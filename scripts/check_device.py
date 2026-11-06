"""Serial streaming smoke check; optional --sync sends the computer's UTC time."""
import argparse
import base64
import collections
import json
import time

import serial


def check_audio(packet):
    samples = packet['audio_samples']
    if not isinstance(samples, int) or not 0 < samples <= 4096:
        raise ValueError('Invalid sample count')
    if 'audio_pcm_s32_b64' in packet:
        key, expected = 'audio_pcm_s32_b64', 4 * samples
        if packet['protocol'] != 3 or packet['audio_codec'] != 'i2s_s32le':
            raise ValueError('Invalid raw audio format')
        if samples != 960 or packet['audio_rate_hz'] != 48000:
            raise ValueError('Unexpected A3 capture format')
    elif 'audio_pcm_s16_b64' in packet:
        key, expected = 'audio_pcm_s16_b64', 2 * samples
    else:
        key, expected = 'audio_adpcm_b64', 4 + samples // 2
    if len(base64.b64decode(packet[key], validate=True)) != expected:
        raise ValueError('Audio payload length mismatch')
    for key in ('stream_id', 'sequence', 'audio_sample_index'):
        if not isinstance(packet[key], int) or packet[key] < 0:
            raise ValueError('Invalid audio sequence metadata')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', required=True)
    parser.add_argument('--seconds', type=int, default=20)
    parser.add_argument('--sync', action='store_true')
    parser.add_argument('--capture')
    args = parser.parse_args()
    counts = collections.Counter()
    audio = []
    statuses = []
    health = []
    environment = None
    malformed = invalid_audio = samples = 0
    buffer = bytearray()
    aligned = False
    capture = open(args.capture, 'w') if args.capture else None
    # Set line state before opening: do not assert ESP32 boot/reset controls.
    device = serial.Serial(port=None, baudrate=230400, timeout=0.02, write_timeout=1)
    device.dtr = device.rts = False
    device.port = args.port
    try:
        device.open()
        # Drain pre-connection backlog before measuring continuity.
        warmup_until = time.monotonic() + 1
        until = warmup_until + args.seconds
        while time.monotonic() < until:
            # Bulk reads are necessary for ~290 kB/s JSON/base64 at 48 kHz.
            buffer.extend(device.read(16384))
            if time.monotonic() < warmup_until:
                buffer.clear()
                continue
            while b'\n' in buffer:
                line, _, remainder = buffer.partition(b'\n')
                buffer = bytearray(remainder)
                if not aligned:
                    # Opening a live stream may start halfway through a packet.
                    aligned = True
                    device.write(b'{"cmd":"get_config"}\n')
                    if args.sync:
                        command = {'cmd': 'set_time', 'unix_ms': int(time.time() * 1000)}
                        device.write((json.dumps(command) + '\n').encode())
                    continue
                try:
                    packet = json.loads(line)
                    if not isinstance(packet, dict):
                        raise ValueError('Expected an object')
                except (ValueError, UnicodeDecodeError):
                    malformed += 1
                    continue
                kind = packet.get('type')
                counts[kind] += 1
                if capture:
                    capture.write(json.dumps(packet) + '\n')
                if kind in ('status', 'configuration'):
                    statuses.append(packet)
                elif kind == 'health':
                    health.append(packet)
                elif kind == 'environment':
                    environment = packet
                elif kind == 'audio':
                    try:
                        check_audio(packet)
                    except (ValueError, KeyError, TypeError):
                        invalid_audio += 1
                        continue
                    audio.append({k: v for k, v in packet.items() if not k.endswith('_b64')})
                    samples += packet['audio_samples']
            if len(buffer) > 65536:
                malformed += 1
                buffer.clear()
    finally:
        device.close()
        if capture:
            capture.close()
    gaps = sum(max(0, b['sequence'] - a['sequence'] - 1)
               for a, b in zip(audio, audio[1:]) if a['stream_id'] == b['stream_id'])
    discontinuities = sum(b['sequence'] <= a['sequence'] or
                          b['audio_sample_index'] != a['audio_sample_index'] + a['audio_samples']
                          for a, b in zip(audio, audio[1:]) if a['stream_id'] == b['stream_id'])
    counters = ('imu_overruns', 'imu_dropped', 'audio_dropped', 'audio_overruns',
                'telemetry_dropped', 'usb_dropped', 'ble_dropped')
    delta = {key: health[-1][key] - health[0][key] for key in counters
             if health and key in health[0] and key in health[-1]}
    print(json.dumps({'packets': dict(counts), 'malformed_lines': malformed,
                      'invalid_audio': invalid_audio, 'samples': samples,
                      'sequence_gaps': gaps, 'sample_discontinuities': discontinuities,
                      'first_audio': audio[0] if audio else None,
                      'last_audio': audio[-1] if audio else None,
                      'health_counter_increases': delta,
                      'last_health': health[-1] if health else None,
                      'last_environment': environment, 'status': statuses}, indent=2))
    if not audio or malformed or invalid_audio or gaps or discontinuities:
        raise SystemExit('Stream check failed; see diagnostics above')


if __name__ == '__main__':
    main()
