// Records every camera with video to disk during the show, with a marker for every cue
// fired (and every note), so the recording can be jumped through cue by cue afterwards.
// Files: <Show Control folder>/Recordings/<date time show>/<camera>.mp4 + session.json
// The MP4s come straight from the video relay (no re-encoding, so it is light on the computer)
// and play in Safari, Chrome and VLC.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');

const safe = s => String(s).replace(/[\\/:*?"<>|#%]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60) || 'camera';
const stamp = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')}`;

class Recorder extends EventEmitter {
  // cameras(): [{ id, name }] of cameras that have video right now
  constructor({ dir, log, mp4Url, cameras, showName }) {
    super();
    Object.assign(this, { dir, log, mp4Url, cameras, showName });
    this.session = null; this.auto = false;
  }

  freeBytes() { try { const s = fs.statfsSync(fs.existsSync(this.dir) ? this.dir : path.dirname(this.dir)); return s.bavail * s.bsize; } catch { return null; } }

  state() {
    const s = this.session;
    return { on: !!s, auto: this.auto, free: this.freeBytes(), started: s?.started || null, folder: s?.folder || null,
      cams: s ? s.cams.map(c => ({ id: c.id, name: c.name, bytes: c.bytes, ok: !!c.req && c.flowing })) : [], markers: s?.markers.length || 0 };
  }

  start(who) {
    if (this.session) return this.state();
    const cams = this.cameras();
    const now = new Date();
    let folder = `${stamp(now)} ${safe(this.showName())}`;
    for (let n = 2; fs.existsSync(path.join(this.dir, folder)); n++) folder = `${stamp(now)} ${safe(this.showName())} (${n})`;
    fs.mkdirSync(path.join(this.dir, folder), { recursive: true });
    const s = this.session = { folder, show: this.showName(), started: now.getTime(), ended: null, markers: [], cams: cams.map(c => ({ id: c.id, name: c.name, files: [], bytes: 0 })) };
    this.log('cmd', `recording started by ${who}${cams.length ? ` (${cams.map(c => c.name.split(' · ')[0]).join(', ')})` : ': no cameras with video, cue markers only'}`);
    const free = this.freeBytes();
    if (free != null && free < 5e9) this.log('warn', `only ${(free / 1e9).toFixed(1)} GB of disk space left for recordings`);
    for (const c of s.cams) this.pull(c);
    this.save();
    this.tick = setInterval(() => { this.emit('changed'); this.save(); }, 2000);
    this.emit('changed');
    return this.state();
  }

  // One camera: read the relay's MP4 into a file. If the camera drops out, carry on in a new part.
  pull(c) {
    const s = this.session; if (!s) return;
    const base = safe(c.name.split(' · ')[0]);
    const file = c.files.length ? `${base} (part ${c.files.length + 1}).mp4` : `${base}.mp4`;
    const entry = { file, start: Date.now() - s.started, end: null };
    let out = null;
    c.flowing = false;
    const again = () => {
      if (entry.end == null) entry.end = Date.now() - s.started;
      c.req = null; c.flowing = false;
      if (this.session === s) c.retry = setTimeout(() => this.pull(c), 3000);
    };
    c.req = http.get(this.mp4Url(c.id), res => {
      if (res.statusCode !== 200) { res.resume(); return again(); }
      res.once('data', () => {
        c.flowing = true;
        entry.start = Date.now() - s.started; // the file starts when the first video arrives
        c.files.push(entry);
        this.emit('changed');
      });
      res.on('data', d => {
        if (!out) out = fs.createWriteStream(path.join(this.dir, s.folder, file));
        out.write(d); c.bytes += d.length;
      });
      res.on('end', () => { out?.end(); again(); });
      res.on('error', () => { out?.end(); again(); });
    });
    c.req.on('error', () => { out?.end(); again(); });
  }

  mark(kind, label, extra = {}) {
    const s = this.session; if (!s) return;
    s.markers.push({ t: Date.now() - s.started, at: Date.now(), kind, label, ...extra });
    this.save();
  }

  stop(who) {
    const s = this.session; if (!s) return this.state();
    this.session = null;
    clearInterval(this.tick);
    s.ended = Date.now();
    for (const c of s.cams) {
      clearTimeout(c.retry);
      for (const f of c.files) if (f.end == null) f.end = s.ended - s.started;
      c.req?.destroy();
    }
    this.save(s);
    const gb = s.cams.reduce((a, c) => a + c.bytes, 0) / 1e9;
    this.log('cmd', `recording stopped by ${who}: ${Math.round((s.ended - s.started) / 60000)} min, ${s.markers.length} markers, ${gb.toFixed(2)} GB in Recordings/${s.folder}`);
    this.emit('changed');
    return this.state();
  }

  save(s = this.session) {
    if (!s) return;
    const out = { show: s.show, started: s.started, ended: s.ended, markers: s.markers,
      cams: s.cams.map(c => ({ id: c.id, name: c.name, files: c.files.filter(f => fs.existsSync(path.join(this.dir, s.folder, f.file))) })) };
    try { fs.writeFileSync(path.join(this.dir, s.folder, 'session.json'), JSON.stringify(out, null, 1)); }
    catch (e) { this.log('warn', `could not save recording markers: ${e.message}`); }
  }

  list() {
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch { return []; }
    return names.map(folder => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(this.dir, folder, 'session.json'), 'utf8'));
        const bytes = j.cams.flatMap(c => c.files).reduce((a, f) => { try { return a + fs.statSync(path.join(this.dir, folder, f.file)).size; } catch { return a; } }, 0);
        return { folder, show: j.show, started: j.started, ended: j.ended || (this.session?.folder === folder ? null : j.started), live: this.session?.folder === folder, cams: j.cams.length, markers: j.markers.length, bytes };
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.started - a.started);
  }

  read(folder) {
    if (!this.list().some(r => r.folder === folder)) throw new Error('No such recording');
    return { folder, ...JSON.parse(fs.readFileSync(path.join(this.dir, folder, 'session.json'), 'utf8')) };
  }

  remove(folder, who) {
    if (this.session?.folder === folder) throw new Error('Stop the recording first');
    if (!this.list().some(r => r.folder === folder)) throw new Error('No such recording');
    fs.rmSync(path.join(this.dir, folder), { recursive: true, force: true });
    this.log('cmd', `recording ${folder} deleted by ${who}`);
  }
}

module.exports = Recorder;
