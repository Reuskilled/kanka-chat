"""kanka.py: Kanka Chat bot kütüphanesi (Python 3.9+, gereksinim: aiohttp)

Belgeler: https://kankahq.com/gelistirici

    import os, random, kanka
    bot = kanka.Bot(token=os.environ["KANKA_TOKEN"])

    @bot.komut("zar", aciklama="Zar at", secenekler=[kanka.Secenek("yuz", "tamsayi", "Kaç yüzlü?")])
    async def zar(k):
        await k.cevapla(f"🎲 {random.randint(1, k.secenek('yuz', 6))}")

    bot.calistir()
"""
import asyncio, hashlib, hmac, json, re, time
import aiohttp

SURUM = "1.0.0"


class KankaHata(Exception):
    def __init__(self, mesaj, durum=None, veri=None):
        super().__init__(mesaj); self.durum = durum; self.veri = veri


def Secenek(ad, tur="yazi", aciklama="", zorunlu=False, secimler=None):
    """Komut seçeneği. tur: yazi, sayi, tamsayi, kisi, oda, rol, evethayir"""
    return {"ad": ad, "tur": tur, "aciklama": aciklama or ad, "zorunlu": zorunlu, "secimler": [{"ad": str(a), "deger": d} for a, d in (secimler or [])]}


def Buton(id, etiket, stil="ana", emoji=None, kapali=False):
    return {"tur": "buton", "id": id, "etiket": etiket, "stil": stil, "emoji": emoji, "kapali": kapali}


def LinkButon(url, etiket):
    return {"tur": "buton", "stil": "link", "url": url, "etiket": etiket}


def Secim(id, secenekler, yer_tutucu="Bir seçenek seç", min=1, max=1):
    return {"tur": "secim", "id": id, "yerTutucu": yer_tutucu, "min": min, "max": max,
            "secenekler": [o if isinstance(o, dict) else {"etiket": o, "deger": o} for o in secenekler]}


class Kart(dict):
    """Kart (embed): Kart(baslik="...", aciklama="...", renk="#ff8a4c").alan("ad", "değer", satir=True)"""
    def __init__(self, baslik=None, aciklama=None, renk=None, url=None, resim=None, kucuk_resim=None, altyazi=None):
        super().__init__({k: v for k, v in dict(baslik=baslik, aciklama=aciklama, renk=renk, url=url, resim=resim, kucukResim=kucuk_resim, altyazi=altyazi).items() if v})
    def alan(self, ad, deger, satir=False):
        self.setdefault("alanlar", []).append({"ad": ad, "deger": str(deger), "satir": satir}); return self


def _govde(x):
    return {"icerik": x} if isinstance(x, str) else dict(x or {})


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
    def kullanici(self): return self["kullanici"]
    async def _istek(self, yontem, yol, veri):
        async with self._bot._oturum.request(yontem, f"{self._bot.adres}/api/v1/etkilesim/{self['id']}/{self['token']}{yol}", json=veri) as r:
            j = await r.json(content_type=None)
            if r.status >= 400: raise KankaHata((j or {}).get("hata", f"HTTP {r.status}"), r.status, j)
            return j
    async def cevapla(self, icerik, gizli=False):
        """3 saniye içinde cevap ver. gizli=True ise sadece komutu kullanan görür."""
        self.cevaplandi = True; return await self._istek("POST", "/cevap", {"tur": "mesaj", **_govde(icerik), **({"gizli": True} if gizli else {})})
    async def bekle(self, gizli=False):
        """Uzun işler için: önce 'düşünüyor…', sonra duzenle() ile bitir (15 dakika)."""
        self.cevaplandi = True; return await self._istek("POST", "/cevap", {"tur": "bekle", "gizli": gizli})
    async def guncelle(self, icerik):
        """Butona basılan mesajı yerinde değiştir."""
        self.cevaplandi = True; return await self._istek("POST", "/cevap", {"tur": "guncelle", **_govde(icerik)})
    async def form_ac(self, id, baslik, alanlar):
        """alanlar: [{"id": "oyun", "etiket": "En sevdiğin oyun", "tur": "kisa"|"uzun", "zorunlu": True}]"""
        self.cevaplandi = True; return await self._istek("POST", "/cevap", {"tur": "form", "form": {"id": id, "baslik": baslik, "alanlar": alanlar}})
    async def duzenle(self, icerik):
        return await self._istek("PATCH", "/mesaj", _govde(icerik))
    async def takip(self, icerik, gizli=False):
        return await self._istek("POST", "/takip", {**_govde(icerik), **({"gizli": True} if gizli else {})})


