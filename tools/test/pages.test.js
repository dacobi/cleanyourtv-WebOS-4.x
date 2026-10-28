// The pages that run on the TV (launcher, manager, picker, notification card): nothing newer than Chromium 68 (webOS 5), and fixes that
// must not come back.
const fs = require('fs'),
  path = require('path');
const { root, ok, run } = require('./lib');

run(async () => {
  const pages = ['app', 'manager/app', 'picker/app', 'notify/app'].map(d => path.join(root, d, 'index.html'));
  const rules = [
    [/\?\?|\?\.[A-Za-z_\[(]/, 'optional chaining or ??'],
    [/\|\|=|&&=/, 'logical assignment'],
    [
      /\.(flat|flatMap|matchAll|replaceAll|findLast)\(|\.at\(-?\d|\bObject\.fromEntries\b|\bPromise\.(allSettled|any)\b|\bglobalThis\b|\bstructuredClone\b|\bAbortSignal\.timeout\b/,
      'a function newer than Chromium 68',
    ],
    [
      /\baspect-ratio\s*:|:is\(|:where\(|:has\(|\binset\s*:|:focus-visible|\bcontainer-type|color-mix\(|\b\d+d?v?[sd]vh\b|@layer\b|\bplace-(items|content|self)\s*:|\b(overscroll|scroll)-behavior\s*:/,
      'CSS newer than Chromium 53 / 68',
    ],
  ];
  const bad = [];
  for (const f of pages)
    fs.readFileSync(f, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        for (const r of rules) if (r[0].test(line)) bad.push(path.relative(root, f) + ':' + (i + 1) + ' ' + r[1]);
      });
  ok(!bad.length, 'the pages use nothing newer than Chromium 68' + (bad.length ? ':\n  ' + bad.join('\n  ') : ''));
  // the scripts must be ES5: Chromium 68 knows most of ES2015, but a slip there is a page that stays blank on webOS 5 only
  const acorn = require(path.join(root, 'tools', 'vendor', 'acorn.js'));
  for (const f of pages) {
    const html = fs.readFileSync(f, 'utf8'),
      re = /<script>([\s\S]*?)<\/script>/g;
    let m,
      err = '';
    while ((m = re.exec(html))) {
      try {
        acorn.parse(m[1], { ecmaVersion: 5 });
      } catch (e) {
        err = e.message;
      }
    }
    ok(!err, 'the script of ' + path.relative(root, f) + ' is ES5' + (err ? ': ' + err : ''));
  }
  // flex "gap" is ignored before Chromium 84, and the script that once added the spacing after each redraw made lists jump and left old
  // text behind on webOS 5 (issues 4, 8, 13): flex children are spaced with sibling margins
  const gapBad = [];
  for (const f of pages) {
    const t = fs.readFileSync(f, 'utf8'),
      re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(t))) {
      if (/display:\s*(inline-)?flex/.test(m[2]) && /(^|[;\s])(row-|column-)?gap\s*:/.test(m[2]))
        gapBad.push(path.relative(root, f) + ': ' + m[1].trim().split('\n').pop());
    }
  }
  ok(!gapBad.length, 'no flex container uses gap (a sibling margin instead)' + (gapBad.length ? ':\n  ' + gapBad.join('\n  ') : ''));
  ok(
    !fs.existsSync(path.join(root, 'shared', 'flexgap.js')) && !/flexgap/.test(fs.readFileSync(path.join(root, 'ipk', 'build.py'), 'utf8')),
    'no script adds the spacing after a redraw'
  );
  ok(
    !/\.tile\.f\s*\{[^}]*outline/.test(fs.readFileSync(path.join(root, 'app', 'index.html'), 'utf8')) &&
      /\.tile\.f::before\s*\{[^}]*border-radius:/.test(fs.readFileSync(path.join(root, 'app', 'index.html'), 'utf8')) &&
      /\.tile\.fill\.f\s*\{\s*box-shadow:\s*0 0 0 var\(--ring-w\)/.test(fs.readFileSync(path.join(root, 'app', 'index.html'), 'utf8')),
    'the focus ring has its own rounded corners (an outline is a rectangle before Chromium 94), also on tiles that crop their picture'
  );
  const built = require(path.join(root, 'tools', 'build-pages.js'));
  for (const p of built.PAGES)
    ok(
      built.build(p[0]) === fs.readFileSync(path.join(root, p[1]), 'utf8'),
      p[1] + ' is built from ' + p[0] + ' (run: node tools/build-pages.js)'
    );
  // a long device name (HDMI-CEC) is the second line of a chip in the Inputs picker: the line could not shrink, so it was painted outside the
  // card, over the next ones (issue 19). It wraps onto a second line now, ends in an ellipsis there when that is not enough, and the card
  // reserves the two lines so every card's icon and port sit at the same height.
  const pickerPage = fs.readFileSync(path.join(root, 'picker', 'app', 'index.html'), 'utf8'),
    cssRule = (css, sel) => (css.match(new RegExp(sel.replace(/\./g, '\\.') + '\\s*\\{([^}]*)\\}')) || [])[1] || '',
    chipSt = cssRule(pickerPage, '.chip .st'),
    chipTx = cssRule(pickerPage, '.chip .tx');
  ok(
    /-webkit-line-clamp:\s*2/.test(chipSt) &&
      /overflow:\s*hidden/.test(chipSt) &&
      /min-height:\s*2\.4em/.test(chipSt) &&
      !/white-space:\s*nowrap/.test(chipSt) &&
      /text-align:\s*center/.test(chipSt) &&
      /width:\s*100%/.test(chipTx) &&
      /overflow:\s*hidden/.test(cssRule(pickerPage, '.chip')),
    'a long input name stays inside its card in the Inputs picker, on two lines'
  );
  // the favourite star and the menus' right-hand text both had the class st: the star's width squeezed the menu text into a column
  const launcher = fs.readFileSync(path.join(root, 'app', 'index.html'), 'utf8');
  ok(
    !/(^|\n)\s*\.st\s*\{/.test(launcher) && /svg\.st\s*\{\s*width:\s*26px/.test(launcher),
    "the favourite star is styled as svg.st, so the menu's .st text keeps its natural width"
  );
  // Chromium 53 (webOS 4.x) lacks CSS Grid, max() and Intl hourCycle: check that the fallbacks stay in place
  ok(
    /#grid\s*\{[^}]*display:\s*flex/.test(launcher) && /@supports\s*\(display:\s*grid\)/.test(launcher),
    'the launcher grid has a Flexbox fallback for Chromium 53 (webOS 4) before @supports (display: grid)'
  );
  ok(
    /o\.hour12\s*=\s*false/.test(launcher) && /o\.hour12\s*=\s*true/.test(launcher),
    'the clock passes hour12 alongside hourCycle for Chromium 53 (webOS 4)'
  );
  ok(
    /min-width:\s*200px;\s*min-width:\s*max\(200px,\s*fit-content\)/.test(pickerPage),
    'the Inputs picker keeps a min-width: 200px fallback before max() for Chromium 53 (webOS 4)'
  );
  // Outside @supports (...), no style block may rely on CSS Grid, gap, 8-digit hex alpha, calc() inside rgba(), or <time> inside calc()
  function stripSupports(css) {
    let out = '',
      i = 0;
    while (i < css.length) {
      const at = css.indexOf('@supports', i);
      if (at < 0) {
        out += css.slice(i);
        break;
      }
      out += css.slice(i, at);
      const open = css.indexOf('{', at);
      if (open < 0) break;
      let depth = 1,
        j = open + 1;
      while (j < css.length && depth > 0) {
        if (css[j] === '{') depth++;
        else if (css[j] === '}') depth--;
        j++;
      }
      i = j;
    }
    return out;
  }
  const c53Bad = [];
  for (const f of pages) {
    const html = fs.readFileSync(f, 'utf8'),
      rel = path.relative(root, f),
      re = /<style>([\s\S]*?)<\/style>/g;
    let m;
    while ((m = re.exec(html))) {
      if (/#[0-9a-fA-F]{8}\b/.test(m[1])) c53Bad.push(rel + ': 8-digit hex colour (#rrggbbaa needs Chrome 62+)');
      if (/\b(min|clamp)\s*\(/.test(m[1])) c53Bad.push(rel + ': CSS min()/clamp() (needs Chrome 79+)');
      const base = stripSupports(m[1]).replace(/\/\*[\s\S]*?\*\//g, '');
      if (/display:\s*(inline-)?grid\b/.test(base)) c53Bad.push(rel + ': display: grid outside @supports');
      if (/(^|[{;\s])(grid-|row-|column-)?gap\s*:/.test(base)) c53Bad.push(rel + ': gap outside @supports');
      if (/rgba?\([^)]*calc\(/.test(base)) c53Bad.push(rel + ': calc() inside rgb()/rgba() outside @supports');
      if (/transition(-duration)?\s*:[^;}]*calc\(/.test(base)) c53Bad.push(rel + ': calc() in transition duration outside @supports');
    }
  }
  ok(
    !c53Bad.length,
    'all <style> blocks keep a valid Chromium 53 base outside @supports' + (c53Bad.length ? ':\n  ' + c53Bad.join('\n  ') : '')
  );
  // webOS 4 exposes window.PalmSystem without window.webOSSystem: every page must fall back to PalmSystem and never call bare webOSSystem.*
  const wosBad = [];
  for (const f of pages) {
    const html = fs.readFileSync(f, 'utf8'),
      rel = path.relative(root, f),
      scripts = (html.match(/<script>[\s\S]*?<\/script>/g) || []).join('\n');
    if (/\bwebOSSystem\s*[.[]/.test(scripts)) wosBad.push(rel + ': bare webOSSystem property access without PalmSystem fallback');
    if (!/window\.PalmSystem\b/.test(scripts)) wosBad.push(rel + ': missing window.PalmSystem fallback');
  }
  ok(
    !wosBad.length,
    'every page falls back from window.webOSSystem to window.PalmSystem (webOS 4)' + (wosBad.length ? ': ' + wosBad.join('; ') : '')
  );
});
