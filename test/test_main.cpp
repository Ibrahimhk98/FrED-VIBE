#include <unity.h>
#include <string>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include "ima_adpcm.h"
#include "ble_packet.h"
#include "ble_imu.h"
#include "ble_stream.h"
#include "ble_audio_filter.h"
#include "board_a3.h"

static inline int32_t constrainVal(int32_t val, int32_t minVal, int32_t maxVal) {
  return val < minVal ? minVal : (val > maxVal ? maxVal : val);
}

std::string encodeBase64Test(const uint8_t *data, size_t length) {
  static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string encoded;
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

int8_t quantizePcm32To8(int32_t raw) {
  return static_cast<int8_t>(constrainVal(raw >> 24, -128, 127));
}

double calculateDbfs(double squareSum, uint32_t count) {
  constexpr double DBFS_FLOOR = -120.0;
  if (count == 0 || squareSum <= 0.0) return DBFS_FLOOR;
  const double rms = sqrt(squareSum / count);
  return std::max(DBFS_FLOOR, 20.0 * log10(rms));
}

void test_base64_encoding() {
  const uint8_t input[] = "PAL-V2";
  std::string result = encodeBase64Test(input, 6);
  TEST_ASSERT_EQUAL_STRING("UEFMLVYy", result.c_str());
}

void test_pcm_quantization() {
  // Max positive 32-bit sample should map to 127
  TEST_ASSERT_EQUAL_INT8(127, quantizePcm32To8(2147483647));
  // Zero sample should map to 0
  TEST_ASSERT_EQUAL_INT8(0, quantizePcm32To8(0));
  // Mid positive sample (0.5 full scale = 1073741824) should map to 64
  TEST_ASSERT_EQUAL_INT8(64, quantizePcm32To8(1073741824));
  // Negative full scale (-2147483648) should map to -128
  TEST_ASSERT_EQUAL_INT8(-128, quantizePcm32To8(-2147483648LL));
}

void test_dbfs_calculation() {
  // Full scale sine/square wave (rms = 1.0) -> 0.0 dBFS
  TEST_ASSERT_FLOAT_WITHIN(0.01f, 0.0f, static_cast<float>(calculateDbfs(1.0, 1)));
  // Half amplitude (rms = 0.5) -> -6.02 dBFS
  TEST_ASSERT_FLOAT_WITHIN(0.1f, -6.02f, static_cast<float>(calculateDbfs(0.25, 1)));
  // Zero amplitude -> -120.0 dBFS floor
  TEST_ASSERT_FLOAT_WITHIN(0.01f, -120.0f, static_cast<float>(calculateDbfs(0.0, 0)));
}


void test_a3_calibrated_battery_conversion() {
  TEST_ASSERT_FLOAT_WITHIN(0.005f, 4.2f, FredPal::batteryVolts(1042));
  TEST_ASSERT_FLOAT_WITHIN(0.005f, 3.7f, FredPal::batteryVolts(918));
  TEST_ASSERT_EQUAL_FLOAT(0.0f, FredPal::batteryVolts(0));
}

void test_adpcm_encoder_decoder_roundtrip() {
  constexpr size_t numSamples = 160; // 20 ms at 8 kHz
  int16_t originalPcm[numSamples];
  for (size_t i = 0; i < numSamples; ++i) {
    // Generate 440 Hz sine wave with 20000 peak amplitude
    originalPcm[i] = static_cast<int16_t>(20000.0f * sinf(2.0f * 3.14159265f * 440.0f * i / 8000.0f));
  }

  ImaAdpcmEncoder encoder;
  ImaAdpcmDecoder decoder;

  TEST_ASSERT_EQUAL_INT(0, encoder.getStepIndex());
  TEST_ASSERT_EQUAL_INT16(0, encoder.getPredictedSample());

  uint8_t adpcmOutput[numSamples / 2];
  const size_t encodedBytes = encoder.encodeBlock(originalPcm, numSamples, adpcmOutput);
  TEST_ASSERT_EQUAL_UINT32(numSamples / 2, encodedBytes);

  // Predictor step size should adapt upwards from 0 during strong signal variations
  TEST_ASSERT_TRUE(encoder.getStepIndex() > 0);

  int16_t decodedPcm[numSamples];
  const size_t decodedSamples = decoder.decodeBlock(adpcmOutput, encodedBytes, decodedPcm);
  TEST_ASSERT_EQUAL_UINT32(numSamples, decodedSamples);

  // Encoder and Decoder predictor state must stay perfectly synchronized
  TEST_ASSERT_EQUAL_INT16(encoder.getPredictedSample(), decoder.getPredictedSample());
  TEST_ASSERT_EQUAL_INT(encoder.getStepIndex(), decoder.getStepIndex());

  // Calculate Signal-to-Noise Ratio (SNR) in dB (skipping initial 10-sample predictor ramp-up)
  double signalPower = 0.0;
  double noisePower = 0.0;
  for (size_t i = 10; i < numSamples; ++i) {
    const double orig = originalPcm[i];
    const double diff = orig - decodedPcm[i];
    signalPower += orig * orig;
    noisePower += diff * diff;
  }

  TEST_ASSERT_TRUE(signalPower > 0.0);
  TEST_ASSERT_TRUE(noisePower > 0.0);

  const double snrDb = 10.0 * log10(signalPower / noisePower);
  // 4-bit IMA-ADPCM achieves >15 dB SNR fidelity during steady-state tracking
  TEST_ASSERT_TRUE(snrDb > 15.0);
}

void test_self_contained_audio_exact_length() {
  for (size_t count : {1, 2, 3, 1600}) {
    int16_t input[1600], output[1601];
    for (size_t i = 0; i < count; ++i) input[i] = static_cast<int16_t>(1000 + 100 * sin(i * .1));
    output[count] = 12345;
    uint8_t block[804];
    ImaAdpcmEncoder encoder;
    ImaAdpcmDecoder decoder;
    size_t bytes = encoder.encodeBlockSelfContained(input, count, block);
    TEST_ASSERT_EQUAL_UINT32(4 + count / 2, bytes);
    TEST_ASSERT_EQUAL_UINT32(count, decoder.decodeBlockSelfContained(block, bytes, output, count));
    TEST_ASSERT_EQUAL_INT16(input[0], output[0]);
    TEST_ASSERT_EQUAL_INT16(12345, output[count]);
    TEST_ASSERT_EQUAL_UINT32(0, decoder.decodeBlockSelfContained(block, bytes - 1, output, count));
  }
}

void test_ble_wire_checksum_and_endianness() {
  const uint8_t vector[] = {'1','2','3','4','5','6','7','8','9'};
  TEST_ASSERT_EQUAL_HEX32(0xcbf43926, palCrc32(vector, sizeof(vector)));
  uint8_t bytes[8] = {};
  palWriteLE(bytes, 0x1122334455667788ULL, 8);
  const uint8_t expected[] = {0x88,0x77,0x66,0x55,0x44,0x33,0x22,0x11};
  TEST_ASSERT_EQUAL_UINT8_ARRAY(expected, bytes, 8);
}

void test_compact_imu_packet() {
  PalBleImuRecord rows[2] = {{5000000000ULL,1793967805123ULL,17,1,{-32768,0,32767}},
    {4999999991ULL,1793967805122ULL,18,2,{-1,2048,-2048}}};
  uint8_t bytes[74] = {};
  TEST_ASSERT_EQUAL_UINT32(74,palEncodeBleImu(bytes,sizeof(bytes),0x88cda63f1fb8ULL,123,4,5,6,true,rows,2));
  TEST_ASSERT_EQUAL_HEX8(0xb8,bytes[0]);TEST_ASSERT_EQUAL_HEX8(0x88,bytes[5]);
  TEST_ASSERT_EQUAL_UINT8(2,bytes[39]);TEST_ASSERT_EQUAL_UINT8(1,bytes[46]);
  TEST_ASSERT_EQUAL_HEX8(0x80,bytes[48]);TEST_ASSERT_EQUAL_HEX8(0x7f,bytes[52]);
  TEST_ASSERT_EQUAL_HEX8(0xf7,bytes[57]);TEST_ASSERT_EQUAL_HEX8(0xff,bytes[60]);
  TEST_ASSERT_EQUAL_HEX8(0xff,bytes[61]);TEST_ASSERT_EQUAL_UINT8(2,bytes[63]);
  TEST_ASSERT_EQUAL_UINT8(18,bytes[70]);
  uint8_t rated[76]={};
  TEST_ASSERT_EQUAL_UINT32(76,palEncodeBleImu(rated,sizeof(rated),0,1,2,3,4,true,rows,2,416));
  TEST_ASSERT_EQUAL_HEX8(0xa0,rated[40]);TEST_ASSERT_EQUAL_HEX8(0x01,rated[41]);
  TEST_ASSERT_EQUAL_UINT8(1,rated[48]);TEST_ASSERT_EQUAL_UINT8(2,rated[65]);
  TEST_ASSERT_EQUAL_UINT32(0,palEncodeBleImu(bytes,73,0,0,0,0,0,true,rows,2));
  rows[1].timeMs+=40000;
  TEST_ASSERT_EQUAL_UINT32(0,palEncodeBleImu(bytes,sizeof(bytes),0,0,0,0,0,true,rows,2));
}

void test_ble_stream_packs_messages_and_bounds_tail() {
  PalBleStream<495> stream;
  uint8_t input[2000],output[2000];size_t written=0,calls=0;
  for(size_t i=0;i<sizeof(input);++i)input[i]=i%251;
  auto send=[&](const uint8_t *p,size_t n) {memcpy(output+written,p,n);written+=n;++calls;return true;};
  TEST_ASSERT_TRUE(stream.append(input,556,495,100,send));
  TEST_ASSERT_EQUAL_UINT32(61,stream.pending());TEST_ASSERT_EQUAL_UINT32(1,calls);
  TEST_ASSERT_FALSE(stream.expired(129,30));TEST_ASSERT_TRUE(stream.expired(130,30));
  TEST_ASSERT_TRUE(stream.append(input+556,1444,495,120,send));
  TEST_ASSERT_EQUAL_UINT32(4,calls);TEST_ASSERT_EQUAL_UINT32(20,stream.pending());
  TEST_ASSERT_TRUE(stream.flush(send));TEST_ASSERT_EQUAL_UINT32(5,calls);
  TEST_ASSERT_EQUAL_UINT8_ARRAY(input,output,2000);
  auto fail=[](const uint8_t*,size_t){return false;};
  TEST_ASSERT_FALSE(stream.append(input,600,244,200,fail));TEST_ASSERT_EQUAL_UINT32(0,stream.pending());
  TEST_ASSERT_TRUE(stream.append(input,10,244,0xfffffff0,send));
  TEST_ASSERT_TRUE(stream.expired(20,30));stream.reset();TEST_ASSERT_EQUAL_UINT32(0,stream.pending());
}

void test_ble_audio_decimation_preserves_passband_rejects_aliases() {
  int32_t input[960];int16_t output[480];
  for(unsigned rate : {16000U,24000U}) {
    for(double frequency : {1000.0,rate==24000?10000.0:6000.0,rate==24000?14000.0:10000.0}) {
      PalBleAudioFilter filter;double sum=0;size_t samples=0;
      for(int block=0;block<6;++block) {
        for(size_t i=0;i<960;++i)input[i]=static_cast<int32_t>(1073741824.0*sin(2*3.141592653589793*frequency*(block*960+i)/48000));
        const size_t n=filter.process(input,960,output,rate);TEST_ASSERT_EQUAL_UINT32(rate/50,n);
        if(block)for(size_t i=0;i<n;++i){const double v=output[i]/32768.0;sum+=v*v;++samples;}
      }
      const double gain=sqrt(sum/samples)/sqrt(0.125);
      if(frequency<rate/2)TEST_ASSERT_FLOAT_WITHIN(.002f,1.0f,static_cast<float>(gain));
      else TEST_ASSERT_TRUE(gain<.0002); // >74 dB alias rejection, including int16 quantization
    }
  }
  PalBleAudioFilter f;std::fill(input,input+960,1073741824);
  f.process(input,960,output,24000);TEST_ASSERT_INT_WITHIN(1,16384,output[479]);
  f.reset();std::fill(input,input+960,0);f.process(input,960,output,24000);
  TEST_ASSERT_EQUAL_INT16(0,output[479]);
}

int main(int argc, char **argv) {
  UNITY_BEGIN();
  RUN_TEST(test_a3_calibrated_battery_conversion);
  RUN_TEST(test_base64_encoding);
  RUN_TEST(test_pcm_quantization);
  RUN_TEST(test_dbfs_calculation);
  RUN_TEST(test_adpcm_encoder_decoder_roundtrip);
  RUN_TEST(test_self_contained_audio_exact_length);
  RUN_TEST(test_ble_wire_checksum_and_endianness);
  RUN_TEST(test_compact_imu_packet);
  RUN_TEST(test_ble_stream_packs_messages_and_bounds_tail);
  RUN_TEST(test_ble_audio_decimation_preserves_passband_rejects_aliases);
  return UNITY_END();
}


