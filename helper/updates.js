// Updates from GitHub releases: which release is on offer (the latest stable one, or the dev build), downloading with a
// SHA-256 check, installing the launcher with a rollback when it does not start, and installing the service package. Used by the
// manager (manager.js) and, without the service, by selfupdate.js.
var fs = require('fs');
var P = require('./paths'),
  nc = require('./netcompat'),
  fetch = require('./fetch'),
  exec = require('./exec'),
  cmp = require('./version').cmp;

var DEFAULT_REPO = 'lasharor/cleanyourtv-WebOS';
// the dev builds: one pre-release named dev, rebuilt on every push to the dev branch. Before 1.6.9 every branch had its own
// pre-release test-<branch>; a TV still following one of those follows dev.
var DEV_TAG = 'dev';
var OLD_TEST_TAG = /^test-[a-z0-9-]{1,60}$/;
function apiBase() {
  return process.env.CYTV_API || 'https://api.github.com';
}

function readJson(f, d) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (_) {
    return d;
  }
}
function readText(f) {
  try {
    return fs.readFileSync(f, 'utf8').trim();
  } catch (_) {
    return '';
  }
}
// the update channel: '' for the stable releases, or 'dev'. The file can be set by install.sh too.
function channel() {
  var t = readText(P.CHANNEL);
  return t === DEV_TAG || OLD_TEST_TAG.test(t) ? DEV_TAG : '';
}
// the repository: D/source can name another one ("owner/repo [branch]"), for testing
function repo() {
  var src = readText(P.SOURCE).split(/\s+/)[0];
  return /^[\w.-]+\/[\w.-]+$/.test(src) ? src : DEFAULT_REPO;
}
function baseRepo() {
  return apiBase() + '/repos/' + repo();
}
function releaseUrl(conf) {
  if (conf && conf.releasesUrl) return conf.releasesUrl;
  return baseRepo() + (channel() ? '/releases/tags/' + channel() : '/releases/latest');
}
// plain http only for a test server (CYTV_API) or a custom release source in config.json
function allowHttp() {
  return !!process.env.CYTV_API || !!readJson(P.CONF, {}).releasesUrl;
}
var GITHUB = {
  headers: { 'User-Agent': 'cleanyourtv-manager', Accept: 'application/vnd.github+json, application/json, */*' },
  allowHttp: allowHttp,
  redirects: 6,
};
var FILE = {
  headers: { 'User-Agent': 'cleanyourtv-manager', Accept: 'application/octet-stream, */*' },
  allowHttp: allowHttp,
  redirects: 6,
};

// the commit a build was made from (dev builds only; a stable install has no BUILD file)
function buildOf(f) {
  var b = readText(f);
  return /^[0-9a-f]{7,40}$/.test(b) ? b : '';
}
function buildInBody(body) {
  var m = /^build:\s*([0-9a-f]{7,40})\s*$/m.exec(String(body || ''));
  return m ? m[1] : '';
}
// the files of a release: the launcher and the service package are versioned separately, each needs its .sha256
function parseRelease(j) {
  /** @type {Record<string, string>} */
  var assets = {};
  var list = j.assets || [];
  for (var i = 0; i < list.length; i++) assets[list[i].name] = list[i].browser_download_url;
  var frontend = null,
    service = null,
    ks = Object.keys(assets);
  for (var k = 0; k < ks.length; k++) {
    var n = ks[k];
    var m = /^frontend-(\d+\.\d+\.\d+)\.tgz$/.exec(n);
    if (m && assets[n + '.sha256']) frontend = m[1];
    m = /^com\.cleanyourtv\.manager_(\d+\.\d+\.\d+)_all\.ipk$/.exec(n);
    if (m && assets[n + '.sha256']) service = m[1];
  }
  return {
    version: j.tag_name === DEV_TAG ? service || '' : String(j.tag_name || '').replace(/^(v|test-)/, ''),
    frontend: frontend,
    service: service,
    assets: assets,
    build: buildInBody(j.body),
    test: !!channel(),
    notes: String(j.body || '').slice(0, 600),
  };
}
function latest(conf) {
  return fetch.read(releaseUrl(conf), nc.assign({ totalMs: 45000, totalText: 'no answer from GitHub in time' }, GITHUB)).then(function (r) {
    return parseRelease(JSON.parse(r.body.toString()));
  });
}
// download a release file and check it against its .sha256
function download(release, name, dest) {
  var url = release.assets[name],
    shaUrl = release.assets[name + '.sha256'];
  if (!url) return Promise.reject(new Error('release has no ' + name));
  if (!shaUrl) return Promise.reject(new Error('release has no ' + name + '.sha256, refusing to install an unchecked file'));
  return fetch.read(shaUrl, GITHUB).then(function (r) {
    var want = r.body.toString().trim().split(/\s+/)[0].toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(want)) throw new Error('bad checksum file');
    return fetch.toFile(url, dest, FILE).then(function (out) {
      if (out.sha256 !== want) {
        try {
          fs.unlinkSync(dest);
        } catch (_) {}
        throw new Error('checksum mismatch');
      }
    });
  });
}
// is the offered file different from what is installed? A newer version always is; a dev build also when it is another commit of the
// same version; and a dev build installed with the channel back on stable offers the stable release, even an older one or one of the same
// version (a dev build carries the version of the release it leads to, but not its files).
function differs(offered, installed, offeredBuild, installedBuild) {
  if (!offered) return false;
  if (cmp(offered, installed) > 0) return true;
  if (offeredBuild) return offeredBuild !== installedBuild;
  return !!installedBuild;
}

