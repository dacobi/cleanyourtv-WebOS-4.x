# Debloat

An optional clean-up of LG's ads and telemetry. It is on by default in the setup; the [manager app](manager.md) has a **Debloat**
screen with its four groups.

## What it does

About a minute after every boot, the debloat:

| Group | What it does |
|---|---|
| **Ads** | Prevents `admanager` and `adoverlay-service` from starting, and adds `eic.ads.lgtvcommon.com`, `nl.ad.lgsmartad.com` and `nl.info.lgsmartad.com` to `/etc/hosts`, pointing at `127.0.0.1` and `::1` and marked `# cleanyourtv-debloat` (other entries are untouched). |
| **Viewing tracking (LivePlus)** | Prevents `acr2` from starting: it recognises what is on screen and reports it. |
| **Telemetry logs** | Stops the systemd or Upstart services `remotelogger` and `service-logger`. |
| **Suggestions and nudges** | Stops `contentminer` and `nudge`, and prevents `sportsalarm` from starting. |

A program is prevented from starting by mounting a do-nothing stub over it (in RAM; the real files are not changed). Where
`/etc/hosts` is on the read-only system partition, a copy with the ad lines is kept in RAM (`/tmp/cleanyourtv-hosts`) and mounted
over it until the next restart. Each group can be switched on or off on its own; the ones that are off are listed in
`options.debloatOff` in `config.json`.

Nothing is uninstalled. It applies only while the launcher is Home, because LG's own Home needs some of those services to start;
switching back to LG's Home lifts the debloat first.

## Turning it off

Switch a group off in the manager app (**Debloat**), or **Switch all off**. It starts that group's services again, unmounts its stubs
and, for **Ads**, removes the marked hosts lines. Switching the last group off switches the debloat off. To pause it without the manager, create `/media/developer/cleanyourtv/DISABLE-DEBLOAT`.

## What it does not do

It does not block updates: firmware update blocking (for example with the Homebrew Channel's tools) is separate and is not touched.
It does not claim to remove all tracking. It stops the services listed above and nothing else.
