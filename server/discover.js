// "Find my equipment": looks for show gear on this computer's networks, in about 10 seconds.
// Read-only: it only asks "who's there?" in ways the gear is built to answer, never changes anything.
//  1. Broadcast "who's there" messages that gear is made to answer: Sony/VISCA camera finder,
//     PJLink class 2 search, Art-Net poll (finds consoles and DMX nodes), X32/X Air /xinfo.
//  2. Bonjour (mDNS) for QLab and network MIDI sessions.
//  3. Knocks on the usual control ports of nearby addresses (this computer's own /24, the /24 of
//     every address already typed in, and whatever the computer has recently talked to), and
//     reads the greeting where there is one (PJLink, Panasonic, Yamaha, HyperDeck...).
// Every result says how sure it is: "sure" (the device said what it is) or "likely" (the right port is open).
const os = require('os');
const fs = require('fs');
const net = require('net');
const dgram = require('dgram');
const { execFile } = require('child_process');
const osc = require('./lib/osc');
const { request } = require('./lib/http');

const isIPv4 = s => /^\d{1,3}(\.\d{1,3}){3}$/.test(s) && s.split('.').every(n => Number(n) <= 255);
const toInt = ip => ip.split('.').reduce((a, n) => (a * 256) + Number(n), 0) >>> 0;
const toIp = n => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

// This computer's IPv4 networks (Tailscale and link-local left out: no show gear lives there).
function interfaces() {
  return Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.') && !i.address.startsWith('100.'))
    .map(i => ({ address: i.address, netmask: i.netmask, broadcast: toIp((toInt(i.address) & toInt(i.netmask)) | (~toInt(i.netmask) >>> 0)) }));
}
const slash24 = ip => { const b = ip.split('.').slice(0, 3).join('.'); return Array.from({ length: 254 }, (_, i) => `${b}.${i + 1}`); };

// Addresses this computer has talked to recently (the ARP table): a cheap list of what's alive.
function arpTable() {
  return new Promise(resolve => {
    try {
      const t = fs.readFileSync('/proc/net/arp', 'utf8');
      return resolve(t.split('\n').slice(1).map(l => l.split(/\s+/)).filter(c => c[2] && c[2] !== '0x0').map(c => c[0]).filter(isIPv4));
    } catch { /* not Linux */ }
    execFile('arp', ['-a'], { timeout: 3000 }, (err, out) => resolve(err ? [] : [...String(out).matchAll(/(\d{1,3}(?:\.\d{1,3}){3})/g)].map(m => m[1]).filter(ip => isIPv4(ip) && !ip.endsWith('.255'))));
  });
}

// ---------- 1. broadcast probes ----------
const ARTNET_POLL = Buffer.concat([Buffer.from('Art-Net\0', 'ascii'), Buffer.from([0x00, 0x20, 0x00, 0x0e, 0x00, 0x00])]);
const SONY_ENQ = Buffer.concat([Buffer.from([0x02]), Buffer.from('ENQ:network', 'ascii'), Buffer.from([0xff, 0x03])]);

// What an Art-Net poll reply's name says about the device.
function artnetGuess(name) {
  if (/eos|\bion\b|gio|element|apex|nomad|\betc\b/i.test(name)) return { type: 'eos', profile: 'eos', label: 'ETC Eos console' };
  if (/grandma3|ma3|gma3/i.test(name)) return { type: 'grandma', profile: 'grandma3', label: 'grandMA3', defaults: { version: '3' } };
  if (/grandma|\bma\b/i.test(name)) return { type: 'grandma', profile: 'grandma2', label: 'grandMA', defaults: { version: '2' } };
  if (/magicq|chamsys/i.test(name)) return { type: 'magicq', profile: 'magicq', label: 'ChamSys MagicQ' };
  return { type: 'dmx', profile: 'artnet', label: 'Art-Net DMX node', defaults: { protocol: 'artnet' } };
}

