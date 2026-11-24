// Kanka Chat otomatik güncelleyici (VDS)
// GitHub'daki depoyu dakikada bir kontrol eder; yeni sürüm varsa dosyaları günceller,
// gerekirse paketleri kurar ve sunucuyu yeniden başlatır. Masaüstü uygulamasının
// güncelleme paketlerini de GitHub Releases'tan indir/ klasörüne çeker.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REPO = 'Reuskilled/kanka-chat', BRANCH = 'main';
const APP = __dirname;
const STATE = path.join(APP, 'veri', 'guncelleme.json');
const LOG = path.join(APP, 'kayitlar', 'guncelleme.log');
const SYNC = [ // depodaki yol -> sunucudaki yol
  ['server.js', 'server.js'], ['package.json', 'package.json'], ['package-lock.json', 'package-lock.json'],
  ['public', 'public'], ['vds/guncelleyici.js', 'guncelleyici.js'], ['vds/Caddyfile', 'Caddyfile'],
];
const H = { 'User-Agent': 'kanka-guncelleyici', Accept: 'application/vnd.github+json' };

let st = { sha: null, etag: null, relEtag: null };
try { st = { ...st, ...JSON.parse(fs.readFileSync(STATE, 'utf8')) }; } catch {}
const save = () => { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(st, null, 2)); };
const log = m => { const l = `[${new Date().toLocaleString('tr-TR')}] ${m}`; console.log(l); try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, l + '\n'); } catch {} };
const hash = f => { try { return crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex'); } catch { return null; } };

// Değişen her dosyanın eski hâli BAK klasörüne kopyalanır; yeni sürüm açılmazsa geri konur
const BAK = path.join(APP, 'veri', 'onceki-surum');
function syncPath(src, dst, changed, created) {
  if (!fs.existsSync(src)) return;
  if (fs.statSync(src).isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const n of fs.readdirSync(src)) syncPath(path.join(src, n), path.join(dst, n), changed, created);
    return;
  }
  const rel = path.relative(APP, dst);
  // package-lock.json'ı npm kurulumu sunucuda yeniden yazıyor; bu yüzden sunucudaki dosyayla değil, depodan en son alınan hâliyle karşılaştır.
  // (Yoksa her güncellemede "değişti" sanılıp paketler kuruluyor ve sunucu boş yere yeniden başlıyordu.)
  if (rel === 'package-lock.json') { const h = hash(src); if (!st.lockSrc) st.lockSrc = h; if (h === st.lockSrc) return; st.lockSrc = h; }
  else if (hash(src) === hash(dst)) return;
  if (fs.existsSync(dst)) { const b = path.join(BAK, rel); fs.mkdirSync(path.dirname(b), { recursive: true }); fs.copyFileSync(dst, b); }
  else created.push(rel);
  const tmp = dst + '.yeni';
  fs.copyFileSync(src, tmp);
  // Windows'ta dosya o an okunuyorsa (sunucu, virüs tarayıcı) yeniden adlandırma EPERM verebiliyor: kısa aralıklarla tekrar dene
  for (let i = 0; ; i++) { try { fs.renameSync(tmp, dst); break; } catch (e) { if (i >= 9 || !/EPERM|EBUSY|EACCES/.test(e.code || '')) throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); } }
  changed.push(rel);
}

// Kurmadan önce kontrol: sözdizimi hatalı JS ya da bozuk package.json canlıya hiç gitmesin
function validate(root) {
  const errs = [];
  const jsFiles = ['server.js', 'vds/guncelleyici.js'];
  const walk = d => { if (!fs.existsSync(d)) return; for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) { if (n !== 'vendor') walk(p); } else if (/\.js$/.test(n)) jsFiles.push(path.relative(root, p)); } };
  walk(path.join(root, 'public'));
  for (const f of jsFiles) {
    const p = path.join(root, f); if (!fs.existsSync(p)) { if (f === 'server.js') errs.push('server.js yok'); continue; }
    try { execFileSync(process.execPath, ['--check', p], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, timeout: 60e3 }); }
    catch (e) { errs.push(`${f}: ${String(e.stderr || e.message).split('\n').filter(Boolean).slice(0, 4).join(' | ').slice(0, 400)}`); }
  }
  for (const f of ['package.json', 'package-lock.json']) {
    const p = path.join(root, f); if (!fs.existsSync(p)) continue;
    try { JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { errs.push(`${f}: ${e.message}`); }
  }
  return errs;
}

