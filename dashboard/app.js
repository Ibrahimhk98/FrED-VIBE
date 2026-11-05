import { decodeAudio, LineParser } from './protocol.js';
import { BlePacketParser } from './ble-protocol.js';
import { newSession, sessionCount, MAX_RECORDING_BYTES, ENV_FIELDS, IMU_FIELDS } from './session.js';
import { hdf5Job, download } from './files.js';
import { loadKits, rememberKit, validHost, availableKits, KIT_STORAGE_KEY } from './kits.js';
import { createExplorerWindow } from './workspace.js';
import { loadRecordingFolder, rememberRecordingFolder, ensureFolderWritePermission, recordingFilename, writeRecordingFile } from './recording-location.js';
const $ = id => document.getElementById(id);
const SERVICE = '7f510001-5b8d-4a84-9c7c-a07142ab6002', DATA = '7f510002-5b8d-4a84-9c7c-a07142ab6002', COMMAND = '7f510003-5b8d-4a84-9c7c-a07142ab6002';
let active, connecting = false, handoff = false, handoffTimer, recording = false, session = newSession();
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
let waveSamples = [], liveRate = 16000;
function status(message) { $('status').textContent = message; $('pulseDot').className = `pulse-dot ${recording ? 'recording' : active ? 'connected' : ''}`; }
function controls() {
  for (const id of ['usb','usbBridge','ble','wifiConnect']) $(id).disabled = connecting;
  $('record').disabled = recording || !active?.deviceIdentity || exporting;
  $('stop').disabled = !recording;
  $('clock').disabled = !active || recording;
  $('wifiEnable').disabled = !active || active.kind === 'ws' || handoff;
  $('wifiOff').disabled = !active;
  $('save').disabled = recording || exporting || folderBusy || !sessionCount(session);
  $('chooseRecordingFolder').disabled = !canChooseFolder || folderBusy || exporting;
  $('useDownloads').disabled = !recordingFolder || folderBusy || exporting;
  $('clear').disabled = recording || exporting;
  $('recCounter').style.display = recording ? 'inline-flex' : 'none';
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
  if (Number.isFinite(data.time_ms)) {
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
  if (data.type === 'environment') {
    showEnv(data);
    if (recording) {
      session.environment.push(Object.fromEntries(['time_ms', ...ENV_FIELDS].map(f => [f, Number(data[f])])));
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
    if (previousFrame && frame.stream_id === previousFrame.stream_id && frame.sequence > previousFrame.sequence)
      missingFrames += Math.max(0, frame.sequence - previousFrame.sequence - 1);
    previousFrame = frame; lastFrame = frame; lastAudioAt = performance.now(); liveRate = frame.rate;
    for (const sample of frame.pcm) waveSamples.push(sample / 32768);
    waveSamples = waveSamples.slice(-Math.round(liveRate / 2));
    $('audioValue').textContent = `${frame.dbfs.toFixed(1)} dBFS · ${frame.rate / 1000} kHz`;
    if (recording) { session.audio.push(frame); recordSize(frame.pcm.byteLength + 256); }
  }
  controls();
}
function makeChannel(kind) {
  const channel = {kind, closing:false};
  channel.parser = new LineParser(data => packet(data, channel), () => { malformed++; if (recording) session.malformed++; });
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
  missingFrames = 0; malformed = 0; lastFrame = undefined;
  previousFrame = undefined; waveSamples = []; lastAudioAt = performance.now();
  handoff = false; clearTimeout(handoffTimer);
  await closeChannel(old);
  status(`Connected via ${{usb:'USB',bridge:'USB bridge',ble:'Bluetooth',ws:'Wi-Fi'}[channel.kind]}`); controls();
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
    await sendCommand({cmd:'wifi_status'});
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
    const expected = {set_time:['clock_set'], wifi_on:['wifi_connecting'], wifi_status:['wifi_status','wifi_connected']}[command.cmd];
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
  if (!active) return;
  if (sessionCount(session) && !confirm('Start a new recording? Export the current session first if you want to keep it.')) return;
  session = newSession(); session.device = {...active.deviceIdentity}; recording = true; unsaved = true; controls(); status('Recording acoustic samples, motion and environment');
}
function stopRecording() {
  recording = false; session.ended = Date.now(); controls();
  status(`Recording stopped: ${session.audio.length} audio frames · ${session.imu.length} IMU samples · ${session.environment.length} environmental readings`);
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
window.addEventListener('beforeunload', event => { if (active || recording || (unsaved && sessionCount(session))) {event.preventDefault(); event.returnValue = '';} });
if (!navigator.serial || !navigator.bluetooth) $('browserBanner').style.display = 'block';
controls();
setInterval(() => {
  draw('accel'); draw('gyro'); drawAudio();
  if (recording) $('recCounterText').textContent = `${Math.floor((Date.now()-session.started)/1000)}s · ${(session.bytes / 1048576).toFixed(1)} MB`;
  if (active && performance.now() - lastAudioAt > 3000) $('streamHealth').textContent = 'No recent audio frames. Check microphone wiring and device status.';
  else if (lastFrame) $('streamHealth').textContent = `${lastFrame.rate.toLocaleString()} samples/s · ${lastFrame.codec} · ${missingFrames} missing frames · ${lastFrame.dropped} capture queue drops · ${lastFrame.overruns} DMA overruns · ${malformed} malformed packets${lastFrame.clock_synced ? '' : ' · RTC needs synchronization'}`;
}, 200);
function drawAudio() {
  const canvas = $('audio'), ctx = canvas.getContext('2d');
  const w = canvas.width = canvas.clientWidth * devicePixelRatio, h = canvas.height = canvas.clientHeight * devicePixelRatio;
  let low = Infinity, high = -Infinity; for (const v of waveSamples) { low = Math.min(low,v); high = Math.max(high,v); }
  if (!Number.isFinite(low)) { low = -.0001; high = .0001; }
  if (high-low < .0001) {low -= .00005; high += .00005;}
  const center = (low+high)/2, peak = (high-low)/2;
  $('audioAxis').textContent = `Last ${(waveSamples.length/liveRate).toFixed(2)} s · amplitude ${low.toFixed(4)} to ${high.toFixed(4)} full scale (auto-scaled)`;
  ctx.strokeStyle = '#334155'; ctx.beginPath(); ctx.moveTo(0,h/2); ctx.lineTo(w,h/2); ctx.stroke();
  ctx.strokeStyle = '#38bdf8'; ctx.beginPath();
  for (let x=0; x<w; x++) {
    const a = Math.floor(x * waveSamples.length/w), b = Math.max(a+1, Math.floor((x+1)*waveSamples.length/w));
    let lo=1, hi=-1; for(let i=a;i<b && i<waveSamples.length;i++){lo=Math.min(lo,waveSamples[i]);hi=Math.max(hi,waveSamples[i]);}
    if (a < waveSamples.length) {ctx.moveTo(x,h/2-(hi-center)/peak*h*.44);ctx.lineTo(x,h/2-(lo-center)/peak*h*.44);}
  }
  ctx.stroke();
}
    function showEnv(d) {
      document.querySelector('#envTemp').textContent = `${d.temperature_c.toFixed(1)} °C`;
      document.querySelector('#envHum').textContent = `${d.humidity_pct.toFixed(1)} %`;
      document.querySelector('#envPress').textContent = `${d.pressure_hpa.toFixed(1)} hPa`;
      document.querySelector('#envGas').textContent = `${Number(d.gas_ohms).toLocaleString()} Ω`;

      if (d.iaq !== undefined) {
        const iaq = Number(d.iaq);
        const voc = Number(d.voc_ppm).toFixed(2);
        const eco2 = Math.round(Number(d.eco2_ppm));

        const iaqValEl = document.querySelector('#iaqVal');
        const vocValEl = document.querySelector('#vocVal');
        const eco2ValEl = document.querySelector('#eco2Val');
        const iaqBadgeEl = document.querySelector('#iaqBadge');
        const iaqStatusTextEl = document.querySelector('#iaqStatusText');

        if (iaqValEl) iaqValEl.textContent = iaq.toFixed(1);
        if (vocValEl) vocValEl.textContent = `${voc} ppm`;
        if (eco2ValEl) eco2ValEl.textContent = `${eco2} ppm`;

        if (iaq <= 50) {
          if (iaqBadgeEl) {
            iaqBadgeEl.textContent = '🟢 Good (0-50)';
            iaqBadgeEl.style.background = 'rgba(52, 211, 153, 0.15)';
            iaqBadgeEl.style.color = '#34d399';
            iaqBadgeEl.style.borderColor = 'rgba(52, 211, 153, 0.3)';
          }
          if (iaqValEl) iaqValEl.style.color = '#34d399';
          if (iaqStatusTextEl) { iaqStatusTextEl.textContent = 'Good Air Quality'; iaqStatusTextEl.style.color = '#34d399'; }
        } else if (iaq <= 100) {
          if (iaqBadgeEl) {
            iaqBadgeEl.textContent = '🟡 Moderate (51-100)';
            iaqBadgeEl.style.background = 'rgba(251, 191, 36, 0.15)';
            iaqBadgeEl.style.color = '#fbbf24';
            iaqBadgeEl.style.borderColor = 'rgba(251, 191, 36, 0.3)';
          }
          if (iaqValEl) iaqValEl.style.color = '#fbbf24';
          if (iaqStatusTextEl) { iaqStatusTextEl.textContent = 'Moderate Air Quality'; iaqStatusTextEl.style.color = '#fbbf24'; }
        } else if (iaq <= 200) {
          if (iaqBadgeEl) {
            iaqBadgeEl.textContent = '🟠 Poor (101-200)';
            iaqBadgeEl.style.background = 'rgba(249, 115, 22, 0.15)';
            iaqBadgeEl.style.color = '#f97316';
            iaqBadgeEl.style.borderColor = 'rgba(249, 115, 22, 0.3)';
          }
          if (iaqValEl) iaqValEl.style.color = '#f97316';
          if (iaqStatusTextEl) { iaqStatusTextEl.textContent = 'Poor Air Quality'; iaqStatusTextEl.style.color = '#f97316'; }
        } else {
          if (iaqBadgeEl) {
            iaqBadgeEl.textContent = '🔴 Hazardous (201+)';
            iaqBadgeEl.style.background = 'rgba(244, 63, 94, 0.15)';
            iaqBadgeEl.style.color = '#f43f5e';
            iaqBadgeEl.style.borderColor = 'rgba(244, 63, 94, 0.3)';
          }
          if (iaqValEl) iaqValEl.style.color = '#f43f5e';
          if (iaqStatusTextEl) { iaqStatusTextEl.textContent = 'Hazardous Air!'; iaqStatusTextEl.style.color = '#f43f5e'; }
        }
      }

      if (d.battery_v !== undefined) {
        const v = Number(d.battery_v).toFixed(2);
        const pct = Number(d.battery_pct);
        const batEl = document.querySelector('#batVal');
        const batStat = document.querySelector('#batStatus');

        if (batEl && batStat) {
          batEl.textContent = `🔋 ${v} V (${pct}%)`;
          if (pct >= 50) {
            batEl.style.color = 'var(--accent-green)';
            batStat.textContent = '🔋 Battery Level Normal';
          } else if (pct >= 20) {
            batEl.style.color = 'var(--accent-amber)';
            batStat.textContent = '🟡 Battery Level Moderate';
          } else {
            batEl.style.color = 'var(--accent-rose)';
            batStat.textContent = '🔴 Battery Low - Recharge Soon';
          }
        }
      }
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
