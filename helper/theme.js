// Themes for the launcher's home screen. A theme is a folder in the themes/ folder of the GitHub repository (theme.json, a screenshot and
// optionally a wallpaper and a typeface). Nothing is shipped with the service: the TV reads themes/index.json from GitHub, shows the list
// with the screenshots and downloads a theme (and its wallpaper and typeface) when it is chosen; downloaded themes stay on the TV. Classic is built in. A theme sets
// values from the table SCHEMA below: colours, surfaces, text, and the position and size of every part of the screen (clock, buttons, app
// name, dock, grid), plus effects and a wallpaper. There is no CSS or script in a theme. Every value is checked against SCHEMA and clamped,
// a value that is missing or invalid keeps the value of the theme it extends (or the default, the original look), and unknown keys are
// ignored, so a theme can change how Home looks but nothing else. A new setting is one row in SCHEMA plus the CSS that reads its variable;
// docs/themes.md is generated from SCHEMA (tools/theme-docs.js).
// API (loopback only): GET /api/theme/list, POST /api/theme/set {id, accent}, POST /api/theme/revert, GET /api/theme/preview/<id>,
// GET /api/theme/wallpaper/<id>/<file>, GET /api/theme/font/<id>/<file>.
var fs = require('fs'),
  path = require('path');
var nc = require('./netcompat'),
  fetch = require('./fetch'),
  ts = require('./themeschema');
var ACCENTS = ts.ACCENTS,
  DEFAULTS = ts.DEFAULTS,
  DEFAULT_ID = ts.DEFAULT_ID,
  FILE = ts.FILE,
  FONT_FILE = ts.FONT_FILE,
  HEX = ts.HEX,
  ID = ts.ID,
  MAX_FONT = ts.MAX_FONT,
  MAX_INDEX = ts.MAX_INDEX,
  MAX_PREVIEW = ts.MAX_PREVIEW,
  MAX_THEME = ts.MAX_THEME,
  MAX_WALLPAPER = ts.MAX_WALLPAPER,
  PREVIEW_PATH = ts.PREVIEW_PATH,
  SCHEMA = ts.SCHEMA,
  dir = ts.dir,
  fontOk = ts.fontOk,
  fontType = ts.fontType,
  getPath = ts.getPath,
  hex = ts.hex,
  imageOk = ts.imageOk,
  imageType = ts.imageType,
  normalize = ts.normalize,
  resolve = ts.resolve,
  sniff = ts.sniff;

function BUILTIN() {
  return normalize(
    { name: 'Classic', author: 'CleanYourTV', description: 'The original look: near-black, white focus, ten columns.' },
    DEFAULT_ID
  );
}
/** @type {Record<string, any>|null} */
var cache = null;
// the themes on the TV: Classic (built in) and every downloaded folder
function load() {
  if (cache) return cache;
  /** @type {Record<string, any>} */
  var raws = {};
  var names = [];
  try {
    names = fs.readdirSync(dir());
  } catch (_) {}
  names.sort();
  for (var i = 0; i < names.length; i++) {
    var f = names[i];
    if (!ID.test(f) || f === DEFAULT_ID) continue;
    try {
      raws[f] = JSON.parse(fs.readFileSync(path.join(dir(), f, 'theme.json'), 'utf8'));
    } catch (_) {}
  }
  /** @type {Record<string, any>} */
  var out = {};
  out[DEFAULT_ID] = BUILTIN();
  function build(id, stack) {
    // "extends": another theme's values are the starting point
    if (out[id]) return out[id];
    var raw = raws[id];
    if (!raw || stack.indexOf(id) >= 0 || stack.length > 4) return null;
    var baseId = typeof raw.extends === 'string' && ID.test(raw.extends) ? raw.extends : '',
      base = baseId ? build(baseId, stack.concat(id)) : null;
    if (baseId && !base) return null; // its base is missing: not usable
    return (out[id] = normalize(raw, id, base ? base.v : null));
  }
  var rks = Object.keys(raws);
  for (var j = 0; j < rks.length; j++) build(rks[j], []);
  var oks = Object.keys(out);
  for (var k = 0; k < oks.length; k++) if (!out[oks[k]]) delete out[oks[k]];
  return (cache = out);
}

