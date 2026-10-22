// Show Control server: bridges show devices to a touch web UI over WebSocket.
// Usage: node server/index.js [path/to/show.json]   (default config/show.json)
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const express = require('express');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const drivers = require('./drivers');

const cfgPath = path.resolve(process.argv[2] || process.env.SHOW_CONFIG || path.join(__dirname, '../config/show.json'));
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const PORT = Number(process.env.PORT || cfg.server?.port || 8080);
const PIN = process.env.SHOW_PIN || cfg.server?.pin || '';

// ---------- devices ----------
const logRing = [];
const devices = new Map();
function log(entry) {
  logRing.push(entry); if (logRing.length > 300) logRing.shift();
  broadcast({ t: 'log', entry });
  if (!process.env.SHOW_QUIET) console.log(`[${new Date(entry.t).toISOString().slice(11, 19)}] ${entry.device || 'core'}: ${entry.msg}`);
}
for (const dc of cfg.devices) {
  if (dc.enabled === false) continue;
  const D = drivers[dc.type];
  if (!D) { console.warn(`unknown device type ${dc.type}`); continue; }
  const d = new D(dc);
  d.on('log', log);
  d.on('changed', () => queueDevice(d));
  devices.set(d.id, d);
}

// Coalesce state pushes (TF sync and VISCA polls can be chatty) to ≤ 20/s per device.
const dirty = new Set();
let flushTimer = null;
function queueDevice(d) {
  dirty.add(d);
  if (!flushTimer) flushTimer = setTimeout(() => {
    flushTimer = null;
    for (const x of dirty) broadcast({ t: 'device', device: x.snapshot() });
    dirty.clear();
  }, 50);
}

// Projector groups from config, plus a built-in "all" group of every projector.
const projectors = () => [...devices.values()].filter(d => d.kind === 'projector');
const groups = () => [
  { id: 'all', name: 'All projectors', members: projectors().map(d => d.id) },
  ...(cfg.projection?.groups || []).map(g => ({ ...g, members: g.members.filter(id => devices.has(id)) })),
];

const LEVEL = { ok: 'cmd', accepted: 'cmd', sent: 'cmd', busy: 'warn', timeout: 'warn' };
// Runs one action against a device or a group ("group:<id>"); returns one result per device.
async function runAction(a, source) {
  let targets;
  if (String(a.device).startsWith('group:')) {
    const g = groups().find(x => x.id === a.device.slice(6));
    if (!g) throw new Error(`no projector group "${a.device.slice(6)}"`);
    targets = g.members.map(id => devices.get(id));
  } else {
    const d = devices.get(a.device);
    if (!d) throw new Error(`no device "${a.device}"`);
    targets = [d];
  }
  // Group commands go out concurrently; each projector reports its own outcome.
  return Promise.all(targets.map(async d => {
    let r;
    try { r = (await d.command(a.cmd, a.args || {})) || { outcome: 'sent' }; }
    catch (e) { r = { outcome: 'not_sent', detail: e.message }; }
    if (a.cmd !== 'move' && a.cmd !== 'zoom') {
      log({ device: d.id, level: LEVEL[r.outcome] || 'error', msg: `${a.cmd} ${JSON.stringify(a.args || {})} → ${r.outcome}${r.detail ? `: ${r.detail}` : ''} (${source})`, t: Date.now() });
    }
    return { device: d.id, name: d.name, ...r };
  }));
}

// ---------- show cue stack ----------
// A show cue fires several device actions at once (or with per-action delay), e.g.
// Eos cue 12 + QLab GO + TF scene + camera preset.
const show = {
  name: cfg.show?.name || 'Show',
  cues: cfg.show?.cues || [],
  index: 0,          // standby (next) cue
  lastFired: null,
  timers: { show: { start: null, acc: 0 }, act: { start: null, acc: 0 }, label: cfg.show?.timerLabel || 'Act 1' },
};
const showSnapshot = () => ({ name: show.name, cues: show.cues, index: show.index, lastFired: show.lastFired, timers: show.timers, now: Date.now() });
function fireCue(i, source) {
  const cue = show.cues[i];
  if (!cue) return;
  show.lastFired = i;
  show.index = Math.min(i + 1, show.cues.length);
  log({ device: 'show', level: 'go', msg: `GO ${cue.number ?? i + 1} ${cue.label || ''} (${source})`, t: Date.now() });
  for (const a of cue.actions || []) {
    setTimeout(() => runAction(a, `cue ${cue.number ?? i + 1}`).catch(e => log({ device: a.device, level: 'error', msg: e.message, t: Date.now() })), (a.delay || 0) * 1000);
  }
  broadcast({ t: 'show', show: showSnapshot() });
}
function timer(name, op) {
  const tm = show.timers[name]; if (!tm) return;
  if (op === 'start' && !tm.start) tm.start = Date.now();
  if (op === 'stop' && tm.start) { tm.acc += Date.now() - tm.start; tm.start = null; }
  if (op === 'reset') { tm.acc = 0; tm.start = tm.start ? Date.now() : null; }
}

