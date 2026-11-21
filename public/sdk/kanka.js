// kanka.js — Kanka Chat bot kütüphanesi (Node.js 18+)
// Belgeler: https://kankahq.com/gelistirici
//
//   const { Kanka } = require('./kanka.js');
//   const bot = new Kanka({ token: process.env.KANKA_TOKEN });
//   bot.komut('zar', { aciklama: 'Zar at' }, k => k.cevapla(`🎲 ${1 + Math.floor(Math.random() * 6)}`));
//   bot.baglan();
'use strict';
const SURUM = '1.1.0';
const EventEmitter = require('events');

class KankaHata extends Error { constructor(mesaj, durum, veri) { super(mesaj); this.name = 'KankaHata'; this.durum = durum; this.veri = veri; } }
const uyu = ms => new Promise(r => setTimeout(r, ms));
const govde = x => typeof x === 'string' ? { icerik: x } : (x || {});

class Kanka extends EventEmitter {
  /**
   * @param {object} ayar
   * @param {string} ayar.token  Geliştirici Portalı'ndan aldığın bot token'ı
   * @param {string[]} [ayar.niyetler]  'mesajlar', 'icerik', 'uyeler', 'tepkiler', 'dm'
   * @param {string} [ayar.adres]  Varsayılan https://kankahq.com
   */
  constructor({ token, niyetler = ['mesajlar', 'uyeler', 'tepkiler', 'dm'], adres = 'https://kankahq.com', kayit = true } = {}) {
    super();
    if (!token) throw new KankaHata('token gerekli (Geliştirici Portalı › botun › Token)');
    this.token = String(token).replace(/^Bot\s+/i, ''); this.niyetler = niyetler; this.adres = adres.replace(/\/$/, ''); this.kayit = kayit;
    this.komutlar = new Map(); this.sunucuKomutlari = new Map(); this.butonlar = []; this.secimler = []; this.formlar = [];
    this.ben = null; this.sunucular = new Map(); this._oturum = null; this._sira = 0; this._ws = null; this._kapat = false; this._deneme = 0;
  }
  // ---------- REST ----------
  async api(yontem, yol, veri) {
    for (let deneme = 0; deneme < 4; deneme++) {
      const r = await fetch(this.adres + '/api/v1' + yol, { method: yontem, headers: { Authorization: 'Bot ' + this.token, 'Content-Type': 'application/json', 'User-Agent': 'kanka.js/' + SURUM }, body: veri === undefined ? undefined : JSON.stringify(veri) });
      const j = await r.json().catch(() => null);
      if (r.status === 429) { await uyu(((j && j.tekrarDene) || 1) * 1000 + 100); continue; }
      if (!r.ok) throw new KankaHata((j && j.hata) || `HTTP ${r.status}`, r.status, j);
      return j;
    }
    throw new KankaHata('Hız sınırı: istek tekrar tekrar reddedildi', 429);
  }
  gonder(oda, icerik) { return this.api('POST', `/odalar/${oda}/mesajlar`, govde(icerik)).then(r => this._mesaj(r.mesaj)); }
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
  /** durum: 'cevrimici' | 'bosta' | 'rahatsizetme' | 'gorunmez', yazi: durum yazısı */
  durum(durum, yazi) { return this.api('PATCH', '/ben/durum', { ...(durum ? { durum } : {}), ...(yazi !== undefined ? { yazi } : {}) }); }
  dm(kullanici, icerik) { return this.api('POST', `/kullanicilar/${encodeURIComponent(kullanici)}/dm`, govde(icerik)).then(r => this._mesaj(r.mesaj)); }
  duzenle(oda, mesaj, icerik) { return this.api('PATCH', `/odalar/${oda}/mesajlar/${mesaj}`, govde(icerik)); }
  sil(oda, mesaj) { return this.api('DELETE', `/odalar/${oda}/mesajlar/${mesaj}`); }
  tepki(oda, mesaj, emoji) { return this.api('PUT', `/odalar/${oda}/mesajlar/${mesaj}/tepkiler/${encodeURIComponent(emoji)}`); }
  mesajlar(oda, { limit = 50, once } = {}) { return this.api('GET', `/odalar/${oda}/mesajlar?limit=${limit}${once ? '&once=' + once : ''}`).then(r => r.mesajlar.map(m => this._mesaj(m))); }
  uyeler(sunucu) { return this.api('GET', `/sunucular/${sunucu}/uyeler`).then(r => r.uyeler); }
  rolVer(sunucu, kisi, rol) { return this.api('PUT', `/sunucular/${sunucu}/uyeler/${encodeURIComponent(kisi)}/roller/${rol}`); }
  rolAl(sunucu, kisi, rol) { return this.api('DELETE', `/sunucular/${sunucu}/uyeler/${encodeURIComponent(kisi)}/roller/${rol}`); }
  sustur(sunucu, kisi, dakika = 10, sebep = '') { return this.api('POST', `/sunucular/${sunucu}/uyeler/${encodeURIComponent(kisi)}/sustur`, { dakika, sebep }); }
  at(sunucu, kisi, sebep = '') { return this.api('DELETE', `/sunucular/${sunucu}/uyeler/${encodeURIComponent(kisi)}`, { sebep }); }
  yasakla(sunucu, kisi, sebep = '') { return this.api('PUT', `/sunucular/${sunucu}/yasaklar/${encodeURIComponent(kisi)}`, { sebep }); }
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
  kapat() { this._kapat = true; clearInterval(this._nabiz); try { this._ws && this._ws.close(); } catch {} }
  _ac() {
    const WS = globalThis.WebSocket || require('ws');
    const ws = this._ws = new WS(this.adres.replace(/^http/, 'ws') + '/bot/gateway');
    const gonder = o => { try { ws.send(JSON.stringify(o)); } catch {} };
    const al = async veri => {
      let m; try { m = JSON.parse(typeof veri === 'string' ? veri : veri.data !== undefined ? veri.data : String(veri)); } catch { return; }
      if (m.op === 10) {
        clearInterval(this._nabiz); this._nabiz = setInterval(() => gonder({ op: 1, d: this._sira }), m.d.nabizAraligi || 30000);
        if (this._oturum) gonder({ op: 6, d: { token: this.token, oturum: this._oturum, sira: this._sira, niyetler: this.niyetler } });
        else gonder({ op: 2, d: { token: this.token, niyetler: this.niyetler } });
      }
      if (m.op === 0) { if (m.s) this._sira = m.s; this._olay(m.t, m.d).catch(e => this.emit('hata', e)); }
    };
    const kapandi = (kod, sebep) => {
      clearInterval(this._nabiz); if (this._kapat) return;
      if ([4004, 4014].includes(kod)) { this.emit('hata', new KankaHata(`Bağlantı reddedildi: ${sebep || kod}`, kod)); return; }
      const bekle = Math.min(30000, 1000 * 2 ** this._deneme++); this.emit('koptu', { kod, sebep, bekle }); setTimeout(() => this._ac(), bekle);
    };
    if (ws.on) { ws.on('message', al); ws.on('close', (k, s) => kapandi(k, String(s || ''))); ws.on('error', e => this.emit('hata', e)); }
    else { ws.onmessage = al; ws.onclose = e => kapandi(e.code, e.reason); ws.onerror = () => {}; }
  }
  async _olay(t, d) {
    if (t === 'HAZIR') { this._oturum = d.oturum; this._deneme = 0; this.ben = d.bot; for (const s of d.sunucular) this.sunucular.set(s.id, s); if (!d.icerikIzni && this.niyetler.includes('icerik')) this.emit('uyari', 'Mesaj içeriği izni yok: sadece komutlar ve botun etiketlendiği mesajların içeriği gelir. Doğrulanan botlar için Kanka ekibi bu izni ayrıca verir.'); return this.emit('hazir', this); }
    if (t === 'DEVAM_EDILDI') { this._deneme = 0; return this.emit('devam'); }
    if (t === 'MESAJ_GELDI') { const m = this._mesaj(d); if (m.yazar && this.ben && m.yazar.ad === this.ben.ad) return; return this.emit('mesaj', m); }
    if (t === 'MESAJ_DUZENLENDI') return this.emit('mesajDuzenlendi', this._mesaj(d));
    if (t === 'MESAJ_SILINDI') return this.emit('mesajSilindi', d);
    if (t === 'UYE_KATILDI') return this.emit('uyeKatildi', d.uye, d.sunucu);
    if (t === 'UYE_AYRILDI') return this.emit('uyeAyrildi', d.uye, d.sunucu);
    if (t === 'UYE_GUNCELLENDI') return this.emit('uyeGuncellendi', d.uye, d.sunucu);
    if (t === 'TEPKI_EKLENDI') return this.emit('tepki', d);
    if (t === 'TEPKI_KALDIRILDI') return this.emit('tepkiKaldirildi', d);
    if (t === 'SUNUCUYA_EKLENDI') { this.sunucular.set(d.id, d); return this.emit('sunucuyaEklendi', d); }
    if (t === 'SUNUCUDAN_CIKARILDI') { this.sunucular.delete(d.id); return this.emit('sunucudanCikarildi', d); }
    if (['KOMUT', 'BUTON', 'SECIM', 'FORM'].includes(t)) {
      const e = new Etkilesim(this, d), eslesir = (id, x) => typeof id === 'string' ? id === x : id instanceof RegExp ? id.test(x) : typeof id === 'function' && id(x);
      let fn = null;
      if (t === 'KOMUT') fn = this.komutlar.get(d.veri.ad)?.isleyici;
      else { const l = t === 'BUTON' ? this.butonlar : t === 'SECIM' ? this.secimler : this.formlar; fn = l.find(([id]) => eslesir(id, d.veri.id))?.[1]; }
      this.emit('etkilesim', e);
      if (fn) { try { await fn(e); } catch (er) { this.emit('hata', er); if (!e.cevaplandi) e.cevapla({ icerik: '⚠️ Bir şeyler ters gitti.', gizli: true }).catch(() => {}); } }
    }
  }
  _mesaj(d) {
    if (!d) return d; const bot = this;
    return Object.assign(d, {
      cevapla(icerik) { return bot.gonder(d.oda, { ...govde(icerik), yanit: d.id }); },
      tepkiEkle(emoji) { return bot.tepki(d.oda, d.id, emoji); },
      sil() { return bot.sil(d.oda, d.id); },
      duzenle(icerik) { return bot.duzenle(d.oda, d.id, icerik); },
    });
  }
}
class Etkilesim {
  constructor(bot, d) { Object.assign(this, d); this._bot = bot; this.cevaplandi = false; }
  /** Seçenek değeri (komutlarda) */
  secenek(ad, varsayilan) { const v = this.veri && this.veri.secenekler ? this.veri.secenekler[ad] : undefined; return v === undefined ? varsayilan : v; }
  get degerler() { return (this.veri && this.veri.degerler) || []; }
  get alanlar() { return (this.veri && this.veri.alanlar) || {}; }
  _c(govdeVeri) { this.cevaplandi = true; return fetch(`${this._bot.adres}/api/v1/etkilesim/${this.id}/${this.token}/cevap`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(govdeVeri) }).then(async r => { const j = await r.json().catch(() => null); if (!r.ok) throw new KankaHata((j && j.hata) || 'Cevap verilemedi', r.status, j); return j; }); }
  /** Cevap ver (3 saniye içinde). gizli: true ise sadece komutu kullanan görür */
  cevapla(icerik) { return this._c({ tur: 'mesaj', ...govde(icerik) }); }
  /** Uzun sürecek işler için: önce "düşünüyor…" göster, sonra duzenle() ile bitir (15 dakika) */
  bekle({ gizli = false } = {}) { return this._c({ tur: 'bekle', gizli }); }
  /** Butona basılan mesajı yerinde değiştir */
  guncelle(icerik) { return this._c({ tur: 'guncelle', ...govde(icerik) }); }
  /** Kullanıcıya form penceresi aç: { id, baslik, alanlar: [{ id, etiket, tur: 'kisa'|'uzun', zorunlu, yerTutucu }] } */
  formAc(form) { return this._c({ tur: 'form', form }); }
  /** bekle()'den sonra mesajı doldur */
  duzenle(icerik) { return fetch(`${this._bot.adres}/api/v1/etkilesim/${this.id}/${this.token}/mesaj`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(govde(icerik)) }).then(r => r.json()); }
  /** Ek mesaj gönder */
  takip(icerik) { return fetch(`${this._bot.adres}/api/v1/etkilesim/${this.id}/${this.token}/takip`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(govde(icerik)) }).then(r => r.json()); }
}
// Kart (embed) oluşturucu: new Kart().baslik('...').aciklama('...').renk('#ff8a4c').alan('ad', 'değer', true)
class Kart {
  constructor() { this.v = {}; }
  baslik(x) { this.v.baslik = x; return this; } aciklama(x) { this.v.aciklama = x; return this; } renk(x) { this.v.renk = x; return this; } url(x) { this.v.url = x; return this; }
  alan(ad, deger, satir = false) { (this.v.alanlar ||= []).push({ ad, deger: String(deger), satir }); return this; }
  resim(x) { this.v.resim = x; return this; } kucukResim(x) { this.v.kucukResim = x; return this; } altyazi(x) { this.v.altyazi = x; return this; }
  toJSON() { return this.v; }
}
const Buton = (id, etiket, stil = 'ana', ek = {}) => ({ tur: 'buton', id, etiket, stil, ...ek });
const LinkButon = (url, etiket) => ({ tur: 'buton', stil: 'link', url, etiket });
const Secim = (id, secenekler, ek = {}) => ({ tur: 'secim', id, secenekler: secenekler.map(o => typeof o === 'string' ? { etiket: o, deger: o } : o), ...ek });
// HTTP etkileşim imzasını doğrula (sürekli bağlantı yerine adres kullanıyorsan)
function imzaDogrula(sir, zaman, govdeMetni, imza) {
  const crypto = require('crypto'); if (Math.abs(Date.now() / 1000 - Number(zaman)) > 300) return false;
  const h = crypto.createHmac('sha256', sir).update(zaman + '.' + govdeMetni).digest('hex');
  return typeof imza === 'string' && imza.length === h.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(imza));
}
module.exports = { Kanka, Kart, Buton, LinkButon, Secim, KankaHata, imzaDogrula, SURUM };