function delay(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function create(ctx) {
  var luna = ctx.luna,
    config = ctx.config,
    version = ctx.version;
  var D = P.D;
  var job = { state: 'idle', message: '', at: 0 },
    /** @type {any} */
    release = null,
    releaseAt = 0,
    releaseErr = '',
    /** @type {string|null} */
    frontendOk = null,
    checking = false;
  function setJob(state, message) {
    job = { state: state, message: message, at: Date.now() };
  }
  function busy() {
    return job.state === 'working';
  }
  function serviceBuild() {
    return buildOf(D + '/BUILD');
  }
  function frontendBuild() {
    return buildOf(D + '/app/BUILD');
  }
  function frontendInfo() {
    return readJson(D + '/app/version.json', {});
  }
  function prevInfo() {
    return readJson(D + '/app.prev/version.json', null);
  }

  function check() {
    checking = true;
    return latest(config.get())
      .then(
        function (rel) {
          release = rel;
          releaseErr = '';
        },
        function (e) {
          release = null;
          releaseErr = e.message === 'HTTP 404' ? 'no release published yet' : String(e.message || e);
        }
      )
      .then(function () {
        releaseAt = Date.now();
        checking = false;
        return release;
      });
  }
  // the update part of the manager's status
  function status() {
    var fe = frontendInfo(),
      lat = release,
      prev = prevInfo();
    return {
      service: {
        version: version,
        build: serviceBuild(),
        updateTo: lat && differs(lat.service, version, lat.build, serviceBuild()) ? lat.service : null,
      },
      frontend: {
        version: fe.version || '?',
        build: frontendBuild(),
        previous: (prev && prev.version) || null,
        updateTo: lat && differs(lat.frontend, fe.version, lat.build, frontendBuild()) ? lat.frontend : null,
      },
      channel: channel(),
      release: lat
        ? { version: lat.version, frontend: lat.frontend, service: lat.service, build: lat.build, test: lat.test, notes: lat.notes }
        : null,
      checkedAt: releaseAt,
      checking: checking,
      checkError: releaseErr,
    };
  }
  function stale() {
    return !checking && Date.now() - releaseAt > 300000;
  }

  // ---- a package installed by someone else (the Homebrew Channel, ares-install): the running service is the copy in D, so it is
  // brought to the package's version with bootstrap.sh update, as after an update from the manager. Only once the package has stayed
  // the same for two checks in a row and no update of our own is running (that one runs bootstrap.sh update itself). ----
  function packaged() {
    try {
      var v = (/(?:const|var) VERSION = '([^']+)'/.exec(fs.readFileSync(P.SERVICE_DIR + '/helper/helper.js', 'utf8')) || [])[1];
      return v && fs.existsSync(P.SERVICE_DIR + '/bootstrap.sh') ? v + ' ' + (buildOf(P.SERVICE_DIR + '/BUILD') || '') : '';
    } catch (_) {
      return '';
    }
  }
  var seenPackage = '',
    applied = false;
  function watchPackage() {
    var now = packaged();
    if (!now || applied || busy() || now === version + ' ' + (serviceBuild() || '')) return void (seenPackage = '');
    if (now !== seenPackage) return void (seenPackage = now);
    applied = true;
    var ver = now.split(' ')[0];
    // bootstrap.sh writes this when the new version did not start and it went back: do not try the same package again and again
    if (readText(D + '/last-error.txt').indexOf('update to ' + ver + ' failed') >= 0) return;
    console.log('updates: the installed package is service ' + now.trim() + ', this is ' + version + '; applying it');
    exec.detached('sleep 1; sh ' + P.SERVICE_DIR + '/bootstrap.sh update ' + ver);
  }

  // ---- the launcher: D/app is replaced, the old one kept as D/app.prev; a launcher that does not report back is rolled back ----
  // reload-home.sh closes the Home page and launches it again; on webOS 6, where WebAppMgr keeps the old page and there is no
  // renderer process to stop, it restarts webapp-mgr (issue 9: the new launcher never started there and the update rolled back)
  function reloadHome() {
    return exec.sh('sh ' + D + '/reload-home.sh', 90000).then(function () {});
  }
  function swapIn(src) {
    return exec.sh(
      [
        'rm -rf ' + D + '/app.prev',
        'mv ' + D + '/app ' + D + '/app.prev',
        'mv ' + src + ' ' + D + '/app',
        'sh ' + D + '/stage-home.sh',
      ].join(' && ')
    );
  }
  function swapBack() {
    return exec
      .sh(
        [
          'rm -rf ' + D + '/app.next',
          'mv ' + D + '/app ' + D + '/app.next',
          'mv ' + D + '/app.prev ' + D + '/app',
          'mv ' + D + '/app.next ' + D + '/app.prev',
          'sh ' + D + '/stage-home.sh',
        ].join(' && ')
      )
      .then(reloadHome);
  }
  function waitFrontend(ver, ms) {
    var until = Date.now() + ms;
    function poll() {
      if (frontendOk === ver) return Promise.resolve(true);
      if (Date.now() >= until) return Promise.resolve(false);
      return delay(1000).then(poll);
    }
    return poll();
  }
  function updateFrontend(ver) {
    setJob('working', 'Downloading launcher ' + ver);
    var T = D + '/tmp-frontend';
    var ready = !release || release.frontend !== ver ? check() : Promise.resolve(release);
    return ready
      .then(function () {
        if (!release || release.frontend !== ver) throw new Error('launcher ' + ver + ' is not in the latest release');
        return exec.sh('rm -rf ' + T + ' && mkdir -p ' + T);
      })
      .then(function () {
        return download(release, 'frontend-' + ver + '.tgz', T + '/f.tgz');
      })
      .then(function () {
        setJob('working', 'Checking the download');
        return exec.sh('tar tzf ' + T + '/f.tgz');
      })
      .then(function (lst) {
        var names = lst.out.split('\n').filter(Boolean);
        function bad(n) {
          return n.indexOf('/') === 0 || n.split('/').indexOf('..') >= 0 || !(n === 'app' || n.indexOf('app/') === 0);
        }
        if (!lst.ok || !names.length || names.some(bad)) throw new Error('unexpected files in the download');
        return exec.sh('cd ' + T + ' && tar xzf f.tgz');
      })
      .then(function (unpack) {
        if (!unpack.ok) throw new Error('could not unpack');
        var nv = readJson(T + '/app/version.json', {});
        if (nv.version !== ver || !fs.existsSync(T + '/app/index.html')) throw new Error('the download is not launcher ' + ver);
        if (nv.minService && cmp(version, nv.minService) < 0)
          throw new Error('needs service ' + nv.minService + ' or newer; update the service first');
        setJob('working', 'Installing launcher ' + ver);
        frontendOk = null;
        return swapIn(T + '/app').then(reloadHome);
      })
      .then(function () {
        setJob('working', 'Checking that the new launcher starts');
        return waitFrontend(ver, 40000);
      })
      .then(function (started) {
        if (!started) {
          setJob('working', 'The new launcher did not start; rolling back');
          return swapBack().then(function () {
            throw new Error('the new launcher did not start; the previous version is back');
          });
        }
        setJob('done', 'Launcher ' + ver + ' installed');
      })
      .then(null, function (e) {
        setJob('error', String(e.message || e));
      })
      .then(function () {
        return exec.sh('rm -rf ' + T).then(function () {});
      });
  }
  function rollbackFrontend() {
    var prev = prevInfo();
    if (!prev) {
      setJob('error', 'there is no previous version');
      return Promise.resolve();
    }
    setJob('working', 'Going back to launcher ' + prev.version);
    return swapBack().then(
      function () {
        setJob('done', 'Launcher ' + frontendInfo().version + ' restored');
      },
      function (e) {
        setJob('error', String(e.message || e));
      }
    );
  }

  // ---- the service: the system installs the package, then bootstrap.sh update restarts the service (and undoes a failed start) ----
  function updateService(ver) {
    setJob('working', 'Downloading service ' + ver);
    var f = D + '/tmp-service.ipk',
      name = 'com.cleanyourtv.manager_' + ver + '_all.ipk';
    var ready = !release || release.service !== ver ? check() : Promise.resolve(release);
    return ready
      .then(function () {
        if (!release || release.service !== ver) throw new Error('service ' + ver + ' is not in the latest release');
        return download(release, name, f);
      })
      .then(function () {
        setJob('working', 'Installing service ' + ver);
        return luna('luna://com.webos.appInstallService/dev/install', {
          id: 'com.cleanyourtv.manager',
          ipkUrl: f,
          subscribe: false,
        });
      })
      .then(function (r) {
        if (!r.returnValue) throw new Error('the system refused the install: ' + (r.errorText || ''));
        var until = Date.now() + 90000,
          before = buildOf(P.SERVICE_DIR + '/BUILD'),
          seen = 0;
        function poll() {
          if (Date.now() >= until) return Promise.resolve(false);
          return delay(3000)
            .then(function () {
              return luna('luna://com.webos.applicationManager/getAppInfo', { id: 'com.cleanyourtv.manager' });
            })
            .then(function (ai) {
              if (!(ai.appInfo && ai.appInfo.version === ver)) return poll();
              // the same version number can be a different build: wait until the package's BUILD file is the offered one (or gone, for
              // stable after a dev build); a package that does not touch it is accepted after 30 s
              if (!seen) seen = Date.now();
              var now = buildOf(P.SERVICE_DIR + '/BUILD');
              if (release.build ? now === release.build : !before || !now) return true;
              if (Date.now() - seen > 30000) return true;
              return poll();
            });
        }
        return poll();
      })
      .then(function (ok) {
        if (!ok) throw new Error('the install did not finish');
        setJob('working', 'Restarting the service');
        exec.detached('sleep 1; sh ' + P.SERVICE_DIR + '/bootstrap.sh update ' + ver);
      })
      .then(null, function (e) {
        setJob('error', String(e.message || e));
        try {
          fs.unlinkSync(f);
        } catch (_) {}
      });
  }

  // the dev build on offer (the manager's Update channel list): the pre-release named dev, or none while it is being rebuilt
  function tests() {
    return fetch.read(baseRepo() + '/releases/tags/' + DEV_TAG, GITHUB).then(
      function (res) {
        var r = JSON.parse(res.body.toString());
        var p = parseRelease(r);
        var builds = r.prerelease
          ? [{ tag: DEV_TAG, branch: DEV_TAG, build: p.build, published: r.published_at, service: p.service, frontend: p.frontend }]
          : [];
        return { channel: channel(), builds: builds };
      },
      function (e) {
        return { channel: channel(), builds: [], error: e.message === 'HTTP 404' ? '' : String(e.message || e) };
      }
    );
  }
  // { tag: "dev" } or { tag: "" } for the stable releases (an old test-<branch> tag means dev); returns an error text or ''
  function setChannel(tag) {
    var t = String(tag || '');
    if (OLD_TEST_TAG.test(t)) t = DEV_TAG;
    if (t && t !== DEV_TAG) return Promise.resolve('unknown channel');
    if (busy()) return Promise.resolve('an update is running');
    try {
      if (t) fs.writeFileSync(P.CHANNEL, t + '\n');
      else fs.unlinkSync(P.CHANNEL);
    } catch (_) {}
    release = null;
    releaseAt = 0;
    return check().then(function () {
      return '';
    });
  }

  return {
    check: check,
    status: status,
    stale: stale,
    watchPackage: watchPackage,
    job: function () {
      return job;
    },
    busy: busy,
    tests: tests,
    setChannel: setChannel,
    updateFrontend: updateFrontend,
    rollbackFrontend: rollbackFrontend,
    updateService: updateService,
    frontendLoaded: function (v) {
      frontendOk = v;
    },
    repo: function () {
      return releaseUrl(config.get())
        .replace(/^https?:\/\/[^/]+\/repos\//, '')
        .replace(/\/releases.*$/, '');
    },
  };
}

module.exports = {
  create: create,
  latest: latest,
  download: download,
  parseRelease: parseRelease,
  differs: differs,
  channel: channel,
  repo: repo,
  releaseUrl: releaseUrl,
  DEV_TAG: DEV_TAG,
};
