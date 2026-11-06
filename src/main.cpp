#include <Arduino.h>
#include <Wire.h>
#include <RTClib.h>
#include "a3_sensors.h"
#include <esp_heap_caps.h>
#include <esp_system.h>
#include <NimBLEDevice.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <WebSocketsServer.h>
#include <driver/i2s.h>
#include <a3_usb.h>
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
#include "ble_imu.h"
#include "ble_stream.h"
#include "ble_audio_filter.h"
#include "firmware_version.h"

constexpr gpio_num_t MIC_BCLK = static_cast<gpio_num_t>(FredPal::MIC_BCLK);
constexpr gpio_num_t MIC_DOUT = static_cast<gpio_num_t>(FredPal::MIC_SD);
constexpr gpio_num_t MIC_LRCL = static_cast<gpio_num_t>(FredPal::MIC_WS);
constexpr int PIN_BATTERY = FredPal::BAT_ADC;
constexpr uint32_t MIC_SAMPLE_RATE = FredPal::AUDIO_SAMPLE_RATE;
constexpr uint32_t IMU_INTERVAL_MS = 10, PACKET_INTERVAL_MS = 100, ENV_INTERVAL_MS = 1000;
constexpr size_t AUDIO_FRAME_SAMPLES = 960; // 20 ms at 48 kHz

// 495 value bytes + 7 ATT/L2CAP bytes fit two full 251-byte link-layer packets.
// Smaller negotiated MTUs still use their exact available value capacity.
constexpr size_t BLE_MAX_CHUNK_BYTES = 495;

String deviceId, deviceName, deviceHostname;
static const char *SERVICE_UUID = "7f510001-5b8d-4a84-9c7c-a07142ab6002";
static const char *DATA_UUID = "7f510002-5b8d-4a84-9c7c-a07142ab6002";
static const char *COMMAND_UUID = "7f510003-5b8d-4a84-9c7c-a07142ab6002";

RTC_DS3231 rtc;
A3Environment bme;
A3Imu imu;
NimBLECharacteristic *dataCharacteristic = nullptr;
i2s_port_t microphonePort = I2S_NUM_0;

struct ImuSample { int64_t monotonicUs; uint32_t sequence; uint8_t tag; int16_t xyz[3]; };
ImuSample imuSamples[32];
size_t imuCount = 0;
uint32_t imuCounts[2] = {}, imuSegment = 0, imuOverruns = 0, imuDropped = 0, imuUnknownTags = 0;
int64_t imuAnchors[2] = {};
uint32_t imuAnchorCounts[2] = {};
TaskHandle_t sensorTask = nullptr;
volatile uint32_t telemetryDropped = 0, usbDropped = 0, bleDropped = 0;
volatile uint32_t audioHighWater = 0, audioDropped = 0, audioOverruns = 0;
uint32_t audioQueueFrames = 0;
bool psramQueue = false;
StaticQueue_t audioQueueControl;
void sendConfiguration();
void IRAM_ATTR imuInterrupt() {
  BaseType_t wake = pdFALSE;
  if (sensorTask) vTaskNotifyGiveFromISR(sensorTask, &wake);
  if (wake) portYIELD_FROM_ISR();
}
bool rtcReady = false;
bool rtcNeedsSync = false;
bool bmeReady = false;
bool imuReady = false;
bool micReady = false;
bool usbReady = false;
volatile bool bleSubscribed = false;
volatile size_t bleChunkBytes = 20;
volatile uint16_t bleIntervalUnits = 0;
volatile uint32_t bleNotifyRetries = 0;
volatile uint32_t bleAudioRate=24000, bleConnectionEpoch=0;
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
  int32_t pcm[AUDIO_FRAME_SAMPLES]; // untouched left-slot DMA words, LE on ESP32-S3
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
struct OutgoingLine { char *text; uint8_t *blePayload; uint16_t bleLength; uint8_t bleKind; };

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
  uint32_t sum=0;
  for (int i=0;i<8;++i) sum+=analogReadMilliVolts(PIN_BATTERY);
  return FredPal::batteryVolts(sum/8);
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

  // Snapshot before reading the clock: a callback on the other core may update
  // the timestamp, otherwise unsigned subtraction can resemble a long timeout.
  const uint32_t lastActivity = lastBleActivityMs;
  const uint32_t now = millis();
  if (lastActivity > 0 && (now - lastActivity > (bleSubscribed ? 15000U : 60000U))) {
    performSafeBleDisconnect();
  }
}

