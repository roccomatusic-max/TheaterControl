// Show Control web UI. No build step, no external assets (runs on an offline LAN).
'use strict';
const $ = (s, el = document) => el.querySelector(s);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
}
// el.replaceChildren(...) that skips false/null and flattens lists, like h() does.
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(c => c != null && c !== false));

const S = { devices: {}, show: null, log: [], ui: {}, tab: localStorage.getItem('tab') || 'show', clockSkew: 0 };
const updaters = {}; // device id → [fn(snapshot)]
// Extension points for the other files (setup.js, health.js, …): extra screens, extra cards on the
// System tab, and handlers for extra server messages.
const VIEWS = {};       // tab name → () => element
const NAV_PARENT = { edit: 'show', setup: 'sys' }; // sub-screens light up their parent tab
const SYS_CARDS = [];   // () => element, shown on the System tab
const SHOW_BUTTONS = []; // () => element, buttons next to "Edit cues" on the Show tab
const STANDBY_EXTRAS = []; // (show) => element or null, extra lines in the standby box
const LX_CARDS = [];     // (eos device or undefined) => element or null, cards on the Lighting tab
const msgHandlers = {}; // message type → [fn(msg)], called before the built-in handling
const onMsg = (t, fn) => (msgHandlers[t] ||= []).push(fn);
const onDevice = (id, fn) => { (updaters[id] ||= []).push(fn); if (S.devices[id]) fn(S.devices[id]); };
const byType = t => Object.values(S.devices).filter(d => d.type === t);

