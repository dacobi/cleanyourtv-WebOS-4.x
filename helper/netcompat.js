// Compatibility layer so the service runs unchanged from webOS 4.x (Node 0.12) and webOS 5/6 (Node 8) to webOS 25+ (Node 16+):
// URL / URLSearchParams, TLS root CAs on Node 0.12, http(s).get(url, options, cb), request timeouts, stream destroy, Buffer.from/alloc,
// crypto.randomInt / timingSafeEqual, fs.copyFileSync, mkdirp and Object.assign.
var url = require('url'),
  https = require('https'),
  querystring = require('querystring'),
  fs = require('fs'),
  path = require('path'),
  crypto = require('crypto');

var NODE_MAJOR = parseInt(String(process.versions && process.versions.node).split('.')[0], 10) || 0;

/**
 * @template {object} T
 * @param {T} target
 * @param {...any} _rest
 * @returns {any}
 */
function assign(target, _rest) {
  var t = Object(target || {});
  for (var i = 1; i < arguments.length; i++) {
    var s = arguments[i];
    if (s && typeof s === 'object') {
      var ks = Object.keys(s);
      for (var j = 0; j < ks.length; j++) t[ks[j]] = s[ks[j]];
    }
  }
  return t;
}
if (!Object.assign) Object.assign = assign;

function dec(s) {
  try {
    return decodeURIComponent(String(s).replace(/\+/g, ' '));
  } catch (_) {
    return String(s).replace(/\+/g, ' ');
  }
}

/** @constructor @param {string} [init] */
function PolySearchParams(init) {
  var q = String(init || '').replace(/^\?/, '');
  /** @type {Array<[string, string]>} */
  this._p = [];
  if (!q) return;
  var parts = q.split('&');
  for (var i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    var eq = parts[i].indexOf('=');
    if (eq < 0) this._p.push([dec(parts[i]), '']);
    else this._p.push([dec(parts[i].slice(0, eq)), dec(parts[i].slice(eq + 1))]);
  }
}
PolySearchParams.prototype.get = function (name) {
  var k = String(name);
  for (var i = 0; i < this._p.length; i++) if (this._p[i][0] === k) return this._p[i][1];
  return null;
};
PolySearchParams.prototype.set = function (name, val) {
  var k = String(name),
    v = String(val),
    /** @type {[string, string][]} */
    kept = [],
    done = false;
  for (var i = 0; i < this._p.length; i++) {
    if (this._p[i][0] === k) {
      if (!done) {
        kept.push([k, v]);
        done = true;
      }
    } else kept.push(this._p[i]);
  }
  if (!done) kept.push([k, v]);
  this._p = kept;
};
PolySearchParams.prototype.toString = function () {
  var out = [];
  for (var i = 0; i < this._p.length; i++) {
    out.push(querystring.escape(this._p[i][0]) + '=' + querystring.escape(this._p[i][1]));
  }
  return out.join('&');
};

/** @constructor @param {string} input @param {string|any} [base] */
function PolyURL(input, base) {
  var raw = String(input || '');
  if (base !== undefined) {
    var b = base instanceof PolyURL ? base.href : String(base || '');
    var bp = url.parse(b);
    if (!bp.protocol || (!bp.hostname && bp.protocol !== 'file:')) throw new TypeError('Invalid base URL');
    raw = url.resolve(b, raw);
  }
  var p = url.parse(raw);
  if (!p.protocol || (!p.hostname && p.protocol !== 'file:')) throw new TypeError('Invalid URL: ' + raw);
  this.protocol = p.protocol;
  var hn = p.hostname || '';
  this.hostname = hn.indexOf(':') >= 0 && hn.charAt(0) !== '[' ? '[' + hn + ']' : hn;
  var defPort = (p.protocol === 'http:' && p.port === '80') || (p.protocol === 'https:' && p.port === '443');
  this.port = p.port && !defPort ? String(p.port) : '';
  this.host = this.hostname + (this.port ? ':' + this.port : '');
  this.pathname = p.pathname || '/';
  this.search = p.search || '';
  this.hash = p.hash || '';
  var auth = p.auth || '',
    colon = auth.indexOf(':');
  this.username = colon >= 0 ? auth.slice(0, colon) : auth;
  this.password = colon >= 0 ? auth.slice(colon + 1) : '';
  this.searchParams = new PolySearchParams(this.search);
  this.origin = this.protocol + '//' + this.host;
  this.href = this.protocol + '//' + (auth ? auth + '@' : '') + this.host + this.pathname + this.search + this.hash;
}
PolyURL.prototype.toString = function () {
  var q = this.searchParams ? this.searchParams.toString() : '';
  var s = q ? '?' + q : this.search || '';
  return (
    this.protocol +
    '//' +
    (this.username ? this.username + (this.password ? ':' + this.password : '') + '@' : '') +
    this.host +
    this.pathname +
    s +
    this.hash
  );
};

var URLCtor = /** @type {typeof url.URL} */ (url.URL || PolyURL);
var URLSearchParamsCtor = /** @type {typeof url.URLSearchParams} */ (url.URLSearchParams || PolySearchParams);

