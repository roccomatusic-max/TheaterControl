// Buttons, MIDI and timecode: the remote web address (Stream Deck through Companion), OSC, learned
// MIDI buttons, MIDI Show Control and cues fired by MIDI timecode.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const WebSocket = require('ws');
const assert = require('assert');
const osc = require('../server/lib/osc');
const wait = ms => new Promise(r => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showctl-inputs-'));
const file = path.join(tmp, 'show.json');
const env = { ...process.env, PORT: '18091', SHOW_SAVE_PATH: file, SHOW_STATE_FILE: path.join(tmp, 'state.json'), SHOW_QUIET: '1' };
const root = path.join(__dirname, '..');
const OSC_PORT = 18192, KEY = 'abc123def456';
let server, sims;

(async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config/show.sim.json'), 'utf8'));
  cfg.remote = { http: true, key: KEY, osc: true, oscPort: OSC_PORT, msc: true };
  const ballad = cfg.show.cues.findIndex(c => c.label === 'Ballad');
  cfg.show.cues[ballad].tc = '00:00:02:00';
  cfg.show.cues[ballad + 1].tc = '00:00:03:00';
  fs.writeFileSync(file, JSON.stringify(cfg));
  sims = spawn(process.execPath, ['-e', "require('./sim/devices')"], { cwd: root, env, stdio: 'ignore' });
  await wait(400);
  server = spawn(process.execPath, [path.join(root, 'server/index.js'), file], { env, stdio: 'ignore' });
  await wait(3000);

  const ws = new WebSocket(`ws://127.0.0.1:${env.PORT}/ws`);
  const st = { show: null, logs: [], timecode: null }; const pending = {}; let seq = 0;
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.t === 'init') { st.show = m.show; st.timecode = m.timecode; }
    if (m.t === 'show') st.show = m.show;
    if (m.t === 'log') st.logs.push(m.entry);
    if (m.t === 'timecode') st.timecode = m.timecode;
    if ((m.t === 'reply' || m.t === 'error') && pending[m.id]) pending[m.id](m.t === 'error' ? { error: m.msg } : m.data ?? {});
  });
  await new Promise(r => ws.on('open', r)); await wait(1500);
  const send = m => ws.send(JSON.stringify(m));
  const ask = m => new Promise(r => { const id = ++seq; pending[id] = r; send({ ...m, id }); });
  const standby = async i => { send({ t: 'show', action: 'standby', index: i }); await wait(150); };
  const get = async p => { const r = await fetch(`http://127.0.0.1:${env.PORT}/remote/${p}`); return { status: r.status, ...(await r.json()) }; };

  // ---------- the remote web address (Stream Deck through Companion) ----------
  assert.equal((await get('wrongkey/go')).status, 403, 'wrong key refused');
  await standby(0);
  let r = await get(`${KEY}/go`);
  assert.equal(r.status, 200); assert.equal(st.show.index, 1, 'GO from a button');
  assert.match(r.standby, /^2 Preshow/);
  assert.ok(st.logs.some(l => /GO 1 House to half \(Button 127\.0\.0\.1\)/.test(l.msg)), 'logged with where it came from');
  assert.equal((await get(`${KEY}/go`)).ignored, 'pressed twice within half a second', 'a bounce is ignored');
  await wait(600);
  await get(`${KEY}/fire/5`); await wait(100);
  assert.equal(st.show.lastFired, 4, 'fire cue 5');
  await get(`${KEY}/back`); await wait(100);
  assert.equal(st.show.index, 4, 'standby back one');
  assert.match((await get(`${KEY}/fire/99`)).error, /no cue 99/);
  await ask({ t: 'show-lock', on: true });
  await wait(600);
  r = await get(`${KEY}/fire/3`);
  assert.equal(r.status, 409); assert.match(r.error, /locked/i, 'the show lock applies to buttons too');
  await ask({ t: 'show-lock', on: false, pin: '' });
  await get(`${KEY}/stop`); await wait(300);
  assert.ok(st.show.emergency, 'STOP from a button');
  send({ t: 'show', action: 'clear-emergency' }); await wait(200);
  assert.match((await get(`${KEY}/state`)).standby, /Thunder/);

  // ---------- OSC ----------
  const udp = dgram.createSocket('udp4');
  const oscSend = (addr, args) => new Promise(res => udp.send(osc.encode(addr, args), OSC_PORT, '127.0.0.1', res));
  await standby(0);
  await oscSend('/showcontrol/go', [0]); await wait(200);
  assert.equal(st.show.index, 0, 'a button release does nothing');
  await oscSend('/showcontrol/go', [1]); await wait(250);
  assert.equal(st.show.index, 1, 'OSC GO');
  await oscSend('/showcontrol/fire', ['3']); await wait(250);
  assert.equal(st.show.lastFired, 2, 'OSC fire cue 3');

  // ---------- learned MIDI buttons ----------
  r = await ask({ t: 'remote-learn', action: 'go' });
  assert.equal(r.learning, 'GO');
  send({ t: 'midi-in', messages: [[0x90, 60, 100], [0x80, 60, 0]] }); await wait(250);
  r = await ask({ t: 'remote-get' });
  assert.equal(r.midi.length, 1); assert.equal(r.midi[0].words, 'note 60 (channel 1)'); assert.equal(r.learning, null);
  await standby(0);
  send({ t: 'midi-in', messages: [[0x90, 60, 100]] }); await wait(250);
  assert.equal(st.show.index, 1, 'the learned note is GO');
  send({ t: 'midi-in', messages: [[0x90, 61, 100]] }); await wait(250);
  assert.equal(st.show.index, 1, 'other notes do nothing');
  r = await ask({ t: 'remote-get' });
  assert.equal(r.key, KEY, 'admin sees the address');
  assert.equal(r.oscOn, true, 'OSC listening'); assert.equal(r.msc, true); assert.ok(r.addresses.length >= 0 && r.port === 18091);

  // ---------- MIDI Show Control from a console ----------
  send({ t: 'midi-in', messages: [[0xf0, 0x7f, 0x7f, 0x02, 0x01, 0x01, ...Buffer.from('4'), 0xf7]] }); await wait(250);
  assert.equal(st.show.lastFired, 3, 'MSC GO 4 fires cue 4');

  // ---------- timecode ----------
  // MIDI timecode quarter frames at 30 fps, a full set every two frames.
  const qf = (h, m, s, f) => [f & 15, f >> 4, s & 15, s >> 4, m & 15, m >> 4, h & 15, (h >> 4) | (3 << 1)].map((v, k) => [0xf1, (k << 4) | v]);
  const play = async (fromSec, toSec) => {
    for (let fr = fromSec * 30; fr <= toSec * 30; fr += 2) {
      const f = fr % 30, s = Math.floor(fr / 30) % 60;
      send({ t: 'midi-in', messages: qf(0, 0, s, f) });
      await wait(30);
    }
  };
  await standby(0);
  await play(1, 1.5); // following is off: nothing fires
  await play(1.6, 2.4);
  assert.equal(st.show.index, 0, 'nothing fires until following is switched on');
  r = await ask({ t: 'timecode-follow', on: true });
  assert.equal(r.follow, true); assert.equal(r.cues, 2);
  await play(0, 0.3);
  await play(2.6, 2.9); // a jump past the Ballad's timecode: nothing fires
  assert.equal(st.show.index, 0, 'a jump in the timecode fires nothing');
  await play(1, 3.5);
  await wait(200);
  assert.ok(st.logs.some(l => /timecode 00:00:02:00: cue 6/.test(l.msg)), 'Ballad fired by timecode');
  assert.equal(st.show.lastFired, ballad + 1, 'the next timecode cue fired too');
  assert.match(st.timecode.text, /^00:00:03:/, 'timecode shown');
  await wait(700);
  assert.equal(st.timecode.running, false, 'stops when the timecode stops');
  const check = await ask({ t: 'preshow-check' });
  assert.equal(check.items.find(i => i.label === 'Timecode').state, 'ok');
  // OSC timecode works too
  await oscSend('/showcontrol/timecode', ['00:00:07:00']); await wait(300);
  assert.match(st.timecode.text, /^00:00:07:00/);

  udp.close(); server.kill(); sims.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nINPUTS TEST PASSED');
  process.exit(0);
})().catch(e => { console.error('\nINPUTS TEST FAILED:', e.message); server?.kill(); sims?.kill(); process.exit(1); });
