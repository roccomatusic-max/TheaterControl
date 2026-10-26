// Per-screen limits (System > Screens), kiosk crew screens, the GO lockout and the show position
// being saved when Show Control stops.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const assert = require('assert');
const wait = ms => new Promise(r => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showctl-screens-'));
const file = path.join(tmp, 'show.json');
const stateFile = path.join(tmp, '.show.state.json');
const env = { ...process.env, PORT: '18096', SHOW_SAVE_PATH: file, SHOW_STATE_FILE: stateFile, SHOW_QUIET: '1', SHOW_VIDEO: '0', SHOW_HTTPS: '0' };
const root = path.join(__dirname, '..');
let server;
// the simulated gear, with this test's own show file
const start = async () => { server = spawn(process.execPath, ['-e', `require('./sim/devices'); setTimeout(() => { process.argv[2] = ${JSON.stringify(file)}; require('./server/index'); }, 300)`], { cwd: root, env, stdio: 'ignore' }); await wait(3500); };
const stop = async () => { server.kill('SIGTERM'); await new Promise(r => server.once('exit', r)); await wait(300); };

// A screen with its own id. From 127.0.0.2, so it is not "the show computer itself" (which is never limited).
function connect({ screen, pin, from = '127.0.0.2' } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${env.PORT}/ws${screen ? `?screen=${screen}` : ''}`, { localAddress: from });
    const pending = {}; let seq = 0; const c = { ws, errors: [], inits: [] };
    c.ask = m => new Promise(r => { const id = ++seq; pending[id] = r; ws.send(JSON.stringify({ ...m, id })); });
    c.send = m => ws.send(JSON.stringify(m));
    ws.on('error', reject);
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.t === 'auth-required') c.send({ t: 'auth', pin });
      if (m.t === 'init') { c.init = m; c.show = m.show; c.inits.push(m); resolve(c); }
      if (m.t === 'show') c.show = m.show;
      if (m.t === 'screens') c.screens = m.screens;
      if (m.t === 'alerts') c.alerts = m.alerts;
      if (m.t === 'saved' && pending[m.id]) pending[m.id]({});
      if (m.t === 'error' && !pending[m.id]) c.errors.push(m.msg);
      if ((m.t === 'reply' || m.t === 'error' || m.t === 'result') && pending[m.id]) pending[m.id](m.t === 'error' ? { error: m.msg } : m.t === 'result' ? m.results : m.data ?? {});
    });
  });
}

(async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config/show.sim.json'), 'utf8'));
  delete cfg.server;
  cfg.devices.push({ id: 'deadlx', type: 'eos', name: 'Spare Eos', host: '127.0.0.1', port: 1 }); // nothing listens there
  fs.writeFileSync(file, JSON.stringify(cfg));
  await start();

  // ---- no PINs: every screen can do everything, until it is limited ----
  const ipad = await connect({ screen: 'sipad0001' });
  const phone = await connect({ screen: 'sphone001' });
  assert.equal(phone.init.role, 'admin');
  await ipad.ask({ t: 'screen-hello', screen: 'sipad0001', name: 'Rocco iPad', view: { tab: 'sys' } });
  await phone.ask({ t: 'screen-hello', screen: 'sphone001', name: 'Fly floor', view: { tab: 'crew' } });
  assert.match((await ipad.ask({ t: 'screen-limit-set', screen: 'sipad0001', limit: 'viewer' })).error, /screen you are using/, 'cannot lock yourself out without a PIN');
  const pre = await ipad.ask({ t: 'preshow-check' });
  assert.match(pre.items.find(i => i.label === 'Crew screens')?.detail || '', /Fly floor can press GO/, 'the pre-show check spots a crew phone that can press GO');
  const set = await ipad.ask({ t: 'screen-limit-set', screen: 'sphone001', name: 'Fly floor', limit: 'viewer' });
  assert.equal(set.screenLimits.sphone001, 'viewer');
  await wait(300);
  assert.equal(phone.init.role, 'viewer', 'the phone is told at once');
  assert.ok(phone.init.screenLimited);
  assert.equal(ipad.screens.find(s => s.id === 'sphone001').limit, 'viewer', 'System > Screens shows the limit');
  await phone.ask({ t: 'screen-hello', screen: 'sphone001', name: 'Fly floor', view: { tab: 'crew' } }); // the page says hello again after its new init
  assert.ok(!(await ipad.ask({ t: 'preshow-check' })).items.some(i => i.label === 'Crew screens'), 'and is happy once it is limited');
  const before = ipad.show?.index ?? 0;
  phone.send({ t: 'show', action: 'go' }); await wait(300);
  assert.match(phone.errors.join(), /crew and watch only/, 'a limited phone cannot press GO');
  assert.equal(ipad.show?.index ?? 0, before);
  assert.ok(!(await phone.ask({ t: 'crew', op: 'standby-ack', role: 'Fly floor', name: 'Sam' })).error, 'it can still answer its cue light');
  assert.match((await phone.ask({ t: 'setup-get' })).error, /crew and watch only/);
  // the same phone reconnecting keeps its limit; the show computer itself never is limited
  phone.ws.close();
  const again = await connect({ screen: 'sphone001' });
  assert.equal(again.init.role, 'viewer');
  const local = await connect({ screen: 'sphone001', from: '127.0.0.1' });
  assert.equal(local.init.role, 'admin', 'the show computer itself always gets everything');
  local.ws.close();

  // ---- new screens start limited; the screen that set it keeps full control ----
  const n = await ipad.ask({ t: 'screen-limit-set', newScreens: 'operator' });
  assert.equal(n.newScreens, 'operator');
  assert.equal(n.screenLimits.sipad0001, 'admin');
  const stranger = await connect({ screen: 'snew00001' });
  assert.equal(stranger.init.role, 'operator');
  assert.match((await stranger.ask({ t: 'setup-get' })).error, /run the show only/);
  assert.match((await stranger.ask({ t: 'screen-limit-set', screen: 'snew00001', limit: 'admin' })).error, /run the show only/, 'a limited screen cannot lift its own limit');
  const noId = await connect();
  assert.equal(noId.init.role, 'admin', 'connections without a screen id (backup computer, stand-ins) are not limited');
  noId.ws.close();

  // ---- the GO lockout: a second GO within half a second is ignored and said so ----
  await ipad.ask({ t: 'screen-limit-set', newScreens: 'admin' });
  await ipad.ask({ t: 'screen-limit-set', screen: 'sphone001', limit: 'admin' });
  await wait(700);
  const at = ipad.show.index;
  ipad.send({ t: 'show', action: 'go' });
  again.send({ t: 'show', action: 'go' });
  await wait(400);
  assert.equal(ipad.show.index, at + 1, 'two GOs at once fire one cue');
  assert.match(again.errors.join(), /Second GO ignored: Rocco iPad pressed GO/);
  await wait(400);
  again.send({ t: 'show', action: 'go' }); await wait(300);
  assert.equal(ipad.show.index, at + 2, 'after the lockout GO works again');

  // ---- a command to equipment that isn't connected is not reported as done ----
  const [r] = await ipad.ask({ t: 'cmd', device: 'deadlx', cmd: 'go' });
  assert.equal(r.outcome, 'offline', JSON.stringify(r));
  assert.match(r.detail, /not connected/);

  // ...and a cue step to it is shown on every screen as an alert, not only in the log
  const cues = [...ipad.show.cues, { label: 'Spare console test', actions: [{ device: 'deadlx', cmd: 'go' }] }];
  await ipad.ask({ t: 'save-cues', cues });
  ipad.send({ t: 'show', action: 'fire', index: cues.length - 1 }); await wait(500);
  const alert = (again.alerts || []).find(a => a.key === 'cue-step:deadlx');
  assert.ok(alert, JSON.stringify(again.alerts));
  assert.match(alert.title, /Spare console test: Spare Eos did not take it/);
  assert.match(alert.detail, /not connected/);

  // ---- kiosk: leaving needs the admin PIN, when there is one ----
  assert.ok((await again.ask({ t: 'kiosk-exit', pin: '' })).ok);

  // ---- the show position is saved even when Show Control stops right after a GO ----
  ipad.send({ t: 'show', action: 'standby', index: 5 }); await wait(50);
  await stop();
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).index, 5);

  // ---- with PINs: the admin PIN always gets everything; the limit applies to the others ----
  const withPins = JSON.parse(fs.readFileSync(file, 'utf8'));
  withPins.server = { ...withPins.server, pin: '1111', operatorPin: '2222', screenLimits: { sphone001: 'viewer' } };
  fs.writeFileSync(file, JSON.stringify(withPins));
  await start();
  assert.equal((await connect({ screen: 'sphone001', pin: '1111' })).init.role, 'admin', 'admin PIN beats the limit');
  const opPhone = await connect({ screen: 'sphone001', pin: '2222' });
  assert.equal(opPhone.init.role, 'viewer', 'operator PIN on a crew-only phone is crew-only');
  assert.match((await opPhone.ask({ t: 'kiosk-exit', pin: '' })).error, /Wrong PIN/);
  assert.ok((await opPhone.ask({ t: 'kiosk-exit', pin: '1111' })).ok);
  await stop();

  console.log('\nSCREENS TEST PASSED');
  process.exit(0);
})().catch(async e => { console.error('\nSCREENS TEST FAILED:', e); server?.kill(); process.exit(1); });
