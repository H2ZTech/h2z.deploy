#!/bin/sh
# 把仓库里的本地显示脚本（HDMI 检测、Chrome 看门狗）装到系统目录——随 `git pull` / scripts/update.sh 自动生效，不用手动装。
#   sudo sh host/install-kiosk.sh        可以重复跑：文件没变就什么都不做
# 谁来跑：host-agent 启动时和每 10 分钟（以 root 在宿主机上）；scripts/update.sh 重建 host-agent 后马上会跑一次。
# 只在有本地显示的机器上动作（H2Z OS x86：已有 /usr/local/bin/h2z-kiosk-session）；Orange Pi、NAS、普通 Linux 没有就静默跳过。
# 只换脚本，不碰 /etc/h2z/kiosk.env（现场改过的设置保留；新增设置的缺省值写在脚本里，不靠这个文件）。
# 文件变了才重启本地画面（几秒闪一下）；没人登录本地屏时不重启。
# 测试：H2Z_INSTALL_ROOT=临时目录（所有系统路径加这个前缀，不检查 root、不动 systemd）——scripts/install-kiosk.test.mjs
set -eu
R=${H2Z_INSTALL_ROOT:-}
[ -n "$R" ] || [ "$(id -u)" = 0 ] || { echo "要 root：sudo sh $0" >&2; exit 1; }
REPO=$(cd "$(dirname "$0")/.." && pwd)
SRC="$REPO/os/x86/rootfs-system/usr/local/bin"
# C 形态（h2z.backend 版 H2Z OS，栈在 docker2/ 下）的脚本在 os2/x86：本机的 h2z-os-stack 认 docker2 就是 C。
# 不分形态一律装 os/x86 会把整包升级带来的 C 版 kiosk 脚本（白屏保护、开机文字）换回 B 版，还白白重启一次本地画面（2026-11-07 现场）。
# B 形态（现场客户，os/x86）不变：没有 docker2 就还是装 os/x86。
if grep -q docker2 "$R/usr/local/sbin/h2z-os-stack" 2>/dev/null && [ -d "$REPO/os2/x86/rootfs-system/usr/local/bin" ]; then
  SRC="$REPO/os2/x86/rootfs-system/usr/local/bin"
fi
DST="$R/usr/local/bin"
[ -x "$DST/h2z-kiosk-session" ] || { echo "kiosk: 这台机器没有本地显示，跳过"; exit 0; }
[ -d "$SRC" ] || { echo "kiosk: 仓库里没有 $SRC，跳过"; exit 0; }
changed=""
for f in h2z-kiosk-session h2z-kiosk-browser h2z-kiosk-restart h2z-kiosk-window; do
  [ -f "$SRC/$f" ] || continue
  if ! cmp -s "$SRC/$f" "$DST/$f"; then install -m 755 "$SRC/$f" "$DST/$f"; changed="$changed $f"; fi
done
if [ -z "$changed" ]; then echo "kiosk: 已是最新"; exit 0; fi
if [ -z "$R" ] && systemctl is-active --quiet getty@tty1.service 2>/dev/null; then
  # 新脚本要重启本地画面才用上；用 --no-block，host-agent / update.sh 不等它
  command -v h2z-boot-mark >/dev/null 2>&1 && h2z-boot-mark kiosk-sync "updated$changed restart-getty"
  systemctl restart --no-block getty@tty1.service
  echo "kiosk: 已更新$changed，本地画面重启中"
else
  echo "kiosk: 已更新$changed"
fi
