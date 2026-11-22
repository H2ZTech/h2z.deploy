#!/bin/sh
# 装 / 更新板子看门狗（2026-11-02 负责人确认），可以重复跑：
#   sudo sh host/install-watchdog.sh
# - host/watchdog.sh → /usr/local/lib/h2z/watchdog.sh，systemd 每分钟跑（h2z-watchdog.timer）
# - /etc/h2z/watchdog.env 记部署目录（看门狗用 docker compose --project-directory 只动本项目）
# - 硬件看门狗：systemd RuntimeWatchdogSec=60（系统本身死机才重启；断网不会触发）。没有 /dev/watchdog（虚拟机）时 systemd 自动跳过；
#   NAS 系统（飞牛等）自己管硬件看门狗，不改
# 测试：H2Z_INSTALL_ROOT=临时目录（所有系统路径加这个前缀，不检查 root）——scripts/install-watchdog.test.mjs
set -eu
R=${H2Z_INSTALL_ROOT:-}
[ -n "$R" ] || [ "$(id -u)" = 0 ] || { echo "要 root：sudo sh $0" >&2; exit 1; }
REPO=$(cd "$(dirname "$0")/.." && pwd)
STATE="$R/var/lib/h2z/watchdog"
install -d -m 755 "$R/usr/local/lib/h2z" "$R/etc/h2z" "$STATE" "$R/etc/systemd/system" "$R/etc/systemd/system.conf.d"
install -m 755 "$REPO/host/watchdog.sh" "$R/usr/local/lib/h2z/watchdog.sh"
# 更新脚本（普通用户、在 docker 组里）要能写暂停文件：状态目录给 docker 组写
if getent group docker >/dev/null 2>&1; then chgrp docker "$STATE" && chmod 2775 "$STATE"; fi
printf "H2Z_DIR='%s'\n" "$REPO" > "$R/etc/h2z/watchdog.env"
# setup-host-network.sh 会把 host/systemd/ 下的单元 systemctl link 成指向仓库的符号链接（含看门狗）：已经是同一个文件就不用再装
# （install 对同一个文件会报错退出，2026-11-11 LA18 旁挂机器补宿主时踩到）
for u in h2z-watchdog.service h2z-watchdog.timer; do
  [ "$REPO/host/systemd/$u" -ef "$R/etc/systemd/system/$u" ] || install -m 644 "$REPO/host/systemd/$u" "$R/etc/systemd/system/$u"
done
# NAS 系统（飞牛 / TrueNAS / 群晖…）自己管硬件看门狗：不改（和 storage-agent 认托管模式的标志一样）
nas=""
for m in /usr/trim /etc/synoinfo.conf /etc/unraid-version /usr/share/openmediavault /etc/default/truenas; do
  if [ -e "$R$m" ]; then nas=$m; fi
done
if grep -qiE 'fnos|truenas|unraid|openmediavault|synology' "$R/etc/os-release" 2>/dev/null; then nas=${nas:-os-release}; fi
case "$(uname -r)" in *-trim) nas=${nas:-kernel} ;; esac
if [ -z "$nas" ]; then
  cat > "$R/etc/systemd/system.conf.d/h2z-watchdog.conf" <<'CONF'
# H2Z：硬件看门狗。系统本身死机（内核 / systemd 卡住）60 秒没喂狗就重启；关机重启卡住 10 分钟强制重启
[Manager]
RuntimeWatchdogSec=60
RebootWatchdogSec=10min
CONF
fi
systemctl daemon-reload
if [ -z "$nas" ]; then systemctl daemon-reexec; fi   # 让 RuntimeWatchdogSec 生效（不重启服务）
systemctl enable --now h2z-watchdog.timer >/dev/null
systemctl start h2z-watchdog.service || true
if [ -n "$nas" ]; then
  hw="没改（NAS 系统自己管，$nas）"
elif [ -e "$R/dev/watchdog" ] || [ -e "$R/dev/watchdog0" ]; then
  hw="$(systemctl show -p RuntimeWatchdogUSec --value 2>/dev/null || echo 已设置)"
else
  hw="没有（虚拟机或没有驱动，systemd 跳过）"
fi
echo "看门狗：$(systemctl is-active h2z-watchdog.timer 2>/dev/null || echo 未知)；硬件看门狗：$hw；状态：/var/lib/h2z/watchdog/status.json"
