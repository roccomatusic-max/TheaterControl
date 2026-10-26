// Live camera video. Show Control runs go2rtc (a small video relay, bundled with the downloads)
// and writes its settings from the camera list, so nobody has to set it up by hand.
// go2rtc pulls each camera's RTSP feed once and hands it to every iPad as WebRTC (well under
// a second of delay). It only listens on this computer; iPads reach it through Show Control
// at /video/..., behind the same PIN as everything else. Phones can send their camera in too.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..');
const EXE = process.platform === 'win32' ? 'go2rtc.exe' : 'go2rtc';
const PHONE_SLOTS = 4;

// Bundled next to Node in the downloads (runtime/), or set GO2RTC_BIN, or installed on the PATH.
function findBinary() {
  const arch = process.arch === 'x64' ? 'x64' : process.arch;
  const tries = [process.env.GO2RTC_BIN, path.join(ROOT, 'runtime', `${process.platform}-${arch}`, EXE), path.join(ROOT, 'runtime', EXE),
    ...(process.env.PATH || '').split(path.delimiter).map(p => path.join(p, EXE))];
  return tries.find(p => { try { return p && fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

const q = s => JSON.stringify(String(s)); // JSON strings are valid YAML strings

// rtsp:// (or http:// MJPEG) address → go2rtc source. Two-way audio is never wanted here.
const source = url => (/^rtsps?:/.test(url) && !url.includes('#') ? `${url}#backchannel=0` : url);

function yaml({ apiPort, webrtcPort, rtspPort, streams }) {
  return [
    '# Written by Show Control from your camera list. Changes made here are replaced.',
    'api:', `  listen: ${q(`127.0.0.1:${apiPort}`)}`,
    // RTSP on this computer only: OBS (or VLC) here can take rtsp://127.0.0.1:<port>/<camera>
    'rtsp:', `  listen: ${q(`127.0.0.1:${rtspPort}`)}`, 'rtmp:', '  listen: ""', 'srtp:', '  listen: ""',
    'webrtc:', `  listen: ${q(`:${webrtcPort}`)}`,
    'log:', '  level: warn',
    'streams:',
    ...Object.entries(streams).map(([id, url]) => (url ? `  ${id}: ${q(source(url))}` : `  ${id}:`)),
    '',
  ].join('\n');
}

// What iPads may ask go2rtc for: playing and sending video. Not its settings pages or
// stream list, which would show camera passwords.
const ALLOWED = /^\/api\/(webrtc|stream\.m3u8|stream\.mp4|hls\/[\w.]+|frame\.jpeg)$/;

class Video extends EventEmitter {
  constructor({ dir, log, apiPort = 18984, webrtcPort = 8555, rtspPort = 18554 }) {
    super();
    this.dir = dir; this.log = log; this.apiPort = apiPort; this.webrtcPort = webrtcPort; this.rtspPort = rtspPort;
    this.bin = findBinary();
    this.streams = {};
    this.status = this.bin ? 'off' : 'missing';
    this.phones = new Map(); // slot → name
  }

  // cameras: [{ id, url }] for every camera with a video address.
  configure(cameras) {
    const streams = {};
    for (const c of cameras) streams[c.id] = c.url;
    for (let i = 1; i <= PHONE_SLOTS; i++) streams[`phone${i}`] = '';
    const changed = JSON.stringify(streams) !== JSON.stringify(this.streams);
    this.streams = streams;
    if (changed && this.proc) this.restart();
  }

  has(id) { return id in this.streams; }

  start() {
    if (!this.bin) {
      this.log('warn', 'live camera video is not available: the go2rtc video relay was not found. The downloads include it; when running from source, see README > Video.');
      return;
    }
    this.stopping = false;
    // A relay left running by a Show Control that was killed outright would hold the ports: stop it first.
    const pidFile = path.join(this.dir, '.go2rtc.pid');
    let old = 0; try { old = Number(fs.readFileSync(pidFile, 'utf8')); } catch { /* none */ }
    this.ping().then(async up => {
      if (up && old) { try { process.kill(old); } catch { /* already gone */ } await new Promise(r => setTimeout(r, 700)); }
      this.spawn();
    });
  }

  spawn() {
    const file = path.join(this.dir, '.go2rtc.yaml');
    try { fs.mkdirSync(this.dir, { recursive: true }); fs.writeFileSync(file, yaml(this), { mode: 0o600 }); }
    catch (e) { this.log('error', `could not write the video settings: ${e.message}`); return; }
    this.setStatus('starting');
    const started = Date.now();
    const p = this.proc = spawn(this.bin, ['-config', file], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    if (p.pid) try { fs.writeFileSync(path.join(this.dir, '.go2rtc.pid'), String(p.pid)); } catch { /* not important */ }
    let tail = '';
    const onOut = d => {
      tail = (tail + d).slice(-4000);
      for (const line of String(d).split('\n')) {
        if (/ (ERR|WRN|FTL) /.test(line)) this.relayLog(line);
        if (/\[api\] listen/.test(line)) this.setStatus('running');
      }
    };
    p.stdout.on('data', onOut); p.stderr.on('data', onOut);
    // go2rtc logs nothing at "warn" level when it starts cleanly, so also check its API answers.
    const ready = setInterval(() => this.ping().then(ok => { if (ok) { clearInterval(ready); this.setStatus('running'); } }), 500);
    p.on('error', e => this.log('error', `video relay could not start: ${e.message}`));
    p.on('exit', code => {
      clearInterval(ready);
      if (this.proc === p) this.proc = null;
      if (this.stopping || p.replaced) return;
      this.setStatus('failed');
      const quick = Date.now() - started < 10000;
      this.fails = quick ? (this.fails || 0) + 1 : 0;
      const msg = /address already in use|bind:/i.test(tail) ? ` Port ${this.webrtcPort}, ${this.apiPort} or ${this.rtspPort} is used by another program.` : '';
      this.log('warn', `video relay stopped (code ${code}).${msg} Starting it again.`);
      this.retry = setTimeout(() => this.spawn(), Math.min(30, 2 ** (this.fails || 0)) * 1000);
    });
  }

  // go2rtc's own messages, without the source-code location, at most one per stream per minute.
  relayLog(line) {
    const msg = line.replace(/^\S+ \w+ /, '').replace(/\S+\.go:\d+ > /, '').trim();
    const key = msg.slice(0, 60); this.seenLog ||= new Map();
    if (Date.now() - (this.seenLog.get(key) || 0) < 60000) return;
    this.seenLog.set(key, Date.now());
    this.log('warn', `relay: ${msg.replace(/\s*\n\s*/g, ' ').slice(0, 300)}`);
  }

  restart() {
    if (!this.proc) return this.spawn();
    const old = this.proc; old.replaced = true; this.proc = null;
    old.once('exit', () => this.spawn());
    old.kill();
  }

  stop() { this.stopping = true; clearTimeout(this.retry); this.proc?.kill(); this.proc = null; this.setStatus(this.bin ? 'off' : 'missing'); }

  setStatus(s) { if (s !== this.status) { this.status = s; this.emit('status', s); } }

  ping() {
    return new Promise(res => {
      const r = http.get({ host: '127.0.0.1', port: this.apiPort, path: '/api', timeout: 1000 }, x => { x.resume(); res(x.statusCode === 200); });
      r.on('error', () => res(false)); r.on('timeout', () => { r.destroy(); res(false); });
    });
  }

  // Where the recorder reads a camera from (fragmented MP4, plays in any browser or VLC).
  mp4Url(id) { return `http://127.0.0.1:${this.apiPort}/api/stream.mp4?src=${encodeURIComponent(id)}`; }

  // Express handler for /video/*: only the allowed go2rtc calls, passed straight through.
  proxy(req, res) {
    const u = new URL(req.url, 'http://x');
    if (!ALLOWED.test(u.pathname)) return res.status(404).end();
    const src = u.searchParams.get('src') || u.searchParams.get('dst');
    if (src && !this.has(src)) return res.status(404).type('text').send('No such camera');
    if (!this.proc || this.status !== 'running') return res.status(503).type('text').send(this.status === 'missing' ? 'Video relay not installed' : 'Video relay starting');
    const up = http.request({ host: '127.0.0.1', port: this.apiPort, method: req.method, path: u.pathname + u.search,
      headers: { 'content-type': req.headers['content-type'] || 'application/sdp', ...(req.headers.range ? { range: req.headers.range } : {}) } }, r => {
      res.status(r.statusCode);
      for (const h of ['content-type', 'content-length', 'cache-control', 'location', 'content-range', 'accept-ranges']) if (r.headers[h]) res.setHeader(h, r.headers[h]);
      r.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.status(502).end(); else res.end(); });
    req.on('aborted', () => up.destroy());
    res.on('close', () => up.destroy());
    req.pipe(up);
  }

  // Phone cameras: a free slot for a phone that wants to send its camera, or null if all are busy.
  claimPhone(name) {
    for (let i = 1; i <= PHONE_SLOTS; i++) if (!this.phones.has(`phone${i}`)) { this.phones.set(`phone${i}`, name); return `phone${i}`; }
    return null;
  }
  releasePhone(slot) { this.phones.delete(slot); }
}

// Addresses this computer can be reached at, for the "use this address" hints.
const lanIPs = () => Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')).map(i => i.address);

module.exports = { Video, findBinary, yaml, ALLOWED, PHONE_SLOTS, lanIPs };
