// Shure networked wireless receivers (ULX-D, QLX-D, SLX-D, Axient Digital). They share one
// plain-text protocol on TCP port 2202:  "< GET 1 BATT_BARS >"  →  "< REP 1 BATT_BARS 004 >".
// Channel 0 means every channel. With METER_RATE set, the receiver also streams
//   < SAMPLE 1 ALL <antenna> <rf level(s)> <audio level> >
// No setup on the receiver beyond a fixed IP address (the same connection Wireless Workbench uses).
const net = require('net');
const Driver = require('./base');

const UNKNOWN_BARS = 255, UNKNOWN_MINUTES = 65534; // 65534 "calculating", 65535 unknown
const POLL = ['CHAN_NAME', 'TX_TYPE', 'BATT_BARS', 'BATT_RUN_TIME', 'BATT_CHARGE'];

class ShureDriver extends Driver {
  constructor(cfg) {
    super(cfg);
    this.kind = 'receiver';
    const n = Number(cfg.channels ?? 4);
    this.state = {
      model: cfg.model || 'Shure',
      // tx: transmitter type, null when no pack is switched on and linked
      channels: Array.from({ length: n }, (_, i) => ({ n: i + 1, name: `CH${i + 1}`, tx: null, batteryBars: null, batteryMinutes: null, batteryPercent: null, rf: null, audio: null, antenna: null })),
    };
    this.buf = '';
  }

  start() { this.setStatus('connecting'); this.connect(); this.watchdog(20000); }

  connect() {
    const { host, port = 2202 } = this.cfg;
    const sock = net.connect(port, host);
    sock.setEncoding('ascii');
    sock.on('connect', () => {
      this.log(`connected ${host}:${port}`);
      this.write('GET 0 ALL');
      this.state.channels.forEach(c => this.write(`SET ${c.n} METER_RATE ${String(this.cfg.meterMs ?? 1000).padStart(5, '0')}`));
    });
    sock.on('data', d => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('>')) >= 0) { this.onLine(this.buf.slice(0, i).replace(/^[^<]*</, '').trim()); this.buf = this.buf.slice(i + 1); }
      if (this.buf.length > 4096) this.buf = '';
    });
    sock.on('error', e => this.log(e.message, 'warn'));
    sock.on('close', () => {
      this.sock = null; this.setStatus('offline');
      if (!this.stopped) this.retry = setTimeout(() => this.connect(), 3000);
    });
    this.sock = sock;
    clearInterval(this.poll);
    this.poll = setInterval(() => POLL.forEach(p => this.write(`GET 0 ${p}`)), 10000);
  }

  write(cmd) { if (this.sock && !this.sock.destroyed) this.sock.write(`< ${cmd} >`); }

  // "REP 2 BATT_BARS 004", "REP 1 CHAN_NAME {Lead M    }", "SAMPLE 1 ALL XB 090 033"
  onLine(line) {
    const m = line.match(/^(REP|SAMPLE)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (!m) return;
    this.seen();
    const [, verb, ch, key, rest] = m;
    const c = this.state.channels[Number(ch) - 1];
    if (!c) return;
    const val = rest.trim(), num = Number(val);
    const before = JSON.stringify(c);
    if (verb === 'SAMPLE') {
      const [ant, ...nums] = val.split(/\s+/);
      const v = nums.map(Number).filter(x => !isNaN(x));
      c.antenna = ant;
      if (v.length >= 2) { c.rf = Math.max(...v.slice(0, -1)) - 128; c.audio = v.at(-1) - 50; } // dBm, dBFS
    } else switch (key) {
      case 'CHAN_NAME': c.name = val.replace(/^\{|\}$/g, '').trim() || c.name; break;
      case 'TX_TYPE': c.tx = /^UNKN|^UNKNOWN/.test(val) ? null : val; if (!c.tx) Object.assign(c, { batteryBars: null, batteryMinutes: null, batteryPercent: null, rf: null, audio: null }); break;
      case 'BATT_BARS': c.batteryBars = num >= UNKNOWN_BARS || isNaN(num) ? null : num; break;
      case 'BATT_RUN_TIME': c.batteryMinutes = num >= UNKNOWN_MINUTES || isNaN(num) ? null : num; break;
      case 'BATT_CHARGE': c.batteryPercent = num >= UNKNOWN_BARS || isNaN(num) ? null : num; break;
      case 'RX_RF_LVL': c.rf = isNaN(num) ? null : num - 128; break;
      case 'AUDIO_LVL': c.audio = isNaN(num) ? null : num - 50; break;
      default: return;
    }
    if (JSON.stringify(c) !== before) this.changed();
  }

  async command(cmd, a = {}) {
    switch (cmd) {
      case 'flash': // make the receiver's channel display blink, to find it in the rack
        this.write(`SET ${a.channel ?? 0} FLASH ON`);
        return { outcome: this.sock ? 'sent' : 'offline' };
      case 'raw': this.write(String(a.line)); return { outcome: 'sent' };
      default: return super.command(cmd);
    }
  }

  stop() { super.stop(); this.stopped = true; clearTimeout(this.retry); clearInterval(this.poll); this.sock?.destroy(); }
}

module.exports = ShureDriver;
