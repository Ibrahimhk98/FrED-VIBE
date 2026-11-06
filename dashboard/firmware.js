export function compareFirmware(current,available) {
 const parse=v=>/^a3-(\d+)\.(\d+)\.(\d+)$/.exec(v || '')?.slice(1).map(Number);
 const a=parse(current),b=parse(available);if(!a || !b)return null;
 for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]<b[i]?-1:1;
 return 0;
}

export function setupFirmwarePanel({getState,sendCommand,disconnect,onBusy}) {
 const $=id=>document.getElementById(id);
 let release=null,ports=[],usbConfiguration=null,usbPath='',busy=false,checking=false,polling=false,handledJob='',message='Check the connected kit and the release bundled with this dashboard.';
 const isBusy=job=>job && ['reading','flashing','verifying'].includes(job.stage);
 async function api(path='',body) {
  const response=await fetch('/api/firmware'+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{cache:'no-store'});
  if(!response.headers.get('content-type')?.includes('application/json'))throw new Error('Start this dashboard with npm run serve to enable firmware updates.');
  const result=await response.json();if(!response.ok)throw new Error(result.error || 'Firmware request failed');return result;
 }
 const configuration=()=>{
  if(getState().active)return getState().active.configuration;
  const selected=ports.find(p=>p.path===$('firmwarePort').value);
  return usbPath===selected?.path && (!selected.deviceId || selected.deviceId===usbConfiguration?.device_id)?usbConfiguration:null;
 };
 function render() {
  const state=getState(),config=configuration(),cmp=compareFirmware(config?.firmware,release?.version),selected=ports.find(p=>p.path===$('firmwarePort').value);
  const mismatch=(state.active?.deviceIdentity?.id && selected?.deviceId && state.active.deviceIdentity.id!==selected.deviceId) || (config?.hardware && config.hardware!=='FrED PAL A3');
  $('firmwareCurrent').textContent=config?.firmware || (state.active?'Waiting for device configuration…':'Connect a kit or read its USB version');
  $('firmwareAvailable').textContent=release?.version || 'No bundled release';
  $('firmwareComparison').textContent=cmp===0?'Up to date with this dashboard.':cmp===-1?'A newer firmware release is available.':cmp===1?'Installed firmware is newer than this dashboard’s release.':release?'Read the installed version to compare.':'';
  $('firmwareCheck').disabled=busy || checking;
  $('firmwarePort').disabled=busy || checking;
  $('firmwareRead').disabled=busy || checking || state.recording || state.exporting || state.connecting || !selected || !!mismatch;
  $('firmwareInstall').disabled=busy || checking || state.recording || state.exporting || state.connecting || !selected || !release || !!mismatch || cmp===1;
  $('firmwareInstall').textContent=cmp===0?'Reinstall via USB…':'Update via USB…';
  $('firmwareStatus').textContent=busy?message:state.recording?'Stop and export your recording before updating firmware.':mismatch?'Select the USB port belonging to the connected FrED PAL A3 kit.':message;
  $('firmwareNotes').textContent=release?.notes?.join(' ') || '';
 }
 function setBusy(value){busy=!!value;onBusy(busy);render();}
 async function check() {
  if(busy)return;checking=true;render();
  try {
   if(getState().active)await sendCommand({cmd:'get_config'});
   const data=await api();release=data.release;ports=data.ports || [];
   const previous=$('firmwarePort').value,expected=getState().active?.deviceIdentity?.id;
   $('firmwarePort').replaceChildren(new Option(ports.length?'Select a USB board…':'No ESP32 USB board detected',''));
   for(const p of ports)$('firmwarePort').add(new Option(`${p.path}${p.deviceId?' · PAL-'+p.deviceId.slice(-6):''}`,p.path));
   const selected=ports.find(p=>p.path===previous) || ports.find(p=>expected && p.deviceId===expected) || (ports.length===1?ports[0]:null);
   $('firmwarePort').value=selected?.path || '';
   message=data.toolError || data.releaseError || (ports.length?'Release and USB ports checked. USB flashing restarts the selected board.':'Connect the board by USB with SW1 ON, then check again.');
   if(data.job && (isBusy(data.job) || data.job.id!==handledJob)){setBusy(isBusy(data.job));poll();}
  }catch(error){message=error.message;}
  finally{checking=false;render();}
 }
 async function poll() {
  if(polling)return;polling=true;
  try {
   while(true) {
    const {job}=await api('/status');
    if(!job){setBusy(false);break;}
    message=job.detail;$('firmwareProgress').hidden=false;$('firmwareProgress').value=job.progress || 0;
    $('firmwareLog').textContent=job.log || '';
    if(isBusy(job)){setBusy(true);await new Promise(r=>setTimeout(r,700));continue;}
    if(handledJob!==job.id){
     handledJob=job.id;
     if(job.result?.configuration){usbConfiguration=job.result.configuration;usbPath=job.port;}
     if(job.stage==='error')message+=' Keep USB connected. If needed, hold BOOT, tap RESET, release BOOT, and retry.';
    }
    setBusy(false);break;
   }
  }catch(error){message='Unable to read update progress. Leave USB connected and check again: '+error.message;setBusy(false);}
  finally{polling=false;render();}
 }
 async function start(action) {
  const state=getState();if(busy || state.recording || state.exporting || state.connecting)return;
  const port=$('firmwarePort').value,deviceId=state.active?.deviceIdentity?.id || ports.find(p=>p.path===port)?.deviceId || '';
  if(!port || (action==='flash'&&!release))return;
  $('firmwareProgress').value=0;$('firmwareLog').textContent='';
  setBusy(true);message=action==='flash'?'Starting USB update…':'Reading USB version…';render();
  try {
   await disconnect(); // session remains in memory; release Web Serial / bridge first
   await new Promise(r=>setTimeout(r,400));
   await api('/'+action,{port,deviceId,...(action==='flash'?{releaseId:release.id}:{})});
   await poll();
  }catch(error){message=error.message;setBusy(false);}
 }
 $('firmwareCheck').onclick=check;
 $('firmwareRead').onclick=()=>start('read');
 $('firmwarePort').onchange=render;
 $('firmwareInstall').onclick=()=>{
  $('firmwareConfirmText').textContent=`Install ${release.version} on ${$('firmwarePort').selectedOptions[0].textContent}? The board will restart. Leave USB connected until verification finishes.`;
  $('firmwareConfirm').showModal();
 };
 $('firmwareCancel').onclick=()=>$('firmwareConfirm').close();
 $('firmwareStart').onclick=()=>{$('firmwareConfirm').close();start('flash');};
 // Recover operation progress after a page reload; never initiate an update automatically.
 check();
 return {render,isBusy:()=>busy};
}
