#pragma once
#include "ble_packet.h"
#include <limits.h>

struct PalBleImuRecord {
  uint64_t monotonicUs, timeMs;
  uint32_t sequence;
  uint8_t tag;
  int16_t xyz[3];
};
constexpr size_t PAL_BLE_IMU_HEADER = 40, PAL_BLE_IMU_ROW = 17;
// Kind 3 preserves native tagged records; only timestamps use lossless deltas.
inline size_t palEncodeBleImu(uint8_t *out, size_t capacity, uint64_t device,
    uint32_t stream, uint32_t segment, uint32_t overruns, uint32_t dropped,
    bool clockSynced, const PalBleImuRecord *rows, size_t count, uint16_t rateHz=0) {
  const size_t header = PAL_BLE_IMU_HEADER + (rateHz ? 2 : 0);
  const size_t length = header + count * PAL_BLE_IMU_ROW;
  if (!count || count > 32 || capacity < length) return 0;
  palWriteLE(out, device, 6); palWriteLE(out+6, rows[0].timeMs, 8);
  palWriteLE(out+14, rows[0].monotonicUs, 8);
  palWriteLE(out+22, stream, 4); palWriteLE(out+26, segment, 4);
  palWriteLE(out+30, overruns, 4); palWriteLE(out+34, dropped, 4);
  out[38] = clockSynced; out[39] = count;
  if(rateHz)palWriteLE(out+40,rateHz,2); // kind 4 adds the actual IMU ODR
  for (size_t i=0;i<count;++i) {
    const auto &r=rows[i];
    const int64_t us=static_cast<int64_t>(r.monotonicUs)-static_cast<int64_t>(rows[0].monotonicUs);
    const int64_t ms=static_cast<int64_t>(r.timeMs)-static_cast<int64_t>(rows[0].timeMs);
    if (us<INT32_MIN || us>INT32_MAX || ms<INT16_MIN || ms>INT16_MAX || (r.tag!=1 && r.tag!=2)) return 0;
    uint8_t *p=out+header+i*PAL_BLE_IMU_ROW;
    palWriteLE(p,static_cast<uint32_t>(us),4); palWriteLE(p+4,static_cast<uint16_t>(ms),2);
    p[6]=r.tag;
    for (int axis=0;axis<3;++axis) palWriteLE(p+7+axis*2,static_cast<uint16_t>(r.xyz[axis]),2);
    palWriteLE(p+13,r.sequence,4);
  }
  return length;
}
