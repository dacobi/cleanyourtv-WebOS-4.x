// Smoke and HTTP integration test written in pure ES5 + Promise so it runs directly inside Node.js v0.12.2 (the engine on webOS 4.x).
// Verifies that every module in helper/ loads cleanly, the polyfills and parsers work, jtool.js runs, and the HTTP service answers.
'use strict';
var fs = require('fs'),
  os = require('os'),
  vm = require('vm'),
  path = require('path'),
  http = require('http'),
  cp = require('child_process');

var root = path.join(__dirname, '..');
var tmp = path.join(os.tmpdir(), 'cytv-node012-' + process.pid + '-' + Date.now());
fs.mkdirSync(tmp);
fs.mkdirSync(path.join(tmp, 'live'));
fs.mkdirSync(path.join(tmp, 'themes'));
fs.mkdirSync(path.join(tmp, 'backup'));
fs.mkdirSync(path.join(tmp, 'wallpapers'));
process.env.CYTV_DIR = tmp;
process.env.CYTV_RUN = path.join(tmp, 'run.json');

var failed = 0,
  checks = 0;
function ok(cond, msg) {
  checks++;
  if (!cond) {
    failed++;
    console.log('FAIL ' + msg);
  }
}

function rmrf(p) {
  try {
    var st = fs.lstatSync(p);
    if (st.isDirectory()) {
      var list = fs.readdirSync(p);
      for (var i = 0; i < list.length; i++) rmrf(path.join(p, list[i]));
      fs.rmdirSync(p);
    } else fs.unlinkSync(p);
  } catch (e) {}
}

