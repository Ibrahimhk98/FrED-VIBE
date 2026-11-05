import { Bonjour } from 'bonjour-service';
import { isIPv4 } from 'node:net';

export function kitFromService(service, now = Date.now()) {
  const hostname = String(service.host || '').toLowerCase().replace(/\.$/, '');
  const id = /^pal-([a-f0-9]{12})\.local$/.exec(hostname)?.[1];
  const addresses = [...new Set((service.addresses || []).filter(address => isIPv4(address) && address !== '0.0.0.0'))];
  if (!id || service.type !== 'pal-telemetry' || service.protocol !== 'tcp' || service.port !== 81 || !addresses.length) return null;
  return {id, name:`PAL-${id.slice(-6)}`, hostname, host:addresses[0], addresses, port:81, lastSeen:now};
}

export function startDiscovery(bonjourOptions = {}) {
  const found = new Map();
  let browser, error = '', lastBrowse = 0;
  const bonjour = new Bonjour(bonjourOptions, err => { error = `Network discovery unavailable: ${err.code || err.message}`; });
  const refresh = () => {
    if (Date.now() - lastBrowse < 4000) return;
    lastBrowse = Date.now();
    // Fresh browsers also pick up unchanged SRV records whose DHCP A record
    // changed. bonjour-service otherwise retains the first address indefinitely.
    browser?.stop();
    browser = bonjour.find({type:'pal-telemetry', protocol:'tcp'}, service => {
      const kit = kitFromService(service);
      if (kit) { found.set(kit.id, kit); error = ''; }
    });
    browser.on('down', service => {
      const kit = kitFromService(service);
      if (kit) found.delete(kit.id);
    });
  };
  refresh();
  const timer = setInterval(refresh, 5000);
  return {
    snapshot() {
      const now = Date.now();
      for (const [id, kit] of found) if (now - kit.lastSeen > 30000) found.delete(id);
      return {kits:[...found.values()].sort((a,b) => a.name.localeCompare(b.name)), error, updatedAt:now};
    },
    close() {clearInterval(timer); browser?.stop(); bonjour.destroy();}
  };
}
