// Store the browser's directory handle, not an arbitrary filesystem path.
async function folderStore(mode, handle, indexedDB = globalThis.indexedDB) {
  if (!indexedDB) throw new Error('Browser storage is unavailable');
  const db = await new Promise((resolve,reject) => {
    const request = indexedDB.open('pal-recording-settings', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('settings');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve,reject) => {
      const transaction = db.transaction('settings', mode);
      const store = transaction.objectStore('settings');
      const request = mode === 'readonly' ? store.get('directory')
        : handle ? store.put(handle, 'directory') : store.delete('directory');
      transaction.oncomplete = () => resolve(request.result || null);
      transaction.onabort = () => reject(transaction.error || new Error('Folder setting could not be saved'));
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {db.close();}
}
export const loadRecordingFolder = () => folderStore('readonly');
export const rememberRecordingFolder = handle => folderStore('readwrite', handle);

export async function ensureFolderWritePermission(directory) {
  const options = {mode:'readwrite'};
  // Request before compression, while the Export click is still a user gesture.
  if (await directory.queryPermission(options) === 'granted') return;
  if (await directory.requestPermission(options) !== 'granted')
    throw new Error('Folder access was not granted. Choose a recording folder or use browser downloads.');
}

export function recordingFilename(session) {
  const id = String(session.device?.id || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0,80);
  return `pal-${id}-${new Date(session.started).toISOString().replace(/[:.]/g,'-')}.h5`;
}

export async function writeRecordingFile(directory, filename, bytes) {
  if (!/^[a-zA-Z0-9_.-]+\.h5$/.test(filename)) throw new Error('Invalid recording filename');
  // Repeated exports get a new filename instead of replacing a previous file.
  for (let suffix = 0; suffix < 1000; suffix++) {
    const name = suffix ? filename.replace(/\.h5$/, `-${suffix + 1}.h5`) : filename;
    try {
      await directory.getFileHandle(name);
      continue;
    } catch (error) {
      if (error.name === 'TypeMismatchError') continue; // a directory has this name
      if (error.name !== 'NotFoundError') throw error;
    }
    const handle = await directory.getFileHandle(name, {create:true});
    const writable = await handle.createWritable();
    try {await writable.write(bytes); await writable.close();}
    catch (error) {try {await writable.abort();} catch {} throw error;}
    return name;
  }
  throw new Error('Too many files with this recording name. Choose another folder.');
}
