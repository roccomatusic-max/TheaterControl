// A camera that only gives video: a fixed or infrared backstage camera, or a phone (see
// /phone). Nothing to control; it shows as online while its video port answers.
const net = require('net');
const Driver = require('./base');

class CameraDriver extends Driver {
  constructor(cfg) {
    super(cfg);
    this.kind = 'camera';
    this.state = { stream: cfg.stream || (cfg.video ? { type: 'live', src: cfg.id } : null), night: !!cfg.night, phone: !!cfg.phone };
  }

  start() {
    if (this.cfg.phone) return this.setStatus('online'); // a phone is online while it is connected
    let target;
    try { const u = new URL(this.cfg.video); target = [Number(u.port) || (u.protocol === 'http:' ? 80 : 554), u.hostname]; }
    catch { target = this.cfg.host ? [554, this.cfg.host] : null; }
    if (!target) return this.setStatus('offline');
    this.setStatus('connecting');
    const check = () => {
      const s = net.connect(...target);
      s.setTimeout(3000);
      s.on('connect', () => { this.seen(); s.destroy(); });
      s.on('timeout', () => s.destroy());
      s.on('error', () => {});
    };
    check();
    this.poll = setInterval(check, this.cfg.pollMs || 5000);
    this.watchdog(12000);
  }

  async command(cmd, a = {}) {
    if (cmd === 'night') { this.patch({ night: !!a.on }); return { outcome: 'ok' }; } // view only: brightens the picture on the iPad
    return super.command(cmd);
  }

  stop() { super.stop(); clearInterval(this.poll); }
}

module.exports = CameraDriver;
