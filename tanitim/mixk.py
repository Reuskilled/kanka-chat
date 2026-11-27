#!/usr/bin/env python3
# Kanka tanıtım müziği: 120 BPM, gerilimli giriş → logoda düşüş → groove → CTA'da büyük vuruş. Stereo, -1 dB tavan.
import numpy as np, json, wave, sys
SR = 44100
M = json.load(open(sys.argv[1])); T = M['TOT']; N = int(T * SR)
L = np.zeros(N); R = np.zeros(N)
rng = np.random.default_rng(7)

def add(sig, at, g=1.0, pan=0.0):
    i = int(at * SR)
    if i >= N or i + len(sig) <= 0: return
    if i < 0: sig = sig[-i:]; i = 0
    j = min(N, i + len(sig)); s = sig[:j - i] * g
    L[i:j] += s * np.sqrt(0.5 * (1 - pan)); R[i:j] += s * np.sqrt(0.5 * (1 + pan))

def env(n, a=.005, d=.2):
    x = np.arange(n) / SR; return np.minimum(1, x / a) * np.exp(-x / d)

def lp(x, c):  # tek kutuplu alçak geçiren (c 0..1)
    y = np.zeros_like(x); a = 0.0
    for i in range(len(x)): a += c * (x[i] - a); y[i] = a
    return y

bpm = 128; beat = 60 / bpm; bar = beat * 4
DROP = M['M']['hit'][0]          # logo
END = M['M']['hit'][1]           # CTA

# --- davul örnekleri
def kick():
    n = int(.32 * SR); x = np.arange(n) / SR
    f = 48 + 110 * np.exp(-x * 28)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * env(n, .001, .16) * 1.1 + rng.standard_normal(n) * env(n, .0005, .004) * .3
def clap():
    n = int(.25 * SR); w = rng.standard_normal(n)
    e = np.zeros(n)
    for o in (0, .011, .022): k = int(o * SR); e[k:] += env(n - k, .0005, .012)
    e += env(n, .002, .09) * .5
    b = w - lp(w, .25)
    return b * e * .9
def hat(op=False):
    n = int((.18 if op else .05) * SR); w = rng.standard_normal(n); h = w - lp(w, .6)
    return h * env(n, .0005, .06 if op else .013)

# --- akorlar (Fm Db Ab Eb : karanlık ama umutlu)
CH = [[174.6, 207.7, 261.6], [138.6, 174.6, 207.7], [207.7, 261.6, 311.1], [155.6, 196.0, 233.1]]
BASS = [43.65, 34.65, 51.91, 38.89]

def saw(f, n, det=0.0):
    x = np.arange(n) / SR; ph = (f * (1 + det) * x) % 1
    return 2 * ph - 1

def pad(freqs, n):
    s = np.zeros(n)
    for f in freqs:
        for d in (-.004, 0, .004): s += saw(f, n, d)
    s = lp(s / (len(freqs) * 3), .06)
    x = np.arange(n) / SR; e = np.minimum(1, x / .25) * np.minimum(1, (n / SR - x) / .3)
    return s * e

# giriş: gerilim dronu + kalp atışı tick
n = int(DROP * SR); x = np.arange(n) / SR
drone = (np.sin(2 * np.pi * 43.65 * x) + .5 * np.sin(2 * np.pi * 87.3 * x * (1 + .002 * np.sin(x * 3)))) * np.minimum(1, x / 1.5)
add(drone * .35, 0)
for k in range(int(DROP / beat)):
    add(kick() * .55, k * beat)
# yükselen gürültü (drop'tan önce) ve ters zil
for target, ln in ((DROP, 2.2), (END, 2.0)):
    n = int(ln * SR); w = rng.standard_normal(n); x = np.arange(n) / SR
    y = np.zeros(n); a = 0.0
    for i in range(n): c = .005 + .45 * (i / n) ** 2; a += c * (w[i] - a); y[i] = a
    add(y * (x / ln) ** 2.2 * 1.6, target - ln, .55, -.3); add(y[::-1][::-1] * (x / ln) ** 2.2 * 1.6, target - ln, .55, .3)

# ana bölüm
t0 = DROP
k = 0
while t0 + k * beat < END - .01:
    at = t0 + k * beat; b = k % 4; barI = int(k / 4)
    # son 2 vuruşta boşluk bırak (CTA'dan önce)
    if at > END - beat * 2: k += 1; continue
    add(kick(), at, .95)
    if b in (1, 3): add(clap(), at, .55)
    add(hat(), at + beat / 2, .22, .35)
    if k % 8 == 7: add(hat(True), at + beat / 2, .2, -.35)
    add(hat(), at + beat / 4 * 3, .1, -.4)
    k += 1
