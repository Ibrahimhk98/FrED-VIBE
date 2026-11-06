# FrED PAL A3 — hardware and firmware implementation reference

Document date: **2026-10-27**. Hardware: **FrED PAL A3**, prototype release dated 2026-10-22. Target application: Arduino firmware that continuously acquires microphone, motion and environmental data and streams raw measurements over Wi-Fi, with optional student expansion modules.

This document is intended to be supplied directly to a coding agent. It contains the board-specific wiring, hardware limits, build requirements, and proposed software behavior. **Wiring and component values describe the saved A3 design. Software policies marked “recommended” are implementation choices, not existing functionality.** The design has not yet been qualified on a physical first article. The existing `ExpansionDemo` is an uncompiled teaching sketch, not an acquisition application.

## 1. Instructions for the implementing coding agent

1. Target **ESP32-S3-WROOM-1-N8R8** and the explicit GPIO assignments below. Arduino pin numbers in this document are **ESP32 GPIO numbers**, not module pad numbers or connector pin numbers.
2. Treat this as custom hardware. Do not import the Feather V2 pin map or assume a generic ESP32-S3 development board's RGB LED, battery monitor or peripheral wiring.
3. The fitted microphone is **ICS-43432**. Do not use SPH0645-specific alignment workarounds, PDM capture, or an analog microphone driver.
4. The IMU uses four-wire SPI. The BME688 and RTC share I2C. The microphone uses standard I2S. Student SPI expansion uses a separate set of nets and a separate general-purpose SPI controller.
5. Configure all peripheral pins explicitly. Reserve onboard pins; do not let a library silently initialize its default I2C/SPI pins or reconfigure another sensor's controller.
6. Keep hardware facts separate from software choices. Record framework/library versions, actual programmed rates, data formats, and any measured limits in the firmware release.
7. Do not invent GPIOs for charger status, USB presence, regulator enable, microphone enable, or battery temperature. Those functions are not wired to ESP32 GPIOs on A3.
8. Use bounded initialization and error recovery. Report missing sensors and data loss instead of manufacturing samples or silently reporting stale data as new.
9. Preserve raw samples and configuration metadata. Filtering, compression, inference and derived gas metrics should be optional, explicit features.
10. Do not change KiCad sources to make software assumptions fit. Report a hardware/document mismatch before changing the design.

### Authoritative project sources

Paths in this table are relative to `hardware/rev_a3/` in the project. This Markdown file is self-contained for software planning; the native design remains the source of truth for physical connections.

| Source | Purpose |
|---|---|
| `design/FrED_PAL_A3.kicad_pro` | KiCad 10 project |
| `design/FrED_PAL_A3.kicad_pcb` | Physical PCB, footprints, pad nets, routing and stackup |
| `design/FrED_PAL_A3.kicad_sch` and numbered child sheets | Circuit and component values |
| `verification/circuit_manifest.json` | Component pin names and intended net assignments |
| `verification/schematic.xml` | Exported schematic connectivity |
| `verification/selected_parts.json` | Selected JLC component identifiers |
| `firmware/ExpansionDemo/board_pins.h` | Existing A3 pin constants |
| `verification/release_audit.json` | Prototype release checks and file hashes |

For this document, **305 connected component pins were checked against both the exported schematic netlist and the saved PCB**, with no mismatches. Power-flag symbols are excluded from the component-pin count. This verifies design consistency, not assembly quality or sensor operation.

Revision fingerprints, SHA-256:

```text
FrED_PAL_A3.kicad_pcb
1f89c58fffe9c902ee830b3b7989baf23daeb97282d1235c7726f88b09510380
circuit_manifest.json
cb28d4c612879618a4c25a588039d01a8c6adee6dd63f6b9c2a50fced6cacc0a
schematic.xml
a9dd05ed18e4c3f6e450870ea0c97363cd6f5ecc0e42396487784b475c4e3e6b
```

## 2. Board architecture and fitted devices

| Ref | Fitted part | JLC ID in A3 | Role / software interface |
|---|---|---|---|
| U1 | ESP32-S3-WROOM-1-N8R8 | C2913201 | MCU, Wi-Fi, native USB; 8 MB flash, 8 MB octal PSRAM |
| U8 | LSM6DSOXTR | C481766 | Three-axis accelerometer and gyroscope; SPI plus two interrupts |
| U9 | BME688 | C3664478 | Temperature, pressure, humidity and gas resistance; I2C |
| U10 | DS3231SN# | C722469 | Battery-backed real-time clock; I2C plus INT/SQW |
| U11 | ICS-43432 | C574021 | One digital MEMS microphone; I2S, left slot |
| U6 | BQ24073RGTR | C15220 | 1S charger and power path; hardware configuration only |
| U7 | TPS63802DLAR | C2845237 | Main 3.3 V buck-boost regulator; physical ON/OFF control |
| U2 | TUSB320LIRWBR | C2836598 | USB-C current advertisement detection; GPIO-mode hardware logic |
| U3 | MCP1700T-3302E/TT | C39051 | USB-powered 3.3 V rail for USB-C control logic |
| U4 | SN74LVC1G04DBVR | C7827 | Converts source-current indication into charger mode selection |
| U5 | USBLC6-2SC6 | C2827654 | USB data-line ESD protection |
| BT1 | MY-1220-04 holder, CR1220 cell | C2979172, holder only | Nonrechargeable RTC backup cell |

JLC IDs identify the design selections; they are not a current inventory guarantee. The original breakout modules are not mounted as daughterboards. In particular, **U1 is an S3 module, U11 is ICS-43432, U6 is BQ24073, and U2 is TUSB320LI** in this revision.

```text
USB-C J1: 5 V ── F1 ── BQ24073 IN
                              ├── BAT ── J2 protected 1S rechargeable cell
                              └── SYS ── TPS63802 ── +3V3
                                            ▲          ├── ESP32-S3
                                         SW1 enable    ├── IMU, BME688, RTC VCC
                                                       ├── J3/J4 accessory power
                                                       └── R27 RC filter ── microphone

USB-C CC1/CC2 ── TUSB320LI + inverter ── charger input-current mode
USB-C D-/D+ ── ESD + 22 Ω resistors ── ESP32 GPIO19/20

ESP32 GPIO12/11/13/10 ── SPI ── LSM6DSOX; INT1/INT2 → GPIO14/15
ESP32 GPIO8/9         ── I2C ── BME688 + DS3231 + J4
ESP32 GPIO4/5/6       ── I2S ── ICS-43432
DS3231 INT/SQW       ────────── GPIO7; CR1220 → RTC VBAT
ESP32 GPIO40/41/42/47 ── separate SPI ── J4
```

