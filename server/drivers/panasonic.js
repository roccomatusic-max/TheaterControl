// Panasonic projectors over the LAN command protocol ("NTCONTROL", TCP 1024).
// Ported from Projector Control (roccomatusic-max/Projectionmapping, docs/PROTOCOL-RESEARCH.md):
//  - greeting "NTCONTROL 0" or "NTCONTROL 1 <random>"; protect mode prefixes the FIRST command
//    with md5("user:password:random") (not PJLink's digest)
//  - frames "00<CMD>\r"; replies "00<CMD>" (ack), "00<value>" or "00<CMD>:<value>" (query),
//    LAN errors ERR1-5/ERRA, device errors 00ER401-404
//  - > 0.5 s between commands; some firmware closes the socket after each reply
//  - power is confirmed by reading QPW, never assumed; power is never retried after a timeout
//  - commands only documented for sibling models are not sent unless allowUnverified is set
const crypto = require('crypto');
const Driver = require('./base');
const { LineSession, CommandQueue } = require('../lib/line-session');
const { pjlinkBatch, parseErst } = require('../lib/pjlink');
const { result } = require('../lib/outcome');

const LABELS = { RG1: 'RGB1', RG2: 'RGB2', VID: 'VIDEO', SVD: 'S-VIDEO', DVI: 'DVI-D', HD1: 'HDMI', SD1: 'SDI 1', SD2: 'SDI 2', DL1: 'DIGITAL LINK' };
const pick = (...codes) => codes.map(code => ({ code, label: LABELS[code] }));
const MODELS = {
  'pt-dz13k': { name: 'Panasonic PT-DZ13K series', inputs: pick('RG1', 'RG2', 'VID', 'DVI', 'HD1', 'SD1', 'SD2'), optional: ['SD1', 'SD2'], lamps: 4 },
  'pt-dz770': { name: 'Panasonic PT-DZ770 series', inputs: pick('RG1', 'RG2', 'DVI', 'HD1', 'VID', 'SVD'), optional: [], lamps: 2 },
};

// provenance: doc = in a Panasonic document naming the model; family = sibling model only (gated)
const CAPS = {
  power: 'doc', shutter: 'doc', input: 'doc', lensHome: 'doc', freeze: 'family',
};

const LAN_ERRORS = {
  ERR1: ['unsupported', 'undefined control command'], ERR2: ['rejected', 'parameter out of range'],
  ERR3: ['busy', 'projector busy'], ERR4: ['busy', 'not acceptable in this period'],
  ERR5: ['rejected', 'wrong data length'], ERRA: ['auth_failed', 'password mismatch'],
};
const DEVICE_ERRORS = {
  ER401: ['unsupported', 'not available on this model or in this state'],
  ER402: ['rejected', 'invalid parameter, or input is being driven by REMOTE2'],
  ER403: ['busy', 'not acceptable in the current state'], ER404: ['fault', 'projector reported a fault'],
};

const COOLDOWN_MS = 120000, WARMUP_MS = 60000;

class PanasonicDriver extends Driver {
  constructor(cfg) {
    super(cfg);
    this.kind = 'projector';
    this.model = MODELS[cfg.model] || MODELS['pt-dz13k'];
    this.session = new LineSession(cfg.host, cfg.port || 1024, { readTimeout: cfg.timeoutMs || 4000 });
    this.queue = new CommandQueue(cfg.gapMs ?? 600);
    this.digest = null; this.digestUsed = false;
    this.onAt = null; this.offAt = null; this.timeouts = 0;
    this.state = {
      model: this.model.name, protocol: 'Panasonic LAN', power: null, transition: null, shutter: null, input: null,
      inputs: this.model.inputs, unavailableInputs: {}, lamps: null, health: null, healthSource: null,
      temperatures: 'not read', allowUnverified: !!cfg.allowUnverified, lastResult: null,
    };
  }

  // ---------- wire ----------
  async openSession() {
    await this.session.open();
    const greet = await this.session.readLine();
    const m = greet.match(/^NTCONTROL\s+([01])(?:\s+(\S+))?/);
    if (!m) throw Object.assign(new Error(`unexpected greeting ${greet}`), { code: 'fault' });
    if (m[1] === '1') {
      if (!this.cfg.password) throw Object.assign(new Error('projector is in protect mode; set "username" and "password" (its web login, usually admin1)'), { code: 'auth_failed' });
      this.digest = crypto.createHash('md5').update(`${this.cfg.username || 'admin1'}:${this.cfg.password}:${m[2]}`).digest('hex');
    } else this.digest = null;
    this.digestUsed = false;
  }

