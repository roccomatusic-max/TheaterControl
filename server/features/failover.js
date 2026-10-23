// Backup computer: a second computer runs Show Control on standby, keeps an up-to-date copy of the
// show (cue list, position, timers, lock, settings) and takes over by itself if the main computer
// stops answering. Only the active computer talks to the equipment.
//
// Settings in the show file: "failover": { "role": "main" | "backup", "peer": "10.101.50.6:8080" }.
// The computer on standby connects to the active one like an iPad does (with the admin PIN, which
// both share once the show is copied) and listens. The iPads know both addresses and move across
// by themselves.
//  - At start-up the main computer runs the show, unless the backup has already taken over (then
//    the main waits on standby until someone hands the show back).
//  - The backup waits on standby. If it can't reach the main computer for TAKEOVER_MS (or for
//    STARTUP_GRACE_MS after it starts), it takes over.
//  - "Hand back" on the backup asks the main computer to take over again; the backup then restarts
//    on standby (equipment connections are only ever opened once per run).
const fs = require('fs');
const crypto = require('crypto');
const WebSocket = require('ws');

const TAKEOVER_MS = Number(process.env.SHOW_TAKEOVER_MS || 5000);
const STARTUP_GRACE_MS = Number(process.env.SHOW_FAILOVER_GRACE_MS || 60000);
const LOCAL_KEYS = ['failover', 'live']; // never copied from the other computer

