// Kanka Chat masaüstü uygulaması
// Sohbeti kendi penceresinde açar, sistem tepsisinde yaşar, oyun ve Spotify'ı arka planda algılar.
// Kurulum/kaldırma sırasında Squirrel kısayolları oluşturur ve hemen çıkar
if (require('electron-squirrel-startup')) process.exit(0);
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, dialog, Notification, autoUpdater } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

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
  if (!win) return createWindow();
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
    if (!(config.startHidden && process.argv.includes('--hidden'))) { win.show(); win.focus(); }
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
  win?.webContents.send('kanka:update-ready', version || '');
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
    { label: 'Bilgisayar açılınca başlat', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: i => app.setLoginItemSettings({ openAtLogin: i.checked, args: ['--hidden'] }) },
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
const PS_DETECT = 'WwBDAG8AbgBzAG8AbABlAF0AOgA6AE8AdQB0AHAAdQB0AEUAbgBjAG8AZABpAG4AZwA9AFsAVABlAHgAdAAuAEUAbgBjAG8AZABpAG4AZwBdADoAOgBVAFQARgA4AAoARwBlAHQALQBQAHIAbwBjAGUAcwBzACAAUwBwAG8AdABpAGYAeQAsAGoAYQB2AGEAdwAgAC0ARQByAHIAbwByAEEAYwB0AGkAbwBuACAAUwBpAGwAZQBuAHQAbAB5AEMAbwBuAHQAaQBuAHUAZQAgAHwAIABXAGgAZQByAGUALQBPAGIAagBlAGMAdAAgAE0AYQBpAG4AVwBpAG4AZABvAHcAVABpAHQAbABlACAAfAAgAEYAbwByAEUAYQBjAGgALQBPAGIAagBlAGMAdAAgAHsAIAAkAF8ALgBQAHIAbwBjAGUAcwBzAE4AYQBtAGUAIAArACAAJwB8ACcAIAArACAAJABfAC4ATQBhAGkAbgBXAGkAbgBkAG8AdwBUAGkAdABsAGUAIAB9AAoAdAByAHkAIAB7AAoAIAAgAEEAZABkAC0AVAB5AHAAZQAgAC0AQQBzAHMAZQBtAGIAbAB5AE4AYQBtAGUAIABTAHkAcwB0AGUAbQAuAFIAdQBuAHQAaQBtAGUALgBXAGkAbgBkAG8AdwBzAFIAdQBuAHQAaQBtAGUACgAgACAAJABhAHQAIAA9ACAAKABbAFMAeQBzAHQAZQBtAC4AVwBpAG4AZABvAHcAcwBSAHUAbgB0AGkAbQBlAFMAeQBzAHQAZQBtAEUAeAB0AGUAbgBzAGkAbwBuAHMAXQAuAEcAZQB0AE0AZQB0AGgAbwBkAHMAKAApACAAfAAgAFcAaABlAHIAZQAtAE8AYgBqAGUAYwB0ACAAewAgACQAXwAuAE4AYQBtAGUAIAAtAGUAcQAgACcAQQBzAFQAYQBzAGsAJwAgAC0AYQBuAGQAIAAkAF8ALgBHAGUAdABQAGEAcgBhAG0AZQB0AGUAcgBzACgAKQAuAEMAbwB1AG4AdAAgAC0AZQBxACAAMQAgAC0AYQBuAGQAIAAkAF8ALgBHAGUAdABQAGEAcgBhAG0AZQB0AGUAcgBzACgAKQBbADAAXQAuAFAAYQByAGEAbQBlAHQAZQByAFQAeQBwAGUALgBOAGEAbQBlACAALQBlAHEAIAAnAEkAQQBzAHkAbgBjAE8AcABlAHIAYQB0AGkAbwBuAGAAMQAnACAAfQApAFsAMABdAAoAIAAgAGYAdQBuAGMAdABpAG8AbgAgAFcAKAAkAG8AcAAsACAAJAB0ACkAIAB7ACAAJAB0AGEAcwBrACAAPQAgACQAYQB0AC4ATQBhAGsAZQBHAGUAbgBlAHIAaQBjAE0AZQB0AGgAbwBkACgAJAB0ACkALgBJAG4AdgBvAGsAZQAoACQAbgB1AGwAbAAsACAAQAAoACQAbwBwACkAKQA7ACAAJABuAHUAbABsACAAPQAgACQAdABhAHMAawAuAFcAYQBpAHQAKAAzADAAMAAwACkAOwAgACQAdABhAHMAawAuAFIAZQBzAHUAbAB0ACAAfQAKACAAIAAkAE0AIAA9ACAAWwBXAGkAbgBkAG8AdwBzAC4ATQBlAGQAaQBhAC4AQwBvAG4AdAByAG8AbAAuAEcAbABvAGIAYQBsAFMAeQBzAHQAZQBtAE0AZQBkAGkAYQBUAHIAYQBuAHMAcABvAHIAdABDAG8AbgB0AHIAbwBsAHMAUwBlAHMAcwBpAG8AbgBNAGEAbgBhAGcAZQByACwAIABXAGkAbgBkAG8AdwBzAC4ATQBlAGQAaQBhAC4AQwBvAG4AdAByAG8AbAAsACAAQwBvAG4AdABlAG4AdABUAHkAcABlACAAPQAgAFcAaQBuAGQAbwB3AHMAUgB1AG4AdABpAG0AZQBdAAoAIAAgACQAUAAgAD0AIABbAFcAaQBuAGQAbwB3AHMALgBNAGUAZABpAGEALgBDAG8AbgB0AHIAbwBsAC4ARwBsAG8AYgBhAGwAUwB5AHMAdABlAG0ATQBlAGQAaQBhAFQAcgBhAG4AcwBwAG8AcgB0AEMAbwBuAHQAcgBvAGwAcwBTAGUAcwBzAGkAbwBuAE0AZQBkAGkAYQBQAHIAbwBwAGUAcgB0AGkAZQBzACwAIABXAGkAbgBkAG8AdwBzAC4ATQBlAGQAaQBhAC4AQwBvAG4AdAByAG8AbAAsACAAQwBvAG4AdABlAG4AdABUAHkAcABlACAAPQAgAFcAaQBuAGQAbwB3AHMAUgB1AG4AdABpAG0AZQBdAAoAIAAgACQAbQBnAHIAIAA9ACAAVwAgACgAJABNADoAOgBSAGUAcQB1AGUAcwB0AEEAcwB5AG4AYwAoACkAKQAgACQATQAKACAAIABmAG8AcgBlAGEAYwBoACAAKAAkAHgAIABpAG4AIAAkAG0AZwByAC4ARwBlAHQAUwBlAHMAcwBpAG8AbgBzACgAKQApACAAewAKACAAIAAgACAAaQBmACAAKABbAHMAdAByAGkAbgBnAF0AJAB4AC4ARwBlAHQAUABsAGEAeQBiAGEAYwBrAEkAbgBmAG8AKAApAC4AUABsAGEAeQBiAGEAYwBrAFMAdABhAHQAdQBzACAALQBuAGUAIAAnAFAAbABhAHkAaQBuAGcAJwApACAAewAgAGMAbwBuAHQAaQBuAHUAZQAgAH0ACgAgACAAIAAgACQAcAAgAD0AIABXACAAKAAkAHgALgBUAHIAeQBHAGUAdABNAGUAZABpAGEAUAByAG8AcABlAHIAdABpAGUAcwBBAHMAeQBuAGMAKAApACkAIAAkAFAACgAgACAAIAAgACcATQB8ACcAIAArACAAJAB4AC4AUwBvAHUAcgBjAGUAQQBwAHAAVQBzAGUAcgBNAG8AZABlAGwASQBkACAAKwAgACcAfAAnACAAKwAgACQAcAAuAEEAcgB0AGkAcwB0ACAAKwAgACcAfAAnACAAKwAgACQAcAAuAFQAaQB0AGwAZQAKACAAIAB9AAoAfQAgAGMAYQB0AGMAaAAgAHsAfQAKAA==';
let games = {}, lastStatus = 'Etkinlik: bekleniyor';
const run = (cmd, args) => new Promise(res => execFile(cmd, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (e, out) => res(e ? '' : String(out))));
const csvRow = l => (l.match(/"([^"]*)"/g) || []).map(x => x.slice(1, -1));

