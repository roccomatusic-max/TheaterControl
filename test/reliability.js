// Equipment connections that go quiet are opened again; commands to equipment that isn't connected
// are not reported as done; QLab is signed in again after it restarts.
const net = require('net');
const dgram = require('dgram');
const assert = require('assert');
const osc = require('../server/lib/osc');
const Eos = require('../server/drivers/eos');
const QLab = require('../server/drivers/qlab');
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // ---- a console that answers, then goes silent with the connection still open (cable pulled) ----
  let connections = 0, answer = true;
  const srv = net.createServer(sock => {
    connections++;
    const dec = new osc.SlipDecoder(pkt => {
      const m = osc.decode(pkt);
      if (answer && m.address === '/eos/ping') sock.write(osc.slipEncode(osc.encode('/eos/out/ping', [])));
    });
    sock.on('data', d => dec.push(d));
    sock.on('error', () => {});
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const eos = new Eos({ id: 'eos', type: 'eos', host: '127.0.0.1', port: srv.address().port });
  const logs = [];
  eos.on('log', e => logs.push(e.msg));
  eos.start();
  await wait(1500);
  assert.equal(eos.status, 'online');
  assert.equal(connections, 1);
  answer = false; // silent from now on, but the TCP connection stays up
  await wait(9000);
  assert.ok(connections >= 2, `connects again after going quiet (connections: ${connections})`);
  assert.ok(logs.some(l => /no answer for 6 s/.test(l)));
  answer = true; await wait(3000);
  assert.equal(eos.status, 'online', 'back online once it answers again');
  eos.stop(); srv.close();

  // ---- a console that never answers is left connected (its commands may still arrive) ----
  let silentConns = 0;
  const quiet = net.createServer(s => { silentConns++; s.on('error', () => {}); });
  await new Promise(r => quiet.listen(0, '127.0.0.1', r));
  const eos2 = new Eos({ id: 'eos2', type: 'eos', host: '127.0.0.1', port: quiet.address().port });
  eos2.start(); await wait(8000);
  assert.equal(silentConns, 1, 'no reconnect loop for a console that never answered');
  eos2.stop(); quiet.close();

  // ---- QLab: signed in again (passcode) when it comes back after a restart ----
  const got = [];
  const q = dgram.createSocket('udp4');
  q.on('message', m => { try { got.push(osc.decode(m).address); } catch { /* bundle */ } });
  await new Promise(r => q.bind(0, '127.0.0.1', r));
  const qlab = new QLab({ id: 'qlab', type: 'qlab', host: '127.0.0.1', port: q.address().port, passcode: '1234' });
  qlab.start(); await wait(300);
  assert.equal(got.filter(a => a === '/connect').length, 1);
  await wait(5200); // not answering: the sign-in is sent again
  assert.ok(got.filter(a => a === '/connect').length >= 2, 'QLab sign-in repeated while QLab is not answering');
  qlab.stop(); q.close();

  console.log('\nRELIABILITY TEST PASSED');
  process.exit(0);
})().catch(e => { console.error('\nRELIABILITY TEST FAILED:', e); process.exit(1); });
