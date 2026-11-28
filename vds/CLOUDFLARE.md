# Kanka'yı Cloudflare arkasına almak (DDoS koruması)

Kod hazır: sunucu, Cloudflare'den gelen bağlantılarda gerçek kullanıcı IP'sini `CF-Connecting-IP` başlığından okur.
Bu başlığa sadece bağlantı gerçekten Cloudflare'in IP aralığından geliyorsa güvenir. Bu yüzden IP başına limitler
(giriş denemesi, bağlantı sınırı, kayıt) Cloudflare'e geçince de doğru çalışır.

## 1. Alan adını Cloudflare'e ekle (ücretsiz plan yeterli)
1. dash.cloudflare.com → Add a site → `kankahq.com` → Free.
2. Cloudflare'in verdiği iki nameserver'ı alan adını aldığın yerde (registrar) eskilerin yerine yaz. Geçiş birkaç saat sürebilir.
3. DNS kayıtları:
   - `kankahq.com` A → sunucu IP'si → **turuncu bulut (Proxied)**
   - `www` CNAME → `kankahq.com` → **Proxied**
   - Sesli sohbet (TURN) için ayrı bir kayıt gerekiyorsa (ör. `turn.kankahq.com`) → **gri bulut (DNS only)**.
     Cloudflare'in ücretsiz planı UDP taşımaz.

## 2. Cloudflare ayarları
- SSL/TLS → **Full (strict)**. Caddy'nin sertifikası olduğu gibi kalır.
- SSL/TLS → Edge Certificates → Always Use HTTPS: açık.
- Network → **WebSockets: açık** (varsayılan açık).
- Security → Settings → Security level: Medium. Saldırı anında **"I'm under attack"** modu tek tıkla açılır.
- Security → WAF → Rate limiting rules (ücretsiz planda 1 kural):
  `URI Path eq /api/dosya` ya da genel bir kural, örneğin "aynı IP 10 saniyede 100 istekten fazla → Block 10 sn".
  Socket.IO yolunu (`/socket.io/`) bu kurala katma. Uygulama kendi sınırlarını zaten uyguluyor.
- Notifications → **HTTP DDoS Attack Alert**: açık (saldırı olunca e-posta gelir).

## 3. Sunucu IP'sini gizle (önemli)
Cloudflare sadece saldırgan gerçek IP'yi bilmiyorsa işe yarar.
- Şu anki IP; DNS'te, git geçmişinde ve DNS geçmişi tutan sitelerde görünüyor. Mümkünse sağlayıcıdan
  **yeni bir IP** al, DNS'te sadece Cloudflare'e yaz, hiçbir yerde paylaşma.
- Site Cloudflare üzerinden sorunsuz açıldıktan sonra yönetici PowerShell'de `cloudflare-kilit.ps1` çalıştır.
  Bu betik 80/443 portlarını sadece Cloudflare'e açar. Geri almak için betiği `-GeriAl` ile çalıştırman yeterli.
- **Sesli sohbet sunucusu (TURN)** IP'yi her zaman gösterir, çünkü kullanıcılar ona doğrudan bağlanır. Saldırı bu IP'ye
  gelirse sadece ses etkilenir, site ayakta kalır. Asıl çözüm TURN'ü **ayrı, ucuz bir sunucuya** taşımak.

## 4. Hukuki not (KVKK)
Cloudflare trafiği yurt dışında işler ve şifreli trafiği açıp tekrar şifreler (IP adresleri ve istek içerikleri onun
sunucularından geçer). Bu, KVKK m.9 kapsamında **yurt dışına veri aktarımı** sayılır. Gerekenler:
- Cloudflare ile standart sözleşme (veri sorumlusundan veri işleyene) yapılması ve imzadan sonra **5 iş günü
  içinde** KVKK'ya bildirilmesi.
- Gizlilik politikasına Cloudflare'in eklenmesi.

Bunu avukatla birlikte yap. Alternatif olarak, DDoS korumasını içinde veren Türkiye'deki bir sağlayıcıya (VDS) geçmek de
mümkün; o durumda yurt dışına aktarım olmaz.
