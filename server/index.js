// Show Control server: bridges show devices to a touch web UI over WebSocket.
// Usage: node server/index.js [path/to/show.json]   (default config/show.json)
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const http = require('http');
const os = require('os');
const express = require('express');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const drivers = require('./drivers');
const setup = require('./setup');
const catalog = require('./catalog');
const discover = require('./discover');
const { MicPlan, validateMics } = require('./mics');
const FeedbackWatch = require('./feedback');
const createCrew = require('./crew');

const cfgPath = path.resolve(process.argv[2] || process.env.SHOW_CONFIG || path.join(__dirname, '../config/show.json'));
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const PORT = Number(process.env.PORT || cfg.server?.port || 8080);
const PIN = process.env.SHOW_PIN || cfg.server?.pin || '';
// Where cue edits are saved (the launcher points practice mode at a copy in the user's folder),
// and where cue position + timers are kept so a restart mid-show resumes at the same cue.
const SAVE_PATH = process.env.SHOW_SAVE_PATH || cfgPath;
const STATE_PATH = process.env.SHOW_STATE_FILE ?? path.join(path.dirname(SAVE_PATH), `.${path.basename(SAVE_PATH, '.json')}.state.json`);
// Set by the double-click launcher: practice (simulated gear) or live (the real show file), and
// where the real show file lives. Run directly (node server/index.js show.json) it's "direct".
const MODE = process.env.SHOW_MODE || 'direct';
const LIVE_PATH = process.env.SHOW_LIVE_PATH || cfgPath;
const SUPERVISED = !!process.env.SHOW_SUPERVISED; // the launcher restarts us when we exit with RESTART
const RESTART = 75;

// Practice mode keeps a copy of the practice show in the user's folder. Equipment added to the
// practice gear in a later version (e.g. the radio mic receivers) is added to that copy here.
if (MODE === 'practice' && process.env.SHOW_SIM_CONFIG) {
  try {
    const sim = JSON.parse(fs.readFileSync(process.env.SHOW_SIM_CONFIG, 'utf8'));
    for (const d of sim.devices || []) if (!cfg.devices.some(x => x.id === d.id)) cfg.devices.push(d);
    for (const k of ['mics', 'sound']) if (!cfg[k] && sim[k]) cfg[k] = sim[k];
  } catch { /* no practice show to merge */ }
}

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
  // ready-made commands of the brand picked on the Setup screen, plus any written into show.json
  const templates = { ...(catalog.templatesFor(dc.profile) || {}), ...(dc.templates || {}) };
  const d = new D(Object.keys(templates).length ? { ...dc, templates } : dc);
  d.on('log', log);
  d.on('changed', () => { queueDevice(d); micPlan?.refresh(); });
  d.on('meters', onMeters);
  devices.set(d.id, d);
}
// The mic plot is a device too, so cues can switch the mics for a scene ("device": "mics").
const micPlan = new MicPlan(cfg.mics, devices);
micPlan.on('log', log);
micPlan.on('changed', () => queueDevice(micPlan));
micPlan.on('alert', raiseAlert);
devices.set(micPlan.id, micPlan);

// ---------- alerts (possible feedback, low mic batteries, equipment that stopped answering, STOP) ----------
// Shown on every iPad and phone until someone dismisses them (or, for equipment, until it answers
// again). Same key = same alert, not a new one. features/health.js raises the equipment ones and
// sends every alert to the phone.
let alerts = [];
function raiseAlert(a) {
  alerts = [{ ...a, at: Date.now() }, ...alerts.filter(x => x.key !== a.key)].slice(0, 20);
  log({ device: a.device || 'mics', level: a.level === 'error' ? 'error' : 'warn', msg: `${a.title}${a.detail ? ` (${a.detail})` : ''}`, t: Date.now() });
  broadcast({ t: 'alerts', alerts });
  events.emit('alert', alerts[0]);
}
function clearAlert(key) {
  if (!alerts.some(a => a.key === key)) return;
  alerts = alerts.filter(a => a.key !== key);
  broadcast({ t: 'alerts', alerts });
}

