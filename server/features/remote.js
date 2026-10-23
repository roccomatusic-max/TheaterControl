// Buttons, MIDI and timecode: things other than the iPads that run the show.
//  - Remote address over HTTP (off until switched on): GET or POST /remote/<key>/go (back, next,
//    stop, fire/<cue number>, dept/<department>, state). For a Stream Deck through Bitfocus
//    Companion's HTTP buttons or the Stream Deck app's web-request plugins, X-keys, scripts.
//  - OSC on UDP (off until switched on, port 53535): /showcontrol/go, /back, /next, /stop,
//    /fire <cue number>, /dept/<department>/go, /timecode "01:02:03:04". For Companion's OSC
//    buttons, TouchOSC, QLab network cues, Eos cue OSC strings.
//  - MIDI from equipment that passes it on (a device emitting 'midi', or a computer running Show
//    Control in Chrome with MIDI switched on): learned notes, CCs and program changes run GO, back,
//    STOP or a department's GO; MIDI Show Control GO from a console; MIDI timecode.
//  - Timecode: cues with a timecode fire by themselves as the timecode plays past them, while
//    "follow timecode" is on. A jump in the timecode (someone scrubbing) fires nothing.
// Everything except timecode goes through the same checks as a screen signed in as an operator
// (show lock, backup computer on standby).
const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const osc = require('../lib/osc');

const OSC_PORT = 53535;
const FPS = [24, 25, 29.97, 30];
const ACTION_WORDS = { go: 'GO', back: 'Standby back one cue', next: 'Standby on the next cue', stop: 'Emergency STOP', fire: 'Fire cue', dept: 'Department GO' };

