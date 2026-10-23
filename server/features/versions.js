// Cue list history: every saved cue list is kept as a version (newest 200), so any earlier one can be
// looked at and put back, and "Undo" puts back the one before the last save. Undoing twice redoes.
// Versions live in "<Show Control folder>/Cue list history".
const fs = require('fs');
const path = require('path');

const KEEP = 200;
const stamp = t => new Date(t).toISOString().replace(/[:.]/g, '-');

// What changed between two cue lists, in a few words ("2 cues added, 1 changed").
function compare(before = [], after = []) {
  const key = c => `${c.number}`;
  const b = new Map(before.map(c => [key(c), JSON.stringify(c)])), a = new Map(after.map(c => [key(c), JSON.stringify(c)]));
  const added = [...a.keys()].filter(k => !b.has(k)), removed = [...b.keys()].filter(k => !a.has(k));
  const changed = [...a.keys()].filter(k => b.has(k) && b.get(k) !== a.get(k));
  const moved = !added.length && !removed.length && !changed.length && before.map(key).join() !== after.map(key).join();
  const n = (x, w) => x.length ? `${x.length} cue${x.length > 1 ? 's' : ''} ${w} (${x.slice(0, 5).join(', ')}${x.length > 5 ? '…' : ''})` : '';
  return [n(added, 'added'), n(removed, 'removed'), n(changed, 'changed'), moved && 'cues reordered'].filter(Boolean).join(', ') || 'no changes';
}

module.exports = function versions(ctx) {
  const dir = path.join(ctx.DATA_DIR, 'Cue list history');
  const list = () => { try { return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort(); } catch { return []; } };
  const read = f => JSON.parse(fs.readFileSync(path.join(dir, path.basename(f)), 'utf8'));
  function add(cues, who, note, at = Date.now()) {
    fs.mkdirSync(dir, { recursive: true });
    const file = `${stamp(at)}.json`;
    ctx.writeJson(path.join(dir, file), { at, by: who, mode: ctx.MODE, show: ctx.show.name, note: note || '', cues });
    for (const old of list().slice(0, -KEEP)) fs.rmSync(path.join(dir, old), { force: true });
    return file;
  }

  ctx.events.on('cues-saved', ({ before, cues, who, note }) => {
    try {
      // The first time, keep the list as it was before this save too, so the first edit can be undone.
      if (!list().length && before?.length) add(before, 'before the first edit', 'starting point', Date.now() - 1);
      add(cues, who, note);
    } catch (e) { ctx.log({ device: 'core', level: 'warn', msg: `could not keep a copy in the cue list history: ${e.message}`, t: Date.now() }); }
  });

  function restore(file, who, note) {
    const v = read(file);
    ctx.saveCues(v.cues, who, note || `restored the cue list from ${new Date(v.at).toLocaleString()}`);
    ctx.broadcast({ t: 'show', show: ctx.showSnapshot() });
    return { restored: file, count: v.cues.length };
  }
  ctx.handlers['versions-list'] = () => {
    const files = list().slice(-50).reverse();
    const all = files.map(f => { try { return { file: f, ...read(f) }; } catch { return null; } }).filter(Boolean);
    return {
      folder: dir,
      versions: all.map((v, i) => ({ file: v.file, at: v.at, by: v.by, note: v.note, count: v.cues.length, mode: v.mode,
        changes: all[i + 1] ? compare(all[i + 1].cues, v.cues) : 'first copy kept', current: i === 0 })),
    };
  };
  ctx.handlers['versions-restore'] = (m, ws) => restore(m.file, ws.who);
  ctx.handlers['cues-undo'] = (m, ws) => {
    const files = list();
    if (files.length < 2) throw new Error('There is nothing to undo yet.');
    return restore(files.at(-2), ws.who, 'undo');
  };
  ctx.compareCues = compare;
};
module.exports.compare = compare;
