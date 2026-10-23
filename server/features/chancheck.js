// Channel check: walk the rig one light at a time, from a phone on stage. Each channel comes on by
// itself at the check level; tap OK, or say what's wrong (lamp out, wrong colour, focus…), and the
// next one comes on. Problems stay on a list, and in the pre-show check, until someone marks them
// fixed or the channel checks OK next time. Works with an Eos (labels, fixture types and gels come
// from its patch, and everything is put back with Sneak at the end) and with DMX boxes.
const fs = require('fs');
const path = require('path');

const eosLevel = pct => (pct >= 100 ? 'Full' : String(Math.round(pct)).padStart(2, '0'));
// [1,2,3,7] → "1 Thru 3 + 7"
function eosRanges(nums) {
  const out = [];
  for (const n of [...nums].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n; else out.push([n, n]);
  }
  return out.map(([a, b]) => (a === b ? `${a}` : `${a} Thru ${b}`)).join(' + ');
}
// "1-24, 31, 501 thru 504" → [1..24, 31, 501..504]
function parseChans(s, max) {
  const out = [];
  for (const part of String(s).split(/\s*[,+]\s*/).filter(Boolean)) {
    const m = part.trim().match(/^(\d+)(?:\s*(?:-|thru)\s*(\d+))?$/i);
    if (!m) throw new Error(`"${part}" is not a channel number or range (like 1-24).`);
    const a = Number(m[1]), b = Number(m[2] ?? m[1]);
    if (a < 1 || b < a || b > max) throw new Error(`Channels go from 1 to ${max}.`);
    if (b - a > 2000) throw new Error('That is a lot of channels. Check them a few hundred at a time.');
    for (let n = a; n <= b; n++) out.push(n);
  }
  return [...new Set(out)];
}

