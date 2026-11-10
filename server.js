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
  const game = auto?.game || u.manual?.game || null;
  const music = auto?.music || u.manual?.music || null;
  return game || music ? { game, music, auto: !!auto } : null;
}
const pushActivity = u => io.emit('activity', { name: u.name, activities: activitiesOf(u) });
app.post('/api/presence', async (req, res) => {
  const { key, game, detail, music } = req.body || {};
  const u = key && Object.values(db.users).find(x => x.presenceKey === key);
  if (!u) return res.status(401).json({ error: 'Anahtar geçersiz' });
  const prev = u.auto && Date.now() - u.auto.at < 45e3 ? u.auto : {};
  const g = typeof game === 'string' && game.trim() ? clean(game, 60) : null;
  const m = music && typeof music.title === 'string' && music.title.trim() ? { title: clean(music.title, 120), artist: clean(music.artist, 120) } : null;
  const next = { at: Date.now(),
    game: g ? { name: g, detail: clean(detail, 40), start: prev.game?.name === g ? prev.game.start : Date.now() } : null,
    music: m ? { ...m, start: prev.music?.title === m.title ? prev.music.start : Date.now(), art: prev.music?.title === m.title ? prev.music.art : null } : null };
  const changed = JSON.stringify([prev.game?.name, prev.game?.detail, prev.music?.title]) !== JSON.stringify([next.game?.name, next.game?.detail, next.music?.title]) || !prev.at;
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
  s.roles ||= {};
  for (const c of s.channels) c.type ||= 'text';
  if (s.id === 's1' && !s.channels.some(c => c.type === 'voice')) s.channels.push({ id: 'v1', name: 'Sohbet', type: 'voice' });
}

function ensureOwners() {
  const first = Object.values(db.users).filter(u => u.name !== 'Claude').sort((a, b) => a.createdAt - b.createdAt)[0];
  for (const s of db.servers) if (!s.owner && first) s.owner = first.name;
}
ensureOwners();

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
const pubUser = u => ({ name: u.name, color: u.color, xp: u.xp || 0, level: level(u.xp), avatar: u.avatar || null, status: u.status || '', bio: u.bio || '', banner: u.banner || null, createdAt: u.createdAt || null,
  birthday: u.birthday || null, music: u.music || null, activities: activitiesOf(u), badges: badgesOf(u), streak: u.streak?.count || 0, friendCount: (u.friends || []).length });
const social = n => { const u = db.users[n] || {}; return { friends: u.friends || [], reqIn: u.reqIn || [], reqOut: u.reqOut || [], blocked: u.blocked || [] }; };
const pushSocial = (...names) => names.forEach(n => io.to('user:' + n).emit('social', social(n)));
const allUsers = () => Object.values(db.users).map(pubUser);

const serversFor = name => db.servers.filter(s => s.public || s.members.includes(name));
const serverView = s => ({
  id: s.id, name: s.name, icon: s.icon, iconImg: s.iconImg || null, owner: s.owner || null, invite: s.invite, public: s.public, roles: s.roles,
  emojis: s.emojis || {}, filter: !!s.filter, slow: s.slow || 0,
  channels: s.channels, members: s.public ? Object.keys(db.users) : s.members
});
const findChannel = chId => {
  for (const s of db.servers) { const c = s.channels.find(c => c.id === chId); if (c) return { s, c }; }
  return null;
};
const dmId = (a, b) => 'dm:' + [a, b].sort().join('|');
const dmPeers = chId => chId.slice(3).split('|');
function canAccess(name, chId) {
  if (!name || !chId) return false;
  if (chId.startsWith('dm:')) return dmPeers(chId).includes(name);
  const f = findChannel(chId);
  return !!f && f.c.type === 'text' && (f.s.public || f.s.members.includes(name));
}
function dmsFor(name) {
  return Object.keys(db.messages)
    .filter(k => k.startsWith('dm:') && dmPeers(k).includes(name) && db.messages[k].length)
    .map(k => ({ id: k, with: dmPeers(k).find(n => n !== name) || name, last: db.messages[k].at(-1).time }))
    .sort((a, b) => b.last - a.last);
}
const findMsg = (chId, msgId) => (db.messages[chId] || []).find(m => m.id === msgId);
const roleOf = (s, n) => s.owner === n ? 'admin' : (s.roles?.[n] || 'member');
const isMod = (s, n) => ['admin', 'mod'].includes(roleOf(s, n));
const serverOf = chId => chId && !chId.startsWith('dm:') ? findChannel(chId)?.s : null;
const UPLOAD_RE = /^\/uploads\/[a-f0-9]+\.(png|jpe?g|gif|webp)$/;

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
  return b;
}

