# Pinned drivers

Unmodified manufacturer source files are vendored for reproducible builds.

| Directory | Upstream | Pinned commit | License |
|---|---|---|---|
| LSM6DSOX | https://github.com/STMicroelectronics/lsm6dsox-pid | `2e86793125f7f46b6195fce93a2b3cb76a51e564` | BSD-3-Clause, included LICENSE |
| BME68x | https://github.com/boschsensortec/BME68x_SensorAPI | `80ea120a8b8ac987d7d79eb68a9ed796736be845` | BSD-3-Clause, included LICENSE |

Additional dependencies pinned by `platformio.ini`: NimBLE-Arduino 2.5.0,
RTClib 2.1.4, Adafruit BusIO 1.17.0, WebSockets 2.4.2. Framework: Arduino-ESP32
2.0.17 / ESP-IDF 4.4.7 via espressif32 6.9.0. No BSEC or derived-gas library is used.

I2S configuration was checked against Espressif's matching
[IDF 4.4.7 S3 driver documentation](https://docs.espressif.com/projects/esp-idf/en/v4.4.7/esp32s3/api-reference/peripherals/i2s.html)
and HAL source. Physical slot alignment and clock rates still require measurement.

`A3USB` adapts Espressif's Apache-2.0
[ESP-IDF v4.4.7 USB Serial/JTAG driver](https://github.com/espressif/esp-idf/blob/v4.4.7/components/driver/usb_serial_jtag.c)
for this pinned framework; its license is included. The public functions are
prefixed `a3_usb_` so the framework's precompiled driver is not overridden.
Changes preserve pending endpoint interrupts at installation
([upstream issue #13940](https://github.com/espressif/esp-idf/issues/13940)),
send a zero-length packet when TX goes idle, handle enqueue during the ISR's
idle transition, and correct allocation-failure checks/cleanup. The idle-TX
behavior follows Espressif's
[newer USB Serial/JTAG driver](https://github.com/espressif/esp-idf/blob/048630bd9a5391c6b61ae48e4a7d7a306cd03d2e/components/esp_driver_usb_serial_jtag/src/usb_serial_jtag.c).
Full JSON lines enter
the byte ring buffer in one atomic call; only the ISR writes the hardware FIFO,
and short FIFO writes are retained. Do not use Arduino HWCDC or install the
framework USB driver at the same time.
