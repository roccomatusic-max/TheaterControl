// Fake devices that speak the real protocols on localhost, so the whole system can be
// exercised without a console, mixer or cameras.  node sim/devices.js
const net = require('net');
const dgram = require('dgram');
const osc = require('../server/lib/osc');

const log = (who, msg) => process.env.SHOW_QUIET || console.log(`[sim ${who}] ${msg}`);

// ---------- ETC Eos (OSC over TCP/SLIP) ----------
function eosSim(port) {
  const cues = Array.from({ length: 40 }, (_, i) => ({ n: i + 1, label: ['Preshow', 'Overture', 'Opening', 'Street', 'Blackout', 'Ballad', 'Chase', 'Finale'][i % 8] }));
  let active = -1;
  const text = c => (c ? `1/${c.n} ${c.label} 3.0 100%` : '');
  net.createServer(sock => {
    const send = (a, args = []) => sock.write(osc.slipEncode(osc.encode(a, args)));
    const pushCues = () => { send('/eos/out/active/cue/text', [text(cues[active])]); send('/eos/out/pending/cue/text', [text(cues[active + 1])]); send('/eos/out/active/cue', [{ type: 'f', value: 1 }]); };
    send('/eos/out/show/name', ['Sim Musical']); pushCues();
    const dec = new osc.SlipDecoder(p => {
      const { address, args } = osc.decode(p);
      if (address === '/eos/ping') send('/eos/out/ping');
      else if (address === '/eos/key/go_0') { active = Math.min(active + 1, cues.length - 1); log('eos', `GO → ${active + 1}`); pushCues(); }
      else if (address === '/eos/key/stop') { active = Math.max(active - 1, -1); pushCues(); }
      else if (/^\/eos\/cue\/\d+\/[\d.]+\/fire$/.test(address)) { active = Math.max(0, Math.round(Number(address.split('/')[4])) - 1); log('eos', `fire cue ${active + 1}`); pushCues(); }
      else if (address === '/eos/newcmd') { log('eos', `cmd: ${args[0]}`); send('/eos/out/cmd', [`LIVE: Cmd: ${args[0]}`]); }
      else if (address !== '/eos/subscribe' && address !== '/eos/user') log('eos', address);
    });
    sock.on('data', d => dec.push(d));
    sock.on('error', () => {});
  }).listen(port, () => log('eos', `OSC/TCP on ${port}`));
}

// ---------- QLab (OSC over UDP, JSON replies) ----------
function qlabSim(port) {
  const cues = Array.from({ length: 30 }, (_, i) => ({ number: String(i + 1), name: ['House music', 'Preshow announce', 'Overture', 'Thunder', 'Door slam', 'Underscore', 'Bows'][i % 7] }));
  let ph = 0; const running = [];
  const s = dgram.createSocket('udp4');
  s.on('message', (m, r) => {
    const { address } = osc.decode(m);
    const reply = data => s.send(osc.encode('/reply' + address, [JSON.stringify({ workspace_id: 'sim', address, status: 'ok', data })]), r.port, r.address);
    const start = c => { if (!c) return; running.push(c.name); setTimeout(() => running.splice(running.indexOf(c.name), 1), 6000); log('qlab', `start ${c.number} ${c.name}`); };
    if (address === '/go') { start(cues[ph]); ph = Math.min(ph + 1, cues.length - 1); }
    else if (address === '/stop' || address === '/panic') { running.length = 0; log('qlab', address); }
    else if (address === '/playhead/next') ph = Math.min(ph + 1, cues.length - 1);
    else if (address === '/playhead/previous') ph = Math.max(ph - 1, 0);
    else if (/^\/cue\/[^/]+\/start$/.test(address)) start(cues.find(c => c.number === address.split('/')[2]));
    else if (/^\/playhead\/[^/]+$/.test(address)) { const i = cues.findIndex(c => c.number === address.split('/')[2]); if (i >= 0) ph = i; }
    else if (address === '/cue/playhead/number') reply(cues[ph].number);
    else if (address === '/cue/playhead/displayName') reply(cues[ph].name);
    else if (address === '/runningCues/shallow') reply(running.map(name => ({ name })));
  });
  s.bind(port, () => log('qlab', `OSC/UDP on ${port}`));
}

