// Setup screen support: turn the practice show into a real one from the iPad.
//  - testDevice(): starts the real driver against an address for a few seconds and
//    explains the result in plain words (nothing is changed on the device)
//  - realTemplate(): the practice device list with addresses blanked, so cues keep working
//  - cleanDevices(): validates what the Setup screen sends before it is saved
const os = require('os');
const net = require('net');
const drivers = require('./drivers');

// Settings that only make sense for the simulators (fake ports, fast warm-up) are never copied to a real show.
const SIM_ONLY = ['port', 'pjlinkPort', 'gapMs', 'warmupMs', 'cooldownMs', 'pollMs', 'inputs', 'password'];

function realTemplate(devices) {
  return devices.map(d => {
    const r = { ...d, host: '' };
    for (const k of SIM_ONLY) delete r[k];
    if (r.stream?.type === 'sim') delete r.stream;
    return r;
  });
}

const isIPv4 = s => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s) && s.split('.').every(n => Number(n) <= 255);
const toInt = ip => ip.split('.').reduce((a, n) => (a * 256) + Number(n), 0);

// Is `host` on one of this computer's networks? null when it can't be told (a name, not a number).
function sameNetwork(host) {
  if (!isIPv4(host)) return null;
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal || !i.netmask) continue;
      const mask = toInt(i.netmask);
      if ((toInt(i.address) & mask) >>> 0 === (toInt(host) & mask) >>> 0) return true;
    }
  }
  return host.startsWith('127.') ? true : false;
}

// This computer's own wired/Wi-Fi addresses, with the range a device must be in to be reachable.
function localNetworks() {
  return Object.entries(os.networkInterfaces()).flatMap(([name, list]) => (list || [])
    .filter(i => i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.') && !i.address.startsWith('100.'))
    .map(i => ({ name, address: i.address, netmask: i.netmask })));
}

const PLAIN = {
  ECONNREFUSED: 'Something is at this address, but it is not accepting remote control. Turn on network control on the device (see "How to set it up").',
  EHOSTUNREACH: 'This computer cannot reach that address. Check the network cable and that the address is right.',
  ENETUNREACH: 'This computer is not on a network that can reach that address.',
  ETIMEDOUT: 'Nothing answered at that address.',
  ENOTFOUND: 'That name could not be found. Use the number address instead (like 10.101.50.20).',
};

// Starts a throwaway copy of the real driver and waits for it to hear from the device.
function testDevice(dc, ms = 6000) {
  const D = drivers[dc.type];
  if (!D) return Promise.resolve({ ok: false, detail: 'Unknown kind of equipment.' });
  if (!dc.host) return Promise.resolve({ ok: false, detail: 'Type the address first.' });
  const near = sameNetwork(dc.host);
  return new Promise(resolve => {
    let lastErr = '';
    let d;
    let done = false;
    try { d = new D({ ...dc, id: `test-${dc.id || dc.type}` }); }
    catch (e) { return resolve({ ok: false, detail: e.message }); }
    const finish = ok => {
      if (done) return; done = true;
      clearTimeout(timer); d.removeAllListeners();
      try { d.stop(); } catch { /* already stopped */ }
      const lr = d.state?.lastResult;
      if (ok) return resolve({ ok: true, detail: describe(dc, d) });
      if (lr?.outcome === 'auth_failed') return resolve({ ok: false, detail: 'The device answered, but the password was wrong.' });
      const code = Object.keys(PLAIN).find(k => lastErr.includes(k));
      let detail = code ? PLAIN[code] : 'No answer from that address.';
      if (!code && ['qlab', 'ptz'].includes(dc.type)) detail += dc.type === 'qlab'
        ? ' Check QLab is open with your show, and that OSC access is turned on.'
        : ' Check the camera is on, and that VISCA over IP is turned on in its settings.';
      if (near === false) detail += ` Also, ${dc.host} is not on the same network as this computer (${localNetworks().map(n => n.address).join(', ') || 'no network'}).`;
      resolve({ ok: false, detail });
    };
    d.on('log', e => { if (e.level === 'warn') lastErr = e.msg; });
    d.on('changed', () => { if (d.status === 'online') setTimeout(() => finish(true), 600); /* let the first replies arrive */ });
    const timer = setTimeout(() => finish(d.status === 'online'), ms);
    try { d.start(); } catch (e) { lastErr = e.message; finish(false); }
  });
}

function describe(dc, d) {
  const s = d.state || {};
  switch (dc.type) {
    case 'eos': return `Connected to Eos${s.showName ? `, show "${s.showName}"` : ''}.`;
    case 'yamaha-tf': return 'Connected to the mixer.';
    case 'qlab': return `QLab answered${s.playheadName ? `, playhead on "${s.playheadName}"` : ''}.`;
    case 'ptz': return 'The camera answered.';
    case 'panasonic': case 'pjlink': return `The projector answered${s.power ? `: ${s.power}` : ''}${s.info?.name ? ` (${s.info.name})` : ''}.`;
    default: return 'Connected.';
  }
}

// What the Setup screen may save. Unknown kinds and duplicate names are refused.
function cleanDevices(list) {
  if (!Array.isArray(list) || !list.length) throw new Error('Add at least one piece of equipment.');
  const ids = new Set();
  return list.map((d, i) => {
    if (!drivers[d.type]) throw new Error(`Item ${i + 1}: unknown kind of equipment`);
    const id = String(d.id || '').trim();
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new Error(`Item ${i + 1}: bad internal name`);
    if (ids.has(id)) throw new Error(`Two items are both called "${id}"`);
    ids.add(id);
    const name = String(d.name || '').trim() || id;
    const host = String(d.host || '').trim();
    if (host && !isIPv4(host) && !/^[A-Za-z0-9.-]+$/.test(host)) throw new Error(`${name}: "${host}" is not an address`);
    const out = { ...d, id, name, host };
    if (!host) out.enabled = false; else delete out.enabled;
    return out;
  });
}

module.exports = { realTemplate, testDevice, cleanDevices, localNetworks, sameNetwork };