function broadcastProbes(ifaces, found, ms) {
  return new Promise(resolve => {
    const socks = [];
    const own = new Set(ifaces.map(i => i.address));
    const onMsg = (port, m, r) => {
      if (own.has(r.address)) return; // our own broadcast echoed back
      try {
        if (m.toString('ascii', 0, 8) === 'Art-Net\0' && m.readUInt16LE(8) === 0x2100) {
          const ip = [...m.subarray(10, 14)].join('.');
          const short = m.toString('latin1', 26, 44).replace(/\0.*$/s, ''), long = m.toString('latin1', 44, 108).replace(/\0.*$/s, '');
          const g = artnetGuess(`${short} ${long}`);
          found({ host: isIPv4(ip) && ip !== '0.0.0.0' ? ip : r.address, ...g, name: long || short, detail: `answered an Art-Net search as "${long || short}"`, confidence: g.type === 'dmx' ? 'likely' : 'sure' });
        } else if (m[0] === 0x02 && m.includes('MAC:')) {
          const f = Object.fromEntries(m.toString('latin1').split(/[\xff\x02\x03]/).map(x => x.split(':')).filter(x => x.length >= 2).map(([k, ...v]) => [k, v.join(':')]));
          found({ host: f.IPADR || r.address, type: 'ptz', profile: 'sony', label: 'VISCA camera', defaults: { protocol: 'visca-ip', port: 52381 }, name: f.NAME || f.MODEL || '', detail: `answered the camera finder${f.MODEL ? ` as ${f.MODEL}` : ''}`, confidence: 'sure' });
        } else if (/^%2ACKN=/.test(m.toString('latin1'))) {
          found({ host: r.address, type: 'pjlink', profile: 'pjlink', label: 'PJLink projector', detail: 'answered a PJLink search', confidence: 'sure' });
        } else if (port === 'osc') {
          const { address, args } = osc.decode(m);
          if (address === '/xinfo' || address === '/info') {
            const model = args.map(String).find(a => /X32|M32|XR|MR|X-?AIR/i.test(a)) || '';
            const air = /XR|MR|AIR/i.test(model);
            found({ host: r.address, type: 'x32', profile: air ? 'xair' : 'x32', label: air ? 'Behringer X Air / Midas MR' : 'Behringer X32 / Midas M32', defaults: { series: air ? 'xair' : 'x32' }, name: String(args[1] || ''), detail: `answered as ${model || 'a Behringer/Midas mixer'}`, confidence: 'sure' });
          }
        }
      } catch { /* not a reply we understand */ }
    };
    const open = (port, tag, send) => {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      socks.push(s);
      s.on('error', () => {});
      s.on('message', (m, r) => onMsg(tag, m, r));
      s.bind(port, () => { try { s.setBroadcast(true); send(s); } catch { /* no broadcast here */ } });
    };
    const targets = [...new Set([...ifaces.map(i => i.broadcast), '255.255.255.255'])];
    const each = (s, buf, port) => targets.forEach(t => s.send(buf, port, t, () => {}));
    // Art-Net replies go to port 6454, Sony camera replies to 52380, PJLink class 2 to 4352.
    open(6454, 'artnet', s => each(s, ARTNET_POLL, 6454));
    open(52380, 'sony', s => each(s, SONY_ENQ, 52380));
    open(4352, 'pjlink', s => each(s, Buffer.from('%2SRCH\r', 'latin1'), 4352));
    open(0, 'osc', s => { for (const p of [10023, 10024]) { each(s, osc.encode('/xinfo'), p); } });
    setTimeout(() => { socks.forEach(s => { try { s.close(); } catch { /* closed */ } }); resolve(); }, ms);
  });
}

