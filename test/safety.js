// Emergency stop, cue-list editing and resuming at the same cue after a restart.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const assert = require('assert');
const wait = ms => new Promise(r => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showctl-'));
const env = { ...process.env, PORT: '18082', SHOW_SAVE_PATH: path.join(tmp, 'show.json'), SHOW_STATE_FILE: path.join(tmp, 'state.json'), SHOW_QUIET: '1' };
let child;
const startServer = async () => { child = spawn(process.execPath, [path.join(__dirname, '../sim/run.js')], { env, stdio: 'ignore' }); await wait(3500); };
const stopServer = async () => { child.kill('SIGTERM'); await wait(800); };

async function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${env.PORT}/ws`);
  const st = { devices: {}, show: null }; const pending = {}; let seq = 0;
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.t === 'init') { m.devices.forEach(d => (st.devices[d.id] = d)); st.show = m.show; }
    if (m.t === 'device') st.devices[m.device.id] = m.device;
    if (m.t === 'show') st.show = m.show;
    if ((m.t === 'saved' || m.t === 'error') && pending[m.id]) pending[m.id](m);
  });
  await new Promise(r => ws.on('open', r)); await wait(1500);
  const send = m => ws.send(JSON.stringify(m));
  const ask = m => new Promise(r => { const id = ++seq; pending[id] = r; send({ ...m, id }); });
  return { ws, st, send, ask };
}

(async () => {
  await startServer();
  let c = await connect();

  // emergency stop
  c.send({ t: 'cmd', device: 'group:all', cmd: 'power', args: { on: true } });
  c.send({ t: 'emergency' });
  await wait(1500);
  assert.ok(c.st.show.emergency, 'emergency recorded and broadcast');
  const out = Object.fromEntries(c.st.show.emergency.results.map(r => [r.device, r.outcome]));
  assert.ok(out.qlab, 'QLab panicked');
  assert.ok(['projL', 'projR', 'rear'].every(id => out[id]), 'every projector got a shutter close');
  c.send({ t: 'show', action: 'clear-emergency' }); await wait(300);
  assert.strictEqual(c.st.show.emergency, null, 'emergency cleared');

  // cue editing: bad lists are refused, good ones saved to the save path
  let r = await c.ask({ t: 'save-cues', cues: [{ label: 'X', actions: [{ device: 'nope', cmd: 'go' }] }] });
  assert.strictEqual(r.t, 'error'); assert.match(r.msg, /unknown device/);
  const cues = [...c.st.show.cues, { number: 99, label: 'Bows', actions: [{ device: 'qlab', cmd: 'start', args: { cue: '7' } }, { device: 'group:all', cmd: 'shutter', args: { closed: true }, delay: 2 }] }];
  r = await c.ask({ t: 'save-cues', cues });
  assert.strictEqual(r.t, 'saved');
  await wait(300);
  const saved = JSON.parse(fs.readFileSync(env.SHOW_SAVE_PATH, 'utf8'));
  assert.strictEqual(saved.show.cues.at(-1).label, 'Bows', 'cue list written to the show file');
  assert.ok(saved.devices.length > 5, 'rest of the show file kept');
  assert.strictEqual(c.st.show.cues.length, cues.length, 'all iPads see the new list');

  // resume after restart
  c.send({ t: 'show', action: 'go' }); c.send({ t: 'show', action: 'go' });
  c.send({ t: 'show', action: 'timer', timer: 'show', op: 'start' });
  await wait(1200);
  assert.strictEqual(c.st.show.index, 2);
  c.ws.close(); await stopServer();
  env.SHOW_CONFIG = env.SHOW_SAVE_PATH; // restart from the saved show file
  child = spawn(process.execPath, [path.join(__dirname, '../server/index.js'), env.SHOW_SAVE_PATH], { env, stdio: 'ignore' });
  const sims = spawn(process.execPath, ['-e', "require('./sim/devices')"], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' });
  await wait(3000);
  c = await connect();
  assert.strictEqual(c.st.show.index, 2, 'standby cue survives a restart');
  assert.ok(c.st.show.timers.show.start, 'show timer still running after restart');
  assert.strictEqual(c.st.show.cues.at(-1).label, 'Bows', 'edited cues survive a restart');
  c.ws.close(); child.kill(); sims.kill();
  console.log('\nSAFETY TEST PASSED');
  process.exit(0);
})().catch(e => { console.error('\nSAFETY TEST FAILED:', e.message); child?.kill(); process.exit(1); });
