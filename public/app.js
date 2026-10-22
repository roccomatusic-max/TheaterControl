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
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
}

const S = { devices: {}, show: null, log: [], ui: {}, tab: localStorage.getItem('tab') || 'show', clockSkew: 0 };
const updaters = {}; // device id → [fn(snapshot)]
const onDevice = (id, fn) => { (updaters[id] ||= []).push(fn); if (S.devices[id]) fn(S.devices[id]); };
const byType = t => Object.values(S.devices).filter(d => d.type === t);

// ---------- connection ----------
let ws, wsTimer;
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => setConn(true);
  ws.onclose = () => { setConn(false); clearTimeout(wsTimer); wsTimer = setTimeout(connect, 1500); };
  ws.onmessage = e => handle(JSON.parse(e.data));
}
const send = m => ws?.readyState === 1 ? ws.send(JSON.stringify(m)) : toast('Not connected');
const cmd = (device, c, args) => send({ t: 'cmd', device, cmd: c, args });
function setConn(ok) { const c = $('#conn'); c.textContent = ok ? 'live' : 'offline'; c.className = 'pill ' + (ok ? 'ok' : 'off'); }

function handle(m) {
  if (m.t === 'auth-required') { $('#pin').hidden = false; $('#pinInput').focus(); const saved = localStorage.getItem('pin'); if (saved) send({ t: 'auth', pin: saved }); }
  else if (m.t === 'auth-failed') { $('#pinErr').textContent = 'Wrong PIN'; localStorage.removeItem('pin'); $('#pin').hidden = false; }
  else if (m.t === 'init') {
    $('#pin').hidden = true;
    S.devices = Object.fromEntries(m.devices.map(d => [d.id, d])); S.show = m.show; S.log = m.log; S.ui = m.ui;
    S.clockSkew = m.show.now - Date.now();
    $('#showName').textContent = m.show.name;
    render();
  } else if (m.t === 'device') {
    S.devices[m.device.id] = m.device;
    (updaters[m.device.id] || []).forEach(fn => fn(m.device));
    renderDots();
  } else if (m.t === 'show') { S.show = m.show; S.clockSkew = m.show.now - Date.now(); (updaters.__show || []).forEach(fn => fn(S.show)); }
  else if (m.t === 'log') { S.log.push(m.entry); if (S.log.length > 300) S.log.shift(); (updaters.__log || []).forEach(fn => fn(m.entry)); }
  else if (m.t === 'error') toast(m.msg);
}
$('#pin form').addEventListener('submit', e => { e.preventDefault(); const pin = $('#pinInput').value; localStorage.setItem('pin', pin); send({ t: 'auth', pin }); });

function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2500); }

// ---------- chrome ----------
function renderDots() {
  $('#statusDots').replaceChildren(...Object.values(S.devices).map(d => h('div', { class: `dot ${d.status}`, title: `${d.name}: ${d.status}` }, h('i'), h('span', {}, d.name.split(' · ')[0]))));
}
document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => { S.tab = b.dataset.tab; localStorage.setItem('tab', S.tab); render(); }));
const lockBtn = $('#lockBtn');
function setLock(on) { document.body.classList.toggle('locked', on); lockBtn.textContent = on ? '🔒' : '🔓'; localStorage.setItem('locked', on ? '1' : ''); }
lockBtn.addEventListener('click', () => setLock(!document.body.classList.contains('locked')));
setLock(!!localStorage.getItem('locked'));
setInterval(() => { $('#clock').textContent = new Date(Date.now() + S.clockSkew).toLocaleTimeString([], { hour12: false }); (updaters.__tick || []).forEach(f => f()); }, 250);

function render() {
  for (const k of Object.keys(updaters)) delete updaters[k];
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === S.tab));
  renderDots();
  const main = $('#main');
  main.replaceChildren(({ show: showTab, lx: lxTab, snd: sndTab, cam: camTab, sys: sysTab })[S.tab]());
}

