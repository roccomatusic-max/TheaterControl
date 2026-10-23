// MIDI over the network (RTP-MIDI / "AppleMIDI"), the same thing as a Mac's Audio MIDI Setup >
// Network session or rtpMIDI on Windows. Covers MIDI Show Control (MSC) for consoles that take it
// (grandMA, Hog, ETC, ChamSys, QLab...), notes, CCs and program changes for anything with MIDI,
// and real MIDI cables through a Mac that bridges its network session to a USB interface.
// We are the session initiator: invite on the control port, then on port + 1, then keep the
// clock in sync (CK) so the far end keeps the session open. Incoming MIDI is emitted as 'midi'
// events (one complete message per event) for features that trigger on it.
const dgram = require('dgram');
const crypto = require('crypto');
const Driver = require('./base');

const SIG = 0xffff;
const MSC_CMDS = { go: 0x01, stop: 0x02, resume: 0x03, load: 0x05, fire: 0x07, alloff: 0x08, reset: 0x0a };
const MSC_FORMATS = { lighting: 0x01, moving: 0x02, sound: 0x10, video: 0x30, projection: 0x40, all: 0x7f };

function exchange(cmd, token, ssrc, name) {
  const n = name ? Buffer.from(`${name}\0`, 'utf8') : Buffer.alloc(0);
  const b = Buffer.alloc(16 + n.length);
  b.writeUInt16BE(SIG, 0); b.write(cmd, 2, 'ascii'); b.writeUInt32BE(2, 4); b.writeUInt32BE(token, 8); b.writeUInt32BE(ssrc, 12);
  n.copy(b, 16);
  return b;
}
const now100us = () => BigInt(Math.round(performance.now() * 10));

class AppleMIDIDriver extends Driver {
  constructor(cfg) {
    super(cfg);
    this.ssrc = crypto.randomBytes(4).readUInt32BE(0);
    this.token = crypto.randomBytes(4).readUInt32BE(0);
    this.seq = 0;
    this.state = { session: 'not connected', peer: '' };
  }
  get port() { return Number(this.cfg.port) || 5004; }

  start() {
    this.setStatus('connecting');
    // the data socket must be on the control socket's port + 1; try again if that one is taken
    const sock = () => {
      const s = dgram.createSocket('udp4');
      s.on('message', m => this.onMessage(s, m));
      return s;
    };
    const bindPair = (tries = 0) => {
      this.ctl = sock(); this.dat = sock();
      this.ctl.on('error', e => this.log(e.message, 'warn'));
      this.ctl.bind(0, () => {
        this.dat.once('error', () => { this.ctl.close(); if (tries < 20) bindPair(tries + 1); });
        this.dat.bind(this.ctl.address().port + 1, () => { this.dat.on('error', e => this.log(e.message, 'warn')); this.invite(); });
      });
    };
    bindPair();
    this.timer = setInterval(() => {
      if (this.phase !== 'open') return this.invite();
      this.sync();
      if (Date.now() - this.lastSync > 30000) { this.log('no clock sync reply for 30 s, reconnecting', 'warn'); this.drop(); }
    }, 5000);
  }
  invite() {
    this.phase = 'ctl';
    this.ctl.send(exchange('IN', this.token, this.ssrc, this.cfg.sessionName || 'Show Control'), this.port, this.cfg.host);
  }
  drop() { this.phase = null; this.setStatus('offline'); this.patch({ session: 'not connected' }); }
  sync(count = 0, ts = [now100us(), 0n, 0n]) {
    const b = Buffer.alloc(36);
    b.writeUInt16BE(SIG, 0); b.write('CK', 2, 'ascii'); b.writeUInt32BE(this.ssrc, 4); b[8] = count;
    ts.forEach((t, i) => b.writeBigUInt64BE(BigInt.asUintN(64, t), 12 + i * 8));
    this.dat.send(b, this.port + 1, this.cfg.host);
  }
  onMessage(sock, m) {
    if (m.length < 4) return;
    if (m.readUInt16BE(0) !== SIG) { if (sock === this.dat && this.phase === 'open') this.receive(m); return; }
    const cmd = m.toString('ascii', 2, 4);
    if (cmd === 'OK' && sock === this.ctl && this.phase === 'ctl') {
      this.phase = 'dat';
      const name = m.length > 16 ? m.toString('utf8', 16).replace(/\0.*$/s, '') : '';
      this.patch({ peer: name });
      this.dat.send(exchange('IN', this.token, this.ssrc, this.cfg.sessionName || 'Show Control'), this.port + 1, this.cfg.host);
    } else if (cmd === 'OK' && sock === this.dat && this.phase === 'dat') {
      this.phase = 'open'; this.lastSync = Date.now();
      this.patch({ session: 'connected' }); this.seen(); this.log(`MIDI session open with ${this.state.peer || this.cfg.host}`);
      this.sync();
    } else if (cmd === 'NO') {
      this.log('the other end refused the MIDI session (is the session enabled and allowing "Anyone"?)', 'warn'); this.drop();
    } else if (cmd === 'BY') {
      this.log('the other end closed the MIDI session', 'warn'); this.drop();
    } else if (cmd === 'CK' && m.length >= 36) {
      this.lastSync = Date.now(); this.seen();
      if (m[8] === 1) this.sync(2, [m.readBigUInt64BE(12), m.readBigUInt64BE(20), now100us()]);
    }
  }

