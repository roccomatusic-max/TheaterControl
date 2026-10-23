// Training mode's stand-in for equipment that has no simulator (see server/features/training.js):
// it answers like the real kind of equipment would on the screens ("type" is the real one), says
// yes to every command and logs what the real equipment would have been sent.
const Driver = require('./base');

class PretendDriver extends Driver {
  constructor(cfg) {
    super(cfg);
    this.type = cfg.as || 'pretend';
    this.state = { pretend: true };
  }
  start() {
    this.seen();
    this.timer = setInterval(() => { if (this.status === 'online') this.lastSeen = Date.now(); }, 2000);
  }
  stop() { clearInterval(this.timer); super.stop(); }
  async command(cmd, args) {
    return { outcome: 'ok', detail: `pretend: ${cmd}${args && Object.keys(args).length ? ` ${JSON.stringify(args)}` : ''}` };
  }
}

module.exports = PretendDriver;