// Yeni sunucu ayağa kalktı mı? /api/surum cevap vermeli ve yeniden başlatmadan sonra açılmış olmalı
const PORT = process.env.PORT || 3000;
async function healthy(since, waitMs = 90e3) {
  const end = Date.now() + waitMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/surum`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) { const j = await r.json(); if ((j.baslama || 0) >= since) return true; }
    } catch {}
    await new Promise(r => setTimeout(r, 3000));
  }
  return false;
}

function rollback(p) {
  for (const rel of p.changed) {
    const b = path.join(BAK, rel), dst = path.join(APP, rel);
    try {
      if (p.created.includes(rel)) fs.rmSync(dst, { force: true });
      else if (fs.existsSync(b)) { fs.copyFileSync(b, dst + '.yeni'); fs.renameSync(dst + '.yeni', dst); }
    } catch (e) { log(`Geri alınamadı: ${rel} (${e.message})`); }
  }
  if (p.changed.some(f => /^package(-lock)?\.json$/.test(f))) st.needNpm = true; // eski paketleri geri kur
}

function ps(cmd) { return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true }); }
function restartCaddy() {
  if (process.platform !== 'win32') return log('(test) https sunucusu yeniden başlatılacaktı');
  // calistir-https.cmd döngüsü Caddy'yi 5 saniye içinde yeni ayarla açar
  ps("Get-Process caddy -ErrorAction SilentlyContinue | Stop-Process -Force");
  log('Https sunucusu yeni ayarla yeniden başlatıldı');
}
// Önce sunucudan düzgün kapanmasını iste: kayıtları diske yazar, kullanıcılara "güncelleniyor" der,
// botlara "birkaç saniye sonra yeniden bağlan" der ve oturumlarını saklar (botlar kaldığı yerden devam eder).
// Cevap vermezse eskisi gibi zorla kapatılır.
async function askGraceful() {
  try {
    const key = fs.readFileSync(path.join(APP, 'veri', 'kapat.anahtar'), 'utf8').trim(); if (!key) return false;
    const r = await fetch(`http://127.0.0.1:${PORT}/api/_kapat`, { method: 'POST', headers: { 'x-kapat-anahtar': key }, signal: AbortSignal.timeout(4000) });
    if (!r.ok) return false;
    await new Promise(res => setTimeout(res, 2500)); // sunucu kendi kendine kapanır (~0,7 sn)
    return true;
  } catch { return false; }
}
async function restartServer() {
  if (process.platform !== 'win32') { log('(test) sunucu yeniden başlatılacaktı'); return false; }
  if (await askGraceful()) log('Sunucu düzgün kapandı');
  // calistir-uygulama.cmd döngüsü sunucuyu 3 saniye içinde yeniden açar
  ps("Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }");
  log('Sunucu yeniden başlatıldı');
  return true;
}

