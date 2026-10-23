// ---------- Scene map, rehearsal jump, second operator, show reports ----------
'use strict';
const DEPT_COLOR = { lx: '#f5b942', snd: '#4aa3ff', proj: '#b57bff', cam: '#2ec4b6', crew: '#ff7a90', other: '#9aa4b2' };
const hhmm = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const deptOf = device => {
  if (String(device).startsWith('group:')) return 'proj';
  return S.depts?.list.find(d => d.devices.includes(device))?.id || 'other';
};
const deptName = id => (id === 'crew' ? 'Crew' : S.depts?.list.find(d => d.id === id)?.name || id);
const deptActs = (cue, dept) => (cue?.actions || []).filter(a => deptOf(a.device) === dept);
const cueTitle = (c, i) => `${c.number ?? i + 1}  ${c.label}`;
S.myDept = store('myDept') || null;

onMsg('init', m => { S.depts = m.depts || { list: [], split: {} }; S.reportRecording = m.reportRecording || null; });
onMsg('depts', m => { S.depts = m.depts; (updaters.__show || []).forEach(f => f(S.show)); (updaters.__depts || []).forEach(f => f()); });
onMsg('report-status', m => { S.reportRecording = m.recording; (updaters.__report || []).forEach(f => f()); });

// ---------- Show tab: buttons and who runs what ----------
SHOW_BUTTONS.push(
  () => h('button', { class: 'always', onclick: () => { S.tab = 'map'; render(); } }, 'Scene map'),
  () => h('button', { onclick: () => jumpSheet() }, 'Jump to…'),
  () => h('button', { onclick: () => { S.tab = 'dept'; render(); } }, 'Second operator'));
STANDBY_EXTRAS.push(() => {
  const split = Object.entries(S.depts?.split || {});
  if (!split.length) return null;
  // For the cue on standby: which of its steps the second operator does instead of this GO.
  const held = d => deptActs(S.show.cues[S.show.index], d).map(actionText).join(', ');
  return h('div', { class: 'splitline' }, split.map(([d, s]) => h('span', { class: 'chip', style: `--c:${DEPT_COLOR[d]}` },
    held(d) ? `${s.by} does ${held(d)}` : `${deptName(d)}: run by ${s.by}${nextDeptCue(d, s) != null ? `, next cue ${S.show.cues[nextDeptCue(d, s)].number ?? nextDeptCue(d, s) + 1}` : ''}`)));
});
function nextDeptCue(dept, s) {
  for (let j = Math.max(0, s.index); j < S.show.cues.length; j++) if (deptActs(S.show.cues[j], dept).length) return j;
  return null;
}

// ---------- rehearsal jump ----------
function jumpSheet(index) {
  let el;
  if (index == null) {
    const scenes = []; let cur = null;
    S.show.cues.forEach((c, i) => { if (c.scene || !cur) scenes.push(cur = { name: c.scene || '', cues: [] }); cur.cues.push(i); });
    el = sheet(h('h2', {}, 'Jump to…'),
      h('p', {}, 'Pick where to go. The lights, sound, cameras and projectors are set to match, without running the cues in between.'),
      h('div', { class: 'jumplist' }, scenes.map(sc => [sc.name && h('div', { class: 'sub' }, sc.name),
        sc.cues.map(i => h('button', { class: `choice always ${i === S.show.index ? 'here' : ''}`, onclick: () => { el.remove(); jumpSheet(i); } }, h('b', {}, cueTitle(S.show.cues[i], i)),
          h('span', {}, (S.show.cues[i].actions || []).map(actionText).join(' · ') || 'No equipment')))])));
    setTimeout(() => el.querySelector('.here')?.scrollIntoView({ block: 'center' }), 0);
    return;
  }
  const c = S.show.cues[index];
  const opt = { mode: 'before', snap: true };
  const steps = h('div', { class: 'jumpsteps' }, h('div', { class: 'dim' }, 'Working out what to set…'));
  const draw = async () => {
    const p = await ask('jump-preview', { index, ...opt });
    if (p.error) return fill(steps, h('div', { class: 'bad' }, p.error));
    fill(steps, p.steps.length ? p.steps.map(s => h('div', { class: 'jstep', style: `--c:${DEPT_COLOR[s.dept] || DEPT_COLOR.other}` }, s.text)) : h('div', { class: 'dim' }, 'Nothing to set: no cue before this one uses any equipment.'),
      p.skipped.length > 0 && h('div', { class: 'dim', style: 'margin-top:6px' }, `Not repeated (do these by hand if needed): ${p.skipped.join(', ')}`));
  };
  const modeBtn = (mode, label, sub) => h('button', { class: `choice always ${opt.mode === mode ? 'primary' : ''}`, onclick: e => { opt.mode = mode; el.querySelectorAll('.modes button').forEach(b => b.classList.toggle('primary', b === e.currentTarget)); draw(); } }, h('b', {}, label), h('span', {}, sub));
  el = sheet(h('h2', {}, `Jump to cue ${c.number ?? index + 1}`), h('p', {}, c.label),
    h('div', { class: 'modes' },
      modeBtn('before', 'Ready to GO this cue', 'The stage looks as it does just before it, with this cue on standby.'),
      modeBtn('look', 'As if this cue had just run', 'The stage shows this cue, with the next one on standby.')),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: true, onchange: e => { opt.snap = e.target.checked; draw(); } }), 'Snap the lights (no fade)'),
    h('div', { class: 'sub' }, 'What will be set'), steps,
    h('button', { class: 'primary', onclick: async e => {
      e.currentTarget.disabled = true;
      const r = await ask('jump', { index, ...opt, name: screenName }, 30000);
      el.remove();
      if (r.error) return toast(r.error, 6000);
      toast(r.problems.length ? `Jumped, but: ${r.problems.join('; ')}` : `Jumped to cue ${c.number ?? index + 1}`, r.problems.length ? 8000 : 3000);
      if (S.tab !== 'show' && S.tab !== 'map') { S.tab = 'show'; render(); }
    } }, 'Jump'));
  draw();
}