The PCB has no SD card, external bulk storage, audio playback DAC/amplifier, fuel-gauge IC, or software-controlled sensor power switch. The MCU module's flash and PSRAM are available for firmware/configuration and bounded buffering.

## 3. Complete MCU connection map

Direction is relative to the ESP32 during normal operation. `SRC` and `DRV` distinguish the two sides of series resistors; they are not extra GPIOs.

| GPIO | U1 module pad | Net at U1 | Connection / intended use | Direction |
|---:|---:|---|---|---|
| 0 | 27 | BOOT_N | SW3 to GND, R2 10 kΩ pull-up; TP7 | Boot input |
| 1 | 39 | BAT_ADC | R4/R5 battery divider and C4 | Analog input |
| 2 | 38 | LED_STATUS | R3 1 kΩ → D1 green LED → GND | Output, HIGH lights LED |
| 4 | 4 | BCLK_SRC | R24 22 Ω → U11.6 microphone SCK | I2S clock output |
| 5 | 5 | WS_SRC | R25 22 Ω → U11.5 microphone WS | I2S frame-clock output |
| 6 | 6 | MIC_SD | R29 22 Ω ← U11.7 microphone SD | I2S data input |
| 7 | 7 | RTC_INT | U10.3 INT/SQW, R23 10 kΩ pull-up | Input |
| 8 | 12 | I2C_SDA | U9.3, U10.15, J4.3, R21 2.2 kΩ pull-up | I2C open drain |
| 9 | 17 | I2C_SCL | U9.4, U10.16, J4.4, R22 2.2 kΩ pull-up | I2C open drain |
| 10 | 18 | IMU_CS_SRC | R32 22 Ω → U8.12 CS | Output, active LOW |
| 11 | 19 | SPI_MOSI_SRC | R31 22 Ω → U8.14 SDA/SDI | SPI output |
| 12 | 20 | SPI_SCK_SRC | R30 22 Ω → U8.13 SCL/SPC | SPI clock output |
| 13 | 21 | SPI_MISO | R33 22 Ω ← U8.1 SDO | SPI input |
| 14 | 22 | IMU_INT1 | U8.4 INT1; no external pull resistor | Input |
| 15 | 8 | IMU_INT2 | U8.9 INT2; no external pull resistor | Input |
| 16 | 9 | EXT_GPIO16 | J3.3 | User-defined |
| 17 | 10 | EXT_GPIO17 | J3.4 | User-defined |
| 18 | 11 | EXT_GPIO18 | J3.5 | User-defined |
| 19 | 13 | USB_DM_MCU | R9 22 Ω → USB D− and U5 | Dedicated USB |
| 20 | 14 | USB_DP_MCU | R10 22 Ω → USB D+ and U5 | Dedicated USB |
| 21 | 23 | EXT_GPIO21 | J3.6 | User-defined |
| 38 | 31 | EXT_GPIO38 | J3.7 | User-defined |
| 39 | 32 | EXT_GPIO39 | J3.8; conflicts with external JTAG use | User-defined |
| 40 | 33 | EXT_GPIO40 | J3.9 and J4.5; external SPI SCK | Output when SPI |
| 41 | 34 | EXT_GPIO41 | J3.10 and J4.6; external SPI MOSI | Output when SPI |
| 42 | 35 | EXT_GPIO42 | J3.11 and J4.7; external SPI MISO | Input when SPI |
| 43 | 37 | UART_TX | J4.9 and TP5 | UART output |
| 44 | 36 | UART_RX | J4.10 and TP6 | UART input |
| 47 | 24 | EXT_GPIO47 | J4.8; R28 10 kΩ pull-up | External CS, active LOW, or spare GPIO |
| 48 | 25 | EXT_GPIO48 | J3.12 | User-defined; **no RGB LED fitted** |

All pull-ups in this table go to **+3V3**. Main module supply is U1.2; ground is U1.1, U1.40 and U1.41. C1 = 10 µF and C2 = 100 nF provide local supply bypass.

| Other module pad / signal | A3 treatment |
|---|---|
| U1.3 EN / RESET_N | R1 10 kΩ to +3V3, C3 1 µF to GND, SW2 to GND, J4.11 and TP8; not a GPIO |
| U1.15 GPIO3 | Externally unconnected; strapping-related pin, not exposed for students |
| U1.16 GPIO46 | Externally unconnected; strapping-related pin |
| U1.26 GPIO45 | Externally unconnected; strapping-related pin |
| U1.28/29/30 GPIO35/36/37 | Externally unconnected on PCB; reserved by this module's octal PSRAM configuration |
| Other internal memory signals | Reserved for module flash/PSRAM; not expansion pins |

