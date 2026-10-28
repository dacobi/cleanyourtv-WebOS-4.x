// Picture notifications from the local network: POST /notify with "Authorization: Bearer <token>" on a port of the TV
// (default 8767). Off until switched on in the manager app. It exposes the notification call only, nothing else of the
// service. Wrong tokens lock an address out for ten minutes; an optional "allow" list in config.json restricts addresses.
var http = require('http'),
  crypto = require('crypto');
var nc = require('./netcompat'),
  web = require('./web');
var DEFAULTS = { enabled: false, port: 8767, token: '', allow: [] };
var MAX_BODY = 32 * 1024,
  PER_MINUTE = 20;
function pageMs() {
  return +process.env.CYTV_NOTIFY_PAGE_MS || 10 * 60 * 1000; // how long the page behind the QR code works
}
var esc = web.esc,
  lanIp = web.lanIp;

function create(ctx) {
  var config = ctx.config;
  var notify = ctx.notify || ctx.feature('notify');
  /** @type {any} */
  var srv = null,
    port = 0,
    /** @type {{path: string, until: number}|null} */
    tokenPage = null; // tokenPage: { path, until }, a page that shows the token, for a phone that scans the QR code in the manager
  /** @type {Record<string, {n: number, t: number}>} */
  var fails = Object.create(null),
    /** @type {Record<string, {n: number, t: number}>} */
    hits = Object.create(null);
  function cfg() {
    return nc.assign({}, DEFAULTS, config.get().notifyApi || {});
  }
  function save(n) {
    return config.update('notifications', function (c) {
      c.notifyApi = n;
    });
  }
  function ipOk(ip, allow) {
    return allow.some(function (a) {
      // exact address or a /8, /16, /24 prefix such as 192.168.1.0/24
      var m = /^(\d+\.\d+\.\d+\.\d+)(?:\/(8|16|24))?$/.exec(String(a));
      if (!m) return false;
      if (!m[2]) return ip === m[1];
      var k = Number(m[2]) / 8;
      return ip.split('.').slice(0, k).join('.') === m[1].split('.').slice(0, k).join('.');
    });
  }
  function stop() {
    if (srv) {
      try {
        srv.close();
      } catch (_) {}
      srv = null;
      port = 0;
    }
    tokenPage = null;
  }

  function handler(req, res) {
    var ip = ((req.socket && req.socket.remoteAddress) || '').replace('::ffff:', '');
    function send(c, o) {
      res.writeHead(c, { 'content-type': 'application/json' });
      res.end(JSON.stringify(o));
    }
    var n = cfg();
    if (n.allow.length && !ipOk(ip, n.allow)) return send(403, { error: 'address not allowed' });
    // the page behind the QR code: GET /t/<random>, valid for ten minutes, shows the address and the token
    if (
      req.method === 'GET' &&
      tokenPage &&
      Date.now() < tokenPage.until &&
      String(req.url || '').split('?')[0] === '/t/' + tokenPage.path
    ) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(tokenHtml(n, lanIp()));
    }
    var now = Date.now(),
      f = fails[ip] || { n: 0, t: now };
    if (now - f.t > 600000) {
      f.n = 0;
      f.t = now;
    }
    if (f.n >= 10) return send(429, { error: 'too many wrong tokens; wait ten minutes' });
    var h = String(req.headers.authorization || ''),
      tok = h.indexOf('Bearer ') === 0 ? h.slice(7).trim() : '';
    var a = nc.bufFrom(tok),
      b = nc.bufFrom(n.token || '');
    if (!n.token || a.length !== b.length || !nc.timingSafeEqual(a, b)) {
      f.n++;
      fails[ip] = f;
      return send(401, { error: 'bad or missing token' });
    }
    var r = hits[ip] || { n: 0, t: now };
    if (now - r.t > 60000) {
      r.n = 0;
      r.t = now;
    }
    r.n++;
    hits[ip] = r;
    if (r.n > PER_MINUTE) return send(429, { error: 'too many notifications; at most ' + PER_MINUTE + ' a minute' });
    if (req.method !== 'POST' || String(req.url || '').split('?')[0] !== '/notify')
      return send(404, { error: 'POST /notify with a JSON body' });
    var body = '',
      big = false;
    req.on('data', function (c) {
      body += c;
      if (body.length > MAX_BODY) {
        big = true;
        nc.destroy(req);
      }
    });
    req.on('end', function () {
      if (big) return;
      var parsed;
      try {
        parsed = JSON.parse(body || '{}');
      } catch (_) {
        return send(400, { error: 'the body must be JSON' });
      }
      req.url = '/api/notify';
      Promise.resolve()
        .then(function () {
          return notify.handle(req, res, '/api/notify', function () {
            return Promise.resolve(parsed);
          });
        })
        .then(null, function (e) {
          send(500, { error: String(e.message || e) });
        });
    });
  }
  function tokenHtml(n, ip) {
    var addr = 'http://' + ip + ':' + n.port + '/notify',
      t = esc(n.token),
      a = esc(addr);
    return (
      '<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>CleanYourTV notifications</title>\n' +
      '<style>:root{color-scheme:light dark}*{box-sizing:border-box}body{font:18px/1.45 system-ui,sans-serif;max-width:640px;margin:28px auto;padding:0 18px}h1{font-size:24px;margin:0 0 4px}small,p{color:#777}\n' +
      '.box{border:1px solid #8884;border-radius:12px;padding:12px 14px;margin:6px 0 14px;word-break:break-all;font:16px/1.4 ui-monospace,Menlo,monospace;user-select:all}button{font:inherit;padding:8px 14px;border-radius:10px;border:1px solid #8886;background:#8882;color:inherit}\n' +
      'label{display:block;margin-top:16px;font-weight:600}</style>\n' +
      '<h1>CleanYourTV notifications</h1><p>Your TV accepts picture notifications at this address. The token is a secret: anyone who has it can show cards on the TV.</p>\n' +
      '<label>Address (POST)</label><div class=box id=a>' +
      a +
      '</div><button onclick="cp(\'a\')">Copy</button>\n' +
      '<label>Token</label><div class=box id=t>' +
      t +
      '</div><button onclick="cp(\'t\')">Copy</button>\n' +
      '<label>Header to send</label><div class=box id=h>Authorization: Bearer ' +
      t +
      '</div><button onclick="cp(\'h\')">Copy</button>\n' +
      '<p><small>This page works for ten minutes after the code was shown on the TV. Send a POST with a JSON body such as {"title":"Front door","text":"Someone is at the door","seconds":15}.</small></p>\n' +
      "<script>function cp(i){var e=document.getElementById(i),r=document.createRange();r.selectNodeContents(e);var s=getSelection();s.removeAllRanges();s.addRange(r);try{document.execCommand('copy')}catch(x){}}</script>"
    );
  }
  function start(p) {
    srv = http.createServer(handler);
    srv.setTimeout(10000);
    srv.on('error', function (e) {
      console.error('notification api:', e.message);
      srv = null;
      port = 0;
    });
    srv.listen(p, '0.0.0.0');
    port = p;
  }
  // make the listener match the settings: call at start and after every change
  function sync() {
    var n = cfg();
    if (!n.enabled) return stop();
    if (!n.token) {
      n.token = crypto.randomBytes(24).toString('hex');
      save(n);
    }
    if (srv && port === n.port) return;
    stop();
    start(n.port);
  }
  function info() {
    var n = cfg();
    return { enabled: !!n.enabled, port: n.port, token: n.token, ip: lanIp(), allow: n.allow, listening: !!srv };
  }
  function set(o) {
    var n = cfg();
    if (typeof o.enabled === 'boolean') n.enabled = o.enabled;
    if (o.regenerate || (n.enabled && !n.token)) n.token = crypto.randomBytes(24).toString('hex');
    save(n);
    sync();
    if (o.page && n.enabled && srv) {
      tokenPage = { path: crypto.randomBytes(12).toString('hex'), until: Date.now() + pageMs() };
      return nc.assign(info(), {
        pageUrl: 'http://' + lanIp() + ':' + n.port + '/t/' + tokenPage.path,
        pageSeconds: Math.round(pageMs() / 1000),
      });
    }
    return info();
  }
  return { name: 'notifyapi', start: sync, sync: sync, info: info, set: set };
}
module.exports = { create: create };
