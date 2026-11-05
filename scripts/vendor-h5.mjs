import { cp, mkdir } from 'node:fs/promises';
await mkdir('dashboard/vendor/h5wasm', { recursive: true });
await cp('node_modules/h5wasm/dist/esm', 'dashboard/vendor/h5wasm', { recursive: true });
await cp('node_modules/h5wasm/LICENSE.txt', 'dashboard/vendor/h5wasm/LICENSE.txt');