module.exports = function chanCheck(ctx) {
  const file = ctx.STATE_PATH && path.join(path.dirname(ctx.STATE_PATH), `.${path.basename(ctx.SAVE_PATH, '.json')}.chancheck.json`);
  // run: the check in progress { device, chans: [{ n, label, type, gel }], at, level, by, since, marks: { n: 'ok'|'problem' } }
  // last: how the last finished one went; problems: [{ n, device, label, note, at, by }]
  let st = { run: null, last: null, problems: [] };
  try { st = { ...st, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* first run */ }
  const save = () => { if (file) try { ctx.writeJson(file, st); } catch { /* not critical */ } };
  const kinds = ['eos', 'dmx'];
  const devs = () => [...ctx.devices.values()].filter(d => kinds.includes(d.type)).map(d => ({ id: d.id, name: d.name, type: d.type, status: d.status }));
  const info = () => ({ run: st.run, last: st.last, problems: st.problems, devices: devs() });
  const publish = () => { save(); ctx.broadcast({ t: 'chancheck', chancheck: info() }); };
  const log = msg => ctx.log({ device: 'chancheck', level: 'cmd', msg, t: Date.now() });

  async function light(n, on) {
    const d = ctx.devices.get(st.run.device);
    if (!d) throw new Error('That equipment is no longer in the list.');
    if (d.type === 'eos') return d.command('cmdline', { text: `Chan ${n} At ${on ? eosLevel(st.run.level) : '00'}#` });
    return d.command('level', { channels: String(n), level: on ? st.run.level : 0, fade: 0 });
  }
  async function finish(who) {
    const r = st.run;
    if (!r) return;
    const cur = r.chans[r.at];
    if (cur) await light(cur.n, false).catch(() => {});
    const d = ctx.devices.get(r.device);
    // put every checked channel back the way the console had it
    if (d?.type === 'eos') await d.command('cmdline', { text: `Chan ${eosRanges(r.chans.map(c => c.n))} Sneak#` }).catch(() => {});
    const marks = Object.values(r.marks);
    st.last = { device: r.device, name: d?.name || r.device, at: Date.now(), since: r.since, by: r.by, total: r.chans.length,
      checked: marks.length, ok: marks.filter(x => x === 'ok').length, problems: marks.filter(x => x === 'problem').length };
    st.run = null;
    log(`channel check finished by ${who}: ${st.last.checked} of ${st.last.total} checked, ${st.last.problems} problem${st.last.problems === 1 ? '' : 's'}`);
  }

  ctx.handlers['chancheck-get'] = () => info();
  ctx.handlers['chancheck-start'] = async (m, ws) => {
    if (st.run) throw new Error(`A channel check is already running (${st.run.by}). Finish it first.`);
    const d = ctx.devices.get(m.device);
    if (!d || !kinds.includes(d.type)) throw new Error('Pick the lighting console or DMX box to check.');
    if (!['online', 'sim'].includes(d.status)) throw new Error(`${d.name} is not connected.`);
    const level = [25, 50, 75, 100].includes(Number(m.level)) ? Number(m.level) : 75;
    const typed = String(m.channels || '').trim();
    let chans;
    if (d.type === 'eos') {
      // labels, fixture types and gels from the console's patch
      let patch = [];
      try { patch = (await d.getList('patch')).map(({ number, args: x }) => ({ n: Number(number), label: String(x[1] || ''), type: `${x[2] || ''} ${x[3] || ''}`.trim(), gel: String(x[7] || '') })); }
      catch (e) { if (!typed) throw new Error(`Couldn't read the patch from ${d.name} (${e.message}). Type the channels to check instead.`); }
      const byN = new Map(patch.filter(p => p.n > 0).map(p => [p.n, p]));
      chans = typed ? parseChans(typed, 99999).map(n => byN.get(n) || { n, label: '', type: '', gel: '' }) : [...byN.values()].sort((a, b) => a.n - b.n);
    } else {
      if (!typed) throw new Error('Type the DMX channels to check, like 1-24.');
      chans = parseChans(typed, 512).map(n => ({ n, label: '', type: '', gel: '' }));
    }
    if (!chans.length) throw new Error('No channels to check.');
    st.run = { device: d.id, chans, at: 0, level, by: m.name || ws.who, since: Date.now(), marks: {} };
    log(`channel check of ${chans.length} channels on ${d.name} started by ${st.run.by}`);
    await light(chans[0].n, true);
    publish();
    return info();
  };
  // Marks the channel that is on (ok, or a problem with a note) and moves to another one.
  ctx.handlers['chancheck-step'] = async (m, ws) => {
    const r = st.run;
    if (!r) throw new Error('No channel check is running.');
    const cur = r.chans[r.at];
    if (m.mark === 'ok' || m.mark === 'problem') {
      r.marks[cur.n] = m.mark;
      st.problems = st.problems.filter(p => !(p.n === cur.n && p.device === r.device));
      if (m.mark === 'problem') st.problems.push({ n: cur.n, device: r.device, label: cur.label, note: String(m.note || 'Problem').slice(0, 120), at: Date.now(), by: m.name || ws.who });
    }
    const to = m.to === 'back' ? r.at - 1 : m.to === 'next' || m.to == null ? r.at + 1 : r.chans.findIndex(c => c.n === Number(m.to));
    if (to < 0 && m.to !== 'back') throw new Error(`Channel ${m.to} is not in this check.`);
    if (to >= r.chans.length) { await finish(m.name || ws.who); publish(); return info(); }
    const next = Math.max(0, to);
    if (next !== r.at) {
      await light(cur.n, false);
      r.at = next;
      await light(r.chans[next].n, true);
    }
    publish();
    return info();
  };
  ctx.handlers['chancheck-finish'] = async (m, ws) => { await finish(m.name || ws.who); publish(); return info(); };
  ctx.handlers['chancheck-fixed'] = (m, ws) => {
    const p = st.problems.find(x => x.n === Number(m.n) && x.device === m.device);
    if (!p) throw new Error('That problem is not on the list.');
    st.problems = st.problems.filter(x => x !== p);
    log(`channel ${p.n} (${p.note}) marked fixed by ${m.name || ws.who}`);
    publish();
    return info();
  };
  ctx.access?.viewerMay('chancheck-get');

  ctx.checks.push(() => {
    const base = { group: 'Show', label: 'Channel check' };
    const words = p => `${p.n}${p.label ? ` (${p.label})` : ''} ${p.note.toLowerCase()}`;
    if (st.run) return [{ ...base, state: 'info', detail: `In progress (${st.run.by}): channel ${st.run.at + 1} of ${st.run.chans.length}.` }];
    if (st.problems.length) return [{ ...base, state: 'warn', detail: `${st.problems.length} to fix: ${st.problems.slice(0, 4).map(words).join(', ')}${st.problems.length > 4 ? ' and more' : ''}.` }];
    if (!st.last) return [];
    const today = Date.now() - st.last.at < 20 * 3600e3;
    return [{ ...base, state: today ? 'ok' : 'info', detail: `${today ? 'Done' : 'Last done'} ${new Date(st.last.at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}: ${st.last.checked} of ${st.last.total} channels checked, nothing to fix.` }];
  });
  ctx.initExtras.push(() => ({ chancheck: info() }));
};
