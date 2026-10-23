// Example plugin: a made-up relay box that takes "ON 3" / "OFF 3" over TCP port 2001 and
// answers "OK". Copy this file into a plugins folder, rename it, and change it for your gear.
// (Files in plugins/examples are not loaded; files directly in plugins/ are.)
module.exports = ({ Driver, net, result }) => class ExampleRelay extends Driver {
  // Everything the Setup screen and cue editor need to know.
  static meta = {
    type: 'example-relay',                 // the "type" in show.json; must be unique
    label: 'Example relay box',            // shown in the Add equipment list
    category: 'effects',                   // lighting, sound, playback, cameras, projection, effects, other
    fields: [['port', 'port', 'Port (leave empty for 2001)', '2001']], // extra settings: [key, type, label, placeholder]
    defaults: {},                          // settings a new one starts with
    help: ['Give the relay box a fixed address with its own setup tool.', 'Type the address here and tap Test.'],
    commands: { on: [['relay', 'number', 1, 'Relay']], off: [['relay', 'number', 1, 'Relay']] }, // cue editor: command → [arg, type, default, label]
    commandLabels: { on: 'Relay on', off: 'Relay off' },
  };

  start() {
    this.setStatus('connecting');
    const connect = () => {
      this.sock = net.connect(this.cfg.port || 2001, this.cfg.host);
      this.sock.on('connect', () => this.seen());           // seen() = we heard from it, so it's online
      this.sock.on('data', d => { this.seen(); this.reply?.(d.toString().trim()); });
      this.sock.on('error', e => this.log(e.message, 'warn'));
      this.sock.on('close', () => { this.setStatus('offline'); if (!this.stopped) this.retry = setTimeout(connect, 3000); });
    };
    connect();
  }

  // Return a result: 'ok' (it confirmed), 'sent' (no confirmation possible), 'timeout', 'rejected', ...
  async command(cmd, a = {}) {
    if (cmd !== 'on' && cmd !== 'off') return super.command(cmd);
    if (!this.sock?.writable) return result('offline', 'not connected');
    const answer = new Promise(res => { this.reply = res; setTimeout(() => res(null), 2000); });
    this.sock.write(`${cmd.toUpperCase()} ${Number(a.relay) || 1}\r\n`);
    const r = await answer;
    return r === 'OK' ? result('ok') : r == null ? result('timeout') : result('rejected', r);
  }

  stop() { super.stop(); this.stopped = true; clearTimeout(this.retry); this.sock?.destroy(); }
};
