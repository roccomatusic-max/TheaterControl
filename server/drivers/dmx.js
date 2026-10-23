// DMX out over the network: sACN (E1.31) or Art-Net, to a DMX node, a console's network input
// or a fixture that takes it directly. For things the lighting console doesn't run: hazers, fog,
// LED strips, blinders, house lights. Levels are in percent (0-100) with optional fades.
// One-way: DMX gives no answer. Universe: sACN counts from 1, Art-Net from 0 (as their apps do).
const dgram = require('dgram');
const crypto = require('crypto');
const Driver = require('./base');

// "1-4, 7" → [1,2,3,4,7] (DMX addresses 1-512)
function parseChannels(s) {
  const out = new Set();
  for (const part of String(s ?? '').split(/[,\s]+/).filter(Boolean)) {
    const [a, b] = part.split(/-|\.\.|thru/i).map(Number);
    if (!(a >= 1 && a <= 512)) throw new Error(`"${part}" is not a DMX address (1-512)`);
    const end = b >= a && b <= 512 ? b : a;
    for (let i = a; i <= end; i++) out.add(i);
  }
  if (!out.size) throw new Error('which DMX channels?');
  return [...out];
}

function sacnPacket(cid, name, universe, seq, data, priority = 100) {
  const p = Buffer.alloc(638);
  p.writeUInt16BE(0x0010, 0); p.writeUInt16BE(0, 2); p.write('ASC-E1.17', 4, 'ascii');
  p.writeUInt16BE(0x7000 | (638 - 16), 16); p.writeUInt32BE(0x00000004, 18); cid.copy(p, 22);
  p.writeUInt16BE(0x7000 | (638 - 38), 38); p.writeUInt32BE(0x00000002, 40); p.write(name.slice(0, 63), 44, 'utf8');
  p[108] = priority; p.writeUInt16BE(0, 109); p[111] = seq; p[112] = 0; p.writeUInt16BE(universe, 113);
  p.writeUInt16BE(0x7000 | (638 - 115), 115); p[117] = 0x02; p[118] = 0xa1; p.writeUInt16BE(0, 119); p.writeUInt16BE(1, 121); p.writeUInt16BE(513, 123);
  p[125] = 0; data.copy(p, 126);
  return p;
}
function artnetPacket(universe, seq, data) {
  const p = Buffer.alloc(18 + 512);
  p.write('Art-Net\0', 0, 'ascii'); p.writeUInt16LE(0x5000, 8); p.writeUInt16BE(14, 10);
  p[12] = seq; p[13] = 0; p[14] = universe & 0xff; p[15] = (universe >> 8) & 0x7f; p.writeUInt16BE(512, 16);
  data.copy(p, 18);
  return p;
}

