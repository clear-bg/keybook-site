// Service Worker（docs/design.md 4.14）：オフラインでも閲覧ページを開けるようにする
// - ページのファイルは、バージョンごとのキャッシュに入れておき、キャッシュを優先する
// - HTML と songs.json は、キャッシュを先に返し、裏でネットから取り直す（songs.json が変わればページに知らせる）
// 9524eef12e はビルドで内容のハッシュに置き換わる。中身が変わるのでブラウザが新しい Service Worker を入れる

const VERSION = "9524eef12e";
const ASSET_CACHE_PREFIX = "keybook-assets-";
const ASSET_CACHE = ASSET_CACHE_PREFIX + VERSION;
const DATA_CACHE = "keybook-data";

const SCOPE = self.registration.scope;
const HTML_URL = SCOPE;
const SONGS_URL = new URL("songs.json", SCOPE).href;

// ページのファイル（?v= 付きの URL は中身が変わらない）
const ASSETS = [
  ...["app.js", "style.css", "list.js", "keycalc.js"].map((name) => `${name}?v=${VERSION}`),
  "manifest.webmanifest", "icon.svg", "favicon-32.png", "apple-touch-icon.png", "icon-192.png", "icon-512.png",
].map((path) => new URL(path, SCOPE).href);

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const assets = await caches.open(ASSET_CACHE);
    await assets.addAll(ASSETS.map((url) => new Request(url, { cache: "reload" })));
    // このバージョンの HTML も入れ直す（古い HTML が、消した古いページのファイルを指したままにならないように）
    const data = await caches.open(DATA_CACHE);
    for (const url of [HTML_URL, `${SONGS_URL}?v=${VERSION}`]) {
      const res = await fetch(url, { cache: "no-cache" });
      if (!res.ok) {
        throw new Error(`取得できません: ${url}（${res.status}）`);
      }
      await data.put(url === HTML_URL ? HTML_URL : SONGS_URL, res);
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(ASSET_CACHE_PREFIX) && name !== ASSET_CACHE) {
        await caches.delete(name);
      }
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const handled = route(event.request);
  if (handled) {
    event.respondWith(handled.response);
    if (handled.background) {
      event.waitUntil(handled.background);
    }
  }
});

/** 扱うリクエストなら { response, background } を返す。扱わないなら null（ブラウザに任せる） */
function route(request) {
  if (request.method !== "GET" || !request.url.startsWith(SCOPE)) {
    return null;
  }
  const url = new URL(request.url);
  const path = url.origin + url.pathname;
  if (request.mode === "navigate" && (path === HTML_URL || path === `${HTML_URL}index.html`)) {
    // index.html や ?q= 付きで開いても、同じ1つの HTML として扱う
    return staleWhileRevalidate(HTML_URL, HTML_URL, false);
  }
  if (path === SONGS_URL) {
    // 古い HTML から古い ?v= で呼ばれても、同じ1つの songs.json として扱う
    return staleWhileRevalidate(SONGS_URL, request.url, true);
  }
  return { response: cacheFirst(request) };
}

/** キャッシュがあればすぐ返し、裏でネットから取り直してキャッシュを更新する */
function staleWhileRevalidate(key, url, notifyChange) {
  const cachePromise = caches.open(DATA_CACHE);
  const cachedPromise = cachePromise.then((cache) => cache.match(key));
  const networkPromise = fetch(url, { cache: "no-cache" });
  // 元の Response は読まずに残し、ページへは複製を渡す（裏の処理で中身を比べるため）
  const response = cachedPromise.then((cached) => cached?.clone() ?? networkPromise.then((res) => res.clone()));
  const background = (async () => {
    const [cache, cached, res] = await Promise.all([cachePromise, cachedPromise, networkPromise]);
    if (!res.ok) {
      return; // エラーの応答はキャッシュに入れない
    }
    const changed = notifyChange && cached !== undefined && (await cached.clone().text()) !== (await res.clone().text());
    await cache.put(key, res.clone());
    if (changed) {
      for (const client of await self.clients.matchAll({ type: "window" })) {
        client.postMessage({ type: "songs-updated" });
      }
    }
  })().catch(() => {}); // 圏外などで取り直せなくても、キャッシュを返していれば十分
  return { response, background };
}

/** キャッシュにあればそれを、なければネットから返す */
async function cacheFirst(request) {
  const cache = await caches.open(ASSET_CACHE);
  return (await cache.match(request.url)) ?? fetch(request);
}
