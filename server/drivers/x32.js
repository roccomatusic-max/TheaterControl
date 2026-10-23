// Behringer X32 / Midas M32 (OSC UDP 10023) and Behringer X Air / Midas MR (OSC UDP 10024).
// No setup on the desk beyond its network address. Two-way: /xremote makes the desk push every
// change for 10 s, so we renew it. State uses the same shape and units as the Yamaha TF driver
// (levels in 0.01 dB, -32768 = -inf) so cues and fader screens work the same with either desk.
const dgram = require('dgram');
const osc = require('../lib/osc');
const Driver = require('./base');

const NEG_INF = -32768;
// X32 fader law: 0..1 float ↔ dB in four straight segments (-inf, -90..+10 dB)
function toDb(f) {
  if (f <= 0) return -Infinity;
  if (f >= 0.5) return f * 40 - 30;
  if (f >= 0.25) return f * 80 - 50;
  if (f >= 0.0625) return f * 160 - 70;
  return f * 480 - 90;
}
function toFloat(db) {
  if (db === -Infinity || db <= -90) return 0;
  db = Math.min(10, db);
  const f = db >= -10 ? (db + 30) / 40 : db >= -30 ? (db + 50) / 80 : db >= -60 ? (db + 70) / 160 : (db + 90) / 480;
  return Math.round(f * 1023) / 1023; // the desk has 1024 fader steps
}
const two = n => String(n).padStart(2, '0');

class X32Driver extends Driver {
  constructor(cfg) {
    super(cfg);
    this.air = cfg.series === 'xair';
    const n = cfg.channels ?? (this.air ? 16 : 32), d = cfg.dcas ?? (this.air ? 4 : 8);
    const strip = (i, prefix) => ({ index: i, name: `${prefix}${i + 1}`, level: NEG_INF, on: true });
    this.state = {
      model: '', channels: Array.from({ length: n }, (_, i) => strip(i, 'CH')),
      dcas: Array.from({ length: d }, (_, i) => strip(i, 'DCA')), master: { level: NEG_INF, on: true }, lastScene: null,
    };
  }
  get port() { return this.cfg.port || (this.air ? 10024 : 10023); }
  get main() { return this.air ? '/lr/mix' : '/main/st/mix'; }
  path(strip, i, what) {
    if (strip === 'master') return `${this.main}/${what}`;
    if (strip === 'dca') return `/dca/${i + 1}/${what}`;
    return `/ch/${two(i + 1)}/mix/${what}`;
  }

  start() {
    this.setStatus('connecting');
    this.udp = dgram.createSocket('udp4');
    this.udp.on('message', m => this.onPacket(m));
    this.udp.on('error', e => this.log(e.message, 'warn'));
    this.udp.bind(0, () => { this.synced = true; this.hello(); });
    this.ka = setInterval(() => { this.send('/xremote'); this.send('/info'); }, 3000);
    this.watchdog(10000);
  }
  setStatus(s) { if (s === 'offline') this.synced = false; super.setStatus(s); }
  send(address, args = []) { this.udp?.send(osc.encode(address, args), this.port, this.cfg.host); }
  hello() {
    this.send('/info'); this.send('/xremote');
    this.state.channels.forEach((_, i) => { this.send(this.path('ch', i, 'fader')); this.send(this.path('ch', i, 'on')); this.send(`/ch/${two(i + 1)}/config/name`); });
    this.state.dcas.forEach((_, i) => { this.send(this.path('dca', i, 'fader')); this.send(this.path('dca', i, 'on')); this.send(`/dca/${i + 1}/config/name`); });
    this.send(`${this.main}/fader`); this.send(`${this.main}/on`);
  }

