// End-to-end check against the simulators: every driver connects, and commands round-trip.
process.env.PORT = process.env.PORT || '18080';
require('../sim/run');
const WebSocket = require('ws');
const assert = require('assert');
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await wait(2500);
  const ws = new WebSocket(`ws://127.0.0.1:${process.env.PORT}/ws`);
  const devices = {}; let show;
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.t === 'init') { m.devices.forEach(d => (devices[d.id] = d)); show = m.show; }
    if (m.t === 'device') devices[m.device.id] = m.device;
    if (m.t === 'show') show = m.show;
  });
  await new Promise(r => ws.on('open', r));
  const send = m => ws.send(JSON.stringify(m));
  await wait(1500);

  for (const d of Object.values(devices)) assert.strictEqual(d.status, 'online', `${d.id} not online`);
  assert.ok(devices.tf5.state.channels[0].name === 'Lead M', 'TF channel names synced');

  send({ t: 'show', action: 'go' }); send({ t: 'show', action: 'go' }); send({ t: 'show', action: 'go' }); // cues 1-3
  send({ t: 'cmd', device: 'tf5', cmd: 'level', args: { strip: 'dca', index: 2, db: -12.5 } });
  send({ t: 'cmd', device: 'tf5', cmd: 'on', args: { strip: 'ch', index: 3, on: false } });
  send({ t: 'cmd', device: 'cam3', cmd: 'move', args: { pan: 1, tilt: 0 } });
  await wait(1500);
  send({ t: 'cmd', device: 'cam3', cmd: 'move', args: { pan: 0, tilt: 0 } });
  await wait(3500);

  assert.strictEqual(show.index, 3, 'show advanced 3 cues');
  assert.match(devices.eos.state.activeCue, /^1\/2 /, `Eos active cue (got "${devices.eos.state.activeCue}")`);
  assert.strictEqual(devices.qlab.state.playhead, '1', 'QLab playhead number reported');
  assert.strictEqual(devices.tf5.state.dcas[2].level, -1250, 'DCA level echoed by mixer');
  assert.strictEqual(devices.tf5.state.channels[3].on, false, 'channel mute echoed');
  assert.strictEqual(devices.tf5.state.lastScene, 'A1', 'scene recall sent');
  assert.strictEqual(devices.cam1.state.lastPreset, 2, 'cam1 preset from cue');
  assert.ok(devices.cam3.state.pan > 0, `cam3 panned right (pan=${devices.cam3.state.pan})`);
  assert.ok(devices.cam2.state.zoom > 0, 'cam2 moved to preset after 2s delay');
  console.log('\nSMOKE TEST PASSED');
  process.exit(0);
})().catch(e => { console.error('\nSMOKE TEST FAILED:', e.message); process.exit(1); });
