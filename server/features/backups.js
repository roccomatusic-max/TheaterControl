// Nightly backups into "<Show Control folder>/Backups/<date time>/":
//  - the show files (real and practice), with the saved show position
//  - equipment.json: what each device reported at the time (mixer channel names and levels, Eos show
//    name, QLab playhead, projector lamp hours, camera presets)
//  - any extra folders chosen on the System tab (e.g. the QLab workspace folder when QLab runs on
//    this computer, or a folder where Eos or TF Editor show files are saved)
// Runs at a set time each night (default 03:00), and on start-up if the last one is over a day old.
// Keeps the newest 30.
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const MAX_FOLDER_BYTES = 2e9;
const pad = n => String(n).padStart(2, '0');
const folderName = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

// Copies without blocking, so a backup during a show never holds up GO.
async function copyDir(from, to, budget) {
  await fsp.mkdir(to, { recursive: true });
  for (const e of await fsp.readdir(from, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) await copyDir(a, b, budget);
    else if (e.isFile()) {
      if ((budget.used += (await fsp.stat(a)).size) > MAX_FOLDER_BYTES) throw new Error(`${path.basename(from)} is larger than 2 GB, so it was only partly copied`);
      await fsp.copyFile(a, b);
    }
  }
}
const dirSize = d => { let n = 0; try { for (const e of fs.readdirSync(d, { withFileTypes: true })) n += e.isDirectory() ? dirSize(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size; } catch { /* gone */ } return n; };

module.exports = function backups(ctx) {
  const root = path.join(ctx.DATA_DIR, 'Backups');
  const cfg = () => ({ time: '03:00', keep: 30, folders: [], ...(ctx.settings().backups || {}) });
  const lastFile = path.join(root, 'last.json');
  let last = null;
  try { last = JSON.parse(fs.readFileSync(lastFile, 'utf8')); } catch { /* never backed up */ }
  let running = null;

  async function backup(why) {
    if (running) return running;
    running = (async () => {
      const at = new Date();
      const dest = path.join(root, folderName(at));
      const problems = [];
      fs.mkdirSync(dest, { recursive: true });
      const files = [...new Set([ctx.LIVE_PATH, ctx.SAVE_PATH, process.env.SHOW_PRACTICE_PATH, ctx.STATE_PATH].filter(Boolean))];
      for (const f of files) if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dest, path.basename(f)));
      const equipment = Object.fromEntries([...ctx.devices.values()].map(d => [d.id, d.snapshot()]));
      ctx.writeJson(path.join(dest, 'equipment.json'), { at: at.getTime(), show: ctx.show.name, devices: equipment });
      for (const folder of cfg().folders) {
        try { await copyDir(folder, path.join(dest, 'Folders', path.basename(folder) || 'folder'), { used: 0 }); }
        catch (e) { problems.push(`${folder}: ${e.code === 'ENOENT' ? 'folder not found (is the drive connected?)' : e.message}`); }
      }
      // Keep the newest N.
      const all = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort();
      for (const old of all.slice(0, -Math.max(1, cfg().keep))) fs.rmSync(path.join(root, old), { recursive: true, force: true });
      last = { at: at.getTime(), name: path.basename(dest), ok: !problems.length, problems, why, size: dirSize(dest) };
      ctx.writeJson(lastFile, last);
      ctx.log({ device: 'core', level: problems.length ? 'warn' : 'cmd', msg: `backup ${problems.length ? 'finished with problems' : 'done'} (${why}): ${dest}${problems.length ? ` · ${problems.join('; ')}` : ''}`, t: Date.now() });
      return last;
    })().catch(e => {
      last = { at: Date.now(), ok: false, problems: [e.message], why };
      try { ctx.writeJson(lastFile, last); } catch { /* disk full? */ }
      ctx.log({ device: 'core', level: 'error', msg: `backup failed: ${e.message}`, t: Date.now() });
      return last;
    }).finally(() => { running = null; });
    return running;
  }

  // Nightly at the set time; on start-up when the last backup is more than a day old (the computer
  // may have been off at night). Only for the real show computer, not tests or direct runs.
  if (ctx.SUPERVISED || process.env.SHOW_BACKUPS) {
    let lastDay = last ? new Date(last.at).toDateString() : '';
    setInterval(() => {
      const now = new Date(), [hh, mm] = cfg().time.split(':').map(Number);
      if (now.toDateString() !== lastDay && now.getHours() * 60 + now.getMinutes() >= hh * 60 + mm) { lastDay = now.toDateString(); backup('nightly'); }
    }, 30e3).unref();
    if (!last || Date.now() - last.at > 26 * 3600e3) setTimeout(() => backup('catch-up after start'), Number(process.env.SHOW_BACKUP_DELAY_MS || 120e3)).unref();
  }

  const list = () => { try { return fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort().reverse(); } catch { return []; } };
  ctx.handlers['backups-get'] = () => ({ folder: root, ...cfg(), last, running: !!running, list: list().slice(0, 40) });
  ctx.handlers['backups-now'] = (m, ws) => backup(`by ${ws.who}`);
  ctx.handlers['backups-set'] = m => {
    const cur = cfg(), next = { ...cur };
    if (m.time != null) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(m.time)) throw new Error('Time must look like 03:00'); next.time = m.time; }
    if (m.keep != null) next.keep = Math.max(1, Math.min(365, Number(m.keep) || 30));
    if (m.folders) {
      next.folders = [...new Set(m.folders.map(String).filter(Boolean))];
      for (const f of next.folders) if (!fs.existsSync(f) || !fs.statSync(f).isDirectory()) throw new Error(`Folder not found: ${f}`);
    }
    ctx.saveSettings({ backups: next });
    return ctx.handlers['backups-get']();
  };
  // Folder picker for "also back up this folder": lists sub-folders, starting at the home folder.
  ctx.handlers['backups-browse'] = m => {
    const at = path.resolve(m.path || os.homedir());
    const dirs = fs.readdirSync(at, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name).sort((a, b) => a.localeCompare(b));
    const roots = [os.homedir(), ...(process.platform === 'darwin' && fs.existsSync('/Volumes') ? ['/Volumes'] : [])];
    return { path: at, parent: path.dirname(at) !== at ? path.dirname(at) : null, dirs, roots };
  };
  // Put the cue list back from a backup (the backup itself is not changed).
  ctx.handlers['backups-restore-cues'] = (m, ws) => {
    const dest = path.join(root, path.basename(String(m.name)));
    const file = [ctx.SAVE_PATH, ctx.LIVE_PATH].map(f => path.join(dest, path.basename(f))).find(f => fs.existsSync(f));
    if (!file) throw new Error('That backup has no show file.');
    const cues = JSON.parse(fs.readFileSync(file, 'utf8')).show?.cues;
    if (!Array.isArray(cues)) throw new Error('That backup has no cue list.');
    ctx.saveCues(cues, ws.who, `restored the cue list from the backup of ${m.name}`);
    ctx.broadcast({ t: 'show', show: ctx.showSnapshot() });
    return { count: cues.length };
  };

  ctx.checks.push(() => {
    const item = { group: 'This computer', label: 'Backups' };
    const now = { label: 'Back up now', msgs: [{ t: 'backups-now' }] };
    if (!last) return [{ ...item, state: 'warn', detail: 'No backup yet.', fix: now }];
    const age = Date.now() - last.at, when = new Date(last.at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    if (!last.ok) return [{ ...item, state: 'warn', detail: `The last backup (${when}) had a problem: ${last.problems.join('; ')}`, fix: now }];
    if (age > 2 * 86400e3) return [{ ...item, state: 'warn', detail: `Last backup ${when}, more than two days ago.`, fix: now }];
    return [{ ...item, state: 'ok', detail: `Last backup ${when}.` }];
  });
  return { backup };
};
