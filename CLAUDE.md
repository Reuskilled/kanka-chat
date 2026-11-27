# Kanka Chat: Claude için devir notu

Bu dosya, projeyi başka bir Claude oturumundan devralan Claude için. Önce bunu oku, sonra kaldığın yerden devam et.
Son güncelleme: 27 Kasım 2026.

## Proje
Türkçe, Discord tarzı sohbet uygulaması. Tek geliştirici: Reuskilled (kullanıcı). Canlı: https://kankahq.com

| Repo | İçerik |
| --- | --- |
| `Reuskilled/kanka-chat` (bu repo) | `server.js` (Node, Express, Socket.IO, tek dosya), `public/` web arayüzü (`index.html` tek dosya), `desktop/` Electron, `vds/` sunucu güncelleyici, `tanitim/` tanıtım videosu kaynakları, `magaza/` Play ve App Store gönderim rehberleri ile mağaza metinleri |
| `Reuskilled/kanka-chat-mobile` | Yerel telefon uygulaması: Expo SDK 58, RN 0.88, Expo Router, TypeScript. Kendi `CLAUDE.md`'si var |

**Yayına alma:** `main`'e push = 1 dakika içinde canlı sunucuda (VDS güncelleyicisi depoyu izliyor). Yani her push canlıya gider; test etmeden push etme.

**İki repo da herkese açık.** Şifre, anahtar, keystore, google-services.json, sunucu ayarı asla commit edilmez.

## Kullanıcıyla çalışma kuralları
- Türkçe, samimi, kısa konuş ("kanka" tonu). Uzun açıklama değil, doğrudan iş.
- Sorma, yap. Belirsizse makul olanı seç ve söyle.
- Hukuki konuları ağır anlatma; basit ve pratik tut.
- **Topluluk geri bildirimi akışı:** Kullanıcı bir üyenin şikayetini/ekran görüntüsünü getirince: düzelt → test et (yerel sunucu + Playwright) → push → cevabın sonunda küçük harfle yazılmış, samimi bir **"Topluluk için cevap"** metni ver.
- `public/degisiklik-gunlugu.json`'a **sadece Kanka Bot ile ilgili** değişiklikler girer (en üste eklenir: id, baslik, metin).
- Commit mesajları Türkçe.
- **Güvenlik:** Şifre veya API anahtarını hiçbir alana sen girme; sırları (Play hizmet hesabı, Firebase, APNs, GitHub secrets) kullanıcı kendisi yükler. Ürettiğin anahtarları kullanıcıya ver ve kendi kopyanı sil. claude-mem kurulum seçimlerini kullanıcı adına yapma. Cloudflare aktif olmadan `cloudflare-kilit.ps1` çalıştırma.

## Yerel test
```bash
npm install
PORT=3313 DATA_DIR=/tmp/kanka-test node server.js     # boş veriyle başlar; test kullanıcılarını kayıtla aç
```
Önceki oturumdaki test verisinde kullanıcılar `sahip`, `uye` ("Mert"), `ucuncu` (şifre `sifre123`), sunucular `s1` "Kanka HQ" (herkese açık) ve `2fc1550663` "Gece Lobisi" vardı. Yeni ortamda bu veri yok; gerekirse yeniden oluştur.
Testler Playwright ile, sayfa içinden `socket.emit(...)` çağırarak yazılıyor (web: `http://localhost:3313/app`).

## Son durum (27 Kasım 2026)
- **Kanka Bot otomatik moderasyon:** Yönetim ekibi (`isStaff`: sahip, yönetici, moderatör, ya da administrator/manageServer/manageRoles/manageChannels/manageMessages/kick/ban/timeout yetkisi olan) hiçbir kuraldan etkilenmez.
- **Mesaj seli cezası (`msgFlood`):** Yere bağlı (sunucu ya da DM). Sunucuda normal susturma (`s.timeouts`) olarak uygulanır, yetkili kaldırabilir. Sahip ve yönetim ekibi kendi sunucusunda ceza almaz. Sahip hiçbir zaman susturulmuş sayılmaz (`timedOut`).
- **Spark (ücretli abonelik):** Vergi levhası çıkana kadar ertelendi. Sunucu kodu hazır (Google Play ve App Store doğrulaması). Uygulamada satış kapalıyken Spark ve Energy girişleri gizli (giriş yanıtında `magaza: {play, apple}`).
- **iOS:** App Store gönderim rehberi Claude Docs'ta hazırlandı (önceki hesapta). Gizlilik manifesti ve şifreleme beyanı (`usesNonExemptEncryption: true`, standart algoritma) ayarlı.

## Bekleyen işler
**Kullanıcıda olanlar**
- GitHub secrets: Android (`ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASS`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASS`, `GOOGLE_SERVICES_JSON`) ve iOS (`APPLE_TEAM_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY`, `IOS_DIST_KEY`).
- Firebase `google-services.json`: gelmeden Android'de telefon bildirimi çalışmaz.
- Apple Developer üyeliği ve App Store Connect kaydı. APNs anahtarı sunucu ayarına: `"apns": {key, keyId, teamId, bundle, prod: true}`.
- Spark: vergi levhasından sonra Play ve App Store ürünleri. App Store bildirim adresi `https://kankahq.com/apple/bildirim`, ayara `"apple": {"on": true}`.

**Claude'da olanlar**
- TestFlight'tan sonra: iOS CallKit/PushKit ve iOS ekran paylaşımı (broadcast extension).
- `wip/masaustu-oyun-algilama` dalı: masaüstü oyun algılama, yarım kaldı. Kullanıcı istemeden dokunma.

## Tanıtım videoları
Kaynaklar `tanitim/` klasöründe; nasıl render edildiği `tanitim/README.md`'de. Seri: **Yorumlarla Kanka** (bir üyenin yorumu → "Tamam kanka. YAPTIK." → özellik → "sıradaki bölüm senin yorumun"). #1 Rob Run, #2 telefon uygulaması. Bir sonraki bölüm için gerçek bir yorum kullan, uydurma yorum koyma.
