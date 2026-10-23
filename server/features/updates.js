// System > Updates: update Show Control from the iPad. It asks GitHub for the newest release (the
// show computer needs internet, from the control network), downloads the Mac or Windows version,
// checks it, unpacks it into "Show Control/App versions" and restarts into it (launcher/versions.js).
// If the new version doesn't start, the launcher goes back to this one by itself, and "Go back"
// returns to the version before at any time. Without internet, the downloaded .zip can be sent
// from a screen instead.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { once } = require('events');
const unzip = require('../unzip');
const versions = require('../../launcher/versions');

const REPO = 'roccomatusic-max/TheaterControl';
const ASSET = { darwin: 'ShowControl-mac.zip', win32: 'ShowControl-windows.zip' };
const UPDATE = 76; // tells the launcher to run the version in use.json
const OFFLINE = ['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH'];

// 0.10.2 < 0.11.0 (numbers only; anything after a "-" is ignored)
const cmp = (a, b) => {
  const x = String(a).split('-')[0].split('.').map(Number), y = String(b).split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};
// The release's list of changes (GitHub writes one line per merged pull request), in plain words.
const notesOf = body => String(body || '').split(/\r?\n/).filter(l => /^\s*[-*] /.test(l))
  .map(l => l.replace(/^\s*[-*] /, '').replace(/ by @\S+ in https?:\/\/\S+$/, '').replace(/\*\*|`/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim())
  .filter(Boolean).slice(0, 20);

module.exports = function updates(ctx) {
  const APP = path.join(__dirname, '..', '..');
  const mine = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8')).version;
  const asset = ASSET[process.env.SHOW_UPDATE_PLATFORM || process.platform];
  const packaged = fs.existsSync(path.join(APP, 'runtime')) || !!process.env.SHOW_UPDATE_ANY;
  const api = process.env.SHOW_UPDATE_API || 'https://api.github.com';
  const repo = () => ctx.settings().updates?.repo || REPO;
  const dir = versions.dir();
  let latest = null, checkedAt = 0, checkError = null;
  let job = null; // { stage: download | check | unpack | restart | error, version, got, total, error, at }

  // Why this copy can't update itself from here (null: it can).
  const why = () => !asset ? 'Updating from here works on the Mac and Windows downloads.'
    : !packaged ? 'This copy runs from the code, not the download: update it with git pull.'
      : !ctx.SUPERVISED ? 'Start Show Control by double-clicking it (or with the computer) to update from here.' : null;
  function info() {
    const u = versions.read();
    return {
      current: mine, latest, newer: !!latest && cmp(latest.version, mine) > 0, checkedAt, checkError, job, can: !why(), why: why(), asset,
      previous: u?.app && versions.same(u.app, APP) && u.previous?.version ? u.previous.version : null,
      failed: u?.failed && Date.now() - u.failed.at < 24 * 3600e3 ? u.failed : null,
      page: `https://github.com/${repo()}/releases/latest`,
    };
  }
  let lastSent = 0, sendTimer = null;
  const publish = (now = false) => {
    clearTimeout(sendTimer);
    if (now || Date.now() - lastSent > 500) { lastSent = Date.now(); ctx.broadcast({ t: 'update', update: info() }); } else sendTimer = setTimeout(() => publish(true), 500);
  };
  const log = (msg, level = 'cmd') => ctx.log({ device: 'core', level, msg, t: Date.now() });

  async function check() {
    try {
      const r = await fetch(`${api}/repos/${repo()}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'show-control' }, signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(r.status === 404 ? 'There are no releases yet.' : `GitHub answered ${r.status}.`);
      const j = await r.json();
      const a = (j.assets || []).find(x => x.name === asset);
      latest = { version: String(j.tag_name || '').replace(/^v/, ''), date: j.published_at, notes: notesOf(j.body), url: a?.browser_download_url || null, size: a?.size || 0, digest: a?.digest || null };
      checkError = null;
    } catch (e) {
      checkError = e.name === 'TimeoutError' || OFFLINE.includes(e.cause?.code) ? 'This computer can\'t reach the internet. Updates need internet (the control network), or send a downloaded file instead.' : e.message;
    }
    checkedAt = Date.now();
    publish(true);
    return info();
  }

  async function download(rel) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `.download-${rel.version}.zip`);
    const r = await fetch(rel.url, { headers: { 'User-Agent': 'show-control' }, signal: AbortSignal.timeout(30 * 60e3) });
    if (!r.ok) throw new Error(`The download didn't start (${r.status}).`);
    job.total = Number(r.headers.get('content-length')) || rel.size || 0;
    const out = fs.createWriteStream(file), hash = crypto.createHash('sha256');
    for await (const chunk of r.body) {
      hash.update(chunk); job.got += chunk.length;
      if (!out.write(chunk)) await once(out, 'drain');
      publish();
    }
    out.end(); await once(out, 'close');
    publish(true);
    if (rel.digest && rel.digest !== `sha256:${hash.digest('hex')}`) { fs.rmSync(file, { force: true }); throw new Error('The download was damaged on the way. Try again.'); }
    return file;
  }

  // Unpacks a downloaded .zip next to the other versions, checks it is a whole Show Control that can
  // run on this computer, and chooses it for the next start.
  async function install(zip, want, who) {
    job.stage = 'unpack'; publish(true);
    const part = path.join(dir, `.unpack-${Date.now()}`);
    try {
      await unzip(zip, part);
      const rel = ['Show Control/app', 'app', '.'].find(r => fs.existsSync(path.join(part, r, 'launcher', 'start.js')) && fs.existsSync(path.join(part, r, 'server', 'index.js')));
      if (!rel) throw new Error('That file isn\'t a Show Control download.');
      const version = JSON.parse(fs.readFileSync(path.join(part, rel, 'package.json'), 'utf8')).version;
      if (want && version !== want) throw new Error(`The download is version ${version}, not ${want}.`);
      if (version === mine) throw new Error(`This computer already runs version ${version}.`);
      job.version = version; job.stage = 'check'; publish(true);
      const node = versions.nodeOf(path.join(part, rel));
      await new Promise((res, rej) => execFile(node, ['--version'], { timeout: 20000 }, e => (e ? rej(new Error('The new version can\'t run on this computer.')) : res())));
      const dest = path.join(dir, version);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(part, dest);
      const app = path.join(dest, rel);
      versions.write({ version, app, at: Date.now(), by: who, confirmed: false, previous: { version: mine, app: APP } });
      job.stage = 'restart'; publish(true);
      ctx.restart(`updating Show Control from ${mine} to ${version} (by ${who})`, UPDATE);
      return version;
    } finally {
      fs.rmSync(part, { recursive: true, force: true });
      fs.rmSync(zip, { force: true });
    }
  }
  function startJob(work, version) {
    if (job && !['error', 'done'].includes(job.stage)) throw new Error('An update is already on its way.');
    job = { stage: 'download', version, got: 0, total: 0, at: Date.now() };
    publish(true);
    work().catch(e => { job = { ...job, stage: 'error', error: e.message }; log(`update failed: ${e.message}`, 'error'); publish(true); });
  }

  ctx.handlers['update-get'] = () => info();
  ctx.handlers['update-check'] = () => check();
  ctx.handlers['update-install'] = async (m, ws) => {
    if (why()) throw new Error(why());
    await check(); // always fresh: the release may have been replaced since the last look
    if (!latest) throw new Error(checkError || 'Could not find the newest version.');
    if (cmp(latest.version, mine) <= 0) throw new Error('This is already the newest version.');
    if (!latest.url) throw new Error(`Version ${latest.version} has no ${asset} to download yet. Try again in a few minutes.`);
    const who = ctx.screenName?.(ws.who) || ws.who, rel = latest;
    log(`update to ${rel.version} started by ${who}`);
    startJob(async () => install(await download(rel), rel.version, who), rel.version);
    return info();
  };
  // Back to the version that ran before this one.
  ctx.handlers['update-back'] = (m, ws) => {
    if (why()) throw new Error(why());
    const u = versions.read();
    if (!u?.previous?.app || !versions.same(u.app, APP)) throw new Error('There is no earlier version to go back to.');
    const who = ctx.screenName?.(ws.who) || ws.who;
    versions.write({ ...u.previous, at: Date.now(), by: who, confirmed: false, previous: { version: mine, app: APP } });
    ctx.restart(`going back from Show Control ${mine} to ${u.previous.version} (by ${who})`, UPDATE);
    return { restarting: true };
  };
  // Without internet: the .zip downloaded on another device is sent here (a link that works once).
  const uploads = new Map();
  ctx.handlers['update-upload'] = (m, ws) => {
    if (why()) throw new Error(why());
    if (job && !['error', 'done'].includes(job.stage)) throw new Error('An update is already on its way.');
    const token = crypto.randomBytes(12).toString('hex');
    uploads.set(token, { who: ctx.screenName?.(ws.who) || ws.who, until: Date.now() + 10 * 60e3 });
    return { url: `/api/update-file/${token}` };
  };
  ctx.routes.push(app => app.post('/api/update-file/:token', (req, res) => {
    const u = uploads.get(req.params.token);
    uploads.delete(req.params.token);
    if (!u || u.until < Date.now()) return res.status(403).json({ error: 'This link has expired. Try again from System > Updates.' });
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `.upload-${Date.now()}.zip`);
    const out = fs.createWriteStream(file);
    let got = 0, tooBig = false;
    req.on('data', d => { got += d.length; if (got > 600e6 && !tooBig) { tooBig = true; req.unpipe(out); out.destroy(); fs.rmSync(file, { force: true }); res.status(413).json({ error: 'That file is too big to be a Show Control download.' }); } });
    req.pipe(out);
    out.on('finish', () => {
      if (tooBig) return;
      log(`update from a file (${(got / 1e6).toFixed(0)} MB) sent by ${u.who}`);
      try { startJob(() => install(file, null, u.who), null); res.json({ ok: true }); } catch (e) { fs.rmSync(file, { force: true }); res.status(409).json({ error: e.message }); }
    });
  }));
  for (const t of ['update-install', 'update-back', 'update-upload']) ctx.access?.adminOnly(t);

  // Started as the chosen version: tell the launcher it's running (else it goes back after a while),
  // and tidy up versions nobody can go back to.
  ctx.events.once('listening', () => {
    const u = versions.read();
    if (u?.failed && Date.now() - u.failed.at < 10 * 60e3) {
      ctx.raiseAlert?.({ key: 'update-failed', kind: 'update', level: 'warn', title: `The update to ${u.failed.version} didn't start`, detail: `${u.failed.error}; Show Control ${mine} is running instead` });
    }
    if (u?.app && versions.same(u.app, APP) && !u.confirmed) {
      versions.write({ ...u, confirmed: true, confirmedAt: Date.now() });
      log(`now running Show Control ${mine}${u.previous?.version ? ` (was ${u.previous.version})` : ''}`);
    }
    const keep = [APP, u?.app, u?.previous?.app].filter(Boolean).map(a => path.resolve(a));
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const d = path.resolve(dir, e.name);
        if (!e.isDirectory() && !e.name.startsWith('.download-') && !e.name.startsWith('.upload-')) continue;
        if (e.isDirectory() && keep.some(k => k === d || k.startsWith(d + path.sep))) continue;
        fs.rmSync(d, { recursive: true, force: true });
      }
    } catch { /* no versions yet */ }
    // Look for a newer version now and then (quietly: nothing happens without a tap).
    if (!why()) {
      setTimeout(check, Number(process.env.SHOW_UPDATE_FIRST_CHECK_MS || 60e3)).unref();
      setInterval(check, 6 * 3600e3).unref();
    }
  });
  ctx.initExtras.push(() => ({ version: mine, updateAvailable: latest && cmp(latest.version, mine) > 0 ? latest.version : null }));
};
