import { spawn } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export async function firmwareRelease(root=join(repo,'firmware')) {
 const manifest=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));
 if(manifest.schema!==1 || manifest.hardware!=='FrED PAL A3' || manifest.chip!=='esp32s3' || manifest.flashSize!==8388608 || !/^a3-\d+\.\d+\.\d+$/.test(manifest.version) || !/^[a-f0-9]{64}$/.test(manifest.id) || JSON.stringify(manifest.images?.map(i=>i.offset))!=='[0,32768,57344,65536]')throw new Error('Invalid A3 firmware manifest');
 const limits=[0x8000,0x1000,0x2000,0x600000];
 for(const [n,img] of manifest.images.entries()) {
  if(!new RegExp(`^${manifest.id}/[a-zA-Z0-9_.-]+\\.bin$`).test(img.file) || img.size<1 || img.size>limits[n])throw new Error('Invalid firmware image');
  const bytes=await readFile(join(root,img.file));
  if(bytes.length!==img.size || createHash('sha256').update(bytes).digest('hex')!==img.sha256)throw new Error('Firmware checksum mismatch; rebuild the package');
 }
 if(manifest.images[3].sha256!==manifest.id)throw new Error('Firmware release ID mismatch');
 return manifest;
}
async function pythonPath() {
 if(process.env.PAL_PYTHON)return process.env.PAL_PYTHON;
 const path=join(homedir(),'.platformio','penv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
 try{await access(path);return path;}catch{return 'python3';}
}
export async function runFirmwareTool(args,onOutput=()=>{}) {
 const python=await pythonPath();
 return new Promise((resolve,reject)=>{
  const child=spawn(python,['-u',join(repo,'scripts/firmware_device.py'),...args],{cwd:repo,stdio:['ignore','pipe','pipe']});
  let output='',result,timer=setTimeout(()=>child.kill(),args[0]==='flash'?180000:15000);
  const consume=chunk=>{output=(output+chunk.toString()).slice(-24000);onOutput(output);};
  child.stdout.on('data',consume);child.stderr.on('data',consume);
  child.on('error',e=>{clearTimeout(timer);reject(e);});
  child.on('close',code=>{
   clearTimeout(timer);
   for(const line of output.split(/\r?\n/))if(line.startsWith('PAL_RESULT ')){try{result=JSON.parse(line.slice(11));}catch{}}
   if(code===0 && result)resolve(result);
   else reject(new Error(output.match(/PAL_ERROR ([^\n]+)/)?.[1] || 'Firmware tool unavailable or timed out. Install PlatformIO, run npm run firmware:build, then retry.'));
  });
 });
}
export function createFirmwareService({release=firmwareRelease,run=runFirmwareTool}={}) {
 let job=null;
 const busy=()=>job && ['reading','flashing','verifying'].includes(job.stage);
 return {
  async snapshot() {
   let available=null,error='',ports=[],toolError='';
   try{available=await release();}catch(e){error=e.code==='ENOENT'?'No bundled release. Run npm run firmware:build.':e.message;}
   try{ports=(await run(['ports'])).ports;}catch(e){toolError=e.message;}
   return {release:available,releaseError:error,ports,toolError,job};
  },
  status(){return {job};},
  async start(action,body) {
   if(!['read','flash'].includes(action) || !body || typeof body.port!=='string' || body.port.length>200 || (body.deviceId && !/^[a-f0-9]{12}$/i.test(body.deviceId)))throw Object.assign(new Error('Invalid firmware request'),{status:400});
   if(busy())throw Object.assign(new Error('A firmware operation is already running'),{status:409});
   // Reserve the slot before any awaits so simultaneous tabs cannot open USB twice.
   job={id:randomUUID(),stage:action==='read'?'reading':'flashing',action,port:body.port,progress:0,detail:action==='read'?'Reading USB firmware version…':'Connecting to the bootloader…',log:''};
   const current=job;
   try {
    if(action==='flash') {
     const available=await release();
     if(body.releaseId!==available.id)throw Object.assign(new Error('Available firmware changed. Check again.'),{status:409});
    }
    const ports=(await run(['ports'])).ports,port=ports.find(p=>p.path===body.port);
    if(!port || (body.deviceId && port.deviceId && body.deviceId!==port.deviceId))throw Object.assign(new Error('Selected USB board is unavailable or does not match the connected kit.'),{status:409});
    const expected=body.deviceId || port.deviceId;
    const args=[action,'--port',port.path,...(expected?['--device',expected]:[]),...(action==='flash'?['--release',body.releaseId]:[])];
    run(args,output=>{
     current.log=output.replace(/\x1b\[[0-9;]*m/g,'').slice(-6000);
     const percentages=[...output.matchAll(/\((\d+) %\)/g)];
     if(percentages.length){current.progress=Number(percentages.at(-1)[1]);current.detail=`Writing firmware image… ${current.progress}%`;}
     const events=output.split(/\r?\n/).filter(l=>l.startsWith('PAL_EVENT '));
     if(events.length)try{Object.assign(current,JSON.parse(events.at(-1).slice(10)));}catch{}
    }).then(result=>Object.assign(current,{stage:result.flashVerified&&!result.runningVerified?'needs-reset':'complete',progress:100,result,detail:result.detail || 'Firmware version read successfully.'}),e=>Object.assign(current,{stage:'error',detail:e.message}));
    return {job:current};
   }catch(e){Object.assign(current,{stage:'error',detail:e.message});throw e;}
  }
 };
}
