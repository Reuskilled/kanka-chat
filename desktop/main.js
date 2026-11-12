// Kanka Chat masaüstü uygulaması
// Sohbeti kendi penceresinde açar, sistem tepsisinde yaşar, oyun ve Spotify'ı arka planda algılar.
// Kurulum/kaldırma sırasında Squirrel kısayolları oluşturur ve hemen çıkar
if (require('electron-squirrel-startup')) process.exit(0);
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, dialog, Notification, autoUpdater, screen, globalShortcut, powerMonitor } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
// Ana süreçte beklenmeyen bir hata olursa kullanıcıya çirkin hata kutusu gösterme, sadece kaydet
process.on('uncaughtException', e => { try { console.error('[kanka] hata:', e?.stack || e); } catch {} });

const DEFAULT_SERVER = 'https://185-208-172-60.sslip.io';
const CONFIG = () => path.join(app.getPath('userData'), 'ayarlar.json');
let config = { server: DEFAULT_SERVER, presenceKey: null, startHidden: false };
try { Object.assign(config, JSON.parse(fs.readFileSync(CONFIG(), 'utf8'))); } catch {}
// Eski sürümler yerel sunucuya bağlıydı: kullanıcı adresi kendisi seçmediyse yeni sunucuya geç
if (!config.serverChosen && config.server !== DEFAULT_SERVER) { config.server = DEFAULT_SERVER; config.presenceKey = null; }
const saveConfig = () => { try { fs.writeFileSync(CONFIG(), JSON.stringify(config, null, 2)); } catch {} };

let win = null, tray = null, quitting = false, splash = null, splashShown = 0;
const ICON = path.join(__dirname, 'icon.png');

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showWindow());
app.setAppUserModelId('com.kanka.chat');

function showWindow() {
  // Kapanış yarıda kaldıysa ya da pencere yok olduysa: takılı kalma, temiz başla
  if (quitting) { app.relaunch(); app.exit(0); return; }
  if (!win || win.isDestroyed()) { win = null; return createWindow(); }
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}

function createSplash() {
  splash = new BrowserWindow({ width: 300, height: 340, frame: false, resizable: false, transparent: true, alwaysOnTop: true, skipTaskbar: false,
    center: true, show: false, title: 'Kanka Chat', icon: ICON, webPreferences: { contextIsolation: true } });
  splash.loadFile(path.join(__dirname, 'splash.html'));
  splash.once('ready-to-show', () => { splash.show(); splashShown = Date.now(); });
}
const setSplash = (t, sub = '', pct = null) => splash && !splash.isDestroyed() && splash.webContents.executeJavaScript(`setStatus(${JSON.stringify(t)}, ${JSON.stringify(sub)}, ${pct})`).catch(() => {});
function finishSplash() {
  if (!splash || splash.isDestroyed()) return;
  setSplash('Hazır!');
  const wait = Math.max(0, 1400 - (Date.now() - splashShown)); // çok hızlı açılsa bile animasyon görünsün
  setTimeout(() => {
    if (win && !win.isDestroyed() && !(config.startHidden && (process.argv.includes('--hidden') || process.argv.includes('--autostart')))) { win.show(); win.focus(); }
    splash?.destroy(); splash = null;
  }, wait);
}

