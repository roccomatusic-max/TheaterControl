// Who may do what. Each role has its own PIN, set on the System tab (the admin PIN is the one on the
// Setup screen):
//   admin    everything, including equipment setup, PINs and phone alerts
//   operator runs the show: GO, cues, device controls, STOP, editing cues, show lock
//   viewer   watches only (crew phones, the house manager)
// No PINs at all (the default) means no sign-in and everyone is admin. With "crew can watch without
// a PIN" on, anyone on the network can join as a viewer.
const PIN_RE = /^[A-Za-z0-9]{0,12}$/;
const RANK = { viewer: 0, operator: 1, admin: 2 };
const LIMIT_WORDS = { admin: 'everything', operator: 'run the show', viewer: 'crew and watch only' };

module.exports = function access(ctx) {
  const pins = () => {
    const s = ctx.settings().server || {};
    return { admin: String(process.env.SHOW_PIN || s.pin || ''), operator: String(s.operatorPin || ''), viewer: String(s.viewerPin || ''), openViewing: !!s.openViewing };
  };
  // Requests a viewer may make (read-only). Other features add theirs with ctx.access.viewerMay(type).
  const viewerOk = new Set(['health-get', 'preshow-check', 'versions-list', 'backups-get']);
  // Requests only an admin may make.
  const adminOnly = new Set(['setup-get', 'setup-test', 'setup-discover', 'setup-save', 'autostart', 'alerts-phone', 'access-get', 'access-set', 'backups-set', 'backups-browse']);

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
    // What this iPad or phone may do at most, set per screen on the System tab (System > Screens):
    // e.g. crew phones that should never press GO even when nobody uses PINs. The admin PIN and the
    // show computer itself always get everything, so nobody can be locked out.
    limit(ws, role) {
      if (!ws.screenId || role === 'admin' && this.required() || isLocal(ws.who)) return role;
      const cap = screenLimit(ws.screenId);
      return RANK[cap] < RANK[role] ? cap : role;
    },
    screenLimit: id => screenLimit(id),
    // A spare carrying on from another screen (features/screens.js) takes on that screen's limit
    // too, if it is stricter: a spare for a crew phone is a crew phone; a crew phone can't gain
    // more by carrying on from the stage manager's iPad.
    carryLimit(fromId, ws) {
      if (!ws.screenId || fromId === ws.screenId) return;
      const from = screenLimit(fromId), mine = screenLimit(ws.screenId);
      if (RANK[from] >= RANK[mine]) return;
      const cur = ctx.settings().server || {};
      ctx.saveSettings({ server: { ...cur, screenLimits: { ...(cur.screenLimits || {}), [ws.screenId]: from } } });
      reapply();
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
    const limited = ws.signedInAs && RANK[ws.signedInAs] > RANK[role];
    if (role === 'viewer' && !viewerOk.has(m.t) && !viewerCrew(m)) throw new Error(limited ? 'This screen is set to crew and watch only (System > Screens on the main iPad).' : 'This screen is signed in to watch only. Sign in with the operator PIN to control the show.');
    if (adminOnly.has(m.t)) throw new Error(limited ? 'This screen is set to run the show only, not change the setup (System > Screens on the main iPad).' : 'Only the admin PIN can change this.');
  });

  // Per-screen limits: { screenLimits: { <screen id>: 'operator' | 'viewer' }, newScreens: 'admin' | 'operator' | 'viewer' }
  const isLocal = who => !who || who === '127.0.0.1' || who === '::1';
  const limits = () => { const s = ctx.settings().server || {}; return { map: s.screenLimits || {}, fresh: RANK[s.newScreens] != null ? s.newScreens : 'admin' }; };
  const screenLimit = id => { const l = limits(); return RANK[l.map[id]] != null ? l.map[id] : l.fresh; };
  // Tell every connected screen what it may do now (they redraw with the new role).
  const reapply = () => {
    for (const ws of ctx.clients()) {
      if (!ws.screenId || ws.readonly || !ws.hello) continue;
      const role = ctx.access.limit(ws, ws.signedInAs || 'admin');
      if (role !== ws.role) { ws.role = role; ws.hello(); }
    }
    ctx.events.emit('screen-limits');
  };
  ctx.handlers['screen-limit-set'] = (m, ws) => {
    const cur = ctx.settings().server || {}, map = { ...(cur.screenLimits || {}) };
    let newScreens = cur.newScreens || 'admin';
    if (m.newScreens != null) {
      if (RANK[m.newScreens] == null) throw new Error('Unknown setting');
      newScreens = m.newScreens;
      // the screen making the change keeps full control, so it can undo this
      if (newScreens !== 'admin' && ws.screenId && !map[ws.screenId]) map[ws.screenId] = 'admin';
    }
    if (m.screen != null) {
      const id = String(m.screen);
      if (!/^[A-Za-z0-9_-]{4,40}$/.test(id) || RANK[m.limit] == null) throw new Error('Unknown screen or setting');
      if (id === ws.screenId && m.limit !== 'admin' && !ctx.access.required()) throw new Error('This is the screen you are using: change it from another screen, so you keep a screen with full control.');
      map[id] = m.limit;
    }
    ctx.saveSettings({ server: { ...cur, screenLimits: map, newScreens } });
    ctx.log({ device: 'core', level: 'cmd', msg: m.screen != null ? `screen ${m.name || m.screen} may now: ${LIMIT_WORDS[m.limit]}` : `new screens may: ${LIMIT_WORDS[newScreens]}`, t: Date.now() });
    reapply();
    return { screenLimits: map, newScreens };
  };
  adminOnly.add('screen-limit-set');
  // Pre-show check: crew pages (phones, kiosk cue lights, front of house) that could still press GO.
  ctx.checks.push(() => {
    const crewPages = ['crew', 'foh', 'lobby'];
    const open = (ctx.handlers['screens-list']?.() || []).filter(s => s.connected && crewPages.includes(s.view?.tab) && s.role !== 'viewer');
    if (!open.length) return [];
    return [{ group: 'Show', state: 'warn', label: 'Crew screens',
      detail: `${open.map(s => s.name).slice(0, 4).join(', ')}${open.length > 4 ? ` and ${open.length - 4} more` : ''} can press GO and change things. Set them to "Crew & watch only" on System > Screens.` }];
  });

  // Leaving kiosk mode on a crew screen (public/crew/common.js) needs the admin PIN, when there is one.
  const kioskFails = new Map(); // address → wrong PINs in a row (3 allowed, then a minute's wait)
  ctx.handlers['kiosk-exit'] = (m, ws) => {
    const p = pins(), f = kioskFails.get(ws.who) || { n: 0, until: 0 };
    if (f.until > Date.now()) throw new Error('Too many wrong PINs: try again in a minute.');
    if (p.admin && String(m.pin ?? '') !== p.admin) {
      kioskFails.set(ws.who, { n: f.n + 1, until: f.n + 1 >= 3 ? Date.now() + 60e3 : 0 });
      throw new Error('Wrong PIN: this screen stays in kiosk mode.');
    }
    kioskFails.delete(ws.who);
    return { ok: true };
  };
  viewerOk.add('kiosk-exit');

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
  ctx.initExtras.push(ws => ({ role: ws.role || 'admin', signin: ctx.access.required(), newScreens: limits().fresh,
    screenLimited: !!ws.screenId && ws.role !== (ws.signedInAs || 'admin') }));
};