GPIO39–42 overlap the external JTAG pin assignment. Allocate them either to external JTAG or student functions, not both. USB Serial/JTAG uses GPIO19/20. GPIO16–18 are ADC2-capable; do not promise continuous ADC2 acquisition alongside Wi-Fi. Prefer an external ADC for student analog streaming. See [Espressif's S3 ADC driver documentation](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-reference/peripherals/adc/index.html) for the selected framework's restrictions.

## 4. LSM6DSOX IMU — U8

### Exact wiring

| U8 pin | Pin function | PCB connection |
|---:|---|---|
| 1 | SDO | IMU_MISO_DRV → R33 22 Ω → SPI_MISO → GPIO13 |
| 2 | SDx | GND; auxiliary interface unused |
| 3 | SCx | GND; auxiliary interface unused |
| 4 | INT1 | IMU_INT1 → GPIO14, directly |
| 5 | VDDIO | +3V3 |
| 6, 7 | GND | GND |
| 8 | VDD | +3V3 |
| 9 | INT2 | IMU_INT2 → GPIO15, directly |
| 10 | OCS_AUX | Unconnected |
| 11 | SDO_AUX | Unconnected |
| 12 | CS | IMU_CS ← R32 22 Ω ← GPIO10; R20 10 kΩ to +3V3 |
| 13 | SCL / SPC | SPI_SCK ← R30 22 Ω ← GPIO12 |
| 14 | SDA / SDI | SPI_MOSI ← R31 22 Ω ← GPIO11 |

C15 and C16 are 100 nF supply decouplers. This is a four-wire SPI connection; the IMU is not on GPIO8/9 I2C and should not appear in that bus's address scan.

### Interface facts and limits

- Use MSB-first, **SPI mode 3**, with CS held LOW for the command and its data. Keep CS HIGH between transactions.
- The device's SPI ceiling is **10 MHz**. Start at 1 MHz for identification; qualify higher clocks under simultaneous Wi-Fi/audio load.
- `WHO_AM_I` register `0x0F` must read **`0x6C`**.
- Accelerometer and gyroscope ODR can reach approximately **6.667 ksample/s each**. This is distinct from SPI clock speed and useful measurement bandwidth.
- Available accelerometer ranges are ±2/4/8/16 g; gyro ranges are ±125/250/500/1000/2000 dps. Range and filtering are software choices.
- The device supports a tagged FIFO. Read tags; do not assume every entry is a combined six-axis sample.
- Keep GPIO14 high impedance without a pull-up during IMU power-up: INT1 must not be forced HIGH when selecting I2C/SPI operation.
- “SPI mode 3” describes clock polarity/phase. It does not mean enabling the chip's separate auxiliary/OIS “Mode 3” connection scheme.

These facts come from [ST's LSM6DSOX datasheet, interface timing, register map and connection tables](https://www.st.com/resource/en/datasheet/lsm6dsox.pdf).

### Recommended initialization and acquisition

Use [ST's platform-independent LSM6DSOX driver](https://github.com/STMicroelectronics/lsm6dsox-pid), with Arduino SPI transaction callbacks and checked return values. Pin its release or commit.

1. Set GPIO14/15 to inputs with no pull-up; establish CS HIGH before starting SPI clocks.
2. Read device ID, issue software reset, and wait for reset completion with a timeout. Re-read the ID.
3. Configure four-wire operation, block-data-update and register auto-increment. Explicitly disable unused I3C/I2C modes through the driver where appropriate. Leave the auxiliary interface and sensor hub disabled.
4. Select ranges, filters and ODR. Read back the configuration and include it in stream metadata.
5. Configure gyro/accelerometer FIFO batching, watermark and continuous acquisition. Route watermark to INT1. Recommended output configuration is push-pull, active HIGH; neither interrupt has an external pull-up. Leave INT2 disabled/input until assigned a documented purpose.
6. Drain the FIFO in a task notified by the ISR. The ISR should only capture timing/notify, not perform SPI transfers or network sends.
7. Detect FIFO overruns, identify record types, maintain separate accelerometer/gyro counters, and expose discontinuities.

Use the driver's definitions rather than copying register masks from another LSM6 variant. Keep native sensor axes in the raw stream. The PCB places U8 at KiCad rotation 0°, but a validated sensor-to-enclosure coordinate transform has not been established; do not silently relabel its axes as machine axes.

## 5. ICS-43432 microphone — U11

### Exact wiring

| U11 pin | Function | PCB connection |
|---:|---|---|
| 1 | LR | GND: selects **left** I2S slot |
| 2 | CONFIG | GND; fixed power-up configuration |
| 3 | VDD | MIC_3V3, supplied through R27 22 Ω from +3V3 |
| 4 | GND | GND |
| 5 | WS | MIC_WS ← R25 22 Ω ← GPIO5 |
| 6 | SCK | MIC_BCLK ← R24 22 Ω ← GPIO4 |
| 7 | SD | MIC_SD_DRV → R29 22 Ω → MIC_SD → GPIO6 |

R26 = 100 kΩ pulls MIC_SD to GND. C20 = 1 µF, C21 = 100 nF and C22 = 10 µF bypass MIC_3V3. There is no firmware-controlled LR, CONFIG, power-enable or mute pin. No MCLK connection is required.

### Required serial format

| Property | Required configuration |
|---|---|
| ESP32 role | I2S master, receive data; ESP32 generates BCLK and WS |
| Protocol | Standard Philips I2S, MSB-first, one-clock delay after WS transition |
| Microphone sample | Signed 24-bit two's-complement |
| Wire frame | Two 32-bit slots, **64 BCLK periods per complete WS frame** |
| Useful channel | Left slot, associated with WS LOW; right slot is not a second microphone |
| Nominal rate | 48,000 mono samples/s |
| Nominal BCLK | 48,000 × 64 = **3.072 MHz** |
| Datasheet rate range | Approximately 7.19–52.8 ksample/s; clock accuracy/timing limits still apply |
| Near-ceiling BCLK | 52,800 × 64 = **3.3792 MHz**, rounded to 3.379 MHz in the timing table |

The local manufacturer reference is [`references/ICS-43432-v1.3.pdf`](../references/ICS-43432-v1.3.pdf), particularly pages 5, 8, 10 and 11. [TDK's product page](https://product.tdk.com/en/search/sw_piezo/mic/mems-mic/info?part_no=ICS-43432) identifies this microphone.

**Do not configure a 32-clock mono wire frame merely because there is one microphone.** The physical frame still needs 64 clocks. A left-only receive buffer is acceptable if the selected API preserves the required wire format. Initially, capturing both 32-bit slots and discarding the right slot is a straightforward way to inspect alignment. Measure BCLK/WS and check the actual driver configuration before optimizing.

### Startup, buffering and conversion

After power-up or exiting standby, the manufacturer specifies **262,144 SCK clocks before valid data**. At 64 clocks/frame this is **4,096 complete frames**, approximately **85.33 ms at 48 kHz**. Nonzero output appears sooner and is not proof that settling is complete. Recommended policy: discard at least 4,096 frames after clocks start, with a small margin, and record the first valid sample's counter/time. Repeat settling after restarting from standby.

The microphone tri-states SD outside its active 24-bit word. Trailing slot bits and the unused right channel must not be treated as meaningful audio. Use 32-bit DMA storage, identify the valid 24 bits, and sign-extend correctly. If inspection confirms that valid bits occupy bits 31:8 of each received word, a signed arithmetic shift by 8 produces a signed 24-bit value in `int32_t`; do not apply this shift without confirming the driver's alignment. Document whether transmitted words contain left-aligned I2S words or right-aligned sign-extended samples.

Stopping both clocks and holding BCLK/WS LOW puts the microphone into standby. Its filtered supply remains powered while the board is on. Do not reassign these pins to unrelated outputs.

Use either the selected core's [Arduino I2S API](https://docs.espressif.com/projects/arduino-esp32/en/latest/api/i2s.html) or its matching [ESP-IDF standard I2S driver](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-reference/peripherals/i2s.html). Explicit assignments are BCLK=4, WS=5, DIN=6, DOUT unused and MCLK unused. Verify slot width, slot selection, signed format and DMA buffer requirements against the **installed** core. Do not combine examples from incompatible legacy and current driver APIs.

Recommended software checks: bounded DMA reads; partial-read handling; sample counters; queue high-water mark; overflow count; minimum/maximum/RMS diagnostics; a known acoustic tone to confirm sample rate and bit alignment. Raw capture should not apply automatic gain control, normalization or noise filtering unless the application enables and records it.

## 6. Shared I2C bus and BME688 — U9

### Bus wiring

SDA is GPIO8 and SCL is GPIO9. R21 and R22 are **2.2 kΩ to +3V3**, respectively. Both onboard I2C devices and J4 share these nets. Use seven-bit addresses in Arduino `Wire`; do not supply shifted read/write address bytes.

| Device | Seven-bit address | Address / mode selection |
|---|---|---|
| BME688 U9 | **0x76** | SDO grounded, CSB tied HIGH |
| DS3231 U10 | **0x68** | Fixed device address |

Start diagnostics at 100 kHz. **400 kHz is the A3 shared-bus ceiling**, limited by the RTC. External modules may require a lower rate. With these pull-ups the design uses an approximate 160 pF total capacitance budget for a 300 ns rise-time target; additional leads/modules consume that budget. Check parallel pull-ups on accessories.

Use one bus owner or a mutex spanning complete transactions, including repeated-start sequences. Do not hold the bus lock throughout a sensor's conversion delay. Do not run an I2C scanner concurrently with acquisitions. Set finite bus timeouts and recover in task context.

### Exact BME688 wiring

| U9 pin | Function | Connection |
|---:|---|---|
| 1 | GND | GND |
| 2 | CSB | +3V3, selecting I2C |
| 3 | SDI / SDA | I2C_SDA → GPIO8 and J4.3 |
| 4 | SCK / SCL | I2C_SCL → GPIO9 and J4.4 |
| 5 | SDO | GND, selecting address 0x76 |
| 6 | VDDIO | +3V3 |
| 7 | GND | GND |
| 8 | VDD | +3V3 |

C17 and C18 are 100 nF supply decouplers. There is **no BME688 interrupt or chip-select GPIO**. Switching this device to SPI requires a hardware revision.

### Initialization and measurement

Use [Bosch's BME68x SensorAPI](https://github.com/boschsensortec/BME68x_SensorAPI) with I2C callbacks bound to address 0x76. Its [device definitions](https://github.com/boschsensortec/BME68x_SensorAPI/blob/master/bme68x_defs.h) define chip ID **0x61**, read at register **0xD0**. This ID is shared within the BME68x family; let the driver also handle variant identification and calibration data.

Recommended sequence: initialize/reset through the driver; read calibration; configure oversampling and filtering; select the heater profile; trigger a measurement; wait for the driver-calculated conversion/heater duration without blocking other acquisition tasks; then read and validate the result. Forced mode is a useful initial implementation. Configure parallel/sequential gas profiles only when the application needs them and record their parameters.

Temperature, pressure and humidity require device calibration compensation. Gas measurements depend on heater conditions and validity flags; a raw gas resistance is not a calibrated gas concentration or CO2 reading. Conversion time, oversampling and heater duration determine measurement rate. Faster polling cannot create new measurements. The heater and nearby board heat can bias temperature. See [Bosch's BME688 datasheet](https://www.bosch-sensortec.com/media/boschsensortec/downloads/datasheets/bst-bme688-ds000.pdf).

Recommended stream fields: acquisition time, measurement/profile index, temperature, pressure, humidity, gas resistance, new-data status, gas-valid and heater-stable status, and the configuration version. Specify units explicitly—e.g. °C, Pa, %RH and Ω—and account for the selected driver's floating-point versus fixed-point output format. For literal ADC/raw-register streaming, also retain the calibration coefficients and gas range/status fields needed by the receiver. BSEC-derived outputs are optional software additions with their own library/configuration requirements; do not label raw resistance as IAQ.

## 7. DS3231 real-time clock — U10

### Exact wiring

| U10 pin | Function | Connection |
|---:|---|---|
| 1 | 32KHZ | Unconnected; no 32.768 kHz signal reaches ESP32 |
| 2 | VCC | +3V3, C19 100 nF bypass |
| 3 | INT/SQW | RTC_INT → GPIO7; R23 10 kΩ to +3V3 |
| 4 | RST | Unconnected; not the board's RESET_N |
| 5–12 | Manufacturer NC pins | Grounded in this PCB |
| 13 | GND | GND |
| 14 | VBAT | RTC_BAT → BT1 CR1220 positive contacts |
| 15 | SDA | I2C_SDA → GPIO8 |
| 16 | SCL | I2C_SCL → GPIO9 |

BT1 pins 1 and 2 connect the positive clip to RTC_BAT; pin 3 contacts the negative terminal and GND. This backup supply is separate from the rechargeable main battery. No charging path to the CR1220 is provided.

### Firmware behavior

The RTC uses address 0x68 and supports 400 kHz I2C. INT/SQW is open drain. In alarm mode it asserts LOW; configure GPIO7 as an input. Read the oscillator-stop flag (OSF) in status register `0x0F` before trusting calendar time. Control register `0x0E` selects alarm versus square-wave behavior. Calendar fields are BCD and must be decoded with their control bits. Clear the relevant alarm flag after servicing; otherwise the interrupt can remain LOW. Source: [Analog Devices DS3231 datasheet](https://www.analog.com/media/en/technical-documentation/data-sheets/ds3231.pdf).

Recommended policy: store UTC, mark time invalid when OSF is set or the calendar is implausible, and initialize it only from an explicit trusted time source. Do not overwrite a valid RTC with build time at every boot. Preserve a mapping between RTC UTC and a 64-bit MCU monotonic timestamp. I2C read latency and the RTC's one-second calendar resolution do not provide sample-accurate audio/IMU timestamps.

Choose either alarms or square-wave output for GPIO7 and document that choice. Perform I2C servicing in a task notified by the ISR. The RTC can retain time while SW1 is off, but cannot turn on the main regulator. Any deep-sleep wake implementation requires SW1 to remain ON, an appropriate ESP32 wake configuration and verified alarm behavior. Do not confuse deep sleep with mechanical switch-off.

## 8. Power architecture, controls and battery measurement

### Rails and switch behavior

| Net | Source / nominal voltage | Firmware implication |
|---|---|---|
| VBUS_RAW | J1 USB-C input, 5 V | Before F1; not an ESP32 input |
| USB_5V | After F1 1.5 A fuse | Charger input and USB-C logic supply; not an ESP32 input |
| CC_3V3 | U3 USB-powered regulator | USB-C logic remains operational with SW1 OFF |
| BAT | J2 pin 1, protected 1S cell | 3.7 V nominal; charge regulated to 4.2 V; nominal voltage is not a discharge cutoff |
| SYS | U6 OUT | About 4.4 V with adequate USB input; follows battery through the power path when USB is absent |
| +3V3 | U7 buck-boost output | MCU, sensors, RTC main supply and both expansion headers |
| MIC_3V3 | +3V3 through R27 22 Ω | Filtered microphone supply, slightly below +3V3 under load |
| RTC_BAT | CR1220 | RTC timekeeping backup only |

**The 4.4 V value belongs to SYS, not to the rechargeable battery. BAT remains a 4.2 V charging system.** See the local [TI charger family datasheet](../references/BQ24074.pdf), which includes BQ24073, and [TI's BQ24073 product documentation](https://www.ti.com/product/BQ24073).

J2 is a two-pin JST PH battery connector: **pin 1 BAT+, pin 2 GND**. Cable colors are not a pinout guarantee. SW1 common pin 2 drives SYS_EN; its ON contact pin 1 connects SYS_EN to SYS and its OFF contact pin 3 connects it to GND. R18 = 100 kΩ also pulls SYS_EN down. **SW1 disables the main regulator; it does not disconnect the cell or stop USB charging.** Firmware cannot read SW1 position or turn itself back on after this switch removes its supply.

U7 MODE is tied to SYS, selecting forced PWM. Feedback uses R16 = 560 kΩ from +3V3 to FB and R17 = 100 kΩ from FB to GND. L1 is **XGL4020-471MEC, 0.47 µH**, not a 4.7 µH `-472` part. C13/C14 are each 47 µF. These are fixed hardware choices, not software settings.

### Charger and USB-C controller: no software register interface on A3

| Item | Wiring / configured behavior |
|---|---|
| U6 BAT | Pins 2/3 → BAT |
| U6 OUT | Pins 10/11 → SYS |
| U6 IN | Pin 13 → USB_5V |
| Charge enable | U6.4 CE_N grounded; enabled by hardware |
| Charge current | U6.16 ISET → R11 1.47 kΩ → GND; about 605 mA nominal fast charge |
| Input current | U6.12 ILIM → R12 1.62 kΩ → GND; approximately 1 A when resistor-limited mode is selected |
| Input mode | U6.5 EN2 → CHG_HIGH_EN; U6.6 EN1 → GND |
| Termination | U6.15 TD grounded, enabling termination; A3 uses BQ24073, not the BQ24074 ITERM pin function |
| Timer | U6.14 TMR → R13 64.9 kΩ → GND |
| Cell temperature | U6.1 TS → BAT_NTC → remote TH1 10 kΩ B3435 NTC → GND |
| USB power-good | U6.7 PGOOD_N → USB_PGOOD_N; R15 10 kΩ to +3V3; TP9 only |
| Charging indicator | U6.9 CHG_N sinks D2 red LED current; USB_5V → R14 2.2 kΩ → D2 |
| Regulator power-good | U7.5 PG → REG_PG; R19 10 kΩ to +3V3; TP10 only |

U2 is strapped as a sink with PORT grounded and EN_N grounded. ADDR is unconnected for GPIO mode. CC1/CC2 go to J1; OUT1 drives CC_DEFAULT_N with R7 = 10 kΩ pull-up to CC_3V3. U4 inverts this into CHG_HIGH_EN; R8 = 100 kΩ pulls that signal down. The circuit selects conservative 100 mA input mode for default-current sources, or the approximately 1 A resistor limit when at least 1.5 A is advertised. No higher-voltage USB-PD contract is requested. See [TI TUSB320LI documentation](https://www.ti.com/lit/ds/symlink/tusb320li.pdf).

Actual charging current may be reduced by source limits, system load, thermal regulation or battery state. A default-current USB port may not sustain high-load Wi-Fi operation without battery assistance. The user's 3000 mAh cell does not imply a firmware-programmable 1.5 A charging current; this PCB sets approximately 605 mA in hardware.

TH1 is a remote cell-contact thermistor termination, not a student connector and not an MCU ADC. Firmware cannot report pack temperature from it. Charger status, USB_PGOOD_N and REG_PG are likewise not readable by the MCU without a hardware modification. A USB serial connection is not a reliable substitute for measuring USB power availability.

### Battery ADC: GPIO1

```text
BAT ── R4 1,000,000 Ω ──┬── GPIO1 / BAT_ADC
                       ├── R5 330,000 Ω ── GND
                       └── C4 100 nF ───── GND
```

Nominal equations:

```text
Vadc = Vbattery × 330000 / (1000000 + 330000)
Vbattery = Vadc × 4.0303030303
Vbattery_mV = calibrated_adc_mV × 4.0303030303

4.2 V battery → approximately 1.0421 V at GPIO1
3.7 V battery → approximately 0.9180 V at GPIO1
```

Use a calibrated ADC conversion, not `raw * 3.3 / 4095`. Recommended initial Arduino attenuation: **ADC_6db**, which covers this input with headroom. The ESP32-S3's 0 dB range ends around 0.95 V and is insufficient at full charge. See [Espressif Arduino ADC documentation](https://docs.espressif.com/projects/arduino-esp32/en/latest/api/adc.html).

The divider's Thevenin resistance is approximately 248 kΩ; with C4 the nominal time constant is 24.8 ms. This is a slow battery monitor, not a high-bandwidth ADC source. Recommended: wait at least about 125 ms after a supply transition before using the result, average a small group of calibrated readings, report around once per second, and compare against a meter across several battery voltages. Resistor tolerance, ADC behavior and loading require a board-specific calibration check. Do not enable a GPIO pull resistor on GPIO1 or drive it as an output.

The divider remains connected to BAT when SW1 is off; it is not switched by firmware. Firmware cannot measure the battery while the MCU is unpowered. No current sensor or coulomb counter exists. Do not report a precise battery percentage, charge current or remaining runtime from voltage alone. Define low-battery policy using the actual pack's specifications and measured load behavior; 3.7 V is not a cutoff threshold.

### User controls and indicators

| Ref | Function | Firmware consequence |
|---|---|---|
| SW1 | Main electronics ON/OFF | Removes +3V3 when OFF; no software shutdown handshake |
| SW2 | RESET, pulls U1 EN LOW | Hardware reset; not a readable user button |
| SW3 | BOOT, pulls GPIO0 LOW | Boot strap; may be read after boot if deliberately used, but LOW during reset enters download mode |
| D1 | Green status LED, GPIO2 through R3 1 kΩ | HIGH = on, LOW = off; regular LED, not addressable RGB |
| D2 | Red charging LED | Hardware-driven by charger; not software-controllable |

## 9. Student expansion headers

J3 and J4 are **2 × 6, 2.54 mm** headers/sockets. View the component side with the ESP32 antenna at the top. Both headers have this physical numbering: even pins on the inner row, odd pins on the row closest to the bottom board edge. Pin 1 is the square pad at the lower left.

```text
                    toward board interior / antenna
                    2   4   6   8  10  12
                    1   3   5   7   9  11
                    toward bottom board edge
```

### J3 — general GPIO expansion

| Pin | Connection | Notes |
|---:|---|---|
| 1 | +3V3 | Switched power output |
| 2 | GND | Ground |
| 3 | GPIO16 | ADC2-capable; Wi-Fi/continuous acquisition restrictions |
| 4 | GPIO17 | ADC2-capable; same restrictions |
| 5 | GPIO18 | ADC2-capable; same restrictions |
| 6 | GPIO21 | General GPIO |
| 7 | GPIO38 | General GPIO |
| 8 | GPIO39 | General GPIO or external JTAG function |
| 9 | GPIO40 | Same net as J4.5, external SPI SCK |
| 10 | GPIO41 | Same net as J4.6, external SPI MOSI |
| 11 | GPIO42 | Same net as J4.7, external SPI MISO |
| 12 | GPIO48 | General GPIO |

### J4 — buses, UART and reset

| Pin | Connection | Notes |
|---:|---|---|
| 1 | +3V3 | Switched power output |
| 2 | GND | Ground |
| 3 | GPIO8 / I2C SDA | Shared with BME688 and RTC |
| 4 | GPIO9 / I2C SCL | Shared bus, maximum 400 kHz |
| 5 | GPIO40 / external SCK | Separate from onboard IMU SCK12 |
| 6 | GPIO41 / external MOSI | Separate from onboard IMU MOSI11 |
| 7 | GPIO42 / external MISO | Separate from onboard IMU MISO13 |
| 8 | GPIO47 / external CS | R28 10 kΩ to +3V3; active LOW by default |
| 9 | GPIO43 / UART TX | Connect to accessory RX; can emit boot messages |
| 10 | GPIO44 / UART RX | Connect to accessory TX |
| 11 | EN / RESET_N | Input to MCU enable/reset; **not a GPIO** |
| 12 | GND | Ground |

**A3 J4 SPI wiring differs from A2.** The A3 external SPI pins are 40/41/42/47, not the IMU's 12/11/13/10. J3 and J4 duplicate GPIO40/41/42; they do not add separate signals.

Recommended allocation: onboard IMU on Arduino `SPI` / S3 `FSPI`, external SPI on a separate `SPIClass(HSPI)`. Initialize each with its explicit pin tuple and use transactions with each device's required mode/rate. These host names are Arduino aliases; confirm them for the pinned S3 core. [Espressif's multiple-SPI-bus example](https://docs.espressif.com/projects/arduino-esp32/en/latest/api/spi.html) demonstrates explicit instances and alternate pin assignments.

Start external SPI at 1 MHz on short leads; its module/cabling determines the maximum. A device must release MISO while deselected. GPIO47 can be general-purpose if external SPI CS is unused. Do not initialize an external driver on the onboard `SPI` instance by accident.

All headers use **3.3 V logic and power only**; no 5 V tolerance or per-pin level conversion is provided. The combined J3/J4 accessory power budget is provisionally 100 mA, pending load/thermal qualification; it is not an individually protected output. Do not back-power the rail. For I2C, avoid addresses 0x68/0x76, check extra pull-ups and lower clock rate if cable capacitance requires it. For J4.11 use only an appropriate open-drain reset output or momentary contact to GND; do not drive it with a push-pull accessory signal.

## 10. Arduino build, USB flashing and recovery

### Build configuration

| Setting | A3 requirement / recommended starting choice |
|---|---|
| Target | ESP32-S3; generic **ESP32S3 Dev Module**, not ESP32 Feather V2 |
| Arduino base board ID | `esp32:esp32:esp32s3`; resolve option identifiers for the pinned core |
| Flash size | **8 MB** |
| Flash type / mode | Quad SPI; QIO is the recommended initial setting |
| Flash frequency | **80 MHz** initial/default; do not assume 120 MHz capability |
| PSRAM | **OPI / octal, 8 MB**; not QSPI PSRAM |
| CPU | 240 MHz recommended for initial throughput work |
| USB | Native USB; USB CDC On Boot enabled |
| USB mode | Hardware CDC and JTAG is the recommended initial diagnostic path when offered by the selected core |
| Partition scheme | Must fit 8 MB; explicitly choose OTA versus non-OTA layout |
| Framework/libraries | Pin versions in the build configuration and record them in startup diagnostics |

Module memory configuration and flash limits are documented in the local [ESP32-S3-WROOM-1 datasheet](../references/ESP32-S3-WROOM-1.pdf), section 1.2. Menu names/options can change; use the matching [Arduino tools-menu documentation](https://docs.espressif.com/projects/arduino-esp32/en/latest/guides/tools_menu.html).

Check detected flash size, PSRAM initialization and available internal/external heap at startup. Fail visibly or use an explicitly declared reduced-buffer mode if PSRAM is unavailable. Do not use the entire advertised PSRAM capacity as a queue budget; framework and application allocations also consume memory. Follow the installed driver's DMA memory requirements; a conservative starting design keeps DMA descriptors/buffers in DMA-capable internal RAM and copies completed blocks into PSRAM queues.

### USB path

J1 D− goes through R9 22 Ω to GPIO19; D+ goes through R10 22 Ω to GPIO20. U5 protects the data nets. **There is no CP210x/CH340/FTDI USB-to-UART bridge and no discrete DTR/RTS auto-reset circuit.** U2 handles USB-C attachment/current detection, not application USB data.

Keep SW1 ON when flashing or using USB diagnostics. Use a data-capable cable. If a blank board or failed application does not enumerate:

1. Hold SW3 BOOT.
2. Press and release SW2 RESET while BOOT remains held.
3. Release BOOT, select the newly enumerated port, and flash the ESP32-S3 build.
4. Reset after programming if the flashing tool does not restart the application.

Use the chosen build system's generated flashing arguments and partition offsets. Native USB may re-enumerate between ROM download and application modes. Follow [Espressif's USB CDC flashing procedure](https://docs.espressif.com/projects/arduino-esp32/en/latest/tutorials/cdc_dfu_flash.html). Do not block indefinitely on `while (!Serial)`; the product must also start from battery without a USB host.

UART recovery is available on J4.9/10 or TP5/6 using **3.3 V TTL** signals and common GND: adapter RX ← TX43, adapter TX → RX44. Do not connect an adapter's 5 V or RS-232 voltage outputs. BOOT/RESET are still available manually. If USB CDC is `Serial`, use a separate explicitly configured UART instance for student peripherals. GPIO43 may carry ROM boot output, which an attached module must tolerate.

## 11. Recommended streaming software architecture

This section proposes software requirements. It does not describe firmware already implemented or tested.

### Ownership and scheduling

| Responsibility | Recommended implementation |
|---|---|
| Audio acquisition | I2S RX DMA → bounded audio queue; independent of network blocking |
| IMU acquisition | FIFO watermark notification → SPI drain task → bounded IMU queue |
| Environmental acquisition | Low-rate BME688 task with timed conversion/heater state machine |
| RTC / battery / health | Periodic housekeeping; shared I2C lock for RTC, slow calibrated ADC reads |
| Network output | Separate task, batching binary payloads from queues |
| Configuration | Validated settings, versioned metadata; coordinated stop/reconfigure/restart for sample format changes |
| Diagnostics | Rate-limited USB/log output; separate from raw payload |

Use a small number of preallocated buffers. Avoid per-sample allocation, JSON serialization and printing in high-rate paths. Do not hold bus locks while waiting for network output. ISR callbacks should notify tasks and capture minimal timing information. Keep watchdog servicing and network scheduling functional; do not assign task affinity/priorities from an unrelated ESP32 example without measuring this build.

### Rates and payload budget

| Stream | Initial qualification target | Upper design/device limit |
|---|---|---|
| Audio | 48,000 samples/s, one useful 32-bit word/sample | About 52,800 samples/s, subject to actual clock tolerance and timing |
| Accelerometer | Begin with a lower ODR, then raise while observing FIFO health | About 6,667 samples/s |
| Gyroscope | Same staged approach | About 6,667 samples/s |
| IMU bus | Start at 1 MHz; raise after ID/readback and timing checks | 10 MHz SPI ceiling |
| BME688 | Profile-dependent; schedule only valid completed measurements | Conversion/heater settings determine throughput |
| Shared I2C | 100 kHz bring-up, 400 kHz after validation | 400 kHz |
| Battery / health | Approximately 1 report/s recommended | No need for high-rate sampling |

At 48 kHz audio in 32-bit words and 6,667 Hz on six 16-bit IMU axes:

```text
audio: 48000 × 4                  = 192000 bytes/s
IMU:    6667 × 6 × 2              =  80004 bytes/s
total before metadata/overheads   = 272004 bytes/s ≈ 2.176 Mbit/s

at 52800 Hz audio: total          = 291204 bytes/s ≈ 2.330 Mbit/s
```

These are useful payload estimates, not complete bus/network load. FIFO tags, separate sensor timestamps, protocol framing, retries, environmental records and temporary stereo DMA storage add overhead. Qualify at least about **5 Mbit/s of sustained application throughput** with the intended Wi-Fi access point, enclosure and charging conditions. This is a test target, not a demonstrated capability guarantee. Discard the unused I2S right slot before transmission unless explicitly sending diagnostic wire frames.

Finite buffers cannot bridge arbitrary outages. Choose and document a policy: drop oldest data for a live stream, stop acquisition on full queues, or another explicit bounded behavior. Always report sample/packet loss. Do not advertise lossless operation solely because TCP is used; local acquisition queues can still overflow.

### Timing and a proposed packet contract

Audio BCLK/WS, the IMU sampling clock and the RTC are separate clock domains. Host packet-arrival time is not acquisition time. Recommended fields:

| Field / record | Purpose |
|---|---|
| Protocol version, record type, payload length | Unambiguous framing and future compatibility |
| Device ID, hardware revision, firmware build ID, boot/session ID | Identify source and distinguish restarts |
| Per-stream sequence and first sample counter | Detect missing or reordered blocks |
| 64-bit monotonic timestamp, sample count, rate/configuration ID | Reconstruct within-session timing |
| Time-anchor record: monotonic time, UTC, validity/source/uncertainty | Relate sample time to RTC or a trusted network clock |
| Audio format descriptor | Signedness, 24 valid bits, 32-bit container alignment, channel, actual rate |
| IMU format descriptor | Sensor axis order, range, sensitivity, ODR, filter settings; raw signed 16-bit values |
| Environmental descriptor | Units, profile, compensated versus raw representation, validity/status fields |
| Health record | FIFO/DMA overruns, queue high-water marks, dropped counts, reconnects, resets and battery mV |

Specify byte order and field widths explicitly. Recommended initial wire encoding is binary with little-endian integers, rather than sending native C structs with implicit padding. Define transport framing for TCP or packet sizes/loss behavior for UDP; avoid IP fragmentation when choosing UDP block sizes. Receiver endpoint, protocol and authentication are deployment configuration, not wired properties of this board.

Timestamp blocks at acquisition/driver events, retain sample counters, and characterize clock drift. If combining accelerometer and gyro records, verify their timestamp relationship before claiming they are simultaneous. Retain the original sensor coordinates until an enclosure transform is tested. Do not write high-rate samples continuously into internal flash; use it for bounded configuration/calibration storage and intentionally designed logs only.

## 12. Pin constants and implementation starting points

The following constants reproduce the existing A3 header and can be copied into a new project. They define hardware allocation, not a complete driver or tested application.

```cpp
#pragma once
namespace FredPal {
constexpr int I2C_SDA=8, I2C_SCL=9;
constexpr int IMU_SCK=12, IMU_MOSI=11, IMU_MISO=13, IMU_CS=10;
constexpr int IMU_INT1=14, IMU_INT2=15, RTC_INT=7;
constexpr int MIC_BCLK=4, MIC_WS=5, MIC_SD=6;
constexpr int BAT_ADC=1, STATUS_LED=2, UART_TX=43, UART_RX=44;
constexpr int USB_DM=19, USB_DP=20, EXT_SPI_CS=47;
constexpr int EXT_SPI_SCK=40, EXT_SPI_MOSI=41, EXT_SPI_MISO=42;
constexpr unsigned IMU_SPI_MAX_HZ=10000000, I2C_MAX_HZ=400000;
constexpr unsigned AUDIO_MAX_SAMPLE_RATE=52800;
constexpr int FREE_GPIO[]={16,17,18,21,38,39,40,41,42,47,48};
constexpr unsigned BME688_ADDRESS=0x76, DS3231_ADDRESS=0x68;
constexpr unsigned AUDIO_SAMPLE_RATE=48000;
}
```

`FREE_GPIO` means available for assignment when no conflicting accessory/JTAG function is active. It does not imply every listed pin can be used independently of both headers or has the same analog/peripheral capabilities.

Illustrative battery conversion after ADC calibration/setup and settling:

```cpp
// Arduino-ESP32 API; compile and validate against the selected core.
analogReadResolution(12);
analogSetPinAttenuation(FredPal::BAT_ADC, ADC_6db);
// Later, in a slow housekeeping task after settling:
uint32_t adc_mV = analogReadMilliVolts(FredPal::BAT_ADC);
float battery_mV = adc_mV * (1330000.0f / 330000.0f);
```

Suggested startup order:

1. Establish safe outputs: status LED LOW, IMU CS HIGH, external CS HIGH; sensor interrupt pins input/no pull-up.
2. Start bounded USB diagnostics; log reset cause, build, board revision and memory detection.
3. Start I2C on 8/9, IMU SPI on 12/13/11/10 in the API's SCK/MISO/MOSI/CS order, and initialize each sensor with a timeout.
4. Read RTC validity; initialize battery ADC; report any missing/invalid device without treating address ACK as complete validation.
5. Allocate queues and DMA resources. Configure I2S and verify successful initialization before enabling streaming.
6. Discard microphone startup frames. Configure and enable IMU FIFO acquisition; timestamp initial valid blocks independently.
7. Connect Wi-Fi and apply the selected bounded buffering/disconnect policy; emit complete configuration metadata before sample payloads.
8. Enable optional student modules only after checking their pin/controller/address/resource allocations.

Build any example code against the pinned core and libraries. The snippets here have not been compiled or exercised on a physical A3 board.

## 13. Testpoints and physical-design context

| Testpoint | Net | Meaning / access |
|---|---|---|
| TP1 | GND | Measurement reference |
| TP2 | +3V3 | Main regulated output |
| TP3 | SYS | Charger system output, not battery charge voltage |
| TP4 | BAT | Main battery voltage |
| TP5 | UART_TX | GPIO43 |
| TP6 | UART_RX | GPIO44 |
| TP7 | BOOT_N | GPIO0 |
| TP8 | RESET_N | ESP32 EN |
| TP9 | USB_PGOOD_N | Charger open-drain power-good, active LOW; no ESP32 GPIO connection |
| TP10 | REG_PG | Regulator power-good; no ESP32 GPIO connection |

The PCB is 68 × 68 mm, with four 3.2 mm nonplated mounting holes at (4,4), (64,4), (4,64), (64,64) mm in top-view coordinates with X right and Y down. The module antenna overhangs the top edge by 6 mm. J3/J4 are near the bottom edge. The microphone acoustic port is a 0.6 mm opening at (17,13) mm. Enclosure obstruction changes acoustic response; metal/battery placement near the antenna changes RF performance.

A3 specifies the JLC **JLC04161H-3313** four-layer stackup: outer signal/power layers, two inner GND reference planes, nominal 1.6 mm construction. The microphone has local supply filtering; I2S and IMU SPI signals have 22 Ω series resistors. The regulator uses fixed forced-PWM operation. USB routing targets 90 Ω differential impedance. These layout measures do not prove noise performance, EMC compliance or maximum clock reliability.

The selected N8R8 module's published base ambient range is −40 to +65 °C; its datasheet describes conditional extension with PSRAM ECC and reduced usable memory. Do not infer whole-board industrial temperature qualification from the word “industrial” in the application goal. Verify memory configuration, enclosure temperature and the complete assembly separately. See the [module datasheet, section 1.2](../references/ESP32-S3-WROOM-1.pdf).

## 14. Firmware bring-up and acceptance checklist

Before testing maximum rates, record firmware/library versions, actual assembled part identities, board revision and supply conditions.

| Test | Required observation / record |
|---|---|
| Power / switching | +3V3 is correct with battery and suitable USB supply; SW1 OFF removes MCU power while USB charging remains possible |
| Flash / memory | ESP32-S3 identified, 8 MB flash recognized, octal PSRAM initializes; stable resets and download recovery |
| Status LED | GPIO2 HIGH/LOW controls D1 only |
| I2C | 0x68 and 0x76 ACK; transactions reliable at 100 kHz, then qualified at 400 kHz |
| IMU identity | WHO_AM_I = 0x6C; reset and configuration readback succeed |
| IMU data | Plausible stationary data, correct full-scale conversion, interrupts and FIFO counters; no unexplained tag loss |
| Microphone clocks | WS equals requested sample rate; BCLK/WS ratio is 64; left slot contains valid signed samples |
| Microphone startup | At least 4,096 startup frames discarded; known tone confirms alignment/rate; no false second channel |
| BME688 | ID/variant/calibration recognized; new-data/heater/gas validity handled; units/profile recorded |
| RTC | OSF/time-validity handled, UTC retained across main power loss with a fitted cell, alarm flags correctly cleared |
| Battery ADC | Calibrated reading matches a meter across battery voltage range; no full-charge clipping |
| Expansion | Pin numbering verified; external SPI does not reconfigure IMU; I2C/UART modules coexist within resource limits |
| Streaming | Sustained receiver-side rate, sample counts, latency, queue occupancy and loss counters measured together |
| Failure recovery | AP loss, stalled receiver, missing accessory, full queue and sensor error produce bounded recovery and explicit gaps |
| Power/noise stress | Repeat streaming while charging, on battery, with intended enclosure/accessories and supply transients |

Report measured results separately from datasheet limits. Existing CAD release checks reported zero ERC/DRC violations and zero unrouted connections; they do not replace these electrical and software tests. No claim of compiled acquisition firmware, measured maximum throughput, calibrated sensors or lossless streaming is made by this document.

## 15. Application decisions still to configure

Hardware wiring is fixed, but the coding agent must make the following explicit configuration choices before a deployable application is complete:

- Wi-Fi provisioning, receiver address/port, transport, authentication and reconnect policy.
- Audio 48 kHz baseline versus a separately qualified near-ceiling rate; packet sample representation.
- IMU ranges, ODR, filter settings and sensor-to-enclosure transform.
- BME688 oversampling/heater profile, required outputs, and whether BSEC is wanted.
- Trusted time source and RTC synchronization policy.
- Maximum queue memory/latency, overflow policy and loss reporting.
- Low-battery behavior, OTA/partition layout and configuration storage.
- Which student modules, addresses, GPIOs and power budget are actually in use.

Defaults should be configurable and documented; none of these choices can be inferred from a connector or component part number.
