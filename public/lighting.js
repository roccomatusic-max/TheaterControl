// ---------- House lights, the console's cue list, channel check ----------
'use strict';
// House lights in cues: they are equipment called "house" (server/features/house.js).
CATALOG.house = {
  houseLook: [['look', 'select:full|preshow|half|out', 'half', 'Look'], ['fade', 'number', 5, 'Fade (s)']],
  houseLevel: [['level', 'number', 50, 'Level %'], ['fade', 'number', 5, 'Fade (s)']],
};
Object.assign(CMD_LABEL, { houseLook: 'Go to a look', houseLevel: 'Set a level' });

onMsg('init', m => { S.house = m.house || null; S.eosCues = m.eosCues || null; S.chancheck = m.chancheck || null; });
onMsg('house', m => {
  if (m.house) S.devices.house = m.house; else delete S.devices.house;
  renderDots();
  ask('house-get').then(r => { if (!r.error) S.house = r; });
});
onMsg('eos-cues', m => { S.eosCues = m.eosCues; (updaters.__eosCues || []).forEach(f => f()); });
onMsg('chancheck', m => { S.chancheck = m.chancheck; (updaters.__chancheck || []).forEach(f => f()); });

// ---------- house lights: the buttons ----------
let houseFade = ''; // '' is the usual fade
function houseControls() {
  const now = h('div', { class: 'housenow' });
  onDevice('house', d => {
    const s = d.state || {}, to = s.target ?? s.level;
    const look = S.house?.looks.find(l => l.id === s.look && l.level === to);
    const where = s.level == null ? 'Level not known yet' : s.fading ? `Fading to ${look ? look.name : `${to}%`}, now ${s.level}%` : `At ${look ? `${look.name} (${s.level}%)` : `${s.level}%`}`;
    fill(now, h('span', { class: `pill ${d.status === 'online' ? 'ok' : 'off'}` }, d.status === 'online' ? 'ready' : 'not connected'), h('span', {}, where));
  });
  const go = async args => {
    const r = await cmd('house', args.look ? 'houseLook' : 'houseLevel', { ...args, ...(houseFade !== '' ? { fade: Number(houseFade) } : {}) });
    if (typeof r === 'string') toast(r, 5000);
  };
  const fades = [['', `Usual fade (${S.house?.fade ?? 5} s)`], ['0', 'Snap'], ['3', '3 seconds'], ['10', '10 seconds']];
  return h('div', { class: 'house' }, now,
    h('div', { class: 'houselooks' }, (S.house?.looks || []).map(l => h('button', { class: 'big', onclick: () => go({ look: l.id }) }, l.name, h('small', {}, `${l.level}%`)))),
    h('div', { class: 'row', style: 'align-items:center;margin-top:8px' }, h('span', { class: 'dim' }, 'Fade'),
      h('select', { onchange: e => (houseFade = e.target.value) }, fades.map(([v, t]) => h('option', { value: v, selected: v === houseFade }, t)))));
}
SHOW_BUTTONS.push(() => S.devices.house ? h('button', { onclick: () => sheet(h('h2', {}, 'House lights'), houseControls()) }, 'House lights') : null);
LX_CARDS.push(() => S.devices.house ? h('div', { class: 'card' }, h('h3', {}, 'House lights'), houseControls()) : null);