// Mixer input meters: sent to the iPads at most 10 times a second, and watched for feedback.
const fbCfg = cfg.sound?.feedback || {};
const feedback = fbCfg.enabled === false ? null : new FeedbackWatch(fbCfg);
const meterSent = new Map();
function onMeters(d) {
  const now = Date.now();
  if (now - (meterSent.get(d.id) || 0) >= 100) { meterSent.set(d.id, now); broadcast({ t: 'meters', device: d.id, levels: d.levels }); }
  for (const hit of feedback?.push(d.id, d.levels, now) || []) {
    const name = d.state.channels[hit.channel]?.name || `CH${hit.channel + 1}`;
    const pack = micPlan.plan.packs.find(p => p.channel === hit.channel && micPlan.mixerFor(p) === d);
    const who = pack && micPlan.wearer(pack);
    raiseAlert({ key: `fb:${d.id}:${hit.channel}`, kind: 'feedback', device: d.id, title: `Possible feedback on ${name}${who ? ` (${who})` : ''}`,
      detail: `steady tone at ${hit.db.toFixed(0)} dB on channel ${hit.channel + 1}`, action: { label: `Mute ${name}`, device: d.id, cmd: 'on', args: { strip: 'ch', index: hit.channel, on: false } } });
  }
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
    try { r = await d.command(a.cmd, a.args || {}); if (!r || typeof r !== 'object') r = { outcome: 'sent' }; }
    catch (e) { r = { outcome: 'not_sent', detail: e.message }; }
    // a projector in standby is already dark, so a refused shutter-close there is not a problem
    if (a.cmd === 'shutter' && a.args?.closed && r.outcome === 'busy' && ['standby', 'cooling'].includes(d.snapshot().state?.power)) r = { outcome: 'ok', detail: 'in standby, already dark' };
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
const showSnapshot = () => ({ name: show.name, cues: show.cues, index: show.index, lastFired: show.lastFired, timers: show.timers, now: Date.now(), emergency: show.emergency || null });

// Atomic write: a power cut mid-write never leaves a half-written file.
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
function loadState() {
  if (!STATE_PATH) return;
  try {
    const st = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    show.index = Math.max(0, Math.min(show.cues.length, st.index ?? 0));
    show.lastFired = st.lastFired ?? null;
    for (const k of ['show', 'act']) if (st.timers?.[k]) show.timers[k] = st.timers[k];
    console.log(`Resumed at cue position ${show.index + 1} (saved ${new Date(st.savedAt).toLocaleString()})`);
  } catch { /* first run */ }
}
let stateTimer = null;
function saveState() {
  if (!STATE_PATH || stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    try { writeJson(STATE_PATH, { index: show.index, lastFired: show.lastFired, timers: show.timers, savedAt: Date.now() }); }
    catch (e) { log({ device: 'core', level: 'warn', msg: `could not save show position: ${e.message}`, t: Date.now() }); }
  }, 200);
}
loadState();
const crew = createCrew({ cfg, show, savePath: SAVE_PATH, writeJson, broadcast: m => broadcast(m), log, saveCues: (c, who) => saveCues(c, who),
  statePath: STATE_PATH && path.join(path.dirname(STATE_PATH), `.${path.basename(SAVE_PATH, '.json')}.crew.json`),
  showChanged: () => broadcast({ t: 'show', show: showSnapshot() }) });

// Cue list edits from the iPad. Validated, backed up, then written to the show file.
function validateCues(cues) {
  if (!Array.isArray(cues)) throw new Error('cues must be a list');
  return cues.map((c, i) => {
    if (!c || typeof c.label !== 'string') throw new Error(`cue ${i + 1}: needs a name`);
    const actions = (c.actions || []).map((a, j) => {
      const where = `cue ${i + 1}, action ${j + 1}`;
      if (typeof a.device !== 'string' || typeof a.cmd !== 'string') throw new Error(`${where}: needs a device and a command`);
      // equipment that's in the show file but has no address yet still counts (its steps are skipped at GO)
      if (!a.device.startsWith('group:') && !devices.has(a.device) && !cfg.devices.some(d => d.id === a.device)) throw new Error(`${where}: unknown device "${a.device}"`);
      const delay = Number(a.delay || 0);
      if (!(delay >= 0 && delay <= 600)) throw new Error(`${where}: delay must be 0-600 seconds`);
      return { device: a.device, cmd: a.cmd, ...(a.args && Object.keys(a.args).length ? { args: a.args } : {}), ...(delay ? { delay } : {}) };
    });
    // crew tasks: who does what on this cue (shown on their phone's run sheet and cue light)
    const tasks = (Array.isArray(c.crew) ? c.crew : []).filter(x => x && typeof x.role === 'string' && x.role.trim())
      .map(x => ({ role: x.role.trim(), task: String(x.task || '').trim() }));
    const scene = String(c.scene ?? '').trim().slice(0, 80); // starts a new scene on the scene map
    return { number: c.number === '' || c.number == null ? i + 1 : c.number, label: c.label.trim() || `Cue ${i + 1}`, ...(scene ? { scene } : {}), ...(c.note ? { note: String(c.note) } : {}), ...(tasks.length ? { crew: tasks } : {}), actions };
  });
}
function saveCues(cues, who, note) {
  const clean = validateCues(cues);
  const before = show.cues;
  let onDisk = cfg;
  try { onDisk = JSON.parse(fs.readFileSync(SAVE_PATH, 'utf8')); } catch { /* first save of a practice copy */ }
  if (fs.existsSync(SAVE_PATH)) fs.copyFileSync(SAVE_PATH, `${SAVE_PATH}.bak`);
  writeJson(SAVE_PATH, { ...onDisk, show: { ...(onDisk.show || {}), cues: clean } });
  show.cues = clean;
  show.index = Math.min(show.index, clean.length);
  if (show.lastFired != null && show.lastFired >= clean.length) show.lastFired = null;
  log({ device: 'show', level: 'cmd', msg: `cue list saved (${clean.length} cues) by ${who}${note ? `: ${note}` : ''}`, t: Date.now() });
  saveState();
  events.emit('cues-saved', { before, cues: clean, who, note });
}

