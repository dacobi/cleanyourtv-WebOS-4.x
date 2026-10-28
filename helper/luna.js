// luna-send, the TV's service bus. Every call is one luna-send process with its stdin closed (it waits on it otherwise) and a time
// limit; a reply that is not JSON comes back as {returnValue: false, errorText}.
var exec = require('./exec');

function luna(uri, payload, opts) {
  var o = opts || {};
  var wait = o.wait || 5000;
  var script = 'luna-send -n 1 -w ' + wait + ' -f "$1" "$2" </dev/null';
  return exec
    .run('/bin/sh', ['-c', script, 'sh', uri, JSON.stringify(payload || {})], { timeout: o.timeout || wait + 3000 })
    .then(function (r) {
      try {
        return JSON.parse(r.out);
      } catch (_) {
        return { returnValue: false, errorText: r.error || 'bad json' };
      }
    });
}

module.exports = luna;