// ---------- Yamaha TF (text over TCP) ----------
function tfSim(port) {
  const names = ['Lead M', 'Lead F', 'Ens 1', 'Ens 2', 'Ens 3', 'Ens 4', 'Ens 5', 'Ens 6', 'Kbd L', 'Kbd R', 'Bass', 'Kick', 'Snare', 'OH L', 'OH R', 'Gtr', 'Reeds', 'Tpt', 'Choir L', 'Choir R'];
  const p = {};
  const key = (path, x) => `${path} ${x}`;
  for (let i = 0; i < 32; i++) {
    p[key('MIXER:Current/InCh/Fader/Level', i)] = i < 20 ? -1000 : -32768;
    p[key('MIXER:Current/InCh/Fader/On', i)] = 1;
    p[key('MIXER:Current/InCh/Label/Name', i)] = names[i] || `ch${i + 1}`;
  }
  ['Leads', 'Ensemble', 'Band', 'Drums', 'Choir', 'SFX', 'Reverb', 'Spare'].forEach((n, i) => {
    p[key('MIXER:Current/DCA/Fader/Level', i)] = 0; p[key('MIXER:Current/DCA/Fader/On', i)] = 1; p[key('MIXER:Current/DCA/Label/Name', i)] = n;
  });
  p[key('MIXER:Current/St/Fader/Level', 0)] = 0; p[key('MIXER:Current/St/Fader/On', 0)] = 1;
  const clients = new Set();
  // Input meters: speech-like bursts on the radio mics (ch 1-8), steadier band channels, silence when off.
  // "simfeedback <ch>" (sim only) makes a channel ring with a steady tone for 3 s.
  const ringing = new Map(), talking = Array.from({ length: 32 }, () => Math.random() < 0.5);
  const meterByte = i => {
    if (!p[key('MIXER:Current/InCh/Fader/On', i)] || p[key('MIXER:Current/InCh/Fader/Level', i)] <= -13800) return 0;
    let db;
    if ((ringing.get(i) || 0) > Date.now()) db = -6 + Math.random() * 0.5;
    else if (i < 8) { if (Math.random() < 0.08) talking[i] = !talking[i]; db = talking[i] ? -28 + Math.random() * 18 : -62 + Math.random() * 6; }
    else if (i < 20) db = -30 + Math.random() * 10;
    else return 0;
    return Math.max(1, Math.min(127, Math.round(127 + db * 2)));
  };
  setInterval(() => {
    for (const c of clients) if (c.meters) c.write(`NOTIFY mtr MIXER:Current/Meter/InCh 2 ${Array.from({ length: 32 }, (_, i) => meterByte(i).toString(16).padStart(2, '0')).join(' ')}\n`);
  }, 100);
  const fmt = (path, x, v) => `${path} ${x} 0 ${typeof v === 'string' ? `"${v}"` : v}`;
  net.createServer(sock => {
    clients.add(sock); sock.setEncoding('utf8'); let buf = '';
    sock.on('data', d => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        const [verb, path, x, , ...rest] = line.split(' ');
        if (verb === 'get' && key(path, x) in p) sock.write(`OK get ${fmt(path, x, p[key(path, x)])}\n`);
        else if (verb === 'set') {
          const raw = rest.join(' '); const v = raw.startsWith('"') ? raw.slice(1, -1) : Number(raw);
          p[key(path, x)] = v; sock.write(`OK set ${fmt(path, x, v)}\n`);
          for (const c of clients) if (c !== sock) c.write(`NOTIFY set ${fmt(path, x, v)}\n`);
        } else if (verb === 'devstatus') sock.write('OK devstatus runmode "normal"\n');
        else if (verb === 'mtrstart') { sock.meters = true; sock.write(`OK mtrstart ${path} ${x}\n`); }
        else if (verb === 'simfeedback') { ringing.set(Number(path), Date.now() + 3000); log('tf', `feedback on ch ${Number(path) + 1}`); sock.write('OK simfeedback\n'); }
        else if (verb === 'ssrecall_ex') { log('tf', `recall ${path} ${x}`); sock.write(`OK ssrecall_ex ${path} ${x}\n`); }
        else sock.write(`ERROR ${verb} UnknownCommand\n`);
      }
    });
    sock.on('close', () => clients.delete(sock)); sock.on('error', () => {});
  }).listen(port, () => log('tf', `RCP/TCP on ${port}`));
  // fake someone moving a fader on the desk now and then
  setInterval(() => {
    const ch = Math.floor(Math.random() * 8), v = -1000 + Math.round((Math.random() - 0.5) * 600);
    p[key('MIXER:Current/InCh/Fader/Level', ch)] = v;
    for (const c of clients) c.write(`NOTIFY set MIXER:Current/InCh/Fader/Level ${ch} 0 ${v} "${(v / 100).toFixed(2)}"\n`);
  }, 7000);
}

