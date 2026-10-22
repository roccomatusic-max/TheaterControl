// Fake devices that speak the real protocols on localhost, so the whole system can be
// exercised without a console, mixer or cameras.  node sim/devices.js
const net = require('net');
const dgram = require('dgram');
const osc = require('../server/lib/osc');

const log = (who, msg) => console.log(`[sim ${who}] ${msg}`);

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

// ---------- Projector (PJLink) ----------
function pjlinkSim(port) {
  let power = '0', av = '30';
  net.createServer(sock => {
    sock.write('PJLINK 0\r');
    sock.on('data', d => {
      const m = d.toString().trim().match(/%1(\w{4}) (.+)/); if (!m) return;
      const [, cmd, arg] = m;
      if (cmd === 'POWR') { if (arg === '?') sock.write(`%1POWR=${power}\r`); else { power = arg === '1' ? '3' : '2'; setTimeout(() => (power = arg), 4000); log('pjlink', `power ${arg}`); sock.write('%1POWR=OK\r'); } }
      else if (cmd === 'AVMT') { if (arg === '?') sock.write(`%1AVMT=${av}\r`); else { av = arg; sock.write('%1AVMT=OK\r'); } }
      else sock.write(`%1${cmd}=OK\r`);
    });
    sock.on('error', () => {});
  }).listen(port, () => log('pjlink', `PJLink on ${port}`));
}

eosSim(13037);
qlabSim(15300);
tfSim(14928);
viscaSim(15238, 'cam1'); viscaSim(15239, 'cam2'); viscaSim(15240, 'cam3');
pjlinkSim(14352);
