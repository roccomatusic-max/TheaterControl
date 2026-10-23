// Who may do what. Each role has its own PIN, set on the System tab (the admin PIN is the one on the
// Setup screen):
//   admin    everything, including equipment setup, PINs and phone alerts
//   operator runs the show: GO, cues, device controls, STOP, editing cues, show lock
//   viewer   watches only (crew phones, the house manager)
// No PINs at all (the default) means no sign-in and everyone is admin. With "crew can watch without
// a PIN" on, anyone on the network can join as a viewer.
const PIN_RE = /^[A-Za-z0-9]{0,12}$/;
const RANK = { viewer: 0, operator: 1, admin: 2 };

module.exports = function access(ctx) {
  const pins = () => {
    const s = ctx.settings().server || {};
    return { admin: String(process.env.SHOW_PIN || s.pin || ''), operator: String(s.operatorPin || ''), viewer: String(s.viewerPin || ''), openViewing: !!s.openViewing };
  };
  // Requests a viewer may make (read-only). Other features add theirs with ctx.access.viewerMay(type).
  const viewerOk = new Set(['health-get', 'preshow-check', 'versions-list', 'backups-get']);
  // Requests only an admin may make.
  const adminOnly = new Set(['setup-get', 'setup-test', 'setup-save', 'autostart', 'alerts-phone', 'access-get', 'access-set', 'backups-set', 'backups-browse']);

  ctx.access = {
    required: () => { const p = pins(); return !!(p.admin || p.operator || p.viewer); },
    hint: () => ({ watch: pins().openViewing }),
    roleFor(pin) {
      const p = pins(), s = String(pin ?? '');
      if (!this.required()) return 'admin';
      if (s && s === p.admin) return 'admin';
      if (s && s === p.operator) return 'operator';
      if (s && s === p.viewer) return 'viewer';
      if (!s && p.openViewing) return 'viewer';
      return null;
    },
    viewerMay: t => viewerOk.add(t),
    adminOnly: t => adminOnly.add(t),
    atLeast: (ws, role) => RANK[ws.role || 'admin'] >= RANK[role],
  };

  // Crew phones and the front-of-house screen sign in with the crew PIN: they may answer cue lights,
  // send calls, sign off checklist items and set the house status, but not change the script.
  const viewerCrew = m => m.t === 'crew' && m.op !== 'script';

  ctx.guards.push((m, ws) => {
    const role = ws.role || 'admin';
    if (role === 'admin') return;
    if (role === 'viewer' && !viewerOk.has(m.t) && !viewerCrew(m)) throw new Error('This screen is signed in to watch only. Sign in with the operator PIN to control the show.');
    if (adminOnly.has(m.t)) throw new Error('Only the admin PIN can change this.');
  });

  ctx.handlers['access-get'] = () => { const p = pins(); return { pin: p.admin, operatorPin: p.operator, viewerPin: p.viewer, openViewing: p.openViewing, envPin: !!process.env.SHOW_PIN }; };
  ctx.handlers['access-set'] = m => {
    const next = { pin: String(m.pin ?? '').trim(), operatorPin: String(m.operatorPin ?? '').trim(), viewerPin: String(m.viewerPin ?? '').trim(), openViewing: !!m.openViewing };
    for (const [k, label] of [['pin', 'admin'], ['operatorPin', 'operator'], ['viewerPin', 'crew']]) {
      if (!PIN_RE.test(next[k])) throw new Error(`The ${label} PIN can be up to 12 letters or numbers`);
    }
    if (!next.pin && (next.operatorPin || next.viewerPin || next.openViewing)) throw new Error('Set an admin PIN first, so someone can always change these settings.');
    const used = [next.pin, next.operatorPin, next.viewerPin].filter(Boolean);
    if (new Set(used).size !== used.length) throw new Error('Each PIN must be different');
    const cur = ctx.settings();
    ctx.saveSettings({ server: { ...(cur.server || {}), ...next } });
    ctx.log({ device: 'core', level: 'cmd', msg: `PINs changed (${['admin', next.operatorPin && 'operator', next.viewerPin && 'crew'].filter(Boolean).join(', ')}${next.openViewing ? ', crew can watch without a PIN' : ''})`, t: Date.now() });
    return ctx.handlers['access-get']();
  };
  ctx.initExtras.push(ws => ({ role: ws.role || 'admin', signin: ctx.access.required() }));
};
