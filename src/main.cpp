#include <Arduino.h>
#include <Wire.h>
#include <RTClib.h>
#include <Adafruit_BME680.h>
#include <Adafruit_LSM6DSOX.h>
#include <Adafruit_NeoPixel.h>
#include <NimBLEDevice.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <WebSocketsServer.h>
#include <driver/i2s.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>
#include <ctype.h>
#include <errno.h>
#include <math.h>
#include <esp_timer.h>
#include <cJSON.h>
#include "ima_adpcm.h"
#include "ble_packet.h"

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

constexpr uint32_t IMU_INTERVAL_MS = 10;       // 100 Hz sensor acquisition
constexpr uint32_t PACKET_INTERVAL_MS = 100;   // ten samples per telemetry packet
constexpr uint32_t ENV_INTERVAL_MS = 1000;
constexpr size_t AUDIO_FRAME_SAMPLES = MIC_SAMPLE_RATE / 10; // fixed 100 ms frames

constexpr size_t BLE_MAX_CHUNK_BYTES = 244;   // matches negotiated MTU 247 (MTU - 3) to minimise notifies per packet

String deviceId, deviceName, deviceHostname;
static const char *SERVICE_UUID = "7f510001-5b8d-4a84-9c7c-a07142ab6002";
static const char *DATA_UUID = "7f510002-5b8d-4a84-9c7c-a07142ab6002";
static const char *COMMAND_UUID = "7f510003-5b8d-4a84-9c7c-a07142ab6002";

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
uint32_t lastImuMs = 0;
uint32_t lastPacketMs = 0;
uint32_t lastEnvMs = 0;
uint32_t lastLedUpdateMs = 0;
volatile uint32_t lastBleActivityMs = 0;
uint32_t bmeReadyAtMs = 0;
bool bmeReading = false;
// Audio capture never waits for Serial, BLE, Wi-Fi, JSON serialization or sensors.
struct AudioFrame {
  int16_t pcm[AUDIO_FRAME_SAMPLES];
  uint64_t sampleIndex;
  int64_t monotonicUs;
  uint32_t sequence, segment, droppedFrames, dmaOverruns;
  uint8_t slot;
};
QueueHandle_t audioQueue = nullptr;
QueueHandle_t i2sEvents = nullptr;
uint32_t streamId = 0;
portMUX_TYPE clockMux = portMUX_INITIALIZER_UNLOCKED;
int64_t clockAnchorUs = 0;

// Sensor and status lines have the same representation on all transports.
struct OutgoingLine { char *text; };

struct CommandMessage {
  char text[769];
};

QueueHandle_t commandQueue = nullptr;
QueueHandle_t telemetryQueue = nullptr;
QueueHandle_t statusQueue = nullptr;
SemaphoreHandle_t i2cMutex = nullptr;


bool batterySaveMode = false;

