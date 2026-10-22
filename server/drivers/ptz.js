// PTZ cameras via VISCA.
//  protocol "visca-ip"  : Sony VISCA-over-IP, UDP 52381, 8-byte header (Sony, many PTZOptics/Panasonic/Marshall in Sony mode)
//  protocol "visca-tcp" : raw VISCA over TCP (PTZOptics/BirdDog/Lumens default port 5678)
// Video is NOT carried here; see stream config + docs/VIDEO.md (go2rtc/MediaMTX → WebRTC in the browser).
const dgram = require('dgram');
const net = require('net');
const Driver = require('./base');

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

class PTZDriver extends Driver {
  constructor(cfg) {
    super(cfg);
    this.seq = 0;
    this.state = { power: null, zoom: null, pan: null, tilt: null, lastPreset: null, presets: cfg.presets || [], stream: cfg.stream || null, tally: false };
  }

  start() {
    this.setStatus('connecting');
    const { host } = this.cfg;
    if (this.cfg.protocol === 'visca-tcp') {
      const connect = () => {
        this.sock = net.connect(this.cfg.port || 5678, host);
        this.sock.on('data', d => this.onReply(d));
        this.sock.on('error', e => this.log(e.message, 'warn'));
        this.sock.on('close', () => { this.setStatus('offline'); if (!this.stopped) this.retry = setTimeout(connect, 3000); });
      };
      connect();
    } else {
      this.udp = dgram.createSocket('udp4');
      this.udp.on('message', m => this.onReply(m.subarray(8)));
      this.udp.on('error', e => this.log(e.message, 'warn'));
      this.udp.bind(0, () => this.raw([0x01]) /* reset sequence: control command */);
    }
    this.poll = setInterval(() => { this.visca([0x81, 0x09, 0x04, 0x00, 0xff]); this.visca([0x81, 0x09, 0x04, 0x47, 0xff]); this.visca([0x81, 0x09, 0x06, 0x12, 0xff]); }, this.cfg.pollMs || 1000);
    this.watchdog(6000);
  }

  // Sony header: payload type (2) | length (2) | sequence (4)
  frame(payload, type = 0x0100) {
    const h = Buffer.alloc(8);
    h.writeUInt16BE(type, 0); h.writeUInt16BE(payload.length, 2); h.writeUInt32BE(this.seq++ >>> 0, 4);
    return Buffer.concat([h, Buffer.from(payload)]);
  }
  raw(payload) { this.udp?.send(this.frame(payload, 0x0200), this.cfg.port || 52381, this.cfg.host); }
  visca(bytes) {
    if (this.cfg.protocol === 'visca-tcp') { if (this.sock && !this.sock.destroyed) this.sock.write(Buffer.from(bytes)); }
    else this.udp?.send(this.frame(bytes), this.cfg.port || 52381, this.cfg.host);
  }

  onReply(b) {
    this.seen();
    // replies can be concatenated; split on 0xFF
    let start = 0;
    for (let i = 0; i < b.length; i++) {
      if (b[i] !== 0xff) continue;
      const r = b.subarray(start, i + 1); start = i + 1;
      if (r[1] === 0x50 && r.length === 4) this.patch({ power: r[2] === 0x02 });
      else if (r[1] === 0x50 && r.length === 7) this.patch({ zoom: ((r[2] & 15) << 12) | ((r[3] & 15) << 8) | ((r[4] & 15) << 4) | (r[5] & 15) });
      else if (r[1] === 0x50 && r.length === 11) {
        const n16 = o => { const v = ((r[o] & 15) << 12) | ((r[o + 1] & 15) << 8) | ((r[o + 2] & 15) << 4) | (r[o + 3] & 15); return v > 0x7fff ? v - 0x10000 : v; };
        this.patch({ pan: n16(2), tilt: n16(6) });
      }
      else if ((r[1] & 0xf0) === 0x60) this.log(`VISCA error ${r.toString('hex')}`, 'warn');
    }
  }

  async command(cmd, a = {}) {
    switch (cmd) {
      case 'move': { // { pan: -1..1, tilt: -1..1 } joystick vector; 0,0 = stop
        const pan = clamp(Number(a.pan) || 0, -1, 1), tilt = clamp(Number(a.tilt) || 0, -1, 1);
        const vv = Math.max(1, Math.round(Math.abs(pan) * 0x18)), ww = Math.max(1, Math.round(Math.abs(tilt) * 0x14));
        const pd = pan < -0.05 ? 1 : pan > 0.05 ? 2 : 3, td = tilt > 0.05 ? 1 : tilt < -0.05 ? 2 : 3;
        return this.visca([0x81, 0x01, 0x06, 0x01, vv, ww, pd, td, 0xff]);
      }
      case 'zoom': { // { speed: -1..1 } negative = wide
        const s = clamp(Number(a.speed) || 0, -1, 1), p = Math.min(7, Math.round(Math.abs(s) * 7));
        return this.visca([0x81, 0x01, 0x04, 0x07, s > 0.05 ? 0x20 | p : s < -0.05 ? 0x30 | p : 0x00, 0xff]);
      }
      case 'focus': // { mode: 'auto'|'manual'|'onepush' }
        return this.visca(a.mode === 'manual' ? [0x81, 0x01, 0x04, 0x38, 0x03, 0xff] : a.mode === 'onepush' ? [0x81, 0x01, 0x04, 0x18, 0x01, 0xff] : [0x81, 0x01, 0x04, 0x38, 0x02, 0xff]);
      case 'preset': this.patch({ lastPreset: Number(a.preset) }); return this.visca([0x81, 0x01, 0x04, 0x3f, 0x02, Number(a.preset) & 0x7f, 0xff]);
      case 'store': return this.visca([0x81, 0x01, 0x04, 0x3f, 0x01, Number(a.preset) & 0x7f, 0xff]);
      case 'home': return this.visca([0x81, 0x01, 0x06, 0x04, 0xff]);
      case 'power': return this.visca([0x81, 0x01, 0x04, 0x00, a.on ? 0x02 : 0x03, 0xff]);
      case 'tally': this.patch({ tally: !!a.on }); return this.visca([0x81, 0x01, 0x7e, 0x01, 0x0a, 0x00, a.on ? 0x02 : 0x03, 0xff]);
      default: return super.command(cmd);
    }
  }

  stop() { super.stop(); this.stopped = true; clearInterval(this.poll); clearTimeout(this.retry); this.udp?.close(); this.sock?.destroy(); }
}

module.exports = PTZDriver;