// Mic plot edits from the iPad: validated, backed up, saved to the show file, used at once.
function saveMics(m, who) {
  const clean = validateMics(m, id => devices.has(id) || cfg.devices.some(d => d.id === id));
  let onDisk = cfg;
  try { onDisk = JSON.parse(fs.readFileSync(SAVE_PATH, 'utf8')); } catch { /* first save of a practice copy */ }
  if (fs.existsSync(SAVE_PATH)) fs.copyFileSync(SAVE_PATH, `${SAVE_PATH}.bak`);
  // a practice copy also keeps the practice gear the mic plot points at
  writeJson(SAVE_PATH, { ...onDisk, ...(MODE === 'practice' ? { devices: cfg.devices } : {}), mics: clean });
  cfg.mics = clean;
  micPlan.load(clean);
  log({ device: 'mics', level: 'cmd', msg: `mic plot saved (${clean.packs.length} packs, ${clean.scenes.length} scenes) by ${who}`, t: Date.now() });
}

// Emergency stop: everything that makes noise, light or movement, all at once.
// Default: QLab panic, close every projector shutter, stop every PTZ camera. Add more in
// config "safety": { "emergency": [ { "device": "eos", "cmd": "macro", "args": { "macro": 999 } } ] }
async function emergencyStop(who) {
  const actions = [
    ...[...devices.values()].filter(d => d.type === 'qlab').map(d => ({ device: d.id, cmd: 'panic' })),
    ...(projectors().length ? [{ device: 'group:all', cmd: 'shutter', args: { closed: true } }] : []),
    ...[...devices.values()].filter(d => d.type === 'ptz' || d.type === 'panasonic-cam').flatMap(d => [{ device: d.id, cmd: 'move', args: { pan: 0, tilt: 0 } }, { device: d.id, cmd: 'zoom', args: { speed: 0 } }]),
    ...(cfg.safety?.emergency || []),
  ];
  log({ device: 'show', level: 'error', msg: `EMERGENCY STOP by ${who}`, t: Date.now() });
  const results = (await Promise.all(actions.map(a => runAction(a, `EMERGENCY ${who}`).catch(e => [{ device: a.device, name: a.device, outcome: 'not_sent', detail: e.message }])))).flat()
    .filter(r => !(['sent', 'ok'].includes(r.outcome) && ['ptz', 'panasonic-cam'].includes(devices.get(r.device)?.type)))
    // a projector in standby is already dark, so a refused shutter-close there is not a problem
    .map(r => r.outcome === 'busy' && ['standby', 'cooling'].includes(devices.get(r.device)?.snapshot().state?.power) ? { ...r, outcome: 'ok', detail: 'in standby, already dark' } : r);
  show.emergency = { at: Date.now(), by: who, results };
  broadcast({ t: 'show', show: showSnapshot() });
  events.emit('emergency', who, results);
  return results;
}
// Runs some of a cue's actions, each after its own delay. Features hear about the GO and every
// result (the show report lists them); dept is set when a second operator runs one department.
function runCueActions(i, actions, source, dept) {
  const cue = show.cues[i], at = Date.now();
  events.emit('cue-fired', { i, cue, source, at, dept, actions });
  for (const a of actions) {
    setTimeout(() => runAction(a, `cue ${cue.number ?? i + 1}`)
      .catch(e => { log({ device: a.device, level: 'error', msg: e.message, t: Date.now() }); return [{ device: a.device, name: a.device, outcome: 'not_sent', detail: e.message }]; })
      .then(results => events.emit('cue-results', { i, at, action: a, results })), (a.delay || 0) * 1000);
  }
}
function fireCue(i, source) {
  const cue = show.cues[i];
  if (!cue) return;
  show.lastFired = i;
  show.index = Math.min(i + 1, show.cues.length);
  log({ device: 'show', level: 'go', msg: `GO ${cue.number ?? i + 1} ${cue.label || ''} (${source})`, t: Date.now() });
  runCueActions(i, (cue.actions || []).filter(a => !ctx.heldBack(a)), source);
  broadcast({ t: 'show', show: showSnapshot() });
  saveState();
  crew.fired(i);
}
function timer(name, op) {
  const tm = show.timers[name]; if (!tm) return;
  if (op === 'start' && !tm.start) tm.start = Date.now();
  if (op === 'stop' && tm.start) { tm.acc += Date.now() - tm.start; tm.start = null; }
  if (op === 'reset') { tm.acc = 0; tm.start = tm.start ? Date.now() : null; }
  saveState();
}

