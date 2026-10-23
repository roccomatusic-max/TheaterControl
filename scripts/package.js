// Builds the double-click downloads: dist/ShowControl-mac.zip and dist/ShowControl-windows.zip.
// Each bundles an official Node.js runtime, so nothing has to be installed on the show computer.
// Runs on Linux or macOS (needs curl, tar, unzip, zip). Used by .github/workflows/release.yml.
const { execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const NODE_VERSION = process.env.BUNDLED_NODE || 'v22.22.0';
// go2rtc: the video relay that gives live camera video, recording and phone cameras (MIT licence).
// Pinned version and checksums, checked on every download.
const GO2RTC = 'v1.9.14';
const GO2RTC_SUMS = {
  'go2rtc_mac_arm64.zip': '919b78adc759d6b3883d1e1b2ac915ac0985bb903ff1897b4d228527bd64690c',
  'go2rtc_mac_amd64.zip': '9b0b9a27a4dc3a5b8b93376e7e8fc2787c6af624a512842622be84aec0171c7a',
  'go2rtc_win64.zip': 'dd4167d75cb04abe618855b7c71f8658bd009f60c1a71835d134d2c11c939907',
  'go2rtc_linux_amd64': '32d616af226bd731678ffde328b94cfb94e30339bfefc469cfb76323144615a6',
  'go2rtc_linux_arm64': '359fabade8a7a51e81a55fe6df6b0ef81764a5e1d63179577534eaaa71904b50',
  LICENSE: 'b0dcf4855af5a72b4dfbd9117c207b330f4cc35658576a0b5351d6e2becac546',
};
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const CACHE = path.join(ROOT, '.cache', 'node');
const version = require('../package.json').version;
const sh = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', ...opts });

const APP_FILES = ['server', 'public', 'sim', 'config', 'launcher', 'deploy', 'plugins', 'package.json', 'package-lock.json', 'README.md'];

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

function downloadGo2rtc(file) {
  const dir = path.join(ROOT, '.cache', 'go2rtc', GO2RTC);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, file);
  const url = file === 'LICENSE' ? `https://raw.githubusercontent.com/AlexxIT/go2rtc/${GO2RTC}/LICENSE` : `https://github.com/AlexxIT/go2rtc/releases/download/${GO2RTC}/${file}`;
  if (!fs.existsSync(dest)) sh(`curl -fsSL -o "${dest}" ${url}`);
  const got = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
  if (got !== GO2RTC_SUMS[file]) { fs.rmSync(dest); throw new Error(`checksum mismatch for ${file}`); }
  return dest;
}
// Puts the go2rtc binary from `file` (a zip, or the bare binary) at runtime/<sub>/<name>.
function addGo2rtc(app, file, sub, name) {
  const src = downloadGo2rtc(file);
  const out = path.join(app, 'runtime', sub);
  fs.mkdirSync(out, { recursive: true });
  if (file.endsWith('.zip')) sh(`unzip -q -o "${src}" -d "${out}"`);
  else fs.copyFileSync(src, path.join(out, name));
  fs.chmodSync(path.join(out, name), 0o755);
  fs.copyFileSync(downloadGo2rtc('LICENSE'), path.join(app, 'runtime', 'go2rtc-LICENSE.txt'));
}

function stageApp(dir) {
  const app = path.join(dir, 'app');
  fs.mkdirSync(app, { recursive: true });
  // never ship files a test run or a show left behind (video settings, certificates, recordings, notes)
  const skip = src => /^config[\\/](\.|Recordings|Notes)/.test(path.relative(ROOT, src));
  for (const f of APP_FILES) fs.cpSync(path.join(ROOT, f), path.join(app, f), { recursive: true, filter: src => !skip(src) });
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

REAL EQUIPMENT: on the iPad, open System > Set up real equipment. Type
the address of each device, tap Test, then tap Go live. Each device has
step-by-step help for the settings to turn on at the device itself.
On that screen you can also make Show Control start by itself when this
computer turns on.

CAMERAS: live camera video, recording and phone cameras work by
themselves. ${platform === 'mac' ? 'If your Mac asks whether "go2rtc" may accept incoming network\nconnections, click Allow: that is the video relay.' : 'If the firewall asks about "go2rtc", tick "Private networks" and\nclick "Allow": that is the video relay.'}

Node.js ${NODE_VERSION} is included (MIT licence, see app/runtime).
go2rtc ${GO2RTC} is included for camera video (MIT licence, see app/runtime).
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
    addGo2rtc(app, `go2rtc_mac_${arch === 'x64' ? 'amd64' : 'arm64'}.zip`, `darwin-${arch}`, 'go2rtc');
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
  addGo2rtc(app, 'go2rtc_win64.zip', '', 'go2rtc.exe');
  fs.writeFileSync(path.join(dir, 'Start Show Control.bat'), [
    '@echo off', 'title Show Control', 'cd /d "%~dp0app"', 'runtime\\node.exe launcher\\start.js', 'echo.', 'pause', '',
  ].join('\r\n'));
  fs.writeFileSync(path.join(dir, 'READ ME FIRST.txt'), README('windows').replace(/\n/g, '\r\n'));
  zip('ShowControl-windows.zip', dir);
}

// For running from source: `node scripts/package.js video` puts go2rtc for this computer in runtime/.
function devVideo() {
  const key = `${process.platform}-${process.arch}`;
  const pick = { 'darwin-arm64': ['go2rtc_mac_arm64.zip', 'darwin-arm64', 'go2rtc'], 'darwin-x64': ['go2rtc_mac_amd64.zip', 'darwin-x64', 'go2rtc'],
    'win32-x64': ['go2rtc_win64.zip', '', 'go2rtc.exe'], 'linux-x64': ['go2rtc_linux_amd64', 'linux-x64', 'go2rtc'], 'linux-arm64': ['go2rtc_linux_arm64', 'linux-arm64', 'go2rtc'] }[key];
  if (!pick) throw new Error(`no go2rtc download for ${key}`);
  addGo2rtc(ROOT, ...pick);
  console.log(`go2rtc ${GO2RTC} installed in runtime/${pick[1] ? `${pick[1]}/` : ''}`);
}

const only = process.argv[2];
if (only === 'video') { devVideo(); process.exit(0); }
fs.mkdirSync(DIST, { recursive: true });
if (!only || only === 'mac') buildMac();
if (!only || only === 'windows') buildWindows();
