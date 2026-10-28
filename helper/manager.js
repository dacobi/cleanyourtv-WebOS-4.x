// The manager app's API (/api/manager/*): status, updates (updates.js), options, learning remote buttons, the update channel, LG's
// Home or ours, and uninstalling. Also POST /api/frontend-ok (a new launcher reports that it started) and POST /api/undo (the
// launcher's "LG's Home" button).
var fs = require('fs');
var P = require('./paths'),
  nc = require('./netcompat'),
  web = require('./web'),
  exec = require('./exec'),
  debloat = require('./debloat');

// the TV comes back to its last app after a restart; that must not be one of ours
function fixLastApp() {
  try {
    if (fs.readFileSync(P.LASTAPP, 'utf8').indexOf('cleanyourtv') >= 0) {
      var hid = 'com.webos.app.home';
      try {
        var t = fs.readFileSync(P.HOME_ID_FILE, 'utf8').trim();
        if (t) hid = t;
      } catch (_) {}
      fs.writeFileSync(P.LASTAPP, JSON.stringify({ lastAppId: hid }));
    }
  } catch (_) {}
}
// Switching between LG's Home and ours needs a restart: LG's Home does not come back reliably while the system is running.
function setHome(enabled) {
  if (enabled) {
    try {
      fs.unlinkSync(P.DISABLE);
    } catch (_) {}
  } else {
    fs.writeFileSync(P.DISABLE, '');
    fixLastApp();
  }
  exec.detached('sleep 3; reboot');
}
var KEY_NAMES = ['home', 'voice', 'guide'];
var PICKER_MODES = ['overlay', 'ondemand', 'launcher'];

