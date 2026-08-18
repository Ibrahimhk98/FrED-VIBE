#include <Arduino.h>
#include <Wire.h>
#include <RTClib.h>
#include <Adafruit_BME680.h>
#include <Adafruit_LSM6DSOX.h>
#include <Adafruit_NeoPixel.h>
#include <NimBLEDevice.h>
#include <driver/i2s.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>
#include <ctype.h>
#include <errno.h>
#include <math.h>
#include "ima_adpcm.h"

// Feather V2 pin labels: A0=GPIO26, A1=GPIO25, A5=GPIO4.
// A3/GPIO39 is input-only and cannot generate LRCL. Rewire LRCL to A5.
// Both I2S slots are captured, so the ICS43434 SEL pin may select either slot.
constexpr gpio_num_t MIC_BCLK = GPIO_NUM_26;
constexpr gpio_num_t MIC_DOUT = GPIO_NUM_25;
constexpr gpio_num_t MIC_LRCL = GPIO_NUM_4;
constexpr gpio_num_t PIN_BATTERY = GPIO_NUM_35;
constexpr gpio_num_t STATUS_NEOPIXEL_PIN = GPIO_NUM_0;
constexpr gpio_num_t STATUS_NEOPIXEL_POWER_PIN = GPIO_NUM_2;
constexpr uint32_t MIC_SAMPLE_RATE = 16000;
constexpr uint32_t AUDIO_PLAYBACK_RATE_USB = 16000;
constexpr uint32_t AUDIO_PLAYBACK_RATE_BLE = 8000;

constexpr uint32_t IMU_INTERVAL_MS = 10;       // 100 Hz sensor acquisition
constexpr uint32_t PACKET_INTERVAL_MS = 100;   // ten samples per telemetry packet
constexpr uint32_t ENV_INTERVAL_MS = 1000;
constexpr size_t AUDIO_PCM16_BUFFER_SIZE = (MIC_SAMPLE_RATE * PACKET_INTERVAL_MS / 1000) * 5 / 4; // 2000 samples (1600 nominal + jitter headroom so no samples are dropped)
constexpr size_t BLE_MAX_CHUNK_BYTES = 244;   // matches negotiated MTU 247 (MTU - 3) to minimise notifies per packet

static const char *DEVICE_NAME = "PAL-V2-Telemetry";
static const char *SERVICE_UUID = "7f510001-5b8d-4a84-9c7c-a07142ab6001";
static const char *DATA_UUID = "7f510002-5b8d-4a84-9c7c-a07142ab6001";
static const char *COMMAND_UUID = "7f510003-5b8d-4a84-9c7c-a07142ab6001";

RTC_DS3231 rtc;
Adafruit_BME680 bme;
Adafruit_LSM6DSOX lsm6dsox;
Adafruit_NeoPixel pixel(1, STATUS_NEOPIXEL_PIN, NEO_GRB + NEO_KHZ800);
NimBLECharacteristic *dataCharacteristic = nullptr;
i2s_port_t microphonePort = I2S_NUM_0;

struct ImuSample {
  uint32_t offsetMs;
  float ax, ay, az;
  float gx, gy, gz;
};

ImuSample imuSamples[16];
size_t imuCount = 0;
bool rtcReady = false;
bool rtcNeedsSync = false;
bool bmeReady = false;
bool imuReady = false;
bool micReady = false;
volatile bool bleSubscribed = false;
volatile size_t bleChunkBytes = 20;
volatile uint16_t bleConnectionHandle = BLE_HS_CONN_HANDLE_NONE;
uint64_t clockBaseMs = 0;
uint32_t clockBaseMillis = 0;
uint32_t lastImuMs = 0;
uint32_t lastPacketMs = 0;
uint32_t lastEnvMs = 0;
uint32_t lastLedUpdateMs = 0;
volatile uint32_t lastBleActivityMs = 0;
uint32_t bmeReadyAtMs = 0;
bool bmeReading = false;
bool audioStreaming = true;
double audioSquareSum = 0.0;
uint32_t audioSampleCount = 0;
int16_t audioPcm16Samples[AUDIO_PCM16_BUFFER_SIZE];
size_t audioPcm16Count = 0;
ImaAdpcmEncoder bleAdpcmEncoder;

struct CommandMessage {
  char text[257];
};

QueueHandle_t commandQueue = nullptr;
QueueHandle_t telemetryQueue = nullptr;
SemaphoreHandle_t i2cMutex = nullptr;
SemaphoreHandle_t audioMutex = nullptr;

bool batterySaveMode = false;

class I2CLock {
public:
  I2CLock() {
    if (i2cMutex != nullptr) {
      xSemaphoreTake(i2cMutex, portMAX_DELAY);
    }
  }
  ~I2CLock() {
    if (i2cMutex != nullptr) {
      xSemaphoreGive(i2cMutex);
    }
  }
};

class AudioLock {
public:
  AudioLock() {
    if (audioMutex != nullptr) {
      xSemaphoreTake(audioMutex, portMAX_DELAY);
    }
  }
  ~AudioLock() {
    if (audioMutex != nullptr) {
      xSemaphoreGive(audioMutex);
    }
  }
};

