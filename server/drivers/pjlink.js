// Projectors / displays via PJLink class 1 (TCP 4352). Supported by Epson, Panasonic, NEC, Sony, Christie, Barco, etc.
const net = require('net');
const crypto = require('crypto');
const Driver = require('./base');

class PJLinkDriver extends Driver {
  constructor(cfg) { super(cfg); this.state = { power: null, shutter: null, input: null }; }

  start() {
    this.setStatus('connecting');
    this.queue = Promise.resolve();
    this.poll = setInterval(() => { this.req('POWR ?'); this.req('AVMT ?'); }, 5000);
    this.req('POWR ?');
    this.watchdog(15000);
  }

  // PJLink closes the socket after idle, so each request is its own short connection.
  req(body) {
    this.queue = this.queue.then(() => new Promise(resolve => {
      const sock = net.connect(this.cfg.port || 4352, this.cfg.host);
      let buf = '', prefix = '';
      const done = () => { sock.destroy(); resolve(); };
      sock.setTimeout(3000, done);
      sock.on('error', () => { this.setStatus('offline'); done(); });
      sock.on('data', d => {
        buf += d.toString();
        if (!buf.includes('\r')) return;
        const line = buf.split('\r')[0]; buf = '';
        if (line.startsWith('PJLINK')) {
          const [, auth, rand] = line.split(' ');
          if (auth === '1') prefix = crypto.createHash('md5').update(rand + (this.cfg.password || '')).digest('hex');
          sock.write(`${prefix}%1${body}\r`);
        } else { this.seen(); this.onReply(line); done(); }
      });
    }));
    return this.queue;
  }

  onReply(line) {
    const m = line.match(/^%1(\w{4})=(.*)$/);
    if (!m) return;
    const [, cmd, val] = m;
    if (val.startsWith('ERR')) return this.log(`${cmd} ${val}`, 'warn');
    if (cmd === 'POWR' && val !== 'OK') this.patch({ power: { 0: 'off', 1: 'on', 2: 'cooling', 3: 'warming' }[val] || val });
    if (cmd === 'AVMT' && val !== 'OK') this.patch({ shutter: val === '31' ? 'closed' : 'open' });
  }

  async command(cmd, a = {}) {
    switch (cmd) {
      case 'power': return this.req(`POWR ${a.on ? 1 : 0}`);
      case 'shutter': this.patch({ shutter: a.closed ? 'closed' : 'open' }); return this.req(`AVMT ${a.closed ? 31 : 30}`);
      case 'input': return this.req(`INPT ${a.input}`);
      default: return super.command(cmd);
    }
  }

  stop() { super.stop(); clearInterval(this.poll); }
}

module.exports = PJLinkDriver;
