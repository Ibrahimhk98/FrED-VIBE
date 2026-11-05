# PAL V2 sensor acquisition

Firmware for an Adafruit ESP32 Feather V2 with an ICS43434 I2S microphone,
LSM6DSOX IMU, BME688 environmental sensor, and DS3231 RTC. The browser dashboard
connects over USB serial, Bluetooth LE, or Wi-Fi and saves synchronized time
series to compressed HDF5. A separate explorer opens recordings, plots sensors
on a shared timeline, and plays or exports selected audio ranges.

## Build, flash, and open the dashboard

```sh
~/.platformio/penv/bin/pio run -e adafruit_feather_esp32_v2
~/.platformio/penv/bin/pio run -e adafruit_feather_esp32_v2 -t upload
npm ci
npm run serve
```

Open **http://localhost:8000** in desktop Chrome or Edge. `npm ci` copies the
pinned h5wasm library into `dashboard/vendor`; after that, HDF5 import/export
works without a CDN or an internet connection. Serve the entire dashboard
directory, including its modules and vendor files. Opening `index.html` as a
`file:` URL is unsupported. Font loading is optional; system fonts are used
when offline. No recording data is sent to a cloud service.
`npm run serve` also discovers the kits' `_pal-telemetry._tcp` mDNS service
on the local network and exposes their IPv4 addresses to the dashboard. A plain
static file server still supports acquisition, but does not provide discovery.

The ESP32 uses Arduino-ESP32 2.0.17 / ESP-IDF 4.4 via PlatformIO
`espressif32@6.9.0`. Do not update to Arduino core 3.x without migrating the
legacy I2S and ADC drivers together.

## Connect and record

- **USB:** choose **Connect USB**, select the USB serial adapter, and use
  230400 baud. Close serial monitors before connecting. If Chrome does not list
  the USB adapter but PlatformIO does, use **Connect USB bridge** with the local
  helper below. Direct USB can also be checked with the smoke-test script.
- **Bluetooth:** choose **Connect Bluetooth** and select the kit’s unique `PAL-xxxxxx` name.
  Accept pairing if requested. Command writes require an encrypted connection.
- **Wi-Fi:** use an existing device IP with **Connect selected kit**, or configure it
  from Bluetooth/USB as described below. The browser and ESP32 must be able to
  reach each other on the LAN; guest-network client isolation can prevent this.
  Allow Chrome's local-network access prompt if requested. The socket is
  `ws://<device-ip>:81/`, so use the localhost HTTP dashboard rather than an
  HTTPS-hosted copy that would block mixed-content WebSockets.

| Link | Acoustic stream | Fidelity |
| --- | --- | --- |
| USB serial | 16 kHz mono, independently decodable IMA-ADPCM frames | Lossy 4-bit ADPCM, decoded to signed 16-bit PCM |
| Bluetooth LE | 16 kHz mono, independently decodable IMA-ADPCM frames | Same codec; throughput depends on negotiated BLE link |
| Wi-Fi WebSocket | 16 kHz mono, signed 16-bit little-endian PCM | Uncompressed captured samples |

All links carry **sample sequences**, not sound-level averages. dBFS is an
additional diagnostic. No automatic gain or DC filtering alters stored samples.
The live waveform scales to the signal's observed amplitude range, including
any DC offset. Explorer playback offers gain and an optional 20 Hz high-pass
filter; neither changes HDF5 or WAV samples.

Synchronize the RTC before recording. Click **Record**, then **Stop** and
**Export HDF5**. Recording is independent of continuous device streaming. A
successful Bluetooth-to-Wi-Fi handoff can continue the same recording. A lost
connection stops recording and retains the captured data. A new recording or
Clear asks before discarding an existing session. Export is disabled while
recording so the saved file has a definite end.

Recordings remain in browser memory until exported; closing/reloading the page
loses unexported data; a leave-page warning protects active connections and
unexported recordings. Switching to analysis or returning through its navigation
does not reload the acquisition page. A 96 MiB estimated recording cap stops acquisition into
memory and asks for export. HDF5 work runs in a dedicated worker. Audio is held
as `Int16Array` chunks; it is not expanded into one JS object per audio sample.

## USB bridge fallback

