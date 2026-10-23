// System > Shows: several shows on one computer (server/library.js). Keep a copy of this show under
// another name, switch to another show, start a new show with the same equipment, download a show to
// take to another computer, and add one from a file. For the real show file (live, or run directly);
// practice mode has its own copy of the show.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const lib = require('../library');

module.exports = function shows(ctx) {
  const dir = path.join(ctx.HOME_DIR, 'Shows');
  const here = ctx.MODE === 'live' || ctx.MODE === 'direct';
  const current = () => lib.read(ctx.SAVE_PATH, null) || ctx.cfg;
  const same = (a, b) => lib.safe(a).toLowerCase() === lib.safe(b).toLowerCase(); // Mac and Windows ignore case in file names
  const inLibrary = name => lib.list(dir).find(s => same(s.name, name));
  const taken = name => same(name, lib.nameOf(current())) || !!inLibrary(name);
  const need = () => { if (!here) throw new Error('Several shows are for your real show: set up your real equipment and go live first.'); };
  function newName(name) {
    const n = String(name ?? '').trim();
    if (!n) throw new Error('Give the show a name.');
    if (lib.safe(n) !== n) throw new Error('A show\'s name can\'t start with a dot or contain / \\ : * ? " < > |, and is at most 60 letters.');
    if (taken(n)) throw new Error(`There is already a show called "${n}".`);
    return n;
  }
  const log = msg => ctx.log({ device: 'show', level: 'cmd', msg, t: Date.now() });

  function info() {
    const cur = current(), name = lib.nameOf(cur);
    return {
      here, mode: ctx.MODE, current: { name, cues: (cur.show?.cues || []).length, devices: (cur.devices || []).filter(d => d.enabled !== false).length },
      list: lib.list(dir).filter(s => !same(s.name, name)), last: lib.last(dir), folder: dir,
    };
  }

  ctx.handlers['shows-get'] = () => info();
  ctx.handlers['shows-switch'] = (m, ws) => {
    need();
    const to = inLibrary(m.name);
    if (!to || same(to.name, lib.nameOf(current()))) throw new Error('That show is not in the list.');
    lib.ask(dir, { action: 'switch', name: to.name, by: ws.who });
    ctx.restart(`switching to the show "${to.name}" (asked by ${ws.who})`);
    return { restarting: true };
  };
  ctx.handlers['shows-new'] = (m, ws) => {
    need();
    const name = newName(m.name), keep = m.keep === 'all' ? 'all' : 'equipment';
    lib.ask(dir, { action: 'new', name, keep, by: ws.who });
    ctx.restart(`starting a new show "${name}" with ${keep === 'all' ? 'a copy of everything' : 'the same equipment'} (asked by ${ws.who})`);
    return { restarting: true };
  };
  ctx.handlers['shows-copy'] = (m, ws) => {
    need();
    const name = newName(m.name), cur = lib.strip(current());
    lib.write(lib.entry(dir, name), { ...cur, show: { ...(cur.show || {}), name } });
    log(`a copy of the show was kept as "${name}" by ${ws.who}`);
    return info();
  };
  ctx.handlers['shows-delete'] = (m, ws) => {
    need();
    const s = inLibrary(m.name);
    if (!s || same(s.name, lib.nameOf(current()))) throw new Error('That show is not in the list.');
    fs.rmSync(path.join(dir, s.file), { force: true });
    fs.rmSync(path.join(dir, s.file.replace(/\.json$/, '.state')), { recursive: true, force: true });
    log(`the show "${s.name}" was deleted by ${ws.who}`);
    return info();
  };
  // A show file from another computer (downloaded from Shows there), as text.
  ctx.handlers['shows-import'] = (m, ws) => {
    need();
    const text = String(m.text ?? '');
    if (text.length > 20e6) throw new Error('That file is too big to be a show file.');
    let s; try { s = JSON.parse(text); } catch { s = null; }
    if (!lib.valid(s)) throw new Error('That file isn\'t a Show Control show file.');
    const base = lib.safe(m.name || lib.nameOf(s)) || 'Show';
    let name = base;
    for (let k = 2; taken(name); k++) name = `${base.slice(0, 55)} ${k}`;
    lib.write(lib.entry(dir, name), { ...lib.strip(s), show: { ...s.show, name } });
    log(`the show "${name}" was added from a file by ${ws.who}`);
    return { ...info(), added: name };
  };

  // Download: a link that works for 15 minutes. The file has no PINs or other settings of this computer.
  const links = new Map();
  ctx.routes.push(app => app.get('/shows/:token/:file', (req, res) => {
    const l = links.get(req.params.token);
    if (!l || l.until < Date.now()) return res.status(404).type('text').send('This link has expired. Download the show again from Show Control.');
    const s = l.name === null ? current() : lib.read(lib.entry(dir, l.name));
    if (!lib.valid(s)) return res.status(404).type('text').send('That show is no longer there.');
    res.type('json').setHeader('Content-Disposition', `attachment; filename="${lib.safe(lib.nameOf(s)).replace(/[^A-Za-z0-9 ._-]/g, '') || 'Show'}.json"`);
    res.send(JSON.stringify(lib.strip(s), null, 2));
  }));
  ctx.handlers['shows-link'] = m => {
    need();
    const s = !m.name || same(m.name, lib.nameOf(current())) ? null : inLibrary(m.name);
    if (m.name && !same(m.name, lib.nameOf(current())) && !s) throw new Error('That show is not in the list.');
    const token = crypto.randomBytes(12).toString('hex');
    for (const [k, v] of links) if (v.until < Date.now()) links.delete(k);
    links.set(token, { name: s ? s.name : null, until: Date.now() + 15 * 60e3 });
    return { url: `/shows/${token}/${encodeURIComponent(lib.safe(s ? s.name : lib.nameOf(current())) || 'Show')}.json` };
  };
  for (const t of ['shows-switch', 'shows-new', 'shows-copy', 'shows-delete', 'shows-import', 'shows-link']) ctx.access?.adminOnly(t);

  // Say what happened at start-up when this run began with a switch.
  const l = lib.last(dir);
  if (l && Date.now() - l.done < 60e3) {
    ctx.events.once('listening', () => ctx.log({ device: 'show', level: l.error ? 'error' : 'cmd', msg: l.error ? `could not switch shows: ${l.error}` : `now running the show "${l.name}"${l.from ? ` (was "${l.from}")` : ''}`, t: Date.now() }));
  }
};
