"""kanka.py: Kanka Chat bot kütüphanesi (Python 3.9+, gereksinim: aiohttp · sesli oda için: aiortc ve ffmpeg)

Belgeler: https://kankahq.com/gelistirici

    import os, random, kanka
    bot = kanka.Bot(token=os.environ["KANKA_TOKEN"], durum={"durum": "cevrimici", "aktivite": {"tur": "oynuyor", "ad": "/zar"}})

    @bot.komut("zar", aciklama="Zar at", secenekler=[kanka.Secenek("yuz", "tamsayi", "Kaç yüzlü?")])
    async def zar(k):
        await k.cevapla(f"🎲 {random.randint(1, k.secenek('yuz', 6))}")

    bot.calistir()
"""
import asyncio, time, random, hashlib, hmac, json, re, os
from urllib.parse import quote
import aiohttp

SURUM = "1.9.0"


class KankaHata(Exception):
    def __init__(self, mesaj, durum=None, veri=None):
        super().__init__(mesaj); self.durum = durum; self.veri = veri


def Secenek(ad, tur="yazi", aciklama="", zorunlu=False, secimler=None):
    """Komut seçeneği. tur: yazi, sayi, tamsayi, kisi, oda, rol, evethayir"""
    return {"ad": ad, "tur": tur, "aciklama": aciklama or ad, "zorunlu": zorunlu, "secimler": [{"ad": str(a), "deger": d} for a, d in (secimler or [])]}


def Satir(*ogeler):
    """Butonları bir satırda topla: bilesenler=[kanka.Satir(Buton(...), Buton(...))]"""
    return [o for x in ogeler for o in (x if isinstance(x, list) else [x])]


def Buton(id, etiket, stil="ana", emoji=None, kapali=False):
    return {"tur": "buton", "id": id, "etiket": etiket, "stil": stil, "emoji": emoji, "kapali": kapali}


def LinkButon(url, etiket):
    return {"tur": "buton", "stil": "link", "url": url, "etiket": etiket}


def KisiSecici(id, yer_tutucu="Üye ara…", min=1, max=1):
    """Üye seçici: kullanıcı sunucudaki üyeler arasında arayıp seçer"""
    return {"tur": "kisi", "id": id, "yerTutucu": yer_tutucu, "min": min, "max": max}


def RolSecici(id, yer_tutucu="Rol seç…", min=1, max=1):
    return {"tur": "rol", "id": id, "yerTutucu": yer_tutucu, "min": min, "max": max}


def OdaSecici(id, yer_tutucu="Oda seç…", min=1, max=1, oda_turu=None):
    """oda_turu: text | voice | stage | forum"""
    return {"tur": "oda", "id": id, "yerTutucu": yer_tutucu, "min": min, "max": max, **({"odaTuru": oda_turu} if oda_turu else {})}


def Secim(id, secenekler, yer_tutucu="Bir seçenek seç", min=1, max=1):
    return {"tur": "secim", "id": id, "yerTutucu": yer_tutucu, "min": min, "max": max,
            "secenekler": [o if isinstance(o, dict) else {"etiket": o, "deger": o} for o in secenekler]}


class Kart(dict):
    """Kart (embed): Kart(baslik="...", aciklama="...", renk="#ff8a4c").alan("ad", "değer", satir=True)"""
    def __init__(self, baslik=None, aciklama=None, renk=None, url=None, resim=None, kucuk_resim=None, altyazi=None):
        super().__init__({k: v for k, v in dict(baslik=baslik, aciklama=aciklama, renk=renk, url=url, resim=resim, kucukResim=kucuk_resim, altyazi=altyazi).items() if v})
    def alan(self, ad, deger, satir=False):
        self.setdefault("alanlar", []).append({"ad": ad, "deger": str(deger), "satir": satir}); return self
    def alanlar(self, liste):
        """[("Ad", "Değer", True), ...]"""
        for x in liste: self.alan(*x)
        return self


def _govde(x):
    if isinstance(x, str): return {"icerik": x}
    if isinstance(x, Kart): return {"kartlar": [dict(x)]}
    return dict(x or {})