// ---- reading from GitHub ----
// the themes folder of the repository (main branch); https only, except the address a test sets
function baseUrl(slug, ref) {
  return process.env.CYTV_THEMES_URL || 'https://raw.githubusercontent.com/' + slug + '/' + (ref || 'main') + '/themes';
}
// a file from GitHub, at most `max` bytes and `ms` milliseconds
function fetchBuf(url, max, ms) {
  return fetch
    .read(url, {
      headers: { 'User-Agent': 'cleanyourtv-themes' },
      maxBytes: max,
      totalMs: ms || 15000,
      idleMs: 10000,
      redirects: 3,
      allowHttp: function () {
        return !!process.env.CYTV_THEMES_URL;
      },
      statusText: function (st) {
        return st === 404 ? 'not found on GitHub' : 'GitHub answered ' + st;
      },
    })
    .then(function (r) {
      return r.body;
    });
}
function writeAtomic(f, data) {
  fs.writeFileSync(f + '.tmp', data);
  fs.renameSync(f + '.tmp', f);
}
function mkdirs(d) {
  try {
    nc.mkdirp(d);
  } catch (_) {}
}
function rmrf(d) {
  try {
    var fsList = fs.readdirSync(d);
    for (var i = 0; i < fsList.length; i++) {
      var p = path.join(d, fsList[i]);
      if (fs.statSync(p).isDirectory()) rmrf(p);
      else fs.unlinkSync(p);
    }
    fs.rmdirSync(d);
  } catch (_) {}
}

