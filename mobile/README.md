# Kanka Chat · Android ve iOS

Bu klasör Kanka Chat'in telefon uygulamasıdır (Capacitor 8). Web sitesi, Windows uygulaması ve telefon uygulaması **aynı arayüzü, aynı sunucuyu ve aynı hesapları** kullanır.

---

## 1. Mevcut mimari (analiz)

| Parça | Ne | Mobil için anlamı |
|---|---|---|
| `server.js` | Tek Node/Express sunucusu: REST (`/api/...`), Socket.IO, dosya yükleme (`/dosya`, `/uploads`), TURN (node-turn), Web Push (VAPID), e-posta | Hiç değişmeden mobilin de arka ucu. Socket.IO ve REST zaten HTTPS üzerinden, aynı adresten |
| `public/index.html` | Tüm uygulama tek sayfa (~18 bin satır). Tüm istekler göreli adreslerle (`/api`, `io()`), oturum `localStorage`'da `kanka-token` | Telefon genişliğinde zaten çalışan bir mobil düzeni var (çekmece menüsü, alt çubuk, dokunma). Kod kopyalanmadan aynen kullanılabilir |
| `desktop/` | Electron. Arayüzü kendi içine gömmez, `https://kankahq.com/app` adresini açar; üstüne tepsi, oyun algılama, ekran paylaşımı ekler | Mobil de aynı modeli kullanıyor (aşağıda) |
| Ses | WebRTC eşler arası (P2P), TURN aynı sunucuda | Android WebView ve iOS WKWebView (iOS 14.3+) WebRTC'yi destekliyor |
| Ekran paylaşımı | `getDisplayMedia` | Telefon WebView'larında **yok** (bkz. riskler) |
| Bildirim | Web Push (VAPID) + servis çalışanı | WebView'larda Web Push **çalışmaz**; mobilde FCM/APNs gerekiyor |
| Veri | `veri/data.json` + SQLite (`mesajlar.db`, `istatistik.db`) | Değişmiyor; hesaplar ve mesajlar zaten ortak |
| Abonelik | Kanka Spark & Energy (sunucu tarafı hazır). **Ödeme sistemi henüz yok**; Spark şimdilik yönetim panelinden veriliyor | Mobilde Apple IAP / Google Play Billing gerekecek |

## 2. Mimari kararı: "uzak arayüzlü" Capacitor

Capacitor uyumlu: proje saf HTML/CSS/JS, derleme adımı yok, her şey göreli adres ve HTTPS.

Seçilen model, Windows uygulamasıyla aynı: **yerel kabuk + arayüz `https://kankahq.com/app`'ten**.

- Kod kopyası yok: tek `public/index.html` üç platformu besler. Mobil için ayrı yerler sadece `html.native` sınıfı ve `NATIVE` değişkeniyle ayrılır.
- Arayüz düzeltmeleri mağaza onayı beklemeden telefonlara gelir. Mağaza güncellemesi sadece yerel kod (izinler, eklentiler) değişince gerekir.
- Hesap, oturum, mesaj, sunucu: hepsi ortak, taşıma yok.
- İnternet yoksa uygulama içindeki `www/hata.html` açılır ("Bağlanamadık · Tekrar dene"), bağlantı gelince kendiliğinden döner.

Alternatif (arayüzü uygulamanın içine gömmek) her arayüz değişikliğinde mağaza onayı ve tüm göreli adreslerin değiştirilmesini gerektirirdi; reddedildi.

**Mağaza riski:** Apple "sadece bir web sitesini saran" uygulamaları (Kural 4.2) reddedebilir. Bunu karşılamak için mobile özgü yerel özellikler (yerel bildirimler, arama ekranı, paylaş menüsü, uygulama bağlantıları, titreşim, arka planda ses) Faz 2-4'te eklenecek. İlk gönderim bunlar olmadan yapılmamalı.

## 3. Uyumluluk raporu

| Özellik | Android | iOS | Not |
|---|---|---|---|
| Giriş, kayıt, profil, arkadaşlar, DM, sunucular, odalar, roller, moderasyon, engelleme, şikayet, ayarlar, yönetim | ✅ | ✅ | Web arayüzü aynen çalışır |
| Resim / dosya gönderme | ✅ | ✅ | `<input type=file>` → sistemin galeri/dosya/kamera seçicisi |
| Sesli oda, arama, sesli mesaj | ✅ ön planda | ✅ ön planda | Mikrofon izni sistem penceresiyle istenir |
| Arka planda seste kalma | ⚠️ Faz 3 | ⚠️ Faz 3 | Android: mikrofonlu ön plan hizmeti gerekir. iOS: `audio` arka plan modu eklendi; aramalar için CallKit gerekir |
| Bluetooth kulaklık, hoparlör seçimi | ⚠️ Faz 3 | ⚠️ Faz 3 | İzinler eklendi; ses yönlendirme için yerel ses oturumu eklentisi gerekir |
| Gelen arama ekranı | ❌ → Faz 3 | ❌ → Faz 3 | Android ConnectionService / iOS CallKit + PushKit (VoIP) |
| Push bildirimleri | ❌ → Faz 2 | ❌ → Faz 2 | FCM (Android) + APNs (iOS); sunucuya cihaz jetonu kaydı ve gönderimi eklenecek |
| Ekran paylaşımı | ❌ | ❌ | WebView'larda `getDisplayMedia` yok. Android MediaProjection ve iOS ReplayKit ancak **yerel WebRTC** ile mümkün (büyük iş, Faz 5). O zamana kadar mobilde düğme gizli kalır (zaten `getDisplayMedia` yoksa gizleniyor); izlemek çalışır |
| Uygulama bağlantıları (davet linkleri) | ✅ hazır, imza bekliyor | ✅ hazır, Team ID bekliyor | Sunucu `assetlinks.json` / `apple-app-site-association` yayınlıyor (ortam değişkenleriyle) |
| Android geri tuşu | ✅ | — | Açık pencere/çekmece/oda geçmişi kapanır; en başta uygulama arka plana alınır |
| Spark aboneliği satın alma | ❌ → Faz 4 | ❌ → Faz 4 | Apple IAP / Google Play Billing + sunucuda makbuz doğrulama |

