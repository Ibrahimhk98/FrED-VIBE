// Quaternions are [w,x,y,z]. q rotates sensor vectors into a +Z-up world.
export const identity = () => [1,0,0,0];
export const conjugate = q => [q[0],-q[1],-q[2],-q[3]];
export function multiply(a,b) {
  const [w,x,y,z]=a,[v,i,j,k]=b;
  return [w*v-x*i-y*j-z*k,w*i+x*v+y*k-z*j,w*j-x*k+y*v+z*i,w*k+x*j-y*i+z*v];
}
const normalize = q => {const n=Math.hypot(...q); return n>1e-12 ? q.map(v=>v/n):identity();};
export function rotate(q,v) { return multiply(multiply(q,[0,...v]),conjugate(q)).slice(1); }
export function fromEuler(roll,pitch,yaw) {
  const axis=(angle,i)=>{const q=[Math.cos(angle/2),0,0,0];q[i]=Math.sin(angle/2);return q;};
  return multiply(multiply(axis(yaw,3),axis(pitch,2)),axis(roll,1));
}
function gravityPose(a) {
  const [x,y,z]=a.map(v=>v/Math.hypot(...a));
  return z < -.999999 ? [0,1,0,0] : normalize([1+z,y,-x,0]);
}
export const TRIM_DURATION_MS = 2000;
export class Orientation {
  constructor() {this.reset();}
  reset() {
    this.q=identity();this.boardToSensor=identity();this.gyroBias=[0,0,0];
    this.time=null;this.ready=false;this.trimmed=false;this.calibrating=false;
    this.trimState={phase:'idle',progress:0};this.window=null;
  }
  beginTrim() {
    if(!this.ready)return false;
    this.calibrating=true;this.window=null;this.trimState={phase:'collecting',progress:0};return true;
  }
  cancelTrim() {this.calibrating=false;this.window=null;this.trimState={phase:'idle',progress:0};}
  collectTrim(accel,gyro,timeMs,gap) {
    if(!this.calibrating)return;
    const stable=Math.abs(Math.hypot(...accel)-9.80665)<.5 && Math.hypot(...gyro)<.12;
    if(!stable || gap) {this.window=null;this.trimState={phase:'moving',progress:0};return;}
    if(this.window && Math.hypot(...accel.map((v,i)=>v-this.window.first[i]))>.15) {
      this.window=null;this.trimState={phase:'moving',progress:0};return;
    }
    if(!this.window)this.window={start:timeMs,first:[...accel],accel:[0,0,0],gyro:[0,0,0],count:0};
    const w=this.window;
    accel.forEach((v,i)=>w.accel[i]+=v);gyro.forEach((v,i)=>w.gyro[i]+=v);w.count++;
    this.trimState={phase:'collecting',progress:Math.min(1,(timeMs-w.start)/TRIM_DURATION_MS)};
    if(timeMs-w.start<TRIM_DURATION_MS || w.count<20)return;
    this.q=gravityPose(w.accel.map(v=>v/w.count));
    this.gyroBias=w.gyro.map(v=>v/w.count);
    // The board is physically flat here. Store a fixed sensor mounting transform.
    // Right multiplication preserves world gravity when the board subsequently turns.
    this.boardToSensor=conjugate(this.q);this.trimmed=true;this.calibrating=false;
    this.window=null;this.trimState={phase:'complete',progress:1};
  }
  update(accel,gyro,timeMs) {
    if (![...accel,...gyro,timeMs].every(Number.isFinite)) return false;
    const norm=Math.hypot(...accel);
    if (this.time!==null && timeMs<=this.time) return false;
    let dt=this.time===null ? 0:(timeMs-this.time)/1000;
    const gap=dt>.25;
    if (!this.ready || gap) {
      if (norm<7.8 || norm>11.8) return false;
      if(!this.ready) this.q=gravityPose(accel);
      else {
        // Correct tilt after a gap without integrating unknown gyro samples or
        // discarding the fixed mounting calibration. Unobserved yaw cannot be recovered.
        this.q=normalize(multiply(gravityPose(rotate(this.q,accel)),this.q));
      }
      dt=0;this.ready=true;
    }
    const omega=gyro.map((v,i)=>v-this.gyroBias[i]);
    // At rest, accelerometer specific force points up. Correct it toward world +Z.
    // Reject gravity correction during substantial linear acceleration; yaw remains relative.
    if (norm>8.8 && norm<10.8) {
      const a=accel.map(v=>v/norm),g=rotate(conjugate(this.q),[0,0,1]);
      const error=[a[1]*g[2]-a[2]*g[1],a[2]*g[0]-a[0]*g[2],a[0]*g[1]-a[1]*g[0]];
      error.forEach((v,i)=>omega[i]+=1.5*v);
    }
    const speed=Math.hypot(...omega),angle=speed*dt;
    if(speed>1e-12) this.q=normalize(multiply(this.q,[Math.cos(angle/2),...omega.map(v=>v/speed*Math.sin(angle/2))]));
    this.time=timeMs;this.collectTrim(accel,gyro,timeMs,gap);return true;
  }
  clearTrim() {this.cancelTrim();this.boardToSensor=identity();this.gyroBias=[0,0,0];this.trimmed=false;}
  get pose() {return normalize(multiply(this.q,this.boardToSensor));}
  get angles() {
    const [w,x,y,z]=this.pose;
    return [Math.atan2(2*(w*x+y*z),1-2*(x*x+y*y)),Math.asin(Math.max(-1,Math.min(1,2*(w*y-z*x)))),Math.atan2(2*(w*z+x*y),1-2*(y*y+z*z))].map(v=>v*180/Math.PI);
  }
}

