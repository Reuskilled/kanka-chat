#!/usr/bin/env python3
# Beta 50 8-bit sürüm müziği: kare dalga, üçgen bas, gürültü davul (NES tarzı), 120 BPM. Sahneler marks'tan.
import numpy as np, json, wave, sys
SR = 44100
M = json.load(open(sys.argv[1])); T = M['TOT']; N = int(round(T * SR)); K = M['M']
L = np.zeros(N); R = np.zeros(N); rng = np.random.default_rng(3)
def add(sig, at, g=1.0, pan=0.0):
    i = int(round(at * SR))
    if i >= N: return
    s = sig[:N - i] * g; L[i:i + len(s)] += s * (1 - pan) * .7; R[i:i + len(s)] += s * (1 + pan) * .7
def hz(n): return 440 * 2 ** ((n - 69) / 12)
def sq(f, d, duty=.5, dec=0.):
    n = int(d * SR); x = np.arange(n) / SR; ph = (f * x) % 1
    s = np.where(ph < duty, .5, -.5); e = np.ones(n)
    if dec: e = np.exp(-x / dec)
    e[-min(n, 200):] *= np.linspace(1, 0, min(n, 200)); return s * e
def tri(f, d):
    n = int(d * SR); x = np.arange(n) / SR; ph = (f * x) % 1
    s = (4 * np.abs(ph - .5) - 1) * .6; s = np.round(s * 8) / 8  # 4-bit basamak
    s[-min(n, 200):] *= np.linspace(1, 0, min(n, 200)); return s
def noise(d, dec=.05, per=1):
    n = int(d * SR); w = np.repeat(rng.choice([-.4, .4], n // per + 1), per)[:n]; return w * np.exp(-np.arange(n) / SR / dec)
def sweep(f0, f1, d, duty=.5):
    n = int(d * SR); x = np.arange(n) / SR; f = f0 + (f1 - f0) * x / d; ph = np.cumsum(f) / SR % 1
    return np.where(ph < duty, .5, -.5) * np.linspace(1, .3, n)
B = .5
tm = {}
for m in K: tm.setdefault(m['k'], m['t'])
S2 = K[4]['t'] + .05 if False else 3.24
S3, BR, GET, S4, DROP, WARN, S5, CTA = tm['dun'], tm['open'], tm['get'], tm['boss'], tm['drop'], tm['warn'], tm['cont'], tm['ins']
def melody(a, b, notes, bass, lead_g=.22, duty=.25, step=.25):
    t = a; i = 0
    while t < b - .01:
        n = notes[i % len(notes)]
        if n: add(sq(hz(n), step * .9, duty, .15), t, lead_g, .2)
        if i % 2 == 0: add(tri(hz(bass[(i // 2) % len(bass)]), step * 2 * .95), t, .5)
        if i % 4 == 0: add(noise(.12, .04, 24), t, .35)          # kick-ish
        if i % 4 == 2: add(noise(.15, .06, 2), t, .3)            # trampet
        add(noise(.04, .01, 1), t + step / 2, .12, -.3)          # hat
        t += step; i += 1
# başlık: üç vuruş
for k, f in (('t1', [60, 64, 67]), ('t2', [62, 65, 69]), ('t3', [64, 67, 72, 76])):
    t = tm[k]
    for j, n in enumerate(f): add(sq(hz(n), .5, .5, .25), t + j * .02, .18, -.3 + .3 * j)
    add(noise(.5, .2, 3), t, .45); add(tri(hz(f[0] - 24), .5), t, .6)
add(sq(hz(84), .06), tm['start'], .2); add(sq(hz(91), .2, .5, .08), tm['start'] + .06, .2)
# dünya 1-1: neşeli
OW = [72, 76, 79, 76, 74, 77, 81, 77, 72, 76, 79, 84, 83, 79, 74, 0]
melody(S2, S3, OW, [48, 53, 55, 48, 45, 53, 55, 43])
for m in K:
    if m['k'] == 'jump': add(sweep(300, 900, .18, .25), m['t'], .22)
    if m['k'] == 'coin': add(sq(hz(83), .07), m['t'], .25); add(sq(hz(88), .35, .5, .12), m['t'] + .07, .25)
# zindan: gergin, sandık açılınca arpej ve item fanfarı
t = S3
while t < BR - .01:
    add(tri(hz([45, 45, 44, 44][int((t - S3) / B) % 4]), B * .95), t, .55)
    if int((t - S3) / B) % 2 == 0: add(sq(hz(69), .1, .125, .05), t, .12)
    t += B
for j, n in enumerate([69, 73, 76, 81, 85, 88]): add(sq(hz(n), .12, .25, .1), BR + j * .06, .2)
melody(BR + .4, GET, [81, 0, 76, 0, 79, 0, 74, 0], [45, 41, 43, 40], .12, .5, .25)
for j, (n, d) in enumerate([(74, .15), (76, .15), (78, .15), (79, .9)]):
    add(sq(hz(n), d, .5, .4), GET + j * .15, .28); add(sq(hz(n - 12), d, .25, .4), GET + j * .15, .12, .3)
melody(GET + 1.0, S4, [79, 83, 86, 83, 81, 84, 88, 84], [43, 48, 45, 50], .14, .25, .25)
# boss: hızlı minör
melody(S4, S5, [69, 72, 69, 75, 69, 72, 69, 74, 0, 69, 72, 69, 77, 76, 74, 72], [45, 45, 44, 44, 41, 41, 40, 40], .16, .5, .125)
add(noise(1.2, .35, 6), DROP, .7); add(sweep(400, 40, .6, .5), DROP, .35)
for j in range(6): add(sq(hz(88 if j % 2 else 81), .12), WARN + j * .16, .15)
# devam: geri sayım bipleri, yazma, sonda 1-UP
for j in range(int((CTA - S5) / .5) + 1): add(sq(hz(76), .06), S5 + j * .5, .2)
for m in K:
    if m['k'] == 'type': add(sq(hz(96), .03, .25), m['t'], .12)
melody(CTA, T - .6, [72, 76, 79, 84, 79, 76, 74, 77], [48, 53, 55, 48], .12, .25, .25)
for j, n in enumerate([76, 79, 88, 84, 86, 91]): add(sq(hz(n), .1), CTA + 1.4 + j * .1, .25)
fade = np.ones(N); nf = int(.8 * SR); fade[-nf:] = np.linspace(1, 0, nf)
mx = np.stack([L * fade, R * fade], 1); mx /= np.max(np.abs(mx)) / .89
with wave.open(sys.argv[2], 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes((mx * 32767).astype('<i2').tobytes())
print('ok', T)
