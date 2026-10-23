// Stage manager and crew screens: calls, cue lights, front of house, notes, checklist, script,
// crew tasks on cues, and that it all survives a restart.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const assert = require('assert');
const wait = ms => new Promise(r => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showctl-crew-'));
const env = { ...process.env, PORT: '18086', SHOW_SAVE_PATH: path.join(tmp, 'show.json'), SHOW_STATE_FILE: path.join(tmp, 'state.json'), SHOW_QUIET: '1' };
let child, sims;
const start = async (args = [path.join(__dirname, '../sim/run.js')]) => { child = spawn(process.execPath, args, { env, stdio: 'ignore' }); await wait(3500); };

async function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${env.PORT}/ws`);
  const st = { show: null, crew: null, script: null, calls: [], gos: [] }; const pending = {}; let seq = 0;
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.t === 'init') Object.assign(st, { show: m.show, crew: m.crew, script: m.script });
    if (m.t === 'show') st.show = m.show;
    if (m.t === 'crew') st.crew = m.crew;
    if (m.t === 'crew-script') st.script = m.script;
    if (m.t === 'crew-call') st.calls.push(m.call);
    if (m.t === 'crew-go') st.gos.push(m);
    if (['reply', 'saved', 'error'].includes(m.t) && pending[m.id]) pending[m.id](m);
  });
  await new Promise(r => ws.on('open', r)); await wait(800);
  const send = m => ws.send(JSON.stringify(m));
  const ask = m => new Promise(r => { const id = ++seq; pending[id] = r; send({ ...m, id }); });
  const crew = (op, data = {}) => ask({ t: 'crew', op, name: 'Sam', ...data });
  return { ws, st, send, ask, crew };
}

(async () => {
  await start();
  const sm = await connect(), phone = await connect();
  assert.ok(sm.st.crew.roles.includes('Fly floor'), 'default crew roles');
  assert.deepStrictEqual(sm.st.show.cues[2].crew, [{ role: 'Fly floor', task: 'Fly out the show cloth' }], 'crew tasks loaded from the show file');

  // calls reach every screen, and "Got it" is recorded
  let r = await sm.crew('call', { text: 'Five minutes please', to: 'all' });
  assert.deepStrictEqual(r.data, { ok: true });
  await wait(200);
  const call = phone.st.calls.at(-1);
  assert.strictEqual(call.text, 'Five minutes please', 'phone got the call');
  await phone.crew('call-ack', { call: call.id, name: 'Alex' }); await wait(200);
  assert.ok(sm.st.crew.calls.at(-1).acks.Alex, 'SM sees who has seen the call ');
  r = await sm.crew('call', { text: 'x', to: 'Nobody' });
  assert.match(r.msg, /Nobody/, 'unknown call target refused');

  // front of house and countdown
  await phone.crew('foh', { status: 'closed', note: 'all in' }); await wait(200);
  assert.strictEqual(sm.st.crew.foh.status, 'closed'); assert.strictEqual(sm.st.crew.foh.by, 'Sam');
  await sm.crew('countdown', { label: 'Interval', target: Date.now() + 15 * 60e3 }); await wait(200);
  assert.strictEqual(phone.st.crew.countdown.label, 'Interval');
  r = await sm.crew('countdown', { target: Date.now() + 3 * 86400e3 });
  assert.strictEqual(r.t, 'error', 'countdown more than a day away refused');

  // cue lights: standby on the fly floor's cue, acknowledged, then GO goes to the fly floor
  sm.send({ t: 'show', action: 'standby', index: 2 }); await wait(200);
  await phone.crew('standby-ack', { role: 'Fly floor', name: 'Jo' }); await wait(200);
  assert.strictEqual(sm.st.crew.acks['Fly floor'].name, 'Jo', 'SM sees the fly floor standing by');
  sm.send({ t: 'show', action: 'go' }); await wait(300);
  assert.deepStrictEqual(phone.st.gos.at(-1).roles, ['Fly floor'], 'GO light sent to the fly floor');
  assert.deepStrictEqual(sm.st.crew.acks, {}, 'standby acks cleared for the next cue');
  await sm.crew('light', { role: 'Wardrobe', state: 'standby' }); await wait(200);
  assert.strictEqual(phone.st.crew.lights.Wardrobe.state, 'standby', 'manual standby light');

  // rehearsal notes are tagged with the last cue fired
  await sm.crew('note-add', { text: 'Fly cue late', dept: 'Stage' }); await wait(200);
  const note = sm.st.crew.notes.at(-1);
  assert.strictEqual(note.cue, '3'); assert.strictEqual(note.cueLabel, 'Overture'); assert.strictEqual(note.dept, 'Stage');

  // checklist: can't sign off until everything is ticked
  r = await sm.crew('signoff');
  assert.strictEqual(r.t, 'error', 'sign-off refused with items left');
  for (let i = 0; i < sm.st.crew.checklist.length; i++) await sm.crew('check', { i, on: true });
  r = await sm.crew('signoff'); await wait(200);
  assert.ok(sm.st.crew.checks.signedOff, 'signed off');

  // setup saved to the show file: roles, script with cue places, cue note
  await sm.crew('conf', { roles: 'Fly floor\nDeck', depts: 'LX\nSound' });
  await sm.crew('script', { text: 'ACT ONE\nScene 1\nLEAD: Hello', marks: { 3: 2 } }); await wait(200);
  assert.deepStrictEqual(phone.st.script.marks, { 3: 2 }, 'script places broadcast');
  r = await sm.crew('cue-note', { index: 4, note: 'Wait for the door slam' }); await wait(200);
  assert.strictEqual(sm.st.show.cues[4].note, 'Wait for the door slam', 'cue note saved from the SM screen');
  let saved = JSON.parse(fs.readFileSync(env.SHOW_SAVE_PATH, 'utf8'));
  assert.deepStrictEqual(saved.crew.roles, ['Fly floor', 'Deck']);
  assert.strictEqual(saved.crew.script.text.split('\n').length, 3);
  assert.strictEqual(saved.show.cues[2].crew[0].role, 'Fly floor', 'crew tasks kept when cues are saved');

  // editing cues in the cue editor keeps crew tasks; the script is still in the file afterwards
  const cues = sm.st.show.cues.map(c => ({ ...c })); cues[0].crew = [{ role: 'Deck', task: 'Clear the chair' }, { role: '', task: 'dropped' }];
  r = await sm.ask({ t: 'save-cues', cues }); assert.strictEqual(r.t, 'saved');
  saved = JSON.parse(fs.readFileSync(env.SHOW_SAVE_PATH, 'utf8'));
  assert.deepStrictEqual(saved.show.cues[0].crew, [{ role: 'Deck', task: 'Clear the chair' }], 'empty crew tasks dropped');
  assert.ok(saved.crew.script.text, 'script kept after a cue save');

  // everything survives a restart
  sm.ws.close(); phone.ws.close(); child.kill('SIGTERM'); await wait(800);
  sims = spawn(process.execPath, ['-e', "require('./sim/devices')"], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' });
  await start([path.join(__dirname, '../server/index.js'), env.SHOW_SAVE_PATH]);
  const again = await connect();
  assert.strictEqual(again.st.crew.notes.at(-1).text, 'Fly cue late', 'notes survive a restart');
  assert.ok(again.st.crew.checks.signedOff, 'checklist survives a restart');
  assert.strictEqual(again.st.crew.foh.status, 'closed', 'front of house status survives a restart');
  assert.deepStrictEqual(again.st.crew.roles, ['Fly floor', 'Deck']);
  assert.strictEqual(again.st.script.marks[3], 2, 'script survives a restart');
  again.ws.close(); child.kill(); sims.kill();
  console.log('\nCREW TEST PASSED');
  process.exit(0);
})().catch(e => { console.error('\nCREW TEST FAILED:', e.message); child?.kill(); sims?.kill(); process.exit(1); });
