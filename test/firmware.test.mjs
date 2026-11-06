import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createFirmwareService, firmwareRelease } from '../scripts/firmware-service.mjs';
import { createDashboardServer } from '../scripts/dashboard_server.mjs';
import { compareFirmware } from '../dashboard/firmware.js';
const hash=b=>createHash('sha256').update(b).digest('hex');
test('firmware versions compare numerically and reject unrelated hardware labels',()=>{
 assert.equal(compareFirmware('a3-1.9.1','a3-1.10.0'),-1);assert.equal(compareFirmware('a3-2.0.0','a3-1.10.0'),1);
 assert.equal(compareFirmware('a3-1.1.0','a3-1.1.0'),0);assert.equal(compareFirmware('v1.1.0','a3-1.1.0'),null);
});
test('release rejects changed binaries and paths outside the firmware package',async t=>{
 const root=await mkdtemp(join(tmpdir(),'pal-firmware-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const bytes=Buffer.from('test image'),id=hash(bytes);await mkdir(join(root,id));
 const images=[];for(const [i,offset] of [0,0x8000,0xe000,0x10000].entries()) {const file=`${id}/${i}.bin`;await writeFile(join(root,file),bytes);images.push({offset,file,size:bytes.length,sha256:id});}
 const manifest={schema:1,hardware:'FrED PAL A3',chip:'esp32s3',flashSize:8388608,version:'a3-1.1.0',id,images};
 const save=()=>writeFile(join(root,'manifest.json'),JSON.stringify(manifest));await save();assert.equal((await firmwareRelease(root)).version,'a3-1.1.0');
 await writeFile(join(root,images[0].file),'modified');await assert.rejects(firmwareRelease(root),/checksum/);
 images[0].file='../external.bin';await save();await assert.rejects(firmwareRelease(root),/Invalid firmware image/);
});
const port={path:'/dev/test-pal',deviceId:'88cda63f1fb8'},release={id:'release-id'};
test('updater rejects stale releases and wrong board identity before starting a write',async()=>{
 const calls=[],service=createFirmwareService({release:async()=>release,run:async args=>{calls.push(args);return {ports:[port]};}});
 await assert.rejects(service.start('flash',{port:port.path,releaseId:'old'}),/changed/);assert.equal(calls.length,0);
 await assert.rejects(service.start('flash',{port:port.path,releaseId:release.id,deviceId:'000000000000'}),/does not match/);
 assert.deepEqual(calls.map(a=>a[0]),['ports']);
});
test('only one USB operation runs and flash verification is separate from application startup',async()=>{
 let finish;const calls=[],service=createFirmwareService({release:async()=>release,run:args=>{calls.push(args);return args[0]==='ports'?Promise.resolve({ports:[port]}):new Promise(r=>finish=r);}});
 await service.start('flash',{port:port.path,releaseId:release.id});
 await assert.rejects(service.start('read',{port:port.path}),/already running/);
 assert.equal(calls[1].includes(port.deviceId),true);
 finish({flashVerified:true,runningVerified:false});await new Promise(r=>setImmediate(r));
 assert.equal(service.status().job.stage,'needs-reset');
});
test('firmware write endpoint requires same-origin JSON and never flashes on GET',async t=>{
 let writes=0;const firmware={snapshot:async()=>({release}),status:()=>({job:null}),start:async()=>{writes++;return {job:{stage:'flashing'}};}};
 const server=createDashboardServer({snapshot:()=>({kits:[]})},firmware);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const url=`http://127.0.0.1:${server.address().port}`;
 assert.equal((await fetch(url+'/api/firmware/flash')).status,405);
 assert.equal((await fetch(url+'/api/firmware/flash',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
 assert.equal((await fetch(url+'/api/firmware/flash',{method:'POST',headers:{Origin:'https://example.com','Content-Type':'application/json'},body:'{}'})).status,403);
 const response=await fetch(url+'/api/firmware/flash',{method:'POST',headers:{Origin:url,'Content-Type':'application/json'},body:JSON.stringify({port:port.path,releaseId:release.id})});
 assert.equal(response.status,200);assert.equal(writes,1);
});
