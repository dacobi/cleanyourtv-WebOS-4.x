// Notifications with pictures: the TV's own toasts are text-only, so this shows a card in a small transparent window (the notify
// app) on top of whatever is running. POST /api/notify {title, text, image, seconds, position}
var luna = require('./luna'),
  fetch = require('./fetch'),
  web = require('./web'),
  URL = require('./netcompat').URL;

/** @type {Record<string, {type: string, buf: Buffer}>} */
var images = Object.create(null); // id -> {type, buf}; kept in memory, newest few only
/** @type {string[]} */
var imageIds = [];
var seq = 0;

function fetchImage(url) {
  return fetch
    .read(url, {
      refuseLocal: true, // not a way to read the service's own pages
      insecure: true,
      idleMs: 8000,
      redirects: 4,
      maxBytes: 6 << 20,
      bigText: 'image too large',
      statusText: function (s) {
        return 'image server answered ' + s;
      },
    })
    .then(function (r) {
      return { type: r.headers['content-type'] || 'image/jpeg', buf: r.body };
    });
}

// "topui" windows sit above every app and, unlike "overlay" ones, leave the remote with the app underneath (see tvprofile.js)
function launch(params) {
  return luna('luna://com.webos.applicationManager/launch', { id: 'com.cleanyourtv.notify', params: params });
}

function show(b, internal) {
  // the voice function's own look; not available to network senders
  var kind = internal && /^(listening|thinking|answer)$/.test(b.kind) ? b.kind : '';
  /** @type {Record<string, any>} */
  var p = {
    title: String(b.title || '').slice(0, 120),
    text: String(b.text || '').slice(0, kind ? 1500 : 400),
    seconds: Math.max(2, Math.min(120, +b.seconds || 8)),
    position: /^(top|middle|bottom)-(left|center|right)$/.test(b.position) ? b.position : kind ? 'bottom-center' : 'top-right',
  };
  if (kind) {
    p.kind = kind;
    p.question = String(b.question || '').slice(0, 300);
  }
  var prep = b.image
    ? fetchImage(String(b.image)).then(
        function (img) {
          var id = String(++seq);
          images[id] = img;
          imageIds.push(id);
          if (imageIds.length > 5) {
            var old = imageIds.shift();
            if (old) delete images[old];
          }
          p.image = 'http://127.0.0.1:8765/api/notify/img?id=' + id;
        },
        function (e) {
          p.text = (p.text ? p.text + '\n' : '') + '(image: ' + e.message + ')';
        }
      )
    : Promise.resolve();
  return prep.then(function () {
    if (!p.title && !p.text && !p.image && !kind) return { error: 'nothing to show' };
    return launch(p);
  });
}

function handle(req, res, u, body) {
  if (u === '/api/notify/img') {
    var id = new URL(req.url, 'http://x').searchParams.get('id');
    var e = id ? images[id] : null;
    if (!e) return web.notFound(res);
    res.writeHead(200, { 'content-type': e.type, 'cache-control': 'no-store' });
    return res.end(e.buf);
  }
  if (u === '/api/notify' && req.method === 'POST') {
    return body(req)
      .then(function (b) {
        return show(b);
      })
      .then(function (r) {
        return web.json(res, r.error ? { error: r.error } : r, r.error ? 400 : 200);
      });
  }
  web.notFound(res);
}

// ctx is not needed: this part keeps its own state
function create(/** @type {any} */ _ctx) {
  return { name: 'notify', prefix: '/api/notify', handle: handle, show: show };
}

module.exports = { create: create, handle: handle, show: show };
