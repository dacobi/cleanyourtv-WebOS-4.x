// Input key: injects the bundled inputhook (see third-party/inputhook) into LG's input processes and binds the remote's
// Input button (id 241) to scripts/inputkey.sh, which opens the Inputs picker overlay. Removing our bind gives the key
// back to LG's own picker. Other binds in keybinds.json are left alone.
var fs = require('fs'),
  nc = require('./netcompat'),
  exec = require('./exec'),
  P = require('./paths');
var D = P.D,
  HOOK = P.HOOK,
  CFGDIR = P.HOOK_CFG,
  BINDS = CFGDIR + '/keybinds.json';
// The processes the hook goes into. LG's input service (lginput2) is where the remote's keys arrive on webOS 5 and newer, and the
// only one hooked when it runs. The others are only for firmware without it: in micomservice the hook replaces write(), and that
// process also passes the remote's keys on to HDMI-CEC devices and the soundbar; hooked there, CEC control and eARC stopped
// working after a boot (issue 23).
var PRIMARY = 'lginput2',
  FALLBACK = ['RELEASE', 'micomservice', 'tvservice', 'testapp'];
var TARGETS = [PRIMARY].concat(FALLBACK);
var DEFAULT_KEY = '241',
  COMMAND = 'sh ' + D + '/inputkey.sh',
  VOICE_COMMAND = 'sh ' + D + '/voicekey.sh',
  GUIDE_COMMAND = 'sh ' + D + '/guidekey.sh'; // 241: the Input button on the remote this was written with; learned in the setup

function procs() {
  /** @type {Array<{pid: string, name: string}>} */
  var out = [];
  var all = [];
  try {
    all = fs.readdirSync(P.PROC);
  } catch (_) {}
  for (var i = 0; i < all.length; i++) {
    var p = all[i];
    if (!/^\d+$/.test(p)) continue;
    try {
      var n = fs.readFileSync(P.PROC + '/' + p + '/comm', 'utf8').trim();
      if (TARGETS.indexOf(n) >= 0) out.push({ pid: p, name: n });
    } catch (_) {}
  }
  var primary = out.filter(function (x) {
    return x.name === PRIMARY;
  });
  return primary.length ? primary : out;
}
function hooked(pid) {
  try {
    return fs.readFileSync(P.PROC + '/' + pid + '/maps', 'utf8').indexOf('libinputhookpp') >= 0;
  } catch (_) {
    return false;
  }
}

function writeBinds(on, key, vkey, gkey) {
  /** @type {Record<string, any>} */
  var b = {};
  try {
    b = JSON.parse(fs.readFileSync(BINDS, 'utf8'));
  } catch (_) {}
  var before = JSON.stringify(b);
  var ks = Object.keys(b);
  for (var i = 0; i < ks.length; i++) {
    var k = ks[i];
    if (
      b[k] &&
      ((b[k].command === COMMAND && (!on || k !== key)) ||
        (b[k].command === VOICE_COMMAND && (!vkey || k !== vkey)) ||
        (b[k].command === GUIDE_COMMAND && (!gkey || k !== gkey)))
    )
      delete b[k]; // our binds only, wherever they were
  }
  if (on) b[key] = { action: 'exec', command: COMMAND };
  if (vkey) b[vkey] = { action: 'exec', command: VOICE_COMMAND };
  if (gkey) b[gkey] = { action: 'exec', command: GUIDE_COMMAND };
  if (JSON.stringify(b) === before) return;
  nc.mkdirp(CFGDIR);
  fs.writeFileSync(BINDS + '.tmp', JSON.stringify(b));
  fs.renameSync(BINDS + '.tmp', BINDS);
}