// ---------- scene map ----------
NAV_PARENT.map = 'show';
let mapTiming;
VIEWS.map = () => {
  const cues = S.show.cues;
  const lanes = ['lx', 'snd', 'proj', 'cam', 'other'].filter(d => cues.some(c => deptActs(c, d).length));
  if (cues.some(c => c.crew?.length)) lanes.push('crew');
  const scenes = []; let cur = null;
  cues.forEach((c, i) => { if (c.scene || !cur) scenes.push(cur = { name: c.scene || 'Top of the show', from: i, to: i }); else cur.to = i; });
  const box = h('div', {});
  const draw = () => {
    // Where each cue sits on the timeline: from the last full show if there is one, else evenly.
    const t = mapTiming?.at || {}, known = Object.keys(t).length >= cues.length * 0.6;
    const pos = cues.map((_, i) => (known && t[i] != null ? t[i] / Math.max(1, mapTiming.length) : null));
    if (known) {
      for (let i = 0; i < cues.length; i++) if (pos[i] == null) {
        let a = i - 1; while (a >= 0 && pos[a] == null) a--;
        let b = i + 1; while (b < cues.length && pos[b] == null) b++;
        const pa = a >= 0 ? pos[a] : 0, pb = b < cues.length ? pos[b] : 1;
        pos[i] = pa + (pb - pa) * (i - a) / (b - a);
      }
    } else cues.forEach((_, i) => (pos[i] = (i + 0.5) / cues.length));
    const pct = i => `${(Math.min(1, Math.max(0, i >= cues.length ? 1 : pos[i])) * 100).toFixed(2)}%`;
    const jumpTo = i => { const row = box.querySelector(`#mrow-${i}`); row?.scrollIntoView({ block: 'center', behavior: 'smooth' }); row?.classList.add('flash'); setTimeout(() => row?.classList.remove('flash'), 1200); };
    const timeline = h('div', { class: 'card tl' },
      h('h3', {}, 'Whole show', h('span', { class: 'dim', style: 'text-transform:none;letter-spacing:0' }, known ? `Timed from the show on ${new Date(mapTiming.from).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} (${fmtDur(mapTiming.length)})` : 'Evenly spaced until a full show has been run')),
      h('div', { class: 'tl-body' },
        h('div', { class: 'tl-scenes' }, scenes.map((sc, k) => h('div', { class: `tl-scene ${k % 2 ? 'alt' : ''}`, style: `left:${pct(sc.from)};width:calc(${pct(sc.to + 1)} - ${pct(sc.from)})`, title: sc.name }, h('span', {}, sc.name))),
          h('div', { class: 'tl-now', style: `left:${pct(S.show.index)}` })),
        lanes.map(d => h('div', { class: 'tl-lane' }, h('span', { class: 'tl-name', style: `color:${DEPT_COLOR[d]}` }, deptName(d)),
          h('div', { class: 'tl-track' }, cues.map((c, i) => ((d === 'crew' ? c.crew?.length : deptActs(c, d).length)
            ? h('i', { class: i < S.show.index ? 'done' : '', style: `left:${pct(i)};background:${DEPT_COLOR[d]}`, title: cueTitle(c, i), onclick: () => jumpTo(i) }) : null)))))));
    const cell = (c, d) => (d === 'crew' ? (c.crew || []).map(x => `${x.role}: ${x.task}`) : deptActs(c, d).map(actionText));
    const table = h('div', { class: 'card' }, h('h3', {}, 'Cue by cue', h('span', { class: 'dim', style: 'text-transform:none;letter-spacing:0' }, 'Tap a cue to jump there')),
      h('div', { class: 'map', style: `--lanes:${lanes.length}` },
        h('div', { class: 'mrow head' }, h('span', {}, 'Time'), h('span', {}, 'Cue'), lanes.map(d => h('span', { style: `color:${DEPT_COLOR[d]}` }, deptName(d)))),
        cues.map((c, i) => [
          scenes.find(sc => sc.from === i && (i > 0 || c.scene)) && h('div', { class: 'mscene' }, c.scene),
          h('div', { id: `mrow-${i}`, class: `mrow ${i < S.show.index ? 'done' : ''} ${i === S.show.index ? 'next' : ''}`, onclick: () => jumpSheet(i) },
            h('span', { class: 't mono' }, known && mapTiming.at[i] != null ? fmtDur(mapTiming.at[i]).replace(/^0:/, '') : ''),
            h('span', { class: 'c' }, h('b', {}, c.number ?? i + 1), ' ', c.label, c.note ? h('small', {}, c.note) : ''),
            lanes.map(d => { const x = cell(c, d); return h('span', { class: `cell ${x.length ? '' : 'empty'}`, style: `--c:${DEPT_COLOR[d]}`, 'data-lane': deptName(d) }, x.join('\n')); }))])),
      !cues.some(c => c.scene) && h('p', { class: 'dim' }, 'Tip: give the first cue of each scene a scene name (Edit cues) to see the scenes here.'));
    fill(box, h('div', { class: 'row', style: 'margin-bottom:10px;justify-content:space-between' }, h('button', { class: 'always', onclick: () => { S.tab = 'show'; render(); } }, '← Show'),
      h('button', { onclick: () => jumpSheet() }, 'Jump to…')), timeline, table);
  };
  (updaters.__show ||= []).push(() => draw());
  draw();
  if (mapTiming === undefined) ask('report-timing').then(r => { mapTiming = r?.error ? null : r; if (S.tab === 'map') draw(); });
  return box;
};

