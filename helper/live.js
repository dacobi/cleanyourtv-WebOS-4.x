// Live TV backend for the launcher: reads an M3U playlist (and its XMLTV guide), serves them to the Live TV app,
// and runs a short-lived pairing page on the LAN so the playlist address can be entered from a phone or computer.
var http = require('http'),
  https = require('https'),
  fs = require('fs'),
  crypto = require('crypto');
var nc = require('./netcompat'),
  URL = nc.URL,
  URLSearchParams = nc.URLSearchParams;
var P = require('./paths'),
  fetch = require('./fetch'),
  web = require('./web'),
  i18n = require('./i18n');
var DIR = P.LIVE;
var SETTINGS = DIR + '/settings.json',
  PLAYLIST = DIR + '/playlist.json',
  EPG = DIR + '/epg.json',
  STATE = DIR + '/state.json';
var PAIR_PORT = 8766,
  PAIR_MS = 10 * 60 * 1000,
  REFRESH_MS = 12 * 3600 * 1000;
try {
  nc.mkdirp(DIR);
} catch (_) {}

function readJson(f, d) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (_) {
    return d;
  }
}
function writeJson(f, o) {
  fs.writeFileSync(f + '.tmp', JSON.stringify(o), { mode: parseInt('600', 8) });
  fs.renameSync(f + '.tmp', f);
} // the playlist address holds an access key: owner only
var settings = readJson(SETTINGS, {}),
  playlist = readJson(PLAYLIST, null),
  epg = readJson(EPG, null);
// What the viewer did, kept here so it survives launcher updates: favourites, the last channels watched and the channels that failed
// (by channel key, see parseM3U). Capped, and written at most once a second.
var FAIL_MS = 7 * 24 * 3600 * 1000;
var state = (function (o) {
  return {
    fav: Array.isArray(o.fav) ? o.fav : [],
    recent: Array.isArray(o.recent) ? o.recent : [],
    failed: o.failed && typeof o.failed === 'object' ? o.failed : {},
  };
})(readJson(STATE, {}));
/** @type {any} */
var stateT = 0;
function saveState() {
  clearTimeout(stateT);
  stateT = setTimeout(function () {
    try {
      writeJson(STATE, state);
    } catch (_) {}
  }, 1000);
}
function validKey(k) {
  return typeof k === 'string' && /^[0-9a-f]{10}(-\d+)?$/.test(k);
}
function pruneState() {
  var now = Date.now(),
    ks = Object.keys(state.failed);
  for (var i = 0; i < ks.length; i++) {
    var k = ks[i];
    if (!(now - state.failed[k] < FAIL_MS)) delete state.failed[k];
  }
  state.fav = state.fav.filter(validKey).slice(0, 500);
  state.recent = state.recent.filter(validKey).slice(0, 30);
}
function changeState(b) {
  if (!b || typeof b !== 'object') return false;
  if (b.op === 'clear') {
    state.recent = [];
    state.failed = {};
    saveState();
    return true;
  }
  if (!validKey(b.key)) return false;
  if (b.op === 'fav') {
    state.fav = state.fav.filter(function (k) {
      return k !== b.key;
    });
    if (b.on) state.fav.unshift(b.key);
  } else if (b.op === 'recent') {
    state.recent = [b.key]
      .concat(
        state.recent.filter(function (k) {
          return k !== b.key;
        })
      )
      .slice(0, 30);
  } else if (b.op === 'failed') {
    if (b.on) state.failed[b.key] = Date.now();
    else delete state.failed[b.key];
  } else return false;
  pruneState();
  saveState();
  return true;
}
var status = { state: 'idle', error: '' };

// ---- fetching: a stream of the playlist or the guide (fetch.js handles redirects, gzip and dropped connections) ----
// sniff: also unpack a body that starts like gzip (a guide published as .xml.gz)
function get(url, sniff) {
  return fetch.open(url, {
    headers: { 'user-agent': 'cleanyourtv-live', 'accept-encoding': 'gzip' },
    idleMs: 20000,
    statusText: function (s) {
      return 'server answered ' + s;
    },
    unzip: sniff ? 'sniff' : 'header',
  });
}
function readAll(s) {
  return new Promise(function (res, rej) {
    /** @type {Buffer[]} */
    var b = [];
    var ended = false;
    s.on('data', function (c) {
      b.push(c);
    });
    s.on('end', function () {
      ended = true;
      res(Buffer.concat(b).toString('utf8'));
    });
    s.on('error', rej);
    s.on('aborted', function () {
      rej(new Error('the connection was lost'));
    });
    s.on('close', function () {
      if (!ended) rej(new Error('the connection was closed'));
    });
  });
}