var busy = false;
// Idempotent: call at start and every so often (LG's input service restarts now and then and loses the hook).
var voiceFn = function () {
  return '';
}; // the key bound to the voice function, or '' (set by the service)
function setVoiceKey(f) {
  voiceFn = f;
}
var guideFn = function () {
  return '';
}; // the key bound to the Live TV guide, or '' (Live TV off or no key learned)
function setGuideKey(f) {
  guideFn = f;
}
function ensure(enabled, key) {
  var vkey = voiceFn(),
    gkey = guideFn();
  try {
    writeBinds(enabled, String(key || DEFAULT_KEY), vkey ? String(vkey) : '', gkey ? String(gkey) : '');
  } catch (e) {
    console.error('inputhook: keybinds:', e.message);
  }
  if (!(enabled || vkey || gkey) || busy || !fs.existsSync(HOOK + '/ezinject')) return;
  var todo = procs().filter(function (p) {
    return !hooked(p.pid);
  });
  if (!todo.length) return;
  busy = true;
  try {
    fs.chmodSync(HOOK + '/ezinject', parseInt('755', 8));
  } catch (_) {}
  var left = todo.length;
  todo.forEach(function (p) {
    var log = '/tmp/lginput-hook-' + p.name + '.log';
    try {
      fs.writeFileSync(log, '');
    } catch (_) {}
    exec.execFile(HOOK + '/ezinject', ['-l', log, p.pid, HOOK + '/libinputhookpp.so'], { timeout: 20000 }, function (e) {
      if (e) console.error('inputhook: inject ' + p.name + ':', e.message);
      if (--left === 0) busy = false;
    });
  });
}
var HOOKLOG = P.HOOK_LOG;
// What the hook reports about itself: did it find LG's input function and install?
function hookInfo() {
  var t = '';
  try {
    t = fs.readFileSync(HOOKLOG, 'utf8');
  } catch (_) {}
  return {
    attached: /InputHook initialized/.test(t) && /lib_main returned: 0/.test(t),
    sawKeys: /lginput_uinput_send_button called/.test(t),
    errors: t
      .split('\n')
      .filter(function (l) {
        return /\[(ERRO|FAIL|WARN)/.test(l);
      })
      .slice(0, 5),
  };
}
function status(key) {
  var ps = procs();
  return {
    hooked:
      ps
        .filter(function (p) {
          return p.name === 'lginput2' || p.name === 'micomservice';
        })
        .every(function (p) {
          return hooked(p.pid);
        }) && ps.length > 0,
    bound: (function () {
      try {
        var b = JSON.parse(fs.readFileSync(BINDS, 'utf8'));
        var k = String(key || DEFAULT_KEY);
        return !!(b[k] && b[k].command === COMMAND);
      } catch (_) {
        return false;
      }
    })(),
    hook: hookInfo(),
  };
}

// ---- learning a key: the code of the next button press, read from the hook's log ----
/** @type {Record<string, number[]>} */
var IGNORE = {
  input: [28, 103, 105, 106, 108, 272, 273, 274, 352, 412],
  home: [28, 103, 105, 106, 108, 272, 273, 274, 352],
  voice: [28, 103, 105, 106, 108, 272, 273, 274, 352, 412],
  guide: [28, 103, 105, 106, 108, 272, 273, 274, 352, 412],
}; // arrows, OK, pointer, Back
/** @type {{name: string, size: number, at: number, result: any}|null} */
var learn = null;
function markSaved() {
  if (learn && learn.result) learn.result.saved = true;
}
function startLearn(name) {
  var size = 0;
  try {
    size = fs.statSync(HOOKLOG).size;
  } catch (_) {}
  learn = { name: name, size: size, at: Date.now(), result: null };
}
function learnState() {
  if (!learn) return { state: 'idle' };
  if (learn.result) return nc.assign({ state: 'got', name: learn.name }, learn.result);
  if (!hookInfo().attached) return { state: 'unsupported', name: learn.name };
  var t = '';
  try {
    var fd = fs.openSync(HOOKLOG, 'r'),
      st = fs.fstatSync(fd),
      n = Math.max(0, st.size - learn.size);
    var b = nc.bufAlloc(Math.min(n, 65536));
    fs.readSync(fd, b, 0, b.length, learn.size);
    fs.closeSync(fd);
    t = b.toString('utf8');
  } catch (_) {}
  var re = /keyid=(\d+), state=1 uinput_code=(\d+)/g;
  var m;
  if (Date.now() - learn.at > 1200) {
    // ignore the OK press that started the step
    while ((m = re.exec(t))) {
      if ((IGNORE[learn.name] || []).indexOf(+m[2]) < 0) {
        learn.result = { code: m[2], keyid: m[1] };
        return nc.assign({ state: 'got', name: learn.name }, learn.result);
      }
    }
  }
  return {
    state: Date.now() - learn.at > 45000 ? 'timeout' : 'waiting',
    name: learn.name,
    seconds: Math.round((Date.now() - learn.at) / 1000),
  };
}
module.exports = {
  setVoiceKey: setVoiceKey,
  setGuideKey: setGuideKey,
  ensure: ensure,
  status: status,
  markSaved: markSaved,
  startLearn: startLearn,
  learnState: learnState,
  hookInfo: hookInfo,
  procs: procs,
  DEFAULT_KEY: DEFAULT_KEY,
};
