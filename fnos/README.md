# fnOS package (fpk) for the B line

A thin wrapper. It has no compose logic of its own: the first start runs the B-line `install.sh`, later starts run `docker compose up -d`
in `/opt/h2z.security`. Host network, host disks, host-agent and storage-agent behave exactly as in the B line.

## What the user sees
- Install: preflight dialog if something is missing (root, Docker, free space, ports 8096/18099, internet).
- Open the app icon: progress page on `:18099` (stage, progress bar, live log tail, FAILED + reason). When the stack answers, it redirects to `http://<nas-ip>:8096/ioc/`.
- Uninstall: wizard switch "also delete all data". Off (default) = containers, watchdog, tunnel removed, data kept. On = `uninstall.sh --purge`.
  Recordings under `/srv/h2z` are never deleted. Log: `/var/log/h2z-uninstall.log`.
- Files on the NAS: `/var/apps/com.h2ztech.security/var/web/{status.json,install.log,tail.txt}`.

## Build (Windows)
`powershell -File fnos\build.ps1` builds inside WSL (the Windows fnpack loses the exec bit of cmd/*). Output: `fnos/dist/com.h2ztech.security.fpk`.
Linux: `sh fnos/build.sh`. Needs the official fnpack 1.2.3, downloaded automatically from static2.fnnas.com.

## Unverified on a real fnOS (test list)
1. Preflight dialog text appears when Docker is missing (install_init writes `$TRIM_TEMP_LOGFILE`).
2. The app starts by itself after install (install_callback calls `main start`).
3. Desktop icon opens `:18099`, then redirects to `:8096/ioc/`.
4. Uninstall wizard shows, and `wizard_delete_data` reaches the callback (check `/var/log/h2z-uninstall.log`).
5. Camera search on the LAN works; the storage page must not offer fnOS data disks.