String encodeBase64(const uint8_t *data, size_t length) {
  static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  String encoded;
  encoded.reserve(((length + 2) / 3) * 4);
  for (size_t i = 0; i < length; i += 3) {
    const uint32_t a = data[i];
    const uint32_t b = i + 1 < length ? data[i + 1] : 0;
    const uint32_t c = i + 2 < length ? data[i + 2] : 0;
    const uint32_t triple = (a << 16) | (b << 8) | c;
    encoded += alphabet[(triple >> 18) & 0x3F];
    encoded += alphabet[(triple >> 12) & 0x3F];
    encoded += i + 1 < length ? alphabet[(triple >> 6) & 0x3F] : '=';
    encoded += i + 2 < length ? alphabet[triple & 0x3F] : '=';
  }
  return encoded;
}


float readBatteryVoltage() {
  // Adafruit Feather ESP32 V2 uses a 1:2 voltage divider (two 100k resistors) on GPIO35.
  const uint32_t raw = analogRead(PIN_BATTERY);
  const float vAdc = (static_cast<float>(raw) / 4095.0f) * 3.3f;
  const float vBat = vAdc * 2.0f;
  return vBat;
}

uint8_t calculateBatteryPercentage(float vBat) {
  if (vBat >= 4.20f) return 100;
  if (vBat <= 3.30f) return 0;
  return static_cast<uint8_t>(constrain((vBat - 3.30f) / (4.20f - 3.30f) * 100.0f, 0.0f, 100.0f));
}

struct IaqResult {
  float iaq;
  float vocPpm;
  float eco2Ppm;
};

IaqResult calculateIaqScore(float tempC, float humPct, uint32_t gasOhms) {
  if (gasOhms == 0) {
    return {0.0f, 0.0f, 400.0f};
  }

  // 1. Humidity Contribution (25% weight)
  float sHum = 0.0f;
  if (humPct >= 38.0f && humPct <= 42.0f) {
    sHum = 25.0f;
  } else if (humPct < 38.0f) {
    sHum = (0.25f / 40.0f) * humPct * 100.0f;
  } else {
    sHum = ((-0.25f / 60.0f) * humPct + 0.4166f) * 100.0f;
  }

  // 2. Gas Resistance Contribution (75% weight)
  float rGas = static_cast<float>(gasOhms);
  constexpr float R_UPPER = 50000.0f; // Good air
  constexpr float R_LOWER = 5000.0f;  // Bad air
  if (rGas > R_UPPER) rGas = R_UPPER;
  if (rGas < R_LOWER) rGas = R_LOWER;

  float sGas = ((0.75f / (R_UPPER - R_LOWER)) * rGas - (R_LOWER * (0.75f / (R_UPPER - R_LOWER)))) * 100.0f;

  // 3. IAQ Score and VOC estimation
  float iaqPct = sHum + sGas; // 100% = perfectly clean
  float rawIaq = (100.0f - iaqPct) * 5.0f; // 0 = best, 500 = worst
  if (rawIaq < 0.0f) rawIaq = 0.0f;
  if (rawIaq > 500.0f) rawIaq = 500.0f;

  const float vocPpm = (rawIaq / 500.0f) * 10.0f;
  const float eco2Ppm = 400.0f + (rawIaq * 8.0f);

  return {rawIaq, vocPpm, eco2Ppm};
}


enum SystemStatusColor {
  COLOR_BLUE,   // BLE Connected
  COLOR_RED,    // Sensor Error or High Gas Alert
  COLOR_AMBER,  // RTC Drift / Low Battery
  COLOR_GREEN   // All Systems Normal
};

SystemStatusColor evaluateSystemStatus(bool bleConn, bool rtcOk, bool rtcSyncNeeded, bool imuOk, bool bmeOk, bool micOk, float vBat, uint32_t gasOhms) {
  if (bleConn) return COLOR_BLUE;
  if (!rtcOk || !imuOk || !bmeOk || !micOk || (bmeOk && gasOhms > 0 && gasOhms < 20000)) return COLOR_RED;
  if (rtcSyncNeeded || (vBat > 0.5f && vBat < 3.48f)) return COLOR_AMBER;
  return COLOR_GREEN;
}

void performSafeBleDisconnect() {
  bleSubscribed = false;
  {
    AudioLock lock;
    // Keep audioStreaming on (USB waveform stays live); only reset the BLE codec
    // state so the next connection starts the ADPCM stream cleanly.
    bleAdpcmEncoder.reset();
  }
  const uint16_t handle = bleConnectionHandle;
  bleConnectionHandle = BLE_HS_CONN_HANDLE_NONE;

  NimBLEServer *server = NimBLEDevice::getServer();
  if (server != nullptr && handle != BLE_HS_CONN_HANDLE_NONE && server->getConnectedCount() > 0) {
    server->disconnect(handle);
  }

  NimBLEAdvertising *adv = NimBLEDevice::getAdvertising();
  if (adv != nullptr && !adv->isAdvertising()) {
    adv->start();
  }
}

