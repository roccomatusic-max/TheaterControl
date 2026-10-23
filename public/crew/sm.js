// Stage manager screen: a GO-only calling view on the left, crew tools on the right.
'use strict';
$('#night').append(nightBtn());
C.defaultName = 'SM';
const root = $('#sm');

// ---------- calling column ----------
const stby = h('div', { class: 'bigstby' });
let lastGo = 0;
const go = h('button', { id: 'smGo', onclick: () => { if (Date.now() - lastGo < 600) return; lastGo = Date.now(); showCmd('go'); } }, 'GO');
const last = h('div', { class: 'lastfired' });
const nav = h('div', { class: 'row' },
  h('button', { onclick: () => showCmd('standby', { index: Math.max(0, C.show.index - 1) }) }, '◀ Back one'),
  h('button', { onclick: () => showCmd('standby', { index: Math.min(C.show.cues.length, C.show.index + 1) }) }, 'Skip ▶'));
const tmrs = h('div', { class: 'tmini' });
const left = h('div', { class: 'callcol' }, stby, go, nav, last, tmrs);

function devName(id) {
  const g = String(id).startsWith('group:') && C.groups.find(x => x.id === id.slice(6));
  return g ? g.name : (C.devices[id]?.name || id).split(' · ')[0];
}
function offline(cue) {
  const ids = [...new Set((cue?.actions || []).flatMap(a => String(a.device).startsWith('group:') ? (C.groups.find(g => g.id === a.device.slice(6))?.members || []) : [a.device]))];
  return ids.map(id => C.devices[id]).filter(d => d && d.status !== 'online').map(d => d.name.split(' · ')[0]);
}
function updCalling() {
  const sh = C.show, i = sh.index, c = sh.cues[i];
  go.disabled = !c;
  const acks = C.crew?.acks || {};
  const roles = [...new Set((c?.crew || []).map(x => x.role))];
  const off = offline(c);
  fill(stby, h('small', {}, 'STANDBY'),
    h('div', { class: 'num' }, c ? cueNo(c, i) : '—'), h('div', { class: 'lbl' }, c ? c.label : 'End of show'),
    c && h('div', { class: 'row', style: 'align-items:center' },
      c.note ? h('div', { class: 'cue-note', style: 'flex:1' }, c.note) : h('div', { style: 'flex:1', class: 'dim' }, 'No note on this cue'),
      h('button', { style: 'flex:0 0 auto', onclick: () => editNote(i) }, c.note ? '✎ Note' : '+ Note')),
    roles.length > 0 && h('div', { class: 'needs' }, roles.map(r => h('span', { class: `need ${acks[r] ? 'ack' : ''}`, title: tasksFor(c, r).map(x => x.task).join(', ') },
      acks[r] ? `✓ ${r} (${acks[r].name})` : `${r}: waiting`))),
    off.length > 0 && h('div', { class: 'warnline' }, `⚠ Not connected: ${off.join(', ')}`),
    c && h('div', { class: 'acts', style: 'margin-top:6px' }, (c.actions || []).map(a => `${devName(a.device)} ${a.cmd}`).join(' · ')));
  const lf = sh.cues[sh.lastFired];
  last.textContent = lf ? `Last GO: ${cueNo(lf, sh.lastFired)} ${lf.label}` : 'No cue fired yet';
}
function editNote(i) {
  const c = C.show.cues[i];
  const v = prompt(`Note for cue ${cueNo(c, i)} ${c.label} (shown when it comes up):`, c.note || '');
  if (v != null) ask('cue-note', { index: i, note: v }).then(r => r.ok && toast('Note saved'));
}
function timerCard(key, label) {
  const t = h('div', { class: 't' });
  on('tick', () => (t.textContent = fmtDur(timerMs(key))));
  return h('div', { class: 'card' }, h('h3', {}, label()), t, h('div', { class: 'row' },
    h('button', { onclick: () => showCmd('timer', { timer: key, op: 'start' }) }, 'Start'),
    h('button', { onclick: () => showCmd('timer', { timer: key, op: 'stop' }) }, 'Stop'),
    h('button', { onclick: () => confirm(`Reset the ${label()} timer?`) && showCmd('timer', { timer: key, op: 'reset' }) }, 'Reset')));
}