// ---------------- Otomatik güncelleme (Squirrel) ----------------
function checkUpdates() {
  return new Promise(resolve => {
    if (!app.isPackaged || process.platform !== 'win32') return resolve();
    let done = false; const end = () => { if (!done) { done = true; resolve(); } };
    try {
      autoUpdater.setFeedURL({ url: config.server.replace(/\/$/, '') + '/indir' });
      autoUpdater.once('update-not-available', end);
      autoUpdater.once('error', end);
      autoUpdater.once('update-available', () => setSplash('Güncelleme indiriliyor…', 'Yeni özellikler geliyor'));
      autoUpdater.once('update-downloaded', () => { setSplash('Güncelleme kuruluyor…', 'Kanka Chat yeniden başlayacak'); setTimeout(() => { quitting = true; autoUpdater.quitAndInstall(); }, 900); });
      autoUpdater.checkForUpdates();
      setTimeout(end, 8000); // sunucu yavaşsa açılışı bekletme; indirme arka planda sürer
    } catch { end(); }
  });
}
setInterval(() => { try { if (app.isPackaged && process.platform === 'win32') autoUpdater.checkForUpdates(); } catch {} }, 10 * 60e3);
let updateReady = false;
autoUpdater.on?.('update-downloaded', (e, notes, version) => {
  if (splash) return;
  updateReady = true;
  if (win && !win.isDestroyed()) win.webContents.send('kanka:update-ready', version || '');
  if (!win?.isVisible() && Notification.isSupported()) {
    const n = new Notification({ title: 'Kanka Chat güncellemesi hazır', body: 'Yeniden başlatmak için tıkla.', icon: ICON });
    n.on('click', () => { quitting = true; autoUpdater.quitAndInstall(); }); n.show();
  }
});
ipcMain.handle('kanka:install-update', () => { if (!updateReady) return { ok: false }; quitting = true; setTimeout(() => autoUpdater.quitAndInstall(), 200); return { ok: true }; });
ipcMain.handle('kanka:update-pending', () => updateReady);

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 420, minHeight: 560,
    backgroundColor: '#17110e', title: 'Kanka Chat', icon: ICON, show: false, autoHideMenuBar: true,
    // Windows'un açık renkli başlık çubuğu yerine temaya uyan koyu çubuk (butonlar Windows'un kendi butonları)
    titleBarStyle: 'hidden', titleBarOverlay: { color: config.tbColor || '#17110e', symbolColor: config.tbSymbol || '#b49c89', height: 34 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  win.removeMenu();
  win.loadURL(config.server).catch(() => showOffline());
  win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => { if (isMain && code !== -3) showOffline(); });
  win.webContents.once('did-finish-load', finishSplash);
  win.webContents.once('did-fail-load', () => setTimeout(finishSplash, 500));
  // Dış linkleri tarayıcıda aç
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(config.server)) { e.preventDefault(); shell.openExternal(url); } });
  // Mikrofon, kamera, ekran paylaşımı ve bildirim izinleri
  win.webContents.session.setPermissionRequestHandler((wc, perm, cb) => cb(['media', 'notifications', 'clipboard-sanitized-write', 'fullscreen', 'display-capture'].includes(perm)));
  win.webContents.session.setDisplayMediaRequestHandler((req, cb) => {
    const { desktopCapturer } = require('electron');
    const chosen = pendingPick; pendingPick = null;
    desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } }).then(sources => {
      const s = chosen && sources.find(x => x.id === chosen.id);
      if (s) return cb(chosen.audio && process.platform === 'win32' ? { video: s, audio: 'loopback' } : { video: s });
      pickSource(sources, cb);
    }).catch(() => cb({}));
  }, { useSystemPicker: true });
  // Kapatınca tepsiye küçült
  win.on('closed', () => { win = null; });
  win.on('close', e => {
    if (quitting) return;
    e.preventDefault(); win.hide();
    if (!config.trayHintShown && Notification.isSupported()) {
      new Notification({ title: 'Kanka Chat arka planda', body: 'Saatin yanındaki simgeden tekrar açabilirsin. Kapatmak için simgeye sağ tıkla › Çıkış.', icon: ICON }).show();
      config.trayHintShown = true; saveConfig();
    }
  });
}

// Uygulama içi yayın seçicisi: pencere ve ekranları küçük resimleriyle listeler
let pendingPick = null;
ipcMain.handle('kanka:sources', async () => {
  const { desktopCapturer } = require('electron');
  const list = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 384, height: 216 }, fetchWindowIcons: true });
  return list.filter(x => x.name && !/^Kanka Chat$/.test(x.name)).map(x => ({ id: x.id, name: x.name, screen: x.id.startsWith('screen:'), thumb: x.thumbnail.toDataURL(), icon: x.appIcon && !x.appIcon.isEmpty() ? x.appIcon.resize({ width: 32 }).toDataURL() : null }));
});
ipcMain.handle('kanka:pick', (e, p) => { pendingPick = p && typeof p.id === 'string' ? { id: p.id, audio: !!p.audio } : null; return true; });