void checkBleSafetyTimeout() {
  NimBLEServer *server = NimBLEDevice::getServer();
  if (server == nullptr) return;
  const size_t connCount = server->getConnectedCount();

  if (connCount == 0) {
    if (bleSubscribed || bleConnectionHandle != BLE_HS_CONN_HANDLE_NONE) {
      performSafeBleDisconnect();
    }
    NimBLEAdvertising *adv = NimBLEDevice::getAdvertising();
    if (adv != nullptr && !adv->isAdvertising()) {
      adv->start();
    }
    return;
  }

  const uint32_t now = millis();
  if (lastBleActivityMs > 0 && (now - lastBleActivityMs > 15000)) {
    performSafeBleDisconnect();
  }
}

void updateNeoPixelStatus() {
  checkBleSafetyTimeout();
  NimBLEServer *server = NimBLEDevice::getServer();
  const bool activeBleConnected = bleSubscribed && (server != nullptr && server->getConnectedCount() > 0);
  const float vBat = readBatteryVoltage();
  const SystemStatusColor status = evaluateSystemStatus(
    activeBleConnected, rtcReady, rtcNeedsSync, imuReady, bmeReady, micReady, vBat, bme.gas_resistance
  );

  uint8_t r = 0, g = 0, b = 0;
  switch (status) {
    case COLOR_BLUE:
      b = 255;
      break;
    case COLOR_RED:
      r = 255;
      break;
    case COLOR_AMBER:
      r = 255; g = 140;
      break;
    case COLOR_GREEN:
    default:
      g = 255;
      break;
  }

  if (batterySaveMode) {
    const uint32_t phase = millis() % 5000;
    constexpr uint32_t PULSE_DURATION_MS = 600;
    if (phase < PULSE_DURATION_MS) {
      const float factor = sinf((static_cast<float>(phase) / static_cast<float>(PULSE_DURATION_MS)) * M_PI);
      pixel.setPixelColor(0, pixel.Color(
        static_cast<uint8_t>(r * factor),
        static_cast<uint8_t>(g * factor),
        static_cast<uint8_t>(b * factor)
      ));
    } else {
      pixel.setPixelColor(0, pixel.Color(0, 0, 0));
    }
  } else {
    pixel.setPixelColor(0, pixel.Color(r, g, b));
  }
  pixel.show();
}

uint64_t nowUnixMs() {
  return clockBaseMs + static_cast<uint32_t>(millis() - clockBaseMillis);
}

void syncClockBase() {
  I2CLock lock;
  DateTime now = rtc.now();
  clockBaseMs = static_cast<uint64_t>(now.unixtime()) * 1000ULL;
  clockBaseMillis = millis();
}

void sendLine(const String &line) {
  Serial.println(line);
  if (dataCharacteristic == nullptr || !bleSubscribed) {
    return;
  }

  const size_t chunkBytes = bleChunkBytes;
  const uint16_t connectionHandle = bleConnectionHandle;

  // Retry each notify briefly: a false return is controller tx congestion, not a lost
  // link, and yielding lets the buffers drain over a connection interval or two.
  auto notifyWithRetry = [&](const uint8_t *data, size_t length) -> bool {
    for (int attempt = 0; attempt < 12; ++attempt) {
      if (dataCharacteristic->notify(data, length, connectionHandle)) {
        lastBleActivityMs = millis();
        return true;
      }
      vTaskDelay(1);
    }
    return false;
  };

  for (size_t start = 0; start < line.length(); start += chunkBytes) {
    const size_t length = min(chunkBytes, line.length() - start);
    if (!notifyWithRetry(reinterpret_cast<const uint8_t *>(line.c_str() + start), length)) {
      break;
    }
  }

  // Always emit the newline delimiter (even after a dropped chunk) so a lost fragment
  // corrupts only its own line and never merges into the following packet.
  const uint8_t newline = '\n';
  notifyWithRetry(&newline, 1);
}

void enqueueTelemetry(const String &line) {
  if (telemetryQueue == nullptr) return;
  char *msg = strdup(line.c_str());
  if (msg == nullptr) return;
  if (xQueueSend(telemetryQueue, &msg, 0) != pdTRUE) {
    free(msg);
  }
}

void sendStatus(const char *state, const char *detail) {
  String message = "{\"type\":\"status\",\"time_ms\":" + String(nowUnixMs()) +
                   ",\"state\":\"" + state + "\",\"detail\":\"" + detail + "\"}";
  enqueueTelemetry(message);
}

void setRtcFromUnixMs(uint64_t unixMs) {
  if (!rtcReady) {
    sendStatus("command_error", "DS3231 is unavailable; clock was not changed");
    return;
  }
  {
    I2CLock lock;
    rtc.adjust(DateTime(static_cast<uint32_t>(unixMs / 1000ULL)));
  }
  clockBaseMs = unixMs;
  clockBaseMillis = millis();
  rtcNeedsSync = false;
  sendStatus("clock_set", "RTC updated from dashboard (UTC)");
}

