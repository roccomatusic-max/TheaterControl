// Double-click launcher used by the Mac and Windows downloads (see scripts/package.js).
// Practice mode (simulated devices) unless the user has a real show file at
// ~/Show Control/show.json (made by the Setup screen; "live": false keeps practice mode).
// Opens the browser and prints the iPad address + QR code. Runs the server as a child
// process and restarts it after a switch between practice and live, or if it ever crashes.
// --background (used when starting with the computer): no browser, no screen clearing.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { execFile, fork, spawn } = require('child_process');
const QRCode = require('qrcode');

const ROOT = path.join(__dirname, '..');
const USER_DIR = path.join(os.homedir(), 'Show Control');
const USER_CFG = path.join(USER_DIR, 'show.json');
// Cue edits made in practice mode are kept here, so updating the app never loses them.
const PRACTICE_CFG = path.join(USER_DIR, 'practice-show.json');
const SIM_CFG = path.join(ROOT, 'config/show.sim.json');
const BACKGROUND = process.argv.includes('--background');
const RESTART = 75;
const isLive = () => { try { return JSON.parse(fs.readFileSync(USER_CFG, 'utf8')).live !== false; } catch { return false; } };

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

(async () => {
  const firstCfg = isLive() ? USER_CFG : fs.existsSync(PRACTICE_CFG) ? PRACTICE_CFG : SIM_CFG;
  const wanted = Number(process.env.PORT || JSON.parse(fs.readFileSync(firstCfg, 'utf8')).server?.port || 8080);

  if (await alreadyRunning(wanted)) {
    console.log('\n  Show Control is already running. Opening it in your browser.\n');
    if (!BACKGROUND) openBrowser(`http://localhost:${wanted}/connect`);
    return setTimeout(() => process.exit(0), 500);
  }
  let port = wanted;
  while (!(await portFree(port)) && port < wanted + 20) port++;
  // The show computer must not go to sleep while Show Control runs (Mac; the display may still sleep).
  if (process.platform === 'darwin') spawn('caffeinate', ['-is', '-w', String(process.pid)], { stdio: 'ignore' }).on('error', () => {});

  let child = null, stopping = false, started = 0, crashes = 0, opened = BACKGROUND, recovered = false;
  const run = () => {
    if (stopping) return;
    const practice = !isLive();
    if (practice && fs.existsSync(USER_CFG)) try { JSON.parse(fs.readFileSync(USER_CFG, 'utf8')); } catch (e) {
      console.log(`\n  Your show file has a mistake in it, so Show Control is starting in practice mode.\n  ${USER_CFG}: ${e.message}\n  Saving on the Setup screen replaces it (the old one is kept as show.json.bak).\n`);
    }
    const cfgPath = !practice ? USER_CFG : fs.existsSync(PRACTICE_CFG) ? PRACTICE_CFG : SIM_CFG;
    started = Date.now();
    child = fork(path.join(__dirname, 'run.js'), [cfgPath], {
      env: {
        ...process.env, PORT: String(port), SHOW_QUIET: '1', // device activity is in the System tab; keep this window readable
        SHOW_MODE: practice ? 'practice' : 'live', SHOW_SAVE_PATH: practice ? PRACTICE_CFG : USER_CFG, SHOW_LIVE_PATH: USER_CFG,
        SHOW_PRACTICE_PATH: PRACTICE_CFG, SHOW_SIM_CONFIG: SIM_CFG, SHOW_SUPERVISED: '1', SHOW_SIMS: practice ? '1' : '',
        SHOW_RECOVERED: recovered ? '1' : '', // started again after a crash: raise an alert
      },
    });
    child.on('message', m => { if (m?.t === 'ready') banner(m.urls, practice); });
    child.on('exit', (code, signal) => {
      child = null;
      if (stopping) return;
      // Stopped on purpose (window closed, Ctrl-C, shutdown): stop the launcher too.
      if (code === 0 || ['SIGINT', 'SIGTERM', 'SIGHUP'].includes(signal)) return process.exit(0);
      if (code === RESTART) { recovered = false; console.log('\n  Restarting Show Control with the new settings…\n'); return run(); }
      // Crashed: start again. Back off if it keeps failing straight away (e.g. the port is taken).
      crashes = Date.now() - started < 20000 ? crashes + 1 : 0;
      recovered = true;
      const wait = Math.min(30, 2 ** crashes);
      console.log(`\n  Show Control stopped unexpectedly (${signal || `code ${code}`}). Starting it again in ${wait} s…\n`);
      setTimeout(run, wait * 1000);
    });
  };
  const banner = async (urls, practice) => {
    if (!BACKGROUND) console.clear();
    const ipad = urls[0];
    const line = '─'.repeat(64);
    console.log(`\n${line}\n  SHOW CONTROL IS RUNNING${practice ? '   (practice mode: pretend equipment)' : '   (live: real equipment)'}\n${line}`);
    console.log(`  On this computer:  http://localhost:${port}`);
    console.log(`  On your iPad:      ${ipad || '(connect this computer to Wi-Fi first)'}`);
    if (ipad) console.log('\n  Scan this with the iPad camera:\n\n' + (await QRCode.toString(ipad, { type: 'terminal', small: true })));
    console.log(`  Leave this window open while you use it. Close the window to stop Show Control.`);
    if (practice) console.log('  To use your real equipment: System tab > Set up real equipment.');
    console.log(`${line}\n`);
    if (!opened) { opened = true; openBrowser(`http://localhost:${port}/connect`); }
  };
  const quit = () => { stopping = true; child?.kill(); setTimeout(() => process.exit(0), 300); };
  process.on('SIGINT', quit); process.on('SIGTERM', quit); process.on('SIGHUP', quit);
  run();
})().catch(e => { console.error('\n  Show Control could not start:', e.message, '\n'); process.exitCode = 1; });
