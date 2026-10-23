// Equipment health, alerts and the one-button pre-show check.
//  - Alerts: equipment that was working and stops answering for more than a few seconds raises an
//    alert on every screen (and on the phone, see below); it clears when the equipment answers again.
//  - Phone alerts: pushed through ntfy (free app for iPhone/Android), so they arrive even when the app
//    is closed. Needs the show computer to have internet (the control network). Off until turned on.
//  - Pre-show check: one list of green/amber/red items for equipment, the show and this computer,
//    with a "fix" button where there is an obvious fix.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');

const GRACE_MS = Number(process.env.SHOW_ALERT_GRACE_MS || 5000); // brief network blips don't alert
const FRESH_MS = 15000; // every driver hears from its device at least this often when it's working
const DAY_MS = 12 * 3600e3;
const PROJECTOR = ['panasonic', 'pjlink'];

module.exports = function health(ctx) {
  const { devices, show, log, broadcast } = ctx;
  const nameOf = d => (d.name || d.id).split(' · ')[0];
  const track = new Map(); // device id → { status, since, drops: [times], timer, alerted }
  const recent = []; // last 50 alerts
  const active = new Map(); // device id (or 'core') → alert still showing
  let seq = 0;
  let lastCheck = null;

  // ---------- alerts ----------
  function raise(level, key, msg, extra = {}) {
    const a = { id: ++seq, at: Date.now(), level, key, msg, ...extra };
    recent.push(a); if (recent.length > 50) recent.shift();
    if (level === 'error') active.set(key, a); else active.delete(key);
    broadcast({ t: 'alert', alert: a });
    log({ device: key, level: level === 'error' ? 'error' : 'info', msg, t: a.at });
    queuePush(a);
    return a;
  }
  // Alerts that arrive together (a switch dies and everything drops) go to the phone as one message.
  // Each new alert waits a little longer for others (equipment notices a dead switch at different
  // speeds), but never more than four times the wait after the first one.
  const BATCH_MS = Number(process.env.SHOW_ALERT_BATCH_MS || 3000);
  let batch = [], batchTimer = null, batchStart = 0;
  function queuePush(a) {
    if (!batch.length) batchStart = Date.now();
    batch.push(a);
    clearTimeout(batchTimer);
    batchTimer = setTimeout(() => {
      const list = batch; batch = []; batchTimer = null;
      if (list.length === 1) return push(list[0]);
      const names = lv => list.filter(x => x.level === lv && devices.has(x.key)).map(x => nameOf(devices.get(x.key)));
      const down = names('error'), up = names('ok'), other = list.filter(x => !devices.has(x.key)).map(x => x.msg);
      push({ level: list.some(x => x.level === 'error') ? 'error' : 'ok', msg: [
        down.length && `Stopped answering: ${down.join(', ')}.${down.length >= 3 ? ' Check the show network switch.' : ''}`,
        up.length && `Answering again: ${up.join(', ')}.`, ...other].filter(Boolean).join('\n') });
    }, Math.max(0, Math.min(BATCH_MS, batchStart + 4 * BATCH_MS - Date.now())));
  }
  function onChange(d) {
    let t = track.get(d.id);
    if (!t) track.set(d.id, t = { status: d.status, since: Date.now(), drops: [] });
    if (t.status === d.status) return;
    const was = t.status;
    t.status = d.status; t.since = Date.now();
    if (d.status === 'online') {
      if (t.timer) { clearTimeout(t.timer); t.timer = null; } // a blip: never alerted
      else if (t.alerted) { t.alerted = false; raise('ok', d.id, `${nameOf(d)} is answering again`); }
    } else if (was === 'online') {
      t.drops.push(Date.now());
      t.timer = setTimeout(() => {
        t.timer = null; t.alerted = true;
        raise('error', d.id, `${nameOf(d)} stopped answering`);
      }, GRACE_MS);
    }
  }
  for (const d of devices.values()) {
    track.set(d.id, { status: d.status, since: Date.now(), drops: [] });
    d.on('changed', onChange);
  }
  ctx.events.on('emergency', who => raise('error', 'emergency', `Emergency STOP pressed (${who})`));
  ctx.events.on('emergency-cleared', () => { if (active.has('emergency')) raise('ok', 'emergency', 'Emergency stop cleared'); });
  if (process.env.SHOW_RECOVERED) setTimeout(() => raise('warn', 'core', 'Show Control stopped unexpectedly and started again by itself'), 3000);

  // ---------- phone alerts (ntfy) ----------
  const phoneCfg = () => ctx.settings().alerts || {};
  let pushFailedAt = 0;
  async function push(a, force) {
    const p = phoneCfg();
    if (!p.ntfyTopic || (!p.on && !force)) return { ok: false, detail: 'Phone alerts are off.' };
    const body = {
      topic: p.ntfyTopic, title: `${show.name}${ctx.MODE === 'practice' ? ' (practice)' : ''}`, message: a.msg,
      priority: a.level === 'error' ? 5 : 3, tags: [a.level === 'error' ? 'rotating_light' : a.level === 'warn' ? 'warning' : 'white_check_mark'],
    };
    try {
      const res = await fetch(p.ntfyServer || 'https://ntfy.sh', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`the alert service answered ${res.status}`);
      return { ok: true, detail: 'Sent. It should arrive on your phone in a few seconds.' };
    } catch (e) {
      const why = /fetch failed|ENOTFOUND|EAI_AGAIN|ENETUNREACH|timeout|aborted/i.test(`${e.message} ${e.cause?.code || ''}`)
        ? 'This computer could not reach the internet, so the phone alert was not sent.' : `Phone alert not sent: ${e.message}`;
      if (Date.now() - pushFailedAt > 60000) { pushFailedAt = Date.now(); log({ device: 'core', level: 'warn', msg: why, t: Date.now() }); }
      return { ok: false, detail: why };
    }
  }
  async function phoneInfo() {
    const p = phoneCfg();
    if (!p.ntfyTopic) return { on: false };
    const server = p.ntfyServer || 'https://ntfy.sh';
    const url = `${server.replace(/\/$/, '')}/${p.ntfyTopic}`;
    return { on: !!p.on, server, topic: p.ntfyTopic, url, qr: await QRCode.toString(url, { type: 'svg', margin: 1 }) };
  }
  function setPhone(on) {
    const p = phoneCfg();
    // A random channel name: anyone who knows it can read the alerts, so it is never guessable.
    const topic = p.ntfyTopic || `showcontrol-${crypto.randomBytes(8).toString('hex')}`;
    ctx.saveSettings({ alerts: { ...p, on: !!on, ntfyTopic: topic } });
    return phoneInfo();
  }

  // ---------- pre-show check ----------
  const ago = ms => ms < 90e3 ? `${Math.round(ms / 1000)} s` : ms < 90 * 60e3 ? `${Math.round(ms / 60e3)} min` : `${(ms / 3600e3).toFixed(1)} h`;
  function equipmentItem(d) {
    const s = d.state || {};
    const base = { group: 'Equipment', id: d.id, label: nameOf(d) };
    if (d.type === 'osc') return { ...base, state: 'info', detail: 'Messages are sent without a reply, so this one can\'t be checked from here.' };
    if (d.status !== 'online') return { ...base, state: 'error', detail: d.status === 'connecting' ? 'Trying to connect, no answer yet.' : 'Not answering. Check it is switched on and plugged into the show network.' };
    if (Date.now() - d.lastSeen > FRESH_MS) return { ...base, state: 'warn', detail: `Connected, but last heard from ${ago(Date.now() - d.lastSeen)} ago.` };
    const bits = [];
    if (d.type === 'eos' && s.showName) bits.push(`Show file "${s.showName}"`);
    if (d.type === 'qlab' && s.playhead) bits.push(`Next QLab cue ${s.playhead}${s.playheadName ? ` (${s.playheadName})` : ''}`);
    if (d.type === 'yamaha-tf' && s.lastScene) bits.push(`Last scene ${s.lastScene}`);
    if (PROJECTOR.includes(d.type)) {
      const bad = Object.entries(s.health || {}).filter(([, v]) => v && v !== 'ok');
      if (s.power === 'standby') return { ...base, state: 'warn', detail: 'Switched off (standby). It takes about a minute to warm up.', fix: { label: 'Turn on', msgs: [{ t: 'cmd', device: d.id, cmd: 'power', args: { on: true } }] } };
      if (bad.length) return { ...base, state: 'warn', detail: `Reports a problem: ${bad.map(([k, v]) => `${k} ${v}`).join(', ')}` };
      bits.push(s.transition === 'warming' ? 'Warming up' : s.power === 'on' ? 'On' : '');
      if (s.shutter) bits.push(`shutter ${s.shutter}`);
    }
    return { ...base, state: 'ok', detail: `Answering.${bits.filter(Boolean).length ? ` ${bits.filter(Boolean).join(', ')}.` : ''}` };
  }
  function showItems() {
    const items = [], add = (state, label, detail, fix) => items.push({ group: 'Show', state, label, detail, ...(fix ? { fix } : {}) });
    if (ctx.MODE === 'practice') add('warn', 'Practice mode', 'Pretend equipment: nothing real is being controlled. Go live from System > Set up real equipment.');
    if (show.emergency) add('error', 'Emergency stop', 'The emergency stop banner is still showing.', { label: 'Clear it', msgs: [{ t: 'show', action: 'clear-emergency' }] });
    if (!show.cues.length) add('error', 'Cue list', 'There are no cues yet.');
    else {
      const top = show.cues[0];
      if (show.index > 0) add('warn', 'Standby', `Standing by on cue ${show.cues[show.index]?.number ?? show.index + 1}${show.cues[show.index] ? ` (${show.cues[show.index].label})` : ' (end of show)'}, not the first cue.`,
        { label: 'Go to the top', msgs: [{ t: 'show', action: 'standby', index: 0 }] });
      else add('ok', 'Standby', `Standing by on the first cue: ${top.number ?? 1} ${top.label}.`);
      // Steps for equipment that isn't set up (no address) are skipped at GO.
      const missing = new Map();
      show.cues.forEach((c, i) => (c.actions || []).forEach(a => {
        if (String(a.device).startsWith('group:') || devices.has(a.device)) return;
        if (!missing.has(a.device)) missing.set(a.device, []);
        const n = c.number ?? i + 1; if (!missing.get(a.device).includes(n)) missing.get(a.device).push(n);
      }));
      for (const [id, nums] of missing) {
        const dc = ctx.cfg.devices.find(x => x.id === id);
        add('warn', dc?.name?.split(' · ')[0] || id, `Used by cue${nums.length > 1 ? 's' : ''} ${nums.slice(0, 8).join(', ')}${nums.length > 8 ? '…' : ''}, but it has no address yet, so those steps will be skipped.`);
      }
    }
    const tm = show.timers;
    const running = ['show', 'act'].filter(k => tm[k].start || tm[k].acc > 1000);
    if (running.length) add('warn', 'Timers', `The ${running.map(k => (k === 'act' ? tm.label : 'show')).join(' and ')} timer is not at zero.`,
      { label: 'Reset timers', msgs: running.flatMap(k => [{ t: 'show', action: 'timer', timer: k, op: 'stop' }, { t: 'show', action: 'timer', timer: k, op: 'reset' }]) });
    else add('ok', 'Timers', 'At zero.');
    return items;
  }
  function computerItems() {
    const items = [], add = (state, label, detail) => items.push({ group: 'This computer', state, label, detail });
    try {
      const st = fs.statfsSync(path.dirname(ctx.SAVE_PATH));
      const gb = (st.bavail * st.bsize) / 1e9;
      add(gb < 1 ? 'error' : gb < 5 ? 'warn' : 'ok', 'Disk space', `${gb.toFixed(gb < 10 ? 1 : 0)} GB free.${gb < 5 ? ' Delete old recordings or files soon.' : ''}`);
    } catch { /* not available on this system */ }
    const screens = ctx.clients().length;
    add('info', 'Screens connected', `${screens} iPad${screens === 1 ? '' : 's'}, phone${screens === 1 ? '' : 's'} or computer${screens === 1 ? '' : 's'} using Show Control right now.`);
    const p = phoneCfg();
    add(p.on ? 'ok' : 'info', 'Phone alerts', p.on ? 'On.' : 'Off. Turn them on below to get a notification when something stops answering.');
    return items;
  }
  async function preshowCheck(who) {
    // Give anything that is still connecting a few seconds to answer before judging it.
    for (let i = 0; i < 10 && [...devices.values()].some(d => d.status === 'connecting'); i++) await new Promise(r => setTimeout(r, 500));
    const items = [...[...devices.values()].map(equipmentItem), ...showItems(), ...computerItems()];
    for (const extra of ctx.checks) try { items.push(...(await extra())); } catch (e) { items.push({ group: 'This computer', state: 'warn', label: 'Check', detail: e.message }); }
    const count = k => items.filter(i => i.state === k).length;
    lastCheck = { at: Date.now(), by: who, items, errors: count('error'), warnings: count('warn') };
    log({ device: 'show', level: lastCheck.errors ? 'error' : lastCheck.warnings ? 'warn' : 'cmd',
      msg: `pre-show check by ${who}: ${lastCheck.errors ? `${lastCheck.errors} problem${lastCheck.errors > 1 ? 's' : ''}` : 'no problems'}${lastCheck.warnings ? `, ${lastCheck.warnings} to look at` : ''}`, t: lastCheck.at });
    broadcast({ t: 'check', check: lastCheck });
    return lastCheck;
  }

  function healthInfo() {
    const now = Date.now();
    return {
      now,
      devices: Object.fromEntries([...track].map(([id, t]) => [id, { since: t.since, drops: t.drops.filter(x => now - x < DAY_MS).length }])),
      alerts: recent.slice(-20).reverse(),
      lastCheck,
    };
  }

  ctx.handlers['preshow-check'] = (m, ws) => preshowCheck(ws.who);
  ctx.handlers['health-get'] = async () => ({ ...healthInfo(), phone: await phoneInfo() });
  ctx.handlers['alerts-phone'] = m => setPhone(m.on);
  ctx.handlers['alerts-test'] = () => push({ level: 'warn', msg: 'Test alert from Show Control. Phone alerts are working.' }, true);
  ctx.initExtras.push(() => ({ alerts: [...active.values()], lastCheck }));
  return { raise, preshowCheck };
};
