#!/bin/sh
# TDengine 启动前把日志上限和监控写进 taos.cfg，再交给官方入口（/usr/bin/entrypoint.sh）。
#
# 为什么写进 taos.cfg：TAOS_* 环境变量不会写进 taos.cfg，是否被 taosd / taos 客户端直接认没法在每个版本上保证；
# 镜像自带的 taos.cfg 里有构建机留下的 `fqdn buildkitsandbox`、`monitor 1` + `monitorFQDN buildkitsandbox`，
# 健康检查用的 taos 客户端里监控上报死循环刷 "generateClusterReport failed"，一个日志文件涨到 38 GB 写满系统盘。
# 这里：关监控、删掉 monitorFQDN、日志只留 N 天、单个日志文件 N 行后轮转（taosd 和 taos 客户端都按这个）。
set -e
CFG=/etc/taos/taos.cfg
touch "$CFG"
set_kv() {
  if grep -qiE "^[[:space:]]*$1[[:space:]]" "$CFG"; then
    sed -i -E "s|^[[:space:]]*$1[[:space:]].*|$1 $2|I" "$CFG"
  else
    echo "$1 $2" >> "$CFG"
  fi
}
# 镜像自带的 taos.cfg 里 fqdn 也是构建机的 buildkitsandbox：客户端（健康检查）按它连，解析不了就卡住超时（LA18 健康检查 124）。
# 换成本服务的主机名（compose 里 hostname = TAOS_FQDN），firstEp 同步改。
if [ -n "${TAOS_FQDN:-}" ]; then
  set_kv fqdn "$TAOS_FQDN"
  set_kv firstEp "$TAOS_FQDN:6030"
fi
set_kv monitor 0
sed -i -E '/^[[:space:]]*monitorFqdn[[:space:]]/Id' "$CFG"
set_kv logKeepDays "${TAOS_LOG_KEEP_DAYS:-3}"
set_kv numOfLogLines "${TAOS_NUM_OF_LOG_LINES:-1000000}"
exec /usr/bin/entrypoint.sh "$@"
