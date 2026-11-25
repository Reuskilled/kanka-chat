// Kanka Chat service worker: uygulama kabuğunu önbellekte tutar, çevrimdışıyken de açılır
const CACHE = 'kanka-v203';
const SHELL = ['/app', '/manifest.json', '/icon-192.png', '/icon-512.png', '/favicon.png'];
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
  }).catch(() => caches.match(e.request).then(r => r || (e.request.mode === 'navigate' ? caches.match('/app') : undefined))));
});
// Telefona bildirim: uygulama kapalıyken sunucudan gelir
// Uçtan uca şifreli mesaj: sunucu içeriği bilmez; önizleme bu cihazda kayıtlı sohbet anahtarıyla burada açılır
const b64d = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
function ckOf(key) { return new Promise(res => { try { const r = indexedDB.open('kanka-e2e', 1); r.onupgradeneeded = () => r.result.createObjectStore('k');
  r.onsuccess = () => { try { const q = r.result.transaction('k').objectStore('k').get(key); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); } catch { res(null); } }; r.onerror = () => res(null); } catch { res(null); } }); }
async function e2ePeek(d) {
  try {
    const raw = await ckOf('ck:' + d.ch + '|' + d.e.enc.ep); if (!raw) return null;
    const te = new TextEncoder(), C = crypto.subtle, key = await C.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
    const o = JSON.parse(new TextDecoder().decode(await C.decrypt({ name: 'AES-GCM', iv: b64d(d.e.enc.iv), additionalData: te.encode(d.e.cid || d.ch) }, key, b64d(d.e.enc.ct))));
    const hk = await C.importKey('raw', b64d(o.fk), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const fc = btoa(String.fromCharCode(...new Uint8Array(await C.sign('HMAC', hk, te.encode(o.p))))), x = JSON.parse(o.p);
    if (fc !== d.e.fc || x.a !== d.from) return null;
    return (typeof x.t === 'string' && x.t.trim() ? x.t : x.g ? 'GIF gönderdi' : x.au ? '🎤 Ses mesajı' : Array.isArray(x.f) && x.f.length ? '📎 Dosya gönderdi' : null)?.slice(0, 160) || null;
  } catch { return null; }
}
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data?.text() }; }
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async cs => {
    if (!d.test && cs.some(c => c.visibilityState === 'visible' && c.focused)) return; // zaten bakıyor (deneme bildirimi her zaman görünür)
    if (d.e?.enc && d.ch) d.body = await e2ePeek(d) || d.body;
    return self.registration.showNotification(d.title || 'Kanka Chat', {
      body: d.body || '', icon: '/icon-192.png', badge: '/icon-192.png', tag: d.tag || 'kanka', renotify: true,
      data: { ch: d.ch || null, from: d.from || null, dm: !!d.dm, friend: !!d.friend }, vibrate: [80, 40, 80] });
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const d = e.notification.data || {}, q = d.friend ? '?ac=arkadaslar' : d.ch ? `?ac=${encodeURIComponent(d.ch)}${d.from ? '&kim=' + encodeURIComponent(d.from) : ''}` : '';
  // Açık Kanka sekmesi varsa yenisini açma: o sekmeyi öne getir ve sohbeti orada aç
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async cs => {
    cs = cs.filter(c => { const u = new URL(c.url); return u.origin === self.location.origin && u.pathname === '/app'; }); // tanıtım sayfası sekmesi sohbet açamaz
    const c = cs.find(c => c.focused) || cs.find(c => c.visibilityState === 'visible') || cs[0];
    if (!c) return self.clients.openWindow('/app' + q);
    c.postMessage({ kankaOpen: d });
    try { return await c.focus(); }
    catch { try { const n = await c.navigate('/app' + q); return n?.focus(); } catch { return self.clients.openWindow('/app' + q); } }
  }));
});
