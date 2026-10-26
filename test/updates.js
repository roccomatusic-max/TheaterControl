// One-tap update, end to end through the real launcher: a damaged download is refused; a newer
// version is downloaded, unpacked, started in place of this one and confirms it is running; "Go
// back" returns to the started version; a version that stops straight away, or never gets running,
// is abandoned and the started version carries on, with an alert saying so.
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const assert = require('assert');
const wait = ms => new Promise(r => setTimeout(r, ms));
const step = m => process.env.SHOW_TEST_VERBOSE && console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

const root = path.join(__dirname, '..');
const mine = require('../package.json').version;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showctl-updates-'));
const home = path.join(tmp, 'home'); fs.mkdirSync(home);
const PORT = 18097;
const useFile = path.join(home, 'Show Control', 'App versions', 'use.json');
const readUse = () => JSON.parse(fs.readFileSync(useFile, 'utf8'));
let launcher, api, out = '';

// A Show Control download (a copy of this one with another version number), zipped like the real one.
function release(version, launcherCode) {
  const stage = path.join(tmp, `stage-${version}`), app = path.join(stage, 'Show Control', 'app');
  for (const f of ['server', 'public', 'sim', 'config', 'launcher', 'plugins', 'package.json']) fs.cpSync(path.join(root, f), path.join(app, f), { recursive: true });
  fs.cpSync(path.join(root, 'node_modules'), path.join(app, 'node_modules'), { recursive: true, verbatimSymlinks: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ ...pkg, version }));
  if (launcherCode) fs.writeFileSync(path.join(app, 'launcher', 'start.js'), launcherCode);
  const zip = path.join(tmp, `ShowControl-${version}.zip`);
  execFileSync('zip', ['-q', '-r', '-y', '-X', zip, 'Show Control'], { cwd: stage });
  return { version, zip, digest: `sha256:${crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex')}` };
}

// A stand-in for GitHub: the newest release and its download.
let latest = null;
function fakeGitHub() {
  return http.createServer((req, res) => {
    if (req.url === '/repos/roccomatusic-max/TheaterControl/releases/latest') {
      if (!latest) return res.writeHead(404).end('{}');
      const size = fs.statSync(latest.zip).size;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({
        tag_name: `v${latest.version}`, published_at: new Date().toISOString(),
        body: '**Mac:** download it.\n\n## What\'s Changed\n* Several shows on one computer by @rocco in https://github.com/x/y/pull/15\n* One-tap **update** from the iPad by @rocco in https://github.com/x/y/pull/16\n',
        assets: [{ name: 'ShowControl-mac.zip', size, digest: latest.digest, browser_download_url: `http://127.0.0.1:${api.address().port}/dl/${latest.version}.zip` }],
      }));
    }
    if (req.url.startsWith('/dl/') && latest) {
      res.writeHead(200, { 'Content-Length': fs.statSync(latest.zip).size });
      return fs.createReadStream(latest.zip).pipe(res);
    }
    res.writeHead(404).end();
  });
}

const health = () => new Promise(res => http.get(`http://127.0.0.1:${PORT}/api/health`, r => { let b = ''; r.on('data', d => (b += d)); r.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }).on('error', () => res(null)));
async function running(version, ms = 60000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await wait(300)) { const h = await health(); if (h?.version === version) return h; }
  throw new Error(`version ${version} did not come up\n${out.slice(-3000)}`);
}
function connect() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const c = { ws, init: null, updates: [] }; const pending = {}; let seq = 0;
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.t === 'init') { c.init = m; res(c); }
      if (m.t === 'update') c.updates.push(m.update);
      if ((m.t === 'reply' || m.t === 'error') && pending[m.id]) pending[m.id](m.t === 'error' ? { error: m.msg } : m.data ?? {});
    });
    c.ask = m => new Promise(r => { const id = ++seq; pending[id] = r; ws.send(JSON.stringify({ ...m, id })); });
    ws.on('error', rej);
  });
}
// The connection closing as the server restarts (or a clear failure, not a test that hangs).
const closed = (c, ms = 60000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(`the server did not restart\n${out.slice(-3000)}`)), ms); c.ws.once('close', () => { clearTimeout(t); res(); }); });
async function until(what, fn, ms = 30000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await wait(200)) if (await fn()) return;
  throw new Error(`timed out: ${what}\n${out.slice(-3000)}`);
}

