export function setupSamplingPanel({getState,sendCommand,onBusy}) {
 const $=id=>document.getElementById(id);let applying=false,lastKey='',errorMessage='',lastActive=null;
 function render() {
  const {active,recording,firmwareBusy}=getState(),config=active?.configuration;
  if(active!==lastActive){errorMessage='';lastKey='';lastActive=active;}
  const key=`${active?.deviceIdentity?.id}/${config?.ble_audio_rate_hz}/${config?.imu?.odr_hz}`;
  if(key!==lastKey && config?.sampling_control) {
   $('bleAudioRate').value=String(config.ble_audio_rate_hz);$('imuRate').value=String(config.imu.odr_hz);lastKey=key;
  }
  const disabled=!config?.sampling_control || recording || firmwareBusy || applying;
  for(const id of ['bleAudioRate','imuRate','applySampling'])$(id).disabled=disabled;
  $('samplingCurrent').textContent=config ? `On board: Bluetooth audio ${config.ble_audio_rate_hz?config.ble_audio_rate_hz/1000+' kHz':'48 kHz (older firmware)'} · IMU ${config.imu?.odr_hz??'—'} Hz · USB/Wi-Fi audio 48 kHz raw` : 'Connect a kit to read sampling settings.';
  if(!applying)$('samplingStatus').textContent=errorMessage || (recording?'Stop recording to change sampling rates.':config&&!config.sampling_control?'Update the firmware to enable sampling controls.':'Settings apply to this kit until restart. Higher rates use more Bluetooth bandwidth.');
 }
 $('applySampling').onclick=async()=>{
  const state=getState();if(applying || !state.active?.configuration?.sampling_control || state.recording || state.firmwareBusy)return;
  applying=true;errorMessage='';onBusy(true);render();$('samplingStatus').textContent='Applying and checking sensor settings…';
  try{await sendCommand({cmd:'set_sampling',ble_audio_hz:Number($('bleAudioRate').value),imu_hz:Number($('imuRate').value)});}
  catch(error){errorMessage=error.message;}
  finally{applying=false;onBusy(false);render();}
 };
 return {render};
}
