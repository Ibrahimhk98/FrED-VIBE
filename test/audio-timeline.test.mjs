import test from 'node:test';
import assert from 'node:assert/strict';
import { audioEnvelope, audioIntegrity } from '../dashboard/audio-timeline.js';
import { decodeBlePacket, BlePacketParser, crc32 } from '../dashboard/ble-protocol.js';
const frame=(n,level=0)=>({stream_id:1,segment:0,sequence:n,sample_index:n*960,time_ms:1000+n*20,rate:48000,pcm:new Int16Array(960).fill(level),dropped:0});
test('audio integrity distinguishes actual missing frames, quiet samples and capture loss',()=>{
 assert.deepEqual(audioIntegrity([frame(0),frame(1),frame(2)]),{missingFrames:0,missingSamples:0,missingMs:0,captureDrops:0,discontinuities:0});
 const lost=audioIntegrity([frame(0),{...frame(3),dropped:2}]);
 assert.deepEqual(lost,{missingFrames:2,missingSamples:1920,missingMs:40,captureDrops:2,discontinuities:0});
 assert.equal(audioIntegrity([frame(0),{...frame(1),stream_id:2}]).discontinuities,1);
 assert.equal(audioIntegrity([frame(0),{...frame(5),segment:1}]).missingSamples,0);
});
test('live envelope leaves an empty time interval for lost audio but draws recorded silence',()=>{
 const e=audioEnvelope([frame(0,16384),frame(2)],1000,1060,60);
 assert.equal(e.high[10],.5);assert.equal(e.high[30],-Infinity);assert.equal(e.low[30],Infinity);
 assert.equal(e.high[50],0);assert.equal(e.low[50],0);assert.equal(e.minimum,0);assert.equal(e.maximum,.5);
});
test('A3 binary IMU retains independent signed timestamp offsets, native counts and metadata',()=>{
 const b=new Uint8Array(74),v=new DataView(b.buffer);b.set([0xb8,0x1f,0x3f,0xa6,0xcd,0x88]);
 v.setBigUint64(6,1793967805123n,true);v.setBigUint64(14,5000000000n,true);
 [123,4,5,6].forEach((x,i)=>v.setUint32(22+4*i,x,true));b[38]=1;b[39]=2;
 const rows=[[0,0,1,-32768,0,32767,17],[-9,-1,2,-1,2048,-2048,18]];
 rows.forEach((r,i)=>{const p=40+i*17;v.setInt32(p,r[0],true);v.setInt16(p+4,r[1],true);b[p+6]=r[2];for(let a=0;a<3;a++)v.setInt16(p+7+2*a,r[3+a],true);v.setUint32(p+13,r[6],true);});
 const decoded=decodeBlePacket(3,b);
 const ratePacket=new Uint8Array(76);ratePacket.set(b.subarray(0,40));ratePacket.set(b.subarray(40),42);new DataView(ratePacket.buffer).setUint16(40,416,true);
 assert.equal(decodeBlePacket(4,ratePacket).imu_rate_hz,416);assert.deepEqual(decodeBlePacket(4,ratePacket).imu_raw,decoded.imu_raw);
 new DataView(ratePacket.buffer).setUint16(40,999,true);assert.throws(()=>decodeBlePacket(4,ratePacket),/Invalid/);
 assert.deepEqual(decoded.imu_raw,[[5000000000,1,-32768,0,32767,17,1793967805123],[4999999991,2,-1,2048,-2048,18,1793967805122]]);
 assert.equal(decoded.device_id,'88cda63f1fb8');assert.equal(decoded.imu_overruns,5);assert.equal(decoded.imu_dropped,6);assert.equal(decoded.imu_segment,4);
 const wire=new Uint8Array(86),w=new DataView(wire.buffer);wire.set([80,65,76,2,3,0]);w.setUint16(6,74,true);w.setUint32(8,crc32(b),true);wire.set(b,12);
 const packets=[],errors=[],parser=new BlePacketParser(p=>packets.push(p),e=>errors.push(e));
 for(let i=0;i<wire.length;i+=11)parser.push(wire.subarray(i,i+11));
 assert.deepEqual(packets,[decoded]);assert.equal(errors.length,0);
 assert.throws(()=>decodeBlePacket(3,b.slice(0,-1)),/Invalid/);b[46]=4;assert.throws(()=>decodeBlePacket(3,b),/Invalid/);
});
