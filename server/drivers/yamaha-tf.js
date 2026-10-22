// Yamaha TF1/TF3/TF5 via the Yamaha remote control protocol (plain text over TCP port 49280,
// same family as CL/QL/RIVAGE "RCP"). Fader levels are in 0.01 dB; -32768 means -inf.
// Mixer must be on the same subnet; no setup on the desk beyond its IP address.
const net = require('net');
const Driver = require('./base');

const NEG_INF = -32768;
// Parameter paths (TF series). Verify against the TF parameter list for your firmware.
const P = {
  inLevel: 'MIXER:Current/InCh/Fader/Level',
  inOn: 'MIXER:Current/InCh/Fader/On',
  inName: 'MIXER:Current/InCh/Label/Name',
  dcaLevel: 'MIXER:Current/DCA/Fader/Level',
  dcaOn: 'MIXER:Current/DCA/Fader/On',
  dcaName: 'MIXER:Current/DCA/Label/Name',
  stLevel: 'MIXER:Current/St/Fader/Level',
  stOn: 'MIXER:Current/St/Fader/On',
};

class YamahaTFDriver extends Driver {
  constructor(cfg) {
    super(cfg);
    const n = cfg.channels ?? 32, d = cfg.dcas ?? 8;
    const strip = (i, prefix) => ({ index: i, name: `${prefix}${i + 1}`, level: NEG_INF, on: true });
    this.state = {
      channels: Array.from({ length: n }, (_, i) => strip(i, 'CH')),
      dcas: Array.from({ length: d }, (_, i) => strip(i, 'DCA')),
      master: { level: NEG_INF, on: true },
      lastScene: null,
    };
    this.buf = '';
  }

  start() { this.setStatus('connecting'); this.connect(); this.watchdog(10000); }

  connect() {
    const { host, port = 49280 } = this.cfg;
    const sock = net.connect(port, host);
    sock.setEncoding('utf8');
    sock.on('connect', () => { this.log(`connected ${host}:${port}`); this.seen(); this.syncAll(); });
    sock.on('data', d => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) { this.onLine(this.buf.slice(0, i).trim()); this.buf = this.buf.slice(i + 1); }
    });
    sock.on('error', e => this.log(e.message, 'warn'));
    sock.on('close', () => {
      this.sock = null; this.setStatus('offline');
      if (!this.stopped) this.retry = setTimeout(() => this.connect(), 3000);
    });
    this.sock = sock;
    clearInterval(this.ka);
    this.ka = setInterval(() => this.write('devstatus runmode'), 3000);
  }

  write(line) { if (this.sock && !this.sock.destroyed) this.sock.write(line + '\n'); }

  syncAll() {
    this.state.channels.forEach((_, i) => { this.write(`get ${P.inLevel} ${i} 0`); this.write(`get ${P.inOn} ${i} 0`); this.write(`get ${P.inName} ${i} 0`); });
    this.state.dcas.forEach((_, i) => { this.write(`get ${P.dcaLevel} ${i} 0`); this.write(`get ${P.dcaOn} ${i} 0`); this.write(`get ${P.dcaName} ${i} 0`); });
    this.write(`get ${P.stLevel} 0 0`); this.write(`get ${P.stOn} 0 0`);
  }

  // e.g.  OK get MIXER:Current/InCh/Fader/Level 3 0 -1000
  //       NOTIFY set MIXER:Current/InCh/Fader/On 3 0 0 "OFF"
  onLine(line) {
    if (!line) return;
    this.seen();
    const m = line.match(/^(OK|NOTIFY|OKm)\s+(?:get|set)\s+(\S+)\s+(\d+)\s+(\d+)\s+(?:"([^"]*)"|(-?\d+))/);
    if (!m) { if (line.startsWith('ERROR')) this.log(line, 'warn'); return; }
    const [, , path, x, , str, num] = m;
    const i = Number(x);
    const val = str !== undefined ? str : Number(num);
    const s = this.state;
    const set = (arr, key) => { if (arr[i]) { arr[i][key] = key === 'on' ? !!val : val; this.changed(); } };
    switch (path) {
      case P.inLevel: return set(s.channels, 'level');
      case P.inOn: return set(s.channels, 'on');
      case P.inName: return set(s.channels, 'name');
      case P.dcaLevel: return set(s.dcas, 'level');
      case P.dcaOn: return set(s.dcas, 'on');
      case P.dcaName: return set(s.dcas, 'name');
      case P.stLevel: s.master.level = val; return this.changed();
      case P.stOn: s.master.on = !!val; return this.changed();
    }
  }

  async command(cmd, a = {}) {
    const lvl = v => (v === '-inf' || v <= -138 ? NEG_INF : Math.round(Math.min(10, Number(v)) * 100)); // dB → 0.01 dB
    switch (cmd) {
      case 'level': // { strip: 'ch'|'dca'|'master', index, db }
        return this.write(`set ${a.strip === 'dca' ? P.dcaLevel : a.strip === 'master' ? P.stLevel : P.inLevel} ${a.index ?? 0} 0 ${lvl(a.db)}`);
      case 'on':
        return this.write(`set ${a.strip === 'dca' ? P.dcaOn : a.strip === 'master' ? P.stOn : P.inOn} ${a.index ?? 0} 0 ${a.on ? 1 : 0}`);
      case 'scene': // { bank: 'a'|'b', scene }
        this.patch({ lastScene: `${(a.bank || 'a').toUpperCase()}${a.scene}` });
        return this.write(`ssrecall_ex scene_${a.bank || 'a'} ${a.scene}`);
      case 'raw': return this.write(String(a.line));
      default: return super.command(cmd);
    }
  }

  stop() { super.stop(); this.stopped = true; clearTimeout(this.retry); clearInterval(this.ka); this.sock?.destroy(); }
}

YamahaTFDriver.NEG_INF = NEG_INF;
module.exports = YamahaTFDriver;
