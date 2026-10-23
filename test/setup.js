// Setup screen: practice → live → practice through the double-click launcher, connection
// tests in plain words, and the start-with-the-computer switch. Uses a throwaway home folder.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const WebSocket = require('ws');
const assert = require('assert');
const wait = ms => new Promise(r => setTimeout(r, ms));

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'showctl-home-'));
const PORT = '18084';
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData'), PORT };
const live = path.join(home, 'Show Control', 'show.json');
const practice = path.join(home, 'Show Control', 'practice-show.json');

async function connect(expectMode, pin) {
  for (let i = 0; i < 40; i++) {
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      const c = await new Promise((resolve, reject) => {
        const pending = {}; let seq = 0;
        ws.on('error', reject);
        ws.on('message', raw => {
          const m = JSON.parse(raw);
          if (m.t === 'auth-required') { if (pin) ws.send(JSON.stringify({ t: 'auth', pin })); else resolve({ ws, locked: true }); }
          if (m.t === 'init') resolve({ ws, init: m, ask: q => new Promise(r => { const id = ++seq; pending[id] = r; ws.send(JSON.stringify({ ...q, id })); }) });
          if ((m.t === 'reply' || m.t === 'error') && pending[m.id]) pending[m.id](m.t === 'reply' ? m.data : { error: m.msg });
        });
      });
      if (c.locked) { c.ws.close(); if (!pin && expectMode === 'locked') return c; }
      else if (!expectMode || c.init.mode === expectMode) return c;
      c.ws.close();
    } catch { /* not up yet */ }
    await wait(500);
  }
  throw new Error(`server did not come up in ${expectMode} mode`);
}

(async () => {
  const launcher = spawn(process.execPath, [path.join(__dirname, '../launcher/start.js'), '--background'], { env, stdio: 'ignore' });
  try {
    let c = await connect('practice');
    let info = await c.ask({ t: 'setup-get' });
    assert.equal(info.mode, 'practice');
    assert.ok(info.supervised, 'launcher marks the server as supervised');
    assert.ok(info.devices.length >= 5 && info.devices.every(d => d.host === '' && !d.port), 'starts from the practice gear with blank addresses');
    assert.ok(info.devices.find(d => d.type === 'panasonic').username, 'keeps non-secret settings');

    // Connection tests: a real (simulated) Eos answers; a closed port and a dead address are explained.
    const ok = await c.ask({ t: 'setup-test', device: { id: 'eos', type: 'eos', host: '127.0.0.1', port: 13037 } });
    assert.ok(ok.ok, `simulated Eos answers: ${ok.detail}`);
    const closed = await new Promise(r => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
    const refused = await c.ask({ t: 'setup-test', device: { id: 'mixer', type: 'yamaha-tf', host: '127.0.0.1', port: closed } });
    assert.ok(!refused.ok && /not accepting remote control/.test(refused.detail), refused.detail);
    const blank = await c.ask({ t: 'setup-test', device: { id: 'qlab', type: 'qlab', host: '' } });
    assert.ok(!blank.ok && /address first/.test(blank.detail));
    const pj = await c.ask({ t: 'setup-test', device: { id: 'rear', type: 'pjlink', host: '127.0.0.1', port: 14352, password: 'wrong' } });
    assert.ok(!pj.ok && /password was wrong/.test(pj.detail), pj.detail);

    // Bad input is refused with a reason.
    const bad = await c.ask({ t: 'setup-save', action: 'save', name: 'X', devices: [{ id: 'a', type: 'toaster', host: '1.2.3.4' }] });
    assert.ok(bad.error && /unknown kind/.test(bad.error), JSON.stringify(bad));

    // Save in practice: stays in practice, no restart, real show file written with live:false.
    const devs = info.devices.map(d => ({ ...d, host: d.id === 'tf5' ? '' : '127.0.0.1' }));
    let r = await c.ask({ t: 'setup-save', action: 'save', name: 'Into the Woods', devices: devs });
    assert.equal(r.restarting, false);
    assert.deepEqual(r.missing, ['tf5'], 'cue steps that use equipment without an address are reported');
    let file = JSON.parse(fs.readFileSync(live, 'utf8'));
    assert.equal(file.live, false);
    assert.equal(file.devices.find(d => d.id === 'tf5').enabled, false);
    assert.ok(file.show.cues.length > 5, 'cue list copied into the real show');

    // Go live: server restarts on its own in live mode, with the real show file.
    const badPin = await c.ask({ t: 'setup-save', action: 'go-live', name: 'Into the Woods', pin: '12 34', devices: devs });
    assert.ok(/PIN/.test(badPin.error || ''), 'odd PIN refused');
    r = await c.ask({ t: 'setup-save', action: 'go-live', name: 'Into the Woods', pin: '2468', devices: devs });
    assert.equal(r.restarting, true);
    c.ws.close();
    await connect('locked'); // live mode asks for the PIN set on the Setup screen
    c = await connect('live', '2468');
    assert.equal((await c.ask({ t: 'setup-get' })).pin, '2468');
    assert.equal(c.init.show.name, 'Into the Woods');
    assert.ok(!c.init.devices.some(d => d.id === 'tf5'), 'equipment without an address is left out');
    assert.equal(JSON.parse(fs.readFileSync(live, 'utf8')).live, true);

    // Start with the computer.
    let a = await c.ask({ t: 'autostart', on: true });
    assert.ok(a.on, 'autostart on');
    a = await c.ask({ t: 'autostart', on: false });
    assert.ok(!a.on, 'autostart off');

    // Back to practice: cue list goes back too.
    r = await c.ask({ t: 'setup-save', action: 'practice', name: 'Into the Woods', pin: '2468', devices: devs });
    c.ws.close();
    c = await connect('practice', '2468'); // the PINs apply in practice too
    assert.equal(JSON.parse(fs.readFileSync(live, 'utf8')).live, false);
    assert.ok(JSON.parse(fs.readFileSync(practice, 'utf8')).show.cues.length > 5, 'practice copy has the cue list');
    info = await c.ask({ t: 'setup-get' });
    assert.equal(info.devices.find(d => d.id === 'eos').host, '127.0.0.1', 'practice shows the saved real addresses');
    c.ws.close();
    console.log('\nSETUP TEST PASSED');
  } finally {
    launcher.kill('SIGTERM');
    await wait(800);
    fs.rmSync(home, { recursive: true, force: true });
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
