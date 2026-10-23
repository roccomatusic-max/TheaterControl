// Stage manager and crew features: calls to crew phones, cue lights, front of house link,
// countdown for the lobby screen, rehearsal notes, show night checklist and the script.
// Setup that belongs to the show (crew roles, checklist items, script) is saved in the show
// file under "crew"; what happens during a night (notes, ticks, calls) in a state file next to it.
const fs = require('fs');

const DEFAULTS = {
  roles: ['ASM stage left', 'ASM stage right', 'Fly floor', 'Follow spot 1', 'Follow spot 2', 'Wardrobe'],
  depts: ['SM', 'LX', 'Sound', 'Video', 'Stage', 'Cast'],
  checklist: ['Stage swept and mopped', 'Props preset stage left', 'Props preset stage right', 'Fire exits clear and lit',
    'Radio mics fitted and checked', 'Comms checked', 'Lighting channel check done', 'Projectors on, shutters closed',
    'Front of house ready'],
};
const FOH = ['not-open', 'open', 'hold', 'closed', 'interval'];
const TARGETS = ['all', 'crew', 'foh'];
const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const list = (v, max) => (Array.isArray(v) ? v : String(v || '').split('\n')).map(x => str(x, 120)).filter(Boolean).slice(0, max);

module.exports = function createCrew({ cfg, show, savePath, statePath, writeJson, broadcast, log, saveCues, showChanged }) {
  const conf = () => ({ ...DEFAULTS, ...(cfg.crew || {}) });
  const st = { notes: [], calls: [], foh: { status: 'not-open', at: null, by: null, note: '' }, countdown: null, lobby: '',
    checks: { started: Date.now(), ticks: {}, signedOff: null }, acks: { index: null, roles: {} }, lights: {} };
  try { Object.assign(st, JSON.parse(fs.readFileSync(statePath, 'utf8'))); } catch { /* first run */ }

  let saveTimer = null;
  const persist = () => {
    if (!statePath || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try { writeJson(statePath, st); } catch (e) { log({ device: 'crew', level: 'warn', msg: `could not save crew state: ${e.message}`, t: Date.now() }); }
    }, 200);
  };
  // Standby acknowledgements only count for the cue that's in standby right now.
  const acks = () => (st.acks.index === show.index ? st.acks.roles : {});
  const snapshot = () => {
    const c = conf();
    return { roles: c.roles, depts: c.depts, checklist: c.checklist, hasScript: !!c.script?.text,
      notes: st.notes, calls: st.calls.slice(-30), foh: st.foh, countdown: st.countdown, lobby: st.lobby,
      checks: st.checks, acks: acks(), lights: st.lights };
  };
  const script = () => ({ text: conf().script?.text || '', marks: conf().script?.marks || {} });
  const changed = () => { broadcast({ t: 'crew', crew: snapshot() }); persist(); };

  // Show setup lives in the show file, so it travels with the cue list (practice → live and back).
  function saveConf(patch, who, what) {
    let onDisk = cfg;
    try { onDisk = JSON.parse(fs.readFileSync(savePath, 'utf8')); } catch { /* first save of a practice copy */ }
    if (fs.existsSync(savePath)) fs.copyFileSync(savePath, `${savePath}.bak`);
    cfg.crew = { ...(onDisk.crew || {}), ...patch };
    writeJson(savePath, { ...onDisk, crew: cfg.crew });
    log({ device: 'crew', level: 'cmd', msg: `${what} saved by ${who}`, t: Date.now() });
  }

  function addCall(text, to, by) {
    const call = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), text, to, by, at: Date.now(), acks: {} };
    st.calls.push(call); if (st.calls.length > 60) st.calls.shift();
    broadcast({ t: 'crew-call', call });
    log({ device: 'crew', level: 'cmd', msg: `call "${text}" to ${to} by ${by}`, t: Date.now() });
    return call;
  }

  // Every op answers with { ok: true } (or throws); the caller sends that back as a reply.
  const ops = {
    'note-add'(m, who) {
      const text = str(m.text, 2000); if (!text) throw new Error('The note is empty');
      const i = show.lastFired ?? show.index, cue = show.cues[i];
      const tm = show.timers.show;
      st.notes.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), text, dept: str(m.dept, 40), by: str(m.name, 40) || who, at: Date.now(),
        cue: cue ? String(cue.number ?? i + 1) : '', cueLabel: cue?.label || '', showTime: tm.acc + (tm.start ? Date.now() - tm.start : 0) });
    },
    'note-del'(m) { st.notes = st.notes.filter(n => n.id !== m.note); },
    'notes-clear'() { st.notes = []; },
    call(m, who) {
      const text = str(m.text, 200); if (!text) throw new Error('Type a call first');
      const to = str(m.to, 120) || 'all';
      if (!TARGETS.includes(to) && !conf().roles.includes(to)) throw new Error(`Nobody called "${to}"`);
      addCall(text, to, str(m.name, 40) || who);
    },
    'call-ack'(m, who) {
      const c = st.calls.find(x => x.id === m.call); if (!c) return;
      c.acks[str(m.name, 40) || who] = Date.now();
    },
    foh(m, who) {
      if (!FOH.includes(m.status)) throw new Error('Unknown front of house status');
      st.foh = { status: m.status, note: str(m.note, 200), at: Date.now(), by: str(m.name, 40) || who };
      log({ device: 'crew', level: 'cmd', msg: `front of house: ${m.status}${st.foh.note ? ` (${st.foh.note})` : ''} by ${st.foh.by}`, t: Date.now() });
    },
    countdown(m) {
      if (m.target == null) { st.countdown = null; return; }
      const target = Number(m.target);
      if (!(target > Date.now() - 60e3 && target < Date.now() + 24 * 3600e3)) throw new Error('Pick a time within the next 24 hours');
      st.countdown = { label: str(m.label, 80) || 'Starting in', target, done: str(m.done, 80) };
    },
    lobby(m) { st.lobby = str(m.text, 200); },
    check(m, who) {
      const items = conf().checklist, i = Number(m.i);
      if (!(i >= 0 && i < items.length)) throw new Error('No such checklist item');
      if (m.on) st.checks.ticks[i] = { by: str(m.name, 40) || who, at: Date.now() }; else delete st.checks.ticks[i];
      st.checks.signedOff = null; // any change after sign-off needs a new sign-off
    },
    signoff(m, who) {
      const missing = conf().checklist.filter((_, i) => !st.checks.ticks[i]).length;
      if (missing) throw new Error(`${missing} item${missing === 1 ? ' is' : 's are'} not ticked yet`);
      st.checks.signedOff = { by: str(m.name, 40) || who, at: Date.now() };
      log({ device: 'crew', level: 'cmd', msg: `show night checklist signed off by ${st.checks.signedOff.by}`, t: Date.now() });
    },
    'checks-reset'() { st.checks = { started: Date.now(), ticks: {}, signedOff: null }; },
    // Manual cue light for one role (for moments that aren't in the cue list).
    light(m) {
      if (!conf().roles.includes(m.role)) throw new Error(`No crew role "${m.role}"`);
      if (m.state === 'standby' || m.state === 'go') st.lights[m.role] = { state: m.state, at: Date.now() };
      else delete st.lights[m.role];
      if (m.state === 'go') broadcast({ t: 'crew-go', roles: [m.role], at: Date.now() });
    },
    'standby-ack'(m, who) {
      if (st.acks.index !== show.index) st.acks = { index: show.index, roles: {} };
      st.acks.roles[str(m.role, 120)] = { name: str(m.name, 40) || who, at: Date.now() };
      if (st.lights[m.role]?.state === 'standby') st.lights[m.role].acked = Date.now();
    },
    conf(m, who) {
      const patch = {};
      if (m.roles) patch.roles = list(m.roles, 40);
      if (m.depts) patch.depts = list(m.depts, 20);
      if (m.checklist) { patch.checklist = list(m.checklist, 80); st.checks.ticks = {}; st.checks.signedOff = null; }
      saveConf(patch, who, 'crew setup');
    },
    script(m, who) {
      const cur = script();
      const next = { text: m.text != null ? String(m.text).slice(0, 2e6) : cur.text, marks: m.marks && typeof m.marks === 'object' ? m.marks : cur.marks };
      next.marks = Object.fromEntries(Object.entries(next.marks).map(([k, v]) => [str(k, 20), Math.max(0, Math.floor(Number(v)))]).filter(([k, v]) => k && Number.isFinite(v)));
      saveConf({ script: next }, who, 'script');
      broadcast({ t: 'crew-script', script: next });
    },
    'cue-note'(m, who) {
      const i = Number(m.index);
      if (!show.cues[i]) throw new Error('No such cue');
      const cues = JSON.parse(JSON.stringify(show.cues));
      cues[i].note = str(m.note, 300);
      if (!cues[i].note) delete cues[i].note;
      saveCues(cues, who);
      showChanged();
    },
  };

  return {
    snapshot, script,
    // Handles a { t: 'crew', op } message; returns what to reply with.
    handle(m, who) {
      const fn = ops[m.op];
      if (!fn) throw new Error(`unknown crew request "${m.op}"`);
      fn(m, who);
      changed();
      return { ok: true };
    },
    // A cue was fired: the crew whose task is on it get a green GO light.
    fired(i) {
      const roles = [...new Set((show.cues[i]?.crew || []).map(x => x.role))];
      for (const r of roles) delete st.lights[r];
      broadcast({ t: 'crew-go', index: i, roles, at: Date.now() });
      changed();
    },
  };
};
