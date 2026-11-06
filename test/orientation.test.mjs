import test from 'node:test';
import assert from 'node:assert/strict';
import { Orientation, ImuPreview, rotate, conjugate, multiply, fromEuler } from '../dashboard/orientation.js';
const near=(a,b,tolerance=1e-5)=>assert.ok(Math.abs(a-b)<tolerance,`${a} != ${b}`);
const gravity=[0,0,9.80665];
function calibrate(f,accel=gravity,bias=[0,0,0],start=0) {
 f.update(accel,bias,start);assert.ok(f.beginTrim());
 for(let i=1;i<=201;i++)f.update(accel,bias,start+i*10);
 assert.ok(f.trimmed);assert.equal(f.calibrating,false);return start+2010;
}
test('gravity quaternion aligns tilted and inverted sensor axes with world +Z',()=>{
 for(const angles of [[.7,-.4,0],[Math.PI,0,0],[0,Math.PI/2,0]]) {
  const a=rotate(conjugate(fromEuler(...angles)),gravity);
  const f=new Orientation();assert.ok(f.update(a,[0,0,0],1000));
  rotate(f.q,a).forEach((v,i)=>near(v,gravity[i]));
 }
});
test('flat calibration measures gyro bias and requires two seconds of stillness',()=>{
 const f=new Orientation(),bias=[.01,-.008,.015];
 f.update(gravity,bias,0);f.beginTrim();
 for(let i=1;i<=100;i++)f.update(gravity,bias,i*10);
 assert.equal(f.trimmed,false);
 f.update([2,0,9.8],[.2,0,0],1010);assert.equal(f.trimState.phase,'moving');
 for(let i=102;i<=303;i++)f.update(gravity,bias,i*10);
 assert.ok(f.trimmed);f.gyroBias.forEach((v,i)=>near(v,bias[i]));
 for(let i=304;i<=603;i++)f.update(gravity,bias,i*10);
 f.angles.forEach(v=>near(v,0));
 f.clearTrim();assert.equal(f.trimmed,false);assert.deepEqual(f.gyroBias,[0,0,0]);
});
test('a mounted sensor turning about world Z keeps the calibrated board flat',()=>{
 const f=new Orientation(),a=rotate(conjugate(fromEuler(.7,-.45,0)),gravity);
 let t=calibrate(f,a),initial=[...f.q],mounting=[...f.boardToSensor];
 const gyro=rotate(conjugate(initial),[0,0,Math.PI/2]);
 for(let i=1;i<=100;i++)f.update(a,gyro,t+i*10);
 near(f.angles[0],0);near(f.angles[1],0);near(f.angles[2],90);
 rotate(f.pose,[0,0,1]).forEach((v,i)=>near(v,[0,0,1][i]));
 assert.deepEqual(f.boardToSensor,mounting);
});
test('calibrated roll follows the board despite tilted native sensor axes',()=>{
 const f=new Orientation(),a=rotate(conjugate(fromEuler(.7,-.45,0)),gravity);
 const t=calibrate(f,a),initial=[...f.q],gyro=rotate(conjugate(initial),[Math.PI/2,0,0]);
 for(let i=1;i<=100;i++) {
  const actual=multiply(fromEuler(i*Math.PI/200,0,0),initial);
  f.update(rotate(conjugate(actual),gravity),gyro,t+i*10);
 }
 near(f.angles[0],90,1);near(f.angles[1],0,.1);near(f.angles[2],0,.1);
});
test('acceleration rejection and data gaps preserve the fixed calibration',()=>{
 const f=new Orientation(),a=rotate(conjugate(fromEuler(.4,.2,0)),gravity);
 const t=calibrate(f,a),mounting=[...f.boardToSensor];
 assert.equal(f.update([NaN,0,9],[0,0,0],t+10),false);
 assert.equal(f.update(a,[0,0,1],t-1),false);
 f.update(a,[0,0,100],t+2000); // a missing interval is never integrated
 assert.ok(f.trimmed);assert.deepEqual(f.boardToSensor,mounting);f.angles.forEach(v=>near(v,0));
 f.update([20,0,9.8],[0,0,0],t+2010);f.angles.forEach(v=>near(v,0));
 f.reset();assert.equal(f.ready,false);assert.equal(f.trimmed,false);assert.equal(f.beginTrim(),false);
});
test('cancelled or interrupted flat calibration cannot install a partial transform',()=>{
 const f=new Orientation();f.update(gravity,[0,0,0],0);f.beginTrim();
 f.update(gravity,[0,0,0],1000);assert.equal(f.trimState.progress,0);
 f.cancelTrim();assert.equal(f.calibrating,false);assert.equal(f.trimmed,false);
});
test('two-second trim also completes with the lowest selectable 26 Hz IMU rate',()=>{
 const f=new Orientation();f.update(gravity,[0,0,0],0);f.beginTrim();
 for(let i=1;i<=54;i++)f.update(gravity,[0,0,0],i*1000/26);
 assert.ok(f.trimmed);assert.equal(f.calibrating,false);
});
const packet=rows=>({device_id:'test',stream_id:1,imu_segment:0,imu_raw:rows,clock_synced:true});
const row=(us,tag,seq)=>[us,tag,0,0,tag===2?8197:0,seq,1700000000000+us/1000];
test('FIFO preview pairs fresh tags only and preserves exact separate native records',()=>{
 const preview=new ImuPreview();
 assert.equal(preview.consume(packet([row(10000,1,0)])).pairs.length,0);
 let r=preview.consume(packet([row(10000,2,0)]));assert.equal(r.pairs.length,1);assert.equal(r.raw[0].z,8197);
 assert.equal(preview.consume(packet([row(20000,1,1),row(30000,1,2)])).pairs.length,0);
 r=preview.consume(packet([row(30000,2,2)]));assert.equal(r.pairs.length,0); // sequence gap clears pending gyro
 assert.equal(preview.consume(packet([row(30000,1,2)])).raw.length,0); // duplicate
 r=preview.consume(packet([row(40000,1,3)]));assert.equal(r.pairs.length,1);
 assert.equal(preview.consume({...packet([row(50000,2,0)]),stream_id:2}).pairs.length,0);
});
test('stale opposite tags and corrupted/out of range samples are rejected',()=>{
 const p=new ImuPreview();const r=p.consume(packet([row(0,1,0),row(100000,2,0),[1,2,40000,0,0,1,1]]));assert.equal(r.pairs.length,0);assert.equal(r.raw.length,2);
});