void updateStatusLed() {
  const bool fault = !rtcReady || rtcNeedsSync || !imuReady || !bmeReady || !micReady;
  // A3 has one active-HIGH green LED. Fast blink=fault, slow blink=idle, solid=link.
  const bool lit = fault ? (millis()/250)%2 :
    batterySaveMode ? (millis()%5000 < 250) : (wifiClientConnected || bleSubscribed || (millis()%2000 < 250));
  digitalWrite(FredPal::STATUS_LED, lit ? HIGH : LOW);
}

uint64_t unixMsAt(int64_t monotonicUs) {
  portENTER_CRITICAL(&clockMux);
  const int64_t value = static_cast<int64_t>(clockBaseMs) + (monotonicUs - clockAnchorUs) / 1000;
  portEXIT_CRITICAL(&clockMux);
  return value > 0 ? value : 0;
}
uint64_t nowUnixMs() { return unixMsAt(esp_timer_get_time()); }

PalBleStream<BLE_MAX_CHUNK_BYTES> bleWire;
uint16_t bleWireHandle=BLE_HS_CONN_HANDLE_NONE;
size_t bleWireLimit=0;

bool notifyBleBytes(const uint8_t *data,size_t length) {
  const uint16_t handle=bleConnectionHandle;
  for(int attempt=0;attempt<100;++attempt) {
    if(!bleSubscribed || handle!=bleConnectionHandle || handle!=bleWireHandle)return false;
    if(dataCharacteristic->notify(data,length,handle)) {lastBleActivityMs=millis();return true;}
    ++bleNotifyRetries;vTaskDelay(pdMS_TO_TICKS(2));
  }
  return false;
}
void serviceBleWire(bool flushTail=true) {
  if(!bleSubscribed || bleWireHandle!=bleConnectionHandle || bleWireLimit!=bleChunkBytes) {
    bleWire.reset();bleWireHandle=bleConnectionHandle;bleWireLimit=bleChunkBytes;
  }
  // A short final tail must also arrive when no more messages are pending.
  if(flushTail && bleSubscribed && uxQueueMessagesWaiting(audioQueue)==0 && bleWire.expired(millis(),30) && !bleWire.flush(notifyBleBytes))++bleDropped;
}
void sendBleFrame(uint8_t kind, const uint8_t *payload, size_t payloadLength) {
  if(dataCharacteristic==nullptr || !bleSubscribed)return;
  if(payloadLength>4096) {++bleDropped;return;}
  serviceBleWire(false);
  uint8_t wire[4108]={'P','A','L',2,kind,0};
  palWriteLE(wire+6,payloadLength,2);palWriteLE(wire+8,palCrc32(payload,payloadLength),4);
  memcpy(wire+12,payload,payloadLength);
  if(!bleWire.append(wire,payloadLength+12,bleWireLimit,millis(),notifyBleBytes))++bleDropped;
}

void sendBleLine(const String &line) {
  sendBleFrame(0, reinterpret_cast<const uint8_t *>(line.c_str()), line.length());
}
void sendUsbLine(const String &line) {
  if (!usbReady) return;
  // IDF queues the entire JSON line atomically or returns zero on timeout.
  // Its ISR preserves short FIFO writes; Arduino 2.0.17 HWCDC can lose bytes.
  const String packet = line + '\n';
  // Never stall BLE/audio behind a USB host that is not reading. The 16 KiB
  // ring absorbs active-host bursts; congestion drops an entire counted line.
  const int written = a3_usb_write_bytes(packet.c_str(), packet.length(), 0);
  if (written != static_cast<int>(packet.length())) ++usbDropped;
}

String identityFields() {
  return ",\"device_id\":\"" + deviceId + "\",\"device_name\":\"" + deviceName + "\",\"hostname\":\"" + deviceHostname + ".local\"";
}
String sampleIdentityFields() { return ",\"device_id\":\"" + deviceId + "\""; }

