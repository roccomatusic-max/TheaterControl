// The "Add equipment" list: makes and models people recognise, each mapped to the driver that
// speaks to it, with the right defaults, extra set-up steps, and (for the "anything" drivers)
// ready-made cue commands. Several entries can share one driver (every PJLink projector brand,
// every VISCA camera brand). Add a line here to make another brand easy to pick.
//
// Entry: { id, label, category, type, defaults?, keywords?, helpBefore?, help?, templates?, note? }
//   helpBefore: steps shown before the driver's usual set-up steps; help: replaces them
//   templates: named cue commands for osc/text/http drivers (see server/lib/templates.js)
const drivers = require('./drivers');
const { catalogOf, labelsOf } = require('./lib/templates');

const CATEGORIES = [
  ['lighting', 'Lighting consoles'], ['sound', 'Sound desks'], ['playback', 'Playback and video'],
  ['cameras', 'Cameras'], ['projection', 'Projectors and screens'], ['effects', 'Haze, fog, DMX and power'],
  ['other', 'Anything else'],
];

const viaCompanion = (what, module) => [
  `Show Control does not talk to ${what} directly yet, but Bitfocus Companion does (its "${module}" connection). Companion is free: bitfocus.io/companion.`,
  `In Companion, add the ${module} connection and make a button for each thing a cue should do. Then add Companion here, and use "Press Companion button" in cues.`,
];
const pjlinkBrand = (id, brand, how) => ({ id, label: `${brand} projector`, category: 'projection', type: 'pjlink', keywords: 'pjlink', helpBefore: [how] });
const visca = (id, label, protocol, port, how) => ({ id, label, category: 'cameras', type: 'ptz', defaults: { protocol, port, presets: [] }, keywords: 'ptz visca', helpBefore: how ? [how] : [] });

