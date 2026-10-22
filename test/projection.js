// Projector control against the simulated Panasonic PT-DZ13Ks and PJLink projector:
// auth, power confirmation, warm-up/cool-down refusals, shutter polarity, inputs, gating, groups.
process.env.PORT = process.env.PORT || '18081';
require('../sim/run');
const WebSocket = require('ws');
const assert = require('assert');
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await wait(2500);
  const ws = new WebSocket(`ws://127.0.0.1:${process.env.PORT}/ws`);
  const devs = {}; const pending = {}; let seq = 0;
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.t === 'init') m.devices.forEach(d => (devs[d.id] = d));
    if (m.t === 'device') devs[m.device.id] = m.device;
    if (m.t === 'result') pending[m.id](m.results);
  });
  await new Promise(r => ws.on('open', r));
  const cmd = (device, c, args) => new Promise(r => { const id = ++seq; pending[id] = r; ws.send(JSON.stringify({ t: 'cmd', id, device, cmd: c, args })); });
  const by = rs => Object.fromEntries(rs.map(r => [r.device, r]));
  await wait(3000);

  for (const id of ['projL', 'projR', 'rear']) assert.strictEqual(devs[id].status, 'online', `${id} online (projL uses protect-mode auth, projR closes after every reply)`);
  assert.strictEqual(devs.projL.state.power, 'standby');
  assert.strictEqual(devs.projL.state.shutter, null, 'shutter unknown in standby, not guessed');
  assert.deepStrictEqual(devs.projL.state.lamps.map(l => l.hours), [1520, 1498, 1533, 1507], 'four lamp hours from Q$L');
  assert.strictEqual(devs.projR.state.health.fan, 'warning', 'fan warning from PJLink ERST');

  let r = by(await cmd('group:all', 'shutter', { closed: false }));
  assert.strictEqual(r.projL.outcome, 'busy', 'shutter in standby is busy, not unsupported');
  assert.match(r.projL.detail, /standby/);

  r = by(await cmd('group:all', 'power', { on: true }));
  for (const id of ['projL', 'projR', 'rear']) assert.strictEqual(r[id].outcome, 'accepted', `${id} power on accepted`);
  await wait(800);
  r = by(await cmd('projL', 'power', { on: false }));
  assert.strictEqual(r.projL.outcome, 'busy', 'power off refused while warming');
  assert.match(r.projL.detail, /starting up/);

  r = by(await cmd('projL', 'freeze', { on: true }));
  assert.strictEqual(r.projL.outcome, 'not_sent', 'unverified command gated');

  await wait(9000); // past warm-up
  assert.strictEqual(devs.projL.state.power, 'on');
  assert.strictEqual(devs.projL.state.shutter, 'closed', 'QSH 1 read as CLOSED');
  r = by(await cmd('group:foh', 'shutter', { closed: false }));
  assert.ok(r.projL.outcome === 'accepted' && r.projR.outcome === 'accepted' && !r.rear, 'group addresses only its members');
  r = by(await cmd('projL', 'input', { input: 'SD1' }));
  assert.strictEqual(r.projL.outcome, 'unsupported', 'SDI board not fitted');
  r = by(await cmd('projL', 'input', { input: 'XYZ' }));
  assert.strictEqual(r.projL.outcome, 'not_sent', 'unknown input never sent');
  await cmd('projL', 'input', { input: 'HD1' });
  await wait(1500);
  assert.strictEqual(devs.projL.state.shutter, 'open', 'shutter open confirmed by QSH');
  assert.strictEqual(devs.projL.state.input, 'HD1');
  assert.ok(devs.projL.state.unavailableInputs.SD1, 'SD1 struck off for this unit');

  await cmd('projR', 'power', { on: false });
  r = by(await cmd('projR', 'power', { on: true }));
  assert.strictEqual(r.projR.outcome, 'busy', 'power on refused while cooling');
  assert.match(r.projR.detail, /cooling/);

  r = by(await cmd('rear', 'input', { input: '31' }));
  assert.strictEqual(r.rear.outcome, 'accepted');
  r = by(await cmd('rear', 'input', { input: '99' }));
  assert.strictEqual(r.rear.outcome, 'rejected', 'PJLink ERR2 reported as rejected');

  console.log('\nPROJECTION TEST PASSED');
  process.exit(0);
})().catch(e => { console.error('\nPROJECTION TEST FAILED:', e.message); process.exit(1); });