## 4. Riskler

1. **Apple Kural 4.2 (minimum işlev):** yukarıda. Faz 2-4 bitmeden iOS'a gönderme.
2. **Arka plan sınırları:** iOS uygulama arka plana geçince WebView'ı durdurur; sesli odada kalmak ses oturumu + CallKit ister. Android 14 mikrofonu arka planda ancak ön plan hizmetiyle verir.
3. **Ödemeler:** Telefonda dijital abonelik satışı mağazanın kendi ödemesiyle yapılmalı (Apple %15-30, Google %15). Web'den alınan Spark mobilde de geçerli olur; ama uygulama içinde web'e ödeme linki verilemez (Türkiye'de).
4. **Oturum güvenliği:** Oturum jetonu şimdilik WebView'ın `localStorage`'ında (uygulamaya özel, başka uygulama okuyamaz). Faz 2'de Keychain/Keystore'a taşınması önerilir.
5. **Bu ortamda derleme yapılamıyor:** Android SDK/Gradle ve Xcode buradan indirilemiyor. Android derlemesi Android Studio'da, iOS derlemesi bir Mac'te Xcode ile yapılmalı. Bu yüzden telefon üzerindeki testler henüz yapılmadı (bkz. Durum).

## 5. Plan

| Faz | İçerik | Durum |
|---|---|---|
| 1 | Klasör yapısı, Capacitor kurulumu, Android ve iOS projeleri, izinler, simgeler, açılış ekranı, çevrimdışı ekranı, geri tuşu, uygulama bağlantıları, web tarafında korumalı mobil uyum | ✅ yapıldı (cihazda test bekliyor) |
| 2 | Push: `@capacitor/push-notifications`, sunucuya cihaz jetonu kaydı (`pushNative`), FCM HTTP v1 gönderimi, bildirime basınca ilgili ekrana gitme (DM, istek, bahsetme, sunucu); Keychain'de oturum | sırada |
| 3 | Ses: Android ön plan hizmeti (mikrofon), iOS ses oturumu, Bluetooth/hoparlör seçimi, CallKit/ConnectionService ile gelen arama, VoIP push | |
| 4 | Spark ödemesi: Apple IAP + Google Play Billing, sunucuda makbuz doğrulama, mevcut Spark haklarının korunması | |
| 5 | Ekran paylaşımı (yerel WebRTC + MediaProjection/ReplayKit), mağaza paketleri, gizlilik formları | |

## 6. Derleme

Gerekenler: Node 20+, **Android Studio** (Android için), **Mac + Xcode 16+** (iOS için).

```bash
cd mobile
npm install
npx cap sync          # ayarları ve eklentileri yerel projelere kopyalar
npx cap open android  # Android Studio'da aç → Run
npx cap open ios      # Xcode'da aç → Signing'de takımı seç → Run
```

Yayın imzası (Android): Android Studio › Build › Generate Signed Bundle. Anahtar dosyası (`*.jks`) ve şifreleri **depoya girmez** (`.gitignore` hazır).

## 7. Senden gerekenler

| Ne | Neden |
|---|---|
| Google Play geliştirici hesabı (25$ tek sefer) | Android yayını |
| Apple Developer Program (99$/yıl) ve **Team ID** | iOS yayını, push, Universal Links |
| Firebase projesi (`com.kanka.chat` Android + iOS uygulaması) | Push bildirimleri. `google-services.json` / `GoogleService-Info.plist` depoya girmez |
| Android imza sertifikasının SHA-256 parmak izi | Davet linklerinin uygulamada açılması |

Sunucuda (VDS) ortam değişkenleri: `ANDROID_SHA256=AA:BB:...` ve `IOS_TEAM_ID=XXXXXXXXXX` girilince `/.well-known/assetlinks.json` ve `apple-app-site-association` kendiliğinden yayınlanır.

## 8. Faz 1 durumu

- `mobile/` oluşturuldu: `capacitor.config.ts`, `android/`, `ios/`, `www/` (açılış ve çevrimdışı ekranı).
- Uygulama kimliği `com.kanka.chat` (Windows uygulamasıyla aynı), adı "Kanka Chat", koyu tema, Kanka simgesi (uyarlanabilir Android simgesi + iOS 1024px), açılış ekranı.
- Android izinleri: internet, mikrofon, ses ayarları, Bluetooth, kamera, bildirim, titreşim. iOS: mikrofon, kamera, galeri açıklamaları (Türkçe), `audio` arka plan modu.
- Web tarafı (`public/index.html`): `NATIVE` algılama, Android geri tuşu, uygulama bağlantıları, uyanınca yeniden bağlanma, durum çubuğu; telefonda "ana ekrana ekle" istemleri kapalı. **Tarayıcıda ve Windows uygulamasında hiçbir şey değişmez** (test edildi).
- Sunucu: `KankaMobil/` tarayıcı kimliği `/app`'e yönlenir; `assetlinks.json` ve `apple-app-site-association` (ortam değişkenine bağlı).
- Test edildi: web sürümünde regresyon yok; mobil köprü sahte Capacitor ortamında çalışıyor; sunucu bağlantı dosyaları doğru.
- **Test edilmedi:** gerçek Android/iOS cihazında çalıştırma (bu ortamda derleme yapılamıyor).