// ---------- tools column ----------
const PANELS = { calls: 'Calls', notes: 'Notes', script: 'Script', check: 'Checklist', crew: 'Crew', count: 'Countdown' };
let panel = localStorage.getItem('smPanel') || 'calls';
const ptabs = h('div', { class: 'ptabs' });
const body = h('div', { class: 'card' });
const right = h('div', {}, ptabs, body);
let panelUpd = () => {}, panelGen = 0;
function openPanel(p) {
  panel = p; panelGen++; localStorage.setItem('smPanel', p);
  fill(ptabs, ...Object.entries(PANELS).map(([k, l]) => h('button', { class: k === p ? 'on always' : 'always', onclick: () => openPanel(k) }, l)));
  const v = { calls: callsPanel, notes: notesPanel, script: scriptPanel, check: checkPanel, crew: crewPanel, count: countPanel }[p]();
  fill(body, v.el); panelUpd = v.upd; v.upd();
}
const ago = t => clock(t);

function callsPanel() {
  const PRESETS = ['Half hour please', 'Quarter of an hour please', 'Five minutes please', 'Beginners please', 'Places please', 'Show stop: hold please'];
  const to = h('select', {});
  const text = h('input', { placeholder: 'Your own call…', style: 'flex:1' });
  const recent = h('div', { class: 'items' });
  const call = t => t && ask('call', { text: t, to: to.value }).then(r => r.ok && toast(`Called: ${t}`));
  return {
    el: h('div', {}, h('h3', {}, 'Call the company'),
      h('label', { class: 'form' }, h('span', { class: 'big-label', style: 'margin:0' }, 'Send to'), to),
      h('div', { class: 'chips', style: 'margin-top:10px' }, PRESETS.map(p => h('button', { onclick: () => call(p) }, p))),
      h('div', { class: 'row', style: 'margin-top:10px' }, text, h('button', { class: 'primary', onclick: () => { call(text.value.trim()); text.value = ''; } }, 'Send')),
      h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { onclick: () => ask('call', { text: 'Are we clear to start?', to: 'foh' }) }, 'Ask front of house: clear to start?')),
      h('div', { class: 'big-label' }, 'Recent calls (who has seen them)'), recent),
    upd() {
      const cur = to.value || 'all';
      fill(to, h('option', { value: 'all' }, 'Everyone (crew and front of house)'), h('option', { value: 'crew' }, 'All crew'), h('option', { value: 'foh' }, 'Front of house'),
        (C.crew.roles || []).map(r => h('option', { value: r }, r)));
      to.value = cur;
      fill(recent, ...C.crew.calls.slice().reverse().map(c => h('div', { class: 'item' },
        h('div', {}, h('b', {}, c.text), h('div', { class: 'meta' }, `${ago(c.at)} to ${c.to === 'all' ? 'everyone' : c.to === 'foh' ? 'front of house' : c.to} · ${Object.keys(c.acks).length ? `seen by ${Object.keys(c.acks).join(', ')}` : 'not seen yet'}`)))));
      if (!C.crew.calls.length) recent.append(h('p', { class: 'dim' }, 'No calls yet.'));
    },
  };
}

