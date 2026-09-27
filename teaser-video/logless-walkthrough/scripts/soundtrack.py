"""Original, deterministic low-key electric-key bed and soft interface cues. No samples."""
from array import array
import math,wave
from pathlib import Path
RATE=48000
DURATION=30
samples=array('f',[0])*(RATE*DURATION)
def tone(start,duration,hz,level,pan=0):
    n=int(duration*RATE); offset=int(start*RATE)
    for i in range(n):
        j=offset+i
        if j>=len(samples):break
        t=i/RATE
        attack=min(1,t/.012)
        release=min(1,(duration-t)/.35)
        env=attack*release*math.exp(-t/1.8)
        samples[j]+=level*env*(math.sin(2*math.pi*hz*t)+.18*math.sin(2*math.pi*hz*2*t)*math.exp(-t*3))
# Sparse, consonant voicings at 80 bpm, with a resolved six-second closing phrase.
chords=[(0,[146.83,220,293.66,369.99]),(6,[130.81,196,261.63,329.63]),(12,[164.81,220,329.63,392]),(18,[146.83,220,293.66,369.99]),(24,[146.83,220,293.66,440])]
for start,chord in chords:
    for i,hz in enumerate(chord):tone(start+i*.045,5.6,hz,.038)
    for step in range(1,7):tone(start+step*.75,2.5,chord[step%4]*2,.024)
for at in [5.55,12.12,16.62]:
    tone(at,.1,720,.035);tone(at+.012,.12,1080,.018)
tone(18.3,.85,587.33,.04);tone(18.37,.85,739.99,.024)
# Whole-film envelope gives the final note a complete tail inside 30 seconds.
peak=max(abs(v) for v in samples)
scale=.55/max(peak,.0001)
output=array('h')
for i,s in enumerate(samples):
    t=i/RATE
    fade=min(1,t/.5,max(0,(DURATION-t)/1.2))
    value=round(max(-.98,min(.98,s*scale*fade))*32767)
    output.extend([value,value])
path=Path(__file__).resolve().parent.parent/'public'/'soundtrack.wav'
with wave.open(str(path),'wb') as w:
    w.setnchannels(2);w.setsampwidth(2);w.setframerate(RATE);w.writeframes(output.tobytes())
print(path)
