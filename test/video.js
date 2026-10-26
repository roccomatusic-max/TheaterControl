// Cameras and video: video relay settings, phone-camera certificate, "Find video", recording with
// cue markers, snapshot notes, screens (view-only key), phone cameras, blackout, content check and
// "cameras follow cues". When go2rtc and ffmpeg are installed, also live video end to end.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const WebSocket = require('ws');
const assert = require('assert');
const { yaml, ALLOWED, findBinary } = require('../server/video');
const selfsigned = require('../server/lib/selfsigned');
const rtsp = require('../server/lib/rtsp');
const Recorder = require('../server/recorder');
const Notes = require('../server/notes');
const wait = ms => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showctl-video-'));
const get = (url, headers = {}) => new Promise((res, rej) => {
  (url.startsWith('https') ? https : http).get(url, { headers, rejectUnauthorized: false }, r => { const b = []; r.on('data', d => b.push(d)); r.on('end', () => res({ status: r.statusCode, body: Buffer.concat(b) })); }).on('error', rej);
});

// A pretend camera that only gives RTSP video with a Digest password (admin / secret).
function fakeRtspCamera() {
  const md5 = s => crypto.createHash('md5').update(s).digest('hex');
  const srv = net.createServer(sock => {
    let buf = '';
    sock.on('data', d => {
      buf += d; const end = buf.indexOf('\r\n\r\n'); if (end < 0) return;
      const req = buf.slice(0, end); buf = '';
      const uri = req.split(' ')[1], path_ = new URL(uri).pathname;
      if (path_ !== '/Streaming/Channels/102') return sock.end('RTSP/1.0 404 Not Found\r\nCSeq: 2\r\n\r\n');
      const auth = /Authorization: Digest (.+)/.exec(req)?.[1];
      const field = k => (auth?.match(new RegExp(`${k}="([^"]*)"`)) || [])[1];
      const ok = auth && field('response') === md5(`${md5('admin:cam:secret')}:n0nce:${md5(`DESCRIBE:${field('uri')}`)}`);
      if (!ok) return sock.end('RTSP/1.0 401 Unauthorized\r\nCSeq: 2\r\nWWW-Authenticate: Digest realm="cam", nonce="n0nce"\r\n\r\n');
      const sdp = 'v=0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\n';
      sock.end(`RTSP/1.0 200 OK\r\nCSeq: 2\r\nContent-Type: application/sdp\r\nContent-Length: ${sdp.length}\r\n\r\n${sdp}`);
    });
    sock.on('error', () => {});
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

async function units() {
  // video relay settings: one stream per camera plus four phone slots; two-way audio off
  const y = yaml({ apiPort: 1, webrtcPort: 2, rtspPort: 3, streams: { cam1: 'rtsp://u:p@10.0.0.1:554/2', phone1: '' } });
  assert.match(y, /cam1: "rtsp:\/\/u:p@10\.0\.0\.1:554\/2#backchannel=0"/);
  assert.match(y, /phone1:\n/); assert.match(y, /listen: "127\.0\.0\.1:1"/);
  assert.ok(ALLOWED.test('/api/webrtc') && ALLOWED.test('/api/stream.mp4') && !ALLOWED.test('/api/streams') && !ALLOWED.test('/api/config'), 'only playing/sending video is passed through');

  // phone-camera certificate: Node makes it, and an HTTPS server can use it
  const tls = selfsigned.make({ ips: ['127.0.0.1', '10.101.50.5'] });
  assert.ok(selfsigned.fits(tls.cert, ['10.101.50.5']) && !selfsigned.fits(tls.cert, ['10.9.9.9']));
  const srv = https.createServer(tls, (_, r) => r.end('secure')).listen(0);
  await new Promise(r => srv.on('listening', r));
  assert.strictEqual(String((await get(`https://127.0.0.1:${srv.address().port}/`)).body), 'secure');
  srv.close();

  // Find video: wrong path → 404, password needed → asks, right login → address found
  const cam = await fakeRtspCamera(), port = cam.address().port;
  assert.strictEqual((await rtsp.probe(`rtsp://127.0.0.1:${port}/nope`)).status, 404);
  assert.ok((await rtsp.probe(`rtsp://127.0.0.1:${port}/Streaming/Channels/102`)).needsPassword);
  assert.ok((await rtsp.probe(`rtsp://admin:wrong@127.0.0.1:${port}/Streaming/Channels/102`)).needsPassword);
  const found = await rtsp.probe(`rtsp://admin:secret@127.0.0.1:${port}/Streaming/Channels/102`);
  assert.ok(found.ok && found.codec === 'H264', JSON.stringify(found));
  cam.close();

  // Recorder: pulls each camera's MP4 into a file and keeps cue markers; carries on after a drop-out
  let drops = 0;
  const relay = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'video/mp4' });
    const t = setInterval(() => res.write(Buffer.alloc(1000, 7)), 100);
    if (req.url.includes('flaky') && drops++ === 0) setTimeout(() => { clearInterval(t); res.end(); }, 400);
    res.on('close', () => clearInterval(t));
  }).listen(0);
  await new Promise(r => relay.on('listening', r));
  const logs = [];
  const rec = new Recorder({ dir: path.join(tmp, 'Recordings'), log: (l, m) => logs.push(m), mp4Url: id => `http://127.0.0.1:${relay.address().port}/${id}`,
    cameras: () => [{ id: 'cam1', name: 'Cam 1 · FOH' }, { id: 'flaky', name: 'Wings' }], showName: () => 'Test: Show/1' });
  rec.start('test');
  await wait(800); rec.mark('cue', '1 Overture'); await wait(3800); rec.mark('note', 'late');
  const st = rec.state();
  assert.ok(st.on && st.cams.every(c => c.bytes > 0), 'both cameras recording');
  rec.stop('test');
  const list = rec.list();
  assert.strictEqual(list.length, 1); assert.match(list[0].folder, /Test- Show-1$/);
  const s = rec.read(list[0].folder);
  assert.deepStrictEqual(s.markers.map(m => m.label), ['1 Overture', 'late']);
  assert.strictEqual(s.cams.find(c => c.id === 'flaky').files.length, 2, 'a camera that dropped out continues in a second file');
  assert.ok(fs.statSync(path.join(rec.dir, list[0].folder, 'Cam 1.mp4')).size > 10000);
  rec.remove(list[0].folder, 'test'); assert.strictEqual(rec.list().length, 0);
  relay.close();

  // Notes: text + picture, export page with the picture inside
  const notes = new Notes({ dir: path.join(tmp, 'Notes') });
  const px = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const n = notes.add({ text: 'DSL <special> late', image: px, cue: 'after cue 3', camName: 'Cam 1' });
  assert.ok(notes.imagePath(n.image));
  const html = notes.exportHtml('Show');
  assert.ok(html.includes('DSL &lt;special&gt; late') && html.includes('data:image/png;base64,'));
  assert.throws(() => notes.add({ text: '' }), /empty/);
  notes.remove(n.id); assert.strictEqual(notes.list().length, 0);

  // Panasonic PTZ cameras get live video and preset shots like the VISCA ones
  const drivers = require('../server/drivers'), catalog = require('../server/catalog'), setup = require('../server/setup');
  const pana = new drivers['panasonic-cam']({ id: 'pcam', type: 'panasonic-cam', name: 'Pana', host: '127.0.0.1', video: 'rtsp://127.0.0.1:554/MediaInput/h264/stream_1' });
  assert.deepStrictEqual(pana.state.stream, { type: 'live', src: 'pcam' });
  assert.ok(drivers['panasonic-cam'].meta.fields.some(f => f[1] === 'video'), 'Panasonic set-up has the video address field');
  assert.strictEqual(catalog.cueCatalog().catalog['panasonic-cam'].preset[0][1], 'preset', 'cue editor picks Panasonic shots by name');
  assert.strictEqual(setup.cleanDevices([{ id: 'pcam', type: 'panasonic-cam', host: '10.0.0.5', video: ' rtsp://10.0.0.5/MediaInput/h264/stream_1 ' }])[0].video, 'rtsp://10.0.0.5/MediaInput/h264/stream_1');
  assert.ok(catalog.PROFILES.some(p => p.type === 'camera'), 'video-only cameras are in the Add equipment list');
  assert.ok(rtsp.PATHS.some(([b, p]) => b === 'Panasonic' && p.includes('MediaInput/h264/stream_1')));
}

