// ---------- Mics: mic plot, pack status, mic check, level meters, alerts ----------
'use strict';

// ----- level meters (from the mixer, about 10 a second) -----
const meterPos = db => (db == null ? 0 : Math.max(0, Math.min(1, (db + 60) / 60))); // -60..0 dBFS
// A meter bar for one mixer input. onLevel(db) is also called with every new level.
function meterBar(devId, ch, { horizontal = false, onLevel } = {}) {
  const cover = h('div', { class: 'cover' }), pk = h('div', { class: 'pk' });
  const el = h('div', { class: `meter${horizontal ? ' h' : ''}` }, cover, pk);
  let peak = 0, peakAt = 0;
  (updaters.__meters ||= []).push(dev => {
    if (dev !== devId) return;
    const db = S.meters?.[devId]?.[typeof ch === 'function' ? ch() : ch], p = meterPos(db), now = Date.now();
    if (p >= peak || now - peakAt > 1500) { peak = p; peakAt = now; }
    const gone = `${(1 - p) * 100}%`, at = `${peak * 100}%`;
    if (horizontal) { cover.style.width = gone; pk.style.left = at; } else { cover.style.height = gone; pk.style.bottom = at; }
    onLevel?.(db);
  });
  return el;
}
function meterNote(devId) {
  const n = h('span', { class: 'dim', style: 'text-transform:none;letter-spacing:0' });
  onDevice(devId, d => (n.textContent = { unsupported: 'meters not available from this mixer', waiting: 'meters: waiting…', off: '' }[d.state.meters] || ''));
  return n;
}

// ----- alerts bar: possible feedback, low batteries. Shown on every screen until dismissed. -----
const seenAlerts = new Set();
function renderAlerts() {
  const bar = $('#alertBar'), list = S.alerts || [];
  if (list.some(a => !seenAlerts.has(`${a.key}@${a.at}`))) navigator.vibrate?.([200, 100, 200]);
  list.forEach(a => seenAlerts.add(`${a.key}@${a.at}`));
  bar.hidden = !list.length;
  const dismiss = a => send({ t: 'alert-dismiss', key: a.key });
  bar.replaceChildren(...list.slice(0, 3).map(a => h('div', { class: `alert ${a.kind}` },
    h('b', {}, a.title), h('span', {}, `${a.detail || ''} · ${new Date(a.at).toLocaleTimeString([], { hour12: false })}`),
    a.action && h('button', { class: 'danger always', onclick: () => { cmd(a.action.device, a.action.cmd, a.action.args); dismiss(a); } }, a.action.label),
    h('button', { class: 'always', onclick: () => dismiss(a) }, 'Dismiss'))),
  list.length > 3 ? h('div', { class: 'dim' }, `and ${list.length - 3} more`) : '');
}

