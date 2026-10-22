// Double-click launcher used by the Mac and Windows downloads (see scripts/package.js).
// Practice mode (simulated devices) unless the user has a real show file at
// ~/Show Control/show.json. Opens the browser and prints the iPad address + QR code.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { execFile } = require('child_process');
const QRCode = require('qrcode');

const ROOT = path.join(__dirname, '..');
const USER_DIR = path.join(os.homedir(), 'Show Control');
const USER_CFG = path.join(USER_DIR, 'show.json');

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
  const practice = !fs.existsSync(USER_CFG);
  const cfgPath = practice ? path.join(ROOT, 'config/show.sim.json') : USER_CFG;
  const wanted = Number(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).server?.port || 8080);

  if (await alreadyRunning(wanted)) {
    console.log('\n  Show Control is already running. Opening it in your browser.\n');
    openBrowser(`http://localhost:${wanted}/connect`);
    return setTimeout(() => process.exit(0), 500);
  }
  let port = wanted;
  while (!(await portFree(port)) && port < wanted + 20) port++;
  process.env.PORT = String(port);
  process.env.SHOW_QUIET = '1'; // device activity is in the System tab; keep this window readable

  if (practice) require('../sim/devices');
  process.argv[2] = cfgPath;
  setTimeout(() => {
    const { server } = require('../server/index');
    server.on('ready', async ({ urls }) => {
      console.clear();
      const ipad = urls[0];
      const line = '─'.repeat(64);
      console.log(`\n${line}\n  SHOW CONTROL IS RUNNING${practice ? '   (practice mode: simulated devices)' : ''}\n${line}`);
      console.log(`  On this computer:  http://localhost:${port}`);
      console.log(`  On your iPad:      ${ipad || '(connect this computer to Wi-Fi first)'}`);
      if (ipad) console.log('\n  Scan this with the iPad camera:\n\n' + (await QRCode.toString(ipad, { type: 'terminal', small: true })));
      console.log(`  Leave this window open while you use it. Close the window to stop Show Control.`);
      if (practice) console.log(`  To use real equipment later, put your show file at: ${USER_CFG}`);
      console.log(`${line}\n`);
      openBrowser(`http://localhost:${port}/connect`);
    });
    server.on('error', e => { console.error(`\n  Could not start: ${e.message}\n`); });
  }, practice ? 300 : 0);
})().catch(e => { console.error('\n  Show Control could not start:', e.message, '\n'); process.exitCode = 1; });
