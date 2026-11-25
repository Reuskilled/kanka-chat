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
| Push bildirimleri | ✅ kod hazır | ✅ kod hazır | Anahtarlar yüklenince çalışır (aşağıda) |
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
| 2 | Push: `@capacitor/push-notifications`, cihaz jetonu kaydı (`pushNative`), Android FCM HTTP v1 + iOS APNs (HTTP/2, .p8) gönderimi, bildirime basınca ilgili ekrana gitme, Android bildirim kanalları, yönetim panelinden anahtar yükleme | ✅ kod hazır · anahtar ve cihaz testi bekliyor |
| 3 | Ses: Android ön plan hizmeti (mikrofon), iOS ses oturumu, Bluetooth/hoparlör/kulaklık seçimi, gelen arama bildirimi önceliği | ✅ kod hazır · cihaz testi bekliyor (CallKit/tam ekran arama: Faz 3b) |
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

## 9. Faz 2: bildirimler

**Nasıl çalışıyor:** Uygulama girişten sonra bildirim izni ister (ilk girişte bir kez), işletim sisteminden cihaz jetonunu alır ve `pushNative` ile hesaba bağlar (en fazla 10 cihaz; aynı jeton başka hesaptaysa oradan alınır, çıkış yapınca silinir). Sunucu, mevcut bildirim akışında (`sendPush`: özel mesaj, etiketlenme, gelen ve cevapsız arama, arkadaşlık isteği ve kabulü) web aboneliklerine ek olarak telefonlara da gönderir:

- **Android:** Firebase Cloud Messaging HTTP v1 (hizmet hesabıyla JWT → erişim jetonu, 1 saat önbellek). Kanallar: `mesajlar`, `aramalar`, `sosyal`. Küçük simge `ic_stat_kanka`, renk Kanka yeşili.
- **iOS:** APNs'e doğrudan HTTP/2 (`.p8` anahtarıyla ES256 JWT). Yayın/geliştirme ortamı yanlışsa bir kez diğeri denenir.
- Geçersiz jetonlar kendiliğinden silinir; hatalar Yönetim paneli › Mobil bildirimler'de görünür.
- Bildirime basınca ilgili sohbet/sunucu/arkadaş sayfası açılır; uygulama kapalıysa giriş bitince açılır.
- Kanka açıkken (ekrana bakılıyorsa) bildirim gönderilmez; uygulama içi bildirim zaten gösterilir.

**Kurulum (bir kez):**
1. Firebase: proje oluştur, `com.kanka.chat` Android uygulamasını ekle. `google-services.json` → `mobile/android/app/` (depoya girmez). Proje ayarları › Hizmet hesapları › yeni özel anahtar → Yönetim paneli › Mobil bildirimler'e yükle.
2. Apple: Keys › APNs anahtarı (.p8) oluştur → panele yükle, Key ID ve Team ID'yi yaz. Xcode'da **Signing & Capabilities**'te takımını seç (Push Notifications ve Associated Domains `App.entitlements` içinde hazır).
3. Uygulamada Ayarlar › Bildirimler › **Dene** ile test et.

**Test durumu:** Jeton kaydı, izin akışı, kanal oluşturma, bildirime basınca yönlendirme, anahtar doğrulama ve hata kaydı sahte eklentiyle uçtan uca test edildi. FCM imzası ve istek gövdesi, APNs JWT'si ve HTTP/2 isteği (410/BadDeviceToken dahil) yerel sahte sunucularla test edildi. **Gerçek Google/Apple sunucularına ve telefona gönderim test edilmedi** (anahtar ve cihaz gerekiyor).

## 10. Faz 3: telefonda ses

Yerel eklenti **KankaSes** (Android: `KankaSesPlugin.java` + `KankaSesService.java`, iOS: `KankaSes.swift`). Web tarafı sesli odaya/aramaya girince `start`, çıkınca `stop` çağırır.

