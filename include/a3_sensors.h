#pragma once
#include <Arduino.h>
#include <SPI.h>
#include <Wire.h>
#include "board_a3.h"
#include "lsm6dsox_reg.h"
#include "bme68x.h"

// SPI is exclusively owned by the sensor task, apart from initialization.
// Student expansion must use a different SPIClass(HSPI), on 40/42/41/47.
class A3Imu {
public:
  stmdev_ctx_t ctx = {};
  uint8_t registers[4] = {};
  uint16_t rateHz = 104;
  bool begin();
  bool setRate(uint16_t hz);
  bool read(uint8_t &tag, int16_t xyz[3]);
  bool level(uint16_t &count, bool &overflow);
  bool restartFifo();
private:
  static int32_t readRegisters(void *, uint8_t, uint8_t *, uint16_t);
  static int32_t writeRegisters(void *, uint8_t, const uint8_t *, uint16_t);
};
class A3Environment {
public:
  bme68x_dev device = {};
  bme68x_conf config = {};
  bme68x_heatr_conf heater = {};
  bool begin();
  uint32_t start();
  bool finish(bme68x_data &data);
private:
  static BME68X_INTF_RET_TYPE readRegisters(uint8_t, uint8_t *, uint32_t, void *);
  static BME68X_INTF_RET_TYPE writeRegisters(uint8_t, const uint8_t *, uint32_t, void *);
};
