// Backup computer: the standby copies the show, takes over when the main computer dies, the main
// comes back on standby, and the show can be handed back. Also: a spare screen carrying on from another.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const assert = require('assert');
const wait = ms => new Promise(r => setTimeout(r, ms));

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showctl-failover-'));
const PORTS = { main: 18087, backup: 18088 };
const procs = {};
let sims;
const fileOf = who => path.join(tmp, who, 'show.json');
function startServer(who) {
  const env = { ...process.env, PORT: String(PORTS[who]), SHOW_SAVE_PATH: fileOf(who), SHOW_STATE_FILE: path.join(tmp, who, '.show.state.json'), SHOW_QUIET: '1',
    SHOW_TAKEOVER_MS: '1500', SHOW_FAILOVER_GRACE_MS: '4000' };
  procs[who] = spawn(process.execPath, [path.join(root, 'server/index.js'), fileOf(who)], { env, stdio: 'ignore' });
}
function connect(who) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORTS[who]}/ws`);
    const pending = {}; let seq = 0; const c = { ws, errors: [], events: [] };
    c.ask = m => new Promise(r => { const id = ++seq; pending[id] = r; ws.send(JSON.stringify({ ...m, id })); });
    c.send = m => ws.send(JSON.stringify(m));
    ws.on('error', reject);
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.t === 'auth-required') c.send({ t: 'auth', pin: '4321' });
      if (m.t === 'init') { c.init = m; c.show = m.show; c.devices = Object.fromEntries(m.devices.map(d => [d.id, d])); resolve(c); }
      if (m.t === 'device') c.devices[m.device.id] = m.device;
      if (m.t === 'show') c.show = m.show;
      if (m.t === 'failover') c.events.push(m);
      if (m.t === 'error' && !pending[m.id]) c.errors.push(m.msg);
      if ((m.t === 'reply' || m.t === 'error' || m.t === 'saved') && pending[m.id]) pending[m.id](m.t === 'error' ? { error: m.msg } : m.data ?? {});
    });
  });
}
async function until(what, fn, ms = 10000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(250)) if (await fn()) return;
  throw new Error(`timed out waiting for: ${what}`);
}

(async () => {
  const sim = JSON.parse(fs.readFileSync(path.join(root, 'config/show.sim.json'), 'utf8'));
  for (const [who, other] of [['main', 'backup'], ['backup', 'main']]) {
    fs.mkdirSync(path.join(tmp, who));
    fs.writeFileSync(fileOf(who), JSON.stringify({ ...sim, server: { pin: '4321' }, failover: { role: who, peer: `127.0.0.1:${PORTS[other]}` } }));
  }
  sims = spawn(process.execPath, ['-e', "require('./sim/devices')"], { cwd: root, env: { ...process.env, SHOW_QUIET: '1' }, stdio: 'ignore' });
  await wait(400);
  startServer('main'); await wait(1500);
  startServer('backup'); await wait(3000);

  // The main computer runs the show; the backup is on standby, connected, with no equipment connections.
  let main = await connect('main');
  assert.ok(main.init.failover.active, 'main is running the show');
  await until('backup connected to main', async () => (await main.ask({ t: 'failover-get' })).mirror);
  let backup = await connect('backup');
  assert.equal(backup.init.failover.active, false, 'backup on standby');
  assert.ok(Object.values(backup.devices).every(d => d.status === 'offline'), 'standby does not talk to the equipment');
  assert.equal((await main.ask({ t: 'preshow-check' })).items.find(i => i.label === 'Backup computer').state, 'ok');

  // Everything the operator does on the main computer is copied to the backup.
  main.send({ t: 'show', action: 'go' }); main.send({ t: 'show', action: 'go' });
  const cues = JSON.parse(JSON.stringify(main.init.show.cues)); cues[0].label = 'House to half (copied)';
  assert.ok(!(await main.ask({ t: 'save-cues', cues })).error);
  await main.ask({ t: 'show-lock', on: true });
  await until('backup has the show position and cue edit', () => backup.show.index === 2 && backup.show.cues[0].label === 'House to half (copied)');
  await until('backup saved the show file', () => JSON.parse(fs.readFileSync(fileOf('backup'), 'utf8')).show.cues[0].label === 'House to half (copied)', 5000);
  assert.equal(JSON.parse(fs.readFileSync(fileOf('backup'), 'utf8')).failover.role, 'backup', 'backup keeps its own role');
  assert.ok((await connect('backup')).init.lock, 'show lock copied');
  await main.ask({ t: 'show-lock', on: false, pin: '4321' });
  backup.send({ t: 'show', action: 'go' }); await wait(300);
  assert.match(backup.errors.join(), /on standby/, 'the standby refuses to run anything');

  // The main computer dies: the backup takes over, with the show where it was.
  procs.main.kill('SIGKILL');
  await until('backup takes over', () => backup.events.length > 0);
  backup.ws.close();
  backup = await connect('backup');
  assert.ok(backup.init.failover.active, 'backup is running the show');
  assert.equal(backup.show.index, 2, 'same cue position');
  await until('backup connected to the equipment', () => backup.devices.eos?.status === 'online' && backup.devices.tf5?.status === 'online');
  backup.send({ t: 'show', action: 'go' });
  await until('GO on the backup', () => backup.show.index === 3);

  // The main computer comes back: it waits on standby and copies the backup.
  startServer('main'); await wait(2500);
  main = await connect('main');
  assert.equal(main.init.failover.active, false, 'main came back on standby');
  await until('main copies the backup', () => main.show.index === 3);

  // Hand the show back: the main runs it again, the backup steps down.
  assert.ok(!(await backup.ask({ t: 'failover-handback' })).error);
  await until('main takes over again', () => main.events.length > 0);
  main.ws.close();
  main = await connect('main');
  assert.ok(main.init.failover.active, 'main is running the show again');
  await until('main connected to the equipment', () => main.devices.eos?.status === 'online');
  assert.equal(main.show.index, 3, 'position kept through the hand-back');
  startServer('backup'); await wait(2500);
  assert.equal((await connect('backup')).init.failover.active, false, 'backup restarts on standby');

  // A spare screen carries on from one that dropped off.
  const a = await connect('main');
  await a.ask({ t: 'screen-hello', screen: 'screenAAAA', name: 'Rocco\'s iPad', view: { tab: 'cam', camSel: 'cam2' } });
  a.ws.close(); await wait(300);
  const b = await connect('main');
  await b.ask({ t: 'screen-hello', screen: 'screenBBBB', name: 'iPad XY', view: { tab: 'show' } });
  let list = await b.ask({ t: 'screens-list' });
  assert.equal(list.find(s => s.id === 'screenAAAA').connected, false, 'dropped-off screen listed');
  const r = await b.ask({ t: 'screen-takeover', from: 'screenAAAA' });
  assert.equal(r.name, 'Rocco\'s iPad'); assert.equal(r.view.camSel, 'cam2');
  list = await b.ask({ t: 'screens-list' });
  assert.ok(!list.some(s => s.id === 'screenAAAA') && list.find(s => s.id === 'screenBBBB').name === 'Rocco\'s iPad', 'spare took its name');

  for (const p of Object.values(procs)) p.kill();
  sims.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nFAILOVER TEST PASSED');
  process.exit(0);
})().catch(e => { console.error('\nFAILOVER TEST FAILED:', e.message); for (const p of Object.values(procs)) p.kill(); sims?.kill(); process.exit(1); });
