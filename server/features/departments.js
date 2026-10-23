// Departments, and the second operator: a deputy runs one department (say sound) from their own
// screen with its own GO, while the main GO runs everything else. The deputy has their own place in
// the cue list: their GO runs that department's part of the next cue that has one.
//
// Each piece of equipment belongs to a department by its type; "dept" on a device in the show file
// overrides that (e.g. a QLab that only runs video: "dept": "proj").
const fs = require('fs');
const path = require('path');

const DEPTS = [
  { id: 'lx', name: 'Lighting', types: ['eos', 'grandma', 'magicq', 'dmx', 'house'] },
  { id: 'snd', name: 'Sound', types: ['qlab', 'yamaha-tf', 'x32', 'allen-heath', 'shure', 'mics'] },
  { id: 'proj', name: 'Projection', types: ['panasonic', 'pjlink'] },
  { id: 'cam', name: 'Cameras', types: ['ptz', 'panasonic-cam', 'camera'] },
  { id: 'other', name: 'Other', types: [] },
];

module.exports = function departments(ctx) {
  const statePath = ctx.STATE_PATH && path.join(path.dirname(ctx.STATE_PATH), `.${path.basename(ctx.SAVE_PATH, '.json')}.depts.json`);
  let split = {}; // dept id → { by, since, index }
  try { split = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { /* none */ }
  const persist = () => { if (statePath) try { ctx.writeJson(statePath, split); } catch { /* not critical */ } };

  const deptOfDevice = id => {
    const dc = ctx.cfg.devices.find(d => d.id === id);
    const d = ctx.devices.get(id);
    if (dc?.dept && DEPTS.some(x => x.id === dc.dept)) return dc.dept;
    if (d?.kind === 'projector') return 'proj';
    return DEPTS.find(x => x.types.includes(dc?.type || d?.type))?.id || 'other';
  };
  const deptOf = device => (String(device).startsWith('group:') ? 'proj' : deptOfDevice(device));
  const actionsFor = (cue, dept) => (cue?.actions || []).filter(a => deptOf(a.device) === dept);
  const nextFor = (dept, from) => { for (let j = Math.max(0, from); j < ctx.show.cues.length; j++) if (actionsFor(ctx.show.cues[j], dept).length) return j; return null; };
  const name = id => DEPTS.find(x => x.id === id)?.name || id;
  // equipment in the show file, plus equipment made by a feature (the house lights)
  const ids = () => [...new Set([...ctx.cfg.devices.map(d => d.id), ...ctx.devices.keys()])];
  const info = () => ({
    list: DEPTS.map(x => ({ id: x.id, name: x.name, devices: ids().filter(id => deptOfDevice(id) === x.id) })),
    split: Object.fromEntries(Object.entries(split).map(([k, v]) => [k, { ...v, next: nextFor(k, v.index) }])),
  });
  const publish = () => { persist(); ctx.broadcast({ t: 'depts', depts: info() }); };
  ctx.depts = { deptOf, actionsFor, name, list: DEPTS };

  // The main GO leaves out departments a second operator is running.
  ctx.heldBack = a => !!split[deptOf(a.device)];

  const check = m => { if (!DEPTS.some(x => x.id === m.dept)) throw new Error('Unknown department'); return m.dept; };
  ctx.handlers['dept-take'] = (m, ws) => {
    const dept = check(m);
    const by = String(m.name || ws.who).trim().slice(0, 40);
    if (split[dept] && split[dept].by !== by && !m.force) throw new Error(`${name(dept)} is already run by ${split[dept].by}. Take it over anyway?`);
    const index = split[dept]?.index ?? ctx.show.index;
    split[dept] = { by, since: Date.now(), index };
    ctx.log({ device: 'show', level: 'cmd', msg: `${name(dept)} is now run by a second operator (${by}); the main GO leaves it out`, t: Date.now() });
    ctx.events.emit('dept', { dept, name: name(dept), by, on: true });
    publish();
    return info();
  };
  ctx.handlers['dept-release'] = (m, ws) => {
    const dept = check(m), s = split[dept];
    if (!s) return info();
    // Cues of this department the deputy hadn't run yet, now behind the main GO, are not run.
    let missed = 0;
    for (let j = s.index; j < ctx.show.index; j++) if (actionsFor(ctx.show.cues[j], dept).length) missed++;
    delete split[dept];
    ctx.log({ device: 'show', level: 'cmd', msg: `${name(dept)} handed back to the main GO by ${m.name || ws.who}${missed ? ` (${missed} of its cues were not run)` : ''}`, t: Date.now() });
    ctx.events.emit('dept', { dept, name: name(dept), by: m.name || ws.who, on: false, missed });
    publish();
    return { ...info(), missed };
  };
  ctx.handlers['dept-go'] = (m, ws) => {
    const dept = check(m), s = split[dept];
    if (!s) throw new Error(`${name(dept)} is run by the main GO at the moment.`);
    const j = nextFor(dept, s.index);
    if (j == null) throw new Error(`No more ${name(dept).toLowerCase()} cues.`);
    const cue = ctx.show.cues[j];
    s.index = j + 1;
    ctx.log({ device: 'show', level: 'go', msg: `${name(dept).toUpperCase()} GO ${cue.number ?? j + 1} ${cue.label} (${s.by})`, t: Date.now() });
    ctx.runCueActions(j, actionsFor(cue, dept), `${s.by} (${name(dept)})`, dept);
    publish();
    return { fired: j };
  };
  ctx.handlers['dept-standby'] = m => {
    const dept = check(m), s = split[dept];
    if (!s) throw new Error(`${name(dept)} is run by the main GO at the moment.`);
    s.index = Math.max(0, Math.min(ctx.show.cues.length, Number(m.index) || 0));
    publish();
    return info();
  };
  ctx.handlers['depts-get'] = () => info();
  ctx.access?.viewerMay('depts-get');

  // Jumping in rehearsal moves everyone; a changed cue list keeps positions in range.
  ctx.events.on('jump', ({ index }) => { for (const s of Object.values(split)) s.index = index; if (Object.keys(split).length) publish(); });
  ctx.events.on('cues-saved', () => { for (const s of Object.values(split)) s.index = Math.min(s.index, ctx.show.cues.length); if (Object.keys(split).length) publish(); });
  ctx.initExtras.push(() => ({ depts: info() }));
};
