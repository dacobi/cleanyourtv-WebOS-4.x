// The Running apps menu's service side (running.js, issue 16): what is listed, what can be closed, and how.
const { ok, call, req, run } = require('./lib');
const running = req('running');

run(async () => {
  const apps = [
    { id: 'netflix', title: 'Netflix' },
    { id: 'youtube.leanback.v4', title: 'YouTube' },
    { id: 'com.webos.app.hdmi1', title: 'HDMI 1' },
  ];
  const listed = running.pick(
    [
      { id: 'netflix' },
      { appId: 'youtube.leanback.v4' },
      { id: 'netflix' },
      { id: 'com.webos.app.home' },
      { id: 'com.webos.app.fullhome' },
      { id: 'com.cleanyourtv.picker' },
      { id: 'airplay' },
      null,
    ],
    apps
  );
  ok(listed.map(a => a.id).join() === 'netflix,youtube.leanback.v4', 'running apps the launcher knows, once each (by id or appId)');
  ok(
    !listed.some(a => /^com\.webos\.app\.(full)?home$/.test(a.id) || /cleanyourtv/.test(a.id)) && !listed.some(a => a.id === 'airplay'),
    'never Home (home or fullhome), never our own apps, never apps the launcher does not list'
  );
  ok(listed[1].title === 'YouTube', 'with the title the launcher shows');

  let runningNow = [{ id: 'netflix' }, { id: 'youtube.leanback.v4' }, { id: 'com.cleanyourtv.picker' }],
    calls = [],
    closeByAppIdWorks = true;
  const luna = async (uri, p) => {
    calls.push(uri.split('/').pop() + ' ' + ((p && (p.id || p.appId)) || ''));
    if (/running$/.test(uri)) return { returnValue: true, running: runningNow };
    if (/closeByAppId$/.test(uri)) return { returnValue: closeByAppIdWorks };
    if (/close$/.test(uri)) return { returnValue: true };
    if (/removeRecent$/.test(uri)) return { returnValue: false, errorText: 'no such service' };
    return {};
  };
  const r = running.create({ luna, feature: n => (n === 'apps' ? { apps: async () => apps } : null) });
  let x = await call(r, '/api/running');
  ok(x.j.apps.length === 2 && x.j.apps[0].id === 'netflix', 'GET /api/running lists them');
  x = await call(r, '/api/running/close', 'POST', { id: 'com.cleanyourtv.picker' });
  ok(x.j.returnValue === false && !calls.some(c => /close.* com.cleanyourtv/.test(c)), 'our own picker cannot be closed this way');
  x = await call(r, '/api/running/close', 'POST', { id: 'com.webos.app.home' });
  const xf = await call(r, '/api/running/close', 'POST', { id: 'com.webos.app.fullhome' });
  ok(x.j.returnValue === false && xf.j.returnValue === false, 'Home (home or fullhome) cannot be closed');
  calls = [];
  x = await call(r, '/api/running/close', 'POST', { id: 'netflix' });
  ok(
    x.j.returnValue === true &&
      x.j.closed.join() === 'netflix' &&
      calls.indexOf('closeByAppId netflix') >= 0 &&
      calls.indexOf('removeRecent netflix') >= 0,
    'one app: closeByAppId, then it leaves the recents'
  );
  ok(
    calls.indexOf('removeRecent netflix') > calls.indexOf('closeByAppId netflix'),
    'a missing recent service does not matter: the app is closed'
  );
  closeByAppIdWorks = false;
  calls = [];
  x = await call(r, '/api/running/close', 'POST', { all: true });
  ok(
    x.j.returnValue === true && x.j.closed.join() === 'netflix,youtube.leanback.v4' && calls.indexOf('close youtube.leanback.v4') >= 0,
    'Close all closes every listed app, with close as the fallback'
  );
  runningNow = [];
  x = await call(r, '/api/running/close', 'POST', { all: true });
  ok(x.j.returnValue === false && /nothing is running/.test(x.j.errorText), 'nothing to close');
  x = await call(r, '/api/running/close', 'POST', { all: 'yes' });
  ok(x.j.returnValue === false, 'only all: true closes everything');
});
