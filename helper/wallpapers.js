// Wallpapers: your own photos as the launcher's background, from two sources kept apart on disk:
//   D/wallpapers/upload/<random>.jpg   photos uploaded from a phone (the phone page scales them before sending)
//   D/wallpapers/immich/<asset id>.jpg photos from chosen Immich albums, downloaded by a sync and kept, so showing one never needs Immich
// D/wallpapers/index.json says what each file is (source, size, Immich checksum); only files listed there are ever deleted.
// The settings are the wallpapers section of config.json: {size: '4k'|'hd' (4K is the default: Home is drawn at the panel's 3840 x 2160), immich: {url, key, albums: [ids], hidden: [asset ids]}}.
// The Immich key never leaves the service: status() shows its last four characters only, and it is not logged.
// API (loopback, our apps): GET /api/wallpapers/status, GET /api/wallpapers/list, GET /api/wallpapers/photo/<u|i>/<id>,
// POST /api/wallpapers/set {size}, POST /api/wallpapers/pair, POST /api/wallpapers/sync, POST /api/wallpapers/remove-uploads,
// POST /api/wallpapers/disconnect. The phone page (POST pair) is a short-lived server on the LAN, port 8791, that needs the code shown
// on the TV; its API is under /api/ on that port.
var fs = require('fs'),
  http = require('http'),
  path = require('path'),
  crypto = require('crypto');
var P = require('./paths'),
  web = require('./web'),
  i18n = require('./i18n'),
  fetch = require('./fetch'),
  nc = require('./netcompat');

var DIR = P.D + '/wallpapers',
  UP = DIR + '/upload',
  IM = DIR + '/immich',
  INDEX = DIR + '/index.json';
var LIMITS = { uploads: 100, immich: 300, bytes: 150 * 1024 * 1024, file: 12 * 1024 * 1024 };
var PAIR_PORT = 8791, // after the Share-log page's range (8768-8790)
  PAIR_MS = 15 * 60 * 1000,
  SYNC_MS = 6 * 3600 * 1000;
var ID = /^[a-f0-9]{16}$/,
  ASSET = /^[0-9a-f-]{36}$/i;
