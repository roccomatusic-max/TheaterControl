// ETC Eos family (Eos, Ion, Gio, Element 2, Nomad) via OSC.
// Preferred transport: TCP port 3037 with SLIP framing (OSC 1.1) – reliable and two-way.
// Fallback: UDP (console defaults: console receives on 8000, replies on 8001; set in Shell > Settings > Network).
const net = require('net');
const dgram = require('dgram');
const osc = require('../lib/osc');
const Driver = require('./base');

class EosDriver extends Driver {
  constructor(cfg) {
    super(cfg);
    this.state = { showName: '', activeCue: '', pendingCue: '', activeCuePct: 0, cmdLine: '', user: cfg.user ?? 0 };
  }

  start() {
    this.setStatus('connecting');
    if ((this.cfg.transport || 'tcp') === 'tcp') this.connectTcp(); else this.openUdp();
    this.ping = setInterval(() => this.send('/eos/ping'), 2000);
    this.watchdog(6000);
  }

  connectTcp() {
    const { host, port = 3037 } = this.cfg;
    const sock = net.connect(port, host);
    const slip = new osc.SlipDecoder(pkt => this.onPacket(pkt));
    sock.on('connect', () => { this.log(`TCP connected ${host}:${port}`); this.hello(); });
    sock.on('data', d => slip.push(d));
    sock.on('error', e => this.log(e.message, 'warn'));
    sock.on('close', () => {
      this.sock = null; this.setStatus('offline');
      if (!this.stopped) this.retry = setTimeout(() => this.connectTcp(), 3000);
    });
    this.sock = sock;
  }

  openUdp() {
    const { host, port = 8000, listenPort = 8001 } = this.cfg;
    this.udp = dgram.createSocket('udp4');
    this.udp.on('message', m => this.onPacket(m));
    this.udp.on('error', e => this.log(e.message, 'warn'));
    this.udp.bind(listenPort, () => { this.log(`UDP → ${host}:${port}, listening ${listenPort}`); this.hello(); });
  }

  hello() {
    if (this.state.user) this.send('/eos/user', [this.state.user]);
    this.send('/eos/subscribe', [1]);
    this.send('/eos/ping');
  }

  send(address, args = []) {
    const pkt = osc.encode(address, args);
    if (this.sock && !this.sock.destroyed) this.sock.write(osc.slipEncode(pkt));
    else if (this.udp) this.udp.send(pkt, this.cfg.port || 8000, this.cfg.host);
  }

  onPacket(pkt) {
    let msgs;
    try { msgs = [].concat(osc.decode(pkt)); } catch { return; }
    this.seen();
    for (const { address, args } of msgs) {
      if (address === '/eos/out/active/cue/text') this.patch({ activeCue: args[0] || '' });
      else if (address === '/eos/out/pending/cue/text') this.patch({ pendingCue: args[0] || '' });
      else if (address === '/eos/out/active/cue') this.patch({ activeCuePct: Math.round((args[0] || 0) * 100) });
      else if (address === '/eos/out/show/name') this.patch({ showName: args[0] || '' });
      else if (address.startsWith('/eos/out/cmd')) this.patch({ cmdLine: args[0] || '' });
    }
  }

  async command(cmd, a = {}) {
    switch (cmd) {
      case 'go': return this.send('/eos/key/go_0');
      case 'back': return this.send('/eos/key/stop'); // Stop/Back key; hold-to-back behaviour depends on console setup
      case 'cue': return this.send(`/eos/cue/${a.list ?? 1}/${a.cue}/fire`);
      case 'macro': return this.send(`/eos/macro/${a.macro}/fire`);
      case 'sub': return this.send(`/eos/sub/${a.sub}`, [{ type: 'f', value: Number(a.level) }]); // level 0..1
      case 'chan': return this.send('/eos/newcmd', [`Chan ${a.chan} At ${a.level}#`]);
      case 'cmdline': return this.send('/eos/newcmd', [String(a.text)]);
      default: return super.command(cmd);
    }
  }

  stop() {
    super.stop(); this.stopped = true;
    clearInterval(this.ping); clearTimeout(this.retry);
    this.sock?.destroy(); this.udp?.close();
  }
}

module.exports = EosDriver;
