    /* =========================================================================
     *  アプリ設定（環境・地域を変えるときは、まずこのブロックを書き換える）
     *  ※ 番地データ（地区・丁目・番）の正は code_api.gs の AREA_DEF（このファイルではない）
     * ========================================================================= */
    /* Mapbox 公開トークン（pk.）。
       ※ このトークンはブラウザで地図タイル取得に使うため、閲覧者には必ず見える（クライアント側トークンは隠蔽不可）。
          別ファイル化・難読化・GAS経由にしても見えるので「隠す」対策は無意味。流用対策は Mapbox 側で行う：
            ① URL制限（URL restrictions）＝ 配信ドメインのみ許可【最重要】
            ② 公開トークン(pk.)のみ・読み取り専用スコープ（sk. の秘密トークンは絶対にここへ置かない）
            ③ 使用量アラート/上限を設定（万一の流用・課金暴走に備える）
          手順は 導入手順書.md「5. Mapbox」を参照。露出済みトークンは新規発行＋URL制限＋差し替え（ローテーション）を推奨。 */
    const MY_TOKEN = 'pk.eyJ1IjoidG9ydW8xMTA0IiwiYSI6ImNtcTdlOGp2MzBhY3QycXBocno2OHQ5dmoifQ.bfkHvR5OmkacGJsDorHL5Q';
    mapboxgl.accessToken = MY_TOKEN;
    // ↓ デプロイした GAS Webアプリの URL（.../exec）に置き換える
    const GAS_API_URL = "https://script.google.com/macros/s/AKfycbzBumpfaVa-15ax6fjyflo82saWKw0PMLOILyvO-riz7e1ZVZ4_feN0mc-Lhv6If5--/exec";
    // ↓ Google Cloud で発行した OAuth クライアントID（code_api.gs と同一値）
    const GOOGLE_CLIENT_ID = "273556684740-01e17ja1as1pchs4cvlfqvh67vbt51l3.apps.googleusercontent.com";
    // ↓ 地図スタイル（Mapbox Studio のスタイルURL。標準に戻す場合は 'mapbox://styles/mapbox/streets-v12'）
    const MAP_STYLE = 'mapbox://styles/toruo1104/cmq7cda6y001g01sqf3aogpwy';
    // ↓ 地図の初期表示位置（前回位置の保存が無い初回起動時に使う）。住所検索の優先中心も兼ねる
    const MAP_HOME = { lng: 139.89036779018497, lat: 35.72063279470909, zoom: 16 };
    // ↓ 住所検索のプレフィックス（区域ラベル「東小岩3丁目5番」等の前に付けてジオコーディングする）
    const ADDR_PREFIX = '東京都江戸川区';
    const AREA_PROXIMITY = MAP_HOME.lng + ',' + MAP_HOME.lat; // Mapboxフォールバック検索の優先中心

    let appEntered = false; // enterApp を一度だけ実行（トークン自動更新では画面を作り直さない）

    // ── Firebase Authentication 初期化（GIS から移行） ──
    // refresh token を indexedDB に保持し、IDトークンを無音で自動更新する＝アカウント確認UIが出ない（再認証頻発の解消）。
    const firebaseConfig = {
        apiKey: 'AIzaSyC5ItYNNlpwkO2s54dAOjGS1d51MCYLVEk',
        authDomain: 'sk-visit-map.firebaseapp.com',
        projectId: 'sk-visit-map',
        appId: '1:742821746922:web:83729214d2ffe155255f93'
    };
    firebase.initializeApp(firebaseConfig);
    const fbAuth = firebase.auth();

    const DATA_CACHE_KEY = 'vm_dataCache'; // 前回取得した地図データ（起動時の先行表示用。サインアウト時に掃除する）

    // サインイン後（新規サインイン／セッション復帰の共通処理）：UIを切り替えてデータ取得
    function enterApp() {
        document.getElementById('startup-overlay').classList.add('hidden'); // 起動中ローディングを隠す
        document.getElementById('login-overlay').classList.add('hidden');
        document.getElementById('signout-btn').style.display = '';
        document.getElementById('area-nav-btn').style.display = '';
        document.getElementById('scale-group').style.display = 'flex';
        updateScaleBtnText();
        updateTextBtnText();
        loadMe(); // 自分の権限・グループを取得（メニューの管理項目の出し分け）
        const blocksReady = loadBlocks(); // 街区ポリゴン(blocks.geojson)を先読み
        loadAddrPoints();  // 番地代表点(address_points.json)を先読み（住所の逆算用）
        loadDataFromSheet();
        // 起動時に現在地へ寄せる（現在地ボタンを基本オンに）。?area/?pin のディープリンク時はそちらを優先。
        if (!DEEP_LINK_AREA && !DEEP_LINK_PIN && !didAutoGeolocate) {
            didAutoGeolocate = true;
            const triggerGeo = () => { try { geolocateControl.trigger(); } catch (e) {} };
            if (map.loaded()) triggerGeo(); else map.once('load', triggerGeo);
            setTimeout(ensureGeolocateOn, 2500); // 初回 trigger がタイミングで不発でも、許可済みなら少し後に再ONして取りこぼしを防ぐ
        }
        // 外部リンク(?area=...)で来た場合は、地図と街区データの準備後にその番地を表示する
        if (DEEP_LINK_AREA && !deepLinkDone) {
            deepLinkDone = true;
            blocksReady.then(() => {
                if (map.loaded()) runAreaDeepLink(DEEP_LINK_AREA);
                else map.once('load', () => runAreaDeepLink(DEEP_LINK_AREA));
            });
        }
    }

    // ログイン画面の「Google でサインイン」ボタンから呼ぶ
    function signInWithGoogle() {
        const provider = new firebase.auth.GoogleAuthProvider();
        fbAuth.signInWithPopup(provider).catch(function (e) {
            // ポップアップが塞がれる環境（PWA/一部モバイル）ではリダイレクト方式へフォールバック
            if (e && (e.code === 'auth/popup-blocked' || e.code === 'auth/cancelled-popup-request' || e.code === 'auth/operation-not-supported-in-this-environment')) {
                fbAuth.signInWithRedirect(provider);
            } else {
                showToast('サインインに失敗しました: ' + ((e && e.message) || e), true);
            }
        });
    }

    // ログイン状態の監視＝画面のルーティング。Firebase が indexedDB の refresh token で自動復帰・自動更新する。
    fbAuth.onAuthStateChanged(function (user) {
        if (user) {
            if (!appEntered) { appEntered = true; enterApp(); } // 初回のみ画面遷移。トークン更新では何もしない
        } else {
            showLogin();
        }
    });
    // 安全弁: 認証解決が異常に遅い/失敗しても固まらないよう、一定時間後に起動中ならログイン画面へ落とす
    setTimeout(function () {
        const su = document.getElementById('startup-overlay');
        if (su && !su.classList.contains('hidden') && !appEntered) showLogin();
    }, 12000);
    // リダイレクト方式サインイン（PWA/一部モバイル）の失敗を可視化する。
    // 承認済みドメイン未登録・ネットワーク断などで戻ってきた時、従来は無音だったので原因が分かるよう通知する。
    fbAuth.getRedirectResult().catch(function (e) {
        showToast('サインインに失敗しました: ' + ((e && e.message) || e), true);
    });

    window.addEventListener('load', initScale);
    window.addEventListener('load', () => {
        // GASのコールドスタートをログイン画面の間に済ませておく（応答は読まずに捨てる）
        try { fetch(GAS_API_URL).catch(() => {}); } catch (e) {}
        loadCachedData(); // 期限切れデータキャッシュの掃除（サインインせず開いた場合でも消す）
    });

    function initScale() {
        // 文字は「大」基準に統一（標準モードは廃止）。常に large-ui を適用する＝これが文字サイズ「小」。
        document.body.classList.add('large-ui');
        // 右下ボタンで切り替える「アイコン(印)の大きさ」だけを記憶から復元する。
        if (localStorage.getItem('iconScale') === 'large') document.body.classList.add('icon-large');
        // 文字サイズ（小=既定 / 中=text-md / 大=text-lg）を記憶から復元する。
        const ts = localStorage.getItem('textScale');
        if (ts === 'medium') document.body.classList.add('text-md');
        else if (ts === 'large') document.body.classList.add('text-lg');
        // 「印」ボタン：タップ＝印サイズ切替（従来）／長押し＝アイコンのフィルタ画面
        const sb = document.getElementById('scale-btn');
        if (sb && !sb._lpBound) { sb._lpBound = true; attachLongPress(sb, toggleScale, openIconFilter); }
    }

    // 現在のアイコン(印)サイズに応じてボタン表示を更新（「印 小」「印 大」）
    function updateScaleBtnText() {
        const t = document.body.classList.contains('icon-large') ? '大' : '小';
        document.getElementById('scale-btn').textContent = '印 ' + t;
    }

    // 右下ボタン：アイコン（印＝マーカー）の大きさを 標準 ⇔ 大 で切替（文字サイズは変えない）
    function toggleScale() {
        const iconLarge = document.body.classList.toggle('icon-large');
        localStorage.setItem('iconScale', iconLarge ? 'large' : 'normal');
        updateScaleBtnText();
        applyZoomScale(); // マーカーサイズを切替に合わせて更新
    }

    // 文字サイズ：小(既定=large-ui)→中(text-md)→大(text-lg) の3段階。吹き出し内の文字を大きくする（印＝ピンサイズとは独立）。
    function currentTextScale() {
        if (document.body.classList.contains('text-lg')) return 'large';
        if (document.body.classList.contains('text-md')) return 'medium';
        return 'small';
    }
    function updateTextBtnText() {
        const label = { small: '小', medium: '中', large: '大' }[currentTextScale()];
        const btn = document.getElementById('text-btn');
        if (btn) btn.textContent = '文字 ' + label;
    }
    // 左の「文字」ボタン：押すたび 小→中→大→小 と循環する。
    function toggleTextScale() {
        const order = ['small', 'medium', 'large'];
        const next = order[(order.indexOf(currentTextScale()) + 1) % order.length];
        document.body.classList.remove('text-md', 'text-lg');
        if (next === 'medium') document.body.classList.add('text-md');
        else if (next === 'large') document.body.classList.add('text-lg');
        localStorage.setItem('textScale', next);
        updateTextBtnText();
    }

    // ※ GISの handleCredential / scheduleTokenRefresh / refreshTokenOnResume（prompt() によるトークン更新と
    //   復帰時更新）は廃止した。Firebase が refresh token で無音自動更新するため不要＝これが再認証頻発の解消。

    // サインアウト：Firebase からサインアウトし、ログイン画面へ戻す
    function signOut() {
        appEntered = false;
        try { localStorage.removeItem(DATA_CACHE_KEY); } catch (e) {} // データキャッシュ掃除（別アカウントに前データが見えるのを防ぐ）
        currentMarkers.forEach(function (m) { m.remove(); });
        currentMarkers = [];
        document.getElementById('signout-btn').style.display = 'none';
        document.getElementById('scale-group').style.display = 'none';
        document.getElementById('area-nav-btn').style.display = 'none';
        closeMenu();
        closeAppModal();
        document.body.classList.remove('role-lend', 'role-manage', 'role-sys');
        ME = { email: '', name: '', group: '', level: 0 };
        closeAreaNav();
        clearBanchiBox();
        didAutoGeolocate = false; // 次回サインイン時にまた現在地へ寄せる
        document.getElementById('area-label').style.display = 'none';
        fbAuth.signOut(); // → onAuthStateChanged(null) が showLogin() を呼ぶ
    }

    // ログイン画面を再表示（認証エラー時・未ログイン時）。自動再サインインはしない（無限ループ防止）。
    function showLogin() {
        try { localStorage.removeItem(DATA_CACHE_KEY); } catch (e) {} // 無効トークン時も前データを残さない
        document.getElementById('startup-overlay').classList.add('hidden'); // 起動中ローディングを隠す（NG＝ログインへ）
        document.getElementById('signout-btn').style.display = 'none';
        document.getElementById('login-overlay').classList.remove('hidden');
    }

    // GAS API 呼び出し（fetch）。CORSプリフライト回避のため Content-Type は text/plain。
    // 認証は検証可能な Firebase IDトークン(JWT)を送る。getIdToken() は有効なトークンを返し、期限切れなら無音で自動更新する。
    async function apiCall(action, params) {
        const user = fbAuth.currentUser;
        const idToken = user ? await user.getIdToken() : '';
        return fetch(GAS_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(Object.assign({ action: action, idToken: idToken }, params || {}))
        })
        .then(function (r) { return r.json(); })
        .then(function (res) {
            if (res.error) { const e = new Error(res.message || res.error); e.code = res.error; throw e; } // error種別を code で保持（文言非依存の判定用）
            return res.data;
        });
    }

    // 外部リンク（URLパラメータ）：?area=東小岩3丁目5番 で番地表示、?pin=行番号 でその行のピンの吹き出しを開く
    const _urlParams = new URLSearchParams(location.search);
    const DEEP_LINK_AREA = _urlParams.get('area');
    const DEEP_LINK_PIN = _urlParams.get('pin');
    let deepLinkDone = false, deepLinkPinDone = false;
    let didAutoGeolocate = false; // 起動時の現在地フォーカスを1回だけ行うためのフラグ

    /* ── 表示位置の保存・復元（Androidのタブ破棄対策） ──
       スマホのブラウザはメモリ不足時にタブを破棄し、戻ると全リロード＝初期位置に戻ってしまう。
       moveend ごとに中心・ズームを localStorage に保存し、起動時はそこから再開する。 */
    const VIEW_KEY = 'vm_lastView';
    function loadSavedView() {
        try {
            const v = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null');
            if (!v || !isFinite(v.lng) || !isFinite(v.lat) || !isFinite(v.zoom)) return null;
            if (Date.now() - (v.ts || 0) > 24 * 60 * 60 * 1000) return null; // 古い保存は使わない
            return v;
        } catch (e) { return null; }
    }
    const savedView = loadSavedView();

    const map = new mapboxgl.Map({
        container: 'map',
        style: MAP_STYLE,
        center: savedView ? [savedView.lng, savedView.lat] : [MAP_HOME.lng, MAP_HOME.lat], // 前回位置 or 既定の中心
        zoom: savedView ? savedView.zoom : MAP_HOME.zoom,
        bearingSnap: 18 // 北付近の小さな（意図しない）回転は指を離すと北に戻す＝誤回転を抑制
    });
    // 表示位置を保存（パン・ズーム・flyTo すべて moveend で拾う）
    map.on('moveend', () => {
        try {
            const c = map.getCenter();
            localStorage.setItem(VIEW_KEY, JSON.stringify({ lng: c.lng, lat: c.lat, zoom: map.getZoom(), ts: Date.now() }));
        } catch (e) {}
    });

    /* Mapbox内蔵の「タップ→続けてドラッグで1本指ズーム」(tapDragZoom)を無効化する。
       吹き出しを閉じるタップの直後にスクロールを始めると、連続タップ＋ドラッグと誤認されて
       1本指のスクロールがズームになってしまうため。ズームは2本指ピンチ／ダブルタップで従来どおり可能。
       （内部ハンドラへのアクセスのため、構造が変わった場合に備えて try で保護） */
    try { map.handlers._handlersById.tapDragZoom.disable(); } catch (e) {}

    // 右上にコンパス（クリックで北が上に戻る）
    map.addControl(new mapboxgl.NavigationControl({ showZoom: false, showCompass: true, visualizePitch: true }), 'top-right');

    // 現在地（青ポチ表示＋押すと現在地へフォーカス）。コンパスの下に追加される。
    const geolocateControl = new mapboxgl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: true,
        showUserHeading: true,
        showAccuracyCircle: false,             // 周囲の薄い青（精度円）は表示しない
        fitBoundsOptions: { maxZoom: 18 }
    });
    map.addControl(geolocateControl, 'top-right');
    // 「最新の状態に更新」ボタンを現在地ボタンの真下（同じ右上グループ）に置く。PWAはブラウザ更新UIが無いための救済。
    map.addControl({
        onAdd: function () {
            const div = document.createElement('div');
            div.className = 'mapboxgl-ctrl mapboxgl-ctrl-group';
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.title = '最新の状態に更新';
            btn.setAttribute('aria-label', '最新の状態に更新');
            btn.style.fontSize = '17px';
            btn.textContent = '🔄';
            btn.addEventListener('click', reloadApp);
            div.appendChild(btn);
            return div;
        },
        onRemove: function () {}
    }, 'top-right');
    /* GeolocateControl は位置更新のたびに「GPS精度の円が収まるズーム」へ自動で再フィットする。
       精度が粗いと大きく引いてしまい、こちらの zoom 21 を上書きするので、
       追従中は毎回 21 に補正して固定する（初回は住所検索と同じ flyTo、以降は素早い easeTo）。 */
    let geoActive = false, geoFirst = false, geoUserOff = false; // geoUserOff＝利用者が長押しで明示オフにした（自動再ONを抑止）
    geolocateControl.on('trackuserlocationstart', () => { geoActive = true; geoFirst = true; });
    geolocateControl.on('trackuserlocationend', () => { geoActive = false; });
    geolocateControl.on('geolocate', (pos) => {
        if (!geoActive) return;               // 追従中（ACTIVE_LOCK）のときだけ補正する
        const c = [pos.coords.longitude, pos.coords.latitude];
        const first = geoFirst; geoFirst = false;
        // 制御側の自動カメラ移動の後に上書きしたいので少し遅延させる
        setTimeout(() => {
            if (!geoActive) return;
            if (first) map.flyTo({ center: c, zoom: 18, duration: 1200 });  // 初回：住所検索と同じ動き
            else map.easeTo({ center: c, zoom: 18, duration: 250 });        // 追従：ズーム18を維持
        }, 70);
    });

    // 位置情報が「許可済み」なら、現在地追従が OFF のとき自動で ON にする（利用時に大抵オンを維持）。
    //  ・既に追従中(geoActive)なら何もしない。trigger は OFF↔ON のトグルなので ON 中に呼ぶと切れてしまうため。
    //  ・許可が未設定/拒否のときは自動ONしない（不意の許可ダイアログやエラーを出さない）。起動時の初回プロンプトは enterApp の trigger が担う。
    //  ・OFF→ON にすると現在地へカメラが寄る（geolocate ハンドラの flyTo）。OFF のとき限定なので、追従中の利用者の表示は邪魔しない。
    function ensureGeolocateOn() {
        if (geoActive || geoUserOff) return; // 既にON、または利用者が長押しで明示オフにした間は自動ONしない
        try {
            if (navigator.permissions && navigator.permissions.query) {
                navigator.permissions.query({ name: 'geolocation' }).then(function (st) {
                    if (st.state === 'granted' && !geoActive) { try { geolocateControl.trigger(); } catch (e) {} }
                }).catch(function () {});
            }
        } catch (e) {}
    }

    // 現在地ボタンの「長押し」で確実にオフにする（タップは Mapbox 既定＝オン/中心化のトグルのまま）。
    //  ・パンで追従が外れた状態(BACKGROUND)からのタップは ACTIVE_LOCK に戻るだけで切れないため、長押しは状態に依らず OFF にする。
    //  ・長押しオフ中は geoUserOff=true で自動再ON(ensureGeolocateOn)を止める＝オフが続く。通常タップでオンに戻すと解除。
    function turnGeolocateOffByUser() {
        const wasOn = geoActive;
        geoUserOff = true; // 自動再ONを止める
        if (wasOn) {
            // ACTIVE_LOCK→OFF（trackuserlocationend が同期発火し geoActive=false）。BACKGROUND だった場合は一旦 ACTIVE_LOCK に戻るだけなので、まだ ON ならもう一度。
            try { geolocateControl.trigger(); if (geoActive) geolocateControl.trigger(); } catch (e) {}
            showToast('現在地をオフにしました', false);
        }
    }
    // 現在地ボタンに長押し(オフ)を割り当てる。コントロール追加直後にボタンが DOM に存在する。
    function setupGeolocateLongPressOff() {
        const btn = document.querySelector('.mapboxgl-ctrl-geolocate');
        if (!btn) { setTimeout(setupGeolocateLongPressOff, 300); return; } // まだ無ければ少し待って再試行
        let pressTimer = null, longFired = false, sx = 0, sy = 0;
        btn.addEventListener('pointerdown', (e) => {
            longFired = false; sx = e.clientX; sy = e.clientY;
            clearTimeout(pressTimer);
            pressTimer = setTimeout(() => { longFired = true; turnGeolocateOffByUser(); }, 500);
        });
        btn.addEventListener('pointermove', (e) => { if (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10) clearTimeout(pressTimer); });
        ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => btn.addEventListener(ev, () => clearTimeout(pressTimer)));
        btn.addEventListener('contextmenu', (e) => e.preventDefault()); // 長押し時のコールアウト抑止
        // 長押し発火後の click（Mapbox のトグル＝再ON）を握りつぶす。document の capture で、ボタン自身の click より先に判定する。
        document.addEventListener('click', (e) => {
            if (!(e.target && e.target.closest && e.target.closest('.mapboxgl-ctrl-geolocate'))) return;
            if (longFired) { e.stopImmediatePropagation(); e.preventDefault(); longFired = false; } // 長押し→トグルを無効化（オフを維持）
            else geoUserOff = false; // 通常タップ＝利用者がオンに戻す意思 → 自動再ON を再び許可
        }, true);
    }
    setupGeolocateLongPressOff();

    // GPS現在地（青ポチ）を訪問先ピンより前面に固定する。Mapbox v3 はマーカー(青ポチを含む)に
    // 動的な z-index を inline で付与し CSS の !important より優先されることがあるため、JS で上書きする。
    // 値は「ピン(3)より上・吹き出し(50)より下」になるよう 49 にする。
    function raiseUserDot() {
        const c = map.getCanvasContainer && map.getCanvasContainer();
        if (!c) return;
        c.querySelectorAll('.mapboxgl-user-location-dot, .mapboxgl-user-location-heading').forEach(el => {
            const m = el.closest('.mapboxgl-marker') || el;
            if (m) m.style.setProperty('z-index', '49', 'important');
        });
    }
    map.on('idle', raiseUserDot); // パン/ズーム/マーカー再描画などで地図が落ち着くたびに前面化を再適用

    let currentMarkers = [];
    let activeNewMarker = null;
    let gridActiveRooms = [];
    let gridRoomMark = {}; // 登録/編集グリッドの部屋マーク {部屋番号:'p'(個人宅)|'c'(会社)}。長押しで 無→個人→会社→無 と循環
    let currentData = []; // 直近にサーバーから受け取ったデータ（編集機能で参照）

    // 集合住宅ピンの色（構成属性で見分ける／落ち着いたトーン）
    function shugaColor(attr) {
        switch (attr) {
            case 'ファミリー': return '#F2E394'; // 薄黄
            case 'シングル':   return '#5B8BB0'; // ブルー（くすみ）
            case '混在':       return '#F2E394'; // 薄黄（ファミリーと同色）
            default:           return '#8C8C8C'; // 不明など（既定・グレー）
        }
    }

    // ── 集合住宅フォームの色付きセレクト（新規・編集 共通。オートロック/構成属性/管理人） ──
    // 各 option に背景色を付け、選択中の値の色をセレクト本体にも反映する（閉じた状態でも色で分かる）。
    // 構成属性はアイコン色(shugaColor)と同じ＋不明はオートロックの不明と同色。オートロック=あり薄赤/なし薄青。管理人=あり薄緑/なし・不明薄グレー。
    const SHUGA_ATTR_OPTS_ = [
        { v: '不明',      label: '不明',      bg: '#E2E2E2', fg: '#444444' }, // 不明はオートロックの不明と同色（薄グレー）
        { v: 'ファミリー', label: 'ファミリー', bg: '#F2E394', fg: '#6b5a1e' },
        { v: 'シングル',   label: 'シングル',   bg: '#5B8BB0', fg: '#ffffff' },
        { v: '混在',      label: '混在',      bg: '#F2E394', fg: '#6b5a1e' }
    ];
    const SHUGA_LOCK_OPTS_ = [
        { v: '不明', label: '不明', bg: '#E2E2E2', fg: '#444444' },
        { v: 'なし', label: 'なし', bg: '#D9E8F2', fg: '#1f4a63' }, // 薄い青
        { v: 'あり', label: 'あり', bg: '#F3D9D5', fg: '#7a342c' }  // 薄い赤
    ];
    const SHUGA_MGR_OPTS_ = [
        { v: '不明', label: '不明', bg: '#E5E5E5', fg: '#444444' }, // 薄いグレー
        { v: 'なし', label: 'なし', bg: '#E5E5E5', fg: '#444444' }, // 薄いグレー
        { v: 'あり', label: 'あり', bg: '#D6EAD9', fg: '#2E5E33' }  // 薄い緑
    ];
    function coloredSelectHtml(id, opts, current) {
        const cur = opts.find(o => String(o.v) === String(current)) || opts[0];
        const optionHtml = opts.map(o =>
            `<option value="${escHtml(o.v)}" style="background:${o.bg}; color:${o.fg};" ${String(current) === String(o.v) ? 'selected' : ''}>${escHtml(o.label)}</option>`
        ).join('');
        return `<select id="${id}" style="background:${cur.bg}; color:${cur.fg}; font-weight:bold;" onchange="applySelectColor(this)">${optionHtml}</select>`;
    }
    // 選択変更時にセレクト本体の色を選択中 option の色へ更新する（閉じた状態の視認用）
    function applySelectColor(sel) {
        const o = sel.options[sel.selectedIndex];
        if (!o) return;
        sel.style.background = o.style.background;
        sel.style.color = o.style.color;
    }
    // 集合住宅 詳細の上部情報行（オートロック/構成/管理人）の文字色（値ごと。深い色）。
    //  オートロック: あり→赤 / なし・不明→グレー
    //  構成:        シングル→青 / ファミリー・混在→黄 / 不明→グレー
    //  管理人:      あり→緑 / なし・不明→グレー
    function shugaInfoColor(field, v) {
        v = v || '不明';
        const GRAY = '#555555';
        if (field === 'lock') return (v === 'あり') ? '#7a342c' : GRAY;          // あり=深い赤
        if (field === 'attr') {
            if (v === 'シングル') return '#1f4a63';                              // 深い青
            if (v === 'ファミリー' || v === '混在') return '#8a7117';            // 深い黄
            return GRAY;                                                          // 不明
        }
        return (v === 'あり') ? '#2E5E33' : GRAY;                                 // 管理人 あり=深い緑
    }

    // ── 施設（目印になる建物）の種類 ── 種別='施設'。種類は属性(I列)に保存。マーカーは絵文字のみ（丸なし）。
    const FACILITY_TYPES = [
        { v: '区の施設',          icon: '🏛️', color: '#7B5EA7' },
        { v: 'コンビニ',          icon: '🏪', color: '#E08A3C' },
        { v: 'スーパー',          icon: '🛍️', color: '#4F8FBF' },
        { v: '病院',             icon: '🏥', color: '#C9544B' },
        { v: '郵便局',           icon: '〒', color: '#E60012' }, // 〒マーク（マーカーは赤・太字で表示）
        { v: '公園',             icon: '🌳', color: '#4F9E5E' },
        { v: '学校',             icon: '🏫', color: '#D9A441' },
        { v: 'カフェ・レストラン', icon: '🍴', color: '#B07A4F' },
        { v: '銭湯',             icon: '♨️', color: '#3E8E8A' },
        { v: 'ドラッグストア',    icon: '💊', color: '#C75B9E' }
    ];
    // 旧値「コンビニ・スーパー」の後方互換（🏪で表示。編集で「コンビニ」「スーパー」に付け替え可）
    const FACILITY_LEGACY_ICON_ = { 'コンビニ・スーパー': '🏪' };
    function facilityIcon(v) { const f = FACILITY_TYPES.find(t => t.v === v); return f ? f.icon : (FACILITY_LEGACY_ICON_[v] || '📍'); }
    function facilityLabel(v) { const f = FACILITY_TYPES.find(t => t.v === v); return f ? f.v : (v || '施設'); }
    // 施設マーカーの見た目を種類に応じて設定（絵文字＋郵便局は〒を赤に。太字は .custom-marker の font-weight:900）。サイズ判定用に種類を保持。
    function styleFacilityMarker(el, type) {
        if (!el) return;
        el.innerHTML = facilityIcon(type);
        el.dataset.facType = type || '';
        el.style.color = (type === '郵便局') ? '#E60012' : ''; // 〒は赤。絵文字は色指定なし（自前グリフ色）
    }
    // 種類ごとのアイコンサイズ倍率。
    //  公園・区の施設：z14以上は等倍、z14から広域になるほど大きく（目印として。z14=1.0 / z13=1.5 / z12=2.0 …＝1段ごと+0.5）。
    //  その他：低ズームで小さめ(0.6)→ズームイン(z16以上)で等倍(1.0)に戻す（z13=0.6 / z16以上=1.0、間は線形）。
    function facilitySizeMult(type, zoom) {
        if (type === '公園' || type === '区の施設') return zoom >= 14 ? 1.0 : 1.0 + (14 - zoom) * 0.5;
        if (zoom >= 16) return 1.0;
        if (zoom <= 13) return 0.6;
        return 0.6 + (zoom - 13) * (0.4 / 3);
    }

    // ── アイコンのフィルタ（右下「印」ボタン長押し）。チェックした種類だけ地図に表示（未選択＝全表示）。並び・色は他表示に合わせる。
    // フィルタ利用中はズームによる自動非表示は行わない（選択した種類は常時表示）。
    const ICON_FILTER_SECTIONS = [
        { key: '種別', title: '種別', opts: [
            { v: '戸建て', label: '戸建て', icon: '🏠' },
            { v: '集合住宅', label: '集合住宅', icon: '🏢' },
            { v: '施設', label: '施設', icon: '🏛️' }
        ] },
        { key: '訪問結果', title: '戸建て：訪問結果', opts: [
            { v: '未訪問', label: '未訪問', color: '#6FAEC0' },
            { v: '不在', label: '不在', color: '#4A78B0' },
            { v: '会えた', label: '会えた', color: '#DB7C2E' },
            { v: '投函', label: '投函', color: '#3E8E54' }
        ] },
        { key: '戸建て属性', title: '戸建て：属性', opts: [
            { v: '通常', label: '訪問可', color: '#F2E394' },
            { v: '訪問拒否', label: '訪問拒否', color: '#A8554E' },
            { v: '外国語', label: '外国語', color: '#8E79AB' },
            { v: '空き家', label: '空き家', color: '#D4D4D4' },
            { v: '他', label: '他', color: '#CBD0D6' },
            { v: '会社', label: '会社', color: '#2E5090' }
        ] },
        { key: '構成', title: '集合住宅：構成属性', opts: [
            { v: '不明', label: '不明', color: '#8C8C8C' },
            { v: 'ファミリー', label: 'ファミリー', color: '#F2E394' },
            { v: 'シングル', label: 'シングル', color: '#5B8BB0' },
            { v: '混在', label: '混在', color: '#F2E394' }
        ] },
        { key: 'オートロック', title: '集合住宅：オートロック', opts: [
            { v: 'あり', label: 'あり', color: '#F3D9D5' },
            { v: 'なし', label: 'なし', color: '#D9E8F2' },
            { v: '不明', label: '不明', color: '#E2E2E2' }
        ] },
        { key: '管理人', title: '集合住宅：管理人', opts: [
            { v: 'あり', label: 'あり', color: '#D6EAD9' },
            { v: 'なし', label: 'なし', color: '#E5E5E5' },
            { v: '不明', label: '不明', color: '#E5E5E5' }
        ] },
        { key: '施設種類', title: '施設の種類', opts: FACILITY_TYPES.map(t => ({ v: t.v, label: t.v, icon: t.icon })) }
    ];
    const iconFilter = {}; ICON_FILTER_SECTIONS.forEach(s => { iconFilter[s.key] = new Set(); });
    function iconFilterActive() { return ICON_FILTER_SECTIONS.some(s => iconFilter[s.key].size > 0); }
    // 戸建ての現在の訪問結果を 未訪問/不在/会えた/投函 に正規化（K列=最新ステータス）
    function kodateVisitKey(item) {
        const s = String(item.最新ステータス || '');
        if (s.indexOf('不在') >= 0) return '不在';
        if (s.indexOf('会えた') >= 0) return '会えた';
        if (s.indexOf('投函') >= 0) return '投函';
        return '未訪問';
    }
    // 各属性枠が対象とする種別（種別枠は全種別のゲート）。「欲しい種別」の推定に使う。
    const ICON_FILTER_SECTION_TYPE = {
        '訪問結果': '戸建て', '戸建て属性': '戸建て',
        '構成': '集合住宅', 'オートロック': '集合住宅', '管理人': '集合住宅',
        '施設種類': '施設'
    };
    // フィルタ利用中、このピンを表示するか（＝かつ/AND 条件）。
    //  ・同じ枠内の複数チェック … どれかに一致でOK（OR。1ピンは1つの値しか持てないため）。
    //  ・別の枠どうし … すべて満たす（AND）。例: オートロック=あり かつ 管理人=あり の集合住宅だけ。
    //  ・種別を選ばなくても、属性枠（例:オートロック）を選べばその枠が対象とする種別へ自動で絞る。
    //    ある種別に無関係な枠（戸建てに対するオートロック等）は無視する（種別ごとの枠構造を踏襲）。
    function iconFilterShows(item) {
        if (!item || !iconFilterActive()) return true;
        const t = item.種別;
        // 1) 「欲しい種別」を決める。種別枠が選択されていればそれ。無ければ選択中の属性枠が対象とする種別の集合。
        let wantedTypes = null; // null = 種別の制約なし（全種別OK）
        if (iconFilter['種別'].size > 0) {
            wantedTypes = iconFilter['種別'];
        } else {
            const ws = new Set();
            Object.keys(ICON_FILTER_SECTION_TYPE).forEach(function(k) { if (iconFilter[k].size > 0) ws.add(ICON_FILTER_SECTION_TYPE[k]); });
            if (ws.size > 0) wantedTypes = ws;
        }
        if (wantedTypes && !wantedTypes.has(t)) return false;
        // 2) その種別に該当する属性枠すべてで AND 判定（選択がある枠のみ。無関係な枠は無視）。
        if (t === '戸建て') {
            if (iconFilter['訪問結果'].size > 0 && !iconFilter['訪問結果'].has(kodateVisitKey(item))) return false;
            if (iconFilter['戸建て属性'].size > 0 && !iconFilter['戸建て属性'].has(item.属性 || '通常')) return false;
        } else if (t === '集合住宅') {
            if (iconFilter['構成'].size > 0 && !iconFilter['構成'].has(item.属性 || '不明')) return false;
            if (iconFilter['オートロック'].size > 0 && !iconFilter['オートロック'].has(getAutolock(item))) return false;
            if (iconFilter['管理人'].size > 0 && !iconFilter['管理人'].has(item.管理人 || '不明')) return false;
        } else if (t === '施設') {
            if (iconFilter['施設種類'].size > 0) {
                const okFac = iconFilter['施設種類'].has(item.属性)
                    || (item.属性 === 'コンビニ・スーパー' && (iconFilter['施設種類'].has('コンビニ') || iconFilter['施設種類'].has('スーパー'))); // 旧値の後方互換
                if (!okFac) return false;
            }
        }
        return true;
    }
    function renderIconFilterBody() {
        const body = document.getElementById('icon-filter-body');
        if (!body) return;
        body.innerHTML = ICON_FILTER_SECTIONS.map(sec => {
            const opts = sec.opts.map(o => {
                const on = iconFilter[sec.key].has(o.v);
                const sw = o.icon ? `<span class="iff-ic">${o.icon}</span>` : `<span class="iff-sw" style="background:${o.color};"></span>`;
                return `<label class="iff-opt${on ? ' on' : ''}" onclick="toggleIconFilterOpt(this,'${sec.key}','${o.v}')">${sw}${escHtml(o.label)}</label>`;
            }).join('');
            return `<div class="iff-sec"><div class="iff-sec-ttl">${escHtml(sec.title)}</div><div class="iff-opts">${opts}</div></div>`;
        }).join('') + `<div class="iff-note">チェックした条件すべてに当てはまるピンだけ表示します（別の枠どうしは「かつ」／同じ枠内はどれか・未選択＝全部表示）。フィルタ利用中はズームによる自動非表示は行いません。</div>`;
    }
    function openIconFilter() {
        renderIconFilterBody();
        document.getElementById('icon-filter-modal').style.display = 'flex';
    }
    function closeIconFilter() { document.getElementById('icon-filter-modal').style.display = 'none'; }
    function toggleIconFilterOpt(el, secKey, v) {
        const set = iconFilter[secKey];
        if (set.has(v)) { set.delete(v); el.classList.remove('on'); }
        else { set.add(v); el.classList.add('on'); }
        applyZoomVisibility(); // 地図に即反映
    }
    function iconFilterSelectAll() {
        ICON_FILTER_SECTIONS.forEach(s => s.opts.forEach(o => iconFilter[s.key].add(o.v)));
        renderIconFilterBody(); applyZoomVisibility();
    }
    function iconFilterClearAll() {
        ICON_FILTER_SECTIONS.forEach(s => iconFilter[s.key].clear());
        renderIconFilterBody(); applyZoomVisibility();
    }

    // 集合住宅のオートロック有無（新方式=S列。旧データはメモ内から後方互換で取得）
    function getAutolock(item) {
        if (item.オートロック) return item.オートロック;
        const m = String(item.特記事項 || '').match(/オートロック:(あり|なし)/);
        return m ? m[1] : 'なし';
    }

    // メモ本文（旧データの「オートロック:xxx / 」プレフィックスを除去）
    function cleanMemo(item) {
        const raw = String(item.特記事項 || '');
        const m = raw.match(/^オートロック:(?:あり|なし)\s*\/\s*([\s\S]*)$/);
        return m ? m[1] : raw;
    }

    // ユーザー入力（建物名・メモ・住所等）をHTMLへ埋め込む際のエスケープ（& や < による表示崩れを防ぐ）
    function escHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
    }

    // ポップアップが画面内に収まるよう、ピンを画面の下寄り中央へ寄せる（上向き吹き出し用・簡易版）
    function centerForPopup(lngLat) {
        const h = map.getContainer().clientHeight;
        map.easeTo({ center: lngLat, offset: [0, h * 0.18], duration: 300 });
    }

    // 吹き出しの実高さを測り、吹き出しが画面の縦中央に来るよう地図を移動する。
    // 背の高い集合住宅の詳細など、中央寄せだと上端が見切れる場合だけ「上端を画面上部に合わせる」へ自動で切替。
    // reservePx: これから広がる余白（集合住宅の部屋操作欄ぶん）を前もって見込む。
    function fitPopupInView(marker, reservePx) {
        const popup = marker.getPopup();
        if (!popup || !popup.isOpen()) return;
        const el = popup.getElement();
        const content = el ? el.querySelector('.popup-content') : null;
        const mapH = map.getContainer().clientHeight;
        const pad = 12, tip = 28; // 吹き出し口ぶんの余白
        let popupH = (content ? content.getBoundingClientRect().height : mapH * 0.4) + (reservePx || 0);
        popupH = Math.min(popupH, mapH * 0.82); // 吹き出しは最大でも約82vh（詳細表示の縦長に合わせる）
        // 基本は吹き出しを画面の縦中央に置く（戸建てなど背の低い吹き出しが上部に寄らないように）。
        //   吹き出し中心Y = ピン画面Y − tip − popupH/2、ピン画面Y = mapH/2 + oy
        //   中心を mapH/2 に合わせる → oy = tip + popupH/2
        // ただし背の高い吹き出し（集合住宅の詳細など）は中央寄せだと上端が見切れるので、
        // 「上端を topMargin に合わせる oy」を下限とし、はみ出す場合はそちらを採用する。
        const topMargin = mapH * 0.12;
        const oyCenter = tip + popupH / 2;                 // 縦中央寄せ（戸建て等）
        const oyTop = topMargin + tip + popupH - mapH / 2; // 上端を topMargin に固定（背の高い吹き出し用）
        let oy = Math.max(oyCenter, oyTop);
        const limit = mapH / 2 - pad; // ピンが画面外に出ない範囲にだけ収める
        oy = Math.max(-limit, Math.min(oy, limit));
        map.easeTo({ center: marker.getLngLat(), offset: [0, oy], duration: 300 });
    }

    // 吹き出しの「詳細を表示／隠す」を切り替える（簡易表示が既定）。
    // 補助ボタン・空メモ・横スクロールの表示は CSS（.popup-content.detail）で一括制御する。
    function togglePopupDetail(btn) {
        const root = btn.closest('.popup-content');
        if (!root) return;
        const isDetail = root.classList.toggle('detail');
        btn.textContent = isDetail ? '▲ 詳細を隠す' : '▼ 詳細を表示';
        // 表示量が変わって高さが変化するので、吹き出しが画面に収まるよう寄せ直す
        const m = currentMarkers.find(mk => { const p = mk.getPopup(); return p && p.isOpen(); }) || activeNewMarker;
        if (m) setTimeout(() => fitPopupInView(m, 0), 30);
    }

    // 部屋セルの見た目（状態に応じた色・文字）。未訪問は既定色のまま。落ち着いたトーンに調整。
    // 管理人を「特別な部屋」として部屋ステータス(S列)・履歴(Q列)で扱うための予約キー。
    // 通常の部屋番号(101〜)とは衝突しない文字列キー。操作・履歴・色は通常の部屋と同じ仕組みに乗せる。
    const MGR_KEY = '管理人';
    function isMgrKey(rk) { return String(rk) === MGR_KEY; }
    // 履歴/最新ステータスの接頭辞。部屋＝「101号室」／管理人＝「管理人」。GAS の roomTag_ と表記を揃える。
    function roomTag(rk) { return isMgrKey(rk) ? MGR_KEY : (rk + '号室'); }
    // onclick テンプレートに埋める JS リテラル。数値部屋はそのまま、管理人は文字列なのでクォートする。
    function roomKeyJs(rk) { return isMgrKey(rk) ? ("'" + rk + "'") : rk; }

    function roomVisual(status) {
        status = status || '';
        const ab = String(status).match(/不在\((\d+)回目\)/); // 不在は回数を抽出（上限なし）
        if (ab) {
            const n = parseInt(ab[1], 10);
            // 1〜5回目で5段階に濃くする（6回目以降は最濃で固定）
            const bgs = ['#CBE3F0', '#A6CFE4', '#7FB6D6', '#5A9BC4', '#3D7FA8'];
            const bg = bgs[Math.min(n, 5) - 1];
            return { char: String(n), bg: bg, color: n >= 4 ? '#ffffff' : '#0d3c55' };
        }
        if (status.indexOf('会えた')     >= 0) return { char: '会', bg: '#F2C892', color: '#5b3b00' }; // 目に優しいオレンジ
        if (status.indexOf('投函')       >= 0) return { char: '投', bg: '#CBE2CC', color: '#2E5E33' };
        if (status.indexOf('訪問拒否')   >= 0) return { char: '拒', bg: '#A8554E', color: '#ffffff' }; // くすみブリック
        if (status.indexOf('外国語')     >= 0) return { char: '外', bg: '#8E79AB', color: '#ffffff' }; // くすみパープル
        if (status.indexOf('空き家')     >= 0) return { char: '空', bg: '#D4D4D4', color: '#555555' };
        if (status === '他')                   return { char: '他', bg: '#CBD0D6', color: '#454c54' };
        return { char: null, bg: '#E6F1F4', color: '#333333' }; // 未訪問（既定）
    }

    /* ── 集合住宅ピンのアイコン（SVG・白シルエット。窓は背景色＝構成属性の色が抜ける） ──
       アパート＝低層横長（庇・窓4・中央玄関）/ マンション＝高層縦長（塔屋・窓3列・エントランス）。
       マンションは縦長で細く見えるため、ピンに対する占有率を大きめにしてバランスを取る。 */
    const ICON_APART = '<svg viewBox="0 0 24 24" style="width:58%;height:58%;fill:currentColor;display:block;" aria-hidden="true"><path fill-rule="evenodd" d="M1.5 4.5 h21 v2.5 h-21 Z M3 7 h18 v14 h-18 Z M5.6 9.3 h3.2 v3 h-3.2 Z M15.2 9.3 h3.2 v3 h-3.2 Z M5.6 14.8 h3.2 v3 h-3.2 Z M15.2 14.8 h3.2 v3 h-3.2 Z M10.4 15 h3.2 v6 h-3.2 Z"/></svg>';
    const ICON_MANSION = '<svg viewBox="0 0 24 24" style="width:76%;height:76%;fill:currentColor;display:block;" aria-hidden="true"><path fill-rule="evenodd" d="M9 1.5 h6 v2.5 h-6 Z M5 4 h14 v17 h-14 Z M7 6 h2.2 v2.2 H7 Z M10.9 6 h2.2 v2.2 h-2.2 Z M14.8 6 h2.2 v2.2 h-2.2 Z M7 9.4 h2.2 v2.2 H7 Z M10.9 9.4 h2.2 v2.2 h-2.2 Z M14.8 9.4 h2.2 v2.2 h-2.2 Z M7 12.8 h2.2 v2.2 H7 Z M10.9 12.8 h2.2 v2.2 h-2.2 Z M14.8 12.8 h2.2 v2.2 h-2.2 Z M7 16.2 h2.2 v2.2 H7 Z M14.8 16.2 h2.2 v2.2 h-2.2 Z M10.7 16.4 h2.6 v4.6 h-2.6 Z"/></svg>';

    /* ── 属性・訪問結果の選択UI（ネイティブselectの代替・ボタン式） ──
       視認性向上のため選択肢を最初からボタンで並べ、現在値を凡例と同系色でハイライトする。
       ・詳細/部屋操作: タップ＝即保存（従来のonchange相当）。保存後の再描画で新しい現在値が光る。
       ・新規フォーム: タップした値で即登録（pickNewAndSubmit）。確定用「登録」ボタンは詳細表示内に控える。 */
    const ATTR_CHOICES = [
        { v: '通常',     roomV: '未訪問',   label: '訪問可', on: '#F2E394', onText: '#6b5a1e', offText: '#555' }, // 薄黄は白文字が読めないため濃黄土文字
        { v: '訪問拒否', roomV: '訪問拒否', label: '拒否',   on: '#A8554E', offText: '#A8554E' },
        { v: '外国語',   roomV: '外国語',   label: '外国語', on: '#8E79AB', offText: '#8E79AB' },
        { v: '空き家',   roomV: '空き家',   label: '空き',   on: '#8C8C8C', offText: '#666' }, // 表示は「空き」(5択を1行に収める)。保存値は従来どおり「空き家」
        { v: '他',       roomV: '他',       label: '他',     on: '#7f8c8d', offText: '#666' },
        { v: '会社',     roomV: '会社',     label: '会社',   on: '#2E5090', offText: '#2E5090', kodateOnly: true } // 戸建て専用（集合は部屋マーク🏢で会社を表す）
    ];
    const RESULT_CHOICES = [
        { v: '不在',   label: '不在',   on: '#3D7FA8', offBg: '#CBE3F0', offText: '#0d3c55', offBd: '#9fc4da' },
        { v: '会えた', label: '会えた', on: '#DB7C2E', offBg: '#F2C892', offText: '#5b3b00', offBd: '#ddb070' },
        { v: '投函',   label: '投函',   on: '#3E8E54', offBg: '#CBE2CC', offText: '#2E5E33', offBd: '#a8cbaa' }
    ];
    function choiceBtnHtml(label, onStyle, offStyle, isOn, onclick) {
        return `<button class="choice-btn" data-on="${onStyle}" data-off="${offStyle}" style="${isOn ? onStyle : offStyle}" onclick="${onclick}">${label}</button>`;
    }
    // 属性の4択ボタン。current=現在値、onclickTpl の %v が値に置換される。useRoomV=部屋用の値体系(未訪問)を使う
    function attrChoiceHtml(current, onclickTpl, useRoomV) {
        const isAttr = ['訪問拒否', '外国語', '空き家', '他', '会社'].indexOf(current) >= 0;
        const choices = ATTR_CHOICES.filter(c => !(c.kodateOnly && useRoomV)); // 会社は戸建て専用＝部屋ピッカーでは除外
        return `<div class="choice-grid c${choices.length}">` + choices.map(c => {
            const val = useRoomV ? c.roomV : c.v;
            const on = isAttr ? current === val : c.label === '訪問可'; // 属性でなければ「訪問可」が現在値
            const onStyle = `background:${c.on}; border-color:${c.on}; color:${c.onText || '#fff'};`;
            const offStyle = `color:${c.offText};`;
            return choiceBtnHtml(c.label, onStyle, offStyle, on, onclickTpl.replace('%v', val));
        }).join('') + '</div>';
    }
    // 訪問結果の3択ボタン。「不在(2回目)」のような値も先頭一致で不在をハイライトする
    function resultChoiceHtml(current, onclickTpl) {
        const cur = String(current || '');
        return '<div class="choice-grid c3">' + RESULT_CHOICES.map(c => {
            const on = cur.indexOf(c.v) === 0;
            const onStyle = `background:${c.on}; border-color:${c.on}; color:#fff;`;
            const offStyle = `background:${c.offBg}; border-color:${c.offBd}; color:${c.offText};`;
            return choiceBtnHtml(c.label, onStyle, offStyle, on, onclickTpl.replace('%v', c.v));
        }).join('') + '</div>';
    }
    // 属性の現在値ボタン（ラベル無し。住所行・部屋番号行の右端に置く）。タップで4択に展開する。
    function attrLineHtml(current, onclickTpl, useRoomV) {
        const isAttr = ['訪問拒否', '外国語', '空き家', '他', '会社'].indexOf(current) >= 0;
        const cur = (isAttr && ATTR_CHOICES.find(c => (useRoomV ? c.roomV : c.v) === current)) || ATTR_CHOICES[0];
        return `<button class="choice-btn attr-cur" data-cur="${current || ''}" data-tpl="${onclickTpl}" data-room="${useRoomV ? 1 : 0}"`
            + ` style="background:${cur.on}; border-color:${cur.on}; color:${cur.onText || '#fff'};" onclick="expandAttrChoices(this)">${cur.label} ▾</button>`;
    }
    // 現在値ボタンをタップ → 4択に展開（flex行内では折り返して全幅表示。選択すると保存/畳みで戻る）
    function expandAttrChoices(btn) {
        const wrap = document.createElement('div');
        wrap.innerHTML = attrChoiceHtml(btn.dataset.cur, btn.dataset.tpl, btn.dataset.room === '1');
        const grid = wrap.firstElementChild;
        grid.dataset.tpl = btn.dataset.tpl;     // 選択後・閉じた時に現在値ボタンへ畳むための情報を引き継ぐ
        grid.dataset.room = btn.dataset.room;
        grid.dataset.cur = btn.dataset.cur;
        btn.replaceWith(grid);
    }
    // 選択ボタン群のうち、押されたボタンだけを選択色(on)にし、同じグリッドの他は未選択色(off)へ戻す。
    // 戸建て新規フォームで「押しても色が変わらない」問題の解消（集合住宅編集と同じ押下フィードバックにする）。
    function highlightPicked(btn) {
        if (!btn) return;
        const grid = btn.closest('.choice-grid');
        if (grid) grid.querySelectorAll('.choice-btn').forEach(b => { if (b.dataset.off) b.setAttribute('style', b.dataset.off); });
        if (btn.dataset.on) btn.setAttribute('style', btn.dataset.on);
    }
    // 戸建て新規フォーム：訪問結果/属性ボタンを押した時点で、その値を hidden にセットして即登録する。
    // 登録ボタンを押さずに反映する（属性・訪問結果のどちらでも可）。確定用の「登録」ボタンは
    // 「詳細を表示」内に控える（メモを添えたい等のときに使う）。押したボタンは即ハイライトして押下を可視化する。
    function pickNewAndSubmit(ev, inputId, val, lat, lng) {
        const btn = ev && ev.currentTarget;
        highlightPicked(btn);
        // 二重送信防止: 押した瞬間に新規フォーム内の選択ボタンを無効化する（応答前の連打で訂正タップが
        // サーバ側の重複抑止により無言で捨てられるのを防ぐ。失敗時は submitNewLocation の catch で復帰）。
        const form = btn ? btn.closest('.popup-content') : null;
        if (form) form.querySelectorAll('.choice-btn').forEach(b => { b.disabled = true; b.style.pointerEvents = 'none'; });
        const input = document.getElementById(inputId);
        if (input) input.value = val;
        submitNewLocation(lat, lng, '戸建て');
    }

    // 広域表示（ズームがこの値未満）のときは戸建てを隠す
    const KODATE_HIDE_BELOW_ZOOM = 16; // 17→16。もう少しだけ広域でも戸建てを表示（z16は約85%サイズ）
    // 小さめ集合住宅（12戸以下＝アパート型）は zoom 16.5未満で隠す（＝16.5以上で表示）。
    const SHUGA_SMALL_HIDE_BELOW_ZOOM = 16.5;
    // 大きめ集合住宅（13戸以上＝マンション型）は zoom 15.5未満で隠す（＝15.5以上で表示。小より広域から見える）。
    const SHUGA_LARGE_HIDE_BELOW_ZOOM = 15.5;
    function applyZoomVisibility() {
        const zoom = map.getZoom();
        const showKodate = zoom >= KODATE_HIDE_BELOW_ZOOM;
        const showSmallShuga = zoom >= SHUGA_SMALL_HIDE_BELOW_ZOOM; // 小規模集合住宅（≤12戸）
        const showLargeShuga = zoom >= SHUGA_LARGE_HIDE_BELOW_ZOOM; // 大規模集合住宅（≥13戸）
        const filterOn = iconFilterActive(); // フィルタ利用中はズーム非表示せず、チェック一致だけで判定（常時表示）
        currentMarkers.forEach(m => {
            let show;
            if (filterOn) {
                show = iconFilterShows(m._item);
            } else {
                let zoomShow = true;
                if (m._isKodate) zoomShow = showKodate;
                else if (m._isShuga) zoomShow = m._shugaSmall ? showSmallShuga : showLargeShuga;
                // 施設はズームでは常時表示
                show = zoomShow;
            }
            m.getElement().style.display = show ? '' : 'none';
        });
        const sb = document.getElementById('scale-btn'); if (sb) sb.classList.toggle('filtering', filterOn); // 「印」ボタンにフィルタ有効の目印
        applyZoomScale(); // ズームに応じてアイコンサイズも更新
    }
    map.on('zoomend', applyZoomVisibility);

    // ── ピンチ等のズーム中だけ、現在の縮尺（ズームレベル）を左下に薄く表示 ──
    // 目的: 「どの縮尺で何のアイコンを隠すか」を相談するときの参考値を見えるようにする。
    // ユーザー操作（ピンチ/スクロール/ダブルタップ）のみ表示（flyTo 等の自動移動では出さない）。操作が止まると自動で消える。
    let zoomIndHideTimer = null;
    function showZoomIndicator() {
        const el = document.getElementById('zoom-indicator');
        if (!el) return;
        el.textContent = 'ズーム ' + map.getZoom().toFixed(1);
        el.classList.add('show');
        clearTimeout(zoomIndHideTimer);
        zoomIndHideTimer = setTimeout(() => el.classList.remove('show'), 1200); // 操作が止まったら薄れて消える
    }
    function onUserZoom(e) { if (e && e.originalEvent) showZoomIndicator(); } // originalEvent あり＝ユーザー操作のみ
    map.on('zoomstart', onUserZoom);
    map.on('zoom', onUserZoom);

    // ズームレベルに応じてマーカーサイズを動的に変える（広域ほど小さく）
    // ベースサイズは全体的に1段階小さめ。☆形は本体が小さいため少し大きめ＆文字は控えめに。
    function applyZoomScale() {
        const zoom = map.getZoom();
        // 高ズーム(最大付近)ほど大きく。引きは急に小さくならないよう段階的に：
        // 19+=130%, 18=115%, 17=100%, 16=85%, 15=70%, 14=55%, 13=45%, 12=35%,
        // さらに引くと段階的に小さく：11=28%, 10=23%, 9=19%, 8以下=15%（最小）
        const scale = zoom >= 19 ? 1.30 : zoom >= 18 ? 1.15 : zoom >= 17 ? 1.0 : zoom >= 16 ? 0.85
            : zoom >= 15 ? 0.70 : zoom >= 14 ? 0.55 : zoom >= 13 ? 0.45 : zoom >= 12 ? 0.35
            : zoom >= 11 ? 0.28 : zoom >= 10 ? 0.23 : zoom >= 9 ? 0.19 : 0.15;
        // アイコンサイズ（右下ボタンの icon-large）で基準サイズを切替。文字サイズとは独立。
        const iconLarge = document.body.classList.contains('icon-large');
        currentMarkers.forEach(m => {
            const el = m.getElement();
            if (el.classList.contains('marker-kodedate')) {
                const base = iconLarge ? { w: 42, f: 24 } : { w: 24, f: 13 };
                const star = el.classList.contains('marker-star');
                el.style.width = el.style.height = Math.round(base.w * scale * (star ? 1.45 : 1)) + 'px';
                el.style.fontSize = Math.round(base.f * scale * (star ? 1.05 : 1)) + 'px';
            } else if (el.classList.contains('marker-shuga')) {
                const base = iconLarge ? { w: 46, f: 26 } : { w: 28, f: 16 };
                el.style.width = el.style.height = Math.round(base.w * scale) + 'px';
                el.style.fontSize = Math.round(base.f * scale) + 'px';
            } else if (el.classList.contains('marker-facility')) {
                const base = iconLarge ? { w: 46, f: 38 } : { w: 30, f: 24 }; // 施設＝絵文字。fontSize が見た目サイズ
                // 施設は目印なので低ズームで大きく見せる：z13で2.5倍、z16で等倍、その間は段階的(線形)に縮める（z13以下は2.5倍／z16以上は等倍）。
                const facMult = zoom <= 13 ? 2.5 : zoom >= 16 ? 1.0 : 2.5 - (zoom - 13) * 0.5;
                const typeMult = facilitySizeMult(el.dataset.facType, zoom); // 公園・区の施設=等倍／他=低ズーム0.6→ズームイン等倍
                el.style.width = el.style.height = Math.round(base.w * scale * facMult * typeMult) + 'px';
                el.style.fontSize = Math.round(base.f * scale * facMult * typeMult) + 'px';
            }
        });
    }

    // ── 処理中インジケーター（サーバー通信中は全画面オーバーレイで操作をブロック） ──
    function showBusy(msg) {
        // 操作をブロックする全画面オーバーレイ
        let ov = document.getElementById('busy-overlay');
        if (!ov) {
            ov = document.createElement('div');
            ov.id = 'busy-overlay';
            document.body.appendChild(ov);
        }
        ov.style.display = 'block';
        // スピナー＋メッセージ
        let el = document.getElementById('busy-indicator');
        if (!el) {
            el = document.createElement('div');
            el.id = 'busy-indicator';
            document.body.appendChild(el);
        }
        el.innerHTML = '<span class="spinner"></span>' + (msg || '更新中…');
        el.style.display = 'flex';
    }
    function hideBusy() {
        const el = document.getElementById('busy-indicator');
        if (el) el.style.display = 'none';
        const ov = document.getElementById('busy-overlay');
        if (ov) ov.style.display = 'none';
    }

    // ── 軽量「保存中」バッジ（楽観的更新用） ──
    // showBusy と違い全画面オーバーレイを出さず操作をブロックしない。飛んでいる通信数を参照カウントで表示する。
    let _savingCount = 0;
    function showSaving() {
        _savingCount++;
        let el = document.getElementById('saving-indicator');
        if (!el) {
            el = document.createElement('div');
            el.id = 'saving-indicator';
            el.innerHTML = '<span class="spinner"></span>保存中…';
            document.body.appendChild(el);
        }
        el.style.display = 'flex';
    }
    function hideSaving() {
        _savingCount = Math.max(0, _savingCount - 1);
        if (_savingCount === 0) {
            const el = document.getElementById('saving-indicator');
            if (el) el.style.display = 'none';
        }
    }
    // 楽観更新・新規登録の完了通知。「保存中…」と同じ位置・近い色で「○○しました」を一瞬出してフェードアウトする。
    // 緑の上部トースト(showToast)ではなく、更新中(saving)の流れを引き継ぐ控えめな下部バッジにする。
    function showDone(msg) {
        const sv = document.getElementById('saving-indicator');
        if (sv) sv.style.display = 'none'; // 「保存中…」が残っていれば消す（同じ場所で切り替わって見えるように。参照カウントは触らない）
        let el = document.getElementById('done-indicator');
        if (!el) {
            el = document.createElement('div');
            el.id = 'done-indicator';
            document.body.appendChild(el);
        }
        el.innerHTML = '<span class="done-check">✓</span>' + (msg || '完了しました');
        el.style.display = 'flex';
        el.style.opacity = '1';
        clearTimeout(window._doneTimer);
        clearTimeout(window._doneFade);
        window._doneTimer = setTimeout(() => {
            el.style.opacity = '0';
            window._doneFade = setTimeout(() => { el.style.display = 'none'; }, 320);
        }, 1500);
    }

    /* ── 住所で移動（地区→丁目→番地を選んで、そのエリアの中心へ移動） ──
       値は { 丁目: 最大番地 }（番地は1〜最大の連番）。null は丁目を持たない地区（例：鹿骨町）。
       【番地のマスタは code_api.gs の AREA_DEF】ここは初回起動・通信失敗時のフォールバック。
       サインイン時に getMe が最新を配布し、これを上書き＋localStorage(vm_areaDef) に保持する。
       ※ 地区そのものを増減したときだけ、地区マップSVG(AREA_MAP_SVG)とこのフォールバックも手で合わせる。 */
    let AREA_DATA = {
        '東小岩': { 1: 32, 2: 24, 3: 24, 4: 33 },
        '北篠崎': { 1: 9, 2: 28 },
        '南小岩': { 1: 15, 2: 23, 3: 29, 4: 18 },
        '東松本': { 1: 16, 2: 18 },
        '鹿骨町': null,
        '鹿骨':   { 1: 63, 2: 45, 3: 20, 4: 33, 5: 40, 6: 10 },
        '新堀':   { 1: 42, 2: 32 },
        '春江町': { 1: 3 },
        '谷河内': { 1: 20 },
        '西篠崎': { 1: 20, 2: 27 },
        '上篠崎': { 1: 25, 2: 27, 3: 17, 4: 30 },
        '篠崎町': { 1: 44, 7: 31, 8: 15 }
    };
    // 前回サインイン時に受け取った番地データ（マスタ由来）があれば、内蔵値より優先して復元する
    try { const _ad = JSON.parse(localStorage.getItem('vm_areaDef') || 'null'); if (_ad) AREA_DATA = _ad; } catch (e) {}
    // 地区選択のSVGマップ（Geminiで江戸川区の地区図をトレース。座標は見た目重視で地理座標ではない）。
    // 各 path のクリックで selectArea('district', 地区名) を呼ぶ＝既存の丁目/番地ロジックをそのまま利用。
    const AREA_MAP_SVG = `<div class="area-map"><svg viewBox="0 0 905 1060" role="group" aria-label="地区マップ">
      <g>
        <path class="dist" data-name="東小岩" onclick="selectArea('district','東小岩')" d="M 451,5 L 272,162 L 380,472 L 460,360 L 524,333 L 454,160 L 451,106 L 506,33 Z"/>
        <path class="dist" data-name="南小岩" onclick="selectArea('district','南小岩')" d="M 244,187 L 81,347 L 113,404 L 319,501 L 343,579 L 361,538 Z"/>
        <path class="dist" data-name="北篠崎" onclick="selectArea('district','北篠崎')" d="M 528,347 L 468,374 L 391,487 L 472,552 L 621,487 Z"/>
        <path class="dist" data-name="東松本" onclick="selectArea('district','東松本')" d="M 57,360 L 37,394 L 114,667 L 142,660 L 133,623 L 154,618 L 148,586 L 126,593 L 122,589 L 111,542 L 131,535 L 123,505 L 296,567 L 290,510 L 92,424 Z"/>
        <path class="dist" data-name="鹿骨町" onclick="selectArea('district','鹿骨町')" d="M 211,543 L 146,557 L 158,610 L 160,623 L 228,605 Z"/>
        <path class="dist" data-name="西篠崎" onclick="selectArea('district','西篠崎')" d="M 391,514 L 466,735 L 470,733 L 571,734 L 533,633 Z"/>
        <path class="dist" data-name="鹿骨" onclick="selectArea('district','鹿骨')" d="M 221,555 L 247,649 L 117,680 L 164,876 L 351,873 L 465,961 L 491,962 L 373,578 L 356,601 Z"/>
        <path class="dist" data-name="上篠崎" onclick="selectArea('district','上篠崎')" d="M 656,548 L 523,606 L 558,636 L 601,743 L 610,752 L 469,749 L 499,854 L 701,806 L 695,732 L 719,732 L 724,712 L 791,719 Z"/>
        <path class="dist" data-name="篠崎町" onclick="selectArea('district','篠崎町')" d="M 803,743 L 737,738 L 734,765 L 707,764 L 711,846 L 508,877 L 553,1033 L 771,963 L 732,859 L 808,842 L 865,816 Z"/>
        <path class="dist" data-name="新堀" onclick="selectArea('district','新堀')" d="M 162,889 L 196,1019 L 319,1026 L 314,976 L 392,934 L 327,890 Z"/>
        <path class="dist" data-name="春江町" onclick="selectArea('district','春江町')" d="M 405,945 L 385,953 L 362,964 L 346,970 L 339,974 L 324,980 L 332,1021 L 334,1027 L 392,1030 Z"/>
        <path class="dist" data-name="谷河内" onclick="selectArea('district','谷河内')" d="M 420,952 L 402,1033 L 519,1040 L 504,987 L 479,988 Z"/>
      </g>
      <g>
        <text class="lbl" data-name="東小岩" x="399" y="229">東小岩</text>
        <text class="lbl" data-name="南小岩" x="225" y="365">南小岩</text>
        <text class="lbl" data-name="北篠崎" x="503" y="456">北篠崎</text>
        <text class="lbl sm" data-name="東松本" x="142" y="506">東松本</text>
        <text class="lbl sm" data-name="鹿骨町" x="186" y="582">鹿骨町</text>
        <text class="lbl" data-name="西篠崎" x="482" y="650">西篠崎</text>
        <text class="lbl" data-name="鹿骨" x="300" y="757">鹿骨</text>
        <text class="lbl" data-name="上篠崎" x="661" y="708">上篠崎</text>
        <text class="lbl" data-name="篠崎町" x="674" y="893">篠崎町</text>
        <text class="lbl" data-name="新堀" x="262" y="949">新堀</text>
        <text class="lbl sm" data-name="春江町" x="366" y="993">春江町</text>
        <text class="lbl sm" data-name="谷河内" x="456" y="1006">谷河内</text>
      </g>
    </svg></div>`;

    /* ── 住所検索の「丁目マップ」：地区図の上に丁目番号バッジを重ね、タップでその丁目の番地選択へ進む ──
       ※ この機能は住所検索（地図移動モード）専用。印刷/貸出の住所指定モード(areaPickCallback)では出さない。
       丁目の一覧は AREA_DATA（サーバ AREA_DEF が正）を使い、ここは「番号をどこに置くか(SVG座標)」だけを持つ。
       添付画像をもとに見た目で配置。未定義の丁目は地区ラベル付近へ自動仮配置（後から座標を微調整可）。 */
    const CHOME_POS = {
        '東小岩': { 3: [406, 134], 4: [343, 193], 2: [461, 273], 1: [412, 361] },
        '南小岩': { 3: [220, 288], 4: [168, 324], 1: [225, 417], 2: [292, 398] },
        '北篠崎': { 1: [512, 399], 2: [487, 505] },
        '東松本': { 2: [102, 460], 1: [241, 513] },
        '鹿骨':   { 6: [175, 725], 5: [250, 717], 4: [308, 664], 3: [365, 671], 1: [263, 810], 2: [408, 817] },
        '西篠崎': { 1: [462, 593], 2: [508, 692] },
        '上篠崎': { 1: [633, 605], 3: [607, 671], 2: [687, 671], 4: [588, 797] },
        '篠崎町': { 8: [568, 932], 7: [687, 938], 1: [780, 800] },
        '新堀':   { 1: [209, 942], 2: [341, 917] },
        '春江町': { 1: [360, 980] },
        '谷河内': { 1: [468, 995] }
    };
    // 各地区ラベルの座標（CHOME_POS 未定義の丁目を仮配置する基準）
    const AREA_LBL_POS = {
        '東小岩': [399, 229], '南小岩': [225, 365], '北篠崎': [503, 456], '東松本': [142, 506],
        '鹿骨町': [186, 582], '西篠崎': [482, 650], '鹿骨': [300, 757], '上篠崎': [661, 708],
        '篠崎町': [674, 893], '新堀': [262, 949], '春江町': [366, 993], '谷河内': [456, 1006]
    };
    // 地区図SVGに重ねる丁目バッジ群を生成する。AREA_DATA の丁目すべてを必ず出す（位置は CHOME_POS／無ければ仮配置）。
    function buildChomeBadges() {
        let s = '<g class="chome-layer">';
        Object.keys(AREA_DATA).forEach(function (d) {
            const chomes = AREA_DATA[d];
            if (!chomes) return; // 丁目を持たない地区（鹿骨町）はバッジ無し＝地区そのものをタップして選択
            const keys = Object.keys(chomes);
            keys.forEach(function (c, idx) {
                let pos = (CHOME_POS[d] && CHOME_POS[d][c]) ? CHOME_POS[d][c] : null;
                if (!pos) { // 未定義はラベル付近に横並びで仮配置（後で CHOME_POS に正値を入れて微調整）
                    const base = AREA_LBL_POS[d] || [452, 530];
                    pos = [base[0] + (idx - (keys.length - 1) / 2) * 48, base[1] + 44];
                }
                s += '<g class="chome-badge" onclick="pickChomeOnMap(\'' + d + '\',' + c + ')">'
                   + '<circle cx="' + pos[0] + '" cy="' + pos[1] + '" r="24"/>'
                   + '<text x="' + pos[0] + '" y="' + pos[1] + '">' + c + '</text></g>';
            });
        });
        return s + '</g>';
    }
    // 丁目バッジのタップ：その地区・丁目を確定して既存の「番地を選択」ステップへ。selectArea は変更しない（共用ロジック保護）。
    function pickChomeOnMap(d, c) {
        areaSel.district = d;
        areaSel.chome = c;
        renderAreaStep('banchi');
    }

    let areaSel = { district: null, chome: null };
    let areaViewMode = localStorage.getItem('vm_areaView') || 'map'; // 'map'=地区図 / 'list'=一覧グリッド
    if (areaViewMode === 'chome') areaViewMode = 'map'; // 旧3状態('chome')の名残は地図に正規化
    let areaChomeOn = localStorage.getItem('vm_areaChome') === '1'; // 地図表示中に丁目バッジを重ねるか（住所検索のみ）
    // 一覧グリッドの並び順（3列×4行で江戸川区の地図配置に近づけた）
    const AREA_GRID_ORDER = ['東松本','南小岩','東小岩','鹿骨町','鹿骨','北篠崎','新堀','西篠崎','上篠崎','春江町','谷河内','篠崎町'];
    const SHARED_GROUP_NAME = '全体利用'; // 全体利用（共同利用）の予約グループ名。サーバの SHARED_GROUP_ と必ず一致させる
    function toggleAreaView() {
        areaViewMode = (areaViewMode === 'map') ? 'list' : 'map';
        localStorage.setItem('vm_areaView', areaViewMode);
        renderAreaStep('district');
    }
    // 地図表示中の「丁目表示」ON/OFF（住所検索のみ。印刷/貸出では出さない）
    function toggleChomeOverlay() {
        areaChomeOn = !areaChomeOn;
        localStorage.setItem('vm_areaChome', areaChomeOn ? '1' : '0');
        renderAreaStep('district');
    }
    let areaPickCallback = null; // 住所指定モード：番地確定時にこの関数へ住所文字列を渡す（無ければ通常＝地図移動）
    let suppressMapTapUntil = 0;  // この時刻まで地図タップ（新規登録）を無効化（住所モーダルを閉じた直後の誤爆防止）

    // onPick を渡すと「住所を選んで返す」モード、無指定だと「地図を移動」モード
    function openAreaNav(onPick) {
        areaPickCallback = (typeof onPick === 'function') ? onPick : null;
        areaSel = { district: null, chome: null };
        renderAreaStep('district');
        document.getElementById('area-modal').style.display = 'flex';
    }
    function closeAreaNav() {
        document.getElementById('area-modal').style.display = 'none';
        areaPickCallback = null;
        // 閉じた直後の地図への貫通タップ（戸建て/集合住宅の誤登録）を抑止。
        // 保留中の登録タイマーも念のためクリアする。
        clearTimeout(singleTapTimer);
        clearTimeout(window.longPressTimer);
        suppressMapTapUntil = Date.now() + 1200;
    }
    function renderAreaStep(step) {
        const title = document.getElementById('area-modal-title');
        const back = document.getElementById('area-back-btn');
        const toggle = document.getElementById('area-view-toggle');
        const chomeToggle = document.getElementById('area-chome-toggle');
        const body = document.getElementById('area-modal-body');
        if (chomeToggle) chomeToggle.style.display = 'none'; // 既定は隠し、地図表示(住所検索)のときだけ出す
        body.classList.remove('is-banchi'); // 番地グリッド(5列)は banchi ステップでのみ付与（他ステップでは外す）
        let html = '';
        if (step === 'district') {
            title.textContent = '地区を選択';
            back.style.visibility = 'hidden';
            toggle.style.display = '';             // 地区選択時だけ「地図⇔一覧」切替ボタンを出す
            const allowChome = !areaPickCallback;  // 丁目表示は住所検索（非pickモード）でのみ。印刷/貸出は従来挙動を保持
            if (areaViewMode === 'map') {
                toggle.textContent = '☰ 一覧';
                body.classList.add('is-map');
                body.classList.remove('is-list');
                // 地図表示中はONなら地区図に丁目バッジを重ねる。右上に丁目ON/OFFトグルを出す。
                const showChome = allowChome && areaChomeOn;
                html = showChome ? AREA_MAP_SVG.replace('</svg>', buildChomeBadges() + '</svg>') : AREA_MAP_SVG;
                if (chomeToggle && allowChome) {
                    chomeToggle.style.display = '';
                    chomeToggle.textContent = areaChomeOn ? '☑ 丁目' : '☐ 丁目';
                    chomeToggle.classList.toggle('on', areaChomeOn);
                }
            } else {
                toggle.textContent = '🗺 地図';
                body.classList.add('is-list');
                body.classList.remove('is-map');
                AREA_GRID_ORDER.forEach(d => {
                    html += `<button class="area-opt" onclick="selectArea('district','${d}')">${d}</button>`;
                });
            }
        } else if (step === 'chome') {
            toggle.style.display = 'none';
            body.classList.remove('is-map');
            body.classList.remove('is-list');
            title.textContent = areaSel.district + ' の丁目を選択';
            back.style.visibility = 'visible';
            back.onclick = () => renderAreaStep('district');
            Object.keys(AREA_DATA[areaSel.district]).forEach(c => {
                html += `<button class="area-opt" onclick="selectArea('chome',${c})">${c}丁目</button>`;
            });
        } else if (step === 'banchi') {
            toggle.style.display = 'none';
            body.classList.remove('is-map');
            body.classList.remove('is-list');
            body.classList.add('is-banchi'); // 番地ボタンは5列グリッド（横幅いっぱい）

            title.textContent = areaSel.district + areaSel.chome + '丁目 の番地を選択';
            back.style.visibility = 'visible';
            back.onclick = () => renderAreaStep('chome');
            const maxB = AREA_DATA[areaSel.district][areaSel.chome];
            for (let b = 1; b <= maxB; b++) {
                html += `<button class="area-opt area-opt-num" data-b="${b}">${b}</button>`;
            }
        }
        body.innerHTML = html;
        body.scrollTop = 0;
        // 番地ボタンはタップでその番地へ移動して枠表示（枠内ピン一括割当は廃止）
        if (step === 'banchi') {
            body.querySelectorAll('.area-opt-num').forEach(el => {
                const b = parseInt(el.dataset.b, 10);
                el.onclick = () => selectArea('banchi', b);
            });
        }
    }
    // タップと長押しを区別してハンドラを割り当てる。
    // ※ pointercancel はモバイルの長押し（コールアウト）開始時に誤発火するため使わず、
    //   touch / mouse イベントで実装。スクロール（移動）でキャンセル、touchendはpreventDefaultで合成clickを抑止。
    // 直近のtouch時刻（全 attachLongPress で共有＝グローバル）。renderRoomGrid 等の再描画でセルが
    // 作り直されても合成mouse(ゴーストクリック)抑止が効くよう、attachLongPress のローカルにはしない。
    let lastTouch = 0;
    // 長押し(onLong)発火後の release で onTap を誤発火させないための共有フラグ。longFired は要素ごと(ローカル)なので、
    // renderRoomGrid 等でセルが作り直されると新セルの mouseup(longFired=false)が onTap してしまう（PCで部屋が外れる）。これを防ぐためグローバルにする。
    let longActive = false;
    function attachLongPress(el, onTap, onLong) {
        let timer = null, longFired = false, sx = 0, sy = 0, moved = false;
        try { el.style.userSelect = 'none'; el.style.webkitUserSelect = 'none'; el.style.webkitTouchCallout = 'none'; } catch (e) {} // 長押し対象の文字選択・コールアウトを抑止
        const begin = (x, y) => {
            longFired = false; moved = false; longActive = false; sx = x; sy = y;
            clearTimeout(timer);
            timer = setTimeout(() => { longFired = true; longActive = true; try { const sel = window.getSelection(); if (sel) sel.removeAllRanges(); } catch (e) {} onLong(); }, 500);
        };
        const movecheck = (x, y) => {
            if (Math.abs(x - sx) > 10 || Math.abs(y - sy) > 10) { moved = true; clearTimeout(timer); }
        };
        const finish = () => { clearTimeout(timer); if (longActive) { longActive = false; return; } if (!longFired && !moved) onTap(); };
        // touch直後はAndroid Chromeが合成mouse(mousedown→mouseup→click)を発火し、mouseup経由でfinish()が再度onTapを呼ぶ二重発火を起こす。
        // touch操作の時刻を記録し、直後の合成mouse系は無視する（地図側のsuppressMapTapUntilと同型の時刻ガード。PCはtouch非発火で常にlastTouch=0→ガード無効）。
        const synthMouse = () => Date.now() - lastTouch < 600;
        el.addEventListener('touchstart', (e) => { lastTouch = Date.now(); const t = e.touches[0]; begin(t.clientX, t.clientY); }, { passive: true });
        el.addEventListener('touchmove', (e) => { lastTouch = Date.now(); const t = e.touches[0]; if (t) movecheck(t.clientX, t.clientY); }, { passive: true });
        el.addEventListener('touchend', (e) => { lastTouch = Date.now(); if (longFired) e.preventDefault(); finish(); }); // 長押し時のみ既定動作を止める（タップ/横スクロールは妨げない）
        el.addEventListener('mousedown', (e) => { if (synthMouse()) return; begin(e.clientX, e.clientY); });
        el.addEventListener('mousemove', (e) => { if (timer) movecheck(e.clientX, e.clientY); });
        el.addEventListener('mouseup', () => { if (synthMouse()) return; finish(); });
        el.addEventListener('mouseleave', () => clearTimeout(timer));
        el.addEventListener('contextmenu', (e) => e.preventDefault()); // 長押しメニューを抑止
    }
    function selectArea(kind, val) {
        if (kind === 'district') {
            areaSel.district = val;
            if (AREA_DATA[val] === null) {            // 丁目を持たない地区（鹿骨町）
                areaSel.chome = null;
                const cb = areaPickCallback;
                closeAreaNav();
                if (cb) cb(val);                      // 住所指定モード：住所を返す
                else geocodeAndFly(ADDR_PREFIX + val, 16, false, val); // 通常：移動
            } else {
                renderAreaStep('chome');
            }
        } else if (kind === 'chome') {
            areaSel.chome = val;
            renderAreaStep('banchi');
        } else if (kind === 'banchi') {
            const label = areaSel.district + areaSel.chome + '丁目' + val + '番';
            const cb = areaPickCallback;
            closeAreaNav();
            if (cb) {
                cb(label); // 住所指定モード：選んだ住所を返す（地図は動かさない）
            } else {
                // 通常モード：その番地へ移動して街区を赤線で囲む
                const query = ADDR_PREFIX + areaSel.district + areaSel.chome + '-' + val;
                geocodeAndFly(query, 18, true, label);
            }
        }
    }
    // 外部リンク(?area=ラベル)で渡された番地を表示する（赤枠表示のみ。割当はしない）。
    // area は既知の地区(AREA_DATA)に照合し、ラベルは地区名＋数字から組み直す（不正値・XSS対策）。
    function runAreaDeepLink(area) {
        area = (area || '').trim();
        const m = area.match(/^(.+?)(\d+)丁目(\d+)番$/);
        if (m && AREA_DATA[m[1]]) {                              // 例「東小岩3丁目5番」：番地へズーム＋赤枠
            const label = m[1] + m[2] + '丁目' + m[3] + '番';
            geocodeAndFly(ADDR_PREFIX + m[1] + m[2] + '-' + m[3], 18, true, label);
        } else if (AREA_DATA.hasOwnProperty(area) && AREA_DATA[area] === null) {
            geocodeAndFly(ADDR_PREFIX + area, 16, false, area); // 鹿骨町（丁目なし）：地区へ移動
        } else {
            showToast('リンクの住所が見つかりませんでした', true);
        }
    }
    // 外部リンク(?pin=行番号)で指定された行のピンへ寄り、その吹き出しを開く（スプレッドシートの行リンク用）。
    function openPinDeepLink(rowNumber) {
        const item = currentData.find(d => d.rowNumber === rowNumber);
        if (!item) { showToast('リンクのピンが見つかりませんでした', true); return; }
        const lng = parseFloat(item.経度), lat = parseFloat(item.緯度);
        if (isNaN(lng) || isNaN(lat)) { showToast('ピンの座標が不正です', true); return; }
        const openIt = () => {
            const marker = currentMarkers.find(m => m._rowNumber === rowNumber);
            if (!marker) return; // 間引き表示で未描画なら、寄った後の再描画で再試行される
            if (activeNewMarker) { activeNewMarker.remove(); activeNewMarker = null; }
            currentMarkers.forEach(o => { const p = o.getPopup(); if (o !== marker && p && p.isOpen()) o.togglePopup(); });
            const mp = marker.getPopup();
            if (mp && !mp.isOpen()) marker.togglePopup(); // 既に開いていれば何もしない（冪等）
        };
        map.flyTo({ center: [lng, lat], zoom: 19, duration: 1200 }); // 戸建ては zoom16未満で隠れるため確実に見える寄りに
        map.once('moveend', () => setTimeout(openIt, 80)); // 間引き再描画(既存moveend)の後にマーカーを開く
        setTimeout(openIt, 1500);                          // moveendが発火しない場合のフォールバック
    }
    // 住所をジオコーディングして地点へ移動。日本の番地に強い国土地理院(GSI)を優先し、失敗時のみMapbox。
    // outline=true のとき、移動先の番地を含む街区を赤線で囲む。label を画面上部に約10秒表示。
    // onArrive: 到着後（枠描画後）に実行する処理。長押しの一括割当などに使う。
    function geocodeAndFly(query, zoom, outline, label, onArrive) {
        zoom = zoom || 18;
        showBusy('検索中…');
        fetch('https://msearch.gsi.go.jp/address-search/AddressSearch?q=' + encodeURIComponent(query))
            .then(r => r.json())
            .then(list => {
                if (Array.isArray(list) && list.length && list[0].geometry && list[0].geometry.coordinates) {
                    hideBusy();
                    arriveAt(list[0].geometry.coordinates, zoom, outline, label, onArrive);
                } else {
                    mapboxGeocodeFly(query, zoom, outline, label, onArrive); // GSIで見つからなければMapboxへ
                }
            })
            .catch(() => mapboxGeocodeFly(query, zoom, outline, label, onArrive));
    }
    function mapboxGeocodeFly(query, zoom, outline, label, onArrive) {
        const url = 'https://api.mapbox.com/geocoding/v5/mapbox.places/' + encodeURIComponent(query)
            + '.json?access_token=' + encodeURIComponent(mapboxgl.accessToken)
            + '&country=jp&language=ja&limit=1&proximity=' + AREA_PROXIMITY;
        fetch(url).then(r => r.json()).then(data => {
            hideBusy();
            if (data && data.features && data.features.length) {
                arriveAt(data.features[0].center, Math.min(zoom, 17), outline, label, onArrive);
            } else {
                showToast('該当の場所が見つかりませんでした', true);
            }
        }).catch(() => { hideBusy(); showToast('住所検索に失敗しました', true); });
    }
    // 選択中の住所をURL(?area=)へ反映する（既存の外部リンク機能を流用）。
    // タブ破棄や再読込が起きても、ページを更新すれば同じ場所＋赤枠に自動で戻れる。
    // ?area= が解釈できる形式（「○○N丁目M番」または丁目なし地区名）のときだけ書き込む。
    function setAreaUrl(label) {
        try {
            const u = new URL(location.href);
            if (label && isAreaLinkable(label)) {
                u.searchParams.set('area', label);
                u.searchParams.delete('pin'); // 最後の操作を優先（リロード時に両方発火させない）
            } else if (!label) {
                u.searchParams.delete('area');
            } else {
                return; // 解釈できない住所はURLに書かない（リロード時のエラー表示を防ぐ）
            }
            history.replaceState(null, '', u);
        } catch (e) {}
    }
    function isAreaLinkable(label) {
        const m = String(label || '').match(/^(.+?)(\d+)丁目(\d+)番$/);
        if (m && AREA_DATA[m[1]]) return true;
        return AREA_DATA.hasOwnProperty(label) && AREA_DATA[label] === null; // 鹿骨町など丁目なし地区
    }
    // 移動 → 街区を赤線で囲む（無ければ枠で代用）→ 地域名を表示 →（あれば）到着後処理
    function arriveAt(center, zoom, outline, label, onArrive) {
        map.flyTo({ center: center, zoom: zoom, duration: 1200 });
        if (outline) showBlockOrBox(center, label); else clearBanchiBox();
        if (label) { showAreaLabel(label); setAreaUrl(label); } // 住所表示と同時に ?area= も更新（復元用）
        if (typeof onArrive === 'function') onArrive();
    }

    /* ── 住所の表示（街区内包方式で番地を判定）。手動指定(E列)があればそれを優先 ── */
    // 詳細ポップアップに入れる「住所」行。未指定の住所は吹き出し表示時に fillDerivedAddress で算出して埋める。
    // attrHtml: 戸建てで住所の右側に置く属性の現在値ボタン（集合住宅は未使用）
    function addrRowHtml(item, attrHtml) {
        const stored = (item.住所 && item.住所 !== '-' && String(item.住所).trim() !== '') ? item.住所 : '';
        const lng = parseFloat(item.経度), lat = parseFloat(item.緯度);
        const shown = stored || '判定中…';
        return `<div style="font-size:14px; color:#555; margin-bottom:6px; display:flex; align-items:center; gap:6px; flex-wrap:wrap;">`
            + `🏠 <span class="derived-addr" id="addr-text-${item.rowNumber}" data-lng="${lng}" data-lat="${lat}" data-stored="${stored ? '1' : '0'}" style="cursor:pointer;" title="タップで番地を赤枠表示">${escHtml(shown)}</span>`
            + `<span style="cursor:pointer; padding:0 4px; font-size:17px;" title="Googleマップでこの地点を開く" onclick="window.open('https://www.google.com/maps/search/?api=1&query=${lat},${lng}','_blank')">🗺</span>`
            + (attrHtml || '')
            + `</div>`;
    }
    // 吹き出しの住所をタップ → 住所選択時と同じ赤枠（街区）を表示し、上部に住所ラベルを出す。
    function outlineAddrForPin(rowNumber) {
        const item = currentData.find(d => d.rowNumber === rowNumber);
        if (!item) return;
        const lng = parseFloat(item.経度), lat = parseFloat(item.緯度);
        if (isNaN(lng) || isNaN(lat)) return;
        const addr = (item.住所 && item.住所 !== '-' && String(item.住所).trim() !== '') ? addrWithoutGo(item.住所) : (deriveAddress(lng, lat) || '');
        arriveAt([lng, lat], 18, true, addr);   // 赤枠＋上部ラベルは「番」まで（号は落とす）。住所選択時と同じ flyTo
    }
    // 新規登録フォームの住所タップ → 同様に新規地点の番地を赤枠表示＋遷移する。
    function outlineNewAddr() {
        if (isNaN(newPinLng) || isNaN(newPinLat)) return;
        const addr = newPinAddress ? addrWithoutGo(newPinAddress) : (deriveAddress(newPinLng, newPinLat) || ''); // 赤枠ラベルは「番」まで（号は落とす）
        arriveAt([newPinLng, newPinLat], 18, true, addr);
    }
    // 吹き出し内の未指定住所(.derived-addr[data-stored=0])を、街区内包方式で算出して表示に反映
    function fillDerivedAddress(rootEl) {
        if (!rootEl || !rootEl.querySelectorAll) return;
        rootEl.querySelectorAll('.derived-addr[data-stored="0"]').forEach(el => {
            const a = deriveAddress(parseFloat(el.dataset.lng), parseFloat(el.dataset.lat));
            el.textContent = a ? a : (addrPoints ? '（住所判定不可）' : '判定中…');
        });
        // 住所表示にタップ（番地を赤枠表示）を割り当てる（長押しでの住所指定は廃止）
        rootEl.querySelectorAll('.derived-addr').forEach(el => {
            if (el._goBound) return;
            const rn = parseInt(String(el.id).replace('addr-text-', ''));
            if (!rn) return;
            el._goBound = true;
            attachLongPress(el, () => outlineAddrForPin(rn), () => {});
        });
    }
    function saveAddressFor(rowNumber, addr) {
        showBusy('更新中…');
        apiCall('updateAddress', { rowNumber: rowNumber, address: addr }).then((latest) => {
            applyInPlace(rowNumber, latest);
            showToast('住所を保存しました', false);
        }).catch(handleServerError).finally(hideBusy);
    }
    // 新規登録フォームで指定中の住所（登録時に送信）
    let newPinAddress = '';
    let newPinLng = NaN, newPinLat = NaN; // 新規登録地点の座標（住所タップで赤枠表示するのに使う）
    // 住所の「号」を選ぶモーダル（なし＋1〜50）。cb(go) で選択値（''=なし）を返す。Esc/枠外で閉じる。
    function pickGoNumber(curGo, cb) {
        let ov = document.getElementById('go-pick-overlay');
        if (!ov) { ov = document.createElement('div'); ov.id = 'go-pick-overlay'; document.body.appendChild(ov); }
        let g = `<button class="go-pick-btn${!curGo ? ' cur' : ''}" data-go="">なし</button>`;
        for (let i = 1; i <= 50; i++) g += `<button class="go-pick-btn${String(i) === String(curGo) ? ' cur' : ''}" data-go="${i}">${i}</button>`;
        ov.innerHTML = `<div id="go-pick-card"><div id="go-pick-title">「号」を選んでください</div><div id="go-pick-grid">${g}</div><button id="go-pick-cancel">キャンセル</button></div>`;
        ov.style.display = 'flex';
        const close = () => { ov.style.display = 'none'; document.removeEventListener('keydown', onKey, true); };
        const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
        document.addEventListener('keydown', onKey, true);
        ov.onclick = (e) => { if (e.target === ov) close(); };
        ov.querySelectorAll('.go-pick-btn').forEach(b => { b.onclick = () => { close(); cb(b.dataset.go); }; });
        document.getElementById('go-pick-cancel').onclick = close;
    }
    // 既存ピンの住所に「号」を設定（番地部分は維持し、号だけ差し替え）
    function pickGoForPin(rn) {
        const item = currentData.find(d => d.rowNumber === rn);
        if (!item) return;
        let base = (item.住所 && item.住所 !== '-' && String(item.住所).trim() !== '') ? item.住所 : (deriveAddress(parseFloat(item.経度), parseFloat(item.緯度)) || '');
        base = addrWithoutGo(base);
        if (!base) { showToast('先に番地を表示してください', true); return; }
        pickGoNumber(addrGoOf(item.住所), go => saveAddressFor(rn, addrWithGo(base, go)));
    }
    // 新規登録フォームの住所に「号」を設定
    function pickGoForNew() {
        let base = addrWithoutGo(newPinAddress || deriveAddress(newPinLng, newPinLat) || '');
        if (!base) { showToast('先に番地を指定してください', true); return; }
        pickGoNumber(addrGoOf(newPinAddress), go => {
            newPinAddress = addrWithGo(base, go);
            const el = document.getElementById('new-addr-text');
            if (el) el.textContent = newPinAddress;
        });
    }
    // 新規登録フォームに入れる「住所」行。attrHtml: 戸建てで右側に置く属性の現在値ボタン
    function newAddrRowHtml(attrHtml) {
        return `<div style="font-size:14px; color:#555; margin:-2px 0 6px; display:flex; align-items:center; gap:6px; flex-wrap:wrap;">`
            + `🏠 <span id="new-addr-text" style="cursor:pointer;" title="タップで番地を赤枠表示">${escHtml(newPinAddress || '（住所未指定）')}</span>`
            + (attrHtml || '')
            + `</div>`;
    }

    /* ── 街区(番)ポリゴン：OSMの道路から生成した blocks.geojson を読み込み、
          番地代表点を内包する街区を赤線で囲む。見つからない場合は約70m四方の枠で代用。 ── */
    let blocksData = null;
    function loadBlocks() {
        if (blocksData) return Promise.resolve();
        return fetch('blocks.geojson').then(r => r.json())
            .then(d => { blocksData = (d && d.features) ? d.features : []; })
            .catch(() => { blocksData = []; }); // 取得失敗時は枠フォールバックで動作
    }
    // 点が多角形(外周リング)の内側かを判定（レイキャスティング）
    function pointInRing(lng, lat, ring) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
            if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
        }
        return inside;
    }
    function findBlock(lng, lat) {
        if (!blocksData) return null;
        for (let k = 0; k < blocksData.length; k++) {
            const g = blocksData[k].geometry;
            const ring = g && g.coordinates && g.coordinates[0];
            if (ring && pointInRing(lng, lat, ring)) return blocksData[k];
        }
        return null;
    }

    /* ── 住所の逆算取得：番地の代表点(address_points.json)を読み込み、
          ピン座標に最も近い番地の住所を返す（赤枠＝街区の逆算に相当） ── */
    let addrPoints = null; // [{a:'東小岩3丁目5番', x:lng, y:lat}, ...]
    function loadAddrPoints() {
        if (addrPoints) return;
        fetch('address_points.json').then(r => r.json())
            .then(d => {
                addrPoints = Array.isArray(d) ? d : [];
                // 読み込み前に開いていた吹き出しがあれば住所を反映する
                document.querySelectorAll('.mapboxgl-popup').forEach(p => fillDerivedAddress(p));
            })
            .catch(() => { addrPoints = []; });
    }
    function distM(lng1, lat1, lng2, lat2) {
        const R = 6371000, toR = Math.PI / 180;
        const dLat = (lat2 - lat1) * toR, dLng = (lng2 - lng1) * toR;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    }
    // 座標→住所（番地）。ピンを内包する街区(赤枠)を特定し、その街区内に代表点がある番地を採用する。
    //  ・街区内に番地点が複数（OSMで結合された場合）→ ピンに最も近いものを採用
    //  ・街区が特定できない/街区内に番地点が無い場合 → 最寄り番地(400m以内)にフォールバック
    function deriveAddress(lng, lat) {
        if (!addrPoints || !addrPoints.length || isNaN(lng) || isNaN(lat)) return null;
        const cosLat = Math.cos(lat * Math.PI / 180); // 経度差は緯度で縮むため補正（最寄り判定を実距離に近づける）
        const block = findBlock(lng, lat); // ピンを内包する街区（赤枠と同じロジック）
        if (block && block.geometry && block.geometry.coordinates) {
            const ring = block.geometry.coordinates[0];
            let best = null, bd = Infinity;
            for (let i = 0; i < addrPoints.length; i++) {
                const p = addrPoints[i];
                if (!pointInRing(p.x, p.y, ring)) continue; // その街区の中にある番地点だけ
                const dx = (p.x - lng) * cosLat, dy = p.y - lat, d = dx * dx + dy * dy;
                if (d < bd) { bd = d; best = p; }
            }
            if (best) return best.a;
        }
        // フォールバック：街区で特定できないときは最寄り番地（400m以内）
        let nb = null, nd = Infinity;
        for (let i = 0; i < addrPoints.length; i++) {
            const p = addrPoints[i];
            const dx = (p.x - lng) * cosLat, dy = p.y - lat, d = dx * dx + dy * dy;
            if (d < nd) { nb = p; nd = d; }
        }
        if (nb && distM(lng, lat, nb.x, nb.y) <= 400) return nb.a;
        return null;
    }

    /* ── 住所の「号」ヘルパー ── 住所(E列)は「○○3丁目5番」または「○○3丁目5番16号」。
       号は末尾の「M号」で表す。街区検索・?area は番地部分だけを使う（号は表示・記録用）。 */
    function addrWithoutGo(addr) { return String(addr || '').replace(/\d+号\s*$/, '').trim(); }
    function addrWithGo(banchi, go) { banchi = addrWithoutGo(banchi); return (go ? banchi + go + '号' : banchi); }
    function addrGoOf(addr) { const m = String(addr || '').match(/(\d+)号\s*$/); return m ? m[1] : ''; }

    /* アイコン位置から最寄りの「号」(住居番号)を Mapbox から取得する。
       mapbox-streets-v8 の housenum_label ソースレイヤーを Tilequery API で照会し、最も近い house_num を返す。
       データが無い地域では null（その場合は番地のみ＝手動の「号」設定に委ねる）。 */
    function fetchNearestHouseNum(lng, lat) {
        const url = 'https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/tilequery/'
            + lng + ',' + lat + '.json?radius=25&limit=10&dedupe&layers=housenum_label&access_token='
            + encodeURIComponent(mapboxgl.accessToken);
        return fetch(url).then(r => r.json()).then(d => {
            let best = null;
            ((d && d.features) || []).forEach(f => {
                const p = f.properties || {};
                const hn = (p.house_num != null && p.house_num !== '') ? String(p.house_num) : '';
                if (!hn || !/^\d+$/.test(hn)) return; // 数字の号だけ扱う（"1-2" 等は対象外）
                const dist = (p.tilequery && typeof p.tilequery.distance === 'number') ? p.tilequery.distance : Infinity;
                if (!best || dist < best.dist) best = { num: hn, dist: dist };
            });
            return best ? best.num : null;
        }).catch(() => null);
    }
    function boxFeature(center) {
        const lng = center[0], lat = center[1], half = 35; // 約70m四方
        const dLat = half / 111320, dLng = half / (111320 * Math.cos(lat * Math.PI / 180));
        return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[
            [lng - dLng, lat - dLat], [lng + dLng, lat - dLat],
            [lng + dLng, lat + dLat], [lng - dLng, lat + dLat], [lng - dLng, lat - dLat]
        ]] } };
    }
    // 現在表示中の赤枠（街区ポリゴン）と、その住所ラベル。枠内ピン一括割当で使う。
    let currentBoxFeature = null;
    let currentBoxAddr = null;
    function showBlockOrBox(center, addr) {
        const f = findBlock(center[0], center[1]) || boxFeature(center);
        currentBoxFeature = f;       // 枠内ピン一括割当（番地ボタン長押し）で参照
        currentBoxAddr = addr || null;
        drawBanchiFeature(f);
    }
    function drawBanchiFeature(feature) {
        const draw = () => {
            if (map.getSource('banchi-box')) {
                map.getSource('banchi-box').setData(feature);
            } else {
                map.addSource('banchi-box', { type: 'geojson', data: feature });
                // 赤線のみ（内側の網掛けは無し）
                map.addLayer({ id: 'banchi-box-line', type: 'line', source: 'banchi-box',
                    paint: { 'line-color': '#e03131', 'line-width': 3 } });
            }
        };
        if (map.isStyleLoaded()) draw(); else map.once('idle', draw);
    }
    function clearBanchiBox() {
        if (map.getSource('banchi-box')) {
            map.getSource('banchi-box').setData({ type: 'FeatureCollection', features: [] });
        }
        currentBoxFeature = null;
        currentBoxAddr = null;
    }
    // 画面上部に選択した地域名（番地まで）を常時表示する（長押しで消去できる）
    function showAreaLabel(text) {
        const el = document.getElementById('area-label');
        // 住所だけを表示。タップ＝枠線と住所表示の消去（消去前に確認ダイアログを出すので誤タップでも即消えない）
        // ※利用者入力(住所D/E列・AreaList区域名)が来るため必ず escHtml（保存型XSS対策）。
        el.innerHTML = '<span id="area-label-text">' + escHtml(text) + '</span>';
        el.style.display = 'block';
        attachLongPress(document.getElementById('area-label-text'), () => askClearAreaSelection(), () => {});
    }
    // 住所表示をタップ → 枠線と住所表示を消すか確認してクリア
    function askClearAreaSelection() {
        appConfirm('枠線と住所表示を消しますか？', { okLabel: '消す' }).then(ok => {
            if (!ok) return;
            clearBanchiBox();
            document.getElementById('area-label').style.display = 'none';
            setAreaUrl(null); // 復元用の ?area= もURLから消す
        });
    }

    // ピンが多いときは画面内だけ描画して負荷を抑える（少なければ全件表示）
    const MAX_RENDER_ALL = 200;
    let limitedMode = false;
    function inCurrentView(item) {
        const lat = parseFloat(item.緯度), lng = parseFloat(item.経度);
        if (isNaN(lat) || isNaN(lng)) return false;
        return map.getBounds().contains([lng, lat]);
    }
    map.on('moveend', () => {
        if (!limitedMode) return;
        if (activeNewMarker || document.querySelector('.mapboxgl-popup')) return; // 操作中は再描画しない
        renderMarkers(currentData);
    });

    // 戸建てピンの見た目（属性＝拒否/外国語/空き家 を優先、なければ訪問結果）
    // star:true のものは○ではなく☆形マーカー（塗り＝color／白文字）で描画する。
    function kodateVisual(item) {
        const attr = item.属性;
        if (attr === '訪問拒否') return { char: '拒', color: '#B0554D', star: true };
        if (attr === '外国語')   return { char: '外', color: '#8E79AB', star: true };
        if (attr === '空き家')   return { char: '空', color: '#8C8C8C' };
        if (attr === '他')       return { char: '他', color: '#7f8c8d' };
        if (attr === '会社')     return { char: '🏢', color: '#2E5090' }; // 会社＝丸形・🏢。属性優先＝訪問結果でアイコンを変えない
        const s = item.最新ステータス;
        const ab = String(s).match(/不在\((\d+)回目\)/); // 不在は回数を抽出（上限なし）
        if (ab) {
            const n = parseInt(ab[1], 10);
            return { char: String(n), color: n >= 3 ? '#1B4F72' : n === 2 ? '#4A78B0' : '#333333' };
        }
        if (s === '会えた')      return { char: '会', color: '#DB7C2E' }; // オレンジ
        if (s === '投函')        return { char: '投', color: '#3E8E54' };
        if (s === '訪問拒否')    return { char: '拒', color: '#B0554D', star: true };
        if (s === '外国語')      return { char: '外', color: '#8E79AB', star: true };
        if (s === '空き家')      return { char: '空', color: '#8C8C8C' };
        return { char: '未', color: '#6FAEC0' }; // 未訪問（新規未操作・履歴クリア後）
    }

    // 戸建てマーカー要素に見た目（文字・色・☆形）を適用する。新規描画とその場更新の両方で使う。
    function styleKodateMarker(markerEl, item) {
        markerEl.className = 'custom-marker marker-kodedate';
        const kv = kodateVisual(item);
        markerEl.innerHTML = kv.char;
        markerEl.style.background = '';
        if (kv.star) {
            markerEl.classList.add('marker-star'); // ☆形：塗り＝属性色／白文字
            markerEl.style.background = kv.color;
            markerEl.style.color = '#fff';
        } else {
            markerEl.style.color = kv.color;
        }
    }

    // マーカーを長押しすると「移動モード」（金色グロー）に入り、指を動かすとアイコンが追従し、離すと確認して座標を保存する。
    // Mapbox標準のドラッグは長押し後の同一タッチでは効かないため、pointermoveで自前にマーカーを動かす。
    // touch/mouse を混在させると合成イベントで二重起動し、移動モードのdocumentリスナが残って以降のタップが
    // 効かなくなるため、pointer events に統一する。通常タップ（吹き出し）と区別するため長押し(500ms)で起動。
    // 同時タッチ数を数える（ピンチ等＝2本指以上を検知して、マーカー移動の長押しを抑止するため）。document の capture で各マーカーより先に拾う。
    let activeTouchPoints = 0;
    document.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') activeTouchPoints++; }, true);
    const _decTouchPoints = (e) => { if (e.pointerType === 'touch') activeTouchPoints = Math.max(0, activeTouchPoints - 1); };
    document.addEventListener('pointerup', _decTouchPoints, true);
    document.addEventListener('pointercancel', _decTouchPoints, true);

    function enableMarkerDragOnLongPress(marker, el, rowNumber) {
        let pressTimer = null, moving = false, dragged = false, sx = 0, sy = 0;
        const onMove = (cx, cy) => {
            if (!moving) return;
            dragged = true;
            const rect = map.getContainer().getBoundingClientRect();
            marker.setLngLat(map.unproject([cx - rect.left, cy - rect.top]));
        };
        const onPM = (e) => { if (moving) { e.preventDefault(); onMove(e.clientX, e.clientY); } };
        const finishMove = () => {
            if (!moving) return;
            moving = false;
            el.classList.remove('marker-moving');
            map.dragPan.enable();
            document.removeEventListener('pointermove', onPM);
            document.removeEventListener('pointerup', finishMove);
            document.removeEventListener('pointercancel', finishMove);
            suppressMapTapUntil = Date.now() + 1500; // 離した直後の地図タップ（新規登録）を抑止
            clearTimeout(singleTapTimer);            // 予約済みの戸建て登録タイマーもキャンセル
            if (!dragged) return; // 動かさず離した → 何もしない（通常の click で吹き出しが開く）
            const ll = marker.getLngLat();
            // 移動先が他のピンと同一座標になる場合は自動キャンセル（同座標スタックを作らない。判定はピンのグループ化と同じ6桁一致）
            const destKey = ll.lat.toFixed(6) + '_' + ll.lng.toFixed(6);
            const clash = (currentData || []).some(d => d.rowNumber !== rowNumber
                && parseFloat(d.緯度).toFixed(6) + '_' + parseFloat(d.経度).toFixed(6) === destKey);
            if (clash) {
                renderMarkers(currentData); // 元の位置へ戻す
                showToast('移動先に既にピンがあるため移動をキャンセルしました', true);
                return;
            }
            appConfirm('このピンをここへ移動しますか？', { okLabel: '移動する' }).then(ok => {
                if (!ok) { renderMarkers(currentData); return; } // キャンセル → 元の位置へ戻す
                showBusy('移動中…');
                apiCall('updateCoords', { rowNumber: rowNumber, lat: ll.lat, lng: ll.lng })
                    .then(latest => { showToast('移動しました', false); renderMarkers(latest); })
                    .catch(err => { handleServerError(err); renderMarkers(currentData); })
                    .finally(hideBusy);
            });
        };
        const enter = () => {
            if (activeTouchPoints >= 2) return; // 複数指（ピンチ等）が同時に検知されている間は移動モードに入らない
            moving = true; dragged = false;
            el.classList.add('marker-moving');
            map.dragPan.disable();                    // 移動中は地図がパンしないように
            suppressMapTapUntil = Date.now() + 30000; // 移動モード中は地図の長押し/タップ（新規登録）を抑止
            clearTimeout(singleTapTimer);             // 既に予約された戸建て登録タイマーを消す
            showToast('指で動かして移動 → 離して確定', false);
            document.addEventListener('pointermove', onPM, { passive: false });
            document.addEventListener('pointerup', finishMove);
            document.addEventListener('pointercancel', finishMove);
        };
        const startPress = (e) => {
            if (e.pointerType === 'touch' && activeTouchPoints >= 2) return; // 既に複数指＝ピンチ操作 → 移動の長押しを始めない
            sx = e.clientX; sy = e.clientY; clearTimeout(pressTimer); pressTimer = setTimeout(enter, 500);
        };
        const cancelPress = () => clearTimeout(pressTimer);
        const moveCancel = (e) => { if (!moving && (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10)) clearTimeout(pressTimer); };
        el.addEventListener('pointerdown', startPress);
        el.addEventListener('pointerup', cancelPress);
        el.addEventListener('pointermove', moveCancel);
        el.addEventListener('pointercancel', cancelPress);
        el.addEventListener('pointerleave', cancelPress);
        el.addEventListener('contextmenu', (e) => e.preventDefault()); // 長押し時のコールアウト（選択メニュー）を抑止
    }

    map.on('load', () => { /* データ取得はサインイン成功後（handleCredential）に行う */ });

    // 他アプリ等から戻った時に地図が消えている対策。
    // ① まずサイズ再計算＋再描画（軽い処理）で復帰を試みる。
    // ② WebGL（地図描画）コンテキストがOSに破棄されたまま復元されない場合は、ページを再読込して作り直す。
    //    表示位置・サインイン・選択中の住所(?area=)は保存済みなので、再読込後も同じ状態に自動で戻る。
    let glLost = false;
    map.on('webglcontextlost', () => { glLost = true; });
    map.on('webglcontextrestored', () => { glLost = false; });
    function recoverMap() {
        try {
            map.resize(); map.triggerRepaint();
            ensureGeolocateOn(); // 他アプリから戻った時など、許可済みなら現在地追従を再ON（OFFになっていた場合）
            if (glLost) setTimeout(() => {
                if (glLost && document.visibilityState === 'visible') reloadApp(); // キャッシュバスト付き再読込に統一（reloadApp は location.reload へフォールバック）
            }, 1200); // 復元イベントを少し待ち、戻らなければ再読込
        } catch (e) {}
    }
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') recoverMap(); });
    window.addEventListener('pageshow', recoverMap);
    window.addEventListener('focus', recoverMap);

    // 入力フォームや詳細ポップアップが開いていれば閉じる。閉じたものがあれば true を返す。
    function closeOpenForms() {
        let closed = false;
        const infoCopy = document.getElementById('info-copy-modal');
        if (infoCopy && infoCopy.style.display === 'flex') { closeInfoCopy(); return true; } // 最前面の情報コピーを先に閉じる
        const appModal = document.getElementById('app-modal');
        if (appModal && appModal.style.display === 'flex') { closeAppModal(); return true; } // 管理モーダル（割り当て/貸出/ユーザー/メンテ/進捗）も Esc・背景タップで閉じる
        const areaModal = document.getElementById('area-modal');
        if (areaModal && areaModal.style.display === 'flex') { closeAreaNav(); return true; } // 住所検索モーダルも Esc で閉じる（背景タップは従来から可）
        const iconFilterModal = document.getElementById('icon-filter-modal');
        if (iconFilterModal && iconFilterModal.style.display === 'flex') { closeIconFilter(); return true; } // アイコンフィルタも Esc・背景タップで閉じる
        if (activeNewMarker) { activeNewMarker.remove(); activeNewMarker = null; closed = true; }
        currentMarkers.forEach(m => {
            const p = m.getPopup();
            if (p && p.isOpen()) { resetRoomActionPanel(p); m.togglePopup(); closed = true; }
        });
        // メニューが開いていれば閉じる（範囲外タップでの登録の誤発火を防ぐ）
        const menuP = document.getElementById('menu-panel');
        if (menuP && menuP.classList.contains('show')) { menuP.classList.remove('show'); closed = true; }
        return closed;
    }

    // タップ判定用の状態（ピンチ/パン中の誤登録を防ぐ）
    let tapSuppressed = false;
    let touchStartPt = null;

    // ① 通常タップ/左クリック時 -> 何か開いていればキャンセル、無ければ戸建ての新規登録
    //   ダブルタップ（ズーム）対策：
    //   ・前回タップから DOUBLE_TAP_MS 以内の2回目タップは「ダブルタップ」とみなし、登録を発火させない。
    //   ・1回目タップも DOUBLE_TAP_MS 待ってから登録を開く（その間に2回目が来たらキャンセル）。
    let singleTapTimer = null;
    let lastTapTime = 0;
    let lastTouchStartTime = 0;   // 直近のタッチ開始時刻（ダブルタップ判定用）
    let doubleTapZoomUntil = 0;   // この時刻まではダブルタップ由来の click を無視する
    const DOUBLE_TAP_MS = 300;
    map.on('click', (e) => {
        // ピンチ・パン由来のクリックは無視する
        if (tapSuppressed) { tapSuppressed = false; return; }
        // 住所モーダルを閉じた直後の誤タップ（地図への貫通）は無視する
        if (Date.now() < suppressMapTapUntil) { clearTimeout(singleTapTimer); return; }
        // スマホのダブルタップ（ズーム）中に合成される click は登録に使わない
        if (Date.now() < doubleTapZoomUntil) { clearTimeout(singleTapTimer); return; }
        // 地図の背景（canvas）の場合のみ反応
        const onCanvas = e.originalEvent && e.originalEvent.target &&
            typeof e.originalEvent.target.className === 'string' &&
            e.originalEvent.target.className.includes('mapboxgl-canvas');
        if (!onCanvas) return;
        if (closeOpenForms()) { lastTapTime = 0; return; } // 開いていれば閉じるだけ
        const now = Date.now();
        // 直前タップとの間隔が短い＝ダブルタップ。登録をキャンセルしてズームに任せる。
        if (now - lastTapTime < DOUBLE_TAP_MS) {
            clearTimeout(singleTapTimer);
            lastTapTime = 0;
            return;
        }
        lastTapTime = now;
        const lngLat = e.lngLat;
        clearTimeout(singleTapTimer);
        singleTapTimer = setTimeout(() => { handleMapClickOrTap(lngLat, '戸建て'); }, DOUBLE_TAP_MS);
    });
    // ダブルタップ（ズーム）時は新規登録を発火させない
    map.on('dblclick', () => { clearTimeout(singleTapTimer); lastTapTime = 0; });

    // ② 長押し/右クリック時 -> 何か開いていればキャンセル、無ければ集合住宅の新規登録
    map.on('contextmenu', (e) => {
        if (Date.now() < suppressMapTapUntil) return;
        if (closeOpenForms()) return;
        handleMapClickOrTap(e.lngLat, '集合住宅');
    });

    // タッチ: 複数指（ピンチ）や指の移動（パン）のときは登録しない
    map.on('touchstart', (e) => {
        if (Date.now() < suppressMapTapUntil) return; // モーダルを閉じた直後の貫通タッチは無視
        const touches = e.originalEvent.touches;
        if (touches && touches.length > 1) {
            tapSuppressed = true;            // ピンチ等のマルチタッチ
            clearTimeout(window.longPressTimer);
            return;
        }
        tapSuppressed = false;
        touchStartPt = e.point;
        // ダブルタップ検出：前回のタッチ開始から350ms以内の2回目タップなら、
        // 保留中の新規登録をキャンセルし、以後600msのclick登録を抑止（＝ズームに専念）。
        const tnow = Date.now();
        if (tnow - lastTouchStartTime < 350) {
            doubleTapZoomUntil = tnow + 600;
            clearTimeout(singleTapTimer);
        }
        lastTouchStartTime = tnow;
        // 長押しで集合住宅登録
        window.longPressTimer = setTimeout(() => {
            if (tapSuppressed) return;
            if (Date.now() < suppressMapTapUntil) return; // 住所モーダルを閉じた直後は登録しない
            if (closeOpenForms()) return;
            handleMapClickOrTap(map.unproject([e.point.x, e.point.y]), '集合住宅');
        }, 800);
    });
    map.on('touchmove', (e) => {
        if (e.originalEvent.touches && e.originalEvent.touches.length > 1) tapSuppressed = true;
        if (touchStartPt) {
            const dx = e.point.x - touchStartPt.x;
            const dy = e.point.y - touchStartPt.y;
            if (Math.hypot(dx, dy) > 12) { tapSuppressed = true; clearTimeout(window.longPressTimer); }
        }
    });
    map.on('touchend', () => { clearTimeout(window.longPressTimer); });

    // PC: Escape キーで入力フォーム／ポップアップをキャンセル
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeOpenForms();
    });

    // 吹き出し・住所モーダル上でのピンチ（2本指）による画面ズームを抑止する。
    // ※ iOS Safari は viewport の user-scalable=no を無視するため、ジェスチャを直接 preventDefault する。
    //    地図(canvas)上のピンチは対象外なので、地図のズームは従来どおり効く。
    // 地図(#map)以外＝吹き出し・メニュー・各モーダル/ダイアログ全部では、ピンチによる「ページ全体の拡大」を抑止する。
    // （地図上のピンチズームは Mapbox が canvas で処理するので対象外。吹き出しは #map 内に出るため明示的に含める）
    // ※ページ拡大されたまま吹き出しを閉じると操作不能になる事故を防ぐ。新しいモーダルも body直下なら自動で対象。
    function isOnPopup(t) { return t && t.closest && (t.closest('.mapboxgl-popup') || !t.closest('#map')); }
    ['gesturestart', 'gesturechange', 'gestureend'].forEach(ev => {
        document.addEventListener(ev, (e) => { if (isOnPopup(e.target)) e.preventDefault(); }, { passive: false });
    });
    document.addEventListener('touchmove', (e) => {
        if (e.touches && e.touches.length > 1 && isOnPopup(e.target)) e.preventDefault();
    }, { passive: false });


    // 新規登録フォーム生成
    function handleMapClickOrTap(lngLat, forcedType) {
        if (activeNewMarker) activeNewMarker.remove();
        gridActiveRooms = [];
        gridRoomMark = {};

        // 座標を100%数値型としてパース
        const latVal = parseFloat(lngLat.lat);
        const lngVal = parseFloat(lngLat.lng);
        // タップ地点から住所を逆算して初期値に（号は下で Mapbox から付加。手動上書きは不可）
        newPinAddress = deriveAddress(lngVal, latVal) || '';
        // 最寄りの「号」(住居番号)を Mapbox から取得して住所に付加（取れなければ番地のみ。手動でも設定可）
        if (newPinAddress) fetchNearestHouseNum(lngVal, latVal).then(go => {
            if (!go || addrGoOf(newPinAddress)) return;       // 取れない／既に号があるなら何もしない
            newPinAddress = addrWithGo(newPinAddress, go);
            const el = document.getElementById('new-addr-text');
            if (el) el.textContent = newPinAddress;
        });
        newPinLng = lngVal; newPinLat = latVal; // 住所タップで赤枠表示するため新規地点の座標を保持

        let formHtml = `<div class="popup-content">`;
        if (forcedType === '戸建て') {
            formHtml += `
                <div class="building-title">📍 戸建てを新規登録</div>
                <input type="hidden" id="new-attribute-k" value="通常">
                ${newAddrRowHtml(attrLineHtml('通常', `pickNewAndSubmit(event, 'new-attribute-k', '%v', ${latVal}, ${lngVal})`, false))}
                <input type="hidden" id="new-status" value="">
                <div style="font-weight:bold; font-size:14px; margin:2px 0 4px;">訪問結果（タップで登録）</div>
                ${resultChoiceHtml('', `pickNewAndSubmit(event, 'new-status', '%v', ${latVal}, ${lngVal})`)}
                <div class="form-group memo-empty"><label>メモ</label><textarea id="new-memo" rows="2"></textarea></div>
                <button class="submit-btn detail-only" id="reg-btn" onclick="submitNewLocation(${latVal}, ${lngVal}, '戸建て')">登録</button>
                <button class="detail-toggle" onclick="togglePopupDetail(this)">▼ 詳細を表示</button>
            `;
        } else {
            formHtml += `
                <div class="building-title">🏢 集合住宅を新規登録</div>
                ${newAddrRowHtml()}
                <div class="form-group"><label>建物名</label><input type="text" id="new-name" placeholder="例：ハイツ小岩" style="background:#FFF9DD;"></div>
                <div class="form-row" style="display:flex; gap:4px;">
                    <div class="form-group" style="flex:1;"><label>階数</label>
                        <select id="new-floors" class="numlist" size="5" onchange="generateSetupGrid()" style="background:#FFF9DD;">${Array.from({length:30},(_,i)=>i+1).map(v=>`<option value="${v}" ${v===2?'selected':''}>${v}F</option>`).join('')}</select>
                    </div>
                    <div class="form-group" style="flex:1;"><label>最大部屋数</label>
                        <select id="new-maxroom" class="numlist" size="5" onchange="generateSetupGrid()" style="background:#FFF9DD;">${Array.from({length:20},(_,i)=>i+1).map(v=>`<option value="${v}" ${v===3?'selected':''}>${String(v).padStart(2,'0')}</option>`).join('')}</select>
                    </div>
                </div>
                <div class="form-group" style="margin:2px 0;">
                    <label style="display:flex; align-items:center; gap:4px; font-weight:normal; font-size:11px;">
                        <input type="checkbox" id="new-hideroom" style="width:auto;" onchange="renderRoomGrid()"> 部屋番号が不明（番号を表示しない）
                    </label>
                </div>
                <label style="font-size:11px; font-weight:bold;">緑=部屋あり（初期は全選択）。無い部屋をタップで外す</label>
                <div id="setup-grid-container" style="max-height:120px; overflow:auto; margin-bottom:8px;"></div>
                <div class="inline-group"><label>オートロック</label>${coloredSelectHtml('new-lock', SHUGA_LOCK_OPTS_, '不明')}</div>
                <div class="inline-group"><label>構成属性</label>${coloredSelectHtml('new-attribute', SHUGA_ATTR_OPTS_, '不明')}</div>
                <div class="inline-group detail-only"><label>管理人</label>${coloredSelectHtml('new-manager', SHUGA_MGR_OPTS_, '不明')}</div>
                <div class="form-group memo-empty"><label>メモ</label><input type="text" id="new-memo"></div>
                <button class="submit-btn" id="reg-btn" onclick="submitNewLocation(${latVal}, ${lngVal}, '集合住宅')">登録</button>
                <div class="detail-only" style="text-align:right; margin-top:6px;"><button type="button" onclick="switchToFacilityForm(${latVal}, ${lngVal})" style="width:34%; padding:8px 0; background:#5B7C99; color:#fff; border:none; border-radius:6px; font-size:13px; font-weight:bold; cursor:pointer;">🏛 施設登録</button></div>
                <button class="detail-toggle" onclick="togglePopupDetail(this)">▼ 詳細を表示</button>
            `;
        }
        formHtml += `</div>`;

        const popup = new mapboxgl.Popup({ offset: 25, closeOnClick: false, maxWidth: 'none', anchor: 'bottom', focusAfterOpen: false }).setHTML(formHtml);
        // 新規フォームの吹き出しも「上端基準」で画面に収める（開いた直後に実高さを測る）
        popup.on('open', () => {
            fitPopupInView(activeNewMarker, 0);
            const el = document.getElementById('new-addr-text');
            if (el && !el._goBound) { el._goBound = true; attachLongPress(el, () => outlineNewAddr(), () => {}); }
        });
        activeNewMarker = new mapboxgl.Marker({ color: forcedType === '戸建て' ? '#E0A93C' : '#C75F56' })
            .setLngLat([lngVal, latVal])
            .setPopup(popup)
            .addTo(map);
        activeNewMarker.togglePopup();

        // 集合住宅はグリッドを後から生成するため、生成後に高さが変わる→再度フィットさせる
        if (forcedType === '集合住宅') {
            setTimeout(generateSetupGrid, 100);
            prefillNearestBuildingName(lngVal, latVal); // 最寄りの建物・施設名を建物名の初期値に（試験的）
        }
    }

    /* ── 建物名の自動入力（試験的）：タップ地点の最寄りPOI名を Mapbox Tilequery API で取得する ──
       地図タイルのPOIデータ（mapbox-streets-v8）を座標で照会し、15m以内で最も近い「名前を持つ」
       地物の名前（日本語優先）を建物名欄へ事前入力する。
       ・取得できない／該当なしの場合は何もしない（従来どおり空欄で手入力）
       ・利用者がすでに入力を始めていたら上書きしない
       ・日本の住宅地ではPOI収録が疎らなため、アパート名は取れないことも多い（精度は実地確認） */
    function prefillNearestBuildingName(lng, lat) {
        const url = 'https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/tilequery/'
            + lng + ',' + lat + '.json?radius=15&limit=10&layers=poi_label&access_token='
            + encodeURIComponent(mapboxgl.accessToken);
        fetch(url).then(r => r.json()).then(d => {
            const el = document.getElementById('new-name');
            if (!el || el.value) return; // フォームが閉じた／入力済みなら何もしない
            let best = null;
            ((d && d.features) || []).forEach(f => {
                const p = f.properties || {};
                const name = p.name_ja || p.name;
                if (!name) return;
                const dist = (p.tilequery && typeof p.tilequery.distance === 'number') ? p.tilequery.distance : Infinity;
                if (!best || dist < best.dist) best = { name: name, dist: dist };
            });
            if (best) el.value = best.name;
        }).catch(() => { /* 取得失敗時は静かに従来どおり（手入力） */ });
    }

    // グリッドの現在の階数・最大部屋番号を取得
    function getGridDims() {
        return {
            floors: parseInt(document.getElementById('new-floors').value),
            maxRoom: parseInt(document.getElementById('new-maxroom').value)
        };
    }

    // 「部屋番号が不明」チェックの状態
    function isHideRoomNum() {
        const cb = document.getElementById('new-hideroom');
        return !!(cb && cb.checked);
    }

    // gridActiveRooms の選択状態に従ってグリッドを描画
    // 部屋番号非表示の集合住宅で、四隅の部屋に方角を表示する（番号が無いと位置の手がかりが無いため）。
    // 上＝最上階／下＝最下階、左＝最小番号／右＝最大番号。各階1部屋(maxRoom=1)は左右の区別が無いのでブランク。
    function cornerLabel(f, r, floors, maxRoom) {
        if (maxRoom <= 1) return ''; // 各階1部屋＝左右の手がかりが無いので方角ラベルを出さない
        const v = (f === floors) ? '上' : (f === 1) ? '下' : '';
        const h = (r === 1) ? '左' : (r === maxRoom) ? '右' : '';
        return (v && h) ? (h + v) : '';
    }

    // 部屋マーク（個人宅/会社）の保存形式 ⇔ {部屋番号:'p'|'c'} 変換。
    // U列文字列: 個人=数字そのまま("305")／会社=先頭C("C305")。旧データ(数字のみ)は全て個人として読める。
    function parseRoomMarks(str) {
        const m = {};
        String(str || '').split(',').forEach(tok => {
            tok = tok.trim();
            if (!tok) return;
            const isCo = (tok[0] === 'C' || tok[0] === 'c');
            const n = parseInt(isCo ? tok.slice(1) : tok);
            if (!isNaN(n)) m[n] = isCo ? 'c' : 'p';
        });
        return m;
    }
    // マップ→U列文字列。validRooms に無い部屋のマークは捨てる（部屋を外したら一緒に消える）。
    function encodeRoomMarks(map, validRooms) {
        return Object.keys(map)
            .map(Number)
            .filter(n => validRooms.includes(n))
            .map(n => (map[n] === 'c' ? 'C' + n : '' + n))
            .join(',');
    }
    // セルに表示するマークラベル（個人宅=🏠／会社=🏢）。マーク無しは空。
    function roomMarkLabel(mark) {
        if (mark === 'p') return '🏠<span style="font-size:10px;">個人</span>';
        if (mark === 'c') return '🏢<span style="font-size:10px;">会社</span>';
        return '';
    }

    function renderRoomGrid() {
        const { floors, maxRoom } = getGridDims();
        const hideNum = isHideRoomNum();
        let html = '<div class="grid-scroll" style="overflow-x:auto;"><table class="grid-table" style="width:auto;"><tbody>';
        for (let f = floors; f >= 1; f--) {
            html += `<tr><td class="grid-floor">${f}F</td>`;
            for (let r = 1; r <= maxRoom; r++) {
                const roomNum = f * 100 + r;
                const active = gridActiveRooms.includes(roomNum);
                let label = hideNum ? cornerLabel(f, r, floors, maxRoom) : String(roomNum);
                if (active && gridRoomMark[roomNum]) label = roomMarkLabel(gridRoomMark[roomNum]); // 個人宅=🏠／会社=🏢
                html += `<td id="setup-rm-${roomNum}" style="min-width:40px; background:${active ? '#5FA97D' : '#fff'}; color:${active ? '#fff' : '#333'}; cursor:pointer;">${label}</td>`;
            }
            html += `</tr>`;
        }
        html += '</tbody></table></div>';
        const container = document.getElementById('setup-grid-container');
        const prevLeft = (container.querySelector('.grid-scroll') || {}).scrollLeft || 0; // 再描画で横スクロールが左端に戻らないよう位置を退避
        container.innerHTML = html;
        const scroller = container.querySelector('.grid-scroll'); if (scroller) scroller.scrollLeft = prevLeft; // 退避した横スクロール位置を復元
        // 部屋マトリックスの縦は「4.5階(4行＋半行)」ぶんを上限にする。続きがある時は半行だけ覗かせ、スクロールできると分かるようにする。
        const firstGridRow = container.querySelector('.grid-table tr');
        if (firstGridRow && firstGridRow.offsetHeight) container.style.maxHeight = Math.round(firstGridRow.offsetHeight * 4.5 + 6) + 'px'; // +6 はテーブルの上マージン分
        // 各セルにタップ（部屋の有無切替）と長押し（マーク循環: 個人宅→会社→無し）を割り当てる
        for (let f = floors; f >= 1; f--) {
            for (let r = 1; r <= maxRoom; r++) {
                const rn = f * 100 + r;
                const cell = document.getElementById(`setup-rm-${rn}`);
                if (cell) attachLongPress(cell, () => toggleSetupRoom(rn), () => cycleRoomMark(rn));
            }
        }
    }

    // 新規登録用: 全室を選択済みにして描画（不要な部屋をタップして外す運用）
    function generateSetupGrid() {
        const { floors, maxRoom } = getGridDims();
        gridActiveRooms = [];
        for (let f = 1; f <= floors; f++) {
            for (let r = 1; r <= maxRoom; r++) gridActiveRooms.push(f * 100 + r);
        }
        renderRoomGrid();
        if (activeNewMarker) fitPopupInView(activeNewMarker, 0); // グリッド生成後の高さで再フィット
    }

    function toggleSetupRoom(roomNum) {
        const el = document.getElementById(`setup-rm-${roomNum}`);
        const idx = gridActiveRooms.indexOf(roomNum);
        if (idx > -1) {
            // 部屋を外す → その部屋のマーク(個人宅/会社)も一緒に解除（アイコンを消すため再描画）
            gridActiveRooms.splice(idx, 1);
            delete gridRoomMark[roomNum];
            renderRoomGrid();
        } else {
            gridActiveRooms.push(roomNum);
            el.style.background = '#5FA97D'; el.style.color = '#fff';
        }
    }

    // 部屋のマスを長押し → マークを循環: 無し→個人宅(🏠)→会社(🏢)→無し。有効な部屋だけが対象。
    function cycleRoomMark(roomNum) {
        if (!gridActiveRooms.includes(roomNum)) return; // 部屋が無い所はマークしない
        const cur = gridRoomMark[roomNum];
        if (!cur) gridRoomMark[roomNum] = 'p';
        else if (cur === 'p') gridRoomMark[roomNum] = 'c';
        else delete gridRoomMark[roomNum];
        renderRoomGrid(); // マークの変化を反映
    }

    // ── 施設（目印になる建物）の新規登録 ── 集合住宅フォームの「施設登録」から切替。住所/建物名/メモは流用、部屋の代わりに種類を選ぶ。
    function switchToFacilityForm(lat, lng) {
        const root = activeNewMarker && activeNewMarker.getPopup() ? activeNewMarker.getPopup().getElement() : null;
        const container = root ? root.querySelector('.popup-content') : null;
        if (!container) return;
        const prevName = (document.getElementById('new-name') || {}).value || ''; // 集合住宅フォームで入力済みなら引き継ぐ
        const prevMemo = (document.getElementById('new-memo') || {}).value || '';
        const picker = FACILITY_TYPES.map(t =>
            `<button type="button" class="fac-type-btn" data-v="${escHtml(t.v)}" onclick="pickFacilityType(this)">${t.icon} ${escHtml(t.v)}</button>`
        ).join('');
        container.innerHTML = `
            <div class="building-title">🏛 施設を新規登録</div>
            ${newAddrRowHtml()}
            <div class="form-group"><label>建物名</label><input type="text" id="new-name" placeholder="例：小岩図書館" style="background:#FFF9DD;"></div>
            <input type="hidden" id="new-fac-type" value="">
            <div style="font-size:12px; font-weight:bold; margin:4px 0;">施設の種類（タップで選択）</div>
            <div class="fac-type-grid">${picker}</div>
            <div class="form-group"><label>メモ</label><input type="text" id="new-memo"></div>
            <button class="submit-btn" id="reg-btn" onclick="submitNewFacility(${lat}, ${lng})">登録</button>
        `;
        if (prevName) document.getElementById('new-name').value = prevName;
        if (prevMemo) document.getElementById('new-memo').value = prevMemo;
        const el = document.getElementById('new-addr-text'); // 住所文字の長押し（番地の赤枠表示）を付け直す
        if (el) attachLongPress(el, () => outlineNewAddr(), () => {});
        prefillNearestBuildingName(lng, lat); // 最寄りPOI名を建物名へ（引数は経度,緯度の順。入力済みなら上書きしない）
        if (activeNewMarker) setTimeout(() => fitPopupInView(activeNewMarker, 0), 30);
    }
    // 施設の種類ボタンのタップ：選択をハイライトし hidden に値をセット
    function pickFacilityType(btn) {
        const grid = btn.closest('.fac-type-grid');
        if (grid) grid.querySelectorAll('.fac-type-btn').forEach(b => b.classList.remove('fac-sel'));
        btn.classList.add('fac-sel');
        const h = document.getElementById('new-fac-type');
        if (h) h.value = btn.dataset.v;
    }
    // 施設の登録（種別='施設'、属性=種類）。addNew をそのまま使う（部屋系は空）。
    function submitNewFacility(lat, lng) {
        const type = document.getElementById('new-fac-type').value;
        if (!type) { appAlert('施設の種類を選んでください'); return; }
        const data = { type: '施設', name: document.getElementById('new-name').value, lat: parseFloat(lat), lng: parseFloat(lng),
            memo: document.getElementById('new-memo').value, attribute: type, address: newPinAddress };
        const btn = document.getElementById('reg-btn');
        btn.disabled = true; btn.innerText = '登録中...';
        showSaving();
        apiCall('addNew', { data: data }).then((latest) => {
            if (activeNewMarker) activeNewMarker.remove();
            activeNewMarker = null;
            showDone('登録しました');
            renderMarkers(latest);
        }).catch((err) => { btn.disabled = false; btn.innerText = '登録'; handleServerError(err); }).finally(hideSaving);
    }

    function submitNewLocation(lat, lng, type) {
        let name = '';
        if (type === '集合住宅') {
            name = document.getElementById('new-name').value;
            if (!name) { appAlert('建物名を入力してください'); return; }
        }

        let data = { type: type, name: name, lat: parseFloat(lat), lng: parseFloat(lng), memo: document.getElementById('new-memo').value, attribute: '不明', address: newPinAddress };

        if (type === '戸建て') {
            const st = document.getElementById('new-status').value;
            data.status = (st === '不在') ? '不在(1回目)' : st; // 選択ボタンの「不在」は初回として保存
            data.attribute = document.getElementById('new-attribute-k').value; // 通常/訪問拒否/外国語/空き家
        } else {
            data.floors = document.getElementById('new-floors').value;
            data.maxRoomNum = document.getElementById('new-maxroom').value;
            data.validRooms = gridActiveRooms.join(',');
            data.totalRooms = gridActiveRooms.length;
            data.manager = document.getElementById('new-manager').value;
            data.attribute = document.getElementById('new-attribute').value;
            data.lock = document.getElementById('new-lock').value;
            data.hideRoomNum = isHideRoomNum();
            data.personalRooms = encodeRoomMarks(gridRoomMark, gridActiveRooms);
        }

        const btn = document.getElementById('reg-btn');
        btn.disabled = true; btn.innerText = '登録中...';
        showSaving(); // 全画面ブロックはやめ保存中バッジに（操作はブロックしない）。ボタン無効化で二重登録は防ぐ。

        apiCall('addNew', { data: data }).then((latestData) => {
            if (activeNewMarker) activeNewMarker.remove();
            activeNewMarker = null;
            showDone('登録しました');
            renderMarkers(latestData);
        }).catch((err) => {
            btn.disabled = false; btn.innerText = '登録';
            // 失敗時は選択ボタンの無効化も解除して再操作できるようにする（pickNewAndSubmit で無効化したぶん）
            const root = activeNewMarker && activeNewMarker.getPopup() ? activeNewMarker.getPopup().getElement() : null;
            if (root) root.querySelectorAll('.choice-btn').forEach(b => { b.disabled = false; b.style.pointerEvents = ''; });
            handleServerError(err);
        }).finally(hideSaving);
    }

    /* ── データキャッシュ（起動の先行表示用） ──
       取得済みデータを localStorage に保存しておき、次回起動時はまずそれで即ピンを描画 →
       裏で最新を取得して静かに差し替える。「読み込み中…」の待ちを起動時から無くす。
       【端末に残す情報を最小化】
        ・履歴・メモ・更新者メールは保存しない（先行表示＝ピン描画には不要。裏の最新取得で揃う）
        ・有効期間は6時間。期限切れ・形式不正は「使わない」だけでなく端末からも物理削除する */
    const DATA_CACHE_MAX_MS = 6 * 60 * 60 * 1000;
    const CACHE_OMIT_FIELDS = ['履歴データ', '特記事項', '最終更新者']; // 漏えい時に痛い機微フィールド
    function saveDataCache(data) {
        try {
            const slim = data.map(item => {
                const o = Object.assign({}, item);
                CACHE_OMIT_FIELDS.forEach(k => { delete o[k]; });
                return o;
            });
            localStorage.setItem(DATA_CACHE_KEY, JSON.stringify({ ts: Date.now(), data: slim }));
        } catch (e) {}
    }
    function loadCachedData() {
        try {
            const raw = localStorage.getItem(DATA_CACHE_KEY);
            if (!raw) return null;
            const c = JSON.parse(raw);
            if (!c || !Array.isArray(c.data) || Date.now() - (c.ts || 0) > DATA_CACHE_MAX_MS) {
                localStorage.removeItem(DATA_CACHE_KEY); // 期限切れは端末から消す
                return null;
            }
            return c.data;
        } catch (e) {
            try { localStorage.removeItem(DATA_CACHE_KEY); } catch (e2) {} // 壊れた保存も消す
            return null;
        }
    }
    function loadDataFromSheet() {
        const openDeepLinkPin = () => {
            // スプレッドシートの行リンク(?pin=行番号)で来た場合は、そのピンの吹き出しを開く（初回のみ）
            if (DEEP_LINK_PIN && !deepLinkPinDone) {
                deepLinkPinDone = true;
                openPinDeepLink(Number(DEEP_LINK_PIN));
            }
        };
        const cached = loadCachedData();
        if (cached) {
            // 先行表示：前回データで即描画し、画面をブロックせず裏で最新化する
            renderMarkers(cached);
            apiCall('getData', {}).then((data) => {
                if (activeNewMarker || document.querySelector('.mapboxgl-popup')) {
                    currentData = data;   // 操作中は差し替えを保留（以後の再描画・更新で反映される）
                    saveDataCache(data);
                } else {
                    renderMarkers(data);  // キャッシュ保存は renderMarkers 内で行う
                }
                openDeepLinkPin(); // 行リンクは最新データで照合してから開く
            }).catch(handleServerError);
            return;
        }
        // 初回（キャッシュなし）：従来どおり取得完了までブロック表示
        showBusy('読み込み中…');
        apiCall('getData', {}).then((data) => {
            renderMarkers(data);
            openDeepLinkPin();
        }).catch(handleServerError).finally(hideBusy);
    }

    /* フロントで起きたエラーをバックエンドの ErrorLog へ「コッソリ」送る（遠隔で原因特定するため）。
       ★この関数自体は絶対にアプリを壊さない・ループしない設計にしている：
        - 通常の apiCall を使わず独自 fetch にする（apiCall失敗→handleServerError→ここ、の循環を断つ）
        - fetch の失敗は握りつぶす（オフライン時も安全。報告失敗を再報告しない）
        - 同一内容の連投と、1セッションの総数を制限してスパム・暴走を防ぐ */
    let _errReportLast = '';
    let _errReportCount = 0;
    function sendErrorToServer(errorType, message, location) {
        try {
            const msg = String(message == null ? '' : message);
            const sig = (errorType || '') + '|' + msg + '|' + (location || '');
            if (sig === _errReportLast) return;      // 直前と同一内容は送らない
            if (_errReportCount >= 30) return;       // 暴走防止の上限
            _errReportLast = sig; _errReportCount++;
            fetch(GAS_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                body: JSON.stringify({
                    action: 'reportError',
                    userEmail: (fbAuth.currentUser && fbAuth.currentUser.email) || '', // 参考情報（reportErrorは未認証でも受理。検証は不要）
                    message: msg.slice(0, 2000),
                    location: String(location || '').slice(0, 500),
                    userAgent: (navigator && navigator.userAgent) || ''
                })
            }).catch(function () { /* オフライン等。報告失敗は無視する（再報告しない） */ });
        } catch (e) { /* 何があってもアプリ本体に影響させない */ }
    }

    // 予期せぬJS例外も自動でサーバーへ可視化（画面クラッシュを遠隔で特定するため）
    window.addEventListener('error', function (ev) {
        try {
            const loc = (ev.filename || '') + ':' + (ev.lineno || '') + ':' + (ev.colno || '');
            sendErrorToServer('JsError', ev.message || 'error', loc);
        } catch (e) {}
    });
    window.addEventListener('unhandledrejection', function (ev) {
        try {
            const r = ev.reason;
            sendErrorToServer('PromiseRejection', (r && r.message) ? r.message : String(r), 'unhandledrejection');
        } catch (e) {}
    });

    // サーバー側エラーを画面に出して原因を分かるようにする
    function handleServerError(err) {
        console.error('サーバーエラー:', err);
        const msg = (err && err.message) ? err.message : String(err);
        sendErrorToServer('CommError', msg, 'handleServerError'); // 誰の端末で起きたかを ErrorLog に集約する
        // 認証エラー（トークン無効・期限切れ・権限なし）はログイン画面へ戻す。
        // サーバーの具体的な理由（権限なしなら対象メール入り）をそのまま表示し、原因を分かるようにする。
        // 判定は GAS の error種別(code=AuthFailed/Forbidden)を優先し、文言一致はフォールバック（文言変更で壊れない）。
        // showLogin() は自動再サインインしないため、ここに来てもループにはならない。
        const code = (err && err.code) || '';
        if (code === 'AuthFailed' || code === 'Forbidden' || msg.indexOf('Access Denied') >= 0 || msg.indexOf('利用権限') >= 0 || msg.indexOf('サインイン') >= 0) {
            showToast(msg, true);
            showLogin();
            return;
        }
        showToast('通信エラー: ' + msg, true);
    }

    function showToast(msg, isError) {
        let el = document.getElementById('app-toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'app-toast';
            el.style.cssText = 'position:absolute; top:60px; left:50%; transform:translateX(-50%); z-index:10008; padding:8px 14px; border-radius:6px; font-size:14px; box-shadow:0 2px 6px rgba(0,0,0,0.3); max-width:90%; text-align:center;'; // トースト=結果通知は最前面（モーダル・busyより上）
            document.body.appendChild(el);
        }
        el.style.background = isError ? '#C75F56' : '#5FA97D';
        el.style.color = '#fff';
        el.textContent = msg;
        el.style.display = 'block';
        clearTimeout(window._toastTimer);
        window._toastTimer = setTimeout(() => { el.style.display = 'none'; }, isError ? 8000 : 2500);
    }

    /* ── 確認ダイアログ（ネイティブ confirm/alert の代替・独自UI） ──
       appConfirm(msg, opts) → Promise<boolean>。OK=true / キャンセル・枠外タップ・Esc=false。
       opts: { okLabel: OKボタン文言, cancelLabel: キャンセル文言, danger: trueでOKを赤（破壊的操作） }
       appAlert(msg) → OKボタンのみの通知。 */
    function appConfirm(msg, opts) {
        opts = opts || {};
        return new Promise(resolve => {
            let ov = document.getElementById('app-confirm-overlay');
            if (!ov) {
                ov = document.createElement('div');
                ov.id = 'app-confirm-overlay';
                ov.innerHTML = '<div id="app-confirm-card"><div id="app-confirm-msg"></div>'
                    + '<div id="app-confirm-btns"><button id="app-confirm-cancel"></button><button id="app-confirm-ok"></button></div></div>';
                document.body.appendChild(ov);
            }
            const okBtn = document.getElementById('app-confirm-ok');
            const cancelBtn = document.getElementById('app-confirm-cancel');
            document.getElementById('app-confirm-msg').textContent = msg;
            okBtn.textContent = opts.okLabel || 'OK';
            okBtn.classList.toggle('danger', !!opts.danger);
            cancelBtn.textContent = opts.cancelLabel || 'キャンセル';
            cancelBtn.style.display = opts.alertMode ? 'none' : '';
            const close = (val) => {
                ov.style.display = 'none';
                document.removeEventListener('keydown', onKey, true);
                resolve(val);
            };
            const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(false); } };
            okBtn.onclick = () => close(true);
            cancelBtn.onclick = () => close(false);
            // 表示直後はタップ由来の合成click(Android Chromeのゴーストクリック)が背景に着弾して即キャンセル閉じになるのを防ぐため、一定時間は背景タップを無視する。
            const openedAt = Date.now();
            ov.onclick = (e) => { if (e.target === ov && Date.now() - openedAt > 400) close(false); }; // 枠外タップ＝キャンセル（表示直後の合成clickは無視）
            document.addEventListener('keydown', onKey, true); // 既存のEsc処理（フォームを閉じる）より先に拾う
            ov.style.display = 'flex';
        });
    }
    function appAlert(msg) {
        return appConfirm(msg, { okLabel: 'OK', alertMode: true });
    }

    /* =========================================================================
     *  メニュー／割り当て区域／管理画面（区域の貸出・返却、ユーザー管理）
     *  データは UserList / AreaList / LendLog（GAS側 getMe ほか）を参照。
     * ========================================================================= */
    let ME = { email: '', name: '', group: '', level: 0 };
    function loadMe() {
        apiCall('getMe', {}).then(me => {
            ME = me || ME;
            const lv = ME.level || 0; // 役割でメニューを出し分け（1=貸出係/2=管理者/3=システム管理者。上位は下位を内包）
            document.body.classList.toggle('role-lend', lv >= 1);
            document.body.classList.toggle('role-manage', lv >= 2);
            document.body.classList.toggle('role-sys', lv >= 3);
            // 番地データ（マスタ＝GASのAREA_DEF）を受け取り、フォールバックを上書きして保持する
            if (me && me.areaDef) {
                AREA_DATA = me.areaDef;
                try { localStorage.setItem('vm_areaDef', JSON.stringify(me.areaDef)); } catch (e) {}
            }
        }).catch(() => { /* 取得失敗でも本体は動かす（メニューが一般表示・番地は内蔵値のまま） */ });
    }
    function toggleMenu() { document.getElementById('menu-panel').classList.toggle('show'); }
    function closeMenu() { document.getElementById('menu-panel').classList.remove('show'); }
    /* ホーム画面アプリ（PWA）はブラウザの更新UIが無く、引っ張って更新も分かりにくい。
       メニューから強制リロードする。URLに v=時刻 を付け直すことでキャッシュされた古い
       index.html の再表示を防ぐ（Ctrl+Shift+R 相当）。?area=/?pin= 等の既存パラメータは保持。 */
    function reloadApp() {
        try {
            const u = new URL(location.href);
            u.searchParams.set('v', Date.now());
            location.replace(u.href);
        } catch (e) {
            location.reload();
        }
    }
    // メニュー外タップで閉じる
    document.addEventListener('click', (e) => {
        const p = document.getElementById('menu-panel');
        const b = document.getElementById('signout-btn');
        if (p.classList.contains('show') && !p.contains(e.target) && e.target !== b) { p.classList.remove('show'); suppressMapTapUntil = Date.now() + 600; }
    });

    function openAppModal(title) {
        document.getElementById('app-modal-title').textContent = title;
        document.getElementById('app-modal-body').innerHTML = '<div style="color:#888; padding:8px;">読み込み中…</div>';
        document.getElementById('app-modal').style.display = 'flex';
        var hfs = document.getElementById('help-fs-header'); if (hfs) hfs.remove(); // ヘルプの文字サイズボタンを他モーダルに残さない
    }
    function closeAppModal() {
        document.getElementById('app-modal').style.display = 'none';
        document.getElementById('lend-preview-back').style.display = 'none';
    }
    // アプリの使い方（左下メニュー）。図解版＝マーカー凡例＋戸建て新規/集合住宅編集の吹き出し図解。
    // 見た目は実アプリのCSS/配色に合わせる。メンテナンス節はシステム管理者(level>=3)のみ表示。文字サイズ(小/大)切替つき。
    function showHelp() {
        openAppModal('❓ アプリの使い方');
        // 文字サイズ切替を共有モーダルのヘッダー（✕の左）に置く＝本文をスクロールしても常に見える
        try {
            const _hd = document.getElementById('app-modal-head'), _x = _hd.querySelector('button');
            const _fs = document.createElement('span'); _fs.id = 'help-fs-header';
            _fs.innerHTML = `<span class="vmh-lab">文字</span><button class="vmh-fsbtn" data-fs="s" onclick="setHelpFontSize('s')">小</button><button class="vmh-fsbtn" data-fs="l" onclick="setHelpFontSize('l')">大</button>`;
            _hd.insertBefore(_fs, _x);
        } catch (e) {}
        const mb = (c, w) => { w = w || 15; return '<svg viewBox="0 0 24 24" width="' + w + '" height="' + w + '" style="fill:' + c + '"><path fill-rule="evenodd" d="M9 1.5 h6 v2.5 h-6 Z M5 4 h14 v17 h-14 Z M7 6 h2.2 v2.2 H7 Z M10.9 6 h2.2 v2.2 h-2.2 Z M14.8 6 h2.2 v2.2 h-2.2 Z M7 9.4 h2.2 v2.2 H7 Z M10.9 9.4 h2.2 v2.2 h-2.2 Z M14.8 9.4 h2.2 v2.2 h-2.2 Z M7 12.8 h2.2 v2.2 H7 Z M10.9 12.8 h2.2 v2.2 h-2.2 Z M14.8 12.8 h2.2 v2.2 h-2.2 Z M7 16.2 h2.2 v2.2 H7 Z M14.8 16.2 h2.2 v2.2 h-2.2 Z M10.7 16.4 h2.6 v4.6 h-2.6 Z"/></svg>'; };
        const isSys = (typeof ME !== 'undefined' && ME && ME.level >= 3);
        let html = `<div id="help-root" class="vmh-root">`;
        // 地図の見方（マーカー凡例）
        html += `<details class="vmh-sec"><summary class="vmh-h">🗺️ 地図の見方（マーカーの意味）</summary><div class="vmh-in">
            <div class="vmh-sub">── 戸建て ──</div>
            <div class="vmh-mk">
              <div class="vmh-i vmh-full"><span class="vmh-chip vmh-ko" style="color:#333;">1</span><span class="vmh-chip vmh-ko" style="color:#4A78B0;">2</span><span class="vmh-chip vmh-ko" style="color:#1B4F72;">3</span>不在回数</div>
              <div class="vmh-i"><span class="vmh-chip vmh-ko" style="color:#DB7C2E;">会</span>会えた</div>
              <div class="vmh-i"><span class="vmh-chip vmh-ko" style="color:#3E8E54;">投</span>投函</div>
              <div class="vmh-i"><span class="vmh-chip vmh-star" style="background:#B0554D;">拒</span>拒否宅</div>
              <div class="vmh-i"><span class="vmh-chip vmh-star" style="background:#8E79AB;">外</span>外国語</div>
              <div class="vmh-i"><span class="vmh-chip vmh-ko" style="color:#8C8C8C;">空</span>空き家</div>
              <div class="vmh-i"><span class="vmh-chip vmh-ko" style="color:#7f8c8d;">他</span>その他</div>
              <div class="vmh-i"><span class="vmh-chip vmh-ko vmh-em">🏢</span>会社・店</div>
              <div class="vmh-i"><span class="vmh-chip vmh-ko" style="color:#6FAEC0;">未</span>未訪問</div>
            </div>
            <div class="vmh-sub">── 集合住宅 ──</div>
            <div class="vmh-shline">
              <span class="vmh-chip vmh-sh" style="background:#F2E394;">${mb('#8a7117')}</span>ファミリー/混在
              <span class="vmh-chip vmh-sh" style="background:#5B8BB0;">${mb('#fff')}</span>シングル
              <span class="vmh-chip vmh-sh" style="background:#8C8C8C;">${mb('#fff')}</span>不明
            </div>
            <div class="vmh-ssnote">※ マークの色 ＝ 建物の構成</div>
        </div></details>`;
        // 戸建ての新規登録
        html += `<details class="vmh-sec" open><summary class="vmh-h">🏠 戸建て</summary><div class="vmh-in">
            <div class="vmh-note"><b>地図をタップ</b> すると吹き出しが出ます</div>
            <div class="vmh-pop">
              <div class="vmh-pttl">📍 戸建てを新規登録</div>
              <div class="vmh-prow">🏠 <span>東小岩2丁目5番3</span> <span class="vmh-attrb">訪問可 ▾</span></div>
              <div class="vmh-plbl">訪問結果（タップで登録）</div>
              <div class="vmh-cg3"><div class="vmh-b" style="background:#CBE3F0;border-color:#9fc4da;color:#0d3c55;">不在</div><div class="vmh-b" style="background:#F2C892;border-color:#ddb070;color:#5b3b00;">会えた</div><div class="vmh-b" style="background:#CBE2CC;border-color:#a8cbaa;color:#2E5E33;">投函</div></div>
            </div>
            <div class="vmh-steps">
              <div class="vmh-s"><span class="vmh-num">1</span><div><div class="vmh-act">訪問結果をタップ <span class="vmh-must">これだけでOK</span></div><div class="vmh-dt"><span class="vmh-mbtn" style="background:#CBE3F0;border-color:#9fc4da;color:#0d3c55;">不在</span><span class="vmh-mbtn" style="background:#F2C892;border-color:#ddb070;color:#5b3b00;">会えた</span> などを押せば完了</div></div></div>
              <div class="vmh-s"><span class="vmh-num">2</span><div><div class="vmh-act">右上の <span class="vmh-mbtn" style="background:#F2E394;border-color:#F2E394;color:#6b5a1e;">訪問可 ▾</span> で状況を変更可能</div><div class="vmh-dt"><span class="vmh-mbtn" style="background:#F2E394;border-color:#F2E394;color:#6b5a1e;">訪問可</span><span class="vmh-mbtn" style="background:#A8554E;border-color:#A8554E;color:#fff;">拒否</span><span class="vmh-mbtn" style="background:#8E79AB;border-color:#8E79AB;color:#fff;">外国語</span><span class="vmh-mbtn" style="background:#8C8C8C;border-color:#8C8C8C;color:#fff;">空き</span><span class="vmh-mbtn" style="background:#7f8c8d;border-color:#7f8c8d;color:#fff;">他</span><span class="vmh-mbtn" style="background:#2E5090;border-color:#2E5090;color:#fff;">会社</span></div></div></div>
            </div>
        </div></details>`;
        // 集合住宅の編集
        html += `<details class="vmh-sec" open><summary class="vmh-h"><span class="vmh-hicon">${mb('#8a7117', 13)}</span>アパート・マンション</summary><div class="vmh-in">
            <div class="vmh-note"><b>四角のマークをタップ</b> すると下の吹き出しが出ます</div>
            <div class="vmh-pop">
              <div class="vmh-pttl">ハイツ小岩</div>
              <div class="vmh-prow" style="margin:-2px 0 4px;">🏠 <span>東小岩2丁目5番</span></div>
              <div class="vmh-psub">管理人: なし ｜ 構成: ファミリー ｜ オートロック: なし</div>
              <table class="vmh-gt"><tbody>
                <tr><td class="vmh-fl">3F</td><td style="background:#E6F1F4;">301</td><td style="background:#F2C892;color:#5b3b00;">302</td><td style="background:#CBE2CC;color:#2E5E33;">303</td></tr>
                <tr><td class="vmh-fl">2F</td><td class="vmh-sel" style="background:#CBE3F0;color:#0d3c55;">201</td><td style="background:#A8554E;color:#fff;">☆</td><td style="background:#E6F1F4;">203</td></tr>
                <tr><td class="vmh-fl">1F</td><td style="background:#A6CFE4;color:#0d3c55;">101</td><td style="background:#E6F1F4;">102</td><td class="vmh-ina"></td></tr>
              </tbody></table>
              <div class="vmh-rarea">🚪 <b>201号室</b> の訪問結果<div class="vmh-cg3 vmh-cg3s" style="margin:5px 0 0;"><div class="vmh-b" style="background:#3D7FA8;border-color:#3D7FA8;color:#fff;">不在</div><div class="vmh-b" style="background:#F2C892;border-color:#ddb070;color:#5b3b00;">会えた</div><div class="vmh-b" style="background:#CBE2CC;border-color:#a8cbaa;color:#2E5E33;">投函</div></div></div>
            </div>
            <div class="vmh-steps">
              <div class="vmh-s"><span class="vmh-num">1</span><div><div class="vmh-act">部屋番号をタップ <span class="vmh-must">これだけでOK</span></div><div class="vmh-dt">部屋番号が選択されたら<br>　<span class="vmh-mbtn" style="background:#CBE3F0;border-color:#9fc4da;color:#0d3c55;">不在</span><span class="vmh-mbtn" style="background:#F2C892;border-color:#ddb070;color:#5b3b00;">会えた</span><span class="vmh-mbtn" style="background:#CBE2CC;border-color:#a8cbaa;color:#2E5E33;">投函</span> を押す</div></div></div>
              <div class="vmh-s"><span class="vmh-num">2</span><div style="width:100%;"><div class="vmh-act">色で状況が分かります</div>
                <div class="vmh-mk" style="margin-top:7px;">
                  <div class="vmh-i vmh-full"><span class="vmh-rcell" style="background:#CBE3F0;color:#0d3c55;">1</span><span class="vmh-rcell" style="background:#A6CFE4;color:#0d3c55;">2</span><span class="vmh-rcell" style="background:#7FB6D6;color:#0d3c55;">3</span>不在回数（濃いほど多い）</div>
                  <div class="vmh-i"><span class="vmh-rcell" style="background:#F2C892;color:#5b3b00;">会</span>会えた</div>
                  <div class="vmh-i"><span class="vmh-rcell" style="background:#CBE2CC;color:#2E5E33;">投</span>投函</div>
                  <div class="vmh-i"><span class="vmh-rcell" style="background:#A8554E;color:#fff;">☆</span>拒否</div>
                  <div class="vmh-i"><span class="vmh-rcell" style="background:#8E79AB;color:#fff;">☆</span>外国語</div>
                </div>
              </div></div>
            </div>
        </div></details>`;
        // アパート・マンションの新規登録（集合住宅）。上の「アパート・マンション」説明と対の図解。
        html += `<details class="vmh-sec"><summary class="vmh-h"><span class="vmh-hicon">${mb('#8a7117', 13)}</span>アパート・マンションの新規登録</summary><div class="vmh-in">
            <div class="vmh-note"><b>地図を長押し</b> すると下の吹き出しが出ます</div>
            <div class="vmh-pop">
              <div class="vmh-pttl">🏢 集合住宅を新規登録</div>
              <div class="vmh-prow" style="margin:-2px 0 4px;">🏠 <span>東小岩2丁目5番</span></div>
              <div class="vmh-psub">建物名: ハイツ小岩 ｜ 階数: 3F ｜ 最大部屋数: 03</div>
              <div class="vmh-plbl" style="font-weight:normal;font-size:12px;color:#555;">緑 ＝ 部屋あり。無い部屋をタップで外す</div>
              <table class="vmh-gt"><tbody>
                <tr><td class="vmh-fl">3F</td><td style="background:#CBE2CC;color:#2E5E33;">301</td><td style="background:#CBE2CC;color:#2E5E33;">302</td><td style="background:#CBE2CC;color:#2E5E33;">303</td></tr>
                <tr><td class="vmh-fl">2F</td><td style="background:#CBE2CC;color:#2E5E33;">201</td><td style="background:#CBE2CC;color:#2E5E33;">202</td><td style="background:#eef0f2;color:#b9c0c6;text-decoration:line-through;">203</td></tr>
                <tr><td class="vmh-fl">1F</td><td style="background:#CBE2CC;color:#2E5E33;">101</td><td style="background:#CBE2CC;color:#2E5E33;">102</td><td style="background:#CBE2CC;color:#2E5E33;">103</td></tr>
              </tbody></table>
              <div class="vmh-dtog" style="background:#5E9DB8;color:#fff;border-color:#5E9DB8;margin-top:8px;">登録</div>
            </div>
            <div class="vmh-steps">
              <div class="vmh-s"><span class="vmh-num">1</span><div><div class="vmh-act">建物名・階数・最大部屋数 を入れる</div></div></div>
              <div class="vmh-s"><span class="vmh-num">2</span><div><div class="vmh-act">無い部屋を <b>タップして外す</b></div></div></div>
              <div class="vmh-s"><span class="vmh-num">3</span><div><div class="vmh-act"><span class="vmh-mbtn" style="background:#5E9DB8;border-color:#5E9DB8;color:#fff;">登録</span> を押して完了</div></div></div>
            </div>
        </div></details>`;
        // 応用操作（長押し移動・履歴削除・情報コピー・部屋マーク）。各機能の実挙動に合わせた図解。
        html += `<details class="vmh-sec"><summary class="vmh-h">💡 応用操作</summary><div class="vmh-in">
            <div class="vmh-note">少し慣れてきた人向けの便利ワザです。<b>無理に使わなくても大丈夫</b>。</div>
            <div class="vmh-sub">📍 ピンを動かす（場所の修正）</div>
            <div class="vmh-steps" style="margin-bottom:12px;">
              <div class="vmh-s"><span class="vmh-num">1</span><div><div class="vmh-act">ピンを <b>長押し</b> すると金色に光ります</div><div class="vmh-dt">そのまま指で正しい場所へ動かす</div></div></div>
              <div class="vmh-s"><span class="vmh-num">2</span><div><div class="vmh-act">指を離す → <span class="vmh-mbtn" style="background:#5E9DB8;border-color:#5E9DB8;color:#fff;">移動する</span> を押して確定</div><div class="vmh-dt">他のピンと同じ場所へは移動できません</div></div></div>
            </div>
            <div class="vmh-sub">🕘 訪問の記録（履歴）を見る・消す</div>
            <div class="vmh-steps" style="margin-bottom:12px;">
              <div class="vmh-s"><span class="vmh-num">1</span><div><div class="vmh-act">吹き出しの <span class="vmh-mbtn" style="background:#eef2f4;border-color:#dfe4e8;color:#555;">詳細を表示</span> で記録が出ます</div><div class="vmh-dt">いつ・誰が・どの結果を入れたか</div></div></div>
              <div class="vmh-s"><span class="vmh-num">2</span><div><div class="vmh-act">記録を <b>長押し</b> すると <span class="vmh-mbtn" style="background:#A8554E;border-color:#A8554E;color:#fff;">削除</span> が出ます</div><div class="vmh-dt">間違えて登録した1件だけを消せます</div></div></div>
            </div>
            <div class="vmh-sub">📋 住所や記録をコピー</div>
            <div class="vmh-steps" style="margin-bottom:12px;">
              <div class="vmh-s"><span class="vmh-num">1</span><div><div class="vmh-act">吹き出しの題名（<b>戸建て</b>／建物名）を <b>長押し</b></div><div class="vmh-dt">集合住宅は部屋のマスを長押しでもOK</div></div></div>
              <div class="vmh-s"><span class="vmh-num">2</span><div><div class="vmh-act">住所・属性・履歴がまとまって出る → <span class="vmh-mbtn" style="background:#5E9DB8;border-color:#5E9DB8;color:#fff;">コピー</span></div><div class="vmh-dt">LINE やメモ帳に貼り付けられます</div></div></div>
            </div>
            <div class="vmh-sub">🏠 部屋に「個人宅／会社」の目印</div>
            <div class="vmh-note" style="margin-bottom:8px;">集合住宅の<b>登録・編集中</b>に、部屋のマスを <b>長押し</b> するたびに目印が変わります</div>
            <div class="vmh-steps">
              <div class="vmh-s"><span class="vmh-num">1</span><div><div class="vmh-act">無し → <span class="vmh-mbtn" style="background:#CBE2CC;border-color:#a8cbaa;color:#2E5E33;">🏠 個人宅</span> → <span class="vmh-mbtn" style="background:#CBE3F0;border-color:#9fc4da;color:#0d3c55;">🏢 会社</span> → 無し の順で切替</div><div class="vmh-dt">付けた目印は地図のマスにも表示されます</div></div></div>
            </div>
        </div></details>`;
        // 区域の貸出方法。一般ユーザー向け（自分の区域・全体利用）は全員、貸出係向け（貸出・返却・進捗）は isLend で出し分け。
        const isLend = (typeof ME !== 'undefined' && ME && ME.level >= 1);
        html += `<details class="vmh-sec"><summary class="vmh-h">🗂 区域の貸出方法</summary><div class="vmh-in">
            <div class="vmh-note">「区域」は <b>○○丁目○番</b> のまとまり。担当を決めて貸し借りします。左下メニューの各項目から操作します。</div>
            <div class="vmh-sub">📋 自分の区域（自分が借りている区域）</div>
            <div class="vmh-steps" style="margin-bottom:12px;">
              <div class="vmh-s"><span class="vmh-num">1</span><div><div class="vmh-act">左下メニュー → <span class="vmh-mbtn" style="background:#eef2f4;border-color:#dfe4e8;color:#555;">📋 自分の区域</span></div><div class="vmh-dt">今あなた（と所属グループ）に貸し出されている区域が一覧で出ます</div></div></div>
              <div class="vmh-s"><span class="vmh-num">2</span><div><div class="vmh-act">各区域の <span class="vmh-mbtn" style="background:#5E9DB8;border-color:#5E9DB8;color:#fff;">地図を表示</span> で場所を確認</div><div class="vmh-dt">返却期日が近い／過ぎていると色（黄・赤）で分かります</div></div></div>
              <div class="vmh-s"><span class="vmh-num">3</span><div><div class="vmh-act">終わったら <span class="vmh-mbtn" style="background:#A8554E;border-color:#A8554E;color:#fff;">区域を返却</span></div><div class="vmh-dt">自分が借りた区域は自分で返せます</div></div></div>
            </div>
            <div class="vmh-sub">👪 全体利用の区域（みんなで使う区域）</div>
            <div class="vmh-steps"${isLend ? ' style="margin-bottom:12px;"' : ''}>
              <div class="vmh-s"><span class="vmh-num">1</span><div><div class="vmh-act">左下メニュー → <span class="vmh-mbtn" style="background:#eef2f4;border-color:#dfe4e8;color:#555;">👪 全体利用の区域</span></div><div class="vmh-dt">特定の人ではなく、全員で共同利用する区域です</div></div></div>
              <div class="vmh-s"><span class="vmh-num">2</span><div><div class="vmh-act">地区の地図 か <span class="vmh-mbtn" style="background:#eef2f4;border-color:#dfe4e8;color:#555;">☰ 一覧</span> で見られます</div><div class="vmh-dt">地区をタップすると、その地区の区域が出ます</div></div></div>
            </div>`;
        if (isLend) {
            html += `
            <div class="vmh-sub">🗂 区域を貸し出す・返す　<span style="font-weight:normal;font-size:11px;color:#888;">※貸出係のみ</span></div>
            <div class="vmh-steps" style="margin-bottom:12px;">
              <div class="vmh-s"><span class="vmh-num">1</span><div><div class="vmh-act">左下メニュー → <span class="vmh-mbtn" style="background:#2E5090;border-color:#2E5090;color:#fff;">🗂 区域の貸出・返却</span></div></div></div>
              <div class="vmh-s"><span class="vmh-num">2</span><div><div class="vmh-act"><b>借りる人</b> を選ぶ（グループ → ユーザー）</div><div class="vmh-dt">「全体利用（全員で共同利用）」も選べます</div></div></div>
              <div class="vmh-s"><span class="vmh-num">3</span><div><div class="vmh-act"><b>区域</b> を選ぶ（地区 → 丁目 → 範囲）</div><div class="vmh-dt">番地ごとに件数・状態・地図プレビューが出ます</div></div></div>
              <div class="vmh-s"><span class="vmh-num">4</span><div><div class="vmh-act">返却期日を入れて <span class="vmh-mbtn" style="background:#5E9DB8;border-color:#5E9DB8;color:#fff;">貸出</span></div><div class="vmh-dt">他人・グループ・全体利用の区域の返却もこの画面から</div></div></div>
            </div>
            <div class="vmh-sub">📈 進捗モニタリング　<span style="font-weight:normal;font-size:11px;color:#888;">※貸出係のみ</span></div>
            <div class="vmh-steps">
              <div class="vmh-s"><span class="vmh-num">1</span><div><div class="vmh-act">左下メニュー → <span class="vmh-mbtn" style="background:#2E5090;border-color:#2E5090;color:#fff;">📈 進捗モニタリング</span></div><div class="vmh-dt">地区→丁目ごとに訪問の進み具合をバーで表示</div></div></div>
              <div class="vmh-s"><span class="vmh-num">2</span><div><div class="vmh-act">合算／戸建て／部屋／ピン で集計を切替</div><div class="vmh-dt">「進捗が低い順」「件数が多い順」で並べ替えできます</div></div></div>
            </div>`;
        }
        html += `</div></details>`;
        if (isSys) {
            html += `<details class="vmh-sec"><summary class="vmh-h">⚙️ メンテナンス　<span style="font-weight:normal;font-size:11px;color:#888;">※システム管理者のみ</span></summary><div class="vmh-in"><div class="vmh-soon">Coming soon ✨<small>期間を指定した履歴・ステータスの一括リセット</small></div></div></details>`;
        }
        html += `</div>`;
        document.getElementById('app-modal-body').innerHTML = html;
        let fs = 's'; try { fs = localStorage.getItem('vm_helpFont') || 's'; } catch (e) {}
        setHelpFontSize(fs);
    }
    // ヘルプの文字サイズ切替（小=通常 / 大=拡大＋全文Bold）。端末に記憶。
    function setHelpFontSize(sz) {
        try { localStorage.setItem('vm_helpFont', sz); } catch (e) {}
        const root = document.getElementById('help-root');
        if (root) { root.classList.toggle('vmh-large', sz === 'l'); } // 大=文字拡大＋太字（幅は変えないので吹き出しがはみ出さない）
        document.querySelectorAll('.vmh-fsbtn').forEach(b => b.classList.toggle('on', b.getAttribute('data-fs') === sz));
    }
    // 返却期日の警告クラス。超過=赤(due-over)、2週間以内=アンバー(due-soon)、それ以外は無印
    function dueClass(d) {
        if (!d) return '';
        const t = new Date(String(d).replace(/-/g, '/'));
        if (isNaN(t)) return '';
        const now = new Date(); now.setHours(0, 0, 0, 0);
        if (t < now) return 'due-over';
        if ((t - now) / 86400000 <= 14) return 'due-soon';
        return '';
    }
    // 区域ラベルを地図に表示（「○○N丁目M番」は赤枠つき、丁目なし地区は移動のみ）
    function showAssignedArea(area) {
        const m = String(area).match(/^(.+?)(\d+)丁目(\d+)番$/);
        if (m) geocodeAndFly(ADDR_PREFIX + m[1] + m[2] + '-' + m[3], 18, true, area);
        else geocodeAndFly(ADDR_PREFIX + area, 16, false, area);
    }

    // ── 割り当て区域（自分に貸出中の一覧。タップでその区域を表示） ──
    // 管理: メンテナンス（指定期間の訪問結果・履歴をクリア。属性・住所・個人宅・建物情報は保持）
    function showMaintenance() {
        openAppModal('🧹 メンテナンス');
        const body = document.getElementById('app-modal-body');
        const pad = n => String(n).padStart(2, '0');
        const td = new Date(), ps = new Date(); ps.setMonth(ps.getMonth() - 6);
        const toVal = `${td.getFullYear()}-${pad(td.getMonth() + 1)}-${pad(td.getDate())}`;
        const fromVal = `${ps.getFullYear()}-${pad(ps.getMonth() + 1)}-${pad(ps.getDate())}`;
        body.innerHTML =
            `<div style="font-size:13px; color:#555; margin-bottom:10px;">指定した期間の<b>訪問結果(不在/会えた/投函)と履歴</b>を消去します。<br>属性(拒否/外国語/空き家)・住所・個人宅・建物情報は<b>消えません</b>。</div>`
            + `<div style="display:flex; gap:6px; align-items:center; margin-bottom:6px;"><label style="width:48px; font-size:13px; font-weight:bold;">開始</label><input type="date" id="mnt-from" value="${fromVal}" style="flex:1; min-width:0;"></div>`
            + `<div style="display:flex; gap:6px; align-items:center; margin-bottom:14px;"><label style="width:48px; font-size:13px; font-weight:bold;">終了</label><input type="date" id="mnt-to" value="${toVal}" style="flex:1; min-width:0;"></div>`
            + `<button class="clear-btn" style="width:100%; margin-bottom:8px;" onclick="runMaintenance('history')">🗑 この期間の履歴をクリア</button>`
            + `<button class="clear-btn" style="width:100%; background:#8a6d3b;" onclick="runMaintenance('status')">🔄 この期間の訪問ステータスをクリア</button>`;
    }
    function runMaintenance(kind) {
        const from = (document.getElementById('mnt-from') || {}).value || '';
        const to = (document.getElementById('mnt-to') || {}).value || '';
        if (!from || !to) { appAlert('開始日と終了日を指定してください'); return; }
        if (from > to) { appAlert('開始日が終了日より後になっています'); return; }
        const label = (kind === 'history') ? '履歴' : '訪問ステータス';
        appConfirm(`${from} 〜 ${to}\nこの期間の${label}をクリアします。\n（属性・住所・個人宅・建物情報は消えません）`, { danger: true, okLabel: '次へ' }).then(ok => {
            if (!ok) return;
            appConfirm('この操作は元に戻せません。本当に実行しますか？', { danger: true, okLabel: '実行する' }).then(ok2 => {
                if (!ok2) return;
                showBusy('クリア中…');
                const action = (kind === 'history') ? 'clearHistoryRange' : 'clearStatusRange';
                apiCall(action, { from: from.replace(/-/g, '/'), to: to.replace(/-/g, '/') })
                    .then(res => {
                        renderMarkers(res.data);
                        closeAppModal();
                        const n = (kind === 'history') ? res.removed : res.cleared;
                        showToast(`${label}を ${n} 件クリアしました`, false);
                    })
                    .catch(handleServerError).finally(hideBusy);
            });
        });
    }

    // ── 管理: 進捗モニタリング（丁目単位。currentData から その場集計＝常に最新。シートには書かない） ──
    let progState = { mode: 'pin', sort: 'rate', open: {}, areas: [] }; // mode: all/kodate/room/pin（当面は'pin'を既定＝ピンが揃ったら'all'等へ戻す予定）、sort: rate(低い順)/count(多い順)。areas=件数(AreaList)
    // 訪問結果（不在/会えた/投函）か＝訪問済み。属性(拒否/外国語/空き家/他/未訪問)は未訪問扱い。
    function isVisitResult_(s) { s = String(s || ''); return s.indexOf('不在') >= 0 || s.indexOf('会えた') >= 0 || s.indexOf('投函') >= 0; }
    function progTotals_(s, mode) {
        if (mode === 'kodate') return { total: s.kodatePin, done: s.kodateDone };
        if (mode === 'room') return { total: s.room, done: s.roomDone };
        if (mode === 'pin') return { total: s.kensu, done: s.pin }; // ピン基準＝母数:件数(AreaList) / 分子:登録ピン数
        return { total: s.kodatePin + s.room, done: s.kodateDone + s.roomDone }; // 合算＝戸建てピン＋集合の部屋（棟は数えない）
    }
    function barColor_(r) { return r < 25 ? '#C75F56' : r < 50 ? '#D98E5A' : r < 70 ? '#E2C36A' : r < 85 ? '#9BC27E' : '#5E9DB8'; }
    function fmtPct_(done, total) { return total ? Math.round(done / total * 1000) / 10 : 0; }
    function fmtNum_(n) { return (n == null || n === '') ? n : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); } // 1234 → 1,234
    function progBar_(r) { return `<div class="prog-bar"><span style="width:${Math.min(100, r)}%; background:${barColor_(r)};"></span></div>`; }
    // currentData を 地区→丁目 に集計する
    function aggregateProgress(areaList) {
        const blank = () => ({ kodatePin: 0, kodateDone: 0, room: 0, roomDone: 0, vacant: 0, refuse: 0, pin: 0, kensu: 0 });
        const tree = {};
        const bucket = (district, chomeKey) => {
            if (!tree[district]) tree[district] = { chomes: {}, total: blank() };
            if (!tree[district].chomes[chomeKey]) tree[district].chomes[chomeKey] = blank();
            return tree[district].chomes[chomeKey];
        };
        (currentData || []).forEach(item => {
            const lng = parseFloat(item.経度), lat = parseFloat(item.緯度);
            if (isNaN(lng) || isNaN(lat) || lng === 0 || lat === 0) return; // 地図描画と同じ条件で不正座標を除外
            if (item.種別 === '施設') return; // 施設は目印で訪問対象でないため進捗集計から除外
            const addr = (item.住所 && item.住所 !== '-' && String(item.住所).trim() !== '') ? addrWithoutGo(item.住所) : (deriveAddress(lng, lat) || '');
            let district = '（住所未設定）', chomeKey = '（住所未設定）';
            const m = String(addr).match(/^(.+?)(\d+丁目)\d+番$/);
            if (m) { district = m[1]; chomeKey = m[1] + m[2]; }
            else if (addr) { district = addr; chomeKey = addr; } // 丁目なし地区（鹿骨町 等）
            const st = bucket(district, chomeKey);
            st.pin += 1; // ピン基準の分子＝登録ピン数（1行=1ピン。戸建ても集合住宅も棟1つで1ピン）
            if (item.種別 === '集合住宅') {
                const validSet = {};
                let rooms = 0;
                String(item.有効部屋リスト || '').split(',').forEach(s => { const k = String(s).trim(); if (k !== '') { validSet[k] = true; rooms++; } });
                let map = {};
                try { map = JSON.parse(item.部屋ステータス || '{}') || {}; } catch (e) { map = {}; }
                let roomsDone = 0;
                Object.keys(map).forEach(k => {
                    if (!validSet[k]) return; // 有効部屋リストにある部屋だけ集計（建物編集で外れた部屋のT列残骸は無視＝率が100%超になるのを防ぐ）
                    const v = String(map[k] || '');
                    if (isVisitResult_(v)) roomsDone++;
                    else if (v.indexOf('空き家') >= 0) st.vacant++;
                    else if (v.indexOf('訪問拒否') >= 0) st.refuse++;
                });
                st.room += rooms; st.roomDone += roomsDone; // 集合は「部屋」を母数にする（棟は数えない＝戸建てピンと二重計上しない）
            } else {
                st.kodatePin += 1;
                const a = String(item.属性 || '');
                const hasAttr = (a === '訪問拒否' || a === '外国語' || a === '空き家' || a === '他' || a === '会社'); // 現在の状態が属性
                if (a === '空き家') st.vacant++;
                else if (a === '訪問拒否') st.refuse++;
                // 現在の状態が属性なら訪問済みに数えない（集合の部屋判定と統一。訪問済み＝会えた/不在/投函）
                if (!hasAttr && isVisitResult_(item.最新ステータス)) st.kodateDone += 1;
            }
        });
        // 「件数」(AreaList) を丁目バケットに合算＝ピン基準の母数。ピンが無い丁目もここで作られ 0% で出る。
        (areaList || []).forEach(a => {
            const cnt = parseInt(a.count); if (isNaN(cnt) || cnt <= 0) return;
            const area = String(a.area || '');
            let district = area, chomeKey = area;
            const mm = area.match(/^(.+?)(\d+丁目)\d+番$/); // ピン側と同じ正規化で丁目キーを一致させる
            if (mm) { district = mm[1]; chomeKey = mm[1] + mm[2]; }
            bucket(district, chomeKey).kensu += cnt;
        });
        Object.keys(tree).forEach(d => {
            const tot = tree[d].total;
            Object.keys(tree[d].chomes).forEach(c => {
                const s = tree[d].chomes[c];
                tot.kodatePin += s.kodatePin; tot.kodateDone += s.kodateDone; tot.room += s.room; tot.roomDone += s.roomDone; tot.vacant += s.vacant; tot.refuse += s.refuse; tot.pin += s.pin; tot.kensu += s.kensu;
            });
        });
        return tree;
    }
    function sortProg_(arr) {
        if (progState.sort === 'rate') arr.sort((a, b) => a.rate - b.rate); // 進捗が低い順（遅れている所が上）
        else arr.sort((a, b) => b.cnt - a.cnt);                              // 件数が多い順
    }
    function setProgMode(m) { progState.mode = m; renderProgress(); }
    function toggleProgSort() { progState.sort = (progState.sort === 'rate') ? 'count' : 'rate'; renderProgress(); }
    function toggleProgDistrict(d) { progState.open[d] = !progState.open[d]; renderProgress(); }
    function expandAllProg() { const tree = progState.tree || aggregateProgress(progState.areas); Object.keys(tree).forEach(d => { progState.open[d] = true; }); renderProgress(); }
    function collapseAllProg() { progState.open = {}; renderProgress(); }
    function showProgress() {
        openAppModal('📈 進捗モニタリング');
        const body = document.getElementById('app-modal-body');
        if (!addrPoints) { body.innerHTML = '<div style="color:#888; padding:8px;">住所データを読み込み中です。少し待ってから開き直してください。</div>'; return; }
        showBusy('読み込み中…');
        // 「ピン」基準の母数に AreaList の件数を使うため getLendData も取得（ピン未取得なら getData も並行）
        const dataP = (!currentData || !currentData.length) ? apiCall('getData', {}) : Promise.resolve(null);
        // getLendData(件数)は失敗しても進捗本体(getData)は出す＝ピンモードの母数が無いだけに留める（巻き添え防止）
        Promise.all([dataP, apiCall('getLendData', {}).catch(() => null)]).then(([d, lend]) => {
            if (d) renderMarkers(d);
            progState.areas = (lend && lend.areas) || [];
            progState.tree = aggregateProgress(progState.areas); // 集計は開いた時に1回だけ（モード/並び/展開のトグルでは再計算しない＝重い deriveAddress を繰り返さない）
            renderProgress();
        }).catch(handleServerError).finally(hideBusy);
    }
    function renderProgress() {
        const body = document.getElementById('app-modal-body');
        const tree = progState.tree || aggregateProgress(progState.areas);
        const mode = progState.mode;
        const doneLabel = (mode === 'pin') ? '登録' : '訪問済'; // ピン基準は「登録(ピン)数 / 件数」
        const ML = { all: '合算', kodate: '戸建て', room: '部屋', pin: 'ピン' };
        const rem_ = (t) => Math.max(0, t.total - t.done); // 残はマイナスにしない（ピン>件数 や 件数未入力 でも0止まり）
        const pctTxt_ = (t) => (mode === 'pin' && t.total === 0) ? '件数未' : (fmtPct_(t.done, t.total) + '%'); // 件数未入力(分母0)は率を出さない
        let g = { total: 0, done: 0 };
        Object.keys(tree).forEach(d => { const t = progTotals_(tree[d].total, mode); g.total += t.total; g.done += t.done; });
        const grate = fmtPct_(g.done, g.total);
        let html = '<div style="display:flex; gap:6px; margin-bottom:8px;">'
            + ['all', 'kodate', 'room', 'pin'].map(mk => `<button class="choice-btn" style="flex:1; ${mode === mk ? 'background:#5E9DB8; border-color:#5E9DB8; color:#fff;' : ''}" onclick="setProgMode('${mk}')">${ML[mk]}</button>`).join('')
            + '</div>';
        html += `<div style="background:#f0f7f9; border:1px solid #cfe3ec; border-radius:8px; padding:10px; margin-bottom:10px;">`
            + `<div style="font-weight:bold; font-size:15px;">全体（${ML[mode]}）</div>`
            + `<div style="font-size:14px; margin:4px 0;">${doneLabel} ${fmtNum_(g.done)} / ${fmtNum_(g.total)}　<b style="color:${barColor_(grate)};">${grate}%</b>　（残 ${fmtNum_(Math.max(0, g.total - g.done))}）</div>`
            + progBar_(grate) + '</div>';
        const visD_ = Object.keys(tree).filter(d => { const t = progTotals_(tree[d].total, mode); return !(t.total === 0 && t.done === 0); });
        const allOpen_ = visD_.length > 0 && visD_.every(d => progState.open[d]); // 表示中の全地区が開いているか（1ボタンで開閉を切替）
        html += `<div style="display:flex; justify-content:space-between; align-items:center; gap:6px; margin-bottom:6px;">`
            + `<button class="save-btn" style="background:${allOpen_ ? '#7f8c8d' : '#5E9DB8'}; padding:3px 8px;" onclick="${allOpen_ ? 'collapseAllProg()' : 'expandAllProg()'}">${allOpen_ ? 'すべて閉じる' : 'すべて開く'}</button>`
            + `<button class="save-btn" style="background:#7f8c8d; padding:3px 8px;" onclick="toggleProgSort()">並び：${progState.sort === 'rate' ? '進捗が低い順' : '件数が多い順'} ▼</button>`
            + `</div>`;
        const rows = Object.keys(tree).map(d => { const t = progTotals_(tree[d].total, mode); return { d: d, t: t, rate: fmtPct_(t.done, t.total), cnt: t.total }; })
            .filter(row => !(row.t.total === 0 && row.t.done === 0)); // 中身ゼロのバケット（件数のみ・ピン0が他モードに混入する回帰）を除外
        sortProg_(rows);
        rows.forEach(row => {
            const d = row.d, t = row.t, rate = row.rate, opened = !!progState.open[d];
            html += `<div class="lend-row" style="cursor:pointer; ${opened ? '' : 'border-bottom:2px solid #8a949c;'}" onclick="toggleProgDistrict('${escHtml(d)}')">`
                + `<div class="grow"><b>${opened ? '▾' : '▸'} ${escHtml(d)}</b>　<span style="font-size:12px; color:#333;">${fmtNum_(t.done)}/${fmtNum_(t.total)}（残 ${fmtNum_(rem_(t))}）</span>${progBar_(rate)}</div>`
                + `<div style="width:50px; text-align:right; font-weight:bold; color:${barColor_(rate)};">${pctTxt_(t)}</div></div>`;
            if (opened) {
                const crows = Object.keys(tree[d].chomes).map(c => { const ct = progTotals_(tree[d].chomes[c], mode); return { c: c, ct: ct, rate: fmtPct_(ct.done, ct.total), cnt: ct.total, stat: tree[d].chomes[c] }; })
                    .filter(cr => !(cr.ct.total === 0 && cr.ct.done === 0));
                sortProg_(crows);
                crows.forEach((cr, ci) => {
                    const s = cr.stat, extra = (mode !== 'pin' && (s.vacant || s.refuse)) ? `　空${s.vacant}/拒${s.refuse}` : ''; // ピン基準では空き家/拒否(訪問状態)は出さない
                    const lastC = (ci === crows.length - 1) ? 'border-bottom:2px solid #8a949c;' : ''; // 地区の最後の丁目の下に太線（地区の区切り）
                    html += `<div class="lend-row" style="padding-left:16px; background:#e9eef2; ${lastC}"><div class="grow"><span style="font-size:13px;">${escHtml(cr.c)}</span>　<span style="font-size:11px; color:#555;">${fmtNum_(cr.ct.done)}/${fmtNum_(cr.ct.total)}（残 ${fmtNum_(rem_(cr.ct))}）${extra}</span>${progBar_(cr.rate)}</div><div style="width:46px; text-align:right; font-size:13px; color:${barColor_(cr.rate)};">${pctTxt_(cr.ct)}</div></div>`;
                });
            }
        });
        body.innerHTML = html;
    }

    // ── 管理: 印刷用表示（admin・PC/タブレット）。A4横で 左=詳細地図（実地図＋赤枠＋ピン＋集合住宅カード）/ 右=広域地図。白黒・大きめ。
    //    実地図は Mapbox Static Images API のラスター画像（WebGLの生地図は印刷に弱いため）。重ね物は同じWebメルカトル投影で位置合わせ。
    const PRINT_STYLE = 'mapbox/light-v11'; // 暫定: 建物＋号の両方を描ける既製スタイル。印刷専用スタイル(A案)ができたら 'toruo1104/xxxx' に差し替え
    function staticMapUrl_(lng, lat, zoom, w, h) {
        return 'https://api.mapbox.com/styles/v1/' + PRINT_STYLE + '/static/'
            + lng.toFixed(6) + ',' + lat.toFixed(6) + ',' + zoom.toFixed(2) + '/' + w + 'x' + h + '@2x'
            + '?logo=false&attribution=false&access_token=' + encodeURIComponent(mapboxgl.accessToken);
    }
    // 中心・ズーム・画像サイズから 緯度経度→ピクセル の投影を作る（Mapbox Static と同じ Webメルカトル / 512pxタイル）
    function mercProjector_(cLng, cLat, zoom, w, h) {
        const ws = 512 * Math.pow(2, zoom);
        const wx = lng => (lng + 180) / 360 * ws;
        const wy = lat => { const s = Math.sin(lat * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * ws; };
        const cx = wx(cLng), cy = wy(cLat);
        return { x: lng => w / 2 + (wx(lng) - cx), y: lat => h / 2 + (wy(lat) - cy) };
    }
    // bbox[w,s,e,n] を画像内に padding率 f で収めるズーム
    function fitZoom_(w, s, e, n, imgW, imgH, f) {
        const wx = lng => (lng + 180) / 360 * 512;
        const wy = lat => { const si = Math.sin(lat * Math.PI / 180); return (0.5 - Math.log((1 + si) / (1 - si)) / (4 * Math.PI)) * 512; };
        const spanX = Math.max(wx(e) - wx(w), 1e-9), spanY = Math.max(wy(s) - wy(n), 1e-9);
        return Math.max(0, Math.min(19, Math.log2(Math.min(imgW * f / spanX, imgH * f / spanY))));
    }
    // ★（5角星）の頂点列。訪問拒否/外国語のアイコンに使う
    function starPts_(cx, cy, R, r) {
        let p = '';
        for (let i = 0; i < 10; i++) {
            const a = -Math.PI / 2 + i * Math.PI / 5, rad = (i % 2 === 0) ? R : r;
            p += (cx + rad * Math.cos(a)).toFixed(1) + ',' + (cy + rad * Math.sin(a)).toFixed(1) + ' ';
        }
        return p.trim();
    }

    function showPrintView() {
        if (!currentBoxFeature || !currentBoxFeature.geometry || !currentBoxFeature.geometry.coordinates) {
            // 区域(赤枠)が未選択のときは、住所選択を開いて印刷する番地を選ばせ、その赤枠を出してから印刷用表示を開く
            openAreaNav(function (addr) {
                const m = String(addr).match(/^(.+?)(\d+)丁目(\d+)番$/);
                const query = m ? (ADDR_PREFIX + m[1] + m[2] + '-' + m[3]) : (ADDR_PREFIX + addr);
                geocodeAndFly(query, 18, true, addr, function () { showPrintView(); });
            });
            return;
        }
        const ring = currentBoxFeature.geometry.coordinates[0];
        if (!ring || ring.length < 3) { appAlert('赤枠の形が取得できませんでした。'); return; }

        const pins = (currentData || []).filter(d => {
            const lng = parseFloat(d.経度), lat = parseFloat(d.緯度);
            return !isNaN(lng) && !isNaN(lat) && lng !== 0 && lat !== 0 && pointInRing(lng, lat, ring);
        });
        const kodate = pins.filter(d => d.種別 === '戸建て'); // 施設は印刷に出さない（目印は今は対象外）
        const shuga = pins.filter(d => d.種別 === '集合住宅');

        // bbox[w,s,e,n]（枠＋ピンを内包）と中心
        let w = Infinity, e = -Infinity, s = Infinity, n = -Infinity;
        const ext = (x, y) => { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); };
        ring.forEach(p => ext(p[0], p[1]));
        pins.forEach(d => ext(+d.経度, +d.緯度));
        const cLng = (w + e) / 2, cLat = (s + n) / 2;
        // 枠が縦長（高さ/幅 > 1.6）なら印刷を縦向きに。横長・正方形は横向き。
        const spanXm = (e - w) * Math.cos(cLat * Math.PI / 180), spanYm = (n - s);
        const portrait = (spanYm / Math.max(spanXm, 1e-9)) > 1.6;

        // 詳細地図（全幅）。集合住宅カードの幅だけ左右に余白を確保し、その「中央領域」に枠をギリギリまで大きく収める。
        // カードは必ず余白帯（枠の左右外側）に置く＝赤枠とカードは重ならない。向きに合わせて紙サイズを切替。
        const DW = portrait ? 730 : 1050, DH = portrait ? 1000 : 670, gap = 12, topPad = 8; // 紙の余白内で少し拡大
        const cardW = d => Math.min(parseInt(d.最大部屋番号 || 1), 6) * 40 + 46;
        const cardH = d => Math.min(parseInt(d.階数 || 1), 8) * 36 + 40;
        const sideOf = d => (+d.経度 < cLng) ? 'L' : 'R';
        const maxCardW = side => { const a = shuga.filter(d => sideOf(d) === side).map(cardW); return a.length ? Math.max.apply(null, a) : 0; };
        const leftM = maxCardW('L') ? maxCardW('L') + gap : 8, rightM = maxCardW('R') ? maxCardW('R') + gap : 8;
        const cw = Math.max(DW - leftM - rightM, 140), chh = DH - 2 * topPad;
        const dZoom = fitZoom_(w, s, e, n, cw, chh, 1.0);   // 中央領域いっぱい（100%）まで枠を拡大
        const wsD = 512 * Math.pow(2, dZoom);
        // 枠中心を 画像ピクセル(leftM + cw/2, DH/2) に合わせる → 地図中心を左右にずらす
        const mapLng = cLng - ((leftM + cw / 2) - DW / 2) * 360 / wsD;
        const dProj = mercProjector_(mapLng, cLat, dZoom, DW, DH);
        const dUrl = staticMapUrl_(mapLng, cLat, dZoom, DW, DH);

        // 赤枠（黒・塗りなし）＋ピン＋引き出し線。記号は「拒/外」だけ表示（それ以外は ○/番号 のみ）。
        let ovD = `<svg class="ov" viewBox="0 0 ${DW} ${DH}">`;
        ovD += `<polygon points="${ring.map(p => dProj.x(p[0]).toFixed(1) + ',' + dProj.y(p[1]).toFixed(1)).join(' ')}" fill="none" stroke="#000" stroke-width="2.5"/>`;
        kodate.forEach(d => {
            const kc = kodateVisual(d).char;
            const cx = dProj.x(+d.経度), cy = dProj.y(+d.緯度);
            if (kc === '拒' || kc === '外') { // 訪問拒否/外国語の戸建てだけ ★＋記号で表示
                ovD += `<polygon points="${starPts_(cx, cy, 15, 6)}" fill="#fff" stroke="#000" stroke-width="1.5"/>`
                    + `<text x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" text-anchor="middle" dominant-baseline="central" font-size="11" font-weight="bold" fill="#000">${escHtml(kc)}</text>`;
            } else if (kc === '🏢') { // 会社の戸建て＝アプリの丸形🏢に合わせ ○＋🏢 で表示（「会」だと「会えた」と紛らわしいため）
                ovD += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="12" fill="#fff" stroke="#000" stroke-width="2"/>`
                    + `<text x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" text-anchor="middle" dominant-baseline="central" font-size="14" style="filter:grayscale(1);">🏢</text>`;
            }
            // それ以外（通常の戸建て）は印を出さない
        });
        const nextTop = { L: topPad, R: topPad };
        let cardsHtml = '';
        shuga.forEach((d, i) => {
            const bx = dProj.x(+d.経度), by = dProj.y(+d.緯度), num = i + 1;
            ovD += `<rect x="${(bx - 11).toFixed(1)}" y="${(by - 11).toFixed(1)}" width="22" height="22" rx="3" fill="#fff" stroke="#000" stroke-width="2"/>`
                + `<text x="${bx.toFixed(1)}" y="${by.toFixed(1)}" text-anchor="middle" dominant-baseline="central" font-size="13" font-weight="bold" fill="#000">${num}</text>`;
            const side = sideOf(d), cwid = cardW(d), chgt = cardH(d);
            let top = nextTop[side];
            if (top + chgt > DH - 4) top = Math.max(4, DH - chgt - 4);
            nextTop[side] = top + chgt + 8;
            const lx = side === 'L' ? 4 + cwid : DW - 4 - cwid, ly = top + 14;
            ovD += `<line x1="${bx.toFixed(1)}" y1="${by.toFixed(1)}" x2="${lx.toFixed(1)}" y2="${ly.toFixed(1)}" stroke="#000" stroke-width="1"/>`;
            cardsHtml += `<div class="print-card" style="top:${top}px; ${side === 'L' ? 'left:4px;' : 'right:4px;'}">`
                + `<div class="print-card-h">${num}. ${escHtml(d['建物名 / 世帯名'] || '')}</div>`
                + printRoomGrid(d) + `</div>`;
        });
        ovD += `</svg>`;

        const head = escHtml(currentBoxAddr || '（番地）'); // 見出しは番地のみ（件数・日付は出さない）

        document.getElementById('print-view-body').innerHTML =
            `<div class="print-hide" style="display:flex; justify-content:flex-end; align-items:center; margin-bottom:8px;">`
            + `<button onclick="closePrintView()" style="font-size:16px; padding:7px 16px; border:1px solid #999; border-radius:6px; background:#f4f4f4; cursor:pointer;">✕ 閉じる</button></div>`
            + `<div class="print-head">${head}</div>`
            + `<div class="print-map-wrap" style="width:${DW}px; height:${DH}px;"><img class="basemap" src="${dUrl}" alt="">${ovD}${cardsHtml}</div>`
            + `<div class="print-credit">地図 © Mapbox © OpenStreetMap</div>`;

        // 用紙の向きを枠の縦横比で切替（@page を動的に設定）
        let pps = document.getElementById('print-page-style');
        if (!pps) { pps = document.createElement('style'); pps.id = 'print-page-style'; document.head.appendChild(pps); }
        pps.textContent = `@page { size: A4 ${portrait ? 'portrait' : 'landscape'}; margin: 8mm; }`;

        document.getElementById('print-view').style.display = 'block';
        document.body.classList.add('printing');
        document.addEventListener('keydown', printEscHandler, true);
    }
    function printEscHandler(e) { if (e.key === 'Escape') { e.stopPropagation(); closePrintView(); } }
    function closePrintView() {
        document.getElementById('print-view').style.display = 'none';
        document.body.classList.remove('printing');
        const pps = document.getElementById('print-page-style'); if (pps) pps.textContent = ''; // 用紙向きの指定を解除（通常印刷に影響させない）
        document.removeEventListener('keydown', printEscHandler, true);
    }
    // 集合住宅1棟の部屋グリッド（白黒・印刷用）。個人宅/会社の部屋は番号を消して「個人」「会社」を表示（アプリと同じ）。
    // それ以外は部屋番号＋記号（拒=訪問拒否 / 外=外国語 のみ。会えた/不在/投函等は出さない）。
    function printRoomGrid(item) {
        const floors = parseInt(item.階数 || 1), maxRoom = parseInt(item.最大部屋番号 || 1);
        const valid = String(item.有効部屋リスト || '').split(',').map(Number);
        let map = {}; try { map = JSON.parse(item.部屋ステータス || '{}') || {}; } catch (e) { map = {}; }
        const hideNum = String(item.部屋番号非表示) === '1';
        const marks = parseRoomMarks(item.個人宅); // 個人宅/会社マーク（U列）→ {部屋番号:'p'|'c'}
        let grid = '<table class="print-grid"><tbody>';
        for (let f = floors; f >= 1; f--) {
            grid += `<tr><td class="pf">${f}F</td>`;
            for (let r = 1; r <= maxRoom; r++) {
                const rn = f * 100 + r;
                if (!valid.includes(rn)) { grid += '<td class="pe"></td>'; continue; }
                if (marks[rn]) { // アプリと同じく、個人宅/会社は番号を消して「個人」「会社」を表示
                    grid += `<td class="pc"><div class="pm">${marks[rn] === 'c' ? '会社' : '個人'}</div></td>`;
                    continue;
                }
                const ch = roomVisual(map[rn]).char, mark = (ch === '拒' || ch === '外') ? ch : '';
                const numLabel = hideNum ? cornerLabel(f, r, floors, maxRoom) : String(rn);
                grid += `<td class="pc"><div class="pn">${escHtml(String(numLabel))}</div>${mark ? `<div class="ps">${escHtml(mark)}</div>` : ''}</td>`;
            }
            grid += '</tr>';
        }
        return grid + '</tbody></table>';
    }

    // 区域の返却（確認つき）。権限はサーバで判定（個人=本人 / グループ・全体利用=貸出係以上）。onDone で呼び出し元ビューを再読込。
    function returnAreaConfirm(areaId, label, onDone) {
        appConfirm(`「${label}」を返却します。\nよろしいですか？`, { okLabel: '返却する', danger: true }).then(ok => {
            if (!ok) return;
            showBusy('返却中…');
            apiCall('returnArea', { areaId: areaId })
                .then(() => { showToast('返却しました', false); if (typeof onDone === 'function') onDone(); })
                .catch(handleServerError).finally(hideBusy);
        });
    }
    function showMyAreas() {
        openAppModal('📋 個人・グループの区域');
        showBusy('読み込み中…');
        apiCall('getMyAreas', {}).then(list => {
            const body = document.getElementById('app-modal-body');
            if (!list || !list.length) { body.innerHTML = '<div style="color:#888; padding:8px;">現在割り当てられている区域はありません。</div>'; return; }
            const rowHtml = a => {
                const canReturn = (a.lentTo === 'self') || (ME.level >= 1); // 個人=本人 / グループ=貸出係以上
                return `<div class="lend-row">`
                    + `<div class="grow"><b style="font-size:16px;">${escHtml(a.area)}</b>${a.count !== '' && a.count != null ? `<span style="color:#888; font-size:12px;">（${a.count}件）</span>` : ''}<br>`
                    + `<span style="color:#666; font-size:12px;">貸出: ${escHtml(a.lendDate || '-')} ／ 返却期日: <span class="${dueClass(a.dueDate)}">${escHtml(a.dueDate || '-')}</span></span></div>`
                    + `<div style="display:flex; flex-direction:column; gap:4px; flex-shrink:0;">`
                    + `<button class="choice-btn" style="background:#eef3f6; padding:5px 8px; font-size:12px;" onclick="closeAppModal(); showAssignedArea('${escHtml(a.area)}')">地図を表示</button>`
                    + (canReturn ? `<button class="clear-btn" style="padding:5px 8px; font-size:12px;" onclick="returnAreaConfirm(${a.id}, '${escHtml(a.area)}', showMyAreas)">区域を返却</button>` : '')
                    + `</div></div>`;
            };
            const mine = list.filter(a => a.lentTo !== 'group'); // 自分個人への貸出
            const grp = list.filter(a => a.lentTo === 'group');  // 自分の所属グループへの貸出
            let html = `<div style="font-weight:bold; color:#356B82; padding-bottom:6px; border-bottom:1px solid #b9d6e2; margin-bottom:6px;">👤 個人の区域</div>`;
            html += mine.length ? mine.map(rowHtml).join('') : '<div style="color:#888; padding:8px;">あなた個人への割り当てはありません。</div>';
            if (grp.length) {
                html += `<div style="background:#e6f0f5; border:1px solid #9cc3d4; border-left:5px solid #5E9DB8; border-radius:6px; padding:8px; margin-top:16px;">`;
                html += `<div style="font-weight:bold; padding-bottom:6px; color:#356B82; border-bottom:1px solid #b9d6e2; margin-bottom:4px;">👥 グループの区域（${escHtml(grp[0].group)}）</div>`;
                html += grp.map(rowHtml).join('');
                html += `</div>`;
            }
            body.innerHTML = html;
        }).catch(handleServerError).finally(hideBusy);
    }

    // ── 全体利用（共同利用）の区域：地区ごとに集計し、一覧／地区マップで表示（閲覧は全員可） ──
    let sharedState = { areas: [], district: null, view: localStorage.getItem('vm_sharedView') || 'list' };
    // 区域名（例「東松本1丁目5番」）から地区名を判定（AREA_DATA のキーで最長一致＝「鹿骨町」を「鹿骨」より先に）
    function districtOfArea(area) {
        const keys = Object.keys(AREA_DATA).sort((a, b) => b.length - a.length);
        for (let i = 0; i < keys.length; i++) { if (String(area).indexOf(keys[i]) === 0) return keys[i]; }
        return 'その他';
    }
    function toggleSharedView() {
        sharedState.view = (sharedState.view === 'map') ? 'list' : 'map';
        localStorage.setItem('vm_sharedView', sharedState.view);
        renderSharedAreas();
    }
    function showSharedAreas() {
        openAppModal('👪 全体利用の区域');
        showBusy('読み込み中…');
        apiCall('getSharedAreas', {}).then(list => {
            sharedState.areas = list || [];
            sharedState.district = null;
            renderSharedAreas();
        }).catch(handleServerError).finally(hideBusy);
    }
    function renderSharedAreas() {
        const body = document.getElementById('app-modal-body');
        const areas = sharedState.areas || [];
        if (!areas.length) { body.innerHTML = '<div style="color:#888; padding:8px;">現在、全体利用の区域はありません。</div>'; return; }
        const byDist = {};
        areas.forEach(a => { const d = districtOfArea(a.area); (byDist[d] = byDist[d] || []).push(a); });
        // 地区詳細：その地区の貸出中区域の一覧（タップで地図表示）
        if (sharedState.district) {
            const d = sharedState.district;
            const rows = byDist[d] || [];
            let html = `<button class="choice-btn" style="background:#eef3f6; margin-bottom:8px;" onclick="sharedState.district=null; renderSharedAreas();">← 地区一覧へ戻る</button>`;
            html += `<div style="font-weight:bold; color:#356B82; margin-bottom:6px;">${escHtml(d)}（貸出中 ${rows.length}）</div>`;
            html += rows.map(a => {
                const canReturn = (ME.level >= 1); // 全体利用は貸出係以上のみ返却可
                return `<div class="lend-row">`
                    + `<div class="grow"><b style="font-size:16px;">${escHtml(a.area)}</b>${a.count !== '' && a.count != null ? `<span style="color:#888; font-size:12px;">（${a.count}件）</span>` : ''}<br>`
                    + `<span style="color:#666; font-size:12px;">貸出: ${escHtml(a.lendDate || '-')} ／ 返却期日: <span class="${dueClass(a.dueDate)}">${escHtml(a.dueDate || '-')}</span></span></div>`
                    + `<div style="display:flex; flex-direction:column; gap:4px; flex-shrink:0;">`
                    + `<button class="choice-btn" style="background:#eef3f6; padding:5px 8px; font-size:12px;" onclick="closeAppModal(); showAssignedArea('${escHtml(a.area)}')">地図を表示</button>`
                    + (canReturn ? `<button class="clear-btn" style="padding:5px 8px; font-size:12px;" onclick="returnAreaConfirm(${a.id}, '${escHtml(a.area)}', showSharedAreas)">区域を返却</button>` : '')
                    + `</div></div>`;
            }).join('');
            body.innerHTML = html;
            return;
        }
        // 概要：一覧 or 地区マップ（切替）。各地区に貸出中数を表示し、タップでその地区の一覧へ。
        // AREA_GRID_ORDER/地区マップに無い地区（'その他'等）は埋もれないよう別枠で必ず出す。
        const extra = Object.keys(byDist).filter(d => AREA_GRID_ORDER.indexOf(d) < 0);
        const cell = d => { const n = (byDist[d] || []).length;
            return `<button class="area-opt shared-cell${n ? '' : ' is-empty'}" ${n ? `onclick="sharedState.district='${d}'; renderSharedAreas();"` : 'disabled'}><span class="sc-name">${escHtml(d)}</span><span class="sc-num">${n}</span></button>`; };
        let html = `<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">`
            + `<span style="font-size:13px; color:#666;">貸出中 計 ${areas.length} 区域</span>`
            + `<button class="choice-btn" style="background:#eef3f6; padding:4px 12px; min-width:0;" onclick="toggleSharedView()">${sharedState.view === 'map' ? '☰ 一覧' : '🗺 地図'}</button>`
            + `</div>`;
        if (sharedState.view === 'map') {
            html += `<div id="shared-map-host">${AREA_MAP_SVG}</div>`;
            if (extra.length) html += `<div style="font-size:12px; color:#888; margin:8px 0 4px;">地図にない地区</div><div class="shared-grid">${extra.map(cell).join('')}</div>`;
            body.innerHTML = html;
            decorateSharedMap(byDist);
        } else {
            html += `<div class="shared-grid">${AREA_GRID_ORDER.map(cell).join('')}${extra.map(cell).join('')}</div>`;
            body.innerHTML = html;
        }
    }
    // 地区マップSVGを全体利用ビュー用に再利用：クリックを地区選択へ差し替え、各地区に件数ラベルを重ねる
    function decorateSharedMap(byDist) {
        const host = document.getElementById('shared-map-host');
        if (!host) return;
        const svg = host.querySelector('svg');
        const NS = 'http://www.w3.org/2000/svg';
        try {
        host.querySelectorAll('path.dist').forEach(p => {
            const name = p.getAttribute('data-name');
            const n = (byDist[name] || []).length;
            p.onclick = () => { if (n) { sharedState.district = name; renderSharedAreas(); } };
            p.style.cursor = n ? 'pointer' : 'default';
            if (!n) { p.style.fill = '#eef1f3'; p.style.opacity = '0.6'; } // 貸出ありの地区はCSS既定（ホバー反応）を残す
        });
        if (svg) host.querySelectorAll('text.lbl').forEach(t => {
            const name = t.getAttribute('data-name');
            const n = (byDist[name] || []).length;
            t.onclick = () => { if (n) { sharedState.district = name; renderSharedAreas(); } };
            const c = document.createElementNS(NS, 'text');
            c.setAttribute('x', t.getAttribute('x'));
            c.setAttribute('y', String(Number(t.getAttribute('y')) + 52));
            c.setAttribute('text-anchor', 'middle');
            c.setAttribute('fill', n ? '#C75F56' : '#9aa6ad');
            c.setAttribute('font-size', '26');
            c.setAttribute('font-weight', 'bold');
            c.setAttribute('pointer-events', 'none');
            c.textContent = n ? (n + '区域') : '0';
            svg.appendChild(c);
        });
        } catch (e) { console.warn('全体利用マップの装飾に失敗しました', e); }
    }

    // ── 管理: 区域の貸出・返却 ──
    let lendState = { users: [], areas: [], sel: { group: '', email: '', district: '', chome: '', range: '' } };
    function showLendScreen() {
        openAppModal('🗂 区域の貸出・返却');
        showBusy('読み込み中…');
        apiCall('getLendData', {}).then(d => {
            lendState.users = d.users || [];
            lendState.areas = d.areas || [];
            renderLendScreen();
        }).catch(handleServerError).finally(hideBusy);
    }
    function lendSel(k, v) {
        lendState.sel[k] = v;
        if (k === 'group') lendState.sel.email = ''; // グループを変えたら「借りる人」選択をリセット
        if (k === 'group' && v === SHARED_GROUP_NAME) lendState.sel.email = '__GROUP__'; // 全体利用は借りる人を自動で「全体利用」に固定
        if (k === 'district') { lendState.sel.chome = ''; lendState.sel.range = ''; }
        if (k === 'chome') lendState.sel.range = '';
        renderLendScreen();
    }
    function lendDefaultDue() {
        const d = new Date(); d.setMonth(d.getMonth() + 4); // 既定の返却期日は4ヶ月後（変更可）
        return d.toISOString().slice(0, 10);
    }
    function renderLendScreen() {
        const s = lendState.sel;
        const isShared = (s.group === SHARED_GROUP_NAME); // 全体利用（共同利用）への割り振りモード
        const body = document.getElementById('app-modal-body');
        const opt = (v, l, cur) => `<option value="${escHtml(String(v))}" ${String(cur) === String(v) ? 'selected' : ''}>${escHtml(String(l))}</option>`;
        // 無効化(active=false)ユーザーは貸出先に出さない（参照できない人への貸出＝区域の滞留を入口で防ぐ。最終防御はGAS lendArea）
        const activeUsers = lendState.users.filter(u => u.active !== false);
        const groups = Array.from(new Set(activeUsers.map(u => u.group).filter(Boolean)));
        const users = isShared ? [] : activeUsers.filter(u => !s.group || u.group === s.group);
        if (s.email && s.email !== '__GROUP__' && !users.some(u => u.email === s.email)) s.email = '';
        const noChome = s.district && AREA_DATA[s.district] === null;
        const chomes = (s.district && !noChome) ? Object.keys(AREA_DATA[s.district]) : [];
        const uname = (em) => { const u = lendState.users.find(x => x.email === em); return u ? (u.name || u.email) : em; };
        const canLend = !!s.email; // 借りる人（個人 or グループ/全体利用）が選択済みか
        // 選択中の地区・丁目に属する番地（丁目なし地区は地区そのもの1件）
        let chomeAreas = [];
        if (noChome) chomeAreas = lendState.areas.filter(a => a.area === s.district);
        else if (s.district && s.chome) { const p = s.district + s.chome + '丁目'; chomeAreas = lendState.areas.filter(a => a.area.indexOf(p) === 0); }
        const banchiNum = a => { const m = String(a.area).match(/(\d+)番$/); return m ? parseInt(m[1]) : 0; };
        // 20件単位の範囲（丁目あり時のみ）。丁目を選んだら既定で先頭範囲。
        let ranges = [];
        let listAreas = chomeAreas;
        if (!noChome && s.chome) {
            const maxB = AREA_DATA[s.district][s.chome] || 0;
            for (let st = 1; st <= maxB; st += 20) ranges.push(st);
            if ((!s.range || isNaN(parseInt(s.range))) && ranges.length) s.range = ranges[0];
            const rstart = parseInt(s.range) || 1;
            listAreas = chomeAreas.filter(a => { const n = banchiNum(a); return n >= rstart && n <= rstart + 19; });
        }

        const groupSel = `<select style="flex:1; min-width:0;" onchange="lendSel('group', this.value)"><option value="">グループ選択</option>${groups.map(g => opt(g, g, s.group)).join('')}${opt(SHARED_GROUP_NAME, '👪 全体利用（共同利用）', s.group)}</select>`;
        const userSel = isShared
            ? `<select style="flex:2; min-width:0;" disabled><option selected>👪 全体利用（全員で共同利用）</option></select>`
            : `<select style="flex:2; min-width:0;" onchange="lendSel('email', this.value)"><option value="">-- ユーザー選択 --</option>${s.group ? opt('__GROUP__', '🟢 ' + s.group + '（グループ全体）', s.email) : ''}${users.map(u => opt(u.email, (u.name || u.email) + (u.group ? '（' + u.group + '）' : ''), s.email)).join('')}</select>`;
        let html = '<div style="font-weight:bold; margin-bottom:4px;">借りる人</div>'
            + '<div style="display:flex; gap:6px; margin-bottom:10px;">'
            + groupSel + userSel
            + '</div>'
            + '<div style="font-weight:bold; margin-bottom:4px;">区域（地区・丁目・範囲を選ぶ）</div>'
            + '<div style="display:flex; gap:6px; margin-bottom:8px;">'
            + `<select style="flex:1; min-width:0;" onchange="lendSel('district', this.value)"><option value="">地区</option>${Object.keys(AREA_DATA).map(d => opt(d, d, s.district)).join('')}</select>`
            + `<select style="flex:1; min-width:0;" onchange="lendSel('chome', this.value)" ${(!s.district || noChome) ? 'disabled' : ''}><option value="">丁目</option>${chomes.map(c => opt(c, c + '丁目', s.chome)).join('')}</select>`
            + `<select style="flex:1.4; min-width:0;" onchange="lendSel('range', this.value)" ${(noChome || !s.chome || !ranges.length) ? 'disabled' : ''}><option value="">範囲</option>${ranges.map(st => opt(st, st + '～' + Math.min(st + 19, AREA_DATA[s.district][s.chome]) + '番', s.range)).join('')}</select>`
            + '</div>';
        // 範囲内の番地一覧（番地ごとに 件数・状態・プレビュー・返却期日・貸出ボタン）
        if (listAreas.length) {
            html += listAreas.slice().sort((a, b) => banchiNum(a) - banchiNum(b)).map(a => {
                const num = noChome ? a.area : String(a.area).replace(/^.*丁目/, '');
                const lent2 = !!(a.user || a.group);
                const who = a.group ? (a.group === SHARED_GROUP_NAME ? '👪 全体利用' : a.group + '（グループ）') : (a.name || uname(a.user));
                const statusHtml = lent2
                    ? `<span style="color:#C75F56;">貸出中（${a.lendCount || 1}回目）: ${escHtml(who)}（${escHtml(a.lendDate || '-')} → <span class="${dueClass(a.dueDate)}">${escHtml(a.dueDate || '-')}</span>）</span>`
                    : `<span style="color:#555;">最終返却日: ${escHtml(a.lastReturn || 'なし')}　これまで ${a.lendCount || 0} 回</span>`;
                const off = lent2 || !canLend;
                const dateInput = lent2 ? '' : `<span style="margin-left:8px; color:#555;">貸出期限</span><input type="date" id="lend-due-${a.id}" value="${lendDefaultDue()}" style="font-size:12px; padding:2px 4px; width:106px; margin-left:4px; vertical-align:middle;">`; // 未貸出のみ。状態行の「これまでX回」の右に「貸出期限＋日付」を小さく表示
                return `<div class="lend-item">`
                    + `<div style="display:flex; gap:6px; align-items:center;">`
                    + `<div style="flex:1; min-width:0;"><b style="font-size:15px;">${escHtml(num)}</b><span style="color:#777; font-size:12px;">（${a.count === '' || a.count == null ? '-' : a.count}件）</span></div>`
                    + `<button class="choice-btn" style="flex:0 0 auto; width:104px; padding:6px 0; white-space:nowrap; background:#eef3f6;" onclick="previewLendArea(${a.id})">地図プレビュー</button>`
                    + `<button class="choice-btn" style="flex:0 0 auto; width:104px; padding:6px 0; white-space:nowrap; ${off ? 'background:#b9c2c8; border-color:#b9c2c8; color:#f0f0f0; cursor:not-allowed;' : 'background:#5E9DB8; border-color:#5E9DB8; color:#fff;'}" onclick="doLendArea(${a.id})" ${off ? 'disabled' : ''}>貸出</button>`
                    + `</div>`
                    + `<div style="font-size:12px; margin-top:4px;">${statusHtml}${dateInput}</div>`
                    + `</div>`;
            }).join('');
        } else if (s.district && (noChome || s.chome)) {
            html += '<div style="color:#888; padding:6px;">この範囲に番地がありません。</div>';
        } else {
            html += '<div style="color:#888; padding:8px;">地区・丁目・範囲を選ぶと、番地ごとの貸出欄が表示されます。</div>';
        }
        const lent = lendState.areas.filter(a => a.user || a.group);
        html += `<div style="background:#d4dae0; border:1px solid #b3bcc4; border-radius:6px; padding:8px; margin-top:8px;">`;
        html += `<div style="font-weight:bold; padding-bottom:6px; border-bottom:1px solid #aeb8c0; margin-bottom:4px;">貸出中の区域（${lent.length}）</div>`;
        html += lent.length ? lent.map(a =>
            `<div class="lend-row"><div class="grow"><b>${escHtml(a.area)}</b>　<span style="font-size:13px; color:#333;">${escHtml(a.group ? (a.group === SHARED_GROUP_NAME ? '👪 全体利用' : a.group + '（グループ）') : (a.name || uname(a.user)))}</span><br>`
            + `<span style="font-size:12px; color:#666;">${escHtml(a.lendDate || '-')} → <span class="${dueClass(a.dueDate)}">${escHtml(a.dueDate || '-')}</span></span></div>`
            + `<button class="clear-btn" onclick="doReturnArea(${a.id}, '${escHtml(a.area)}')">返却</button></div>`
        ).join('') : '<div style="color:#888; padding:6px;">ありません</div>';
        html += `</div>`;
        body.innerHTML = html;
    }
    // プレビュー: モーダルを一旦隠して地図で区域を確認 →「戻る」で選択状態のまま貸出画面へ
    function previewLendArea(areaId) {
        const a = lendState.areas.find(x => String(x.id) === String(areaId));
        if (!a) return;
        document.getElementById('app-modal').style.display = 'none';
        document.getElementById('lend-preview-back').style.display = '';
        showAssignedArea(a.area);
    }
    function backToLendScreen() {
        document.getElementById('lend-preview-back').style.display = 'none';
        document.getElementById('app-modal').style.display = 'flex'; // 選択状態は lendState に保持されている
    }
    function doLendArea(areaId) {
        const s = lendState.sel;
        const a = lendState.areas.find(x => String(x.id) === String(areaId));
        if (!a) return;
        const isGroup = (s.email === '__GROUP__'); // 「グループ用」選択時はグループ全体へ貸出
        const isShared = (s.group === SHARED_GROUP_NAME); // 全体利用（共同利用）への割り振り
        const u = isGroup ? null : lendState.users.find(x => x.email === s.email);
        if (!isGroup && !u) { showToast('借りる人を選んでください', true); return; }
        const dueEl = document.getElementById('lend-due-' + areaId);
        const due = dueEl ? dueEl.value : '';
        const whoLabel = isShared ? '全体利用（全員で共同利用）' : (isGroup ? `グループ「${s.group}」全体` : `${u.name || u.email} さん`);
        appConfirm(`「${a.area}」を\n${whoLabel}に貸し出します。\n返却期日: ${due || '未設定'}`, { okLabel: '貸出する' }).then(ok => {
            if (!ok) return;
            showBusy('貸出中…');
            const params = isGroup
                ? { areaId: a.id, targetGroup: s.group, dueDate: due ? due.replace(/-/g, '/') : '' }
                : { areaId: a.id, targetEmail: u.email, dueDate: due ? due.replace(/-/g, '/') : '' };
            apiCall('lendArea', params)
                .then(d => {
                    lendState.users = d.users; lendState.areas = d.areas;
                    renderLendScreen(); // 借りる人・区域・範囲の選択は保持＝続けて同じ範囲の別番地を貸し出せる
                    showToast('貸し出しました', false);
                })
                .catch(handleServerError).finally(hideBusy);
        });
    }
    function doReturnArea(id, label) {
        appConfirm(`「${label}」を返却済みにします。`, { okLabel: '返却する' }).then(ok => {
            if (!ok) return;
            showBusy('返却中…');
            apiCall('returnArea', { areaId: id })
                .then(d => { lendState.users = d.users; lendState.areas = d.areas; renderLendScreen(); showToast('返却しました', false); })
                .catch(handleServerError).finally(hideBusy);
        });
    }

    // ── 管理: ユーザー管理（保存すると UserList とスプレッドシートの共有を更新） ──
    let userAdminState = [];
    let userAdminFilter = { q: '', role: '', status: '', group: '' }; // ユーザー管理のフィルタ（メール/名前/グループ・権限・状態）
    // 権限ごとの色（背景＋文字）。一般=グレー / 貸出係=緑 / 管理者=青 / システム管理者=アンバー
    const ROLE_STYLE = { user: 'background:#EEF1F3; color:#4B5560;', lender: 'background:#E1F5EE; color:#0F6E56;', manager: 'background:#E6F1FB; color:#185FA5;', sysadmin: 'background:#FAEEDA; color:#854F0B;' };
    const roleStyleStr = role => ROLE_STYLE[role] || '';
    // グループ名から決定的に色を割り当て（同じ名前は常に同じ色）。空は色なし。
    const GROUP_PALETTE = ['background:#E6F1FB; color:#0C447C;', 'background:#E1F5EE; color:#085041;', 'background:#FAECE7; color:#712B13;', 'background:#FBEAF0; color:#72243E;', 'background:#EAF3DE; color:#27500A;', 'background:#FAEEDA; color:#633806;', 'background:#EEEDFE; color:#3C3489;', 'background:#F1EFE8; color:#444441;'];
    const groupStyleStr = name => { name = String(name || '').trim(); if (!name) return ''; let h = 0; for (let k = 0; k < name.length; k++) h = (h * 31 + name.charCodeAt(k)) >>> 0; return GROUP_PALETTE[h % GROUP_PALETTE.length]; };
    function showUserAdmin() {
        openAppModal('👥 ユーザー管理');
        showBusy('読み込み中…');
        apiCall('getUsers', {}).then(list => {
            userAdminState = (list || []).map(u => ({ email: u.email, name: u.name, role: u.role, group: u.group, active: u.active !== false }));
            userAdminFilter = { q: '', role: '', status: '', group: '' }; // 開くたびにフィルタは初期化（前回条件を持ち越さない）
            renderUserAdmin();
        }).catch(handleServerError).finally(hideBusy);
    }
    function renderUserAdmin() {
        const body = document.getElementById('app-modal-body');
        let html = '';
        const _uf = userAdminFilter;
        const groups = Array.from(new Set(userAdminState.map(u => String(u.group || '').trim()).filter(Boolean))).sort();
        const gOpt = cur => groups.map(g => `<option value="${escHtml(g)}" ${String(cur) === g ? 'selected' : ''}>${escHtml(g)}</option>`).join('');
        // フィルタ：メール/名前は検索（記入）、グループ・権限・状態は選択
        html += '<div class="ua-filter">'
            + `<input id="ua-filter-q" placeholder="🔍 メール／名前 で検索" value="${escHtml(_uf.q)}" oninput="userAdminFilter.q = this.value; applyUserFilter();">`
            + `<select id="ua-filter-group" style="${groupStyleStr(_uf.group)}" onchange="userAdminFilter.group = this.value; applyUserFilter();"><option value="">グループ選択</option>${gOpt(_uf.group)}</select>`
            + `<select id="ua-filter-role" style="${roleStyleStr(_uf.role)}" onchange="userAdminFilter.role = this.value; applyUserFilter();"><option value="">権限選択</option><option value="user" ${_uf.role === 'user' ? 'selected' : ''}>一般</option><option value="lender" ${_uf.role === 'lender' ? 'selected' : ''}>貸出係</option><option value="manager" ${_uf.role === 'manager' ? 'selected' : ''}>管理者</option><option value="sysadmin" ${_uf.role === 'sysadmin' ? 'selected' : ''}>システム管理者</option></select>`
            + `<select id="ua-filter-status" onchange="userAdminFilter.status = this.value; applyUserFilter();"><option value="">有効・無効</option><option value="active" ${_uf.status === 'active' ? 'selected' : ''}>有効</option><option value="inactive" ${_uf.status === 'inactive' ? 'selected' : ''}>無効</option></select>`
            + '<span id="ua-filter-count"></span>'
            + '</div>';
        html += `<datalist id="ua-group-list">${groups.map(g => `<option value="${escHtml(g)}">`).join('')}</datalist>`;
        // 行データ。オーナーは末尾へ並べ替え（i は userAdminState の元インデックスを保持＝各操作はそのまま有効）
        const isOwnerRow = u => !!(ME.owner && String(u.email).trim().toLowerCase() === ME.owner);
        const rows = userAdminState.map((u, i) => ({ u, i }));
        const ordered = rows.filter(r => !isOwnerRow(r.u)).concat(rows.filter(r => isOwnerRow(r.u)));
        html += ordered.map(({ u, i }) => {
            const isOwner = isOwnerRow(u);
            if (isOwner) { u.role = 'sysadmin'; u.active = true; } // 表示と送信値を一致させる（シート手編集で崩れていても矯正）
            const inactive = (u.active === false);
            // オーナーは権限・状態を変更不可（グレーアウトした無効セレクトで“他と同じ表示”にする）。メールは読取専用、削除不可。漢字名・グループは編集可。
            const emailIn = isOwner
                ? `<input data-uf="email" class="ua-email" readonly style="background:#ececec; color:#8a8a8a;" value="${escHtml(u.email)}">`
                : `<input data-uf="email" class="ua-email" placeholder="メールアドレス" value="${escHtml(u.email)}" onchange="userAdminState[${i}].email = this.value">`;
            const statusSel = `<select data-uf="status" class="ua-status" ${isOwner ? 'disabled' : ''} style="${inactive ? 'color:#C75F56; font-weight:bold;' : ''}" onchange="userAdminState[${i}].active = (this.value === '1'); renderUserAdmin();"><option value="1" ${!inactive ? 'selected' : ''}>有効</option><option value="0" ${inactive ? 'selected' : ''}>無効</option></select>`;
            const roleSel = `<select data-uf="role" class="ua-role" style="${isOwner ? '' : roleStyleStr(u.role)}" ${isOwner ? 'disabled' : ''} onchange="userAdminState[${i}].role = this.value; renderUserAdmin();"><option value="user" ${u.role === 'user' ? 'selected' : ''}>一般</option><option value="lender" ${u.role === 'lender' ? 'selected' : ''}>貸出係</option><option value="manager" ${u.role === 'manager' ? 'selected' : ''}>管理者</option><option value="sysadmin" ${u.role === 'sysadmin' ? 'selected' : ''}>システム管理者</option></select>`;
            return `<div class="user-row${isOwner ? ' ua-owner' : ''}${inactive ? ' ua-inactive' : ''}">`
                + `<div class="ua-row1">`
                + emailIn
                + `<input data-uf="name" class="ua-name" placeholder="漢字名" value="${escHtml(u.name)}" onchange="userAdminState[${i}].name = this.value">`
                + `</div><div class="ua-row2">`
                + `<input data-uf="group" class="ua-group" list="ua-group-list" style="${groupStyleStr(u.group)}" placeholder="グループ" value="${escHtml(u.group)}" onchange="userAdminState[${i}].group = this.value; renderUserAdmin();">`
                + statusSel
                + roleSel
                + (isOwner ? '' : `<button class="clear-btn ua-del" onclick="userAdminState.splice(${i}, 1); renderUserAdmin();">削除</button>`)
                + `</div></div>`;
        }).join('');
        html += '<div style="display:flex; gap:8px; margin-top:10px;">'
            + `<button class="choice-btn" style="flex:1; background:#eef3f6;" onclick="userAdminState.push({email:'',name:'',group:'',role:'user',active:true}); renderUserAdmin();">＋ 行を追加</button>`
            + `<button class="choice-btn" style="flex:1; background:#5E9DB8; border-color:#5E9DB8; color:#fff;" onclick="saveUserAdmin()">保存する</button>`
            + '</div>';
        body.innerHTML = html;
        applyUserFilter();
    }
    // ユーザー管理のフィルタ適用（行の input/select を直接読んで表示/非表示を切替。再描画しないので入力欄のフォーカスを保てる）
    function applyUserFilter() {
        const f = userAdminFilter; const q = (f.q || '').trim().toLowerCase();
        let shown = 0, total = 0;
        document.querySelectorAll('#app-modal-body .user-row').forEach(row => {
            total++;
            const val = sel => { const el = row.querySelector(sel); return el ? String(el.value || '') : ''; };
            const email = val('input[data-uf="email"]').toLowerCase();
            const name = val('input[data-uf="name"]').toLowerCase();
            const group = val('input[data-uf="group"]').toLowerCase();
            const roleEl = row.querySelector('select[data-uf="role"]');
            const role = roleEl ? roleEl.value : (row.dataset.ownerRole || 'sysadmin');
            const stEl = row.querySelector('select[data-uf="status"]');
            const active = stEl ? (stEl.value === '1') : true; // オーナー行はセレクトが無く常に有効
            let ok = true;
            if (q && !(email.indexOf(q) >= 0 || name.indexOf(q) >= 0)) ok = false; // 検索はメール/名前のみ
            if (f.group && group !== String(f.group).trim().toLowerCase()) ok = false; // グループは選択で一致
            if (f.role && role !== f.role) ok = false;
            if (f.status === 'active' && !active) ok = false;
            if (f.status === 'inactive' && active) ok = false;
            row.style.display = ok ? '' : 'none';
            if (ok) shown++;
        });
        const c = document.getElementById('ua-filter-count');
        if (c) c.textContent = shown + ' / ' + total + ' 件';
    }
    function saveUserAdmin() {
        const users = userAdminState
            .map(u => ({ email: String(u.email || '').trim().toLowerCase(), name: u.name || '', role: u.role || 'user', group: u.group || '', active: u.active !== false }))
            .filter(u => u.email);
        appConfirm('ユーザー一覧を保存し、スプレッドシートの共有にも反映します。', { okLabel: '保存する' }).then(ok => {
            if (!ok) return;
            showBusy('保存中…');
            apiCall('saveUsers', { users: users }).then(list => {
                userAdminState = (list || []).map(u => ({ email: u.email, name: u.name, role: u.role, group: u.group, active: u.active !== false }));
                renderUserAdmin();
                showToast('保存しました（共有も更新）', false);
            }).catch(handleServerError).finally(hideBusy);
        });
    }

    // ✨ 最重要: スプレッドシートから読み込んだ瞬間に「絶対数値化」する描画処理
    function renderMarkers(data) {
        currentMarkers.forEach(m => m.remove());
        currentMarkers = [];

        if (!Array.isArray(data)) {
            console.error('renderMarkers: 配列ではありません', data);
            showToast('データ形式が不正です（配列ではありません）', true);
            return;
        }
        currentData = data;
        saveDataCache(data); // 次回起動の先行表示用に保存（同一データの再保存は無害）

        // ピンが多いときは画面内のみ描画（少なければ全件）
        limitedMode = data.length > MAX_RENDER_ALL;
        const renderList = limitedMode ? data.filter(inCurrentView) : data;

        const groups = {};
        let skipped = 0;
        renderList.forEach(item => {
            // ここで文字列の座標を「浮動小数点数」へ強制パース
            const lat = parseFloat(item.緯度);
            const lng = parseFloat(item.経度);

            // 座標として有効ではない行（空白、不正テキストなど）は安全にスキップ
            if (isNaN(lat) || isNaN(lng) || lat === 0 || lng === 0) { skipped++; return; }

            const key = `${lat.toFixed(6)}_${lng.toFixed(6)}`;
            // パース済みの数値座標をグループに保持（マーカー生成時の再パースを排除）
            if (!groups[key]) groups[key] = { lat, lng, items: [] };
            groups[key].items.push(item);
        });

        console.log(`受信データ ${data.length} 件 / 表示ピン ${Object.keys(groups).length} 件 / 座標無効スキップ ${skipped} 件`);
        // 「座標が無い」警告は、全データに有効座標が1件も無いときだけ出す。
        // limitedMode（>200件）で画面内にピンが無いだけのケースでは出さない（誤検知防止）。
        if (data.length > 0 && Object.keys(groups).length === 0) {
            const hasAnyValidCoord = data.some(item => {
                const la = parseFloat(item.緯度), ln = parseFloat(item.経度);
                return !isNaN(la) && !isNaN(ln) && la !== 0 && ln !== 0;
            });
            if (!hasAnyValidCoord) showToast('座標が読み取れる行がありません（E列=緯度 / F列=経度 を確認）', true);
        }

        Object.keys(groups).forEach(key => {
          try {
            const group = groups[key];
            const items = group.items;
            const firstItem = items[0];
            const markerEl = document.createElement('div');
            markerEl.className = 'custom-marker';

            let popupHtml = `<div class="popup-content">`;
            let isSmallShuga = false; // 小さめ集合住宅(12戸以下)＝広域で先に隠す対象

            if (firstItem.種別 === '集合住宅') {
                markerEl.className += ' marker-shuga';
                // 戸数が12以下はアパート(低層SVG)、13以上はマンション(高層SVG)。白シルエットで背景色(構成属性)が生きる
                const units = parseInt(firstItem.総戸数) || (firstItem.有効部屋リスト ? String(firstItem.有効部屋リスト).split(',').filter(s => s !== '').length : 0);
                isSmallShuga = units <= 12;
                markerEl.innerHTML = units > 12 ? ICON_MANSION : ICON_APART;
                // 背景＝構成属性（ファミリー/シングル等）で色分け
                markerEl.style.background = shugaColor(firstItem.属性);
                // 薄黄(ファミリー/混在)背景では白シルエットが見えないため、濃い黄土色に切り替える
                markerEl.style.color = (firstItem.属性 === 'ファミリー' || firstItem.属性 === '混在') ? '#8a7117' : '#fff';
                // 枠＝オートロックありのみ赤枠。なし・不明は枠なし
                markerEl.style.border = (getAutolock(firstItem) === 'あり') ? '3px solid #A8554E' : 'none';
                popupHtml += createShugaViewHtml(items);
            } else if (firstItem.種別 === '施設') {
                markerEl.className += ' marker-facility';
                styleFacilityMarker(markerEl, firstItem.属性); // 絵文字（郵便局は〒赤太字）＋種類を保持（サイズ調整用）
                popupHtml += createFacilityViewHtml(firstItem);
            } else {
                styleKodateMarker(markerEl, firstItem);
                // 同一座標に複数の戸建て（世帯）がある場合はページャ付きで全件を辿れるようにする（座標重複でも世帯が消えない）
                popupHtml += (items.length > 1) ? kodateGroupHtml(items, 0) : createKodedateViewHtml(firstItem);
            }
            popupHtml += `</div>`;

            const popup = new mapboxgl.Popup({ offset: 25, closeOnClick: false, maxWidth: 'none', anchor: 'bottom', focusAfterOpen: false }).setHTML(popupHtml);

            const isShuga = (firstItem.種別 === '集合住宅');
            const isFacility = (firstItem.種別 === '施設');
            const isKodate = !isShuga && !isFacility;
            // 吹き出しが開いたら、実高さを測ってピン＋吹き出しが画面に収まるよう寄せる。
            // 集合住宅は後から部屋操作欄が広がるぶん(約140px)を見込む。
            // 開くたびに操作欄を初期化（前回の部屋選択を持ち越さない＝確実に「部屋をタップして…」に）
            popup.on('open', () => {
                if (isShuga) resetRoomActionPanel(popup);
                fillDerivedAddress(popup.getElement()); // 住所（街区内包方式）を算出して表示
                if (!isShuga) attachHistoryLongPress(popup.getElement(), firstItem.rowNumber, false); // 戸建て履歴の長押し編集
                if (isShuga) bindRoomCopyCells(popup.getElement(), firstItem.rowNumber); // 部屋: タップ=操作欄 / 長押し=情報コピー
                else bindTitleCopy(popup.getElement(), firstItem.rowNumber);              // 戸建て: 「戸建て」長押し=情報コピー
                if (isKodate && items.length > 1) bindKodateGroupPager(popup, marker, items); // 同座標の複数世帯ページャ（◀▶で切替。戸建てのみ）
                fitPopupInView(marker, 0); // 部屋操作欄は最初から高さを確保するので追加余白は不要
            });
            // 吹き出しを閉じたら、展開中のUI（編集フォーム・詳細表示・属性4択・部屋操作欄）を初期状態へ戻す
            popup.on('close', () => resetPopupView(popup, firstItem.rowNumber));

            // 【数値保証】グループ化時にパース済みの数値座標 [lng, lat] でマーカーを作成
            const marker = new mapboxgl.Marker(markerEl)
                .setLngLat([group.lng, group.lat])
                .setPopup(popup)
                .addTo(map);
            marker._isKodate = isKodate;                         // 戸建ては広域(z<16)で隠す
            marker._isShuga = isShuga;                           // 集合住宅は規模ごとに広域で隠す（小=z<15.5 / 大=z<14.0）。施設は常時表示
            marker._shugaSmall = isSmallShuga;                  // 集合住宅のうち小規模(≤12戸=アパート型)か
            marker._item = firstItem;                            // アイコンフィルタ判定用（種別・属性・オートロック・管理人 等を参照）
            marker._rowNumber = firstItem.rowNumber;            // 部屋更新時にポップアップを特定する用
            if (isKodate) marker._rowNumbers = items.map(it => it.rowNumber); // 同座標の複数世帯を全部覚える（戸建てのページャ・インプレース判定用）

            // このマーカーを開くときは、新規フォームや他の開いているポップアップを閉じる
            // （寄せる処理は popup の 'open' イベントで実高さを測って行う）
            markerEl.addEventListener('click', () => {
                if (activeNewMarker) { activeNewMarker.remove(); activeNewMarker = null; }
                currentMarkers.forEach(other => {
                    if (other !== marker) { const op = other.getPopup(); if (op && op.isOpen()) other.togglePopup(); }
                });
            });
            enableMarkerDragOnLongPress(marker, markerEl, firstItem.rowNumber); // 長押し→振動→ドラッグで移動
            currentMarkers.push(marker);
          } catch (err) {
            console.error('マーカー描画スキップ:', key, err);
          }
        });

        applyZoomVisibility(); // 現在のズームに応じて戸建ての表示/非表示を反映
    }

    // 同一座標に複数の戸建て（世帯）がある場合の吹き出し。◀▶ページャで全件を辿れるようにする（座標重複でも世帯が消えない）。
    function kodateGroupHtml(items, idx) {
        const n = items.length, i = ((idx % n) + n) % n;
        const navBtn = (d, label) => `<button class="kg-nav" data-d="${d}" style="border:1px solid #b8c4cc; background:#eef3f6; color:#2c3e50; border-radius:6px; padding:2px 12px; font-size:14px; cursor:pointer;">${label}</button>`;
        const pager = `<div class="kodate-group-nav" style="display:flex; align-items:center; justify-content:space-between; gap:6px; margin-bottom:6px; padding-bottom:4px; border-bottom:1px dashed #cfd8dd;">`
            + navBtn(-1, '◀')
            + `<span style="font-size:12px; font-weight:bold; color:#2c3e50;">同じ地点に ${n} 世帯（${i + 1}/${n}）</span>`
            + navBtn(1, '▶')
            + `</div>`;
        return `<div class="kodate-group" data-idx="${i}">${pager}${createKodedateViewHtml(items[i])}</div>`;
    }
    // ページャの◀▶に切替処理を割り当てる（押すたび吹き出し内容・マーカー色・各種長押しを作り直して再バインド）。
    function bindKodateGroupPager(popup, marker, items) {
        const root = popup.getElement && popup.getElement();
        if (!root) return;
        root.querySelectorAll('.kg-nav').forEach(btn => {
            btn.onclick = () => {
                const wrap = root.querySelector('.kodate-group');
                const n = items.length;
                const cur = wrap ? (parseInt(wrap.dataset.idx) || 0) : 0;
                const ni = (((cur + (parseInt(btn.dataset.d) || 0)) % n) + n) % n;
                popup.setHTML('<div class="popup-content">' + kodateGroupHtml(items, ni) + '</div>');
                styleKodateMarker(marker.getElement(), items[ni]); applyZoomScale(); // マーカー色を表示中の世帯に合わせる
                const el = popup.getElement();
                fillDerivedAddress(el);
                attachHistoryLongPress(el, items[ni].rowNumber, false);
                bindTitleCopy(el, items[ni].rowNumber);
                bindKodateGroupPager(popup, marker, items); // 作り直したボタンへ再バインド
                setTimeout(() => fitPopupInView(marker, 0), 30);
            };
        });
    }

    // 戸建て詳細ポップアップ画面
    function createKodedateViewHtml(item) {
        let historyHtml = '';
        if (item.履歴データ) {
            try {
                const arr = JSON.parse(item.履歴データ);
                historyHtml = arr.map((h, i) => `<div class="history-item hist-row" data-idx="${i}" data-time="${escHtml(h.time)}" style="display:flex; justify-content:space-between; gap:8px; cursor:pointer;"><span>${escHtml(h.time)}</span><b>${escHtml(String(h.status).replace(/属性：/g, ''))}</b></div>`).join('');
            } catch(e){}
        }

        const attr = item.属性;
        const memoCls = (item.特記事項 && String(item.特記事項).trim()) ? '' : ' memo-empty'; // 空メモは簡易表示で隠す

        return `
            <div class="building-title">${escHtml(item['建物名 / 世帯名'] || '戸建て')}</div>
            ${addrRowHtml(item, attrLineHtml(attr, `saveAttribute(${item.rowNumber}, '%v')`, false))}
            <div style="font-weight:bold; font-size:14px; margin:2px 0 4px;">訪問結果</div>
            ${resultChoiceHtml(item.最新ステータス, `saveStatus(${item.rowNumber}, '%v')`)}
            <div style="font-weight:bold; font-size:14px; margin-top:6px;">履歴欄</div>
            <div class="history-box">${historyHtml || '<div style="color:#aaa;">履歴なし</div>'}</div>

            <div class="memo-section${memoCls}">
                <label style="font-size:11px; font-weight:bold;">メモ</label>
                <textarea id="memo-${item.rowNumber}" rows="2" style="width:100%; font-size:12px;" readonly onpointerdown="this.removeAttribute('readonly')">${escHtml(item.特記事項 || '')}</textarea>
                <div class="btn-row detail-only">
                    <button class="save-btn" onclick="saveMemo(${item.rowNumber})">メモ保存</button>
                    <button class="clear-btn" onclick="clearMemo(${item.rowNumber})">メモ削除</button>
                    <button class="clear-btn" style="background:#7f8c8d;" onclick="confirmClearHistory(${item.rowNumber}, false)">履歴クリア</button>
                </div>
            </div>
            <button class="clear-btn detail-only" style="width:100%; margin-top:8px; background:#9E3B4A;" onclick="confirmDelete(${item.rowNumber})">🗑 このピンを削除</button>
            <button class="detail-toggle" onclick="togglePopupDetail(this)">▼ 詳細を表示</button>
        `;
    }

    // 施設（目印になる建物）の詳細吹き出し。訪問結果・部屋・履歴は持たず、種類・住所・メモ・編集・削除のみ。
    function createFacilityViewHtml(item) {
        const ic = facilityIcon(item.属性), lbl = facilityLabel(item.属性);
        const memoText = cleanMemo(item);
        const memoCls = memoText.trim() ? '' : ' memo-empty';
        return `
            <div class="building-title">${ic} ${escHtml(item['建物名 / 世帯名'] || '施設')}</div>
            ${addrRowHtml(item)}
            <div style="font-size:13px; color:#555; margin-bottom:6px;">種類: <b style="font-size:14px;">${ic} ${escHtml(lbl)}</b></div>
            <div class="memo-section${memoCls}">
                <label style="font-size:11px; font-weight:bold;">メモ</label>
                <textarea id="memo-${item.rowNumber}" rows="1" style="width:100%; font-size:11px;" readonly onpointerdown="this.removeAttribute('readonly')">${escHtml(memoText)}</textarea>
                <div class="btn-row detail-only">
                    <button class="save-btn" onclick="saveMemo(${item.rowNumber})">メモ保存</button>
                    <button class="clear-btn" onclick="clearMemo(${item.rowNumber})">メモ削除</button>
                </div>
            </div>
            <button class="save-btn detail-only" style="background:#34495e; width:100%; margin-top:8px;" onclick="showFacilityEditForm(${item.rowNumber}, this)">✏️ 施設情報を編集</button>
            <button class="clear-btn detail-only" style="width:100%; margin-top:6px; background:#9E3B4A;" onclick="confirmDelete(${item.rowNumber})">🗑 このピンを削除</button>
            <button class="detail-toggle" onclick="togglePopupDetail(this)">▼ 詳細を表示</button>
        `;
    }
    // 施設の吹き出しを、閉じずにその場で最新化する（メモ保存・履歴クリア相当など）
    function refreshFacilityPopup(rowNumber, latest) {
        currentData = latest;
        saveDataCache(currentData);
        const item = currentData.find(d => d.rowNumber === rowNumber);
        const marker = currentMarkers.find(m => m._rowNumber === rowNumber);
        const popup = marker ? marker.getPopup() : null;
        if (item && popup) {
            if (marker.getElement()) styleFacilityMarker(marker.getElement(), item.属性); // 種類変更時はマーカー（絵文字・郵便局の赤）も更新
            popup.setHTML('<div class="popup-content">' + createFacilityViewHtml(item) + '</div>');
            fillDerivedAddress(popup.getElement());
            bindTitleCopy(popup.getElement(), rowNumber);
            setTimeout(() => fitPopupInView(marker, 0), 30);
        } else {
            renderMarkers(latest);
        }
    }
    // 施設情報の編集フォーム（種類・建物名・メモ）。詳細表示を差し替える。
    function showFacilityEditForm(rowNumber, btn) {
        const item = currentData.find(d => d.rowNumber === rowNumber);
        if (!item) { showToast('編集対象が見つかりません', true); return; }
        const container = btn.closest('.popup-content');
        if (!container) return;
        const picker = FACILITY_TYPES.map(t =>
            `<button type="button" class="fac-type-btn${item.属性 === t.v ? ' fac-sel' : ''}" data-v="${escHtml(t.v)}" onclick="pickFacilityType(this)">${t.icon} ${escHtml(t.v)}</button>`
        ).join('');
        container.innerHTML = `
            <div class="building-title">✏️ 施設情報を編集</div>
            <div class="form-group"><label>建物名</label><input type="text" id="fac-edit-name" value="${escHtml(item['建物名 / 世帯名'] || '')}" style="background:#FFF9DD;"></div>
            <input type="hidden" id="new-fac-type" value="${escHtml(item.属性 || '')}">
            <div style="font-size:12px; font-weight:bold; margin:4px 0;">施設の種類</div>
            <div class="fac-type-grid">${picker}</div>
            <div class="form-group"><label>メモ</label><input type="text" id="fac-edit-memo" value="${escHtml(cleanMemo(item))}"></div>
            <div class="btn-row">
                <button class="submit-btn" id="fac-edit-save" onclick="saveFacilityEdit(${rowNumber}, this)">更新を保存</button>
                <button class="clear-btn" onclick="refreshFacilityPopup(${rowNumber}, currentData)">閉じる</button>
            </div>
        `;
        const marker = currentMarkers.find(m => m._rowNumber === rowNumber);
        if (marker) setTimeout(() => fitPopupInView(marker, 0), 30);
    }
    // 施設の編集を保存（構造が変わるので renderMarkers で全再描画）
    function saveFacilityEdit(rowNumber, btn) {
        const type = document.getElementById('new-fac-type').value;
        if (!type) { appAlert('施設の種類を選んでください'); return; }
        const data = { rowNumber: rowNumber, name: document.getElementById('fac-edit-name').value,
            facilityType: type, memo: document.getElementById('fac-edit-memo').value };
        btn.disabled = true; btn.innerText = '保存中...';
        showBusy('更新中…');
        apiCall('updateFacility', { data: data }).then((latest) => {
            showToast('施設情報を更新しました', false);
            renderMarkers(latest);
        }).catch((err) => { btn.disabled = false; btn.innerText = '更新を保存'; handleServerError(err); }).finally(hideBusy);
    }

    // 集合住宅詳細・グリッドテーブル画面
    function createShugaViewHtml(items) {
        const first = items[0];
        const floors = parseInt(first.階数 || 1);
        const maxRoom = parseInt(first.最大部屋番号 || 1);
        const validRoomsArr = String(first.有効部屋リスト || "").split(',').map(Number);

        // 部屋ごとの現在ステータス（T列のJSON）を取得し、色分けに使う
        let roomStatusMap = {};
        try { roomStatusMap = JSON.parse(first.部屋ステータス || '{}') || {}; } catch(e) { roomStatusMap = {}; }
        const hideNum = String(first.部屋番号非表示) === '1';
        // 個人宅/会社（U列）→ {部屋番号:'p'|'c'} に展開し、セルにアイコンを付ける
        const roomMarkMap = parseRoomMarks(first.個人宅);
        const memoText = cleanMemo(first);
        const memoCls = memoText.trim() ? '' : ' memo-empty'; // 空メモは簡易表示で隠す

        // 6部屋以上のときに横スクロールできるよう、テーブルを内容幅で配置（簡易表示では吹き出し幅に収める）
        let gridHtml = '<div class="grid-scroll" style="overflow-x:auto;"><table class="grid-table" style="width:auto;"><tbody>';
        for (let f = floors; f >= 1; f--) {
            gridHtml += `<tr><td class="grid-floor">${f}F</td>`;
            for (let r = 1; r <= maxRoom; r++) {
                const roomNum = f * 100 + r;
                if (validRoomsArr.includes(roomNum)) {
                    // 色は状態で変える。文字は通常は部屋番号だが、拒否・外国語のときは☆を表示する。
                    // （番号はセルをタップすると下の操作欄に「XXX号室」として表示される）
                    const st = roomStatusMap[roomNum];
                    const v = roomVisual(st);
                    let label = (st === '訪問拒否' || st === '外国語') ? '☆' : (hideNum ? cornerLabel(f, r, floors, maxRoom) : String(roomNum));
                    if (roomMarkMap[roomNum]) label = roomMarkLabel(roomMarkMap[roomNum]); // 個人宅=🏠／会社=🏢
                    gridHtml += `<td class="cell-active" data-room="${roomNum}" style="min-width:40px; background:${v.bg}; color:${v.color};">${label}</td>`;
                } else {
                    gridHtml += `<td class="cell-inactive"></td>`;
                }
            }
            gridHtml += '</tr>';
        }
        gridHtml += '</tbody></table></div>';

        // 管理人「あり」のときだけ、部屋グリッドの下に管理人マトリックス（1セル）を出す。
        // 操作・履歴・色は通常の部屋と同じ仕組み（部屋ステータスS列・履歴Q列を予約キー「管理人」で流用）。
        let mgrHtml = '';
        if (String(first.管理人) === 'あり') {
            // セルの表記は他の部屋と同様に固定（「管理人」）。状態は色だけで表す（roomVisual）。見出しは付けない。
            const mv = roomVisual(roomStatusMap[MGR_KEY]);
            mgrHtml = `<table class="grid-table" style="width:auto; margin-top:8px;"><tbody><tr>`
                + `<td class="cell-active" data-room="${MGR_KEY}" style="min-width:72px; background:${mv.bg}; color:${mv.color}; text-align:center; font-size:0.85em;">管理人</td>`
                + `</tr></tbody></table>`;
        }

        return `
            <div class="building-title">${escHtml(first['建物名 / 世帯名'])}</div>
            ${addrRowHtml(first)}
            <div style="font-size:11px; color:#aaa; margin-bottom:4px;">
                <span style="color:${shugaInfoColor('lock', getAutolock(first))};">オートロック: ${escHtml(getAutolock(first))}</span> ｜ <span style="color:${shugaInfoColor('attr', first.属性)};">構成: ${escHtml(first.属性 || '不明')}</span> ｜ <span style="color:${shugaInfoColor('mgr', first.管理人)};">管理人: ${escHtml(first.管理人 || '不明')}</span>
            </div>
            ${gridHtml}
            ${mgrHtml}
            <div id="room-action-area" style="margin-top:8px; border:1px solid #6FAEC0; padding:6px; background:#f0f7f9; min-height:200px;">${roomActionPlaceholder()}</div>

            <div class="memo-section${memoCls}">
                <label style="font-size:11px; font-weight:bold;">メモ</label>
                <textarea id="memo-${first.rowNumber}" rows="1" style="width:100%; font-size:11px;" readonly onpointerdown="this.removeAttribute('readonly')">${escHtml(memoText)}</textarea>
                <div class="btn-row detail-only">
                    <button class="save-btn" onclick="saveMemo(${first.rowNumber})">メモ保存</button>
                    <button class="clear-btn" onclick="clearMemo(${first.rowNumber})">メモ削除</button>
                    <button class="clear-btn" style="background:#7f8c8d;" onclick="confirmClearHistory(${first.rowNumber}, true)">履歴クリア</button>
                </div>
            </div>
            <button class="save-btn detail-only" style="background:#34495e; width:100%; margin-top:8px;" onclick="confirmShugaEdit(${first.rowNumber}, this)">✏️ 建物情報を編集</button>
            <button class="clear-btn detail-only" style="width:100%; margin-top:6px; background:#9E3B4A;" onclick="confirmDelete(${first.rowNumber})">🗑 このピンを削除</button>
            <button class="detail-toggle" onclick="togglePopupDetail(this)">▼ 詳細を表示</button>
        `;
    }

    // 編集前確認ダイアログ
    function confirmShugaEdit(rowNumber, btn) {
        showShugaEditForm(rowNumber, btn); // 確認ダイアログは廃止（押したら直接編集フォームへ）
    }

    // 集合住宅の建物情報を編集するフォームを表示（詳細表示を差し替え）
    function showShugaEditForm(rowNumber, btn) {
        const item = currentData.find(d => d.rowNumber === rowNumber);
        if (!item) { showToast('編集対象が見つかりません', true); return; }

        const floors = parseInt(item.階数) || 1;
        const maxRoom = parseInt(item.最大部屋番号) || 1;
        // 現在の有効部屋を選択状態に設定
        gridActiveRooms = String(item.有効部屋リスト || '').split(',').map(s => parseInt(s)).filter(n => !isNaN(n));
        gridRoomMark = parseRoomMarks(item.個人宅);

        const lock = getAutolock(item);
        const memoText = cleanMemo(item);

        const opt = (v, label, cur) => `<option value="${v}" ${String(cur) === String(v) ? 'selected' : ''}>${label}</option>`;
        const floorOpts = Array.from({length:30},(_,i)=>i+1).map(v => opt(v, v + 'F', floors)).join('');
        const roomOpts = Array.from({length:20},(_,i)=>i+1).map(v => opt(v, String(v).padStart(2,'0'), maxRoom)).join('');
        // オートロック/構成属性/管理人は coloredSelectHtml で色付き生成（下のHTMLで直接呼ぶ）

        const html = `
            <div class="building-title">✏️ 建物情報を編集</div>
            <div class="form-group"><label>建物名</label><input type="text" id="new-name" value="${escHtml(item['建物名 / 世帯名'] || '')}" style="background:#FFF9DD;"></div>
            <div class="form-row" style="display:flex; gap:4px;">
                <div class="form-group" style="flex:1;"><label>階数</label>
                    <select id="new-floors" class="numlist" size="5" onchange="renderRoomGrid()" style="background:#FFF9DD;">${floorOpts}</select>
                </div>
                <div class="form-group" style="flex:1;"><label>最大部屋数</label>
                    <select id="new-maxroom" class="numlist" size="5" onchange="renderRoomGrid()" style="background:#FFF9DD;">${roomOpts}</select>
                </div>
            </div>
            <div class="form-group" style="margin:2px 0;">
                <label style="display:flex; align-items:center; gap:4px; font-weight:normal; font-size:11px;">
                    <input type="checkbox" id="new-hideroom" style="width:auto;" onchange="renderRoomGrid()" ${String(item.部屋番号非表示) === '1' ? 'checked' : ''}> 部屋番号が不明（番号を表示しない）
                </label>
            </div>
            <label style="font-size:11px; font-weight:bold;">緑=有効。不要な部屋をタップで外す</label>
            <div id="setup-grid-container" style="max-height:120px; overflow:auto; margin-bottom:8px;"></div>
            <div class="inline-group"><label>オートロック</label>${coloredSelectHtml('new-lock', SHUGA_LOCK_OPTS_, lock)}</div>
            <div class="inline-group"><label>構成属性</label>${coloredSelectHtml('new-attribute', SHUGA_ATTR_OPTS_, item.属性)}</div>
            <div class="inline-group"><label>管理人</label>${coloredSelectHtml('new-manager', SHUGA_MGR_OPTS_, item.管理人)}</div>
            <div class="form-group"><label>メモ</label><input type="text" id="new-memo" value="${escHtml(memoText)}"></div>
            <div class="btn-row">
                <button class="submit-btn" id="edit-save-btn" onclick="saveShugaEdit(${rowNumber}, this)">更新を保存</button>
                <button class="clear-btn" onclick="cancelShugaEdit(${rowNumber}, this)">閉じる</button>
            </div>
        `;
        btn.closest('.popup-content').innerHTML = html;
        renderRoomGrid();
        // 編集フォームは縦に長いので、吹き出しが画面に収まるよう寄せ直す
        const opened = currentMarkers.find(mk => { const p = mk.getPopup(); return p && p.isOpen(); });
        if (opened) setTimeout(() => fitPopupInView(opened, 0), 30);
    }

    // 集合住宅の編集内容を保存
    function saveShugaEdit(rowNumber, btn) {
        const name = document.getElementById('new-name').value;
        if (!name) { appAlert('建物名を入力してください'); return; }
        const { floors, maxRoom } = getGridDims();
        // 現在のグリッド範囲内の選択のみを有効として保存
        const valid = gridActiveRooms.filter(rn => Math.floor(rn / 100) <= floors && (rn % 100) <= maxRoom).sort((a, b) => a - b);

        const data = {
            rowNumber: rowNumber,
            name: name,
            floors: floors,
            maxRoomNum: maxRoom,
            validRooms: valid.join(','),
            totalRooms: valid.length,
            manager: document.getElementById('new-manager').value,
            attribute: document.getElementById('new-attribute').value,
            lock: document.getElementById('new-lock').value,
            memo: document.getElementById('new-memo').value,
            hideRoomNum: isHideRoomNum(),
            personalRooms: encodeRoomMarks(gridRoomMark, valid)
        };

        btn.disabled = true; btn.innerText = '保存中...';
        showBusy('更新中…');
        apiCall('updateBuilding', { data: data }).then((latest) => {
            showToast('建物情報を更新しました', false);
            renderMarkers(latest);
        }).catch((err) => {
            btn.disabled = false; btn.innerText = '更新を保存';
            handleServerError(err);
        }).finally(hideBusy);
    }

    // 編集をキャンセルして詳細表示に戻す（更新しない）
    function cancelShugaEdit(rowNumber, btn) {
        const item = currentData.find(d => d.rowNumber === rowNumber);
        const container = btn.closest('.popup-content');
        if (item && container) {
            container.innerHTML = createShugaViewHtml([item]);
            fillDerivedAddress(container);
            // 編集ボタンは詳細表示からのみ押せるため .detail は残っている。
            // 作り直したトグルボタンの表記を実状態（詳細表示中）に合わせる。
            const t = container.querySelector('.detail-toggle');
            if (t && container.classList.contains('detail')) t.textContent = '▲ 詳細を隠す';
        } else {
            closeOpenForms();
        }
    }

    // 部屋未選択時の操作欄プレースホルダ（押した後とおおよそ同じ高さを確保し、レイアウトの変動を抑える）
    function roomActionPlaceholder() {
        return '<div style="min-height:210px; display:flex; align-items:center; justify-content:center; font-size:13px; color:#888; text-align:center;">🚪 部屋をタップして操作してください</div>';
    }

    // 吹き出しを閉じたときに、部屋の選択ハイライトと操作欄を初期状態へ戻す（選択状態を解除）。
    // ※ Mapbox は 'close' 発火前に _container を破棄するため getElement() が null になる。
    //    その場合は破棄されない _content（吹き出し本文）を参照してリセットする。
    function resetRoomActionPanel(popup) {
        if (!popup) return;
        const root = (popup.getElement && popup.getElement()) || popup._content;
        if (!root) return;
        root.querySelectorAll('.cell-operating').forEach(el => el.classList.remove('cell-operating'));
        const area = root.querySelector('#room-action-area');
        if (area) area.innerHTML = roomActionPlaceholder();
    }

    // 吹き出しを閉じたとき、展開していたUIをすべて初期状態へ戻す（次に開くと閉じた状態から始まる）。
    // ①建物編集フォーム→通常表示（編集は破棄） ②詳細表示→簡易 ③属性4択の展開→現在値ボタン ④部屋操作欄→未選択
    function resetPopupView(popup, rowNumber) {
        if (!popup) return;
        const root = (popup.getElement && popup.getElement()) || popup._content;
        if (!root) return;
        // ① 建物/施設の編集フォームを開いたまま閉じた場合は、通常の詳細表示へ作り直す
        if (root.querySelector('#edit-save-btn') || root.querySelector('#fac-edit-save')) {
            const item = currentData.find(d => d.rowNumber === rowNumber);
            const container = root.querySelector('.popup-content');
            if (item && container) {
                container.innerHTML = (item.種別 === '施設') ? createFacilityViewHtml(item) : createShugaViewHtml([item]);
                fillDerivedAddress(container);
            }
        }
        // ② 詳細表示を簡易に戻す
        root.querySelectorAll('.popup-content.detail').forEach(pc => pc.classList.remove('detail'));
        const t = root.querySelector('.detail-toggle');
        if (t) t.textContent = '▼ 詳細を表示';
        // ③ 展開中の属性4択を現在値ボタンへ畳む（保存せず閉じた場合は元の値のまま）
        root.querySelectorAll('.choice-grid[data-tpl]').forEach(grid => {
            const wrap = document.createElement('div');
            wrap.innerHTML = attrLineHtml(grid.dataset.cur || '', grid.dataset.tpl, grid.dataset.room === '1');
            grid.replaceWith(wrap.firstElementChild);
        });
        // ④ 部屋の選択ハイライトと操作欄を初期化
        resetRoomActionPanel(popup);
    }

    function showRoomAction(buildingRow, roomNum, cellEl) {
        // 操作中のセルをハイライト（どこを操作しているか分かるように）
        document.querySelectorAll('.cell-operating').forEach(el => el.classList.remove('cell-operating'));
        if (cellEl) cellEl.classList.add('cell-operating');

        // この部屋の履歴を、建物の履歴データから抽出
        let historyHtml = '';
        const item = currentData.find(d => d.rowNumber === buildingRow);
        if (item && item.履歴データ) {
            try {
                const arr = JSON.parse(item.履歴データ);
                const prefix = roomTag(roomNum); // 部屋＝「○号室」／管理人＝「管理人」。結果も属性ログも接頭辞一致で拾う
                historyHtml = arr.map((h, i) => ({ h, i }))
                    .filter(x => String(x.h.status).indexOf(prefix) === 0)
                    .map(x => {
                        const text = String(x.h.status).slice(prefix.length).replace(/^[:：\s]+/, '').replace(/属性：/g, ''); // 先頭の「○号室」と「属性：」を除去（号室は欄上部に表示済み）
                        return `<div class="hist-row" data-idx="${x.i}" data-time="${escHtml(x.h.time)}" style="border-bottom:1px dashed #eee; display:flex; justify-content:space-between; gap:8px; cursor:pointer;"><span>${escHtml(x.h.time)}</span><b>${escHtml(text)}</b></div>`;
                    }).join('');
            } catch(e){}
        }

        // この部屋の現在値（属性 or 訪問結果）。選択ボタンのハイライトに使う。
        const curRoomVal = roomStatusOf(item, roomNum);

        const hideNum = item && String(item.部屋番号非表示) === '1';
        const title = isMgrKey(roomNum) ? '👤 管理人' : (hideNum ? '🚪 部屋' : `🚪 ${roomNum}号室`);

        // レイアウトは戸建ての詳細と統一（見出し＋選択ボタン）。属性を上、訪問結果を下に。
        const html = `
            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:6px;">
                <span style="font-weight:bold; font-size:12px;">${title}</span>
                ${attrLineHtml(curRoomVal, `saveRoomState(${buildingRow}, ${roomKeyJs(roomNum)}, '%v')`, true)}
            </div>
            <div style="font-weight:bold; font-size:12px; margin:2px 0 4px;">訪問結果</div>
            ${resultChoiceHtml(curRoomVal, `saveRoomStatus(${buildingRow}, ${roomKeyJs(roomNum)}, '%v')`)}
            <div style="font-weight:bold; font-size:14px; margin-top:4px;">部屋の履歴:</div>
            <div class="history-box" style="min-height:46px; max-height:60px; margin-top:2px;">${historyHtml || '<div style="color:#aaa;">履歴なし</div>'}</div>
        `;
        const area = document.getElementById('room-action-area');
        if (area) { area.innerHTML = html; attachHistoryLongPress(area, buildingRow, true, roomNum); }
    }

    // 履歴の日時テキスト（createLogTimestamp_ と同形式 "2026/6/6 (土) 09:05"）を Date と相互変換する
    function formatLogTime(d) {
        const w = ['日','月','火','水','木','金','土'][d.getDay()];
        return `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()} (${w}) ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    }
    function parseLogTime(s) {
        const m = String(s || '').match(/(\d+)\/(\d+)\/(\d+)\D+(\d+):(\d+)/);
        return m ? new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5]) : new Date();
    }
    // 履歴欄(.hist-row)に長押しを割り当てる（タップは無効、長押しで日時編集／削除モーダル）
    function attachHistoryLongPress(rootEl, rn, isRoom, roomNum) {
        if (!rootEl || !rootEl.querySelectorAll) return;
        rootEl.querySelectorAll('.hist-row').forEach(el => {
            if (el._histBound) return;
            el._histBound = true;
            attachLongPress(el, () => {}, () => openHistoryEdit(rn, parseInt(el.dataset.idx), el.dataset.time, isRoom, roomNum));
        });
    }
    // 履歴1件の日時編集／削除モーダル（Esc・枠外で閉じる）
    function openHistoryEdit(rn, idx, curTime, isRoom, roomNum) {
        if (isNaN(idx)) return;
        let ov = document.getElementById('hist-edit-overlay');
        if (!ov) { ov = document.createElement('div'); ov.id = 'hist-edit-overlay'; document.body.appendChild(ov); }
        const d = parseLogTime(curTime), pad = n => String(n).padStart(2, '0');
        const val = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        ov.innerHTML = `<div id="hist-edit-card"><div id="hist-edit-title">履歴の編集</div>`
            + `<label style="font-size:13px; font-weight:bold;">日時</label>`
            + `<input type="datetime-local" id="hist-edit-dt" value="${val}">`
            + `<button id="hist-edit-save" class="submit-btn" style="width:100%; margin-top:12px;">日時を保存</button>`
            + `<button id="hist-edit-del" class="clear-btn" style="width:100%; margin-top:8px;">この履歴を削除</button>`
            + `<button id="hist-edit-cancel" style="width:100%; margin-top:8px; padding:10px; border:1px solid #ccc; border-radius:6px; background:#eef1f4; cursor:pointer;">キャンセル</button></div>`;
        ov.style.display = 'flex';
        const close = () => { ov.style.display = 'none'; document.removeEventListener('keydown', onKey, true); };
        const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
        document.addEventListener('keydown', onKey, true);
        ov.onclick = (e) => { if (e.target === ov) close(); };
        const after = (latest) => {
            applyInPlace(rn, latest); // 戸建て=履歴欄ごと再描画（長押しも付け直す）、集合=吹き出し更新
            if (isRoom) { const cell = document.querySelector(`.cell-active[data-room="${roomNum}"]`); showRoomAction(rn, roomNum, cell); }
        };
        document.getElementById('hist-edit-save').onclick = () => {
            const v = document.getElementById('hist-edit-dt').value;
            if (!v) { showToast('日時を入力してください', true); return; }
            close(); showBusy('更新中…');
            apiCall('editHistory', { rowNumber: rn, index: idx, op: 'time', newTime: formatLogTime(new Date(v)) })
                .then(latest => { showToast('履歴を更新しました', false); after(latest); })
                .catch(handleServerError).finally(hideBusy);
        };
        document.getElementById('hist-edit-del').onclick = () => {
            close();
            appConfirm('この履歴を削除しますか？', { okLabel: '削除', danger: true }).then(ok => {
                if (!ok) return;
                showBusy('削除中…');
                apiCall('editHistory', { rowNumber: rn, index: idx, op: 'delete' })
                    .then(latest => { showToast('履歴を削除しました', false); after(latest); })
                    .catch(handleServerError).finally(hideBusy);
            });
        };
        document.getElementById('hist-edit-cancel').onclick = close;
    }

    // 「不在」を選ぶと不在回数を1つ繰り上げる（上限なし）。
    // 直前が不在以外（会えた/投函/属性/未訪問）なら一致せず「不在(1回目)」に戻る＝リセット。
    function nextAbsence(current) {
        const m = String(current || '').match(/不在\((\d+)回目\)/);
        const n = m ? parseInt(m[1], 10) + 1 : 1;
        return '不在(' + n + '回目)';
    }

    // 部屋の現在値（T列の部屋ステータスJSON）を安全に取り出す共通ヘルパー
    function roomStatusOf(item, roomNum) {
        try { return (JSON.parse((item && item.部屋ステータス) || '{}') || {})[roomNum] || ''; } catch (e) { return ''; }
    }

    // サーバー更新後の最新データを、ポップアップを閉じずにその場で反映する（種別を自動判別）。
    // 集合住宅は refreshShugaPopup、戸建ては applyKodateChange に委譲して挙動を統一する。
    function applyInPlace(rowNumber, latest) {
        const item = (latest || []).find(d => d.rowNumber === rowNumber);
        if (item && item.種別 === '集合住宅') refreshShugaPopup(rowNumber, latest);
        else if (item && item.種別 === '施設') refreshFacilityPopup(rowNumber, latest);
        else applyKodateChange(rowNumber)(latest);
    }

    // 戸建ての更新を、ポップアップを閉じずにマーカーの色・吹き出し内容だけ最新化する。
    function applyKodateChange(rowNumber) {
        return (latest) => {
            currentData = latest;
            saveDataCache(currentData); // インプレース更新でもキャッシュを最新化（次回起動の先行表示で旧状態が一瞬出るのを防ぐ）
            const item = currentData.find(d => d.rowNumber === rowNumber);
            const marker = currentMarkers.find(m => m._rowNumber === rowNumber);
            const popup = marker ? marker.getPopup() : null;
            // 同一座標に複数世帯（ページャ付き吹き出し）のマーカーは、ページャを保つため全再描画に委ねる
            const isGroup = !!(marker && marker._rowNumbers && marker._rowNumbers.length > 1);
            if (item && marker && popup && !isGroup) {
                styleKodateMarker(marker.getElement(), item); // ピンの色・形を更新
                applyZoomScale();                             // ☆⇔○でサイズが変わるため再調整
                popup.setHTML('<div class="popup-content">' + createKodedateViewHtml(item) + '</div>');
                fillDerivedAddress(popup.getElement());
                attachHistoryLongPress(popup.getElement(), rowNumber, false); // 履歴欄を作り直したので長押しを付け直す
                bindTitleCopy(popup.getElement(), rowNumber); // タイトル長押し（情報コピー）も付け直す
                setTimeout(() => fitPopupInView(marker, 0), 30); // 編集後、ピンを画面中央の少し下へ戻す（詳細表示で縦長→下に出る対策）
            } else {
                renderMarkers(latest); // フォールバック
            }
        };
    }

    // ── 楽観的更新の共通エンジン ──
    // key 単位（戸建て=行番号 / 集合住宅=建物行番号）で直列キュー（chain）を持ち、UIは即時・保存は裏で順送りする。
    //   fns.snapshot()      : 一連の最初の1回だけ呼ばれ、開始前状態を返す（失敗時のロールバック先）。
    //   fns.apply()         : 毎回呼ばれ、currentData を楽観的に書き換えて即UI反映する。
    //   fns.send()          : Promise<latest>（サーバー送信）。
    //   fns.reconcile(src)  : 正データ src（getMapData の戻り）で確定描画する。
    //   fns.restore(snap)   : 失敗かつ一度も成功していない時に、開始前状態へ戻す。
    //   fns.onSuccess()     : 全送信が正常完了した時だけ呼ばれる（成功トースト）。
    // 1件でも失敗したら gen を進めて以降のキューを無効化し、直前に成功した正データ（無ければ snapshot）へ戻す。
    const _optState = {};
    function enqueueOptimistic(key, fns) {
        const st = _optState[key] || (_optState[key] = { gen: 0, pending: 0, chain: Promise.resolve() });
        if (st.pending === 0) { st.snap = fns.snapshot(); st.lastGood = null; } // 開始前状態を退避（楽観反映の前に）
        fns.apply(); // 楽観反映（即UI）
        const myGen = st.gen;
        st.pending++;
        showSaving();
        st.chain = st.chain.then(() => {
            if (st.gen !== myGen) { hideSaving(); return; } // 先行操作が失敗→無効化済み：送信しない
            return fns.send()
                .then((latest) => {
                    hideSaving();
                    if (st.gen !== myGen) return;
                    st.lastGood = latest;   // 直前に成功した正データ（途中失敗時のロールバック先）
                    st.pending--;
                    if (st.pending === 0) { fns.reconcile(latest); fns.onSuccess(); } // 全送信完了 → 確定＋成功通知
                })
                .catch((err) => {
                    hideSaving();
                    if (st.gen !== myGen) return;
                    st.gen++;               // 以降のキューを全て無効化
                    st.pending = 0;
                    if (st.lastGood) fns.reconcile(st.lastGood); // 直前の成功分は保持してそこへ（成功トーストは出さない）
                    else fns.restore(st.snap);                   // まだ1件も成功していない → 開始前へ
                    handleServerError(err); // 通知＋認証時はログイン誘導
                });
        });
    }

    // 楽観反映用：履歴JSONの先頭に暫定エントリ（時刻は「…」、サーバー応答で正式な時刻に置き換わる）を積む。
    function addProvisionalHistory(historyJson, status) {
        let arr = [];
        try { arr = JSON.parse(historyJson || '[]') || []; } catch (e) { arr = []; }
        arr.unshift({ status: status, time: '…', user: '' });
        return JSON.stringify(arr);
    }

    // currentData の該当行だけを source（getMapData の戻り）の同じ行で差し替え、その場再描画する。
    // 全件置換にしないのは、別の行で飛んでいる楽観更新を巻き戻さないため。
    function reconcileKodate(rowNumber, source) {
        const i = currentData.findIndex(d => d.rowNumber === rowNumber);
        const src = source ? source.find(d => d.rowNumber === rowNumber) : null;
        if (i >= 0 && src) { currentData[i] = src; applyKodateChange(rowNumber)(currentData); }
        else { applyKodateChange(rowNumber)(source || currentData); } // 行が消えた等のフォールバック
    }

    // 戸建ての訪問結果。タップ即反映 → 裏で保存 → 失敗で巻き戻し（共通エンジンに乗せる）。
    function saveStatus(rowNumber, val) {
        if (!val) return;
        const idx = currentData.findIndex(d => d.rowNumber === rowNumber);
        if (idx < 0) return;
        // 「不在」は現在値（楽観反映済みなら最新値）から繰り上げ＝連打で 1→2→3 と進む。それ以外は同値なら再送スキップ。
        let status = val;
        if (val === '不在') status = nextAbsence(currentData[idx].最新ステータス);
        else if (currentData[idx].最新ステータス === status) return;

        enqueueOptimistic(rowNumber, {
            snapshot: () => { const it = currentData.find(d => d.rowNumber === rowNumber); return { 最新ステータス: it.最新ステータス, 履歴データ: it.履歴データ }; },
            apply: () => {
                const i = currentData.findIndex(d => d.rowNumber === rowNumber);
                currentData[i] = Object.assign({}, currentData[i], {
                    最新ステータス: status,
                    履歴データ: addProvisionalHistory(currentData[i].履歴データ, status)
                });
                applyKodateChange(rowNumber)(currentData);
            },
            send: () => apiCall('updateLocation', { rowNumber: rowNumber, status: status, memoText: null, isClearMemo: false }),
            reconcile: (latest) => reconcileKodate(rowNumber, latest),
            restore: (snap) => { const i = currentData.findIndex(d => d.rowNumber === rowNumber); if (i >= 0) { currentData[i] = Object.assign({}, currentData[i], snap); applyKodateChange(rowNumber)(currentData); } },
            onSuccess: () => showDone('訪問結果を記録しました')
        });
    }

    // 集合住宅の楽観反映用：部屋履歴の暫定エントリ。prefix「○号室」付きなので showRoomAction の履歴欄に出る。
    function addRoomProvisionalHistory(historyJson, roomNum, status) {
        let arr = [];
        try { arr = JSON.parse(historyJson || '[]') || []; } catch (e) { arr = []; }
        arr.unshift({ status: roomTag(roomNum) + ': ' + status, time: '…', user: '' });
        return JSON.stringify(arr);
    }

    // currentData の現在値で、集合住宅の吹き出し＋指定部屋の操作欄をその場再描画する（applyRoomChange の描画部分を分離）。
    function renderShugaRoom(buildingRow, roomNum) {
        saveDataCache(currentData); // 部屋ステータス変更でもキャッシュを最新化（次回起動の先行表示で旧色が一瞬出るのを防ぐ）
        const item = currentData.find(d => d.rowNumber === buildingRow);
        const marker = currentMarkers.find(m => m._rowNumber === buildingRow);
        const popup = marker ? marker.getPopup() : null;
        if (item && popup) {
            popup.setHTML('<div class="popup-content">' + createShugaViewHtml([item]) + '</div>');
            const root = popup.getElement();
            fillDerivedAddress(root);
            bindRoomCopyCells(root, buildingRow); // グリッドを作り直したので部屋長押し（情報コピー）を付け直す
            const newCell = root ? root.querySelector(`[data-room="${roomNum}"]`) : null;
            showRoomAction(buildingRow, roomNum, newCell); // 操作欄を開き直し履歴も更新
            setTimeout(() => fitPopupInView(marker, 0), 30); // 編集後、ピンを画面中央の少し下へ戻す
        } else {
            renderMarkers(currentData); // フォールバック
        }
    }

    // 該当建物行を source の同じ行で差し替えてから再描画する（他行の楽観更新を壊さない）。
    function reconcileShugaRoom(buildingRow, roomNum, source) {
        const i = currentData.findIndex(d => d.rowNumber === buildingRow);
        const src = source ? source.find(d => d.rowNumber === buildingRow) : null;
        if (i >= 0 && src) currentData[i] = src;
        renderShugaRoom(buildingRow, roomNum);
    }

    // 部屋の更新（訪問結果・属性 共通）。ポップアップを閉じず、グリッドの色・履歴を楽観的に即反映する。
    function applyRoomChange(buildingRow, roomNum, finalStatus, addHistory) {
        const idx = currentData.findIndex(d => d.rowNumber === buildingRow);
        if (idx < 0) return;
        if (roomStatusOf(currentData[idx], roomNum) === finalStatus) return; // 同値スキップ（不在は繰り上げ済みで一致しない）

        enqueueOptimistic(buildingRow, { // 建物行単位で直列化（同一建物の履歴順序を保証）
            snapshot: () => { const it = currentData.find(d => d.rowNumber === buildingRow); return { 部屋ステータス: it.部屋ステータス, 最新ステータス: it.最新ステータス, 履歴データ: it.履歴データ }; },
            apply: () => {
                const i = currentData.findIndex(d => d.rowNumber === buildingRow);
                const it = currentData[i];
                let rsMap = {}; try { rsMap = JSON.parse(it.部屋ステータス || '{}') || {}; } catch (e) {}
                rsMap[String(roomNum)] = finalStatus;
                const patch = { 部屋ステータス: JSON.stringify(rsMap), 最新ステータス: roomTag(roomNum) + ': ' + finalStatus };
                if (addHistory) patch.履歴データ = addRoomProvisionalHistory(it.履歴データ, roomNum, finalStatus);
                currentData[i] = Object.assign({}, it, patch);
                renderShugaRoom(buildingRow, roomNum);
            },
            send: () => apiCall('updateRoom', { buildingRow: buildingRow, roomNum: roomNum, status: finalStatus, addHistory: addHistory }),
            reconcile: (latest) => reconcileShugaRoom(buildingRow, roomNum, latest),
            restore: (snap) => { const i = currentData.findIndex(d => d.rowNumber === buildingRow); if (i >= 0) { currentData[i] = Object.assign({}, currentData[i], snap); renderShugaRoom(buildingRow, roomNum); } },
            onSuccess: () => showDone('更新しました')
        });
    }

    function saveRoomStatus(buildingRow, roomNum, val) {
        if(!val) return;
        let status = val;
        if (val === '不在') {
            const item = currentData.find(d => d.rowNumber === buildingRow);
            status = nextAbsence(roomStatusOf(item, roomNum));
        }
        applyRoomChange(buildingRow, roomNum, status, true);
    }

    // 戸建ての属性（通常/訪問拒否/外国語/空き家）。タップ即反映（ピン形・色も変わる）→ 裏で保存 → 失敗で巻き戻し。
    function saveAttribute(rowNumber, attribute) {
        if (!attribute) return;
        const idx = currentData.findIndex(d => d.rowNumber === rowNumber);
        if (idx < 0) return;
        if (currentData[idx].属性 === attribute) return; // 同値スキップ

        enqueueOptimistic(rowNumber, {
            snapshot: () => { const it = currentData.find(d => d.rowNumber === rowNumber); return { 属性: it.属性, 履歴データ: it.履歴データ }; },
            apply: () => {
                const i = currentData.findIndex(d => d.rowNumber === rowNumber);
                currentData[i] = Object.assign({}, currentData[i], {
                    属性: attribute,
                    履歴データ: addProvisionalHistory(currentData[i].履歴データ, '属性：' + attribute) // 暫定。応答で「属性：旧→新」に確定
                });
                applyKodateChange(rowNumber)(currentData);
            },
            send: () => apiCall('updateLocation', { rowNumber: rowNumber, status: null, memoText: null, isClearMemo: false, addHistory: true, attribute: attribute }),
            reconcile: (latest) => reconcileKodate(rowNumber, latest),
            restore: (snap) => { const i = currentData.findIndex(d => d.rowNumber === rowNumber); if (i >= 0) { currentData[i] = Object.assign({}, currentData[i], snap); applyKodateChange(rowNumber)(currentData); } },
            onSuccess: () => showDone('属性を更新しました')
        });
    }

    // 部屋の属性（訪問可/訪問拒否/外国語/空き家）の更新。操作ログも履歴に残す（addHistory=true）。
    function saveRoomState(buildingRow, roomNum, state) {
        if(!state) return;
        applyRoomChange(buildingRow, roomNum, state, true);
    }

    // ピン（地点）の削除。実行前に必ず確認する
    function confirmDelete(rowNumber) {
        appConfirm("このピンを削除します。\n登録内容・履歴もすべて消え、元に戻せません。", { okLabel: '削除する', danger: true }).then(ok => {
            if (!ok) return;
            showBusy('更新中…');
            apiCall('deleteLocation', { rowNumber: rowNumber })
                .then((latest) => { showToast('削除しました', false); renderMarkers(latest); })
                .catch(handleServerError).finally(hideBusy);
        });
    }

    function saveMemo(rowNumber) {
        const txt = document.getElementById(`memo-${rowNumber}`).value;
        showBusy('更新中…');
        apiCall('updateLocation', { rowNumber: rowNumber, status: null, memoText: txt, isClearMemo: false })
            .then((latest) => { applyInPlace(rowNumber, latest); showToast('メモを保存しました', false); })
            .catch(handleServerError).finally(hideBusy);
    }

    function clearMemo(rowNumber) {
        appConfirm("メモをクリアしますか？", { okLabel: 'クリアする', danger: true }).then(ok => {
            if (!ok) return;
            showBusy('更新中…');
            apiCall('updateLocation', { rowNumber: rowNumber, status: null, memoText: null, isClearMemo: true })
                .then((latest) => { applyInPlace(rowNumber, latest); showToast('メモを削除しました', false); })
                .catch(handleServerError).finally(hideBusy);
        });
    }

    // 集合住宅の吹き出しを、閉じずにその場で最新化する（履歴クリア後などに使用）
    function refreshShugaPopup(buildingRow, latest) {
        currentData = latest;
        saveDataCache(currentData); // インプレース更新でもキャッシュを最新化（次回起動の先行表示で旧状態が一瞬出るのを防ぐ）
        const item = currentData.find(d => d.rowNumber === buildingRow);
        const marker = currentMarkers.find(m => m._rowNumber === buildingRow);
        const popup = marker ? marker.getPopup() : null;
        if (item && popup) {
            popup.setHTML('<div class="popup-content">' + createShugaViewHtml([item]) + '</div>');
            fillDerivedAddress(popup.getElement());
            bindRoomCopyCells(popup.getElement(), buildingRow); // 部屋長押し（情報コピー）を付け直す
            setTimeout(() => fitPopupInView(marker, 0), 30); // 編集後、ピンを画面中央の少し下へ戻す
        } else {
            renderMarkers(latest);
        }
    }

    // ── 情報コピー（住所・最新履歴・アプリリンク・地図リンクを選んでクリップボードへ） ──
    // 吹き出しから 戸建て=「戸建て」長押し / 集合住宅=部屋番号長押し で openInfoCopyMenu を開く。
    function effectiveAddress_(item) {
        return (item.住所 && item.住所 !== '-' && String(item.住所).trim() !== '') ? String(item.住所).trim()
            : (deriveAddress(parseFloat(item.経度), parseFloat(item.緯度)) || '');
    }
    // 履歴を新しい順の配列で返す（戸建て=全件 / 集合住宅=その部屋の '○号室' 一致のみ。各要素は「日時 結果」）
    function histRecords_(item, roomNum) {
        if (!item || !item.履歴データ) return [];
        let arr; try { arr = JSON.parse(item.履歴データ); } catch (e) { return []; }
        if (!Array.isArray(arr)) return [];
        if (roomNum != null && roomNum !== '') { // 数値部屋＋管理人キーは部屋単位で抽出（戸建て=null は建物全体）
            const prefix = roomTag(roomNum);
            return arr.filter(h => String(h.status).indexOf(prefix) === 0)
                      .map(h => ((h.time || '') + ' ' + String(h.status).slice(prefix.length).replace(/^[:：\s]+/, '').replace(/属性：/g, '')).trim());
        }
        return arr.map(h => ((h.time || '') + ' ' + String(h.status || '').replace(/属性：/g, '')).trim());
    }
    let infoCopyCtx = null; // 現在開いているコピー対象の {addr,hist,app,map}
    function openInfoCopyMenu(rowNumber, roomNum) {
        const item = currentData.find(d => d.rowNumber === rowNumber);
        if (!item) { showToast('情報が見つかりませんでした', true); return; }
        const lat = parseFloat(item.緯度), lng = parseFloat(item.経度);
        let addr = effectiveAddress_(item);
        if (roomNum != null) addr = (addr ? addr + ' ' : '') + roomTag(roomNum); // 部屋＝「○号室」／管理人＝「管理人」
        infoCopyCtx = {
            addr: addr,
            histList: histRecords_(item, roomNum),
            app: location.origin + location.pathname + '?pin=' + rowNumber,
            map: (!isNaN(lat) && !isNaN(lng)) ? ('https://www.google.com/maps/search/?api=1&query=' + lat + ',' + lng) : ''
        };
        const f = infoCopyCtx;
        const rowOpt = (key, label, val) => val ? `<label class="copy-opt"><input type="checkbox" data-ck="${key}" checked><span><span class="co-label">${escHtml(label)}</span><br><span class="co-val">${escHtml(val)}</span></span></label>` : '';
        let html = `<div style="font-size:12px; color:#666; margin-bottom:8px;">コピーする項目を選んで「コピー」を押してください。</div>`;
        html += rowOpt('addr', roomNum != null ? '住所・部屋番号' : '住所', f.addr);
        if (f.histList.length) {
            html += `<div class="copy-opt" style="cursor:default;"><input type="checkbox" data-ck="hist" checked>`
                + `<span style="flex:1;"><span class="co-label">履歴</span>`
                + `<span style="font-size:12px; margin-left:10px; white-space:nowrap;">`
                + `<label style="cursor:pointer;"><input type="radio" name="hist-mode" value="latest" checked onchange="updateHistPreview('latest')" style="width:14px; height:14px; margin:0 3px 0 0; vertical-align:middle;"> 最新</label>`
                + `<label style="cursor:pointer; margin-left:12px;"><input type="radio" name="hist-mode" value="all" onchange="updateHistPreview('all')" style="width:14px; height:14px; margin:0 3px 0 0; vertical-align:middle;"> 全部(${f.histList.length}件)</label>`
                + `</span><br><span class="co-val" id="hist-preview">${escHtml(f.histList[0])}</span></span></div>`;
        }
        html += rowOpt('app', 'アプリのリンク', f.app);
        html += rowOpt('map', 'Googleマップのリンク', f.map);
        if (!f.addr && !f.histList.length && !f.map) html += `<div style="color:#aaa; font-size:12px;">コピーできる情報がありません。</div>`;
        else html += `<button class="save-btn" style="width:100%; margin-top:8px;" onclick="doInfoCopy()">📋 選んだ項目をコピー</button>`;
        document.getElementById('info-copy-body').innerHTML = html;
        document.getElementById('info-copy-modal').style.display = 'flex';
    }
    function closeInfoCopy() {
        document.getElementById('info-copy-modal').style.display = 'none';
        infoCopyCtx = null;
    }
    function doInfoCopy() {
        if (!infoCopyCtx) return;
        const f = infoCopyCtx;
        const isOn = k => { const cb = document.querySelector('#info-copy-body input[data-ck="' + k + '"]'); return cb && cb.checked; };
        const lines = [];
        if (isOn('addr') && f.addr) lines.push(f.addr); // 住所は値のみ（ラベル文字は付けない）
        if (isOn('hist') && f.histList && f.histList.length) {
            const m = document.querySelector('#info-copy-body input[name="hist-mode"]:checked');
            lines.push((m && m.value === 'all') ? f.histList.join('\n') : f.histList[0]); // 履歴も値のみ（最新 or 全部）
        }
        if (isOn('app') && f.app) lines.push('■アプリのリンク\n' + f.app);   // リンクは見出し＋改行＋URL
        if (isOn('map') && f.map) lines.push('■Googleマップのリンク\n' + f.map);
        if (!lines.length) { showToast('項目が選ばれていません', true); return; }
        copyTextToClipboard_(lines.join('\n'))
            .then(() => { closeInfoCopy(); showToast('コピーしました', false); })
            .catch(() => { showToast('コピーに失敗しました', true); });
    }
    // 履歴の最新/全部 切替時にプレビュー表示を更新
    function updateHistPreview(mode) {
        const el = document.getElementById('hist-preview');
        if (!el || !infoCopyCtx) return;
        const list = infoCopyCtx.histList || [];
        el.textContent = !list.length ? '履歴なし' : (mode === 'all' ? (list.length + '件すべて') : list[0]);
    }
    function copyTextToClipboard_(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
        return new Promise((resolve, reject) => {
            const ta = document.createElement('textarea');
            try {
                ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px'; ta.style.opacity = '0';
                document.body.appendChild(ta); ta.focus(); ta.select();
                document.execCommand('copy') ? resolve() : reject();
            } catch (e) { reject(e); } finally { if (ta.parentNode) ta.parentNode.removeChild(ta); }
        });
    }
    // 戸建て: タイトル「戸建て」長押しで情報コピー。集合住宅: 部屋セル タップ=操作欄 / 長押し=情報コピー。
    function bindTitleCopy(popupEl, rowNumber) {
        if (!popupEl) return;
        const t = popupEl.querySelector('.building-title');
        if (t) attachLongPress(t, () => {}, () => openInfoCopyMenu(rowNumber, null));
    }
    function bindRoomCopyCells(popupEl, rowNumber) {
        if (!popupEl) return;
        popupEl.querySelectorAll('td.cell-active[data-room]').forEach(cell => {
            const raw = cell.getAttribute('data-room');
            const rn = /^\d+$/.test(raw) ? parseInt(raw) : raw; // 管理人など非数値キーは文字列のまま
            attachLongPress(cell, () => showRoomAction(rowNumber, rn, cell), () => openInfoCopyMenu(rowNumber, rn));
        });
    }

    // 履歴欄(R列)をすべてクリアする。削除と同様に実行前に必ず確認する。
    function confirmClearHistory(rowNumber, isShuga) {
        appConfirm("この地点の履歴欄をすべてクリアします。\n元に戻せません。", { okLabel: 'クリアする', danger: true }).then(ok => {
            if (!ok) return;
            showBusy('更新中…');
            apiCall('clearHistory', { rowNumber: rowNumber }).then((latest) => {
                applyInPlace(rowNumber, latest); // 種別は自動判別（戸建て/集合住宅で共通）
                showToast('履歴欄をクリアしました', false);
            }).catch(handleServerError).finally(hideBusy);
        });
    }
