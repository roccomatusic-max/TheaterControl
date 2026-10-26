// ---------- Several shows and training mode (System tab) ----------
'use strict';
const showsDay = t => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' });
const showsTime = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---------- Shows ----------
SYS_CARDS.push(() => {
  const body = h('div', {}, h('div', { class: 'dim' }, 'Loading…'));
  const msg = h('div', { class: 'last' });
  const done = r => { if (r.error) { msg.textContent = r.error; return false; } return true; };
  const restarting = r => { if (done(r)) msg.textContent = 'Switching… Show Control restarts and every screen reconnects in a few seconds.'; };
  const download = async name => { const r = await ask('shows-link', { name }); if (done(r)) location.href = r.url; };
  const addFile = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    const r = await ask('shows-import', { text: await f.text() });
    if (done(r)) { msg.textContent = `Added "${r.added}". Switch to it when you're ready.`; draw(r); }
  } });
  function newShow(cur) {
    const name = h('input', { placeholder: 'e.g. Into the Woods', maxlength: 60 });
    const keep = h('select', {}, h('option', { value: 'equipment' }, 'Same equipment, empty cue list'), h('option', { value: 'all' }, 'A copy of everything, cues too'));
    const err = h('p', { class: 'err' });
    const el = sheet(h('h2', {}, 'Start a new show'),
      h('p', { class: 'dim' }, `"${cur}" is kept, with its cue list and where it was, and you can switch back to it at any time.`),
      h('div', { class: 'form' }, h('label', {}, 'Name of the new show', name), h('label', {}, 'Start with', keep)), err,
      h('button', { class: 'primary always', onclick: async () => {
        const r = await ask('shows-new', { name: name.value.trim(), keep: keep.value });
        if (r.error) { err.textContent = r.error; return; }
        el.remove(); restarting(r);
      } }, 'Start it'));
    name.focus();
  }
  function draw(s) {
    if (s.error) return fill(body, h('p', { class: 'bad' }, s.error));
    if (!s.here) return fill(body, h('p', {}, 'Keep several shows on this computer, each with its own equipment, cue list and mic plot, and switch between them.'),
      h('p', { class: 'dim' }, s.mode === 'training' ? 'Not while training.' : 'Available once you are live with your real equipment.'));
    const admin = S.role === 'admin';
    const l = s.last;
    fill(body,
      l && Date.now() - l.done < 10 * 60e3 && (l.error ? h('p', { class: 'bad' }, `Couldn't switch shows: ${l.error}`) : null),
      h('div', { class: 'showrow current' },
        h('div', {}, h('b', {}, s.current.name), h('span', { class: 'dim' }, `Running now · ${plural(s.current.cues, 'cue')} · ${plural(s.current.devices, 'piece')} of equipment`)),
        admin && h('div', { class: 'row' },
          h('button', { onclick: async () => { const n = prompt('Keep a copy of this show under the name:', `${s.current.name} copy`); if (!n) return; const r = await ask('shows-copy', { name: n.trim() }); if (done(r)) { msg.textContent = `Kept a copy as "${n.trim()}".`; draw(r); } } }, 'Keep a copy'),
          h('button', { onclick: () => download(null) }, 'Download'))),
      s.list.map(x => h('div', { class: 'showrow' },
        h('div', {}, h('b', {}, x.name), h('span', { class: 'dim' }, `${plural(x.cues, 'cue')} · ${plural(x.devices, 'piece')} of equipment · saved ${showsDay(x.savedAt)}`)),
        admin && h('div', { class: 'row' },
          h('button', { class: 'primary', onclick: async () => {
            if (!confirm(`Switch to "${x.name}"?\n\nShow Control restarts (about 10 seconds) and every screen reconnects. "${s.current.name}" is kept, with where it was.`)) return;
            restarting(await ask('shows-switch', { name: x.name }));
          } }, 'Switch to this'),
          h('button', { onclick: () => download(x.name) }, 'Download'),
          h('button', { class: 'danger', onclick: async () => { if (!confirm(`Delete "${x.name}" from this computer? This can't be undone (the nightly backups still have it).`)) return; const r = await ask('shows-delete', { name: x.name }); if (done(r)) draw(r); } }, 'Delete')))),
      !s.list.length && h('p', { class: 'dim' }, 'No other shows yet. Start a new one for another production or venue, or add one from a file downloaded on another computer.'),
      admin ? h('div', { class: 'row' },
        h('button', { onclick: () => newShow(s.current.name) }, 'Start a new show'),
        h('button', { onclick: () => addFile.click() }, 'Add from a file'), addFile)
        : h('p', { class: 'dim' }, 'Only the admin PIN can switch or change shows.'),
      msg);
  }
  ask('shows-get').then(draw);
  return h('div', { class: 'card' }, h('h3', {}, 'Shows'), body);
});

