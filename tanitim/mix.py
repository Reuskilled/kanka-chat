import numpy as np, json, wave, sys
SR=44100; M=json.load(open(sys.argv[1])); T=M['TOT']; N=int(T*SR); out=np.zeros(N)
t=np.arange(N)/SR
def add(sig,at,g=1.0):
    i=int(at*SR)
    if i>=N: return
    j=min(N,i+len(sig)); out[i:j]+=sig[:j-i]*g
def env(n,a=.005,d=.2):
    x=np.arange(n)/SR; return np.minimum(1,x/a)*np.exp(-x/d)
# beat 96 bpm, loop-friendly (bar aligned to T)
bpm=96; beat=60/bpm
kick=lambda: np.sin(2*np.pi*np.cumsum(np.linspace(120,45,int(.25*SR)))/SR)*env(int(.25*SR),.002,.09)
hat=lambda: np.random.randn(int(.05*SR))*env(int(.05*SR),.001,.012)
nb=int(T/beat)
for b in range(nb+1):
    at=b*beat
    if at>=T: break
    if b%2==0: add(kick(),at,.55)
    add(hat(),at+beat/2,.08)
# pad chords (Am F C G), soft
ch=[[220,261.6,329.6],[174.6,220,261.6],[261.6,329.6,392],[196,246.9,293.7]]
bar=beat*4
for k in range(int(T/bar)+1):
    f=ch[k%4]; n=int(bar*SR); x=np.arange(n)/SR
    s=sum(np.sin(2*np.pi*fr*x)+.3*np.sin(2*np.pi*fr*2*x) for fr in f)/3
    e=np.minimum(1,x/.4)*np.minimum(1,(bar-x)/.4)
    add(s*e,k*bar,.07)
# sfx
def pop():
    n=int(.12*SR); x=np.arange(n)/SR; return np.sin(2*np.pi*(600+2600*np.exp(-x*40))*x)*env(n,.001,.04)
def tick():
    n=int(.04*SR); x=np.arange(n)/SR; return np.sin(2*np.pi*1900*x)*env(n,.0005,.008)
def key():
    n=int(.03*SR); return np.random.randn(n)*env(n,.0005,.006)
for a in M['M']['pop']: add(pop(),a,.35)
for a in M['M']['tick']: add(tick(),a,.25)
for a in M['M']['type']: add(key(),a+np.random.rand()*.03,.25)
def whoosh():
    n=int(.45*SR); x=np.arange(n)/SR; w=np.random.randn(n); 
    # band-ish sweep: simple one-pole lowpass with rising cutoff
    y=np.zeros(n); a=0.0
    for i in range(n):
        c=0.02+0.5*(i/n); a+= c*(w[i]-a); y[i]=a
    return y*np.sin(np.pi*x/.45)**2
def fail():
    n=int(.35*SR); x=np.arange(n)/SR; return (np.sign(np.sin(2*np.pi*140*x))*.5+np.sin(2*np.pi*110*x))*env(n,.002,.18)
for a in M['M'].get('whoosh',[]): add(whoosh(),a-.2,.5)
for a in M['M'].get('fail',[]): add(fail(),a,.35)
# bass line
for b in range(int(T/beat)):
    at=b*beat
    if at<4.6: continue
    f=[110,87.3,130.8,98][int(at/(beat*4))%4]; n=int(beat*.9*SR); x=np.arange(n)/SR
    add(np.sin(2*np.pi*f*x)*env(n,.005,.25),at,.18)
# loop seam: fade last/first 60ms
fl=int(.06*SR); out[:fl]*=np.linspace(0,1,fl); out[-fl:]*=np.linspace(1,0,fl)
out=out/np.max(np.abs(out))*.8
w=wave.open(sys.argv[2],'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes((out*32767).astype(np.int16).tobytes()); w.close()