// ---- M3U ----
/** @type {Array<[RegExp, string]>} */
var QUALITY = [
  [/\b(?:4k|uhd|2160p)\b/i, '4K'],
  [/\b(?:fhd|1080[pi])\b/i, 'FHD'],
  [/\b(?:hd|720p)\b/i, 'HD'],
  [/\b(?:sd|480p|576p)\b/i, 'SD'],
];
function qualityOf(s) {
  for (var i = 0; i < QUALITY.length; i++) if (QUALITY[i][0].test(s)) return QUALITY[i][1];
  return '';
}
function firstOf(s) {
  return String(s || '')
    .split(/[;,]/)[0]
    .trim();
}
// A short stable key per channel (favourites and recents refer to it): the guide id, else the name and group.
function keyOf(id, name, group) {
  return crypto
    .createHash('md5')
    .update(id || name + '|' + group)
    .digest('hex')
    .slice(0, 10);
}
var FL_GEO = 1,
  FL_PART = 2,
  FL_HEADERS = 4;

function parseM3U(text) {
  var lines = text.split(/\r?\n/),
    /** @type {any[]} */
    out = [],
    /** @type {string[]} */
    groups = [],
    /** @type {Record<string, any>} */
    byBase = {},
    /** @type {Record<string, number>} */
    keys = {};
  var epgUrl = '',
    /** @type {any} */
    cur = null,
    grp = '',
    headers = false;
  function addGroup(g) {
    if (g && groups.indexOf(g) < 0) groups.push(g);
  }
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i].trim();
    if (!l) continue;
    if (l.indexOf('#EXTM3U') === 0) {
      var m = l.match(/(?:x-tvg-url|url-tvg)="([^"]*)"/i);
      if (m) epgUrl = m[1].split(',')[0].trim();
      continue;
    }
    if (l.indexOf('#EXTINF') === 0) {
      /** @type {Record<string, string>} */
      var attrs = {};
      l.replace(/([\w-]+)="([^"]*)"/g, function (_, k, v) {
        attrs[k.toLowerCase()] = v;
        return '';
      });
      cur = {
        id: attrs['tvg-id'] || '',
        name: (attrs['tvg-name'] || l.slice(l.lastIndexOf(',') + 1)).trim(),
        group: (attrs['group-title'] || grp || '').trim(),
        logo: attrs['tvg-logo'] || '',
        country: firstOf(attrs['tvg-country']),
        lang: firstOf(attrs['tvg-language']),
      };
      var nm = l.slice(l.lastIndexOf(',') + 1).trim();
      if (nm) cur.name = nm;
      continue;
    }
    if (/^#EXTGRP:/i.test(l)) {
      grp = l.slice(8).trim();
      continue;
    }
    if (/^#EXTVLCOPT:\s*http-(?:user-agent|referrer)/i.test(l)) {
      headers = true;
      continue;
    }
    if (l.charAt(0) === '#') continue;
    if (cur) {
      if (!/^#+/.test(cur.name)) {
        // "#### NL ALGEMEEN ####" lines are separators, not channels
        var idq = (cur.id.match(/@([A-Za-z0-9]+)$/) || [])[1] || '',
          base = cur.id.replace(/@[A-Za-z0-9]+$/, '');
        var q = qualityOf(idq) || qualityOf(cur.name);
        if (cur.id.indexOf('@') >= 0 && byBase[base]) {
          // the same channel again (Name.cc@SD, Name.cc@HD): another stream of it
          byBase[base].alt.push({ url: l, q: q });
        } else {
          /** @type {any} */
          var ch = {
            id: cur.id,
            name: cur.name,
            group: cur.group,
            logo: cur.logo,
            url: l,
            num: out.length + 1,
            q: q,
            cats: cur.group
              ? cur.group
                  .split(';')
                  .map(function (x) {
                    return x.trim();
                  })
                  .filter(Boolean)
              : [],
            alt: [],
            fl:
              (/geo-?\s?blocked/i.test(cur.name) ? FL_GEO : 0) |
              (/not\s*24\s*\/\s*7/i.test(cur.name) ? FL_PART : 0) |
              (headers || /\|[\w-]+=/.test(l) ? FL_HEADERS : 0),
            cc: cur.country.toUpperCase() || ((base.match(/\.([a-z]{2})$/i) || [])[1] || '').toUpperCase(),
            lang: cur.lang,
          };
          var k = keyOf(base || '', cur.name, cur.group);
          if (keys[k]) k += '-' + ++keys[k];
          else keys[k] = 1;
          ch.key = k;
          if (cur.id.indexOf('@') >= 0) byBase[base] = ch;
          out.push(ch);
          ch.cats.forEach(addGroup);
        }
      }
      cur = null;
      headers = false;
    }
  }
  return { v: 2, epgUrl: epgUrl, groups: groups, channels: out, fetchedAt: Date.now() };
}

