// Small helpers for the HTTP handlers of the service.
// json(res, object, status): a JSON reply
function json(res, o, code) {
  res.writeHead(code || 200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(o));
}
// the request body as JSON ({} when it is empty or not JSON); at most `max` bytes (default 1 MB), the rest is dropped
/**
 * @param {any} req
 * @param {number} [max]
 * @returns {Promise<any>}
 */
function body(req, max) {
  var limit = max || 1 << 20;
  return new Promise(function (resolve) {
    var b = '',
      big = false;
    req.on('data', function (c) {
      if (big) return;
      b += c;
      if (b.length > limit) big = true;
    });
    req.on('end', function () {
      if (big) return resolve({});
      try {
        resolve(JSON.parse(b || '{}'));
      } catch (_) {
        resolve({});
      }
    });
    req.on('error', function () {
      resolve({});
    });
  });
}
function notFound(res) {
  res.writeHead(404);
  res.end();
}
var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
function esc(t) {
  return String(t).replace(/[&<>"]/g, function (c) {
    return ESC_MAP[c];
  });
}
// the TV's address on the local network (for the short-lived pages: Live TV pairing, the notification token, Share log)
function lanIp() {
  var n = require('os').networkInterfaces(),
    ks = Object.keys(n);
  for (var i = 0; i < ks.length; i++) {
    var list = n[ks[i]] || [];
    for (var j = 0; j < list.length; j++) {
      var a = list[j];
      if (a && a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return '';
}
module.exports = { json: json, body: body, notFound: notFound, esc: esc, lanIp: lanIp };