// ---------- house lights: setting them up (System tab) ----------
SYS_CARDS.push(() => {
  const body = h('div', { class: 'form' }, h('div', { class: 'dim' }, 'Loading…'));
  const NEEDS = { sub: 'eos', chan: 'eos', macro: 'eos', dmx: 'dmx' };
  const draw = r => {
    if (r.error) return fill(body, h('div', { class: 'bad' }, r.error));
    S.house = r;
    const admin = S.role === 'admin';
    const set = async patch => { const x = await ask('house-set', patch); if (x.error) { toast(x.error, 5000); draw(r); } else draw(x); };
    const choices = r.choices.filter(d => d.type === NEEDS[r.way]);
    const num = (label, value, patch) => h('label', {}, label, h('input', { class: 'time', inputmode: 'numeric', value: value ?? '', disabled: !admin, onchange: e => set(patch(e.target.value)) }));
    fill(body,
      h('p', { class: 'dim' }, 'The audience lights, from a button on the Show and Lighting tabs, or as a step in any cue.'),
      h('label', {}, 'Where are they?', h('select', { disabled: !admin, onchange: e => set({ way: e.target.value, device: r.choices.find(d => d.type === NEEDS[e.target.value])?.id || '' }) },
        [['', 'Not set up'], ['sub', 'A submaster on the Eos'], ['chan', 'Channels on the Eos'], ['macro', 'Macros on the Eos, one for each look'], ['dmx', 'Their own DMX box']]
          .map(([v, t]) => h('option', { value: v, selected: v === r.way }, t)))),
      r.way && !choices.length && h('p', { class: 'bad' }, NEEDS[r.way] === 'dmx' ? 'Add the DMX box in "Set up real equipment" first (DMX over the network).' : 'Add the Eos in "Set up real equipment" first.'),
      r.way && choices.length > 1 && h('label', {}, 'On', h('select', { disabled: !admin, onchange: e => set({ device: e.target.value }) }, choices.map(d => h('option', { value: d.id, selected: d.id === r.device }, d.name)))),
      r.way === 'sub' && num('Submaster number', r.sub, v => ({ sub: v })),
      r.way === 'chan' && [h('label', {}, 'Channels (like 501-504)', h('input', { value: r.chans, disabled: !admin, onchange: e => set({ chans: e.target.value }) })),
        h('p', { class: 'dim small' }, 'These stay as manual levels on the console. A submaster is tidier if the board operator can make one.')],
      r.way === 'dmx' && h('label', {}, 'DMX channels (like 1-4)', h('input', { value: r.channels, disabled: !admin, onchange: e => set({ channels: e.target.value }) })),
      r.way && h('div', { class: 'houselevels' }, r.looks.map(l => r.way === 'macro'
        ? num(`${l.name}: macro`, r.macros[l.id], v => ({ macros: { [l.id]: v } }))
        : num(`${l.name} %`, l.level, v => ({ levels: { [l.id]: v } })))),
      r.way && r.way !== 'macro' && num('Usual fade, seconds', r.fade, v => ({ fade: v })),
      r.way && h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: r.onStop, disabled: !admin, onchange: e => set({ onStop: e.target.checked }) }), 'Holding STOP brings the house lights to Full'));
  };
  ask('house-get').then(draw);
  return h('div', { class: 'card hcard' }, h('h3', {}, 'House lights'), body);
});

