// Show running tools: the show report (PDF after the last cue, sent to the phone), the second
// operator (a department with its own GO), the rehearsal jump and scene names on cues.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const assert = require('assert');
const wait = ms => new Promise(r => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showctl-tools-'));
const file = path.join(tmp, 'show.json');
const env = { ...process.env, PORT: '18089', SHOW_SAVE_PATH: file, SHOW_STATE_FILE: path.join(tmp, 'state.json'), SHOW_QUIET: '1' };
const root = path.join(__dirname, '..');
let server, sims;

(async () => {
  // A stand-in for the ntfy phone service: records JSON alerts and file uploads.
  const pushed = [];
  const ntfy = http.createServer((req, res) => {
    const chunks = []; req.on('data', d => chunks.push(d));
    req.on('end', () => { pushed.push({ method: req.method, headers: req.headers, body: Buffer.concat(chunks) }); res.end('{}'); });
  });
  await new Promise(r => ntfy.listen(0, '127.0.0.1', r));
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config/show.sim.json'), 'utf8'));
  cfg.alerts = { on: true, ntfyServer: `http://127.0.0.1:${ntfy.address().port}`, ntfyTopic: 'showcontrol-test' };
  cfg.reports = { afterMin: 0 };
  fs.writeFileSync(file, JSON.stringify(cfg));

  sims = spawn(process.execPath, ['-e', "require('./sim/devices')"], { cwd: root, env, stdio: 'ignore' });
  await wait(400);
  server = spawn(process.execPath, [path.join(root, 'server/index.js'), file], { env, stdio: 'ignore' });
  await wait(3000);

  const ws = new WebSocket(`ws://127.0.0.1:${env.PORT}/ws`);
  const st = { init: null, show: null, logs: [], depts: null }; const pending = {}; let seq = 0;
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.t === 'init') { st.init = m; st.show = m.show; st.depts = m.depts; }
    if (m.t === 'show') st.show = m.show;
    if (m.t === 'log') st.logs.push(m.entry);
    if (m.t === 'depts') st.depts = m.depts;
    if ((m.t === 'reply' || m.t === 'error' || m.t === 'saved') && pending[m.id]) pending[m.id](m.t === 'error' ? { error: m.msg } : m.data ?? {});
  });
  await new Promise(r => ws.on('open', r)); await wait(2500);
  const send = m => ws.send(JSON.stringify(m));
  const ask = m => new Promise(r => { const id = ++seq; pending[id] = r; send({ ...m, id }); });
  const sent = (device, re) => st.logs.some(l => l.device === device && re.test(l.msg));
  const n = st.show.cues.length;

  // Departments: every device belongs to one.
  const dept = id => st.depts.list.find(d => d.devices.includes(id))?.id;
  assert.deepEqual(['eos', 'qlab', 'tf5', 'cam1', 'projL'].map(dept), ['lx', 'snd', 'snd', 'cam', 'proj']);

  // ---------- show report ----------
  // A full run from the top: the report is made after the last cue and sent to the phone.
  for (let i = 0; i < n; i++) { send({ t: 'show', action: 'go' }); await wait(250); }
  await wait(2500);
  let r = await ask({ t: 'reports-get' });
  assert.equal(r.list.length, 1, 'one report after the last cue');
  assert.equal(r.list[0].kind, 'Show report');
  assert.equal(r.list[0].cuesRun, n);
  assert.equal(r.recording, null, 'nothing recording after the report');
  const upload = pushed.find(p => p.method === 'PUT');
  assert.ok(upload, 'report sent to the phone');
  assert.match(upload.headers.filename, /Show report\.pdf$/);
  assert.equal(upload.body.subarray(0, 5).toString(), '%PDF-');
  // The PDF opens from a screen through a short-lived link, and reads as a report.
  const link = await ask({ t: 'report-link', name: r.list[0].name });
  const res = await fetch(`http://127.0.0.1:${env.PORT}${link.url}`);
  assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /pdf/);
  const pdfFile = path.join(tmp, 'report.pdf');
  fs.writeFileSync(pdfFile, Buffer.from(await res.arrayBuffer()));
  try {
    const text = execFileSync('pdftotext', ['-layout', pdfFile, '-'], { encoding: 'utf8' });
    for (const s of [cfg.show.name, 'Show report', 'What happened', 'House to half', 'Act 1 finale', `${n} of ${n}`]) assert.ok(text.includes(s), `PDF mentions ${s}`);
  } catch (e) { if (e.code !== 'ENOENT') throw e; console.log('(pdftotext not installed: PDF text not checked)'); }
  assert.equal((await fetch(`http://127.0.0.1:${env.PORT}/reports/nope/x.pdf`)).status, 404, 'unknown links are refused');

  // ---------- second operator ----------
  send({ t: 'show', action: 'standby', index: 0 }); await wait(200);
  r = await ask({ t: 'dept-take', dept: 'snd', name: 'Sound iPad' });
  assert.equal(r.split.snd.by, 'Sound iPad');
  assert.match((await ask({ t: 'dept-take', dept: 'snd', name: 'Other iPad' })).error, /already run by Sound iPad/);
  st.logs = [];
  send({ t: 'show', action: 'go' }); await wait(600);
  assert.ok(sent('eos', /cue/), 'main GO runs the lighting');
  assert.ok(!sent('qlab', /start/), 'main GO leaves sound out');
  r = await ask({ t: 'dept-go', dept: 'snd' });
  assert.equal(r.fired, 0); await wait(400);
  assert.ok(sent('qlab', /start \{"cue":"1"\}/), 'sound GO runs the sound of cue 1');
  r = await ask({ t: 'dept-go', dept: 'snd' }); // cue 2 is sound-only
  assert.equal(r.fired, 1);
  send({ t: 'show', action: 'go' }); send({ t: 'show', action: 'go' }); await wait(300); // main runs cues 2 and 3
  r = await ask({ t: 'dept-release', dept: 'snd', name: 'Sound iPad' });
  assert.equal(r.missed, 1, 'cue 3 sound was behind the main GO');
  assert.deepEqual(r.split, {});

  // ---------- rehearsal jump ----------
  const ballad = st.show.cues.findIndex(c => c.label === 'Ballad');
  const p = await ask({ t: 'jump-preview', index: ballad, mode: 'before' });
  const words = p.steps.map(s => s.text).join(' | ');
  for (const re of [/cue 1\/5 with no fade/, /scene A2/, /Cam 1.*preset 3/, /Cam 2.*preset 2/, /shutter closed/, /fade out everything playing, playhead to Q7/]) assert.match(words, re);
  st.logs = [];
  r = await ask({ t: 'jump', index: ballad, mode: 'before', name: 'Rocco' });
  assert.deepEqual(r.problems, []);
  await wait(300);
  assert.equal(st.show.index, ballad, 'Ballad on standby');
  assert.ok(sent('eos', /Go_To_Cue 1\/5 Time 0#/), 'lights snapped to cue 5');
  assert.ok(sent('qlab', /panic/) && sent('qlab', /playhead/), 'sound faded out and lined up');
  const look = await ask({ t: 'jump-preview', index: ballad, mode: 'look', snap: false });
  assert.match(look.steps.map(s => s.text).join(' | '), /cue 1\/6(?! with)/, 'the look of the Ballad itself, with its fade');
  await ask({ t: 'show-lock', on: true });
  assert.match((await ask({ t: 'jump', index: 0 })).error, /locked/i, 'no jumping while the show is locked');
  await ask({ t: 'show-lock', on: false });

  // The rehearsal (with a jump) becomes a rehearsal report, made by hand.
  r = await ask({ t: 'report-now' });
  assert.match(r.name, /Rehearsal report$/);
  const timing = await ask({ t: 'report-timing' });
  assert.equal(Object.keys(timing.at).length, n, 'scene map timing from the full show');

  // ---------- scenes ----------
  const cues = JSON.parse(JSON.stringify(st.show.cues)); cues[2].scene = 'Act 1 · Overture';
  await ask({ t: 'save-cues', cues }); await wait(200);
  assert.equal(st.show.cues[2].scene, 'Act 1 · Overture', 'scene name kept');

  server.kill(); sims.kill(); ntfy.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nSHOW TOOLS TEST PASSED');
  process.exit(0);
})().catch(e => { console.error('\nSHOW TOOLS TEST FAILED:', e.message); server?.kill(); sims?.kill(); process.exit(1); });