// ---------- HTTP + WS ----------
// IPv4 addresses an iPad on the same network can reach this computer at.
function lanAddresses() {
  return Object.entries(os.networkInterfaces()).flatMap(([name, list]) => (list || [])
    .filter(i => i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'))
    .map(i => ({ name: /^100\./.test(i.address) ? 'Tailscale (works from anywhere)' : 'this network', url: `http://${i.address}:${PORT}`, ts: /^100\./.test(i.address) })))
    .sort((a, b) => a.ts - b.ts); // local network first, Tailscale last
}
const app = express();
// "Connect your iPad" page: address + QR code to scan with the iPad camera.
app.get('/connect', async (_, res) => {
  const addrs = lanAddresses();
  const qrs = await Promise.all(addrs.map(a => QRCode.toString(a.url, { type: 'svg', margin: 1, color: { dark: '#000', light: '#fff' } })));
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect your iPad · Show Control</title><style>
body{margin:0;background:#0b0d10;color:#e7eaee;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:24px}
main{max-width:860px;margin:0 auto}h1{margin:0 0 4px}p{color:#8b94a1;margin:0 0 20px}
.addrs{display:flex;flex-wrap:wrap;gap:20px}.a{background:#15181d;border:1px solid #2a3039;border-radius:14px;padding:16px;text-align:center}
.a svg{width:220px;height:220px;border-radius:8px}.u{font:600 20px ui-monospace,Menlo,monospace;margin-top:8px}.n{color:#8b94a1;font-size:13px}
ol{color:#c9ced6;padding-left:20px}a.btn{display:inline-block;margin-top:20px;background:#1fbf5a;color:#04140a;font-weight:800;padding:12px 20px;border-radius:10px;text-decoration:none}
</style></head><body><main>
<h1>Show Control is running</h1><p>${show.name}</p>
<h2>Connect your iPad or phone</h2>
<ol><li>Join the iPad to the <b>same Wi-Fi network</b> as this computer.</li>
<li>Open the <b>Camera</b> app and point it at the code, then tap the link. Or type the address into Safari.</li>
<li>In Safari tap <b>Share → Add to Home Screen</b> to get a full-screen app icon.</li></ol>
<div class="addrs">${addrs.length ? addrs.map((a, i) => `<div class="a">${qrs[i]}<div class="u">${a.url}</div><div class="n">${a.name}</div></div>`).join('') : '<p>This computer is not on a network yet. Connect it to Wi-Fi or Ethernet and reload this page.</p>'}</div>
<a class="btn" href="/">Open the controls on this computer</a>
</main></body></html>`);
});
app.use(express.static(path.join(__dirname, '../public'), { maxAge: 0 }));
app.get('/api/health', (_, res) => res.json({ ok: true, app: 'show-control', show: show.name, addresses: lanAddresses(), devices: [...devices.values()].map(d => ({ id: d.id, status: d.status })) }));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of wss.clients) if (c.authed && c.readyState === 1) c.send(s);
}

wss.on('connection', (ws, req) => {
  const who = req.socket.remoteAddress?.replace('::ffff:', '');
  ws.authed = !PIN;
  const hello = () => ws.send(JSON.stringify({
    t: 'init', devices: [...devices.values()].map(d => d.snapshot()), show: showSnapshot(), log: logRing.slice(-100),
    ui: cfg.ui || {}, groups: groups(),
  }));
  if (ws.authed) hello(); else ws.send(JSON.stringify({ t: 'auth-required' }));

  ws.on('message', async raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'auth') {
      if (String(m.pin) === String(PIN)) { ws.authed = true; hello(); log({ device: 'core', msg: `client ${who} signed in`, t: Date.now() }); }
      else ws.send(JSON.stringify({ t: 'auth-failed' }));
      return;
    }
    if (!ws.authed) return;
    try {
      if (m.t === 'cmd') {
        const results = await runAction(m, who);
        if (m.id) ws.send(JSON.stringify({ t: 'result', id: m.id, results }));
      }
      else if (m.t === 'show') {
        if (m.action === 'go') fireCue(show.index, who);
        else if (m.action === 'fire') fireCue(Number(m.index), who);
        else if (m.action === 'standby') show.index = Math.max(0, Math.min(show.cues.length, Number(m.index)));
        else if (m.action === 'timer') timer(m.timer, m.op);
        broadcast({ t: 'show', show: showSnapshot() });
      }
    } catch (e) {
      ws.send(JSON.stringify({ t: 'error', msg: e.message }));
      log({ device: m.device || 'core', level: 'error', msg: e.message, t: Date.now() });
    }
  });
});

server.listen(PORT, cfg.server?.host || '0.0.0.0', () => {
  const urls = lanAddresses().map(a => a.url);
  console.log(`Show Control "${show.name}" using ${cfgPath}`);
  console.log(`Open on iPad/phone: ${urls.join('  ') || `http://localhost:${PORT}`}${PIN ? '  (PIN required)' : ''}`);
  for (const d of devices.values()) d.start();
  server.emit('ready', { port: PORT, urls });
});

module.exports = { server, lanAddresses };

function shutdown() { for (const d of devices.values()) d.stop(); process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
