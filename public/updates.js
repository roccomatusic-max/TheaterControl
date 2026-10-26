// ---------- System tab: updates ----------
'use strict';
const UPDATE_STAGES = { download: 'Downloading', unpack: 'Unpacking', check: 'Checking it runs on this computer', restart: 'Restarting into the new version', error: 'The update stopped' };
onMsg('init', m => {
  // The show computer now runs another version (one-tap update): load its screens too, so this iPad
  // never runs old buttons against a new server. Not while carried over to the backup computer (a
  // reload would go back to the stopped one), and not in the middle of editing cues or setup, where
  // a reload would lose changes: say so instead.
  if (S.appVersion && m.version && m.version !== S.appVersion) {
    if (['edit', 'setup', 'wizard'].includes(S.tab) || wsHost() !== location.host) toast(`Show Control is now version ${m.version}. Save, then reload this page.`, 10000);
    else return location.reload();
  }
  S.appVersion = m.version; S.updateAvailable = m.updateAvailable;
});
onMsg('update', m => { S.updateInfo = m.update; S.updateAvailable = m.update.newer ? m.update.latest.version : null; if (S.tab === 'sys') drawUpdate?.(m.update); });
let drawUpdate = null;
SYS_CARDS.push(() => {
  const body = h('div', {}, h('div', { class: 'dim' }, 'Loading…'));
  const msg = h('div', { class: 'last' });
  const mb = n => `${Math.round(n / 1e6)} MB`;
  const sendFile = h('input', { type: 'file', accept: '.zip,application/zip', hidden: true, onchange: async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    const r = await ask('update-upload');
    if (r.error) { msg.textContent = r.error; return; }
    msg.textContent = `Sending ${f.name} (${mb(f.size)})…`;
    try {
      const res = await fetch(r.url, { method: 'POST', body: f, headers: { 'Content-Type': 'application/zip' } });
      const j = await res.json();
      msg.textContent = j.error || 'Sent. Show Control unpacks it and restarts into it.';
    } catch { msg.textContent = 'Sending stopped. Check this screen is still connected and try again.'; }
  } });
  function draw(u) {
    if (u.error) return fill(body, h('p', { class: 'bad' }, u.error));
    const admin = S.role === 'admin';
    const j = u.job, busy = j && !['error', 'done'].includes(j.stage);
    fill(body,
      h('p', {}, `This is Show Control ${u.current}.`),
      u.failed && h('p', { class: 'bad' }, `The update to ${u.failed.version} didn't start (${u.failed.error}), so this version is running instead.`),
      busy ? [h('p', { class: 'good' }, `${UPDATE_STAGES[j.stage]}${j.version ? ` ${j.version}` : ''}${j.stage === 'download' && j.total ? `: ${mb(j.got)} of ${mb(j.total)}` : '…'}`),
        j.stage === 'download' && j.total ? h('div', { class: 'updbar' }, h('i', { style: `width:${Math.round((100 * j.got) / j.total)}%` })) : null,
        h('p', { class: 'dim' }, 'Every screen reconnects by itself when it restarts.')]
        : [j?.stage === 'error' && h('p', { class: 'bad' }, `The update stopped: ${j.error}`),
          u.checkError ? h('p', { class: 'dim' }, u.checkError)
            : u.newer ? [h('p', { class: 'good' }, `Version ${u.latest.version} is available${u.latest.date ? ` (${new Date(u.latest.date).toLocaleDateString([], { day: 'numeric', month: 'short' })})` : ''}.`),
              u.latest.notes.length ? h('ul', { class: 'updnotes' }, u.latest.notes.map(n => h('li', {}, n))) : null]
              : u.checkedAt ? h('p', { class: 'dim' }, `This is the newest version (checked ${new Date(u.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}).`) : null,
          !u.can ? h('p', { class: 'dim' }, u.why)
            : admin ? [h('div', { class: 'row' },
              u.newer && h('button', { class: 'primary', onclick: async () => {
                if (!confirm(`Update to ${u.latest.version}?\n\nShow Control downloads it, then restarts (about 20 seconds) and every screen reconnects. If the new version doesn't start, it goes back to ${u.current} by itself. Don't do this during a show.`)) return;
                const r = await ask('update-install'); if (r.error) msg.textContent = r.error; else draw(r);
              } }, `Update to ${u.latest.version}`),
              h('button', { onclick: async () => { msg.textContent = 'Checking…'; draw(await ask('update-check')); msg.textContent = ''; } }, 'Check for updates'),
              u.previous && h('button', { onclick: async () => {
                if (!confirm(`Go back to Show Control ${u.previous}?\n\nShow Control restarts (about 20 seconds) and every screen reconnects.`)) return;
                const r = await ask('update-back'); msg.textContent = r.error || 'Going back. Every screen reconnects in a few seconds.';
              } }, `Go back to ${u.previous}`)),
            h('details', {}, h('summary', {}, 'No internet on the show computer?'),
              h('p', { class: 'dim' }, `On a phone or another computer, download ${u.asset} from the Show Control releases page, then send it here from this screen.`),
              h('div', { class: 'row' }, h('a', { href: u.page, target: '_blank', rel: 'noopener' }, 'Releases page'), h('button', { onclick: () => sendFile.click() }, 'Send the downloaded file'), sendFile))]
              : h('p', { class: 'dim' }, 'Only the admin PIN can update Show Control.')],
      msg);
  }
  drawUpdate = draw;
  ask('update-get').then(draw);
  return h('div', { class: 'card' }, h('h3', {}, 'Updates'), body);
});
