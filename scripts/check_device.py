"""Read-only serial streaming smoke check; optional --sync sends the computer UTC time."""
import argparse, base64, collections, json, time
import serial
p=argparse.ArgumentParser(); p.add_argument('--port', required=True); p.add_argument('--seconds',type=int,default=20); p.add_argument('--sync',action='store_true'); p.add_argument('--capture')
a=p.parse_args(); counts=collections.Counter(); audio=[]; errors=[]; malformed=0; samples=0
with serial.Serial(a.port,230400,timeout=1) as dev:
    if a.sync: dev.write((json.dumps({'cmd':'set_time','unix_ms':int(time.time()*1000)})+'\n').encode())
    until=time.monotonic()+a.seconds
    capture=open(a.capture,'w') if a.capture else None
    try:
        while time.monotonic()<until:
            line=dev.readline()
            try: d=json.loads(line)
            except (ValueError,UnicodeDecodeError):
                if line: malformed+=1
                continue
            counts[d.get('type')]+=1
            if capture: capture.write(json.dumps(d)+'\n')
            if d.get('type')=='status': errors.append(d)
            if d.get('type')=='audio':
                payload=base64.b64decode(d['audio_adpcm_b64']); assert len(payload)==4+(d['audio_samples']//2)
                audio.append({k:v for k,v in d.items() if not k.endswith('_b64')}); samples+=d['audio_samples']
    finally:
        if capture: capture.close()
gaps=sum(max(0,b['sequence']-a['sequence']-1) for a,b in zip(audio,audio[1:]) if a['stream_id']==b['stream_id'])
print(json.dumps({'packets':dict(counts),'malformed_lines':malformed,'samples':samples,'sequence_gaps':gaps,'first_audio':audio[0] if audio else None,'last_audio':audio[-1] if audio else None,'status':errors},indent=2))
if not audio: raise SystemExit('No audio received')
