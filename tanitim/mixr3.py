#!/usr/bin/env python3
# Rozet 3 müziği: 120 BPM, 16 sn, kesintisiz döngü (kuyruklar başa sarılır).
# Kanca vuruşu t=0'da; sondaki yükseliş tekrar başa, kancaya bağlanır.
import numpy as np, json, wave, sys
from scipy.signal import lfilter
SR = 44100
M = json.load(open(sys.argv[1])); T = M['TOT']; N = int(round(T * SR)); K = M['M']
L = np.zeros(N); R = np.zeros(N); rng = np.random.default_rng(7)
def add(sig, at, g=1.0, pan=0.0):
    i = int(round(at * SR)) % N
    s = sig * g; l = s * np.sqrt(.5 * (1 - pan)); r = s * np.sqrt(.5 * (1 + pan))
    idx = (np.arange(len(s)) + i) % N  # döngü: taşan kısım başa
    np.add.at(L, idx, l); np.add.at(R, idx, r)
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
# akorlar: Am F C G (4 ölçü = 8 sn, iki tur)
CH = [[220, 261.6, 329.6], [174.6, 220, 261.6], [261.6, 329.6, 392], [196, 246.9, 293.7]]
BASS = [55, 43.65, 65.41, 49]
for bar in range(8):
    at = bar * 2; c = bar % 4; n = int(2 * SR)
    add(pad(CH[c], n), at, .22, -.2); add(pad([f * 2 for f in CH[c]], n), at, .08, .25)
    for q in range(8):
        a2 = at + q * .25; m = int(.25 * SR); x = np.arange(m) / SR
        add(lp(saw(BASS[c] * 2, m), .1) * np.minimum(1, x / .01) * np.exp(-x / .15), a2, .5)
for k in range(32):
    at = k * B
    if 15 <= at < 16: continue  # yükselişte davullar susar, kanca vuruşu başta
    hook = at < 2
    add(kick(), at, .9)
    if k % 2 == 1 and not hook: add(clap(), at, .5)
    if not hook:
        add(hat(), at + B / 2, .2, .35); add(hat(), at + B * .75, .09, -.4)
        if 8 <= at < 14: add(hat(True), at + B / 2, .1, -.3)
# efektler
PENTA = [0, 2, 4, 7, 9]
def note(i): return 440 * 2 ** ((PENTA[i % 5] + 12 * (i // 5)) / 12)
for m in K:
    t, k = m['t'], m['k']
    if k == 'hit': add(impact(), t, .9); add(bell(880), t, .25, .2)
    elif k == 'pop': add(pluck(note(m['i'])), t, .32, -.3 + .6 * (m['i'] % 2))
    elif k == 'leg': add(impact(.7), t, .7); add(bell(note(m['i'] + 2)), t, .35); add(bell(note(m['i'] + 4)), t + .04, .2, .4)
    elif k == 'lock':
        add(impact(1.), t, .9); add(bell(220, 2), t, .3)
        n = int(.18 * SR); add(lp(rng.standard_normal(n), .4) * env(n, .001, .05), t + .35, .8)  # damga
    elif k == 'end': add(impact(.9), t, .8); add(bell(659.3), t, .3, -.2); add(bell(987.8), t + .05, .2, .3)
    elif k == 'tick': add(pluck(note(m['i']) / 2, .12), t, .14, .4 - .8 * (m['i'] % 2))
    elif k == 'rise': add(riser(2.0), t, .45)
mx = np.stack([L, R], 1); mx /= np.max(np.abs(mx)) / .89
with wave.open(sys.argv[2], 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes((mx * 32767).astype('<i2').tobytes())
print('ok', T)