// ---------- Training mode ----------
const TROUBLE_WORDS = { down: 'not answering', fail: 'will refuse its next command' };
onMsg('training', m => { S.trainingInfo = m.training; if (S.tab === 'sys') render(); });
SYS_CARDS.push(() => {
  const body = h('div', {}, h('div', { class: 'dim' }, 'Loading…'));
  const msg = h('div', { class: 'last' });
  const restartNote = r => { msg.textContent = r.error || 'Show Control is restarting. Every screen reconnects in a few seconds.'; };
  function draw(t) {
    if (t.error) return fill(body, h('p', { class: 'bad' }, t.error));
    const admin = S.role === 'admin';
    if (!t.on) return fill(body,
      h('p', {}, 'New operators practise on a copy of this show, with pretend equipment. Nothing real moves, and nothing they change reaches the real show. You can make equipment stop answering to practise what to do.'),
      t.mode === 'practice' ? h('p', { class: 'dim' }, 'Practice mode already uses pretend equipment, so new operators can practise right here. Training mode, for when you are live, copies the real show.')
        : admin ? [h('p', { class: 'dim' }, 'While training, the real show is not running: don\'t start it during a performance. End training puts everything back where it was.'),
          h('button', { class: 'primary', onclick: async () => { if (!confirm('Start training mode?\n\nShow Control restarts with a copy of this show and pretend equipment. Nothing real is controlled until you end training.')) return; restartNote(await ask('training-start')); } }, 'Start training')]
          : h('p', { class: 'dim' }, 'Only the admin PIN can start training.'),
      msg);
    fill(body,
      h('p', { class: 'trainnow' }, `Training since ${showsTime(t.since)}${t.by ? ` (started by ${t.by})` : ''}. All equipment is pretend, and changes stay in the training copy.`),
      admin && [h('h4', {}, 'Make something go wrong'),
        h('div', { class: 'trouble' }, t.devices.map(d => h('div', { class: `troublerow ${d.trouble || ''}` },
          h('div', {}, h('b', {}, d.name.split(' · ')[0]), h('span', { class: 'dim' }, d.trouble ? TROUBLE_WORDS[d.trouble] : d.stand === 'sim' ? 'simulator' : 'stand-in')),
          h('select', { onchange: async e => draw(await ask('training-trouble', { device: d.id, what: e.target.value })) },
            [['fixed', 'Working'], ['down', 'Stops answering'], ['fail', 'Refuses next command']].map(([v, l]) => h('option', { value: v, selected: (d.trouble || 'fixed') === v }, l)))))),
        h('button', { class: 'primary always', onclick: async () => { if (!confirm('End training and go back to the real show?\n\nChanges made while training are not kept in the real show.')) return; restartNote(await ask('training-stop')); } }, 'End training')],
      !admin && h('p', { class: 'dim' }, 'The admin PIN ends training.'),
      msg);
  }
  ask('training-get').then(draw);
  return h('div', { class: `card${S.mode === 'training' ? ' trainingcard' : ''}` }, h('h3', {}, S.mode === 'training' ? 'Training mode: on' : 'Training mode'), body);
});
// The "training" pill at the top opens the training card.
$('#conn').addEventListener('click', () => { if (S.mode === 'training') { S.tab = 'sys'; render(); } });
