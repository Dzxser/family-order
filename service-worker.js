/* Service Worker — 缓存核心静态资源 + 离线访问 */
const CACHE_NAME = 'family-order-v3';
const STATIC = [
  './',
  './order.html',
  './manifest.json'
];

// 安装：缓存静态资源
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(STATIC))
  );
  self.skipWaiting();
});

// 激活：清旧缓存
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// 拦截：静态资源走缓存优先，API / socket 走网络
self.addEventListener('fetch', (e) => {
  const url = e.request.url;
  // API 请求不缓存（要实时数据）
  if(url.includes('/api/') || url.includes('/socket.io')) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      // 有缓存直接返回
      if(cached) return cached;
      // 没缓存走网络
      return fetch(e.request).then(res => {
        // 成功的 GET 请求存缓存
        if(res.ok && e.request.method === 'GET'){
          const copy = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() => {
        // 网络也挂了，返回 order.html 当 fallback
        return caches.match('./order.html');
      });
    })
  );
});