// ---------- connection ----------
let ws, wsTimer;
let wsHost = () => location.host; // failover.js moves to the backup computer when this one stops
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${wsHost()}/ws`);
  ws.onopen = () => setConn(true);
  ws.onclose = () => { setConn(false); clearTimeout(wsTimer); wsTimer = setTimeout(connect, 1500); };
  ws.onmessage = e => handle(JSON.parse(e.data));
}
const send = m => ws?.readyState === 1 ? ws.send(JSON.stringify(m)) : toast('Not connected');
// Every command gets a per-device result back; anything that didn't work is shown, never swallowed.
let cmdSeq = 0; const pending = {};
const GOOD = ['ok', 'accepted', 'sent'];
const OUTCOME_WORDS = { busy: 'warming up, try again', offline: 'not connected', timeout: 'no answer', not_sent: 'not sent', rejected: 'refused', auth_failed: 'wrong password', fault: 'fault' };
function cmd(device, c, args) {
  const id = ++cmdSeq;
  send({ t: 'cmd', id, device, cmd: c, args });
  return new Promise(res => { pending[id] = res; setTimeout(() => { if (pending[id]) { delete pending[id]; res([]); } }, 15000); });
}
let offlineTimer;
function setConn(ok) {
  // practice = pretend equipment (tap to set up the real gear), live = real equipment
  const c = $('#conn'); c.textContent = ok ? (S.mode === 'practice' ? 'practice' : 'live') : 'offline';
  c.className = 'pill ' + (ok ? (S.mode === 'practice' ? 'warn' : 'ok') : 'off');
  clearTimeout(offlineTimer);
  if (ok) $('#offline').hidden = true;
  else offlineTimer = setTimeout(() => ($('#offline').hidden = false), 1200); // brief blips don't flash the warning
}

function handle(m) {
  (msgHandlers[m.t] || []).forEach(fn => fn(m)); // first, so other files' state is ready when the screen is drawn
  if (m.t === 'auth-required') { $('#pin').hidden = false; $('#pinInput').focus(); const saved = localStorage.getItem('pin'); if (saved) send({ t: 'auth', pin: saved }); }
  else if (m.t === 'auth-failed') { $('#pinErr').textContent = 'Wrong PIN'; localStorage.removeItem('pin'); $('#pin').hidden = false; }
  else if (m.t === 'init') {
    $('#pin').hidden = true;
    S.devices = Object.fromEntries(m.devices.map(d => [d.id, d])); S.show = m.show; S.log = m.log; S.ui = m.ui; S.groups = m.groups || []; S.crew = m.crew;
    S.mode = m.mode; setConn(true);
    if (S.setup?.restarting) S.setup = null; // back after a practice/live switch: reload the equipment list
    S.clockSkew = m.show.now - Date.now();
    $('#showName').textContent = m.show.name;
    renderEmergency();
    render();
  } else if (m.t === 'device') {
    S.devices[m.device.id] = m.device;
    (updaters[m.device.id] || []).forEach(fn => fn(m.device));
    (updaters.__anyDevice || []).forEach(fn => fn());
    renderDots();
  } else if (m.t === 'show') { S.show = m.show; S.clockSkew = m.show.now - Date.now(); renderEmergency(); (updaters.__show || []).forEach(fn => fn(S.show)); }
  else if (m.t === 'crew') S.crew = m.crew;
  else if (m.t === 'saved') { pending[m.id]?.(true); delete pending[m.id]; }
  else if (m.t === 'reply') { pending[m.id]?.(m.data); delete pending[m.id]; }
  else if (m.t === 'log') { S.log.push(m.entry); if (S.log.length > 300) S.log.shift(); (updaters.__log || []).forEach(fn => fn(m.entry)); }
  else if (m.t === 'error') { if (m.id && pending[m.id]) { pending[m.id](m.msg); delete pending[m.id]; } else toast(m.msg); }
  else if (m.t === 'result') {
    pending[m.id]?.(m.results); delete pending[m.id];
    const bad = m.results.filter(r => !GOOD.includes(r.outcome));
    if (bad.length) toast(bad.map(r => `${r.name.split(' · ')[0]}: ${r.outcome.replace('_', ' ')}${r.detail ? ` (${r.detail})` : ''}`).join('\n'), 6000);
  }
}
// Request/reply to the server: resolves with the reply data, or { error } in plain words.
function ask(t, payload = {}, ms = 20000) {
  const id = ++cmdSeq;
  send({ t, id, ...payload });
  return new Promise(res => {
    pending[id] = r => res(typeof r === 'string' ? { error: r } : r === true ? {} : r);
    setTimeout(() => { if (pending[id]) { delete pending[id]; res({ error: 'No answer from Show Control' }); } }, ms);
  });
}
$('#pin form').addEventListener('submit', e => { e.preventDefault(); const pin = $('#pinInput').value; localStorage.setItem('pin', pin); send({ t: 'auth', pin }); });

function toast(msg, ms = 2500) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), ms); }

// ---------- chrome ----------
function renderDots() {
  $('#statusDots').replaceChildren(...Object.values(S.devices).map(d => h('div', { class: `dot ${d.status}`, title: `${d.name}: ${d.status}` }, h('i'), h('span', {}, d.name.split(' · ')[0]))));
}
document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => { S.tab = b.dataset.tab; localStorage.setItem('tab', S.tab); render(); }));
const lockBtn = $('#lockBtn');
function setLock(on) { document.body.classList.toggle('locked', on); lockBtn.textContent = on ? '🔒' : '🔓'; localStorage.setItem('locked', on ? '1' : ''); }
setLock(!!localStorage.getItem('locked'));
// Night mode: dim red screen for backstage (same switch as the crew screens, kept per device).
function setNight(on) { document.documentElement.classList.toggle('night', on); localStorage.setItem('night', on ? '1' : ''); }
$('#nightBtn').addEventListener('click', () => setNight(!document.documentElement.classList.contains('night')));
setNight(!!localStorage.getItem('night'));

// Emergency stop: hold 1.5 s. Works even when the screen is locked.
(() => {
  const b = $('#estop'); let t;
  const cancel = () => { clearTimeout(t); b.classList.remove('holding'); };
  b.addEventListener('pointerdown', e => {
    b.setPointerCapture(e.pointerId); b.classList.add('holding');
    t = setTimeout(() => { b.classList.remove('holding'); navigator.vibrate?.(200); send({ t: 'emergency' }); }, 1500);
  });
  b.addEventListener('pointerup', cancel); b.addEventListener('pointercancel', cancel);
  b.addEventListener('click', e => e.preventDefault());
})();
function renderEmergency() {
  const bar = $('#emergencyBar'), em = S.show?.emergency;
  bar.hidden = !em;
  if (!em) return;
  const bad = em.results.filter(r => !GOOD.includes(r.outcome));
  bar.replaceChildren(h('b', {}, `EMERGENCY STOP at ${new Date(em.at).toLocaleTimeString([], { hour12: false })}`),
    h('span', { class: 'r' }, bad.length ? `Not confirmed: ${bad.map(r => `${r.name.split(' · ')[0]} (${OUTCOME_WORDS[r.outcome] || r.outcome.replace('_', ' ')})`).join(', ')}` : `QLab stopped, shutters closed, cameras stopped (from ${em.by})`),
    h('button', { class: 'always', onclick: () => send({ t: 'show', action: 'clear-emergency' }) }, 'Clear'));
}

// Keep the iPad screen awake while the app is open (re-requested when the page comes back).
let wakeLock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => (wakeLock = null)); } } catch { /* not allowed yet */ }
}
document.addEventListener('visibilitychange', keepAwake);
document.addEventListener('pointerdown', keepAwake, { once: true });
keepAwake();
setInterval(() => { $('#clock').textContent = new Date(Date.now() + S.clockSkew).toLocaleTimeString([], { hour12: false }); (updaters.__tick || []).forEach(f => f()); }, 250);

function render() {
  for (const k of Object.keys(updaters)) delete updaters[k];
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === (NAV_PARENT[S.tab] || S.tab)));
  renderDots();
  const main = $('#main');
  const view = VIEWS[S.tab] || ({ show: showTab, edit: editTab, lx: lxTab, snd: sndTab, proj: projTab, cam: camTab, sys: sysTab, setup: setupTab })[S.tab] || showTab;
  main.replaceChildren(view());
}

// ---------- Show tab ----------
const fmtDur = ms => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
function actionText(a) {
  const grp = String(a.device).startsWith('group:') && S.groups.find(g => g.id === a.device.slice(6));
  const d = grp ? grp.name : S.devices[a.device]?.name?.split(' · ')[0] || a.device, x = a.args || {};
  const s = { cue: `Q${x.cue}`, start: `Q${x.cue}`, scene: `scene ${String(x.bank || 'a').toUpperCase()}${x.scene}`, preset: `preset ${x.preset}`, macro: `macro ${x.macro}`,
    shutter: x.closed ? 'shutter close' : 'shutter open', power: x.on ? 'power on' : 'power off', input: `input ${x.input}` }[a.cmd] || a.cmd;
  return `${d} ${s}${a.delay ? ` +${a.delay}s` : ''}`;
}
// Devices the standby cue needs that aren't online, so the operator knows before pressing GO.
function cueDevices(cue) {
  return [...new Set((cue?.actions || []).flatMap(a => String(a.device).startsWith('group:')
    ? (S.groups.find(g => g.id === a.device.slice(6))?.members || []) : [a.device]))];
}
function warnLine(cue) {
  if (S.failover && !S.failover.active) return ''; // a standby computer never connects to the equipment
  const off = cueDevices(cue).map(id => S.devices[id]).filter(d => d && d.status !== 'online');
  return off.length ? h('div', { class: 'warnline' }, `⚠ Not connected: ${off.map(d => d.name.split(' · ')[0]).join(', ')}`) : '';
}
// Ready dot: green when every piece of equipment the cue uses is answering, red when one isn't.
function setReadyDot(el, cue) {
  const ids = cueDevices(cue), off = ids.filter(id => S.devices[id]?.status !== 'online');
  el.className = `rdot ${!ids.length ? 'none' : off.length ? 'bad' : 'good'}`;
  el.title = !ids.length ? 'This cue does not control any equipment'
    : off.length ? `Not ready: ${off.map(id => S.devices[id]?.name.split(' · ')[0] || `${id} (no address)`).join(', ')}` : 'Everything this cue uses is answering';
  return el;
}

function showTab() {
  let lastGo = 0;
  const go = h('button', { id: 'goBtn', onclick: () => { if (Date.now() - lastGo < 600) return; lastGo = Date.now(); send({ t: 'show', action: 'go' }); } }, 'GO');
  const stby = h('div', { class: 'standby' });
  const warn = h('div');
  const list = h('div', { class: 'cuelist' });
  const tmr = (key, label) => {
    const t = h('div', { class: 't' }, '0:00:00');
    const el = h('div', { class: 'card timer' }, h('h3', {}, label), t,
      h('div', { class: 'row' }, h('button', { onclick: () => send({ t: 'show', action: 'timer', timer: key, op: 'start' }) }, 'Start'),
        h('button', { onclick: () => send({ t: 'show', action: 'timer', timer: key, op: 'stop' }) }, 'Stop'),
        h('button', { onclick: () => confirm(`Reset ${label} timer?`) && send({ t: 'show', action: 'timer', timer: key, op: 'reset' }) }, 'Reset')));
    (updaters.__tick ||= []).push(() => { const tm = S.show.timers[key]; t.textContent = fmtDur(tm.acc + (tm.start ? Date.now() + S.clockSkew - tm.start : 0)); });
    return el;
  };
  const update = sh => {
    const next = sh.cues[sh.index];
    go.disabled = !next;
    fill(stby, h('small', {}, 'STANDBY'), h('div', { class: 'lbl' }, next ? `${next.number ?? sh.index + 1}  ${next.label}` : 'End of show'),
      next?.note && h('div', { class: 'cue-note' }, next.note),
      h('div', { class: 'acts' }, next ? (next.actions || []).map(actionText).join(' · ') : ''),
      STANDBY_EXTRAS.map(f => f(sh)), warn);
    warn.replaceChildren(warnLine(next));
    list.replaceChildren(...sh.cues.map((c, i) => h('div', { class: `cue ${i < sh.index ? 'done' : ''} ${i === sh.index ? 'next' : ''} ${i === sh.lastFired ? 'last' : ''}` },
      h('div', { class: 'n' }, c.number ?? i + 1, setReadyDot(h('i'), c)),
      h('div', {}, h('div', {}, c.label), h('div', { class: 'tags' }, (c.actions || []).map(actionText).join(' · '))),
      h('div', { class: 'row' }, h('button', { onclick: () => send({ t: 'show', action: 'standby', index: i }) }, 'Stby'),
        h('button', { onclick: () => confirm(`Fire ${c.label} now?`) && send({ t: 'show', action: 'fire', index: i }) }, 'Fire')))));
    // keep the standby cue in view inside the list only; never scroll the page away from GO
    const nx = list.querySelector('.next');
    if (nx) list.scrollTop = Math.max(0, nx.offsetTop - list.offsetTop - 60);
  };
  (updaters.__show ||= []).push(update);
  (updaters.__anyDevice ||= []).push(() => {
    warn.replaceChildren(warnLine(S.show.cues[S.show.index]));
    list.querySelectorAll('.rdot').forEach((el, i) => setReadyDot(el, S.show.cues[i]));
  });
  setTimeout(() => update(S.show));

  const eos = byType('eos')[0], qlab = byType('qlab')[0];
  const quick = h('div', { class: 'grid' }, projectors().length > 0 && projQuick(),
    eos && h('div', { class: 'card' }, h('h3', {}, eos.name), eosStatus(eos.id),
      h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'big', onclick: () => cmd(eos.id, 'go') }, 'LX GO'), h('button', { onclick: () => cmd(eos.id, 'back') }, 'Back'))),
    qlab && h('div', { class: 'card' }, h('h3', {}, qlab.name), qlabStatus(qlab.id),
      h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'big', onclick: () => cmd(qlab.id, 'go') }, 'SFX GO'),
        h('button', { onclick: () => cmd(qlab.id, 'stop') }, 'Stop'), h('button', { class: 'danger', onclick: () => cmd(qlab.id, 'panic') }, 'Panic'))));
  return h('div', {},
    h('div', { class: 'showtop' }, stby, go),
    h('div', { class: 'row', style: 'margin-bottom:10px;justify-content:flex-end' }, SHOW_BUTTONS.map(f => f()), h('button', { class: 'always', onclick: () => (location.href = '/sm.html') }, 'Stage manager view'),
      h('button', { onclick: () => { S.tab = 'edit'; render(); } }, '✎ Edit cues')),
    h('div', { class: 'timers', style: 'margin-bottom:10px' }, tmr('show', 'Show'), tmr('act', S.show.timers.label)),
    quick,
    h('div', { class: 'card', style: 'margin-top:10px' }, h('h3', {}, 'Show cues'), list));
}

// ---------- Lighting ----------
function eosStatus(id) {
  const el = h('div', { class: 'kv' });
  onDevice(id, d => el.replaceChildren(h('b', {}, 'Active'), h('span', {}, d.state.activeCue || '—'), h('b', {}, 'Pending'), h('span', {}, d.state.pendingCue || '—')));
  return el;
}
function lxTab() {
  const eos = byType('eos')[0];
  if (!eos) return h('div', { class: 'grid' }, h('div', { class: 'card' }, 'No Eos console configured.'), LX_CARDS.map(f => f()));
  const cueIn = h('input', { inputmode: 'decimal', placeholder: 'Cue', style: 'width:90px' });
  const chanIn = h('input', { inputmode: 'numeric', placeholder: 'Chan', style: 'width:80px' });
  const lvlIn = h('input', { inputmode: 'numeric', placeholder: '@ %', style: 'width:70px' });
  const cmdline = h('div', { class: 'mono', style: 'margin-top:8px;color:var(--dim)' });
  onDevice(eos.id, d => (cmdline.textContent = d.state.cmdLine || ''));
  const numpad = (input, label, onGo) => h('div', { class: 'row', style: 'align-items:center' }, h('b', { style: 'width:60px' }, label), input, h('button', { onclick: onGo }, 'Go'));
  [cueIn, chanIn, lvlIn].forEach(i => (i.className = 'num'));
  return h('div', { class: 'grid' },
    h('div', { class: 'card' }, h('h3', {}, eos.name, h('span', {}, statusPill(eos.id))), eosStatus(eos.id),
      h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'big', onclick: () => cmd(eos.id, 'go') }, 'GO'), h('button', { class: 'big', onclick: () => cmd(eos.id, 'back') }, 'BACK'))),
    h('div', { class: 'card' }, h('h3', {}, 'Direct'),
      numpad(cueIn, 'Cue', () => cueIn.value && cmd(eos.id, 'cue', { list: 1, cue: cueIn.value })),
      h('div', { style: 'height:8px' }),
      h('div', { class: 'row', style: 'align-items:center' }, h('b', { style: 'width:60px' }, 'Chan'), chanIn, lvlIn,
        h('button', { onclick: () => chanIn.value && cmd(eos.id, 'chan', { chan: chanIn.value, level: lvlIn.value || 'Full' }) }, 'At'),
        h('button', { onclick: () => chanIn.value && cmd(eos.id, 'chan', { chan: chanIn.value, level: 'Out' }) }, 'Out')),
      cmdline),
    h('div', { class: 'card' }, h('h3', {}, 'Quick buttons'),
      h('div', { class: 'row' }, (S.ui.eosQuick || []).map(q => h('button', { onclick: () => cmd(eos.id, q.cmd, q.args) }, q.label)))),
    LX_CARDS.map(f => f(eos)));
}
function statusPill(id) {
  const p = h('span', { class: 'pill' });
  onDevice(id, d => { p.textContent = d.status; p.className = 'pill ' + (d.status === 'online' ? 'ok' : d.status === 'connecting' ? 'warn' : 'off'); });
  return p;
}

// ---------- Sound ----------
function qlabStatus(id) {
  const el = h('div', { class: 'kv' });
  onDevice(id, d => el.replaceChildren(h('b', {}, 'Next'), h('span', {}, d.state.playhead ? `${d.state.playhead} · ${d.state.playheadName}` : '—'),
    h('b', {}, 'Running'), h('span', {}, d.state.running?.length ? d.state.running.join(', ') : '—')));
  return el;
}
// Fader taper: position (0..1) ↔ dB, roughly like a console fader.
const TAPER = [[0, -Infinity], [0.04, -80], [0.15, -50], [0.3, -30], [0.5, -15], [0.65, -5], [0.75, 0], [1, 10]];
function posToDb(p) {
  if (p <= 0.01) return -Infinity;
  for (let i = 1; i < TAPER.length; i++) if (p <= TAPER[i][0]) { const [p0, d0] = TAPER[i - 1], [p1, d1] = TAPER[i]; return d0 === -Infinity ? d1 : d0 + (d1 - d0) * (p - p0) / (p1 - p0); }
  return 10;
}
function dbToPos(db) {
  if (db === -Infinity || db <= -80) return db <= -80 && db > -Infinity ? 0.04 : 0;
  for (let i = 2; i < TAPER.length; i++) if (db <= TAPER[i][1]) { const [p0, d0] = TAPER[i - 1], [p1, d1] = TAPER[i]; return p0 + (p1 - p0) * (db - d0) / (d1 - d0); }
  return 1;
}
const rawToDb = v => (v <= -13800 ? -Infinity : v / 100);
const fmtDb = db => (db === -Infinity ? '-∞' : (db > 0 ? '+' : '') + db.toFixed(1));

function fader(onMove) {
  const cap = h('div', { class: 'cap' });
  const el = h('div', { class: 'fader' }, h('div', { class: 'track' }), h('div', { class: 'unity', style: `top:${(1 - 0.75) * 100}%` }), cap);
  let dragging = false, startY = 0, startPos = 0, pos = 0, lastSend = 0, pending = null;
  const place = p => { pos = Math.max(0, Math.min(1, p)); cap.style.top = `${(1 - pos) * 100}%`; };
  const flush = () => { if (pending != null) { onMove(pending); pending = null; lastSend = Date.now(); } };
  el.addEventListener('pointerdown', e => { dragging = true; el.setPointerCapture(e.pointerId); startY = e.clientY; startPos = pos; });
  el.addEventListener('pointermove', e => {
    if (!dragging) return;
    place(startPos - (e.clientY - startY) / el.clientHeight); // relative drag: touching never jumps the fader
    pending = pos; if (Date.now() - lastSend > 50) flush(); else setTimeout(flush, 50);
  });
  const end = () => { if (dragging) { dragging = false; flush(); } };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  el.addEventListener('dblclick', () => { place(0.75); onMove(0.75); });
  return { el, set: p => { if (!dragging) place(p); } };
}

function strip(devId, kind, idx, getStrip) {
  const nm = h('div', { class: 'nm' }), db = h('div', { class: 'db' });
  const f = fader(p => { const d = posToDb(p); db.textContent = fmtDb(d); cmd(devId, 'level', { strip: kind, index: idx, db: d === -Infinity ? '-inf' : +d.toFixed(2) }); });
  const onBtn = h('button', { onclick: () => { const s = getStrip(S.devices[devId]); cmd(devId, 'on', { strip: kind, index: idx, on: !s.on }); } }, 'ON');
  onDevice(devId, d => {
    const s = getStrip(d); if (!s) return;
    nm.textContent = s.name; const v = rawToDb(s.level); db.textContent = fmtDb(v); f.set(dbToPos(v));
    onBtn.textContent = s.on ? 'ON' : 'OFF'; onBtn.className = s.on ? 'on' : 'muted';
  });
  return h('div', { class: 'strip' }, nm, onBtn, f.el, db);
}

function sndTab() {
  const out = h('div', { class: 'grid', style: 'grid-template-columns:1fr' });
  const qlab = byType('qlab')[0];
  if (qlab) out.append(h('div', { class: 'card' }, h('h3', {}, qlab.name, statusPill(qlab.id)), qlabStatus(qlab.id),
    h('div', { class: 'row', style: 'margin-top:10px' },
      h('button', { class: 'big', onclick: () => cmd(qlab.id, 'go') }, 'GO'),
      h('button', { onclick: () => cmd(qlab.id, 'previous') }, '◀ Prev'), h('button', { onclick: () => cmd(qlab.id, 'next') }, 'Next ▶'),
      h('button', { onclick: () => cmd(qlab.id, 'pause') }, 'Pause'), h('button', { onclick: () => cmd(qlab.id, 'resume') }, 'Resume'),
      h('button', { onclick: () => cmd(qlab.id, 'stop') }, 'Stop all'), h('button', { class: 'danger', onclick: () => cmd(qlab.id, 'panic') }, 'PANIC'))));
  for (const tf of byType('yamaha-tf')) {
    const sel = S.ui.faders || {};
    const chans = sel.channels || tf.state.channels.map((_, i) => i), dcas = sel.dcas || tf.state.dcas.map((_, i) => i);
    const sceneIn = h('input', { inputmode: 'numeric', placeholder: 'Scene #', style: 'width:100px' });
    const last = h('span', { class: 'pill' }); onDevice(tf.id, d => (last.textContent = d.state.lastScene ? `last ${d.state.lastScene}` : 'no recall yet'));
    out.append(
      h('div', { class: 'card' }, h('h3', {}, `${tf.name} · DCAs`, statusPill(tf.id)),
        h('div', { class: 'strips' }, dcas.map(i => strip(tf.id, 'dca', i, d => d.state.dcas[i])), strip(tf.id, 'master', 0, d => ({ ...d.state.master, name: 'ST' })))),
      h('div', { class: 'card' }, h('h3', {}, `${tf.name} · Inputs`), h('div', { class: 'strips' }, chans.map(i => strip(tf.id, 'ch', i, d => d.state.channels[i])))),
      h('div', { class: 'card' }, h('h3', {}, 'Scene recall', last),
        h('div', { class: 'row', style: 'align-items:center' }, sceneIn,
          h('button', { onclick: () => sceneIn.value && confirm(`Recall scene A${sceneIn.value} on ${tf.name}?`) && cmd(tf.id, 'scene', { bank: 'a', scene: Number(sceneIn.value) }) }, 'Recall A'),
          h('button', { onclick: () => sceneIn.value && confirm(`Recall scene B${sceneIn.value} on ${tf.name}?`) && cmd(tf.id, 'scene', { bank: 'b', scene: Number(sceneIn.value) }) }, 'Recall B'))));
  }
  return out;
}

// ---------- Projection ----------
const PROJ_TYPES = ['panasonic', 'pjlink'];
const projectors = () => Object.values(S.devices).filter(d => PROJ_TYPES.includes(d.type));
const POWER_TXT = { on: 'On', standby: 'Standby', warming: 'Warming up', cooling: 'Cooling down' };
// Never show a value the projector didn't give: unknown is "—", not a guess.
const powerText = s => s.power == null ? '—' : s.transition === 'cooling' && s.power !== 'on' ? 'Cooling down' : s.transition === 'warming' ? 'Warming up' : POWER_TXT[s.power] || s.power;
const inputText = s => s.input == null ? '—' : (s.inputs.find(i => i.code === s.input)?.label || s.input);
function confirmPower(names, on) {
  return confirm(on ? `Power ON ${names}?` : `Power OFF ${names}?\n\nA projector that is turned off has to cool down for 1-2 minutes before it will turn on again.`);
}

function projQuick() {
  const sum = h('div', { class: 'kv' });
  const upd = () => {
    const ps = projectors(); const st = k => ps.filter(p => p.state.shutter === k).length;
    sum.replaceChildren(h('b', {}, 'Shutters'), h('span', {}, `${st('open')} open · ${st('closed')} closed${ps.length - st('open') - st('closed') ? ` · ${ps.length - st('open') - st('closed')} unknown` : ''}`),
      h('b', {}, 'Power'), h('span', {}, ps.map(p => `${p.name.split(' · ')[0]} ${powerText(p.state)}`).join(' · ')));
  };
  projectors().forEach(p => onDevice(p.id, upd));
  return h('div', { class: 'card' }, h('h3', {}, 'Projection'), sum,
    h('div', { class: 'row', style: 'margin-top:8px' },
      h('button', { class: 'big', onclick: () => cmd('group:all', 'shutter', { closed: true }) }, 'Close all shutters'),
      h('button', { onclick: () => cmd('group:all', 'shutter', { closed: false }) }, 'Open all')));
}

function healthView(s) {
  if (!s.health) return h('span', { class: 'dim', title: s.healthSource || '' }, s.healthSource && s.healthSource.startsWith('PJLink:') ? `— (${s.healthSource})` : '—');
  return h('span', { class: 'health' }, Object.entries(s.health).map(([k, v]) => h('span', { class: `hb ${v}`, title: `${k}: ${v} (from ${s.healthSource})` }, k)));
}

function projCard(p) {
  const kv = h('div', { class: 'kv' });
  const shut = h('div', { class: 'row' }), pow = h('div', { class: 'row' }), ins = h('div', { class: 'inputs' }), last = h('div', { class: 'last' });
  const badge = h('div', { class: 'shutterbadge' });
  onDevice(p.id, d => {
    const s = d.state;
    badge.textContent = s.shutter == null ? 'SHUTTER —' : s.shutter === 'closed' ? 'SHUTTER CLOSED' : 'SHUTTER OPEN';
    badge.className = `shutterbadge ${s.shutter || ''}`;
    kv.replaceChildren(
      h('b', {}, 'Power'), h('span', {}, powerText(s)),
      h('b', {}, 'Input'), h('span', {}, inputText(s)),
      h('b', {}, 'Lamps'), h('span', {}, s.lamps ? s.lamps.map((l, i) => h('span', { class: 'lamp', title: l.why || '' }, `L${i + 1} ${l.hours == null ? '—' : `${l.hours} h`}`)) : '—'),
      h('b', {}, 'Health'), healthView(s),
      h('b', {}, 'Temps'), h('span', { class: 'dim' }, typeof s.temperatures === 'string' ? s.temperatures : '—'),
      h('b', {}, 'Model'), h('span', { class: 'dim' }, `${s.model} · ${s.protocol}`));
    ins.replaceChildren(...s.inputs.map(i => {
      const why = s.unavailableInputs?.[i.code];
      return h('button', { class: `${s.input === i.code ? 'cur' : ''} ${why ? 'na' : ''}`, title: why || '', disabled: !!why, onclick: () => cmd(p.id, 'input', { input: i.code }) }, i.label);
    }));
    const r = s.lastResult;
    last.textContent = r ? `Last: ${r.cmd} → ${r.outcome.replace('_', ' ')}${r.detail ? ` (${r.detail})` : ''}` : '';
    last.className = `last ${r && !GOOD.includes(r.outcome) ? 'bad' : ''}`;
  });
  shut.append(h('button', { class: 'big', onclick: () => cmd(p.id, 'shutter', { closed: true }) }, 'Close'), h('button', { class: 'big', onclick: () => cmd(p.id, 'shutter', { closed: false }) }, 'Open'));
  pow.append(h('button', { onclick: () => confirmPower(p.name, true) && cmd(p.id, 'power', { on: true }) }, 'Power on'),
    h('button', { class: 'danger', onclick: () => confirmPower(p.name, false) && cmd(p.id, 'power', { on: false }) }, 'Power off'));
  if (p.type === 'panasonic') pow.append(h('button', { onclick: () => confirm(`Move ${p.name}'s lens to its home position?`) && cmd(p.id, 'lensHome') }, 'Lens home'));
  if (p.state.allowUnverified) pow.append(h('button', { title: 'Unverified for this model', onclick: () => cmd(p.id, 'freeze', { on: true }) }, 'Freeze ⚠'), h('button', { onclick: () => cmd(p.id, 'freeze', { on: false }) }, 'Unfreeze'));
  return h('div', { class: 'card' }, h('h3', {}, p.name, statusPill(p.id)), badge, shut, kv, h('div', { class: 'sub' }, 'Input'), ins, h('div', { class: 'sub' }, 'Power'), pow, last);
}

