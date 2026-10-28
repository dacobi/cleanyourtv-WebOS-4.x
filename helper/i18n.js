// Translations for the pages the service serves itself (the phone pages for Wallpapers, Live TV and voice, Share log): the same
// i18n/<language>.json files as the TV's screens (copied next to the service by the setup; in a checkout, ../i18n). A phone page is in
// the phone's language (its Accept-Language), else the language chosen in the manager, else English.
//   lang(req, chosen)  -> a language code there is a file for, or 'en'
//   tr(lang, text)     -> the text in that language (whole, or the parts joined by " · " or lines, or a %s / %d template)
//   script(lang, html) -> a <script> with the translations a page's own script uses and t() (i18n/runtime.js), set to that language
// The service's own messages stay English: the TV's screens translate them where they show them.
var fs = require('fs'),
  path = require('path');

var DIRS = [path.join(__dirname, 'i18n'), path.join(__dirname, '..', 'i18n')];
/** @type {{langs: Record<string, any>, runtime: string}|null} */
var cache = null;
function load() {
  if (cache) return cache;
  cache = { langs: {}, runtime: '' };
  for (var di = 0; di < DIRS.length; di++) {
    var d = DIRS[di];
    var files = [];
    try {
      files = fs.readdirSync(d);
    } catch (_) {
      continue;
    }
    for (var fi = 0; fi < files.length; fi++) {
      var f = files[fi];
      var m = /^([a-z]{2})\.json$/.exec(f);
      if (!m) continue;
      try {
        cache.langs[m[1]] = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
      } catch (_) {}
    }
    try {
      cache.runtime = fs.readFileSync(path.join(d, 'runtime.js'), 'utf8');
    } catch (_) {}
    if (Object.keys(cache.langs).length) break;
  }
  return cache;
}
function lang(req, chosen) {
  var L = load().langs,
    acc = String((req && req.headers && req.headers['accept-language']) || '');
  var asked = acc
    .split(',')
    .map(function (p) {
      var m = /^\s*([a-zA-Z]{2})(?:-[a-zA-Z0-9]+)?\s*(?:;\s*q=([0-9.]+))?/.exec(p);
      return m ? { c: m[1].toLowerCase(), q: m[2] === undefined ? 1 : parseFloat(m[2]) } : null;
    })
    .filter(Boolean)
    .sort(function (a, b) {
      return /** @type {any} */ (b).q - /** @type {any} */ (a).q;
    });
  for (var i = 0; i < asked.length; i++) {
    var a = /** @type {any} */ (asked[i]);
    if (a.c === 'en' || (L[a.c] && L[a.c]._name && a.c !== 'en')) return a.c;
  }
  return chosen && chosen !== 'en' && L[chosen] ? chosen : 'en';
}