void enqueueTelemetry(const String &line, bool priority = false,
    const uint8_t *blePayload = nullptr, size_t bleLength = 0, uint8_t bleKind = 0) {
  if (telemetryQueue == nullptr) return;
  String identified = line;
  if (identified.endsWith("}")) {
    const bool samples = line.startsWith("{\"type\":\"telemetry\"") || line.startsWith("{\"type\":\"environment\"");
    identified.remove(identified.length() - 1);
    identified += (samples ? sampleIdentityFields() : identityFields()) + "}";
  }
  OutgoingLine item = {strdup(identified.c_str()), nullptr, 0, bleKind};
  if (item.text == nullptr) { ++telemetryDropped; return; }
  if (bleLength) {
    item.blePayload = static_cast<uint8_t *>(malloc(bleLength));
    if (!item.blePayload) { free(item.text); ++telemetryDropped; return; }
    memcpy(item.blePayload,blePayload,bleLength); item.bleLength=bleLength;
  }
  if (xQueueSend(priority ? statusQueue : telemetryQueue, &item, 0) != pdTRUE) {
    free(item.text); free(item.blePayload); ++telemetryDropped;
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
    const DateTime check=rtc.now();
    Wire.beginTransmission(FredPal::DS3231_ADDRESS);
    if (Wire.endTransmission()!=0 || rtc.lostPower() || !check.isValid() || llabs(static_cast<int64_t>(check.unixtime())-static_cast<int64_t>(unixMs/1000ULL))>1) {
      sendStatus("command_error","RTC write/readback failed; clock was not accepted"); return;
    }
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
  } else if (!strcmp(cmd, "get_config")) {
    sendConfiguration();
  } else if (!strcmp(cmd, "set_sampling")) {
    const cJSON *audio=cJSON_GetObjectItemCaseSensitive(root,"ble_audio_hz");
    const cJSON *motion=cJSON_GetObjectItemCaseSensitive(root,"imu_hz");
    const double a=cJSON_IsNumber(audio)?audio->valuedouble:0, m=cJSON_IsNumber(motion)?motion->valuedouble:0;
    if((a!=16000 && a!=24000 && a!=48000) || (m!=26 && m!=52 && m!=104 && m!=208 && m!=416)) {
      sendStatus("command_error","Supported BLE audio rates: 16000/24000/48000; IMU rates: 26/52/104/208/416");
    } else if(!imuReady) sendStatus("command_error","IMU unavailable; sampling settings were not applied");
    else {
      const bool changed=imu.rateHz!=static_cast<uint16_t>(m);
      if(changed && !imu.setRate(static_cast<uint16_t>(m))) {imuReady=false;sendStatus("command_error","IMU rate readback failed; restart the board");}
      else {
        if(changed) {++imuSegment;imuDropped+=imuCount;imuCount=0;imuAnchors[0]=imuAnchors[1]=0;}
        bleAudioRate=static_cast<uint32_t>(a);
        sendConfiguration();sendStatus("sampling_applied","Sampling settings applied; USB/Wi-Fi audio remains raw 48 kHz. Settings reset on reboot.");
      }
    }
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
      // Keep link tuning after the central's encryption/service discovery.
      // Request Apple's 15 ms minimum; the central chooses the actual interval.
      NimBLEServer *server = NimBLEDevice::getServer();
      server->updateConnParams(connInfo.getConnHandle(), 12, 12, 0, 400);
      server->setDataLen(connInfo.getConnHandle(), 251);
      server->updatePhy(connInfo.getConnHandle(), BLE_GAP_LE_PHY_2M_MASK, BLE_GAP_LE_PHY_2M_MASK, 0);
      sendConfiguration();
    }
  }
};

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnParamsUpdate(NimBLEConnInfo &connInfo) override {
    bleIntervalUnits = connInfo.getConnInterval();
  }
  void onMTUChange(uint16_t mtu, NimBLEConnInfo &) override {
    bleChunkBytes = min(BLE_MAX_CHUNK_BYTES, static_cast<size_t>(max(23, static_cast<int>(mtu)) - 3));
  }
  void onAuthenticationComplete(NimBLEConnInfo &connInfo) override {
    lastBleActivityMs = millis();
    sendStatus("ble_security", connInfo.isEncrypted() ? "Bluetooth link encrypted" : "Bluetooth encryption failed; reconnect");
  }
  void onConnect(NimBLEServer *, NimBLEConnInfo &connInfo) override {
    ++bleConnectionEpoch;
    lastBleActivityMs = millis();
    bleConnectionHandle = connInfo.getConnHandle();
    bleIntervalUnits = connInfo.getConnInterval();
    commandCallbacks.reset();
    // READ_ENC / WRITE_ENC trigger pairing when the central accesses commands.
    // Do not race that request with an unsolicited peripheral security request.
  }
  void onDisconnect(NimBLEServer * /*server*/, NimBLEConnInfo & /*connInfo*/, int reason) override {
    const String detail = "Bluetooth disconnected (reason " + String(reason) + ")";
    sendStatus("ble_disconnected", detail.c_str());
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
  NimBLEDevice::setMTU(517);
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
  dataCharacteristic->setValue("FrED PAL A3 ready");
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
      sendConfiguration();
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
  config.dma_buf_len = 256; // 42.7 ms total stereo DMA storage
  config.bits_per_chan = I2S_BITS_PER_CHAN_32BIT;
  config.use_apll = false; // ESP32-S3 uses PLL clock, not original ESP32 APLL
  config.mclk_multiple = I2S_MCLK_MULTIPLE_256;
  config.total_chan = 2;
  config.chan_mask = static_cast<i2s_channel_t>(I2S_TDM_ACTIVE_CH0 | I2S_TDM_ACTIVE_CH1);
  config.left_align = true;
  config.big_edin = false;
  config.bit_order_msb = false; // IDF 4.4 field name is misleading: HAL true enables LSB-first
  config.skip_msk = false;

  i2s_pin_config_t pins = {};
  pins.mck_io_num = I2S_PIN_NO_CHANGE; // A3 has no MCLK connection
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
  constexpr int slot = 0; // S3 standard stereo DMA: left (WS LOW), then right
  uint32_t settling = FredPal::AUDIO_SETTLING_FRAMES;
  int64_t anchorUs = 0;
  uint64_t anchorIndex = 0;
  // Installation occurs here, immediately before reading, so boot/BLE setup cannot
  // fill the DMA buffer before the capture task starts.
  beginMicrophone();
  if (!micReady) { sendStatus("sensor_error", "ICS-43432 I2S setup failed"); vTaskDelete(nullptr); return; }
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
    const esp_err_t result=i2s_read(microphonePort, stereo, sizeof(stereo), &bytesRead, pdMS_TO_TICKS(25));
    if (result!=ESP_OK || bytesRead%8) { ++overruns; ++segment; filled=0; anchorUs=0; continue; }
    const size_t count = bytesRead / (2 * sizeof(int32_t));
    if (!count) continue;
    if (!anchorUs) { anchorUs = esp_timer_get_time() - count * 1000000LL / MIC_SAMPLE_RATE; anchorIndex = sampleIndex; }
    for (size_t i = 0; i < count; ++i) {
      if (settling) { --settling; ++sampleIndex; continue; }
      if (!filled) {
        frame.sampleIndex = sampleIndex;
        frame.monotonicUs = anchorUs + (sampleIndex - anchorIndex) * 1000000LL / MIC_SAMPLE_RATE;
        frame.segment = segment;
        frame.slot = slot;
      }
      frame.pcm[filled++] = stereo[i * 2 + frame.slot];
      ++sampleIndex;
      if (filled == AUDIO_FRAME_SAMPLES) {
        frame.sequence = sequence++;
        frame.droppedFrames = dropped;
        frame.dmaOverruns = overruns;
        if (xQueueSend(audioQueue, &frame, 0) != pdTRUE) ++dropped;
        audioDropped=dropped; audioOverruns=overruns;
        audioHighWater=max(static_cast<uint32_t>(audioHighWater),static_cast<uint32_t>(uxQueueMessagesWaiting(audioQueue)));
        filled = 0;
      }
    }
  }
}

