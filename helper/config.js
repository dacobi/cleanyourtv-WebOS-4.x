// The settings in config.json, for every part of the service. Read and change them only through this module:
//   config.get()                 a copy of everything
//   config.options()             {debloat, inputKey, liveTv} with their defaults (and debloatOff, the debloat groups switched off)
//   config.keys()                the learned remote buttons with their defaults
//   config.update(source, fn)    fn changes a copy, which is then written at once (atomically). The read, the change and the write
//                                happen in one go, so two parts of the service can never overwrite each other's settings.
// Every change of an option, a learned key or the Input-key mode is logged with its source ("manager", "launcher", "setup", ...),
// so a setting that changes by itself shows up in the service log and in Share log.
var fs = require('fs');
var P = require('./paths'),
  nc = require('./netcompat');

var MODE_600 = parseInt('600', 8);
var OPTIONS = { debloat: true, inputKey: true, liveTv: true };
var KEYS = { input: '', home: '', voice: '', guide: '', learned: false };
// what the launcher saves with POST /api/config; everything else belongs to the service and the manager
var LAUNCHER_KEYS = ['dock', 'hidden', 'sort', 'clock', 'topbar', 'runDots', 'wall', 'cards'];

// file: config.json; opts.log(line) for the change log; opts.memory: keep the settings in memory instead (tests)
function create(file, opts) {
  var o = opts || {};
  var log =
    o.log ||
    function (m) {
      console.log(m);
    };
  var mem = o.memory ? JSON.stringify(o.memory) : null;
  function read() {
    if (mem !== null) return JSON.parse(mem);
    try {
      var c = JSON.parse(fs.readFileSync(file, 'utf8'));
      return c && typeof c === 'object' && !Array.isArray(c) ? c : {};
    } catch (_) {
      return {};
    }
  }
  function write(c) {
    if (mem !== null) {
      mem = JSON.stringify(c);
      return;
    }
    fs.writeFileSync(file + '.tmp', JSON.stringify(c, null, 2), { mode: MODE_600 });
    fs.renameSync(file + '.tmp', file);
  }
  // compared with their defaults filled in, so writing a default down is not a change
  function watched(c) {
    return {
      options: nc.assign({}, OPTIONS, c.options),
      keys: nc.assign({}, KEYS, c.keys),
      picker: { mode: (c.picker || {}).mode },
    };
  }
  function report(source, before, after) {
    var a = watched(before),
      b = watched(after),
      secs = Object.keys(b);
    for (var si = 0; si < secs.length; si++) {
      var sec = secs[si],
        ks = Object.keys(nc.assign({}, a[sec], b[sec]));
      for (var ki = 0; ki < ks.length; ki++) {
        var k = ks[ki];
        if (JSON.stringify(a[sec][k]) !== JSON.stringify(b[sec][k]))
          log('config: ' + sec + '.' + k + ' ' + JSON.stringify(a[sec][k]) + ' -> ' + JSON.stringify(b[sec][k]) + ' (' + source + ')');
      }
    }
  }
  function update(source, fn) {
    var before = read();
    var draft = JSON.parse(JSON.stringify(before));
    var r = fn(draft);
    var next = r && typeof r === 'object' ? r : draft;
    write(next);
    report(source, before, next);
    return next;
  }
  return {
    file: file,
    get: read,
    options: function () {
      return nc.assign({}, OPTIONS, read().options || {});
    },
    keys: function () {
      return nc.assign({}, KEYS, read().keys || {});
    },
    update: update,
    // for code that still thinks in whole files (tests, older modules): replaces everything, still logged
    replace: function (source, c) {
      return update(source, function () {
        return c;
      });
    },
  };
}

/** @type {ReturnType<typeof create>|null} */
var shared = null;
// the service's config.json
function main() {
  return shared || (shared = create(P.CONF));
}
// settings kept in memory, for the tests
function memory(initial, log) {
  return create('', { memory: initial || {}, log: log || function () {} });
}

module.exports = { create: create, main: main, memory: memory, OPTIONS: OPTIONS, KEYS: KEYS, LAUNCHER_KEYS: LAUNCHER_KEYS };
