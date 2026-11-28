# App Store Connect: gönderim dosyası

App Store Connect'e girilecek her şey burada. Mağaza metinleri `fastlane/metadata/tr/` içinde (metadata denetiminden temiz geçti).

## 1. Gönderimden önce (sırayla)

Telefon uygulaması artık `Reuskilled/kanka-chat-mobile` (Expo / React Native). iOS derlemesini GitHub Actions (`ios.yml`) yapıyor: sırlar tanımlıysa imzalı IPA üretip TestFlight'a kendisi yüklüyor. Xcode'u elle açmaya gerek yok.

1. **Apple Developer üyeliği** (bireysel, 99 $/yıl). Satıcı adı olarak sahibinin adı soyadı görünür.
2. **App Store Connect › Uygulamalar › Yeni uygulama:** platform iOS, ad `Kanka Chat`, birincil dil Türkçe, paket kimliği `com.kanka.chat`, SKU `kankachat`.
3. **App Store Connect API anahtarı** (Users and Access › Integrations › App Store Connect API, rol *App Manager*). `.p8` dosyası, Key ID ve Issuer ID GitHub sırlarına girer: `ASC_KEY` (p8 dosyasının içeriği), `ASC_KEY_ID`, `ASC_ISSUER_ID`, `APPLE_TEAM_ID`. `IOS_DIST_KEY` dağıtım sertifikasının özel anahtarıdır (PEM): Claude üretip verir, sertifikayı CI Apple'da kendisi oluşturur. **Bu dosyanın ve `.p8` anahtarlarının yedeğini parola yöneticisinde tut** (Android'de yükleme anahtarı böyle kayboldu).
4. **APNs anahtarı** (Certificates, IDs & Profiles › Keys › Apple Push Notifications service). `.p8` dosyasını Yönetim paneli › Mobil bildirimler'e yükle. Team ID buradan otomatik alınır ve `kankahq.com/.well-known/apple-app-site-association` çalışmaya başlar (universal link).
5. **TestFlight'ta gerçek iPhone testi:** giriş, sesli oda (hoparlör / kulaklık / Bluetooth), özel sesli ve görüntülü arama, bildirimler, fotoğraf ve sesli mesaj gönderme, birlikte izle, Face ID kilidi, hesap silme.
6. **Demo hesap** (aşağıda, 4. bölüm).
7. **Ülkeler:** Pricing and Availability › sadece **Türkiye**. ABD/AB yaş doğrulama yasaları ve Fransa'nın şifreleme belgesi böylece ilk sürüme uygulanmaz.

Henüz yok (ilk sürüm için gerekmiyor): CallKit / PushKit (uygulama kapalıyken telefonun kendi arama ekranı) ve iOS ekran paylaşımı. Mağaza metninde ve inceleme notlarında bunlardan bahsetme.

## 2. Uygulama bilgileri

| Alan | Değer |
|---|---|
| Ad | Kanka Chat |
| Alt başlık | Arkadaşlarınla sesli sohbet |
| Kategori | Sosyal Ağ (ikincil: Eğlence) |
| Gizlilik politikası URL | https://kankahq.com/gizlilik |
| Destek URL | https://kankahq.com/destek |
| Pazarlama URL | https://kankahq.com |
| Fiyat | Ücretsiz, uygulama içi satın alma yok |
| Telif | 2026 Kanka Chat |

Açıklama, anahtar kelimeler, tanıtım metni: `fastlane/metadata/tr/`. **Mağaza metninde, ekran görüntülerinde ve uygulama adında "Discord" ve "VPN" geçmez** (Apple 2.3).

**Ekran görüntüleri** (6.9" ve 6.5" iPhone): uygulama kullanılırken çekilmiş gerçek ekranlar. Giriş ekranı olmasın. Öneri: 1) sunucu ve sohbet, 2) sesli oda, 3) özel mesajlar, 4) gelen arama ekranı, 5) profil ve rozetler. Kişisel bilgi görünmeyen bir test sunucusunda çek.

## 3. Şifreleme (Export Compliance)

`app.json`'da `usesNonExemptEncryption: true` (ITSAppUsesNonExemptEncryption = YES). Özel mesajlar uçtan uca şifreleniyor (standart algoritmalar: ECDH + AES-GCM). App Store Connect'in sorduğu sorulara cevaplar:

| Soru | Cevap |
|---|---|
| Uygulama şifreleme kullanıyor mu? | Evet |
| Apple'ın işletim sistemindeki şifrelemeye ek olarak ya da onun yerine standart algoritmalar kullanıyor mu? | Evet (standart algoritmalar) |
| Özel / standart dışı algoritma var mı? | Hayır |
| Fransa'da yayınlanacak mı? | Hayır (sadece Türkiye) |

ABD ihracat kuralları açısından bu "kitlesel pazar" (5D992.c) yazılımıdır. Her yıl Şubat başında ABD Ticaret Bakanlığı'na (BIS) kısa bir öz-sınıflandırma raporu e-postayla gönderilmesi gerekebilir. Zamanı gelince Claude'dan iste.

## 4. Demo hesap (inceleme için zorunlu)

Kayıt kapalı betada davet koduna bağlı. İncelemeci kendisi hesap açamaz, hazır hesap vermelisin. Bu artık tek tuş:

