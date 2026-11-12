// Kanka Chat sunucusu (v0.4)
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

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

app.use('/uploads', express.static(UPLOADS, { maxAge: '30d' }));
app.use('/indir', express.static(path.join(__dirname, 'indir'), { setHeaders: res => res.set('Content-Disposition', 'attachment') }));
app.use(express.json({ limit: '8kb' }));

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
  'bf2042': ['Battlefield 2042', ''], 'bf6': ['Battlefield 6', ''], 'Minecraft Launcher': ['Minecraft', 'Başlatıcıda'],
};
app.get('/api/presence/games', (req, res) => res.json(GAME_PROCS));
const STARTED = Date.now();
app.get('/api/davet/:code', (req, res) => {
  const s = db.servers.find(x => x.invite === req.params.code);
  if (!s) return res.status(404).json({ error: 'Davet geçersiz ya da süresi dolmuş' });
  const mem = membersOf(s), on = new Set(onlineNames());
  res.json({ name: s.name, icon: s.icon, iconImg: s.iconImg || null, badges: srvBadges(s), description: s.description || '', banner: s.banner || null, bannerColor: s.bannerColor || null, members: mem.length, online: mem.filter(n => on.has(n)).length });
});
app.get('/davet/:code', (req, res) => res.redirect('/?davet=' + encodeURIComponent(req.params.code)));
app.get('/kod/:code', (req, res) => res.redirect('/?kod=' + encodeURIComponent(req.params.code)));
for (const [u, f] of [['/gizlilik', 'gizlilik.html'], ['/kosullar', 'kosullar.html'], ['/kvkk', 'gizlilik.html']]) app.get(u, (req, res) => res.sendFile(path.join(__dirname, 'public', f)));
app.get('/api/surum', (req, res) => {
  let sha = null;
  try { sha = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'guncelleme.json'), 'utf8')).sha; } catch {}
  res.json({ surum: sha ? sha.slice(0, 7) : 'yerel', baslama: STARTED });
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
  if (f) for (const n of membersOf(f.s)) if (n !== u.name) io.to('user:' + n).emit('chanActivity', { channelId: chId, serverId: f.s.id });
}
app.post('/api/presence', express.json({ limit: '24kb' }), async (req, res) => {
  const { key, game, detail, music, rich } = req.body || {};
  const u = key && Object.values(db.users).find(x => x.presenceKey === key);
  if (!u) return res.status(401).json({ error: 'Anahtar geçersiz' });
  if (Array.isArray(req.body.matches) && u.matchShare?.on !== false) {
    const seen = (u.matchKeys ||= []);
    for (const raw of req.body.matches.slice(0, 5)) {
      const m = cleanMatch(raw); if (!m || seen.includes(m.key)) continue;
      seen.push(m.key); if (seen.length > 30) seen.shift();
      try { deliverMatch(u, m); } catch (e) { console.error('maç kartı', e); }
    }
  }
  const prev = u.auto && Date.now() - u.auto.at < 45e3 ? u.auto : {}, now = Date.now();
  const g = typeof game === 'string' && game.trim() ? clean(game, 60) : null;
  const m = music && typeof music.title === 'string' && music.title.trim() ? { title: clean(music.title, 120), artist: clean(music.artist, 120), album: clean(music.album, 120) || null } : null;
  if (m) {
    const dur = +music.dur, pos = +music.pos, same = prev.music?.title === m.title && prev.music?.artist === m.artist;
    if (dur > 1000 && dur < 3600e3 && pos >= 0 && pos <= dur) { m.dur = Math.round(dur); m.start = now - Math.round(pos); if (same && prev.music.start && Math.abs(prev.music.start - m.start) < 3000) m.start = prev.music.start; }
    else m.start = same ? prev.music.start : now;
    m.art = same ? prev.music.art : null;
  }
  const r = g ? cleanRich(rich) : null;
  const next = { at: now,
    game: g ? { name: g, detail: clean(detail, 40), start: prev.game?.name === g ? prev.game.start : now, ...(r ? { rich: r } : {}) } : null,
    music: m };
  const sig = x => JSON.stringify([x.game?.name, x.game?.detail, x.game?.rich && { ...x.game.rich }, x.music?.title, x.music?.artist, x.music?.start]);
  const changed = sig(prev) !== sig(next) || !prev.at;
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
let db = { users: {}, sessions: {}, servers: [], messages: {}, playlists: {} };
if (fs.existsSync(DATA_FILE)) {
  try { Object.assign(db, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch (e) { console.error('data.json okunamadı', e); }
}
// Sıfırlama: klasörde SIFIRLA.txt varsa her şey silinir ve uygulama sıfırdan başlar
const RESET_FLAG = path.join(DATA_DIR, 'SIFIRLA.txt');
if (fs.existsSync(RESET_FLAG)) {
  db = { users: {}, sessions: {}, servers: [], messages: {}, playlists: {} };
  for (const f of fs.readdirSync(UPLOADS)) { try { fs.unlinkSync(path.join(UPLOADS, f)); } catch {} }
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  fs.unlinkSync(RESET_FLAG);
  console.log('Tüm veriler sıfırlandı.');
}
for (const k of ['users', 'sessions', 'messages', 'playlists']) db[k] ||= {};
db.servers ||= [];
if (!db.servers.find(s => s.id === 's1')) {
  db.servers.unshift({ id: 's1', name: 'Kanka HQ', icon: 'K', channels: [{ id: 'c1', name: 'genel' }, { id: 'c2', name: 'duyurular' }, { id: 'c3', name: 'oyun' }] });
}
for (const s of db.servers) {
  s.members ||= [];
  s.invite ||= crypto.randomBytes(4).toString('hex');
  s.public = s.id === 's1' || (!s.owner && !s.members.length); // hesaplardan önce açılan sunucular herkese açık kalsın
  s.roles ||= {}; s.customRoles ||= []; s.memberRoles ||= {}; s.bans ||= {}; s.timeouts ||= {};
  for (const c of s.channels) c.type ||= 'text';
  if (s.id === 's1' && !s.channels.some(c => c.type === 'voice')) s.channels.push({ id: 'v1', name: 'Sohbet', type: 'voice' });
  // Resmi sunucunun afişi ve simgesi (bir kez uygulanır; yönetici sonra değiştirebilir)
  if (s.id === 's1' && !s.brandV1) { s.banner ||= '/marka/hq-afis.png'; s.iconImg ||= '/marka/hq-simge.png'; s.brandV1 = true; }
  if (s.id === 's1' && !s.brandV2) { if (s.banner === '/marka/hq-afis.png') s.banner = '/marka/hq-afis.gif'; if (s.iconImg === '/marka/hq-simge.png') s.iconImg = '/marka/hq-simge.gif'; s.brandV2 = true; } // hareketli sürüm
}

function ensureOwners() {
  const first = Object.values(db.users).filter(u => u.name !== 'Claude').sort((a, b) => a.createdAt - b.createdAt)[0];
  for (const s of db.servers) if (!s.owner && first) s.owner = first.name;
}
ensureOwners();
for (const u of Object.values(db.users)) delete u.manual; // elle etkinlik kaldırıldı

// ---------- Gece yedeği: her gün bir kopya, son 7 gün saklanır ----------
const BACKUPS = path.join(DATA_DIR, 'yedekler');
function backup() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    fs.mkdirSync(BACKUPS, { recursive: true });
    const f = path.join(BACKUPS, `data-${new Date().toISOString().slice(0, 10)}.json`);
    if (!fs.existsSync(f)) { fs.copyFileSync(DATA_FILE, f); console.log('Yedek alındı:', path.basename(f)); }
    const all = fs.readdirSync(BACKUPS).filter(n => /^data-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
    for (const old of all.slice(0, Math.max(0, all.length - 7))) fs.unlinkSync(path.join(BACKUPS, old));
  } catch (e) { console.error('Yedek alınamadı', e.message); }
}
backup(); setInterval(backup, 60 * 60e3);

// ---------- Kötüye kullanım koruması ----------
const limits = new Map();
// key için pencere içinde en fazla max deneme; aşılırsa kalan bekleme süresini (sn) döndürür
function limited(key, max, windowMs) {
  const now = Date.now(), arr = (limits.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) { limits.set(key, arr); return Math.ceil((windowMs - (now - arr[0])) / 1000); }
  arr.push(now); limits.set(key, arr); return 0;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of limits) if (!v.length || now - v[v.length - 1] > 3600e3) limits.delete(k); }, 600e3);

// ---------- TURN: farklı ağlardaki kişiler sesli odada birbirini duysun ----------
const TURN_FILE = path.join(DATA_DIR, 'turn.json');
let turnInfo = null;
async function startTurn() {
  if (process.env.TURN === 'off' || (process.platform !== 'win32' && process.env.TURN !== 'on')) return;
  try {
    const Turn = require('node-turn');
    let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(TURN_FILE, 'utf8')); } catch {}
    if (!cfg.pass) { cfg = { user: 'kanka', pass: crypto.randomBytes(16).toString('hex') }; fs.writeFileSync(TURN_FILE, JSON.stringify(cfg)); }
    let ip = process.env.PUBLIC_IP;
    if (!ip) { const r = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(8000) }); ip = (await r.text()).trim(); }
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) throw new Error('Genel IP bulunamadı');
    if (process.platform === 'win32') { // güvenlik duvarında TURN portlarını aç (bir kez)
      const { execFileSync } = require('child_process');
      try { execFileSync('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=Kanka Chat TURN'], { stdio: 'ignore' }); }
      catch { try { execFileSync('netsh', ['advfirewall', 'firewall', 'add', 'rule', 'name=Kanka Chat TURN', 'dir=in', 'action=allow', 'protocol=UDP', 'localport=3478,50000-50200'], { stdio: 'ignore' }); } catch {} }
    }
    const server = new Turn({ authMech: 'long-term', credentials: { [cfg.user]: cfg.pass }, realm: 'kanka', listeningPort: 3478, minPort: 50000, maxPort: 50200, externalIps: ip, debugLevel: 'OFF' });
    server.start();
    turnInfo = { urls: [`turn:${ip}:3478?transport=udp`], username: cfg.user, credential: cfg.pass };
    console.log('TURN sunucusu çalışıyor:', ip + ':3478');
  } catch (e) { console.error('TURN başlatılamadı:', e.message); }
}
startTurn();
const iceServers = () => [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }, ...(turnInfo ? [turnInfo] : [])];

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(DATA_FILE, JSON.stringify(db, null, 2), () => {}), 300);
}

// ---------- Yardımcılar ----------
const id = () => crypto.randomBytes(5).toString('hex');
const clean = (s, max) => String(s ?? '').trim().slice(0, max);
const COLORS = ['#ff7a59', '#f6c445', '#4cc38a', '#4aa8ff', '#b07cff', '#ff6b9a', '#2fd3c3', '#ff9f43'];
const NAME_RE = /^[\p{L}\p{N}_.-]{2,20}$/u;
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const level = xp => Math.floor(Math.sqrt((xp || 0) / 5)) + 1;
// Profil: çerçeveler (seviyeyle açılır) ve sosyal bağlantılar
const FRAMES = { halka: 2, gokkusagi: 5, ates: 10, neon: 15, altin: 25, kurucu: 0 };
const SOCIALS = ['instagram', 'tiktok', 'youtube', 'x', 'twitch', 'steam', 'spotify'];
const kurucuOk = u => Object.values(db.users).filter(x => (x.createdAt || 0) < (u.createdAt || 0)).length < 100;
const frameOk = (u, f) => f === 'none' || (f in FRAMES && (f === 'kurucu' ? kurucuOk(u) : level(u.xp) >= FRAMES[f]));
const HEX = /^#[0-9a-f]{6}$/i;
const pubUser = u => ({ displayName: u.displayName || '', pronouns: u.pronouns || '', theme: u.theme || null, bannerImg: u.bannerImg || null, frame: u.frame || null, socials: u.socials || {}, kurucu: kurucuOk(u), name: u.name, color: u.color, xp: u.xp || 0, level: level(u.xp), avatar: u.avatar || null, status: u.status || '', bio: u.bio || '', banner: u.banner || null, createdAt: u.createdAt || null,
  birthday: u.birthday || null, music: u.music || null, activities: activitiesOf(u), badges: badgesOf(u), streak: u.streak?.count || 0, friendCount: (u.friends || []).length });
