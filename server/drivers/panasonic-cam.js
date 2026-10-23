// Panasonic PTZ cameras (AW-UE, AW-HE and AK-UB series) over their web command interface:
// GET /cgi-bin/aw_ptz?cmd=%23<command>&res=1. Same commands and state as the VISCA "ptz" driver,
// so the Cameras screen and cue steps work the same.
//   #R00-#R99 recall preset 1-100 · #M00 store · #PTSxxyy pan/tilt speed (50 = stop)
//   #Zxx zoom speed (50 = stop) · #O1/#O0 power · #O? → p1 (on) / p0 (standby)
const Driver = require('./base');
const { request } = require('../lib/http');
const { result } = require('../lib/outcome');

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const two = n => String(n).padStart(2, '0');
// joystick -1..1 → 01..99 with 50 = stop
const speed = v => two(clamp(Math.round(50 + clamp(Number(v) || 0, -1, 1) * 49), 1, 99));

class PanasonicCamDriver extends Driver {
  constructor(cfg) {
    super(cfg);
    this.kind = 'camera';
    this.state = { power: null, lastPreset: null, presets: cfg.presets || [], stream: cfg.stream || (cfg.video ? { type: 'live', src: cfg.id } : null), tally: false };
  }
  start() {
    this.setStatus('connecting');
    this.poll();
    this.timer = setInterval(() => this.poll(), this.cfg.pollMs || 3000);
  }
  async aw(cmd, cgi = 'aw_ptz') {
    const r = await request({ host: this.cfg.host, port: this.cfg.port || 80, path: `/cgi-bin/${cgi}?cmd=${encodeURIComponent(cmd)}&res=1`,
      user: this.cfg.username, password: this.cfg.password, timeout: 2000 });
    if (r.error) { this.log(r.error, 'warn'); this.setStatus('offline'); throw new Error(r.error); }
    if (r.status === 401) throw new Error('camera refused the username or password');
    this.seen();
    return r.body.trim();
  }
  async poll() {
    try {
      const p = await this.aw('#O');
      if (/^p[0-3]/.test(p)) this.patch({ power: p === 'p1' });
    } catch { /* offline already noted */ }
  }
  // [command, cgi] for each operator command; the camera answers every one, so "ok" means it took it
  commandFor(cmd, a) {
    switch (cmd) {
      case 'move': return [`#PTS${speed(a.pan)}${speed(a.tilt)}`]; // tilt > 0 = up, as in the VISCA driver
      case 'zoom': return [`#Z${speed(a.speed)}`];
      case 'preset': this.patch({ lastPreset: Number(a.preset) }); return [`#R${two(clamp(Number(a.preset) - 1, 0, 99))}`];
      case 'store': return [`#M${two(clamp(Number(a.preset) - 1, 0, 99))}`];
      case 'home': return ['#APC80008000'];
      case 'power': return [a.on ? '#O1' : '#O0'];
      case 'focus': return [a.mode === 'manual' ? '#D10' : '#D11'];
      case 'tally': this.patch({ tally: !!a.on }); return [`TLR:${a.on ? 1 : 0}`, 'aw_cam'];
      default: return null;
    }
  }
  async command(cmd, a = {}) {
    const c = this.commandFor(cmd, a);
    if (!c) return super.command(cmd);
    try { await this.aw(...c); return result('ok'); }
    catch (e) { return result(/ETIMEDOUT/.test(e.message) ? 'timeout' : /refused the username/.test(e.message) ? 'auth_failed' : 'offline', e.message); }
  }
  stop() { super.stop(); clearInterval(this.timer); }
}

PanasonicCamDriver.meta = {
  label: 'Panasonic PTZ camera (AW-UE / AW-HE)', category: 'cameras',
  fields: [['username', 'text', 'Username (if you set one)', ''], ['password', 'password', 'Password', ''],
    ['video', 'video', 'Video address', 'rtsp://… (tap Find video)']],
  help: [
    'Plug the camera into the show network switch and give it a fixed address (Panasonic\'s Easy IP Setup tool finds it, or use the camera\'s menu).',
    'Open the camera\'s web page (type its address into a browser). Under Maintenance or User mng., check whether a login is needed for control; if so, type it here.',
    'Type the address and tap Test. Then tap Find video to fill in the video address (usually rtsp://<address>:554/MediaInput/h264/stream_1).',
    'No picture? On the camera\'s web page, under Setup > Video over IP, check the H.264 stream is on and RTSP is allowed.',
  ],
  commands: { preset: [['preset', 'preset', 1, 'Shot']], home: [], tally: [['on', 'bool:On|Off', true, 'Tally']], power: [['on', 'bool:On|Off', true, 'Power']] },
  commandLabels: { preset: 'Go to preset shot', home: 'Home', tally: 'Tally light', power: 'Power' },
};

module.exports = PanasonicCamDriver;
