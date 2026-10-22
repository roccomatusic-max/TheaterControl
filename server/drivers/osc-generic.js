// Generic OSC-over-UDP output for anything else on the network (Resolume, Millumin, Disguise,
// Bitfocus Companion, TouchDesigner, ...). Commands: send { address, args[] }.
const dgram = require('dgram');
const osc = require('../lib/osc');
const Driver = require('./base');

class OSCGenericDriver extends Driver {
  start() {
    this.udp = dgram.createSocket('udp4');
    this.udp.on('error', e => this.log(e.message, 'warn'));
    this.udp.bind(0);
    this.setStatus('online'); // fire-and-forget: we can't know if the far end is listening
  }
  async command(cmd, a = {}) {
    if (cmd !== 'send') return super.command(cmd);
    this.udp.send(osc.encode(a.address, a.args || []), this.cfg.port, this.cfg.host);
  }
  stop() { super.stop(); this.udp?.close(); }
}

module.exports = OSCGenericDriver;
