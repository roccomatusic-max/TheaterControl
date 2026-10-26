// Shared by the stage manager, crew, front of house and lobby screens: connection, PIN,
// night (red) mode, sounds and small helpers. No build step, no external assets.
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

const C = { defaultName: '', show: null, crew: null, script: { text: '', marks: {} }, devices: {}, groups: [], skew: 0, mode: null, ready: false };
const hooks = {};
const on = (k, fn) => (hooks[k] ||= []).push(fn);
const emit = (k, ...a) => (hooks[k] || []).forEach(fn => fn(...a));
const now = () => Date.now() + C.skew;

// Who is holding this device (asked once, kept on the device).
const me = () => ({ name: localStorage.getItem('crewName') || '', role: localStorage.getItem('crewRole') || '' });
const setMe = (k, v) => localStorage.setItem(k === 'name' ? 'crewName' : 'crewRole', v || '');

// ---------- connection ----------
let ws, wsTimer, seq = 0;
const pending = {};
// Same id as the main app on this device, so System > Screens lists it and can limit what it may do.
const screenId = (() => { try { return localStorage.getItem('screenId') || (localStorage.setItem('screenId', `s${Math.random().toString(36).slice(2, 12)}`), localStorage.getItem('screenId')); } catch { return ''; } })();
const PAGE = location.pathname.replace(/^\/|\.html$/g, '') || 'crew';
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?screen=${encodeURIComponent(screenId)}`);
  ws.onopen = () => setConn(true);
  ws.onclose = () => { setConn(false); clearTimeout(wsTimer); wsTimer = setTimeout(connect, 1500); };
  ws.onmessage = e => handle(JSON.parse(e.data));
}
const send = m => ws?.readyState === 1 ? (ws.send(JSON.stringify(m)), true) : (toast('Not connected'), false);
// Crew requests always get an answer: { ok: true }, or the reason it didn't work (shown as a toast).
function ask(op, data = {}) {
  const id = ++seq;
  if (!send({ t: 'crew', op, id, name: me().name || C.defaultName, ...data })) return Promise.resolve({ error: 'Not connected' });
  return new Promise(res => {
    pending[id] = r => { if (r?.error) toast(r.error, 5000); res(r); };
    setTimeout(() => { if (pending[id]) { delete pending[id]; toast('No answer from Show Control'); res({ error: 'timeout' }); } }, 10000);
  });
}
const showCmd = (action, extra = {}) => send({ t: 'show', action, ...extra });

let offlineTimer;
function setConn(ok) {
  const p = $('#conn');
  if (p) { p.textContent = ok ? (C.mode === 'practice' ? 'practice' : 'live') : 'offline'; p.className = 'pill ' + (ok ? (C.mode === 'practice' ? 'warn' : 'ok') : 'off'); }
  clearTimeout(offlineTimer);
  C.lostAt = ok ? null : C.lostAt || Date.now();
  if (ok) offlineEl.hidden = true;
  else offlineTimer = setTimeout(() => (offlineEl.hidden = false), 1200);
}
function handle(m) {
  if (m.t === 'auth-required') { pinEl.hidden = false; const saved = localStorage.getItem('pin'); if (saved) send({ t: 'auth', pin: saved }); else $('input', pinEl).focus(); }
  else if (m.t === 'auth-failed') { $('.err', pinEl).textContent = 'Wrong PIN'; localStorage.removeItem('pin'); pinEl.hidden = false; }
  else if (m.t === 'init') {
    pinEl.hidden = true;
    Object.assign(C, { show: m.show, crew: m.crew, script: m.script || { text: '', marks: {} }, groups: m.groups || [], mode: m.mode, skew: m.show.now - Date.now(), ready: true });
    C.devices = Object.fromEntries(m.devices.map(d => [d.id, d]));
    setConn(true);
    document.title = `${document.title.split(' · ')[0]} · ${m.show.name}`;
    C.role = m.role || 'admin'; C.signin = !!m.signin;
    reloadIfUpdated(m.version);
    screenHello();
    emit('init');
  }
  else if (m.t === 'show') { C.show = m.show; C.skew = m.show.now - Date.now(); emit('show'); }
  else if (m.t === 'crew') { C.crew = m.crew; emit('crew'); }
  else if (m.t === 'crew-script') { C.script = m.script; emit('script'); }
  else if (m.t === 'crew-call') emit('call', m.call);
  else if (m.t === 'crew-go') emit('go', m);
  else if (m.t === 'device') { C.devices[m.device.id] = m.device; emit('device'); }
  else if (m.t === 'reply') { pending[m.id]?.(m.data); delete pending[m.id]; }
  else if (m.t === 'saved') { pending[m.id]?.({ ok: true }); delete pending[m.id]; }
  else if (m.t === 'error') { if (pending[m.id]) { pending[m.id]({ error: m.msg }); delete pending[m.id]; } else toast(m.msg, 5000); }
}

// ---------- kiosk ----------
// A Chromebook, Android tablet or spare iPad that only ever shows this one screen, e.g. a cue light
// on the fly floor. Open the page once with ?kiosk=1 (crew.html?kiosk=1&job=Fly%20floor also fixes the
// job); the device remembers it. Kiosk screens go full screen at the first tap, stay awake, hide
// everything that leads off the page, reload themselves if they lose Show Control for a while, and
// warn when their battery runs low. Press and hold the clock for 3 seconds to leave kiosk mode.
const KIOSK = (() => {
  const key = `kiosk:${PAGE}`, q = new URLSearchParams(location.search);
  try {
    if (q.get('kiosk') === '0') { localStorage.removeItem(key); return null; }
    if (q.has('kiosk')) localStorage.setItem(key, JSON.stringify({ job: q.get('job') || '', name: q.get('name') || '' }));
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch { return q.has('kiosk') && q.get('kiosk') !== '0' ? { job: q.get('job') || '', name: q.get('name') || '' } : null; }
})();
if (KIOSK) {
  document.documentElement.classList.add('kiosk');
  if (KIOSK.job) setMe('role', KIOSK.job);
  if (KIOSK.name || (KIOSK.job && !me().name)) setMe('name', KIOSK.name || KIOSK.job);
}
function setupKiosk() {
  if (!KIOSK) return;
  const root = document.documentElement;
  const full = () => { if (!document.fullscreenElement && !document.webkitFullscreenElement) (root.requestFullscreen || root.webkitRequestFullscreen)?.call(root)?.catch?.(() => {}); };
  // browsers only allow full screen from a tap, so every tap tries again until it sticks
  document.addEventListener('click', full, true);
  document.addEventListener('contextmenu', e => e.preventDefault());
  document.addEventListener('fullscreenchange', keepAwake);
  // the mouse pointer (Chromebook trackpad) hides when not used
  let idle;
  document.addEventListener('pointermove', () => { root.classList.remove('idle'); clearTimeout(idle); idle = setTimeout(() => root.classList.add('idle'), 4000); });
  // Not connected for 30 seconds: reload, in case the page itself is stuck. (Reconnecting is automatic
  // before that, and this page holds nothing that would be lost.)
  setInterval(() => { if (ws?.readyState !== 1 && Date.now() - (C.lostAt || Date.now()) > 30e3) location.reload(); }, 5000);
  const bat = h('div', { class: 'kiosk-battery', hidden: '' });
  document.body.append(bat);
  navigator.getBattery?.().then(b => {
    const show = () => { bat.hidden = b.charging || b.level > 0.2; bat.textContent = `🔋 ${Math.round(b.level * 100)}%: plug this screen in`; };
    b.addEventListener('levelchange', show); b.addEventListener('chargingchange', show); show();
  }).catch(() => {});
  // press and hold the clock for 3 seconds to leave kiosk mode (needs the admin PIN, if there is one)
  const clockEl = $('#clock')?.parentElement || $('header');
  let hold;
  clockEl?.addEventListener('pointerdown', () => { hold = setTimeout(leaveKiosk, 3000); });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) clockEl?.addEventListener(ev, () => clearTimeout(hold));
}
async function leaveKiosk() {
  const pin = C.signin ? prompt('Admin PIN to leave kiosk mode') : (confirm('Leave kiosk mode on this screen?') ? '' : null);
  if (pin == null) return;
  const id = ++seq;
  send({ t: 'kiosk-exit', id, pin });
  pending[id] = r => {
    if (r?.error) return toast(r.error, 4000);
    try { localStorage.removeItem(`kiosk:${PAGE}`); } catch { /* private mode */ }
    document.exitFullscreen?.().catch(() => {});
    location.replace(location.pathname);
  };
}

// Listed on System > Screens with the crew member's name and job.
function screenHello() {
  if (!screenId) return;
  const who = me(), name = localStorage.getItem('screenName') || [who.name, who.role].filter(Boolean).join(' · ') || C.defaultName || 'Crew screen';
  send({ t: 'screen-hello', id: ++seq, screen: screenId, name, view: { tab: PAGE, role: who.role || null, kiosk: KIOSK || null } });
}
// After a one-tap update the server runs a new version: load the new pages too (they are tiny).
let seenVersion = null;
function reloadIfUpdated(v) {
  if (v && seenVersion && v !== seenVersion) location.reload();
  if (v) seenVersion = v;
}

// ---------- page furniture ----------
const pinEl = h('div', { id: 'pin', hidden: '' }, h('form', { onsubmit: e => { e.preventDefault(); const pin = $('input', pinEl).value; localStorage.setItem('pin', pin); send({ t: 'auth', pin }); } },
  h('h2', {}, 'Enter PIN'), h('input', { inputmode: 'numeric', autocomplete: 'off', type: 'password' }), h('button', {}, 'Unlock'), h('p', { class: 'err', id: 'pinErr' })));
const offlineEl = h('div', { id: 'offline', hidden: '' }, h('div', {}, h('b', {}, 'Not connected to Show Control'), h('span', {}, 'Reconnecting… Buttons do nothing until this goes away.')));
const toastEl = h('div', { id: 'toast' });
function toast(msg, ms = 2500) { toastEl.textContent = msg; toastEl.classList.add('show'); clearTimeout(toastEl._t); toastEl._t = setTimeout(() => toastEl.classList.remove('show'), ms); }

// Night mode: everything in dim red so a screen in the wings doesn't light up the set. Kept per device.
function setNight(on) { document.documentElement.classList.toggle('night', on); localStorage.setItem('night', on ? '1' : ''); }
setNight(!!localStorage.getItem('night'));
const nightBtn = () => h('button', { class: 'nightbtn always', title: 'Night mode: dim red screen for backstage', onclick: () => setNight(!document.documentElement.classList.contains('night')) }, '🌙');

// Sounds: iOS only plays audio after the first tap, so the first touch anywhere unlocks it.
let actx;
document.addEventListener('pointerdown', () => { try { actx ||= new (window.AudioContext || window.webkitAudioContext)(); actx.resume(); } catch { /* no audio */ } }, { once: true });
function beep(kind = 'call') {
  navigator.vibrate?.(kind === 'go' ? [300] : [200, 100, 200]);
  if (!actx || localStorage.getItem('mute')) return;
  const tones = kind === 'go' ? [[880, 0, 0.35]] : kind === 'standby' ? [[660, 0, 0.15]] : [[660, 0, 0.18], [880, 0.22, 0.25]];
  for (const [f, at, len] of tones) {
    const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime + at;
    o.frequency.value = f; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.4, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(g).connect(actx.destination); o.start(t); o.stop(t + len + 0.05);
  }
}

// Keep the screen awake while the page is open.
let wakeLock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => (wakeLock = null)); } } catch { /* not allowed yet */ }
}
document.addEventListener('visibilitychange', keepAwake);
document.addEventListener('pointerdown', keepAwake, { once: true });

// A full-screen call ("Five minutes please") with a Got it button, on crew and front of house screens.
function callOverlay(call) {
  beep('call');
  const el = h('div', { class: 'callov' }, h('div', {},
    h('small', {}, `CALL from ${call.by} · ${clock(call.at)}`), h('div', { class: 'ct' }, call.text),
    h('button', { class: 'primary big', onclick: () => { ask('call-ack', { call: call.id }); el.remove(); } }, 'Got it')));
  document.body.append(el);
}

// ---------- helpers ----------
// replaceChildren, but skipping the false/undefined left by `cond && el`
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(c => c != null && c !== false));
const pad = n => String(n).padStart(2, '0');
const fmtDur = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`; };
const fmtCount = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`; };
const clock = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const timerMs = key => { const tm = C.show?.timers?.[key]; return tm ? tm.acc + (tm.start ? now() - tm.start : 0) : 0; };
const cueNo = (c, i) => String(c?.number ?? i + 1);
const tasksFor = (cue, role) => (cue?.crew || []).filter(x => x.role === role);
const FOH_TEXT = { 'not-open': 'House not open yet', open: 'House open', hold: 'Hold: audience still coming in', closed: 'House closed: clear to start', interval: 'Interval' };
const FOH_CLASS = { 'not-open': '', open: 'warn', hold: 'off', closed: 'ok', interval: 'warn' };
const fohPill = () => { const f = C.crew?.foh || {}; return h('span', { class: `pill ${FOH_CLASS[f.status] || ''}`, title: f.at ? `${f.by} at ${clock(f.at)}` : '' }, `FOH: ${FOH_TEXT[f.status] || '—'}`); };

function boot() {
  document.body.append(pinEl, offlineEl, toastEl);
  setInterval(() => emit('tick'), 250);
  setupKiosk();
  keepAwake();
  connect();
}
