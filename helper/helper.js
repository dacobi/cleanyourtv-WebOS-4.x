// Root service of CleanYourTV: the launcher's bridge to the TV (apps, inputs, launching), Live TV, picture notifications, voice,
// themes, the Input key and the manager's API (updates, options). Listens on 127.0.0.1:8765 only.
// This file only wires the parts together. Each part is a feature module with create(ctx) -> { name, paths/prefix, handle, start };
// ctx carries what they share (config, the TV profile, luna). A part that fails to load is left out and reported at /api/service;
// the rest keeps working. AGENTS.md has the map of the files.
var VERSION = '1.6.10';
var fs = require('fs');
var P = require('./paths'),
  diag = require('./diag');
diag.start();
// A promise that fails without a handler ends the process on Node 15 and newer (webOS 22 and later ship Node 16): log it and keep the
// service running; the launcher depends on it.
process.on('unhandledRejection', function (/** @type {any} */ e) {
  console.error('unhandled: ' + ((e && e.stack) || e));
});
var luna = require('./luna'),
  web = require('./web'),
  config = require('./config').main(),
  tvprofile = require('./tvprofile');

var PORT = 8765;
/** @type {any[]} */
var loaded = [],
  /** @type {Record<string, string>} */
  failed = {};
var ctx = {
  version: VERSION,
  config: config,
  luna: luna,
  profile: tvprofile.create({ luna: luna }),
  feature: function (name) {
    return (
      loaded.filter(function (f) {
        return f.name === name;
      })[0] || null
    );
  },
};
function load(name, make) {
  try {
    var f = make();
    if (f) loaded.push(f);
    return f;
  } catch (e) {
    failed[name] = String(e.message || e);
    console.error(name + ' module failed: ' + ((e && e.stack) || e));
    return null;
  }
}

// the service itself: its version, the TV profile and which parts are running
var core = {
  name: 'core',
  paths: ['/api/version', '/api/tv', '/api/service'],
  handle: function (req, res, u) {
    if (u === '/api/version') return web.json(res, { version: VERSION });
    if (u === '/api/tv') return web.json(res, ctx.profile.get());
    web.json(res, {
      version: VERSION,
      node: process.version,
      features: loaded.map(function (f) {
        return f.name;
      }),
      failed: failed,
    });
  },
};
loaded.push(core);

// the order matters where one part uses another: voice and the notification port show cards through notify
var notify = load('notify', function () {
  return require('./notify').create(ctx);
});
if (notify)
  load('voice', function () {
    return require('./voice').create(ctx);
  });
load('live', function () {
  return require('./live').create(ctx);
});
load('theme', function () {
  return require('./theme').create(ctx);
});
load('wallpapers', function () {
  return require('./wallpapers').create(ctx);
});
load('cards', function () {
  return require('./cards').create(ctx);
});
var inputkey = load('inputkey', function () {
  return require('./inputkey').create(ctx);
});
if (notify)
  load('notifyapi', function () {
    return require('./notifyapi').create(ctx);
  });
var manager = load('manager', function () {
  return require('./manager').create(ctx);
});
load('apps', function () {
  return require('./apps').create(ctx);
});
load('running', function () {
  return require('./running').create(ctx);
});

require('./server')
  .create({
    features: function () {
      return loaded;
    },
  })
  .listen(PORT, '127.0.0.1', function () {
    // the files that hold addresses and keys are for root only
    /** @type {Array<[string, number]>} */
    var secret = [
      [P.LIVE, parseInt('700', 8)],
      [P.CONF, parseInt('600', 8)],
      [P.USAGE, parseInt('600', 8)],
    ];
    for (var i = 0; i < secret.length; i++) {
      try {
        fs.chmodSync(secret[i][0], secret[i][1]);
      } catch (_) {}
    }
    for (var j = 0; j < loaded.length; j++) {
      try {
        if (loaded[j].start) loaded[j].start();
      } catch (e) {
        console.error(loaded[j].name + ' failed to start: ' + e.message);
      }
    }
    // what this TV is (webOS version, firmware): the Input key's default follows it
    ctx.profile.refresh().then(function () {
      if (inputkey) inputkey.syncMode();
    });
    if (manager)
      setTimeout(function () {
        manager.check();
      }, 60000);
  });
