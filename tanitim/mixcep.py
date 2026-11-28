#!/usr/bin/env python3
# Cep Öncüsü videosu müziği (21 sn): beta50s ile aynı yapı, 5 özellik geçişi.
import numpy as np, json, wave, sys
from scipy.signal import lfilter
SR = 44100
M = json.load(open(sys.argv[1])); T = M['TOT']; N = int(round(T * SR)); K = M['M']
L = np.zeros(N); R = np.zeros(N); rng = np.random.default_rng(7)
def add(sig, at, g=1.0, pan=0.0):
    i = int(round(at * SR)) % N
    s = sig * g; l = s * np.sqrt(.5 * (1 - pan)); r = s * np.sqrt(.5 * (1 + pan))
    idx = np.arange(len(s)) + i; ok = idx < N  # bu sürüm döngü değil: taşan kısım kesilir
    np.add.at(L, idx[ok], l[ok]); np.add.at(R, idx[ok], r[ok])
def env(n, a=.005, d=.2): x = np.arange(n) / SR; return np.minimum(1, x / a) * np.exp(-x / d)
def lp(x, c): return lfilter([c], [1, c - 1], x)
B = .5
def kick():
    n = int(.34 * SR); x = np.arange(n) / SR; f = 45 + 130 * np.exp(-x * 26)
    return np.tanh(2.4 * np.sin(2 * np.pi * np.cumsum(f) / SR) * env(n, .001, .17))
def clap():
    n = int(.25 * SR); w = rng.standard_normal(n); e = np.zeros(n)
    for o in (0, .01, .021): k = int(o * SR); e[k:] += env(n - k, .0005, .012)
    e += env(n, .002, .1) * .5; return (w - lp(w, .25)) * e
def hat(op=False):
    n = int((.2 if op else .05) * SR); w = rng.standard_normal(n); return (w - lp(w, .6)) * env(n, .0005, .07 if op else .012)
def saw(f, n, d=0.): x = np.arange(n) / SR; return 2 * ((f * (1 + d) * x) % 1) - 1
def pad(fs, n):
    s = sum(saw(f, n, d) for f in fs for d in (-.006, 0, .006)) / (len(fs) * 3); s = lp(s, .05)
    x = np.arange(n) / SR; return s * np.minimum(1, x / .05) * np.minimum(1, (n / SR - x) / .05)
def impact(g=1.):
    n = int(1.4 * SR); x = np.arange(n) / SR; w = rng.standard_normal(n)
    return (np.sin(2 * np.pi * np.cumsum(38 + 170 * np.exp(-x * 16)) / SR) * np.exp(-x * 3.5) * 1.2 + lp(w, .3) * np.exp(-x * 8) * .8) * g
def pluck(f, ln=.35):
    n = int(ln * SR); x = np.arange(n) / SR
    s = (np.sin(2 * np.pi * f * x) + .5 * np.sin(2 * np.pi * 2 * f * x) + .25 * np.sign(np.sin(2 * np.pi * f * x)))
    return s * env(n, .002, .09)
def bell(f, ln=1.2):
    n = int(ln * SR); x = np.arange(n) / SR
    return sum(np.sin(2 * np.pi * f * m * x) * a * np.exp(-x * (2 + m)) for m, a in ((1, 1), (2.76, .5), (5.4, .25), (8.9, .12)))
def riser(ln):
    n = int(ln * SR); w = rng.standard_normal(n); x = np.arange(n) / SR
    y = lfilter([.08], [1, -.92], w) * 0  # yer tutucu
    cs = .01 + .6 * (x / ln) ** 2; a = 0.; y = np.zeros(n)
    for i in range(n): a += cs[i] * (w[i] - a); y[i] = a
    tone = np.sin(2 * np.pi * np.cumsum(180 + 1500 * (x / ln) ** 2) / SR) * .25
    return (y * 1.4 + tone) * (x / ln) ** 2

def whoosh(ln=.35):
    n = int(ln * SR); w = rng.standard_normal(n); x = np.arange(n) / SR
    return lp(w, .15) * np.sin(np.pi * x / ln) ** 2 * 1.5
CH = [[220, 261.6, 329.6], [174.6, 220, 261.6], [261.6, 329.6, 392], [196, 246.9, 293.7]]
BASS = [55, 43.65, 65.41, 49]
def music(a, b):
    bar = int(a // 2)
    while bar * 2 < b - .01:
        at = max(a, bar * 2); e = min(b, bar * 2 + 2); c = bar % 4; n = int((e - at) * SR)
        if n > 100:
            add(pad(CH[c], n), at, .22, -.2); add(pad([f * 2 for f in CH[c]], n), at, .08, .25)
            q = at
            while q < e - .01:
                m = int(.25 * SR); x = np.arange(m) / SR
                add(lp(saw(BASS[c] * 2, m), .1) * np.minimum(1, x / .01) * np.exp(-x / .15), q, .5); q += .25
        bar += 1
def drums(a, b, half=False, build=False):
    k = 0
    while a + k * B < b - .01:
        at = a + k * B
        if not half or k % 2 == 0: add(kick(), at, .9)
        if build: add(kick(), at + B / 2, .6)
        if (k % 2 == 1) and not half: add(clap(), at, .5)
        if half and k % 4 == 2: add(clap(), at, .55)
        add(hat(), at + B / 2, .2, .35); add(hat(), at + B * .75, .09, -.4)
        k += 1
tm = {m['k']: m['t'] for m in K}
RISE, BADGE, TICK, DROP, CTA = tm['rise'], tm['badge'], tm['tick'], tm['drop'], tm['cta']
H = tm['whoosh']
music(H, RISE); drums(H, RISE)
music(BADGE, TICK); drums(BADGE, TICK, half=True)
music(TICK, DROP); drums(TICK, DROP, build=True)
music(DROP, T); drums(DROP, T)
for m in K:
    t, k = m['t'], m['k']
    if k == 'slam': add(impact(.8), t, .8); add(kick(), t, .9)
    elif k == 'slam2': add(impact(1.), t, 1.); add(kick(), t, 1.); add(bell(440), t, .25)
    elif k == 'whoosh': add(whoosh(.5), t - .1, .5)
    elif k == 'swipe': add(whoosh(.3), t - .08, .45, .5 - (m['i'] % 2)); add(pluck(440 * 2 ** ([0, 4, 7, 12, 16][m['i'] % 5] / 12)), t, .3)
    elif k == 'rise': add(riser(BADGE - t), t, .5)
    elif k == 'badge': add(impact(1.), t, .9); add(bell(659.3, 2), t, .35); add(bell(987.8, 2), t + .06, .25, .3); add(bell(1318.5, 2), t + .12, .15, -.3)
    elif k == 'tick':
        for j in range(30):
            tt = t + 1.5 * (1 - (1 - j / 30) ** 2); add(pluck(880 + j * 20, .06), tt, .12, .3 - .6 * (j % 2))
        add(riser(1.5), t, .35)
    elif k == 'drop': add(impact(1.), t, 1.); add(bell(523.3, 2), t, .3)
    elif k == 'cta': add(impact(.7), t, .6); add(bell(880, 1.5), t, .25)
fade = np.ones(N); nf = int(1.2 * SR); fade[-nf:] = np.linspace(1, 0, nf)
L *= fade; R *= fade
mx = np.stack([L, R], 1); mx /= np.max(np.abs(mx)) / .89
with wave.open(sys.argv[2], 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes((mx * 32767).astype('<i2').tobytes())
print('ok', T)
