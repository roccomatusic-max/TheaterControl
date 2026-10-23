// Show lock: during a performance nobody can change the show by accident, on any screen.
// GO, STOP, standby and the everyday controls (faders, cameras, shutters) keep working. Blocked until
// someone unlocks: editing or restoring cues, equipment setup, switching practice/live, firing a cue
// out of order, resetting timers and powering projectors off. Unlocking needs the operator or admin
// PIN when PINs are set. The lock survives a restart.
const fs = require('fs');

const BLOCKED = {
  'save-cues': 'edit the cue list', 'versions-restore': 'restore an earlier cue list', 'cues-undo': 'undo cue list changes',
  'backups-restore-cues': 'restore a cue list from a backup', 'setup-save': 'change the equipment setup', autostart: 'change start-up settings',
  'access-set': 'change PINs', jump: 'jump to another cue', 'house-set': 'change the house lights setup', 'eos-import': 'edit the cue list',
  'chancheck-start': 'start a channel check',
};

module.exports = function lock(ctx) {
  const file = ctx.STATE_PATH ? ctx.STATE_PATH.replace(/(\.state)?\.json$/, '.lock.json') : '';
  let state = null; // { at, by } while locked
  try { if (file) state = JSON.parse(fs.readFileSync(file, 'utf8')).locked || null; } catch { /* not locked */ }
  const save = () => { if (file) try { ctx.writeJson(file, { locked: state }); } catch { /* best effort */ } };
  const publish = () => ctx.broadcast({ t: 'lock', lock: state });

  ctx.guards.push((m, ws) => {
    if (!state) return;
    let what = BLOCKED[m.t];
    if (m.t === 'show' && m.action === 'fire') what = 'fire a cue out of order (use GO)';
    if (m.t === 'show' && m.action === 'timer' && m.op === 'reset') what = 'reset the timers';
    if (m.t === 'cmd' && m.cmd === 'power' && m.args?.on === false) what = 'switch equipment off';
    if (what) throw new Error(`The show is locked, so you can't ${what}. Tap the lock at the top to unlock it.`);
  });

  ctx.handlers['show-lock'] = (m, ws) => {
    if (m.on) {
      if (!state) { state = { at: Date.now(), by: ws.who }; ctx.log({ device: 'show', level: 'cmd', msg: `show locked by ${ws.who}`, t: state.at }); }
    } else if (state) {
      // With PINs set, unlocking needs a PIN that can run the show (a viewer can't unlock).
      if (ctx.access?.required()) {
        const role = ctx.access.roleFor(m.pin);
        if (!m.pin || !role || role === 'viewer') throw new Error('Wrong PIN. Unlocking needs the operator or admin PIN.');
      }
      ctx.log({ device: 'show', level: 'cmd', msg: `show unlocked by ${ws.who}`, t: Date.now() });
      state = null;
    }
    save(); publish();
    return { lock: state };
  };
  ctx.initExtras.push(() => ({ lock: state }));
  ctx.events.on('mirror-lock', l => { state = l || null; save(); publish(); }); // copied from the main computer
  ctx.checks.push(() => [{ group: 'Show', state: state ? 'ok' : 'info', label: 'Show lock',
    detail: state ? 'Locked: nobody can change the cue list or setup by accident.' : 'Unlocked. Lock the show (lock button at the top) before the performance.',
    ...(state ? {} : { fix: { label: 'Lock the show', msgs: [{ t: 'show-lock', on: true }] } }) }]);
  return { locked: () => !!state };
};