function projTab() {
  const ps = projectors();
  if (!ps.length) return h('div', { class: 'card' }, 'No projectors configured.');
  S.projGroup ||= 'all';
  const g = S.groups.find(x => x.id === S.projGroup) || S.groups[0];
  const members = ps.filter(p => g.members.includes(p.id));
  const names = members.map(p => p.name.split(' · ')[0]).join(', ');
  const target = `group:${g.id}`;
  const report = h('div', { class: 'results' });
  const run = async (c, args) => {
    report.textContent = 'Sending…';
    const res = await cmd(target, c, args);
    report.replaceChildren(...res.map(r => h('div', { class: GOOD.includes(r.outcome) ? 'good' : 'bad' }, `${r.name.split(' · ')[0]}: ${r.outcome.replace('_', ' ')}${r.detail ? ` (${r.detail})` : ''}`)));
  };
  // inputs every member shares (same codes), so a group input change means the same thing on each
  const common = members.length && members.every(p => p.type === members[0].type)
    ? members[0].state.inputs.filter(i => members.every(p => p.state.inputs.some(j => j.code === i.code))) : [];
  return h('div', {},
    h('div', { class: 'row', style: 'margin-bottom:10px' }, S.groups.map(x => h('button', { class: x.id === g.id ? 'on always' : 'always', onclick: () => { S.projGroup = x.id; render(); } }, x.name))),
    h('div', { class: 'card', style: 'margin-bottom:10px' }, h('h3', {}, `${g.name} · ${members.length} projector${members.length === 1 ? '' : 's'}`),
      h('div', { class: 'row' },
        h('button', { class: 'big', onclick: () => run('shutter', { closed: true }) }, 'Close shutters'),
        h('button', { class: 'big', onclick: () => run('shutter', { closed: false }) }, 'Open shutters'),
        h('button', { onclick: () => confirmPower(names, true) && run('power', { on: true }) }, 'Power on'),
        h('button', { class: 'danger', onclick: () => confirmPower(names, false) && run('power', { on: false }) }, 'Power off')),
      common.length > 0 && h('div', { class: 'inputs', style: 'margin-top:8px' }, common.map(i => h('button', { onclick: () => run('input', { input: i.code }) }, i.label))),
      h('div', { class: 'note' }, 'Group commands go to each projector at the same time; they are not frame-synchronised. Each projector reports its own result.'),
      report),
    h('div', { class: 'grid' }, members.map(projCard)));
}