var PNG_MAGIC = nc.bufFrom([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// what a file is, from its first bytes: only JPEG, PNG and WebP are kept
function imageType(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 8 && b.slice(0, 8).equals(PNG_MAGIC)) return 'png';
  if (b.length > 12 && b.toString('binary', 0, 4) === 'RIFF' && b.toString('binary', 8, 12) === 'WEBP') return 'webp';
  return '';
}
/** @type {Record<string, string>} */
var MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

function create(ctx) {
  var config = ctx.config;
  function cfg() {
    return nc.assign({ size: '4k' }, config.get().wallpapers || {});
  }
  function icfg() {
    return nc.assign({ url: '', key: '', albums: [], hidden: [] }, cfg().immich || {});
  }
  function setCfg(fn) {
    return config.update('wallpapers', function (c) {
      c.wallpapers = nc.assign({}, c.wallpapers || {}); // the size is written only when it is chosen
      fn(c.wallpapers);
    });
  }

  // ---- the index of the files ----
  /** @type {any} */
  var index = null;
  function idx() {
    if (index) return index;
    try {
      index = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
    } catch (_) {
      index = {};
    }
    index.upload = Array.isArray(index.upload) ? index.upload : [];
    index.immich = index.immich && typeof index.immich === 'object' ? index.immich : {};
    index.sync = index.sync || { state: 'idle', at: 0, error: '', ok: 0 };
    return index;
  }
  function saveIdx() {
    nc.mkdirp(DIR);
    fs.writeFileSync(INDEX + '.tmp', JSON.stringify(idx()));
    fs.renameSync(INDEX + '.tmp', INDEX);
  }
  function immichList() {
    var i = idx().immich,
      hid = icfg().hidden;
    return Object.keys(i).filter(function (id) {
      return hid.indexOf(id) < 0;
    });
  }
  function usedBytes() {
    var x = idx();
    return (
      x.upload.reduce(function (n, u) {
        return n + (u.bytes || 0);
      }, 0) +
      Object.keys(x.immich).reduce(function (n, k) {
        return n + (x.immich[k].bytes || 0);
      }, 0)
    );
  }
  // your photos are for root only, as the settings are
  function mkdir(d) {
    nc.mkdirp(d);
    try {
      fs.chmodSync(DIR, parseInt('700', 8));
    } catch (_) {}
  }
  function unlink(f) {
    try {
      fs.unlinkSync(f);
    } catch (_) {}
  }

  // ---- uploads ----
  function addUpload(buf) {
    var type = imageType(buf);
    if (!type) return 'not a JPEG, PNG or WebP picture';
    if (buf.length > LIMITS.file) return 'the picture is larger than 12 MB';
    if (idx().upload.length >= LIMITS.uploads) return 'there are ' + LIMITS.uploads + ' uploads already: remove some first';
    if (usedBytes() + buf.length > LIMITS.bytes) return 'Wallpapers is full (150 MB): remove some photos first';
    mkdir(UP);
    var id = crypto.randomBytes(8).toString('hex'),
      file = id + '.' + type;
    fs.writeFileSync(path.join(UP, file + '.tmp'), buf, { mode: parseInt('600', 8) });
    fs.renameSync(path.join(UP, file + '.tmp'), path.join(UP, file));
    idx().upload.push({ id: id, file: file, bytes: buf.length, at: Date.now() });
    saveIdx();
    return '';
  }
  function removeUpload(id) {
    var u = idx().upload.filter(function (x) {
      return x.id === id;
    })[0];
    if (!u) return false;
    unlink(path.join(UP, u.file));
    idx().upload = idx().upload.filter(function (x) {
      return x.id !== id;
    });
    saveIdx();
    return true;
  }
  function removeUploads() {
    var list = idx().upload;
    for (var i = 0; i < list.length; i++) unlink(path.join(UP, list[i].file));
    idx().upload = [];
    saveIdx();
  }

  // ---- Immich (https://immich.app/docs/api): the key goes in the x-api-key header ----
  function base(u) {
    return String(u || '')
      .trim()
      .replace(/\/+$/, '')
      .replace(/\/api$/, '');
  }
  function immich(pathname, ic, opts) {
    var c = ic || icfg();
    return fetch
      .read(
        base(c.url) + '/api' + pathname,
        nc.assign(
          { headers: { 'x-api-key': c.key, Accept: 'application/json' }, idleMs: 20000, maxBytes: 16 << 20, anyStatus: true },
          opts || {}
        )
      )
      .then(function (r) {
        if (r.status === 401 || r.status === 403) throw new Error('Immich refused the API key (needs album.read and asset.read/view)');
        if (r.status !== 200) throw new Error('Immich answered ' + r.status);
        return JSON.parse(r.body.toString('utf8'));
      });
  }
  // every album the key can read: own and shared with you
  function albums(ic) {
    return immich('/albums', ic).then(function (own) {
      return immich('/albums?shared=true', ic)
        .then(null, function () {
          return [];
        })
        .then(function (shared) {
          /** @type {Record<string, number>} */
          var seen = {};
          return own
            .concat(shared)
            .filter(function (a) {
              return a && a.id && !seen[a.id] && (seen[a.id] = 1);
            })
            .map(function (a) {
              return { id: a.id, name: String(a.albumName || 'Album').slice(0, 80), count: a.assetCount || 0 };
            });
        });
    });
  }
  function connect(url, key) {
    var c = { url: base(url), key: key || icfg().key };
    if (!/^https?:\/\/[^/]+/i.test(c.url)) return Promise.resolve({ error: 'the address must start with http:// or https://' });
    if (!c.key) return Promise.resolve({ error: 'enter the API key' });
    return albums(c).then(
      function (list) {
        setCfg(function (w) {
          var old = nc.assign({ albums: [], hidden: [] }, w.immich || {});
          w.immich = {
            url: c.url,
            key: c.key,
            albums: old.url === c.url ? old.albums : [],
            hidden: old.url === c.url ? old.hidden : [],
          };
        });
        return { ok: true, albums: list };
      },
      function (e) {
        return { error: 'could not reach Immich: ' + String(e.message || e) };
      }
    );
  }

  // ---- the sync: new or changed photos are downloaded, photos no longer wanted are deleted (only files the index lists) ----
  /** @type {Promise<void>|null} */
  var syncing = null,
    again = false;
  // one sync at a time; a request during a sync (new albums chosen, Sync now) runs it once more afterwards, within the same promise
  function sync() {
    if (syncing) {
      again = true;
      return syncing;
    }
    function loop() {
      again = false;
      return doSync()
        .then(null, function () {})
        .then(function () {
          if (again) return loop();
          syncing = null;
        });
    }
    syncing = loop();
    return syncing;
  }
  function download(id, mime, size) {
    var ic = icfg(),
      tmp = path.join(IM, id + '.tmp'),
      hdrs = { 'x-api-key': ic.key };
    var tries =
      size === '4k'
        ? ['/assets/' + id + '/thumbnail?size=fullsize'].concat(
            /^image\/(jpeg|png|webp)$/.test(mime || '') ? ['/assets/' + id + '/original'] : [],
            ['/assets/' + id + '/thumbnail?size=preview']
          )
        : ['/assets/' + id + '/thumbnail?size=preview'];
    /** @type {any} */
    var last = null;
    function step(ti) {
      if (ti >= tries.length) {
        unlink(tmp);
        return Promise.reject(last || new Error('download failed'));
      }
      return fetch
        .read(base(ic.url) + '/api' + tries[ti], { headers: hdrs, idleMs: 30000, maxBytes: LIMITS.file, anyStatus: true })
        .then(function (r) {
          if (r.status !== 200) throw new Error('Immich answered ' + r.status);
          var type = imageType(r.body);
          if (!type) throw new Error('not a picture the TV can show');
          fs.writeFileSync(tmp, r.body, { mode: parseInt('600', 8) });
          var file = id + '.' + type;
          fs.renameSync(tmp, path.join(IM, file));
          return { file: file, bytes: r.body.length };
        })
        .then(null, function (e) {
          last = e;
          return step(ti + 1);
        });
    }
    return step(0);
  }
  // an album's photos. Up to Immich 1.x the album itself lists them; newer servers (2.x, 3.x) leave them out, so they are searched by
  // album (POST /api/search/metadata), a page at a time
  function albumAssets(id) {
    return immich('/albums/' + encodeURIComponent(id) + '?withoutAssets=false').then(function (al) {
      if (Array.isArray(al.assets)) return al.assets;
      /** @type {any[]} */
      var out = [];
      function nextPage(page, n) {
        if (!page || n >= 20) return Promise.resolve(out);
        return immich('/search/metadata', null, {
          method: 'POST',
          headers: { 'x-api-key': icfg().key, Accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ albumIds: [id], type: 'IMAGE', size: 250, page: page }),
        }).then(function (r) {
          var items = (r.assets && r.assets.items) || [];
          out = out.concat(items);
          var np = r.assets && r.assets.nextPage ? +r.assets.nextPage : 0;
          if (out.length >= LIMITS.immich * 2) return out;
          return nextPage(np, n + 1);
        });
      }
      return nextPage(1, 0);
    });
  }
  function doSync() {
    var ic = icfg(),
      st = idx().sync;
    if (!ic.url || !ic.key) return Promise.resolve();
    st.state = 'syncing';
    st.error = '';
    st.done = 0;
    return Promise.resolve()
      .then(function () {
        mkdir(IM);
        // the albums' photos, newest first, without videos or trashed ones (hidden ones stay on the TV, so they can be shown again)
        /** @type {any[]} */
        var want = [];
        /** @type {Record<string, number>} */
        var seen = {};
        var seq = Promise.resolve();
        ic.albums.forEach(function (a) {
          seq = seq
            .then(function () {
              return albumAssets(a);
            })
            .then(function (assets) {
              for (var i = 0; i < assets.length; i++) {
                var x = assets[i];
                if (x && ASSET.test(x.id) && x.type === 'IMAGE' && !x.isTrashed && x.visibility !== 'hidden' && !seen[x.id]) {
                  seen[x.id] = 1;
                  want.push({
                    id: x.id,
                    sum: x.checksum || '',
                    mime: x.originalMimeType || '',
                    at: Date.parse(x.fileCreatedAt || '') || 0,
                  });
                }
              }
            });
        });
        return seq.then(function () {
          want.sort(function (a, b) {
            return b.at - a.at;
          });
          if (!want.length && ic.albums.length) st.error = 'the chosen albums have no photos the TV can show';
          var keep = want.slice(0, LIMITS.immich),
            /** @type {Record<string, number>} */
            keepIds = {};
          keep.forEach(function (w) {
            keepIds[w.id] = 1;
          });
          // first the ones no longer wanted, so their space is free for the new ones
          var cur = idx().immich;
          var cks = Object.keys(cur);
          for (var j = 0; j < cks.length; j++) {
            var cid = cks[j];
            if (!keepIds[cid]) {
              unlink(path.join(IM, cur[cid].file));
              delete cur[cid];
            }
          }
          saveIdx();
          var size = cfg().size === 'hd' ? 'hd' : '4k';
          var full = false,
            failed = 0;
          function dlStep(ki) {
            if (ki >= keep.length) return Promise.resolve();
            var w = keep[ki];
            var have = cur[w.id];
            if (have && have.sum === w.sum && have.size === size && fs.existsSync(path.join(IM, have.file))) return dlStep(ki + 1);
            if (usedBytes() > LIMITS.bytes - 2 * 1024 * 1024) {
              full = true;
              return Promise.resolve();
            }
            return download(w.id, w.mime, size).then(
              function (d) {
                if (have && have.file !== d.file) unlink(path.join(IM, have.file));
                cur[w.id] = { file: d.file, bytes: d.bytes, sum: w.sum, size: size };
                st.done++;
                if (st.done % 10 === 0) saveIdx();
                return dlStep(ki + 1);
              },
              function (e) {
                failed++;
                if (failed >= 5 && !st.done) throw e; // Immich is down or the key lost a permission: stop, keep what is there
                return dlStep(ki + 1);
              }
            );
          }
          return dlStep(0).then(function () {
            st.ok = Date.now();
            if (full) st.error = 'Wallpapers is full (150 MB): not every photo was downloaded';
            else if (failed) st.error = failed + ' photos could not be downloaded';
          });
        });
      })
      .then(null, function (e) {
        st.error = String(e.message || e);
      })
      .then(function () {
        st.state = 'idle';
        st.at = Date.now();
        saveIdx();
      });
  }
  function disconnect() {
    var cur = idx().immich,
      ks = Object.keys(cur);
    for (var i = 0; i < ks.length; i++) unlink(path.join(IM, cur[ks[i]].file));
    idx().immich = {};
    idx().sync = { state: 'idle', at: 0, error: '', ok: 0 };
    saveIdx();
    setCfg(function (w) {
      delete w.immich;
    });
  }

  // ---- what the TV shows ----
  function list() {
    return idx()
      .upload.map(function (u) {
        return 'u/' + u.id;
      })
      .concat(
        immichList().map(function (id) {
          return 'i/' + id;
        })
      );
  }
  // a number that changes whenever the set of photos changes: the launcher reads the list again then
  function stamp() {
    var l = list();
    return l.length + ':' + crypto.createHash('md5').update(l.join(',')).digest('hex').slice(0, 8);
  }
  function status() {
    var ic = icfg(),
      s = idx().sync;
    return {
      size: cfg().size === 'hd' ? 'hd' : '4k',
      uploads: idx().upload.length,
      immich: {
        configured: !!(ic.url && ic.key),
        url: ic.url,
        keyHint: ic.key ? '…' + ic.key.slice(-4) : '',
        albums: ic.albums.length,
        photos: immichList().length,
        hidden: ic.hidden.length,
        state: s.state,
        lastSync: s.ok || 0,
        tried: s.at || 0,
        error: s.error || '',
        done: s.done || 0,
      },
      total: list().length,
      bytes: usedBytes(),
      limits: LIMITS,
      pair: pair ? { url: pair.url, code: pair.code, until: pair.until } : null,
    };
  }
  function photoFile(src, id) {
    if (src === 'u' && ID.test(id)) {
      var u = idx().upload.filter(function (x) {
        return x.id === id;
      })[0];
      return u ? path.join(UP, u.file) : '';
    }
    if (src === 'i' && ASSET.test(id) && idx().immich[id]) return path.join(IM, idx().immich[id].file);
    return '';
  }
  function sendPhoto(res, src, id, cacheHdr) {
    var f = photoFile(src, id);
    if (!f || !fs.existsSync(f)) return web.notFound(res);
    var ext = f.split('.').pop() || '';
    res.writeHead(200, { 'content-type': MIME[ext] || 'image/jpeg', 'cache-control': cacheHdr || 'max-age=86400' });
    fs.createReadStream(f).pipe(res);
  }

  // ---- the phone page: LAN, short-lived, the code shown on the TV in every request (header x-code) ----
  /** @type {any} */
  var pair = null;
  function startPair() {
    stopPair();
    var code = String(nc.randomInt(100000, 1000000));
    var bad = 0;
    var srv = http.createServer(function (req, res) {
      phone(req, res, code, function () {
        return ++bad;
      });
    });
    pair = {
      code: code,
      srv: srv,
      url: 'http://' + web.lanIp() + ':' + PAIR_PORT,
      until: Date.now() + PAIR_MS,
      timer: setTimeout(stopPair, PAIR_MS),
    };
    var out = { url: pair.url, code: code, qr: pair.url + '/#' + code, seconds: PAIR_MS / 1000 };
    return new Promise(function (resolve) {
      srv.on('error', function (e) {
        stopPair();
        resolve({ error: 'the phone page could not start: ' + e.message });
      });
      srv.listen(PAIR_PORT, '0.0.0.0', function () {
        resolve(out);
      });
    });
  }
  // while the page is used it stays open (up to an hour after it was opened)
  function touch() {
    if (!pair) return;
    clearTimeout(pair.timer);
    pair.until = Math.min(Date.now() + PAIR_MS, (pair.opened || (pair.opened = Date.now())) + 3600 * 1000);
    pair.timer = setTimeout(stopPair, pair.until - Date.now());
  }
  function stopPair() {
    if (!pair) return;
    clearTimeout(pair.timer);
    try {
      pair.srv.close();
    } catch (_) {}
    pair = null;
  }
  function rawBody(req, max) {
    return new Promise(function (resolve, reject) {
      /** @type {Buffer[]} */
      var b = [];
      var n = 0;
      req.on('data', function (c) {
        n += c.length;
        if (n > max) {
          reject(new Error('the picture is larger than 12 MB'));
          nc.destroy(req);
        } else b.push(c);
      });
      req.on('end', function () {
        resolve(Buffer.concat(b));
      });
      req.on('error', reject);
    });
  }
  function phone(req, res, code, wrong) {
    var u = String(req.url || '').split('?')[0];
    function json(o, c) {
      res.writeHead(c || 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(o));
    }
    if (req.method === 'GET' && u === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return Promise.resolve(res.end(phonePage(i18n.lang(req, config.get().lang))));
    }
    if (u.indexOf('/api/') !== 0) return Promise.resolve(web.notFound(res));
    if (req.headers['x-code'] !== code) {
      if (wrong() >= 8) stopPair();
      return Promise.resolve(json({ error: 'wrong code' }, 403));
    }
    touch();
    return Promise.resolve()
      .then(function () {
        if (u === '/api/state')
          return json(
            nc.assign(status(), {
              pair: null,
              uploadsList: idx().upload.map(function (x) {
                return x.id;
              }),
            })
          );
        var m = /^\/api\/photo\/([ui])\/([0-9a-f-]{16,36})$/i.exec(u);
        if (m && req.method === 'GET') return sendPhoto(res, m[1], m[2], 'private, max-age=3600');
        if (req.method !== 'POST') return json({ error: 'not found' }, 404);
        if (u === '/api/upload') {
          return rawBody(req, LIMITS.file).then(function (buf) {
            var err = addUpload(buf);
            return json(err ? { error: err } : { ok: true, uploads: idx().upload.length }, err ? 400 : 200);
          });
        }
        return web.body(req, 16384).then(function (b) {
          if (u === '/api/upload/delete') return json({ ok: removeUpload(String(b.id || '')) });
          if (u === '/api/immich/connect')
            return connect(String(b.url || ''), String(b.key || '')).then(function (r) {
              return json(r);
            });
          if (u === '/api/immich/albums') {
            if (Array.isArray(b.ids)) {
              var ids = b.ids
                .filter(function (x) {
                  return typeof x === 'string' && ASSET.test(x);
                })
                .slice(0, 50);
              setCfg(function (w) {
                w.immich = nc.assign({}, w.immich, { albums: ids });
              });
              sync();
              return json({ ok: true });
            }
            var sel = icfg().albums;
            return albums().then(function (albs) {
              return json({
                albums: albs.map(function (a) {
                  return nc.assign(a, { on: sel.indexOf(a.id) >= 0 });
                }),
              });
            });
          }
          if (u === '/api/immich/sync') {
            sync();
            return json({ ok: true });
          }
          if (u === '/api/immich/photos') {
            var hid = icfg().hidden;
            return json({
              photos: Object.keys(idx().immich).map(function (id) {
                return { id: id, hidden: hid.indexOf(id) >= 0 };
              }),
            });
          }
          if (u === '/api/immich/hide') {
            var id = String(b.id || '');
            if (!ASSET.test(id)) return json({ error: 'bad id' }, 400);
            setCfg(function (w) {
              var ic = nc.assign({ hidden: [] }, w.immich);
              ic.hidden = ic.hidden.filter(function (x) {
                return x !== id;
              });
              if (b.hidden) ic.hidden.push(id);
              w.immich = ic;
            });
            return json({ ok: true });
          }
          if (u === '/api/immich/disconnect') {
            disconnect();
            return json({ ok: true });
          }
          return json({ error: 'not found' }, 404);
        });
      })
      .then(null, function (e) {
        return json({ error: String(e.message || e) }, 400);
      });
  }

  // ---- the service's API ----
  function handle(req, res, u, body) {
    function json(o, c) {
      return web.json(res, o, c);
    }
    var m = /^\/api\/wallpapers\/photo\/([ui])\/([0-9a-f-]{16,36})$/i.exec(u);
    if (m) return sendPhoto(res, m[1], m[2]);
    if (u === '/api/wallpapers/status') return json(status());
    if (u === '/api/wallpapers/list') return json({ photos: list(), stamp: stamp() });
    if (req.method !== 'POST') return web.notFound(res);
    return body(req).then(function (b) {
      if (u === '/api/wallpapers/set') {
        if (b.size === '4k' || b.size === 'hd')
          setCfg(function (w) {
            w.size = b.size;
          });
        return json(status());
      }
      if (u === '/api/wallpapers/pair') {
        if (b.stop) {
          stopPair();
          return json({});
        }
        return startPair().then(function (r) {
          return json(r);
        });
      }
      if (u === '/api/wallpapers/sync') {
        sync();
        return json(status());
      }
      if (u === '/api/wallpapers/remove-uploads') {
        removeUploads();
        return json(status());
      }
      if (u === '/api/wallpapers/disconnect') {
        disconnect();
        return json(status());
      }
      return web.notFound(res);
    });
  }

  // the automatic sync: every six hours; shortly after a start only when the last one is more than a day old
  function start() {
    if (idx().sync.state === 'syncing') idx().sync.state = 'idle'; // a sync the last run did not finish
    var t = setInterval(function () {
      sync();
    }, SYNC_MS);
    if (t.unref) t.unref();
    if (Date.now() - (idx().sync.ok || 0) > 24 * 3600 * 1000) {
      var t2 = setTimeout(
        function () {
          sync();
        },
        15 * 60 * 1000
      );
      if (t2.unref) t2.unref();
    }
  }

  return {
    name: 'wallpapers',
    prefix: '/api/wallpapers/',
    handle: handle,
    start: start,
    status: status,
    stamp: stamp,
    sync: sync,
    addUpload: addUpload,
    list: list,
    phone: phone,
  };
}

