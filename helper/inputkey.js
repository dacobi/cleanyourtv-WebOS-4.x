// The remote's Input key (and the learned Voice and Guide keys): keeps the hook in LG's input processes and the key binds up to date
// (inputhook.js), keeps the Inputs picker ready where that works (picker.js), closes the picker when it asks, and writes the mode
// that scripts/inputkey.sh follows. GET /api/log?m=... is the picker's and the overlay apps' small diagnostics channel.
var fs = require('fs');
var P = require('./paths'),
  web = require('./web'),
  picker = require('./picker');

var PICKER = 'com.cleanyourtv.picker';

function create(ctx) {
  var config = ctx.config,
    luna = ctx.luna,
    profile = ctx.profile;
  var inputhook = ctx.inputhook || require('./inputhook');
  var pickerShownAt = 0;

  function keyCode() {
    return String(config.keys().input || '241');
  }
  // the voice key belongs to us only while voice is installed and on; the Guide key only while Live TV is on and a key was learned
  function voiceKey() {
    var v = config.get().voice || {};
    var voice = ctx.feature('voice');
    return v.enabled && voice && voice.installed() ? String(config.keys().voice || '') : '';
  }
  function guideKey() {
    return config.options().liveTv !== false ? String(config.keys().guide || '') : '';
  }
  // overlay, ondemand or launcher: the manager's choice, else this TV's default (tvprofile.js)
  function mode() {
    return picker.modeOf(config.get().picker || {}, profile.get().pickerMode);
  }
  // with the launcher's list as the target, CleanYourTV has to be the Home: while LG's Home is chosen the key stays with LG
  function on() {
    return config.options().inputKey && !(mode() === 'launcher' && fs.existsSync(P.DISABLE));
  }
  function syncMode() {
    try {
      fs.writeFileSync(P.PICKER_MODE, mode() + '\n');
    } catch (_) {}
  }
  function ensure() {
    return inputhook.ensure(on(), keyCode());
  }

  // the on-demand picker asks to be closed when it is dismissed. Closing from the page does nothing on some builds, so the app
  // manager does it: closeByAppId works on webOS 6, plain close is the fallback
  function closePicker() {
    return luna('luna://com.webos.applicationManager/closeByAppId', { id: PICKER }).then(function (a) {
      if (a.returnValue === true) return;
      return luna('luna://com.webos.applicationManager/close', { id: PICKER }).then(function (b) {
        if (b.returnValue !== true)
          console.error(
            'picker: could not close it (' + (a.errorText || 'closeByAppId failed') + '; ' + (b.errorText || 'close failed') + ')'
          );
      });
    });
  }

  function handle(req, res) {
    var m = decodeURIComponent(String(req.url || '').split('m=')[1] || '');
    if (/picker show/.test(m)) pickerShownAt = Date.now();
    if (/picker close/.test(m)) setTimeout(closePicker, 400);
    var up = '';
    try {
      up = fs.readFileSync(P.PROC + '/uptime', 'utf8').split(' ')[0];
    } catch (_) {}
    console.log(up + ' ' + m.slice(0, 300));
    web.json(res, {});
  }

  function start() {
    if (inputhook.setVoiceKey) inputhook.setVoiceKey(voiceKey);
    if (inputhook.setGuideKey) inputhook.setGuideKey(guideKey);
    syncMode();
    // bind the key and keep the hook in LG's input processes (they restart now and then)
    setTimeout(ensure, 500);
    setInterval(ensure, 30000);
    // a hidden picker is only kept while the hook attached: without it the key cannot open the picker, which would only hold the remote
    function hookAttached() {
      try {
        return !!(inputhook.hookInfo && inputhook.hookInfo().attached);
      } catch (_) {
        return false;
      }
    }
    picker.start(
      luna,
      function () {
        return config.options().inputKey && mode() === 'overlay' && hookAttached();
      },
      {
        get: function () {
          return config.get().picker || {};
        },
        set: function (v) {
          config.update('picker', function (c) {
            c.picker = v;
          });
          syncMode();
        },
      }
    );
  }

  return {
    name: 'inputkey',
    paths: ['/api/log'],
    handle: handle,
    start: start,
    // for the manager
    mode: mode,
    on: on,
    syncMode: syncMode,
    ensure: ensure,
    pickerShownAt: function () {
      return pickerShownAt;
    },
    keyCode: keyCode,
  };
}

module.exports = { create: create };
