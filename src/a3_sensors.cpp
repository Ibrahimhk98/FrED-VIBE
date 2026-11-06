#include "a3_sensors.h"
int32_t A3Imu::readRegisters(void *, uint8_t reg, uint8_t *data, uint16_t n) {
  SPI.beginTransaction(SPISettings(FredPal::IMU_SPI_HZ, MSBFIRST, SPI_MODE3));
  digitalWrite(FredPal::IMU_CS, LOW); SPI.transfer(reg | 0x80);
  for (uint16_t i=0; i<n; ++i) data[i]=SPI.transfer(0);
  digitalWrite(FredPal::IMU_CS, HIGH); SPI.endTransaction();
  return 0; // SPI has no ACK; identity/configuration readback validates the device.
}
int32_t A3Imu::writeRegisters(void *, uint8_t reg, const uint8_t *data, uint16_t n) {
  SPI.beginTransaction(SPISettings(FredPal::IMU_SPI_HZ, MSBFIRST, SPI_MODE3));
  digitalWrite(FredPal::IMU_CS, LOW); SPI.transfer(reg & 0x7f);
  for (uint16_t i=0; i<n; ++i) SPI.transfer(data[i]);
  digitalWrite(FredPal::IMU_CS, HIGH); SPI.endTransaction(); return 0;
}
bool A3Imu::begin() {
  ctx.read_reg=readRegisters; ctx.write_reg=writeRegisters;
  SPI.begin(FredPal::IMU_SCK, FredPal::IMU_MISO, FredPal::IMU_MOSI, FredPal::IMU_CS);
  uint8_t id=0, reset=1;
  if (lsm6dsox_device_id_get(&ctx,&id) || id!=LSM6DSOX_ID || lsm6dsox_reset_set(&ctx,1)) return false;
  const uint32_t start=millis();
  do { delay(1); if (lsm6dsox_reset_get(&ctx,&reset)) return false; } while (reset && millis()-start<100);
  if (reset || lsm6dsox_device_id_get(&ctx,&id) || id!=LSM6DSOX_ID) return false;
  if (lsm6dsox_spi_mode_set(&ctx,LSM6DSOX_SPI_4_WIRE) ||
      lsm6dsox_i3c_disable_set(&ctx,LSM6DSOX_I3C_DISABLE) ||
      lsm6dsox_i2c_interface_set(&ctx,LSM6DSOX_I2C_DISABLE) ||
      lsm6dsox_block_data_update_set(&ctx,1) || lsm6dsox_auto_increment_set(&ctx,1) ||
      lsm6dsox_xl_full_scale_set(&ctx,LSM6DSOX_4g) || lsm6dsox_gy_full_scale_set(&ctx,LSM6DSOX_500dps) ||
      lsm6dsox_xl_data_rate_set(&ctx,LSM6DSOX_XL_ODR_104Hz) ||
      lsm6dsox_gy_data_rate_set(&ctx,LSM6DSOX_GY_ODR_104Hz) ||
      lsm6dsox_fifo_xl_batch_set(&ctx,LSM6DSOX_XL_BATCHED_AT_104Hz) ||
      lsm6dsox_fifo_gy_batch_set(&ctx,LSM6DSOX_GY_BATCHED_AT_104Hz) ||
      lsm6dsox_fifo_watermark_set(&ctx,8) ||
      lsm6dsox_pin_mode_set(&ctx,LSM6DSOX_PUSH_PULL) ||
      lsm6dsox_pin_polarity_set(&ctx,LSM6DSOX_ACTIVE_HIGH)) return false;
  lsm6dsox_pin_int1_route_t route={}; route.fifo_th=1;
  lsm6dsox_pin_int2_route_t route2={};
  if (lsm6dsox_pin_int1_route_set(&ctx,route) || lsm6dsox_pin_int2_route_set(&ctx,nullptr,route2) || !restartFifo()) return false;
  lsm6dsox_fs_xl_t xl; lsm6dsox_fs_g_t gy; lsm6dsox_odr_xl_t axRate; lsm6dsox_odr_g_t gyRate;
  lsm6dsox_fifo_mode_t mode;
  if (lsm6dsox_xl_full_scale_get(&ctx,&xl) || lsm6dsox_gy_full_scale_get(&ctx,&gy) ||
      lsm6dsox_xl_data_rate_get(&ctx,&axRate) || lsm6dsox_gy_data_rate_get(&ctx,&gyRate) ||
      lsm6dsox_fifo_mode_get(&ctx,&mode)) return false;
  readRegisters(nullptr,LSM6DSOX_CTRL1_XL,registers,sizeof(registers));
  return xl==LSM6DSOX_4g && gy==LSM6DSOX_500dps && axRate==LSM6DSOX_XL_ODR_104Hz && gyRate==LSM6DSOX_GY_ODR_104Hz && mode==LSM6DSOX_STREAM_MODE;
}
bool A3Imu::restartFifo() {
  return !lsm6dsox_fifo_mode_set(&ctx,LSM6DSOX_BYPASS_MODE) && !lsm6dsox_fifo_mode_set(&ctx,LSM6DSOX_STREAM_MODE);
}
bool A3Imu::setRate(uint16_t hz) {
  uint8_t code=hz==26?2:hz==52?3:hz==104?4:hz==208?5:hz==416?6:0;
  if(!code)return false;
  const auto ax=static_cast<lsm6dsox_odr_xl_t>(code);
  const auto gy=static_cast<lsm6dsox_odr_g_t>(code);
  const auto ab=static_cast<lsm6dsox_bdr_xl_t>(code);
  const auto gb=static_cast<lsm6dsox_bdr_gy_t>(code);
  if(lsm6dsox_fifo_mode_set(&ctx,LSM6DSOX_BYPASS_MODE) ||
     lsm6dsox_xl_data_rate_set(&ctx,ax) || lsm6dsox_gy_data_rate_set(&ctx,gy) ||
     lsm6dsox_fifo_xl_batch_set(&ctx,ab) || lsm6dsox_fifo_gy_batch_set(&ctx,gb) || !restartFifo())return false;
  lsm6dsox_odr_xl_t ar;lsm6dsox_odr_g_t gr;lsm6dsox_bdr_xl_t abr;lsm6dsox_bdr_gy_t gbr;
  if(lsm6dsox_xl_data_rate_get(&ctx,&ar) || lsm6dsox_gy_data_rate_get(&ctx,&gr) ||
     lsm6dsox_fifo_xl_batch_get(&ctx,&abr) || lsm6dsox_fifo_gy_batch_get(&ctx,&gbr) ||
     ar!=ax || gr!=gy || abr!=ab || gbr!=gb)return false;
  readRegisters(nullptr,LSM6DSOX_CTRL1_XL,registers,sizeof(registers));rateHz=hz;return true;
}
bool A3Imu::level(uint16_t &count, bool &overflow) {
  uint8_t flag=0, id=0;
  if (lsm6dsox_device_id_get(&ctx,&id) || id!=LSM6DSOX_ID ||
      lsm6dsox_fifo_data_level_get(&ctx,&count) || lsm6dsox_fifo_ovr_flag_get(&ctx,&flag)) return false;
  overflow=flag; return true;
}
bool A3Imu::read(uint8_t &tag, int16_t xyz[3]) {
  // One complete tagged entry per transaction; FIFO is not a flat register array.
  uint8_t bytes[7];
  if (readRegisters(nullptr,LSM6DSOX_FIFO_DATA_OUT_TAG,bytes,7)) return false;
  tag=bytes[0]>>3;
  for (int i=0;i<3;++i) xyz[i]=static_cast<int16_t>(bytes[1+2*i] | (bytes[2+2*i]<<8));
  return true;
}
BME68X_INTF_RET_TYPE A3Environment::readRegisters(uint8_t reg, uint8_t *data, uint32_t n, void *) {
  Wire.beginTransmission(FredPal::BME688_ADDRESS); Wire.write(reg);
  if (Wire.endTransmission(false)!=0 || Wire.requestFrom(FredPal::BME688_ADDRESS,static_cast<uint8_t>(n))!=n) return -1;
  for(uint32_t i=0;i<n;++i) data[i]=Wire.read(); return 0;
}
BME68X_INTF_RET_TYPE A3Environment::writeRegisters(uint8_t reg, const uint8_t *data, uint32_t n, void *) {
  Wire.beginTransmission(FredPal::BME688_ADDRESS); Wire.write(reg); Wire.write(data,n);
  return Wire.endTransmission()==0 ? 0 : -1;
}
bool A3Environment::begin() {
  device.intf=BME68X_I2C_INTF; device.read=readRegisters; device.write=writeRegisters;
  device.delay_us=[](uint32_t us,void *) { if(us>=1000) delay((us+999)/1000); else delayMicroseconds(us); };
  device.amb_temp=25;
  if (bme68x_init(&device)!=BME68X_OK || device.chip_id!=BME68X_CHIP_ID) return false;
  config.os_hum=BME68X_OS_2X; config.os_pres=BME68X_OS_4X; config.os_temp=BME68X_OS_8X;
  config.filter=BME68X_FILTER_OFF; config.odr=BME68X_ODR_NONE;
  heater.enable=BME68X_ENABLE; heater.heatr_temp=320; heater.heatr_dur=150;
  return bme68x_set_conf(&config,&device)==BME68X_OK && bme68x_set_heatr_conf(BME68X_FORCED_MODE,&heater,&device)==BME68X_OK;
}
uint32_t A3Environment::start() {
  if(bme68x_set_op_mode(BME68X_FORCED_MODE,&device)!=BME68X_OK) return 0;
  return (bme68x_get_meas_dur(BME68X_FORCED_MODE,&config,&device)+999)/1000+heater.heatr_dur+10;
}
bool A3Environment::finish(bme68x_data &data) {
  uint8_t count=0;
  return bme68x_get_data(BME68X_FORCED_MODE,&data,&count,&device)==BME68X_OK && count>0 && (data.status&BME68X_NEW_DATA_MSK);
}
