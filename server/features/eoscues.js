// The lighting console's own cue list, mirrored on the Lighting tab: every cue with its label,
// times, follow, scene and notes, and which cue is live and which is pending. It is read again
// when the console says its cues changed, when another show is loaded, and on request.
// It also checks the show's cue list against it (a show cue firing a lighting cue the console
// doesn't have is a pre-show check warning), and can add the console's cues to the show's list.
module.exports = function eosCues(ctx) {
  const eos = () => [...ctx.devices.values()].find(d => d.type === 'eos' && typeof d.getList === 'function');
  const norm = x => (x === '' || x == null || isNaN(x) ? String(x ?? '') : String(Number(x)));
  const sec = ms => (Number(ms) >= 0 ? Math.round(Number(ms) / 100) / 10 : null);
  // The show's cues that fire a numbered lighting cue: { i, list, cue }
  const refs = d => ctx.show.cues.flatMap((c, i) => (c.actions || []).filter(a => a.device === d.id && a.cmd === 'cue' && a.args?.cue !== '' && a.args?.cue != null)
    .map(a => ({ i, list: Number(a.args.list ?? 1) || 1, cue: norm(a.args.cue) })));

  let mirror = { device: null, lists: {}, at: 0, error: null };
  let busy = null, again = false;
  async function refresh() {
    const d = eos();
    if (!d) return mirror;
    if (busy) { again = true; return busy; }
    busy = (async () => {
      const lists = [...new Set([1, ...refs(d).map(r => r.list)])].sort((a, b) => a - b);
      try {
        const out = {};
        for (const list of lists) {
          // uid, label, up time, up delay, down time, down delay, focus/colour/beam times and delays,
          // preheat, curve, rate, mark, block, assert, link, follow time, hang time, all fade, loop,
          // solo, timecode, part count, notes, scene, scene end (times in milliseconds, -1 when not set)
          out[list] = (await d.getList(`cue/${list}`)).map(({ number, args: x }) => ({
            number: norm(number), label: String(x[1] ?? ''), up: sec(x[2]), down: sec(x[4]),
            follow: sec(x[19]), hang: sec(x[20]), block: !!x[16] && x[16] !== 'F', mark: !!x[15] && x[15] !== 'F',
            parts: Number(x[25]) || 0, notes: String(x[26] ?? ''), scene: String(x[27] ?? ''),
          }));
        }
        mirror = { device: d.id, lists: out, at: Date.now(), error: null };
      } catch (e) {
        mirror = { ...mirror, device: d.id, error: e.message };
      }
      ctx.broadcast({ t: 'eos-cues', eosCues: mirror });
      busy = null;
      if (again) { again = false; return refresh(); }
      return mirror;
    })();
    return busy;
  }
  let soon = null;
  const refreshSoon = (ms = 1500) => { clearTimeout(soon); soon = setTimeout(refresh, ms); };
  for (const d of ctx.devices.values()) {
    if (d.type !== 'eos') continue;
    let was = d.status;
    d.on('changed', () => { if (d.status === 'online' && was !== 'online') refreshSoon(500); was = d.status; });
    d.on('cues-changed', () => refreshSoon());
  }
  // a show cue now points at another lighting cue list: read that one too
  ctx.events.on('cues-saved', () => {
    const d = eos();
    if (d && refs(d).some(r => !mirror.lists[r.list])) refreshSoon(200);
  });

  ctx.handlers['eos-cues-get'] = () => mirror;
  ctx.handlers['eos-cues-refresh'] = async () => {
    if (!eos()) throw new Error('No Eos console in the equipment list.');
    const r = await refresh();
    if (r.error) throw new Error(r.error);
    return r;
  };
  // Adds the console's cues (by number, from one list) to the show's cue list, each where it
  // belongs among the show cues that already fire a lighting cue from that list.
  ctx.handlers['eos-import'] = (m, ws) => {
    const d = eos();
    if (!d) throw new Error('No Eos console in the equipment list.');
    const list = Number(m.list ?? 1) || 1;
    const have = new Set(refs(d).filter(r => r.list === list).map(r => r.cue));
    const want = new Set((m.numbers || []).map(norm));
    const adding = (mirror.lists[list] || []).filter(c => want.has(c.number) && !have.has(c.number));
    if (!adding.length) throw new Error('Those cues are already in the show\'s cue list.');
    const cues = JSON.parse(JSON.stringify(ctx.show.cues));
    const lxCue = c => {
      const a = (c.actions || []).find(x => x.device === d.id && x.cmd === 'cue' && (Number(x.args?.list ?? 1) || 1) === list);
      return a && !isNaN(a.args?.cue) && a.args.cue !== '' ? Number(a.args.cue) : null;
    };
    let lastScene = null;
    for (const ec of adding) {
      const n = Number(ec.number);
      let before = -1, after = -1;
      cues.forEach((c, i) => { const x = lxCue(c); if (x == null) return; if (x < n) before = i; else if (after < 0) after = i; });
      const at = before >= 0 ? before + 1 : after >= 0 ? after : cues.length;
      const scene = ec.scene && ec.scene !== lastScene ? ec.scene : '';
      if (ec.scene) lastScene = ec.scene;
      cues.splice(at, 0, { number: isNaN(ec.number) ? ec.number : n, label: ec.label || `Lighting cue ${ec.number}`, ...(scene ? { scene } : {}),
        ...(ec.notes ? { note: ec.notes } : {}), actions: [{ device: d.id, cmd: 'cue', args: { list, cue: ec.number } }] });
    }
    ctx.saveCues(cues, ws.who, `added ${adding.length} lighting cue${adding.length > 1 ? 's' : ''} from ${d.name}`);
    ctx.broadcast({ t: 'show', show: ctx.showSnapshot() });
    return { added: adding.length };
  };
  ctx.access?.viewerMay('eos-cues-get');

  ctx.checks.push(async () => {
    const d = eos();
    if (!d) return [];
    const r = refs(d);
    if (!r.length) return [];
    if (d.status === 'online' && Date.now() - mirror.at > 60e3) await refresh(); // read it fresh
    const base = { group: 'Show', label: 'Lighting cues' };
    if (!mirror.at) return [{ ...base, state: 'warn', detail: `Couldn't read the cue list from ${d.name}${mirror.error ? ` (${mirror.error})` : ''}, so the show's lighting cues weren't checked.` }];
    const missing = r.filter(x => mirror.lists[x.list] && !mirror.lists[x.list].some(c => c.number === x.cue));
    const name = x => `${x.list}/${x.cue} (show cue ${ctx.show.cues[x.i].number ?? x.i + 1} ${ctx.show.cues[x.i].label})`;
    if (missing.length) return [{ ...base, state: 'warn', detail: `Not on ${d.name}: ${missing.slice(0, 5).map(name).join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}. Those GOs will do nothing on the lights.` }];
    const total = Object.values(mirror.lists).reduce((n, l) => n + l.length, 0);
    return [{ ...base, state: 'ok', detail: `All ${r.length} lighting cues the show fires are on ${d.name} (${total} cues read ${Math.round((Date.now() - mirror.at) / 60000)} min ago).` }];
  });
  ctx.initExtras.push(() => ({ eosCues: mirror }));
  ctx.eosCues = { mirror: () => mirror, refresh };
};
