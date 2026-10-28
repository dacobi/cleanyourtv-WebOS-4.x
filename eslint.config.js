// Lint rules (node tools/lint.js). The service runs on Node 0.12 (webOS 4) and Node 8 (webOS 5 and 6), the pages on Chromium 53+: the
// rules catch mistakes a test may not reach, such as ES2015+ syntax in the service or a name that is used but never defined.
const globals = require('globals');

const mistakes = {
  'no-undef': 'error',
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
  'no-dupe-keys': 'error',
  'no-unreachable': 'error',
  'no-redeclare': 'error',
  'no-self-assign': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
};

// Node 0.12.2 (V8 3.28 on webOS 4) has ES5 + Promise + TypedArrays, without ES2015 collections or WHATWG URL globals.
const node012Globals = Object.assign({}, globals.node, {
  Promise: 'readonly',
  Set: 'off',
  Map: 'off',
  WeakSet: 'off',
  WeakMap: 'off',
  Symbol: 'off',
  Proxy: 'off',
  Reflect: 'off',
  URL: 'off',
  URLSearchParams: 'off',
  TextEncoder: 'off',
  TextDecoder: 'off',
  AbortController: 'off',
  AbortSignal: 'off',
  fetch: 'off',
  globalThis: 'off',
  queueMicrotask: 'off',
  structuredClone: 'off',
});

module.exports = [
  {
    files: ['helper/*.js', 'scripts/jtool.js', 'tools/test-node012.js'],
    languageOptions: { ecmaVersion: 5, sourceType: 'commonjs', globals: node012Globals },
    rules: mistakes,
  },
  {
    files: ['tools/**/*.js'],
    ignores: ['tools/vendor/**', 'tools/test-node012.js'],
    languageOptions: { ecmaVersion: 2018, sourceType: 'commonjs', globals: Object.assign({}, globals.node) },
    rules: mistakes,
  },
  {
    // the scripts of the built pages, given to ESLint by tools/lint.js
    files: ['**/*.page.js'],
    languageOptions: {
      ecmaVersion: 5,
      sourceType: 'script',
      // what Chromium 53+ has beyond ES5 (Promise, Intl) and what webOS adds
      globals: Object.assign({}, globals.browser, {
        Promise: 'readonly',
        Intl: 'readonly',
        webOS: 'readonly',
        webOSSystem: 'readonly',
        PalmSystem: 'readonly',
        PalmServiceBridge: 'readonly',
        qrcode: 'readonly',
      }),
    },
    // a page's functions are called from its markup and from each other across the files it is built from
    rules: Object.assign({}, mistakes, { 'no-unused-vars': 'off' }),
  },
];