  // Send one command and classify the reply. Runs inside the queue.
  async raw(cmd) {
    const t0 = Date.now();
    try {
      if (!this.session.connected) await this.openSession();
      const prefix = this.digest && !this.digestUsed ? this.digest : '';
      this.session.write(`${prefix}00${cmd}\r`);
      this.digestUsed = true; // consumed on write: the projector has read it even if no reply comes
      const reply = (await this.session.readLine()).trim();
      this.seen();
      return { ...this.classify(cmd, reply), ms: Date.now() - t0 };
    } catch (e) {
      if (e.code === 'auth_failed') return result('auth_failed', e.message);
      if (e.code === 'closed') this.session.close();
      if (e.code === 'timeout') { this.session.close(); return result('timeout', `no reply to ${cmd}`); }
      this.setStatus('offline');
      return result('offline', e.message);
    }
  }

  classify(cmd, reply) {
    const up = reply.toUpperCase();
    if (LAN_ERRORS[up]) { const [o, why] = LAN_ERRORS[up]; return result(o, why, { raw: reply }); }
    const body = up.startsWith('00') ? reply.slice(2) : reply;
    const code = body.toUpperCase().slice(0, 5);
    if (DEVICE_ERRORS[code]) { const [o, why] = DEVICE_ERRORS[code]; return result(o, why, { raw: reply }); }
    if (/^ER\d{3}/i.test(body)) return result('rejected', `projector returned ${code}`, { raw: reply });
    const mnemonic = cmd.split(':')[0];
    const isQuery = /^Q/.test(mnemonic);
    if (!isQuery) return result('accepted', '', { raw: reply });
    const value = body.toUpperCase().startsWith(mnemonic + ':') ? body.slice(mnemonic.length + 1) : body;
    return result('ok', '', { value: value.trim(), raw: reply });
  }

  send(cmd, priority = 'lo') { return this.queue.push(() => this.raw(cmd), priority); }

  // ---------- state ----------
  // Upper estimates; QPW reads standby while cooling, so this is how cooling is reported at all.
  cooling() { return !!this.offAt && Date.now() - this.offAt < (this.cfg.cooldownMs || COOLDOWN_MS); }
  warming() { return !!this.onAt && Date.now() - this.onAt < (this.cfg.warmupMs || WARMUP_MS); }

  start() {
    this.setStatus('connecting');
    // Poll faster while warming up or cooling down, so the iPad sees the change promptly.
    const loop = async () => {
      await this.poll();
      if (!this.stopped) this.pollTimer = setTimeout(loop, this.state.transition ? 1500 : this.cfg.pollMs || 5000);
    };
    loop();
    this.slowTimer = setInterval(() => this.slowPoll(), 60000);
    setTimeout(() => this.slowPoll(), 1500);
  }

  async poll() {
    if (this.queue.pendingPolls) return;
    const pw = await this.send('QPW');
    if (pw.outcome === 'offline') return;
    if (pw.outcome === 'timeout') { if (++this.timeouts >= 2) this.setStatus('offline'); return; }
    this.timeouts = 0;
    if (pw.outcome === 'auth_failed') { this.setStatus('offline'); return this.patch({ lastResult: { cmd: 'connect', ...pw, t: Date.now() } }); }
    const patch = {};
    if (pw.outcome === 'ok') {
      const on = /^0*1$/.test(pw.value);
      patch.power = on ? 'on' : 'standby';
      if (on && this.offAt) this.offAt = null;
      if (!on && this.onAt && !this.warming()) this.onAt = null;
    }
    patch.transition = this.cooling() ? 'cooling' : this.warming() ? 'warming' : null;
    if (patch.power === 'on') {
      const sh = await this.send('QSH'); const inp = await this.send('QIN');
      if (sh.outcome === 'ok') patch.shutter = sh.value.endsWith('1') ? 'closed' : 'open'; // OSH/QSH: 1 = CLOSED
      if (inp.outcome === 'ok') patch.input = inp.value;
    } else { patch.shutter = null; patch.input = null; } // standby: unknown, never guessed
    this.patch(patch);
  }