// ---------- Shure wireless receiver (ULX-D style text over TCP) ----------
// packs: [{ name, tx, bars, minutes }] per channel; tx null = no transmitter switched on.
function shureSim(port, packs) {
  const ch = packs.map(p => ({ ...p, rf: 100, audio: 20 }));
  const val = (c, k) => ({
    CHAN_NAME: `{${c.name.padEnd(31)}}`, TX_TYPE: c.tx || 'UNKN', BATT_BARS: String(c.tx ? c.bars : 255).padStart(3, '0'),
    BATT_RUN_TIME: String(c.tx ? c.minutes : 65535).padStart(5, '0'), BATT_CHARGE: '255',
    RX_RF_LVL: String(c.tx ? c.rf : 0).padStart(3, '0'), AUDIO_LVL: String(c.tx ? c.audio : 0).padStart(3, '0'),
  }[k]);
  const KEYS = ['CHAN_NAME', 'TX_TYPE', 'BATT_BARS', 'BATT_RUN_TIME', 'BATT_CHARGE', 'RX_RF_LVL', 'AUDIO_LVL'];
  // batteries run down slowly: a minute of runtime every 6 s, a bar every 40 minutes of runtime
  setInterval(() => ch.forEach(c => { if (c.tx && c.minutes > 0) { c.minutes--; c.bars = Math.min(c.bars, Math.ceil(c.minutes / 40)); } }), 6000);
  net.createServer(sock => {
    sock.setEncoding('ascii'); let buf = ''; const meter = new Set();
    const rep = (n, k) => { const v = val(ch[n - 1], k); if (v !== undefined) sock.write(`< REP ${n} ${k} ${v} >`); };
    const t = setInterval(() => meter.forEach(n => {
      const c = ch[n - 1]; if (!c.tx) return;
      c.rf = 95 + Math.round(Math.random() * 10); c.audio = 10 + Math.round(Math.random() * 25);
      sock.write(`< SAMPLE ${n} ALL ${Math.random() < 0.5 ? 'AX' : 'XB'} ${String(c.rf).padStart(3, '0')} ${String(c.audio).padStart(3, '0')} >`);
    }), 1000);
    sock.on('data', d => {
      buf += d; let i;
      while ((i = buf.indexOf('>')) >= 0) {
        const [verb, n, k, arg] = buf.slice(0, i).replace(/^[^<]*</, '').trim().split(/\s+/); buf = buf.slice(i + 1);
        const all = n === '0' ? ch.map((_, j) => j + 1) : [Number(n)];
        if (verb === 'GET') all.forEach(x => (k === 'ALL' ? KEYS : [k]).forEach(kk => rep(x, kk)));
        else if (verb === 'SET' && k === 'METER_RATE') all.forEach(x => (Number(arg) ? meter.add(x) : meter.delete(x)));
        else if (verb === 'SET' && k === 'FLASH') log('shure', `flash ch ${n}`);
      }
    });
    sock.on('close', () => clearInterval(t)); sock.on('error', () => {});
  }).listen(port, () => log('shure', `receiver on ${port}`));
}

