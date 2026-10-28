#!/bin/sh
# Build the directory that gets bind-mounted over LG's Home (or opened by WebAppMgr in stand-in mode): the launcher page plus an
# appinfo.json derived from this TV's own stock Home (nothing of LG's is shipped in the repo). Safe to re-run while mounted.
export PATH=/usr/bin:/usr/sbin:/bin:/sbin:$PATH
R=${CYTV_TEST_ROOT:-}
L=$R/media/developer/cleanyourtv
S=$L/home-overlay
mkdir -p $S $L/backup $R/tmp
cp $L/app/* $S/
[ -f $R/usr/palm/applications/com.webos.app.fullhome/appinfo.json ] && [ ! -f "$L/backup/fullhome-appinfo.orig.json" ] && \
  cp $R/usr/palm/applications/com.webos.app.fullhome/appinfo.json "$L/backup/fullhome-appinfo.orig.json" 2>/dev/null

method="$1"
if [ -z "$method" ]; then
  method=$(node $L/tvprofile.js get homeTakeover --home "$(node $L/jtool.js kind "$L/backup/home-appinfo.orig.json" 2>/dev/null)" 2>/dev/null)
  [ "$(cat $L/home-method 2>/dev/null)" = mount ] && method=mount
fi

HID=com.webos.app.home
ORIG="$L/backup/home-appinfo.orig.json"
if [ "$method" = standin ] && [ -f "$L/backup/fullhome-appinfo.orig.json" ]; then
  DEF=$(luna-send -n 1 -w 3000 luna://com.webos.settingsservice/getSystemSettings '{"category":"general","keys":["defaultApps"]}' </dev/null 2>/dev/null | tr -d '\n')
  HID=$(node $L/jtool.js homeid "$DEF" $R/etc/palm/defaultSettings.json "$L/backup/fullhome-appinfo.orig.json" 2>/dev/null)
  [ -n "$HID" ] || HID=com.webos.app.home
  [ "$HID" = com.webos.app.fullhome ] && ORIG="$L/backup/fullhome-appinfo.orig.json"
fi
echo "$HID" > $R/tmp/cleanyourtv-home-id
node $L/jtool.js stage "$ORIG" "$S/appinfo.json"
# what scripts/home-standin.sh sends to webapp-mgr where LG's Home is the native program (homeTakeover 'standin')
node $L/jtool.js wamlaunch "$S/appinfo.json" "$S" "$L/wam-launch.json"