(async () => {
  api = fakeGitHub();
  await new Promise(r => api.listen(0, '127.0.0.1', r));
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, PORT: String(PORT), SHOW_UPDATE_API: `http://127.0.0.1:${api.address().port}`,
    SHOW_UPDATE_PLATFORM: 'darwin', SHOW_UPDATE_ANY: '1', SHOW_UPDATE_CONFIRM_MS: '8000', SHOW_UPDATE_FIRST_CHECK_MS: '600000',
  };
  launcher = spawn(process.execPath, [path.join(root, 'launcher/start.js'), '--background'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  launcher.stdout.on('data', d => (out += d)); launcher.stderr.on('data', d => (out += d));
  step('starting'); await running(mine);
  let c = await connect();
  assert.equal(c.init.version, mine);
  let u = await c.ask({ t: 'update-get' });
  assert.equal(u.current, mine); assert.equal(u.can, true, u.why);

  step('nothing released');
  // Nothing released yet, then a release whose download doesn't match its checksum.
  u = await c.ask({ t: 'update-check' });
  assert.match(u.checkError, /no releases/i);
  const good = release('9.9.9');
  latest = { ...good, digest: 'sha256:0000' };
  u = await c.ask({ t: 'update-check' });
  assert.equal(u.newer, true); assert.equal(u.latest.version, '9.9.9');
  assert.deepEqual(u.latest.notes, ['Several shows on one computer', 'One-tap update from the iPad']);
  u = await c.ask({ t: 'update-install' });
  assert.ok(!u.error, u.error);
  await until('damaged download refused', () => c.updates.some(x => x.job?.stage === 'error'));
  assert.match(c.updates.at(-1).job.error, /damaged/);
  assert.equal((await health()).version, mine, 'still running');

  step('real install');
  // The real thing: downloaded, unpacked, started instead of this version, and confirmed.
  latest = good;
  await c.ask({ t: 'show-lock', on: true });
  assert.match((await c.ask({ t: 'update-install' })).error, /locked/);
  await c.ask({ t: 'show-lock', on: false });
  c.updates = [];
  const gone = closed(c);
  u = await c.ask({ t: 'update-install' });
  assert.ok(!u.error, u.error);
  await gone;
  assert.ok(c.updates.some(x => x.job?.stage === 'download' && x.job.total > 0), 'download progress shown');
  assert.ok(c.updates.some(x => x.job?.stage === 'restart'));
  await running('9.9.9');
  await until('9.9.9 confirms it is running', () => readUse().confirmed);
  let use = readUse();
  assert.equal(use.version, '9.9.9'); assert.equal(use.previous.version, mine);
  assert.ok(fs.existsSync(path.join(use.app, 'node_modules', '.bin')), 'unpacked with its links');
  c = await connect();
  u = await c.ask({ t: 'update-get' });
  assert.equal(u.current, '9.9.9'); assert.equal(u.previous, mine); assert.equal(u.newer, false);

  step('go back');
  // Go back to the version that was started.
  let g = closed(c);
  assert.ok((await c.ask({ t: 'update-back' })).restarting);
  await g; await running(mine);
  c = await connect();
  u = await c.ask({ t: 'update-get' });
  assert.equal(u.current, mine);

  step('broken version');
  // A version that stops straight away (sent as a file, as without internet): back to this one.
  const broken = release('9.9.10', 'process.exit(3);\n');
  let r = await c.ask({ t: 'update-upload' });
  g = closed(c);
  const sent = await fetch(`http://127.0.0.1:${PORT}${r.url}`, { method: 'POST', body: fs.readFileSync(broken.zip) });
  assert.equal(sent.status, 200, await sent.text());
  await g; await wait(1500); await running(mine);
  use = readUse();
  assert.equal(use.failed.version, '9.9.10'); assert.match(use.failed.error, /code 3/);
  c = await connect();
  assert.ok(c.init.alerts.some(a => a.key === 'update-failed' && /9\.9\.10/.test(a.title)), 'an alert says the update didn\'t start');
  assert.equal((await c.ask({ t: 'update-get' })).failed.version, '9.9.10');

  step('hanging version');
  // A version that never gets its server running: given up on after a while.
  const hangs = release('9.9.11', 'setInterval(() => {}, 1000);\n');
  r = await c.ask({ t: 'update-upload' });
  g = closed(c);
  await fetch(`http://127.0.0.1:${PORT}${r.url}`, { method: 'POST', body: fs.readFileSync(hangs.zip) });
  await g; await wait(9000); await running(mine, 30000);
  use = readUse();
  assert.equal(use.failed.version, '9.9.11'); assert.match(use.failed.error, /wasn't running/);
  // A used upload link doesn't work again.
  assert.equal((await fetch(`http://127.0.0.1:${PORT}${r.url}`, { method: 'POST', body: 'x' })).status, 403);

  launcher.kill('SIGTERM'); api.close();
  await wait(1000);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nUPDATES TEST PASSED');
  process.exit(0);
})().catch(e => { console.error(e); console.error(out.slice(-2000)); launcher?.kill(); process.exit(1); });