For adapters missing from Chrome’s serial chooser, run this once with Python 3.10+
(the PlatformIO Python interpreter also works):

```sh
python3 -m venv .venv-usb
.venv-usb/bin/pip install -r scripts/requirements-usb.txt
```

Start the helper alongside `npm run serve`:

```sh
.venv-usb/bin/python scripts/usb_bridge.py
```

Then choose **Connect USB bridge**. With several USB adapters attached, specify
`--port /dev/cu.usbserial-YOUR_DEVICE`. The helper uses the wired serial link;
it does not require ESP32 Wi-Fi or Bluetooth. It listens only on loopback,
accepts the localhost:8000 dashboard origin, and permits one connected dashboard.
Recordings retain `usb` as their source transport. Stop the helper with Ctrl+C.

## Configure Wi-Fi over Bluetooth

1. Connect Bluetooth (or USB) and expand **Configure Wi-Fi over Bluetooth or USB**.
2. Enter a **2.4 GHz** network name and password. SSIDs are 1–32 UTF-8 bytes;
   passwords are empty for an open network, or 8–63 bytes for a passphrase.
   Spaces, quotes and backslashes are preserved through JSON escaping.
3. Click **Send credentials & switch**. Commands are serialized and fragmented
   into acknowledged 20-byte BLE writes, then reassembled on the ESP32 before parsing.
4. The device joins asynchronously and announces its IP on the current link.
   The dashboard opens the WebSocket automatically, then releases the old link.
   BLE is suspended only after a WebSocket client connects.
5. Failed association times out after 20 seconds and restores BLE availability.
   A closed WebSocket restores BLE advertising. **Turn Wi-Fi off** switches
   the radio back to BLE; reconnect Bluetooth to resume streaming.

Credentials are held in device RAM, are never echoed into telemetry or saved
with recordings, and are cleared from the dashboard password input after being
sent. A reboot returns to Bluetooth/USB setup. They are not persisted to flash.
BLE uses encrypted “Just Works” pairing (no authenticated passkey); Wi-Fi
WebSockets are unencrypted and unauthenticated. Use the kit on a trusted LAN.

## Multiple kits on one router

Each kit has a stable hardware-derived ID, a Bluetooth name such as
`PAL-d6cdc0`, and a unique mDNS hostname such as `pal-346c38d6cdc0.local`.
Every sensor/audio/status packet includes the device ID; connection/status
packets also carry the name and hostname to avoid repeating them in every frame. Multiple kits
can stay associated with the same 2.4 GHz access point while the dashboard
subscribes to one kit at a time.

Provision each kit over Bluetooth. With **npm run serve**, the dashboard lists
each discovered kit's name and IP in **Wi-Fi kits · name and IP**, with selectable
address cards below. Discovery refreshes every five seconds without connecting
to the kits or interrupting Bluetooth. Select a kit, then **Connect selected kit**
to switch. You can also enter its IP or hostname and choose **Remember address**.
The registry stores addresses and names in browser local storage, never Wi-Fi
passwords. The actual device ID replaces an address-only entry when connected.
Discovery updates a kit's address after DHCP changes it. Saved addresses are
labelled separately and remain selectable when discovery is unavailable.

The local Node server browses mDNS; it does not scan arbitrary addresses or
connect to every kit. It listens only on loopback and only serves its inventory
to the local dashboard. Entries are shown as recently discovered, not guaranteed
reachable; a kit that stops advertising disappears from discovery within 30 s.
The computer and kits must share a network that permits multicast and device
communication. This works with a conventional router, another ESP32 configured
as an access point, or a Raspberry Pi hotspot; no internet connection is required.
When multicast is blocked, use a saved/manual IP or the kit's `.local` hostname.

Switching kits stops the current recording and retains it for export. HDF5 root
attributes `device_id` and `device_name` identify its source, and the explorer
shows the kit identity. The dashboard rejects mixing a different device ID into
an ongoing recording. Simultaneous recording of multiple kits is not included.

## Explore data

**Explore recording** opens a separate browser window/tab with a snapshot of
the current session. Both the navigation link and recording button use the same
analysis window. **Return to live acquisition** focuses the original window
without reloading it or opening a second disconnected dashboard. The live
acquisition window keeps running, and analysis shows its connection/recording
state and sample counts. **Load current dashboard recording** refreshes the
snapshot with newly captured samples; it does not stop recording. The explorer
can also open a saved PAL schema-v2 `.h5` file without a connected device.