// ---------- Setup screen: real equipment, practice/live ----------
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
function setupInfo() {
  const live = readJson(LIVE_PATH, null);
  // In practice the form starts from the real show file if there is one, else from the practice gear with blank addresses.
  const list = MODE === 'practice' ? (live?.devices || setup.realTemplate(cfg.devices)) : (readJson(SAVE_PATH, cfg).devices || cfg.devices);
  let autostart = null;
  if (SUPERVISED) try { autostart = require('../launcher/autostart').status(); } catch { /* not available on this system */ }
  const pin = (MODE === 'practice' ? live?.server?.pin : readJson(SAVE_PATH, cfg).server?.pin) || '';
  return { mode: MODE, name: (MODE === 'practice' ? live?.show?.name : show.name) || show.name.replace(/^Simulated /, ''), pin: String(pin), devices: list,
    networks: setup.localNetworks(), autostart, supervised: SUPERVISED, firstRun: firstRun(),
    // the "Add equipment" list, and what each kind needs to be set up
    categories: catalog.CATEGORIES, profiles: catalog.profiles(), types: catalog.typeInfo(),
    plugins: { ...drivers.plugins, folders: require('./plugins').dirs() } };
}
// Practice mode and no real show file yet: the iPad offers the guided set-up.
const firstRun = () => MODE === 'practice' && !fs.existsSync(LIVE_PATH);
// Saves the equipment list. action: "save" (stay in this mode), "go-live", or "practice".
// The cue list goes with you: practice cues are copied into the real show when going live, and back.
function saveSetup(m, who) {
  const list = setup.cleanDevices(m.devices);
  const name = String(m.name || '').trim() || show.name;
  const ids = new Set(list.filter(d => d.enabled !== false).map(d => d.id));
  let out;
  if (MODE === 'direct') {
    out = { ...readJson(SAVE_PATH, cfg), devices: list };
    out.show = { ...(out.show || {}), name };
  } else if (MODE === 'practice') {
    const live = readJson(LIVE_PATH, {}), practice = readJson(SAVE_PATH, cfg);
    out = { ...live, ...practice, server: live.server || practice.server, devices: list, live: m.action === 'go-live' };
    if (!out.mics && cfg.mics) out.mics = cfg.mics; // the mic plot comes with you, like the cue list
    out.show = { ...(practice.show || {}), name };
  } else {
    const live = readJson(LIVE_PATH, cfg);
    out = { ...live, devices: list, live: m.action !== 'practice' };
    out.show = { ...(live.show || {}), name };
    if (m.action === 'practice' && process.env.SHOW_PRACTICE_PATH) {
      const p = readJson(process.env.SHOW_PRACTICE_PATH, null) || readJson(process.env.SHOW_SIM_CONFIG, null);
      if (p) writeJson(process.env.SHOW_PRACTICE_PATH, { ...p, show: { ...live.show, name: p.show?.name || name } });
    }
  }
  const pin = String(m.pin ?? out.server?.pin ?? '').trim();
  if (!/^[A-Za-z0-9]{0,12}$/.test(pin)) throw new Error('The PIN can be up to 12 letters or numbers');
  out.server = { ...(out.server || {}), pin };
  const file = MODE === 'direct' ? SAVE_PATH : LIVE_PATH;
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  writeJson(file, out);
  // Steps in cues that point at equipment that's gone or has no address are skipped at GO; say so now.
  const missing = [...new Set((out.show?.cues || []).flatMap(c => (c.actions || []).map(a => a.device))
    .filter(id => !id.startsWith('group:') && id !== 'mics' && !ids.has(id)))];
  const restarting = SUPERVISED && (m.action !== 'save' || MODE !== 'practice');
  log({ device: 'core', level: 'cmd', msg: `equipment setup saved (${m.action}) by ${who}${restarting ? ', restarting' : ''}`, t: Date.now() });
  if (restarting) setTimeout(() => { for (const d of devices.values()) d.stop(); process.exit(RESTART); }, 500);
  return { restarting, missing };
}

