// The launcher's Running apps menu (Back on Home, issue 16, as suggested and first built by Steefzar): the apps that are open now, to
// close them, as LG's own Home does with its Recents panel on a second Back.
//   GET /api/running                               {apps: [{id, title}]}
//   POST /api/running/close {id} or {all: true}    {returnValue, closed: [ids]}
// Only apps the launcher knows are listed (the apps of listApps), never Home and never CleanYourTV's own apps (the manager, and the
// picker and notify apps that are meant to stay up). Only listed apps can be closed. Closing also drops the app from LG's recents, as
// LG's panel does.
var web = require('./web');

var HOME_RE = /^com\.webos\.app\.(?:full)?home$/,
  OWN = /^com\.cleanyourtv\./,
  AM = 'luna://com.webos.applicationManager/';

// running: the list of applicationManager/running; apps: the launcher's apps ({id, title})
function pick(running, apps) {
  /** @type {Record<string, string>} */
  var title = {},
    /** @type {Record<string, boolean>} */
    seen = {},
    /** @type {Array<{id: string, title: string}>} */
    out = [];
  (apps || []).forEach(function (a) {
    title[a.id] = a.title || a.id;
  });
  (running || []).forEach(function (r) {
    var id = r && (r.id || r.appId);
    if (!id || seen[id] || HOME_RE.test(id) || OWN.test(id) || !Object.prototype.hasOwnProperty.call(title, id)) return;
    seen[id] = true;
    out.push({ id: id, title: title[id] });
  });
  return out;
}

function create(ctx) {
  var luna = ctx.luna;
  function apps() {
    var a = ctx.feature('apps');
    return a ? a.apps() : Promise.resolve([]);
  }
  function list() {
    return luna(AM + 'running', {}).then(function (r) {
      if (!Array.isArray(r.running)) return { apps: [], error: r.errorText || 'the app manager did not answer' };
      return apps().then(function (known) {
        return { apps: pick(r.running, known) };
      });
    });
  }
  // closeByAppId is the call that works on webOS 6, plain close the fallback (as for the picker in inputkey.js)
  function close(id) {
    return luna(AM + 'closeByAppId', { id: id })
      .then(function (r) {
        if (r.returnValue === true) return r;
        return luna(AM + 'close', { id: id });
      })
      .then(function (r) {
        if (r.returnValue !== true) return false;
        return luna('luna://com.webos.service.recent/removeRecent', { appId: id }).then(function () {
          return true; // not on every webOS; the app is closed either way
        });
      });
  }
  function handle(req, res, u, body) {
    if (u === '/api/running')
      return list().then(function (r) {
        return web.json(res, r);
      });
    if (u === '/api/running/close' && req.method === 'POST') {
      return body(req).then(function (b) {
        return list().then(function (cur) {
          var ids = cur.apps
            .map(function (a) {
              return a.id;
            })
            .filter(function (id) {
              return b.all === true || id === b.id;
            });
          if (!ids.length) return web.json(res, { returnValue: false, errorText: b.all ? 'nothing is running' : 'not a running app' });
          /** @type {string[]} */
          var closed = [];
          var seq = Promise.resolve();
          ids.forEach(function (id) {
            seq = seq.then(function () {
              return close(id).then(function (ok) {
                if (ok) closed.push(id);
              });
            });
          });
          return seq.then(function () {
            return web.json(res, { returnValue: closed.length === ids.length, closed: closed });
          });
        });
      });
    }
    web.notFound(res);
  }
  return { name: 'running', paths: ['/api/running', '/api/running/close'], handle: handle, list: list, close: close };
}

module.exports = { create: create, pick: pick };
