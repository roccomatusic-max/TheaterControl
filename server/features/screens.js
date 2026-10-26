// Screens: every iPad, phone or computer using Show Control has a name and tells the server what it
// is showing. A spare iPad can carry on exactly where a broken or flat one left off: same name, same
// tab, same camera and projector group. (Cue position, timers and everything else already live on
// the show computer, so any screen sees the same show.)
module.exports = function screens(ctx) {
  const list = new Map(); // id → { id, name, role, who, view, sockets, connected, lastSeen }
  // limit: the most this screen may do (System > Screens; features/access.js)
  const pub = () => [...list.values()].map(({ sockets, ...s }) => ({ ...s, limit: ctx.access?.screenLimit?.(s.id) || 'admin' })).sort((a, b) => b.connected - a.connected || b.lastSeen - a.lastSeen);
  const publish = () => ctx.broadcast({ t: 'screens', screens: pub() });
  const clean = (v, n) => String(v ?? '').trim().slice(0, n);

  ctx.handlers['screen-hello'] = (m, ws) => {
    const id = clean(m.screen, 40); // ("id" is the request number)
    if (!/^[A-Za-z0-9_-]{4,40}$/.test(id)) throw new Error('bad screen id');
    const s = list.get(id) || { id, sockets: new Set() };
    s.sockets.add(ws);
    Object.assign(s, { name: clean(m.name, 40) || s.name || 'Screen', role: ws.role || 'admin', who: ws.who, view: m.view && typeof m.view === 'object' ? m.view : s.view || {}, connected: true, lastSeen: Date.now() });
    list.set(id, s);
    if (ws.screenId !== id) {
      ws.screenId = id;
      ws.once('close', () => {
        s.sockets.delete(ws);
        if (!s.sockets.size && list.get(id) === s) { s.connected = false; s.lastSeen = Date.now(); publish(); }
      });
    }
    publish();
    return { ok: true };
  };
  ctx.handlers['screens-list'] = () => pub();
  // The name of the screen at this address, for logs and reports ("Rocco's iPad" rather than an IP).
  ctx.screenById = id => list.get(id)?.name;
  ctx.screenName = who => [...list.values()].find(s => s.connected && s.who === who)?.name;
  // This screen carries on from another one: it gets that screen's name and view, and the other one
  // is forgotten (if it comes back, it joins as itself again).
  ctx.handlers['screen-takeover'] = (m, ws) => {
    const from = list.get(clean(m.from, 40));
    if (!from) throw new Error('That screen is no longer listed.');
    if (from.connected && !m.force) throw new Error(`${from.name} is still connected. Carry on from it anyway?`);
    ctx.access?.carryLimit?.(from.id, ws);
    list.delete(from.id);
    const me = list.get(ws.screenId);
    if (me) { me.name = from.name; me.view = from.view; }
    ctx.log({ device: 'core', level: 'cmd', msg: `${ws.who} carries on from ${from.name}`, t: Date.now() });
    publish();
    return { name: from.name, view: from.view || {} };
  };
  ctx.handlers['screen-forget'] = m => { list.delete(clean(m.screen, 40)); publish(); return { ok: true }; };
  for (const t of ['screen-hello', 'screens-list', 'screen-takeover']) ctx.access?.viewerMay(t);
  ctx.events.on('screen-limits', publish);
  ctx.initExtras.push(() => ({ screens: pub() }));
};
