// Answers for the voice function (voice.js): Home Assistant's Assist, a language model through OpenRouter, and a server of yours. Text
// goes in, text comes out; the settings are the voice section of config.json (voice.js passes them in with init).
var fetch = require('./fetch'),
  nc = require('./netcompat'),
  URL = nc.URL;

var cfg = function () {
  return /** @type {any} */ ({});
};
function init(f) {
  cfg = f;
}

// POST JSON; resolves {status, text}. Redirects are not followed.
function request(url, headers, payload, ms, extra) {
  return fetch
    .read(url, {
      method: payload === undefined ? 'GET' : 'POST', // no payload: a GET
      headers: headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
      idleMs: ms || 30000,
      redirects: 0,
      anyStatus: true,
      maxBytes: 1 << 20,
      bigText: 'the answer is too large',
      insecure: !!(extra && extra.rejectUnauthorized === false),
    })
    .then(
      function (r) {
        return { status: r.status, text: r.body.toString('utf8') };
      },
      function (e) {
        if (e.code === 'timeout') throw new Error('no answer in time');
        if (e.code === 'url')
          throw new Error(/http/.test(e.message) ? 'the address must start with http:// or https://' : 'the address is not valid');
        throw e;
      }
    );
}
// a server of yours: POST {"text": ...}; the answer may be JSON ({"text", "title", "image", "seconds"}) or plain text
function toServer(c, payload) {
  return request(c.url, c.token ? { authorization: 'Bearer ' + c.token } : {}, payload, 30000).then(function (r) {
    if (r.status < 200 || r.status >= 300) throw new Error('your server answered ' + r.status);
    var o = null;
    try {
      o = JSON.parse(r.text);
    } catch (_) {}
    if (o && typeof o === 'object') {
      var text = String(o.text || o.reply || o.answer || o.message || '').trim();
      return text || o.image ? { title: o.title ? String(o.title) : '', text: text, image: o.image, seconds: o.seconds } : null;
    }
    var t = r.text.trim();
    return t ? { text: t } : null;
  });
}

// ---- chat with a language model through OpenRouter (text only; the key and the questions go to OpenRouter) ----
function orApi() {
  return process.env.CYTV_OPENROUTER || 'https://openrouter.ai/api/v1'; // overridden only by the tests
}
var LLM_DEFAULTS = { enabled: false, key: '', model: 'openrouter/auto', system: '' };
function llmCfg() {
  return nc.assign({}, LLM_DEFAULTS, cfg().llm || {});
}
var DEFAULT_SYSTEM =
  'You are a voice assistant on a television. You have no tools and no internet access: answer from your own knowledge, and say when something may be out of date. The user speaks to you through the remote control and your answer appears as text on the screen, so keep it short: one to three plain sentences, no markdown, no lists, no emoji. If the speech looks like a recognition mistake, answer what was most likely meant.';
/** @type {Array<{role: string, content: string}>} */
var history = [],
  lastTurn = 0;
