import { ENV_FIELDS, IMU_FIELDS, newSession } from './session.js';
const AUDIO_FIELDS = ['time_ms', 'rate', 'sequence', 'stream_id', 'segment', 'sample_index', 'monotonic_us', 'dbfs', 'dropped', 'overruns', 'clock_synced'];
const TRANSPORTS = ['usb', 'ble', 'ws'];
const CODECS = ['pcm_s16le', 'ima_adpcm', 'i2s_s32le'];
const RAW_FIELDS = ['time_ms','monotonic_us','tag','x','y','z','sequence','segment','stream_id','clock_synced'];
const ENV_STATUS = ['monotonic_us','new_data','gas_valid','heater_stable','measurement_index','profile_id','clock_synced'];
const HEALTH_FIELDS = ['time_ms','clock_synced','battery_v','imu_ready','bme_ready','mic_ready','imu_overruns','imu_dropped','imu_unknown_tags','audio_dropped','audio_overruns','audio_queue_high_water','telemetry_dropped','usb_dropped','ble_dropped','free_heap','free_psram'];
function writeRows(group,name,rows,fields) {
  const values=Float64Array.from(rows.flatMap(row=>fields.map(f=>row[f]==null ? NaN:Number(row[f]))));
  dataset(group,name,values,[rows.length,fields.length]).create_attribute('columns',fields);
}
function readRows(file,path,fields) {
  const ds=file.get(path);if(!ds)return [];
  const values=ds.value;
  if(ds.shape.length!==2 || ds.shape[1]!==fields.length || values.length%fields.length) throw new Error('Invalid raw/health table');
  return Array.from({length:values.length/fields.length},(_,i)=>Object.fromEntries(fields.map((f,j)=>[f,values[i*fields.length+j]])));
}
function dataset(group, name, data, shape = [data.length]) {
  const options = {name, data, shape};
  if (data.length) Object.assign(options, { chunks: [Math.min(shape[0], 4096), ...shape.slice(1)], compression: 'gzip', compression_opts: [4] });
  return group.create_dataset(options);
}
export function writeSession(h5, FS, session) {
  const path = 'recording.h5'; let file;
  try {
    file = new h5.File(path, 'w');
    file.create_attribute('device_id', session.device?.id || '');
    file.create_attribute('device_name', session.device?.name || '');
    file.create_attribute('schema', 'pal-v2-timeseries');
    const v3=!!session.configuration || !!session.imu_raw?.length || !!session.health?.length || session.audio.some(f=>f.pcm instanceof Int32Array);
    file.create_attribute('schema_version', new Uint32Array([v3?3:2]));
    if(v3) {
      file.create_attribute('configuration_json', JSON.stringify(session.configuration ?? null));
      writeRows(file.create_group('imu_raw'),'records',session.imu_raw || [],RAW_FIELDS);
      writeRows(file.create_group('health'),'records',session.health || [],HEALTH_FIELDS);
    }
    file.create_attribute('started_ms', new Float64Array([session.started]));
    file.create_attribute('ended_ms', new Float64Array([session.ended || Date.now()]));
    file.create_attribute('malformed_packets', new Uint32Array([session.malformed || 0]));
    file.create_attribute('time_reference', 'Device Unix milliseconds; consult per-frame clock_synced. Audio sample time = frame time + sample offset / rate.');
    for (const [name, fields] of [['imu', IMU_FIELDS], ['environment', ENV_FIELDS]]) {
      const rows = session[name], group = file.create_group(name);
      dataset(group, 'time_ms', Float64Array.from(rows, r => r.time_ms));
      const values = new Float32Array(rows.length * fields.length);
      rows.forEach((r, i) => fields.forEach((key, j) => values[i * fields.length + j] = r[key] ?? NaN));
      const ds = dataset(group, 'values', values, [rows.length, fields.length]);
      if(v3 && name==='environment') writeRows(group,'status',rows,ENV_STATUS);
      ds.create_attribute('columns', fields);
      ds.create_attribute('units', name === 'imu' ? ['m/s^2', 'm/s^2', 'm/s^2', 'rad/s', 'rad/s', 'rad/s'] : ['degC', '%', 'hPa', 'ohm', 'index (estimate)', 'ppm (estimate)', 'ppm (estimate)', 'V', '%']);
    }
    const group = file.create_group('audio'), frames = session.audio;
    const total = frames.reduce((sum, f) => sum + f.pcm.length, 0);
    // Chunked writes avoid constructing a second full-length PCM array in JS.
    const pcm = group.create_dataset({name:v3?'pcm_s32':'pcm_s16', data:v3?new Int32Array(0):new Int16Array(0), shape:[0], maxshape:[null], chunks:[16000], compression:'gzip', compression_opts:[4]});
    pcm.resize([total]);
    const offsets = new Float64Array(frames.length + 1); let offset = 0;
    frames.forEach((f, i) => { offsets[i] = offset; pcm.write_slice([[offset, offset + f.pcm.length]], v3 && !(f.pcm instanceof Int32Array) ? Int32Array.from(f.pcm,v=>v*65536) : f.pcm); offset += f.pcm.length; });
    offsets[frames.length] = total;
    dataset(group, 'frame_offsets', offsets);
    for (const key of AUDIO_FIELDS) dataset(group, key, Float64Array.from(frames, f => Number(f[key] ?? 0)));
    dataset(group, 'transport', Uint8Array.from(frames, f => TRANSPORTS.indexOf(f.transport)));
    dataset(group, 'codec', Uint8Array.from(frames, f => CODECS.indexOf(f.codec)));
    group.create_attribute('transport_codes', TRANSPORTS);
    group.create_attribute('codec_codes', CODECS);
    pcm.create_attribute('units', v3 ? 'unshifted signed I2S words, full scale = 2147483648; legacy/ADPCM preview promoted by 65536; inspect codec per frame' : 'signed PCM, full scale = 32768; ADPCM sources are decoded, lossy samples');
    file.flush(); file.close(); file = null;
    return FS.readFile(path).slice();
  } finally { if (file) file.close(); try { FS.unlink(path); } catch {} }
}
export function readSession(h5, FS, bytes) {
  const path = 'import.h5'; let file;
  try {
    FS.writeFile(path, bytes); file = new h5.File(path, 'r');
    const version=Number(file.attrs.schema_version?.value);
    if (file.attrs.schema?.value !== 'pal-v2-timeseries' || ![2,3].includes(version))
      throw new Error('Use a PAL time-series HDF5 recording (schema version 2 or 3)');
    const session = newSession();
    if(file.attrs.device_id?.value) session.device = {id:file.attrs.device_id.value,name:file.attrs.device_name?.value || file.attrs.device_id.value};
    session.started = Number(file.attrs.started_ms.value); session.ended = Number(file.attrs.ended_ms.value);
    session.malformed = Number(file.attrs.malformed_packets?.value || 0);
    // Bound decompressed data before asking WASM to allocate it.
    let size = 0;
    for (const path of file.paths()) {
      const ds = file.get(path);
      if (ds.shape) size += ds.shape.reduce((a,b) => a*b, 1) * 8;
    }
    if (size > 512 * 1024 * 1024) throw new Error('Recording is too large for the browser explorer');
    for (const [name, fields] of [['imu', IMU_FIELDS], ['environment', ENV_FIELDS]]) {
      const t = file.get(`${name}/time_ms`).value, values = file.get(`${name}/values`).value;
      if (values.length !== t.length * fields.length || !Array.from(t).every(Number.isFinite)) throw new Error('Invalid sensor array dimensions');
      session[name] = Array.from(t, (time_ms, i) => Object.fromEntries([['time_ms', time_ms], ...fields.map((f, j) => [f, values[i * fields.length + j]])]));
    }
    if(version===3) {
      session.configuration=JSON.parse(file.attrs.configuration_json?.value || 'null');
      session.imu_raw=readRows(file,'imu_raw/records',RAW_FIELDS);
      session.health=readRows(file,'health/records',HEALTH_FIELDS);
      const envStatus=readRows(file,'environment/status',ENV_STATUS);
      if(envStatus.length!==session.environment.length)throw new Error('Invalid environment status dimensions');
      session.environment.forEach((row,i)=>Object.assign(row,envStatus[i]));
    }
    const pcm = file.get(version===3?'audio/pcm_s32':'audio/pcm_s16').value, offsets = file.get('audio/frame_offsets').value;
    const meta = Object.fromEntries([...AUDIO_FIELDS, 'transport', 'codec'].map(f => [f, file.get(`audio/${f}`).value]));
    const count = meta.time_ms.length;
    if (!(version===3 ? pcm instanceof Int32Array : pcm instanceof Int16Array) || offsets.length !== count + 1 || offsets[0] !== 0 || offsets[count] !== pcm.length || Object.values(meta).some(a => a.length !== count))
      throw new Error('Invalid audio frame index');
    for (let i = 0; i < count; i++) {
      if (!Number.isInteger(offsets[i]) || offsets[i + 1] <= offsets[i] || offsets[i + 1] > pcm.length || !Number.isFinite(meta.time_ms[i]) || !Number.isInteger(meta.rate[i]) || meta.rate[i] < 8000 || meta.rate[i] > 52800)
        throw new Error('Invalid audio frame metadata');
      session.audio.push({...Object.fromEntries(AUDIO_FIELDS.map(f => [f, meta[f][i]])), pcm: version===3 && CODECS[meta.codec[i]]!=='i2s_s32le' ? Int16Array.from(pcm.subarray(offsets[i],offsets[i+1]),v=>v/65536) : pcm.subarray(offsets[i], offsets[i + 1]), transport:TRANSPORTS[meta.transport[i]], codec:CODECS[meta.codec[i]]});
    }
    session.bytes = pcm.byteLength + session.imu.length * 64 + session.environment.length * 160 + session.imu_raw.length*160 + session.health.length*256;
    return session;
  } finally { if (file) file.close(); try { FS.unlink(path); } catch {} }
}
