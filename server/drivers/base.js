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
  snapshot() { return { id: this.id, type: this.type, name: this.name, status: this.status, state: this.state, lastSeen: this.lastSeen }; }
  // Mark offline if nothing heard for `ms`. Call from drivers that get regular traffic/heartbeats.
  watchdog(ms) {
    this._wd = setInterval(() => {
      if (this.status === 'online' && Date.now() - this.lastSeen > ms) this.setStatus('offline');
    }, 1000);
  }
  stop() { clearInterval(this._wd); }
  async command() { throw new Error(`${this.type}: unknown command`); }
}

module.exports = Driver;
