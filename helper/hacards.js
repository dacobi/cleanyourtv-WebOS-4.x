// Home Assistant for the cards (cards.js): the states of entities, a toggle, and a camera's picture. It uses the address and the
// long-lived access token already set for Voice (config voice.ha, typed on the voice phone page), so nothing new is stored. The states
// come from one /api/states request that is kept 20 seconds, however many cards ask.
//   create({config}) -> { ready(), states(ids) -> [{id, name, state, unit, domain, on}], toggle(id), camera(id) -> {type, body},
//                         entities() -> [{id, name}] for the phone page }
var nc = require('./netcompat'),
  fetch = require('./fetch'),
  answers = require('./answers');
// what OK on a card may switch: things that are on or off, and scenes and scripts that run. Not locks, alarms or covers.
var TOGGLE = ['light', 'switch', 'fan', 'input_boolean', 'automation'],
  RUN = ['scene', 'script'],
  ID = /^[a-z_]+\.[\w]{1,120}$/;

function create(opts) {
  var config = opts.config;
  function ha() {
    return nc.assign({}, answers.HA_DEFAULTS, (config.get().voice || {}).ha || {});
  }
  function ready() {
    return answers.haReady(ha());
  }
  function call(path, method, payload, max) {
    var h = ha();
    return fetch
      .read(h.url + path, {
        method: method || 'GET',
        headers: { authorization: 'Bearer ' + h.token, 'content-type': 'application/json' },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        totalMs: 15000,
        redirects: 0,
        anyStatus: true,
        maxBytes: max || 4 << 20,
        insecure: !!(h.selfSigned && /^https:/.test(h.url)),
      })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) throw new Error('Home Assistant refused the access token');
        if (r.status < 200 || r.status >= 300) throw new Error('Home Assistant answered ' + r.status);
        return r;
      });
  }
  /** @type {{at: number, list: any[]}|null} */
  var all = null; // { at, list }
  function list() {
    if (all && Date.now() - all.at < 20000) return Promise.resolve(all.list);
    return call('/api/states').then(function (r) {
      var l = [];
      try {
        l = JSON.parse(r.body.toString('utf8'));
      } catch (_) {
        throw new Error('Home Assistant did not answer with JSON');
      }
      all = { at: Date.now(), list: Array.isArray(l) ? l : [] };
      return all.list;
    });
  }
  function short(e) {
    var id = String(e.entity_id || ''),
      a = e.attributes || {},
      domain = id.split('.')[0];
    return {
      id: id,
      name: String(a.friendly_name || id).slice(0, 60),
      state: String(e.state === undefined ? '' : e.state).slice(0, 60),
      unit: String(a.unit_of_measurement || '').slice(0, 12),
      domain: domain,
      can: TOGGLE.indexOf(domain) >= 0 || RUN.indexOf(domain) >= 0,
    };
  }
  function states(ids) {
    if (!ready()) return Promise.resolve({ error: 'Home Assistant is not set up' });
    var want = (Array.isArray(ids) ? ids : [])
      .filter(function (i) {
        return typeof i === 'string' && ID.test(i);
      })
      .slice(0, 20);
    return list().then(
      function (items) {
        /** @type {Record<string, any>} */
        var by = {};
        for (var i = 0; i < items.length; i++) by[items[i].entity_id] = items[i];
        return {
          states: want.map(function (id) {
            return by[id] ? short(by[id]) : { id: id, name: id, state: 'unavailable', unit: '', domain: id.split('.')[0], can: false };
          }),
        };
      },
      function (e) {
        return { error: String(e.message || e) };
      }
    );
  }
  function toggle(id) {
    if (!ready()) return Promise.resolve({ error: 'Home Assistant is not set up' });
    if (typeof id !== 'string' || !ID.test(id)) return Promise.resolve({ error: 'bad entity' });
    var domain = id.split('.')[0];
    var svc = TOGGLE.indexOf(domain) >= 0 ? domain + '/toggle' : RUN.indexOf(domain) >= 0 ? domain + '/turn_on' : '';
    if (!svc) return Promise.resolve({ error: 'this entity cannot be switched from the TV' });
    return call('/api/services/' + svc, 'POST', { entity_id: id }, 1 << 20).then(
      function () {
        all = null; // the next states show the change
        return { ok: true };
      },
      function (e) {
        return { error: String(e.message || e) };
      }
    );
  }
  function camera(id) {
    if (!ready() || typeof id !== 'string' || !/^camera\.[\w]{1,120}$/.test(id)) return Promise.resolve(null);
    return call('/api/camera_proxy/' + id, 'GET', undefined, 4 << 20).then(
      function (r) {
        var type = String(r.headers['content-type'] || 'image/jpeg');
        return /^image\//.test(type) ? { type: type, body: r.body } : null;
      },
      function () {
        return null;
      }
    );
  }
  function entities() {
    if (!ready()) return Promise.resolve([]);
    return list().then(function (items) {
      return items
        .map(short)
        .sort(function (a, b) {
          return a.id.localeCompare(b.id);
        })
        .slice(0, 2000)
        .map(function (e) {
          return { id: e.id, name: e.name };
        });
    });
  }
  return { ready: ready, states: states, toggle: toggle, camera: camera, entities: entities };
}

module.exports = { create: create, TOGGLE: TOGGLE, RUN: RUN };