module.exports = function failover(ctx) {
  const conf = () => ctx.settings().failover || {};
  const peerUrl = () => { const p = String(conf().peer || '').trim(); return p ? (p.includes(':') ? p : `${p}:8080`) : ''; };
  const me = { id: crypto.randomBytes(4).toString('hex'), role: conf().role || null, active: true, since: Date.now(), reason: '' };
  let mirrors = new Set(); // sockets of the standby computer copying from us
  let link = null;         // our connection to the active computer, while on standby
  let lastCopy = 0, takeoverTimer = null, peerSeen = false;

  ctx.failover = me;
  if (!me.role || ctx.MODE === 'practice') { me.role = null; registerHandlers(); return; }

  // ---------- standby: copy the active computer ----------
  ctx.holdDevices = true; // index.js starts the equipment once we know we're the active one
  function goStandby(reason) {
    me.active = false; me.reason = reason; me.since = Date.now();
    ctx.log({ device: 'core', level: 'warn', msg: `backup computer: on standby (${reason})`, t: Date.now() });
    connect();
  }
  function connect() {
    if (me.active || !peerUrl()) return;
    const ws = new WebSocket(`ws://${peerUrl()}/ws`, { handshakeTimeout: 2000 });
    link = ws;
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.t === 'auth-required') ws.send(JSON.stringify({ t: 'auth', pin: ctx.settings().server?.pin || '' }));
      else if (m.t === 'auth-failed') ctx.log({ device: 'core', level: 'error', msg: 'backup computer: the other computer refused the admin PIN. Give both the same admin PIN.', t: Date.now() });
      else if (m.t === 'init') {
        peerSeen = true; clearTimeout(takeoverTimer); takeoverTimer = null;
        // Both on standby (e.g. the main computer restarted while the backup was restarting): the main
        // computer takes over; the backup keeps trying until the main one is running the show.
        if (m.failover && !m.failover.active) { ws.close(); if (me.role === 'main') takeOver('both computers were on standby'); return; }
        applyShow(m.show); if (m.lock !== undefined) ctx.events.emit('mirror-lock', m.lock);
        ws.send(JSON.stringify({ t: 'mirror-hello', id: me.id }));
      }
      else if (m.t === 'show') applyShow(m.show);
      else if (m.t === 'lock') ctx.events.emit('mirror-lock', m.lock);
      else if (m.t === 'mirror-file') applyFile(m.file);
      else if (m.t === 'failover-handback') takeOver('the backup computer handed the show back');
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      if (link === ws) link = null;
      if (me.active) return;
      // Not answering: take over after TAKEOVER_MS (STARTUP_GRACE_MS if we never reached it).
      if (!takeoverTimer) takeoverTimer = setTimeout(() => takeOver(peerSeen ? 'the main computer stopped answering' : 'the main computer could not be reached after start-up'), peerSeen ? TAKEOVER_MS : STARTUP_GRACE_MS);
      setTimeout(connect, 1000);
    });
  }
  function applyShow(s) {
    if (!s) return;
    Object.assign(ctx.show, { name: s.name, cues: s.cues, index: s.index, lastFired: s.lastFired, timers: s.timers, emergency: s.emergency || null });
    lastCopy = Date.now();
    ctx.saveState();
    ctx.broadcast({ t: 'show', show: ctx.showSnapshot() });
  }
  function applyFile(file) {
    try {
      const mine = ctx.readJson(ctx.SAVE_PATH, {});
      const next = { ...file };
      for (const k of LOCAL_KEYS) { if (k in mine) next[k] = mine[k]; else delete next[k]; }
      ctx.writeJson(ctx.SAVE_PATH, next);
      lastCopy = Date.now();
    } catch (e) { ctx.log({ device: 'core', level: 'warn', msg: `backup computer: could not save the copy of the show: ${e.message}`, t: Date.now() }); }
  }
  function takeOver(reason) {
    if (me.active) return;
    clearTimeout(takeoverTimer); takeoverTimer = null;
    me.active = true; me.since = Date.now(); me.reason = reason;
    const l = link; link = null; l?.close();
    ctx.startDevices();
    ctx.alert?.('error', 'failover', `${me.role === 'backup' ? 'The backup computer has taken over' : 'This computer is running the show again'}: ${reason}.`, { kind: 'backup' });
    ctx.broadcast({ t: 'failover', ...info() }); // screens connected here reload as the active computer
  }

  // ---------- active: let the standby copy us ----------
  let lastMtime = 0;
  const fileNow = () => ctx.readJson(ctx.SAVE_PATH, null) || ctx.cfg;
  setInterval(() => {
    if (!me.active || !mirrors.size) return;
    let mt = 0; try { mt = fs.statSync(ctx.SAVE_PATH).mtimeMs; } catch { return; }
    if (mt !== lastMtime) { lastMtime = mt; for (const ws of mirrors) ws.send(JSON.stringify({ t: 'mirror-file', file: fileNow() })); }
  }, 2000).unref();

  // ---------- start-up: who runs the show? ----------
  function decide(why) {
    // Ask the other computer whether it is already running the show.
    const ws = new WebSocket(`ws://${peerUrl()}/ws`, { handshakeTimeout: 2000 });
    let settled = false;
    const done = peerActive => {
      if (settled) return; settled = true; ws.terminate();
      if (peerActive) goStandby(`the ${me.role === 'main' ? 'backup' : 'main'} computer is running the show`);
      else if (me.role === 'main') { me.active = true; me.since = Date.now(); ctx.startDevices(); }
      else goStandby(why || 'waiting for the main computer');
    };
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.t === 'auth-required') ws.send(JSON.stringify({ t: 'auth', pin: ctx.settings().server?.pin || '' }));
      else if (m.t === 'init') done(!!m.failover?.active);
      else if (m.t === 'auth-failed') done(false);
    });
    ws.on('error', () => done(false));
    ws.on('close', () => done(false));
    setTimeout(() => done(false), 3000);
  }
  me.active = false;
  ctx.events.once('listening', () => decide());

  registerHandlers();
  for (const t of ['failover-set', 'failover-takeover', 'failover-handback']) ctx.access?.adminOnly(t);

  // ---------- requests from the screens ----------
  function info() {
    return { role: me.role, active: me.active, since: me.since, reason: me.reason, peer: peerUrl(), mirror: mirrors.size > 0, linked: !!link && link.readyState === 1, lastCopy };
  }
  function registerHandlers() {
    ctx.handlers['failover-get'] = () => ({ ...info(), mode: ctx.MODE });
    ctx.handlers['failover-set'] = m => {
      if (ctx.MODE === 'practice') throw new Error('Set up the backup computer once you are live with the real equipment.');
      const role = m.role === 'main' || m.role === 'backup' ? m.role : null;
      const peer = String(m.peer || '').trim();
      if (role && !/^[A-Za-z0-9.-]+(:\d{2,5})?$/.test(peer)) throw new Error('Type the other computer\'s address, like 10.101.50.6 (or 10.101.50.6:8080)');
      ctx.saveSettings({ failover: role ? { role, peer } : undefined });
      ctx.log({ device: 'core', level: 'cmd', msg: role ? `backup computer: this is the ${role} computer, the other one is ${peer}` : 'backup computer: turned off', t: Date.now() });
      if (ctx.SUPERVISED) setTimeout(() => process.exit(75), 500); // restart into the new arrangement
      return { restarting: ctx.SUPERVISED };
    };
    ctx.handlers['mirror-hello'] = (m, ws) => {
      if (!me.active) throw new Error('This computer is on standby itself.');
      ws.mirror = true; mirrors.add(ws);
      ws.on('close', () => { mirrors.delete(ws); if (me.active && me.role) ctx.alert?.('error', 'failover-mirror', 'The backup computer is no longer connected, so it can\'t take over.', { kind: 'backup' }); });
      ctx.alert?.('ok', 'failover-mirror', 'Backup computer connected');
      ws.send(JSON.stringify({ t: 'mirror-file', file: fileNow() }));
      return { ok: true };
    };
    ctx.handlers['failover-takeover'] = () => { if (!me.role) throw new Error('No backup computer is set up.'); takeOver('taken over from this screen'); return info(); };
    // On the backup while it runs the show: give it back to the main computer, then restart on standby.
    ctx.handlers['failover-handback'] = () => {
      if (!me.active || me.role !== 'backup') throw new Error('Only the backup computer, while it runs the show, can hand it back.');
      if (!mirrors.size) throw new Error('The main computer isn\'t connected yet. Start Show Control on it first.');
      for (const ws of mirrors) ws.send(JSON.stringify({ t: 'failover-handback' }));
      ctx.log({ device: 'core', level: 'cmd', msg: 'backup computer: handed the show back to the main computer', t: Date.now() });
      setTimeout(() => { ctx.stopDevices(); process.exit(ctx.SUPERVISED ? 75 : 0); }, 300);
      return { ok: true };
    };
  }

  // Screens on the standby computer can look but not run anything.
  const LOOK = new Set(['auth', 'failover-get', 'failover-set', 'failover-takeover', 'health-get', 'preshow-check', 'versions-list', 'backups-get', 'access-get', 'setup-get', 'screens-list', 'screen-hello', 'depts-get', 'reports-get', 'report-link', 'report-timing']);
  ctx.guards.push(m => {
    if (me.role && !me.active && !LOOK.has(m.t)) throw new Error(`This is the backup computer, on standby. The show is running on ${peerUrl()}.`);
  });
  ctx.initExtras.push(() => ({ failover: me.role ? info() : null }));
  ctx.checks.push(() => !me.role ? [] : [me.active
    ? (mirrors.size ? { group: 'This computer', state: 'ok', label: 'Backup computer', detail: `Connected (${peerUrl()}), keeping a copy of the show. It takes over by itself if this computer stops.` }
      : { group: 'This computer', state: 'warn', label: 'Backup computer', detail: `Not connected (${peerUrl()}), so it can't take over. Check Show Control is running on it.` })
    : { group: 'This computer', state: 'warn', label: 'Backup computer', detail: `This is the backup computer, on standby. The show runs on ${peerUrl()}.` }]);
};