  onPacket(pkt) {
    let msgs;
    try { msgs = [].concat(osc.decode(pkt)); } catch { return; }
    const wasOffline = this.status !== 'online';
    this.seen();
    if (wasOffline && !this.synced) { this.synced = true; this.hello(); } // back after a drop-out: read everything again
    for (const { address, args } of msgs) {
      if (address === '/info' || address === '/xinfo') { const model = args.find(a => /X32|M32|XR|MR|X-?AIR/i.test(String(a))); if (model) this.patch({ model }); continue; }
      const v = args[0];
      let m;
      const lvl = f => { const db = toDb(f); return db === -Infinity ? NEG_INF : Math.round(db * 100); };
      if ((m = address.match(/^\/ch\/(\d+)\/mix\/(fader|on)$/))) this.set(this.state.channels[m[1] - 1], m[2], v, lvl);
      else if ((m = address.match(/^\/ch\/(\d+)\/config\/name$/))) { const s = this.state.channels[m[1] - 1]; if (s && v) { s.name = v; this.changed(); } }
      else if ((m = address.match(/^\/dca\/(\d+)\/(fader|on)$/))) this.set(this.state.dcas[m[1] - 1], m[2], v, lvl);
      else if ((m = address.match(/^\/dca\/(\d+)\/config\/name$/))) { const s = this.state.dcas[m[1] - 1]; if (s && v) { s.name = v; this.changed(); } }
      else if ((m = address.match(/^\/(?:main\/st|lr)\/mix\/(fader|on)$/))) this.set(this.state.master, m[1], v, lvl);
    }
  }
  set(s, what, v, lvl) {
    if (!s || v == null) return;
    if (what === 'fader') s.level = lvl(v); else s.on = !!v;
    this.changed();
  }

  async command(cmd, a = {}) {
    const i = Number(a.index) || 0;
    switch (cmd) {
      case 'level': { // { strip: 'ch'|'dca'|'master', index, db }
        const db = a.db === '-inf' ? -Infinity : Number(a.db);
        return this.send(this.path(a.strip, i, 'fader'), [{ type: 'f', value: toFloat(db) }]);
      }
      case 'on': return this.send(this.path(a.strip, i, 'on'), [a.on ? 1 : 0]);
      case 'scene': // number as shown on the desk: X32 scenes 0-99, X Air snapshots 1-64
        this.patch({ lastScene: String(a.scene) });
        return this.air ? this.send('/-snap/load', [Number(a.scene)]) : this.send('/-action/goscene', [Number(a.scene)]);
      case 'raw': return this.send(String(a.address), a.args || []);
      default: return super.command(cmd);
    }
  }

  stop() { super.stop(); clearInterval(this.ka); this.udp?.close(); }
}

X32Driver.meta = {
  label: 'Behringer X32 / Midas M32 / X Air mixer', category: 'sound',
  fields: [['series', 'select:x32=X32 or M32 (full size, Rack, Compact, Producer)|xair=X Air or MR (XR12, XR16, XR18, MR18)', 'Model']],
  defaults: { series: 'x32' },
  help: [
    'Plug the mixer\'s Ethernet (remote) port into the show network switch.',
    'X32/M32: press SETUP, then the Network tab. Turn DHCP off and set a fixed address (for example 10.101.50.21, mask 255.255.0.0). X Air: use X Air Edit > Setup > Network, or the mixer\'s own access point first.',
    'Nothing else to turn on: the same connection X32-Edit and Mixing Station use. Type the address and tap Test.',
  ],
  commands: {
    scene: [['scene', 'number', 1, 'Scene / snapshot number']],
    level: [['strip', 'select:dca|ch|master', 'dca', 'Fader'], ['index', 'n1', 0, 'Number'], ['db', 'number', 0, 'Level dB']],
    on: [['strip', 'select:ch|dca|master', 'ch', 'Fader'], ['index', 'n1', 0, 'Number'], ['on', 'bool:On|Off', true, 'Set to']],
  },
  commandLabels: { scene: 'Recall scene', level: 'Set fader', on: 'Fader on/off' },
};
X32Driver.toDb = toDb; X32Driver.toFloat = toFloat;

module.exports = X32Driver;
