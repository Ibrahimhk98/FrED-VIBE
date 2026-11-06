// Package only the locally built A3 images; the dashboard never accepts an upload path.
import { readFile, mkdir, writeFile, rename, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
if(process.argv.includes('--build')) {
 const pio=process.env.PAL_PLATFORMIO || join(homedir(),'.platformio','penv',process.platform==='win32'?'Scripts':'bin',process.platform==='win32'?'platformio.exe':'pio');
 for(const target of [[],['-t','idedata']]) {
  const result=spawnSync(pio,['run','-e','fred_pal_a3',...target],{cwd:repo,stdio:target.length?['ignore','pipe','inherit']:'inherit'});
  if(result.error)throw result.error;if(result.status)process.exit(result.status);
 }
}
const hash=b=>createHash('sha256').update(b).digest('hex');
const version=(await readFile(join(repo,'include/firmware_version.h'),'utf8')).match(/#define FRED_FIRMWARE_VERSION "(a3-\d+\.\d+\.\d+)"/)?.[1];
if(!version)throw new Error('Missing A3 version');
const build=join(repo,'.pio/build/fred_pal_a3'),meta=JSON.parse(await readFile(join(build,'idedata.json'),'utf8')).extra;
const input=[...meta.flash_images,{offset:meta.application_offset,path:join(build,'firmware.bin')}];
const app=await readFile(input.at(-1).path);
if(!app.includes(Buffer.from(version)))throw new Error('Binary does not contain the source version; rebuild first');
const id=hash(app),output=join(repo,'firmware',id);await mkdir(output,{recursive:true});
const images=[];
for(const image of input) {
 const bytes=await readFile(image.path),name=basename(image.path);
 await copyFile(image.path,join(output,name));
 images.push({offset:Number(image.offset),file:`${id}/${name}`,size:bytes.length,sha256:hash(bytes)});
}
if(JSON.stringify(images.map(x=>x.offset))!==JSON.stringify([0,32768,57344,65536]))throw new Error('Unexpected A3 flash layout');
const manifest={schema:1,hardware:'FrED PAL A3',chip:'esp32s3',flashSize:8388608,version,id,builtAt:new Date().toISOString(),
 notes:['Bluetooth audio defaults to a filtered 24 kHz preview; USB/Wi-Fi keep 48 kHz raw samples.','Selectable Bluetooth audio (16/24/48 kHz) and IMU (26–416 Hz) rates.','Gravity-based flat trim, compact BLE transport, and a verified USB updater.'],images};
await writeFile(join(repo,'firmware/manifest.json.tmp'),JSON.stringify(manifest,null,2)+'\n');
await rename(join(repo,'firmware/manifest.json.tmp'),join(repo,'firmware/manifest.json'));
console.log(`Packaged ${version}: ${id}`);