module.exports = function remote(ctx) {
  const conf = () => ({ key: '', http: false, osc: false, oscPort: OSC_PORT, midi: [], msc: false, tcFollow: false, ...(ctx.settings().remote || {}) });
  const save = patch => ctx.saveSettings({ remote: { ...conf(), ...patch } });
  const log = (msg, level = 'cmd') => ctx.log({ device: 'remote', level, msg, t: Date.now() });

  // ---------- stand-in screens ----------
  // Each source (a button box's address, OSC, a MIDI device) is a stand-in screen signed in as an
  // operator, so its requests are checked and logged like any iPad's.
  const stands = new Map();
  function standIn(label) {
    if (stands.has(label)) return stands.get(label);
    const s = new EventEmitter();
    Object.assign(s, { readyState: 1, pending: new Map(), seq: 0, close() {}, terminate() {} });
    s.send = raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      const done = s.pending.get(m.id);
      if (done && ['reply', 'error', 'saved', 'result'].includes(m.t)) { s.pending.delete(m.id); done(m.t === 'error' ? { error: m.msg } : m.data ?? {}); }
    };
    ctx.attachScreen(s, label);
    s.authed = true; s.role = 'operator';
    stands.set(label, s);
    return s;
  }
  const request = (label, m, ms) => new Promise(res => {
    const s = standIn(label), id = `remote${++s.seq}`;
    s.pending.set(id, res);
    s.emit('message', Buffer.from(JSON.stringify({ ...m, id })));
    setTimeout(() => { if (s.pending.delete(id)) res({}); }, ms); // "show" requests only answer when something is wrong
  });
  const recent = new Map();
  async function run(action, arg, label) {
    const k = `${label}|${action}|${arg ?? ''}`;
    if (Date.now() - (recent.get(k) || 0) < 500) return { ignored: 'pressed twice within half a second' }; // bouncing buttons
    recent.set(k, Date.now());
    const sh = ctx.show;
    switch (action) {
      case 'go': return request(label, { t: 'show', action: 'go' }, 150);
      case 'back': return request(label, { t: 'show', action: 'standby', index: Math.max(0, sh.index - 1) }, 150);
      case 'next': return request(label, { t: 'show', action: 'standby', index: Math.min(sh.cues.length, sh.index + 1) }, 150);
      case 'stop': return request(label, { t: 'emergency' }, 5000);
      case 'fire': {
        const i = sh.cues.findIndex(c => String(c.number) === String(arg).trim());
        if (i < 0) { log(`${label}: no cue ${arg}`, 'warn'); return { error: `There is no cue ${arg}` }; }
        return request(label, { t: 'show', action: 'fire', index: i }, 150);
      }
      case 'dept': return request(label, { t: 'dept-go', dept: arg }, 3000);
      default: return { error: `Unknown action "${action}". Use go, back, next, stop, fire/<cue>, dept/<department>.` };
    }
  }
  const state = () => {
    const sh = ctx.show, n = sh.cues[sh.index], l = sh.cues[sh.lastFired];
    return { standby: n ? `${n.number ?? sh.index + 1} ${n.label}` : 'End of show', last: l ? `${l.number ?? sh.lastFired + 1} ${l.label}` : '', timecode: tcText(), following: conf().tcFollow };
  };

  // ---------- HTTP ----------
  ctx.routes.push(app => app.all('/remote/:key/:action/:arg?', async (req, res) => {
    const c = conf();
    if (!c.http || !c.key || req.params.key !== c.key) return res.status(403).json({ ok: false, error: 'Wrong or old remote address: copy it again from System > Buttons, MIDI and timecode.' });
    if (req.params.action === 'state') return res.json({ ok: true, ...state() });
    const r = await run(req.params.action, req.params.arg, `Button ${String(req.ip || '').replace('::ffff:', '')}`);
    res.status(r.error ? 409 : 200).json({ ok: !r.error, ...r, ...state() });
  }));

  // ---------- OSC ----------
  let sock = null;
  function oscStart() {
    if (sock) { try { sock.close(); } catch { /* closed */ } sock = null; }
    const c = conf();
    if (!c.osc) return;
    const s = sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    s.on('error', e => { log(`OSC input on port ${c.oscPort} stopped: ${e.message}`, 'error'); if (sock === s) sock = null; try { s.close(); } catch { /* closed */ } });
    s.on('message', (buf, from) => { let msgs; try { msgs = [].concat(osc.decode(buf)); } catch { return; } msgs.forEach(m => onOsc(m, from.address)); });
    s.bind(Number(c.oscPort) || OSC_PORT);
  }
  function onOsc({ address, args }, from) {
    const p = String(address).toLowerCase().split('/').filter(Boolean);
    if (p[0] !== 'showcontrol') return;
    if (p[1] === 'timecode') return p[2] === 'stop' ? tcStop() : tcSet(parseTc(args.length > 1 ? args.join(':') : args[0]), `OSC from ${from}`, true);
    if (args[0] === 0 || args[0] === false) return; // a button being let go
    const label = `OSC ${from}`;
    if (p[1] === 'dept') return run('dept', p[2], label);
    if (p[1] === 'fire') return run('fire', p[2] ?? args[0], label);
    if (['go', 'back', 'next', 'stop'].includes(p[1])) return run(p[1], null, label);
  }

  // ---------- MIDI ----------
  let learning = null, lastMidi = null;
  const ccDown = new Set();
  for (const d of ctx.devices.values()) d.on('midi', bytes => midiIn([...bytes], (d.name || d.id).split(' · ')[0]));
  function midiIn(b, from) {
    const st = b[0];
    if (st === 0xf1) return mtcQuarter(b[1], from);
    if (st === 0xf0) {
      if (b[1] === 0x7f && b[3] === 0x01 && b[4] === 0x01) return tcSet({ h: b[5] & 0x1f, m: b[6], s: b[7], f: b[8], rate: (b[5] >> 5) & 3 }, from, false); // full frame: a locate
      if (b[1] === 0x7f && b[3] === 0x02) return mscIn(b, from);
      return;
    }
    const type = st >> 4, ch = st & 0x0f;
    let ev = null;
    if (type === 0x9 && b[2] > 0) ev = { type: 'note', ch, num: b[1] };
    else if (type === 0xb) {
      const k = `${ch}:${b[1]}`;
      if (b[2] < 64) { ccDown.delete(k); return; }
      if (ccDown.has(k)) return; // only the moment it is pressed
      ccDown.add(k); ev = { type: 'cc', ch, num: b[1] };
    } else if (type === 0xc) ev = { type: 'pc', ch, num: b[1] };
    if (!ev) return;
    lastMidi = { ...ev, from, at: Date.now() };
    if (learning && learning.until > Date.now()) {
      const midi = conf().midi.filter(x => !(x.type === ev.type && x.ch === ev.ch && x.num === ev.num));
      midi.push({ ...ev, action: learning.action, arg: learning.arg ?? null });
      save({ midi });
      log(`MIDI ${midiWords(ev)} from ${from} now does: ${actionWords(learning.action, learning.arg)}`);
      learning = null;
      return publish();
    }
    const map = conf().midi.find(x => x.type === ev.type && x.ch === ev.ch && x.num === ev.num);
    if (map) run(map.action, map.arg, `MIDI ${from}`);
    publish();
  }
  function mscIn(b, from) {
    if (!conf().msc || b[5] !== 0x01) return; // only GO
    const end = b.indexOf(0xf7);
    const data = b.slice(6, end < 0 ? undefined : end);
    const z = data.indexOf(0);
    const cue = String.fromCharCode(...data.slice(0, z < 0 ? data.length : z)).trim();
    return cue ? run('fire', cue, `${from} (MIDI Show Control)`) : run('go', null, `${from} (MIDI Show Control)`);
  }
  ctx.handlers['midi-in'] = (m, ws) => {
    const from = `MIDI on ${ctx.screenName?.(ws.who) || ws.who}`;
    for (const b of (Array.isArray(m.messages) ? m.messages : []).slice(0, 400)) if (Array.isArray(b) && b.length) midiIn(b.map(x => Number(x) & 0xff), from);
    return null;
  };
  const midiWords = x => `${{ note: 'note', cc: 'controller', pc: 'program' }[x.type]} ${x.type === 'pc' ? x.num + 1 : x.num} (channel ${x.ch + 1})`;
  const actionWords = (a, arg) => `${ACTION_WORDS[a] || a}${a === 'fire' ? ` ${arg}` : a === 'dept' ? ` (${ctx.depts?.name(arg) || arg})` : ''}`;

  // ---------- timecode ----------
  const tc = { qf: [], fps: 30, sec: null, running: false, source: '', at: 0, watch: null };
  const secOf = ({ h, m, s, f }) => h * 3600 + m * 60 + s + f / tc.fps;
  const parseTc = v => { const p = String(v ?? '').split(/[:;.]/).map(Number); return p.length === 4 && p.every(n => n >= 0) ? { h: p[0], m: p[1], s: p[2], f: p[3] } : null; };
  function tcText() {
    if (tc.sec == null) return '';
    const fps = Math.round(tc.fps), fr = Math.floor(tc.sec * fps + 1e-6), p = n => String(n).padStart(2, '0');
    return `${p(Math.floor(fr / (3600 * fps)))}:${p(Math.floor(fr / (60 * fps)) % 60)}:${p(Math.floor(fr / fps) % 60)}:${p(fr % fps)}`;
  }
  function mtcQuarter(v, from) {
    const piece = v >> 4;
    if (piece === 0) tc.qf = [];
    tc.qf[piece] = v & 0x0f;
    if (piece !== 7 || tc.qf.filter(x => x != null).length !== 8) return;
    const q = tc.qf;
    // a full set takes two frames to arrive, so the time it carries is two frames old
    tcSet({ f: (q[0] | (q[1] << 4)) + 2, s: q[2] | (q[3] << 4), m: q[4] | (q[5] << 4), h: q[6] | ((q[7] & 1) << 4), rate: (q[7] >> 1) & 3 }, from, true);
  }
  function tcSet(t, source, running) {
    if (!t) return;
    if (t.rate != null) tc.fps = FPS[t.rate];
    const prev = tc.running ? tc.sec : null, sec = secOf(t);
    Object.assign(tc, { sec, source, at: Date.now(), running });
    clearTimeout(tc.watch);
    if (running) tc.watch = setTimeout(tcStop, 500);
    // Playing: fire the cues it has just passed. A jump (scrubbing, a locate) fires nothing.
    if (running && prev != null && conf().tcFollow && sec > prev && sec - prev < 1.5) {
      const standby = ctx.failover?.role && !ctx.failover.active;
      ctx.show.cues.forEach((c, i) => {
        const at = c.tc && secOf(parseTc(c.tc));
        if (at > prev && at <= sec && !standby) { log(`timecode ${c.tc}: cue ${c.number ?? i + 1}`); ctx.fireCue(i, `timecode ${c.tc}`); }
      });
    }
    publishTc();
  }
  function tcStop() { clearTimeout(tc.watch); if (!tc.running) return; tc.running = false; publishTc(true); }
  let tcTimer = null;
  const tcInfo = () => ({ text: tcText(), running: tc.running, source: tc.source, fps: tc.fps, at: tc.at, follow: conf().tcFollow, cues: ctx.show.cues.filter(c => c.tc).length });
  function publishTc(now) {
    if (now) { clearTimeout(tcTimer); tcTimer = null; return ctx.broadcast({ t: 'timecode', timecode: tcInfo() }); }
    if (!tcTimer) tcTimer = setTimeout(() => { tcTimer = null; ctx.broadcast({ t: 'timecode', timecode: tcInfo() }); }, 250);
  }

  // ---------- settings ----------
  const addresses = () => Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')).map(i => i.address);
  // Only the admin sees the remote key: it is as good as the operator PIN.
  const info = ws => {
    const c = conf();
    return { http: c.http, key: (ws?.role || 'admin') === 'admin' ? c.key : undefined, osc: c.osc, oscPort: c.oscPort, oscOn: !!sock, msc: c.msc, addresses: addresses(), port: Number(process.env.PORT || ctx.cfg.server?.port || 8080),
      midi: c.midi.map(x => ({ ...x, words: midiWords(x), does: actionWords(x.action, x.arg) })), learning: learning && learning.until > Date.now() ? actionWords(learning.action, learning.arg) : null,
      lastMidi: lastMidi && { words: midiWords(lastMidi), from: lastMidi.from, at: lastMidi.at }, timecode: tcInfo() };
  };
  const publish = () => { for (const ws of ctx.clients()) ws.send(JSON.stringify({ t: 'remote', remote: info(ws) })); };
  ctx.handlers['remote-get'] = (m, ws) => info(ws);
  ctx.handlers['remote-set'] = (m, ws) => {
    const c = conf(), patch = {};
    if (m.http != null) patch.http = !!m.http;
    if ((patch.http && !c.key) || m.newKey) patch.key = crypto.randomBytes(6).toString('hex');
    if (m.osc != null) patch.osc = !!m.osc;
    if (m.oscPort != null) {
      const p = Number(m.oscPort);
      if (!(p >= 1024 && p <= 65535)) throw new Error('The OSC port must be a number from 1024 to 65535.');
      patch.oscPort = p;
    }
    if (m.msc != null) patch.msc = !!m.msc;
    if (m.forget != null) patch.midi = c.midi.filter((_, i) => i !== Number(m.forget));
    save(patch);
    log(`buttons and MIDI settings changed by ${ctx.screenName?.(ws.who) || ws.who}`);
    if ('osc' in patch || 'oscPort' in patch) oscStart();
    publish();
    return info(ws);
  };
  ctx.handlers['remote-learn'] = (m, ws) => {
    if (m.cancel) { learning = null; publish(); return info(ws); }
    if (!ACTION_WORDS[m.action]) throw new Error('Pick what the MIDI button should do.');
    learning = { action: m.action, arg: m.arg ?? null, until: Date.now() + 30e3 };
    setTimeout(() => { if (learning && learning.until <= Date.now()) { learning = null; publish(); } }, 30.5e3);
    publish();
    return info(ws);
  };
  ctx.handlers['timecode-follow'] = (m, ws) => {
    save({ tcFollow: !!m.on });
    log(`${m.on ? 'cues now fire by timecode' : 'cues no longer fire by timecode'} (${ctx.screenName?.(ws.who) || ws.who})`);
    publishTc(true);
    return tcInfo();
  };
  for (const t of ['remote-set']) ctx.access?.adminOnly(t);

  ctx.checks.push(() => {
    const n = ctx.show.cues.filter(c => c.tc).length;
    if (!n) return [];
    const fresh = tc.at && Date.now() - tc.at < 10 * 60e3;
    return [{ group: 'Show', label: 'Timecode', state: conf().tcFollow ? (fresh ? 'ok' : 'warn') : 'warn',
      detail: `${n} cue${n > 1 ? 's' : ''} fire by timecode. ${conf().tcFollow ? 'Following timecode' : 'Following timecode is OFF, so they won\'t fire'}. ${fresh ? `Last timecode ${tcText()} from ${tc.source}.` : 'No timecode received yet.'}` }];
  });
  ctx.initExtras.push(ws => ({ timecode: tcInfo(), remoteRole: ws.role }));
  ctx.events.once('listening', oscStart);
};
