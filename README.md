# FrED PAL A3 acquisition

Firmware and local dashboard for the **integrated FrED PAL A3 PCB**, using the
ESP32-S3-WROOM-1-N8R8, ICS-43432 microphone, SPI LSM6DSOX, I2C BME688 and DS3231.
The board mapping follows [the supplied A3 reference](FrED_PAL_A3_Firmware_Hardware_Reference.md).
This firmware is **not for the older Feather V2 assembly**.

## Build, flash and open

```sh
~/.platformio/penv/bin/pio run -e fred_pal_a3
~/.platformio/penv/bin/pio device list
~/.platformio/penv/bin/pio run -e fred_pal_a3 -t upload --upload-port /dev/cu.usbmodemYOUR_DEVICE
npm ci
npm run serve
```

Open **http://localhost:8000** in Chrome or Edge. The flashable application is
`.pio/build/fred_pal_a3/firmware.bin`. Use PlatformIO's upload command to program
its matching bootloader and partition table at the generated offsets; uploading
only the application to a blank board is insufficient.

The pinned build uses PlatformIO `espressif32@6.9.0`, Arduino-ESP32 **2.0.17** /
ESP-IDF **4.4.7**, 240 MHz CPU, 8 MB QIO flash at 80 MHz, and 8 MB **octal** PSRAM.
Native USB hardware CDC/JTAG uses the vendored ESP-IDF driver adaptation in
`lib/A3USB` (pending-event and idle-transfer fixes), with a 16 KiB
TX buffer and nonblocking atomic JSON-line enqueue. This avoids byte loss in
the pinned Arduino HWCDC implementation. Do not initialize `Serial` alongside
this driver. USB packets dropped while no host is reading are counted in
`usb_dropped`; compare counter increases during an active capture.
`partitions_a3.csv` has a single 6 MiB
factory application in 8 MiB flash; **OTA is disabled**. Do not update to core 3.x
without migrating the legacy I2S and ADC interfaces together. Third-party driver
versions and licenses are recorded in [lib/SOURCES.md](lib/SOURCES.md).

A3 has no USB-to-UART adapter. Keep **SW1 ON** and use a data-capable USB-C cable.
For a blank or unresponsive board: hold **SW3 BOOT**, press/release **SW2 RESET**,
then release BOOT. Select the newly enumerated USB port and flash; reset afterward
if necessary. A port may change between ROM download and application modes.
If macOS lists no attached USB device at all, check the cable, host port,
accessory permission and board power before retrying firmware upload.

### Firmware panel

Run `npm run firmware:build` to compile and bundle the four matching A3 flash
images, then `npm run serve`. The **Device setup → Firmware** tab reads the installed version
over USB, Bluetooth or Wi-Fi and compares it numerically with this checkout's
bundled release. **Check firmware** refreshes the release and USB port list;
**Read USB version** works without a live dashboard connection. It disconnects
the live link first to release the serial port and retains the recording in memory.

Stop and export a recording before selecting **Update via USB…**, then confirm
the displayed version and USB board. Keep USB connected until verification
finishes. The updater verifies SHA-256 package checksums, ESP32-S3 identity, MAC,
8 MB flash, the flashed image digests, and the running firmware version after
restart. If startup cannot be confirmed, it reports that separately and asks for
RESET. A blank board can be flashed from ROM download mode without a version
response. An installed newer version is not automatically downgraded.