// ---------- the console's cue list (Lighting tab) ----------
const eosNorm = x => (x === '' || x == null || isNaN(x) ? String(x ?? '') : String(Number(x)));
// lighting cue number → the show cue that fires it, for one list
function showCuesFor(eosId, list) {
  const out = new Map();
  S.show.cues.forEach((c, i) => (c.actions || []).forEach(a => {
    if (a.device === eosId && a.cmd === 'cue' && (Number(a.args?.list ?? 1) || 1) === list && !out.has(eosNorm(a.args?.cue))) out.set(eosNorm(a.args?.cue), c.number ?? i + 1);
  }));
  return out;
}
const eosTimes = c => [c.up == null ? '' : c.down != null && c.down !== c.up ? `${c.up}/${c.down}` : `${c.up}`, c.follow != null ? `F${c.follow}` : '', c.hang != null ? `H${c.hang}` : ''].filter(Boolean).join(' ');
let eosListNo = 1;
LX_CARDS.push(eos => {
  if (!eos) return null;
  const head = h('div', { class: 'dim small' });
  const box = h('div', { class: 'eoslist' });
  const tools = h('div', { class: 'row', style: 'margin-top:8px' });
  const mark = d => {
    const live = d?.state?.active, pend = d?.state?.pending;
    let liveRow = null;
    for (const row of box.querySelectorAll('.eoscue')) {
      const isLive = live?.list === eosListNo && eosNorm(live.cue) === row.dataset.n;
      row.classList.toggle('live', isLive);
      row.classList.toggle('pend', pend?.list === eosListNo && eosNorm(pend.cue) === row.dataset.n);
      if (isLive) liveRow = row;
    }
    // keep the live cue in view, a third of the way down
    if (liveRow && liveRow.dataset.n !== box.dataset.shown) { box.dataset.shown = liveRow.dataset.n; box.scrollTop = liveRow.offsetTop - box.clientHeight / 3; }
  };
  const draw = () => {
    const m = S.eosCues;
    if (!m?.at) { fill(head, m?.error ? `Couldn't read the cue list: ${m.error}` : 'Reading the cue list from the console…'); fill(box); fill(tools); return; }
    const lists = Object.keys(m.lists).map(Number);
    if (!lists.includes(eosListNo)) eosListNo = lists[0];
    const cues = m.lists[eosListNo] || [], inShow = showCuesFor(eos.id, eosListNo);
    const missing = cues.filter(c => !inShow.has(c.number));
    fill(head, lists.length > 1 && h('span', { class: 'row', style: 'margin-bottom:6px' }, lists.map(l => h('button', { class: `mini ${l === eosListNo ? 'primary' : ''}`, onclick: () => { eosListNo = l; draw(); } }, `List ${l}`))),
      `${cues.length} cues in list ${eosListNo}, read at ${hhmm(m.at)}. Green is live on stage, yellow is next.${m.error ? ` (Last try: ${m.error})` : ''}`);
    let scene = null;
    const rows = [];
    for (const c of cues) {
      if (c.scene && c.scene !== scene) { scene = c.scene; rows.push(h('div', { class: 'eosscene' }, c.scene)); }
      rows.push(h('button', { class: 'eoscue always', 'data-n': c.number, onclick: () => eosCueSheet(eos, eosListNo, c, inShow.get(c.number)) },
        h('b', {}, c.number), h('span', { class: 'lbl' }, c.label || '—', c.notes ? h('small', {}, c.notes) : null), h('span', { class: 'tm' }, eosTimes(c)),
        inShow.has(c.number) ? h('span', { class: 'inshow' }, `show ${inShow.get(c.number)}`) : h('span', {})));
    }
    delete box.dataset.shown;
    fill(box, rows);
    fill(tools, missing.length > 0 && h('button', { onclick: () => eosAddSheet(eos, eosListNo, cues, inShow) }, `Add cues to the show's cue list (${missing.length} not in it)…`));
    mark(S.devices[eos.id]);
  };
  onDevice(eos.id, mark);
  (updaters.__eosCues ||= []).push(draw);
  draw();
  const again = async () => { fill(head, 'Reading the cue list from the console…'); const r = await ask('eos-cues-refresh', {}, 60000); if (r.error) toast(r.error, 5000); else { S.eosCues = r; draw(); } };
  return h('div', { class: 'card eoscard' }, h('h3', {}, 'Cue list on the console', h('button', { class: 'mini always', onclick: again }, 'Read again')), head, box, tools);
});
function eosCueSheet(eos, list, c, showNo) {
  const el = sheet(h('h2', {}, `Lighting cue ${list}/${c.number}`), h('p', {}, c.label || 'No label'),
    h('div', { class: 'kv' }, h('b', {}, 'Time'), h('span', {}, c.up == null ? '—' : c.down != null && c.down !== c.up ? `${c.up} s up, ${c.down} s down` : `${c.up} s`),
      c.follow != null && [h('b', {}, 'Follow'), h('span', {}, `the next cue runs by itself ${c.follow} s after this one starts`)],
      c.hang != null && [h('b', {}, 'Hang'), h('span', {}, `the next cue runs by itself ${c.hang} s after this one ends`)],
      c.scene && [h('b', {}, 'Scene'), h('span', {}, c.scene)], c.notes && [h('b', {}, 'Notes'), h('span', {}, c.notes)],
      h('b', {}, 'Show cue list'), h('span', {}, showNo != null ? `fired by show cue ${showNo}` : 'not in it')),
    h('button', { onclick: () => { if (confirm(`Fire lighting cue ${list}/${c.number} on the console now? The stage changes.`)) { cmd(eos.id, 'cue', { list, cue: c.number }); el.remove(); } } }, 'Fire this cue on the console'),
    showNo == null && h('button', { class: 'primary', onclick: async () => { const r = await ask('eos-import', { list, numbers: [c.number] }); if (r.error) return toast(r.error, 5000); toast('Added to the show\'s cue list'); el.remove(); render(); } }, 'Add it to the show\'s cue list'));
}
// Pick console cues to add as show cues. Cues that run by themselves (after a follow or hang) start unticked.
function eosAddSheet(eos, list, cues, inShow) {
  const auto = new Set();
  cues.forEach((c, i) => { if ((c.follow != null || c.hang != null) && cues[i + 1]) auto.add(cues[i + 1].number); });
  const picks = cues.filter(c => !inShow.has(c.number)).map(c => ({ c, box: h('input', { type: 'checkbox', checked: !auto.has(c.number) }) }));
  const err = h('p', { class: 'err' });
  const el = sheet(h('h2', {}, 'Add lighting cues to the show'),
    h('p', {}, 'Each one becomes a show cue that fires that lighting cue, in order among the show cues you already have. Cues that run by themselves after a follow or hang are left out unless you tick them.'),
    h('div', { class: 'row' }, h('button', { class: 'mini', onclick: () => picks.forEach(p => (p.box.checked = true)) }, 'Tick all'), h('button', { class: 'mini', onclick: () => picks.forEach(p => (p.box.checked = false)) }, 'Untick all')),
    h('div', { class: 'eospick' }, picks.map(({ c, box }) => h('label', { class: 'check' }, box, `${c.number}  ${c.label || ''}${auto.has(c.number) ? ' (runs by itself)' : ''}`))),
    err,
    h('button', { class: 'primary', onclick: async () => {
      const numbers = picks.filter(p => p.box.checked).map(p => p.c.number);
      if (!numbers.length) { err.textContent = 'Tick the cues to add.'; return; }
      const r = await ask('eos-import', { list, numbers });
      if (r.error) { err.textContent = r.error; return; }
      toast(`Added ${r.added} cue${r.added > 1 ? 's' : ''} to the show's cue list. Undo is in the cue list history.`, 5000);
      el.remove(); render();
    } }, 'Add the ticked cues'));
}