// ---------- PTZ camera (Sony VISCA over IP, UDP) ----------
function viscaSim(port, name) {
  const st = { pan: 0, tilt: 0, zoom: 0, ps: 0, ts: 0, zs: 0, presets: {} };
  setInterval(() => {
    st.pan = Math.max(-2448, Math.min(2448, st.pan + st.ps * 6));
    st.tilt = Math.max(-432, Math.min(1296, st.tilt + st.ts * 6));
    st.zoom = Math.max(0, Math.min(0x4000, st.zoom + st.zs * 80));
  }, 50);
  const s = dgram.createSocket('udp4');
  s.on('message', (m, r) => {
    const hdr = m.subarray(0, 8), b = m.subarray(8);
    const out = bytes => { const h = Buffer.from(hdr); h.writeUInt16BE(0x0111, 0); h.writeUInt16BE(bytes.length, 2); s.send(Buffer.concat([h, Buffer.from(bytes)]), r.port, r.address); };
    if (hdr.readUInt16BE(0) !== 0x0100) return;
    const nib = (v, n) => Array.from({ length: n }, (_, i) => ((v & 0xffff) >> (4 * (n - 1 - i))) & 15);
    if (b[1] === 0x09) {
      if (b[2] === 0x04 && b[3] === 0x00) out([0x90, 0x50, 0x02, 0xff]);
      else if (b[2] === 0x04 && b[3] === 0x47) out([0x90, 0x50, ...nib(st.zoom, 4), 0xff]);
      else if (b[2] === 0x06 && b[3] === 0x12) out([0x90, 0x50, ...nib(st.pan, 4), ...nib(st.tilt, 4), 0xff]);
      return;
    }
    out([0x90, 0x41, 0xff]);
    if (b[2] === 0x06 && b[3] === 0x01) { st.ps = b[6] === 1 ? -b[4] : b[6] === 2 ? b[4] : 0; st.ts = b[7] === 1 ? b[5] : b[7] === 2 ? -b[5] : 0; }
    else if (b[2] === 0x04 && b[3] === 0x07) { const d = b[4] >> 4, sp = (b[4] & 15) + 1; st.zs = d === 2 ? sp : d === 3 ? -sp : 0; }
    else if (b[2] === 0x04 && b[3] === 0x3f) {
      if (b[4] === 0x01) { st.presets[b[5]] = { pan: st.pan, tilt: st.tilt, zoom: st.zoom }; log(name, `store preset ${b[5]}`); }
      else if (st.presets[b[5]]) { Object.assign(st, st.presets[b[5]]); log(name, `recall preset ${b[5]}`); }
      else { Object.assign(st, { pan: (b[5] - 3) * 500, tilt: 200, zoom: b[5] * 1500 }); log(name, `recall preset ${b[5]} (default)`); }
    } else if (b[2] === 0x06 && b[3] === 0x04) Object.assign(st, { pan: 0, tilt: 0 });
    out([0x90, 0x51, 0xff]);
  });
  s.bind(port, () => log(name, `VISCA/UDP on ${port}`));
}

// ---------- Projectors ----------
// Shared projector state with realistic warm-up / cool-down, served over PJLink and
// (for Panasonic units) the NTCONTROL LAN protocol.
const crypto = require('crypto');
function projectorState(name, { warmMs = 6000, coolMs = 6000, inputs, lampHours = [1200, 1180] } = {}) {
  const st = { name, power: 'standby', shutter: '1', input: inputs[0], lampHours, erst: '000000', inputs };
  st.powerOn = () => { if (st.power !== 'standby') return false; st.power = 'warming'; setTimeout(() => (st.power = 'on'), warmMs); return true; };
  st.powerOff = () => { if (st.power !== 'on') return false; st.power = 'cooling'; st.shutter = '1'; setTimeout(() => (st.power = 'standby'), coolMs); return true; };
  return st;
}
function pjlinkSim(port, st, { password = '', pjInputs = ['11', '31', '32'] } = {}) {
  const POW = { standby: '0', on: '1', cooling: '2', warming: '3' };
  net.createServer(sock => {
    const rand = crypto.randomBytes(4).toString('hex');
    const digest = password && crypto.createHash('md5').update(rand + password).digest('hex');
    let authed = !password, buf = '';
    sock.write(password ? `PJLINK 1 ${rand}\r` : 'PJLINK 0\r');
    sock.on('data', d => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\r')) >= 0) {
        let line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!authed) { if (line.slice(0, 32) !== digest) { sock.end('PJLINK ERRA\r'); return; } authed = true; line = line.slice(32); }
        const m = line.match(/^%1(\w{4}) (.+)$/); if (!m) continue;
        const [, cmd, arg] = m, q = arg === '?', on = st.power === 'on';
        const reply = v => sock.write(`%1${cmd}=${v}\r`);
        if (cmd === 'POWR') q ? reply(POW[st.power]) : reply((arg === '1' ? st.powerOn() : st.powerOff()) || st.power === (arg === '1' ? 'on' : 'standby') ? 'OK' : 'ERR3');
        else if (cmd === 'AVMT') { if (!on) reply('ERR3'); else if (q) reply(st.shutter === '1' ? '31' : '30'); else { st.shutter = ['11', '31'].includes(arg) ? '1' : '0'; reply('OK'); } }
        else if (cmd === 'INPT') { if (!on) reply('ERR3'); else if (q) reply(st.pjInput || pjInputs[0]); else if (pjInputs.includes(arg)) { st.pjInput = arg; reply('OK'); } else reply('ERR2'); }
        else if (cmd === 'ERST') reply(st.erst);
        else if (cmd === 'LAMP') reply(st.lampHours.map(h => `${h} ${on ? 1 : 0}`).join(' '));
        else if (cmd === 'INST') reply(pjInputs.join(' '));
        else if (cmd === 'NAME') reply(st.name);
        else if (cmd === 'INF1') reply(st.mfr || 'SIMCO');
        else if (cmd === 'INF2') reply(st.model || 'PJ-1000');
        else if (cmd === 'CLSS') reply('1');
        else reply('ERR1');
      }
    });
    sock.on('error', () => {});
  }).listen(port, () => log('pjlink', `${st.name} PJLink on ${port}${password ? ' (password)' : ''}`));
}
function panasonicSim(port, st, { user = 'admin1', password = '', closeAfterReply = false } = {}) {
  net.createServer(sock => {
    const rand = crypto.randomBytes(4).toString('hex');
    const digest = password && crypto.createHash('md5').update(`${user}:${password}:${rand}`).digest('hex');
    let first = true, buf = '';
    sock.write(password ? `NTCONTROL 1 ${rand}\r` : 'NTCONTROL 0\r');
    sock.on('data', d => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\r')) >= 0) {
        let line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (password && first) { if (line.slice(0, 32) !== digest) { sock.end('ERRA\r'); return; } line = line.slice(32); }
        first = false;
        if (!line.startsWith('00')) { sock.write('ERR5\r'); continue; }
        const cmd = line.slice(2), [mn, arg] = cmd.split(':'), on = st.power === 'on';
        const out = s => { sock.write(`00${s}\r`); if (closeAfterReply) sock.end(); };
        if (mn === 'QPW') out(on || st.power === 'warming' ? '001' : '000');
        else if (mn === 'PON') st.power === 'cooling' ? out('ER401') : (st.powerOn(), out('PON'));
        else if (mn === 'POF') st.power === 'warming' ? out('ER401') : (st.powerOff(), out('POF'));
        else if (mn === 'Q$L') out(String(st.lampHours[Number(arg) - 1] ?? 0).padStart(5, '0'));
        else if (!on) out('ER401');
        else if (mn === 'QSH') out(st.shutter);
        else if (mn === 'OSH') { st.shutter = arg; log(st.name, `shutter ${arg === '1' ? 'CLOSED' : 'open'}`); out(cmd); }
        else if (mn === 'QIN') out(st.input);
        else if (mn === 'IIS') { if (!st.inputs.includes(arg)) out('ER401'); else { st.input = arg; out(cmd); } }
        else if (mn === 'VXX') out(cmd);
        else sock.write('ERR1\r');
      }
    });
    sock.on('error', () => {});
  }).listen(port, () => log('panasonic', `${st.name} NTCONTROL on ${port}${password ? ' (protect mode)' : ''}${closeAfterReply ? ', closes after each reply' : ''}`));
}

