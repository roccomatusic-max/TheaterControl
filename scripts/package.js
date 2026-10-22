// Builds the double-click downloads: dist/ShowControl-mac.zip and dist/ShowControl-windows.zip.
// Each bundles an official Node.js runtime, so nothing has to be installed on the show computer.
// Runs on Linux or macOS (needs curl, tar, unzip, zip). Used by .github/workflows/release.yml.
const { execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const NODE_VERSION = process.env.BUNDLED_NODE || 'v22.22.0';
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const CACHE = path.join(ROOT, '.cache', 'node');
const version = require('../package.json').version;
const sh = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', ...opts });

const APP_FILES = ['server', 'public', 'sim', 'config', 'launcher', 'deploy', 'package.json', 'package-lock.json', 'README.md'];

let sums;
function download(file) {
  fs.mkdirSync(CACHE, { recursive: true });
  const dest = path.join(CACHE, file);
  const base = `https://nodejs.org/dist/${NODE_VERSION}`;
  if (!sums) sums = execSync(`curl -fsSL ${base}/SHASUMS256.txt`).toString();
  const want = sums.split('\n').find(l => l.endsWith(`  ${file}`))?.split(' ')[0];
  if (!want) throw new Error(`no checksum for ${file}`);
  if (!fs.existsSync(dest)) sh(`curl -fsSL -o "${dest}" ${base}/${file}`);
  const got = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
  if (got !== want) { fs.rmSync(dest); throw new Error(`checksum mismatch for ${file}`); }
  return dest;
}

function stageApp(dir) {
  const app = path.join(dir, 'app');
  fs.mkdirSync(app, { recursive: true });
  for (const f of APP_FILES) fs.cpSync(path.join(ROOT, f), path.join(app, f), { recursive: true });
  sh('npm ci --omit=dev --ignore-scripts --no-audit --no-fund --silent', { cwd: app });
  return app;
}

const README = (platform) => `SHOW CONTROL ${version}
${'='.repeat(20 + version.length)}

${platform === 'mac'
    ? `START:  double-click "Show Control.command".

The first time, your Mac will say it can't check the app for malware
(it isn't from the App Store). To allow it, once:
  1. Click "Done" on that message.
  2. Open System Settings > Privacy & Security.
  3. Scroll down, click "Open Anyway" next to "Show Control.command",
     and enter your Mac password.
After that, double-clicking just works.`
    : `START:  double-click "Start Show Control.bat".

If Windows shows "Windows protected your PC", click "More info" and then
"Run anyway". If the firewall asks about Node.js, tick "Private networks"
and click "Allow", so your iPad can connect.`}

A window opens showing the address for your iPad, with a code you can
scan with the iPad camera. Your web browser opens too.
Leave that window open while you use Show Control. Close it to stop.

PRACTICE MODE: until you set up your real equipment, everything runs
against simulated devices (lighting desk, sound desk, QLab, cameras and
projectors), so you can try every button safely.

REAL EQUIPMENT: put your show file at  Show Control/show.json  in your
home folder (start from app/config/show.example.json). The next start
uses it instead of the simulators.

Node.js ${NODE_VERSION} is included (MIT licence, see app/runtime).
`;

function zip(name, dir) {
  const out = path.join(DIST, name);
  fs.rmSync(out, { force: true });
  sh(`zip -q -r -y -X "${out}" "${path.basename(dir)}"`, { cwd: path.dirname(dir) });
  console.log(`built ${path.relative(ROOT, out)} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
}

function buildMac() {
  const dir = path.join(DIST, 'mac', 'Show Control');
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  const app = stageApp(dir);
  for (const arch of ['arm64', 'x64']) {
    const name = `node-${NODE_VERSION}-darwin-${arch}`;
    const tgz = download(`${name}.tar.gz`);
    const rt = path.join(app, 'runtime', `darwin-${arch}`);
    fs.mkdirSync(rt, { recursive: true });
    sh(`tar -xzf "${tgz}" -C "${rt}" --strip-components=2 ${name}/bin/node`);
    sh(`tar -xzf "${tgz}" -C "${path.join(app, 'runtime')}" --strip-components=1 ${name}/LICENSE`);
  }
  const cmd = path.join(dir, 'Show Control.command');
  fs.writeFileSync(cmd, `#!/bin/bash
# Show Control launcher: double-click to start. Close this window to stop.
HERE="$(cd "$(dirname "$0")" && pwd)"
# Once you've allowed this file to open, stop macOS asking again about the files inside.
xattr -dr com.apple.quarantine "$HERE" 2>/dev/null
cd "$HERE/app" || exit 1
case "$(uname -m)" in arm64) NODE=runtime/darwin-arm64/node ;; *) NODE=runtime/darwin-x64/node ;; esac
printf '\\033]0;Show Control\\007'
exec "$NODE" launcher/start.js
`);
  fs.chmodSync(cmd, 0o755);
  fs.writeFileSync(path.join(dir, 'READ ME FIRST.txt'), README('mac'));
  zip('ShowControl-mac.zip', dir);
}

function buildWindows() {
  const dir = path.join(DIST, 'windows', 'Show Control');
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  const app = stageApp(dir);
  const name = `node-${NODE_VERSION}-win-x64`;
  const z = download(`${name}.zip`);
  const rt = path.join(app, 'runtime');
  fs.mkdirSync(rt, { recursive: true });
  sh(`unzip -q -j -o "${z}" "${name}/node.exe" "${name}/LICENSE" -d "${rt}"`);
  fs.writeFileSync(path.join(dir, 'Start Show Control.bat'), [
    '@echo off', 'title Show Control', 'cd /d "%~dp0app"', 'runtime\\node.exe launcher\\start.js', 'echo.', 'pause', '',
  ].join('\r\n'));
  fs.writeFileSync(path.join(dir, 'READ ME FIRST.txt'), README('windows').replace(/\n/g, '\r\n'));
  zip('ShowControl-windows.zip', dir);
}

const only = process.argv[2];
fs.mkdirSync(DIST, { recursive: true });
if (!only || only === 'mac') buildMac();
if (!only || only === 'windows') buildWindows();