// Node 0.12 (webOS 4.x) ships a 2015 OpenSSL CA bundle that rejects modern GitHub / Let's Encrypt certificates; load the TV's system CAs once.
/** @type {string[]|null} */
var cachedCa = null;
function systemCa() {
  if (cachedCa !== null) return cachedCa;
  cachedCa = [];
  var file = process.env.CYTV_CA_FILE || '/etc/ssl/certs/ca-certificates.crt';
  try {
    var pem = fs.readFileSync(file, 'utf8');
    var m = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
    if (m && m.length) cachedCa = m;
  } catch (_) {}
  return cachedCa;
}

// http(s) options from an address plus extra options (the address form with options came with Node 10.9)
function withUrl(u, opts, isHttps) {
  var x = u && typeof u === 'object' && typeof u.protocol === 'string' && typeof u.pathname === 'string' ? u : new URLCtor(String(u));
  /** @type {any} */
  var o = { protocol: x.protocol, hostname: x.hostname.replace(/^\[|\]$/g, ''), path: x.pathname + x.search };
  if (x.port) o.port = x.port;
  if (x.username) o.auth = decodeURIComponent(x.username) + ':' + decodeURIComponent(x.password);
  assign(o, opts || {});
  if (NODE_MAJOR > 0 && NODE_MAJOR < 8 && isHttps && o.rejectUnauthorized !== false && !o.ca) {
    var ca = systemCa();
    if (ca.length) o.ca = ca;
  }
  return o;
}

function request(lib, u, opts, cb) {
  var isHttps = lib === https || (u && String(u.protocol || u).indexOf('https:') === 0);
  var req = lib.request(withUrl(u, opts, isHttps), cb);
  if (NODE_MAJOR > 0 && NODE_MAJOR < 8 && opts && opts.timeout > 0) req.setTimeout(opts.timeout);
  return req;
}

function get(lib, u, opts, cb) {
  var req = request(lib, u, opts, cb);
  req.end();
  return req;
}

// Safely abort/destroy HTTP requests, responses, sockets and zlib streams on Node 0.12 through modern Node
function destroy(s, err) {
  if (!s) return;
  try {
    if (NODE_MAJOR > 0 && NODE_MAJOR < 8 && typeof s.abort === 'function') {
      s.abort();
      if (err && typeof s.emit === 'function') s.emit('error', err);
      return;
    }
    if (typeof s.destroy === 'function') {
      if (NODE_MAJOR >= 8 && err) s.destroy(err);
      else {
        s.destroy();
        if (err && typeof s.emit === 'function') s.emit('error', err);
      }
    } else if (typeof s.abort === 'function') {
      s.abort();
      if (err && typeof s.emit === 'function') s.emit('error', err);
    } else if (typeof s.close === 'function') {
      s.close();
      if (err && typeof s.emit === 'function') s.emit('error', err);
    }
  } catch (_) {}
}

// Buffer helpers (Buffer.from / Buffer.alloc came with Node 5.10)
/**
 * @param {any} x
 * @param {BufferEncoding} [enc]
 * @returns {Buffer}
 */
function bufFrom(x, enc) {
  if (Buffer.from && Buffer.alloc) return enc ? Buffer.from(x, enc) : Buffer.from(x);
  var LegacyBuf = /** @type {any} */ (Buffer);
  return enc ? new LegacyBuf(x, enc) : new LegacyBuf(x);
}

/**
 * @param {number} n
 * @returns {Buffer}
 */
function bufAlloc(n) {
  if (Buffer.alloc) return Buffer.alloc(n);
  var LegacyBuf = /** @type {any} */ (Buffer);
  var b = new LegacyBuf(n);
  b.fill(0);
  return b;
}

/**
 * @param {Buffer} a
 * @param {Buffer} b
 * @returns {boolean}
 */
function timingSafeEqual(a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b) || a.length !== b.length) return false;
  if (crypto.timingSafeEqual) return crypto.timingSafeEqual(a, b);
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * @param {string} src
 * @param {string} dst
 */
function copyFileSync(src, dst) {
  if (fs.copyFileSync) fs.copyFileSync(src, dst);
  else fs.writeFileSync(dst, fs.readFileSync(src));
}

// mkdir -p
function mkdirp(d) {
  try {
    fs.mkdirSync(d);
  } catch (e) {
    if (e.code === 'ENOENT') {
      mkdirp(path.dirname(d));
      fs.mkdirSync(d);
    } else if (e.code !== 'EEXIST') throw e;
  }
}

// crypto.randomInt (Node 14.10 / 12.19): an unbiased random integer in [min, max)
function randomInt(min, max) {
  if (crypto.randomInt) return crypto.randomInt(min, max);
  var range = max - min,
    limit = Math.floor(0x100000000 / range) * range,
    x;
  do {
    x = crypto.randomBytes(4).readUInt32BE(0);
  } while (x >= limit); // reject the uneven top so every value is equally likely
  return min + (x % range);
}

module.exports = {
  URL: URLCtor,
  URLSearchParams: URLSearchParamsCtor,
  PolyURL: PolyURL,
  PolySearchParams: PolySearchParams,
  assign: assign,
  get: get,
  request: request,
  destroy: destroy,
  bufFrom: bufFrom,
  bufAlloc: bufAlloc,
  timingSafeEqual: timingSafeEqual,
  copyFileSync: copyFileSync,
  mkdirp: mkdirp,
  randomInt: randomInt,
  systemCa: systemCa,
};
