#!/bin/sh
# Stands in for LG's Home program on TVs where LG's Home is the native app (tvprofile.js homeTakeover 'standin'). 10-cleanyourtv-home
# bind-mounts this file over that program (and com.webos.app.fullhome when present), so the app manager (SAM) keeps LG's Home manifest
# and starts this script whenever Home is launched; it does not have to be restarted (issues 14, 23 and 24). The script asks webapp-mgr
# to open the launcher and stays running. It also tries to register with SAM under the launched Home app id: then the Home key sends it
# a "relaunch" and the launcher is shown again; without registration SAM restarts this script on the Home key, which shows the launcher
# the same way. Every step is written to /tmp/cleanyourtv-boot.log, which Share log includes.
export PATH=/usr/bin:/usr/sbin:/bin:/sbin:$PATH
L=/media/developer/cleanyourtv
LOG=/tmp/cleanyourtv-boot.log
up() { cut -d' ' -f1 /proc/uptime; }
log() { echo "$(up) home-standin[$$]: $*" >> $LOG 2>/dev/null; }

case "${0##*/}" in
  com.webos.app.*) APP_ID="${0##*/}" ;;
  *) APP_ID=$(cat /tmp/cleanyourtv-home-id 2>/dev/null); [ -n "$APP_ID" ] || APP_ID=com.webos.app.home ;;
esac

# a previous copy that SAM killed leaves its registration and reader behind
for p in $(pgrep -f "^/bin/sh $0"); do [ "$p" != $$ ] && kill "$p" 2>/dev/null; done
pkill -f "[l]una-send -i -a $APP_ID" 2>/dev/null

# The parameters of a Home launch ({live, guide} from guidekey.sh, {inputs} from inputkey.sh) are passed on to the launcher (issue 26).
# The key scripts leave them in $PARAMS with the time ("<uptime> <json>"), so they arrive even if what the app manager sends is read
# wrong; otherwise they are taken from the app manager's relaunch event or this script's start argument ($1).
PARAMS=/tmp/cleanyourtv-home-params
params() {  # $1: start or relaunch, $2: the start argument or the relaunch event
  if [ -f $PARAMS ]; then
    read -r t p < $PARAMS
    rm -f $PARAMS
    read -r now _ < /proc/uptime
    [ -n "$p" ] && [ $((${now%.*} - ${t%.*})) -le 10 ] && { echo "$p"; return; }
  fi
  p=$(echo "$2" | sed -n 's/.*"parameters": *\({[^{}]*}\).*/\1/p')
  [ -z "$p" ] && [ "$1" = start ] && case "$2" in '{'*'}') p=$2 ;; esac
  [ -n "$p" ] || p='{}'
  echo "$p"
}

show() {
  p=$(params "$1" "$2")
  # home_launcher.sh preloads Home at boot with {"activateType":"preload"}; do not cover an HDMI input or app already in foreground
  case "$p" in
    *'"activateType"'*'"preload"'*)
      fg=$(luna-send -n 1 -w 3000 -f luna://com.webos.applicationManager/getForegroundAppInfo '{}' </dev/null 2>/dev/null | grep '"appId"')
      case "$fg" in
        *'"appId": ""'*|*com.webos.app.home*|*com.webos.app.fullhome*|"") ;;
        *) log "preload while $(echo "$fg" | tr -d ' \n') is in foreground; waiting for Home key"; return 0 ;;
      esac ;;
  esac
  k='"parameters":{}'
  for f in $L/wam-launch.json $L/wam-launch.json.str; do
    [ -f $f ] || continue
    req=$(cat $f)
    case "$req" in *"$k"*) req="${req%%"$k"*}\"parameters\":$p${req#*"$k"}" ;; esac
    r=$(luna-send -n 1 -w 8000 luna://com.palm.webappmanager/launchApp "$req" </dev/null 2>&1 | tr -d '\n')
    if echo "$r" | grep -q '"returnValue": *true'; then log "launcher shown ($1, $APP_ID) with $(echo "$p" | cut -c1-120)"; return 0; fi
    log "webapp-mgr refused ${f##*/}: $(echo "$r" | cut -c1-200)"
  done
  return 1
}

log "started ($APP_ID) as uid $(id -u), arguments: $(echo "$*" | cut -c1-200)"
show start "$1"

# the registration: SAM's events arrive one JSON line each
for m in registerApp registerNativeApp; do
  luna-send -i -a "$APP_ID" "luna://com.webos.applicationManager/$m" '{}' </dev/null 2>&1 | while read -r line; do
    case "$line" in
      *'"event"'*relaunch*) show relaunch "$line" ;;
      *'"event"'*close*) log "closed by the app manager ($APP_ID)"; kill $$ 2>/dev/null; exit 0 ;;
      *'"event"'*registered*) log "registered with the app manager ($m as $APP_ID)" ;;
      *'"returnValue"'*false*) log "$m ($APP_ID) refused: $(echo "$line" | cut -c1-200)" ;;
    esac
  done
  log "$m ($APP_ID) ended"
done

log "running without registration ($APP_ID): the app manager restarts this script on the Home key"
while :; do sleep 60; done
