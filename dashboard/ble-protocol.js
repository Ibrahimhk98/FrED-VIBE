export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function decodeBlePacket(kind, bytes) {
  if (kind === 0) return JSON.parse(new TextDecoder().decode(bytes));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 15) throw new Error('Truncated Bluetooth packet');
  let mac = 0;
  for (let i = 5; i >= 0; i--) mac = mac * 256 + bytes[i];
  const device_id = mac.toString(16).padStart(12, '0');
  const time = Number(view.getBigUint64(6, true));
  if (kind === 1) {
    if (bytes.length < 64) throw new Error('Truncated Bluetooth audio header');
    return {
      type:'audio', protocol:2, device_id, audio_time_ms:time,
      stream_id:view.getUint32(14,true), sequence:view.getUint32(18,true), segment:view.getUint32(22,true),
      audio_sample_index:Number(view.getBigUint64(26,true)), audio_monotonic_us:Number(view.getBigUint64(34,true)),
      audio_samples:view.getUint16(42,true), audio_rate_hz:view.getUint16(44,true),
      capture_dropped_frames:view.getUint32(46,true), dma_overruns:view.getUint32(50,true),
      audio_dbfs:view.getFloat32(54,true), clock_synced:!!bytes[58], mic_slot:bytes[59],
      audio_codec:'ima_adpcm', audio_adpcm_bytes:bytes.slice(60)
    };
  }
  if (kind === 2) {
    const count = bytes[14];
    if (count > 16 || bytes.length !== 15 + count * 14) throw new Error('Invalid Bluetooth IMU packet');
    const imu = Array.from({length:count}, (_,i) => {
      const offset = 15 + i * 14;
      return [view.getUint16(offset,true), ...Array.from({length:6}, (_,axis) =>
        view.getInt16(offset+2+axis*2,true) * (axis < 3 ? .122*9.80665/1000 : 17.50*(3.14159265/180)/1000))];
    });
    return {type:'telemetry', protocol:2, device_id, time_ms:time, imu};
  }
  if (kind === 3 || kind === 4) {
    const header=kind===4?42:40;
    if(bytes.length<header)throw new Error('Truncated A3 Bluetooth IMU header');
    const count=bytes[39], baseUs=Number(view.getBigUint64(14,true));
    const rate=kind===4?view.getUint16(40,true):104;
    if(![26,52,104,208,416].includes(rate) || !count || count>32 || bytes.length!==header+17*count || bytes[38]>1 || !Number.isSafeInteger(baseUs) || !Number.isSafeInteger(time))throw new Error('Invalid A3 Bluetooth IMU packet');
    const imu_raw=Array.from({length:count},(_,i)=>{
      const p=header+i*17, tag=bytes[p+6], us=baseUs+view.getInt32(p,true), ms=time+view.getInt16(p+4,true);
      if(![1,2].includes(tag) || !Number.isSafeInteger(us) || us<0 || ms<0)throw new Error('Invalid A3 Bluetooth IMU record');
      return [us,tag,view.getInt16(p+7,true),view.getInt16(p+9,true),view.getInt16(p+11,true),view.getUint32(p+13,true),ms];
    });
    return {type:'telemetry',protocol:3,device_id,time_ms:time,clock_synced:!!bytes[38],imu_rate_hz:rate,
      stream_id:view.getUint32(22,true),imu_segment:view.getUint32(26,true),
      imu_overruns:view.getUint32(30,true),imu_dropped:view.getUint32(34,true),imu_raw};
  }
  throw new Error('Unknown Bluetooth packet kind');
}

// A message can span many ATT notifications. CRC and magic allow recovery after
// a lost fragment without treating corrupted audio bytes as valid samples.
export class BlePacketParser {
  constructor(onPacket, onError = () => {}) {
    this.buffer = new Uint8Array(0); this.onPacket = onPacket; this.onError = onError;
  }
  push(chunk) {
    const bytes = chunk instanceof DataView ? new Uint8Array(chunk.buffer,chunk.byteOffset,chunk.byteLength) : chunk;
    const joined = new Uint8Array(this.buffer.length + bytes.length);
    joined.set(this.buffer); joined.set(bytes,this.buffer.length); this.buffer = joined;
    while (this.buffer.length >= 12) {
      if (this.buffer[0] !== 80 || this.buffer[1] !== 65 || this.buffer[2] !== 76 || this.buffer[3] !== 2) {
        this.buffer = this.buffer.subarray(1); continue;
      }
      const view = new DataView(this.buffer.buffer,this.buffer.byteOffset,this.buffer.byteLength);
      const length = view.getUint16(6,true), kind = this.buffer[4];
      if (length > 4096 || kind > 4 || this.buffer[5] !== 0) {this.buffer=this.buffer.subarray(1);this.onError(new Error('Invalid Bluetooth header'));continue;}
      if (this.buffer.length < length+12) break;
      const payload = this.buffer.slice(12,length+12);
      if (crc32(payload) !== view.getUint32(8,true)) {this.buffer=this.buffer.subarray(1);this.onError(new Error('Bluetooth CRC mismatch'));continue;}
      this.buffer = this.buffer.subarray(length+12);
      try {this.onPacket(decodeBlePacket(kind,payload));} catch(error) {this.onError(error);}
    }
  }
}
