import { Orientation, ImuPreview } from './orientation.js';
import { DeviceView } from './device-view.js';
import { audioEnvelope, audioIntegrity } from './audio-timeline.js';
import { setupFirmwarePanel } from './firmware.js';
import { setupSamplingPanel } from './sampling.js';
import { setupDeviceDialog } from './setup.js';
import { decodeAudio, LineParser } from './protocol.js';
import { BlePacketParser } from './ble-protocol.js';
import { newSession, sessionCount, MAX_RECORDING_BYTES, ENV_FIELDS, IMU_FIELDS } from './session.js';
import { hdf5Job, download } from './files.js';
import { loadKits, rememberKit, validHost, availableKits, KIT_STORAGE_KEY } from './kits.js';
import { createExplorerWindow } from './workspace.js';
import { loadRecordingFolder, rememberRecordingFolder, ensureFolderWritePermission, recordingFilename, writeRecordingFile } from './recording-location.js';
const $ = id => document.getElementById(id);
const setupDialog=setupDeviceDialog();
const orientation = new Orientation(), imuPreview = new ImuPreview(), deviceView = new DeviceView($('deviceRender'));
let lastMotionAt = -Infinity, motionKey = '';
function resetMotion() {orientation.reset();imuPreview.reset();lastMotionAt=-Infinity;motionKey='';}
$('trimOrientation').onclick = () => {
  if(performance.now()-lastMotionAt>=1500)return;
  orientation.cancelTrim();$('trimProgress').textContent='Place the board flat before starting.';$('trimDialog').showModal();
};
$('startTrim').onclick = () => {if(performance.now()-lastMotionAt<1500)orientation.beginTrim();};
$('cancelTrim').onclick = () => {orientation.cancelTrim();$('trimDialog').close();};
$('trimDialog').addEventListener('cancel',()=>orientation.cancelTrim());
$('resetOrientation').onclick = () => orientation.clearTrim();
let lastRenderAt=0;
function renderDevice(now) {
  if(now-lastRenderAt>=32) {
    const live=!!active && now-lastMotionAt<1500;
    deviceView.draw(orientation.pose,live);
    $('trimOrientation').disabled=!live || !orientation.ready || orientation.calibrating;
    $('resetOrientation').disabled=!orientation.trimmed;
    $('startTrim').disabled=!live || orientation.calibrating;
    if($('trimDialog').open && orientation.calibrating) $('trimProgress').textContent=!live ? 'Waiting for fresh motion samples…' : orientation.trimState.phase==='moving' ? 'Movement detected. Keep the board still on the flat surface.' : `Keep still… ${Math.round(orientation.trimState.progress*100)}%`;
    if($('trimDialog').open && orientation.trimState.phase==='complete') {$('trimDialog').close();status('Flat-surface trim complete. World Z is up; heading is relative.');}
    $('orientationState').textContent=live ? (orientation.calibrating?'Calibrating · keep the board flat and still':orientation.trimmed?'Live · flat-surface calibrated · Z up':'Live · gravity reference · place flat and trim') : orientation.ready?'Motion paused · no recent samples':'Waiting for motion data';
    const angles=orientation.angles;
    ['Roll','Pitch','Yaw'].forEach((name,i)=>$('pose'+name).textContent=orientation.ready?`${angles[i].toFixed(1)}°`:'—');
    lastRenderAt=now;
  }
  requestAnimationFrame(renderDevice);
}
requestAnimationFrame(renderDevice);
const SERVICE = '7f510001-5b8d-4a84-9c7c-a07142ab6002', DATA = '7f510002-5b8d-4a84-9c7c-a07142ab6002', COMMAND = '7f510003-5b8d-4a84-9c7c-a07142ab6002';
let active, connecting = false, handoff = false, handoffTimer, recording = false, session = newSession();
let firmwareBusy=false, firmwarePanel, samplingBusy=false, samplingPanel;
let previousFrame, missingFrames = 0, malformed = 0, lastAudioAt = 0, lastFrame, exporting = false, unsaved = false;
let commandChain = Promise.resolve();
let recordingFolder = null, folderBusy = true;
const canChooseFolder = typeof window.showDirectoryPicker === 'function';
let kitStorage;
try { kitStorage = localStorage; } catch {}
let kits = loadKits(kitStorage);
let discoveredKits = [], discovering = false, renderedKitState = '';
const allKits = () => availableKits(kits, discoveredKits);
const histories = {accel:[], gyro:[]};
let waveFrames = [];
function status(message) { $('status').textContent = message; $('pulseDot').className = `pulse-dot ${recording ? 'recording' : active ? 'connected' : ''}`; }
function controls() {
  for (const id of ['usb','usbBridge','ble','wifiConnect']) $(id).disabled = connecting || firmwareBusy;
  $('disconnectBtn').disabled=firmwareBusy || !active;
  $('openSetup').textContent=active?'Device settings':'Connect / device setup';
  $('record').disabled = recording || !active?.deviceIdentity || exporting || firmwareBusy || samplingBusy;
  $('stop').disabled = !recording;
  $('clock').disabled = !active || recording;
  $('wifiEnable').disabled = !active || active.kind === 'ws' || handoff;
  $('wifiOff').disabled = !active;
  $('save').disabled = recording || exporting || folderBusy || !sessionCount(session);
  $('chooseRecordingFolder').disabled = !canChooseFolder || folderBusy || exporting;
  $('useDownloads').disabled = !recordingFolder || folderBusy || exporting;
  $('clear').disabled = recording || exporting;
  $('recCounter').style.display = recording ? 'inline-flex' : 'none';
  firmwarePanel?.render();
  samplingPanel?.render();
}
function recordSize(bytes) {
  unsaved = true;
  session.bytes += bytes;
  if (session.bytes >= MAX_RECORDING_BYTES) { stopRecording(); status('Recording memory limit reached. Export this session before starting another.'); }
}
function packet(data, channel) {
  if (channel !== active) return;
  if (typeof data.device_id === 'string') {
    const identity = {id:data.device_id, name:data.device_name ||
      (channel.deviceIdentity?.id === data.device_id && channel.deviceIdentity.name) ||
      (/^[a-f0-9]{12}$/i.test(data.device_id) ? `PAL-${data.device_id.slice(-6)}` : data.device_id)};
    if (channel.expectedDeviceId && channel.expectedDeviceId !== identity.id) {
      lost(channel, `This address belongs to ${identity.name}, not the selected kit. Update the selected kit's address and reconnect.`);
      closeChannel(channel); return;
    }
    if (recording && session.device && session.device.id !== identity.id) {
      stopRecording(); status('Kit identity changed. Recording stopped to keep kits separate.');
    }
    channel.deviceIdentity = identity;
    channel.hostname = data.hostname || channel.hostname || (/^[a-f0-9]{12}$/i.test(identity.id) ? `pal-${identity.id}.local` : '');
    if (data.state === 'wifi_connected' && data.ip) channel.wifiIp = data.ip;
    $('deviceIdentity').textContent = `${identity.name} · ID ${identity.id} · ${channel.hostname}${channel.kind === 'ws' ? ' · Wi-Fi address: '+channel.host : channel.wifiIp ? ' · Wi-Fi IP: '+channel.wifiIp : ''}`;
    if (channel.kind === 'ws' && !channel.remembered) {saveKit(identity, channel.host);channel.remembered=true;}
    if (data.state === 'wifi_connected' && data.ip) saveKit(identity, data.ip);
  }
  if (data.type === 'configuration') {
    channel.configuration = data;
    if(recording) {session.configuration=structuredClone(data);recordSize(JSON.stringify(data).length);}
  }
  if (data.clock_synced === false) {
    $('deviceTime').textContent='Time not synchronized';$('clockDrift').textContent='Sync RTC to PC before recording UTC timestamps';
  } else if (Number.isFinite(data.time_ms) && data.time_ms > 1577836800000) {
    $('deviceTime').textContent = new Date(data.time_ms).toLocaleTimeString([], {hour12:false});
    $('clockDrift').textContent = `Clock offset vs PC: ${((Date.now() - data.time_ms) / 1000).toFixed(2)} s`;
  }
  if (data.type === 'status') {
    channel.commandStatus?.(data);
    if (data.state === 'wifi_connected' && data.ip) {
      if (handoff || !$('kitSelect').value || $('kitSelect').value === channel.deviceIdentity?.id) $('wifiHost').value = data.ip;
      if (handoff && !connecting) connectWifi(data.ip);
    } else if (['wifi_error', 'command_error'].includes(data.state)) {
      handoff = false; clearTimeout(handoffTimer); controls();
    }
    if (!(data.state === 'wifi_connected' && connecting)) status(`${data.state}: ${data.detail || data.ip || ''}`);
    return;
  }
  if (data.type === 'health') {
    if(channel.kind==='ble')$('radioHealth').textContent=`Bluetooth interval ${data.ble_interval_ms??'unknown'} ms · notification payload ${data.ble_att_payload??'unknown'} bytes · transmit retries ${data.ble_notify_retries??'unknown'} · audio queue high-water ${data.audio_queue_high_water??'unknown'} frames · failed Bluetooth messages ${data.ble_dropped??0}`;
    if(Number.isFinite(data.battery_v)) {$('batVal').textContent=`${data.battery_v.toFixed(3)} V`;$('batStatus').textContent='J2 BAT+ terminal · measured through GPIO1';}
    $('sensorHealth').textContent=`IMU ${data.imu_ready?'ready':'unavailable'} · environment ${data.bme_ready?'ready':'unavailable'} · microphone ${data.mic_ready?'ready':'unavailable'} · IMU overruns ${data.imu_overruns??0} · telemetry drops ${data.telemetry_dropped??0}`;
    if(recording) {session.health.push(data);recordSize(1024);}
  }
  if (data.type === 'telemetry' && Array.isArray(data.imu_raw)) {
    const {raw,pairs,key}=imuPreview.consume(data);
    if(key!==motionKey) {orientation.reset();motionKey=key;}
    for(const pair of pairs) {
      if(orientation.update(pair.accel,pair.gyro,pair.monotonic_us/1000)) lastMotionAt=performance.now();
      histories.accel.push(pair.accel);histories.gyro.push(pair.gyro);
      const values=[...pair.accel,...pair.gyro];
      ['Ax','Ay','Az','Gx','Gy','Gz'].forEach((id,i)=>$('val'+id).textContent=values[i].toFixed(2));
      if(recording) {session.imu.push(Object.fromEntries([['time_ms',pair.time_ms],...IMU_FIELDS.map((f,i)=>[f,values[i]])]));recordSize(128);}
    }
    if(recording) {session.imu_raw.push(...raw);recordSize(raw.length*160);}
    histories.accel=histories.accel.slice(-300);histories.gyro=histories.gyro.slice(-300);
  }
  if (data.type === 'environment') {
    showEnv(data);
    if (recording) {
      session.environment.push({...data,...Object.fromEntries(['time_ms', ...ENV_FIELDS].map(f => [f, data[f]==null ? NaN : Number(data[f])]))});
      recordSize(160);
    }
  }
  if (data.type === 'telemetry' && Array.isArray(data.imu)) {
    for (const s of data.imu) {
      if (s.length !== 7 || !s.every(Number.isFinite)) continue;
      const accel = s.slice(1,4), gyro = s.slice(4,7);
      histories.accel.push(accel); histories.gyro.push(gyro);
      ['Ax','Ay','Az','Gx','Gy','Gz'].forEach((id, i) => $('val' + id).textContent = s[i+1].toFixed(2));
      if (recording) {
        session.imu.push(Object.fromEntries([['time_ms', data.time_ms + s[0]], ...IMU_FIELDS.map((f,i) => [f,s[i+1]])]));
        recordSize(128);
      }
    }
    histories.accel = histories.accel.slice(-300); histories.gyro = histories.gyro.slice(-300);
  }
  if (data.type === 'audio') {
    const frame = decodeAudio(data, channel.kind === 'bridge' ? 'usb' : channel.kind);
    // Store the decoded frame before preview work; plotting never gates recording.
    if (recording) { session.audio.push(frame); recordSize(frame.pcm.byteLength + 256); }
    if (previousFrame && frame.stream_id === previousFrame.stream_id && frame.sequence > previousFrame.sequence)
      missingFrames += Math.max(0, frame.sequence - previousFrame.sequence - 1);
    previousFrame = frame; lastFrame = frame; lastAudioAt = performance.now();
    waveFrames.push(frame);
    waveFrames=waveFrames.filter(f=>f.stream_id===frame.stream_id && f.time_ms+f.pcm.length*1000/f.rate>frame.time_ms-500).slice(-64);
  }
  controls();
}
function makeChannel(kind) {
  const channel = {kind, closing:false};
  channel.parser = new LineParser(data => packet(data, channel), () => { malformed++; if (recording) session.malformed++; }, {usbBootLog:kind === 'usb' || kind === 'bridge'});
  return channel;
}
function lost(channel, message) {
  channel.commandStatus?.({state:'command_error', detail:message});
  if (active !== channel) return;
  active = null;
  if (handoff) { controls(); return; }
  if (recording) stopRecording();
  status(message); controls();
}
async function closeChannel(channel) {
  if (!channel) return;
  channel.closing = true;
  if (channel.kind === 'usb') {
    try { await channel.reader?.cancel(); } catch {}
    try { await channel.readTask; } catch {}
    try { channel.writer?.releaseLock(); } catch {}
    try { await channel.port.close(); } catch {}
  } else if (channel.kind === 'ble') {
    try { channel.device.gatt.disconnect(); } catch {}
  } else channel.socket.close();
}
async function disconnect() {
  handoff = false; clearTimeout(handoffTimer);
  if (recording) stopRecording();
  const old = active; active = null; await closeChannel(old);
  controls(); status('Disconnected. Your recording is retained.');
}
async function activate(channel) {
  const old = active;
  if (recording && !handoff) stopRecording();
  active = channel;
  resetMotion();
  missingFrames = 0; malformed = 0; lastFrame = undefined;
  previousFrame = undefined; waveFrames = []; lastAudioAt = performance.now();
  handoff = false; clearTimeout(handoffTimer);
  await closeChannel(old);
  status(`Connected via ${{usb:'USB',bridge:'USB bridge',ble:'Bluetooth',ws:'Wi-Fi'}[channel.kind]}`); controls();
  setupDialog.connected();
}
async function connectUsb() {
  if (!navigator.serial) { status('Web Serial requires Chrome or Edge on localhost.'); return; }
  connecting = true; controls();
  let channel;
  try {
    const port = await navigator.serial.requestPort();
    await disconnect();
    await port.open({baudRate:230400, bufferSize:65536});
    channel = makeChannel('usb'); channel.port = port;
    channel.writer = port.writable.getWriter(); channel.reader = port.readable.getReader();
    await activate(channel);
    channel.readTask = (async () => {
      const decoder = new TextDecoder();
      try {
        while (!channel.closing) {
          const {value, done} = await channel.reader.read(); if (done) break;
          channel.parser.push(decoder.decode(value, {stream:true}));
        }
      } catch (e) { if (!channel.closing) status(`USB: ${e.message}`); }
      finally { channel.reader.releaseLock(); if (!channel.closing) { lost(channel, 'USB disconnected. Recording stopped.'); closeChannel(channel); } }
    })();
    await sendCommand({cmd:'get_config'});
  } catch (e) { if (channel) await closeChannel(channel); status(`USB: ${e.message}`); }
  finally { connecting = false; controls(); }
}
async function connectBle() {
  if (!navigator.bluetooth) { status('Web Bluetooth requires a supported Chrome or Edge installation.'); return; }
  connecting = true; controls(); let channel;
  try {
    const device = await navigator.bluetooth.requestDevice({filters:[{services:[SERVICE]}, {namePrefix:'PAL-'}], optionalServices:[SERVICE]});
    await disconnect(); channel = makeChannel('ble'); channel.device = device;
    device.addEventListener('gattserverdisconnected', () => lost(channel, 'Bluetooth disconnected. Reconnect to continue.'));
    const server = await device.gatt.connect(), service = await server.getPrimaryService(SERVICE);
    channel.command = await service.getCharacteristic(COMMAND);
    status('Securing Bluetooth connection. Accept pairing if prompted.');
    // An encrypted read completes pairing before any credential bytes are sent.
    await withTimeout(channel.command.readValue(), 30000);
    channel.data = await service.getCharacteristic(DATA);
    channel.parser = new BlePacketParser(data => packet(data,channel), () => {malformed++; if(recording)session.malformed++;});
    channel.data.addEventListener('characteristicvaluechanged', e => channel.parser.push(e.target.value));
    await activate(channel); await channel.data.startNotifications();
    // The subscription's first notification can arrive before the central has
    // completed CCCD setup. Request configuration after notifications are ready.
    await sendCommand({cmd:'get_config'});
  } catch (e) { if (channel) { if (active === channel) active = null; await closeChannel(channel); } status(`Bluetooth: ${e.message}`); }
  finally { connecting = false; controls(); }
}
async function connectWifi(host = $('wifiHost').value.trim(), bridge = false) {
  if (!validHost(host)) { status('Enter the ESP32 IP address or local hostname.'); return; }
  if (location.protocol === 'https:') { status('Open http://localhost:8000 to connect to the local ESP32 WebSocket.'); return; }
  if (connecting) return;
  connecting = true; controls(); const channel = makeChannel(bridge ? 'bridge' : 'ws'); channel.host = host;
  const selectedKit = !bridge && allKits().find(kit => kit.id === $('kitSelect').value && kit.host === host);
  if (selectedKit && !selectedKit.id.startsWith('host:')) channel.expectedDeviceId = selectedKit.id;
  try {
    const socket = channel.socket = new WebSocket(bridge ? 'ws://127.0.0.1:8766/' : `ws://${host}:81/`);
    socket.onmessage = event => { if (typeof event.data === 'string') channel.parser.push(event.data); };
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('Connection timed out; check the IP and network')); }, 10000);
      socket.onopen = () => { clearTimeout(timer); resolve(); };
      socket.onerror = () => { clearTimeout(timer); reject(new Error('Unable to connect; check the local-network permission and network')); };
      socket.onclose = () => { clearTimeout(timer); reject(new Error('Socket closed before connecting')); };
    });
    socket.onclose = () => lost(channel, bridge ? 'USB bridge disconnected. Check the cable and local bridge.' : 'Wi-Fi disconnected. Reconnect by IP or Bluetooth.');
    socket.onerror = () => status(bridge ? 'USB bridge connection error' : 'Wi-Fi connection error');
    await activate(channel);
    await sendCommand({cmd:'get_config'});
  } catch (e) {
    channel.socket?.close(); handoff = false; clearTimeout(handoffTimer);
    if (!active && recording) stopRecording();
    status(bridge ? `USB bridge: ${e.message}. Start scripts/usb_bridge.py and retry.` : `Wi-Fi: ${e.message}. Bluetooth is available for retry.`);
  } finally { connecting = false; controls(); }
}
function withTimeout(promise, ms = 10000) {
  let timer;
  return Promise.race([promise, new Promise((_,reject) => {timer=setTimeout(()=>reject(new Error('Device command timed out; reconnect and retry')),ms);})]).finally(()=>clearTimeout(timer));
}
function sendCommand(command) {
  const channel = active;
  const run = async () => {
    if (!channel || channel !== active) throw new Error('Connect a device first');
    const payload = new TextEncoder().encode(JSON.stringify(command) + '\n');
    if (payload.length > 768) throw new Error('Command too long');
    const expected = {set_sampling:['sampling_applied'],set_time:['clock_set'], wifi_on:['wifi_connecting'], wifi_status:['wifi_status','wifi_connected']}[command.cmd];
    let acknowledge, failure;
    const confirmed = expected ? new Promise((resolve, reject) => {acknowledge=resolve; failure=reject;}) : Promise.resolve();
    // Install before writing: the device may respond before the final ATT ACK.
    if (expected) channel.commandStatus = data => {
      if (expected.includes(data.state)) acknowledge();
      else if (data.state === 'command_error') failure(new Error(data.detail || 'Device rejected command'));
    };
    confirmed.catch(() => {}); // a disconnect may arrive while writing
    try {
      if (channel.kind === 'usb') await withTimeout(channel.writer.write(payload));
      else if (channel.kind === 'ws' || channel.kind === 'bridge') channel.socket.send(new TextDecoder().decode(payload));
      else for (let offset = 0; offset < payload.length; offset += 20) {
        await withTimeout(channel.command.writeValueWithResponse(payload.slice(offset, offset + 20)));
      }
      await withTimeout(confirmed);
    } finally {
      channel.commandStatus = null;
    }
  };
  const result = commandChain.then(run); commandChain = result.catch(async (error) => {
    if (error.message.includes('timed out') && active === channel) { lost(channel, error.message); await closeChannel(channel); }
  }); return result;
}
function startRecording() {
  if (!active || firmwareBusy || samplingBusy) return;
  if (sessionCount(session) && !confirm('Start a new recording? Export the current session first if you want to keep it.')) return;
  session = newSession(); session.device = {...active.deviceIdentity}; session.configuration = active.configuration ? structuredClone(active.configuration) : null; recording = true; unsaved = true; controls(); status('Recording acoustic samples, motion and environment');
}
function stopRecording() {
  recording = false; session.ended = Date.now(); controls();
  const integrity=audioIntegrity(session.audio);
  status(`Recording stopped: ${session.audio.length} audio frames · ${integrity.missingFrames} missing audio frames (${(integrity.missingMs/1000).toFixed(3)} s) · ${session.imu.length} IMU samples · ${session.environment.length} environmental readings`);
}
function renderKits(selected = $('kitSelect').value) {
  const state = JSON.stringify([selected, allKits().map(({id,name,host,addresses,discovered}) => ({id,name,host,addresses,discovered})), kits.map(k=>k.id)]);
  if (state === renderedKitState) return; // Polling must not dismiss an open selector or steal focus.
  renderedKitState = state;
  $('kitSelect').replaceChildren(new Option('Choose a kit…',''));
  for(const kit of allKits()) $('kitSelect').add(new Option(`${kit.name} · ${kit.host} · ${kit.discovered ? 'discovered' : 'saved'}`,kit.id));
  $('kitSelect').value = selected;
  $('forgetKit').disabled = !kits.some(k => k.id === $('kitSelect').value);
  $('networkKits').replaceChildren();
  for (const kit of allKits().filter(k => k.discovered)) {
    const button = document.createElement('button'); button.className = 'kit-option';
    button.setAttribute('aria-pressed', String(kit.id === selected));
    const name = document.createElement('strong'), address = document.createElement('span');
    name.textContent = kit.name; address.textContent = `${kit.addresses?.join(' · ') || kit.host} · seen on network`;
    button.append(name, address);
    button.onclick = () => { $('kitSelect').value = kit.id; selectKit(); };
    $('networkKits').append(button);
  }
}
function saveKit(identity, host) {
  kits = rememberKit(kits,identity,host);
  try {localStorage.setItem(KIT_STORAGE_KEY,JSON.stringify(kits));} catch {status('Browser storage is unavailable; kits will be remembered only in this tab.');}
  renderKits($('kitSelect').value || identity?.id || `host:${host}`);
}
async function discoverKits() {
  if (discovering) return;
  discovering = true; $('refreshKits').disabled = true;
  const selected = allKits().find(k => k.id === $('kitSelect').value);
  try {
    const response = await fetch('/api/kits', {cache:'no-store', signal:AbortSignal.timeout(4000)});
    if (!response.ok) throw new Error('Start the dashboard with npm run serve to enable Wi-Fi discovery.');
    const result = await response.json();
    if (!Array.isArray(result.kits)) throw new Error('Wi-Fi discovery returned an invalid response.');
    discoveredKits = result.kits; renderKits();
    const updated = allKits().find(k => k.id === selected?.id);
    if (updated && $('wifiHost').value === selected.host) $('wifiHost').value = updated.host;
    $('discoveryStatus').textContent = result.error || (discoveredKits.length
      ? `${discoveredKits.length} kit${discoveredKits.length === 1 ? '' : 's'} discovered on this network. Choose a name and IP, then connect. Updates every 5 s.`
      : 'No kits discovered yet. Join the same Wi-Fi as the kits; the router must allow multicast discovery. Saved or manual addresses still work.');
  } catch (error) {
    discoveredKits = []; renderKits();
    $('discoveryStatus').textContent = `Discovery unavailable. ${error.message} Saved or manual addresses still work.`;
  } finally { discovering = false; $('refreshKits').disabled = false; }
}
$('refreshKits').onclick = discoverKits;
discoverKits(); setInterval(discoverKits, 5000);
$('addKit').onclick = () => {
  const host = $('wifiHost').value.trim();
  if(!validHost(host)){status('Enter a kit IP address or hostname first');return;}
  saveKit(null,host); status('Kit address saved. Choose Connect selected kit.');
};
$('forgetKit').onclick = () => {
  kits = kits.filter(k=>k.id!==$('kitSelect').value);
  try {localStorage.setItem(KIT_STORAGE_KEY,JSON.stringify(kits));} catch {}
  renderKits(''); status('Saved kit address removed');
};
function selectKit() {
  const kit = allKits().find(k=>k.id===$('kitSelect').value);
  if(kit){$('wifiHost').value=kit.host;status(`Selected ${kit.name}. Choose Connect selected kit to switch.`);}
  renderKits();
}
$('kitSelect').onchange = selectKit;
renderKits();
$('usb').onclick = connectUsb; $('ble').onclick = connectBle;
$('usbBridge').onclick = () => connectWifi('127.0.0.1', true);
$('wifiConnect').onclick = () => connectWifi(); $('disconnectBtn').onclick = disconnect;
$('record').onclick = startRecording; $('stop').onclick = stopRecording;
$('wifiEnable').onclick = async () => {
  const ssid = $('wifiSsid').value, password = $('wifiPass').value, encode = new TextEncoder();
  if (!ssid || encode.encode(ssid).length > 32 || (password.length && (encode.encode(password).length < 8 || encode.encode(password).length > 63))) {
    status('SSID must be 1–32 bytes; password must be empty or 8–63 bytes.'); return;
  }
  handoff = true; controls(); status('Sending Wi-Fi settings. Accept Bluetooth pairing if prompted.');
  try {
    await sendCommand({cmd:'wifi_on', ssid, password}); $('wifiPass').value = '';
    handoffTimer = setTimeout(() => { handoff = false; controls(); status('Wi-Fi setup timed out. The current link remains available; retry or enter the IP.'); }, 35000);
  } catch (e) { handoff = false; controls(); status(e.message); }
};
$('wifiOff').onclick = async () => { try { await sendCommand({cmd:'wifi_off'}); status('Wi-Fi turning off. Reconnect with Bluetooth or USB.'); } catch(e) { status(e.message); } };
$('clock').onclick = async () => { try { await sendCommand({cmd:'set_time', unix_ms:Date.now()}); } catch(e) { status(e.message); } };
$('clear').onclick = () => { if (!sessionCount(session) || confirm('Clear this recording?')) {session = newSession(); unsaved = false; controls(); status('Recording cleared');} };
function showRecordingFolder(message) {
  $('recordingFolder').textContent = recordingFolder ? recordingFolder.name : 'Browser download location';
  $('recordingFolderHint').textContent = message || (recordingFolder
    ? 'Export HDF5 saves into this folder. Stop, then export to write the file.'
    : canChooseFolder ? 'Choose where Export HDF5 saves your recordings. Stop, then export to write the file.'
    : 'Folder selection requires desktop Chrome or Edge. Exports use your browser’s download settings.');
  controls();
}
$('chooseRecordingFolder').onclick = async () => {
  folderBusy = true; controls();
  try {
    const folder = await window.showDirectoryPicker({id:'pal-recordings', mode:'readwrite', startIn:recordingFolder || 'documents'});
    recordingFolder = folder;
    try {await rememberRecordingFolder(folder); showRecordingFolder();}
    catch {showRecordingFolder('Folder selected for this tab. Browser storage could not remember it for next time.');}
  } catch (error) {
    if (error.name !== 'AbortError') showRecordingFolder(`Folder selection failed: ${error.message}. Your existing location is unchanged.`);
  } finally {folderBusy = false; controls();}
};
$('useDownloads').onclick = async () => {
  folderBusy = true; recordingFolder = null; controls();
  try {await rememberRecordingFolder(null); showRecordingFolder();}
  catch {showRecordingFolder('Using browser downloads for this tab. The saved folder setting could not be cleared.');}
  finally {folderBusy = false; controls();}
};
(async () => {
  try {
    if (canChooseFolder) {
      const folder = await loadRecordingFolder();
      if (folder?.kind === 'directory') recordingFolder = folder;
    }
    showRecordingFolder();
  } catch {showRecordingFolder();}
  finally {folderBusy = false; controls();}
})();
$('save').onclick = async () => {
  if (recording || exporting || folderBusy || !sessionCount(session)) return;
  const destination = recordingFolder, filename = recordingFilename(session);
  exporting = true; controls();
  try {
    if (destination) {status('Checking recording folder access…'); await ensureFolderWritePermission(destination);}
    status('Compressing HDF5 recording…');
    const bytes = await hdf5Job({action:'write', session});
    if (destination) {
      const name = await writeRecordingFile(destination, filename, bytes);
      status(`Saved ${destination.name}/${name} · ${(bytes.length / 1048576).toFixed(2)} MB`);
    } else {
      download(bytes, filename, 'application/x-hdf5');
      status(`HDF5 download requested · ${(bytes.length / 1048576).toFixed(2)} MB`);
    }
    unsaved = false;
  } catch(e) { status(`Export failed: ${e.message} Your recording is retained; choose another location and retry.`); }
  finally { exporting = false; controls(); }
};
const openExplorer = createExplorerWindow(window, () => session, () => ({
  recording, connected:!!active, device:active?.deviceIdentity?.name || session.device?.name,
  audioFrames:session.audio.length, imuSamples:session.imu.length, bytes:session.bytes,
  elapsed:recording ? Date.now()-session.started : session.ended-session.started
}), () => status('Allow pop-up windows to open the explorer. Acquisition and recording are still running.'));
$('explore').onclick = openExplorer;
$('exploreNav').onclick = event => {event.preventDefault(); openExplorer();};
$('liveNav').onclick = event => event.preventDefault();
window.addEventListener('beforeunload', event => { if (firmwareBusy || active || recording || (unsaved && sessionCount(session))) {event.preventDefault(); event.returnValue = '';} });
if (!navigator.serial || !navigator.bluetooth) $('browserBanner').style.display = 'block';
samplingPanel=setupSamplingPanel({getState:()=>({active,recording,firmwareBusy}),sendCommand,onBusy:value=>{samplingBusy=value;controls();}});
firmwarePanel=setupFirmwarePanel({getState:()=>({active,recording,exporting,connecting:connecting||samplingBusy}),sendCommand,disconnect,onBusy:value=>{firmwareBusy=value;controls();}});
controls();
setInterval(() => {
  draw('accel'); draw('gyro'); drawAudio();
  if (recording) $('recCounterText').textContent = `${Math.floor((Date.now()-session.started)/1000)}s · ${(session.bytes / 1048576).toFixed(1)} MB`;
  if (active && performance.now() - lastAudioAt > 3000) $('streamHealth').textContent = 'No recent audio frames. Check microphone wiring and device status.';
  else if (lastFrame) $('streamHealth').textContent = `${lastFrame.rate.toLocaleString()} samples/s · ${lastFrame.codec} · Since connection: ${missingFrames} missing frames, ${malformed} malformed packets · Since boot: ${lastFrame.dropped} capture queue drops, ${lastFrame.overruns} DMA overruns${lastFrame.clock_synced ? '' : ' · RTC needs synchronization'}`;
}, 200);
function drawAudio() {
  const canvas=$('audio'),ctx=canvas.getContext('2d'),dpr=Math.min(devicePixelRatio||1,2);
  const w=canvas.width=Math.max(1,Math.round(canvas.clientWidth*dpr)),h=canvas.height=canvas.clientHeight*dpr;
  const latest=waveFrames.at(-1),end=latest ? latest.time_ms+latest.pcm.length*1000/latest.rate : 500;
  const envelope=audioEnvelope(waveFrames,end-500,end,w);
  let low=envelope.minimum,high=envelope.maximum;
  if(!Number.isFinite(low)){low=-.0001;high=.0001;}
  if(high-low<.0001){low-=.00005;high+=.00005;}
  const center=(low+high)/2,peak=(high-low)/2;
  $('audioAxis').textContent=`Last 0.50 s of acquisition time · blank intervals are missing data · amplitude ${low.toFixed(4)} to ${high.toFixed(4)} full scale`;
  if(latest)$('audioValue').textContent=`${latest.dbfs.toFixed(1)} dBFS · ${latest.rate/1000} kHz`;
  ctx.strokeStyle='#334155';ctx.beginPath();ctx.moveTo(0,h/2);ctx.lineTo(w,h/2);ctx.stroke();
  ctx.strokeStyle='#38bdf8';ctx.beginPath();
  for(let x=0;x<w;x++)if(Number.isFinite(envelope.low[x])) {
    const top=h/2-(envelope.high[x]-center)/peak*h*.44,bottom=h/2-(envelope.low[x]-center)/peak*h*.44;
    ctx.moveTo(x,top);ctx.lineTo(x,Math.max(top+.5,bottom));
  }
  ctx.stroke();
}
function showEnv(d) {
  for(const [id,field,unit] of [['envTemp','temperature_c','°C'],['envHum','humidity_pct','%'],['envPress','pressure_hpa','hPa'],['envGas','gas_ohms','Ω']]) {
    $(id).textContent=Number.isFinite(d[field]) ? `${d[field].toLocaleString(undefined,{maximumFractionDigits:2})} ${unit}`:'Unavailable';
  }
  $('gasValidity').textContent=d.gas_valid && d.heater_stable ? 'New reading · gas valid · heater stable' : 'Gas unavailable until a valid, heater-stable measurement';
}

    function draw(key) {
      const canvas = document.querySelector('#' + key), values = histories[key], ctx = canvas.getContext('2d');
      const w = canvas.width = canvas.clientWidth * devicePixelRatio, h = canvas.height = canvas.clientHeight * devicePixelRatio;
      ctx.clearRect(0, 0, w, h);
      if (!values.length) return;

      // Draw horizontal baseline gridlines
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.lineWidth = 1 * devicePixelRatio;
      ctx.beginPath();
      ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2);
      ctx.moveTo(0, h * 0.25); ctx.lineTo(w, h * 0.25);
      ctx.moveTo(0, h * 0.75); ctx.lineTo(w, h * 0.75);
      ctx.stroke();

      let max = 1;
      for (let i = 0; i < values.length; i++) {
        const r = values[i];
        for (let j = 0; j < r.length; j++) {
          const abs = Math.abs(r[j]);
          if (abs > max) max = abs;
        }
      }

      const colors = ['#38bdf8', '#fbbf24', '#f43f5e'];
      for (let col = 0; col < values[0].length; col++) {
        ctx.strokeStyle = colors[col];
        ctx.lineWidth = 2 * devicePixelRatio;
        ctx.beginPath();
        values.forEach((row, i) => {
          const x = i * w / Math.max(1, values.length - 1);
          const y = h / 2 - (row[col] / max) * (h * 0.42);
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        });
        ctx.stroke();
      }
    }