// ---------- Show tab ----------
const fmtDur = ms => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
function actionText(a) {
  const d = S.devices[a.device]?.name?.split(' · ')[0] || a.device, x = a.args || {};
  const s = { cue: `Q${x.cue}`, start: `Q${x.cue}`, scene: `scene ${String(x.bank || 'a').toUpperCase()}${x.scene}`, preset: `preset ${x.preset}`, macro: `macro ${x.macro}`, shutter: x.closed ? 'shutter close' : 'shutter open' }[a.cmd] || a.cmd;
  return `${d} ${s}${a.delay ? ` +${a.delay}s` : ''}`;
}
function showTab() {
  let lastGo = 0;
  const go = h('button', { id: 'goBtn', onclick: () => { if (Date.now() - lastGo < 600) return; lastGo = Date.now(); send({ t: 'show', action: 'go' }); } }, 'GO');
  const stby = h('div', { class: 'standby' });
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
    stby.replaceChildren(h('small', {}, 'STANDBY'), h('div', { class: 'lbl' }, next ? `${next.number ?? sh.index + 1}  ${next.label}` : 'End of show'),
      h('div', { class: 'acts' }, next ? [next.note ? `${next.note} · ` : '', (next.actions || []).map(actionText).join(' · ')] : ''));
    list.replaceChildren(...sh.cues.map((c, i) => h('div', { class: `cue ${i < sh.index ? 'done' : ''} ${i === sh.index ? 'next' : ''} ${i === sh.lastFired ? 'last' : ''}` },
      h('div', { class: 'n' }, c.number ?? i + 1),
      h('div', {}, h('div', {}, c.label), h('div', { class: 'tags' }, (c.actions || []).map(actionText).join(' · '))),
      h('div', { class: 'row' }, h('button', { onclick: () => send({ t: 'show', action: 'standby', index: i }) }, 'Stby'),
        h('button', { onclick: () => confirm(`Fire ${c.label} now?`) && send({ t: 'show', action: 'fire', index: i }) }, 'Fire')))));
    // keep the standby cue in view inside the list only; never scroll the page away from GO
    const nx = list.querySelector('.next');
    if (nx) list.scrollTop = Math.max(0, nx.offsetTop - list.offsetTop - 60);
  };
  (updaters.__show ||= []).push(update);
  setTimeout(() => update(S.show));

  const eos = byType('eos')[0], qlab = byType('qlab')[0];
  const quick = h('div', { class: 'grid' },
    eos && h('div', { class: 'card' }, h('h3', {}, eos.name), eosStatus(eos.id),
      h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'big', onclick: () => cmd(eos.id, 'go') }, 'LX GO'), h('button', { onclick: () => cmd(eos.id, 'back') }, 'Back'))),
    qlab && h('div', { class: 'card' }, h('h3', {}, qlab.name), qlabStatus(qlab.id),
      h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'big', onclick: () => cmd(qlab.id, 'go') }, 'SFX GO'),
        h('button', { onclick: () => cmd(qlab.id, 'stop') }, 'Stop'), h('button', { class: 'danger', onclick: () => cmd(qlab.id, 'panic') }, 'Panic'))));
  return h('div', {},
    h('div', { class: 'showtop' }, stby, go),
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
  if (!eos) return h('div', { class: 'card' }, 'No Eos console configured.');
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
      h('div', { class: 'row' }, (S.ui.eosQuick || []).map(q => h('button', { onclick: () => cmd(eos.id, q.cmd, q.args) }, q.label)))));
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
  const projs = byType('pjlink').map(p => {
    const kv = h('div', { class: 'kv' }); onDevice(p.id, d => kv.replaceChildren(h('b', {}, 'Power'), h('span', {}, d.state.power ?? '—'), h('b', {}, 'Shutter'), h('span', {}, d.state.shutter ?? '—')));
    return h('div', { class: 'card' }, h('h3', {}, p.name, statusPill(p.id)), kv,
      h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { onclick: () => confirm(`Power ON ${p.name}?`) && cmd(p.id, 'power', { on: true }) }, 'Power on'),
        h('button', { onclick: () => confirm(`Power OFF ${p.name}?`) && cmd(p.id, 'power', { on: false }) }, 'Power off'),
        h('button', { onclick: () => cmd(p.id, 'shutter', { closed: true }) }, 'Shutter close'), h('button', { onclick: () => cmd(p.id, 'shutter', { closed: false }) }, 'Shutter open')));
  });
  const devs = h('div', { class: 'kv' }, Object.values(S.devices).map(d => [h('b', {}, d.name), h('span', {}, statusPill(d.id), ' ', h('span', { class: 'mono' }, d.type))]));
  return h('div', { class: 'grid' }, h('div', { class: 'card' }, h('h3', {}, 'Devices'), devs), ...projs,
    h('div', { class: 'card', style: 'grid-column:1/-1' }, h('h3', {}, 'Log'), log));
}

connect();
