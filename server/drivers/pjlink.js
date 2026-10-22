// Any PJLink projector or display (Epson, Panasonic, NEC, Sony, Christie, Barco, Optoma...).
// PJLink only reports ok/warning/error health, never temperatures; the UI says so.
const Driver = require('./base');
const { pjlinkBatch, parseErst, parseLamps, inputLabel } = require('../lib/pjlink');
const { CommandQueue } = require('../lib/line-session');
const { result } = require('../lib/outcome');

const POWER = { 0: 'standby', 1: 'on', 2: 'cooling', 3: 'warming' };

class PJLinkDriver extends Driver {
  constructor(cfg) {
    super(cfg);
    this.kind = 'projector';
    this.queue = new CommandQueue(150);
    this.state = {
      model: cfg.model || 'PJLink', protocol: 'PJLink', power: null, shutter: null, input: null,
      inputs: Object.entries(cfg.inputs || {}).map(([code, label]) => ({ code, label })),
      lamps: null, health: null, healthSource: 'PJLink ERST', temperatures: 'n/a', lastResult: null, info: {},
    };
  }

  start() {
    this.setStatus('connecting');
    this.identify();
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), this.cfg.pollMs || 4000);
    this.slowTimer = setInterval(() => this.batch(['LAMP ?']).then(([l]) => l.outcome === 'ok' && this.patch({ lamps: parseLamps(l.value) })), 60000);
  }

  batch(bodies, priority) {
    return this.queue.push(() => pjlinkBatch(this.cfg.host, this.cfg.port || 4352, this.cfg.password || '', bodies), priority);
  }

  async identify() {
    const [name, mfr, model, inst, lamps] = await this.batch(['NAME ?', 'INF1 ?', 'INF2 ?', 'INST ?', 'LAMP ?']);
    const info = { name: name.value, manufacturer: mfr.value, model: model.value };
    const patch = { info };
    if (mfr.value || model.value) patch.model = [mfr.value, model.value].filter(Boolean).join(' ');
    if (!this.cfg.inputs && inst.outcome === 'ok') patch.inputs = inst.value.split(/\s+/).filter(Boolean).map(code => ({ code, label: inputLabel(code) }));
    if (lamps.outcome === 'ok') patch.lamps = parseLamps(lamps.value);
    this.patch(patch);
  }

  async poll() {
    if (this.queue.pendingPolls) return; // don't pile up polls behind a slow projector
    const [pw, av, inp, er] = await this.batch(['POWR ?', 'AVMT ?', 'INPT ?', 'ERST ?']);
    if (pw.outcome === 'offline' || pw.outcome === 'timeout') return this.setStatus('offline');
    if (pw.outcome === 'auth_failed') { this.setStatus('offline'); return this.patch({ lastResult: { cmd: 'connect', ...pw, t: Date.now() } }); }
    this.seen();
    const patch = {};
    if (pw.outcome === 'ok') patch.power = POWER[pw.value] || pw.value;
    // AVMT ?: 11/31 = video muted (shutter closed); 10/20/21/30 = picture shown
    if (av.outcome === 'ok') patch.shutter = ['11', '31'].includes(av.value) ? 'closed' : 'open';
    else if (av.outcome === 'busy') patch.shutter = null; // standby: unknown, not "open"
    if (inp.outcome === 'ok') patch.input = inp.value;
    if (er.outcome === 'ok') patch.health = parseErst(er.value);
    this.patch(patch);
  }

  async command(cmd, a = {}) {
    let body;
    switch (cmd) {
      case 'power': body = `POWR ${a.on ? 1 : 0}`; break;
      case 'shutter': body = `AVMT ${a.closed ? 31 : 30}`; break;
      case 'input': body = `INPT ${a.input}`; break;
      default: return result('not_sent', `PJLink has no "${cmd}" command`);
    }
    const [r] = await this.batch([body], 'hi');
    this.patch({ lastResult: { cmd: `${cmd} ${JSON.stringify(a)}`, ...r, t: Date.now() } });
    setTimeout(() => this.poll(), 300); // read the real state back rather than assuming it
    return r;
  }

  stop() { super.stop(); clearInterval(this.pollTimer); clearInterval(this.slowTimer); }
}

module.exports = PJLinkDriver;
