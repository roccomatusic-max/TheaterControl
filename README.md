# Show Control

One touch-friendly control surface for the whole show, served from an always-on show computer
and used from an iPad or phone in a browser. It works with no internet.

| System | Protocol | Status |
|---|---|---|
| ETC Eos / Ion / Gio / Element 2 | OSC over TCP 3037 (SLIP), or UDP | GO / Back, fire cue, macros, subs, channel levels, command line; shows active/pending cue |
| Yamaha TF1/3/5 | Yamaha remote control protocol, TCP 49280 | Input + DCA + stereo faders and on/off, two-way (moves on the desk show on the iPad), scene recall |
| QLab 4/5 | OSC over UDP 53000 | GO, stop, panic, pause/resume, playhead, start any cue; shows playhead + running cues |
| PTZ cameras | VISCA-over-IP (UDP 52381) or raw VISCA TCP (5678) | Joystick pan/tilt, zoom, focus, presets (tap = recall, hold = store), tally, home, power |
| Camera video | go2rtc / MediaMTX → WebRTC, or MJPEG/HLS | Live view on the iPad, low latency |
| Panasonic projectors (PT-DZ13K, PT-DZ770 series) | Panasonic LAN protocol, TCP 1024 (+ PJLink for health) | Power with confirmation, shutter, inputs, lamp hours, fan/lamp/temperature health, lens home |
| Any PJLink projector / display | PJLink class 1, TCP 4352 | Power, shutter, inputs, lamp hours, health, make/model |
| Anything else | Generic OSC out | Resolume, Millumin, Companion, TouchDesigner… |

**Show cues** tie it together: one GO can fire an Eos cue, a QLab cue, a TF scene and camera
presets, with optional per-action delays. There are also show/act timers, a lock button so a
pocketed phone can't fire anything, and an optional PIN.

<p>
  <img src="docs/screenshots/ipad-show.png" width="49%" alt="Show tab on iPad">
  <img src="docs/screenshots/ipad-cam.png" width="49%" alt="Camera tab on iPad">
</p>

## Stage manager and crew screens

Other people in the company open their own page on a phone, iPad or TV (same address, different page):

| Page | For | What it does |
|---|---|---|
| `/sm.html` | Stage manager | Big standby cue and GO, cue notes, which crew are standing by, show/act timers. Side panels: calls, rehearsal notes (tagged with the cue and show time, export to a spreadsheet), script with cue places that follows the show, show night checklist with sign-off, crew cue lights, countdown and lobby message |
| `/crew.html` | Crew phones | Pick your job once. Your own run sheet, a cue light that turns amber at standby (tap "Standing by") and green at GO, and calls like "Five minutes please" with a Got it button |
| `/foh.html` | Front of house manager | House not open / open / hold / closed / interval, seen instantly by the stage manager; calls; lobby message |
| `/lobby.html` | Lobby TV | The show name and a big countdown to the start or the end of the interval |

Crew roles, the checklist and the script are saved in the show file under `"crew"`; give a cue crew tasks in
Show → Edit cues. Notes, ticks and calls are kept across a restart. The 🌙 button on every screen switches
that device to a dim, red-only night mode for backstage.

## Easiest way to try it (Mac or Windows, nothing to install)