// ---------- 2. Bonjour / mDNS ----------
function dnsName(buf, off) {
  const labels = []; let jumped = false, end = off, guard = 0;
  while (off < buf.length && guard++ < 64) {
    const len = buf[off];
    if (len === 0) { off++; break; }
    if ((len & 0xc0) === 0xc0) { if (!jumped) end = off + 2; off = ((len & 0x3f) << 8) | buf[off + 1]; jumped = true; continue; }
    labels.push(buf.toString('utf8', off + 1, off + 1 + len)); off += len + 1;
  }
  return [labels.join('.'), jumped ? end : off];
}
function mdnsQuery(names) {
  const parts = [Buffer.from([0, 0, 0, 0, 0, names.length, 0, 0, 0, 0, 0, 0])];
  for (const n of names) {
    for (const l of n.split('.')) parts.push(Buffer.from([l.length]), Buffer.from(l));
    parts.push(Buffer.from([0, 0, 12, 0, 1])); // PTR, IN
  }
  return Buffer.concat(parts);
}
// Answers: [{ service, instance, port }] — the host is the reply's sender.
function mdnsParse(buf) {
  const out = []; const srv = {};
  const count = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let off = 12;
  for (let i = 0; i < buf.readUInt16BE(4); i++) { off = dnsName(buf, off)[1] + 4; }
  for (let i = 0; i < count && off < buf.length; i++) {
    const [name, o] = dnsName(buf, off);
    const type = buf.readUInt16BE(o), len = buf.readUInt16BE(o + 8), data = o + 10;
    if (type === 12) out.push({ service: name, instance: dnsName(buf, data)[0] });
    if (type === 33) srv[name] = buf.readUInt16BE(data + 4);
    off = data + len;
  }
  return out.map(x => ({ ...x, port: srv[x.instance] }));
}
const MDNS = {
  '_qlab._tcp.local': x => ({ type: 'qlab', profile: 'qlab', label: 'QLab', name: x.instance.split('._qlab')[0], confidence: 'sure', detail: 'QLab announced itself on the network' }),
  '_apple-midi._udp.local': x => ({ type: 'applemidi', profile: 'midi', label: 'Network MIDI session', name: x.instance.split('._apple-midi')[0], defaults: x.port ? { port: x.port } : {}, confidence: 'sure', detail: 'a network MIDI session announced itself' }),
  '_osc._udp.local': x => ({ type: 'osc', profile: 'osc', label: 'OSC receiver', name: x.instance.split('._osc')[0], defaults: x.port ? { port: x.port } : {}, confidence: 'likely', detail: 'announced an OSC input' }),
};
function mdns(found, ms) {
  return new Promise(resolve => {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    s.on('error', () => {});
    s.on('message', (m, r) => {
      try {
        for (const x of mdnsParse(m)) { const f = MDNS[x.service]; if (f) found({ host: r.address, ...f(x) }); }
      } catch { /* malformed */ }
    });
    s.bind(0, () => { try { s.send(mdnsQuery(Object.keys(MDNS)), 5353, '224.0.0.251', () => {}); } catch { /* no multicast */ } });
    setTimeout(() => { try { s.close(); } catch { /* closed */ } resolve(); }, ms);
  });
}