  // Incoming RTP-MIDI: emits 'midi' with each complete message as a byte array (notes, CC, MSC,
  // MIDI timecode...). The recovery journal after the command list is ignored.
  receive(m) {
    if ((m[0] & 0xc0) !== 0x80 || (m[1] & 0x7f) !== 0x61) return;
    let off = 12 + (m[0] & 0x0f) * 4;
    const flags = m[off];
    if (flags === undefined) return;
    const len = flags & 0x80 ? ((flags & 0x0f) << 8) | m[off + 1] : flags & 0x0f;
    off += flags & 0x80 ? 2 : 1;
    const end = Math.min(m.length, off + len);
    const delta = () => { for (let i = 0; i < 4 && off < end; i++) if (!(m[off++] & 0x80)) break; };
    const dataLen = st => (st >= 0xf0 ? { 0xf1: 1, 0xf2: 2, 0xf3: 1 }[st] ?? 0 : [0xc0, 0xd0].includes(st & 0xf0) ? 1 : 2);
    let status = this.runningStatus || 0, first = true;
    this.seen();
    while (off < end) {
      if (!first || flags & 0x20) delta();
      first = false;
      if (off >= end) break;
      if (m[off] === 0xf0) { // sysex, complete in one packet
        const stop = m.indexOf(0xf7, off);
        if (stop < 0 || stop >= end) break;
        this.emit('midi', [...m.subarray(off, stop + 1)]);
        off = stop + 1; continue;
      }
      if (m[off] & 0x80) status = m[off++];
      if (!status) break;
      const n = dataLen(status);
      if (off + n > end) break;
      this.emit('midi', [status, ...m.subarray(off, off + n)]);
      off += n;
      if (status < 0xf0) this.runningStatus = status; // running status only carries for channel messages
    }
  }

  midi(bytes) {
    if (this.phase !== 'open') throw new Error('MIDI session not connected');
    const len = bytes.length;
    const head = len <= 15 ? Buffer.from([len]) : Buffer.from([0x80 | ((len >> 8) & 0x0f), len & 0xff]);
    const rtp = Buffer.alloc(12);
    rtp[0] = 0x80; rtp[1] = 0x61; rtp.writeUInt16BE((this.seq = (this.seq + 1) & 0xffff), 2);
    rtp.writeUInt32BE(Number(now100us() & 0xffffffffn), 4); rtp.writeUInt32BE(this.ssrc, 8);
    this.dat.send(Buffer.concat([rtp, head, Buffer.from(bytes)]), this.port + 1, this.cfg.host);
  }
  get ch() { return Math.max(1, Math.min(16, Number(this.cfg.midiChannel) || 1)) - 1; }
  msc(command, a) {
    const ascii = s => [...String(s ?? '').replace(/[^0-9.]/g, '')].map(c => c.charCodeAt(0));
    const fmt = MSC_FORMATS[a.format || this.cfg.mscFormat || 'lighting'] ?? 0x01;
    const dev = Math.max(0, Math.min(127, Number(a.deviceId ?? this.cfg.mscDevice ?? 1)));
    let data = [];
    if (command === 'fire') data = [Number(a.macro) & 0x7f];
    else if (a.cue !== '' && a.cue != null) data = [...ascii(a.cue), ...(a.list ? [0x00, ...ascii(a.list)] : [])];
    return this.midi([0xf0, 0x7f, dev, 0x02, fmt, MSC_CMDS[command], ...data, 0xf7]);
  }

