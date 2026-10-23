// Every kind of equipment Show Control can talk to, by "type" (the "type" in show.json).
// A driver may carry static `meta` (label, settings fields, set-up help, cue commands) that the
// Setup screen and cue editor read; see plugins/README.md. Plugins are added at the end.
const drivers = {
  eos: require('./eos'),
  qlab: require('./qlab'),
  'yamaha-tf': require('./yamaha-tf'),
  ptz: require('./ptz'),
  pjlink: require('./pjlink'),
  panasonic: require('./panasonic'),
  osc: require('./osc-generic'),
  grandma: require('./grandma'),
  magicq: require('./magicq'),
  x32: require('./x32'),
  'allen-heath': require('./allen-heath'),
  'panasonic-cam': require('./panasonic-cam'),
  companion: require('./companion'),
  dmx: require('./dmx'),
  applemidi: require('./applemidi'),
  text: require('./text'),
  http: require('./http'),
};

const plugins = require('../plugins').load(drivers);
Object.defineProperty(drivers, 'plugins', { value: plugins, enumerable: false });

module.exports = drivers;
