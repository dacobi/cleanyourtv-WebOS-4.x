#!/bin/sh
# System service control across webOS versions:
#   webOS 5 and newer: systemd (systemctl)
#   webOS 4.x:         Upstart (/sbin/initctl, /etc/init/<job>.conf)
# Sourced by the setup, Home takeover and debloat scripts. CYTV_TEST_ROOT lets tools/test/ exercise Upstart without root.

svc_has_systemd() {
  [ "${CYTV_INIT:-}" != upstart ] && command -v systemctl >/dev/null 2>&1
}

svc_upstart_job() {
  case "$1" in
    webapp-mgr) echo WebAppMgr ;;
    preload-manager) echo webos-preload-manager ;;
    *) echo "$1" ;;
  esac
}

svc_has() {
  if svc_has_systemd; then
    systemctl cat "$1.service" >/dev/null 2>&1
  else
    [ -f "${CYTV_TEST_ROOT:-}/etc/init/$(svc_upstart_job "$1").conf" ]
  fi
}

svc_active() {
  if svc_has_systemd; then
    systemctl is-active "$1" >/dev/null 2>&1
  else
    initctl status "$(svc_upstart_job "$1")" 2>/dev/null | grep -q 'start/running'
  fi
}

svc_state() {
  if svc_has_systemd; then
    systemctl is-active "$1" 2>/dev/null
  elif svc_active "$1"; then
    echo active
  else
    echo inactive
  fi
}

svc_restart() {
  if svc_has_systemd; then
    systemctl restart "$1"
  else
    _j=$(svc_upstart_job "$1")
    initctl restart "$_j" >/dev/null 2>&1 || initctl start "$_j" >/dev/null 2>&1
  fi
}

svc_start_bg() {
  if svc_has_systemd; then
    systemctl --no-block start "$1.service"
  elif svc_has "$1"; then
    initctl start --no-wait "$(svc_upstart_job "$1")" >/dev/null 2>&1 || true
  fi
}

svc_stop_bg() {
  if svc_has_systemd; then
    systemctl --no-block stop "$1.service"
  elif svc_has "$1"; then
    initctl stop --no-wait "$(svc_upstart_job "$1")" 2>&1 || true
  fi
}

svc_list() {
  if svc_has_systemd; then
    systemctl list-units --no-legend
  elif command -v initctl >/dev/null 2>&1; then
    initctl list
  fi
}
