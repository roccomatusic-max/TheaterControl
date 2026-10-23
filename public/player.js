// Live camera player, shared by the app, the TV screen page and the phone camera page.
// Plays a camera through Show Control's /video (the bundled go2rtc relay): WebRTC first, well
// under a second of delay; if that can't get through, HLS (Safari) or an MP4 stream instead.
// Reconnects by itself, and closes when it is taken off the page.
'use strict';
window.LiveVideo = (() => {
  const players = new Set();
  setInterval(() => { for (const p of players) if (!p.el.isConnected) p.close(); }, 2000);

  const gathered = pc => new Promise(r => {
    if (pc.iceGatheringState === 'complete') return r();
    pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && r());
    setTimeout(r, 1500); // the host addresses are enough on a local network
  });

  // Sends a WebRTC offer to the relay and returns its answer (go2rtc speaks plain SDP over HTTP).
  async function signal(pc, query) {
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
    const r = await fetch(`video/api/webrtc?${query}`, { method: 'POST', body: pc.localDescription.sdp, headers: { 'content-type': 'application/sdp' } });
    const text = await r.text();
    if (!r.ok) throw Object.assign(new Error(text || `error ${r.status}`), { status: r.status });
    await pc.setRemoteDescription({ type: 'answer', sdp: text });
  }

  function create(src) {
    const video = document.createElement('video');
    video.muted = true; video.autoplay = true; video.playsInline = true;
    video.setAttribute('playsinline', ''); video.setAttribute('muted', '');
    const msg = document.createElement('div'); msg.className = 'vmsg';
    const el = document.createElement('div'); el.className = 'livevid'; el.append(video, msg);
    let pc = null, timer = null, closed = false, mode = 'webrtc', fails = 0;
    const say = t => { msg.textContent = t || ''; msg.hidden = !t; };
    const later = (fn, ms) => { clearTimeout(timer); if (!closed) timer = setTimeout(fn, ms); };
    const drop = () => { if (pc) { pc.onconnectionstatechange = null; pc.close(); pc = null; } };

    async function webrtc() {
      drop(); say('Connecting…');
      const me = pc = new RTCPeerConnection();
      me.addTransceiver('video', { direction: 'recvonly' });
      me.addTransceiver('audio', { direction: 'recvonly' });
      me.ontrack = e => { if (!(video.srcObject instanceof MediaStream)) { video.removeAttribute('src'); video.srcObject = new MediaStream(); } video.srcObject.addTrack(e.track); video.play().catch(() => {}); };
      me.onconnectionstatechange = () => {
        if (me !== pc) return;
        if (me.connectionState === 'connected') { fails = 0; say(''); }
        if (me.connectionState === 'failed') { say('Video lost. Reconnecting…'); later(start, 1500); }
        if (me.connectionState === 'disconnected') later(() => me === pc && me.connectionState !== 'connected' && start(), 4000);
      };
      try { await signal(me, `src=${encodeURIComponent(src)}`); }
      catch (e) {
        if (me !== pc) return;
        drop();
        if (e.status === 404) return say('This camera has no video address. Add it in System > Equipment setup.');
        if (e.status === 401) return say('Sign in to see video.');
        say(e.status === 503 ? `Video is starting… (${e.message})` : 'No video from the camera yet. Trying again…');
        return later(start, e.status === 503 ? 2000 : Math.min(15000, 2000 * ++fails));
      }
      // Connected on paper but no picture after a while: WebRTC is blocked somewhere, use the fallback.
      later(() => { if (me === pc && !video.videoWidth) { mode = 'stream'; start(); } }, 8000);
    }

    function stream() {
      drop(); say('Connecting (slower mode)…');
      const hls = video.canPlayType('application/vnd.apple.mpegurl');
      video.srcObject = null;
      video.src = `video/api/stream.${hls ? 'm3u8' : 'mp4'}?src=${encodeURIComponent(src)}&t=${Date.now()}`;
      video.play().catch(() => {});
      video.onplaying = () => say('');
      video.onerror = () => { say('No video from the camera yet. Trying again…'); mode = 'webrtc'; later(start, Math.min(15000, 2000 * ++fails)); };
    }

    function start() { if (closed) return; clearTimeout(timer); mode === 'webrtc' ? webrtc() : stream(); }
    function close() { closed = true; clearTimeout(timer); drop(); video.removeAttribute('src'); video.srcObject = null; players.delete(p); }

    const p = { el, video, close, src };
    players.add(p);
    start();
    return p;
  }

  // A still from any playing <video> or <canvas>, as a JPEG data URL (at most 1280 wide).
  function snapshot(media) {
    const w0 = media.videoWidth || media.width, h0 = media.videoHeight || media.height;
    if (!w0) return null;
    const k = Math.min(1, 1280 / w0), c = document.createElement('canvas');
    c.width = Math.round(w0 * k); c.height = Math.round(h0 * k);
    c.getContext('2d').drawImage(media, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.85);
  }

  return { create, snapshot, signal, gathered };
})();
