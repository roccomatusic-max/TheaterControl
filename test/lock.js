// Sign-in roles, show lock, cue list history (undo) and backups.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const assert = require('assert');
const wait = ms => new Promise(r => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showctl-lock-'));
const file = path.join(tmp, 'show.json');
const env = { ...process.env, PORT: '18086', SHOW_SAVE_PATH: file, SHOW_STATE_FILE: path.join(tmp, '.show.state.json'), SHOW_QUIET: '1', SHOW_BACKUPS: '1', SHOW_BACKUP_DELAY_MS: '300' };
const root = path.join(__dirname, '..');
let server;
const start = async () => { server = spawn(process.execPath, [path.join(root, 'sim/run.js')], { env, stdio: 'ignore' }); await wait(3500); };
const stop = async () => { server.kill('SIGTERM'); await wait(800); };

// Connects and signs in with `pin` (undefined: don't sign in). Resolves with the first answer.
function connect(pin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${env.PORT}/ws`);
    const pending = {}; let seq = 0; const c = { ws, errors: [] };
    c.ask = m => new Promise(r => { const id = ++seq; pending[id] = r; ws.send(JSON.stringify({ ...m, id })); });
    c.send = m => ws.send(JSON.stringify(m));
    ws.on('error', reject);
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.t === 'auth-required') { c.authRequired = m; if (pin === undefined) resolve(c); else c.send({ t: 'auth', pin }); }
      if (m.t === 'auth-failed') { c.failed = true; resolve(c); }
      if (m.t === 'init') { c.init = m; resolve(c); }
      if (m.t === 'show') c.show = m.show;
      if (m.t === 'lock') c.lock = m.lock;
      if (m.t === 'error' && !pending[m.id]) c.errors.push(m.msg);
      if ((m.t === 'reply' || m.t === 'error' || m.t === 'saved') && pending[m.id]) pending[m.id](m.t === 'error' ? { error: m.msg } : m.data ?? {});
    });
  });
}

(async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config/show.sim.json'), 'utf8'));
  cfg.server = { pin: '1111', operatorPin: '2222', viewerPin: '3333', openViewing: true };
  fs.writeFileSync(file, JSON.stringify(cfg));
  await start();

  // ---- roles ----
  let c = await connect();
  assert.ok(c.authRequired?.watch, 'PIN screen offers "just watch"');
  c.ws.close();
  assert.ok((await connect('9999')).failed, 'wrong PIN refused');
  const viewer = await connect('');
  assert.equal(viewer.init.role, 'viewer');
  assert.ok((await viewer.ask({ t: 'setup-get' })).error, 'viewer cannot open setup');
  assert.ok(!(await viewer.ask({ t: 'health-get' })).error, 'viewer can look at equipment health');
  viewer.send({ t: 'show', action: 'go' }); await wait(300);
  assert.match(viewer.errors.join(), /watch only/, 'viewer cannot press GO');
  const op = await connect('2222');
  assert.equal(op.init.role, 'operator');
  assert.match((await op.ask({ t: 'setup-get' })).error, /admin PIN/, 'operator cannot open setup');
  assert.match((await op.ask({ t: 'access-set', pin: '' })).error, /admin PIN/);
  op.send({ t: 'show', action: 'go' }); await wait(300);
  assert.equal(op.show.index, 1, 'operator can GO');
  const admin = await connect('1111');
  assert.equal(admin.init.role, 'admin');
  assert.ok(!(await admin.ask({ t: 'setup-get' })).error);
  assert.match((await admin.ask({ t: 'access-set', pin: '', operatorPin: '5' })).error, /admin PIN first/);
  assert.match((await admin.ask({ t: 'access-set', pin: '1111', operatorPin: '1111' })).error, /different/);
  assert.equal((await connect('3333')).init.role, 'viewer', 'crew PIN signs in to watch');

  // ---- cue list history: every save is kept; undo puts back the one before; undo again redoes ----
  const cues = c => JSON.parse(JSON.stringify(op.show?.cues || admin.init.show.cues));
  let list = cues();
  list[0].label = 'House to half (edited)';
  assert.ok(!(await op.ask({ t: 'save-cues', cues: list })).error);
  await wait(200);
  list = cues(); list.push({ number: 99, label: 'Exit music', actions: [] });
  assert.ok(!(await op.ask({ t: 'save-cues', cues: list })).error);
  let v = await viewer.ask({ t: 'versions-list' });
  assert.equal(v.versions.length, 3, 'starting point + two saves');
  assert.match(v.versions[0].changes, /1 cue added \(99\)/);
  assert.match(v.versions[1].changes, /changed \(1\b/, JSON.stringify(v.versions));
  await op.ask({ t: 'cues-undo' }); await wait(200);
  assert.equal(op.show.cues.at(-1).label, 'Act 1 finale', 'undo removed the added cue');
  await op.ask({ t: 'cues-undo' }); await wait(200);
  assert.equal(op.show.cues.at(-1).label, 'Exit music', 'undo again redoes');
  v = await op.ask({ t: 'versions-list' });
  await op.ask({ t: 'versions-restore', file: v.versions.at(-1).file }); await wait(200);
  assert.equal(op.show.cues[0].label, 'House to half', 'starting point put back');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).show.cues[0].label, 'House to half', 'saved to the show file');

  // ---- show lock ----
  assert.ok((await viewer.ask({ t: 'show-lock', on: true })).error, 'viewer cannot lock');
  let r = await op.ask({ t: 'show-lock', on: true });
  assert.ok(r.lock?.at, 'operator locked the show'); await wait(100);
  assert.ok(admin.lock, 'every screen hears about the lock');
  assert.match((await op.ask({ t: 'save-cues', cues: cues() })).error, /locked/, 'cue edits refused');
  assert.match((await op.ask({ t: 'cues-undo' })).error, /locked/, 'undo refused');
  assert.match((await admin.ask({ t: 'setup-save', action: 'save', devices: [] })).error, /locked/, 'setup refused, even for admin');
  op.send({ t: 'show', action: 'fire', index: 5 }); await wait(200);
  assert.match(op.errors.at(-1), /out of order/);
  const pw = await op.ask({ t: 'cmd', device: 'projL', cmd: 'power', args: { on: false } });
  assert.match(pw.error, /switch equipment off/);
  const before = op.show.index;
  op.send({ t: 'show', action: 'go' }); await wait(300);
  assert.equal(op.show.index, before + 1, 'GO still works when locked');
  let check = await op.ask({ t: 'preshow-check' });
  assert.equal(check.items.find(i => i.label === 'Show lock').state, 'ok');

  // The lock survives a restart.
  for (const x of [viewer, op, admin]) x.ws.close();
  await stop(); await start();
  const op2 = await connect('2222');
  assert.ok(op2.init.lock, 'still locked after a restart');
  assert.match((await op2.ask({ t: 'show-lock', on: false, pin: '3333' })).error, /operator or admin PIN/, 'crew PIN cannot unlock');
  r = await op2.ask({ t: 'show-lock', on: false, pin: '2222' });
  assert.equal(r.lock, null, 'unlocked with the operator PIN');

  // ---- backups ----
  const bdir = path.join(tmp, 'Backups');
  const firstBackups = fs.readdirSync(bdir).filter(n => !n.endsWith('.json'));
  assert.ok(firstBackups.length >= 1, 'catch-up backup made at start-up');
  const one = path.join(bdir, firstBackups[0]);
  assert.ok(fs.existsSync(path.join(one, 'show.json')) && fs.existsSync(path.join(one, 'equipment.json')));
  assert.ok(JSON.parse(fs.readFileSync(path.join(one, 'equipment.json'), 'utf8')).devices.tf5.state.channels.length > 0, 'mixer state kept');
  const extra = path.join(tmp, 'QLab show'); fs.mkdirSync(path.join(extra, 'audio'), { recursive: true });
  fs.writeFileSync(path.join(extra, 'Into the Woods.qlab5'), 'workspace'); fs.writeFileSync(path.join(extra, 'audio', 'thunder.wav'), 'x'.repeat(1000));
  const admin2 = await connect('1111');
  assert.match((await op2.ask({ t: 'backups-set', folders: [extra] })).error, /admin PIN/, 'only admin chooses folders');
  assert.match((await admin2.ask({ t: 'backups-set', time: '25:00' })).error, /03:00/);
  const browse = await admin2.ask({ t: 'backups-browse', path: tmp });
  assert.ok(browse.dirs.includes('QLab show'), 'folder picker lists folders');
  let b = await admin2.ask({ t: 'backups-set', folders: [extra], time: '02:30' });
  assert.equal(b.time, '02:30');
  await wait(1100); // a new folder name (they are per second)
  b = await op2.ask({ t: 'backups-now' });
  assert.ok(b.ok, JSON.stringify(b));
  assert.ok(fs.existsSync(path.join(bdir, b.name, 'Folders', 'QLab show', 'audio', 'thunder.wav')), 'extra folder copied');
  check = await op2.ask({ t: 'preshow-check' });
  assert.equal(check.items.find(i => i.label === 'Backups').state, 'ok');
  r = await op2.ask({ t: 'backups-restore-cues', name: b.name });
  assert.ok(r.count > 5, JSON.stringify(r));
  assert.ok((await op2.ask({ t: 'backups-restore-cues', name: '../../etc' })).error, 'only real backups');

  op2.ws.close(); admin2.ws.close(); await stop();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nLOCK TEST PASSED');
  process.exit(0);
})().catch(e => { console.error('\nLOCK TEST FAILED:', e.message); server?.kill(); process.exit(1); });
