// Allen & Heath SQ, Qu, Avantis and dLive mixers: scene recall over "MIDI over TCP/IP".
// Ports: SQ, Qu and Avantis 51325; dLive 51328 (MixRack) or 51329 (surface).
// A scene is recalled with Bank Select (CC 0) + Program Change on the desk's MIDI channel,
// scenes counted from 1: bank = (scene - 1) div 128, program = (scene - 1) mod 128.
// Wording from the A&H MIDI protocol documents; not yet checked on a real desk.
const net = require('net');
const Driver = require('./base');

const PORTS = { sq: 51325, qu: 51325, avantis: 51325, dlive: 51328 };

class AllenHeathDriver extends Driver {
  constructor(cfg) {
    super(cfg);
    this.state = { model: cfg.series || 'sq', lastScene: null };
  }
  start() {
    this.setStatus('connecting');
    const connect = () => {
      const sock = net.connect(this.cfg.port || PORTS[this.cfg.series] || 51325, this.cfg.host);
      sock.setKeepAlive(true, 5000);
      sock.on('connect', () => { this.log('connected'); this.seen(); });
      sock.on('data', () => this.seen());
      sock.on('error', e => this.log(e.message, 'warn'));
      sock.on('close', () => { this.sock = null; this.setStatus('offline'); if (!this.stopped) this.retry = setTimeout(connect, 3000); });
      this.sock = sock;
    };
    connect();
  }
  midi(bytes) {
    if (!this.sock?.writable || this.sock.connecting) throw new Error('not connected');
    this.sock.write(Buffer.from(bytes));
  }
  get ch() { return (Math.max(1, Math.min(16, Number(this.cfg.midiChannel) || 1)) - 1); }
  async command(cmd, a = {}) {
    switch (cmd) {
      case 'scene': {
        const n = Math.max(1, Math.round(Number(a.scene) || 1)) - 1;
        this.patch({ lastScene: String(n + 1) });
        return this.midi([0xb0 | this.ch, 0x00, (n >> 7) & 0x7f, 0xc0 | this.ch, n & 0x7f]);
      }
      case 'midi': return this.midi(String(a.bytes || '').trim().split(/[\s,]+/).map(x => parseInt(x, 16) & 0xff));
      default: return super.command(cmd);
    }
  }
  stop() { super.stop(); this.stopped = true; clearTimeout(this.retry); this.sock?.destroy(); }
}

AllenHeathDriver.meta = {
  label: 'Allen & Heath mixer (SQ, Qu, Avantis, dLive)', category: 'sound',
  fields: [['series', 'select:sq=SQ (SQ-5, SQ-6, SQ-7)|qu=Qu (Qu-16, Qu-24, Qu-32, Qu-Pac, Qu-SB)|avantis=Avantis|dlive=dLive', 'Model'],
    ['midiChannel', 'number', 'MIDI channel set on the desk (1-16)', '1'], ['port', 'port', 'Port (leave empty for the usual one)', '']],
  defaults: { series: 'sq', midiChannel: 1 },
  help: [
    'Plug the desk\'s network port into the show network switch and give it a fixed address (SQ/Qu: Setup > Network; dLive: Surface > Network).',
    'Check its MIDI channel (SQ: Setup > Control > MIDI; Qu: Setup > Control > MIDI) and type it here. Make sure scene recall by MIDI is allowed there.',
    'Type the address and tap Test. Scene numbers are the ones shown on the desk.',
  ],
  commands: { scene: [['scene', 'number', 1, 'Scene']], midi: [['bytes', 'text', '', 'Raw MIDI bytes (hex)']] },
  commandLabels: { scene: 'Recall scene', midi: 'Send MIDI' },
};

module.exports = AllenHeathDriver;
