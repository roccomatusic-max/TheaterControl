// Double-click launcher used by the Mac and Windows downloads (see scripts/package.js).
// Practice mode (simulated devices) unless the user has a real show file at
// ~/Show Control/show.json (made by the Setup screen; "live": false keeps practice mode); see plan.js.
// Opens the browser and prints the iPad address + QR code. Runs the server as a child
// process and restarts it after a switch between practice and live, or if it ever crashes.
// --background (used when starting with the computer): no browser, no screen clearing.
// After a one-tap update, this launcher starts the newer version's launcher instead (versions.js).
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { execFile, fork, spawn } = require('child_process');
const QRCode = require('qrcode');
const { plan, env } = require('./plan');
const versions = require('./versions');

const BACKGROUND = process.argv.includes('--background');
const RESTART = 75, UPDATE = 76; // exit codes of the server: restart, or run another version
const ROOT_APP = path.join(__dirname, '..');
const HANDED = !!process.env.SHOW_ROOT_APP; // started by an older version's launcher, which chooses
// How long a newly installed version has to get its server running before we go back.
const CONFIRM_MS = Number(process.env.SHOW_UPDATE_CONFIRM_MS || 120e3);
let stopNow = () => process.exit(0);
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => stopNow());
let opened = BACKGROUND, awake = false;

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  execFile(cmd, args, () => {});
}

// Is Show Control already running on this port? Then just open it again.
function alreadyRunning(port) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1000 }, res => {
      let body = ''; res.on('data', d => (body += d));
      res.on('end', () => { try { resolve(JSON.parse(body).app === 'show-control'); } catch { resolve(false); } });
    });
    req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
function portFree(port) {
  return new Promise(resolve => {
    const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '0.0.0.0');
  });
}

// Runs the version chosen on System > Updates if it isn't this one, else this one's own server.
function start() {
  const next = !HANDED && versions.pick(ROOT_APP);
  if (next) handOff(next);
  else serve().catch(e => { console.error('\n  Show Control could not start:', e.message, '\n'); process.exitCode = 1; });
}

function handOff(next) {
  console.log(`\n  Starting Show Control ${next.version}…\n`);
  const t0 = Date.now();
  let settled = false;
  const child = spawn(next.node, [next.start, ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, SHOW_ROOT_APP: ROOT_APP, SHOW_ROOT_NODE: process.execPath } });
  stopNow = () => { settled = true; child.kill(); setTimeout(() => process.exit(0), 1500); };
  const back = why => {
    if (settled) return;
    settled = true; clearInterval(watch);
    versions.failed(next, why);
    console.log(`\n  Show Control ${next.version} didn't start properly (${why}), so the version before it starts instead.\n`);
    if (child.exitCode !== null || child.signalCode !== null) return start();
    child.removeAllListeners('exit'); child.once('exit', () => start()); child.kill();
  };
  const watch = setInterval(() => {
    if (versions.confirmed(next)) { settled = true; clearInterval(watch); } else if (Date.now() - t0 > CONFIRM_MS) back(`it wasn't running after ${Math.round(CONFIRM_MS / 1000)} s`);
  }, 1000);
  child.on('error', e => back(e.message));
  child.on('exit', (code, signal) => {
    clearInterval(watch);
    if (code === UPDATE) return start(); // another version was chosen: choose again
    if (!settled && code !== 0 && !signal) return back(`it stopped with code ${code}`);
    process.exit(code ?? 0);
  });
}

async function serve() {
  const wanted = Number(process.env.PORT || JSON.parse(fs.readFileSync(plan().cfgPath, 'utf8')).server?.port || 8080);

  if (await alreadyRunning(wanted)) {
    console.log('\n  Show Control is already running. Opening it in your browser.\n');
    if (!BACKGROUND) openBrowser(`http://localhost:${wanted}/connect`);
    return setTimeout(() => process.exit(0), 500);
  }
  let port = wanted;
  while (!(await portFree(port)) && port < wanted + 20) port++;
  // The show computer must not go to sleep while Show Control runs (Mac; the display may still sleep).
  if (process.platform === 'darwin' && !awake) { awake = true; spawn('caffeinate', ['-is', '-w', String(process.pid)], { stdio: 'ignore' }).on('error', () => {}); }

  let child = null, stopping = false, started = 0, crashes = 0, recovered = false;
  const run = () => {
    if (stopping) return;
    const pl = plan();
    if (pl.broken) {
      console.log(`\n  Your show file has a mistake in it, so Show Control is starting in practice mode.\n  ${pl.p.real}\n  Saving on the Setup screen replaces it (the old one is kept as show.json.bak).\n`);
    }
    started = Date.now();
    child = fork(path.join(__dirname, 'run.js'), [pl.cfgPath], {
      env: {
        ...process.env, PORT: String(port), SHOW_QUIET: '1', // device activity is in the System tab; keep this window readable
        ...env(pl), SHOW_SUPERVISED: '1',
        SHOW_RECOVERED: recovered ? '1' : '', // started again after a crash: raise an alert
      },
    });
    child.on('message', m => { if (m?.t === 'ready') banner(m.urls, m.mode || pl.mode); });
    child.on('exit', (code, signal) => {
      child = null;
      if (stopping) return;
      // Stopped on purpose (window closed, Ctrl-C, shutdown): stop the launcher too.
      if (code === 0 || ['SIGINT', 'SIGTERM', 'SIGHUP'].includes(signal)) return process.exit(0);
      if (code === RESTART) { recovered = false; console.log('\n  Restarting Show Control with the new settings…\n'); return run(); }
      // Updated (or back to an earlier version): the started launcher chooses which one runs now.
      if (code === UPDATE) { console.log('\n  Restarting Show Control in another version…\n'); return HANDED ? process.exit(UPDATE) : start(); }
      // Crashed: start again. Back off if it keeps failing straight away (e.g. the port is taken).
      crashes = Date.now() - started < 20000 ? crashes + 1 : 0;
      recovered = true;
      const wait = Math.min(30, 2 ** crashes);
      console.log(`\n  Show Control stopped unexpectedly (${signal || `code ${code}`}). Starting it again in ${wait} s…\n`);
      setTimeout(run, wait * 1000);
    });
  };
  const banner = async (urls, mode) => {
    if (!BACKGROUND) console.clear();
    const ipad = urls[0];
    const line = '─'.repeat(64);
    const what = { practice: 'practice mode: pretend equipment', training: 'TRAINING: pretend equipment', live: 'live: real equipment' }[mode];
    console.log(`\n${line}\n  SHOW CONTROL IS RUNNING   (${what})\n${line}`);
    console.log(`  On this computer:  http://localhost:${port}`);
    console.log(`  On your iPad:      ${ipad || '(connect this computer to Wi-Fi first)'}`);
    if (ipad) console.log('\n  Scan this with the iPad camera:\n\n' + (await QRCode.toString(ipad, { type: 'terminal', small: true })));
    console.log(`  Leave this window open while you use it. Close the window to stop Show Control.`);
    if (mode === 'practice') console.log('  To use your real equipment: System tab > Set up real equipment.');
    if (mode === 'training') console.log('  To go back to the real show: System tab > Training > End training.');
    console.log(`${line}\n`);
    if (!opened) { opened = true; openBrowser(`http://localhost:${port}/connect`); }
  };
  stopNow = () => { stopping = true; child?.kill(); setTimeout(() => process.exit(0), 300); };
  run();
}

start();
