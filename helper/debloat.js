// Switching the debloat on and off while the TV runs (the boot script 15-cleanyourtv-debloat applies it at every start). What it
// stops and blocks is in scripts/debloat-stop.sh; scripts/debloat-undo.sh reverses it. Its four groups can be switched off one by
// one: options.debloatOff in config.json lists those, and debloat-stop.sh reads it.
var P = require('./paths'),
  exec = require('./exec');

var GROUPS = ['ads', 'tracking', 'logs', 'suggestions'];

function apply(on) {
  var link = P.INITD + '/15-cleanyourtv-debloat';
  if (on) return exec.sh('ln -sf ' + P.D + '/15-cleanyourtv-debloat ' + link + '; sh ' + P.D + '/debloat-stop.sh', 60000);
  return exec.sh('rm -f ' + link + '; sh ' + P.D + '/debloat-undo.sh', 60000);
}

// while the debloat is on: undo the groups that were switched off, apply the ones switched on again
function change(offBefore, offAfter) {
  var undo = offAfter.filter(function (g) {
      return offBefore.indexOf(g) < 0;
    }),
    redo = offBefore.filter(function (g) {
      return offAfter.indexOf(g) < 0;
    });
  var p = Promise.resolve();
  if (undo.length)
    p = p.then(function () {
      return exec.sh('sh ' + P.D + '/debloat-undo.sh ' + undo.join(' '), 60000);
    });
  if (redo.length)
    p = p.then(function () {
      return exec.sh('sh ' + P.D + '/debloat-stop.sh ' + redo.join(' '), 60000);
    });
  return p.then(function () {});
}

// the groups that are off, from a request: known names only, each once
function cleanOff(list) {
  return GROUPS.filter(function (g) {
    return Array.isArray(list) && list.indexOf(g) >= 0;
  });
}

module.exports = { apply: apply, change: change, cleanOff: cleanOff, GROUPS: GROUPS };