1. Yönetim paneli › Mobil › **İnceleme hesaplarını hazırla**.
2. Düğme `appleinceleme` ve `appleinceleme2` hesaplarını (2FA kapalı, yetişkin, arkadaş) ve içinde yazılı + sesli oda, örnek mesajlar ve aralarında DM olan "Apple İnceleme" sunucusunu kurar, şifreleri ekranda gösterir.
3. Gösterilen iki şifreyi aşağıdaki notlara yapıştır. Düğmeye tekrar basarsan şifreler yenilenir, notları da güncelle.
4. İstersen bir hesapla girip bir resim gönder (incelemeci medya paylaşımını görsün).
5. İnceleme süresince (birkaç gün) sunucunun açık kalacağından emin ol. Bu sürede büyük sunucu güncellemesi yapma.

## 5. İnceleme notları (App Review Information › Notes, İngilizce)

```
Kanka Chat is a Turkish-language community and voice chat app (servers, text and voice rooms, private messages, private voice/video calls).

DEMO ACCOUNTS (no 2FA)
  Account 1: appleinceleme / <şifre>
  Account 2: appleinceleme2 / <şifre>
Sign in with Account 1 on the device and Account 2 on the web at https://kankahq.com/app to test messaging and calls between them.

NATIVE FEATURES
  - Native React Native app (not a web wrapper): voice rooms and private voice/video calls over WebRTC, with speaker / earpiece / Bluetooth route selection.
  - Push notifications (APNs) for private messages, mentions, calls and friend requests.
  - Face ID app lock (optional, Profile -> Hesap ve güvenlik).
  - Watch-together: in a private message, paste a YouTube link and choose "+ -> Birlikte izle"; playback stays in sync for both users (official YouTube embed).
  - Universal links for kankahq.com invite links.

USER-GENERATED CONTENT (Guideline 1.2)
  - Users must accept the Terms (https://kankahq.com/kosullar), which state zero tolerance for objectionable content, before registering.
  - Report: long-press any message, or open a user's profile -> "Şikayet et" (Report). Reports are reviewed within 24 hours; offending content is removed and the account is suspended.
  - Block: profile or message menu -> "Engelle" (Block). Blocked users cannot message or call.
  - Server moderators can delete messages, mute, kick and ban; an automatic moderation filter is available.

ACCOUNT DELETION (Guideline 5.1.1(v))
  "Sen" (Profile) tab -> scroll down -> "Hesabı sil" (Delete account).

AGE
  Minimum age 15 (date of birth asked at sign-up, required by Turkish law 5651). Users under 18 must confirm guardian consent.

No in-app purchases. No ads. No third-party analytics or tracking SDKs.
Contact: kankahq1@gmail.com
```

## 6. Gizlilik etiketleri (App Privacy)

**Tracking (izleme):** Hayır. Hiçbir veri izleme için kullanılmıyor, reklam yok, üçüncü taraf analitik yok.

| Veri türü (Apple) | Toplanıyor | Kimliğe bağlı | Amaç |
|---|---|---|---|
| İletişim bilgisi › E-posta adresi | Evet | Evet | Uygulama işlevi |
| İletişim bilgisi › Ad (görünen ad) | Evet | Evet | Uygulama işlevi |
| Kullanıcı içeriği › E-postalar veya mesajlar | Evet | Evet | Uygulama işlevi |
| Kullanıcı içeriği › Fotoğraflar veya videolar | Evet | Evet | Uygulama işlevi |
| Kullanıcı içeriği › Ses verisi (sesli mesaj) | Evet | Evet | Uygulama işlevi |
| Kullanıcı içeriği › Diğer kullanıcı içeriği (profil, durum, sunucu içerikleri) | Evet | Evet | Uygulama işlevi |
| Tanımlayıcılar › Kullanıcı kimliği | Evet | Evet | Uygulama işlevi |
| Tanımlayıcılar › Cihaz kimliği (geri döndürülemez özet, yasak atlatmayı önlemek için) | Evet | Evet | Uygulama işlevi |
| Kullanım verisi › Ürün etkileşimi (seviye, seri, istatistik) | Evet | Evet | Uygulama işlevi, Analiz (sadece kendi istatistiklerimiz) |
| Diğer veriler (doğum tarihi: yaş sınırı ve veli onayı) | Evet | Evet | Uygulama işlevi |

Toplanmayanlar: konum, kişiler, sağlık, finans, tarama geçmişi, arama geçmişi, hassas bilgi, çökme verisi.
`app.json` › `ios.privacyManifests` bu tabloyla birebir aynı. Biri değişirse ikisi de değişmeli, `kankahq.com/gizlilik` de.

## 7. Yaş derecelendirmesi (2026 anketi)

| Soru | Cevap |
|---|---|
| Kullanıcı tarafından oluşturulan içerik | Evet |
| Kullanıcılar arası mesajlaşma ve sohbet | Evet |
| Kısıtlamasız web erişimi | Hayır (sadece kankahq.com açılır) |
| Şiddet, cinsellik, kumar, alkol/uyuşturucu, korku | Yok |
| Yaş doğrulama / ebeveyn denetimi | Uygulama içinde yaş kapısı (15+), 18 altına veli onayı |
| Paylaşılan konum | Hayır |
| Flört / ilişki | Hayır |

Beklenen derece: **13+** ya da **16+** (kullanıcı içeriği ve yabancılarla sohbet nedeniyle). Hangisini önerirse kabul et; uygulamanın kendi yaş kuralı (15+, 5651 sayılı Kanun) ayrıca uygulama içinde işliyor.

## 8. Ret gelirse

Apple'ın yazdığı kural numarasını ve metnini olduğu gibi Claude'a ver. Aynı derlemeyi değiştirmeden tekrar gönderme.