// ---- why a stream does not play: ask the stream address the way the player does and sort the answer ----
// Only addresses of channels in the stored playlist are ever asked, never one given by the page.
/** @type {Record<string, {at: number, r: any}>} */
var probeCache = {};
function probe(url) {
  return new Promise(function (resolve) {
    var u;
    try {
      u = new URL(url);
    } catch (_) {
      return resolve({ reason: 'unknown' });
    }
    var t0 = Date.now();
    var done = false;
    function fin(o) {
      if (!done) {
        done = true;
        o.ms = Date.now() - t0;
        resolve(o);
      }
    }
    var lib = u.protocol === 'https:' ? https : http;
    function go(target, depth) {
      var req = nc.get(
        lib,
        target,
        { headers: { 'user-agent': 'cleanyourtv-live', range: 'bytes=0-8191', accept: '*/*' }, timeout: 8000, rejectUnauthorized: false },
        function (res) {
          var st = res.statusCode || 0;
          if (st >= 300 && st < 400 && res.headers.location && depth < 5) {
            res.resume();
            return go(new URL(res.headers.location, target), depth + 1);
          }
          var type = String(res.headers['content-type'] || '')
            .toLowerCase()
            .split(';')[0]
            .trim();
          var first = Date.now() - t0;
          if (st >= 400 || st < 200) {
            res.resume();
            return fin({ reason: st === 404 || st === 410 ? 'gone' : st >= 500 ? 'server' : 'refused', status: st, type: type });
          }
          /** @type {Buffer[]} */
          var b = [];
          var n = 0;
          res.on('data', function (c) {
            b.push(c);
            n += c.length;
            if (n > 8192) {
              nc.destroy(res);
            }
          });
          function end() {
            var head = Buffer.concat(b).toString('utf8', 0, 8192);
            if (/^\s*#EXTM3U/.test(head)) {
              if (
                /#EXT-X-(?:SESSION-)?KEY:[^\n]*(?:METHOD=SAMPLE-AES|KEYFORMAT="(?:com\.apple\.streamingkeydelivery|urn:uuid:[^"]*)")/i.test(
                  head
                )
              )
                return fin({ reason: 'drm', status: st, type: type });
              return fin({ reason: first > 5000 ? 'slow' : 'ok', status: st, type: type, hls: true });
            }
            if (/^(?:text\/|application\/(?:json|xml|xhtml))/.test(type) || /^\s*<(?:!doctype|html)/i.test(head))
              return fin({ reason: 'notvideo', status: st, type: type });
            fin({ reason: first > 5000 ? 'slow' : 'ok', status: st, type: type });
          }
          res.on('end', end);
          res.on('close', end);
          res.on('error', function () {
            fin({ reason: 'unreachable' });
          });
        }
      );
      req.on('timeout', function () {
        nc.destroy(req);
        fin({ reason: 'slow' });
      });
      req.on('error', function () {
        fin({ reason: 'unreachable' });
      });
    }
    go(u, 0);
  });
}
function probeCached(url) {
  var c = probeCache[url];
  if (c && Date.now() - c.at < 60000) return Promise.resolve(c.r);
  return probe(url).then(function (r) {
    probeCache[url] = { at: Date.now(), r: r };
    var keys = Object.keys(probeCache);
    if (keys.length > 50) delete probeCache[keys[0]];
    return r;
  });
}