1. Go to [Releases](https://github.com/roccomatusic-max/TheaterControl/releases) and download
   **ShowControl-mac.zip** or **ShowControl-windows.zip**.
2. Open the zip (on Windows: right-click → Extract All).
3. Double-click **Show Control.command** (Mac) or **Start Show Control.bat** (Windows).
   - **Mac, first time only:** macOS says it can't check the app for malware. Click **Done**, open
     **System Settings → Privacy & Security**, scroll down and click **Open Anyway**, then enter your password.
   - **Windows:** if "Windows protected your PC" appears, click **More info → Run anyway**. If the
     firewall asks about Node.js, allow it on private networks.
4. Your browser opens with a QR code. Scan it with the iPad camera to open the controls on the iPad.

It starts in **practice mode** with simulated equipment. To use your real gear, open
**System → Set up real equipment** on the iPad: type each device's address, tap **Test**, then **Go live**.
Each device has a "How to set it up" list for the settings to turn on at the device. Show Control restarts
itself into live mode, and your cue list comes with you. The setup is saved in `Show Control/show.json` in
your home folder (`"live": false` there means practice mode). On the same screen you can make Show Control
start automatically when the computer turns on; while it runs, a Mac is kept from going to sleep.

To build the downloads yourself: `npm run package`. When `main` gets a new `version` in `package.json`, GitHub Actions publishes a release with both downloads.

## Try it now (no hardware, for developers)

```bash
npm install
npm run sim        # fake Eos, TF5, QLab, 3 PTZ cams, projector + the server
# open http://<this-computer>:8080 on your iPad or phone
npm test           # end-to-end checks against the simulators (show + projection)
```

The simulators speak the real protocols, so the same drivers talk to the real gear.

## Run it for real

1. Install Node.js 20+ on the show server and copy this folder to it.
2. `npm install --omit=dev`
3. Edit `config/show.json` (start from `config/show.example.json`): device IPs, cameras, show cues.
4. `npm start`, then open the printed URL on the iPad. In Safari use **Share → Add to Home Screen** to get a full-screen app.
5. To run it 24/7, use `deploy/show-control.service` (Linux), `deploy/com.show-control.plist` (macOS),
   or on Windows `nssm install ShowControl "C:\Program Files\nodejs\node.exe" server\index.js`.

### Console / device setup

- **Eos**: Setup → Show/System → Shell (Setup) → Network: enable **OSC TCP** (Eos v3+ listens on 3037,
  SLIP framing) and give the console a static IP on the show network. If you use UDP instead,
  set the OSC UDP RX/TX ports and `"transport": "udp"`.
- **TF5**: set a static IP on the desk (Setup → Network). No other setting needed. Scene recall uses
  `ssrecall_ex scene_a <n>`. Check this on the real desk first, because the scene command syntax varies by firmware.
- **QLab 5**: Workspace Settings → Network: allow OSC, and set a passcode if you want one (put it in
  `"passcode"`).
- **PTZ**: set static IPs and enable VISCA-over-IP (Sony style, UDP 52381) or note the TCP port
  for PTZOptics-style raw VISCA (`"protocol": "visca-tcp", "port": 5678`).
- **Panasonic projectors**: give each a static IP. If the projector has a web-control password,
  put its login in `"username"` (usually `admin1`) and `"password"`. PJLink should stay enabled,
  because that's where fan, lamp and temperature health comes from.
- **Other projectors**: enable PJLink and set its password in `"password"`.

## Network

```
                 ┌──────────── Show network (wired, isolated, no internet) ────────────┐
                 │  Eos 10.101.100.101   TF5 .50.20   QLab Mac .50.10                    │
                 │  PTZ cams .60.11-13   Projector .60.30                               │
                 └──────────────────────────────┬──────────────────────────────────────┘
                                                │ NIC 1
                                       ┌────────┴────────┐
                                       │   Show server   │  Show Control + go2rtc + Tailscale
                                       └────────┬────────┘
                                                │ NIC 2
                 ┌──────────── Control network (Wi-Fi AP + router with internet) ──────┐
                 │  iPad, phone                         internet ⇄ Tailscale (remote fix) │
                 └──────────────────────────────────────────────────────────────────────┘
```

- Only the server is on both networks. The iPad never talks to the gear directly, and nothing on
  the show network can reach the internet.
- Set `"server": { "host": "<control-NIC-IP>" }` to serve the UI only on the control network.
- **Remote access**: install Tailscale on the server and your phone/laptop. It only makes outbound connections, so there's
  no port forwarding. From anywhere, open `http://<server-tailscale-name>:8080`, or SSH/remote desktop in.
- Use a dedicated 5 GHz access point for the control network with a hidden SSID and WPA2/3. Don't share it with the house or cast Wi-Fi.
- Turn off automatic OS updates and sleep on the server during the run.
- If the TF5 carries Dante, keep Dante on its own network or VLAN.

## Projection

The **Projection** tab works like Projector Control, without mapping. It has:

- Groups from `"projection": { "groups": [...] }` plus a built-in **All projectors** group.
  Show cues address a group as `"device": "group:foh"`.
- **Close all shutters** on the Show tab, which blanks every projector in one tap.
- A clear result from each projector for every command. The app keeps these outcomes separate: *busy*
  (for example cooling down), *rejected*, *unsupported*, *timed out*, *password refused* and
  *not sent*. A projector that's cooling down is never reported as "can't do that".

It uses the same safety rules as Projector Control:

- **Power is confirmed by reading it back.** A power command is never retried after a timeout, and the app queries the projector instead.
- **Panasonic shutter polarity lives in one place** (`OSH:1` = closed).
- **Commands only documented for sibling models aren't sent** unless that projector has
  `"allowUnverified": true`. Freeze is the one such command today.
- **The app never shows a number the projector didn't report.** Unknown values show as `—`, and the
  Panasonic temperatures that aren't read show as "not read".
- **An input the projector refuses while it's on and settled is crossed out** on that unit
  (for example, SDI with no SDI board fitted).

Nothing has been tested on a physical projector yet. Before the first show, use the
[hardware validation steps](https://github.com/roccomatusic-max/Projectionmapping/blob/main/docs/HARDWARE-VALIDATION.md)
from Projector Control.

## Video

Browsers (especially iPad Safari) can't play RTSP or NDI directly. Run **go2rtc** on the server
(`deploy/go2rtc.yaml`). It pulls each camera's RTSP once and serves WebRTC to every tablet with
well under a second of delay. In the camera config:

```json
"stream": { "type": "go2rtc", "url": "http://<server>:1984", "src": "cam1" }
```

Other options: `"mediamtx"` (MediaMTX WebRTC page), `"mjpeg"` (camera's own MJPEG URL),
`"hls"` (works natively on iOS, a few seconds of delay), `"iframe"`.
For NDI|HX cameras, turn on their RTSP output, or bridge NDI to RTSP on the server.
For recording or streaming the show, OBS on the server can take the same feeds.

## How it's built

```
server/index.js          HTTP + WebSocket hub, show cue stack, timers, PIN, log
server/drivers/*.js      one driver per device type; each exposes status, state, command()
server/lib/osc.js        OSC encode/decode + SLIP framing (no dependencies)
public/                  the iPad/phone app (plain JS/CSS, no build step, no CDN)
sim/                     protocol-accurate fake devices
config/*.json            device list, show cues, UI layout
```

Adding a device type means adding one file in `server/drivers/` and one line in `drivers/index.js`.

## Next ideas

- Projection mapping (shared with Projector Control's mapping module)
- Cue editor in the UI (today cues are edited in `config/show.json`)
- MIDI Show Control / MIDI timecode out (USB MIDI interface on the server)
- LTC/MTC display and chase, Clear-Com/Green-GO comms status, Stream Deck via Bitfocus Companion
- Backstage and front-of-house paging through QLab
- Per-user roles (SM: GO only; TD: everything)
