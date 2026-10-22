// A TCP session that reads CR- or LF-terminated lines, used by the Panasonic and PJLink drivers.
const net = require('net');

class LineSession {
  constructor(host, port, { connectTimeout = 3000, readTimeout = 4000 } = {}) {
    Object.assign(this, { host, port, connectTimeout, readTimeout });
    this.sock = null; this.buf = ''; this.lines = []; this.waiter = null; this.closedByPeer = false;
  }
  get connected() { return !!this.sock && !this.sock.destroyed && !this.closedByPeer; }

  open() {
    this.close();
    this.closedByPeer = false; this.buf = ''; this.lines = [];
    return new Promise((resolve, reject) => {
      const sock = net.connect(this.port, this.host);
      const t = setTimeout(() => { sock.destroy(); reject(Object.assign(new Error(`connect timeout ${this.host}:${this.port}`), { code: 'offline' })); }, this.connectTimeout);
      sock.once('connect', () => { clearTimeout(t); resolve(); });
      sock.once('error', e => { clearTimeout(t); reject(Object.assign(e, { code: 'offline' })); });
      sock.on('data', d => {
        this.buf += d.toString('latin1');
        let m;
        while ((m = this.buf.match(/\r\n|\r|\n/))) {
          const line = this.buf.slice(0, m.index); this.buf = this.buf.slice(m.index + m[0].length);
          if (line === '') continue;
          if (this.waiter) { const w = this.waiter; this.waiter = null; w.resolve(line); } else this.lines.push(line);
        }
      });
      sock.on('close', () => { this.closedByPeer = true; if (this.waiter) { const w = this.waiter; this.waiter = null; w.reject(Object.assign(new Error('connection closed by device'), { code: 'closed' })); } });
      sock.on('error', () => {});
      this.sock = sock;
    });
  }

  readLine(timeout = this.readTimeout) {
    if (this.lines.length) return Promise.resolve(this.lines.shift());
    if (this.closedByPeer) return Promise.reject(Object.assign(new Error('connection closed by device'), { code: 'closed' }));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiter = null; reject(Object.assign(new Error('no reply'), { code: 'timeout' })); }, timeout);
      this.waiter = { resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } };
    });
  }

  write(s) { this.sock.write(s, 'latin1'); }
  close() { this.sock?.destroy(); this.sock = null; }
}

// Runs jobs one at a time. Operator commands jump ahead of background polls.
class CommandQueue {
  constructor(gapMs = 0) { this.hi = []; this.lo = []; this.running = false; this.gapMs = gapMs; this.lastDone = 0; }
  push(fn, priority = 'lo') {
    return new Promise((resolve, reject) => { (priority === 'hi' ? this.hi : this.lo).push({ fn, resolve, reject }); this.pump(); });
  }
  get pendingPolls() { return this.lo.length; }
  async pump() {
    if (this.running) return;
    this.running = true;
    while (this.hi.length || this.lo.length) {
      const job = this.hi.shift() || this.lo.shift();
      const wait = this.lastDone + this.gapMs - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      try { job.resolve(await job.fn()); } catch (e) { job.reject(e); }
      this.lastDone = Date.now();
    }
    this.running = false;
  }
}

module.exports = { LineSession, CommandQueue };
