#pragma once
#include <stddef.h>
#include <stdint.h>
#include <string.h>

// The wire protocol is a CRC-framed byte stream, independent of ATT boundaries.
// Fill notifications across message boundaries rather than wasting a radio slot
// on every short message tail. Only the transmitter task owns this buffer.
template <size_t Capacity> class PalBleStream {
 public:
  void reset() { used=0; since=0; }
  template <class Send> bool append(const uint8_t *bytes, size_t length, size_t limit, uint32_t now, Send send) {
    if (!limit || limit>Capacity || used>limit) {reset();return false;}
    while(length) {
      if(!used)since=now;
      const size_t count=length<limit-used?length:limit-used;
      memcpy(buffer+used,bytes,count);used+=count;bytes+=count;length-=count;
      if(used==limit && !flush(send))return false;
    }
    return true;
  }
  template <class Send> bool flush(Send send) {
    if(!used)return true;
    const bool ok=send(buffer,used);reset();return ok;
  }
  bool expired(uint32_t now,uint32_t maxAge) const {return used && static_cast<uint32_t>(now-since)>=maxAge;}
  size_t pending() const {return used;}
 private:
  uint8_t buffer[Capacity];size_t used=0;uint32_t since=0;
};