function pickSource(sources, cb) {
  // Sistem seçicisi yoksa: basit bir seçim penceresi
  const names = sources.map(s => s.name.slice(0, 60));
  dialog.showMessageBox(win, { type: 'question', title: 'Ekran paylaş', message: 'Neyi paylaşmak istiyorsun?', buttons: [...names.slice(0, 8), 'Vazgeç'], cancelId: Math.min(names.length, 8) })
    .then(r => { const s = sources[r.response]; s ? cb({ video: s }) : cb({}); });
}

function showOffline() {
  const html = `<html><body style="margin:0;height:100vh;-webkit-app-region:drag;display:flex;align-items:center;justify-content:center;background:#17110e;color:#f4e6d8;font-family:Segoe UI,sans-serif;text-align:center">
    <div><div style="font-size:22px;font-weight:800;margin-bottom:8px">Kanka Chat'e bağlanılamadı</div>
    <div style="color:#b49c89;margin-bottom:18px">Sunucu: ${config.server}<br>İnternetini kontrol et ya da sunucu adresini değiştir.</div>
    <a href="#" onclick="location.reload()" style="color:#ff8a4c;font-weight:800;-webkit-app-region:no-drag">Tekrar dene</a></div></body></html>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  setTimeout(() => win && !win.isDestroyed() && win.loadURL(config.server).catch(() => {}), 15000);
}

function buildTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('Kanka Chat');
  const menu = () => Menu.buildFromTemplate([
    { label: 'Kanka Chat\'i aç', click: showWindow },
    { type: 'separator' },
    { label: lastStatus, enabled: false },
    { label: 'Bilgisayar açılınca başlat', type: 'checkbox', checked: autostartOn(),
      click: i => { setAutostart(i.checked); } },
    { label: 'Sunucu adresini değiştir…', click: changeServer },
    { type: 'separator' },
    { label: 'Çıkış', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu());
  tray.on('click', showWindow);
  setInterval(() => tray.setContextMenu(menu()), 15000);
}

async function changeServer() {
  showWindow();
  const cur = config.server;
  const v = await win.webContents.executeJavaScript(`prompt('Kanka Chat sunucu adresi:', ${JSON.stringify(cur)})`).catch(() => null);
  if (v && /^https?:\/\/\S+$/.test(v.trim())) { config.server = v.trim().replace(/\/$/, ''); config.serverChosen = true; config.presenceKey = null; saveConfig(); win.loadURL(config.server).catch(() => showOffline()); }
}

// ---------------- Oyun ve Spotify algılama ----------------
const RICH = require('./rich');
// PowerShell betikleri: Türkçe karakterler bozulmasın diye UTF-8, komut satırına UTF-16 base64 olarak verilir
const enc = src => Buffer.from(src, 'utf16le').toString('base64');
const PS_MEDIA = enc(`[Console]::OutputEncoding=[Text.Encoding]::UTF8
Get-Process Spotify,javaw -ErrorAction SilentlyContinue | Where-Object MainWindowTitle | ForEach-Object { 'T' + (@{ p = $_.ProcessName; t = $_.MainWindowTitle } | ConvertTo-Json -Compress) }
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $at = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
  function W($op, $t) { $task = $at.MakeGenericMethod($t).Invoke($null, @($op)); $null = $task.Wait(3000); $task.Result }
  $M = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $P = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
  $mgr = W ($M::RequestAsync()) $M
  foreach ($x in $mgr.GetSessions()) {
    if ([string]$x.GetPlaybackInfo().PlaybackStatus -ne 'Playing') { continue }
    $p = W ($x.TryGetMediaPropertiesAsync()) $P
    $tl = $x.GetTimelineProperties()
    $age = 0; try { $age = [int]([DateTimeOffset]::Now - $tl.LastUpdatedTime).TotalMilliseconds } catch {}
    'M' + (@{ app = $x.SourceAppUserModelId; artist = $p.Artist; title = $p.Title; album = $p.AlbumTitle; pos = [int]$tl.Position.TotalMilliseconds; end = [int]$tl.EndTime.TotalMilliseconds; age = $age } | ConvertTo-Json -Compress)
  }
} catch {}`);
const PS_LOL = enc(`(Get-CimInstance Win32_Process -Filter "Name='LeagueClientUx.exe'" -ErrorAction SilentlyContinue | Select-Object -First 1).CommandLine`);
const ps = b64 => run('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64]);
let games = {}, lastStatus = 'Etkinlik: bekleniyor', lolPid = null;
const run = (cmd, args) => new Promise(res => execFile(cmd, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (e, out) => res(e ? '' : String(out))));
const csvRow = l => (l.match(/"([^"]*)"/g) || []).map(x => x.slice(1, -1));

async function loadGames() {
  try { const r = await fetch(config.server + '/api/presence/games', { signal: AbortSignal.timeout(8000) }); if (r.ok) games = await r.json(); } catch {}
}
// CS2 için Game State Integration: Steam klasörünü bul, ayar dosyasını yaz, yerel dinleyiciyi aç
async function setupCS2() {
  if (process.platform !== 'win32') return;
  RICH.startGSI();
  const out = await run('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath']);
  const sp = out.match(/SteamPath\s+REG_SZ\s+(.+)/)?.[1]?.trim().replace(/\//g, '\\');
  RICH.installGSI([sp, 'C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam'].filter(Boolean));
}

async function detect() {
  if (process.platform !== 'win32') return { game: null, detail: '', music: null };
  const lines = (await run('tasklist', ['/fo', 'csv', '/nh'])).split(/\r?\n/);
  let best = 0, game = null, detail = '';
  for (const l of lines) {
    const name = (csvRow(l)[0] || '').replace(/\.exe$/i, '');
    const hit = games[name] || Object.entries(games).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
    if (!hit) continue;
    const score = ['Lobide', 'Açılıyor', 'Başlatıcıda'].includes(hit[1]) ? 1 : 2;
    if (score > best) { best = score; game = hit[0]; detail = hit[1] || ''; }
    if (best === 2) break;
  }
  const names = new Map(lines.map(l => { const r = csvRow(l); return [(r[0] || '').toLowerCase(), r[1]]; }));
  // Oyunların kendi yerel servislerinden ayrıntı: şampiyon, mod, derece, skor, KDA
  let rich = null;
  try {
    if (game === 'League of Legends' && names.has('leagueclientux.exe')) {
      const pid = names.get('leagueclientux.exe'); if (pid !== lolPid) { lolPid = pid; RICH.resetLol(); }
      rich = await RICH.lolRich(() => ps(PS_LOL));
    } else if (game === 'Valorant') rich = await RICH.valorantRich();
    else if (game === 'Counter-Strike 2') rich = RICH.cs2Rich();
  } catch { rich = null; }
  // Pencere başlıkları ve Windows medya oturumu (Spotify şarkısı, süresi, Minecraft sürümü)
  let titles = [], media = [];
  if (names.has('spotify.exe') || (!game && names.has('javaw.exe')) || game === 'Minecraft') {
    for (const l of (await ps(PS_MEDIA)).split(/\r?\n/).filter(Boolean)) {
      try { const j = JSON.parse(l.slice(1)); if (l[0] === 'M') media.push({ ...j, app: String(j.app || '').toLowerCase() }); else if (l[0] === 'T') titles.push([String(j.p).toLowerCase(), String(j.t || '').trim()]); } catch {}
    }
  }
  const mc = titles.find(([p, t]) => p === 'javaw' && t.startsWith('Minecraft'));
  if (mc && (!game || game === 'Minecraft')) {
    game = 'Minecraft'; const v = mc[1].match(/Minecraft\*?\s+([\d.]+)/)?.[1], t = mc[1];
    const where = /Multiplayer|Çok Oyunculu/i.test(t) ? 'Çok oyunculu' : /Singleplayer|Tek Oyunculu/i.test(t) ? 'Tek oyunculu' : /LAN/i.test(t) ? 'LAN' : '';
    detail = ['Java', v].filter(Boolean).join(' ');
    if (where) rich = { mode: where, state: v ? `Java ${v}` : 'Java' };
  }
  let music = null;
  // 1) Windows medya oturumu: Spotify küçültülmüş ya da tepsideyken de çalışır, süre ve konum da gelir
  const sm = media.find(m => m.app.includes('spotify') && m.title);
  if (sm) {
    music = { artist: sm.artist || '', title: sm.title, album: sm.album || '' };
    if (sm.end > 1000) { music.dur = sm.end; music.pos = Math.min(sm.end, Math.max(0, sm.pos + Math.max(0, sm.age || 0))); }
  }
  // 2) Yedek: pencere başlığı "Sanatçı - Şarkı"
  if (!music) {
    const sp = titles.find(([p, t]) => p === 'spotify' && !/^Spotify/i.test(t) && t.includes(' - '));
    if (sp) { const t = sp[1], i = t.indexOf(' - '); music = { artist: t.slice(0, i), title: t.slice(i + 3) }; }
  }
  return { game, detail, music, rich };
}

async function presenceLoop() {
  if (config.presenceKey) {
    const st = await detect();
    if (st.game !== currentGame) { currentGame = st.game; updateOverlay(); }
    try {
      const matches = config.matchCards === false ? [] : RICH.takeMatches(); // biten maçlar: sunucu maç sonu kartı yapar
      const r = await fetch(config.server + '/api/presence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: config.presenceKey, ...st, matches }), signal: AbortSignal.timeout(8000) });
      if (r.ok) for (const m of matches) RICH.doneMatch(m.key);
      lastStatus = st.game ? `Oynuyor: ${st.game}${st.rich?.state ? ' · ' + st.rich.state : ''}` : st.music ? `Dinliyor: ${st.music.title}` : 'Etkinlik: boşta';
    } catch { lastStatus = 'Etkinlik: sunucuya ulaşılamadı'; }
  }
  setTimeout(presenceLoop, 10000);
}

ipcMain.handle('kanka:presenceKey', (e, key) => {
  if (typeof key === 'string' && /^[a-f0-9]{20,80}$/.test(key) && key !== config.presenceKey) { config.presenceKey = key; saveConfig(); }
  return { ok: true };
});
ipcMain.handle('kanka:info', () => ({ version: app.getVersion(), platform: process.platform, connected: !!config.presenceKey, status: lastStatus }));
ipcMain.on('kanka:titlebar', (e, color, symbol) => {
  if (!/^#[0-9a-f]{6}$/i.test(color) || !/^#[0-9a-f]{6}$/i.test(symbol)) return;
  try { win?.setTitleBarOverlay({ color, symbolColor: symbol, height: 34 }); win?.setBackgroundColor(color); } catch {}
  if (config.tbColor !== color || config.tbSymbol !== symbol) { config.tbColor = color; config.tbSymbol = symbol; saveConfig(); }
});
// ---------------- Bilgisayar açılınca başlat ----------------
// Squirrel kurulumunda uygulama klasörü her güncellemede değişir; bu yüzden kalıcı Update.exe üzerinden başlatılır.
const UPDATE_EXE = path.resolve(path.dirname(process.execPath), '..', 'Update.exe');
const loginOpts = () => fs.existsSync(UPDATE_EXE)
  // Tırnak ekleme: Electron boşluklu argümanları kendisi tırnaklar. Elle eklenen tırnaklar kaçışlanıp
  // "\"Kanka Chat.exe\"" olur ve Squirrel uygulamayı bulamaz (1.0.9'a kadarki hata).
  ? { path: UPDATE_EXE, args: ['--processStart', path.basename(process.execPath), '--process-start-args', '--autostart'] }
  : { args: ['--autostart'] };
const autostartOn = () => { try { return app.getLoginItemSettings(loginOpts()).openAtLogin; } catch { return false; } };
function setAutostart(on) {
  if (!app.isPackaged) return;
  try { app.setLoginItemSettings({ ...loginOpts(), openAtLogin: !!on }); } catch {}
  try { app.setLoginItemSettings({ openAtLogin: false, args: ['--hidden'] }); } catch {} // eski sürümün (klasöre bağlı) kaydını temizle
  if (!!on) app.setLoginItemSettings({ ...loginOpts(), openAtLogin: true });
  config.autostart = !!on; saveConfig();
}
ipcMain.handle('kanka:autostart', (e, p) => {
  if (p && typeof p.on === 'boolean') setAutostart(p.on);
  if (p && typeof p.hidden === 'boolean') { config.startHidden = p.hidden; saveConfig(); }
  return { on: autostartOn(), hidden: !!config.startHidden };
});
// ---------------- Oyun içi katman: sesli odadakiler ve kim konuşuyor ----------------
// Her zaman üstte, şeffaf, tıklamaları oyuna geçiren küçük bir pencere. Kenarlıksız/pencereli tam ekran oyunlarda görünür.
config.overlay = { on: true, pos: 'tl', onlyGame: true, onlySpeaking: false, opacity: 1, size: 1, ...(config.overlay || {}) };
let overlay = null, ovState = null, ovHidden = false, ovPreview = 0, currentGame = null;
const OV_W = 300, OV_H = 560;
function placeOverlay() {
  if (!alive(overlay)) return;
  const b = screen.getPrimaryDisplay().bounds, sz = config.overlay.size || 1, w = Math.round(OV_W * sz), h = Math.round(OV_H * sz), m = 12, p = config.overlay.pos;
  overlay.setBounds({ x: b.x + (p[1] === 'r' ? b.width - w - m : m), y: b.y + (p[0] === 'b' ? b.height - h - m : m), width: w, height: h });
}
function ensureOverlay() {
  if (overlay && !overlay.isDestroyed()) return overlay;
  overlay = new BrowserWindow({ width: OV_W, height: OV_H, frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false, focusable: false,
    skipTaskbar: true, hasShadow: false, show: false, alwaysOnTop: true, backgroundColor: '#00000000', webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  overlay.setAlwaysOnTop(true, 'screen-saver'); overlay.setIgnoreMouseEvents(true); overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.loadFile(path.join(__dirname, 'overlay.html')).then(() => updateOverlay(true)).catch(() => {});
  overlay.on('closed', () => { overlay = null; });
  placeOverlay();
  return overlay;
}
const SAMPLE = { room: 'Sohbet', server: 'Önizleme', users: [{ n: 'Sen', c: '#ff8a4c', sp: true }, { n: 'Kanka', c: '#4aa8ff' }, { n: 'Ayşe', c: '#b07cff', m: true }] };
const alive = w => !!w && !w.isDestroyed();
function updateOverlay(force) {
  try { updateOverlay_(force); } catch (e) { console.warn('overlay', e?.message); }
}
function updateOverlay_(force) {
  if (quitting) return;
  const c = config.overlay, preview = Date.now() < ovPreview, st = preview ? (ovState || SAMPLE) : ovState;
  const want = !!st && (preview || (c.on && !ovHidden && st.users?.length && (!c.onlyGame || currentGame) && !(alive(win) && win.isFocused() && win.isVisible())));
  if (!want) { if (alive(overlay) && overlay.isVisible()) overlay.hide(); return; }
  const o = ensureOverlay();
  const cfg = { pos: c.pos, onlySpeaking: preview ? false : c.onlySpeaking, opacity: c.opacity, scale: c.size };
  o.webContents.executeJavaScript(`window.render && window.render(${JSON.stringify(st)}, ${JSON.stringify(cfg)})`).catch(() => {});
  if (!o.isVisible() || force) { o.showInactive(); o.setAlwaysOnTop(true, 'screen-saver'); }
}
ipcMain.on('kanka:overlay', (e, st) => {
  if (e.sender !== win?.webContents) return;
  if (st && typeof st === 'object' && Array.isArray(st.users)) {
    const s = v => String(v ?? '').slice(0, 60);
    ovState = { room: s(st.room), server: s(st.server), users: st.users.slice(0, 40).map(u => ({ n: s(u.n), c: /^#[0-9a-f]{3,8}$/i.test(u.c) ? u.c : null, av: /^https:\/\//.test(u.av || '') ? String(u.av).slice(0, 400) : null, sp: !!u.sp, m: !!u.m })) };
  } else ovState = null;
  updateOverlay();
});
ipcMain.handle('kanka:overlayConfig', (e, p) => {
  if (p && typeof p === 'object') {
    const o = config.overlay;
    if (typeof p.on === 'boolean') o.on = p.on;
    if (['tl', 'tr', 'bl', 'br'].includes(p.pos)) o.pos = p.pos;
    if (typeof p.onlyGame === 'boolean') o.onlyGame = p.onlyGame;
    if (typeof p.onlySpeaking === 'boolean') o.onlySpeaking = p.onlySpeaking;
    if (+p.opacity >= .3 && +p.opacity <= 1) o.opacity = +p.opacity;
    if (+p.size >= .8 && +p.size <= 1.3) o.size = +p.size;
    saveConfig(); placeOverlay();
    if (p.preview) { ovPreview = Date.now() + 6000; setTimeout(() => updateOverlay(), 6100); }
    updateOverlay(true);
  }
  return { ...config.overlay, game: currentGame, hotkey: 'Ctrl+Shift+O' };
});
ipcMain.handle('kanka:logout', () => { config.presenceKey = null; saveConfig(); return { ok: true }; });
// Gerçek boşta süresi: Windows'un kendi sayacı (oyunda klavye/fare kullanmak da sayılır), ekran kilitliyse hemen boşta
let screenLocked = false;
ipcMain.handle('kanka:idle', () => { try { return screenLocked ? -1 : powerMonitor.getSystemIdleTime(); } catch { return null; } });
app.whenReady().then(() => { try { powerMonitor.on('lock-screen', () => { screenLocked = true; }); powerMonitor.on('unlock-screen', () => { screenLocked = false; }); powerMonitor.on('suspend', () => { screenLocked = true; }); powerMonitor.on('resume', () => { screenLocked = false; }); } catch {} });
ipcMain.on('kanka:badge', (e, n) => { if (win && process.platform === 'win32') win.setOverlayIcon(n ? nativeImage.createFromPath(path.join(__dirname, 'dot.png')) : null, n ? `${n} okunmamış` : ''); win?.flashFrame(!!n && !win.isFocused()); });

app.whenReady().then(async () => {
  // İlk açılışta varsayılan olarak "bilgisayar açılınca başlat" açık
  if (config.autostart === undefined) setAutostart(true);
  else if (config.autostart) setAutostart(true); // her açılışta kaydı yeniden yaz: eski/bozuk kayıtlar kendiliğinden onarılır
  const hidden = config.startHidden && (process.argv.includes('--hidden') || process.argv.includes('--autostart'));
  if (!hidden) createSplash();
  await new Promise(r => setTimeout(r, 350));
  setSplash('Güncellemeler denetleniyor…');
  await checkUpdates();
  setSplash('Sunucuya bağlanılıyor…', config.server.replace(/^https?:\/\//, ''));
  createWindow(); buildTray();
  await loadGames(); setInterval(loadGames, 10 * 60e3);
  setupCS2().catch(() => {});
  presenceLoop();
  try { globalShortcut.register('Control+Shift+O', () => { ovHidden = !ovHidden; updateOverlay(true); }); } catch {}
  win?.on('focus', () => updateOverlay()); win?.on('blur', () => setTimeout(() => updateOverlay(), 150)); win?.on('hide', () => updateOverlay()); win?.on('show', () => updateOverlay());
  screen.on('display-metrics-changed', placeOverlay);
});
app.on('before-quit', () => {
  quitting = true; try { overlay?.destroy(); } catch {}
  // Kapanış bir yerde takılırsa süreç arkada asılı kalmasın (yoksa uygulama bir daha açılmıyor)
  setTimeout(() => app.exit(0), 6000).unref?.();
});
app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch {} });
app.on('window-all-closed', e => e.preventDefault());