// the phone page: two actions, Upload photos and Configure Immich. Plain script for iOS Safari and Android Chrome; photos are scaled in
// the browser (to 3840 or 1920 pixels on the long side) before they are sent, which also turns an iPhone's HEIC into JPEG. It is in the
// phone's language: the fixed text is translated here, the script's own texts by t() with the translations it uses (i18n.js).
var PHONE_JS = [
  "var code='',S={},MAX=3840,$=function(i){return document.getElementById(i)};",
  "/* a text with its %s / %d filled in, in order, then in the page's language (a template's plural form follows the number) */",
  'function fm(s){var a=arguments,n=1;return t(s.replace(/%[sd]/g,function(){return a[n++]}))}',
  "function api(p,b,ct){return new Promise(function(ok,no){var x=new XMLHttpRequest();x.open(b===undefined?'GET':'POST','/api/'+p);x.setRequestHeader('x-code',code);",
  " if(ct)x.setRequestHeader('content-type',ct);x.onload=function(){var j={};try{j=JSON.parse(x.responseText)}catch(e){}if(x.status===403){showLogin(t('Wrong code.'));no(j)}else ok(j)};x.onerror=function(){no({error:t('The TV did not answer. Is the phone on the same Wi-Fi?')})};",
  ' x.send(b===undefined?null:(ct?b:JSON.stringify(b)))})}',
  "function msg(t,e){$('msg').innerHTML=t?'<p class=\"m'+(e?' e':'')+'\"></p>':'';if(t)$('msg').firstChild.textContent=t}",
  "function showLogin(t){$('login').className='';$('main').className='hide';$('sum').textContent=t||''}",
  "function ago(x){if(!x)return t('never');var m=Math.round((Date.now()-x)/60000);return m<1?t('just now'):m<60?fm('%d min ago',m):m<1440?fm('%d h ago',Math.round(m/60)):fm('%d days ago',Math.round(m/1440))}",
  "function state(){return api('state').then(function(s){S=s;MAX=s.size==='hd'?1920:3840;$('login').className='hide';$('main').className='';",
  " $('sum').textContent=fm('Local uploads: %d · Immich: %d · Total: %d photos (%d of 150 MB)',s.uploads,s.immich.photos,s.total,Math.round(s.bytes/1048576));",
  " $('un').textContent=fm('%d of %d',s.uploads,s.limits.uploads);var g='';(s.uploadsList||[]).forEach(function(id){g+='<div class=ph><img loading=lazy src=\"\" data-s=\"u/'+id+'\"><button data-d=\"'+id+'\">×</button></div>'});$('ug').innerHTML=g;thumbs($('ug'));",
  " var i=s.immich;$('iu').value=$('iu').value||i.url;$('ik').placeholder=i.keyHint?fm('API key (saved: %s; leave empty to keep)',i.keyHint):t('API key');",
  " $('ist').innerHTML='';var p=document.createElement('p');p.textContent=i.configured?(i.state==='syncing'?fm('Syncing… %d new',i.done):fm('Last sync: %s',ago(i.lastSync))+' · '+fm('%d photos from %d albums',i.photos,i.albums))+(i.error?' · '+t(i.error):''):t('Not connected.');$('ist').appendChild(p);",
  " $('isy').className=$('idc').className=i.configured?'':'hide';if(i.state==='syncing')setTimeout(state,3000)})}",
  "function thumbs(el){[].forEach.call(el.querySelectorAll('img[data-s]'),function(im){var x=new XMLHttpRequest();x.open('GET','/api/photo/'+im.getAttribute('data-s'));x.setRequestHeader('x-code',code);x.responseType='blob';",
  ' x.onload=function(){if(x.status===200)im.src=URL.createObjectURL(x.response)};x.send()})}',
  '/* scale in the browser: the long side to MAX pixels, JPEG; a file the browser cannot draw is sent as it is when it is small enough */',
  'function scaled(file){return new Promise(function(ok){var u=URL.createObjectURL(file),im=new Image();im.onload=function(){var w=im.naturalWidth,h=im.naturalHeight,k=Math.min(1,MAX/Math.max(w,h));',
  " var c=document.createElement('canvas');c.width=Math.round(w*k);c.height=Math.round(h*k);c.getContext('2d').drawImage(im,0,0,c.width,c.height);URL.revokeObjectURL(u);c.toBlob(function(b){ok(b||file)},'image/jpeg',0.9)};",
  ' im.onerror=function(){URL.revokeObjectURL(u);ok(file)};im.src=u})}',
  "function upload(files){var list=[].slice.call(files),n=0,okN=0,errs=[];$('prog').className='';msg('');",
  " (function next(){if(n>=list.length){$('prog').className='hide';msg(fm('%d of %d photos uploaded.',okN,list.length)+(errs.length?' '+errs[0]:''),!!errs.length&&!okN);state();return}",
  "  var f=list[n];$('pt').textContent=fm('Photo %d of %d · preparing',n+1,list.length);$('pb').style.width=Math.round(n/list.length*100)+'%';",
  "  scaled(f).then(function(b){var x=new XMLHttpRequest();x.open('POST','/api/upload');x.setRequestHeader('x-code',code);x.setRequestHeader('content-type',b.type||'application/octet-stream');",
  "   x.upload.onprogress=function(e){if(e.lengthComputable)$('pb').style.width=Math.round((n+e.loaded/e.total)/list.length*100)+'%';$('pt').textContent=fm('Photo %d of %d · sending',n+1,list.length)};",
  "   x.onload=function(){var j={};try{j=JSON.parse(x.responseText)}catch(e){}if(x.status===200)okN++;else errs.push((f.name||t('A photo'))+': '+t(j.error||'refused'));n++;next()};",
  "   x.onerror=function(){errs.push(t('The TV did not answer.'));n++;next()};x.send(b)})})()}",
  "$('f').onchange=function(){if(this.files.length)upload(this.files);this.value=''};",
  "$('ug').onclick=function(e){var d=e.target.getAttribute('data-d');if(d)api('upload/delete',{id:d}).then(state)};",
  "$('tu').onclick=function(){$('tu').className='on';$('ti').className='';$('up').className='';$('im').className='hide'};",
  "$('ti').onclick=function(){$('ti').className='on';$('tu').className='';$('im').className='';$('up').className='hide';if(S.immich&&S.immich.configured){loadAlbums();loadPhotos()}};",
  "function loadAlbums(){api('immich/albums',{}).then(function(r){if(r.error)return msg(t(r.error),1);var h='';(r.albums||[]).forEach(function(a){h+='<label class=al><input type=checkbox value=\"'+a.id+'\"'+(a.on?' checked':'')+'><span></span><small>'+a.count+'</small></label>'});",
  " $('al').innerHTML=h;var sp=$('al').querySelectorAll('span');(r.albums||[]).forEach(function(a,i){sp[i].textContent=a.name});$('albox').className=''},function(e){msg(e.error||t('Could not read the albums'),1)})}",
  "function loadPhotos(){api('immich/photos',{}).then(function(r){var ps=r.photos||[];$('iphb').className=ps.length?'':'hide';var g='';ps.forEach(function(p){g+='<div class=\"ph'+(p.hidden?' off':'')+'\" data-h=\"'+p.id+'\"><img loading=lazy src=\"\" data-s=\"i/'+p.id+'\"></div>'});$('ipg').innerHTML=g;thumbs($('ipg'))})}",
  "$('ipg').onclick=function(e){var t=e.target.closest('[data-h]');if(!t)return;var off=!/off/.test(t.className);api('immich/hide',{id:t.getAttribute('data-h'),hidden:off}).then(function(){t.className='ph'+(off?' off':'');state()})};",
  "$('ic').onclick=function(){msg(t('Connecting…'));api('immich/connect',{url:$('iu').value,key:$('ik').value}).then(function(r){if(r.error)return msg(t(r.error),1);$('ik').value='';msg(t('Connected to Immich.'));state().then(loadAlbums)})};",
  "$('as').onclick=function(){var ids=[].map.call($('al').querySelectorAll('input:checked'),function(i){return i.value});api('immich/albums',{ids:ids}).then(function(){msg(t('Albums saved. Syncing…'));setTimeout(state,1500);setTimeout(loadPhotos,8000)})};",
  "$('isy').onclick=function(){api('immich/sync',{}).then(function(){msg(t('Syncing…'));setTimeout(state,1500)})};",
  "$('idc').onclick=function(){if(confirm(t('Disconnect Immich? Its photos are removed from the TV.')))api('immich/disconnect',{}).then(function(){$('albox').className='hide';$('iphb').className='hide';msg(t('Immich disconnected.'));state()})};",
  "$('go').onclick=function(){code=$('code').value.trim();state().catch(function(){})};",
  "code=(location.hash||'').slice(1);if(/^\\d{6}$/.test(code))state().catch(function(){});else showLogin();",
  '',
].join('\n');

