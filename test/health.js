// Health: pre-show check, alerts when equipment stops answering (on screen and to the phone), and
// the phone alert settings. The simulators run in their own process so they can be "unplugged".
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const assert = require('assert');
const wait = ms => new Promise(r => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showctl-health-'));
const file = path.join(tmp, 'show.json');
const env = { ...process.env, PORT: '18085', SHOW_SAVE_PATH: file, SHOW_STATE_FILE: path.join(tmp, 'state.json'), SHOW_QUIET: '1', SHOW_ALERT_GRACE_MS: '800', SHOW_ALERT_BATCH_MS: '1500' };
const root = path.join(__dirname, '..');
let server, sims;
const startSims = () => { sims = spawn(process.execPath, ['-e', "require('./sim/devices')"], { cwd: root, env, stdio: 'ignore' }); };

(async () => {
  // A stand-in for the ntfy phone alert service.
  const pushed = [];
  const ntfy = http.createServer((req, res) => { let b = ''; req.on('data', d => (b += d)); req.on('end', () => { pushed.push(JSON.parse(b)); res.end('{}'); }); });
  await new Promise(r => ntfy.listen(0, '127.0.0.1', r));
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config/show.sim.json'), 'utf8'));
  cfg.alerts = { on: true, ntfyServer: `http://127.0.0.1:${ntfy.address().port}`, ntfyTopic: 'showcontrol-test' };
  fs.writeFileSync(file, JSON.stringify(cfg));

  startSims(); await wait(400);
  server = spawn(process.execPath, [path.join(root, 'server/index.js'), file], { env, stdio: 'ignore' });
  await wait(3000);

  const ws = new WebSocket(`ws://127.0.0.1:${env.PORT}/ws`);
  const st = { devices: {}, alerts: [], init: null }; const pending = {}; let seq = 0;
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.t === 'init') { st.init = m; m.devices.forEach(d => (st.devices[d.id] = d)); }
    if (m.t === 'device') st.devices[m.device.id] = m.device;
    if (m.t === 'alert') st.alerts.push(m.alert);
    if ((m.t === 'reply' || m.t === 'error') && pending[m.id]) pending[m.id](m.t === 'reply' ? m.data : { error: m.msg });
  });
  await new Promise(r => ws.on('open', r)); await wait(1500);
  const send = m => ws.send(JSON.stringify(m));
  const ask = m => new Promise(r => { const id = ++seq; pending[id] = r; send({ ...m, id }); });
  assert.deepEqual(st.init.alerts, [], 'no alerts at start');

  // Everything answering: no problems with the equipment or the show.
  let c = await ask({ t: 'preshow-check' });
  const bad = c.items.filter(i => i.state === 'error' && i.group !== 'This computer');
  assert.equal(bad.length, 0, JSON.stringify(bad));
  assert.ok(c.items.filter(i => i.group === 'Equipment' && i.state === 'ok').length >= 5, 'equipment answering');
  assert.match(c.items.find(i => i.id === 'eos').detail, /Sim Musical/, 'Eos show file name reported');
  assert.equal(c.items.find(i => i.label === 'Standby').state, 'ok');

  // Mid-show state is flagged with a one-tap fix that puts it right.
  send({ t: 'show', action: 'go' }); send({ t: 'show', action: 'timer', timer: 'show', op: 'start' });
  await wait(500);
  c = await ask({ t: 'preshow-check' });
  for (const label of ['Standby', 'Timers']) {
    const item = c.items.find(i => i.label === label);
    assert.equal(item.state, 'warn', label);
    item.fix.msgs.forEach(send);
  }
  await wait(500);
  c = await ask({ t: 'preshow-check' });
  assert.equal(c.items.find(i => i.label === 'Standby').state, 'ok', 'fixed: back at the top');
  assert.equal(c.items.find(i => i.label === 'Timers').state, 'ok', 'fixed: timers at zero');

  // Unplug everything: each device raises one alert (after the grace period), on screen and on the phone.
  sims.kill(); await wait(9000); // cameras are UDP: noticed by a 6 s watchdog
  const down = st.alerts.filter(a => a.level === 'error');
  for (const id of ['eos', 'tf5', 'qlab', 'cam1']) assert.ok(down.some(a => a.key === id), `alert for ${id}: ${JSON.stringify(st.alerts)}`);
  assert.ok(pushed.some(p => p.topic === 'showcontrol-test' && /Stopped answering: .*(Eos.*TF5|TF5.*Eos)/.test(p.message) && p.priority === 5), `alerts that arrive together go to the phone as one: ${JSON.stringify(pushed)}`);
  assert.ok(pushed.length < down.length, 'fewer phone messages than alerts');
  c = await ask({ t: 'preshow-check' });
  assert.equal(c.items.find(i => i.id === 'eos').state, 'error', 'check shows the console not answering');

  // A screen that connects now sees the alerts that are still active.
  const late = await new Promise(r => { const w = new WebSocket(`ws://127.0.0.1:${env.PORT}/ws`); w.on('message', raw => { const m = JSON.parse(raw); if (m.t === 'init') { w.close(); r(m); } }); });
  assert.ok(late.alerts.some(a => a.key === 'eos'), 'active alerts sent to new screens');

  // Plug back in: "answering again" clears each alert.
  st.alerts = []; startSims(); await wait(7000);
  for (const id of ['eos', 'tf5', 'qlab']) assert.ok(st.alerts.some(a => a.key === id && a.level === 'ok'), `${id} back: ${JSON.stringify(st.alerts)}`);

  // Emergency stop pings the phone too.
  send({ t: 'emergency' }); await wait(2500);
  assert.ok(pushed.some(p => /Emergency STOP/.test(p.message)), 'emergency stop sent to phone');

  // Phone alert settings: test message, turn off, turn on again keeps the same private channel name.
  const before = pushed.length;
  const t = await ask({ t: 'alerts-test' });
  assert.ok(t.ok, t.detail); assert.equal(pushed.length, before + 1);
  let p = await ask({ t: 'alerts-phone', on: false });
  assert.equal(p.on, false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).alerts.on, false, 'saved in the show file');
  p = await ask({ t: 'alerts-phone', on: true });
  assert.equal(p.topic, 'showcontrol-test'); assert.match(p.qr, /<svg/);
  const h = await ask({ t: 'health-get' });
  assert.ok(h.devices.eos.drops >= 1, 'drop-out counted');
  assert.ok(h.alerts.length > 0);

  ws.close(); server.kill(); sims.kill(); ntfy.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nHEALTH TEST PASSED');
  process.exit(0);
})().catch(e => { console.error('\nHEALTH TEST FAILED:', e.message); server?.kill(); sims?.kill(); process.exit(1); });