function getJson(port, urlPath, headers) {
  return new Promise(function (resolve, reject) {
    http
      .get({ host: '127.0.0.1', port: port, path: urlPath, headers: headers || {} }, function (res) {
        var s = '';
        res.setEncoding('utf8');
        res.on('data', function (d) {
          s += d;
        });
        res.on('end', function () {
          try {
            resolve({ status: res.statusCode, headers: res.headers, body: s ? JSON.parse(s) : null });
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

// 1. Parse all 34 files in helper/ with Node 0.12's own V8 engine, and require every library module
var helperDir = path.join(root, 'helper');
var allFiles = fs
  .readdirSync(helperDir)
  .filter(function (f) {
    return /\.js$/.test(f);
  })
  .sort();
var mods = {};
for (var i = 0; i < allFiles.length; i++) {
  var fname = allFiles[i],
    name = fname.replace(/\.js$/, ''),
    full = path.join(helperDir, fname),
    src = fs.readFileSync(full, 'utf8').replace(/^#!.*\n/, '');
  try {
    new vm.Script('(function(exports,require,module,__filename,__dirname){' + src + '\n})', { filename: fname });
    if (fname !== 'helper.js' && fname !== 'selfupdate.js') mods[name] = require(full);
    ok(true, 'load helper/' + fname);
  } catch (e) {
    ok(false, 'load helper/' + fname + ': ' + ((e && e.stack) || e));
  }
}

// 2. Exercise key modules directly under Node 0.12
var prof = mods.tvprofile.decide(
  { sdk: '4.10.0', firmware: '05.50.00', home: 'com.webos.app.fullhome native', node: process.version },
  JSON.parse(fs.readFileSync(path.join(root, 'compat.json'), 'utf8')).entries
);
ok(
  prof.homeTakeover === 'standin' &&
    prof.pickerMode === 'ondemand' &&
    prof.notifyWindow === 'overlay' &&
    prof.legacyNode === true &&
    prof.tested === true,
  'tvprofile decisions for webOS 4.10 fullhome under ' + process.version
);

var u = new mods.netcompat.URL('http://127.0.0.1:8765/api/apps?x=1');
u.searchParams.set('y', '2');
ok(u.toString() === 'http://127.0.0.1:8765/api/apps?x=1&y=2', 'netcompat URL + URLSearchParams');

var bA = mods.netcompat.bufFrom('cleanyourtv', 'utf8'),
  bB = mods.netcompat.bufFrom('cleanyourtv', 'utf8');
ok(mods.netcompat.timingSafeEqual(bA, bB) && mods.netcompat.bufAlloc(16).length === 16, 'netcompat Buffer and timingSafeEqual');

// 3. Exercise scripts/jtool.js in a child process of this same Node binary
var appinfo = path.join(tmp, 'fullhome.json'),
  staged = path.join(tmp, 'staged.json'),
  binStub = path.join(tmp, 'fullhome-bin');
fs.writeFileSync(binStub, '');
fs.writeFileSync(appinfo, JSON.stringify({ id: 'com.webos.app.fullhome', type: 'native', main: 'file://' + binStub }));

function runJtool(args) {
  return new Promise(function (resolve) {
    cp.execFile(process.execPath, [path.join(root, 'scripts', 'jtool.js')].concat(args), function (err, stdout) {
      resolve({ code: err ? err.code || 1 : 0, out: String(stdout || '').trim() });
    });
  });
}

// 4. Wire up the real feature modules and server.js on an ephemeral loopback port and query HTTP endpoints
var cfg = mods.config.main();
var fakeLuna = function (uri) {
  if (/getSystemInfo$/.test(uri))
    return Promise.resolve({ returnValue: true, modelName: 'OLED65B9SLA', firmwareVersion: '05.50.00', sdkVersion: '4.10.0' });
  if (/listApps$/.test(uri))
    return Promise.resolve({
      returnValue: true,
      apps: [
        { id: 'netflix', title: 'Netflix', visible: true },
        { id: 'com.webos.app.fullhome', title: 'FullHome', visible: true },
      ],
    });
  if (/running$/.test(uri)) return Promise.resolve({ returnValue: true, running: [{ id: 'com.webos.app.fullhome' }, { id: 'netflix' }] });
  return Promise.resolve({ returnValue: true });
};

var ctx = {
  version: '1.6.10',
  config: cfg,
  luna: fakeLuna,
  profile: mods.tvprofile.create({ luna: fakeLuna }),
  noStartup: true,
  feature: function (n) {
    for (var j = 0; j < loaded.length; j++) if (loaded[j].name === n) return loaded[j];
    return null;
  },
};
var ORDER = ['notify', 'voice', 'live', 'theme', 'wallpapers', 'cards', 'inputkey', 'notifyapi', 'manager', 'apps', 'running'];
var loaded = [
  {
    name: 'core',
    paths: ['/api/version', '/api/tv', '/api/service'],
    handle: function (req, res, uPath) {
      if (uPath === '/api/version') return mods.web.json(res, { version: '1.6.10' });
      if (uPath === '/api/tv') return mods.web.json(res, ctx.profile.get());
      mods.web.json(res, {
        version: '1.6.10',
        node: process.version,
        features: loaded.map(function (f) {
          return f.name;
        }),
        failed: {},
      });
    },
  },
];
for (var k = 0; k < ORDER.length; k++) {
  try {
    loaded.push(mods[ORDER[k]].create(ctx));
  } catch (e) {
    ok(false, 'create(' + ORDER[k] + '): ' + ((e && e.stack) || e));
  }
}
ok(loaded.length === ORDER.length + 1, 'all ' + ORDER.length + ' feature modules instantiated cleanly');

var srv = mods.server.create({
  features: function () {
    return loaded;
  },
});

runJtool(['exe', appinfo])
  .then(function (r1) {
    ok(r1.code === 0 && r1.out === binStub, 'jtool exe strips file:// under ' + process.version);
    return runJtool(['stage', appinfo, staged]);
  })
  .then(function (r2) {
    var st = JSON.parse(fs.readFileSync(staged, 'utf8'));
    ok(r2.code === 0 && st.id === 'com.webos.app.fullhome' && st.type === 'web', 'jtool stage writes web appinfo.json');
    return new Promise(function (resolve, reject) {
      srv.listen(0, '127.0.0.1', function () {
        resolve(srv.address().port);
      });
      srv.on('error', reject);
    });
  })
  .then(function (port) {
    return Promise.all([
      getJson(port, '/api/version'),
      getJson(port, '/api/service'),
      getJson(port, '/api/apps', { Origin: 'file://' }),
      getJson(port, '/api/running', { Origin: 'file://com.webos.app.fullhome-webos' }),
      getJson(port, '/api/live/status'),
      getJson(port, '/api/wallpapers/list'),
      getJson(port, '/api/inputs', { Origin: 'file://com.cleanyourtv.picker' }),
      getJson(port, '/api/version', { Origin: 'file://com.cleanyourtv.manager' }),
      getJson(port, '/api/version', { Origin: 'file://com.other.app' }),
    ]).then(function (res) {
      ok(res[0].status === 200 && res[0].body.version === '1.6.10', 'GET /api/version');
      ok(res[1].status === 200 && res[1].body.features.length === ORDER.length + 1, 'GET /api/service');
      ok(
        res[2].status === 200 && Array.isArray(res[2].body.apps) && res[2].headers['access-control-allow-origin'] === '*',
        'GET /api/apps accepts bare file:// Origin from Chromium 53'
      );
      ok(
        res[3].status === 200 &&
          res[3].body.apps.length === 1 &&
          res[3].body.apps[0].id === 'netflix' &&
          res[3].headers['access-control-allow-origin'] === '*',
        'GET /api/running accepts fullhome Origin and excludes com.webos.app.fullhome'
      );
      ok(res[4].status === 200 && res[4].body.state === 'idle', 'GET /api/live/status');
      ok(res[5].status === 200 && Array.isArray(res[5].body.photos), 'GET /api/wallpapers/list');
      ok(
        res[6].status === 200 &&
          res[6].headers['access-control-allow-origin'] === '*' &&
          res[7].status === 200 &&
          res[7].headers['access-control-allow-origin'] === '*' &&
          res[8].status === 403,
        'webOS 4 file://<appId> Origin (without -webos) is accepted for our apps and refused for others'
      );
      srv.close();
    });
  })
  .then(
    function () {
      rmrf(tmp);
      if (failed) {
        console.log(failed + ' of ' + checks + ' checks failed on Node ' + process.version);
        process.exit(1);
      }
      console.log('all ' + checks + ' checks passed on Node ' + process.version);
      process.exit(0);
    },
    function (err) {
      try {
        srv.close();
      } catch (e) {}
      rmrf(tmp);
      console.log('FAIL unhandled error: ' + ((err && err.stack) || err));
      process.exit(1);
    }
  );
