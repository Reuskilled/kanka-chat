# Kanka Chat

Sıcak ve samimi, Discord tarzı gerçek zamanlı sohbet uygulaması.

**Canlı:** https://kankahq.com

## Klasörler
- `server.js`, `public/`: sunucu ve web arayüzü (Node.js, Express, Socket.IO)
- `desktop/`: Windows masaüstü uygulaması (Electron, Squirrel kurulum ve otomatik güncelleme)
- `vds/`: sunucu kurulumu (`KUR.bat`) ve otomatik güncelleyici (`GUNCELLEYICI-KUR.bat`, `guncelleyici.js`)

## Otomatik güncelleme
VDS'teki güncelleyici bu depoyu dakikada bir kontrol eder. `main` dalına gelen her değişiklik
1 dakika içinde sunucuya kurulur; gerekirse sunucu yeniden başlar ve açık sayfalarda
"Kanka Chat güncellendi" kartı çıkar. Masaüstü sürümleri GitHub Releases'tan dağıtılır.

## Yerelde çalıştırma
```
npm install
npm start   # http://localhost:3000
```
