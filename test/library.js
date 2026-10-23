// Several shows (System > Shows) and training mode (System > Training): switching shows keeps each
// show's position and cue list history and this computer's settings; training runs a copy of the
// show with pretend equipment, never touches the real gear, and leaves the real show as it was.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const net = require('net');
const dgram = require('dgram');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const assert = require('assert');
const wait = ms => new Promise(r => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showctl-library-'));
const file = path.join(tmp, 'show.json');
const env = { ...process.env, PORT: '18095', SHOW_QUIET: '1', SHOW_SIMS: '1', SHOW_ALERT_GRACE_MS: '1000', SHOW_ALERT_BATCH_MS: '300' };
const root = path.join(__dirname, '..');
const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
let server, sims;

// "Real" equipment the test can watch: a lighting desk (TCP) and an OSC box (UDP).
const realEos = { conns: [] };
const eosSrv = net.createServer(s => { realEos.conns.push(Date.now()); s.on('error', () => {}); });
const oscIn = [];
const osc = dgram.createSocket('udp4'); osc.on('message', m => oscIn.push(m));

function start() {
  server = spawn(process.execPath, [path.join(root, 'server/index.js'), file], { env, stdio: ['ignore', 'ignore', 'inherit'] });
  return connect();
}
const exited = () => new Promise(r => server.once('exit', code => r(code)));
async function connect() {
  for (let i = 0; i < 40; i++) {
    const c = await new Promise(res => {
      const ws = new WebSocket(`ws://127.0.0.1:${env.PORT}/ws`);
      const st = { ws, init: null, show: null, logs: [], devices: {}, alerts: [], training: null }; const pending = {}; let seq = 0;
      ws.on('message', raw => {
        const m = JSON.parse(raw);
        if (m.t === 'init') { st.init = m; st.show = m.show; st.alerts = m.alerts || []; for (const d of m.devices) st.devices[d.id] = d; }
        if (m.t === 'show') st.show = m.show;
        if (m.t === 'device') st.devices[m.device.id] = m.device;
        if (m.t === 'log') st.logs.push(m.entry);
        if (m.t === 'alerts') st.alerts = m.alerts;
        if (m.t === 'training') st.training = m.training;
        if ((m.t === 'reply' || m.t === 'error' || m.t === 'saved' || m.t === 'result') && pending[m.id]) pending[m.id](m.t === 'error' ? { error: m.msg } : m.t === 'result' ? m.results : m.data ?? {});
      });
      st.send = m => ws.send(JSON.stringify(m));
      st.ask = m => new Promise(r => { const id = ++seq; pending[id] = r; st.send({ ...m, id }); });
      ws.on('open', () => { const t = setInterval(() => { if (st.init) { clearInterval(t); res(st); } }, 50); });
      ws.on('error', () => res(null));
    });
    if (c) return c;
    await wait(250);
  }
  throw new Error('server did not start');
}
// Asks for something that restarts the server, then waits for it to come back.
async function restartAfter(c, m) {
  const gone = exited();
  const r = await c.ask(m);
  assert.ok(!r.error, r.error); assert.ok(r.restarting);
  assert.equal(await gone, 75, 'stops so it can start again');
  c.ws.close();
  return start();
}
const go = async c => { c.send({ t: 'show', action: 'go' }); await wait(400); };
const getText = url => new Promise((res, rej) => http.get(`http://127.0.0.1:${env.PORT}${url}`, r => { let b = ''; r.on('data', d => (b += d)); r.on('end', () => res({ status: r.statusCode, body: b, headers: r.headers })); }).on('error', rej));

(async () => {
  await new Promise(r => eosSrv.listen(0, '127.0.0.1', r));
  await new Promise(r => osc.bind(0, '127.0.0.1', r));
  const cfg = read(path.join(root, 'config/show.sim.json'));
  const eos = cfg.devices.find(d => d.id === 'eos'); eos.port = eosSrv.address().port;
  cfg.devices.push({ id: 'fx', name: 'Smoke machine', type: 'osc', host: '127.0.0.1', port: osc.address().port });
  cfg.show.cues[0].actions.push({ device: 'fx', cmd: 'send', args: { address: '/smoke/go', args: [] } });
  cfg.alerts = { on: false, ntfyTopic: 'this-computer-only' };
  fs.writeFileSync(file, JSON.stringify(cfg));
  sims = spawn(process.execPath, ['-e', "require('./sim/devices')"], { cwd: root, env, stdio: 'ignore' });
  await wait(400);

  let c = await start();
  await wait(1500);
  assert.ok(realEos.conns.length > 0, 'live: the real lighting desk is connected');
  await go(c); await go(c);
  assert.equal(c.show.index, 2);
  assert.ok(oscIn.length > 0, 'live: the smoke machine got its cue');
  const name = c.show.name;

  // ---------- several shows ----------
  let r = await c.ask({ t: 'shows-get' });
  assert.equal(r.here, true); assert.equal(r.current.name, name); assert.deepEqual(r.list, []);
  r = await c.ask({ t: 'shows-copy', name: 'Spring Concert' });
  assert.deepEqual(r.list.map(s => s.name), ['Spring Concert']);
  assert.match((await c.ask({ t: 'shows-copy', name: 'spring concert' })).error, /already a show/);
  assert.match((await c.ask({ t: 'shows-new', name: 'A/B' })).error, /can't/);
  await c.ask({ t: 'show-lock', on: true });
  assert.match((await c.ask({ t: 'shows-new', name: 'Into the Woods' })).error, /locked/);
  await c.ask({ t: 'show-lock', on: false });

  // A new show with the same equipment: empty cue list, at the top.
  c = await restartAfter(c, { t: 'shows-new', name: 'Into the Woods' });
  assert.equal(c.show.name, 'Into the Woods'); assert.equal(c.show.cues.length, 0); assert.equal(c.show.index, 0);
  assert.ok(c.devices.eos && c.devices.fx, 'same equipment');
  r = await c.ask({ t: 'shows-get' });
  assert.deepEqual(r.list.map(s => s.name), [name, 'Spring Concert']);
  assert.equal(r.last.name, 'Into the Woods'); assert.equal(r.last.from, name);
  assert.ok(!(await c.ask({ t: 'save-cues', cues: [{ number: 1, label: 'Prologue', actions: [] }] })).error);
  const woodsHistory = (await c.ask({ t: 'versions-list' })).versions;
  assert.ok(woodsHistory.length >= 1 && woodsHistory.every(v => v.count <= 1), 'its own cue list history');
  const shelf = read(path.join(tmp, 'Shows', `${name}.json`));
  assert.ok(!shelf.alerts && !shelf.server, 'a show in the library has none of this computer\'s settings');
  assert.equal(read(file).alerts.ntfyTopic, 'this-computer-only', 'this computer\'s settings stay put');

  // Back to the first show: where it was, with its own history.
  c = await restartAfter(c, { t: 'shows-switch', name });
  assert.equal(c.show.name, name); assert.equal(c.show.index, 2, 'back at the same cue');
  assert.equal(c.show.cues.length, cfg.show.cues.length);
  assert.ok((await c.ask({ t: 'versions-list' })).versions.every(v => v.count !== 1), 'the other show\'s history is not mixed in');
  assert.equal(read(file).alerts.ntfyTopic, 'this-computer-only');

  // Download a show and add it back from the file.
  r = await c.ask({ t: 'shows-link', name: 'Spring Concert' });
  const dl = await getText(r.url);
  assert.equal(dl.status, 200); assert.match(dl.headers['content-disposition'], /Spring Concert\.json/);
  const fileText = dl.body;
  assert.ok(!JSON.parse(fileText).alerts, 'no PINs or phone settings in a download');
  r = await c.ask({ t: 'shows-import', text: fileText });
  assert.equal(r.added, 'Spring Concert 2');
  assert.match((await c.ask({ t: 'shows-import', text: '{"hello":1}' })).error, /isn't a Show Control show file/);
  r = await c.ask({ t: 'shows-delete', name: 'Spring Concert 2' });
  assert.ok(!r.list.some(s => s.name === 'Spring Concert 2'));
  assert.match((await c.ask({ t: 'shows-delete', name })).error, /not in the list/, 'the running show can\'t be deleted');

  // ---------- training mode ----------
  r = await c.ask({ t: 'training-get' });
  assert.equal(r.on, false); assert.equal(r.can, true);
  c = await restartAfter(c, { t: 'training-start' });
  const since = realEos.conns.length;
  await wait(1500);
  assert.equal(c.init.mode, 'training'); assert.ok(c.init.training.since);
  assert.equal(c.show.index, 0, 'training starts at the top');
  assert.equal(c.devices.eos.status, 'online', 'the lighting desk is a simulator');
  r = await c.ask({ t: 'training-get' });
  assert.equal(r.devices.find(d => d.id === 'eos').stand, 'sim');
  assert.equal(r.devices.find(d => d.id === 'fx').stand, 'pretend');
  assert.equal(c.devices.fx.type, 'osc', 'a stand-in looks like the real kind of equipment');
  const osc0 = oscIn.length;
  await go(c);
  assert.ok(c.logs.some(l => l.device === 'fx' && /pretend/.test(l.msg)), 'the smoke machine cue is pretend');
  assert.equal(oscIn.length, osc0, 'nothing reached the real smoke machine');
  assert.equal(realEos.conns.length, since, 'nothing connected to the real lighting desk');
  assert.match((await c.ask({ t: 'setup-save', devices: [], action: 'save' })).error, /training mode/);
  assert.match((await c.ask({ t: 'shows-switch', name: 'Spring Concert' })).error, /training mode/);

  // The trainer makes the sound desk stop answering, then refuse one command.
  r = await c.ask({ t: 'training-trouble', device: 'qlab', what: 'down' });
  assert.equal(r.devices.find(d => d.id === 'qlab').trouble, 'down');
  await wait(1800);
  assert.equal(c.devices.qlab.status, 'offline');
  assert.ok(c.alerts.some(a => a.key === 'qlab' && a.kind === 'equipment'), 'the drop-out shows on the alert bar');
  c.logs = []; await go(c);
  assert.ok(c.logs.some(l => l.device === 'qlab' && /not_sent/.test(l.msg)));
  await c.ask({ t: 'training-trouble', device: 'qlab', what: 'fixed' });
  await wait(500);
  assert.equal(c.devices.qlab.status, 'online');
  await c.ask({ t: 'training-trouble', device: 'qlab', what: 'fail' });
  assert.equal((await c.ask({ t: 'cmd', device: 'qlab', cmd: 'go', args: {} }))[0].outcome, 'rejected', 'refused once');
  assert.ok(['ok', 'sent'].includes((await c.ask({ t: 'cmd', device: 'qlab', cmd: 'go', args: {} }))[0].outcome), 'then fine again');

  // Changes while training stay in the training copy.
  const cues = JSON.parse(JSON.stringify(c.show.cues)); cues[0].label = 'Changed in training';
  assert.ok(!(await c.ask({ t: 'save-cues', cues })).error);
  assert.ok(fs.readdirSync(path.join(tmp, 'Training', 'Cue list history')).length > 0, 'training has its own history');

  c = await restartAfter(c, { t: 'training-stop' });
  await wait(1500);
  assert.equal(c.init.mode, 'direct', 'back to the real show');
  assert.equal(c.show.index, 2, 'where it was');
  assert.notEqual(c.show.cues[0].label, 'Changed in training', 'the real cue list is untouched');
  assert.equal(read(file).training.on, false);
  assert.ok(realEos.conns.length > since, 'the real lighting desk is connected again');

  server.kill(); sims.kill(); eosSrv.close(); osc.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nLIBRARY AND TRAINING TEST PASSED');
  process.exit(0);
})().catch(e => { console.error(e); server?.kill(); sims?.kill(); process.exit(1); });
