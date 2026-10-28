/* ---------- language: the pages are written in English and translated where text is shown ----------
   I18N holds the translations this page uses, from i18n/<language>.json, put in by tools/build-pages.js ({language: {English: text}}).
   The language is the TV's, unless the manager's Language setting chose another (setLang). t() looks a text up whole, then the parts
   of a text joined by line breaks or " · ", and fills in templates: "%s" is any text, "%d" a number ("Launcher %s", "%d photos").
   A text without a translation stays English. A translation can have plural forms, {"one": "%d foto", "other": "%d foto's"}: the
   form follows the first number in the text, by the language's plural rules (Unicode CLDR: zero, one, two, few, many, other). The
   English plural forms are in I18N.en. */
var LANG_TV = String((window.webOSSystem || window.PalmSystem || {}).locale || navigator.language || 'en')
    .slice(0, 2)
    .toLowerCase(),
  LANG = 'en',
  LT = null,
  LTPL = null;
/* '' or undefined: the TV's language; a language without translations here falls back to English */
function setLang(code) {
  var c = code || LANG_TV;
  LANG = I18N[c] && (c === 'en' || I18N[c]._name) ? c : 'en';
  LT = I18N[LANG] || null;
  LTPL = null;
  if (document.documentElement) {
    document.documentElement.lang = LANG;
    /* a right-to-left language (_dir "rtl": Arabic, Hebrew) mirrors the layout; the pages' CSS has the [dir="rtl"] rules */
    document.documentElement.dir = LT && LT._dir === 'rtl' ? 'rtl' : 'ltr';
  }
}
/* left and right swap places in a right-to-left layout: the arrow keys follow what the eye sees */
function rtl() {
  return !!(LT && LT._dir === 'rtl');
}
/* the plural form of n in the current language: the browser's rules, or a small table of the same rules for older engines */
function pluralForm(n) {
  try {
    if (window.Intl && Intl.PluralRules) return new Intl.PluralRules(LANG).select(n);
  } catch (e) {}
  var i = Math.floor(Math.abs(n)),
    m10 = i % 10,
    m100 = i % 100;
  if (/^(ja|zh|ko|th|vi|id|ms|tr)$/.test(LANG)) return 'other';
  if (/^(fr|pt)$/.test(LANG)) return i < 2 ? 'one' : 'other';
  if (/^(ru|uk|be)$/.test(LANG))
    return m10 === 1 && m100 !== 11 ? 'one' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'few' : 'many';
  if (LANG === 'pl') return i === 1 ? 'one' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'few' : 'many';
  if (/^(cs|sk)$/.test(LANG)) return i === 1 ? 'one' : i >= 2 && i <= 4 ? 'few' : 'other';
  if (LANG === 'ar')
    return i === 0 ? 'zero' : i === 1 ? 'one' : i === 2 ? 'two' : m100 >= 3 && m100 <= 10 ? 'few' : m100 >= 11 ? 'many' : 'other';
  if (LANG === 'he') return i === 1 ? 'one' : i === 2 ? 'two' : 'other';
  return n === 1 ? 'one' : 'other';
}
/* a translation, with its plural form picked for n when it has forms */
function tForm(v, n) {
  if (typeof v === 'string') return v;
  if (!v) return '';
  return (n !== undefined && v[pluralForm(+String(n).replace(',', '.'))]) || v.other || '';
}
setLang('');
/* which capture of a template holds its first number (the plural form follows it) */
function firstNum(key) {
  var k = 0,
    re = /%[sd]/g,
    x;
  while ((x = re.exec(key))) {
    k++;
    if (x[0] === '%d') return k;
  }
  return 1;
}
function tTemplates() {
  if (LTPL) return LTPL;
  LTPL = [];
  for (var k in LT)
    if (k.charAt(0) !== '_' && /%[sd]/.test(k))
      LTPL.push([
        new RegExp(
          '^' +
            k
              .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
              .replace(/%s/g, '([\\s\\S]+?)')
              .replace(/%d/g, '([0-9][0-9.,]*)') +
            '$'
        ),
        k,
        /\n| · /.test(k),
      ]);
  LTPL.sort(function (a, b) {
    return b[1].length - a[1].length;
  });
  return LTPL;
}
function tTpl(s, joined) {
  var tp = tTemplates();
  for (var i = 0; i < tp.length; i++) {
    if (tp[i][2] !== joined) continue;
    var m = tp[i][0].exec(s);
    if (m) {
      var j = 1,
        num = /%d/.test(tp[i][1]) ? m[firstNum(tp[i][1])] : undefined;
      return tForm(LT[tp[i][1]], num).replace(/%[sd]/g, function () {
        return t(m[j++]);
      });
    }
  }
  return null;
}
function t(s) {
  if (!LT || s === null || s === undefined || s === '') return s;
  s = String(s);
  if (Object.prototype.hasOwnProperty.call(LT, s)) return tForm(LT[s]);
  var r = tTpl(s, true);
  if (r !== null) return r;
  if (s.indexOf('\n') >= 0) return s.split('\n').map(t).join('\n');
  if (s.indexOf(' · ') >= 0) return s.split(' · ').map(t).join(' · ');
  r = tTpl(s, false);
  return r !== null ? r : s;
}
/* the manager calls it tr: its code has local variables named t */
function tr(s) {
  return t(s);
}
/* the languages for the manager's Language list: English and every language this page has, with how complete it is */
function languages() {
  var out = [{ code: 'en', name: 'English', pct: 100 }];
  for (var c in I18N) if (c !== 'en') out.push({ code: c, name: I18N[c]._name || c, pct: I18N[c]._pct || 0 });
  return out;
}