// En son commit: GitHub API saatte 60 istekle sınırlı (dakikada bir sorunca 403 veriyordu).
// Bu yüzden git'in kendi adresinden okuyoruz; bu sınırlı değil. Olmazsa API'ye düşer.
async function latestSha() {
  try {
    const r = await fetch(`https://github.com/${REPO}.git/info/refs?service=git-upload-pack`, { headers: { 'User-Agent': 'git/2.40 kanka-guncelleyici' }, signal: AbortSignal.timeout(20000) });
    if (r.ok) { const m = (await r.text()).match(new RegExp(`([0-9a-f]{40}) refs/heads/${BRANCH}\\b`)); if (m) return { sha: m[1] }; }
    if (!st.refsWarn) { st.refsWarn = 1; log('git adresi okunamadı: ' + r.status); }
  } catch (e) { if (!st.refsWarn) { st.refsWarn = 1; log('git adresi okunamadı: ' + e.message); } }
  if (Date.now() - (st.apiAt || 0) < 15 * 60e3) return null; // API yedek: en fazla 15 dakikada bir
  st.apiAt = Date.now();
  const h = { ...H }; if (st.etag) h['If-None-Match'] = st.etag;
  const r = await fetch(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`, { headers: h, signal: AbortSignal.timeout(20000) });
  if (r.status === 304) return null;
  if (!r.ok) { if (r.status !== 404 && r.status !== 409) log(`GitHub cevabı: ${r.status}`); return null; }
  const j = await r.json(); st.etag = r.headers.get('etag');
  return { sha: j.sha, msg: (j.commit?.message || '').split('\n')[0] };
}

// Bu sürüm kurulursa sunucu yeniden başlamalı mı? (dosyalara dokunmadan bakar)
function needsRestart(root) {
  for (const [a, b] of [['server.js', 'server.js'], ['package.json', 'package.json']]) if (hash(path.join(root, a)) !== hash(path.join(APP, b))) return true;
  const h = hash(path.join(root, 'package-lock.json')); return !!(h && st.lockSrc && h !== st.lockSrc);
}
// Yeniden başlatma gerektiren güncellemeler toplu ve sakin bir anda kurulur:
//  - üst üste gelen commit'ler bitsin diye son commit'ten sonra QUIET kadar beklenir (hepsi tek seferde kurulur)
//  - seste biri varsa en fazla MAX_WAIT kadar sakin bir an beklenir. Sesli bağlantılar kişiden kişiye olduğu ve uygulama
//    yeniden bağlanınca mevcut bağlantıyı koruduğu için yeniden başlatma konuşmayı kesmez; bu yüzden bekleme kısa.
// Sadece sayfa dosyaları değiştiyse sunucu hiç yeniden başlamaz, hemen kurulur.
const QUIET = 90e3, MAX_WAIT = 4 * 60e3;
async function liveStatus() {
  try {
    const key = fs.readFileSync(path.join(APP, 'veri', 'kapat.anahtar'), 'utf8').trim();
    const r = await fetch(`http://127.0.0.1:${PORT}/api/_durum`, { headers: { 'x-kapat-anahtar': key }, signal: AbortSignal.timeout(4000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
async function checkCode() {
  const j = await latestSha(); if (!j) return;
  if (j.sha === st.sha || j.sha === st.badSha) return; // hatalı sürüm bir sonraki commit'e kadar tekrar denenmez
  if (st.waitSha !== j.sha) log(`Yeni sürüm bulundu ${j.sha.slice(0, 7)}${j.msg ? ': ' + j.msg : ''}`);
  const zr = await fetch(`https://codeload.github.com/${REPO}/zip/${j.sha}`, { headers: H, signal: AbortSignal.timeout(120000) });
  if (!zr.ok) throw new Error('Arşiv indirilemedi: ' + zr.status);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanka-'));
  try {
    const zip = path.join(tmp, 'k.zip');
    fs.writeFileSync(zip, Buffer.from(await zr.arrayBuffer()));
    if (process.platform === 'win32') ps(`Expand-Archive -LiteralPath '${zip}' -DestinationPath '${path.join(tmp, 'x')}' -Force`);
    else execFileSync('unzip', ['-q', zip, '-d', path.join(tmp, 'x')]);
    const root = path.join(tmp, 'x', fs.readdirSync(path.join(tmp, 'x'))[0]);
    const errs = validate(root);
    if (errs.length) { st.badSha = j.sha; save(); log(`KURULMADI ${j.sha.slice(0, 7)}: kod hatalı, canlı sürüm aynen çalışmaya devam ediyor. ${errs.join(' ; ')}`); return; }
    const restartNeeded = needsRestart(root);
    if (restartNeeded) {
      if (st.waitSha !== j.sha) { if (!st.waitSha) st.waitFirst = Date.now(); st.waitSha = j.sha; st.waitSeen = Date.now(); save(); log(`${j.sha.slice(0, 7)} sunucuyu yeniden başlatacak; sakin bir an bekleniyor`); }
      const now = Date.now(), lv = await liveStatus();
      const quiet = now - st.waitSeen >= QUIET, calm = !lv || !lv.ses, late = now - (st.waitFirst || now) >= MAX_WAIT;
      if (!(quiet && (calm || late))) return;
      log(`Kuruluyor (${late && !calm ? 'en uzun bekleme doldu' : 'sakin an'}${lv ? `, seste ${lv.ses}, bağlı ${lv.bagli}` : ''})`);
    }
    st.waitSha = null; st.waitFirst = null;
    if (restartNeeded) { st.needRestart = true; save(); } // kurulum yarıda kalsa bile sunucu yeni koda geçsin
    const changed = [], created = [];
    fs.rmSync(BAK, { recursive: true, force: true }); fs.mkdirSync(BAK, { recursive: true });
    for (const [a, b] of SYNC) syncPath(path.join(root, a), path.join(APP, b), changed, created);
    if (changed.length) log('Güncellenen dosyalar: ' + changed.join(', '));
    if (changed.some(f => /^package(-lock)?\.json$/.test(f))) st.needNpm = true;
    if (restartNeeded || changed.some(f => f === 'server.js' || /^package/.test(f))) { st.needRestart = true; st.pending = { sha: j.sha, prevSha: st.sha, changed, created }; }
    if (changed.includes('Caddyfile')) st.needCaddy = true;
    st.sha = j.sha; save();
    await finishPending();
    if (changed.includes('guncelleyici.js')) { log('Güncelleyici kendini güncelledi, yeniden başlıyor'); process.exit(0); }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// Yarıda kalan işler (paket kurulumu, yeniden başlatma) bir sonraki turda tekrar denenir
async function finishPending() {
  if (st.needNpm) {
    log('Paketler kuruluyor...');
    try { npmInstall(); st.needNpm = false; st.npmFail = 0; save(); log('Paketler kuruldu'); }
    catch (e) { st.npmFail = (st.npmFail || 0) + 1; save(); log(`Paket kurulumu olmadı (${st.npmFail}. deneme): ${e.message} — ayrıntı: kayitlar\\npm-guncelleme.log`); }
  }
  // paket kurulamasa bile sunucu yeni koda geçsin; kurulum sonraki turlarda yeniden denenir
  if (st.needRestart) {
    const since = Date.now(); const did = await restartServer(); st.needRestart = false; save();
    const p = st.pending;
    if (did && p) {
      if (await healthy(since)) log(`Yeni sürüm ${p.sha.slice(0, 7)} sağlıklı çalışıyor`);
      else {
        log(`Yeni sürüm ${p.sha.slice(0, 7)} 90 saniyede açılmadı, önceki sürüme dönülüyor`);
        rollback(p); st.badSha = p.sha; st.sha = p.prevSha; save();
        if (st.needNpm) { try { npmInstall(); st.needNpm = false; save(); } catch (e) { log('Eski paketler kurulamadı: ' + e.message); } }
        const since2 = Date.now(); await restartServer();
        log(await healthy(since2) ? 'Önceki sürüm geri geldi ve çalışıyor' : 'DİKKAT: önceki sürüm de açılmadı, elle bakılmalı');
      }
    }
    st.pending = null; save();
  }
  if (st.needCaddy) { restartCaddy(); st.needCaddy = false; save(); }
}

// Görev SYSTEM hesabıyla çalışıyor: npm'yi node'un yanından çağır, SYSTEM'in eksik npm klasörünü oluştur, çıktıyı dosyaya yaz
function npmInstall() {
  const out = fs.openSync(path.join(APP, 'kayitlar', 'npm-guncelleme.log'), 'w');
  try {
    if (process.platform === 'win32') {
      if (process.env.APPDATA) fs.mkdirSync(path.join(process.env.APPDATA, 'npm'), { recursive: true });
      const npm = path.join(path.dirname(process.execPath), 'npm.cmd');
      // /s ile cmd komutun ilk ve son tırnağını atar: bütün komut ayrıca tırnağa alınmazsa "C:\Program Files" boşlukta bölünür ve kurulum hiç çalışmaz
      execFileSync('cmd.exe', ['/d', '/s', '/c', `""${fs.existsSync(npm) ? npm : 'npm'}" install --omit=dev --no-audit --no-fund --no-save"`], { cwd: APP, stdio: ['ignore', out, out], windowsHide: true, windowsVerbatimArguments: true, timeout: 10 * 60e3 });
    } else execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-save'], { cwd: APP, stdio: ['ignore', out, out], timeout: 10 * 60e3 });
  } finally { fs.closeSync(out); }
}

async function checkDesktop() {
  // Masaüstü uygulaması sürümleri GitHub Releases'ta: RELEASES, *.nupkg, KankaChat-Kurulum.exe
  const h = { ...H }; if (st.relEtag) h['If-None-Match'] = st.relEtag;
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: h, signal: AbortSignal.timeout(20000) });
  if (r.status === 304 || r.status === 404 || !r.ok) return;
  const rel = await r.json(); st.relEtag = r.headers.get('etag');
  const dir = path.join(APP, 'indir'); fs.mkdirSync(dir, { recursive: true });
  const assets = rel.assets || [];
  const order = [...assets.filter(a => a.name !== 'RELEASES'), ...assets.filter(a => a.name === 'RELEASES')]; // RELEASES en son
  for (const a of order) {
    if (!/^(RELEASES|.+\.nupkg|KankaChat-Kurulum\.exe)$/.test(a.name)) continue;
    const dst = path.join(dir, a.name);
    if (fs.existsSync(dst) && fs.statSync(dst).size === a.size && a.name !== 'RELEASES') continue;
    log(`Masaüstü sürümü indiriliyor: ${a.name} (${Math.round(a.size / 1048576)} MB)`);
    const d = await fetch(a.browser_download_url, { headers: { 'User-Agent': H['User-Agent'] }, redirect: 'follow', signal: AbortSignal.timeout(30 * 60e3) });
    if (!d.ok) { log('İndirilemedi: ' + a.name); continue; }
    const tmp = dst + '.indiriliyor';
    fs.writeFileSync(tmp, Buffer.from(await d.arrayBuffer())); fs.renameSync(tmp, dst);
  }
  save();
}

// Android uygulaması: "android-v..." etiketli en yeni sürümdeki KankaChat.apk → indir/KankaChat.apk (kankahq.com/indir/KankaChat.apk)
async function checkAndroid() {
  const h = { ...H }; if (st.apkEtag) h['If-None-Match'] = st.apkEtag;
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=15`, { headers: h, signal: AbortSignal.timeout(20000) });
  if (r.status === 304 || !r.ok) return;
  st.apkEtag = r.headers.get('etag');
  const rel = (await r.json()).find(x => /^android-v/.test(x.tag_name) && !x.draft);
  const a = rel?.assets?.find(x => x.name === 'KankaChat.apk'); if (!a) return save();
  if (st.apkTag === rel.tag_name) return save();
  const dir = path.join(APP, 'indir'); fs.mkdirSync(dir, { recursive: true });
  log(`Android sürümü indiriliyor: ${rel.tag_name} (${Math.round(a.size / 1048576)} MB)`);
  const d = await fetch(a.browser_download_url, { headers: { 'User-Agent': H['User-Agent'] }, redirect: 'follow', signal: AbortSignal.timeout(30 * 60e3) });
  if (!d.ok) return log('APK indirilemedi: ' + d.status);
  const buf = Buffer.from(await d.arrayBuffer()); if (buf.length !== a.size) return log('APK eksik indi');
  const dst = path.join(dir, 'KankaChat.apk'); fs.writeFileSync(dst + '.indiriliyor', buf); fs.renameSync(dst + '.indiriliyor', dst);
  fs.writeFileSync(path.join(dir, 'android.json'), JSON.stringify({ surum: rel.tag_name, boyut: a.size, tarih: new Date().toISOString() }));
  st.apkTag = rel.tag_name; save(); log(`Android ${rel.tag_name} hazır: /indir/KankaChat.apk`);
}

// Yedek yol: GitHub Releases kullanılamazsa 'masaustu' dalındaki parçalı dosyalar (manifest.json)
async function checkDesktopBranch() {
  const raw = p => `https://raw.githubusercontent.com/${REPO}/masaustu/${p}`;
  const r = await fetch(raw('manifest.json') + '?t=' + Date.now(), { headers: { 'User-Agent': H['User-Agent'] }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) return;
  const man = await r.json();
  if (!man.version || man.version === st.deskVer) return;
  const dir = path.join(APP, 'indir'); fs.mkdirSync(dir, { recursive: true });
  const names = [...Object.keys(man.files).filter(n => n !== 'RELEASES'), ...Object.keys(man.files).filter(n => n === 'RELEASES')];
  for (const name of names) {
    const f = man.files[name], dst = path.join(dir, name);
    if (hash(dst) === f.sha1) continue;
    log(`Masaüstü ${man.version} indiriliyor: ${name} (${Math.round(f.size / 1048576)} MB)`);
    const bufs = [];
    for (const part of f.parts) {
      const d = await fetch(raw(part), { headers: { 'User-Agent': H['User-Agent'] }, signal: AbortSignal.timeout(30 * 60e3) });
      if (!d.ok) throw new Error('Parça indirilemedi: ' + part);
      bufs.push(Buffer.from(await d.arrayBuffer()));
    }
    const buf = Buffer.concat(bufs);
    if (crypto.createHash('sha1').update(buf).digest('hex') !== f.sha1) throw new Error('Bozuk indirme: ' + name);
    fs.writeFileSync(dst + '.indiriliyor', buf); fs.renameSync(dst + '.indiriliyor', dst);
  }
  st.deskVer = man.version; save();
  log(`Masaüstü sürümü hazır: ${man.version}`);
}

// Diskteki server.js çalışan sunucudan yeniyse (ör. önceki kurulum yarıda kaldı) sakin bir anda yeniden başlat
async function healStale() {
  if (st.needRestart || st.waitSha || process.platform !== 'win32') return;
  let j; try { const r = await fetch(`http://127.0.0.1:${PORT}/api/surum`, { signal: AbortSignal.timeout(5000) }); if (!r.ok) return; j = await r.json(); } catch { return; }
  const mt = fs.statSync(path.join(APP, 'server.js')).mtimeMs; if (!j.baslama || mt <= j.baslama + 2000) { st.staleAt = null; return; }
  if (!st.staleAt) { st.staleAt = Date.now(); save(); log('Çalışan sunucu diskteki koddan eski; sakin bir anda yeniden başlatılacak'); }
  const lv = await liveStatus();
  if ((lv && lv.ses) && Date.now() - st.staleAt < MAX_WAIT) return;
  st.staleAt = null; st.needRestart = true; st.pending = null; save();
}
let busy = false, n = 0;
async function tick() {
  if (busy) return; busy = true;
  try { await healStale(); } catch (e) { log('Hata (eski sunucu): ' + e.message); }
  try { await finishPending(); } catch (e) { log('Hata (bekleyen iş): ' + e.message); }
  try { await checkCode(); } catch (e) { log('Hata (kod): ' + e.message); }
  if (n++ % 30 === 0) { try { await checkDesktop(); } catch (e) { log('Hata (masaüstü): ' + e.message); } // GitHub API sınırı için 30 dakikada bir
    try { await checkDesktopBranch(); } catch (e) { log('Hata (masaüstü dalı): ' + e.message); } }
  if (n % 5 === 1) { try { await checkAndroid(); } catch (e) { log('Hata (Android): ' + e.message); } } // 5 dakikada bir
  busy = false;
}
log('Güncelleyici çalışıyor');
tick();
setInterval(tick, 60e3);
