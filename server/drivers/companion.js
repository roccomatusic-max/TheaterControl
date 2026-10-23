// Bitfocus Companion (the free Stream Deck software, bitfocus.io/companion). Companion talks
// to 700+ kinds of equipment (ATEM, Avolites, Hog, DiGiCo, Soundcraft, vMix, OBS, Disguise,
// ...), so anything Companion can control, a show cue can control: make a button there, then
// "press" it from a cue. Companion 3 and 4: POST /api/location/<page>/<row>/<column>/press.
// Companion 2: GET /press/bank/<page>/<button>.
const Driver = require('./base');
const { request } = require('../lib/http');
const { result } = require('../lib/outcome');

class CompanionDriver extends Driver {
  constructor(cfg) {
    super(cfg);
    this.state = { lastResult: null };
  }
  start() {
    this.setStatus('connecting');
    this.check();
    this.timer = setInterval(() => this.check(), this.cfg.pollMs || 5000);
  }
  req(o) { return request({ host: this.cfg.host, port: this.cfg.port || 8000, timeout: 3000, ...o }); }
  async check() {
    const r = await this.req({ path: '/' });
    if (r.error) { if (this.status !== 'offline') this.log(r.error, 'warn'); this.setStatus('offline'); } else this.seen();
  }
  async call(method, path) {
    const r = await this.req({ method, path });
    if (r.error) return result(/ETIMEDOUT/.test(r.error) ? 'timeout' : 'offline', r.error);
    this.seen();
    const out = r.status < 300 ? result('ok') : r.status === 404 ? result('rejected', 'Companion has no such button or variable') : result('rejected', `HTTP ${r.status} ${r.body.slice(0, 80)}`);
    this.patch({ lastResult: { ...out, t: Date.now() } });
    return out;
  }
  async command(cmd, a = {}) {
    const v2 = String(this.cfg.version) === '2';
    const loc = `${Number(a.page) || 1}/${Number(a.row) || 0}/${Number(a.column) || 0}`;
    switch (cmd) {
      // Companion 2 numbers its 8-wide grid 1-32 from the top left
      case 'press': return v2 ? this.call('GET', `/press/bank/${Number(a.page) || 1}/${(Number(a.row) || 0) * 8 + (Number(a.column) || 0) + 1}`) : this.call('POST', `/api/location/${loc}/press`);
      case 'down': return this.call('POST', `/api/location/${loc}/down`);
      case 'up': return this.call('POST', `/api/location/${loc}/up`);
      case 'variable': return this.call('POST', `/api/custom-variable/${encodeURIComponent(a.name || '')}/value?value=${encodeURIComponent(a.value ?? '')}`);
      default: return super.command(cmd);
    }
  }
  stop() { super.stop(); clearInterval(this.timer); }
}

CompanionDriver.meta = {
  label: 'Bitfocus Companion (Stream Deck software)', category: 'other',
  fields: [['version', 'select:3=Companion 3 or newer|2=Companion 2', 'Version'], ['port', 'port', 'Port (leave empty for 8000)', '8000']],
  defaults: { version: '3' },
  help: [
    'Companion is free (bitfocus.io/companion) and controls hundreds of kinds of equipment that Show Control does not know directly, like ATEM vision mixers, Avolites and Hog consoles, DiGiCo and Soundcraft desks, vMix and OBS.',
    'Install Companion on this computer or another one on the show network, add your equipment in it, and make a button for each thing you want a cue to do.',
    'The address is the computer running Companion (127.0.0.1 if it is this one). The port is shown in Companion\'s launcher window (usually 8000).',
    'In the cue editor choose "Press Companion button" and type the page, row and column of the button (row and column start at 0, top left).',
  ],
  commands: {
    press: [['page', 'number', 1, 'Page'], ['row', 'number', 0, 'Row (from 0)'], ['column', 'number', 0, 'Column (from 0)']],
    variable: [['name', 'text', '', 'Custom variable'], ['value', 'text', '', 'Value']],
  },
  commandLabels: { press: 'Press Companion button', variable: 'Set Companion variable' },
};

module.exports = CompanionDriver;
