// Mic plot, radio mic receivers, mixer meters and the feedback / low battery alerts.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const assert = require('assert');
const FeedbackWatch = require('../server/feedback');
const wait = ms => new Promise(r => setTimeout(r, ms));

// Feedback detector on its own: a steady loud tone trips it, a moving voice does not.
{
  const fw = new FeedbackWatch({ minDb: -12, holdMs: 1000, steadyDb: 3 });
  let hits = [];
  for (let t = 0; t <= 1500; t += 100) hits = hits.concat(fw.push('m', [-6 + (t % 200 ? 0.5 : 0), -10 + ((t / 100) % 2 ? 8 : 0), null], t));
  assert.deepStrictEqual(hits.map(x => x.channel), [0], 'only the steady channel is flagged, once');
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showctl-snd-'));
const env = { ...process.env, PORT: '18086', SHOW_SAVE_PATH: path.join(tmp, 'show.json'), SHOW_STATE_FILE: '', SHOW_QUIET: '1' };
const child = spawn(process.execPath, [path.join(__dirname, '../sim/run.js')], { env, stdio: 'ignore' });

(async () => {
  await wait(3500);
  const ws = new WebSocket(`ws://127.0.0.1:${env.PORT}/ws`);
  const st = { devices: {}, alerts: [], meters: {} }; const pending = {}; let seq = 0;
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.t === 'init') { m.devices.forEach(d => (st.devices[d.id] = d)); st.alerts = m.alerts; }
    if (m.t === 'device') st.devices[m.device.id] = m.device;
    if (m.t === 'alerts') st.alerts = m.alerts;
    if (m.t === 'meters') st.meters[m.device] = m.levels;
    if (['saved', 'error', 'result'].includes(m.t) && pending[m.id]) pending[m.id](m);
  });
  await new Promise(r => ws.on('open', r));
  const send = m => ws.send(JSON.stringify(m));
  const ask = m => new Promise(r => { const id = ++seq; pending[id] = r; send({ ...m, id }); });
  await wait(2500);

  // receivers and pack status
  assert.strictEqual(st.devices.rx1.status, 'online', 'receiver 1 online');
  assert.strictEqual(st.devices.rx1.state.channels[0].name, 'Lead M', 'receiver channel names read');
  const mics = st.devices.mics.state;
  assert.strictEqual(mics.packs.length, 8, 'mic plot loaded');
  assert.strictEqual(mics.status['1'].batteryBars, 5, 'battery from the receiver');
  assert.strictEqual(mics.status['7'].tx, null, 'pack 7 not switched on');
  assert.ok(mics.status['3'].lowBattery, 'pack 3 battery low');
  assert.ok(st.alerts.some(a => a.key === 'batt:3' && /Priya/.test(a.title)), 'low battery alert names the actor');

  // meters
  assert.strictEqual(st.devices.tf5.state.meters, 'on', 'mixer meters streaming');
  assert.strictEqual(st.meters.tf5?.length, 32, 'a level for every input');

  // mic scene from the iPad: duet = packs 1 and 2 only
  let r = await ask({ t: 'cmd', device: 'mics', cmd: 'scene', args: { scene: '1-2' } });
  assert.strictEqual(r.results[0].outcome, 'sent', `mic scene sent (${r.results[0].detail})`);
  await wait(600);
  const on = st.devices.tf5.state.channels.slice(0, 8).map(c => c.on);
  assert.deepStrictEqual(on, [true, true, false, false, false, false, false, false], 'mixer channels follow the mic scene');
  assert.strictEqual(st.devices.mics.state.current, '1-2', 'current mic scene shown');
  assert.strictEqual(st.meters.tf5[4], null, 'a muted mic meters silence');

  // feedback alert on a live mic
  send({ t: 'cmd', device: 'tf5', cmd: 'raw', args: { line: 'simfeedback 1' } });
  await wait(2200);
  const fb = st.alerts.find(a => a.key === 'fb:tf5:1');
  assert.ok(fb, 'feedback alert raised');
  assert.match(fb.title, /Lead F \(Jo\)/, 'alert names the channel and actor');
  assert.deepStrictEqual(fb.action.args, { strip: 'ch', index: 1, on: false }, 'alert offers to mute that channel');
  send({ t: 'alert-dismiss', key: fb.key }); await wait(300);
  assert.ok(!st.alerts.some(a => a.key === fb.key), 'alert dismissed');

  // editing the mic plot
  r = await ask({ t: 'save-mics', mics: { packs: [{ id: '1' }, { id: '1' }], scenes: [] } });
  assert.strictEqual(r.t, 'error'); assert.match(r.msg, /both/);
  const plan = { ...mics, scenes: [...mics.scenes, { id: 'fin', name: 'Finale', live: ['1', '2', '99'], wearers: { 2: 'Cover' } }] };
  r = await ask({ t: 'save-mics', mics: plan });
  assert.strictEqual(r.t, 'saved', r.msg);
  await wait(300);
  const saved = JSON.parse(fs.readFileSync(env.SHOW_SAVE_PATH, 'utf8'));
  assert.deepStrictEqual(saved.mics.scenes.at(-1), { id: 'fin', name: 'Finale', live: ['1', '2'], wearers: { 2: 'Cover' } }, 'mic plot saved, unknown packs dropped');
  assert.strictEqual(st.devices.mics.state.scenes.length, 6, 'every iPad sees the new scene');
  r = await ask({ t: 'save-cues', cues: [{ label: 'Finale', actions: [{ device: 'mics', cmd: 'scene', args: { scene: 'fin' } }] }] });
  assert.strictEqual(r.t, 'saved', 'cues can switch mic scenes');

  ws.close(); child.kill();
  console.log('\nSOUND TEST PASSED');
  process.exit(0);
})().catch(e => { console.error('\nSOUND TEST FAILED:', e.message); child.kill(); process.exit(1); });