function create(ctx) {
  var config = ctx.config;
  var updates = require('./updates').create(ctx);
  var inputhook = ctx.inputhook || require('./inputhook');
  // the Input key part may be missing (failed to load): fall back to plain rules
  function inputkey() {
    return (
      ctx.feature('inputkey') || {
        mode: function () {
          return 'overlay';
        },
        on: function () {
          return config.options().inputKey;
        },
        syncMode: function () {},
        pickerShownAt: function () {
          return 0;
        },
      }
    );
  }
  function keys() {
    var k = config.keys();
    return nc.assign(k, { inputIsDefault: !k.input, input: k.input || '241' });
  }
  function ensureHook(code) {
    return inputhook.ensure(inputkey().on(), code || keys().input);
  }

  function status() {
    var opts = config.options(),
      voice = ctx.feature('voice'),
      napi = ctx.feature('notifyapi'),
      wp = ctx.feature('wallpapers');
    var ours = false;
    try {
      var mounts = fs.readFileSync(P.PROC + '/mounts', 'utf8');
      // the launcher's folder over LG's Home app, or the stand-in over LG's native Home program(s) (scripts/home-standin.sh)
      var standins = fs.existsSync(P.STANDIN)
        ? fs
            .readFileSync(P.STANDIN, 'utf8')
            .split('\n')
            .map(function (s) {
              return s.trim();
            })
            .filter(Boolean)
        : [];
      ours =
        mounts.indexOf(' ' + P.HOME_APP + ' ') >= 0 ||
        mounts.indexOf(' ' + P.FULLHOME_APP + ' ') >= 0 ||
        standins.some(function (s) {
          return mounts.indexOf(' ' + s + ' ') >= 0;
        });
    } catch (_) {}
    var vs = voice ? voice.status() : null;
    var ws = wp ? wp.status() : null;
    return nc.assign(updates.status(), {
      options: opts,
      picker: nc.assign({}, config.get().picker || {}, { mode: inputkey().mode(), released: !!opts.inputKey && !inputkey().on() }),
      voice: vs ? { installed: vs.installed, enabled: vs.enabled } : null,
      notifyApi: napi ? { enabled: napi.info().enabled, port: napi.info().port } : { enabled: false },
      wallpapers: ws ? { total: ws.total, uploads: ws.uploads, immich: ws.immich.photos } : null,
      lang: config.get().lang || '', // the Language setting: '' follows the TV
      home: { enabled: !fs.existsSync(P.DISABLE), fullhome: fs.existsSync(P.FULLHOME_APP), ours: ours },
      inputhook: inputhook.status(keys().input),
      keys: keys(),
      job: updates.job(),
      repo: updates.repo(),
    });
  }

  function setOptions(o) {
    var cur = config.options();
    var next = nc.assign({}, cur);
    var boolKeys = ['debloat', 'inputKey', 'liveTv'];
    for (var i = 0; i < boolKeys.length; i++) {
      var k = boolKeys[i];
      if (typeof o[k] === 'boolean') next[k] = o[k];
    }
    if (Array.isArray(o.debloatOff)) next.debloatOff = debloat.cleanOff(o.debloatOff);
    config.update('manager', function (c) {
      // the language of every screen: a two-letter code, or '' to follow the TV
      if (typeof o.lang === 'string' && /^([a-z]{2})?$/.test(o.lang)) {
        if (o.lang) c.lang = o.lang;
        else delete c.lang;
      }
      if (typeof o.pickerPrewarm === 'boolean')
        c.picker = nc.assign(
          {},
          c.picker,
          o.pickerPrewarm ? { prewarm: true } : { prewarm: false, reason: 'switched off in the manager', at: Date.now() }
        );
      if (PICKER_MODES.indexOf(o.pickerMode) >= 0)
        c.picker = nc.assign({}, c.picker, {
          mode: o.pickerMode,
          prewarm: o.pickerMode === 'overlay' ? true : (c.picker || {}).prewarm,
          reason: 'chosen in the manager',
          at: Date.now(),
        });
      c.options = next;
    });
    inputkey().syncMode();
    var work = Promise.resolve();
    if (next.debloat !== cur.debloat) work = debloat.apply(next.debloat).then(function () {});
    else if (next.debloat) work = debloat.change(debloat.cleanOff(cur.debloatOff), debloat.cleanOff(next.debloatOff));
    return work.then(function () {
      ensureHook();
      return next;
    });
  }

  // the code of the key just pressed while learning; saved here once it arrives ('learned' is set when the Input flow ends: keys-done)
  function learnState() {
    var l = inputhook.learnState();
    if (l.state === 'got' && !l.saved) {
      config.update('manager', function (c) {
        c.keys = nc.assign({ input: '241', home: '', voice: '' }, c.keys || {});
        c.keys[l.name] = l.code;
      });
      if (inputhook.markSaved) inputhook.markSaved();
      if (l.name === 'input') ensureHook(l.code);
      else if (l.name === 'voice' || l.name === 'guide') ensureHook();
    }
    return l;
  }
  // forget a learned code: Input goes back to the default, the others to none
  function clearKey(name) {
    config.update('manager', function (c) {
      c.keys = nc.assign({ input: '', home: '', voice: '', guide: '' }, c.keys || {});
      c.keys[name] = '';
      if (name === 'input') c.keys.learned = false;
    });
    if (name !== 'home') ensureHook();
  }

  function handle(req, res, u, body) {
    function json(o, c) {
      return web.json(res, o, c);
    }
    if (u === '/api/frontend-ok' && req.method === 'POST') {
      return body(req).then(function (b) {
        updates.frontendLoaded(String(b.version || ''));
        return json({ returnValue: true });
      });
    }
    if (u === '/api/undo' && req.method === 'POST') {
      // LG's Home, kept until switched back on in the manager; restarts the TV
      setHome(false);
      return json({ returnValue: true });
    }
    var act = u.replace('/api/manager/', '');
    var napi = ctx.feature('notifyapi');
    if (act === 'status') {
      if (updates.stale()) updates.check();
      return json(status());
    }
    if (act === 'learn-state') return json(learnState());
    if (act === 'notify-api' && req.method === 'GET') return json(napi ? napi.info() : { enabled: false });
    if (act === 'test-key') return json({ pickerShownAt: inputkey().pickerShownAt(), now: Date.now() });
    if (act === 'tests')
      return updates.tests().then(function (r) {
        return json(r);
      });
    if (req.method !== 'POST') return json({ error: 'POST expected' }, 405);
    return body(req).then(function (b) {
      if (act === 'check') {
        return updates.check().then(function () {
          return json(status());
        });
      }
      if (act === 'channel') {
        return updates.setChannel(b.tag).then(function (err) {
          if (err) return json({ error: err }, err === 'unknown channel' ? 400 : 409);
          return json(status());
        });
      }
      if (act === 'notify-api') return json(napi ? napi.set(b) : { enabled: false });
      if (act === 'learn-key') {
        inputhook.startLearn(KEY_NAMES.indexOf(b.name) >= 0 ? b.name : 'input');
        return json({ returnValue: true });
      }
      if (act === 'clear-key') {
        clearKey(KEY_NAMES.indexOf(b.name) >= 0 ? b.name : 'input');
        return json({ returnValue: true });
      }
      if (act === 'keys-done') {
        config.update('manager', function (c) {
          c.keys = nc.assign({ input: '241', home: '' }, c.keys || {}, { learned: true });
        });
        return json({ returnValue: true });
      }
      if (act === 'options') {
        return setOptions(b).then(function () {
          return json(status());
        });
      }
      if (act === 'home') {
        setHome(b.enabled !== false);
        return json({ returnValue: true });
      }
      if (act === 'restore') {
        setHome(false);
        return json({ returnValue: true });
      }
      if (act === 'uninstall') {
        exec.detached('sleep 1; sh ' + P.D + '/uninstall.sh');
        return json({ returnValue: true });
      }
      if (['update-frontend', 'rollback-frontend', 'update-service'].indexOf(act) >= 0) {
        if (updates.busy()) return json({ error: 'busy', job: updates.job() }, 409);
        var ver = String(b.version || '').replace(/[^0-9.]/g, '');
        if (act === 'update-frontend') updates.updateFrontend(ver);
        else if (act === 'update-service') updates.updateService(ver);
        else updates.rollbackFrontend();
        return json({ returnValue: true, job: updates.job() });
      }
      return json({ error: 'unknown action' }, 404);
    });
  }

  return {
    name: 'manager',
    prefix: '/api/manager/',
    paths: ['/api/frontend-ok', '/api/undo'],
    handle: handle,
    start: function () {
      return setInterval(updates.watchPackage, 120000);
    },
    check: updates.check,
    status: status,
    frontendLoaded: updates.frontendLoaded,
    useLgHome: function () {
      return setHome(false);
    },
  };
}

module.exports = { create: create };