// ---------- Cue editor ----------
// What each kind of device can do in a show cue, and the fields each command needs.
// Field: [arg, type, default, label]; types: number, text, bool:<yes>/<no>, select:a|b, n1 (shown 1-based, stored 0-based)
const CATALOG = {
  eos: { cue: [['list', 'number', 1, 'Cue list'], ['cue', 'text', '', 'Cue']], go: [], back: [], macro: [['macro', 'number', 1, 'Macro']],
    sub: [['sub', 'number', 1, 'Sub'], ['level', 'number', 1, 'Level (0-1)']], chan: [['chan', 'text', '', 'Channel(s)'], ['level', 'text', 'Full', 'Level']], cmdline: [['text', 'text', '', 'Command line']] },
  qlab: { start: [['cue', 'text', '', 'Cue number']], go: [], stop: [], panic: [], pause: [], resume: [], playhead: [['cue', 'text', '', 'Cue number']] },
  'yamaha-tf': { scene: [['bank', 'select:a|b', 'a', 'Bank'], ['scene', 'number', 1, 'Scene']],
    level: [['strip', 'select:dca|ch|master', 'dca', 'Fader'], ['index', 'n1', 0, 'Number'], ['db', 'number', 0, 'Level dB']],
    on: [['strip', 'select:ch|dca|master', 'ch', 'Fader'], ['index', 'n1', 0, 'Number'], ['on', 'bool:On|Off', true, 'Set to']] },
  ptz: { preset: [['preset', 'number', 1, 'Preset']], home: [], tally: [['on', 'bool:On|Off', true, 'Tally']] },
  projector: { shutter: [['closed', 'bool:Close|Open', true, 'Shutter']], power: [['on', 'bool:On|Off', true, 'Power']], input: [['input', 'input', '', 'Input']] },
  osc: { send: [['address', 'text', '/', 'OSC address']] },
};
const CMD_LABEL = { cue: 'Fire cue', go: 'GO', back: 'Back', macro: 'Fire macro', sub: 'Sub level', chan: 'Channel level', cmdline: 'Command line',
  start: 'Start cue', stop: 'Stop all', panic: 'Panic (fade out all)', pause: 'Pause all', resume: 'Resume all', playhead: 'Move playhead to',
  scene: 'Recall scene', level: 'Set fader', on: 'Fader on/off', preset: 'Go to preset', home: 'Home', tally: 'Tally light',
  shutter: 'Shutter', power: 'Power', input: 'Input', send: 'Send OSC' };