// ---------- second operator ----------
NAV_PARENT.dept = 'show';
VIEWS.dept = () => {
  const box = h('div', {});
  let controls = null, controlsFor = null; // the department's own tab, built once (it keeps its live updates)
  const take = async (d, force) => {
    const r = await ask('dept-take', { dept: d, name: screenName, force });
    if (r.error) { if (/Take it over anyway/.test(r.error) && confirm(r.error)) return take(d, true); return toast(r.error, 5000); }
    S.myDept = store('myDept', d); S.depts = r; draw();
  };
  const draw = () => {
    const mine = S.myDept, s = mine && S.depts?.split[mine];
    if (!s) {
      const counts = Object.fromEntries((S.depts?.list || []).map(d => [d.id, S.show.cues.filter(c => deptActs(c, d.id).length).length]));
      return fill(box, h('div', { class: 'card' }, h('h3', {}, 'Second operator'),
        h('p', {}, 'Run one department from this screen, with its own GO. The main GO then leaves that department out, and you take its cues on the stage manager\'s call. Everyone else still sees the whole show.'),
        h('div', { class: 'deptpick' }, (S.depts?.list || []).filter(d => counts[d.id]).map(d => {
          const other = S.depts.split[d.id];
          return h('button', { class: 'choice', style: `--c:${DEPT_COLOR[d.id]}`, onclick: () => take(d.id, false) },
            h('b', {}, `Run ${d.name}`), h('span', {}, `${counts[d.id]} cues${other ? ` · run by ${other.by} now` : ''}`));
        })),
        h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'always', onclick: () => { S.tab = 'show'; render(); } }, '← Show'))));
    }
    const color = DEPT_COLOR[mine], cues = S.show.cues, nx = nextDeptCue(mine, s), nc = cues[nx];
    const mainNext = nextDeptCue(mine, { index: S.show.index });
    let behind = 0;
    for (let j = s.index; j < S.show.index; j++) if (deptActs(cues[j], mine).length) behind++;
    let lastGo = 0;
    const go = h('button', { class: 'deptgo', style: `--c:${color}`, disabled: nx == null, onclick: async () => {
      if (Date.now() - lastGo < 600) return; lastGo = Date.now();
      const r = await ask('dept-go', { dept: mine }); if (r.error) toast(r.error, 4000);
    } }, `${deptName(mine).toUpperCase()} GO`);
    const tabs = { lx: lxTab, snd: sndTab, proj: projTab, cam: camTab };
    if (controlsFor !== mine) { controlsFor = mine; controls = tabs[mine] ? h('div', { style: 'margin-top:10px' }, tabs[mine]()) : null; }
    fill(box,
      h('div', { class: 'deptbar', style: `--c:${color}` }, h('b', {}, `You are running ${deptName(mine).toLowerCase()}`), h('span', {}, s.by === screenName ? '' : `(as ${s.by})`),
        h('button', { class: 'always', onclick: async () => {
          if (!confirm(`Hand ${deptName(mine).toLowerCase()} back to the main GO?`)) return;
          const r = await ask('dept-release', { dept: mine, name: screenName });
          if (r.error) return toast(r.error, 5000);
          if (r.missed) toast(`${r.missed} ${deptName(mine).toLowerCase()} cue${r.missed > 1 ? 's were' : ' was'} behind the main GO and won't run.`, 6000);
          S.depts = r; S.myDept = store('myDept', ''); S.tab = 'show'; render();
        } }, 'Hand back to the main GO')),
      h('div', { class: 'showtop' },
        h('div', { class: 'standby', style: `border-color:${color}` }, h('small', { style: `color:${color}` }, 'STANDBY'),
          h('div', { class: 'lbl' }, nc ? cueTitle(nc, nx) : `No more ${deptName(mine).toLowerCase()} cues`),
          nc?.note && h('div', { class: 'cue-note' }, nc.note),
          h('div', { class: 'acts' }, nc ? deptActs(nc, mine).map(actionText).join(' · ') : ''),
          h('div', { class: `deptpos ${behind ? 'bad' : ''}` }, `Main show: standby on ${cues[S.show.index] ? cueTitle(cues[S.show.index], S.show.index) : 'the end'}.`,
            behind ? ` You are ${behind} ${deptName(mine).toLowerCase()} cue${behind > 1 ? 's' : ''} behind.` : nx != null && mainNext != null && nx < mainNext ? '' : '')),
        go),
      h('div', { class: 'card' }, h('h3', {}, `${deptName(mine)} cues`),
        h('div', { class: 'cuelist' }, cues.map((c, i) => deptActs(c, mine).length ? h('div', { class: `cue ${i < s.index ? 'done' : ''} ${i === nx ? 'next' : ''}` },
          h('div', { class: 'n' }, c.number ?? i + 1),
          h('div', {}, h('div', {}, c.label), h('div', { class: 'tags' }, deptActs(c, mine).map(actionText).join(' · '))),
          h('div', { class: 'row' }, h('button', { onclick: () => ask('dept-standby', { dept: mine, index: i }) }, 'Stby'))) : null))),
      controls);
    setTimeout(() => { const n = box.querySelector('.cuelist .next'); if (n) n.parentElement.scrollTop = Math.max(0, n.offsetTop - n.parentElement.offsetTop - 60); });
  };
  (updaters.__show ||= []).push(() => draw());
  (updaters.__depts ||= []).push(() => draw());
  draw();
  return box;
};

