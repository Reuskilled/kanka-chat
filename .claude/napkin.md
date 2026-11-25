# Napkin Runbook

## Curation Rules
- Re-prioritize on every read.
- Keep recurring, high-value notes only.
- Max 10 items per category.
- Each item includes date + "Do instead".

## Deploy & Canlı (Highest Priority)
1. **[2026-11-25] VDS güncelleyicisi sadece `server.js`, `package*.json` ve `public/` kopyalar**
   Do instead: sunucunun okuyacağı her dosyayı `public/` altına koy (ör. `public/degisiklik-gunlugu.json`); depo köküne koyduğun dosya canlıya hiç gitmez.
2. **[2026-11-25] Sunucu yeniden başlatması gecikir: son commit'ten 90 sn sessizlik, seste biri varsa en fazla 4 dk**
   Do instead: peş peşe küçük commit atma, işleri toplayıp tek seferde gönder; kullanıcıya "birkaç dakika sürebilir" de. `public/` dosyaları ise beklemeden canlıya geçer.
3. **[2026-11-25] `public/index.html` değişince tarayıcı eski sürümü önbellekten verir**
   Do instead: her ekran değişikliğinde `public/sw.js` içindeki `kanka-vNNN` sayısını bir artır.
4. **[2026-11-25] kankahq.com bu ortamdan erişilemez (curl/WebFetch)**
   Do instead: canlıyı kontrol etmeyi kullanıcıdan iste; kendin yerel test sunucusunda doğrula.
5. **[2026-11-25] Gönderme akışı**
   Do instead: `git fetch -q origin main && git stash -q && git rebase -q FETCH_HEAD && git stash pop -q`, sonra commit ve `git push -q origin HEAD:main`; `git ls-remote origin main` ile doğrula (`origin/main` referansı yerelde olmayabilir).
6. **[2026-11-25] GitHub Actions ödeme nedeniyle kilitli (masaüstü ve Android derlemesi çalışmaz)**
   Do instead: iOS ve Android derlemesi için `codemagic.yaml` (ios-testflight, android-apk) kullan.

## Yerel Test
1. **[2026-11-25] Test sunucusu**
   Do instead: `pkill -f "^node server.js"; rm -rf /tmp/kt9X && cp -r /tmp/kt9 /tmp/kt9X && (PORT=3313 DATA_DIR=/tmp/kt9X nohup node server.js > /tmp/srv.log 2>&1 &)`; uygulama `/app` altında. Kullanıcılar sahip / uye / ucuncu (sifre123), sunucu `2fc1550663` (yazı `7fc1781bb8`, ses `6a69805a1b`). `/tmp/kt9` yoksa yeni veriyle kendin kur.
2. **[2026-11-25] Bot API testlerinde hız sınırı 429 verir**
   Do instead: test istekleri arasına ~110 ms bekleme koy.
3. **[2026-11-25] Playwright'ta açılış pencereleri (e2ee notu, güncelleme, seviye) ekranı kapatır**
   Do instead: ekran görüntüsünden önce `closeModal()` çağır, `.toast,#embar,#updbar` öğelerini kaldır, `has-eb` sınıfını sil; Chrome yolu `/usr/bin/google-chrome`, `NODE_PATH=$(npm root -g)`.
4. **[2026-11-25] Mesajın üstünde sağa kaydırmak yanıt verir, çekmeceyi açmaz**
   Do instead: kaydırma testini mesaj satırı olmayan boş alandan başlat.
5. **[2026-11-25] `history` socket olayı sadece sayfalama yapar**
   Do instead: ilk mesajları `join` cevabından al; kayıtlı veriyi doğrulamak için `mesajlar.db` (tablo `kanal`) oku.

## Kod Tuzakları
1. **[2026-11-25] Mobil uygulama (Capacitor) kankahq.com/app'i yükleyen bir kabuk**
   Do instead: arayüz değişikliği yeni APK gerektirmez; sadece yerel eklenti/izin değişince yeni derleme iste. Uygulama görünümü `html.mapp` (Capacitor, ana ekran, `?uygulama=1`).
2. **[2026-11-25] Android'de Firebase (google-services.json) yoksa bildirim kaydı uygulamayı çökertir**
   Do instead: bildirim sorununda önce FCM kurulumunu (panel › Mobil, Codemagic `GOOGLE_SERVICES_JSON`) kontrol et; kod genelde suçlu değil.
3. **[2026-11-25] Herkese yayın yapan olaylar (users, presence, servers) sunucuyu yorar**
   Do instead: değişeni gönder (`pushUsers`, `pushPresence` farkları), toplayarak gönder, çevrimdışı kişi için hesaplama yapma (`io.sockets.adapter.rooms.has('user:'+n)`).
4. **[2026-11-25] Bot API değişikliği üç yeri birden ilgilendirir**
   Do instead: `public/sdk/kanka.js` + `kanka.py` sürümünü artır, `public/gelistirici.html` belgesini güncelle, `public/degisiklik-gunlugu.json`'a kayıt ekle (sadece bot geliştirmeleri).
5. **[2026-11-25] Kart (embed) metinleri farklı CSS sınıflarında**
   Do instead: `.bubble` için yapılan stil/etiket düzeltmesini `.aembed` (bot kartı) ve `.bembed` (Kanka Bot kartı) için de uygula.

## Video Hattı
1. **[2026-11-25] ElevenLabs dosya sunucusu engelli, ücretsiz kredi ayda 10.000 karakter**
   Do instead: seslendirmeyi kullanıcı indirip yükler; önce `account_get_usage` ile krediye bak, tek deneme (`generations_count: 1`) iste.
2. **[2026-11-25] Seslendirme tahminden farklı uzunlukta gelir**
   Do instead: `silencedetect` ile cümleleri ayır, gerekirse librosa DTW ile tekrar eden ifadeleri eşleştir; sesi kesmek yerine sahne sınırlarını (`B` dizisi) sese göre yeniden kur. Altyapı: `/tmp/vt` (`r.js p|v`, `mixb.py`, `final.sh`).
3. **[2026-11-25] Videoda başka markanın logosu kullanılmaz, iOS uygulaması henüz mağazada yok**
   Do instead: marka adını sadece yazı olarak geç; cihaz etiketlerinde "Android", "Windows · Tarayıcı" yaz. Güncel olayları (Discord engeli vb.) önce ara, gün sayısını hesapla.

## User Directives
1. **[2026-11-25] Kullanıcıyla Türkçe konuş**
   Do instead: tüm cevaplar Türkçe; topluluk cevap taslakları küçük harfli, samimi.
2. **[2026-11-25] Soru sormadan doğrudan yap ("bana sorma", "direkt yap")**
   Do instead: makul varsayımla başla, varsayımı cevapta tek cümleyle belirt; sadece geri alınamaz işlerde dur.
3. **[2026-11-25] Topluluk geri bildiriminde önce kodda kontrol et**
   Do instead: istenen özellik zaten varsa (ör. Bot API 1.5) bunu söyle ve ilgili kullanımı göster; gerçekten eksik olanı ekle, test et, gönder.
