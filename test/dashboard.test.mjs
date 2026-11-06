import test, { after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import * as h5 from 'h5wasm/node';
import { decodeAudio, LineParser } from '../dashboard/protocol.js';
import { newSession, renderAudio, wavBytes } from '../dashboard/session.js';
import { writeSession, readSession } from '../dashboard/hdf5.js';
import { crc32, BlePacketParser } from '../dashboard/ble-protocol.js';
import { audioIntegrity } from '../dashboard/audio-timeline.js';
const {FS} = await h5.ready;
const temp = mkdtempSync(join(tmpdir(), 'pal-h5-'));
FS.chdir(temp);
after(() => rmSync(temp, {recursive:true,force:true}));
const base = {audio_time_ms:1793896772968,audio_rate_hz:16000,audio_samples:4};
function pcmPacket(samples) { const bytes = Buffer.alloc(samples.length*2);samples.forEach((v,i)=>bytes.writeInt16LE(v,i*2));return {...base,audio_samples:samples.length,audio_pcm_s16_b64:bytes.toString('base64')}; }
test('PCM preserves signed values and rejects partial frames',()=>{
 assert.deepEqual([...decodeAudio(pcmPacket([-32768,-1,0,32767]),'ws').pcm],[-32768,-1,0,32767]);
 assert.throws(()=>decodeAudio({...pcmPacket([1]),audio_samples:2},'ws'),/Truncated/);
});
test('ADPCM exact sample count discards padding nibble',()=>{
 const frame={...base,audio_adpcm_b64:Buffer.from([0xE8,3,0,0,0x11,0xF1]).toString('base64')};
 const pcm=decodeAudio(frame,'ble').pcm;
 assert.equal(pcm.length,4);assert.equal(pcm[0],1000);assert.deepEqual([...pcm],[1000,1001,1002,1003]);
 assert.throws(()=>decodeAudio({...frame,audio_samples:8},'ble'),/Invalid/);
});
test('fragmented lines, malformed packet recovery, bounded buffer',()=>{
 const packets=[],errors=[];const parser=new LineParser(p=>packets.push(p),e=>errors.push(e));
 for(const c of '{"a":1}\n{broken\n{"b":2}\n')parser.push(c);
 assert.deepEqual(packets,[{a:1},{b:2}]);assert.equal(errors.length,1);
 parser.push('x'.repeat(70000));parser.push('\n{"c":3}\n');assert.deepEqual(packets.at(-1),{c:3});
});
test('USB boot diagnostics do not hide malformed JSON or a reboot mid-stream',()=>{
 const packets=[],errors=[];const parser=new LineParser(p=>packets.push(p),e=>errors.push(e),{usbBootLog:true});
 parser.push('ESP-ROM:esp32s3-20210327\r\nload:0x3fce3808,len:0x4bc\r\n');
 parser.push('E (208) esp_core_dump_flash: No core dump partition found!\n{broken\n');
 parser.push('{"type":"health"}\nESP-ROM:esp32s3-20210327\n');
 assert.deepEqual(packets,[{type:'health'}]);assert.equal(errors.length,2);
 const strict=new LineParser(()=>{},e=>errors.push(e));
 strict.push('ESP-ROM:esp32s3-20210327\n');assert.equal(errors.length,3);
});
test('binary Bluetooth preserves samples, 64-bit clocks and IMU axes; CRC recovers after corruption',()=>{
 assert.equal(crc32(new TextEncoder().encode('123456789')),0xcbf43926);
 const frame=(kind,payload)=>{
  const b=new Uint8Array(payload.length+12),v=new DataView(b.buffer);
  b.set([80,65,76,2,kind,0]);v.setUint16(6,payload.length,true);v.setUint32(8,crc32(payload),true);b.set(payload,12);return b;
 };
 const audio=new Uint8Array(66),v=new DataView(audio.buffer);
 audio.set([0xc0,0xcd,0xd6,0x38,0x6c,0x34]);v.setBigUint64(6,1793896772968n,true);
 v.setUint32(14,99,true);v.setUint32(18,42,true);v.setBigUint64(26,4294967298n,true);v.setBigUint64(34,123456789012n,true);
 v.setUint16(42,4,true);v.setUint16(44,16000,true);v.setFloat32(54,-12.5,true);audio[58]=1;
 audio.set([0xe8,3,0,0,0x11,0xf1],60);
 const imu=new Uint8Array(29),iv=new DataView(imu.buffer);imu.set(audio.subarray(0,14));imu[14]=1;iv.setUint16(15,123,true);
 [1,-2,8192,10,-10,100].forEach((x,i)=>iv.setInt16(17+i*2,x,true));
 const status=frame(0,new TextEncoder().encode('{"type":"status","state":"clock_set"}'));
 const broken=frame(1,audio);broken[35]^=1;
 const bytes=Buffer.concat([broken,frame(1,audio),frame(2,imu),status]);
 const packets=[],errors=[];const parser=new BlePacketParser(p=>packets.push(p),e=>errors.push(e));
 for(let i=0;i<bytes.length;i+=7)parser.push(new DataView(bytes.buffer,bytes.byteOffset+i,Math.min(7,bytes.length-i)));
 assert.equal(errors.length,1);assert.equal(packets.length,3);assert.equal(packets[0].device_id,'346c38d6cdc0');
 assert.equal(packets[0].audio_sample_index,4294967298);assert.equal(packets[0].audio_time_ms,1793896772968);
 assert.deepEqual([...decodeAudio(packets[0],'ble').pcm],[1000,1001,1002,1003]);
 assert.equal(packets[1].imu[0][0],123);assert.equal(packets[1].imu[0][2],-2*.122*9.80665/1000);assert.equal(packets[2].state,'clock_set');
});
test('compact IMU encoding retains all signed 16-bit sensor counts after serial decimal rounding',()=>{
 for(const scale of [.122*9.80665/1000,17.50*(3.14159265/180)/1000]) {
  for(let raw=-32768;raw<=32767;raw++) {
   const serialized=Number(Math.fround(raw*Math.fround(scale)).toFixed(4));
   assert.equal(Math.round(serialized/scale) || 0,raw);
  }
 }
});
function fixture() {
 const s=newSession();s.started=1793896772000;s.ended=s.started+1000;
 s.imu=[{time_ms:1793896772968,ax:1,ay:-2,az:9.81,gx:.1,gy:0,gz:-.1}];
 s.environment=[{time_ms:1793896772969,temperature_c:25.5,humidity_pct:42,pressure_hpa:1000,gas_ohms:80000}];
 s.audio=[{...decodeAudio(pcmPacket([1000,-1000,32767,-32768]),'ws'),sequence:12,clock_synced:true},
 {...decodeAudio({...pcmPacket([10,20]),audio_time_ms:base.audio_time_ms+1,audio_rate_hz:8000},'ble'),sequence:14,codec:'ima_adpcm'}];
 return s;
}
test('HDF5 compressed round trip preserves sample values, per-frame rates, exact epoch ms and offsets',()=>{
 const s=fixture(),bytes=writeSession(h5,FS,s),r=readSession(h5,FS,bytes);
 assert.equal(r.imu[0].time_ms,s.imu[0].time_ms);assert.equal(r.environment[0].temperature_c,25.5);
 assert.deepEqual(r.audio.map(f=>[...f.pcm]),s.audio.map(f=>[...f.pcm]));
 assert.deepEqual(r.audio.map(f=>f.rate),[16000,8000]);assert.deepEqual(r.audio.map(f=>f.sequence),[12,14]);
 assert.equal(r.audio[0].clock_synced,1);assert.equal(r.audio[1].transport,'ble');assert.equal(r.audio[1].codec,'ima_adpcm');
 FS.writeFile('inspect.h5',bytes);const file=new h5.File('inspect.h5','r');assert.equal(file.get('audio/pcm_s16').metadata.chunks[0],16000);file.close();FS.unlink('inspect.h5');
 assert.equal(FS.analyzePath('recording.h5').exists,false);assert.equal(FS.analyzePath('import.h5').exists,false);
});
test('HDF5 empty and sensor-only sessions round trip',()=>{
 for(const s of [newSession(),{...fixture(),audio:[]}]){const r=readSession(h5,FS,writeSession(h5,FS,s));assert.equal(r.audio.length,0);assert.equal(r.imu.length,s.imu.length);}
});
test('48 kHz Bluetooth recording retains actual frame gaps through HDF5 into Explorer',()=>{
 const s=newSession();
 s.audio=[0,1,4,5].map(n=>decodeAudio({type:'audio',audio_codec:'ima_adpcm',audio_adpcm_bytes:new Uint8Array(484),audio_rate_hz:48000,audio_samples:960,audio_time_ms:1793896772000+20*n,audio_sample_index:960*n,audio_monotonic_us:1000000+20000*n,sequence:n,stream_id:42,segment:0,capture_dropped_frames:n<4?0:2,clock_synced:true},'ble'));
 const imported=readSession(h5,FS,writeSession(h5,FS,s));
 assert.deepEqual(imported.audio.map(f=>f.pcm.length),[960,960,960,960]);
 assert.deepEqual(audioIntegrity(imported.audio),audioIntegrity(s.audio));
 assert.equal(audioIntegrity(imported.audio).missingMs,40);assert.equal(audioIntegrity(imported.audio).missingFrames,2);
});
test('playback preserves gaps and rate changes; WAV contains PCM',()=>{
 const s=newSession();s.audio=[{time_ms:1000,rate:8000,pcm:new Int16Array(800).fill(16384)},{time_ms:1200,rate:16000,pcm:new Int16Array(1600).fill(-16384)}];
 const r=renderAudio(s,1000,1300);assert.equal(r.pcm.length,4800);assert.equal(r.pcm[50],.5);assert.equal(r.pcm[2400],0);assert.equal(r.pcm[4000],-.5);
 assert.equal(wavBytes(r.pcm,r.rate).length,44+9600);assert.throws(()=>renderAudio(s,0,121000),/120/);
});

test('kit registry preserves distinct devices and updates a kit after DHCP changes',async()=>{
 const {rememberKit,loadKits}=await import('../dashboard/kits.js');
 let kits=rememberKit([],{id:'one',name:'PAL-one'},'192.168.4.2');
 kits=rememberKit(kits,{id:'two',name:'PAL-two'},'192.168.4.3');
 kits=rememberKit(kits,{id:'one',name:'PAL-one'},'192.168.4.4');
 assert.equal(kits.length,2);assert.equal(kits.find(k=>k.id==='two').host,'192.168.4.3');assert.equal(kits.find(k=>k.id==='one').host,'192.168.4.4');
 assert.equal(rememberKit(kits,null,'ws://evil/path').length,2);
 assert.deepEqual(loadKits({getItem:()=>'{broken'}),[]);
 const s=fixture();s.device={id:'one',name:'PAL-one'};
 assert.deepEqual(readSession(h5,FS,writeSession(h5,FS,s)).device,s.device);
});

test('A3 raw audio preserves every signed 32-bit DMA bit, including low bits and extremes',()=>{
 const values=[-2147483648,-257,-1,0,1,257,2147483647];
 const data=Buffer.alloc(values.length*4);values.forEach((v,i)=>data.writeInt32LE(v,i*4));
 const packet={...base,audio_rate_hz:48000,audio_samples:values.length,audio_pcm_s32_b64:data.toString('base64')};
 const frame=decodeAudio(packet,'usb');assert.ok(frame.pcm instanceof Int32Array);assert.deepEqual([...frame.pcm],values);
 assert.equal(frame.codec,'i2s_s32le');assert.throws(()=>decodeAudio({...packet,audio_samples:8},'usb'),/Truncated/);
 const s=fixture();s.configuration={hardware:'FrED PAL A3',audio:{alignment:'unshifted_dma_requires_bench_validation'}};
 s.audio.unshift(frame);s.imu_raw=[{time_ms:base.audio_time_ms,monotonic_us:123456789,tag:2,x:-32768,y:32767,z:-1,sequence:2,segment:1,stream_id:8,clock_synced:1}];
 s.health=[{time_ms:base.audio_time_ms,battery_v:4.123,imu_overruns:3}];s.environment[0].gas_ohms=NaN;s.environment[0].gas_valid=false;s.environment[0].heater_stable=false;
 const bytes=writeSession(h5,FS,s),r=readSession(h5,FS,bytes);
 assert.deepEqual(r.configuration,s.configuration);assert.deepEqual(r.imu_raw,s.imu_raw);
 assert.deepEqual(r.audio.map(f=>[...f.pcm]),s.audio.map(f=>[...f.pcm]));assert.ok(r.audio[0].pcm instanceof Int32Array);assert.ok(r.audio[1].pcm instanceof Int16Array);
 assert.equal(r.health[0].imu_overruns,3);assert.equal(r.health[0].battery_v,4.123);assert.ok(Number.isNaN(r.environment[0].gas_ohms));assert.equal(r.environment[0].gas_valid,0);
 const playback=renderAudio({...newSession(),audio:[{time_ms:0,rate:48000,pcm:new Int32Array(480).fill(1073741824)}]},0,10,48000);nearHalf(playback.pcm[10]);
 function nearHalf(v) {assert.equal(v,.5);}
});
