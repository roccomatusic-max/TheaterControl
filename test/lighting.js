// Lighting tools: house lights (on an Eos submaster, Eos channels, or macros), the Eos cue list
// mirror (and adding its cues to the show), and the channel check.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const assert = require('assert');
const wait = ms => new Promise(r => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showctl-lighting-'));
const file = path.join(tmp, 'show.json');
const env = { ...process.env, PORT: '18093', SHOW_SAVE_PATH: file, SHOW_STATE_FILE: path.join(tmp, 'state.json'), SHOW_QUIET: '1' };
const root = path.join(__dirname, '..');
let server, sims;

(async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config/show.sim.json'), 'utf8'));
  fs.writeFileSync(file, JSON.stringify(cfg));
  sims = spawn(process.execPath, ['-e', "require('./sim/devices')"], { cwd: root, env, stdio: 'ignore' });
  await wait(400);
  server = spawn(process.execPath, [path.join(root, 'server/index.js'), file], { env, stdio: 'ignore' });
  await wait(3000);

  const ws = new WebSocket(`ws://127.0.0.1:${env.PORT}/ws`);
  const st = { show: null, logs: [], devices: {}, init: null, eosCues: null, chancheck: null }; const pending = {}; let seq = 0;
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.t === 'init') { st.init = m; st.show = m.show; for (const d of m.devices) st.devices[d.id] = d; st.eosCues = m.eosCues; }
    if (m.t === 'show') st.show = m.show;
    if (m.t === 'device') st.devices[m.device.id] = m.device;
    if (m.t === 'log') st.logs.push(m.entry);
    if (m.t === 'eos-cues') st.eosCues = m.eosCues;
    if (m.t === 'chancheck') st.chancheck = m.chancheck;
    if ((m.t === 'reply' || m.t === 'error' || m.t === 'saved' || m.t === 'result') && pending[m.id]) pending[m.id](m.t === 'error' ? { error: m.msg } : m.t === 'result' ? m.results : m.data ?? {});
  });
  await new Promise(r => ws.on('open', r)); await wait(2500);
  const send = m => ws.send(JSON.stringify(m));
  const ask = m => new Promise(r => { const id = ++seq; pending[id] = r; send({ ...m, id }); });
  const cmd = (device, c, args) => ask({ t: 'cmd', device, cmd: c, args });
  const eosCmd = () => st.devices.eos.state.cmdLine;

  // ---------- house lights ----------
  assert.equal(st.init.house, null, 'house lights not set up yet');
  assert.ok(!st.devices.house);
  let r = await ask({ t: 'house-set', way: 'sub', device: 'eos', sub: 10, fade: 0.5, levels: { half: 45 } });
  assert.equal(r.way, 'sub'); assert.equal(r.looks.find(l => l.id === 'half').level, 45);
  await wait(400);
  assert.equal(st.devices.house?.status, 'online', 'House lights appear as equipment, connected like the Eos');
  r = await cmd('house', 'houseLook', { look: 'half' });
  assert.equal(r[0].outcome, 'sent');
  await wait(300);
  assert.ok(st.devices.house.state.fading, 'fading');
  await wait(700);
  assert.equal(st.devices.house.state.level, 45, 'at half after the fade');
  assert.equal(st.devices.house.state.fading, false);
  assert.ok(st.logs.some(l => l.device === 'house' && /houseLook \{"look":"half"\} → sent/.test(l.msg)));

  // on channels: one command line with the level and the fade
  await ask({ t: 'house-set', way: 'chan', chans: '501-504' });
  await cmd('house', 'houseLevel', { level: 5, fade: 3 }); await wait(300);
  assert.match(eosCmd(), /Chan 501 Thru 504 At 05 Time 3#/, 'Eos reads "At 5" as 50%, so 5% is "05"');
  await cmd('house', 'houseLook', { look: 'full', fade: 0 }); await wait(300);
  assert.match(eosCmd(), /Chan 501 Thru 504 At Full#/);
  // macros: one per look
  await ask({ t: 'house-set', way: 'macro', macros: { full: 801, out: 804 } });
  r = await cmd('house', 'houseLook', { look: 'half' });
  assert.equal(r[0].outcome, 'not_sent', 'no macro for Half'); assert.match(r[0].detail, /no Eos macro for Half/);
  r = await cmd('house', 'houseLook', { look: 'out' });
  assert.equal(r[0].detail, 'macro 804');
  assert.match((await ask({ t: 'house-set', way: 'chan', chans: 'everything' })).error, /Type channels like/);

  // in a cue, in the rehearsal jump, and on STOP
  await ask({ t: 'house-set', way: 'sub', fade: 0, onStop: true });
  const cues = JSON.parse(JSON.stringify(st.show.cues));
  cues[0].actions.push({ device: 'house', cmd: 'houseLook', args: { look: 'half' } });
  cues[2].actions.push({ device: 'house', cmd: 'houseLook', args: { look: 'out', fade: 4 } });
  assert.equal((await ask({ t: 'save-cues', cues })).error, undefined, 'house lights steps save in cues');
  send({ t: 'show', action: 'standby', index: 0 }); await wait(100);
  send({ t: 'show', action: 'go' }); await wait(400);
  assert.equal(st.devices.house.state.level, 45, 'cue 1 takes the house to half');
  const p = await ask({ t: 'jump-preview', index: 4, mode: 'before' });
  assert.ok(p.steps.some(s => s.text === 'House lights: Out'), 'the jump puts the house lights where the cue list left them');
  send({ t: 'emergency' }); await wait(2500); // a 2 second fade
  assert.equal(st.devices.house.state.level, 100, 'STOP brings the house lights up');
  send({ t: 'show', action: 'clear-emergency' }); await wait(100);
  r = await ask({ t: 'depts-get' });
  assert.ok(r.list.find(d => d.id === 'lx').devices.includes('house'), 'house lights belong to lighting');

  // ---------- Eos cue list mirror ----------
  assert.equal(st.eosCues.lists[1].length, 40, 'the console\'s 40 cues');
  const c5 = st.eosCues.lists[1].find(c => c.number === '5');
  assert.equal(c5.label, 'Blackout'); assert.equal(c5.up, 0); assert.match(c5.notes, /Thunder/);
  assert.equal(st.eosCues.lists[1].find(c => c.number === '3').scene, 'Act 1 · Opening');
  assert.equal(st.eosCues.lists[1].find(c => c.number === '7').follow, 2, 'follow time in seconds');
  assert.deepEqual(st.devices.eos.state.active, { list: 1, cue: '1' }, 'live cue from the console');
  let check = await ask({ t: 'preshow-check' });
  let item = check.items.find(i => i.label === 'Lighting cues');
  assert.equal(item.state, 'ok'); assert.match(item.detail, /All 5 lighting cues/);
  assert.equal(check.items.find(i => i.label === 'House lights').state, 'ok');
  assert.ok(!check.items.some(i => i.label === 'House lights' && i.group === 'Equipment' && /answering/.test(i.detail)), 'not listed twice');
  // a show cue firing a lighting cue the console doesn't have
  const cues2 = JSON.parse(JSON.stringify(st.show.cues));
  cues2[6].actions.find(a => a.device === 'eos').args.cue = 77;
  await ask({ t: 'save-cues', cues: cues2 });
  check = await ask({ t: 'preshow-check' });
  item = check.items.find(i => i.label === 'Lighting cues');
  assert.equal(item.state, 'warn'); assert.match(item.detail, /Not on ETC Eos: 1\/77 \(show cue 7 Act 1 finale\)/);
  // add console cues to the show, each in its place
  const n = st.show.cues.length;
  r = await ask({ t: 'eos-import', numbers: ['3', '4', '5'] });
  assert.equal(r.added, 2, 'cue 5 is already in the show');
  await wait(200);
  assert.equal(st.show.cues.length, n + 2);
  assert.deepEqual(st.show.cues.slice(2, 5).map(c => c.label), ['Overture', 'Opening', 'Street'], 'after the show cue for Eos cue 2');
  assert.equal(st.show.cues[3].scene, 'Act 1 · Opening', 'scene from the console');
  await ask({ t: 'show-lock', on: true });
  assert.match((await ask({ t: 'eos-import', numbers: ['9'] })).error, /locked/);
  assert.match((await ask({ t: 'chancheck-start', device: 'eos' })).error, /locked/);
  await ask({ t: 'show-lock', on: false });

  // ---------- channel check ----------
  r = await ask({ t: 'chancheck-start', device: 'eos', channels: '1-3', level: 75 });
  assert.equal(r.run.chans.length, 3);
  assert.equal(r.run.chans[0].label, 'FOH 1'); assert.equal(r.run.chans[0].gel, 'R02');
  await wait(200);
  assert.match(eosCmd(), /Chan 1 At 75#/);
  r = await ask({ t: 'chancheck-step', mark: 'ok' }); await wait(200);
  assert.equal(r.run.at, 1); assert.match(eosCmd(), /Chan 2 At 75#/);
  r = await ask({ t: 'chancheck-step', mark: 'problem', note: 'Lamp out' });
  assert.equal(r.problems[0].n, 2); assert.equal(r.problems[0].label, 'FOH 2');
  r = await ask({ t: 'chancheck-step', to: 'back' }); await wait(200);
  assert.equal(r.run.at, 1, 'back to channel 2'); assert.match(eosCmd(), /Chan 2 At 75#/);
  await ask({ t: 'chancheck-step', to: 'next' });
  r = await ask({ t: 'chancheck-step', mark: 'ok' }); await wait(200);
  assert.equal(r.run, null, 'finished after the last channel');
  assert.equal(r.last.checked, 3); assert.equal(r.last.problems, 1);
  assert.match(eosCmd(), /Chan 1 Thru 3 Sneak#/, 'everything put back');
  check = await ask({ t: 'preshow-check' });
  item = check.items.find(i => i.label === 'Channel check');
  assert.equal(item.state, 'warn'); assert.match(item.detail, /2 \(FOH 2\) lamp out/);
  r = await ask({ t: 'chancheck-fixed', n: 2, device: 'eos' });
  assert.equal(r.problems.length, 0);
  // the whole patch when no channels are typed
  r = await ask({ t: 'chancheck-start', device: 'eos', channels: '' });
  assert.equal(r.run.chans.length, 52); assert.equal(r.run.chans[51].label, 'House 4');
  r = await ask({ t: 'chancheck-finish' });
  assert.equal(r.last.checked, 0);
  assert.equal(st.chancheck.run, null, 'every screen hears about it');

  server.kill(); sims.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nLIGHTING TEST PASSED');
  process.exit(0);
})().catch(e => { console.error('\nLIGHTING TEST FAILED:', e.message); server?.kill(); sims?.kill(); process.exit(1); });
