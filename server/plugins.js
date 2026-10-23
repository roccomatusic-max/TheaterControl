// Plugins: extra kinds of equipment added without changing Show Control itself.
// Drop a .js file into either folder and restart Show Control:
//   <Show Control folder>/plugins/          (ships with the app)
//   <your home>/Show Control/plugins/       (yours; kept when the app is updated)
// See plugins/README.md for how to write one. A plugin that fails to load is listed on the
// Setup screen with the reason, and never stops the show from starting.
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const dgram = require('dgram');
const Driver = require('./drivers/base');

// What a plugin gets handed, so it needn't know where Show Control's files are.
const api = () => ({
  Driver, net, dgram,
  osc: require('./lib/osc'),
  request: require('./lib/http').request,
  result: require('./lib/outcome').result,
  LineSession: require('./lib/line-session').LineSession,
  templates: require('./lib/templates'),
});

function dirs() {
  const list = [path.join(__dirname, '../plugins'), path.join(os.homedir(), 'Show Control', 'plugins')];
  if (process.env.SHOW_PLUGIN_DIR) list.push(...process.env.SHOW_PLUGIN_DIR.split(path.delimiter));
  return [...new Set(list.map(d => path.resolve(d)))];
}

// Adds plugin drivers to `drivers` (type → class). Returns what was loaded and what wasn't.
function load(drivers) {
  const loaded = [], errors = [];
  for (const dir of dirs()) {
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort(); } catch { continue; }
    for (const f of files) {
      const file = path.join(dir, f);
      try {
        let exp = require(file);
        const list = (Array.isArray(exp) ? exp : [exp]).map(x => (typeof x === 'function' && !(x.prototype instanceof Driver) ? x(api()) : x));
        for (const D of list) {
          if (typeof D !== 'function' || !(D.prototype instanceof Driver)) throw new Error('must export a class that extends Driver (see plugins/README.md)');
          const type = String(D.meta?.type || path.basename(f, '.js'));
          if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(type)) throw new Error(`"${type}" is not a usable type name (lower-case letters, numbers and -)`);
          if (drivers[type]) throw new Error(`"${type}" is already a kind of equipment; give the plugin its own type`);
          D.meta = { label: type, category: 'other', fields: [], help: [], commands: {}, ...(D.meta || {}), type, plugin: file };
          drivers[type] = D;
          loaded.push({ type, label: D.meta.label, file });
        }
      } catch (e) {
        errors.push({ file, error: e.message });
        if (!process.env.SHOW_QUIET) console.warn(`plugin ${file} not loaded: ${e.message}`);
      }
    }
  }
  return { loaded, errors };
}

module.exports = { load, dirs };