class Bot:
    def __init__(self, token, niyetler=("mesajlar", "uyeler", "tepkiler", "dm"), adres="https://kankahq.com"):
        if not token: raise KankaHata("token gerekli (Geliştirici Portalı › botun › Token)")
        self.token = re.sub(r"^Bot\s+", "", token); self.niyetler = list(niyetler); self.adres = adres.rstrip("/")
        self.komutlar = {}; self.sunucu_komutlari = {}; self._butonlar = []; self._secimler = []; self._formlar = []; self._olaylar = {}
        self.ben = None; self.sunucular = {}; self._oturum = None; self._oturum_id = None; self._sira = 0

    # ---------- REST ----------
    async def api(self, yontem, yol, veri=None):
        for _ in range(4):
            async with self._oturum.request(yontem, f"{self.adres}/api/v1{yol}", json=veri, headers={"Authorization": "Bot " + self.token, "User-Agent": "kanka.py/" + SURUM}) as r:
                j = await r.json(content_type=None)
                if r.status == 429: await asyncio.sleep((j or {}).get("tekrarDene", 1) + 0.1); continue
                if r.status >= 400: raise KankaHata((j or {}).get("hata", f"HTTP {r.status}"), r.status, j)
                return j
        raise KankaHata("Hız sınırı", 429)
    async def gonder(self, oda, icerik):
        return Mesaj(self, (await self.api("POST", f"/odalar/{oda}/mesajlar", _govde(icerik)))["mesaj"])
    async def dm(self, kullanici, icerik):
        return Mesaj(self, (await self.api("POST", f"/kullanicilar/{kullanici}/dm", _govde(icerik)))["mesaj"])
    async def duzenle(self, oda, mesaj, icerik): return await self.api("PATCH", f"/odalar/{oda}/mesajlar/{mesaj}", _govde(icerik))
    async def sil(self, oda, mesaj): return await self.api("DELETE", f"/odalar/{oda}/mesajlar/{mesaj}")
    async def tepki(self, oda, mesaj, emoji):
        from urllib.parse import quote
        return await self.api("PUT", f"/odalar/{oda}/mesajlar/{mesaj}/tepkiler/{quote(emoji)}")
    async def uyeler(self, sunucu): return (await self.api("GET", f"/sunucular/{sunucu}/uyeler"))["uyeler"]
    async def rol_ver(self, sunucu, kisi, rol): return await self.api("PUT", f"/sunucular/{sunucu}/uyeler/{kisi}/roller/{rol}")
    async def rol_al(self, sunucu, kisi, rol): return await self.api("DELETE", f"/sunucular/{sunucu}/uyeler/{kisi}/roller/{rol}")
    async def sustur(self, sunucu, kisi, dakika=10, sebep=""): return await self.api("POST", f"/sunucular/{sunucu}/uyeler/{kisi}/sustur", {"dakika": dakika, "sebep": sebep})
    async def at(self, sunucu, kisi, sebep=""): return await self.api("DELETE", f"/sunucular/{sunucu}/uyeler/{kisi}", {"sebep": sebep})
    async def yasakla(self, sunucu, kisi, sebep=""): return await self.api("PUT", f"/sunucular/{sunucu}/yasaklar/{kisi}", {"sebep": sebep})

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
        """Olaylar: hazir, mesaj, mesaj_duzenlendi, mesaj_silindi, uye_katildi, uye_ayrildi, uye_guncellendi, tepki, sunucuya_eklendi, sunucudan_cikarildi"""
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
                try:
                    await self._baglan(); bekle = 1
                except KankaHata as e:
                    if e.durum in (4004, 4014): raise
                    print(f"[kanka] bağlantı koptu: {e}")
                except Exception as e:
                    print(f"[kanka] bağlantı koptu: {e!r}")
                await asyncio.sleep(bekle); bekle = min(30, bekle * 2)

    async def _baglan(self):
        async with self._oturum.ws_connect(self.adres.replace("http", "ws", 1) + "/bot/gateway", heartbeat=None) as ws:
            nabiz = None
            async for m in ws:
                if m.type != aiohttp.WSMsgType.TEXT: break
                p = json.loads(m.data)
                if p["op"] == 10:
                    async def nabiz_at(araligi=p["d"].get("nabizAraligi", 30000) / 1000):
                        while True: await asyncio.sleep(araligi); await ws.send_json({"op": 1, "d": self._sira})
                    nabiz = asyncio.create_task(nabiz_at())
                    if self._oturum_id: await ws.send_json({"op": 6, "d": {"token": self.token, "oturum": self._oturum_id, "sira": self._sira, "niyetler": self.niyetler}})
                    else: await ws.send_json({"op": 2, "d": {"token": self.token, "niyetler": self.niyetler}})
                elif p["op"] == 0:
                    if p.get("s"): self._sira = p["s"]
                    asyncio.create_task(self._olay(p["t"], p["d"]))
            if nabiz: nabiz.cancel()
            if ws.close_code in (4004, 4014): raise KankaHata(f"Bağlantı reddedildi ({ws.close_code})", ws.close_code)
            raise KankaHata(f"kapandı ({ws.close_code})", ws.close_code)

    async def _olay(self, t, d):
        if t == "HAZIR":
            self._oturum_id = d["oturum"]; self.ben = d["bot"]; self.sunucular = {s["id"]: s for s in d["sunucular"]}
            return await self._yay("hazir")
        adlar = {"MESAJ_DUZENLENDI": "mesaj_duzenlendi", "MESAJ_SILINDI": "mesaj_silindi", "TEPKI_EKLENDI": "tepki", "TEPKI_KALDIRILDI": "tepki_kaldirildi", "SUNUCUYA_EKLENDI": "sunucuya_eklendi", "SUNUCUDAN_CIKARILDI": "sunucudan_cikarildi"}
        if t == "MESAJ_GELDI":
            if d.get("yazar") and self.ben and d["yazar"]["ad"] == self.ben["ad"]: return
            return await self._yay("mesaj", Mesaj(self, d))
        if t in ("UYE_KATILDI", "UYE_AYRILDI", "UYE_GUNCELLENDI"): return await self._yay(t.lower(), d["uye"], d["sunucu"])
        if t in adlar: return await self._yay(adlar[t], d)
        if t in ("KOMUT", "BUTON", "SECIM", "FORM"):
            e = Etkilesim(self, d); fn = None
            if t == "KOMUT": fn = (self.komutlar.get(d["veri"]["ad"]) or (None, None))[1]
            else:
                liste = {"BUTON": self._butonlar, "SECIM": self._secimler, "FORM": self._formlar}[t]
                for id, f in liste:
                    if (isinstance(id, str) and id == d["veri"]["id"]) or (hasattr(id, "match") and id.match(d["veri"]["id"])): fn = f; break
            if fn:
                try: await fn(e)
                except Exception as er:
                    print(f"[kanka] işleyicide hata: {er!r}")
                    if not e.cevaplandi:
                        try: await e.cevapla("⚠️ Bir şeyler ters gitti.", gizli=True)
                        except Exception: pass
