// Kanka Chat sunucusu (v0.4)
const MAX_ROLES = 250; // sunucu başına en fazla rol
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

// Güvenlik: tek bir hatalı istek bütün sunucuyu düşürmesin (hata kaydedilir, sunucu çalışmaya devam eder)
const errSeen = new Map();
function logCrash(where, e) {
  const k = where + '|' + String(e?.message || e).slice(0, 120), n = (errSeen.get(k) || 0) + 1; errSeen.set(k, n);
  if (errSeen.size > 500) errSeen.clear();
  if (n <= 3 || n % 100 === 0) console.error(`[hata] ${where} (${n}. kez):`, e?.stack || e);
}
process.on('uncaughtException', e => logCrash('uncaught', e));
process.on('unhandledRejection', e => logCrash('promise', e));
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 6e6 });
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const UPLOADS = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });
const OLD_UP = path.join(__dirname, 'public', 'uploads');
if (fs.existsSync(OLD_UP) && OLD_UP !== UPLOADS) for (const f of fs.readdirSync(OLD_UP)) { try { fs.renameSync(path.join(OLD_UP, f), path.join(UPLOADS, f)); } catch {} }

// Temel güvenlik başlıkları: başka sitelerin Kanka'yı çerçeve içine alıp tıklama tuzağı kurmasını ve tür tahminini engelle
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'SAMEORIGIN' });
  if (!req.path.startsWith('/dosya/')) res.set('Content-Security-Policy', "frame-ancestors 'self'; object-src 'none'; base-uri 'self'");
  next();
});
app.use('/uploads', express.static(UPLOADS, { maxAge: '30d', setHeaders: res => res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; sandbox") }));
// Masaüstü sürüm dağılımı: uygulamalar 10 dakikada bir /indir/RELEASES?localVersion=x.y.z sorar.
// Son 48 saatte hangi sürümden kaç farklı bağlantı sordu, /api/surum'da görünür (güncellemelerin kullanıcılara ulaştığını görmek için).
// IP saklanmaz, sadece sayım için tuzlu özeti bellekte tutulur.
const deskSeen = new Map(), DESK_SALT = crypto.randomBytes(16);
app.use('/indir', (req, res, next) => {
  if (/^\/releases$/i.test(req.path)) { const v = String(req.query.localVersion || req.query.localversion || '').slice(0, 20); if (/^\d+\.\d+\.\d+$/.test(v)) deskSeen.set(crypto.createHmac('sha256', DESK_SALT).update(reqIp(req)).digest('hex').slice(0, 16), { v, at: Date.now() }); }
  next();
});
const deskVersions = () => { const now = Date.now(), o = {}; for (const [k, x] of deskSeen) { if (now - x.at > 48 * 3600e3) { deskSeen.delete(k); continue; } o[x.v] = (o[x.v] || 0) + 1; } return o; };
app.use('/indir', express.static(path.join(__dirname, 'indir'), { setHeaders: res => res.set('Content-Disposition', 'attachment') }));
// Genel gövde sınırı 8 KB. Bot API'si (/api/v1, 128 KB) ve masaüstü etkinlik bildirimi (/api/presence, 24 KB) kendi sınırlarıyla
// okur: genel okuyucu önce çalışınca 8 KB'ı aşan bot mesajları ve oyun listeleri "request entity too large" ile düşüyordu.
const json8 = express.json({ limit: '8kb' });
app.use((req, res, next) => (req.path.startsWith('/api/v1/') || req.path === '/api/presence') ? next() : json8(req, res, next));
// Bozuk / çok büyük gövde: kayıtları yığın izleriyle doldurmadan kısa bir JSON hata dön
app.use((err, req, res, next) => { if (err?.type === 'entity.too.large') return res.status(413).json({ hata: 'İstek çok büyük' }); if (err?.type === 'entity.parse.failed' || err?.type === 'encoding.unsupported' || err?.type === 'request.aborted') return res.status(400).json({ hata: 'Geçersiz istek' }); next(err); });

// ---------- Etkinlik (oyun / müzik) ----------
// İşlem adı -> [oyun adı, durum]. Kanka Durum bu listeyi buradan indirir; yeni oyun eklemek için buraya yazmak yeter.
const GAME_PROCS = {
  'League of Legends': ['League of Legends', 'Maçta'], LeagueClientUx: ['League of Legends', 'Lobide'], LeagueClient: ['League of Legends', 'Lobide'],
  'VALORANT-Win64-Shipping': ['Valorant', 'Oyunda'], VALORANT: ['Valorant', 'Açılıyor'],
  cs2: ['Counter-Strike 2', ''], 'Minecraft.Windows': ['Minecraft', 'Bedrock'], 'FortniteClient-Win64-Shipping': ['Fortnite', ''],
  RobloxPlayerBeta: ['Roblox', ''], GTA5: ['Grand Theft Auto V', ''], GTA5_Enhanced: ['Grand Theft Auto V', ''], PlayGTAV: ['Grand Theft Auto V', 'Açılıyor'],
  r5apex: ['Apex Legends', ''], r5apex_dx12: ['Apex Legends', ''], RocketLeague: ['Rocket League', ''], Overwatch: ['Overwatch 2', ''], dota2: ['Dota 2', ''],
  'Among Us': ['Among Us', ''], FC25: ['EA FC 25', ''], FC26: ['EA FC 26', ''], RainbowSix: ['Rainbow Six Siege', ''], RainbowSix_Vulkan: ['Rainbow Six Siege', ''], RainbowSix_DX11: ['Rainbow Six Siege', ''],
  TslGame: ['PUBG', ''], 'Marvel-Win64-Shipping': ['Marvel Rivals', ''], eurotrucks2: ['Euro Truck Simulator 2', ''], amtrucks: ['American Truck Simulator', ''],
  GenshinImpact: ['Genshin Impact', ''], YuanShen: ['Genshin Impact', ''], StarRail: ['Honkai: Star Rail', ''], ZenlessZoneZero: ['Zenless Zone Zero', ''],
  Cyberpunk2077: ['Cyberpunk 2077', ''], eldenring: ['Elden Ring', ''], 'Palworld-Win64-Shipping': ['Palworld', ''], Terraria: ['Terraria', ''], 'Stardew Valley': ['Stardew Valley', ''],
  RDR2: ['Red Dead Redemption 2', ''], RustClient: ['Rust', ''], ForzaHorizon5: ['Forza Horizon 5', ''], 'Lethal Company': ['Lethal Company', ''], Phasmophobia: ['Phasmophobia', ''],
  'osu!': ['osu!', ''], witcher3: ['The Witcher 3', ''], destiny2: ['Destiny 2', ''], 'hollow_knight': ['Hollow Knight', ''], Brawlhalla: ['Brawlhalla', ''], 'Warframe.x64': ['Warframe', ''],
  PEAK: ['PEAK', ''], 'REPO': ['R.E.P.O.', ''], 'TheFinals': ['The Finals', ''], 'Discovery': ['The Finals', ''], 'MetinII': ['Metin2', ''], metin2client: ['Metin2', ''],
  'Knight OnLine': ['Knight Online', ''], KnightOnLine: ['Knight Online', ''], 'Wolfteam.bin': ['Wolfteam', ''], 'MobileLegends': ['Mobile Legends', ''], 'BlackDesert64': ['Black Desert', ''],
  'HeroesOfTheStorm_x64': ['Heroes of the Storm', ''], Hearthstone: ['Hearthstone', ''], 'Diablo IV': ['Diablo IV', ''], 'Wow': ['World of Warcraft', ''], 'Content Warning': ['Content Warning', ''],
  'Sons Of The Forest': ['Sons of the Forest', ''], Raft: ['Raft', ''], 'Dead by Daylight': ['Dead by Daylight', ''], 'DeadByDaylight-Win64-Shipping': ['Dead by Daylight', ''],
  'Fall Guys': ['Fall Guys', ''], 'FallGuys_client_game': ['Fall Guys', ''], 'Valheim': ['Valheim', ''], 'HELLDIVERS2': ['Helldivers 2', ''], 'cod': ['Call of Duty', ''], 'BlackOps6': ['Call of Duty', ''],
  RobRun: ['Rob Run', ''], 'ROB RUN': ['Rob Run', ''], 'Rob Run': ['Rob Run', ''], ROBRUN: ['Rob Run', ''], 'RobRun-Win64-Shipping': ['Rob Run', ''], 'RobRunClient': ['Rob Run', ''],
  'bf2042': ['Battlefield 2042', ''], 'bf6': ['Battlefield 6', ''], 'Minecraft Launcher': ['Minecraft', 'Başlatıcıda'],
};
app.get('/api/presence/games', (req, res) => res.json(GAME_PROCS));
const STARTED = Date.now();
// Gerçek istemci IP'si: X-Forwarded-For sadece bağlantı kendi sunucumuzdaki ters vekilden (Caddy) geliyorsa ve en son eklenen değer dikkate alınır; aksi halde sahte başlıkla limitler atlatılabilirdi
function clientIp(remote, xff) {
  const r = String(remote || '').replace(/^::ffff:/, '');
  if ((r === '127.0.0.1' || r === '::1') && xff) { const hops = String(xff).split(',').map(x => x.trim()).filter(Boolean); if (hops.length) return hops[hops.length - 1].replace(/^::ffff:/, ''); }
  return r || 'bilinmiyor';
}
const reqIp = req => clientIp(req.socket?.remoteAddress, req.headers['x-forwarded-for']);
// ---------- İki adımlı doğrulama (TOTP, Google Authenticator vb.) ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32enc = buf => { let bits = '', out = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0'); for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)]; return out; };
const b32dec = str => { let bits = ''; for (const c of String(str).toUpperCase().replace(/[^A-Z2-7]/g, '')) bits += B32.indexOf(c).toString(2).padStart(5, '0'); const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); };
function totpAt(secret, counter) {
  const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', b32dec(secret)).update(c).digest(), o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0');
}
// Kod doğruysa kullanılan adımı döndürür (aynı kod iki kez kullanılamasın diye), değilse -1
function totpCheck(secret, code, last = -1) {
  code = String(code || '').replace(/\s/g, ''); if (!/^\d{6}$/.test(code)) return -1;
  const now = Math.floor(Date.now() / 30e3);
  for (const w of [0, -1, 1]) { const ctr = now + w; if (ctr > last && totpAt(secret, ctr) === code) return ctr; }
  return -1;
}
const hashCode = c => crypto.createHash('sha256').update(String(c).toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');
// Kullanıcının 2FA'sı açıksa kodu (ya da yedek kodu) doğrular. Kapalıysa her zaman geçer.
function tfaPass(u, code) {
  if (!u?.tfa?.on) return true;
  const ctr = totpCheck(u.tfa.secret, code, u.tfa.last ?? -1);
  if (ctr >= 0) { u.tfa.last = ctr; return true; }
  const h = hashCode(code), i = (u.tfa.backup || []).indexOf(h);
  if (String(code || '').replace(/[^A-Za-z0-9]/g, '').length >= 8 && i >= 0) { u.tfa.backup.splice(i, 1); return true; }
  return false;
}
// Güvenlik olayları (yönetim panelinde görünür)
function secLog(kind, who, detail) {
  const l = (db.secLog ||= []); const last = l[0];
  if (last && last.kind === kind && last.who === who && Date.now() - last.at < 10 * 60e3) { last.n = (last.n || 1) + 1; last.at = Date.now(); }
  else l.unshift({ kind, who, detail: String(detail || '').slice(0, 120), at: Date.now(), n: 1 });
  l.length = Math.min(l.length, 200); save();
}
// Davet kodu tahmin etmeye çalışanları yavaşlat: kısa sürede çok geçersiz kod deneyen 1 saat engellenir
function inviteGuard(key, valid) {
  if (blockedUntil(key)) return false;
  if (!valid) {
    const k = 'invbad|' + key; const n = (limits.get(k) || []).filter(t => Date.now() - t < 3600e3); n.push(Date.now()); limits.set(k, n);
    // aynı internet bağlantısını paylaşan (okul, yurt, mobil) masumları vurmamak için IP sınırı daha yüksek
    if (n.length >= (key.startsWith('ip:') ? 40 : 12)) { limits.set('invblock|' + key, [Date.now() + 3600e3]); secLog('davet-tahmini', key, `${n.length} geçersiz davet kodu denendi, 1 saat engellendi`); }
  }
  return true;
}
const blockedUntil = key => { const b = limits.get('invblock|' + key)?.[0]; return b && b > Date.now() ? b : 0; };
const newInviteCode = () => { const A = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let c = ''; const b = crypto.randomBytes(12); for (const x of b) c += A[x % A.length]; return c.slice(0, 10); };
// ---------- Davet linkleri: ana link (kalıcı) + süreli / kullanım sınırlı / geçici üyelik linkleri ----------
const invValid = i => !!i && !i.revoked && (!i.exp || i.exp > Date.now()) && (!i.max || (i.uses || 0) < i.max);
function findInvite(code) {
  if (!code || typeof code !== 'string') return null;
  for (const s of db.servers) {
    if (s.invite === code) return { s, inv: null };
    const inv = s.invites?.find(i => i.code === code); if (inv) return invValid(inv) ? { s, inv } : null;
  }
  return null;
}
const invOut = i => ({ code: i.code, by: i.by, at: i.at, exp: i.exp || null, max: i.max || 0, uses: i.uses || 0, temp: !!i.temp, ok: invValid(i) });
// ---------- Güvenlik seviyesi: sunucuda yazmak / sese girmek için hesap şartları ----------
const SEC_LEVELS = ['Yok', 'Düşük', 'Orta', 'Yüksek', 'En yüksek'];
function secMissing(s, n) {
  const L = s?.secLevel || 0, u = db.users[n]; if (!L || !u || u.bot || s.owner === n || s.public) return [];
  if ((s.memberRoles?.[n] || []).length || isMod(s, n)) return []; // rolü olan (yetkililerin onayladığı) kişiler muaf
  const miss = [], now = Date.now(), age = now - (u.createdAt || 0), inSrv = now - (s.joinedAt?.[n] || 0);
  if (L >= 1 && !u.email) miss.push({ k: 'email', t: 'Hesabına e-posta ekle' });
  if (L >= 2 && L < 3 && age < 864e5) miss.push({ k: 'age', t: 'Hesabın en az 1 günlük olmalı', until: (u.createdAt || 0) + 864e5 });
  if (L >= 3 && age < 7 * 864e5) miss.push({ k: 'age', t: 'Hesabın en az 7 günlük olmalı', until: (u.createdAt || 0) + 7 * 864e5 });
  if (L >= 3 && inSrv < 10 * 60e3) miss.push({ k: 'wait', t: 'Sunucuda 10 dakika beklemelisin', until: (s.joinedAt?.[n] || 0) + 10 * 60e3 });
  if (L >= 4 && !u.tfa?.on) miss.push({ k: 'tfa', t: 'İki adımlı doğrulamayı aç' });
  return miss;
}
const secBlock = (s, n) => { const m = secMissing(s, n); return m.length ? `Bu sunucunun güvenlik seviyesi için: ${m.map(x => x.t.toLocaleLowerCase('tr')).join(', ')}` : null; };
app.get('/api/davet/:code', (req, res) => {
  const ipk = 'ip:' + reqIp(req);
  if (blockedUntil(ipk) || limited('davetapi|' + ipk, 40, 600e3)) return res.status(429).json({ error: 'Çok fazla deneme, biraz sonra tekrar dene' });
  const s = findInvite(req.params.code)?.s;
  inviteGuard(ipk, !!s);
  if (!s) return res.status(404).json({ error: 'Davet geçersiz ya da süresi dolmuş' });
  const mem = membersOf(s), on = new Set(onlineNames());
  res.json({ name: s.name, icon: s.icon, iconImg: s.iconImg || null, badges: srvBadges(s), description: s.description || '', banner: s.banner || null, bannerColor: s.bannerColor || null, members: mem.length, online: mem.filter(n => on.has(n)).length });
});
// Reklam ölçümü: kayıt olan kişinin ilk geldiği kaynak (utm / Google reklam tıklaması / yönlendiren site)
// GIF'in tekrar sayısını sonsuz yap. NETSCAPE2.0 eki varsa sayıyı 0'a çeker, yoksa ekler.
// (Ek yoksa ya da sayı 1-2 gibiyse tarayıcı GIF'i birkaç kez oynatıp son karede durdurur.)
function gifLoopForever(buf) {
  try {
    if (buf.length < 13 || buf.toString('latin1', 0, 3) !== 'GIF') return buf;
    const i = buf.indexOf('NETSCAPE2.0', 0, 'latin1');
    if (i > 0 && buf[i + 11] === 3 && buf[i + 12] === 1) { const out = Buffer.from(buf); out[i + 13] = 0; out[i + 14] = 0; return out; }
    if (i > 0) return buf;
    const packed = buf[10], gct = packed & 0x80 ? 3 * (1 << ((packed & 7) + 1)) : 0, at = 13 + gct;
    if (at > buf.length) return buf;
    const ext = Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0', 'latin1'), 0x03, 0x01, 0x00, 0x00, 0x00]);
    return Buffer.concat([buf.subarray(0, at), ext, buf.subarray(at)]);
  } catch { return buf; }
}
// Daha önce yüklenmiş GIF'leri de bir kere düzelt (açılışta, arka planda)
setTimeout(() => { try { let n = 0; for (const f of fs.readdirSync(UPLOADS)) { if (!f.endsWith('.gif')) continue; const p = path.join(UPLOADS, f), b = fs.readFileSync(p), o = gifLoopForever(b); if (o !== b) { fs.writeFileSync(p, o); n++; } } if (n) console.log(`[gif] ${n} GIF sonsuz döngüye alındı`); } catch (e) { console.error('[gif]', e.message); } }, 5000);
function cleanSrc(x) {
  if (!x || typeof x !== 'object') return null;
  const c = (v, n = 60) => typeof v === 'string' ? v.replace(/[^\p{L}\p{N} ._\-+/]/gu, '').trim().slice(0, n) || undefined : undefined;
  const o = { s: c(x.s), m: c(x.m), c: c(x.c), t: c(x.t, 80), g: x.g ? 1 : undefined, lp: c(x.lp), ref: c(x.ref), at: +x.at || undefined };
  Object.keys(o).forEach(k => o[k] === undefined && delete o[k]);
  return Object.keys(o).some(k => k !== 'at') ? o : null;
}
const srcLabel = s => !s ? 'Doğrudan / bilinmiyor' : s.g || /google/i.test(s.s || '') && /cpc|ads|ppc|paid/i.test(s.m || 'cpc') ? `Google reklam${s.t ? ' · ' + s.t : s.c ? ' · ' + s.c : ''}` : s.s ? `${s.s}${s.c ? ' · ' + s.c : ''}${s.t ? ' · ' + s.t : ''}` : s.ref ? s.ref : s.lp ? 'Sayfa: ' + s.lp : 'Doğrudan / bilinmiyor';
// ---- Adresler: kankahq.com tanıtım sayfası, /app uygulama, /login giriş, /register kayıt ----
const PAGE = f => path.join(__dirname, 'public', f);
const APP_QS = ['ac', 'kim', 'oda', 'davet', 'botekle', 'izin', 'rehber', 'arayuz'];
const qsOf = req => (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
app.get('/', (req, res) => {
  const q = req.query || {};
  // Eski linkler (davet, bildirim, şifre sıfırlama, masaüstü uygulaması) uygulamaya gitmeye devam etsin
  if (q.kayit !== undefined || q.kod) return res.redirect(302, '/register' + qsOf(req));
  if (q.sifirla) return res.redirect(302, '/login' + qsOf(req));
  if (APP_QS.some(k => q[k] !== undefined) || /Electron\/|KankaMobil\//.test(req.get('user-agent') || '')) return res.redirect(302, '/app' + qsOf(req));
  res.set('Cache-Control', 'no-store'); res.sendFile(PAGE('sesli-sohbet.html'));
});
for (const p of ['/app', '/login', '/register']) app.get(p, (req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(PAGE('index.html')); });
app.get(['/giris', '/giris-yap'], (req, res) => res.redirect(301, '/login' + qsOf(req)));
app.get(['/kayit', '/kayit-ol', '/signup'], (req, res) => res.redirect(301, '/register' + qsOf(req)));
app.get('/discord-alternatifi', (req, res) => res.redirect(301, '/sesli-sohbet' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '')));
// Mobil uygulama bağlantıları: Android App Links ve iOS Universal Links doğrulama dosyaları.
// Değerler gizli değildir ama imzaya bağlıdır: ANDROID_SHA256 (Play imza sertifikası SHA-256, virgülle birden fazla) ve IOS_TEAM_ID ortam değişkenleri yoksa 404 döner.
app.get('/.well-known/assetlinks.json', (req, res) => { const fp = String(process.env.ANDROID_SHA256 || '').split(',').map(x => x.trim()).filter(Boolean); if (!fp.length) return res.status(404).end();
  res.json([{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: process.env.ANDROID_PACKAGE || 'com.kanka.chat', sha256_cert_fingerprints: fp } }]); });
app.get(['/.well-known/apple-app-site-association', '/apple-app-site-association'], (req, res) => { const team = String(process.env.IOS_TEAM_ID || npCfg.apns?.teamId || '').trim(); if (!team) return res.status(404).end(); // Team ID: ortam değişkeni ya da Yönetim › Mobil bildirimler'deki APNs ayarı
  res.type('application/json').send(JSON.stringify({ applinks: { details: [{ appIDs: [`${team}.${process.env.IOS_BUNDLE || npCfg.apns?.bundle || 'com.kanka.chat'}`], components: ['/davet/*', '/s/*', '/app*', '/bot-ekle/*'].map(p => ({ '/': p })) }] } })); });
app.get('/davet/:code', (req, res) => res.redirect('/app?davet=' + encodeURIComponent(req.params.code)));
// Partner sunucuların özel linki: kankahq.com/s/isim
app.get('/s/:slug', (req, res) => { const s = db.servers.find(x => x.vanity && x.vanity === String(req.params.slug).toLowerCase() && vanityOk(x)); res.redirect(s ? '/app?davet=' + encodeURIComponent(s.invite) : '/'); });
// İzlenen kısa link: kankahq.com/r/youtube-rozet → kaynak "youtube", kampanya "rozet" (video açıklamalarına koymak için)
app.get('/r/:tag', (req, res) => { const t = String(req.params.tag).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 60); const [src, ...rest] = t.split('-'); res.redirect('/?utm_source=' + encodeURIComponent(src || 'link') + (rest.length ? '&utm_campaign=' + encodeURIComponent(rest.join('-')) : '') + '&utm_medium=kisalink'); });
app.get('/bot-ekle/:id', (req, res) => res.redirect('/app?botekle=' + encodeURIComponent(String(req.params.id).slice(0, 40)) + (req.query.izin ? '&izin=' + encodeURIComponent(String(req.query.izin).slice(0, 300)) : '')));
app.get('/gelistirici', (req, res) => res.sendFile(path.join(__dirname, 'public', 'gelistirici.html')));
app.get('/kod/:code', (req, res) => res.redirect('/register?kod=' + encodeURIComponent(req.params.code)));
// İndirme güvenliği: sunulan kurulum dosyasının SHA-256'sı (VirusTotal raporu bu özetle açılır)
let exeHash = { at: 0, mtime: 0, v: null };
function exeInfo() {
  const f = path.join(__dirname, 'indir', 'KankaChat-Kurulum.exe');
  try { const st = fs.statSync(f); if (exeHash.mtime !== st.mtimeMs) exeHash = { mtime: st.mtimeMs, v: { sha256: crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'), size: st.size, date: st.mtime } }; return exeHash.v; } catch { return null; }
}
// Masaüstü sürümünü GitHub Release'ten kendiliğinden al (GitHub Actions derleyip "desktop-v<sürüm>" olarak yayınlıyor)
const GH_REPO = process.env.GH_REPO || 'Reuskilled/kanka-chat', INDIR = path.join(__dirname, 'indir');
let ghTok = process.env.GITHUB_TOKEN || ''; try { ghTok ||= JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'github.json'), 'utf8')).token || ''; } catch {}
const deskState = { checking: false, last: null, err: null };
async function deskSync() {
  if (deskState.checking) return; deskState.checking = true;
  try {
    const H = { Accept: 'application/vnd.github+json', 'User-Agent': 'kanka-chat', ...(ghTok ? { Authorization: 'Bearer ' + ghTok } : {}) };
    const r = await fetch(`https://api.github.com/repos/${GH_REPO}/releases?per_page=10`, { headers: H, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('GitHub ' + r.status + (r.status === 404 ? ' (depo gizliyse DATA_DIR/github.json içine {"token":"..."} koy)' : ''));
    const rel = (await r.json()).find(x => /^desktop-v\d+\.\d+\.\d+$/.test(x.tag_name) && !x.draft && !x.prerelease);
    if (!rel) { deskState.last = Date.now(); return; }
    const cur = (() => { try { return fs.readFileSync(path.join(INDIR, '.surum'), 'utf8').trim(); } catch { return ''; } })();
    if (cur === rel.tag_name) { deskState.last = Date.now(); deskState.err = null; return; }
    const want = rel.assets.filter(a => /^(KankaChat-Kurulum\.exe|RELEASES|[\w.-]+-full\.nupkg)$/.test(a.name));
    if (!want.some(a => a.name === 'KankaChat-Kurulum.exe') || !want.some(a => a.name === 'RELEASES')) throw new Error(rel.tag_name + ': dosyalar eksik');
    fs.mkdirSync(INDIR, { recursive: true });
    for (const a of want) { // önce hepsini indir, sonra birden değiştir (yarım güncelleme olmasın)
      const d = await fetch(ghTok ? a.url : a.browser_download_url, { headers: { ...H, Accept: 'application/octet-stream' }, signal: AbortSignal.timeout(15 * 60e3) });
      if (!d.ok) throw new Error(a.name + ' indirilemedi: ' + d.status);
      const buf = Buffer.from(await d.arrayBuffer()); if (buf.length !== a.size) throw new Error(a.name + ' boyutu tutmuyor');
      fs.writeFileSync(path.join(INDIR, '.yeni-' + a.name), buf);
    }
    for (const a of want.filter(x => x.name !== 'RELEASES')) fs.renameSync(path.join(INDIR, '.yeni-' + a.name), path.join(INDIR, a.name));
    fs.renameSync(path.join(INDIR, '.yeni-RELEASES'), path.join(INDIR, 'RELEASES')); // en son: güncelleyiciler yeni sürümü ancak her şey hazırken görsün
    fs.writeFileSync(path.join(INDIR, '.surum'), rel.tag_name);
    for (const f of fs.readdirSync(INDIR)) if (/\.nupkg$/.test(f) && !want.some(a => a.name === f)) try { fs.unlinkSync(path.join(INDIR, f)); } catch {} // RELEASES artık sadece yeni paketi gösteriyor
    deskState.last = Date.now(); deskState.err = null;
    console.log('Masaüstü sürümü güncellendi:', rel.tag_name);
    for (const n of siteAdmins()) io.to('user:' + n).emit('toast', `💻 Masaüstü ${rel.tag_name.slice(9)} yayında, kullanıcılara güncelleme gidiyor`);
  } catch (e) { deskState.err = String(e.message || e).slice(0, 200); console.error('Masaüstü sürüm kontrolü:', deskState.err); }
  finally { deskState.checking = false; }
}
setTimeout(deskSync, 20e3); setInterval(deskSync, 10 * 60e3);
app.get('/api/indir-bilgi', (req, res) => res.json(exeInfo() || {}));
app.get('/guvenli', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guvenli.html')));
for (const [u, f] of [['/gizlilik', 'gizlilik.html'], ['/kosullar', 'kosullar.html'], ['/kvkk', 'gizlilik.html'], ['/sesli-sohbet', 'sesli-sohbet.html'], ['/destek', 'destek.html'], ['/hesap-silme', 'hesap-silme.html'], ['/hesap-sil', 'hesap-silme.html']]) app.get(u, (req, res) => res.sendFile(path.join(__dirname, 'public', f)));
// ---------- Beta kayıt sayfası (/beta) ----------
// Sayfadan gelen kayıt uygulamanın bekleme listesine (db.waitlist) girer. Kontenjan doluysa yedekte bekler;
// değilse hemen davet kodu üretilir, ekranda gösterilir ve e-postayla da gönderilir.
const BETA_OLD = path.join(DATA_DIR, 'beta.json');
let betaMigrated = false;
function betaMigrate() { // ilk sürümün ayrı listesini bekleme listesine taşı
  if (betaMigrated) return; betaMigrated = true;
  let old = []; try { old = JSON.parse(fs.readFileSync(BETA_OLD, 'utf8')); } catch { return; }
  for (const o of old) if (!db.waitlist.some(w => w.email === o.email)) db.waitlist.push({ email: o.email, name: o.name, at: o.at, ref: 'beta-sayfa' });
  save(); try { fs.renameSync(BETA_OLD, BETA_OLD + '.tasindi'); } catch {}
}
const betaCount = () => userCount() + db.waitlist.filter(w => !w.joined).length;
app.get('/beta', (req, res) => res.sendFile(path.join(__dirname, 'public', 'beta.html')));
app.get('/api/beta', (req, res) => { betaMigrate(); res.json({ count: Math.min(betaCount(), db.beta.cap || 300), cap: db.beta.cap || 300 }); });
app.post('/api/beta', (req, res) => {
  betaMigrate();
  const ip = reqIp(req), cap = db.beta.cap || 300;
  const name = clean(req.body?.name, 24), email = clean(req.body?.email, 190).toLowerCase();
  if (name.length < 2) return res.status(400).json({ error: 'Kullanıcı adını yaz.' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Geçerli bir e-posta yaz.' });
  if (req.body?.kvkk !== true) return res.status(400).json({ error: 'Aydınlatma metnini onaylaman gerekiyor.' });
  const acct = Object.values(db.users).find(u => u.email === email);
  if (acct) return res.json({ account: true, count: Math.min(betaCount(), cap), cap });
  let i = db.waitlist.findIndex(w => w.email === email); const again = i >= 0;
  if (!again) {
    if (limited('beta|' + ip, 5, 3600e3)) return res.status(429).json({ error: 'Çok fazla deneme, biraz sonra tekrar dene.' });
    db.waitlist.push({ email, name, at: Date.now(), ref: 'beta-sayfa' + (req.body?.src ? ':' + clean(req.body.src, 20) : '') }); i = db.waitlist.length - 1;
  }
  const w = db.waitlist[i];
  const inCap = !db.beta.on || !betaFull();
  let mailed = !!w.mailed;
  if (inCap) {
    if (!w.code || db.codes[w.code]?.usedBy) w.code = newCode('kanka', 'Beta sayfası: ' + email);
    w.invited ||= Date.now();
    if (!w.mailed) { w.mailed = Date.now(); mailed = true; sendInviteMail(email, w.code).then(ok => { if (!ok) { delete w.mailed; save(); } }); }
  }
  save();
  if (!again) for (const n of siteAdmins()) io.to('user:' + n).emit('waitlistNew', db.waitlist.filter(x => !x.invited).length);
  res.json({ pos: Math.min(userCount() + 1 + db.waitlist.filter((x, j) => j < i && !x.joined).length, 999999), inCap, code: inCap ? w.code : null, mailed: inCap && mailed && !!getMailer(), again: again || undefined, count: Math.min(betaCount(), cap), cap });
});
// ---------- Yedek indirme (sadece Kanka yönetimi; masaüstü uygulaması her gün bilgisayara çeker) ----------
app.get('/api/yedek/:name', (req, res) => {
  const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''), who = sessGet(tok);
  if (!who || !siteAdmin(who)) return res.status(403).json({ error: 'Yetkin yok' });
  if (limited('yedek|' + who, 30, 3600e3)) return res.status(429).json({ error: 'Çok fazla istek' });
  let name = req.params.name;
  if (name === 'son') { backup(); name = backupList()[0]?.name; }
  if (!name || !BACKUP_RE.test(name)) return res.status(404).json({ error: 'Yedek yok' });
  const f = path.join(BACKUPS, name); if (!fs.existsSync(f)) return res.status(404).json({ error: 'Yedek yok' });
  db.backupLog = { ...(db.backupLog || {}), download: { at: Date.now(), by: who, name, via: String(req.headers['x-kanka-via'] || 'web').slice(0, 20) } }; save();
  res.set({ 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="kanka-${name}"`, 'Cache-Control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});
// ---------- Bağlantı önizlemesi: mesajdaki ilk bağlantının başlığı, açıklaması ve görseli ----------
const dns = require('dns').promises, net = require('net');
const privIP = ip => net.isIPv6(ip) ? /^(::1|::|fc|fd|fe80|::ffff:(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.))/i.test(ip)
  : /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|22[4-9]\.|2[3-5]\d\.)/.test(ip);
const lpCache = new Map();
// Özel/yerel ağ adreslerine istek atılmasın (SSRF). Kontrol bağlantı anında yapılır, DNS değişse bile atlatılamaz.
const PRIV = new net.BlockList();
for (const c of ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.168.0.0/16', '198.18.0.0/15', '224.0.0.0/3']) { const [a, b] = c.split('/'); PRIV.addSubnet(a, +b, 'ipv4'); }
for (const c of ['::/127', 'fc00::/7', 'fe80::/10', '64:ff9b::/96', 'ff00::/8', '2001:db8::/32']) { const [a, b] = c.split('/'); PRIV.addSubnet(a, +b, 'ipv6'); }
const privAddr = (a, fam) => { try { return PRIV.check(a, fam === 6 || net.isIPv6(a) ? 'ipv6' : 'ipv4'); } catch { return true; } };
function safeLookup(host, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  require('dns').lookup(host, { ...opts, all: true }, (err, list) => {
    if (err) return cb(err);
    if (!list.length || list.some(x => privAddr(x.address, x.family))) return cb(Object.assign(new Error('Özel ağ adresi'), { code: 'EPRIV' }));
    opts.all ? cb(null, list) : cb(null, list[0].address, list[0].family);
  });
}
function safeFetch(url, hops = 0) {
  return new Promise(resolve => {
    let u; try { u = new URL(url); } catch { return resolve(null); }
    if (!/^https?:$/.test(u.protocol) || hops > 3 || (u.port && !['80', '443', '8080', '8443'].includes(u.port))) return resolve(null);
    if (net.isIP(u.hostname.replace(/^\[|\]$/g, '')) && privAddr(u.hostname.replace(/^\[|\]$/g, ''))) return resolve(null);
    const mod = u.protocol === 'https:' ? require('https') : require('http');
    const req = mod.get(u, { lookup: safeLookup, timeout: 5000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KankaChatBot/1.0; +https://kankahq.com)', Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'tr,en;q=0.8' } }, res => {
      const loc = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && loc) { res.resume(); let nu; try { nu = new URL(loc, u).href; } catch { return resolve(null); } return resolve(safeFetch(nu, hops + 1)); }
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); return resolve(null); }
      resolve({ url: u.href, type: String(res.headers['content-type'] || ''),
        head: max => new Promise(done => { let html = '', n = 0; const end = () => { res.destroy(); done(html); };
          res.on('data', b => { n += b.length; html += b.toString('utf8'); if (n >= max || /<\/head>/i.test(html)) end(); }); res.on('end', () => done(html)); res.on('error', () => done(html)); setTimeout(end, 5000); }) });
    });
    req.on('timeout', () => req.destroy()); req.on('error', () => resolve(null));
  });
}
const unent = t => String(t || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n)).replace(/\s+/g, ' ').trim();
async function linkPreview(url) {
  if (lpCache.has(url)) return lpCache.get(url);
  let out = null;
  try {
    const r = await safeFetch(url);
    if (r && /text\/html|application\/xhtml/i.test(r.type)) {
      const html = await r.head(400e3);
      const meta = k => { const m = new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]*>`, 'i').exec(html)?.[0]; return m && unent(/content=["']([^"']*)["']/i.exec(m)?.[1]); };
      const title = meta('og:title') || meta('twitter:title') || unent(/<title[^>]*>([^<]{1,300})<\/title>/i.exec(html)?.[1]);
      let image = meta('og:image') || meta('twitter:image'); try { image = image ? new URL(image, r.url || url).href : null; } catch { image = null; }
      if (image && !/^https:\/\//.test(image)) image = null;
      if (title) out = { url, title: title.slice(0, 140), desc: (meta('og:description') || meta('description') || '').slice(0, 220), image: image?.slice(0, 500) || null, site: (meta('og:site_name') || new URL(url).hostname.replace(/^www\./, '')).slice(0, 60) };
    }
  } catch {}
  if (lpCache.size > 500) lpCache.clear();
  lpCache.set(url, out); return out;
}
// ---------- Dosya yükleme: resim, video, PDF, zip, belge… (en çok 25 MB, günde 300 MB) ----------
const FILES = path.join(DATA_DIR, 'uploads', 'f'); fs.mkdirSync(FILES, { recursive: true });
const FILE_MAX = 25 * 1024 * 1024, FILE_DAY = 300 * 1024 * 1024;
const BAD_EXT = /\.(exe|msi|bat|cmd|com|scr|ps1|vbs|vbe|js|jse|wsf|wsh|hta|cpl|jar|lnk|reg|dll|sys|html?|xhtml|xml|php|apk|app|dmg|pkg|iso)$/i;
const fileKind = (mime, name) => /^image\/(png|jpeg|gif|webp)$/.test(mime) ? 'image' : /^video\/(mp4|webm|quicktime)$/.test(mime) || /\.(mp4|webm|mov)$/i.test(name) ? 'video' : /^audio\//.test(mime) ? 'audio' : 'file';
const safeName = n => String(n || 'dosya').normalize('NFC').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').slice(-120) || 'dosya';
app.post('/api/dosya', express.raw({ type: () => true, limit: FILE_MAX + 1024 }), (req, res) => {
  const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''), me = sessGet(tok);
  if (!me || !db.users[me]) return res.status(401).json({ error: 'Giriş yapmalısın' });
  if (limited('dosya|' + me, 40, 60e3)) return res.status(429).json({ error: 'Çok fazla dosya yükledin, bir dakika bekle' });
  let name; try { name = safeName(decodeURIComponent(String(req.headers['x-file-name'] || 'dosya'))); } catch { name = 'dosya'; }
  const buf = req.body; if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'Boş dosya' });
  if (buf.length > FILE_MAX) return res.status(413).json({ error: 'Dosya en fazla 25 MB olabilir' });
  if (BAD_EXT.test(name)) return res.status(400).json({ error: 'Bu dosya türü güvenlik nedeniyle gönderilemez (.exe, .bat, .html gibi)' });
  const r = storeFile(me, name, req.headers['x-file-type'], buf);
  if (r.error) return res.status(r.code || 400).json({ error: r.error });
  res.json({ ok: true, ...r });
});
// İstemcide yaşanan ve sunucuya hiç ulaşmayan hatalar (ör. yükleme sırasında bağlantı kopması) kayda düşsün: nerede takıldığını görmek için
app.post('/api/istemci-hata', express.text({ type: () => true, limit: '2kb' }), (req, res) => {
  res.status(204).end();
  if (limited('ihata|' + (req.ip || ''), 10, 600e3)) return;
  let d; try { d = JSON.parse(req.body); } catch { return; }
  console.warn('[istemci-hata]', JSON.stringify({ ...d, ua: String(req.headers['user-agent'] || '').slice(0, 110) }).slice(0, 400));
});
// Kullanıcı ya da bot için dosyayı kaydet (tür içerikten doğrulanır, günlük sınır uygulanır)
function storeFile(me, name, typeHdr, buf) {
  const u = db.users[me], day = new Date().toISOString().slice(0, 10);
  if (u.upDay?.d !== day) u.upDay = { d: day, b: 0 };
  if (u.upDay.b + buf.length > FILE_DAY) return { error: 'Bugünkü yükleme sınırına ulaşıldı (300 MB). Yarın tekrar dene.', code: 429 };
  let mime = String(typeHdr || 'application/octet-stream').split(';')[0].toLowerCase().slice(0, 80); // gövde hep octet-stream gelir (json ayrıştırıcısına takılmasın)
  // İçerikten tür doğrulama: resim diyorsa gerçekten resim olsun
  const sig = buf.subarray(0, 12).toString('hex');
  const realImg = sig.startsWith('89504e47') ? 'image/png' : sig.startsWith('ffd8ff') ? 'image/jpeg' : sig.startsWith('47494638') ? 'image/gif' : sig.startsWith('52494646') && buf.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : null;
  if (realImg) mime = realImg; // tür başlığı boş/yanlış gelse de (bazı Android galerileri) içerik resimse resimdir
  else if (mime.startsWith('image/')) mime = 'application/octet-stream';
  const kind = fileKind(mime, name), fid = crypto.randomBytes(12).toString('hex');
  fs.writeFileSync(path.join(FILES, fid), buf);
  u.upDay.b += buf.length;
  (db.files ||= {})[fid] = { owner: me, name, size: buf.length, mime, kind, at: Date.now() };
  save();
  return { id: fid, name, size: buf.length, kind, url: `/dosya/${fid}/${encodeURIComponent(name)}` };
}
app.get('/dosya/:id/:name?', (req, res) => {
  const f = /^[a-f0-9]{24}$/.test(req.params.id) && db.files?.[req.params.id];
  if (!f) return res.status(404).send('Dosya bulunamadı');
  // Tarayıcıda açılacak tür sadece gerçekten resim/video/ses olan güvenli türler olabilir (ör. ".mp4" adlı bir HTML dosyası sayfa gibi açılmasın)
  const inline = ['image', 'video', 'audio'].includes(f.kind) && /^(image\/(png|jpeg|gif|webp)|video\/(mp4|webm|quicktime)|audio\/(mpeg|mp4|ogg|webm|wav|x-wav|aac|x-m4a|flac))$/.test(f.mime);
  res.set({ 'Content-Type': inline ? f.mime : 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=2592000',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}` });
  res.sendFile(path.join(FILES, req.params.id), { acceptRanges: true });
});
const SQLITE_OK = (() => { try { require('node:sqlite'); return true; } catch { return false; } })(); // SQLite'a geçiş için: sunucudaki Node bunu destekliyor mu
app.get('/api/surum', (req, res) => {
  let sha = null;
  try { sha = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'guncelleme.json'), 'utf8')).sha; } catch {}
  res.json({ surum: sha ? sha.slice(0, 7) : 'yerel', baslama: STARTED, bildirim: pushStats, node: process.version, sqlite: SQLITE_OK, kayit: saveSummary(), masaustu: { sunulan: (() => { try { return fs.readFileSync(path.join(__dirname, 'indir', '.surum'), 'utf8').trim(); } catch { return null; } })(), kullanilan48s: deskVersions() } });
});
const artCache = new Map();
async function albumArt(title, artist) {
  const k = (artist + ' ' + title).toLowerCase();
  if (artCache.has(k)) return artCache.get(k);
  let url = null;
  try {
    const r = await fetch('https://itunes.apple.com/search?entity=song&limit=1&term=' + encodeURIComponent(k), { signal: AbortSignal.timeout(4000) });
    url = (await r.json()).results?.[0]?.artworkUrl100?.replace('100x100', '300x300') || null;
  } catch {}
  if (artCache.size > 500) artCache.clear();
  artCache.set(k, url); return url;
}
function activitiesOf(u) {
  if (u.presence === 'invisible') return null; // görünmez: oyun/müzik de "çevrimiçiyim" diye ele vermesin
  if (!isOnlineName(u.name)) return null; // çevrimdışıyken masaüstü uygulaması açık kalsa da "oynuyor" görünmesin
  const auto = u.auto && Date.now() - u.auto.at < 45e3 ? u.auto : null;
  return auto && (auto.game || auto.music) ? { game: auto.game, music: auto.music, auto: true } : null;
}
const pushActivity = u => io.emit('activity', { name: u.name, activities: activitiesOf(u) });
// Oyunun kendi servisinden gelen ayrıntılar (şampiyon, mod, derece, skor). Resimler sadece bilinen oyun kaynaklarından.
const RICH_IMG = /^https:\/\/(ddragon\.leagueoflegends\.com|media\.valorant-api\.com|cdn\.communitydragon\.org)\//;
function cleanRich(r) {
  if (!r || typeof r !== 'object') return null;
  const o = {};
  for (const k of ['phase', 'mode', 'rank', 'state', 'champ', 'map', 'extra']) if (typeof r[k] === 'string' && r[k].trim()) o[k] = clean(r[k], 80);
  if (typeof r.img === 'string' && RICH_IMG.test(r.img)) o.img = r.img.slice(0, 300);
  if (r.ranked) o.ranked = true;
  if (Array.isArray(r.kda) && r.kda.length === 3) o.kda = r.kda.map(x => Math.max(0, Math.min(999, +x || 0)));
  const st = +r.start; if (st && st > Date.now() - 6 * 3600e3 && st <= Date.now() + 5e3) o.start = st;
  return Object.keys(o).length ? o : null;
}
// ---------- Maç sonu kartı ----------
const MATCH_GAMES = ['League of Legends', 'Valorant', 'Counter-Strike 2'];
function cleanMatch(m) {
  if (!m || typeof m !== 'object' || !MATCH_GAMES.includes(m.game) || !['win', 'loss', 'draw'].includes(m.result)) return null;
  const key = clean(m.key, 90); if (!key) return null;
  const o = { key, game: m.game, result: m.result, ranked: !!m.ranked };
  for (const k of ['mode', 'map', 'champ']) if (typeof m[k] === 'string' && m[k].trim()) o[k] = clean(m[k], 40);
  for (const k of ['img', 'bg']) if (typeof m[k] === 'string' && RICH_IMG.test(m[k])) o[k] = m[k].slice(0, 300);
  if (Array.isArray(m.kda) && m.kda.length === 3) o.kda = m.kda.map(x => Math.max(0, Math.min(999, Math.round(+x) || 0)));
  if (Array.isArray(m.score) && m.score.length === 2) o.score = m.score.map(x => Math.max(0, Math.min(99, Math.round(+x) || 0)));
  if (+m.dur > 0) o.dur = Math.min(4 * 3600, Math.round(+m.dur));
  if (Array.isArray(m.extra)) o.extra = m.extra.filter(x => typeof x === 'string').slice(0, 3).map(x => clean(x, 24)).filter(Boolean);
  if (m.rank && typeof m.rank === 'object') {
    const r = {}; for (const k of ['before', 'after', 'text']) if (typeof m.rank[k] === 'string' && m.rank[k].trim()) r[k] = clean(m.rank[k], 40);
    if (Number.isFinite(+m.rank.delta) && m.rank.delta !== null) r.delta = Math.max(-999, Math.min(999, Math.round(+m.rank.delta)));
    if (['up', 'down'].includes(m.rank.dir)) r.dir = m.rank.dir;
    if (r.after) o.rank = r;
  }
  return o;
}
const voiceRoomOf = n => { for (const [ch, room] of voice) if (!ch.startsWith('call:') && [...room.values()].includes(n)) return ch; return null; };
// Kart nereye düşsün: ayardaki oda, yoksa şu an seste olduğu sunucunun oyun odası (adında oyun/maç geçen), yoksa ilk yazılı oda
function matchTarget(u) {
  const to = u.matchShare?.to || 'profile'; // varsayılan: sadece profilde
  if (to === 'profile') return null;
  const ok = (sv, c) => sv && c && c.type === 'text' && !c.news && (sv.public || sv.members.includes(u.name)) && !sv.bans?.[u.name] && chPerm(sv, c, u.name, 'send');
  if (to !== 'voice') { const f = findChannel(to); return f && ok(f.s, f.c) ? f.c.id : null; }
  const vc = voiceRoomOf(u.name), f = vc && findChannel(vc); if (!f) return null;
  const list = f.s.channels.filter(c => ok(f.s, c));
  return (list.find(c => /oyun|ma[çc]|game|gaming|valo|lol|cs|rank/i.test(c.name)) || list[0])?.id || null;
}
function deliverMatch(u, m) {
  const player = { n: u.name, champ: m.champ || null, img: m.img || null, kda: m.kda || null, extra: m.extra || [], rank: m.rank || null };
  (u.matches ||= []).unshift({ game: m.game, result: m.result, mode: m.mode || null, map: m.map || null, champ: m.champ || null, img: m.img || null, kda: m.kda || null, score: m.score || null, rank: m.rank || null, time: Date.now() });
  u.matches.length = Math.min(u.matches.length, 10);
  const chId = matchTarget(u); if (!chId) return save();
  const list = (db.messages[chId] ||= []);
  // Aynı maçta olan kankalar tek kartta toplanır
  const same = list.slice(-40).reverse().find(x => x.kind === 'match' && Date.now() - x.time < 15 * 60e3 && x.match.result === m.result && x.match.game === m.game &&
    (x.match.key === m.key || (m.score && x.match.score && x.match.map === m.map && x.match.score.join('-') === m.score.join('-'))));
  if (same) {
    if (!same.match.players.some(p => p.n === u.name)) { same.match.players.push(player); save(); io.to(chId).emit('update', { channelId: chId, msg: same }); }
    return;
  }
  const { champ, img, kda, extra, rank, ...card } = m;
  const msg = { id: id(), author: u.name, color: u.color, time: Date.now(), kind: 'match', reactions: {}, match: { ...card, players: [player] } };
  list.push(msg); if (list.length > 2000) list.shift();
  save();
  io.to(chId).emit('message', { channelId: chId, msg });
  const f = findChannel(chId);
  if (f) for (const n of membersOf(f.s)) if (n !== u.name && canAccess(n, chId)) io.to('user:' + n).emit('chanActivity', { channelId: chId, serverId: f.s.id });
}
const autoSrc = new Map(); // kullanıcı -> (kaynak -> son bildirim)
// ---- Webhook'lar: dışarıdan bir odaya mesaj gönderme (Discord webhook biçimiyle uyumlu) ----
// POST /api/webhooks/:id/:token  { content, username?, avatar_url?, embeds?: [{ title, description, color, fields: [{ name, value }] }] }
const whHits = new Map();
app.post('/api/webhooks/:id/:token', (req, res) => {
  const w = db.webhooks?.[req.params.id];
  if (!w || !req.params.token || w.token.length !== String(req.params.token).length || !crypto.timingSafeEqual(Buffer.from(w.token), Buffer.from(String(req.params.token)))) return res.status(401).json({ error: 'Geçersiz webhook' });
  const now = Date.now(), h = (whHits.get(w.id) || []).filter(t => now - t < 60e3);
  if (h.length >= 30 || h.filter(t => now - t < 2000).length >= 5) { res.set('Retry-After', '2'); return res.status(429).json({ error: 'Çok hızlı. Dakikada en fazla 30, 2 saniyede 5 mesaj.' }); }
  h.push(now); whHits.set(w.id, h);
  const s = db.servers.find(x => x.id === w.serverId), c = s?.channels.find(x => x.id === w.channelId);
  if (!s || !c || voiceLike(c.type)) return res.status(404).json({ error: 'Oda bulunamadı' });
  const b = req.body || {}, e = Array.isArray(b.embeds) ? b.embeds[0] || {} : {};
  const noPing = t => String(t || '').replace(/@(everyone|here|herkes)/gi, '@\u200b$1');
  const text = noPing(clean(b.content ?? b.text, 2000)), title = clean(e.title, 120), desc = noPing(clean(e.description, 1800));
  const fields = (Array.isArray(e.fields) ? e.fields : []).slice(0, 8).map(f => [clean(f?.name, 60), noPing(clean(f?.value, 300))]).filter(f => f[0] || f[1]);
  if (!text && !title && !desc && !fields.length) return res.status(400).json({ error: 'Boş mesaj: content ya da embeds gerekli' });
  const color = Number.isInteger(e.color) ? '#' + (e.color >>> 0 & 0xffffff).toString(16).padStart(6, '0') : /^#[0-9a-f]{6}$/i.test(e.color || '') ? e.color : null;
  const av = /^https:\/\/\S{8,300}$/i.test(b.avatar_url || '') ? b.avatar_url : w.avatar || null;
  const msg = { id: id(), kind: 'bot', time: now, wh: { id: w.id, name: (n => n && !/kanka|yönetim|yonetim|admin|moderat|sistem/i.test(n) ? n : w.name)(clean(b.username, 32)), avatar: av }, bot: { title, text: [text, desc].filter(Boolean).join('\n\n'), plain: !title && !desc && !fields.length, tone: 'info', color, fields }, reactions: {} };
  const list = (db.messages[c.id] ||= []); list.push(msg); if (list.length > 2000) list.shift();
  w.uses = (w.uses || 0) + 1; w.lastAt = now; save();
  io.to(c.id).emit('message', { channelId: c.id, msg });
  res.status(req.query.wait === 'true' ? 200 : 204); req.query.wait === 'true' ? res.json({ id: msg.id }) : res.end();
});
// Masaüstü uygulamasının anahtarından kullanıcıyı bul: her 10 saniyede gelen istekte tüm kullanıcıları taramamak için dizin
const presIdx = new Map(); let presBuilt = 0;
function presUser(key) {
  let n = presIdx.get(key);
  if (!n && Date.now() - presBuilt > 10e3) { presIdx.clear(); for (const x of Object.values(db.users)) if (x.presenceKey) presIdx.set(x.presenceKey, x.name); presBuilt = Date.now(); n = presIdx.get(key); }
  const u = n && db.users[n];
  return u && u.presenceKey === key ? u : null; // anahtar yenilendiyse ya da hesap silindiyse eski kayıt geçmez
}
app.post('/api/presence', express.json({ limit: '64kb' }), async (req, res) => {
  const { key, game, detail, music, rich } = req.body || {};
  const pip = 'presfail|' + reqIp(req);
  if ((limits.get(pip) || []).filter(t => Date.now() - t < 600e3).length >= 30) return res.status(429).json({ error: 'Çok fazla hatalı deneme' });
  const u = typeof key === 'string' && key.length >= 16 && key.length <= 100 && presUser(key);
  if (!u) { limited(pip, 1e6, 600e3); return res.status(401).json({ error: 'Anahtar geçersiz' }); }
  if (Array.isArray(req.body.matches) && u.matchShare?.on !== false) {
    const seen = (u.matchKeys ||= []);
    for (const raw of req.body.matches.slice(0, 5)) {
      const m = cleanMatch(raw); if (!m || seen.includes(m.key)) continue;
      seen.push(m.key); if (seen.length > 30) seen.shift();
      try { deliverMatch(u, m); } catch (e) { console.error('maç kartı', e); }
    }
  }
  // Aynı hesap birden fazla bilgisayardan (ör. ev bilgisayarı + sunucu) bildirebilir: her kaynak ayrı tutulur, sonra birleştirilir.
  // Eskiden biri "oyun var", diğeri "oyun yok" deyince "Oynuyor" her 10 saniyede bir gidip geliyordu.
  const now = Date.now(), srcId = reqIp(req) + '|' + clean(req.body.dev, 40);
  const srcs = autoSrc.get(u.name) || new Map(); autoSrc.set(u.name, srcs);
  for (const [k, v] of srcs) if (now - v.at > 45e3) srcs.delete(k);
  const sp = srcs.get(srcId) || {};
  const prev = u.auto && now - u.auto.at < 45e3 && !u.auto.gone ? u.auto : {};
  let g = typeof game === 'string' && game.trim() ? clean(game, 60) : null, gDetail = clean(detail, 40), r = g ? cleanRich(rich) : null;
  // Tek seferlik algılama boşluğu (görev listesi geç cevap verdi vb.) oyunu düşürmesin: 25 sn tolerans
  if (!g && sp.game && now - sp.gameSeen < 25e3) { g = sp.game.name; gDetail = sp.game.detail; r = sp.game.rich || null; }
  // Oyunun kendi servisi bir turluk cevap vermezse (ajan, mod, skor) ayrıntı düşüp "Oynuyor" yazısıyla gidip gelmesin
  const richNow = !!r;
  if (g && !r && sp.game?.name === g && sp.game.rich && now - (sp.richSeen || 0) < 25e3) { r = sp.game.rich; if (!gDetail) gDetail = sp.game.detail; }
  const m = music && typeof music.title === 'string' && music.title.trim() ? { title: clean(music.title, 120), artist: clean(music.artist, 120), album: clean(music.album, 120) || null } : null;
  srcs.set(srcId, { at: now, game: g ? { name: g, detail: gDetail, ...(r ? { rich: r } : {}) } : null, gameSeen: typeof game === 'string' && game.trim() ? now : sp.gameSeen || 0, richSeen: richNow ? now : sp.richSeen || 0, music: m, musicRaw: m ? music : null });
  // Birleştir: oyun bildiren en yeni kaynak, müzik bildiren en yeni kaynak
  const live = [...srcs.values()];
  const gs = live.filter(x => x.game).sort((a, b) => b.gameSeen - a.gameSeen)[0];
  const ms = live.filter(x => x.music).sort((a, b) => b.at - a.at)[0];
  const mm = ms ? { ...ms.music } : null;
  if (mm) {
    const dur = +ms.musicRaw.dur, pos = +ms.musicRaw.pos, same = prev.music?.title === mm.title && prev.music?.artist === mm.artist;
    if (dur > 1000 && dur < 3600e3 && pos >= 0 && pos <= dur) { mm.dur = Math.round(dur); mm.start = now - Math.round(pos); if (same && prev.music.start && Math.abs(prev.music.start - mm.start) < 8000) mm.start = prev.music.start; } // aynı şarkı: süre izleyicide kendiliğinden ilerler; sadece ileri/geri sarınca (8 sn+) yeniden gönderilir
    else mm.start = same ? prev.music.start : now;
    mm.art = same ? prev.music.art : null;
  }
  const gg = gs?.game;
  const next = { at: now,
    game: gg ? { name: gg.name, detail: gg.detail, start: prev.game?.name === gg.name ? prev.game.start : now, ...(gg.rich ? { rich: gg.rich } : {}) } : null,
    music: mm };
  const sig = x => JSON.stringify([x.game?.name, x.game?.detail, x.game?.rich && { ...x.game.rich }, x.music?.title, x.music?.artist, x.music?.start]);
  const changed = sig(prev) !== sig(next) || !prev.at || !!u.auto?.gone;
  u.auto = next;
  if (changed) {
    pushActivity(u);
    if (next.music && !next.music.art) albumArt(next.music.title, next.music.artist).then(a => { if (a && u.auto?.music?.title === next.music.title) { u.auto.music.art = a; pushActivity(u); } });
  }
  res.json({ ok: true });
});
setInterval(() => { // durumu bildirmeyi bırakanları temizle
  for (const u of Object.values(db.users)) if (u.auto && !u.auto.gone && Date.now() - u.auto.at > 45e3) { u.auto.gone = true; pushActivity(u); }
}, 15e3);
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false, lastModified: false, setHeaders: res => res.set('Cache-Control', 'no-store')
}));

// ---------- Veri ----------
// Veri tek dosyada (data.json). Yazım atomik: önce data.json.tmp yazılır ve diske işlenir, sonra yerine geçer;
// bir önceki sürüm data.json.bak olarak durur. Açılışta dosya bozuksa sırayla .bak ve günlük yedeklerden kurtarılır.
const zlib = require('zlib');
const BAK_FILE = DATA_FILE + '.bak', TMP_FILE = DATA_FILE + '.tmp';
const BACKUPS = path.join(DATA_DIR, 'yedekler');
const BACKUP_RE = /^data-\d{4}-\d{2}-\d{2}\.json(\.gz)?$/;
function readDbFile(f) {
  const raw = fs.readFileSync(f), txt = f.endsWith('.gz') ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
  const j = JSON.parse(txt);
  if (!j || typeof j !== 'object' || typeof j.users !== 'object' || !Array.isArray(j.servers)) throw new Error('beklenen alanlar yok');
  return j;
}
let dbRecovered = null, dbLoadedFrom = null;
function loadDb() {
  const backups = fs.existsSync(BACKUPS) ? fs.readdirSync(BACKUPS).filter(n => BACKUP_RE.test(n)).sort().reverse().map(n => path.join(BACKUPS, n)) : [];
  for (const f of [DATA_FILE, BAK_FILE, TMP_FILE, ...backups]) {
    if (!fs.existsSync(f)) continue;
    try {
      const j = readDbFile(f); dbLoadedFrom = f;
      if (f !== DATA_FILE) {
        dbRecovered = path.basename(f);
        console.error(`!!! data.json okunamadı, ${dbRecovered} dosyasından kurtarıldı`);
        if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, DATA_FILE + '.bozuk-' + Date.now());
      }
      return j;
    } catch (e) { console.error('Okunamadı:', path.basename(f), e.message); }
  }
  if (fs.existsSync(DATA_FILE)) { fs.copyFileSync(DATA_FILE, DATA_FILE + '.bozuk-' + Date.now()); console.error('!!! Hiçbir kopya okunamadı; bozuk dosya saklandı'); }
  return null;
}
let db = { users: {}, sessions: {}, servers: [], messages: {}, playlists: {} };
{ const j = loadDb(); if (j) Object.assign(db, j); }
// Sıfırlama: klasörde SIFIRLA.txt varsa her şey silinir ve uygulama sıfırdan başlar
const RESET_FLAG = path.join(DATA_DIR, 'SIFIRLA.txt');
if (fs.existsSync(RESET_FLAG)) {
  db = { users: {}, sessions: {}, servers: [], messages: {}, playlists: {} };
  for (const f of fs.readdirSync(UPLOADS)) { try { fs.unlinkSync(path.join(UPLOADS, f)); } catch {} }
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  for (const x of ['', '-wal', '-shm']) try { fs.rmSync(path.join(DATA_DIR, 'mesajlar.db' + x), { force: true }); } catch {}
  fs.unlinkSync(RESET_FLAG);
  console.log('Tüm veriler sıfırlandı.');
}
for (const k of ['users', 'sessions', 'messages', 'playlists']) db[k] ||= {};

// ---------- Mesaj deposu (SQLite) ----------
// Mesajlar bellekte eskisi gibi db.messages içinde durur; kod aynen çalışır. Değişen kanallar her kayıtta
// mesajlar.db'ye (SQLite) anında ve tek tek yazılır. data.json'a ise mesajların tam görüntüsü 10 dakikada bir
// alınır; arada data.json'a son görüntü aynen eklenir. Böylece her kayıtta 5+ MB'lık JSON üretilmez,
// zorla kapatmada mesaj kaybolmaz ve data.json her zaman tek başına eksiksiz bir yedek olarak kalır
// (eski sürüme dönülse en fazla 10 dakikalık mesaj değişikliği data.json'da eksik olur).
// Kapatmak için: KANKA_SQLITE=0 (data.json eskisi gibi her kayıtta tam yazılır).
const MSG_DB_FILE = path.join(DATA_DIR, 'mesajlar.db');
const MSG_SNAP_EVERY = 10 * 60e3, MSG_TOUCH_KEEP = 60e3;
const msgRaw = db.messages; // gerçek nesne (Proxy'siz). Sadece OKUYAN toplu işler (okunmamış sayacı, DM listesi, istatistik, dışa aktarma) bunu kullanır; yazan kod db.messages kullanmalı ki değişiklik SQLite'a gitsin
const msgTouched = new Map(), msgDeleted = new Set(); // kanal -> son erişim zamanı · silinen kanallar
let msgDb = null, msgQ = null, msgSnapJson = null, msgSnapAt = 0, lastStamp = 0;
{
  const snapAt = +db.msgSnapAt || 0, wrote = +db.msgWrittenAt || 0;
  delete db.msgSnapAt; delete db.msgWrittenAt;
  if (SQLITE_OK) try {
    const { DatabaseSync } = require('node:sqlite');
    const m = new DatabaseSync(MSG_DB_FILE);
    m.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=2000;'
      + 'CREATE TABLE IF NOT EXISTS kanal (ch TEXT PRIMARY KEY, data TEXT NOT NULL, at INTEGER NOT NULL);'
      + 'CREATE TABLE IF NOT EXISTS silinen (ch TEXT PRIMARY KEY, at INTEGER NOT NULL);'
      + 'CREATE TABLE IF NOT EXISTS bilgi (k TEXT PRIMARY KEY, v TEXT NOT NULL);');
    // data.json'u en son bu sürüm mü yazdı? Her yazımdan sonra dosyanın boyutu ve zamanı SQLite'a not edilir.
    // Eski bir sürüm (geri dönüş yapılmış) sonradan yazdıysa bunlar tutmaz: data.json daha yenidir, SQLite'taki kopyalar atılır.
    let st = null; try { st = fs.statSync(dbLoadedFrom || DATA_FILE); } catch {}
    const mark = (() => { try { return JSON.parse(m.prepare("SELECT v FROM bilgi WHERE k = 'json'").get()?.v || 'null'); } catch { return null; } })();
    const same = !!st && !!mark && mark.size === st.size && Math.abs(mark.mtime - st.mtimeMs) < 1;
    // data.json bozulup .bak/yedekten kurtarıldıysa SQLite'taki daha yeni kopyalar tam tersine çok değerli: hepsi üstüne konur.
    // Yazımla not arasında kapanılmışsa dosyadaki damga nottakinden yenidir (eski sürüm damgaya dokunmaz, olduğu gibi bırakır).
    const ours = dbLoadedFrom && dbLoadedFrom !== DATA_FILE ? true : same || (!!wrote && !!mark && wrote > (mark.stamp || 0));
    if (!ours && (m.prepare('SELECT COUNT(*) n FROM kanal').get().n || m.prepare('SELECT COUNT(*) n FROM silinen').get().n)) {
      console.log('mesajlar.db: data.json başka bir sürümce yazılmış, SQLite kopyası yenileniyor');
      m.exec('DELETE FROM kanal; DELETE FROM silinen;');
    } else if (ours) {
      let n = 0, d = 0;
      for (const r of m.prepare('SELECT ch, data FROM kanal WHERE at > ?').all(snapAt)) { try { msgRaw[r.ch] = JSON.parse(r.data); n++; } catch (e) { console.error('mesajlar.db okunamadı:', r.ch, e.message); } }
      for (const r of m.prepare('SELECT ch FROM silinen WHERE at > ?').all(snapAt)) { delete msgRaw[r.ch]; d++; }
      if (n || d) console.log(`mesajlar.db: ${n} kanal güncellendi, ${d} kanal silindi (data.json görüntüsünden sonraki değişiklikler)`);
    }
    if (process.env.KANKA_SQLITE !== '0') {
      msgDb = m;
      msgQ = {
        up: m.prepare('INSERT INTO kanal (ch, data, at) VALUES (?, ?, ?) ON CONFLICT(ch) DO UPDATE SET data = excluded.data, at = excluded.at'),
        unTomb: m.prepare('DELETE FROM silinen WHERE ch = ?'),
        del: m.prepare('DELETE FROM kanal WHERE ch = ?'),
        tomb: m.prepare('INSERT INTO silinen (ch, at) VALUES (?, ?) ON CONFLICT(ch) DO UPDATE SET at = excluded.at'),
        mark: m.prepare("INSERT INTO bilgi (k, v) VALUES ('json', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"),
      };
      // Eski kayıtları temizle: tam görüntüye girmiş silme işaretleri artık gereksiz
      m.prepare('DELETE FROM silinen WHERE at < ?').run(Date.now() - 7 * 864e5);
    } else m.close();
  } catch (e) { console.error('mesajlar.db açılamadı, sadece data.json kullanılacak:', e.message); msgDb = null; }
  if (msgDb) db.messages = new Proxy(msgRaw, {
    get(t, k) { if (typeof k === 'string' && Object.hasOwn(t, k)) msgTouched.set(k, Date.now()); return t[k]; },
    set(t, k, v) { t[k] = v; if (typeof k === 'string') { msgTouched.set(k, Date.now()); msgDeleted.delete(k); } return true; },
    deleteProperty(t, k) { delete t[k]; if (typeof k === 'string') { msgTouched.delete(k); msgDeleted.add(k); } return true; },
  });
}
// Erişilen (ve muhtemelen değişen) kanalları SQLite'a yaz. Erişimden sonra 60 sn boyunca her kayıtta yeniden yazılır:
// sonradan gelen değişiklikler (bağlantı önizlemesi vb.) de kaçmasın.
function msgPersist() {
  if (!msgDb || (!msgTouched.size && !msgDeleted.size)) return;
  const now = Date.now();
  msgDb.exec('BEGIN');
  try {
    for (const [ch, at] of msgTouched) {
      const list = msgRaw[ch];
      if (list) { msgQ.up.run(ch, JSON.stringify(list), now); msgQ.unTomb.run(ch); }
      if (now - at > MSG_TOUCH_KEEP) msgTouched.delete(ch);
    }
    for (const ch of msgDeleted) { msgQ.del.run(ch); msgQ.tomb.run(ch, now); }
    msgDb.exec('COMMIT');
    msgDeleted.clear();
  } catch (e) { try { msgDb.exec('ROLLBACK'); } catch {} throw e; }
}
// Kayıt ölçümü: her kayıtta sunucunun ne kadar donduğu (SQLite yazımı + JSON üretimi, ms). /api/surum'da görünür.
const saveStats = [];
function saveStat(x) { saveStats.push(x); if (saveStats.length > 200) saveStats.shift(); }
function saveSummary() {
  if (!saveStats.length) return null;
  const r = n => Math.round(n * 10) / 10, tot = saveStats.map(x => x.sqlite + x.json), part = saveStats.filter(x => !x.tam);
  const avg = a => a.length ? a.reduce((p, c) => p + c, 0) / a.length : 0;
  return { adet: saveStats.length, ortMs: r(avg(tot)), maxMs: r(Math.max(...tot)), ortSqliteMs: r(avg(saveStats.map(x => x.sqlite))), ortJsonMs: r(avg(part.map(x => x.json))),
    tamGoruntuMs: r(avg(saveStats.filter(x => x.tam).map(x => x.json))), ortKanal: r(avg(saveStats.map(x => x.kanal))), dosyaMB: r(saveStats.at(-1).mb) };
}
// data.json yazıldıktan sonra: boyutunu ve zamanını not et (açılışta "bu dosyayı ben mi yazdım" kontrolü için)
function msgMarkJson(stamp) { if (!msgDb) return; try { const st = fs.statSync(DATA_FILE); msgQ.mark.run(JSON.stringify({ size: st.size, mtime: st.mtimeMs, stamp })); } catch (e) { console.error('mesajlar.db notu:', e.message); } }
// data.json metni: SQLite açıksa mesajlar en fazla 10 dakikada bir yeniden JSON'a çevrilir, arada son görüntü eklenir
function dbJson(full) {
  if (!msgDb) return JSON.stringify(db);
  const now = Date.now();
  if (full || msgSnapJson === null || now - msgSnapAt > MSG_SNAP_EVERY) { msgSnapAt = now; msgSnapJson = JSON.stringify(msgRaw); }
  const { messages, ...rest } = db;
  lastStamp = Math.max(Date.now(), lastStamp + 1); // her yazımın damgası farklı ve artan
  const head = JSON.stringify({ ...rest, msgSnapAt, msgWrittenAt: lastStamp });
  return head.slice(0, -1) + (head.length > 2 ? ',' : '') + '"messages":' + msgSnapJson + '}';
}
// Oturum ve şifre sıfırlama anahtarları veritabanında açık değil, özet (SHA-256) olarak saklanır:
// yedek dosyası bir yere sızsa bile içindeki anahtarlarla kimsenin hesabına girilemez.
const tokH = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const SESS_TTL = 90 * 864e5;
if (!db.sessHashed) { const o = {}, r = {}; for (const [t, n] of Object.entries(db.sessions || {})) o[tokH(t)] = n; for (const [t, x] of Object.entries(db.resets || {})) r[tokH(t)] = x; db.sessions = o; if (db.resets) db.resets = r; db.sessHashed = true; }
db.sessAt ||= {};
const sessGet = t => { if (typeof t !== 'string' || t.length < 20 || t.length > 100) return null; const h = tokH(t); return Object.hasOwn(db.sessions, h) ? db.sessions[h] : null; };
function sessNew(name) { const t = crypto.randomBytes(24).toString('hex'), h = tokH(t); db.sessions[h] = name; db.sessAt[h] = Date.now(); return t; }
function sessDel(t) { if (typeof t !== 'string') return; const h = tokH(t); delete db.sessions[h]; delete db.sessAt[h]; }
function sessDelUser(name) { for (const [h, n] of Object.entries(db.sessions)) if (n === name) { delete db.sessions[h]; delete db.sessAt[h]; } }
setInterval(() => { const now = Date.now(); let n = 0; for (const h of Object.keys(db.sessions)) { const at = db.sessAt[h] ||= now; if (now - at > SESS_TTL) { delete db.sessions[h]; delete db.sessAt[h]; n++; } } for (const h of Object.keys(db.sessAt)) if (!db.sessions[h]) delete db.sessAt[h]; if (n) save(); }, 3600e3);
db.servers ||= [];
if (!db.servers.find(s => s.id === 's1')) {
  db.servers.unshift({ id: 's1', name: 'Kanka HQ', icon: 'K', channels: [{ id: 'c1', name: 'genel' }, { id: 'c2', name: 'duyurular' }, { id: 'c3', name: 'oyun' }] });
}
for (const s of db.servers) {
  s.members ||= [];
  s.invite ||= newInviteCode();
  s.public = s.id === 's1' || (!s.owner && !s.members.length); // hesaplardan önce açılan sunucular herkese açık kalsın
  s.roles ||= {}; s.customRoles ||= []; s.memberRoles ||= {}; s.bans ||= {}; s.timeouts ||= {};
  for (const c of s.channels) c.type ||= 'text';
  if (s.id === 's1' && !s.channels.some(c => c.type === 'voice')) s.channels.push({ id: 'v1', name: 'Sohbet', type: 'voice' });
  // Resmi sunucunun afişi ve simgesi (bir kez uygulanır; yönetici sonra değiştirebilir)
  if (s.id === 's1' && !s.tagV1) { s.tag ||= { t: 'KHQ', i: '🦝', c: '#c8ff00', on: true, at: 0, by: null }; s.tagV1 = true; } // sunucu etiketi testi
  if (s.id === 's1' && !s.tagFix1) { if (s.tag) s.tag.on = true; s.tagFix1 = true; } // yanlışlıkla kapatılan test etiketini bir kez geri aç
  if (s.id === 's1' && !s.brandV1) { s.banner ||= '/marka/hq-afis.png'; s.iconImg ||= '/marka/hq-simge.png'; s.brandV1 = true; }
  if (s.id === 's1' && !s.brandV2) { if (s.banner === '/marka/hq-afis.png') s.banner = '/marka/hq-afis.gif'; if (s.iconImg === '/marka/hq-simge.png') s.iconImg = '/marka/hq-simge.gif'; s.brandV2 = true; } // hareketli sürüm
}

function ensureOwners() {
  const first = Object.values(db.users).filter(u => u.name !== 'Claude').sort((a, b) => a.createdAt - b.createdAt)[0];
  for (const s of db.servers) if (!s.owner && first) s.owner = first.name;
}
ensureOwners();
for (const u of Object.values(db.users)) delete u.manual; // elle etkinlik kaldırıldı

// ---------- Günlük yedek: sıkıştırılmış kopya, son 14 gün saklanır ----------
let lastBackup = null;
function backup(force) {
  try {
    if (!fs.existsSync(DATA_FILE)) return null;
    fs.mkdirSync(BACKUPS, { recursive: true });
    const name = `data-${new Date().toISOString().slice(0, 10)}.json.gz`, f = path.join(BACKUPS, name);
    if (force || !fs.existsSync(f)) {
      if (saveTimer || dbDirty || dbWriting || msgDb) { writeDbNow(); dbDirty = false; }
      const gz = zlib.gzipSync(fs.readFileSync(DATA_FILE), { level: 9 });
      readDbFile(DATA_FILE); // bozuk veriyi yedeğe koyma
      fs.writeFileSync(f + '.tmp', gz); fs.renameSync(f + '.tmp', f);
      console.log('Yedek alındı:', name, Math.round(gz.length / 1024) + ' KB');
      if (!force) mailBackup(f, name).catch(() => {});
    }
    const all = fs.readdirSync(BACKUPS).filter(n => BACKUP_RE.test(n)).sort();
    for (const old of all.slice(0, Math.max(0, all.length - 14))) fs.unlinkSync(path.join(BACKUPS, old));
    lastBackup = { name, at: Date.now() };
    return name;
  } catch (e) { console.error('Yedek alınamadı', e.message); return null; }
}
// Her gün yedeğin bir kopyası yöneticinin e-postasına gider (e-posta çalışıyorsa); 20 MB üstü gönderilmez
async function mailBackup(f, name) {
  if (db.backupCfg?.mail === false || !mailCfg?.ok) return false;
  const size = fs.statSync(f).size; if (size > 20 * 1024 * 1024) return false;
  const owner = db.servers.find(x => x.id === 's1')?.owner, to = db.users[owner]?.email || mailCfg.user;
  const ok = await sendMail(to, `Kanka yedeği · ${name.slice(5, 15)}`, mailHtml('Günlük yedek', `Kanka Chat'in ${name.slice(5, 15)} tarihli veritabanı yedeği ekte (${Math.round(size / 1024)} KB). Sunucuya bir şey olursa bu dosyadan geri yüklenebilir. Bu e-postayı silme.`), [{ filename: 'kanka-' + name, path: f }]);
  db.backupLog = { ...(db.backupLog || {}), mail: { at: Date.now(), ok, to } }; save();
  return ok;
}
const backupList = () => fs.existsSync(BACKUPS) ? fs.readdirSync(BACKUPS).filter(n => BACKUP_RE.test(n)).sort().reverse().map(n => ({ name: n, size: fs.statSync(path.join(BACKUPS, n)).size, at: fs.statSync(path.join(BACKUPS, n)).mtimeMs })) : [];

// ---------- Kötüye kullanım koruması ----------
const limits = new Map();
// key için pencere içinde en fazla max deneme; aşılırsa kalan bekleme süresini (sn) döndürür
// Mesaj seli: hız sınırına 1 dakikada 3 kez takılan geçici olarak hiç yazamaz. Tekrar ederse süre artar (5 dk → 15 dk → 1 saat), 24 saatte sıfırlanır.
const floodPen = new Map(); // isim -> { until, lvl, at, strikes: [] }
function msgFlood(me) {
  const now = Date.now(), p = floodPen.get(me) || { until: 0, lvl: 0, at: 0, strikes: [] };
  if (p.until > now) return `Çok fazla mesaj attığın için ${Math.ceil((p.until - now) / 60e3)} dakika yazamazsın`;
  if (!limited('msg|' + me, 8, 5000)) return null;
  p.strikes = p.strikes.filter(t => now - t < 60e3); p.strikes.push(now);
  if (p.strikes.length >= 3) {
    if (now - p.at > 864e5) p.lvl = 0;
    const dk = [5, 15, 60][Math.min(p.lvl, 2)]; p.lvl++; p.at = now; p.until = now + dk * 60e3; p.strikes = [];
    floodPen.set(me, p); secLog('mesaj-seli', me, `hız sınırını zorladı, ${dk} dk yazma cezası`);
    return `Çok hızlı ve çok fazla mesaj attın, ${dk} dakika yazamazsın`;
  }
  floodPen.set(me, p); return 'Çok hızlı yazıyorsun, biraz yavaşla 🙂';
}
setInterval(() => { const now = Date.now(); for (const [k, v] of floodPen) if (v.until < now && now - v.at > 864e5 && !v.strikes.some(t => now - t < 60e3)) floodPen.delete(k); }, 600e3);
function limited(key, max, windowMs) {
  const now = Date.now(), arr = (limits.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) { limits.set(key, arr); return Math.ceil((windowMs - (now - arr[0])) / 1000); }
  arr.push(now); limits.set(key, arr); return 0;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of limits) if (!v.length || now - v[v.length - 1] > 3600e3) limits.delete(k); }, 600e3);

// ---------- TURN: farklı ağlardaki kişiler sesli odada birbirini duysun ----------
const TURN_FILE = path.join(DATA_DIR, 'turn.json');
let turnInfo = null;
async function startTurn(attempt = 1) {
  if (process.env.TURN === 'off' || (process.platform !== 'win32' && process.env.TURN !== 'on')) return;
  try {
    const Turn = require('node-turn');
    let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(TURN_FILE, 'utf8')); } catch {}
    if (!cfg.pass) { cfg = { user: 'kanka', pass: crypto.randomBytes(16).toString('hex') }; fs.writeFileSync(TURN_FILE, JSON.stringify(cfg)); }
    let ip = process.env.PUBLIC_IP;
    // Genel IP: bulunamazsa (açılışta internet geç gelebilir) son bilinen IP kullanılır
    if (!ip) { try { const r = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(8000) }); ip = (await r.text()).trim(); } catch (e) { if (!cfg.ip) throw e; ip = cfg.ip; console.log('TURN: genel IP alınamadı, son bilinen kullanılıyor'); } }
    if (/^\d+\.\d+\.\d+\.\d+$/.test(ip) && cfg.ip !== ip) { cfg.ip = ip; try { fs.writeFileSync(TURN_FILE, JSON.stringify(cfg)); } catch {} }
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) throw new Error('Genel IP bulunamadı');
    if (process.platform === 'win32') { // güvenlik duvarında TURN portlarını aç (bir kez)
      const { execFileSync } = require('child_process');
      try { execFileSync('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=Kanka Chat TURN'], { stdio: 'ignore' }); }
      catch { try { execFileSync('netsh', ['advfirewall', 'firewall', 'add', 'rule', 'name=Kanka Chat TURN', 'dir=in', 'action=allow', 'protocol=UDP', 'localport=3478,50000-50200'], { stdio: 'ignore' }); } catch {} }
    }
    const server = new Turn({ authMech: 'long-term', credentials: { [cfg.user]: cfg.pass }, realm: 'kanka', listeningPort: 3478, minPort: 50000, maxPort: 50200, externalIps: ip, debugLevel: 'OFF' });
    // node-turn 0.0.6 hatası: yenileme (Refresh) isteği tanımsız ayar adlarını (defaultLifetime, maxAllocateTimeout) okuyor,
    // süre NaN çıkıyor ve ayrılan röle 1 ms sonra siliniyor. Sonuç: TURN üzerinden giden sesli görüşme ilk yenilemede
    // (birkaç dakika sonra) kopuyordu. Günlükteki "TimeoutNaNWarning" bundandı.
    server.defaultLifetime = server.defaultAllocatetLifetime || 600;
    server.maxAllocateTimeout = server.maxAllocateLifetime || 3600;
    try { // Allocate tekrarında da süre verilmeden çağrılıyor: mevcut süreyi kullan
      const Alloc = require('node-turn/lib/allocation'), upd = Alloc.prototype.update;
      if (!upd.kankaFix) { Alloc.prototype.update = function (l) { return upd.call(this, l === 0 ? 0 : Number.isFinite(+l) && +l > 0 ? +l : this.lifetime); }; Alloc.prototype.update.kankaFix = true; }
    } catch (e) { console.error('TURN yaması uygulanamadı:', e.message); }
    server.start();
    turnInfo = { urls: [`turn:${ip}:3478?transport=udp`], username: cfg.user, credential: cfg.pass };
    console.log('TURN sunucusu çalışıyor:', ip + ':3478');
    if (attempt > 1) try { io.emit('ice', iceServers()); } catch {} // geç açıldıysa bağlı olanlara da bildir
  } catch (e) {
    console.error('TURN başlatılamadı:', e.message);
    // farklı ağlardaki kişiler birbirini duyamaz; birkaç kez yeniden dene (bilgisayar yeni açıldıysa internet geç gelebilir)
    if (attempt < 6) setTimeout(() => startTurn(attempt + 1), Math.min(300e3, 20e3 * attempt));
  }
}
startTurn();
const iceServers = () => [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }, ...(turnInfo ? [turnInfo] : [])];

let saveTimer = null, saveFails = 0, syncGen = 0, dbDirty = false, dbWriting = false;
// Atomik yazım: yarım kalan bir yazım asla data.json'u bozamaz
function writeDbNow() {
  clearTimeout(saveTimer); saveTimer = null;
  try {
    try { msgPersist(); } catch (e) { console.error('mesajlar.db yazılamadı:', e.message); }
    const txt = dbJson(true), stamp = lastStamp;
    const fd = fs.openSync(TMP_FILE, 'w');
    try { fs.writeSync(fd, txt); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (fs.existsSync(DATA_FILE)) { try { fs.copyFileSync(DATA_FILE, BAK_FILE); } catch {} }
    syncGen++; // süren bir asenkron yazım varsa artık eski: onu data.json'un üstüne koyma
    let tries = 0;
    for (;;) { try { fs.renameSync(TMP_FILE, DATA_FILE); break; } catch (e) { if (++tries > 5) throw e; const t = Date.now() + 40; while (Date.now() < t); } } // Windows'ta dosya anlık kilitli olabilir
    msgMarkJson(stamp);
    saveFails = 0;
  } catch (e) { saveFails++; console.error('Kayıt yazılamadı (' + saveFails + '):', e.message); setTimeout(save, Math.min(30e3, 1000 * saveFails)); }
}
// Erişimi kalkan (atılan, yasaklanan, gruptan çıkan, odayı görme izni alınan) kişi açık tuttuğu odanın canlı akışından düşsün
let roomCheckQ = false;
function roomCheck() {
  roomCheckQ = false;
  for (const sk of io.sockets.sockets.values()) {
    const c = sk.data.cur; if (!c || canAccess(sk.data.name, c)) continue;
    sk.leave(c); sk.data.cur = null; sk.emit('roomLost', c);
  }
}
// Normal kayıt asenkron: diske yazarken sunucu donmaz (sesli sohbet, mesajlar takılmaz).
// Yazım sürerken gelen değişiklikler bitince tek seferde yazılır; aynı anda iki yazım olmaz.
const TMP_ASYNC = DATA_FILE + '.tmpa';
async function writeDbAsync() {
  saveTimer = null;
  if (dbWriting) { dbDirty = true; return; }
  dbWriting = true; dbDirty = false;
  const gen = syncGen;
  try {
    const t0 = performance.now(), nCh = msgTouched.size;
    try { msgPersist(); } catch (e) { console.error('mesajlar.db yazılamadı:', e.message); }
    const t1 = performance.now(), snap0 = msgSnapAt;
    const txt = dbJson(false), stamp = lastStamp;
    saveStat({ sqlite: t1 - t0, json: performance.now() - t1, kanal: nCh, mb: txt.length / 1e6, tam: msgSnapAt !== snap0 });
    const fh = await fs.promises.open(TMP_ASYNC, 'w');
    try { await fh.writeFile(txt); await fh.sync(); } finally { await fh.close(); }
    // bu arada senkron (daha yeni) bir yazım olduysa bu eski kopyayı data.json'un üstüne koyma
    if (gen === syncGen) { try { await fs.promises.copyFile(DATA_FILE, BAK_FILE); } catch {} }
    for (let tries = 0; gen === syncGen; tries++) { try { await fs.promises.rename(TMP_ASYNC, DATA_FILE); msgMarkJson(stamp); break; } catch (e) { if (tries >= 5) throw e; await new Promise(r => setTimeout(r, 40)); } } // Windows'ta dosya anlık kilitli olabilir
    saveFails = 0;
  } catch (e) { saveFails++; dbDirty = true; console.error('Kayıt yazılamadı (' + saveFails + '):', e.message); await new Promise(r => setTimeout(r, Math.min(30e3, 1000 * saveFails))); }
  finally { dbWriting = false; }
  if (dbDirty && !saveTimer) saveTimer = setTimeout(writeDbAsync, 300);
}
function save() {
  if (!roomCheckQ) { roomCheckQ = true; setImmediate(roomCheck); }
  dbDirty = true;
  if (saveTimer || dbWriting) return; // 300 ms içindeki tüm değişiklikler tek yazımda; yazım sürüyorsa bitince yazılır
  saveTimer = setTimeout(writeDbAsync, 300);
}
// Kapanırken bekleyen değişiklikleri senkron yaz (süren asenkron yazım yarım kalsa da data.json hep sağlam kalır)
const flushDb = () => { if (saveTimer || dbDirty || dbWriting) { writeDbNow(); dbDirty = false; } };
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) { try { process.on(sig, () => { if (typeof gracefulShutdown === 'function') gracefulShutdown(sig); else { flushDb(); process.exit(0); } }); } catch {} }
process.on('exit', flushDb);
if (dbRecovered) { try { fs.unlinkSync(DATA_FILE); } catch {} writeDbNow(); } // kurtarılan veriyi hemen sağlam dosyaya yaz (bozuk kopya .bozuk-… olarak saklandı)
setTimeout(() => backup(), 5000); setInterval(backup, 60 * 60e3);

// ---------- Yardımcılar ----------
const id = () => crypto.randomBytes(5).toString('hex');
const clean = (s, max) => String(s ?? '').trim().slice(0, max);
const MSG_MAX = 4000;
const cleanMsg = s => String(s ?? '').trim().slice(0, MSG_MAX); // mesaj metinleri en çok 4000 karakter (çok büyük mesajla sunucuyu şişirmeyi engeller)
const COLORS = ['#ff7a59', '#f6c445', '#4cc38a', '#4aa8ff', '#b07cff', '#ff6b9a', '#2fd3c3', '#ff9f43'];
const NAME_RE = /^[\p{L}\p{N}_.-]{2,20}$/u;
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
// Girişte şifre kontrolü asenkron: scrypt iş parçacığında çalışır, çok sayıda giriş denemesi sunucuyu dondurmaz. Karşılaştırma sabit sürede.
const hashPwAsync = (pw, salt) => new Promise((ok, no) => crypto.scrypt(pw, salt, 32, (e, k) => e ? no(e) : ok(k.toString('hex'))));
const DUMMY_SALT = crypto.randomBytes(16).toString('hex');
const pwOk = async (u, pw) => {
  const h = await hashPwAsync(String(pw ?? ''), u?.salt || DUMMY_SALT); // kullanıcı yoksa da aynı süre: var/yok tahmin edilemesin
  return !!u?.hash && h.length === u.hash.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(u.hash));
};
const level = xp => Math.floor(Math.sqrt((xp || 0) / 5)) + 1;
// ---- Adil XP ----
// Mesaj: dakikada en fazla bir kez 3-6 XP (hızlı yazmak/spam avantaj değil); çok kısa ya da aynı mesaj XP vermez.
// Ses: odada en az 2 kişi varken dakikada 2 XP (mikrofon kapalıysa 1), sağırlaştırılmış/AFK değilse; günde en fazla 240 XP.
// XP her yerden addXp ile verilir: seviye atlanınca kişiye kutlama gider.
function addXp(name, n, why, srv, chId) {
  const u = db.users[name]; if (!u || !(n > 0)) return 0;
  const b = level(u.xp); u.xp = (u.xp || 0) + n; const a = level(u.xp);
  if (a > b) setTimeout(() => io.to('user:' + name).emit('levelUp', { level: a, from: b, why: why || null }), 300);
  if (srv && !srv.public && srv.levels?.on !== false) srvXp(srv, name, n, chId);
  return a - b;
}
// ---- Sunucu seviyeleri: her sunucunun kendi XP'si, sıralaması ve rol ödülleri ----
// s.levels = { on, announce: 'same' | 'channel' | 'off', channel, rewards: [{ level, role }], stack }
function srvXp(s, name, n, chId) {
  s.xp ||= {}; const b = level(s.xp[name]); s.xp[name] = (s.xp[name] || 0) + n; const a = level(s.xp[name]);
  if (a <= b) return;
  const cfg = s.levels || {}, rw = (cfg.rewards || []).filter(r => r.level <= a && s.customRoles?.some(x => x.id === r.role)).sort((x, y) => x.level - y.level);
  let got = null;
  if (rw.length) { s.memberRoles ||= {}; const l = new Set(s.memberRoles[name] || []), top = rw[rw.length - 1];
    if (cfg.stack === false) for (const r of rw) if (r !== top) l.delete(r.role);
    for (const r of cfg.stack === false ? [top] : rw) if (!l.has(r.role)) { l.add(r.role); if (r.level === a || r === top) got = s.customRoles.find(x => x.id === r.role); }
    s.memberRoles[name] = [...l]; setTimeout(() => pushServers(membersOf(s)), 50); }
  const mode = cfg.announce || 'same'; if (mode === 'off' || !s.bot?.added) return; // duyuruyu Kanka Bot yapar: sunucuya eklenmemişse sessiz
  const to = mode === 'channel' && s.channels.some(c => c.id === cfg.channel) ? cfg.channel : chId;
  if (!to || voiceLike(findChannel(to)?.c?.type)) return;
  setTimeout(() => botPost(to, { title: `🎉 ${db.users[name]?.displayName || name} bu sunucuda seviye ${a} oldu!`, text: got ? `Yeni rol kazandı: ${got.name}` : 'Sohbet etmeye devam, sıradaki seviye seni bekliyor.', tone: 'ok', fields: got ? [['Sunucu seviyesi', String(a)], ['Ödül', got.name]] : null }), 400);
}
// Profil: çerçeveler (seviyeyle açılır) ve sosyal bağlantılar
const FRAMES = { halka: 2, gokkusagi: 5, ates: 10, neon: 15, altin: 25, kurucu: 0 };
const PEFFECTS = ['glitch', 'matrix', 'starry', 'embers', 'lightning', 'snow', 'rain', 'sakura', 'sparkles'];
const PEFFECTS_OWNER = ['dragon_crimson', 'dragon_jade', 'dragon_frost', 'vfx_inferno', 'vfx_volt', 'vfx_rift', 'vfx_blackhole', 'vfx_aurora'];
const NAME_BANNERS = ['cyberlime', 'embers', 'magma', 'frostbite', 'deepsea', 'thunder', 'nebula', 'eclipse', 'prism', 'sakura', 'goldsilk'];
const SOCIALS = ['instagram', 'tiktok', 'youtube', 'x', 'twitch', 'steam', 'spotify'];
const kurucuOk = u => Object.values(db.users).filter(x => (x.createdAt || 0) < (u.createdAt || 0)).length < 100;
const frameOk = (u, f) => f === 'none' || (f in FRAMES && (f === 'kurucu' ? kurucuOk(u) : level(u.xp) >= FRAMES[f]));
const effectOk = (u, ef) => !ef || ef === 'none' || PEFFECTS.includes(ef) || (PEFFECTS_OWNER.includes(ef) && staffRank(u.name) === 'owner');
const nameBannerOk = (u, nb) => !nb || nb === 'none' || NAME_BANNERS.includes(nb);
const NS_FONTS = ['default', 'serif', 'cinzel', 'rounded', 'script', 'pixel', 'cyber', 'mono'];
const NS_MODES = ['none', 'solid', 'gradient'];
const NS_ANIMS = ['none', 'flow', 'shimmer', 'glow', 'rainbow'];
const HEX = /^#[0-9a-f]{6}$/i;
const cleanNameStyle = ns => {
  if (!ns || typeof ns !== 'object') return null;
  const font = NS_FONTS.includes(ns.font) ? ns.font : 'default';
  const mode = NS_MODES.includes(ns.mode) ? ns.mode : 'none';
  const anim = NS_ANIMS.includes(ns.anim) ? ns.anim : 'none';
  const c1 = HEX.test(ns.c1) ? ns.c1 : '#d4ff00';
  const c2 = HEX.test(ns.c2) ? ns.c2 : '#ec4899';
  return font === 'default' && mode === 'none' && anim === 'none' ? null : { font, mode, c1, c2, anim };
};
// ---- Kalıcı kullanıcı kimliği ----
// Ad değişse de değişmeyen sayısal kimlik (Discord'daki gibi). Hesabın açıldığı zamandan türetilir: (ms - 2025-01-01) << 12 | sıra.
// Botlar ve geliştiriciler kullanıcıyı bununla saklar; ad değişince bağ kopmaz.
const UID_EPOCH = 1735689600000n;
let uidSeq = 0, uidIdx = null;
function uidIndex() { if (!uidIdx) { uidIdx = new Map(); for (const [n, u] of Object.entries(db.users)) if (u?.id) uidIdx.set(u.id, n); } return uidIdx; }
function mkUid(t) {
  const idx = uidIndex(), base = BigInt(Math.max(0, Math.floor(Number(t) || Date.now()))) - UID_EPOCH;
  let v; do v = (((base < 0n ? 0n : base) << 12n) | BigInt(uidSeq++ & 4095)).toString(); while (idx.has(v));
  return v;
}
function uidOf(u) {
  if (!u) return null;
  if (!u.id) { u.id = mkUid(u.createdAt); if (u.name) uidIndex().set(u.id, u.name); save(); }
  return u.id;
}
const isUid = x => typeof x === 'string' && /^\d{12,20}$/.test(x);
function userById(id) {
  id = String(id || ''); if (!isUid(id)) return null;
  let n = uidIndex().get(id);
  if (n && db.users[n]?.id === id) return db.users[n];
  uidIdx = null; n = uidIndex().get(id); // ad değişti ya da hesap silindi: dizini yeniden kur
  return n && db.users[n]?.id === id ? db.users[n] : null;
}
// Kimlik ya da ad verilir, kullanıcı adı döner (önce kimlik denenir)
const nameOfRef = ref => { ref = String(ref || ''); const byId = userById(ref); return byId ? byId.name : db.users[ref] ? ref : null; };
function migrateUids() { // eski hesaplara, açılış sırasına göre kimlik ver
  const miss = Object.entries(db.users).filter(([, u]) => u && !u.id).sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));
  for (const [n, u] of miss) { u.name ||= n; u.id = mkUid(u.createdAt); uidIndex().set(u.id, n); }
  if (miss.length) { save(); console.log(`Kullanıcı kimliği: ${miss.length} hesaba kalıcı kimlik verildi`); }
}
// ---------- Sunucu etiketi (Discord'daki gibi isim yanında küçük etiket) ----------
// Test aşamasında: sadece TAG.cfg.servers listesindeki sunucular etiket açabilir (başta Kanka HQ),
// TAG.cfg.who = 'ekip' ise sadece Kanka ekibi, 'uye' ise o sunucunun tüm üyeleri takabilir. Ayar site yöneticisinde.
// Sunucu: s.tag = { t: 'KHQ', i: '🦝', c: '#c8ff00', on: true, at, by } · Kullanıcı: u.tag = sunucu id
const TAG_ICONS = ['🦝', '🔥', '⚡', '🎮', '👑', '💎', '🌙', '⭐', '🍀', '🐺', '🦊', '🐉', '🎧', '🎯', '🏆', '🚀', '💀', '❤️', '🌊', '🍕', '🎵', '🌸', '🛡️', '⚔️'];
const TAG_COLORS = ['#c8ff00', '#ff7a59', '#4aa8ff', '#b07cff', '#ff6b9a', '#2fd3c3', '#f6c445', '#4cc38a', '#e5484d', '#e4e4e7'];
const TAG_RESERVED = ['ADMN', 'ADMIN', 'KNKA', 'EKIP', 'EKİP', 'MOD', 'RESMI', 'RESMİ', 'KHQ', 'STAF', 'DEV'];
const TAG = {
  cfg() { return (db.tagCfg ||= { servers: ['s1'], who: 'ekip' }); },
  allowedServer: s => !!s && TAG.cfg().servers.includes(s.id),
  defOf(s) { return s && TAG.allowedServer(s) && s.tag?.on && s.tag.t ? { t: s.tag.t, i: s.tag.i, c: s.tag.c, ad: s.name, simge: s.icon || null, simgeImg: s.iconImg || null } : null; },
  defs() { const o = {}; for (const s of db.servers) { const d = TAG.defOf(s); if (d) o[s.id] = d; } return o; },
  canUse(n, s) { const u = db.users[n]; if (!u || u.bot || !s || !TAG.defOf(s)) return false; if (!(s.public || s.members.includes(n)) || s.bans?.[n]) return false; return TAG.cfg().who === 'uye' || !!staffRank(n); },
  canList: n => db.servers.filter(s => TAG.canUse(n, s)).map(s => s.id),
  of(u) { if (!u?.tag) return null; const s = db.servers.find(x => x.id === u.tag); return TAG.canUse(u.name, s) ? s.id : null; },
  push() { const d = TAG.defs(); io.emit('tagDefs', d); for (const [sid, n] of online) io.to(sid).emit('tagCan', TAG.canList(n)); pushUsers(); },
};
const pubUser = u => ({ sp: sparkOn(u) ? u.spark.since : null, id: uidOf(u), displayName: u.displayName || '', pronouns: u.pronouns || '', theme: u.theme && (sparkOn(u) || staffRank(u.name) === 'owner') ? u.theme : null, intro: u.intro && (sparkOn(u) || staffRank(u.name) === 'owner') ? u.intro : null, bannerImg: u.bannerImg || null, frame: u.frame || null, effect: u.effect && (!PEFFECTS_OWNER.includes(u.effect) || staffRank(u.name) === 'owner') ? u.effect : null, nameBanner: u.nameBanner || null, nameStyle: staffRank(u.name) === 'owner' ? (u.nameStyle || null) : null, socials: u.socials || {}, kurucu: kurucuOk(u), name: u.name, color: u.color, xp: u.xp || 0, level: level(u.xp), avatar: u.avatar || null, status: u.status || '', bio: u.bio || '', banner: u.banner || null, createdAt: u.createdAt || null,
  birthday: u.birthday || null, music: u.music || null, ...(u.bot ? { bot: { app: u.bot.app, dogrulandi: !!db.apps?.[u.bot.app]?.verified, sahip: db.apps?.[u.bot.app]?.owner || null } } : {}), activities: activitiesOf(u), tg: u.bot ? null : TAG.of(u), badges: shownBadges(u), ach: u.bot ? undefined : achOf(u), betaNo: betaNoOf(u), streak: u.streak?.count || 0, friendCount: (u.friends || []).length });
const social = n => { const u = db.users[n] || {}; return { friends: u.friends || [], reqIn: u.reqIn || [], reqOut: u.reqOut || [], blocked: u.blocked || [] }; };
const pushSocial = (...names) => names.forEach(n => io.to('user:' + n).emit('social', social(n)));
const allUsers = () => Object.values(db.users).map(pubUser);

const serversFor = name => db.servers.filter(s => (s.public || s.members.includes(name)) && !s.bans?.[name]);
// ---------- Roller ve izinler ----------
const PERMS = ['administrator', 'manageServer', 'manageRoles', 'manageChannels', 'manageEmojis', 'manageWebhooks', 'viewAudit', 'manageMessages', 'pinMessages', 'slowBypass', 'mentionEveryone', 'kick', 'ban', 'timeout', 'voiceMute', 'voiceMove', 'manageSounds'];
const MOD_PERMS = ['manageChannels', 'manageEmojis', 'manageSounds', 'viewAudit', 'manageMessages', 'pinMessages', 'slowBypass', 'kick', 'timeout', 'mentionEveryone', 'voiceMute', 'voiceMove'];
function permsOf(s, n) {
  if (s.owner === n) return new Set(PERMS);
  const p = new Set(s.roles?.[n] === 'mod' ? MOD_PERMS : []);
  for (const rid of s.memberRoles?.[n] || []) for (const x of s.customRoles.find(r => r.id === rid)?.perms || []) p.add(x);
  return p.has('administrator') ? new Set(PERMS) : p; // Yönetici: her yetki + odalardaki tüm kısıtlamaları aşar
}
const can = (s, n, perm) => permsOf(s, n).has(perm);
const rankOf = (s, n) => s.owner === n ? 1e9 : Math.max(s.roles?.[n] === 'mod' ? 500 : 0, ...(s.memberRoles?.[n] || []).map(rid => { const i = s.customRoles.findIndex(r => r.id === rid); return i < 0 ? 0 : 1000 - i; }));
const outranks = (s, a, b) => s.owner === a || rankOf(s, a) > rankOf(s, b);
const timedOut = (s, n) => (s.timeouts?.[n] || 0) > Date.now();
// ---------- Kategoriler ve oda izinleri ----------
// Her oda/kategori: perms = { '@everyone' | rolId: { view, send, connect } } (true izin, false yasak, yoksa devral)
// Eşitlenmiş oda (sync) kategorisinin izinlerini kullanır.
const CH_KEYS = ['view', 'send', 'history', 'connect', 'attach', 'embed', 'react', 'mention', 'apps', 'thread', 'manage', 'video', 'stream', 'speak', 'soundboard'];
// 'video' (kamera) eskiden 'stream' ile birlikteydi: bir katmanda video yazılmamışsa o katmandaki stream değeri geçerli
const ovGet = (o, k) => o?.[k] !== undefined ? o[k] : k === 'video' ? o?.stream : undefined;
const voiceLike = t => t === 'voice' || t === 'stage';
const stage = new Map(); // sahne odası: chId -> { speakers: Set, hands: Set }
const stageOf = ch => { if (!stage.has(ch)) stage.set(ch, { speakers: new Set(), hands: new Set() }); return stage.get(ch); };
const stageView = ch => { const st = stageOf(ch); return { speakers: [...st.speakers], hands: [...st.hands] }; };
const catOf = (s, c) => c.cat ? (s.categories || []).find(k => k.id === c.cat) : null;
const ovOf = (s, c) => { const k = catOf(s, c); return (c.sync && k ? k.perms : c.perms) || {}; };
function chPermWith(s, ov, n, key) {
  if (s.owner === n || can(s, n, 'manageChannels')) return true;
  if (key === 'send' && can(s, n, 'manageMessages')) return true;
  const def = k => k === 'manage' ? can(s, n, 'manageMessages') : k === 'mention' ? can(s, n, 'mentionEveryone') : true;
  const val = k => { let v = def(k); const e = ovGet(ov['@everyone'], k); if (e !== undefined) v = e;
    const rs = s.memberRoles?.[n] || [];
    if (rs.some(r => ovGet(ov[r], k) === false)) v = false;
    if (rs.some(r => ovGet(ov[r], k) === true)) v = true;
    const u = ovGet(ov['u:' + n], k); if (u !== undefined) v = u;
    return v; };
  if (!val('view')) return false;
  return key === 'view' ? true : val(key);
}
const chPerm = (s, c, n, key) => {
  if (key === 'speak' && c.type === 'stage') return s.owner === n || can(s, n, 'manageChannels') || chPermWith(s, ovOf(s, c), n, 'manage') || !!stage.get(c.id)?.speakers.has(n);
  return chPermWith(s, ovOf(s, c), n, key) || (key === 'view' && (c.allowUsers || []).includes(n));
};
const seesChannel = (s, c, n) => chPerm(s, c, n, 'view');
function cleanPerms(s, p) {
  const out = {};
  if (!p || typeof p !== 'object') return out;
  for (const [t, v] of Object.entries(p)) {
    if (t !== '@everyone' && !s.customRoles.some(r => r.id === t) && !(t.startsWith('u:') && db.users[t.slice(2)] && (s.public || s.members.includes(t.slice(2))))) continue;
    const o = {}; for (const k of CH_KEYS) if (v?.[k] === true || v?.[k] === false) o[k] = v[k];
    if (Object.keys(o).length) out[t] = o;
  }
  return out;
}
const PERM_TR = { view: 'görme', send: 'yazma', history: 'geçmişi okuma', connect: 'bağlanma', attach: 'dosya', embed: 'bağlantı ve GIF', react: 'tepki', mention: '@herkes', apps: 'anket ve oyun', thread: 'yanıt dizisi', manage: 'mesaj yönetimi', video: 'kamera', stream: 'ekran paylaşma', speak: 'konuşma' };
function permDiff(s, a = {}, b = {}) {
  const nm = t => t === '@everyone' ? '@herkes' : t.startsWith('u:') ? t.slice(2) : (s.customRoles.find(r => r.id === t)?.name || '?');
  const out = [];
  for (const t of new Set([...Object.keys(a), ...Object.keys(b)])) for (const k of CH_KEYS) {
    const x = a[t]?.[k], y = b[t]?.[k];
    if (x !== y) out.push(`${nm(t)} ${PERM_TR[k]} ${y === true ? '✓' : y === false ? '✗' : '⧸'}`);
  }
  return out.slice(0, 6).join(', ') + (out.length > 6 ? ` +${out.length - 6}` : '');
}
// Eski "kategori adı / özel / salt okunur" verisini yeni modele taşı
function migrateCats(s) {
  if (s.categories) return;
  s.categories = [];
  const byName = {}, hasCats = s.channels.some(c => c.category);
  for (const c of s.channels) {
    c.type ||= 'text';
    const nm = c.category || (hasCats ? null : c.type === 'voice' ? 'Sesli odalar' : 'Yazılı odalar');
    if (nm) { if (!byName[nm]) { byName[nm] = { id: id(), name: nm, perms: {} }; s.categories.push(byName[nm]); } c.cat = byName[nm].id; }
    delete c.category;
    c.perms ||= {};
    if (c.private) { c.perms['@everyone'] = { ...c.perms['@everyone'], view: false }; for (const r of c.allow || []) c.perms[r] = { ...c.perms[r], view: true }; }
    if (c.readonly) c.perms['@everyone'] = { ...c.perms['@everyone'], send: false };
    delete c.private; delete c.readonly; delete c.allow;
    c.sync = !Object.keys(c.perms).length && !!c.cat;
  }
  // düzen: kategorisizler üstte, sonra kategori sırasıyla
  s.channels = [...s.channels.filter(c => !c.cat), ...s.categories.flatMap(k => s.channels.filter(c => c.cat === k.id))];
}
// Oda görünümü (izleyene göre)
const everyoneDenied = (ov, k) => ov['@everyone']?.[k] === false;
// Oda izin ayarları bot görünümü: [{ hedef, tur: 'herkes'|'rol'|'kisi', izin: { view: false, ... } }]
const ovView = ov => Object.entries(ov || {}).map(([k, v]) => k === '@everyone' ? { hedef: 'herkes', tur: 'herkes', izin: v } : k.startsWith('u:') ? { hedef: k.slice(2), tur: 'kisi', id: db.users[k.slice(2)] ? uidOf(db.users[k.slice(2)]) : null, izin: v } : { hedef: k, tur: 'rol', izin: v });
// Görme izni kısıtlı odayı kimler görebiliyor? Herkese açık (çok üyeli) sunucuda da hızlı olsun diye 2 sn önbellek
const viewersCache = new Map();
function viewersOf(s, c) {
  const k = s.id + '|' + c.id, hit = viewersCache.get(k), now = Date.now();
  if (hit && now - hit.t < 2000) return hit.v;
  const v = membersOf(s).filter(n => seesChannel(s, c, n)); viewersCache.set(k, { t: now, v }); return v;
}
// Oda simgesi (test: sadece etiket testindeki sunucular, yani şimdilik Kanka HQ). c.icon: emoji | ':ozelEmoji:' | '/uploads/...'
const CHICON = {
  allowed: s => TAG.allowedServer(s) || perkOn(s, 'chIcon'),
  EMO_RE: /^(?=.*\p{Extended_Pictographic}|.*\p{Regional_Indicator}|.*\u20e3)[\p{Extended_Pictographic}\p{Emoji_Component}\p{Regional_Indicator}\u200d\ufe0f\u20e3]+$/u,
  clean(s, v) {
    if (v === null || v === '' || v === undefined) return { ok: true, v: undefined };
    v = String(v).trim();
    if (UPLOAD_RE.test(v)) return { ok: true, v };
    const m = /^:([a-z0-9_]{2,24}):$/.exec(v); if (m) return s.emojis?.[m[1]] ? { ok: true, v } : { error: 'Bu özel emoji sunucuda yok' };
    if (v.length <= 24 && [...v].length <= 10 && CHICON.EMO_RE.test(v)) return { ok: true, v };
    return { error: 'Simge tek bir emoji, sunucunun özel emojisi ya da yüklenen bir resim olmalı' };
  },
  view(s, c) {
    if (!c.icon || !CHICON.allowed(s)) return null;
    if (c.icon.startsWith('/uploads/')) return { u: c.icon };
    const m = /^:([a-z0-9_]+):$/.exec(c.icon); if (m) return s.emojis?.[m[1]] ? { u: s.emojis[m[1]] } : null;
    return { e: c.icon };
  },
};
function chView(s, c, viewer, manager) {
  const ov = ovOf(s, c);
  const P = k => viewer ? chPerm(s, c, viewer, k) : true;
  const v = { id: c.id, name: c.name, type: c.type || 'text', cat: c.cat || null, sync: !!c.sync, icon: CHICON.view(s, c), color: c.color || null, font: c.font || null, iconRaw: manager && CHICON.allowed(s) ? c.icon || null : undefined,
    topic: c.topic || '', slow: c.slow || 0, limit: c.limit || 0, bitrate: c.bitrate === 'studio' && !energyPerk(s, 'studio') ? 'high' : c.bitrate || 'std', news: !!c.news, followers: (c.followers || []).length,
    stage: c.type === 'stage' && stage.has(c.id) ? stageView(c.id) : undefined,
    canAttach: P('attach'), canReact: P('react'), canMention: P('mention'), canManage: P('manage'), canStream: P('stream'), canSpeak: P('speak'), canSound: P('soundboard'),
    canVideo: P('video'), canEmbed: P('embed'), canApps: P('apps'), canThread: P('thread'), canHistory: P('history'),
    private: everyoneDenied(ov, 'view'), ann: everyoneDenied(ov, 'send'), locked: voiceLike(c.type) && everyoneDenied(ov, 'connect'),
    readonly: viewer ? !chPerm(s, c, viewer, 'send') : false, canConnect: viewer ? chPerm(s, c, viewer, 'connect') : true,
    ticket: c.ticket ? { no: c.ticket.no, by: c.ticket.by, claimedBy: c.ticket.claimedBy || null, closed: !!c.ticket.closedAt } : undefined };
  if (manager) v.perms = c.perms || {};
  // Görme izni kısıtlı odada üye listesi sadece odayı görebilenleri göstersin
  if (c.allowUsers?.length || Object.values(ov).some(o => o && o.view !== undefined)) v.viewers = viewersOf(s, c);
  return v;
}
for (const s of db.servers) migrateCats(s);
// Resmi sunucu düzeni (bir kez uygulanır). Var olan odalar silinmez: adı eşleşen oda yerinde kullanılır, eksikler eklenir.
(function hqLayout() {
  const s = db.servers.find(x => x.id === 's1'); if (!s || s.hqLayoutV1) return;
  const RO = { '@everyone': { send: false } };
  const PLAN = [
    ['📌 BAŞLARKEN', [
      ['kurallar', 'text', 'Okumadan geçme. Kısa, söz.', RO, ['kurallar']],
      ['duyurular', 'text', 'Kanka\'daki yenilikler ve beta haberleri', RO, ['duyurular']],
      ['nasıl-kullanılır', 'text', 'Telefonda, masaüstünde ve tarayıcıda Kanka', RO, ['nasıl-kullanılır']],
    ]],
    ['💬 SOHBET', [
      ['genel', 'text', 'Her şeyden konuş. Hoş geldin kanka!', null, ['genel']],
      ['tanışma', 'text', 'Kendini tanıt: adın, oynadığın oyunlar, nereden geldin', null, ['tanışma', 'tanisma']],
      ['medya', 'text', 'Ekran görüntüleri, klipler, capsler', null, ['medya']],
    ]],
    ['🎮 OYUN', [
      ['oyun', 'text', 'Oyun sohbeti', null, ['oyun']],
      ['takım-arıyorum', 'text', 'Oyun, rank ve saat yaz; takımını bul', null, ['takım-arıyorum', 'takim-ariyorum']],
      ['Oyun Odası 1', 'voice', '', null, ['oyun odası 1']],
      ['Oyun Odası 2', 'voice', '', null, ['oyun odası 2']],
    ]],
    ['🧪 BETA', [
      ['yorumlarla-yapıyorum', 'text', 'Ne eklenmeli? Yaz, en çok tepki alan fikir sıradaki videoda yapılıyor', null, ['yorumlarla-yapıyorum', 'fikirler', 'öneriler']],
      ['hata-bildir', 'text', 'Bir şey bozuksa buraya: ne yaptın, ne oldu, telefon mu bilgisayar mı', null, ['hata-bildir', 'hatalar', 'bug']],
    ]],
    ['🔊 SESLİ', [
      ['Sohbet', 'voice', '', null, ['sohbet']],
      ['Müzik', 'voice', '', null, ['müzik']],
    ]],
  ];
  const norm = x => String(x || '').toLocaleLowerCase('tr').trim();
  const used = new Set(), cats = [], ordered = [];
  for (const [catName, chans] of PLAN) {
    let k = s.categories.find(x => norm(x.name).replace(/^[^a-zçğıöşü]+/u, '') === norm(catName).replace(/^[^a-zçğıöşü]+/u, ''));
    if (!k) k = { id: id(), name: catName, perms: {} }; else k.name = catName;
    cats.push(k);
    for (const [name, type, topic, perms, alias] of chans) {
      let c = s.channels.find(x => !used.has(x) && (x.type || 'text') === type && alias.includes(norm(x.name)));
      if (!c) c = { id: id(), name, type, perms: {}, sync: true };
      used.add(c); c.cat = k.id;
      if (topic && !c.topic) c.topic = topic;
      if (perms) { c.perms = { ...(c.perms || {}), '@everyone': { ...(c.perms?.['@everyone'] || {}), ...perms['@everyone'] } }; c.sync = false; }
      if (name === 'duyurular') c.news = true;
      ordered.push(c);
    }
  }
  const rest = s.channels.filter(c => !used.has(c)); // planda olmayan odalar korunur, sohbet kategorisinin sonuna
  const chat = cats[1];
  for (const c of rest) { if (!c.cat || !cats.some(k => k.id === c.cat)) c.cat = (s.categories.find(k => k.id === c.cat) ? c.cat : chat.id); }
  s.categories = [...cats, ...s.categories.filter(k => !cats.includes(k) && rest.some(c => c.cat === k.id))];
  s.channels = s.categories.flatMap(k => [...ordered, ...rest].filter(c => c.cat === k.id));
  // Kurallar ve nasıl kullanılır odalarına ilk mesajlar (oda boşsa)
  const owner = s.owner && db.users[s.owner];
  const post = (name, text) => {
    const c = s.channels.find(x => x.name === name); if (!c || !owner || (msgRaw[c.id] || []).length) return;
    (db.messages[c.id] ||= []).push({ id: id(), author: owner.name, color: owner.color, time: Date.now(), kind: 'text', text, reactions: {} });
  };
  post('kurallar', [
    '**Kanka HQ kuralları** 🦝',
    '1. Saygı. Hakaret, taciz, nefret söylemi yok.',
    '2. Spam ve reklam yok. Sunucu davetini sormadan atma.',
    '3. +18, şiddet ve yasa dışı içerik yok.',
    '4. Kimsenin kişisel bilgisini paylaşma.',
    '5. Hata bulursan #hata-bildir, fikrin varsa #yorumlarla-yapıyorum.',
    'Kurallara uymayan uyarılır, tekrar ederse çıkarılır. İyi sohbetler kanka!',
  ].join('\n'));
  post('nasıl-kullanılır', [
    '**Kanka\'yı nereden kullanırım?**',
    '📱 **Telefon:** kankahq.com\'u tarayıcıda aç → Paylaş → "Ana Ekrana Ekle". Uygulama gibi açılır, bildirim gelir.',
    '💻 **Bilgisayar:** Tarayıcıdan kankahq.com ya da masaüstü uygulaması.',
    '🎙️ **Sesli oda:** Soldaki 🔊 odalara tıkla, bağlan. Ekran paylaşımı da orada.',
    '🧪 **Beta:** İlk 300 kişiye kalıcı Beta Tester rozeti. Kankanı getir: kankahq.com/beta',
  ].join('\n'));
  s.hqLayoutV1 = true; save();
})();
// ---------- Sunucu şablonları ----------
const MOD = ['manageChannels', 'manageMessages', 'kick', 'timeout', 'mentionEveryone'];
const TEMPLATES = {
  bos: { channels: [{ n: 'genel' }, { n: 'Sohbet', v: 1 }] },
  oyun: {
    roles: [{ name: 'Kaptan', color: '#ff4655', perms: MOD, hoist: true }, { name: 'Takım', color: '#4aa8ff', perms: [], hoist: true }],
    channels: [{ n: 'duyurular', cat: 'Bilgi', ro: 1 }, { n: 'kurallar', cat: 'Bilgi', ro: 1 }, { n: 'genel', cat: 'Sohbet' }, { n: 'klip-ve-ekran', cat: 'Sohbet' }, { n: 'takım-arıyorum', cat: 'Sohbet' },
      { n: 'strateji', cat: 'Takım', priv: ['Kaptan', 'Takım'] }, { n: 'Lobi', cat: 'Sesli', v: 1 }, { n: 'Maç 1', cat: 'Sesli', v: 1 }, { n: 'Maç 2', cat: 'Sesli', v: 1 }, { n: 'AFK', cat: 'Sesli', v: 1 }],
    welcome: { message: 'Takıma hoş geldin! Önce kuralları oku, sonra #takım-arıyorum odasında kendini tanıt.', rules: ['Küfür, hakaret ve taciz yok.', 'Hile, hile satışı ve hesap paylaşımı yasak.', 'Spam ve izinsiz reklam yapma.', 'Maç sırasında sesli odada sessiz olmaya özen göster.'],
      channels: [['duyurular', 'Turnuva ve maç saatleri'], ['takım-arıyorum', 'Kendini tanıt, takım bul'], ['klip-ve-ekran', 'En iyi anlarını paylaş']] } },
  arkadas: {
    roles: [{ name: 'Kanka', color: '#ffb347', perms: [], hoist: false }],
    channels: [{ n: 'genel', cat: 'Takılma' }, { n: 'mimler', cat: 'Takılma' }, { n: 'fotoğraflar', cat: 'Takılma' }, { n: 'planlar', cat: 'Takılma' }, { n: 'müzik', cat: 'Takılma' },
      { n: 'Muhabbet', cat: 'Sesli', v: 1 }, { n: 'Oyun', cat: 'Sesli', v: 1 }, { n: 'Film gecesi', cat: 'Sesli', v: 1 }] },
  okul: {
    roles: [{ name: 'Öğretmen', color: '#2fd3c3', perms: MOD, hoist: true }, { name: 'Sınıf başkanı', color: '#b07cff', perms: ['manageMessages', 'mentionEveryone'], hoist: true }],
    channels: [{ n: 'duyurular', cat: 'Okul', ro: 1 }, { n: 'ödevler', cat: 'Okul' }, { n: 'sınav-takvimi', cat: 'Okul', ro: 1 }, { n: 'soru-cevap', cat: 'Dersler' }, { n: 'notlar', cat: 'Dersler' }, { n: 'sohbet', cat: 'Teneffüs' },
      { n: 'Etüt', cat: 'Sesli', v: 1 }, { n: 'Grup çalışması', cat: 'Sesli', v: 1 }],
    welcome: { message: 'Sınıfımıza hoş geldin! Duyuruları takip et, takıldığın soruları #soru-cevap odasına yaz.', rules: ['Birbirimize saygılı olalım.', 'Ödev cevaplarını doğrudan paylaşma, birbirine yardım et.', 'Ders dışı konular için #sohbet odasını kullan.'],
      channels: [['duyurular', 'Okul ve ders duyuruları'], ['ödevler', 'Teslim tarihleri ve ödevler'], ['soru-cevap', 'Takıldığın yerleri sor']] } },
  topluluk: {
    roles: [{ name: 'Moderatör', color: '#4cc38a', perms: MOD, hoist: true }, { name: 'Destekçi', color: '#ff6b9a', perms: [], hoist: true }],
    channels: [{ n: 'duyurular', cat: 'Başla', ro: 1 }, { n: 'kurallar', cat: 'Başla', ro: 1 }, { n: 'kendini-tanıt', cat: 'Başla' }, { n: 'genel', cat: 'Topluluk' }, { n: 'öneriler', cat: 'Topluluk' }, { n: 'paylaşımlar', cat: 'Topluluk' },
      { n: 'mod-odası', cat: 'Yönetim', priv: ['Moderatör'] }, { n: 'Sohbet', cat: 'Sesli', v: 1 }, { n: 'Etkinlik', cat: 'Sesli', v: 1 }],
    welcome: { message: 'Topluluğumuza hoş geldin! Kuralları kabul ettikten sonra #kendini-tanıt odasında selam ver.', rules: ['Herkese saygılı ol, ayrımcılık ve nefret söylemi yok.', 'Spam, izinsiz reklam ve davet linki paylaşma.', 'Konuya uygun odayı kullan.', 'Moderatörlerin uyarılarına uy.'],
      channels: [['kendini-tanıt', 'Kendinden bahset'], ['genel', 'Ana sohbet'], ['öneriler', 'Fikirlerini paylaş']] } },
};
const CATS = ['Oyun', 'Sohbet', 'Müzik', 'Eğitim', 'Yazılım', 'Anime', 'Film ve dizi', 'Spor', 'Sanat', 'Diğer'];
// ---------- Discord şablonundan sunucu kurma ----------
// discord.new/KOD linkindeki şablonu Discord'un açık API'sinden okur; odalar, kategoriler, roller ve izinler Kanka modeline çevrilir
const DC_PERM_BITS = { administrator: 3n, manageWebhooks: 29n, pinMessages: 13n, slowBypass: 13n, manageServer: 5n, manageRoles: 28n, manageChannels: 4n, manageEmojis: 30n, viewAudit: 7n, manageMessages: 13n, mentionEveryone: 17n, kick: 1n, ban: 2n, timeout: 40n, voiceMute: 22n, voiceMove: 24n, manageSounds: 30n };
const DC_CH_BITS = { view: 10n, send: 11n, history: 16n, connect: 20n, attach: 15n, embed: 14n, react: 6n, mention: 17n, apps: 39n, thread: 38n, manage: 13n, video: 9n, stream: 9n, speak: 21n };
const DC_TYPES = { 0: 'text', 2: 'voice', 5: 'text', 13: 'stage', 15: 'forum' };
const DC_TYPE_TR = { 14: 'rehber odası', 16: 'medya odası' };
const SLOW_STEPS = [0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 3600];
const nearest = (list, x) => list.reduce((a, b) => Math.abs(b - x) < Math.abs(a - x) ? b : a);
function dcCode(link) {
  const s = String(link ?? '').trim();
  const m = s.includes('/') ? s.match(/(?:discord\.new|discord(?:app)?\.com\/template)\/([A-Za-z0-9]{2,32})/i) : s.match(/^([A-Za-z0-9]{2,32})$/);
  return m ? m[1] : null;
}
const dcCache = new Map();
async function dcFetch(code) {
  const hit = dcCache.get(code); if (hit && Date.now() - hit.t < 600e3) return hit.v;
  let r;
  try { r = await fetch('https://discord.com/api/v10/guilds/templates/' + encodeURIComponent(code), { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'KankaChat (https://kankahq.com, 1.0)' } }); }
  catch { return { error: 'Şablona ulaşılamadı, biraz sonra tekrar dene' }; }
  if (r.status === 404) return { error: 'Şablon bulunamadı. Linkin doğru olduğundan ve şablonun silinmediğinden emin ol.' };
  if (r.status === 429) return { error: 'Şablon servisi şu an yoğun, bir dakika sonra tekrar dene' };
  if (!r.ok) return { error: `Şablon okunamadı (${r.status})` };
  const d = await r.json().catch(() => null);
  if (!d?.serialized_source_guild) return { error: 'Şablon okunamadı' };
  const v = { code, name: d.name || '', guild: d.serialized_source_guild };
  dcCache.set(code, { t: Date.now(), v }); if (dcCache.size > 200) dcCache.delete(dcCache.keys().next().value);
  return v;
}
function dcConvert(t) {
  const g = t.guild || {}, skipped = [];
  const big = v => { try { return BigInt(v || 0); } catch { return 0n; } };
  const has = (p, b) => ((p >> b) & 1n) === 1n;
  const allRoles = Array.isArray(g.roles) ? g.roles : [];
  const everyone = allRoles.find(r => String(r.id) === '0') || allRoles.find(r => r.name === '@everyone');
  const evP = big(everyone?.permissions);
  // Discord şablonunda roller alttan üste sıralı; Kanka'da ilk rol en yüksek
  const src = allRoles.filter(r => r !== everyone).reverse();
  if (src.length > MAX_ROLES) skipped.push(`${src.length - MAX_ROLES} rol (en fazla ${MAX_ROLES} rol olabilir)`);
  if (src.some(r => r.icon && !r.unicode_emoji)) skipped.push('rol resim simgeleri');
  const roleMap = new Map();
  const roles = src.slice(0, MAX_ROLES).map(r => {
    const p = big(r.permissions), admin = has(p, 3n);
    const color = r.color ? '#' + (Number(r.color) & 0xffffff).toString(16).padStart(6, '0') : '#99aab5';
    const icon = r.unicode_emoji ? [...clean(r.unicode_emoji, 16)].slice(0, 2).join('') : null;
    const kr = { id: id(), name: clean(r.name, 30) || 'rol', color, perms: PERMS.filter(k => admin || has(p, DC_PERM_BITS[k])), hoist: !!r.hoist, icon, mentionable: !!r.mentionable };
    roleMap.set(String(r.id), { kr, p, admin });
    return kr;
  });
  let memberOv = false;
  const BASE_KEYS = ['view', 'send', 'history', 'connect', 'attach', 'embed', 'react', 'apps', 'thread', 'video', 'stream', 'speak', 'soundboard']; // Kanka'da varsayılanı "açık" olanlar
  const conv = ows => {
    const list = Array.isArray(ows) ? ows : [], out = {}, ev = {};
    if (list.some(o => o.type === 1)) memberOv = true;
    const evo = list.find(o => o.type === 0 && everyone && String(o.id) === String(everyone.id));
    const baseOff = new Set();
    for (const [k, b] of Object.entries(DC_CH_BITS)) {
      const allow = evo && has(big(evo.allow), b), deny = evo && has(big(evo.deny), b);
      if (allow) ev[k] = true;
      else if (deny) ev[k] = false;
      else if (BASE_KEYS.includes(k) && !has(evP, b) && !has(evP, 3n)) { ev[k] = false; baseOff.add(k); }
      else if (!BASE_KEYS.includes(k) && (has(evP, b) || has(evP, 3n))) ev[k] = true; // @everyone'ın sunucu genelindeki @herkes / mesaj yönetimi yetkisi
    }
    if (Object.keys(ev).length) out['@everyone'] = ev;
    for (const o of list) {
      if (o.type !== 0) continue; const m = roleMap.get(String(o.id)); if (!m) continue;
      const x = {}; for (const [k, b] of Object.entries(DC_CH_BITS)) { if (has(big(o.allow), b)) x[k] = true; else if (has(big(o.deny), b)) x[k] = false; }
      if (Object.keys(x).length) out[m.kr.id] = x;
    }
    // Sunucu genelinde @everyone'a kapalı ama rolde açık olan yetki odada role izin olarak yazılır
    // Odada bir rol bu yetkiyi yasaklıyorsa eklenmez: Kanka'da rol izni rol yasağını ezer, Discord'da ezmez
    const roleDenied = new Set(Object.entries(out).filter(([t]) => t !== '@everyone').flatMap(([, x]) => Object.keys(x).filter(k => x[k] === false)));
    for (const { kr, p, admin } of roleMap.values()) for (const k of baseOff) if (!admin && !roleDenied.has(k) && has(p, DC_CH_BITS[k]) && out[kr.id]?.[k] === undefined) (out[kr.id] ||= {})[k] = true;
    return out;
  };
  const canon = o => JSON.stringify(Object.keys(o).sort().map(t => [t, Object.keys(o[t]).sort().map(k => [k, o[t][k]])]));
  const chans = (Array.isArray(g.channels) ? g.channels : []).slice().sort((a, b) => (a.position || 0) - (b.position || 0) || (a.id || 0) - (b.id || 0));
  const categories = [], catMap = new Map();
  const srcCats = chans.filter(c => c.type === 4);
  if (srcCats.length > 50) skipped.push(`${srcCats.length - 50} kategori (en fazla 50)`);
  for (const c of srcCats.slice(0, 50)) { const k = { id: id(), name: clean(c.name, 30) || 'Kategori', perms: conv(c.permission_overwrites) }; categories.push(k); catMap.set(String(c.id), k); }
  const items = [], unsupported = {}; let over = 0, nsfw = 0;
  for (const c of chans) {
    if (c.type === 4) continue;
    const type = DC_TYPES[c.type];
    if (!type) { const nm = DC_TYPE_TR[c.type] || 'desteklenmeyen oda'; unsupported[nm] = (unsupported[nm] || 0) + 1; continue; }
    if (items.length >= 200) { over++; continue; }
    if (c.nsfw) nsfw++;
    let name = clean(c.name, 30); if (type === 'text' || type === 'forum') name = name.toLowerCase().replace(/\s+/g, '-');
    if (!name) name = voiceLike(type) ? 'Sesli' : 'oda';
    const k = c.parent_id != null ? catMap.get(String(c.parent_id)) || null : null;
    const perms = conv(c.permission_overwrites), sync = !!k && canon(perms) === canon(k.perms);
    const ch = { id: id(), name, type, perms: sync ? {} : perms, sync };
    if (k) ch.cat = k.id;
    const topic = clean(c.topic, 160); if (topic) ch.topic = topic; else if (type === 'stage') ch.topic = 'Sahne';
    if (c.rate_limit_per_user) ch.slow = nearest(SLOW_STEPS, c.rate_limit_per_user);
    if (voiceLike(type)) { if (c.user_limit) ch.limit = Math.min(99, c.user_limit); if ((c.bitrate || 0) > 64000) ch.bitrate = 'high'; }
    if (c.type === 5) ch.news = true;
    items.push({ ch, src: c, ci: k ? categories.indexOf(k) : -1 });
  }
  for (const [nm, n] of Object.entries(unsupported)) skipped.push(`${n} ${nm}`);
  if (over) skipped.push(`${over} oda (en fazla 200 oda olabilir)`);
  if (memberOv) skipped.push('kişiye özel oda izinleri');
  if (nsfw) skipped.push(`${nsfw} odanın yaş sınırı (NSFW) işareti`);
  // Discord düzeni: kategorisizler üstte; kategori içinde önce yazılı, sonra sesli odalar
  items.sort((a, b) => a.ci - b.ci || (voiceLike(a.ch.type) ? 1 : 0) - (voiceLike(b.ch.type) ? 1 : 0) || (a.src.position || 0) - (b.src.position || 0) || (a.src.id || 0) - (b.src.id || 0));
  const afkSrc = g.afk_channel_id != null && items.find(x => String(x.src.id) === String(g.afk_channel_id) && x.ch.type === 'voice');
  const afk = afkSrc ? { ch: afkSrc.ch.id, min: nearest([1, 5, 10, 15, 30, 60], (g.afk_timeout || 600) / 60) } : null;
  return { name: clean(t.name || g.name, 40), roles, categories, channels: items.map(x => x.ch), afk, skipped, lockChannels: !has(evP, 4n) && !has(evP, 3n) };
}
function dcPreview(c, code) {
  const row = ch => ({ name: ch.name, type: ch.type, news: !!ch.news, private: ovOfPreview(c, ch) });
  return { code, name: c.name, roles: c.roles.map(r => ({ name: r.name, color: r.color, icon: r.icon, admin: r.perms.length === PERMS.length })),
    top: c.channels.filter(ch => !ch.cat).map(row),
    categories: c.categories.map(k => ({ name: k.name, channels: c.channels.filter(ch => ch.cat === k.id).map(row) })),
    counts: { channels: c.channels.length, categories: c.categories.length, roles: c.roles.length }, skipped: c.skipped };
}
const ovOfPreview = (c, ch) => { const k = ch.cat && c.categories.find(x => x.id === ch.cat); return (ch.sync && k ? k.perms : ch.perms)?.['@everyone']?.view === false; };
// ---------- Mevcut sunucuya şablon uygulama ----------
// Adı tutan kategori, aynı türde oda ve rol korunur (kimliği, mesajları, üye atamaları), izin ve ayarları şablondakiyle güncellenir.
// Şablondaki yeniler eklenir, hiçbir şey silinmez. Önceki düzen 24 saat geri alınabilir.
const TPL_UNDO_MS = 864e5;
const tplKey = n => String(n || '').toLocaleLowerCase('tr').trim().replace(/[\s_-]+/g, '-');
function dcMerge(s, c) {
  const copy = x => JSON.parse(JSON.stringify(x || []));
  const roles = copy(s.customRoles), cats = copy(s.categories), chans = copy(s.channels);
  const view = { roles: r => ({ name: r.name, color: r.color }), categories: k => ({ name: k.name }), channels: ch => ({ name: ch.name, type: ch.type, news: !!ch.news }) };
  const diff = {}; for (const g of ['add', 'update', 'keep']) diff[g] = { roles: [], categories: [], channels: [] };
  const added = { roles: [], categories: [], channels: [] }, over = { roles: 0, categories: 0, channels: 0 };
  const put = (g, kind, x) => { diff[g][kind].push(view[kind](x)); if (g === 'add') added[kind].push(x.id); };
  // Yeni roller en alta eklenir: mevcut rollerin sırası ve üstünlüğü değişmez
  const rid = {}, usedR = new Set();
  for (const r of c.roles) {
    const m = roles.find(x => !x.bot && !usedR.has(x) && tplKey(x.name) === tplKey(r.name));
    if (m) { usedR.add(m); rid[r.id] = m.id; Object.assign(m, { color: r.color, perms: r.perms, hoist: r.hoist, icon: r.icon, mentionable: r.mentionable }); put('update', 'roles', m); }
    else if (roles.length >= MAX_ROLES) over.roles++;
    else { roles.push(r); usedR.add(r); rid[r.id] = r.id; put('add', 'roles', r); }
  }
  // Şablonun izinleri sunucudaki rol kimliklerine çevrilir; şablonda geçmeyen rol ve kişilerin mevcut izinleri kalır
  const mapPerms = p => Object.fromEntries(Object.entries(p || {}).filter(([t]) => t === '@everyone' || rid[t]).map(([t, v]) => [t === '@everyone' ? t : rid[t], { ...v }]));
  const merged = (old, p) => ({ ...(old || {}), ...mapPerms(p) });
  const kid = {}, usedK = new Set(), tplCats = [];
  for (const k of c.categories) {
    const m = cats.find(x => !usedK.has(x) && tplKey(x.name) === tplKey(k.name));
    if (m) { usedK.add(m); kid[k.id] = m.id; m.perms = merged(m.perms, k.perms); tplCats.push(m); put('update', 'categories', m); }
    else if (cats.length >= 50) over.categories++;
    else { const n = { ...k, perms: mapPerms(k.perms) }; cats.push(n); usedK.add(n); kid[k.id] = n.id; tplCats.push(n); put('add', 'categories', n); }
  }
  const oldOv = Object.fromEntries(s.channels.map(ch => [ch.id, ovOf(s, ch)]));
  const cid = {}, usedC = new Set(), placed = [];
  for (const t of c.channels) {
    const cat = t.cat ? kid[t.cat] : undefined, tp = t.sync ? c.categories.find(k => k.id === t.cat)?.perms : t.perms;
    const m = chans.find(x => !usedC.has(x) && x.type === t.type && tplKey(x.name) === tplKey(t.name));
    let ch;
    if (m) {
      ch = m; put('update', 'channels', m);
      for (const f of ['slow', 'limit', 'bitrate']) if (t[f] !== undefined) m[f] = t[f]; else delete m[f];
      if (t.topic) m.topic = t.topic;
      if (t.news) m.news = true;
    } else if (chans.length >= 200) { over.channels++; continue; }
    else { ch = { ...t, perms: {} }; chans.push(ch); put('add', 'channels', ch); }
    usedC.add(ch); cid[t.id] = ch.id;
    if (cat) ch.cat = cat; else delete ch.cat;
    if (t.sync && cat) { ch.sync = true; ch.perms = {}; }
    else { ch.sync = false; ch.perms = m ? merged(oldOv[m.id], tp) : mapPerms(tp); }
    placed.push(ch);
  }
  // Düzen: önce şablondakiler şablon sırasıyla, sonra dokunulmayan mevcutlar kendi yerlerinde
  const rest = chans.filter(x => !usedC.has(x));
  const order = [...tplCats, ...cats.filter(k => !tplCats.includes(k))], catIds = new Set(order.map(k => k.id));
  const grp = k => [...placed, ...rest].filter(x => (x.cat && catIds.has(x.cat) ? x.cat : null) === k);
  const channels = [...grp(null), ...order.flatMap(k => grp(k.id))];
  for (const r of roles) if (!usedR.has(r) && !r.bot) put('keep', 'roles', r);
  for (const k of cats) if (!usedK.has(k)) put('keep', 'categories', k);
  for (const ch of rest) put('keep', 'channels', ch);
  const skipped = [...c.skipped];
  if (over.roles) skipped.push(`${over.roles} rol (sunucuda en fazla ${MAX_ROLES} rol olabilir)`);
  if (over.categories) skipped.push(`${over.categories} kategori (en fazla 50)`);
  if (over.channels) skipped.push(`${over.channels} oda (en fazla 200 oda olabilir)`);
  const afk = c.afk && cid[c.afk.ch] ? { ch: cid[c.afk.ch], min: c.afk.min } : s.afk || null;
  return { roles, categories: order, channels, afk, lockChannels: !!c.lockChannels, added, diff, skipped };
}

// ---------- Sunucu rozetleri ----------
// resmi: Kanka HQ · dogrulanmis/partner: site yöneticisi verir · topluluk: 15+ üye ve 7+ gün
// ---- Kanka ekibi: rütbeler ----
// owner: Kanka HQ sahibi (her şey + ekibi yönetir) · admin: yönetim (her şey, ekip hariç) · mod: şikayet, uyarı, askıya alma · destek: şikayetleri görür, uyarır
const STAFF_RANKS = { owner: 'Kurucu', admin: 'Yönetici', mod: 'Moderatör', destek: 'Destek' };
const CO_OWNERS = new Set(['babayim']);
const isCoOwner = n => !!n && CO_OWNERS.has(String(n).toLowerCase());
const coOwnerNames = () => Object.keys(db.users || {}).filter(isCoOwner);
const staffRank = n => !n || !db.users?.[n] ? null : (db.servers.find(x => x.id === 's1')?.owner === n || isCoOwner(n)) ? 'owner' : db.staff?.[n]?.rank || ((db.siteAdmins || []).includes(n) ? 'admin' : null);
const siteAdmin = n => ['owner', 'admin'].includes(staffRank(n));
const siteMod = n => !!staffRank(n);
const ALL_STAFF = ['owner', 'admin', 'mod', 'destek'];
const STAFF_CAN = { warn: ALL_STAFF, reports: ALL_STAFF, lookup: ALL_STAFF, suspend: ['owner', 'admin', 'mod'], ban: ['owner', 'admin'], del: ['owner', 'admin'], email: ['owner', 'admin'], reset: ['owner', 'admin'] };
const canStaff = (n, act) => (STAFF_CAN[act] || []).includes(staffRank(n));
const staffList = () => [...new Set([db.servers.find(x => x.id === 's1')?.owner, ...coOwnerNames(), ...Object.keys(db.staff || {}), ...(db.siteAdmins || [])])].filter(n => n && db.users[n] && staffRank(n));
function staffLog(by, action, target, detail) { (db.staffLog ||= []).unshift({ at: Date.now(), by, action, target: target || null, detail: String(detail || '').slice(0, 200) }); if (db.staffLog.length > 1500) db.staffLog.length = 1500; }
const isBanned = u => { if (!u?.siteBan) return false; if (u.siteBan.until && u.siteBan.until < Date.now()) { delete u.siteBan; save(); return false; } return true; };
// Yıldız: kademelerin sonu (şartlı başvuru). Partner: ekibin elle seçtiği iş birlikleri (şartsız). Partner, Yıldız'ın tüm ayrıcalıklarını da alır.
const isStar = s => !!(s?.badges?.yildiz || s?.badges?.partner);
setTimeout(() => { try { // eski partnerler Yıldız da olsun, bekleyen partner başvuruları Yıldız başvurusuna dönsün
  let ch = false; for (const x of db.servers) if (x.badges?.partner && !x.badges.yildiz) { x.badges.yildiz = { ...x.badges.partner }; ch = true; }
  for (const A of Object.values(db.srvApps || {})) if (A.partner && !A.yildiz) { A.yildiz = A.partner; delete A.partner; ch = true; }
  if (ch) save(); partnerPerks(); } catch (e) { console.error('[yildiz]', e.message); } }, 4000);
// Yıldız ve Partner sahiplerine Kanka HQ'da rol ve sadece onların gördüğü yildiz-salonu odası
function partnerPerks() {
  const hq = db.servers.find(x => x.id === 's1'); if (!hq) return;
  hq.customRoles ||= []; hq.memberRoles ||= {};
  let role = hq.customRoles.find(r => r.id === db.partnerRoleId);
  if (!role) { role = { id: id(), name: 'Kanka Partner', color: '#7c5cff', perms: [], hoist: true, icon: '🤝', mentionable: false }; hq.customRoles.push(role); db.partnerRoleId = role.id; }
  let star = hq.customRoles.find(r => r.id === db.starRoleId);
  if (!star) { star = { id: id(), name: 'Yıldız Sunucu', color: '#ffc23d', perms: [], hoist: true, icon: '⭐', mentionable: false }; hq.customRoles.push(star); db.starRoleId = star.id; }
  const salon = hq.channels.find(c => c.id === db.partnerChId);
  if (salon) { if (salon.name === 'partner-salonu') { salon.name = 'yildiz-salonu'; salon.topic = 'Yıldız ve Partner sunucu sahipleri ile Kanka ekibi. Fikirler, etkinlikler, iş birlikleri.'; } salon.perms = { ...salon.perms, [star.id]: { view: true } }; }
  if (!salon) {
    const ch = { id: id(), name: 'yildiz-salonu', type: 'text', topic: 'Yıldız ve Partner sunucu sahipleri ile Kanka ekibi. Fikirler, etkinlikler, iş birlikleri.', sync: false, perms: { '@everyone': { view: false }, [role.id]: { view: true }, [star.id]: { view: true } } };
    const last = hq.channels.findLastIndex(c => c.type !== 'voice'); hq.channels.splice(last + 1, 0, ch); db.partnerChId = ch.id;
    (db.messages[ch.id] ||= []).push({ id: id(), author: BOT_NAME, color: '#ff8a4c', time: Date.now(), kind: 'text', text: '⭐ yıldız salonuna hoş geldiniz! burası yıldız ve partner sunucu sahipleri ile kanka ekibi için. fikirlerinizi, etkinliklerinizi ve iş birliği tekliflerinizi buraya yazabilirsiniz.', reactions: {} });
  }
  for (const [r, key] of [[role, 'partner'], [star, 'yildiz']]) { const owners = new Set(db.servers.filter(x => x.badges?.[key]).map(x => x.owner));
    for (const n of Object.keys(db.users)) { const l = hq.memberRoles[n] || [], has = l.includes(r.id), want = owners.has(n);
      if (want && !has) hq.memberRoles[n] = [...l, r.id];
      else if (!want && has) { hq.memberRoles[n] = l.filter(x => x !== r.id); if (!hq.memberRoles[n].length) delete hq.memberRoles[n]; } } }
  save(); pushServers(membersOf(hq)); pushUsers(); // sahibin profil rozeti güncellensin
}
// ================= Uçtan uca şifreleme (DM ve grup DM) =================
// Sunucu anahtarları hiç görmez: her hesabın ECDH (P-256) anahtar çifti cihazda üretilir; gizli anahtar kullanıcının
// şifresiyle (PBKDF2) kilitlenip burada saklanır. Her sohbetin rastgele bir "sohbet anahtarı" (dönem/epoch) vardır,
// üyelerin açık anahtarlarına sarılır (wraps). Mesajlar sadece bu anahtarla şifreli metin olarak tutulur.
const B64 = /^[A-Za-z0-9+/=_-]+$/;
const b64ok = (x, max) => typeof x === 'string' && x.length > 0 && x.length <= max && B64.test(x);
const e2eChat = chId => isPrivateChat(chId) && !chatMembers(chId).some(n => n === 'Claude' || n === BOT_NAME || db.users[n]?.bot);
const e2eKid = pubB64 => crypto.createHash('sha256').update(Buffer.from(pubB64, 'base64')).digest('hex').slice(0, 16);
const e2eCur = n => db.users[n]?.e2e || null;
function e2ePubs(names) { const o = {}; for (const n of names) { const u = db.users[n]; if (!u) continue; if (u.e2e) o[u.e2e.kid] = { n, pub: u.e2e.pub }; for (const k of u.e2eOld || []) o[k.kid] = { n, pub: k.pub, old: true }; } return o; }
function e2eConvView(chId) {
  const c = db.e2e?.[chId], mem = chatMembers(chId);
  return { chId, cid: c?.cid || chId, eligible: e2eChat(chId), members: mem.map(n => ({ n, kid: e2eCur(n)?.kid || null, was: (db.users[n]?.oldNames || []).map(o => o.n) })), eps: c?.eps || [], keys: e2ePubs(mem) };
}
// Bu kişinin açabildiği ama başka bir üyenin güncel anahtarına henüz sarılmamış dönemler (yeniden paylaşım işi)
function e2eTodo(me) {
  const out = [], myKids = new Set([e2eCur(me)?.kid, ...(db.users[me]?.e2eOld || []).map(k => k.kid)].filter(Boolean));
  for (const [chId, c] of Object.entries(db.e2e || {})) {
    const mem = chatMembers(chId); if (!mem.includes(me)) continue;
    for (const ep of c.eps) { if (![...myKids].some(k => ep.wraps[k])) continue;
      for (const n of mem) { const k = e2eCur(n)?.kid; if (k && !ep.wraps[k]) out.push({ chId, ep: ep.id, kid: k }); } }
    if (out.length > 400) break;
  }
  return out;
}
function e2eNudge(name) { // anahtarı değişen kişinin sohbet arkadaşlarına: "geçmişi ona yeniden paylaş"
  const peers = new Set(); for (const chId of Object.keys(db.e2e || {})) { const mem = chatMembers(chId); if (mem.includes(name)) mem.forEach(n => peers.add(n)); }
  for (const n of peers) io.to('user:' + n).emit('e2eNeed');
}
// Şikayet için mesaj mühürü: gönderen HMAC(fk, düz metin) taahhüdünü mesajla birlikte yollar; şikayet eden fk ve metni açınca doğrulanır
const e2eFrankOk = (msg, plain, fk) => { try { return typeof plain === 'string' && plain.length <= 40000 && b64ok(fk, 64) && msg?.fc && crypto.createHmac('sha256', Buffer.from(fk, 'base64')).update(plain).digest('base64') === msg.fc; } catch { return false; } };
// ---- Kanka Bot'tan özel mesaj (sadece okunur bildirim kanalı) ----
function botDm(name, o) {
  if (!db.users[name]) return; const chId = dmId(BOT_NAME, name);
  const msg = botPost(chId, o); io.to('user:' + name).emit('dms', dmsFor(name));
  io.to('user:' + name).emit('message', { channelId: chId, msg }); // DM odasına girmemiş olsa da gelsin (okunmadı noktası)
  notifyUser(name, { from: BOT_NAME, text: o.title || 'Yeni mesaj', channelId: chId, dm: true }); // sesli bildirim + telefona/masaüstüne bildirim
}
// ---- Bot geliştiriciler: kabul edilen → aday (HQ'da rol + oda); rozet → botu gerçekten kullanılınca ----
const DEV_GOAL = { servers: 3, cmds: 50 };
function devPerks() {
  const hq = db.servers.find(x => x.id === 's1'); if (!hq) return;
  hq.customRoles ||= []; hq.memberRoles ||= {};
  let role = hq.customRoles.find(r => r.id === db.devRoleId);
  if (!role) { role = { id: id(), name: 'Bot Geliştirici', color: '#5b8cff', perms: [], hoist: true, icon: '🛠️', mentionable: true }; hq.customRoles.push(role); db.devRoleId = role.id; }
  if (!hq.channels.some(c => c.id === db.devChId)) {
    const ch = { id: id(), name: 'bot-gelistirici', type: 'text', topic: 'Bot geliştirici adayları ve Kanka ekibi. Sorular, fikirler, hata bildirimleri, duyurular.', sync: false, perms: { '@everyone': { view: false }, [role.id]: { view: true } } };
    const last = hq.channels.findLastIndex(c => c.type !== 'voice'); hq.channels.splice(last + 1, 0, ch); db.devChId = ch.id;
    (db.messages[ch.id] ||= []).push({ id: id(), author: BOT_NAME, color: '#ff8a4c', time: Date.now(), kind: 'text', text: '🛠️ bot geliştirici odasına hoş geldiniz! bot sistemiyle ilgili duyurular, sorular ve fikirler burada. kanka ekibi de burada, takıldığınız yeri yazın.', reactions: {} });
  }
  for (const n of Object.keys(db.users)) { const u = db.users[n], want = !!(u.devBeta || u.devEarned), l = hq.memberRoles[n] || [], has = l.includes(role.id);
    if (want && !hq.members.includes(n) && !hq.public) continue;
    if (want && !has) hq.memberRoles[n] = [...l, role.id]; else if (!want && has) { hq.memberRoles[n] = l.filter(x => x !== role.id); if (!hq.memberRoles[n].length) delete hq.memberRoles[n]; } }
  save(); pushServers(membersOf(hq));
}
// Bot API sayaçları (u.devStats) güncellenince çağrılır: şart tamamsa rozet + tebrik mesajı
function devCheck(name) {
  const u = db.users[name]; if (!u || !u.devBeta || u.devEarned) return;
  const st = u.devStats || {}; if ((st.servers || 0) < DEV_GOAL.servers || (st.cmds || 0) < DEV_GOAL.cmds) return;
  devAward(name, 'otomatik');
}
function devAward(name, by) {
  const u = db.users[name]; if (!u) return; u.devEarned = true; (u.badgeAt ||= {}).dev = Date.now(); const a = db.devApps?.[name]; if (a) { a.earnedAt = Date.now(); a.earnedBy = by; }
  save(); pushUsers(); devPerks();
  botDm(name, { title: '🛠️ Bot Geliştirici rozeti senin!', tone: 'good', text: 'botun gerçekten kullanılıyor, eline sağlık! profilinde artık bot geliştirici rozeti var. kanka\'yı birlikte büyütüyoruz 🧡' });
}
setTimeout(() => { // bir kerelik: eski kuralla rozet alanlar rozetlerini korur
  if (!db.devRule2) { for (const u of Object.values(db.users)) if (u.devBeta) u.devEarned = true; db.devRule2 = Date.now(); save(); }
  devPerks();
}, 5000);
// ---- Partner yolu: Topluluk (otomatik) → Yükselen (otomatik) → Kanka Partner (başvuru, ekip karar verir) ----
const PT = { topluluk: { members: 15, days: 7 }, yukselen: { members: 30, days: 7, active: 10, rules: true }, yildiz: { members: 100, days: 21, active: 30, rules: true } };
const activeCache = new Map();
// Son 7 günde sunucunun yazı odalarında en az bir mesaj yazan farklı üye sayısı (botlar sayılmaz), 5 dk önbellek
function activeWeek(s) {
  const c = activeCache.get(s.id); if (c && Date.now() - c.t < 300e3) return c.n;
  const since = Date.now() - 7 * 864e5, who = new Set();
  for (const ch of s.channels || []) { const l = msgRaw[ch.id]; if (!l) continue;
    for (let i = l.length - 1; i >= 0 && l[i].time > since; i--) { const a = l[i].author; if (a && a !== BOT_NAME && a !== 'Claude' && db.users[a] && !db.users[a].bot) who.add(a); } }
  activeCache.set(s.id, { t: Date.now(), n: who.size }); return who.size;
}
const hasRules = s => !!(s.welcome?.rules?.length || (s.channels || []).some(c => /kural|rules/i.test(c.name)));
const srvStats = s => ({ members: membersOf(s).length, days: Math.floor((Date.now() - (s.createdAt || Date.now())) / 864e5), active: activeWeek(s), rules: hasRules(s) });
const meets = (st, r) => st.members >= r.members && st.days >= r.days && (!r.active || st.active >= r.active) && (!r.rules || st.rules);
const emojiLimit = s => (isStar(s) || s.id === 's1' ? 200 : srvBadges(s).some(b => b.id === 'yukselen') ? 100 : 50) + energyPerk(s, 'emoji');
function srvBadges(s) {
  const b = [];
  if (s.id === 's1' || (db.devServer && s.id === db.devServer)) b.push({ id: 'resmi', since: s.createdAt || null });
  for (const id of ['dogrulanmis', 'partner', 'yildiz']) if (s.badges?.[id]) b.push({ id, by: s.badges[id].by, since: s.badges[id].time });
  const age = Date.now() - (s.createdAt || 0);
  if (s.id !== 's1' && membersOf(s).length >= 15 && (!s.createdAt || age > 7 * 864e5)) b.push({ id: 'topluluk' });
  if (s.id !== 's1' && !isStar(s) && membersOf(s).length >= PT.yukselen.members && meets(srvStats(s), PT.yukselen)) b.push({ id: 'yukselen' });
  return b;
}
const serverView = (s, viewer) => (s.customRoles ||= [], s.memberRoles ||= {}, s.bans ||= {}, s.timeouts ||= {}, {
  id: s.id, name: s.name, icon: s.icon, iconImg: s.iconImg || null, banner: s.banner || null, bannerColor: s.bannerColor || null, owner: s.owner || null, invite: s.invite, vanity: vanityOk(s) ? s.vanity || null : null, energy: { total: energyTotal(s), level: energyLevel(s) }, public: s.public, roles: s.roles,
  emojis: s.emojis || {}, emojiMeta: s.emojiMeta || {}, sounds: s.sounds || [], tag: s.tag || null, tagAllowed: TAG.allowedServer(s), chIconAllowed: CHICON.allowed(s), perks: perksOf(s), perkLv: PERK_LV,
  theme: s.theme || null, chatBg: s.chatBg || null, chatBgDim: s.chatBgDim ?? 0.6, sbAll: s.sbAll !== false, filter: !!s.filter, slow: s.slow || 0,
  channels: (viewer ? s.channels.filter(c => seesChannel(s, c, viewer)) : s.channels).map(c => chView(s, c, viewer, viewer && can(s, viewer, 'manageChannels'))),
  categories: (s.categories || []).filter(k => !viewer || can(s, viewer, 'manageChannels') || s.channels.some(c => c.cat === k.id && seesChannel(s, c, viewer)))
    .map(k => ({ id: k.id, name: k.name, ...(viewer && can(s, viewer, 'manageChannels') ? { perms: k.perms || {} } : {}) })), members: s.public ? Object.keys(db.users) : s.members,
  customRoles: s.customRoles, memberRoles: s.memberRoles, timeouts: Object.fromEntries(Object.entries(s.timeouts || {}).filter(([, t]) => t > Date.now())),
  bans: viewer && (s.owner === viewer || can(s, viewer, 'ban')) ? s.bans : {}, myPerms: viewer ? [...permsOf(s, viewer)] : [],
  badges: srvBadges(s), createdAt: s.createdAt || null, siteAdmin: siteAdmin(viewer), lockChannels: !!s.lockChannels,
  discoverable: !!s.discoverable, description: s.description || '', category: s.category || null,
  setup: viewer && s.owner === viewer ? setupOf(s) : null,
  afk: s.afk || null,
  tplUndo: viewer && s.owner === viewer && s.tplUndo && Date.now() - s.tplUndo.t < TPL_UNDO_MS ? { t: s.tplUndo.t, channels: s.tplUndo.added.channels.length, categories: s.tplUndo.added.categories.length, roles: s.tplUndo.added.roles.length } : null,
  bot: viewer && can(s, viewer, 'manageServer') ? botCfg(s) : { added: !!s.bot?.added, mod: { on: botOn(s, 'mod') }, welcome: { on: botOn(s, 'welcome') }, ticket: { on: botOn(s, 'ticket'), askReason: s.bot?.ticket?.askReason !== false } },
  myTicketStaff: viewer ? isTicketStaff(s, viewer) : false, appCmds: cmdsFor(s, viewer),
  welcome: s.welcome || null, accepted: !s.welcome?.enabled || !!s.accepted?.[viewer] || s.owner === viewer,
  secLevel: s.secLevel || 0, sec: viewer ? secMissing(s, viewer) : [], gate: s.gate || null, apply: viewer ? s.applications?.[viewer]?.st || null : null,
  appsWaiting: viewer && isMod(s, viewer) ? Object.values(s.applications || {}).filter(a => a.st === 'bekliyor').length : 0, temp: !!s.temp?.[viewer]
});
const findChannel = chId => {
  for (const s of db.servers) { const c = s.channels.find(c => c.id === chId); if (c) return { s, c }; }
  return null;
};
const dmId = (a, b) => 'dm:' + [a, b].sort().join('|');
const dmPeers = chId => chId.slice(3).split('|');
const groupOf = chId => chId?.startsWith('g:') ? db.groups?.[chId.slice(2)] : null;
const chatMembers = chId => chId.startsWith('dm:') ? dmPeers(chId) : groupOf(chId)?.members || [];
const isPrivateChat = chId => chId?.startsWith('dm:') || chId?.startsWith('g:');
function canAccess(name, chId) {
  if (!name || !chId) return false;
  if (typeof chId !== 'string') return false;
  if (chId.startsWith('dm:')) { const p = dmPeers(chId); return p.length === 2 && chId === dmId(p[0], p[1]) && p.includes(name) && p.every(n => Object.hasOwn(db.users, n) || n === BOT_NAME); }
  if (chId.startsWith('g:')) return !!groupOf(chId)?.members.includes(name);
  const f = findChannel(chId);
  return !!f && (f.c.type === 'text' || f.c.type === 'forum' || voiceLike(f.c.type)) && (f.s.public || f.s.members.includes(name)) && !f.s.bans?.[name] && seesChannel(f.s, f.c, name);
}
// Mesaj silinince/temizlenince okunmamış sayaçlarını geri al: silinenlerin zamanları + kanalda kalan son mesajın zamanı
function unActivity(chId, gone) {
  const times = (gone || []).map(m => m?.time || 0), last = (msgRaw[chId] || []).at(-1)?.time || 0;
  if (!times.length) return;
  const to = isPrivateChat(chId) ? chatMembers(chId) : (() => { const f = findChannel(chId); return f ? membersOf(f.s).filter(n => canAccess(n, chId)) : []; })();
  for (const n of to) io.to('user:' + n).emit('chanUnact', { channelId: chId, last, times });
}
function dmsFor(name) {
  const dms = Object.keys(msgRaw)
    .filter(k => k.startsWith('dm:') && dmPeers(k).includes(name) && msgRaw[k].length)
    .map(k => ({ id: k, with: dmPeers(k).find(n => n !== name) || name, last: msgRaw[k].at(-1).time }));
  const groups = Object.values(db.groups || {}).filter(g => g.members.includes(name))
    .map(g => ({ id: 'g:' + g.id, group: true, name: g.name, members: g.members, owner: g.owner, last: msgRaw['g:' + g.id]?.at(-1)?.time || g.created }));
  return [...dms, ...groups].sort((a, b) => b.last - a.last);
}
// Her odanın, kullanıcı dışındaki biri tarafından yazılmış son mesajının zamanı (okunmamış noktaları için)
function lastMsgTimes(name) {
  const o = {}, lastOther = ch => { const l = msgRaw[ch]; if (!l) return 0; for (let i = l.length - 1; i >= Math.max(0, l.length - 50); i--) if (l[i].author && l[i].author !== name) return l[i].time; return 0; };
  for (const sv of serversFor(name)) for (const c of sv.channels) if (!voiceLike(c.type) && seesChannel(sv, c, name)) { const t = lastOther(c.id); if (t) o[c.id] = t; }
  for (const d of dmsFor(name)) { const t = lastOther(d.id); if (t) o[d.id] = t; }
  return o;
}
const groupTitle = g => g.name || g.members.slice(0, 4).join(', ');
const findMsg = (chId, msgId) => (db.messages[chId] || []).find(m => m.id === msgId);
const roleOf = (s, n) => s.roles?.[n] || 'member';
// Sahiplik role bağlı değildir: sahip rolü ne olursa olsun tüm yetkilere sahiptir
const isAdmin = (s, n) => s.owner === n || roleOf(s, n) === 'admin';
// Üye sunucudan çıkınca (ayrılma, atılma, yasak, geçici üyelik, ret) sunucudaki rolleri ve kabul bilgisi silinir;
// geri gelirse yeni üye gibi başlar. Susturma (kaçmak için çık-gir yapılmasın) ve seviye (XP) korunur.
// ================= Kanka Spark & Energy =================
// Spark aboneliği her ay 2 Energy verir; her 3 kesintisiz ayda +1 bonus. Energy sunuculara gönderilir, istenince geri çekilir.
// Abonelik biterse tüm Energy'ler (sunuculardakiler dahil) silinir, sadakat sayacı sıfırlanır.
const SPARK_MONTH = 30 * 864e5, SPARK_PER_MONTH = 2, SPARK_BONUS_EVERY = 3;
const ENERGY_LV = [0, 2, 7, 14]; // Energy Level eşikleri (Total Energy)
// Görünüm avantajları seviyeyle birikir (üst seviye alttakileri de içerir)
const EP1 = { chIcon: true, chColor: true, roleEmoji: true }, EP2 = { ...EP1, theme: true, roleGrad: true, roleFont: true, chFont: true }, EP3 = { ...EP2, chatBg: true };
const ENERGY_PERKS = [null,
  { emoji: 50, sb: 10, ...EP1, items: ['+50 özel emoji yeri', '+10 ses paneli yeri', 'Sunucu listesinde Energy rozeti', 'Oda simgeleri (emoji)', 'Oda adı rengi', 'Rollere özel emoji simgesi'] },
  { emoji: 100, sb: 20, studio: true, ...EP2, items: ['+100 özel emoji yeri', '+20 ses paneli yeri', 'Stüdyo ses kalitesi (256 kbps)', 'Sunucu renk teması', 'Oda adı yazı tipi', 'Rol renk geçişi ve yazı tipi'] },
  { emoji: 150, sb: 30, studio: true, vanity: true, ...EP3, items: ['+150 özel emoji yeri', '+30 ses paneli yeri', 'Özel davet linki (kankahq.com/s/…)', 'Sohbet arka plan fotoğrafı'] }];
const PERK_KEYS = ['chIcon', 'chColor', 'chFont', 'theme', 'chatBg', 'roleGrad', 'roleFont', 'roleEmoji'];
const PERK_LV = Object.fromEntries(PERK_KEYS.map(k => [k, ENERGY_PERKS.findIndex(p => p?.[k])]));
const perkOn = (s, k) => !!energyPerk(s, k) || isStar(s) || s?.id === 's1'; // Yıldız sunucular ve Kanka HQ hepsini kullanır
const perksOf = s => Object.fromEntries(PERK_KEYS.map(k => [k, perkOn(s, k)]));
const perkErr = k => `Bu özellik Energy Level ${PERK_LV[k]} ile açılır. Üyeler sunucuya Energy gönderdikçe seviye artar.`;
const FONT_IDS = ['serif', 'cinzel', 'rounded', 'script', 'pixel', 'cyber', 'mono'];
const INTROS = ['burst', 'portal', 'confetti', 'hearts', 'neon', 'flame', 'glitch', 'stars'];
// Google Play aboneliğinde yenileme bildirimi birkaç saat gecikebilir: bitişten sonra 6 saat açık kalır, kesin kararı playSync verir
const sparkOn = u => !!(u?.spark && u.spark.until + (u.spark.play ? 6 * 3600e3 : 0) > Date.now());
const energyTotal = s => Object.values(s?.energy || {}).reduce((a, b) => a + b, 0);
const energyLevel = s => { const t = energyTotal(s); let l = 0; for (let i = 1; i < ENERGY_LV.length; i++) if (t >= ENERGY_LV[i]) l = i; return l; };
const energyPerk = (s, k) => { const l = energyLevel(s); return l ? ENERGY_PERKS[l][k] || 0 : 0; };
const vanityOk = s => isStar(s) || !!energyPerk(s, 'vanity');
function energyView(s, viewer) {
  const t = energyTotal(s), l = energyLevel(s), u = db.users[viewer];
  return { total: t, level: l, next: ENERGY_LV[l + 1] ?? null, levels: ENERGY_LV, perks: ENERGY_PERKS.map(p => p?.items || []),
    mine: s.energy?.[viewer] || 0, free: (u?.spark?.energy || []).filter(x => !x.srv).length, spark: sparkOn(u),
    by: Object.entries(s.energy || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 50).map(([name, n]) => ({ name, n })) };
}
function sparkView(u) {
  const sp = u?.spark; if (!sp) return { active: false };
  const e = sp.energy || [], placed = {}; for (const x of e) if (x.srv) placed[x.srv] = (placed[x.srv] || 0) + 1;
  const done = sp.credited || 0;
  return { active: sparkOn(u), since: sp.since, until: sp.until, months: done, play: !!sp.play, nextBonusIn: SPARK_BONUS_EVERY - (done % SPARK_BONUS_EVERY),
    nextCredit: sp.since + done * SPARK_MONTH < sp.until ? sp.since + done * SPARK_MONTH : null, energy: e.length, free: e.filter(x => !x.srv).length,
    placed: Object.entries(placed).map(([sid, n]) => { const sv = db.servers.find(x => x.id === sid); return { sid, n, name: sv?.name || 'Silinmiş sunucu', icon: sv?.icon || '', iconImg: sv?.iconImg || null, level: sv ? energyLevel(sv) : 0, total: sv ? energyTotal(sv) : 0 }; }) };
}
function energyTouch(sids) { for (const sid of new Set(sids)) { const s = db.servers.find(x => x.id === sid); if (s) pushServers(membersOf(s)); } }
function energyMove(u, s, d) { // d>0: sunucuya gönder, d<0: geri çek
  const e = u.spark?.energy || []; let moved = 0;
  if (d > 0) for (const x of e) { if (moved >= d) break; if (!x.srv) { x.srv = s.id; x.sentAt = Date.now(); moved++; } }
  else for (const x of e) { if (moved >= -d) break; if (x.srv === s.id) { delete x.srv; delete x.sentAt; moved++; } }
  if (!moved) return 0;
  s.energy ||= {}; s.energy[u.name] = (s.energy[u.name] || 0) + (d > 0 ? moved : -moved); if (s.energy[u.name] <= 0) delete s.energy[u.name];
  botEnergy(s, u.name, d > 0 ? moved : -moved);
  return moved;
}
function energyRelease(name, sid) { // üye sunucudan çıkınca / sunucu silinince Energy sahibine geri döner (boşta kalır)
  const u = db.users[name], s = db.servers.find(x => x.id === sid) || { id: sid };
  for (const x of u?.spark?.energy || []) if (x.srv === sid) { delete x.srv; delete x.sentAt; }
  const had = s.energy?.[name] || 0; if (s.energy) delete s.energy[name]; if (had && s.members) botEnergy(s, name, -had);
}
function sparkCredit(u) { // vadesi gelen ayların Energy'sini ekle (her ay 2, her 3 ayda +1 bonus)
  const sp = u.spark; if (!sp) return false; sp.energy ||= []; let ch = false;
  while (sp.since + (sp.credited || 0) * SPARK_MONTH <= Date.now() && sp.since + (sp.credited || 0) * SPARK_MONTH < sp.until) {
    sp.credited = (sp.credited || 0) + 1; ch = true;
    for (let i = 0; i < SPARK_PER_MONTH; i++) sp.energy.push({ id: id(), at: Date.now(), src: 'ay' });
    if (sp.credited % SPARK_BONUS_EVERY === 0) { sp.energy.push({ id: id(), at: Date.now(), src: 'bonus' });
      botDm(u.name, { title: '⚡ Sadakat bonusu!', tone: 'good', text: `${sp.credited} aydır kesintisiz Kanka Spark'tasın. Teşekkürler! Hesabına 1 bonus Energy eklendi.` }); }
  }
  return ch;
}
function sparkExpire(u, why = 'Kanka Spark aboneliğin sona erdi') {
  const sids = (u.spark?.energy || []).map(x => x.srv).filter(Boolean);
  for (const sid of new Set(sids)) { const s = db.servers.find(x => x.id === sid); if (s?.energy) delete s.energy[u.name]; }
  delete u.spark; save(); energyTouch(sids); io.to('user:' + u.name).emit('spark', sparkView(u)); pushUsers();
  botDm(u.name, { title: '⚡ Kanka Spark sona erdi', tone: 'info', text: `${why}. Spark avantajların kaldırıldı; sunuculara gönderdiğin Energy'ler de silindi. Yeniden abone olduğunda her şey sıfırdan başlar.` });
}
function sparkGrant(u, months, by) { // ödeme/yenileme ya da ekip tarafından verilen abonelik süresi
  if (u.spark && !sparkOn(u)) sparkExpire(u, 'Önceki Kanka Spark aboneliğin bitmişti');
  const fresh = !u.spark;
  if (fresh) u.spark = { since: Date.now(), until: Date.now(), credited: 0, energy: [] };
  u.spark.until += months * SPARK_MONTH; (u.spark.log ||= []).push({ at: Date.now(), months, by }); u.spark.log = u.spark.log.slice(-30);
  sparkCredit(u); save(); io.to('user:' + u.name).emit('spark', sparkView(u)); pushUsers();
  if (fresh) botDm(u.name, { title: '⚡ Kanka Spark\'a hoş geldin!', tone: 'good', text: `Aboneliğin başladı. Hesabına ${SPARK_PER_MONTH} Energy eklendi: bir sunucunun sayfasında "Sunucuya Energy Gönder" ile destekleyebilirsin. Her ay ${SPARK_PER_MONTH} Energy daha gelir, her 3 ayda bir de bonus.` });
}
setInterval(() => { try { // abonelik sayacı: ay dolunca Energy ver, süresi bitince sonlandır
  let ch = false;
  for (const u of Object.values(db.users)) { if (!u.spark) continue; if (!sparkOn(u)) sparkExpire(u); else if (sparkCredit(u)) { ch = true; io.to('user:' + u.name).emit('spark', sparkView(u)); } }
  if (ch) save();
} catch (e) { console.error('spark', e); } }, 5 * 60e3);
// ================= Google Play Faturalandırma (Kanka Spark aboneliği, Android uygulaması) =================
// Satın alma telefonda Google Play ekranında olur. Uygulama purchaseToken'ı gönderir; sunucu Google Play Developer API
// (purchases.subscriptionsv2) ile doğrular, Spark'ı Google'ın verdiği bitiş tarihine kadar açar ve satın almayı onaylar
// (3 gün içinde onaylanmayan satın almayı Google iade eder). Yenileme, iptal, askı ve iadeler Google'ın gerçek zamanlı
// bildirimleriyle (/play/rtdn, Pub/Sub push) ve 30 dakikalık kontrolle güncellenir. Kart bilgisi Kanka'ya hiç gelmez.
const PLAY_PKG = 'com.kanka.chat', PLAY_SPARK = ['kanka_spark'];
const PLAY_ON = ['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', 'SUBSCRIPTION_STATE_CANCELED'];
const playAcct = name => crypto.createHash('sha256').update('kanka-play|' + (uidOf(db.users[name]) || name)).digest('hex').slice(0, 48);
const playReady = () => !!npCfg.play?.private_key;
let playTok = null;
async function playAccess() {
  const sa = npCfg.play; if (!sa?.private_key) throw new Error('Google Play hizmet hesabı ayarlı değil');
  if (playTok && playTok.exp > Date.now() + 60e3) return playTok.t;
  const now = Math.floor(Date.now() / 1000), head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' })),
    body = b64u(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher', aud: sa.token_uri || 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = b64u(crypto.createSign('RSA-SHA256').update(head + '.' + body).sign(sa.private_key));
  const r = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + body + '.' + sig }) });
  const j = await r.json(); if (!j.access_token) throw new Error('Google Play giriş: ' + (j.error_description || j.error || r.status));
  playTok = { t: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 }; return playTok.t;
}
const PLAY_API = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PLAY_PKG}/purchases/subscriptions`;
async function playGet(token) {
  const r = await fetch(`${PLAY_API}v2/tokens/${encodeURIComponent(token)}`, { headers: { Authorization: 'Bearer ' + await playAccess() } });
  const j = await r.json().catch(() => ({}));
  if (r.status === 404 || r.status === 410) return { gone: true };
  if (!r.ok) throw new Error('Google Play: ' + (j.error?.message || r.status));
  return j;
}
async function playAck(productId, token) {
  const r = await fetch(`${PLAY_API}/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}:acknowledge`, { method: 'POST', headers: { Authorization: 'Bearer ' + await playAccess(), 'Content-Type': 'application/json' }, body: '{}' });
  if (!r.ok) throw new Error('Google Play onay: ' + r.status);
}
function sparkPlay(u, until, token) { // Google Play aboneliği: bitiş tarihini Google belirler
  if (!u.spark || !sparkOn(u)) sparkGrant(u, 0, 'google-play'); // yeni abonelik: hoş geldin mesajı ve sayaç
  const sp = u.spark;
  if (until > sp.until) sp.until = until;
  if (sp.play !== token) { sp.play = token; (sp.log ||= []).push({ at: Date.now(), months: 0, by: 'google-play' }); sp.log = sp.log.slice(-30); }
  sparkCredit(u); save(); io.to('user:' + u.name).emit('spark', sparkView(u)); pushUsers();
}
async function playSync(token, claimer = null) { // Google'dan güncel durumu al, Spark'ı aç/kapat, gerekiyorsa onayla
  db.playSubs ||= {};
  const info = await playGet(token), rec = db.playSubs[token];
  if (info.gone) { if (rec) { const u = db.users[rec.u]; if (u?.spark?.play === token) sparkExpire(u, 'Google Play aboneliğin bulunamadı (iade edilmiş ya da silinmiş olabilir)'); delete db.playSubs[token]; save(); } return { error: 'Satın alma Google Play\'de bulunamadı' }; }
  const li = (info.lineItems || []).find(l => PLAY_SPARK.includes(l.productId));
  if (!li) return { error: 'Bu satın alma Kanka Spark değil' };
  const acct = info.externalAccountIdentifiers?.obfuscatedExternalAccountId || '';
  let owner = rec?.u || null;
  if (!owner && acct) owner = (claimer && playAcct(claimer) === acct) ? claimer : Object.keys(db.users).find(n => playAcct(n) === acct) || null;
  if (!owner && claimer && !acct) owner = claimer; // hesap kimliği olmadan yapılmış satın alma (Play Console test satın alması)
  if (claimer && owner && owner !== claimer) return { error: 'Bu abonelik başka bir Kanka hesabına bağlı. O hesapla giriş yap.' };
  if (!owner || !db.users[owner]) { if (rec) { delete db.playSubs[token]; save(); } return { error: 'Aboneliğin bağlı olduğu Kanka hesabı bulunamadı' }; }
  if (info.linkedPurchaseToken && db.playSubs[info.linkedPurchaseToken]?.u === owner) delete db.playSubs[info.linkedPurchaseToken]; // yenilenen/yükseltilen eski abonelik
  const exp = Date.parse(li.expiryTime || '') || 0, st = info.subscriptionState || '', on = PLAY_ON.includes(st) && exp > Date.now();
  db.playSubs[token] = { u: owner, p: li.productId, at: rec?.at || Date.now(), st, exp, chk: Date.now(), test: !!info.testPurchase, yenile: !!li.autoRenewingPlan?.autoRenewEnabled };
  const u = db.users[owner];
  if (on) sparkPlay(u, exp, token);
  else if (u.spark?.play === token) sparkExpire(u, st === 'SUBSCRIPTION_STATE_ON_HOLD' ? 'Google Play ödemen alınamadığı için aboneliğin beklemeye alındı. Ödeme yöntemini Google Play\'den güncelleyince Spark geri açılır'
    : st === 'SUBSCRIPTION_STATE_PAUSED' ? 'Google Play aboneliğin duraklatıldı' : 'Google Play aboneliğin sona erdi');
  if (on && info.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING') { try { await playAck(li.productId, token); } catch (e) { console.error('play ack', e.message); } }
  save();
  return { ok: true, active: on, until: exp, state: st, pending: st === 'SUBSCRIPTION_STATE_PENDING', me: sparkView(u) };
}
app.post('/play/rtdn', express.json({ limit: '16kb' }), (req, res) => { // Google Play gerçek zamanlı geliştirici bildirimleri (Pub/Sub push)
  if (npCfg.playRtdnKey && req.query.k !== npCfg.playRtdnKey) return res.status(403).end();
  res.status(204).end();
  if (!playReady() || limited('play-rtdn', 600, 60e3)) return;
  let d; try { d = JSON.parse(Buffer.from(String(req.body?.message?.data || ''), 'base64').toString('utf8')); } catch { return; }
  if (d?.packageName !== PLAY_PKG) return;
  const pr = d.pendingRefundReviewNotification; // ters ibraz (chargeback) incelemesi: 24 saat içinde görüş bildir. Kanka tarafsız kalır, karar Google'ın
  if (pr?.pendingRefundToken && pr.orderId) { playAccess().then(at => fetch(`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PLAY_PKG}/orders/${encodeURIComponent(pr.orderId)}:reviewrefund`, { method: 'POST',
    headers: { Authorization: 'Bearer ' + at, 'Content-Type': 'application/json' }, body: JSON.stringify({ pendingRefundToken: pr.pendingRefundToken, sampleContentProvided: true, refundPreference: 'NEUTRAL' }) }))
    .then(r => { if (!r.ok) console.error('play reviewrefund', r.status); }).catch(e => console.error('play reviewrefund', e.message)); return; }
  const token = d.subscriptionNotification?.purchaseToken || d.voidedPurchaseNotification?.purchaseToken; // sahte bildirim zararsız: durum hep Google'dan okunur
  if (token && String(token).length < 400) playSync(String(token)).catch(e => console.error('play rtdn', e.message));
});
setInterval(async () => { // bildirim kaçarsa: bitişi yaklaşan / beklemedeki abonelikleri yokla
  if (!playReady()) return;
  for (const [t, r] of Object.entries(db.playSubs || {})) {
    if (Date.now() - (r.chk || 0) < 30 * 60e3) continue;
    const due = r.st === 'SUBSCRIPTION_STATE_PENDING' ? Date.now() - r.at < 4 * 864e5 : PLAY_ON.includes(r.st) || r.st === 'SUBSCRIPTION_STATE_ON_HOLD' ? r.exp < Date.now() + 3 * 3600e3 || r.st === 'SUBSCRIPTION_STATE_ON_HOLD' : false;
    if (!due) { if (!PLAY_ON.includes(r.st) && r.st !== 'SUBSCRIPTION_STATE_ON_HOLD' && Date.now() - (r.chk || 0) > 90 * 864e5) delete db.playSubs[t]; continue; }
    try { await playSync(t); } catch (e) { console.error('play sync', e.message); r.chk = Date.now(); }
  }
}, 10 * 60e3);
function wipeMember(s, n) {
  if (s.energy?.[n]) energyRelease(n, s.id); // çıkan üyenin Energy'si kendisine geri döner
  if (db.users[n]?.tag === s.id) delete db.users[n].tag; // sunucudan çıkan etiketini de bırakır
  delete s.roles?.[n]; delete s.memberRoles?.[n]; delete s.joinedAt?.[n]; delete s.accepted?.[n]; delete s.temp?.[n];
  if (s.applications?.[n]?.st !== 'ret') delete s.applications?.[n];
  if (s.bot?.autorole?.pending) delete s.bot.autorole.pending[n];
}
const isMod = (s, n) => isAdmin(s, n) || roleOf(s, n) === 'mod' || can(s, n, 'manageChannels');
const serverOf = chId => chId && !isPrivateChat(chId) ? findChannel(chId)?.s : null;
const UPLOAD_RE = /^\/uploads\/[a-f0-9]+\.(png|jpe?g|gif|webp)$/;
// Hazır K6 Noir Monogram profil avatarları (public/avatar)
const PRESET_AV = ['asit', 'turkuaz', 'kizil', 'mor', 'altin', 'buzul', 'zumrut', 'pembe', 'turuncu', 'indigo', 'krom', 'ters-asit'].map(k => `/avatar/k6-${k}.svg`);
const pickPresetAv = () => PRESET_AV.length ? PRESET_AV[crypto.randomInt(PRESET_AV.length)] : null;
const AVATAR_OK = a => UPLOAD_RE.test(a) || PRESET_AV.includes(a);
// Eski kaldırılan rakun avatarlarını kullanan hesapları yeni K6 Noir setine geçir
for (const u of Object.values(db.users || {})) { if (typeof u?.avatar === 'string' && u.avatar.startsWith('/avatar/rakun-')) u.avatar = pickPresetAv(); }
// Başlangıç rehberi: bu tarihten önce açılmış hesaplara gösterilmez
const ONB_SINCE = Date.parse('2026-11-11T15:00:00Z');
const onbPush = (name, ob) => io.to('user:' + name).emit('onb', ob);
// Rehber adımı: rehber gizlenmiş olsa bile kaydedilir; beş adım bitince Çaylak rozeti ve +100 XP kendiliğinden verilir
const onbFlag = (name, k) => { const u = db.users[name]; if (!u) return; const ob = onbOf(u); if (!ob[k]) { ob[k] = true; save(); if (!ob.done) onbPush(name, ob); } onbAward(name); };
function onbSteps(u) {
  const ob = u.onb || {}, n = u.name;
  return { join: db.servers.some(x => x.id !== 's1' && (x.owner === n || (x.members || []).includes(n))), msg: !!(ob.msg || u.msgs > 0), voice: !!(ob.voice || Object.keys(u.vmin || {}).length),
    invite: !!(ob.invite || Object.values(db.users).some(x => x.invitedBy === n)), profile: !!(ob.profile || u.bio || u.status) };
}
function onbAward(name) {
  const u = db.users[name]; if (!u) return; const ob = onbOf(u); if (ob.rewarded) return;
  const st = onbSteps(u); if (!Object.values(st).every(Boolean)) return;
  ob.rewarded = true; addXp(u.name, 100, 'rehber'); save();
  io.to('user:' + name).emit('onbReward', {}); pushUsers();
}
setTimeout(() => { for (const n of Object.keys(db.users)) onbAward(n); }, 5000); // eski hesaplar da hak ettiyse alsın
const setupOf = s => { if (!s.setup) s.setup = (s.createdAt || 0) < ONB_SINCE || s.public ? { done: true } : {}; return s.setup; };
const onbOf = u => { if (!u.onb) u.onb = (u.createdAt || 0) < ONB_SINCE ? { done: true } : {}; return u.onb; };

const QUESTIONS = ['Issız bir adaya düşsen yanına alacağın 3 şey ne?', 'Hayatında izlediğin en iyi film hangisi?', 'Süper gücün olsa ne olurdu?', 'En sevdiğin yemek ne, kim yapıyor en iyisini?',
  'Zaman makinen olsa hangi yıla giderdin?', 'Bu aralar hangi şarkıyı dinlemeden duramıyorsun?', 'Çocukken ne olmak istiyordun?', 'Bir gün başka biri olabilsen kim olurdun?',
  'En komik anın hangisi?', 'Hiç unutamadığın bir oyun var mı?', 'Bir milyon kazansan ilk ne yapardın?', 'En sevdiğin mevsim hangisi, neden?', 'Sabah insanı mısın gece kuşu mu?',
  'Gitmek istediğin bir ülke?', 'Son okuduğun kitap neydi?', 'Kahve mi çay mı?', 'Hiç denemediğin ama denemek istediğin bir şey?', 'Bu hafta seni en çok ne mutlu etti?',
  'Bir dizinin içinde yaşayabilsen hangisi olurdu?', 'Kendine 10 yıl önce bir tavsiye verebilsen ne derdin?'];
const today = () => new Date().toISOString().slice(0, 10);
function birthdays(s) {
  const md = ymd().slice(5);
  if (s.bday === ymd()) return;
  const ch = s.channels.find(c => c.type === 'text' && !c.news && !everyoneDenied(ovOf(s, c), 'send')) || s.channels.find(c => c.type === 'text'); if (!ch) return;
  const who = membersOf(s).filter(n => db.users[n]?.birthday === md);
  s.bday = ymd();
  for (const n of who) {
    const msg = { id: id(), kind: 'birthday', time: Date.now(), text: n, reactions: {} };
    (db.messages[ch.id] ||= []).push(msg);
    io.to(ch.id).emit('message', { channelId: ch.id, msg });
  }
  if (who.length) save();
}
function dailyQuestion(s) {
  birthdays(s);
  const ch = s.channels.find(c => c.type === 'text' && !c.news && !everyoneDenied(ovOf(s, c), 'send')) || s.channels.find(c => c.type === 'text');
  if (!ch || s.daily === today()) return;
  s.daily = today();
  const q = QUESTIONS[Math.floor(Date.now() / 864e5) % QUESTIONS.length];
  const msg = { id: id(), kind: 'daily', time: Date.now(), text: q, reactions: {} };
  (db.messages[ch.id] ||= []).push(msg); save();
  io.to(ch.id).emit('message', { channelId: ch.id, msg });
}
function winnerOf(b) {
  for (const [a, c, d] of [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]]) if (b[a] !== '.' && b[a] === b[c] && b[a] === b[d]) return b[a];
  return b.includes('.') ? null : 'draw';
}
const watch = new Map(); // kanal -> {videoId, playing, time, at, by}
const AUDIO_RE = /^\/uploads\/[a-f0-9]+\.(webm|ogg|m4a|mp4)$/;
// ---------- Ses paneli ----------
// Hazır sesler herkese açık; her sunucu en çok SB_MAX ses ekleyebilir (en fazla 5 sn, WAV olarak yüklenir: tarayıcı kırpıp dönüştürür).
const SB_DEFAULTS = [['korna', 'Korna', '📯'], ['ba-dum-tss', 'Ba dum tss', '🥁'], ['alkis', 'Alkış', '👏'], ['tada', 'Tada', '🎉'], ['yanlis', 'Yanlış', '❌'], ['dramatik', 'Dramatik', '😱'],
  ['kriket', 'Sessizlik', '🦗'], ['ding', 'Ding', '🔔'], ['boing', 'Boing', '🤸'], ['vuuu', 'Vuuu', '💨'], ['seviye', 'Seviye atladı', '🆙'], ['pop', 'Pop', '🫧']]
  .map(([f, name, emoji]) => ({ id: 'd:' + f, name, emoji, vol: 0.8, url: `/ses-paneli/${f}.mp3`, def: true }));
const SB_MAX = 30, SB_MAX_SEC = 5.2, SB_MAX_BYTES = 520 * 1024;
// Gelen WAV gerçekten kısa, düz PCM bir ses mi? (süre başlıktaki veri boyutundan hesaplanır)
function wavInfo(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let i = 12, fmt = null, data = 0;
  while (i + 8 <= buf.length) {
    const id = buf.toString('ascii', i, i + 4), n = buf.readUInt32LE(i + 4);
    if (id === 'fmt ') fmt = { pcm: buf.readUInt16LE(i + 8), ch: buf.readUInt16LE(i + 10), rate: buf.readUInt32LE(i + 12), bits: buf.readUInt16LE(i + 22) };
    else if (id === 'data') { data = Math.min(n, buf.length - i - 8); break; }
    i += 8 + n + (n & 1);
  }
  if (!fmt || fmt.pcm !== 1 || ![1, 2].includes(fmt.ch) || fmt.rate < 8000 || fmt.rate > 48000 || ![8, 16].includes(fmt.bits) || !data) return null;
  return { sec: data / (fmt.rate * fmt.ch * fmt.bits / 8) };
}
const sbFind = (s, sid) => typeof sid !== 'string' ? null : sid.startsWith('d:') ? SB_DEFAULTS.find(x => x.id === sid) : (s?.sounds || []).find(x => x.id === sid);
const sbCanManage = (s, n) => s.owner === n || can(s, n, 'manageSounds');
const sbCanAdd = (s, n) => s.members.includes(n) && (sbCanManage(s, n) || (!s.public && s.sbAll !== false));
const slowMap = new Map();
const BAD = ['amk', 'aq', 'orospu', 'piç', 'siktir', 'sik', 'yarrak', 'göt', 'ananı', 'amına', 'oç', 'pezevenk', 'kahpe', 'gavat', 'fuck', 'shit', 'bitch'];
const BAD_RE = new RegExp(`(?<![\\p{L}])(${BAD.join('|')})(?![\\p{L}])`, 'giu');
const filterText = t => t.replace(BAD_RE, w => '★'.repeat([...w].length));
function audit(s, by, action, target = '') {
  (s.audit ||= []).unshift({ time: Date.now(), by, action, target });
  s.audit.length = Math.min(s.audit.length, 200);
  if (s.bot?.mod?.on && s.bot.mod.logCh && by !== BOT_NAME && !/^Mesaj sildi$/.test(action)) setTimeout(() => modLog(s, { title: action, text: by + (target ? ' → ' + target : ''), tone: /Yasak|attı|Sustur|sildi|aldı/i.test(action) ? 'warn' : 'info' }), 0);
}
// ---------- Kanka Bot ----------
// Sunucuya özel hazır bot modülleri. Her sunucuda s.bot = { mod: {...}, ... }
const BOT_NAME = 'Kanka Bot';
const BOT_MODS = {
  mod: { on: false, antinuke: true, invites: true, links: false, spam: true, mentions: true, caps: false, words: '', logCh: null, warnLimit: 3 },
  welcome: { on: false, ch: null, text: '{üye} aramıza katıldı! 🎉 Kendini #tanışma odasında tanıt.', count: true, role: null, bye: false, byeText: '{üye} aramızdan ayrıldı. Yolun açık olsun 👋' },
  autorole: { on: false, roles: [], when: 'join', delayMin: 10, pending: {} },
  ticket: { on: false, panelCh: null, role: null, askReason: true, panelText: 'Bir sorunun mu var? Talebini aç, yetkililer en kısa sürede ilgilenecek.', welcome: 'Merhaba {üye}! Talebini buraya yazabilirsin. Yetkililer en kısa sürede bakacak.', cooldownMin: 10, seq: 0 },
};
const WELCOME_TITLES = ['👋 Aramıza hoş geldin!', '🎉 Yeni kanka geldi!', '🦝 Bir kanka daha!', '🚀 Ekibe katıldı!', '✨ Selam, yeni yüz!'];
const ordinalTr = n => n + '.';
// Karşılama modülü: yeni üyeyi seçilen odada kartla karşılar, sırasını söyler, istersen rol verir
function welcomeChannel(s, w) {
  return s.channels.find(c => c.id === w.ch && (c.type || 'text') === 'text')
    || s.channels.find(c => (c.type || 'text') === 'text' && !c.news && !everyoneDenied(ovOf(s, c), 'send'));
}
function welcomeFill(s, t, name, count) {
  return String(t || '').replace(/\{(üye|uye|kullanıcı)\}/gi, '@' + name).replace(/\{sunucu\}/gi, s.name).replace(/\{(sayı|sayi)\}/gi, String(count));
}
// ---- Oto-rol: yeni gelene (hemen / kuralları kabul edince / X dakika sonra) roller ver ----
const autoRoleList = s => (s.bot?.autorole?.roles || []).map(id => (s.customRoles || []).find(r => r.id === id && !r.bot)).filter(Boolean);
const botCanGive = (s, r) => { const br = botRole(s); return !br || s.customRoles.indexOf(r) > s.customRoles.indexOf(br); };
function autoRoleGive(s, name, { log = true, push = true } = {}) {
  if (!botOn(s, 'autorole') || s.public || name === BOT_NAME || !s.members.includes(name) || s.bans?.[name]) return [];
  const gave = [], blocked = [];
  s.memberRoles ||= {}; const l = (s.memberRoles[name] ||= []);
  for (const r of autoRoleList(s)) {
    if (l.includes(r.id)) continue;
    if (r.perms?.length) { blocked.push(r.name + ' (yetkili rol)'); continue; }
    if (!botCanGive(s, r)) { blocked.push(r.name); continue; }
    l.push(r.id); gave.push(r.name);
  }
  if (blocked.length && log) modLog(s, { title: '🏷️ Oto-rol: bazı roller verilemedi', text: `${blocked.join(', ')} verilemedi. Roller sekmesinde Kanka Bot rolünü bu rollerin üstüne taşı; yetkisi olan roller otomatik verilmez.`, tone: 'warn' });
  if (gave.length && push) { save(); pushServers(membersOf(s)); }
  return gave;
}
// Katılınca çağrılır: hemen ver ya da sıraya koy. Karşılama kartında gösterilsin diye verilen rollerin adını döner.
function autoRoleOnJoin(s, name) {
  if (!botOn(s, 'autorole') || s.public) return [];
  const a = s.bot.autorole, rulesGate = a.when === 'rules' && s.welcome?.enabled && s.owner !== name && !s.accepted?.[name];
  if (a.when === 'delay' && a.delayMin > 0) { (a.pending ||= {})[name] = Date.now() + a.delayMin * 60e3; save(); return []; }
  if (rulesGate) return [];
  return autoRoleGive(s, name, { push: false });
}
setInterval(() => { // gecikmeli oto-rol
  const now = Date.now();
  for (const s of db.servers) { const p = s.bot?.autorole?.pending; if (!p) continue;
    for (const [n, t] of Object.entries(p)) if (t <= now) { delete p[n]; if (botOn(s, 'autorole') && s.members.includes(n)) autoRoleGive(s, n); } }
}, 30e3);
for (const sv of db.servers || []) if (sv.bot?.welcome?.role) botCfg(sv); // karşılamadaki eski tek rolü oto-role taşı
function botWelcome(s, name, arGave = []) {
  if (!botOn(s, 'welcome') || name === BOT_NAME) return;
  const w = s.bot.welcome, ch = welcomeChannel(s, w); if (!ch) return;
  const count = s.public ? userCount() : s.members.length;
  const u = db.users[name], fields = [];
  if (w.count) fields.push(['Üye', `${ordinalTr(count)} kanka`]);
  if (u && badgesOf(u).includes('beta')) fields.push(['Rozet', '🧪 Beta Tester']);
  const gave = arGave.join(', ') || null;
  if (gave) fields.push(['Rol', gave]);
  const txt = welcomeFill(s, w.text, name, count) || `@${name} aramıza katıldı!`;
  botPost(ch.id, { title: WELCOME_TITLES[count % WELCOME_TITLES.length], text: txt, tone: 'ok', fields });
  if (txt.includes('@' + name)) notifyUser(name, { from: BOT_NAME, text: txt, channelId: ch.id, where: `${s.name} · #${ch.name}`, mention: true });
}
// ---- Kanka HQ: sık sorulanlara Kanka Bot'tan hazır cevap ----
// Sadece soru gibi duran mesajlara cevap verir; aynı konuyu bir odada 3 dk, aynı kişiye 30 dk içinde tekrar anlatmaz.
const HQ_FAQ = [
  { id: 'amac', q: /(amac[ıi]|ama[çc]\s*ne|ne\s*i[şs]e\s*yar|bura(s[ıi])?\s*(ne|neresi)|kanka\s*(chat\s*|hq\s*)?(ne|nedir|neyin)|bu\s*(site|uygulama|platform)\s*ne)/,
    title: 'Kanka Chat ne? 🦝', text: 'Discord gibi düşün ama Türk yapımı: sesli odalar, ekran yayını, sunucular, arkadaşlar, botlar. Türkiye\'de VPN\'siz sorunsuz çalışır, tamamen ücretsiz. Şu an betada, yorumlara göre her gün geliştiriliyor. Nasıl kullanılacağı #nasıl-kullanılır odasında.' },
  { id: 'mobil', q: /(mobil|telefon|android|ios|iphone|play\s*store|app\s*store|apk)/,
    title: 'Telefonda var mı? 📱', text: 'Var! Telefonun tarayıcısından kankahq.com\'u aç, menüden "Ana ekrana ekle" de. Uygulama gibi açılır, bildirimler de gelir. Play Store sürümü beta bitince geliyor.' },
  { id: 'pc', q: /(windows|masa\s*[üu]st[üu]|bilgisayar\s*uygulama|pc\s*(uygulama|s[üu]r[üu]m)|\.exe|indir(ebilir|eyim|ece[ğg]|mek))/,
    title: 'Windows uygulaması 💻', text: 'Var: kankahq.com/indir/KankaChat-Kurulum.exe ya da sitenin üstündeki şeritten "Ücretsiz indir". Oyun içi bildirimler, oyun katmanı ve "Oynuyor" durumu uygulamada.' },
  { id: 'bildirim', q: /bildirim/,
    title: 'Bildirimler 🔔', text: 'Bir sunucuyu sessize almak için soldaki simgesine sağ tıkla (telefonda basılı tut) → "Sunucuyu sessize al". Tek bir oda için odanın üstündeki menüden bildirim ayarını seç. Hepsini birden: sol alttaki ⚙️ → Bildirim ve uygulama.' },
  { id: 'sunucu', q: /(sunucu|server)\w*\s*(nas[ıi]l\s*)?(kur|a[çc]|olu[şs]tur|yap)/,
    title: 'Sunucu kurmak 🏠', text: 'Soldaki çubukta + simgesine bas, adını yaz, hazır. Arkadaşlarını davet linkiyle çağırırsın, roller ve odalar sunucu ayarlarında. Herkese açık yapıp Keşfet\'te de çıkabilirsin.' },
  { id: 'discord', q: /(discord(dan|tan|la)?\s*(ne\s*)?fark|neden\s*discord\s*de[ğg]il|discord\s*var\s*(zaten|ya)|discord\s*(dururken|varken))/,
    title: 'Discord\'dan farkı? ⚔️', text: 'Türkiye\'de erişim sorunu yok, Türkçe ve Türk kullanıcılar için yapılıyor. Ekran yayını, yüksek ses kalitesi gibi şeyler için Nitro yok, hepsi ücretsiz. Bir de istekleriniz gerçekten ekleniyor: #yorumlarla-yapıyorum.' },
  { id: 'ucret', q: /([üu]cretli|[üu]cretsiz|bedava|para\s*(l[ıi]|m[ıi]|ister)|nitro|premium)/,
    title: 'Ücretli mi? 💸', text: 'Hayır, tamamen ücretsiz. Yayın kalitesi, ses kalitesi, yükleme gibi şeyler için ücretli paket yok.' },
  { id: 'ses', q: /(ses(im)?\s*(gelmiyor|gitmiyor|yok|duyulmuyor)|mikrofon(um)?\s*(çal[ıi][şs]m[ıi]yor|gitmiyor|yok|alm[ıi]yor)|beni\s*duym|duyam[ıi]yor)/, noQ: true,
    title: 'Ses sorunu 🎙️', text: 'Önce tarayıcının mikrofon iznini kontrol et (adres çubuğundaki 🔒 simgesi). Sonra sol alttaki ⚙️ → Ses ve görüntü bölümünden doğru mikrofonu seç, orada test de edebilirsin. Hâlâ olmuyorsa #hata-bildir\'e yaz.' },
  { id: 'yayin', q: /(yay[ıi]n|ekran\s*payla[şs])\w*\s*(nas[ıi]l|a[çc])/,
    title: 'Yayın açmak 📺', text: 'Bir sesli odaya gir, alttaki ses çubuğunda ekran simgesine bas. Kaliteyi (720p\'den 1440p 60 FPS\'e kadar) ve oyun sesini orada seçersin. İzleyenler "Yayını izle"ye basınca görür.' },
  { id: 'partner', q: /(partner|reklam\s*(yap|ver|al))/,
    title: 'Partnerlik 🤝', text: 'Kanka Partner rozeti alan sunucular Keşfet\'te üst sıralarda çıkar. Kanka\'da aktif bir sunucun varsa @Pisago\'ya yaz, beraber bakalım.' },
  { id: 'kim', q: /(kim\s*yapt[ıi]|yapan\s*kim|kim\s*(geli[şs]tir|kodla)|sahibi\s*kim|kurucu(su)?\s*kim)/,
    title: 'Kim yapıyor? 🛠️', text: 'Kanka Chat\'i @Pisago geliştiriyor, yapım sürecini Instagram\'da paylaşıyor. Fikrin varsa #yorumlarla-yapıyorum\'a yaz.' },
  { id: 'hata', q: /((hata|bug)\s*(buldum|var|ald[ıi]m|veriyor)|çal[ıi][şs]m[ıi]yor|bozuk)/, noQ: true,
    title: 'Hata mı buldun? 🐞', text: 'Ne yaptığını ve ne olduğunu #hata-bildir odasına yazar mısın? Ekran görüntüsü varsa çok işe yarar. Genelde aynı gün düzeltiyoruz.' },
];
const faqSeen = new Map();
const looksQuestion = t => /\?/.test(t) || /(\s|^)(m[ıiuü]|m[ıiuü]s[ıiuü]n|m[ıiuü]y[ıiuü]z|m[ıiuü]d[ıiuü]r)(\s|$|\W)/.test(t) || /(^|\s)(ne|neden|nas[ıi]l|nerede|nereden|niye|kim|hangi|nedir|ne\s*zaman)(\s|$|\W)/.test(t);
function hqFaq(s, chId, name, text) {
  if (s.id !== 's1' || !s.bot?.added || s.bot.faqOff || name === BOT_NAME || siteAdmin(name)) return;
  const c = s.channels.find(x => x.id === chId); if (!c || (c.type || 'text') !== 'text' || /hata|yorum/.test(c.name)) return;
  const t = String(text || '').toLocaleLowerCase('tr').trim(); if (t.length < 6 || t.length > 220 || /^\//.test(t) || /https?:\/\//.test(t)) return;
  const q = looksQuestion(t), now = Date.now();
  const hit = HQ_FAQ.find(f => (q || f.noQ) && f.q.test(t)); if (!hit) return;
  const kc = chId + '|' + hit.id, ku = name + '|' + hit.id;
  if (now - (faqSeen.get(kc) || 0) < 3 * 60e3 || now - (faqSeen.get(ku) || 0) < 30 * 60e3) return;
  faqSeen.set(kc, now); faqSeen.set(ku, now);
  if (faqSeen.size > 5000) for (const [k, v] of faqSeen) if (now - v > 60 * 60e3) faqSeen.delete(k);
  setTimeout(() => botPost(chId, { title: hit.title, text: `@${name} ${hit.text.replace(/@Pisago/g, '@' + s.owner)}`, tone: 'info' }), 900);
}
function botBye(s, name) {
  if (!botOn(s, 'welcome') || !s.bot.welcome.bye) return;
  const ch = welcomeChannel(s, s.bot.welcome); if (!ch) return;
  botPost(ch.id, { title: '👋 Görüşürüz', text: welcomeFill(s, s.bot.welcome.byeText, name, s.members.length).replace('@' + name, name), tone: 'info' });
}
function botCfg(s) {
  s.bot ||= {};
  for (const [k, def] of Object.entries(BOT_MODS)) s.bot[k] = { ...def, ...(s.bot[k] || {}) };
  if (s.bot.welcome.role) { if (!s.bot.autorole.roles.length) { s.bot.autorole.roles = [s.bot.welcome.role]; s.bot.autorole.on = !!s.bot.welcome.on; } s.bot.welcome.role = null; } // eski: karşılamanın içindeki tek rol
  return s.bot;
}
const botOn = (s, mod) => !!s?.bot?.added && !!s.bot[mod]?.on;
const botRole = s => (s.customRoles || []).find(r => r.bot);
// Kanka Bot otomatik işlemi bu kişiye uygulayabilir mi? (rol sırası: botun rolü kişinin en yüksek rolünden üstte olmalı)
const botOutranks = (s, n) => { if (s.owner === n) return false; const r = botRole(s); const br = r ? 1000 - s.customRoles.indexOf(r) : 600; return br > rankOf(s, n); };
function botAddTo(s, by, withMod = true) {
  const b = botCfg(s); if (b.added) return false;
  b.added = true; b.addedBy = by; b.addedAt = Date.now(); if (withMod) b.mod.on = true;
  s.customRoles ||= [];
  if (!botRole(s)) s.customRoles.unshift({ id: id(), name: 'Kanka Bot', color: '#ff8a4c', perms: [], hoist: false, bot: true });
  setupOf(s).bot = true;
  audit(s, by, 'Kanka Bot\'u ekledi', withMod ? 'Mod modülü açık' : '');
  const ch = s.channels.find(c => (c.type || 'text') === 'text' && !everyoneDenied(ovOf(s, c), 'send')) || s.channels.find(c => (c.type || 'text') === 'text');
  if (ch) botPost(ch.id, { title: '🤖 Kanka Bot sunucuya katıldı!', text: `Selam ${s.name}! ${by} beni ekledi. Komutlarımı görmek için /yardım yaz${withMod ? ', moderasyon benden 🛡️' : ''}.`, tone: 'ok' });
  return true;
}
for (const s0 of db.servers) if (s0.bot?.mod?.on && s0.bot.added === undefined) s0.bot.added = true; // eski kurulum
// Resmi sunucuda Kanka Bot karşılama modülüyle gelir (bir kez)
(function hqBot() {
  const hq = db.servers.find(x => x.id === 's1'); if (!hq || hq.hqBotV1) return;
  const b = botCfg(hq); b.added = true; b.addedBy ||= hq.owner || BOT_NAME; b.addedAt ||= Date.now();
  b.welcome.on = true;
  b.welcome.ch = (hq.channels.find(c => c.name === 'genel' && (c.type || 'text') === 'text') || {}).id || null;
  b.welcome.text = '{üye} Kanka HQ\'ya katıldı! 🎉 Kendini #tanışma odasında tanıt, takım arıyorsan #takım-arıyorum.';
  hq.customRoles ||= [];
  if (!(hq.customRoles || []).some(r => r.bot)) hq.customRoles.unshift({ id: id(), name: 'Kanka Bot', color: '#ff8a4c', perms: [], hoist: false, bot: true });
  hq.hqBotV1 = true; save();
  if (b.welcome.ch) setTimeout(() => botPost(b.welcome.ch, { title: '🤖 Kanka Bot burada!', text: 'Bundan sonra Kanka HQ\'ya gelen her yeni kankayı ben karşılayacağım. Sunucuna eklemek için: Keşfet → Botlar.', tone: 'ok' }), 3000);
})();
function botPost(chId, { title, text, tone = 'info', fields } = {}) {
  const msg = { id: id(), author: BOT_NAME, kind: 'bot', time: Date.now(), bot: { title: clean(title, 80), text: clean(text, 900), tone, fields: (fields || []).slice(0, 6).map(([a, b]) => [clean(a, 40), clean(b, 120)]) }, reactions: {} };
  const list = (db.messages[chId] ||= []); list.push(msg); if (list.length > 2000) list.shift();
  save(); io.to(chId).emit('message', { channelId: chId, msg });
  return msg;
}
// Değişiklik günlüğü: depodaki degisiklik-gunlugu.json'a eklenen her kayıt, geliştirici sunucusunun #değişiklik-günlüğü odasına
// Kanka Bot tarafından bir kez yazılır (yayınlananlar db.clPosted'da). Dosya dakikada bir kontrol edilir; sunucuyu yeniden başlatmaya gerek yok.
const CL_FILE = path.join(__dirname, 'public', 'degisiklik-gunlugu.json'); let clMtime = 0; // VDS güncelleyicisi sadece server.js, package*.json ve public/ kopyalar
function changelogSync(force) {
  let st; try { st = fs.statSync(CL_FILE); } catch { return; } if (!force && st.mtimeMs === clMtime) return;
  let list; try { list = JSON.parse(fs.readFileSync(CL_FILE, 'utf8')); } catch (e) { console.error('degisiklik-gunlugu.json okunamadı:', e.message); return; }
  const norm = x => String(x || '').toLocaleLowerCase('tr').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i');
  const targets = db.servers.filter(s => s.id === db.devServer || s.template === 'gelistirici').flatMap(s => { const t = s.channels.filter(c => (c.type || 'text') === 'text');
    const exact = t.filter(c => c.name === 'değişiklik-günlüğü'); return (exact.length ? exact : t.filter(c => /degisiklik|gunlug|changelog/.test(norm(c.name)))).slice(0, 1).map(c => c.id); });
  if (!targets.length) { if (!changelogSync.warned) { changelogSync.warned = 1; console.log('Değişiklik günlüğü: geliştirici sunucusunda günlük odası bulunamadı'); } return; }
  clMtime = st.mtimeMs;
  const done = (db.clPosted ||= []); let any = false;
  for (const e of Array.isArray(list) ? list : []) { if (!e?.id || done.includes(e.id)) continue;
    for (const ch of targets) botPost(ch, { title: e.baslik || 'Güncelleme', text: e.metin || '', tone: e.ton || 'info' }); done.push(e.id); any = true; }
  if (any) { db.clPosted = done.slice(-500); save(); }
}
setTimeout(() => changelogSync(true), 20e3); setInterval(changelogSync, 60e3);
// Sadece komutu yazana görünen cevap (kaydedilmez)
const botWhisper = (sock, chId, o) => sock.emit('message', { channelId: chId, msg: { id: 'w' + id(), author: BOT_NAME, kind: 'bot', time: Date.now(), ephemeral: true, bot: { title: clean(o.title, 80), text: clean(o.text, 1500), tone: o.tone || 'info', fields: o.fields || [] }, reactions: {} } });
function modLog(s, o) {
  const m = s.bot?.mod; if (!m?.on || !m.logCh) return;
  if (!s.channels.some(c => c.id === m.logCh && (c.type || 'text') === 'text')) return;
  botPost(m.logCh, o);
}
// ---------- Destek (ticket) ----------
function isTicketStaff(s, n) {
  if (!n) return false;
  if (s.owner === n || can(s, n, 'manageChannels')) return true;
  const r = s.bot?.ticket?.role;
  return !!(r && (s.memberRoles?.[n] || []).includes(r));
}
function ticketStaff(s) {
  const t = s.bot?.ticket || {}, out = new Set();
  if (s.owner) out.add(s.owner);
  const pool = s.public ? onlineNames() : membersOf(s);
  for (const n of pool) if (can(s, n, 'manageChannels')) out.add(n);
  if (t.role) for (const [n, rs] of Object.entries(s.memberRoles || {})) if ((rs || []).includes(t.role) && (s.public || s.members.includes(n))) out.add(n);
  return [...out];
}
function ticketCats(s) {
  s.categories ||= [];
  let cat = s.categories.find(k => k.ticketCat);
  if (!cat) { cat = { id: id(), name: 'Destek Talepleri', perms: { '@everyone': { view: false } }, ticketCat: true }; s.categories.push(cat); }
  let arch = s.categories.find(k => k.ticketArchive);
  if (!arch) { arch = { id: id(), name: 'Kapatılan Destekler', perms: { '@everyone': { view: false } }, ticketArchive: true }; s.categories.push(arch); }
  return { cat, arch };
}
function ticketCardFields(c) {
  const t = c.ticket, f = [['Açan', t.by]];
  if (t.claimedBy) f.push(['Yetkili', t.claimedBy]);
  f.push(['Durum', t.closedAt ? 'Kapatıldı' : t.claimedBy ? 'Üstlenildi' : 'Açık']);
  return f;
}
function ticketCardUpdate(s, c) {
  if (!c.ticket?.cardId) return;
  const m = (db.messages[c.id] || []).find(x => x.id === c.ticket.cardId);
  if (!m) return;
  m.ticket = { no: c.ticket.no, by: c.ticket.by, claimedBy: c.ticket.claimedBy || null, closed: !!c.ticket.closedAt };
  m.bot.fields = ticketCardFields(c);
  m.bot.text = c.ticket.closedAt ? 'Talep kapatıldı. Yazışma yetkililer için arşivde duruyor.' : c.ticket.claimedBy ? `${c.ticket.claimedBy} bu taleple ilgileniyor.` : 'Yetkililer en kısa sürede ilgilenecek. Talebi kapatmak için aşağıdaki butona basabilirsin.';
  save();
  io.to(c.id).emit('update', { channelId: c.id, msg: m });
}
function openTicket(s, by, reason) {
  const t = s.bot?.ticket;
  if (!s.bot?.added || !t?.on) return { error: 'Destek modülü bu sunucuda açık değil' };
  if (!(s.public || s.members.includes(by))) return { error: 'Önce sunucuya katıl' };
  if (s.bans?.[by]) return { error: 'Sunucudan yasaklısın' };
  const open = s.channels.find(c => c.ticket && !c.ticket.closedAt && c.ticket.by === by);
  if (open) return { error: 'Zaten açık bir destek talebin var: #' + open.name, channelId: open.id };
  const cool = Math.max(0, Math.min(1440, t.cooldownMin ?? 10));
  const last = s.channels.filter(c => c.ticket && c.ticket.by === by && c.ticket.closedAt).sort((a, b) => b.ticket.closedAt - a.ticket.closedAt)[0];
  if (cool && last && Date.now() - last.ticket.closedAt < cool * 60e3) return { error: `Yeni talep için ${Math.ceil((cool * 60e3 - (Date.now() - last.ticket.closedAt)) / 60e3)} dakika bekle` };
  const rs = clean(reason, 200);
  if (t.askReason && rs.length < 2) return { error: 'Talebinin konusunu kısaca yaz' };
  t.seq ||= 0;
  let name;
  do { t.seq++; name = 'destek-' + String(t.seq).padStart(4, '0'); } while (s.channels.some(c => c.name === name));
  const { cat } = ticketCats(s);
  const perms = { '@everyone': { view: false, send: false }, ['u:' + by]: { view: true, send: true, attach: true, react: true } };
  if (t.role) perms[t.role] = { view: true, send: true, attach: true, react: true };
  const c = { id: id(), name, type: 'text', cat: cat.id, sync: false, perms, topic: `Destek talebi #${t.seq} · ${by}`, ticket: { no: t.seq, by, at: Date.now(), reason: rs, claimedBy: null, claimedAt: null, closedAt: null, closedBy: null } };
  const lastIdx = s.channels.map(x => x.cat || null).lastIndexOf(cat.id);
  if (lastIdx >= 0) s.channels.splice(lastIdx + 1, 0, c); else s.channels.push(c);
  botPost(c.id, { title: 'Destek talebi açıldı', text: (t.welcome || 'Merhaba {üye}! Talebini buraya yazabilirsin.').replace(/\{üye\}/g, '@' + by).replace(/\{sunucu\}/g, s.name), tone: 'ok', fields: [['Açan', by], ...(rs ? [['Konu', rs]] : [])] });
  const list = (db.messages[c.id] ||= []);
  const card = { id: id(), author: BOT_NAME, kind: 'bot', time: Date.now() + 1, ticket: { no: t.seq, by, claimedBy: null, closed: false }, bot: { title: 'Destek durumu', text: 'Yetkililer en kısa sürede ilgilenecek. Talebi kapatmak için aşağıdaki butona basabilirsin.', tone: 'info', fields: ticketCardFields(c) }, reactions: {} };
  list.push(card); if (list.length > 2000) list.shift();
  c.ticket.cardId = card.id;
  io.to(c.id).emit('message', { channelId: c.id, msg: card });
  audit(s, by, 'Destek talebi açtı', '#' + name);
  save(); pushServers(membersOf(s));
  for (const n of ticketStaff(s)) if (n !== by) io.to('user:' + n).emit('toast', `Yeni destek talebi: #${name} · ${by}`);
  return { ok: true, channelId: c.id, name };
}
function claimTicket(s, c, by) {
  if (!c?.ticket) return { error: 'Destek talebi bulunamadı' };
  if (!isTicketStaff(s, by)) return { error: 'Talepleri üstlenme yetkin yok' };
  if (c.ticket.closedAt) return { error: 'Bu talep kapatıldı' };
  if (c.ticket.claimedBy) return { error: 'Bu talebi zaten ' + c.ticket.claimedBy + ' üstlendi' };
  c.ticket.claimedBy = by; c.ticket.claimedAt = Date.now();
  botPost(c.id, { title: 'Talep üstlenildi', text: `${by} bu talebi üstlendi, artık o ilgilenecek.`, tone: 'ok' });
  ticketCardUpdate(s, c);
  audit(s, by, 'Destek talebini üstlendi', '#' + c.name);
  save(); pushServers(membersOf(s));
  return { ok: true };
}
function closeTicket(s, c, by) {
  if (!c?.ticket) return { error: 'Destek talebi bulunamadı' };
  if (!(c.ticket.by === by || isTicketStaff(s, by))) return { error: 'Bu talebi kapatma yetkin yok' };
  if (c.ticket.closedAt) return { error: 'Bu talep zaten kapatıldı' };
  c.ticket.closedAt = Date.now(); c.ticket.closedBy = by;
  c.sync = false; c.perms ||= {};
  delete c.perms['u:' + c.ticket.by];
  c.perms['@everyone'] = { ...(c.perms['@everyone'] || {}), view: false, send: false };
  const { arch } = ticketCats(s);
  c.cat = arch.id;
  s.channels = s.channels.filter(x => x !== c);
  const idx = s.channels.map(x => x.cat || null).lastIndexOf(arch.id);
  if (idx >= 0) s.channels.splice(idx + 1, 0, c); else s.channels.push(c);
  const mins = Math.max(1, Math.round((Date.now() - c.ticket.at) / 60e3));
  botPost(c.id, { title: 'Talep kapatıldı', text: `${by} talebi kapattı. Yazışma arşivde duruyor.`, tone: 'info', fields: [['Süre', dur(mins)], ['Açan', c.ticket.by]] });
  ticketCardUpdate(s, c);
  audit(s, by, 'Destek talebini kapattı', '#' + c.name);
  save();
  const panel = s.bot?.ticket?.panelCh && s.channels.find(x => x.id === s.bot.ticket.panelCh && (x.type || 'text') === 'text');
  const goCh = (panel && seesChannel(s, panel, c.ticket.by) ? panel.id : null) || s.channels.find(x => (x.type || 'text') === 'text' && seesChannel(s, x, c.ticket.by))?.id || null;
  io.to('user:' + c.ticket.by).emit('ticketClosed', { channelId: c.id, goCh });
  io.to('user:' + c.ticket.by).emit('toast', `${s.name} sunucusundaki destek talebin kapatıldı`);
  pushServers(membersOf(s));
  return { ok: true, goCh };
}
// Anti-nuke: yetkili kısa sürede çok fazla yıkıcı işlem yaparsa yetkileri alınır
const nukeMap = new Map();
function nukeCheck(s, actor, what) {
  if (!botOn(s, 'mod') || !s.bot.mod.antinuke || s.owner === actor) return false;
  const k = s.id + '|' + actor, now = Date.now();
  const arr = (nukeMap.get(k) || []).filter(t => now - t < 60e3); arr.push(now); nukeMap.set(k, arr);
  if (arr.length < 4) return false; // 1 dakikada 3 işleme kadar normal, 4.sü durdurulur
  const can0 = botOutranks(s, actor), had = can0 && (s.roles?.[actor] || (s.memberRoles?.[actor] || []).length);
  if (can0) { delete s.roles[actor]; delete s.memberRoles?.[actor]; }
  else io.to('user:' + s.owner).emit('toast', `🛡️ Kanka Bot: ${actor} kısa sürede çok fazla ${what} yapmaya çalıştı, işlem durduruldu. Rolü botun rolünden yüksek olduğu için yetkilerini alamadım.`);
  nukeMap.delete(k);
  modLog(s, { title: '🛡️ Anti-nuke devrede', text: `${actor} 1 dakikada çok fazla ${what} yapmaya çalıştı. İşlem durduruldu${had ? ' ve yetkileri alındı' : ''}.`, tone: 'danger' });
  if (had) {
    audit(s, BOT_NAME, 'Anti-nuke: yetkilerini aldı', `${actor} · 1 dakikada çok fazla ${what}`);
    save(); pushServers(membersOf(s));
    io.to('user:' + s.owner).emit('toast', `🛡️ Kanka Bot: ${actor}, ${s.name} sunucusunda 1 dakikada çok fazla ${what} yaptı. Yetkileri alındı.`);
    sendPush?.(s.owner, { title: `🛡️ ${s.name}: anti-nuke devrede`, body: `${actor} kısa sürede çok fazla ${what} yaptı, yetkileri alındı.`, tag: 'nuke' + s.id });
    io.to('user:' + actor).emit('toast', 'Kanka Bot: Kısa sürede çok fazla işlem yaptığın için yetkilerin alındı. Sunucu sahibine danış.');
  }
  return true;
}
// Otomatik moderasyon: engellenirse hata metni döner
const spamMap = new Map();
const LINK_RE = /https?:\/\/|www\.[^\s]+\.[a-z]{2,}/i, INV_RE = /discord\.(gg|com\/invite)\/|\/davet\/[a-z0-9]+|[?&]davet=/i;
function automod(s, chId, me, text) {
  const m = s.bot?.mod; if (!m?.on || s.owner === me || isMod(s, me) || can(s, me, 'manageMessages')) return null;
  text = String(text || '');
  const block = (why, label) => { modLog(s, { title: 'Otomatik moderasyon', text: `${me} adlı üyenin mesajı engellendi: ${label}`, tone: 'warn', fields: [['Oda', '#' + (s.channels.find(c => c.id === chId)?.name || '?')], ['Mesaj', text.slice(0, 110) || '—']] }); return 'Kanka Bot: ' + why; };
  if (m.invites && INV_RE.test(text) && !text.includes('/davet/' + s.invite)) return block('Bu sunucuda başka sunucuların davet linkleri paylaşılamaz.', 'davet linki');
  if (m.links && LINK_RE.test(text)) return block('Bu sunucuda link paylaşmak kapalı.', 'link');
  if (m.mentions && (text.match(/@[\p{L}\p{N}_.-]+/gu) || []).length > 5) return block('Bir mesajda en fazla 5 kişiyi etiketleyebilirsin.', 'toplu etiket');
  if (m.caps) { const L = text.replace(/[^\p{L}]/gu, ''); if (L.length >= 12 && L.replace(/[^\p{Lu}]/gu, '').length / L.length > .75) return block('Lütfen BÜYÜK HARFLE bağırma 🙂', 'büyük harf'); }
  if (m.words) {
    const ws = m.words.split(',').map(w => w.trim().toLocaleLowerCase('tr')).filter(Boolean);
    const low = text.toLocaleLowerCase('tr'); const hit = ws.find(w => low.includes(w));
    if (hit) return block('Mesajında bu sunucuda yasaklanmış bir kelime var.', 'yasaklı kelime');
  }
  if (m.spam) {
    const k = s.id + '|' + me, now = Date.now(), arr = (spamMap.get(k) || []).filter(x => now - x.t < 15e3);
    arr.push({ t: now, x: text.trim().toLocaleLowerCase('tr') }); spamMap.set(k, arr);
    const same = arr.filter(a => a.x && a.x === arr.at(-1).x).length, fast = arr.filter(a => now - a.t < 6e3).length;
    if ((same >= 4 || fast >= 6) && botOutranks(s, me)) {
      s.timeouts ||= {}; s.timeouts[me] = now + 5 * 60e3; spamMap.delete(k);
      audit(s, BOT_NAME, 'Spam yüzünden susturdu', `${me} · 5 dk`);
      botPost(chId, { title: 'Spam engellendi', text: `${me} çok hızlı ya da aynı mesajı tekrar tekrar gönderdiği için 5 dakika susturuldu.`, tone: 'warn' });
      save(); pushServers(membersOf(s));
      io.to('user:' + me).emit('toast', `${s.name} sunucusunda spam yüzünden 5 dakika susturuldun`);
      return 'Kanka Bot: Spam yaptığın için 5 dakika susturuldun.';
    }
  }
  return null;
}
const dur = mn => mn >= 1440 ? Math.round(mn / 1440) + ' gün' : mn >= 60 ? Math.round(mn / 60) + ' saat' : mn + ' dk';
// Gün Türkiye saatine göre değişir (UTC+3; eskiden UTC'ydi, gece 03:00'te dönüyordu)
const ymd = (d = new Date()) => new Date(+d + 3 * 3600e3).toISOString().slice(0, 10);
// Günlük seri: o gün Kanka'da bulunduysan sayılır. Eskiden sadece giriş yaparken bakılıyordu;
// uygulama/sekme gece boyunca açık kalınca ertesi gün sayılmıyor, seri sıfırlanıyordu.
function markActive(u, t = ymd()) { u.seen = Date.now(); const a = (u.act ||= []); if (a[a.length - 1] !== t) { a.push(t); if (a.length > 180) a.splice(0, a.length - 180); } }
function touchStreak(name) {
  const u = db.users[name]; if (!u) return null;
  const t = ymd(), y = ymd(new Date(Date.now() - 864e5)); markActive(u, t);
  if (u.streak?.last === t) return null;
  const count = u.streak?.last === y ? (u.streak.count || 0) + 1 : 1;
  const bonus = 5 + Math.min(count, 10) * 2;
  u.streak = { last: t, count, best: Math.max(count, u.streak?.best || 0) };
  addXp(name, bonus, 'seri');
  setTimeout(() => pushUsers(), 100);
  return { count, bonus };
}
setInterval(() => { // açık kalan bağlantılar da yeni günü saysın
  let any = false;
  for (const n of new Set(online.values())) { const r = touchStreak(n); if (r) { any = true; io.to('user:' + n).emit('toast', `🔥 ${r.count} günlük seri! +${r.bonus} XP`); } }
  if (any) save();
}, 5 * 60e3);
// Analiz için bir kerelik geçmiş doldurma: hangi günler aktif, ilk mesaj zamanı (mesajlardan, ses kayıtlarından ve yedeklerden)
setTimeout(() => { try {
  if (db.anFill1) return;
  const days = {}, first = {}, add = (n, d) => (days[n] ||= new Set()).add(d);
  for (const list of Object.values(msgRaw)) for (const m of list || []) if (m.author && m.time) { add(m.author, ymd(new Date(m.time))); if (!first[m.author] || m.time < first[m.author]) first[m.author] = m.time; }
  try { for (const f of fs.readdirSync(BACKUPS).filter(n => BACKUP_RE.test(n))) { const j = readDbFile(path.join(BACKUPS, f)); for (const [n, u] of Object.entries(j.users || {})) if (u.streak?.last) add(n, u.streak.last); } } catch {}
  for (const u of Object.values(db.users)) {
    const d = days[u.name] ||= new Set(); if (u.createdAt) d.add(ymd(new Date(u.createdAt))); for (const k of Object.keys(u.vmin || {})) d.add(k); if (u.streak?.last) d.add(u.streak.last);
    for (const x of u.act || []) d.add(x); u.act = [...d].sort().slice(-180);
    if (first[u.name] && !u.firstMsgAt) u.firstMsgAt = first[u.name];
    if (!u.firstVoiceAt && Object.keys(u.vmin || {}).length) u.firstVoiceAt = new Date(Object.keys(u.vmin).sort()[0] + 'T12:00:00Z').getTime();
    if (!u.vtot && u.vmin) u.vtot = Object.values(u.vmin).reduce((a, b) => a + b, 0);
  }
  db.anFill1 = Date.now(); save();
} catch (e) { console.error('analiz doldurma', e); } }, 6000);
// Bir kerelik onarım: yukarıdaki hata yüzünden kırılan serileri mesaj geçmişinden geri hesapla
setTimeout(() => { try {
  if (db.streakFix2) return;
  const days = {};
  // Günlük yedeklerdeki seri bilgisi: o gün "son gün" ve öncesinde kaç gün üst üste geldiği yazıyor
  try { for (const f of fs.readdirSync(BACKUPS).filter(n => BACKUP_RE.test(n))) { const j = readDbFile(path.join(BACKUPS, f));
    for (const [n, u] of Object.entries(j.users || {})) { const st = u.streak; if (!st?.last) continue; let c = new Date(st.last + 'T12:00:00Z');
      for (let i = 0; i < Math.min(st.count || 1, 400); i++) { (days[n] ||= new Set()).add(c.toISOString().slice(0, 10)); c = new Date(+c - 864e5); } } } } catch (e) { console.error('seri yedek', e.message); }
  for (const list of Object.values(msgRaw)) for (const m of list || []) if (m.author && m.time) (days[m.author] ||= new Set()).add(ymd(new Date(m.time)));
  const today = ymd(), yest = ymd(new Date(Date.now() - 864e5)); let fixed = 0;
  for (const u of Object.values(db.users)) {
    const d = days[u.name] ||= new Set(); if (u.streak?.last) { let c = new Date(u.streak.last + 'T12:00:00Z'); for (let i = 0; i < Math.min(u.streak.count || 1, 400); i++) { d.add(c.toISOString().slice(0, 10)); c = new Date(+c - 864e5); } }
    let start = d.has(today) ? today : d.has(yest) ? yest : null; if (!start) continue;
    let n = 0, cur = new Date(start + 'T12:00:00Z');
    while (d.has(cur.toISOString().slice(0, 10))) { n++; cur = new Date(+cur - 864e5); }
    if (n > (u.streak?.count || 0)) { u.streak = { last: start, count: n, best: Math.max(n, u.streak?.best || 0) }; fixed++; }
  }
  db.streakFix2 = Date.now(); save(); if (fixed) { console.log(`Seri onarımı: ${fixed} kişinin serisi düzeltildi`); pushUsers(); }
} catch (e) { console.error('seri onarımı', e); } }, 4000);
const BADGES = {
  erken: ['🌱', 'Erken kanka', 'İlk 100 üyeden biri'],
  gece: ['🦉', 'Gece kuşu', 'Gece 00:00-05:00 arası mesaj attı'],
  sohbet: ['💬', 'Geveze', '100+ mesaj'],
  efsane: ['👑', 'Efsane', '1000+ mesaj'],
  xox: ['⭕', 'XOX şampiyonu', '3 XOX oyunu kazandı'],
  seri7: ['🔥', 'Ateşli seri', '7 gün üst üste giriş'],
  kurucu: ['🏰', 'Kurucu', 'Bir sunucu kurdu'],
  sosyal: ['🦋', 'Sosyal kelebek', '5+ arkadaş'],
  caylak: ['🐣', 'Çaylak', 'Başlangıç rehberini bitirdi'],
  beta: ['🧪', 'Beta Tester', 'Kanka betasındaki ilk 300 kişiden biri'],
  ekip: ['🛡️', 'Kanka Ekibi', 'Kanka Chat moderasyon ekibinde'],
  avci: ['🐞', 'Hata Avcısı', 'Kanka HQ\'da önemli bir hatayı bulup ekibe bildirdi'],
  dev: ['🤖', 'Bot Geliştirici', 'Kanka bot sisteminin beta geliştiricisi'],
  partner: ['🤝', 'Kanka Partner', 'Kanka\'nın iş birliği yaptığı bir sunucunun sahibi'],
  yildiz: ['⭐', 'Yıldız Sunucu', 'Yıldız kademesine ulaşmış bir sunucunun sahibi'],
  arena: ['🏆', 'Arena Şampiyonu', 'Kanka Arena genel sıralamasında ilk 10'],
};
// Elle verilen rozetler (Kanka ekibi verir): u.awards = { avci: { by, time } }
const AWARDS = ['avci'];
// Katılım sırası: Claude ve bot hesapları sayılmaz; kayıt tarihi olmayan eski hesaplar en başta, kendi kayıt sıralarıyla
const joinOrder = () => Object.values(db.users).filter(x => x.name !== 'Claude' && x.name !== BOT_NAME && !x.bot).map((x, i) => [x, i]).sort((a, b) => (a[0].createdAt || 0) - (b[0].createdAt || 0) || a[1] - b[1]).map(([x]) => x.name);
// Beta Tester sıra numarası (1-300): kayıt sırası, gizlenmişse gönderilmez
let betaOrderCache = { n: -1, list: [] }, badgeStatsCache = null;
function betaNoOf(u) {
  if ((u.hideBadges || []).includes('beta')) return undefined;
  const cnt = Object.keys(db.users).length;
  if (betaOrderCache.n !== cnt) betaOrderCache = { n: cnt, list: joinOrder() };
  const i = betaOrderCache.list.indexOf(u.name); return i >= 0 && i < 300 ? i + 1 : undefined;
}
function badgesOf(u) {
  if (u.bot) return AWARDS.filter(k => u.awards?.[k]); // botlar otomatik rozet almaz, sadece ekibin elle verdikleri
  const order = joinOrder(), idx = order.indexOf(u.name);
  const b = [];
  if (idx >= 0 && idx < 100) b.push('erken');
  if (idx >= 0 && idx < 300) b.push('beta');
  if (u.night) b.push('gece');
  if ((u.msgs || u.xp || 0) >= 100) b.push('sohbet');
  if ((u.msgs || u.xp || 0) >= 1000) b.push('efsane');
  if ((u.xoxWins || 0) >= 3) b.push('xox');
  if ((u.streak?.best || 0) >= 7) b.push('seri7');
  if (db.servers.some(s => s.owner === u.name && !s.public)) b.push('kurucu');
  if (db.servers.some(s => s.owner === u.name && s.badges?.partner)) b.push('partner');
  if (db.servers.some(s => s.owner === u.name && s.badges?.yildiz)) b.push('yildiz');
  if ((u.friends || []).length >= 5) b.push('sosyal');
  if (u.onb?.rewarded) b.push('caylak');
  if (staffRank(u.name)) b.unshift('ekip');
  for (const k of AWARDS) if (u.awards?.[k]) b.push(k);
  if (u.devEarned) b.push('dev');
  try { if (arenaChampions().has(u.name)) b.push('arena'); } catch {} // rozet: bot gerçekten kullanılınca (kabul edilmek yetmez)
  if (db.users[u.name] === u) { const first = !u.badgeAt; u.badgeAt ||= {}; let ch = first; for (const k of b) if (!(k in u.badgeAt)) { u.badgeAt[k] = first ? 0 : Date.now(); ch = true; } if (ch) save(); } // ilk geçişte eski rozetlerin tarihi bilinmiyor (0)
  return b;
}
// Profilde görünen rozetler: kişinin gizlediklerini çıkar
// Başarımlar: kolay kazanılanlar rozet değil, profilde kademeli (1 bronz, 2 gümüş, 3 altın) gösterilir. Değer: [kademe, şu anki, sonraki eşik]
const ACH = { sohbet: [100, 1000, 10000], xox: [3, 25, 100], seri7: [7, 30, 100], sosyal: [5, 25, 100], kurucu: [1, 10, 50], gece: [1], caylak: [1] };
let ownCache = null; // sunucu sahibi -> sahip olduğu en kalabalık sunucunun üye sayısı (her kullanıcı için tüm sunucuları taramamak için)
function achOf(u) {
  if (!ownCache || Date.now() - ownCache.t > 30e3) { const m = new Map(); for (const s of db.servers) if (!s.public) m.set(s.owner, Math.max(m.get(s.owner) || 0, s.members.length, 1)); ownCache = { t: Date.now(), m }; }
  const val = { sohbet: u.msgs || u.xp || 0, xox: u.xoxWins || 0, seri7: u.streak?.best || 0, sosyal: (u.friends || []).length, kurucu: ownCache.m.get(u.name) || 0, gece: u.night ? 1 : 0, caylak: u.onb?.rewarded ? 1 : 0 };
  const o = {}; for (const [k, t] of Object.entries(ACH)) { const v = val[k], tier = t.filter(x => v >= x).length; o[k] = [tier, v, t[tier] ?? null]; }
  return o;
}
const shownBadges = u => { const h = new Set(u.hideBadges || []); return badgesOf(u).filter(k => !h.has(k)); };

// ---------- Çevrimiçi ve ses durumu ----------
const online = new Map();            // socket.id -> kullanıcı adı
const voice = new Map();             // kanal id -> Map(socket.id -> ad)
const voicePass = new Map();         // socket.id -> { ch, until }: yetkili taşımasıyla kilitli odaya geçici giriş izni
const onlineNames = () => [...new Set(online.values())];
let onSetCache = { t: 0, set: new Set() }; // listelerde her kişi için tüm bağlantıları taramamak için kısa önbellek
function isOnlineName(n) { if (Date.now() - onSetCache.t > 1000) onSetCache = { t: Date.now(), set: new Set(online.values()) }; return onSetCache.set.has(n); }
const idleSockets = new Set();
// Telefondan bağlı oturumlar: kişinin bütün açık oturumları telefondaysa durum noktası telefon simgesi olur
const mobileSockets = new Set();
const desktopSockets = new Set();         // masaüstü uygulamasından bağlananlar (bildirimi kendisi gösterir)
const isMobileUA = ua => /Android|iPhone|iPod|iPad|Mobile/i.test(ua || '') && !/Electron|KankaChat/i.test(ua || '');
const onMobile = name => { const socks = [...online].filter(([, n]) => n === name).map(([sid]) => sid); return socks.length > 0 && socks.every(sid => mobileSockets.has(sid)); };
function statusOf(name) {
  const chosen = db.users[name]?.presence || 'online';
  if (chosen === 'invisible') return null;
  if (chosen === 'online') {
    const socks = [...online].filter(([, n]) => n === name).map(([sid]) => sid);
    if (socks.length && socks.every(sid => idleSockets.has(sid))) return 'idle';
  }
  return chosen;
}
// ---------- Telefona bildirim (Web Push) ----------
// Kullanıcının görünür (açık ve önde) bir Kanka penceresi yoksa bildirim telefona/tarayıcıya push olarak gider
const visibleSockets = new Set();
let webpush = null, vapid = null;
try {
  webpush = require('web-push');
  const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
  try { vapid = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8')); } catch { vapid = webpush.generateVAPIDKeys(); fs.writeFileSync(VAPID_FILE, JSON.stringify(vapid)); }
  webpush.setVapidDetails('mailto:kankahq1@gmail.com', vapid.publicKey, vapid.privateKey);
} catch (e) { console.warn('Web Push kapalı:', e.message); webpush = null; }
// Hesapta saklanan bildirim tercihleri (her cihazda aynı): notif=false hepsi kapalı; muted=susturulan sunucular; ch={odaId:'all'|'mentions'|'none'}
const prefsOf = u => u?.prefs || {};
const EMO_KEY_RE = /^(?:[a-z0-9]{1,32}\/[a-z0-9_]{2,24}|[^\s/<>"'&]{1,40})$/u;
// İstemci bir ara art arda yazılan emojileri tek anahtar olarak gönderiyordu; tek tek ayır
const EMO_SEG = (() => { try { return new Intl.Segmenter('tr', { granularity: 'grapheme' }); } catch { return null; } })();
const emoSplit = k => EMO_SEG ? [...EMO_SEG.segment(k)].map(x => x.segment) : [k];
function saneEmojiPrefs(e) {
  const out = { fav: [], use: {} };
  if (!e || typeof e !== 'object') return out;
  if (Array.isArray(e.fav)) {
    const seen = new Set();
    for (const k of e.fav) {
      if (typeof k !== 'string' || k.length > 40 || !EMO_KEY_RE.test(k) || seen.has(k)) continue;
      if (!k.includes('/') && emoSplit(k).length !== 1) continue;
      seen.add(k); out.fav.push(k);
      if (out.fav.length >= 48) break;
    }
  }
  if (e.use && typeof e.use === 'object') {
    const put = (k, n, t) => {
      if (!k || k.length > 40 || !EMO_KEY_RE.test(k)) return;
      const c = out.use[k];
      out.use[k] = { n: Math.min(9999, Math.max(c?.n || 0, n)), t: Math.max(c?.t || 0, t) };
    };
    for (const [k, v] of Object.entries(e.use).slice(0, 200)) {
      if (typeof k !== 'string' || !v) continue;
      const n = Math.floor(+v.n); if (!(n > 0)) continue;
      const t = Math.min(Date.now(), Math.max(0, +v.t || 0));
      if (k.includes('/')) put(k, n, t);
      else for (const p of emoSplit(k)) put(p, n, t);
    }
    const ks = Object.keys(out.use);
    if (ks.length > 64) ks.sort((a, b) => out.use[b].n - out.use[a].n).slice(64).forEach(k => delete out.use[k]);
  }
  return out;
}
function pushAllowed(u, n) {
  const pr = prefsOf(u); if (pr.notif === false) return false;
  const chId = n.channelId || n.ch;
  if (n.dm || n.friend || !chId) return true;
  const f = findChannel(chId); if (!f) return true;
  if ((pr.muted || []).includes(f.s.id) && !n.direct) return false;
  const cm = (pr.ch || {})[chId]; if (cm === 'none') return false;
  return !(cm == null && pr.srv?.[f.s.id]?.lvl === 'none');
}
// Bildirim gönderim sayaçları (/api/surum'da görünür): sorun olduğunda nerede takıldığını görmek için
const pushStats = { gonderildi: 0, hata: 0, gorunur: 0, masaustu: 0, sonHata: null };
function pushOne(u, sub, body, tag) {
  // Apple, Topic başlığını kabul etmiyor (BadWebPushTopic → iPhone'a hiç bildirim gitmiyordu); ona konu gönderme
  const apple = /push\.apple\.com/.test(sub.endpoint || '');
  return webpush.sendNotification(sub, body, { TTL: 3600, urgency: 'high', topic: apple ? undefined : (tag || 'kanka').replace(/[^\w-]/g, '').slice(0, 32) || undefined }).then(r => { pushStats.gonderildi++; return { ok: true, status: r?.statusCode }; }).catch(err => {
    const st = err?.statusCode || 0;
    if (st === 404 || st === 410) { u.push = (u.push || []).filter(x => x.endpoint !== sub.endpoint); save(); }
    else { pushStats.hata++; pushStats.sonHata = { at: Date.now(), status: st, host: (() => { try { return new URL(sub.endpoint).host; } catch { return '?'; } })(), msg: String(err?.body || err?.message || '').slice(0, 160) }; if (pushStats.hata % 20 === 1) console.warn('Bildirim gönderilemedi', pushStats.sonHata); }
    return { ok: false, status: st };
  });
}
// ================= Mobil uygulama bildirimleri (Android: FCM HTTP v1, iOS: APNs) =================
// Anahtarlar depoda değil, sunucunun veri klasöründe (veri/mobil-bildirim.json): Yönetim paneli › Mobil bildirimler'den yüklenir.
const NPUSH_FILE = path.join(DATA_DIR, 'mobil-bildirim.json');
let npCfg = {}; try { npCfg = JSON.parse(fs.readFileSync(NPUSH_FILE, 'utf8')); } catch {}
const npStats = { fcm: 0, apns: 0, hata: 0, sonHata: null };
const b64u = b => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
let fcmTok = null; // { t, exp }
async function fcmAccess() {
  const sa = npCfg.fcm; if (!sa?.private_key) throw new Error('FCM hesabı yok');
  if (fcmTok && fcmTok.exp > Date.now() + 60e3) return fcmTok.t;
  const now = Math.floor(Date.now() / 1000), head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' })),
    body = b64u(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: sa.token_uri || 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = b64u(crypto.createSign('RSA-SHA256').update(head + '.' + body).sign(sa.private_key));
  const r = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + body + '.' + sig }) });
  const j = await r.json(); if (!j.access_token) throw new Error('FCM giriş: ' + (j.error_description || j.error || r.status));
  fcmTok = { t: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 }; return fcmTok.t;
}
const npData = p => { const d = { ch: p.ch || '', from: p.from || '', dm: p.dm ? '1' : '', friend: p.friend ? '1' : '', tag: p.tag || 'kanka', call: p.call ? '1' : '', mid: p.mid || '' }; for (const k in d) if (!d[k]) delete d[k]; return d; };
async function fcmSend(token, p) {
  const at = await fcmAccess(), chan = p.call ? 'aramalar' : p.friend ? 'sosyal' : 'mesajlar';
  const r = await fetch(`https://fcm.googleapis.com/v1/projects/${npCfg.fcm.project_id}/messages:send`, { method: 'POST', headers: { Authorization: 'Bearer ' + at, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { token, notification: { title: String(p.title || 'Kanka Chat').slice(0, 120), body: String(p.body || '').slice(0, 300) }, data: npData(p),
      android: { priority: 'HIGH', ttl: p.call ? '45s' : '3600s', collapse_key: (p.tag || 'kanka').slice(0, 60), notification: { channel_id: chan, tag: (p.tag || 'kanka').slice(0, 60), icon: 'ic_stat_kanka', color: '#D4FF00', sound: 'default', ...(p.badge ? { notification_count: p.badge } : {}) } } } }) });
  if (r.ok) { npStats.fcm++; return { ok: true }; }
  const j = await r.json().catch(() => ({})), code = j?.error?.details?.find?.(x => x.errorCode)?.errorCode || j?.error?.status;
  return { ok: false, dead: r.status === 404 || code === 'UNREGISTERED' || (r.status === 400 && code === 'INVALID_ARGUMENT'), msg: `${r.status} ${code || ''} ${j?.error?.message || ''}`.trim() };
}
let apnsJwt = null; // { t, at }
function apnsToken() {
  const a = npCfg.apns; if (!a?.key) throw new Error('APNs anahtarı yok');
  if (apnsJwt && Date.now() - apnsJwt.at < 40 * 60e3) return apnsJwt.t;
  const head = b64u(JSON.stringify({ alg: 'ES256', kid: a.keyId })), body = b64u(JSON.stringify({ iss: a.teamId, iat: Math.floor(Date.now() / 1000) }));
  const sig = b64u(crypto.sign('sha256', Buffer.from(head + '.' + body), { key: a.key, dsaEncoding: 'ieee-p1363' }));
  apnsJwt = { t: head + '.' + body + '.' + sig, at: Date.now() }; return apnsJwt.t;
}
let apnsConn = null;
function apnsSend(token, p, sandbox, voip) {
  const a = npCfg.apns, host = sandbox ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
  return new Promise(res => {
    try {
      if (!apnsConn || apnsConn.closed || apnsConn.destroyed || apnsConn._host !== host) { apnsConn = require('http2').connect(host); apnsConn._host = host; apnsConn.on('error', () => { apnsConn = null; }); apnsConn.setTimeout(10 * 60e3, () => { try { apnsConn.close(); } catch {} apnsConn = null; }); }
      const payload = voip ? JSON.stringify({ aps: {}, k: { ch: p.ch || '', from: p.from || '', title: String(p.callTitle || p.title || '').slice(0, 80), video: p.video ? '1' : '' } }) : JSON.stringify({ aps: { alert: { title: String(p.title || 'Kanka Chat').slice(0, 120), body: String(p.body || '').slice(0, 300) }, sound: 'default', 'thread-id': (p.tag || 'kanka').slice(0, 60), 'interruption-level': p.call ? 'time-sensitive' : 'active', ...(p.badge != null ? { badge: p.badge } : {}) }, ...npData(p) });
      const req = apnsConn.request({ ':method': 'POST', ':path': '/3/device/' + token, authorization: 'bearer ' + apnsToken(), 'apns-topic': (a.bundle || 'com.kanka.chat') + (voip ? '.voip' : ''), 'apns-push-type': voip ? 'voip' : 'alert', 'apns-priority': '10',
        'apns-expiration': String(Math.floor(Date.now() / 1000) + (p.call ? 45 : 3600)), 'apns-collapse-id': (p.tag || 'kanka').slice(0, 60) });
      let st = 0, out = ''; req.on('response', h => { st = h[':status']; }); req.on('data', d => { out += d; });
      req.on('end', () => { if (st === 200) { npStats.apns++; return res({ ok: true }); } let rsn = ''; try { rsn = JSON.parse(out).reason; } catch {}
        res({ ok: false, dead: st === 410 || ['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic'].includes(rsn), wrongEnv: rsn === 'BadDeviceToken', msg: `${st} ${rsn}` }); });
      req.on('error', e => res({ ok: false, msg: e.message })); req.end(payload);
    } catch (e) { res({ ok: false, msg: e.message }); }
  });
}
async function nativePush(u, p) {
  // iOS: VoIP jetonu olan cihaza arama, telefonun kendi arama ekranıyla (CallKit) gelir; aynı aramayı normal bildirimle tekrar göndermeyiz.
  // VoIP jetonuna arama dışında hiçbir şey gönderilmez (Apple kuralı: her VoIP bildirimi bir arama olmalı).
  const voipOn = p.call && (u.npush || []).some(d => d.voip);
  for (const d of [...(u.npush || [])]) {
    if (d.voip ? !p.call : (voipOn && d.p === 'ios')) continue;
    let r;
    try { r = d.p === 'ios' ? (npCfg.apns ? await apnsSend(d.t, p, d.sandbox ?? !npCfg.apns.prod, !!d.voip) : { ok: false, msg: 'APNs ayarlı değil' }) : (npCfg.fcm ? await fcmSend(d.t, p) : { ok: false, msg: 'FCM ayarlı değil' }); }
    catch (e) { r = { ok: false, msg: e.message }; }
    if (!r.ok && d.p === 'ios' && r.wrongEnv && d.sandbox === undefined) { d.sandbox = !(npCfg.apns.prod === false); r = await apnsSend(d.t, p, d.sandbox, !!d.voip); } // geliştirme / yayın ortamı farkı: bir kez diğerini dene
    if (r.ok) continue;
    if (r.dead) { u.npush = u.npush.filter(x => x.t !== d.t); save(); continue; }
    npStats.hata++; npStats.sonHata = { at: Date.now(), p: d.p, msg: String(r.msg || '').slice(0, 160) };
  }
}
function sendPush(name, payload) {
  const u = db.users[name]; if (!u || !((webpush && u.push?.length) || u.npush?.length)) return;
  if ((u.presence || 'online') === 'dnd') return;
  if (!pushAllowed(u, payload)) return;
  // Şu an Kanka'ya bakıyorsa gönderme. Ama ekran açık kalıp kişi uzaklaştıysa (boşta) telefona yine gelsin.
  if ([...online].some(([sid, n]) => n === name && visibleSockets.has(sid) && !idleSockets.has(sid))) { pushStats.gorunur++; return; }
  const body = JSON.stringify(payload);
  // Masaüstü uygulaması açıksa bildirimi o zaten gösteriyor: bilgisayardaki tarayıcıya da gönderirsek tıklayınca Chrome açılıyordu.
  // O durumda sadece telefonlara gönder.
  const desk = [...online].some(([sid, n]) => n === name && desktopSockets.has(sid));
  if (u.npush?.length) nativePush(u, payload).catch(e => console.warn('mobil bildirim', e.message)); // telefon uygulaması
  if (!webpush) return;
  for (const sub of [...(u.push || [])]) {
    // sadece bilgisayar tarayıcısı olduğunu bildiğimiz abonelikleri atla; eski/bilinmeyen abonelikler (telefon olabilir) yine alır
    if (desk && (sub.dev === 'pc' || (sub.dev == null && sub.mob === false))) { pushStats.masaustu++; continue; }
    pushOne(u, sub, body, payload.tag);
  }
}
// Bildirim kutusu (Discord'un Bildirimler sekmesi): bahsetme, yanıt, @everyone, rol, arkadaşlık isteği. Her cihazda aynı, son 60 kayıt.
function inboxAdd(name, n) {
  const u = db.users[name]; if (!u || u.bot) return null;
  const t = n.friend ? 'friend' : n.dm ? 'dm' : n.kind || 'direct', now = Date.now();
  // Özel mesajlar: aynı sohbetten okunmamış kayıt varsa yenisi onu günceller (sayı artar), liste sel olmaz
  const old = t === 'dm' ? (u.inbox || []).find(x => x.t === 'dm' && x.ch === n.channelId && !x.r) : null;
  const e = { id: old?.id || id(), t, from: n.from, text: String(n.text || '').slice(0, 160), ch: n.channelId || null, sid: n.sid || null, mid: n.mid || null, where: n.where || '', at: now, ...(t === 'dm' ? { n: (old?.n || 0) + 1, grp: n.channelId?.startsWith('g:') ? 1 : undefined } : {}) };
  u.inbox = [e, ...(u.inbox || []).filter(x => x.id !== e.id && !(e.mid && x.mid === e.mid))].slice(0, 80); save();
  io.to('user:' + name).emit('inbox+', e); return e;
}
const inboxUnseen = u => (u.inbox || []).filter(x => !x.r && x.at > (u.inboxSeen || 0)).length;
const badgeOf = u => Math.min(99, inboxUnseen(u)); // uygulama simgesindeki sayı
function notifyUser(name, n) {
  io.to('user:' + name).emit('notify', n);
  if (db.users[name]) inboxAdd(name, n);
  const title = n.friend ? n.from : n.dm && n.channelId?.startsWith('g:') ? `${n.from} · ${n.where}` : n.dm ? n.from : n.kind === 'reply' ? `${n.from} sana yanıt verdi` : n.kind === 'everyone' ? `${n.from} · @everyone` : n.kind === 'role' ? `${n.from} rolünü etiketledi` : `${n.from} seni etiketledi`;
  sendPush(name, { direct: !!n.mention, title, body: n.friend ? 'sana arkadaşlık isteği gönderdi' : String(n.text || '').slice(0, 160) + (n.dm ? '' : n.where ? `\n${n.where}` : ''),
    tag: n.channelId || (n.friend ? 'friends' : 'kanka'), ch: n.channelId || null, from: n.from, dm: !!n.dm, friend: !!n.friend, mid: n.mid || undefined, badge: badgeOf(db.users[name] || {}),
    e: n.e && n.e.enc.ct.length <= 2400 ? n.e : undefined }); // bildirim boyutu sınırlı: kısa şifreli mesaj telefonda çözülüp gösterilir
}
const presenceList = () => [...onlineNames().map(n => { const st = statusOf(n); return st && onMobile(n) ? [n, st, 'm'] : [n, st]; }).filter(x => x[1]),
  ...botsOnline().map(n => [n, db.users[n]?.presence || 'online']).filter(x => x[1] !== 'invisible')]; // geliştirici botları: ağ geçidine bağlıyken çevrimiçi
function botsOnline() { const out = []; try { for (const [appId, set] of botConns) if ([...set].some(c => c.ready) && db.apps?.[appId]?.bot) out.push(db.apps[appId].bot); } catch {} return out; }
// ---------- Yıllık sayaçlar (Kanka Wrapped ve zevk eşleşmesi için) ----------
// Sadece toplam sayılar tutulur (hangi şarkıyı kaç dakika dinledin, kiminle kaç dakika seste kaldın…); mesaj içeriği tutulmaz.
// Ayrı dosyada (istatistik.db) durur, data.json'u büyütmez. Bellekte biriktirilir, dakikada bir topluca yazılır.
// Kullanıcı Ayarlar › Gizlilik'ten kapatırsa (u.wrapOff) onun için hiçbir şey sayılmaz.
// Anahtarlar: msg, msgh:<saat>, msgsv:<sunucu>, msgch:<oda>, dm:<kişi>, em:<emoji>, vs (ses dk), vch:<oda>, vsv:<sunucu>, vk:<kişi>,
//   mz (müzik dk), ma:<sanatçı>, ms:<sanatçı — şarkı>, oy (oyun dk), og:<oyun>, gun (aktif gün), ar:<oyun>:o / :w (Arena)
// Sunucu toplamları "#<sunucu id>" adıyla: msg, vs, m:<üye>, v:<üye>, ch:<oda>, vch:<oda>, em:<emoji>, h:<saat>
const STAT = (() => {
  const pend = new Map(); let sdb = null, up = null;
  if (SQLITE_OK) try {
    const { DatabaseSync } = require('node:sqlite');
    sdb = new DatabaseSync(path.join(DATA_DIR, 'istatistik.db'));
    sdb.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=2000;'
      + 'CREATE TABLE IF NOT EXISTS sayac (y INTEGER NOT NULL, u TEXT NOT NULL, k TEXT NOT NULL, v REAL NOT NULL, PRIMARY KEY (y, u, k)) WITHOUT ROWID;');
    up = sdb.prepare('INSERT INTO sayac (y, u, k, v) VALUES (?, ?, ?, ?) ON CONFLICT(y, u, k) DO UPDATE SET v = v + excluded.v');
  } catch (e) { console.error('istatistik.db açılamadı:', e.message); sdb = null; }
  const yearTR = (t = Date.now()) => new Date(t + 3 * 3600e3).getUTCFullYear();
  const off = n => { const u = db.users[n]; return !u || u.bot || !!u.wrapOff; };
  const K = s => String(s).slice(0, 160);
  function add(u, k, n = 1) { if (!sdb || !u || !k || !n) return; const key = u + '\u0001' + K(k); pend.set(key, (pend.get(key) || 0) + n); }
  function flush() {
    if (!sdb || !pend.size) return; const y = yearTR(), rows = [...pend]; pend.clear();
    try { sdb.exec('BEGIN'); for (const [key, v] of rows) { const i = key.indexOf('\u0001'); up.run(y, key.slice(0, i), key.slice(i + 1), v); } sdb.exec('COMMIT'); }
    catch (e) { try { sdb.exec('ROLLBACK'); } catch {} console.error('istatistik yazılamadı:', e.message); }
  }
  setInterval(flush, 60e3);
  const qTop = () => sdb.prepare('SELECT k, v FROM sayac WHERE y = ? AND u = ? AND k >= ? AND k < ? ORDER BY v DESC LIMIT ?');
  const qAll = () => sdb.prepare('SELECT k, v FROM sayac WHERE y = ? AND u = ?');
  let _top = null, _all = null;
  return {
    on: () => !!sdb, yearTR, off, add, flush,
    // kişi için (sayılmıyorsa hiçbir şey eklenmez)
    me(n, k, v = 1) { if (!off(n)) add(n, k, v); },
    top(u, y, prefix, lim = 10) { if (!sdb) return []; flush(); _top ||= qTop(); return _top.all(y, u, prefix, prefix + '￿', lim).map(r => ({ k: r.k.slice(prefix.length), v: r.v })); },
    all(u, y) { if (!sdb) return {}; flush(); _all ||= qAll(); const o = {}; for (const r of _all.all(y, u)) o[r.k] = r.v; return o; },
    // bu değerden fazlasına sahip olanların oranı (yüzde, küçük = daha iyi)
    rankPct(y, k, v) { if (!sdb || !v) return null; flush(); const t = sdb.prepare("SELECT COUNT(*) n FROM sayac WHERE y = ? AND k = ? AND u NOT LIKE '#%'").get(y, k).n, a = sdb.prepare("SELECT COUNT(*) n FROM sayac WHERE y = ? AND k = ? AND v > ? AND u NOT LIKE '#%'").get(y, k, v).n; return t ? Math.max(1, Math.ceil((a + 1) / t * 100)) : null; },
    wipe(u) { if (!sdb) return; for (const k of [...pend.keys()]) if (k.startsWith(u + '\u0001')) pend.delete(k); try { sdb.prepare('DELETE FROM sayac WHERE u = ?').run(u); } catch {} },
    close() { try { flush(); sdb?.close(); } catch {} },
  };
})();
// Mesaj sayaçları: saat (TR), sunucu, oda, DM kişisi, kullanılan emojiler
const EMOJI_RE = /\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*/gu;
const statDay = new Map();
function statMsg(me, chId, text) {
  if (!STAT.on() || !db.users[me] || db.users[me].bot) return;
  const h = new Date(Date.now() + 3 * 3600e3).getUTCHours(), mine = !STAT.off(me), sv = serverOf(chId), ems = text ? (String(text).match(EMOJI_RE) || []).slice(0, 12) : [];
  if (mine) {
    STAT.add(me, 'msg'); STAT.add(me, 'msgh:' + h);
    const d = dayKeyTR(); if (statDay.get(me) !== d) { statDay.set(me, d); STAT.add(me, 'gun'); }
    if (sv) { STAT.add(me, 'msgsv:' + sv.id); STAT.add(me, 'msgch:' + chId); }
    else if (chId.startsWith('dm:')) { const o = chId.slice(3).split('|').find(n => n !== me); if (o && !STAT.off(o)) STAT.add(me, 'dm:' + o); }
    for (const e of ems) STAT.add(me, 'em:' + e);
  }
  if (sv && !sv.public) { const g = '#' + sv.id; STAT.add(g, 'msg'); STAT.add(g, 'h:' + h); STAT.add(g, 'ch:' + chId); if (mine) STAT.add(g, 'm:' + me); for (const e of ems) STAT.add(g, 'em:' + e); }
}
// Dakikada bir: dinlenen müzik ve oynanan oyun (masaüstü uygulamasının bildirdiği)
setInterval(() => {
  if (!STAT.on()) return; const now = Date.now();
  for (const u of Object.values(db.users)) {
    const a = u.auto; if (!a || a.gone || now - a.at > 45e3 || STAT.off(u.name)) continue;
    if (a.music?.title) { const ar = (a.music.artist || '').split(/\s*(?:,|&| feat\.? | ft\.? | x )\s*/i)[0].trim(); STAT.add(u.name, 'mz'); if (ar) { STAT.add(u.name, 'ma:' + ar); STAT.add(u.name, 'ms:' + ar + ' — ' + a.music.title); } }
    if (a.game?.name) { STAT.add(u.name, 'oy'); STAT.add(u.name, 'og:' + a.game.name); }
    if ((a.music?.title || a.game?.name) && statDay.get(u.name) !== dayKeyTR()) { statDay.set(u.name, dayKeyTR()); STAT.add(u.name, 'gun'); }
  }
}, 60e3);
// Zevk profili: sanatçı ve oyun dakikaları (bu yıl + geçen yılın yarısı), 10 dakika önbellekli
const tasteCache = new Map();
function tasteOf(n) {
  const c = tasteCache.get(n); if (c && Date.now() - c.at < 600e3) return c;
  const y = STAT.yearTR(), art = new Map(), game = new Map(), arena = new Map();
  if (!STAT.off(n)) for (const [yy, w] of [[y, 1], [y - 1, 0.5]]) {
    for (const r of STAT.top(n, yy, 'ma:', 200)) art.set(r.k, (art.get(r.k) || 0) + r.v * w);
    for (const r of STAT.top(n, yy, 'og:', 60)) game.set(r.k, (game.get(r.k) || 0) + r.v * w);
    for (const r of STAT.top(n, yy, 'ar:', 40)) if (r.k.endsWith(':o')) arena.set(r.k.slice(0, -2), (arena.get(r.k.slice(0, -2)) || 0) + r.v * w);
  }
  const t = { at: Date.now(), art, game, arena }; tasteCache.set(n, t); return t;
}
// Kosinüs benzerliği (dakikaların logaritması: 10 saat dinlenen sanatçı 1 saatlikten 10 kat değil ~2 kat ağır)
function cosSim(a, b) {
  if (!a.size || !b.size) return null;
  let dot = 0, na = 0, nb = 0; const w = v => Math.log1p(v);
  for (const [k, v] of a) { na += w(v) ** 2; const o = b.get(k); if (o) dot += w(v) * w(o); }
  for (const v of b.values()) nb += w(v) ** 2;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
const shared = (a, b, min = 3) => [...a].filter(([k, v]) => v >= min && (b.get(k) || 0) >= min).sort((x, y) => Math.min(y[1], b.get(y[0])) - Math.min(x[1], b.get(x[0]))).map(([k]) => k);
// İki kişinin uyumu: müzik ve oyun ayrı ayrı (yüzde), toplam, ortak sanatçılar/oyunlar ve "neden önerildi" yazısı
function compat(a, b) {
  const ua = db.users[a], ub = db.users[b]; if (!ua || !ub || ua.matchOff || ub.matchOff) return null;
  const A = tasteOf(a), B = tasteOf(b);
  const pct = x => x == null ? null : Math.round(100 * Math.sqrt(Math.max(0, Math.min(1, x))));
  const mz = pct(cosSim(A.art, B.art)), og = pct(cosSim(A.game, B.game)), ar = pct(cosSim(A.arena, B.arena));
  const parts = [[mz, 0.5], [og, 0.35], [ar, 0.15]].filter(([v]) => v != null);
  if (!parts.length) return null;
  const sw = parts.reduce((s, [, w]) => s + w, 0), total = Math.round(parts.reduce((s, [v, w]) => s + v * w, 0) / sw);
  const sanatci = shared(A.art, B.art).slice(0, 5), oyun = shared(A.game, B.game, 10).slice(0, 4), arena = shared(A.arena, B.arena, 1).slice(0, 3);
  const why = [mz != null && mz >= 20 ? `%${mz} müzik uyumu` : '', sanatci.length ? `${sanatci.length} ortak sanatçı` : '', oyun.length === 1 ? `ikiniz de ${oyun[0]}` : oyun.length ? `${oyun.length} ortak oyun` : '', arena.length ? `Arena'da ${arena[0]}` : ''].filter(Boolean).join(' · ');
  return { uyum: total, muzik: mz, oyun: og, arenaUyum: ar, sanatci, oyunlar: oyun, arena, neden: why };
}

// Odadaki sohbet ne zamandır sürüyor: oda boşken doluya geçince başlar, tamamen boşalınca sıfırlanır
// Seste geçen süre (kişi başı, gün gün): Yuva'daki "Bu hafta seste" grafiği için. Dakikada bir sayılır, 21 gün tutulur.
const dayKeyTR = (t = Date.now()) => new Date(t + 3 * 3600e3).toISOString().slice(0, 10);
setInterval(() => {
  const who = new Set(); for (const [, m] of voice) for (const n of m.values()) who.add(n);
  if (!who.size) return;
  const d = dayKeyTR(), cut = dayKeyTR(Date.now() - 21 * 864e5);
  for (const [ch, m] of voice) { // yıllık sayaçlar: ses dakikası, oda, sunucu, birlikte seste olunan kişiler
    const f = ch.startsWith('call:') ? null : findChannel(ch), names = [...new Set(m.values())], afk = f && (f.s.afk?.ch || f.s.afk) === ch;
    if (afk) continue;
    for (const n of names) { if (STAT.off(n)) continue; STAT.add(n, 'vs'); if (f) { STAT.add(n, 'vch:' + ch); STAT.add(n, 'vsv:' + f.s.id); }
      if (names.length <= 16) for (const o of names) if (o !== n && !STAT.off(o)) STAT.add(n, 'vk:' + o); }
    if (f && !f.s.public) { const g = '#' + f.s.id; STAT.add(g, 'vs', names.length); STAT.add(g, 'vch:' + ch, names.length); for (const n of names) if (!STAT.off(n)) STAT.add(g, 'v:' + n); }
  }
  for (const n of who) { const u = db.users[n]; if (!u) continue; u.firstVoiceAt ||= Date.now(); u.vtot = (u.vtot || 0) + 1; const v = (u.vmin ||= {}); v[d] = (v[d] || 0) + 1; for (const k of Object.keys(v)) if (k < cut) delete v[k]; }
  for (const [ch, m] of voice) { // sesli XP
    if (m.size < 2) continue; const f = ch.startsWith('call:') ? null : findChannel(ch); if (f && (f.s.afk?.ch || f.s.afk) === ch) continue;
    for (const [sid, n] of m) { const u = db.users[n], fl = voiceFlags.get(sid) || {}; if (!u || fl.d) continue;
      const vx = u.vxp?.d === d ? u.vxp : (u.vxp = { d, n: 0 }); if (vx.n >= 240) continue;
      const g = fl.m ? 1 : 2; vx.n += g; addXp(n, g, 'ses', f?.s || null, null); } }
  save(); if (who.size) pushUsers();
}, 60e3);
const voiceStart = new Map();
function voiceAges() {
  const now = Date.now(), o = {};
  for (const k of [...voiceStart.keys()]) if (!voice.get(k)?.size) voiceStart.delete(k);
  for (const [k, m] of voice) if (m.size) { if (!voiceStart.has(k)) voiceStart.set(k, now); if (!k.startsWith('call:')) o[k] = now - voiceStart.get(k); } // özel aramalar herkese gitmesin (DM id'si iki ismi içeriyor) · saat farkı olmasın diye "kaç ms önce" gönderilir
  return o;
}
const voiceState = () => Object.fromEntries([...voice].filter(([k]) => !k.startsWith('call:')).map(([k, m]) => [k, [...new Set(m.values())]]));
// Durum listesi: kısa sürede gelen değişiklikler tek gönderimde toplanır, değişmediyse hiç gönderilmez
let presT = null, lastPres = '';
// Yeni istemcilere tüm liste değil sadece değişenler gider (presenceDiff: { set: [[ad, durum, 'm'?]], del: [ad] }); eski istemciler tüm listeyi alır
let presMap = new Map();
const pushPresence = () => { if (presT) return; presT = setTimeout(() => { presT = null; const l = presenceList(), j = JSON.stringify(l); if (j === lastPres) return; lastPres = j;
  const m = new Map(l.map(e => [e[0], JSON.stringify(e)])), set = l.filter(e => presMap.get(e[0]) !== m.get(e[0])), del = [...presMap.keys()].filter(n => !m.has(n)); presMap = m;
  if (set.length || del.length) io.to('up2').emit('presenceDiff', { set, del });
  if (io.sockets.sockets.size > (io.sockets.adapter.rooms.get('up2')?.size || 0)) io.except('up2').emit('presence', l); }, 400); };
// Kullanıcı bilgileri: herkese tüm liste yerine sadece değişen kişiler gider (1,5 sn'de bir toplanır). Eski istemciler tüm listeyi almaya devam eder.
const usersCache = new Map(); let usersT = null;
function pushUsers() { if (!usersT) usersT = setTimeout(flushUsers, 1500); }
function flushUsers() {
  usersT = null; const upd = [], seen = new Set();
  for (const u of Object.values(db.users)) { const p = pubUser(u), j = JSON.stringify(p); seen.add(p.name); if (usersCache.get(p.name) !== j) { usersCache.set(p.name, j); upd.push(p); } }
  const del = [...usersCache.keys()].filter(n => !seen.has(n)); for (const n of del) usersCache.delete(n);
  if (!upd.length && !del.length) return;
  io.to('up2').emit('usersPatch', { upd, del });
  if (io.sockets.sockets.size > (io.sockets.adapter.rooms.get('up2')?.size || 0)) io.except('up2').emit('users', allUsers());
}
setTimeout(() => { for (const u of Object.values(db.users)) { const p = pubUser(u); usersCache.set(p.name, JSON.stringify(p)); } }, 0);
const voiceMedia = new Map();       // socket.id -> { cam, screen } (yayın rozetleri için)
const liveMeta = new Map();         // socket.id -> { since, q, viewers, audio, thumb, thumbAt } (yayın önizleme kartı)
const liveState = () => { const o = {}; for (const [ch, m] of voice) { if (ch.startsWith('call:')) continue; const l = [...m].filter(([sid]) => voiceMedia.get(sid)?.screen).sort((a, b) => (liveMeta.get(a[0])?.since || 0) - (liveMeta.get(b[0])?.since || 0)).map(([, n]) => n); if (l.length) o[ch] = l; } return o; };
// Odadakileri sesten çıkar (oda silindi, sunucudan atıldı vb.)
const srvMuted = new Set(); // 'sunucuId|isim': yetkili tarafından seste susturulanlar
function voiceKick(chIds, onlyName, reason) {
  let any = false;
  for (const ch of chIds) {
    const room = voice.get(ch); if (!room) continue;
    for (const [sid, n] of [...room]) {
      if (onlyName && n !== onlyName) continue;
      any = true; room.delete(sid); voiceMedia.delete(sid); voiceFlags.delete(sid); liveMeta.delete(sid);
      if (botVoice.has(sid)) { const bv = botVoice.get(sid); botVoice.delete(sid); gwSend(bv.conn, { op: 0, t: 'SES_AYRILDI', d: { oda: ch, sebep: reason || 'sesten çıkarıldı' } }); }
      io.to(sid).emit('voiceKicked', { ch, reason });
      io.sockets.sockets.get(sid)?.leave('v:' + ch);
      io.to('v:' + ch).emit('voiceLeft', sid);
      stage.get(ch)?.speakers.delete(n); stage.get(ch)?.hands.delete(n);
    }
    if (!room.size) { voice.delete(ch); stage.delete(ch); }
  }
  if (any) pushVoice();
}
const voiceFlags = new Map(); // socket.id -> { m: mikrofon kapalı }
const flagsState = () => { const o = {}; for (const [ch, room] of voice) { if (ch.startsWith('call:')) continue; for (const [sid, n] of room) { const f = voiceFlags.get(sid) || {}, md = voiceMedia.get(sid) || {}; const sm = srvMuted.size && srvMuted.has((findChannel(ch)?.s?.id || '') + '|' + n); if (f.m || f.d || md.cam || md.screen || sm) (o[ch] ||= {})[n] = { m: !!f.m, ...(f.d ? { d: true } : {}), cam: !!md.cam, screen: !!md.screen, ...(sm ? { sm: true } : {}) }; } } return o; };
// Özel sohbet aramaları (DM/grup) sadece o sohbetin üyelerine görünür: "Arama sürüyor · Katıl"
const callsFor = name => { const o = {}; for (const [k, m] of voice) if (k.startsWith('call:') && m.size && canAccess(name, k.slice(5))) o[k.slice(5)] = [...new Set(m.values())]; return o; };
let lastCallsSig = '';
function pushCalls() {
  const sig = JSON.stringify([...voice].filter(([k]) => k.startsWith('call:')).map(([k, m]) => [k, [...m.values()]]));
  if (sig === lastCallsSig) return; lastCallsSig = sig;
  for (const n of new Set(online.values())) io.to('user:' + n).emit('calls', callsFor(n));
}
// Ses odası bilgisi sadece o odayı görebilene: özel sunucunun / gizli odanın kimlerle dolu olduğu dışarı sızmasın
const seenBy = (o, n) => { const r = {}; for (const k in o) if (canAccess(n, k)) r[k] = o[k]; return r; };
const eachOnline = fn => { for (const n of new Set(online.values())) fn(n); };
const pushFlags = () => { const F = flagsState(); eachOnline(n => io.to('user:' + n).emit('voiceFlags', seenBy(F, n))); botVoiceTap(); };
function voiceTo(names) {
  const V = voiceState(), A = voiceAges(), L = liveState(), F = flagsState();
  for (const n of names) { const t = io.to('user:' + n); t.emit('voiceState', seenBy(V, n)); t.emit('voiceAge', seenBy(A, n)); t.emit('voiceLive', seenBy(L, n)); t.emit('voiceFlags', seenBy(F, n)); }
}
const pushVoice = () => { voiceTo(new Set(online.values())); pushCalls(); botVoiceTap(); };
// Özel arama günlüğü: sohbete "arama başladı / bitti / cevapsız" yazar, 3 dakika yalnız kalana Kanka seslenir
const callSess = new Map();
const CALL_ALONE_MS = +process.env.CALL_ALONE_MS || 300e3;
function callMsg(chId, call) {
  const msg = { id: id(), kind: 'call', time: Date.now(), call, reactions: {} };
  const list = (db.messages[chId] ||= []); list.push(msg); if (list.length > 2000) list.shift();
  save(); io.to(chId).emit('message', { channelId: chId, msg });
  for (const n of chatMembers(chId)) io.to('user:' + n).emit('dms', dmsFor(n));
  return msg;
}
function callSessOf(chId) {
  let s = callSess.get(chId);
  if (!s) { s = { by: null, start: Date.now(), rangAt: 0, max: 0, names: new Set(), aloneT: null }; callSess.set(chId, s); }
  return s;
}
// Aramada tek kişi kalırsa (diğeri çıktı ya da bağlantısı koptu) arama hemen bitmez: karşı taraf geri dönebilir.
// CALL_ALONE_MS (5 dk) boyunca kimse gelmezse arama sunucu tarafında kapatılır; 1 dakika kala uyarılır.
function callAloneWatch(chId) {
  const s = callSess.get(chId); if (!s) return;
  clearTimeout(s.aloneT); clearTimeout(s.warnT); s.aloneT = s.warnT = null;
  const room = voice.get('call:' + chId);
  if (!room || new Set(room.values()).size !== 1) return;
  const name = [...room.values()][0], alone = () => { const r = voice.get('call:' + chId); return r && new Set(r.values()).size === 1 && [...r.values()][0] === name; };
  const mins = Math.max(1, Math.round(CALL_ALONE_MS / 60e3));
  if (CALL_ALONE_MS > 90e3) { s.warnT = setTimeout(() => { if (alone()) io.to('user:' + name).emit('toast', 'Aramada tek başınasın. 1 dakika içinde kimse gelmezse arama kapanacak.'); }, CALL_ALONE_MS - 60e3); s.warnT.unref?.(); }
  s.aloneT = setTimeout(() => {
    if (!alone()) return;
    voiceKick(['call:' + chId], null, `${mins} dakikadır aramada tek başınaydın, arama kapatıldı`);
    callEnded(chId);
  }, CALL_ALONE_MS);
  s.aloneT.unref?.();
}
function callEnded(chId) {
  const s = callSess.get(chId); if (!s) return;
  clearTimeout(s.aloneT); clearTimeout(s.warnT); callSess.delete(chId);
  const ms = Date.now() - s.start;
  if (s.max >= 2) return callMsg(chId, { state: 'end', by: s.by, ms, members: [...s.names].filter(n => n !== s.by).slice(0, 9) });
  if (!s.rangAt) return;
  callMsg(chId, { state: 'missed', by: s.by, ms: Math.max(1000, Date.now() - s.rangAt) });
  for (const n of chatMembers(chId)) if (n !== s.by && !db.users[n]?.blocked?.includes(s.by)) sendPush(n, { title: 'Cevapsız arama', body: `${s.by} seni aradı`, tag: 'call-' + chId, ch: chId, from: s.by, dm: true });
}
function pushServers(names) {
  viewersCache.clear(); // izin değişmiş olabilir: listeyi baştan hesapla, aynı gönderimde tekrar kullan
  roomCheck();
  const rooms = io.sockets.adapter.rooms;
  for (const n of new Set(names)) if (rooms.has('user:' + n)) io.to('user:' + n).emit('servers', serversFor(n).map(s => serverView(s, n))); // çevrimdışı kişi için hesaplama (açık sunucuda herkes üye sayılır); tekrarlı isimler tek sefer
  if (voice.size) { const on = new Set(online.values()); voiceTo([...new Set(names)].filter(n => on.has(n))); } // erişim değişti: ses odaları da yeniden süzülsün
}
const membersOf = s => s.public ? Object.keys(db.users) : s.members;

// Normal mesajla aynı kurallar (zamanlanmış mesaj gibi socket 'message' dışından gelen yazılar için)
function postGate(me, chId, text) {
  if (!canAccess(me, chId)) return 'Bu odaya erişimin yok';
  if (chId.startsWith('dm:')) {
    if (dmPeers(chId).includes(BOT_NAME)) return 'Kanka Bot\'a buradan yazılamıyor';
    const other = dmPeers(chId).find(n => n !== me) || me;
    if (db.users[me]?.blocked?.includes(other)) return 'Bu kişiyi engelledin';
    if (db.users[other]?.blocked?.includes(me)) return 'Bu kişi sana mesaj alımını kapattı';
  }
  const f = isPrivateChat(chId) ? null : findChannel(chId); if (!f) return null;
  if (f.s.welcome?.enabled && f.s.owner !== me && !f.s.accepted?.[me]) return f.s.applications?.[me]?.st === 'bekliyor' ? 'Katılım başvurun yetkililerin onayını bekliyor' : 'Önce sunucu kurallarını kabul etmelisin';
  { const sb = secBlock(f.s, me); if (sb) return sb; }
  if (timedOut(f.s, me)) return 'Susturuldun';
  if (!chPerm(f.s, f.c, me, 'send')) return 'Bu odaya yazma iznin yok';
  if (/@(everyone|herkes)\b/i.test(text || '') && !chPerm(f.s, f.c, me, 'mention')) return '@herkes etiketleme iznin yok';
  return automod(f.s, chId, me, text) || null;
}
function postMessage(me, chId, p = {}) {
  const u = db.users[me];
  const msg = { id: id(), author: me, color: u.color, time: Date.now(), kind: 'text', reactions: {} };
  const kind = p.kind || 'text';
  if (p.scheduled) msg.scheduled = true;
  { const f0 = findChannel(chId); if (f0?.c?.type === 'forum' && p.title) msg.title = clean(p.title, 100); }
  if (p.xfrom && typeof p.xfrom === 'object') msg.xfrom = { server: clean(p.xfrom.server, 40), channel: clean(p.xfrom.channel, 30), icon: clean(p.xfrom.icon, 4), iconImg: UPLOAD_RE.test(p.xfrom.iconImg || '') ? p.xfrom.iconImg : null };
  if (p.fwd && typeof p.fwd === 'object') msg.fwd = { author: clean(p.fwd.author, 40) || null };

  if (kind === 'text' && p.enc) { msg.enc = p.enc; msg.fc = p.fc; }
  else if (kind === 'text') {
    msg.text = cleanMsg(p.text);
    if (p.image && UPLOAD_RE.test(p.image)) msg.image = p.image;
    if (Array.isArray(p.files)) { // yeni: bir mesajda en çok 10 dosya/resim (sadece kendi yüklediklerin)
      const fs_ = p.files.slice(0, 10).map(x => typeof x === 'string' && /^[a-f0-9]{24}$/.test(x) && db.files?.[x]).filter(f => f && f.owner === me);
      const ids = p.files.slice(0, 10).filter(x => typeof x === 'string' && db.files?.[x]?.owner === me);
      if (ids.length) msg.files = ids.map(x => { const f = db.files[x]; return { id: x, name: f.name, size: f.size, kind: f.kind, url: `/dosya/${x}/${encodeURIComponent(f.name)}` }; });
    }
    if (p.audio && AUDIO_RE.test(p.audio)) { msg.audio = p.audio; msg.duration = Math.min(Math.max(+p.duration || 0, 0), 600); }
    if (p.gif && typeof p.gif === 'object' && gifOk(p.gif.url)) msg.gif = { url: p.gif.url, prev: gifOk(p.gif.prev) ? p.gif.prev : p.gif.url, w: Math.min(Math.max(+p.gif.w || 0, 0), 2000), h: Math.min(Math.max(+p.gif.h || 0, 0), 2000), title: clean(p.gif.title, 80) };
    if (!msg.text && !msg.image && !msg.audio && !msg.files?.length && !msg.gif) return ({ error: 'Boş mesaj' });
    const srv = serverOf(chId);
    if (srv?.filter && msg.text) msg.text = filterText(msg.text);
  } else if (kind === 'plan') {
    const title = clean(p.title, 120); if (!title) return ({ error: 'Plan başlığı gerekli' });
    Object.assign(msg, { kind, plan: { title, when: clean(p.when, 80), going: [me] } });
  } else if (kind === 'poll') {
    const question = clean(p.question, 200);
    const options = (p.options || []).map(o => clean(o, 80)).filter(Boolean).slice(0, 8);
    if (!question || options.length < 2) return ({ error: 'Anket için soru ve en az 2 seçenek gerekli' });
    Object.assign(msg, { kind, poll: { question, options: options.map(text => ({ text, votes: [] })) } });
  } else if (kind === 'song') {
    const title = clean(p.title, 200); if (!title) return ({ error: 'Şarkı adı ya da linki gerekli' });
    const url = /^https?:\/\//i.test(title) ? title : 'https://www.youtube.com/results?search_query=' + encodeURIComponent(title);
    Object.assign(msg, { kind, song: { title, url, by: me } });
    (db.playlists[chId] ||= []).push({ id: msg.id, title, url, by: me, time: msg.time });
    io.to(chId).emit('playlist', { channelId: chId, playlist: db.playlists[chId] });
  } else if (kind === 'dice') {
    const n = Math.min(Math.max(parseInt(p.sides) || 6, 2), 100);
    Object.assign(msg, { kind, game: { sides: n, result: 1 + crypto.randomInt(n) } });
  } else if (kind === 'coin') {
    Object.assign(msg, { kind, game: { result: crypto.randomInt(2) ? 'Yazı' : 'Tura' } });
  } else if (kind === 'xox') {
    Object.assign(msg, { kind, game: { x: me, o: null, board: '.........', turn: 'x', winner: null } });
  } else return ({ error: 'Bilinmeyen mesaj türü' });

  if (p.replyTo) {
    const r = findMsg(chId, p.replyTo);
    if (r) msg.replyTo = { id: r.id, author: r.author, text: r.enc ? '' : (r.text || r.plan?.title || r.poll?.question || r.song?.title || 'görsel').slice(0, 100), enc: !!r.enc || undefined };
  }

  const list = (db.messages[chId] ||= []);
  list.push(msg);
  if (list.length > 2000) list.shift();
  // Bağlantı önizlemesi (YouTube zaten kendi kartıyla gösteriliyor)
  { const lu = msg.kind === 'text' && /https?:\/\/[^\s<>"']+/i.exec(msg.text || '')?.[0]?.replace(/[).,!?;:]+$/, '');
    const fe = lu && !msg.bot && !msg.wh ? findChannel(chId) : null;
    if (lu && !(fe && !chPerm(fe.s, fe.c, me, 'embed')) && !/(youtube\.com|youtu\.be)\//i.test(lu) && !/\/davet\/|[?&]davet=/i.test(lu)) linkPreview(lu).then(pv => { if (pv && findMsg(chId, msg.id)) { msg.preview = pv; save(); io.to(chId).emit('update', { channelId: chId, msg }); } }); }
  // Takip edilebilir duyuru odası: takipçi odalara kopyala
  { const f1 = p.xfrom || p.fwd ? null : findChannel(chId);
    if (f1?.c.news && f1.c.followers?.length) setTimeout(() => {
      f1.c.followers = f1.c.followers.filter(fw => { const d = findChannel(fw.c); return d && d.s.id === fw.s; });
      for (const fw of f1.c.followers) postMessage(me, fw.c, { kind: 'text', text: msg.text, image: msg.image, gif: msg.gif, xfrom: { server: f1.s.name, channel: f1.c.name, icon: f1.s.icon, iconImg: f1.s.iconImg } });
    }, 0); }

  // Seviye
  const before = level(u.xp);
  { const now = Date.now(), txt = String(msg.text || '').trim().toLocaleLowerCase('tr'), rich = !!(msg.image || msg.gif || msg.files?.length || msg.audio || msg.poll || msg.song || msg.plan);
    const real = rich || !!msg.enc || txt.replace(/\s+/g, '').length >= 3, fresh = !txt || txt !== u.xpLast;
    const srvCh = !chId.startsWith('dm:') && !chId.startsWith('g:'), f0 = srvCh ? findChannel(chId) : null, crowd = !srvCh || (f0 && membersOf(f0.s).length >= 3);
    if (real && fresh && crowd && now - (u.xpAt || 0) >= 60e3) { u.xpAt = now; addXp(me, 3 + Math.floor(Math.random() * 4), 'mesaj', f0?.s || null, chId); }
    if (txt) u.xpLast = txt.slice(0, 200); }
  if (!p.scheduled && !p.xfrom) statMsg(me, chId, msg.text);
  u.msgs = (u.msgs || 0) + 1; u.firstMsgAt ||= Date.now();
  const hr = new Date().getHours(); if (hr >= 0 && hr < 5) u.night = true;
  save();
  io.to(chId).emit('message', { channelId: chId, msg });
  io.to('user:' + me).emit('users', allUsers());

  if (level(u.xp) > before) pushUsers();

  // Bildirimler
  const where = chId.startsWith('dm:') ? 'özel mesaj' : chId.startsWith('g:') ? groupTitle(groupOf(chId)) : (() => { const f = findChannel(chId); return `${f.s.name} › ${f.c.name}`; })();
  const preview = msg.enc ? 'Yeni mesaj' : (msg.text || msg.plan?.title || msg.poll?.question || msg.song?.title || (msg.game ? 'bir oyun başlattı' : msg.files?.length ? (msg.files.every(f => f.kind === 'image') ? 'resim gönderdi' : 'dosya gönderdi: ' + msg.files[0].name) : 'görsel gönderdi')).slice(0, 120);
  if (isPrivateChat(chId)) {
    for (const n of chatMembers(chId)) {
      io.to('user:' + n).emit('dms', dmsFor(n));
      if (n !== me) notifyUser(n, { from: me, text: preview, channelId: chId, where, dm: true, e: msg.enc ? { id: msg.id, enc: msg.enc, fc: msg.fc, cid: db.e2e?.[chId]?.cid || undefined } : undefined }); // şifreliyse önizlemeyi alıcının cihazı açar
    }
  } else {
    const f = findChannel(chId);
    for (const n of membersOf(f.s)) if (n !== me && canAccess(n, chId)) {
      io.to('user:' + n).emit('chanActivity', { channelId: chId, serverId: f.s.id });
      const pr = prefsOf(db.users[n]);
      if ((pr.ch?.[chId] === 'all' || (pr.ch?.[chId] == null && pr.srv?.[f.s.id]?.lvl === 'all')) && !(pr.muted || []).includes(f.s.id) && seesChannel(f.s, f.c, n) && !(msg.text || '').includes('@' + n) && msg.replyTo?.author !== n)
        sendPush(n, { title: `${me} · #${f.c.name}`, body: (msg.text || (msg.files?.length ? 'dosya gönderdi' : 'görsel gönderdi')).slice(0, 160), tag: chId, ch: chId, from: me });
    }
    const noUrl = (msg.text || '').replace(/https?:\/\/\S+/g, ' '); // link içindeki @ad etiket sayılmaz
    // Kim nasıl bahsedildi: doğrudan > rol > @everyone. Kişi sunucu ayarında @everyone / rol bahsetmelerini bastırdıysa bildirim gitmez (Discord gibi)
    const how = new Map(); const put = (n, k) => { const o = { direct: 3, role: 2, everyone: 1 }; if ((o[k] || 0) > (o[how.get(n)] || 0)) how.set(n, k); };
    for (const m of noUrl.matchAll(/@([\p{L}\p{N}_.-]+)/gu)) put(m[1], 'direct');
    if (/@(everyone|herkes)\b/i.test(noUrl) && can(f.s, me, 'mentionEveryone')) { membersOf(f.s).forEach(n => put(n, 'everyone')); msg.everyone = true; }
    for (const r of f.s.customRoles || []) if (noUrl.includes('@' + r.name) && (r.mentionable !== false || can(f.s, me, 'mentionEveryone'))) for (const [n, rs] of Object.entries(f.s.memberRoles)) if (rs.includes(r.id)) put(n, 'role');
    const ra = msg.replyTo?.author; if (ra && ra !== me && !how.has(ra) && f.s.members.includes(ra)) how.set(ra, 'reply');
    for (const [n, k] of how) {
      if (n === me || !db.users[n] || !canAccess(n, chId)) continue;
      const sp = prefsOf(db.users[n]).srv?.[f.s.id] || {};
      if ((k === 'everyone' && sp.ev) || (k === 'role' && sp.rol)) continue;
      notifyUser(n, { from: me, text: preview, channelId: chId, where, mention: true, kind: k, mid: msg.id, sid: f.s.id });
    }
  }
  onbFlag(me, 'msg');
  return { ok: true, msg };
}

// ---------- Kapalı beta, davet kodları, bekleme listesi ----------
for (const k of ['codes', 'resets']) db[k] ||= {};
for (const k of ['waitlist', 'reports']) db[k] ||= [];
db.beta ||= { on: true, cap: 300 };
const CODES_PER_USER = 3;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i;
const userCount = () => Object.keys(db.users).filter(n => n !== 'Claude' && !db.users[n].bot).length;
const CODE_ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newCode(by, note = '') {
  let c; do { c = 'KNK-' + Array.from({ length: 6 }, () => CODE_ABC[crypto.randomInt(CODE_ABC.length)]).join(''); } while (db.codes[c]);
  db.codes[c] = { by, at: Date.now(), note };
  return c;
}
const normCode = c => String(c ?? '').trim().toUpperCase().replace(/\s+/g, '').replace(/^(KNK)?-?/, 'KNK-').slice(0, 10);
const codeFree = c => !!db.codes[c] && !db.codes[c].usedBy;
const betaFull = () => db.beta.on && userCount() >= (db.beta.cap || 300);
const betaInfo = () => ({ on: !!db.beta.on, full: betaFull(), left: db.beta.on ? Math.max(0, (db.beta.cap || 300) - userCount()) : null, waiting: db.waitlist.filter(w => !w.invited).length });
// Kayıt kapısı: beta açıksa geçerli kod ya da özel bir sunucunun davet linki gerekir
function betaGate(code, invite) {
  if (!db.beta.on) return { ok: true };
  if (betaFull()) return { error: 'Beta şu an dolu. Bekleme listesine yazıl, yer açılınca haber verelim.', full: true };
  const c = code && normCode(code);
  if (c && codeFree(c)) return { ok: true, code: c };
  if (c) return { error: db.codes[c] ? 'Bu davet kodu daha önce kullanılmış.' : 'Davet kodu geçersiz. Büyük harflerle tekrar dene.' };
  if (invite && (f => f && !f.s.public)(findInvite(invite))) return { ok: true, via: 'invite' };
  return { error: 'Kanka şu an kapalı betada. Kayıt için davet kodu gerekli.', needCode: true };
}
function myCodes(name) {
  const u = db.users[name]; if (!u) return [];
  const have = Object.values(db.codes).filter(c => c.by === name).length; for (let i = have; i < CODES_PER_USER; i++) newCode(name);
  return Object.entries(db.codes).filter(([, c]) => c.by === name).sort((a, b) => a[1].at - b[1].at).slice(-30)
    .map(([code, c]) => ({ code, usedBy: c.usedBy || null, usedAt: c.usedAt || null, note: c.note || '' }));
}

// ---------- E-posta (şifre sıfırlama, bekleme listesi davetleri) ----------
const MAIL_FILE = path.join(DATA_DIR, 'mail.json');
// ---- GIF (KLIPY ya da GIPHY; Tenor 30 Haziran 2026'da kapandı) ----
const GIF_FILE = path.join(DATA_DIR, 'gif.json');
let gifCfg = null; try { gifCfg = JSON.parse(fs.readFileSync(GIF_FILE, 'utf8')); } catch {}
if (!gifCfg?.key && process.env.KLIPY_KEY) gifCfg = { provider: 'klipy', key: process.env.KLIPY_KEY };
if (!gifCfg?.key && process.env.GIPHY_KEY) gifCfg = { provider: 'giphy', key: process.env.GIPHY_KEY };
const gifHosts = new Set(gifCfg?.hosts || []);
const gifCache = new Map();
const gifReady = () => !!gifCfg?.key;
const gifSaveCfg = () => { try { fs.writeFileSync(GIF_FILE, JSON.stringify({ ...gifCfg, hosts: [...gifHosts].slice(0, 40) })); } catch {} };
function gifNorm(provider, j) {
  const out = [];
  if (provider === 'giphy') {
    for (const g of j?.data || []) {
      const im = g.images || {}, full = im.downsized_medium || im.original || im.downsized, prev = im.fixed_width || im.fixed_width_downsampled || full;
      if (!full?.url) continue;
      out.push({ id: 'g' + g.id, url: full.url, prev: prev.webp || prev.url, w: +full.width || 0, h: +full.height || 0, title: String(g.title || '').slice(0, 80) });
    }
    return { items: out, next: (j?.pagination?.offset || 0) + (j?.pagination?.count || 0) < (j?.pagination?.total_count || 0) };
  }
  const list = Array.isArray(j?.data?.data) ? j.data.data : Array.isArray(j?.data) ? j.data : [];
  for (const g of list) {
    const f = g.file || g.files; if (!f || g.type === 'ad') continue;
    const pick = (...ks) => { for (const k of ks) { const [a, b] = k.split('.'); if (f[a]?.[b]?.url) return f[a][b]; } return null; };
    const full = pick('md.gif', 'hd.gif', 'sm.gif'), prev = pick('sm.webp', 'sm.gif', 'xs.webp', 'xs.gif', 'md.webp') || full;
    if (!full) continue;
    out.push({ id: 'k' + (g.slug || g.id), url: full.url, prev: prev.url, w: +full.width || 0, h: +full.height || 0, title: String(g.title || '').slice(0, 80) });
  }
  return { items: out, next: !!(j?.data?.has_next ?? list.length >= 24) };
}
async function gifFetch(q, page = 1, who = '') {
  if (!gifReady()) return { error: 'GIF henüz açılmadı' };
  q = String(q || '').trim().slice(0, 60); page = Math.min(Math.max(+page || 1, 1), 10);
  const key = gifCfg.provider + '|' + q.toLocaleLowerCase('tr') + '|' + page;
  const hit = gifCache.get(key); if (hit && Date.now() - hit.at < (q ? 15 : 5) * 60e3) return hit.v;
  let url;
  if (gifCfg.provider === 'giphy') {
    const u = new URL('https://api.giphy.com/v1/gifs/' + (q ? 'search' : 'trending'));
    u.search = new URLSearchParams({ api_key: gifCfg.key, limit: '24', offset: String((page - 1) * 24), rating: 'pg-13', lang: 'tr', bundle: 'messaging_non_clips', ...(q ? { q } : {}) }); url = u;
  } else {
    const u = new URL(`https://api.klipy.com/api/v1/${encodeURIComponent(gifCfg.key)}/gifs/${q ? 'search' : 'trending'}`);
    u.search = new URLSearchParams({ per_page: '24', page: String(page), locale: 'tr', content_filter: 'medium', customer_id: crypto.createHash('sha256').update('kanka:' + who).digest('hex').slice(0, 24), ...(q ? { q } : {}) }); url = u;
  }
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000), headers: { Accept: 'application/json' } });
    if (r.status === 401 || r.status === 403) return { error: 'GIF anahtarı geçersiz', bad: true };
    if (!r.ok) return { error: 'GIF servisi şu an cevap vermiyor' };
    const v = gifNorm(gifCfg.provider, await r.json());
    let grew = false; for (const it of v.items) for (const x of [it.url, it.prev]) { try { const h = new URL(x).hostname; if (!gifHosts.has(h)) { gifHosts.add(h); grew = true; } } catch {} }
    if (grew) gifSaveCfg();
    gifCache.set(key, { at: Date.now(), v }); if (gifCache.size > 300) gifCache.delete(gifCache.keys().next().value);
    return v;
  } catch { return { error: 'GIF servisine ulaşılamadı' }; }
}
const gifOk = x => { try { const u = new URL(String(x || '')); return u.protocol === 'https:' && gifHosts.has(u.hostname) && x.length < 500; } catch { return false; } };

let mailCfg = null; try { mailCfg = JSON.parse(fs.readFileSync(MAIL_FILE, 'utf8')); } catch {}
if (!mailCfg && process.env.SMTP_USER) mailCfg = { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS, host: process.env.SMTP_HOST || '', url: process.env.PUBLIC_URL || '' };
let mailer = null;
function getMailer() {
  if (!mailCfg?.user || !mailCfg?.pass) return null;
  if (mailer) return mailer;
  try {
    const nm = require('nodemailer');
    const tmo = { connectionTimeout: 15e3, greetingTimeout: 10e3, socketTimeout: 25e3 }; // takılırsa dakikalarca beklemesin, hatayı hemen görelim
    mailer = nm.createTransport(mailCfg.host ? { host: mailCfg.host, port: +mailCfg.port || 465, secure: (+mailCfg.port || 465) === 465, auth: { user: mailCfg.user, pass: mailCfg.pass }, ...tmo }
      : { service: 'gmail', auth: { user: mailCfg.user, pass: mailCfg.pass }, ...tmo });
  } catch (e) { console.error('E-posta modülü yüklenemedi:', e.message); return null; }
  return mailer;
}
// Linkler istekteki adrese göre değil, yönetimin kaydettiği adrese göre kurulur (link zehirlemesine karşı)
const baseUrl = () => ((mailCfg?.url && !/sslip\.io|\/\/\d+\.\d+\.\d+\.\d+/.test(mailCfg.url) ? mailCfg.url : '') || process.env.PUBLIC_URL || 'https://kankahq.com').replace(/\/+$/, '');
const mailHtml = (title, body, btn, url) => `<!doctype html><html><body style="margin:0;background:#17120f;font-family:Segoe UI,Arial,sans-serif;color:#f3e9e1">
<div style="max-width:480px;margin:0 auto;padding:36px 22px"><div style="font-size:22px;font-weight:800;color:#ff8a4c;margin-bottom:22px">🦝 Kanka Chat</div>
<div style="background:#231b17;border:1px solid #3a2e27;border-radius:20px;padding:28px"><h1 style="font-size:20px;margin:0 0 12px">${title}</h1><div style="font-size:15px;line-height:1.6;color:#d8c9bd">${body}</div>
${btn ? `<a href="${url}" style="display:inline-block;margin-top:22px;background:#ff8a4c;color:#1b130f;font-weight:800;text-decoration:none;padding:13px 22px;border-radius:12px">${btn}</a>` : ''}</div>
<p style="font-size:12px;color:#8c7b6f;margin-top:18px">Bu e-postayı Kanka Chat gönderdi. Sen istemediysen görmezden gelebilirsin.</p></div></body></html>`;
// E-posta sağlığı: son başarı/hata yönetim panelinde görünür, bozulunca yöneticilere haber gider
const mailHealth = { lastOk: 0, lastErr: '', lastErrAt: 0, warned: 0 };
const maskMail = e => String(e || '').replace(/^(.{2}).*(@.*)$/, '$1•••$2');
function mailLog(to, kind, ok, err) { db.mailLog ||= []; db.mailLog.push({ at: Date.now(), to: maskMail(to), kind, ok, err: err ? String(err).slice(0, 160) : undefined }); if (db.mailLog.length > 60) db.mailLog.splice(0, db.mailLog.length - 60); }
const mailDown = () => mailHealth.lastErrAt > mailHealth.lastOk && Date.now() - mailHealth.lastErrAt < 20 * 60e3;
async function sendMail(to, subject, html, attachments, kind = 'diğer') {
  const t = getMailer(); if (!t) return false;
  try { await t.sendMail({ from: `"Kanka Chat" <${mailCfg.from || mailCfg.user}>`, to, subject, html, ...(attachments ? { attachments } : {}) }); mailHealth.lastOk = Date.now(); mailLog(to, kind, true); save(); return true; }
  catch (e) {
    console.error('E-posta gönderilemedi:', e.message); mailHealth.lastErr = e.message; mailHealth.lastErrAt = Date.now(); mailLog(to, kind, false, e.message); save();
    if (/535|BadCredentials|Invalid login|Username and Password not accepted/i.test(e.message) && mailCfg) { mailCfg.ok = false; try { fs.writeFileSync(MAIL_FILE, JSON.stringify(mailCfg)); } catch {} }
    if (Date.now() - mailHealth.warned > 30 * 60e3) { mailHealth.warned = Date.now(); secLog('eposta-hatasi', 'sistem', e.message.slice(0, 120)); for (const n of siteAdmins()) io.to('user:' + n).emit('toast', '⚠️ E-posta gönderilemiyor (şifre sıfırlama çalışmıyor). Yönetim → E-posta\'ya bak.'); }
    return false;
  }
}
const findUserBy = who => { who = clean(who, 190).toLowerCase(); return who && (Object.values(db.users).find(u => !u.bot && u.name.toLowerCase() === who || (u.email && u.email === who)) || Object.values(db.users).find(u => (u.oldNames || []).some(o => o.n.toLowerCase() === who && Date.now() - o.at < NAME_HOLD))); }; // eski adla da giriş (ayrılma süresi içinde)
// ---------- Kullanıcı adı değiştirme ----------
const NAME_HOLD = 14 * 864e5, NAME_COOLDOWN = 7 * 864e5;
const RESERVED_NAMES = ['kanka', 'kanka bot', 'kankabot', 'claude', 'admin', 'yonetim', 'yönetim', 'destek', 'sistem'];
// Ad kullanılabilir mi? (başkasının adı, ayrılmış bir eski ad ya da sistem adı olamaz)
function nameTaken(name, self) {
  const k = name.toLowerCase();
  if (RESERVED_NAMES.includes(k)) return true;
  return Object.values(db.users).some(u => u.name !== self && (u.name.toLowerCase() === k || (u.oldNames || []).some(o => o.n.toLowerCase() === k && Date.now() - o.at < NAME_HOLD)));
}
// Ad, verinin her yerinde değişir: üyelikler, roller, mesaj yazarları, arkadaşlar, DM odaları (dm:a|b), oturumlar…
// Mesaj metinleri, başlıklar gibi serbest yazılara dokunulmaz.
const NAME_FIELDS = new Set(['author', 'by', 'owner', 'target', 'addedBy', 'from', 'to', 'with', 'n', 'x', 'o', 'usedBy', 'invitedBy', 'claimedBy', 'host', 'winner', 'user', 'who', 'mod', 'actor']);
const NAME_SKIP = new Set(['text', 'title', 'bio', 'status', 'note', 'reason', 'question', 'desc', 'description', 'topic', 'hash', 'salt', 'email', 'enc', 'fc', 'url', 'emojis', 'emojiMeta', 'push', 'wrapped', 'pub', 'preview', 'cid', 'oldNames', 'secLog', 'backupLog', 'waitlist']);
function renameUser(old, nw) {
  const u = db.users[old]; if (!u || db.users[nw]) return false;
  const fixDm = v => { const m = /^(call:)?dm:(.+)$/.exec(v); if (!m) return v; const p = m[2].split('|'); return p.includes(old) ? (m[1] || '') + dmId(...p.map(x => x === old ? nw : x)) : v; };
  for (const [k, c] of Object.entries(db.e2e || {})) if (k.startsWith('dm:') && dmPeers(k).includes(old)) c.cid ||= k; // şifreleme, sohbetin ilk kimliğine bağlı kalır
  delete db.users[old]; db.users[nw] = u; u.name = nw;
  const seen = new Set();
  const walk = x => {
    if (!x || typeof x !== 'object' || seen.has(x)) return; seen.add(x);
    if (Array.isArray(x)) { for (let i = 0; i < x.length; i++) { const v = x[i]; if (v === old) x[i] = nw; else if (typeof v === 'string') { if (v.includes('dm:')) x[i] = fixDm(v); } else walk(v); } return; }
    for (const k of Object.keys(x)) {
      if (NAME_SKIP.has(k)) continue;
      const v = x[k];
      if (v === old && NAME_FIELDS.has(k)) x[k] = nw;
      else if (typeof v === 'string') { if (/^(call:)?dm:/.test(v)) x[k] = fixDm(v); }
      else walk(v);
      const nk = k === old ? nw : k === 'u:' + old ? 'u:' + nw : k === 'user:' + old ? 'user:' + nw : /^(call:)?dm:/.test(k) ? fixDm(k) : k;
      if (nk !== k) { if (!Object.hasOwn(x, nk)) x[nk] = x[k]; delete x[k]; }
    }
  };
  for (const [k, v] of Object.entries(db)) if (k !== 'sessions' && k !== 'sessAt') walk(v);
  for (const [h, n] of Object.entries(db.sessions)) if (n === old) db.sessions[h] = nw;
  for (const r of Object.values(db.resets || {})) if (r.name === old) r.name = nw;
  for (const w of db.waitlist || []) if (w.name === old) w.name = nw;
  (u.oldNames ||= []).push({ n: old, at: Date.now() }); if (u.oldNames.length > 10) u.oldNames.shift();
  u.renamedAt = Date.now();
  save();
  // açık olan her yerde yeni adla yeniden bağlansın
  io.to('user:' + old).emit('renamed', { from: old, to: nw });
  setTimeout(() => io.in('user:' + old).disconnectSockets(true), 1500);
  pushUsers(); pushPresence();
  for (const sv of db.servers) if (sv.members.includes(nw)) pushServers(sv.members);
  const peers = new Set(); for (const k of Object.keys(db.messages)) if (k.startsWith('dm:') && dmPeers(k).includes(nw)) dmPeers(k).forEach(n => peers.add(n));
  for (const g of Object.values(db.groups || {})) if (g.members.includes(nw)) g.members.forEach(n => peers.add(n));
  for (const n of peers) if (n !== nw) { io.to('user:' + n).emit('dms', dmsFor(n)); io.to('user:' + n).emit('social', social(n)); io.to('user:' + n).emit('userRenamed', { from: old, to: nw }); }
  return true;
}
// ---------- Yaş kontrolü (kayıtta doğum tarihi zorunlu, 13 yaş altı hesap açamaz) ----------
const needAge = u => !!u && (!u.dob || !!u.ageLock);
// 18 yaş altı: kayıtta ve sonradan bir kez "velimin bilgisi ve izniyle kullanıyorum" onayı alınır, tarihiyle saklanır
const isMinor = u => { const a = ageOf(u?.dob); return a !== null && a < 18; };
const needVeli = u => isMinor(u) && !u.guardian;
const AGE_FREE = new Set(['disconnect', 'auth', 'login', 'logout', 'setDob', 'vis', 'register', 'resetPw', 'forgot', 'checkReset', 'betaInfo', 'checkCode', 'waitlist']);
function ageOf(dob) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dob || '')); if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2], +m[3]], dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d || y < 1900) return null;
  const now = new Date(Date.now() + 3 * 3600e3), ny = now.getUTCFullYear(), nm = now.getUTCMonth() + 1, nd = now.getUTCDate();
  const age = ny - y - (nm < mo || (nm === mo && nd < d) ? 1 : 0);
  return age >= 0 && age < 130 ? age : null;
}
// 18+ kuralı döneminde kilitlenen hesaplar 13+ kuralında doğum tarihini yeniden girebilsin
if (!db.ageRuleV2) { for (const u of Object.values(db.users)) if (u?.ageLock) delete u.ageLock; db.ageRuleV2 = 1; save(); }
function resetToken(name, hours) {
  for (const [t, r] of Object.entries(db.resets)) if (r.exp < Date.now()) delete db.resets[t];
  const mine = Object.entries(db.resets).filter(([, r]) => r.name === name).sort((a, b) => a[1].exp - b[1].exp);
  while (mine.length >= 3) delete db.resets[mine.shift()[0]]; // en fazla 3 geçerli link: son gelen e-postalardan hangisine basılırsa çalışsın
  const t = crypto.randomBytes(24).toString('hex'); db.resets[tokH(t)] = { name, exp: Date.now() + hours * 3600e3 }; save();
  return t;
}
async function sendInviteMail(email, code) {
  return sendMail(email, 'Kanka Chat davetin geldi 🎉', mailHtml('Sıra sende kanka!', `Bekleme listesinden çıktın. Davet kodun: <b style="font-size:18px;color:#fff;letter-spacing:1px">${code}</b><br><br>Aşağıdaki butona basınca kod otomatik yazılır.`, 'Hesabımı oluştur', `${baseUrl()}/kod/${code}`));
}

// ---------- Şikayetler ----------
const REPORT_REASONS = { spam: 'Spam ya da reklam', taciz: 'Taciz veya zorbalık', nefret: 'Nefret söylemi', cinsel: 'Cinsel içerik', siddet: 'Şiddet ya da tehdit', dolandir: 'Dolandırıcılık', cocuk: 'Çocuk güvenliği', taklit: 'Başkasını taklit', diger: 'Diğer' };
const siteAdmins = () => { const s1 = db.servers.find(x => x.id === 's1')?.owner; return [...new Set([s1, ...coOwnerNames(), ...Object.keys(db.staff || {}).filter(n => db.staff[n]?.rank === 'owner'), ...(db.siteAdmins || [])].filter(Boolean))]; };
const srvOf = id => id && db.servers.find(x => x.id === id);
const reportVisible = (r, n) => siteMod(n) || (!!r.serverId && !!srvOf(r.serverId) && isMod(srvOf(r.serverId), n));
function reportCounts(n) {
  const open = db.reports.filter(r => r.status === 'open');
  const out = { site: siteMod(n) ? open.length : 0, servers: {} };
  for (const r of open) if (r.serverId && srvOf(r.serverId) && isMod(srvOf(r.serverId), n)) out.servers[r.serverId] = (out.servers[r.serverId] || 0) + 1;
  return out;
}
function pushReports(r) {
  const who = new Set(staffList());
  const s = srvOf(r.serverId); if (s) for (const n of s.members.concat(s.owner || [])) if (isMod(s, n)) who.add(n);
  for (const n of who) io.to('user:' + n).emit('reportCounts', reportCounts(n));
  return who;
}
const reportView = (r, n) => ({ ...r, by: siteAdmin(n) ? r.by : null, reasonText: REPORT_REASONS[r.reason] || r.reason, serverName: srvOf(r.serverId)?.name || null, targetGone: !db.users[r.target], targetBanned: !!db.users[r.target]?.siteBan,
  msgAlive: r.msg ? !!findMsg(r.chId, r.msg.id) : null, priors: db.reports.filter(x => x.target === r.target && x.id !== r.id).length });
function siteBanUser(name, by, reason, until) {
  const u = db.users[name]; if (!u) return false;
  u.siteBan = { by, at: Date.now(), reason: clean(reason, 160), ...(until ? { until } : {}), devs: (u.idSeen?.d || []).map(x => x.h), ips: (u.idSeen?.i || []).map(x => x.h) };
  staffLog(by, until ? 'Askıya aldı' : 'Hesabı kapattı', name, (until ? (h => h < 24 ? `${h} saat · ` : `${Math.round(h / 24)} gün · `)(Math.round((until - Date.now()) / 3600e3)) : '') + clean(reason, 160));
  sessDelUser(name); setTimeout(() => io.in('user:' + name).disconnectSockets(true), 300); // açık bağlantılar da kapansın
  for (const s of db.servers) voiceKick(s.channels.map(c => c.id), name, 'Hesabın kapatıldı');
  io.to('user:' + name).emit('siteBanned', u.siteBan.reason);
  setTimeout(() => io.in('user:' + name).disconnectSockets(true), 300);
  save(); return true;
}
function siteWarnUser(name, by, reason) {
  const u = db.users[name]; if (!u) return null;
  const w = { id: id(), at: Date.now(), by, reason: clean(reason, 300) || 'Kurallara uymayan davranış', seen: false };
  (u.siteWarns ||= []).push(w); if (u.siteWarns.length > 50) u.siteWarns.shift();
  staffLog(by, 'Uyardı', name, w.reason);
  io.to('user:' + name).emit('siteWarn', { id: w.id, at: w.at, reason: w.reason, count: u.siteWarns.length });
  save(); return w;
}
const banText = u => (u.siteBan?.until ? `Bu hesap ${new Date(u.siteBan.until).toLocaleString('tr-TR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Istanbul' })} tarihine kadar askıya alındı.` : 'Bu hesap Kanka Chat kurallarını ihlal ettiği için kapatıldı.') + (u.siteBan?.reason ? ` Sebep: ${u.siteBan.reason}` : '') + ' Hata olduğunu düşünüyorsan kankahq1@gmail.com adresine yaz.';
// ---- Yan hesap engeli: askıya alınan/kapatılan kişinin cihazı ve bağlantısı ----
// Ham IP ya da cihaz kimliği saklanmaz; sunucuya özel anahtarla özetlenir (geri çevrilemez). Kişi başı son 8 cihaz/bağlantı.
const idH = x => x ? crypto.createHmac('sha256', (db.idKey ||= crypto.randomBytes(24).toString('hex'))).update(String(x)).digest('hex').slice(0, 20) : null;
const IP_BAN_MS = 864e5; // bağlantı (IP) eşleşmesi en çok 24 saat: mobil operatörde yüzlerce kişi aynı IP'yi paylaşır, masumlar uzun süre engellenmesin
function seenAdd(u, dH, iH) {
  const s = (u.idSeen ||= { d: [], i: [] }), now = Date.now();
  for (const [k, v] of [['d', dH], ['i', iH]]) if (v) { s[k] = s[k].filter(x => x.h !== v && now - x.at < 90 * 864e5); s[k].unshift({ h: v, at: now }); s[k] = s[k].slice(0, 8); }
}
// Bu cihaz/bağlantı askıdaki başka bir hesaba ait mi? (dev: cihaz eşleşmesi girişi de engeller, ip: sadece yeni kayıt)
function evasionOf(dH, iH, self) {
  const now = Date.now();
  for (const u of Object.values(db.users)) {
    if (u.name === self || !u.siteBan || !isBanned(u)) continue;
    const b = u.siteBan, devs = b.devs || (u.idSeen?.d || []).map(x => x.h), ips = b.ips || (u.idSeen?.i || []).map(x => x.h);
    if (dH && devs.includes(dH)) return { u, by: 'dev' };
    if (iH && ips.includes(iH) && now - (b.at || 0) < IP_BAN_MS) return { u, by: 'ip' };
  }
  return null;
}
const evadeText = (u, by = 'dev') => by === 'ip' ? 'Bu bağlantıdan kısa süre önce Kanka\'dan uzaklaştırılan bir hesap kullanılmış. Yeni hesap açmak için biraz bekle ya da farklı bir bağlantı dene; hata olduğunu düşünüyorsan bize yaz.' : u.siteBan?.until ? `Bu cihazda ${new Date(u.siteBan.until).toLocaleString('tr-TR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Istanbul' })} tarihine kadar askıya alınmış bir hesap var. Askı bitene kadar başka hesapla giriş yapılamaz.` : 'Bu cihazda Kanka Chat\'ten uzaklaştırılmış bir hesap var, başka hesapla giriş yapılamaz.';
// Gmail'de nokta ve +etiket aynı kutuya gider: aynı adresle ikinci hesap açılmasın
const mailKey = e => { const [a, d] = String(e || '').toLowerCase().split('@'); if (!d) return e; const dd = d === 'googlemail.com' ? 'gmail.com' : d; return (dd === 'gmail.com' ? a.split('+')[0].replace(/\./g, '') : a.split('+')[0]) + '@' + dd; };
// Aynı cihazı ya da bağlantıyı kullanmış diğer hesaplar (ekip görür)
function linkedOf(u) {
  const d = new Set((u.idSeen?.d || []).map(x => x.h)), i = new Set((u.idSeen?.i || []).map(x => x.h)), out = [];
  for (const o of Object.values(db.users)) { if (o === u || o.bot) continue; const sd = (o.idSeen?.d || []).some(x => d.has(x.h)), si = (o.idSeen?.i || []).some(x => i.has(x.h)); if (sd || si) out.push({ name: o.name, cihaz: sd, ag: si, askida: !!o.siteBan && isBanned(o) }); }
  return out.slice(0, 20);
}

setInterval(() => { // eski şikayetleri ve süresi dolan sıfırlama linklerini temizle (gizlilik politikasında yazan süreler)
  const lim = Date.now() - 730 * 864e5; db.reports = db.reports.filter(r => r.at > lim);
  for (const [t, r] of Object.entries(db.resets)) if (r.exp < Date.now()) delete db.resets[t];
}, 6 * 3600e3);

// ---------- Hesap silme (KVKK) ----------
function deleteUserData(name) {
  STAT.wipe(name); tasteCache.delete(name);
  for (const [fid, f] of Object.entries(db.files || {})) if (f.owner === name) { try { fs.unlinkSync(path.join(FILES, fid)); } catch {} delete db.files[fid]; }
  for (const s of [...db.servers]) {
    if (s.owner === name && !s.public) {
      const rank = n => roleOf(s, n) === 'admin' ? 0 : roleOf(s, n) === 'mod' ? 1 : 2;
      const heir = s.members.filter(n => n !== name && db.users[n]).sort((a, b) => rank(a) - rank(b) || (s.joinedAt?.[a] || 0) - (s.joinedAt?.[b] || 0))[0];
      if (heir) { s.owner = heir; delete s.roles[heir]; audit(s, 'Kanka', 'Sahiplik devredildi (hesap silindi)', heir); io.to('user:' + heir).emit('toast', `${s.name} sunucusunun sahibi artık sensin`); }
      else { for (const c of s.channels) delete db.messages[c.id]; db.servers.splice(db.servers.indexOf(s), 1); continue; }
    }
    s.members = (s.members || []).filter(n => n !== name);
    delete s.roles?.[name]; delete s.memberRoles?.[name]; delete s.joinedAt?.[name]; delete s.accepted?.[name];
    voiceKick(s.channels.map(c => c.id), name, 'Hesap silindi');
  }
  for (const k of Object.keys(db.messages)) {
    if (k.startsWith('dm:') && dmPeers(k).includes(name)) { delete db.messages[k]; continue; }
    db.messages[k] = db.messages[k].filter(m => m.author !== name);
  }
  for (const g of Object.values(db.groups || {})) g.members = g.members.filter(n => n !== name);
  for (const u of Object.values(db.users)) for (const f of ['friends', 'reqIn', 'reqOut', 'blocked']) if (Array.isArray(u[f])) u[f] = u[f].filter(n => n !== name);
  sessDelUser(name); setTimeout(() => io.in('user:' + name).disconnectSockets(true), 300);
  for (const [c, x] of Object.entries(db.codes)) if (x.by === name && !x.usedBy) delete db.codes[c];
  const em = db.users[name]?.email; if (em) db.waitlist = db.waitlist.filter(w => w.email !== em);
  for (const a of Object.values(db.apps || {})) if (a.owner === name) appRemove(a);
  for (const [t, r] of Object.entries(db.playSubs || {})) if (r.u === name) delete db.playSubs[t]; // Google Play aboneliğini kullanıcı Play'den iptal eder
  delete db.users[name];
  save();
}

// ---------- Sürüm takibi: sayfa değişince açık olan herkese "yenile" uyarısı ----------
const INDEX = path.join(__dirname, 'public', 'index.html');
let build = '';
// içerik özeti: güncelleyici her seferinde tüm dosyaları yeniden yazdığı için tarih değil içerik bakılır;
// böylece sadece uygulamanın kendisi değişince "yenile" uyarısı çıkar (karşılama sayfası vb. değişince çıkmaz)
const readBuild = () => { try { return crypto.createHash('sha1').update(fs.readFileSync(INDEX)).digest('hex').slice(0, 12); } catch { return ''; } };
build = readBuild();
// Görünüm (stil) ve kod ayrı özetlenir: sadece stil değiştiyse açık sayfalar yenilenmeden yeni görünümü alır
const sh = x => crypto.createHash('sha1').update(x).digest('hex').slice(0, 12);
const readParts = () => { try { const t = fs.readFileSync(INDEX, 'utf8'), m = t.match(/<style[^>]*>([\s\S]*?)<\/style>/); return { b: sh(t), css: sh(m ? m[1] : ''), js: sh(m ? t.replace(m[0], '') : t), major: /<meta name="kanka-buyuk" content="([^"]+)"/.exec(t)?.[1] || null }; } catch { return null; } };
let buildParts = readParts();
let buildTimer = null;
try {
  fs.watch(path.dirname(INDEX), (ev, file) => { if (file && file !== 'index.html') return; clearTimeout(buildTimer); buildTimer = setTimeout(() => { const b = readBuild(); if (b && b !== build) { build = b; buildParts = readParts(); io.emit('build', build); if (buildParts) io.emit('buildParts', buildParts); } }, 25000); }); // güncelleyici dosyaları yazıp sunucuyu yeniden başlatır: "yenile" uyarısı yeni sunucu açıldıktan sonra (yeniden bağlanınca) gelsin, kapanırken basılıp boş ekranda kalınmasın
} catch {}

// =====================================================================
// ---------- Kanka Bot API: geliştiricilerin kendi botları ----------
// Uygulama (db.apps) + bot hesabı (db.users[ad].bot) · Gateway (WebSocket /bot/gateway) · REST (/api/v1) · komutlar ve etkileşimler
// Doğrulanmamış bir bot en fazla REACH_MAX farklı kişiye ulaşabilir; fazlası için Kanka ekibinin onayı (doğrulama) gerekir.
// =====================================================================
const REACH_MAX = 50, APP_MAX = 5, CMD_MAX = 50, INTER_TTL = 15 * 60e3, INTER_WAIT = 3000;
const BOT_INTENTS = ['mesajlar', 'icerik', 'uyeler', 'tepkiler', 'dm', 'ses'];
const OPT_TYPES = ['yazi', 'sayi', 'tamsayi', 'kisi', 'oda', 'rol', 'evethayir'];
const BTN_STYLES = ['ana', 'ikincil', 'basari', 'tehlike', 'link'];
const BOT_PERMS = PERMS.filter(p => p !== 'administrator'); // yönetici yetkisi bota verilmez, sunucu sahibi isterse rolü elle yükseltir
const isBotUser = n => !!db.users[n]?.bot;
const appOf = n => db.apps?.[db.users[n]?.bot?.app] || null;
const appTokH = t => crypto.createHash('sha256').update('kbot|' + t).digest('hex');
const appByToken = t => { if (typeof t !== 'string' || t.length < 30 || t.length > 120) return null; const h = appTokH(t); return Object.values(db.apps || {}).find(a => a.tokenH && a.tokenH.length === h.length && crypto.timingSafeEqual(Buffer.from(a.tokenH), Buffer.from(h))) || null; };
const devOk = n => !!db.users[n] && (db.devApps?.[n]?.status === 'accepted' || !!db.users[n].devBeta || siteAdmin(n));
const botServers = a => db.servers.filter(s => !s.public && s.members.includes(a.bot));
const humans = list => list.filter(n => db.users[n] && !db.users[n].bot && n !== 'Claude' && n !== BOT_NAME);
function reachOf(a, extra) { const set = new Set(); for (const s of botServers(a)) humans(s.members).forEach(n => set.add(n)); if (extra) humans(extra.members).forEach(n => set.add(n)); return set.size; }
const contentOk = a => !a.verified || !!a.contentOk; // küçük (doğrulanmamış) botlar içeriği görebilir; büyüyenler için onay gerekir
function appView(a, full) {
  const u = db.users[a.bot] || {};
  const v = { id: a.id, kullaniciId: uidOf(db.users[a.bot]), ad: a.bot, gorunenAd: u.displayName || a.name, aciklama: a.desc || '', avatar: u.avatar || null, sahip: a.owner, dogrulandi: !!a.verified, olusturuldu: a.createdAt, listede: !!(a.listed && a.verified), eklemeLinki: baseUrl() + '/bot-ekle/' + a.id };
  if (!full) return v;
  return { ...v, emojiler: Object.entries(a.emojis || {}).map(([ad, url]) => ({ ad, url })), tokenVar: !!a.tokenH, tokenAt: a.tokenAt || null, gizlilik: a.privacy || '', etkilesimUrl: a.interUrl || '', dmIzin: a.dmOk !== false, kapali: a.killed || null,
    erisim: reachOf(a), esik: REACH_MAX, sunucular: botServers(a).map(s => ({ id: s.id, ad: s.name, uye: humans(s.members).length })),
    dogrulama: a.verifyReq || null, icerikIzni: contentOk(a), komutlar: (a.cmds || []).length, istatistik: appStatsOut(a), cevrimici: botConnsOf(a.id).length > 0,
    sirIpucu: a.secret ? a.secret.slice(0, 6) + '…' : null };
}
function appStatsOut(a) { const st = a.stats || {}, d = ymd(); return { komutToplam: st.cmds || 0, komutBugun: st.day?.[d] || 0, kullanan: (st.users || []).length, gun: Object.entries(st.day || {}).slice(-14) }; }
function appCount(a, user) { // komut sayaçları: geliştirici rozeti için kendi denemeleri sayılmaz
  const st = (a.stats ||= {}), d = ymd(); st.cmds = (st.cmds || 0) + 1; (st.day ||= {})[d] = (st.day[d] || 0) + 1;
  for (const k of Object.keys(st.day)) if (k < ymd(Date.now() - 30 * 864e5)) delete st.day[k];
  if (user !== a.owner) { if (!(st.users ||= []).includes(user)) { st.users.push(user); if (st.users.length > 5000) st.users.shift(); } st.cmdsOther = (st.cmdsOther || 0) + 1; devStatsSync(a.owner); }
}
function devStatsSync(owner) {
  const u = db.users[owner]; if (!u) return; const mine = Object.values(db.apps || {}).filter(a => a.owner === owner);
  const srv = new Set(); for (const a of mine) for (const s of botServers(a)) if (s.owner !== owner) srv.add(s.id);
  u.devStats = { servers: srv.size, cmds: mine.reduce((t, a) => t + (a.stats?.cmdsOther || 0), 0) }; // kendi sunucuları ve kendi denemeleri sayılmaz
  devCheck(owner);
}
const noPing = t => String(t || '').replace(/@(everyone|here|herkes)/gi, '@​$1');
// ---- Mesaj içeriği: kartlar (embed) ve bileşenler (buton / seçim menüsü) ----
const hexColor = c => Number.isInteger(c) ? '#' + (c >>> 0 & 0xffffff).toString(16).padStart(6, '0') : /^#[0-9a-f]{6}$/i.test(c || '') ? c : null;
const httpsUrl = u => typeof u === 'string' && /^https:\/\/[^\s<>"']{4,400}$/i.test(u) ? u : null;
// Kart resmi: https adresi ya da Kanka'ya yüklenmiş bir dosya (kimliği, /dosya/... adresi, "dosya:kimlik" ya da "attachment://kimlik").
// Bot önce POST /dosyalar ile yükleyip dönen id/url'yi kartta kullanabilir (Discord'daki attachment:// gibi).
let embedWarn = null, embedFiles = [], embedUsed = new Set(); // embedFiles: bu mesajın ekleri (attachment://dosya.png ile adla kullanılabilir)
function cardImg(u, alan) {
  if (u == null || u === '') return null;
  if (typeof u === 'string') {
    const an = u.match(/^attachment:\/\/(.+)$/)?.[1] ?? (/^[^/:]+\.(png|jpe?g|gif|webp)$/i.test(u) ? u : null); // Discord alışkanlığı: ekteki dosyanın adı
    if (an && !/^[a-f0-9]{24}$/.test(an)) { const fid = embedFiles.find(x => db.files?.[x]?.name === an || db.files?.[x]?.name === safeName(an));
      if (fid) { embedUsed.add(fid); if (db.files[fid].kind === 'image') return `/dosya/${fid}/${encodeURIComponent(db.files[fid].name)}`; embedWarn ||= `${alan}: ${an} resim değil`; return null; }
      embedWarn ||= `${alan}: "${an}" bu mesajın eklerinde yok. Dosyayı POST /dosyalar ile yükleyip ya dönen id'yi yaz ya da ekler: [id] ile birlikte gönder`; return null; }
    const m = u.match(/^(?:https:\/\/[^/]+)?\/dosya\/([a-f0-9]{24})(?:\/|$)/) || u.match(/^(?:dosya:|attachment:\/\/)?([a-f0-9]{24})$/);
    if (m && db.files?.[m[1]]) { const f = db.files[m[1]]; if (f.kind === 'image') return `/dosya/${m[1]}/${encodeURIComponent(f.name)}`; embedWarn ||= `${alan}: bu dosya resim değil`; return null; }
    const h = httpsUrl(u); if (h) return h;
    embedWarn ||= /^data:/i.test(u) ? `${alan}: base64 (data:) resim olmaz; önce POST /dosyalar ile yükle, dönen id'yi yaz` : /^http:\/\//i.test(u) ? `${alan}: adres https:// ile başlamalı` : m ? `${alan}: dosya bulunamadı (önce POST /dosyalar ile yükle)` : `${alan}: geçersiz resim adresi (https:// adresi ya da yüklediğin dosyanın id'si olmalı)`;
  } else embedWarn ||= `${alan}: resim metin (adres ya da dosya id'si) olmalı`;
  return null;
}
function cleanEmbeds(list) {
  embedWarn = null;
  if (!Array.isArray(list)) return [];
  return list.slice(0, 5).map(e => { if (!e || typeof e !== 'object') return null;
    const k = { baslik: refFix(noPing(clean(e.baslik ?? e.title, 200))), aciklama: refFix(noPing(clean(e.aciklama ?? e.description, 3000))), renk: hexColor(e.renk ?? e.color), url: httpsUrl(e.url),
      alanlar: (Array.isArray(e.alanlar ?? e.fields) ? (e.alanlar ?? e.fields) : []).slice(0, 15).map(f => ({ ad: refFix(noPing(clean(f?.ad ?? f?.name, 100))), deger: refFix(noPing(clean(f?.deger ?? f?.value, 800))), satir: !!(f?.satir ?? f?.inline) })).filter(f => f.ad || f.deger),
      resim: cardImg(e.resim ?? e.image?.url ?? e.image, 'resim'), kucukResim: cardImg(e.kucukResim ?? e.thumbnail?.url ?? e.thumbnail, 'kucukResim'), altyazi: noPing(clean(e.altyazi ?? e.footer?.text ?? e.footer, 200)) };
    return k.baslik || k.aciklama || k.alanlar.length || k.resim ? k : null; }).filter(Boolean);
}
const PICK_TUR = { kisi: 'kisi', uye: 'kisi', kullanici: 'kisi', kisiSecim: 'kisi', user: 'kisi', rol: 'rol', rolSecim: 'rol', role: 'rol', oda: 'oda', odaSecim: 'oda', channel: 'oda' };
// Seçicide gelen değerleri doğrula ve bota çözülmüş hâlini ver (kişi → üye bilgisi, rol → rol bilgisi, oda → oda bilgisi)
function pickVals(kind, raw, s, chId, me, { min = 1, max = 1, odaTuru = null } = {}) {
  const vals = [...new Set((Array.isArray(raw) ? raw : [raw]).filter(v => typeof v === 'string' && v && v.length < 80))];
  if (vals.length < min || vals.length > max) return { error: min === max ? `${max} seçim yapmalısın` : `${min}-${max} arası seçim yapmalısın` };
  if (kind === 'kisi') {
    const ok = n => s ? s.members.includes(n) : dmPeers(chId).includes(n);
    const names = vals.map(v => ok(v) ? v : nameOfRef(v)).filter(n => n && ok(n)); if (names.length !== vals.length) return { error: 'Seçilen kişi bu sunucuda değil' };
    return { vals: names, coz: { kullanicilar: names.map(n => s ? memberView(s, n) : { id: uidOf(db.users[n] || {}), ad: n, gorunenAd: db.users[n]?.displayName || n }) } };
  }
  if (!s) return { error: 'Bu seçici sadece sunucuda çalışır' };
  if (kind === 'rol') { const rs = vals.map(v => s.customRoles.find(r => r.id === v)); if (rs.some(r => !r)) return { error: 'Rol bulunamadı' }; return { vals, coz: { roller: rs.map(r => roleView(r, s.customRoles.indexOf(r))) } }; }
  const cs = vals.map(v => s.channels.find(c => c.id === v)); if (cs.some(c => !c || !seesChannel(s, c, me) || (odaTuru && (c.type || 'text') !== odaTuru))) return { error: 'Oda bulunamadı' };
  return { vals, coz: { odalar: cs.map(c => chBotView(s, c)) } };
}
function cleanComps(rows) {
  if (!Array.isArray(rows)) return [];
  const ids = new Set();
  return rows.slice(0, 5).map(r => (Array.isArray(r) ? r : Array.isArray(r?.bilesenler ?? r?.components) ? (r.bilesenler ?? r.components) : [r]).slice(0, 5).map(c => {
    if (!c || typeof c !== 'object') return null;
    const pk = PICK_TUR[c.tur] || (c.tur == null && { 5: 'kisi', 6: 'rol', 8: 'oda' }[c.type]);
    if (pk) { // kişi / rol / oda seçici: liste Kanka'dan gelir, kullanıcı arayarak seçer
      const id = clean(c.id ?? c.custom_id, 100); if (!id || ids.has(id)) return null; ids.add(id);
      const min = Math.min(Math.max(parseInt(c.min ?? c.min_values) ?? 1, 0), 25), max = Math.min(Math.max(parseInt(c.max ?? c.max_values) || 1, min || 1), 25);
      const ot = ['text', 'voice', 'stage', 'forum'].includes(c.odaTuru) ? c.odaTuru : null;
      return { tur: pk, id, yerTutucu: clean(c.yerTutucu ?? c.placeholder, 100) || { kisi: 'Üye ara…', rol: 'Rol seç…', oda: 'Oda seç…' }[pk], min: Number.isNaN(min) ? 1 : min, max, ...(pk === 'oda' && ot ? { odaTuru: ot } : {}), kapali: !!(c.kapali ?? c.disabled) };
    }
    const tur = c.tur ?? (c.type === 3 ? 'secim' : 'buton');
    if (tur === 'buton') {
      const stil = BTN_STYLES.includes(c.stil) ? c.stil : c.url ? 'link' : 'ana', b = { tur, stil, etiket: clean(c.etiket ?? c.label, 80), emoji: clean(c.emoji, 16) || null, kapali: !!(c.kapali ?? c.disabled) };
      if (stil === 'link') { b.url = httpsUrl(c.url); if (!b.url) return null; } else { b.id = clean(c.id ?? c.custom_id, 100); if (!b.id || ids.has(b.id)) return null; ids.add(b.id); }
      return b.etiket || b.emoji ? b : null;
    }
    if (tur === 'secim') {
      const id = clean(c.id ?? c.custom_id, 100); if (!id || ids.has(id)) return null; ids.add(id);
      const sec = (Array.isArray(c.secenekler ?? c.options) ? (c.secenekler ?? c.options) : []).slice(0, 25).map(o => ({ etiket: clean(o?.etiket ?? o?.label, 100), deger: clean(o?.deger ?? o?.value, 100), aciklama: clean(o?.aciklama ?? o?.description, 100) || null, emoji: clean(o?.emoji, 16) || null })).filter(o => o.etiket && o.deger);
      if (!sec.length) return null;
      const min = Math.min(Math.max(parseInt(c.min ?? c.min_values) || 1, 0), sec.length), max = Math.min(Math.max(parseInt(c.max ?? c.max_values) || 1, min || 1), sec.length);
      return { tur, id, yerTutucu: clean(c.yerTutucu ?? c.placeholder, 100) || 'Bir seçenek seç', secenekler: sec, min, max, kapali: !!(c.kapali ?? c.disabled) };
    }
    return null;
  }).filter(Boolean)).filter(r => r.length).filter(r => r.every(c => c.tur === 'buton') || r.length === 1);
}
// Discord alışkanlığı: <@kimlik> → @ad, <@&rolId> → @RolAdı, <#odaId> → #oda-adı (mesaj metninde ve kartlarda)
function refFix(t) {
  return String(t || '').replace(/<@!?(\d{12,20})>/g, (m, id) => { const u = userById(id); return u ? '@' + u.name : m; })
    .replace(/<@&([a-z0-9]{6,24})>/gi, (m, rid) => { for (const s of db.servers) { const r = s.customRoles?.find(x => x.id === rid); if (r) return '@' + r.name; } return m; })
    .replace(/<#([a-z0-9]{6,24})>/gi, (m, cid) => { const f = findChannel(cid); return f ? '#' + f.c.name : m; });
}
function msgBody(b) { // REST gövdesinden mesaj alanları (Kanka ve alışık olunan İngilizce adlar)
  // <@kimlik> yazılırsa o kişinin güncel adıyla etiketlenir (bot adı değil kimliği saklar)
  const text = refFix(noPing(clean(b?.icerik ?? b?.content ?? '', MSG_MAX)));
  let ek = b?.ekler ?? b?.attachments ?? b?.dosyalar ?? b?.files ?? b?.ek; if (ek != null && !Array.isArray(ek)) ek = [ek];
  const fidOf = x => { const v = typeof x === 'string' ? x : x?.id ?? x?.url; const m = typeof v === 'string' && (v.match(/^[a-f0-9]{24}$/) || v.match(/\/dosya\/([a-f0-9]{24})/)); return m ? (m[1] || m[0]) : null; };
  let files = (ek || []).slice(0, 10).map(fidOf), bad = files.filter(x => !x).length; files = files.filter(Boolean);
  embedFiles = files; embedUsed = new Set();
  let embeds = cleanEmbeds(b?.kartlar ?? b?.embeds ?? (b?.kart ?? b?.embed ? [b.kart ?? b.embed] : undefined));
  const warn = embedWarn || (bad ? 'ekler: dosya id\'si olmalı (önce POST /dosyalar ile yükle, dönen id\'yi yaz)' : null);
  files = files.filter(x => !embedUsed.has(x)); embedFiles = [];
  return { text, embeds, comps: cleanComps(b?.bilesenler ?? b?.components), files, uyari: warn };
}
// Botun yüklediği dosyalar (POST /dosyalar) mesaja eklenir; başkasının dosyası eklenemez
const botFiles = (a, ids) => (ids || []).filter(x => db.files?.[x]?.owner === a.bot).map(x => { const f = db.files[x]; return { id: x, name: f.name, size: f.size, kind: f.kind, url: `/dosya/${x}/${encodeURIComponent(f.name)}` }; });
// Botun kendi emojileri: mesajda :ad: geçiyorsa resmi mesajla birlikte gider (her sunucuda ve DM'de görünür)
function appEmo(a, text, embeds) {
  const em = a.emojis || {}, src = [text || '', ...(embeds || []).flatMap(e => [e.baslik, e.aciklama, ...(e.alanlar || []).flatMap(f => [f.ad, f.deger])])].join(' ');
  const used = {}; for (const [, n] of src.matchAll(/:([a-z0-9_]{2,24}):/g)) if (em[n]) used[n] = em[n];
  return Object.keys(used).length ? used : undefined;
}
// ---- Bota giden mesaj görünümü ----
function msgForBot(a, chId, m, full) {
  const f = findChannel(chId), dm = chId.startsWith('dm:'), mention = !!m.text && new RegExp('@' + a.bot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}\\p{N}_.-])', 'u').test(m.text);
  const see = !!full || dm || mention || m.author === a.bot;
  const au = db.users[m.author];
  return { id: m.id, oda: chId, sunucu: f?.s.id || null, dm, zaman: m.time, duzenlendi: !!m.edited,
    yazar: m.author ? { id: au ? uidOf(au) : null, ad: m.author, gorunenAd: au?.displayName || m.author, bot: !!au?.bot || m.author === BOT_NAME, ...(m.author === BOT_NAME ? { sistem: true } : {}), ...(au?.bot ? { uygulama: db.apps?.[au.bot.app] ? appInfoOf(db.apps[au.bot.app]) : { id: au.bot.app } } : {}) } : null,
    icerik: see ? (m.text || '') : '', kartlar: see ? (m.embeds || []) : [], bilesenler: m.comps || [], etiketlendi: mention,
    ekler: see ? (m.files || []).map(x => ({ ad: x.name, url: x.url, boyut: x.size, tur: x.kind })) : [], yanit: m.replyTo?.id || null, tepkiler: Object.fromEntries(Object.entries(m.reactions || {}).map(([e, us]) => [e, us.length])) };
}
// ---- Gateway (WebSocket) ----
const botConns = new Map(); // appId -> Set(bağlantı)
const botSessions = new Map(); // oturum id -> { app, seq, buf, closedAt }
const botConnsOf = appId => [...(botConns.get(appId) || [])];
let WSS = null; try { const { WebSocketServer } = require('ws'); WSS = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 }); } catch (e) { console.error('ws paketi yok, bot gateway kapalı', e.message); }
function gwSend(conn, o) { try { if (conn.ws.readyState === 1) conn.ws.send(JSON.stringify(o)); } catch {} }
function gwDispatch(appId, t, d, filter) {
  for (const conn of botConnsOf(appId)) {
    if (!conn.ready || (filter && !filter(conn))) continue;
    const sess = botSessions.get(conn.session); if (!sess) continue;
    const ev = { op: 0, t, s: ++sess.seq, d }; sess.buf.push(ev); if (sess.buf.length > 300) sess.buf.shift();
    gwSend(conn, ev);
  }
}
if (WSS) {
  server.on('upgrade', (req, sock, head) => {
    let p; try { p = new URL(req.url, 'http://x').pathname; } catch { return; }
    if (p !== '/bot/gateway') return; // diğer yükseltmeler (socket.io) kendi yoluna
    WSS.handleUpgrade(req, sock, head, ws => gwConnection(ws, req));
  });
}
function gwConnection(ws, req) {
  const ipk = 'gw|' + reqIp(req);
  if (limited(ipk, 30, 60e3)) return ws.close(4008, 'Çok sık bağlanıyorsun');
  const conn = { ws, app: null, intents: new Set(), ready: false, session: null, alive: Date.now() };
  gwSend(conn, { op: 10, d: { nabizAraligi: 30000, heartbeat_interval: 30000 } });
  const kill = setTimeout(() => { if (!conn.ready) ws.close(4003, 'Kimlik doğrulama gelmedi'); }, 15000);
  const hb = setInterval(() => { if (Date.now() - conn.alive > 75000) ws.close(4009, 'Nabız gelmedi'); }, 20000);
  ws.on('message', raw => {
    let m; try { m = JSON.parse(String(raw)); } catch { return ws.close(4002, 'Geçersiz JSON'); }
    if (limited('gwmsg|' + (conn.app?.id || ipk), 120, 60e3)) return ws.close(4008, 'Çok fazla mesaj');
    if (m.op === 1) { conn.alive = Date.now(); return gwSend(conn, { op: 11 }); }
    if (m.op === 2 || m.op === 6) {
      const d = m.d || {}, a = appByToken(String(d.token || '').replace(/^Bot\s+/i, ''));
      if (!a) return ws.close(4004, 'Token geçersiz');
      if (a.killed) return ws.close(4014, 'Bu bot Kanka ekibi tarafından durduruldu');
      if (botConnsOf(a.id).length >= 2) return ws.close(4005, 'Bu bot zaten 2 bağlantıyla bağlı');
      conn.app = a; conn.alive = Date.now();
      const want = Array.isArray(d.niyetler ?? d.intents) ? (d.niyetler ?? d.intents) : ['mesajlar', 'uyeler', 'tepkiler', 'dm'];
      conn.intents = new Set(want.filter(x => BOT_INTENTS.includes(x)));
      if (conn.intents.has('icerik') && !contentOk(a)) { conn.intents.delete('icerik'); }
      let sess = m.op === 6 && botSessions.get(String(d.oturum ?? d.session_id ?? '')), resumed = false;
      if (sess && sess.app === a.id) { resumed = true; sess.closedAt = null; } else { sess = { app: a.id, seq: 0, buf: [], closedAt: null }; }
      conn.session = resumed ? String(d.oturum ?? d.session_id) : crypto.randomBytes(12).toString('hex'); botSessions.set(conn.session, sess);
      (botConns.get(a.id) || botConns.set(a.id, new Set()).get(a.id)).add(conn); conn.ready = true; clearTimeout(kill); pushPresence();
      a.lastOnline = Date.now();
      { const pr = d.durum ?? d.presence; if (pr && typeof pr === 'object') { const r = botSetPresence(a, pr); if (r.error) gwSend(conn, { op: 0, t: 'HATA', d: { islem: 'durum', hata: r.error } }); } }
      if (resumed) { const from = +(d.sira ?? d.seq) || 0; for (const ev of sess.buf.filter(e => e.s > from)) gwSend(conn, ev); gwSend(conn, { op: 0, t: 'DEVAM_EDILDI', s: sess.seq, d: {} }); }
      else gwSend(conn, { op: 0, t: 'HAZIR', s: ++sess.seq, d: { oturum: conn.session, bot: appView(a), niyetler: [...conn.intents], icerikIzni: contentOk(a),
        sunucular: botServers(a).map(s => botServerView(a, s)) } });
      return;
    }
    // op 3: durum / etkinlik güncelle (Discord'daki presence update gibi)
    // op 4: sesli odaya katıl / ayrıl { oda } (oda null ise ayrıl) · op 5: WebRTC sinyali { kime, veri }
    if (m.op === 4) {
      if (!conn.ready || !conn.app) return ws.close(4003, 'Önce kimlik doğrula (op 2)');
      if (limited('gwses|' + conn.app.id, 20, 60e3)) return gwSend(conn, { op: 0, t: 'HATA', d: { islem: 'ses', hata: 'Çok sık sese girip çıkıyorsun' } });
      const oda = m.d?.oda ?? m.d?.channel ?? null;
      if (!oda) { botVoiceLeave(conn.app.id, 'bot ayrıldı'); return; }
      const r = botVoiceJoin(conn.app, String(oda), conn);
      if (r.error) gwSend(conn, { op: 0, t: 'HATA', d: { islem: 'ses', oda, hata: r.error } });
      return;
    }
    if (m.op === 5) {
      if (!conn.ready || !conn.app) return;
      const bv = botVoiceOfApp(conn.app.id), to = String(m.d?.kime ?? m.d?.to ?? '');
      if (!bv || !voice.get(bv.ch)?.has(to) || to === bv.sid) return;
      const data = m.d?.veri ?? m.d?.data; if (!data || typeof data !== 'object' || JSON.stringify(data).length > 20000) return;
      if (botVoice.has(to)) return; // bot ↔ bot ses bağlantısı yok
      io.to(to).emit('signal', { from: bv.sid, data: data.sdp ? { sdp: { type: String(data.sdp.type), sdp: String(data.sdp.sdp) } } : data.ice ? { ice: data.ice } : {} });
      return;
    }
    if (m.op === 3) {
      if (!conn.ready || !conn.app) return ws.close(4003, 'Önce kimlik doğrula (op 2)');
      const r = botSetPresence(conn.app, m.d || {});
      return gwSend(conn, r.error ? { op: 0, t: 'HATA', d: { islem: 'durum', hata: r.error } } : { op: 0, t: 'DURUM_GUNCELLENDI', d: r });
    }
  });
  ws.on('close', () => { clearTimeout(kill); clearInterval(hb); if (conn.app) { const bv = botVoiceOfApp(conn.app.id); if (bv?.conn === conn) botVoiceLeave(conn.app.id, 'bağlantı koptu'); botConns.get(conn.app.id)?.delete(conn); if (conn.ready) setTimeout(pushPresence, 0); const s = botSessions.get(conn.session); if (s) s.closedAt = Date.now(); } });
  ws.on('error', () => {});
}
setInterval(() => { for (const [k, s] of botSessions) if (s.closedAt && Date.now() - s.closedAt > 120e3) botSessions.delete(k); }, 60e3);
// ---- Güncellemede botlar kopmasın: oturumlar diske yazılır, yeni sunucu açılınca bot "devam et" (op 6) ile kaldığı yerden döner ----
const GW_SESS_FILE = path.join(DATA_DIR, 'gw-oturumlar.json');
try {
  const o = JSON.parse(fs.readFileSync(GW_SESS_FILE, 'utf8'));
  if (Date.now() - o.at < 180e3) for (const [k, v] of Object.entries(o.s || {})) botSessions.set(k, { app: v.app, seq: v.seq || 0, buf: [], closedAt: Date.now() });
  fs.unlinkSync(GW_SESS_FILE);
} catch {}
let shuttingDown = false;
// =================== Kanka Arena ===================
// Sesli odalarda oyun lobileri. Lobiler bellekte durur (sunucu güncellenirken sıra tabanlı oyunlar arena.json'a yazılıp geri yüklenir).
// Her oyun bir "motor": init(oyuncular) → durum, move(durum, oyuncu, hamle) → hata yazısı | undefined, view(durum, bakan) → gönderilecek görüntü.
// Gerçek zamanlı oyunlar (masa hokeyi, bilek güreşi) ayrıca tick(durum, dt) ve input(durum, oyuncu, girdi) kullanır.
// Puan: oyun başına Elo (1000'den başlar). Genel sıralamada ilk 10 "Arena Şampiyonu" rozeti alır.
const ARENA_FILE = path.join(DATA_DIR, 'arena.json');
const arenas = new Map();            // lobi id -> lobi
const arenaSocks = new Map();        // socket.id -> izlenen lobi id
const rint = n => crypto.randomInt(n);
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = rint(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const r3 = x => Math.round(x * 1000) / 1000;
// ---------- Pişti ----------
const SUITS = ['S', 'H', 'D', 'C'], RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const cRank = c => c.slice(0, -1);
const PISTI = {
  ad: 'Pişti', emoji: '🃏', min: 2, max: 2, turnSec: 45,
  init(ps) {
    const deck = shuffle(SUITS.flatMap(s => RANKS.map(r => r + s)));
    let table = deck.splice(0, 4); while (cRank(table[3]) === 'J') { deck.push(table.pop()); shuffle(deck); table.push(deck.shift()); } // açık kart vale olmasın
    const st = { ps, deck, table, hands: {}, caps: {}, pis: {}, turn: 0, last: null, ev: null };
    for (const p of ps) { st.hands[p] = deck.splice(0, 4); st.caps[p] = []; st.pis[p] = 0; }
    return st;
  },
  cur: st => st.ps[st.turn],
  move(st, p, mv) {
    if (st.ps[st.turn] !== p) return 'Sıra sende değil';
    const h = st.hands[p], i = h.indexOf(mv?.card); if (i < 0) return 'Bu kart elinde yok';
    const card = h.splice(i, 1)[0], top = st.table[st.table.length - 1];
    st.ev = { by: p, card, cap: false, pisti: 0 };
    if (top && (cRank(card) === cRank(top) || cRank(card) === 'J')) {
      if (st.table.length === 1 && cRank(card) === cRank(top)) { const pts = cRank(card) === 'J' ? 20 : 10; st.pis[p] += pts; st.ev.pisti = pts; }
      st.caps[p].push(...st.table, card); st.table = []; st.last = p; st.ev.cap = true;
    } else st.table.push(card);
    st.turn = (st.turn + 1) % st.ps.length;
    if (st.ps.every(x => !st.hands[x].length)) {
      if (st.deck.length) for (const x of st.ps) st.hands[x] = st.deck.splice(0, 4);
      else {
        if (st.table.length && st.last) { st.caps[st.last].push(...st.table); st.table = []; }
        const sc = PISTI.score(st); st.final = sc;
        const [a, b] = st.ps; st.over = sc[a] === sc[b] ? { draw: true, rank: [a, b] } : { rank: [...st.ps].sort((x, y) => sc[y] - sc[x]) };
      }
    }
  },
  score(st) {
    const o = {}, n = Object.fromEntries(st.ps.map(p => [p, st.caps[p].length])), most = Math.max(...Object.values(n));
    for (const p of st.ps) {
      let s = st.pis[p];
      for (const c of st.caps[p]) { if (c === '2C') s += 2; if (c === '10D') s += 3; if (['A', 'J'].includes(cRank(c))) s += 1; }
      if (n[p] === most && Object.values(n).filter(v => v === most).length === 1) s += 3;
      o[p] = s;
    }
    return o;
  },
  view(st, me) {
    return { hand: st.hands[me] || null, counts: Object.fromEntries(st.ps.map(p => [p, st.hands[p].length])), top: st.table[st.table.length - 1] || null, under: st.table[st.table.length - 2] || null, tableN: st.table.length,
      deck: st.deck.length, caps: Object.fromEntries(st.ps.map(p => [p, st.caps[p].length])), pis: st.pis, turn: st.ps[st.turn], ev: st.ev, final: st.final || null, score: PISTI.score(st) };
  },
  leave(st, p) { st.over = { rank: [...st.ps.filter(x => x !== p), p], forfeit: p }; },
};
// ---------- Kanka Kart (UNO benzeri) ----------
// kart: renk (r,y,g,b) + değer (0-9, s=atla, r=yön, d=+2) ya da w (renk seç), w4 (+4)
const KK_COLORS = ['r', 'y', 'g', 'b'];
const KART = {
  ad: 'Kanka Kart', emoji: '🌈', min: 2, max: 6, turnSec: 40,
  deck() { const d = []; for (const c of KK_COLORS) { d.push(c + '0'); for (const v of ['1', '2', '3', '4', '5', '6', '7', '8', '9', 's', 'r', 'd']) d.push(c + v, c + v); } for (let i = 0; i < 4; i++) d.push('w', 'w4'); return shuffle(d); },
  init(ps) {
    const deck = KART.deck(), st = { ps, deck, pile: [], hands: {}, turn: 0, dir: 1, color: null, drew: false, ev: null, out: [] };
    for (const p of ps) st.hands[p] = deck.splice(0, 7);
    let top; while (true) { top = deck.shift(); if (/^[rygb][0-9]$/.test(top)) break; deck.push(top); }
    st.pile.push(top); st.color = top[0]; return st;
  },
  cur: st => st.ps[st.turn],
  isWild: c => c[0] === 'w',
  ok(st, c) { const top = st.pile[st.pile.length - 1]; return KART.isWild(c) || c[0] === st.color || (!KART.isWild(top) && c.slice(1) === top.slice(1)); },
  draw(st, p, n) { for (let i = 0; i < n; i++) { if (!st.deck.length) { const top = st.pile.pop(); st.deck = shuffle(st.pile); st.pile = [top]; } if (!st.deck.length) break; st.hands[p].push(st.deck.shift()); } },
  next(st, k = 1) { const n = st.ps.length; st.turn = ((st.turn + st.dir * k) % n + n) % n; st.drew = false; },
  move(st, p, mv) {
    if (st.ps[st.turn] !== p) return 'Sıra sende değil';
    const h = st.hands[p];
    if (mv?.draw) { if (st.drew) return 'Zaten kart çektin'; KART.draw(st, p, 1); st.drew = true; st.ev = { by: p, draw: 1 }; if (!h.some(c => KART.ok(st, c))) { st.ev.pass = true; KART.next(st); } return; }
    if (mv?.pass) { if (!st.drew) return 'Önce kart çek'; st.ev = { by: p, pass: true }; KART.next(st); return; }
    const i = +mv?.i; if (!Number.isInteger(i) || !h[i]) return 'Geçersiz kart';
    const c = h[i]; if (!KART.ok(st, c)) return 'Bu kart oynanamaz';
    if (st.drew && i !== h.length - 1) return 'Kart çektikten sonra sadece çektiğin kartı oynayabilirsin';
    if (KART.isWild(c) && !KK_COLORS.includes(mv.color)) return 'Bir renk seç';
    h.splice(i, 1); st.pile.push(c); st.color = KART.isWild(c) ? mv.color : c[0];
    st.ev = { by: p, card: c, color: st.color, kanka: h.length === 1 };
    if (!h.length) {
      const left = st.ps.filter(x => x !== p).sort((a, b) => st.hands[a].length - st.hands[b].length);
      st.over = { rank: [p, ...left] }; return;
    }
    const v = c.slice(1), n = st.ps.length;
    if (v === 's') KART.next(st, 2);
    else if (v === 'r') { if (n === 2) KART.next(st, 2); else { st.dir *= -1; KART.next(st); } }
    else if (v === 'd' || c === 'w4') { KART.next(st); const victim = st.ps[st.turn]; KART.draw(st, victim, v === 'd' ? 2 : 4); st.ev.hit = { who: victim, n: v === 'd' ? 2 : 4 }; KART.next(st); }
    else KART.next(st);
  },
  view(st, me) {
    return { hand: st.hands[me] || null, counts: Object.fromEntries(st.ps.map(p => [p, st.hands[p].length])), top: st.pile[st.pile.length - 1], color: st.color, dir: st.dir, deck: st.deck.length,
      turn: st.ps[st.turn], drew: st.ps[st.turn] === me && st.drew, ev: st.ev, playable: st.hands[me] && st.ps[st.turn] === me ? st.hands[me].map(c => KART.ok(st, c) && (!st.drew || c === st.hands[me][st.hands[me].length - 1])) : null };
  },
  leave(st, p) {
    const i = st.ps.indexOf(p); if (i < 0) return;
    if (st.ps.length <= 2) { st.over = { rank: [...st.ps.filter(x => x !== p), p], forfeit: p }; return; }
    st.out.push(p); st.deck.push(...st.hands[p]); shuffle(st.deck); delete st.hands[p];
    const wasTurn = st.turn === i; st.ps.splice(i, 1); if (st.turn > i || st.turn >= st.ps.length) st.turn = (st.turn - (st.turn > i ? 1 : 0)) % st.ps.length; if (wasTurn) st.drew = false;
    st.ev = { left: p };
  },
};
// ---------- Adam asmaca (harf tahmin) ----------
const KELIMELER = {
  Hayvan: ['ZÜRAFA', 'PENGUEN', 'TİMSAH', 'KAPLUMBAĞA', 'ÇİTA', 'SİNCAP', 'KARINCA', 'YUNUS', 'KANGURU', 'BAYKUŞ', 'ARMADİLLO', 'GERGEDAN', 'ÖRDEK', 'KELEBEK', 'AHTAPOT', 'FLAMİNGO', 'KİRPİ', 'TAVŞAN', 'PAPAĞAN', 'ÇEKİRGE'],
  Yiyecek: ['LAHMACUN', 'MANTI', 'BAKLAVA', 'İSKENDER', 'KÜNEFE', 'MENEMEN', 'SUCUK', 'PİDE', 'KARPUZ', 'ANANAS', 'BÖREK', 'DÖNER', 'SİMİT', 'KOKOREÇ', 'ÇİĞ KÖFTE', 'LOKUM', 'AYRAN', 'PATLICAN', 'MANDALİNA', 'HAMBURGER'],
  Şehir: ['İSTANBUL', 'ANKARA', 'İZMİR', 'TRABZON', 'ESKİŞEHİR', 'GAZİANTEP', 'MARDİN', 'ANTALYA', 'ERZURUM', 'KAPADOKYA', 'ÇANAKKALE', 'MUĞLA', 'DİYARBAKIR', 'SAMSUN', 'BURSA', 'KONYA', 'RİZE', 'EDİRNE', 'ŞANLIURFA', 'ADANA'],
  Meslek: ['ASTRONOT', 'ECZACI', 'MİMAR', 'İTFAİYECİ', 'GARSON', 'BERBER', 'PİLOT', 'YAZILIMCI', 'AŞÇI', 'VETERİNER', 'AVUKAT', 'FOTOĞRAFÇI', 'ÖĞRETMEN', 'MÜHENDİS', 'TERZİ', 'POSTACI', 'ARKEOLOG', 'DİŞ HEKİMİ', 'KAPTAN', 'HAKEM'],
  Eşya: ['KULAKLIK', 'ŞEMSİYE', 'BUZDOLABI', 'KLAVYE', 'MERDİVEN', 'YASTIK', 'TELESKOP', 'PUSULA', 'ÇAYDANLIK', 'MİKROFON', 'BİLGİSAYAR', 'MAKAS', 'AYNA', 'SAAT', 'KUMANDA', 'ŞARJ ALETİ', 'CÜZDAN', 'GÖZLÜK', 'MASA LAMBASI', 'ÇEKİÇ'],
  Oyun: ['SATRANÇ', 'TAVLA', 'OKEY', 'MİNECRAFT', 'VALORANT', 'TETRİS', 'SAKLAMBAÇ', 'MONOPOLY', 'DOMİNO', 'BİLARDO', 'LANGIRT', 'PİŞTİ', 'BOWLİNG', 'YAKAN TOP', 'SEK SEK', 'MANGALA', 'ZEKA KÜPÜ', 'BİNGO', 'DART', 'AMONG US'],
  Spor: ['BASKETBOL', 'VOLEYBOL', 'GÜREŞ', 'OKÇULUK', 'YÜZME', 'TENİS', 'HENTBOL', 'KAYAK', 'BOKS', 'ESKRİM', 'KÜREK', 'JİMNASTİK', 'MARATON', 'SÖRF', 'KARATE', 'BİSİKLET', 'DALIŞ', 'PATEN', 'RUGBY', 'GOLF'],
  Ülke: ['JAPONYA', 'BREZİLYA', 'MEKSİKA', 'NORVEÇ', 'MISIR', 'ARJANTİN', 'KANADA', 'İTALYA', 'HİNDİSTAN', 'AVUSTRALYA', 'İZLANDA', 'PORTEKİZ', 'GÜNEY KORE', 'FAS', 'ŞİLİ', 'YUNANİSTAN', 'İSVEÇ', 'KÜBA', 'PERU', 'ENDONEZYA'],
};
const TR_ALPHA = 'ABCÇDEFGĞHIİJKLMNOÖPRSŞTUÜVYZ';
const ASMACA = {
  ad: 'Harf Tahmin', emoji: '🔤', min: 2, max: 8, turnSec: 35, maxMiss: 7,
  pick(st) { const cats = Object.keys(KELIMELER), cat = cats[rint(cats.length)], l = KELIMELER[cat].filter(w => !st.used.includes(w)); const w = l[rint(l.length)]; st.used.push(w); return { cat, word: w }; },
  init(ps) { const st = { ps, scores: Object.fromEntries(ps.map(p => [p, 0])), round: 0, rounds: Math.min(6, Math.max(3, ps.length)), used: [], turn: 0, ev: null }; ASMACA.newRound(st); return st; },
  newRound(st) { const { cat, word } = ASMACA.pick(st); Object.assign(st, { cat, word, got: [], wrong: [], miss: 0, roundOver: null }); st.round++; st.turn = (st.round - 1) % st.ps.length; },
  cur: st => st.ps[st.turn],
  solved: st => [...st.word].every(ch => ch === ' ' || st.got.includes(ch)),
  endRound(st, why) {
    st.roundOver = { word: st.word, why };
    if (st.round >= st.rounds) { st.over = { rank: [...st.ps].sort((a, b) => st.scores[b] - st.scores[a]) }; const top = st.scores[st.over.rank[0]]; if (st.ps.filter(p => st.scores[p] === top).length > 1 && st.ps.length === 2) st.over.draw = true; }
    else { const keep = st.roundOver; ASMACA.newRound(st); st.prev = keep; }
  },
  move(st, p, mv) {
    if (st.ps[st.turn] !== p) return 'Sıra sende değil';
    st.prev = null;
    const pass = () => { st.turn = (st.turn + 1) % st.ps.length; };
    if (typeof mv?.word === 'string') {
      const g = mv.word.toLocaleUpperCase('tr').replace(/\s+/g, ' ').trim(); if (!g) return 'Bir kelime yaz';
      if (g === st.word) { const hidden = [...new Set([...st.word].filter(ch => ch !== ' ' && !st.got.includes(ch)))].length; st.scores[p] += 20 + hidden * 5; st.ev = { by: p, word: g, ok: true, pts: 20 + hidden * 5 }; ASMACA.endRound(st, p + ' bildi'); return; }
      st.scores[p] = Math.max(0, st.scores[p] - 5); st.miss++; st.ev = { by: p, word: g, ok: false };
      if (st.miss >= ASMACA.maxMiss) return ASMACA.endRound(st, 'Adam asıldı');
      return pass();
    }
    const L = String(mv?.letter || '').toLocaleUpperCase('tr'); if (L.length !== 1 || !TR_ALPHA.includes(L)) return 'Geçersiz harf';
    if (st.got.includes(L) || st.wrong.includes(L)) return 'Bu harf denendi';
    const n = [...st.word].filter(ch => ch === L).length;
    if (n) { st.got.push(L); st.scores[p] += 10 * n; st.ev = { by: p, letter: L, n }; if (ASMACA.solved(st)) { st.scores[p] += 15; ASMACA.endRound(st, p + ' tamamladı'); } return; }
    st.wrong.push(L); st.miss++; st.ev = { by: p, letter: L, n: 0 };
    if (st.miss >= ASMACA.maxMiss) return ASMACA.endRound(st, 'Adam asıldı');
    pass();
  },
  view(st) {
    return { cat: st.cat, mask: [...st.word].map(ch => ch === ' ' ? ' ' : st.got.includes(ch) || st.over ? ch : '_').join(''), got: st.got, wrong: st.wrong, miss: st.miss, maxMiss: ASMACA.maxMiss, turn: st.ps[st.turn],
      scores: st.scores, round: st.round, rounds: st.rounds, ev: st.ev, prev: st.prev || null, word: st.over ? st.word : null };
  },
  leave(st, p) {
    if (st.ps.length <= 2) { st.over = { rank: [...st.ps.filter(x => x !== p), p], forfeit: p }; return; }
    const i = st.ps.indexOf(p); st.ps.splice(i, 1); delete st.scores[p]; if (st.turn >= st.ps.length || st.turn > i) st.turn = Math.max(0, st.turn - (st.turn > i ? 1 : 0)) % st.ps.length; st.ev = { left: p };
  },
};
// ---------- Dart (301) ----------
const DART_ORDER = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
function dartScore(x, y) { // tahta yarıçapı 1 (çift halkanın dış kenarı)
  const r = Math.hypot(x, y); if (r > 1) return { pts: 0, label: 'Dışarı' };
  if (r <= 6.35 / 170) return { pts: 50, label: 'Bull' };
  if (r <= 15.9 / 170) return { pts: 25, label: '25' };
  const deg = (Math.atan2(x, y) * 180 / Math.PI + 360) % 360, n = DART_ORDER[Math.floor(((deg + 9) % 360) / 18)];
  if (r >= 162 / 170) return { pts: n * 2, label: 'Çift ' + n };
  if (r >= 99 / 170 && r <= 107 / 170) return { pts: n * 3, label: 'Üçlü ' + n };
  return { pts: n, label: String(n) };
}
const DART = {
  ad: 'Dart', emoji: '🎯', min: 2, max: 4, turnSec: 40, START: 301, ROUNDS: 10,
  init(ps) { return { ps, score: Object.fromEntries(ps.map(p => [p, DART.START])), turn: 0, dart: 0, from: DART.START, round: 1, hits: [], ev: null }; },
  cur: st => st.ps[st.turn],
  nextTurn(st) { st.turn = (st.turn + 1) % st.ps.length; st.dart = 0; st.hits = []; if (st.turn === 0) st.round++; st.from = st.score[st.ps[st.turn]];
    if (st.round > DART.ROUNDS) st.over = { rank: [...st.ps].sort((a, b) => st.score[a] - st.score[b]) }; },
  move(st, p, mv) {
    if (st.ps[st.turn] !== p) return 'Sıra sende değil';
    let x = +mv?.x, y = +mv?.y; if (!isFinite(x) || !isFinite(y) || Math.abs(x) > 1.6 || Math.abs(y) > 1.6) return 'Geçersiz atış';
    x += gauss() * 0.035; y += gauss() * 0.035; // el titremesi
    const s = dartScore(x, y), left = st.score[p] - s.pts, hit = { x: r3(x), y: r3(y), ...s };
    st.hits.push(hit); st.ev = { by: p, ...hit };
    if (left < 0) { st.score[p] = st.from; st.ev.bust = true; return DART.nextTurn(st); }
    st.score[p] = left;
    if (left === 0) { st.over = { rank: [p, ...st.ps.filter(q => q !== p).sort((a, b) => st.score[a] - st.score[b])] }; return; }
    if (++st.dart >= 3) DART.nextTurn(st);
  },
  view(st) { return { score: st.score, turn: st.ps[st.turn], dart: st.dart, round: Math.min(st.round, DART.ROUNDS), rounds: DART.ROUNDS, hits: st.hits, ev: st.ev }; },
  leave(st, p) { if (st.ps.length <= 2) { st.over = { rank: [...st.ps.filter(x => x !== p), p], forfeit: p }; return; } const i = st.ps.indexOf(p); st.ps.splice(i, 1); delete st.score[p]; if (st.turn === i) { st.turn = (i - 1 + st.ps.length) % st.ps.length; DART.nextTurn(st); } else if (st.turn > i) st.turn--; },
};
// ---------- Bilardo (8 Ball Pool kuralları ve fiziği) ----------
// Gerçek ölçüler (metre): 8 ayak masa 2,24 x 1,12, top çapı 57,15 mm. Atış sunucuda baştan sona hesaplanır; istemci kareleri oynatır.
// Fizik: kayma → yuvarlanma geçişi (falso, çekme, takip), yan falso (bantta etkisi), cep ağızlarında çene bantları, top-top ve bant sekmeleri.
const PB = { W: 2.24, H: 1.12, R: 0.028575, G: 9.81, MUS: 0.15, MUR: 0.025, MUSP: 0.045, E_BALL: 0.96, E_RAIL: 0.8, MU_RAIL: 0.18, VMAX: 7.4, DT: 1 / 480 };
const PB_POCKETS = (() => { const { W, H } = PB, c = 0.019, s = 0.034; return [[-c, -c, 0.07], [W / 2, -s, 0.063], [W + c, -c, 0.07], [-c, H + c, 0.07], [W / 2, H + s, 0.063], [W + c, H + c, 0.07]]; })();
const PB_SEGS = (() => {
  const { W, H } = PB, CM = 0.087, SM = 0.064, J = 0.042, segs = [];
  const add = (x1, y1, x2, y2) => segs.push([x1, y1, x2, y2]);
  // uzun bantlar (üst ve alt), ortada yan cep boşluğu
  for (const y of [0, H]) { const o = y ? 1 : -1;
    add(CM, y, W / 2 - SM, y); add(W / 2 + SM, y, W - CM, y);
    add(CM, y, CM - J * 0.7, y + o * J); add(W - CM, y, W - CM + J * 0.7, y + o * J); // köşe çeneleri
    add(W / 2 - SM, y, W / 2 - SM + 0.012, y + o * J); add(W / 2 + SM, y, W / 2 + SM - 0.012, y + o * J); } // yan cep çeneleri
  for (const x of [0, W]) { const o = x ? 1 : -1;
    add(x, CM, x, H - CM); add(x, CM, x + o * J, CM - J * 0.7); add(x, H - CM, x + o * J, H - CM + J * 0.7); }
  return segs;
})();
function poolRack() {
  const { W, H, R } = PB, b = [{ n: 0, x: W * 0.25, y: H / 2, in: false }], dx = R * 2 * Math.sqrt(3) / 2 + 0.0001, dy = R * 2 + 0.0001;
  const solids = shuffle([1, 2, 3, 4, 5, 6, 7]), stripes = shuffle([9, 10, 11, 12, 13, 14, 15]);
  const cornerA = solids.pop(), cornerB = stripes.pop(), rest = shuffle([...solids, ...stripes]);
  for (let row = 0; row < 5; row++) for (let k = 0; k <= row; k++) {
    const n = row === 2 && k === 1 ? 8 : row === 4 && k === 0 ? cornerA : row === 4 && k === 4 ? cornerB : rest.pop();
    b.push({ n, x: W * 0.75 + row * dx + (Math.random() - 0.5) * 0.0006, y: H / 2 + (k - row / 2) * dy + (Math.random() - 0.5) * 0.0006, in: false }); // gerçek diziliş gibi milimetrik boşluklar: açılışta toplar daha iyi dağılır
  }
  return b.sort((a, c) => a.n - c.n);
}
// Bir atışı baştan sona hesapla. sp: [yan, dikey] (-1..1, dikey > 0 = üstten vuruş / takip)
function poolSim(balls, ang, power, sp = [0, 0]) {
  const { R, G, MUS, MUR, MUSP, DT } = PB;
  const B = balls.map(b => ({ ...b, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0, ox: b.x, oy: b.y }));
  const V = 0.25 + Math.pow(power, 1.6) * (PB.VMAX - 0.25), sx = Math.max(-1, Math.min(1, sp[0] || 0)), sy = Math.max(-1, Math.min(1, sp[1] || 0));
  const a = ang - sx * 0.012 * power; // yan falsoda beyaz hafif sapar
  const dx = Math.cos(a), dy = Math.sin(a), cue = B[0], spin = 2.1 * V / R; // oyun hissi için gerçeğinden biraz güçlü falso
  cue.vx = dx * V; cue.vy = dy * V; cue.wx = -dy * spin * sy * 0.5 * 2; cue.wy = dx * spin * sy * 0.5 * 2; cue.wz = -spin * sx * 0.5 * 2;
  // (sy=0.4 doğal yuvarlanmaya yakın; sy<0 çekme)
  const frames = [], events = [], potted = [], rails = new Set(); let first = null, t = 0, step = 0, contact = false;
  const FR = 16; // her 16 adımda bir kare (30 kare/sn)
  const snap = () => { const f = []; for (let i = 0; i < B.length; i++) { const b = B[i]; if (b.in) continue; const X = Math.round(b.x * 1000), Y = Math.round(b.y * 1000); if (X !== b.lx || Y !== b.ly || !frames.length) { f.push(i, X, Y); b.lx = X; b.ly = Y; } } frames.push(f); };
  const ev = (type, s) => { if (s > 0.02) events.push([frames.length, type, Math.round(Math.min(1, s) * 100) / 100]); };
  snap();
  while (t < 20) {
    let moving = false;
    for (const b of B) {
      if (b.in) continue;
      const ux = b.vx - R * b.wy, uy = b.vy + R * b.wx, us = Math.hypot(ux, uy), sp2 = Math.hypot(b.vx, b.vy);
      if (us > 0.002) { // kayıyor
        const k = MUS * G * DT, ax = -ux / us, ay = -uy / us;
        if (us <= 3.5 * k) { b.vx -= ux * 2 / 7; b.vy -= uy * 2 / 7; b.wx = -b.vy / R; b.wy = b.vx / R; } // tam bu adımda yuvarlanmaya geçer
        else { b.vx += ax * k; b.vy += ay * k; b.wx += 2.5 * ay * k / R; b.wy -= 2.5 * ax * k / R; }
        moving = true;
      } else if (sp2 > 0.003) { // yuvarlanıyor
        const ns = Math.max(0, sp2 - MUR * G * DT * (sp2 < 0.15 ? 1.6 : 1)); b.vx *= ns / sp2; b.vy *= ns / sp2; b.wx = -b.vy / R; b.wy = b.vx / R; moving = true;
      } else { b.vx = b.vy = b.wx = b.wy = 0; }
      if (b.wz) { const d = 2.5 * MUSP * G / R * DT; b.wz = Math.abs(b.wz) <= d ? 0 : b.wz - Math.sign(b.wz) * d; }
      b.x += b.vx * DT; b.y += b.vy * DT;
    }
    if (!moving) break;
    // top-top
    for (let i = 0; i < B.length; i++) { const p = B[i]; if (p.in) continue;
      for (let j = i + 1; j < B.length; j++) { const q = B[j]; if (q.in) continue;
        const ddx = q.x - p.x, ddy = q.y - p.y; if (Math.abs(ddx) > 2 * R || Math.abs(ddy) > 2 * R) continue;
        const d = Math.hypot(ddx, ddy); if (d >= 2 * R || d === 0) continue;
        const nx = ddx / d, ny = ddy / d, ov = 2 * R - d; p.x -= nx * ov / 2; p.y -= ny * ov / 2; q.x += nx * ov / 2; q.y += ny * ov / 2;
        const rv = (p.vx - q.vx) * nx + (p.vy - q.vy) * ny; if (rv <= 0) continue;
        const J = rv * (1 + PB.E_BALL) / 2; p.vx -= J * nx; p.vy -= J * ny; q.vx += J * nx; q.vy += J * ny;
        // atma (throw): kesik vuruşta hedef top beyazın kayma yönüne hafif çekilir
        const tx = -ny, ty = nx, rel = (p.vx - q.vx) * tx + (p.vy - q.vy) * ty, th = Math.max(-0.035, Math.min(0.035, rel * 0.02)) * J; q.vx += tx * th; q.vy += ty * th;
        if (first === null && (p.n === 0 || q.n === 0)) first = p.n === 0 ? q.n : p.n;
        contact = true; ev(0, J / 3);
      } }
    // bantlar ve çeneler
    for (const b of B) { if (b.in) continue;
      if (b.x > 0.1 && b.x < PB.W - 0.1 && b.y > 0.1 && b.y < PB.H - 0.1) continue;
      for (const [x1, y1, x2, y2] of PB_SEGS) {
        const sx2 = x2 - x1, sy2 = y2 - y1, L2 = sx2 * sx2 + sy2 * sy2, tt = Math.max(0, Math.min(1, ((b.x - x1) * sx2 + (b.y - y1) * sy2) / L2));
        const qx = x1 + sx2 * tt, qy = y1 + sy2 * tt, ddx = b.x - qx, ddy = b.y - qy, d = Math.hypot(ddx, ddy); if (d >= R || d === 0) continue;
        const nx = ddx / d, ny = ddy / d, vn = b.vx * nx + b.vy * ny; b.x = qx + nx * R; b.y = qy + ny * R; if (vn >= 0) continue;
        const tx = -ny, ty = nx; let vt = b.vx * tx + b.vy * ty;
        const vnNew = -vn * PB.E_RAIL, slip = vt - b.wz * R, Jt = -Math.sign(slip) * Math.min(Math.abs(slip) / 3.5, PB.MU_RAIL * (1 + PB.E_RAIL) * -vn);
        vt += Jt; b.wz -= 2.5 * Jt / R;
        // üst/alt falsonun bantla gelen kısmı kısmen tersine döner
        let rvx = R * b.wy, rvy = -R * b.wx; const rvn = rvx * nx + rvy * ny; rvx -= 1.45 * rvn * nx; rvy -= 1.45 * rvn * ny; b.wx = -rvy / R; b.wy = rvx / R;
        b.vx = tx * vt + nx * vnNew; b.vy = ty * vt + ny * vnNew;
        if (contact || b.n !== 0) rails.add(b.n); ev(1, -vn / 4);
      } }
    // cepler
    for (const b of B) { if (b.in) continue;
      for (let k = 0; k < PB_POCKETS.length; k++) { const [px, py, pr] = PB_POCKETS[k]; if (Math.hypot(b.x - px, b.y - py) < pr) { b.in = true; b.pk = k; potted.push([b.n, k]); events.push([frames.length, 2, Math.round(Math.min(1, 0.3 + Math.hypot(b.vx, b.vy) / 4) * 100) / 100, b.n, k]); b.vx = b.vy = 0; break; } }
      if (!b.in && (b.x < -0.08 || b.x > PB.W + 0.08 || b.y < -0.08 || b.y > PB.H + 0.08)) { b.in = true; potted.push([b.n, -1]); events.push([frames.length, 2, 0.5, b.n, -1]); }
    }
    t += DT; if (++step % FR === 0) snap();
  }
  snap();
  return { balls: B.map(({ n, x, y, in: i }) => ({ n, x: r3(x), y: r3(y), in: i })), frames, events, potted, first, rails: rails.size, contact };
}
const BILARDO = {
  ad: 'Bilardo', emoji: '🎱', min: 2, max: 2, turnSec: 45,
  init(ps) { return { ps, balls: poolRack(), turn: 0, groups: null, hand: 'kitchen', brk: true, shot: 0, ev: null, msg: null }; },
  cur: st => st.ps[st.turn],
  own: (st, p, n) => { const g = st.groups?.[p]; return g ? (g === 'duz' ? n >= 1 && n <= 7 : n >= 9 && n <= 15) : n !== 8 && n !== 0; },
  left(st, p) { const g = st.groups?.[p]; if (!g) return 7; return st.balls.filter(b => !b.in && (g === 'duz' ? b.n >= 1 && b.n <= 7 : b.n >= 9)).length; },
  onEight: (st, p) => !!st.groups && BILARDO.left(st, p) === 0,
  free(st, x, y, kitchen) { const R = PB.R; return x > R && x <= (kitchen ? PB.W * 0.25 + 1e-6 : PB.W - R) && y > R && y < PB.H - R && st.balls.every(b => b.in || b.n === 0 || Math.hypot(b.x - x, b.y - y) > 2 * R + 0.001); },
  move(st, p, mv) {
    if (st.ps[st.turn] !== p) return 'Sıra sende değil';
    const ang = +mv?.a, pw = Math.max(0.02, Math.min(1, +mv?.p || 0)); if (!isFinite(ang)) return 'Geçersiz atış';
    const sp = Array.isArray(mv.s) ? [+mv.s[0] || 0, +mv.s[1] || 0] : [0, 0]; if (Math.hypot(sp[0], sp[1]) > 1.01) return 'Geçersiz falso';
    const cue = st.balls[0], opp = st.ps[1 - st.turn], eight = BILARDO.onEight(st, p);
    if (st.hand) { const x = +mv.cx, y = +mv.cy; if (isFinite(x) && isFinite(y)) { if (!BILARDO.free(st, x, y, st.hand === 'kitchen')) return st.hand === 'kitchen' ? 'Açılışta beyaz top sol çeyrekte olmalı' : 'Beyaz topu boş bir yere koy'; cue.x = x; cue.y = y; } cue.in = false; }
    let call = null; if (eight) { call = +mv.pc; if (!Number.isInteger(call) || call < 0 || call > 5) return '8 numara için bir cep seç'; }
    const brk = st.brk, sim = poolSim(st.balls, ang, pw, sp);
    st.balls = sim.balls; st.shot++; st.brk = false;
    const pots = sim.potted.map(x => x[0]), cueIn = pots.includes(0), eightIn = pots.includes(8), objs = pots.filter(n => n && n !== 8);
    let foul = null;
    if (sim.first === null) foul = 'Hiçbir topa değmedi';
    else if (cueIn) foul = 'Beyaz top cebe girdi';
    else if (!brk && st.groups && !eight && !BILARDO.own(st, p, sim.first)) foul = sim.first === 8 ? 'Önce 8 numaraya vurdu' : 'Önce rakibin topuna vurdu';
    else if (!brk && st.groups && eight && sim.first !== 8) foul = 'Önce 8 numaraya vurmalıydı';
    else if (!brk && !st.groups && sim.first === 8) foul = 'Açık masada önce 8 numaraya vurdu';
    else if (!brk && !pots.length && sim.rails === 0) foul = 'Temastan sonra hiçbir top banda gitmedi';
    st.ev = { by: p, frames: sim.frames, events: sim.events, potted: sim.potted, foul, seq: st.shot, a: r3(ang), p: r3(pw), s: sp.map(r3), from: [r3(cue.x), r3(cue.y)], call };
    if (eightIn) {
      if (brk) { // açılışta 8 girerse masa yeniden dizilir, aynı oyuncu yeniden açar
        Object.assign(st, { balls: poolRack(), hand: 'kitchen', brk: true, groups: null }); st.ev.msg = '8 numara açılışta girdi, masa yeniden dizildi'; return; }
      const pk = sim.potted.find(x => x[0] === 8)[1], win = eight && !foul && !cueIn && pk === call;
      st.over = { rank: win ? [p, opp] : [opp, p], why: win ? '8 numarayı söylediği cebe soktu' : !eight ? '8 numara erken girdi' : cueIn ? '8 numarayla birlikte beyaz da girdi' : pk !== call ? '8 numara yanlış cebe girdi' : 'Faulle 8 numara' }; st.ev.end = st.over.why; return;
    }
    if (!st.groups && !brk && !foul && objs.length) { const g0 = objs[0] < 8 ? 'duz' : 'cizgili'; st.groups = { [p]: g0, [opp]: g0 === 'duz' ? 'cizgili' : 'duz' }; st.ev.groups = true; }
    const keep = !foul && objs.some(n => brk || !st.groups || BILARDO.own(st, p, n));
    st.hand = foul ? 'any' : false;
    if (!keep) st.turn = 1 - st.turn;
    if (cueIn || foul) { const c = st.balls[0]; c.in = false; if (cueIn) { c.x = PB.W * 0.25; c.y = PB.H / 2; for (let k = 0; k < 20 && !BILARDO.free(st, c.x, c.y); k++) { c.x = 0.2 + rint(160) / 100; c.y = 0.1 + rint(90) / 100; } } }
  },
  view(st, me) {
    const p = st.ps[st.turn];
    return { balls: st.balls, turn: p, groups: st.groups, hand: st.hand, brk: st.brk, ev: st.ev, eight: BILARDO.onEight(st, p),
      left: Object.fromEntries(st.ps.map(x => [x, BILARDO.left(st, x)])) };
  },
  leave(st, p) { st.over = { rank: [...st.ps.filter(x => x !== p), p], forfeit: p }; },
};
// ---------- Bilek güreşi (gerçek zamanlı: hızlı bas) ----------
const BILEK = {
  ad: 'Bilek Güreşi', emoji: '💪', min: 2, max: 2, rt: true, hz: 10,
  // Güç: A ve D'ye sırayla basınca artar; yoruldukça her basışın kazandırdığı güç azalır.
  // Güç düşünce zamanlama barı çıkar: işaret yeşil bölgedeyken boşluğa basan gücünü zirvesine yaklaştırır, yorgunluğu atar.
  PER: 2.4, QTE_MAX: 3.6, QTE_CD: 2.5, qid: 0,
  init(ps) {
    const pl = () => ({ pw: 30, peak: 30, fat: 0, k: 0, q: null, cd: 0, last: null });
    return { ps, pos: 0, wins: Object.fromEntries(ps.map(p => [p, 0])), P: Object.fromEntries(ps.map(p => [p, pl()])), phase: 'cd', t: 3, round: 1, now: 0 };
  },
  mark: t => { const u = (Math.max(0, t) / BILEK.PER) % 1; return u < 0.5 ? u * 2 : 2 - u * 2; }, // 0 → 1 → 0 sabit hızla gidip gelen işaret
  input(st, p, inp) {
    const P = st.P?.[p]; if (!P || st.phase !== 'go') return;
    const k = Math.max(0, Math.min(3, Math.floor(+inp?.k || 0))); P.k += k; // 100 ms'de en çok 3 doğru basış (saniyede ~30)
    if (inp?.q != null && P.q && !P.q.done && (inp.qi == null || +inp.qi === P.q.id)) {
      // İstemci, barı gördüğü andan bu yana geçen süreyi gönderir; gecikme payı: sunucudaki süreden en çok 0,8 sn geride olabilir
      const sv = (Date.now() - P.q.at) / 1000; let t = +inp.q; if (!isFinite(t) || t > sv + 0.05 || t < sv - 0.8) t = sv;
      const dist = Math.abs(BILEK.mark(t) - P.q.z), acc = Math.max(0, Math.min(1, 1 - dist / (2 * P.q.w))); // bölge kenarında %50, ortasında %100
      P.q.done = true; P.q.acc = Math.round(acc * 100) / 100; P.last = { acc: P.q.acc, at: st.now };
      if (acc > 0) { P.pw += (P.peak - P.pw) * acc; P.fat *= 1 - acc * 0.85; } else P.pw = Math.max(0, P.pw - 8);
      P.cd = BILEK.QTE_CD; setTimeout(() => { if (P.q?.done) P.q = null; }, 600);
    }
  },
  tick(st, dt) {
    st.now += dt;
    if (st.phase === 'cd' || st.phase === 'pause') { st.t -= dt; if (st.t <= 0) { if (st.phase === 'pause') { st.pos = 0; st.round++; for (const p of st.ps) Object.assign(st.P[p], { pw: 30, peak: 30, fat: 0, q: null, cd: 0 }); } st.phase = 'go'; st.t = 0; } return true; }
    if (st.phase !== 'go') return false;
    for (const p of st.ps) {
      const P = st.P[p], k = Math.min(P.k, 3); P.k = 0;
      P.pw = Math.min(100, P.pw + k * 4.2 * (1 - P.fat));   // basış gücü yorgunlukla azalır
      P.fat = Math.min(0.92, P.fat + k * 0.016);             // her basış yorar
      P.fat = Math.max(0, P.fat - 0.02 * dt);                // durunca çok yavaş dinlenir
      P.pw = Math.max(0, P.pw - (7 + P.pw * 0.06) * dt);     // güç kendiliğinden düşer
      if (P.pw > P.peak) P.peak = P.pw; else P.peak = Math.max(P.pw, P.peak - 1.5 * dt);
      if (P.cd > 0) P.cd -= dt;
      if (P.q && !P.q.done && (Date.now() - P.q.at) / 1000 > BILEK.QTE_MAX) { P.q.done = true; P.q.acc = 0; P.last = { acc: 0, at: st.now, miss: true }; P.cd = BILEK.QTE_CD; setTimeout(() => { if (P.q?.done) P.q = null; }, 400); }
      // güç zirvenin yarısına düşünce (ya da çok yorulunca) zamanlama barı çıkar
      if (!P.q && P.cd <= 0 && P.peak > 25 && (P.pw < P.peak * 0.65 || P.fat > 0.5)) P.q = { id: ++BILEK.qid, at: Date.now(), z: r3(0.3 + Math.random() * 0.5), w: 0.1 };
    }
    const [a, b] = st.ps, d = st.P[a].pw - st.P[b].pw;
    st.pos += d * 0.0019 * dt - Math.sign(st.pos) * 0.01 * dt; // güç farkı 50 iken yaklaşık 10 sn'de kazanılır
    if (Math.abs(st.pos) >= 1) { const w = st.pos > 0 ? a : b; st.wins[w]++; st.last = w;
      if (st.wins[w] >= 2) { st.over = { rank: [w, w === a ? b : a] }; st.phase = 'end'; } else { st.phase = 'pause'; st.t = 2.5; } }
    return true;
  },
  view(st) {
    const P = {}; for (const p of st.ps) { const x = st.P[p]; P[p] = { pw: Math.round(x.pw), peak: Math.round(x.peak), fat: Math.round(x.fat * 100) / 100, q: x.q ? { id: x.q.id, age: r3((Date.now() - x.q.at) / 1000), z: x.q.z, w: x.q.w, done: !!x.q.done, acc: x.q.acc ?? null } : null, last: x.last && st.now - x.last.at < 1.2 ? x.last : null }; }
    return { pos: r3(st.pos), wins: st.wins, phase: st.phase, t: Math.ceil(st.t), round: st.round, last: st.last || null, P, per: BILEK.PER };
  },
  leave(st, p) { st.over = { rank: [...st.ps.filter(x => x !== p), p], forfeit: p }; },
};
// ---------- Masa hokeyi (gerçek zamanlı · 30Hz yayın, 8 alt adımlı fizik; istemci arayı tahminle doldurur) ----------
// Masa 1 x 1.6; ilk oyuncu altta, ikinci üstte. İstemci kendi tarafını hep altta görür (ikinci oyuncu için çevrilir).
const HOK = { W: 1, H: 1.6, PR: 0.075, KR: 0.042, GOAL: 0.36, POST: 0.014, MAXV: 2.7, PADV: 9, WIN: 7 }; // biraz yavaşlatıldı (pak 3.6→2.7, tokmak 11.5→9)
const HOK_POSTS = [
  [0.5 - HOK.GOAL / 2, 0], [0.5 + HOK.GOAL / 2, 0],
  [0.5 - HOK.GOAL / 2, HOK.H], [0.5 + HOK.GOAL / 2, HOK.H],
];
const HOKEY = {
  ad: 'Masa Hokeyi', emoji: '🏒', min: 2, max: 2, rt: true, hz: 30,
  init(ps) { return { ps, k: { x: 0.5, y: 1.05, vx: 0, vy: 0 }, pd: [{ x: 0.5, y: 1.4, tx: 0.5, ty: 1.4, vx: 0, vy: 0 }, { x: 0.5, y: 0.2, tx: 0.5, ty: 0.2, vx: 0, vy: 0 }], sc: [0, 0], pause: 1.6, serve: 0, last: null, ev: null, evSeq: 0 }; },
  input(st, p, inp) { const i = st.ps.indexOf(p); if (i < 0) return; let x = +inp?.x, y = +inp?.y; if (!isFinite(x) || !isFinite(y)) return;
    if (i === 1) { x = HOK.W - x; y = HOK.H - y; } // ikinci oyuncu masayı ters görür
    const pd = st.pd[i]; pd.tx = Math.max(HOK.PR, Math.min(HOK.W - HOK.PR, x)); pd.ty = i === 0 ? Math.max(HOK.H / 2 + HOK.PR, Math.min(HOK.H - HOK.PR, y)) : Math.max(HOK.PR, Math.min(HOK.H / 2 - HOK.PR, y)); },
  tick(st, dt) {
    if (st.over) return false;
    const steps = 8, h = dt / steps, k = st.k;
    const emitEv = (t, x, y, v) => { st.evSeq = (st.evSeq || 0) + 1; st.ev = { seq: st.evSeq, t, x: r3(x), y: r3(y), v: r3(Math.min(1, v)) }; };
    for (let s = 0; s < steps; s++) {
      for (const pd of st.pd) {
        const dx = pd.tx - pd.x, dy = pd.ty - pd.y, d = Math.hypot(dx, dy);
        const ox = pd.x, oy = pd.y;
        if (d > 1e-5) {
          const step = Math.min(d, HOK.PADV * h);
          pd.x += (dx / d) * step;
          pd.y += (dy / d) * step;
        }
        const ivx = (pd.x - ox) / h, ivy = (pd.y - oy) / h;
        pd.vx = pd.vx * 0.32 + ivx * 0.68;
        pd.vy = pd.vy * 0.32 + ivy * 0.68;
      }
      if (st.pause > 0) { st.pause -= h; continue; }
      k.x += k.vx * h; k.y += k.vy * h;
      // Gerçek hava yastığı süzülmesi (çok düşük sürtünme)
      const drag = Math.pow(0.996, h * 60);
      k.vx *= drag; k.vy *= drag;
      if (Math.abs(k.y - HOK.H / 2) < HOK.PR && Math.hypot(k.vx, k.vy) < 0.08) { st.stuck = (st.stuck || 0) + h; if (st.stuck > 1.8) { k.vy = (Math.random() < 0.5 ? -1 : 1) * 0.55; st.stuck = 0; } } else st.stuck = 0;
      // Yan bantlar
      if (k.x < HOK.KR) { k.x = HOK.KR; if (k.vx < -0.15) emitEv('rail', k.x, k.y, Math.abs(k.vx) / 2.2); k.vx = Math.abs(k.vx) * 0.93; }
      if (k.x > HOK.W - HOK.KR) { k.x = HOK.W - HOK.KR; if (k.vx > 0.15) emitEv('rail', k.x, k.y, Math.abs(k.vx) / 2.2); k.vx = -Math.abs(k.vx) * 0.93; }
      // Fiziksel kale direkleri (gerçekçi direk sekmesi!)
      for (const [px, py] of HOK_POSTS) {
        const dx = k.x - px, dy = k.y - py, d = Math.hypot(dx, dy), md = HOK.KR + HOK.POST;
        if (d < md && d > 1e-6) {
          const nx = dx / d, ny = dy / d; k.x = px + nx * md; k.y = py + ny * md;
          const vn = k.vx * nx + k.vy * ny;
          if (vn < 0) { k.vx -= 1.92 * vn * nx; k.vy -= 1.92 * vn * ny; emitEv('post', px, py, Math.abs(vn) / 2.0); }
        }
      }
      const inGoal = Math.abs(k.x - HOK.W / 2) < HOK.GOAL / 2 - HOK.POST * 0.5;
      if (k.y < HOK.KR && !inGoal) { k.y = HOK.KR; if (k.vy < -0.15) emitEv('rail', k.x, k.y, Math.abs(k.vy) / 2.2); k.vy = Math.abs(k.vy) * 0.93; }
      if (k.y > HOK.H - HOK.KR && !inGoal) { k.y = HOK.H - HOK.KR; if (k.vy > 0.15) emitEv('rail', k.x, k.y, Math.abs(k.vy) / 2.2); k.vy = -Math.abs(k.vy) * 0.93; }
      // Gol kontrolü
      if (k.y < -HOK.KR || k.y > HOK.H + HOK.KR) {
        const scorer = k.y < 0 ? 0 : 1; st.sc[scorer]++; st.last = st.ps[scorer]; st.goalAt = Date.now();
        emitEv('goal', 0.5, k.y < 0 ? 0 : HOK.H, 1);
        if (st.sc[scorer] >= HOK.WIN) { st.over = { rank: [st.ps[scorer], st.ps[1 - scorer]] }; return true; }
        Object.assign(k, { x: 0.5, y: scorer === 0 ? 0.52 : 1.08, vx: 0, vy: 0 }); st.pause = 1.15; break;
      }
      // Tokmak - Pak çarpışması (yüksek hassasiyetli momentum aktarımı + sıkışma önleyici)
      for (const pd of st.pd) {
        const dx = k.x - pd.x, dy = k.y - pd.y, d = Math.hypot(dx, dy), md = HOK.PR + HOK.KR;
        if (d >= md) continue;
        const nx = d > 1e-6 ? dx / d : 0, ny = d > 1e-6 ? dy / d : (pd.y > HOK.H / 2 ? -1 : 1);
        k.x = pd.x + nx * (md + 0.001); k.y = pd.y + ny * (md + 0.001);
        const rvx = k.vx - pd.vx, rvy = k.vy - pd.vy, rv = rvx * nx + rvy * ny;
        if (rv < 0) {
          const imp = -1.86 * rv;
          k.vx += imp * nx + pd.vx * 0.14;
          k.vy += imp * ny + pd.vy * 0.14;
          if (-rv > 0.12) emitEv('hit', pd.x + nx * HOK.PR, pd.y + ny * HOK.PR, (-rv) / 2.6);
        }
        // Bant köşesine sıkışırsa paku temizce içeri iter
        if (k.x < HOK.KR) { k.x = HOK.KR; k.vx = Math.max(k.vx, 0.35); }
        if (k.x > HOK.W - HOK.KR) { k.x = HOK.W - HOK.KR; k.vx = Math.min(k.vx, -0.35); }
        const v = Math.hypot(k.vx, k.vy); if (v > HOK.MAXV) { k.vx *= HOK.MAXV / v; k.vy *= HOK.MAXV / v; }
      }
    }
    return true;
  },
  view(st) { const k = st.k; return { k: [r3(k.x), r3(k.y)], kv: [r3(k.vx), r3(k.vy)], p: st.pd.map(pd => [r3(pd.x), r3(pd.y)]), sc: st.sc, pause: st.pause > 0, last: st.last, win: HOK.WIN, ev: st.ev }; },
  leave(st, p) { st.over = { rank: [...st.ps.filter(x => x !== p), p], forfeit: p }; },
};
const ARENA_GAMES = { bilardo: BILARDO, dart: DART, pisti: PISTI, kart: KART, bilek: BILEK, hokey: HOKEY, asmaca: ASMACA };
// ---------- Lobi yönetimi ----------
const arenaInVoice = (ch, n) => [...(voice.get(ch)?.values() || [])].includes(n);
function arenaView(L, viewer) {
  const E = ARENA_GAMES[L.game];
  return { id: L.id, ch: L.ch, sv: L.sv, game: L.game, ad: E.ad, emoji: E.emoji, min: E.min, max: E.max, rt: !!E.rt, host: L.host, players: L.players, state: L.state, at: L.at,
    watchers: io.sockets.adapter.rooms.get('ar:' + L.id)?.size || 0, g: L.st ? E.view(L.st, viewer) : null, ps: L.st?.ps || null, res: L.res || null, rematch: L.rematch || [], turnAt: L.turnAt || null, turnSec: E.turnSec || null, seq: L.seq };
}
const arenaSummary = L => ({ id: L.id, game: L.game, ad: ARENA_GAMES[L.game].ad, emoji: ARENA_GAMES[L.game].emoji, host: L.host, players: L.players, max: ARENA_GAMES[L.game].max, state: L.state });
// Odalar listesinde oyun simgesi: odayı görebilen herkese hangi oyunların açık olduğu
const arenaRoomOf = ch => [...arenas.values()].filter(L => L.ch === ch).map(L => ({ game: L.game, state: L.state }));
function arenaRoomsFor(n) { const o = {}; for (const L of arenas.values()) { if (o[L.ch]) continue; const f = findChannel(L.ch); if (f && (f.s.public || f.s.members.includes(n)) && seesChannel(f.s, f.c, n)) o[L.ch] = arenaRoomOf(L.ch); } return o; }
const arenaRoomSig = new Map();
function arenaPushCh(ch) {
  const list = [...arenas.values()].filter(L => L.ch === ch).map(arenaSummary);
  io.to('v:' + ch).to('arch:' + ch).emit('arenaCh', { ch, lobbies: list });
  const g = arenaRoomOf(ch), sig = JSON.stringify(g);
  if (arenaRoomSig.get(ch) !== sig) { arenaRoomSig.set(ch, sig); if (!g.length) arenaRoomSig.delete(ch);
    const f = findChannel(ch); if (f) { const who = f.s.public ? [...new Set(online.values())] : membersOf(f.s); for (const n of who) if (seesChannel(f.s, f.c, n)) io.to('user:' + n).emit('arenaRoom', { ch, g }); } }
}
function arenaPush(L) {
  L.seq = (L.seq || 0) + 1;
  for (const sid of io.sockets.adapter.rooms.get('ar:' + L.id) || []) io.to(sid).emit('arena', arenaView(L, online.get(sid)));
}
function arenaCardUpdate(L) {
  const list = db.messages[L.ch]; const m = L.msg && list?.find(x => x.id === L.msg); if (!m) return;
  m.arena = { ...m.arena, state: L.state, players: L.res && L.state !== 'play' && L.state !== 'lobby' ? [...L.res.rank] : [...L.players], winner: L.res?.rank?.[0] || null, draw: !!L.res?.draw, gone: !arenas.has(L.id) };
  save(); io.to(L.ch).emit('update', { channelId: L.ch, msg: m });
}
// Elo: sıralamadaki her ikili karşılaştırma ayrı maç sayılır
function arenaRate(game, rank, draw) {
  const R = n => { const u = db.users[n]; const a = ((u.arena ||= {})[game] ||= { r: 1000, w: 0, l: 0, d: 0, p: 0 }); return a; };
  const before = Object.fromEntries(rank.map(n => [n, R(n).r])), delta = Object.fromEntries(rank.map(n => [n, 0])), K = 32 / Math.max(1, rank.length - 1);
  for (let i = 0; i < rank.length; i++) for (let j = i + 1; j < rank.length; j++) {
    const a = rank[i], b = rank[j], ea = 1 / (1 + 10 ** ((before[b] - before[a]) / 400)), sa = draw ? 0.5 : 1;
    delta[a] += K * (sa - ea); delta[b] -= K * (sa - ea);
  }
  for (const n of rank) { const a = R(n); a.r = Math.max(100, Math.round(a.r + delta[n])); a.p++; delta[n] = Math.round(delta[n]); }
  if (draw) for (const n of rank) R(n).d++; else { R(rank[0]).w++; for (const n of rank.slice(1)) R(n).l++; }
  arenaTopCache = null; return delta;
}
function arenaFinish(L) {
  const E = ARENA_GAMES[L.game], o = L.st.over, rank = o.rank.filter(n => db.users[n]);
  const delta = rank.length >= 2 ? arenaRate(L.game, rank, !!o.draw) : {};
  for (const n of rank) { addXp(n, n === rank[0] && !o.draw ? 30 : 10, 'arena', null, null); STAT.me(n, 'ar:' + E.ad + ':o'); if (n === rank[0] && !o.draw) STAT.me(n, 'ar:' + E.ad + ':w'); }
  L.state = 'end'; L.res = { rank, draw: !!o.draw, delta, forfeit: o.forfeit || null, why: o.why || null }; L.rematch = []; L.endAt = Date.now();
  save(); arenaPush(L); arenaPushCh(L.ch); arenaCardUpdate(L);
  for (const n of rank) io.to('user:' + n).emit('users', allUsers());
}
function arenaStart(L) {
  const E = ARENA_GAMES[L.game];
  L.st = E.init(shuffle([...L.players])); L.state = 'play'; L.res = null; L.rematch = []; L.turnAt = Date.now(); L.away = {};
  arenaPush(L); arenaPushCh(L.ch); arenaCardUpdate(L);
}
function arenaMove(L, n, mv) {
  const E = ARENA_GAMES[L.game]; if (L.state !== 'play' || !L.st.ps.includes(n)) return 'Bu oyunda değilsin';
  const err = E.move(L.st, n, mv); if (err) return err;
  L.turnAt = Date.now();
  if (L.st.over) arenaFinish(L); else arenaPush(L);
}
function arenaDrop(L, n, why) {
  const E = ARENA_GAMES[L.game];
  if (L.state === 'play' && L.st.ps.includes(n)) { E.leave(L.st, n); L.players = L.players.filter(x => x !== n); if (L.st.over) { L.st.over.forfeit ||= n; arenaFinish(L); } else { L.turnAt = Date.now(); arenaPush(L); } }
  else { L.players = L.players.filter(x => x !== n); L.rematch = (L.rematch || []).filter(x => x !== n); }
  if (L.host === n) L.host = L.players[0] || null;
  if (!L.players.length && L.state !== 'play') { arenas.delete(L.id); io.to('ar:' + L.id).emit('arenaGone', { id: L.id, why: why || 'Lobi kapandı' }); arenaCardUpdate({ ...L, state: L.res ? 'end' : 'closed' }); }
  else { arenaPush(L); arenaCardUpdate(L); }
  arenaPushCh(L.ch);
}
// Saniyede bir: odadan çıkanlar (45 sn içinde dönmezse oyundan düşer), sırasını bekletenler, eski lobiler
setInterval(() => {
  const now = Date.now();
  for (const L of [...arenas.values()]) {
    if (!findChannel(L.ch)) { arenas.delete(L.id); continue; }
    for (const n of [...L.players]) {
      if (arenaInVoice(L.ch, n)) { if (L.away?.[n]) delete L.away[n]; continue; }
      if (L.state !== 'play') { arenaDrop(L, n, 'Odadan ayrıldı'); continue; }
      (L.away ||= {})[n] ||= now; if (now - L.away[n] > 45e3) arenaDrop(L, n, 'Odadan ayrıldı');
    }
    if (!arenas.has(L.id)) continue;
    const E = ARENA_GAMES[L.game];
    if (L.state === 'play' && !E.rt && E.turnSec && now - (L.turnAt || now) > (E.turnSec + 15) * 1000) { const c = E.cur(L.st); if (c) { io.to('ar:' + L.id).emit('arenaNote', { id: L.id, text: `${c} uzun süre oynamadı, oyundan düştü` }); arenaDrop(L, c, 'Süre doldu'); } }
    if (L.state === 'end' && now - L.endAt > 10 * 60e3) { for (const n of [...L.players]) arenaDrop(L, n, 'Lobi kapandı'); arenas.delete(L.id); }
    if (L.state === 'lobby' && now - L.at > 60 * 60e3) { for (const n of [...L.players]) arenaDrop(L, n, 'Lobi uzun süre başlamadı'); }
  }
}, 1000);
// Gerçek zamanlı oyunlar (60Hz akıcı hokey, 10Hz bilek güreşi)
{ let lastRt = Date.now(), acc10 = 0, acc30 = 0;
  setInterval(() => {
    const now = Date.now(), dt = Math.min(0.05, (now - lastRt) / 1000); lastRt = now;
    acc10 += dt; const slow10 = acc10 >= 0.1; if (slow10) acc10 = 0;
    acc30 += dt; const tick30 = acc30 >= 0.031, dt30 = Math.min(0.06, acc30); if (tick30) acc30 = 0; // geçen gerçek süre kadar ilerle (oyun hızı yayın sıklığına bağlı kalmasın)
    for (const L of arenas.values()) {
      const E = ARENA_GAMES[L.game]; if (!E.rt || L.state !== 'play') continue;
      if (E.hz === 10 && !slow10) continue;
      if (E.hz === 30 && !tick30) continue;
      E.tick(L.st, E.hz === 10 ? 0.1 : E.hz === 30 ? dt30 : dt);
      io.to('ar:' + L.id).volatile.emit('arT', { id: L.id, g: E.view(L.st) });
      if (L.st.over) arenaFinish(L);
    }
  }, 16);
}
// Genel sıralama: her oyundaki (puan - 1000) toplamı + oynanan maç başına 2 (en az 3 maç oynamış olanlar)
let arenaTopCache = null;
function arenaOverall() {
  if (arenaTopCache && Date.now() - arenaTopCache.t < 60e3) return arenaTopCache.list;
  const list = Object.values(db.users).filter(u => u.arena && !u.bot).map(u => { let pts = 0, p = 0, w = 0; for (const a of Object.values(u.arena)) { pts += a.r - 1000; p += a.p; w += a.w; } return { name: u.name, pts: Math.round(pts + p * 2), p, w }; })
    .filter(x => x.p >= 3).sort((a, b) => b.pts - a.pts || b.w - a.w);
  arenaTopCache = { t: Date.now(), list }; return list;
}
const arenaChampions = () => new Set(arenaOverall().slice(0, 10).filter(x => x.pts > 0).map(x => x.name));
// Güncelleme sırasında sıra tabanlı oyunlar kaybolmasın
function arenaSave() {
  try { const o = [...arenas.values()].filter(L => !ARENA_GAMES[L.game].rt || L.state !== 'play').map(L => ({ ...L, away: {} })); fs.writeFileSync(ARENA_FILE, JSON.stringify({ at: Date.now(), l: o })); } catch (e) { console.error('arena kaydı', e.message); }
}
try { const j = JSON.parse(fs.readFileSync(ARENA_FILE, 'utf8')); if (Date.now() - j.at < 15 * 60e3) for (const L of j.l) { if (ARENA_GAMES[L.game]) { L.turnAt = Date.now(); arenas.set(L.id, L); } } fs.unlinkSync(ARENA_FILE); } catch {}

function gracefulShutdown(why = 'güncelleme') {
  if (shuttingDown) return; shuttingDown = true;
  console.log('Sunucu düzgün kapanıyor:', why);
  try { const o = {}; for (const [k, v] of botSessions) o[k] = { app: v.app, seq: v.seq }; fs.writeFileSync(GW_SESS_FILE, JSON.stringify({ at: Date.now(), s: o })); } catch {}
  // Kullanıcılara: birkaç saniyelik kesinti (uygulama "güncelleniyor" der, sesli oda kendiliğinden geri bağlanır)
  try { io.emit('serverRestart', { ms: 5000 }); } catch {}
  // Botlara: op 7 = yeniden bağlan (oturum korunur), 1012 = sunucu yeniden başlıyor
  for (const set of botConns.values()) for (const conn of set) { gwSend(conn, { op: 7, d: { bekle: 4000, sebep: 'Sunucu güncelleniyor' } }); try { conn.ws.close(1012, 'Sunucu güncelleniyor, birkaç saniye sonra yeniden bağlan'); } catch {} }
  try { flushDb(); } catch (e) { console.error('Kapanışta kayıt:', e.message); }
  STAT.close(); arenaSave();
  setTimeout(() => process.exit(0), 700);
}
// Güncelleyici sunucuyu öldürmeden önce bunu çağırır (sadece bu bilgisayardan, anahtarla)
const KAPAT_KEY_FILE = path.join(DATA_DIR, 'kapat.anahtar');
let kapatKey = ''; try { kapatKey = fs.readFileSync(KAPAT_KEY_FILE, 'utf8').trim(); } catch {}
if (!kapatKey) { kapatKey = crypto.randomBytes(24).toString('hex'); try { fs.writeFileSync(KAPAT_KEY_FILE, kapatKey); } catch {} }
app.post('/api/_kapat', (req, res) => {
  const ip = req.socket.remoteAddress || '';
  if (!/^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(ip) || req.get('x-kapat-anahtar') !== kapatKey) return res.status(404).end();
  res.json({ ok: true }); setTimeout(() => gracefulShutdown('güncelleyici'), 50);
});
// Güncelleyici yeniden başlatmak için sakin bir an bekler: seste kimse yokken (sadece bu bilgisayardan, anahtarla)
app.get('/api/_durum', (req, res) => {
  const ip = req.socket.remoteAddress || '';
  if (!/^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(ip) || req.get('x-kapat-anahtar') !== kapatKey) return res.status(404).end();
  let ses = 0; for (const [, m] of voice) ses += m.size;
  res.json({ ses, bagli: io.engine.clientsCount });
});
// ---- Oda yönetimi: kullanıcı arayüzü ve Bot API aynı kuralları kullanır ----
const CH_TYPE_IN = { text: 'text', yazi: 'text', yazili: 'text', 'yazılı': 'text', voice: 'voice', ses: 'voice', sesli: 'voice', stage: 'stage', sahne: 'stage', forum: 'forum' };
const SLOW_OK = [0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 3600];
function chBotView(s, c, bot) {
  return { id: c.id, ad: c.name, tur: c.type || 'text', konu: c.topic || '', kategori: c.cat || null, sunucu: s.id, ozel: everyoneDenied(ovOf(s, c), 'view'),
    yavasMod: c.slow || 0, limit: c.limit || 0, kategoriyleEsit: !!(c.sync && c.cat), izinAyarlari: ovView(ovOf(s, c)), ...(bot ? { yazabilir: chPerm(s, c, bot, 'send') } : {}) };
}
function chEvent(s, t, c) { // botlara oda olayları: ODA_OLUSTU / ODA_GUNCELLENDI / ODA_SILINDI
  if (!s || s.public) return;
  for (const n of s.members.filter(isBotUser)) { const a = appOf(n); if (!a || a.killed) continue;
    if (t === 'ODA_SILINDI') gwDispatch(a.id, t, { id: c.id, sunucu: s.id }); else if (seesChannel(s, c, a.bot)) gwDispatch(a.id, t, chBotView(s, c, a.bot)); }
}
function placeInCat(s, c, k) { // odayı kategorinin (ya da kategorisizlerin) sonuna taşı
  s.channels = s.channels.filter(x => x !== c);
  const last = s.channels.map(x => x.cat || null).lastIndexOf(k?.id || null);
  if (last >= 0) s.channels.splice(last + 1, 0, c);
  else if (k) { const ord = s.categories.indexOf(k); const after = s.channels.findIndex(x => x.cat && s.categories.findIndex(y => y.id === x.cat) > ord); s.channels.splice(after < 0 ? s.channels.length : after, 0, c); }
  else s.channels.unshift(c);
}
function addChannel(s, by, { name, type, cat, priv, topic } = {}) {
  if (s.channels.length >= 200) return { error: 'En fazla 200 oda olabilir' };
  type = CH_TYPE_IN[String(type || 'text').toLocaleLowerCase('tr')]; if (!type) return { error: 'Oda türü text, voice, stage ya da forum olmalı' };
  name = clean(name, 30); if (type === 'text' || type === 'forum') name = name.toLowerCase().replace(/\s+/g, '-');
  if (!name) return { error: 'Oda adı gerekli' };
  const k = cat ? s.categories.find(x => x.id === cat) : null; if (cat && !k) return { error: 'Kategori bulunamadı' };
  const c = { id: id(), name, type, perms: {}, sync: !!k && !priv };
  if (type === 'stage') c.topic = 'Sahne';
  if (topic) c.topic = clean(topic, 160);
  if (k) c.cat = k.id;
  if (priv) c.perms = { '@everyone': { view: false } };
  s.channels.push(c); placeInCat(s, c, k);
  audit(s, by, 'Oda oluşturdu', c.name); save(); pushServers(membersOf(s)); chEvent(s, 'ODA_OLUSTU', c);
  return { c };
}
function voiceModDo(s, me, name, action, to) { // kullanıcı arayüzü ve Bot API aynı kuralları kullanır
  const need = action === 'mute' || action === 'unmute' ? 'voiceMute' : 'voiceMove';
  if (!can(s, me, need)) return ({ error: need === 'voiceMute' ? 'Seste susturma yetkin yok' : 'Seste taşıma yetkin yok' });
  if (name !== me && (name === s.owner || !outranks(s, me, name))) return ({ error: 'Bu kişiye bunu yapamazsın' });
  const chIds = s.channels.filter(c => voiceLike(c.type)).map(c => c.id);
  const cur = chIds.find(ch => [...(voice.get(ch)?.values() || [])].includes(name));
  if (!cur) return ({ error: 'Bu kişi şu an bu sunucuda seste değil' });
  if (action === 'mute' || action === 'unmute') {
    const on = action === 'mute';
    on ? srvMuted.add(s.id + '|' + name) : srvMuted.delete(s.id + '|' + name);
    for (const [sid, n] of voice.get(cur) || []) if (n === name && botVoice.has(sid)) gwSend(botVoice.get(sid).conn, { op: 0, t: 'SES_SUSTURMA', d: { susturuldu: on, kim: me } });
    for (const [sid, n] of voice.get(cur) || []) if (n === name) { io.to(sid).emit('srvMute', { on, by: me }); if (on) { voiceFlags.set(sid, { ...(voiceFlags.get(sid) || {}), m: true }); } }
    pushFlags();
    audit(s, me, on ? 'Seste susturdu' : 'Ses susturmasını kaldırdı', name);
  } else if (action === 'disconnect') {
    voiceKick([cur], name, `${me} seni sesli odadan çıkardı`); audit(s, me, 'Sesten çıkardı', name);
  } else if (action === 'move') {
    const c = s.channels.find(x => x.id === to && voiceLike(x.type)); if (!c || c.id === cur) return ({ error: 'Geçersiz oda' });
    if (!chPerm(s, c, me, 'connect')) return ({ error: 'Bu odaya giriş yetkin yok' });
    if (!seesChannel(s, c, name)) return ({ error: `${name} bu odayı göremiyor` });
    if (timedOut(s, name)) return ({ error: `${name} susturulduğu için sesli odaya giremiyor` });
    if (c.limit && (voice.get(c.id)?.size || 0) >= c.limit) return ({ error: `${c.name} dolu` });
    const pass = !chPerm(s, c, name, 'connect');
    for (const [sid, n] of voice.get(cur) || []) if (n === name && botVoice.has(sid)) { const a = db.apps?.[botVoice.get(sid).appId]; if (a) botVoiceJoin(a, c.id, botVoice.get(sid).conn, true); }
    for (const [sid, n] of voice.get(cur) || []) if (n === name && !botVoice.has(sid)) {
      if (pass) voicePass.set(sid, { ch: c.id, until: Date.now() + 60000 });
      io.to(sid).emit('voiceMoveTo', { ch: c.id, by: me });
    }
    audit(s, me, 'Sesli odaya taşıdı', `${name} → ${c.name}`);
  } else return ({ error: 'Geçersiz işlem' });
  save(); return { ok: true };
}
function removeChannel(s, by, c) {
  if (c.type === 'text' && s.channels.filter(x => x.type === 'text').length < 2) return { error: 'En az bir yazılı oda kalmalı' };
  if (nukeCheck(s, by, 'oda silme')) return { error: 'Kanka Bot: Kısa sürede çok fazla oda silindi, işlem durduruldu.' };
  s.channels = s.channels.filter(x => x !== c); delete db.messages[c.id]; delete db.playlists[c.id];
  for (const x of db.ozel?.[c.id] || []) ozelIdx.delete(x.msg.id); if (db.ozel) delete db.ozel[c.id];
  if (s.afk?.ch === c.id) s.afk = null;
  voiceKick([c.id], null, 'Bulunduğun ses odası silindi');
  audit(s, by, 'Oda sildi', c.name); save(); pushServers(membersOf(s)); chEvent(s, 'ODA_SILINDI', c);
  return { ok: true };
}
function botServerView(a, s) {
  return { id: s.id, ad: s.name, simge: s.iconImg || null, sahip: s.owner, uyeSayisi: humans(s.members).length, ekleyen: botAdder(s, a.bot),
    energy: { toplam: energyTotal(s), seviye: energyLevel(s) },
    odalar: s.channels.filter(c => seesChannel(s, c, a.bot)).map(c => ({ id: c.id, ad: c.name, tur: c.type, konu: c.topic || '', kategori: c.cat || null, yazabilir: chPerm(s, c, a.bot, 'send'), ozel: everyoneDenied(ovOf(s, c), 'view') })),
    roller: (s.customRoles || []).map(roleView), izinler: [...permsOf(s, a.bot)] };
}
const roleView = (r, i, all) => ({ id: r.id, ad: r.name, renk: r.color || null, sira: i, simge: r.icon || null, ayriGoster: !!r.hoist, etiketlenebilir: r.mentionable !== false, izinler: r.perms || [], bot: r.managed || null });
// Botu kim ekledi: yeni eklemelerde kayıtlı, eskilerde denetim kaydından bulunur
function botAdder(s, bot) {
  const b = s.botBy?.[bot] || (() => { const x = (s.audit || []).find(e => e.action === 'Bot ekledi' && e.target === bot); return x ? { by: x.by, at: x.time } : null; })();
  if (!b) return null; const u = db.users[b.by]; return { id: u ? uidOf(u) : null, ad: b.by, gorunenAd: u?.displayName || b.by, zaman: b.at };
}
// Sunucudaki sesli odalar: kim hangi odada, mikrofon/kulaklık/kamera/yayın durumu
function botVoiceView(a, s) {
  const out = {};
  for (const c of s.channels) { if (!voiceLike(c.type) || !seesChannel(s, c, a.bot)) continue; const room = voice.get(c.id); if (!room?.size) continue;
    const seen = new Set(); out[c.id] = [];
    for (const [sid, n] of room) { if (seen.has(n)) continue; seen.add(n); const f = voiceFlags.get(sid) || {}, md = voiceMedia.get(sid) || {}, u = db.users[n];
      out[c.id].push({ id: u ? uidOf(u) : null, ad: n, mikKapali: !!f.m, sagir: !!f.d, sunucuSusturdu: srvMuted.has(s.id + '|' + n), kamera: !!md.cam, yayin: !!md.screen }); } }
  return out;
}
// ---- Botlar sesli odada (müzik vb.): bot sanal bir katılımcı olur. Ses bottan kullanıcılara doğrudan (WebRTC) gider,
// Kanka sunucusu sadece bağlantı bilgisini (sinyal) taşır; ses verisi sunucudan geçmez. sid '~' ile başlar ki tarayıcı her zaman "kibar" taraf olsun.
const botVoice = new Map(); // sid -> { appId, ch, conn, name }
const botVoiceOfApp = appId => { for (const [sid, v] of botVoice) if (v.appId === appId) return { sid, ...v }; return null; };
function botVoiceJoin(a, chId, conn, moved) {
  const f = findChannel(chId); if (!f || f.s.public || !f.s.members.includes(a.bot)) return { error: 'Oda bulunamadı' };
  const { s, c } = f; if (c.type !== 'voice') return { error: 'Bot sadece sesli odalara (voice) girebilir' };
  if (!seesChannel(s, c, a.bot)) return { error: 'Bot bu odayı göremiyor' };
  if (!moved && !chPerm(s, c, a.bot, 'connect')) return { error: 'Botun bu odaya bağlanma izni yok' };
  if (!chPerm(s, c, a.bot, 'speak')) return { error: 'Botun bu odada konuşma izni yok' };
  if (timedOut(s, a.bot)) return { error: 'Bot bu sunucuda susturulmuş' };
  const old = botVoiceOfApp(a.id);
  if (old?.ch === chId) return { ok: true };
  if (!moved && c.limit && (voice.get(chId)?.size || 0) >= c.limit && !can(s, a.bot, 'manageChannels')) return { error: `Oda dolu (${c.limit}/${c.limit})` };
  if (old) botVoiceLeave(a.id, moved ? 'taşındı' : 'başka odaya geçti', true);
  const sid = '~' + a.id + crypto.randomBytes(4).toString('hex'), room = voice.get(chId) || new Map();
  const peers = [...room].filter(([x]) => !botVoice.has(x)).map(([x, name]) => ({ sid: x, ad: name }));
  room.set(sid, a.bot); voice.set(chId, room); botVoice.set(sid, { appId: a.id, ch: chId, conn, name: a.bot });
  io.to('v:' + chId).emit('voiceJoined', { sid, name: a.bot });
  pushVoice();
  gwSend(conn, { op: 0, t: 'SES_BAGLANDI', d: { oda: chId, sunucu: s.id, sid, ice: iceServers(), kisiler: peers, tasindi: !!moved } });
  if (srvMuted.has(s.id + '|' + a.bot)) gwSend(conn, { op: 0, t: 'SES_SUSTURMA', d: { susturuldu: true } });
  return { ok: true };
}
function botVoiceLeave(appId, why, quiet) {
  const bv = botVoiceOfApp(appId); if (!bv) return;
  botVoice.delete(bv.sid); const room = voice.get(bv.ch); if (room) { room.delete(bv.sid); if (!room.size) voice.delete(bv.ch); }
  io.to('v:' + bv.ch).emit('voiceLeft', bv.sid); pushVoice();
  if (!quiet || why) gwSend(bv.conn, { op: 0, t: 'SES_AYRILDI', d: { oda: bv.ch, sebep: why || '' } });
}
function botVoiceTapPeers(ch, ev, d, except) { // odaya giren/çıkan kullanıcıyı sesteki bota bildir
  for (const [sid, bv] of botVoice) { if (bv.ch !== ch) continue;
    if (ev === 'voiceLeft') { if (d !== sid) gwSend(bv.conn, { op: 0, t: 'SES_KISI_AYRILDI', d: { sid: d } }); }
    else if (d?.sid && d.sid !== sid && !botVoice.has(d.sid)) gwSend(bv.conn, { op: 0, t: ev === 'voiceRekey' ? 'SES_KISI_YENILENDI' : 'SES_KISI_KATILDI', d: { sid: d.sid, ad: d.name, eski: d.old || null } }); }
}
const voiceSig = new Map();
function botVoiceTap() { // ses durumu değişince "ses" niyetiyle bağlı botlara SES_DURUMU (sadece değişen sunucular)
  if (!botConns.size) return;
  for (const [appId, set] of botConns) { if (![...set].some(c => c.ready && c.intents.has('ses'))) continue; const a = db.apps?.[appId]; if (!a || a.killed) continue;
    for (const s of botServers(a)) { const v = botVoiceView(a, s), sig = JSON.stringify(v), k = appId + '|' + s.id;
      if ((voiceSig.get(k) ?? '{}') === sig) continue; voiceSig.set(k, sig); if (voiceSig.size > 20000) voiceSig.clear();
      gwDispatch(appId, 'SES_DURUMU', { sunucu: s.id, odalar: v }, c => c.intents.has('ses')); } }
}
function botEnergy(s, name, delta) { // Energy (boost) gönderildi / geri çekildi
  if (!s || s.public || !delta) return; const u = db.users[name];
  for (const n of (s.members || []).filter(isBotUser)) { const a = appOf(n); if (!a || a.killed) continue;
    gwDispatch(a.id, delta > 0 ? 'ENERGY_GONDERILDI' : 'ENERGY_GERI_CEKILDI', { sunucu: s.id, uye: { id: u ? uidOf(u) : null, ad: name }, adet: Math.abs(delta), uyeninToplami: s.energy?.[name] || 0, toplam: energyTotal(s), seviye: energyLevel(s) }, c => c.intents.has('uyeler')); }
}
const memberView = (s, n) => { const u = db.users[n] || {}, vc = voiceRoomOf(n); return { id: db.users[n] ? uidOf(u) : null, ad: n, gorunenAd: u.displayName || n, bot: !!u.bot, avatar: u.avatar || null, roller: s.memberRoles?.[n] || [], izinler: [...permsOf(s, n)], sahip: s.owner === n, yonetici: permsOf(s, n).has('administrator') || s.owner === n, energy: s.energy?.[n] || 0, sesOdasi: vc && s.channels.some(c => c.id === vc) ? vc : null, katildi: s.joinedAt?.[n] || null, susturulduBitis: (s.timeouts?.[n] || 0) > Date.now() ? s.timeouts[n] : null }; };
// Mesaj olaylarını botlara ilet: socket.io yayınlarına kanca (her yerden atılan mesaj, düzenleme ve silme yakalanır)
const lastBotText = new Map();
{
  const BO = Object.getPrototypeOf(io.to('__kanca__')), orig = BO.emit;
  BO.emit = function (ev, ...args) {
    const d = args[0];
    if ((ev === 'message' || ev === 'update' || ev === 'remove') && d && typeof d.channelId === 'string' && this.rooms?.has?.(d.channelId) && !d.msg?.ephemeral) { try { botTap(ev, d); } catch (e) { logCrash('botTap', e); } }
    if (botVoice.size && (ev === 'voiceJoined' || ev === 'voiceLeft' || ev === 'voiceRekey')) { try { for (const r of this.rooms || []) if (typeof r === 'string' && r.startsWith('v:')) botVoiceTapPeers(r.slice(2), ev, d, this.exceptRooms); } catch (e) { logCrash('botVoicePeers', e); } }
    return orig.call(this, ev, ...args);
  };
}
function botsIn(chId) {
  if (chId.startsWith('dm:')) return dmPeers(chId).filter(isBotUser).map(n => ({ a: appOf(n), s: null, c: null })).filter(x => x.a && !x.a.killed);
  const f = findChannel(chId); if (!f || f.s.public) return [];
  return f.s.members.filter(isBotUser).map(n => ({ a: appOf(n), s: f.s, c: f.c })).filter(x => x.a && !x.a.killed && seesChannel(x.s, x.c, x.a.bot));
}
function botTap(ev, d) {
  const targets = botsIn(d.channelId); if (!targets.length) return;
  for (const { a } of targets) {
    const dm = d.channelId.startsWith('dm:'), need = dm ? 'dm' : 'mesajlar';
    if (ev === 'message') { const m = d.msg; if (!m?.author || m.kind === 'system') continue; lastBotText.set(m.id, m.text || '');
      for (const conn of botConnsOf(a.id)) if (conn.ready && conn.intents.has(need)) gwDispatch(a.id, 'MESAJ_GELDI', msgForBot(a, d.channelId, m, dm || (conn.intents.has('icerik') && contentOk(a))), x => x === conn); }
    else if (ev === 'update') { const m = d.msg; if (!m) continue; const t = (m.text || '') + JSON.stringify(m.embeds || []); if (lastBotText.get(m.id) === t) continue; lastBotText.set(m.id, t);
      for (const conn of botConnsOf(a.id)) if (conn.ready && conn.intents.has(need)) gwDispatch(a.id, 'MESAJ_DUZENLENDI', msgForBot(a, d.channelId, m, dm || (conn.intents.has('icerik') && contentOk(a))), x => x === conn); }
    else if (ev === 'remove') gwDispatch(a.id, 'MESAJ_SILINDI', { id: d.msgId, oda: d.channelId }, c => c.intents.has(need));
  }
  if (lastBotText.size > 20000) lastBotText.clear();
}
function botReact(chId, msg, emoji, user, added) {
  for (const { a } of botsIn(chId)) gwDispatch(a.id, added ? 'TEPKI_EKLENDI' : 'TEPKI_KALDIRILDI', { mesaj: msg.id, oda: chId, emoji, kullanici: user }, c => c.intents.has('tepkiler'));
}
function botMember(s, name, kind, meta) { // üye katıldı / ayrıldı / güncellendi; bot atıldıysa kendisine ve sahibine bildir. meta: { by, islem: 'atildi'|'yasaklandi'|'ayrildi', sebep }
  if (!s || s.public) return;
  const who = meta?.by ? { id: db.users[meta.by] ? uidOf(db.users[meta.by]) : null, ad: meta.by, gorunenAd: db.users[meta.by]?.displayName || meta.by } : null;
  const why = meta ? { islem: meta.islem || 'ayrildi', kaldiran: who, sebep: meta.sebep || '', zaman: Date.now() } : { islem: 'ayrildi', kaldiran: null, sebep: '', zaman: Date.now() };
  if (kind === 'leave' && isBotUser(name)) { const ek = botAdder(s, name); if (s.botBy) delete s.botBy[name]; const a = appOf(name);
    if (a) { s.customRoles = (s.customRoles || []).filter(r => r.managed !== a.id); gwDispatch(a.id, 'SUNUCUDAN_CIKARILDI', { id: s.id, ad: s.name, ekleyen: ek, ...why }); devStatsSync(a.owner);
      if (a.owner !== meta?.by) botDm(a.owner, { title: `🤖 ${a.bot} bir sunucudan çıkarıldı`, tone: 'warn', text: `${s.name} sunucusundan ${who ? who.ad + ' tarafından ' : ''}${why.islem === 'yasaklandi' ? 'yasaklandı' : 'çıkarıldı'}${why.sebep ? ` (sebep: ${why.sebep})` : ''}. botun artık ${botServers(a).length} sunucuda.` }); }
    return; }
  for (const n of s.members.filter(isBotUser)) { const a = appOf(n); if (!a || a.killed || n === name) continue;
    const t = kind === 'join' ? 'UYE_KATILDI' : kind === 'leave' ? 'UYE_AYRILDI' : 'UYE_GUNCELLENDI';
    gwDispatch(a.id, t, { sunucu: s.id, uye: kind === 'leave' ? { id: db.users[name] ? uidOf(db.users[name]) : null, ad: name } : memberView(s, name), ...(kind === 'leave' ? why : {}) }, c => c.intents.has('uyeler'));
    if (kind === 'join' && !a.verified) { const r = reachOf(a); if (r > REACH_MAX && !a.reachWarned) { a.reachWarned = Date.now(); botDm(a.owner, { title: `🤖 ${a.bot} ${REACH_MAX} kişiyi geçti`, tone: 'warn', text: `botun artık ${r} kişiye ulaşıyor. doğrulanmamış botlar yeni sunuculara eklenemez. Geliştirici Portalı'ndan doğrulama isteyebilirsin.` }); } }
  }
}
// ---- Bot mesajı gönderme ----
// Mesajın kendisi hangi bottan geldiğini söylesin (kullanıcı listesine bakmadan): ad, görünen ad, doğrulama, sahip
const appInfoOf = a => ({ id: a.id, ad: a.bot, gorunenAd: db.users[a.bot]?.displayName || a.name || a.bot, dogrulandi: !!a.verified, sahip: a.owner || null });
function appPost(a, chId, body, extra = {}) {
  const u = db.users[a.bot];
  const files = botFiles(a, body.files), emo = appEmo(a, body.text, body.embeds);
  if ((body.files?.length || 0) > files.length) body.uyari ||= 'ekler: bazı dosyalar bulunamadı ya da bu bota ait değil (önce bu botla POST /dosyalar ile yükle)';
  const msg = { id: id(), author: a.bot, color: u.color, time: Date.now(), kind: 'text', reactions: {}, app: a.id, appInfo: appInfoOf(a), text: body.text || '', ...(files.length ? { files } : {}), ...(emo ? { emo } : {}), ...(body.embeds?.length ? { embeds: body.embeds } : {}), ...(body.comps?.length ? { comps: body.comps } : {}), ...extra };
  if (!msg.text && !msg.embeds && !msg.comps && !msg.files && !msg.loading) return { error: body?.uyari ? `Mesaj boş kaldı: ${body.uyari}` : 'Boş mesaj: icerik, kartlar, ekler ya da bilesenler gerekli' };
  const list = (db.messages[chId] ||= []); list.push(msg); if (list.length > 2000) list.shift();
  save(); io.to(chId).emit('message', { channelId: chId, msg });
  if (chId.startsWith('dm:')) for (const n of dmPeers(chId)) { io.to('user:' + n).emit('dms', dmsFor(n)); if (n !== a.bot) notifyUser(n, { from: a.bot, text: msg.text || msg.embeds?.[0]?.baslik || 'Yeni mesaj', channelId: chId, where: 'özel mesaj', dm: true }); }
  else { const f = findChannel(chId); if (f) for (const n of membersOf(f.s)) if (n !== a.bot && canAccess(n, chId)) io.to('user:' + n).emit('chanActivity', { channelId: chId, serverId: f.s.id });
    for (const n of new Set((msg.text.match(/@([\p{L}\p{N}_.-]{2,20})/gu) || []).map(x => x.slice(1)))) if (f && f.s.members.includes(n) && !isBotUser(n) && seesChannel(f.s, f.c, n)) notifyUser(n, { from: a.bot, text: msg.text.slice(0, 160), channelId: chId, where: `${f.s.name} › ${f.c.name}`, mention: true }); }
  return { msg };
}
function ephPost(a, chId, user, body, extra = {}) { // sadece tek kişinin göreceği mesaj (kaydedilmez)
  const emo = appEmo(a, body.text, body.embeds), files = botFiles(a, body.files);
  const msg = { id: 'e' + id(), author: a.bot, color: db.users[a.bot]?.color, time: Date.now(), kind: 'text', reactions: {}, app: a.id, appInfo: appInfoOf(a), ephemeral: true, text: body.text || '', ...(emo ? { emo } : {}), ...(files.length ? { files } : {}), ...(body.embeds?.length ? { embeds: body.embeds } : {}), ...(body.comps?.length ? { comps: body.comps } : {}), ...extra };
  ephMsgs.set(msg.id, { msg, chId, user, at: Date.now() }); if (ephMsgs.size > 5000) ephMsgs.delete(ephMsgs.keys().next().value);
  io.to('user:' + user).emit('message', { channelId: chId, msg });
  return msg;
}
const ephMsgs = new Map();
// Kalıcı gizli mesaj: sadece bir kişi görür ama 15 dakikada silinmez (ticket paneli, kişiye özel bilgi). db.ozel[oda] = [{ user, msg }]
const OZEL_PER_CH = 300, OZEL_PER_USER = 30;
const ozelIdx = new Map(); for (const [ch, l] of Object.entries(db.ozel || {})) for (const x of l) ozelIdx.set(x.msg.id, { msg: x.msg, chId: ch, user: x.user, kalici: true });
const ephGet = mid => ephMsgs.get(mid) || ozelIdx.get(mid);
function ozelPost(a, chId, user, body, extra = {}) {
  const emo = appEmo(a, body.text, body.embeds), files = botFiles(a, body.files);
  const msg = { id: 'k' + id(), author: a.bot, color: db.users[a.bot]?.color, time: Date.now(), kind: 'text', reactions: {}, app: a.id, appInfo: appInfoOf(a), ephemeral: true, kalici: true, text: body.text || '', ...(emo ? { emo } : {}), ...(files.length ? { files } : {}), ...(body.embeds?.length ? { embeds: body.embeds } : {}), ...(body.comps?.length ? { comps: body.comps } : {}), ...extra };
  db.ozel ||= {}; const mine = (db.ozel[chId] || []).filter(x => x.user === user); if (mine.length >= OZEL_PER_USER) ozelDel(mine[0].msg.id);
  if ((db.ozel[chId] || []).length >= OZEL_PER_CH) ozelDel(db.ozel[chId][0].msg.id);
  (db.ozel[chId] ||= []).push({ user, msg }); ozelIdx.set(msg.id, { msg, chId, user, kalici: true }); save();
  io.to('user:' + user).emit('message', { channelId: chId, msg });
  return msg;
}
function ozelDel(mid) {
  const e = ozelIdx.get(mid); if (!e) return false; ozelIdx.delete(mid);
  const l = db.ozel?.[e.chId]; if (l) { const i = l.findIndex(x => x.msg.id === mid); if (i >= 0) l.splice(i, 1); if (!l.length) delete db.ozel[e.chId]; }
  save(); io.to('user:' + e.user).emit('remove', { channelId: e.chId, msgId: mid }); return true;
}
const ozelFor = (chId, user) => (db.ozel?.[chId] || []).filter(x => x.user === user).map(x => x.msg);
// ---- Etkileşimler (komut, buton, seçim, form) ----
const inters = new Map();
setInterval(() => { const now = Date.now(); for (const [k, x] of inters) if (now - x.at > INTER_TTL) inters.delete(k); for (const [k, x] of ephMsgs) if (now - x.at > INTER_TTL) ephMsgs.delete(k); }, 60e3);
function newInter(a, type, user, chId, data, msg) {
  const f = findChannel(chId), it = { id: id() + id(), token: crypto.randomBytes(24).toString('hex'), app: a.id, type, user, chId, sid: f?.s.id || null, data, msgId: msg?.id || null, eph: !!msg?.ephemeral, at: Date.now(), done: false, deferred: null };
  inters.set(it.id, it);
  const u = db.users[user] || {};
  const payload = { id: it.id, token: it.token, tur: type, oda: chId, sunucu: it.sid, dm: chId.startsWith('dm:'),
    kullanici: { id: db.users[user] ? uidOf(u) : null, ad: user, gorunenAd: u.displayName || user, avatar: u.avatar || null, roller: f ? f.s.memberRoles?.[user] || [] : [], izinler: f ? [...permsOf(f.s, user)] : [] },
    veri: data, mesaj: msg ? msgForBot(a, chId, msg, true) : null };
  setTimeout(() => { if (!it.done && !it.deferred) ephWhisper(user, chId, `${a.bot} cevap vermedi. Bot kapalı ya da yavaş olabilir.`); }, INTER_WAIT + 400);
  if (botConnsOf(a.id).length) gwDispatch(a.id, type === 'KOMUT' ? 'KOMUT' : type === 'FORM' ? 'FORM' : type === 'SECIM' ? 'SECIM' : 'BUTON', payload);
  else if (a.interUrl) interHttp(a, payload).then(r => r && interRespond(it, r)).catch(() => {});
  else { it.done = true; ephWhisper(user, chId, `${a.bot} şu an çevrimdışı.`); }
  if (type === 'KOMUT') { appCount(a, user); save(); }
  return it;
}
const ephWhisper = (user, chId, text) => io.to('user:' + user).emit('message', { channelId: chId, msg: { id: 'w' + id(), author: BOT_NAME, kind: 'bot', time: Date.now(), ephemeral: true, bot: { title: '', text, plain: true, tone: 'warn' } } });
// HTTP ile etkileşim: bot sürekli bağlı kalmadan, Kanka isteği adresine POST eder (imzalı) ve cevabı aynı istekte alır
function interHttp(a, payload) {
  return new Promise(res => {
    let u; try { u = new URL(a.interUrl); } catch { return res(null); }
    const body = JSON.stringify(payload), ts = String(Math.floor(Date.now() / 1000)), sig = crypto.createHmac('sha256', a.secret).update(ts + '.' + body).digest('hex');
    const mod = u.protocol === 'https:' ? require('https') : http;
    const rq = mod.request(u, { method: 'POST', lookup: process.env.BOT_HTTP_TEST === '1' ? undefined : safeLookup, timeout: INTER_WAIT, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'KankaBot/1.0', 'X-Kanka-Zaman': ts, 'X-Kanka-Imza': sig } }, r => {
      let buf = ''; r.setEncoding('utf8'); r.on('data', c => { buf += c; if (buf.length > 200e3) rq.destroy(); }); r.on('end', () => { try { res(r.statusCode < 300 ? JSON.parse(buf || 'null') : null); } catch { res(null); } });
    });
    rq.on('timeout', () => rq.destroy()); rq.on('error', () => res(null)); rq.end(body);
  });
}
function interRespond(it, b) {
  const a = db.apps[it.app]; if (!a) return { error: 'Uygulama yok', code: 404 };
  const tur = b?.tur ?? b?.type ?? 'mesaj', body = msgBody(b?.veri ?? b?.data ?? b), gizli = !!(b?.gizli ?? b?.ephemeral ?? (b?.veri ?? b?.data)?.gizli), kalici = !!(b?.kalici ?? (b?.veri ?? b?.data)?.kalici) && !it.chId.startsWith('dm:');
  if (tur === 'PONG') return { ok: true };
  if (tur === 'form') {
    if (it.done) return { error: 'Bu etkileşim zaten cevaplandı', code: 400 };
    const f = b?.form ?? b?.veri ?? b;
    const alanlar = (Array.isArray(f?.alanlar) ? f.alanlar : []).slice(0, 5).map(x => ({ id: clean(x?.id, 60), etiket: clean(x?.etiket, 60), tur: x?.tur === 'uzun' ? 'uzun' : PICK_TUR[x?.tur] || 'kisa', zorunlu: x?.zorunlu !== false, yerTutucu: clean(x?.yerTutucu, 100), min: Math.max(0, parseInt(x?.min) || 0), max: Math.min(4000, parseInt(x?.max) || 400), deger: clean(x?.deger, 4000) })).filter(x => x.id && x.etiket);
    if (!alanlar.length) return { error: 'Form için en az bir alan gerekli', code: 400 };
    it.done = true; it.form = { id: clean(f?.id, 100) || 'form', baslik: clean(f?.baslik, 60) || a.bot, tipler: Object.fromEntries(alanlar.map(x => [x.id, x.tur])), zorunlu: alanlar.filter(x => x.zorunlu).map(x => x.id) };
    io.to('user:' + it.user).emit('appForm', { iid: it.id, app: a.id, bot: a.bot, baslik: it.form.baslik, alanlar });
    return { ok: true };
  }
  if (tur === 'bekle') {
    if (it.done) return { error: 'Bu etkileşim zaten cevaplandı', code: 400 };
    it.done = true; it.deferred = gizli ? ephPost(a, it.chId, it.user, { text: '' }, { loading: true, inter: it.type === 'KOMUT' ? { user: it.user, cmd: it.data?.ad } : undefined }) : appPost(a, it.chId, { text: '' }, { loading: true, inter: it.type === 'KOMUT' ? { user: it.user, cmd: it.data?.ad } : undefined }).msg;
    return { ok: true };
  }
  if (tur === 'guncelle') { // butona basılan mesajı yerinde değiştir
    if (it.done) return { error: 'Bu etkileşim zaten cevaplandı', code: 400 };
    if (!it.msgId) return { error: 'Güncellenecek mesaj yok (sadece buton/seçim için)', code: 400 };
    it.done = true; return editAppMsg(a, it.chId, it.msgId, b?.veri ?? b?.data ?? b, it.user);
  }
  if (it.done) return { error: 'Bu etkileşim zaten cevaplandı; bekle ile başladıysan mesajı düzenle', code: 400 };
  if (!body.text && !body.embeds.length && !body.comps.length) return { error: 'Boş cevap', code: 400 };
  it.done = true;
  const inter = it.type === 'KOMUT' ? { user: it.user, cmd: it.data?.ad } : undefined;
  if (gizli) { const em = (kalici ? ozelPost : ephPost)(a, it.chId, it.user, body, { inter }); return { ok: true, mesaj: em.id }; }
  const f = findChannel(it.chId); if (f && !chPerm(f.s, f.c, a.bot, 'send')) { ephPost(a, it.chId, it.user, body, { inter }); return { ok: true, not: 'Botun bu odada yazma izni yok, cevap sadece kullanıcıya gösterildi' }; }
  const r = appPost(a, it.chId, body, { inter }); return r.error ? { error: r.error, code: 400 } : { ok: true, mesaj: r.msg.id };
}
function editAppMsg(a, chId, msgId, b, user) {
  const body = msgBody(b), e = ephGet(msgId);
  if (e) { const m = e.msg; if (m.app !== a.id) return { error: 'Bu mesaj botun değil', code: 403 }; Object.assign(m, { text: body.text, embeds: body.embeds.length ? body.embeds : undefined, comps: body.comps.length || Array.isArray(b?.bilesenler ?? b?.components) ? body.comps : m.comps, loading: false, edited: !!m.text });
    if (e.kalici) save(); io.to('user:' + e.user).emit('update', { channelId: e.chId, msg: m }); return { ok: true }; }
  const m = findMsg(chId, msgId); if (!m || m.author !== a.bot) return { error: 'Mesaj bulunamadı ya da botun değil', code: 404 };
  if (!body.text && !body.embeds.length && !body.comps.length && !Array.isArray(b?.bilesenler ?? b?.components)) return { error: body.uyari ? `Mesaj boş kaldı: ${body.uyari}` : 'Boş mesaj', code: 400 };
  m.text = body.text; m.emo = appEmo(a, body.text, body.embeds); if (body.embeds.length || Array.isArray(b?.kartlar ?? b?.embeds)) m.embeds = body.embeds; if (Array.isArray(b?.bilesenler ?? b?.components)) m.comps = body.comps;
  if (!m.loading) m.edited = true; m.loading = false; save(); io.to(chId).emit('update', { channelId: chId, msg: m });
  return { ok: true };
}
// ---- Komut kayıtları ----
function cleanCmds(list) {
  if (!Array.isArray(list)) return { error: 'Komut listesi dizi olmalı' };
  if (list.length > CMD_MAX) return { error: `En fazla ${CMD_MAX} komut` };
  const out = [], names = new Set();
  for (const c of list) {
    const ad = String(c?.ad ?? c?.name ?? '').toLocaleLowerCase('tr').trim();
    if (!/^[\p{Ll}\p{N}_-]{1,32}$/u.test(ad)) return { error: `Geçersiz komut adı: "${ad}" (küçük harf, rakam, _ ve -, en fazla 32)` };
    if (names.has(ad)) return { error: `Aynı adla iki komut: ${ad}` }; names.add(ad);
    const opts = [];
    for (const o of (Array.isArray(c.secenekler ?? c.options) ? (c.secenekler ?? c.options) : []).slice(0, 10)) {
      const oad = String(o?.ad ?? o?.name ?? '').toLocaleLowerCase('tr').trim(), tur = o?.tur ?? o?.type ?? 'yazi';
      if (!/^[\p{Ll}\p{N}_-]{1,32}$/u.test(oad)) return { error: `Geçersiz seçenek adı: "${oad}"` };
      if (!OPT_TYPES.includes(tur)) return { error: `Seçenek türü şunlardan biri olmalı: ${OPT_TYPES.join(', ')}` };
      opts.push({ ad: oad, aciklama: clean(o?.aciklama ?? o?.description, 100) || oad, tur, zorunlu: !!(o?.zorunlu ?? o?.required),
        secimler: (Array.isArray(o?.secimler ?? o?.choices) ? (o.secimler ?? o.choices) : []).slice(0, 25).map(x => ({ ad: clean(x?.ad ?? x?.name, 100), deger: x?.deger ?? x?.value })).filter(x => x.ad && x.deger !== undefined) });
    }
    opts.sort((x, y) => (y.zorunlu ? 1 : 0) - (x.zorunlu ? 1 : 0));
    out.push({ ad, aciklama: clean(c.aciklama ?? c.description, 100) || ad, secenekler: opts });
  }
  return { list: out };
}
function cmdsFor(s, viewer) { // istemcinin / listesine: bu sunucudaki botların komutları
  if (!s || s.public) return [];
  const out = [];
  for (const n of s.members.filter(isBotUser)) { const a = appOf(n); if (!a || a.killed) continue;
    for (const c of [...(a.cmds || []), ...(a.srvCmds?.[s.id] || [])]) out.push({ app: a.id, bot: a.bot, ...c }); }
  return out;
}
function dmCmdsFor(bot) { const a = appOf(bot); return a && !a.killed ? (a.cmds || []).map(c => ({ app: a.id, bot: a.bot, ...c })) : []; }
// Seçenek değerlerini türüne göre doğrula
function parseOpts(cmd, raw, s) {
  const out = {};
  for (const o of cmd.secenekler) {
    let v = raw?.[o.ad];
    if (v === undefined || v === null || v === '') { if (o.zorunlu) return { error: `"${o.ad}" gerekli` }; continue; }
    if (o.secimler.length) { const c = o.secimler.find(x => String(x.deger) === String(v) || x.ad === v); if (!c) return { error: `"${o.ad}" için geçersiz seçim` }; v = c.deger; }
    else if (o.tur === 'sayi' || o.tur === 'tamsayi') { v = Number(String(v).replace(',', '.')); if (!Number.isFinite(v) || (o.tur === 'tamsayi' && !Number.isInteger(v))) return { error: `"${o.ad}" ${o.tur === 'tamsayi' ? 'tam sayı' : 'sayı'} olmalı` }; }
    else if (o.tur === 'evethayir') v = v === true || /^(evet|true|1|açık|acik)$/i.test(String(v));
    else if (o.tur === 'kisi') { v = String(v).replace(/^@/, ''); if (!db.users[v] || (s && !s.members.includes(v))) return { error: `"${o.ad}": kişi bulunamadı` }; }
    else if (o.tur === 'oda') { const c = s?.channels.find(c => c.id === v || c.name === String(v).replace(/^#/, '')); if (!c) return { error: `"${o.ad}": oda bulunamadı` }; v = c.id; }
    else if (o.tur === 'rol') { const r = (s?.customRoles || []).find(r => r.id === v || r.name === String(v).replace(/^@/, '')); if (!r) return { error: `"${o.ad}": rol bulunamadı` }; v = r.id; }
    else v = clean(v, 1000);
    out[o.ad] = v;
  }
  return { out };
}
// ---- REST API ----
const apiHits = new Map();
function apiAuth(req, res) {
  const a = appByToken(String(req.headers.authorization || '').replace(/^Bot\s+/i, ''));
  if (!a) { res.status(401).json({ hata: 'Token geçersiz', error: 'Unauthorized' }); return null; }
  if (a.killed) { res.status(403).json({ hata: 'Bu bot Kanka ekibi tarafından durduruldu' + (a.killed.reason ? ': ' + a.killed.reason : '') }); return null; }
  const now = Date.now(), h = (apiHits.get(a.id) || []).filter(t => now - t < 1000);
  if (h.length >= 10) { if (a.over && now - a.over.t < 60e3) { a.over.n++; if (a.over.n > 300) { a.pausedUntil = now + 3600e3; secLog('bot-durdu', a.bot, 'sürekli hız sınırını aştı, 1 saat durduruldu'); } } else a.over = { t: now, n: 1 };
    res.set('Retry-After', '1'); res.status(429).json({ hata: 'Çok hızlı: saniyede en fazla 10 istek', tekrarDene: 1, retry_after: 1 }); return null; }
  if ((a.pausedUntil || 0) > now) { res.status(429).json({ hata: 'Bot sürekli sınırı aştığı için bir süre durduruldu', tekrarDene: Math.ceil((a.pausedUntil - now) / 1000) }); return null; }
  h.push(now); apiHits.set(a.id, h); a.lastApi = now;
  return a;
}
const api = express.Router();
api.use(express.json({ limit: '128kb' }));
api.use((err, req, res, next) => res.status(400).json({ hata: 'Geçersiz JSON' }));
const R = (fn) => (req, res) => { const a = apiAuth(req, res); if (!a) return; try { const r = fn(a, req, res); if (r && !res.headersSent) res.status(r.code || (r.error ? 400 : 200)).json(r.error ? { hata: r.error } : r); } catch (e) { logCrash('api ' + req.path, e); if (!res.headersSent) res.status(500).json({ hata: 'Sunucu hatası' }); } };
const botSrv = (a, sid) => { const s = db.servers.find(x => x.id === sid); return s && !s.public && s.members.includes(a.bot) ? s : null; };
function botChan(a, cid, need = 'view') {
  if (typeof cid !== 'string') return { error: 'Oda yok', code: 404 };
  if (cid.startsWith('dm:')) { if (!dmPeers(cid).includes(a.bot)) return { error: 'Oda bulunamadı', code: 404 }; return { dm: true }; }
  const f = findChannel(cid); if (!f || f.s.public || !f.s.members.includes(a.bot) || !seesChannel(f.s, f.c, a.bot)) return { error: 'Oda bulunamadı ya da bot göremiyor', code: 404 };
  if (need !== 'view' && !chPerm(f.s, f.c, a.bot, need)) return { error: `Botun bu odada "${need}" izni yok`, code: 403 };
  return f;
}
const chanHits = new Map();
// Kullanıcı yerine kalıcı kimliği de kabul et: /uyeler/123456789012345 ile /uyeler/ali aynı kişi
api.param('ad', (req, res, next, val) => { const n = nameOfRef(val); if (n) req.params.ad = n; next(); });
api.get('/kullanicilar/:ad', R((a, req) => {
  const n = req.params.ad, u = db.users[n];
  // Sadece botla ortak sunucusu olan ya da bota DM atmış kullanıcılar görülebilir
  if (!u || !(botServers(a).some(s => s.members.includes(n)) || msgRaw[dmId(a.bot, n)]?.some(m => m.author === n))) return { error: 'Kullanıcı bulunamadı', code: 404 };
  return { id: uidOf(u), ad: n, gorunenAd: u.displayName || n, avatar: u.avatar || null, bot: !!u.bot, olusturuldu: u.createdAt || null };
}));
// ---- Dosya yükleme: gövde ham dosya, adı X-Dosya-Adi başlığında. Dönen id mesajda ekler: [id] ile kullanılır ----
const rawBody = express.raw({ type: () => true, limit: FILE_MAX + 1024 });
api.post('/dosyalar', rawBody, R((a, req) => {
  if (limited('botdosya|' + a.id, 30, 60e3)) return { error: 'Çok fazla dosya: dakikada en fazla 30', code: 429 };
  const buf = req.body; if (!Buffer.isBuffer(buf) || !buf.length) return { error: 'Boş dosya. Gövdeye dosyanın kendisini koy (Content-Type: application/octet-stream)', code: 400 };
  if (buf.length > FILE_MAX) return { error: 'Dosya en fazla 25 MB olabilir', code: 413 };
  let name; try { name = safeName(decodeURIComponent(String(req.headers['x-dosya-adi'] || req.headers['x-file-name'] || 'dosya'))); } catch { name = 'dosya'; }
  if (BAD_EXT.test(name)) return { error: 'Bu dosya türü güvenlik nedeniyle gönderilemez', code: 400 };
  const r = storeFile(a.bot, name, req.headers['x-dosya-turu'] || req.headers['x-file-type'], buf);
  return r.error ? r : { id: r.id, ad: r.name, boyut: r.size, tur: r.kind, url: r.url };
}));
// ---- Botun kendi emojileri (en fazla 50): mesajda :ad: yazınca her yerde görünür ----
const APP_EMOJI_MAX = 50;
api.get('/emojiler', R(a => ({ emojiler: Object.entries(a.emojis || {}).map(([ad, url]) => ({ ad, url })) })));
api.put('/emojiler/:emoji', rawBody, R((a, req) => {
  const ad = String(req.params.emoji || '').toLowerCase();
  if (!/^[a-z0-9_]{2,24}$/.test(ad)) return { error: 'Emoji adı 2-24 karakter olmalı (a-z, 0-9, _)', code: 400 };
  a.emojis ||= {};
  if (!a.emojis[ad] && Object.keys(a.emojis).length >= APP_EMOJI_MAX) return { error: `En fazla ${APP_EMOJI_MAX} emoji eklenebilir`, code: 400 };
  if (limited('botemo|' + a.id, 20, 60e3)) return { error: 'Çok hızlı: dakikada en fazla 20 emoji', code: 429 };
  let buf = req.body; if (!Buffer.isBuffer(buf) || !buf.length) return { error: 'Gövdeye resmin kendisini koy (PNG, JPG, GIF ya da WEBP)', code: 400 };
  if (buf.length > 512 * 1024) return { error: 'Emoji en fazla 512 KB olabilir', code: 413 };
  const h = buf.subarray(0, 12).toString('hex'), ext = h.startsWith('89504e47') ? 'png' : h.startsWith('ffd8ff') ? 'jpg' : h.startsWith('47494638') ? 'gif' : h.startsWith('52494646') && buf.subarray(8, 12).toString() === 'WEBP' ? 'webp' : null;
  if (!ext) return { error: 'Sadece PNG, JPG, GIF ya da WEBP', code: 400 };
  if (ext === 'gif') buf = gifLoopForever(buf);
  const file = crypto.randomBytes(12).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(UPLOADS, file), buf);
  a.emojis[ad] = '/uploads/' + file; save();
  return { ad, url: a.emojis[ad] };
}));
api.delete('/emojiler/:emoji', R((a, req) => { const ad = String(req.params.emoji || '').toLowerCase(); if (!a.emojis?.[ad]) return { error: 'Böyle bir emoji yok', code: 404 }; delete a.emojis[ad]; save(); return { ok: true }; }));
// ---- "yazıyor..." göstergesi (yaklaşık 8 saniye görünür; uzun işlerde tekrar gönder) ----
api.post('/odalar/:cid/yaziyor', R((a, req) => {
  const f = botChan(a, req.params.cid, 'send'); if (f.error) return f;
  if (limited('bottyp|' + a.id + '|' + req.params.cid, 10, 10e3)) return { ok: true };
  io.to(req.params.cid).emit('typing', { channelId: req.params.cid, name: a.bot, long: true });
  return { ok: true };
}));
// ---- Botun durumu: çevrimiçi / boşta / rahatsız etmeyin / görünmez, durum yazısı ve etkinlik ----
// REST (PATCH /ben/durum), ağ geçidi (op 3) ve bağlanırken (op 2 içinde "durum") aynı yerden geçer.
// Türkçe harfler ve İngilizce adlar da kabul edilir: "çevrimiçi", "boşta", "rahatsız etmeyin", "online", "dnd"...
const trAscii = x => String(x ?? '').toLocaleLowerCase('tr').replace(/[çğıöşüâî]/g, c => ({ ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i' }[c])).replace(/[^a-z]/g, '');
const BOT_ST = { cevrimici: 'online', online: 'online', acik: 'online', bosta: 'idle', idle: 'idle', uzakta: 'idle', rahatsizetme: 'dnd', rahatsizetmeyin: 'dnd', mesgul: 'dnd', dnd: 'dnd', gorunmez: 'invisible', invisible: 'invisible', cevrimdisi: 'invisible', offline: 'invisible' };
const BOT_ACT = { oynuyor: 'Oynuyor', playing: 'Oynuyor', '0': 'Oynuyor', yayinda: 'Yayında', streaming: 'Yayında', '1': 'Yayında', dinliyor: 'Dinliyor', listening: 'Dinliyor', '2': 'Dinliyor',
  izliyor: 'İzliyor', watching: 'İzliyor', '3': 'İzliyor', yayin: 'Yayında', yayinyapiyor: 'Yayında', yayinliyor: 'Yayında', canli: 'Yayında', canliyayin: 'Yayında', live: 'Yayında', stream: 'Yayında', oynamak: 'Oynuyor', oyun: 'Oynuyor', dinle: 'Dinliyor', izle: 'İzliyor', yaris: 'Yarışıyor', ozel: '', custom: '', '4': '', yarisiyor: 'Yarışıyor', competing: 'Yarışıyor', '5': 'Yarışıyor' };
function botSetPresence(a, b) {
  const u = db.users[a.bot]; if (!u) return { error: 'Bot hesabı yok', code: 404 };
  b = b && typeof b === 'object' ? b : {};
  const rawSt = b.durum ?? b.status, st = rawSt === undefined || rawSt === null || rawSt === '' ? null : BOT_ST[trAscii(rawSt)];
  if (rawSt !== undefined && rawSt !== null && rawSt !== '' && !st) return { error: `Bilinmeyen durum "${String(rawSt).slice(0, 20)}". Kullan: cevrimici, bosta, rahatsizetme, gorunmez`, code: 400 };
  let yazi = b.yazi ?? b.text;
  const act = b.aktivite ?? b.etkinlik ?? (Array.isArray(b.activities) ? b.activities[0] : b.activity);
  if (act && typeof act === 'object') {
    const ad = String(act.ad ?? act.name ?? act.state ?? '').trim(), tk = trAscii(act.tur ?? act.type ?? 'oynuyor') || String(act.type ?? ''), lab = BOT_ACT[tk] ?? BOT_ACT[String(act.type)];
    if (lab === undefined) return { error: `Bilinmeyen aktivite türü "${String(act.tur ?? act.type).slice(0, 20)}". Kullan: oynuyor, yayinda, dinliyor, izliyor, yarisiyor, ozel`, code: 400 };
    if (ad) yazi = lab ? `${lab}: ${ad}` : ad;
  } else if (typeof act === 'string' && act.trim()) yazi = `Oynuyor: ${act.trim()}`;
  if (!st && yazi === undefined) return { error: 'Gönderilecek bir şey yok: durum, yazi ya da aktivite ver', code: 400 };
  if (limited('botdurum|' + a.id, 10, 60e3)) return { error: 'Durumu dakikada en fazla 10 kez değiştirebilirsin', code: 429 };
  let prof = false;
  if (st) u.presence = st;
  if (yazi !== undefined && yazi !== null) { const t = noPing(clean(yazi, 80)); if (t !== (u.status || '')) { u.status = t; prof = true; } }
  save(); pushPresence(); if (prof) pushUsers();
  return { durum: { online: 'cevrimici', idle: 'bosta', dnd: 'rahatsizetme', invisible: 'gorunmez' }[u.presence || 'online'], yazi: u.status || '' };
}
api.patch('/ben/durum', R((a, req) => botSetPresence(a, req.body)));
api.put('/ben/durum', R((a, req) => botSetPresence(a, req.body)));
api.get('/ben/durum', R(a => { const u = db.users[a.bot] || {}; return { durum: { online: 'cevrimici', idle: 'bosta', dnd: 'rahatsizetme', invisible: 'gorunmez' }[u.presence || 'online'], yazi: u.status || '', bagli: botConnsOf(a.id).length > 0 }; }));
api.get('/ben', R(a => ({ bot: appView(a), sunucuSayisi: botServers(a).length, erisim: reachOf(a), esik: REACH_MAX, dogrulandi: !!a.verified, icerikIzni: contentOk(a) })));
api.get('/sunucular', R(a => ({ sunucular: botServers(a).map(s => botServerView(a, s)) })));
api.get('/sunucular/:sid', R((a, req) => { const s = botSrv(a, req.params.sid); return s ? botServerView(a, s) : { error: 'Sunucu bulunamadı', code: 404 }; }));
api.get('/sunucular/:sid/uyeler', R((a, req) => { const s = botSrv(a, req.params.sid); if (!s) return { error: 'Sunucu bulunamadı', code: 404 };
  const q = String(req.query.ara ?? req.query.q ?? '').trim().toLocaleLowerCase('tr').slice(0, 40), lim = Math.min(Math.max(parseInt(req.query.limit) || (q ? 25 : 2000), 1), 2000);
  if (!q) return { uyeler: s.members.slice(0, lim).map(n => memberView(s, n)) };
  const hit = n => { const d = (db.users[n]?.displayName || '').toLocaleLowerCase('tr'), l = n.toLocaleLowerCase('tr'); return l.startsWith(q) || d.startsWith(q) ? 2 : l.includes(q) || d.includes(q) ? 1 : 0; };
  return { uyeler: s.members.map(n => [n, hit(n)]).filter(x => x[1]).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0], 'tr')).slice(0, lim).map(x => memberView(s, x[0])) }; }));
// Kişinin yetkileri: sunucu yetkileri + (oda verilirse) o odadaki izinleri. Bot kendi kontrolünü buna göre yapar.
api.get('/sunucular/:sid/uyeler/:ad/izinler', R((a, req) => { const s = botSrv(a, req.params.sid); if (!s || !s.members.includes(req.params.ad)) return { error: 'Üye bulunamadı', code: 404 };
  const n = req.params.ad, out = { ad: n, sahip: s.owner === n, yonetici: s.owner === n || can(s, n, 'administrator'), izinler: [...permsOf(s, n)], roller: s.memberRoles?.[n] || [], botunUstunde: !outranks(s, a.bot, n) };
  const cid = req.query.oda; if (cid) { const c = s.channels.find(x => x.id === cid); if (!c || !seesChannel(s, c, a.bot)) return { error: 'Oda bulunamadı', code: 404 }; out.oda = { id: c.id, ...Object.fromEntries(CH_KEYS.map(k => [k, chPerm(s, c, n, k)])) }; }
  return out; }));
api.get('/sunucular/:sid/roller', R((a, req) => { const s = botSrv(a, req.params.sid); if (!s) return { error: 'Sunucu bulunamadı', code: 404 }; return { roller: (s.customRoles || []).map(roleView), izinListesi: PERMS }; }));
// Energy (boost): toplam, seviye ve kimin kaç Energy gönderdiği. Bot bunu kullanarak kendi "destekçi" rolünü verebilir.
api.get('/sunucular/:sid/energy', R((a, req) => { const s = botSrv(a, req.params.sid); if (!s) return { error: 'Sunucu bulunamadı', code: 404 };
  return { toplam: energyTotal(s), seviye: energyLevel(s), sonrakiSeviye: ENERGY_LV[energyLevel(s) + 1] ?? null, gonderenler: Object.entries(s.energy || {}).filter(([n, k]) => k > 0 && s.members.includes(n)).sort((x, y) => y[1] - x[1]).map(([n, k]) => ({ id: db.users[n] ? uidOf(db.users[n]) : null, ad: n, adet: k })) }; }));
// Sesli odalar: kim nerede, mikrofon/kulaklık durumu. Değişiklikler "ses" niyetiyle SES_DURUMU olayı olarak gelir.
api.get('/sunucular/:sid/ses', R((a, req) => { const s = botSrv(a, req.params.sid); if (!s) return { error: 'Sunucu bulunamadı', code: 404 }; return { sunucu: s.id, odalar: botVoiceView(a, s) }; }));
// Sesteki kişiyi taşı / sesten çıkar / sunucuda sustur / susturmayı kaldır (voiceMove / voiceMute izni gerekir)
api.post('/sunucular/:sid/uyeler/:ad/ses', R((a, req) => { const s = botSrv(a, req.params.sid); if (!s || !s.members.includes(req.params.ad)) return { error: 'Üye bulunamadı', code: 404 };
  const b = req.body || {}, act = { tasi: 'move', cikar: 'disconnect', sustur: 'mute', ac: 'unmute', move: 'move', disconnect: 'disconnect', mute: 'mute', unmute: 'unmute' }[b.islem ?? b.action];
  if (!act) return { error: 'islem şunlardan biri olmalı: tasi, cikar, sustur, ac' };
  if (limited('botvc|' + a.id, 30, 60e3)) return { error: 'Çok hızlı: dakikada en fazla 30 ses işlemi', code: 429 };
  const r = voiceModDo(s, a.bot, req.params.ad, act, b.oda ?? b.channel); return r.error ? { error: r.error.replace(/yetkin yok/, 'botun izni yok (voiceMute / voiceMove)'), code: 403 } : r; }));
api.get('/sunucular/:sid/uyeler/:ad', R((a, req) => { const s = botSrv(a, req.params.sid); if (!s || !s.members.includes(req.params.ad)) return { error: 'Üye bulunamadı', code: 404 }; return memberView(s, req.params.ad); }));
api.get('/odalar/:cid', R((a, req) => { const f = botChan(a, req.params.cid); if (f.error) return f; if (f.dm) return { id: req.params.cid, tur: 'dm', kisiler: dmPeers(req.params.cid) }; return { id: f.c.id, ad: f.c.name, tur: f.c.type, konu: f.c.topic || '', sunucu: f.s.id, yazabilir: chPerm(f.s, f.c, a.bot, 'send') }; }));
api.get('/odalar/:cid/mesajlar', R((a, req) => {
  const cid = req.params.cid, f = botChan(a, cid, cid.startsWith('dm:') ? 'view' : 'history'); if (f.error) return f;
  const list = db.messages[cid] || [], lim = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
  let end = list.length; if (req.query.once) { const i = list.findIndex(m => m.id === req.query.once); if (i >= 0) end = i; }
  return { mesajlar: list.slice(Math.max(0, end - lim), end).filter(m => !m.enc).map(m => msgForBot(a, cid, m, cid.startsWith('dm:') || contentOk(a) ? true : false)) };
}));
api.get('/odalar/:cid/mesajlar/:mid', R((a, req) => { const f = botChan(a, req.params.cid); if (f.error) return f; const m = findMsg(req.params.cid, req.params.mid); return m && !m.enc ? msgForBot(a, req.params.cid, m, req.params.cid.startsWith('dm:') || contentOk(a)) : { error: 'Mesaj yok', code: 404 }; }));
api.post('/odalar/:cid/mesajlar', R((a, req) => {
  const cid = req.params.cid, f = botChan(a, cid, 'send'); if (f.error) return f;
  const now = Date.now(), k = a.id + '|' + cid, h = (chanHits.get(k) || []).filter(t => now - t < 5000);
  if (h.length >= 10) return { error: 'Bu odaya çok hızlı yazıyorsun: 5 saniyede en fazla 10 mesaj', code: 429 }; // botun genel sınırı (saniyede 10 istek) ayrıca geçerli
  h.push(now); chanHits.set(k, h);
  if (!f.dm && timedOut(f.s, a.bot)) return { error: 'Bot bu sunucuda susturulmuş', code: 403 };
  const body = msgBody(req.body || {}); let extra = {};
  const rid = req.body?.yanit ?? req.body?.message_reference?.message_id; if (rid) { const r = findMsg(cid, rid); if (r) extra.replyTo = { id: r.id, author: r.author, text: r.enc ? '' : (r.text || '').slice(0, 100) }; }
  const r = appPost(a, cid, body, extra); return r.error ? r : { mesaj: msgForBot(a, cid, r.msg, true), ...(body.uyari ? { uyari: body.uyari } : {}) };
}));
api.patch('/odalar/:cid/mesajlar/:mid', R((a, req) => { const f = botChan(a, req.params.cid); if (f.error) return f; return editAppMsg(a, req.params.cid, req.params.mid, req.body || {}); }));
api.delete('/odalar/:cid/mesajlar/:mid', R((a, req) => {
  const cid = req.params.cid, f = botChan(a, cid); if (f.error) return f;
  const list = db.messages[cid] || [], m = list.find(x => x.id === req.params.mid); if (!m) return { error: 'Mesaj yok', code: 404 };
  if (m.author !== a.bot && (f.dm || !can(f.s, a.bot, 'manageMessages'))) return { error: 'Başkasının mesajını silmek için "Mesajları yönet" izni gerekli', code: 403 };
  if (m.author !== a.bot && !f.dm && m.author === f.s.owner) return { error: 'Sunucu sahibinin mesajı bot tarafından silinemez', code: 403 };
  db.messages[cid] = list.filter(x => x !== m); if (m.author !== a.bot && !f.dm) audit(f.s, a.bot, 'Mesaj sildi (bot)', m.author || '');
  save(); io.to(cid).emit('remove', { channelId: cid, msgId: m.id }); unActivity(cid, [m]); return { ok: true };
}));
api.put('/odalar/:cid/mesajlar/:mid/tepkiler/:emoji', R((a, req) => {
  const cid = req.params.cid, f = botChan(a, cid, cid.startsWith('dm:') ? 'view' : 'react'); if (f.error) return f;
  const m = findMsg(cid, req.params.mid); if (!m) return { error: 'Mesaj yok', code: 404 };
  const e = clean(decodeURIComponent(req.params.emoji), 16); if (!e) return { error: 'Emoji gerekli' };
  const arr = ((m.reactions ||= {})[e] ||= []); if (!arr.includes(a.bot)) arr.push(a.bot); save(); io.to(cid).emit('update', { channelId: cid, msg: m }); return { ok: true };
}));
api.delete('/odalar/:cid/mesajlar/:mid/tepkiler/:emoji', R((a, req) => {
  const cid = req.params.cid, f = botChan(a, cid); if (f.error) return f; const m = findMsg(cid, req.params.mid); if (!m) return { error: 'Mesaj yok', code: 404 };
  const e = clean(decodeURIComponent(req.params.emoji), 16), arr = m.reactions?.[e]; if (arr) { const i = arr.indexOf(a.bot); if (i >= 0) arr.splice(i, 1); if (!arr.length) delete m.reactions[e]; } save(); io.to(cid).emit('update', { channelId: cid, msg: m }); return { ok: true };
}));
api.put('/odalar/:cid/sabitler/:mid', R((a, req) => { const f = botChan(a, req.params.cid); if (f.error) return f; if (!f.dm && !can(f.s, a.bot, 'pinMessages') && !can(f.s, a.bot, 'manageMessages')) return { error: 'Sabitleme izni yok', code: 403 }; const m = findMsg(req.params.cid, req.params.mid); if (!m) return { error: 'Mesaj yok', code: 404 }; m.pinned = true; save(); io.to(req.params.cid).emit('update', { channelId: req.params.cid, msg: m }); return { ok: true }; }));
api.delete('/odalar/:cid/sabitler/:mid', R((a, req) => { const f = botChan(a, req.params.cid); if (f.error) return f; if (!f.dm && !can(f.s, a.bot, 'pinMessages') && !can(f.s, a.bot, 'manageMessages')) return { error: 'Sabitleme izni yok', code: 403 }; const m = findMsg(req.params.cid, req.params.mid); if (!m) return { error: 'Mesaj yok', code: 404 }; delete m.pinned; save(); io.to(req.params.cid).emit('update', { channelId: req.params.cid, msg: m }); return { ok: true }; }));
// Bottan özel mesaj: ortak bir sunucu gerekir ve kişi bot DM'lerini kapatmamış olmalı
api.post('/kullanicilar/:ad/dm', R((a, req) => {
  const n = req.params.ad, u = db.users[n]; if (!u || u.bot) return { error: 'Kişi bulunamadı', code: 404 };
  if (a.dmOk === false) return { error: 'Bu uygulamada DM kapalı (Geliştirici Portalı)', code: 403 };
  if (u.botDmOff) return { error: 'Bu kişi botlardan özel mesaj almıyor', code: 403 };
  if (u.blocked?.includes(a.bot)) return { error: 'Bu kişi botu engellemiş', code: 403 };
  if (!botServers(a).some(s => s.members.includes(n)) && !msgRaw[dmId(a.bot, n)]?.some(m => m.author === n)) return { error: 'Bot ile bu kişinin ortak bir sunucusu yok', code: 403 };
  if (limited('botdm|' + a.id, 30, 60e3) || limited('botdm1|' + a.id + '|' + n, 5, 60e3)) return { error: 'Çok fazla DM: dakikada en fazla 30 (kişi başı 5)', code: 429 };
  const cid = dmId(a.bot, n), r = appPost(a, cid, msgBody(req.body || {})); return r.error ? r : { oda: cid, mesaj: msgForBot(a, cid, r.msg, true) };
}));
// Üye yönetimi (bot rolünün izinleri ve rol sırası geçerli)
const botMod = (a, req, perm) => { const s = botSrv(a, req.params.sid); if (!s) return { error: 'Sunucu bulunamadı', code: 404 }; const n = req.params.ad; if (!s.members.includes(n)) return { error: 'Üye bulunamadı', code: 404 };
  if (!can(s, a.bot, perm)) return { error: `Botun "${perm}" izni yok`, code: 403 }; if (n === s.owner || !outranks(s, a.bot, n)) return { error: 'Bu üye botun rolünden üstte', code: 403 }; return { s, n }; };
api.put('/sunucular/:sid/uyeler/:ad/roller/:rid', R((a, req) => {
  const x = botMod(a, req, 'manageRoles'); if (x.error) return x; const { s, n } = x, rid = req.params.rid;
  const i = s.customRoles.findIndex(r => r.id === rid); if (i < 0) return { error: 'Rol yok', code: 404 };
  const mine = (s.memberRoles[a.bot] || []).map(id => s.customRoles.findIndex(r => r.id === id)).filter(k => k >= 0); if (!mine.length || Math.min(...mine) >= i) return { error: 'Bot sadece kendi rolünden aşağıdaki rolleri verebilir', code: 403 };
  if (s.customRoles[i].managed) return { error: 'Bot rolleri elle verilemez', code: 403 };
  const l = (s.memberRoles[n] ||= []); if (!l.includes(rid)) l.push(rid); audit(s, a.bot, 'Rol verdi (bot)', `${n} · ${s.customRoles[i].name}`); save(); pushServers(membersOf(s)); botMember(s, n, 'update'); return { ok: true };
}));
api.delete('/sunucular/:sid/uyeler/:ad/roller/:rid', R((a, req) => {
  const x = botMod(a, req, 'manageRoles'); if (x.error) return x; const { s, n } = x, rid = req.params.rid, i = s.customRoles.findIndex(r => r.id === rid); if (i < 0) return { error: 'Rol yok', code: 404 };
  const mine = (s.memberRoles[a.bot] || []).map(id => s.customRoles.findIndex(r => r.id === id)).filter(k => k >= 0); if (!mine.length || Math.min(...mine) >= i) return { error: 'Bot sadece kendi rolünden aşağıdaki rolleri alabilir', code: 403 };
  s.memberRoles[n] = (s.memberRoles[n] || []).filter(r => r !== rid); if (!s.memberRoles[n].length) delete s.memberRoles[n]; audit(s, a.bot, 'Rol aldı (bot)', `${n} · ${s.customRoles[i].name}`); save(); pushServers(membersOf(s)); botMember(s, n, 'update'); return { ok: true };
}));
api.post('/sunucular/:sid/uyeler/:ad/sustur', R((a, req) => {
  const x = botMod(a, req, 'timeout'); if (x.error) return x; const { s, n } = x, dk0 = parseInt(req.body?.dakika), dk = Math.min(Math.max(Number.isFinite(dk0) ? dk0 : 10, 0), 40320);
  if (!dk) delete s.timeouts[n]; else s.timeouts[n] = Date.now() + dk * 60e3; audit(s, a.bot, dk ? 'Susturdu (bot)' : 'Susturmayı kaldırdı (bot)', n + (req.body?.sebep ? ' · ' + clean(req.body.sebep, 120) : '')); save(); pushServers(membersOf(s)); if (dk) io.to('user:' + n).emit('toast', `${s.name} sunucusunda ${dk} dakika susturuldun`); return { ok: true };
}));
api.delete('/sunucular/:sid/uyeler/:ad', R((a, req) => {
  const x = botMod(a, req, 'kick'); if (x.error) return x; const { s, n } = x;
  if (nukeCheck(s, a.bot, 'üye atma')) return { error: 'Kısa sürede çok fazla üye attın, işlem durduruldu', code: 429 };
  s.members = s.members.filter(m => m !== n); wipeMember(s, n); audit(s, a.bot, 'Sunucudan attı (bot)', n + (req.body?.sebep ? ' · ' + clean(req.body.sebep, 120) : ''));
  voiceKick(s.channels.map(c => c.id), n, 'Sunucudan çıkarıldın'); save(); pushServers([n, ...s.members]); io.to('user:' + n).emit('toast', `${s.name} sunucusundan çıkarıldın`); botMember(s, n, 'leave', { by: a.bot, islem: 'atildi', sebep: clean(req.body?.sebep, 120) }); return { ok: true };
}));
api.put('/sunucular/:sid/yasaklar/:ad', R((a, req) => {
  const x = botMod(a, req, 'ban'); if (x.error) return x; const { s, n } = x;
  if (nukeCheck(s, a.bot, 'yasaklama')) return { error: 'Kısa sürede çok fazla yasaklama, işlem durduruldu', code: 429 };
  s.bans[n] = { by: a.bot, time: Date.now(), reason: clean(req.body?.sebep, 120) }; s.members = s.members.filter(m => m !== n); wipeMember(s, n);
  audit(s, a.bot, 'Yasakladı (bot)', n); voiceKick(s.channels.map(c => c.id), n, 'Sunucudan yasaklandın'); save(); pushServers([n, ...s.members]); io.to('user:' + n).emit('toast', `${s.name} sunucusundan yasaklandın`); botMember(s, n, 'leave', { by: a.bot, islem: 'yasaklandi', sebep: clean(req.body?.sebep, 120) }); return { ok: true };
}));
api.delete('/sunucular/:sid/uyeler/:ad/sustur', R((a, req) => {
  const x = botMod(a, req, 'timeout'); if (x.error) return x; const { s, n } = x;
  delete s.timeouts[n]; audit(s, a.bot, 'Susturmayı kaldırdı (bot)', n); save(); pushServers(membersOf(s)); botMember(s, n, 'update'); return { ok: true };
}));
api.get('/sunucular/:sid/yasaklar', R((a, req) => {
  const s = botSrv(a, req.params.sid); if (!s) return { error: 'Sunucu bulunamadı', code: 404 }; if (!can(s, a.bot, 'ban')) return { error: 'Botun "ban" izni yok', code: 403 };
  return { yasaklar: Object.entries(s.bans || {}).map(([ad, b]) => ({ ad, id: db.users[ad] ? uidOf(db.users[ad]) : null, sebep: b?.reason || '', yapan: b?.by || null, zaman: b?.time || null })) };
}));
api.delete('/sunucular/:sid/yasaklar/:ad', R((a, req) => {
  const s = botSrv(a, req.params.sid); if (!s) return { error: 'Sunucu bulunamadı', code: 404 }; if (!can(s, a.bot, 'ban')) return { error: 'Botun "ban" izni yok', code: 403 };
  const n = req.params.ad; if (!s.bans?.[n]) return { error: 'Bu kişi yasaklı değil', code: 404 };
  delete s.bans[n]; audit(s, a.bot, 'Yasağı kaldırdı (bot)', n); save(); pushServers(membersOf(s)); return { ok: true };
}));
api.get('/odalar/:cid/sabitler', R((a, req) => {
  const cid = req.params.cid, f = botChan(a, cid, cid.startsWith('dm:') ? 'view' : 'history'); if (f.error) return f;
  return { mesajlar: (db.messages[cid] || []).filter(m => m.pinned && !m.enc).slice(-50).map(m => msgForBot(a, cid, m, cid.startsWith('dm:') || contentOk(a))) };
}));
// Toplu silme (/temizle komutları için): en fazla 100 mesaj, son 14 gün; sunucu sahibinin mesajları atlanır
api.post('/odalar/:cid/mesajlar/toplu-sil', R((a, req) => {
  const cid = req.params.cid, f = botChan(a, cid); if (f.error) return f;
  if (f.dm) return { error: 'DM\'de toplu silme yok', code: 400 };
  if (!can(f.s, a.bot, 'manageMessages')) return { error: 'Toplu silme için "Mesajları yönet" izni gerekli', code: 403 };
  if (limited('bottoplu|' + a.id, 5, 60e3)) return { error: 'Dakikada en fazla 5 toplu silme', code: 429 };
  const list = db.messages[cid] || [], b = req.body || {}, old = Date.now() - 14 * 864e5;
  let pick = Array.isArray(b.mesajlar ?? b.messages) ? new Set((b.mesajlar ?? b.messages).slice(0, 100).map(String)) : null;
  const adet = Math.min(Math.max(parseInt(b.adet ?? b.limit) || 0, 0), 100);
  if (!pick && !adet) return { error: 'mesajlar (id listesi) ya da adet (1-100) ver', code: 400 };
  const kim = b.kisi ?? b.yazar ?? null;
  let cand = list.filter(m => m.time > old && m.author !== f.s.owner && (!kim || m.author === kim));
  cand = pick ? cand.filter(m => pick.has(m.id)) : cand.slice(-adet);
  if (!cand.length) return { silinen: 0 };
  const del = new Set(cand); db.messages[cid] = list.filter(m => !del.has(m));
  audit(f.s, a.bot, 'Toplu mesaj sildi (bot)', `${cand.length} mesaj${kim ? ' · ' + kim : ''}`); save();
  for (const m of cand) io.to(cid).emit('remove', { channelId: cid, msgId: m.id });
  unActivity(cid, cand); return { silinen: cand.length };
}));
// Komutlar: tamamını tek seferde yaz (PUT) ya da oku (GET); her yerde geçerli ya da tek sunucuya özel
api.get('/komutlar', R(a => ({ komutlar: a.cmds || [] })));
api.put('/komutlar', R((a, req) => { const r = cleanCmds(Array.isArray(req.body) ? req.body : req.body?.komutlar); if (r.error) return r; a.cmds = r.list; save(); for (const s of botServers(a)) pushServers(membersOf(s)); return { komutlar: a.cmds }; }));
// ---- Oda ve kategori yönetimi (manageChannels izni gerekir) ----
const botChMgr = (a, s) => s && can(s, a.bot, 'manageChannels');
api.get('/sunucular/:sid/odalar', R((a, req) => { const s = botSrv(a, req.params.sid); if (!s) return { error: 'Sunucu bulunamadı', code: 404 };
  return { odalar: s.channels.filter(c => seesChannel(s, c, a.bot)).map(c => chBotView(s, c, a.bot)), kategoriler: s.categories.map(k => ({ id: k.id, ad: k.name })) }; }));
api.post('/sunucular/:sid/odalar', R((a, req) => {
  const s = botSrv(a, req.params.sid); if (!s) return { error: 'Sunucu bulunamadı', code: 404 };
  if (!botChMgr(a, s)) return { error: 'Botun bu sunucuda "manageChannels" (odaları yönet) izni yok', code: 403 };
  if (limited('botch|' + a.id + '|' + s.id, 10, 60e3)) return { error: 'Çok hızlı oda açıyorsun: dakikada en fazla 10', code: 429 };
  const b = req.body || {}; const r = addChannel(s, a.bot, { name: b.ad ?? b.name, type: b.tur ?? b.type, cat: b.kategori ?? b.parent ?? null, priv: !!((b.ozel ?? b.private) || b.kisiler), topic: b.konu ?? b.topic });
  if (r.error) return r;
  // Talep (ticket) odası tek istekte: { ozel: true, kisiler: ['ali'], roller: [rolId], izinler: { hedef: { view, send } } }
  const ov = {}; const put = (k, v) => { const t = ovTarget(s, k); if (t) ov[t] = { ...(ov[t] || {}), ...v }; };
  for (const k of [].concat(b.kisiler || [])) put(k, { view: true, send: true, history: true, attach: true });
  for (const k of [].concat(b.roller || [])) put(k, { view: true, send: true, history: true });
  if (b.izinler && typeof b.izinler === 'object') for (const [k, v] of Object.entries(b.izinler)) { const o = {}; for (const [k0, x] of Object.entries(v || {})) { const kk = OV_TR[k0] || k0; if (CH_KEYS.includes(kk) && typeof x === 'boolean') o[kk] = x; } put(k, o); }
  if (Object.keys(ov).length) { const c = r.c; if (c.sync) { c.perms = JSON.parse(JSON.stringify(catOf(s, c)?.perms || {})); c.sync = false; } c.perms = { ...(c.perms || {}), ...ov }; c.perms['u:' + a.bot] = { ...(c.perms['u:' + a.bot] || {}), view: true, send: true }; save(); pushServers(membersOf(s)); chEvent(s, 'ODA_GUNCELLENDI', c); }
  return chBotView(s, r.c, a.bot);
}));
// Oda izinleri (gizli oda, ticket odası): hedef = herkes | rol id'si | kişi adı/kimliği. Gövde: { view: true, send: false, ... } (null = devral)
const OV_TR = { gor: 'view', gorme: 'view', yaz: 'send', yazma: 'send', gecmis: 'history', baglan: 'connect', baglanma: 'connect', dosya: 'attach', tepki: 'react', konus: 'speak', konusma: 'speak', kamera: 'video', yayin: 'stream' };
function ovTarget(s, h) {
  h = String(h || ''); if (['herkes', '@everyone', 'everyone', s.id].includes(h)) return '@everyone';
  if (s.customRoles.some(r => r.id === h)) return h; const n = nameOfRef(h.replace(/^(u:|kisi:)/, '')) || h.replace(/^(u:|kisi:)/, ''); return s.members.includes(n) ? 'u:' + n : null;
}
function ovSet(a, req, del) {
  const f = botChan(a, req.params.cid); if (f.error) return f; if (f.dm) return { error: 'DM için izin yok', code: 400 };
  const { s, c } = f; if (!botChMgr(a, s)) return { error: 'Botun bu sunucuda "manageChannels" (odaları yönet) izni yok', code: 403 };
  const t = ovTarget(s, req.params.hedef); if (!t) return { error: 'Hedef bulunamadı: herkes, bir rol id\'si ya da sunucudaki bir kişi olmalı', code: 404 };
  if (limited('botov|' + a.id, 60, 60e3)) return { error: 'Çok hızlı: dakikada en fazla 60 izin değişikliği', code: 429 };
  if (c.sync) { c.perms = JSON.parse(JSON.stringify(catOf(s, c)?.perms || {})); c.sync = false; } c.perms ||= {};
  if (del) delete c.perms[t];
  else { const cur = { ...(c.perms[t] || {}) }; let n = 0;
    for (const [k0, v] of Object.entries(req.body || {})) { const k = OV_TR[k0] || k0; if (!CH_KEYS.includes(k)) return { error: `Bilinmeyen izin: ${k0}. Geçerli: ${CH_KEYS.join(', ')}` }; if (v === null) delete cur[k]; else if (typeof v === 'boolean') cur[k] = v; else return { error: `${k0}: true, false ya da null olmalı` }; n++; }
    if (!n) return { error: 'Gövdede en az bir izin olmalı, ör. { "view": true, "send": true }' };
    if (t === 'u:' + a.bot && cur.view === false) return { error: 'Bot kendi görme iznini kapatamaz' };
    if (Object.keys(cur).length) c.perms[t] = cur; else delete c.perms[t]; }
  audit(s, a.bot, 'Oda izinlerini düzenledi', `${c.name} (${t === '@everyone' ? 'herkes' : t.startsWith('u:') ? t.slice(2) : s.customRoles.find(r => r.id === t)?.name || t})`);
  save(); pushServers(membersOf(s)); chEvent(s, 'ODA_GUNCELLENDI', c);
  return chBotView(s, c, a.bot);
}
api.put('/odalar/:cid/izinler/:hedef', R((a, req) => ovSet(a, req, false)));
api.patch('/odalar/:cid/izinler/:hedef', R((a, req) => ovSet(a, req, false)));
api.delete('/odalar/:cid/izinler/:hedef', R((a, req) => ovSet(a, req, true)));
// Kalıcı gizli mesaj: odada sadece "kisi" görür, sayfayı yenileyince de kaybolmaz (kişi "Kapat" diyene ya da bot silene kadar)
api.post('/odalar/:cid/ozel-mesajlar', R((a, req) => {
  const f = botChan(a, req.params.cid); if (f.error) return f; if (f.dm) return { error: 'DM zaten özel; normal mesaj gönder', code: 400 };
  const b = req.body || {}, n = nameOfRef(String(b.kisi ?? b.user ?? '')) || String(b.kisi ?? b.user ?? '');
  if (!f.s.members.includes(n) || isBotUser(n) || !seesChannel(f.s, f.c, n)) return { error: 'kisi: bu odayı gören bir üye olmalı', code: 404 };
  if (limited('botozel|' + a.id, 60, 60e3)) return { error: 'Çok hızlı: dakikada en fazla 60 gizli mesaj', code: 429 };
  const body = msgBody(b); if (!body.text && !body.embeds.length && !body.comps.length && !body.files.length) return { error: 'Boş mesaj' };
  const m = ozelPost(a, req.params.cid, n, body); return { ok: true, mesaj: m.id, ...(body.uyari ? { uyari: body.uyari } : {}) };
}));
api.delete('/odalar/:cid/ozel-mesajlar/:mid', R((a, req) => { const e = ozelIdx.get(req.params.mid); if (!e || e.chId !== req.params.cid || e.msg.app !== a.id) return { error: 'Mesaj yok', code: 404 }; ozelDel(req.params.mid); return { ok: true }; }));
api.patch('/odalar/:cid/ozel-mesajlar/:mid', R((a, req) => { const e = ozelIdx.get(req.params.mid); if (!e || e.chId !== req.params.cid) return { error: 'Mesaj yok', code: 404 }; return editAppMsg(a, req.params.cid, req.params.mid, req.body || {}); }));
api.patch('/odalar/:cid', R((a, req) => {
  const f = botChan(a, req.params.cid); if (f.error) return f; if (f.dm) return { error: 'DM düzenlenemez', code: 400 };
  const { s, c } = f; if (!botChMgr(a, s)) return { error: 'Botun bu sunucuda "manageChannels" (odaları yönet) izni yok', code: 403 };
  const b = req.body || {}, ch = [];
  if (b.ad !== undefined) { let n = clean(b.ad, 30); if (c.type === 'text' || c.type === 'forum') n = n.toLowerCase().replace(/\s+/g, '-'); if (!n) return { error: 'Oda adı boş olamaz' }; c.name = n; ch.push('ad'); }
  if (b.konu !== undefined) { c.topic = clean(b.konu, 160); ch.push('konu'); }
  if (b.kategori !== undefined) { const k = b.kategori ? s.categories.find(x => x.id === b.kategori) : null; if (b.kategori && !k) return { error: 'Kategori bulunamadı' };
    if ((c.cat || null) !== (k?.id || null)) { c.cat = k?.id || undefined; if (!k) c.sync = false; placeInCat(s, c, k); } ch.push('kategori'); }
  if (b.yavasMod !== undefined) { if (!SLOW_OK.includes(+b.yavasMod)) return { error: 'yavasMod şunlardan biri olmalı: ' + SLOW_OK.join(', ') }; c.slow = +b.yavasMod; ch.push('yavasMod'); }
  if (b.limit !== undefined) { if (!voiceLike(c.type)) return { error: 'Kişi sınırı sadece sesli odalarda olur' }; c.limit = Math.max(0, Math.min(99, parseInt(b.limit) || 0)); ch.push('limit'); }
  if (b.ozel !== undefined) { if (c.sync) { c.perms = JSON.parse(JSON.stringify(catOf(s, c)?.perms || {})); c.sync = false; } c.perms ||= {}; const e = c.perms['@everyone'] ||= {}; if (b.ozel) e.view = false; else delete e.view; if (!Object.keys(e).length) delete c.perms['@everyone']; ch.push('ozel'); }
  if (!ch.length) return { error: 'Değiştirilecek alan yok (ad, konu, kategori, yavasMod, limit, ozel)' };
  audit(s, a.bot, 'Odayı düzenledi', `${c.name} (${ch.join(', ')})`); save(); pushServers(membersOf(s)); chEvent(s, 'ODA_GUNCELLENDI', c);
  return chBotView(s, c, a.bot);
}));
api.delete('/odalar/:cid', R((a, req) => {
  const f = botChan(a, req.params.cid); if (f.error) return f; if (f.dm) return { error: 'DM silinemez', code: 400 };
  if (!botChMgr(a, f.s)) return { error: 'Botun bu sunucuda "manageChannels" (odaları yönet) izni yok', code: 403 };
  const r = removeChannel(f.s, a.bot, f.c); return r.error ? { ...r, code: 409 } : r;
}));
api.post('/sunucular/:sid/kategoriler', R((a, req) => {
  const s = botSrv(a, req.params.sid); if (!s) return { error: 'Sunucu bulunamadı', code: 404 };
  if (!botChMgr(a, s)) return { error: 'Botun bu sunucuda "manageChannels" (odaları yönet) izni yok', code: 403 };
  if (s.categories.length >= 50) return { error: 'En fazla 50 kategori olabilir' };
  if (limited('botch|' + a.id + '|' + s.id, 10, 60e3)) return { error: 'Çok hızlı: dakikada en fazla 10 oda/kategori', code: 429 };
  const name = clean(req.body?.ad, 30); if (!name) return { error: 'Kategori adı gerekli' };
  const k = { id: id(), name, perms: {} }; s.categories.push(k); audit(s, a.bot, 'Kategori oluşturdu', k.name); save(); pushServers(membersOf(s));
  return { id: k.id, ad: k.name };
}));
api.delete('/sunucular/:sid/kategoriler/:kid', R((a, req) => {
  const s = botSrv(a, req.params.sid); if (!s) return { error: 'Sunucu bulunamadı', code: 404 };
  if (!botChMgr(a, s)) return { error: 'Botun bu sunucuda "manageChannels" (odaları yönet) izni yok', code: 403 };
  const k = s.categories.find(x => x.id === req.params.kid); if (!k) return { error: 'Kategori bulunamadı', code: 404 };
  for (const c of s.channels) if (c.cat === k.id) { if (c.sync) { c.perms = { ...(k.perms || {}) }; c.sync = false; } delete c.cat; }
  s.categories = s.categories.filter(x => x !== k); s.channels = [...s.channels.filter(c => !c.cat), ...s.channels.filter(c => c.cat)];
  audit(s, a.bot, 'Kategoriyi sildi', k.name); save(); pushServers(membersOf(s)); return { ok: true };
}));
api.get('/sunucular/:sid/komutlar', R((a, req) => { const s = botSrv(a, req.params.sid); if (!s) return { error: 'Sunucu bulunamadı', code: 404 }; return { komutlar: a.srvCmds?.[s.id] || [] }; }));
api.put('/sunucular/:sid/komutlar', R((a, req) => { const s = botSrv(a, req.params.sid); if (!s) return { error: 'Sunucu bulunamadı', code: 404 }; const r = cleanCmds(Array.isArray(req.body) ? req.body : req.body?.komutlar); if (r.error) return r; (a.srvCmds ||= {})[s.id] = r.list; save(); pushServers(membersOf(s)); return { komutlar: r.list }; }));
// Etkileşim cevabı (token'sız da çalışır: etkileşim token'ı yeterli, böylece HTTP botları da kullanabilir)
const interRoute = fn => (req, res) => {
  const it = inters.get(req.params.iid);
  if (!it || !req.params.tok || it.token.length !== String(req.params.tok).length || !crypto.timingSafeEqual(Buffer.from(it.token), Buffer.from(String(req.params.tok)))) return res.status(404).json({ hata: 'Etkileşim bulunamadı ya da süresi doldu' });
  if (Date.now() - it.at > INTER_TTL) return res.status(404).json({ hata: 'Etkileşimin süresi doldu (15 dk)' });
  if (!it.done && !it.deferred && Date.now() - it.at > INTER_WAIT + 2000 && req.method === 'POST') return res.status(400).json({ hata: '3 saniye içinde cevap verilmedi; uzun işler için önce "bekle" gönder' });
  const r = fn(it, req.body || {}); res.status(r.code || (r.error ? 400 : 200)).json(r.error ? { hata: r.error } : r);
};
api.post('/etkilesim/:iid/:tok/cevap', interRoute((it, b) => interRespond(it, b)));
api.patch('/etkilesim/:iid/:tok/mesaj', interRoute((it, b) => { if (!it.deferred && !it.done) return { error: 'Önce cevap ver', code: 400 }; const a = db.apps[it.app]; const mid = it.deferred?.id || it.msgId; if (!mid) return { error: 'Düzenlenecek mesaj yok', code: 400 }; return editAppMsg(a, it.chId, mid, b, it.user); }));
api.post('/etkilesim/:iid/:tok/takip', interRoute((it, b) => { const a = db.apps[it.app]; const body = msgBody(b); if (b.gizli ?? b.ephemeral) { const em = (b.kalici && !it.chId.startsWith('dm:') ? ozelPost : ephPost)(a, it.chId, it.user, body); return { ok: true, mesaj: em.id }; } const r = appPost(a, it.chId, body); return r.error ? r : { ok: true, mesaj: r.msg.id }; }));
api.use((req, res) => res.status(404).json({ hata: 'Böyle bir uç nokta yok. Belgeler: /gelistirici' }));
app.use('/api/v1', api);
function botJoin(a, s, perms, by) {
  s.members.push(a.bot); (s.joinedAt ||= {})[a.bot] = Date.now();
  const role = { id: id(), name: a.bot, color: '#8b93ff', perms: perms.filter(p => BOT_PERMS.includes(p)), hoist: false, managed: a.id, mentionable: false };
  (s.customRoles ||= []).push(role); (s.memberRoles ||= {})[a.bot] = [role.id];
  audit(s, by, 'Bot ekledi', a.bot); (s.botBy ||= {})[a.bot] = { by, at: Date.now() };
  gwDispatch(a.id, 'SUNUCUYA_EKLENDI', botServerView(a, s));
  devStatsSync(a.owner);
}
function appRemove(a) {
  for (const c of botConnsOf(a.id)) c.ws.close(4004, 'Uygulama silindi');
  for (const s of db.servers) if (s.members.includes(a.bot)) { s.members = s.members.filter(n => n !== a.bot); delete s.memberRoles?.[a.bot]; delete s.joinedAt?.[a.bot]; delete s.roles?.[a.bot]; s.customRoles = (s.customRoles || []).filter(r => r.managed !== a.id); pushServers(membersOf(s)); }
  delete db.users[a.bot]; delete db.apps[a.id]; save(); pushUsers();
}

// ---------- Bağlantı ----------
const tfaPending = new Map(); // isim -> { secret, exp } (kurulum sırasında)
// Çöp kutusundaki sunucular 7 gün sonra kalıcı silinir
setInterval(() => {
  const now = Date.now(); let n = 0;
  for (const t of [...(db.trash || [])]) if (now - t.at > 7 * 864e5) { for (const c of t.server.channels || []) delete db.messages[c.id]; db.trash = db.trash.filter(x => x !== t); n++; }
  if (n) save();
}, 3600e3);
const ipConns = new Map();
io.on('connection', socket => {
  socket.on('usersPatchOk', () => socket.join('up2'));
  { // aynı IP'den aşırı bağlantı açılmasın (bir evde birkaç cihaz rahatça sığar)
    const ipc = clientIp(socket.handshake.address, socket.handshake.headers['x-forwarded-for']), n = (ipConns.get(ipc) || 0) + 1;
    ipConns.set(ipc, n); socket.on('disconnect', () => { const k = (ipConns.get(ipc) || 1) - 1; k ? ipConns.set(ipc, k) : ipConns.delete(ipc); });
    if (n > 120) { if (n === 121) secLog('baglanti-seli', 'ip:' + ipc, 'aynı IP\'den 120+ eşzamanlı bağlantı (mobil operatörler çok kişiyi tek IP\'den çıkarabilir)'); return socket.disconnect(true); }
  }
  { // Her olay dinleyicisini sarmala: geri çağırma (cb) unutulmuş ya da bozuk veri gelmişse hata yutulur, sunucu düşmez
    const on = socket.on.bind(socket);
    const BADK = new Set(['__proto__', 'constructor', 'prototype']);
    const poisoned = (v, d = 0) => { if (typeof v === 'string') return v.length <= 11 && BADK.has(v); if (!v || typeof v !== 'object' || d > 5) return false;
      let n = 0; for (const k of Object.keys(v)) { if (BADK.has(k) || ++n > 400 || poisoned(v[k], d + 1)) return true; } return false; };
    socket.on = (ev, fn) => on(ev, (...args) => {
      if (args.some(a => typeof a !== 'function' && poisoned(a))) { const cb = args.findLast(a => typeof a === 'function'); cb?.({ error: 'Geçersiz istek' }); return; } // __proto__ kirletme girişimi
      if (args[0] === null && /^\s*(async\s*)?\(\s*\{/.test(fn.toString())) args[0] = undefined; // null gönderilince varsayılan {} devreye girsin
      if (typeof args[args.length - 1] !== 'function') args.push(() => {}); // cevap fonksiyonu verilmese de olay çökmesin
      // Yaş doğrulaması: doğum tarihini girmemiş (ya da 13 yaş altı kilitli) hesap, tarihi girene kadar hiçbir şey yapamaz
      if (me && needAge(db.users[me]) && !AGE_FREE.has(ev)) { const cb = args.findLast(a => typeof a === 'function'); cb?.({ error: 'Devam etmek için doğum tarihini gir', ageGate: true }); return; }
      try { const r = fn(...args); if (r && typeof r.catch === 'function') r.catch(e => logCrash('olay:' + ev, e)); }
      catch (e) { logCrash('olay:' + ev, e); }
    });
  }
  // Tek bir bağlantıdan olağandışı yoğunlukta istek gelirse (betik/saldırı) bağlantıyı kes
  { let n = 0, t0 = Date.now();
    // Gerçek zamanlı oyun girdisi (masa hokeyi 60Hz) sayılmaz: kendi sınırı var (arenaIn), yoksa oyuncu bağlantıdan ve sesten düşer
    socket.onAny(ev => { if (ev === 'arenaIn' || ev === 'instr') return; const now = Date.now(); if (now - t0 > 10e3) { n = 0; t0 = now; } if (++n === 400) { secLog('istek-seli', socket.data?.me || 'bağlantı', '10 saniyede 400+ istek, bağlantı kesildi'); socket.disconnect(true); } }); }
  socket.emit('build', build); if (buildParts) socket.emit('buildParts', buildParts);
  // Eski sayfa (büyük güncellemeden önce açılmış) yenile uyarısını bilmiyor: ona birkaç kez yazılı haber ver.
  // Yeni sayfalar bağlanınca 'yeniIstemci' der; demeyenler eski sayfadır.
  socket.on('yeniIstemci', () => { socket.data.yeni = true; });
  for (const ms of [6e3, 4 * 60e3, 12 * 60e3]) setTimeout(() => { if (socket.connected && online.has(socket.id) && !socket.data.yeni && buildParts?.major) socket.emit('toast', '🎉 Büyük güncelleme geldi: Kanka Arena (sesli odada oyunlar), ses paneli ve yıl özeti! Görmek için sayfayı yenile. Telefonda uygulamayı kapatıp yeniden aç.'); }, ms);
  const ip = clientIp(socket.handshake.address, socket.handshake.headers['x-forwarded-for']);
  const devRaw = socket.handshake.auth?.d, dH = typeof devRaw === 'string' && /^[a-z0-9-]{16,64}$/i.test(devRaw) ? idH('d|' + devRaw) : null, iH = ip && ip !== 'bilinmiyor' ? idH('i|' + ip) : null;
  let me = null, cur = null, myVoice = null;

  function start(name) {
    { const ev = evasionOf(dH, null, name); if (ev) { secLog('yan-hesap', name, `askıdaki ${ev.u.name} ile aynı cihaz`); staffLog('Kanka', 'Yan hesap girişi engellendi', name, `askıdaki hesap: ${ev.u.name}`); return { error: evadeText(ev.u), banned: true }; } }
    { const u0 = db.users[name]; if (u0 && !u0.bot) { seenAdd(u0, dH, iH); save(); } }
    me = name;
    socket.join('user:' + name);
    online.set(socket.id, name); onSetCache.t = 0; if (isMobileUA(socket.handshake.headers['user-agent'])) mobileSockets.add(socket.id); if (/Electron\//.test(socket.handshake.headers['user-agent'] || '')) desktopSockets.add(socket.id);
    pushPresence();
    { const ua = String(socket.handshake.headers['user-agent'] || ''), pf = /Electron\//.test(ua) ? 'app' : /iPhone|iPad|iPod/.test(ua) ? 'ios' : /Android/.test(ua) ? 'android' : /Mobi/.test(ua) ? 'mob' : 'web';
      const u0 = db.users[name]; if (u0) { (u0.plat ||= {})[pf] = (u0.plat[pf] || 0) + 1; u0.plat1 ||= pf; } }
    const reward = touchStreak(name);
    const token = sessNew(name); save();
    return { reward, social: social(name), badgeInfo: BADGES, ice: iceServers(),
      token, user: pubUser(db.users[name]), users: allUsers(), online: presenceList(), voiceFlags: seenBy(flagsState(), name), myStatus: db.users[name].presence || 'online', myStatusUntil: db.users[name].presenceUntil || null, customUntil: db.users[name].statusUntil || null,
      servers: serversFor(name).map(s => serverView(s, name)), dms: dmsFor(name), voice: seenBy(voiceState(), name), voiceAge: seenBy(voiceAges(), name), calls: callsFor(name), live: seenBy(liveState(), name), lastMsg: lastMsgTimes(name), prefs: db.users[name].prefs || null,
      onb: onbOf(db.users[name]), presets: PRESET_AV,
      needVeli: needVeli(db.users[name]), inboxUnseen: inboxUnseen(db.users[name]), minor: isMinor(db.users[name]), myEmail: db.users[name].email || null, siteAdmin: siteAdmin(name), staff: staffRank(name), warns: (db.users[name].siteWarns || []).filter(w => !w.seen).map(w => ({ id: w.id, at: w.at, reason: w.reason })), reportCounts: reportCounts(name), beta: db.beta.on, tfa: !!db.users[name].tfa?.on, botDmOff: !!db.users[name].botDmOff, wrapOff: !!db.users[name].wrapOff, tagDefs: TAG.defs(), tagCan: TAG.canList(name), npReady: { fcm: !!npCfg.fcm, apns: !!npCfg.apns }, tagCfg: siteAdmin(name) ? TAG.cfg() : null, arenaRooms: arenaRoomsFor(name), entrySound: db.users[name].entrySound || null, matchOff: !!db.users[name].matchOff, ageGate: needAge(db.users[name]) ? (db.users[name].ageLock ? 'locked' : 'need') : null, gif: gifReady(), gifHosts: [...gifHosts].slice(0, 40)
    };
  }

  socket.on('register', ({ name, password, email, code, invite, terms, src, dob, veli } = {}, cb = () => {}) => {
    name = clean(name, 20); password = String(password ?? ''); email = clean(email, 190).toLowerCase();
    if (!NAME_RE.test(name)) return cb({ error: 'Kullanıcı adı 2-20 karakter olmalı; harf, rakam, _ . - kullanabilirsin.' });
    const age = ageOf(dob);
    if (age === null) return cb({ error: 'Doğum tarihini seç.', field: 'dob' });
    if (age < 13) return cb({ error: 'Kanka Chat\'te hesap açmak için 13 yaşında ya da daha büyük olmalısın.', field: 'dob', minor: true }); // doğum tarihi saklanmaz
    if (password.length < 6) return cb({ error: 'Şifre en az 6 karakter olmalı.' });
    if (!EMAIL_RE.test(email)) return cb({ error: 'Geçerli bir e-posta adresi yaz. Şifreni unutursan buraya link göndeririz.', field: 'email' });
    if (!terms) return cb({ error: 'Devam etmek için kullanım şartlarını ve gizlilik politikasını kabul etmelisin.', field: 'terms' });
    if (age < 18 && veli !== true) return cb({ error: '18 yaşından küçüksen velinin bilgisi ve izniyle kullandığını onaylamalısın.', field: 'veli' });
    if (nameTaken(name)) return cb({ error: 'Bu kullanıcı adı alınmış.', field: 'name' });
    { const ev = evasionOf(dH, iH, null); if (ev) { secLog('yan-hesap', name, `kayıt engellendi, askıdaki ${ev.u.name} (${ev.by === 'dev' ? 'cihaz' : 'bağlantı'})`); return cb({ error: evadeText(ev.u, ev.by) }); } }
    if (Object.values(db.users).some(u => u.email === email || (u.email && mailKey(u.email) === mailKey(email)))) return cb({ error: 'Bu e-posta ile zaten bir hesap var. Şifreni unuttuysan giriş ekranından sıfırlayabilirsin.', field: 'email' });
    const gate = betaGate(code, invite); if (gate.error) return cb({ ...gate, field: 'code' });
    const w = limited('reg|' + ip, 5, 3600e3);
    if (w) return cb({ error: `Bu bağlantıdan çok fazla hesap açıldı. ${Math.ceil(w / 60)} dakika sonra tekrar dene.` });
    const salt = crypto.randomBytes(16).toString('hex');
    db.users[name] = { name, email, terms: { v: 1, at: Date.now() }, color: COLORS[Object.keys(db.users).length % COLORS.length], salt, hash: hashPw(password, salt), xp: 0, createdAt: Date.now(), avatar: pickPresetAv(), onb: {} }; uidOf(db.users[name]);
    const sr = cleanSrc(src); if (sr) db.users[name].src = sr;
    db.users[name].dob = String(dob); db.users[name].birthday = String(dob).slice(5); if (age < 18) db.users[name].guardian = { at: Date.now(), v: 1, where: 'kayit' }; // tam tarih gizli tutulur; profilde sadece gün-ay (istersen kaldırabilirsin)
    { const iv = clean(invite, 40).split(/[=/]/).pop(), sv = iv && findInvite(iv)?.s; if (sv) db.users[name].via = { srv: sv.id, name: clean(sv.name, 40) }; else if (gate.code) db.users[name].via = { code: 1 }; } // hangi reklamdan / kelimeden geldi (ilk ziyaret)
    if (gate.code) {
      const c = db.codes[gate.code]; c.usedBy = name; c.usedAt = Date.now(); db.users[name].invitedBy = c.by;
      const inv = db.users[c.by];
      if (inv) { addXp(c.by, 50, 'davet'); io.to('user:' + c.by).emit('toast', `🎉 ${name} senin davet kodunla Kanka'ya katıldı! +50 XP`); }
    }
    db.waitlist.forEach(x => { if (x.email === email) x.joined = name; });
    ensureOwners(); save();
    pushUsers();
    pushServers(onlineNames()); // herkese açık sunucunun üye listesi değişti
    cb(start(name));
    for (const sv of db.servers) if (sv.public) setTimeout(() => botWelcome(sv, name), 1500);
  });
  socket.on('betaInfo', (cb = () => {}) => cb(betaInfo()));
  socket.on('checkCode', (code, cb = () => {}) => {
    if (limited('code|' + ip, 30, 600e3)) return cb({ error: 'Çok fazla deneme' });
    const c = normCode(code); cb(codeFree(c) ? { ok: true, code: c, by: db.codes[c].by && db.users[db.codes[c].by] ? db.codes[c].by : null } : { error: db.codes[c] ? 'Bu kod kullanılmış' : 'Kod geçersiz' });
  });
  socket.on('waitlist', ({ email, ref } = {}, cb = () => {}) => {
    email = clean(email, 190).toLowerCase();
    if (!EMAIL_RE.test(email)) return cb({ error: 'Geçerli bir e-posta adresi yaz.' });
    let i = db.waitlist.findIndex(x => x.email === email);
    if (i < 0) {
      if (limited('wait|' + ip, 5, 3600e3)) return cb({ error: 'Çok fazla deneme, biraz sonra tekrar dene.' });
      db.waitlist.push({ email, at: Date.now(), ref: clean(ref, 40) || null }); save(); i = db.waitlist.length - 1;
      for (const n of siteAdmins()) io.to('user:' + n).emit('waitlistNew', db.waitlist.filter(w => !w.invited).length);
    }
    const w = db.waitlist[i];
    cb({ ok: true, invited: !!w.invited, pos: w.invited ? 0 : db.waitlist.filter((x, j) => !x.invited && j <= i).length, total: db.waitlist.filter(x => !x.invited).length });
  });
  socket.on('forgot', async (who, cb = () => {}) => {
    if (limited('forgot|' + ip, 5, 900e3)) return cb({ error: 'Çok fazla istek. 15 dakika sonra tekrar dene.' });
    const DOWN = { error: 'Şu an e-posta gönderemiyoruz, kusura bakma. kankahq1@gmail.com adresine kullanıcı adınla yaz, hemen elle yardım edelim.' };
    if (!getMailer() || mailCfg?.ok === false) return cb(DOWN);
    const u = findUserBy(who);
    if (u?.email && !u.siteBan && !limited('forgotU|' + u.name, 5, 3600e3)) {
      const t = resetToken(u.name, 1);
      const ok = await sendMail(u.email, 'Kanka Chat şifre sıfırlama', mailHtml('Şifreni sıfırla', `Selam <b>${u.name}</b>, şifreni sıfırlamak için bir istek aldık. Link <b>1 saat</b> geçerli.<br><br>Buton çalışmazsa bu adresi tarayıcına yapıştır:<br><span style="word-break:break-all;color:#ffb38a">${baseUrl()}/login?sifirla=${t}</span>`, 'Yeni şifre belirle', `${baseUrl()}/login?sifirla=${t}`), null, 'şifre');
      if (!ok) return cb(DOWN); // gönderim sunucu genelinde bozuksa herkese aynı cevap gider, hesap varlığı belli olmaz
    } else if (mailDown()) return cb(DOWN);
    cb({ ok: true }); // hesabın var olup olmadığını belli etme
  });
  socket.on('checkReset', (token, cb = () => {}) => {
    const r = typeof token === 'string' && token.length <= 100 ? db.resets[tokH(token)] : null;
    cb(r && r.exp > Date.now() && db.users[r.name] ? { ok: true, name: r.name } : { error: 'Bu link geçersiz ya da süresi dolmuş. Yeni bir link iste.' });
  });
  socket.on('resetPw', ({ token, password } = {}, cb = () => {}) => {
    if (limited('reset|' + ip, 10, 900e3)) return cb({ error: 'Çok fazla deneme' });
    const r = typeof token === 'string' && token.length <= 100 ? db.resets[tokH(token)] : null, u = r && db.users[r.name];
    if (!r || r.exp < Date.now() || !u) return cb({ error: 'Bu link geçersiz ya da süresi dolmuş. Yeni bir link iste.' });
    if (String(password ?? '').length < 6) return cb({ error: 'Şifre en az 6 karakter olmalı.' });
    if (isBanned(u)) return cb({ error: banText(u) });
    u.salt = crypto.randomBytes(16).toString('hex'); u.hash = hashPw(String(password), u.salt);
    sessDelUser(u.name); for (const s2 of io.sockets.adapter.rooms.get('user:' + u.name) || []) if (s2 !== socket.id) io.sockets.sockets.get(s2)?.disconnect(true); // eski cihazlar düşsün
    for (const [t, x] of Object.entries(db.resets)) if (x.name === u.name) delete db.resets[t];
    save(); cb(start(u.name));
  });

  socket.on('login', async ({ name, password, code } = {}, cb) => {
    if (typeof cb !== 'function') return;
    const key = 'login|' + ip + '|' + clean(name, 190).toLowerCase(), ipKey = 'loginip|' + ip, now = Date.now();
    // Diziler yerinde güncellenir: aynı anda gelen denemeler birbirinin kaydını ezmesin
    const live = (k, win) => { let a = limits.get(k); if (!a) limits.set(k, a = []); const keep = a.filter(t => now - t < win); a.length = 0; a.push(...keep); return a; };
    const fails = live(key, 600e3), ipFails = live(ipKey, 900e3);
    if (fails.length >= 5) return cb({ error: `Çok fazla hatalı deneme. ${Math.ceil((600e3 - (now - fails[0])) / 60000)} dakika sonra tekrar dene.` });
    if (ipFails.length >= 25) return cb({ error: 'Bu bağlantıdan çok fazla hatalı giriş denendi. 15 dakika sonra tekrar dene.' });
    // Şifre kontrolü bitene kadar deneme hatalı sayılır: aynı anda yüzlerce istek atıp sınırı aşmak mümkün olmasın
    fails.push(now); ipFails.push(now);
    let u = findUserBy(name);
    const ok = await pwOk(u, password);
    if (u && !db.users[u.name]) u = null; // beklerken hesap silindiyse
    if (!u || !ok) { if (ipFails.length === 25) secLog('giris-denemesi', 'ip:' + ip, '15 dakikada 25 hatalı giriş'); return cb({ error: fails.length >= 5 ? 'Çok fazla hatalı deneme, 10 dakika bekle.' : 'Kullanıcı adı / e-posta ya da şifre yanlış.' }); }
    for (const a of [fails, ipFails]) { const i = a.lastIndexOf(now); if (i >= 0) a.splice(i, 1); } // şifre doğru: geçici kaydı geri al
    if (u.tfa?.on) {
      if (!code) return cb({ needTfa: true });
      if (!tfaPass(u, code)) { fails.push(now); limits.set(key, fails); return cb({ needTfa: true, error: fails.length >= 5 ? 'Çok fazla hatalı deneme, 10 dakika bekle.' : 'Doğrulama kodu yanlış. Uygulamadaki güncel 6 haneli kodu ya da bir yedek kodu yaz.' }); }
      save();
    }
    limits.delete(key);
    if (isBanned(u)) return cb({ error: banText(u), banned: true });
    cb(start(u.name));
  });

  socket.on('auth', (token, cb) => {
    const n = sessGet(token);
    if (!n || !db.users[n]) return cb({ error: 'Oturum bulunamadı' });
    sessDel(token);
    if (isBanned(db.users[n])) return cb({ error: banText(db.users[n]), banned: true });
    cb(start(n));
  });

  socket.on('onbReset', (cb = () => {}) => {
    const u = db.users[me]; if (!u) return cb({ error: 'Giriş yap' });
    u.onb = {}; save(); cb({ ok: true, onb: u.onb });
  });
  socket.on('onbMark', ({ k, serverId } = {}, cb = () => {}) => {
    if (!me || k !== 'invite') return cb({ error: 'Geçersiz' });
    onbFlag(me, 'invite');
    const sv = serverId && db.servers.find(x => x.id === serverId);
    if (sv && sv.owner === me && !setupOf(sv).invite) { setupOf(sv).invite = true; save(); pushServers([me]); }
    cb({ ok: true });
  });
  socket.on('onbClaim', (cb = () => {}) => {
    const u = db.users[me]; if (!u) return cb({ error: 'Giriş yap' });
    const ob = onbOf(u);
    if (ob.rewarded) return cb({ ok: true, already: true, onb: ob });
    if (!Object.values(onbSteps(u)).every(Boolean)) return cb({ error: 'Adımlar henüz bitmedi' });
    ob.rewarded = true; addXp(u.name, 100, 'rehber'); save();
    pushUsers(); cb({ ok: true, xp: 100, onb: ob });
  });
  socket.on('setupSet', ({ serverId, k } = {}, cb = () => {}) => {
    const sv = db.servers.find(x => x.id === serverId);
    if (!sv || sv.owner !== me || !['done', 'dismissed'].includes(k)) return cb({ error: 'Geçersiz' });
    setupOf(sv)[k] = true; save(); pushServers([me]); cb({ ok: true });
  });
  socket.on('onbStats', (cb = () => {}) => {
    if (!siteAdmin(me)) return cb({ error: 'Sadece yönetim görebilir' });
    const us = Object.values(db.users).filter(u => (u.createdAt || 0) >= ONB_SINCE);
    const cnt = f => us.filter(f).length;
    const svs = db.servers.filter(x => !x.public && (x.createdAt || 0) >= ONB_SINCE);
    cb({ ok: true, since: ONB_SINCE, total: us.length,
      steps: { seen: cnt(u => u.onb?.seen), join: cnt(u => serversFor(u.name).some(x => x.id !== 's1')), msg: cnt(u => u.onb?.msg), voice: cnt(u => u.onb?.voice),
        invite: cnt(u => u.onb?.invite), profile: cnt(u => u.onb?.profile), rewarded: cnt(u => u.onb?.rewarded), dismissed: cnt(u => u.onb?.dismissed) },
      servers: { total: svs.length, ready: svs.filter(x => x.setup?.done).length, three: svs.filter(x => membersOf(x).length >= 3).length } });
  });
  // ---- Hesap: e-posta, veri indirme, hesap silme ----
  socket.on('setEmail', ({ email, password } = {}, cb = () => {}) => {
    const u = db.users[me]; if (!u) return cb({ error: 'Giriş yap' });
    if (limited('pw|' + me, 5, 600e3)) return cb({ error: 'Çok fazla deneme, biraz bekle.' });
    if (hashPw(String(password ?? ''), u.salt) !== u.hash) return cb({ error: 'Şifre yanlış' });
    email = clean(email, 190).toLowerCase();
    if (!EMAIL_RE.test(email)) return cb({ error: 'Geçerli bir e-posta adresi yaz' });
    if (Object.values(db.users).some(x => x !== u && x.email === email)) return cb({ error: 'Bu e-posta başka bir hesapta kayıtlı' });
    u.email = email; save(); cb({ ok: true, email });
  });
  socket.on('exportData', (cb = () => {}) => {
    const u = db.users[me]; if (!u) return cb({ error: 'Giriş yap' });
    if (limited('export|' + me, 3, 3600e3)) return cb({ error: 'Saatte en fazla 3 kez indirebilirsin' });
    const { salt, hash, ...profile } = u, msgs = [];
    for (const [k, list] of Object.entries(msgRaw)) for (const m of list) if (m.author === me)
      msgs.push({ yer: k.startsWith('dm:') ? 'DM: ' + dmPeers(k).filter(n => n !== me).join(', ') : (findChannel(k) ? findChannel(k).s.name + ' #' + findChannel(k).c.name : k), zaman: new Date(m.time).toISOString(), tur: m.kind, metin: m.text || '', resim: m.image || null });
    cb({ ok: true, data: { aciklama: 'Kanka Chat hesabında hakkında tuttuğumuz veriler (KVKK md. 11)', indirilme: new Date().toISOString(), profil: profile, sunucular: serversFor(me).filter(s => !s.public).map(s => ({ ad: s.name, sahip: s.owner === me, katilim: s.joinedAt?.[me] ? new Date(s.joinedAt[me]).toISOString() : null })), mesajlar: msgs } });
  });
  // ----- İki adımlı doğrulama -----
  socket.on('tfaStatus', (cb = () => {}) => { const u = db.users[me]; if (!u) return cb({}); cb({ on: !!u.tfa?.on, backupLeft: u.tfa?.backup?.length || 0, at: u.tfa?.at || null }); });
  socket.on('tfaSetup', ({ password } = {}, cb = () => {}) => {
    const u = db.users[me]; if (!u) return cb({ error: 'Giriş yap' });
    if (limited('pw|' + me, 5, 600e3)) return cb({ error: 'Çok fazla deneme, biraz bekle.' });
    if (hashPw(String(password ?? ''), u.salt) !== u.hash) return cb({ error: 'Şifre yanlış' });
    if (u.tfa?.on) return cb({ error: 'İki adımlı doğrulama zaten açık' });
    const secret = b32enc(crypto.randomBytes(20));
    tfaPending.set(me, { secret, exp: Date.now() + 15 * 60e3 });
    const uri = `otpauth://totp/${encodeURIComponent('Kanka:' + me)}?secret=${secret}&issuer=Kanka&digits=6&period=30`;
    const out = svg => cb({ ok: true, secret: secret.replace(/(.{4})/g, '$1 ').trim(), uri, svg });
    let qr = null; try { qr = require('qrcode'); } catch {} // paket kurulamamışsa QR'sız devam: kod elle girilir
    if (!qr) return out(null);
    qr.toString(uri, { type: 'svg', margin: 1, color: { dark: '#17110e', light: '#ffffff' } }, (e, svg) => out(e ? null : svg));
  });
  socket.on('tfaEnable', ({ code } = {}, cb = () => {}) => {
    const u = db.users[me], p = tfaPending.get(me); if (!u) return cb({ error: 'Giriş yap' });
    if (!p || p.exp < Date.now()) return cb({ error: 'Kurulum süresi doldu, baştan başla' });
    if (limited('tfa|' + me, 10, 600e3)) return cb({ error: 'Çok fazla deneme, biraz bekle.' });
    const ctr = totpCheck(p.secret, code); if (ctr < 0) return cb({ error: 'Kod yanlış. Uygulamadaki güncel 6 haneli kodu yaz (her 30 saniyede değişir).' });
    const backup = Array.from({ length: 10 }, () => { const c = Array.from({ length: 8 }, () => CODE_ABC[crypto.randomInt(CODE_ABC.length)]).join(''); return c.slice(0, 4) + '-' + c.slice(4); });
    u.tfa = { on: true, secret: p.secret, last: ctr, backup: backup.map(hashCode), at: Date.now() };
    tfaPending.delete(me); secLog('2fa-acildi', me, ''); save();
    cb({ ok: true, backup });
  });
  socket.on('tfaDisable', ({ password, code } = {}, cb = () => {}) => {
    const u = db.users[me]; if (!u) return cb({ error: 'Giriş yap' });
    if (limited('pw|' + me, 5, 600e3)) return cb({ error: 'Çok fazla deneme, biraz bekle.' });
    if (hashPw(String(password ?? ''), u.salt) !== u.hash) return cb({ error: 'Şifre yanlış' });
    if (!tfaPass(u, code)) return cb({ error: 'Doğrulama kodu yanlış' });
    delete u.tfa; secLog('2fa-kapatildi', me, ''); save(); cb({ ok: true });
  });
  socket.on('tfaNewBackup', ({ code } = {}, cb = () => {}) => {
    const u = db.users[me]; if (!u?.tfa?.on) return cb({ error: 'İki adımlı doğrulama kapalı' });
    if (limited('tfa|' + me, 10, 600e3)) return cb({ error: 'Çok fazla deneme, biraz bekle.' });
    if (!tfaPass(u, code)) return cb({ error: 'Doğrulama kodu yanlış' });
    const backup = Array.from({ length: 10 }, () => { const c = Array.from({ length: 8 }, () => CODE_ABC[crypto.randomInt(CODE_ABC.length)]).join(''); return c.slice(0, 4) + '-' + c.slice(4); });
    u.tfa.backup = backup.map(hashCode); save(); cb({ ok: true, backup });
  });
  // ----- Sunucu silme (7 gün çöp kutusu), geri getirme, sahiplik devri -----
  const ownerCheck = (s, password, code, cb) => {
    const u = db.users[me];
    if (!s || s.owner !== me) { cb({ error: 'Bunu sadece sunucunun sahibi yapabilir' }); return false; }
    if (s.public) { cb({ error: 'Bu sunucu silinemez' }); return false; }
    if (limited('pw|' + me, 5, 600e3)) { cb({ error: 'Çok fazla deneme, biraz bekle.' }); return false; }
    if (hashPw(String(password ?? ''), u.salt) !== u.hash) { cb({ error: 'Şifre yanlış' }); return false; }
    if (!tfaPass(u, code)) { cb({ error: 'İki adımlı doğrulama kodu yanlış', needTfa: true }); return false; }
    return true;
  };
  socket.on('serverDelete', ({ serverId, name, password, code } = {}, cb = () => {}) => {
    const s = db.servers.find(x => x.id === serverId);
    if (s && String(name || '').trim() !== s.name) return cb({ error: 'Onay için sunucunun adını aynen yaz' });
    if (!ownerCheck(s, password, code, cb)) return;
    voiceKick(s.channels.map(c => c.id), null, `${s.name} sunucusu kapatıldı`);
    const who = membersOf(s);
    for (const n of Object.keys(s.energy || {})) energyRelease(n, s.id);
    db.servers = db.servers.filter(x => x !== s);
    (db.trash ||= []).push({ server: s, at: Date.now(), by: me });
    audit(s, me, 'Sunucuyu sildi (7 gün çöp kutusunda)');
    secLog('sunucu-silindi', me, `${s.name} (${s.id})`); save();
    pushServers(who); for (const n of who) if (n !== me) io.to('user:' + n).emit('toast', `${s.name} sunucusu kapatıldı`);
    cb({ ok: true });
  });
  socket.on('trashList', (cb = () => {}) => {
    const now = Date.now();
    cb((db.trash || []).filter(t => t.server.owner === me).map(t => ({ id: t.server.id, name: t.server.name, icon: t.server.icon, iconImg: t.server.iconImg || null, members: t.server.members.length, at: t.at, left: Math.max(0, Math.ceil((t.at + 7 * 864e5 - now) / 864e5)) })));
  });
  socket.on('serverRestore', ({ serverId } = {}, cb = () => {}) => {
    const t = (db.trash || []).find(x => x.server.id === serverId && x.server.owner === me);
    if (!t) return cb({ error: 'Sunucu bulunamadı ya da süresi doldu' });
    db.trash = db.trash.filter(x => x !== t); db.servers.push(t.server);
    audit(t.server, me, 'Sunucuyu geri getirdi'); save();
    pushServers(membersOf(t.server)); for (const n of membersOf(t.server)) if (n !== me) io.to('user:' + n).emit('toast', `${t.server.name} sunucusu geri açıldı 🎉`);
    cb({ ok: true });
  });
  socket.on('serverTransfer', ({ serverId, to, password, code } = {}, cb = () => {}) => {
    const s = db.servers.find(x => x.id === serverId);
    if (!ownerCheck(s, password, code, cb)) return;
    if (!to || to === me || !s.members.includes(to) || !db.users[to]) return cb({ error: 'Sahipliği bu sunucunun bir üyesine devredebilirsin' });
    s.owner = to; delete s.roles?.[to];
    audit(s, me, 'Sahipliği devretti', to); secLog('sahiplik-devri', me, `${s.name} → ${to}`); save();
    pushServers(membersOf(s)); io.to('user:' + to).emit('toast', `👑 ${me}, ${s.name} sunucusunun sahipliğini sana devretti`);
    cb({ ok: true });
  });
  socket.on('deleteAccount', ({ password, confirm, code } = {}, cb = () => {}) => {
    const u = db.users[me]; if (!u) return cb({ error: 'Giriş yap' });
    if (limited('pw|' + me, 5, 600e3)) return cb({ error: 'Çok fazla deneme, biraz bekle.' });
    if (hashPw(String(password ?? ''), u.salt) !== u.hash) return cb({ error: 'Şifre yanlış' });
    if (String(confirm || '') !== me) return cb({ error: 'Onay için kullanıcı adını aynen yaz' });
    if (!tfaPass(u, code)) return cb({ error: 'İki adımlı doğrulama kodu yanlış', needTfa: true });
    if (db.servers.find(x => x.id === 's1')?.owner === me) return cb({ error: 'Kanka HQ sahibi hesabını silemez' });
    const name = me, touched = onlineNames();
    deleteUserData(name);
    cb({ ok: true });
    pushUsers(); pushServers(touched.filter(n => n !== name));
    setTimeout(() => io.in('user:' + name).disconnectSockets(true), 200);
  });
  socket.on('myCodes', (cb = () => {}) => {
    if (!me) return cb({ error: 'Giriş yap' });
    const list = myCodes(me); save();
    cb({ ok: true, beta: db.beta.on, codes: list, joined: Object.values(db.users).filter(u => u.invitedBy === me).length });
  });

  // ---- Şikayetler ----
  socket.on('report', ({ kind, msgId, chId, name, reason, note, open: openIn } = {}, cb = () => {}) => {
    if (!me) return cb({ error: 'Giriş yap' });
    if (!REPORT_REASONS[reason]) return cb({ error: 'Bir sebep seç' });
    if (limited('report|' + me, 15, 3600e3)) return cb({ error: 'Çok fazla şikayet gönderdin, biraz bekle' });
    let r;
    if (kind === 'msg') {
      if (!canAccess(me, chId)) return cb({ error: 'Bu mesaja erişimin yok' });
      const list = db.messages[chId] || [], i = list.findIndex(m => m.id === msgId), m = list[i];
      if (!m) return cb({ error: 'Mesaj bulunamadı' });
      if (m.author === me) return cb({ error: 'Kendi mesajını şikayet edemezsin' });
      if (db.reports.some(x => x.by === me && x.msg?.id === msgId)) return cb({ ok: true, dup: true });
      // Şifreli mesaj: ekip sadece şikayet edenin açıp gönderdiği mesajları görür; her biri gönderenin mühürüyle doğrulanır
      const open = {}; for (const o of Array.isArray(openIn) ? openIn.slice(0, 8) : []) { const x = findMsg(chId, o?.id); if (x?.enc && e2eFrankOk(x, o.plain, o.fk)) { try { const j = JSON.parse(o.plain); open[x.id] = { text: String(j.t || '').slice(0, 600) + (j.f?.length ? ` [${j.f.length} dosya]` : '') + (j.g ? ' [GIF]' : ''), ok: true }; } catch {} } }
      if (m.enc && !open[m.id]) return cb({ error: 'Şifreli mesaj doğrulanamadı, sayfayı yenileyip tekrar dene' });
      const f = findChannel(chId), snap = x => ({ id: x.id, author: x.author, text: x.enc ? (open[x.id]?.text ?? '🔒 şifreli (şikayet eden açmadı)') : (x.text || '').slice(0, 600), image: x.image || null, kind: x.kind, time: x.time, e2e: x.enc ? (open[x.id] ? 'dogrulandi' : 'kapali') : undefined });
      r = { kind: 'msg', target: m.author, chId, serverId: f && !f.s.public ? f.s.id : null, where: f ? `${f.s.name} · #${f.c.name}` : isPrivateChat(chId) ? (chId.startsWith('dm:') ? 'Özel mesaj' : 'Grup sohbeti') : '',
        msg: snap(m), context: list.slice(Math.max(0, i - 3), i).concat(list.slice(i + 1, i + 2)).map(snap) };
    } else if (kind === 'user') {
      if (!db.users[name] || name === me) return cb({ error: 'Kullanıcı bulunamadı' });
      if (db.reports.some(x => x.by === me && x.kind === 'user' && x.target === name && x.status === 'open')) return cb({ ok: true, dup: true });
      const sv = db.servers.find(x => x.id === chId && !x.public && x.members.includes(me) && x.members.includes(name));
      r = { kind: 'user', target: name, serverId: sv?.id || null, where: sv ? sv.name : 'Profil' };
    } else return cb({ error: 'Geçersiz' });
    Object.assign(r, { id: id(), by: me, reason, note: clean(note, 500), at: Date.now(), status: 'open', urgent: reason === 'cocuk' });
    db.reports.unshift(r); if (db.reports.length > 3000) db.reports.length = 3000;
    save(); cb({ ok: true });
    for (const n of pushReports(r)) if (n !== me) io.to('user:' + n).emit('reportNew', { id: r.id, target: r.target, reason: REPORT_REASONS[reason], where: r.where, serverId: reportVisible(r, n) && !siteAdmin(n) ? r.serverId : null, urgent: r.urgent });
  });
  socket.on('reportCounts', (cb = () => {}) => cb(me ? reportCounts(me) : {}));
  socket.on('reports', ({ serverId, status = 'open' } = {}, cb = () => {}) => {
    if (!me) return cb({ error: 'Giriş yap' });
    let list;
    if (serverId) { const s = srvOf(serverId); if (!s || !isMod(s, me)) return cb({ error: 'Yetkin yok' }); list = db.reports.filter(r => r.serverId === serverId); }
    else { if (!siteMod(me)) return cb({ error: 'Yetkin yok' }); list = db.reports; }
    list = list.filter(r => status === 'all' || r.status === status).slice(0, 200);
    cb({ ok: true, reports: list.map(r => reportView(r, me)) });
  });
  socket.on('reportAct', ({ id: rid, action, label, reason } = {}, cb = () => {}) => {
    const r = db.reports.find(x => x.id === rid); if (!r || !reportVisible(r, me)) return cb({ error: 'Yetkin yok' });
    const site = siteAdmin(me), s = srvOf(r.serverId);
    const close = txt => { r.status = 'done'; r.handledBy = me; r.handledAt = Date.now(); r.action = txt; };
    if (action === 'dismiss') close('Kural ihlali yok');
    else if (action === 'reopen') { r.status = 'open'; delete r.action; delete r.handledBy; }
    else if (action === 'delete') {
      const list = db.messages[r.chId] || [], i = list.findIndex(m => m.id === r.msg?.id);
      if (i >= 0) {
        if (!site && !(s && s.channels.some(c => c.id === r.chId))) return cb({ error: 'Bu mesajı silemezsin' });
        const [gm] = list.splice(i, 1); io.to(r.chId).emit('remove', { channelId: r.chId, msgId: r.msg.id }); unActivity(r.chId, [gm]);
        if (s) audit(s, me, 'Şikayet üzerine mesaj sildi', `${r.target}: ${(r.msg.text || '').slice(0, 60)}`);
      }
      close('Mesaj silindi');
    } else if (action === 'warn') {
      if (!canStaff(me, 'warn')) return cb({ error: 'Yetkin yok' });
      siteWarnUser(r.target, me, reason || REPORT_REASONS[r.reason]); close('Uyarıldı');
    } else if (action === 'suspend') {
      if (!canStaff(me, 'suspend')) return cb({ error: 'Yetkin yok' });
      if (staffRank(r.target)) return cb({ error: 'Ekipten biri askıya alınamaz' });
      const days = [1, 3, 7].includes(+label) ? +label : 1;
      siteBanUser(r.target, me, reason || REPORT_REASONS[r.reason], Date.now() + days * 864e5); close(`${days} gün askıya alındı`);
    } else if (action === 'siteban') {
      if (!site) return cb({ error: 'Sadece Kanka yönetimi' });
      if (siteAdmin(r.target)) return cb({ error: 'Yönetici kapatılamaz' });
      siteBanUser(r.target, me, reason || REPORT_REASONS[r.reason]);
      for (const x of db.reports) if (x.target === r.target && x.status === 'open') { x.status = 'done'; x.handledBy = me; x.handledAt = Date.now(); x.action = 'Hesap kapatıldı'; }
    } else if (action === 'resolve') close(clean(label, 60) || 'Gereken yapıldı');
    else return cb({ error: 'Geçersiz işlem' });
    if (r.status === 'done' && r.by && db.users[r.by] && r.by !== me) io.to('user:' + r.by).emit('toast', `🛡️ Şikayetin incelendi, teşekkürler. Sonuç: ${r.action}`);
    save(); pushReports(r); cb({ ok: true, report: reportView(r, me) });
  });

  // ---- Kanka yönetimi ----
  const SA = cb => { if (siteAdmin(me)) return true; cb({ error: 'Sadece Kanka yönetimi' }); return false; };
  socket.on('adminBeta', (cb = () => {}) => {
    if (!SA(cb)) return;
    const codes = Object.entries(db.codes);
    cb({ ok: true, ...betaInfo(), cap: db.beta.cap, users: userCount(), mail: !!getMailer(),
      codes: { total: codes.length, used: codes.filter(([, c]) => c.usedBy).length },
      adminCodes: codes.filter(([, c]) => c.by === 'kanka').slice(-60).reverse().map(([code, c]) => ({ code, usedBy: c.usedBy || null, note: c.note || '' })),
      waitlist: db.waitlist.map((w, i) => ({ i, email: w.email, at: w.at, ref: w.ref, invited: w.invited || null, code: w.code || null, joined: w.joined || null })).reverse().slice(0, 300),
      top: Object.entries(Object.values(db.users).reduce((a, u) => (u.invitedBy && (a[u.invitedBy] = (a[u.invitedBy] || 0) + 1), a), {})).sort((a, b) => b[1] - a[1]).slice(0, 5) });
  });
  socket.on('adminBetaSet', ({ on, cap } = {}, cb = () => {}) => {
    if (!SA(cb)) return;
    if (on !== undefined) db.beta.on = !!on;
    if (cap !== undefined) db.beta.cap = Math.max(1, Math.min(100000, +cap || 300));
    save(); cb({ ok: true });
  });
  socket.on('adminCodes', ({ n = 1, note } = {}, cb = () => {}) => {
    if (!SA(cb)) return;
    const out = Array.from({ length: Math.max(1, Math.min(50, +n || 1)) }, () => newCode('kanka', clean(note, 40) || 'Yönetim: ' + me));
    save(); cb({ ok: true, codes: out });
  });
  socket.on('adminInviteWait', async ({ n = 10, emails } = {}, cb = () => {}) => {
    if (!SA(cb)) return;
    const pick = (Array.isArray(emails) && emails.length ? db.waitlist.filter(w => emails.includes(w.email)) : db.waitlist.filter(w => !w.invited).slice(0, Math.max(1, Math.min(100, +n || 10)))).filter(w => !w.joined);
    const out = [];
    for (const w of pick) {
      if (!w.code || db.codes[w.code]?.usedBy) w.code = newCode('kanka', 'Bekleme: ' + w.email);
      w.invited = Date.now();
      out.push({ email: w.email, code: w.code, sent: await sendInviteMail(w.email, w.code) });
    }
    save(); cb({ ok: true, sent: out });
  });
  socket.on('adminSec', (cb = () => {}) => { if (!SA(cb)) return; cb({ log: (db.secLog || []).slice(0, 100) }); });
  socket.on('adminBackup', ({ now, mail, pulled } = {}, cb = () => {}) => {
    if (pulled) { if (siteAdmin(me)) { db.backupLog = { ...(db.backupLog || {}), desktop: { at: Date.now(), by: me, dir: clean(pulled.dir, 200), name: clean(pulled.name, 80) } }; save(); } return cb({ ok: true }); }
    if (!SA(cb)) return;
    if (now) backup(true);
    if (typeof mail === 'boolean') { db.backupCfg = { ...(db.backupCfg || {}), mail }; save(); }
    cb({ list: backupList().slice(0, 14), recovered: dbRecovered, log: db.backupLog || {}, mailOn: db.backupCfg?.mail !== false, mailReady: !!mailCfg?.ok });
  });
  let gifHits = [];
  socket.on('gifs', ({ q, page } = {}, cb = () => {}) => {
    if (typeof cb !== 'function') return;
    if (!me) return cb({ error: 'Giriş yapmalısın' });
    const now = Date.now(); gifHits = gifHits.filter(t => now - t < 60e3);
    if (gifHits.length >= 40) return cb({ error: 'Biraz yavaş, bir dakika sonra tekrar dene' });
    gifHits.push(now);
    gifFetch(q, page, me).then(cb);
  });
  socket.on('adminGif', ({ set, test } = {}, cb = () => {}) => {
    if (!SA(cb)) return;
    const done = r => cb(r.error ? { error: r.error } : { ok: true, provider: gifCfg?.provider, count: r.items.length, sample: r.items.slice(0, 4).map(x => x.prev) });
    if (set?.off) { gifCfg = null; gifCache.clear(); try { fs.unlinkSync(GIF_FILE); } catch {} io.emit('gifOn', false); return cb({ ok: true, on: false }); }
    if (set) {
      const provider = set.provider === 'giphy' ? 'giphy' : 'klipy', key = String(set.key || '').trim().slice(0, 120) || (gifCfg?.provider === provider ? gifCfg.key : '');
      if (!/^[\w-]{8,120}$/.test(key)) return cb({ error: 'Anahtar geçersiz görünüyor' });
      const prev = gifCfg; gifCfg = { provider, key }; gifCache.clear();
      return gifFetch('merhaba', 1, me).then(r => {
        if (r.error && r.bad) { gifCfg = prev; return cb({ error: 'Servis bu anahtarı kabul etmedi, kopyalarken eksik kalmış olabilir' }); }
        gifSaveCfg(); io.emit('gifOn', true); done(r);
      });
    }
    if (test) return gifFetch('merhaba', 1, me).then(done);
    cb({ ok: true, on: gifReady(), provider: gifCfg?.provider || 'klipy', hasKey: !!gifCfg?.key });
  });
  socket.on('adminMail', ({ set, test } = {}, cb = () => {}) => {
    if (!SA(cb)) return;
    if (set) {
      const cfg = { user: clean(set.user, 190), pass: String(set.pass || '').replace(/\s+/g, '').slice(0, 200) || mailCfg?.pass || '', host: clean(set.host, 120), port: +set.port || 465, url: clean(set.url, 200).replace(/\/+$/, '') || baseUrl() };
      if (!EMAIL_RE.test(cfg.user)) return cb({ error: 'Gönderen e-posta adresi geçersiz' });
      mailCfg = cfg; mailer = null;
      try { fs.writeFileSync(MAIL_FILE, JSON.stringify(cfg)); } catch (e) { return cb({ error: 'Kaydedilemedi: ' + e.message }); }
    }
    if (test) {
      const to = db.users[me]?.email || mailCfg?.user;
      return (async () => {
        const t = getMailer(); if (!t) return cb({ error: 'Önce ayarları kaydet' });
        try { await t.verify(); } catch (e) {
          mailCfg.ok = false; try { fs.writeFileSync(MAIL_FILE, JSON.stringify(mailCfg)); } catch {}
          const bad = /535|BadCredentials|Invalid login/i.test(e.message);
          return cb({ error: bad ? 'Gmail şifreyi kabul etmedi. Normal Gmail şifren değil, 16 harfli uygulama şifresi olmalı; 2 adımlı doğrulama açık ve şifre aynı hesapta oluşturulmuş olmalı.' : 'Bağlanamadı: ' + e.message.slice(0, 160) });
        }
        mailCfg.ok = true; try { fs.writeFileSync(MAIL_FILE, JSON.stringify(mailCfg)); } catch {}
        const ok = await sendMail(to, 'Kanka Chat test e-postası', mailHtml('E-posta çalışıyor 🎉', 'Bu test e-postası geldiyse şifre sıfırlama ve bekleme listesi davetleri hazır.'));
        cb(ok ? { ok: true, to } : { error: 'Gönderilemedi, sunucu kayıtlarına bak' });
      })();
    }
    const noMail = Object.values(db.users).filter(u => !u.email && !u.bot && u.name !== 'Claude' && u.name !== BOT_NAME).length;
    const health = { lastOk: mailHealth.lastOk, lastErr: mailHealth.lastErrAt > mailHealth.lastOk ? mailHealth.lastErr : '', lastErrAt: mailHealth.lastErrAt, noMail, total: Object.keys(db.users).length, log: (db.mailLog || []).slice(-15).reverse() };
    cb({ ok: true, health, cfg: mailCfg ? { user: mailCfg.user, host: mailCfg.host || '', port: mailCfg.port || 465, url: mailCfg.url || baseUrl(), hasPass: !!mailCfg.pass } : { url: baseUrl() }, ready: !!getMailer() && mailCfg?.ok === true, unverified: !!getMailer() && mailCfg?.ok !== true, failed: mailCfg?.ok === false });
  });
  // ---- Yönetim paneli: kullanıcılar, ekip, istatistik, kayıtlar ----
  const SM = cb => { if (siteMod(me)) return true; cb({ error: 'Sadece Kanka ekibi' }); return false; };
  const userCard = u => ({ spark: u.spark ? { active: sparkOn(u), until: u.spark.until, months: u.spark.credited || 0, energy: (u.spark.energy || []).length } : null, linked: canStaff(me, 'lookup') ? linkedOf(u) : [], name: u.name, email: canStaff(me, 'email') && u.email ? u.email.replace(/^(.{2}).*(@.*)$/, '$1•••$2') : null, createdAt: u.createdAt, invitedBy: u.invitedBy || null,
    banned: isBanned(u) ? u.siteBan : null, reports: db.reports.filter(r => r.target === u.name).length, servers: serversFor(u.name).filter(s => !s.public).length,
    level: level(u.xp), xp: u.xp || 0, msgs: u.msgs || 0, streak: u.streak?.count || 0, age: u.ageLock ? 'locked' : u.dob ? 'ok' : 'none', online: onlineNames().includes(u.name), rank: staffRank(u.name),
    warns: (u.siteWarns || []).slice(-10).reverse().map(w => ({ at: w.at, by: w.by, reason: w.reason, seen: w.seen })) });
  // ---- Spark & Energy basma (kurucu ve yöneticiler): kullanıcıya Spark süresi / Energy, sunucuya doğrudan Energy ----
  // Sunucuya basılan Energy '@kanka' adıyla tutulur: seviyeye sayılır, kimsenin hesabından düşmez, Spark bitince silinmez.
  const mintLog = (kind, target, n, note) => { (db.mintLog ||= []).push({ at: Date.now(), by: me, kind, target, n, note: note || '' }); db.mintLog = db.mintLog.slice(-200); };
  socket.on('adminMint', ({ act, user, server, n, months, note } = {}, cb = () => {}) => {
    if (typeof cb !== 'function') cb = () => {};
    if (!SM(cb)) return; if (!canStaff(me, 'ban')) return cb({ error: 'Spark ve Energy basma yetkin yok' });
    note = clean(note, 120);
    if (act === 'list') {
      const srvLite = sv => ({ id: sv.id, name: sv.name, icon: sv.icon, iconImg: sv.iconImg || null, members: membersOf(sv).length, total: energyTotal(sv), level: energyLevel(sv), kanka: sv.energy?.['@kanka'] || 0 });
      const q = clean(server, 60).toLocaleLowerCase('tr');
      const srvs = q ? db.servers.filter(sv => !sv.public && (sv.id === q || sv.invite === q || sv.vanity === q || sv.name.toLocaleLowerCase('tr').includes(q))).slice(0, 12).map(srvLite) : [];
      const sparks = Object.values(db.users).filter(u => sparkOn(u)).map(u => ({ name: u.name, until: u.spark.until, play: !!u.spark.play, energy: (u.spark.energy || []).length, free: (u.spark.energy || []).filter(x => !x.srv).length })).sort((a, b) => b.until - a.until);
      const boosted = db.servers.filter(sv => energyTotal(sv) > 0).map(srvLite).sort((a, b) => b.total - a.total).slice(0, 30);
      return cb({ ok: true, srvs, sparks, boosted, levels: ENERGY_LV, log: (db.mintLog || []).slice(-60).reverse() });
    }
    if (act === 'spark' || act === 'energy') {
      const u = findUserBy(user); if (!u) return cb({ error: 'Kullanıcı bulunamadı' });
      if (act === 'spark') {
        const m = Math.max(-24, Math.min(24, parseInt(months) || 0)); if (!m) return cb({ error: 'Ay sayısı gir (1-24, kısaltmak için eksi)' });
        if (m < 0) { if (!sparkOn(u)) return cb({ error: 'Aktif Spark aboneliği yok' }); if (u.spark.play) return cb({ error: 'Bu abonelik Google Play üzerinden, süresi oradan yönetilir' });
          u.spark.until += m * SPARK_MONTH; if (u.spark.until <= Date.now()) sparkExpire(u, 'Kanka Spark aboneliğin ekip tarafından sonlandırıldı'); else { save(); io.to('user:' + u.name).emit('spark', sparkView(u)); pushUsers(); } }
        else sparkGrant(u, m, me);
        staffLog(me, `Kanka Spark ${m > 0 ? 'verdi' : 'kısalttı'} (${m} ay)`, u.name); mintLog('spark', u.name, m, note);
        return cb({ ok: true, until: u.spark?.until || null });
      }
      const k = Math.max(-100, Math.min(100, parseInt(n) || 0)); if (!k) return cb({ error: 'Energy miktarı gir (1-100, geri almak için eksi)' });
      if (!sparkOn(u)) return cb({ error: 'Energy sadece Spark üyelerinin hesabında durur. Önce Spark ver ya da Energy\'yi doğrudan sunucuya bas.' });
      const e = (u.spark.energy ||= []);
      if (k > 0) for (let i = 0; i < k; i++) e.push({ id: id(), at: Date.now(), src: 'ekip' });
      else { let left = -k; for (let i = e.length - 1; i >= 0 && left; i--) if (!e[i].srv) { e.splice(i, 1); left--; } if (left === -k) return cb({ error: 'Boşta Energy yok (sunucudakiler önce geri çekilmeli)' }); }
      save(); io.to('user:' + u.name).emit('spark', sparkView(u));
      if (k > 0) botDm(u.name, { title: '⚡ Hediye Energy!', tone: 'good', text: `Kanka ekibi hesabına ${k} Energy ekledi${note ? `: ${note}` : ''}. Bir sunucunun sayfasında "Sunucuya Energy Gönder" ile kullanabilirsin.` });
      staffLog(me, `Energy ${k > 0 ? 'verdi' : 'aldı'} (${Math.abs(k)})`, u.name); mintLog('energy', u.name, k, note);
      return cb({ ok: true, energy: e.length });
    }
    if (act === 'server') {
      const sv = db.servers.find(x => x.id === server); if (!sv || sv.public) return cb({ error: 'Sunucu bulunamadı' });
      const k = Math.max(-500, Math.min(500, parseInt(n) || 0)); if (!k) return cb({ error: 'Energy miktarı gir (geri almak için eksi)' });
      sv.energy ||= {}; const before = energyLevel(sv), cur = sv.energy['@kanka'] || 0, nv = Math.max(0, cur + k);
      if (nv) sv.energy['@kanka'] = nv; else delete sv.energy['@kanka'];
      save(); pushServers(membersOf(sv));
      const after = energyLevel(sv);
      if (after > before && sv.owner) botDm(sv.owner, { title: `⚡ ${sv.name} Energy Level ${after} oldu!`, tone: 'good', text: `Kanka ekibi sunucuna ${nv - cur} Energy hediye etti${note ? `: ${note}` : ''}. Yeni avantajlar sunucu ayarlarında açıldı.` });
      staffLog(me, `Sunucuya Energy ${k > 0 ? 'bastı' : 'geri aldı'} (${Math.abs(nv - cur)})`, sv.name); mintLog('server', sv.name, nv - cur, note);
      return cb({ ok: true, total: energyTotal(sv), level: after, kanka: nv });
    }
    cb({ error: 'Bilinmeyen işlem' });
  });
  socket.on('adminUser', ({ name, action, reason, days, confirm } = {}, cb = () => {}) => {
    if (!SM(cb)) return;
    const u = findUserBy(name); if (!u) return cb({ error: 'Kullanıcı bulunamadı' });
    const deny = () => cb({ error: 'Bunun için yetkin yok' });
    if (action && u.name !== me && staffRank(u.name) === 'owner') return cb({ error: 'Kurucuya işlem yapılamaz' });
    if (action === 'resetLink') { if (!canStaff(me, 'reset')) return deny(); if (staffRank(u.name) && u.name !== me && staffRank(me) !== 'owner') return cb({ error: 'Ekipten birinin şifre linkini sadece kurucu oluşturabilir' }); staffLog(me, 'Şifre linki oluşturdu', u.name); save(); return cb({ ok: true, link: `${baseUrl()}/login?sifirla=${resetToken(u.name, 24)}` }); }
    if (action === 'ageReset') { if (!canStaff(me, 'ban')) return deny(); delete u.ageLock; delete u.dob; staffLog(me, 'Yaş kilidini kaldırdı', u.name); save(); io.to('user:' + u.name).emit('ageGate', { locked: false }); return cb({ ok: true, user: userCard(u) }); }
    if (action === 'streak') { if (!canStaff(me, 'ban')) return deny(); const n = Math.min(Math.max(parseInt(days) || 0, 0), 3650); u.streak = { last: ymd(), count: n, best: Math.max(n, u.streak?.best || 0) }; staffLog(me, 'Seriyi düzeltti', u.name, n + ' gün'); save(); pushUsers(); }
    if (action === 'spark') { if (!canStaff(me, 'ban')) return deny(); const m = Math.min(Math.max(parseInt(days) || 0, 1), 24); sparkGrant(u, m, me); staffLog(me, `Kanka Spark verdi (${m} ay)`, u.name); }
    if (action === 'sparkOff') { if (!canStaff(me, 'ban')) return deny(); if (!u.spark) return cb({ error: 'Aboneliği yok' }); sparkExpire(u, 'Kanka Spark aboneliğin ekip tarafından sonlandırıldı'); staffLog(me, 'Kanka Spark aboneliğini sonlandırdı', u.name); }
    if (action === 'warn') { if (!canStaff(me, 'warn')) return deny(); if (u.name === me) return cb({ error: 'Kendini uyaramazsın' }); siteWarnUser(u.name, me, reason); }
    if (action === 'suspend') { if (!canStaff(me, 'suspend')) return deny(); if (staffRank(u.name)) return cb({ error: 'Ekipten biri askıya alınamaz' }); const ms = /^h(1|3|6|12)$/.test(String(days)) ? +String(days).slice(1) * 3600e3 : ([1, 3, 7, 30].includes(+days) ? +days : 1) * 864e5; siteBanUser(u.name, me, reason || 'Kural ihlali', Date.now() + ms); }
    if (action === 'ban') { if (!canStaff(me, 'ban')) return deny(); if (staffRank(u.name)) return cb({ error: 'Ekipten biri kapatılamaz' }); siteBanUser(u.name, me, reason); }
    if (action === 'unban') { if (!canStaff(me, 'suspend')) return deny(); if (u.siteBan && !u.siteBan.until && !canStaff(me, 'ban')) return deny(); delete u.siteBan; staffLog(me, 'Hesabı açtı', u.name); save(); }
    if (action === 'delete') {
      if (!canStaff(me, 'del')) return deny();
      if (staffRank(u.name)) return cb({ error: 'Ekipten birinin hesabı silinemez. Önce ekipten çıkar.' });
      if (String(confirm || '') !== u.name) return cb({ error: 'Onay için kullanıcı adını aynen yaz' });
      const nm = u.name, touched = onlineNames();
      io.to('user:' + nm).emit('siteBanned', 'Hesabın Kanka yönetimi tarafından silindi' + (reason ? ': ' + clean(reason, 160) : ''));
      setTimeout(() => io.in('user:' + nm).disconnectSockets(true), 200);
      deleteUserData(nm); staffLog(me, 'Hesabı sildi', nm, reason); save();
      pushUsers(); pushServers(touched.filter(n => n !== nm));
      return cb({ ok: true, deleted: nm });
    }
    save(); cb({ ok: true, user: userCard(u) });
  });
  socket.on('adminBanned', (cb = () => {}) => { if (!SM(cb)) return; cb({ ok: true, list: Object.values(db.users).filter(isBanned).map(u => ({ name: u.name, ...u.siteBan })) }); });
  socket.on('adminStats', (cb = () => {}) => {
    if (!SM(cb)) return;
    const now = Date.now(), us = Object.values(db.users), day = now - 864e5, on = onlineNames();
    let msgsToday = 0; for (const l of Object.values(msgRaw)) for (let i = l.length - 1; i >= 0 && l[i].time > day; i--) msgsToday++;
    const inVoice = new Set(); for (const [, m] of voice) for (const n of m.values()) inVoice.add(n);
    const newest = [...us].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 8).map(u => ({ name: u.name, at: u.createdAt || 0, invitedBy: u.invitedBy || null }));
    cb({ ok: true, users: us.length, online: on.length, new1: us.filter(u => (u.createdAt || 0) > day).length, new7: us.filter(u => (u.createdAt || 0) > now - 7 * 864e5).length,
      servers: db.servers.filter(s => !s.public).length, msgsToday, voice: inVoice.size, reports: db.reports.filter(r => r.status === 'open').length, banned: us.filter(isBanned).length,
      warned: us.filter(u => (u.siteWarns || []).some(w => w.at > now - 30 * 864e5)).length, newest, rank: staffRank(me), sources: (() => {
        const m = new Map(); for (const u of us) { if ((u.createdAt || 0) < now - 30 * 864e5) continue; const k = srcLabel(u.src), r = m.get(k) || { k, n: 0, act: 0, ad: !!(u.src?.g || /google/i.test(u.src?.s || '')) };
          r.n++; if ((u.msgs || 0) > 0 || Object.keys(u.vmin || {}).length) r.act++; m.set(k, r); }
        return [...m.values()].sort((a, b) => b.n - a.n).slice(0, 15); })() });
  });
  socket.on('adminAnalytics', ({ days = 30, src: srcF = null } = {}, cb = () => {}) => {
    if (!SA(cb)) return;
    const N = [7, 30, 90, 365].includes(+days) ? +days : 30, now = Date.now(), today = ymd(), D = k => ymd(new Date(now - k * 864e5));
    const dayOf = t => ymd(new Date(t)), addD = (d, k) => new Date(new Date(d + 'T12:00:00Z').getTime() + k * 864e5).toISOString().slice(0, 10);
    const all = Object.values(db.users).filter(u => !u.bot && u.name !== 'Claude' && u.name !== BOT_NAME);
    const S0 = u => { if (u.via?.srv) return { k: 'Sunucu daveti', d: u.via.name || '' }; if (u.src) { const l = srcLabel(u.src); return { k: l.split(' · ')[0], d: l.includes(' · ') ? l.split(' · ').slice(1).join(' · ') : '' }; } if (u.invitedBy || u.via?.code) return { k: 'Davet kodu', d: u.invitedBy || '' }; return { k: 'Doğrudan / bilinmiyor', d: '' }; };
    const info = u => { const c = u.createdAt ? dayOf(u.createdAt) : null, act = new Set(u.act || []); const age = c ? Math.floor((new Date(today + 'T12:00:00Z') - new Date(c + 'T12:00:00Z')) / 864e5) : 0;
      const later = [...act].filter(d => c && d > c), wk = k => [...act].some(d => d >= addD(c, k * 7) && d < addD(c, k * 7 + 7));
      const srvs = db.servers.filter(x => !x.public && (x.owner === u.name || (x.members || []).includes(u.name))).length;
      return { u, c, age, act, back1: c && act.has(addD(c, 1)), back7: later.some(d => d <= addD(c, 7)), days: act.size, wk, msg: !!(u.firstMsgAt || u.msgs > 0), voice: !!(u.firstVoiceAt || Object.keys(u.vmin || {}).length), srv: srvs > 0, srvs, src: S0(u) }; };
    const cut = now - N * 864e5, recent = all.filter(u => (u.createdAt || 0) >= cut).map(info);
    const R = srcF ? recent.filter(x => x.src.k === srcF) : recent;
    const pct = (arr, f) => arr.length ? Math.round(arr.filter(f).length / arr.length * 100) : null;
    const elig = k => R.filter(x => x.age >= k);
    // Günlük seriler
    const series = []; for (let i = Math.min(N, 90) - 1; i >= 0; i--) { const d = D(i); series.push({ d, reg: all.filter(u => u.createdAt && dayOf(u.createdAt) === d).length, act: all.filter(u => (u.act || []).includes(d)).length }); }
    // Kaynak tablosu
    const g = new Map(); for (const x of recent) { const r = g.get(x.src.k) || { k: x.src.k, n: 0, list: [] }; r.n++; r.list.push(x); g.set(x.src.k, r); }
    const srcRows = [...g.values()].sort((a, b) => b.n - a.n).map(r => { const e1 = r.list.filter(x => x.age >= 1), e7 = r.list.filter(x => x.age >= 7);
      const det = new Map(); for (const x of r.list) if (x.src.d) det.set(x.src.d, (det.get(x.src.d) || 0) + 1);
      return { k: r.k, n: r.n, msg: pct(r.list, x => x.msg), voice: pct(r.list, x => x.voice), srv: pct(r.list, x => x.srv), back1: pct(e1, x => x.back1), back7: pct(e7, x => x.back7), d3: pct(r.list, x => x.days >= 3),
        lvl: Math.round(r.list.reduce((a, x) => a + level(x.u.xp), 0) / r.list.length * 10) / 10, det: [...det].sort((a, b) => b[1] - a[1]).slice(0, 8) }; });
    // Huni
    const funnel = [['Kayıt oldu', R.length], ['İlk mesajı attı', R.filter(x => x.msg).length], ['Bir sunucuya katıldı', R.filter(x => x.srv).length], ['Sesliye girdi', R.filter(x => x.voice).length],
      ['Ertesi gün geri geldi', elig(1).filter(x => x.back1).length, elig(1).length], ['3 farklı gün geldi', R.filter(x => x.days >= 3).length], ['7 farklı gün geldi', R.filter(x => x.days >= 7).length]];
    // Haftalık kohortlar (son 8 hafta)
    const cohorts = []; for (let w = 7; w >= 0; w--) { const a = now - (w + 1) * 7 * 864e5, b = now - w * 7 * 864e5, c = all.filter(u => u.createdAt >= a && u.createdAt < b).map(info);
      if (!c.length) continue; cohorts.push({ from: a, n: c.length, w: [1, 2, 3, 4].map(k => { const e = c.filter(x => x.age >= k * 7); return e.length ? Math.round(e.filter(x => x.wk(k)).length / e.length * 100) : null; }) }); }
    // Cihaz
    const plat = {}; for (const x of R) { const p0 = x.u.plat1 || (x.u.plat ? Object.entries(x.u.plat).sort((a, b) => b[1] - a[1])[0][0] : 'bilinmiyor'); plat[p0] = (plat[p0] || 0) + 1; }
    // Saat dağılımı (kayıt saati, Türkiye)
    const hours = Array(24).fill(0); for (const x of R) hours[new Date(x.u.createdAt + 3 * 3600e3).getUTCHours()]++;
    const people = [...R].sort((a, b) => b.u.createdAt - a.u.createdAt).slice(0, 150).map(x => ({ name: x.u.name, at: x.u.createdAt, src: x.src.k, det: x.src.d, plat: x.u.plat1 || null, days: x.days, back1: x.age >= 1 ? !!x.back1 : null,
      msgs: x.u.msgs || 0, vmin: x.u.vtot || Object.values(x.u.vmin || {}).reduce((a, b) => a + b, 0), srvs: x.srvs, seen: x.u.seen || null, lvl: level(x.u.xp), on: onlineNames().includes(x.u.name), inv: x.u.invitedBy || null }));
    const dau = all.filter(u => (u.act || []).includes(today)).length, wau = all.filter(u => (u.act || []).some(d => d >= D(6))).length, mau = all.filter(u => (u.act || []).some(d => d >= D(29))).length;
    const prev = all.filter(u => (u.createdAt || 0) >= cut - N * 864e5 && (u.createdAt || 0) < cut).length;
    cb({ ok: true, days: N, src: srcF, total: all.length, kpi: { reg: R.length, regPrev: srcF ? null : prev, dau, wau, mau, online: onlineNames().length,
      back1: pct(elig(1), x => x.back1), back1n: elig(1).length, back7: pct(elig(7), x => x.back7), back7n: elig(7).length, d3: pct(R, x => x.days >= 3), msg: pct(R, x => x.msg), voice: pct(R, x => x.voice) },
      series, srcRows, funnel, cohorts, plat, hours, people, beta: { cap: db.beta.cap || 300, used: Math.min(betaCount(), db.beta.cap || 300), on: !!db.beta.on } });
  });
  socket.on('staffList', (cb = () => {}) => {
    if (!SM(cb)) return;
    cb({ ok: true, me: staffRank(me), ranks: STAFF_RANKS, list: staffList().map(n => ({ name: n, rank: staffRank(n), since: db.staff?.[n]?.at || null, by: db.staff?.[n]?.by || null, online: onlineNames().includes(n),
      acts: (db.staffLog || []).filter(l => l.by === n && l.at > Date.now() - 30 * 864e5).length })).sort((a, b) => Object.keys(STAFF_RANKS).indexOf(a.rank) - Object.keys(STAFF_RANKS).indexOf(b.rank)) });
  });
  socket.on('staffSet', ({ name, rank } = {}, cb = () => {}) => {
    const my = staffRank(me); if (!['owner', 'admin'].includes(my)) return cb({ error: 'Ekibi sadece kurucu ve yöneticiler düzenleyebilir' });
    const u = findUserBy(name); if (!u) return cb({ error: 'Kullanıcı bulunamadı' });
    if (u.name === me) return cb({ error: 'Kendi rütbeni değiştiremezsin' });
    const cur = staffRank(u.name), isMainOwner = db.servers.find(x => x.id === 's1')?.owner === u.name;
    if (isMainOwner || (cur === 'owner' && my !== 'owner')) return cb({ error: 'Kurucunun rütbesi değişmez' });
    if (rank && !['owner', 'admin', 'mod', 'destek'].includes(rank)) return cb({ error: 'Geçersiz rütbe' });
    if (my !== 'owner' && ['owner', 'admin'].includes(rank || cur)) return cb({ error: 'Bu rütbeyi sadece kurucu verebilir ya da alabilir' });
    if (rank && isBanned(u)) return cb({ error: 'Kapatılmış bir hesap ekibe alınamaz' });
    db.staff ||= {}; db.siteAdmins = (db.siteAdmins || []).filter(n => n !== u.name);
    if (rank) db.staff[u.name] = { rank, at: db.staff[u.name]?.at || Date.now(), by: me }; else delete db.staff[u.name];
    staffLog(me, rank ? (cur ? 'Rütbesini değiştirdi' : 'Ekibe aldı') : 'Ekipten çıkardı', u.name, rank ? STAFF_RANKS[rank] : STAFF_RANKS[cur] || '');
    save();
    io.to('user:' + u.name).emit('staffChanged', { rank: rank || null, by: me });
    if (rank) notifyUser(u.name, { from: me, text: `Seni Kanka ekibine ${STAFF_RANKS[rank]} olarak aldı 🛡️ Ayarlar › Yönetim panelinden başlayabilirsin.`, where: 'Kanka ekibi' });
    pushUsers();
    cb({ ok: true });
  });
  socket.on('staffLogGet', (cb = () => {}) => { if (!SM(cb)) return; const all = siteAdmin(me); cb({ ok: true, list: (db.staffLog || []).filter(l => all || l.by === me).slice(0, 200) }); });
  socket.on('warnSeen', (wid, cb = () => {}) => { const u = db.users[me]; if (!u) return cb({}); for (const w of u.siteWarns || []) if (!wid || w.id === wid) w.seen = true; save(); cb({ ok: true }); });

  socket.on('onbSet', (k, cb = () => {}) => {
    const u = db.users[me]; if (!u || !['dismissed', 'done', 'seen'].includes(k)) return cb({ error: 'Geçersiz' });
    onbOf(u)[k] = true; save(); cb({ ok: true, onb: u.onb });
  });
  // Telefon uygulaması bildirim jetonu (Android FCM / iOS APNs). Aynı jeton başka hesaptaysa oradan alınır (telefonda hesap değiştirme).
  socket.on('pushNative', ({ token, platform, sandbox, voip } = {}, cb = () => {}) => {
    if (!me) return cb({ error: 'Giriş yap' }); token = String(token || '').trim();
    if (!/^[\w:.\-]{20,4096}$/.test(token) || !['android', 'ios'].includes(platform)) return cb({ error: 'Geçersiz jeton' });
    if (limited('npush|' + me, 20, 3600e3)) return cb({ error: 'Biraz bekle' });
    for (const u of Object.values(db.users)) if (u.npush?.some(d => d.t === token) && u.name !== me) u.npush = u.npush.filter(d => d.t !== token);
    const u = db.users[me]; u.npush = (u.npush || []).filter(d => d.t !== token);
    u.npush.push({ t: token, p: platform, at: Date.now(), ...(platform === 'ios' && typeof sandbox === 'boolean' ? { sandbox } : {}), ...(platform === 'ios' && voip === true ? { voip: true } : {}) }); u.npush = u.npush.slice(-10);
    socket.data.npTok = token; save(); cb({ ok: true, hazir: platform === 'ios' ? !!npCfg.apns : !!npCfg.fcm });
  });
  socket.on('pushNativeOff', ({ token } = {}, cb = () => {}) => { const u = db.users[me]; if (u?.npush) { u.npush = u.npush.filter(d => d.t !== String(token || '')); save(); } cb({ ok: true }); });
  socket.on('pushNativeTest', (_, cb = () => {}) => { const u = db.users[me]; if (!u?.npush?.length) return cb({ error: 'Bu hesapta kayıtlı telefon yok' }); if (limited('nptest|' + me, 5, 600e3)) return cb({ error: 'Biraz bekle' });
    nativePush(u, { title: 'Kanka Chat', body: 'Bildirimler çalışıyor 🎉', tag: 'test' }).then(() => cb({ ok: true, ...npStats })); });
  // Apple incelemesi için iki demo hesap: arkadaş, ortak test sunucusu, DM ve örnek mesajlarla hazır. Şifreleri sistem üretir, sadece yöneticiye bir kez gösterilir.
  // Var olan hesaplarda şifre yenilenir. İki adımlı doğrulama kapalı tutulur (incelemeci geçemez).
  socket.on('adminReviewAccounts', (_ = {}, cb = () => {}) => {
    if (!SA(cb)) return;
    const pw = () => crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 12) + '7k';
    const names = ['appleinceleme', 'appleinceleme2'], out = [];
    for (const [i, name] of names.entries()) {
      const password = pw(), salt = crypto.randomBytes(16).toString('hex');
      let u = db.users[name];
      if (!u) { u = db.users[name] = { name, email: null, terms: { v: 1, at: Date.now() }, color: COLORS[i % COLORS.length], xp: 0, createdAt: Date.now(), avatar: pickPresetAv(), onb: { rewarded: true }, displayName: i ? 'Apple Test 2' : 'Apple Test', review: true }; uidOf(u); }
      u.salt = salt; u.hash = hashPw(password, salt); u.dob = '1990-01-01'; u.birthday = '01-01'; delete u.ageLock; delete u.tfa; delete u.siteBan;
      u.friends ||= []; u.reqIn ||= []; u.reqOut ||= [];
      out.push({ name, password });
    }
    const [a, b] = names.map(n => db.users[n]);
    if (!a.friends.includes(b.name)) a.friends.push(b.name); if (!b.friends.includes(a.name)) b.friends.push(a.name);
    let sv = db.servers.find(x => x.owner === a.name && x.reviewDemo);
    if (!sv) {
      const t = id(), v = id(), g = id();
      sv = { id: id(), name: 'Apple İnceleme', icon: 'A', owner: a.name, members: [a.name, b.name], joinedAt: { [a.name]: Date.now(), [b.name]: Date.now() }, createdAt: Date.now(), setup: {}, roles: {}, customRoles: [], memberRoles: {}, bans: {}, timeouts: {},
        channels: [{ id: t, name: 'genel', type: 'text' }, { id: g, name: 'oyun', type: 'text' }, { id: v, name: 'Sohbet', type: 'voice' }], template: 'bos', reviewDemo: true };
      migrateCats(sv); db.servers.push(sv);
      const say = (who, ch, text) => { try { postMessage(who, ch, { text }); } catch (e) { console.warn('inceleme mesajı', e.message); } };
      say(a.name, t, 'Merhaba! Bu, Apple incelemesi için hazırlanmış bir test sunucusu 👋', 9e5);
      say(b.name, t, 'Selam! Akşam sesli odaya gelir misin?', 6e5);
      say(a.name, t, 'Olur, 21:00 gibi Sohbet odasındayım 🎧', 3e5);
      say(b.name, g, 'Bu akşam maç var mı?', 2e5);
      const dm = dmId(a.name, b.name);
      say(b.name, dm, 'Selam, bu bir özel mesaj. Buradan arama da yapabilirsin 📞', 4e5);
      say(a.name, dm, 'Harika, birazdan ararım.', 1e5);
    } else for (const n of names) if (!sv.members.includes(n)) sv.members.push(n);
    secLog?.('apple-inceleme', me, 'inceleme hesapları hazırlandı / şifreler yenilendi');
    save(); pushUsers(); pushServers(names.filter(n => onlineNames().includes(n)));
    cb({ ok: true, accounts: out, server: sv.name });
  });
  socket.on('adminMobilPush', ({ fcm, apns, play, clear } = {}, cb = () => {}) => {
    if (!SA(cb)) return; if (staffRank(me) !== 'owner' && !siteAdmin(me)) return cb({ error: 'Yetkin yok' });
    if (clear === 'fcm') delete npCfg.fcm; if (clear === 'apns') delete npCfg.apns;
    if (clear === 'play') { delete npCfg.play; playTok = null; }
    if (play) { let j; try { j = typeof play === 'string' ? JSON.parse(play) : play; } catch { return cb({ error: 'Google Play hizmet hesabı JSON dosyası okunamadı' }); }
      if (j.type !== 'service_account' || !j.client_email || !/BEGIN PRIVATE KEY/.test(j.private_key || '')) return cb({ error: 'Bu bir Google Cloud hizmet hesabı anahtarı değil (client_email, private_key olmalı)' });
      npCfg.play = { client_email: j.client_email, private_key: j.private_key, token_uri: j.token_uri }; playTok = null; npCfg.playRtdnKey ||= crypto.randomBytes(18).toString('base64url'); }
    if (fcm) { let j; try { j = typeof fcm === 'string' ? JSON.parse(fcm) : fcm; } catch { return cb({ error: 'Firebase hizmet hesabı JSON dosyası okunamadı' }); }
      if (j.type !== 'service_account' || !j.project_id || !j.client_email || !/BEGIN PRIVATE KEY/.test(j.private_key || '')) return cb({ error: 'Bu bir Firebase hizmet hesabı anahtarı değil (project_id, client_email, private_key olmalı)' });
      npCfg.fcm = { project_id: j.project_id, client_email: j.client_email, private_key: j.private_key, token_uri: j.token_uri }; fcmTok = null; }
    if (apns) { const a = { keyId: clean(apns.keyId, 20), teamId: clean(apns.teamId, 20), bundle: clean(apns.bundle, 100) || 'com.kanka.chat', prod: apns.prod !== false, key: String(apns.key || npCfg.apns?.key || '').trim() };
      if (!/^[A-Z0-9]{10}$/.test(a.keyId) || !/^[A-Z0-9]{10}$/.test(a.teamId)) return cb({ error: 'Key ID ve Team ID 10 karakter olmalı' });
      if (!/BEGIN PRIVATE KEY/.test(a.key)) return cb({ error: 'APNs anahtarı (.p8 dosyasının içeriği) gerekli' });
      try { crypto.createPrivateKey(a.key); } catch { return cb({ error: '.p8 anahtarı okunamadı' }); }
      npCfg.apns = a; apnsJwt = null; }
    if (fcm || apns || play || clear) { try { fs.writeFileSync(NPUSH_FILE, JSON.stringify(npCfg), { mode: 0o600 }); } catch (e) { return cb({ error: 'Kaydedilemedi: ' + e.message }); } staffLog(me, 'Mobil bildirim ayarlarını değiştirdi', '-'); }
    const cihaz = Object.values(db.users).reduce((a, u) => { for (const d of u.npush || []) a[d.p] = (a[d.p] || 0) + 1; return a; }, {});
    cb({ ok: true, fcm: npCfg.fcm ? { project: npCfg.fcm.project_id, email: npCfg.fcm.client_email } : null, apns: npCfg.apns ? { keyId: npCfg.apns.keyId, teamId: npCfg.apns.teamId, bundle: npCfg.apns.bundle, prod: npCfg.apns.prod } : null, cihaz, stats: npStats,
      play: npCfg.play ? { email: npCfg.play.client_email, rtdn: `${baseUrl()}/play/rtdn?k=${npCfg.playRtdnKey}`, abone: Object.values(db.playSubs || {}).filter(r => PLAY_ON.includes(r.st) && r.exp > Date.now()).length } : null });
  });
  socket.on('logout', token => { sessDel(token); if (socket.data.npTok && db.users[me]?.npush) db.users[me].npush = db.users[me].npush.filter(d => d.t !== socket.data.npTok); save(); });

  // ----- Kanallar -----
  socket.on('join', (chId, cb = () => {}) => {
    if (typeof cb !== 'function') cb = () => {};
    if (!canAccess(me, chId)) return cb({ error: 'Bu odaya erişimin yok' });
    if (cur) socket.leave(cur);
    cur = chId; socket.join(chId); socket.data.cur = chId; socket.data.name = me;
    const s = serverOf(chId); if (s) try { dailyQuestion(s); } catch (e) { console.error('dailyQuestion', e); } // hata olsa da oda açılsın
    const fj = findChannel(chId), noHist = fj && !chPerm(fj.s, fj.c, me, 'history');
    let msgs = noHist ? (db.messages[chId] || []).filter(m => m.pinned || m.author === me).slice(-30) : (db.messages[chId] || []).slice(-150);
    { const oz = ozelFor(chId, me); if (oz.length) { const full = !noHist && (db.messages[chId] || []).length > 150, from = full ? msgs[0]?.time || 0 : 0; msgs = [...msgs, ...oz.filter(m => m.time >= from)].sort((x, y) => x.time - y.time); } }
    cb({ messages: msgs, noHistory: noHist || undefined, playlist: db.playlists[chId] || [], watch: watch.get(chId) || null });
  });

  // ----- Durum -----
  // Durum: { st, until } — until verilirse o anda otomatik "Çevrimiçi"ye döner
  socket.on('setStatus', (arg, cb = () => {}) => {
    const { st, until } = typeof arg === 'string' ? { st: arg } : (arg || {});
    if (!me || !['online', 'idle', 'dnd', 'invisible'].includes(st)) return cb({ error: 'Geçersiz durum' });
    const u = db.users[me], wasInv = u.presence === 'invisible'; u.presence = st;
    if (wasInv !== (st === 'invisible')) pushActivity(u);
    const t = +until; u.presenceUntil = st !== 'online' && t > Date.now() && t < Date.now() + 31 * 864e5 ? t : null;
    save(); pushPresence(); io.to('user:' + me).emit('myStatus', { st, until: u.presenceUntil }); cb({ ok: true, until: u.presenceUntil }); // diğer cihazlar da bilsin (rahatsız etmeyin her yerde geçerli)
  });
  socket.on('setCustomStatus', ({ text, until } = {}, cb = () => {}) => {
    const u = db.users[me]; if (!u) return cb({ error: 'Giriş yap' });
    u.status = clean(text, 60); const t = +until;
    u.statusUntil = u.status && t > Date.now() && t < Date.now() + 31 * 864e5 ? t : null;
    if (u.status) onbFlag(me, 'profile');
    save(); pushUsers(); cb({ ok: true, until: u.statusUntil });
  });
  socket.on('prefs', (p, cb = () => {}) => {
    const u = db.users[me]; if (!u) return cb({});
    if (p && typeof p === 'object') {
      const ch = {}; for (const [k, v] of Object.entries(p.ch || {}).slice(0, 500)) if (typeof k === 'string' && k.length < 80 && ['all', 'none'].includes(v)) ch[k] = v;
      const ids = a => (Array.isArray(a) ? a : []).filter(x => typeof x === 'string' && x.length < 40).slice(0, 200);
      const mu = {}; for (const [k, v] of Object.entries(p.muteUntil || {}).slice(0, 200)) if (typeof k === 'string' && k.length < 40 && +v > Date.now()) mu[k] = +v;
      const srv = {}; for (const [k, v] of Object.entries(p.srv && typeof p.srv === 'object' ? p.srv : (u.prefs?.srv || {})).slice(0, 200)) if (typeof k === 'string' && k.length < 40 && v && typeof v === 'object') {
        const o = {}; if (['all', 'mentions', 'none'].includes(v.lvl) && v.lvl !== 'mentions') o.lvl = v.lvl; if (v.ev) o.ev = 1; if (v.rol) o.rol = 1; if (Object.keys(o).length) srv[k] = o; }
      u.prefs = { notif: p.notif !== false, muted: ids(p.muted), ch, srv, order: p.order ? ids(p.order) : u.prefs?.order || [], muteUntil: mu,
        read: u.prefs?.read || {}, emoji: p.emoji === undefined ? (u.prefs?.emoji || { fav: [], use: {} }) : saneEmojiPrefs(p.emoji), at: Date.now() };
      save();
      for (const [sid, n] of online) if (n === me && sid !== socket.id) io.to(sid).emit('prefs', { notif: u.prefs.notif, muted: u.prefs.muted, ch, srv, order: u.prefs.order, muteUntil: mu, emoji: u.prefs.emoji });
    }
    cb(u.prefs ? { notif: u.prefs.notif, muted: u.prefs.muted, ch: u.prefs.ch, srv: u.prefs.srv || {}, order: u.prefs.order || [], muteUntil: u.prefs.muteUntil || {}, read: u.prefs.read || {}, emoji: u.prefs.emoji || { fav: [], use: {} }, at: u.prefs.at } : null);
  });
  socket.on('read', id => { // okundu bilgisi her cihazda aynı olsun
    const u = db.users[me]; if (!u || typeof id !== 'string' || id.length > 80) return;
    const t = Date.now(); u.prefs ||= {}; u.prefs.read ||= {}; u.prefs.read[id] = t;
    { let ch = false; for (const e of u.inbox || []) if (e.ch === id && !e.r) { e.r = 1; ch = true; } if (ch) io.to('user:' + me).emit('inboxRead', { ch: id, unseen: inboxUnseen(u) }); }
    const keys = Object.keys(u.prefs.read); if (keys.length > 600) for (const k of keys.sort((a, b) => u.prefs.read[a] - u.prefs.read[b]).slice(0, 100)) delete u.prefs.read[k];
    save();
    for (const [sid, n] of online) if (n === me && sid !== socket.id) io.to(sid).emit('readSync', { id, t });
  });
  socket.on('vis', on => { on ? visibleSockets.add(socket.id) : visibleSockets.delete(socket.id); });
  // Bildirimler sekmesi
  socket.on('inbox', (_, cb = () => {}) => { const u = me && db.users[me]; if (!u) return cb({ list: [] });
    cb({ list: (u.inbox || []).map(e => ({ ...e, seen: !!e.r || e.at <= (u.inboxSeen || 0) })), unseen: inboxUnseen(u) }); });
  socket.on('inboxSeen', () => { const u = me && db.users[me]; if (!u) return; u.inboxSeen = Date.now(); save(); io.to('user:' + me).emit('inboxSeen', u.inboxSeen); });
  socket.on('inboxDel', (eid, cb = () => {}) => { const u = me && db.users[me]; if (!u) return cb({}); u.inbox = (u.inbox || []).filter(e => eid === '*' ? false : e.id !== eid); save(); io.to('user:' + me).emit('inboxDel', eid); cb({ ok: true }); });
  socket.on('pushKey', (cb = () => {}) => cb(webpush && vapid ? vapid.publicKey : null));
  socket.on('pushSub', (sub, cb = () => {}) => {
    const u = db.users[me]; if (!u) return cb({ error: 'Giriş yap' });
    if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || sub.endpoint.length > 600 || typeof sub.keys?.p256dh !== 'string' || typeof sub.keys?.auth !== 'string') return cb({ error: 'Geçersiz abonelik' });
    const mob = mobileSockets.has(socket.id) || isMobileUA(socket.handshake.headers['user-agent']);
    const clean = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh.slice(0, 200), auth: sub.keys.auth.slice(0, 100) }, at: Date.now(), mob, dev: mob ? 'mob' : 'pc' };
    u.push = [clean, ...(u.push || []).filter(x => x.endpoint !== clean.endpoint)].slice(0, 6); save(); cb({ ok: true });
  });
  socket.on('pushOff', (endpoint, cb = () => {}) => { const u = db.users[me]; if (!u) return; u.push = (u.push || []).filter(x => x.endpoint !== endpoint); save(); cb({ ok: true }); });
  socket.on('pushTest', (cb = () => {}) => {
    const u = db.users[me]; if (!u?.push?.length || !webpush) return cb({ error: 'Bu cihazda bildirim açık değil' });
    if (limited('ptest|' + me, 10, 600e3)) return cb({ error: 'Çok sık denedin, biraz bekle' });
    const body = JSON.stringify({ title: 'Kanka Chat', body: 'Bildirimler çalışıyor! Kanka kapalıyken de mesajlarını kaçırmayacaksın.', tag: 'test', test: true });
    const subs = [...u.push];
    Promise.all(subs.map(sub => pushOne(u, sub, body, 'test'))).then(r => cb({ ok: r.some(x => x.ok), n: subs.length, sent: r.filter(x => x.ok).length, fail: r.filter(x => !x.ok).map(x => x.status) }));
  });
  socket.on('idle', on => { on ? idleSockets.add(socket.id) : idleSockets.delete(socket.id); pushPresence(); });

  // ----- Eski mesajlar -----
  socket.on('history', ({ before } = {}, cb = () => {}) => {
    if (!canAccess(me, cur)) return cb({ messages: [] });
    { const f = findChannel(cur); if (f && !chPerm(f.s, f.c, me, 'history')) return cb({ messages: [], more: false }); }
    const list = db.messages[cur] || [], i = list.findIndex(m => m.id === before);
    if (i <= 0) return cb({ messages: [], more: false });
    cb({ messages: list.slice(Math.max(0, i - 100), i), more: i > 100 });
  });

  // ----- Grup sohbetleri -----
  const pushDms = names => names.forEach(n => io.to('user:' + n).emit('dms', dmsFor(n)));
  socket.on('createGroup', ({ members, name } = {}, cb = () => {}) => {
    if (!me) return;
    const list = [...new Set((members || []).filter(n => db.users[n] && n !== me))].slice(0, 9);
    if (list.length < 2) return cb({ error: 'Grup için en az 2 kişi seç' });
    if (list.some(n => db.users[n].blocked?.includes(me))) return cb({ error: 'Seçtiğin kişilerden biri seni ekleyemez' });
    if (limited('grp|' + me, 10, 3600e3)) return cb({ error: 'Çok fazla grup açtın, biraz bekle' });
    db.groups ||= {};
    const g = { id: id(), name: clean(name, 40), members: [me, ...list], owner: me, created: Date.now() };
    db.groups[g.id] = g; save();
    const sys = { id: id(), kind: 'system', time: Date.now(), text: `${me} grubu oluşturdu`, reactions: {} };
    (db.messages['g:' + g.id] ||= []).push(sys);
    pushDms(g.members);
    cb({ id: 'g:' + g.id });
  });
  socket.on('groupUpdate', ({ id: gid, name, add, leave } = {}, cb = () => {}) => {
    const g = groupOf(gid); if (!g || !g.members.includes(me)) return cb({ error: 'Grup bulunamadı' });
    const before = [...g.members], notes = [];
    if (name !== undefined) { g.name = clean(name, 40); notes.push(`${me} grubun adını "${g.name || 'adsız'}" yaptı`); }
    if (add?.length) {
      const fresh = add.filter(n => db.users[n] && !g.members.includes(n) && !db.users[n].blocked?.includes(me)).slice(0, 10 - g.members.length);
      if (!fresh.length) return cb({ error: 'Eklenecek kimse yok (en fazla 10 kişi)' });
      g.members.push(...fresh); notes.push(`${me}, ${fresh.join(', ')} kişisini ekledi`);
    }
    if (leave) {
      g.members = g.members.filter(n => n !== me); notes.push(`${me} gruptan ayrıldı`);
      if (g.owner === me) g.owner = g.members[0] || null;
      if (!g.members.length) { delete db.groups[g.id]; delete db.messages[gid]; }
    }
    for (const t of notes) if (db.groups[g.id]) {
      const sys = { id: id(), kind: 'system', time: Date.now(), text: t, reactions: {} };
      (db.messages[gid] ||= []).push(sys); io.to(gid).emit('message', { channelId: gid, msg: sys });
    }
    save(); pushDms([...new Set([...before, ...g.members])]); cb({ ok: true });
  });

  // ----- Özel arama (DM ve grup) -----
  socket.on('ring', ({ chId, video } = {}) => {
    if (!isPrivateChat(chId) || !canAccess(me, chId) || limited('ring|' + me, 6, 60e3)) return;
    { const s = callSessOf(chId); s.rangAt = Date.now(); if (!s.by) s.by = me; }
    for (const n of chatMembers(chId)) if (n !== me && !db.users[n]?.blocked?.includes(me))
    { const title = chId.startsWith('g:') ? groupTitle(groupOf(chId)) : me;
      io.to('user:' + n).emit('ring', { from: me, chatId: chId, callId: 'call:' + chId, video: !!video, title });
      sendPush(n, { title: chId.startsWith('g:') ? `${me} · ${title}` : me, body: video ? '📹 Görüntülü arıyor… Dokun, katıl' : '📞 Sesli arıyor… Dokun, katıl', tag: 'call-' + chId, ch: chId, from: me, dm: true, call: true, video: !!video, callTitle: title }); }
  });
  socket.on('ringCancel', chId => { if (canAccess(me, chId)) for (const n of chatMembers(chId)) if (n !== me) io.to('user:' + n).emit('ringCancel', { chatId: chId }); });
  socket.on('callDecline', chId => { if (canAccess(me, chId)) for (const n of chatMembers(chId)) if (n !== me) io.to('user:' + n).emit('callDecline', { from: me, chatId: chId }); });

  // Profil kartından hızlı DM
  socket.on('quickDM', ({ to, text } = {}, cb = () => {}) => {
    if (!me || !db.users[to] || to === me) return cb({ error: 'Kullanıcı bulunamadı' });
    text = cleanMsg(text); if (!text) return cb({ error: 'Boş mesaj' });
    { const fl = msgFlood(me); if (fl) return cb({ error: fl }); }
    if (db.users[me].blocked?.includes(to)) return cb({ error: 'Bu kişiyi engelledin. Mesaj göndermek için engeli kaldır.' });
    if (db.users[to].blocked?.includes(me)) return cb({ error: 'Bu kişi sana mesaj alımını kapattı.' });
    const r = postMessage(me, dmId(me, to), { kind: 'text', text });
    cb(r.error ? r : { ok: true, id: dmId(me, to) });
  });
  socket.on('openDM', (other, cb) => {
    if (!me || !db.users[other] || other === me) return cb({ error: 'Kullanıcı bulunamadı' });
    cb({ id: dmId(me, other), with: other });
  });

  // ----- Mesaj gönderme -----
  socket.on('message', (p0 = {}, cb = () => {}) => {
    if (!me || !cur || !canAccess(me, cur)) return cb({ error: 'Önce bir odaya gir' });
    if (!p0 || typeof p0 !== 'object' || Array.isArray(p0)) return cb({ error: 'Geçersiz mesaj' });
    if (cur.startsWith('dm:') && dmPeers(cur).includes(BOT_NAME)) return cb({ error: 'Kanka Bot\'a buradan cevap yazılamıyor. Sorun için Kanka HQ\'daki odalara yaz.' });
    let { xfrom, fwd, scheduled, ...p } = p0; // bu alanları sadece sunucu koyar (sahte "iletildi / şuradan" etiketi olmasın)
    if (typeof p.text === 'string' && p.text.length > MSG_MAX) return cb({ error: `Mesaj en fazla ${MSG_MAX} karakter olabilir` });
    if (p.enc) { // uçtan uca şifreli mesaj: içerik sunucuya hiç açık gelmez
      const c = db.e2e?.[cur];
      if (!e2eChat(cur) || !c || !p.enc || !c.eps.some(x => x.id === p.enc.ep) || !b64ok(p.enc.iv, 24) || !b64ok(p.enc.ct, 60000) || !b64ok(p.fc, 64)) return cb({ error: 'Şifreli mesaj geçersiz, sayfayı yenile' });
      p = { kind: 'text', enc: { ep: p.enc.ep, iv: p.enc.iv, ct: p.enc.ct }, fc: p.fc, replyTo: p.replyTo };
    } else if (db.e2e?.[cur]?.eps?.length && e2eChat(cur) && (!p.kind || p.kind === 'text' || ['poll', 'plan', 'song'].includes(p.kind)) && chatMembers(cur).every(n => e2eCur(n))) return cb({ error: 'Bu sohbet uçtan uca şifreli, sayfayı yenileyip tekrar dene', e2e: true });
    { const fl = msgFlood(me); if (fl) return cb({ error: fl }); }
    if (cur.startsWith('dm:')) {
      const other = dmPeers(cur).find(n => n !== me) || me, u = db.users[me], o = db.users[other];
      if (u?.blocked?.includes(other)) return cb({ error: 'Bu kişiyi engelledin. Mesaj göndermek için engeli kaldır.' });
      if (o?.blocked?.includes(me)) return cb({ error: 'Bu kişi sana mesaj alımını kapattı.' });
    }
    const srv = serverOf(cur);
    if (srv?.welcome?.enabled && srv.owner !== me && !srv.accepted?.[me]) return cb({ error: srv.applications?.[me]?.st === 'bekliyor' ? 'Katılım başvurun yetkililerin onayını bekliyor' : 'Önce sunucu kurallarını kabul etmelisin', needRules: srv.id });
    { const sb = srv && secBlock(srv, me); if (sb) return cb({ error: sb, needSec: srv.id }); }
    if (srv && /^\/\S/.test(p.text || '') && (!p.kind || p.kind === 'text') && botCommand(srv, p.text.trim())) return cb({ ok: true, bot: true });
    if (srv && timedOut(srv, me)) return cb({ error: `Susturuldun. ${Math.ceil((srv.timeouts[me] - Date.now()) / 60000)} dakika sonra yazabilirsin.` });
    if (srv && !chPerm(srv, findChannel(cur).c, me, 'send')) return cb({ error: 'Bu odaya yazma iznin yok' });
    const chObj = srv && findChannel(cur).c;
    if (srv && /@(everyone|herkes)\b/i.test(p.text || '') && !chPerm(srv, chObj, me, 'mention')) return cb({ error: '@herkes etiketleme iznin yok' });
    if (srv && (p.image || p.audio || (Array.isArray(p.files) && p.files.length)) && !chPerm(srv, chObj, me, 'attach')) return cb({ error: 'Bu odada dosya ve resim gönderme iznin yok' });
    if (srv && p.gif && !chPerm(srv, chObj, me, 'embed')) return cb({ error: 'Bu odada GIF gönderme iznin yok' });
    if (srv && ['poll', 'plan', 'dice', 'coin', 'xox', 'song'].includes(p.kind) && !chPerm(srv, chObj, me, 'apps')) return cb({ error: 'Bu odada anket, plan ve oyun kullanma iznin yok' });
    if (srv && chObj.type === 'forum' && !p.thread && !clean(p.title, 100)) return cb({ error: 'Gönderi başlığı gerekli' });
    const slowSec = (chObj?.slow || srv?.slow || 0);
    if (srv && slowSec && !isMod(srv, me) && !can(srv, me, 'slowBypass') && !chPerm(srv, chObj, me, 'manage')) {
      const key = cur + '|' + me, last = slowMap.get(key) || 0, wait = slowSec * 1000 - (Date.now() - last);
      if (wait > 0) return cb({ error: `Yavaş mod açık: ${Math.ceil(wait / 1000)} saniye bekle` });
      slowMap.set(key, Date.now());
    }
    if (srv && (!p.kind || p.kind === 'text')) { const am = automod(srv, cur, me, p.text); if (am) return cb({ error: am }); }
    const res = postMessage(me, cur, p); cb(res);
    if (srv && res?.ok !== false && !res?.error && (!p.kind || p.kind === 'text') && !p.replyTo?.bot) hqFaq(srv, cur, me, p.text);
    if (res?.ok !== false && !res?.error && srv?.bot?.added && /@kanka\s?bot\b/i.test(p.text || '')) {
      const ch0 = cur, who = me;
      setTimeout(() => botPost(ch0, { title: `Selam ${who}! 👋`, text: 'Ben Kanka Bot. Komutlarımı görmek için /yardım yaz' + (botOn(srv, 'mod') ? '. Bu sunucuda moderasyon bende 🛡️' : '.'), tone: 'info' }), 700);
    }
  });
  // ----- Mesaj iletme (kaynak odadan hedef odaya içerik kopyalanır) -----
  socket.on('forward', (p = {}, cb = () => {}) => {
    if (!me) return cb({ error: 'Giriş yapmalısın' });
    const { from, msgId, to } = p;
    if (!from || !msgId || !to) return cb({ error: 'Eksik bilgi' });
    if (!canAccess(me, from) || !canAccess(me, to)) return cb({ error: 'Bu odaya erişimin yok' });
    { const fl = msgFlood(me); if (fl) return cb({ error: fl }); }
    const src = findMsg(from, msgId);
    if (!src || src.ephemeral) return cb({ error: 'Mesaj bulunamadı' });
    if (src.enc) return cb({ error: 'Şifreli mesajlar iletilemez' });
    if (!['text', 'bot', 'plan', 'poll', 'song'].includes(src.kind || 'text')) return cb({ error: 'Bu mesaj iletilemez' });
    const text = src.text || (src.kind === 'bot' ? [src.bot?.title, src.bot?.text].filter(Boolean).join('\n')
      : src.kind === 'plan' ? `Plan: ${src.plan.title}${src.plan.when ? ' · ' + src.plan.when : ''}`
      : src.kind === 'poll' ? `Anket: ${src.poll.question}`
      : src.kind === 'song' ? `Şarkı: ${src.song.title}` : '');
    if (!text && !src.image && !src.audio) return cb({ error: 'Bu mesaj iletilemez' });
    if (to.startsWith('dm:')) {
      const other = dmPeers(to).find(n => n !== me) || me, u = db.users[me], o = db.users[other];
      if (u?.blocked?.includes(other)) return cb({ error: 'Bu kişiyi engelledin. İletmek için engeli kaldır.' });
      if (o?.blocked?.includes(me)) return cb({ error: 'Bu kişi sana mesaj alımını kapattı.' });
    }
    const tFind = serverOf(to) ? findChannel(to) : null;
    if (tFind) {
      const { s, c } = tFind;
      if (s.welcome?.enabled && s.owner !== me && !s.accepted?.[me]) return cb({ error: 'Önce sunucu kurallarını kabul etmelisin' });
      if (timedOut(s, me)) return cb({ error: 'Susturuldun, şu an mesaj iletemezsin.' });
      if (!chPerm(s, c, me, 'send')) return cb({ error: 'Bu odaya yazma iznin yok' });
      if ((src.image || src.audio) && !chPerm(s, c, me, 'attach')) return cb({ error: 'Bu odada resim ve ses gönderemezsin' });
      if (c.type === 'forum') return cb({ error: 'Forum gönderileri iletilemez' });
      const slowSec = (c.slow || s.slow || 0);
      if (slowSec && !isMod(s, me) && !can(s, me, 'slowBypass') && !chPerm(s, c, me, 'manage')) {
        const last = slowMap.get(to + '|' + me) || 0, wait = slowSec * 1000 - (Date.now() - last);
        if (wait > 0) return cb({ error: `Yavaş mod açık: ${Math.ceil(wait / 1000)} saniye bekle` });
        slowMap.set(to + '|' + me, Date.now());
      }
      const am = automod(s, to, me, text); if (am) return cb({ error: am });
    }
    const res = postMessage(me, to, { kind: 'text', text, image: src.image, gif: src.gif, audio: src.audio, duration: src.duration, fwd: { author: src.author || (src.kind === 'bot' ? 'Kanka Bot' : null) } });
    cb(res?.error ? res : { ok: true });
  });
  // ----- Kanka Bot komutları (/uyar, /sustur, /temizle, /kilitle ...) -----
  function botCommand(s, text) {
    const [cmd0, ...rest] = text.split(/\s+/); const cmd = cmd0.toLocaleLowerCase('tr');
    const W = o => (botWhisper(socket, cur, o), true);
    const target = () => { const n = (rest[0] || '').replace(/^@/, ''); return membersOf(s).find(x => x.toLocaleLowerCase('tr') === n.toLocaleLowerCase('tr')) || null; };
    const reason = k => clean(rest.slice(k).join(' '), 120);
    const modCmds = ['/uyar', '/uyarılar', '/uyarilar', '/uyarısil', '/uyarisil', '/sustur', '/temizle', '/kilitle', '/kilidiaç', '/kilidiac', '/aç', '/ac'];
    if (cmd === '/yardım' || cmd === '/yardim' || cmd === '/komutlar') {
      let txt = 'Herkes: /zar · /yazitura · /xox · /anket · /plan · /şarkı · /izle' + (s.bot?.ticket?.on ? ' · /destek' : '');
      if (s.bot?.added && s.bot.ticket?.on) txt += '\n\nDestek:\n/destek konu · talebini aç\n/üstlen · açık talebi üstlen (yetkili)\n/kapat · talebi kapat';
      if (can(s, me, 'timeout') || can(s, me, 'manageMessages') || can(s, me, 'manageChannels')) txt += '\n\nYetkililer:\n/uyar @isim sebep · uyarı ver\n/uyarılar @isim · uyarıları gör\n/uyarısil @isim · uyarıları sıfırla\n/sustur @isim 10 sebep · dakika olarak sustur\n/temizle 20 · son mesajları sil (en çok 100)\n/kilitle · odayı yazmaya kapat\n/kilidiaç · odayı yeniden aç' + (botOn(s, 'mod') ? '' : '\n\nOtomatik moderasyon (davet linki, spam, küfür filtresi) için: Sunucu ayarları → Kanka Bot → Mod modülü.');
      return W({ title: 'Kanka Bot komutları', tone: 'info', text: txt });
    }
    const ticketCmds = ['/destek', '/talep', '/ticket', '/üstlen', '/ustlen', '/kapat'];
    if (ticketCmds.includes(cmd)) {
      if (!s.bot?.added) return W({ title: 'Kanka Bot bu sunucuda yok', tone: 'warn', text: 'Bu komut için önce Kanka Bot\'u ekle: Sunucu ayarları → Kanka Bot → Botu ekle.' });
      if (!s.bot.ticket?.on) return W({ title: 'Destek modülü kapalı', tone: 'warn', text: 'Sunucu ayarları → Kanka Bot → Destek modülünü aç.' });
      if (cmd === '/destek' || cmd === '/talep' || cmd === '/ticket') {
        const r = openTicket(s, me, rest.join(' '));
        if (r.error) return W({ title: 'Talep açılamadı', tone: 'warn', text: r.error });
        return W({ title: 'Destek talebin açıldı', tone: 'ok', text: `#${r.name} odasına geçebilirsin. Yetkililer en kısa sürede ilgilenecek.` });
      }
      const tc = s.channels.find(x => x.id === cur);
      if (!tc?.ticket) return W({ title: 'Burada olmaz', tone: 'warn', text: 'Bu komut yalnızca bir destek odasında çalışır.' });
      const r = cmd === '/kapat' ? closeTicket(s, tc, me) : claimTicket(s, tc, me);
      if (r.error) return W({ title: 'Olmadı', tone: 'warn', text: r.error });
      return W({ title: cmd === '/kapat' ? 'Talep kapatıldı' : 'Talep üstlenildi', tone: 'ok', text: cmd === '/kapat' ? 'Yazışma arşive taşındı.' : 'Artık bu taleple sen ilgileniyorsun.' });
    }
    if (!modCmds.includes(cmd)) return false;
    // Bu komutlar yetkilinin zaten sahip olduğu yetkilerin kısayolu: Kanka Bot ekli / mod modülü açık olmasa da çalışır (her komut kendi yetkisini kontrol eder)
    const c = s.channels.find(x => x.id === cur);
    if (cmd === '/uyar') {
      if (!can(s, me, 'timeout')) return W({ title: 'Yetkin yok', tone: 'warn', text: 'Uyarı vermek için susturma yetkin olmalı.' });
      const n = target(); if (!n || n === me || !outranks(s, me, n)) return W({ title: 'Kullanım', tone: 'warn', text: '/uyar @isim sebep' });
      s.warns ||= {}; const arr = (s.warns[n] ||= []); arr.push({ by: me, time: Date.now(), reason: reason(1) });
      const lim = s.bot?.mod?.warnLimit || 3;
      audit(s, me, 'Uyardı', `${n} (${arr.length}/${lim})${reason(1) ? ' · ' + reason(1) : ''}`);
      if (arr.length >= lim && s.bot?.added && !botOutranks(s, n)) {
        botPost(cur, { title: `${n} uyarıldı (${arr.length}/${lim})`, text: 'Uyarı sınırına ulaştı ama Kanka Bot\'un rolü bu kişininkinden düşük olduğu için otomatik susturamadı. Rol sırasını Sunucu ayarları → Roller\'den değiştirebilirsin.', tone: 'warn', fields: [['Yetkili', me]] });
      } else if (arr.length >= lim) {
        s.timeouts ||= {}; s.timeouts[n] = Date.now() + 60 * 60e3; s.warns[n] = [];
        botPost(cur, { title: `${n} susturuldu`, text: `${lim} uyarıya ulaştığı için 1 saat susturuldu.`, tone: 'danger', fields: [['Son uyarı', reason(1) || 'Sebep belirtilmedi'], ['Yetkili', me]] });
        io.to('user:' + n).emit('toast', `${s.name} sunucusunda ${lim} uyarıya ulaştığın için 1 saat susturuldun`);
      } else {
        botPost(cur, { title: `${n} uyarıldı (${arr.length}/${lim})`, text: reason(1) || 'Sebep belirtilmedi', tone: 'warn', fields: [['Yetkili', me]] });
        io.to('user:' + n).emit('toast', `${s.name} sunucusunda uyarı aldın (${arr.length}/${lim})${reason(1) ? ': ' + reason(1) : ''}`);
      }
      save(); pushSrv(s); return true;
    }
    if (cmd === '/uyarılar' || cmd === '/uyarilar') {
      if (!can(s, me, 'timeout')) return W({ title: 'Yetkin yok', tone: 'warn', text: 'Uyarıları görmek için susturma yetkin olmalı.' });
      const n = target(); if (!n) return W({ title: 'Kullanım', tone: 'warn', text: '/uyarılar @isim' });
      const arr = s.warns?.[n] || [];
      return W({ title: `${n}: ${arr.length} uyarı`, tone: 'info', text: arr.length ? arr.map((w, i) => `${i + 1}. ${w.reason || 'Sebep yok'} · ${w.by} · ${new Date(w.time).toLocaleDateString('tr-TR')}`).join('\n') : 'Hiç uyarısı yok.' });
    }
    if (cmd === '/uyarısil' || cmd === '/uyarisil') {
      if (!can(s, me, 'timeout')) return W({ title: 'Yetkin yok', tone: 'warn', text: 'Bunun için susturma yetkin olmalı.' });
      const n = target(); if (!n) return W({ title: 'Kullanım', tone: 'warn', text: '/uyarısil @isim' });
      if (s.warns) delete s.warns[n]; audit(s, me, 'Uyarılarını sildi', n); save(); return W({ title: 'Uyarılar silindi', tone: 'ok', text: `${n} adlı üyenin uyarıları sıfırlandı.` });
    }
    if (cmd === '/sustur') {
      if (!can(s, me, 'timeout')) return W({ title: 'Yetkin yok', tone: 'warn', text: 'Susturma yetkin yok.' });
      const n = target(), mn = Math.min(Math.max(parseInt(rest[1]) || 10, 1), 10080);
      if (!n || n === me || !outranks(s, me, n)) return W({ title: 'Kullanım', tone: 'warn', text: '/sustur @isim 10 sebep (dakika)' });
      s.timeouts ||= {}; s.timeouts[n] = Date.now() + mn * 60e3;
      audit(s, me, 'Susturdu', `${n} · ${dur(mn)}${reason(2) ? ' · ' + reason(2) : ''}`);
      botPost(cur, { title: `${n} susturuldu`, text: `${dur(mn)} boyunca yazamaz ve sesli odalara giremez.`, tone: 'warn', fields: [['Sebep', reason(2) || 'Belirtilmedi'], ['Yetkili', me]] });
      io.to('user:' + n).emit('toast', `${s.name} sunucusunda ${dur(mn)} susturuldun`);
      pushSrv(s); return true;
    }
    if (cmd === '/temizle') {
      if (!can(s, me, 'manageMessages') && !chPerm(s, c, me, 'manage')) return W({ title: 'Yetkin yok', tone: 'warn', text: 'Mesaj silmek için mesaj yönetme yetkin olmalı.' });
      const k = Math.min(Math.max(parseInt(rest[0]) || 0, 1), 100); if (!parseInt(rest[0])) return W({ title: 'Kullanım', tone: 'warn', text: '/temizle 20 (en çok 100)' });
      const list = db.messages[cur] || [], gone = list.splice(Math.max(0, list.length - k), k);
      for (const m of gone) io.to(cur).emit('remove', { channelId: cur, msgId: m.id });
      unActivity(cur, gone);
      if (db.playlists[cur]) { const ids = new Set(gone.map(m => m.id)); db.playlists[cur] = db.playlists[cur].filter(x => !ids.has(x.id)); io.to(cur).emit('playlist', { channelId: cur, playlist: db.playlists[cur] }); }
      audit(s, me, 'Mesajları temizledi', `#${c?.name} · ${gone.length} mesaj`); save();
      return W({ title: 'Temizlendi', tone: 'ok', text: `${gone.length} mesaj silindi.` });
    }
    if (cmd === '/kilitle' || cmd === '/kilidiaç' || cmd === '/kilidiac' || cmd === '/aç' || cmd === '/ac') {
      if (!can(s, me, 'manageChannels')) return W({ title: 'Yetkin yok', tone: 'warn', text: 'Oda kilitlemek için oda yönetme yetkin olmalı.' });
      if (!c) return W({ title: 'Burada olmaz', tone: 'warn', text: 'Bu komut sunucu odalarında çalışır.' });
      const lock = cmd === '/kilitle';
      if (lock) {
        if (c.lock) return W({ title: 'Zaten kilitli', tone: 'info', text: 'Açmak için /kilidiaç yaz.' });
        const k = catOf(s, c); c.lock = { sync: !!c.sync, prev: (c.sync && k ? k.perms : c.perms)?.['@everyone']?.send };
        if (c.sync && k) { c.perms = JSON.parse(JSON.stringify(k.perms || {})); c.sync = false; }
        c.perms ||= {}; c.perms['@everyone'] = { ...(c.perms['@everyone'] || {}), send: false };
        audit(s, me, 'Odayı kilitledi', '#' + c.name);
        botPost(cur, { title: '🔒 Oda kilitlendi', text: 'Yetkililer açana kadar bu odaya sadece yetkililer yazabilir.', tone: 'warn' });
      } else {
        if (!c.lock) return W({ title: 'Oda kilitli değil', tone: 'info', text: 'Kilitlemek için /kilitle yaz.' });
        c.perms ||= {}; const e = { ...(c.perms['@everyone'] || {}) };
        if (c.lock.prev === undefined) delete e.send; else e.send = c.lock.prev;
        if (Object.keys(e).length) c.perms['@everyone'] = e; else delete c.perms['@everyone'];
        if (c.lock.sync) c.sync = true; delete c.lock;
        audit(s, me, 'Odanın kilidini açtı', '#' + c.name);
        botPost(cur, { title: '🔓 Oda açıldı', text: 'Herkes yeniden yazabilir.', tone: 'ok' });
      }
      pushSrv(s); return true;
    }
    return false;
  }
  socket.on('botAdd', ({ serverId, mod = true } = {}, cb = () => {}) => {
    const s = permServer(serverId, 'manageServer'); if (!s) return cb({ error: 'Bot eklemek için sunucuyu yönetme yetkin olmalı' });
    if (s.public && !(s.id === 's1' && siteAdmin(me))) return cb({ error: 'Bu sunucuya bot eklenemez' });
    botAddTo(s, me, !!mod); pushSrv(s); cb({ ok: true });
  });
  socket.on('botWelcomeTest', ({ serverId } = {}, cb = () => {}) => {
    const s = permServer(serverId, 'manageServer'); if (!s) return cb({ error: 'Yetkin yok' });
    if (!botOn(s, 'welcome')) return cb({ error: 'Önce Karşılama modülünü aç' });
    if (limited('wtest|' + me, 5, 60e3)) return cb({ error: 'Biraz bekle' });
    const w = s.bot.welcome, ch = welcomeChannel(s, w); if (!ch) return cb({ error: 'Karşılama odası yok' });
    const count = s.public ? userCount() : s.members.length;
    botPost(ch.id, { title: '🧪 Deneme · ' + WELCOME_TITLES[count % WELCOME_TITLES.length], text: welcomeFill(s, w.text, me, count), tone: 'ok', fields: w.count ? [['Üye', `${ordinalTr(count)} kanka`]] : [] });
    cb({ ok: true, ch: ch.name });
  });
  socket.on('botRemove', ({ serverId } = {}, cb = () => {}) => {
    const s = permServer(serverId, 'manageServer'); if (!s) return cb({ error: 'Yetkin yok' });
    const b = botCfg(s); if (!b.added) return cb({ ok: true });
    b.added = false; for (const k of Object.keys(BOT_MODS)) b[k].on = false;
    const r = botRole(s); if (r) s.customRoles = s.customRoles.filter(x => x !== r);
    if (s.memberRoles) delete s.memberRoles[BOT_NAME];
    audit(s, me, 'Kanka Bot\'u sunucudan attı');
    pushSrv(s); cb({ ok: true });
  });
  socket.on('botSave', ({ serverId, module, cfg } = {}, cb = () => {}) => {
    const s = permServer(serverId, 'manageServer'); if (!s) return cb({ error: 'Kanka Bot ayarları için sunucuyu yönetme yetkin olmalı' });
    const def = BOT_MODS[module]; if (!def || !cfg || typeof cfg !== 'object') return cb({ error: 'Geçersiz modül' });
    const b = botCfg(s), was = b[module].on;
    if (!b.added && cfg.on) return cb({ error: 'Önce Kanka Bot\'u sunucuya ekle' });
    for (const k of Object.keys(def)) if (k in cfg) {
      const v = cfg[k];
      if (typeof def[k] === 'boolean') b[module][k] = !!v;
      else if (k === 'warnLimit') b[module][k] = Math.min(Math.max(parseInt(v) || 3, 2), 10);
      else if (k === 'logCh') b[module][k] = s.channels.some(c => c.id === v && (c.type || 'text') === 'text') ? v : null;
      else if (k === 'words') b[module][k] = clean(v, 500);
      else if (k === 'ch' || k === 'panelCh') b[module][k] = s.channels.some(c => c.id === v && (c.type || 'text') === 'text') ? v : null;
      else if (k === 'text' || k === 'byeText' || k === 'panelText' || k === 'welcome') b[module][k] = clean(v, 400);
      else if (k === 'role') { const r = (s.customRoles || []).find(x => x.id === v && !x.bot); b[module][k] = r ? r.id : null; }
      else if (k === 'cooldownMin') b[module][k] = Math.min(Math.max(parseInt(v) || 0, 0), 1440);
      else if (k === 'roles') { const ok = (Array.isArray(v) ? v : []).filter(x => (s.customRoles || []).some(r => r.id === x && !r.bot)); const bad = ok.filter(x => s.customRoles.find(r => r.id === x).perms?.length); if (bad.length) return cb({ error: 'Yetkisi olan roller otomatik verilemez' }); b[module][k] = [...new Set(ok)].slice(0, 5); }
      else if (k === 'when') b[module][k] = ['join', 'rules', 'delay'].includes(v) ? v : 'join';
      else if (k === 'delayMin') b[module][k] = Math.min(Math.max(parseInt(v) || 10, 1), 1440);
      else if (k === 'pending') {}
    }
    if (was !== b[module].on) audit(s, me, b[module].on ? 'Kanka Bot modülünü açtı' : 'Kanka Bot modülünü kapattı', { mod: 'Mod', welcome: 'Karşılama', ticket: 'Destek', autorole: 'Oto-rol' }[module] || module);
    else audit(s, me, 'Kanka Bot ayarlarını değiştirdi', { mod: 'Mod', welcome: 'Karşılama', ticket: 'Destek', autorole: 'Oto-rol' }[module] || module);
    pushSrv(s); cb({ ok: true });
  });
  socket.on('autoRoleAll', ({ serverId } = {}, cb = () => {}) => {
    const s = permServer(serverId, 'manageRoles'); if (!s || s.public) return cb({ error: 'Rolleri yönetme yetkin yok' });
    if (!botOn(s, 'autorole') || !autoRoleList(s).length) return cb({ error: 'Önce oto-rolü açıp rol seç' });
    if (limited('arAll|' + s.id, 2, 60e3)) return cb({ error: 'Biraz bekle' });
    let n = 0; for (const m of s.members) if (m !== s.owner && m !== BOT_NAME && autoRoleGive(s, m, { log: false, push: false }).length) n++;
    audit(s, me, 'Oto-rolü mevcut üyelere uyguladı', n + ' üye'); save(); pushServers(membersOf(s)); cb({ ok: true, n });
  });
  socket.on('ticketOpen', ({ serverId, reason } = {}, cb = () => {}) => {
    if (!me) return cb({ error: 'Giriş yapmalısın' });
    const s = db.servers.find(x => x.id === serverId); if (!s) return cb({ error: 'Sunucu bulunamadı' });
    const wait = limited('ticket|' + me, 3, 60e3); if (wait) return cb({ error: `Çok hızlı talep açıyorsun, ${wait} saniye bekle` });
    cb(openTicket(s, me, reason));
  });
  socket.on('ticketClaim', ({ channelId } = {}, cb = () => {}) => {
    const f = me && findChannel(channelId); if (!f) return cb({ error: 'Talep bulunamadı' });
    if (!canAccess(me, channelId)) return cb({ error: 'Bu odaya erişimin yok' });
    cb(claimTicket(f.s, f.c, me));
  });
  socket.on('ticketClose', ({ channelId } = {}, cb = () => {}) => {
    const f = me && findChannel(channelId); if (!f) return cb({ error: 'Talep bulunamadı' });
    if (!canAccess(me, channelId)) return cb({ error: 'Bu odaya erişimin yok' });
    cb(closeTicket(f.s, f.c, me));
  });
  socket.on('ticketPanel', ({ serverId, chId } = {}, cb = () => {}) => {
    const s = permServer(serverId, 'manageServer'); if (!s) return cb({ error: 'Yetkin yok' });
    const t = botCfg(s).ticket;
    if (!s.bot?.added || !t.on) return cb({ error: 'Önce Destek modülünü aç' });
    const c = s.channels.find(x => x.id === chId && (x.type || 'text') === 'text' && !x.news);
    if (!c) return cb({ error: 'Geçerli bir yazılı oda seç' });
    const msg = { id: id(), author: BOT_NAME, kind: 'bot', time: Date.now(), ticketPanel: true, bot: { title: 'Destek', text: t.panelText || 'Bir sorunun mu var? Talebini aç, yetkililer ilgilenecek.', tone: 'info', fields: [] }, reactions: {} };
    const list = (db.messages[c.id] ||= []); list.push(msg); if (list.length > 2000) list.shift();
    t.panelCh = c.id;
    audit(s, me, 'Destek panelini gönderdi', '#' + c.name);
    save(); io.to(c.id).emit('message', { channelId: c.id, msg }); pushServers(membersOf(s));
    cb({ ok: true, channelId: c.id });
  });

  socket.on('upload', ({ data } = {}, cb) => {
    if (!me) return cb({ error: 'Giriş yapmalısın' });
    if (limited('up|' + me, 15, 60e3)) return cb({ error: 'Çok fazla dosya yükledin, bir dakika bekle' });
    let m = /^data:image\/(png|jpeg|gif|webp);base64,(.+)$/.exec(String(data || ''));
    if (!m) {
      const a = /^data:audio\/(webm|ogg|mp4|x-m4a)(?:;[^,]*)?;base64,(.+)$/.exec(String(data || ''));
      if (a) m = [a[0], { webm: 'webm', ogg: 'ogg', mp4: 'm4a', 'x-m4a': 'm4a' }[a[1]], a[2]];
    }
    if (!m) return cb({ error: 'Sadece resim ya da ses yükleyebilirsin' });
    let buf = Buffer.from(m[2], 'base64');
    if (buf.length > 5 * 1024 * 1024) return cb({ error: 'Resim en fazla 5 MB olabilir' });
    { // içerik gerçekten söylediği tür mü? (resim diye HTML/SVG yüklenmesin)
      const h = buf.subarray(0, 12).toString('hex'), ok = { png: h.startsWith('89504e47'), jpeg: h.startsWith('ffd8ff'), gif: h.startsWith('47494638'), webp: h.startsWith('52494646') && buf.subarray(8, 12).toString() === 'WEBP',
        webm: h.startsWith('1a45dfa3'), ogg: h.startsWith('4f676753'), m4a: buf.subarray(4, 8).toString() === 'ftyp' }[m[1]];
      if (!ok) return cb({ error: 'Dosya bozuk ya da türü yanlış' });
      const u = db.users[me], day = new Date().toISOString().slice(0, 10); if (u.upDay?.d !== day) u.upDay = { d: day, b: 0 };
      if (u.upDay.b + buf.length > FILE_DAY) return cb({ error: 'Bugünkü yükleme sınırına ulaştın (300 MB). Yarın tekrar dene.' });
      u.upDay.b += buf.length;
    }
    if (m[1] === 'gif') buf = gifLoopForever(buf); // bazı GIF'ler birkaç kez oynayıp durur: hep dönsün
    const file = crypto.randomBytes(12).toString('hex') + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
    fs.writeFile(path.join(UPLOADS, file), buf, err => cb(err ? { error: 'Kaydedilemedi' } : { url: '/uploads/' + file }));
  });

  // ----- Mesaj işlemleri -----
  const update = (chId, msg) => { save(); io.to(chId).emit('update', { channelId: chId, msg }); };

  socket.on('react', ({ msgId, emoji } = {}) => {
    if (!canAccess(me, cur)) return;
    if (limited('etk|' + me, 25, 10e3)) return socket.emit('toast', 'Çok hızlı, biraz yavaşla');
    const msg = findMsg(cur, msgId); if (!msg) return;
    const f = findChannel(cur); if (f && timedOut(f.s, me)) return socket.emit('toast', 'Susturulmuşken tepki veremezsin');
    const cm = /^:([a-z0-9_]{2,24}):$/.exec(typeof emoji === 'string' ? emoji : '');
    if (cm) {
      if (!f || !f.s?.emojis?.[cm[1]]) return; // başka sunucunun/silinmiş emojisiyle tepki verilmez
      emoji = ':' + cm[1] + ':';
    } else emoji = clean(emoji, 16);
    if (!emoji) return;
    { if (f && !msg.reactions?.[emoji] && !chPerm(f.s, f.c, me, 'react')) return socket.emit('toast', 'Bu odada tepki ekleme iznin yok'); }
    msg.reactions ||= {};
    const arr = (msg.reactions[emoji] ||= []);
    const i = arr.indexOf(me);
    i >= 0 ? arr.splice(i, 1) : arr.push(me);
    if (!arr.length) delete msg.reactions[emoji];
    update(cur, msg); botReact(cur, msg, emoji, me, i < 0);
    if (i < 0 && !cm) { STAT.me(me, 'em:' + emoji); const sv = serverOf(cur); if (sv && !sv.public) STAT.add('#' + sv.id, 'em:' + emoji); }
  });

  socket.on('edit', ({ msgId, text, enc, fc } = {}) => {
    if (!canAccess(me, cur)) return;
    { const f = findChannel(cur); if (f && timedOut(f.s, me)) return socket.emit('toast', 'Susturulmuşken mesaj düzenleyemezsin'); }
    if (enc) { const msg = findMsg(cur, msgId), c = db.e2e?.[cur]; // şifreli düzenleme
      if (!msg || msg.author !== me || !msg.enc || !c?.eps.some(x => x.id === enc.ep) || !b64ok(enc.iv, 24) || !b64ok(enc.ct, 60000) || !b64ok(fc, 64)) return;
      msg.enc = { ep: enc.ep, iv: enc.iv, ct: enc.ct }; msg.fc = fc; msg.edited = true; return update(cur, msg); }
    const msg = findMsg(cur, msgId); text = cleanMsg(text);
    if (!msg || msg.author !== me || msg.kind !== 'text' || !text || msg.enc) return;
    msg.text = text; msg.edited = true;
    update(cur, msg);
  });

  socket.on('delete', msgId => {
    if (!canAccess(me, cur)) return;
    const list = db.messages[cur] || [];
    const i = list.findIndex(m => m.id === msgId);
    if (i < 0) return;
    const f = findChannel(cur);
    if (list[i].author !== me && !(f && (isMod(f.s, me) || chPerm(f.s, f.c, me, 'manage')))) return;
    if (list[i].author !== me && f) audit(f.s, me, 'Mesaj sildi', `${list[i].author}: ${(list[i].text || '').slice(0, 60)}`);
    const gm = list.splice(i, 1);
    if (db.playlists[cur]) {
      db.playlists[cur] = db.playlists[cur].filter(s => s.id !== msgId);
      io.to(cur).emit('playlist', { channelId: cur, playlist: db.playlists[cur] });
    }
    save();
    io.to(cur).emit('remove', { channelId: cur, msgId }); unActivity(cur, gm);
  });

  socket.on('planToggle', msgId => {
    if (!canAccess(me, cur)) return;
    if (limited('etk|' + me, 25, 10e3)) return socket.emit('toast', 'Çok hızlı, biraz yavaşla');
    { const f = isPrivateChat(cur) ? null : findChannel(cur); if (f && timedOut(f.s, me)) return socket.emit('toast', 'Susturulmuşken kullanamazsın'); }
    const msg = findMsg(cur, msgId);
    if (!msg || msg.kind !== 'plan') return;
    const g = msg.plan.going, i = g.indexOf(me);
    i >= 0 ? g.splice(i, 1) : g.push(me);
    update(cur, msg);
  });

  socket.on('vote', ({ msgId, index } = {}) => {
    if (!canAccess(me, cur)) return;
    if (limited('etk|' + me, 25, 10e3)) return socket.emit('toast', 'Çok hızlı, biraz yavaşla');
    { const f = isPrivateChat(cur) ? null : findChannel(cur); if (f && timedOut(f.s, me)) return socket.emit('toast', 'Susturulmuşken kullanamazsın'); }
    const msg = findMsg(cur, msgId);
    if (!msg || msg.kind !== 'poll' || !msg.poll.options[index]) return;
    const already = msg.poll.options[index].votes.includes(me);
    for (const o of msg.poll.options) o.votes = o.votes.filter(v => v !== me);
    if (!already) msg.poll.options[index].votes.push(me);
    update(cur, msg);
  });

  socket.on('xoxMove', ({ msgId, i } = {}) => {
    if (!canAccess(me, cur)) return;
    if (limited('etk|' + me, 25, 10e3)) return socket.emit('toast', 'Çok hızlı, biraz yavaşla');
    { const f = isPrivateChat(cur) ? null : findChannel(cur); if (f && (timedOut(f.s, me) || !chPerm(f.s, f.c, me, 'send'))) return socket.emit('toast', 'Bu odada oynama iznin yok'); }
    const msg = findMsg(cur, msgId);
    if (!msg || msg.kind !== 'xox') return;
    const g = msg.game; i = +i;
    if (g.winner || !(i >= 0 && i < 9) || g.board[i] !== '.') return;
    if (g.turn === 'x' && me !== g.x) return;
    if (g.turn === 'o') { if (!g.o && me !== g.x) g.o = me; if (me !== g.o) return; }
    g.board = g.board.slice(0, i) + g.turn + g.board.slice(i + 1);
    g.winner = winnerOf(g.board);
    if (g.winner === 'x' || g.winner === 'o') { const w = db.users[g.winner === 'x' ? g.x : g.o]; if (w) w.xoxWins = (w.xoxWins || 0) + 1; pushUsers(); }
    g.turn = g.turn === 'x' ? 'o' : 'x';
    update(cur, msg);
  });

  socket.on('pin', msgId => {
    if (!canAccess(me, cur)) return;
    const f = findChannel(cur);
    if (f && !isMod(f.s, me) && !can(f.s, me, 'pinMessages') && !chPerm(f.s, f.c, me, 'manage')) return socket.emit('toast', 'Bu odada mesaj sabitleme iznin yok');
    const msg = findMsg(cur, msgId);
    if (!msg) return;
    msg.pinned = !msg.pinned;
    update(cur, msg);
  });

  // Odada paylaşılan medya / bağlantı / dosyalar (en yeniden eskiye, aramalı, sayfalı)
  socket.on('chanMedia', ({ chId, tab = 'media', q = '', before = null } = {}, cb = () => {}) => {
    if (!me || typeof chId !== 'string' || !canAccess(me, chId)) return cb({ error: 'Bu odaya erişimin yok' });
    if (limited('cmedia|' + me, 60, 60e3)) return cb({ error: 'Biraz yavaş' });
    const f = findChannel(chId), noHist = f && !chPerm(f.s, f.c, me, 'history');
    const ql = clean(q, 100).toLocaleLowerCase('tr'), has = (...xs) => !ql || xs.some(x => x && String(x).toLocaleLowerCase('tr').includes(ql));
    const list = db.messages[chId] || []; let i = list.length - 1;
    if (before) { const k = list.findIndex(m => m.id === before); if (k >= 0) i = k - 1; }
    const out = []; let last = null;
    for (; i >= 0 && out.length < 60; i--) {
      const m = list[i]; if (!m || m.enc || m.ephemeral || (noHist && m.author !== me && !m.pinned)) continue;
      const base = { id: m.id, author: m.author || null, time: m.time };
      if (tab === 'media') {
        if (m.image && has(m.author, m.text, 'resim')) out.push({ ...base, type: 'image', url: m.image });
        if (m.gif?.url && has(m.author, m.text, m.gif.title, 'gif')) out.push({ ...base, type: 'gif', url: m.gif.url, thumb: m.gif.prev || m.gif.url, title: m.gif.title || '' });
        for (const x of m.files || []) if ((x.kind === 'image' || x.kind === 'video') && has(m.author, m.text, x.name)) out.push({ ...base, type: x.kind, url: x.url, name: x.name, size: x.size });
      } else if (tab === 'files') {
        for (const x of m.files || []) if (x.kind !== 'image' && x.kind !== 'video' && has(m.author, m.text, x.name)) out.push({ ...base, type: x.kind, url: x.url, name: x.name, size: x.size });
      } else {
        const urls = [...new Set((String(m.text || '').match(/https?:\/\/[^\s<>"']+/gi) || []).map(u => u.replace(/[).,!?;:]+$/, '')))];
        for (const u of urls.slice(0, 5)) { const pv = m.preview && (m.preview.url === u || urls.length === 1) ? m.preview : null;
          if (has(u, m.author, pv?.title, pv?.site) || (urls.length === 1 && has(m.text))) out.push({ ...base, type: 'link', url: u, title: pv?.title || '', site: pv?.site || '', desc: pv?.desc || '', img: pv?.image || null, text: String(m.text || '').slice(0, 200) }); }
      }
      last = m.id;
    }
    cb({ items: out, more: i >= 0, cursor: last, e2e: !!(e2eChat(chId) && db.e2e?.[chId]?.eps?.length) });
  });
  socket.on('search', (q, cb) => {
    if (!canAccess(me, cur)) return cb([]);
    q = clean(q, 100).toLocaleLowerCase('tr');
    if (!q) return cb([]);
    const fs_ = findChannel(cur), noHist = fs_ && !chPerm(fs_.s, fs_.c, me, 'history'); // geçmişi okuma izni yoksa aramada da çıkmasın
    cb((db.messages[cur] || []).filter(m => !m.ephemeral && (!noHist || m.author === me || m.pinned)).filter(m => [m.text, m.author, m.plan?.title, m.poll?.question, m.song?.title].some(t => t && t.toLocaleLowerCase('tr').includes(q))).slice(-50).reverse());
  });

  // ----- Birlikte izle -----
  socket.on('watchSet', url => {
    if (!canAccess(me, cur)) return;
    if (!isPrivateChat(cur)) return socket.emit('toast', 'Birlikte izleme sadece özel mesajlarda ve gruplarda var');
    { const f = findChannel(cur); if (f && !chPerm(f.s, f.c, me, 'apps')) return socket.emit('toast', 'Bu odada birlikte izleme başlatma iznin yok'); }
    const m = /(?:youtu\.be\/|v=|shorts\/|embed\/)([\w-]{11})/.exec(String(url || '')) || /^([\w-]{11})$/.exec(String(url || '').trim());
    if (!m) return socket.emit('toast', 'Geçerli bir YouTube linki değil');
    const st = { videoId: m[1], playing: true, time: 0, at: Date.now(), by: me };
    watch.set(cur, st);
    io.to(cur).emit('watch', { channelId: cur, state: st });
  });
  socket.on('watchCtl', ({ playing, time } = {}) => {
    const st = watch.get(cur);
    if (!st || !canAccess(me, cur)) return;
    Object.assign(st, { playing: !!playing, time: Math.max(0, +time || 0), at: Date.now(), by: me });
    socket.to(cur).emit('watch', { channelId: cur, state: st });
  });
  socket.on('watchStop', () => {
    if (!canAccess(me, cur)) return;
    watch.delete(cur);
    io.to(cur).emit('watch', { channelId: cur, state: null });
  });

  // ----- Profil -----
  socket.on('updateProfile', ({ avatar, status, bio, banner, color, birthday, music, displayName, pronouns, theme, bannerImg, frame, effect, nameBanner, nameStyle, socials, intro } = {}, cb = () => {}) => {
    const u = db.users[me]; if (!u) return;
    if (avatar === null) u.avatar = null;
    else if (avatar !== undefined) { if (!AVATAR_OK(avatar)) return cb({ error: 'Geçersiz resim' }); u.avatar = avatar; }
    if (status !== undefined) { const ns = clean(status, 60); if (ns !== u.status) u.statusUntil = null; u.status = ns; }
    if (bio !== undefined) u.bio = clean(bio, 190);
    if (banner !== undefined) u.banner = /^#[0-9a-f]{6}$/i.test(banner) ? banner : null;
    if (color !== undefined && /^#[0-9a-f]{6}$/i.test(color)) u.color = color;
    if (birthday !== undefined) u.birthday = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(birthday) ? birthday : null;
    if (music !== undefined) u.music = /^https?:\/\/\S{4,300}$/.test(music) ? music : null;
    if (displayName !== undefined) u.displayName = clean(displayName, 32).replace(/[\u200B-\u200F\u202A-\u202E]/g, '');
    if (pronouns !== undefined) u.pronouns = clean(pronouns, 20);
    const sparky = sparkOn(u) || staffRank(u.name) === 'owner';
    if (theme !== undefined) { const t = Array.isArray(theme) && theme.length === 2 && theme.every(c => HEX.test(c)) ? theme : null; if (t && !sparky && JSON.stringify(t) !== JSON.stringify(u.theme)) return cb({ error: 'Profil renk teması Kanka Spark ile açılır' }); u.theme = t; }
    if (intro !== undefined) { if (intro && intro !== 'none' && !INTROS.includes(intro)) return cb({ error: 'Geçersiz açılış efekti' }); if (intro && intro !== 'none' && !sparky) return cb({ error: 'Profil açılış efekti Kanka Spark ile açılır' }); u.intro = intro && intro !== 'none' ? intro : null; }
    if (bannerImg !== undefined) u.bannerImg = bannerImg && UPLOAD_RE.test(bannerImg) ? bannerImg : null;
    if (frame !== undefined) { if (frame && !frameOk(u, frame)) return cb({ error: 'Bu çerçeve henüz açılmadı' }); u.frame = frame && frame !== 'none' ? frame : null; }
    if (effect !== undefined) { if (effect && !effectOk(u, effect)) return cb({ error: PEFFECTS_OWNER.includes(effect) ? 'Bu 3D profil efekti sadece Kurucu rütbesine özeldir' : 'Geçersiz profil efekti' }); u.effect = effect && effect !== 'none' ? effect : null; }
    if (nameBanner !== undefined) { if (nameBanner && !nameBannerOk(u, nameBanner)) return cb({ error: 'Geçersiz isim afişi' }); u.nameBanner = nameBanner && nameBanner !== 'none' ? nameBanner : null; }
    if (nameStyle !== undefined) { if (nameStyle && staffRank(u.name) !== 'owner') return cb({ error: 'Görünen ad stili sadece Kurucu rütbesine özeldir' }); u.nameStyle = staffRank(u.name) === 'owner' ? cleanNameStyle(nameStyle) : null; }
    if (socials !== undefined) { const o = {}; for (const k of SOCIALS) { const v = clean(socials?.[k], 60).replace(/^https?:\/\/\S+\//, '').replace(/^@/, ''); if (v && /^[\w.\-]{1,40}$/.test(v)) o[k] = v; } u.socials = o; }
    if (u.bio || u.status) onbFlag(me, 'profile');
    save(); pushUsers(); cb({ ok: true });
  });
  // Kendi rozet ilerlemen (kazanılmamışlar için)
  socket.on('matchShare', (p, cb = () => {}) => {
    const u = db.users[me]; if (!u) return;
    if (p && typeof p === 'object') {
      const to = p.to === 'voice' || p.to === 'profile' ? p.to : (findChannel(p.to)?.c?.type === 'text' ? p.to : 'voice');
      u.matchShare = { on: p.on !== false, to }; save();
    }
    const chans = serversFor(me).filter(sv => !sv.public).flatMap(sv => sv.channels.filter(c => c.type === 'text' && !c.news && chPerm(sv, c, me, 'send')).map(c => ({ id: c.id, name: c.name, server: sv.name })));
    cb({ on: u.matchShare?.on !== false, to: u.matchShare?.to || 'profile', chans, last: (u.matches || []).slice(0, 5) });
  });
  socket.on('badgeProgress', (cb = () => {}) => {
    const u = db.users[me]; if (!u) return cb({});
    const m = u.msgs || u.xp || 0;
    cb({ sohbet: [Math.min(m, 100), 100], efsane: [Math.min(m, 1000), 1000], xox: [Math.min(u.xoxWins || 0, 3), 3], seri7: [Math.min(u.streak?.best || 0, 7), 7],
      sosyal: [Math.min((u.friends || []).length, 5), 5], gece: [u.night ? 1 : 0, 1], kurucu: [db.servers.some(s => s.owner === me && !s.public) ? 1 : 0, 1], caylak: [u.onb?.rewarded ? 1 : 0, 1], erken: [badgesOf(u).includes('erken') ? 1 : 0, 1] });
  });
  // Rozet paneli: kaç kişide var, kimlerde var (önce arkadaşlar), ne zaman kazanıldı
  socket.on('badgeStats', ({ badge, owner } = {}, cb = () => {}) => {
    if (!me || !BADGES[badge]) return cb({ error: 'Geçersiz' });
    const now = Date.now();
    if (!badgeStatsCache || now - badgeStatsCache.t > 60e3) {
      const holders = {}, users = Object.values(db.users).filter(x => x.name !== 'Claude' && x.name !== BOT_NAME && !x.bot);
      for (const x of users) for (const k of shownBadges(x)) (holders[k] ||= []).push(x.name);
      badgeStatsCache = { t: now, holders, total: users.length };
    }
    const list = (badgeStatsCache.holders[badge] || []).filter(n => db.users[n]), fr = new Set(db.users[me]?.friends || []); // önbellek 1 dk: bu arada silinen/adı değişen hesaplar listede kalmasın
    const sample = [...list.filter(n => fr.has(n) && n !== owner), ...list.filter(n => !fr.has(n) && n !== owner && n !== me).sort((a, b) => (db.users[b].lastSeen || 0) - (db.users[a].lastSeen || 0))].slice(0, 3);
    const o = db.users[owner]; let earned = null;
    if (o) earned = o.awards?.[badge]?.time || (badge === 'dev' ? db.devApps?.[owner]?.decidedAt : null) || (['beta', 'erken'].includes(badge) ? o.createdAt : null) || o.badgeAt?.[badge] || null;
    const by = o?.awards?.[badge]?.by || (badge === 'dev' ? db.devApps?.[owner]?.by : null) || null;
    cb({ count: list.length, total: badgeStatsCache.total, sample, earned, by, betaGiven: badge === 'beta' ? Math.min(300, badgeStatsCache.total) : undefined });
  });
  socket.on('mutuals', (n, cb = () => {}) => {
    const o = db.users[n]; if (!me || !o) return cb({ servers: [], friends: [] });
    const servers = db.servers.filter(s => { const m = membersOf(s); return m.includes(me) && m.includes(n); }).sort((a, b) => (b.id === 's1') - (a.id === 's1')).map(s => ({ id: s.id, name: s.name, icon: s.icon, iconImg: s.iconImg || null, joined: s.joinedAt?.[n] || null }));
    const mine = new Set(db.users[me].friends || []), friends = n === me ? [] : (o.friends || []).filter(x => mine.has(x));
    cb({ matches: (o.matches || []).slice(0, 8), servers: n === me ? [] : servers, friends, joined: Object.fromEntries(db.servers.filter(s => s.members.includes(n) && s.joinedAt?.[n]).map(s => [s.id, s.joinedAt[n]])) });
  });
  // Eski hesaplar için bir kereye mahsus doğum tarihi
  socket.on('veliOnay', (_ = {}, cb = () => {}) => { const u = db.users[me]; if (!u) return cb({ error: 'Giriş yap' }); if (isMinor(u) && !u.guardian) { u.guardian = { at: Date.now(), v: 1, where: 'sonradan' }; save(); } cb({ ok: true }); });
  socket.on('setDob', (dob, cb = () => {}) => {
    const u = db.users[me]; if (!u) return cb({ error: 'Giriş yap' });
    if (u.ageLock) return cb({ error: 'Kanka Chat\'i kullanabilmek için en az 13 yaşında olmalısın.', locked: true });
    if (u.dob) return cb({ ok: true });
    if (limited('dob|' + me, 10, 3600e3)) return cb({ error: 'Çok fazla deneme, biraz bekle.' });
    const age = ageOf(dob); if (age === null) return cb({ error: 'Geçerli bir doğum tarihi seç.' });
    if (age < 13) { u.ageLock = { at: Date.now() }; save(); secLog('yas-kilidi', me, '13 yaş altı doğum tarihi girdi'); return cb({ error: 'Kanka Chat\'i kullanabilmek için en az 13 yaşında olmalısın.', locked: true }); } // tarih saklanmaz, sadece kilit
    u.dob = String(dob); if (!u.birthday) u.birthday = String(dob).slice(5); save();
    cb({ ok: true });
  });
  socket.on('changeName', ({ name, password } = {}, cb = () => {}) => {
    const u = db.users[me]; if (!u) return cb({ error: 'Giriş yap' });
    if (limited('rename|' + me, 5, 600e3)) return cb({ error: 'Çok fazla deneme, biraz bekle.' });
    if (hashPw(String(password ?? ''), u.salt) !== u.hash) return cb({ error: 'Şifre yanlış', field: 'password' });
    name = clean(name, 20);
    if (!NAME_RE.test(name)) return cb({ error: 'Kullanıcı adı 2-20 karakter olmalı; harf, rakam, _ . - kullanabilirsin.', field: 'name' });
    if (name === me) return cb({ error: 'Bu zaten senin adın', field: 'name' });
    const back = (u.oldNames || []).some(o => o.n === name); // kendi eski adına dönüş serbest
    if (name.toLowerCase() !== me.toLowerCase() && nameTaken(name, me) && !back) return cb({ error: 'Bu kullanıcı adı alınmış', field: 'name' });
    const wait = (u.renamedAt || 0) + NAME_COOLDOWN - Date.now();
    if (wait > 0 && !siteAdmin(me)) return cb({ error: `Adını haftada bir değiştirebilirsin. ${Math.ceil(wait / 864e5)} gün sonra tekrar dene.` });
    if (!renameUser(me, name)) return cb({ error: 'Değiştirilemedi' });
    secLog('ad-degisti', me, `${me} → ${name}`);
    cb({ ok: true, name });
  });
  socket.on('nameFree', (name, cb = () => {}) => { name = clean(name, 20); if (!me || limited('namefree|' + me, 60, 60e3)) return cb({}); cb({ ok: NAME_RE.test(name), free: NAME_RE.test(name) && (name.toLowerCase() === me.toLowerCase() || !nameTaken(name, me) || (db.users[me].oldNames || []).some(o => o.n === name)) }); });
  socket.on('changePassword', ({ old, next } = {}, cb = () => {}) => {
    const u = db.users[me]; if (!u) return;
    if (limited('pw|' + me, 5, 600e3)) return cb({ error: 'Çok fazla deneme, biraz bekle.' });
    if (hashPw(String(old ?? ''), u.salt) !== u.hash) return cb({ error: 'Mevcut şifre yanlış' });
    if (String(next ?? '').length < 6) return cb({ error: 'Yeni şifre en az 6 karakter olmalı' });
    u.salt = crypto.randomBytes(16).toString('hex'); u.hash = hashPw(String(next), u.salt);
    sessDelUser(me); for (const s2 of io.sockets.adapter.rooms.get('user:' + me) || []) if (s2 !== socket.id) io.sockets.sockets.get(s2)?.disconnect(true); // şifre değişince diğer cihazlardaki oturumlar kapansın
    save(); cb({ ok: true, token: sessNew(me) });
  });

  // ----- Sunucu yönetimi -----
  const adminServer = (serverId, needAdmin) => {
    const s = db.servers.find(x => x.id === serverId);
    if (!me || !s) return null;
    return (needAdmin ? isAdmin(s, me) : isMod(s, me)) ? s : null;
  };
  // Rol verilebilecek hedefler: üyeler ve sunucuya eklenmiş bot
  const roleTarget = (s, name) => membersOf(s).includes(name) || (name === BOT_NAME && !!s.bot?.added);
  // Kendi rozetlerin: kazandıkların ve gizlediklerin; görünürlüğü değiştir
  socket.on('myBadges', (_ = {}, cb = () => {}) => { const u = db.users[me]; if (!u) return cb({ error: 'Giriş yap' }); cb({ all: badgesOf(u), hidden: u.hideBadges || [], awards: AWARDS, staff: !!staffRank(me) }); });
  socket.on('hideBadges', ({ hidden } = {}, cb = () => {}) => {
    const u = db.users[me]; if (!u || !Array.isArray(hidden)) return cb({ error: 'Geçersiz' });
    const mine = new Set(badgesOf(u)); u.hideBadges = [...new Set(hidden.filter(k => typeof k === 'string' && k in BADGES && mine.has(k)))];
    if (!u.hideBadges.length) delete u.hideBadges;
    save(); pushUsers(); cb({ ok: true });
  });
  // ---- Bot geliştirici beta başvuruları (özel: sadece başvuran ve Kanka ekibi görür) ----
  const devApp = n => (db.devApps ||= {})[n];
  socket.on('devApp', (_ = {}, cb = () => {}) => { if (!me) return cb({ error: 'Giriş yap' }); const a = devApp(me); cb({ app: a ? { ...a, note: undefined } : null, open: db.devBetaOpen !== false }); });
  socket.on('devApply', (f = {}, cb = () => {}) => {
    if (!me) return cb({ error: 'Giriş yap' });
    if (db.devBetaOpen === false) return cb({ error: 'Başvurular şu an kapalı' });
    if (limited('dev|' + me, 3, 3600e3)) return cb({ error: 'Biraz bekleyip tekrar dene' });
    if (isMinor(db.users[me]) && f.veli !== true) return cb({ error: '18 yaşından küçüksen velinin bilgisi ve izniyle başvurduğunu onaylamalısın' });
    const cur = devApp(me); if (cur && cur.status !== 'rejected') return cb({ error: cur.status === 'accepted' ? 'Başvurun zaten kabul edildi' : 'Başvurun zaten değerlendiriliyor' });
    const t = (v, n) => String(v || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
    const LANGS = ['JavaScript', 'TypeScript', 'Python', 'Java', 'C#', 'Go', 'Rust', 'PHP', 'Diğer'];
    const app = { langs: (Array.isArray(f.langs) ? f.langs : []).filter(x => LANGS.includes(x)).slice(0, 5), exp: ['yok', 'az', 'cok'].includes(f.exp) ? f.exp : 'yok',
      link: t(f.link, 200), idea: t(f.idea, 600), hours: ['1-3', '4-8', '8+'].includes(f.hours) ? f.hours : '1-3', contact: t(f.contact, 120), at: Date.now(), status: 'pending', ...(isMinor(db.users[me]) ? { veliAt: Date.now() } : {}) };
    if (!app.langs.length) return cb({ error: 'En az bir dil seç' });
    if (app.idea.length < 20) return cb({ error: 'Bot fikrini biraz daha anlat (en az 20 karakter)' });
    if (app.link && !/^https?:\/\/\S+$/i.test(app.link)) return cb({ error: 'Bağlantı http:// ya da https:// ile başlamalı' });
    db.devApps[me] = app; save();
    for (const n of Object.keys(db.users)) if (staffRank(n)) io.to('user:' + n).emit('toast', `🤖 Yeni bot geliştirici başvurusu: ${me}`);
    cb({ ok: true });
  });
  socket.on('devAppWithdraw', (_ = {}, cb = () => {}) => { const a = me && devApp(me); if (!a || a.status !== 'pending') return cb({ error: 'Geri çekilecek başvuru yok' }); delete db.devApps[me]; save(); cb({ ok: true }); });
  socket.on('adminDevApps', (_ = {}, cb = () => {}) => {
    if (!siteMod(me)) return cb({ error: 'Yetkin yok' });
    const list = Object.entries(db.devApps || {}).map(([n, a]) => ({ name: n, ...a, level: level(db.users[n]?.xp || 0), joined: db.users[n]?.createdAt, earned: !!db.users[n]?.devEarned, stats: db.users[n]?.devStats || {}, seen: db.users[n]?.seen || null, inCh: (db.messages[db.devChId] || []).filter(m => m.author === n).length })).sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || b.at - a.at);
    cb({ list, open: db.devBetaOpen !== false, goal: DEV_GOAL });
  });
  socket.on('adminDevDecide', ({ name, status, note } = {}, cb = () => {}) => {
    if (!siteMod(me)) return cb({ error: 'Yetkin yok' });
    const a = devApp(name); if (!a || !['accepted', 'rejected', 'pending'].includes(status)) return cb({ error: 'Geçersiz' });
    a.status = status; a.by = me; a.decidedAt = Date.now(); a.note = String(note || '').slice(0, 300);
    const u = db.users[name]; if (u) { u.devBeta = status === 'accepted' || undefined; if (!u.devBeta) delete u.devBeta; }
    save(); pushUsers(); devPerks();
    const nt = a.note ? `\n\nekipten not: ${a.note}` : '';
    if (status === 'accepted') botDm(name, { title: '🎉 bot geliştirici başvurun kabul edildi!', tone: 'good',
      text: `hoş geldin! artık kanka'nın bot geliştirici adaylarındansın. kanka hq'da sana özel #bot-gelistirici odası açıldı, duyurular ve sorular orada.${nt}`,
      fields: [['1. adım', 'kanka hq › #bot-gelistirici odasına uğra, kendini tanıt'], ['2. adım', 'bot sistemi açılınca ayarlar › bot geliştirici\'den botunu oluştur'], ['3. adım', 'botunu senin olmayan 3 sunucuya ekletip 50 komut kullanılsın'], ['ödül', '🛠️ bot geliştirici rozeti otomatik gelir']] });
    if (status === 'rejected') botDm(name, { title: 'bot geliştirici başvurun', tone: 'info', text: `başvurun için teşekkürler! bu sefer olmadı ama kapı kapalı değil. birkaç hafta sonra fikrini biraz daha detaylandırıp tekrar başvurabilirsin.${nt}` });
    console.log(`[dev] ${me} -> ${name}: ${status}`); cb({ ok: true });
  });
  socket.on('adminDevBadge', ({ name, on } = {}, cb = () => {}) => {
    if (!siteMod(me)) return cb({ error: 'Yetkin yok' }); const u = db.users[name]; if (!u) return cb({ error: 'Kullanıcı yok' });
    if (on) devAward(name, me); else { delete u.devEarned; if (u.badgeAt) delete u.badgeAt.dev; save(); pushUsers(); devPerks(); }
    staffLog(me, on ? 'Bot geliştirici rozeti verdi' : 'Bot geliştirici rozetini aldı', name); cb({ ok: true });
  });
  // ---------- Uçtan uca şifreleme ----------
  socket.on('e2eMine', (_ = {}, cb = () => {}) => { if (!me) return cb({}); const u = db.users[me]; cb({ key: u.e2e || null, old: (u.e2eOld || []).map(k => k.kid), on: db.e2eOff !== true }); });
  socket.on('e2eSetup', ({ pub, wrapped } = {}, cb = () => {}) => {
    if (!me) return cb({ error: 'Giriş yap' }); if (limited('e2es|' + me, 10, 3600e3)) return cb({ error: 'Biraz bekle' });
    if (!b64ok(pub, 120) || Buffer.from(pub, 'base64').length !== 65) return cb({ error: 'Geçersiz anahtar' });
    const w = wrapped && b64ok(wrapped.s, 40) && b64ok(wrapped.iv, 24) && b64ok(wrapped.ct, 400) ? { s: wrapped.s, iv: wrapped.iv, ct: wrapped.ct, it: Math.min(Math.max(+wrapped.it || 310000, 100000), 2000000) } : null;
    const u = db.users[me], kid = e2eKid(pub);
    if (u.e2e?.kid === kid) { if (w) u.e2e.wrapped = w; save(); return cb({ ok: true, kid }); } // aynı anahtar: sadece yedeği güncelle
    if (u.e2e) { (u.e2eOld ||= []).push({ kid: u.e2e.kid, pub: u.e2e.pub, at: u.e2e.at }); if (u.e2eOld.length > 20) u.e2eOld.shift(); }
    u.e2e = { kid, pub, wrapped: w, at: Date.now() }; save();
    e2eNudge(me); cb({ ok: true, kid });
  });
  socket.on('e2eWrap', ({ wrapped } = {}, cb = () => {}) => { // şifre değişince gizli anahtarın yedeğini yeni şifreyle kilitle
    if (!me || !db.users[me].e2e) return cb({ error: 'Anahtar yok' });
    if (!(wrapped && b64ok(wrapped.s, 40) && b64ok(wrapped.iv, 24) && b64ok(wrapped.ct, 400))) return cb({ error: 'Geçersiz' });
    db.users[me].e2e.wrapped = { s: wrapped.s, iv: wrapped.iv, ct: wrapped.ct, it: Math.min(Math.max(+wrapped.it || 310000, 100000), 2000000) }; save(); cb({ ok: true });
  });
  socket.on('e2eConv', (chId, cb = () => {}) => { if (!me || typeof chId !== 'string' || !isPrivateChat(chId) || !canAccess(me, chId)) return cb({ error: 'Yok' }); cb(e2eConvView(chId)); });
  socket.on('e2eEpoch', ({ chId, ep } = {}, cb = () => {}) => {
    if (!me || typeof chId !== 'string' || !e2eChat(chId) || !canAccess(me, chId)) return cb({ error: 'Bu sohbet şifrelenemez' });
    if (limited('e2ee|' + me, 30, 3600e3)) return cb({ error: 'Biraz bekle' });
    const mem = chatMembers(chId), kids = mem.map(n => e2eCur(n)?.kid);
    if (kids.some(k => !k)) return cb({ error: 'Herkesin anahtarı yok', conv: e2eConvView(chId) });
    const c = (db.e2e ||= {})[chId] ||= { eps: [] }, last = c.eps.at(-1);
    if (last && mem.every(n => last.mem.includes(n)) && last.mem.every(n => mem.includes(n)) && last.wraps[e2eCur(me).kid] && Date.now() - last.at < 864e5 * 365) return cb({ error: 'exists', conv: e2eConvView(chId) }); // yarış: başkası zaten açtı
    if (!ep || typeof ep.id !== 'string' || !/^[a-z0-9]{6,20}$/.test(ep.id) || c.eps.some(x => x.id === ep.id) || !ep.wraps || typeof ep.wraps !== 'object') return cb({ error: 'Geçersiz' });
    const myKid = e2eCur(me).kid, wraps = {};
    for (const k of kids) { const w = ep.wraps[k]; if (!w || w.by !== myKid || !b64ok(w.iv, 24) || !b64ok(w.ct, 120)) return cb({ error: 'Eksik anahtar paylaşımı', conv: e2eConvView(chId) }); wraps[k] = { by: myKid, iv: w.iv, ct: w.ct }; }
    c.eps.push({ id: ep.id, at: Date.now(), by: me, mem: [...mem], wraps }); if (c.eps.length > 200) c.eps.shift();
    save(); for (const n of mem) io.to('user:' + n).emit('e2eConvUpd', chId); cb({ ok: true, conv: e2eConvView(chId) });
  });
  socket.on('e2ePlainMine', (chId, cb = () => {}) => { // şifrelenmeyi bekleyen kendi eski mesajların (sadece yazı/GIF)
    if (!me || typeof chId !== 'string' || !e2eChat(chId) || !canAccess(me, chId) || !db.e2e?.[chId]?.eps?.length) return cb({ items: [] });
    cb({ items: (db.messages[chId] || []).filter(m => m.author === me && !m.enc && (m.kind || 'text') === 'text' && !m.image && !m.files?.length && !m.audio && (m.text || m.gif)).slice(-500).map(m => ({ id: m.id, t: m.text || '', g: m.gif || null })) });
  });
  socket.on('e2eTodo', (_ = {}, cb = () => {}) => { if (!me) return cb({ items: [] }); cb({ items: e2eTodo(me) }); });
  socket.on('e2eShare', ({ items } = {}, cb = () => {}) => {
    if (!me || !Array.isArray(items)) return cb({ error: 'Geçersiz' });
    const myKids = new Set([e2eCur(me)?.kid, ...(db.users[me].e2eOld || []).map(k => k.kid)].filter(Boolean)); let n = 0; const touched = new Set();
    for (const it of items.slice(0, 400)) {
      const c = db.e2e?.[it?.chId]; if (!c || !chatMembers(it.chId).includes(me)) continue;
      const ep = c.eps.find(x => x.id === it.ep); if (!ep || ep.wraps[it.kid] || it.by !== e2eCur(me)?.kid || ![...myKids].some(k => ep.wraps[k])) continue;
      if (!chatMembers(it.chId).some(m => e2eCur(m)?.kid === it.kid) || !b64ok(it.iv, 24) || !b64ok(it.ct, 120)) continue;
      ep.wraps[it.kid] = { by: it.by, iv: it.iv, ct: it.ct }; n++; touched.add(it.chId);
    }
    if (n) { save(); for (const chId of touched) for (const m of chatMembers(chId)) io.to('user:' + m).emit('e2eConvUpd', chId); }
    cb({ ok: true, n });
  });
  socket.on('e2eMigrate', ({ chId, items } = {}, cb = () => {}) => { // kendi eski (şifresiz) mesajlarını şifreli hâliyle değiştir
    if (!me || typeof chId !== 'string' || !e2eChat(chId) || !canAccess(me, chId) || !Array.isArray(items)) return cb({ error: 'Geçersiz' });
    const c = db.e2e?.[chId], done = new Set(); let n = 0;
    for (const it of items.slice(0, 200)) { const m = findMsg(chId, it?.id); if (!m || m.author !== me || m.enc || m.kind !== 'text' || m.image || m.files?.length || m.audio) continue;
      if (!c?.eps.some(x => x.id === it.enc?.ep) || !b64ok(it.enc.iv, 24) || !b64ok(it.enc.ct, 60000) || !b64ok(it.fc, 64)) continue;
      m.enc = { ep: it.enc.ep, iv: it.enc.iv, ct: it.enc.ct }; m.fc = it.fc; delete m.text; delete m.gif; delete m.preview; n++; done.add(m.id); }
    if (n) { for (const x of (db.messages[chId] || [])) if (x.replyTo && done.has(x.replyTo.id)) { x.replyTo.text = ''; x.replyTo.enc = true; } // yanıt alıntılarında da açık metin kalmasın
      save(); io.to(chId).emit('e2eMigrated', { channelId: chId }); }
    cb({ ok: true, n });
  });
  // ---------- Bot API: Geliştirici Portalı, botu sunucuya ekleme, komut ve bileşen etkileşimleri ----------
  const myApp = (aid, cb) => { const a = db.apps?.[aid]; if (!a || (a.owner !== me && !siteAdmin(me))) { cb({ error: 'Uygulama bulunamadı' }); return null; } return a; };
  socket.on('appMine', (_ = {}, cb = () => {}) => {
    if (!me) return cb({ error: 'Giriş yap' });
    const devS = db.devServer && db.servers.find(x => x.id === db.devServer);
    cb({ ok: true, topluluk: devS ? { davet: devS.invite, id: devS.id, uye: devS.members.includes(me) } : null, izin: devOk(me), basvuru: db.devApps?.[me]?.status || null, max: APP_MAX, esik: REACH_MAX, apps: Object.values(db.apps || {}).filter(a => a.owner === me).map(a => appView(a, true)), devStats: db.users[me].devStats || { servers: 0, cmds: 0 }, hedef: DEV_GOAL, rozet: !!db.users[me].devEarned });
  });
  socket.on('appCreate', ({ name, desc } = {}, cb = () => {}) => {
    if (!me) return cb({ error: 'Giriş yap' });
    if (!devOk(me)) return cb({ error: 'Bot oluşturmak için bot geliştirici başvurunun kabul edilmiş olması gerekiyor' });
    if (limited('appc|' + me, 5, 3600e3)) return cb({ error: 'Biraz bekle' });
    const mine = Object.values(db.apps || {}).filter(a => a.owner === me);
    if (mine.length >= APP_MAX && !siteAdmin(me)) return cb({ error: `En fazla ${APP_MAX} uygulama oluşturabilirsin` });
    name = clean(name, 20);
    if (!NAME_RE.test(name)) return cb({ error: 'Bot adı 2-20 karakter olmalı; harf, rakam, _ . - kullanabilirsin', field: 'name' });
    if (nameTaken(name) || /kanka|claude|admin|yönetim|yonetim|destek|resmi|official/i.test(name)) return cb({ error: 'Bu ad kullanılamaz ya da alınmış', field: 'name' });
    const aid = id() + id(), token = crypto.randomBytes(30).toString('base64url');
    db.users[name] = { name, bot: { app: aid }, color: COLORS[crypto.randomInt(COLORS.length)], xp: 0, createdAt: Date.now(), avatar: pickPresetAv(), displayName: name, bio: clean(desc, 190) }; uidOf(db.users[name]);
    const a = (db.apps ||= {})[aid] = { id: aid, owner: me, bot: name, name, desc: clean(desc, 400), createdAt: Date.now(), tokenH: appTokH(token), tokenAt: Date.now(), secret: crypto.randomBytes(24).toString('hex'), cmds: [], dmOk: true, stats: {} };
    if (!mine.length) { // ilk botla birlikte bir deneme sunucusu: bot içinde hazır
      const s = { id: id(), name: `${name} deneme`, icon: '🤖', owner: me, members: [me], joinedAt: { [me]: Date.now() }, createdAt: Date.now(), setup: {}, roles: {}, customRoles: [], memberRoles: {}, bans: {}, timeouts: {}, invite: newInviteCode(), template: 'bos', botTest: aid,
        channels: [{ id: id(), name: 'genel', type: 'text', topic: 'Botunu burada dene: / yaz, komutların listede görünür' }, { id: id(), name: 'bot-kayitlari', type: 'text', topic: 'Botunun mesaj attığı ikinci bir oda' }] };
      db.servers.push(s); botJoin(a, s, BOT_PERMS, me); a.testServer = s.id;
    }
    save(); pushUsers(); pushServers([me]);
    cb({ ok: true, app: appView(a, true), token, sir: a.secret });
  });
  socket.on('appUpdate', async ({ id: aid, desc, displayName, avatar, privacy, dmOk, interUrl, listed } = {}, cb = () => {}) => {
    const a = myApp(aid, cb); if (!a) return; const u = db.users[a.bot];
    if (desc !== undefined) { a.desc = clean(desc, 400); u.bio = clean(desc, 190); }
    if (displayName !== undefined) u.displayName = clean(displayName, 32) || a.bot;
    if (avatar !== undefined && (avatar === null || UPLOAD_RE.test(avatar) || /^\/dosya\/[a-f0-9]{24}(\/[^?#\s]*)?$/.test(avatar) || PRESET_AV.includes(avatar))) u.avatar = avatar || PRESET_AV[0] || null;
    if (privacy !== undefined) a.privacy = /^https:\/\/\S{4,300}$/.test(privacy || '') ? privacy : '';
    if (dmOk !== undefined) a.dmOk = !!dmOk;
    if (listed !== undefined) a.listed = !!listed;
    if (interUrl !== undefined) {
      const url = String(interUrl || '').trim();
      if (!url) a.interUrl = '';
      else { if (!/^https:\/\/\S{4,300}$/.test(url) && !(process.env.BOT_HTTP_TEST === '1' && /^http:\/\/127\.0\.0\.1:\d+\/\S*$/.test(url))) return cb({ error: 'Etkileşim adresi https:// ile başlamalı' });
        const old = a.interUrl; a.interUrl = url; const r = await interHttp(a, { tur: 'PING' });
        if (!r || (r.tur ?? r.type) !== 'PONG') { a.interUrl = old || ''; return cb({ error: 'Adres doğrulanamadı: { "tur": "PING" } isteğine 3 saniye içinde { "tur": "PONG" } dönmeli (imzayı da kontrol etmelisin)' }); } }
    }
    save(); pushUsers(); cb({ ok: true, app: appView(a, true) });
  });
  // Geliştirici Portalı: botun kendi emojileri (sadece o bot kullanabilir; mesajda :ad: yazınca görünür)
  socket.on('appEmojiAdd', ({ id: aid, name, url } = {}, cb = () => {}) => {
    const a = myApp(aid, cb); if (!a) return;
    const ad = String(name || '').toLowerCase().trim();
    if (!/^[a-z0-9_]{2,24}$/.test(ad)) return cb({ error: 'Emoji adı 2-24 karakter olmalı: küçük harf, rakam ya da _' });
    if (!UPLOAD_RE.test(url || '')) return cb({ error: 'Geçersiz resim' });
    try { if (fs.statSync(path.join(UPLOADS, path.basename(url))).size > 512 * 1024) return cb({ error: 'Emoji en fazla 512 KB olabilir' }); } catch { return cb({ error: 'Resim bulunamadı' }); }
    a.emojis ||= {};
    if (!a.emojis[ad] && Object.keys(a.emojis).length >= APP_EMOJI_MAX) return cb({ error: `Bir bota en fazla ${APP_EMOJI_MAX} emoji eklenebilir` });
    if (limited('appemo|' + me, 40, 600e3)) return cb({ error: 'Çok hızlı, biraz bekle' });
    a.emojis[ad] = url; save(); cb({ ok: true, ad });
  });
  socket.on('appEmojiDel', ({ id: aid, name } = {}, cb = () => {}) => {
    const a = myApp(aid, cb); if (!a) return;
    if (!a.emojis?.[name]) return cb({ error: 'Böyle bir emoji yok' });
    delete a.emojis[name]; save(); cb({ ok: true });
  });
  socket.on('appToken', ({ id: aid, secret } = {}, cb = () => {}) => {
    const a = myApp(aid, cb); if (!a) return; if (limited('appt|' + me, 10, 3600e3)) return cb({ error: 'Biraz bekle' });
    if (secret) { a.secret = crypto.randomBytes(24).toString('hex'); save(); return cb({ ok: true, sir: a.secret }); }
    const token = crypto.randomBytes(30).toString('base64url'); a.tokenH = appTokH(token); a.tokenAt = Date.now(); save();
    for (const c of botConnsOf(a.id)) c.ws.close(4004, 'Token yenilendi');
    cb({ ok: true, token });
  });
  socket.on('appDelete', ({ id: aid, confirm } = {}, cb = () => {}) => {
    const a = myApp(aid, cb); if (!a) return; if (confirm !== a.bot) return cb({ error: 'Onay için botun adını aynen yaz' });
    appRemove(a); cb({ ok: true });
  });
  socket.on('appVerifyReq', ({ id: aid, why, needContent, contentWhy } = {}, cb = () => {}) => {
    const a = myApp(aid, cb); if (!a) return; if (a.verified) return cb({ error: 'Bot zaten doğrulanmış' });
    if (a.verifyReq?.status === 'pending') return cb({ error: 'İsteğin zaten inceleniyor' });
    why = clean(why, 800); if (why.length < 30) return cb({ error: 'Botun ne yaptığını biraz daha anlat (en az 30 karakter)' });
    a.verifyReq = { at: Date.now(), why, needContent: !!needContent, contentWhy: clean(contentWhy, 500), status: 'pending', reach: reachOf(a) }; save();
    for (const n of Object.keys(db.users)) if (staffRank(n)) io.to('user:' + n).emit('toast', `🤖 Doğrulama isteği: ${a.bot}`);
    cb({ ok: true, app: appView(a, true) });
  });
  // Ekleme ekranı: bot bilgisi + eklenebileceğin sunucular
  socket.on('appInfo', ({ id: aid, perms } = {}, cb = () => {}) => {
    const a = db.apps?.[aid]; if (!a) return cb({ error: 'Bot bulunamadı' }); if (a.killed) return cb({ error: 'Bu bot şu an kullanılamıyor' });
    const want = (Array.isArray(perms) ? perms : String(perms || '').split(',')).filter(p => BOT_PERMS.includes(p));
    const reach = reachOf(a);
    cb({ ok: true, app: appView(a), izinler: want, tumIzinler: BOT_PERMS, erisim: reach, esik: REACH_MAX,
      sunucular: me ? db.servers.filter(s => !s.public && s.members.includes(me) && can(s, me, 'manageServer')).map(s => ({ id: s.id, ad: s.name, simge: s.icon, simgeImg: s.iconImg || null, var: s.members.includes(a.bot), uye: humans(s.members).length, sigmaz: !a.verified && reachOf(a, s) > REACH_MAX })) : [] });
  });
  socket.on('appAuthorize', ({ id: aid, serverId, perms } = {}, cb = () => {}) => {
    const a = db.apps?.[aid], s = db.servers.find(x => x.id === serverId);
    if (!me || !a || !s) return cb({ error: 'Bulunamadı' }); if (a.killed) return cb({ error: 'Bu bot şu an kullanılamıyor' });
    if (s.public) return cb({ error: 'Herkese açık sunuculara bot eklenemez' });
    if (!s.members.includes(me) || !can(s, me, 'manageServer')) return cb({ error: 'Bu sunucuya bot eklemek için "Sunucuyu yönet" yetkin olmalı' });
    if (s.members.includes(a.bot)) return cb({ error: 'Bot zaten bu sunucuda' });
    if (s.bans?.[a.bot]) return cb({ error: 'Bu bot bu sunucudan yasaklanmış' });
    if (s.members.filter(isBotUser).length >= 25) return cb({ error: 'Bir sunucuda en fazla 25 bot olabilir' });
    if (!a.verified && reachOf(a, s) > REACH_MAX) return cb({ error: `Bu bot henüz doğrulanmadı: doğrulanmamış botlar en fazla ${REACH_MAX} kişiye ulaşabilir (bu sunucuyla ${reachOf(a, s)} olur). Geliştiricisi Kanka'dan doğrulama isteyebilir.`, esik: true });
    if (limited('appauth|' + me, 10, 600e3)) return cb({ error: 'Biraz bekle' });
    botJoin(a, s, (Array.isArray(perms) ? perms : []).filter(p => BOT_PERMS.includes(p)), me);
    save(); pushServers(membersOf(s)); pushUsers();
    if (a.owner !== me) botDm(a.owner, { title: `🤖 ${a.bot} yeni bir sunucuya eklendi`, tone: 'good', text: `${s.name} sunucusuna ${me} tarafından eklendi. botun artık ${botServers(a).length} sunucuda, ${reachOf(a)} kişiye ulaşıyor.` });
    cb({ ok: true, serverId: s.id });
  });
  // Komut kullan
  socket.on('appCmd', ({ chId, app: aid, name, opts } = {}, cb = () => {}) => {
    if (!me || typeof chId !== 'string' || !canAccess(me, chId)) return cb({ error: 'Erişim yok' });
    if (limited('appcmd|' + me, 20, 60e3)) return cb({ error: 'Çok hızlı komut kullanıyorsun' });
    const a = db.apps?.[aid]; if (!a) return cb({ error: 'Bot bulunamadı' }); if (a.killed) return cb({ error: 'Bu bot şu an kullanılamıyor' });
    let s = null;
    if (chId.startsWith('dm:')) { if (!dmPeers(chId).includes(a.bot)) return cb({ error: 'Bu bot burada yok' }); }
    else { const f = findChannel(chId); if (!f || !f.s.members.includes(a.bot) || !seesChannel(f.s, f.c, a.bot)) return cb({ error: 'Bu bot bu odayı göremiyor' });
      s = f.s; if (!chPerm(f.s, f.c, me, 'apps')) return cb({ error: 'Bu odada uygulama kullanma iznin yok' }); if (timedOut(f.s, me)) return cb({ error: 'Susturulmuşken komut kullanamazsın' }); }
    const cmd = [...(a.cmds || []), ...(s ? a.srvCmds?.[s.id] || [] : [])].find(c => c.ad === String(name || '').toLocaleLowerCase('tr')); if (!cmd) return cb({ error: 'Komut bulunamadı' });
    const p = parseOpts(cmd, opts && typeof opts === 'object' ? opts : {}, s); if (p.error) return cb({ error: p.error });
    const it = newInter(a, 'KOMUT', me, chId, { ad: cmd.ad, secenekler: p.out });
    cb({ ok: true, iid: it.id });
  });
  socket.on('appComp', ({ chId, msgId, cid, values } = {}, cb = () => {}) => {
    if (!me || typeof chId !== 'string' || !canAccess(me, chId)) return cb({ error: 'Erişim yok' });
    if (limited('appcomp|' + me, 30, 60e3)) return cb({ error: 'Çok hızlı' });
    const e = ephGet(msgId); if (e && e.user !== me) return cb({ error: 'Bu mesaj sana ait değil' });
    const m = e ? e.msg : findMsg(chId, msgId); if (!m?.app) return cb({ error: 'Mesaj bulunamadı' });
    const a = db.apps[m.app]; if (!a || a.killed) return cb({ error: 'Bot kullanılamıyor' });
    const comp = (m.comps || []).flat().find(c => c.id === cid); if (!comp || comp.kapali) return cb({ error: 'Bu düğme artık kullanılamıyor' });
    const f = isPrivateChat(chId) ? null : findChannel(chId); if (f && timedOut(f.s, me)) return cb({ error: 'Susturulmuşken kullanamazsın' });
    if (f && !chPerm(f.s, f.c, me, 'apps')) return cb({ error: 'Bu odada uygulama kullanma iznin yok' });
    let data = { id: cid };
    if (PICK_TUR[comp.tur]) { const r = pickVals(comp.tur, values, f?.s || null, chId, me, comp); if (r.error) return cb(r); data.degerler = r.vals; data.cozulmus = r.coz; }
    if (comp.tur === 'secim') { const vals = (Array.isArray(values) ? values : []).map(String).filter(v => comp.secenekler.some(o => o.deger === v)); if (vals.length < comp.min || vals.length > comp.max) return cb({ error: 'Geçersiz seçim' }); data.degerler = vals; }
    newInter(a, comp.tur === 'buton' ? 'BUTON' : 'SECIM', me, chId, data, m); cb({ ok: true });
  });
  socket.on('appFormSubmit', ({ iid, values } = {}, cb = () => {}) => {
    const it = inters.get(iid); if (!me || !it || it.user !== me || !it.form) return cb({ error: 'Form süresi doldu' });
    const a = db.apps[it.app]; if (!a || a.killed) return cb({ error: 'Bot kullanılamıyor' });
    const vals = {}; for (const [k, v] of Object.entries(values && typeof values === 'object' ? values : {}).slice(0, 5)) vals[clean(k, 60)] = clean(v, 4000);
    const f2 = it.form, coz = {}, fs = isPrivateChat(it.chId) ? null : findChannel(it.chId)?.s || null;
    for (const [k, t] of Object.entries(f2.tipler || {})) if (PICK_TUR[t]) {
      if (!vals[k]) { if (f2.zorunlu?.includes(k)) return cb({ error: 'Bir seçim yapmalısın' }); continue; }
      const r = pickVals(t, vals[k], fs, it.chId, me); if (r.error) return cb(r); vals[k] = r.vals[0]; coz[k] = Object.values(r.coz)[0][0];
    }
    it.form = null;
    newInter(a, 'FORM', me, it.chId, { id: f2.id, alanlar: vals, ...(Object.keys(coz).length ? { cozulmus: coz } : {}) }, it.msgId ? findMsg(it.chId, it.msgId) || ephGet(it.msgId)?.msg : null); cb({ ok: true });
  });
  socket.on('ozelKapat', (mid, cb = () => {}) => { const e = typeof mid === 'string' && ozelIdx.get(mid); if (!me || !e || e.user !== me) return cb({ error: 'Mesaj yok' }); ozelDel(mid); cb({ ok: true }); });
  socket.on('appDmCmds', (bot, cb = () => {}) => cb({ komutlar: me && typeof bot === 'string' && isBotUser(bot) ? dmCmdsFor(bot) : [] }));
  socket.on('setBotDm', (on, cb = () => {}) => { const u = db.users[me]; if (!u) return cb({}); u.botDmOff = !on; save(); cb({ ok: true, on: !u.botDmOff }); });
  socket.on('appDirectory', (_ = {}, cb = () => {}) => cb({ ok: true, apps: Object.values(db.apps || {}).filter(a => a.verified && a.listed && !a.killed).map(a => ({ ...appView(a), sunucu: botServers(a).length, erisim: reachOf(a) })).sort((x, y) => y.erisim - x.erisim) }));
  // Yönetim: doğrulama istekleri ve acil kapatma
  socket.on('adminApps', (_ = {}, cb = () => {}) => {
    if (!staffRank(me)) return cb({ error: 'Yetkin yok' });
    cb({ ok: true, esik: REACH_MAX, apps: Object.values(db.apps || {}).map(a => ({ ...appView(a, true), sahipSeviye: level(db.users[a.owner]?.xp || 0) })).sort((x, y) => (y.dogrulama?.status === 'pending') - (x.dogrulama?.status === 'pending') || y.erisim - x.erisim) });
  });
  socket.on('adminAppAct', ({ id: aid, action, note, contentOk: cOk } = {}, cb = () => {}) => {
    if (!staffRank(me) || !['owner', 'admin'].includes(staffRank(me))) return cb({ error: 'Sadece kurucu ve yöneticiler' });
    const a = db.apps?.[aid]; if (!a) return cb({ error: 'Uygulama yok' }); note = clean(note, 400);
    if (action === 'verify') { a.verified = Date.now(); a.contentOk = !!cOk; if (a.verifyReq) Object.assign(a.verifyReq, { status: 'ok', by: me, decidedAt: Date.now(), note });
      botDm(a.owner, { title: `✅ ${a.bot} doğrulandı`, tone: 'good', text: `botun artık ${REACH_MAX} kişi sınırı olmadan her sunucuya eklenebilir${cOk ? ' ve mesaj içeriklerini görebilir' : ''}. adının yanında doğrulanmış tiki görünüyor.${note ? '\n\nekipten not: ' + note : ''}` }); staffLog(me, 'Botu doğruladı', a.bot); }
    else if (action === 'reject') { if (a.verifyReq) Object.assign(a.verifyReq, { status: 'rejected', by: me, decidedAt: Date.now(), note });
      botDm(a.owner, { title: `${a.bot} doğrulama isteği`, tone: 'warn', text: `şimdilik onaylanmadı.${note ? ' sebep: ' + note : ''} düzeltip tekrar isteyebilirsin.` }); staffLog(me, 'Bot doğrulamasını reddetti', a.bot, note); }
    else if (action === 'unverify') { a.verified = null; a.contentOk = false; staffLog(me, 'Bot doğrulamasını kaldırdı', a.bot, note); }
    if (['verify', 'unverify', 'kill', 'unkill'].includes(action)) devRoleSync(a.owner);
    else if (action === 'kill') { a.killed = { at: Date.now(), by: me, reason: note }; for (const c of botConnsOf(a.id)) c.ws.close(4014, 'Bot durduruldu'); botDm(a.owner, { title: `⛔ ${a.bot} durduruldu`, tone: 'danger', text: `botun Kanka ekibi tarafından durduruldu.${note ? ' sebep: ' + note : ''} itiraz için kankahq1@gmail.com` }); staffLog(me, 'Botu durdurdu', a.bot, note); }
    else if (action === 'unkill') { a.killed = null; staffLog(me, 'Botu yeniden açtı', a.bot); }
    else return cb({ error: 'Geçersiz işlem' });
    save(); pushUsers(); cb({ ok: true, app: appView(a, true) });
  });
  socket.on('botInfo', (_ = {}, cb = () => {}) => {
    if (!me) return cb({});
    const all = db.servers.filter(x => x.bot?.added && !x.public), mine = all.filter(x => x.members.includes(me) || x.owner === me);
    const first = Math.min(...all.map(x => x.bot.addedAt || x.created || Date.now()), Date.now());
    cb({ total: all.length + 1, mutual: [{ id: 's1', name: 'Kanka HQ' }, ...mine.map(x => ({ id: x.id, name: x.name, icon: x.icon, iconImg: x.iconImg }))].slice(0, 30), since: first });
  });
  socket.on('adminDevOpen', ({ open } = {}, cb = () => {}) => { if (!siteMod(me)) return cb({ error: 'Yetkin yok' }); db.devBetaOpen = !!open; save(); cb({ ok: true }); });
  // Kanka ekibi kullanıcıya elle rozet verir/geri alır (ör. Hata Avcısı)
  socket.on('userAward', ({ name, badge, on } = {}, cb = () => {}) => {
    if (!siteMod(me)) return cb({ error: 'Bu rozeti sadece Kanka ekibi verebilir' });
    const u = db.users[name];
    if (!u || !AWARDS.includes(badge)) return cb({ error: 'Geçersiz' });
    u.awards ||= {};
    const had = !!u.awards[badge];
    if (on) u.awards[badge] = u.awards[badge] || { by: me, time: Date.now() }; else delete u.awards[badge];
    save(); pushUsers();
    if (on && !had) {
      io.to('user:' + name).emit('toast', `🎉 Yeni rozet ${BADGES[badge][0]} ${BADGES[badge][1]}! Teşekkürler kanka`);
      io.to('user:' + name).emit('badgeEarned', { badge, by: me });
    }
    console.log(`[rozet] ${me} -> ${name}: ${badge} ${on ? 'verdi' : 'aldı'}`);
    cb({ ok: true, on: !!on });
  });
  // ---- Sunucu rozeti başvurusu (Doğrulanmış / Kanka Partner): sunucu sahibi başvurur, Kanka yönetimi karar verir ----
  const SB_LABEL = { dogrulanmis: 'Doğrulanmış', partner: 'Kanka Partner', yildiz: 'Yıldız' };
  const SB_REQ = { yildiz: PT.yildiz, dogrulanmis: { members: 0, days: 0 } };
  const sbInfo = s => srvStats(s);
  socket.on('srvBadgeApp', ({ serverId } = {}, cb = () => {}) => {
    const s = db.servers.find(x => x.id === serverId); if (!s || s.owner !== me) return cb({ error: 'Rozete sadece sunucu sahibi başvurabilir' });
    const A = (db.srvApps ||= {})[serverId] ||= {};
    A.code ||= 'kanka-' + crypto.randomBytes(3).toString('hex'); save();
    const view = t => A[t] ? { status: A[t].status, at: A[t].at, link: A[t].link, about: A[t].about, note: A[t].status === 'rejected' ? A[t].note || '' : '' } : null;
    const tier = isStar(s) ? 'yildiz' : srvBadges(s).some(b => b.id === 'yukselen') ? 'yukselen' : srvBadges(s).some(b => b.id === 'topluluk') ? 'topluluk' : null;
    cb({ code: A.code, info: sbInfo(s), req: SB_REQ, tiers: PT, tier, vanity: s.vanity || null, emoji: { used: Object.keys(s.emojis || {}).length, max: emojiLimit(s) }, partner: !!s.badges?.partner, has: { dogrulanmis: !!s.badges?.dogrulanmis, yildiz: isStar(s) }, apps: { dogrulanmis: view('dogrulanmis'), yildiz: view('yildiz') } });
  });
  socket.on('srvBadgeApply', ({ serverId, type, link, about } = {}, cb = () => {}) => {
    const s = db.servers.find(x => x.id === serverId); if (!s || s.owner !== me) return cb({ error: 'Rozete sadece sunucu sahibi başvurabilir' });
    if (!SB_REQ[type]) return cb({ error: 'Geçersiz' });
    if (s.badges?.[type] || (type === 'yildiz' && isStar(s))) return cb({ error: 'Sunucunda bu rozet zaten var' });
    if (limited('sb|' + me, 4, 3600e3)) return cb({ error: 'Biraz bekleyip tekrar dene' });
    const A = (db.srvApps ||= {})[serverId] ||= {}; if (A[type]?.status === 'pending') return cb({ error: 'Başvurun zaten değerlendiriliyor' });
    const i = sbInfo(s), r = SB_REQ[type];
    if (!meets(i, r)) return cb({ error: type === 'yildiz' ? `Yıldız için en az ${r.members} üye, ${r.days} günlük sunucu, haftada ${r.active} aktif üye ve kurallar gerekiyor` : `Bu rozet için en az ${r.members} üye ve ${r.days} günlük sunucu gerekiyor` });
    const t = (v, n) => String(v || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
    link = t(link, 200); about = t(about, 500);
    if (type === 'dogrulanmis' && !/^https?:\/\/\S+$/i.test(link)) return cb({ error: 'Resmi hesabının bağlantısını gir (https:// ile)' });
    if (link && !/^https?:\/\/\S+$/i.test(link)) return cb({ error: 'Bağlantı https:// ile başlamalı' });
    if (about.length < 20) return cb({ error: 'Biraz daha anlat (en az 20 karakter)' });
    A[type] = { status: 'pending', at: Date.now(), by: me, link, about, members: i.members, days: i.days };
    save();
    for (const n of Object.keys(db.users)) if (staffRank(n)) io.to('user:' + n).emit('toast', `🏷️ Yeni sunucu rozeti başvurusu: ${s.name}`);
    cb({ ok: true });
  });
  socket.on('srvVanity', ({ serverId, slug } = {}, cb = () => {}) => {
    const s = db.servers.find(x => x.id === serverId); if (!s || s.owner !== me) return cb({ error: 'Sadece sunucu sahibi değiştirebilir' });
    if (!vanityOk(s)) return cb({ error: 'Özel link Yıldız/Partner sunuculara ve Energy Level 3 sunuculara özel' });
    slug = String(slug || '').toLowerCase().trim();
    if (!slug) { delete s.vanity; save(); return cb({ ok: true, vanity: null }); }
    if (!/^[a-z0-9](?:[a-z0-9-]{1,22}[a-z0-9])$/.test(slug)) return cb({ error: '3-24 karakter: küçük harf, rakam ve tire (başta/sonda tire olmaz)' });
    if (['kanka', 'kankahq', 'admin', 'yonetim', 'destek', 'resmi', 'partner', 'yildiz', 'api', 'davet', 'kod'].includes(slug)) return cb({ error: 'Bu isim ayrılmış' });
    if (db.servers.some(x => x !== s && x.vanity === slug)) return cb({ error: 'Bu link alınmış' });
    if (limited('vanity|' + me, 6, 3600e3)) return cb({ error: 'Biraz bekle' });
    s.vanity = slug; audit(s, me, 'Özel linki değiştirdi', slug); save(); cb({ ok: true, vanity: slug });
  });
  // Webhook yönetimi: sunucu ya da oda yönetme yetkisi gerekir
  const whView = w => ({ id: w.id, name: w.name, avatar: w.avatar || null, channelId: w.channelId, by: w.by, createdAt: w.createdAt, uses: w.uses || 0, lastAt: w.lastAt || null, url: `${baseUrl()}/api/webhooks/${w.id}/${w.token}` });
  const whSrv = serverId => { const s = db.servers.find(x => x.id === serverId); return s && !s.public && (s.owner === me || can(s, me, 'manageWebhooks') || can(s, me, 'manageServer')) ? s : null; };
  socket.on('levelsGet', ({ serverId } = {}, cb = () => {}) => { const s = permServer(serverId, 'manageServer'); if (!s) return cb({ error: 'Sunucuyu yönetme yetkin yok' }); cb({ cfg: { on: s.levels?.on !== false, announce: s.levels?.announce || 'same', channel: s.levels?.channel || null, rewards: s.levels?.rewards || [], stack: s.levels?.stack !== false } }); });
  socket.on('levelsSave', ({ serverId, cfg } = {}, cb = () => {}) => {
    const s = permServer(serverId, 'manageServer'); if (!s || s.public) return cb({ error: 'Sunucuyu yönetme yetkin yok' });
    const roles = new Set((s.customRoles || []).filter(r => !r.bot).map(r => r.id));
    const rewards = (Array.isArray(cfg?.rewards) ? cfg.rewards : []).map(r => ({ level: Math.max(2, Math.min(100, parseInt(r.level) || 0)), role: String(r.role || '') })).filter(r => roles.has(r.role)).slice(0, 15);
    // yetkili rol ödül olamaz: seviye kasan biri yönetici olmasın
    const risky = rewards.find(r => (s.customRoles.find(x => x.id === r.role)?.perms || []).length); if (risky) return cb({ error: `"${s.customRoles.find(x => x.id === risky.role).name}" rolünde yetki var. Ödül rolleri yetkisiz olmalı.` });
    s.levels = { on: cfg?.on !== false, announce: ['same', 'channel', 'off'].includes(cfg?.announce) ? cfg.announce : 'same', channel: s.channels.some(c => c.id === cfg?.channel && !voiceLike(c.type)) ? cfg.channel : null, rewards: rewards.sort((a, b) => a.level - b.level), stack: cfg?.stack !== false };
    audit(s, me, 'Seviye ayarlarını değiştirdi'); save(); cb({ ok: true });
  });
  socket.on('whList', ({ serverId } = {}, cb = () => {}) => { const s = whSrv(serverId); if (!s) return cb({ error: 'Yetkin yok' }); cb({ list: Object.values(db.webhooks || {}).filter(w => w.serverId === s.id).sort((a, b) => a.createdAt - b.createdAt).map(whView) }); });
  socket.on('whCreate', ({ serverId, channelId, name } = {}, cb = () => {}) => {
    const s = whSrv(serverId); if (!s) return cb({ error: 'Yetkin yok' });
    const c = s.channels.find(x => x.id === channelId && !voiceLike(x.type)); if (!c) return cb({ error: 'Bir yazı odası seç' });
    if (Object.values(db.webhooks || {}).filter(w => w.serverId === s.id).length >= 10) return cb({ error: 'Bir sunucuda en fazla 10 webhook olabilir' });
    if (limited('wh|' + me, 10, 3600e3)) return cb({ error: 'Biraz bekle' });
    const w = { id: crypto.randomBytes(6).toString('hex'), token: crypto.randomBytes(24).toString('base64url'), serverId: s.id, channelId: c.id, name: clean(name, 32) || 'Webhook', avatar: null, by: me, createdAt: Date.now(), uses: 0 };
    (db.webhooks ||= {})[w.id] = w; audit(s, me, 'Webhook oluşturdu', `${w.name} → #${c.name}`); save(); cb({ ok: true, w: whView(w) });
  });
  socket.on('whEdit', ({ id: wid, name, avatar, channelId, reset } = {}, cb = () => {}) => {
    const w = db.webhooks?.[wid], s = w && whSrv(w.serverId); if (!s) return cb({ error: 'Yetkin yok' });
    if (name !== undefined) w.name = clean(name, 32) || w.name;
    if (avatar !== undefined) w.avatar = avatar && UPLOAD_RE.test(avatar) ? avatar : null;
    if (channelId !== undefined) { const c = s.channels.find(x => x.id === channelId && !voiceLike(x.type)); if (!c) return cb({ error: 'Bir yazı odası seç' }); w.channelId = c.id; }
    if (reset) { w.token = crypto.randomBytes(24).toString('base64url'); audit(s, me, 'Webhook linkini yeniledi', w.name); }
    save(); cb({ ok: true, w: whView(w) });
  });
  socket.on('whDelete', ({ id: wid } = {}, cb = () => {}) => {
    const w = db.webhooks?.[wid], s = w && whSrv(w.serverId); if (!s) return cb({ error: 'Yetkin yok' });
    delete db.webhooks[wid]; audit(s, me, 'Webhook sildi', w.name); save(); cb({ ok: true });
  });
  socket.on('adminSrvApps', (_ = {}, cb = () => {}) => {
    if (!siteMod(me)) return cb({ error: 'Yetkin yok' });
    const list = [];
    for (const [sid, A] of Object.entries(db.srvApps || {})) { const s = db.servers.find(x => x.id === sid); if (!s) continue;
      for (const type of ['dogrulanmis', 'partner', 'yildiz']) if (A[type]) list.push({ serverId: sid, name: s.name, owner: s.owner, iconImg: s.iconImg || null, icon: s.icon || null, code: A.code, type, ...A[type], now: sbInfo(s) }); }
    list.sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || b.at - a.at);
    cb({ list, canDecide: siteAdmin(me) });
  });
  socket.on('adminSrvDecide', ({ serverId, type, status, note } = {}, cb = () => {}) => {
    if (!siteAdmin(me)) return cb({ error: 'Rozet kararını sadece Kanka yönetimi verebilir' });
    const s = db.servers.find(x => x.id === serverId), a = db.srvApps?.[serverId]?.[type];
    if (!s || !a || !['accepted', 'rejected'].includes(status)) return cb({ error: 'Geçersiz' });
    a.status = status; a.decidedBy = me; a.decidedAt = Date.now(); a.note = String(note || '').slice(0, 300);
    const label = SB_LABEL[type] || type;
    if (status === 'accepted') { s.badges ||= {}; s.badges[type] = { by: me, time: Date.now() }; audit(s, me, 'Rozet verdi', label); if (type !== 'dogrulanmis') partnerPerks(); pushServers(membersOf(s)); for (const n of membersOf(s)) io.to('user:' + n).emit('toast', `🎉 ${s.name} artık ${label} bir sunucu`); }
    else io.to('user:' + s.owner).emit('toast', `${s.name} için ${label} başvurusu bu sefer olmadı${a.note ? ': ' + a.note : ''}. Sunucu ayarları › Rozetler'den tekrar başvurabilirsin`);
    save(); console.log(`[rozet-başvuru] ${me} -> ${s.name}: ${type} ${status}`); cb({ ok: true });
  });
  socket.on('serverBadge', ({ serverId, badge, on } = {}, cb = () => {}) => {
    if (!siteAdmin(me)) return cb({ error: 'Rozetleri sadece Kanka Chat yönetimi verebilir' });
    const s = db.servers.find(x => x.id === serverId);
    if (!s || !SB_LABEL[badge]) return cb({ error: 'Geçersiz' });
    s.badges ||= {};
    if (on) s.badges[badge] = { by: me, time: Date.now() }; else delete s.badges[badge];
    if (badge !== 'dogrulanmis') partnerPerks();
    audit(s, me, on ? 'Rozet verdi' : 'Rozeti kaldırdı', SB_LABEL[badge]);
    save(); pushServers(membersOf(s));
    for (const n of membersOf(s)) if (on) io.to('user:' + n).emit('toast', `${s.name} artık ${SB_LABEL[badge]} bir sunucu`);
    cb({ ok: true });
  });
  socket.on('updateServer', ({ serverId, name, icon, iconImg, banner, bannerColor, filter, slow, afkCh, afkMin, theme, chatBg, chatBgDim } = {}, cb = () => {}) => {
    const s = permServer(serverId, 'manageServer'); if (!s) return cb({ error: 'Sunucuyu yönetme yetkin yok' });
    if (theme !== undefined) { if (theme && !perkOn(s, 'theme')) return cb({ error: perkErr('theme') }); if (theme && !HEX.test(theme)) return cb({ error: 'Geçersiz renk' }); s.theme = theme || null; audit(s, me, theme ? 'Sunucu renk temasını değiştirdi' : 'Sunucu renk temasını kaldırdı'); }
    if (chatBg !== undefined) { if (chatBg && !perkOn(s, 'chatBg')) return cb({ error: perkErr('chatBg') }); s.chatBg = chatBg && UPLOAD_RE.test(chatBg) ? chatBg : null; audit(s, me, s.chatBg ? 'Sohbet arka planını değiştirdi' : 'Sohbet arka planını kaldırdı'); }
    if (chatBgDim !== undefined) s.chatBgDim = Math.max(0.2, Math.min(0.9, +chatBgDim || 0.6));
    if (filter !== undefined) { s.filter = !!filter; audit(s, me, filter ? 'Küfür filtresini açtı' : 'Küfür filtresini kapattı'); }
    if (slow !== undefined) { s.slow = [0, 5, 10, 30, 60, 300].includes(+slow) ? +slow : 0; audit(s, me, 'Yavaş modu ayarladı', s.slow ? s.slow + ' sn' : 'kapalı'); }
    if (name !== undefined || icon !== undefined || iconImg !== undefined) audit(s, me, 'Sunucu ayarlarını değiştirdi');
    if (name !== undefined) { name = clean(name, 40); if (name) s.name = name; }
    if (icon !== undefined) { icon = clean(icon, 4); if (icon) s.icon = icon; }
    if (iconImg !== undefined) s.iconImg = iconImg && UPLOAD_RE.test(iconImg) ? iconImg : null;
    if (banner !== undefined) { s.banner = banner && UPLOAD_RE.test(banner) ? banner : null; audit(s, me, s.banner ? 'Sunucu afişini değiştirdi' : 'Sunucu afişini kaldırdı'); }
    if (bannerColor !== undefined) s.bannerColor = /^#[0-9a-f]{6}$/i.test(bannerColor || '') ? bannerColor : null;
    if (afkCh !== undefined) { const c = s.channels.find(x => x.id === afkCh && x.type === 'voice'); s.afk = c ? { ch: c.id, min: [1, 5, 10, 15, 30, 60].includes(+afkMin) ? +afkMin : 10 } : null; audit(s, me, 'AFK odasını ayarladı', c ? `${c.name} · ${s.afk.min} dk` : 'kapalı'); }
    save(); pushServers(membersOf(s)); cb({ ok: true });
  });
  socket.on('setRole', ({ serverId, name, role } = {}, cb = () => {}) => {
    const s = adminServer(serverId, true); if (!s) return cb({ error: 'Sadece yönetici rol verebilir' });
    if (!roleTarget(s, name)) return cb({ error: 'Bu kişinin rolü değiştirilemez' });
    if (name === s.owner && me !== s.owner) return cb({ error: 'Sunucu sahibinin rolünü sadece kendisi değiştirebilir' });
    if (name !== me && name !== BOT_NAME && !outranks(s, me, name)) return cb({ error: 'Senden yüksek ya da eşit birinin rolünü değiştiremezsin' });
    if (role === 'mod') s.roles[name] = 'mod'; else delete s.roles[name];
    audit(s, me, role === 'mod' ? 'Moderatör yaptı' : 'Moderatörlüğü aldı', name);
    save(); pushServers(membersOf(s)); cb({ ok: true });
  });
  const permServer = (serverId, perm) => { const s = db.servers.find(x => x.id === serverId); if (s) { s.customRoles ||= []; s.memberRoles ||= {}; s.bans ||= {}; s.timeouts ||= {}; s.roles ||= {}; } return me && s && can(s, me, perm) ? s : null; };
  const pushSrv = s => { save(); pushServers(membersOf(s)); };
  socket.on('roleSave', ({ serverId, role } = {}, cb = () => {}) => {
    const s = permServer(serverId, 'manageRoles'); if (!s) return cb({ error: 'Rolleri yönetme yetkin yok' });
    const name = clean(role?.name, 30); if (!name) return cb({ error: 'Rol adı gerekli' });
    const perms = (role.perms || []).filter(p => PERMS.includes(p) && (s.owner === me || can(s, me, p)) && (p !== 'administrator' || s.owner === me || (r0 => r0?.perms?.includes('administrator'))(s.customRoles.find(x => x.id === role.id))));
    const color = /^#[0-9a-f]{6}$/i.test(role.color) ? role.color : '#99aab5';
    let r = s.customRoles.find(x => x.id === role.id);
    if (r?.bot) { if (!outranksRole(s, r)) return cb({ error: 'Bu rol senden yüksek' }); r.color = color; pushSrv(s); return cb({ ok: true, id: r.id }); }
    let icon; { const raw = String(role.icon || '').trim(), em = /^:([a-z0-9_]{2,24}):$/.exec(raw);
      if (em) { if (!perkOn(s, 'roleEmoji')) return cb({ error: perkErr('roleEmoji') }); if (!s.emojis?.[em[1]]) return cb({ error: 'Bu özel emoji sunucuda yok' }); icon = raw; }
      else icon = [...clean(raw, 16)].slice(0, 2).join('') || null; }
    const mentionable = !!role.mentionable;
    const color2 = HEX.test(role.color2 || '') ? role.color2 : null, font = FONT_IDS.includes(role.font) ? role.font : null;
    if (color2 && !perkOn(s, 'roleGrad') && color2 !== r?.color2) return cb({ error: perkErr('roleGrad') });
    if (font && !perkOn(s, 'roleFont') && font !== r?.font) return cb({ error: perkErr('roleFont') });
    const fx = {}; if (color2) fx.color2 = color2; if (font) fx.font = font;
    if (r) { if (!outranksRole(s, r)) return cb({ error: 'Bu rol senden yüksek' }); delete r.color2; delete r.font; Object.assign(r, { name, color, perms, hoist: !!role.hoist, icon, mentionable, ...fx }); audit(s, me, 'Rolü düzenledi', name); }
    else { if (s.customRoles.length >= MAX_ROLES) return cb({ error: `En fazla ${MAX_ROLES} rol` }); r = { id: id(), name, color, perms, hoist: !!role.hoist, icon, mentionable, ...fx }; s.customRoles.push(r); audit(s, me, 'Rol oluşturdu', name); }
    pushSrv(s); cb({ ok: true, id: r.id });
  });
  const outranksRole = (s, r) => s.owner === me || rankOf(s, me) > 1000 - s.customRoles.indexOf(r);
  socket.on('roleDelete', ({ serverId, roleId } = {}, cb = () => {}) => {
    const s = permServer(serverId, 'manageRoles'); if (!s) return cb({ error: 'Yetkin yok' });
    const r = s.customRoles.find(x => x.id === roleId); if (!r || !outranksRole(s, r)) return cb({ error: 'Bu rolü silemezsin' });
    if (r.bot) return cb({ error: 'Bu rol Kanka Bot\'a ait. Kaldırmak için botu sunucudan at.' });
    if (nukeCheck(s, me, 'rol silme')) return cb({ error: 'Kanka Bot: Kısa sürede çok fazla rol sildin, işlem durduruldu.' });
    s.customRoles = s.customRoles.filter(x => x !== r);
    for (const n in s.memberRoles) s.memberRoles[n] = s.memberRoles[n].filter(x => x !== roleId);
    for (const c of [...s.channels, ...(s.categories || [])]) if (c.perms?.[roleId]) delete c.perms[roleId];
    audit(s, me, 'Rolü sildi', r.name); pushSrv(s); cb({ ok: true });
  });
  socket.on('roleMove', ({ serverId, roleId, dir } = {}, cb = () => {}) => {
    const s = permServer(serverId, 'manageRoles'); if (!s) return cb({ error: 'Yetkin yok' });
    const i = s.customRoles.findIndex(x => x.id === roleId), j = i + (dir < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= s.customRoles.length) return cb({ ok: true });
    if (!outranksRole(s, s.customRoles[i]) || !outranksRole(s, s.customRoles[j])) return cb({ error: 'Senden yüksek rolleri taşıyamazsın' });
    [s.customRoles[i], s.customRoles[j]] = [s.customRoles[j], s.customRoles[i]]; pushSrv(s); cb({ ok: true });
  });
  socket.on('roleOrder', ({ serverId, roleId, to } = {}, cb = () => {}) => { // sürükle-bırak: rolü listede istenen sıraya taşı
    const s = permServer(serverId, 'manageRoles'); if (!s) return cb({ error: 'Yetkin yok' });
    const i = s.customRoles.findIndex(x => x.id === roleId), j = Math.min(Math.max(parseInt(to) || 0, 0), s.customRoles.length - 1);
    if (i < 0) return cb({ error: 'Rol bulunamadı' }); if (i === j) return cb({ ok: true });
    for (let k = Math.min(i, j); k <= Math.max(i, j); k++) if (!outranksRole(s, s.customRoles[k])) return cb({ error: 'Rolü kendi rolünün üstüne ya da senden yüksek rollerin arasına taşıyamazsın' });
    const [r] = s.customRoles.splice(i, 1); s.customRoles.splice(j, 0, r);
    audit(s, me, 'Rol sırasını değiştirdi', `${r.name}: ${i + 1}. → ${j + 1}.`); pushSrv(s); cb({ ok: true });
  });
  socket.on('roleHoist', ({ serverId, roleId, hoist } = {}, cb = () => {}) => {
    const s = permServer(serverId, 'manageRoles'); if (!s) return cb({ error: 'Yetkin yok' });
    const r = s.customRoles.find(x => x.id === roleId); if (!r || r.bot || !outranksRole(s, r)) return cb({ error: 'Bu rolü düzenleyemezsin' });
    r.hoist = !!hoist; audit(s, me, hoist ? 'Rolü listede ayrı gösterdi' : 'Rolü listede ayrı göstermeyi kapattı', r.name); pushSrv(s); cb({ ok: true });
  });
  // Rolün içinden toplu üye ekle / çıkar
  socket.on('roleMembers', ({ serverId, roleId, add = [], remove = [] } = {}, cb = () => {}) => {
    const s = permServer(serverId, 'manageRoles'); if (!s) return cb({ error: 'Rolleri yönetme yetkin yok' });
    const r = s.customRoles.find(x => x.id === roleId); if (!r || r.bot) return cb({ error: 'Rol bulunamadı' });
    if (!outranksRole(s, r)) return cb({ error: 'Senden yüksek bir rolü veremez/alamazsın' });
    const mem = new Set(membersOf(s)); if (s.bot?.added) mem.add(BOT_NAME);
    const addL = Array.isArray(add) ? add.slice(0, 200) : [], remL = Array.isArray(remove) ? remove.slice(0, 200) : [];
    if ([...addL, ...remL].includes(s.owner) && me !== s.owner) return cb({ error: 'Sunucu sahibinin rollerini sadece kendisi değiştirebilir' });
    if ([...addL, ...remL].some(n => n !== me && n !== BOT_NAME && !outranks(s, me, n))) return cb({ error: 'Senden yüksek ya da eşit birinin rollerini değiştiremezsin' });
    let n = 0;
    for (const name of addL) if (mem.has(name)) { const l = (s.memberRoles[name] ||= []); if (!l.includes(r.id)) { l.push(r.id); n++; } }
    for (const name of remL) { const l = s.memberRoles[name]; if (l?.includes(r.id)) { s.memberRoles[name] = l.filter(x => x !== r.id); if (!s.memberRoles[name].length) delete s.memberRoles[name]; n++; } }
    if (n) { audit(s, me, 'Rol üyelerini düzenledi', `${r.name} · ${n} değişiklik`); pushSrv(s); }
    cb({ ok: true, changed: n });
  });
  // Sesli oda moderasyonu: sunucuda sustur, bağlantıyı kes, başka odaya taşı
  socket.on('voiceMod', ({ serverId, name, action, to } = {}, cb = () => {}) => {
    const s = db.servers.find(x => x.id === serverId); if (!me || !s) return cb({ error: 'Yetkin yok' });
    cb(voiceModDo(s, me, name, action, to));
  });
  socket.on('memberRoles', ({ serverId, name, roles } = {}, cb = () => {}) => {
    const s = permServer(serverId, 'manageRoles'); if (!s || !roleTarget(s, name)) return cb({ error: 'Yetkin yok' });
    if (name === s.owner && me !== s.owner) return cb({ error: 'Sunucu sahibinin rollerini sadece kendisi değiştirebilir' });
    if (name !== me && name !== BOT_NAME && !outranks(s, me, name)) return cb({ error: 'Senden yüksek ya da eşit birinin rollerini değiştiremezsin' });
    const old = s.memberRoles[name] || [];
    const want = (roles || []).filter(rid => s.customRoles.some(r => r.id === rid && !r.bot));
    for (const rid of new Set([...old, ...want])) if (old.includes(rid) !== want.includes(rid) && !outranksRole(s, s.customRoles.find(r => r.id === rid))) return cb({ error: 'Senden yüksek bir rolü veremez/alamazsın' });
    if (want.length) s.memberRoles[name] = want; else delete s.memberRoles[name];
    audit(s, me, 'Rollerini değiştirdi', name); pushSrv(s); botMember(s, name, 'update'); cb({ ok: true });
  });
  socket.on('channelSave', ({ serverId, channelId, name, cat, perms, sync, topic, slow, limit, bitrate, news, icon, color, font } = {}, cb = () => {}) => {
    const s = permServer(serverId, 'manageChannels'); if (!s) return cb({ error: 'Oda yönetme yetkin yok' });
    const c = s.channels.find(x => x.id === channelId); if (!c) return cb({ error: 'Oda bulunamadı' });
    if (name !== undefined) { name = clean(name, 30); if (c.type === 'text' || c.type === 'forum') name = name.toLowerCase().replace(/\s+/g, '-'); if (name) c.name = name; }
    if (cat !== undefined) {
      const k = cat && s.categories.find(x => x.id === cat);
      if (cat && !k) return cb({ error: 'Kategori bulunamadı' });
      if ((c.cat || null) !== (k?.id || null)) { c.cat = k?.id || undefined; if (!k) c.sync = false; placeInCat(s, c, k); }
    }
    if (icon !== undefined) {
      if (!CHICON.allowed(s) && icon) return cb({ error: perkErr('chIcon') });
      const r = CHICON.clean(s, icon); if (r.error) return cb({ error: r.error });
      if ((c.icon || undefined) !== r.v) { if (r.v) c.icon = r.v; else delete c.icon; audit(s, me, r.v ? 'Oda simgesini değiştirdi' : 'Oda simgesini kaldırdı', c.name); }
    }
    if (color !== undefined) { if (color && !perkOn(s, 'chColor')) return cb({ error: perkErr('chColor') }); if (color) { if (!HEX.test(color)) return cb({ error: 'Geçersiz renk' }); c.color = color; } else delete c.color; }
    if (font !== undefined) { if (font && !perkOn(s, 'chFont')) return cb({ error: perkErr('chFont') }); if (font && FONT_IDS.includes(font)) c.font = font; else delete c.font; }
    if (topic !== undefined) c.topic = clean(topic, 160);
    if (slow !== undefined) c.slow = [0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 3600].includes(+slow) ? +slow : 0;
    if (limit !== undefined) c.limit = Math.max(0, Math.min(99, parseInt(limit) || 0));
    if (bitrate !== undefined) { if (bitrate === 'studio' && !energyPerk(s, 'studio')) return cb({ error: 'Stüdyo ses kalitesi Energy Level 2 ile açılır' }); c.bitrate = ['high', 'studio'].includes(bitrate) ? bitrate : 'std'; }
    if (news !== undefined && c.type === 'text') { c.news = !!news; if (!c.news) c.followers = []; }
    if (sync === true && catOf(s, c)) { audit(s, me, 'Odayı kategoriyle eşitledi', '#' + c.name); c.sync = true; c.perms = {}; }
    else if (perms !== undefined) { const np = cleanPerms(s, perms), d = permDiff(s, ovOf(s, c), np); if (d) audit(s, me, 'İzinleri değiştirdi', `#${c.name}: ${d}`); c.perms = np; c.sync = false; }
    if (s.owner === me) setupOf(s).channels = true;
    audit(s, me, 'Odayı düzenledi', c.name); save(); pushSrv(s); chEvent(s, 'ODA_GUNCELLENDI', c); cb({ ok: true });
  });
  socket.on('chDuplicate', ({ serverId, channelId } = {}, cb = () => {}) => {
    const s = permServer(serverId, 'manageChannels'); if (!s) return cb({ error: 'Oda yönetme yetkin yok' });
    const c = s.channels.find(x => x.id === channelId); if (!c) return cb({ error: 'Oda bulunamadı' });
    if (s.channels.length >= 200) return cb({ error: 'En fazla 200 oda olabilir' });
    const n = { ...JSON.parse(JSON.stringify(c)), id: id(), name: clean(c.name + (c.type === 'text' || c.type === 'forum' ? '-kopya' : ' kopya'), 30), followers: [] };
    s.channels.splice(s.channels.indexOf(c) + 1, 0, n);
    audit(s, me, 'Odayı çoğalttı', c.name); save(); pushSrv(s); cb({ ok: true, id: n.id });
  });
  socket.on('stageHand', (on, cb = () => {}) => {
    const f = myVoice && findChannel(myVoice); if (!f || f.c.type !== 'stage') return cb({ error: 'Sahnede değilsin' });
    const st = stageOf(myVoice); on ? st.hands.add(me) : st.hands.delete(me);
    io.to('v:' + myVoice).emit('stage', { ch: myVoice, ...stageView(myVoice) }); cb({ ok: true });
  });
  socket.on('stageSpeaker', ({ name, on } = {}, cb = () => {}) => {
    const f = myVoice && findChannel(myVoice); if (!f || f.c.type !== 'stage') return cb({ error: 'Sahnede değilsin' });
    const mod = f.s.owner === me || can(f.s, me, 'manageChannels') || chPermWith(f.s, ovOf(f.s, f.c), me, 'manage');
    if (!mod && !(name === me && !on)) return cb({ error: 'Sahne yönetme yetkin yok' });
    const st = stageOf(myVoice); if (on) { st.speakers.add(name); st.hands.delete(name); } else st.speakers.delete(name);
    io.to('v:' + myVoice).emit('stage', { ch: myVoice, ...stageView(myVoice) });
    pushServers(membersOf(f.s)); cb({ ok: true });
  });
  socket.on('newsFollow', ({ srcId, dstId, off } = {}, cb = () => {}) => {
    const src = findChannel(srcId); if (!src || !src.c.news || !seesChannel(src.s, src.c, me) || !(src.s.public || src.s.members.includes(me))) return cb({ error: 'Duyuru odası bulunamadı' });
    const dst = findChannel(dstId); if (!dst || dst.c.type !== 'text' || !can(dst.s, me, 'manageChannels') && dst.s.owner !== me) return cb({ error: 'Hedef odayı yönetme yetkin yok' });
    if (dst.c.id === src.c.id) return cb({ error: 'Aynı odayı takip edemezsin' });
    src.c.followers ||= [];
    src.c.followers = src.c.followers.filter(x => x.c !== dst.c.id);
    if (!off) { if (src.c.followers.length >= 50) return cb({ error: 'Bu oda en fazla 50 yerden takip edilebilir' }); src.c.followers.push({ s: dst.s.id, c: dst.c.id }); audit(dst.s, me, 'Duyuru takip etti', `${src.s.name} #${src.c.name} → #${dst.c.name}`); }
    save(); pushServers(membersOf(src.s)); cb({ ok: true });
  });
  socket.on('catSave', ({ serverId, catId, name, perms } = {}, cb = () => {}) => {
    const s = permServer(serverId, 'manageChannels'); if (!s) return cb({ error: 'Kategori yönetme yetkin yok' });
    let k = catId && s.categories.find(x => x.id === catId);
    if (catId && !k) return cb({ error: 'Kategori bulunamadı' });
    if (name !== undefined) { name = clean(name, 30); if (!name) return cb({ error: 'Kategori adı gerekli' }); }
    if (!k) { if (s.categories.length >= 50) return cb({ error: 'En fazla 50 kategori olabilir' }); k = { id: id(), name: name || 'Yeni kategori', perms: {} }; s.categories.push(k); audit(s, me, 'Kategori oluşturdu', k.name); }
    else if (name) k.name = name;
    if (perms !== undefined) { const np = cleanPerms(s, perms), d = permDiff(s, k.perms || {}, np); if (d) audit(s, me, 'Kategori izinlerini değiştirdi', `${k.name}: ${d}`); k.perms = np; }
    if (s.owner === me) setupOf(s).channels = true;
    save(); pushSrv(s); cb({ ok: true, id: k.id });
  });
  socket.on('catDelete', ({ serverId, catId } = {}, cb = () => {}) => {
    const s = permServer(serverId, 'manageChannels'); if (!s) return cb({ error: 'Kategori yönetme yetkin yok' });
    const k = s.categories.find(x => x.id === catId); if (!k) return cb({ error: 'Kategori bulunamadı' });
    for (const c of s.channels) if (c.cat === k.id) { if (c.sync) { c.perms = { ...(k.perms || {}) }; c.sync = false; } delete c.cat; }
    s.categories = s.categories.filter(x => x !== k);
    s.channels = [...s.channels.filter(c => !c.cat), ...s.channels.filter(c => c.cat)];
    audit(s, me, 'Kategoriyi sildi', k.name); save(); pushSrv(s); cb({ ok: true });
  });
  // Sürükle-bırak sonrası tüm düzen: { top: [odaId], cats: [{ id, channels: [odaId] }] }
  socket.on('chLayout', ({ serverId, top, cats } = {}, cb = () => {}) => {
    const s = permServer(serverId, 'manageChannels'); if (!s) return cb({ error: 'Oda yönetme yetkin yok' });
    if (!Array.isArray(top) || !Array.isArray(cats)) return cb({ error: 'Geçersiz düzen' });
    const allIds = [...top, ...cats.flatMap(k => k.channels || [])], have = new Set(s.channels.map(c => c.id));
    if (allIds.length !== have.size || new Set(allIds).size !== have.size || allIds.some(x => !have.has(x))) return cb({ error: 'Düzen güncel değil, yenile' });
    const catIds = cats.map(k => k.id);
    if (catIds.length !== s.categories.length || catIds.some(x => !s.categories.some(k => k.id === x))) return cb({ error: 'Düzen güncel değil, yenile' });
    const byId = Object.fromEntries(s.channels.map(c => [c.id, c]));
    const moved = [];
    for (const x of top) { const c = byId[x]; if (c.cat) { moved.push(c); delete c.cat; if (c.sync) { c.perms = { ...(catOf(s, c)?.perms || {}) }; c.sync = false; } } }
    for (const k of cats) for (const x of k.channels) { const c = byId[x]; if (c.cat !== k.id) { if (c.sync && c.cat) { c.perms = { ...(catOf(s, c)?.perms || {}) }; c.sync = false; } c.cat = k.id; moved.push(c); } }
    s.categories = catIds.map(x => s.categories.find(k => k.id === x));
    s.channels = allIds.map(x => byId[x]);
    if (s.owner === me) setupOf(s).channels = true;
    save(); pushSrv(s); cb({ ok: true });
  });
  socket.on('channelMove', ({ serverId, channelId, dir } = {}, cb = () => {}) => {
    const s = permServer(serverId, 'manageChannels'); if (!s) return cb({ error: 'Yetkin yok' });
    const i = s.channels.findIndex(x => x.id === channelId), j = i + (dir < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= s.channels.length) return cb({ ok: true });
    [s.channels[i], s.channels[j]] = [s.channels[j], s.channels[i]]; if (s.owner === me) setupOf(s).channels = true; save(); pushSrv(s); cb({ ok: true });
  });
  socket.on('timeout', ({ serverId, name, minutes } = {}, cb = () => {}) => {
    const s = permServer(serverId, 'timeout'); if (!s) return cb({ error: 'Susturma yetkin yok' });
    if (!membersOf(s).includes(name) || name === me || !outranks(s, me, name)) return cb({ error: 'Bu kişiyi susturamazsın' });
    minutes = [0, 1, 5, 10, 60, 1440, 10080].includes(+minutes) ? +minutes : 10;
    if (minutes) s.timeouts[name] = Date.now() + minutes * 60e3; else delete s.timeouts[name];
    audit(s, me, minutes ? 'Susturdu' : 'Susturmayı kaldırdı', minutes ? `${name} · ${minutes >= 1440 ? minutes / 1440 + ' gün' : minutes >= 60 ? minutes / 60 + ' saat' : minutes + ' dk'}` : name);
    if (minutes) io.to('user:' + name).emit('toast', `${s.name} sunucusunda ${minutes >= 60 ? Math.round(minutes / 60) + ' saat' : minutes + ' dakika'} susturuldun`);
    pushSrv(s); cb({ ok: true });
  });
  socket.on('ban', ({ serverId, name, reason, unban } = {}, cb = () => {}) => {
    const s = permServer(serverId, 'ban'); if (!s) return cb({ error: 'Yasaklama yetkin yok' });
    if (s.public) return cb({ error: 'Herkese açık sunucuda yasak yok' });
    if (unban) { delete s.bans[name]; audit(s, me, 'Yasağı kaldırdı', name); pushSrv(s); return cb({ ok: true }); }
    if (!db.users[name] || name === me || !outranks(s, me, name)) return cb({ error: 'Bu kişiyi yasaklayamazsın' });
    if (nukeCheck(s, me, 'yasaklama')) return cb({ error: 'Kanka Bot: Kısa sürede çok fazla yasaklama yaptın, işlem durduruldu.' });
    s.bans[name] = { by: me, time: Date.now(), reason: clean(reason, 120) };
    s.members = s.members.filter(n => n !== name); wipeMember(s, name);
    audit(s, me, 'Yasakladı', name + (reason ? ' · ' + clean(reason, 120) : ''));
    voiceKick(s.channels.map(c => c.id), name, 'Sunucudan yasaklandın');
    save(); pushServers([name, ...s.members]);
    io.to('user:' + name).emit('toast', `${s.name} sunucusundan yasaklandın`); botMember(s, name, 'leave', { by: me, islem: 'yasaklandi', sebep: clean(reason, 120) });
    cb({ ok: true });
  });
  socket.on('kick', ({ serverId, name } = {}, cb = () => {}) => {
    const s = adminServer(serverId, false); if (!s) return cb({ error: 'Yetkin yok' });
    if (s.public) return cb({ error: 'Herkese açık sunucudan kimse atılamaz' });
    if (name === s.owner || !can(s, me, 'kick') || !outranks(s, me, name)) return cb({ error: 'Bu kişiyi atamazsın' });
    if (nukeCheck(s, me, 'üye atma')) return cb({ error: 'Kanka Bot: Kısa sürede çok fazla üye attın, işlem durduruldu.' });
    s.members = s.members.filter(n => n !== name); wipeMember(s, name);
    audit(s, me, 'Sunucudan attı', name);
    voiceKick(s.channels.map(c => c.id), name, 'Sunucudan çıkarıldın');
    save(); pushServers([name, ...s.members]);
    io.to('user:' + name).emit('toast', `${s.name} sunucusundan çıkarıldın`); botMember(s, name, 'leave', { by: me, islem: 'atildi' });
    cb({ ok: true });
  });
  socket.on('deleteChannel', ({ serverId, channelId } = {}, cb = () => {}) => {
    const s = adminServer(serverId, false); if (!s) return cb({ error: 'Yetkin yok' });
    const c = s.channels.find(c => c.id === channelId);
    if (!c) return cb({ error: 'Oda bulunamadı' });
    cb(removeChannel(s, me, c));
  });
  socket.on('renameChannel', ({ serverId, channelId, name } = {}, cb = () => {}) => {
    const s = adminServer(serverId, false); if (!s) return cb({ error: 'Yetkin yok' });
    const c = s.channels.find(c => c.id === channelId); name = clean(name, 30);
    if (!c || !name) return cb({ error: 'Geçersiz' });
    audit(s, me, 'Oda adını değiştirdi', `${c.name} → ${name}`);
    c.name = c.type === 'text' ? name.toLowerCase().replace(/\s+/g, '-') : name;
    save(); pushServers(membersOf(s)); cb({ ok: true });
  });

  // ----- Arkadaşlar -----
  const U = n => { const u = db.users[n]; if (u) { u.friends ||= []; u.reqIn ||= []; u.reqOut ||= []; u.blocked ||= []; } return u; };
  const pull = (arr, n) => { const i = arr.indexOf(n); if (i >= 0) arr.splice(i, 1); };
  // ---- Tanıyor olabileceğin kişiler: ortak arkadaş, ortak (özel) sunucu, sohbet ettiğin ama arkadaş olmadığın kişiler ----
  // Yaş grubu farklıysa (18 altı / 18 üstü) önerilmez. "Gösterme" denenler bir daha çıkmaz.
  socket.on('friendSuggest', (_ = {}, cb = () => {}) => {
    const u = db.users[me]; if (!u) return cb({ error: 'Giriş yap' });
    if (limited('fsug|' + me, 30, 60e3)) return cb({ error: 'Biraz bekle' });
    const minor = isMinor(u), skip = new Set([me, BOT_NAME, ...(u.friends || []), ...(u.reqOut || []), ...(u.reqIn || []), ...(u.blocked || []), ...(u.fsHide || [])]);
    const ok = n => { const x = db.users[n]; return !!x && !x.bot && !skip.has(n) && !(x.blocked || []).includes(me) && !x.banned && isMinor(x) === minor; };
    const chatted = [];
    for (const d of dmsFor(me)) if (!d.group && ok(d.with)) { const l = msgRaw[d.id] || []; const both = l.some(m => m.author === me) && l.some(m => m.author === d.with); if (both) chatted.push({ name: d.with, last: d.last, n: l.length }); }
    chatted.sort((a, b) => b.last - a.last);
    const servers = new Map(), friendsOf = new Map();
    for (const sv of db.servers) if (!sv.public && sv.members.includes(me) && sv.members.length <= 2000) for (const n of sv.members) if (ok(n)) (servers.get(n) || servers.set(n, []).get(n)).push({ id: sv.id, ad: sv.name });
    for (const f of u.friends || []) for (const n of db.users[f]?.friends || []) if (ok(n)) friendsOf.set(n, (friendsOf.get(n) || 0) + 1);
    const seen = new Set(chatted.map(c => c.name));
    const cand = [...new Set([...servers.keys(), ...friendsOf.keys()])].filter(n => !seen.has(n)).map(n => {
      const sv = servers.get(n) || [], mf = friendsOf.get(n) || 0;
      return { name: n, sunucular: sv.slice(0, 3), sunucuSayisi: sv.length, ortakArkadas: mf, puan: mf * 3 + Math.min(sv.length, 5) * 2 + (isOnlineName(n) ? 1 : 0) };
    }).sort((a, b) => b.puan - a.puan).slice(0, 30);
    // Zevkine göre: dinlediğin müzik, oynadığın oyunlar ve Arena (sadece aynı yaş grubundan, son 30 günde aktif olanlar)
    let uyumlu = [];
    if (!u.matchOff && STAT.on()) {
      const me_ = tasteOf(me);
      if (me_.art.size || me_.game.size || me_.arena.size) {
        const cutoff = Date.now() - 30 * 864e5;
        uyumlu = Object.values(db.users).filter(x => ok(x.name) && !seen.has(x.name) && !x.matchOff && !x.wrapOff && Math.max(Date.parse(x.streak?.last || "") || 0, x.auto?.at || 0, x.createdAt || 0) > cutoff)
          .map(x => { const c = compat(me, x.name); return c && c.uyum >= 25 && c.neden ? { name: x.name, ...c } : null; }).filter(Boolean)
          .sort((a, b) => b.uyum - a.uyum).slice(0, 12);
        const um = new Map(uyumlu.map(x => [x.name, x]));
        for (const c of cand) { const x = um.get(c.name) || compat(me, c.name); if (x) { c.uyum = x.uyum; c.neden = x.neden; } }
      }
    }
    cb({ ok: true, sohbet: chatted.slice(0, 8).map(c => ({ name: c.name, last: c.last, n: c.n })), oneriler: cand, uyumlu, zevkYok: !u.matchOff && !uyumlu.length && !tasteOf(me).art.size && !tasteOf(me).game.size });
  });
  // Profilde: "Müzik uyumunuz %74" (yaş grubu farklıysa ya da biri kapattıysa gösterilmez)
  socket.on('compat', (name, cb = () => {}) => {
    if (typeof cb !== 'function') return; const u = db.users[me], o = typeof name === 'string' && db.users[name];
    if (!u || !o || name === me || o.bot || isMinor(u) !== isMinor(o) || (o.blocked || []).includes(me)) return cb(null);
    if (limited('cmp|' + me, 60, 60e3)) return cb(null);
    cb(compat(me, name));
  });
  // Gizlilik: yıllık özet için sayma (Wrapped) ve zevk eşleşmesi ayrı ayrı kapatılabilir
  socket.on('statPrefs', ({ wrapOff, matchOff, wipe } = {}, cb = () => {}) => {
    const u = db.users[me]; if (!u) return cb({ error: 'Giriş yap' });
    if (typeof wrapOff === 'boolean') u.wrapOff = wrapOff || undefined;
    if (typeof matchOff === 'boolean') u.matchOff = matchOff || undefined;
    if (wipe === true) STAT.wipe(me);
    tasteCache.delete(me); save(); cb({ ok: true, wrapOff: !!u.wrapOff, matchOff: !!u.matchOff });
  });
  socket.on('friendSuggestHide', (name, cb = () => {}) => {
    const u = db.users[me]; if (!u || typeof name !== 'string' || !db.users[name]) return cb({ error: 'Bulunamadı' });
    u.fsHide = [...new Set([...(u.fsHide || []), name])].slice(-300); save(); cb({ ok: true });
  });
  socket.on('friendRequest', (name, cb = () => {}) => {
    if (limited('fr|' + me, 20, 3600e3)) return cb({ error: 'Çok fazla istek gönderdin, sonra tekrar dene' });
    const a = U(me), b = U(name);
    if (!a || !b || name === me) return cb({ error: 'Kullanıcı bulunamadı' });
    if (a.friends.includes(name)) return cb({ error: 'Zaten arkadaşsınız' });
    if (b.blocked.includes(me)) return cb({ error: 'Bu kişiye istek gönderilemiyor' });
    if (a.reqIn.includes(name)) { // karşı taraf zaten istek göndermişse kabul et
      pull(a.reqIn, name); pull(b.reqOut, me); a.friends.push(name); b.friends.push(me);
      save(); pushSocial(me, name); pushUsers();
      io.to('user:' + name).emit('toast', `${me} arkadaşlık isteğini kabul etti`);
    sendPush(name, { title: me, body: 'arkadaşlık isteğini kabul etti 🎉', tag: 'friends', friend: true, from: me });
      return cb({ ok: true, accepted: true });
    }
    if (!a.reqOut.includes(name)) { a.reqOut.push(name); b.reqIn.push(me); }
    save(); pushSocial(me, name);
    notifyUser(name, { from: me, text: 'sana arkadaşlık isteği gönderdi', where: 'Arkadaşlar', friend: true });
    cb({ ok: true });
  });
  socket.on('friendAccept', (name, cb = () => {}) => {
    const a = U(me), b = U(name);
    if (!a || !b || !a.reqIn.includes(name)) return cb({ error: 'İstek bulunamadı' });
    pull(a.reqIn, name); pull(b.reqOut, me); a.friends.push(name); b.friends.push(me);
    save(); pushSocial(me, name); pushUsers();
    io.to('user:' + name).emit('toast', `${me} arkadaşlık isteğini kabul etti`);
    onbFlag(me, 'invite'); onbFlag(name, 'invite'); cb({ ok: true });
  });
  socket.on('friendRemove', (name, cb = () => {}) => { // arkadaşlıktan çıkar / isteği reddet / isteği geri çek
    const a = U(me), b = U(name); if (!a || !b) return cb({ error: 'Kullanıcı bulunamadı' });
    pull(a.friends, name); pull(b.friends, me); pull(a.reqIn, name); pull(a.reqOut, name); pull(b.reqIn, me); pull(b.reqOut, me);
    save(); pushSocial(me, name); pushUsers(); cb({ ok: true });
  });
  socket.on('block', ({ name, on } = {}, cb = () => {}) => {
    const a = U(me), b = U(name); if (!a || !b || name === me) return cb({ error: 'Kullanıcı bulunamadı' });
    if (on) {
      if (!a.blocked.includes(name)) a.blocked.push(name);
      pull(a.friends, name); pull(b.friends, me); pull(a.reqIn, name); pull(a.reqOut, name); pull(b.reqIn, me); pull(b.reqOut, me);
    } else pull(a.blocked, name);
    save(); pushSocial(me, name); pushUsers(); cb({ ok: true });
  });

  // Yuva (ana sayfa) özeti: bu haftaki ses süresi gün gün, geçen haftanın toplamı, Kanka HQ sıralaması
  socket.on('yuva', (cb = () => {}) => {
    const u = db.users[me]; if (!u) return cb(null);
    const now = new Date(Date.now() + 3 * 3600e3), dow = (now.getUTCDay() + 6) % 7; // 0 = Pazartesi
    const day = i => u.vmin?.[dayKeyTR(Date.now() - (dow - i) * 864e5)] || 0;
    const week = [0, 1, 2, 3, 4, 5, 6].map(i => i <= dow ? day(i) : null);
    const last = [0, 1, 2, 3, 4, 5, 6].reduce((a, i) => a + (u.vmin?.[dayKeyTR(Date.now() - (dow + 7 - i) * 864e5)] || 0), 0);
    const hq = db.servers.find(x => x.id === 's1');
    let rank = null; if (hq) { const xp = u.xp || 0; rank = 1 + membersOf(hq).reduce((a, n) => a + ((db.users[n]?.xp || 0) > xp ? 1 : 0), 0); }
    const ps = db.servers.filter(x => isStar(x) && !x.bans?.[me]).sort((a, b) => a.id < b.id ? -1 : 1);
    let potw = null; if (ps.length) { const x = ps[Math.floor(Date.now() / (7 * 864e5)) % ps.length], mem = membersOf(x), on = new Set(onlineNames());
      potw = { id: x.id, name: x.name, icon: x.icon, iconImg: x.iconImg || null, banner: x.banner || null, bannerColor: x.bannerColor || null, description: x.description || '', members: mem.length, online: mem.filter(n => on.has(n)).length, invite: x.invite, joined: mem.includes(me) }; }
    cb({ week, today: dow, last, rank, potw });
  });
  // Yuva sağ panel: Kanka HQ'da en yüksek seviye ve en uzun seri
  socket.on('hqTops', (cb = () => {}) => {
    const hq = db.servers.find(x => x.id === 's1'); if (!hq || !me) return cb(null);
    const us = membersOf(hq).map(n => db.users[n]).filter(u => u && !u.siteBan), row = u => ({ name: u.name, level: level(u.xp), xp: u.xp || 0, streak: u.streak?.count || 0 });
    const lvl = [...us].sort((a, b) => (b.xp || 0) - (a.xp || 0)).slice(0, 10).map(row);
    const stk = us.filter(u => (u.streak?.count || 0) > 0).sort((a, b) => (b.streak?.count || 0) - (a.streak?.count || 0) || (b.xp || 0) - (a.xp || 0)).slice(0, 10).map(row);
    const meU = db.users[me], myL = 1 + us.filter(u => (u.xp || 0) > (meU.xp || 0)).length, myS = 1 + us.filter(u => (u.streak?.count || 0) > (meU.streak?.count || 0)).length;
    cb({ lvl, stk, me: { ...row(meU), lvlRank: myL, stkRank: myS } });
  });
  socket.on('leaderboard', (serverId, cb) => {
    const s = db.servers.find(x => x.id === serverId);
    if (!s || !(s.public || s.members.includes(me))) return cb([]);
    if (!s.public && s.levels?.on !== false) { const X = s.xp || {}, all = membersOf(s).filter(n => db.users[n]).sort((a, b) => (X[b] || 0) - (X[a] || 0));
      return cb(all.slice(0, 25).map(n => ({ name: n, xp: X[n] || 0, level: level(X[n]), streak: db.users[n].streak?.count || 0, srv: true })).concat(all.indexOf(me) >= 25 ? [{ name: me, xp: X[me] || 0, level: level(X[me]), rank: all.indexOf(me) + 1, srv: true, me: true }] : [])); }
    cb(membersOf(s).map(n => db.users[n]).filter(Boolean).sort((a, b) => (b.xp || 0) - (a.xp || 0)).slice(0, 25)
      .map(u => ({ name: u.name, xp: u.xp || 0, level: level(u.xp), streak: u.streak?.count || 0 })));
  });

  // ----- Özel emojiler -----
  socket.on('addEmoji', ({ serverId, name, url } = {}, cb = () => {}) => {
    const s = adminServer(serverId, false) || permServer(serverId, 'manageEmojis'); if (!s) return cb({ error: 'Emoji eklemek için emoji yönetme yetkin olmalı' });
    name = clean(name, 24).toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (name.length < 2) return cb({ error: 'Emoji adı en az 2 karakter olmalı (a-z, 0-9, _)' });
    if (!UPLOAD_RE.test(url || '')) return cb({ error: 'Geçersiz resim' });
    s.emojis ||= {};
    if (Object.keys(s.emojis).length >= emojiLimit(s)) return cb({ error: emojiLimit(s) < 200 ? `En fazla ${emojiLimit(s)} özel emoji eklenebilir. Yükselen sunucular 100, Kanka Partner sunucular 200 emoji ekleyebilir.` : `En fazla ${emojiLimit(s)} özel emoji eklenebilir` });
    s.emojis[name] = url;
    s.emojiMeta ||= {}; s.emojiMeta[name] = { by: me, at: Date.now() };
    audit(s, me, 'Emoji ekledi', ':' + name + ':');
    save(); pushServers(membersOf(s)); cb({ ok: true });
  });
  socket.on('editEmoji', ({ serverId, name, to, url } = {}, cb = () => {}) => {
    const s = adminServer(serverId, false) || permServer(serverId, 'manageEmojis'); if (!s || !s.emojis?.[name]) return cb({ error: 'Yetkin yok' });
    to = clean(to, 24).toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (to.length < 2) return cb({ error: 'Emoji adı en az 2 karakter olmalı (a-z, 0-9, _)' });
    if (to !== name && s.emojis[to]) return cb({ error: 'Bu adda bir emoji zaten var' });
    if (url && !UPLOAD_RE.test(url)) return cb({ error: 'Geçersiz resim' });
    if (to !== name) {
      s.emojis[to] = url || s.emojis[name]; delete s.emojis[name];
      if (s.emojiMeta?.[name]) { s.emojiMeta[to] = s.emojiMeta[name]; delete s.emojiMeta[name]; }
    } else if (url) s.emojis[to] = url;
    if (to !== name || url) {
      audit(s, me, 'Emoji düzenledi', ':' + name + ':' + (to !== name ? ' → :' + to + ':' : '') + (url ? ' (görsel güncellendi)' : ''));
      save(); pushServers(membersOf(s));
    }
    cb({ ok: true, name: to });
  });
  socket.on('removeEmoji', ({ serverId, name } = {}, cb = () => {}) => {
    const s = adminServer(serverId, false) || permServer(serverId, 'manageEmojis'); if (!s || !s.emojis?.[name]) return cb({ error: 'Yetkin yok' });
    delete s.emojis[name]; if (s.emojiMeta) delete s.emojiMeta[name];
    audit(s, me, 'Emoji sildi', ':' + name + ':');
    save(); pushServers(membersOf(s)); cb({ ok: true });
  });
  socket.on('audit', (serverId, cb) => {
    const s = adminServer(serverId, false) || permServer(serverId, 'viewAudit'); cb(s ? (s.audit || []).slice(0, 100) : []);
  });

  // ----- Konular -----
  socket.on('threadReply', ({ msgId, text } = {}, cb = () => {}) => {
    if (!canAccess(me, cur)) return cb({ error: 'Erişim yok' });
    { const fl = msgFlood(me); if (fl) return cb({ error: fl }); }
    const msg = findMsg(cur, msgId); text = cleanMsg(text);
    if (!msg || !text || msg.kind === 'system') return cb({ error: 'Gönderilemedi' });
    if (db.e2e?.[cur]?.eps?.length) return cb({ error: 'Şifreli sohbette konu açılamıyor' });
    { const f = findChannel(cur); if (f && (!chPerm(f.s, f.c, me, 'send') && f.c.type !== 'forum' || !chPerm(f.s, f.c, me, 'thread'))) return cb({ error: 'Bu odada yanıt dizisine yazma iznin yok' }); if (f && timedOut(f.s, me)) return cb({ error: 'Susturuldun' }); }
    if (serverOf(cur)?.filter) text = filterText(text);
    (msg.thread ||= []).push({ id: id(), author: me, text, time: Date.now() });
    if (msg.thread.length > 300) msg.thread.shift();
    update(cur, msg);
    const who = new Set([msg.author, ...msg.thread.map(t => t.author)]); who.delete(me);
    for (const n of who) notifyUser(n, { from: me, text: `konuda yanıtladı: ${text.slice(0, 80)}`, channelId: cur, where: 'Konu', mention: true });
    cb({ ok: true });
  });

  // ----- Zamanlanmış mesajlar -----
  socket.on('schedule', ({ text, at } = {}, cb = () => {}) => {
    if (!canAccess(me, cur)) return cb({ error: 'Erişim yok' });
    text = cleanMsg(text); at = +at;
    if (!text) return cb({ error: 'Mesaj boş olamaz' });
    if (db.e2e?.[cur]?.eps?.length) return cb({ error: 'Şifreli sohbette zamanlanmış mesaj yok (sunucu metni görmesin diye)' });
    { const g = postGate(me, cur, text); if (g) return cb({ error: g }); }
    if (!(at > Date.now() + 30e3) || at > Date.now() + 30 * 864e5) return cb({ error: 'Zaman en az 1 dakika sonra, en fazla 30 gün içinde olmalı' });
    db.scheduled ||= [];
    if (db.scheduled.filter(x => x.author === me).length >= 20) return cb({ error: 'En fazla 20 zamanlanmış mesajın olabilir' });
    db.scheduled.push({ id: id(), chId: cur, author: me, text, at }); save();
    cb({ ok: true, list: db.scheduled.filter(x => x.author === me) });
  });
  socket.on('scheduledList', cb => cb((db.scheduled || []).filter(x => x.author === me)));
  socket.on('unschedule', (sid, cb = () => {}) => {
    db.scheduled = (db.scheduled || []).filter(x => !(x.id === sid && x.author === me)); save();
    cb((db.scheduled || []).filter(x => x.author === me));
  });

  // ----- Etkinlik -----
  socket.on('presenceKey', ({ renew } = {}, cb = () => {}) => {
    const u = db.users[me]; if (!u) return;
    if (!u.presenceKey || renew) { if (u.presenceKey) presIdx.delete(u.presenceKey); u.presenceKey = crypto.randomBytes(18).toString('hex'); presIdx.set(u.presenceKey, u.name); save(); }
    cb({ key: u.presenceKey, connected: !!(u.auto && Date.now() - u.auto.at < 45e3) });
  });

  // ----- Ses: konuşma göstergesi -----
  socket.on('media', st => {
    if (!myVoice) return;
    const was = voiceMedia.get(socket.id)?.screen, now = { cam: !!st?.cam, screen: !!st?.screen };
    { const f = findChannel(myVoice);
      if (f && now.cam && !chPerm(f.s, f.c, me, 'video')) { socket.emit('toast', 'Bu odada kamera açma iznin yok'); now.cam = false; }
      if (f && now.screen && !chPerm(f.s, f.c, me, 'stream')) { socket.emit('toast', 'Bu odada ekran paylaşma iznin yok'); now.screen = false; } }
    voiceMedia.set(socket.id, now);
    if (now.screen) { const lm = liveMeta.get(socket.id) || { since: Date.now() }; Object.assign(lm, { q: clean(st?.q, 12), viewers: Math.min(+st?.viewers || 0, 99), audio: !!st?.audio }); liveMeta.set(socket.id, lm); }
    else liveMeta.delete(socket.id);
    socket.to('v:' + myVoice).emit('media', { sid: socket.id, name: me, ...now, streamId: clean(st?.streamId, 80), viewers: Math.min(+st?.viewers || 0, 99), q: clean(st?.q, 12), audio: !!st?.audio });
    if (!!was !== now.screen) pushVoice(); else pushFlags();
  });
  // Yayın önizlemesi: yayıncı ~10 sn'de bir küçük bir kare gönderir; odayı görebilenler üstüne gelince görür
  socket.on('liveThumb', data => {
    const lm = liveMeta.get(socket.id); if (!lm || !myVoice) return;
    data = String(data || ''); if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(data) || data.length > 140e3) return;
    if (Date.now() - (lm.thumbAt || 0) < 4000) return;
    lm.thumb = data; lm.thumbAt = Date.now();
  });
  socket.on('liveInfo', ({ name, ch } = {}, cb = () => {}) => {
    if (!me) return cb(null);
    const f = findChannel(ch); if (!f || !chPerm(f.s, f.c, me, 'view')) return cb(null);
    const room = voice.get(ch); if (!room) return cb(null);
    const allowed = myVoice === ch || chPerm(f.s, f.c, me, 'connect'); // odaya girme yetkisi olmayan yayının görüntüsünü göremez
    for (const [sid, n] of room) if (n === name && voiceMedia.get(sid)?.screen) { const lm = liveMeta.get(sid) || {}; return cb(allowed ? { since: lm.since || null, q: lm.q || null, viewers: lm.viewers || 0, audio: !!lm.audio, thumb: lm.thumb || null, thumbAt: lm.thumbAt || null } : { locked: true, since: lm.since || null }); }
    cb(null);
  });
  // Yayın izleme: izleyici yayıncıya "izliyorum / bıraktım" der; yayıncı görüntüyü sadece izleyenlere gönderir
  socket.on('streamWatch', ({ to, on } = {}) => {
    if (!myVoice || !voice.get(myVoice)?.has(to)) return;
    io.to(to).emit('streamWatch', { from: socket.id, name: me, on: !!on });
  });

  socket.on('typing', () => { if (!me || !cur || !canAccess(me, cur)) return; { const f = isPrivateChat(cur) ? null : findChannel(cur); if (f && (timedOut(f.s, me) || !chPerm(f.s, f.c, me, 'send'))) return; } if (limited('typ|' + me, 30, 10e3)) return; socket.to(cur).emit('typing', { channelId: cur, name: me }); });

  // ----- Sunucular -----
  socket.on('createServer', (arg, cb = () => {}) => {
    setTimeout(() => onbAward(me), 800);
    if (!me) return;
    if (limited('srv|' + me, 5, 3600e3)) return cb({ error: 'Bir saatte en fazla 5 sunucu kurabilirsin' });
    const opts = typeof arg === 'string' ? { name: arg } : (arg || {});
    const name = clean(opts.name, 40); if (!name) return cb({ error: 'Sunucu adı gerekli' });
    const tpl = TEMPLATES[opts.template] || TEMPLATES.bos;
    const s = {
      id: id(), name, icon: [...name][0].toUpperCase(), owner: me, members: [me], joinedAt: { [me]: Date.now() }, createdAt: Date.now(), setup: {}, roles: {}, customRoles: [], memberRoles: {}, bans: {}, timeouts: {}, invite: newInviteCode(),
      channels: [], template: opts.template in TEMPLATES ? opts.template : 'bos'
    };
    const finish = () => { db.servers.push(s); save(); pushServers([me]); cb(serverView(s, me)); };
    if (opts.discord) {
      const code = dcCode(opts.discord); if (!code) return cb({ error: 'Geçerli bir şablon linki ya da kodu yaz' });
      return dcFetch(code).then(t => {
        if (t.error) return cb(t);
        const c = dcConvert(t);
        Object.assign(s, { customRoles: c.roles, categories: c.categories, channels: c.channels, template: 'discord', discordTemplate: code });
        if (c.afk) s.afk = c.afk;
        if (c.lockChannels) s.lockChannels = true;
        finish();
      }).catch(e => { console.error('Discord şablonu aktarılamadı', e); cb({ error: 'Şablon aktarılamadı, biraz sonra tekrar dene' }); });
    }
    for (const r of tpl.roles || []) s.customRoles.push({ id: id(), ...r });
    for (const c of tpl.channels) {
      const ch = { id: id(), name: c.n, type: c.v ? 'voice' : 'text' };
      if (c.cat) ch.category = c.cat; if (c.ro) ch.readonly = true; // migrateCats dönüştürür
      if (c.priv) { ch.private = true; ch.allow = s.customRoles.filter(r => c.priv.includes(r.name)).map(r => r.id); }
      s.channels.push(ch);
    }
    migrateCats(s);
    if (tpl.welcome) s.welcome = { enabled: true, message: tpl.welcome.message, rules: [...tpl.welcome.rules],
      channels: tpl.welcome.channels.map(([n, d]) => ({ id: s.channels.find(c => c.name === n)?.id, desc: d })).filter(x => x.id) };
    finish();
  });
  socket.on('discordTemplate', async (link, cb = () => {}) => {
    if (!me) return cb({ error: 'Giriş yap' });
    const code = dcCode(link); if (!code) return cb({ error: 'Geçerli bir şablon linki ya da kodu yaz' });
    if (limited('dctpl|' + me, 20, 600e3)) return cb({ error: 'Çok fazla deneme, biraz bekle' });
    try { const t = await dcFetch(code); cb(t.error ? t : dcPreview(dcConvert(t), code)); }
    catch (e) { console.error('Şablon okunamadı', e); cb({ error: 'Şablon okunamadı, biraz sonra tekrar dene' }); }
  });
  // ----- Mevcut sunucuya şablon uygulama (sadece sahip) -----
  const ownedServer = serverId => { const s = me && db.servers.find(x => x.id === serverId); return s && s.owner === me ? s : null; };
  const tplLoad = async (serverId, link) => {
    if (!ownedServer(serverId)) return { error: 'Şablonu sadece sunucu sahibi uygulayabilir' };
    const code = dcCode(link); if (!code) return { error: 'Geçerli bir şablon linki ya da kodu yaz' };
    if (limited('dctpl|' + me, 20, 600e3)) return { error: 'Çok fazla deneme, biraz bekle' };
    const t = await dcFetch(code); if (t.error) return t;
    const s = ownedServer(serverId); if (!s) return { error: 'Sunucu bulunamadı' };
    s.categories ||= []; s.customRoles ||= []; s.memberRoles ||= {};
    return { s, code, c: dcConvert(t) };
  };
  socket.on('tplPreview', async ({ serverId, link } = {}, cb = () => {}) => {
    try { const r = await tplLoad(serverId, link); if (r.error) return cb(r); const m = dcMerge(r.s, r.c); cb({ name: r.c.name, ...m.diff, skipped: m.skipped }); }
    catch (e) { console.error('Şablon önizlenemedi', e); cb({ error: 'Şablon okunamadı, biraz sonra tekrar dene' }); }
  });
  socket.on('tplApply', async ({ serverId, link } = {}, cb = () => {}) => {
    try {
      const r = await tplLoad(serverId, link); if (r.error) return cb(r);
      const { s, code, c } = r, m = dcMerge(s, c);
      s.tplUndo = { t: Date.now(), code, customRoles: s.customRoles, categories: s.categories, channels: s.channels, afk: s.afk || null, lockChannels: !!s.lockChannels, added: m.added };
      Object.assign(s, { customRoles: m.roles, categories: m.categories, channels: m.channels, afk: m.afk });
      if (m.lockChannels) s.lockChannels = true;
      audit(s, me, 'Şablon uyguladı', `${c.name} · ${m.added.channels.length} oda, ${m.added.categories.length} kategori, ${m.added.roles.length} rol eklendi`);
      pushSrv(s); cb({ ok: true });
    } catch (e) { console.error('Şablon uygulanamadı', e); cb({ error: 'Şablon uygulanamadı, biraz sonra tekrar dene' }); }
  });
  socket.on('tplUndo', ({ serverId } = {}, cb = () => {}) => {
    const s = ownedServer(serverId), u = s?.tplUndo;
    if (!s) return cb({ error: 'Sadece sunucu sahibi geri alabilir' });
    if (!u || Date.now() - u.t > TPL_UNDO_MS) return cb({ error: 'Geri alınacak şablon yok' });
    const addedCh = new Set(u.added.channels), addedK = new Set(u.added.categories), addedR = new Set(u.added.roles);
    const now = new Set(s.channels.map(ch => ch.id)), oldIds = new Set(u.channels.map(ch => ch.id));
    const oldC = u.channels.filter(ch => now.has(ch.id)); // sonradan silinen oda geri gelmez, mesajları gitti
    // Şablonla eklenen odalardan içine mesaj yazılmış olanlar kalır
    const gone = s.channels.filter(ch => addedCh.has(ch.id) && !(msgRaw[ch.id] || []).length);
    if (!oldC.some(ch => ch.type === 'text')) { const i = gone.findIndex(ch => ch.type === 'text'); if (i >= 0) gone.splice(i, 1); }
    const extra = s.channels.filter(ch => !oldIds.has(ch.id) && !gone.includes(ch));
    const curK = new Map(s.categories.map(k => [k.id, k])), oldK = new Set(u.categories.map(k => k.id));
    s.categories = [...u.categories, ...s.categories.filter(k => !oldK.has(k.id) && !addedK.has(k.id))];
    const catIds = new Set(s.categories.map(k => k.id));
    for (const ch of extra) if (ch.cat && !catIds.has(ch.cat)) { if (ch.sync) { ch.perms = { ...(curK.get(ch.cat)?.perms || {}) }; ch.sync = false; } delete ch.cat; }
    const all = [...oldC, ...extra];
    s.channels = [...all.filter(ch => !ch.cat || !catIds.has(ch.cat)), ...s.categories.flatMap(k => all.filter(ch => ch.cat === k.id))];
    const curR = s.customRoles, oldR = new Set(u.customRoles.map(r => r.id));
    s.customRoles = [...u.customRoles.filter(r => !r.bot || curR.some(x => x.id === r.id)), ...curR.filter(r => !oldR.has(r.id) && !addedR.has(r.id))];
    const live = new Set(s.customRoles.map(r => r.id));
    for (const n in s.memberRoles) { s.memberRoles[n] = s.memberRoles[n].filter(x => live.has(x)); if (!s.memberRoles[n].length) delete s.memberRoles[n]; }
    for (const x of [...s.channels, ...s.categories]) for (const t in x.perms || {}) if (addedR.has(t)) delete x.perms[t];
    s.afk = u.afk && s.channels.some(ch => ch.id === u.afk.ch) ? u.afk : null;
    if (u.lockChannels) s.lockChannels = true; else delete s.lockChannels;
    for (const ch of gone) { delete db.messages[ch.id]; delete db.playlists[ch.id]; }
    if (gone.length) voiceKick(gone.map(ch => ch.id), null, 'Bulunduğun ses odası kaldırıldı');
    delete s.tplUndo;
    audit(s, me, 'Şablonu geri aldı', `${gone.length} oda kaldırıldı`);
    pushSrv(s); cb({ ok: true, kept: s.channels.filter(ch => addedCh.has(ch.id)).length });
  });

  socket.on('createChannel', ({ serverId, name, type, cat, private: priv } = {}, cb = () => {}) => {
    const s = db.servers.find(x => x.id === serverId);
    if (!me || !s || !(s.public || s.members.includes(me))) return cb({ error: 'Yetkin yok' });
    if ((s.customRoles?.length || s.lockChannels) && !can(s, me, 'manageChannels')) return cb({ error: 'Oda açma yetkin yok' });
    if (s.owner === me) setupOf(s).channels = true;
    const r = addChannel(s, me, { name, type: ['voice', 'stage', 'forum'].includes(type) ? type : 'text', cat, priv }); if (r.error) return cb(r);
    cb(chView(s, r.c, me, true));
  });
  socket.on('discover', ({ q, cat } = {}, cb = () => {}) => {
    if (!me) return cb([]);
    q = clean(q, 60).toLocaleLowerCase('tr');
    const on = new Set(onlineNames()), W = { resmi: 60, partner: 55, yildiz: 50, dogrulanmis: 20, yukselen: 20, topluluk: 10 };
    const list = db.servers.filter(s => (s.public || s.discoverable) && !s.bans?.[me])
      .filter(s => !cat || s.category === cat)
      .filter(s => !q || s.name.toLocaleLowerCase('tr').includes(q) || (s.description || '').toLocaleLowerCase('tr').includes(q))
      .map(s => { const mem = membersOf(s), b = srvBadges(s); return { id: s.id, name: s.name, icon: s.icon, iconImg: s.iconImg || null, banner: s.banner || null, bannerColor: s.bannerColor || null,
        description: s.description || (s.public ? 'Kanka Chat\'in resmi sunucusu. Duyurular, yenilikler ve sohbet.' : ''), category: s.public ? 'Sohbet' : s.category || 'Diğer', badges: b,
        members: mem.length, online: mem.filter(n => on.has(n)).length, invite: s.invite, joined: s.public || s.members.includes(me), _w: b.reduce((a, x) => a + (W[x.id] || 0), 0) }; })
      .sort((a, b) => b._w - a._w || b.online - a.online || b.members - a.members).slice(0, 60);
    cb({ list, cats: CATS });
  });
  socket.on('acceptRules', (serverId, cb = () => {}, answers) => {
    if (typeof serverId === 'object' && serverId) { answers = serverId.answers; serverId = serverId.serverId; }
    const s = db.servers.find(x => x.id === serverId);
    if (!me || !s || !membersOf(s).includes(me)) return cb({ error: 'Geçersiz' });
    if (s.accepted?.[me]) return cb({ ok: true });
    const g = s.gate || {}, qs = (g.questions || []).filter(Boolean);
    if (s.owner !== me && (qs.length || g.approval)) {
      const ans = qs.map((q, i) => clean(Array.isArray(answers) ? answers[i] : '', 300));
      if (ans.some(a => !a)) return cb({ error: 'Tüm soruları cevapla', needAnswers: true });
      if (g.approval && !isMod(s, me)) {
        if (s.applications?.[me]?.st === 'bekliyor') return cb({ ok: true, pending: true });
        if (limited('basvuru|' + me + '|' + s.id, 3, 3600e3)) return cb({ error: 'Çok fazla başvuru yaptın, biraz bekle' });
        (s.applications ||= {})[me] = { st: 'bekliyor', at: Date.now(), q: qs, a: ans, via: s.joinVia?.[me] || null };
        save(); pushServers([me, ...membersOf(s).filter(n => isMod(s, n))]);
        for (const n of membersOf(s).filter(n => isMod(s, n) && n !== me)) io.to('user:' + n).emit('toast', `📝 ${me}, ${s.name} sunucusuna katılmak için başvurdu`);
        return cb({ ok: true, pending: true });
      }
      if (qs.length) (s.applications ||= {})[me] = { st: 'onay', at: Date.now(), q: qs, a: ans, auto: true };
    }
    (s.accepted ||= {})[me] = Date.now();
    if (botOn(s, 'autorole') && s.bot.autorole.when === 'rules') autoRoleGive(s, me);
    save(); pushServers([me]); cb({ ok: true });
  });
  // ----- Davet linkleri -----
  socket.on('invList', (serverId, cb = () => {}) => {
    const s = permServer(serverId, 'manageServer'); if (!s) return cb({ error: 'Yetkin yok' });
    s.invites = (s.invites || []).filter(i => invValid(i) || Date.now() - (i.exp || i.at) < 7 * 864e5); // bitenler 7 gün listede kalır
    const via = Object.values(s.joinVia || {}).filter(v => v === 'ana').length;
    cb({ main: { code: s.invite, uses: via }, list: s.invites.map(invOut).reverse() });
  });
  socket.on('invCreate', ({ serverId, exp, max, temp } = {}, cb = () => {}) => {
    const s = permServer(serverId, 'manageServer'); if (!s) return cb({ error: 'Yetkin yok' });
    if (limited('invc|' + me, 30, 3600e3)) return cb({ error: 'Çok fazla link oluşturdun, biraz bekle' });
    if ((s.invites || []).filter(invValid).length >= 50) return cb({ error: 'En fazla 50 aktif davet linki olabilir; eskileri iptal et' });
    const E = [0, 1800, 3600, 21600, 43200, 86400, 604800], M = [0, 1, 5, 10, 25, 50, 100];
    const i = { code: newInviteCode(), by: me, at: Date.now(), exp: E.includes(+exp) && +exp ? Date.now() + exp * 1000 : null, max: M.includes(+max) ? +max : 0, uses: 0, temp: !!temp };
    (s.invites ||= []).push(i); audit(s, me, 'Davet linki oluşturdu', `${i.exp ? 'süreli' : 'süresiz'}${i.max ? `, ${i.max} kullanım` : ''}${i.temp ? ', geçici üyelik' : ''}`); save();
    cb({ ok: true, inv: invOut(i) });
  });
  socket.on('invRevoke', ({ serverId, code } = {}, cb = () => {}) => {
    const s = permServer(serverId, 'manageServer'); if (!s) return cb({ error: 'Yetkin yok' });
    const i = s.invites?.find(x => x.code === code); if (!i) return cb({ error: 'Link bulunamadı' });
    i.revoked = Date.now(); audit(s, me, 'Davet linkini iptal etti', code); save(); cb({ ok: true });
  });
  // ----- Güvenlik seviyesi ve katılım kapısı -----
  socket.on('secSave', ({ serverId, level, questions, approval } = {}, cb = () => {}) => {
    const s = permServer(serverId, 'manageServer'); if (!s || s.public) return cb({ error: 'Yetkin yok' });
    const L = Math.max(0, Math.min(4, +level || 0)), qs = (Array.isArray(questions) ? questions : []).map(q => clean(q, 150)).filter(Boolean).slice(0, 3);
    s.secLevel = L; s.gate = qs.length || approval ? { questions: qs, approval: !!approval } : null;
    if (s.gate && !s.welcome?.enabled) s.welcome = { ...(s.welcome || { rules: [], channels: [] }), enabled: true, message: s.welcome?.message || `${s.name} sunucusuna hoş geldin!` };
    audit(s, me, 'Katılım güvenliğini değiştirdi', `seviye: ${SEC_LEVELS[L]}${qs.length ? `, ${qs.length} soru` : ''}${approval ? ', onaylı katılım' : ''}`);
    save(); pushServers(membersOf(s)); cb({ ok: true });
  });
  socket.on('joinApps', (serverId, cb = () => {}) => {
    const s = db.servers.find(x => x.id === serverId); if (!s || !me || !isMod(s, me)) return cb({ error: 'Yetkin yok' });
    cb({ list: Object.entries(s.applications || {}).filter(([n, a]) => a.st === 'bekliyor' && s.members.includes(n)).map(([n, a]) => ({ name: n, at: a.at, q: a.q, a: a.a, via: a.via,
      createdAt: db.users[n]?.createdAt || null, email: !!db.users[n]?.email, tfa: !!db.users[n]?.tfa?.on })).sort((x, y) => x.at - y.at) });
  });
  socket.on('joinDecide', ({ serverId, name, ok, note } = {}, cb = () => {}) => {
    const s = db.servers.find(x => x.id === serverId); if (!s || !me || !isMod(s, me)) return cb({ error: 'Yetkin yok' });
    const a = s.applications?.[name]; if (!a || a.st !== 'bekliyor') return cb({ error: 'Başvuru bulunamadı' });
    note = clean(note, 200); Object.assign(a, { st: ok ? 'onay' : 'ret', by: me, decidedAt: Date.now(), note });
    if (ok) {
      (s.accepted ||= {})[name] = Date.now(); if (botOn(s, 'autorole') && s.bot.autorole.when === 'rules') autoRoleGive(s, name);
      audit(s, me, 'Katılım başvurusunu onayladı', name); io.to('user:' + name).emit('toast', `✅ ${s.name} sunucusuna katılım başvurun onaylandı, artık yazabilirsin!`);
    } else {
      s.members = s.members.filter(n => n !== name); wipeMember(s, name); voiceKick(s.channels.map(c => c.id), name, 'Başvurun reddedildi');
      audit(s, me, 'Katılım başvurusunu reddetti', name + (note ? ': ' + note : '')); io.to('user:' + name).emit('toast', `${s.name} sunucusuna katılım başvurun kabul edilmedi${note ? ': ' + note : ''}`);
    }
    save(); pushServers([name, ...membersOf(s)]); cb({ ok: true });
  });
  socket.on('welcomeSave', ({ serverId, enabled, message, rules, channels } = {}, cb = () => {}) => {
    const s = permServer(serverId, 'manageServer'); if (!s) return cb({ error: 'Sunucuyu yönetme yetkin yok' });
    s.welcome = { enabled: !!enabled, message: clean(message, 500), rules: (rules || []).map(r => clean(r, 200)).filter(Boolean).slice(0, 10),
      channels: (channels || []).filter(c => s.channels.some(x => x.id === c?.id && x.type === 'text')).slice(0, 5).map(c => ({ id: c.id, desc: clean(c.desc, 60) })) };
    audit(s, me, 'Hoş geldin ekranını düzenledi'); save(); pushServers(membersOf(s)); cb({ ok: true });
  });
  socket.on('discoverySave', ({ serverId, discoverable, description, category } = {}, cb = () => {}) => {
    const s = permServer(serverId, 'manageServer'); if (!s) return cb({ error: 'Sunucuyu yönetme yetkin yok' });
    if (discoverable && !clean(description, 200)) return cb({ error: 'Keşfette görünmek için kısa bir açıklama yaz' });
    s.discoverable = !!discoverable; s.description = clean(description, 200); s.category = CATS.includes(category) ? category : null;
    audit(s, me, s.discoverable ? 'Sunucuyu keşfete açtı' : 'Keşif ayarlarını değiştirdi'); save(); pushServers(membersOf(s)); cb({ ok: true });
  });
  // Mesajlardaki davet linkleri için kart bilgisi (Discord'daki gibi)
  socket.on('invitePeek', (codes, cb = () => {}) => {
    if (!me || !Array.isArray(codes)) return cb({});
    const on = new Set(onlineNames()), out = {};
    for (const code of codes.slice(0, 10)) {
      if (typeof code !== 'string' || code.length > 40) continue;
      if (blockedUntil('u:' + me) || blockedUntil('ip:' + ip) || limited('peek|' + me, 120, 600e3)) { out[code] = null; continue; }
      const vs = /^s:([a-z0-9-]{2,40})$/.exec(code); // özel link: kankahq.com/s/isim
      const sv = vs ? db.servers.find(x => x.vanity === vs[1] && vanityOk(x)) : findInvite(code)?.s;
      inviteGuard('u:' + me, !!sv); inviteGuard('ip:' + ip, !!sv);
      if (!sv || sv.bans?.[me]) { out[code] = null; continue; }
      const mem = membersOf(sv);
      out[code] = { id: sv.id, name: sv.name, icon: sv.icon, iconImg: sv.iconImg || null, banner: sv.banner || null, bannerColor: sv.bannerColor || null, badges: srvBadges(sv),
        description: (sv.description || '').slice(0, 140), invite: code, members: mem.length, online: mem.filter(n => on.has(n)).length, joined: !!sv.public || sv.members.includes(me) };
    }
    cb(out);
  });
  socket.on('resetInvite', (serverId, cb = () => {}) => {
    const sv = db.servers.find(x => x.id === serverId);
    if (!me || !sv || sv.public || !can(sv, me, 'manageServer')) return cb({ error: 'Yetkin yok' });
    if (limited('reinv|' + me, 10, 3600e3)) return cb({ error: 'Çok sık yeniledin, biraz bekle' });
    sv.invite = newInviteCode(); audit(sv, me, 'Davet linkini yeniledi', 'eski link artık çalışmıyor'); save(); pushServers(sv.members);
    cb({ ok: true, invite: sv.invite });
  });
  socket.on('joinInvite', (code, cb = () => {}) => {
    setTimeout(() => onbAward(me), 800);
    code = clean(code, 200).split(/[=/]/).pop();
    if (!me) return cb({ error: 'Giriş yapmalısın' });
    if (blockedUntil('u:' + me) || blockedUntil('ip:' + ip)) return cb({ error: 'Çok fazla geçersiz davet denedin. Bir saat sonra tekrar dene.' });
    if (limited('join|' + me, 15, 600e3)) return cb({ error: 'Çok hızlı sunucuya katılıyorsun, biraz bekle' });
    const fi = findInvite(code), s = fi?.s, inv = fi?.inv;
    inviteGuard('u:' + me, !!s); inviteGuard('ip:' + ip, !!s);
    if (!s) return cb({ error: s === undefined && db.servers.some(x => x.invites?.some(i => i.code === code)) ? 'Bu davetin süresi dolmuş ya da kullanım sınırına ulaşmış' : 'Davet kodu geçersiz' });
    if (s.bans?.[me]) return cb({ error: 'Bu sunucudan yasaklandın' });
    if (!s.public && !s.members.includes(me)) { wipeMember(s, me); s.members.push(me); (s.joinedAt ||= {})[me] = Date.now(); if (inv) { inv.uses = (inv.uses || 0) + 1; if (inv.temp) (s.temp ||= {})[me] = Date.now(); } (s.joinVia ||= {})[me] = inv ? inv.code : 'ana'; const ar = autoRoleOnJoin(s, me); if (s.id === db.devServer) devRoleSync(me); save(); pushServers(s.members); botWelcome(s, me, ar); botMember(s, me, 'join'); }
    cb(serverView(s, me));
  });

  socket.on('leaveServer', (serverId, cb = () => {}) => {
    const s = db.servers.find(x => x.id === serverId);
    if (!me || !s || s.public) return cb({ error: 'Bu sunucudan ayrılamazsın' });
    if (s.owner === me && s.members.some(n => n !== me)) return cb({ error: 'Sunucunun sahibisin. Ayrılmadan önce Sunucu ayarları → Genel → Sahipliği devret, ya da sunucuyu sil.', owner: true });
    s.members = s.members.filter(n => n !== me); wipeMember(s, me); botMember(s, me, 'leave', { islem: 'ayrildi' });
    for (const c of s.channels.filter(c => c.ticket && !c.ticket.closedAt && c.ticket.by === me)) closeTicket(s, c, me);
    botBye(s, me);
    voiceKick(s.channels.map(c => c.id), me, 'Sunucudan ayrıldın');
    if (s.owner === me) s.owner = s.members[0] || null;
    if (!s.members.length) db.servers = db.servers.filter(x => x !== s);
    save(); pushServers([me, ...s.members]); cb({ ok: true });
  });

  // ----- Sesli odalar (WebRTC sinyalleşme) -----
  function leaveVoice() {
    if (!myVoice) return;
    const left = myVoice;
    const room = voice.get(left);
    if (room) { room.delete(socket.id); if (!room.size) voice.delete(left); }
    if (left.startsWith('call:')) { const c = left.slice(5); if (voice.get(left)) callAloneWatch(c); else callEnded(c); }
    socket.to('v:' + left).emit('voiceLeft', socket.id);
    socket.leave('v:' + myVoice);
    voiceMedia.delete(socket.id); voiceFlags.delete(socket.id); delete socket.data.vold;
    { const st = stage.get(myVoice); if (st && ![...(voice.get(myVoice)?.values() || [])].includes(me)) { st.speakers.delete(me); st.hands.delete(me); io.to('v:' + myVoice).emit('stage', { ch: myVoice, ...stageView(myVoice) }); } }
    myVoice = null;
    pushVoice();
  }
  socket.on('voiceJoin', (chId, cb = () => {}) => joinVoice(chId, typeof cb === 'function' ? cb : () => {}, null));
  // Sunucu güncellendikten sonra: aynı kişi yeni bağlantıyla odasına sessizce döner, diğerleri eski bağlantıyı yeni kimliğe taşır
  socket.on('voiceRejoin', ({ ch, old } = {}, cb = () => {}) => {
    if (typeof cb !== 'function') return;
    if (typeof ch !== 'string' || typeof old !== 'string' || old.length > 40 || myVoice) return cb({ error: 'geçersiz' });
    joinVoice(ch, cb, old);
  });
  function joinVoice(chId, cb, old) {
    const isCall = typeof chId === 'string' && chId.startsWith('call:');
    const f = isCall ? null : findChannel(chId);
    if (!me) return cb({ error: 'Erişim yok' });
    if (isCall ? !canAccess(me, chId.slice(5)) || !isPrivateChat(chId.slice(5)) : (!f || !voiceLike(f.c.type) || !(f.s.public || f.s.members.includes(me)) || f.s.bans?.[me] || !seesChannel(f.s, f.c, me))) return cb({ error: 'Erişim yok' });
    if (f && !chPerm(f.s, f.c, me, 'connect')) {
      const pass = voicePass.get(socket.id);
      if (!pass || pass.ch !== chId || pass.until < Date.now()) return cb({ error: 'Bu sesli odaya bağlanma iznin yok' });
      voicePass.delete(socket.id);
    }
    if (f && timedOut(f.s, me)) return cb({ error: 'Susturulduğun için sesli odalara giremezsin' });
    if (f && !f.s.public && f.s.welcome?.enabled && f.s.owner !== me && !f.s.accepted?.[me]) return cb({ error: f.s.applications?.[me]?.st === 'bekliyor' ? 'Katılım başvurun onay bekliyor' : 'Önce sunucu kurallarını kabul etmelisin' });
    { const sb = f && secBlock(f.s, me); if (sb) return cb({ error: sb }); }
    if (f?.c.limit && myVoice !== chId && (voice.get(chId)?.size || 0) >= f.c.limit && !can(f.s, me, 'manageChannels') && f.s.owner !== me) return cb({ error: `Oda dolu (${f.c.limit}/${f.c.limit})` });
    leaveVoice();
    const room = voice.get(chId) || new Map();
    const peers = [...room].map(([sid, name]) => ({ sid, name, media: voiceMedia.get(sid) || null, old: io.sockets.sockets.get(sid)?.data?.vold || null }));
    room.set(socket.id, me); voice.set(chId, room);
    if (old) socket.data.vold = old;
    if (isCall) {
      const c = chId.slice(5), s = callSessOf(c);
      if (!s.by) { s.by = me; if (!old) callMsg(c, { state: 'start', by: me }); }
      s.max = Math.max(s.max, room.size); s.names.add(me);
      callAloneWatch(c);
    }
    if (!old) onbFlag(me, 'voice');
    socket.to('v:' + chId).emit(old ? 'voiceRekey' : 'voiceJoined', { sid: socket.id, name: me, old });
    myVoice = chId; socket.join('v:' + chId);
    pushVoice();
    cb({ peers, stage: f?.c.type === 'stage' ? stageView(chId) : null, srvMuted: !!f && srvMuted.has(f.s.id + '|' + me) });
    if (!old) sbEntryPlay(chId);
    if (f && srvMuted.has(f.s.id + '|' + me)) socket.emit('srvMute', { on: true });
  }
  socket.on('voiceLeave', leaveVoice);
  // ----- Kanka Wrapped (yıl özeti) -----
  // Yıl sonunda (31 Aralık, Türkiye saati) herkese açılır; site yöneticileri "şimdiye kadar" önizlemesini her zaman görebilir.
  socket.on('wrapped', ({ year, server } = {}, cb = () => {}) => {
    if (typeof cb !== 'function') return; const u = db.users[me]; if (!u) return cb({ error: 'Giriş yap' });
    if (!STAT.on()) return cb({ error: 'Yıl özeti şu an hazırlanamıyor' });
    if (limited('wr|' + me, 20, 60e3)) return cb({ error: 'Biraz bekle' });
    const now = new Date(Date.now() + 3 * 3600e3), cy = now.getUTCFullYear(), y = Number.isInteger(year) ? year : cy;
    const open = y < cy || (now.getUTCMonth() === 11 && now.getUTCDate() >= 31), preview = !open && siteAdmin(me);
    if (y > cy || y < 2026 || (!open && !preview)) return cb({ error: `${y} özetin 31 Aralık'ta açılacak`, opensAt: `${y}-12-31` });
    const A = STAT.all(server ? '#' + server : me, y), top = (pre, n = 5, f = x => x) => Object.entries(A).filter(([k]) => k.startsWith(pre)).map(([k, v]) => ({ k: k.slice(pre.length), v: Math.round(v) })).sort((a, b) => b.v - a.v).map(f).filter(Boolean).slice(0, n);
    const chName = id => { const f = findChannel(id); return f ? { id, ad: f.c.name, sv: f.s.name } : null; };
    const svName = id => { const s = db.servers.find(x => x.id === id); return s && s.members.includes(me) ? { id, ad: s.name, simge: s.icon || null, simgeImg: s.iconImg || null } : null; };
    const hours = Array.from({ length: 24 }, (_, h) => Math.round(A[(server ? 'h:' : 'msgh:') + h] || 0));
    const peak = hours.indexOf(Math.max(...hours)), totalH = hours.reduce((a, b) => a + b, 0), night = totalH ? Math.round(hours.slice(0, 5).reduce((a, b) => a + b, 0) / totalH * 100) : 0;
    if (server) {
      const s = db.servers.find(x => x.id === server); if (!s || !s.members.includes(me) || s.public) return cb({ error: 'Bu sunucunun özetini göremezsin' });
      const mem = {}; for (const [k, v] of Object.entries(A)) { const m = /^(m|v):(.+)$/.exec(k); if (m && s.members.includes(m[2])) mem[m[2]] = (mem[m[2]] || 0) + (m[1] === 'm' ? v * 2 : v); }
      return cb({ ok: true, year: y, preview, server: { id: s.id, ad: s.name, simge: s.icon || null, simgeImg: s.iconImg || null, uye: humans(s.members).length },
        msg: Math.round(A.msg || 0), ses: Math.round((A.vs || 0) / 60), peak, hours,
        uyeler: Object.entries(mem).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n]) => n),
        odalar: top('ch:', 3, x => { const c = chName(x.k); return c && { ...c, v: x.v }; }), sesOdalari: top('vch:', 3, x => { const c = chName(x.k); return c && { ...c, v: Math.round(x.v / 60) }; }),
        emoji: top('em:', 5) });
    }
    const vsMin = A.vs || 0;
    const kanka = {}; for (const [k, v] of Object.entries(A)) { const m = /^(vk|dm):(.+)$/.exec(k); if (m && db.users[m[2]] && !db.users[m[2]].bot) kanka[m[2]] = (kanka[m[2]] || 0) + (m[1] === 'vk' ? v : v * 3); }
    const arena = top('ar:', 20).filter(x => x.k.endsWith(':o')).map(x => ({ oyun: x.k.slice(0, -2), oynadi: x.v, kazandi: Math.round(A['ar:' + x.k.slice(0, -2) + ':w'] || 0) }));
    const pct = STAT.rankPct(y, 'vs', vsMin);
    const d = { ok: true, year: y, preview, me: { ad: me, gorunen: u.displayName || me },
      ses: Math.round(vsMin / 60 * 10) / 10, sesDk: Math.round(vsMin), sesYuzde: pct,
      kankalar: Object.entries(kanka).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, v]) => ({ ad: n, dk: Math.round(A['vk:' + n] || 0), msg: Math.round(A['dm:' + n] || 0) })),
      odalar: top('vch:', 3, x => { const c = chName(x.k); return c && { ...c, dk: x.v }; }),
      sunucular: (() => { const m = {}; for (const [k, v] of Object.entries(A)) { const r = /^(vsv|msgsv):(.+)$/.exec(k); if (r) m[r[2]] = (m[r[2]] || 0) + (r[1] === 'vsv' ? v : v * 2); } return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([id]) => svName(id)).filter(Boolean).slice(0, 3); })(),
      muzikDk: Math.round(A.mz || 0), sanatcilar: top('ma:', 5), sarkilar: top('ms:', 5, x => { const i = x.k.indexOf(' — '); return { sanatci: x.k.slice(0, i), ad: x.k.slice(i + 3), dk: x.v }; }),
      oyunDk: Math.round(A.oy || 0), oyunlar: top('og:', 5), arena, arenaGalibiyet: arena.reduce((a, b) => a + b.kazandi, 0),
      emoji: top('em:', 5), msg: Math.round(A.msg || 0), peak, hours, night, gun: Math.round(A.gun || 0), seri: u.streak?.best || 0 };
    // Yılın kişiliği
    const P = [[d.night >= 25 && d.msg >= 50, ['🦉', 'Gece Kuşu', 'Herkes uyurken sen sohbetin ortasındaydın']], [pct != null && pct <= 10 && vsMin >= 600, ['🎧', 'Ses Canavarı', 'Seste en çok kalanların arasındasın']],
      [d.arenaGalibiyet >= 10, ['🏆', 'Arena Efsanesi', 'Arena\'da rakip tanımadın']], [d.muzikDk >= 1200 && d.muzikDk >= d.oyunDk, ['🎵', 'Kankaların DJ\'i', 'Müziksiz bir an bile geçirmedin']],
      [d.oyunDk >= 1200, ['🎮', 'Oyun Kurdu', 'Bilgisayarın başından kalkmadın']], [d.msg >= 1000, ['💬', 'Geveze', 'Mesaj kutusu senden sorulur']], [d.kankalar.length >= 3, ['🤝', 'Sosyal Kelebek', 'Kankasız bir gün yok']], [true, ['🌱', 'Yeni Kanka', 'Bu daha başlangıç, seneye daha çok']]];
    d.kisilik = P.find(([c]) => c)[1];
    cb(d);
  });
  // ----- Kanka Arena -----
  let arWatchCh = null;
  const arLeaveRoom = () => { const cur = arenaSocks.get(socket.id); if (cur) { socket.leave('ar:' + cur); arenaSocks.delete(socket.id); } };
  socket.on('arenaWatch', ({ ch } = {}, cb = () => {}) => {
    if (typeof cb !== 'function') cb = () => {};
    if (arWatchCh) socket.leave('arch:' + arWatchCh); arWatchCh = null;
    const f = typeof ch === 'string' ? findChannel(ch) : null; if (!me || !f || !voiceLike(f.c.type) || !seesChannel(f.s, f.c, me) || !(f.s.public || f.s.members.includes(me))) return cb({ lobbies: [] });
    arWatchCh = ch; socket.join('arch:' + ch);
    cb({ lobbies: [...arenas.values()].filter(L => L.ch === ch).map(arenaSummary) });
  });
  socket.on('arenaCreate', ({ game } = {}, cb = () => {}) => {
    if (typeof cb !== 'function') return; const E = ARENA_GAMES[game];
    if (!me || !E) return cb({ error: 'Böyle bir oyun yok' });
    const f = myVoice && !myVoice.startsWith('call:') ? findChannel(myVoice) : null;
    if (!f) return cb({ error: 'Arena lobisi açmak için bir sunucunun sesli odasına katıl' });
    if (!chPerm(f.s, f.c, me, 'apps') || timedOut(f.s, me)) return cb({ error: 'Bu odada oyun açma iznin yok' });
    if (limited('arc|' + me, 8, 300e3)) return cb({ error: 'Çok hızlı lobi açıyorsun, biraz bekle' });
    if ([...arenas.values()].filter(L => L.ch === f.c.id).length >= 8) return cb({ error: 'Bu odada çok fazla lobi var. Birine katıl ya da bitmesini bekle.' });
    for (const L of [...arenas.values()]) if (L.players.includes(me) && L.state !== 'play') arenaDrop(L, me);
    if ([...arenas.values()].some(L => L.state === 'play' && L.st.ps.includes(me))) return cb({ error: 'Zaten bir oyundasın' });
    const L = { id: id(), ch: f.c.id, sv: f.s.id, game, host: me, players: [me], state: 'lobby', at: Date.now() };
    arenas.set(L.id, L);
    // odanın sohbetine davet kartı
    const u = db.users[me], list = (db.messages[L.ch] ||= []);
    const msg = { id: id(), author: me, color: u.color, time: Date.now(), kind: 'arena', reactions: {}, arena: { id: L.id, game, ad: E.ad, emoji: E.emoji, max: E.max, min: E.min, state: 'lobby', players: [me] } };
    list.push(msg); if (list.length > 2000) list.shift(); L.msg = msg.id; save();
    io.to(L.ch).emit('message', { channelId: L.ch, msg });
    arLeaveRoom(); socket.join('ar:' + L.id); arenaSocks.set(socket.id, L.id);
    arenaPush(L); arenaPushCh(L.ch); cb({ ok: true, lobby: arenaView(L, me) });
  });
  socket.on('arenaOpen', ({ id: lid } = {}, cb = () => {}) => {
    if (typeof cb !== 'function') return; const L = arenas.get(lid); if (!me || !L) return cb({ error: 'Bu lobi kapanmış' });
    const f = findChannel(L.ch); if (!f || !seesChannel(f.s, f.c, me) || !(f.s.public || f.s.members.includes(me))) return cb({ error: 'Bu lobiyi göremezsin' });
    arLeaveRoom(); socket.join('ar:' + L.id); arenaSocks.set(socket.id, L.id);
    cb({ ok: true, lobby: arenaView(L, me) }); setTimeout(() => arenaPush(L), 50); // izleyici sayısı güncellensin
  });
  socket.on('arenaClose', () => { const lid = arenaSocks.get(socket.id); arLeaveRoom(); const L = arenas.get(lid); if (L) arenaPush(L); });
  socket.on('arenaJoin', ({ id: lid } = {}, cb = () => {}) => {
    if (typeof cb !== 'function') return; const L = arenas.get(lid); if (!me || !L) return cb({ error: 'Bu lobi kapanmış' });
    const E = ARENA_GAMES[L.game];
    if (L.players.includes(me)) return cb({ ok: true });
    if (L.state === 'play') return cb({ error: 'Oyun başladı, bitince katılabilirsin. Şimdilik izleyebilirsin.' });
    if (myVoice !== L.ch) return cb({ error: 'Katılmak için önce bu sesli odaya gir', needVoice: L.ch });
    if (L.players.length >= E.max) return cb({ error: 'Lobi dolu' });
    if ([...arenas.values()].some(x => x.state === 'play' && x.st.ps.includes(me))) return cb({ error: 'Zaten bir oyundasın' });
    for (const x of [...arenas.values()]) if (x !== L && x.players.includes(me)) arenaDrop(x, me);
    L.players.push(me); arLeaveRoom(); socket.join('ar:' + L.id); arenaSocks.set(socket.id, L.id);
    arenaPush(L); arenaPushCh(L.ch); arenaCardUpdate(L); cb({ ok: true });
  });
  socket.on('arenaLeave', ({ id: lid } = {}, cb = () => {}) => { const L = arenas.get(lid); if (L && me && L.players.includes(me)) arenaDrop(L, me, 'Ayrıldı'); typeof cb === 'function' && cb({ ok: true }); });
  socket.on('arenaKick', ({ id: lid, name } = {}, cb = () => {}) => {
    if (typeof cb !== 'function') return; const L = arenas.get(lid); if (!L || L.host !== me || name === me || L.state === 'play' || !L.players.includes(name)) return cb({ error: 'Yapılamadı' });
    arenaDrop(L, name, 'Lobiden çıkarıldı'); io.to('user:' + name).emit('arenaNote', { id: L.id, text: 'Lobiden çıkarıldın' }); cb({ ok: true });
  });
  socket.on('arenaStart', ({ id: lid } = {}, cb = () => {}) => {
    if (typeof cb !== 'function') return; const L = arenas.get(lid); if (!L || L.host !== me) return cb({ error: 'Sadece lobiyi açan başlatabilir' });
    const E = ARENA_GAMES[L.game]; if (L.state === 'play') return cb({ error: 'Oyun zaten başladı' });
    if (L.players.length < E.min) return cb({ error: `En az ${E.min} oyuncu gerekli` });
    arenaStart(L); cb({ ok: true });
  });
  socket.on('arenaMove', ({ id: lid, mv } = {}, cb = () => {}) => {
    if (typeof cb !== 'function') cb = () => {};
    const L = arenas.get(lid); if (!L || !me) return cb({ error: 'Lobi bulunamadı' });
    if (limited('arm|' + me, 12, 3e3)) return cb({ error: 'Çok hızlı' });
    const err = arenaMove(L, me, mv && typeof mv === 'object' ? mv : {}); cb(err ? { error: err } : { ok: true });
  });
  let arInT = 0, arInN = 0; // oyun girdisi: saniyede en çok 150 (fazlası sessizce atlanır, bağlantı kesilmez)
  socket.on('arenaIn', ({ id: lid, ...inp } = {}) => { const now = Date.now(); if (now - arInT > 1000) { arInT = now; arInN = 0; } if (++arInN > 150) return; const L = arenas.get(lid); if (!L || L.state !== 'play' || !me) return; const E = ARENA_GAMES[L.game]; if (E.rt) E.input(L.st, me, inp); });
  socket.on('arenaRematch', ({ id: lid } = {}, cb = () => {}) => {
    if (typeof cb !== 'function') cb = () => {};
    const L = arenas.get(lid); if (!L || L.state !== 'end' || !me) return cb({ error: 'Rövanş yapılamaz' });
    if (!L.players.includes(me)) { if (myVoice !== L.ch) return cb({ error: 'Önce bu sesli odaya gir', needVoice: L.ch }); if (L.players.length >= ARENA_GAMES[L.game].max) return cb({ error: 'Lobi dolu' }); L.players.push(me); arLeaveRoom(); socket.join('ar:' + L.id); arenaSocks.set(socket.id, L.id); }
    L.rematch = [...new Set([...(L.rematch || []), me])];
    const E = ARENA_GAMES[L.game], ready = L.players.filter(n => arenaInVoice(L.ch, n));
    if (ready.length >= E.min && ready.every(n => L.rematch.includes(n))) { L.players = ready; arenaStart(L); } else { arenaPush(L); arenaPushCh(L.ch); }
    cb({ ok: true });
  });
  socket.on('arenaTop', ({ game } = {}, cb = () => {}) => {
    if (typeof cb !== 'function') return; if (!me) return cb({ error: 'Giriş yap' });
    const mine = db.users[me]?.arena || {};
    if (game && ARENA_GAMES[game]) {
      const list = Object.values(db.users).filter(u => u.arena?.[game]?.p && !u.bot).map(u => ({ name: u.name, ...u.arena[game] })).sort((a, b) => b.r - a.r || b.w - a.w);
      const i = list.findIndex(x => x.name === me);
      return cb({ game, list: list.slice(0, 50), me: mine[game] || null, myRank: i >= 0 ? i + 1 : null });
    }
    const all = arenaOverall(), i = all.findIndex(x => x.name === me);
    cb({ list: all.slice(0, 50), me: mine, myRank: i >= 0 ? i + 1 : null, champs: [...arenaChampions()] });
  });
  socket.on('disconnect', () => { arenaSocks.delete(socket.id); });
  // ----- Sunucu etiketi -----
  socket.on('tagSet', (sid, cb = () => {}) => {
    if (typeof cb !== 'function') return; const u = db.users[me]; if (!u) return cb({ error: 'Giriş yap' });
    if (limited('tagset|' + me, 15, 3600e3)) return cb({ error: 'Etiketini çok sık değiştirdin, biraz bekle' });
    if (sid == null) { delete u.tag; save(); pushUsers(); return cb({ ok: true, tag: null }); }
    const s = db.servers.find(x => x.id === sid); if (!TAG.canUse(me, s)) return cb({ error: 'Bu sunucunun etiketini takamazsın' });
    u.tag = s.id; (db.tagStats ||= {})[s.id] = (db.tagStats[s.id] || 0) + 1; save(); pushUsers(); cb({ ok: true, tag: s.id });
  });
  socket.on('srvTagSave', ({ serverId, t, i, c, on } = {}, cb = () => {}) => {
    if (typeof cb !== 'function') return; const s = db.servers.find(x => x.id === serverId);
    if (!me || !s || !(s.owner === me || can(s, me, 'manageServer') || (s.public && siteAdmin(me)))) return cb({ error: 'Yetkin yok' });
    if (!TAG.allowedServer(s)) return cb({ error: 'Sunucu etiketi şimdilik test aşamasında, sadece Kanka HQ\'da açık' });
    const txt = String(t ?? s.tag?.t ?? '').trim().toLocaleUpperCase('tr').replace(/\s+/g, '');
    if (!/^[A-Z0-9ÇĞİÖŞÜ]{2,4}$/u.test(txt)) return cb({ error: 'Etiket 2-4 harf ya da rakam olmalı' });
    BAD_RE.lastIndex = 0; const bad = BAD_RE.test(txt); BAD_RE.lastIndex = 0; if (bad) return cb({ error: 'Bu etiket uygun değil' });
    if (s.id !== 's1' && TAG_RESERVED.includes(txt)) return cb({ error: 'Bu etiket Kanka\'ya ayrılmış' });
    const icon = TAG_ICONS.includes(i) ? i : s.tag?.i || TAG_ICONS[0], col = TAG_COLORS.includes(c) ? c : s.tag?.c || TAG_COLORS[0];
    const changed = !s.tag || s.tag.t !== txt || s.tag.i !== icon || s.tag.c !== col;
    if (changed && s.tag?.at && Date.now() - s.tag.at < 864e5 && !siteAdmin(me)) return cb({ error: 'Etiketi günde bir kez değiştirebilirsin' });
    s.tag = { t: txt, i: icon, c: col, on: on === undefined ? s.tag?.on ?? true : !!on, at: changed ? Date.now() : s.tag?.at || Date.now(), by: me };
    audit(s, me, 'Sunucu etiketini değiştirdi', `${icon} ${txt}${s.tag.on ? '' : ' (kapalı)'}`);
    save(); pushServers(membersOf(s)); TAG.push(); cb({ ok: true, tag: s.tag });
  });
  // Etikete tıklayınca açılan kart
  // Kanka Spark & Energy
  socket.on('sparkMe', (_, cb = () => {}) => { if (!me) return cb({ error: 'Giriş yap' }); const u = db.users[me]; if (u.spark && !sparkOn(u)) sparkExpire(u); else if (u.spark && sparkCredit(u)) save();
    cb({ ...sparkView(u), perMonth: SPARK_PER_MONTH, bonusEvery: SPARK_BONUS_EVERY, levels: ENERGY_LV, perks: ENERGY_PERKS.map(p => p?.items || []),
      playHazir: playReady(), playUrun: PLAY_SPARK[0], playHesap: playAcct(me), play: !!u.spark?.play, playYenile: u.spark?.play ? db.playSubs?.[u.spark.play]?.yenile !== false : null }); });
  socket.on('energyInfo', ({ serverId } = {}, cb = () => {}) => { const s = db.servers.find(x => x.id === serverId); if (!me || !s || !s.members.includes(me)) return cb({ error: 'Sunucu bulunamadı' }); cb(energyView(s, me)); });
  socket.on('energyMove', ({ serverId, n = 1, pull } = {}, cb = () => {}) => {
    const s = db.servers.find(x => x.id === serverId), u = db.users[me];
    if (!me || !s || !s.members.includes(me)) return cb({ error: 'Bu sunucunun üyesi değilsin' });
    if (s.public) return cb({ error: 'Herkese açık topluluk sunucularına Energy gönderilmez' });
    if (!sparkOn(u)) return cb({ error: 'Energy göndermek için Kanka Spark gerekli' });
    if (limited('energy|' + me, 20, 60e3)) return cb({ error: 'Biraz yavaş: dakikada en fazla 20 işlem' });
    n = Math.max(1, Math.min(50, parseInt(n) || 1)); const before = energyLevel(s);
    const moved = energyMove(u, s, pull ? -n : n);
    if (!moved) return cb({ error: pull ? 'Bu sunucuda geri çekilecek Energy\'n yok' : 'Boşta Energy\'n yok. Önce başka bir sunucudan geri çek.' });
    audit(s, me, pull ? `Energy'yi geri çekti (${moved})` : `Sunucuya Energy gönderdi (${moved})`);
    const after = energyLevel(s); save(); pushServers(membersOf(s));
    if (!pull) { const ch = s.channels.find(c => c.id === s.bot?.welcome?.ch) || s.channels.find(c => (c.type || 'text') === 'text' && !everyoneDenied(ovOf(s, c), 'send'));
      if (ch) botPost(ch.id, { title: after > before ? `⚡ Energy Level ${after}!` : '⚡ Energy geldi!', tone: 'good', text: `${me} sunucuya ${moved} Energy gönderdi. Total Energy: ${energyTotal(s)}${after > before ? `. Sunucu Energy Level ${after}'e çıktı, yeni ayrıcalıklar açıldı 🎉` : ''}` }); }
    cb({ ok: true, moved, server: energyView(s, me), me: sparkView(u), levelUp: after > before, levelDown: after < before });
  });
  // Spark (yakında gelecek artı paket): bekleme listesi
  socket.on('playBuy', async ({ token } = {}, cb = () => {}) => {
    if (!me) return cb({ error: 'Giriş yap' }); if (limited('playbuy|' + me, 20, 60e3)) return cb({ error: 'Biraz bekle' });
    token = String(token || ''); if (!token || token.length > 400) return cb({ error: 'Geçersiz satın alma' });
    if (!playReady()) return cb({ error: 'Satın alma doğrulaması henüz açık değil. Ödemen alınmadıysa sorun yok; alındıysa birkaç gün içinde Google otomatik iade eder.' });
    try { const r = await playSync(token, me); if (r.ok && !r.pending) secLog?.('play-satin-alma', me, `${r.active ? 'aktif' : r.state} · ${new Date(r.until).toISOString().slice(0, 10)}`); cb(r); }
    catch (e) { console.error('playBuy', e.message); cb({ error: 'Google Play ile doğrulanamadı, biraz sonra tekrar dene. Spark açılmazsa uygulama her açılışta tekrar dener.' }); }
  });
  socket.on('playRestore', async ({ tokens } = {}, cb = () => {}) => {
    if (!me || !playReady()) return cb({ ok: false }); if (limited('playrest|' + me, 6, 60e3)) return cb({ ok: false });
    const out = []; for (const t of (Array.isArray(tokens) ? tokens : []).slice(0, 5)) { if (typeof t !== 'string' || t.length > 400) continue;
      try { out.push(await playSync(t, me)); } catch (e) { out.push({ error: e.message }); } }
    cb({ ok: true, sonuc: out, me: sparkView(db.users[me]) });
  });
  socket.on('sparkInfo', (_, cb = () => {}) => { if (!me) return cb({ error: 'Giriş yap' }); const w = db.sparkWait || {}; cb({ bekliyor: !!w[me], sayi: Object.keys(w).length }); });
  socket.on('sparkWait', ({ on } = {}, cb = () => {}) => {
    if (!me) return cb({ error: 'Giriş yap' }); if (limited('spark|' + me, 10, 60e3)) return cb({ error: 'Biraz bekle' });
    db.sparkWait ||= {}; if (on) db.sparkWait[me] = Date.now(); else delete db.sparkWait[me]; save();
    cb({ bekliyor: !!db.sparkWait[me], sayi: Object.keys(db.sparkWait).length });
  });
  socket.on('tagInfo', (sid, cb = () => {}) => {
    if (typeof cb !== 'function') return; const s = db.servers.find(x => x.id === sid), d = TAG.defOf(s); if (!d) return cb(null);
    const users = Object.values(db.users).filter(u => TAG.of(u) === s.id);
    cb({ ...d, id: s.id, uye: humans(s.members).length || Object.keys(db.users).length, takan: users.length, member: s.public || s.members.includes(me), canUse: TAG.canUse(me, s), mine: db.users[me]?.tag === s.id, public: !!s.public,
      ...(siteAdmin(me) ? { tiklama: db.tagStats?.[s.id] || 0 } : {}) });
  });
  // Test ayarı (site yöneticisi): kimler takabilir
  socket.on('tagCfgSet', ({ who } = {}, cb = () => {}) => {
    if (typeof cb !== 'function') return; if (!siteAdmin(me)) return cb({ error: 'Yetkin yok' });
    if (!['ekip', 'uye'].includes(who)) return cb({ error: 'Geçersiz' });
    TAG.cfg().who = who; save(); TAG.push(); cb({ ok: true, cfg: TAG.cfg() });
  });
  // ----- Ses paneli -----
  const sbServer = (serverId, cb) => { const s = db.servers.find(x => x.id === serverId); if (!me || !s || !s.members.includes(me)) { cb({ error: 'Sunucu bulunamadı' }); return null; } return s; };
  socket.on('sbAdd', ({ serverId, data, name, emoji, vol } = {}, cb = () => {}) => {
    if (typeof cb !== 'function') return; const s = sbServer(serverId, cb); if (!s) return;
    if (!sbCanAdd(s, me)) return cb({ error: 'Bu sunucuya ses ekleme iznin yok' });
    if (limited('sbadd|' + me, 10, 600e3)) return cb({ error: 'Çok fazla ses ekledin, biraz bekle' });
    const sbMax = SB_MAX + energyPerk(s, 'sb'); if ((s.sounds || []).length >= sbMax) return cb({ error: `Bir sunucuda en fazla ${sbMax} ses olabilir. Önce birini sil.${sbMax === SB_MAX ? ' Energy Level 1 ile +10 yer açılır.' : ''}` });
    name = clean(name, 24); if (!name) return cb({ error: 'Sese bir ad ver' });
    const m = /^data:audio\/(?:wav|x-wav|wave);base64,(.+)$/.exec(String(data || '')); if (!m) return cb({ error: 'Ses okunamadı' });
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length > SB_MAX_BYTES) return cb({ error: 'Ses dosyası çok büyük' });
    const w = wavInfo(buf); if (!w) return cb({ error: 'Ses bozuk ya da desteklenmiyor' });
    if (w.sec > SB_MAX_SEC) return cb({ error: 'Ses en fazla 5 saniye olabilir' });
    const fid = crypto.randomBytes(12).toString('hex');
    try { fs.writeFileSync(path.join(UPLOADS, fid + '.wav'), buf); } catch { return cb({ error: 'Kaydedilemedi, tekrar dene' }); }
    const snd = { id: id(), name, emoji: clean(emoji, 16) || '🔊', vol: Math.min(1, Math.max(0.05, +vol || 0.8)), url: `/uploads/${fid}.wav`, by: me, at: Date.now(), sec: Math.round(w.sec * 10) / 10 };
    (s.sounds ||= []).push(snd); audit(s, me, 'Ses paneline ses ekledi', name);
    save(); pushServers(membersOf(s)); cb({ ok: true, sound: snd });
  });
  socket.on('sbEdit', ({ serverId, id: sid, name, emoji, vol } = {}, cb = () => {}) => {
    if (typeof cb !== 'function') return; const s = sbServer(serverId, cb); if (!s) return;
    const x = (s.sounds || []).find(y => y.id === sid); if (!x) return cb({ error: 'Ses bulunamadı' });
    if (x.by !== me && !sbCanManage(s, me)) return cb({ error: 'Bu sesi düzenleme iznin yok' });
    if (name !== undefined) x.name = clean(name, 24) || x.name;
    if (emoji !== undefined) x.emoji = clean(emoji, 16) || '🔊';
    if (vol !== undefined) x.vol = Math.min(1, Math.max(0.05, +vol || 0.8));
    save(); pushServers(membersOf(s)); cb({ ok: true });
  });
  socket.on('sbDel', ({ serverId, id: sid } = {}, cb = () => {}) => {
    if (typeof cb !== 'function') return; const s = sbServer(serverId, cb); if (!s) return;
    const x = (s.sounds || []).find(y => y.id === sid); if (!x) return cb({ error: 'Ses bulunamadı' });
    if (x.by !== me && !sbCanManage(s, me)) return cb({ error: 'Bu sesi silme iznin yok' });
    s.sounds = s.sounds.filter(y => y !== x); audit(s, me, 'Ses panelinden ses sildi', x.name);
    if (!db.servers.some(o => (o.sounds || []).some(y => y.url === x.url))) try { fs.unlinkSync(path.join(UPLOADS, path.basename(x.url))); } catch {}
    save(); pushServers(membersOf(s)); cb({ ok: true });
  });
  socket.on('sbSettings', ({ serverId, all } = {}, cb = () => {}) => {
    if (typeof cb !== 'function') return; const s = sbServer(serverId, cb); if (!s) return;
    if (!sbCanManage(s, me)) return cb({ error: 'Yetkin yok' });
    s.sbAll = !!all; audit(s, me, 'Ses paneli ayarı', all ? 'herkes ses ekleyebilir' : 'sadece yetkililer ses ekler');
    save(); pushServers(membersOf(s)); cb({ ok: true });
  });
  // Çal: bulunduğun sesli odadaki herkes duyar (kişiden kişiye değil, herkes kendi tarafında çalar)
  function sbPlayIn(ch, snd, entry) {
    io.to('v:' + ch).emit('sbPlay', { by: me, id: snd.id, url: snd.url, vol: snd.vol, name: snd.name, emoji: snd.emoji, entry: !!entry });
  }
  function sbAllowed(f) { return !f || (chPerm(f.s, f.c, me, 'soundboard') && !timedOut(f.s, me) && !srvMuted.has(f.s.id + '|' + me) && (f.c.type !== 'stage' || chPerm(f.s, f.c, me, 'speak'))); }
  // Enstrüman: nota olayı odadaki herkese gider, ses her cihazda yerelde üretilir (gecikme ve bant genişliği düşük)
  const INSTR = ['gitar', 'piyano', 'bas', 'davul', 'synth'];
  let insT = 0, insN = 0;
  socket.on('instr', ({ i, n, v } = {}) => {
    if (!me || !myVoice) return;
    const now = Date.now(); if (now - insT > 1000) { insT = now; insN = 0; } if (++insN > 24) return; // saniyede en çok 24 nota
    if (!INSTR.includes(i) || !Number.isInteger(n) || n < 24 || n > 96) return;
    const f = myVoice.startsWith('call:') ? null : findChannel(myVoice);
    if (f && !sbAllowed(f)) return;
    if (f && timedOut(f.s, me)) return;
    socket.to('v:' + myVoice).emit('instr', { sid: socket.id, name: me, i, n, v: Math.max(0.1, Math.min(1, +v || 0.8)) });
  });
  // Kişisel notlar: sadece sahibi görür. Anahtar: oda/sohbet kimliği ya da 'genel'
  socket.on('noteGet', ({ key } = {}, cb = () => {}) => {
    if (typeof cb !== 'function' || !me) return; const u = db.users[me]; key = String(key || 'genel').slice(0, 80);
    cb({ text: u.notes?.[key]?.t || '', at: u.notes?.[key]?.at || null, keys: Object.entries(u.notes || {}).filter(([, x]) => x.t).map(([k, x]) => ({ k, at: x.at, len: x.t.length })).sort((a, b) => b.at - a.at).slice(0, 50) });
  });
  socket.on('noteSet', ({ key, text } = {}, cb = () => {}) => {
    if (typeof cb !== 'function') cb = () => {}; if (!me) return cb({ error: 'Giriş yap' });
    if (limited('note|' + me, 40, 60e3)) return cb({ error: 'Çok hızlı kaydediyorsun' });
    const u = db.users[me]; key = String(key || 'genel').slice(0, 80); text = String(text ?? '').slice(0, 8000);
    u.notes ||= {};
    if (!text.trim()) delete u.notes[key];
    else { if (!u.notes[key] && Object.keys(u.notes).length >= 200) return cb({ error: 'En fazla 200 not' }); u.notes[key] = { t: text, at: Date.now() }; }
    save(); cb({ ok: true, at: u.notes[key]?.at || null });
    for (const sid2 of io.sockets.adapter.rooms.get('user:' + me) || []) if (sid2 !== socket.id) io.to(sid2).emit('noteChanged', { key }); // diğer cihazlar güncellensin
  });
  socket.on('sbPlay', ({ id: sid, from } = {}, cb = () => {}) => {
    if (typeof cb !== 'function') cb = () => {};
    if (!me || !myVoice) return cb({ error: 'Önce bir sesli odaya katıl' });
    const f = myVoice.startsWith('call:') ? null : findChannel(myVoice);
    if (!sbAllowed(f)) return cb({ error: 'Bu odada ses panelini kullanma iznin yok' });
    // başka bir sunucunun sesi de çalınabilir (üyesi olduğun sürece)
    const src = from && from !== f?.s.id ? db.servers.find(x => x.id === from && x.members.includes(me)) : f?.s;
    const snd = sbFind(src, sid); if (!snd) return cb({ error: 'Ses bulunamadı' });
    if (limited('sbp|' + me, 1, 1500) || limited('sbpm|' + me, 12, 60e3)) return cb({ error: 'Biraz yavaş, sesler üst üste binmesin', cool: true });
    sbPlayIn(myVoice, snd); cb({ ok: true });
  });
  // Giriş sesi: sesli odaya girince odadakiler duyar (hazır seslerden ya da üyesi olduğun bir sunucunun sesinden)
  socket.on('sbEntry', (v, cb = () => {}) => {
    if (typeof cb !== 'function') return; const u = db.users[me]; if (!u) return cb({ error: 'Giriş yap' });
    if (!v) { delete u.entrySound; save(); return cb({ ok: true, entry: null }); }
    const src = v.s ? db.servers.find(x => x.id === v.s && x.members.includes(me)) : null, snd = sbFind(src, v.id);
    if (!snd) return cb({ error: 'Ses bulunamadı' });
    u.entrySound = { s: snd.def ? null : src.id, id: snd.id, name: snd.name, emoji: snd.emoji }; save(); cb({ ok: true, entry: u.entrySound });
  });
  function sbEntryPlay(ch) {
    const u = db.users[me], e = u?.entrySound; if (!e) return;
    const f = ch.startsWith('call:') ? null : findChannel(ch); if (!sbAllowed(f)) return;
    const snd = sbFind(e.s ? db.servers.find(x => x.id === e.s && x.members.includes(me)) : null, e.id); if (!snd) return;
    if (limited('sbent|' + me, 3, 60e3)) return;
    setTimeout(() => { if (myVoice === ch) sbPlayIn(ch, snd, true); }, 700);
  }
  socket.on('vflags', ({ m, d } = {}) => {
    if (!myVoice) return;
    const sv = findChannel(myVoice)?.s; if (sv && !m && srvMuted.has(sv.id + '|' + me)) { m = true; socket.emit('srvMute', { on: true }); }
    const pv = voiceFlags.get(socket.id) || {}; voiceFlags.set(socket.id, { m: !!m, d: !!d }); if (!!pv.m !== !!m || !!pv.d !== !!d) pushFlags(); });
  socket.on('signal', ({ to, data } = {}) => {
    if (!myVoice || !voice.get(myVoice)?.has(to)) return;
    if (botVoice.has(to)) { const bv = botVoice.get(to); if (data && typeof data === 'object' && JSON.stringify(data).length < 20000) gwSend(bv.conn, { op: 0, t: 'SES_SINYAL', d: { kimden: socket.id, veri: data } }); return; }
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('disconnect', () => {
    leaveVoice();
    online.delete(socket.id); onSetCache.t = 0; desktopSockets.delete(socket.id); idleSockets.delete(socket.id); visibleSockets.delete(socket.id); mobileSockets.delete(socket.id); voicePass.delete(socket.id);
    pushPresence();
  });
});

setInterval(() => {
  const now = Date.now();
  let pres = false, prof = false;
  for (const u of Object.values(db.users)) {
    if (u.presenceUntil && u.presenceUntil <= now) { u.presence = 'online'; u.presenceUntil = null; pres = true; pushActivity(u); io.to('user:' + u.name).emit('myStatus', { st: 'online', until: null, expired: true }); }
    if (u.statusUntil && u.statusUntil <= now) { u.status = ''; u.statusUntil = null; prof = true; io.to('user:' + u.name).emit('customStatus', { text: '', until: null, expired: true }); }
  }
  if (pres) pushPresence(); if (prof) pushUsers(); if (pres || prof) save();
}, 15e3);
setInterval(() => {
  const now = Date.now(), due = (db.scheduled || []).filter(x => x.at <= now);
  if (!due.length) return;
  db.scheduled = db.scheduled.filter(x => x.at > now);
  for (const x of due) if (db.users[x.author] && !postGate(x.author, x.chId, x.text)) {
    const r = postMessage(x.author, x.chId, { kind: 'text', text: x.text, scheduled: true });
    if (r.msg) { io.to('user:' + x.author).emit('toast', 'Zamanlanmış mesajın gönderildi'); }
  }
  save();
}, process.env.SCHED_MS ? +process.env.SCHED_MS : 10e3);

// ---------- Kanka Geliştiriciler: bot yazanların resmi sunucusu ----------
// İlk açılışta bir kez kurulur (sahibi Kanka HQ sahibi). Sonra her şey normal sunucu gibi yönetilir; silinirse yeniden kurulmaz.
const DEV_ROLES = { ekip: 'Kanka Ekibi', dogru: 'Doğrulanmış Geliştirici', gel: 'Geliştirici' };
function ensureDevServer() {
  if (db.devServer) return;
  const owner = db.servers.find(x => x.id === 's1')?.owner; if (!owner || !db.users[owner]) return;
  const team = [...new Set([owner, ...coOwnerNames()])].filter(n => db.users[n]);
  const s = {
    id: id(), name: 'Kanka Geliştiriciler', icon: 'K', iconImg: '/marka/gelistirici-sunucu.svg', bannerColor: '#f2652f', owner, members: team,
    joinedAt: Object.fromEntries(team.map(n => [n, Date.now()])), createdAt: Date.now(), setup: {}, roles: {}, customRoles: [], memberRoles: {}, bans: {}, timeouts: {},
    invite: newInviteCode(), channels: [], template: 'gelistirici', discoverable: true, category: 'Yazılım',
    description: "Kanka için bot yazanların resmi sunucusu. API duyuruları, SDK desteği, yardım ve bot vitrini.",
  };
  s.customRoles.push({ id: id(), name: DEV_ROLES.ekip, color: '#f2652f', perms: [...MOD, 'manageRoles'], hoist: true },
    { id: id(), name: DEV_ROLES.dogru, color: '#4cc38a', perms: [], hoist: true }, { id: id(), name: DEV_ROLES.gel, color: '#4aa8ff', perms: [], hoist: false });
  const ekip = s.customRoles[0].id; for (const n of team) s.memberRoles[n] = [ekip];
  const CH = [
    { n: 'hoş-geldin', cat: 'Bilgi', ro: 1, topic: 'Buradan başla: kurallar ve ilk adımlar' },
    { n: 'duyurular', cat: 'Bilgi', ro: 1, topic: 'API değişiklikleri, yeni özellikler, SDK sürümleri' },
    { n: 'değişiklik-günlüğü', cat: 'Bilgi', ro: 1, topic: 'Her API değişikliği, tarihiyle' },
    { n: 'genel', cat: 'Topluluk', topic: 'Geliştiricilerin genel sohbeti' },
    { n: 'yardım', cat: 'Topluluk', forum: 1, topic: 'Her soru ayrı başlık: kodunu ve hata mesajını ekle' },
    { n: 'botunu-tanıt', cat: 'Topluluk', forum: 1, topic: 'Yaptığın botu tanıt, ekleme linkini paylaş' },
    { n: 'fikirler', cat: 'Topluluk', forum: 1, topic: 'API ve SDK için istekler' },
    { n: 'kanka-js', cat: 'Teknik', topic: 'JavaScript SDK (kanka.js)' },
    { n: 'kanka-py', cat: 'Teknik', topic: 'Python SDK (kanka.py)' },
    { n: 'test-alanı', cat: 'Teknik', topic: 'Botlarını burada dene, spam serbest' },
    { n: 'hata-bildirimi', cat: 'Teknik', topic: 'API ya da SDK hatası mı buldun? Adımları yaz' },
    { n: 'Kod Sohbeti', cat: 'Sesli', v: 1 }, { n: 'Birlikte Kodlayalım', cat: 'Sesli', v: 1 },
  ];
  for (const c of CH) { const ch = { id: id(), name: c.n, type: c.v ? 'voice' : c.forum ? 'forum' : 'text' }; if (c.cat) ch.category = c.cat; if (c.ro) ch.readonly = true; if (c.topic) ch.topic = c.topic; if (/^(duyurular|değişiklik-günlüğü)$/.test(c.n)) ch.news = true; s.channels.push(ch); }
  migrateCats(s);
  const chId = n => s.channels.find(c => c.name === n)?.id;
  s.welcome = { enabled: true, message: 'Kanka Geliştiriciler\'e hoş geldin! Bot yazmaya yeni başlıyorsan belgelerle başla: kankahq.com/gelistirici',
    rules: ['Saygılı ol; herkes bir yerden başladı.', 'Soru sorarken kodunu ve tam hata mesajını ekle.', 'Token, şifre ya da anahtar paylaşma. Paylaştıysan hemen yenile.', 'Reklam ve bot tanıtımı sadece #botunu-tanıt kanalında.', 'Bot denemelerini #test-alanı kanalında yap.'],
    channels: [[chId('duyurular'), 'API ve SDK duyuruları'], [chId('yardım'), 'Takıldığın yeri sor'], [chId('botunu-tanıt'), 'Botunu göster']].filter(x => x[0]).map(([id, desc]) => ({ id, desc })) };
  db.servers.push(s); db.devServer = s.id;
  for (const a of Object.values(db.apps || {})) devRoleSync(a.owner);
  save(); console.log('Kanka Geliştiriciler sunucusu kuruldu:', s.id);
}
// Botu doğrulanmış geliştiricilere sunucuda "Doğrulanmış Geliştirici" rolü (doğrulama kalkarsa rol de kalkar)
function devRoleSync(name) {
  const s = db.devServer && db.servers.find(x => x.id === db.devServer); if (!s || !name || !s.members.includes(name)) return;
  const r = s.customRoles.find(x => x.name === DEV_ROLES.dogru); if (!r) return;
  const has = Object.values(db.apps || {}).some(a => a.owner === name && a.verified && !a.killed);
  const cur = s.memberRoles[name] || [], on = cur.includes(r.id);
  if (has && !on) s.memberRoles[name] = [...cur, r.id]; else if (!has && on) s.memberRoles[name] = cur.filter(x => x !== r.id); else return;
  try { pushServers([name]); } catch {}
}
app.get('/gelistirici-topluluk', (req, res) => { const s = db.devServer && db.servers.find(x => x.id === db.devServer); res.redirect(s ? '/app?davet=' + encodeURIComponent(s.invite) : '/gelistirici'); });
ensureDevServer();
// Geçici üyelik: geçici davetle gelen kişi bağlantısı kopunca (ve kendisine rol verilmemişse) sunucudan çıkarılır
setInterval(() => {
  const on = new Set(onlineNames()); let ch = false;
  for (const s of db.servers) {
    if (!s.temp) continue;
    for (const n of Object.keys(s.temp)) {
      if (!s.members.includes(n) || (s.memberRoles?.[n] || []).length) { delete s.temp[n]; ch = true; continue; }
      if (on.has(n) || Date.now() - s.temp[n] < 60e3) continue;
      if ([...voice.values()].some(m => [...m.values()].includes(n))) continue;
      s.members = s.members.filter(x => x !== n); wipeMember(s, n); ch = true;
      try { pushServers([n, ...s.members]); } catch {}
    }
    if (!Object.keys(s.temp).length) delete s.temp;
  }
  if (ch) save();
}, 60e3);
migrateUids();
server.listen(PORT, () => console.log(`Kanka Chat çalışıyor: http://localhost:${PORT}`));
