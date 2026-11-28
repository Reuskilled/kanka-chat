# Kanka tanıtım videoları (kaynak)

Her video tek bir HTML sahnesi: `setT(t)` o saniyenin karesini çizer, `MARKS` ses efektlerinin zamanlarını tutar.

```bash
npm i -g playwright            # + Google Chrome, ffmpeg, python3 numpy
node r.js p yk2 1.5 4 9        # önizleme kareleri → out/yk2-pv*.jpg
node r.js v yk2                # 1080×1920 30 fps video → out/yk2-v.mp4 + out/yk2-marks.json
python3 mix2.py out/yk2-marks.json out/yk2.wav          # müzik + efektler
ffmpeg -i out/yk2-v.mp4 -i out/yk2.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -shortest yorumlarla-kanka-2.mp4
```

- `rr-yorum.html` + `mixr.py`: Yorumlarla Kanka #1 (Rob Run)
- `yk2.html` + `mix2.py`: Yorumlarla Kanka #2 (telefon uygulaması)
- `rozet3.html` + `mixr3.py`: "Sende kaç tane var?" 16 rozet, 16 sn döngü (son kare = ilk kare, ses kuyrukları başa sarılır)
- `beta50.html` + `mixb50.py`: "Kendi Discord'umuzu yaptık" → Beta Tester rozeti için 50 yer kaldı (15 sn)
- `beta50s.html` + `mixb50s.py`: aynı videonun ElevenLabs seslendirmeli sürümü (22,5 sn). Sahne zamanları dosyanın başındaki sabitlerde; ses `sidechaincompress` ile müziğin üstüne bindirilir
- `k/` logo, `e2/` telefon uygulaması ekran görüntüleri, `f2/` eski web ekranları
- #1'in `rr/` ekran görüntüleri büyük olduğu için repoda yok.
