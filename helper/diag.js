// Diagnostics for a service that dies without a trace. Node 8 on some TVs aborts with "uv_close: Assertion !uv__is_closing(handle)
// failed", which JavaScript cannot catch. So the service keeps the last operations (child processes, network requests) in a small file in
// /tmp; a later start that finds the file of a process that is gone logs those operations, and the Share log report includes them.
// execFile() is a child-process helper that handles the timeout itself instead of Node's `timeout` option: the child is killed once and
// the callback runs once, so no handle is closed twice.
var fs = require('fs'),
  cp = require('child_process');
var nc = require('./netcompat');
var FILE = require('./paths').RUNFILE,
  KEEP = 25;
/** @type {string[]} */
var ops = [],
  /** @type {any} */
  timer = null,
  started = 0;
function t() {
  return Math.round(Date.now() / 1000);
}
function flush() {
  timer = null;
  try {
    fs.writeFileSync(FILE + '.tmp', JSON.stringify({ pid: process.pid, started: started, ops: ops }));
    fs.renameSync(FILE + '.tmp', FILE);
  } catch (_) {}
}
function note(kind, what) {
  ops.push(
    t() +
      ' ' +
      kind +
      ' ' +
      String(what)
        .replace(/\/live\/[^\/\s]*\/[^\/\s]*\//g, '/live/*/*/')
        .slice(0, 120)
  );
  if (ops.length > KEEP) ops.shift();
  if (started && !timer) timer = setTimeout(flush, 500);
}
// at start: report how the previous process ended, then take over the file
function start() {
  var prev = null;
  try {
    prev = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (_) {}
  if (prev && prev.pid && prev.pid !== process.pid) {
    var alive = false;
    try {
      process.kill(prev.pid, 0);
      alive = true;
    } catch (_) {}
    if (!alive)
      console.error(
        'diag: the previous service process (pid ' +
          prev.pid +
          ', started ' +
          new Date((prev.started || 0) * 1000).toISOString() +
          ') ended without a clean exit. Its last operations:\n  ' +
          (prev.ops || []).join('\n  ')
      );
  }
  started = t();
  flush();
  function bye() {
    try {
      fs.unlinkSync(FILE);
    } catch (_) {}
  }
  process.on('exit', bye);
  process.on('SIGTERM', function () {
    bye();
    process.exit(0);
  });
  process.on('SIGINT', function () {
    bye();
    process.exit(0);
  });
}
// cp.execFile without the `timeout` option; the callback gets (error, stdout, stderr)
function execFile(cmd, args, opts, cb) {
  var o = nc.assign({}, opts),
    ms = o.timeout,
    max = o.maxBuffer || 1 << 20;
  delete o.timeout;
  delete o.maxBuffer;
  note(
    'exec',
    cmd.split('/').pop() +
      ' ' +
      (args || [])
        .filter(function (a) {
          return typeof a === 'string';
        })
        .join(' ')
        .slice(0, 100)
  );
  var done = false,
    /** @type {any} */
    killTimer = null,
    out = '',
    err = '',
    child;
  function fin(e) {
    if (done) return;
    done = true;
    clearTimeout(killTimer);
    cb(e, out, err);
  }
  try {
    child = cp.spawn(cmd, args || [], nc.assign({}, o, { stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (e) {
    fin(e);
    return null;
  }
  child.stdout.on('data', function (d) {
    if (out.length < max) out += d;
  });
  child.stderr.on('data', function (d) {
    if (err.length < max) err += d;
  });
  child.on('error', fin);
  child.on('close', function (code, sig) {
    fin(code === 0 ? null : nc.assign(new Error('exit ' + (code !== null ? code : sig)), { code: code, killed: !!sig }));
  });
  if (ms)
    killTimer = setTimeout(function () {
      try {
        child.kill('SIGKILL');
      } catch (_) {}
      fin(nc.assign(new Error('timed out'), { killed: true }));
    }, ms);
  return child;
}
module.exports = {
  start: start,
  note: note,
  execFile: execFile,
  ops: function () {
    return ops.slice();
  },
};