const kindOf = id => String(id).startsWith('group:') ? 'projector' : PROJ_TYPES.includes(S.devices[id]?.type) ? 'projector' : S.devices[id]?.type;
const targets = () => [
  ...Object.values(S.devices).map(d => ({ id: d.id, label: d.name })),
  ...S.groups.map(g => ({ id: `group:${g.id}`, label: `Projectors: ${g.name}` })),
].filter(t => CATALOG[kindOf(t.id)]);

function defaultsFor(device, c) {
  return Object.fromEntries((CATALOG[kindOf(device)]?.[c] || []).map(([k, , d]) => [k, d]));
}
function newAction() {
  const t = targets()[0]; if (!t) return null;
  const c = Object.keys(CATALOG[kindOf(t.id)])[0];
  return { device: t.id, cmd: c, args: defaultsFor(t.id, c) };
}
function field(a, [key, type, def, label], onChange) {
  const val = a.args?.[key] ?? def;
  const set = v => { a.args = { ...(a.args || {}), [key]: v }; onChange(); };
  let input;
  if (type.startsWith('select:')) input = h('select', { onchange: e => set(e.target.value) }, type.slice(7).split('|').map(o => h('option', { value: o, selected: o === val }, o.toUpperCase())));
  else if (type.startsWith('bool:')) { const [yes, no] = type.slice(5).split('|'); input = h('select', { onchange: e => set(e.target.value === '1') }, h('option', { value: '1', selected: !!val }, yes), h('option', { value: '0', selected: !val }, no)); }
  else if (type === 'n1') input = h('input', { inputmode: 'numeric', value: Number(val) + 1, onchange: e => set(Math.max(0, Number(e.target.value) - 1)) });
  else if (type === 'input') {
    const d = S.devices[a.device], opts = d?.state?.inputs || [];
    input = opts.length ? h('select', { onchange: e => set(e.target.value) }, h('option', { value: '' }, 'Choose…'), opts.map(i => h('option', { value: i.code, selected: i.code === val }, i.label)))
      : h('input', { value: val, placeholder: 'e.g. HD1 or 31', onchange: e => set(e.target.value.trim()) });
  }
  else input = h('input', { inputmode: type === 'number' ? 'decimal' : 'text', value: val, onchange: e => set(type === 'number' ? Number(e.target.value) : e.target.value) });
  return h('label', {}, label, input);
}
function actionEditor(a, list, i, redraw) {
  const kind = kindOf(a.device), cmds = CATALOG[kind] || {};
  return h('div', { class: 'act' },
    h('label', {}, 'Device', h('select', { onchange: e => { a.device = e.target.value; const c = Object.keys(CATALOG[kindOf(a.device)])[0]; a.cmd = c; a.args = defaultsFor(a.device, c); redraw(); } },
      targets().map(t => h('option', { value: t.id, selected: t.id === a.device }, t.label)))),
    h('label', {}, 'Do', h('select', { onchange: e => { a.cmd = e.target.value; a.args = defaultsFor(a.device, a.cmd); redraw(); } },
      Object.keys(cmds).map(c => h('option', { value: c, selected: c === a.cmd }, CMD_LABEL[c] || c)))),
    h('div', { class: 'args' }, (cmds[a.cmd] || []).map(f => field(a, f, () => {})),
      h('label', {}, 'Delay (s)', h('input', { inputmode: 'decimal', value: a.delay || 0, onchange: e => (a.delay = Math.max(0, Number(e.target.value) || 0)) }))),
    h('div', { class: 'tools' },
      h('button', { onclick: () => cmd(a.device, a.cmd, a.args || {}) }, '▶ Try it now'),
      i > 0 && h('button', { onclick: () => { [list[i - 1], list[i]] = [list[i], list[i - 1]]; redraw(); } }, '↑'),
      h('button', { class: 'danger', onclick: () => { list.splice(i, 1); redraw(); } }, 'Remove')));
}

