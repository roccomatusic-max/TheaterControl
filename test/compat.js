// Equipment compatibility: every new driver against a fake device speaking its protocol on
// this computer, the Add equipment list, plugins, the network search, and Test in plain words.
const net = require('net');
const http = require('http');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showctl-plugins-'));
fs.copyFileSync(path.join(__dirname, '../plugins/examples/example-relay.js'), path.join(pluginDir, 'example-relay.js'));
fs.writeFileSync(path.join(pluginDir, 'broken.js'), 'module.exports = 42;');
fs.writeFileSync(path.join(pluginDir, 'eos.js'), "module.exports = ({ Driver }) => class extends Driver { static meta = { type: 'eos' }; };");
process.env.SHOW_PLUGIN_DIR = pluginDir;

const drivers = require('../server/drivers');
const catalog = require('../server/catalog');
const setup = require('../server/setup');
const { discover } = require('../server/discover');
const osc = require('../server/lib/osc');
const X32 = require('../server/drivers/x32');

const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await wait(20); } throw new Error('timed out waiting'); };
const udpServer = () => new Promise(r => { const s = dgram.createSocket('udp4'); s.bind(0, '127.0.0.1', () => r(s)); });
const tcpServer = onConn => new Promise(r => { const s = net.createServer(onConn); s.listen(0, '127.0.0.1', () => r(s)); });
const httpServer = fn => new Promise(r => { const s = http.createServer(fn); s.listen(0, '127.0.0.1', () => r(s)); });
const make = (type, cfg) => { const D = drivers[type]; const tpl = catalog.templatesFor(cfg.profile); return new D({ id: type, type, host: '127.0.0.1', ...cfg, ...(tpl ? { templates: tpl } : {}) }); };

