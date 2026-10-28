// The service's one HTTP(S) client: updates, themes, playlists and guides, pictures for notifications, voice models, Home Assistant.
// Everything a download can do wrong on a TV is handled here once: redirects, plain http where it is not allowed, a connection that
// drops after the headers (Node emits 'aborted' on the response, not an error), a server that never answers, a file that is too
// large, and gzip (announced by the server or only recognisable by its first bytes, an address ending in .gz).
//   read(url, opts)          -> {status, headers, body: Buffer, url}
//   open(url, opts)          -> a readable stream of the body (for large files that are read line by line)
//   toFile(url, file, opts)  -> {sha256} of what was written
// Options: headers, method, body (sent as is, or JSON for an object), idleMs (no data for this long: 'timed out', default 20 s),
// totalMs (the whole request, default none), maxBytes, redirects (how many to follow, default 5; never for a POST), allowHttp
// (default true), insecure (accept any TLS certificate), refuseLocal (refuse addresses of the TV itself), anyStatus (resolve with
// any status instead of rejecting what is not 200), statusText(status) for the message of a refused status, unzip: 'header'
// (default) or 'sniff' (also unpack a body that starts like gzip). Errors carry .code: url, http, local, redirects, status (with
// .status), lost, timeout, big.
var http = require('http'),
  https = require('https'),
  zlib = require('zlib'),
  crypto = require('crypto'),
  fs = require('fs');
var nc = require('./netcompat'),
  URL = nc.URL;
var diag = require('./diag');

function fail(message, code, status) {
  var e = /** @type {Error & {code?: string, status?: number}} */ (new Error(message));
  e.code = code;
  if (status) e.status = status;
  return e;
}
var LOCAL = /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?$)/i;

function allowed(a) {
  return typeof a === 'function' ? !!a() : a !== false;
}