function crewTaskEditor(x, list, i, redraw) {
  const roles = [...new Set([...(S.crew?.roles || []), x.role].filter(Boolean))];
  return h('div', { class: 'act' },
    h('label', {}, 'Who', h('select', { onchange: e => { x.role = e.target.value; redraw(); } }, roles.map(r => h('option', { value: r, selected: r === x.role }, r)))),
    h('label', {}, 'Task', h('input', { value: x.task || '', placeholder: 'e.g. Fly in the moon', onchange: e => { x.task = e.target.value; redraw(); } })),
    h('div', { class: 'tools' }, h('button', { class: 'danger', onclick: () => { list.splice(i, 1); redraw(); } }, 'Remove')));
}

function editTab() {
  const ed = S.editor ||= { draft: JSON.parse(JSON.stringify(S.show.cues)), open: null, dirty: false };
  const wrap = h('div', {});
  const redraw = () => { ed.dirty = true; draw(); };
  const leave = () => { S.editor = null; S.tab = 'show'; render(); };
  const save = async () => {
    const r = await new Promise(res => { const id = ++cmdSeq; pending[id] = res; send({ t: 'save-cues', id, cues: ed.draft }); });
    if (r === true) { toast('Cue list saved'); leave(); } else toast(`Not saved: ${r || 'no answer from Show Control'}`, 6000);
  };
  const saveBar = () => h('div', { class: 'sticky-save' },
    h('button', { onclick: () => (!ed.dirty || confirm('Discard your changes to the cue list?')) && leave() }, 'Cancel'),
    h('button', { class: 'primary', onclick: save }, 'Save cue list'));
  function draw() {
    if (ed.open != null) {
      const c = ed.draft[ed.open];
      c.actions ||= [];
      wrap.replaceChildren(h('div', { class: 'card form' },
        h('h3', {}, `Cue ${c.number ?? ed.open + 1}`, h('button', { onclick: () => { ed.open = null; draw(); } }, '← All cues')),
        h('div', { class: 'row' },
          h('label', { style: 'flex:0 0 110px' }, 'Number', h('input', { inputmode: 'decimal', value: c.number ?? '', onchange: e => { c.number = e.target.value === '' ? '' : isNaN(e.target.value) ? e.target.value : Number(e.target.value); ed.dirty = true; } })),
          h('label', { style: 'flex:1' }, 'Name', h('input', { value: c.label, onchange: e => { c.label = e.target.value; ed.dirty = true; } }))),
        h('label', {}, 'Note for the operator (optional)', h('input', { value: c.note || '', placeholder: 'e.g. On SM call', onchange: e => { c.note = e.target.value; ed.dirty = true; } })),
        h('label', {}, 'Fires by itself at timecode (optional, hours:minutes:seconds:frames)', h('input', { value: c.tc || '', placeholder: 'e.g. 00:03:12:05', inputmode: 'numeric', onchange: e => { c.tc = e.target.value.trim(); ed.dirty = true; } })),
        h('label', {}, 'Starts a new scene (optional, for the scene map)', h('input', { value: c.scene || '', placeholder: 'e.g. Act 1 · Scene 2: The ball', onchange: e => { c.scene = e.target.value; ed.dirty = true; } })),
        h('div', { class: 'sub' }, 'What this cue does'),
        c.actions.map((a, i) => actionEditor(a, c.actions, i, redraw)),
        h('button', { onclick: () => { const a = newAction(); if (a) { c.actions.push(a); redraw(); } } }, '+ Add an action'),
        h('div', { class: 'sub' }, 'Crew tasks (shown on that person\'s phone, which lights up at standby and GO)'),
        (c.crew ||= []).map((x, i) => crewTaskEditor(x, c.crew, i, redraw)),
        h('button', { onclick: () => { c.crew.push({ role: S.crew?.roles?.[0] || '', task: '' }); redraw(); } }, '+ Add a crew task')), saveBar());
      return;
    }
    const sh = S.show;
    wrap.replaceChildren(h('div', { class: 'card' },
      h('h3', {}, 'Edit cues', h('span', { class: 'row' }, h('button', { onclick: () => { if (!ed.dirty || confirm('Leave without saving your changes?')) { S.editor = null; S.tab = 'history'; render(); } } }, '↶ Undo / history'),
        h('button', { onclick: () => { ed.draft.push({ number: ed.draft.length + 1, label: 'New cue', actions: [] }); ed.open = ed.draft.length - 1; redraw(); } }, '+ New cue'))),
      ed.draft.length ? ed.draft.map((c, i) => h('div', { class: 'ed-cue' },
        h('div', { class: 'n' }, c.number ?? i + 1),
        h('div', {}, h('div', {}, c.label), h('div', { class: 'acts' }, (c.actions || []).map(actionText).join(' · ') || 'No actions yet')),
        h('div', { class: 'row' },
          h('button', { onclick: () => { ed.open = i; draw(); } }, 'Edit'),
          i > 0 && h('button', { onclick: () => { [ed.draft[i - 1], ed.draft[i]] = [ed.draft[i], ed.draft[i - 1]]; redraw(); } }, '↑'),
          i < ed.draft.length - 1 && h('button', { onclick: () => { [ed.draft[i + 1], ed.draft[i]] = [ed.draft[i], ed.draft[i + 1]]; redraw(); } }, '↓'),
          h('button', { onclick: () => { ed.draft.splice(i + 1, 0, { ...JSON.parse(JSON.stringify(c)), number: '', label: `${c.label} (copy)` }); redraw(); } }, 'Copy'),
          h('button', { class: 'danger', onclick: () => confirm(`Delete cue "${c.label}"?`) && (ed.draft.splice(i, 1), redraw()) }, 'Delete'))))
        : h('p', { class: 'dim' }, 'No cues yet. Tap "+ New cue".'),
      h('div', { class: 'note' }, `Saving keeps your place in the show (standby: cue ${sh.index + 1}). A backup of the previous cue list is kept next to the show file.`)), saveBar());
  }
  draw();
  return wrap;
}

