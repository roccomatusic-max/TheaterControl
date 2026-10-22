// Figure 53 QLab 4/5 via OSC over UDP (QLab listens on 53000 and replies to the sender's port).
// QLab 5: enable OSC access in Workspace Settings > Network; set a passcode there if you use one.
const dgram = require('dgram');
const osc = require('../lib/osc');
const Driver = require('./base');

class QLabDriver extends Driver {
  constructor(cfg) {
    super(cfg);
    this.state = { playhead: '', playheadName: '', running: [] };
  }

  start() {
    const { host, port = 53000, passcode } = this.cfg;
    this.setStatus('connecting');
    this.udp = dgram.createSocket('udp4');
    this.udp.on('message', m => this.onPacket(m));
    this.udp.on('error', e => this.log(e.message, 'warn'));
    this.udp.bind(this.cfg.listenPort || 0, () => {
      this.log(`UDP → ${host}:${port}`);
      if (passcode) this.send('/connect', [String(passcode)]);
      this.send('/updates', [1]);
    });
    // QLab doesn't push playhead on every workspace, so poll it cheaply.
    this.poll = setInterval(() => {
      this.send('/cue/playhead/number');
      this.send('/cue/playhead/displayName');
      this.send('/runningCues/shallow');
    }, 1000);
    this.watchdog(4000);
  }

  send(address, args = []) { this.udp.send(osc.encode(address, args), this.cfg.port || 53000, this.cfg.host); }

  onPacket(pkt) {
    let msgs;
    try { msgs = [].concat(osc.decode(pkt)); } catch { return; }
    this.seen();
    for (const { address, args } of msgs) {
      if (!address.startsWith('/reply')) continue;
      let body; try { body = JSON.parse(args[0]); } catch { continue; }
      if (body.status && body.status !== 'ok') { this.log(`${body.address}: ${body.status}`, 'warn'); continue; }
      if (address.endsWith('/cue/playhead/number')) this.patch({ playhead: body.data ?? '' });
      else if (address.endsWith('/cue/playhead/displayName')) this.patch({ playheadName: body.data ?? '' });
      else if (address.endsWith('/runningCues/shallow')) this.patch({ running: (body.data || []).map(c => c.listName || c.name || c.number) });
    }
  }

  async command(cmd, a = {}) {
    switch (cmd) {
      case 'go': return this.send('/go');
      case 'stop': return this.send('/stop');
      case 'panic': return this.send('/panic');
      case 'pause': return this.send('/pause');
      case 'resume': return this.send('/resume');
      case 'next': return this.send('/playhead/next');
      case 'previous': return this.send('/playhead/previous');
      case 'start': return this.send(`/cue/${a.cue}/start`);
      case 'playhead': return this.send(`/playhead/${a.cue}`);
      default: return super.command(cmd);
    }
  }

  stop() { super.stop(); clearInterval(this.poll); this.udp?.close(); }
}

module.exports = QLabDriver;
