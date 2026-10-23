// Rehearsal jump: go to any point in the show and set the equipment to match, without running
// every cue in between. It replays, per device, the last thing the cue list told it to do:
//   lighting   the last Eos cue (snapped with no fade, or with its own fade), then any GOs after it
//   sound      everything playing fades out; the QLab playhead moves to the next sound cue
//   mixer      the last scene, then any level and on/off changes after it
//   cameras    the last preset, power and tally
//   projectors the last power, shutter, input and freeze
//   house      the last look or level
// Anything it can't safely repeat (macros, command lines, unknown equipment) is listed, not run.
const STATEFUL = {
  'yamaha-tf': { scene: () => 'scene', level: a => `level:${a.args?.strip}:${a.args?.index}`, on: a => `on:${a.args?.strip}:${a.args?.index}` },
  ptz: { preset: () => 'preset', home: () => 'preset', power: () => 'power', tally: () => 'tally' },
  panasonic: { power: () => 'power', shutter: () => 'shutter', input: () => 'input', freeze: () => 'freeze' },
  pjlink: { power: () => 'power', shutter: () => 'shutter', input: () => 'input' },
  eos: { sub: a => `sub:${a.args?.sub}`, chan: a => `chan:${a.args?.chan}` },
  house: { houseLook: () => 'level', houseLevel: () => 'level' },
};
const IGNORE = { ptz: ['move', 'zoom', 'focus', 'store'], panasonic: ['lensHome'], qlab: ['go', 'stop', 'pause', 'resume', 'next', 'previous', 'playhead', 'start', 'panic'] };