| | Android | iOS |
|---|---|---|
| Uygulama arka plandayken seste kalma | ✅ Mikrofon türünde ön plan hizmeti + "Sesli odadasın · Ayrıl" bildirimi. Uygulama kaydırılıp kapatılınca sesten çıkar | ⚠️ WKWebView, uygulama arka plana geçince mikrofonu durdurur (Apple sınırı). Dönünce kullanıcıya söylenir. Gerçek çözüm yerel WebRTC (Faz 5) |
| Ses çıkışı seçimi | ✅ Hoparlör / Telefon (kulakta) / Bluetooth / kablolu kulaklık (Android 12+ `setCommunicationDevice`, eski sürümlerde SCO/hoparlör) | ✅ `AVAudioSession` (playAndRecord + voiceChat), hoparlör/ahize/Bluetooth/kulaklık |
| Kulaklık takılınca / çıkarılınca | ✅ Kendiliğinden ona geçer | ✅ Kendiliğinden ona geçer |
| Telefon araması gelince | Sistem yönetir | ✅ Arama bitince ses oturumu geri açılır |
| Gelen Kanka araması | ✅ "Aramalar" kanalı (en yüksek öncelik, açılır bildirim) | ✅ Zaman duyarlı bildirim (Odak modunu deler) |
| Tam ekran arama ekranı | Faz 3b (ConnectionService + tam ekran niyet) | Faz 3b (CallKit + PushKit VoIP) |

Arayüzde: sesteyken alttaki ses çubuğunda **Ses çıkışı** düğmesi (yalnızca uygulamada).

**Cihazda denenecekler:** odaya gir → uygulamayı arka plana al → karşı taraf seni duyuyor mu (Android) · bildirimdeki Ayrıl · Bluetooth kulaklık bağla/çıkar · ses çıkışı menüsü · telefon araması gelip bitince ses geri geliyor mu · arama bildirimi.

## 11. Test APK'sı (Android)

- `.github/workflows/mobil.yml`: `mobile/` değişince (ya da elle "Run workflow") GitHub Actions APK derler, `android-v<sürüm>-<no>` adıyla ön sürüm olarak yayınlar (masaüstünün "en son sürüm"ünü etkilemez).
- Sunucudaki güncelleyici 5 dakikada bir bakar, yeni APK'yı `indir/KankaChat.apk`'ye çeker → **https://kankahq.com/indir/KankaChat.apk**
- İmza: gizli değişken `ANDROID_KEYSTORE_B64` (+ `ANDROID_KEYSTORE_PASS`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASS`) varsa onunla; yoksa depodaki **test anahtarıyla** (`android/app/test-debug.keystore`, şifre `android`). Test anahtarıyla imzalı APK'lar birbirinin üstüne kurulur ama Play Store'a gönderilemez.
- Play Store için: yükleme anahtarını kendi bilgisayarında oluştur (`keytool -genkeypair -keystore kanka-upload.jks -alias kanka -keyalg RSA -keysize 4096 -validity 10000`), dosyayı güvenli sakla, base64'ünü ve şifresini GitHub › Settings › Secrets › Actions'a ekle.

## App Store denetimi (25 Kasım 2026)

- `ios/App/App/PrivacyInfo.xcprivacy` eklendi (toplanan veri türleri + UserDefaults CA92.1). App Store Connect'teki gizlilik etiketleri bununla ve `kankahq.com/gizlilik` ile birebir aynı tutulmalı.
- `UIBackgroundModes` içinden `audio` kaldırıldı: WKWebView arka planda mikrofonu durdurduğu için arka planda ses çalmıyorduk (Apple 2.5.4 ret sebebi). Yerel WebRTC/CallKit ile arka planda seste kalma gerçekten çalışınca geri eklenmeli.
- iOS uygulamasında Spark ("yakında", bekleme listesi) gizlendi (`IOS_APP`); satış Apple IAP ile Faz 4'te.
- Kullanım Şartları sürüm 5: uygunsuz içeriğe sıfır tolerans ve şikayetlere 24 saat içinde işlem (Apple 1.2).
- Gönderimden önce hâlâ gerekenler: Faz 3'ün gerçek cihazda testi + CallKit (Apple 4.2), inceleme notlarında demo hesap, gizlilik etiketleri, 2026 yaş anketi, ilk sürümde sadece Türkiye, mağaza metninde "Discord"/"VPN" geçmemesi.
