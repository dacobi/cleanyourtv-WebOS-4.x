// The shell side: the scripts parse, and the setup keeps the options the user chose (issues 6 and 7).
const fs = require('fs'),
  path = require('path'),
  cp = require('child_process');
const { root, tmp, ok, run } = require('./lib');

run(async () => {
  const scripts = fs
    .readdirSync(path.join(root, 'scripts'))
    .filter(f => !/\.js$/.test(f))
    .map(f => path.join('scripts', f))
    .concat(['install.sh', 'uninstall.sh', 'tools/diagnose.sh']);
  for (const f of scripts) {
    const r = cp.spawnSync('sh', ['-n', path.join(root, f)], { encoding: 'utf8' });
    ok(r.status === 0, 'shell syntax ' + f + (r.status ? ': ' + r.stderr : ''));
  }
  const jt = path.join(root, 'scripts', 'jtool.js'),
    cfg = path.join(tmp, 'config.json');
  const opts = function () {
    return cp.spawnSync(process.execPath, [jt, 'options', cfg].concat([].slice.call(arguments)), { encoding: 'utf8' });
  };
  fs.writeFileSync(cfg, JSON.stringify({ options: { inputKey: false, debloat: false, liveTv: false }, keep: 1 }));
  let r = opts('', '');
  let c = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  ok(
    r.status === 0 && c.options.inputKey === false && c.options.debloat === false && c.options.liveTv === false && c.keep === 1,
    'an update (no values) keeps Input key, Debloat and Live TV as they were'
  );
  ok(/\(kept\)/.test(r.stdout), 'the setup log says the options were kept');
  r = opts('1', '1');
  c = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  ok(
    c.options.inputKey === true && c.options.debloat === true && /were/.test(r.stdout),
    'setup with values sets them and says what they were'
  );
  fs.writeFileSync(cfg, '{}');
  opts('', '');
  c = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  ok(c.options.inputKey === true && c.options.debloat === true, 'a first install without values defaults both to on');
  // the stand-in way (LG's native Home): the program it is mounted over, and the request to webapp-mgr
  const jtool = args => cp.spawnSync(process.execPath, [jt].concat(args), { encoding: 'utf8' });
  const prog = path.join(tmp, 'lg-home-program'),
    nat = path.join(tmp, 'native-home.json');
  fs.writeFileSync(prog, '');
  fs.writeFileSync(nat, JSON.stringify({ id: 'com.webos.app.home', type: 'native', main: prog }));
  r = jtool(['exe', nat]);
  ok(r.status === 0 && r.stdout.trim() === prog, "jtool exe: the program of LG's native Home");
  fs.writeFileSync(nat, JSON.stringify({ id: 'com.webos.app.fullhome', type: 'native', main: 'file://' + prog }));
  ok(
    jtool(['exe', nat]).stdout.trim() === prog &&
      jtool(['homeid', '', '', nat]).stdout.trim() === 'com.webos.app.fullhome' &&
      jtool(['homeid', '{"settings":{"defaultApps":{"home":"com.webos.app.home"}}}', '', nat]).stdout.trim() === 'com.webos.app.home',
    'jtool exe and homeid: strips file://, defaults to native fullhome on webOS 4.x, and honours explicit home selection'
  );
  fs.writeFileSync(nat, JSON.stringify({ id: 'com.webos.app.home', type: 'native', main: path.join(tmp, 'missing') }));
  ok(jtool(['exe', nat]).status === 1, 'jtool exe: a missing program is reported, so the mount way is used instead');
  const ov = path.join(tmp, 'overlay.json'),
    req = path.join(tmp, 'wam-launch.json');
  fs.writeFileSync(ov, JSON.stringify({ id: 'com.webos.app.home', type: 'web', main: 'index.html' }));
  jtool(['wamlaunch', ov, '/media/developer/cleanyourtv/home-overlay', req]);
  const q = JSON.parse(fs.readFileSync(req, 'utf8')),
    qs = JSON.parse(fs.readFileSync(req + '.str', 'utf8'));
  ok(
    q.appDesc.id === 'com.webos.app.home' &&
      q.appDesc.type === 'web' &&
      q.appDesc.folderPath === '/media/developer/cleanyourtv/home-overlay' &&
      JSON.parse(qs.appDesc).folderPath === q.appDesc.folderPath,
    'jtool wamlaunch: webapp-mgr opens the launcher folder as com.webos.app.home (also with the description as a string)'
  );
  // bootstrap.sh run for real against a folder that stands in for the TV's root (CYTV_TEST_ROOT), with stand-ins for luna-send and systemctl
  const R = path.join(tmp, 'root'),
    S = path.join(tmp, 'pkg'),
    BIN = path.join(tmp, 'bin');
  const write = (f, data, mode) => {
    cp.spawnSync('mkdir', ['-p', path.dirname(f)]);
    fs.writeFileSync(f, data);
    if (mode) fs.chmodSync(f, mode);
  };
  const copyDir = (from, to, filter) => {
    cp.spawnSync('mkdir', ['-p', to]);
    for (const n of fs.readdirSync(from)) if (!filter || filter(n)) fs.copyFileSync(path.join(from, n), path.join(to, n));
  };
  copyDir(path.join(root, 'helper'), path.join(S, 'helper'), n => /\.js$/.test(n));
  copyDir(path.join(root, 'scripts'), path.join(S, 'scripts'), n => n !== 'bootstrap.sh');
  fs.copyFileSync(path.join(root, 'scripts', 'bootstrap.sh'), path.join(S, 'bootstrap.sh'));
  write(path.join(S, 'inputhook', 'ezinject'), '', 0o755);
  write(path.join(S, 'inputhook', 'libinputhookpp.so'), '');
  fs.copyFileSync(path.join(root, 'compat.json'), path.join(S, 'compat.json'));
  fs.copyFileSync(path.join(root, 'config.example.json'), path.join(S, 'config.example.json'));
  write(path.join(S, 'payload', 'app', 'index.html'), '<!doctype html>');
  fs.copyFileSync(path.join(root, 'app', 'version.json'), path.join(S, 'payload', 'app', 'version.json'));
  write(
    path.join(R, 'usr/palm/applications/com.webos.app.home/appinfo.json'),
    JSON.stringify({ id: 'com.webos.app.home', type: 'flutter' })
  );
  const NA = path.join(R, 'media/developer/apps/usr/palm/applications/com.cleanyourtv.notify/appinfo.json');
  write(NA, JSON.stringify({ id: 'com.cleanyourtv.notify', defaultWindowType: 'topui' }));
  cp.spawnSync('mkdir', ['-p', path.join(R, 'var/lib/webosbrew/init.d')]);
  write(
    path.join(BIN, 'luna-send'),
    '#!/bin/sh\necho \'{"returnValue": true, "modelName": "OLED55CX3LA", "firmwareVersion": "04.30.10", "sdkVersion": "5.4.3"}\'\n',
    0o755
  );
  write(path.join(BIN, 'systemctl'), '#!/bin/sh\nexit 0\n', 0o755);
  const boot = args =>
    cp.spawnSync('sh', [path.join(S, 'bootstrap.sh')].concat(args), {
      encoding: 'utf8',
      env: Object.assign({}, process.env, { PATH: process.env.PATH + ':' + BIN, CYTV_TEST_ROOT: R }),
      timeout: 60000,
    });
  const D = path.join(R, 'media/developer/cleanyourtv');
  let b = boot(['install', '--no-start', '--no-input-key']);
  const out1 = b.stdout + b.stderr;
  ok(b.status === 0, 'bootstrap.sh install runs to the end (' + (b.status === 0 ? 'ok' : out1.slice(-400)) + ')');
  ok(
    /webOS SDK 5\.4\.3/.test(out1) && /not in the compatibility list; continuing because LG's Home is the flutter or web kind/.test(out1),
    'it reads the TV and accepts a flutter Home that is not in the list'
  );
  ok(
    JSON.parse(fs.readFileSync(NA, 'utf8')).defaultWindowType === 'overlay' && /use the overlay window/.test(out1),
    'on SDK 5 the notification app gets the overlay window (tvprofile.js)'
  );
  ok(
    fs.existsSync(path.join(D, 'helper.js')) &&
      fs.existsSync(path.join(D, 'tvprofile.js')) &&
      fs.existsSync(path.join(D, 'app', 'version.json')),
    'the service files and the launcher are in place'
  );
  let conf = JSON.parse(fs.readFileSync(path.join(D, 'config.json'), 'utf8'));
  ok(conf.options.inputKey === false && conf.options.debloat === true, 'the setup stores the chosen options');
  const initd = path.join(R, 'var/lib/webosbrew/init.d');
  ok(
    fs.lstatSync(path.join(initd, '10-cleanyourtv-home')).isSymbolicLink() &&
      fs.lstatSync(path.join(initd, '15-cleanyourtv-debloat')).isSymbolicLink(),
    'the boot scripts are linked'
  );
  b = boot(['update', '1.6.0', '--no-start']);
  const out2 = b.stdout + b.stderr;
  conf = JSON.parse(fs.readFileSync(path.join(D, 'config.json'), 'utf8'));
  ok(
    b.status === 0 && conf.options.inputKey === false && /options: .*\(kept\)/.test(out2),
    'an update keeps the Input key switched off (issues 6 and 7)'
  );
  ok(fs.existsSync(path.join(D, 'backup', 'service-prev.tgz')), 'an update keeps the previous service files for a rollback');
  fs.writeFileSync(
    path.join(R, 'usr/palm/applications/com.webos.app.home/appinfo.json'),
    JSON.stringify({ id: 'com.webos.app.home', type: 'native' })
  );
  fs.unlinkSync(path.join(D, 'backup', 'home-appinfo.orig.json'));
  b = boot(['install', '--no-start']);
  ok(
    b.status !== 0 && /Set up anyway/.test(b.stderr),
    'a native Home that is not in the list stops the setup with the hint to set up anyway'
  );
  b = boot(['install', '--no-start', '--force']);
  ok(b.status === 0 && /continuing because of --force/.test(b.stderr), 'with --force it continues');

  // bootstrap.sh asks tvprofile.js for the per-TV decisions instead of deciding itself
  const bootText = fs.readFileSync(path.join(root, 'scripts', 'bootstrap.sh'), 'utf8');
  const stop = fs.readFileSync(path.join(root, 'scripts', 'debloat-stop.sh'), 'utf8'),
    undo = fs.readFileSync(path.join(root, 'scripts', 'debloat-undo.sh'), 'utf8');
  ok(
    /mount --bind \/tmp\/cleanyourtv-hosts \/etc\/hosts/.test(stop) && /umount \/etc\/hosts/.test(undo),
    'where /etc/hosts is read-only (issue 11) the ad servers go into a copy in RAM, and the undo removes it'
  );
  ok(
    /TV="node \$S\/helper\/tvprofile\.js"/.test(bootText) &&
      /\$TV get notifyWindow/.test(bootText) &&
      /\$TV get testedNote/.test(bootText) &&
      /\$TV get homeSupported/.test(bootText) &&
      !/TESTED_SDK/.test(bootText),
    'the setup takes the window type and the compatibility list from tvprofile.js'
  );

  // webOS 4.x setup: Upstart (initctl, no systemctl), com.webos.app.fullhome native + com.webos.app.home native, firmware 05.50.00
  const R4 = path.join(tmp, 'root4'),
    BIN4 = path.join(tmp, 'bin4'),
    D4 = path.join(R4, 'media/developer/cleanyourtv');
  write(
    path.join(R4, 'usr/palm/applications/com.webos.app.fullhome/appinfo.json'),
    JSON.stringify({ id: 'com.webos.app.fullhome', type: 'native', main: 'file:///usr/bin/com.webos.app.fullhome' })
  );
  write(path.join(R4, 'usr/bin/com.webos.app.fullhome'), '', 0o755);
  write(
    path.join(R4, 'usr/palm/applications/com.webos.app.home/appinfo.json'),
    JSON.stringify({ id: 'com.webos.app.home', type: 'native', main: '/usr/bin/com.webos.app.home' })
  );
  write(path.join(R4, 'usr/bin/com.webos.app.home'), '', 0o755);
  write(
    path.join(R4, 'media/developer/apps/usr/palm/applications/com.cleanyourtv.notify/appinfo.json'),
    JSON.stringify({ id: 'com.cleanyourtv.notify', defaultWindowType: 'topui' })
  );
  cp.spawnSync('mkdir', ['-p', path.join(R4, 'var/lib/webosbrew/init.d'), path.join(R4, 'etc/init')]);
  for (const j of ['sam', 'WebAppMgr', 'admanager', 'contentminer', 'nudge', 'remotelogger'])
    write(path.join(R4, 'etc/init', j + '.conf'), '');
  write(
    path.join(BIN4, 'luna-send'),
    '#!/bin/sh\necho \'{"returnValue": true, "modelName": "OLED65B9SLA", "firmwareVersion": "05.50.00", "sdkVersion": "4.10.0"}\'\n',
    0o755
  );
  write(path.join(BIN4, 'initctl'), '#!/bin/sh\nexit 0\n', 0o755);
  const b4 = cp.spawnSync('sh', [path.join(S, 'bootstrap.sh'), 'install', '--no-start'], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { PATH: BIN4 + ':' + process.env.PATH, CYTV_TEST_ROOT: R4, CYTV_INIT: 'upstart' }),
    timeout: 60000,
  });
  const s4 = cp.spawnSync('sh', [path.join(D4, 'stage-home.sh'), 'standin'], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { PATH: BIN4 + ':' + process.env.PATH, CYTV_TEST_ROOT: R4, CYTV_INIT: 'upstart' }),
    timeout: 15000,
  });
  const out4 = b4.stdout + b4.stderr;
  ok(
    b4.status === 0 &&
      s4.status === 0 &&
      /in the compatibility list/.test(out4) &&
      fs.existsSync(path.join(D4, 'backup', 'fullhome-appinfo.orig.json')) &&
      fs.readFileSync(path.join(R4, 'tmp', 'cleanyourtv-home-id'), 'utf8').trim() === 'com.webos.app.fullhome' &&
      JSON.parse(fs.readFileSync(path.join(D4, 'home-overlay', 'appinfo.json'), 'utf8')).id === 'com.webos.app.fullhome' &&
      JSON.parse(fs.readFileSync(path.join(D4, 'wam-launch.json'), 'utf8')).appDesc.id === 'com.webos.app.fullhome',
    'webOS 4.x setup (Upstart, no systemctl): backs up fullhome and stages com.webos.app.fullhome for WebAppMgr stand-in'
  );
});