// one request with its redirects; resolves {res, url} once a response with the wanted status has its headers
function connect(url, o, hops) {
  return new Promise(function (resolve, reject) {
    var u;
    try {
      u = new URL(String(url));
    } catch (_) {
      return reject(fail('not a valid address', 'url'));
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(fail('the address must start with http:// or https://', 'url'));
    if (u.protocol === 'http:' && !allowed(o.allowHttp)) return reject(fail('refusing a download over plain http', 'http'));
    if (o.refuseLocal && LOCAL.test(u.hostname)) return reject(fail('the address must not point at the TV itself', 'local'));
    var data = null;
    if (o.body !== undefined && o.body !== null)
      data = Buffer.isBuffer(o.body) ? o.body : nc.bufFrom(typeof o.body === 'string' ? o.body : JSON.stringify(o.body));
    var method = o.method || (data ? 'POST' : 'GET');
    var headers = nc.assign({}, o.headers || {});
    if (data) {
      if (
        !Object.keys(headers).some(function (k) {
          return k.toLowerCase() === 'content-type';
        })
      )
        headers['content-type'] = 'application/json';
      headers['content-length'] = data.length;
    }
    /** @type {any} */
    var opts = { method: method, headers: headers, timeout: o.idleMs || 20000 };
    if (o.insecure) opts.rejectUnauthorized = false;
    diag.note('request', method + ' ' + u.protocol + '//' + u.host + u.pathname);
    var req = nc.request(u.protocol === 'https:' ? https : http, u, opts, function (res) {
      var st = res.statusCode;
      if (st >= 300 && st < 400 && res.headers.location && method === 'GET' && o.redirects !== 0) {
        res.resume();
        if ((hops || 0) >= (o.redirects === undefined ? 5 : o.redirects)) return reject(fail('too many redirects', 'redirects'));
        return resolve(connect(new URL(res.headers.location, u).toString(), o, (hops || 0) + 1));
      }
      if (st !== 200 && !o.anyStatus) {
        res.resume();
        return reject(fail(o.statusText ? o.statusText(st) : 'HTTP ' + st, 'status', st));
      }
      resolve({ res: res, url: u.toString(), req: req });
    });
    req.on('timeout', function () {
      nc.destroy(req, fail('timed out', 'timeout'));
    });
    req.on('error', reject);
    req.end(data || undefined);
  });
}

// the body as a stream that ends with an error when the connection drops, unpacked when it is gzip
function bodyOf(res, o) {
  return new Promise(function (resolve, reject) {
    function lost() {
      return fail('the connection was lost', 'lost');
    }
    function gunzip() {
      var gz = res.pipe(zlib.createGunzip());
      res.on('aborted', function () {
        nc.destroy(gz, lost());
      });
      res.on('error', function (e) {
        nc.destroy(gz, e);
      });
      return gz;
    }
    if (String(res.headers['content-encoding'] || '').toLowerCase() === 'gzip') return resolve(gunzip());
    res.on('aborted', function () {
      res.emit('error', lost());
    });
    if (o.unzip !== 'sniff') return resolve(res);
    // look at the first bytes: 1f 8b is gzip
    function onErr(e) {
      reject(e);
    }
    res.once('error', onErr);
    // an empty body ends before any data: hand on a stream that has already ended, so a reader sees its end
    res.once('end', function () {
      var empty = new (require('stream').PassThrough)();
      empty.end();
      resolve(empty);
    });
    res.once('data', function (first) {
      res.pause();
      res.unshift(first);
      res.removeListener('error', onErr);
      resolve(first.length > 1 && first[0] === 0x1f && first[1] === 0x8b ? gunzip() : res);
    });
  });
}

// a time limit for the whole request, so nothing can hang on a TV
function within(p, ms, message) {
  if (!ms) return p;
  return new Promise(function (resolve, reject) {
    var t = setTimeout(function () {
      reject(fail(message || 'timed out', 'timeout'));
    }, ms);
    p.then(
      function (v) {
        clearTimeout(t);
        resolve(v);
      },
      function (e) {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

function read(url, opts) {
  var o = opts || {};
  /** @type {any} */
  var conn = null;
  var work = connect(url, o).then(function (c) {
    return new Promise(function (resolve, reject) {
      conn = c;
      bodyOf(c.res, o).then(function (s) {
        var b = [];
        var n = 0,
          ended = false;
        s.on('data', function (chunk) {
          n += chunk.length;
          if (o.maxBytes && n > o.maxBytes) {
            reject(fail(o.bigText || 'the file is too large', 'big'));
            nc.destroy(s);
            return nc.destroy(c.req);
          }
          b.push(chunk);
        });
        s.on('end', function () {
          ended = true;
          resolve({ status: c.res.statusCode, headers: c.res.headers, body: Buffer.concat(b), url: c.url });
        });
        s.on('error', reject);
        s.on('close', function () {
          if (!ended) reject(fail('the connection was closed', 'lost'));
        });
      }, reject);
    });
  });
  return within(work, o.totalMs, o.totalText).then(null, function (e) {
    if (conn) nc.destroy(conn.req);
    throw e;
  });
}

function open(url, opts) {
  var o = opts || {};
  return connect(url, o).then(function (c) {
    return bodyOf(c.res, o);
  });
}

function toFile(url, file, opts) {
  var o = opts || {};
  var work = connect(url, o).then(function (c) {
    return new Promise(function (resolve, reject) {
      bodyOf(c.res, o).then(function (s) {
        var h = crypto.createHash('sha256'),
          w = fs.createWriteStream(file);
        var n = 0;
        s.on('data', function (chunk) {
          n += chunk.length;
          if (o.maxBytes && n > o.maxBytes) {
            reject(fail(o.bigText || 'the file is too large', 'big'));
            nc.destroy(s);
            nc.destroy(c.req);
          } else h.update(chunk);
        });
        s.on('error', function (e) {
          nc.destroy(w);
          reject(e);
        });
        s.pipe(w);
        w.on('finish', function () {
          resolve({ sha256: h.digest('hex'), bytes: n });
        });
        w.on('error', reject);
      }, reject);
    });
  });
  return within(work, o.totalMs, o.totalText);
}

module.exports = { read: read, open: open, toFile: toFile, within: within, fail: fail };
