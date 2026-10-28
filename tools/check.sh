#!/bin/sh
# Every check before a push or a release, in one command:
#   sh tools/check.sh
# 0. the Node 0.12 smoke and HTTP integration test (tools/test-node012.js) under Node.js 0.12.2, the version on webOS 4.x (downloaded
#    once on Linux x64 and macOS, checksum verified, cached in ~/.cache/cleanyourtv);
# 1. the tests (tools/test.js) under Node.js 8.12.0, the version on webOS 5 and 6 (downloaded once from nodejs.org, checksum
#    verified, cached in ~/.cache/cleanyourtv; on an Apple-silicon Mac the x64 build runs through Rosetta);
# 2. the same tests under the Node.js of this computer, when it is a different version;
# 3. the pages built from their sources are up to date (tools/build-pages.js --check), and the translations in i18n/ (tools/i18n.js:
#    how complete each language is; it fails only on a broken file);
#    types, lint and formatting (tools/lint.js), when the development tools are installed (npm install);
# 4. with --chromium: the pages in Chromium 68 and 79, the engines of webOS 5 and 6 (tools/oldchrome.js, about 200 MB downloaded once).
# Nothing is installed and nothing leaves this machine, apart from the cached Node downloads.
set -e
cd "$(dirname "$0")/.."
C="${XDG_CACHE_HOME:-$HOME/.cache}/cleanyourtv"
P012=""; H012=""
case "$(uname -s)-$(uname -m)" in
  Darwin-*)               P=darwin-x64;   H=ca131b84dfcf2b6f653a6521d31f7a108ad7d83f4d7e781945b2eca8172064aa
                          P012=darwin-x64; H012=7d382f8988ea441e2918d9d935003177affd13d4d160020df6b3d8ee7d65ec2d ;;
  Linux-x86_64)           P=linux-x64;    H=3df19b748ee2b6dfe3a03448ebc6186a3a86aeab557018d77a0f7f3314594ef6
                          P012=linux-x64;  H012=4e1578efc2a2cc67651413a05ccc4c5d43f6b4329c599901c556f24d93cd0508 ;;
  Linux-aarch64|Linux-arm64) P=linux-arm64; H=781ecf1ecb14b4c671ef0732988636282d6fb7071c4bd52567f663b008796bc9 ;;
  Linux-armv7l)           P=linux-armv7l; H=9c564069c5c9f0c9062cb399db02670c79fc4a2a079e67edcc5785a73a663f6e ;;
  *) echo "no Node 8.12.0 build known for $(uname -sm)"; exit 1 ;;
esac
if [ -n "$P012" ]; then
  N012="$C/node-v0.12.2-$P012/bin/node"
  if [ ! -x "$N012" ]; then
    mkdir -p "$C"; T=$(mktemp -d)
    curl -fsSL "https://nodejs.org/dist/v0.12.2/node-v0.12.2-$P012.tar.gz" -o "$T/n.tgz"
    G=$( (sha256sum "$T/n.tgz" 2>/dev/null || shasum -a 256 "$T/n.tgz") | cut -d' ' -f1)
    [ "$G" = "$H012" ] || { echo "checksum mismatch for the Node 0.12.2 download"; rm -rf "$T"; exit 1; }
    tar -xzf "$T/n.tgz" -C "$C"; rm -rf "$T"
  fi
  echo "== smoke & HTTP tests on Node $("$N012" --version) (webOS 4.x)"
  "$N012" tools/test-node012.js
  echo
fi
N8="$C/node-v8.12.0-$P/bin/node"
if [ ! -x "$N8" ]; then
  mkdir -p "$C"; T=$(mktemp -d)
  curl -fsSL "https://nodejs.org/dist/v8.12.0/node-v8.12.0-$P.tar.gz" -o "$T/n.tgz"
  G=$( (sha256sum "$T/n.tgz" 2>/dev/null || shasum -a 256 "$T/n.tgz") | cut -d' ' -f1)
  [ "$G" = "$H" ] || { echo "checksum mismatch for the Node 8.12.0 download"; rm -rf "$T"; exit 1; }
  tar -xzf "$T/n.tgz" -C "$C"; rm -rf "$T"
fi
echo "== tests on Node $("$N8" --version) (webOS 5 and 6)"
"$N8" tools/test.js --quiet
if command -v node >/dev/null && [ "$(node --version)" != "$("$N8" --version)" ]; then
  echo; echo "== tests on Node $(node --version)"
  node tools/test.js --quiet
fi
if [ -f tools/build-pages.js ]; then
  echo; echo "== pages"
  "$N8" tools/build-pages.js --check
fi
if [ -f tools/i18n.js ]; then
  echo; echo "== translations"
  "$N8" tools/i18n.js
fi
if command -v node >/dev/null; then
  echo; echo "== types, lint, formatting"
  node tools/lint.js
fi
if [ "$1" = "--chromium" ]; then
  echo; echo "== pages in old Chromium"
  "$N8" tools/oldchrome.js ${CYTV_SHOTS:+--shots "$CYTV_SHOTS"}
fi
echo; echo "all checks passed"
