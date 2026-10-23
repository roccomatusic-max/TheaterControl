// Setup screen support: turn the practice show into a real one from the iPad.
//  - testDevice(): starts the real driver against an address for a few seconds and
//    explains the result in plain words (nothing is changed on the device)
//  - realTemplate(): the practice device list with addresses blanked, so cues keep working
//  - cleanDevices(): validates what the Setup screen sends before it is saved
const os = require('os');
const { execFile } = require('child_process');
const drivers = require('./drivers');
const catalog = require('./catalog');

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

// Does anything answer a ping at `host`? true/false, or null when ping isn't available here.
function ping(host) {
  const args = process.platform === 'win32' ? ['-n', '1', '-w', '1500', host] : process.platform === 'darwin' ? ['-c', '1', '-t', '2', host] : ['-c', '1', '-W', '2', host];
  return new Promise(resolve => execFile('ping', args, { timeout: 4000 }, (err, out) => {
    if (err?.code === 'ENOENT') return resolve(null);
    resolve(!err && (process.platform !== 'win32' || /TTL=/i.test(out)));
  }));
}

// Equipment that never answers back (OSC to grandMA3, DMX, ...): all a test can do is check the address is there.
async function testOneWay(dc) {
  const how = 'This kind of equipment does not answer back, so check it reacts with "Try it now" in the cue editor.';
  if (!dc.host && drivers[dc.type]?.meta?.addressOptional) return { ok: true, oneWay: true, detail: `Ready to send to everything listening on universe ${dc.universe ?? drivers[dc.type].meta.defaults?.universe ?? 1}. ${how}` };
  if (/^127\./.test(dc.host) || dc.host === 'localhost') return { ok: true, oneWay: true, detail: `Ready (on this computer). ${how}` };
  const near = sameNetwork(dc.host);
  const up = await ping(dc.host);
  if (up) return { ok: true, oneWay: true, detail: `Something is at that address. ${how}` };
  const off = near === false ? ` Also, ${dc.host} is not on the same network as this computer (${localNetworks().map(n => n.address).join(', ') || 'no network'}).` : '';
  if (up === false) return { ok: false, oneWay: true, detail: `Nothing answered at that address (some computers ignore this check because of their firewall, so it may still work).${off} ${how}` };
  return { ok: near !== false, oneWay: true, detail: `Can't check this one from here.${off} ${how}` };
}

const plain = e => PLAIN[Object.keys(PLAIN).find(k => String(e?.code || e?.message || e).includes(k))] || 'No answer from that address.';

// Starts a throwaway copy of the real driver and waits for it to hear from the device.
function testDevice(dc, ms = 6000) {
  const D = drivers[dc.type];
  if (!D) return Promise.resolve({ ok: false, detail: 'Unknown kind of equipment.' });
  if (catalog.isOneWay(dc)) return testOneWay(dc);
  if (!dc.host) return Promise.resolve({ ok: false, detail: 'Type the address first.' });
  const near = sameNetwork(dc.host);
  const templates = catalog.templatesFor(dc.profile);
  if (templates) dc = { ...dc, templates };
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
      if (!code && HINTS[dc.type]) detail += ` ${HINTS[dc.type]}`;
      if (near === false) detail += ` Also, ${dc.host} is not on the same network as this computer (${localNetworks().map(n => n.address).join(', ') || 'no network'}).`;
      resolve({ ok: false, detail });
    };
    d.on('log', e => { if (e.level === 'warn') lastErr = e.msg; });
    d.on('changed', () => { if (d.status === 'online') setTimeout(() => finish(true), 600); /* let the first replies arrive */ });
    const timer = setTimeout(() => finish(d.status === 'online'), ms);
    try { d.start(); } catch (e) { lastErr = e.message; finish(false); }
  });
}

// What to check when a device stays silent, by kind.
const HINTS = {
  qlab: 'Check QLab is open with your show, and that OSC access is turned on.',
  ptz: 'Check the camera is on, and that VISCA over IP is turned on in its settings.',
  x32: 'Check the mixer is on and that this is its network address (SETUP > Network on the desk).',
  applemidi: 'Check the network MIDI session on the other computer is ticked (enabled) and lets "Anyone" connect, and that the port is right.',
  companion: 'Check Companion is running on that computer, and the port matches the one in Companion\'s launcher window.',
  'panasonic-cam': 'Check the camera is on, and try its address in a web browser.',
  grandma: 'Check Telnet login is enabled on the console (Setup > Console > Global Settings).',
};

function describe(dc, d) {
  const s = d.state || {};
  switch (dc.type) {
    case 'eos': return `Connected to Eos${s.showName ? `, show "${s.showName}"` : ''}.`;
    case 'yamaha-tf': return 'Connected to the mixer.';
    case 'qlab': return `QLab answered${s.playheadName ? `, playhead on "${s.playheadName}"` : ''}.`;
    case 'ptz': case 'camera': return 'The camera answered.';
    case 'shure': { const linked = (s.channels || []).filter(c => c.tx).length; return `The receiver answered${linked ? `: ${linked} pack${linked > 1 ? 's' : ''} switched on` : ''}.`; }
    case 'panasonic': case 'pjlink': return `The projector answered${s.power ? `: ${s.power}` : ''}${s.info?.name ? ` (${s.info.name})` : ''}.`;
    case 'x32': return `Connected to the mixer${s.model ? ` (${s.model})` : ''}.`;
    case 'panasonic-cam': return `The camera answered${s.power != null ? `: ${s.power ? 'on' : 'standby'}` : ''}.`;
    case 'applemidi': return `MIDI session open${s.peer ? ` with "${s.peer}"` : ''}.`;
    case 'companion': return 'Companion answered.';
    case 'grandma': return `Connected to the console${s.lastReply ? `: "${s.lastReply.slice(0, 60)}"` : ''}.`;
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
    if (d.profile != null && !catalog.profileById(d.profile)) delete d.profile; // a brand entry that no longer exists: keep the driver
    const video = String(d.video || '').trim();
    if (video && !/^(rtsps?|https?):\/\/\S+$/.test(video)) throw new Error(`${name}: the video address should start with rtsp://`);
    const out = { ...d, id, name, host };
    if (video) out.video = video; else delete out.video;
    if (!host && !drivers[d.type].meta?.addressOptional) out.enabled = false; else delete out.enabled;
    return out;
  });
}

module.exports = { realTemplate, testDevice, cleanDevices, localNetworks, sameNetwork, ping, plain };