// Each payload has an exact sample count; the final ADPCM nibble may be padding.
void sendAudioFrame(const AudioFrame &frame) {
  double squareSum = 0;
  for (const auto sample : frame.pcm) { const double v = sample / 2147483648.0; squareSum += v * v; }
  const double dbfs = squareSum > 0 ? 10 * log10(squareSum / AUDIO_FRAME_SAMPLES) : -120;
  String header = "{\"type\":\"audio\",\"protocol\":3,\"stream_id\":" + String(streamId) +
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
  // Preserve all 32 received bits on USB/Wi-Fi. No unverified 24-bit shift.
  if (usbReady || wifiClientConnected) {
    const String raw=header + ",\"audio_codec\":\"i2s_s32le\",\"audio_pcm_s32_b64\":\"" +
      encodeBase64(reinterpret_cast<const uint8_t *>(frame.pcm), sizeof(frame.pcm)) + "\"}";
    sendUsbLine(raw);
    if (wifiClientConnected) sendWsLine(raw);
  }
  if (!wifiClientConnected && bleSubscribed) {
    // Bluetooth-only anti-alias filtering; USB/Wi-Fi above retain every raw word.
    static PalBleAudioFilter filter;
    static uint32_t previousSequence=0,previousSegment=0,previousRate=0,previousEpoch=0,previewSegment=0;
    const uint32_t rate=bleAudioRate,epoch=bleConnectionEpoch;
    const bool reset=previousRate!=rate || previousEpoch!=epoch || previousSegment!=frame.segment || frame.sequence!=previousSequence+1;
    if(reset) {filter.reset();++previewSegment;}
    previousRate=rate;previousEpoch=epoch;previousSegment=frame.segment;previousSequence=frame.sequence;
    int16_t preview[AUDIO_FRAME_SAMPLES];size_t samples=0;
    int64_t sampleTime=frame.monotonicUs;uint64_t sampleIndex=frame.sampleIndex;
    if(rate==48000) {
      for(size_t i=0;i<AUDIO_FRAME_SAMPLES;++i)preview[i]=frame.pcm[i]>>16;
      samples=AUDIO_FRAME_SAMPLES;
    } else {
      samples=filter.process(frame.pcm,AUDIO_FRAME_SAMPLES,preview,rate);
      if(reset)return; // discard one warm-up frame after connecting/rate change/gap
      sampleTime-=PalBleAudioFilter::DELAY_SAMPLES*1000000LL/MIC_SAMPLE_RATE;
      sampleIndex=(sampleIndex-PalBleAudioFilter::DELAY_SAMPLES)/(MIC_SAMPLE_RATE/rate);
    }
    uint8_t encoded[AUDIO_FRAME_SAMPLES/2+4];ImaAdpcmEncoder codec;
    const size_t bytes=codec.encodeBlockSelfContained(preview,samples,encoded);
    uint8_t payload[60+sizeof(encoded)]={};
    double previewSquares=0;for(size_t i=0;i<samples;++i){const double v=preview[i]/32768.0;previewSquares+=v*v;}
    const float level=previewSquares>0?10*log10(previewSquares/samples):-120;
    palWriteLE(payload,ESP.getEfuseMac(),6);palWriteLE(payload+6,unixMsAt(sampleTime),8);
    palWriteLE(payload+14,streamId,4);palWriteLE(payload+18,frame.sequence,4);palWriteLE(payload+22,previewSegment,4);
    palWriteLE(payload+26,sampleIndex,8);palWriteLE(payload+34,static_cast<uint64_t>(sampleTime),8);
    palWriteLE(payload+42,samples,2);palWriteLE(payload+44,rate,2);
    palWriteLE(payload+46,frame.droppedFrames,4);palWriteLE(payload+50,frame.dmaOverruns,4);
    memcpy(payload+54,&level,4);payload[58]=rtcReady && !rtcNeedsSync;payload[59]=frame.slot;
    memcpy(payload+60,encoded,bytes);
    sendBleFrame(1, payload, 60 + bytes);
  }
}

