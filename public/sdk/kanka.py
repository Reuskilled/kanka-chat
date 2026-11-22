"""kanka.py: Kanka Chat bot kütüphanesi (Python 3.9+, gereksinim: aiohttp)

Belgeler: https://kankahq.com/gelistirici

    import os, random, kanka
    bot = kanka.Bot(token=os.environ["KANKA_TOKEN"], durum={"durum": "cevrimici", "aktivite": {"tur": "oynuyor", "ad": "/zar"}})

    @bot.komut("zar", aciklama="Zar at", secenekler=[kanka.Secenek("yuz", "tamsayi", "Kaç yüzlü?")])
    async def zar(k):
        await k.cevapla(f"🎲 {random.randint(1, k.secenek('yuz', 6))}")

    bot.calistir()
"""
import asyncio, time, random, hashlib, hmac, json, re
from urllib.parse import quote
import aiohttp

SURUM = "1.3.1"


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
    async def gonder(self, oda, icerik):
        return Mesaj(self, (await self.api("POST", f"/odalar/{oda}/mesajlar", _govde(icerik)))["mesaj"])
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
        sunucuya_eklendi, sunucudan_cikarildi, etkilesim, durum, hata"""
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
            nabiz = None
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
            return await self._yay("hazir")
        adlar = {"MESAJ_DUZENLENDI": "mesaj_duzenlendi", "MESAJ_SILINDI": "mesaj_silindi", "TEPKI_EKLENDI": "tepki", "TEPKI_KALDIRILDI": "tepki_kaldirildi", "SUNUCUYA_EKLENDI": "sunucuya_eklendi", "SUNUCUDAN_CIKARILDI": "sunucudan_cikarildi"}
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
