export const ENV_FIELDS = ['temperature_c', 'humidity_pct', 'pressure_hpa', 'gas_ohms', 'iaq', 'voc_ppm', 'eco2_ppm', 'battery_v', 'battery_pct'];
export const IMU_FIELDS = ['ax', 'ay', 'az', 'gx', 'gy', 'gz'];
export const MAX_RECORDING_BYTES = 96 * 1024 * 1024;
export function newSession() { return { version: 2, device: null, started: Date.now(), ended: 0, imu: [], environment: [], audio: [], bytes: 0, malformed: 0 }; }
export function sessionBounds(session) {
  let start = Infinity, end = -Infinity;
  for (const key of ['imu', 'environment', 'audio']) for (const row of session[key]) {
    start = Math.min(start, row.time_ms);
    end = Math.max(end, row.time_ms + (key === 'audio' ? row.pcm.length * 1000 / row.rate : 0));
  }
  return Number.isFinite(start) ? [start, end] : [0, 0];
}
export function sessionCount(s) { return s.imu.length + s.environment.length + s.audio.length; }
// Playback retains wall-clock gaps and uses each frame's own rate. No concatenation
// that would speed up missing data or change pitch after a transport change.
export function renderAudio(session, startMs, endMs, rate = 16000) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || endMs - startMs > 120000)
    throw new Error('Select between 0 and 120 seconds for audio playback');
  const pcm = new Float32Array(Math.ceil((endMs - startMs) * rate / 1000));
  let covered = 0;
  for (const frame of session.audio) {
    const stop = frame.time_ms + frame.pcm.length * 1000 / frame.rate;
    if (stop <= startMs || frame.time_ms >= endMs) continue;
    const from = Math.max(0, Math.ceil((frame.time_ms - startMs) * rate / 1000));
    const to = Math.min(pcm.length, Math.ceil((stop - startMs) * rate / 1000));
    for (let i = from; i < to; i++) {
      const source = (startMs + i * 1000 / rate - frame.time_ms) * frame.rate / 1000;
      const j = Math.max(0, Math.min(frame.pcm.length - 1, Math.floor(source)));
      const next = Math.min(j + 1, frame.pcm.length - 1), mix = Math.max(0, source - j);
      pcm[i] = (frame.pcm[j] * (1 - mix) + frame.pcm[next] * mix) / 32768;
    }
    covered += Math.max(0, to - from);
  }
  return { pcm, rate, covered };
}
export function wavBytes(pcm, rate) {
  const bytes = new Uint8Array(44 + pcm.length * 2), view = new DataView(bytes.buffer);
  const text = (offset, value) => [...value].forEach((c, i) => bytes[offset + i] = c.charCodeAt(0));
  text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, pcm.length * 2, true);
  pcm.forEach((v, i) => view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(v * 32768))), true));
  return bytes;
}
