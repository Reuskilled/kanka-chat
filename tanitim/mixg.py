#!/usr/bin/env python3
# Yorumlarla Kanka #1 müziği: 128 BPM trap/house melezi. Kanca: siren + darbeler; groove; sayaçta kırılma + yükseliş; GİT'te düşüş.
import numpy as np, json, wave, sys
SR = 44100
M = json.load(open(sys.argv[1])); T = M['TOT']; N = int(T * SR); K = M['M']
L = np.zeros(N); R = np.zeros(N); rng = np.random.default_rng(11)
def add(sig, at, g=1.0, pan=0.0):
    i = int(at * SR)
    if i >= N: return
    if i < 0: sig = sig[-i:]; i = 0
    j = min(N, i + len(sig)); s = sig[:j - i] * g
    L[i:j] += s * np.sqrt(.5 * (1 - pan)); R[i:j] += s * np.sqrt(.5 * (1 + pan))
def env(n, a=.005, d=.2): x = np.arange(n) / SR; return np.minimum(1, x / a) * np.exp(-x / d)
def lp(x, c):
    from scipy.signal import lfilter
    return lfilter([c], [1, c - 1], x)
B = 60 / 128; bt = lambda n: n * B
GO = K['go'][0]; HOOK = bt(8); BRK = bt(32); CTA = bt(52)
def kick(g=1):
    n = int(.34 * SR); x = np.arange(n) / SR; f = 45 + 120 * np.exp(-x * 26)
    return np.tanh(2.2 * np.sin(2 * np.pi * np.cumsum(f) / SR) * env(n, .001, .18)) * g + rng.standard_normal(n) * env(n, .0004, .004) * .3
def clap():
    n = int(.25 * SR); w = rng.standard_normal(n); e = np.zeros(n)
    for o in (0, .01, .021): k = int(o * SR); e[k:] += env(n - k, .0005, .012)
    e += env(n, .002, .1) * .5; return (w - lp(w, .25)) * e
def hat(op=False):
    n = int((.2 if op else .05) * SR); w = rng.standard_normal(n); return (w - lp(w, .6)) * env(n, .0005, .07 if op else .012)
def saw(f, n, d=0.): x = np.arange(n) / SR; return 2 * ((f * (1 + d) * x) % 1) - 1
def pad(fs, n):
    s = sum(saw(f, n, d) for f in fs for d in (-.005, 0, .005)) / (len(fs) * 3); s = lp(s, .05)
    x = np.arange(n) / SR; return s * np.minimum(1, x / .2) * np.minimum(1, (n / SR - x) / .2)
def boom(ln=2.4):
    n = int(ln * SR); x = np.arange(n) / SR
    return np.sin(2 * np.pi * np.cumsum(28 + 100 * np.exp(-x * 5)) / SR) * np.exp(-x * 1.5) + rng.standard_normal(n) * np.exp(-x * 10) * .6
def impact():
    n = int(1.2 * SR); x = np.arange(n) / SR; w = rng.standard_normal(n)
    return np.sin(2 * np.pi * np.cumsum(40 + 160 * np.exp(-x * 18)) / SR) * np.exp(-x * 4) * 1.2 + lp(w, .3) * np.exp(-x * 9) * .9
def siren(ln, lvl=1):
    n = int(ln * SR); x = np.arange(n) / SR
    f = np.where((x / .47) % 2 < 1, 960, 720) * (1 + .01 * np.sin(2 * np.pi * 6 * x))
    s = np.sign(np.sin(2 * np.pi * np.cumsum(f) / SR)) * .3 + np.sin(2 * np.pi * np.cumsum(f) / SR)
    return lp(s, .2) * np.minimum(1, x / .05) * np.minimum(1, (ln - x) / .3) * lvl
def riser(ln):
    n = int(ln * SR); w = rng.standard_normal(n); x = np.arange(n) / SR; y = np.zeros(n); a = 0.
    cs = .004 + .5 * (x / ln) ** 2
    for i in range(n): a += cs[i] * (w[i] - a); y[i] = a
    tone = np.sin(2 * np.pi * np.cumsum(200 + 1400 * (x / ln) ** 2) / SR) * .25
    return (y * 1.6 + tone) * (x / ln) ** 2