const PROFILES = [
  // ---- lighting
  { id: 'eos', label: 'ETC Eos family (Eos, Ion, Gio, Element, Apex, Nomad)', category: 'lighting', type: 'eos', keywords: 'etc ion element gio apex nomad' },
  { id: 'grandma3', label: 'grandMA3 (console or onPC)', category: 'lighting', type: 'grandma', defaults: { version: '3' }, keywords: 'ma lighting' },
  { id: 'grandma2', label: 'grandMA2 (console or onPC)', category: 'lighting', type: 'grandma', defaults: { version: '2' }, keywords: 'ma lighting' },
  { id: 'magicq', label: 'ChamSys MagicQ', category: 'lighting', type: 'magicq', keywords: 'chamsys mq' },
  { id: 'msc-lighting', label: 'Any console with MIDI Show Control (Hog, Avolites, Strand...)', category: 'lighting', type: 'applemidi', defaults: { mscFormat: 'lighting' }, keywords: 'msc midi show control hog avolites strand' },
  { id: 'avolites', label: 'Avolites Titan (through Companion)', category: 'lighting', type: 'companion', note: 'through Companion', help: viaCompanion('Avolites consoles', 'Avolites Titan') },
  { id: 'hog', label: 'High End Hog 4 (through Companion)', category: 'lighting', type: 'companion', note: 'through Companion', help: viaCompanion('Hog consoles', 'Hog 4') },
  { id: 'onyx', label: 'Obsidian Onyx (through Companion)', category: 'lighting', type: 'companion', note: 'through Companion', help: viaCompanion('Onyx', 'Obsidian Onyx') },
  // ---- sound
  { id: 'yamaha-tf', label: 'Yamaha TF1, TF3, TF5', category: 'sound', type: 'yamaha-tf', keywords: 'yamaha' },
  { id: 'yamaha-cl', label: 'Yamaha CL, QL, RIVAGE PM, DM7', category: 'sound', type: 'yamaha-tf', defaults: { series: 'cl', channels: 64, dcas: 16 }, keywords: 'yamaha',
    help: ['Plug the desk\'s NETWORK port (not Dante) into the show network switch.', 'On the desk: SETUP > NETWORK. Set a fixed address, for example 10.101.50.20, mask 255.255.0.0. (The same setting CL Editor and StageMix use.)',
      'Type the address and tap Test. Scene recall on these desks is not yet checked on a real one: try it before the show.'] },
  { id: 'x32', label: 'Behringer X32 / Midas M32', category: 'sound', type: 'x32', defaults: { series: 'x32' }, keywords: 'behringer midas m32 x32' },
  { id: 'xair', label: 'Behringer X Air / Midas MR (XR12, XR16, XR18, MR18)', category: 'sound', type: 'x32', defaults: { series: 'xair' }, keywords: 'behringer midas xr18 xair' },
  { id: 'allen-heath', label: 'Allen & Heath SQ, Qu, Avantis, dLive', category: 'sound', type: 'allen-heath', keywords: 'a&h ah sq5 sq6 sq7 qu16 qu24 qu32' },
  { id: 'shure', label: 'Shure wireless mic receiver (ULX-D, QLX-D, SLX-D, Axient Digital)', category: 'sound', type: 'shure', defaults: { channels: 4 }, keywords: 'radio mic wireless receiver battery' },
  { id: 'wing', label: 'Behringer Wing (through Companion)', category: 'sound', type: 'companion', note: 'through Companion', help: viaCompanion('the Wing', 'Behringer Wing') },
  { id: 'digico', label: 'DiGiCo (through Companion)', category: 'sound', type: 'companion', note: 'through Companion', help: viaCompanion('DiGiCo desks', 'DiGiCo') },
  { id: 'soundcraft', label: 'Soundcraft Si / Vi / Ui (through Companion)', category: 'sound', type: 'companion', note: 'through Companion', help: viaCompanion('Soundcraft desks', 'Soundcraft') },
  // ---- playback and video
  { id: 'qlab', label: 'QLab 4 or 5', category: 'playback', type: 'qlab', keywords: 'figure 53 sound video' },
  { id: 'resolume', label: 'Resolume Arena / Avenue', category: 'playback', type: 'osc', defaults: { port: 7000 }, keywords: 'video vj',
    help: ['In Resolume open Preferences > OSC. Turn on OSC Input and note the port (7000 is the usual one).', 'Type the address of the Resolume computer (127.0.0.1 if it is this one) and the port.', 'Resolume does not answer back, so check with "Try it now" in the cue editor.'],
    templates: {
      clip: { label: 'Play clip', fields: [['layer', 'number', 1, 'Layer'], ['clip', 'number', 1, 'Clip']], osc: { address: '/composition/layers/{layer}/clips/{clip}/connect', args: [1] } },
      column: { label: 'Play column', fields: [['column', 'number', 1, 'Column']], osc: { address: '/composition/columns/{column}/connect', args: [1] } },
      clearLayer: { label: 'Clear layer', fields: [['layer', 'number', 1, 'Layer']], osc: { address: '/composition/layers/{layer}/clear', args: [1] } },
      clearAll: { label: 'Clear everything', fields: [], osc: { address: '/composition/disconnectall', args: [1] } },
    } },
  { id: 'millumin', label: 'Millumin', category: 'playback', type: 'osc', defaults: { port: 5000 }, keywords: 'video',
    help: ['In Millumin open Devices > OSC and turn on OSC input (port 5000 is the usual one).', 'Type the address of the Millumin computer and the port. Check with "Try it now": Millumin does not answer back.'],
    templates: {
      column: { label: 'Launch column', fields: [['column', 'number', 1, 'Column']], osc: { address: '/millumin/action/launchColumn', args: ['{column}'] } },
      stop: { label: 'Stop column', fields: [], osc: { address: '/millumin/action/stopColumn', args: [] } },
    } },
  { id: 'hyperdeck', label: 'Blackmagic HyperDeck recorder', category: 'playback', type: 'text', defaults: { protocol: 'tcp', port: 9993, ending: 'lf' }, keywords: 'blackmagic recorder record',
    help: ['Give the HyperDeck a fixed address (front panel: Setup > Network, or Blackmagic HyperDeck Setup).', 'Remote control is on by default on port 9993. Type the address and tap Test.'],
    templates: {
      play: { label: 'Play', fields: [], text: 'play' }, stop: { label: 'Stop', fields: [], text: 'stop' }, record: { label: 'Record', fields: [], text: 'record' },
      clip: { label: 'Go to clip', fields: [['clip', 'number', 1, 'Clip']], text: 'goto: clip id: {clip}' },
    } },
  { id: 'videohub', label: 'Blackmagic Videohub router', category: 'playback', type: 'text', defaults: { protocol: 'tcp', port: 9990, ending: 'lf' }, keywords: 'blackmagic router matrix sdi',
    help: ['Give the Videohub a fixed address (Blackmagic Videohub Setup > Configure).', 'Type the address and tap Test. Inputs and outputs are numbered as on the router\'s labels.'],
    templates: { route: { label: 'Route', fields: [['output', 'n1', 0, 'Output'], ['input', 'n1', 0, 'Input']], text: 'VIDEO OUTPUT ROUTING:\\n{output} {input}\\n' } } },
  { id: 'watchout', label: 'Dataton Watchout (production computer)', category: 'playback', type: 'text', defaults: { protocol: 'tcp', port: 3040, ending: 'cr' }, keywords: 'dataton video',
    help: ['Watchout\'s production computer takes commands on port 3040. Make sure its firewall allows it.', 'Type its address and tap Test.'],
    templates: {
      run: { label: 'Run', fields: [], text: 'run' }, halt: { label: 'Pause', fields: [], text: 'halt' },
      cue: { label: 'Go to cue', fields: [['cue', 'text', '', 'Cue name']], text: 'gotoControlCue "{cue}"' },
    } },
  { id: 'atem', label: 'Blackmagic ATEM vision mixer (through Companion)', category: 'playback', type: 'companion', note: 'through Companion', help: viaCompanion('ATEM', 'Blackmagic ATEM') },
  { id: 'vmix-obs', label: 'vMix or OBS (through Companion)', category: 'playback', type: 'companion', note: 'through Companion', help: viaCompanion('vMix and OBS', 'vMix / OBS') },
  { id: 'disguise', label: 'disguise / d3 (through Companion)', category: 'playback', type: 'companion', note: 'through Companion', help: viaCompanion('disguise', 'disguise') },
  // ---- cameras
  visca('sony', 'Sony PTZ camera', 'visca-ip', 52381, 'Sony: in the camera\'s web page, check Network > VISCA over IP is on.'),
  visca('birddog', 'BirdDog PTZ camera', 'visca-ip', 52381, 'BirdDog: in its web page, under Network > Camera control, turn on VISCA over IP.'),
  visca('ptzoptics', 'PTZOptics camera', 'visca-tcp', 5678, 'PTZOptics: VISCA over TCP is on by default on port 5678.'),
  visca('lumens', 'Lumens PTZ camera', 'visca-tcp', 5678, 'Lumens: in its web page, under Setting > Network, check the VISCA over IP port.'),
  visca('marshall', 'Marshall PTZ camera', 'visca-ip', 52381),
  visca('aver', 'AVer PTZ camera', 'visca-ip', 52381),
  visca('visca', 'Other PTZ camera (VISCA)', 'visca-ip', 52381),
  { id: 'panasonic-cam', label: 'Panasonic PTZ camera (AW-UE, AW-HE)', category: 'cameras', type: 'panasonic-cam', defaults: { presets: [] }, keywords: 'aw ue150 ue80 he40' },
  // ---- projectors
  { id: 'panasonic', label: 'Panasonic projector (PT-DZ13K, PT-DZ770 series)', category: 'projection', type: 'panasonic', defaults: { model: 'pt-dz13k', username: 'admin1' }, keywords: 'ntcontrol' },
  pjlinkBrand('epson', 'Epson', 'Epson: in the menu, Network > Network Settings > Control turn PJLink on, and set Standby Mode to Communication On.'),
  pjlinkBrand('nec', 'NEC / Sharp', 'NEC/Sharp: in the menu, Setup > Control > Network service turn PJLink on, and set Standby Mode to Network Standby.'),
  pjlinkBrand('sony-proj', 'Sony', 'Sony: in the menu, Connection/Power > Network Settings turn PJLink on, and set Standby Mode to Standard.'),
  pjlinkBrand('optoma', 'Optoma', 'Optoma: in the menu, Network > Control turn PJLink on.'),
  pjlinkBrand('christie', 'Christie', 'Christie: PJLink is under Configuration > Communications.'),
  pjlinkBrand('barco', 'Barco', 'Barco: PJLink is under Installation > Communication (some models need the Projector Toolset to turn it on).'),
  pjlinkBrand('benq', 'BenQ', 'BenQ: in the menu, Network Settings turn PJLink on, and set Standby settings > Network to On.'),
  { id: 'pjlink', label: 'Any other projector or screen with PJLink', category: 'projection', type: 'pjlink', keywords: 'pjlink canon hitachi viewsonic casio maxell display tv' },
  // ---- effects, DMX, power
  { id: 'sacn', label: 'DMX node or fixture over sACN (hazer, fog, LED)', category: 'effects', type: 'dmx', defaults: { protocol: 'sacn', universe: 10 }, keywords: 'dmx e1.31 haze hazer fog smoke led enttec dmxking' },
  { id: 'artnet', label: 'DMX node or fixture over Art-Net', category: 'effects', type: 'dmx', defaults: { protocol: 'artnet', universe: 9 }, keywords: 'dmx artnet haze hazer fog smoke led enttec' },
  { id: 'shelly2', label: 'Shelly smart relay or plug (Plus, Pro, Gen 2 and newer)', category: 'effects', type: 'http', keywords: 'power socket relay plug switch',
    help: ['Set the Shelly up with its app on the control Wi-Fi or the show network, and give it a fixed address (Settings > Wi-Fi or Ethernet > Static IP).', 'Type its address and tap Test.'],
    templates: {
      on: { label: 'Turn on', fields: [['relay', 'number', 0, 'Relay (0 for the first)']], http: { path: '/rpc/Switch.Set?id={relay}&on=true' } },
      off: { label: 'Turn off', fields: [['relay', 'number', 0, 'Relay (0 for the first)']], http: { path: '/rpc/Switch.Set?id={relay}&on=false' } },
    } },
  { id: 'shelly1', label: 'Shelly smart relay or plug (Gen 1)', category: 'effects', type: 'http', keywords: 'power socket relay plug switch',
    help: ['Give the Shelly a fixed address in its app or web page (Internet & Security > Wi-Fi client > static IP).', 'Type its address and tap Test.'],
    templates: {
      on: { label: 'Turn on', fields: [['relay', 'number', 0, 'Relay (0 for the first)']], http: { path: '/relay/{relay}?turn=on' } },
      off: { label: 'Turn off', fields: [['relay', 'number', 0, 'Relay (0 for the first)']], http: { path: '/relay/{relay}?turn=off' } },
    } },
  // ---- anything else
  { id: 'companion', label: 'Bitfocus Companion (controls 700+ other kinds of gear)', category: 'other', type: 'companion', keywords: 'stream deck streamdeck' },
  { id: 'osc', label: 'Anything that takes OSC (TouchDesigner, Isadora, Max...)', category: 'other', type: 'osc', keywords: 'touchdesigner isadora max msp ableton' },
  { id: 'midi', label: 'MIDI over the network (and MIDI cables through a Mac)', category: 'other', type: 'applemidi', keywords: 'rtpmidi msc midi show control note' },
  { id: 'tcp', label: 'Anything that takes text commands over TCP (telnet)', category: 'other', type: 'text', defaults: { protocol: 'tcp', ending: 'cr' }, keywords: 'telnet extron kramer crestron rs232' },
  { id: 'udp', label: 'Anything that takes text commands over UDP', category: 'other', type: 'text', defaults: { protocol: 'udp', ending: 'cr' }, keywords: 'udp' },
  { id: 'http', label: 'Anything with a web address (HTTP)', category: 'other', type: 'http', keywords: 'web url api rest' },
];

