// ChamSys MagicQ consoles and MagicQ PC, over OSC (UDP). On the console: Setup > View Settings >
// Network: set "OSC mode" to receive (or send and receive) and "OSC rx port" (default here 8000).
// Addresses follow the MagicQ manual (/pb/<playback>/go etc.); not yet checked on a real console.
const dgram = require('dgram');
const osc = require('../lib/osc');
const Driver = require('./base');

class MagicQDriver extends Driver {
  start() {
    this.udp = dgram.createSocket('udp4');
    this.udp.on('error', e => this.log(e.message, 'warn'));
    this.udp.bind(0);
    this.setStatus('online'); // MagicQ does not answer OSC, so this only means "ready to send"
  }
  send(address, args = []) { this.udp.send(osc.encode(address, args), this.cfg.port || 8000, this.cfg.host); }
  async command(cmd, a = {}) {
    const pb = Math.max(1, Number(a.playback) || 1);
    switch (cmd) {
      case 'go': return this.send(`/pb/${pb}/go`);
      case 'stop': return this.send(`/pb/${pb}/stop`);
      case 'release': return this.send(`/pb/${pb}/release`);
      case 'jump': return this.send(`/pb/${pb}/${String(a.cue).replace(/[^0-9.]/g, '')}`);
      case 'level': return this.send(`/pb/${pb}`, [Math.max(0, Math.min(100, Number(a.level) || 0))]);
      case 'raw': return this.send(String(a.address), []);
      default: return super.command(cmd);
    }
  }
  stop() { super.stop(); this.udp?.close(); }
}

MagicQDriver.meta = {
  label: 'ChamSys MagicQ lighting console', category: 'lighting', oneWay: true,
  fields: [['port', 'port', 'OSC port (leave empty for 8000)', '8000']],
  help: [
    'Plug the console (or MagicQ PC computer) into the show network and give it a fixed address.',
    'On MagicQ open Setup > View Settings > Network. Set OSC mode to receive, and OSC rx port to 8000 (or type the port you use here).',
    'Type the console\'s address. MagicQ does not answer back, so check with "Try it now" in the cue editor.',
  ],
  commands: {
    go: [['playback', 'number', 1, 'Playback']], stop: [['playback', 'number', 1, 'Playback']], release: [['playback', 'number', 1, 'Playback']],
    jump: [['playback', 'number', 1, 'Playback'], ['cue', 'text', '1', 'Cue']], level: [['playback', 'number', 1, 'Playback'], ['level', 'number', 100, 'Level %']],
  },
  commandLabels: { go: 'GO', stop: 'Stop / back', release: 'Release', jump: 'Jump to cue', level: 'Playback level' },
};

module.exports = MagicQDriver;
