// Show report: every GO (and what each piece of equipment answered), problems, emergency stops,
// rehearsal jumps, second-operator changes, crew notes and calls of one performance. A few minutes
// after the last cue it becomes a PDF in "Show Control/Show reports", and it is sent to the phone
// with the phone alerts.
//
// A report starts at the first GO and ends at the last cue of the list; a GO from the top after
// that starts the next one (matinee and evening get one each). A run that never reaches the end is
// finished after 4 hours without a GO, or from the System tab.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pdf = require('../lib/pdf');

const GOOD = ['ok', 'accepted', 'sent'];
const OUTCOME = { busy: 'warming up', offline: 'not connected', timeout: 'no answer', not_sent: 'not sent', rejected: 'refused', auth_failed: 'wrong password', fault: 'fault' };
const IDLE_MS = Number(process.env.SHOW_REPORT_IDLE_MS || 4 * 3600e3);
const KEEP = 200;

const clock = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const clockS = t => new Date(t).toLocaleTimeString([], { hour12: false });
const dur = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const short = ms => (ms < 60e3 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60e3)} min`);
const stamp = t => { const d = new Date(t), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`; };

module.exports = function report(ctx) {
  const dir = path.join(ctx.DATA_DIR, 'Show reports');
  const curPath = path.join(dir, 'current.json');
  const conf = () => ({ phone: true, afterMin: 10, ...(ctx.settings().reports || {}) });
  const phone = () => ctx.settings().alerts || {};
  let run = ctx.readJson(curPath, null);
  let finishTimer = null, saveTimer = null;
  const save = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try { if (run) ctx.writeJson(curPath, run); else fs.rmSync(curPath, { force: true }); }
      catch (e) { ctx.log({ device: 'core', level: 'warn', msg: `show report: could not save: ${e.message}`, t: Date.now() }); }
    }, 300);
  };
  const add = e => { if (!run) return; run.events.push(e); run.last = Math.max(run.last, e.at); save(); publish(); };
  const start = at => { run = { id: crypto.randomBytes(4).toString('hex'), show: ctx.show.name, mode: ctx.MODE, startedAt: at, last: at, lastMain: null, maxI: -1, endedAt: null, events: [] }; };
  const scheduleFinish = () => {
    clearTimeout(finishTimer);
    const wait = Math.max(0, (run.endedAt + conf().afterMin * 60e3) - Date.now());
    finishTimer = setTimeout(() => finish('after the last cue', true), wait);
  };
  if (run?.endedAt) scheduleFinish(); // restarted while waiting to send the report

  // ---------- what happens ----------
  ctx.events.on('cue-fired', f => {
    if (run && !f.dept && f.i === 0 && run.maxI > 0) finish('a new run started from the top', true);
    if (!run) start(f.at);
    run.events.push({ t: 'go', at: f.at, i: f.i, number: f.cue.number ?? f.i + 1, label: f.cue.label, by: ctx.screenName?.(f.source) || f.source, dept: f.dept ? ctx.depts?.name(f.dept) : undefined,
      out: !f.dept && run.lastMain != null && f.i !== run.lastMain + 1, results: [] });
    if (!f.dept) { run.lastMain = f.i; run.maxI = Math.max(run.maxI, f.i); }
    run.last = f.at;
    if (!f.dept && f.i === ctx.show.cues.length - 1) run.endedAt = f.at;
    if (run.endedAt) { run.endedAt = Math.max(run.endedAt, f.at); scheduleFinish(); }
    save(); publish();
  });
  ctx.events.on('cue-results', r => {
    const go = run?.events.find(e => e.t === 'go' && e.i === r.i && e.at === r.at);
    if (!go) return;
    go.results.push(...r.results.map(x => ({ name: String(x.name || x.device).split(' · ')[0], outcome: x.outcome, detail: x.detail })));
    save(); if (r.results.some(x => !GOOD.includes(x.outcome))) publish();
  });
  // Alerts on the alert bar (the emergency stop has its own line), and equipment coming back
  ctx.events.on('alert', a => { if (a.kind !== 'emergency') add({ t: 'alert', at: a.at, level: a.level || (a.kind === 'feedback' ? 'error' : 'warn'), key: a.key, msg: a.detail ? `${a.title} (${a.detail})` : a.title }); });
  ctx.events.on('alert-ok', a => { if (a.key !== 'emergency') add({ t: 'alert', at: a.at, level: 'ok', key: a.key, msg: a.msg }); });
  ctx.events.on('emergency', (who, results) => { if (!run) start(Date.now()); add({ t: 'emergency', at: Date.now(), by: ctx.screenName?.(who) || who, problems: (results || []).filter(r => !GOOD.includes(r.outcome)).map(r => `${String(r.name).split(' · ')[0]}: ${OUTCOME[r.outcome] || r.outcome}`) }); });
  ctx.events.on('emergency-cleared', who => add({ t: 'cleared', at: Date.now(), by: ctx.screenName?.(who) || who }));
  ctx.events.on('jump', j => { if (!run) start(j.at); run.lastMain = j.index - 1; add({ t: 'jump', at: j.at, by: j.who, i: j.target, label: ctx.show.cues[j.target]?.label, number: ctx.show.cues[j.target]?.number ?? j.target + 1, mode: j.mode, problems: j.problems }); });
  ctx.events.on('dept', d => add({ t: 'dept', at: Date.now(), ...d }));
  ctx.events.on('cues-saved', c => add({ t: 'edit', at: Date.now(), by: ctx.screenName?.(c.who) || c.who, note: c.note }));
  setInterval(() => { if (run && !run.endedAt && Date.now() - run.last > IDLE_MS) finish('no GO for a long time', true); }, 60e3).unref();

  // ---------- making the report ----------
  function summarize(r) {
    const gos = r.events.filter(e => e.t === 'go');
    const main = gos.filter(e => !e.dept);
    const ran = new Set(gos.map(e => e.i));
    const jumps = r.events.filter(e => e.t === 'jump');
    const total = r.cues?.length ?? ctx.show.cues.length;
    const upto = r.endedAt ? total - 1 : r.maxI;
    const missed = (r.cues || ctx.show.cues).map((c, i) => ({ i, c })).filter(({ i }) => i <= upto && !ran.has(i)).map(({ i, c }) => `${c.number ?? i + 1} ${c.label}`);
    const problems = [];
    for (const e of r.events) {
      if (e.t === 'go') {
        const bad = e.results.filter(x => !GOOD.includes(x.outcome));
        if (bad.length) problems.push({ at: e.at, text: `Cue ${e.number} ${e.label}: ${bad.map(x => `${x.name} ${OUTCOME[x.outcome] || x.outcome}${x.detail ? ` (${x.detail})` : ''}`).join('; ')}` });
      } else if (e.t === 'alert' && e.level === 'error') {
        const back = r.events.find(x => x.t === 'alert' && x.key === e.key && x.level === 'ok' && x.at > e.at);
        problems.push({ at: e.at, text: `${e.msg.replace(/\.?$/, '.')}${back ? ` Back after ${short(back.at - e.at)}.` : ' Not back by the end.'}` });
      } else if (e.t === 'emergency') problems.push({ at: e.at, text: `Emergency STOP pressed (${e.by})${e.problems.length ? `. Not confirmed: ${e.problems.join(', ')}` : ''}` });
      else if (e.t === 'jump' && e.problems?.length) problems.push({ at: e.at, text: `Jump to cue ${e.number}: ${e.problems.join('; ')}` });
    }
    const inOrder = main.filter(e => !e.out).length;
    const kind = jumps.length || inOrder < total * 0.6 ? 'Rehearsal report' : 'Show report';
    return { kind, first: gos[0]?.at || r.startedAt, last: gos.at(-1)?.at || r.last, cuesRun: ran.size, total, missed, problems, jumps: jumps.length,
      emergencies: r.events.filter(e => e.t === 'emergency').length, outOfOrder: main.filter(e => e.out).length };
  }

  function finish(why, auto) {
    clearTimeout(finishTimer); finishTimer = null;
    if (!run) return null;
    const r = run; run = null; save();
    r.finishedAt = Date.now(); r.why = why;
    const tm = ctx.show.timers, total = k => tm[k].acc + (tm[k].start ? Date.now() - tm[k].start : 0);
    r.timers = { show: total('show'), act: total('act'), label: tm.label };
    r.cues = ctx.show.cues.map(c => ({ number: c.number, label: c.label }));
    const crew = ctx.crew?.snapshot?.() || {};
    const from = r.startedAt - 2 * 3600e3;
    r.notes = (crew.notes || []).filter(n => n.at >= from && n.at <= r.finishedAt).map(n => ({ at: n.at, dept: n.dept, by: n.by, text: n.text, cue: n.cue, cueLabel: n.cueLabel }));
    r.calls = (crew.calls || []).filter(c => c.at >= from && c.at <= r.finishedAt).map(c => ({ at: c.at, text: c.text, to: c.to, by: c.by }));
    r.summary = summarize(r);
    r.name = `${stamp(r.summary.first)} ${r.summary.kind}`;
    for (let k = 2; fs.existsSync(path.join(dir, `${r.name}.json`)); k++) r.name = `${stamp(r.summary.first)} ${r.summary.kind} ${k}`;
    let buf;
    try {
      fs.mkdirSync(dir, { recursive: true });
      buf = makePdf(r);
      ctx.writeJson(path.join(dir, `${r.name}.json`), r);
      fs.writeFileSync(path.join(dir, `${r.name}.pdf`), buf);
      prune();
      ctx.log({ device: 'show', level: 'cmd', msg: `${r.summary.kind} saved: ${r.name}.pdf (${r.summary.cuesRun} cues, ${r.summary.problems.length} problems)`, t: Date.now() });
    } catch (e) {
      ctx.log({ device: 'core', level: 'error', msg: `show report could not be saved: ${e.message}`, t: Date.now() });
      return null;
    }
    if (auto && conf().phone && phone().on) sendToPhone(r, buf).then(x => { if (!x.ok) ctx.log({ device: 'core', level: 'warn', msg: `show report not sent to the phone: ${x.detail}`, t: Date.now() }); });
    publish();
    return r;
  }
  function prune() {
    const names = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'current.json').sort();
    for (const f of names.slice(0, Math.max(0, names.length - KEEP))) for (const ext of ['.json', '.pdf']) fs.rmSync(path.join(dir, f.replace(/\.json$/, ext)), { force: true });
  }
  const list = () => {
    try {
      return fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'current.json').sort().reverse().slice(0, 40).map(f => {
        const r = ctx.readJson(path.join(dir, f), null);
        return r && { name: r.name, show: r.show, mode: r.mode, reachedEnd: !!r.endedAt, first: r.summary.first, last: r.summary.last, kind: r.summary.kind, cuesRun: r.summary.cuesRun, total: r.summary.total, problems: r.summary.problems.length };
      }).filter(Boolean);
    } catch { return []; }
  };
  const status = () => run && (s => ({ since: s.first, cuesRun: s.cuesRun, total: s.total, problems: s.problems.length, endedAt: run.endedAt, sendAt: run.endedAt ? run.endedAt + conf().afterMin * 60e3 : null }))(summarize(run));
  const publish = () => ctx.broadcast({ t: 'report-status', recording: status() });

  async function sendToPhone(r, buf) {
    const a = phone();
    if (!a.ntfyTopic) return { ok: false, detail: 'Phone alerts are not set up yet (System > Equipment health).' };
    const hdr = v => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v).toString('base64')}?=`);
    const s = r.summary;
    const msg = `${s.cuesRun} of ${s.total} cues, ${dur(s.last - s.first)}. ${s.problems.length ? `${s.problems.length} problem${s.problems.length > 1 ? 's' : ''}.` : 'No problems.'}`;
    try {
      const res = await fetch(`${(a.ntfyServer || 'https://ntfy.sh').replace(/\/$/, '')}/${a.ntfyTopic}`, {
        method: 'PUT', body: buf, signal: AbortSignal.timeout(30000),
        headers: { Filename: `${r.name.replace(/[^A-Za-z0-9 ._-]/g, '')}.pdf`, Title: hdr(`${r.show}: ${s.kind}${r.mode === 'practice' ? ' (practice)' : ''}`), Message: hdr(msg), Tags: 'clipboard' },
      });
      if (!res.ok) throw new Error(`the alert service answered ${res.status}`);
      return { ok: true, detail: 'Sent. It should arrive on your phone in a few seconds.' };
    } catch (e) {
      return { ok: false, detail: /fetch failed|ENOTFOUND|EAI_AGAIN|ENETUNREACH|timeout|aborted/i.test(`${e.message} ${e.cause?.code || ''}`) ? 'This computer could not reach the internet.' : e.message };
    }
  }

  // ---------- the PDF ----------
  function makePdf(r) {
    const s = r.summary;
    const doc = pdf.create({ size: conf().paper === 'a4' ? 'a4' : 'letter' });
    const M = 48, W = doc.width - 2 * M, BOTTOM = doc.height - 50;
    let y = M;
    const ensure = h => { if (y + h > BOTTOM) { doc.page(); y = M; } };
    // a heading always has room for a couple of lines under it
    const head = (t, color = '#111') => { ensure(72); y += 12; doc.text(M, y, t, { size: 13, bold: true, color }); y += 19; doc.line(M, y, M + W, y, '#bbbbbb'); y += 6; };
    const para = (t, { size = 10, bold = false, color = '#222', x = M, w = W, gap = 2 } = {}) => {
      for (const ln of doc.wrap(t, w, size, bold)) { ensure(size + 3); doc.text(x, y, ln, { size, bold, color }); y += size + 3; }
      y += gap;
    };

    // title
    doc.rect(0, 0, doc.width, 6, '#1fbf5a');
    doc.text(M, y, r.show, { size: 20, bold: true }); y += 26;
    const day = new Date(s.first).toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    doc.text(M, y, `${s.kind} · ${day}${r.mode === 'practice' ? ' · practice (simulated equipment)' : ''}`, { size: 12, color: '#444' });
    const made = `Made ${clock(r.finishedAt)}`;
    doc.text(M + W - doc.textWidth(made, 9), y + 2, made, { size: 9, color: '#777' });
    y += 22;

    // summary
    const kv = [
      ['First GO', `${clock(s.first)}`],
      ['Last GO', `${clock(s.last)}`],
      ['Running time', `${dur(s.last - s.first)} (first to last GO)`],
      ['Timers', `Show ${dur(r.timers.show)} · ${r.timers.label} ${dur(r.timers.act)}`],
      ['Cues run', `${s.cuesRun} of ${s.total}${s.outOfOrder ? ` (${s.outOfOrder} out of order)` : ''}`],
      ...(s.missed.length ? [['Not run', s.missed.join(', ')]] : []),
      ['Problems', s.problems.length ? String(s.problems.length) : 'None'],
      ['Emergency stops', s.emergencies ? String(s.emergencies) : 'None'],
      ...(s.jumps ? [['Rehearsal jumps', String(s.jumps)]] : []),
    ];
    doc.rect(M, y, W, kv.reduce((n, [, v]) => n + doc.wrap(v, W - 130, 10).length * 13, 0) + 14, '#f2f4f7');
    y += 7;
    for (const [k, v] of kv) {
      doc.text(M + 10, y, k, { size: 10, bold: true, color: '#333' });
      for (const ln of doc.wrap(v, W - 130, 10)) { doc.text(M + 120, y, ln, { size: 10, color: k === 'Problems' && s.problems.length ? '#b3261e' : '#111' }); y += 13; }
    }
    y += 10;

    if (s.problems.length) {
      head('Problems', '#b3261e');
      for (const p of s.problems) {
        ensure(14); doc.text(M, y, clock(p.at), { size: 10, bold: true, color: '#b3261e' });
        para(p.text, { x: M + 44, w: W - 44, color: '#222' });
      }
    }

    // everything, in order
    head('What happened');
    const cols = [['Time', 52], ['Cue', 40], ['What', 190], ['By', 92], ['Result', W - 374]];
    const header = () => { ensure(20); doc.rect(M, y, W, 16, '#e6e9ee'); let x = M + 4; for (const [t, w] of cols) { doc.text(x, y + 3, t, { size: 9, bold: true, color: '#333' }); x += w; } y += 18; };
    header();
    const rows = r.events.map(e => {
      if (e.t === 'go') {
        const bad = e.results.filter(x => !GOOD.includes(x.outcome));
        return [clockS(e.at), String(e.number), `${e.dept ? `${e.dept} GO: ` : ''}${e.label}${e.out ? ' (out of order)' : ''}`, e.by,
          !e.results.length ? (e.dept || ctx.show.cues[e.i]?.actions?.length ? '' : 'No equipment') : bad.length ? bad.map(x => `${x.name} ${OUTCOME[x.outcome] || x.outcome}`).join('; ') : 'OK', bad.length > 0];
      }
      if (e.t === 'alert') return [clockS(e.at), '', e.msg, '', e.level === 'error' ? 'Problem' : 'OK', e.level === 'error'];
      if (e.t === 'emergency') return [clockS(e.at), '', 'EMERGENCY STOP', e.by, e.problems.length ? `Not confirmed: ${e.problems.join(', ')}` : 'Everything confirmed', true];
      if (e.t === 'cleared') return [clockS(e.at), '', 'Emergency stop cleared', e.by, '', false];
      if (e.t === 'jump') return [clockS(e.at), String(e.number), `Jump to ${e.label}${e.mode === 'look' ? ' (as if it had run)' : ' (ready to GO)'}`, e.by, e.problems?.length ? e.problems.join('; ') : 'OK', !!e.problems?.length];
      if (e.t === 'dept') return [clockS(e.at), '', e.on ? `${e.name} handed to a second operator` : `${e.name} back on the main GO${e.missed ? ` (${e.missed} cues not run)` : ''}`, e.by, '', !!e.missed];
      if (e.t === 'edit') return [clockS(e.at), '', `Cue list changed${e.note ? `: ${e.note}` : ''}`, e.by, '', false];
      return null;
    }).filter(Boolean);
    rows.forEach((row, n) => {
      const cells = cols.map(([, w], k) => doc.wrap(row[k], w - 6, 9, k === 1));
      const h = Math.max(...cells.map(c => c.length)) * 11 + 4;
      if (y + h > BOTTOM) { doc.page(); y = M; header(); }
      if (n % 2) doc.rect(M, y - 1, W, h, '#f7f8fa');
      let x = M + 4;
      cells.forEach((lines, k) => { lines.forEach((ln, j) => doc.text(x, y + 1 + j * 11, ln, { size: 9, bold: k === 1, color: k === 4 && row[5] ? '#b3261e' : '#222' })); x += cols[k][1]; });
      y += h;
    });
    if (!rows.length) para('Nothing happened.', { color: '#777' });

    if (r.notes.length) {
      head('Notes');
      for (const n of r.notes) { ensure(14); doc.text(M, y, `${n.dept || 'Note'}`, { size: 10, bold: true }); para(`${n.text} (${n.cue ? `cue ${n.cue} ${n.cueLabel}, ` : ''}${n.by}, ${clock(n.at)})`, { x: M + 70, w: W - 70 }); }
    }
    if (r.calls.length) {
      head('Calls');
      for (const c of r.calls) { ensure(14); doc.text(M, y, clock(c.at), { size: 10, bold: true }); para(`${c.text} (to ${c.to}, from ${c.by})`, { x: M + 44, w: W - 44 }); }
    }

    for (let i = 0; i < doc.pageCount; i++) {
      const f = `Show Control · ${r.show} · page ${i + 1} of ${doc.pageCount}`;
      doc.goto(i).text(M + W - doc.textWidth(f, 8), doc.height - 34, f, { size: 8, color: '#888' });
    }
    return doc.toBuffer();
  }

  // ---------- screens ----------
  const links = new Map(); // token → { file, until }
  ctx.routes.push(app => app.get('/reports/:token/:file', (req, res) => {
    const l = links.get(req.params.token);
    if (!l || l.until < Date.now()) return res.status(404).type('text').send('This link has expired. Open the report again from Show Control.');
    res.type('pdf').setHeader('Content-Disposition', `inline; filename="${path.basename(l.file).replace(/[^A-Za-z0-9 ._-]/g, '')}"`);
    res.sendFile(l.file);
  }));
  const file = name => {
    const n = path.basename(String(name || ''));
    const f = path.join(dir, `${n}.pdf`);
    if (!n || !fs.existsSync(f)) throw new Error('That report is no longer there.');
    return { n, f };
  };
  ctx.handlers['reports-get'] = () => ({ recording: status(), list: list(), settings: conf(), phoneReady: !!(phone().on && phone().ntfyTopic) });
  ctx.handlers['report-now'] = () => {
    const r = finish('made from a screen', false);
    if (!r) throw new Error(run ? 'The report could not be saved.' : 'Nothing to report yet: the report starts with the first GO.');
    return { name: r.name };
  };
  ctx.handlers['report-link'] = m => {
    const { n, f } = file(m.name);
    const token = crypto.randomBytes(12).toString('hex');
    links.set(token, { file: f, until: Date.now() + 15 * 60e3 });
    for (const [k, v] of links) if (v.until < Date.now()) links.delete(k);
    const r = ctx.readJson(path.join(dir, `${n}.json`), null);
    return { url: `/reports/${token}/${encodeURIComponent(n)}.pdf`, summary: r?.summary, show: r?.show };
  };
  ctx.handlers['report-send'] = async m => {
    const { n, f } = file(m.name);
    return sendToPhone(ctx.readJson(path.join(dir, `${n}.json`), {}), fs.readFileSync(f));
  };
  ctx.handlers['reports-set'] = m => {
    const cur = conf();
    const next = { phone: m.phone ?? cur.phone, afterMin: Math.max(0, Math.min(120, Number(m.afterMin ?? cur.afterMin) || 0)), paper: m.paper === 'a4' ? 'a4' : m.paper === 'letter' ? 'letter' : cur.paper };
    ctx.saveSettings({ reports: next });
    if (run?.endedAt) scheduleFinish();
    return conf();
  };
  // When each cue happened in the last full show (for the scene map).
  ctx.handlers['report-timing'] = () => {
    // the newest run that went all the way to the last cue
    const best = list().find(x => x.reachedEnd && x.kind === 'Show report') || list().find(x => x.reachedEnd);
    const r = best && ctx.readJson(path.join(dir, `${best.name}.json`), null);
    if (!r) return null;
    const at = {};
    for (const e of r.events) if (e.t === 'go' && !e.dept && at[e.i] == null && r.cues[e.i]?.label === ctx.show.cues[e.i]?.label) at[e.i] = e.at - r.summary.first;
    return { from: r.summary.first, length: r.summary.last - r.summary.first, at };
  };
  for (const t of ['reports-get', 'report-link', 'report-timing']) ctx.access?.viewerMay(t);
  ctx.initExtras.push(() => ({ reportRecording: status() }));
};