// the plural form of n (Unicode CLDR categories), for translations with forms {"one": ..., "other": ...}; Node 0.12 and 8 have no
// Intl.PluralRules, so the rules of the common languages are written out (as in i18n/runtime.js)
function pluralForm(code, n) {
  var i = Math.floor(Math.abs(n)),
    m10 = i % 10,
    m100 = i % 100,
    few = m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14);
  if (/^(ja|zh|ko|th|vi|id|ms|tr)$/.test(code)) return 'other';
  if (/^(fr|pt)$/.test(code)) return i < 2 ? 'one' : 'other';
  if (/^(ru|uk|be)$/.test(code)) return m10 === 1 && m100 !== 11 ? 'one' : few ? 'few' : 'many';
  if (code === 'pl') return i === 1 ? 'one' : few ? 'few' : 'many';
  if (/^(cs|sk)$/.test(code)) return i === 1 ? 'one' : i >= 2 && i <= 4 ? 'few' : 'other';
  if (code === 'ar')
    return i === 0 ? 'zero' : i === 1 ? 'one' : i === 2 ? 'two' : m100 >= 3 && m100 <= 10 ? 'few' : m100 >= 11 ? 'many' : 'other';
  if (code === 'he') return i === 1 ? 'one' : i === 2 ? 'two' : 'other';
  return n === 1 ? 'one' : 'other';
}
function form(code, v, n) {
  return typeof v === 'string' ? v : !v ? '' : (n !== undefined && v[pluralForm(code, +String(n).replace(',', '.'))]) || v.other || '';
}
/** @type {Record<string, Array<{re: RegExp, key: string, joined: boolean}>>} */
var templates = {};
function tpl(code) {
  if (templates[code]) return templates[code];
  var T = load().langs[code] || {},
    out = [],
    ks = Object.keys(T);
  for (var i = 0; i < ks.length; i++) {
    var k = ks[i];
    if (k.charAt(0) !== '_' && /%[sd]/.test(k))
      out.push({
        re: new RegExp(
          '^' +
            k
              .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
              .replace(/%s/g, '([\\s\\S]+?)')
              .replace(/%d/g, '([0-9][0-9.,]*)') +
            '$'
        ),
        key: k,
        joined: /\n| \u00B7 /.test(k),
      });
  }
  out.sort(function (a, b) {
    return b.key.length - a.key.length;
  });
  return (templates[code] = out);
}
function tr(code, s) {
  var T = load().langs[code];
  if (!T || s === null || s === undefined || s === '') return s;
  s = String(s);
  if (Object.prototype.hasOwnProperty.call(T, s) && T[s]) return form(code, T[s]);
  function viaTpl(joined) {
    var list = tpl(code);
    for (var i = 0; i < list.length; i++) {
      var x = list[i];
      if (x.joined !== joined) continue;
      var m = x.re.exec(s);
      if (m) {
        var j = 1,
          k = 0,
          first = 0;
        x.key.replace(/%[sd]/g, function (h) {
          k++;
          if (h === '%d' && !first) first = k;
          return h;
        });
        return form(code, T[x.key], first ? m[first] : undefined).replace(/%[sd]/g, function () {
          return tr(code, m[j++]);
        });
      }
    }
    return null;
  }
  var r = viaTpl(true);
  if (r !== null) return r;
  if (s.indexOf('\n') >= 0)
    return s
      .split('\n')
      .map(function (x) {
        return tr(code, x);
      })
      .join('\n');
  if (s.indexOf(' · ') >= 0)
    return s
      .split(' · ')
      .map(function (x) {
        return tr(code, x);
      })
      .join(' · ');
  r = viaTpl(false);
  return r !== null ? r : s;
}
// the texts of a page's script that have a translation: every key whose fixed parts all appear in the script
function script(code, js) {
  var T = load().langs[code] || {},
    /** @type {Record<string, any>} */
    used = code === 'en' ? {} : { _name: T._name || code, _dir: T._dir === 'rtl' ? 'rtl' : 'ltr' };
  var text = String(js || '').replace(/\\u([0-9a-fA-F]{4})/g, function (m, h) {
    return String.fromCharCode(parseInt(h, 16));
  });
  var ks = Object.keys(T);
  for (var i = 0; i < ks.length; i++) {
    var k = ks[i];
    if (k.charAt(0) === '_' || !T[k]) continue;
    var parts = k.split(/%[sd]/).filter(function (f) {
      return f.trim().length > 0;
    });
    if (
      parts.length &&
      parts.every(function (f) {
        return text.indexOf(f) >= 0;
      })
    )
      used[k] = T[k];
  }
  // in English only the plural forms ("%d photo" / "%d photos") come from the file
  if (code === 'en') {
    var uks = Object.keys(used);
    for (var j = 0; j < uks.length; j++) if (typeof used[uks[j]] !== 'object') delete used[uks[j]];
  }
  /** @type {Record<string, any>} */
  var table = {};
  if (Object.keys(used).length) table[code] = used;
  return (
    '<script>var I18N = ' +
    JSON.stringify(table).replace(/</g, '\\u003c') +
    ';\n' +
    load().runtime +
    '\nsetLang(' +
    JSON.stringify(code) +
    ');</script>'
  );
}

module.exports = { lang: lang, tr: tr, script: script, load: load };
