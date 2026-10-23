// The show library: several shows (productions, venues) on one computer, in "Show Control/Shows".
// Each one is a show file (equipment, cue list, mic plot, ...) and a folder with its running state
// (position, timers, lock, crew notes, ...). Switching puts the running show away with its state and
// brings the other one out with its own. This computer's settings stay put: PINs, phone alerts,
// backups, the backup computer, practice/live and training.
//
// A switch is asked for while the show runs (features/shows.js) and done by server/index.js at the
// next start, before the show file is read, so nothing still running can write over it.
const fs = require('fs');
const path = require('path');

const COMPUTER_KEYS = ['server', 'alerts', 'backups', 'failover', 'live', 'training', 'reports'];
const PENDING = '.pending.json', LAST = '.last.json';

const read = (f, fallback = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
function write(f, data) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(data, null, 2));
  fs.renameSync(`${f}.tmp`, f);
}
// A show's name as a file name: no slashes or other characters Mac and Windows don't allow.
const safe = name => String(name ?? '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/^[.\s]+/, '').trim().slice(0, 60);
const nameOf = s => String(s?.show?.name || '').trim() || 'Show';
// A show file without this computer's settings (also what a download contains: no PINs).
const strip = s => Object.fromEntries(Object.entries(s || {}).filter(([k]) => !COMPUTER_KEYS.includes(k)));
const valid = s => !!s && typeof s === 'object' && Array.isArray(s.devices) && Array.isArray(s.show?.cues);

// The running state that belongs to the show file: .show.state.json, .show.crew.json, the lock, ...
function stateFiles({ file, state }) {
  if (!state) return [];
  const dir = path.dirname(state), base = `.${path.basename(file, '.json')}.`;
  let names = [];
  try { names = fs.readdirSync(dir).filter(f => f.startsWith(base) && f.endsWith('.json')); } catch { /* no folder yet */ }
  return [...new Set([...names.map(f => path.join(dir, f)), state, state.replace(/(\.state)?\.json$/, '.lock.json')])].filter(f => fs.existsSync(f));
}

function list(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('.')); } catch { /* empty library */ }
  return names.map(f => {
    const s = read(path.join(dir, f));
    if (!valid(s)) return null;
    return { name: nameOf(s), file: f, savedAt: fs.statSync(path.join(dir, f)).mtimeMs, cues: s.show.cues.length, devices: s.devices.filter(d => d.enabled !== false).length };
  }).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}
const entry = (dir, name) => path.join(dir, `${safe(name)}.json`);
const has = (dir, name) => !!safe(name) && fs.existsSync(entry(dir, name));

// Puts the running show and its state into the library, under its name.
function shelve({ file, state, dir }) {
  const cur = read(file);
  if (!valid(cur)) return null;
  const name = nameOf(cur);
  write(entry(dir, name), strip(cur));
  const sd = path.join(dir, `${safe(name)}.state`);
  fs.rmSync(sd, { recursive: true, force: true });
  const files = stateFiles({ file, state });
  if (files.length) { fs.mkdirSync(sd, { recursive: true }); for (const f of files) fs.copyFileSync(f, path.join(sd, path.basename(f))); }
  return name;
}
// Makes `next` the running show, with this computer's settings, and the state kept with it (or none:
// it starts at the top).
function load({ file, state }, next, stateDir) {
  const cur = read(file, {});
  const keep = Object.fromEntries(COMPUTER_KEYS.filter(k => k in cur).map(k => [k, cur[k]]));
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  write(file, { ...strip(next), ...keep });
  for (const f of stateFiles({ file, state })) fs.rmSync(f, { force: true });
  if (state && stateDir && fs.existsSync(stateDir)) for (const f of fs.readdirSync(stateDir)) fs.copyFileSync(path.join(stateDir, f), path.join(path.dirname(state), f));
}

// Asked for by a screen; done at the next start. job: { action: 'switch', name } or
// { action: 'new', name, keep: 'equipment' | 'all' }.
const ask = (dir, job) => write(path.join(dir, PENDING), { ...job, at: Date.now() });

function applyPending(p) {
  const f = path.join(p.dir, PENDING);
  const job = read(f);
  if (!job) return null;
  fs.rmSync(f, { force: true }); // once, even if it goes wrong
  let result;
  try {
    const cur = read(p.file);
    if (!valid(cur)) throw new Error('the running show file could not be read');
    if (job.action === 'switch') {
      const next = read(entry(p.dir, job.name));
      if (!valid(next)) throw new Error(`"${job.name}" is not in the library`);
      shelve(p);
      load(p, next, path.join(p.dir, `${safe(job.name)}.state`));
    } else if (job.action === 'new') {
      shelve(p);
      const show = { ...(cur.show || {}), name: job.name, ...(job.keep === 'all' ? {} : { cues: [] }) };
      load(p, { ...cur, show }, null);
    } else throw new Error(`unknown request ${job.action}`);
    result = { ...job, from: nameOf(cur), done: Date.now() };
  } catch (e) {
    result = { ...job, error: e.message, done: Date.now() };
    console.error(`  Could not switch shows: ${e.message}`);
  }
  try { write(path.join(p.dir, LAST), result); } catch { /* not important */ }
  return result;
}
const last = dir => read(path.join(dir, LAST));

module.exports = { COMPUTER_KEYS, safe, nameOf, strip, valid, list, has, entry, shelve, ask, applyPending, last, read, write };
