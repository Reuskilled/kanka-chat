// Sayfa ile masaüstü uygulaması arasındaki güvenli köprü
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('kankaDesktop', {
  isDesktop: true,
  customTitlebar: true,
  setTitlebar: (color, symbol) => ipcRenderer.send('kanka:titlebar', color, symbol),
  setPresenceKey: key => ipcRenderer.invoke('kanka:presenceKey', key),
  info: () => ipcRenderer.invoke('kanka:info'),
  sources: () => ipcRenderer.invoke('kanka:sources'),
  autostart: p => ipcRenderer.invoke('kanka:autostart', p || null),
  pickSource: (id, audio) => ipcRenderer.invoke('kanka:pick', { id, audio }),
  logout: () => ipcRenderer.invoke('kanka:logout'),
  badge: n => ipcRenderer.send('kanka:badge', n),
  onUpdateReady: cb => { ipcRenderer.on('kanka:update-ready', (e, v) => cb(v)); ipcRenderer.invoke('kanka:update-pending').then(p => p && cb('')); },
  installUpdate: () => ipcRenderer.invoke('kanka:install-update'),
  overlay: st => ipcRenderer.send('kanka:overlay', st),
  overlayConfig: p => ipcRenderer.invoke('kanka:overlayConfig', p || null),
  // Bilgisayarın genelinde (oyun dahil) son klavye/fare hareketinden bu yana geçen saniye; ekran kilitliyse -1
  idleTime: () => ipcRenderer.invoke('kanka:idle'),
  // Kanka yönetimi: sunucu yedeğini bu bilgisayara indir (Belgeler/Kanka Yedekleri)
  saveBackup: token => ipcRenderer.invoke('kanka:saveBackup', token),
  openBackups: () => ipcRenderer.invoke('kanka:openBackups'),
});