// ---------- System tab: show reports ----------
SYS_CARDS.push(() => {
  const body = h('div', {}, h('div', { class: 'dim' }, 'Loading…'));
  const status = h('p', {});
  const drawStatus = () => {
    const r = S.reportRecording;
    status.className = r?.problems ? 'bad' : '';
    status.textContent = !r ? 'Nothing recorded yet. The next report starts with the first GO.'
      : `Recording since ${hhmm(r.since)}: ${r.cuesRun} of ${r.total} cues, ${r.problems ? `${r.problems} problem${r.problems > 1 ? 's' : ''}` : 'no problems'}.${r.sendAt ? ` The report is made at ${hhmm(r.sendAt)}.` : ''}`;
  };
  (updaters.__report ||= []).push(drawStatus);
  const draw = r => {
    if (r.error) return fill(body, h('div', { class: 'bad' }, r.error));
    const st = r.settings;
    const set = async patch => draw({ ...r, settings: await ask('reports-set', patch) });
    drawStatus();
    fill(body,
      h('p', { class: 'dim' }, 'A report of every cue, problem, emergency stop and crew note, made a few minutes after the last cue. It is saved as a PDF in the "Show reports" folder.'),
      status,
      h('div', { class: 'row' }, h('button', { onclick: async () => { const x = await ask('report-now'); if (x.error) return toast(x.error, 5000); toast('Report made'); reportSheet(x.name); ask('reports-get').then(draw); } }, 'Make the report now')),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: st.phone && r.phoneReady, disabled: !r.phoneReady, onchange: e => set({ phone: e.target.checked }) }),
        r.phoneReady ? 'Send it to my phone after the show' : 'Send it to my phone (turn on phone alerts in Equipment health first)'),
      h('div', { class: 'row', style: 'align-items:center' }, h('span', { class: 'dim' }, 'Make it'),
        h('select', { onchange: e => set({ afterMin: Number(e.target.value) }) }, [0, 2, 5, 10, 15, 30].map(n => h('option', { value: n, selected: n === st.afterMin }, n ? `${n} minutes` : 'right away'))),
        h('span', { class: 'dim' }, 'after the last cue, on'),
        h('select', { onchange: e => set({ paper: e.target.value }) }, h('option', { value: 'letter', selected: st.paper !== 'a4' }, 'Letter'), h('option', { value: 'a4', selected: st.paper === 'a4' }, 'A4')), h('span', { class: 'dim' }, 'paper')),
      r.list.length ? h('div', { class: 'reports' }, r.list.slice(0, 12).map(x => h('button', { class: 'rep always', onclick: () => reportSheet(x.name) },
        h('b', {}, `${new Date(x.first).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${hhmm(x.first)}`),
        h('span', {}, `${x.kind}${x.mode === 'practice' ? ' (practice)' : ''} · ${x.cuesRun} of ${x.total} cues`),
        h('span', { class: x.problems ? 'bad' : 'good' }, x.problems ? `${x.problems} problem${x.problems > 1 ? 's' : ''}` : 'no problems'))))
        : h('p', { class: 'dim' }, 'No reports yet.'));
  };
  ask('reports-get').then(draw);
  return h('div', { class: 'card hcard' }, h('h3', {}, 'Show reports'), body);
});
async function reportSheet(name) {
  const r = await ask('report-link', { name });
  if (r.error) return toast(r.error, 5000);
  const s = r.summary || {};
  const msg = h('div', { class: 'dim' });
  sheet(h('h2', {}, s.kind || 'Show report'), h('p', {}, `${r.show} · ${new Date(s.first).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}, ${hhmm(s.first)} to ${hhmm(s.last)}`),
    h('div', { class: 'kv' }, h('b', {}, 'Running time'), h('span', {}, fmtDur(s.last - s.first)), h('b', {}, 'Cues run'), h('span', {}, `${s.cuesRun} of ${s.total}`),
      s.missed?.length ? [h('b', {}, 'Not run'), h('span', {}, s.missed.join(', '))] : null,
      h('b', {}, 'Problems'), h('span', { class: s.problems?.length ? 'bad' : 'good' }, s.problems?.length ? String(s.problems.length) : 'None')),
    s.problems?.length ? h('ul', { class: 'plain' }, s.problems.slice(0, 8).map(p => h('li', {}, `${hhmm(p.at)} ${p.text}`))) : null,
    h('a', { class: 'btnlink primary', href: r.url, target: '_blank', rel: 'noopener' }, 'Open the PDF'),
    h('button', { onclick: async () => { msg.textContent = 'Sending…'; const x = await ask('report-send', { name }, 40000); msg.textContent = x.error || x.detail; } }, 'Send to my phone'), msg);
}
