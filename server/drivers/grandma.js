// MA Lighting grandMA consoles and onPC. Both versions take console command-line text
// ("Go+ Sequence 3", "Goto Cue 12 Executor 1.1"):
//  version 2: Telnet (TCP 30000), logs in as a console user. Setup > Console > Global Settings > Telnet: Login Enabled.
//  version 3: OSC over UDP (default port 8000) to /<prefix>/cmd. Menu > In & Out > OSC: add a line,
//             Receive + Receive Command on, port 8000, prefix "gma3". One-way: MA3 does not answer.
// Command wording follows the MA manuals; not yet checked on a real console.
const net = require('net');
const dgram = require('dgram');
const osc = require('../lib/osc');
const Driver = require('./base');

class GrandMADriver extends Driver {
  constructor(cfg) {
    super(cfg);
    this.state = { version: this.v3 ? 3 : 2, lastReply: '' };
  }
  get v3() { return String(this.cfg.version ?? '3') === '3'; }

  start() {
    if (this.v3) {
      this.udp = dgram.createSocket('udp4');
      this.udp.on('error', e => this.log(e.message, 'warn'));
      this.udp.bind(0);
      return this.setStatus('online');
    }
    this.setStatus('connecting');
    const connect = () => {
      const sock = net.connect(this.cfg.port || 30000, this.cfg.host);
      sock.setEncoding('latin1');
      sock.on('connect', () => {
        this.log('telnet connected');
        sock.write(`Login "${this.cfg.user || 'administrator'}" "${this.cfg.password ?? 'admin'}"\r\n`);
      });
      sock.on('data', d => {
        this.seen();
        const last = d.replace(/\x1b\[[0-9;]*m/g, '').trim().split(/\r?\n/).filter(Boolean).slice(-1)[0];
        if (last) this.patch({ lastReply: last.slice(0, 200) });
        if (/login failed|error #?72/i.test(d)) this.log('console refused the login (check user and password)', 'warn');
      });
      sock.on('error', e => this.log(e.message, 'warn'));
      sock.on('close', () => { this.sock = null; this.setStatus('offline'); if (!this.stopped) this.retry = setTimeout(connect, 3000); });
      this.sock = sock;
    };
    connect();
    // keep the telnet session alive and the status honest
    this.ka = setInterval(() => this.sock?.writable && this.sock.write('\r\n'), 5000);
    this.watchdog(15000);
  }

  cmdline(text) {
    text = String(text).replace(/[\r\n]/g, ' ').trim();
    if (!text) throw new Error('empty command');
    if (this.v3) {
      const prefix = String(this.cfg.prefix ?? 'gma3').replace(/^\/+|\/+$/g, '');
      return this.udp.send(osc.encode(`${prefix ? `/${prefix}` : ''}/cmd`, [text]), this.cfg.port || 8000, this.cfg.host);
    }
    if (!this.sock?.writable) throw new Error('not connected');
    this.sock.write(`${text}\r\n`);
  }

  async command(cmd, a = {}) {
    const target = String(a.target || (this.v3 ? 'Sequence 1' : 'Executor 1')).trim();
    const go = this.v3 ? 'Go+' : 'Go';
    switch (cmd) {
      case 'go': return this.cmdline(`${go} ${target}`);
      case 'back': return this.cmdline(`${this.v3 ? 'Go-' : 'GoBack'} ${target}`);
      case 'goto': return this.cmdline(`Goto Cue ${a.cue} ${target}`);
      case 'off': return this.cmdline(`Off ${target}`);
      case 'macro': return this.cmdline(`${go} Macro ${a.macro}`);
      case 'cmdline': return this.cmdline(a.text);
      default: return super.command(cmd);
    }
  }

  stop() { super.stop(); this.stopped = true; clearTimeout(this.retry); clearInterval(this.ka); this.sock?.destroy(); this.udp?.close(); }
}

GrandMADriver.meta = {
  label: 'grandMA lighting console', category: 'lighting',
  oneWayWhen: { version: '3' },
  fields: [['version', 'select:3=grandMA3 (OSC)|2=grandMA2 (Telnet)', 'Version'], ['port', 'port', 'Port (empty = 8000 for MA3, 30000 for MA2)', ''],
    ['prefix', 'text', 'MA3 OSC prefix', 'gma3'], ['user', 'text', 'MA2 user', 'administrator'], ['password', 'password', 'MA2 password', 'admin']],
  defaults: { version: '3' },
  help: [
    'Plug the console (or onPC computer) into the show network and give it a fixed address in its network settings.',
    'grandMA3: open Menu > In & Out > OSC. Add a line with this computer\'s address, port 8000, prefix gma3, and turn on Receive and Receive Command. Turn on "Enable Input" at the top.',
    'grandMA2: open Setup > Console > Global Settings and turn on Telnet "Login Enabled". Use a console user that is allowed to run commands.',
    'Type the console\'s address and tap Test. grandMA3 does not answer back over OSC, so check with "Try it now" in the cue editor.',
  ],
  commands: {
    go: [['target', 'text', 'Sequence 1', 'What (e.g. Sequence 1 or Executor 1.1)']],
    goto: [['cue', 'text', '1', 'Cue'], ['target', 'text', 'Sequence 1', 'On (e.g. Sequence 1)']],
    back: [['target', 'text', 'Sequence 1', 'What']],
    off: [['target', 'text', 'Sequence 1', 'What']],
    macro: [['macro', 'number', 1, 'Macro']],
    cmdline: [['text', 'text', '', 'Command line']],
  },
  commandLabels: { go: 'GO', goto: 'Go to cue', back: 'Back', off: 'Off', macro: 'Fire macro', cmdline: 'Command line' },
};

module.exports = GrandMADriver;
