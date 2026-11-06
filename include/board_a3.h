#pragma once
#include <stdint.h>
namespace FredPal {
constexpr int I2C_SDA=8, I2C_SCL=9;
constexpr int IMU_SCK=12, IMU_MOSI=11, IMU_MISO=13, IMU_CS=10;
constexpr int IMU_INT1=14, IMU_INT2=15, RTC_INT=7;
constexpr int MIC_BCLK=4, MIC_WS=5, MIC_SD=6;
constexpr int BAT_ADC=1, STATUS_LED=2, UART_TX=43, UART_RX=44;
constexpr int USB_DM=19, USB_DP=20;
constexpr int EXT_SPI_SCK=40, EXT_SPI_MOSI=41, EXT_SPI_MISO=42, EXT_SPI_CS=47;
constexpr uint32_t I2C_HZ=100000, IMU_SPI_HZ=1000000;
constexpr uint8_t BME688_ADDRESS=0x76, DS3231_ADDRESS=0x68;
constexpr uint32_t AUDIO_SAMPLE_RATE=48000, AUDIO_SETTLING_FRAMES=4224;
constexpr float BATTERY_DIVIDER=1330000.0f/330000.0f;
constexpr float batteryVolts(uint32_t adcMv) { return adcMv * BATTERY_DIVIDER / 1000.0f; }
}
