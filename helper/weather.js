// Weather for the weather card (cards.js), from Open-Meteo: free, no key, no account. The service asks for a place's weather at most
// every 30 minutes and keeps the last answer in weather.json, so Home shows it at once and while the internet is away. Only the
// coordinates of the chosen place leave the TV; the place is searched by name on the phone page (search).
//   create({path}) -> { get(lat, lon, unit) -> {now, days, at, place?} | {error}, search(name, lang) -> [{name, area, lat, lon}] }
var fs = require('fs');
var fetch = require('./fetch');
var FORECAST = process.env.CYTV_WEATHER_URL || 'https://api.open-meteo.com/v1/forecast',
  GEO = process.env.CYTV_GEO_URL || 'https://geocoding-api.open-meteo.com/v1/search',
  EVERY = 30 * 60 * 1000,
  OLD = 24 * 3600 * 1000; // older than a day is not shown

function num(v, lo, hi) {
  return typeof v === 'number' && isFinite(v) && v >= lo && v <= hi;
}
function r1(n) {
  return Math.round(n * 100) / 100;
}
function read(url) {
  return fetch
    .read(url, {
      headers: { 'User-Agent': 'cleanyourtv-weather' },
      maxBytes: 256 * 1024,
      totalMs: 15000,
      allowHttp: function () {
        return !!(process.env.CYTV_WEATHER_URL || process.env.CYTV_GEO_URL);
      },
    })
    .then(function (r) {
      return JSON.parse(r.body.toString('utf8'));
    });
}

function create(opts) {
  var file = opts.path;
  /** @type {Record<string, any>} */
  var cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch (_) {}
  /** @type {Record<string, Promise<any>>} */
  var busy = {};
  function keep() {
    try {
      // only recent places stay in the file
      var ks = Object.keys(cache);
      for (var i = 0; i < ks.length; i++) {
        var k = ks[i];
        if (Date.now() - cache[k].at > OLD) delete cache[k];
      }
      fs.writeFileSync(file + '.tmp', JSON.stringify(cache));
      fs.renameSync(file + '.tmp', file);
    } catch (_) {}
  }
  function fetchNow(lat, lon, unit) {
    var q =
      '?latitude=' +
      lat +
      '&longitude=' +
      lon +
      '&current=temperature_2m,weather_code,is_day&daily=weather_code,temperature_2m_max,temperature_2m_min' +
      '&timezone=auto&forecast_days=4' +
      (unit === 'f' ? '&temperature_unit=fahrenheit' : '');
    return read(FORECAST + q).then(function (j) {
      var c = j.current || {},
        d = j.daily || {};
      if (typeof c.temperature_2m !== 'number') throw new Error('no weather for this place');
      return {
        at: Date.now(),
        unit: unit,
        now: { temp: Math.round(c.temperature_2m), code: c.weather_code | 0, day: c.is_day !== 0 },
        days: (d.time || []).slice(0, 4).map(function (t, i) {
          return {
            date: String(t).slice(0, 10),
            code: (d.weather_code || [])[i] | 0,
            max: Math.round((d.temperature_2m_max || [])[i]),
            min: Math.round((d.temperature_2m_min || [])[i]),
          };
        }),
      };
    });
  }
  // the weather of a place: the kept answer when it is recent, else a new one (the kept one if that fails)
  function get(lat, lon, unit) {
    if (!num(lat, -90, 90) || !num(lon, -180, 180)) return Promise.resolve({ error: 'no place chosen' });
    var u = unit === 'f' ? 'f' : 'c';
    var key = r1(lat) + ',' + r1(lon) + ',' + u,
      had = cache[key];
    if (had && Date.now() - had.at < EVERY) return Promise.resolve(had);
    if (!busy[key])
      // (no .finally: Node 0.12 and Node 8 do not have it)
      busy[key] = fetchNow(r1(lat), r1(lon), u).then(
        function (w) {
          delete busy[key];
          cache[key] = w;
          keep();
          return w;
        },
        function (e) {
          delete busy[key];
          throw e;
        }
      );
    return busy[key].then(null, function (e) {
      return had && Date.now() - had.at < OLD ? had : { error: String(e.message || e) };
    });
  }
  // places by name, for the phone page
  function search(name, lang) {
    var n = String(name || '')
      .trim()
      .slice(0, 80);
    if (n.length < 2) return Promise.resolve([]);
    return read(GEO + '?count=6&format=json&name=' + encodeURIComponent(n) + '&language=' + encodeURIComponent(lang || 'en')).then(
      function (j) {
        return (j.results || [])
          .filter(function (p) {
            return num(p.latitude, -90, 90) && num(p.longitude, -180, 180);
          })
          .map(function (p) {
            return {
              name: String(p.name || '').slice(0, 60),
              area: [p.admin1, p.country].filter(Boolean).join(', ').slice(0, 80),
              lat: r1(p.latitude),
              lon: r1(p.longitude),
            };
          });
      }
    );
  }
  return { get: get, search: search };
}

module.exports = { create: create };
