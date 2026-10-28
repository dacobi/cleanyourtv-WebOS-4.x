// The launcher's own API: the list of apps with their icons, how often each is used, the inputs, launching, and the launcher's
// settings (dock, hidden apps, sort order, clock, top buttons).
//   GET /api/apps  GET /api/inputs  GET /api/foreground  POST /api/launch {id, params}  POST /api/config {...}  GET /icon/<app id>
//   POST /api/inputs/pin {id, on}   pin an input (its input app, e.g. com.webos.app.hdmi2) to Home, or take it off again
// A pinned input is listed with the apps ({id, title, input: <port>, off: <nothing connected>}), so the dock, the grid, the saved
// layout and the order by use treat it as an app; it is kept in config.json (pinnedInputs), apart from the launcher's own keys.
var fs = require('fs'),
  path = require('path');
var P = require('./paths'),
  nc = require('./netcompat'),
  web = require('./web'),
  exec = require('./exec'),
  cardsShape = require('./cards'),
  LAUNCHER_KEYS = require('./config').LAUNCHER_KEYS;

var HALF_LIFE = 30 * 24 * 3600 * 1000; // usage counts halve every 30 days
var WALL_SECS = [0, 10, 30, 60, 180, 300, 900, 3600]; // the photo-change intervals Customise > Wallpapers offers
var HOME = 'com.webos.app.home';
var HOME_RE = /^com\.webos\.app\.(?:full)?home$/;