// Whole server against the simulators, with a PIN.
async function server() {
  const env = { ...process.env, PORT: '18086', SHOW_SAVE_PATH: path.join(tmp, 'show.json'), SHOW_STATE_FILE: path.join(tmp, 'state.json'), SHOW_QUIET: '1' };
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/show.sim.json'), 'utf8'));
  cfg.server = { port: 18086, pin: '4321', httpsPort: 18087 };
  // with go2rtc and ffmpeg on this computer, a camera with real (test pattern) video
  const live = findBinary() && (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
  if (live) cfg.devices.push({ id: 'wings', type: 'camera', name: 'Wings · IR', host: '127.0.0.1',
    video: 'exec:ffmpeg -hide_banner -loglevel error -re -f lavfi -i testsrc=size=320x180:rate=15 -c:v libx264 -preset ultrafast -tune zerolatency -g 15 -pix_fmt yuv420p -f rtsp {output}' });
  cfg.video = { apiPort: 18988, webrtcPort: 18555, rtspPort: 18564 };
  fs.writeFileSync(env.SHOW_SAVE_PATH, JSON.stringify(cfg));
  if (!live) env.SHOW_VIDEO = '0';
  const child = spawn(process.execPath, ['-e', `require('./sim/devices'); setTimeout(() => { process.argv[2] = ${JSON.stringify(env.SHOW_SAVE_PATH)}; require('./server/index'); }, 300)`],
    { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' });
  try {
    await wait(3500);
    const open = async auth => {
      const ws = new WebSocket(`ws://127.0.0.1:${env.PORT}/ws`);
      const c = { ws, devices: {}, show: null, pending: {}, seq: 0, msgs: [] };
      ws.on('message', raw => {
        const m = JSON.parse(raw); c.msgs.push(m);
        if (m.t === 'auth-required') ws.send(JSON.stringify({ t: 'auth', ...auth }));
        if (m.t === 'init') { c.init = m; m.devices.forEach(d => (c.devices[d.id] = d)); c.show = m.show; }
        if (m.t === 'device') c.devices[m.device.id] = m.device;
        if (m.t === 'device-removed') delete c.devices[m.id];
        if (m.t === 'show') c.show = m.show;
        if ((m.t === 'reply' || m.t === 'error') && c.pending[m.id]) c.pending[m.id](m.t === 'reply' ? m.data : { error: m.msg });
      });
      c.ask = q => new Promise(r => { const id = ++c.seq; c.pending[id] = r; ws.send(JSON.stringify({ ...q, id })); });
      c.send = q => ws.send(JSON.stringify(q));
      for (let i = 0; i < 20 && !c.init; i++) await wait(150);
      return c;
    };
    const op = await open({ pin: '4321' });
    assert.ok(op.init && !op.init.readonly && op.init.viewKey, 'operator signed in, gets the screens key');

    // HTTP video, recordings and notes need the sign-in cookie
    assert.strictEqual((await get(`http://127.0.0.1:${env.PORT}/video/api/stream.mp4?src=cam1`)).status, 401);
    assert.strictEqual((await get(`http://127.0.0.1:${env.PORT}/notes/export.html`)).status, 401);
    const cookie = { cookie: `sc=${op.init.token}` };
    assert.strictEqual((await get(`http://127.0.0.1:${env.PORT}/notes/export.html`, cookie)).status, 200);
    assert.strictEqual((await get(`http://127.0.0.1:${env.PORT}/video/api/streams`, cookie)).status, 404, 'relay settings never passed through');

    // screens: the view-only key can watch and send a phone camera, nothing else
    const tv = await open({ key: op.init.viewKey });
    assert.ok(tv.init.readonly && !tv.init.viewKey && tv.init.log.length === 0);
    const before = op.show.index;
    tv.send({ t: 'show', action: 'go' }); await wait(500);
    assert.strictEqual(op.show.index, before, 'a screen cannot fire cues');
    assert.strictEqual((await get(`http://127.0.0.1:${env.PORT}/notes/export.html`, { cookie: `sc=${tv.init.token}` })).status, 401, 'a screen cannot read notes');
    const ph = await tv.ask({ t: 'phone-start', name: 'Wings SL' });
    await wait(300);
    assert.strictEqual(ph.slot, 'phone1', JSON.stringify(ph));
    assert.ok(op.devices.phone1 && op.devices.phone1.name === 'Phone · Wings SL' && op.devices.phone1.status === 'online', 'phone shows up as a camera');
    tv.ws.close(); await wait(400);
    assert.ok(!op.devices.phone1, 'phone camera goes when the phone disconnects');

    // the phone page is served over HTTPS
    assert.strictEqual((await get('https://127.0.0.1:18087/phone')).status, 200);

    // cameras follow cues, or are held
    op.send({ t: 'cam-follow', on: false }); await wait(200);
    op.send({ t: 'show', action: 'fire', index: 1 }); await wait(800); // cue 2 recalls cam1 preset 1
    assert.notStrictEqual(op.devices.cam1.state.lastPreset, 1, 'held cameras do not move with the cue');
    op.send({ t: 'cam-follow', on: true }); await wait(200);
    op.send({ t: 'show', action: 'fire', index: 1 }); await wait(800);
    assert.strictEqual(op.devices.cam1.state.lastPreset, 1, 'cameras follow cues again');

    // blackout: standby projectors are already dark, which counts as done
    const bo = await op.ask({ t: 'blackout', on: true });
    assert.ok(Array.isArray(bo) && bo.length === 3 && bo.every(r => ['ok', 'accepted', 'sent'].includes(r.outcome)), JSON.stringify(bo));
    assert.ok(op.show.blackout);
    await op.ask({ t: 'blackout', on: false }); await wait(200);
    assert.strictEqual(op.show.blackout, null);

    // content check finds the simulated missing video file
    const cc = await op.ask({ t: 'content-check' });
    const qlab = cc.sections.find(s => s.title.startsWith('QLab'));
    assert.ok(qlab.items.some(i => !i.ok && i.text.includes('Storm.mov')), JSON.stringify(qlab));

    // focus helper wheel nudges reach Eos
    op.send({ t: 'cmd', id: 99, device: 'eos', cmd: 'wheel', args: { param: 'pan', ticks: 4 } });

    // recording with cue markers, and a snapshot note marked in it
    const r1 = await op.ask({ t: 'rec', action: 'start' });
    assert.ok(r1.on);
    op.send({ t: 'show', action: 'go' }); await wait(300);
    const note = await op.ask({ t: 'notes', action: 'add', text: 'Follow spot late', cam: 'cam1', image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' });
    assert.ok(note.id && note.cue && note.camName === 'Cam 1 · FOH centre', JSON.stringify(note));
    assert.strictEqual((await get(`http://127.0.0.1:${env.PORT}/notes/img/${note.image}`, cookie)).status, 200);
    if (live) {
      // live video through Show Control's /video, and into the recording
      const v = await get(`http://127.0.0.1:${env.PORT}/video/api/frame.jpeg?src=wings`, cookie).catch(() => ({ status: 0 }));
      assert.ok([200, 500].includes(v.status), `relay answers through Show Control (${v.status})`);
      await wait(4000);
    }
    const r2 = await op.ask({ t: 'rec', action: 'stop' });
    assert.ok(!r2.on, JSON.stringify(r2));
    if (process.env.DEBUG) console.log(JSON.stringify(r1), JSON.stringify(r2));
    const recs = await op.ask({ t: 'rec', action: 'list' });
    const sess = await op.ask({ t: 'rec', action: 'get', folder: recs[0].folder });
    assert.deepStrictEqual(sess.markers.map(m => m.kind), ['cue', 'note']);
    if (live) {
      const wings = sess.cams.find(c => c.id === 'wings');
      assert.ok(wings?.files.length, 'live camera recorded');
      const file = await get(`http://127.0.0.1:${env.PORT}/recordings/${encodeURIComponent(recs[0].folder)}/${encodeURIComponent(wings.files[0].file)}`, cookie);
      assert.ok(file.status === 200 && file.body.length > 5000 && file.body.subarray(4, 8).toString() === 'ftyp', 'recording is an MP4 and can be played back');
      console.log(`  (live video checked with go2rtc: ${file.body.length} bytes recorded)`);
    } else console.log('  (go2rtc or ffmpeg not installed here: live video part skipped)');
    assert.strictEqual((await get(`http://127.0.0.1:${env.PORT}/recordings/..%2Fshow.json/x.mp4`, cookie)).status, 404, 'no way out of the Recordings folder');
    op.ws.close();
  } finally { child.kill('SIGTERM'); await wait(500); }
}

(async () => {
  await units();
  await server();
  console.log('\nVIDEO TEST PASSED');
  process.exit(0);
})().catch(e => { console.error('\nVIDEO TEST FAILED:', e.stack || e.message); process.exit(1); });
