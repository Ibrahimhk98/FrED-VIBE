export class ImaAdpcmDecoder {
      static STEP_TABLE = [
        7, 8, 9, 10, 11, 12, 13, 14, 16, 17,
        19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
        50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
        130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
        337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
        876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
        2272, 2499, 2749, 3024, 3326, 3659, 4025, 4428, 4870, 5357,
        5893, 6482, 7130, 7843, 8627, 9490, 10439, 11483, 12631, 13895,
        15285, 16814, 18495, 20345, 22380, 24618, 27079, 29787, 32767
      ];

      static INDEX_TABLE = [
        -1, -1, -1, -1, 2, 4, 6, 8,
        -1, -1, -1, -1, 2, 4, 6, 8
      ];

      constructor() {
        this.reset();
      }

      reset() {
        this.predictedSample = 0;
        this.stepIndex = 0;
      }

      decodeNibble(nibble) {
        const step = ImaAdpcmDecoder.STEP_TABLE[this.stepIndex];
        let delta = step >> 3;
        if (nibble & 4) delta += step;
        if (nibble & 2) delta += (step >> 1);
        if (nibble & 1) delta += (step >> 2);

        if (nibble & 8) {
          this.predictedSample -= delta;
        } else {
          this.predictedSample += delta;
        }

        if (this.predictedSample > 32767) this.predictedSample = 32767;
        if (this.predictedSample < -32768) this.predictedSample = -32768;

        this.stepIndex += ImaAdpcmDecoder.INDEX_TABLE[nibble & 0x0F];
        if (this.stepIndex < 0) this.stepIndex = 0;
        if (this.stepIndex > 88) this.stepIndex = 88;

        return this.predictedSample;
      }

      decodeBlock(adpcmBytes) {
        const pcmSamples = new Int16Array(adpcmBytes.length * 2);
        let outIdx = 0;
        for (let i = 0; i < adpcmBytes.length; i++) {
          const byte = adpcmBytes[i];
          pcmSamples[outIdx++] = this.decodeNibble(byte & 0x0F);
          pcmSamples[outIdx++] = this.decodeNibble((byte >> 4) & 0x0F);
        }
        return pcmSamples;
      }

      // Matches firmware encodeBlockSelfContained: 4-byte header (int16 first sample LE,
      // step index, reserved) seeds the predictor so blocks decode with no boundary click.
      decodeBlockSelfContained(adpcmBytes) {
        if (adpcmBytes.length < 4) return new Int16Array(0);
        let first = adpcmBytes[0] | (adpcmBytes[1] << 8);
        if (first & 0x8000) first -= 0x10000;
        this.predictedSample = first;
        this.stepIndex = Math.max(0, Math.min(88, adpcmBytes[2]));
        const pcmSamples = new Int16Array(1 + (adpcmBytes.length - 4) * 2);
        let outIdx = 0;
        pcmSamples[outIdx++] = first;
        for (let i = 4; i < adpcmBytes.length; i++) {
          const byte = adpcmBytes[i];
          pcmSamples[outIdx++] = this.decodeNibble(byte & 0x0F);
          pcmSamples[outIdx++] = this.decodeNibble((byte >> 4) & 0x0F);
        }
        return pcmSamples;
      }
    }


export function decodeAudio(data, transport) {
  const rate = Number(data.audio_rate_hz);
  const count = Number(data.audio_samples);
  if (!Number.isInteger(rate) || rate < 8000 || rate > 52800 || !Number.isInteger(count) || count < 1 || count > 48000)
    throw new Error('Invalid audio rate or sample count');
  const codec = data.audio_pcm_s32_b64 ? 'i2s_s32le' : data.audio_pcm_s16_b64 ? 'pcm_s16le' : 'ima_adpcm';
  const payload = data.audio_pcm_s32_b64 ?? data.audio_pcm_s16_b64 ?? data.audio_adpcm_b64 ?? data.audio_adpcm_bytes;
  if (typeof payload !== 'string' && !(payload instanceof Uint8Array)) throw new Error('Missing audio payload');
  const bytes = payload instanceof Uint8Array ? payload : Uint8Array.from(atob(payload), c => c.charCodeAt(0));
  let pcm;
  if (codec === 'i2s_s32le') {
    if (bytes.length !== count * 4) throw new Error('Truncated PCM frame');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    pcm = Int32Array.from({length: count}, (_, i) => view.getInt32(i * 4, true));
  } else if (codec === 'pcm_s16le') {
    if (bytes.length !== count * 2) throw new Error('Truncated PCM frame');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    pcm = Int16Array.from({length: count}, (_, i) => view.getInt16(i * 2, true));
  } else {
    if (bytes.length !== 4 + Math.ceil((count - 1) / 2) || bytes[2] > 88) throw new Error('Invalid ADPCM frame');
    // The final packed nibble is padding for even sample counts. Never play it.
    pcm = new ImaAdpcmDecoder().decodeBlockSelfContained(bytes).slice(0, count);
  }
  const time = Number(data.audio_time_ms);
  if (!Number.isFinite(time)) throw new Error('Missing audio timestamp');
  return {
    pcm, time_ms: time, rate, codec, transport, device_id: data.device_id,
    sequence: Number(data.sequence ?? 0), stream_id: Number(data.stream_id ?? 0),
    segment: Number(data.segment ?? 0), sample_index: Number(data.audio_sample_index ?? 0),
    monotonic_us: Number(data.audio_monotonic_us ?? 0), dbfs: Number(data.audio_dbfs),
    dropped: Number(data.capture_dropped_frames ?? 0), overruns: Number(data.dma_overruns ?? 0),
    clock_synced: !!data.clock_synced
  };
}

export class LineParser {
  constructor(onPacket, onError = () => {}, {usbBootLog = false} = {}) {
    this.buffer = ''; this.discarding = false; this.onPacket = onPacket; this.onError = onError;
    this.usbBootLog = usbBootLog; this.seenPacket = false;
  }
  push(text) {
    this.buffer += text;
    let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).trim(); this.buffer = this.buffer.slice(end + 1);
      if (this.discarding) { this.discarding = false; continue; }
      if (!line) continue;
      if (line.length > 65536) {this.onError(new Error('Oversized frame')); continue;}
      // Native CDC may reset on open. These are ROM/IDF diagnostics, not packets.
      // Restrict filtering to known boot lines before the first valid JSON packet.
      if (this.usbBootLog && !this.seenPacket && /^(ESP-ROM:|Build:|rst:0x|Saved PC:0x|SPIWP:0x|mode:|load:0x|entry 0x|E \(\d+\) esp_core_dump_flash: No core dump partition found!$)/.test(line)) continue;
      try { const data = JSON.parse(line); this.onPacket(data); this.seenPacket = true; } catch (e) { this.onError(e); }
    }
    if (this.buffer.length > 65536) { this.buffer = ''; this.discarding = true; this.onError(new Error('Oversized frame')); }
  }
}
