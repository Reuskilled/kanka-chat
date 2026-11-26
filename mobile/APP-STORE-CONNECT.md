# App Store Connect: gönderim dosyası

App Store Connect'e girilecek her şey burada. Mağaza metinleri `fastlane/metadata/tr/` içinde (metadata denetiminden temiz geçti).

## 1. Gönderimden önce (sırayla)

1. **Gerçek iPhone'da test:** sesli oda, özel arama, gelen arama ekranı (CallKit), bildirimler, fotoğraf gönderme, hesap silme.
2. **APNs:** Yönetim paneli › Mobil bildirimler'e Apple'dan aldığın `.p8` anahtarını yükle. Aynı anahtar hem normal bildirimler hem gelen aramalar (VoIP, `com.kanka.chat.voip`) için çalışır, ayrı sertifika gerekmez.
3. **Xcode:** Signing & Capabilities'te *Push Notifications* ve *Background Modes › Voice over IP + Remote notifications* açık olmalı (Info.plist'te var). Archive alırken `aps-environment` production olur.
4. **Universal link:** Team ID artık 2. adımda yüklediğin APNs anahtarındaki Team ID'den otomatik alınıyor (istersen VDS'te `IOS_TEAM_ID` ile ezebilirsin). Anahtarı yükledikten sonra tarayıcıda `kankahq.com/.well-known/apple-app-site-association` adresini açıp JSON göründüğünü kontrol et.
5. **Demo hesap** (aşağıda, 4. bölüm).
6. **Ülkeler:** Pricing and Availability › sadece **Türkiye**. ABD/AB yaş doğrulama yasaları ve Çin'in şifreli mesajlaşma beyanı böylece ilk sürüme uygulanmaz.

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

`ITSAppUsesNonExemptEncryption = false` (Info.plist'te). Gerekçe: özel mesaj şifrelemesi iOS'un kendi şifreleme kütüphanesini (WKWebView içinde Web Crypto) standart algoritmalarla kullanır, özel/standart dışı algoritma yok. App Store Connect sorarsa: *"Yalnızca işletim sisteminin sağladığı standart şifrelemeyi kullanıyor"* seçeneği.

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
  - Incoming private calls use CallKit + PushKit: from Account 2 on the web, open the DM with Account 1 and press the call button; the device shows the native incoming-call screen even when the app is closed.
  - Push notifications (APNs) for private messages, mentions and friend requests.
  - Native audio session: speaker / earpiece / Bluetooth route selection in voice rooms.
  - Universal links for kankahq.com invite and channel links.

USER-GENERATED CONTENT (Guideline 1.2)
  - Users must accept the Terms (https://kankahq.com/kosullar), which state zero tolerance for objectionable content, before registering.
  - Report: long-press any message, or open a user's profile -> "Şikayet et" (Report). Reports are reviewed within 24 hours; offending content is removed and the account is suspended.
  - Block: profile or message menu -> "Engelle" (Block). Blocked users cannot message or call.
  - Server moderators can delete messages, mute, kick and ban; an automatic moderation filter is available.

ACCOUNT DELETION (Guideline 5.1.1(v))
  Settings (gear icon) -> Hesap (Account) -> "Hesabı kalıcı olarak sil" (Delete account permanently).

AGE
  Minimum age 13 (date of birth asked at sign-up). Users under 18 must confirm guardian consent.

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
`ios/App/App/PrivacyInfo.xcprivacy` bu tabloyla birebir aynı. Biri değişirse ikisi de değişmeli, `kankahq.com/gizlilik` de.

## 7. Yaş derecelendirmesi (2026 anketi)

| Soru | Cevap |
|---|---|
| Kullanıcı tarafından oluşturulan içerik | Evet |
| Kullanıcılar arası mesajlaşma ve sohbet | Evet |
| Kısıtlamasız web erişimi | Hayır (sadece kankahq.com açılır) |
| Şiddet, cinsellik, kumar, alkol/uyuşturucu, korku | Yok |
| Yaş doğrulama / ebeveyn denetimi | Uygulama içinde yaş kapısı (13+), 18 altına veli onayı |
| Paylaşılan konum | Hayır |
| Flört / ilişki | Hayır |

Beklenen derece: **13+** (kullanıcı içeriği ve yabancılarla sohbet nedeniyle). Apple 16+ önerirse kabul et, bu uygulamanın kendi yaş kuralını (15+, 5651 sayılı Kanun) değiştirmez.

## 8. Ret gelirse

Apple'ın yazdığı kural numarasını ve metnini olduğu gibi Claude'a ver. Aynı derlemeyi değiştirmeden tekrar gönderme.
