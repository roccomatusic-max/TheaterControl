// Just enough RTSP to ask a camera "do you have video at this address?" (DESCRIBE), with
// the camera's password if it needs one. Used by the Setup screen's "Find video" button.
const net = require('net');
const crypto = require('crypto');

const md5 = s => crypto.createHash('md5').update(s).digest('hex');

// One DESCRIBE request. Resolves { status, headers, sdp } or rejects with a network error.
function describe(url, auth, ms = 3000) {
  const u = new URL(url);
  const clean = `rtsp://${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}${u.search}`;
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(u.port) || 554, u.hostname);
    let buf = '';
    const done = (err, val) => { clearTimeout(timer); sock.destroy(); err ? reject(err) : resolve(val); };
    const timer = setTimeout(() => done(Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' })), ms);
    sock.on('connect', () => sock.write(`DESCRIBE ${clean} RTSP/1.0\r\nCSeq: 2\r\nAccept: application/sdp\r\nUser-Agent: ShowControl\r\n${auth ? `Authorization: ${auth(clean)}\r\n` : ''}\r\n`));
    sock.on('data', d => {
      buf += d.toString('latin1');
      const end = buf.indexOf('\r\n\r\n'); if (end < 0) return;
      const [first, ...lines] = buf.slice(0, end).split('\r\n');
      const status = Number(first.split(' ')[1]) || 0;
      const headers = {};
      for (const l of lines) { const i = l.indexOf(':'); if (i > 0) (headers[l.slice(0, i).trim().toLowerCase()] ||= []).push(l.slice(i + 1).trim()); }
      const want = Number(headers['content-length']?.[0] || 0);
      if (buf.length - end - 4 < want) return;
      done(null, { status, headers, sdp: buf.slice(end + 4, end + 4 + want) });
    });
    sock.on('error', e => done(e));
  });
}

function authFor(header, user, pass) {
  if (/^Basic/i.test(header)) return () => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  const get = k => (header.match(new RegExp(`${k}="([^"]*)"`, 'i')) || [])[1];
  const realm = get('realm'), nonce = get('nonce');
  return uri => `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${md5(`${md5(`${user}:${realm}:${pass}`)}:${nonce}:${md5(`DESCRIBE:${uri}`)}`)}"`;
}

// Is there a video stream at this rtsp:// address? { ok, needsPassword, codec, detail }
async function probe(url, ms) {
  let u; try { u = new URL(url); } catch { return { ok: false, detail: 'That is not a video address.' }; }
  if (u.protocol !== 'rtsp:') return { ok: false, detail: 'Video addresses start with rtsp://' };
  const user = decodeURIComponent(u.username), pass = decodeURIComponent(u.password);
  let r = await describe(url, null, ms);
  if (r.status === 401) {
    if (!user) return { ok: false, needsPassword: true, detail: 'The camera wants a username and password for its video.' };
    // prefer Digest; some cameras offer both
    const offers = r.headers['www-authenticate'] || [];
    r = await describe(url, authFor(offers.find(h => /^Digest/i.test(h)) || offers[0] || 'Basic', user, pass), ms);
    if (r.status === 401) return { ok: false, needsPassword: true, detail: 'The camera turned down that username and password.' };
  }
  if (r.status !== 200) return { ok: false, status: r.status, detail: r.status === 404 ? 'The camera has no video at that address.' : `The camera answered "${r.status}".` };
  const codec = (r.sdp.match(/a=rtpmap:\d+ (H264|H265|HEVC|MJPEG|JPEG|MP4V-ES)/i) || [])[1];
  return { ok: true, codec: codec ? codec.toUpperCase().replace('HEVC', 'H265') : null, detail: `Video found${codec ? ` (${codec.toUpperCase()})` : ''}.` };
}

// The usual video addresses for common cameras, sub (smaller) stream first: it is kinder to
// iPads and the Wi-Fi. "Find video" tries each against the camera until one answers.
const PATHS = [
  ['PTZOptics', ':554/2'], ['PTZOptics', ':554/1'],
  ['Sony', ':554/media/video2'], ['Sony', ':554/media/video1'],
  ['Panasonic', ':554/MediaInput/h264/stream_2'], ['Panasonic', ':554/MediaInput/h264/stream_1'], ['Panasonic', ':554/MediaInput/h264'],
  ['Marshall', ':554/live/av1'], ['Marshall', ':554/live/av0'],
  ['Lumens', ':8557/h264'], ['Lumens', ':8554/h264'],
  ['AVer', ':554/live_st2'], ['AVer', ':554/live_st1'],
  ['BirdDog', ':554/live/stream1'], ['BirdDog', ':554/live/stream0'],
  ['Canon', ':554/stream/h264/2'], ['Canon', ':554/stream/h264/1'],
  ['Hikvision', ':554/Streaming/Channels/102'], ['Hikvision', ':554/Streaming/Channels/101'],
  ['Dahua / Amcrest', ':554/cam/realmonitor?channel=1&subtype=1'], ['Dahua / Amcrest', ':554/cam/realmonitor?channel=1&subtype=0'],
  ['Axis', ':554/axis-media/media.amp'],
  ['Reolink', ':554/h264Preview_01_sub'], ['Reolink', ':554/h264Preview_01_main'],
  ['TP-Link Tapo', ':554/stream2'], ['TP-Link Tapo', ':554/stream1'],
  ['Generic', ':554/live'], ['Generic', ':554/stream1'], ['Generic', ':554/'],
];

// Tries the usual addresses on `host`. Stops at the first that has video.
async function find(host, { user = '', pass = '', ms = 2500 } = {}) {
  const cred = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : '';
  let needsPassword = false, reached = false;
  // Only ask on the ports that are open, so a wrong address doesn't take minutes.
  const ports = [...new Set(PATHS.map(([, p]) => Number(p.slice(1).split('/')[0])))];
  const open = new Set((await Promise.all(ports.map(port => new Promise(res => {
    const s = net.connect(port, host); s.setTimeout(ms);
    s.on('connect', () => { s.destroy(); res(port); }); s.on('timeout', () => { s.destroy(); res(null); }); s.on('error', () => res(null));
  })))).filter(Boolean));
  for (const [brand, p] of PATHS.filter(([, p]) => open.has(Number(p.slice(1).split('/')[0])))) {
    const url = `rtsp://${cred}${host}${p}`;
    try {
      const r = await probe(url, ms);
      reached = true;
      if (r.ok) return { ...r, url, brand };
      if (r.needsPassword) needsPassword = true;
    } catch (e) { if (e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT') continue; }
  }
  return { ok: false, needsPassword, detail: needsPassword ? 'The camera has video but wants its username and password. Type them and try again.'
    : reached ? 'The camera answered, but not at any of the usual video addresses. Type the address from its manual (it starts with rtsp://).'
      : 'Nothing answered for video at that address. Check the camera has RTSP (video streaming) turned on in its settings.' };
}

module.exports = { probe, find, PATHS };