// ---------- Cameras ----------
function simView(camId) {
  // Stand-in for a real video feed: a virtual stage that pans/zooms with the simulated camera.
  const c = h('canvas', { width: 640, height: 360 });
  const g = c.getContext('2d');
  const draw = () => {
    if (!c.isConnected) return;
    const st = S.devices[camId]?.state || {};
    const pan = (st.pan || 0) / 2448, tilt = (st.tilt || 0) / 1296, z = 1 + (st.zoom || 0) / 0x4000 * 5;
    g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#05070a'; g.fillRect(0, 0, 640, 360);
    g.translate(320, 180); g.scale(z, z); g.translate(-pan * 600, tilt * 200);
    g.fillStyle = '#2b1d14'; g.fillRect(-700, 40, 1400, 160);               // stage deck
    g.fillStyle = '#5b0f14'; g.fillRect(-720, -260, 120, 300); g.fillRect(600, -260, 120, 300); // proscenium legs
    const t = performance.now() / 1000;
    [[-300, '#ffd27a'], [0, '#9ad1ff'], [300, '#ff9ad5']].forEach(([x, col], i) => {
      const grd = g.createRadialGradient(x, 120, 5, x, 120, 120); grd.addColorStop(0, col + 'aa'); grd.addColorStop(1, '#0000');
      g.fillStyle = grd; g.fillRect(x - 120, 0, 240, 240);
      g.fillStyle = '#ddd'; const bob = Math.sin(t * 2 + i) * 4;
      g.beginPath(); g.arc(x, 40 + bob, 12, 0, 7); g.fill(); g.fillRect(x - 10, 54 + bob, 20, 50);
    });
    g.fillStyle = '#111'; g.fillRect(-250, 200, 500, 80);                    // pit
    g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#fff8'; g.font = '13px monospace';
    g.fillText(`SIM ${camId}  P${st.pan ?? '-'} T${st.tilt ?? '-'} Z${st.zoom ?? '-'}`, 10, 20);
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
  return c;
}
function videoEl(cam) {
  const s = cam.state.stream || {};
  switch (s.type) {
    case 'sim': return simView(cam.id);
    case 'go2rtc': return h('iframe', { src: `${s.url}/stream.html?src=${encodeURIComponent(s.src || cam.id)}&mode=webrtc,mse,hls,mjpeg`, allow: 'autoplay; fullscreen' });
    case 'mediamtx': return h('iframe', { src: `${s.url}/${encodeURIComponent(s.src || cam.id)}`, allow: 'autoplay; fullscreen' });
    case 'mjpeg': return h('img', { src: s.url, alt: cam.name });
    case 'hls': return h('video', { src: s.url, autoplay: '', muted: '', playsinline: '', controls: '' });
    case 'iframe': return h('iframe', { src: s.url, allow: 'autoplay; fullscreen' });
    default: return h('div', { style: 'display:grid;place-items:center;color:var(--dim)' }, 'No video configured');
  }
}
function joystick(onVec) {
  const knob = h('div', { class: 'knob' });
  const el = h('div', { class: 'joy' }, knob);
  let active = false, vec = [0, 0], timer;
  const setFrom = e => {
    const r = el.getBoundingClientRect(), R = r.width / 2;
    let x = (e.clientX - r.left - R) / R, y = (e.clientY - r.top - R) / R;
    const m = Math.hypot(x, y); if (m > 1) { x /= m; y /= m; }
    vec = [x, -y]; knob.style.transform = `translate(${x * R * 0.6}px, ${y * R * 0.6}px)`;
  };
  el.addEventListener('pointerdown', e => { active = true; el.setPointerCapture(e.pointerId); setFrom(e); onVec(...vec); timer = setInterval(() => onVec(...vec), 120); });
  el.addEventListener('pointermove', e => active && setFrom(e));
  const end = () => { if (!active) return; active = false; clearInterval(timer); knob.style.transform = ''; onVec(0, 0); };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  return el;
}
function holdBtn(label, onDown, onUp) {
  const b = h('button', {}, label);
  b.addEventListener('pointerdown', e => { b.setPointerCapture(e.pointerId); onDown(); });
  b.addEventListener('pointerup', onUp); b.addEventListener('pointercancel', onUp);
  return b;
}
function camCard(cam, expanded) {
  const view = h('div', { class: 'view' }, videoEl(cam), h('div', { class: 'osd' }, cam.name));
  onDevice(cam.id, d => view.classList.toggle('tally', !!d.state.tally));
  const presets = h('div', { class: 'presets' });
  onDevice(cam.id, d => presets.replaceChildren(...(d.state.presets.length ? d.state.presets : [1, 2, 3, 4, 5, 6].map(n => ({ n, label: `P${n}` }))).map(p => {
    const b = h('button', { class: d.state.lastPreset === p.n ? 'cur' : '' }, p.label);
    let t; // tap = recall, long-press = store
    b.addEventListener('pointerdown', () => { t = setTimeout(() => { t = null; if (confirm(`Store current shot as "${p.label}" on ${cam.name}?`)) cmd(cam.id, 'store', { preset: p.n }); }, 800); });
    b.addEventListener('pointerup', () => { if (t) { clearTimeout(t); cmd(cam.id, 'preset', { preset: p.n }); } });
    b.addEventListener('pointercancel', () => clearTimeout(t));
    return b;
  })));
  const card = h('div', { class: 'card' }, h('h3', {}, cam.name, statusPill(cam.id)), view);
  if (!expanded) return card;
  card.classList.add('camfull');
  card.append(h('div', { class: 'camctl' },
    joystick((x, y) => cmd(cam.id, 'move', { pan: x, tilt: y })),
    h('div', { class: 'camside' },
      h('div', { class: 'zoom' }, holdBtn('Zoom −', () => cmd(cam.id, 'zoom', { speed: -0.6 }), () => cmd(cam.id, 'zoom', { speed: 0 })),
        holdBtn('Zoom +', () => cmd(cam.id, 'zoom', { speed: 0.6 }), () => cmd(cam.id, 'zoom', { speed: 0 })),
        h('button', { onclick: () => cmd(cam.id, 'home') }, 'Home')),
      h('div', { class: 'row', style: 'margin-top:6px' }, h('button', { onclick: () => cmd(cam.id, 'focus', { mode: 'auto' }) }, 'AF'),
        h('button', { onclick: () => cmd(cam.id, 'focus', { mode: 'onepush' }) }, 'Push AF'),
        h('button', { onclick: () => cmd(cam.id, 'tally', { on: !S.devices[cam.id].state.tally }) }, 'Tally')),
      presets)));
  return card;
}
function camTab() {
  const cams = byType('ptz');
  if (!cams.length) return h('div', { class: 'card' }, 'No cameras configured.');
  S.camSel ||= cams[0].id;
  const tabs = h('div', { class: 'row', style: 'margin-bottom:10px' },
    h('button', { class: S.camSel === 'all' ? 'on always' : 'always', onclick: () => { S.camSel = 'all'; render(); } }, 'All'),
    cams.map(c => h('button', { class: S.camSel === c.id ? 'on always' : 'always', onclick: () => { S.camSel = c.id; render(); } }, c.name.split(' · ')[0])));
  if (S.camSel === 'all') return h('div', {}, tabs, h('div', { class: 'cams' }, cams.map(c => camCard(c, false))));
  return h('div', {}, tabs, camCard(S.devices[S.camSel], true));
}

// ---------- System ----------
function sysTab() {
  const log = h('div', { class: 'log' });
  const line = e => h('div', { class: e.level || '' }, `${new Date(e.t).toLocaleTimeString([], { hour12: false })}  ${e.device || ''}  ${e.msg}`);
  log.append(...S.log.map(line));
  (updaters.__log ||= []).push(e => { const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20; log.append(line(e)); if (atBottom) log.scrollTop = log.scrollHeight; });
  setTimeout(() => (log.scrollTop = log.scrollHeight));
  const devs = h('div', { class: 'kv' }, Object.values(S.devices).map(d => [h('b', {}, d.name), h('span', {}, statusPill(d.id), ' ', h('span', { class: 'mono' }, d.type))]));
  const screen = (href, name, what) => h('div', {}, h('a', { href, target: '_blank', style: 'color:#9cc4ff;font-weight:600' }, name), h('div', { class: 'dim', style: 'font-size:13px' }, what));
  const screens = h('div', { class: 'card' }, h('h3', {}, 'Stage manager and crew screens'),
    h('div', { style: 'display:grid;gap:10px' },
      screen('/sm.html', 'Stage manager', 'Big GO, standby with crew ready, calls, notes, script, checklist, countdown'),
      screen('/crew.html', 'Crew phones', 'Each person picks their job: own run sheet, cue light, calls'),
      screen('/foh.html', 'Front of house', 'House open / closed / hold for the stage manager, calls, lobby message'),
      screen('/lobby.html', 'Lobby TV', 'Big countdown to the start or end of the interval')),
    h('p', { class: 'hint' }, `On another phone or iPad, open ${location.origin} followed by the page name, e.g. ${location.origin}/crew.html`));
  return h('div', { class: 'grid' }, setupCard(), SYS_CARDS.map(f => f()), screens, h('div', { class: 'card' }, h('h3', {}, 'Devices'), devs),
    h('div', { class: 'card', style: 'grid-column:1/-1' }, h('h3', {}, 'Log'), log));
}

connect();
