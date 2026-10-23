// Training mode: new operators practise on a copy of the real show, with pretend equipment.
// "Start training" (System > Training) copies the show file (cue list, equipment names, mic plot,
// settings and PINs) into "Show Control/Training", points each piece of equipment at a simulator of
// the same kind (or a stand-in that says yes to everything, drivers/pretend.js) and restarts in
// training mode (launcher/plan.js). Nothing real is controlled, and changes made while training stay
// in the copy. The trainer can make equipment stop answering, or refuse its next command, to
// practise the alerts. "End training" goes back to the real show, where it was.
const fs = require('fs');
const path = require('path');

// Not while training: these would change the real show or this computer's set-up.
const NOT_IN_TRAINING = {
  'setup-save': 'change the equipment setup', 'failover-set': 'set up the backup computer', 'failover-takeover': 'take over the show',
  autostart: 'change start-up settings', 'training-start': 'start training again',
  'shows-switch': 'switch shows', 'shows-new': 'start a new show', 'shows-import': 'add a show', 'shows-delete': 'delete a show',
  'update-install': 'update Show Control', 'update-back': 'change the Show Control version', 'update-upload': 'update Show Control',
};

module.exports = function training(ctx) {
  const on = ctx.MODE === 'training';
  const file = path.join(ctx.HOME_DIR, 'Training', 'show.json'); // read at start-up by server/index.js
  const real = () => ctx.readJson(ctx.REAL_PATH, null);
  const trouble = new Map(); // device id → 'down' | 'fail' (set by the trainer)
  const gear = () => [...ctx.devices.values()].filter(d => !d.virtual && d.type !== 'mics');
  const publish = () => ctx.broadcast({ t: 'training', training: info() });

  // The training copy: each piece of equipment talks to a simulator of the same kind instead
  // (several of one kind share it), or to a stand-in. The backup computer, phone alerts and the
  // report going to the phone are off.
  function copyOf(show) {
    const sims = ctx.readJson(process.env.SHOW_SIM_CONFIG || path.join(__dirname, '../../config/show.sim.json'), { devices: [] }).devices || [];
    const used = {};
    const devices = (show.devices || []).map(d => {
      const same = sims.filter(s => s.type === d.type);
      if (!same.length) {
        return { id: d.id, name: d.name, type: 'pretend', as: d.type, ...(d.profile ? { profile: d.profile } : {}), ...(d.enabled === false ? { enabled: false } : {}) };
      }
      const { id, name, ...sim } = same[(used[d.type] = (used[d.type] ?? -1) + 1) % same.length];
      return { ...d, ...sim };
    });
    const { training: _, failover: __, ...rest } = show;
    return { ...rest, devices, alerts: { ...(show.alerts || {}), on: false }, reports: { ...(show.reports || {}), phone: false } };
  }

  function info() {
    const t = real()?.training || {};
    return {
      on, mode: ctx.MODE, can: ctx.MODE === 'live' || ctx.MODE === 'direct', since: on ? t.since : null, by: on ? t.by : null,
      devices: on ? gear().map(d => ({ id: d.id, name: d.name, type: d.type, stand: d.cfg.type === 'pretend' ? 'pretend' : 'sim', trouble: trouble.get(d.id) || null })) : [],
    };
  }

  ctx.handlers['training-get'] = () => info();
  ctx.handlers['training-start'] = (m, ws) => {
    if (ctx.MODE === 'practice') throw new Error('Practice mode already uses pretend equipment, so new operators can practise right here.');
    if (ctx.MODE !== 'live' && ctx.MODE !== 'direct') throw new Error('Training mode is not available here.');
    const show = real();
    if (!show) throw new Error('The show file could not be read.');
    // A fresh start: the copy starts at the top of the show, unlocked, with its own cue list history.
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) if (f.startsWith('.show.')) fs.rmSync(path.join(dir, f), { force: true });
    fs.rmSync(path.join(dir, 'Cue list history'), { recursive: true, force: true });
    ctx.writeJson(file, copyOf(show));
    const by = ctx.screenName?.(ws.who) || ws.who;
    ctx.writeJson(ctx.REAL_PATH, { ...show, training: { on: true, since: Date.now(), by } });
    ctx.restart(`training mode started by ${by}`);
    return { restarting: true };
  };
  ctx.handlers['training-stop'] = (m, ws) => {
    if (!on) throw new Error('Training mode is not on.');
    const show = real();
    if (show) ctx.writeJson(ctx.REAL_PATH, { ...show, training: { ...(show.training || {}), on: false, ended: Date.now() } });
    ctx.restart(`training mode ended by ${ws.who}`);
    return { restarting: true };
  };

  // The trainer makes equipment misbehave: "down" stops it answering until "fixed"; "fail" makes it
  // refuse its next command.
  ctx.handlers['training-trouble'] = m => {
    if (!on) throw new Error('Only in training mode.');
    const d = ctx.devices.get(m.device);
    if (!d || d.virtual) throw new Error('No such equipment.');
    delete d.command; delete d.seen; delete d.setStatus; trouble.delete(d.id);
    if (m.what === 'down') {
      d.setStatus('offline');
      d.seen = () => {}; d.setStatus = () => {};
      d.command = async () => { throw new Error('not answering'); };
      trouble.set(d.id, 'down');
    } else if (m.what === 'fail') {
      d.command = async () => {
        delete d.command; trouble.delete(d.id); publish();
        return { outcome: 'rejected', detail: 'the equipment refused the command (training)' };
      };
      trouble.set(d.id, 'fail');
    } else d.seen();
    ctx.log({ device: d.id, level: 'warn', msg: `training: ${{ down: 'stops answering', fail: 'will refuse its next command' }[m.what] || 'back to normal'}`, t: Date.now() });
    publish();
    return info();
  };
  for (const t of ['training-start', 'training-stop', 'training-trouble']) ctx.access?.adminOnly(t);

  if (on) {
    ctx.guards.push(m => {
      const what = NOT_IN_TRAINING[m.t];
      if (what) throw new Error(`This is training mode, so you can't ${what}. End training first (System > Training).`);
    });
    ctx.checks.push(() => [{ group: 'This computer', label: 'Training mode', state: 'warn', detail: 'Pretend equipment: nothing real is controlled. End training from System > Training.' }]);
  }
  ctx.initExtras.push(() => ({ training: on ? { since: real()?.training?.since || null, by: real()?.training?.by || '' } : null }));
};