CH = [[174.6, 207.7, 261.6], [138.6, 174.6, 207.7], [207.7, 261.6, 311.1], [155.6, 196.0, 233.1]]
BASS = [43.65, 34.65, 51.91, 38.89]
def groove(a, b, arp=True, hard=False):
    k = 0
    while a + k * B < b - .01:
        at = a + k * B; q = k % 4
        add(kick(), at, .95)
        if q in (1, 3): add(clap(), at, .55)
        add(hat(), at + B / 2, .22, .35); add(hat(), at + B * .75, .1, -.4)
        if hard: add(hat(True), at + B / 2, .12, -.3)
        k += 1
    i = 0
    while a + i * bt(4) < b - .01:
        at = a + i * bt(4); n = int(min(bt(4), b - at) * SR); c = int(round((at - HOOK) / bt(4))) % 4
        add(pad(CH[c], n), at, .26, -.2); add(pad([f * 2 for f in CH[c]], n), at, .1, .25)
        for q in range(8):
            a2 = at + q * B / 2
            if a2 >= b - .02: break
            m = int(B / 2 * SR); x = np.arange(m) / SR
            add(lp(saw(BASS[c] * 2, m), .09) * np.minimum(1, x / .03) * np.exp(-x / .2), a2, .55)
        if arp:
            nts = CH[c] + [CH[c][0] * 2]
            for q in range(16):
                a2 = at + q * B / 4
                if a2 >= b - .02: break
                f = nts[q % 4] * 2; m = int(.12 * SR); x = np.arange(m) / SR
                add((np.sign(np.sin(2 * np.pi * f * x)) * .4 + np.sin(2 * np.pi * f * x)) * env(m, .002, .05), a2, .07, .5 if q % 2 else -.5)
        i += 1
# kanca: her vuruşta kick + siren + darbeler
# gece girişi: pad + saat tıkırtısı + plak cızırtısı
n0 = int(HOOK * SR); add(pad([87.3, 130.8, 174.6, 207.7], n0), 0, .4)
cr = rng.standard_normal(n0) * (rng.random(n0) > .9993) * 3 + rng.standard_normal(n0) * .015; add(lp(cr, .5), 0, .5)
for k in range(8):
    m = int(.03 * SR); x = np.arange(m) / SR; add(np.sin(2 * np.pi * 2600 * x) * env(m, .0005, .006), bt(k), .25, .3 if k % 2 else -.3)
for a in K['slam']: add(impact(), a, .45, 0)
add(boom(), 0, .35)
# groove 1 (arp yarıdan sonra)
groove(HOOK, bt(16), arp=False); groove(bt(16), BRK)
# kırılma: pad + kalp atışı + riser + siren
n = int((GO - BRK) * SR); add(pad([87.3, 130.8, 174.6], n), BRK, .35)
for k in range(int((GO - BRK) / B)):
    at = BRK + k * B
    if at >= bt(35): add(kick(.8), at, .55)
add(riser(GO - bt(35) - .02), bt(35), .55)
def beep(f, d=.14):
    m = int(d * SR); x = np.arange(m) / SR; return np.sign(np.sin(2 * np.pi * f * x)) * env(m, .002, d / 2.5)
for i, a in enumerate(K['beep']): add(beep(660 if i < 2 else 880), a, .25)
# GİT: düşüş
add(boom(3), GO, 1.0); add(impact(), GO, .7); add(beep(1320, .5), GO, .25)
n = int(2.5 * SR); w = rng.standard_normal(n); add((w - lp(w, .5)) * np.exp(-np.arange(n) / SR * 1.8), GO, .35)  # zil
groove(GO, CTA - B, hard=True)
# CTA
add(boom(), CTA, .8)
nn = int((T - CTA) * SR); add(pad([174.6, 207.7, 261.6, 349.2], nn) * np.exp(-np.arange(nn) / SR / 4), CTA, .45)
for k in range(int((T - CTA - 1) / B)):
    at = CTA + bt(2) + k * B
    if at < T - .6: add(kick(), at, .55); add(hat(), at + B / 2, .14, .3)
# efektler
def whoosh():
    n = int(.45 * SR); w = rng.standard_normal(n); x = np.arange(n) / SR; y = lp(w, .12)
    return y * np.sin(np.pi * x / .45) ** 2 * 2.2
def pop():
    n = int(.12 * SR); x = np.arange(n) / SR; return np.sin(2 * np.pi * (500 + 2400 * np.exp(-x * 40)) * x) * env(n, .001, .04)
def key():
    n = int(.035 * SR); w = rng.standard_normal(n); return (w - lp(w, .3)) * env(n, .0005, .007)
def click():
    n = int(.08 * SR); x = np.arange(n) / SR; return np.sin(2 * np.pi * 1500 * x) * env(n, .0005, .015) + key()[:n] if False else np.sin(2 * np.pi * 1500 * x) * env(n, .0005, .015)
for a in K['whoosh']: add(whoosh(), a - .22, .5, rng.uniform(-.4, .4))
for a in K['pop']: add(pop(), a, .3, rng.uniform(-.3, .3))
for a in K['type']: add(key(), a + rng.uniform(0, .015), .3)
for a in K['tap']: add(click(), a, .4)
for a in K['stamp']: add(impact(), a, .7); add(kick(1.2), a, .6)
mx = np.stack([L, R]); mx = np.tanh(mx * 1.25) / np.tanh(1.25)
fo = int(.6 * SR); mx[:, -fo:] *= np.linspace(1, 0, fo)
mx = mx / np.max(np.abs(mx)) * .89
out = (mx.T * 32767).astype(np.int16)
w = wave.open(sys.argv[2], 'wb'); w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(out.tobytes()); w.close(); print('ok', T)
