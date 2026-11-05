import * as h5 from './vendor/h5wasm/hdf5_hl.js';
import { readSession, writeSession } from './hdf5.js';
self.onmessage = async ({data}) => {
  try {
    const {FS} = await h5.ready;
    const result = data.action === 'write' ? writeSession(h5, FS, data.session) : readSession(h5, FS, data.bytes);
    self.postMessage({result}, result instanceof Uint8Array ? [result.buffer] : []);
  } catch (error) { self.postMessage({error: error.message}); }
};