// Tagged accelerometer and gyro records remain separate in saved data. A fresh
// pair within 1.5 periods is used only for plots/orientation, never called synchronous.
export class ImuPreview {
  constructor() {this.reset();}
  reset() {this.key=null;this.pending={};this.sequences={};}
  consume(packet) {
    const key=`${packet.device_id}/${packet.stream_id}/${packet.imu_segment}`;
    if(key!==this.key) {this.reset();this.key=key;}
    const raw=[],pairs=[];
    for(const row of packet.imu_raw || []) {
      if(row.length!==7 || !row.every(Number.isFinite)) continue;
      const [monotonic_us,tag,x,y,z,sequence,time_ms]=row;
      if(![1,2].includes(tag) || !Number.isSafeInteger(sequence) || sequence<0 || !Number.isSafeInteger(monotonic_us) || monotonic_us<0 ||
        ![x,y,z].every(v=>Number.isInteger(v)&&v>=-32768&&v<=32767) || sequence<=(this.sequences[tag]??-1)) continue;
      if(this.sequences[tag]!==undefined && sequence!==this.sequences[tag]+1) this.pending={};
      this.sequences[tag]=sequence;
      const sample={monotonic_us,tag,x,y,z,sequence,time_ms,segment:packet.imu_segment,stream_id:packet.stream_id,clock_synced:!!packet.clock_synced};
      raw.push(sample);this.pending[tag]=sample;
      const a=this.pending[2],g=this.pending[1];
      if(a&&g) {
        const rate=[26,52,104,208,416].includes(packet.imu_rate_hz)?packet.imu_rate_hz:104;
        if(Math.abs(a.monotonic_us-g.monotonic_us)<=1500000/rate) {
          pairs.push({time_ms:g.time_ms,monotonic_us:g.monotonic_us,accel:[a.x,a.y,a.z].map(v=>v*.122*9.80665/1000),gyro:[g.x,g.y,g.z].map(v=>v*17.5*Math.PI/180/1000)});
          this.pending={};
        } else delete this.pending[a.monotonic_us<g.monotonic_us?2:1];
      }
    }
    return {raw,pairs,key};
  }
}
