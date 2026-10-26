const { EventEmitter } = require('events');

// Every driver exposes: id, type, name, status ('offline'|'connecting'|'online'|'sim'),
// state (plain object pushed to the UI), start(), stop(), and command(cmd, args).
class Driver extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.id = cfg.id;
    this.type = cfg.type;
    this.name = cfg.name || cfg.id;
    this.status = 'offline';
    this.state = {};
    this.lastSeen = 0;
  }
  setStatus(s) { if (s !== this.status) { this.status = s; this.changed(); this.log(`status → ${s}`); } }
  patch(obj) { Object.assign(this.state, obj); this.changed(); }
  changed() { this.emit('changed', this); }
  seen() { this.lastSeen = Date.now(); if (this.status !== 'online') this.setStatus('online'); }
  log(msg, level = 'info') { this.emit('log', { device: this.id, level, msg, t: Date.now() }); }
  snapshot() { return { id: this.id, type: this.type, ...(this.cfg.profile ? { profile: this.cfg.profile } : {}), name: this.name, status: this.status, state: this.state, lastSeen: this.lastSeen }; }
  // The driver's TCP connection, if it has one (drivers set this.sock). Remembers when it was opened.
  get sock() { return this._sock; }
  set sock(s) { this._sock = s; if (s) this._sockAt = Date.now(); }
  // Mark offline if nothing heard for `ms`. Call from drivers that get regular traffic/heartbeats.
  // A pulled cable or a desk that restarted can leave a TCP connection looking open for many
  // minutes, so one that has been silent that long is closed: the driver's own reconnect takes over.
  watchdog(ms) {
    this._wd = setInterval(() => {
      const silent = Date.now() - this.lastSeen > ms;
      if (this.status === 'online' && silent) this.setStatus('offline');
      // only a connection that answered and then went quiet: one that never answered (e.g. the
      // console's OSC output turned off) still delivers commands, so it is left alone
      if (silent && this.lastSeen >= (this._sockAt || Infinity) && typeof this._sock?.destroy === 'function' && !this._sock.destroyed) {
        this.log(`no answer for ${Math.round(ms / 1000)} s, connecting again`, 'warn');
        this._sock.destroy();
      }
    }, 1000);
  }
  stop() { clearInterval(this._wd); }
  async command() { throw new Error(`${this.type}: unknown command`); }
}

module.exports = Driver;