// ---------- channel check ----------
const ccLevel = l => (l >= 100 ? 'Full' : `${l}%`);
const ccWhat = ch => [ch.label, ch.type, ch.gel && `gel ${ch.gel}`].filter(Boolean).join(' · ');
const ccLast = l => `Last check ${new Date(l.at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })} by ${l.by}: ${l.checked} of ${l.total} channels, ${l.problems ? `${l.problems} problem${l.problems > 1 ? 's' : ''}` : 'no problems'}.`;
LX_CARDS.push(() => {
  if (!S.chancheck?.devices.length) return null;
  const body = h('div', {});
  const draw = () => {
    const c = S.chancheck, r = c.run;
    fill(body,
      r ? h('p', {}, `Running (${r.by}): channel ${r.chans[r.at].n}, ${r.at + 1} of ${r.chans.length}.`)
        : h('p', { class: 'dim' }, c.last ? ccLast(c.last) : 'Bring up one channel at a time from your phone, walk the stage, and note anything that needs fixing.'),
      c.problems.length > 0 && h('p', { class: 'bad' }, `To fix: ${c.problems.slice(0, 4).map(p => `${p.n} ${p.note.toLowerCase()}`).join(', ')}${c.problems.length > 4 ? '…' : ''}`),
      h('button', { class: 'always', onclick: () => { S.tab = 'chancheck'; render(); } }, r ? 'Carry on with the channel check' : 'Channel check'));
  };
  (updaters.__chancheck ||= []).push(draw);
  draw();
  return h('div', { class: 'card' }, h('h3', {}, 'Channel check'), body);
});
function ccProblemSheet(done) {
  const note = h('input', { placeholder: 'Or say what is wrong' });
  const pick = t => { el.remove(); done(t); };
  const el = sheet(h('h2', {}, 'What\'s wrong?'),
    h('div', { class: 'reasons' }, ['No light (lamp out)', 'Wrong colour', 'Focus or position off', 'Flickers', 'Wrong channel', 'Dim'].map(t => h('button', { onclick: () => pick(t) }, t))),
    note, h('button', { class: 'primary', onclick: () => pick(note.value.trim() || 'Problem') }, 'Save this note'));
  return el;
}
function ccProblems(c, act) {
  if (!c.problems.length) return null;
  const name = id => c.devices.find(d => d.id === id)?.name || id;
  return h('div', { class: 'card' }, h('h3', {}, `To fix (${c.problems.length})`),
    h('div', { class: 'maps' }, c.problems.map(p => h('div', { class: 'bk' },
      h('span', {}, h('b', {}, `${p.n}${p.label ? ` ${p.label}` : ''}`), ` · ${p.note}`, h('small', { class: 'dim' }, ` ${name(p.device)}, ${hhmm(p.at)}`)),
      h('button', { class: 'mini', onclick: () => act('chancheck-fixed', { n: p.n, device: p.device }) }, 'Fixed')))));
}
NAV_PARENT.chancheck = 'lx';
VIEWS.chancheck = () => {
  const wrap = h('div', { class: 'grid' });
  const act = async (t, payload = {}) => { const r = await ask(t, payload, 30000); if (r.error) return toast(r.error, 5000); S.chancheck = r; draw(); };
  const draw = () => {
    const c = S.chancheck || { devices: [], problems: [] }, r = c.run;
    if (r) {
      const ch = r.chans[r.at], marked = r.marks[ch.n];
      return fill(wrap, h('div', { class: 'card cc-now' },
        h('div', { class: 'cc-top' }, h('span', {}, `${r.at + 1} of ${r.chans.length}`), h('span', {}, `at ${ccLevel(r.level)}`)),
        h('div', { class: 'cc-n' }, `Channel ${ch.n}`),
        h('div', { class: 'cc-label' }, ccWhat(ch) || ' '),
        h('div', { class: 'cc-bar' }, h('i', { style: `width:${((r.at + 1) / r.chans.length) * 100}%` })),
        marked && h('div', { class: marked === 'ok' ? 'good' : 'bad', style: 'text-align:center' }, marked === 'ok' ? 'Marked OK' : 'Marked as a problem'),
        h('button', { class: 'big cc-ok always', onclick: () => act('chancheck-step', { mark: 'ok' }) }, r.at + 1 < r.chans.length ? 'OK, next ›' : 'OK, finish'),
        h('button', { class: 'big cc-bad always', onclick: () => ccProblemSheet(note => act('chancheck-step', { mark: 'problem', note })) }, 'Problem…'),
        h('div', { class: 'row' }, h('button', { class: 'always', disabled: r.at === 0, onclick: () => act('chancheck-step', { to: 'back' }) }, '‹ Back'),
          h('button', { class: 'always', onclick: () => act('chancheck-step', { to: 'next' }) }, 'Skip ›'),
          h('button', { class: 'always', onclick: () => confirm('Finish the channel check? Every channel goes back to how the console had it.') && act('chancheck-finish') }, 'Finish'))),
      ccProblems(c, act));
    }
    if (!c.devices.length) return fill(wrap, h('div', { class: 'card' }, 'Add a lighting console or a DMX box in "Set up real equipment" first.'));
    let dev = c.devices.find(d => d.type === 'eos') || c.devices[0];
    const chans = h('input', { placeholder: dev.type === 'eos' ? 'Every patched channel' : 'Like 1-24' });
    const level = h('select', {}, [50, 75, 100].map(l => h('option', { value: l, selected: l === 75 }, ccLevel(l))));
    fill(wrap, h('div', { class: 'card form' }, h('h3', {}, 'Channel check'),
      h('p', { class: 'dim' }, 'Each channel comes on by itself. Walk the stage with this phone: tap OK if it looks right, or Problem to note what is wrong. At the end every channel goes back to how the console had it.'),
      c.devices.length > 1 && h('label', {}, 'Check', h('select', { onchange: e => { dev = c.devices.find(d => d.id === e.target.value); chans.placeholder = dev.type === 'eos' ? 'Every patched channel' : 'Like 1-24'; } },
        c.devices.map(d => h('option', { value: d.id, selected: d === dev }, d.name)))),
      h('label', {}, 'Channels', chans), h('label', {}, 'Level', level),
      h('button', { class: 'big primary', onclick: () => act('chancheck-start', { device: dev.id, channels: chans.value, level: Number(level.value) }) }, 'Start'),
      c.last && h('p', { class: 'dim' }, ccLast(c.last))),
    ccProblems(c, act));
  };
  (updaters.__chancheck ||= []).push(draw);
  draw();
  return h('div', {}, h('div', { class: 'row', style: 'margin-bottom:10px' }, h('button', { class: 'always', onclick: () => { S.tab = 'lx'; render(); } }, '← Lighting')), wrap);
};
