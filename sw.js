/* visit-map PWA Service Worker
   目的: Android Chrome で「ホーム画面に追加」を WebAPK（本物のアプリ＝専用ウィンドウ起動・
         毎回の「Chromeで開きますか？」確認なし）として成立させるための最小実装。
         Chrome のインストール条件は「fetch イベントハンドラを持つ Service Worker」なので、
         ハンドラを“持つだけ”で満たせる。
   方針: 何もキャッシュしない。fetch では respondWith を呼ばず、ブラウザ既定のネットワーク取得に
         そのまま委ねる。これにより「直したのに反映されない」というキャッシュ起因の不具合を避ける
         （index.html 側に元からあった「SW はキャッシュ干渉のため入れない」という設計意図を踏襲）。 */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function () { /* no-op: 既定のネットワーク取得に委ねる（キャッシュしない） */ });
