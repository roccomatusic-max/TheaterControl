// Figure 53 QLab 4/5 via OSC over UDP (QLab listens on 53000 and replies to the sender's port).
// QLab 5: enable OSC access in Workspace Settings > Network; set a passcode there if you use one.
const dgram = require('dgram');
const osc = require('../lib/osc');
const Driver = require('./base');

class QLabDriver extends Driver {
  constructor(cfg) {
    super(cfg);
    this.state = { playhead: '', playheadName: '', running: [] };
    this.waiting = new Map(); // reply address → [resolve]
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
      const want = this.waiting.get(address.slice(6));
      if (want) { this.waiting.delete(address.slice(6)); want.forEach(f => f(body)); continue; }
      if (body.status && body.status !== 'ok') { this.log(`${body.address}: ${body.status}`, 'warn'); continue; }
      if (address.endsWith('/cue/playhead/number')) this.patch({ playhead: body.data ?? '' });
      else if (address.endsWith('/cue/playhead/displayName')) this.patch({ playheadName: body.data ?? '' });
      else if (address.endsWith('/runningCues/shallow')) this.patch({ running: (body.data || []).map(c => c.listName || c.name || c.number) });
    }
  }

  // Ask QLab something and wait for its /reply. Resolves the reply's data; rejects on no answer.
  query(address, args = [], ms = 2500) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiting.delete(address); reject(new Error('QLab did not answer')); }, ms);
      const list = this.waiting.get(address) || [];
      list.push(body => { clearTimeout(t); body.status && body.status !== 'ok' ? reject(new Error(`QLab said "${body.status}"`)) : resolve(body.data); });
      this.waiting.set(address, list);
      this.send(address, args);
    });
  }

  // Content check: every cue QLab reports as broken, e.g. a video or audio file that has gone
  // missing. Uses /cueLists, then valuesForKeys on each cue (QLab 4 and 5).
  async contentCheck() {
    const lists = await this.query('/cueLists', [], 5000);
    const cues = [];
    const walk = cs => { for (const c of cs || []) { if (c.cues) walk(c.cues); if (!/^(Cue List|Cart|Group)$/.test(c.type)) cues.push(c); } };
    for (const l of lists || []) walk(l.cues);
    const MEDIA = /^(Audio|Video)$/;
    const broken = [];
    let checked = 0;
    for (let i = 0; i < cues.length; i += 20) {
      await Promise.all(cues.slice(i, i + 20).map(async c => {
        const addr = `/cue_id/${c.uniqueID}/valuesForKeys`;
        let v;
        try { v = await this.query(addr, ['["isBroken","fileTarget"]']); }
        catch { v = await this.query(addr, ['["isBroken","fileTarget"]']).catch(() => null); } // UDP: one retry
        if (!v) return;
        checked++;
        if (v.isBroken) broken.push({ number: c.number, name: c.name || c.listName, type: c.type, fileTarget: MEDIA.test(c.type) ? v.fileTarget || null : null });
      }));
    }
    if (checked < cues.length) throw new Error(`QLab only answered for ${checked} of ${cues.length} cues; try again`);
    return { total: cues.length, media: cues.filter(c => MEDIA.test(c.type)).length, broken };
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