const social = n => { const u = db.users[n] || {}; return { friends: u.friends || [], reqIn: u.reqIn || [], reqOut: u.reqOut || [], blocked: u.blocked || [] }; };
const pushSocial = (...names) => names.forEach(n => io.to('user:' + n).emit('social', social(n)));
const allUsers = () => Object.values(db.users).map(pubUser);

const serversFor = name => db.servers.filter(s => (s.public || s.members.includes(name)) && !s.bans?.[name]);
// ---------- Roller ve izinler ----------
const PERMS = ['manageServer', 'manageRoles', 'manageChannels', 'manageMessages', 'kick', 'ban', 'timeout', 'mentionEveryone'];
const MOD_PERMS = ['manageChannels', 'manageMessages', 'kick', 'timeout', 'mentionEveryone'];
function permsOf(s, n) {
  if (s.owner === n) return new Set(PERMS);
  const p = new Set(s.roles?.[n] === 'mod' ? MOD_PERMS : []);
  for (const rid of s.memberRoles?.[n] || []) for (const x of s.customRoles.find(r => r.id === rid)?.perms || []) p.add(x);
  return p;
}
const can = (s, n, perm) => permsOf(s, n).has(perm);
const rankOf = (s, n) => s.owner === n ? 1e9 : Math.max(s.roles?.[n] === 'mod' ? 500 : 0, ...(s.memberRoles?.[n] || []).map(rid => { const i = s.customRoles.findIndex(r => r.id === rid); return i < 0 ? 0 : 1000 - i; }));
const outranks = (s, a, b) => s.owner === a || rankOf(s, a) > rankOf(s, b);
const timedOut = (s, n) => (s.timeouts?.[n] || 0) > Date.now();
// ---------- Kategoriler ve oda izinleri ----------
// Her oda/kategori: perms = { '@everyone' | rolId: { view, send, connect } } (true izin, false yasak, yoksa devral)
// Eşitlenmiş oda (sync) kategorisinin izinlerini kullanır.
const CH_KEYS = ['view', 'send', 'connect', 'attach', 'react', 'mention', 'manage', 'stream', 'speak'];
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
  const val = k => { let v = def(k); const e = ov['@everyone']?.[k]; if (e !== undefined) v = e;
    const rs = s.memberRoles?.[n] || [];
    if (rs.some(r => ov[r]?.[k] === false)) v = false;
    if (rs.some(r => ov[r]?.[k] === true)) v = true;
    const u = ov['u:' + n]?.[k]; if (u !== undefined) v = u;
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
const PERM_TR = { view: 'görme', send: 'yazma', connect: 'bağlanma', attach: 'dosya', react: 'tepki', mention: '@herkes', manage: 'mesaj yönetimi', stream: 'yayın', speak: 'konuşma' };
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
function chView(s, c, viewer, manager) {
  const ov = ovOf(s, c);
  const P = k => viewer ? chPerm(s, c, viewer, k) : true;
  const v = { id: c.id, name: c.name, type: c.type || 'text', cat: c.cat || null, sync: !!c.sync,
    topic: c.topic || '', slow: c.slow || 0, limit: c.limit || 0, bitrate: c.bitrate || 'std', news: !!c.news, followers: (c.followers || []).length,
    stage: c.type === 'stage' && stage.has(c.id) ? stageView(c.id) : undefined,
    canAttach: P('attach'), canReact: P('react'), canMention: P('mention'), canManage: P('manage'), canStream: P('stream'), canSpeak: P('speak'),
    private: everyoneDenied(ov, 'view'), ann: everyoneDenied(ov, 'send'), locked: voiceLike(c.type) && everyoneDenied(ov, 'connect'),
    readonly: viewer ? !chPerm(s, c, viewer, 'send') : false, canConnect: viewer ? chPerm(s, c, viewer, 'connect') : true };
  if (manager) v.perms = c.perms || {};
  return v;
}
for (const s of db.servers) migrateCats(s);
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

// ---------- Sunucu rozetleri ----------
// resmi: Kanka HQ · dogrulanmis/partner: site yöneticisi verir · topluluk: 15+ üye ve 7+ gün
const siteAdmin = n => !!n && (db.servers.find(x => x.id === 's1')?.owner === n || (db.siteAdmins || []).includes(n));
function srvBadges(s) {
  const b = [];
  if (s.id === 's1') b.push({ id: 'resmi', since: s.createdAt || null });
  for (const id of ['dogrulanmis', 'partner']) if (s.badges?.[id]) b.push({ id, by: s.badges[id].by, since: s.badges[id].time });
  const age = Date.now() - (s.createdAt || 0);
  if (s.id !== 's1' && membersOf(s).length >= 15 && (!s.createdAt || age > 7 * 864e5)) b.push({ id: 'topluluk' });
  return b;
}
const serverView = (s, viewer) => (s.customRoles ||= [], s.memberRoles ||= {}, s.bans ||= {}, s.timeouts ||= {}, {
  id: s.id, name: s.name, icon: s.icon, iconImg: s.iconImg || null, banner: s.banner || null, bannerColor: s.bannerColor || null, owner: s.owner || null, invite: s.invite, public: s.public, roles: s.roles,
  emojis: s.emojis || {}, filter: !!s.filter, slow: s.slow || 0,
  channels: (viewer ? s.channels.filter(c => seesChannel(s, c, viewer)) : s.channels).map(c => chView(s, c, viewer, viewer && can(s, viewer, 'manageChannels'))),
  categories: (s.categories || []).filter(k => !viewer || can(s, viewer, 'manageChannels') || s.channels.some(c => c.cat === k.id && seesChannel(s, c, viewer)))
    .map(k => ({ id: k.id, name: k.name, ...(viewer && can(s, viewer, 'manageChannels') ? { perms: k.perms || {} } : {}) })), members: s.public ? Object.keys(db.users) : s.members,
  customRoles: s.customRoles, memberRoles: s.memberRoles, timeouts: Object.fromEntries(Object.entries(s.timeouts || {}).filter(([, t]) => t > Date.now())),
  bans: viewer && (s.owner === viewer || can(s, viewer, 'ban')) ? s.bans : {}, myPerms: viewer ? [...permsOf(s, viewer)] : [],
  badges: srvBadges(s), createdAt: s.createdAt || null, siteAdmin: siteAdmin(viewer),
  discoverable: !!s.discoverable, description: s.description || '', category: s.category || null,
  setup: viewer && s.owner === viewer ? setupOf(s) : null,
  afk: s.afk || null,
  welcome: s.welcome || null, accepted: !s.welcome?.enabled || !!s.accepted?.[viewer] || s.owner === viewer
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
  if (chId.startsWith('dm:')) return dmPeers(chId).includes(name);
  if (chId.startsWith('g:')) return !!groupOf(chId)?.members.includes(name);
  const f = findChannel(chId);
  return !!f && (f.c.type === 'text' || f.c.type === 'forum') && (f.s.public || f.s.members.includes(name)) && !f.s.bans?.[name] && seesChannel(f.s, f.c, name);
}
function dmsFor(name) {
  const dms = Object.keys(db.messages)
    .filter(k => k.startsWith('dm:') && dmPeers(k).includes(name) && db.messages[k].length)
    .map(k => ({ id: k, with: dmPeers(k).find(n => n !== name) || name, last: db.messages[k].at(-1).time }));
  const groups = Object.values(db.groups || {}).filter(g => g.members.includes(name))
    .map(g => ({ id: 'g:' + g.id, group: true, name: g.name, members: g.members, owner: g.owner, last: db.messages['g:' + g.id]?.at(-1)?.time || g.created }));
  return [...dms, ...groups].sort((a, b) => b.last - a.last);
}
const groupTitle = g => g.name || g.members.slice(0, 4).join(', ');
const findMsg = (chId, msgId) => (db.messages[chId] || []).find(m => m.id === msgId);
const roleOf = (s, n) => s.owner === n ? 'admin' : (s.roles?.[n] || 'member');
const isMod = (s, n) => ['admin', 'mod'].includes(roleOf(s, n)) || can(s, n, 'manageChannels');
const serverOf = chId => chId && !isPrivateChat(chId) ? findChannel(chId)?.s : null;
const UPLOAD_RE = /^\/uploads\/[a-f0-9]+\.(png|jpe?g|gif|webp)$/;
// Hazır rakun avatarları (public/avatar)
const PRESET_AV = ['klasik', 'kulaklik', 'gunes-gozlugu', 'tac', 'kep', 'parti', 'bere', 'papyon', 'bandana', 'astronot', 'sihirbaz', 'kalp'].map(k => `/avatar/rakun-${k}.svg`);
const AVATAR_OK = a => UPLOAD_RE.test(a) || PRESET_AV.includes(a);
// Başlangıç rehberi: bu tarihten önce açılmış hesaplara gösterilmez
const ONB_SINCE = Date.parse('2026-11-11T15:00:00Z');
const onbPush = (name, ob) => io.to('user:' + name).emit('onb', ob);
const onbFlag = (name, k) => { const u = db.users[name]; if (!u) return; const ob = onbOf(u); if (ob.done || ob[k]) return; ob[k] = true; save(); onbPush(name, ob); };
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
  const ch = s.channels.find(c => c.type === 'text'); if (!ch) return;
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
  const ch = s.channels.find(c => c.type === 'text');
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
const slowMap = new Map();
const BAD = ['amk', 'aq', 'orospu', 'piç', 'siktir', 'sik', 'yarrak', 'göt', 'ananı', 'amına', 'oç', 'pezevenk', 'kahpe', 'gavat', 'fuck', 'shit', 'bitch'];
const BAD_RE = new RegExp(`(?<![\\p{L}])(${BAD.join('|')})(?![\\p{L}])`, 'giu');
const filterText = t => t.replace(BAD_RE, w => '★'.repeat([...w].length));
function audit(s, by, action, target = '') {
  (s.audit ||= []).unshift({ time: Date.now(), by, action, target });
  s.audit.length = Math.min(s.audit.length, 200);
}
const ymd = (d = new Date()) => d.toISOString().slice(0, 10);
const BADGES = {
  erken: ['🌱', 'Erken kanka', 'İlk 100 üyeden biri'],
  gece: ['🦉', 'Gece kuşu', 'Gece 00:00-05:00 arası mesaj attı'],
  sohbet: ['💬', 'Geveze', '100+ mesaj'],
  efsane: ['👑', 'Efsane', '1000+ mesaj'],
  xox: ['⭕', 'XOX şampiyonu', '3 XOX oyunu kazandı'],
  seri7: ['🔥', 'Ateşli seri', '7 gün üst üste giriş'],
  kurucu: ['🏰', 'Kurucu', 'Bir sunucu kurdu'],
  sosyal: ['🤝', 'Sosyal kelebek', '5+ arkadaş'],
  caylak: ['🐣', 'Çaylak', 'Başlangıç rehberini bitirdi'],
};
function badgesOf(u) {
  const order = Object.values(db.users).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).map(x => x.name);
  const b = [];
  if (order.indexOf(u.name) < 100) b.push('erken');
  if (u.night) b.push('gece');
  if ((u.msgs || u.xp || 0) >= 100) b.push('sohbet');
  if ((u.msgs || u.xp || 0) >= 1000) b.push('efsane');
  if ((u.xoxWins || 0) >= 3) b.push('xox');
  if ((u.streak?.best || 0) >= 7) b.push('seri7');
  if (db.servers.some(s => s.owner === u.name && !s.public)) b.push('kurucu');
  if ((u.friends || []).length >= 5) b.push('sosyal');
  if (u.onb?.rewarded) b.push('caylak');
  return b;
}

// ---------- Çevrimiçi ve ses durumu ----------
const online = new Map();            // socket.id -> kullanıcı adı
const voice = new Map();             // kanal id -> Map(socket.id -> ad)
const onlineNames = () => [...new Set(online.values())];
const idleSockets = new Set();
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
function sendPush(name, payload) {
  const u = db.users[name]; if (!webpush || !u?.push?.length) return;
  if ((u.presence || 'online') === 'dnd') return;
  if ([...online].some(([sid, n]) => n === name && visibleSockets.has(sid))) return; // şu an Kanka'ya bakıyor
  const body = JSON.stringify(payload);
  for (const sub of [...u.push]) {
    webpush.sendNotification(sub, body, { TTL: 3600, urgency: 'high', topic: (payload.tag || 'kanka').replace(/[^\w-]/g, '').slice(0, 32) || undefined }).catch(err => {
      if (err?.statusCode === 404 || err?.statusCode === 410) { u.push = (u.push || []).filter(x => x.endpoint !== sub.endpoint); save(); }
    });
  }
}
function notifyUser(name, n) {
  io.to('user:' + name).emit('notify', n);
  const title = n.friend ? n.from : n.dm && n.channelId?.startsWith('g:') ? `${n.from} · ${n.where}` : n.dm ? n.from : `${n.from} seni etiketledi`;
  sendPush(name, { title, body: n.friend ? 'sana arkadaşlık isteği gönderdi' : String(n.text || '').slice(0, 160) + (n.dm ? '' : n.where ? `\n${n.where}` : ''),
    tag: n.channelId || (n.friend ? 'friends' : 'kanka'), ch: n.channelId || null, from: n.from, dm: !!n.dm, friend: !!n.friend });
}
const presenceList = () => onlineNames().map(n => [n, statusOf(n)]).filter(x => x[1]);
const voiceState = () => Object.fromEntries([...voice].filter(([k]) => !k.startsWith('call:')).map(([k, m]) => [k, [...new Set(m.values())]]));
const pushPresence = () => io.emit('presence', presenceList());
const voiceMedia = new Map();       // socket.id -> { cam, screen } (yayın rozetleri için)
const liveState = () => { const o = {}; for (const [ch, m] of voice) { if (ch.startsWith('call:')) continue; const l = [...m].filter(([sid]) => voiceMedia.get(sid)?.screen).map(([, n]) => n); if (l.length) o[ch] = l; } return o; };
// Odadakileri sesten çıkar (oda silindi, sunucudan atıldı vb.)
function voiceKick(chIds, onlyName, reason) {
  let any = false;
  for (const ch of chIds) {
    const room = voice.get(ch); if (!room) continue;
    for (const [sid, n] of [...room]) {
      if (onlyName && n !== onlyName) continue;
      any = true; room.delete(sid); voiceMedia.delete(sid); voiceFlags.delete(sid);
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
const flagsState = () => { const o = {}; for (const [ch, room] of voice) { if (ch.startsWith('call:')) continue; for (const [sid, n] of room) { const f = voiceFlags.get(sid) || {}, md = voiceMedia.get(sid) || {}; if (f.m || md.cam || md.screen) (o[ch] ||= {})[n] = { m: !!f.m, cam: !!md.cam, screen: !!md.screen }; } } return o; };
const pushVoice = () => { io.emit('voiceState', voiceState()); io.emit('voiceLive', liveState()); io.emit('voiceFlags', flagsState()); };
function pushServers(names) {
  for (const n of names) io.to('user:' + n).emit('servers', serversFor(n).map(s => serverView(s, n)));
}
const membersOf = s => s.public ? Object.keys(db.users) : s.members;

function postMessage(me, chId, p = {}) {
  const u = db.users[me];
  const msg = { id: id(), author: me, color: u.color, time: Date.now(), kind: 'text', reactions: {} };
  const kind = p.kind || 'text';
  if (p.scheduled) msg.scheduled = true;
  { const f0 = findChannel(chId); if (f0?.c?.type === 'forum' && p.title) msg.title = clean(p.title, 100); }
  if (p.xfrom && typeof p.xfrom === 'object') msg.xfrom = { server: clean(p.xfrom.server, 40), channel: clean(p.xfrom.channel, 30), icon: clean(p.xfrom.icon, 4), iconImg: UPLOAD_RE.test(p.xfrom.iconImg || '') ? p.xfrom.iconImg : null };

  if (kind === 'text') {
    msg.text = clean(p.text, 2000);
    if (p.image && UPLOAD_RE.test(p.image)) msg.image = p.image;
    if (p.audio && AUDIO_RE.test(p.audio)) { msg.audio = p.audio; msg.duration = Math.min(Math.max(+p.duration || 0, 0), 600); }
    if (!msg.text && !msg.image && !msg.audio) return ({ error: 'Boş mesaj' });
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
    if (r) msg.replyTo = { id: r.id, author: r.author, text: (r.text || r.plan?.title || r.poll?.question || r.song?.title || 'görsel').slice(0, 100) };
  }

  const list = (db.messages[chId] ||= []);
  list.push(msg);
  if (list.length > 2000) list.shift();
  // Takip edilebilir duyuru odası: takipçi odalara kopyala
  { const f1 = p.xfrom ? null : findChannel(chId);
    if (f1?.c.news && f1.c.followers?.length) setTimeout(() => {
      f1.c.followers = f1.c.followers.filter(fw => { const d = findChannel(fw.c); return d && d.s.id === fw.s; });
      for (const fw of f1.c.followers) postMessage(me, fw.c, { kind: 'text', text: msg.text, image: msg.image, xfrom: { server: f1.s.name, channel: f1.c.name, icon: f1.s.icon, iconImg: f1.s.iconImg } });
    }, 0); }

  // Seviye
  const before = level(u.xp);
  u.xp = (u.xp || 0) + 1;
  u.msgs = (u.msgs || 0) + 1;
  const hr = new Date().getHours(); if (hr >= 0 && hr < 5) u.night = true;
  save();
  io.to(chId).emit('message', { channelId: chId, msg });
  io.to('user:' + me).emit('users', allUsers());

  if (level(u.xp) > before) {
    const sys = { id: id(), kind: 'system', time: Date.now(), text: `${me} seviye ${level(u.xp)} oldu!`, reactions: {} };
    list.push(sys);
    io.to(chId).emit('message', { channelId: chId, msg: sys });
    io.emit('users', allUsers());
  }

  // Bildirimler
  const where = chId.startsWith('dm:') ? 'özel mesaj' : chId.startsWith('g:') ? groupTitle(groupOf(chId)) : (() => { const f = findChannel(chId); return `${f.s.name} › ${f.c.name}`; })();
  const preview = (msg.text || msg.plan?.title || msg.poll?.question || msg.song?.title || (msg.game ? 'bir oyun başlattı' : 'görsel gönderdi')).slice(0, 120);
  if (isPrivateChat(chId)) {
    for (const n of chatMembers(chId)) {
      io.to('user:' + n).emit('dms', dmsFor(n));
      if (n !== me) notifyUser(n, { from: me, text: preview, channelId: chId, where, dm: true });
    }
  } else {
    const f = findChannel(chId);
    for (const n of membersOf(f.s)) if (n !== me) io.to('user:' + n).emit('chanActivity', { channelId: chId, serverId: f.s.id });
    const mentioned = new Set([...(msg.text || '').matchAll(/@([\p{L}\p{N}_.-]+)/gu)].map(m => m[1]));
    if (/@(everyone|herkes)\b/i.test(msg.text || '') && can(f.s, me, 'mentionEveryone')) { membersOf(f.s).forEach(n => mentioned.add(n)); msg.everyone = true; }
    for (const r of f.s.customRoles || []) if ((msg.text || '').includes('@' + r.name)) for (const [n, rs] of Object.entries(f.s.memberRoles)) if (rs.includes(r.id)) mentioned.add(n);
    for (const n of mentioned) {
      if (n !== me && db.users[n] && canAccess(n, chId))
        notifyUser(n, { from: me, text: preview, channelId: chId, where, mention: true });
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
const userCount = () => Object.keys(db.users).filter(n => n !== 'Claude').length;
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
  if (invite && db.servers.some(s => s.invite === invite && !s.public)) return { ok: true, via: 'invite' };
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
let mailCfg = null; try { mailCfg = JSON.parse(fs.readFileSync(MAIL_FILE, 'utf8')); } catch {}
if (!mailCfg && process.env.SMTP_USER) mailCfg = { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS, host: process.env.SMTP_HOST || '', url: process.env.PUBLIC_URL || '' };
let mailer = null;
function getMailer() {
  if (!mailCfg?.user || !mailCfg?.pass) return null;
  if (mailer) return mailer;
  try {
    const nm = require('nodemailer');
    mailer = nm.createTransport(mailCfg.host ? { host: mailCfg.host, port: +mailCfg.port || 465, secure: (+mailCfg.port || 465) === 465, auth: { user: mailCfg.user, pass: mailCfg.pass } }
      : { service: 'gmail', auth: { user: mailCfg.user, pass: mailCfg.pass } });
  } catch (e) { console.error('E-posta modülü yüklenemedi:', e.message); return null; }
  return mailer;
}
// Linkler istekteki adrese göre değil, yönetimin kaydettiği adrese göre kurulur (link zehirlemesine karşı)
const baseUrl = () => (mailCfg?.url || process.env.PUBLIC_URL || 'https://185-208-172-60.sslip.io').replace(/\/+$/, '');
const mailHtml = (title, body, btn, url) => `<!doctype html><html><body style="margin:0;background:#17120f;font-family:Segoe UI,Arial,sans-serif;color:#f3e9e1">
<div style="max-width:480px;margin:0 auto;padding:36px 22px"><div style="font-size:22px;font-weight:800;color:#ff8a4c;margin-bottom:22px">🦝 Kanka Chat</div>
<div style="background:#231b17;border:1px solid #3a2e27;border-radius:20px;padding:28px"><h1 style="font-size:20px;margin:0 0 12px">${title}</h1><div style="font-size:15px;line-height:1.6;color:#d8c9bd">${body}</div>
${btn ? `<a href="${url}" style="display:inline-block;margin-top:22px;background:#ff8a4c;color:#1b130f;font-weight:800;text-decoration:none;padding:13px 22px;border-radius:12px">${btn}</a>` : ''}</div>
<p style="font-size:12px;color:#8c7b6f;margin-top:18px">Bu e-postayı Kanka Chat gönderdi. Sen istemediysen görmezden gelebilirsin.</p></div></body></html>`;
async function sendMail(to, subject, html) {
  const t = getMailer(); if (!t) return false;
  try { await t.sendMail({ from: `"Kanka Chat" <${mailCfg.from || mailCfg.user}>`, to, subject, html }); return true; }
  catch (e) { console.error('E-posta gönderilemedi:', e.message); return false; }
}
const findUserBy = who => { who = clean(who, 190).toLowerCase(); return who && Object.values(db.users).find(u => u.name.toLowerCase() === who || (u.email && u.email === who)); };
function resetToken(name, hours) {
  for (const [t, r] of Object.entries(db.resets)) if (r.name === name || r.exp < Date.now()) delete db.resets[t];
  const t = crypto.randomBytes(24).toString('hex'); db.resets[t] = { name, exp: Date.now() + hours * 3600e3 }; save();
  return t;
}
async function sendInviteMail(email, code) {
  return sendMail(email, 'Kanka Chat davetin geldi 🎉', mailHtml('Sıra sende kanka!', `Bekleme listesinden çıktın. Davet kodun: <b style="font-size:18px;color:#fff;letter-spacing:1px">${code}</b><br><br>Aşağıdaki butona basınca kod otomatik yazılır.`, 'Hesabımı oluştur', `${baseUrl()}/kod/${code}`));
}

// ---------- Şikayetler ----------
const REPORT_REASONS = { spam: 'Spam ya da reklam', taciz: 'Taciz veya zorbalık', nefret: 'Nefret söylemi', cinsel: 'Cinsel içerik', siddet: 'Şiddet ya da tehdit', dolandir: 'Dolandırıcılık', cocuk: 'Çocuk güvenliği', taklit: 'Başkasını taklit', diger: 'Diğer' };
const siteAdmins = () => { const s1 = db.servers.find(x => x.id === 's1')?.owner; return [...new Set([s1, ...(db.siteAdmins || [])].filter(Boolean))]; };
const srvOf = id => id && db.servers.find(x => x.id === id);
const reportVisible = (r, n) => siteAdmin(n) || (!!r.serverId && !!srvOf(r.serverId) && isMod(srvOf(r.serverId), n));
function reportCounts(n) {
  const open = db.reports.filter(r => r.status === 'open');
  const out = { site: siteAdmin(n) ? open.length : 0, servers: {} };
  for (const r of open) if (r.serverId && srvOf(r.serverId) && isMod(srvOf(r.serverId), n)) out.servers[r.serverId] = (out.servers[r.serverId] || 0) + 1;
  return out;
}
function pushReports(r) {
  const who = new Set(siteAdmins());
  const s = srvOf(r.serverId); if (s) for (const n of s.members.concat(s.owner || [])) if (isMod(s, n)) who.add(n);
  for (const n of who) io.to('user:' + n).emit('reportCounts', reportCounts(n));
  return who;
}
const reportView = (r, n) => ({ ...r, by: siteAdmin(n) ? r.by : null, reasonText: REPORT_REASONS[r.reason] || r.reason, serverName: srvOf(r.serverId)?.name || null, targetGone: !db.users[r.target], targetBanned: !!db.users[r.target]?.siteBan,
  msgAlive: r.msg ? !!findMsg(r.chId, r.msg.id) : null, priors: db.reports.filter(x => x.target === r.target && x.id !== r.id).length });
function siteBanUser(name, by, reason) {
  const u = db.users[name]; if (!u) return false;
  u.siteBan = { by, at: Date.now(), reason: clean(reason, 160) };
  for (const [t, n] of Object.entries(db.sessions)) if (n === name) delete db.sessions[t];
  for (const s of db.servers) voiceKick(s.channels.map(c => c.id), name, 'Hesabın kapatıldı');
  io.to('user:' + name).emit('siteBanned', u.siteBan.reason);
  setTimeout(() => io.in('user:' + name).disconnectSockets(true), 300);
  save(); return true;
}
const banText = u => 'Bu hesap Kanka Chat kurallarını ihlal ettiği için kapatıldı.' + (u.siteBan?.reason ? ` Sebep: ${u.siteBan.reason}` : '') + ' Hata olduğunu düşünüyorsan kankahq1@gmail.com adresine yaz.';

setInterval(() => { // eski şikayetleri ve süresi dolan sıfırlama linklerini temizle (gizlilik politikasında yazan süreler)
  const lim = Date.now() - 730 * 864e5; db.reports = db.reports.filter(r => r.at > lim);
  for (const [t, r] of Object.entries(db.resets)) if (r.exp < Date.now()) delete db.resets[t];
}, 6 * 3600e3);

// ---------- Hesap silme (KVKK) ----------
function deleteUserData(name) {
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
  for (const [t, n] of Object.entries(db.sessions)) if (n === name) delete db.sessions[t];
  for (const [c, x] of Object.entries(db.codes)) if (x.by === name && !x.usedBy) delete db.codes[c];
  const em = db.users[name]?.email; if (em) db.waitlist = db.waitlist.filter(w => w.email !== em);
  delete db.users[name];
  save();
}

// ---------- Sürüm takibi: sayfa değişince açık olan herkese "yenile" uyarısı ----------
const INDEX = path.join(__dirname, 'public', 'index.html');
let build = '';
const readBuild = () => { try { const st = fs.statSync(INDEX); return st.size + '-' + Math.round(st.mtimeMs); } catch { return ''; } };
build = readBuild();
let buildTimer = null;
try {
  fs.watch(path.dirname(INDEX), (ev, file) => { if (file && file !== 'index.html') return; clearTimeout(buildTimer); buildTimer = setTimeout(() => { const b = readBuild(); if (b && b !== build) { build = b; io.emit('build', build); } }, 1500); });
} catch {}

// ---------- Bağlantı ----------
io.on('connection', socket => {
  socket.emit('build', build);
  const ip = String(socket.handshake.headers['x-forwarded-for'] || socket.handshake.address || '').split(',')[0].trim();
  let me = null, cur = null, myVoice = null;

  function start(name) {
    me = name;
    socket.join('user:' + name);
    online.set(socket.id, name);
    pushPresence();
    const u = db.users[name], t = ymd(), y = ymd(new Date(Date.now() - 864e5));
    let reward = null;
    if (u.streak?.last !== t) {
      const count = u.streak?.last === y ? (u.streak.count || 0) + 1 : 1;
      const bonus = 5 + Math.min(count, 10) * 2;
      u.streak = { last: t, count, best: Math.max(count, u.streak?.best || 0) };
      u.xp = (u.xp || 0) + bonus;
      reward = { count, bonus };
      setTimeout(() => io.emit('users', allUsers()), 100);
    }
    const token = crypto.randomBytes(24).toString('hex');
    db.sessions[token] = name; save();
    return { reward, social: social(name), badgeInfo: BADGES, ice: iceServers(),
      token, user: pubUser(db.users[name]), users: allUsers(), online: presenceList(), voiceFlags: flagsState(), myStatus: db.users[name].presence || 'online', myStatusUntil: db.users[name].presenceUntil || null, customUntil: db.users[name].statusUntil || null,
      servers: serversFor(name).map(s => serverView(s, name)), dms: dmsFor(name), voice: voiceState(), live: liveState(),
      onb: onbOf(db.users[name]), presets: PRESET_AV,
      myEmail: db.users[name].email || null, siteAdmin: siteAdmin(name), reportCounts: reportCounts(name), beta: db.beta.on
    };
  }

  socket.on('register', ({ name, password, email, code, invite, terms } = {}, cb = () => {}) => {
    name = clean(name, 20); password = String(password ?? ''); email = clean(email, 190).toLowerCase();
    if (!NAME_RE.test(name)) return cb({ error: 'Kullanıcı adı 2-20 karakter olmalı; harf, rakam, _ . - kullanabilirsin.' });
    if (password.length < 6) return cb({ error: 'Şifre en az 6 karakter olmalı.' });
    if (!EMAIL_RE.test(email)) return cb({ error: 'Geçerli bir e-posta adresi yaz. Şifreni unutursan buraya link göndeririz.', field: 'email' });
    if (!terms) return cb({ error: 'Devam etmek için kullanım şartlarını ve gizlilik politikasını kabul etmelisin.', field: 'terms' });
    if (Object.keys(db.users).some(n => n.toLowerCase() === name.toLowerCase())) return cb({ error: 'Bu kullanıcı adı alınmış.', field: 'name' });
    if (Object.values(db.users).some(u => u.email === email)) return cb({ error: 'Bu e-posta ile zaten bir hesap var. Şifreni unuttuysan giriş ekranından sıfırlayabilirsin.', field: 'email' });
    const gate = betaGate(code, invite); if (gate.error) return cb({ ...gate, field: 'code' });
    const w = limited('reg|' + ip, 5, 3600e3);
    if (w) return cb({ error: `Bu bağlantıdan çok fazla hesap açıldı. ${Math.ceil(w / 60)} dakika sonra tekrar dene.` });
    const salt = crypto.randomBytes(16).toString('hex');
    db.users[name] = { name, email, terms: { v: 1, at: Date.now() }, color: COLORS[Object.keys(db.users).length % COLORS.length], salt, hash: hashPw(password, salt), xp: 0, createdAt: Date.now(), avatar: PRESET_AV[crypto.randomInt(PRESET_AV.length)], onb: {} };
    if (gate.code) {
      const c = db.codes[gate.code]; c.usedBy = name; c.usedAt = Date.now(); db.users[name].invitedBy = c.by;
      const inv = db.users[c.by];
      if (inv) { inv.xp = (inv.xp || 0) + 50; io.to('user:' + c.by).emit('toast', `🎉 ${name} senin davet kodunla Kanka'ya katıldı! +50 XP`); }
    }
    db.waitlist.forEach(x => { if (x.email === email) x.joined = name; });
    ensureOwners(); save();
    io.emit('users', allUsers());
    pushServers(onlineNames()); // herkese açık sunucunun üye listesi değişti
    cb(start(name));
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
    if (!getMailer()) return cb({ error: 'E-posta sistemi henüz kurulmadı. kankahq1@gmail.com adresine yaz, elle yardım edelim.' });
    const u = findUserBy(who);
    if (u?.email && !u.siteBan && !limited('forgotU|' + u.name, 3, 3600e3)) {
      const t = resetToken(u.name, 1);
      sendMail(u.email, 'Kanka Chat şifre sıfırlama', mailHtml('Şifreni sıfırla', `Selam <b>${u.name}</b>, şifreni sıfırlamak için bir istek aldık. Link <b>1 saat</b> geçerli.`, 'Yeni şifre belirle', `${baseUrl()}/?sifirla=${t}`));
    }
    cb({ ok: true }); // hesabın var olup olmadığını belli etme
  });
  socket.on('checkReset', (token, cb = () => {}) => {
    const r = db.resets[String(token || '')];
    cb(r && r.exp > Date.now() && db.users[r.name] ? { ok: true, name: r.name } : { error: 'Bu link geçersiz ya da süresi dolmuş. Yeni bir link iste.' });
  });
  socket.on('resetPw', ({ token, password } = {}, cb = () => {}) => {
    if (limited('reset|' + ip, 10, 900e3)) return cb({ error: 'Çok fazla deneme' });
    const r = db.resets[String(token || '')], u = r && db.users[r.name];
    if (!r || r.exp < Date.now() || !u) return cb({ error: 'Bu link geçersiz ya da süresi dolmuş. Yeni bir link iste.' });
    if (String(password ?? '').length < 6) return cb({ error: 'Şifre en az 6 karakter olmalı.' });
    if (u.siteBan) return cb({ error: banText(u) });
    u.salt = crypto.randomBytes(16).toString('hex'); u.hash = hashPw(String(password), u.salt);
    for (const [t, n] of Object.entries(db.sessions)) if (n === u.name) delete db.sessions[t];
    for (const [t, x] of Object.entries(db.resets)) if (x.name === u.name) delete db.resets[t];
    save(); cb(start(u.name));
  });

  socket.on('login', ({ name, password } = {}, cb) => {
    const key = 'login|' + ip + '|' + clean(name, 190).toLowerCase(), now = Date.now();
    const fails = (limits.get(key) || []).filter(t => now - t < 600e3);
    if (fails.length >= 5) return cb({ error: `Çok fazla hatalı deneme. ${Math.ceil((600e3 - (now - fails[0])) / 60000)} dakika sonra tekrar dene.` });
    const u = findUserBy(name);
    if (!u || hashPw(String(password ?? ''), u.salt) !== u.hash) { fails.push(now); limits.set(key, fails); return cb({ error: fails.length >= 5 ? 'Çok fazla hatalı deneme, 10 dakika bekle.' : 'Kullanıcı adı / e-posta ya da şifre yanlış.' }); }
    limits.delete(key);
    if (u.siteBan) return cb({ error: banText(u), banned: true });
    cb(start(u.name));
  });

  socket.on('auth', (token, cb) => {
    const n = db.sessions[token];
    if (!n || !db.users[n]) return cb({ error: 'Oturum bulunamadı' });
    delete db.sessions[token];
    if (db.users[n].siteBan) return cb({ error: banText(db.users[n]), banned: true });
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
    const join = serversFor(me).some(x => x.id !== 's1');
    if (!(join && ob.msg && ob.voice && ob.invite && ob.profile)) return cb({ error: 'Adımlar henüz bitmedi' });
    ob.rewarded = true; u.xp = (u.xp || 0) + 100; save();
    io.emit('users', allUsers()); cb({ ok: true, xp: 100, onb: ob });
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
    for (const [k, list] of Object.entries(db.messages)) for (const m of list) if (m.author === me)
      msgs.push({ yer: k.startsWith('dm:') ? 'DM: ' + dmPeers(k).filter(n => n !== me).join(', ') : (findChannel(k) ? findChannel(k).s.name + ' #' + findChannel(k).c.name : k), zaman: new Date(m.time).toISOString(), tur: m.kind, metin: m.text || '', resim: m.image || null });
    cb({ ok: true, data: { aciklama: 'Kanka Chat hesabında hakkında tuttuğumuz veriler (KVKK md. 11)', indirilme: new Date().toISOString(), profil: profile, sunucular: serversFor(me).filter(s => !s.public).map(s => ({ ad: s.name, sahip: s.owner === me, katilim: s.joinedAt?.[me] ? new Date(s.joinedAt[me]).toISOString() : null })), mesajlar: msgs } });
  });
  socket.on('deleteAccount', ({ password, confirm } = {}, cb = () => {}) => {
    const u = db.users[me]; if (!u) return cb({ error: 'Giriş yap' });
    if (limited('pw|' + me, 5, 600e3)) return cb({ error: 'Çok fazla deneme, biraz bekle.' });
    if (hashPw(String(password ?? ''), u.salt) !== u.hash) return cb({ error: 'Şifre yanlış' });
    if (String(confirm || '') !== me) return cb({ error: 'Onay için kullanıcı adını aynen yaz' });
    if (db.servers.find(x => x.id === 's1')?.owner === me) return cb({ error: 'Kanka HQ sahibi hesabını silemez' });
    const name = me, touched = onlineNames();
    deleteUserData(name);
    cb({ ok: true });
    io.emit('users', allUsers()); pushServers(touched.filter(n => n !== name));
    setTimeout(() => io.in('user:' + name).disconnectSockets(true), 200);
  });
  socket.on('myCodes', (cb = () => {}) => {
    if (!me) return cb({ error: 'Giriş yap' });
    const list = myCodes(me); save();
    cb({ ok: true, beta: db.beta.on, codes: list, joined: Object.values(db.users).filter(u => u.invitedBy === me).length });
  });

  // ---- Şikayetler ----
  socket.on('report', ({ kind, msgId, chId, name, reason, note } = {}, cb = () => {}) => {
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
      const f = findChannel(chId), snap = x => ({ id: x.id, author: x.author, text: (x.text || '').slice(0, 600), image: x.image || null, kind: x.kind, time: x.time });
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
    else { if (!siteAdmin(me)) return cb({ error: 'Yetkin yok' }); list = db.reports; }
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
        list.splice(i, 1); io.to(r.chId).emit('remove', { channelId: r.chId, msgId: r.msg.id });
        if (s) audit(s, me, 'Şikayet üzerine mesaj sildi', `${r.target}: ${(r.msg.text || '').slice(0, 60)}`);
      }
      close('Mesaj silindi');
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
    cb({ ok: true, cfg: mailCfg ? { user: mailCfg.user, host: mailCfg.host || '', port: mailCfg.port || 465, url: mailCfg.url || baseUrl(), hasPass: !!mailCfg.pass } : { url: baseUrl() }, ready: !!getMailer() && mailCfg?.ok === true, unverified: !!getMailer() && mailCfg?.ok !== true, failed: mailCfg?.ok === false });
  });
  socket.on('adminUser', ({ name, action, reason } = {}, cb = () => {}) => {
    if (!SA(cb)) return;
    const u = findUserBy(name); if (!u) return cb({ error: 'Kullanıcı bulunamadı' });
    if (action === 'resetLink') return cb({ ok: true, link: `${baseUrl()}/?sifirla=${resetToken(u.name, 24)}` });
    if (action === 'ban') { if (siteAdmin(u.name)) return cb({ error: 'Yönetici kapatılamaz' }); siteBanUser(u.name, me, reason); }
    if (action === 'unban') { delete u.siteBan; save(); }
    cb({ ok: true, user: { name: u.name, email: u.email ? u.email.replace(/^(.{2}).*(@.*)$/, '$1•••$2') : null, createdAt: u.createdAt, invitedBy: u.invitedBy || null, banned: u.siteBan || null,
      reports: db.reports.filter(r => r.target === u.name).length, servers: serversFor(u.name).filter(s => !s.public).length } });
  });
  socket.on('adminBanned', (cb = () => {}) => { if (!SA(cb)) return; cb({ ok: true, list: Object.values(db.users).filter(u => u.siteBan).map(u => ({ name: u.name, ...u.siteBan })) }); });

  socket.on('onbSet', (k, cb = () => {}) => {
    const u = db.users[me]; if (!u || !['dismissed', 'done', 'seen'].includes(k)) return cb({ error: 'Geçersiz' });
    onbOf(u)[k] = true; save(); cb({ ok: true, onb: u.onb });
  });
  socket.on('logout', token => { delete db.sessions[token]; save(); });

  // ----- Kanallar -----
  socket.on('join', (chId, cb) => {
    if (!canAccess(me, chId)) return cb({ error: 'Bu odaya erişimin yok' });
    if (cur) socket.leave(cur);
    cur = chId; socket.join(chId);
    const s = serverOf(chId); if (s) dailyQuestion(s);
    cb({ messages: (db.messages[chId] || []).slice(-150), playlist: db.playlists[chId] || [], watch: watch.get(chId) || null });
  });

  // ----- Durum -----
  // Durum: { st, until } — until verilirse o anda otomatik "Çevrimiçi"ye döner
  socket.on('setStatus', (arg, cb = () => {}) => {
    const { st, until } = typeof arg === 'string' ? { st: arg } : (arg || {});
    if (!me || !['online', 'idle', 'dnd', 'invisible'].includes(st)) return cb({ error: 'Geçersiz durum' });
    const u = db.users[me]; u.presence = st;
    const t = +until; u.presenceUntil = st !== 'online' && t > Date.now() && t < Date.now() + 31 * 864e5 ? t : null;
    save(); pushPresence(); cb({ ok: true, until: u.presenceUntil });
  });
  socket.on('setCustomStatus', ({ text, until } = {}, cb = () => {}) => {
    const u = db.users[me]; if (!u) return cb({ error: 'Giriş yap' });
    u.status = clean(text, 60); const t = +until;
    u.statusUntil = u.status && t > Date.now() && t < Date.now() + 31 * 864e5 ? t : null;
    if (u.status) onbFlag(me, 'profile');
    save(); io.emit('users', allUsers()); cb({ ok: true, until: u.statusUntil });
  });
  socket.on('vis', on => { on ? visibleSockets.add(socket.id) : visibleSockets.delete(socket.id); });
  socket.on('pushKey', (cb = () => {}) => cb(webpush && vapid ? vapid.publicKey : null));
  socket.on('pushSub', (sub, cb = () => {}) => {
    const u = db.users[me]; if (!u) return cb({ error: 'Giriş yap' });
    if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || sub.endpoint.length > 600 || typeof sub.keys?.p256dh !== 'string' || typeof sub.keys?.auth !== 'string') return cb({ error: 'Geçersiz abonelik' });
    const clean = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh.slice(0, 200), auth: sub.keys.auth.slice(0, 100) }, at: Date.now() };
    u.push = [clean, ...(u.push || []).filter(x => x.endpoint !== clean.endpoint)].slice(0, 6); save(); cb({ ok: true });
  });
  socket.on('pushOff', (endpoint, cb = () => {}) => { const u = db.users[me]; if (!u) return; u.push = (u.push || []).filter(x => x.endpoint !== endpoint); save(); cb({ ok: true }); });
  socket.on('pushTest', (cb = () => {}) => {
    const u = db.users[me]; if (!u?.push?.length || !webpush) return cb({ error: 'Bu cihazda bildirim açık değil' });
    const body = JSON.stringify({ title: 'Kanka Chat', body: 'Bildirimler çalışıyor! Kanka kapalıyken de mesajlarını kaçırmayacaksın.', tag: 'test' });
    Promise.allSettled(u.push.map(sub => webpush.sendNotification(sub, body, { TTL: 60 }))).then(r => cb({ ok: r.some(x => x.status === 'fulfilled') }));
  });
  socket.on('idle', on => { on ? idleSockets.add(socket.id) : idleSockets.delete(socket.id); pushPresence(); });

  // ----- Eski mesajlar -----
  socket.on('history', ({ before } = {}, cb = () => {}) => {
    if (!canAccess(me, cur)) return cb({ messages: [] });
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
    if (!isPrivateChat(chId) || !canAccess(me, chId)) return;
    for (const n of chatMembers(chId)) if (n !== me && !db.users[n]?.blocked?.includes(me))
      io.to('user:' + n).emit('ring', { from: me, chatId: chId, callId: 'call:' + chId, video: !!video, title: chId.startsWith('g:') ? groupTitle(groupOf(chId)) : me });
  });
  socket.on('ringCancel', chId => { if (canAccess(me, chId)) for (const n of chatMembers(chId)) if (n !== me) io.to('user:' + n).emit('ringCancel', { chatId: chId }); });
  socket.on('callDecline', chId => { if (canAccess(me, chId)) for (const n of chatMembers(chId)) if (n !== me) io.to('user:' + n).emit('callDecline', { from: me, chatId: chId }); });

  // Profil kartından hızlı DM
  socket.on('quickDM', ({ to, text } = {}, cb = () => {}) => {
    if (!me || !db.users[to] || to === me) return cb({ error: 'Kullanıcı bulunamadı' });
    text = clean(text, 2000); if (!text) return cb({ error: 'Boş mesaj' });
    if (limited('msg|' + me, 8, 5000)) return cb({ error: 'Çok hızlı yazıyorsun, biraz yavaşla 🙂' });
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
  socket.on('message', (p = {}, cb = () => {}) => {
    if (!me || !cur || !canAccess(me, cur)) return cb({ error: 'Önce bir odaya gir' });
    if (limited('msg|' + me, 8, 5000)) return cb({ error: 'Çok hızlı yazıyorsun, biraz yavaşla 🙂' });
    if (cur.startsWith('dm:')) {
      const other = dmPeers(cur).find(n => n !== me) || me, u = db.users[me], o = db.users[other];
      if (u?.blocked?.includes(other)) return cb({ error: 'Bu kişiyi engelledin. Mesaj göndermek için engeli kaldır.' });
      if (o?.blocked?.includes(me)) return cb({ error: 'Bu kişi sana mesaj alımını kapattı.' });
    }
    const srv = serverOf(cur);
    if (srv?.welcome?.enabled && srv.owner !== me && !srv.accepted?.[me]) return cb({ error: 'Önce sunucu kurallarını kabul etmelisin', needRules: srv.id });
    if (srv && timedOut(srv, me)) return cb({ error: `Susturuldun. ${Math.ceil((srv.timeouts[me] - Date.now()) / 60000)} dakika sonra yazabilirsin.` });
    if (srv && !chPerm(srv, findChannel(cur).c, me, 'send')) return cb({ error: 'Bu odaya yazma iznin yok' });
    const chObj = srv && findChannel(cur).c;
    if (srv && /@(everyone|herkes)\b/i.test(p.text || '') && !chPerm(srv, chObj, me, 'mention')) return cb({ error: '@herkes etiketleme iznin yok' });
    if (srv && (p.image || p.audio) && !chPerm(srv, chObj, me, 'attach')) return cb({ error: 'Bu odada dosya ve resim gönderme iznin yok' });
    if (srv && chObj.type === 'forum' && !p.thread && !clean(p.title, 100)) return cb({ error: 'Gönderi başlığı gerekli' });
    const slowSec = (chObj?.slow || srv?.slow || 0);
    if (srv && slowSec && !isMod(srv, me) && !chPerm(srv, chObj, me, 'manage')) {
      const key = cur + '|' + me, last = slowMap.get(key) || 0, wait = slowSec * 1000 - (Date.now() - last);
      if (wait > 0) return cb({ error: `Yavaş mod açık: ${Math.ceil(wait / 1000)} saniye bekle` });
      slowMap.set(key, Date.now());
    }
    cb(postMessage(me, cur, p));
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
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 5 * 1024 * 1024) return cb({ error: 'Resim en fazla 5 MB olabilir' });
    const file = crypto.randomBytes(12).toString('hex') + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
    fs.writeFile(path.join(UPLOADS, file), buf, err => cb(err ? { error: 'Kaydedilemedi' } : { url: '/uploads/' + file }));
  });

  // ----- Mesaj işlemleri -----
  const update = (chId, msg) => { save(); io.to(chId).emit('update', { channelId: chId, msg }); };

  socket.on('react', ({ msgId, emoji } = {}) => {
    if (!canAccess(me, cur)) return;
    const msg = findMsg(cur, msgId); emoji = clean(emoji, 8);
    if (!msg || !emoji) return;
    { const f = findChannel(cur); if (f && !msg.reactions?.[emoji] && !chPerm(f.s, f.c, me, 'react')) return socket.emit('toast', 'Bu odada tepki ekleme iznin yok'); }
    msg.reactions ||= {};
    const arr = (msg.reactions[emoji] ||= []);
    const i = arr.indexOf(me);
    i >= 0 ? arr.splice(i, 1) : arr.push(me);
    if (!arr.length) delete msg.reactions[emoji];
    update(cur, msg);
  });

  socket.on('edit', ({ msgId, text } = {}) => {
    if (!canAccess(me, cur)) return;
    const msg = findMsg(cur, msgId); text = clean(text, 2000);
    if (!msg || msg.author !== me || msg.kind !== 'text' || !text) return;
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
    list.splice(i, 1);
    if (db.playlists[cur]) {
      db.playlists[cur] = db.playlists[cur].filter(s => s.id !== msgId);
      io.to(cur).emit('playlist', { channelId: cur, playlist: db.playlists[cur] });
    }
    save();
    io.to(cur).emit('remove', { channelId: cur, msgId });
  });

  socket.on('planToggle', msgId => {
    if (!canAccess(me, cur)) return;
    const msg = findMsg(cur, msgId);
    if (!msg || msg.kind !== 'plan') return;
    const g = msg.plan.going, i = g.indexOf(me);
    i >= 0 ? g.splice(i, 1) : g.push(me);
    update(cur, msg);
  });

  socket.on('vote', ({ msgId, index } = {}) => {
    if (!canAccess(me, cur)) return;
    const msg = findMsg(cur, msgId);
    if (!msg || msg.kind !== 'poll' || !msg.poll.options[index]) return;
    const already = msg.poll.options[index].votes.includes(me);
    for (const o of msg.poll.options) o.votes = o.votes.filter(v => v !== me);
    if (!already) msg.poll.options[index].votes.push(me);
    update(cur, msg);
  });

  socket.on('xoxMove', ({ msgId, i } = {}) => {
    if (!canAccess(me, cur)) return;
    const msg = findMsg(cur, msgId);
    if (!msg || msg.kind !== 'xox') return;
    const g = msg.game; i = +i;
    if (g.winner || !(i >= 0 && i < 9) || g.board[i] !== '.') return;
    if (g.turn === 'x' && me !== g.x) return;
    if (g.turn === 'o') { if (!g.o && me !== g.x) g.o = me; if (me !== g.o) return; }
    g.board = g.board.slice(0, i) + g.turn + g.board.slice(i + 1);
    g.winner = winnerOf(g.board);
    if (g.winner === 'x' || g.winner === 'o') { const w = db.users[g.winner === 'x' ? g.x : g.o]; if (w) w.xoxWins = (w.xoxWins || 0) + 1; io.emit('users', allUsers()); }
    g.turn = g.turn === 'x' ? 'o' : 'x';
    update(cur, msg);
  });

  socket.on('pin', msgId => {
    if (!canAccess(me, cur)) return;
    const f = findChannel(cur);
    if (f && !isMod(f.s, me) && !chPerm(f.s, f.c, me, 'manage')) return;
    const msg = findMsg(cur, msgId);
    if (!msg) return;
    msg.pinned = !msg.pinned;
    update(cur, msg);
  });

  socket.on('search', (q, cb) => {
    if (!canAccess(me, cur)) return cb([]);
    q = clean(q, 100).toLocaleLowerCase('tr');
    if (!q) return cb([]);
    cb((db.messages[cur] || []).filter(m => [m.text, m.author, m.plan?.title, m.poll?.question, m.song?.title].some(t => t && t.toLocaleLowerCase('tr').includes(q))).slice(-50).reverse());
  });

  // ----- Birlikte izle -----
  socket.on('watchSet', url => {
    if (!canAccess(me, cur)) return;
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
  socket.on('updateProfile', ({ avatar, status, bio, banner, color, birthday, music, displayName, pronouns, theme, bannerImg, frame, socials } = {}, cb = () => {}) => {
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
    if (theme !== undefined) u.theme = Array.isArray(theme) && theme.length === 2 && theme.every(c => HEX.test(c)) ? theme : null;
    if (bannerImg !== undefined) u.bannerImg = bannerImg && UPLOAD_RE.test(bannerImg) ? bannerImg : null;
    if (frame !== undefined) { if (frame && !frameOk(u, frame)) return cb({ error: 'Bu çerçeve henüz açılmadı' }); u.frame = frame && frame !== 'none' ? frame : null; }
    if (socials !== undefined) { const o = {}; for (const k of SOCIALS) { const v = clean(socials?.[k], 60).replace(/^https?:\/\/\S+\//, '').replace(/^@/, ''); if (v && /^[\w.\-]{1,40}$/.test(v)) o[k] = v; } u.socials = o; }
    if (u.bio || u.status) onbFlag(me, 'profile');
    save(); io.emit('users', allUsers()); cb({ ok: true });
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
  socket.on('mutuals', (n, cb = () => {}) => {
    const o = db.users[n]; if (!me || !o) return cb({ servers: [], friends: [] });
    const servers = db.servers.filter(s => !s.public && s.members.includes(me) && s.members.includes(n)).map(s => ({ id: s.id, name: s.name, icon: s.icon, iconImg: s.iconImg || null, joined: s.joinedAt?.[n] || null }));
    const mine = new Set(db.users[me].friends || []), friends = n === me ? [] : (o.friends || []).filter(x => mine.has(x));
    cb({ matches: (o.matches || []).slice(0, 8), servers: n === me ? [] : servers, friends, joined: Object.fromEntries(db.servers.filter(s => s.members.includes(n) && s.joinedAt?.[n]).map(s => [s.id, s.joinedAt[n]])) });
  });
  socket.on('changePassword', ({ old, next } = {}, cb = () => {}) => {
    const u = db.users[me]; if (!u) return;
    if (limited('pw|' + me, 5, 600e3)) return cb({ error: 'Çok fazla deneme, biraz bekle.' });
    if (hashPw(String(old ?? ''), u.salt) !== u.hash) return cb({ error: 'Mevcut şifre yanlış' });
    if (String(next ?? '').length < 6) return cb({ error: 'Yeni şifre en az 6 karakter olmalı' });
    u.salt = crypto.randomBytes(16).toString('hex'); u.hash = hashPw(String(next), u.salt);
    for (const [t, n] of Object.entries(db.sessions)) if (n === me) delete db.sessions[t];
    save(); cb({ ok: true });
  });

  // ----- Sunucu yönetimi -----
  const adminServer = (serverId, needAdmin) => {
    const s = db.servers.find(x => x.id === serverId);
    if (!me || !s) return null;
    return (needAdmin ? roleOf(s, me) === 'admin' : isMod(s, me)) ? s : null;
  };
  socket.on('serverBadge', ({ serverId, badge, on } = {}, cb = () => {}) => {
    if (!siteAdmin(me)) return cb({ error: 'Rozetleri sadece Kanka Chat yönetimi verebilir' });
    const s = db.servers.find(x => x.id === serverId);
    if (!s || !['dogrulanmis', 'partner'].includes(badge)) return cb({ error: 'Geçersiz' });
    s.badges ||= {};
    if (on) s.badges[badge] = { by: me, time: Date.now() }; else delete s.badges[badge];
    audit(s, me, on ? 'Rozet verdi' : 'Rozeti kaldırdı', badge === 'partner' ? 'Kanka Partner' : 'Doğrulanmış');
    save(); pushServers(membersOf(s));
    for (const n of membersOf(s)) if (on) io.to('user:' + n).emit('toast', `${s.name} artık ${badge === 'partner' ? 'Kanka Partner' : 'Doğrulanmış'} bir sunucu`);
    cb({ ok: true });
  });
  socket.on('updateServer', ({ serverId, name, icon, iconImg, banner, bannerColor, filter, slow, afkCh, afkMin } = {}, cb = () => {}) => {
    const s = permServer(serverId, 'manageServer'); if (!s) return cb({ error: 'Sunucuyu yönetme yetkin yok' });
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
    if (!membersOf(s).includes(name) || name === s.owner) return cb({ error: 'Bu kişinin rolü değiştirilemez' });
    if (role === 'mod') s.roles[name] = 'mod'; else delete s.roles[name];
    audit(s, me, role === 'mod' ? 'Moderatör yaptı' : 'Moderatörlüğü aldı', name);
    save(); pushServers(membersOf(s)); cb({ ok: true });
  });
  const permServer = (serverId, perm) => { const s = db.servers.find(x => x.id === serverId); if (s) { s.customRoles ||= []; s.memberRoles ||= {}; s.bans ||= {}; s.timeouts ||= {}; s.roles ||= {}; } return me && s && can(s, me, perm) ? s : null; };
  const pushSrv = s => { save(); pushServers(membersOf(s)); };
  socket.on('roleSave', ({ serverId, role } = {}, cb = () => {}) => {
    const s = permServer(serverId, 'manageRoles'); if (!s) return cb({ error: 'Rolleri yönetme yetkin yok' });
    const name = clean(role?.name, 30); if (!name) return cb({ error: 'Rol adı gerekli' });
    const perms = (role.perms || []).filter(p => PERMS.includes(p) && (s.owner === me || can(s, me, p)));
    const color = /^#[0-9a-f]{6}$/i.test(role.color) ? role.color : '#99aab5';
    let r = s.customRoles.find(x => x.id === role.id);
    if (r) { if (!outranksRole(s, r)) return cb({ error: 'Bu rol senden yüksek' }); Object.assign(r, { name, color, perms, hoist: !!role.hoist }); audit(s, me, 'Rolü düzenledi', name); }
    else { if (s.customRoles.length >= 30) return cb({ error: 'En fazla 30 rol' }); r = { id: id(), name, color, perms, hoist: !!role.hoist }; s.customRoles.push(r); audit(s, me, 'Rol oluşturdu', name); }
    pushSrv(s); cb({ ok: true, id: r.id });
  });
  const outranksRole = (s, r) => s.owner === me || rankOf(s, me) > 1000 - s.customRoles.indexOf(r);
  socket.on('roleDelete', ({ serverId, roleId } = {}, cb = () => {}) => {
    const s = permServer(serverId, 'manageRoles'); if (!s) return cb({ error: 'Yetkin yok' });
    const r = s.customRoles.find(x => x.id === roleId); if (!r || !outranksRole(s, r)) return cb({ error: 'Bu rolü silemezsin' });
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
  socket.on('memberRoles', ({ serverId, name, roles } = {}, cb = () => {}) => {
    const s = permServer(serverId, 'manageRoles'); if (!s || !membersOf(s).includes(name)) return cb({ error: 'Yetkin yok' });
    const old = s.memberRoles[name] || [];
    const want = (roles || []).filter(rid => s.customRoles.some(r => r.id === rid));
    for (const rid of new Set([...old, ...want])) if (old.includes(rid) !== want.includes(rid) && !outranksRole(s, s.customRoles.find(r => r.id === rid))) return cb({ error: 'Senden yüksek bir rolü veremez/alamazsın' });
    if (want.length) s.memberRoles[name] = want; else delete s.memberRoles[name];
    audit(s, me, 'Rollerini değiştirdi', name); pushSrv(s); cb({ ok: true });
  });
  socket.on('channelSave', ({ serverId, channelId, name, cat, perms, sync, topic, slow, limit, bitrate, news } = {}, cb = () => {}) => {
    const s = permServer(serverId, 'manageChannels'); if (!s) return cb({ error: 'Oda yönetme yetkin yok' });
    const c = s.channels.find(x => x.id === channelId); if (!c) return cb({ error: 'Oda bulunamadı' });
    if (name !== undefined) { name = clean(name, 30); if (c.type === 'text' || c.type === 'forum') name = name.toLowerCase().replace(/\s+/g, '-'); if (name) c.name = name; }
    if (cat !== undefined) {
      const k = cat && s.categories.find(x => x.id === cat);
      if (cat && !k) return cb({ error: 'Kategori bulunamadı' });
      if ((c.cat || null) !== (k?.id || null)) { c.cat = k?.id || undefined; if (!k) c.sync = false;
        // yeni yerine taşı: hedef grubun sonuna
        s.channels = s.channels.filter(x => x !== c); const last = s.channels.map(x => x.cat || null).lastIndexOf(k?.id || null);
        if (k && last < 0) { const ord = s.categories.findIndex(x => x.id === k.id); const after = s.channels.findIndex(x => x.cat && s.categories.findIndex(y => y.id === x.cat) > ord); s.channels.splice(after < 0 ? s.channels.length : after, 0, c); }
        else s.channels.splice(last + 1, 0, c); }
    }
    if (topic !== undefined) c.topic = clean(topic, 160);
    if (slow !== undefined) c.slow = [0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 3600].includes(+slow) ? +slow : 0;
    if (limit !== undefined) c.limit = Math.max(0, Math.min(99, parseInt(limit) || 0));
    if (bitrate !== undefined) c.bitrate = bitrate === 'high' ? 'high' : 'std';
    if (news !== undefined && c.type === 'text') { c.news = !!news; if (!c.news) c.followers = []; }
    if (sync === true && catOf(s, c)) { audit(s, me, 'Odayı kategoriyle eşitledi', '#' + c.name); c.sync = true; c.perms = {}; }
    else if (perms !== undefined) { const np = cleanPerms(s, perms), d = permDiff(s, ovOf(s, c), np); if (d) audit(s, me, 'İzinleri değiştirdi', `#${c.name}: ${d}`); c.perms = np; c.sync = false; }
    if (s.owner === me) setupOf(s).channels = true;
    audit(s, me, 'Odayı düzenledi', c.name); save(); pushSrv(s); cb({ ok: true });
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
    s.bans[name] = { by: me, time: Date.now(), reason: clean(reason, 120) };
    s.members = s.members.filter(n => n !== name); delete s.roles[name]; delete s.memberRoles?.[name];
    audit(s, me, 'Yasakladı', name + (reason ? ' · ' + clean(reason, 120) : ''));
    voiceKick(s.channels.map(c => c.id), name, 'Sunucudan yasaklandın');
    save(); pushServers([name, ...s.members]);
    io.to('user:' + name).emit('toast', `${s.name} sunucusundan yasaklandın`);
    cb({ ok: true });
  });
  socket.on('kick', ({ serverId, name } = {}, cb = () => {}) => {
    const s = adminServer(serverId, false); if (!s) return cb({ error: 'Yetkin yok' });
    if (s.public) return cb({ error: 'Herkese açık sunucudan kimse atılamaz' });
    if (name === s.owner || !can(s, me, 'kick') || !outranks(s, me, name)) return cb({ error: 'Bu kişiyi atamazsın' });
    s.members = s.members.filter(n => n !== name); delete s.roles[name]; delete s.memberRoles?.[name];
    audit(s, me, 'Sunucudan attı', name);
    voiceKick(s.channels.map(c => c.id), name, 'Sunucudan çıkarıldın');
    save(); pushServers([name, ...s.members]);
    io.to('user:' + name).emit('toast', `${s.name} sunucusundan çıkarıldın`);
    cb({ ok: true });
  });
  socket.on('deleteChannel', ({ serverId, channelId } = {}, cb = () => {}) => {
    const s = adminServer(serverId, false); if (!s) return cb({ error: 'Yetkin yok' });
    const c = s.channels.find(c => c.id === channelId);
    if (!c) return cb({ error: 'Oda bulunamadı' });
    if (c.type === 'text' && s.channels.filter(x => x.type === 'text').length < 2) return cb({ error: 'En az bir yazılı oda kalmalı' });
    s.channels = s.channels.filter(x => x !== c); delete db.messages[c.id]; delete db.playlists[c.id];
    if (s.afk?.ch === c.id) s.afk = null;
    voiceKick([c.id], null, 'Bulunduğun ses odası silindi');
    audit(s, me, 'Oda sildi', c.name);
    save(); pushServers(membersOf(s)); cb({ ok: true });
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
  socket.on('friendRequest', (name, cb = () => {}) => {
    if (limited('fr|' + me, 20, 3600e3)) return cb({ error: 'Çok fazla istek gönderdin, sonra tekrar dene' });
    const a = U(me), b = U(name);
    if (!a || !b || name === me) return cb({ error: 'Kullanıcı bulunamadı' });
    if (a.friends.includes(name)) return cb({ error: 'Zaten arkadaşsınız' });
    if (b.blocked.includes(me)) return cb({ error: 'Bu kişiye istek gönderilemiyor' });
    if (a.reqIn.includes(name)) { // karşı taraf zaten istek göndermişse kabul et
      pull(a.reqIn, name); pull(b.reqOut, me); a.friends.push(name); b.friends.push(me);
      save(); pushSocial(me, name); io.emit('users', allUsers());
      io.to('user:' + name).emit('toast', `${me} arkadaşlık isteğini kabul etti`);
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
    save(); pushSocial(me, name); io.emit('users', allUsers());
    io.to('user:' + name).emit('toast', `${me} arkadaşlık isteğini kabul etti`);
    onbFlag(me, 'invite'); onbFlag(name, 'invite'); cb({ ok: true });
  });
  socket.on('friendRemove', (name, cb = () => {}) => { // arkadaşlıktan çıkar / isteği reddet / isteği geri çek
    const a = U(me), b = U(name); if (!a || !b) return cb({ error: 'Kullanıcı bulunamadı' });
    pull(a.friends, name); pull(b.friends, me); pull(a.reqIn, name); pull(a.reqOut, name); pull(b.reqIn, me); pull(b.reqOut, me);
    save(); pushSocial(me, name); io.emit('users', allUsers()); cb({ ok: true });
  });
  socket.on('block', ({ name, on } = {}, cb = () => {}) => {
    const a = U(me), b = U(name); if (!a || !b || name === me) return cb({ error: 'Kullanıcı bulunamadı' });
    if (on) {
      if (!a.blocked.includes(name)) a.blocked.push(name);
      pull(a.friends, name); pull(b.friends, me); pull(a.reqIn, name); pull(a.reqOut, name); pull(b.reqIn, me); pull(b.reqOut, me);
    } else pull(a.blocked, name);
    save(); pushSocial(me, name); io.emit('users', allUsers()); cb({ ok: true });
  });

  socket.on('leaderboard', (serverId, cb) => {
    const s = db.servers.find(x => x.id === serverId);
    if (!s || !(s.public || s.members.includes(me))) return cb([]);
    cb(membersOf(s).map(n => db.users[n]).filter(Boolean).sort((a, b) => (b.xp || 0) - (a.xp || 0)).slice(0, 25)
      .map(u => ({ name: u.name, xp: u.xp || 0, level: level(u.xp), streak: u.streak?.count || 0 })));
  });

  // ----- Özel emojiler -----
  socket.on('addEmoji', ({ serverId, name, url } = {}, cb = () => {}) => {
    const s = adminServer(serverId, false); if (!s) return cb({ error: 'Emoji eklemek için moderatör olmalısın' });
    name = clean(name, 24).toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (name.length < 2) return cb({ error: 'Emoji adı en az 2 karakter olmalı (a-z, 0-9, _)' });
    if (!UPLOAD_RE.test(url || '')) return cb({ error: 'Geçersiz resim' });
    s.emojis ||= {};
    if (Object.keys(s.emojis).length >= 50) return cb({ error: 'En fazla 50 özel emoji eklenebilir' });
    s.emojis[name] = url; audit(s, me, 'Emoji ekledi', ':' + name + ':');
    save(); pushServers(membersOf(s)); cb({ ok: true });
  });
  socket.on('removeEmoji', ({ serverId, name } = {}, cb = () => {}) => {
    const s = adminServer(serverId, false); if (!s || !s.emojis?.[name]) return cb({ error: 'Yetkin yok' });
    delete s.emojis[name]; audit(s, me, 'Emoji sildi', ':' + name + ':');
    save(); pushServers(membersOf(s)); cb({ ok: true });
  });
  socket.on('audit', (serverId, cb) => {
    const s = adminServer(serverId, false); cb(s ? (s.audit || []).slice(0, 100) : []);
  });

  // ----- Konular -----
  socket.on('threadReply', ({ msgId, text } = {}, cb = () => {}) => {
    if (!canAccess(me, cur)) return cb({ error: 'Erişim yok' });
    if (limited('msg|' + me, 8, 5000)) return cb({ error: 'Çok hızlı yazıyorsun' });
    const msg = findMsg(cur, msgId); text = clean(text, 1000);
    if (!msg || !text || msg.kind === 'system') return cb({ error: 'Gönderilemedi' });
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
    text = clean(text, 2000); at = +at;
    if (!text) return cb({ error: 'Mesaj boş olamaz' });
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
    if (!u.presenceKey || renew) { u.presenceKey = crypto.randomBytes(18).toString('hex'); save(); }
    cb({ key: u.presenceKey, connected: !!(u.auto && Date.now() - u.auto.at < 45e3) });
  });

  // ----- Ses: konuşma göstergesi -----
  socket.on('media', st => {
    if (!myVoice) return;
    const was = voiceMedia.get(socket.id)?.screen, now = { cam: !!st?.cam, screen: !!st?.screen };
    { const f = findChannel(myVoice); if (f && (now.cam || now.screen) && !chPerm(f.s, f.c, me, 'stream')) { socket.emit('toast', 'Bu odada kamera ve ekran paylaşma iznin yok'); now.cam = now.screen = false; } }
    voiceMedia.set(socket.id, now);
    socket.to('v:' + myVoice).emit('media', { sid: socket.id, name: me, ...now, streamId: clean(st?.streamId, 80), viewers: Math.min(+st?.viewers || 0, 99), q: clean(st?.q, 12), audio: !!st?.audio });
    if (!!was !== now.screen) pushVoice(); else io.emit('voiceFlags', flagsState());
  });
  // Yayın izleme: izleyici yayıncıya "izliyorum / bıraktım" der; yayıncı görüntüyü sadece izleyenlere gönderir
  socket.on('streamWatch', ({ to, on } = {}) => {
    if (!myVoice || !voice.get(myVoice)?.has(to)) return;
    io.to(to).emit('streamWatch', { from: socket.id, name: me, on: !!on });
  });

  socket.on('typing', () => { if (me && cur) socket.to(cur).emit('typing', { channelId: cur, name: me }); });

  // ----- Sunucular -----
  socket.on('createServer', (arg, cb = () => {}) => {
    if (!me) return;
    if (limited('srv|' + me, 5, 3600e3)) return cb({ error: 'Bir saatte en fazla 5 sunucu kurabilirsin' });
    const opts = typeof arg === 'string' ? { name: arg } : (arg || {});
    const name = clean(opts.name, 40); if (!name) return cb({ error: 'Sunucu adı gerekli' });
    const tpl = TEMPLATES[opts.template] || TEMPLATES.bos;
    const s = {
      id: id(), name, icon: [...name][0].toUpperCase(), owner: me, members: [me], joinedAt: { [me]: Date.now() }, createdAt: Date.now(), setup: {}, roles: {}, customRoles: [], memberRoles: {}, bans: {}, timeouts: {}, invite: crypto.randomBytes(4).toString('hex'),
      channels: [], template: opts.template in TEMPLATES ? opts.template : 'bos'
    };
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
    db.servers.push(s); save();
    pushServers([me]);
    cb(serverView(s, me));
  });

  socket.on('createChannel', ({ serverId, name, type, cat, private: priv } = {}, cb = () => {}) => {
    const s = db.servers.find(x => x.id === serverId);
    if (!me || !s || !(s.public || s.members.includes(me))) return cb({ error: 'Yetkin yok' });
    if ((s.customRoles?.length || s.lockChannels) && !can(s, me, 'manageChannels')) return cb({ error: 'Oda açma yetkin yok' });
    type = ['voice', 'stage', 'forum'].includes(type) ? type : 'text';
    name = clean(name, 30); if (type === 'text' || type === 'forum') name = name.toLowerCase().replace(/\s+/g, '-');
    if (!name) return cb({ error: 'Oda adı gerekli' });
    const k = cat && s.categories.find(x => x.id === cat);
    const c = { id: id(), name, type, perms: {}, sync: !!k && !priv };
    if (type === 'stage') c.topic = 'Sahne';
    if (k) c.cat = k.id;
    if (priv) c.perms = { '@everyone': { view: false } };
    const last = s.channels.map(x => x.cat || null).lastIndexOf(k?.id || null);
    if (last >= 0) s.channels.splice(last + 1, 0, c);
    else if (k) { const ord = s.categories.indexOf(k); const after = s.channels.findIndex(x => x.cat && s.categories.findIndex(y => y.id === x.cat) > ord); s.channels.splice(after < 0 ? s.channels.length : after, 0, c); }
    else s.channels.unshift(c);
    if (s.owner === me) setupOf(s).channels = true;
    audit(s, me, 'Oda oluşturdu', c.name); save();
    pushServers(membersOf(s));
    cb(chView(s, c, me, true));
  });
  socket.on('discover', ({ q, cat } = {}, cb = () => {}) => {
    if (!me) return cb([]);
    q = clean(q, 60).toLocaleLowerCase('tr');
    const on = new Set(onlineNames()), W = { resmi: 40, partner: 30, dogrulanmis: 20, topluluk: 10 };
    const list = db.servers.filter(s => (s.public || s.discoverable) && !s.bans?.[me])
      .filter(s => !cat || s.category === cat)
      .filter(s => !q || s.name.toLocaleLowerCase('tr').includes(q) || (s.description || '').toLocaleLowerCase('tr').includes(q))
      .map(s => { const mem = membersOf(s), b = srvBadges(s); return { id: s.id, name: s.name, icon: s.icon, iconImg: s.iconImg || null, banner: s.banner || null, bannerColor: s.bannerColor || null,
        description: s.description || (s.public ? 'Kanka Chat\'in resmi sunucusu. Duyurular, yenilikler ve sohbet.' : ''), category: s.public ? 'Sohbet' : s.category || 'Diğer', badges: b,
        members: mem.length, online: mem.filter(n => on.has(n)).length, invite: s.invite, joined: s.public || s.members.includes(me), _w: b.reduce((a, x) => a + (W[x.id] || 0), 0) }; })
      .sort((a, b) => b._w - a._w || b.online - a.online || b.members - a.members).slice(0, 60);
    cb({ list, cats: CATS });
  });
  socket.on('acceptRules', (serverId, cb = () => {}) => {
    const s = db.servers.find(x => x.id === serverId);
    if (!me || !s || !membersOf(s).includes(me)) return cb({ error: 'Geçersiz' });
    (s.accepted ||= {})[me] = Date.now(); save(); pushServers([me]); cb({ ok: true });
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
  socket.on('joinInvite', (code, cb = () => {}) => {
    code = clean(code, 200).split(/[=/]/).pop();
    const s = db.servers.find(x => x.invite === code);
    if (!me || !s) return cb({ error: 'Davet kodu geçersiz' });
    if (s.bans?.[me]) return cb({ error: 'Bu sunucudan yasaklandın' });
    if (!s.public && !s.members.includes(me)) { s.members.push(me); (s.joinedAt ||= {})[me] = Date.now(); save(); pushServers(s.members); }
    cb(serverView(s, me));
  });

  socket.on('leaveServer', (serverId, cb = () => {}) => {
    const s = db.servers.find(x => x.id === serverId);
    if (!me || !s || s.public) return cb({ error: 'Bu sunucudan ayrılamazsın' });
    s.members = s.members.filter(n => n !== me);
    voiceKick(s.channels.map(c => c.id), me, 'Sunucudan ayrıldın');
    if (s.owner === me) s.owner = s.members[0] || null;
    if (!s.members.length) db.servers = db.servers.filter(x => x !== s);
    save(); pushServers([me, ...s.members]); cb({ ok: true });
  });

  // ----- Sesli odalar (WebRTC sinyalleşme) -----
  function leaveVoice() {
    if (!myVoice) return;
    const room = voice.get(myVoice);
    if (room) { room.delete(socket.id); if (!room.size) voice.delete(myVoice); }
    socket.to('v:' + myVoice).emit('voiceLeft', socket.id);
    socket.leave('v:' + myVoice);
    voiceMedia.delete(socket.id); voiceFlags.delete(socket.id);
    { const st = stage.get(myVoice); if (st && ![...(voice.get(myVoice)?.values() || [])].includes(me)) { st.speakers.delete(me); st.hands.delete(me); io.to('v:' + myVoice).emit('stage', { ch: myVoice, ...stageView(myVoice) }); } }
    myVoice = null;
    pushVoice();
  }
  socket.on('voiceJoin', (chId, cb = () => {}) => {
    const isCall = typeof chId === 'string' && chId.startsWith('call:');
    const f = isCall ? null : findChannel(chId);
    if (!me) return cb({ error: 'Erişim yok' });
    if (isCall ? !canAccess(me, chId.slice(5)) || !isPrivateChat(chId.slice(5)) : (!f || !voiceLike(f.c.type) || !(f.s.public || f.s.members.includes(me)) || f.s.bans?.[me] || !seesChannel(f.s, f.c, me))) return cb({ error: 'Erişim yok' });
    if (f && !chPerm(f.s, f.c, me, 'connect')) return cb({ error: 'Bu sesli odaya bağlanma iznin yok' });
    if (f && timedOut(f.s, me)) return cb({ error: 'Susturulduğun için sesli odalara giremezsin' });
    if (f?.c.limit && myVoice !== chId && (voice.get(chId)?.size || 0) >= f.c.limit && !can(f.s, me, 'manageChannels') && f.s.owner !== me) return cb({ error: `Oda dolu (${f.c.limit}/${f.c.limit})` });
    leaveVoice();
    const room = voice.get(chId) || new Map();
    const peers = [...room].map(([sid, name]) => ({ sid, name }));
    room.set(socket.id, me); voice.set(chId, room);
    onbFlag(me, 'voice');
    socket.to('v:' + chId).emit('voiceJoined', { sid: socket.id, name: me });
    myVoice = chId; socket.join('v:' + chId);
    pushVoice();
    cb({ peers, stage: f?.c.type === 'stage' ? stageView(chId) : null });
  });
  socket.on('voiceLeave', leaveVoice);
  socket.on('vflags', ({ m } = {}) => { if (!myVoice) return; const was = !!voiceFlags.get(socket.id)?.m; voiceFlags.set(socket.id, { m: !!m }); if (was !== !!m) io.emit('voiceFlags', flagsState()); });
  socket.on('signal', ({ to, data } = {}) => {
    if (!myVoice || !voice.get(myVoice)?.has(to)) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('disconnect', () => {
    leaveVoice();
    online.delete(socket.id); idleSockets.delete(socket.id); visibleSockets.delete(socket.id);
    pushPresence();
  });
});

setInterval(() => {
  const now = Date.now();
  let pres = false, prof = false;
  for (const u of Object.values(db.users)) {
    if (u.presenceUntil && u.presenceUntil <= now) { u.presence = 'online'; u.presenceUntil = null; pres = true; io.to('user:' + u.name).emit('myStatus', { st: 'online', until: null, expired: true }); }
    if (u.statusUntil && u.statusUntil <= now) { u.status = ''; u.statusUntil = null; prof = true; io.to('user:' + u.name).emit('customStatus', { text: '', until: null, expired: true }); }
  }
  if (pres) pushPresence(); if (prof) io.emit('users', allUsers()); if (pres || prof) save();
}, 15e3);
setInterval(() => {
  const now = Date.now(), due = (db.scheduled || []).filter(x => x.at <= now);
  if (!due.length) return;
  db.scheduled = db.scheduled.filter(x => x.at > now);
  for (const x of due) if (db.users[x.author] && canAccess(x.author, x.chId)) {
    const r = postMessage(x.author, x.chId, { kind: 'text', text: x.text, scheduled: true });
    if (r.msg) { io.to('user:' + x.author).emit('toast', 'Zamanlanmış mesajın gönderildi'); }
  }
  save();
}, process.env.SCHED_MS ? +process.env.SCHED_MS : 10e3);

server.listen(PORT, () => console.log(`Kanka Chat çalışıyor: http://localhost:${PORT}`));
