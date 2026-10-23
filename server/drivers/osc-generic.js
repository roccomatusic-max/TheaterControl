// Generic OSC-over-UDP output for anything else on the network (Resolume, Millumin, Disguise,
// Bitfocus Companion, TouchDesigner, ...). Commands: send { address, args[] }, plus any
// ready-made commands ("templates") that came with the brand picked on the Setup screen.
const dgram = require('dgram');
const osc = require('../lib/osc');
const Driver = require('./base');
const { fill, fillArgs } = require('../lib/templates');

// "1, 0.5, hello" typed in the cue editor → [1, 0.5, 'hello']
const parseArgs = a => (Array.isArray(a) ? a : String(a ?? '').split(',').map(s => s.trim()).filter(Boolean).map(s => (isNaN(s) ? s : Number(s))));

class OSCGenericDriver extends Driver {
  start() {
    this.udp = dgram.createSocket('udp4');
    this.udp.on('error', e => this.log(e.message, 'warn'));
    this.udp.bind(0, () => { try { this.udp.setBroadcast(true); } catch { /* not supported here */ } });
    this.setStatus('online'); // fire-and-forget: we can't know if the far end is listening
  }
  send(address, args = []) { this.udp.send(osc.encode(address, args), this.cfg.port, this.cfg.host); }
  async command(cmd, a = {}) {
    const t = this.cfg.templates?.[cmd];
    if (t?.osc) return this.send(fill(t.osc.address, a), fillArgs(t.osc.args, a));
    if (cmd !== 'send') return super.command(cmd);
    if (!String(a.address || '').startsWith('/')) throw new Error('OSC address must start with /');
    this.send(a.address, parseArgs(a.args));
  }
  stop() { super.stop(); this.udp?.close(); }
}

OSCGenericDriver.meta = {
  label: 'Anything that takes OSC', category: 'other', oneWay: true,
  fields: [['port', 'port', 'Port it listens on', 'e.g. 7000']],
  help: [
    'Look in the other program or device\'s settings for "OSC input" or "OSC in". Turn it on and note the port number.',
    'Type its address (127.0.0.1 if it runs on this computer) and that port. Then in the cue editor use "Send OSC" with the address from its manual.',
  ],
  commands: { send: [['address', 'text', '/', 'OSC address'], ['args', 'text', '', 'Values (comma separated)']] },
  commandLabels: { send: 'Send OSC' },
};

module.exports = OSCGenericDriver;
