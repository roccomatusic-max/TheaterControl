// Anything with a web address you can "visit" to make it do something: smart plugs and
// relays (Shelly), web-controlled players, venue systems. Commands: get/post a path, plus
// ready-made commands from the brand picked on the Setup screen.
// "Online" means the device's web server answers at all (any reply, even "not found").
const Driver = require('./base');
const { request } = require('../lib/http');
const { fill } = require('../lib/templates');
const { result } = require('../lib/outcome');

class HTTPDriver extends Driver {
  constructor(cfg) {
    super(cfg);
    this.state = { lastResult: null };
  }
  start() {
    this.setStatus('connecting');
    this.check();
    this.timer = setInterval(() => this.check(), this.cfg.pollMs || 10000);
  }
  async check() {
    const r = await this.req({ path: this.cfg.checkPath || '/' });
    if (r.error) { if (this.status !== 'offline') this.log(r.error, 'warn'); this.setStatus('offline'); } else this.seen();
  }
  req(o) {
    const { host, port, https, username, password } = this.cfg;
    return request({ host, port, https: !!https, user: username, password, timeout: 3000, ...o });
  }
  async call(method, path, body) {
    const r = await this.req({ method, path, body: body === '' ? undefined : body });
    if (r.error) return result(/ETIMEDOUT/.test(r.error) ? 'timeout' : 'offline', r.error);
    this.seen();
    const out = r.status < 300 ? result('ok', `HTTP ${r.status}`) : r.status === 401 || r.status === 403 ? result('auth_failed', `HTTP ${r.status}`) : result('rejected', `HTTP ${r.status} ${r.body.slice(0, 80)}`);
    this.patch({ lastResult: { ...out, t: Date.now() } });
    return out;
  }
  async command(cmd, a = {}) {
    const t = this.cfg.templates?.[cmd];
    if (t?.http) return this.call(t.http.method || 'GET', fill(t.http.path, a), t.http.body != null ? fill(t.http.body, a) : undefined);
    if (cmd === 'get') return this.call('GET', a.path || '/');
    if (cmd === 'post') return this.call('POST', a.path || '/', a.body ?? '');
    return super.command(cmd);
  }
  stop() { super.stop(); clearInterval(this.timer); }
}

HTTPDriver.meta = {
  label: 'Anything with a web address (HTTP)', category: 'other',
  fields: [['port', 'port', 'Port (leave empty for 80)', '80'], ['username', 'text', 'Username (if it asks for one)', ''], ['password', 'password', 'Password', '']],
  help: [
    'Many devices can be told what to do by visiting a web address, like http://10.101.50.40/relay/0?turn=on. The device\'s manual calls this its "HTTP API" or "URL commands".',
    'Type the device\'s address here, then in the cue editor use "Visit web address" with the part after the address (for example /relay/0?turn=on).',
  ],
  commands: { get: [['path', 'text', '/', 'Web address after the host (e.g. /relay/0?turn=on)']], post: [['path', 'text', '/', 'Path'], ['body', 'text', '', 'Body']] },
  commandLabels: { get: 'Visit web address', post: 'Send to web address' },
};

module.exports = HTTPDriver;