eosSim(13037);
qlabSim(15300);
tfSim(14928);
// Two 4-channel receivers for eight packs: one pack nearly flat, one not switched on yet
shureSim(12202, [{ name: 'Lead M', tx: 'ULXD1', bars: 5, minutes: 480 }, { name: 'Lead F', tx: 'ULXD1', bars: 4, minutes: 300 }, { name: 'Ens 1', tx: 'ULXD1', bars: 1, minutes: 35 }, { name: 'Ens 2', tx: 'ULXD1', bars: 5, minutes: 470 }]);
shureSim(12203, [{ name: 'Ens 3', tx: 'ULXD1', bars: 4, minutes: 320 }, { name: 'Ens 4', tx: 'ULXD1', bars: 3, minutes: 200 }, { name: 'Ens 5', tx: null, bars: 0, minutes: 0 }, { name: 'Ens 6', tx: 'ULXD1', bars: 5, minutes: 455 }]);
viscaSim(15238, 'cam1'); viscaSim(15239, 'cam2'); viscaSim(15240, 'cam3');
// Two Panasonic PT-DZ13Ks (no SDI board fitted) and one PJLink-only projector
const projL = projectorState('PROJ-L', { inputs: ['RG1', 'RG2', 'VID', 'DVI', 'HD1'], lampHours: [1520, 1498, 1533, 1507] });
const projR = projectorState('PROJ-R', { inputs: ['RG1', 'RG2', 'VID', 'DVI', 'HD1'], lampHours: [980, 1001, 975, 990] });
projR.erst = '100000'; // fan warning, to show health reporting
const rear = Object.assign(projectorState('REAR-PJ', { inputs: ['31'] }), { mfr: 'EPSON', model: 'EB-L1100U' });
panasonicSim(11024, projL, { password: 'panasonic' }); pjlinkSim(14353, projL, { password: 'panasonic' });
panasonicSim(11025, projR, { closeAfterReply: true }); pjlinkSim(14354, projR);
pjlinkSim(14352, rear, { password: 'epson' });