function create(ctx) {
  var config = ctx.config,
    luna = ctx.luna;

  // ---- the installed apps. The app manager takes a moment to answer (a luna-send each time), and Home is opened often: after the first
  // answer the list is given at once from memory and asked again in the background when it is older than 5 seconds, so an app installed
  // a moment ago shows up on the next opening of Home ----
  /** @type {any[]|null} */
  var appCache = null,
    appCacheAt = 0,
    /** @type {Promise<any[]>|null} */
    asking = null;
  function askApps() {
    if (!asking)
      asking = luna('luna://com.webos.applicationManager/listApps', {}).then(function (r) {
        asking = null;
        if (!Array.isArray(r.apps)) return appCache || [];
        appCache = r.apps
          .filter(function (a) {
            return a.visible !== false && !HOME_RE.test(a.id);
          })
          .map(function (a) {
            return { id: a.id, title: a.title, icon: a.largeIcon || a.icon, folder: a.folderPath, type: a.type };
          });
        appCacheAt = Date.now();
        return appCache;
      });
    return asking;
  }
  function installed() {
    if (!appCache) return askApps();
    if (Date.now() - appCacheAt > 5000) askApps();
    return Promise.resolve(appCache);
  }

  // ---- the inputs, read like the apps: the last answer at once, asked again in the background when older than 5 seconds ----
  /** @type {any} */
  var inputCache = null,
    inputCacheAt = 0,
    /** @type {Promise<any>|null} */
    askingInputs = null;
  function askInputs() {
    if (!askingInputs)
      askingInputs = luna('luna://com.webos.service.eim/getAllInputStatus', {}).then(function (r) {
        askingInputs = null;
        if (Array.isArray(r.devices)) {
          inputCache = r;
          inputCacheAt = Date.now();
        }
        return r;
      });
    return askingInputs;
  }
  function knownInputs() {
    if (!inputCache || Date.now() - inputCacheAt > 5000) askInputs();
    return (inputCache && inputCache.devices) || [];
  }
  function portLabel(d) {
    return 'HDMI ' + d.port;
  }
  // the inputs pinned to Home, with the name and state the TV reports now (or what was saved when it was pinned)
  function pinned() {
    /** @type {Record<string, any>} */
    var now = {};
    var devs = knownInputs();
    for (var i = 0; i < devs.length; i++) if (devs[i].appId) now[devs[i].appId] = devs[i];
    return (config.get().pinnedInputs || [])
      .filter(function (p) {
        return p && typeof p.id === 'string';
      })
      .map(function (p) {
        var d = now[p.id];
        var label = (d && d.label) || p.label || 'HDMI ' + p.port;
        return { id: p.id, title: label, input: (d && d.port) || p.port || 0, off: d ? !d.hdmiPlugIn : false };
      });
  }
  function apps() {
    return installed().then(function (inst) {
      return inst.concat(pinned());
    });
  }
  function pin(b) {
    var id = String(b.id || '');
    return askInputs().then(function (r) {
      var listDevs = r.devices || (inputCache && inputCache.devices) || [];
      var d = listDevs.filter(function (x) {
        return x.appId === id;
      })[0];
      if (b.on !== false && !d) return { returnValue: false, error: 'not an input of this TV' };
      config.update('launcher', function (c) {
        var list = (c.pinnedInputs || []).filter(function (p) {
          return p && p.id !== id;
        });
        if (b.on !== false) list.push({ id: id, label: d.label && d.label !== portLabel(d) ? d.label : '', port: d.port });
        c.pinnedInputs = list.slice(0, 20);
        if (b.on === false && Array.isArray(c.dock))
          c.dock = c.dock.filter(function (i) {
            return i !== id;
          }); // taken off Home: off the dock too
      });
      return { returnValue: true, pinned: b.on !== false };
    });
  }

  // ---- usage: which apps get used (foreground changes), with a 30-day half-life ----
  /** @type {Record<string, {s: number, t: number}>} */
  var usage = {};
  try {
    usage = JSON.parse(fs.readFileSync(P.USAGE, 'utf8'));
  } catch (_) {}
  function decayed(u, now) {
    return u.s * Math.pow(0.5, (now - u.t) / HALF_LIFE);
  }
  function usageScores() {
    var now = Date.now(),
      /** @type {Record<string, number>} */
      out = {};
    for (var id in usage) out[id] = Math.round(decayed(usage[id], now) * 1000) / 1000;
    return out;
  }
  /** @type {any} */
  var saveTimer = null;
  function bump(id) {
    var now = Date.now(),
      u = usage[id];
    usage[id] = { s: (u ? decayed(u, now) : 0) + 1, t: now };
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = null;
      try {
        fs.writeFileSync(P.USAGE + '.tmp', JSON.stringify(usage));
        fs.renameSync(P.USAGE + '.tmp', P.USAGE);
      } catch (_) {}
    }, 15000);
  }
  // an app counts as used once it stayed in the foreground for two polls in a row; going back to Home arms it again
  /** @type {string|null} */
  var cand = null,
    streak = 0,
    /** @type {string|null} */
    counted = null;
  function onForeground(id) {
    if (HOME_RE.test(id)) {
      counted = null;
      cand = id;
      streak = 1;
      return;
    }
    if (!id) return;
    if (id === cand) streak++;
    else {
      cand = id;
      streak = 1;
    }
    if (streak >= 2 && id !== counted) {
      counted = id;
      apps().then(function (list) {
        if (
          list.some(function (a) {
            return a.id === id;
          })
        )
          bump(id);
      });
    }
  }
  // poll every few seconds: a subscription's output is block-buffered by luna-send, so it would arrive late
  function pollForeground() {
    exec.execFile(
      'luna-send',
      ['-n', '1', '-w', '3000', '-f', 'luna://com.webos.applicationManager/getForegroundAppInfo', '{}'],
      { timeout: 6000 },
      function (e, out) {
        try {
          var o = JSON.parse(out);
          if (o.returnValue !== false) onForeground(o.appId || '');
        } catch (_) {}
      }
    );
  }

  // ---- the launcher's settings: only its own keys are replaced; options, keys, theme and the rest stay as they are ----
  function saveLauncherConfig(b) {
    function strs(v) {
      return Array.isArray(v)
        ? v
            .filter(function (x) {
              return typeof x === 'string';
            })
            .slice(0, 200)
        : undefined;
    }
    /** @type {Record<string, any>} */
    var out = {};
    var dock = strs(b.dock);
    var hidden = strs(b.hidden);
    if (dock) out.dock = dock.slice(0, 8);
    if (hidden) out.hidden = hidden;
    if (b.sort === 'usage' || b.sort === 'alpha') out.sort = b.sort;
    if (['auto', '24', '12'].indexOf(b.clock) >= 0) out.clock = b.clock;
    if (b.runDots === true) out.runDots = true; // the green dot on open apps (off unless switched on)
    // Wallpapers in the launcher: on or off, and how often the photo changes
    if (b.wall && typeof b.wall === 'object') {
      // secs: how often the photo changes while Home is shown, in seconds (0: each time Home opens); "every" (minutes) came before it
      var secs = typeof b.wall.secs === 'number' ? b.wall.secs : typeof b.wall.every === 'number' ? b.wall.every * 60 : 900;
      out.wall = { on: b.wall.on === true, secs: WALL_SECS.indexOf(secs) >= 0 ? secs : 900 };
    }
    // the cards in the theme's slots (Customise > Cards), checked for shape only (cards.js)
    var cards = cardsShape.sanitize(b.cards);
    if (cards) out.cards = cards;
    if (Array.isArray(b.topbar))
      out.topbar = b.topbar
        .slice(0, 12)
        .filter(function (o) {
          return o && typeof o.label === 'string';
        })
        .map(function (o) {
          /** @type {Record<string, any>} */
          var t = { label: o.label.slice(0, 40), icon: String(o.icon || 'grid').slice(0, 20) };
          if (typeof o.action === 'string') t.action = o.action;
          if (typeof o.app === 'string') t.app = o.app;
          if (o.params && typeof o.params === 'object') t.params = o.params;
          return t;
        });
    config.update('launcher', function (c) {
      for (var i = 0; i < LAUNCHER_KEYS.length; i++) delete c[LAUNCHER_KEYS[i]];
      return nc.assign(c, out);
    });
  }

  // what the launcher gets: its settings and the resolved theme, not the secrets (voice, notification token)
  function launcherConfig() {
    var c = config.get();
    delete c.voice;
    delete c.notifyApi;
    delete c.theme;
    delete c.wallpapers; // holds the Immich key; the launcher gets only a stamp that changes with the set of photos
    var theme = ctx.feature('theme'),
      wp = ctx.feature('wallpapers');
    if (wp) c.wallpapers = { stamp: wp.stamp() };
    return theme ? nc.assign(c, { theme: theme.resolved() }) : c;
  }

  function handle(req, res, u, body) {
    if (u === '/api/apps')
      return apps().then(function (list) {
        return web.json(res, { apps: list, config: launcherConfig(), usage: usageScores(), version: ctx.version });
      });
    if (u === '/api/inputs')
      return askInputs().then(function (r) {
        return web.json(res, r);
      });
    if (u === '/api/inputs/pin' && req.method === 'POST')
      return body(req)
        .then(pin)
        .then(function (r) {
          return web.json(res, r);
        });
    if (u === '/api/foreground')
      return luna('luna://com.webos.applicationManager/getForegroundAppInfo', {}).then(function (r) {
        return web.json(res, r);
      });
    if (u === '/api/launch' && req.method === 'POST') {
      return body(req).then(function (b) {
        if (!/^[\w.\-]+$/.test(b.id || '')) return web.json(res, { error: 'bad id' }, 400);
        var targetId = b.id;
        if (targetId === HOME) {
          try {
            var hid = fs.readFileSync(P.HOME_ID_FILE, 'utf8').trim();
            if (hid) targetId = hid;
          } catch (_) {}
        }
        // where home-standin.sh stands in for LG's native Home, leave non-empty parameters in HOME_PARAMS too (as inputkey.sh and guidekey.sh do)
        if (
          HOME_RE.test(targetId) &&
          b.params &&
          typeof b.params === 'object' &&
          Object.keys(b.params).length &&
          fs.existsSync(P.STANDIN)
        ) {
          try {
            var up = fs.readFileSync(P.PROC + '/uptime', 'utf8').split(' ')[0];
            if (up) fs.writeFileSync(P.HOME_PARAMS, up + ' ' + JSON.stringify(b.params) + '\n');
          } catch (_) {}
        }
        return luna('luna://com.webos.applicationManager/launch', { id: targetId, params: b.params || {} }).then(function (r) {
          return web.json(res, r);
        });
      });
    }
    if (u === '/api/config' && req.method === 'POST') {
      return body(req).then(function (b) {
        saveLauncherConfig(b);
        return web.json(res, { returnValue: true });
      });
    }
    var m = u.match(/^\/icon\/([\w.\-]+)$/);
    if (m) {
      return apps().then(function (list) {
        var a = list.filter(function (x) {
          return x.id === m[1];
        })[0];
        var f = a && a.icon && a.folder && path.join(a.folder, a.icon);
        if (!f || path.resolve(f).indexOf(path.resolve(a.folder)) !== 0 || !fs.existsSync(f)) return web.notFound(res);
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=3600' });
        return fs.createReadStream(f).pipe(res);
      });
    }
    web.notFound(res);
  }

  return {
    name: 'apps',
    paths: ['/api/apps', '/api/inputs', '/api/inputs/pin', '/api/foreground', '/api/launch', '/api/config'],
    prefix: '/icon/',
    handle: handle,
    start: function () {
      return setInterval(pollForeground, 4000);
    },
    apps: apps,
  };
}

module.exports = { create: create };
