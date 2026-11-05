export function hdf5Job(data) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./io-worker.js', import.meta.url), {type:'module'});
    worker.onmessage = ({data}) => { worker.terminate(); data.error ? reject(new Error(data.error)) : resolve(data.result); };
    worker.onerror = () => { worker.terminate(); reject(new Error('HDF5 could not load. Run npm ci and serve the dashboard from localhost.')); };
    worker.postMessage(data);
  });
}
export function download(bytes, filename, type) {
  const url = URL.createObjectURL(new Blob([bytes], {type}));
  const link = Object.assign(document.createElement('a'), {href:url, download:filename});
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
