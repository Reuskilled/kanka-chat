// kanka.js — Kanka Chat bot kütüphanesi (Node.js 18+)
// Belgeler: https://kankahq.com/gelistirici
//
//   const { Kanka } = require('./kanka.js');
//   const bot = new Kanka({ token: process.env.KANKA_TOKEN, durum: { durum: 'cevrimici', aktivite: { tur: 'oynuyor', ad: '/yardim' } } });
//   bot.komut('zar', { aciklama: 'Zar at' }, k => k.cevapla(`🎲 ${1 + Math.floor(Math.random() * 6)}`));
//   bot.baglan();
'use strict';
const SURUM = '1.9.0';
const EventEmitter = require('events');

class KankaHata extends Error { constructor(mesaj, durum, veri) { super(mesaj); this.name = 'KankaHata'; this.durum = durum; this.veri = veri; } }
const uyu = ms => new Promise(r => setTimeout(r, ms));
const govde = x => typeof x === 'string' ? { icerik: x } : x instanceof Kart ? { kartlar: [x] } : (x || {});
const kod = encodeURIComponent;

class Kanka extends EventEmitter {
  /**
   * @param {object} ayar
   * @param {string} ayar.token  Geliştirici Portalı'ndan aldığın bot token'ı
   * @param {string[]} [ayar.niyetler]  'mesajlar', 'icerik', 'uyeler', 'tepkiler', 'dm', 'ses' (sesli oda olayları)
   * @param {string} [ayar.adres]  Varsayılan https://kankahq.com
   * @param {object} [ayar.durum]  Bağlanınca ayarlanacak durum: { durum: 'cevrimici'|'bosta'|'rahatsizetme'|'gorunmez', yazi, aktivite: { tur: 'oynuyor'|'dinliyor'|'izliyor'|'yayinda'|'yarisiyor', ad } }
   * @param {boolean} [ayar.hataAyikla]  true ise bağlantı olaylarını konsola yazar
   */
  constructor({ token, niyetler = ['mesajlar', 'uyeler', 'tepkiler', 'dm'], adres = 'https://kankahq.com', kayit = true, durum = null, hataAyikla = false } = {}) {
    super();
    if (!token) throw new KankaHata('token gerekli (Geliştirici Portalı › botun › Token)');
    this.token = String(token).replace(/^Bot\s+/i, ''); this.niyetler = niyetler; this.adres = adres.replace(/\/$/, ''); this.kayit = kayit;
    this.komutlar = new Map(); this.sunucuKomutlari = new Map(); this.butonlar = []; this.secimler = []; this.formlar = [];
    this.ben = null; this.sunucular = new Map(); this._oturum = null; this._sira = 0; this._ws = null; this._kapat = false; this._deneme = 0;
    this._durum = durum; this._hd = !!hataAyikla; this._bekleyenler = new Set();
  }
  _log(...x) { if (this._hd) console.log('[kanka]', ...x); }
  // ---------- REST ----------
  async api(yontem, yol, veri) {
    for (let deneme = 0; deneme < 6; deneme++) {
      let r;
      // Sunucu güncellenirken birkaç saniye cevap vermez (502/503 ya da bağlantı hatası): bekleyip tekrar dene
      try { r = await fetch(this.adres + '/api/v1' + yol, { method: yontem, headers: { Authorization: 'Bot ' + this.token, 'Content-Type': 'application/json', 'User-Agent': 'kanka.js/' + SURUM }, body: veri === undefined ? undefined : JSON.stringify(veri) });
      } catch (e) { if (deneme < 5) { await uyu(1500 * (deneme + 1)); continue; } throw e; }
      if ([502, 503, 504].includes(r.status) && deneme < 5) { await uyu(1500 * (deneme + 1)); continue; }
      const j = await r.json().catch(() => null);
      if (r.status === 429) { await uyu(((j && j.tekrarDene) || 1) * 1000 + 100); continue; }
      if (!r.ok) throw new KankaHata((j && j.hata) || `HTTP ${r.status}`, r.status, j);
      return j;
    }
    throw new KankaHata('Hız sınırı: istek tekrar tekrar reddedildi', 429);
  }
  /**
   * Mesaj içindeki dosyaları önce yükler: { dosyalar: ['./kart.png'] } ya da { dosyalar: [{ ad: 'kart.png', veri: buffer }] }.
   * Kartta resim: 'attachment://kart.png' yazman yeter (karşılama kartı vb.).
   */
  async _dosyalar(g) {
    const d = g && (g.dosyalar || g.files); if (!d || !(Array.isArray(d) ? d.length : true)) return g;
    const ids = [].concat(g.ekler || []);
    for (const x of [].concat(d)) {
      let veri = Buffer.isBuffer(x) || typeof x === 'string' ? x : (x.veri ?? x.data ?? x.attachment), ad = x.ad ?? x.name;
      if (typeof veri === 'string') { ad ||= require('path').basename(veri); veri = require('fs').readFileSync(veri); }
      if (!Buffer.isBuffer(veri)) veri = Buffer.from(veri);
      ids.push((await this.dosyaYukle(veri, ad || 'dosya.png')).id);
    }
    const out = { ...g, ekler: ids }; delete out.dosyalar; delete out.files; return out;
  }
  gonder(oda, icerik) { return this._dosyalar(govde(icerik)).then(g => this.api('POST', `/odalar/${oda}/mesajlar`, g)).then(r => { if (r.uyari) { this.emit('uyari', r.uyari); if (!this.listenerCount('uyari')) console.warn('[kanka] uyarı:', r.uyari); } return this._mesaj(r.mesaj); }); }
  // Ham gövdeli istek (dosya, emoji)
  async _ham(yontem, yol, veri, basliklar = {}) {
    const r = await fetch(this.adres + '/api/v1' + yol, { method: yontem, headers: { Authorization: 'Bot ' + this.token, 'Content-Type': 'application/octet-stream', 'User-Agent': 'kanka.js/' + SURUM, ...basliklar }, body: veri });
    const j = await r.json().catch(() => null); if (!r.ok) throw new KankaHata((j && j.hata) || `HTTP ${r.status}`, r.status, j); return j;
  }
  /** Dosya yükle (Buffer). Dönen id'yi mesajda kullan: bot.gonder(oda, { icerik: 'al', ekler: [d.id] }) */
  dosyaYukle(veri, ad = 'dosya') { return this._ham('POST', '/dosyalar', veri, { 'X-Dosya-Adi': encodeURIComponent(ad) }); }
  /** Botun kendi emojisi: mesajda :ad: yazınca her yerde görünür (en fazla 50) */
  emojiYukle(ad, veri) { return this._ham('PUT', `/emojiler/${encodeURIComponent(ad)}`, veri); }
  emojiSil(ad) { return this.api('DELETE', `/emojiler/${encodeURIComponent(ad)}`); }
  emojiler() { return this.api('GET', '/emojiler').then(r => r.emojiler); }
  /** Odada "yazıyor…" göster (yaklaşık 8 sn) */
  yaziyor(oda) { return this.api('POST', `/odalar/${oda}/yaziyor`); }
  // ---------- Durum ----------
  /**
   * Botun durumu. bot.durum('rahatsizetme') · bot.durum('cevrimici', 'Yardım: /yardim') · bot.durum({ durum: 'bosta', aktivite: { tur: 'dinliyor', ad: 'Spotify' } })
   * durum: 'cevrimici' | 'bosta' | 'rahatsizetme' | 'gorunmez' (Türkçe harfle ya da 'online', 'idle', 'dnd' de olur)
   * Hemen uygulanır; bağlantı kopup yeniden gelince de korunur (bağlanırken tekrar gönderilir).
   */
  async durum(durum, yazi) {
    const d = durum && typeof durum === 'object' ? { ...durum } : { ...(durum ? { durum } : {}), ...(yazi !== undefined ? { yazi } : {}) };
    this._durum = { ...(this._durum || {}), ...d };
    return this.api('PATCH', '/ben/durum', d);
  }
  /** Etkinlik: bot.aktivite('oynuyor', 'Minecraft') → "Oynuyor: Minecraft". tur: oynuyor | dinliyor | izliyor | yayinda | yarisiyor | ozel */
  aktivite(tur, ad) { return this.durum({ aktivite: { tur, ad } }); }
  durumuGetir() { return this.api('GET', '/ben/durum'); }
  // ---------- Bilgi ----------
  bilgi() { return this.api('GET', '/ben'); }
  sunucuListesi() { return this.api('GET', '/sunucular').then(r => { for (const s of r.sunucular) this.sunucular.set(s.id, s); return r.sunucular; }); }
  sunucu(id) { return this.api('GET', `/sunucular/${id}`).then(s => { this.sunucular.set(s.id, s); return s; }); }
  uye(sunucu, kisi) { return this.api('GET', `/sunucular/${sunucu}/uyeler/${kod(kisi)}`); }
  oda(id) { return this.api('GET', `/odalar/${kod(id)}`); }
  // Oda yönetimi (botun "manageChannels" izni gerekir). tur: 'text' | 'voice' | 'stage' | 'forum'
  /** Botu sunucuya ekleme linki (Portal'daki linkle aynı). izinler: ['manageMessages', 'kick', ...] */
  eklemeLinki(izinler = []) { if (!this.ben) throw new Error('Önce bağlan: eklemeLinki "hazir" olayından sonra kullanılabilir'); const l = this.ben.eklemeLinki || `${this.adres}/bot-ekle/${this.ben.id}`; return izinler.length ? `${l}?izin=${izinler.join(',')}` : l; }
  odalar(sunucu) { return this.api('GET', `/sunucular/${kod(sunucu)}/odalar`); }
  odaOlustur(sunucu, ayar = {}) { if (typeof ayar === 'string') ayar = { ad: ayar }; return this.api('POST', `/sunucular/${kod(sunucu)}/odalar`, ayar); }
  odaDuzenle(oda, ayar = {}) { return this.api('PATCH', `/odalar/${kod(oda)}`, ayar); }
  odaSil(oda) { return this.api('DELETE', `/odalar/${kod(oda)}`); }
  /** Kategori aç. ayar string ise sadece ad. Gizli kategori: bot.kategoriOlustur(sunucu, { ad: 'Talepler', gizli: true, roller: [yetkiliRolId] }) */
  kategoriOlustur(sunucu, ayar) { return this.api('POST', `/sunucular/${kod(sunucu)}/kategoriler`, typeof ayar === 'string' ? { ad: ayar } : ayar); }
  /** Sunucudaki kategoriler: [{ id, ad, ozel, izinAyarlari, odalar }] */
  kategoriler(sunucu) { return this.api('GET', `/sunucular/${kod(sunucu)}/kategoriler`).then(r => r.kategoriler); }
  kategoriAdi(sunucu, kategori, ad) { return this.api('PATCH', `/sunucular/${kod(sunucu)}/kategoriler/${kod(kategori)}`, { ad }); }
  /** Kategori izni: kategoriyle eşitlenmiş odalar da uyar. bot.kategoriIzni(sunucu, kat, 'herkes', { view: false }) */
  kategoriIzni(sunucu, kategori, hedef, izinler) { return this.api('PUT', `/sunucular/${kod(sunucu)}/kategoriler/${kod(kategori)}/izinler/${kod(hedef)}`, izinler); }
  kategoriIzniKaldir(sunucu, kategori, hedef) { return this.api('DELETE', `/sunucular/${kod(sunucu)}/kategoriler/${kod(kategori)}/izinler/${kod(hedef)}`); }
  kategoriSil(sunucu, kategori) { return this.api('DELETE', `/sunucular/${kod(sunucu)}/kategoriler/${kod(kategori)}`); }
  /**
   * Rol aç: botun rolünün hemen altına eklenir. Bot sadece kendinde olan izinleri verebilir ("manageRoles" gerekir).
   * bot.rolOlustur(sunucu, { ad: 'Bildirim', renk: '#ff4655', izinler: [], etiketlenebilir: true, ayriGoster: false, simge: '🔔' })
   */
  rolOlustur(sunucu, ayar) { return this.api('POST', `/sunucular/${kod(sunucu)}/roller`, ayar); }
  rolDuzenle(sunucu, rol, ayar) { return this.api('PATCH', `/sunucular/${kod(sunucu)}/roller/${kod(rol)}`, ayar); }
  rolSil(sunucu, rol) { return this.api('DELETE', `/sunucular/${kod(sunucu)}/roller/${kod(rol)}`); }
  mesaj(oda, id) { return this.api('GET', `/odalar/${kod(oda)}/mesajlar/${id}`).then(m => this._mesaj(m)); }
  /** Kullanıcı bilgisi: ad ya da sayısal kimlik */
  kullanici(adVeyaId) { return this.api('GET', `/kullanicilar/${kod(adVeyaId)}`); }
  dm(kullanici, icerik) { return this._dosyalar(govde(icerik)).then(g => this.api('POST', `/kullanicilar/${encodeURIComponent(kullanici)}/dm`, g)).then(r => this._mesaj(r.mesaj)); }
  duzenle(oda, mesaj, icerik) { return this._dosyalar(govde(icerik)).then(g => this.api('PATCH', `/odalar/${oda}/mesajlar/${mesaj}`, g)); }
  sil(oda, mesaj) { return this.api('DELETE', `/odalar/${oda}/mesajlar/${mesaj}`); }
  tepki(oda, mesaj, emoji) { return this.api('PUT', `/odalar/${oda}/mesajlar/${mesaj}/tepkiler/${encodeURIComponent(emoji)}`); }
  tepkiKaldir(oda, mesaj, emoji) { return this.api('DELETE', `/odalar/${oda}/mesajlar/${mesaj}/tepkiler/${encodeURIComponent(emoji)}`); }
  sabitle(oda, mesaj) { return this.api('PUT', `/odalar/${oda}/sabitler/${mesaj}`); }
  sabitKaldir(oda, mesaj) { return this.api('DELETE', `/odalar/${oda}/sabitler/${mesaj}`); }
  sabitler(oda) { return this.api('GET', `/odalar/${oda}/sabitler`).then(r => r.mesajlar.map(m => this._mesaj(m))); }
  /**
   * Toplu sil (en fazla 100, son 14 gün). bot.topluSil(oda, 20) son 20 mesaj · bot.topluSil(oda, ['id1','id2'])
   * · bot.topluSil(oda, 50, { kisi: 'ahmet' }) sadece ahmet'in son 50 mesajı içinden. "Mesajları yönet" izni gerekir.
   */
  topluSil(oda, adetVeyaIdler, { kisi } = {}) { return this.api('POST', `/odalar/${oda}/mesajlar/toplu-sil`, { ...(Array.isArray(adetVeyaIdler) ? { mesajlar: adetVeyaIdler } : { adet: adetVeyaIdler }), ...(kisi ? { kisi } : {}) }).then(r => r.silinen); }
  mesajlar(oda, { limit = 50, once } = {}) { return this.api('GET', `/odalar/${oda}/mesajlar?limit=${limit}${once ? '&once=' + once : ''}`).then(r => r.mesajlar.map(m => this._mesaj(m))); }
  uyeler(sunucu) { return this.api('GET', `/sunucular/${sunucu}/uyeler`).then(r => r.uyeler); }
  /** Üye ara (ad ya da görünen ad): bot.uyeAra(sunucu, 'ahm') */
  uyeAra(sunucu, ara, limit = 25) { return this.api('GET', `/sunucular/${kod(sunucu)}/uyeler?ara=${kod(ara)}&limit=${limit}`).then(r => r.uyeler); }
  /** Kişinin yetkileri: { sahip, yonetici, izinler: [...], oda: { view, send, ... } } (oda verilirse o odadaki izinleri de gelir) */
  yetkiler(sunucu, kisi, oda) { return this.api('GET', `/sunucular/${kod(sunucu)}/uyeler/${kod(kisi)}/izinler${oda ? '?oda=' + kod(oda) : ''}`); }
  /** Kişinin bu yetkisi var mı? bot.yetkisiVar(sunucu, 'ali', 'kick') · oda izni için: bot.yetkisiVar(sunucu, 'ali', 'send', oda) */
  async yetkisiVar(sunucu, kisi, izin, oda) { const y = await this.yetkiler(sunucu, kisi, oda); if (oda && y.oda && izin in y.oda) return !!y.oda[izin]; return y.sahip || y.yonetici || y.izinler.includes(izin); }
  roller(sunucu) { return this.api('GET', `/sunucular/${kod(sunucu)}/roller`).then(r => r.roller); }
  /** Sunucunun Energy (boost) durumu: { toplam, seviye, gonderenler: [{ ad, adet }] } */
  energy(sunucu) { return this.api('GET', `/sunucular/${kod(sunucu)}/energy`); }
  /** Sesli odalarda kim var: { odalar: { odaId: [{ ad, mikKapali, sagir, kamera, yayin }] } } */
  ses(sunucu) { return this.api('GET', `/sunucular/${kod(sunucu)}/ses`).then(r => r.odalar); }
  /** Sesteki kişiyi yönet. islem: 'tasi' (oda gerekir) | 'cikar' | 'sustur' | 'ac' */
  sesIslem(sunucu, kisi, islem, oda) { return this.api('POST', `/sunucular/${kod(sunucu)}/uyeler/${kod(kisi)}/ses`, { islem, ...(oda ? { oda } : {}) }); }
  sesteTasi(sunucu, kisi, oda) { return this.sesIslem(sunucu, kisi, 'tasi', oda); }
  sestenCikar(sunucu, kisi) { return this.sesIslem(sunucu, kisi, 'cikar'); }
  /**
   * Oda izni ver/kapat (gizli oda, ticket odası). hedef: 'herkes' | rol id'si | kişi adı
   * bot.odaIzni(oda, 'herkes', { view: false }); bot.odaIzni(oda, 'ali', { view: true, send: true })
   * Değer null ise o izin "devral"a döner. "manageChannels" izni gerekir.
   */
  odaIzni(oda, hedef, izinler) { return this.api('PUT', `/odalar/${kod(oda)}/izinler/${kod(hedef)}`, izinler); }
  odaIzniKaldir(oda, hedef) { return this.api('DELETE', `/odalar/${kod(oda)}/izinler/${kod(hedef)}`); }
  /** Kalıcı gizli mesaj: odada sadece "kisi" görür, sayfa yenilense de kalır. Döner: { id, mesaj: { id, oda, icerik, kartlar, bilesenler, kisi, ... } } */
  ozelGonder(oda, kisi, icerik) { return this._dosyalar(govde(icerik)).then(g => this.api('POST', `/odalar/${kod(oda)}/ozel-mesajlar`, { ...g, kisi })); }
  /**
   * Talep (ticket) odası tek seferde: sadece kisiler, roller ve bot görür.
   * bot.talepOdasi(sunucu, { ad: 'talep-ali', kisiler: ['ali'], roller: [yetkiliRolId], kategori, konu })
   */
  talepOdasi(sunucu, ayar = {}) { return this.api('POST', `/sunucular/${kod(sunucu)}/odalar`, { tur: 'text', ozel: true, ...ayar }); }
  ozelDuzenle(oda, mesaj, icerik) { return this.api('PATCH', `/odalar/${kod(oda)}/ozel-mesajlar/${kod(mesaj)}`, govde(icerik)); }
  ozelSil(oda, mesaj) { return this.api('DELETE', `/odalar/${kod(oda)}/ozel-mesajlar/${kod(mesaj)}`); }
  rolVer(sunucu, kisi, rol) { return this.api('PUT', `/sunucular/${sunucu}/uyeler/${encodeURIComponent(kisi)}/roller/${rol}`); }
  rolAl(sunucu, kisi, rol) { return this.api('DELETE', `/sunucular/${sunucu}/uyeler/${encodeURIComponent(kisi)}/roller/${rol}`); }
  sustur(sunucu, kisi, dakika = 10, sebep = '') { return this.api('POST', `/sunucular/${sunucu}/uyeler/${encodeURIComponent(kisi)}/sustur`, { dakika, sebep }); }
  susturmaKaldir(sunucu, kisi) { return this.api('DELETE', `/sunucular/${sunucu}/uyeler/${encodeURIComponent(kisi)}/sustur`); }
  at(sunucu, kisi, sebep = '') { return this.api('DELETE', `/sunucular/${sunucu}/uyeler/${encodeURIComponent(kisi)}`, { sebep }); }
  yasakla(sunucu, kisi, sebep = '') { return this.api('PUT', `/sunucular/${sunucu}/yasaklar/${encodeURIComponent(kisi)}`, { sebep }); }
  yasakKaldir(sunucu, kisi) { return this.api('DELETE', `/sunucular/${sunucu}/yasaklar/${encodeURIComponent(kisi)}`); }
  yasaklar(sunucu) { return this.api('GET', `/sunucular/${sunucu}/yasaklar`).then(r => r.yasaklar); }
  // ---------- Ses (müzik botu vb.) ----------
  /**
   * Sesli odaya gir. Ses bottan kullanıcılara doğrudan gider (WebRTC); bilgisayarında ffmpeg ve `npm i werift` gerekir.
   *   const ses = await bot.sesliOdayaKatil(odaId);
   *   await ses.cal('sarki.mp3');            // dosya, https adresi ya da okunabilir akış
   *   ses.on('bitti', () => ...);            // şarkı bitince
   *   ses.siraya('a.mp3'); ses.siraya('b.mp3'); // sırayla çalar · ses.gec() sonrakine geçer
   * Botun bu odada "bağlanma" ve "konuşma" izni olmalı.
   */
  sesliOdayaKatil(oda) {
    if (!this._gonder || !this.ben) return Promise.reject(new KankaHata('Önce bağlan: sesliOdayaKatil "hazir" olayından sonra kullanılabilir'));
    werift(); // kurulu değilse hemen anlaşılır hata ver
    this._ses ||= new SesBaglantisi(this);
    const ses = this._ses; ses._istenen = oda;
    return new Promise((ok, no) => {
      const t = setTimeout(() => { this._sesBekle = null; no(new KankaHata('Sese girilemedi: zaman aşımı', 408)); }, 10000);
      this._sesBekle = { ok: x => { clearTimeout(t); ok(x); }, no: e => { clearTimeout(t); no(e); } };
      this._gonder({ op: 4, d: { oda } });
    });
  }
  /** Sesten çık (çalan şarkı durur) */
  sestenAyril() { if (this._ses) { this._ses.durdur(); this._ses._hepsiniKapat(); this._ses._istenen = null; this._ses.oda = null; } this._gonder && this._gonder({ op: 4, d: { oda: null } }); }
  // ---------- Yardımcılar ----------
  /**
   * Bir süre "yazıyor…" göster. İkinci değer: iş fonksiyonu, bir Promise ya da milisaniye.
   * await bot.yaziyorKen(oda, async () => { ...uzun iş... })  ·  await bot.yaziyorKen(oda, 3000)  ·  await bot.yaziyorKen(oda, fetch(url))
   */
  async yaziyorKen(oda, is) {
    const bekle = ms => new Promise(r => setTimeout(r, ms));
    this.yaziyor(oda).catch(() => {}); const t = setInterval(() => this.yaziyor(oda).catch(() => {}), 7000);
    try {
      if (typeof is === 'function') return await is();
      if (typeof is === 'number') return await bekle(Math.min(Math.max(is, 0), 120000));
      if (is && typeof is.then === 'function') return await is;
      return await bekle(3000);
    } finally { clearInterval(t); }
  }
  /**
   * Bir sonraki uygun mesajı bekle (oyunlar, sorular için). Süre dolarsa null döner.
   * const m = await bot.mesajBekle(m => m.oda === oda && m.yazar.ad === 'ahmet', { sure: 30000 })
   * Not: başkalarının mesaj içeriği yalnız DM'de, bot etiketlenince ya da içerik izni varsa gelir.
   */
  mesajBekle(filtre = () => true, { sure = 60000 } = {}) { return this._bekle('mesaj', filtre, sure); }
  /** Butona/seçime basılmasını bekle: const e = await bot.etkilesimBekle(e => e.veri.id === 'evet', { sure: 30000 }) */
  etkilesimBekle(filtre = () => true, { sure = 60000 } = {}) { return this._bekle('etkilesim', filtre, sure); }
  _bekle(olay, filtre, sure) {
    return new Promise(res => {
      const b = { olay, filtre, res, t: setTimeout(() => { this._bekleyenler.delete(b); res(null); }, sure) };
      this._bekleyenler.add(b);
    });
  }
  _bekleyeneVer(olay, x) {
    for (const b of this._bekleyenler) {
      if (b.olay !== olay) continue; let ok = false; try { ok = b.filtre(x); } catch {}
      if (ok) { clearTimeout(b.t); this._bekleyenler.delete(b); b.res(x); return true; }
    }
    return false;
  }
  // ---------- Komutlar ve bileşenler ----------
  /** Komut ekle. secenekler: [{ ad, tur: 'yazi'|'sayi'|'tamsayi'|'kisi'|'oda'|'rol'|'evethayir', aciklama, zorunlu, secimler: [{ ad, deger }] }] */
  komut(ad, ayar, isleyici) {
    if (typeof ayar === 'function') { isleyici = ayar; ayar = {}; }
    const k = { ad: String(ad).toLocaleLowerCase('tr'), aciklama: ayar.aciklama || ad, secenekler: ayar.secenekler || [] };
    if (ayar.sunucu) { const l = this.sunucuKomutlari.get(ayar.sunucu) || []; l.push(k); this.sunucuKomutlari.set(ayar.sunucu, l); }
    this.komutlar.set(k.ad, { tanim: k, isleyici, sunucu: ayar.sunucu || null }); return this;
  }
  buton(id, isleyici) { this.butonlar.push([id, isleyici]); return this; }
  secim(id, isleyici) { this.secimler.push([id, isleyici]); return this; }
  form(id, isleyici) { this.formlar.push([id, isleyici]); return this; }
  async komutlariKaydet() {
    await this.api('PUT', '/komutlar', [...this.komutlar.values()].filter(k => !k.sunucu).map(k => k.tanim));
    for (const [s, l] of this.sunucuKomutlari) await this.api('PUT', `/sunucular/${s}/komutlar`, l);
  }
  // ---------- Bağlantı (Gateway) ----------
  async baglan() {
    this._kapat = false;
    if (this.kayit && (this.komutlar.size)) await this.komutlariKaydet().catch(e => this.emit('hata', e));
    this._ac(); return this;
  }
  kapat() { this._kapat = true; clearInterval(this._nabiz); if (this._ses) { this._ses.yokEt(); this._ses = null; } try { this._ws && this._ws.close(); } catch {} }
  _ac() {
    const WS = globalThis.WebSocket || require('ws');
    const ws = this._ws = new WS(this.adres.replace(/^http/, 'ws') + '/bot/gateway');
    const gonder = o => { try { ws.send(JSON.stringify(o)); } catch {} }; this._gonder = gonder;
    const al = async veri => {
      let m; try { m = JSON.parse(typeof veri === 'string' ? veri : veri.data !== undefined ? veri.data : String(veri)); } catch { return; }
      if (m.op === 10) {
        clearInterval(this._nabiz); this._nabiz = setInterval(() => gonder({ op: 1, d: this._sira }), m.d.nabizAraligi || 30000);
        if (this._oturum) gonder({ op: 6, d: { token: this.token, oturum: this._oturum, sira: this._sira, niyetler: this.niyetler, ...(this._durum ? { durum: this._durum } : {}) } });
        else gonder({ op: 2, d: { token: this.token, niyetler: this.niyetler, ...(this._durum ? { durum: this._durum } : {}) } });
        this._log('bağlandı, kimlik gönderildi');
      }
      if (m.op === 0) { if (m.s) this._sira = m.s; if (m.t === 'DEVAM_EDILDI') this._deneme = 0; this._log('olay', m.t); this._olay(m.t, m.d).catch(e => this.emit('hata', e)); }
      if (m.op === 7) this._ilkBekle = (m.d && m.d.bekle) || 4000; // sunucu güncelleniyor: biraz bekleyip aynı oturumla dön
    };
    const kapandi = (kod, sebep) => {
      clearInterval(this._nabiz); if (this._kapat) return;
      if ([4004, 4014].includes(kod)) { this.emit('hata', new KankaHata(`Bağlantı reddedildi: ${sebep || kod}`, kod)); return; }
      // 1012 / op 7: sunucu güncelleniyor; birkaç saniye bekle. Diğer kopmalarda artan bekleme (en çok 15 sn) + küçük rastgelelik
      const bekle = this._ilkBekle || (kod === 1012 ? 4000 : Math.min(15000, 1000 * 2 ** this._deneme++)) + Math.floor(Math.random() * 500); this._ilkBekle = 0;
      this._log('koptu', kod, sebep, `${bekle} ms sonra yeniden bağlanılacak`);
      this.emit('koptu', { kod, sebep, bekle }); setTimeout(() => this._ac(), bekle);
    };
    if (ws.on) { ws.on('message', al); ws.on('close', (k, s) => kapandi(k, String(s || ''))); ws.on('error', e => this.emit('hata', e)); }
    else { ws.onmessage = al; ws.onclose = e => kapandi(e.code, e.reason); ws.onerror = () => {}; }
  }
  async _olay(t, d) {
    if (t === 'HAZIR' && this._ses && this._ses.oda) setTimeout(() => this._gonder({ op: 4, d: { oda: this._ses.oda } }), 500); // yeniden bağlanınca sese geri dön
    if (t === 'HAZIR') { this._oturum = d.oturum; this._deneme = 0; this.ben = d.bot; for (const s of d.sunucular) this.sunucular.set(s.id, s); if (!d.icerikIzni && this.niyetler.includes('icerik')) this.emit('uyari', 'Mesaj içeriği izni yok: sadece komutlar ve botun etiketlendiği mesajların içeriği gelir. Doğrulanan botlar için Kanka ekibi bu izni ayrıca verir.'); return this.emit('hazir', this); }
    if (t === 'DEVAM_EDILDI') { this._deneme = 0; if (this._ses && this._ses.oda) this._gonder({ op: 4, d: { oda: this._ses.oda } }); return this.emit('devam'); }
    if (t.startsWith('SES_') && t !== 'SES_DURUMU') return this._ses && this._ses._olay(t, d);
    if (t === 'HATA' && d && d.islem === 'ses' && this._sesBekle) { const b = this._sesBekle; this._sesBekle = null; return b.no(new KankaHata(d.hata || 'Sese girilemedi', 400, d)); }
    if (t === 'MESAJ_GELDI') { const m = this._mesaj(d); if (m.yazar && this.ben && m.yazar.ad === this.ben.ad) return; if (this._bekleyeneVer('mesaj', m)) return; return this.emit('mesaj', m); }
    if (t === 'DURUM_GUNCELLENDI') return this.emit('durum', d);
    if (t === 'HATA') return this.emit('hata', new KankaHata(d.hata || 'Sunucu hatası', 400, d));
    if (t === 'MESAJ_DUZENLENDI') return this.emit('mesajDuzenlendi', this._mesaj(d));
    if (t === 'MESAJ_SILINDI') return this.emit('mesajSilindi', d);
    if (t === 'UYE_KATILDI') return this.emit('uyeKatildi', d.uye, d.sunucu);
    if (t === 'UYE_AYRILDI') return this.emit('uyeAyrildi', d.uye, d.sunucu);
    if (t === 'UYE_GUNCELLENDI') return this.emit('uyeGuncellendi', d.uye, d.sunucu);
    if (t === 'ODA_OLUSTU') return this.emit('odaOlustu', d);
    if (t === 'ODA_GUNCELLENDI') return this.emit('odaGuncellendi', d);
    if (t === 'ODA_SILINDI') return this.emit('odaSilindi', d);
    if (t === 'ROL_OLUSTU') return this.emit('rolOlustu', d);
    if (t === 'ROL_GUNCELLENDI') return this.emit('rolGuncellendi', d);
    if (t === 'ROL_SILINDI') return this.emit('rolSilindi', d);
    if (t === 'TEPKI_EKLENDI') return this.emit('tepki', d);
    if (t === 'TEPKI_KALDIRILDI') return this.emit('tepkiKaldirildi', d);
    if (t === 'SES_DURUMU') return this.emit('sesDurumu', d);
    if (t === 'ENERGY_GONDERILDI' || t === 'ENERGY_GERI_CEKILDI') { const x = { ...d, tur: t === 'ENERGY_GONDERILDI' ? 'gonderildi' : 'geriCekildi' }; this.emit('energy', x); return this.emit(t === 'ENERGY_GONDERILDI' ? 'energyGonderildi' : 'energyGeriCekildi', x); }
    if (t === 'SUNUCUYA_EKLENDI') { this.sunucular.set(d.id, d); return this.emit('sunucuyaEklendi', d); }
    if (t === 'SUNUCUDAN_CIKARILDI') { this.sunucular.delete(d.id); return this.emit('sunucudanCikarildi', d); }
    if (['KOMUT', 'BUTON', 'SECIM', 'FORM'].includes(t)) {
      const e = new Etkilesim(this, d), eslesir = (id, x) => typeof id === 'string' ? id === x : id instanceof RegExp ? id.test(x) : typeof id === 'function' && id(x);
      let fn = null;
      if (t === 'KOMUT') fn = this.komutlar.get(d.veri.ad)?.isleyici;
      else { const l = t === 'BUTON' ? this.butonlar : t === 'SECIM' ? this.secimler : this.formlar; fn = l.find(([id]) => eslesir(id, d.veri.id))?.[1]; }
      if (t !== 'KOMUT' && this._bekleyeneVer('etkilesim', e)) return;
      this.emit('etkilesim', e);
      if (!fn && t === 'KOMUT') this.emit('uyari', `"/${d.veri.ad}" komutu için işleyici yok (bot.komut('${d.veri.ad}', ...) ekle)`);
      if (fn) { try { await fn(e); } catch (er) { this.emit('hata', er); if (!e.cevaplandi) e.cevapla({ icerik: '⚠️ Bir şeyler ters gitti.', gizli: true }).catch(() => {}); } }
    }
  }
  _mesaj(d) {
    if (!d) return d; const bot = this;
    Object.assign(d, {
      cevapla(icerik) { return bot.gonder(d.oda, { ...govde(icerik), yanit: d.id }); },
      tepkiEkle(emoji) { return bot.tepki(d.oda, d.id, emoji); },
      sil() { return bot.sil(d.oda, d.id); },
      duzenle(icerik) { return bot.duzenle(d.oda, d.id, icerik); },
      tepkiKaldir(emoji) { return bot.tepkiKaldir(d.oda, d.id, emoji); },
      sabitle() { return bot.sabitle(d.oda, d.id); },
      sabitKaldir() { return bot.sabitKaldir(d.oda, d.id); },
      /** Aynı odaya (yanıt olmadan) yaz */
      odayaYaz(icerik) { return bot.gonder(d.oda, icerik); },
    });
    // salt okunur kısayollar (her okumada güncel)
    Object.defineProperties(d, {
      dmMi: { get() { return /^dm:/.test(d.oda || ''); }, configurable: true },
      /** Mesajda bot etiketlendi mi? */
      etiketlendiMi: { get() { return !!(bot.ben && d.icerik && new RegExp('@' + bot.ben.ad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}\\p{N}_.-])', 'u').test(d.icerik)); }, configurable: true },
    });
    return d;
  }
}
class Etkilesim {
  constructor(bot, d) { Object.assign(this, d); this._bot = bot; this.cevaplandi = false; }
  /** Seçenek değeri (komutlarda) */
  secenek(ad, varsayilan) { const v = this.veri && this.veri.secenekler ? this.veri.secenekler[ad] : undefined; return v === undefined ? varsayilan : v; }
  get degerler() { return (this.veri && this.veri.degerler) || []; }
  /** Kişi/rol/oda seçicide ve formlarda seçilenlerin bilgisi: { kullanicilar: [...] } | { roller } | { odalar } · formda { alanId: {...} } */
  get secilenler() { return (this.veri && this.veri.cozulmus) || {}; }
  /** Butona basan / komutu kullanan kişinin yetkisi var mı? e.yetkisiVar('manageMessages') (sahip ve yönetici her zaman evet) */
  yetkisiVar(izin) { const k = this.kullanici || {}; return (k.izinler || []).includes('administrator') || (k.izinler || []).includes(izin); }
  get alanlar() { return (this.veri && this.veri.alanlar) || {}; }
  async _c(govdeVeri) { this.cevaplandi = true; govdeVeri = await this._bot._dosyalar(govdeVeri); return fetch(`${this._bot.adres}/api/v1/etkilesim/${this.id}/${this.token}/cevap`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(govdeVeri) }).then(async r => { const j = await r.json().catch(() => null); if (!r.ok) throw new KankaHata((j && j.hata) || 'Cevap verilemedi', r.status, j); return j; }); }
  /** Cevap ver (3 saniye içinde). gizli: true ise sadece komutu kullanan görür */
  cevapla(icerik) { return this._c({ tur: 'mesaj', ...govde(icerik) }); }
  /** Sadece komutu kullanan görür */
  gizliCevapla(icerik) { return this.cevapla({ ...govde(icerik), gizli: true }); }
  /** Sadece o kişi görür ama 15 dakikada kaybolmaz; kişi "Kapat" diyene kadar odada kalır (ticket paneli vb.) */
  kaliciGizliCevapla(icerik) { return this.cevapla({ ...govde(icerik), gizli: true, kalici: true }); }
  /** Uzun sürecek işler için: önce "düşünüyor…" göster, sonra duzenle() ile bitir (15 dakika) */
  bekle({ gizli = false } = {}) { return this._c({ tur: 'bekle', gizli }); }
  /** Butona basılan mesajı yerinde değiştir */
  guncelle(icerik) { return this._c({ tur: 'guncelle', ...govde(icerik) }); }
  /** Kullanıcıya form penceresi aç: { id, baslik, alanlar: [{ id, etiket, tur: 'kisa'|'uzun'|'kisi'|'rol'|'oda'|'dosya'|'resim', zorunlu, yerTutucu }] }
   *  'dosya' / 'resim' alanında kullanıcı dosya yükler; e.secilenler[alanId] = { id, ad, url, boyut, tur }. Bot bu dosyayı mesajına ekleyebilir ya da kartta resim olarak kullanabilir. */
  formAc(form) { return this._c({ tur: 'form', form }); }
  /** bekle()'den sonra mesajı doldur */
  async duzenle(icerik) { const g = await this._bot._dosyalar(govde(icerik)); return fetch(`${this._bot.adres}/api/v1/etkilesim/${this.id}/${this.token}/mesaj`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(g) }).then(r => r.json()); }
  /** Ek mesaj gönder */
  async takip(icerik) { const g = await this._bot._dosyalar(govde(icerik)); return fetch(`${this._bot.adres}/api/v1/etkilesim/${this.id}/${this.token}/takip`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(g) }).then(r => r.json()); }
}
// ---------- Ses bağlantısı ----------
let _werift = null;
function werift() {
  if (_werift) return _werift;
  try { _werift = require('werift'); } catch { throw new KankaHata('Ses için werift paketi gerekli: npm i werift'); }
  return _werift;
}
// Ogg kabından Opus paketlerini çıkar (ffmpeg -c:a libopus -f ogg çıktısı)
class OggOpus {
  constructor(paket) { this.buf = Buffer.alloc(0); this.parca = []; this.paket = paket; this.n = 0; }
  yaz(veri) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, veri]) : veri;
    while (this.buf.length >= 27) {
      if (this.buf.readUInt32BE(0) !== 0x4f676753) { const i = this.buf.indexOf('OggS', 1); if (i < 0) { this.buf = Buffer.alloc(0); return; } this.buf = this.buf.subarray(i); continue; }
      const seg = this.buf[26]; if (this.buf.length < 27 + seg) return;
      const tablo = this.buf.subarray(27, 27 + seg); let uzun = 0; for (const x of tablo) uzun += x;
      if (this.buf.length < 27 + seg + uzun) return;
      let o = 27 + seg;
      for (const x of tablo) { this.parca.push(this.buf.subarray(o, o + x)); o += x; if (x < 255) { const p = Buffer.concat(this.parca); this.parca = []; if (this.n++ >= 2) this.paket(p); } } // ilk iki paket: OpusHead, OpusTags
      this.buf = this.buf.subarray(o);
    }
  }
}
// Ses dağıtımı (1.9.0): bot kullanıcılara sadece GÖNDERİR (sendonly). Eskiden 'sendrecv' idi: odadaki herkes mikrofonunu
// bota da yüklüyordu (boşuna yükleme hattı, ping ve kalite düşüşü). Paketler 20 ms'de bir, saat kaymadan gider; olay döngüsü
// takılırsa birikmiş paketler topluca basılmaz (ağda ani yük ve titreşim yapıyordu), eskiler atlanıp canlıya dönülür.
// Kopan / hiç bağlanamayan eşler kapatılır; ayrılmış kişiden geç gelen sinyal yeni bağlantı açmaz (bellek sızıntısıydı).
const KARE = 20, KARE_TS = 960, EN_COK_BIRIKME = 10, KUYRUK_UST = 150, KUYRUK_ALT = 50;
const simdi = () => Number(process.hrtime.bigint() / 1000000n);
class SesBaglantisi extends EventEmitter {
  constructor(bot) {
    super(); this.bot = bot; this.oda = null; this.sid = null; this.ice = []; this.esler = new Map(); this.kuyruk = []; this.sira = []; this.susturuldu = false; this.duraklatildi = false; this.caliyor = null;
    this._seq = Math.floor(Math.random() * 60000); this._ts = Math.floor(Math.random() * 1e9); this._ssrc = 1 + Math.floor(Math.random() * 2 ** 31);
    this.sayac = { gonderilen: 0, eksik: 0, atlanan: 0 }; // eksik: kaynak yetişemedi (sessizlik) · atlanan: bot takıldı, eski paket atıldı
    this._bakim = setInterval(() => this._temizle(), 5000); this._bakim.unref?.();
  }
  get kisiSayisi() { return this.esler.size; }
  /** Anlık durum: { kisi, kuyruk, gonderilen, eksik, atlanan, bellekMB } (uzun süre açık kalan botlarda takip için) */
  get durum() { return { kisi: this.esler.size, kuyruk: this.kuyruk.length, ...this.sayac, bellekMB: Math.round(process.memoryUsage().rss / 1048576) }; }
  _sinyal(kime, veri) { this.bot._gonder && this.bot._gonder({ op: 5, d: { kime, veri } }); }
  _iz() { if (!this._track) { const { MediaStreamTrack } = werift(); this._track = new MediaStreamTrack({ kind: 'audio' }); } return this._track; }
  _es(sid) {
    if (this.esler.has(sid)) return this.esler.get(sid);
    const { RTCPeerConnection, RTCRtpCodecParameters } = werift();
    const ice = []; for (const x of this.ice || []) for (const u of [].concat(x.urls)) ice.push({ urls: u, ...(x.username ? { username: x.username, credential: x.credential } : {}) });
    const pc = new RTCPeerConnection({ iceServers: ice, codecs: { audio: [new RTCRtpCodecParameters({ mimeType: 'audio/opus', clockRate: 48000, channels: 2, parameters: 'minptime=10;useinbandfec=1' })], video: [] } });
    pc._making = false; pc._acildi = Date.now(); pc._durum = 'new'; pc._durumZamani = Date.now(); this.esler.set(sid, pc);
    pc.addTransceiver(this._iz(), { direction: 'sendonly' });
    pc.onicecandidate = e => { if (e && e.candidate && this.esler.get(sid) === pc) this._sinyal(sid, { ice: typeof e.candidate.toJSON === 'function' ? e.candidate.toJSON() : e.candidate }); };
    pc._abone = pc.connectionStateChange.subscribe(st => {
      pc._durum = st; pc._durumZamani = Date.now(); this.bot._log('ses', sid, st);
      if (st === 'failed' || st === 'closed') this._kapat(sid, pc);
    });
    return pc;
  }
  async _teklif(sid) {
    const pc = this._es(sid);
    try { pc._making = true; await pc.setLocalDescription(await pc.createOffer()); if (this.esler.get(sid) === pc) this._sinyal(sid, { sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } }); }
    catch (e) { this.bot.emit('hata', e); } finally { pc._making = false; }
  }
  _kapat(sid, sadece) {
    const pc = this.esler.get(sid); if (!pc || (sadece && pc !== sadece)) return;
    this.esler.delete(sid);
    try { pc._abone && pc._abone.unSubscribe && pc._abone.unSubscribe(); } catch {}
    pc.onicecandidate = null;
    try { for (const t of pc.getTransceivers ? pc.getTransceivers() : []) { try { t.stop && t.stop(); } catch {} } } catch {}
    try { const r = pc.close(); if (r && r.catch) r.catch(() => {}); } catch {}
  }
  _hepsiniKapat() { for (const sid of [...this.esler.keys()]) this._kapat(sid); }
  // Askıda kalan eşler: 15 sn "disconnected", ya da 30 sn'de bağlanamamış → kapat (karşı taraf isterse yeniden teklif eder)
  _temizle() {
    const t = Date.now();
    for (const [sid, pc] of this.esler) {
      if ((pc._durum === 'disconnected' && t - pc._durumZamani > 15000) || (['new', 'connecting'].includes(pc._durum) && t - pc._acildi > 30000)) {
        this.bot._log('ses', sid, 'askıda kaldı, kapatıldı'); this._kapat(sid, pc);
        if (this.oda && this._kisiler && this._kisiler.has(sid)) this._teklif(sid); // kişi hâlâ odadaysa temiz bir bağlantıyla yeniden dene
      }
    }
  }
  async _olay(t, d) {
    if (t === 'SES_BAGLANDI') {
      this._hepsiniKapat(); this.oda = d.oda; this.sunucu = d.sunucu; this.sid = d.sid; this.ice = d.ice || [];
      this._kisiler = new Set((d.kisiler || []).map(k => k.sid));
      for (const k of d.kisiler || []) this._teklif(k.sid);
      const b = this.bot._sesBekle; if (b) { this.bot._sesBekle = null; b.ok(this); }
      return this.emit(d.tasindi ? 'tasindi' : 'baglandi', d);
    }
    if (t === 'SES_SINYAL') {
      const { kimden, veri } = d; if (!veri || !this.oda) return;
      let pc = this.esler.get(kimden);
      if (!pc) { if (!veri.sdp || veri.sdp.type !== 'offer') return; pc = this._es(kimden); } // ayrılmış kişiden geç gelen ICE/cevap yeni bağlantı açmasın
      try {
        if (veri.sdp) {
          const carpisma = veri.sdp.type === 'offer' && (pc._making || pc.signalingState !== 'stable');
          pc._yoksay = carpisma; if (carpisma) return; // bot "kaba" taraf: çakışmada kendi teklifinde kalır, tarayıcı geri çekilir
          await pc.setRemoteDescription(veri.sdp);
          if (veri.sdp.type === 'offer' && this.esler.get(kimden) === pc) { await pc.setLocalDescription(await pc.createAnswer()); this._sinyal(kimden, { sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } }); }
        } else if (veri.ice && !pc._yoksay) { await pc.addIceCandidate(veri.ice).catch(() => {}); }
      } catch (e) { this.bot._log('ses sinyal hatası', e.message); }
      return;
    }
    if (t === 'SES_KISI_KATILDI') { (this._kisiler ||= new Set()).add(d.sid); return this.emit('kisiKatildi', d); }
    if (t === 'SES_KISI_AYRILDI') { this._kisiler && this._kisiler.delete(d.sid); this._kapat(d.sid); return this.emit('kisiAyrildi', d); }
    if (t === 'SES_KISI_YENILENDI') { if (d.eski) this._kapat(d.eski); return; }
    if (t === 'SES_SUSTURMA') { this.susturuldu = !!d.susturuldu; return this.emit('susturma', d); }
    if (t === 'SES_AYRILDI') { this._hepsiniKapat(); const o = this.oda; this.oda = null; this.durdur(); return this.emit('ayrildi', { oda: o, sebep: d.sebep }); }
  }
  /**
   * Çal. kaynak: dosya yolu, https adresi ya da okunabilir akış (Readable).
   * ayar: { ses: 0.5 (ses düzeyi, 0-2), baslangic: 30 (saniye), ffmpeg: 'ffmpeg yolu', bitHizi: 96 (kbps) }
   * Döner: şarkı bitince ya da durdurulunca çözülen Promise.
   */
  cal(kaynak, ayar = {}) {
    this.durdur(true); werift();
    const { spawn } = require('child_process');
    const akis = kaynak && typeof kaynak.pipe === 'function';
    const ff = ayar.ffmpeg || process.env.FFMPEG_PATH || (() => { try { return require('ffmpeg-static'); } catch { return 'ffmpeg'; } })();
    const sv = ayar.ses != null ? Math.max(0, Math.min(2, +ayar.ses || 0)) : 1;
    // 1'den yüksek ses düzeyinde tepe kırpılıp cızırtı yapmasın diye sınırlayıcı; Opus kayıp düzeltme (FEC) açık
    const af = sv !== 1 ? ['-af', `volume=${sv}${sv > 1 ? ',alimiter=limit=0.95' : ''}`] : [];
    const args = ['-hide_banner', '-loglevel', 'error', ...(ayar.baslangic ? ['-ss', String(ayar.baslangic)] : []), ...(akis ? [] : /^https?:/i.test(String(kaynak)) ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'] : []), '-i', akis ? 'pipe:0' : String(kaynak), '-vn', ...af,
      '-ac', '2', '-ar', '48000', '-c:a', 'libopus', '-b:a', `${Math.max(32, Math.min(192, +ayar.bitHizi || 96))}k`, '-vbr', 'on', '-frame_duration', String(KARE), '-application', 'audio', '-fec', '1', '-packet_loss', '10', '-f', 'ogg', 'pipe:1'];
    const p = spawn(ff, args, { stdio: [akis ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let hataYazi = ''; p.stderr.on('data', x => { hataYazi = (hataYazi + x).slice(-500); });
    if (akis) { kaynak.pipe(p.stdin); p.stdin.on('error', () => {}); }
    const c = this.caliyor = { p, bitti: false, kaynak, kuyruk: [] };
    this.kuyruk = c.kuyruk;
    const ogg = new OggOpus(pk => { if (c.son) return; c.kuyruk.push(pk); if (c.kuyruk.length > KUYRUK_UST && !p.stdout.isPaused()) p.stdout.pause(); });
    p.stdout.on('data', x => { if (!c.son) ogg.yaz(x); });
    p.on('error', e => { c.bitti = true; this.emit('hata', new KankaHata(e.code === 'ENOENT' ? 'ffmpeg bulunamadı: bilgisayarına ffmpeg kur (ya da npm i ffmpeg-static)' : e.message)); });
    p.on('close', kod => { c.bitti = true; if (kod && !c.durduruldu && !c.kuyruk.length) this.emit('hata', new KankaHata('ffmpeg: ' + (hataYazi.trim() || 'çalınamadı (kod ' + kod + ')'))); });
    const { RtpPacket, RtpHeader } = werift();
    let sonraki = simdi() + KARE, isaret = true, basladiMi = false;
    const gonder = pk => {
      this._seq = (this._seq + 1) & 0xffff; this._ts = (this._ts + KARE_TS) >>> 0;
      if (this.susturuldu || !this._track || !this.esler.size) { isaret = true; return; }
      this._track.writeRtp(new RtpPacket(new RtpHeader({ payloadType: 111, sequenceNumber: this._seq, timestamp: this._ts, ssrc: this._ssrc, marker: isaret }), pk));
      isaret = false; this.sayac.gonderilen++;
    };
    c.zamanlayici = setInterval(() => {
      const t = simdi();
      if (this.duraklatildi) { sonraki = t + KARE; isaret = true; return; }
      // Bot takıldıysa (çok geride kaldık) eski kareleri at, canlıya dön: topluca basmak titreşim ve paket kaybı yapıyordu
      const geride = Math.floor((t - sonraki) / KARE);
      if (geride > EN_COK_BIRIKME) {
        const at = geride - 2; for (let i = 0; i < at; i++) { if (c.kuyruk.length) { c.kuyruk.shift(); this.sayac.atlanan++; } this._ts = (this._ts + KARE_TS) >>> 0; }
        sonraki += at * KARE; isaret = true;
      }
      let n = 0;
      while (t >= sonraki && n < 3) { // bir turda en çok 3 kare (60 ms)
        const pk = c.kuyruk.shift();
        if (!pk) {
          if (c.bitti) return this._bitir(c);
          if (!basladiMi) { sonraki = t + KARE; break; } // daha ilk veri gelmedi: saati başlatma
          this._ts = (this._ts + KARE_TS) >>> 0; this.sayac.eksik++; isaret = true; // kaynak yetişemedi: bu kare sessizlik, zaman akmaya devam eder
        } else { basladiMi = true; gonder(pk); }
        sonraki += KARE; n++;
      }
      if (c.kuyruk.length < KUYRUK_ALT && p.stdout.isPaused() && !c.son) p.stdout.resume();
    }, 5);
    this.emit('basladi', { kaynak });
    return new Promise(r => { c.coz = r; });
  }
  _bitir(c, durduruldu) {
    if (c.son) return; c.son = true; clearInterval(c.zamanlayici);
    try { c.p.stdout.removeAllListeners('data'); c.p.stdout.destroy(); } catch {}
    try { if (c.kaynak && typeof c.kaynak.unpipe === 'function') c.kaynak.unpipe(c.p.stdin); } catch {}
    try { c.p.kill('SIGKILL'); } catch {}
    c.kuyruk.length = 0;
    if (this.caliyor === c) { this.caliyor = null; this.kuyruk = []; }
    c.coz && c.coz({ durduruldu: !!durduruldu }); c.coz = null;
    if (!durduruldu) { this.emit('bitti', { kaynak: c.kaynak }); if (this.sira.length) { const s = this.sira.shift(); this.cal(s.kaynak, s.ayar); } }
  }
  /** Sıraya ekle; bir şey çalmıyorsa hemen başlar */
  siraya(kaynak, ayar = {}) { if (!this.caliyor) { this.cal(kaynak, ayar); return 0; } this.sira.push({ kaynak, ayar }); return this.sira.length; }
  /** Sonraki şarkıya geç */
  gec() { const c = this.caliyor; if (c) { c.durduruldu = true; this._bitir(c, true); } if (this.sira.length) { const s = this.sira.shift(); this.cal(s.kaynak, s.ayar); } }
  duraklat() { this.duraklatildi = true; }
  devam() { this.duraklatildi = false; }
  /** Çalanı durdur (sıra da temizlenir) */
  durdur(siraKalsin) { const c = this.caliyor; if (c) { c.durduruldu = true; this._bitir(c, true); } if (!siraKalsin) this.sira = []; this.duraklatildi = false; }
  ayril() { this.bot.sestenAyril(); }
  /** Botu tamamen kapatırken: bağlantıları ve zamanlayıcıları serbest bırak */
  yokEt() { this.durdur(); this._hepsiniKapat(); clearInterval(this._bakim); this.removeAllListeners(); }
}
// Kart (embed) oluşturucu: new Kart().baslik('...').aciklama('...').renk('#ff8a4c').alan('ad', 'değer', true)
class Kart {
  constructor() { this.v = {}; }
  baslik(x) { this.v.baslik = x; return this; } aciklama(x) { this.v.aciklama = x; return this; } renk(x) { this.v.renk = x; return this; } url(x) { this.v.url = x; return this; }
  alan(ad, deger, satir = false) { (this.v.alanlar ||= []).push({ ad, deger: String(deger), satir }); return this; }
  resim(x) { this.v.resim = x; return this; } kucukResim(x) { this.v.kucukResim = x; return this; } altyazi(x) { this.v.altyazi = x; return this; }
  /** Birden çok alan: .alanlar([['Ad', 'Değer', true], ...]) */
  alanlar(l) { for (const [a, d, s] of l) this.alan(a, d, s); return this; }
  toJSON() { return this.v; }
}
const Buton = (id, etiket, stil = 'ana', ek = {}) => ({ tur: 'buton', id, etiket, stil, ...ek });
const LinkButon = (url, etiket) => ({ tur: 'buton', stil: 'link', url, etiket });
/** Butonları bir satırda topla: bilesenler: [Satir(Buton(...), Buton(...)), Satir(Secim(...))] */
const Satir = (...ogeler) => ogeler.flat();
/** Üye seçici: kullanıcı sunucudaki üyeler arasında arayıp seçer. KisiSecici('kim', { max: 3, yerTutucu: 'Kimi ekleyelim?' }) */
const KisiSecici = (id, ek = {}) => ({ tur: 'kisi', id, ...ek });
const RolSecici = (id, ek = {}) => ({ tur: 'rol', id, ...ek });
/** odaTuru: 'text' | 'voice' | 'stage' | 'forum' ile sınırlanabilir */
const OdaSecici = (id, ek = {}) => ({ tur: 'oda', id, ...ek });
const Secim = (id, secenekler, ek = {}) => ({ tur: 'secim', id, secenekler: secenekler.map(o => typeof o === 'string' ? { etiket: o, deger: o } : o), ...ek });
// HTTP etkileşim imzasını doğrula (sürekli bağlantı yerine adres kullanıyorsan)
function imzaDogrula(sir, zaman, govdeMetni, imza) {
  const crypto = require('crypto'); if (Math.abs(Date.now() / 1000 - Number(zaman)) > 300) return false;
  const h = crypto.createHmac('sha256', sir).update(zaman + '.' + govdeMetni).digest('hex');
  return typeof imza === 'string' && imza.length === h.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(imza));
}
module.exports = { SesBaglantisi, Kanka, Kart, Buton, LinkButon, Secim, KisiSecici, RolSecici, OdaSecici, Satir, KankaHata, imzaDogrula, SURUM };
