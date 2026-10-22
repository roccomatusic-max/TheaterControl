// PJLink class 1 client (TCP 4352). One short session per batch of commands; the digest
// (md5(random + password), no username, no separator) goes on the first command only.
const crypto = require('crypto');
const { LineSession } = require('./line-session');
const { result } = require('./outcome');

const ERRORS = {
  ERR1: ['unsupported', 'undefined command'],
  ERR2: ['rejected', 'parameter out of range'],
  ERR3: ['busy', 'unavailable time (projector busy)'],
  ERR4: ['fault', 'projector failure'],
};

// bodies: e.g. ['POWR ?', 'ERST ?']  → array of results, one per body, same order
async function pjlinkBatch(host, port = 4352, password = '', bodies = [], opts = {}) {
  const s = new LineSession(host, port, opts);
  const started = Date.now();
  try {
    await s.open();
    const greet = await s.readLine();
    let prefix = '';
    const m = greet.match(/^PJLINK ([01])(?: (\S+))?/);
    if (!m) return bodies.map(() => result('fault', `unexpected greeting ${greet}`));
    if (m[1] === '1') {
      if (!password) return bodies.map(() => result('auth_failed', 'projector asks for a PJLink password but none is configured'));
      prefix = crypto.createHash('md5').update(m[2] + password).digest('hex');
    }
    const out = [];
    for (const body of bodies) {
      s.write(`${prefix}%1${body}\r`); prefix = '';
      let line;
      try { line = await s.readLine(); }
      catch (e) { out.push(result(e.code === 'timeout' ? 'timeout' : 'offline', e.message)); break; }
      if (/^PJLINK ERRA/.test(line)) { out.push(result('auth_failed', 'PJLink password refused')); break; }
      const r = line.match(/^%1(\w{4})=(.*)$/);
      if (!r) { out.push(result('fault', `unparsed reply ${line}`)); continue; }
      const val = r[2].trim();
      if (ERRORS[val]) out.push(result(ERRORS[val][0], `${r[1]}: ${ERRORS[val][1]}`, { raw: line }));
      else out.push(result(body.endsWith('?') ? 'ok' : 'accepted', '', { value: val, raw: line, ms: Date.now() - started }));
    }
    while (out.length < bodies.length) out.push(result('timeout', 'session ended before this command'));
    return out;
  } catch (e) {
    return bodies.map(() => result(e.code === 'timeout' ? 'timeout' : 'offline', e.message));
  } finally { s.close(); }
}

const ERST_KEYS = ['fan', 'lamp', 'temperature', 'cover', 'filter', 'other'];
const ERST_LEVEL = { 0: 'ok', 1: 'warning', 2: 'error' };
function parseErst(v) {
  if (!/^\d{6}$/.test(v || '')) return null;
  return Object.fromEntries(ERST_KEYS.map((k, i) => [k, ERST_LEVEL[v[i]] || 'unknown']));
}
function parseLamps(v) { // "1200 1 1180 0" → [{hours:1200,on:true},...]
  const p = (v || '').trim().split(/\s+/).map(Number);
  const lamps = [];
  for (let i = 0; i + 1 < p.length; i += 2) if (Number.isFinite(p[i])) lamps.push({ hours: p[i], on: p[i + 1] === 1 });
  return lamps;
}
const INPUT_KINDS = { 1: 'RGB', 2: 'Video', 3: 'Digital', 4: 'Storage', 5: 'Network' };
const inputLabel = code => `${INPUT_KINDS[String(code)[0]] || 'Input'} ${String(code)[1] || ''}`.trim();

module.exports = { pjlinkBatch, parseErst, parseLamps, inputLabel, ERST_KEYS };
