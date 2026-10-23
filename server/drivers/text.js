// Plain text or bytes over TCP or UDP: the way most switchers, players and show gear take
// remote commands (Blackmagic HyperDeck/Videohub, Watchout, Extron, Kramer, Crestron, ...).
// TCP stays connected (so "online" is real); UDP is fire-and-forget.
const net = require('net');
const dgram = require('dgram');
const Driver = require('./base');
const { fill, unescape, hexBytes } = require('../lib/templates');

const ENDINGS = { cr: '\r', lf: '\n', crlf: '\r\n', none: '' };

class TextDriver extends Driver {
  constructor(cfg) {
    super(cfg);
    this.state = { lastReply: '' };
  }
  get tcp() { return (this.cfg.protocol || 'tcp') === 'tcp'; }

  start() {
    if (!this.tcp) {
      this.udp = dgram.createSocket('udp4');
      this.udp.on('error', e => this.log(e.message, 'warn'));
      this.udp.on('message', m => this.patch({ lastReply: m.toString('latin1').trim().slice(0, 200) }));
      this.udp.bind(0);
      return this.setStatus('online');
    }
    this.setStatus('connecting');
    const connect = () => {
      const sock = net.connect(this.cfg.port, this.cfg.host);
      sock.setKeepAlive(true, 5000);
      sock.on('connect', () => { this.log(`connected ${this.cfg.host}:${this.cfg.port}`); this.seen(); });
      sock.on('data', d => { this.seen(); this.patch({ lastReply: d.toString('latin1').trim().split(/\r?\n/).slice(-1)[0].slice(0, 200) }); });
      sock.on('error', e => this.log(e.message, 'warn'));
      sock.on('close', () => { this.sock = null; this.setStatus('offline'); if (!this.stopped) this.retry = setTimeout(connect, 3000); });
      this.sock = sock;
    };
    connect();
  }

  write(buf) {
    if (!this.tcp) { this.udp.send(buf, this.cfg.port, this.cfg.host); return; }
    if (!this.sock || this.sock.destroyed || this.sock.connecting) throw new Error('not connected');
    this.sock.write(buf);
  }
  line(text) { return this.write(Buffer.from(unescape(text) + (ENDINGS[this.cfg.ending || 'cr'] ?? '\r'), 'latin1')); }

  async command(cmd, a = {}) {
    const t = this.cfg.templates?.[cmd];
    if (t?.text != null) return this.line(fill(t.text, a));
    if (t?.hex != null) return this.write(hexBytes(fill(t.hex, a)));
    if (cmd === 'send') return this.line(a.text ?? '');
    if (cmd === 'hex') return this.write(hexBytes(a.bytes ?? ''));
    return super.command(cmd);
  }

  stop() { super.stop(); this.stopped = true; clearTimeout(this.retry); this.sock?.destroy(); this.udp?.close(); }
}

TextDriver.meta = {
  label: 'Anything that takes text commands (TCP or UDP)', category: 'other',
  oneWayWhen: { protocol: 'udp' },
  fields: [['protocol', 'select:tcp=TCP (stays connected)|udp=UDP', 'Connection'], ['port', 'port', 'Port', 'from its manual'],
    ['ending', 'select:cr=Return (CR)|lf=New line (LF)|crlf=CR + LF|none=Nothing', 'End each command with']],
  help: [
    'Look in the device\'s manual for "remote control protocol", "RS-232/IP commands" or "telnet". It gives the port and the commands.',
    'Type its address and that port, then in the cue editor use "Send text" with a command from the manual. \\r, \\n and \\xHH work for special characters.',
  ],
  commands: { send: [['text', 'text', '', 'Text to send']], hex: [['bytes', 'text', '', 'Bytes in hex (e.g. 81 01 04 07 02 FF)']] },
  commandLabels: { send: 'Send text', hex: 'Send bytes (hex)' },
};

module.exports = TextDriver;