# akor ve bas
barN = int((END - DROP) / bar) + 1
for i in range(barN):
    at = DROP + i * bar
    if at >= END: break
    n = int(min(bar, END - at) * SR)
    add(pad(CH[i % 4], n), at, .28, -.2); add(pad([f * 2 for f in CH[i % 4]], n), at, .12, .25)
    for q in range(8):  # sekizlik bas, sidechain hissi
        a2 = at + q * beat / 2
        if a2 >= END - beat * 2: break
        m = int(beat / 2 * SR); x = np.arange(m) / SR; f = BASS[i % 4] * 2
        s = lp(saw(f, m), .08) * np.minimum(1, x / .03) * np.exp(-x / .2)
        add(s, a2, .5)
    # arp (16'lık), 16. saniyeden sonra
    if at > DROP + bar * 2:
        notes = CH[i % 4] + [CH[i % 4][0] * 2]
        for q in range(16):
            a2 = at + q * beat / 4
            if a2 >= END - beat * 2: break
            f = notes[q % 4] * 2; m = int(.12 * SR); x = np.arange(m) / SR
            s = (np.sign(np.sin(2 * np.pi * f * x)) * .4 + np.sin(2 * np.pi * f * x)) * env(m, .002, .05)
            add(s, a2, .07, .5 if q % 2 else -.5)

# CTA vuruşu ve kapanış akoru
def boom():
    n = int(2.2 * SR); x = np.arange(n) / SR
    return np.sin(2 * np.pi * np.cumsum(30 + 90 * np.exp(-x * 6)) / SR) * np.exp(-x * 1.6) + rng.standard_normal(n) * np.exp(-x * 14) * .5
add(boom(), DROP, .9); add(boom(), END, 1.0)
n = int((T - END) * SR)
add(pad([174.6, 207.7, 261.6, 349.2], n) * np.exp(-np.arange(n) / SR / 3.5), END, .5)
# CTA'dan sonra yumuşak ritim
for k in range(int((T - END - 1.5) / beat)):
    at = END + 1.0 + k * beat
    add(kick(), at, .5); add(hat(), at + beat / 2, .12, .3)

# --- ses efektleri
def whoosh():
    n = int(.5 * SR); w = rng.standard_normal(n); x = np.arange(n) / SR; y = np.zeros(n); a = 0.0
    for i in range(n): c = .02 + .5 * (i / n); a += c * (w[i] - a); y[i] = a
    return y * np.sin(np.pi * x / .5) ** 2
def pop():
    n = int(.12 * SR); x = np.arange(n) / SR
    return np.sin(2 * np.pi * (500 + 2400 * np.exp(-x * 40)) * x) * env(n, .001, .04)
def tick():
    n = int(.05 * SR); x = np.arange(n) / SR
    return np.sin(2 * np.pi * 1800 * x) * env(n, .0005, .01)
def key():
    n = int(.035 * SR); w = rng.standard_normal(n); return (w - lp(w, .3)) * env(n, .0005, .007)
def fail():
    n = int(.45 * SR); x = np.arange(n) / SR
    return (np.sign(np.sin(2 * np.pi * 130 * x)) * .5 + np.sin(2 * np.pi * 98 * x)) * env(n, .002, .2)
def notes_pluck(f):
    n = int(.6 * SR); x = np.arange(n) / SR
    return (np.sin(2 * np.pi * f * x) + .3 * np.sin(2 * np.pi * 2 * f * x)) * env(n, .002, .25)
for a in M['M']['whoosh']: add(whoosh(), a - .25, .55, rng.uniform(-.4, .4))
for a in M['M']['pop']: add(pop(), a, .3, rng.uniform(-.3, .3))
scale = [349.2, 415.3, 523.3, 622.3, 698.5, 830.6]
for i, a in enumerate(M['M']['tick']): add(notes_pluck(scale[i % 6]), a, .22, rng.uniform(-.5, .5))  # enstrüman sahnesinde notalar
for a in M['M']['type']: add(key(), a + rng.uniform(0, .02), .3)
for a in M['M']['fail']: add(fail(), a, .35)

# master: yumuşak doyum, normalize, sonda sönüm
mx = np.stack([L, R])
mx = np.tanh(mx * 1.3) / np.tanh(1.3)
fo = int(.8 * SR); mx[:, -fo:] *= np.linspace(1, 0, fo)
fi = int(.02 * SR); mx[:, :fi] *= np.linspace(0, 1, fi)
mx = mx / np.max(np.abs(mx)) * 0.89
out = (mx.T * 32767).astype(np.int16)
w = wave.open(sys.argv[2], 'wb'); w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(out.tobytes()); w.close()
print('ok', T)