function phonePage(lang) {
  function T(s) {
    return web.esc(i18n.tr(lang, s));
  }
  return (
    '<!doctype html><html lang=' +
    lang +
    '><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Wallpapers</title>\n' +
    '<style>*{box-sizing:border-box}body{font:17px -apple-system,system-ui,sans-serif;background:#0d0e12;color:#eee;margin:0;padding:20px 16px 60px;max-width:640px;margin:0 auto}\n' +
    'h1{font-size:26px;margin:4px 0 4px}h2{font-size:20px;margin:28px 0 10px}p{color:#aaa;margin:6px 0}.m{padding:12px 14px;border-radius:12px;background:#1d2a1f;margin:12px 0}.m.e{background:#3a1717}\n' +
    'button,input,label.b{font:inherit;display:block;width:100%;padding:14px;border-radius:12px;border:1px solid #333;background:#1a1b21;color:#eee;margin:8px 0;text-align:center}\n' +
    'button.p,label.b{background:#f5f6f8;color:#111;font-weight:600;border:0}input{text-align:left}.row{display:flex;gap:10px}.row>*{flex:1}\n' +
    '.tabs{display:flex;gap:8px;margin:16px 0}.tabs button{margin:0}.tabs .on{background:#f5f6f8;color:#111}.hide{display:none}\n' +
    '.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.ph{position:relative;aspect-ratio:16/9;border-radius:10px;overflow:hidden;background:#222}\n' +
    '.ph img{width:100%;height:100%;object-fit:cover;display:block}.ph button{position:absolute;right:4px;top:4px;width:32px;height:32px;padding:0;margin:0;border-radius:16px;background:rgba(0,0,0,.7);border:0;color:#fff}\n' +
    '.ph.off img{opacity:.3}.al{display:flex;align-items:center;gap:12px;padding:12px;border-radius:12px;background:#1a1b21;margin:6px 0}.al input{width:22px;height:22px;margin:0}\n' +
    '.bar{height:8px;border-radius:4px;background:#333;overflow:hidden;margin:8px 0}.bar i{display:block;height:100%;width:0;background:#f5f6f8}small{color:#888}</style>\n' +
    '<h1>Wallpapers</h1><p id=sum>' +
    T('Connecting to the TV…') +
    '</p>\n' +
    '<div id=login class=hide><p>' +
    T('Enter the code shown on the TV.') +
    '</p><input id=code inputmode=numeric autocomplete=one-time-code><button class=p id=go>' +
    T('Continue') +
    '</button></div>\n' +
    '<div id=main class=hide>\n' +
    '<div class=tabs><button id=tu class=on>' +
    T('Upload photos') +
    '</button><button id=ti>' +
    T('Configure Immich') +
    '</button></div>\n' +
    '<div id=msg></div>\n' +
    '<section id=up><label class=b for=f>' +
    T('Choose photos') +
    '</label><input id=f type=file accept="image/*" multiple class=hide>\n' +
    '<div id=prog class=hide><div class=bar><i id=pb></i></div><p id=pt></p></div>\n' +
    '<h2>' +
    T('Uploaded') +
    ' <small id=un></small></h2><div class=grid id=ug></div></section>\n' +
    '<section id=im class=hide>\n' +
    '<p>' +
    T('Use an API key from Immich (Account settings > API keys) with album.read and asset.read/view permissions.') +
    '</p>\n' +
    '<input id=iu type=url placeholder="https://immich.example.com" autocomplete=off><input id=ik type=password placeholder="' +
    T('API key') +
    '" autocomplete=off>\n' +
    '<button class=p id=ic>' +
    T('Test connection and save') +
    '</button>\n' +
    '<div id=albox class=hide><h2>' +
    T('Albums') +
    '</h2><div id=al></div><button class=p id=as>' +
    T('Save albums and sync') +
    '</button></div>\n' +
    '<div id=ist></div>\n' +
    '<div id=iphb class=hide><h2>' +
    T('Synced photos') +
    ' <small>' +
    T('tap to hide or show one') +
    '</small></h2><div class=grid id=ipg></div></div>\n' +
    '<button id=isy>' +
    T('Sync now') +
    '</button><button id=idc>' +
    T('Disconnect Immich') +
    '</button></section></div>\n' +
    i18n.script(lang, PHONE_JS) +
    '<script>' +
    PHONE_JS +
    '</script></html>'
  );
}

module.exports = { create: create, imageType: imageType, LIMITS: LIMITS, PAIR_PORT: PAIR_PORT };
