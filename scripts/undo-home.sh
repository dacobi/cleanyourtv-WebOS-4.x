#!/bin/sh
# Restore LG's stock Home. "temp": until next reboot only; no arg: also create DISABLE so reboots keep stock Home.
export PATH=/usr/bin:/usr/sbin:/bin:/sbin:$PATH
L=/media/developer/cleanyourtv
[ -f "$L/svc.sh" ] && . "$L/svc.sh" || { [ -f "$(dirname "$0")/svc.sh" ] && . "$(dirname "$0")/svc.sh"; }
[ "$1" = temp ] || touch $L/DISABLE $L/DISABLE-DEBLOAT
HID=$(cat /tmp/cleanyourtv-home-id 2>/dev/null); [ -n "$HID" ] || HID=com.webos.app.home
# our apps must not be what the TV tries to come back to: close them and point the boot's "last app" at LG's Home
for id in com.cleanyourtv.manager com.cleanyourtv.picker com.cleanyourtv.notify; do
  luna-send -n 1 -w 3000 luna://com.webos.applicationManager/closeByAppId "{\"id\":\"$id\"}" </dev/null >/dev/null 2>&1
done
LASTAPP=/var/luna/preferences/bootd_last_foreground_app_id.json
grep -q cleanyourtv $LASTAPP 2>/dev/null && echo "{\"lastAppId\":\"$HID\"}" > $LASTAPP
# LG's own Home needs the ad services the debloat blocks (it fails to start without them), so lift the debloat first
[ -f $L/debloat-undo.sh ] && sh $L/debloat-undo.sh </dev/null >/dev/null 2>&1
# the stand-in way (LG's native Home): unmount it from LG's Home program(s) and close the launcher; sam was never restarted
STANDIN=/tmp/cleanyourtv-home-standin
if [ -f $STANDIN ]; then
  had=0
  while read -r EXE; do
    [ -n "$EXE" ] || continue
    if grep -q " $EXE " /proc/mounts; then
      had=1
      umount "$EXE" 2>/dev/null
      for p in $(pgrep -f "^/bin/sh $EXE"); do kill "$p" 2>/dev/null; done
      echo "$(cut -d' ' -f1 /proc/uptime) undo-home: the stand-in is removed from $EXE" >> /tmp/cleanyourtv-boot.log
    fi
  done < $STANDIN
  rm -f $STANDIN /tmp/cleanyourtv-home-id
  if [ $had = 1 ]; then
    pkill -f "[l]una-send -i -a com.webos.app.home" 2>/dev/null
    pkill -f "[l]una-send -i -a com.webos.app.fullhome" 2>/dev/null
    for id in com.webos.app.home com.webos.app.fullhome; do
      luna-send -n 1 -w 5000 luna://com.palm.webappmanager/killApp "{\"appId\":\"$id\"}" </dev/null >/dev/null 2>&1
    done
    sleep 2
    luna-send -n 1 -w 10000 -f luna://com.webos.applicationManager/launch "{\"id\":\"$HID\"}" </dev/null
    echo "stock Home restored; rm /media/developer/cleanyourtv/DISABLE to re-enable at next boot"
    exit 0
  fi
fi
rm -f /tmp/cleanyourtv-home-id
for m in $(awk '$2 ~ /applications\/com.webos.app.home$/ {print $2}' /proc/mounts | sort -r); do umount $m 2>/dev/null; done
# an airplay child of sam makes the stop wait ~90 s; kill it once the stop has begun
(sleep 3; pkill -9 -f /usr/palm/applications/airplay/LunaExecutable) </dev/null >/dev/null 2>&1 &
svc_restart sam
for i in $(seq 1 60); do svc_active sam && break; sleep 2; done
[ -f $L/after-sam.sh ] && sh $L/after-sam.sh </dev/null
sleep 5
# the old web renderer for Home would keep showing the launcher; retry until the stock flutter Home is up
for t in 1 2 3 4; do
  pkill -f "[a]pp-id=com.webos.app.home"
  sleep 3
  luna-send -n 1 -w 10000 -f luna://com.webos.applicationManager/launch '{"id":"com.webos.app.home"}' </dev/null
  sleep 8
  pgrep -f "[f]lutter-client -i com.webos.app.home" >/dev/null && ! pgrep -f "[a]pp-id=com.webos.app.home" >/dev/null && break
done
echo "stock Home restored; rm /media/developer/cleanyourtv/DISABLE to re-enable at next boot"
