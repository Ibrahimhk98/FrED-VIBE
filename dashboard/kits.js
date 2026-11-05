export const KIT_STORAGE_KEY = 'pal-v2-kits';
export function validHost(host) { return typeof host === 'string' && host.length <= 253 && /^[a-zA-Z0-9.-]+$/.test(host); }
export function loadKits(storage) {
  try {
    const data = JSON.parse(storage.getItem(KIT_STORAGE_KEY) || '[]');
    return Array.isArray(data) ? data.filter(k => typeof k.id === 'string' && k.id.length <= 80 && typeof k.name === 'string' && k.name.length <= 80 && validHost(k.host)).slice(0,100) : [];
  } catch { return []; }
}
export function rememberKit(kits, identity, host) {
  if (!validHost(host)) return kits;
  const id = identity?.id || `host:${host}`, name = identity?.name || host;
  const existing = kits.find(k => k.id === id);
  const updated = {id, name: name.slice(0,80), host, lastSeen:Date.now()};
  return [...kits.filter(k => k.id !== id && k.host !== host), {...existing,...updated}].slice(-100);
}

// Network results are transient. A remembered address is not proof that a kit
// is currently present, and a fresh DHCP address takes precedence by device ID.
export function availableKits(saved, discovered) {
  const network = discovered.filter(k => /^[a-f0-9]{12}$/i.test(k.id) && validHost(k.host))
    .map(k => ({...k, discovered:true}));
  return [...network, ...saved.filter(k => !network.some(n => n.id === k.id || n.host === k.host))
    .map(k => ({...k, discovered:false}))];
}