// Driver-provided settings, help and cue commands for types that describe themselves (incl. plugins).
function typeInfo() {
  return Object.fromEntries(Object.entries(drivers).filter(([, D]) => D.meta).map(([type, D]) => {
    const m = D.meta;
    return [type, { label: m.label, category: m.category || 'other', fields: m.fields || [], help: m.help || [], defaults: m.defaults || {},
      oneWay: !!m.oneWay, oneWayWhen: m.oneWayWhen || null, addressOptional: m.addressOptional || null, plugin: !!m.plugin }];
  }));
}

// Everything the "Add equipment" list needs: plugins appear as their own entries too.
function profiles() {
  const info = typeInfo();
  const list = PROFILES.filter(p => drivers[p.type]).map(p => {
    const t = info[p.type] || {};
    const out = { ...p, defaults: { ...(t.defaults || {}), ...(p.defaults || {}) } };
    if (!p.help && t.help) out.help = [...(p.helpBefore || []), ...t.help];
    if (t.fields) out.fields = t.fields;
    delete out.templates;
    if (p.templates) out.commands = Object.keys(p.templates);
    return out;
  });
  for (const [type, t] of Object.entries(info)) {
    if (t.plugin) list.push({ id: type, label: t.label, category: t.category, type, defaults: t.defaults, fields: t.fields, help: t.help, note: 'plugin' });
  }
  return list;
}

