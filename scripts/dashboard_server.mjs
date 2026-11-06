import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startDiscovery } from './discovery.mjs';
import { createFirmwareService } from './firmware-service.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../dashboard');
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.wasm':'application/wasm','.json':'application/json'};

export function createDashboardServer(discovery, firmware = createFirmwareService()) {
  return createServer(async (req, res) => {
    const host = req.headers.host || '';
    // Loopback binding plus Host/Origin checks keep the local inventory local.
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ||
        (req.headers.origin && req.headers.origin !== `http://${host}`)) {
      res.writeHead(403); res.end('Local dashboard only'); return;
    }
    const headers = {'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
    try {
      const pathname = decodeURIComponent(new URL(req.url, `http://${host}`).pathname);
      if (pathname.startsWith('/api/firmware')) {
        let result;
        if(req.method==='GET' && pathname==='/api/firmware')result=await firmware.snapshot();
        else if(req.method==='GET' && pathname==='/api/firmware/status')result=firmware.status();
        else if(req.method==='POST' && ['/api/firmware/read','/api/firmware/flash'].includes(pathname)) {
          if(req.headers.origin!==`http://${host}` || req.headers['content-type']!=='application/json') {
            res.writeHead(403);res.end('Same-origin JSON request required');return;
          }
          let body='';for await(const chunk of req){body+=chunk;if(body.length>2048)throw Object.assign(new Error('Request too large'),{status:413});}
          result=await firmware.start(pathname.split('/').at(-1),JSON.parse(body));
        } else {res.writeHead(405);res.end();return;}
        res.writeHead(200,{...headers,'Content-Type':'application/json'});res.end(JSON.stringify(result));return;
      }
      if (!['GET','HEAD'].includes(req.method)) {res.writeHead(405); res.end(); return;}
      if (pathname === '/api/kits') {
        res.writeHead(200, {...headers,'Content-Type':'application/json'});
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify(discovery.snapshot())); return;
      }
      const path = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!path.startsWith(root + sep)) {res.writeHead(403); res.end(); return;}
      const bytes = await readFile(path);
      res.writeHead(200, {...headers,'Content-Type':types[extname(path)] || 'application/octet-stream'});
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      res.writeHead(error.status || (error.code === 'ENOENT' || error.code === 'EISDIR' ? 404 : 400), {...headers,'Content-Type':'application/json'});
      res.end(JSON.stringify({error:error.message}));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PAL_DASHBOARD_PORT || 8000);
  const discovery = startDiscovery(), server = createDashboardServer(discovery);
  server.on('error', error => {console.error(error.message); discovery.close(); process.exitCode = 1;});
  server.listen(port, '127.0.0.1', () => console.log(`PAL dashboard: http://localhost:${port}\nDiscovering PAL kits on the local network.`));
  const close = () => {discovery.close(); server.close();};
  process.once('SIGINT', close); process.once('SIGTERM', close);
}