// ---------- 3. port knocks ----------
// [port, what it suggests, how to confirm from the greeting (or a question we send)]
const PORTS = [
  { port: 3037, guess: { type: 'eos', profile: 'eos', label: 'ETC Eos console' }, confidence: 'sure' },
  { port: 49280, guess: { type: 'yamaha-tf', profile: 'yamaha-tf', label: 'Yamaha mixer' }, ask: 'devinfo productname\n',
    read: t => { const m = t.match(/productname\s+"([^"]+)"/); if (!m) return null; const cl = /^(CL|QL|RIVAGE|PM|DM7)/i.test(m[1]); return { name: m[1], profile: cl ? 'yamaha-cl' : 'yamaha-tf', label: `Yamaha ${m[1]}`, defaults: cl ? { series: 'cl' } : {}, confidence: 'sure' }; } },
  { port: 4352, guess: { type: 'pjlink', profile: 'pjlink', label: 'PJLink projector' }, read: t => (/^PJLINK [01]/.test(t) ? { confidence: 'sure' } : null) },
  { port: 1024, guess: { type: 'panasonic', profile: 'panasonic', label: 'Panasonic projector' }, read: t => (/^NTCONTROL [01]/.test(t) ? { confidence: 'sure' } : false) },
  { port: 5678, guess: { type: 'ptz', profile: 'ptzoptics', label: 'PTZ camera (VISCA over TCP)', defaults: { protocol: 'visca-tcp', port: 5678 } }, confidence: 'likely' },
  { port: 53000, guess: { type: 'qlab', profile: 'qlab', label: 'QLab' }, confidence: 'likely' },
  { port: 30000, guess: { type: 'grandma', profile: 'grandma2', label: 'grandMA2', defaults: { version: '2' } }, read: t => (/grandMA|MA Lighting/i.test(t) ? { confidence: 'sure' } : false) },
  { port: 51325, guess: { type: 'allen-heath', profile: 'allen-heath', label: 'Allen & Heath mixer', defaults: { series: 'sq' } }, confidence: 'likely' },
  { port: 51328, guess: { type: 'allen-heath', profile: 'allen-heath', label: 'Allen & Heath dLive', defaults: { series: 'dlive' } }, confidence: 'likely' },
  { port: 9990, guess: { type: 'text', profile: 'videohub', label: 'Blackmagic Videohub', defaults: { protocol: 'tcp', port: 9990, ending: 'lf' } }, read: t => (/PROTOCOL PREAMBLE|VIDEOHUB/i.test(t) ? { confidence: 'sure' } : false) },
  { port: 9993, guess: { type: 'text', profile: 'hyperdeck', label: 'Blackmagic HyperDeck', defaults: { protocol: 'tcp', port: 9993, ending: 'lf' } },
    read: t => (/^500 connection info/m.test(t) ? { confidence: 'sure', name: (t.match(/model:\s*(.+)/) || [])[1]?.trim() } : false) },
  { port: 3040, guess: { type: 'text', profile: 'watchout', label: 'Watchout production computer', defaults: { protocol: 'tcp', port: 3040, ending: 'cr' } }, confidence: 'likely' },
  { port: 8000, http: true, guess: { type: 'companion', profile: 'companion', label: 'Bitfocus Companion' }, check: b => /companion/i.test(b) },
  { port: 80, http: true, guess: { type: 'panasonic-cam', profile: 'panasonic-cam', label: 'Panasonic PTZ camera' }, path: '/cgi-bin/aw_ptz?cmd=%23O&res=1', check: b => /^p[0-3]\s*$/.test(b.trim()) },
];

// Connect, listen for a greeting (or send a question), give up quickly.
function knock(host, p, connectMs = 700, readMs = 900) {
  return new Promise(resolve => {
    let text = '', done = false, connected = false;
    const sock = net.connect(p.port, host);
    const finish = () => { if (done) return; done = true; clearTimeout(t1); clearTimeout(t2); sock.destroy(); resolve(connected ? text : null); };
    const t1 = setTimeout(() => { if (!connected) finish(); }, connectMs);
    let t2;
    sock.on('connect', () => { connected = true; if (p.ask) sock.write(p.ask); t2 = setTimeout(finish, p.read ? readMs : 50); });
    sock.on('data', d => { text += d.toString('latin1'); if (text.length > 2000) finish(); });
    sock.on('error', finish);
    sock.on('close', finish);
  });
}

// Anything at this address? A refused connection counts: only a live device refuses.
function isThere(host, ms = 600) {
  return new Promise(resolve => {
    const sock = net.connect(4352, host);
    const done = v => { clearTimeout(t); sock.destroy(); resolve(v); };
    const t = setTimeout(() => done(false), ms);
    sock.on('connect', () => done(true));
    sock.on('error', e => done(e.code === 'ECONNREFUSED'));
  });
}

async function probeHost(host, found, ports) {
  await Promise.all(ports.map(async p => {
    if (p.http) {
      // only bother with web checks on addresses that answered something else, or were asked for
      const r = await request({ host, port: p.port, path: p.path || '/', timeout: 1200 });
      if (!r.error && p.check(r.body)) found({ host, ...p.guess, defaults: { ...(p.guess.defaults || {}), ...(p.port !== 80 && p.port !== 8000 ? { port: p.port } : {}) }, confidence: 'sure', detail: `answered on port ${p.port}` });
      return;
    }
    const text = await knock(host, p);
    if (text == null) return;
    const extra = p.read ? p.read(text) : null;
    if (extra === false) return; // the greeting says it's something else
    found({ host, ...p.guess, ...(extra || {}), defaults: { ...(p.guess.defaults || {}), ...(extra?.defaults || {}) }, confidence: extra?.confidence || p.confidence || 'likely', detail: `answered on port ${p.port}` });
  }));
}

// Runs `fn` over `items` with at most `n` at a time.
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

// hosts: addresses already typed in. Options for tests: ports (subset/override), broadcast:false, scan:false.
async function discover({ hosts = [], ports = PORTS, broadcast = true, scan = true, timeMs = 3000 } = {}) {
  const started = Date.now();
  const ifaces = interfaces();
  const results = new Map();
  let searchedCount = 0;
  const found = r => {
    const key = `${r.host}|${r.profile || r.type}`;
    const old = results.get(key);
    if (!old || (old.confidence !== 'sure' && r.confidence === 'sure')) results.set(key, { ...old, ...r, name: r.name || old?.name || '' });
  };
  const own = new Set(ifaces.map(i => i.address));
  hosts = [...new Set([...hosts.filter(isIPv4), '127.0.0.1'])]; // 127.0.0.1: QLab, Companion etc. on this same computer
  const tasks = [];
  if (broadcast) tasks.push(broadcastProbes(ifaces, found, timeMs), mdns(found, timeMs));
  const tcpPorts = ports.filter(p => !p.http), httpPorts = ports.filter(p => p.http);
  const full = async h => {
    const before = results.size;
    await probeHost(h, found, tcpPorts);
    // web checks only where something else answered, or the address was typed in
    if (httpPorts.length && (results.size > before || hosts.includes(h))) await probeHost(h, found, httpPorts);
  };
  tasks.push((async () => {
    // Who is there? Addresses typed in, plus whatever has talked to this computer lately (ARP),
    // plus anything on the same /24s that answers a quick knock. Only those get the full check.
    const alive = new Set(hosts);
    if (scan) {
      for (const x of await arpTable()) alive.add(x);
      const nearby = new Set();
      for (const h of [...hosts, ...ifaces.map(i => i.address)]) if (!h.startsWith('127.')) for (const x of slash24(h)) nearby.add(x);
      const unknown = [...nearby].filter(x => !alive.has(x) && !own.has(x)).slice(0, 2048);
      await pool(unknown, 128, async h => { if (await isThere(h)) alive.add(h); });
      for (const x of await arpTable()) alive.add(x); // knocking fills the ARP table with everything that exists
    }
    for (const x of own) alive.delete(x);
    searchedCount = alive.size;
    await pool([...alive], 32, full);
  })());
  await Promise.all(tasks);
  // one entry per address and kind; "sure" first
  const out = [...results.values()].sort((a, b) => (a.confidence === b.confidence ? toInt(a.host) - toInt(b.host) : a.confidence === 'sure' ? -1 : 1));
  return { found: out, networks: ifaces.map(i => ({ address: i.address, netmask: i.netmask })), checked: searchedCount, ms: Date.now() - started };
}

module.exports = { discover, PORTS, mdnsParse, mdnsQuery, artnetGuess };