// Cue editor commands: per driver type (from meta), and per entry with ready-made commands.
// Entries with templates also keep their driver's own commands (e.g. "Send OSC") at the end.
function cueCatalog() {
  const catalog = {}, labels = {};
  for (const [type, D] of Object.entries(drivers)) {
    if (!D.meta?.commands) continue;
    catalog[type] = D.meta.commands; Object.assign(labels, D.meta.commandLabels || {});
  }
  for (const p of PROFILES) {
    if (!p.templates || !drivers[p.type]) continue;
    catalog[p.id] = { ...catalogOf(p.templates), ...(drivers[p.type].meta?.commands || {}) };
    for (const [k, l] of Object.entries(labelsOf(p.templates))) labels[`${p.id}:${k}`] = l;
  }
  return { catalog, labels };
}

const templatesFor = profileId => PROFILES.find(p => p.id === profileId)?.templates || null;
const profileById = id => PROFILES.find(p => p.id === id) || null;

// A driver that gives no answer back (so "Test" can only check the address is reachable).
function isOneWay(dc) {
  const m = drivers[dc.type]?.meta;
  if (!m) return false;
  if (m.oneWay) return true;
  return !!m.oneWayWhen && Object.entries(m.oneWayWhen).every(([k, v]) => String(dc[k] ?? m.defaults?.[k] ?? '') === v);
}

module.exports = { CATEGORIES, PROFILES, profiles, typeInfo, cueCatalog, templatesFor, profileById, isOneWay };
