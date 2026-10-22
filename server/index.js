// Show Control server: bridges show devices to a touch web UI over WebSocket.
// Usage: node server/index.js [path/to/show.json]   (default config/show.json)
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const express = require('express');
const { WebSocketServer } = require('ws');
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
  console.log(`[${new Date(entry.t).toISOString().slice(11, 19)}] ${entry.device || 'core'}: ${entry.msg}`);
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
const app = express();
app.use(express.static(path.join(__dirname, '../public'), { maxAge: 0 }));
app.get('/api/health', (_, res) => res.json({ ok: true, devices: [...devices.values()].map(d => ({ id: d.id, status: d.status })) }));
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
  const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log(`Show Control "${show.name}" using ${cfgPath}`);
  console.log(`Open on iPad/phone: ${ips.map(ip => `http://${ip}:${PORT}`).join('  ') || `http://localhost:${PORT}`}${PIN ? '  (PIN required)' : ''}`);
  for (const d of devices.values()) d.start();
});

function shutdown() { for (const d of devices.values()) d.stop(); process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
