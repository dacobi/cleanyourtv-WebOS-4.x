// Exercise the real shell hook with local stand-ins; never call the TV or system services.
const fs = require('fs'),
  path = require('path'),
  cp = require('child_process');
const { root, tmp, ok, run } = require('./lib');
run(async () => {
  const bin = path.join(tmp, 'bin'),
    service = path.join(tmp, 'service'),
    calls = path.join(tmp, 'calls');
  fs.mkdirSync(bin);
  fs.mkdirSync(service);
  fs.mkdirSync(path.join(service, 'backup'));
  fs.writeFileSync(path.join(service, 'backup/home-appinfo.orig.json'), JSON.stringify({ id: 'com.webos.app.home', type: 'flutter' }));
  fs.copyFileSync(path.join(root, 'helper/tvprofile.js'), path.join(service, 'tvprofile.js'));
  fs.copyFileSync(path.join(root, 'scripts/jtool.js'), path.join(service, 'jtool.js'));
  fs.copyFileSync(path.join(root, 'scripts/svc.sh'), path.join(service, 'svc.sh'));
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  fs.writeFileSync(path.join(bin, 'luna-send'), '#!/bin/sh\nprintf \'%s\\n\' "$FACTS"\n', { mode: 0o755 });
  fs.writeFileSync(
    path.join(bin, 'systemctl'),
    '#!/bin/sh\ncase "$1" in\ncat) [ "$STATE" != missing ] ;;\nis-active) [ "$STATE" = active ] ;;\nrestart) printf "%s\\n" "$2" >> "$CALLS" ;;\n*) exit 1 ;;\nesac\n',
    { mode: 0o755 }
  );
  const script = fs
    .readFileSync(path.join(root, 'scripts/after-sam.sh'), 'utf8')
    .replace(/^export PATH=.*$/m, 'export PATH="' + bin + ':$PATH"')
    .replace('L=/media/developer/cleanyourtv', 'L="' + service + '"')
    .replace('LOG=/tmp/cleanyourtv-boot.log', 'LOG="' + path.join(tmp, 'boot.log') + '"')
    .replace(/^up\(\).*$/m, 'up() { echo 1; }');
  for (const state of ['active', 'inactive', 'missing']) {
    fs.writeFileSync(calls, '');
    const r = cp.spawnSync('sh', ['-s'], {
      input: script,
      encoding: 'utf8',
      env: Object.assign({}, process.env, {
        FACTS: JSON.stringify({ returnValue: true, sdkVersion: '11.2.0', modelName: 'OLED65C35LA.AEU' }),
        STATE: state,
        CALLS: calls,
      }),
    });
    ok(r.status === 0 && fs.readFileSync(calls, 'utf8') === (state === 'active' ? 'arccontroller\n' : ''), 'post-SAM hook: ARC ' + state);
  }

  // webOS 4.x (Upstart, no systemctl): maps webapp-mgr -> WebAppMgr and preload-manager -> webos-preload-manager, restarts only running jobs
  const upRoot = path.join(tmp, 'uproot'),
    etcInit = path.join(upRoot, 'etc', 'init');
  fs.mkdirSync(upRoot);
  fs.mkdirSync(path.join(upRoot, 'etc'));
  fs.mkdirSync(etcInit);
  for (const j of ['eim', 'WebAppMgr', 'webos-preload-manager']) fs.writeFileSync(path.join(etcInit, j + '.conf'), '');
  fs.writeFileSync(path.join(service, 'backup/home-appinfo.orig.json'), JSON.stringify({ id: 'com.webos.app.fullhome', type: 'native' }));
  fs.writeFileSync(
    path.join(bin, 'initctl'),
    '#!/bin/sh\ncase "$1:$2" in\nstatus:eim) echo "eim start/running, process 101" ;;\nstatus:WebAppMgr) echo "WebAppMgr start/running, process 102" ;;\nstatus:webos-preload-manager) echo "webos-preload-manager stop/waiting" ;;\nrestart:*) printf "%s\\n" "$2" >> "$CALLS" ;;\n*) exit 1 ;;\nesac\n',
    { mode: 0o755 }
  );
  fs.writeFileSync(calls, '');
  const ru = cp.spawnSync('sh', ['-s'], {
    input: script,
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      CYTV_INIT: 'upstart',
      CYTV_TEST_ROOT: upRoot,
      FACTS: JSON.stringify({ returnValue: true, sdkVersion: '4.10.0', modelName: 'OLED65B9SLA' }),
      CALLS: calls,
    }),
  });
  ok(
    ru.status === 0 && fs.readFileSync(calls, 'utf8') === 'eim\nWebAppMgr\n',
    'post-SAM hook on Upstart (webOS 4.x): restarts running eim and WebAppMgr, skips stopped webos-preload-manager and missing memorymanager'
  );
});