// ---------- feature modules (server/features) ----------
// Each module gets this context. It can answer extra WebSocket requests (handlers[type] = async
// (msg, ws) => reply data), add to the first message a screen gets (initExtras), and add items to
// the pre-show check (checks). Server-wide settings (alerts, PINs, backups) live in the real show
// file, so practice and live share them.
const SETTINGS_PATH = MODE === 'direct' ? SAVE_PATH : LIVE_PATH;
const events = new EventEmitter();
const ctx = {
  cfg, devices, show, log, broadcast, raiseAlert, clearAlert, runAction, runCueActions, fireCue, saveCues, showSnapshot, writeJson, readJson, events, crew, groups,
  MODE, SAVE_PATH, LIVE_PATH, STATE_PATH, SUPERVISED, handlers: {}, initExtras: [], checks: [],
  DATA_DIR: process.env.SHOW_DATA_DIR || path.dirname(SETTINGS_PATH), // history and backups go here
  guards: [], // (msg, ws) => throws a plain-words reason when that screen may not do this now
  // Replaced by features/access.js (PINs per role); this is the single-PIN behaviour without it.
  access: { required: () => !!PIN, hint: () => ({}), roleFor: pin => (!PIN || String(pin) === String(PIN) ? 'admin' : null) },
  clients: () => [...wss.clients].filter(c => c.authed && c.readyState === 1 && !c.mirror),
  // Equipment connections open once the server is listening, unless a feature holds them (the
  // backup computer on standby). Each device is started at most once per run.
  holdDevices: false,
  startDevices() { if (this.devicesStarted) return; this.devicesStarted = true; for (const d of devices.values()) d.start(); },
  stopDevices() { if (this.devicesStarted) for (const d of devices.values()) d.stop(); },
  saveState: () => saveState(),
  heldBack: () => false, // (action) => true when a second operator runs that department (features/departments.js)
  routes: [],            // (app) => adds HTTP routes (features/report.js serves report files)
  settings: () => readJson(SETTINGS_PATH, null) ?? readJson(SAVE_PATH, cfg),
  saveSettings(patch) {
    const cur = readJson(SETTINGS_PATH, null) ?? (MODE === 'practice' ? { live: false } : readJson(SAVE_PATH, cfg));
    writeJson(SETTINGS_PATH, { ...cur, ...patch });
  },
};
for (const f of ['health', 'access', 'lock', 'versions', 'backups', 'failover', 'screens', 'departments', 'rehearsal', 'report']) require(`./features/${f}`)(ctx);

