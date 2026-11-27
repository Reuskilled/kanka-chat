# Google Play gönderimi (Kanka Chat, com.kanka.chat)

Kodda yapılanlar: Kanka Spark aboneliği Google Play Faturalandırma (Billing Library 8.3) ile satılıyor, sunucu her satın almayı Google Play Developer API ile doğruluyor ve onaylıyor; targetSdk 36, R8 açık, `.aab` derlemesi (Codemagic `android-apk` artık `KankaChat.aab` da üretir), reklam kimliği izni çıkarıldı, Spark iOS uygulamasında gizli (StoreKit gelene kadar), web'den hesap silme sayfası `https://kankahq.com/hesap-silme`, Android mağaza metinleri `fastlane/metadata/android/tr-TR`.

## 1. Gönderimden önce (sırayla)

1. **İmza anahtarı:** Codemagic `android` grubuna `ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASS`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASS` ekle. Anahtar yoksa derleme hata ayıklama anahtarıyla imzalanır ve Play kabul etmez. Anahtarı ve şifreyi kaybetme, yedekle.
2. **Firebase:** `firebase` grubuna `GOOGLE_SERVICES_JSON` ekle (bildirimler için). Yönetim paneli › Mobil'e FCM servis hesabı JSON'unu yükle.
3. Codemagic'te `android-apk` iş akışını çalıştır, `KankaChat.aab` dosyasını indir.
4. Play Console › Uygulama oluştur: ad **Kanka Chat: Sesli Sohbet**, dil Türkçe, Uygulama, Ücretsiz.
5. **Play App Signing** açık kalsın (varsayılan). Kurulumdan sonra Play Console › Test ve yayınla › Uygulama bütünlüğü › Uygulama imzalama sayfasındaki **Uygulama imzalama anahtarı SHA-256** değerini sunucuda `ANDROID_SHA256` ortam değişkenine yaz (kendi yükleme anahtarının parmak izini de virgülle ekleyebilirsin). Yoksa kankahq.com linkleri uygulamada açılmaz.
6. **Kapalı test (yeni kişisel hesapsa zorunlu):** Kapalı test kanalına `.aab` yükle, en az **12 test kullanıcısı** ekle, bu kişiler uygulamayı **kesintisiz 14 gün** yüklü tutsun. Bu süre dolmadan "Üretime erişim başvurusu" düğmesi açılmaz. Kurumsal (şirket) hesabın varsa bu kural yok.
7. **Satış hesabı:** Play Console › Ayarlar › Ödeme profili oluştur (banka hesabı, vergi bilgileri). Yoksa abonelik oluşturamazsın.
8. **Abonelik ürünü:** Play Console › Para kazanma › Ürünler › Abonelikler › Abonelik oluştur. Ürün kimliği tam olarak **`kanka_spark`** (değiştirme, kodda bu). Ad: Kanka Spark. Temel plan: kimlik `aylik`, **otomatik yenilenen, 1 ay**, fiyatı gir, etkinleştir. Ücretsiz deneme istersen temel plana teklif olarak ekle; uygulama Google'ın gösterdiği teklifi kendisi yazar.
9. **Sunucu doğrulaması:** console.cloud.google.com'da *Google Play Android Developer API*'yi aç, hizmet hesabı oluştur, JSON anahtarını indir. Play Console › Kullanıcılar ve izinler › bu e-postayı davet et (Finansal verileri görüntüle, Siparişleri ve abonelikleri yönet). JSON'u Kanka Yönetim paneli › Mobil › **Google Play satın alma doğrulaması**'ndan yükle. Yüklemeden "Abone ol" düğmesi görünmez. İznin işlemesi birkaç saat sürebilir.
10. **Gerçek zamanlı bildirimler (yenileme, iptal, iade):** Google Cloud › Pub/Sub › konu oluştur (`kanka-play`), `google-play-developer-notifications@system.gserviceaccount.com` hesabına konuda *Pub/Sub Publisher* rolü ver. Konuya **push** aboneliği ekle, adres olarak Yönetim panelinde gösterilen `https://kankahq.com/play/rtdn?k=…` adresini gir. Play Console › Para kazanma kurulumu › Gerçek zamanlı geliştirici bildirimleri › konu adını gir, "Test bildirimi gönder". Bildirim kurulmasa da sunucu 30 dakikada bir yoklar, ama iade ve iptaller geç işlenir.
11. **Deneme:** Play Console › Ayarlar › Lisans testi › kendi Gmail'ini ekle. Kapalı testten yüklediğin uygulamada Spark › Abone ol: test kartıyla ücret alınmaz, aylık abonelik 5 dakikada yenilenir. Spark açılıyor mu, Yönetim panelinde "aktif Play abonesi" artıyor mu, iptal edince dönem sonunda kapanıyor mu bak.
12. Aşağıdaki bölümleri doldur, sonra üretime gönder.

