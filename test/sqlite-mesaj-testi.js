// SQLite mesaj deposu senaryo testleri
// Çalıştırma: npm i --no-save socket.io-client && node test/sqlite-mesaj-testi.js <yeni-kod-klasörü> <eski-server.js-klasörü>
const { spawn } = require('child_process'), fs = require('fs'), path = require('path'), c = require('crypto');
const { io } = require('socket.io-client');
const APP = process.argv[2], OLD = process.argv[3]; // yeni ve eski server.js klasörleri
const D = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sq.'));
const WIN = process.platform === 'win32'; // Windows'ta SIGTERM de zorla kapatır (VDS'teki gibi): kapanış kaydı çalışmaz
const PORT = 3998, U = 'http://localhost:' + PORT;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let proc;
async function start(dir = APP, env = {}) {
  proc = spawn(process.execPath, ['server.js'], { cwd: dir, env: { ...process.env, DATA_DIR: D, PORT, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.out = ''; proc.stdout.on('data', d => proc.out += d); proc.stderr.on('data', d => proc.out += d);
  for (let i = 0; i < 50; i++) { await sleep(200); try { if ((await fetch(U + '/api/surum')).ok) return; } catch {} }
  throw new Error('açılmadı: ' + proc.out);
}
const stop = async (sig = 'SIGTERM') => { const p = proc; const done = new Promise(r => p.on('exit', r)); p.kill(sig); await done; };
const conn = () => new Promise(r => { const s = io(U, { transports: ['websocket'], forceNew: true }); s.on('connect', () => r(s)); });
const emit = (s, ev, d) => new Promise(r => s.emit(ev, d, r));
async function session() { const s = await conn(); const r = await emit(s, 'login', { name: 'testci', password: 'gizli123' }); if (r.error) throw new Error(r.error); const j = await emit(s, 'join', 'c1'); if (j.error) throw new Error(j.error); s.hist = j.messages; return s; }
async function texts() { const s = await session(); const t = s.hist.map(m => m.text); s.close(); return t; }
const ok = (cond, msg) => { console.log((cond ? 'GEÇTİ  ' : 'HATALI ') + msg); if (!cond) process.exitCode = 1; };
(async () => {
  // Eski düzende bir data.json: 5 mesaj
  const salt = c.randomBytes(16).toString('hex');
  const db = { users: { testci: { name: 'testci', email: 't@e.com', salt, hash: c.scryptSync('gizli123', salt, 32).toString('hex'), xp: 0, createdAt: Date.now(), onb: {}, color: '#ff7a59', dob: '1995-05-05', birthday: '05-05', terms: { v: 1, at: Date.now() } } },
    sessions: {}, servers: [], playlists: {}, messages: { c1: [1, 2, 3, 4, 5].map(i => ({ id: 'eski' + i, author: 'testci', time: Date.now() - 1e6 + i, kind: 'text', text: 'eski-' + i, reactions: {} })) } };
  fs.writeFileSync(path.join(D, 'data.json'), JSON.stringify(db));

  await start();
  let t = await texts(); ok(t.includes('eski-5'), 'A: eski data.json mesajları yüklendi');
  let s = await session();
  for (let i = 1; i <= 3; i++) await emit(s, 'message', { text: 'yeni-' + i });
  await sleep(800);
  ok(fs.existsSync(path.join(D, 'mesajlar.db')), 'A: mesajlar.db oluştu');
  let j = JSON.parse(fs.readFileSync(path.join(D, 'data.json'), 'utf8'));
  ok(j.msgSnapAt && j.msgWrittenAt && Array.isArray(j.messages.c1), 'A: data.json hâlâ mesajları içeriyor + damgalar var');

  // B: zorla kapatma (kill -9) — data.json görüntüsü eski olsa da mesajlar SQLite'tan gelmeli
  await emit(s, 'message', { text: 'kill-oncesi' }); await sleep(600);
  const msgId = (await session()).hist.find(m => m.text === 'yeni-1').id;
  s.emit('edit', { msgId, text: 'yeni-1-duzenlendi' }); s.emit('react', { msgId, emoji: '👍' }); await sleep(600);
  s.close(); await stop('SIGKILL');
  j = JSON.parse(fs.readFileSync(path.join(D, 'data.json'), 'utf8'));
  ok(!j.messages.c1.some(m => m.text === 'kill-oncesi'), 'B: (kontrol) data.json görüntüsünde son mesaj yok — 10 dk aralık');
  await start();
  s = await session(); t = s.hist.map(m => m.text);
  ok(t.includes('kill-oncesi'), 'B: zorla kapatmadan sonra son mesaj SQLite\'tan geri geldi');
  const e = s.hist.find(m => m.id === msgId);
  ok(e?.text === 'yeni-1-duzenlendi' && e?.reactions?.['👍']?.includes('testci'), 'B: düzenleme ve tepki korunmuş');
  ok(/mesajlar\.db: \d+ kanal güncellendi/.test(proc.out), 'B: açılışta SQLite üstüne kondu (günlük)'); if (!/kanal güncellendi/.test(proc.out)) console.log(proc.out);

  // C: silme ve normal kapanış
  const del = s.hist.find(m => m.text === 'yeni-2').id; s.emit('delete', del); await sleep(600); s.close();
  await stop('SIGTERM');
  j = JSON.parse(fs.readFileSync(path.join(D, 'data.json'), 'utf8'));
  if (!WIN) ok(j.messages.c1.some(m => m.text === 'kill-oncesi') && !j.messages.c1.some(m => m.id === del), 'C: normal kapanışta data.json tam görüntüyle yazıldı');
  await start(); t = await texts();
  ok(!t.includes('yeni-2') && t.includes('yeni-3'), 'C: silinen mesaj geri gelmedi');

  // D: eski sürüme dönüş: eski kod data.json'u değiştirir, yeni kod gelince SQLite'taki eski kopya data.json'u ezmemeli
  s = await session(); await emit(s, 'message', { text: 'donus-oncesi' }); await sleep(600); s.close(); await stop('SIGKILL');
  await start(OLD); t = await texts();
  s = await session(); await emit(s, 'message', { text: 'eski-surumde-yazildi' }); await sleep(800); s.close();
  await stop('SIGKILL');
  await start(); t = await texts();
  ok(t.includes('eski-surumde-yazildi'), 'D: geri dönüşte eski sürümde yazılan mesaj kaybolmadı');
  ok(/başka bir sürümce yazılmış/.test(proc.out), 'D: eski SQLite kopyası algılanıp yenilendi');
  await stop();

  // E: KANKA_SQLITE=0
  await start(APP, { KANKA_SQLITE: '0' }); s = await session(); await emit(s, 'message', { text: 'json-modu' }); await sleep(800); s.close(); await stop('SIGKILL');
  j = JSON.parse(fs.readFileSync(path.join(D, 'data.json'), 'utf8'));
  ok(j.messages.c1.some(m => m.text === 'json-modu') && !j.msgSnapAt, 'E: KANKA_SQLITE=0 iken data.json her kayıtta tam yazılıyor');
  await start(); t = await texts(); ok(t.includes('json-modu'), 'E: tekrar SQLite moduna geçince veri yerinde'); await stop();
  console.log('veri klasörü:', D);
  process.exit();
})().catch(async e => { console.error('TEST ÇÖKTÜ', e); try { console.log(proc.out.slice(-1500)); await stop('SIGKILL'); } catch {} process.exit(1); });