def imza_dogrula(sir, zaman, govde_metni, imza):
    """HTTP etkileşim imzasını doğrula (X-Kanka-Zaman, X-Kanka-Imza başlıkları)"""
    try:
        if abs(time.time() - int(zaman)) > 300: return False
    except (TypeError, ValueError):
        return False
    h = hmac.new(sir.encode(), f"{zaman}.{govde_metni}".encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(h, str(imza or ""))


class Mesaj(dict):
    def __init__(self, bot, d):
        super().__init__(d); self._bot = bot
    async def cevapla(self, icerik):
        return await self._bot.gonder(self["oda"], {**_govde(icerik), "yanit": self["id"]})
    async def tepki(self, emoji):
        return await self._bot.tepki(self["oda"], self["id"], emoji)
    async def sil(self):
        return await self._bot.sil(self["oda"], self["id"])
    async def duzenle(self, icerik):
        return await self._bot.duzenle(self["oda"], self["id"], icerik)
    async def tepki_kaldir(self, emoji):
        return await self._bot.tepki_kaldir(self["oda"], self["id"], emoji)
    async def sabitle(self): return await self._bot.sabitle(self["oda"], self["id"])
    async def sabit_kaldir(self): return await self._bot.sabit_kaldir(self["oda"], self["id"])
    async def odaya_yaz(self, icerik):
        """Aynı odaya (yanıt olmadan) yaz"""
        return await self._bot.gonder(self["oda"], icerik)
    @property
    def yazar(self): return self.get("yazar") or {}
    @property
    def icerik(self): return self.get("icerik") or ""
    @property
    def dm_mi(self): return str(self.get("oda", "")).startswith("dm:")
    @property
    def etiketlendi_mi(self):
        """Mesajda bot etiketlendi mi?"""
        ben = (self._bot.ben or {}).get("ad")
        return bool(ben and re.search("@" + re.escape(ben) + r"(?![\w.-])", self.icerik))


class Etkilesim(dict):
    def __init__(self, bot, d):
        super().__init__(d); self._bot = bot; self.cevaplandi = False
    def secenek(self, ad, varsayilan=None):
        return (self.get("veri") or {}).get("secenekler", {}).get(ad, varsayilan)
    @property
    def degerler(self): return (self.get("veri") or {}).get("degerler", [])
    @property
    def alanlar(self): return (self.get("veri") or {}).get("alanlar", {})
    @property
    def secilenler(self):
        """Kişi/rol/oda seçicide ve formlarda seçilenlerin bilgisi"""
        return (self.get("veri") or {}).get("cozulmus", {})
    def yetkisi_var(self, izin):
        """Butona basan / komutu kullanan kişinin yetkisi var mı? (yönetici her zaman evet)"""
        iz = (self.get("kullanici") or {}).get("izinler", []); return "administrator" in iz or izin in iz
    @property
    def kullanici(self): return self["kullanici"]
    async def _istek(self, yontem, yol, veri):
        async with self._bot._oturum.request(yontem, f"{self._bot.adres}/api/v1/etkilesim/{self['id']}/{self['token']}{yol}", json=veri) as r:
            j = await r.json(content_type=None)
            if r.status >= 400: raise KankaHata((j or {}).get("hata", f"HTTP {r.status}"), r.status, j)
            return j
    async def cevapla(self, icerik, gizli=False, kalici=False):
        """3 saniye içinde cevap ver. gizli=True ise sadece komutu kullanan görür; kalici=True ise o gizli mesaj 15 dakikada kaybolmaz."""
        self.cevaplandi = True; return await self._istek("POST", "/cevap", {"tur": "mesaj", **_govde(icerik), **({"gizli": True} if gizli else {}), **({"kalici": True} if kalici else {})})
    async def bekle(self, gizli=False):
        """Uzun işler için: önce 'düşünüyor…', sonra duzenle() ile bitir (15 dakika)."""
        self.cevaplandi = True; return await self._istek("POST", "/cevap", {"tur": "bekle", "gizli": gizli})
    async def guncelle(self, icerik):
        """Butona basılan mesajı yerinde değiştir."""
        self.cevaplandi = True; return await self._istek("POST", "/cevap", {"tur": "guncelle", **_govde(icerik)})
    async def form_ac(self, id, baslik, alanlar):
        """alanlar: [{"id": "oyun", "etiket": "En sevdiğin oyun", "tur": "kisa"|"uzun", "zorunlu": True}]"""
        self.cevaplandi = True; return await self._istek("POST", "/cevap", {"tur": "form", "form": {"id": id, "baslik": baslik, "alanlar": alanlar}})
    async def gizli_cevapla(self, icerik):
        """Sadece komutu kullanan görür"""
        return await self.cevapla(icerik, gizli=True)
    async def duzenle(self, icerik):
        return await self._istek("PATCH", "/mesaj", _govde(icerik))
    async def takip(self, icerik, gizli=False):
        return await self._istek("POST", "/takip", {**_govde(icerik), **({"gizli": True} if gizli else {})})


class Bot:
    def __init__(self, token, niyetler=("mesajlar", "uyeler", "tepkiler", "dm"), adres="https://kankahq.com", durum=None, hata_ayikla=False):
        """durum: bağlanınca ayarlanacak durum, ör. {"durum": "rahatsizetme", "aktivite": {"tur": "dinliyor", "ad": "Spotify"}}
        hata_ayikla: True ise bağlantı olaylarını yazdırır"""
        if not token: raise KankaHata("token gerekli (Geliştirici Portalı › botun › Token)")
        self.token = re.sub(r"^Bot\s+", "", token); self.niyetler = list(niyetler); self.adres = adres.rstrip("/")
        self._durum = dict(durum) if durum else None; self._hd = hata_ayikla; self._bekleyenler = []
        self.komutlar = {}; self.sunucu_komutlari = {}; self._butonlar = []; self._secimler = []; self._formlar = []; self._olaylar = {}
        self.ben = None; self.sunucular = {}; self._oturum = None; self._oturum_id = None; self._sira = 0
        self._ws = None; self._ses = None; self._ses_bekle = None

    # ---------- REST ----------
    async def api(self, yontem, yol, veri=None):
        for deneme in range(6):
            try:
                async with self._oturum.request(yontem, f"{self.adres}/api/v1{yol}", json=veri, headers={"Authorization": "Bot " + self.token, "User-Agent": "kanka.py/" + SURUM}) as r:
                    gecici = r.status in (502, 503, 504) and deneme < 5
                    if not gecici:
                        j = await r.json(content_type=None)
                        if r.status == 429: await asyncio.sleep((j or {}).get("tekrarDene", 1) + 0.1); continue
                        if r.status >= 400: raise KankaHata((j or {}).get("hata", f"HTTP {r.status}"), r.status, j)
                        return j
            except aiohttp.ClientConnectionError:
                if deneme >= 5: raise
            # sunucu güncellenirken birkaç saniye cevap vermez: bekleyip tekrar dene
            await asyncio.sleep(1.5 * (deneme + 1))
        raise KankaHata("Sunucuya ulaşılamadı ya da hız sınırı", 429)
    async def _dosyalar(self, g):
        """{"dosyalar": ["kart.png"]} ya da [{"ad": "kart.png", "veri": bytes}] → önce yüklenir, kartta "attachment://kart.png" kullanılabilir"""
        d = g.pop("dosyalar", None) if isinstance(g, dict) else None
        if not d: return g
        ids = list(g.get("ekler") or [])
        for x in (d if isinstance(d, (list, tuple)) else [d]):
            if isinstance(x, str):
                with open(x, "rb") as f: veri, ad = f.read(), os.path.basename(x)
            elif isinstance(x, (bytes, bytearray)): veri, ad = bytes(x), "dosya.png"
            else: veri, ad = x.get("veri"), x.get("ad", "dosya.png")
            ids.append((await self.dosya_yukle(veri, ad))["id"])
        g["ekler"] = ids; return g
    async def gonder(self, oda, icerik):
        return Mesaj(self, (await self.api("POST", f"/odalar/{oda}/mesajlar", await self._dosyalar(_govde(icerik))))["mesaj"])
    async def talep_odasi(self, sunucu, ad, kisiler=(), roller=(), kategori=None, konu=None):
        """Talep (ticket) odası: sadece kisiler, roller ve bot görür"""
        return await self.api("POST", f"/sunucular/{sunucu}/odalar", {"ad": ad, "tur": "text", "ozel": True, "kisiler": list(kisiler), "roller": list(roller), **({"kategori": kategori} if kategori else {}), **({"konu": konu} if konu else {})})
    async def _ham(self, yontem, yol, veri, basliklar=None):
        h = {"Authorization": "Bot " + self.token, "User-Agent": "kanka.py/" + SURUM, "Content-Type": "application/octet-stream", **(basliklar or {})}
        async with self._oturum.request(yontem, f"{self.adres}/api/v1{yol}", data=veri, headers=h) as r:
            j = await r.json(content_type=None)
            if r.status >= 400: raise KankaHata((j or {}).get("hata", f"HTTP {r.status}"), r.status, j)
            return j
    async def dosya_yukle(self, veri, ad="dosya"):
        """veri: bytes. Dönen id'yi mesajda kullan: await bot.gonder(oda, {"icerik": "al", "ekler": [d["id"]]})"""
        return await self._ham("POST", "/dosyalar", veri, {"X-Dosya-Adi": quote(ad)})
    async def emoji_yukle(self, ad, veri):
        """Botun kendi emojisi: mesajda :ad: yazınca her yerde görünür (en fazla 50)."""
        return await self._ham("PUT", f"/emojiler/{ad}", veri)
    async def emoji_sil(self, ad): return await self.api("DELETE", f"/emojiler/{ad}")
    async def emojiler(self): return (await self.api("GET", "/emojiler"))["emojiler"]
    async def yaziyor(self, oda):
        """Odada "yazıyor…" göster (yaklaşık 8 saniye)."""
        return await self.api("POST", f"/odalar/{oda}/yaziyor")
    def _log(self, *x):
        if self._hd: print("[kanka]", *x)

    # ---------- Durum ----------
    async def durum(self, durum=None, yazi=None, aktivite=None):
        """Botun durumu. durum: "cevrimici" | "bosta" | "rahatsizetme" | "gorunmez" (Türkçe harfle ya da "online", "dnd" de olur)
        yazi: durum yazısı · aktivite: {"tur": "oynuyor"|"dinliyor"|"izliyor"|"yayinda"|"yarisiyor", "ad": "..."}
        Bağlantı kopup yeniden gelince de korunur."""
        d = dict(durum) if isinstance(durum, dict) else {**({"durum": durum} if durum else {}), **({"yazi": yazi} if yazi is not None else {}), **({"aktivite": aktivite} if aktivite else {})}
        self._durum = {**(self._durum or {}), **d}
        return await self.api("PATCH", "/ben/durum", d)
    async def aktivite(self, tur, ad):
        """Örnek: await bot.aktivite("oynuyor", "Minecraft") ile durum yazısı Oynuyor: Minecraft olur."""
        return await self.durum(aktivite={"tur": tur, "ad": ad})
    async def durumu_getir(self): return await self.api("GET", "/ben/durum")

    # ---------- Bilgi ----------
    async def bilgi(self): return await self.api("GET", "/ben")
    async def sunucu_listesi(self):
        l = (await self.api("GET", "/sunucular"))["sunucular"]
        for s in l: self.sunucular[s["id"]] = s
        return l
    async def sunucu(self, id):
        s = await self.api("GET", f"/sunucular/{id}"); self.sunucular[s["id"]] = s; return s
    async def uye(self, sunucu, kisi): return await self.api("GET", f"/sunucular/{sunucu}/uyeler/{quote(str(kisi))}")
    async def oda(self, id): return await self.api("GET", f"/odalar/{quote(str(id))}")
    # Oda yönetimi (botun "manageChannels" izni gerekir). tur: "text" | "voice" | "stage" | "forum"
    def ekleme_linki(self, *izinler):
        """Botu sunucuya ekleme linki (Portal'daki linkle aynı). ornek: bot.ekleme_linki("manageMessages", "kick")"""
        if not self.ben: raise RuntimeError('Önce bağlan: ekleme_linki "hazir" olayından sonra kullanılabilir')
        l = self.ben.get("eklemeLinki") or f"{self.adres}/bot-ekle/{self.ben['id']}"
        return f"{l}?izin={','.join(izinler)}" if izinler else l
    async def odalar(self, sunucu): return await self.api("GET", f"/sunucular/{quote(str(sunucu))}/odalar")
    async def oda_olustur(self, sunucu, ad, tur="text", kategori=None, ozel=False, konu=None):
        veri = {"ad": ad, "tur": tur, "ozel": ozel}
        if kategori: veri["kategori"] = kategori
        if konu: veri["konu"] = konu
        return await self.api("POST", f"/sunucular/{quote(str(sunucu))}/odalar", veri)
    async def oda_duzenle(self, oda, **ayar): return await self.api("PATCH", f"/odalar/{quote(str(oda))}", ayar)
    async def oda_sil(self, oda): return await self.api("DELETE", f"/odalar/{quote(str(oda))}")
    async def kategori_olustur(self, sunucu, ad, gizli=False, roller=(), kisiler=(), izinler=None):
        """Kategori aç. Gizli kategori: await bot.kategori_olustur(sunucu, "Talepler", gizli=True, roller=[yetkili_rol])"""
        veri = {"ad": ad}
        if gizli: veri["gizli"] = True
        if roller: veri["roller"] = list(roller)
        if kisiler: veri["kisiler"] = list(kisiler)
        if izinler: veri["izinler"] = izinler
        return await self.api("POST", f"/sunucular/{quote(str(sunucu))}/kategoriler", veri)
    async def kategoriler(self, sunucu):
        """[{ id, ad, ozel, izinAyarlari, odalar }]"""
        return (await self.api("GET", f"/sunucular/{quote(str(sunucu))}/kategoriler"))["kategoriler"]
    async def kategori_adi(self, sunucu, kategori, ad): return await self.api("PATCH", f"/sunucular/{quote(str(sunucu))}/kategoriler/{quote(str(kategori))}", {"ad": ad})
    async def kategori_izni(self, sunucu, kategori, hedef, izinler):
        """Kategoriyle eşitlenmiş odalar da uyar. hedef: "herkes" | rol id'si | kişi adı"""
        return await self.api("PUT", f"/sunucular/{quote(str(sunucu))}/kategoriler/{quote(str(kategori))}/izinler/{quote(str(hedef))}", izinler)
    async def kategori_izni_kaldir(self, sunucu, kategori, hedef): return await self.api("DELETE", f"/sunucular/{quote(str(sunucu))}/kategoriler/{quote(str(kategori))}/izinler/{quote(str(hedef))}")
    async def rol_olustur(self, sunucu, ad, renk=None, izinler=(), etiketlenebilir=True, ayri_goster=False, simge=None):
        """Botun rolünün hemen altına rol açar; bot sadece kendinde olan izinleri verebilir ("manageRoles" gerekir)"""
        veri = {"ad": ad, "izinler": list(izinler), "etiketlenebilir": etiketlenebilir, "ayriGoster": ayri_goster}
        if renk: veri["renk"] = renk
        if simge: veri["simge"] = simge
        return await self.api("POST", f"/sunucular/{quote(str(sunucu))}/roller", veri)
    async def rol_duzenle(self, sunucu, rol, **alanlar):
        """alanlar: ad, renk, izinler, etiketlenebilir, ayriGoster, simge"""
        return await self.api("PATCH", f"/sunucular/{quote(str(sunucu))}/roller/{quote(str(rol))}", alanlar)
    async def rol_sil(self, sunucu, rol): return await self.api("DELETE", f"/sunucular/{quote(str(sunucu))}/roller/{quote(str(rol))}")
    async def kategori_sil(self, sunucu, kategori): return await self.api("DELETE", f"/sunucular/{quote(str(sunucu))}/kategoriler/{quote(str(kategori))}")
    async def mesaj(self, oda, id): return Mesaj(self, await self.api("GET", f"/odalar/{quote(str(oda))}/mesajlar/{id}"))
    async def kullanici(self, ad_veya_id): return await self.api("GET", f"/kullanicilar/{quote(str(ad_veya_id))}")
    async def mesajlar(self, oda, limit=50, once=None):
        return [Mesaj(self, m) for m in (await self.api("GET", f"/odalar/{quote(str(oda))}/mesajlar?limit={limit}" + (f"&once={once}" if once else "")))["mesajlar"]]
    async def duzenle(self, oda, mesaj, icerik): return await self.api("PATCH", f"/odalar/{oda}/mesajlar/{mesaj}", _govde(icerik))
    async def sil(self, oda, mesaj): return await self.api("DELETE", f"/odalar/{oda}/mesajlar/{mesaj}")
    async def tepki(self, oda, mesaj, emoji):
        return await self.api("PUT", f"/odalar/{oda}/mesajlar/{mesaj}/tepkiler/{quote(emoji)}")
    async def tepki_kaldir(self, oda, mesaj, emoji):
        return await self.api("DELETE", f"/odalar/{oda}/mesajlar/{mesaj}/tepkiler/{quote(emoji)}")
    async def sabitle(self, oda, mesaj): return await self.api("PUT", f"/odalar/{oda}/sabitler/{mesaj}")
    async def sabit_kaldir(self, oda, mesaj): return await self.api("DELETE", f"/odalar/{oda}/sabitler/{mesaj}")
    async def sabitler(self, oda): return [Mesaj(self, m) for m in (await self.api("GET", f"/odalar/{oda}/sabitler"))["mesajlar"]]
    async def toplu_sil(self, oda, adet_veya_idler, kisi=None):
        """En fazla 100 mesaj, son 14 gün. toplu_sil(oda, 20) son 20 · toplu_sil(oda, ["id1", "id2"]) · toplu_sil(oda, 50, kisi="ahmet")"""
        g = {"mesajlar": list(adet_veya_idler)} if isinstance(adet_veya_idler, (list, tuple)) else {"adet": int(adet_veya_idler)}
        if kisi: g["kisi"] = kisi
        return (await self.api("POST", f"/odalar/{oda}/mesajlar/toplu-sil", g))["silinen"]
    async def uyeler(self, sunucu): return (await self.api("GET", f"/sunucular/{sunucu}/uyeler"))["uyeler"]
    async def uye_ara(self, sunucu, ara, limit=25): return (await self.api("GET", f"/sunucular/{sunucu}/uyeler?ara={quote(str(ara))}&limit={limit}"))["uyeler"]
    async def yetkiler(self, sunucu, kisi, oda=None):
        """{ sahip, yonetici, izinler: [...], oda: { view, send, ... } }"""
        return await self.api("GET", f"/sunucular/{sunucu}/uyeler/{quote(str(kisi))}/izinler" + (f"?oda={quote(str(oda))}" if oda else ""))
    async def yetkisi_var(self, sunucu, kisi, izin, oda=None):
        y = await self.yetkiler(sunucu, kisi, oda)
        if oda and izin in (y.get("oda") or {}): return bool(y["oda"][izin])
        return y["sahip"] or y["yonetici"] or izin in y["izinler"]
    async def roller(self, sunucu): return (await self.api("GET", f"/sunucular/{sunucu}/roller"))["roller"]
    async def energy(self, sunucu):
        """Energy (boost): { toplam, seviye, gonderenler: [{ ad, adet }] }"""
        return await self.api("GET", f"/sunucular/{sunucu}/energy")
    async def ses(self, sunucu): return (await self.api("GET", f"/sunucular/{sunucu}/ses"))["odalar"]
    async def ses_islem(self, sunucu, kisi, islem, oda=None):
        """islem: tasi (oda gerekir) | cikar | sustur | ac"""
        return await self.api("POST", f"/sunucular/{sunucu}/uyeler/{quote(str(kisi))}/ses", {"islem": islem, **({"oda": oda} if oda else {})})
    async def oda_izni(self, oda, hedef, izinler):
        """hedef: "herkes" | rol id'si | kişi adı. izinler: {"view": True, "send": False} (None = devral)"""
        return await self.api("PUT", f"/odalar/{oda}/izinler/{quote(str(hedef))}", izinler)
    async def oda_izni_kaldir(self, oda, hedef): return await self.api("DELETE", f"/odalar/{oda}/izinler/{quote(str(hedef))}")
    async def ozel_gonder(self, oda, kisi, icerik):
        """Kalıcı gizli mesaj: odada sadece kisi görür. Döner: { id, mesaj: { id, oda, icerik, kisi, ... } }"""
        return await self.api("POST", f"/odalar/{oda}/ozel-mesajlar", {**(await self._dosyalar(_govde(icerik))), "kisi": kisi})
    async def ozel_duzenle(self, oda, mesaj, icerik): return await self.api("PATCH", f"/odalar/{oda}/ozel-mesajlar/{mesaj}", _govde(icerik))
    async def ozel_sil(self, oda, mesaj): return await self.api("DELETE", f"/odalar/{oda}/ozel-mesajlar/{mesaj}")
    async def dm(self, kullanici, icerik):
        return Mesaj(self, (await self.api("POST", f"/kullanicilar/{quote(str(kullanici))}/dm", _govde(icerik)))["mesaj"])
    async def rol_ver(self, sunucu, kisi, rol): return await self.api("PUT", f"/sunucular/{sunucu}/uyeler/{kisi}/roller/{rol}")
    async def rol_al(self, sunucu, kisi, rol): return await self.api("DELETE", f"/sunucular/{sunucu}/uyeler/{kisi}/roller/{rol}")
    async def sustur(self, sunucu, kisi, dakika=10, sebep=""): return await self.api("POST", f"/sunucular/{sunucu}/uyeler/{kisi}/sustur", {"dakika": dakika, "sebep": sebep})
    async def at(self, sunucu, kisi, sebep=""): return await self.api("DELETE", f"/sunucular/{sunucu}/uyeler/{kisi}", {"sebep": sebep})
    async def yasakla(self, sunucu, kisi, sebep=""): return await self.api("PUT", f"/sunucular/{sunucu}/yasaklar/{kisi}", {"sebep": sebep})
    async def yasak_kaldir(self, sunucu, kisi): return await self.api("DELETE", f"/sunucular/{sunucu}/yasaklar/{kisi}")
    async def yasaklar(self, sunucu): return (await self.api("GET", f"/sunucular/{sunucu}/yasaklar"))["yasaklar"]
    async def susturma_kaldir(self, sunucu, kisi): return await self.api("DELETE", f"/sunucular/{sunucu}/uyeler/{kisi}/sustur")

    # ---------- Ses (müzik botu vb.) ----------
    async def _gonder(self, veri):
        if self._ws is None or self._ws.closed: return False
        try: await self._ws.send_json(veri); return True
        except Exception: return False
    async def sesli_odaya_katil(self, oda):
        """Sesli odaya gir. Ses bottan kullanıcılara doğrudan gider (WebRTC). Gerekenler: pip install aiortc ve bilgisayarda ffmpeg.
            ses = await bot.sesli_odaya_katil(oda_id)
            await ses.cal("sarki.mp3")            # dosya, https adresi; şarkı bitince döner
            ses.siraya("a.mp3"); ses.siraya("b.mp3"); ses.gec()
        Bir bot aynı anda bir sesli odada olur. Bağlantı koparsa yeniden bağlanınca odaya kendiliğinden döner."""
        if self._ws is None or not self.ben: raise KankaHata('Önce bağlan: sesli_odaya_katil "hazir" olayından sonra kullanılabilir')
        _aiortc()  # kurulu değilse hemen anlaşılır hata ver
        if self._ses is None: self._ses = SesBaglantisi(self)
        ses = self._ses; ses._istenen = oda
        f = asyncio.get_running_loop().create_future(); self._ses_bekle = f
        await self._gonder({"op": 4, "d": {"oda": oda}})
        try: return await asyncio.wait_for(f, 15)
        except asyncio.TimeoutError: raise KankaHata("Sese girilemedi: zaman aşımı", 408)
        finally:
            if self._ses_bekle is f: self._ses_bekle = None
    async def sesten_ayril(self):
        """Sesten çık (çalan şarkı durur)"""
        if self._ses: self._ses.durdur(); await self._ses._hepsini_kapat(); self._ses._istenen = None; self._ses.oda = None
        await self._gonder({"op": 4, "d": {"oda": None}})

    # ---------- Yardımcılar ----------
    def yaziyor_ken(self, oda, sure=None):
        """İş sürerken "yazıyor…" göster:  async with bot.yaziyor_ken(oda): ...
        Ya da belli bir süre:  await bot.yaziyor_ken(oda, 3)  (saniye)"""
        if sure is not None:
            async def _sureli():
                async with self.yaziyor_ken(oda): await asyncio.sleep(min(max(float(sure), 0), 120))
            return _sureli()
        bot = self
        class _Y:
            async def __aenter__(s):
                async def dongu():
                    while True:
                        try: await bot.yaziyor(oda)
                        except Exception: pass
                        await asyncio.sleep(7)
                s.t = asyncio.create_task(dongu()); return s
            async def __aexit__(s, *a): s.t.cancel()
        return _Y()
    async def mesaj_bekle(self, filtre=lambda m: True, sure=60):
        """Bir sonraki uygun mesajı bekle; süre (saniye) dolarsa None.
        m = await bot.mesaj_bekle(lambda m: m["oda"] == oda and m.yazar.get("ad") == "ahmet", sure=30)"""
        return await self._bekle("mesaj", filtre, sure)
    async def etkilesim_bekle(self, filtre=lambda e: True, sure=60):
        """Buton/seçim bekle: e = await bot.etkilesim_bekle(lambda e: e["veri"]["id"] == "evet", sure=30)"""
        return await self._bekle("etkilesim", filtre, sure)
    async def _bekle(self, olay, filtre, sure):
        f = asyncio.get_running_loop().create_future(); b = (olay, filtre, f); self._bekleyenler.append(b)
        try: return await asyncio.wait_for(f, sure)
        except asyncio.TimeoutError: return None
        finally:
            if b in self._bekleyenler: self._bekleyenler.remove(b)
    def _bekleyene_ver(self, olay, x):
        for b in list(self._bekleyenler):
            if b[0] != olay or b[2].done(): continue
            try: ok = b[1](x)
            except Exception: ok = False
            if ok: b[2].set_result(x); self._bekleyenler.remove(b); return True
        return False

    # ---------- Dekoratörler ----------
    def komut(self, ad, aciklama="", secenekler=None, sunucu=None):
        def kaydet(fn):
            t = {"ad": ad.lower(), "aciklama": aciklama or ad, "secenekler": secenekler or []}
            self.komutlar[t["ad"]] = (t, fn, sunucu)
            if sunucu: self.sunucu_komutlari.setdefault(sunucu, []).append(t)
            return fn
        return kaydet
    def buton(self, id):
        def kaydet(fn): self._butonlar.append((id, fn)); return fn
        return kaydet
    def secim(self, id):
        def kaydet(fn): self._secimler.append((id, fn)); return fn
        return kaydet
    def form(self, id):
        def kaydet(fn): self._formlar.append((id, fn)); return fn
        return kaydet
    def olay(self, ad):
        """Olaylar: hazir, mesaj, mesaj_duzenlendi, mesaj_silindi, uye_katildi, uye_ayrildi, uye_guncellendi, tepki, tepki_kaldirildi,
        sunucuya_eklendi, sunucudan_cikarildi, etkilesim, durum, ses_durumu, hata"""
        def kaydet(fn): self._olaylar.setdefault(ad, []).append(fn); return fn
        return kaydet
    async def _yay(self, ad, *a):
        for fn in self._olaylar.get(ad, []):
            try: await fn(*a)
            except Exception as e: print(f"[kanka] {ad} işleyicisinde hata: {e!r}")

    async def komutlari_kaydet(self):
        await self.api("PUT", "/komutlar", [t for t, _, s in self.komutlar.values() if not s])
        for s, l in self.sunucu_komutlari.items(): await self.api("PUT", f"/sunucular/{s}/komutlar", l)

    # ---------- Bağlantı ----------
    def calistir(self):
        asyncio.run(self.baslat())

    async def baslat(self):
        async with aiohttp.ClientSession() as oturum:
            self._oturum = oturum
            if self.komutlar: await self.komutlari_kaydet()
            bekle = 1
            while True:
                basladi = time.monotonic(); self._ilk_bekle = 0
                try:
                    await self._baglan()
                except KankaHata as e:
                    if e.durum in (4004, 4014): raise
                    print(f"[kanka] bağlantı koptu: {e}")
                except Exception as e:
                    print(f"[kanka] bağlantı koptu: {e!r}")
                if time.monotonic() - basladi > 30: bekle = 1  # uzun süre bağlı kaldıysa beklemeyi sıfırla
                # sunucu güncelleniyor (op 7 / 1012): birkaç saniye bekle, aynı oturumla devam et
                await asyncio.sleep(self._ilk_bekle or (bekle + random.random() * 0.5)); bekle = min(15, bekle * 2)

    async def _baglan(self):
        async with self._oturum.ws_connect(self.adres.replace("http", "ws", 1) + "/bot/gateway", heartbeat=None) as ws:
            nabiz = None; self._ws = ws
            async for m in ws:
                if m.type != aiohttp.WSMsgType.TEXT: break
                p = json.loads(m.data)
                if p["op"] == 10:
                    async def nabiz_at(araligi=p["d"].get("nabizAraligi", 30000) / 1000):
                        while True: await asyncio.sleep(araligi); await ws.send_json({"op": 1, "d": self._sira})
                    nabiz = asyncio.create_task(nabiz_at())
                    ek = {"durum": self._durum} if self._durum else {}
                    if self._oturum_id: await ws.send_json({"op": 6, "d": {"token": self.token, "oturum": self._oturum_id, "sira": self._sira, "niyetler": self.niyetler, **ek}})
                    else: await ws.send_json({"op": 2, "d": {"token": self.token, "niyetler": self.niyetler, **ek}})
                    self._log("bağlandı, kimlik gönderildi")
                elif p["op"] == 7:
                    self._ilk_bekle = (p.get("d") or {}).get("bekle", 4000) / 1000
                elif p["op"] == 0:
                    if p.get("s"): self._sira = p["s"]
                    self._log("olay", p["t"])
                    asyncio.create_task(self._olay(p["t"], p["d"]))
            if nabiz: nabiz.cancel()
            if ws.close_code == 1012 and not self._ilk_bekle: self._ilk_bekle = 4
            if ws.close_code in (4004, 4014): raise KankaHata(f"Bağlantı reddedildi ({ws.close_code})", ws.close_code)
            raise KankaHata(f"kapandı ({ws.close_code})", ws.close_code)

    async def _olay(self, t, d):
        if t == "HAZIR":
            self._oturum_id = d["oturum"]; self.ben = d["bot"]; self.sunucular = {s["id"]: s for s in d["sunucular"]}
            if self._ses and self._ses.oda: asyncio.get_running_loop().call_later(0.5, lambda: asyncio.ensure_future(self._gonder({"op": 4, "d": {"oda": self._ses.oda}})))  # yeniden bağlanınca sese dön
            return await self._yay("hazir")
        if t.startswith("SES_") and t != "SES_DURUMU":
            if self._ses: await self._ses._olay(t, d)
            return
        if t == "HATA" and isinstance(d, dict) and d.get("islem") == "ses" and self._ses_bekle and not self._ses_bekle.done():
            self._ses_bekle.set_exception(KankaHata(d.get("hata") or "Sese girilemedi", 400, d)); return
        if t == "DEVAM_EDILDI" and self._ses and self._ses.oda: await self._gonder({"op": 4, "d": {"oda": self._ses.oda}})
        adlar = {"MESAJ_DUZENLENDI": "mesaj_duzenlendi", "MESAJ_SILINDI": "mesaj_silindi", "TEPKI_EKLENDI": "tepki", "TEPKI_KALDIRILDI": "tepki_kaldirildi", "SUNUCUYA_EKLENDI": "sunucuya_eklendi", "SUNUCUDAN_CIKARILDI": "sunucudan_cikarildi", "ODA_OLUSTU": "oda_olustu", "ODA_GUNCELLENDI": "oda_guncellendi", "ODA_SILINDI": "oda_silindi", "ROL_OLUSTU": "rol_olustu", "ROL_GUNCELLENDI": "rol_guncellendi", "ROL_SILINDI": "rol_silindi", "SES_DURUMU": "ses_durumu", "ENERGY_GONDERILDI": "energy_gonderildi", "ENERGY_GERI_CEKILDI": "energy_geri_cekildi"}
        if t == "MESAJ_GELDI":
            if d.get("yazar") and self.ben and d["yazar"]["ad"] == self.ben["ad"]: return
            m = Mesaj(self, d)
            if self._bekleyene_ver("mesaj", m): return
            return await self._yay("mesaj", m)
        if t == "DURUM_GUNCELLENDI": return await self._yay("durum", d)
        if t == "HATA":
            print(f"[kanka] sunucu hatası: {d.get('hata')}"); return await self._yay("hata", d)
        if t == "DEVAM_EDILDI": return await self._yay("devam")
        if t in ("UYE_KATILDI", "UYE_AYRILDI", "UYE_GUNCELLENDI"): return await self._yay(t.lower(), d["uye"], d["sunucu"])
        if t in adlar: return await self._yay(adlar[t], d)
        if t in ("KOMUT", "BUTON", "SECIM", "FORM"):
            e = Etkilesim(self, d); fn = None
            if t != "KOMUT" and self._bekleyene_ver("etkilesim", e): return
            await self._yay("etkilesim", e)
            if t == "KOMUT": fn = (self.komutlar.get(d["veri"]["ad"]) or (None, None))[1]
            else:
                liste = {"BUTON": self._butonlar, "SECIM": self._secimler, "FORM": self._formlar}[t]
                for id, f in liste:
                    if (isinstance(id, str) and id == d["veri"]["id"]) or (hasattr(id, "match") and id.match(d["veri"]["id"])): fn = f; break
            if not fn and t == "KOMUT": print(f"[kanka] /{d['veri']['ad']} komutu için işleyici yok")
            if fn:
                try: await fn(e)
                except Exception as er:
                    print(f"[kanka] işleyicide hata: {er!r}")
                    if not e.cevaplandi:
                        try: await e.cevapla("⚠️ Bir şeyler ters gitti.", gizli=True)
                        except Exception: pass


# ---------- Ses bağlantısı (kanka.js'teki SesBaglantisi'nin Python karşılığı) ----------
# Bot kullanıcılara sadece GÖNDERİR (sendonly). Şarkıyı ffmpeg 48 kHz stereo PCM'e çözer; tek bir zamanlayıcı her 20 ms'de
# bir kare üretip bütün dinleyicilere dağıtır (her dinleyicinin kendi Opus kodlaması aiortc'de). Kimse yokken de zaman akar.
_AIORTC = None
def _aiortc():
    global _AIORTC
    if _AIORTC: return _AIORTC
    try:
        import aiortc, av, fractions
        from aiortc.sdp import candidate_from_sdp
        _AIORTC = (aiortc, av, fractions, candidate_from_sdp)
    except ImportError:
        raise KankaHata("Ses için aiortc gerekli: pip install aiortc (bilgisayarda ffmpeg de kurulu olmalı)")
    return _AIORTC

_ORNEK, _KARE = 48000, 960          # 20 ms
_KARE_BAYT = _KARE * 2 * 2          # stereo, 16 bit
_SESSIZ = bytes(_KARE_BAYT)
_KUYRUK_UST = 150                   # 3 sn ön bellek


def _es_izi_sinifi():
    aiortc, av, fractions, _ = _aiortc()
    class EsIzi(aiortc.MediaStreamTrack):
        kind = "audio"
        def __init__(self):
            super().__init__(); self.q = asyncio.Queue(maxsize=25); self.pts = 0
        async def recv(self):
            veri = await self.q.get()
            f = av.AudioFrame(format="s16", layout="stereo", samples=_KARE); f.planes[0].update(veri)
            f.sample_rate = _ORNEK; f.pts = self.pts; f.time_base = fractions.Fraction(1, _ORNEK); self.pts += _KARE
            return f
        def ver(self, veri):
            if self.q.full():
                try: self.q.get_nowait()
                except asyncio.QueueEmpty: pass
            self.q.put_nowait(veri)
    return EsIzi


class SesBaglantisi:
    """bot.sesli_odaya_katil() döndürür. Olaylar: @ses.olay("bitti") · basladi · baglandi · tasindi · kisi_katildi · kisi_ayrildi · susturma · ayrildi · hata"""
    def __init__(self, bot):
        self.bot = bot; self.oda = None; self.sunucu = None; self.sid = None; self.ice = []; self.esler = {}; self._izler = {}; self._kisiler = set()
        self.sira = []; self.susturuldu = False; self.duraklatildi = False; self.caliyor = None; self._istenen = None; self._olaylar = {}
        self.sayac = {"gonderilen": 0, "eksik": 0, "atlanan": 0}
        self._pompa = None; self._bakim = None

    # olaylar
    def olay(self, ad):
        def kaydet(fn): self._olaylar.setdefault(ad, []).append(fn); return fn
        return kaydet
    def _yay(self, ad, *a):
        for fn in self._olaylar.get(ad, []):
            async def calistir(fn=fn):
                try: await fn(*a)
                except Exception as e: print(f"[kanka] ses {ad} işleyicisinde hata: {e!r}")
            asyncio.ensure_future(calistir())

    @property
    def kisi_sayisi(self): return len(self.esler)
    @property
    def durum(self):
        """Anlık durum: { kisi, kuyruk, gonderilen, eksik, atlanan }"""
        return {"kisi": len(self.esler), "kuyruk": len(self.caliyor["kuyruk"]) if self.caliyor else 0, **self.sayac}

    # ---- eşler ----
    async def _sinyal(self, kime, veri): await self.bot._gonder({"op": 5, "d": {"kime": kime, "veri": veri}})
    def _es(self, sid):
        if sid in self.esler: return self.esler[sid]
        aiortc = _aiortc()[0]
        sunucular = []
        for x in self.ice or []:
            urls = x.get("urls"); urls = urls if isinstance(urls, list) else [urls]
            sunucular.append(aiortc.RTCIceServer(urls=urls, username=x.get("username"), credential=x.get("credential")))
        pc = aiortc.RTCPeerConnection(aiortc.RTCConfiguration(iceServers=sunucular))
        iz = _es_izi_sinifi()()
        pc.addTransceiver(iz, direction="sendonly")
        pc._yapiyor = False; pc._yoksay = False; pc._acildi = time.monotonic(); pc._durum = "new"; pc._durum_zamani = time.monotonic()
        self.esler[sid] = pc; self._izler[sid] = iz
        @pc.on("connectionstatechange")
        async def _durum_degisti():
            pc._durum = pc.connectionState; pc._durum_zamani = time.monotonic(); self.bot._log("ses", sid, pc.connectionState)
            if pc.connectionState in ("failed", "closed"): await self._kapat(sid, pc)
        return pc
    async def _teklif(self, sid):
        pc = self._es(sid)
        try:
            pc._yapiyor = True
            await pc.setLocalDescription(await pc.createOffer())  # aiortc adayları SDP'nin içine koyar (ayrı ICE yok)
            if self.esler.get(sid) is pc: await self._sinyal(sid, {"sdp": {"type": pc.localDescription.type, "sdp": pc.localDescription.sdp}})
        except Exception as e: self.bot._log("ses teklif hatası", repr(e))
        finally: pc._yapiyor = False
    async def _kapat(self, sid, sadece=None):
        pc = self.esler.get(sid)
        if pc is None or (sadece is not None and pc is not sadece): return
        self.esler.pop(sid, None); self._izler.pop(sid, None)
        try: await pc.close()
        except Exception: pass
    async def _hepsini_kapat(self):
        for sid in list(self.esler): await self._kapat(sid)
    async def _temizle(self):
        """Askıda kalan eşler: 15 sn kopuk ya da 30 sn'de bağlanamamış → kapat, kişi hâlâ odadaysa yeniden dene"""
        while True:
            await asyncio.sleep(5); t = time.monotonic()
            for sid, pc in list(self.esler.items()):
                if (pc._durum == "disconnected" and t - pc._durum_zamani > 15) or (pc._durum in ("new", "connecting") and t - pc._acildi > 30):
                    self.bot._log("ses", sid, "askıda kaldı, kapatıldı"); await self._kapat(sid, pc)
                    if self.oda and sid in self._kisiler: asyncio.ensure_future(self._teklif(sid))

    async def _olay(self, t, d):
        aday_coz = _aiortc()[3]
        if t == "SES_BAGLANDI":
            await self._hepsini_kapat(); self.oda = d["oda"]; self.sunucu = d.get("sunucu"); self.sid = d.get("sid"); self.ice = d.get("ice") or []
            self._kisiler = {k["sid"] for k in d.get("kisiler") or []}
            if self._pompa is None or self._pompa.done(): self._pompa = asyncio.ensure_future(self._pompala())
            if self._bakim is None or self._bakim.done(): self._bakim = asyncio.ensure_future(self._temizle())
            for k in d.get("kisiler") or []: asyncio.ensure_future(self._teklif(k["sid"]))
            f = self.bot._ses_bekle
            if f and not f.done(): f.set_result(self)
            return self._yay("tasindi" if d.get("tasindi") else "baglandi", d)
        if t == "SES_SINYAL":
            kimden, veri = d.get("kimden"), d.get("veri")
            if not veri or not self.oda: return
            pc = self.esler.get(kimden)
            if pc is None:
                if not (veri.get("sdp") or {}).get("type") == "offer": return  # ayrılmış kişiden geç gelen sinyal yeni bağlantı açmasın
                pc = self._es(kimden)
            try:
                if veri.get("sdp"):
                    sdp = veri["sdp"]; carpisma = sdp["type"] == "offer" and (pc._yapiyor or pc.signalingState != "stable")
                    pc._yoksay = carpisma
                    if carpisma: return  # bot "kaba" taraf: çakışmada kendi teklifinde kalır
                    await pc.setRemoteDescription(_aiortc()[0].RTCSessionDescription(sdp=sdp["sdp"], type=sdp["type"]))
                    if sdp["type"] == "offer" and self.esler.get(kimden) is pc:
                        await pc.setLocalDescription(await pc.createAnswer())
                        await self._sinyal(kimden, {"sdp": {"type": pc.localDescription.type, "sdp": pc.localDescription.sdp}})
                elif veri.get("ice") and not pc._yoksay:
                    c = veri["ice"]; metin = (c.get("candidate") or "").strip()
                    if metin:
                        aday = aday_coz(metin.split(":", 1)[1] if metin.startswith("candidate:") else metin)
                        aday.sdpMid = c.get("sdpMid"); aday.sdpMLineIndex = c.get("sdpMLineIndex")
                        await pc.addIceCandidate(aday)
            except Exception as e: self.bot._log("ses sinyal hatası", repr(e))
            return
        if t == "SES_KISI_KATILDI": self._kisiler.add(d.get("sid")); return self._yay("kisi_katildi", d)
        if t == "SES_KISI_AYRILDI": self._kisiler.discard(d.get("sid")); await self._kapat(d.get("sid")); return self._yay("kisi_ayrildi", d)
        if t == "SES_KISI_YENILENDI":
            if d.get("eski"): await self._kapat(d["eski"])
            return
        if t == "SES_SUSTURMA": self.susturuldu = bool(d.get("susturuldu")); return self._yay("susturma", d)
        if t == "SES_AYRILDI":
            await self._hepsini_kapat(); o = self.oda; self.oda = None; self.durdur()
            return self._yay("ayrildi", {"oda": o, "sebep": d.get("sebep")})

    # ---- zamanlayıcı: her 20 ms bir kare ----
    async def _pompala(self):
        bas = time.monotonic(); n = 0
        while True:
            n += 1; hedef = bas + n * 0.02; bekle = hedef - time.monotonic()
            if bekle > 0: await asyncio.sleep(bekle)
            elif bekle < -0.2:  # takıldık: eski kareleri atla, canlıya dön
                at = int(-bekle / 0.02) - 2; n += at
                c = self.caliyor
                for _ in range(at):
                    if c and c["kuyruk"]: c["kuyruk"].popleft(); self.sayac["atlanan"] += 1
            kare = self._kare()
            if not self.esler: continue
            if kare is None or self.susturuldu: kare = _SESSIZ
            else: self.sayac["gonderilen"] += 1
            for iz in list(self._izler.values()): iz.ver(kare)
    def _kare(self):
        c = self.caliyor
        if c is None or self.duraklatildi: return None
        if c["kuyruk"]:
            k = c["kuyruk"].popleft()
            if len(c["kuyruk"]) < 50: c["devam"].set()
            c["basladi"] = True; return k
        if c["bitti"]: asyncio.ensure_future(self._bitir(c)); return None
        if c["basladi"]: self.sayac["eksik"] += 1  # kaynak yetişemedi: sessizlik
        return None

    # ---- çalma ----
    def cal(self, kaynak, ses=1.0, baslangic=0, ffmpeg=None):
        """Çal. kaynak: dosya yolu ya da http(s) adresi (ffmpeg'in açabildiği her şey).
        ses: ses düzeyi (0-2) · baslangic: kaçıncı saniyeden · ffmpeg: ffmpeg'in yolu (yoksa FFMPEG_PATH ya da "ffmpeg")
        Döner: şarkı bitince ya da durdurulunca biten bir görev. await ses.cal(...) dersen şarkının bitmesini bekler."""
        self.durdur(sira_kalsin=True)
        c = {"kaynak": kaynak, "kuyruk": __import__("collections").deque(), "bitti": False, "basladi": False, "son": False, "durduruldu": False,
             "devam": asyncio.Event(), "bitis": asyncio.get_running_loop().create_future(), "p": None}
        c["devam"].set(); self.caliyor = c
        c["gorev"] = asyncio.ensure_future(self._oku(c, kaynak, ses, baslangic, ffmpeg))
        self._yay("basladi", {"kaynak": kaynak})
        return c["bitis"]
    async def _oku(self, c, kaynak, sv, baslangic, ff):
        ff = ff or os.environ.get("FFMPEG_PATH") or "ffmpeg"
        sv = max(0.0, min(2.0, float(sv if sv is not None else 1)))
        af = ["-af", f"volume={sv}" + (",alimiter=limit=0.95" if sv > 1 else "")] if sv != 1 else []
        ag = ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"] if re.match(r"^https?:", str(kaynak), re.I) else []
        args = [ff, "-hide_banner", "-loglevel", "error", *(["-ss", str(baslangic)] if baslangic else []), *ag, "-i", str(kaynak), "-vn", *af, "-ac", "2", "-ar", str(_ORNEK), "-f", "s16le", "pipe:1"]
        try:
            p = c["p"] = await asyncio.create_subprocess_exec(*args, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        except FileNotFoundError:
            c["bitti"] = True; self._yay("hata", KankaHata("ffmpeg bulunamadı: bilgisayarına ffmpeg kur (ya da ffmpeg= ile yolunu ver)")); return
        artik = b""
        try:
            while not c["son"]:
                if len(c["kuyruk"]) > _KUYRUK_UST: c["devam"].clear(); await c["devam"].wait(); continue
                parca = await p.stdout.read(_KARE_BAYT * 10)
                if not parca: break
                artik += parca
                while len(artik) >= _KARE_BAYT: c["kuyruk"].append(artik[:_KARE_BAYT]); artik = artik[_KARE_BAYT:]
        finally:
            c["bitti"] = True
            kod = await p.wait() if not c["son"] else None
            if kod and not c["durduruldu"] and not c["kuyruk"]:
                hata = (await p.stderr.read()).decode(errors="ignore").strip()[-300:]
                self._yay("hata", KankaHata("ffmpeg: " + (hata or f"çalınamadı (kod {kod})")))
    async def _bitir(self, c, durduruldu=False):
        if c["son"]: return
        c["son"] = True; c["devam"].set(); c["kuyruk"].clear()
        try:
            if c["p"] and c["p"].returncode is None: c["p"].kill()
        except ProcessLookupError: pass
        if self.caliyor is c: self.caliyor = None
        if not c["bitis"].done(): c["bitis"].set_result({"durduruldu": durduruldu})
        if not durduruldu:
            self._yay("bitti", {"kaynak": c["kaynak"]})
            if self.sira: s = self.sira.pop(0); self.cal(s[0], **s[1])
    def siraya(self, kaynak, **ayar):
        """Sıraya ekle; bir şey çalmıyorsa hemen başlar. Döner: sıradaki yeri (0 = hemen çalıyor)"""
        if self.caliyor is None: self.cal(kaynak, **ayar); return 0
        self.sira.append((kaynak, ayar)); return len(self.sira)
    def gec(self):
        """Sonraki şarkıya geç"""
        c = self.caliyor
        if c: c["durduruldu"] = True; asyncio.ensure_future(self._bitir(c, True)); self.caliyor = None
        if self.sira: s = self.sira.pop(0); self.cal(s[0], **s[1])
    def duraklat(self): self.duraklatildi = True
    def devam(self): self.duraklatildi = False
    def durdur(self, sira_kalsin=False):
        """Çalanı durdur (sıra da temizlenir)"""
        c = self.caliyor
        if c: c["durduruldu"] = True; asyncio.ensure_future(self._bitir(c, True)); self.caliyor = None
        if not sira_kalsin: self.sira = []
        self.duraklatildi = False
    async def ayril(self): await self.bot.sesten_ayril()