var TOOLISH = /<\|?\s*(?:tool|function|python_tag)|<tool_call|\[TOOL_CALL|<function_call/i; // a model that tries to call a tool instead of answering
function cleanAnswer(t) {
  var x = String(t || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  var m = TOOLISH.exec(x);
  if (m) x = x.slice(0, m.index);
  return x
    .replace(/<\|[^|>]*\|>/g, '')
    .replace(/\s+\n/g, '\n')
    .trim();
}
function askLlm(text) {
  var l = llmCfg();
  if (!l.key) return Promise.reject(new Error('no OpenRouter key is set'));
  if (Date.now() - lastTurn > 600000) history = []; // a new conversation after ten quiet minutes
  var turns = history.concat({ role: 'user', content: text }).slice(-12);
  var system = (l.system || DEFAULT_SYSTEM) + ' Today is ' + new Date().toISOString().slice(0, 10) + '.';
  var answer = '',
    tool = false;
  function tryOnce(attempt) {
    if (attempt >= 2 || answer) return Promise.resolve();
    var messages = [
      {
        role: 'system',
        content:
          system +
          (attempt
            ? ' You have no tools and cannot search the internet: never call a tool. Answer in plain text from what you know, and say so if it may be out of date.'
            : ''),
      },
    ].concat(turns);
    return request(
      orApi() + '/chat/completions',
      { authorization: 'Bearer ' + l.key, 'HTTP-Referer': 'https://github.com/lasharor/cleanyourtv-WebOS', 'X-Title': 'CleanYourTV' },
      { model: l.model, messages: messages, max_tokens: 500, reasoning: { exclude: true } },
      60000
    ).then(function (r) {
      /** @type {any} */
      var o = {};
      try {
        o = JSON.parse(r.text);
      } catch (_) {}
      if (r.status !== 200 || o.error)
        throw new Error('OpenRouter: ' + String((o.error && (o.error.message || o.error.code)) || 'HTTP ' + r.status).slice(0, 160));
      var msg = (o.choices && o.choices[0] && o.choices[0].message) || {},
        raw = String(msg.content || '');
      tool = tool || TOOLISH.test(raw) || !!(msg.tool_calls && msg.tool_calls.length);
      answer = cleanAnswer(raw);
      if (tool && !attempt) answer = ''; // retry once, telling the model it has no tools
      return tryOnce(attempt + 1);
    });
  }
  return tryOnce(0).then(function () {
    if (!answer)
      throw new Error(
        tool ? 'The model tried to use a tool instead of answering. Choose another model.' : 'OpenRouter returned an empty answer'
      );
    history = turns.concat({ role: 'assistant', content: answer });
    lastTurn = Date.now();
    return answer;
  });
}

// ---- Home Assistant: the Assist (conversation) API with a long-lived access token ----
var HA_DEFAULTS = { url: '', token: '', selfSigned: false, route: 'ha-first', agent: '' };
var HA_ROUTES = ['ha-first', 'ha-only', 'ai-only'];
function haCfg() {
  return nc.assign({}, HA_DEFAULTS, cfg().ha || {});
}
function haReady(h) {
  return !!(h.url && h.token);
}
/** @type {{id: string, at: number}|null} */
var haConv = null; // { id, at }: Assist keeps the context of a conversation; a new one starts after ten quiet minutes
// the address without credentials, query or trailing slash; '' when it is not an http(s) address
function haBase(t) {
  var u;
  try {
    u = new URL(String(t).trim());
  } catch (_) {
    return '';
  }
  return u.protocol === 'http:' || u.protocol === 'https:' ? u.protocol + '//' + u.host + u.pathname.replace(/\/+$/, '') : '';
}
// Assist asks for the same text twice only if it did not understand: error code no_intent_match
function haCall(h, path, payload, ms) {
  return request(
    h.url + path,
    { authorization: 'Bearer ' + h.token },
    payload,
    ms || 30000,
    h.selfSigned && /^https:/.test(h.url) ? { rejectUnauthorized: false } : {}
  ).then(function (r) {
    if (r.status === 401 || r.status === 403) throw new Error('Home Assistant refused the access token');
    if (r.status === 404) throw new Error('that does not look like Home Assistant (' + path + ' was not found)');
    if (r.status < 200 || r.status >= 300) throw new Error('Home Assistant answered ' + r.status);
    try {
      return JSON.parse(r.text);
    } catch (_) {
      throw new Error('Home Assistant did not answer with JSON');
    }
  });
}
function askHa(text) {
  var h = haCfg();
  if (!haReady(h)) return Promise.reject(new Error('Home Assistant is not set up'));
  if (haConv && Date.now() - haConv.at > 600000) haConv = null;
  /** @type {Record<string, any>} */
  var body = { text: text, language: 'en' };
  if (haConv) body.conversation_id = haConv.id;
  if (h.agent) body.agent_id = h.agent;
  return haCall(h, '/api/conversation/process', body, 30000).then(function (o) {
    var res = (o && o.response) || {};
    var type = String(res.response_type || ''),
      code = String((res.data && res.data.code) || '');
    var speech = String((res.speech && res.speech.plain && res.speech.plain.speech) || '').trim();
    if (o.conversation_id) haConv = { id: String(o.conversation_id), at: Date.now() };
    return {
      text: speech || (type === 'action_done' ? 'Done' : ''),
      understood: !(type === 'error' && code === 'no_intent_match'),
      type: type,
      code: code,
    };
  });
}
function haTest() {
  var h = haCfg();
  if (!haReady(h)) return Promise.reject(new Error('set the Home Assistant address and token first'));
  return haCall(h, '/api/config', undefined, 10000).then(function (c) {
    return { name: String(c.location_name || ''), version: String(c.version || '') };
  });
}
// conversation agents show up as conversation.* entities
function haAgents() {
  var h = haCfg();
  if (!haReady(h)) return Promise.reject(new Error('set the Home Assistant address and token first'));
  return haCall(h, '/api/states', undefined, 20000).then(function (all) {
    return (Array.isArray(all) ? all : [])
      .filter(function (e) {
        return e && /^conversation\.[\w]+$/.test(e.entity_id || '');
      })
      .map(function (e) {
        return { id: e.entity_id, name: String((e.attributes && e.attributes.friendly_name) || e.entity_id).slice(0, 80) };
      });
  });
}

// ---- models of OpenRouter: a short list for the TV, everything for the phone ----
/** @type {any} */
var modelCache = null;
var MAJOR = ['anthropic', 'openai', 'google', 'meta-llama', 'mistralai', 'deepseek', 'qwen', 'x-ai'];
function models() {
  if (modelCache && Date.now() - modelCache.at < 3600000) return Promise.resolve(modelCache);
  return fetch
    .read(orApi() + '/models', {
      headers: { 'User-Agent': 'cleanyourtv-voice' },
      idleMs: 15000,
      maxBytes: 8 << 20,
      bigText: 'the model list is too large',
      statusText: function (st) {
        return 'OpenRouter answered ' + st;
      },
    })
    .then(null, function (e) {
      throw e.code === 'timeout' ? new Error('OpenRouter did not answer') : e;
    })
    .then(function (r) {
      var all;
      try {
        all = JSON.parse(r.body.toString('utf8'))
          .data.filter(function (m) {
            return (
              m &&
              /^[\w.\-:\/~]{1,100}$/.test(m.id || '') &&
              !(
                m.architecture &&
                Array.isArray(m.architecture.output_modalities) &&
                m.architecture.output_modalities.some(function (x) {
                  return x !== 'text';
                })
              )
            );
          })
          .map(function (m) {
            return {
              id: m.id,
              name: String(m.name || m.id).slice(0, 80),
              created: m.created || 0,
              price: m.pricing && +m.pricing.prompt >= 0 ? Math.round(+m.pricing.prompt * 1e8) / 100 : null, // dollars per million input tokens
            };
          });
      } catch (e) {
        throw new Error('the model list could not be read');
      }
      var picks = [],
        /** @type {Record<string, number>} */
        seen = {},
        byDate = all.slice().sort(function (a, b) {
          return b.created - a.created;
        });
      for (var i = 0; i < byDate.length; i++) {
        var m = byDate[i];
        var prov = m.id.split('/')[0];
        if (m.id.indexOf(':') >= 0 || MAJOR.indexOf(prov) < 0) continue;
        if ((seen[prov] = (seen[prov] || 0) + 1) <= 3) picks.push(m);
      }
      return (modelCache = {
        at: Date.now(),
        all: all.sort(function (a, b) {
          return a.id.localeCompare(b.id);
        }),
        picks: picks,
      });
    });
}

// a new conversation: forget what was said to the model and Assist's conversation
function forget() {
  history = [];
  haConv = null;
}
function forgetHa() {
  haConv = null;
}

module.exports = {
  init: init,
  toServer: toServer,
  askLlm: askLlm,
  askHa: askHa,
  haTest: haTest,
  haAgents: haAgents,
  models: models,
  forget: forget,
  forgetHa: forgetHa,
  haBase: haBase,
  haReady: haReady,
  llmCfg: llmCfg,
  haCfg: haCfg,
  LLM_DEFAULTS: LLM_DEFAULTS,
  HA_DEFAULTS: HA_DEFAULTS,
  HA_ROUTES: HA_ROUTES,
};