async function loadGames() {
  try { const r = await fetch(config.server + '/api/presence/games', { signal: AbortSignal.timeout(8000) }); if (r.ok) games = await r.json(); } catch {}
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
  // Pencere başlıkları (Spotify şarkısı, Minecraft Java) — Türkçe karakterler bozulmasın diye PowerShell ile UTF-8 okunur
  const names = new Set(lines.map(l => (csvRow(l)[0] || '').toLowerCase()));
  let titles = [], media = [];
  if (names.has('spotify.exe') || (!game && names.has('javaw.exe'))) {
    const out = await run('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', PS_DETECT]);
    for (const l of out.split(/\r?\n/).filter(Boolean)) {
      const p = l.split('|');
      if (p[0] === 'M') media.push({ app: (p[1] || '').toLowerCase(), artist: p[2] || '', title: p.slice(3).join('|') });
      else titles.push([p[0].toLowerCase(), p.slice(1).join('|').trim()]);
    }
  }
  if (!game && titles.some(([p, t]) => p === 'javaw' && t.startsWith('Minecraft'))) { game = 'Minecraft'; detail = 'Java'; }
  let music = null;
  // 1) Windows medya oturumu: Spotify küçültülmüş ya da tepsideyken de çalışır
  const sm = media.find(m => m.app.includes('spotify') && m.title);
  if (sm) music = { artist: sm.artist, title: sm.title };
  // 2) Yedek: pencere başlığı "Sanatçı - Şarkı"
  if (!music) {
    const sp = titles.find(([p, t]) => p === 'spotify' && !/^Spotify/i.test(t) && t.includes(' - '));
    if (sp) { const t = sp[1], i = t.indexOf(' - '); music = { artist: t.slice(0, i), title: t.slice(i + 3) }; }
  }
  return { game, detail, music };
}

async function presenceLoop() {
  if (config.presenceKey) {
    const st = await detect();
    try {
      await fetch(config.server + '/api/presence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: config.presenceKey, ...st }), signal: AbortSignal.timeout(8000) });
      lastStatus = st.game ? `Oynuyor: ${st.game}` : st.music ? `Dinliyor: ${st.music.title}` : 'Etkinlik: boşta';
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
ipcMain.handle('kanka:logout', () => { config.presenceKey = null; saveConfig(); return { ok: true }; });
ipcMain.on('kanka:badge', (e, n) => { if (win && process.platform === 'win32') win.setOverlayIcon(n ? nativeImage.createFromPath(path.join(__dirname, 'dot.png')) : null, n ? `${n} okunmamış` : ''); win?.flashFrame(!!n && !win.isFocused()); });

app.whenReady().then(async () => {
  const hidden = config.startHidden && process.argv.includes('--hidden');
  if (!hidden) createSplash();
  await new Promise(r => setTimeout(r, 350));
  setSplash('Güncellemeler denetleniyor…');
  await checkUpdates();
  setSplash('Sunucuya bağlanılıyor…', config.server.replace(/^https?:\/\//, ''));
  createWindow(); buildTray();
  await loadGames(); setInterval(loadGames, 10 * 60e3);
  presenceLoop();
});
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', e => e.preventDefault());