// ---- XMLTV (streamed: the guide can be tens of MB) ----
function decode(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, function (_, h) {
      return String.fromCharCode(parseInt(h, 16));
    })
    .replace(/&#(\d+);/g, function (_, d) {
      return String.fromCharCode(+d);
    });
}
function xmltvTime(s) {
  var m = s.match(/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)\s*([+-]\d{4})?/);
  if (!m) return 0;
  var t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (m[7]) {
    var sign = m[7].charAt(0) === '-' ? -1 : 1;
    t -= sign * (+m[7].slice(1, 3) * 60 + +m[7].slice(3, 5)) * 60000;
  }
  return Math.floor(t / 1000);
}
// Names are compared without case, accents, a leading country code ("PL: ", "NL|"), quality words and punctuation:
// "PL: TVP 1 HD", "TVP 1" and "tvp1" are the same channel.
var QWORDS = /\b(?:uhd|fhd|hd|sd|4k|hevc|h265|raw)\b/g;
function nameKey(s) {
  var t = String(s || '').toLowerCase();
  try {
    t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  } catch (_) {}
  t = t
    .replace(/^\s*[a-z]{2}\s*[:|]\s*/, '')
    .replace(/&/g, 'and')
    .replace(QWORDS, ' ');
  return t.replace(/[^a-z0-9]+/g, '');
}
function attr(tag, name) {
  var m = tag.match(new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')'));
  return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
}
function textOf(block, name) {
  var m = block.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>'));
  return m ? decode(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim() : '';
}
// The guide is cut into <channel> and <programme> blocks wherever they sit in the stream: generators differ in their line breaks
// (Tunarr sends the whole file on a few lines, with newlines inside the descriptions) and in the order of the attributes.
function parseEpg(stream, channels) {
  /** @type {Record<string, any[]>} */
  var byId = {},
    /** @type {Record<string, string>} */
    map = {};
  /** @type {Record<string, boolean>} */
  var want = Object.create(null),
    /** @type {Record<string, boolean>} */
    keep = Object.create(null),
    /** @type {Record<string, any[]>} */
    byName = {};
  for (var i = 0; i < channels.length; i++) {
    var c = channels[i];
    if (c.id) {
      want[c.id] = true;
      keep[c.id] = true;
    }
    var nk = nameKey(c.name);
    if (nk) (byName[nk] = byName[nk] || []).push(c);
  }
  var now = Math.floor(Date.now() / 1000),
    from = now - 3600,
    to = now + 36 * 3600;
  var buf = '',
    count = 0;
  function handleBlock(tag, block) {
    var open = block.slice(0, block.indexOf('>') + 1),
      id = attr(open, tag === 'programme' ? 'channel' : 'id');
    if (id === null) return;
    if (tag === 'channel') {
      // a guide channel that is none of the playlist's ids may still have the name of one
      if (want[id]) return;
      /** @type {string[]} */
      var names = [];
      block.replace(/<display-name[^>]*>([^<]*)<\/display-name>/g, function (_, n) {
        names.push(decode(n));
        return '';
      });
      for (var ni = 0; ni < names.length; ni++) {
        var matched = byName[nameKey(names[ni])] || [];
        for (var ci = 0; ci < matched.length; ci++) {
          map[matched[ci].key] = id;
          keep[id] = true;
        }
      }
      return;
    }
    var st = attr(open, 'start'),
      sp = attr(open, 'stop');
    if (!st || !sp || !keep[id]) return;
    var s = xmltvTime(st),
      e = xmltvTime(sp),
      t = textOf(block, 'title');
    if (!(e > from && s < to) || /^no data$/i.test(t)) return;
    var d = textOf(block, 'desc').slice(0, 220);
    (byId[id] = byId[id] || []).push(d ? [s, e, t, d] : [s, e, t]);
    count++;
  }
  function drain() {
    for (;;) {
      var m = /<(channel|programme)\b/.exec(buf);
      if (!m) {
        buf = buf.slice(-10); // the header is not kept; a tag cut in two stays in the last characters
        return;
      }
      var a = m.index,
        tag = m[1],
        te = buf.indexOf('>', a);
      if (te < 0) {
        buf = buf.slice(a);
        return;
      }
      if (buf.charAt(te - 1) === '/') {
        // <channel id="x"/> and <programme .../> have no content
        handleBlock(tag, buf.slice(a, te + 1));
        buf = buf.slice(te + 1);
        continue;
      }
      var b = buf.indexOf('</' + tag + '>', te);
      if (b < 0) {
        buf = buf.slice(a);
        return;
      }
      handleBlock(tag, buf.slice(a, b));
      buf = buf.slice(b + tag.length + 3);
    }
  }
  return new Promise(function (resolve, reject) {
    var n = 0;
    stream.setEncoding('utf8'); // a character cut between two chunks is kept whole
    stream.on('data', function (chunk) {
      buf += chunk;
      drain();
      if (++n % 40 === 0) {
        stream.pause();
        setImmediate(function () {
          stream.resume();
        });
      } // leave CPU for the UI
    });
    var ended = false;
    stream.on('end', function () {
      ended = true;
      resolve(null);
    });
    stream.on('error', reject);
    stream.on('aborted', function () {
      reject(new Error('the connection was lost'));
    });
    stream.on('close', function () {
      if (!ended) reject(new Error('the connection was closed'));
    });
    stream.resume();
  }).then(function () {
    for (var id in byId)
      byId[id].sort(function (a, b) {
        return a[0] - b[0];
      });
    for (var k in map) if (!byId[map[k]]) delete map[k];
    return { v: 5, fetchedAt: Date.now(), count: count, byId: byId, map: map };
  });
}
function loadEpg(url, channels) {
  return get(url, true).then(function (s) {
    return parseEpg(s, channels);
  });
}
// An Xtream playlist (…/get.php?username=…&password=…) has its guide at xmltv.php on the same server.
function derivedEpgUrl(playlistUrl) {
  try {
    var u = new URL(playlistUrl);
    var us = u.searchParams.get('username'),
      pw = u.searchParams.get('password');
    if (/\/get\.php$/i.test(u.pathname) && us && pw)
      return (
        u.protocol +
        '//' +
        u.host +
        u.pathname.replace(/get\.php$/i, 'xmltv.php') +
        '?username=' +
        encodeURIComponent(us) +
        '&password=' +
        encodeURIComponent(pw)
      );
  } catch (_) {}
  return '';
}

var refreshing = false;
function refresh(force) {
  if (refreshing || !settings.playlistUrl) return Promise.resolve();
  refreshing = true;
  status = { state: 'loading playlist', error: '' };
  var plStep =
    force || !playlist || playlist.v !== 2 || Date.now() - playlist.fetchedAt > REFRESH_MS
      ? get(settings.playlistUrl)
          .then(readAll)
          .then(function (txt) {
            playlist = parseM3U(txt);
            if (!playlist.channels.length) throw new Error('no channels found in that playlist');
            writeJson(PLAYLIST, playlist);
          })
      : Promise.resolve();
  return plStep
    .then(function () {
      status = { state: 'idle', error: '' };
      var epgUrl = settings.epgUrl || playlist.epgUrl || derivedEpgUrl(settings.playlistUrl);
      if (epgUrl && (force || !epg || epg.v !== 5 || Date.now() - epg.fetchedAt > REFRESH_MS)) {
        status = { state: 'loading guide', error: '' };
        return loadEpg(epgUrl, playlist.channels).then(
          function (loaded) {
            epg = loaded;
            writeJson(EPG, epg);
          },
          function (e) {
            status = { state: 'idle', error: 'guide: ' + e.message };
          }
        );
      }
    })
    .then(
      function () {
        if (status.state !== 'idle') status = { state: 'idle', error: status.error };
      },
      function (e) {
        status = { state: 'idle', error: e.message };
      }
    )
    .then(function () {
      refreshing = false;
    });
}

// ---- pairing page (LAN, short-lived, needs the code shown on the TV) ----
/** @type {any} */
var pair = null;
var lanIp = web.lanIp,
  esc = web.esc;
// in the phone's language (i18n.js); msg is English and translated here too
function page(msg, ok, lang) {
  function T(x) {
    return esc(i18n.tr(lang, x));
  }
  return (
    '<!doctype html><html lang=' +
    lang +
    '><meta name=viewport content="width=device-width,initial-scale=1"><title>' +
    T('Live TV setup') +
    '</title>\n' +
    '<style>body{font:18px system-ui,sans-serif;background:#111;color:#eee;max-width:560px;margin:40px auto;padding:0 18px}input,button{font:inherit;width:100%;box-sizing:border-box;padding:12px;margin:6px 0 14px;border-radius:10px;border:1px solid #444;background:#1b1b1b;color:#eee}button{background:#f5f6f8;color:#111;font-weight:600;border:0}.m{padding:12px;border-radius:10px;background:' +
    (ok ? '#14361f' : '#3a1717') +
    '}</style>\n' +
    '<h2>' +
    T('Live TV setup') +
    '</h2>' +
    (msg ? '<p class=m>' + T(msg) + '</p>' : '') +
    (ok
      ? ''
      : '<form method=post action=/set>\n' +
        '<label>' +
        T('Code shown on the TV') +
        '</label><input name=code inputmode=numeric autocomplete=off required>\n' +
        '<label>' +
        T('Playlist address (M3U)') +
        '</label><input name=playlist type=url placeholder="http://..." required>\n' +
        '<label>' +
        T('Guide address (XMLTV, optional)') +
        '</label><input name=epg type=url placeholder="' +
        T("leave empty to use the playlist's") +
        '">\n' +
        '<button>' +
        T('Save') +
        '</button></form>')
  );
}
function startPairing() {
  stopPairing();
  var code = String(nc.randomInt(100000, 1000000));
  var bad = 0;
  var srv = http.createServer(function (req, res) {
    function send(c, html) {
      res.writeHead(c, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    }
    var lg = i18n.lang(req, '');
    if (req.method === 'GET') return send(200, page('', false, lg));
    if (req.method === 'POST' && req.url === '/set') {
      var b = '';
      req.on('data', function (c) {
        b += c;
        if (b.length > 8192) nc.destroy(req);
      });
      req.on('end', function () {
        var f = new URLSearchParams(b);
        if (f.get('code') !== code) {
          if (++bad >= 5) stopPairing();
          return send(403, page('Wrong code.', false, lg));
        }
        var url = (f.get('playlist') || '').trim(),
          epgUrl = (f.get('epg') || '').trim();
        if (!/^https?:\/\//i.test(url)) return send(400, page('The playlist address must start with http:// or https://', false, lg));
        settings = { playlistUrl: url, epgUrl: /^https?:\/\//i.test(epgUrl) ? epgUrl : '' };
        writeJson(SETTINGS, settings);
        playlist = null;
        epg = null;
        refresh(true);
        send(200, page('Saved. The TV is loading your channels now; you can close this page.', true, lg));
        setTimeout(stopPairing, 2000);
      });
      return;
    }
    send(404, page('Not found', false, lg));
  });
  srv.on('error', function () {
    pair = null;
  });
  srv.listen(PAIR_PORT, '0.0.0.0');
  pair = {
    code: code,
    srv: srv,
    url: 'http://' + lanIp() + ':' + PAIR_PORT,
    until: Date.now() + PAIR_MS,
    timer: setTimeout(stopPairing, PAIR_MS),
  };
  return { url: pair.url, code: code, seconds: PAIR_MS / 1000 };
}
function stopPairing() {
  if (pair) {
    clearTimeout(pair.timer);
    try {
      pair.srv.close();
    } catch (_) {}
    pair = null;
  }
}

// ---- HTTP API (mounted under /api/live by the helper) ----
function handle(req, res, u, body) {
  function json(o, c) {
    res.writeHead(c || 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(o));
  }
  var q = new URL(req.url, 'http://x').searchParams;
  if (u === '/api/live/status')
    return json({
      configured: !!settings.playlistUrl,
      channels: playlist ? playlist.channels.length : 0,
      epg: epg ? epg.count : 0,
      state: status.state,
      error: status.error,
      pairing: pair ? { url: pair.url, code: pair.code } : null,
    });
  if (u === '/api/live/channels') {
    if (settings.playlistUrl && (!playlist || playlist.v !== 2)) refresh(false);
    // [number, id, name, group, logo, url, key, country, language, quality, flags, categories, other streams as [url, quality]]
    return json(
      playlist
        ? {
            groups: playlist.groups,
            channels: playlist.channels.map(function (c) {
              return [
                c.num,
                guideId(c),
                c.name,
                c.group,
                c.logo,
                c.url,
                c.key || '',
                c.cc || '',
                c.lang || '',
                c.q || '',
                c.fl || 0,
                c.cats || [],
                (c.alt || []).map(function (a) {
                  return [a.url, a.q || ''];
                }),
              ];
            }),
          }
        : { groups: [], channels: [] }
    );
  }
  if (u === '/api/live/epg') {
    /** @type {Record<string, any>} */
    var out = {},
      now = Math.floor(Date.now() / 1000);
    var reqIds = (q.get('ids') || '').split(',').filter(Boolean).slice(0, 60);
    for (var qi = 0; qi < reqIds.length; qi++) {
      var id = reqIds[qi];
      var list = epg && epg.byId[id];
      if (!list) continue;
      var idx = -1;
      for (var li = 0; li < list.length; li++) {
        if (list[li][1] > now) {
          idx = li;
          break;
        }
      }
      if (idx < 0) continue;
      if (q.get('full')) out[id] = { list: list.slice(idx, idx + 8) };
      else out[id] = { now: list[idx][0] <= now ? list[idx] : null, next: list[list[idx][0] <= now ? idx + 1 : idx] || null };
    }
    return json(out);
  }
  if (u === '/api/live/state' && req.method === 'GET') {
    pruneState();
    return json(state);
  }
  if (u === '/api/live/state' && req.method === 'POST') {
    return body(req).then(function (b) {
      return changeState(b) ? json({ returnValue: true }) : json({ error: 'bad request' }, 400);
    });
  }
  if (u === '/api/live/probe') {
    // ?key=<channel key>&i=<stream number, 0 is the main one>
    var wantKey = q.get('key');
    var ch =
      playlist &&
      playlist.channels.filter(function (c) {
        return c.key === wantKey;
      })[0];
    var si = parseInt(q.get('i') || '0', 10) || 0;
    var surl = ch && (si === 0 ? ch.url : (ch.alt[si - 1] || {}).url);
    if (!surl) return json({ error: 'no such stream' }, 404);
    return probeCached(surl).then(function (r) {
      return json(r);
    });
  }
  if (u === '/api/live/pair' && req.method === 'POST') return json(startPairing());
  if (u === '/api/live/refresh' && req.method === 'POST') {
    refresh(true);
    return json({ returnValue: true });
  }
  if (u === '/api/live/settings' && req.method === 'POST') {
    return body(req).then(function (b) {
      if (typeof b.playlistUrl !== 'string' || !/^https?:\/\//i.test(b.playlistUrl)) return json({ error: 'bad playlist address' }, 400);
      settings = { playlistUrl: b.playlistUrl, epgUrl: /^https?:\/\//i.test(b.epgUrl || '') ? b.epgUrl : '' };
      writeJson(SETTINGS, settings);
      playlist = null;
      epg = null;
      refresh(true);
      return json({ returnValue: true });
    });
  }
  if (u === '/api/live/reset' && req.method === 'POST') {
    settings = {};
    playlist = null;
    epg = null;
    var files = [SETTINGS, PLAYLIST, EPG, STATE];
    for (var fi = 0; fi < files.length; fi++)
      try {
        fs.unlinkSync(files[fi]);
      } catch (_) {}
    state = { fav: [], recent: [], failed: {} };
    return json({ returnValue: true });
  }
  res.writeHead(404);
  res.end();
}

// the id the page asks the guide with: the playlist's own, or the guide channel found by name
function guideId(c) {
  return epg && epg.byId && epg.byId[c.id] ? c.id : (epg && epg.map && epg.map[c.key]) || c.id;
}

// refresh once shortly after start (low priority), then twice a day
function start() {
  if (settings.playlistUrl)
    setTimeout(function () {
      refresh(false);
    }, 20000);
  var iv = setInterval(
    function () {
      refresh(false);
    },
    6 * 3600 * 1000
  );
  if (iv.unref) iv.unref();
}

// ctx is not needed: this part keeps its own state
function create(/** @type {any} */ _ctx) {
  return { name: 'live', prefix: '/api/live/', handle: handle, start: start };
}

module.exports = {
  create: create,
  handle: handle,
  parseM3U: parseM3U,
  parseEpg: parseEpg,
  probe: probe,
  derivedEpgUrl: derivedEpgUrl,
  nameKey: nameKey,
};
