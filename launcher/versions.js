// One-tap update (System > Updates, server/features/updates.js): newer versions are unpacked into
// "Show Control/App versions/<version>", and use.json there says which one runs. The launcher that
// was started (double-clicked, or with the computer) stays the same: it starts the chosen version's
// launcher instead of running its own server (start.js), and goes back to the version before if the
// new one doesn't start.
//
// use.json: { version, app (its app folder), at, by, confirmed (it started and is running),
//             previous: { version, app } (what ran before; app = the started one means itself),
//             failed: { version, error, at } (a version that didn't start, and went back) }
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = (home = os.homedir()) => path.join(home, 'Show Control', 'App versions');
const useFile = home => path.join(dir(home), 'use.json');
const read = home => { try { return JSON.parse(fs.readFileSync(useFile(home), 'utf8')); } catch { return null; } };
function write(data, home) {
  const f = useFile(home);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(data, null, 2));
  fs.renameSync(`${f}.tmp`, f);
}
const same = (a, b) => !!a && !!b && path.resolve(a) === path.resolve(b);

// The node runtime that comes with an unpacked download (one per platform), else this one.
function nodeOf(app) {
  const n = process.platform === 'win32' ? path.join(app, 'runtime', 'node.exe') : path.join(app, 'runtime', `${process.platform}-${process.arch}`, 'node');
  return fs.existsSync(n) ? n : process.execPath;
}

// The version to run instead of `root` (the started one), or null to run root itself.
function pick(root, home) {
  const u = read(home);
  if (!u?.app || same(u.app, root) || !fs.existsSync(path.join(u.app, 'launcher', 'start.js'))) return null;
  return { ...u, start: path.join(u.app, 'launcher', 'start.js'), node: nodeOf(u.app) };
}
const confirmed = (next, home) => { const u = read(home); return !!u?.confirmed && same(u.app, next.app); };

// The chosen version didn't start: go back to the one before it (it has to start again too).
function failed(next, error, home) {
  const u = read(home) || {};
  const failure = { version: next.version, error, at: Date.now() };
  const prev = u.previous?.app && fs.existsSync(u.previous.app) ? u.previous : null;
  write(prev ? { ...prev, at: Date.now(), confirmed: false, failed: failure } : { failed: failure }, home);
}

module.exports = { dir, useFile, read, write, same, nodeOf, pick, confirmed, failed };
