#pragma once
#include <stddef.h>
#include <stdint.h>

inline uint32_t palCrc32(const uint8_t *data, size_t length) {
  uint32_t crc = 0xffffffff;
  for (size_t i = 0; i < length; ++i) {
    crc ^= data[i];
    for (int bit = 0; bit < 8; ++bit) crc = (crc >> 1) ^ (0xedb88320u & (0u - (crc & 1)));
  }
  return crc ^ 0xffffffff;
}
inline void palWriteLE(uint8_t *target, uint64_t value, size_t bytes) {
  for (size_t i = 0; i < bytes; ++i) target[i] = static_cast<uint8_t>(value >> (8 * i));
}