module.exports = function rehearsal(ctx) {
  const typeOf = id => ctx.devices.get(id)?.type || ctx.cfg.devices.find(d => d.id === id)?.type;
  const nameOf = id => (ctx.devices.get(id)?.name || id).split(' · ')[0];
  const members = device => (String(device).startsWith('group:') ? ctx.groups().find(g => g.id === device.slice(6))?.members || [] : [device]);
  const cueName = i => { const c = ctx.show.cues[i]; return c ? `cue ${c.number ?? i + 1} (${c.label})` : 'the end'; };

  // What a jump to cue `index` does. mode "before": ready to GO that cue; "look": as if it had just run.
  function plan(index, mode = 'before', snap = true) {
    const cues = ctx.show.cues;
    if (!(index >= 0 && index < cues.length)) throw new Error('Pick a cue to jump to.');
    const upto = mode === 'look' ? index : index - 1;
    const state = new Map();  // device → Map(key → action), in the order they last happened
    const eos = new Map();    // eos device → { cue action, gos }
    const skipped = [];
    for (let i = 0; i <= upto; i++) {
      for (const a of cues[i].actions || []) {
        for (const id of members(a.device)) {
          const type = typeOf(id), x = { ...a, device: id, delay: 0 };
          if (type === 'eos' && a.cmd === 'cue') { eos.set(id, { cue: x, gos: 0, from: i }); continue; }
          if (type === 'eos' && (a.cmd === 'go' || a.cmd === 'back')) {
            const e = eos.get(id);
            if (e) e.gos = Math.max(0, e.gos + (a.cmd === 'go' ? 1 : -1)); else skipped.push(`${nameOf(id)} ${a.cmd.toUpperCase()} with no cue number before it (${cueName(i)})`);
            continue;
          }
          if (IGNORE[type]?.includes(a.cmd)) continue;
          const key = STATEFUL[type]?.[a.cmd]?.(x);
          if (!key) { skipped.push(`${nameOf(id)} ${a.cmd} (${cueName(i)})`); continue; }
          const st = state.get(id) || new Map();
          if (type === 'yamaha-tf' && key === 'scene') st.clear(); // a scene recall resets the levels before it
          st.delete(key); st.set(key, x);
          state.set(id, st);
        }
      }
    }
    const steps = [];
    for (const [id, e] of eos) {
      const { list = 1, cue } = e.cue.args || {};
      const first = snap ? { device: id, cmd: 'cmdline', args: { text: `Go_To_Cue ${list}/${cue} Time 0#` } } : e.cue;
      steps.push({ dept: 'lx', text: `${nameOf(id)}: cue ${list}/${cue}${snap ? ' with no fade' : ''}${e.gos ? `, then GO ×${e.gos}` : ''}`, actions: [first, ...Array(e.gos).fill({ device: id, cmd: 'go' })], sequence: true });
    }
    for (const [id, st] of state) {
      for (const x of st.values()) {
        const snapped = snap && typeOf(id) === 'house' ? { ...x, args: { ...x.args, fade: 0 } } : x; // house lights snap with the lighting
        steps.push({ dept: ctx.depts?.deptOf(id), text: actionWords(x), actions: [snapped] });
      }
    }
    // Sound doesn't "track": fade out what is playing and line QLab up with the next sound cue.
    for (const d of [...ctx.devices.values()].filter(d => d.type === 'qlab')) {
      let next = null;
      for (let i = upto + 1; i < cues.length && !next; i++) next = (cues[i].actions || []).find(a => a.device === d.id && a.cmd === 'start');
      steps.push({ dept: 'snd', text: `${nameOf(d.id)}: fade out everything playing${next ? `, playhead to Q${next.args?.cue}` : ''}`,
        actions: [{ device: d.id, cmd: 'panic' }, ...(next ? [{ device: d.id, cmd: 'playhead', args: { cue: next.args?.cue } }] : [])], sequence: true });
    }
    return { index, mode, snap, target: cueName(index), standby: mode === 'look' ? index + 1 : index, steps, skipped: [...new Set(skipped)] };
  }
  function actionWords(a) {
    const n = nameOf(a.device), x = a.args || {};
    switch (a.cmd) {
      case 'scene': return `${n}: scene ${String(x.bank || 'a').toUpperCase()}${x.scene}`;
      case 'level': return `${n}: ${x.strip} ${x.index} at ${x.db} dB`;
      case 'on': return `${n}: ${x.strip} ${x.index} ${x.on ? 'on' : 'off'}`;
      case 'preset': return `${n}: preset ${x.preset}`;
      case 'home': return `${n}: home`;
      case 'shutter': return `${n}: shutter ${x.closed ? 'closed' : 'open'}`;
      case 'power': return `${n}: power ${x.on ? 'on' : 'off'}`;
      case 'input': return `${n}: input ${x.input}`;
      case 'freeze': return `${n}: freeze ${x.on ? 'on' : 'off'}`;
      case 'tally': return `${n}: tally ${x.on ? 'on' : 'off'}`;
      case 'sub': return `${n}: sub ${x.sub} at ${Math.round(Number(x.level) * 100)}%`;
      case 'chan': return `${n}: channel ${x.chan} at ${x.level}`;
      case 'houseLook': return `${n}: ${ctx.house?.look(x.look)?.name || x.look}`;
      case 'houseLevel': return `${n}: ${x.level}%`;
      default: return `${n}: ${a.cmd}`;
    }
  }
  const pub = p => ({ ...p, steps: p.steps.map(({ actions, sequence, ...s }) => s) });

  ctx.handlers['jump-preview'] = m => pub(plan(Number(m.index), m.mode, m.snap !== false));
  ctx.handlers['jump'] = async (m, ws) => {
    const p = plan(Number(m.index), m.mode, m.snap !== false);
    const who = m.name || ws.who;
    ctx.log({ device: 'show', level: 'go', msg: `JUMP to ${p.target}${p.mode === 'look' ? ' (as if it had just run)' : ' (ready to GO it)'} by ${who}`, t: Date.now() });
    const run = async s => {
      const out = [];
      for (const [k, a] of s.actions.entries()) {
        if (s.sequence && k) await new Promise(r => setTimeout(r, 250));
        out.push(...await ctx.runAction(a, `jump by ${who}`).catch(e => [{ device: a.device, name: a.device, outcome: 'not_sent', detail: e.message }]));
      }
      return out;
    };
    const results = (await Promise.all(p.steps.map(run))).flat();
    ctx.show.index = p.standby;
    ctx.show.lastFired = p.mode === 'look' ? p.index : p.index > 0 ? p.index - 1 : null;
    ctx.saveState();
    ctx.broadcast({ t: 'show', show: ctx.showSnapshot() });
    const problems = results.filter(r => !['ok', 'accepted', 'sent'].includes(r.outcome)).map(r => `${nameOf(r.device)}: ${r.outcome.replace('_', ' ')}${r.detail ? ` (${r.detail})` : ''}`);
    ctx.events.emit('jump', { index: p.standby, target: p.index, mode: p.mode, who, at: Date.now(), problems });
    return { ...pub(p), problems };
  };
};