void handleCommand(String command) {
  command.trim();
  if (command.indexOf("toggle_battery_save") >= 0 || command.indexOf("battery_save") >= 0) {
    batterySaveMode = !batterySaveMode;
    if (batterySaveMode) {
      sendStatus("battery_save_on", "Battery save mode ENABLED (LED pulsating every 5s)");
    } else {
      sendStatus("battery_save_off", "Battery save mode DISABLED (LED continuous status)");
    }
    updateNeoPixelStatus();
    return;
  }
  if (command.indexOf("disconnect_ble") >= 0) {
    performSafeBleDisconnect();
    sendStatus("ble_disconnected", "Bluetooth connection cleared & advertising restarted");
    return;
  }
  if (command.indexOf("start_audio") >= 0) {
    {
      AudioLock lock;
      audioStreaming = true;
    }
    sendStatus("recording", "PCM audio stream active");
    return;
  }
  if (command.indexOf("stop_audio") >= 0) {
    {
      AudioLock lock;
      // Streaming stays on so the live waveform never blanks; recording windows are
      // handled client-side by buffering the decoded PCM.
      audioStreaming = true;
    }
    sendStatus("recording_stopped", "PCM audio stream stays active for live waveform");
    return;
  }
  if (command.indexOf("set_time") < 0) {
    sendStatus("command_error", "Unknown command");
    return;
  }
  const int key = command.indexOf("\"unix_ms\"");
  const int colon = key < 0 ? -1 : command.indexOf(':', key);
  if (colon < 0) {
    sendStatus("command_error", "Missing unix_ms");
    return;
  }
  const char *number = command.c_str() + colon + 1;
  while (isspace(static_cast<unsigned char>(*number))) ++number;
  errno = 0;
  char *end = nullptr;
  const uint64_t unixMs = strtoull(number, &end, 10);
  while (end != nullptr && isspace(static_cast<unsigned char>(*end))) ++end;
  if (errno == ERANGE || end == number || end == nullptr || (*end != '}' && *end != ',') ||
      unixMs < 1577836800000ULL || unixMs >= 4102444800000ULL) {
    sendStatus("command_error", "Invalid unix_ms");
    return;
  }
  setRtcFromUnixMs(unixMs);
}

class CommandCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic *characteristic, NimBLEConnInfo & /*connInfo*/) override {
    lastBleActivityMs = millis();
    if (commandQueue == nullptr) return;
    const NimBLEAttValue value = characteristic->getValue();
    CommandMessage message = {};
    if (value.length() > sizeof(message.text) - 1) {
      strncpy(message.text, "command_too_long", sizeof(message.text) - 1);
    } else {
      memcpy(message.text, value.data(), value.length());
      message.text[value.length()] = '\0';
    }
    xQueueSend(commandQueue, &message, 0);
  }
};

class DataCallbacks : public NimBLECharacteristicCallbacks {
  void onSubscribe(NimBLECharacteristic * /*characteristic*/, NimBLEConnInfo &connInfo, uint16_t subValue) override {
    lastBleActivityMs = millis();
    bleSubscribed = subValue != 0;
    if (bleSubscribed) {
      bleConnectionHandle = connInfo.getConnHandle();
      bleChunkBytes = min(BLE_MAX_CHUNK_BYTES, static_cast<size_t>(max(23, static_cast<int>(connInfo.getMTU())) - 3));
    }
  }
};

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer *pServer, NimBLEConnInfo &connInfo) override {
    lastBleActivityMs = millis();
    bleConnectionHandle = connInfo.getConnHandle();
    // Request a fast connection interval (7.5-15 ms) so audio+IMU telemetry streams
    // without the queue backing up; latency 0, 2 s supervision timeout.
    pServer->updateConnParams(connInfo.getConnHandle(), 6, 12, 0, 200);
    {
      AudioLock lock;
      // Start this connection's ADPCM stream from a known state; the dashboard
      // resets its decoder on connect to match.
      audioPcm16Count = 0;
      bleAdpcmEncoder.reset();
    }
  }
  void onDisconnect(NimBLEServer * /*server*/, NimBLEConnInfo & /*connInfo*/, int /*reason*/) override {
    performSafeBleDisconnect();
  }
};

CommandCallbacks commandCallbacks;
DataCallbacks dataCallbacks;
ServerCallbacks serverCallbacks;