(async () => {
  // ---- the Add equipment list
  const profiles = catalog.profiles();
  assert.ok(profiles.length >= 50, `brands in the list: ${profiles.length}`);
  for (const p of catalog.PROFILES) assert.ok(drivers[p.type], `${p.id} uses a real driver (${p.type})`);
  assert.equal(new Set(catalog.PROFILES.map(p => p.id)).size, catalog.PROFILES.length, 'entry ids are unique');
  for (const p of profiles) assert.ok(catalog.CATEGORIES.some(([c]) => c === p.category), `${p.id} has a known category`);
  const cue = catalog.cueCatalog();
  assert.ok(cue.catalog.resolume.clip && cue.catalog.resolume.send, 'Resolume gets "Play clip" plus raw OSC');
  assert.equal(cue.labels['videohub:route'], 'Route');
  assert.ok(profiles.find(p => p.id === 'epson').helpBefore[0].startsWith('Epson'), 'brand steps come first');
  assert.ok(profiles.find(p => p.id === 'hog').help[0].includes('Companion'), 'through-Companion entries explain how');

  // ---- plugins
  assert.ok(drivers['example-relay'], 'plugin loaded');
  assert.ok(profiles.find(p => p.id === 'example-relay' && p.note === 'plugin'), 'plugin is in the Add equipment list');
  assert.ok(drivers.plugins.errors.some(e => e.file.endsWith('broken.js')), 'broken plugin reported, not fatal');
  assert.ok(drivers.plugins.errors.some(e => /already a kind/.test(e.error)), 'plugins cannot replace built-in drivers');
  assert.notEqual(drivers.eos.meta?.plugin, true);
  {
    let got = '';
    const srv = await tcpServer(s => s.on('data', d => { got += d; s.write('OK\r\n'); }));
    const d = make('example-relay', { port: srv.address().port }); d.start();
    await until(() => d.status === 'online');
    assert.equal((await d.command('on', { relay: 3 })).outcome, 'ok');
    assert.equal(got, 'ON 3\r\n');
    d.stop(); srv.close();
  }

  // ---- X32: faders in dB both ways, scene recall, names
  {
    assert.ok(Math.abs(X32.toFloat(0) - 0.75) < 0.001); assert.equal(X32.toDb(0.75), 0);
    assert.ok(Math.abs(X32.toDb(X32.toFloat(-20)) + 20) < 0.1);
    const s = await udpServer(); const got = [];
    s.on('message', (m, r) => {
      const { address, args } = osc.decode(m); got.push({ address, args });
      const reply = (a, x) => s.send(osc.encode(a, x), r.port, r.address);
      if (address === '/info') reply('/info', ['V2.07', 'osc-server', 'X32', '4.06']);
      if (address === '/ch/01/mix/fader' && !args.length) reply(address, [{ type: 'f', value: 0.75 }]);
      if (address === '/ch/01/config/name' && !args.length) reply(address, ['Lead']);
    });
    const d = make('x32', { port: s.address().port }); d.start();
    await until(() => d.state.channels[0].name === 'Lead');
    assert.equal(d.status, 'online'); assert.equal(d.state.model, 'X32'); assert.equal(d.state.channels[0].level, 0);
    await d.command('level', { strip: 'dca', index: 1, db: -10 });
    await d.command('scene', { scene: 12 });
    await d.command('on', { strip: 'master', index: 0, on: false });
    await until(() => got.some(g => g.address === '/main/st/mix/on' && g.args.length) && got.some(g => g.address === '/dca/2/fader' && g.args.length));
    assert.ok(Math.abs(got.find(g => g.address === '/dca/2/fader' && g.args.length).args[0] - 0.5) < 0.002);
    assert.deepEqual(got.find(g => g.address === '/-action/goscene').args, [12]);
    const t = await setup.testDevice({ id: 'x', type: 'x32', host: '127.0.0.1', port: s.address().port });
    assert.ok(t.ok && /X32/.test(t.detail), t.detail);
    d.stop(); s.close();
  }

  // ---- grandMA2 over telnet, grandMA3 over OSC
  {
    let got = '';
    const srv = await tcpServer(s => { s.write('Welcome to grandMA2\r\n'); s.on('data', d => { got += d; }); });
    const d = make('grandma', { version: '2', port: srv.address().port, password: 'pw' }); d.start();
    await until(() => d.status === 'online');
    await d.command('goto', { cue: 5, target: 'Executor 1.1' });
    await until(() => got.includes('Goto'));
    assert.ok(got.startsWith('Login "administrator" "pw"\r\n') && got.includes('Goto Cue 5 Executor 1.1\r\n'), got);
    d.stop(); srv.close();
    const s = await udpServer(); let m3;
    s.on('message', m => (m3 = osc.decode(m)));
    const d3 = make('grandma', { version: '3', port: s.address().port }); d3.start();
    await d3.command('go', { target: 'Sequence 4' });
    await until(() => m3);
    assert.deepEqual(m3, { address: '/gma3/cmd', args: ['Go+ Sequence 4'] });
    assert.ok(catalog.isOneWay({ type: 'grandma', version: '3' }) && !catalog.isOneWay({ type: 'grandma', version: '2' }));
    d3.stop(); s.close();
  }

  // ---- MagicQ, Resolume (OSC templates), generic OSC with typed values
  {
    const s = await udpServer(); const got = [];
    s.on('message', m => got.push(osc.decode(m)));
    const mq = make('magicq', { port: s.address().port }); mq.start();
    await mq.command('jump', { playback: 2, cue: '7.5' });
    const res = make('osc', { profile: 'resolume', port: s.address().port }); res.start();
    await res.command('clip', { layer: 2, clip: 3 });
    await res.command('send', { address: '/x', args: '1, 0.5, hi' });
    await until(() => got.length === 3);
    assert.deepEqual(got.map(g => g.address), ['/pb/2/7.5', '/composition/layers/2/clips/3/connect', '/x']);
    assert.deepEqual(got[2].args.map(a => (typeof a === 'number' ? +a.toFixed(2) : a)), [1, 0.5, 'hi']);
    mq.stop(); res.stop(); s.close();
  }

  // ---- Allen & Heath scene recall: bank select + program change
  {
    let got = Buffer.alloc(0);
    const srv = await tcpServer(s => s.on('data', d => { got = Buffer.concat([got, d]); }));
    const d = make('allen-heath', { port: srv.address().port, midiChannel: 2 }); d.start();
    await until(() => d.status === 'online');
    await d.command('scene', { scene: 132 });
    await until(() => got.length === 5);
    assert.equal(got.toString('hex'), 'b10001c103');
    d.stop(); srv.close();
  }

  // ---- Panasonic PTZ camera over HTTP
  {
    const hits = [];
    const srv = await httpServer((q, r) => { const c = new URL(q.url, 'http://x').searchParams.get('cmd'); hits.push(c); r.end(c === '#O' ? 'p1' : c.replace('#R', 's')); });
    const d = make('panasonic-cam', { port: srv.address().port, pollMs: 100 }); d.start();
    await until(() => d.state.power === true);
    assert.equal((await d.command('preset', { preset: 3 })).outcome, 'ok');
    await d.command('move', { pan: 1, tilt: 0 });
    assert.ok(hits.includes('#R02') && hits.includes('#PTS9950'), hits.join(' '));
    d.stop(); srv.close();
    const off = await (make('panasonic-cam', { port: 1 })).command('home');
    assert.equal(off.outcome, 'offline');
  }

  // ---- Companion and Shelly over HTTP
  {
    const hits = [];
    const srv = await httpServer((q, r) => { hits.push(`${q.method} ${q.url}`); r.statusCode = q.url.includes('missing') ? 404 : 200; r.end('Bitfocus Companion'); });
    const port = srv.address().port;
    const c = make('companion', { port }); c.start();
    await until(() => c.status === 'online');
    assert.equal((await c.command('press', { page: 2, row: 1, column: 3 })).outcome, 'ok');
    assert.equal((await c.command('variable', { name: 'missing', value: 'x' })).outcome, 'rejected');
    const c2 = make('companion', { port, version: '2' });
    await c2.command('press', { page: 1, row: 1, column: 2 });
    const sh = make('http', { profile: 'shelly2', port });
    await sh.command('on', { relay: 0 });
    assert.ok(hits.includes('POST /api/location/2/1/3/press') && hits.includes('GET /press/bank/1/11') && hits.includes('GET /rpc/Switch.Set?id=0&on=true'), hits.join('\n'));
    c.stop(); srv.close();
  }

  // ---- text over TCP with a template (Videohub) and escapes
  {
    let got = '';
    const srv = await tcpServer(s => { s.write('PROTOCOL PREAMBLE:\n'); s.on('data', d => { got += d; }); });
    const d = make('text', { profile: 'videohub', protocol: 'tcp', port: srv.address().port, ending: 'lf' }); d.start();
    await until(() => d.status === 'online');
    await d.command('route', { output: 2, input: 0 });
    await d.command('send', { text: 'PING:\\x41' });
    await until(() => got.includes('PING'));
    assert.equal(got, 'VIDEO OUTPUT ROUTING:\n2 0\n\nPING:A\n');
    d.stop(); srv.close();
  }

  // ---- DMX: sACN and Art-Net packets with the right levels
  {
    const s = await udpServer(); const pkts = [];
    s.on('message', m => pkts.push(m));
    const port = s.address().port;
    const D = drivers.dmx;
    const sacn = new D({ id: 'haze', type: 'dmx', host: '127.0.0.1', protocol: 'sacn', universe: 7 });
    sacn.start(); sacn.udp.send = (b, p, h) => dgram.Socket.prototype.send.call(sacn.udp, b, port, h); // same packet, test port
    await sacn.command('level', { channels: '1-2, 5', level: 50 });
    await until(() => pkts.some(p => p.length === 638 && p[126 + 4] === 128));
    const p = pkts.find(x => x.length === 638 && x[130] === 128);
    assert.equal(p.toString('ascii', 4, 13), 'ASC-E1.17'); assert.equal(p.readUInt16BE(113), 7);
    assert.deepEqual([...p.subarray(126, 131)], [128, 128, 0, 0, 128]);
    await sacn.command('level', { channels: '1', level: 0, fade: 0.2 });
    await until(() => pkts.slice(-1)[0][126] === 0, 2000);
    sacn.stop();
    const art = new D({ id: 'fx', type: 'dmx', host: '127.0.0.1', protocol: 'artnet', universe: 3 });
    art.start(); art.udp.send = (b, p2, h) => dgram.Socket.prototype.send.call(art.udp, b, port, h);
    await art.command('value', { channels: '512', value: 200 });
    await until(() => pkts.some(x => x.length === 530));
    const a = pkts.find(x => x.length === 530);
    assert.equal(a.toString('ascii', 0, 7), 'Art-Net'); assert.equal(a[14], 3); assert.equal(a[18 + 511], 200);
    assert.throws(() => D.parseChannels('600'), /not a DMX address/);
    art.stop(); s.close();
  }

  // ---- network MIDI: session handshake, then MIDI Show Control
  {
    const ctl = dgram.createSocket('udp4'), dat = dgram.createSocket('udp4');
    await new Promise(r => ctl.bind(0, '127.0.0.1', r));
    await new Promise(r => dat.bind(ctl.address().port + 1, '127.0.0.1', r));
    const ok = (sock, m, r) => { const b = Buffer.from(m); b.write('OK', 2); const out = Buffer.concat([b.subarray(0, 16), Buffer.from('Sim session\0')]); sock.send(out, r.port, r.address); };
    const midi = [];
    ctl.on('message', (m, r) => { if (m.toString('ascii', 2, 4) === 'IN') ok(ctl, m, r); });
    dat.on('message', (m, r) => {
      if (m.readUInt16BE(0) === 0xffff) {
        if (m.toString('ascii', 2, 4) === 'IN') ok(dat, m, r);
        if (m.toString('ascii', 2, 4) === 'CK' && m[8] === 0) { const b = Buffer.from(m); b[8] = 1; dat.send(b, r.port, r.address); }
      } else midi.push(m);
    });
    const d = make('applemidi', { port: ctl.address().port }); d.start();
    await until(() => d.status === 'online');
    assert.equal(d.state.peer, 'Sim session');
    await d.command('msc', { action: 'go', cue: '12.5', list: '1' });
    await d.command('raw', { bytes: Array(20).fill('f8').join(' ') }); // long enough for the 2-byte header
    await d.command('program', { program: 5 });
    await until(() => midi.length === 3);
    assert.equal(midi[0][1], 0x61);
    assert.equal(midi[0][12], 13, 'short MIDI list header: 13 bytes');
    const body = midi[0].subarray(13);
    assert.equal(body.toString('hex'), 'f07f01020101' + Buffer.from('12.5').toString('hex') + '00' + Buffer.from('1').toString('hex') + 'f7');
    assert.equal(midi[1].subarray(12, 14).toString('hex'), '8014');
    assert.equal(midi[2].subarray(12).toString('hex'), '02c004');
    const t = await setup.testDevice({ id: 'm', type: 'applemidi', host: '127.0.0.1', port: ctl.address().port });
    assert.ok(t.ok && /Sim session/.test(t.detail), t.detail);
    d.stop(); await wait(100); ctl.close(); dat.close();
  }

  // ---- Test in plain words for one-way equipment
  {
    const t = await setup.testDevice({ id: 'q', type: 'magicq', host: '127.0.0.1' });
    assert.ok(t.ok && t.oneWay && /Try it now/.test(t.detail), t.detail);
    const s = await setup.testDevice({ id: 'h', type: 'dmx', host: '', protocol: 'sacn', universe: 4 });
    assert.ok(s.ok && /universe 4/.test(s.detail), s.detail);
    assert.equal(setup.cleanDevices([{ id: 'h', type: 'dmx', host: '' }])[0].enabled, undefined, 'sACN needs no address');
    assert.equal(setup.cleanDevices([{ id: 'x', type: 'x32', host: '' }])[0].enabled, false);
    assert.equal(setup.cleanDevices([{ id: 'x', type: 'x32', profile: 'gone', host: '1.2.3.4' }])[0].profile, undefined, 'unknown brand entry dropped');
  }

  // ---- Find my equipment: greetings on the usual ports of this computer
  {
    const servers = [];
    const listen = (port, onConn) => new Promise((res, rej) => { const s = net.createServer(onConn); s.once('error', rej); s.listen(port, '127.0.0.1', () => { servers.push(s); res(); }); });
    try {
      await listen(4352, s => s.write('PJLINK 0\r'));
      await listen(1024, s => s.write('NTCONTROL 0\r'));
      await listen(49280, s => s.on('data', () => s.write('OK devinfo productname "TF5"\n')));
      await listen(3037, () => {});
      await listen(9993, s => s.write('500 connection info:\r\nprotocol version: 1.11\r\nmodel: HyperDeck Studio Mini\r\n\r\n'));
      const r = await discover({ hosts: ['127.0.0.1'], broadcast: false, scan: false });
      const kinds = r.found.filter(f => f.host === '127.0.0.1').map(f => f.profile).sort();
      assert.deepEqual(kinds, ['eos', 'hyperdeck', 'panasonic', 'pjlink', 'yamaha-tf'], JSON.stringify(r.found));
      const tf = r.found.find(f => f.profile === 'yamaha-tf');
      assert.equal(tf.name, 'TF5'); assert.equal(tf.confidence, 'sure');
      assert.equal(r.found.find(f => f.profile === 'hyperdeck').name, 'HyperDeck Studio Mini');
    } catch (e) {
      if (e.code === 'EADDRINUSE') console.log(`(skipped network search check: port ${e.port} is in use on this computer)`); else throw e;
    } finally { servers.forEach(s => s.close()); }
    // whole thing, broadcasts included, finishes in reasonable time and never throws
    const all = await discover({ hosts: [], timeMs: 1500 });
    assert.ok(Array.isArray(all.found) && all.ms < 30000);
  }

  fs.rmSync(pluginDir, { recursive: true, force: true });
  console.log('\nCOMPAT TEST PASSED');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