// ---------- HTTP + WS ----------
// IPv4 addresses an iPad on the same network can reach this computer at.
function lanAddresses() {
  return Object.entries(os.networkInterfaces()).flatMap(([name, list]) => (list || [])
    .filter(i => i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'))
    .map(i => ({ name: /^100\./.test(i.address) ? 'Tailscale (works from anywhere)' : 'this network', url: `http://${i.address}:${PORT}`, ts: /^100\./.test(i.address) })))
    .sort((a, b) => a.ts - b.ts); // local network first, Tailscale last
}
const app = express();
for (const route of ctx.routes) route(app);
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
  const who = ws.who = req.socket.remoteAddress?.replace('::ffff:', '');
  ws.authed = !ctx.access.required();
  ws.role = ws.authed ? 'admin' : null;
  const hello = () => ws.send(JSON.stringify(Object.assign({
    t: 'init', devices: [...devices.values()].map(d => d.snapshot()), show: showSnapshot(), log: logRing.slice(-100),
    ui: cfg.ui || {}, groups: groups(), mode: MODE, alerts, crew: crew.snapshot(), script: crew.script(),
    firstRun: firstRun(), cueCommands: catalog.cueCatalog(),
  }, ...ctx.initExtras.map(f => f(ws)))));
  if (ws.authed) hello(); else ws.send(JSON.stringify({ t: 'auth-required', ...ctx.access.hint() }));

  ws.on('message', async raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'auth') {
      const role = ctx.access.roleFor(m.pin);
      if (role) { ws.authed = true; ws.role = role; hello(); log({ device: 'core', msg: `client ${who} signed in${role !== 'admin' ? ` (${role})` : ''}`, t: Date.now() }); }
      else ws.send(JSON.stringify({ t: 'auth-failed' }));
      return;
    }
    if (!ws.authed) return;
    try {
      for (const guard of ctx.guards) guard(m, ws);
      if (m.t === 'cmd') {
        const results = await runAction(m, who);
        if (m.id) ws.send(JSON.stringify({ t: 'result', id: m.id, results }));
      }
      else if (m.t === 'show') {
        if (m.action === 'go') fireCue(show.index, who);
        else if (m.action === 'fire') fireCue(Number(m.index), who);
        else if (m.action === 'standby') { show.index = Math.max(0, Math.min(show.cues.length, Number(m.index))); saveState(); }
        else if (m.action === 'timer') timer(m.timer, m.op);
        else if (m.action === 'clear-emergency') { show.emergency = null; events.emit('emergency-cleared', who); }
        broadcast({ t: 'show', show: showSnapshot() });
      }
      else if (m.t === 'emergency') await emergencyStop(who);
      else if (m.t === 'alert-dismiss') clearAlert(m.key);
      else if (m.t === 'save-mics') {
        saveMics(m.mics, who);
        ws.send(JSON.stringify({ t: 'saved', id: m.id }));
      }
      else if (m.t === 'crew') ws.send(JSON.stringify({ t: 'reply', id: m.id, data: crew.handle(m, who) }));
      else if (m.t === 'setup-get') ws.send(JSON.stringify({ t: 'reply', id: m.id, data: setupInfo() }));
      else if (m.t === 'setup-test') ws.send(JSON.stringify({ t: 'reply', id: m.id, data: await setup.testDevice(m.device || {}) }));
      else if (m.t === 'setup-discover') {
        // look for equipment near the addresses already typed in, as well as on this computer's own networks
        const hosts = [...new Set([...cfg.devices, ...(m.devices || [])].map(d => d.host).filter(Boolean))];
        ws.send(JSON.stringify({ t: 'reply', id: m.id, data: await discover.discover({ hosts }) }));
      }
      else if (m.t === 'setup-save') ws.send(JSON.stringify({ t: 'reply', id: m.id, data: saveSetup(m, who) }));
      else if (m.t === 'autostart') {
        if (!SUPERVISED) throw new Error('Only available when Show Control is started by double-clicking it');
        ws.send(JSON.stringify({ t: 'reply', id: m.id, data: require('../launcher/autostart').set(!!m.on) }));
      }
      else if (m.t === 'save-cues') {
        saveCues(m.cues, who);
        ws.send(JSON.stringify({ t: 'saved', id: m.id }));
        broadcast({ t: 'show', show: showSnapshot() });
      }
      else if (ctx.handlers[m.t]) ws.send(JSON.stringify({ t: 'reply', id: m.id, data: await ctx.handlers[m.t](m, ws) }));
    } catch (e) {
      ws.send(JSON.stringify({ t: 'error', id: m.id, msg: e.message }));
      log({ device: m.device || 'core', level: 'error', msg: e.message, t: Date.now() });
    }
  });
});

server.listen(PORT, cfg.server?.host || '0.0.0.0', () => {
  const urls = lanAddresses().map(a => a.url);
  console.log(`Show Control "${show.name}" using ${cfgPath}`);
  console.log(`Open on iPad/phone: ${urls.join('  ') || `http://localhost:${PORT}`}${ctx.access.required() ? '  (PIN required)' : ''}`);
  if (!ctx.holdDevices) ctx.startDevices();
  events.emit('listening');
  server.emit('ready', { port: PORT, urls });
});

module.exports = { server, lanAddresses };

function shutdown() { ctx.stopDevices(); process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
// A bug in one driver must not take the whole show down: log it and keep running.
process.on('uncaughtException', e => log({ device: 'core', level: 'error', msg: `internal error (kept running): ${e.stack || e.message}`, t: Date.now() }));
process.on('unhandledRejection', e => log({ device: 'core', level: 'error', msg: `internal error (kept running): ${e?.stack || e}`, t: Date.now() }));
