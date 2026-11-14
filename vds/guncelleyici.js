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

function syncPath(src, dst, changed) {
  if (!fs.existsSync(src)) return;
  if (fs.statSync(src).isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const n of fs.readdirSync(src)) syncPath(path.join(src, n), path.join(dst, n), changed);
    return;
  }
  if (hash(src) === hash(dst)) return;
  const tmp = dst + '.yeni';
  fs.copyFileSync(src, tmp); fs.renameSync(tmp, dst);
  changed.push(path.relative(APP, dst));
}

function ps(cmd) { return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true }); }
function restartCaddy() {
  if (process.platform !== 'win32') return log('(test) https sunucusu yeniden başlatılacaktı');
  // calistir-https.cmd döngüsü Caddy'yi 5 saniye içinde yeni ayarla açar
  ps("Get-Process caddy -ErrorAction SilentlyContinue | Stop-Process -Force");
  log('Https sunucusu yeni ayarla yeniden başlatıldı');
}
function restartServer() {
  if (process.platform !== 'win32') return log('(test) sunucu yeniden başlatılacaktı');
  // calistir-uygulama.cmd döngüsü sunucuyu 3 saniye içinde yeniden açar
  ps("Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }");
  log('Sunucu yeniden başlatıldı');
}

async function checkCode() {
  const h = { ...H }; if (st.etag) h['If-None-Match'] = st.etag;
  const r = await fetch(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`, { headers: h, signal: AbortSignal.timeout(20000) });
  if (r.status === 304) return;
  if (!r.ok) { if (r.status !== 404 && r.status !== 409) log(`GitHub cevabı: ${r.status}`); return; }
  const j = await r.json();
  st.etag = r.headers.get('etag');
  if (j.sha === st.sha) return save();
  log(`Yeni sürüm bulundu ${j.sha.slice(0, 7)}: ${(j.commit?.message || '').split('\n')[0]}`);
  const zr = await fetch(`https://codeload.github.com/${REPO}/zip/${j.sha}`, { headers: H, signal: AbortSignal.timeout(120000) });
  if (!zr.ok) throw new Error('Arşiv indirilemedi: ' + zr.status);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanka-'));
  try {
    const zip = path.join(tmp, 'k.zip');
    fs.writeFileSync(zip, Buffer.from(await zr.arrayBuffer()));
    if (process.platform === 'win32') ps(`Expand-Archive -LiteralPath '${zip}' -DestinationPath '${path.join(tmp, 'x')}' -Force`);
    else execFileSync('unzip', ['-q', zip, '-d', path.join(tmp, 'x')]);
    const root = path.join(tmp, 'x', fs.readdirSync(path.join(tmp, 'x'))[0]);
    const changed = [];
    for (const [a, b] of SYNC) syncPath(path.join(root, a), path.join(APP, b), changed);
    if (changed.length) log('Güncellenen dosyalar: ' + changed.join(', '));
    if (changed.some(f => /^package(-lock)?\.json$/.test(f))) st.needNpm = true;
    if (changed.some(f => f === 'server.js' || /^package/.test(f))) st.needRestart = true;
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
  if (st.needRestart) { restartServer(); st.needRestart = false; save(); }
  if (st.needCaddy) { restartCaddy(); st.needCaddy = false; save(); }
}

// Görev SYSTEM hesabıyla çalışıyor: npm'yi node'un yanından çağır, SYSTEM'in eksik npm klasörünü oluştur, çıktıyı dosyaya yaz
function npmInstall() {
  const out = fs.openSync(path.join(APP, 'kayitlar', 'npm-guncelleme.log'), 'w');
  try {
    if (process.platform === 'win32') {
      if (process.env.APPDATA) fs.mkdirSync(path.join(process.env.APPDATA, 'npm'), { recursive: true });
      const npm = path.join(path.dirname(process.execPath), 'npm.cmd');
      execFileSync('cmd.exe', ['/d', '/s', '/c', `"${fs.existsSync(npm) ? npm : 'npm'}" install --omit=dev --no-audit --no-fund`], { cwd: APP, stdio: ['ignore', out, out], windowsHide: true, windowsVerbatimArguments: true, timeout: 10 * 60e3 });
    } else execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: APP, stdio: ['ignore', out, out], timeout: 10 * 60e3 });
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

let busy = false, n = 0;
async function tick() {
  if (busy) return; busy = true;
  try { await finishPending(); } catch (e) { log('Hata (bekleyen iş): ' + e.message); }
  try { await checkCode(); } catch (e) { log('Hata (kod): ' + e.message); }
  if (n++ % 5 === 0) { try { await checkDesktop(); } catch (e) { log('Hata (masaüstü): ' + e.message); } // GitHub sınırı için 5 dakikada bir
    try { await checkDesktopBranch(); } catch (e) { log('Hata (masaüstü dalı): ' + e.message); } }
  busy = false;
}
log('Güncelleyici çalışıyor');
tick();
setInterval(tick, 60e3);