  async slowPoll() {
    const lamps = [];
    for (let i = 1; i <= this.model.lamps; i++) {
      const r = await this.send(`Q$L:${i}`);
      lamps.push(r.outcome === 'ok' && /^\d+$/.test(r.value) ? { hours: Number(r.value) } : { hours: null, why: r.outcome === 'ok' ? `unparsed "${r.value}"` : r.detail || r.outcome });
    }
    this.patch({ lamps });
    // Fan / lamp / temperature condition comes from PJLink ERST, which Panasonic units also answer.
    if (this.cfg.pjlink !== false) {
      const [er] = await pjlinkBatch(this.cfg.host, this.cfg.pjlinkPort || 4352, this.cfg.pjlinkPassword ?? this.cfg.password ?? '', ['ERST ?']);
      this.patch(er.outcome === 'ok' ? { health: parseErst(er.value), healthSource: 'PJLink ERST' } : { healthSource: `PJLink: ${er.detail || er.outcome}` });
    }
  }

  // ---------- commands ----------
  gate(cap) {
    if (!CAPS[cap]) return result('not_sent', `${this.model.name}: no "${cap}" command`);
    if (CAPS[cap] === 'family' && !this.cfg.allowUnverified)
      return result('not_sent', `"${cap}" is only documented for sibling Panasonic models; set "allowUnverified": true for this projector after checking its manual`);
    return null;
  }

  // ER401 in standby or during warm-up/cool-down is about the projector's state, not the model.
  explain(cmd, r) {
    if (!['unsupported', 'busy'].includes(r.outcome) || !r.raw) return r;
    let why;
    if (cmd === 'PON') { if (this.state.power === 'on' && !this.cooling()) return r; why = 'cooling down after power-off; it will accept power-on in 1-2 minutes'; if (!this.cooling()) this.offAt = Date.now() - (this.cfg.cooldownMs || COOLDOWN_MS) + 30000; }
    else if (cmd === 'POF') { if (!this.warming()) return r; why = 'still starting up; it will accept power-off once start-up finishes'; }
    else if (this.cooling()) why = 'cooling down; this works once it is on again';
    else if (this.warming()) why = 'still starting up; try again in a moment';
    else if (this.state.power === 'standby') why = 'in standby; this works once the projector is on';
    else return r;
    return { ...r, outcome: 'busy', detail: `${why} (projector answered ${r.raw})` };
  }

  async command(cmd, a = {}) {
    const blocked = this.gate(cmd);
    if (blocked) return this.finish(cmd, a, blocked);
    let wire;
    switch (cmd) {
      case 'power': wire = a.on ? 'PON' : 'POF'; break;
      case 'shutter': wire = `OSH:${a.closed ? 1 : 0}`; break; // 1 CLOSES the shutter
      case 'input': {
        const code = String(a.input).toUpperCase();
        if (!this.model.inputs.some(i => i.code === code)) return this.finish(cmd, a, result('not_sent', `${code} is not an input on ${this.model.name}`));
        wire = `IIS:${code}`; break;
      }
      case 'lensHome': wire = 'VXX:LNSI1'; break;
      case 'freeze': wire = `OFZ:${a.on ? 1 : 0}`; break;
    }
    let r = this.explain(wire.split(':')[0], await this.send(wire, 'hi'));
    if (r.outcome === 'accepted' && cmd === 'power') { if (a.on) { this.onAt = Date.now(); this.offAt = null; } else { this.offAt = Date.now(); this.onAt = null; } }
    if (r.outcome === 'timeout' && cmd === 'power') r = { ...r, detail: `${r.detail}. Not retried: reading the power state instead` };
    if (cmd === 'input' && r.outcome === 'unsupported' && this.state.power === 'on' && !this.warming()) {
      const code = String(a.input).toUpperCase();
      const why = this.model.optional.includes(code) ? 'input board not fitted' : 'projector refused this input';
      this.patch({ unavailableInputs: { ...this.state.unavailableInputs, [code]: why } });
    }
    setTimeout(() => this.poll(), 200); // confirm from the projector, don't assume
    return this.finish(cmd, a, r);
  }

  finish(cmd, a, r) { this.patch({ lastResult: { cmd: `${cmd} ${JSON.stringify(a)}`, ...r, t: Date.now() } }); return r; }

  stop() { super.stop(); this.stopped = true; clearTimeout(this.pollTimer); clearInterval(this.slowTimer); this.session.close(); }
}

PanasonicDriver.MODELS = MODELS;
module.exports = PanasonicDriver;