- Pan using the timeline slider, or enter start/window durations in seconds.
- Zoom to individual acoustic samples or fit the session.
- Compare audio, acceleration, gyroscope and a selected environmental channel
  on the same time range. Hover to inspect values and timestamps.
- Play up to 120 seconds of the visible range, stop playback, adjust playback
  gain, or save that range as a standard PCM WAV file. Missing audio spans play
  as silence, and each frame's sample rate determines playback timing.

HDF5 imports are bounded to 192 MiB on disk and 512 MiB of estimated expanded
numeric data. This explorer reads the schema below; earlier experimental PAL
HDF5 files and CSV files need conversion before loading.

## HDF5 schema (version 2)

The root has `schema = pal-v2-timeseries`, `schema_version = 2`, recording
start/end wall-clock milliseconds, and malformed-packet count. Numeric
nonempty datasets use chunking and gzip level 4. Audio PCM is written in
chunks to avoid creating another full PCM array in JavaScript.

| Dataset | Type / shape | Meaning |
| --- | --- | --- |
| `/imu/time_ms` | float64, N | Device timestamps in ms |
| `/imu/values` | float32, N × 6 | ax, ay, az (m/s²), gx, gy, gz (rad/s) |
| `/environment/time_ms` | float64, N | Device timestamps in ms |
| `/environment/values` | float32, N × 9 | temperature_c, humidity_pct, pressure_hpa, gas_ohms, iaq, voc_ppm, eco2_ppm, battery_v, battery_pct |
| `/audio/pcm_s16` | int16, M | Concatenated received audio samples |
| `/audio/frame_offsets` | float64, F + 1 | Sample offsets delimiting each frame |
| `/audio/time_ms` | float64, F | Timestamp of the **first** sample of each frame |
| `/audio/rate` | float64, F | Per-frame sample rate in Hz |
| `/audio/monotonic_us` | float64, F | Capture timestamp relative to device boot |
| `/audio/sample_index` | float64, F | Captured sample index, before queue drops |
| `/audio/sequence`, `/audio/stream_id`, `/audio/segment` | float64, F | Frame number, boot ID, DMA continuity segment |
| `/audio/dropped`, `/audio/overruns` | float64, F | Cumulative capture queue drops and DMA overflow events |
| `/audio/dbfs`, `/audio/clock_synced` | float64, F | Frame level and RTC synchronization flag |
| `/audio/transport`, `/audio/codec` | uint8, F | 0/1/2 = USB/BLE/Wi-Fi; 0/1 = PCM/ADPCM |

`values` datasets have column and unit attributes. Missing environmental
values use NaN. Float64 preserves integer epoch milliseconds exactly.

For frame `i`, samples occupy `[frame_offsets[i], frame_offsets[i+1])` and
sample `j` has time `time_ms[i] + 1000*j/rate[i]`. Do not assume consecutive
frames are contiguous: consult sequence, stream ID, segment and timestamps.
An RTC sync changes wall-clock anchoring, so the dashboard disables Sync during
recording; device monotonic timestamps remain available for analysis.

Python example (`pip install h5py`):

```python
import h5py
with h5py.File('recording.h5') as f:
    acceleration = f['imu/values'][:, :3]
    imu_time_ms = f['imu/time_ms'][:]
    offsets = f['audio/frame_offsets'][:].astype('int64')
    i = 0
    pcm = f['audio/pcm_s16'][offsets[i]:offsets[i + 1]]
    rate = f['audio/rate'][i]
    first_sample_ms = f['audio/time_ms'][i]
```

## Firmware and protocol

- A high-priority capture task reads I2S DMA continuously and forms 1,600-sample
  frames. Its bounded queue never waits for networking. Queue overflow increments
  a counter; sequence and sample indices continue, so gaps are detectable.
- DMA overflows start a new continuity segment. The first sample timestamp is
  estimated from capture startup and then advanced by sample count at 16 kHz;
  it is not a hardware RTC timestamp for every individual I2S sample.