function create(ctx) {
  // the repository and branch the themes come from: this project's main branch, unless D/source names another (to try a theme)
  function slug() {
    return (ctx.slug && ctx.slug()) || require('./updates').repo();
  }
  function ref() {
    if (ctx.ref) return ctx.ref();
    var x = '';
    try {
      x = fs.readFileSync(require('./paths').SOURCE, 'utf8').trim().split(/\s+/)[1];
    } catch (_) {}
    return /^[\w.\/-]{1,60}$/.test(x || '') ? x : 'main';
  }
  function conf() {
    return ctx.config.get();
  }
  function base() {
    return baseUrl(slug(), ref());
  }
  function cur() {
    var c = conf().theme || {};
    var all = load();
    return {
      id: all[c.id] ? c.id : DEFAULT_ID,
      accent: hex(c.accent) || '',
      prev: c.prev && all[c.prev.id] ? { id: c.prev.id, accent: hex(c.prev.accent) || '' } : null,
    };
  }
  function resolved() {
    var c = cur();
    return resolve(load()[c.id], c.accent);
  }
  function save(o) {
    return ctx.config.update('theme', function (c) {
      c.theme = o;
    });
  }

  // the catalogue: themes/index.json from GitHub, kept in memory for ten minutes
  /** @type {{at: number, themes: any[], error: string}} */
  var cat = { at: 0, themes: [], error: '' },
    /** @type {Promise<any>|null} */
    catP = null;
  function refreshCatalogue(force) {
    if (!force && cat.at && Date.now() - cat.at < 600000) return Promise.resolve(cat);
    if (catP) return catP;
    catP = fetchBuf(base() + '/index.json', MAX_INDEX, 12000)
      .then(
        function (b) {
          var j = JSON.parse(b.toString('utf8')),
            out = [],
            arr = Array.isArray(j.themes) ? j.themes.slice(0, 200) : [];
          for (var i = 0; i < arr.length; i++) {
            var t = arr[i];
            if (!t || !ID.test(String(t.id || ''))) continue;
            var pm = PREVIEW_PATH.exec(String(t.preview || ''));
            out.push({
              id: t.id,
              name: String(t.name || t.id).slice(0, 40),
              author: String(t.author || '').slice(0, 60),
              description: String(t.description || '').slice(0, 160),
              preview: pm && pm[1] === t.id ? t.preview : '',
            });
          }
          cat = { at: Date.now(), themes: out, error: '' };
        },
        function (e) {
          cat = { at: cat.at, themes: cat.themes, error: String(e.message || e) };
        }
      )
      .then(function () {
        catP = null;
        return cat;
      });
    return catP;
  }

  // download a theme (and the theme it extends, its wallpaper and its typeface) into themes/<id>/; nothing is kept when a file is invalid
  function install(id, depth) {
    if (!ID.test(id) || id === DEFAULT_ID) return Promise.reject(new Error('unknown theme'));
    if ((depth || 0) > 3) return Promise.reject(new Error('the theme extends too many themes'));
    /** @type {any} */
    var raw = null;
    var w = '',
      /** @type {Buffer|null} */
      wall = null,
      f = '',
      /** @type {Buffer|null} */
      font = null;
    return fetchBuf(base() + '/' + id + '/theme.json', MAX_THEME, 12000)
      .then(function (b) {
        raw = JSON.parse(b.toString('utf8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not a theme file');
        if (typeof raw.extends === 'string' && ID.test(raw.extends) && raw.extends !== DEFAULT_ID && !load()[raw.extends]) {
          return install(raw.extends, (depth || 0) + 1).then(null, function (e) {
            throw new Error('the theme it extends (' + raw.extends + ') could not be downloaded: ' + e.message);
          });
        }
      })
      .then(function () {
        var rw = getPath(raw, 'effects.wallpaper');
        if (typeof rw === 'string' && rw !== '') {
          w = rw;
          if (!FILE.test(w)) throw new Error('the wallpaper name is not valid');
          return fetchBuf(base() + '/' + id + '/' + w, MAX_WALLPAPER, 25000).then(function (buf) {
            if (!imageOk(buf, w, MAX_WALLPAPER)) throw new Error('the wallpaper is not an image of that type');
            wall = buf;
          });
        }
      })
      .then(function () {
        var rf = getPath(raw, 'type.fontFile');
        if (typeof rf === 'string' && rf !== '') {
          f = rf;
          if (!FONT_FILE.test(f)) throw new Error('the typeface name is not valid');
          return fetchBuf(base() + '/' + id + '/' + f, MAX_FONT, 25000).then(function (buf) {
            if (!fontOk(buf, f)) throw new Error('the typeface is not a font of that type');
            font = buf;
          });
        }
      })
      .then(function () {
        var d = path.join(dir(), id),
          had = fs.existsSync(path.join(d, 'theme.json'));
        mkdirs(d);
        if (wall) writeAtomic(path.join(d, w), wall);
        if (font) writeAtomic(path.join(d, f), font);
        writeAtomic(path.join(d, 'theme.json'), JSON.stringify(raw));
        cache = null;
        if (!load()[id]) {
          if (!had) rmrf(d);
          cache = null;
          throw new Error('the theme file is not usable');
        }
      });
  }

  // screenshots: fetched once from GitHub and kept in themes/.previews for a day
  function preview(id) {
    if (!ID.test(id)) return Promise.resolve(null);
    var pd = path.join(dir(), '.previews'),
      f = path.join(pd, id + '.img');
    /** @type {fs.Stats|null} */
    var st = null;
    try {
      st = fs.statSync(f);
    } catch (_) {}
    if (st && Date.now() - +st.mtime < 86400000) return Promise.resolve(fs.readFileSync(f));
    return refreshCatalogue(false)
      .then(function (catNow) {
        var e = catNow.themes.filter(function (t) {
          return t.id === id;
        })[0];
        if (!e || !e.preview) throw new Error('no screenshot');
        return fetchBuf(base() + '/' + e.preview, MAX_PREVIEW, 15000);
      })
      .then(function (b) {
        if (!sniff(b)) throw new Error('the screenshot is not an image');
        mkdirs(pd);
        writeAtomic(f, b);
        return b;
      })
      .then(null, function () {
        return st ? fs.readFileSync(f) : null;
      });
  }

  function list() {
    return refreshCatalogue(false).then(function () {
      var c = cur(),
        all = load(),
        /** @type {Record<string, number>} */
        seen = {},
        /** @type {any[]} */
        themes = [];
      function add(id, info) {
        if (seen[id]) return;
        seen[id] = 1;
        var l = all[id];
        themes.push({
          id: id,
          name: l ? l.name : info.name,
          author: l ? l.author : info.author,
          description: l ? l.description : info.description,
          installed: !!l,
          preview: !!info.preview,
        });
      }
      var cc = cat.themes.filter(function (t) {
        return t.id === DEFAULT_ID;
      })[0];
      add(DEFAULT_ID, cc || { name: 'Classic', author: 'CleanYourTV', description: all[DEFAULT_ID].description, preview: '' });
      for (var i = 0; i < cat.themes.length; i++) add(cat.themes[i].id, cat.themes[i]);
      var aks = Object.keys(all);
      for (var j = 0; j < aks.length; j++) {
        var aid = aks[j];
        add(aid, { name: all[aid].name, author: all[aid].author, description: all[aid].description, preview: '' });
      }
      return {
        current: { id: c.id, accent: c.accent },
        previous: c.prev,
        accents: ACCENTS.map(function (x) {
          return { name: x[0], hex: x[1] };
        }),
        themes: themes,
        catalogue: { ok: !cat.error, error: cat.error, at: cat.at },
      };
    });
  }

  function handle(req, res, u, body) {
    function json(o, code) {
      res.writeHead(code || 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(o));
    }
    var act = u.replace('/api/theme/', '');
    if (act === 'list')
      return list().then(function (r) {
        return json(r);
      });
    var m = /^preview\/([a-z0-9-]{1,30})$/.exec(act);
    if (m) {
      return preview(m[1]).then(function (b) {
        if (!b) {
          res.writeHead(404);
          return res.end();
        }
        res.writeHead(200, { 'content-type': imageType('x.' + sniff(b)), 'cache-control': 'max-age=600' });
        return res.end(b);
      });
    }
    m = /^wallpaper\/([a-z0-9-]{1,30})\/([\w-]{1,40}\.(?:jpg|png|webp))$/.exec(act);
    if (m) {
      var t = load()[m[1]];
      if (!t || t.v['effects.wallpaper'] !== m[2]) {
        res.writeHead(404);
        return res.end();
      }
      try {
        var wb = fs.readFileSync(path.join(dir(), m[1], m[2]));
        res.writeHead(200, { 'content-type': imageType(m[2]), 'cache-control': 'max-age=3600' });
        return res.end(wb);
      } catch (_) {
        res.writeHead(404);
        return res.end();
      }
    }
    m = /^font\/([a-z0-9-]{1,30})\/([\w-]{1,40}\.(?:woff2|woff|ttf|otf))$/.exec(act);
    if (m) {
      var fid = m[1],
        fname = m[2];
      // only the typeface a theme names, from that theme's folder (also when a theme that extends it is chosen)
      var ok = Object.keys(load()).some(function (k) {
        var v = load()[k].v;
        return v['type.fontFile'] === fname && (v.fontTheme || k) === fid;
      });
      try {
        if (!ok) throw new Error('not a theme typeface');
        var fb = fs.readFileSync(path.join(dir(), fid, fname));
        res.writeHead(200, { 'content-type': fontType(fname), 'cache-control': 'max-age=86400', 'access-control-allow-origin': '*' });
        return res.end(fb);
      } catch (_) {
        res.writeHead(404);
        return res.end();
      }
    }
    if (req.method !== 'POST') {
      res.writeHead(404);
      return res.end();
    }
    return body(req).then(function (b) {
      var c = cur();
      if (act === 'set') {
        var id = b.id === undefined ? c.id : String(b.id);
        if (!ID.test(id)) return json({ error: 'unknown theme' }, 400);
        var dl =
          b.id !== undefined && id !== DEFAULT_ID
            ? install(id).then(
                function () {
                  return null;
                },
                function (e) {
                  if (!load()[id]) {
                    var unk = e.message === 'unknown theme' || e.message === 'not found on GitHub';
                    return { body: { error: unk ? 'unknown theme' : 'could not download the theme: ' + e.message }, code: unk ? 400 : 502 };
                  }
                  return null;
                }
              )
            : Promise.resolve(null);
        return dl.then(function (errResp) {
          if (errResp) return json(errResp.body, errResp.code);
          var all = load();
          if (!all[id]) return json({ error: 'unknown theme' }, 400);
          var accent = c.accent;
          if (b.accent !== undefined) {
            if (b.accent !== '' && !HEX.test(String(b.accent))) return json({ error: 'the accent must be a colour like #4c8dff' }, 400);
            accent = String(b.accent).toLowerCase();
          } else if (id !== c.id) accent = ''; // a new theme brings its own accent
          if (id !== c.id || accent !== c.accent) save({ id: id, accent: accent, prev: { id: c.id, accent: c.accent } });
          return list().then(function (r) {
            return json(r);
          });
        });
      }
      if (act === 'revert') {
        if (!c.prev) return json({ error: 'nothing to go back to' }, 400);
        save({ id: c.prev.id, accent: c.prev.accent, prev: { id: c.id, accent: c.accent } });
        return list().then(function (r) {
          return json(r);
        });
      }
      res.writeHead(404);
      res.end();
    });
  }

  // earlier versions shipped the themes with the service: remove those files; fetch the chosen theme when it is not on the TV
  try {
    var existing = fs.readdirSync(dir());
    for (var ei = 0; ei < existing.length; ei++) {
      if (/^[a-z0-9-]+\.json$/.test(existing[ei])) fs.unlinkSync(path.join(dir(), existing[ei]));
    }
    rmrf(path.join(dir(), 'wallpapers'));
  } catch (_) {}
  function startup() {
    var c = conf().theme || {};
    if (c.id && c.id !== DEFAULT_ID && ID.test(c.id) && !load()[c.id]) install(c.id).then(null, function () {});
  }
  if (!ctx.noStartup) {
    var t = setTimeout(startup, 8000);
    if (t.unref) t.unref();
  }
  return {
    name: 'theme',
    prefix: '/api/theme/',
    handle: handle,
    resolved: resolved,
    list: list,
    install: install,
    refreshCatalogue: refreshCatalogue,
    preview: preview,
  };
}
module.exports = {
  create: create,
  normalize: normalize,
  SCHEMA: SCHEMA,
  DEFAULTS: DEFAULTS,
  imageOk: imageOk,
  fontOk: fontOk,
  ID: ID,
  resolve: resolve,
};