  async command(cmd, a = {}) {
    const ch = a.channel ? Math.max(1, Math.min(16, Number(a.channel))) - 1 : this.ch;
    const b7 = v => Math.max(0, Math.min(127, Math.round(Number(v) || 0)));
    switch (cmd) {
      case 'note': return this.midi([0x90 | ch, b7(a.note), b7(a.velocity ?? 127)]);
      case 'noteoff': return this.midi([0x80 | ch, b7(a.note), 0]);
      case 'cc': return this.midi([0xb0 | ch, b7(a.controller), b7(a.value)]);
      case 'program': return this.midi([0xc0 | ch, b7((Number(a.program) || 1) - 1)]); // shown 1-128 like most gear
      case 'msc': return this.msc(MSC_CMDS[a.action] ? a.action : 'go', a);
      case 'raw': return this.midi(String(a.bytes || '').trim().split(/[\s,]+/).filter(Boolean).map(x => parseInt(x, 16) & 0xff));
      default: return super.command(cmd);
    }
  }

  stop() {
    super.stop(); clearInterval(this.timer);
    if (this.phase === 'open') try { this.ctl.send(exchange('BY', this.token, this.ssrc), this.port, this.cfg.host); } catch { /* closing anyway */ }
    setTimeout(() => { try { this.ctl.close(); this.dat.close(); } catch { /* already closed */ } }, 50);
  }
}

AppleMIDIDriver.meta = {
  label: 'MIDI over the network (Apple Network MIDI / rtpMIDI)', category: 'other',
  fields: [['port', 'port', 'Session port (leave empty for 5004)', '5004'], ['midiChannel', 'number', 'MIDI channel (1-16)', '1'],
    ['mscDevice', 'number', 'MSC device ID (0-127, for MIDI Show Control)', '1'],
    ['mscFormat', 'select:lighting=Lighting|sound=Sound|video=Video|projection=Projection|all=All', 'MSC command format']],
  defaults: { midiChannel: 1, mscDevice: 1, mscFormat: 'lighting' },
  help: [
    'This sends MIDI over the network. The other end needs a network MIDI session: on a Mac open Audio MIDI Setup > Window > Show MIDI Studio > Network, add a session, tick it, and set "Who may connect" to Anyone. On Windows install rtpMIDI (free). Many consoles and apps have one built in.',
    'For real MIDI cables: plug a USB MIDI interface into that Mac or PC and route the network session to it (in Audio MIDI Setup "Live routings").',
    'Type the address of the computer or device with the session and its port (5004 is the usual one). Tap Test: it says connected when the session is open.',
    'For MIDI Show Control, set the device ID and command format to match what the console expects (its MIDI Show Control settings).',
  ],
  commands: {
    msc: [['action', 'select:go|stop|resume|load|fire|alloff|reset', 'go', 'MSC command'], ['cue', 'text', '', 'Cue'], ['list', 'text', '', 'Cue list (optional)'], ['macro', 'number', 1, 'Macro (for fire)']],
    note: [['note', 'number', 60, 'Note (0-127)'], ['velocity', 'number', 127, 'Velocity'], ['channel', 'number', 0, 'Channel (0 = default)']],
    cc: [['controller', 'number', 1, 'Controller'], ['value', 'number', 127, 'Value'], ['channel', 'number', 0, 'Channel (0 = default)']],
    program: [['program', 'number', 1, 'Program (1-128)'], ['channel', 'number', 0, 'Channel (0 = default)']],
    raw: [['bytes', 'text', '', 'Raw MIDI bytes (hex)']],
  },
  commandLabels: { msc: 'MIDI Show Control', note: 'Note on', cc: 'Control change', program: 'Program change', raw: 'Send MIDI bytes' },
};

module.exports = AppleMIDIDriver;