// ---- Wi-Fi high-fidelity transport (exclusive wireless transport while active) ----
enum WifiCmd { WIFI_CMD_ON, WIFI_CMD_OFF, WIFI_CMD_STATUS };
enum WifiLinkState { WIFI_LINK_OFF = 0, WIFI_LINK_CONNECTING, WIFI_LINK_ONLINE };
struct WifiRequest { WifiCmd command; char ssid[33]; char password[64]; };
QueueHandle_t wifiQueue = nullptr;
volatile int wifiState = WIFI_LINK_OFF;
volatile bool wifiActive = false;
volatile bool wifiClientConnected = false;
volatile bool bleSuspended = false;
char wifiIp[16] = {0};
uint32_t wifiConnectStartMs = 0, lastWifiAnnouncement = 0;
constexpr uint32_t WIFI_CONNECT_TIMEOUT_MS = 20000;
WebSocketsServer wsServer(81);

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
  const uint16_t handle = bleConnectionHandle;
  bleConnectionHandle = BLE_HS_CONN_HANDLE_NONE;

  NimBLEServer *server = NimBLEDevice::getServer();
  if (server != nullptr && handle != BLE_HS_CONN_HANDLE_NONE && server->getConnectedCount() > 0) {
    server->disconnect(handle);
  }

  NimBLEAdvertising *adv = NimBLEDevice::getAdvertising();
  if (adv != nullptr && !adv->isAdvertising() && !bleSuspended) {
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
    if (adv != nullptr && !adv->isAdvertising() && !bleSuspended) {
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

  if (wifiClientConnected) {
    r = 0; g = 255; b = 255; // cyan: Wi-Fi high-fidelity streaming active
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

uint64_t unixMsAt(int64_t monotonicUs) {
  portENTER_CRITICAL(&clockMux);
  const int64_t value = static_cast<int64_t>(clockBaseMs) + (monotonicUs - clockAnchorUs) / 1000;
  portEXIT_CRITICAL(&clockMux);
  return value > 0 ? value : 0;
}
uint64_t nowUnixMs() { return unixMsAt(esp_timer_get_time()); }

void sendBleFrame(uint8_t kind, const uint8_t *payload, size_t payloadLength) {
  if (dataCharacteristic == nullptr || !bleSubscribed) {
    return;
  }
  if (payloadLength > 2048) return;
  uint8_t wire[2060] = {'P', 'A', 'L', 2, kind, 0};
  palWriteLE(wire + 6, payloadLength, 2);
  palWriteLE(wire + 8, palCrc32(payload, payloadLength), 4);
  memcpy(wire + 12, payload, payloadLength);
  const size_t wireLength = payloadLength + 12;

  const size_t chunkBytes = bleChunkBytes;
  const uint16_t connectionHandle = bleConnectionHandle;

  // Retry each notify briefly: a false return is controller tx congestion, not a lost
  // link, and yielding lets the buffers drain over a connection interval or two.
  auto notifyWithRetry = [&](const uint8_t *data, size_t length) -> bool {
    // macOS connection intervals can exceed 12 ms. Wait through several radio
    // events before abandoning a line when the controller's TX queue is full.
    for (int attempt = 0; attempt < 100; ++attempt) {
      if (!bleSubscribed || bleConnectionHandle != connectionHandle) return false;
      if (dataCharacteristic->notify(data, length, connectionHandle)) {
        lastBleActivityMs = millis();
        return true;
      }
      vTaskDelay(pdMS_TO_TICKS(2));
    }
    return false;
  };

  for (size_t start = 0; start < wireLength; start += chunkBytes) {
    const size_t length = min(chunkBytes, wireLength - start);
    if (!notifyWithRetry(wire + start, length)) {
      break;
    }
  }
}

void sendBleLine(const String &line) {
  // Binary IMU samples and audio avoid JSON/base64 overhead on the radio. Other
  // messages retain JSON inside the same length-delimited, CRC-protected framing.
  if (line.startsWith("{\"type\":\"telemetry\"")) {
    cJSON *root = cJSON_Parse(line.c_str());
    if (!root) return;
    const cJSON *rows = cJSON_GetObjectItemCaseSensitive(root, "imu");
    const cJSON *time = cJSON_GetObjectItemCaseSensitive(root, "time_ms");
    const int count = cJSON_GetArraySize(rows);
    if (count <= 16 && cJSON_IsNumber(time)) {
      uint8_t payload[15 + 16 * 14] = {};
      palWriteLE(payload, ESP.getEfuseMac(), 6);
      palWriteLE(payload + 6, static_cast<uint64_t>(time->valuedouble), 8);
      payload[14] = count;
      bool fits = true;
      for (int i = 0; i < count; ++i) {
        const cJSON *row = cJSON_GetArrayItem(rows, i);
        uint8_t *sample = payload + 15 + i * 14;
        const uint32_t offset = cJSON_GetArrayItem(row, 0)->valuedouble;
        if (offset > 65535) { fits = false; break; }
        palWriteLE(sample, offset, 2);
        for (int axis = 0; axis < 6; ++axis) {
          // Recover the sensor's native signed 16-bit counts. JSON's four-decimal
          // rounding is less than half a sensor LSB for both configured ranges.
          const double scale = axis < 3 ? 0.122 * 9.80665 / 1000.0 : 17.50 * (3.14159265 / 180.0) / 1000.0;
          const int32_t raw = lround(cJSON_GetArrayItem(row, axis + 1)->valuedouble / scale);
          palWriteLE(sample + 2 + axis * 2, static_cast<uint16_t>(static_cast<int16_t>(constrain(raw, -32768, 32767))), 2);
        }
      }
      if (fits) sendBleFrame(2, payload, 15 + count * 14);
      else sendBleFrame(0, reinterpret_cast<const uint8_t *>(line.c_str()), line.length());
    }
    cJSON_Delete(root);
  } else sendBleFrame(0, reinterpret_cast<const uint8_t *>(line.c_str()), line.length());
}

String identityFields() {
  return ",\"device_id\":\"" + deviceId + "\",\"device_name\":\"" + deviceName + "\",\"hostname\":\"" + deviceHostname + ".local\"";
}
String sampleIdentityFields() { return ",\"device_id\":\"" + deviceId + "\""; }

void enqueueTelemetry(const String &line, bool priority = false) {
  if (telemetryQueue == nullptr) return;
  String identified = line;
  if (identified.endsWith("}")) {
    const bool samples = line.startsWith("{\"type\":\"telemetry\"") || line.startsWith("{\"type\":\"environment\"");
    identified.remove(identified.length() - 1);
    identified += (samples ? sampleIdentityFields() : identityFields()) + "}";
  }
  OutgoingLine item = {strdup(identified.c_str())};
  if (item.text == nullptr) return;
  if (xQueueSend(priority ? statusQueue : telemetryQueue, &item, 0) != pdTRUE) {
    free(item.text);
  }
}

void sendStatus(const char *state, const char *detail) {
  String message = "{\"type\":\"status\",\"time_ms\":" + String(nowUnixMs()) +
                   ",\"state\":\"" + state + "\",\"detail\":\"" + detail + "\"}";
  enqueueTelemetry(message, true);
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
  portENTER_CRITICAL(&clockMux);
  clockBaseMs = unixMs;
  clockAnchorUs = esp_timer_get_time();
  portEXIT_CRITICAL(&clockMux);
  rtcNeedsSync = false;
  sendStatus("clock_set", "RTC updated from dashboard (UTC)");
}

void handleCommand(String command) {
  cJSON *root = cJSON_Parse(command.c_str());
  if (!root) { sendStatus("command_error", "Invalid JSON command"); return; }
  const cJSON *cmdItem = cJSON_GetObjectItemCaseSensitive(root, "cmd");
  const char *cmd = cJSON_IsString(cmdItem) ? cmdItem->valuestring : "";
  if (!strcmp(cmd, "wifi_on") || !strcmp(cmd, "wifi_off") || !strcmp(cmd, "wifi_status")) {
    WifiRequest req = {};
    req.command = !strcmp(cmd, "wifi_on") ? WIFI_CMD_ON : !strcmp(cmd, "wifi_off") ? WIFI_CMD_OFF : WIFI_CMD_STATUS;
    bool valid = true;
    if (req.command == WIFI_CMD_ON) {
      const cJSON *ssid = cJSON_GetObjectItemCaseSensitive(root, "ssid");
      const cJSON *pass = cJSON_GetObjectItemCaseSensitive(root, "password");
      valid = cJSON_IsString(ssid) && strlen(ssid->valuestring) > 0 && strlen(ssid->valuestring) <= 32 &&
              cJSON_IsString(pass) && (strlen(pass->valuestring) == 0 || (strlen(pass->valuestring) >= 8 && strlen(pass->valuestring) <= 63));
      if (valid) {
        strcpy(req.ssid, ssid->valuestring);
        strcpy(req.password, pass->valuestring);
      }
    }
    if (!valid) sendStatus("command_error", "SSID must be 1-32 bytes; password must be empty or 8-63 bytes");
    else if (xQueueSend(wifiQueue, &req, 0) != pdTRUE) sendStatus("command_error", "Wi-Fi request queue busy; retry");
    memset(&req, 0, sizeof(req));
  } else if (!strcmp(cmd, "set_time")) {
    const cJSON *time = cJSON_GetObjectItemCaseSensitive(root, "unix_ms");
    if (cJSON_IsNumber(time) && time->valuedouble >= 1577836800000.0 && time->valuedouble < 4102444800000.0)
      setRtcFromUnixMs(static_cast<uint64_t>(time->valuedouble));
    else sendStatus("command_error", "Invalid unix_ms");
  } else if (!strcmp(cmd, "disconnect_ble")) {
    performSafeBleDisconnect();
  } else if (!strcmp(cmd, "battery_save") || !strcmp(cmd, "toggle_battery_save")) {
    batterySaveMode = !batterySaveMode;
    sendStatus("battery_save", batterySaveMode ? "Enabled" : "Disabled");
  } else if (!strcmp(cmd, "start_audio") || !strcmp(cmd, "stop_audio")) {
    sendStatus("audio_streaming", "Audio streams continuously; recording is controlled by the dashboard");
  } else sendStatus("command_error", "Unknown command");
  cJSON_Delete(root);
}

// Reassemble newline-delimited commands across 20-byte BLE writes (minimum ATT MTU).
class CommandCallbacks : public NimBLECharacteristicCallbacks {
  CommandMessage pending = {};
  size_t used = 0;
  bool overflow = false;
  uint32_t lastWrite = 0;
public:
  void reset() { used = 0; overflow = false; memset(&pending, 0, sizeof(pending)); }
  void onRead(NimBLECharacteristic *characteristic, NimBLEConnInfo &) override {
    characteristic->setValue("PAL commands v2");
  }
  void onWrite(NimBLECharacteristic *characteristic, NimBLEConnInfo &) override {
    if (millis() - lastWrite > 5000) reset();
    lastWrite = lastBleActivityMs = millis();
    const NimBLEAttValue value = characteristic->getValue();
    // Never retain a credential fragment as the characteristic's readable value.
    characteristic->setValue("PAL commands v2");
    for (size_t i = 0; i < value.length(); ++i) {
      const char c = value.data()[i];
      if (c == '\n') {
        if (overflow) sendStatus("command_error", "Command exceeds 768 bytes");
        else if (used && xQueueSend(commandQueue, &pending, 0) != pdTRUE)
          sendStatus("command_error", "Command queue busy; retry");
        reset();
      } else if (used < sizeof(pending.text) - 1) pending.text[used++] = c;
      else overflow = true;
    }
  }
};
CommandCallbacks commandCallbacks;

class DataCallbacks : public NimBLECharacteristicCallbacks {
  void onSubscribe(NimBLECharacteristic * /*characteristic*/, NimBLEConnInfo &connInfo, uint16_t subValue) override {
    lastBleActivityMs = millis();
    bleSubscribed = subValue != 0;
    if (bleSubscribed) {
      bleConnectionHandle = connInfo.getConnHandle();
      bleChunkBytes = min(BLE_MAX_CHUNK_BYTES, static_cast<size_t>(max(23, static_cast<int>(connInfo.getMTU())) - 3));
      enqueueTelemetry("{\"type\":\"device\"}", true);
    }
  }
};

class ServerCallbacks : public NimBLEServerCallbacks {
  void onMTUChange(uint16_t mtu, NimBLEConnInfo &) override {
    bleChunkBytes = min(BLE_MAX_CHUNK_BYTES, static_cast<size_t>(max(23, static_cast<int>(mtu)) - 3));
  }
  void onAuthenticationComplete(NimBLEConnInfo &connInfo) override {
    sendStatus("ble_security", connInfo.isEncrypted() ? "Bluetooth link encrypted" : "Bluetooth encryption failed; reconnect");
  }
  void onConnect(NimBLEServer *pServer, NimBLEConnInfo &connInfo) override {
    lastBleActivityMs = millis();
    bleConnectionHandle = connInfo.getConnHandle();
    // Request a short interval; the central selects the final radio parameters.
    pServer->updateConnParams(connInfo.getConnHandle(), 6, 12, 0, 200);
    pServer->setDataLen(connInfo.getConnHandle(), 251);
    commandCallbacks.reset();
    NimBLEDevice::startSecurity(connInfo.getConnHandle());
  }
  void onDisconnect(NimBLEServer * /*server*/, NimBLEConnInfo & /*connInfo*/, int /*reason*/) override {
    performSafeBleDisconnect();
  }
};

DataCallbacks dataCallbacks;
ServerCallbacks serverCallbacks;

void beginBle() {
  NimBLEDevice::init(deviceName.c_str());
  // The v2 GATT permissions require a fresh bond. Migrate once so pre-upgrade
  // pairing records cannot strand macOS clients at an encrypted read/write.
  Preferences pairing;
  if (pairing.begin("pal-ble", false)) {
    if (pairing.getUChar("protocol", 0) != 2 && NimBLEDevice::deleteAllBonds())
      pairing.putUChar("protocol", 2);
    pairing.end();
  }
  NimBLEDevice::setMTU(247);
  NimBLEDevice::setSecurityAuth(true, false, true);
  NimBLEDevice::setSecurityIOCap(BLE_HS_IO_NO_INPUT_OUTPUT);
  NimBLEServer *server = NimBLEDevice::createServer();
  server->setCallbacks(&serverCallbacks);
  server->advertiseOnDisconnect(false);
  NimBLEService *service = server->createService(SERVICE_UUID);
  dataCharacteristic = service->createCharacteristic(DATA_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  NimBLECharacteristic *commandCharacteristic = service->createCharacteristic(
    COMMAND_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::READ_ENC | NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_ENC
  );
  dataCharacteristic->setCallbacks(&dataCallbacks);
  commandCharacteristic->setCallbacks(&commandCallbacks);
  commandCharacteristic->setValue("PAL commands v2");
  dataCharacteristic->setValue("PAL V2 ready");
  server->start();

  NimBLEAdvertising *advertising = NimBLEDevice::getAdvertising();
  advertising->addServiceUUID(SERVICE_UUID);
  advertising->setName(deviceName.c_str());
  advertising->enableScanResponse(true);
  advertising->start();
}

void sendWsLine(const String &line) {
  if (!wifiClientConnected) return;
  String framed = line;
  framed += '\n'; // the dashboard splits the WebSocket stream on newlines
  wsServer.broadcastTXT(framed);
}

void suspendBleForWifi() {
  // Wi-Fi is the exclusive wireless transport: drop the BLE client and stop advertising
  // so all data flows over Wi-Fi. NimBLE stays initialised for a fast resume on wifi_off.
  bleSuspended = true;
  performSafeBleDisconnect();
  NimBLEAdvertising *adv = NimBLEDevice::getAdvertising();
  if (adv != nullptr && adv->isAdvertising()) {
    adv->stop();
  }
}

void resumeBle() {
  bleSuspended = false;
  NimBLEAdvertising *adv = NimBLEDevice::getAdvertising();
  if (adv != nullptr && !adv->isAdvertising()) {
    adv->start();
  }
}

void onWebSocketEvent(uint8_t num, WStype_t type, uint8_t *payload, size_t length) {
  (void)num;
  switch (type) {
    case WStype_CONNECTED:
      wifiClientConnected = true;
      enqueueTelemetry("{\"type\":\"device\"}");
      suspendBleForWifi();
      break;
    case WStype_DISCONNECTED:
      if (wsServer.connectedClients() == 0) {
        wifiClientConnected = false;
        resumeBle();
      }
      break;
    case WStype_TEXT: {
      if (commandQueue == nullptr) break;
      CommandMessage message = {};
      if (length > sizeof(message.text) - 1) {
        strncpy(message.text, "command_too_long", sizeof(message.text) - 1);
      } else {
        memcpy(message.text, payload, length);
        message.text[length] = '\0';
      }
      xQueueSend(commandQueue, &message, 0);
      break;
    }
    default:
      break;
  }
}

void beginWifiConnect(const WifiRequest &request) {
  // Keep BLE available until the browser successfully opens a Wi-Fi socket.
  WiFi.persistent(false);
  WiFi.setAutoReconnect(false);
  WiFi.mode(WIFI_STA);
  WiFi.setHostname(deviceHostname.c_str());
  WiFi.begin(request.ssid, request.password[0] ? request.password : nullptr);
  wifiConnectStartMs = millis();
  wifiState = WIFI_LINK_CONNECTING;
  wifiActive = true;
}

void announceWifi() {
  if (wifiState != WIFI_LINK_ONLINE) return;
  enqueueTelemetry("{\"type\":\"status\",\"state\":\"wifi_connected\",\"detail\":\"WebSocket ready\",\"ip\":\"" + String(wifiIp) + "\",\"port\":81}", true);
  lastWifiAnnouncement = millis();
}

void stopWifi() {
  if (wifiState != WIFI_LINK_OFF) {
    wsServer.close();
    MDNS.end();
    WiFi.disconnect(true, false);
    WiFi.mode(WIFI_OFF);
  }
  wifiActive = false;
  wifiClientConnected = false;
  wifiState = WIFI_LINK_OFF;
  wifiIp[0] = '\0';
  if (bleSuspended) {
    resumeBle();
  }
}

// Runs on Core 0 (telemetry_net_task) so every Wi-Fi/WebSocket radio call stays on one core.
void serviceWifi() {
  WifiRequest request;
  if (xQueueReceive(wifiQueue, &request, 0) == pdTRUE) {
    if (request.command == WIFI_CMD_ON) {
      stopWifi();
      beginWifiConnect(request);
      sendStatus("wifi_connecting", "Joining Wi-Fi network");
    } else if (request.command == WIFI_CMD_OFF) {
      stopWifi();
      sendStatus("wifi_off", "Wi-Fi disabled; BLE restored");
    } else if (wifiState == WIFI_LINK_ONLINE) announceWifi();
    else sendStatus("wifi_status", wifiState == WIFI_LINK_CONNECTING ? "Joining network" : "Wi-Fi is off");
    memset(&request, 0, sizeof(request));
  }

  if (wifiState == WIFI_LINK_CONNECTING) {
    const wl_status_t ws = WiFi.status();
    if (ws == WL_CONNECTED) {
      strncpy(wifiIp, WiFi.localIP().toString().c_str(), sizeof(wifiIp) - 1);
      wifiIp[sizeof(wifiIp) - 1] = '\0';
      WiFi.setSleep(false); // continuous audio benefits from low transport latency
      wsServer.onEvent(onWebSocketEvent);
      wsServer.begin();
      if (MDNS.begin(deviceHostname.c_str())) MDNS.addService("pal-telemetry", "tcp", 81);
      wifiState = WIFI_LINK_ONLINE;
      announceWifi();
    } else if (ws == WL_NO_SSID_AVAIL || ws == WL_CONNECT_FAILED ||
               millis() - wifiConnectStartMs > WIFI_CONNECT_TIMEOUT_MS) {
      const char *reason = (ws == WL_NO_SSID_AVAIL) ? "SSID not found" :
                           (ws == WL_CONNECT_FAILED) ? "wrong password or AP rejected" :
                           "connect timed out";
      stopWifi();
      sendStatus("wifi_error", reason);
    }
  }

  if (wifiState == WIFI_LINK_ONLINE) {
    wsServer.loop();
    if (!wifiClientConnected && millis() - lastWifiAnnouncement > 2000) announceWifi();
    if (WiFi.status() != WL_CONNECTED) {
      stopWifi();
      sendStatus("wifi_error", "Wi-Fi link lost; BLE restored");
    }
  }
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
  pins.mck_io_num = I2S_PIN_NO_CHANGE; // GPIO0 is the NeoPixel, not a microphone MCLK
  pins.bck_io_num = MIC_BCLK;
  pins.ws_io_num = MIC_LRCL;
  pins.data_out_num = I2S_PIN_NO_CHANGE;
  pins.data_in_num = MIC_DOUT;

  micReady = i2s_driver_install(microphonePort, &config, 32, &i2sEvents) == ESP_OK &&
             i2s_set_pin(microphonePort, &pins) == ESP_OK &&
             i2s_start(microphonePort) == ESP_OK;
  if (!micReady) {
    i2s_driver_uninstall(microphonePort);
  }
}

void microphone_task(void *) {
  AudioFrame frame = {};
  uint64_t sampleIndex = 0;
  uint32_t sequence = 0, segment = 0, dropped = 0, overruns = 0;
  size_t filled = 0;
  int slot = -1;
  int64_t anchorUs = 0;
  uint64_t anchorIndex = 0;
  // Installation occurs here, immediately before reading, so boot/BLE setup cannot
  // fill the DMA buffer before the capture task starts.
  beginMicrophone();
  if (!micReady) { sendStatus("sensor_error", "ICS43434 I2S setup failed"); vTaskDelete(nullptr); return; }
  for (;;) {
    i2s_event_t event;
    bool discontinuity = false;
    while (xQueueReceive(i2sEvents, &event, 0) == pdTRUE) {
      if (event.type == I2S_EVENT_RX_Q_OVF || event.type == I2S_EVENT_DMA_ERROR) {
        ++overruns; discontinuity = true;
      }
    }
    if (discontinuity) {
      // Unknown number of lost DMA samples: begin an explicitly new clock segment.
      filled = 0; anchorUs = 0; ++segment;
    }
    int32_t stereo[256];
    size_t bytesRead = 0;
    if (i2s_read(microphonePort, stereo, sizeof(stereo), &bytesRead, pdMS_TO_TICKS(25)) != ESP_OK) continue;
    const size_t count = bytesRead / (2 * sizeof(int32_t));
    if (!count) continue;
    if (!anchorUs) { anchorUs = esp_timer_get_time() - count * 1000000LL / MIC_SAMPLE_RATE; anchorIndex = sampleIndex; }
    if (slot < 0) {
      int64_t energy[2] = {0, 0};
      for (size_t i = 0; i < count * 2; ++i) energy[i % 2] += llabs(static_cast<int64_t>(stereo[i]));
      if (max(energy[0], energy[1]) > 0) {
        slot = energy[0] >= energy[1] ? 0 : 1;
        String diagnostics = "{\"type\":\"microphone_diagnostics\",\"slot\":" + String(slot);
        for (int ch = 0; ch < 2; ++ch) {
          double sum = 0, square = 0;
          for (size_t i = 0; i < count; ++i) { const double v = stereo[i * 2 + ch] >> 16; sum += v; square += v * v; }
          const double mean = sum / count;
          diagnostics += ",\"slot" + String(ch) + "_mean\":" + String(mean, 3) + ",\"slot" + String(ch) + "_ac_rms\":" + String(sqrt(max(0.0, square / count - mean * mean)), 3);
        }
        enqueueTelemetry(diagnostics + "}");
      }
    }
    for (size_t i = 0; i < count; ++i) {
      if (!filled) {
        frame.sampleIndex = sampleIndex;
        frame.monotonicUs = anchorUs + (sampleIndex - anchorIndex) * 1000000LL / MIC_SAMPLE_RATE;
        frame.segment = segment;
        frame.slot = slot < 0 ? 0 : slot;
      }
      frame.pcm[filled++] = static_cast<int16_t>(stereo[i * 2 + frame.slot] >> 16);
      ++sampleIndex;
      if (filled == AUDIO_FRAME_SAMPLES) {
        frame.sequence = sequence++;
        frame.droppedFrames = dropped;
        frame.dmaOverruns = overruns;
        if (xQueueSend(audioQueue, &frame, 0) != pdTRUE) ++dropped;
        filled = 0;
      }
    }
  }
}

// Each payload has an exact sample count; the final ADPCM nibble may be padding.
void sendAudioFrame(const AudioFrame &frame) {
  double squareSum = 0;
  for (const auto sample : frame.pcm) { const double v = sample / 32768.0; squareSum += v * v; }
  const double dbfs = squareSum > 0 ? 10 * log10(squareSum / AUDIO_FRAME_SAMPLES) : -120;
  String header = "{\"type\":\"audio\",\"protocol\":2,\"stream_id\":" + String(streamId) +
    ",\"sequence\":" + String(frame.sequence) + ",\"segment\":" + String(frame.segment) +
    ",\"audio_sample_index\":" + String(frame.sampleIndex) +
    ",\"audio_time_ms\":" + String(unixMsAt(frame.monotonicUs)) +
    ",\"audio_monotonic_us\":" + String(static_cast<uint64_t>(frame.monotonicUs)) +
    ",\"clock_synced\":" + String(rtcReady && !rtcNeedsSync ? "true" : "false") +
    ",\"audio_samples\":" + String(AUDIO_FRAME_SAMPLES) +
    ",\"audio_rate_hz\":" + String(MIC_SAMPLE_RATE) +
    ",\"audio_dbfs\":" + String(dbfs, 2) +
    ",\"capture_dropped_frames\":" + String(frame.droppedFrames) +
    ",\"dma_overruns\":" + String(frame.dmaOverruns) +
    ",\"mic_slot\":" + String(frame.slot) + sampleIdentityFields();
  uint8_t encoded[AUDIO_FRAME_SAMPLES / 2 + 4];
  ImaAdpcmEncoder codec;
  const size_t bytes = codec.encodeBlockSelfContained(frame.pcm, AUDIO_FRAME_SAMPLES, encoded);
  const String compressed = header + ",\"audio_codec\":\"ima_adpcm\",\"audio_adpcm_b64\":\"" + encodeBase64(encoded, bytes) + "\"}";
  Serial.println(compressed);
  if (wifiClientConnected) {
    sendWsLine(header + ",\"audio_codec\":\"pcm_s16le\",\"audio_pcm_s16_b64\":\"" +
      encodeBase64(reinterpret_cast<const uint8_t *>(frame.pcm), sizeof(frame.pcm)) + "\"}");
  } else if (bleSubscribed) {
    uint8_t payload[60 + sizeof(encoded)] = {};
    palWriteLE(payload, ESP.getEfuseMac(), 6);
    palWriteLE(payload + 6, unixMsAt(frame.monotonicUs), 8);
    palWriteLE(payload + 14, streamId, 4);
    palWriteLE(payload + 18, frame.sequence, 4);
    palWriteLE(payload + 22, frame.segment, 4);
    palWriteLE(payload + 26, frame.sampleIndex, 8);
    palWriteLE(payload + 34, frame.monotonicUs, 8);
    palWriteLE(payload + 42, AUDIO_FRAME_SAMPLES, 2);
    palWriteLE(payload + 44, MIC_SAMPLE_RATE, 2);
    palWriteLE(payload + 46, frame.droppedFrames, 4);
    palWriteLE(payload + 50, frame.dmaOverruns, 4);
    const float level = dbfs;
    memcpy(payload + 54, &level, 4);
    payload[58] = rtcReady && !rtcNeedsSync;
    payload[59] = frame.slot;
    memcpy(payload + 60, encoded, bytes);
    sendBleFrame(1, payload, 60 + bytes);
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
  const uint64_t packetTime = nowUnixMs() - static_cast<uint32_t>(millis() - lastPacketMs);
  String packet = "{\"type\":\"telemetry\",\"protocol\":2,\"time_ms\":" + String(packetTime) + ",\"imu\":[";
  packet.reserve(1400);
  for (size_t i = 0; i < imuCount; ++i) {
    const ImuSample &s = imuSamples[i];
    if (i) packet += ',';
    packet += "[" + String(s.offsetMs) + ',' + String(s.ax, 4) + ',' + String(s.ay, 4) + ',' +
              String(s.az, 4) + ',' + String(s.gx, 4) + ',' + String(s.gy, 4) + ',' + String(s.gz, 4) + "]";
  }
  packet += "]}";
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
        sendStatus("command_error", "Serial command exceeded 768 bytes");
      } else if (!input.isEmpty()) {
        if (commandQueue != nullptr) {
          CommandMessage message = {};
          strncpy(message.text, input.c_str(), sizeof(message.text) - 1);
          xQueueSend(commandQueue, &message, 0);
        }
      }
      input = "";
      discarding = false;
    } else if (input.length() < 768) {
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
      sendStatus("command_error", "BLE command exceeded 768 bytes");
    } else {
      handleCommand(String(message.text));
    }
  }
}

void telemetry_net_task(void *pvParameters) {
  (void)pvParameters;
  for (;;) {
    readSerialCommands();


    serviceWifi();

    // Command acknowledgements must not be dropped behind sensor traffic.
    for (QueueHandle_t queue : {statusQueue, telemetryQueue}) {
      OutgoingLine item;
      for (int count = 0; count < 4 && xQueueReceive(queue, &item, 0) == pdTRUE; ++count) {
        Serial.println(item.text);
        if (wifiClientConnected) sendWsLine(String(item.text));
        else if (bleSubscribed) sendBleLine(String(item.text));
        free(item.text);
      }
    }

    AudioFrame frame;
    if (xQueueReceive(audioQueue, &frame, 0) == pdTRUE) sendAudioFrame(frame);
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
  // Let UART transmission overlap BLE radio work instead of blocking each frame.
  Serial.setTxBufferSize(8192);
  Serial.begin(230400);
  delay(300);

  i2cMutex = xSemaphoreCreateMutex();
  audioQueue = xQueueCreate(6, sizeof(AudioFrame));
  wifiQueue = xQueueCreate(2, sizeof(WifiRequest));
  streamId = esp_random();
  char id[13];
  snprintf(id, sizeof(id), "%012llx", static_cast<unsigned long long>(ESP.getEfuseMac()));
  deviceId = id;
  deviceName = "PAL-" + deviceId.substring(6);
  deviceHostname = "pal-" + deviceId;
  telemetryQueue = xQueueCreate(16, sizeof(OutgoingLine));
  statusQueue = xQueueCreate(8, sizeof(OutgoingLine));
  commandQueue = xQueueCreate(8, sizeof(CommandMessage));
  if (!i2cMutex || !audioQueue || !wifiQueue || !telemetryQueue || !statusQueue || !commandQueue) {
    Serial.println("{\"type\":\"status\",\"state\":\"fatal_error\",\"detail\":\"Queue allocation failed\"}");
    for (;;) delay(1000);
  }

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
      clockAnchorUs = esp_timer_get_time();
    } else {
      clockBaseMs = 0;
      clockAnchorUs = esp_timer_get_time();
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

  beginBle();

  lastPacketMs = millis();
  lastImuMs = lastPacketMs;
  lastEnvMs = millis();
  startEnvironmentReading();

  sendStatus("ready", "Protocol v2: audio samples, IMU and environment over USB, BLE or Wi-Fi");
  if (!rtcReady) sendStatus("sensor_error", "DS3231 not found");
  if (rtcNeedsSync) sendStatus("clock_warning", "RTC lost power; synchronize it from the dashboard");
  if (!imuReady) sendStatus("sensor_error", "LSM6DSOX not found");
  if (!bmeReady) sendStatus("sensor_error", "BME688 not found");


  xTaskCreatePinnedToCore(microphone_task, "microphone", 8192, nullptr, 3, nullptr, 0);

  xTaskCreatePinnedToCore(
    telemetry_net_task,
    "telemetry_net",
    16384,
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
