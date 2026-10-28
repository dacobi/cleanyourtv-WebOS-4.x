#!/usr/bin/env node
// Standalone updater for the CleanYourTV package, run as root by the manager app when the service is not running (for example before
// the setup, or when the setup failed). It does not need the service.
//   node selfupdate.js check      prints {installed, latest, updateTo} as JSON
//   node selfupdate.js install    downloads the latest package, checks its SHA-256, installs it; if the TV is already set up it also
//                                 restarts the service on the new files. Progress lines end with DONE or ERROR.
var fs = require('fs'),
  cp = require('child_process');
var P = require('./paths'),
  luna = require('./luna'),
  updates = require('./updates'),
  cmp = require('./version').cmp;

var TMP = '/tmp/cytv-self.ipk';
function say(m) {
  console.log(m);
}
function readJson(f, d) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (_) {
    return d;
  }
}
function installedVersion() {
  try {
    return (/(?:const|var) VERSION = '([^']+)'/.exec(fs.readFileSync(P.SERVICE_DIR + '/helper/helper.js', 'utf8')) || [])[1] || '0';
  } catch (_) {
    return '0';
  }
}
function latest() {
  return updates.latest(readJson(P.CONF, {})).then(function (r) {
    if (!r.service) throw new Error('the latest release has no package with a checksum');
    return r;
  });
}

function check() {
  var inst = installedVersion();
  return latest().then(
    function (l) {
      console.log(JSON.stringify({ installed: inst, latest: l.service, updateTo: cmp(l.service, inst) > 0 ? l.service : null }));
    },
    function (e) {
      console.log(JSON.stringify({ installed: inst, error: String(e.message || e) }));
    }
  );
}
function install() {
  var inst = installedVersion();
  /** @type {any} */
  var l = null;
  return latest()
    .then(function (rel) {
      l = rel;
      say('installed ' + inst + ', latest ' + l.service);
      if (cmp(l.service, inst) <= 0) {
        say('DONE already up to date');
        return null;
      }
      var name = 'com.cleanyourtv.manager_' + l.service + '_all.ipk';
      say('downloading ' + name);
      return updates
        .download(l, name, TMP)
        .then(null, function (e) {
          throw new Error(e.message === 'checksum mismatch' ? 'the package does not match its checksum; nothing was installed' : e.message);
        })
        .then(function () {
          say('installing ' + l.service);
          return luna(
            'luna://com.webos.appInstallService/dev/install',
            { id: 'com.cleanyourtv.manager', ipkUrl: TMP, subscribe: false },
            { timeout: 40000 }
          );
        })
        .then(function (r) {
          if (!r.returnValue) throw new Error('the system refused the install');
          var tries = 0;
          function poll() {
            if (installedVersion() === l.service && fs.existsSync(P.SERVICE_DIR + '/bootstrap.sh')) return Promise.resolve(true);
            if (++tries >= 40) return Promise.resolve(false);
            return new Promise(function (r2) {
              setTimeout(r2, 3000);
            }).then(poll);
          }
          return poll();
        })
        .then(function (ok) {
          if (!ok) throw new Error('the install did not finish');
          try {
            fs.unlinkSync(TMP);
          } catch (_) {}
          if (fs.existsSync(P.D + '/helper.js') && fs.existsSync(P.INITD + '/10-cleanyourtv-home')) {
            say('restarting the service');
            // a synchronous child: spawnSync keeps its time limit itself (exec.js explains why the asynchronous one does not)
            var out = cp.spawnSync('sh', [P.SERVICE_DIR + '/bootstrap.sh', 'update', l.service], {
              env: P.ENV,
              encoding: 'utf8',
              timeout: 240000,
            });
            say(
              String(out.stdout || '')
                .trim()
                .split('\n')
                .slice(-3)
                .join('\n')
            );
            if (out.status !== 0) throw new Error('the new service did not start; the previous files were restored');
          }
          say('DONE updated to ' + l.service + '. Close CleanYourTV and open it again.');
        });
    })
    .then(null, function (e) {
      say('ERROR ' + String(e.message || e));
      process.exitCode = 1;
    });
}

if (process.argv[2] === 'check') check();
else if (process.argv[2] === 'install') install();
else {
  console.log('usage: node selfupdate.js check|install');
  process.exit(2);
}
