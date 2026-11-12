// Kanka Chat service worker: uygulama kabuğunu önbellekte tutar, çevrimdışıyken de açılır
const CACHE = 'kanka-v34';
const SHELL = ['/', '/manifest.json', '/icon-192.png', '/icon-512.png', '/favicon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/socket.io')) return;
  if (u.pathname.startsWith('/uploads/')) { // resimler: önce önbellek
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => { const c = res.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); return res; })));
    return;
  }
  e.respondWith(fetch(e.request).then(res => { // diğerleri: önce ağ, olmazsa önbellek
    if (res.ok) { const c = res.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); }
    return res;
  }).catch(() => caches.match(e.request).then(r => r || caches.match('/'))));
});
// Telefona bildirim: uygulama kapalıyken sunucudan gelir
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data?.text() }; }
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    if (cs.some(c => c.visibilityState === 'visible' && c.focused)) return; // zaten bakıyor
    return self.registration.showNotification(d.title || 'Kanka Chat', {
      body: d.body || '', icon: '/icon-192.png', badge: '/icon-192.png', tag: d.tag || 'kanka', renotify: true,
      data: { ch: d.ch || null, from: d.from || null, dm: !!d.dm, friend: !!d.friend }, vibrate: [80, 40, 80] });
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const d = e.notification.data || {}, q = d.friend ? '?ac=arkadaslar' : d.ch ? `?ac=${encodeURIComponent(d.ch)}${d.from ? '&kim=' + encodeURIComponent(d.from) : ''}` : '';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    const c = cs[0];
    if (c) { c.postMessage({ kankaOpen: d }); return c.focus(); }
    return self.clients.openWindow('/' + q);
  }));
});