// ----- shared bits -----
const micPlan = () => S.devices.mics?.state || { packs: [], scenes: [], status: {} };
const wearer = (p, sceneId = micPlan().current) => micPlan().scenes.find(s => s.id === sceneId)?.wearers?.[p.id] || p.actor || '';
const fmtMin = m => (m == null ? '' : m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m} min`);
function battery(s) {
  if (s.receiverOnline == null) return h('span', { class: 'dim' }, 'no receiver set');
  if (!s.receiverOnline) return h('span', { class: 'bad' }, 'receiver not connected');
  if (!s.tx) return h('span', { class: 'bad' }, 'pack off or not linked');
  if (s.batteryBars == null) return h('span', { class: 'dim' }, 'battery —');
  return h('span', { class: `batt ${s.lowBattery ? 'low' : ''}`, title: `${s.batteryBars} of 5 bars` },
    h('span', { class: 'bars' }, [1, 2, 3, 4, 5].map(i => h('i', { class: i <= s.batteryBars ? 'f' : '' }))),
    s.batteryMinutes != null ? ` ${fmtMin(s.batteryMinutes)}` : s.batteryPercent != null ? ` ${s.batteryPercent}%` : '');
}
const rfText = s => (s.tx && s.rf != null ? `RF ${s.rf} dBm` : '');
const packMixerId = p => micPlan().status[p.id]?.mixer || p.mixer || Object.values(S.devices).find(d => d.type === 'yamaha-tf')?.id;

function micsTab() {
  const mp = micPlan();
  S.micView ||= 'plot';
  const nav = h('div', { class: 'row', style: 'margin-bottom:10px' },
    [['plot', 'Mic plot'], ['check', 'Mic check'], ['edit', 'Edit packs & scenes']].map(([v, l]) =>
      h('button', { class: `${S.micView === v ? 'on' : ''} ${v === 'edit' ? '' : 'always'}`, onclick: () => { if (S.micView === 'edit' && S.micEdit?.dirty && !confirm('Leave without saving the mic plot?')) return; S.micEdit = null; S.micView = v; render(); } }, l)));
  if (S.micView === 'edit') return h('div', {}, nav, micEditor());
  if (!mp.packs.length) return h('div', {}, nav, h('div', { class: 'card' }, h('p', {}, 'No radio mics set up yet. Add your packs, who wears them and which mixer channel each one is on, then the scenes they are live in.'),
    h('button', { class: 'primary', onclick: () => { S.micView = 'edit'; render(); } }, 'Set up mics')));
  return h('div', {}, nav, S.micView === 'check' ? micCheck() : micPlot());
}

// ----- Mic plot: scene buttons + a card per pack -----
function micPlot() {
  const cur = h('div', { class: 'scenecur' }), sum = h('div', { class: 'dim' });
  const scenes = h('div', { class: 'presets scenes' });
  const cards = micPlan().packs.map(p => {
    const who = h('div', { class: 'who' }), ch = h('div', { class: 'dim' }), btn = h('button', {}), state = h('span', { class: 'pill' });
    const batt = h('div', { class: 'packinfo' }), warn = h('div', { class: 'warnline' });
    const card = h('div', { class: 'card pack' },
      h('div', { class: 'packhead' }, h('div', {}, h('b', {}, p.name), ch), state),
      who, meterBar(packMixerId(p), p.channel, { horizontal: true }), batt, warn, btn);
    card.update = () => {
      const s = micPlan().status[p.id] || {}, sc = micPlan().scenes.find(x => x.id === micPlan().current);
      who.textContent = wearer(p) || '—';
      ch.textContent = p.channel == null ? 'no mixer channel' : `ch ${p.channel + 1}${s.channelName ? ` · ${s.channelName}` : ''}`;
      state.textContent = s.on == null ? '—' : s.on ? 'LIVE' : 'OFF'; state.className = `pill ${s.on ? 'ok' : s.on === false ? 'off' : ''}`;
      batt.replaceChildren(battery(s), h('span', { class: 'dim' }, rfText(s)));
      const planned = sc ? (sc.live || []).includes(p.id) : null;
      warn.textContent = planned != null && s.on != null && planned !== s.on ? `⚠ ${sc.name} has this mic ${planned ? 'live' : 'off'}` : !s.mixerOnline && p.channel != null ? '⚠ mixer not connected' : '';
      btn.textContent = s.on ? 'Turn off' : 'Turn on';
      btn.onclick = () => cmd('mics', 'pack', { pack: p.id, on: !s.on });
      card.classList.toggle('lowbatt', !!s.lowBattery); card.classList.toggle('live', !!s.on);
    };
    return card;
  });
  onDevice('mics', d => {
    const mp = d.state, sc = mp.scenes.find(x => x.id === mp.current), st = Object.values(mp.status);
    cur.replaceChildren(h('small', {}, 'MIC SCENE'), h('div', { class: 'lbl' }, sc ? sc.name : 'None recalled yet'));
    sum.textContent = [`${st.filter(s => s.on).length} live`, st.some(s => s.lowBattery) && `${st.filter(s => s.lowBattery).length} low battery`,
      st.some(s => s.receiverOnline && !s.tx) && `${st.filter(s => s.receiverOnline && !s.tx).length} pack${st.filter(s => s.receiverOnline && !s.tx).length > 1 ? 's' : ''} off`].filter(Boolean).join(' · ');
    scenes.replaceChildren(...mp.scenes.map(x => h('button', { class: x.id === mp.current ? 'cur' : '', onclick: () => confirm(`Switch mics to "${x.name}"?\n\n${(x.live || []).length} live. Every other pack is turned off on the mixer.`) && cmd('mics', 'scene', { scene: x.id }) }, x.name)));
    cards.forEach(c => c.update());
  });
  // the desk's channel names and on/off come from the mixer, so redraw when it changes too
  Object.values(S.devices).filter(d => d.type === 'yamaha-tf').forEach(d => onDevice(d.id, () => cards.forEach(c => c.update())));
  return h('div', {}, h('div', { class: 'card', style: 'margin-bottom:10px' }, cur, sum, scenes), h('div', { class: 'packs' }, cards));
}

// ----- Mic check: one pack at a time, with a big meter; results kept on this iPad -----
function micCheck() {
  const packs = micPlan().packs;
  const mc = S.micCheck ||= (() => { try { return JSON.parse(localStorage.getItem('micCheck')) || null; } catch { return null; } })() || { i: 0, results: {}, heard: {} };
  mc.i = Math.min(mc.i, packs.length - 1);
  const keep = () => { try { localStorage.setItem('micCheck', JSON.stringify(mc)); } catch { /* private mode */ } };
  const p = packs[mc.i];
  const heard = h('div', { class: 'heard' });
  const showHeard = () => { heard.textContent = mc.heard[p.id] ? '✓ Heard on the desk' : 'Waiting to hear this mic…'; heard.className = `heard ${mc.heard[p.id] ? 'yes' : ''}`; };
  showHeard();
  const big = meterBar(packMixerId(p), p.channel, { horizontal: true, onLevel: db => { if (db != null && db > -40 && !mc.heard[p.id]) { mc.heard[p.id] = true; keep(); showHeard(); } } });
  big.classList.add('big');
  const info = h('div', { class: 'packinfo' }), deskBtn = h('div');
  onDevice('mics', d => {
    const s = d.state.status[p.id] || {};
    info.replaceChildren(battery(s), h('span', { class: 'dim' }, rfText(s)));
    deskBtn.replaceChildren(s.on === false ? h('button', { onclick: () => cmd('mics', 'pack', { pack: p.id, on: true }) }, 'Mic is off on the desk: turn it on') : '');
  });
  const go = d => { mc.i = Math.max(0, Math.min(packs.length - 1, mc.i + d)); keep(); render(); };
  const mark = r => { mc.results[p.id] = r; keep(); if (mc.i < packs.length - 1) go(1); else render(); };
  const done = packs.filter(x => mc.results[x.id]).length;
  const s0 = micPlan().status;
  return h('div', { class: 'grid' },
    h('div', { class: 'card check' },
      h('h3', {}, `Mic ${mc.i + 1} of ${packs.length}`, h('span', {}, `${done} checked`)),
      h('div', { class: 'checkname' }, wearer(p) || p.name), h('div', { class: 'dim' }, `${p.name}${p.channel != null ? ` · mixer ch ${p.channel + 1}` : ''}`),
      big, heard, info, deskBtn,
      h('div', { class: 'checkbtns' },
        h('button', { class: 'danger big', onclick: () => mark('problem') }, '✗ Problem'),
        h('button', { class: 'primary big', onclick: () => mark('good') }, '✓ Good'),
        h('button', { disabled: mc.i === 0, onclick: () => go(-1) }, '◀ Back'),
        h('button', { disabled: mc.i === packs.length - 1, onclick: () => go(1) }, 'Skip ▶'))),
    h('div', { class: 'card' }, h('h3', {}, 'Results', h('button', { onclick: () => { if (confirm('Start the mic check again?')) { S.micCheck = { i: 0, results: {}, heard: {} }; try { localStorage.removeItem('micCheck'); } catch { /* private mode */ } render(); } } }, 'Start again')),
      h('div', { class: 'checklist' }, packs.map((x, i) => {
        const r = mc.results[x.id], s = s0[x.id] || {};
        return h('div', { class: `ci ${i === mc.i ? 'cur' : ''}`, onclick: () => { mc.i = i; keep(); render(); } },
          h('span', { class: `res ${r || ''}` }, r === 'good' ? '✓' : r === 'problem' ? '✗' : mc.heard[x.id] ? '•' : '○'),
          h('span', {}, h('b', {}, wearer(x) || x.name), ` ${x.name}`), s.lowBattery ? h('span', { class: 'bad' }, 'low battery') : s.receiverOnline && !s.tx ? h('span', { class: 'bad' }, 'pack off') : '');
      }))));
}

// ----- Editor: packs (who, mixer channel, receiver) and scenes (which packs are live, covers) -----
function micEditor() {
  const ed = S.micEdit ||= { draft: JSON.parse(JSON.stringify({ packs: micPlan().packs, scenes: micPlan().scenes, lowBatteryBars: micPlan().lowBatteryBars ?? 1 })), open: null, dirty: false };
  const d = ed.draft;
  const wrap = h('div', {});
  const dirty = () => { ed.dirty = true; };
  const redraw = () => { dirty(); draw(); };
  const tf = Object.values(S.devices).filter(x => x.type === 'yamaha-tf');
  const rxs = Object.values(S.devices).filter(x => x.type === 'shure');
  const nextId = list => { let n = list.length + 1; while (list.some(x => x.id === String(n))) n++; return String(n); };
  const save = async () => {
    const r = await new Promise(res => { const id = ++cmdSeq; pending[id] = res; send({ t: 'save-mics', id, mics: d }); });
    if (r === true) { toast('Mic plot saved'); S.micEdit = null; S.micView = 'plot'; render(); } else toast(`Not saved: ${r || 'no answer from Show Control'}`, 6000);
  };
  const saveBar = () => h('div', { class: 'sticky-save' },
    h('button', { onclick: () => { if (!ed.dirty || confirm('Discard your changes to the mic plot?')) { S.micEdit = null; S.micView = 'plot'; render(); } } }, 'Cancel'),
    h('button', { class: 'primary', onclick: save }, 'Save mic plot'));
  const sel = (val, opts, onchange) => h('select', { onchange: e => { onchange(e.target.value); dirty(); } }, opts.map(([v, l]) => h('option', { value: v, selected: String(v) === String(val ?? '') }, l)));

  function draw() {
    if (ed.open != null) { // one scene
      const sc = d.scenes[ed.open];
      sc.live ||= []; sc.wearers ||= {};
      wrap.replaceChildren(h('div', { class: 'card form' },
        h('h3', {}, 'Scene', h('button', { onclick: () => { ed.open = null; draw(); } }, '← All scenes')),
        h('label', {}, 'Name', h('input', { value: sc.name, onchange: e => { sc.name = e.target.value; dirty(); } })),
        h('div', { class: 'row' }, h('button', { onclick: () => { sc.live = d.packs.map(p => p.id); redraw(); } }, 'All live'), h('button', { onclick: () => { sc.live = []; redraw(); } }, 'All off')),
        h('div', { class: 'sub' }, 'Tap a pack to make it live in this scene. Type a name only when someone else wears it (a cover or a swap).'),
        d.packs.map(p => {
          const on = sc.live.includes(p.id);
          return h('div', { class: 'scenepack' },
            h('button', { class: on ? 'on' : '', onclick: () => { sc.live = on ? sc.live.filter(x => x !== p.id) : [...sc.live, p.id]; redraw(); } }, `${on ? 'LIVE' : 'off'} · ${p.name}`),
            h('input', { value: sc.wearers[p.id] || '', placeholder: p.actor || 'Worn by', onchange: e => { if (e.target.value.trim()) sc.wearers[p.id] = e.target.value.trim(); else delete sc.wearers[p.id]; dirty(); } }));
        })), saveBar());
      return;
    }
    wrap.replaceChildren(
      h('div', { class: 'card form' }, h('h3', {}, 'Packs', h('button', { onclick: () => { const id = nextId(d.packs); d.packs.push({ id, name: `Pack ${id}`, actor: '', ...(tf[0] ? { mixer: tf[0].id, channel: d.packs.length } : {}) }); redraw(); } }, '+ Add pack')),
        d.packs.length ? '' : h('p', { class: 'dim' }, 'No packs yet.'),
        d.packs.map((p, i) => {
          const mixer = S.devices[p.mixer] || tf[0], rx = S.devices[p.receiver];
          return h('div', { class: 'act' },
            h('label', {}, 'Pack', h('input', { value: p.name, onchange: e => { p.name = e.target.value; dirty(); } })),
            h('label', {}, 'Worn by', h('input', { value: p.actor || '', placeholder: 'Actor', onchange: e => { p.actor = e.target.value; dirty(); } })),
            h('label', {}, 'Mixer channel', sel(p.channel, [['', 'None'], ...(mixer?.state.channels || []).map((c, j) => [j, `${j + 1} · ${c.name}`])], v => { if (v === '') delete p.channel; else { p.channel = Number(v); p.mixer = mixer.id; } })),
            h('label', {}, 'Receiver', sel(p.receiver, [['', 'None'], ...rxs.map(r => [r.id, r.name])], v => { if (v) { p.receiver = v; p.rxChannel ||= 1; } else { delete p.receiver; delete p.rxChannel; } draw(); })),
            rx && h('label', {}, 'Receiver channel', sel(p.rxChannel, rx.state.channels.map(c => [c.n, `${c.n} · ${c.name}`]), v => { p.rxChannel = Number(v); })),
            h('div', { class: 'tools' },
              i > 0 && h('button', { onclick: () => { [d.packs[i - 1], d.packs[i]] = [d.packs[i], d.packs[i - 1]]; redraw(); } }, '↑'),
              h('button', { class: 'danger', onclick: () => { if (confirm(`Remove ${p.name}?`)) { d.packs.splice(i, 1); d.scenes.forEach(s => { s.live = (s.live || []).filter(x => x !== p.id); if (s.wearers) delete s.wearers[p.id]; }); redraw(); } } }, 'Remove')));
        }),
        rxs.length ? '' : h('p', { class: 'hint' }, 'To see batteries and signal, add your wireless receivers on System > Equipment setup.'),
        h('label', {}, 'Warn me when a pack battery is down to', sel(d.lowBatteryBars, [[0, 'Empty'], [1, '1 bar'], [2, '2 bars'], [3, '3 bars']], v => { d.lowBatteryBars = Number(v); }))),
      h('div', { class: 'card', style: 'margin-top:10px' }, h('h3', {}, 'Scenes', h('button', { onclick: () => { d.scenes.push({ id: `s${nextId(d.scenes)}`, name: `Scene ${d.scenes.length + 1}`, live: [] }); ed.open = d.scenes.length - 1; redraw(); } }, '+ New scene')),
        d.scenes.length ? d.scenes.map((sc, i) => h('div', { class: 'ed-cue' },
          h('div', { class: 'n' }, i + 1),
          h('div', {}, h('div', {}, sc.name), h('div', { class: 'acts' }, (sc.live || []).length ? (sc.live || []).map(id => d.packs.find(p => p.id === id)).filter(Boolean).map(p => sc.wearers?.[p.id] || p.actor || p.name).join(', ') : 'All mics off')),
          h('div', { class: 'row' },
            h('button', { onclick: () => { ed.open = i; draw(); } }, 'Edit'),
            i > 0 && h('button', { onclick: () => { [d.scenes[i - 1], d.scenes[i]] = [d.scenes[i], d.scenes[i - 1]]; redraw(); } }, '↑'),
            h('button', { onclick: () => { d.scenes.splice(i + 1, 0, { ...JSON.parse(JSON.stringify(sc)), id: `s${nextId(d.scenes)}`, name: `${sc.name} (copy)` }); redraw(); } }, 'Copy'),
            h('button', { class: 'danger', onclick: () => confirm(`Delete scene "${sc.name}"? Cues that switch to it will stop working.`) && (d.scenes.splice(i, 1), redraw()) }, 'Delete'))))
          : h('p', { class: 'dim' }, 'No scenes yet. A scene says which mics are live, e.g. "1-2 Duet".'),
        h('div', { class: 'note' }, 'To switch mics with the show, add "Switch mics to scene" to a cue in Edit cues.')),
      saveBar());
  }
  draw();
  return wrap;
}

// ----- cue editor: "Mics" steps -----
CATALOG.mics = { scene: [['scene', 'pick:micScene', '', 'Mic scene']], pack: [['pack', 'pick:micPack', '', 'Pack'], ['on', 'bool:On|Off', true, 'Set to']] };
Object.assign(CMD_LABEL, { 'mics.scene': 'Switch mics to scene', 'mics.pack': 'One mic on/off' });
PICKERS.micScene = () => micPlan().scenes.map(s => ({ value: s.id, label: s.name }));
PICKERS.micPack = () => micPlan().packs.map(p => ({ value: p.id, label: `${p.name}${p.actor ? ` (${p.actor})` : ''}` }));
ACTION_TEXT.mics = a => {
  const x = a.args || {};
  if (a.cmd === 'scene') return `Mics: ${micPlan().scenes.find(s => s.id === String(x.scene))?.name || x.scene}`;
  if (a.cmd === 'pack') return `Mics: ${micPlan().packs.find(p => p.id === String(x.pack))?.name || x.pack} ${x.on ? 'on' : 'off'}`;
  return `Mics ${a.cmd}`;
};
