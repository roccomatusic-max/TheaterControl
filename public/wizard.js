// ---------- Guided set-up: first time with a new venue, one step at a time ----------
// 1 show name and PIN · 2 this computer on the network · 3 find and pick the equipment
// 4 each piece of equipment in turn: settings, how to set it up, Test · 5 go live
// Uses the same equipment list, tests and save as the Setup screen (setup.js).
'use strict';

const WIZ_STEPS = ['Welcome', 'Network', 'Your equipment', 'Set up each one', 'Finish'];

function wizardTab() {
  const loading = setupLoading();
  if (loading) return loading;
  const st = S.setup;
  const w = S.wiz ||= { step: 0, dev: 0 };
  const go = step => { w.step = step; render(); $('#main').scrollTop = 0; };
  const leave = () => { localStorage.setItem('wizardSeen', '1'); S.wiz = null; S.tab = 'setup'; render(); };
  const wrap = h('div', { class: 'setup wizard' });
  wrap.append(h('ol', { class: 'wizsteps' }, WIZ_STEPS.map((s, i) => h('li', { class: i === w.step ? 'on' : i < w.step ? 'done' : '' },
    h('button', { class: 'always', disabled: i > w.step, onclick: () => go(i) }, s)))));
  const nav = (back, next, nextLabel = 'Next ▶', extra) => h('div', { class: 'sticky-save' },
    h('button', { class: 'always', onclick: back }, back === leave ? 'Not now' : '◀ Back'), extra, next && h('button', { class: 'primary always', onclick: next }, nextLabel));
  const nets = st.networks || [];

  if (w.step === 0) {
    wrap.append(h('div', { class: 'card' },
      h('h2', {}, 'Let\'s set up your show'),
      h('p', {}, 'This takes you through connecting your real lighting, sound, playback, cameras and projectors, one at a time, with what to press on each one. It takes about 10 to 20 minutes.'),
      h('p', {}, st.mode === 'practice' ? 'Nothing real is controlled until you tap Go live at the very end, so you can stop at any point. Everything you type is kept.' : 'Changes are saved at the end.'),
      h('div', { class: 'form two' },
        h('label', {}, 'What is the show called?', h('input', { value: st.name || '', oninput: e => { st.name = e.target.value; st.dirty = true; } })),
        h('label', {}, 'PIN for iPads and phones (optional)', h('input', { inputmode: 'numeric', autocomplete: 'off', value: st.pin || '', placeholder: 'none', oninput: e => { st.pin = e.target.value.trim(); st.dirty = true; } }))),
      h('p', { class: 'hint' }, 'The PIN stops anyone else on the Wi-Fi from running your show. Up to 12 letters or numbers.')),
    nav(leave, () => go(1), 'Start ▶'));
  } else if (w.step === 1) {
    wrap.append(h('div', { class: 'card' },
      h('h2', {}, 'This computer on the network'),
      nets.length
        ? [h('p', {}, 'Show Control reaches your equipment through this computer\'s network connection:'),
          h('div', { class: 'kv' }, nets.map(n => [h('b', { class: 'mono' }, n.address), h('span', {}, `${n.name}, mask ${n.netmask}`)])),
          h('p', {}, `Every piece of equipment needs its own fixed address that starts the same way (${samePart(nets[0])}), with subnet mask ${nets[0].netmask}. Write a list as you go, so no two things share an address.`)]
        : h('p', { class: 'warnline' }, 'This computer is not on a network yet. Plug it into the show network switch (or join the show Wi-Fi), then tap Check again.'),
      h('details', {}, h('summary', {}, 'Using our suggested plan?'),
        h('p', { class: 'hint' }, 'Show network 10.101.x.x, mask 255.255.0.0, no gateway. This computer 10.101.50.5, QLab 10.101.50.10, sound desk 10.101.50.20, cameras 10.101.60.11 and up, projectors 10.101.60.31 and up, Eos console 10.101.100.101 (its factory address).'))),
    nav(() => go(0), () => go(2), 'Next ▶', h('button', { class: 'always', onclick: () => { S.setup = null; render(); } }, 'Check again')));
  } else if (w.step === 2) {
    if (!st.finding && nets.length) { st.finding = { running: true }; setTimeout(() => runDiscover(st)); }
    wrap.append(h('div', { class: 'card' },
      h('h2', {}, 'What equipment do you have?'),
      h('p', {}, 'Show Control is looking for equipment on the network. Add what it finds, and anything else from the list. Remove anything you don\'t have.'),
      st.devices.length ? h('div', { class: 'wizlist' }, st.devices.map((d, i) => h('div', { class: 'foundrow' },
        h('div', {}, h('b', {}, d.name), h('div', { class: 'hint', style: 'margin:0' }, `${kindFor(st, d).label}${d.host ? ` · ${d.host}` : ''}`)),
        h('button', { class: 'danger', onclick: () => { st.devices.splice(i, 1); st.dirty = true; redrawKeepScroll(); } }, 'Remove'))))
        : h('p', { class: 'hint' }, 'Nothing added yet.'),
      st.mode === 'practice' && st.devices.length > 0 && !st.devices.some(d => d.host) && h('p', { class: 'hint' }, 'This list starts with the pretend equipment from practice mode, so the practice cues keep working. Remove what you don\'t have.')),
    foundCard(st),
    st.picking ? picker(st, p => { addDevice(st, p); st.picking = false; redrawKeepScroll(); })
      : h('div', { class: 'card row' }, h('button', { class: 'primary always', onclick: () => { st.picking = true; redrawKeepScroll(); } }, '+ Add from the list')),
    nav(() => go(1), () => { if (!st.devices.length) return toast('Add at least one piece of equipment', 4000); w.dev = 0; go(3); }));
  } else if (w.step === 3) {
    const i = Math.min(w.dev, st.devices.length - 1), d = st.devices[i];
    if (!d) { go(2); return wrap; }
    st.help[d.id] ??= true;
    wrap.append(h('div', { class: 'card' }, h('h2', {}, `${i + 1} of ${st.devices.length}: ${d.name}`),
      h('p', { class: 'hint', style: 'margin:0' }, 'Follow the steps on the equipment itself, type its address here, then tap Test. If it isn\'t ready yet, skip it and come back later from System > Equipment setup.')),
    deviceCard(st, d, i, { open: true }));
    const next = () => { if (i + 1 < st.devices.length) { w.dev = i + 1; render(); $('#main').scrollTop = 0; } else go(4); };
    wrap.append(nav(() => { if (i > 0) { w.dev = i - 1; render(); } else go(2); }, next, st.tests[d.id]?.ok ? 'Next ▶' : 'Skip for now ▶'));
  } else {
    const rows = st.devices.map(d => {
      const t = st.tests[d.id], k = kindFor(st, d);
      const ok = t?.ok, has = d.host || k.addressOptional;
      return h('div', { class: 'foundrow' }, h('div', {}, h('b', {}, d.name), h('div', { class: 'hint', style: 'margin:0' }, `${k.label}${d.host ? ` · ${d.host}` : ''}`)),
        h('span', { class: ok ? 'good' : 'bad' }, !has ? 'No address: left out' : ok ? `✓ ${t.oneWay ? 'ready' : 'answered'}` : t ? '✗ did not answer' : 'not tested'));
    });
    const ready = st.devices.filter(d => st.tests[d.id]?.ok).length;
    const done = async action => { if (await saveSetupAs(st, action)) { localStorage.setItem('wizardSeen', '1'); S.wiz = null; if (!st.restarting) { S.setup = null; S.tab = 'sys'; render(); } } };
    wrap.append(h('div', { class: 'card' }, h('h2', {}, 'All set'),
      h('p', {}, `${ready} of ${st.devices.length} answered the test.${ready < st.devices.length ? ' The rest can be finished later from System > Equipment setup: cue steps that use them are skipped until then.' : ''}`),
      h('div', { class: 'results found' }, rows)),
    nav(() => { w.dev = st.devices.length - 1; go(3); }, null, '', h('span', { style: 'display:contents' },
      st.mode === 'practice' && h('button', { class: 'always', onclick: () => done('save') }, 'Save, stay in practice'),
      h('button', { class: 'primary always', onclick: () => done(st.mode === 'practice' ? 'go-live' : 'save') }, st.mode === 'practice' ? 'Go live ▶' : st.mode === 'live' ? 'Save and restart' : 'Save'))));
  }
  return wrap;
}