void beginBle() {
  NimBLEDevice::init(DEVICE_NAME);
  NimBLEDevice::setMTU(247);
  NimBLEServer *server = NimBLEDevice::createServer();
  server->setCallbacks(&serverCallbacks);
  server->advertiseOnDisconnect(true);
  NimBLEService *service = server->createService(SERVICE_UUID);
  dataCharacteristic = service->createCharacteristic(DATA_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  NimBLECharacteristic *commandCharacteristic = service->createCharacteristic(
    COMMAND_UUID, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR
  );
  dataCharacteristic->setCallbacks(&dataCallbacks);
  commandCharacteristic->setCallbacks(&commandCallbacks);
  dataCharacteristic->setValue("PAL V2 ready");
  server->start();

  NimBLEAdvertising *advertising = NimBLEDevice::getAdvertising();
  advertising->addServiceUUID(SERVICE_UUID);
  advertising->setName(DEVICE_NAME);
  advertising->enableScanResponse(true);
  advertising->start();
}

void beginMicrophone() {
  i2s_config_t config = {};
  config.mode = static_cast<i2s_mode_t>(I2S_MODE_MASTER | I2S_MODE_RX);
  config.sample_rate = MIC_SAMPLE_RATE;
  config.bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT;
  config.channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT;
  config.communication_format = static_cast<i2s_comm_format_t>(I2S_COMM_FORMAT_STAND_I2S);
  config.intr_alloc_flags = ESP_INTR_FLAG_LEVEL1;
  config.dma_buf_count = 8;
  config.dma_buf_len = 256; // ~128 ms of buffering so packet-send stalls don't overflow
  config.use_apll = true;   // APLL gives an accurate 16 kHz sample clock so recorded
                            // audio duration matches playback (avoids ~4% drift)

  i2s_pin_config_t pins = {};
  pins.bck_io_num = MIC_BCLK;
  pins.ws_io_num = MIC_LRCL;
  pins.data_out_num = I2S_PIN_NO_CHANGE;
  pins.data_in_num = MIC_DOUT;

  micReady = i2s_driver_install(microphonePort, &config, 0, nullptr) == ESP_OK &&
             i2s_set_pin(microphonePort, &pins) == ESP_OK &&
             i2s_start(microphonePort) == ESP_OK;
  if (!micReady) {
    i2s_driver_uninstall(microphonePort);
  }
}

void readMicrophone() {
  if (!micReady) return;

  // Drain the I2S DMA fully each cycle. A single bounded read cannot keep pace with
  // the 16 kHz stream and drops samples, which time/pitch-shifts recorded audio.
  for (;;) {
    int32_t frames[256]; // 128 stereo frames per read
    size_t bytesRead = 0;
    if (i2s_read(microphonePort, frames, sizeof(frames), &bytesRead, 0) != ESP_OK) return;
    const size_t words = bytesRead / sizeof(int32_t);
    if (words < 2) return;

    // ICS43434 drives only its SEL-selected slot; pick the active slot once per block
    // (not per frame) so quiet passages don't flip into the silent slot and add noise.
    int64_t leftEnergy = 0, rightEnergy = 0;
    for (size_t i = 0; i + 1 < words; i += 2) {
      leftEnergy += frames[i] < 0 ? -static_cast<int64_t>(frames[i]) : frames[i];
      rightEnergy += frames[i + 1] < 0 ? -static_cast<int64_t>(frames[i + 1]) : frames[i + 1];
    }
    const size_t slot = leftEnergy >= rightEnergy ? 0 : 1;

    double sumSq = 0.0;
    uint32_t count = 0;
    int16_t pcmBuf[128];
    size_t pcmCount = 0;
    for (size_t i = 0; i + 1 < words; i += 2) {
      const int32_t raw = frames[i + slot];
      const double normalized = static_cast<double>(raw) / 2147483648.0;
      sumSq += normalized * normalized;
      ++count;
      if (pcmCount < 128) {
        // Quantize 32-bit left-justified I2S PCM to 16-bit signed PCM
        pcmBuf[pcmCount++] = static_cast<int16_t>(constrain(raw >> 16, -32768, 32767));
      }
    }

    {
      AudioLock lock;
      audioSquareSum += sumSq;
      audioSampleCount += count;
      if (audioStreaming) {
        for (size_t i = 0; i < pcmCount && audioPcm16Count < AUDIO_PCM16_BUFFER_SIZE; ++i) {
          audioPcm16Samples[audioPcm16Count++] = pcmBuf[i];
        }
      }
    }

    if (bytesRead < sizeof(frames)) return; // DMA drained for now
  }
}

void configureImuFifo() {
  if (!imuReady) return;
  I2CLock lock;
  // FIFO_CTRL3 (0x09): BDR_GY[3:0] = 0x04 (104 Hz), BDR_XL[3:0] = 0x04 (104 Hz) -> 0x44
  Wire.beginTransmission(LSM6DS_I2CADDR_DEFAULT);
  Wire.write(0x09);
  Wire.write(0x44);
  Wire.endTransmission();

  // FIFO_CTRL4 (0x0A): FIFO_MODE[2:0] = 0x03 (Continuous Mode)
  Wire.beginTransmission(LSM6DS_I2CADDR_DEFAULT);
  Wire.write(0x0A);
  Wire.write(0x03);
  Wire.endTransmission();
}

void readImuFifoBurst() {
  if (!imuReady) return;

  I2CLock lock;
  Wire.beginTransmission(LSM6DS_I2CADDR_DEFAULT);
  Wire.write(0x3A); // FIFO_STATUS1
  if (Wire.endTransmission() != 0) return;

  Wire.requestFrom(static_cast<uint8_t>(LSM6DS_I2CADDR_DEFAULT), static_cast<uint8_t>(2));
  if (Wire.available() < 2) return;
  const uint8_t lsb = Wire.read();
  const uint8_t msb = Wire.read();
  uint16_t numWords = lsb | ((msb & 0x07) << 8);

  if (numWords == 0) return;
  if (numWords > 32) numWords = 32;

  static float lastAx = 0.0f, lastAy = 0.0f, lastAz = 0.0f;
  static float lastGx = 0.0f, lastGy = 0.0f, lastGz = 0.0f;

  uint16_t wordsRemaining = numWords;
  while (wordsRemaining > 0) {
    uint16_t chunkWords = (wordsRemaining > 18) ? 18 : wordsRemaining;
    uint8_t bytesToRead = chunkWords * 7;

    Wire.beginTransmission(LSM6DS_I2CADDR_DEFAULT);
    Wire.write(0x78); // FIFO_DATA_OUT_TAG
    if (Wire.endTransmission() != 0) break;

    Wire.requestFrom(static_cast<uint8_t>(LSM6DS_I2CADDR_DEFAULT), bytesToRead);
    if (Wire.available() < bytesToRead) break;

    for (uint16_t i = 0; i < chunkWords; ++i) {
      uint8_t rawBytes[7];
      for (int b = 0; b < 7; ++b) {
        rawBytes[b] = Wire.read();
      }

      const uint8_t tag = rawBytes[0] >> 3;
      const int16_t rawX = static_cast<int16_t>(rawBytes[1] | (rawBytes[2] << 8));
      const int16_t rawY = static_cast<int16_t>(rawBytes[3] | (rawBytes[4] << 8));
      const int16_t rawZ = static_cast<int16_t>(rawBytes[5] | (rawBytes[6] << 8));

      if (tag == 0x02) { // Accel tag
        constexpr float ACCEL_SCALE_MS2 = 0.122f * 9.80665f / 1000.0f;
        lastAx = static_cast<float>(rawX) * ACCEL_SCALE_MS2;
        lastAy = static_cast<float>(rawY) * ACCEL_SCALE_MS2;
        lastAz = static_cast<float>(rawZ) * ACCEL_SCALE_MS2;
      } else if (tag == 0x01) { // Gyro tag
        constexpr float GYRO_SCALE_RADS = 17.50f * (3.14159265f / 180.0f) / 1000.0f;
        lastGx = static_cast<float>(rawX) * GYRO_SCALE_RADS;
        lastGy = static_cast<float>(rawY) * GYRO_SCALE_RADS;
        lastGz = static_cast<float>(rawZ) * GYRO_SCALE_RADS;

        if (imuCount < sizeof(imuSamples) / sizeof(imuSamples[0])) {
          ImuSample &sample = imuSamples[imuCount++];
          sample.offsetMs = millis() - lastPacketMs;
          sample.ax = lastAx;
          sample.ay = lastAy;
          sample.az = lastAz;
          sample.gx = lastGx;
          sample.gy = lastGy;
          sample.gz = lastGz;
        }
      }
    }
    wordsRemaining -= chunkWords;
  }
}

void sendTelemetryPacket() {
  const uint32_t elapsedMs = millis() - lastPacketMs;
  const uint64_t audioTime = nowUnixMs();
  const uint64_t packetTime = audioTime - elapsedMs;

  double currentAudioSquareSum = 0.0;
  uint32_t currentAudioSampleCount = 0;
  int16_t currentAudioPcm16Samples[AUDIO_PCM16_BUFFER_SIZE];
  size_t currentAudioPcm16Count = 0;
  bool currentAudioStreaming = false;

  {
    AudioLock lock;
    currentAudioSquareSum = audioSquareSum;
    currentAudioSampleCount = audioSampleCount;
    currentAudioPcm16Count = audioPcm16Count;
    currentAudioStreaming = audioStreaming;
    if (audioPcm16Count > 0) {
      memcpy(currentAudioPcm16Samples, audioPcm16Samples, audioPcm16Count * sizeof(int16_t));
    }
    audioSquareSum = 0.0;
    audioSampleCount = 0;
    audioPcm16Count = 0;
  }

  String packet = "{\"type\":\"telemetry\",\"time_ms\":" + String(packetTime) + ",\"imu\":[";
  packet.reserve(currentAudioStreaming ? 2400 : 1200);
  for (size_t i = 0; i < imuCount; ++i) {
    const ImuSample &s = imuSamples[i];
    if (i) packet += ',';
    packet += "[" + String(s.offsetMs) + ',' + String(s.ax, 4) + ',' + String(s.ay, 4) + ',' +
              String(s.az, 4) + ',' + String(s.gx, 4) + ',' + String(s.gy, 4) + ',' + String(s.gz, 4) + "]";
  }

  constexpr double DBFS_FLOOR = -120.0;
  double audioDbfs = DBFS_FLOOR;
  if (currentAudioSampleCount > 0 && currentAudioSquareSum > 0.0) {
    const double rms = sqrt(currentAudioSquareSum / currentAudioSampleCount);
    audioDbfs = max(DBFS_FLOOR, 20.0 * log10(rms));
  }
  packet += "],\"audio_time_ms\":" + String(audioTime) +
            ",\"audio_samples\":" + String(currentAudioSampleCount) +
            ",\"audio_dbfs\":" + String(audioDbfs, 2);
  if (currentAudioStreaming) {
    // Both links carry 4-bit IMA-ADPCM (4:1 compression) so audio fits the serial and
    // BLE bandwidth without dropping samples. Each 100 ms block is self-contained: a
    // 4-byte header seeds the decoder with the exact first sample so blocks stay
    // drop-tolerant without a click at every boundary, and no connect-time handshake
    // is needed on the USB link.
    if (!bleSubscribed) {
      // USB Serial (Wired): full 16 kHz IMA-ADPCM (audio_adpcm_b64)
      uint8_t adpcmBuf[AUDIO_PCM16_BUFFER_SIZE / 2 + 8];
      const size_t adpcmBytes = bleAdpcmEncoder.encodeBlockSelfContained(currentAudioPcm16Samples, currentAudioPcm16Count, adpcmBuf);
      packet += ",\"audio_rate_hz\":" + String(AUDIO_PLAYBACK_RATE_USB) +
                ",\"audio_adpcm_b64\":\"" +
                encodeBase64(adpcmBuf, adpcmBytes) + "\"";
    } else {
      // BLE Wireless: 8 kHz IMA-ADPCM (downsample 16 kHz -> 8 kHz by taking every 2nd sample)
      int16_t pcm8k[AUDIO_PCM16_BUFFER_SIZE / 2];
      size_t count8k = 0;
      for (size_t i = 0; i < currentAudioPcm16Count; i += 2) {
        pcm8k[count8k++] = currentAudioPcm16Samples[i];
      }
      uint8_t adpcmBuf[AUDIO_PCM16_BUFFER_SIZE / 4 + 8];
      const size_t adpcmBytes = bleAdpcmEncoder.encodeBlockSelfContained(pcm8k, count8k, adpcmBuf);
      packet += ",\"audio_rate_hz\":" + String(AUDIO_PLAYBACK_RATE_BLE) +
                ",\"audio_adpcm_b64\":\"" +
                encodeBase64(adpcmBuf, adpcmBytes) + "\"";
    }
  }
  packet += '}';
  enqueueTelemetry(packet);
  imuCount = 0;
}

void sendEnvironment() {
  bool bmeSuccess = false;
  float tempC = 0.0f, humPct = 0.0f, pressPa = 0.0f;
  uint32_t gasOhms = 0;
  {
    I2CLock lock;
    if (bme.endReading()) {
      bmeSuccess = true;
      tempC = bme.temperature;
      humPct = bme.humidity;
      pressPa = bme.pressure;
      gasOhms = bme.gas_resistance;
    }
  }
  if (!bmeSuccess) {
    sendStatus("sensor_error", "BME688 read failed");
    return;
  }
  const float vBat = readBatteryVoltage();
  const uint8_t pctBat = calculateBatteryPercentage(vBat);
  const IaqResult iaqRes = calculateIaqScore(tempC, humPct, gasOhms);
  String packet = "{\"type\":\"environment\",\"time_ms\":" + String(nowUnixMs()) +
                  ",\"temperature_c\":" + String(tempC, 2) +
                  ",\"humidity_pct\":" + String(humPct, 2) +
                  ",\"pressure_hpa\":" + String(pressPa / 100.0F, 2) +
                  ",\"gas_ohms\":" + String(gasOhms) +
                  ",\"iaq\":" + String(iaqRes.iaq, 1) +
                  ",\"voc_ppm\":" + String(iaqRes.vocPpm, 2) +
                  ",\"eco2_ppm\":" + String(iaqRes.eco2Ppm, 1) +
                  ",\"battery_v\":" + String(vBat, 2) +
                  ",\"battery_pct\":" + String(pctBat) + "}";
  enqueueTelemetry(packet);
}

void startEnvironmentReading() {
  if (!bmeReady || bmeReading) return;
  I2CLock lock;
  const uint32_t readyAt = bme.beginReading();
  if (readyAt == 0) {
    sendStatus("sensor_error", "BME688 start failed");
    return;
  }
  bmeReadyAtMs = readyAt;
  bmeReading = true;
}

void readSerialCommands() {
  static String input;
  static bool discarding = false;
  while (Serial.available()) {
    const char c = static_cast<char>(Serial.read());
    if (c == '\n' || c == '\r') {
      if (discarding) {
        sendStatus("command_error", "Serial command exceeded 256 bytes");
      } else if (!input.isEmpty()) {
        if (commandQueue != nullptr) {
          CommandMessage message = {};
          strncpy(message.text, input.c_str(), sizeof(message.text) - 1);
          xQueueSend(commandQueue, &message, 0);
        }
      }
      input = "";
      discarding = false;
    } else if (input.length() < 256) {
      input += c;
    } else {
      discarding = true;
    }
  }
}

void readBleCommands() {
  if (commandQueue == nullptr) return;
  CommandMessage message;
  while (xQueueReceive(commandQueue, &message, 0) == pdTRUE) {
    if (strcmp(message.text, "command_too_long") == 0) {
      sendStatus("command_error", "BLE command exceeded 256 bytes");
    } else {
      handleCommand(String(message.text));
    }
  }
}

void telemetry_net_task(void *pvParameters) {
  (void)pvParameters;
  for (;;) {
    readSerialCommands();
    readMicrophone();

    char *msg = nullptr;
    while (telemetryQueue != nullptr && xQueueReceive(telemetryQueue, &msg, 0) == pdTRUE) {
      if (msg != nullptr) {
        sendLine(String(msg));
        free(msg);
      }
    }

    checkBleSafetyTimeout();

    vTaskDelay(pdMS_TO_TICKS(5));
  }
}

void sensor_app_task(void *pvParameters) {
  (void)pvParameters;
  for (;;) {
    readBleCommands();

    const uint32_t now = millis();
    if (now - lastImuMs >= IMU_INTERVAL_MS) {
      lastImuMs = now;
      readImuFifoBurst();
    }
    if (now - lastPacketMs >= PACKET_INTERVAL_MS) {
      sendTelemetryPacket();
      lastPacketMs = now;
    }
    if (bmeReading && static_cast<int32_t>(now - bmeReadyAtMs) >= 0) {
      sendEnvironment();
      bmeReading = false;
    }
    if (now - lastEnvMs >= ENV_INTERVAL_MS) {
      lastEnvMs = now;
      startEnvironmentReading();
    }
    if (now - lastLedUpdateMs >= 250) {
      lastLedUpdateMs = now;
      updateNeoPixelStatus();
    }

    vTaskDelay(pdMS_TO_TICKS(5));
  }
}

void setup() {
  // Audio is sent compressed as 4-bit IMA-ADPCM (4:1), so ~16 kHz voice fits well
  // within 230400 baud (~23 KB/s). 230400 is a standard rate the macOS CP210x driver
  // and Chrome Web Serial handle reliably (higher custom rates like 921600 are
  // driver-flaky on macOS and corrupt the stream).
  Serial.begin(230400);
  delay(300);

  i2cMutex = xSemaphoreCreateMutex();
  audioMutex = xSemaphoreCreateMutex();
  telemetryQueue = xQueueCreate(16, sizeof(char *));
  commandQueue = xQueueCreate(8, sizeof(CommandMessage));

  pinMode(STATUS_NEOPIXEL_POWER_PIN, OUTPUT);
  digitalWrite(STATUS_NEOPIXEL_POWER_PIN, HIGH);
  pixel.begin();
  pixel.setBrightness(20);

  // Onboard NeoPixel RGB Boot Self-Test (Red -> Green -> Blue -> Yellow -> Cyan -> Magenta -> White -> Off)
  const uint32_t bootColors[] = {
    pixel.Color(255, 0, 0),     // Red
    pixel.Color(0, 255, 0),     // Green
    pixel.Color(0, 0, 255),     // Blue
    pixel.Color(255, 255, 0),   // Yellow
    pixel.Color(0, 255, 255),   // Cyan
    pixel.Color(255, 0, 255),   // Magenta
    pixel.Color(255, 255, 255), // White
    pixel.Color(0, 0, 0)        // Off
  };
  for (size_t i = 0; i < sizeof(bootColors) / sizeof(bootColors[0]); ++i) {
    pixel.setPixelColor(0, bootColors[i]);
    pixel.show();
    delay(150);
  }

  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);
  Wire.begin(); // STEMMA QT uses SDA=GPIO22 and SCL=GPIO20 on this Feather.
  Wire.setClock(400000); // Enable I2C Fast Mode (400 kHz)

  {
    I2CLock lock;
    rtcReady = rtc.begin();
    if (rtcReady) {
      rtcNeedsSync = rtc.lostPower();
      if (rtcNeedsSync) rtc.adjust(DateTime(F(__DATE__), F(__TIME__)));
      DateTime now = rtc.now();
      clockBaseMs = static_cast<uint64_t>(now.unixtime()) * 1000ULL;
      clockBaseMillis = millis();
    } else {
      clockBaseMs = 0;
      clockBaseMillis = millis();
    }

    bmeReady = bme.begin(0x77) || bme.begin(0x76);
    if (bmeReady) {
      bme.setTemperatureOversampling(BME680_OS_8X);
      bme.setHumidityOversampling(BME680_OS_2X);
      bme.setPressureOversampling(BME680_OS_4X);
      bme.setIIRFilterSize(BME680_FILTER_SIZE_3);
      bme.setGasHeater(320, 150);
    }

    imuReady = lsm6dsox.begin_I2C();
    if (imuReady) {
      lsm6dsox.setAccelRange(LSM6DS_ACCEL_RANGE_4_G);
      lsm6dsox.setGyroRange(LSM6DS_GYRO_RANGE_500_DPS);
      lsm6dsox.setAccelDataRate(LSM6DS_RATE_104_HZ);
      lsm6dsox.setGyroDataRate(LSM6DS_RATE_104_HZ);

      Wire.beginTransmission(LSM6DS_I2CADDR_DEFAULT);
      Wire.write(0x09);
      Wire.write(0x44);
      Wire.endTransmission();

      Wire.beginTransmission(LSM6DS_I2CADDR_DEFAULT);
      Wire.write(0x0A);
      Wire.write(0x03);
      Wire.endTransmission();
    }
  }

  beginMicrophone();
  beginBle();

  lastPacketMs = millis();
  lastImuMs = lastPacketMs;
  lastEnvMs = millis();
  startEnvironmentReading();

  sendStatus("ready", "JSON Lines over USB serial and BLE notifications");
  if (!rtcReady) sendStatus("sensor_error", "DS3231 not found");
  if (rtcNeedsSync) sendStatus("clock_warning", "RTC lost power; synchronize it from the dashboard");
  if (!imuReady) sendStatus("sensor_error", "LSM6DSOX not found");
  if (!bmeReady) sendStatus("sensor_error", "BME688 not found");
  if (!micReady) sendStatus("sensor_error", "ICS43434 I2S setup failed");

  xTaskCreatePinnedToCore(
    telemetry_net_task,
    "telemetry_net",
    12288,
    nullptr,
    2,
    nullptr,
    0
  );

  xTaskCreatePinnedToCore(
    sensor_app_task,
    "sensor_app",
    12288,
    nullptr,
    2,
    nullptr,
    1
  );
}

void loop() {
  vTaskDelete(nullptr);
}