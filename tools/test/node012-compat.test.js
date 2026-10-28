// Node 0.12.2 (webOS 4.x) compatibility: every file in helper/ and scripts/jtool.js must parse as ES5 and avoid APIs added after
// Node 0.12 (Buffer.from/alloc, Object.assign/values/entries, Array/String .includes/.startsWith/.endsWith/.find, Set/Map, fs.copyFileSync,
// stat.mtimeMs, 'latin1' encoding, crypto.timingSafeEqual, global URL/URLSearchParams).
const fs = require('fs'),
  path = require('path');
const { root, tmp, ok, req, run } = require('./lib');
const nc = req('netcompat');

function stripComments(src) {
  // Replace block and line comments while keeping string and regex literals intact enough for API scanning.
  return src.replace(/\/\*[\s\S]*?\*\/|([^:\\]|^)\/\/.*$/gm, '$1');
}

run(async () => {
  const acorn = require(path.join(root, 'tools', 'vendor', 'acorn.js'));
  const helperDir = path.join(root, 'helper');
  const files = fs
    .readdirSync(helperDir)
    .filter(f => /\.js$/.test(f))
    .sort()
    .map(f => path.join('helper', f))
    .concat(['scripts/jtool.js', 'tools/test-node012.js']);

  const syntaxBad = [];
  for (const rel of files) {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) continue;
    const raw = fs.readFileSync(full, 'utf8').replace(/^#!.*\n/, '');
    try {
      acorn.parse(raw, { ecmaVersion: 5 });
    } catch (e) {
      syntaxBad.push(rel + ': ' + e.message);
    }
  }
  ok(
    !syntaxBad.length,
    'every helper, jtool.js and test-node012.js parses as pure ES5' + (syntaxBad.length ? ':\n  ' + syntaxBad.join('\n  ') : '')
  );

  const banned = [
    [/\bBuffer\.(from|alloc|allocUnsafe)\s*\(/, 'Buffer.from/alloc (use nc.bufFrom / nc.bufAlloc)'],
    [/\bfs\.(copyFileSync|rmSync|cpSync|promises)\b/, 'post-0.12 fs API (use nc.copyFileSync / manual unlink)'],
    [/\bmkdirSync\s*\([^)]*recursive/, 'mkdirSync({ recursive })'],
    [/\.mtimeMs\b/, 'stat.mtimeMs (use +st.mtime)'],
    [/['"]latin1['"]/, "'latin1' encoding (use 'binary' on Node 0.12)"],
    [/\bcrypto\.(timingSafeEqual|randomInt)\b/, 'post-0.12 crypto API (use nc.timingSafeEqual)'],
    [/\bnew\s+(Set|Map|WeakSet|WeakMap)\s*\(/, 'ES2015+ collection constructor'],
    [/\bObject\.(assign|values|entries|fromEntries)\s*\(/, 'ES2015+ Object static method'],
    [/\bArray\.from\s*\(/, 'Array.from'],
    [/\.(includes|startsWith|endsWith|findIndex|padStart|padEnd)\s*\(/, 'ES2015+ String/Array method'],
  ];
  const apiBad = [];
  for (const rel of files) {
    if (rel === 'helper/netcompat.js') continue; // feature-detects modern APIs with Node 0.12 fallbacks
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) continue;
    const clean = stripComments(fs.readFileSync(full, 'utf8'));
    const hasLocalUrl = /\bURL\s*=/.test(clean),
      hasLocalSp = /\bURLSearchParams\s*=/.test(clean);
    clean.split('\n').forEach((line, i) => {
      for (const r of banned) if (r[0].test(line)) apiBad.push(rel + ':' + (i + 1) + ' ' + r[1]);
      if (!hasLocalUrl && /\bnew\s+URL\s*\(/.test(line)) apiBad.push(rel + ':' + (i + 1) + ' global URL (use nc.URL)');
      if (!hasLocalSp && /\bnew\s+URLSearchParams\s*\(/.test(line))
        apiBad.push(rel + ':' + (i + 1) + ' global URLSearchParams (use nc.URLSearchParams)');
    });
  }
  ok(!apiBad.length, 'no post-Node-0.12 APIs in helper/ or jtool.js' + (apiBad.length ? ':\n  ' + apiBad.join('\n  ') : ''));

  // Direct tests of netcompat's pure-ES5 polyfills (PolyURL, PolySearchParams, bufFrom, bufAlloc, timingSafeEqual, copyFileSync)
  const u1 = new nc.PolyURL('https://example.com:8443/a/b?x=1&y=two#frag');
  ok(
    u1.protocol === 'https:' &&
      u1.hostname === 'example.com' &&
      u1.port === '8443' &&
      u1.host === 'example.com:8443' &&
      u1.pathname === '/a/b' &&
      u1.searchParams.get('x') === '1' &&
      u1.hash === '#frag',
    'PolyURL parses protocol, host, port, pathname, searchParams and hash'
  );
  const u2 = new nc.PolyURL('../c/d?z=9', 'http://192.168.1.5:8123/a/b/index.html');
  u2.searchParams.set('k', 'hello world');
  ok(
    u2.toString() === 'http://192.168.1.5:8123/a/c/d?z=9&k=hello%20world',
    'PolyURL resolves relative URLs against a base and serialises updated searchParams'
  );
  const u6 = new nc.PolyURL('http://[::1]:8080/status');
  ok(u6.hostname === '[::1]' && u6.port === '8080' && u6.host === '[::1]:8080', 'PolyURL preserves IPv6 bracketed hostnames');

  const b1 = nc.bufFrom('hello', 'utf8'),
    b2 = nc.bufFrom([104, 101, 108, 108, 111]),
    z = nc.bufAlloc(8);
  let allZero = z.length === 8;
  for (let i = 0; i < z.length; i++) if (z[i] !== 0) allZero = false;
  ok(b1.toString('utf8') === 'hello' && nc.timingSafeEqual(b1, b2) && allZero, 'bufFrom, bufAlloc (zero-filled) and timingSafeEqual');
  ok(
    !nc.timingSafeEqual(b1, nc.bufFrom('hellp', 'utf8')) && !nc.timingSafeEqual(b1, nc.bufFrom('hi', 'utf8')),
    'timingSafeEqual rejects different content and different lengths'
  );

  const src = path.join(tmp, 'src.bin'),
    dst = path.join(tmp, 'dst.bin');
  fs.writeFileSync(src, b1);
  nc.copyFileSync(src, dst);
  ok(nc.timingSafeEqual(fs.readFileSync(dst), b1), 'nc.copyFileSync copies binary files accurately');
});
