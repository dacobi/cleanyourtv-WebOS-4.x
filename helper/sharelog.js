#!/usr/bin/env node
// Standalone: collects a diagnostic report and serves it on the local network for ten minutes at an address with a random
// token, so it can be opened on a phone (the manager app shows the address as a QR code). It does not need the service to
// be running, so it also works when the setup failed. Addresses, MAC addresses and URL paths are masked in the report.
// Writes /tmp/cytv-sharelog.json {url, until}. Usage: node sharelog.js
var http = require('http'),
  fs = require('fs'),
  crypto = require('crypto');
var P = require('./paths'),
  exec = require('./exec'),
  web = require('./web'),
  i18n = require('./i18n');
var D = P.D,
  SVC = P.SERVICE_DIR,
  SETUPLOG = P.SETUP_LOG;
var STATE = '/tmp/cytv-sharelog.json',
  PIDF = '/tmp/cytv-sharelog.pid',
  LIFE = 10 * 60 * 1000;

function sh(cmd, ms) {
  return exec.shSync(cmd, ms);
}
function read(f, tail) {
  try {
    var t = fs.readFileSync(f, 'utf8');
    return tail ? t.split('\n').slice(-tail).join('\n') : t;
  } catch (_) {
    return '(not present)';
  }
}

// ---- masking ----
function redact(t) {
  return t
    .replace(/https?:\/\/[^\s"'<>)]+/g, function (u) {
      var m = /^(https?:\/\/)([^\/:?#]+)/.exec(u);
      if (!m) return '<url>';
      return m[1] + (m[2] === '127.0.0.1' ? m[2] : /^\d+\.\d+\.\d+\.\d+$/.test(m[2]) ? 'x.x.x.x' : m[2]) + '/…';
    })
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, function (ip) {
      return ip === '127.0.0.1' || ip === '0.0.0.0' ? ip : 'x.x.x.x';
    })
    .replace(/\b[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5}\b/g, 'xx:xx:xx:xx:xx:xx')
    .replace(/("(?:token|key|password|pass|secret|apikey)"\s*:\s*")[^"]*"/gi, '$1…"');
}

function report() {
  /** @type {string[]} */
  var o = [];
  function sec(title, body) {
    o.push('\n===== ' + title + ' =====\n' + String(body).trim());
  }
  sec('CleanYourTV report', new Date().toISOString());
  function ver(f) {
    return (/(?:const|var) VERSION = '([^']+)'/.exec(read(f)) || [])[1] || '?';
  }
  var info = sh(
    'luna-send -n 1 -w 5000 -f luna://com.webos.service.tv.systemproperty/getSystemInfo \'{"keys":["modelName","firmwareVersion","sdkVersion"]}\' </dev/null'
  );
  sec(
    'TV',
    info.replace(/\s+/g, ' ') + '\n' + sh('uname -a').trim() + '\nnode ' + process.version + '\n' + sh('python3 --version 2>&1').trim()
  );
  sec(
    'Versions',
    'service (package): ' +
      ver(SVC + '/helper/helper.js') +
      '\nservice (running copy): ' +
      ver(D + '/helper.js') +
      '\nlauncher: ' +
      read(D + '/app/version.json').replace(/\s+/g, ' ')
  );
  sec('TV profile (tvprofile.js)', read(P.TV).replace(/\s+/g, ' '));
  var activeId = read(P.HOME_ID_FILE).trim();
  var home =
    activeId === 'com.webos.app.fullhome' ? read(D + '/backup/fullhome-appinfo.orig.json') : read(D + '/backup/home-appinfo.orig.json');
  if (home === '(not present)') {
    home = read((activeId === 'com.webos.app.fullhome' ? P.FULLHOME_APP : P.HOME_APP) + '/appinfo.json');
  }
  try {
    var h = JSON.parse(home);
    sec(
      "LG's Home app (stock appinfo)",
      JSON.stringify(
        { id: h.id, version: h.version, type: h.type, main: h.main, defaultWindowType: h.defaultWindowType, appCategory: h.appCategory },
        null,
        1
      )
    );
  } catch (_) {
    sec("LG's Home app (stock appinfo)", home.slice(0, 1500));
  }
  sec(
    'Mounts and boot scripts',
    sh("grep -E 'com.webos.app.(full)?home|InputPicker' /proc/mounts | cut -c1-120 | head -5") + '\n' + sh('ls ' + P.INITD + ' 2>&1')
  );
  var checkIds = ['com.cleanyourtv.manager', 'com.cleanyourtv.picker', 'com.cleanyourtv.notify', 'com.webos.app.home'];
  if (fs.existsSync(P.FULLHOME_APP)) checkIds.push('com.webos.app.fullhome');
  var apps = '';
  for (var i = 0; i < checkIds.length; i++) {
    var id = checkIds[i];
    apps +=
      id +
      ': ' +
      (/"returnValue": true/.test(
        sh('luna-send -n 1 -w 4000 -f luna://com.webos.applicationManager/getAppInfo \'{"id":"' + id + '"}\' </dev/null')
      )
        ? 'registered'
        : 'not registered') +
      '\n';
  }
  sec('Apps', apps);
  var opts = '(no config)';
  try {
    opts = JSON.stringify(JSON.parse(read(D + '/config.json')).options || {});
  } catch (_) {}
  sec('Options', opts + '\nDISABLE file: ' + (fs.existsSync(D + '/DISABLE') ? 'yes (LG Home selected)' : 'no'));
  var keys = '{}';
  try {
    keys = JSON.stringify(JSON.parse(read(D + '/config.json')).keys || {});
  } catch (_) {}
  var hl = read(P.HOOK_LOG);
  /** @type {Record<string, number>} */
  var codes = {};
  (hl.match(/uinput_code=\d+/g) || []).forEach(function (c) {
    codes[c] = (codes[c] || 0) + 1;
  });
  sec(
    'Remote keys',
    'learned: ' +
      keys +
      '\nhook attached: ' +
      (/InputHook initialized/.test(hl) && /lib_main returned: 0/.test(hl)) +
      '\nkey codes seen in the hook log: ' +
      JSON.stringify(codes) +
      '\n' +
      hl
        .split('\n')
        .filter(function (l) {
          return /\[(ERRO|FAIL|WARN)|Resolving|Applying|initialized/.test(l);
        })
        .slice(0, 8)
        .join('\n')
  );
  sec('Service status', sh('curl -s -m 3 http://127.0.0.1:8765/api/manager/status 2>&1').slice(0, 2500) || '(service not answering)');
  sec('Setup log (' + SETUPLOG + ')', read(SETUPLOG, 150));
  sec('Service log saved at the last rollback', read(SETUPLOG + '.service', 80));
  sec('Last update error', read(D + '/last-error.txt'));
  var changes = read(P.SERVICE_LOG)
    .split('\n')
    .filter(function (l) {
      return /^config: /.test(l);
    });
  sec('Settings changes (config: ...)', changes.length ? changes.slice(-20).join('\n') : '(none since the service started)');
  sec('Boot steps (/tmp/cleanyourtv-boot.log)', read('/tmp/cleanyourtv-boot.log', 40));
  sec('Service log (last 80 lines)', read(P.SERVICE_LOG, 80));
  sec('Input hook (last 10 lines)', read(P.HOOK_LOG, 10));
  return redact(o.join('\n') + '\n').slice(0, 300000);
}

// ---- server ----
function lanIp() {
  return web.lanIp() || '127.0.0.1';
}
// the page around the report is in the phone's language (i18n.js); the report itself stays English, for the people who read the bug report
function page(text, lang) {
  function T(x) {
    return web.esc(i18n.tr(lang, x));
  }
  return (
    '<!doctype html><html lang="' +
    lang +
    '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
    T('CleanYourTV report') +
    '</title>' +
    '<style>body{margin:0;padding:16px;font:16px/1.4 -apple-system,Helvetica,Arial,sans-serif;background:#111;color:#eee}h1{font-size:20px;margin:0 0 8px}p{margin:0 0 12px;color:#bbb}' +
    'button{font:inherit;font-weight:600;padding:12px 18px;margin:0 8px 12px 0;border:0;border-radius:10px;background:#f5f6f8;color:#111}textarea{width:100%;height:60vh;box-sizing:border-box;background:#000;color:#ddd;border:1px solid #333;border-radius:8px;padding:10px;font:12px/1.35 ui-monospace,Menlo,monospace}</style></head><body>' +
    '<h1>' +
    T('CleanYourTV report') +
    '</h1><p>' +
    T(
      'Tap Copy, then paste it into your message. Addresses and URL paths are masked. This page closes ten minutes after it was opened on the TV.'
    ) +
    '</p>' +
    '<button id="c">' +
    T('Copy') +
    '</button><button id="s">' +
    T('Select all') +
    '</button><span id="m"></span><textarea id="t" readonly></textarea>' +
    '<script>var t=document.getElementById("t");t.value=' +
    JSON.stringify(text).replace(/</g, '\\u003c') +
    ';' +
    'document.getElementById("s").onclick=function(){t.focus();t.select();t.setSelectionRange(0,t.value.length)};' +
    'document.getElementById("c").onclick=function(){t.focus();t.select();t.setSelectionRange(0,t.value.length);var ok=false;try{ok=document.execCommand("copy")}catch(e){}' +
    'document.getElementById("m").textContent=ok?' +
    JSON.stringify(i18n.tr(lang, 'Copied')) +
    ':' +
    JSON.stringify(i18n.tr(lang, 'Press and hold the text, then choose Copy')) +
    '};</script></body></html>'
  );
}

function main() {
  try {
    var old = parseInt(fs.readFileSync(PIDF, 'utf8'), 10);
    if (old) process.kill(old, 'SIGTERM');
  } catch (_) {}
  var token = crypto.randomBytes(9).toString('hex');
  var text = 'The report is still being prepared; reload in a few seconds.';
  var srv = http.createServer(function (req, res) {
    var u = String(req.url || '').split('?')[0];
    if (u === '/' + token) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(page(text, i18n.lang(req, '')));
    }
    if (u === '/' + token + '.txt') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(text);
    }
    res.writeHead(404);
    res.end();
  });
  var port = 8768;
  srv.on('error', function (/** @type {any} */ e) {
    if (e.code === 'EADDRINUSE' && port < 8790) {
      port++;
      srv.listen(port, '0.0.0.0');
    } else {
      console.error(e.message);
      process.exit(1);
    }
  });
  srv.on('listening', function () {
    var until = Date.now() + LIFE;
    fs.writeFileSync(STATE, JSON.stringify({ url: 'http://' + lanIp() + ':' + port + '/' + token, until: until }));
    fs.writeFileSync(PIDF, String(process.pid));
    setTimeout(function () {
      try {
        fs.unlinkSync(STATE);
      } catch (_) {}
      process.exit(0);
    }, LIFE);
    // collected after the address is published: right after a boot the luna calls can take a long time
    setTimeout(function () {
      text = report();
    }, 50);
  });
  srv.listen(port, '0.0.0.0');
}
if (require.main === module) {
  if (process.argv[2] === '--print') process.stdout.write(report());
  else main();
}
module.exports = { report: report, redact: redact };
