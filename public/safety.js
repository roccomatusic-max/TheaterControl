// ---------- Show lock, sign-in roles, cue list history, backups ----------
'use strict';
const ROLE_WORDS = { admin: 'Admin', operator: 'Operator', viewer: 'Watch only' };
const when = t => new Date(t).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const fmtSize = b => b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`;

// ---------- sign-in role ----------
// "Just watch" on the PIN screen when the admin allows crew to watch without a PIN.
const watchBtn = h('button', { type: 'button', class: 'watch', hidden: true, onclick: () => { localStorage.setItem('watch', '1'); localStorage.removeItem('pin'); send({ t: 'auth', pin: '' }); } }, 'Just watch (no PIN)');
$('#pin form').append(watchBtn);
onMsg('auth-required', m => {
  watchBtn.hidden = !m.watch;
  if (m.watch && localStorage.getItem('watch') && !localStorage.getItem('pin')) send({ t: 'auth', pin: '' });
});
$('#pin form').addEventListener('submit', () => localStorage.removeItem('watch'));
const rolePill = h('span', { id: 'rolePill', class: 'pill', hidden: true });
$('#conn').after(rolePill);
onMsg('init', m => {
  S.role = m.role || 'admin'; S.signin = !!m.signin; S.lock = m.lock || null;
  document.body.classList.toggle('role-viewer', S.role === 'viewer');
  document.body.classList.toggle('role-operator', S.role === 'operator');
  rolePill.hidden = S.role === 'admin'; rolePill.textContent = ROLE_WORDS[S.role];
  renderLock();
});
const signOut = () => { localStorage.removeItem('pin'); localStorage.removeItem('watch'); location.reload(); };

// ---------- show lock ----------
onMsg('lock', m => { S.lock = m.lock; renderLock(); if (S.tab === 'edit' || S.tab === 'history') render(); });
function renderLock() {
  const b = $('#lockBtn'), screen = document.body.classList.contains('locked');
  document.body.classList.toggle('showlocked', !!S.lock);
  b.textContent = screen || S.lock ? '🔒' : '🔓';
  b.title = screen ? 'This screen is locked' : S.lock ? 'The show is locked' : 'Lock';
}
function sheet(...kids) {
  const el = h('div', { class: 'sheet', onclick: e => e.target === el && el.remove() }, h('div', { class: 'box' }, ...kids, h('button', { class: 'always', onclick: () => el.remove() }, 'Cancel')));
  document.body.append(el);
  return el;
}
function lockMenu() {
  const screen = document.body.classList.contains('locked');
  let el;
  const done = () => { el.remove(); renderLock(); };
  const lockShow = async on => {
    const r = await ask('show-lock', { on, pin: pinIn?.value || localStorage.getItem('pin') || '' });
    if (r.error) { err.textContent = r.error; return; }
    S.lock = r.lock; done(); toast(on ? 'Show locked on every screen' : 'Show unlocked');
  };
  const err = h('p', { class: 'err' });
  const pinIn = S.lock && S.signin ? h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', placeholder: 'Operator or admin PIN' }) : null;
  const choice = (title, text, onclick, cls = '') => h('button', { class: `choice always ${cls}`, onclick }, h('b', {}, title), h('span', {}, text));
  const canShow = S.role !== 'viewer';
  el = sheet(h('h2', {}, 'Lock'),
    screen && choice('Unlock this screen', 'Buttons on this screen work again.', () => { setLock(false); done(); }, 'primary'),
    S.lock ? [h('p', {}, `The show has been locked since ${when(S.lock.at)}${S.lock.by ? ` (from ${S.lock.by})` : ''}. Cue editing, equipment setup, firing cues out of order and switching equipment off are blocked on every screen.`),
      canShow && [pinIn, choice('Unlock the show', 'Allows changes again on every screen.', () => lockShow(false))]]
      : canShow && choice('Lock the show (every screen)', 'GO, STOP and the normal controls keep working. Nobody can edit cues, change the setup, fire cues out of order or switch equipment off by accident.', () => lockShow(true), 'primary'),
    !screen && choice('Lock this screen only', 'Every button on this screen stops working, except STOP, until you unlock it. Good for a phone in your pocket.', () => { setLock(true); done(); }),
    err);
  pinIn?.focus();
}
$('#lockBtn').addEventListener('click', lockMenu);

// The cue editor says so when the show is locked, instead of letting changes be made and then refused.
VIEWS.edit = () => S.lock ? h('div', { class: 'card' }, h('h3', {}, 'Edit cues', h('button', { class: 'always', onclick: () => { S.tab = 'show'; render(); } }, '← Show')),
  h('p', {}, 'The show is locked, so the cue list can\'t be changed. Tap the lock at the top to unlock it.'),
  h('button', { class: 'always', onclick: lockMenu }, 'Unlock…')) : editTab();

// ---------- System tab: who can do what ----------
SYS_CARDS.push(() => {
  const card = h('div', { class: 'card' }, h('h3', {}, 'Who can do what'));
  if (S.role !== 'admin') {
    card.append(h('p', {}, `This screen is signed in as ${ROLE_WORDS[S.role].toLowerCase()}.`, S.role === 'viewer' ? ' It can watch but not control anything.' : ' It can run the show but not change the equipment setup or PINs.'),
      h('button', { class: 'always', onclick: signOut }, 'Sign in with a different PIN'));
    return card;
  }
  const st = {};
  const f = (key, label, hint) => h('label', {}, label, h('input', { inputmode: 'numeric', autocomplete: 'off', placeholder: 'none', oninput: e => (st[key] = e.target.value.trim()) }), hint && h('small', { class: 'dim' }, hint));
  const form = h('div', { class: 'form' },
    f('pin', 'Admin PIN', 'Everything, including setup and these PINs. Same as the PIN on the Setup screen.'),
    f('operatorPin', 'Operator PIN', 'Runs the show: GO, cues, controls, STOP, editing cues.'),
    f('viewerPin', 'Crew PIN (watch only)', 'Sees everything, can\'t press anything.'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: e => (st.openViewing = e.target.checked) }), 'Crew can watch without a PIN'));
  const msg = h('div', { class: 'last' });
  ask('access-get').then(r => {
    if (r.error) return msg.replaceChildren(r.error);
    Object.assign(st, r);
    const [a, o, v, w] = form.querySelectorAll('input');
    a.value = r.pin; o.value = r.operatorPin; v.value = r.viewerPin; w.checked = r.openViewing;
    if (r.envPin) { a.disabled = true; a.title = 'Set when Show Control was started'; }
  });
  card.append(h('p', { class: 'dim' }, 'With no PINs, anyone on the control network can do anything. A crew phone signed in with the crew PIN can watch but not fire cues.'), form,
    h('div', { class: 'row', style: 'margin-top:8px' },
      h('button', { class: 'primary', onclick: async () => {
        const r = await ask('access-set', st);
        if (r.error) { msg.textContent = r.error; msg.className = 'last bad'; return; }
        if (r.pin) localStorage.setItem('pin', r.pin); // this screen stays signed in as admin
        msg.textContent = 'Saved. Screens that are already connected keep their sign-in until they reconnect.'; msg.className = 'last';
      } }, 'Save PINs'),
      S.signin && h('button', { onclick: signOut }, 'Sign out of this screen')),
    msg);
  return card;
});

// ---------- cue list history (undo) ----------
VIEWS.history = () => historyTab();
NAV_PARENT.history = 'show';
function historyTab() {
  const list = h('div', { class: 'versions' }, h('div', { class: 'dim' }, 'Loading…'));
  const back = h('button', { class: 'always', onclick: () => { S.tab = S.editor ? 'edit' : 'show'; render(); } }, '← Back');
  const undo = h('button', { class: 'primary', onclick: async () => {
    if (!confirm('Put back the cue list as it was before the last change?')) return;
    const r = await ask('cues-undo');
    if (r.error) return toast(r.error, 5000);
    S.editor = null; toast('Cue list put back. Undo again to redo.'); load();
  } }, '↶ Undo last change');
  const load = async () => {
    const r = await ask('versions-list');
    if (r.error) return list.replaceChildren(h('div', { class: 'bad' }, r.error));
    list.replaceChildren(...r.versions.length ? r.versions.map(v => h('div', { class: `version ${v.current ? 'current' : ''}` },
      h('div', {}, h('b', {}, when(v.at)), h('span', { class: 'dim' }, ` · ${v.by}${v.mode === 'practice' ? ' · practice' : ''}`),
        h('div', {}, v.note ? `${v.note}: ` : '', v.changes), h('div', { class: 'dim' }, `${v.count} cues`)),
      v.current ? h('span', { class: 'pill ok' }, 'now') : h('button', { onclick: async () => {
        if (!confirm(`Put back the cue list from ${when(v.at)}? The current one stays in the history.`)) return;
        const x = await ask('versions-restore', { file: v.file });
        if (x.error) return toast(x.error, 5000);
        S.editor = null; toast(`Cue list from ${when(v.at)} put back`); load();
      } }, 'Put this back')))
      : [h('div', { class: 'dim' }, 'No saved changes yet. Every time the cue list is saved, a copy is kept here.')]);
  };
  load();
  if (S.lock) undo.disabled = true;
  return h('div', { class: 'grid' }, h('div', { class: 'card', style: 'grid-column:1/-1' },
    h('h3', {}, 'Cue list history', back),
    h('p', { class: 'dim' }, S.lock ? 'The show is locked, so nothing can be put back until it is unlocked.' : 'Every saved cue list is kept. Put any of them back; the current one is kept too, so this can always be undone.'),
    h('div', { class: 'row', style: 'margin-bottom:10px' }, undo), list));
}

// ---------- System tab: backups ----------
SYS_CARDS.push(() => {
  const body = h('div', {}, h('div', { class: 'dim' }, 'Loading…'));
  const draw = r => {
    if (r.error) return body.replaceChildren(h('div', { class: 'bad' }, r.error));
    const l = r.last;
    const admin = S.role === 'admin';
    fill(body,
      h('div', { class: 'kv' },
        h('b', {}, 'Last backup'), h('span', { class: !l ? 'bad' : l.ok ? 'good' : 'bad' }, r.running ? 'Backing up now…' : !l ? 'none yet' : `${when(l.at)}${l.ok ? '' : `: ${l.problems.join('; ')}`}`),
        h('b', {}, 'Every night at'), admin ? h('input', { class: 'time', type: 'time', value: r.time, onchange: async e => draw(await ask('backups-set', { time: e.target.value })) }) : h('span', {}, r.time),
        h('b', {}, 'Keeps'), h('span', {}, `the newest ${r.keep}`),
        h('b', {}, 'Saved in'), h('span', { class: 'mono' }, r.folder)),
      h('div', { class: 'sub' }, 'What is backed up'),
      h('ul', { class: 'plain' }, h('li', {}, 'The show file: cues, equipment, settings'), h('li', {}, 'What each device reports: mixer channel names and levels, Eos show name, projector lamp hours'),
        r.folders.map(f => h('li', {}, h('span', { class: 'mono' }, f), admin && h('button', { class: 'mini', onclick: async () => draw(await ask('backups-set', { folders: r.folders.filter(x => x !== f) })) }, 'Remove')))),
      admin && h('p', { class: 'dim' }, 'Eos and the TF5 keep their own show files. To back those up too, save copies (or the QLab workspace, if QLab runs on this computer) into a folder here and add it.'),
      h('div', { class: 'row' },
        h('button', { onclick: async () => { body.querySelector('.kv span').textContent = 'Backing up now…'; draw(await ask('backups-now', {}, 600000)); draw(await ask('backups-get')); } }, 'Back up now'),
        admin && h('button', { onclick: () => pickFolder(async f => draw(await ask('backups-set', { folders: [...r.folders, f] }))) }, 'Add a folder…')),
      r.list.length > 0 && h('details', {}, h('summary', {}, `Earlier backups (${r.list.length})`),
        r.list.map(name => h('div', { class: 'bk' }, h('span', { class: 'mono' }, name), h('button', { class: 'mini', onclick: async () => {
          if (!confirm(`Put back the cue list from the backup of ${name}? The current one stays in the cue list history.`)) return;
          const x = await ask('backups-restore-cues', { name });
          toast(x.error || `Cue list put back (${x.count} cues)`, 5000);
        } }, 'Put this cue list back')))));
  };
  ask('backups-get').then(draw);
  return h('div', { class: 'card' }, h('h3', {}, 'Backups', h('button', { class: 'always', onclick: () => { S.tab = 'history'; render(); } }, 'Cue list history')), body);
});
// Folder picker on the show computer (admin only).
async function pickFolder(onPick) {
  let el;
  const box = h('div', { class: 'picker' });
  const go = async p => {
    const r = await ask('backups-browse', { path: p });
    if (r.error) return toast(r.error, 5000);
    box.replaceChildren(h('div', { class: 'mono here' }, r.path),
      h('div', { class: 'row' }, r.roots.map(x => h('button', { class: 'mini', onclick: () => go(x) }, x === r.roots[0] ? 'Home' : x)), r.parent && h('button', { class: 'mini', onclick: () => go(r.parent) }, '↑ Up'),
        h('button', { class: 'mini primary', onclick: () => { el.remove(); onPick(r.path); } }, 'Use this folder')),
      h('div', { class: 'dirs' }, r.dirs.length ? r.dirs.map(d => h('button', { onclick: () => go(`${r.path}${r.path.endsWith('/') || r.path.endsWith('\\') ? '' : r.path.includes('\\') ? '\\' : '/'}${d}`) }, `📁 ${d}`)) : h('div', { class: 'dim' }, 'No folders inside')));
  };
  el = sheet(h('h2', {}, 'Choose a folder to back up'), box);
  go();
}
