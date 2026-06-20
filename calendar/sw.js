/* 奉仕予定カレンダー PWA Service Worker（visit-map 本体と同方針の最小実装）
   目的: Android Chrome で「ホーム画面に追加」を WebAPK（専用ウィンドウ起動・毎回の
         「Chromeで開きますか？」確認なし）として成立させる。Chrome のインストール条件は
         「fetch イベントハンドラを持つ Service Worker」なので、ハンドラを“持つだけ”で満たす。
   方針: 何もキャッシュしない。fetch では respondWith を呼ばず既定のネットワーク取得に委ねる
         （「直したのに反映されない」というキャッシュ起因の不具合を避ける）。
   スコープ: このファイルは /calendar/ 配下に置くため、SW のスコープも /calendar/ に限定され、
            visit-map 本体（親フォルダ）の挙動には干渉しない。 */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function () { /* no-op: 既定のネットワーク取得に委ねる（キャッシュしない） */ });
