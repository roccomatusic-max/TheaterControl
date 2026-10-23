// Small HTTP client with a hard timeout, for devices with a web API (Companion, Panasonic
// cameras, smart relays). Never throws: returns { status, body } or { error }.
const http = require('http');
const https = require('https');

function request({ host, port, path = '/', method = 'GET', body, headers = {}, https: secure = false, timeout = 3000, user, password }) {
  return new Promise(resolve => {
    const data = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const h = { ...headers };
    if (data) { h['Content-Length'] = data.length; if (!h['Content-Type']) h['Content-Type'] = typeof body === 'string' ? 'text/plain' : 'application/json'; }
    if (user) h.Authorization = `Basic ${Buffer.from(`${user}:${password || ''}`).toString('base64')}`;
    const req = (secure ? https : http).request({ host, port: port || (secure ? 443 : 80), path: path.startsWith('/') ? path : `/${path}`, method, headers: h, timeout, rejectUnauthorized: false }, res => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', d => { if (out.length < 65536) out += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ error: 'ETIMEDOUT no answer' }); });
    req.on('error', e => resolve({ error: `${e.code || ''} ${e.message}`.trim() }));
    if (data) req.write(data);
    req.end();
  });
}

module.exports = { request };