## 2. Uygulama içeriği (Politika › Uygulama içeriği)

| Bölüm | Cevap |
|---|---|
| Gizlilik politikası | `https://kankahq.com/gizlilik` |
| Uygulama erişimi | "Tüm işlevler veya bazıları kısıtlı" → 4. bölümdeki demo hesaplar ve talimat |
| Reklamlar | Hayır, uygulamada reklam yok |
| Uygulama içi satın alma | Evet (Kanka Spark aboneliği, Google Play Faturalandırma). Mağaza sayfasında "Uygulama içi satın alma içerir" yazar |
| İçerik derecelendirmesi | 5. bölüm |
| Hedef kitle | **16-17, 18 ve üzeri** (uygulama 15 yaş ve üzeri; Play'in 13-15 grubunu işaretleme, 15 yaş altı yasal olarak kapalı). 13 yaş altını işaretleme (işaretlersen Aileler politikası devreye girer). "Uygulama çocuklara hitap ediyor mu?" → Hayır |
| Veri güvenliği | 3. bölüm |
| Hesap silme | Uygulama içi: Ayarlar › Hesap › Hesabı sil. Web URL: `https://kankahq.com/hesap-silme` |
| Haber uygulaması | Hayır |
| Devlet uygulaması | Hayır |
| Finansal özellikler | Hiçbiri |
| Sağlık | Hiçbiri |
| Ön plan hizmetleri | **Mikrofon** (`microphone`): "Kullanıcı sesli odaya ya da aramaya katıldığında, uygulama arka plandayken veya ekran kapalıyken konuşmanın kesilmemesi için. Kullanıcı sesten ayrılınca hizmet durur." Play kısa bir video ister: sesli odaya gir, ana ekrana dön, bildirimde "Sesli odadasın" görünsün, konuşma devam etsin. Ekran kaydıyla çek, YouTube'a liste dışı yükle, linki ver |
| Tüccar (trader) durumu | Satış yapmıyorsun. AB/İngiltere için "Tüccar değilim" seçeneği uygunsa onu seç, şirket olarak satış yapacaksan tüccar bilgilerini gir (son tarih 1 Şubat 2027) |

## 3. Veri güvenliği (Data Safety) cevapları

Genel sorular: Veri topluyor musunuz → **Evet**. Aktarımda şifreleniyor mu → **Evet** (HTTPS/WSS). Kullanıcı silme isteyebilir mi → **Evet** (`https://kankahq.com/hesap-silme`). Veri paylaşımı (üçüncü taraflara) → **Hayır** (Firebase bildirim ve Google STUN, hizmet sağlayıcı aktarımı sayılır, paylaşım değildir).

| Veri türü (Play) | Toplanıyor | İsteğe bağlı mı | Amaç |
|---|---|---|---|
| Kişisel bilgiler › Ad (görünen ad) | Evet | Zorunlu | Uygulama işlevi, Hesap yönetimi |
| Kişisel bilgiler › E-posta adresi | Evet | Zorunlu | Hesap yönetimi, Güvenlik |
| Kişisel bilgiler › Kullanıcı kimlikleri (kullanıcı adı) | Evet | Zorunlu | Uygulama işlevi, Hesap yönetimi |
| Kişisel bilgiler › Diğer (doğum tarihi, veli onayı) | Evet | Zorunlu | Uygulama işlevi (yaş sınırı), Güvenlik |
| Mesajlar › Diğer uygulama içi mesajlar | Evet | Zorunlu | Uygulama işlevi |
| Fotoğraflar ve videolar › Fotoğraflar | Evet | İsteğe bağlı | Uygulama işlevi |
| Ses dosyaları › Ses kayıtları (sesli mesaj) | Evet | İsteğe bağlı | Uygulama işlevi |
| Dosyalar ve belgeler | Evet | İsteğe bağlı | Uygulama işlevi |
| Finansal bilgiler › Satın alma geçmişi (Spark aboneliği durumu) | Evet | İsteğe bağlı | Uygulama işlevi |
| Uygulama etkinliği › Uygulama etkileşimleri (seviye, seri, istatistik) | Evet | Zorunlu | Uygulama işlevi, Analiz |
| Uygulama etkinliği › Kullanıcı tarafından oluşturulan diğer içerik (profil, sunucu içeriği) | Evet | İsteğe bağlı | Uygulama işlevi |
| Cihaz veya diğer kimlikler (bildirim anahtarı, cihaz özeti) | Evet | Zorunlu | Uygulama işlevi, Güvenlik (yasak atlatmayı önleme) |

Toplanmayanlar: konum, kişiler, takvim, ödeme/kart bilgisi (Google alır), sağlık, web geçmişi, yüklü uygulamalar, çökme kayıtları, reklam kimliği.

Sesli odadaki canlı ses toplanmaz (kaydedilmez, sadece diğer katılımcılara iletilir), bu yüzden "Ses kayıtları" sadece sesli mesaj içindir. Bu tablo `kankahq.com/gizlilik` ve iOS gizlilik etiketleriyle (`APP-STORE-CONNECT.md` 6. bölüm) aynı olmalı; biri değişirse hepsini güncelle.

## 4. Uygulama erişimi (demo hesap)

Yönetim paneli › Mobil › **İnceleme hesaplarını hazırla** düğmesi iki mağaza için aynı hesapları kurar. App Store için zaten bastıysan tekrar basma (şifreler yenilenir), aynı şifreleri kullan. Talimat (İngilizce):

```
Kanka Chat is a Turkish-language community and voice chat app. Registration is invite-only during beta, so please use these accounts (no 2FA):
  Account 1: appleinceleme / <şifre>
  Account 2: appleinceleme2 / <şifre>
Sign in with Account 1 on the device and Account 2 on the web at https://kankahq.com/app to test messages, voice rooms and calls between them.
Report: long-press a message or open a profile -> "Şikayet et". Block: profile -> "Engelle".
Delete account: "Sen" tab -> Hesap -> "Hesabı sil". Web: https://kankahq.com/hesap-silme
Optional subscription (Kanka Spark, Google Play Billing): "Mesajlar" tab -> "Spark" in the list. Benefits: Spark badge, 2 Energy per month that can be given to servers to unlock more emoji/soundboard slots, studio audio and a custom invite link. Manage/cancel button opens Google Play subscriptions.
No ads.
```

İnceleme süresince (birkaç gün) sunucu açık kalsın, büyük güncelleme yapma.

## 5. İçerik derecelendirmesi (IARC anketi)

Kategori: **Sosyal / İletişim**. Şiddet, cinsellik, küfür, uyuşturucu, kumar, korku: **Hayır**. Kullanıcılar etkileşime giriyor mu / içerik paylaşıyor mu: **Evet**. Kullanıcının konumu paylaşılıyor mu: **Hayır**. Dijital ürün satın alma: **Evet** (isteğe bağlı abonelik). Kısıtlamasız internet erişimi: **Hayır**. Beklenen sonuç: PEGI 12 / USK 12 civarı ve "Kullanıcı etkileşimi" uyarısı. Bu normal.

## 6. Mağaza girişi

Metinler: `fastlane/metadata/android/tr-TR` (başlık 24/30, kısa açıklama 74/80 karakter, tam açıklama). Gerekenler:

- Uygulama simgesi 512×512 PNG
- Öne çıkan grafik 1024×500
- En az 2 telefon ekran görüntüsü (en iyisi 4-8), **giriş ekranı değil**, uygulama kullanılırken: sunucu ve oda listesi, mesajlaşma, sesli oda, bildirimler sekmesi, özel mesaj
- İletişim e-postası `kankahq1@gmail.com`, web sitesi `https://kankahq.com`
- Kategori: İletişim (ya da Sosyal)

Açıklamada sadece uygulamanın gerçekten yaptığı şeyler var. Android'de gelen arama telefonun arama ekranında çalmadığı için o satır Android metninden çıkarıldı.

## 7. Ret gelirse

Google'ın e-postasındaki politika adını ve metnini olduğu gibi Claude'a ver. Aynı derlemeyi değiştirmeden tekrar gönderme, hesap askıya alınmaya yaklaşır.
