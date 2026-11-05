import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureFolderWritePermission, recordingFilename, writeRecordingFile } from '../dashboard/recording-location.js';

test('restored folders request write permission; denied access rejects before file creation', async () => {
  const calls = [];
  const folder = {queryPermission:async options=>{calls.push(options);return 'prompt';},requestPermission:async options=>{calls.push(options);return 'granted';}};
  await ensureFolderWritePermission(folder); assert.deepEqual(calls,[{mode:'readwrite'},{mode:'readwrite'}]);
  await ensureFolderWritePermission({queryPermission:async()=> 'granted',requestPermission:assert.fail});
  await assert.rejects(ensureFolderWritePermission({queryPermission:async()=> 'prompt',requestPermission:async()=> 'denied'}),/not granted/);
});

function fakeFolder(existing = []) {
  const files = new Map(existing.map(name=>[name,new Uint8Array([99])]));
  return {files, async getFileHandle(name, options) {
    if (!files.has(name) && !options?.create) throw new DOMException('Missing','NotFoundError');
    return {createWritable:async()=>{
      let pending;
      return {write:async bytes=>{pending=bytes.slice();},close:async()=>{files.set(name,pending);},abort:async()=>{pending=null;}};
    }};
  }};
}

test('folder exports close the file and repeated exports retain earlier bytes', async () => {
  const folder = fakeFolder(['pal-test.h5']), bytes = new Uint8Array([1,2,3]);
  assert.equal(await writeRecordingFile(folder,'pal-test.h5',bytes),'pal-test-2.h5');
  assert.equal(await writeRecordingFile(folder,'pal-test.h5',bytes),'pal-test-3.h5');
  assert.deepEqual([...folder.files.get('pal-test.h5')],[99]);
  assert.deepEqual(folder.files.get('pal-test-2.h5'),bytes);
  assert.deepEqual(bytes,new Uint8Array([1,2,3]));
});

test('write and close failures abort the export and propagate errors for retry', async () => {
  for (const failAt of ['write','close']) {
    let aborted = false;
    const folder = {async getFileHandle(name,options) {
      if (!options?.create) throw new DOMException('Missing','NotFoundError');
      return {createWritable:async()=>({write:async()=>{if(failAt==='write')throw new Error('Disk full');},close:async()=>{if(failAt==='close')throw new Error('Disk full');},abort:async()=>{aborted=true;}})};
    }};
    await assert.rejects(writeRecordingFile(folder,'pal-test.h5',new Uint8Array([1])),/Disk full/);
    assert.equal(aborted,true);
  }
});

test('unavailable folders and unsafe filenames never silently fall back or overwrite', async () => {
  const folder = {getFileHandle:async()=>{throw new DOMException('Access revoked','NotAllowedError');}};
  await assert.rejects(writeRecordingFile(folder,'pal-test.h5',new Uint8Array()),/Access revoked/);
  await assert.rejects(writeRecordingFile({getFileHandle:assert.fail},'../other.h5',new Uint8Array()),/Invalid/);
  assert.equal(recordingFilename({device:{id:'kit/../bad'},started:0}),'pal-kit____bad-1970-01-01T00-00-00-000Z.h5');
});