void readImuFifoBurst() {
  if (!imuReady) return;
  uint16_t count=0; bool overflow=false;
  if (!imu.level(count,overflow)) {
    imuReady=false; sendStatus("sensor_error","LSM6DSOX identity/read failed; restart after checking hardware"); return;
  }
  if (overflow) {
    ++imuOverruns; ++imuSegment; imuDropped+=imuCount; imuCount=0;
    imuAnchors[0]=imuAnchors[1]=0;
    if (!imu.restartFifo()) imuReady=false;
    return;
  }
  const int64_t now=esp_timer_get_time();
  for (uint16_t i=0; i<min(count,static_cast<uint16_t>(128)); ++i) {
    ImuSample sample={};
    if (!imu.read(sample.tag,sample.xyz)) { ++imuDropped; break; }
    if (sample.tag!=1 && sample.tag!=2) { ++imuUnknownTags; continue; }
    const int stream=sample.tag-1;
    if (!imuAnchors[stream]) {
      imuAnchors[stream]=now - (max(1,static_cast<int>((count+1)/2))-1)*1000000LL/imu.rateHz;
      imuAnchorCounts[stream]=imuCounts[stream];
    }
    sample.sequence=imuCounts[stream]++;
    sample.monotonicUs=imuAnchors[stream]+(sample.sequence-imuAnchorCounts[stream])*1000000LL/imu.rateHz;
    if (imuCount<32) imuSamples[imuCount++]=sample; else ++imuDropped;
  }
}
void sendTelemetryPacket() {
  if (!imuCount) return;
  String packet="{\"type\":\"telemetry\",\"protocol\":3,\"time_ms\":" + String(nowUnixMs()) +
    ",\"clock_synced\":" + String(rtcReady && !rtcNeedsSync ? "true":"false") +
    ",\"stream_id\":"+String(streamId)+",\"imu_segment\":"+String(imuSegment)+
    ",\"imu_overruns\":"+String(imuOverruns)+",\"imu_dropped\":"+String(imuDropped)+",\"imu_rate_hz\":"+String(imu.rateHz)+",\"imu_raw\":[";
  packet.reserve(2400);
  PalBleImuRecord records[32];
  for(size_t i=0;i<imuCount;++i) {
    const auto &r=imuSamples[i]; if(i) packet+=',';
    const uint64_t timeMs=unixMsAt(r.monotonicUs);
    records[i]={static_cast<uint64_t>(r.monotonicUs),timeMs,r.sequence,r.tag,{r.xyz[0],r.xyz[1],r.xyz[2]}};
    packet+="["+String(static_cast<uint64_t>(r.monotonicUs))+','+String(r.tag)+','+String(r.xyz[0])+','+String(r.xyz[1])+','+String(r.xyz[2])+','+String(r.sequence)+','+String(timeMs)+"]";
  }
  uint8_t payload[PAL_BLE_IMU_HEADER+2+32*PAL_BLE_IMU_ROW];
  const size_t length=palEncodeBleImu(payload,sizeof(payload),ESP.getEfuseMac(),streamId,imuSegment,
    imuOverruns,imuDropped,rtcReady && !rtcNeedsSync,records,imuCount,imu.rateHz);
  enqueueTelemetry(packet+"]}",false,payload,length,4); imuCount=0;
}
void sendEnvironment() {
  bme68x_data data={}; bool ok;
  { I2CLock lock; ok=bme.finish(data); }
  if (!ok) { sendStatus("sensor_error","BME688 conversion failed or no new data"); return; }
  const bool gasValid=data.status&BME68X_GASM_VALID_MSK, heaterStable=data.status&BME68X_HEAT_STAB_MSK;
  String packet="{\"type\":\"environment\",\"time_ms\":"+String(nowUnixMs())+
    ",\"clock_synced\":"+String(rtcReady && !rtcNeedsSync ? "true":"false")+
    ",\"monotonic_us\":"+String(static_cast<uint64_t>(esp_timer_get_time()))+
    ",\"temperature_c\":"+String(data.temperature,3)+",\"humidity_pct\":"+String(data.humidity,3)+
    ",\"pressure_hpa\":"+String(data.pressure/100.0f,3)+",\"gas_ohms\":"+(gasValid && heaterStable ? String(data.gas_resistance,2):String("null"))+
    ",\"new_data\":true,\"gas_valid\":"+String(gasValid?"true":"false")+",\"heater_stable\":"+String(heaterStable?"true":"false")+
    ",\"measurement_index\":"+String(data.meas_index)+",\"profile_id\":1}";
  enqueueTelemetry(packet);
}
void startEnvironmentReading() {
  if (!bmeReady || bmeReading) return;
  I2CLock lock;
  const uint32_t duration=bme.start();
  if (!duration) { sendStatus("sensor_error","BME688 start failed"); return; }
  bmeReadyAtMs=millis()+duration; bmeReading=true;
}
void sendConfiguration() {
  String config="{\"type\":\"configuration\",\"protocol\":3,\"hardware\":\"FrED PAL A3\",\"firmware\":\"" FRED_FIRMWARE_VERSION "\",\"ble_imu\":\"lossless_tagged_rate_kind4\",\"usb_driver\":\"esp-idf-usb-serial-jtag\",\"build\":\"" __DATE__ " " __TIME__ "\",\"arduino\":\"2.0.17\",\"idf\":\"";
  config+=esp_get_idf_version();
  config+="\",\"sampling_control\":true,\"ble_audio_rate_hz\":"+String(bleAudioRate)+",\"ble_filter\":\"kaiser129_decimation_delay_compensated_64_input_samples_24k_pass10k_stop12k_16k_pass6k_stop8k_48k_bypass\",\"stream_id\":"+String(streamId)+",\"reset_reason\":"+String(esp_reset_reason())+
    ",\"flash_bytes\":"+String(ESP.getFlashChipSize())+",\"psram_bytes\":"+String(ESP.getPsramSize())+
    ",\"audio_queue_frames\":"+String(audioQueueFrames)+",\"queue_memory\":\""+(psramQueue?"psram":"internal_reduced")+"\",";
  config+="\"audio\":{\"sensor\":\"ICS-43432\",\"rate_hz\":48000,\"wire_slots\":2,\"slot_bits\":32,\"bclk_hz\":3072000,\"channel\":\"left\",\"container\":\"i2s_s32le\",\"valid_bits\":24,\"alignment\":\"unshifted_dma_requires_bench_validation\",\"settling_frames\":4224,\"ble\":\"ima_adpcm_lossy_preview\"},";
  config+="\"imu\":{\"sensor\":\"LSM6DSOX\",\"spi_hz\":1000000,\"spi_mode\":3,\"odr_hz\":"+String(imu.rateHz)+",\"accel_g\":4,\"gyro_dps\":500,\"axes\":\"native_sensor\",\"timing\":\"independent_counter_estimates_not_synchronized\",\"filter\":\"reset_defaults\",\"ctrl1_4\":[";
  for(int i=0;i<4;++i) {if(i)config+=','; config+=String(imu.registers[i]);}
  config+="],\"driver_commit\":\"2e86793125f7f46b6195fce93a2b3cb76a51e564\"},";
  config+="\"environment\":{\"driver_commit\":\"80ea120a8b8ac987d7d79eb68a9ed796736be845\",\"variant\":"+String(bme.device.variant_id)+",\"i2c_hz\":100000,\"address\":118,\"profile_id\":1,\"oversampling_tph\":[8,4,2],\"iir\":\"off\",\"heater_c\":320,\"heater_ms\":150,\"outputs\":\"compensated_TPH_and_valid_gas_resistance\"},\"overflow_policy\":\"drop_newest_count_gaps\",\"rtc_policy\":\"UTC_explicit_host_sync_OSF_invalid\",\"rtc_interrupt\":\"disabled\",\"battery_policy\":\"voltage_only_no_software_cutoff\",\"expansion\":\"disabled\"}";
  enqueueTelemetry(config,true);
}
void sendHealth() {
  enqueueTelemetry("{\"type\":\"health\",\"time_ms\":"+String(nowUnixMs())+
    ",\"clock_synced\":"+String(rtcReady && !rtcNeedsSync ? "true":"false")+
    ",\"battery_v\":"+String(readBatteryVoltage(),3)+",\"battery_pct\":null,\"imu_ready\":"+String(imuReady?"true":"false")+
    ",\"bme_ready\":"+String(bmeReady?"true":"false")+",\"mic_ready\":"+String(micReady?"true":"false")+
    ",\"imu_overruns\":"+String(imuOverruns)+",\"imu_dropped\":"+String(imuDropped)+",\"imu_unknown_tags\":"+String(imuUnknownTags)+
    ",\"audio_dropped\":"+String(audioDropped)+",\"audio_overruns\":"+String(audioOverruns)+",\"audio_queue_high_water\":"+String(audioHighWater)+
    ",\"telemetry_dropped\":"+String(telemetryDropped)+",\"usb_dropped\":"+String(usbDropped)+",\"ble_dropped\":"+String(bleDropped)+
    ",\"ble_att_payload\":"+String(bleChunkBytes)+",\"ble_interval_ms\":"+String(bleIntervalUnits*1.25f,2)+",\"ble_notify_retries\":"+String(bleNotifyRetries)+
    ",\"free_heap\":"+String(ESP.getFreeHeap())+",\"free_psram\":"+String(ESP.getFreePsram())+"}");
}