// ---------- Çevrimiçi ve ses durumu ----------
const online = new Map();            // socket.id -> kullanıcı adı
const voice = new Map();             // kanal id -> Map(socket.id -> ad)
const onlineNames = () => [...new Set(online.values())];
const voiceState = () => Object.fromEntries([...voice].map(([k, m]) => [k, [...new Set(m.values())]]));
const pushPresence = () => io.emit('presence', onlineNames());
const pushVoice = () => io.emit('voiceState', voiceState());
function pushServers(names) {
  for (const n of names) io.to('user:' + n).emit('servers', serversFor(n).map(serverView));
}
const membersOf = s => s.public ? Object.keys(db.users) : s.members;

function postMessage(me, chId, p = {}) {
  const u = db.users[me];
  const msg = { id: id(), author: me, color: u.color, time: Date.now(), kind: 'text', reactions: {} };
  const kind = p.kind || 'text';
  if (p.scheduled) msg.scheduled = true;

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
  const where = chId.startsWith('dm:') ? 'özel mesaj' : (() => { const f = findChannel(chId); return `${f.s.name} › ${f.c.name}`; })();
  const preview = (msg.text || msg.plan?.title || msg.poll?.question || msg.song?.title || (msg.game ? 'bir oyun başlattı' : 'görsel gönderdi')).slice(0, 120);
  if (chId.startsWith('dm:')) {
    for (const n of dmPeers(chId)) {
      io.to('user:' + n).emit('dms', dmsFor(n));
      if (n !== me) io.to('user:' + n).emit('notify', { from: me, text: preview, channelId: chId, where, dm: true });
    }
  } else {
    const f = findChannel(chId);
    for (const n of membersOf(f.s)) if (n !== me) io.to('user:' + n).emit('activity', { channelId: chId, serverId: f.s.id });
    const mentioned = new Set([...(msg.text || '').matchAll(/@([\p{L}\p{N}_.-]+)/gu)].map(m => m[1]));
    for (const n of mentioned) {
      if (n !== me && db.users[n] && canAccess(n, chId))
        io.to('user:' + n).emit('notify', { from: me, text: preview, channelId: chId, where, mention: true });
    }
  }
  return { ok: true, msg };
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
      token, user: pubUser(db.users[name]), users: allUsers(), online: onlineNames(),
      servers: serversFor(name).map(serverView), dms: dmsFor(name), voice: voiceState()
    };
  }

  socket.on('register', ({ name, password } = {}, cb) => {
    const w = limited('reg|' + ip, 5, 3600e3);
    if (w) return cb({ error: `Bu bağlantıdan çok fazla hesap açıldı. ${Math.ceil(w / 60)} dakika sonra tekrar dene.` });
    name = clean(name, 20); password = String(password ?? '');
    if (!NAME_RE.test(name)) return cb({ error: 'Kullanıcı adı 2-20 karakter olmalı; harf, rakam, _ . - kullanabilirsin.' });
    if (password.length < 6) return cb({ error: 'Şifre en az 6 karakter olmalı.' });
    if (Object.keys(db.users).some(n => n.toLowerCase() === name.toLowerCase())) return cb({ error: 'Bu kullanıcı adı alınmış.' });
    const salt = crypto.randomBytes(16).toString('hex');
    db.users[name] = { name, color: COLORS[Object.keys(db.users).length % COLORS.length], salt, hash: hashPw(password, salt), xp: 0, createdAt: Date.now() };
    ensureOwners(); save();
    io.emit('users', allUsers());
    pushServers(onlineNames()); // herkese açık sunucunun üye listesi değişti
    cb(start(name));
  });

  socket.on('login', ({ name, password } = {}, cb) => {
    const key = 'login|' + ip + '|' + clean(name, 20).toLowerCase(), now = Date.now();
    const fails = (limits.get(key) || []).filter(t => now - t < 600e3);
    if (fails.length >= 5) return cb({ error: `Çok fazla hatalı deneme. ${Math.ceil((600e3 - (now - fails[0])) / 60000)} dakika sonra tekrar dene.` });
    const u = Object.values(db.users).find(u => u.name.toLowerCase() === clean(name, 20).toLowerCase());
    if (!u || hashPw(String(password ?? ''), u.salt) !== u.hash) { fails.push(now); limits.set(key, fails); return cb({ error: fails.length >= 5 ? 'Çok fazla hatalı deneme, 10 dakika bekle.' : 'Kullanıcı adı ya da şifre yanlış.' }); }
    limits.delete(key);
    cb(start(u.name));
  });

  socket.on('auth', (token, cb) => {
    const n = db.sessions[token];
    if (!n || !db.users[n]) return cb({ error: 'Oturum bulunamadı' });
    delete db.sessions[token];
    cb(start(n));
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
    if (srv?.slow && !isMod(srv, me)) {
      const key = cur + '|' + me, last = slowMap.get(key) || 0, wait = srv.slow * 1000 - (Date.now() - last);
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
    if (list[i].author !== me && !(f && isMod(f.s, me))) return;
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
    const s = serverOf(cur);
    if (s && !isMod(s, me)) return;
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
  socket.on('updateProfile', ({ avatar, status, bio, banner, color, birthday, music } = {}, cb = () => {}) => {
    const u = db.users[me]; if (!u) return;
    if (avatar === null) u.avatar = null;
    else if (avatar !== undefined) { if (!UPLOAD_RE.test(avatar)) return cb({ error: 'Geçersiz resim' }); u.avatar = avatar; }
    if (status !== undefined) u.status = clean(status, 60);
    if (bio !== undefined) u.bio = clean(bio, 190);
    if (banner !== undefined) u.banner = /^#[0-9a-f]{6}$/i.test(banner) ? banner : null;
    if (color !== undefined && /^#[0-9a-f]{6}$/i.test(color)) u.color = color;
    if (birthday !== undefined) u.birthday = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(birthday) ? birthday : null;
    if (music !== undefined) u.music = /^https?:\/\/\S{4,300}$/.test(music) ? music : null;
    save(); io.emit('users', allUsers()); cb({ ok: true });
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
  socket.on('updateServer', ({ serverId, name, icon, iconImg, filter, slow } = {}, cb = () => {}) => {
    const s = adminServer(serverId, true); if (!s) return cb({ error: 'Sadece yönetici değiştirebilir' });
    if (filter !== undefined) { s.filter = !!filter; audit(s, me, filter ? 'Küfür filtresini açtı' : 'Küfür filtresini kapattı'); }
    if (slow !== undefined) { s.slow = [0, 5, 10, 30, 60, 300].includes(+slow) ? +slow : 0; audit(s, me, 'Yavaş modu ayarladı', s.slow ? s.slow + ' sn' : 'kapalı'); }
    if (name !== undefined || icon !== undefined || iconImg !== undefined) audit(s, me, 'Sunucu ayarlarını değiştirdi');
    if (name !== undefined) { name = clean(name, 40); if (name) s.name = name; }
    if (icon !== undefined) { icon = clean(icon, 4); if (icon) s.icon = icon; }
    if (iconImg !== undefined) s.iconImg = iconImg && UPLOAD_RE.test(iconImg) ? iconImg : null;
    save(); pushServers(membersOf(s)); cb({ ok: true });
  });
  socket.on('setRole', ({ serverId, name, role } = {}, cb = () => {}) => {
    const s = adminServer(serverId, true); if (!s) return cb({ error: 'Sadece yönetici rol verebilir' });
    if (!membersOf(s).includes(name) || name === s.owner) return cb({ error: 'Bu kişinin rolü değiştirilemez' });
    if (role === 'mod') s.roles[name] = 'mod'; else delete s.roles[name];
    audit(s, me, role === 'mod' ? 'Moderatör yaptı' : 'Moderatörlüğü aldı', name);
    save(); pushServers(membersOf(s)); cb({ ok: true });
  });
  socket.on('kick', ({ serverId, name } = {}, cb = () => {}) => {
    const s = adminServer(serverId, false); if (!s) return cb({ error: 'Yetkin yok' });
    if (s.public) return cb({ error: 'Herkese açık sunucudan kimse atılamaz' });
    if (name === s.owner || (roleOf(s, name) === 'mod' && roleOf(s, me) !== 'admin')) return cb({ error: 'Bu kişiyi atamazsın' });
    s.members = s.members.filter(n => n !== name); delete s.roles[name];
    audit(s, me, 'Sunucudan attı', name);
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
    io.to('user:' + name).emit('notify', { from: me, text: 'sana arkadaşlık isteği gönderdi', where: 'Arkadaşlar', friend: true });
    cb({ ok: true });
  });
  socket.on('friendAccept', (name, cb = () => {}) => {
    const a = U(me), b = U(name);
    if (!a || !b || !a.reqIn.includes(name)) return cb({ error: 'İstek bulunamadı' });
    pull(a.reqIn, name); pull(b.reqOut, me); a.friends.push(name); b.friends.push(me);
    save(); pushSocial(me, name); io.emit('users', allUsers());
    io.to('user:' + name).emit('toast', `${me} arkadaşlık isteğini kabul etti`);
    cb({ ok: true });
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
    for (const n of who) io.to('user:' + n).emit('notify', { from: me, text: `konuda yanıtladı: ${text.slice(0, 80)}`, channelId: cur, where: 'Konu', mention: true });
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
  socket.on('setActivity', ({ game, music } = {}, cb = () => {}) => {
    const u = db.users[me]; if (!u) return;
    const g = clean(game, 60), t = clean(music?.title, 120);
    u.manual = { game: g ? { name: g, start: u.manual?.game?.name === g ? u.manual.game.start : Date.now() } : null,
      music: t ? { title: t, artist: clean(music?.artist, 120), start: Date.now(), art: null } : null };
    save(); pushActivity(u); cb({ ok: true });
    if (u.manual.music) albumArt(t, u.manual.music.artist).then(a => { if (a && u.manual?.music?.title === t) { u.manual.music.art = a; save(); pushActivity(u); } });
  });
  socket.on('presenceKey', ({ renew } = {}, cb = () => {}) => {
    const u = db.users[me]; if (!u) return;
    if (!u.presenceKey || renew) { u.presenceKey = crypto.randomBytes(18).toString('hex'); save(); }
    cb({ key: u.presenceKey, connected: !!(u.auto && Date.now() - u.auto.at < 45e3) });
  });

  // ----- Ses: konuşma göstergesi -----
  socket.on('speaking', on => { if (myVoice) io.emit('speaking', { name: me, on: !!on, sid: socket.id }); });
  socket.on('media', st => { if (myVoice) socket.to('v:' + myVoice).emit('media', { sid: socket.id, name: me, cam: !!st?.cam, screen: !!st?.screen }); });

  socket.on('typing', () => { if (me && cur) socket.to(cur).emit('typing', { channelId: cur, name: me }); });

  // ----- Sunucular -----
  socket.on('createServer', (name, cb = () => {}) => {
    if (!me) return;
    name = clean(name, 40); if (!name) return cb({ error: 'Sunucu adı gerekli' });
    const s = {
      id: id(), name, icon: [...name][0].toUpperCase(), owner: me, members: [me], roles: {}, invite: crypto.randomBytes(4).toString('hex'),
      channels: [{ id: id(), name: 'genel', type: 'text' }, { id: id(), name: 'Sohbet', type: 'voice' }]
    };
    db.servers.push(s); save();
    pushServers([me]);
    cb(serverView(s));
  });

  socket.on('createChannel', ({ serverId, name, type } = {}, cb = () => {}) => {
    const s = db.servers.find(x => x.id === serverId);
    if (!me || !s || !(s.public || s.members.includes(me))) return cb({ error: 'Yetkin yok' });
    type = type === 'voice' ? 'voice' : 'text';
    name = clean(name, 30); if (type === 'text') name = name.toLowerCase().replace(/\s+/g, '-');
    if (!name) return cb({ error: 'Oda adı gerekli' });
    const c = { id: id(), name, type };
    s.channels.push(c); save();
    pushServers(membersOf(s));
    cb(c);
  });

  socket.on('joinInvite', (code, cb = () => {}) => {
    code = clean(code, 200).split(/[=/]/).pop();
    const s = db.servers.find(x => x.invite === code);
    if (!me || !s) return cb({ error: 'Davet kodu geçersiz' });
    if (!s.public && !s.members.includes(me)) { s.members.push(me); save(); pushServers(s.members); }
    cb(serverView(s));
  });

  socket.on('leaveServer', (serverId, cb = () => {}) => {
    const s = db.servers.find(x => x.id === serverId);
    if (!me || !s || s.public) return cb({ error: 'Bu sunucudan ayrılamazsın' });
    s.members = s.members.filter(n => n !== me);
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
    myVoice = null;
    pushVoice();
  }
  socket.on('voiceJoin', (chId, cb = () => {}) => {
    const f = findChannel(chId);
    if (!me || !f || f.c.type !== 'voice' || !(f.s.public || f.s.members.includes(me))) return cb({ error: 'Erişim yok' });
    leaveVoice();
    const room = voice.get(chId) || new Map();
    const peers = [...room].map(([sid, name]) => ({ sid, name }));
    room.set(socket.id, me); voice.set(chId, room);
    socket.to('v:' + chId).emit('voiceJoined', { sid: socket.id, name: me });
    myVoice = chId; socket.join('v:' + chId);
    pushVoice();
    cb({ peers });
  });
  socket.on('voiceLeave', leaveVoice);
  socket.on('signal', ({ to, data } = {}) => {
    if (!myVoice || !voice.get(myVoice)?.has(to)) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('disconnect', () => {
    leaveVoice();
    online.delete(socket.id);
    pushPresence();
  });
});

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
