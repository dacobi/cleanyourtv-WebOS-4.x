#!/bin/sh
# Stop LG telemetry/ad daemons and keep the on-demand ones from starting (RAM-only; a reboot restores them unless run from init.d).
# Four groups, each can be switched off in the manager (options.debloatOff in config.json lists the ones that are off):
#   ads          admanager, adoverlay-service and the ad servers in /etc/hosts
#   tracking     acr2 (viewing tracking, LivePlus)
#   logs         remotelogger, service-logger
#   suggestions  contentminer, nudge, sportsalarm
# sh debloat-stop.sh [group...]: only those groups; without arguments every group that is not switched off.
export PATH=/usr/bin:/usr/sbin:/bin:/sbin:$PATH
L=/media/developer/cleanyourtv
[ -f "$L/svc.sh" ] && . "$L/svc.sh" || { [ -f "$(dirname "$0")/svc.sh" ] && . "$(dirname "$0")/svc.sh"; }
if [ $# -gt 0 ]; then
  G=" $* "
else
  OFF=$(node -e 'try{var o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).options||{};console.log((o.debloatOff||[]).join(" "))}catch(e){}' $L/config.json 2>/dev/null)
  G=" "
  for g in ads tracking logs suggestions; do case " $OFF " in *" $g "*) ;; *) G="$G$g " ;; esac; done
fi
on() { case "$G" in *" $1 "*) return 0 ;; esac; return 1; }
units=""; bins=""
on logs && units="$units remotelogger service-logger"
on suggestions && { units="$units contentminer nudge"; bins="$bins sportsalarm"; }
on tracking && bins="$bins acr2"
on ads && bins="$bins admanager adoverlay-service"
# non-blocking: contentminer can take a minute to stop, which held up the rest of the script (and the manager waiting for it)
for s in $units; do svc_stop_bg "$s" | sed "s/^/$s: /"; done
# luna dynamic services (and Upstart jobs like admanager on webOS 4.x): bind a do-nothing stub over the binary so ls-hubd cannot start them
printf '#!/bin/sh\nexit 0\n' > $L/stub-noop; chmod +x $L/stub-noop
for b in $bins; do
  svc_stop_bg "$b" >/dev/null 2>&1
  [ -e /usr/sbin/$b ] || continue
  grep -q " /usr/sbin/$b " /proc/mounts || mount --bind $L/stub-noop /usr/sbin/$b
  pkill -9 -f "^/usr/sbin/$b"
done
on ads || exit 0
# ad servers (resolved + verified as LG ad endpoints); the marker lets debloat-undo.sh remove them
add_hosts() {
  cat <<'H'
127.0.0.1 eic.ads.lgtvcommon.com nl.ad.lgsmartad.com nl.info.lgsmartad.com # cleanyourtv-debloat
::1 eic.ads.lgtvcommon.com nl.ad.lgsmartad.com nl.info.lgsmartad.com # cleanyourtv-debloat
H
}
if ! grep -q "# cleanyourtv-debloat" /etc/hosts; then
  if [ -w /etc/hosts ] && add_hosts >> /etc/hosts 2>/dev/null; then
    :
  else
    # on some TVs /etc/hosts is on the read-only system partition (issue 11): a copy in RAM is mounted over it until the next restart
    cp /etc/hosts /tmp/cleanyourtv-hosts && add_hosts >> /tmp/cleanyourtv-hosts && mount --bind /tmp/cleanyourtv-hosts /etc/hosts && touch /tmp/cleanyourtv-hosts.mounted \
      || echo "hosts: /etc/hosts cannot be changed on this TV; the ad servers are not blocked"
  fi
fi
