#!/bin/bash
# ============================================================================
# YouTube 出口配置：按域名分流到旁路由，**默认网关保持不动**
# ----------------------------------------------------------------------------
# 背景
#   本项目的服务器默认走主路由（负责公网 NAT），而 YouTube 需要走旁路由的
#   透明代理。若直接把默认网关改成旁路由，会导致原有公网回连路径中断
#   （回包出口 IP 与入站路径不一致，TCP 建不起来）。
#
# 原理（旁路由的透明代理**无需凭据**）
#   1. DNS 劫持：用旁路由做 DNS 时，youtube.com 解析为 fake-IP（198.18.x.x）
#   2. 流量引流：fake-IP 段的路由指向旁路由，它据此识别并代理
#
# 因此只需两件事，且**都不影响默认网关**：
#   a. 明细路由  198.18.0.0/15 via <旁路由 IP>
#   b. dnsmasq   YouTube 域名 -> 旁路由 DNS；其余域名 -> 国内 DNS
#
# 用法：BYPASS_GW=<旁路由IP> bash scripts/youtube-exit.sh
# ============================================================================
set -eu

BYPASS_GW="${BYPASS_GW:-}"
FAKE_RANGE=198.18.0.0/15
IFACE="${IFACE:-$(ip route | awk '/default/{print $5; exit}')}"
if [ -z "$BYPASS_GW" ]; then
  echo "用法: BYPASS_GW=<旁路由IP> bash scripts/youtube-exit.sh" >&2
  exit 1
fi
DIRECT_DNS="${DIRECT_DNS:-114.114.114.114}"

echo "==> 网卡: $IFACE / 旁路由: $BYPASS_GW"

# ── 安全闸：默认网关绝不能指向旁路由 ────────────────────────────────────
CUR_GW="$(ip route | awk '/^default/{print $3; exit}')"
echo "==> 当前默认网关: $CUR_GW"
if [ "$CUR_GW" = "$BYPASS_GW" ]; then
  echo "✗ 拒绝执行：默认网关已指向旁路由，这会中断原有公网回连。" >&2
  echo "  请先把默认网关改回主路由再运行。" >&2
  exit 1
fi

# ── a. 明细路由（只影响 fake-IP 段）───────────────────────────────────────
if ip route show | grep -q "$FAKE_RANGE via $BYPASS_GW"; then
  echo "==> 明细路由已存在，跳过"
else
  sudo ip route add "$FAKE_RANGE" via "$BYPASS_GW" dev "$IFACE"
  echo "==> 已加明细路由: $FAKE_RANGE via $BYPASS_GW"
fi

# ── b. 分流 DNS ───────────────────────────────────────────────────────────
if [ -f /etc/dnsmasq.d/youtube-split.conf ]; then
  echo "==> dnsmasq 分流配置已存在，跳过"
else
  sudo tee /etc/dnsmasq.d/youtube-split.conf >/dev/null <<CONF
# YouTube 域名走旁路由 DNS（返回 fake-IP），其余走国内 DNS（不绕路）。
port=53
listen-address=127.0.0.1
bind-interfaces
no-resolv
no-hosts
cache-size=1000

# → 旁路由
server=/youtube.com/$BYPASS_GW
server=/googlevideo.com/$BYPASS_GW
server=/ytimg.com/$BYPASS_GW
server=/ggpht.com/$BYPASS_GW
server=/youtu.be/$BYPASS_GW
server=/gstatic.com/$BYPASS_GW

# → 国内直连
server=$DIRECT_DNS
CONF
  echo "==> 已写 /etc/dnsmasq.d/youtube-split.conf"
  # 按需停用 systemd-resolved 后启动 dnsmasq，并让 resolv.conf 指向本机
fi

# ── 验证 ────────────────────────────────────────────────────────────────
echo "==> 验证："
FAKE="$(dig +short www.youtube.com A 2>/dev/null | head -1 || true)"
echo "    www.youtube.com => ${FAKE:-解析失败}"
[ -n "${FAKE:-}" ] && echo "    curl youtube  => $(curl -s -m 15 -o /dev/null -w '%{http_code}' https://www.youtube.com/)"
echo "    curl baidu    => $(curl -s -m 15 -o /dev/null -w '%{http_code}' https://www.baidu.com/)  (国内站点，应直连)"
echo "    默认网关       => $(ip route | awk '/^default/{print $3; exit}')  (应保持不变)"