function notesPanel() {
  let dept = localStorage.getItem('noteDept') || '', filter = '';
  const depts = h('div', { class: 'chips' }), filters = h('div', { class: 'chips', style: 'margin-top:10px' });
  const text = h('textarea', { placeholder: 'Note…' });
  const addBtn = h('button', { class: 'primary', style: 'width:100%;margin-top:8px', onclick: () => {
    const t = text.value.trim(); if (!t) return;
    ask('note-add', { text: t, dept }).then(r => { if (r.ok) { text.value = ''; toast('Note added'); } });
  } });
  const items = h('div', { class: 'items' });
  const upd = () => {
    const sh = C.show, i = sh.lastFired ?? sh.index, c = sh.cues[i];
    addBtn.textContent = c ? `Add note at cue ${cueNo(c, i)}` : 'Add note';
    fill(depts, ...C.crew.depts.map(d => h('button', { class: d === dept ? 'on' : '', onclick: () => { dept = d === dept ? '' : d; localStorage.setItem('noteDept', dept); upd(); } }, d)));
    fill(filters, h('button', { class: !filter ? 'on' : '', onclick: () => { filter = ''; upd(); } }, `All (${C.crew.notes.length})`),
      ...C.crew.depts.map(d => h('button', { class: d === filter ? 'on' : '', onclick: () => { filter = d; upd(); } }, `${d} (${C.crew.notes.filter(n => n.dept === d).length})`)));
    const list = C.crew.notes.filter(n => !filter || n.dept === filter).slice().reverse();
    fill(items, ...list.map(n => h('div', { class: 'item' },
      h('div', {}, h('div', {}, n.text), h('div', { class: 'meta' }, [n.cue && `Q${n.cue} ${n.cueLabel}`, n.dept, fmtDur(n.showTime), `${clock(n.at)} ${n.by}`].filter(Boolean).join(' · '))),
      h('button', { onclick: () => confirm('Delete this note?') && ask('note-del', { note: n.id }) }, '✕'))));
    if (!list.length) items.append(h('p', { class: 'dim' }, 'No notes yet. Notes are tagged with the last cue fired and the show time.'));
  };
  return {
    el: h('div', {}, h('h3', {}, 'Rehearsal notes', h('span', { class: 'row' },
      h('button', { onclick: exportNotes }, 'Export'),
      h('button', { class: 'danger', onclick: () => confirm('Delete ALL notes? Export them first if you want to keep them.') && ask('notes-clear') }, 'Clear'))),
    depts, h('div', { style: 'height:8px' }), text, addBtn, filters, items),
    upd,
  };
}
function exportNotes() {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Date', 'Time', 'Show time', 'Cue', 'Cue name', 'Department', 'Note', 'By'],
    ...C.crew.notes.map(n => [new Date(n.at).toLocaleDateString(), clock(n.at), fmtDur(n.showTime), n.cue, n.cueLabel, n.dept, n.text, n.by])];
  const blob = new Blob(['﻿' + rows.map(r => r.map(q).join(',')).join('\r\n')], { type: 'text/csv' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `${C.show.name} notes ${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.append(a); a.click(); a.remove();
}

function scriptPanel() {
  let mode = 'follow', editing = !C.script.text;
  const wrap = h('div', {});
  let lines = [], lineEls = [], marks = {};
  const place = h('select', {});
  function draw() {
    if (editing) {
      const ta = h('textarea', { style: 'min-height:50vh', placeholder: 'Paste the script here (copy it from a Word or PDF file). One line per line of the script.' }, C.script.text);
      fill(wrap, h('h3', {}, 'Script text'), ta, h('div', { class: 'row', style: 'margin-top:8px' },
        C.script.text && h('button', { onclick: () => { editing = false; draw(); } }, 'Cancel'),
        h('button', { class: 'primary', onclick: () => ask('script', { text: ta.value }).then(r => { if (r.ok) { editing = false; draw(); toast('Script saved'); } }) }, 'Save script')),
      h('p', { class: 'hint' }, 'After saving, use "Place cues" to tap the line where each cue is called. Cue places stay attached to the cue number.'));
      return;
    }
    lines = C.script.text.split(/\r?\n/); marks = { ...C.script.marks };
    const byLine = {};
    for (const [q, l] of Object.entries(marks)) (byLine[l] ||= []).push(q);
    lineEls = lines.map((t, n) => h('div', { class: `ln ${mode === 'place' ? 'placing' : ''}`, onclick: () => mode === 'place' && placeAt(n) },
      byLine[n] && h('span', { class: 'mk' }, byLine[n].map(q => `Q${q}`).join(' ')), t || ' '));
    const keep = wrap.querySelector('.script')?.scrollTop || 0; // placing a cue mustn't lose your place
    const box = h('div', { class: 'script' }, lineEls);
    fill(place, ...C.show.cues.map((c, i) => h('option', { value: cueNo(c, i), selected: i === C.show.index }, `${cueNo(c, i)} ${c.label}${marks[cueNo(c, i)] != null ? ' ✓' : ''}`)));
    fill(wrap, h('h3', {}, 'Script', h('span', { class: 'row' },
      h('button', { class: mode === 'follow' ? 'on' : '', onclick: () => { mode = 'follow'; draw(); } }, 'Follow'),
      h('button', { class: mode === 'place' ? 'on' : '', onclick: () => { mode = 'place'; draw(); } }, 'Place cues'),
      h('button', { onclick: () => { editing = true; draw(); } }, 'Edit text'))),
    mode === 'place' && h('div', { class: 'row', style: 'align-items:center;margin-bottom:8px' }, h('span', { class: 'dim' }, 'Tap a line to put'), place, h('span', { class: 'dim' }, 'there. Tap it again to remove.')),
    box);
    box.scrollTop = keep;
    follow();
  }
  function placeAt(n) {
    const q = place.value; if (!q) return;
    if (marks[q] === n) delete marks[q]; else marks[q] = n;
    ask('script', { marks }).then(r => {
      if (!r.ok) return;
      const i = C.show.cues.findIndex((c, j) => cueNo(c, j) === q);
      if (marks[q] != null && C.show.cues[i + 1]) place.value = cueNo(C.show.cues[i + 1], i + 1); // ready for the next cue
    });
  }
  // keep the standby cue's line in view
  function follow() {
    if (editing) return;
    lineEls.forEach(e => e.classList.remove('stby'));
    const c = C.show.cues[C.show.index], n = c && marks[cueNo(c, C.show.index)];
    const el = n != null && lineEls[n];
    if (el) { el.classList.add('stby'); if (mode === 'follow') { const box = el.parentElement; box.scrollTop = Math.max(0, el.offsetTop - box.clientHeight / 3); } }
  }
  const gen = panelGen;
  on('script', () => gen === panelGen && draw());
  draw();
  let lastIndex = C.show.index;
  return { el: wrap, upd() { if (C.show.index !== lastIndex) { lastIndex = C.show.index; follow(); } } };
}

function checkPanel() {
  const wrap = h('div', {});
  let editing = false;
  const upd = () => {
    const ck = C.crew.checks, items = C.crew.checklist, done = items.filter((_, i) => ck.ticks[i]).length;
    if (editing) {
      const ta = h('textarea', { style: 'min-height:40vh' }, items.join('\n'));
      fill(wrap, h('h3', {}, 'Checklist items'), h('p', { class: 'hint' }, 'One item per line. Saving clears tonight\'s ticks.'), ta,
        h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { onclick: () => { editing = false; upd(); } }, 'Cancel'),
          h('button', { class: 'primary', onclick: () => ask('conf', { checklist: ta.value }).then(r => { if (r.ok) { editing = false; upd(); } }) }, 'Save')));
      return;
    }
    fill(wrap, h('h3', {}, `Show night checklist · ${done}/${items.length}`, h('span', { class: 'row' },
      h('button', { onclick: () => { editing = true; upd(); } }, 'Edit'),
      h('button', { onclick: () => confirm('Start a new night? All ticks are cleared.') && ask('checks-reset') }, 'New night'))),
    h('div', { class: 'progress' }, h('i', { style: `width:${items.length ? done / items.length * 100 : 0}%` })),
    h('div', { class: 'items' }, items.map((t, i) => {
      const tk = ck.ticks[i];
      return h('div', { class: `tick ${tk ? 'on' : ''}` }, h('button', { onclick: () => ask('check', { i, on: !tk }) }, tk ? '✓' : ''),
        h('div', {}, h('div', { class: 'tx' }, t), tk && h('div', { class: 'item meta', style: 'background:none;padding:0' }, `${tk.by} · ${clock(tk.at)}`)));
    })),
    ck.signedOff ? h('p', { class: 'cue-note', style: 'background:#0f3a20;color:#7ee2a2' }, `Signed off by ${ck.signedOff.by} at ${clock(ck.signedOff.at)}`)
      : h('button', { class: 'primary', style: 'width:100%;margin-top:10px', disabled: done < items.length ? '' : null, onclick: () => ask('signoff').then(r => r.ok && toast('Signed off')) },
        done < items.length ? `Sign off (${items.length - done} to go)` : 'Sign off: ready for the show'),
    h('p', { class: 'hint' }, `Ticks are kept until "New night" (started ${new Date(ck.started).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}). Anyone on a crew phone can tick too.`));
  };
  return { el: wrap, upd };
}

function crewPanel() {
  const wrap = h('div', {});
  let editing = false;
  const upd = () => {
    if (editing) {
      const roles = h('textarea', {}, C.crew.roles.join('\n')), depts = h('textarea', {}, C.crew.depts.join('\n'));
      fill(wrap, h('h3', {}, 'Crew setup'), h('div', { class: 'form' },
        h('label', {}, 'Crew roles (one per line). Each gets its own run sheet and cue light.', roles),
        h('label', {}, 'Departments for notes (one per line)', depts)),
      h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { onclick: () => { editing = false; upd(); } }, 'Cancel'),
        h('button', { class: 'primary', onclick: () => ask('conf', { roles: roles.value, depts: depts.value }).then(r => { if (r.ok) { editing = false; upd(); } }) }, 'Save')));
      return;
    }
    const sh = C.show, c = sh.cues[sh.index], acks = C.crew.acks;
    const base = location.origin;
    fill(wrap, h('h3', {}, 'Crew cue lights', h('button', { onclick: () => { editing = true; upd(); } }, 'Edit roles')),
      h('p', { class: 'hint', style: 'margin-top:0' }, 'Cues with a crew task light up that person\'s phone automatically at standby and GO. Use these buttons for anything not in the cue list.'),
      h('div', { class: 'items' }, C.crew.roles.map(r => {
        const l = C.crew.lights[r], auto = tasksFor(c, r).length > 0;
        const status = l?.state === 'standby' ? (l.acked ? 'Standing by ✓' : 'Standby sent') : auto ? (acks[r] ? `Standing by for ${cueNo(c, sh.index)} ✓ (${acks[r].name})` : `Standby for ${cueNo(c, sh.index)}, waiting`) : 'Clear';
        return h('div', { class: 'item' }, h('div', {}, h('b', {}, r), h('div', { class: 'meta' }, status)),
          h('div', { class: 'row' }, h('button', { onclick: () => ask('light', { role: r, state: 'standby' }) }, 'Stby'),
            h('button', { class: 'primary', onclick: () => ask('light', { role: r, state: 'go' }) }, 'GO'),
            h('button', { onclick: () => ask('light', { role: r, state: null }) }, 'Off')));
      })),
      h('div', { class: 'big-label' }, 'Screens for the company (open on their phones or a TV)'),
      h('div', { class: 'links' },
        h('div', {}, 'Crew phones (run sheet, cue light, calls): ', h('a', { href: '/crew.html', target: '_blank' }, `${base}/crew.html`)),
        h('div', {}, 'Front of house manager: ', h('a', { href: '/foh.html', target: '_blank' }, `${base}/foh.html`)),
        h('div', {}, 'Lobby TV countdown: ', h('a', { href: '/lobby.html', target: '_blank' }, `${base}/lobby.html`))),
      h('p', { class: 'hint' }, 'Crew tasks for each cue are set in the full controls: Show → Edit cues → a cue → Crew tasks.'));
  };
  return { el: wrap, upd };
}

function countPanel() {
  const cur = h('div', {});
  const time = h('input', { type: 'time', style: 'width:140px' });
  const mins = h('input', { inputmode: 'numeric', placeholder: 'min', style: 'width:80px' });
  const label = h('input', { placeholder: 'Words above the countdown', style: 'flex:1' });
  const lobby = h('input', { placeholder: 'e.g. Latecomers will be admitted at a suitable break', style: 'flex:1' });
  const start = (lbl, target, done = 'Please take your seats') => ask('countdown', { label: lbl, target, done });
  const inMin = m => now() + m * 60e3;
  const atTime = () => {
    if (!time.value) return toast('Pick a time first');
    const [hh, mm] = time.value.split(':').map(Number), d = new Date(now()); d.setHours(hh, mm, 0, 0);
    if (d.getTime() < now() - 60e3) d.setDate(d.getDate() + 1);
    start(label.value.trim() || 'The performance begins in', d.getTime());
  };
  const gen = panelGen;
  on('tick', () => {
    if (gen !== panelGen) return;
    const cd = C.crew?.countdown;
    fill(cur, cd ? h('div', {}, h('div', { class: 'dim' }, cd.label), h('div', { style: 'font-size:56px;font-weight:900;font-variant-numeric:tabular-nums' }, cd.target > now() ? fmtCount(cd.target - now()) : '0:00'),
      h('div', { class: 'dim' }, `until ${clock(cd.target)}`)) : h('p', { class: 'dim' }, 'No countdown running. The lobby screen shows the show name and the time.'));
  });
  return {
    el: h('div', {}, h('h3', {}, 'Countdown and lobby screen', h('button', { onclick: () => ask('countdown', { target: null }) }, 'Stop')), cur,
      h('div', { class: 'big-label' }, 'Quick start'),
      h('div', { class: 'chips' },
        h('button', { onclick: () => start('House opens in', inMin(10), 'The house is open') }, 'House opens in 10'),
        h('button', { onclick: () => start('The performance begins in', inMin(5)) }, 'Show in 5'),
        h('button', { onclick: () => start('Interval: the performance continues in', inMin(15)) }, 'Interval 15'),
        h('button', { onclick: () => start('Interval: the performance continues in', inMin(20)) }, 'Interval 20')),
      h('div', { class: 'big-label' }, 'Your own'),
      h('div', { class: 'row', style: 'align-items:center' }, label),
      h('div', { class: 'row', style: 'align-items:center;margin-top:8px' }, 'At', time, h('button', { onclick: atTime }, 'Start'), 'or in', mins,
        h('button', { onclick: () => Number(mins.value) > 0 ? start(label.value.trim() || 'Starting in', inMin(Number(mins.value))) : toast('Type the minutes first') }, 'Start')),
      h('div', { class: 'big-label' }, 'Message on the lobby screen'),
      h('div', { class: 'row' }, lobby, h('button', { onclick: () => ask('lobby', { text: lobby.value }) }, 'Show'), h('button', { onclick: () => { lobby.value = ''; ask('lobby', { text: '' }); } }, 'Clear'))),
    upd() { if (document.activeElement !== lobby) lobby.value = C.crew.lobby || ''; },
  };
}

// ---------- header + wiring ----------
function updHeader() {
  const cd = C.crew?.countdown;
  fill($('#fohStatus'), fohPill(), cd && cd.target > now() ? h('span', { class: 'pill', style: 'margin-left:6px' }, `${cd.label.replace(/:.*/, '')} ${fmtCount(cd.target - now())}`) : '');
}
on('tick', () => { $('#clock').textContent = new Date(now()).toLocaleTimeString([], { hour12: false }); updHeader(); });
let built = false;
on('init', () => {
  if (built) { updCalling(); return openPanel(panel); }
  built = true;
  fill(tmrs, timerCard('show', () => 'Show'), timerCard('act', () => C.show.timers.label || 'Act'));
  fill(root, left, right);
  updCalling(); openPanel(PANELS[panel] ? panel : 'calls');
});
on('show', () => { updCalling(); panelUpd(); });
on('crew', () => { updCalling(); panelUpd(); });
on('device', updCalling);
boot();