void readSerialCommands() {
  static String input;
  static bool discarding = false;
  if (!usbReady) return;
  char received[256];
  const int length = a3_usb_read_bytes(received, sizeof(received), 0);
  for (int i = 0; i < length; ++i) {
    const char c = received[i];
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
        sendUsbLine(String(item.text));
        if (wifiClientConnected) sendWsLine(String(item.text));
        else if (bleSubscribed) {
          if (item.bleLength) sendBleFrame(item.bleKind,item.blePayload,item.bleLength);
          else sendBleLine(String(item.text));
        }
        free(item.text); free(item.blePayload);
      }
    }

    AudioFrame frame;
    if (xQueueReceive(audioQueue, &frame, 0) == pdTRUE) sendAudioFrame(frame);
    serviceBleWire();
    checkBleSafetyTimeout();

    // A blocked notify already waits for the radio. Do not add another 5 ms
    // to every queued audio frame when catching up after a congested event.
    vTaskDelay(pdMS_TO_TICKS(uxQueueMessagesWaiting(audioQueue) ? 1 : 5));
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
    if (now - lastPacketMs >= min(PACKET_INTERVAL_MS,12000U/imu.rateHz)) {
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
      sendHealth();
    }
    if (now - lastLedUpdateMs >= 250) {
      lastLedUpdateMs = now;
      updateStatusLed();
    }

    ulTaskNotifyTake(pdTRUE,pdMS_TO_TICKS(5));
  }
}