Updates use the local PlatformIO Python environment (override with `PAL_PYTHON`)
and pinned esptool. The updater backports Espressif's
[ESP32-S3 watchdog register correction](https://github.com/espressif/esptool/commit/6fd91af)
to the bundled esptool 4.5.1, preventing watchdog resets during native-USB writes.
The installer runs on the loopback dashboard server; it
requires a same-origin JSON request, allows one USB operation at a time, and
accepts only the local package, never an arbitrary image path. Generated bundles
in `firmware/` are ignored by Git. Rebuild after source changes; reopen the updated
dashboard after installing a new protocol. There is no online release feed or
Bluetooth/OTA flashing; “available” means the locally bundled release.

## Connect and record

- **USB:** choose **Connect USB**, select the ESP32-S3 native USB port. The 230400
  setting is retained for browser compatibility; USB CDC throughput is not a UART
  baud-rate limit. Close serial monitors before connecting.
- **Bluetooth:** choose **Connect Bluetooth**, select `PAL-xxxxxx`, and accept
  pairing. Commands require encryption. Audio on this link is a lossy preview.
- **Wi-Fi:** provision a 2.4 GHz SSID/password over USB/BLE, or select an already
  discovered/saved kit and connect. WebSockets use `ws://<device-ip>:81/`.
  The browser and kit must share a reachable LAN. `npm run serve` discovers
  `_pal-telemetry._tcp` via mDNS; a plain static server supports manual addresses.

| Link | Audio | Representation |
|---|---|---|
| Native USB | 48 kHz mono, 960 samples/frame | All 32 bits of each left-slot DMA word, little endian |
| Wi-Fi | Same raw capture as USB | Same `i2s_s32le` words, base64 in JSON Lines |
| BLE | 24 kHz preview by default; selectable 16 / 24 / 48 kHz | Filtered/decimated at 16 / 24 kHz, lossy IMA-ADPCM |

The microphone has **24 valid bits**, not 32-bit measurement precision. USB/Wi-Fi
retain the unshifted words, including trailing slot bits, so alignment can be
verified on the first article without irreversible bit loss. The current preview
assumes MSB-aligned microphone data; validate slot order, bit alignment, WS and
BCLK with a scope and known tone before treating amplitude/rate as qualified.
There is no automatic gain, DC removal, normalization or filtering in raw capture.
BLE may drop frames when radio throughput is insufficient; use USB/Wi-Fi for raw
acquisition. These are configured rates, not measured throughput guarantees.

Synchronize UTC using **Sync RTC to PC** before recording. Invalid RTC time is
explicitly marked; firmware never fills it with compile time. Select **Record**,
then **Stop**, then **Export HDF5**. A connection loss stops recording and retains
captured data. **Choose folder…** remembers an export directory in supported
browsers; otherwise files use browser downloads. New recordings/Clear prompt
before discarding data. Recordings stay in browser memory until exported, with a
96 MiB estimated cap. HDF5 work runs in a worker; `npm ci` vendors h5wasm locally.
No recording data is uploaded to a cloud service.

**Explore recording** opens a separate analysis window without stopping capture.
The explorer imports schema v2 and v3, plots a shared timeline, and plays/exports
selected audio ranges with gaps preserved. Playback gain/filtering and 16-bit WAV
export are listening derivatives; HDF5 retains the original received values.

## Device render and trim

The live **Device orientation** card renders a 68 × 68 mm A3 PCB with mounting
holes, antenna overhang and illustrative component placement. Accelerometer and
gyroscope samples drive a gravity-corrected quaternion attitude estimate in a
world with **Z up**. Place the board on a **flat, level surface, component side
up**, choose **Trim orientation**, and start the two-second calibration. Movement
restarts the stillness window. Calibration measures gyro bias and a fixed
board-to-sensor transform; the current heading becomes zero. **Clear trim**
restores the sensor reference. Trim affects the view only, never recorded axes.

The view follows **rotation and tilt**, not linear position. Without a
magnetometer, heading is relative and may drift. Gravity correction is reduced
during acceleration. Gaps skip gyro integration and reacquire gravity while
preserving the fixed trim. Restarts and device changes clear calibration; stale
data disables trim. This is an illustrative model, not a CAD import.

## A3 hardware allocation

| Function | Explicit GPIOs/configuration |
|---|---|
| ICS-43432 | BCLK4, WS5, DIN6; fixed left slot; no MCLK, mute or power-enable pin |
| I2S wire format | Philips, two 32-bit slots, 64 clocks/frame; configured WS 48 kHz / BCLK 3.072 MHz |
| LSM6DSOX | FSPI SCK12 / MISO13 / MOSI11 / CS10; mode 3 at 1 MHz; INT1=14, INT2=15 |
| Shared I2C | SDA8 / SCL9, 100 kHz, 50 ms timeout; BME688=0x76, DS3231=0x68 |
| RTC interrupt | GPIO7 input; alarms and square-wave output disabled |
| Battery ADC | GPIO1, calibrated millivolts, 6 dB attenuation; ×1330/330 divider factor |
| Status LED | GPIO2, active-HIGH green; no NeoPixel |
| USB | GPIO19/20 reserved |
| Student SPI | 40/41/42/47 reserved, CS47 HIGH; peripheral disabled |

Onboard SPI belongs exclusively to the IMU. Any student SPI driver must use a
separate `SPIClass(HSPI)` and explicit external pins. Expansion modules are not
auto-initialized. GPIO35–37 are reserved for octal PSRAM. No charger state,
USB-power detection, battery temperature, current or software power-switch GPIO
is invented. Battery terminal voltage is reported once per second, with no inferred charge
percentage or automatic cutoff. Validate voltage against a meter. Low-battery
shutdown requires a separate pack-specific policy.

With J2 empty and USB powering the board, the BQ24073's battery-detection routine
can repeatedly discharge and recharge the BAT terminal. Large changes in the
reported `battery_v` are consistent with this behavior; this field measures BAT,
not USB input or the regulated 3.3 V rail. The dashboard calls it **Battery
terminal voltage**. Firmware cannot reliably determine battery presence from
voltage alone. See [TI datasheet §9.3.5.4](https://www.ti.com/lit/ds/symlink/bq24073.pdf).

The green status LED is solid with a wireless link, slow-blinks while idle, and
fast-blinks when a sensor/RTC is unavailable or RTC synchronization is required.
A microphone setup success indicates the I2S driver started, not an electrical
identity check: this microphone has no readable ID interface.

## Acquisition and protocol

- Audio has an independent DMA capture task. It discards **4,224 startup frames**
  (above the required 4,096), then queues 960-word blocks without waiting for
  networking. DMA buffers stay in internal RAM. The queue holds 24 frames in
  PSRAM (480 ms); a reported reduced mode holds 6 frames internally if PSRAM is
  unavailable. Full queues drop **newest** blocks and count losses.
- IMU identification checks `WHO_AM_I=0x6C`, resets with a 100 ms deadline,
  programs four-wire SPI, BDU and increment, disables I2C/I3C, and checks range,
  ODR and FIFO mode readback. Both sensors use **104 Hz**, ±4 g / ±500 dps, reset
  default filters, tagged continuous FIFO and watermark 8. INT1 only notifies the
  sensor task; timed polling catches missed edges. Each seven-byte FIFO record
  is read in its own transaction. Overruns reset continuity and are counted.
- Accelerometer and gyro records retain separate counters and native signed
  counts. Timestamps are reconstructed from nominal ODR and initial drain time,
  **not hardware-synchronized sensor timestamps**. The dashboard pairs only
  fresh nearby readings for the orientation/converted preview. Raw records are
  preserved separately. Unknown tags, FIFO losses and application drops are
  exposed in health records.
- Bosch's BME68x SensorAPI handles identity, variant and calibration. Forced mode
  uses T/P/H oversampling 8×/4×/2×, IIR off, and a 320 °C / 150 ms heater profile.
  Conversions are scheduled without holding I2C while waiting. Only new completed
  readings are emitted. Gas resistance is null unless gas-valid **and**
  heater-stable flags are set. No synthetic IAQ, VOC or eCO₂ is generated.
- RTC and BME share a mutex. RTC OSF/implausible dates invalidate UTC; only explicit
  `set_time` updates it, with readback. `esp_timer_get_time()` anchors UTC to
  monotonic time. Unsynchronized times are boot-relative; read validity flags.
- Sensor initialization failures are reported and leave other streams running.
  A failed IMU identity during capture disables its stream until restart. This
  release does not automatically power-cycle peripherals or retry indefinitely.
- Networking is separate from acquisition, with bounded queues, serial timeouts,
  BLE retries and WebSocket timeout. Health reports queue occupancy/high-water,
  audio DMA overruns/drops, IMU counters, USB/BLE/telemetry drops, battery and heap.
  Finite buffering is not lossless during arbitrary outages.

USB/Wi-Fi use JSON Lines with types `configuration`, `audio`, `telemetry`,
`environment`, `health` and `status`. Application protocol is **3**. Audio has
`audio_pcm_s32_b64` / `audio_codec: "i2s_s32le"` on raw links, per-frame sequence,
boot ID, continuity segment, sample index, monotonic time and UTC validity.
The left slot is DMA index 0 on the selected S3 standard-I2S configuration.

`telemetry.imu_raw` rows are:

```text
[monotonic_us, tag, x_raw, y_raw, z_raw, stream_sample_counter, time_ms]
```

Tag 1 is gyro and tag 2 is accelerometer. Packet fields include `stream_id`,
`imu_segment`, `imu_overruns`, `imu_dropped` and `clock_synced`. Scaling is
0.122 mg/LSB and 17.5 mdps/LSB; raw axes are never relabeled as enclosure axes.
Configuration records include hardware/firmware/build/framework versions,
read-back IMU registers, driver commits, format/profile/rate choices, memory
sizes, queue policy and reset reason. `get_config` retrieves them after connecting.

BLE retains the v2 CRC envelope (`PAL`, byte 2, kind, reserved, uint16 length,
uint32 IEEE CRC32; little endian) for compatibility, with a 4,096-byte payload
limit. Kind 0 carries configuration/status/environment/health JSON; kind 1 retains
the compact ADPCM layout with explicit sample rate and count. Firmware a3-1.1.0 sends raw tagged IMU as lossless
kind 3: a 40-byte header (MAC, 64-bit UTC/monotonic bases, stream, segment, overrun
and drop counters, clock flag, count) followed by 17-byte records (signed 32-bit
microsecond delta, signed 16-bit millisecond delta, tag, three int16 counts, uint32
sequence). This preserves independent timestamps and reduces radio overhead.
The decoder also accepts legacy kind-2 IMU and kind-0 raw IMU JSON. Reload the
dashboard before using new firmware. Service/characteristic UUIDs are unchanged.

USB writes never wait on an unread host, which previously stalled the shared
transmitter while using Bluetooth. Live audio now plots acquisition timestamps
and leaves missing intervals blank, matching Data Explorer instead of joining
received frames together. Explorer and stopped recordings report missing frame
counts, missing duration and capture-queue loss. Radio capacity can still limit
BLE; these diagnostics do not invent or interpolate absent samples.
Firmware requests a 15 ms BLE connection interval and 2M PHY where
supported, and shortens the transmitter's idle delay while audio is queued.
The central chooses the final radio parameters; **Link diagnostics** shows
the negotiated interval, notification capacity, retries and queue high-water mark.
Firmware a3-1.1.2 and later requests MTU 517 and packs CRC-framed messages across
notifications, using up to 495 value bytes (two 251-byte link-layer packets).
Older/smaller central MTUs are still supported. A final short tail is flushed
when idle; the parser makes no assumption about notification boundaries.

### Sampling controls

Open **Device setup → Sampling** while connected. Select Bluetooth microphone
rate **16 / 24 / 48 kHz** and accelerometer/gyroscope rate **26 / 52 / 104 / 208 /
416 Hz**, then **Apply sampling rates**. The board acknowledges and reports its
configuration; the IMU driver reads back both ODR and FIFO batching registers.
Settings last until reboot (defaults: BLE 24 kHz, IMU 104 Hz). Recording must be
stopped. The microphone selector affects Bluetooth only: USB/Wi-Fi retain
48 kHz raw DMA words. Higher IMU rates consume more wireless bandwidth.

For Bluetooth 24 / 16 kHz, a 129-tap symmetric Kaiser low-pass filter precedes
2:1 / 3:1 decimation. The 24 kHz passband is up to 10 kHz, stopband from 12 kHz;
16 kHz uses 6 / 8 kHz. The 64-input-sample group delay is compensated in timestamps.
One preview frame is discarded to settle the filter after connection, rate change
or a capture gap. No raw words are filtered or replaced. Coefficients are
reproducible with `scripts/design_ble_filter.py`; native tests check in-band gain,
>74 dB rejection at test stopband tones including int16 rounding, and reset state.
The 48 kHz BLE option bypasses this filter and retains the previous lossy preview.

Firmware a3-1.2.0 uses kind 4 for IMU: the kind-3 header plus uint16 actual ODR at
byte 40, with 17-byte records starting at byte 42. The decoder retains kind-3
compatibility at its original 104 Hz. FIFO polling, batching, timestamp increments
and preview pairing respect the selected ODR. An IMU rate change begins a new
motion segment and clears display trim. HDF5 stores the applied configuration.
Commands use `{"cmd":"set_sampling","ble_audio_hz":24000,"imu_hz":104}`.


```json
{"cmd":"get_config"}
{"cmd":"set_time","unix_ms":1793896772968}
{"cmd":"wifi_on","ssid":"Example network","password":"example-password"}
{"cmd":"wifi_status"}
{"cmd":"wifi_off"}
```

Commands are newline-terminated, at most 768 UTF-8 bytes. BLE fragments expire
after 5 s. Wi-Fi association times out after 20 s; BLE stays available until a
WebSocket connects and resumes on disconnection. Credentials live in RAM only,
are never echoed or recorded, and are cleared from the dashboard input. A reboot
requires provisioning again. Pairing uses encrypted Just Works; Wi-Fi is
unauthenticated/unencrypted and intended for a trusted LAN. No automatic Wi-Fi
reconnect is enabled; select/reprovision the kit after a failure.

## HDF5 schema

The historical root schema identifier remains `pal-v2-timeseries`; A3 recordings
use **schema_version=3**. Old schema-2 files still import. Numeric datasets are
chunked/gzip-compressed; `configuration_json` stores the configuration.

| Dataset | Contents |
|---|---|
| `/audio/pcm_s32` | Unshifted int32 I2S words; decoded 16-bit BLE/legacy frames are promoted by ×65536 |
| `/audio/frame_offsets` | Frame boundaries in the concatenated sample dataset |
| `/audio/{time_ms,rate,monotonic_us,sample_index,sequence,stream_id,segment,dropped,overruns,dbfs,clock_synced}` | Per-frame timing, format and continuity metadata |
| `/audio/{transport,codec}` | USB/BLE/Wi-Fi = 0/1/2; PCM16/ADPCM/raw I2S32 = 0/1/2 |
| `/imu_raw/records` | Float64 rows: time_ms, monotonic_us, tag, x, y, z, sequence, segment, stream_id, clock_synced; signed counts remain exact |
| `/imu/{time_ms,values}` | Converted fresh-pair preview, ax/ay/az in m/s² and gx/gy/gz in rad/s |
| `/environment/{time_ms,values}` | Compensated T/P/H/gas; legacy derived fields remain NaN on A3 |
| `/environment/status` | Monotonic time, new-data/gas/heater flags, measurement/profile index, clock validity |
| `/health/records` | Battery voltage, sensor states, loss counts and heap measurements |

Every table has column attributes. Missing numeric values use NaN. Raw audio
normalization for display uses 2^31; this does not imply 32 valid sensor bits.
Frame sample `j` has estimated time `time_ms + 1000*j/rate`. Check boot IDs,
segments, counters and validity before combining spans. Trim is never applied to
recorded IMU samples. Legacy-only sessions may still export schema 2 with
`/audio/pcm_s16`.

## USB bridge and validation

```sh
python3 -m venv .venv-usb
.venv-usb/bin/pip install -r scripts/requirements-usb.txt
.venv-usb/bin/python scripts/usb_bridge.py --port /dev/cu.usbmodemYOUR_DEVICE
```

Choose **Connect USB bridge**. It binds to loopback, accepts the local dashboard
origin, and supports one dashboard. It cannot fix a device that macOS does not
enumerate. Close the bridge before flashing or running the serial check.

```sh
npm test
~/.platformio/penv/bin/pio test -e native
~/.platformio/penv/bin/pio run -e fred_pal_a3
~/.platformio/penv/bin/python scripts/check_device.py --port /dev/cu.usbmodemYOUR_DEVICE --seconds 25
```

`--sync` explicitly sets UTC; `--capture path.jsonl` saves a local trace. The
checker drains one second of connection backlog, then checks JSON, audio payload
lengths and sequence/sample continuity using bulk reads. It exits unsuccessfully
on corrupt or missing audio packets. It reports health counter increases separately.
Both Python serial tools keep DTR/RTS deasserted when opening the device.
The bridge also drains one second of startup/backlog data and aligns to a JSON
line before forwarding. Some hosts still reset native CDC on open despite the
requested control-line state. Recognized initial ROM diagnostics are not
counted as malformed dashboard packets.
If the
macOS native compiler cannot find `<string>`, prefix the test command with
`CPLUS_INCLUDE_PATH=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/include/c++/v1`.

Software verification covers codec framing, exact 32-bit/HDF5 round trips, mixed
raw/preview recordings, orientation rotations/trim/gaps, native FIFO record
handling, discovery and recording workflows. A simulated stream exercises the
browser render. **Electrical first-article qualification is still required:**
flash/PSRAM detection, sensor identities/readback, 64 BCLK per WS, ≥4,096 startup
frames, known-tone bit alignment, ADC against a meter, RTC power retention,
FIFO health, and sustained USB/Wi-Fi throughput under power/network stress.
Use the supplied reference's acceptance checklist; no bench performance or
sensor-to-enclosure alignment is claimed by compilation or simulated tests.

Firmware `a3-1.2.1` was flashed with all four image digests verified, followed by
automatic application-version readback. A 10-second USB check received 501 raw
48 kHz frames with zero gaps or counter increases. A Chrome Bluetooth recording
at 24 kHz / 104 Hz retained 2,267 audio frames (1,088,160 samples; 45.34 seconds),
9,200 native IMU records and 45 environmental readings. Data Explorer and the
exported HDF5 readback both reported zero missing audio frames or capture drops;
DMA, BLE and telemetry counters did not increase during that recording.
The UI's 52/104 Hz IMU changes and flat-surface trim were exercised on the board;
a separate BLE test applied 16 kHz / 26 Hz and restored 24 kHz / 104 Hz.
All 38 JavaScript and 10 native tests passed. See the
[a3-1.2.1 acquisition report](validation/a3-1.2.1-acquisition-2026-11-06.json).
Live diagnostics distinguish totals since connection from counters since boot;
the Explorer reports gaps within the recording. Pairing and sampling transitions
can interrupt acquisition, so configure first, then start recording.

On 2026-11-06, firmware `a3-1.0.1` was flashed and hash-verified on the attached
A3. A 25-second USB check received 1,249 raw audio frames (1,199,040 samples),
2,562 accelerometer and 2,562 gyroscope records, with zero malformed lines,
invalid audio payloads, sequence gaps, or increases in drop/overrun counters.
Flash/PSRAM and sensor configuration readbacks succeeded; explicit RTC sync was
acknowledged. The dashboard's live pose and trim were exercised with the board.
The [verification report](validation/a3-usb-smoke-2026-11-06.json) records the
firmware SHA-256 and device responses. This smoke check does not replace the
electrical qualification above; battery ADC readings require meter validation.
