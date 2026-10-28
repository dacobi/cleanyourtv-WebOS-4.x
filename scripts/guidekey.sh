#!/bin/sh
# Run by the inputhook when the Guide button is pressed (and Live TV is on): open the Live TV channel guide over whatever is running.
export PATH=/usr/bin:/usr/sbin:/bin:/sbin:$PATH
HID=$(cat /tmp/cleanyourtv-home-id 2>/dev/null); [ -n "$HID" ] || HID=com.webos.app.home
# where home-standin.sh stands in for LG's native Home, it takes the parameters from this file (issue 26)
[ -f /tmp/cleanyourtv-home-standin ] && { read -r UP _ < /proc/uptime; echo "$UP {\"live\":true,\"guide\":true}" > /tmp/cleanyourtv-home-params; }
luna-send -n 1 -w 3000 luna://com.webos.applicationManager/launch "{\"id\":\"$HID\",\"params\":{\"live\":true,\"guide\":true}}" </dev/null >/dev/null 2>&1