void setup() {
  digitalWrite(FredPal::STATUS_LED,LOW); pinMode(FredPal::STATUS_LED,OUTPUT);
  digitalWrite(FredPal::IMU_CS,HIGH); pinMode(FredPal::IMU_CS,OUTPUT);
  digitalWrite(FredPal::EXT_SPI_CS,HIGH); pinMode(FredPal::EXT_SPI_CS,OUTPUT);
  pinMode(FredPal::IMU_INT1,INPUT); pinMode(FredPal::IMU_INT2,INPUT); pinMode(FredPal::RTC_INT,INPUT);
  pinMode(PIN_BATTERY,INPUT);
  // This driver exclusively owns hardware CDC. Do not start Arduino HWCDC.
  usb_serial_jtag_driver_config_t usbConfig = {16384, 1024};
  usbReady = a3_usb_driver_install(&usbConfig) == ESP_OK;
  delay(150); // battery divider settling; never wait for a USB host
  i2cMutex=xSemaphoreCreateMutex();
  audioQueueFrames=24;
  uint8_t *queueStorage=static_cast<uint8_t *>(heap_caps_malloc(audioQueueFrames*sizeof(AudioFrame),MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT));
  psramQueue=queueStorage!=nullptr;
  if (queueStorage) audioQueue=xQueueCreateStatic(audioQueueFrames,sizeof(AudioFrame),queueStorage,&audioQueueControl);
  else { audioQueueFrames=6; audioQueue=xQueueCreate(audioQueueFrames,sizeof(AudioFrame)); }
  wifiQueue=xQueueCreate(2,sizeof(WifiRequest));
  telemetryQueue=xQueueCreate(16,sizeof(OutgoingLine)); statusQueue=xQueueCreate(8,sizeof(OutgoingLine)); commandQueue=xQueueCreate(8,sizeof(CommandMessage));
  if (!usbReady || !i2cMutex || !audioQueue || !wifiQueue || !telemetryQueue || !statusQueue || !commandQueue || ESP.getFlashChipSize()!=8388608) {
    for (;;) { sendUsbLine("{\"type\":\"status\",\"state\":\"fatal_error\",\"detail\":\"Allocation/USB failure or flash is not 8 MB\"}"); digitalWrite(FredPal::STATUS_LED,!digitalRead(FredPal::STATUS_LED)); delay(250); }
  }
  streamId=esp_random(); char id[13]; snprintf(id,sizeof(id),"%012llx",static_cast<unsigned long long>(ESP.getEfuseMac()));
  deviceId=id; deviceName="PAL-"+deviceId.substring(6); deviceHostname="pal-"+deviceId;
  analogReadResolution(12); analogSetPinAttenuation(PIN_BATTERY,ADC_6db);
  Wire.begin(FredPal::I2C_SDA,FredPal::I2C_SCL,FredPal::I2C_HZ); Wire.setTimeOut(50);
  clockAnchorUs=esp_timer_get_time();
  {
    I2CLock lock;
    rtcReady=rtc.begin(&Wire); rtcNeedsSync=true;
    if(rtcReady) {
      const DateTime current=rtc.now();
      rtcNeedsSync=rtc.lostPower() || !current.isValid() || current.year()<2020 || current.year()>=2100;
      if(!rtcNeedsSync) {clockBaseMs=static_cast<uint64_t>(current.unixtime())*1000ULL; clockAnchorUs=esp_timer_get_time();}
      rtc.disableAlarm(1); rtc.disableAlarm(2); rtc.clearAlarm(1); rtc.clearAlarm(2); rtc.writeSqwPinMode(DS3231_OFF); rtc.disable32K();
    }
    bmeReady=bme.begin();
  }
  imuReady=imu.begin();
  beginBle();
  lastPacketMs=lastImuMs=lastEnvMs=millis(); startEnvironmentReading();
  sendConfiguration();
  sendStatus("ready","A3: raw 48 kHz audio on native USB/Wi-Fi; BLE is a lossy preview");
  if(!psramQueue) sendStatus("memory_warning","PSRAM unavailable: explicit reduced 6-frame internal queue");
  if(!rtcReady) sendStatus("sensor_error","DS3231 not found");
  if(rtcNeedsSync) sendStatus("clock_warning","RTC invalid; explicit UTC synchronization required");
  if(!imuReady) sendStatus("sensor_error","LSM6DSOX SPI identity or configuration failed");
  if(!bmeReady) sendStatus("sensor_error","BME688 initialization failed at 0x76");
  const bool tasksOk=xTaskCreatePinnedToCore(microphone_task,"microphone",12288,nullptr,3,nullptr,0)==pdPASS &&
    xTaskCreatePinnedToCore(telemetry_net_task,"telemetry_net",24576,nullptr,2,nullptr,0)==pdPASS &&
    xTaskCreatePinnedToCore(sensor_app_task,"sensor_app",12288,nullptr,2,&sensorTask,1)==pdPASS;
  if(!tasksOk) { for(;;) { digitalWrite(FredPal::STATUS_LED,!digitalRead(FredPal::STATUS_LED)); sendUsbLine("{\"type\":\"status\",\"state\":\"fatal_error\",\"detail\":\"Task creation failed\"}"); delay(250); } }
  if(imuReady) attachInterrupt(digitalPinToInterrupt(FredPal::IMU_INT1),imuInterrupt,RISING);
}
void loop() { vTaskDelete(nullptr); }
