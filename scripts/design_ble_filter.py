"""Reproduce the Bluetooth-only anti-alias FIR coefficients (Python standard library)."""
import math
from pathlib import Path

def i0(x):
    term = total = 1.0
    for n in range(1, 60):
        term *= x*x/(4*n*n); total += term
        if term < total*1e-16:
            break
    return total

def taps(cutoff):
    result = []
    for n in range(129):
        m = n-64; fc = cutoff/48000; beta = 7.85726
        sinc = 2*fc if m == 0 else math.sin(2*math.pi*fc*m)/(math.pi*m)
        result.append(sinc*i0(beta*math.sqrt(max(0, 1-(m/64)**2)))/i0(beta))
    scale = sum(result)
    return ',\n  '.join(', '.join(f'{v/scale:.10e}f' for v in result[i:min(i+4,65)]) for i in range(0,65,4))

header = '''#pragma once
#include <stddef.h>
#include <stdint.h>
#include <math.h>

// Bluetooth-only 48 -> 24/16 kHz. 129-tap symmetric Kaiser FIR, beta=7.85726,
// unity DC gain. 24k: pass <=10k/stop >=12k; 16k: pass <=6k/stop >=8k.
// Reproduce coefficients with scripts/design_ble_filter.py. Raw capture bypasses it.
class PalBleAudioFilter {
 public:
  static constexpr size_t DELAY_SAMPLES=64;
  void reset() {for(float &v:history)v=0;head=0;phase=0;}
  size_t process(const int32_t *input,size_t count,int16_t *output,unsigned rate) {
    if(rate!=16000 && rate!=24000)return 0;
    const unsigned factor=48000/rate;const float *taps=coefficients(rate);
    size_t written=0;
    for(size_t i=0;i<count;++i) {
      history[head]=input[i]/2147483648.0f;
      if(phase==0) {
        float value=0;
        for(size_t k=0;k<64;++k)value+=taps[k]*(at(k)+at(128-k));
        value+=taps[64]*at(64);
        float scaled=value*32768.0f;
        output[written++]=scaled>=32767?32767:scaled<=-32768?-32768:static_cast<int16_t>(lroundf(scaled));
      }
      phase=(phase+1)%factor;if(++head==129)head=0;
    }
    return written;
  }
 private:
  float at(size_t delay) const {return history[(head+129-delay)%129];}
  float history[129]={};size_t head=0;unsigned phase=0;
  static const float *coefficients(unsigned rate) {
  static constexpr float taps24[65]={
  @24@
  };
  static constexpr float taps16[65]={
  @16@
  };
  return rate==24000?taps24:taps16;
  }
};
'''
if __name__ == '__main__':
    path = Path(__file__).resolve().parent.parent / 'include/ble_audio_filter.h'
    path.write_text(header.replace('@24@', taps(11000)).replace('@16@', taps(7000)))