- UART TX buffering overlaps USB transmission with radio work; command replies
  have a separate priority queue. BLE retries span multiple connection events.
- A separate task handles serial, BLE notifications, and WebSockets. Sensor
  sampling runs on the other core. IMU timestamps are host read-time estimates;
  the FIFO runs at 104 Hz. Environment is sampled about once per second.
- ADPCM frames have a four-byte predictor/index header. `audio_samples` is
  authoritative: the unused high nibble of the last byte is padding.
- USB and Wi-Fi use JSON Lines with types `audio`, `telemetry` (IMU array),
  `environment`, `status`, and startup `microphone_diagnostics`. Audio protocol
  version is 2. BLE uses compact binary audio/IMU packets, retaining every sample;
  other packets are JSON within the same binary envelope. IMU axes use native
  signed 16-bit counts for the configured ±4 g / ±500 dps ranges and are decoded
  to m/s² and rad/s in the dashboard.
- The BLE envelope is 12 bytes: `PAL` + byte 2, kind (0 JSON / 1 audio / 2 IMU),
  reserved zero, uint16 payload length, uint32 IEEE CRC32 of payload; integers
  are little-endian. Payload layouts are defined in `dashboard/ble-protocol.js`
  and `src/main.cpp`. The parser reassembles notifications and rejects corrupt
  frames. BLE command writes still use newline-terminated UTF-8 JSON.
- RTC interpolation uses `esp_timer_get_time()` to avoid `millis()` rollover.
- The BLE service UUID is `7f510001-5b8d-4a84-9c7c-a07142ab6002`; data notify
  characteristic starts with `7f510002`, and command characteristic with `7f510003`.
  The dashboard completes an encrypted read before sending commands. The v2
  upgrade clears old device pairing records once; later boots preserve bonds.
  If the OS reports “Peer removed pairing information” on that first upgrade,
  forget only the PAL kit in the OS Bluetooth settings, then reconnect to
  establish the new bond.

Commands, each terminated with a newline:

```json
{"cmd":"set_time","unix_ms":1793896772968}
{"cmd":"wifi_on","ssid":"Example network","password":"example-password"}
{"cmd":"wifi_status"}
{"cmd":"wifi_off"}
```

The command limit is 768 UTF-8 bytes. BLE partial commands expire after five
seconds. Input validation uses a JSON parser, not substring matching.

## Wiring

| Signal | Feather GPIO |
| --- | --- |
| Microphone BCLK (A0) | 26 |
| Microphone DOUT (A1) | 25 |
| Microphone LRCL (A5) | 4 |
| Microphone SEL | GND or 3.3 V; active slot is detected and held |
| I2C SDA / SCL (board variant defaults) | 22 / 20 |
| Battery divider | 35 |
| NeoPixel data / power | 0 / 2 |

GPIO39 (A3) is input-only and cannot drive LRCL. The microphone does not need
MCLK; its pin is explicitly disabled so I2S cannot claim NeoPixel GPIO0.

BME688 IAQ/VOC/eCO₂ are heuristic estimates, not calibrated gas concentrations.
Battery voltage uses the existing divider model and may need board-specific
ADC calibration. These estimates do not change the underlying sensor streams.

## Verification

```sh
npm test
~/.platformio/penv/bin/pio test -e native
~/.platformio/penv/bin/pio run -e adafruit_feather_esp32_v2
~/.platformio/penv/bin/python scripts/check_device.py --port /dev/cu.usbserial-YOUR_DEVICE --seconds 25
```

`check_device.py` reads serial packets and reports audio counts, gaps, capture
drops and status; `--sync` also sets the RTC, and `--capture path.jsonl` saves a
temporary protocol trace. Close the dashboard's USB connection before using it.
If Apple's command-line compiler cannot find `<string>`, run the native test
with `CPLUS_INCLUDE_PATH` set to your SDK's `usr/include/c++/v1` directory.

Tests cover ADPCM sample counts and buffer boundaries, malformed/fragmented
packets, HDF5 round trips (including empty and sensor-only recordings), exact
timestamps, mixed sample rates, missing-audio playback, WAV headers, analysis
window reuse and snapshot isolation, multi-kit address selection, the local
discovery API, and mDNS announcements/goodbyes over isolated loopback UDP.
