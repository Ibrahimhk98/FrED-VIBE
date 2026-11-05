import { sessionBounds, sessionCount, renderAudio, wavBytes } from './session.js';
import { hdf5Job, download } from './files.js';
import { returnToAcquisition } from './workspace.js';
const $ = id => document.getElementById(id);
const FIELDS = {temperature_c:'Temperature (°C)', humidity_pct:'Humidity (%)',pressure_hpa:'Pressure (hPa)',gas_ohms:'Gas resistance (Ω)',iaq:'IAQ (estimate)',voc_ppm:'VOC equivalent (ppm, estimate)',eco2_ppm:'CO₂ equivalent (ppm, estimate)',battery_v:'Battery (V)',battery_pct:'Battery (%)'};
for (const [value,text] of Object.entries(FIELDS)) $('environmentField').add(new Option(text,value));
let session, bounds = [0,0], context, source, gainNode, playStart, playTime, cursorMs, raf;
const status = value => $('status').textContent = value;
function load(value, label) {
  stop(); session = value; bounds = sessionBounds(session);
  if (!sessionCount(session)) {
    for (const id of ['start','duration','zoomIn','zoomOut','fit','timeline','environmentField','play','wav']) $(id).disabled = true;
    for (const canvas of document.querySelectorAll('canvas')) canvas.getContext('2d').clearRect(0,0,canvas.width,canvas.height);
    $('summary').textContent = 'This recording contains no samples.'; status('This recording is empty'); return;
  }
  const seconds = (bounds[1]-bounds[0])/1000;
  for (const id of ['start','duration','zoomIn','zoomOut','fit','timeline','environmentField']) $(id).disabled = false;
  $('start').value = 0; $('duration').value = Math.max(.001,Math.min(10,seconds)).toFixed(3);
  const audioSeconds = session.audio.reduce((n,f) => n+f.pcm.length/f.rate,0);
  const rates = [...new Set(session.audio.map(f => f.rate))].join(' / ');
  const unsynced = session.audio.some(f => !f.clock_synced);
  $('summary').textContent = `${session.device ? session.device.name + " (" + session.device.id + ") · " : ""}${label} · ${seconds.toFixed(2)} s timeline · ${session.imu.length.toLocaleString()} IMU samples · ${session.environment.length} environmental readings · ${audioSeconds.toFixed(2)} s audio${rates ? ' at '+rates+' Hz' : ''} · ${session.malformed || 0} malformed packets${unsynced ? ' · Some timestamps have an unsynchronized device clock' : ''}`;
  status('Recording ready'); draw();
}
function range() {
  const total = Math.max(.001,(bounds[1]-bounds[0])/1000);
  const duration = Math.max(.001, Math.min(total, Number($('duration').value) || .001));
  const start = Math.max(0, Math.min(total-duration, Number($('start').value) || 0));
  $('start').value = start.toFixed(3); $('duration').value = duration.toFixed(3);
  $('timeline').max = Math.max(0,total-duration); $('timeline').value = start;
  return [bounds[0]+start*1000, bounds[0]+(start+duration)*1000];
}
function axes(canvas, low, high, start, end) {
  const dpr = devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = Math.round(w*dpr); canvas.height = Math.round(h*dpr);
  const ctx = canvas.getContext('2d'); ctx.scale(dpr,dpr);
  const left=70, right=w-15, top=18, bottom=h-32;
  if (high===low) {low-=1;high+=1;}
  const x = t => left + (t-start)/(end-start)*(right-left), y = v => bottom-(v-low)/(high-low)*(bottom-top);
  ctx.font='11px system-ui'; ctx.fillStyle='#94a3b8'; ctx.strokeStyle='#263449'; ctx.lineWidth=1;
  for(let i=0;i<=4;i++) {
    const yy=top+(bottom-top)*i/4, value=high-(high-low)*i/4;
    ctx.fillText(Math.abs(value)<.01 ? value.toExponential(1) : value.toFixed(Math.max(2,Math.min(6,Math.ceil(-Math.log10((high-low)/4))+1))), 3, yy+4);
    ctx.beginPath();ctx.moveTo(left,yy);ctx.lineTo(right,yy);ctx.stroke();
    const t=start+(end-start)*i/4;
    ctx.fillText(`${((t-bounds[0])/1000).toFixed(end-start<100 ? 3:2)} s`, Math.min(right-30,x(t)-12),h-8);
  }
  if(cursorMs>=start && cursorMs<=end) {ctx.strokeStyle='#f43f5e';ctx.beginPath();ctx.moveTo(x(cursorMs),top);ctx.lineTo(x(cursorMs),bottom);ctx.stroke();}
  return {ctx,x,y,left,right,top,bottom};
}
function linePlot(id, rows, fields, start, end) {
  const selected = rows.filter(r => r.time_ms>=start && r.time_ms<=end);
  let lo=Infinity,hi=-Infinity;
  for(const row of selected) for(const key of fields) if(Number.isFinite(row[key])) {lo=Math.min(lo,row[key]);hi=Math.max(hi,row[key]);}
  if(!Number.isFinite(lo)){lo=-1;hi=1;}
  const padding=(hi-lo)*.08; const {ctx,x,y}=axes($(id),lo-padding,hi+padding,start,end);
  const colors=['#38bdf8','#fbbf24','#f43f5e'];
  fields.forEach((field,j) => {
    ctx.strokeStyle=colors[j];ctx.fillStyle=colors[j];ctx.lineWidth=1.5;ctx.beginPath();let prev;
    for(const row of selected) {
      if(!Number.isFinite(row[field])) {prev=undefined;continue;}
      const gap = id==='envPlot' ? 2500 : 50;
      if(!prev || row.time_ms-prev.time_ms>gap) ctx.moveTo(x(row.time_ms),y(row[field]));else ctx.lineTo(x(row.time_ms),y(row[field]));
      prev=row;
    }
    ctx.stroke();
    if(selected.length<100) for(const row of selected) if(Number.isFinite(row[field])) {ctx.beginPath();ctx.arc(x(row.time_ms),y(row[field]),2,0,Math.PI*2);ctx.fill();}
  });
  if(!selected.length) {ctx.fillStyle='#94a3b8';ctx.fillText('No samples in this range',100,45);}
}
function audioPlot(start,end) {
  let low=Infinity,high=-Infinity;
  const frames=session.audio.filter(f => f.time_ms<end && f.time_ms+f.pcm.length*1000/f.rate>start);
  for(const f of frames) for(let i=Math.max(0,Math.floor((start-f.time_ms)*f.rate/1000));i<Math.min(f.pcm.length,Math.ceil((end-f.time_ms)*f.rate/1000));i++) {low=Math.min(low,f.pcm[i]/32768);high=Math.max(high,f.pcm[i]/32768);}
  if(!Number.isFinite(low)){low=-.0001;high=.0001;}
  if(high-low<.0001){low-=.00005;high+=.00005;}
  const {ctx,x,y,left,right}=axes($('audioPlot'),low,high,start,end);
  ctx.strokeStyle='#38bdf8';ctx.lineWidth=1;ctx.beginPath();
  for(const f of frames) {
    const from=Math.max(0,Math.ceil((start-f.time_ms)*f.rate/1000)), to=Math.min(f.pcm.length,Math.ceil((end-f.time_ms)*f.rate/1000));
    const perPixel=(end-start)*f.rate/1000/(right-left);
    if(perPixel<=1) {
      for(let i=from;i<to;i++){const xx=x(f.time_ms+i*1000/f.rate), yy=y(f.pcm[i]/32768);i===from?ctx.moveTo(xx,yy):ctx.lineTo(xx,yy);}
    } else {
      for(let i=from;i<to;) {
        const column=Math.floor(x(f.time_ms+i*1000/f.rate));let min=32767,max=-32768;
        do {min=Math.min(min,f.pcm[i]);max=Math.max(max,f.pcm[i]);i++;} while(i<to && Math.floor(x(f.time_ms+i*1000/f.rate))===column);
        ctx.moveTo(column,y(max/32768));ctx.lineTo(column,y(min/32768));
      }
    }
  }
  ctx.stroke();if(!frames.length){ctx.fillStyle='#94a3b8';ctx.fillText('No audio in this range',100,45);}
}
function draw() {
  if(!session || !sessionCount(session)) return;
  const [start,end]=range();
  audioPlot(start,end);
  linePlot('accelPlot',session.imu,['ax','ay','az'],start,end);linePlot('gyroPlot',session.imu,['gx','gy','gz'],start,end);
  const field=$('environmentField').value; $('environmentTitle').textContent=FIELDS[field];
  linePlot('envPlot',session.environment,[field],start,end);
  const canPlay=session.audio.length>0 && end-start<=120000;
  $('play').disabled=!canPlay; $('wav').disabled=!canPlay;
  $('selectionInfo').textContent=`${new Date(start).toISOString()} → ${new Date(end).toISOString()} · ${((end-start)/1000).toFixed(3)} s visible`;
}
function stop() {
  if(source) {source.onended=null;try{source.stop();}catch{} source.disconnect();source=null;}
  if(context) {context.close();context=null;}
  cancelAnimationFrame(raf);cursorMs=undefined;$('stop').disabled=true;
}
function redraw(){stop();draw();}
$('start').onchange=redraw; $('duration').onchange=redraw; $('environmentField').onchange=draw;
$('timeline').oninput=()=>{$('start').value=$('timeline').value;redraw();};
$('zoomIn').onclick=()=>{$('duration').value=Number($('duration').value)/4;redraw();};
$('zoomOut').onclick=()=>{$('duration').value=Number($('duration').value)*4;redraw();};
$('fit').onclick=()=>{$('start').value=0;$('duration').value=(bounds[1]-bounds[0])/1000;redraw();};
$('play').onclick=async()=>{
  try {
    stop();const [start,end]=range(), rendered=renderAudio(session,start,end);
    if(!rendered.covered) throw new Error('No audio in the visible range');
    context=new AudioContext();await context.resume();
    const buffer=context.createBuffer(1,rendered.pcm.length,rendered.rate);buffer.copyToChannel(rendered.pcm,0);
    source=context.createBufferSource();source.buffer=buffer;gainNode=context.createGain();gainNode.gain.value=Number($('gain').value);
    if($('removeDc').checked) {const filter=context.createBiquadFilter();filter.type='highpass';filter.frequency.value=20;source.connect(filter).connect(gainNode);} else source.connect(gainNode);
    gainNode.connect(context.destination);playStart=start;playTime=context.currentTime;source.start();$('stop').disabled=false;
    source.onended=()=>{stop();draw();status('Playback complete');};status('Playing visible range');
    let last=0;const animate=now=>{if(!context)return;cursorMs=playStart+(context.currentTime-playTime)*1000;if(now-last>100){draw();last=now;}raf=requestAnimationFrame(animate);};raf=requestAnimationFrame(animate);
  }catch(e){stop();status(e.message);}
};
$('gain').onchange=()=>{if(gainNode)gainNode.gain.value=Number($('gain').value);};
$('stop').onclick=()=>{stop();draw();status('Playback stopped');};
$('wav').onclick=()=>{try{const r=renderAudio(session,...range());download(wavBytes(r.pcm,r.rate),'pal-audio-selection.wav','audio/wav');}catch(e){status(e.message);}};
for(const id of ['audioPlot','accelPlot','gyroPlot','envPlot']) $(id).addEventListener('pointermove',event=>{
  if(!session)return;const [start,end]=range(),rect=event.currentTarget.getBoundingClientRect();
  const t=start+Math.max(0,Math.min(1,(event.clientX-rect.left-70)/(rect.width-85)))*(end-start);
  let detail='No sample';
  if(id==='audioPlot') {
    const f=session.audio.find(f=>t>=f.time_ms && t<f.time_ms+f.pcm.length*1000/f.rate);
    if(f){const i=Math.floor((t-f.time_ms)*f.rate/1000);detail=`PCM ${f.pcm[i]} · amplitude ${(f.pcm[i]/32768).toFixed(6)} · ${f.codec} / ${f.transport}`;}
  }else{
    const rows=id==='envPlot'?session.environment:session.imu;let closest,delta=Infinity;
    for(const r of rows){const d=Math.abs(r.time_ms-t);if(d<delta){delta=d;closest=r;}}
    if(closest){const fields=id==='accelPlot'?['ax','ay','az']:id==='gyroPlot'?['gx','gy','gz']:[$('environmentField').value];detail=fields.map(f=>`${f}: ${closest[f]?.toFixed(4)}`).join(' · ')+` · sample offset ${delta.toFixed(1)} ms`;}
  }
  $('selectionInfo').textContent=`${new Date(t).toISOString()} · ${((t-bounds[0])/1000).toFixed(4)} s · ${detail}`;
});
$('file').onchange=async()=>{
  const file=$('file').files[0];if(!file)return;
  try{if(file.size>192*1048576)throw new Error('File exceeds the 192 MB import limit');status('Opening HDF5…');const value=await hdf5Job({action:'read',bytes:new Uint8Array(await file.arrayBuffer())});load(value,file.name);}catch(e){status(e.message);}
};
function ownerAvailable() {return window.opener && !window.opener.closed;}
function requestSession(){if(ownerAvailable())window.opener.postMessage({type:'pal-session-request'},location.origin);else status('The acquisition window is unavailable. Open a saved file, or launch analysis from a connected dashboard.');}
$('refresh').onclick=requestSession;
function showAcquisition(state) {
  $('acquisitionStatus').dataset.recording = String(state.recording);
  const samples = `${state.audioFrames.toLocaleString()} audio frames · ${state.imuSamples.toLocaleString()} IMU samples`;
  $('acquisitionStatus').textContent = state.recording
    ? `● Recording continues in live acquisition · ${state.device || 'Kit'} · ${Math.floor(state.elapsed/1000)} s · ${samples}. Analysis shows a snapshot; use Load current dashboard recording to update it.`
    : `${state.connected ? 'Kit connected' : 'Kit disconnected'} · Recording stopped · ${samples} retained in live acquisition.`;
}
window.addEventListener('message',event=>{
  if(event.origin!==location.origin || event.source!==window.opener)return;
  if(event.data?.type==='pal-session')load(event.data.session,`Dashboard snapshot at ${new Date().toLocaleTimeString()}`);
  if(event.data?.state)showAcquisition(event.data.state);
});
$('liveNav').onclick = event => {
  if (returnToAcquisition(window)) event.preventDefault();
};
$('exploreNav').onclick = event => event.preventDefault();
setInterval(() => {
  if (ownerAvailable()) window.opener.postMessage({type:'pal-state-request'}, location.origin);
  else if (window.opener) {
    $('acquisitionStatus').dataset.recording = 'false';
    $('acquisitionStatus').textContent = 'The acquisition window was closed. This analysis snapshot remains available.';
  }
}, 1000);
window.addEventListener('resize',draw);window.addEventListener('beforeunload',stop);
if(ownerAvailable())requestSession();
