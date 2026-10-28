#!/bin/sh
# Reload the page of Home. Where the Home renderer can be found (webOS 7 and newer) it is killed and Home is launched
# again. On webOS 4 to 6 (Node before 10) WebAppMgr keeps the replaced page alive and a relaunch only brings the old page back, so
# in mount mode webapp-mgr is restarted. Other versions are never restarted this way.
export PATH=/usr/bin:/usr/sbin:/bin:/sbin:$PATH
L=/media/developer/cleanyourtv
[ -f "$L/svc.sh" ] && . "$L/svc.sh" || { [ -f "$(dirname "$0")/svc.sh" ] && . "$(dirname "$0")/svc.sh"; }
HID=$(cat /tmp/cleanyourtv-home-id 2>/dev/null); [ -n "$HID" ] || HID=com.webos.app.home
# The stand-in way (LG's native Home, scripts/home-standin.sh): webapp-mgr holds the launcher; close it there, and launching Home
# makes the stand-in open it again.
STANDIN=/tmp/cleanyourtv-home-standin
if [ -f $STANDIN ]; then
  mounted=0
  while read -r p; do [ -n "$p" ] && grep -q " $p " /proc/mounts && { mounted=1; break; }; done < $STANDIN
  if [ $mounted = 1 ]; then
    luna-send -n 1 -w 5000 luna://com.palm.webappmanager/killApp "{\"appId\":\"$HID\"}" </dev/null >/dev/null 2>&1
    sleep 2
    luna-send -n 1 -w 10000 -f luna://com.webos.applicationManager/launch "{\"id\":\"$HID\"}" </dev/null >/dev/null
    exit 0
  fi
fi
if pgrep -f "[a]pp-id=$HID" >/dev/null; then
  pkill -f "[a]pp-id=$HID"; sleep 2
else
  nm=$(node -p 'parseInt(process.versions.node, 10)' 2>/dev/null)
  if [ "${nm:-99}" -lt 10 ] && svc_has webapp-mgr; then
    svc_restart webapp-mgr
    for i in $(seq 1 30); do svc_active webapp-mgr && break; sleep 1; done
    sleep 3
  fi
fi
luna-send -n 1 -w 10000 -f luna://com.webos.applicationManager/launch "{\"id\":\"$HID\"}" </dev/null >/dev/null