class DMXDriver extends Driver {
  constructor(cfg) {
    super(cfg);
    this.data = Buffer.alloc(512);
    this.fades = new Map(); // channel → { from, to, start, ms }
    this.seq = 0;
    this.cid = crypto.createHash('md5').update(`show-control-${cfg.id}`).digest(); // stable source id
    this.state = { protocol: this.artnet ? 'Art-Net' : 'sACN', universe: this.universe, levels: {} };
  }
  get artnet() { return this.cfg.protocol === 'artnet'; }
  get universe() { return Number(this.cfg.universe ?? (this.artnet ? 0 : 1)); }
  // sACN with no address: multicast for the universe, which every sACN receiver listens to.
  get dest() {
    if (this.cfg.host) return this.cfg.host;
    return this.artnet ? '255.255.255.255' : `239.255.${(this.universe >> 8) & 0xff}.${this.universe & 0xff}`;
  }
  start() {
    this.udp = dgram.createSocket('udp4');
    this.udp.on('error', e => this.log(e.message, 'warn'));
    this.udp.bind(0, () => { try { this.udp.setBroadcast(true); this.udp.setMulticastTTL(4); } catch { /* fine on unicast */ } });
    this.tick = setInterval(() => this.frame(), 40); // 25 frames a second while fading, otherwise a keep-alive
    this.setStatus('online');
  }
  frame() {
    const now = Date.now();
    let changed = this.fades.size > 0;
    for (const [ch, f] of this.fades) {
      const k = f.ms ? Math.min(1, (now - f.start) / f.ms) : 1;
      this.data[ch - 1] = Math.round(f.from + (f.to - f.from) * k);
      if (k >= 1) this.fades.delete(ch);
    }
    // DMX receivers expect a refresh at least every second or so
    if (!changed && now - (this.lastSent || 0) < 900) return;
    this.lastSent = now;
    this.seq = (this.seq + 1) & 0xff;
    const pkt = this.artnet ? artnetPacket(this.universe, this.seq || 1, this.data) : sacnPacket(this.cid, `Show Control ${this.name}`, this.universe, this.seq, this.data, Number(this.cfg.priority) || 100);
    this.udp?.send(pkt, this.artnet ? 6454 : 5568, this.dest);
  }
  set(channels, pct, fade) {
    const to = Math.round((Math.max(0, Math.min(100, Number(pct) || 0)) * 255) / 100);
    for (const ch of channels) this.fades.set(ch, { from: this.data[ch - 1], to, start: Date.now(), ms: Math.max(0, Number(fade) || 0) * 1000 });
    const levels = { ...this.state.levels };
    for (const ch of channels) levels[ch] = Math.round(to * 100 / 255);
    this.patch({ levels });
    this.frame();
  }
  async command(cmd, a = {}) {
    switch (cmd) {
      case 'level': return this.set(parseChannels(a.channels), a.level, a.fade);
      case 'value': { // raw 0-255
        for (const ch of parseChannels(a.channels)) { this.fades.delete(ch); this.data[ch - 1] = Math.max(0, Math.min(255, Number(a.value) || 0)); }
        this.lastSent = 0; return this.frame();
      }
      case 'blackout': {
        const all = Object.keys(this.state.levels).map(Number);
        return this.set(all.length ? all : [1], 0, a.fade);
      }
      default: return super.command(cmd);
    }
  }
  stop() { super.stop(); clearInterval(this.tick); this.udp?.close(); }
}

DMXDriver.meta = {
  label: 'DMX over the network (sACN or Art-Net)', category: 'effects', oneWay: true,
  fields: [['protocol', 'select:sacn=sACN (E1.31)|artnet=Art-Net', 'Protocol'], ['universe', 'number', 'Universe', '1'],
    ['priority', 'number', 'sACN priority (100 is normal)', '100']],
  defaults: { protocol: 'sacn', universe: 1 },
  addressOptional: 'sACN can leave the address empty: it then goes to everything listening on that universe. Art-Net with no address goes to the whole network.',
  help: [
    'Use this for hazers, fog machines, LED strips and anything else on DMX that the lighting console doesn\'t run. You need a network-to-DMX box (a "DMX node" or "gateway", for example from ENTTEC, DMXking, Obsidian or ETC) or a fixture that takes sACN or Art-Net.',
    'Set the node to a fixed address and pick a universe that the lighting console is NOT using, so the two never fight over the same channels.',
    'Type the node\'s address (or leave it empty for sACN), the protocol and the universe. Then in a cue use "Set level" with the DMX channel numbers.',
  ],
  commands: {
    level: [['channels', 'text', '1', 'DMX channels (e.g. 1-4, 9)'], ['level', 'number', 100, 'Level %'], ['fade', 'number', 0, 'Fade (seconds)']],
    value: [['channels', 'text', '1', 'DMX channels'], ['value', 'number', 255, 'Value (0-255)']],
    blackout: [['fade', 'number', 0, 'Fade (seconds)']],
  },
  commandLabels: { level: 'Set level', value: 'Set raw value', blackout: 'Everything to zero' },
};
DMXDriver.parseChannels = parseChannels;

module.exports = DMXDriver;
