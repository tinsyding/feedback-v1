#!/usr/bin/env bash
# 幂等安装/更新 feedback-api systemd 服务并验证 /healthz。
#
# 用法（在服务器上以 root 运行）：
#   # 主站生产机（jf，宝塔 www 用户）：
#   sudo bash backend-go/deploy/install_go_service.sh
#
#   # 备用/预发机（jf-backup，Debian www-data 用户 + 自定义根目录）：
#   sudo bash backend-go/deploy/install_go_service.sh \
#     --user www-data --root /www/wwwroot/JF/feedback-git/feedback-v1
#
# 可选参数：
#   --bin <path>          Go 二进制目标路径（默认：/opt/feedback-go/feedback-api）
#   --from <src_bin>      可选：先将本地编译产物原子安装到 --bin 指定路径
#   --user <user>         服务运行用户（默认：www；jf-backup 使用 www-data）
#   --group <group>       服务运行用户组（可选，默认与 --user 相同）
#   --root <dir>          feedback-v1 站点根目录（默认：/www/wwwroot/JF/feedback-git/feedback-v1）
#   --listen <addr>       监听地址（默认：127.0.0.1:8090）
#   --healthz-url <url>   健康探针 URL（默认根据 --listen 自动推导）
#   -h, --help            显示帮助

set -euo pipefail

usage() {
    cat <<'EOF'
用法: sudo bash backend-go/deploy/install_go_service.sh [选项]

选项:
  --bin <path>          Go 二进制路径 (默认: /opt/feedback-go/feedback-api)
  --from <src_bin>      可选: 从源路径原子复制二进制到 --bin
  --user <user>         systemd User (默认: www；jf-backup 使用 www-data)
  --group <group>       systemd Group (默认与 --user 相同)
  --root <dir>          FEEDBACK_ROOT 路径 (默认: /www/wwwroot/JF/feedback-git/feedback-v1)
  --listen <addr>       FEEDBACK_LISTEN_ADDR (默认: 127.0.0.1:8090)
  --healthz-url <url>   健康检查 URL (默认: http://<listen>/healthz)
  -h, --help            显示此帮助信息
EOF
}

BIN_PATH="/opt/feedback-go/feedback-api"
FROM_BIN=""
SERVICE_USER="www"
SERVICE_GROUP=""
FEEDBACK_ROOT="/www/wwwroot/JF/feedback-git/feedback-v1"
LISTEN_ADDR="127.0.0.1:8090"
HEALTHZ_URL=""

while [ "$#" -gt 0 ]; do
    case "$1" in
        --bin)
            [ "$#" -ge 2 ] || { echo "缺少参数值: $1" >&2; exit 1; }
            BIN_PATH="$2"
            shift 2
            ;;
        --bin=*)
            BIN_PATH="${1#*=}"
            shift
            ;;
        --from)
            [ "$#" -ge 2 ] || { echo "缺少参数值: $1" >&2; exit 1; }
            FROM_BIN="$2"
            shift 2
            ;;
        --from=*)
            FROM_BIN="${1#*=}"
            shift
            ;;
        --user)
            [ "$#" -ge 2 ] || { echo "缺少参数值: $1" >&2; exit 1; }
            SERVICE_USER="$2"
            shift 2
            ;;
        --user=*)
            SERVICE_USER="${1#*=}"
            shift
            ;;
        --group)
            [ "$#" -ge 2 ] || { echo "缺少参数值: $1" >&2; exit 1; }
            SERVICE_GROUP="$2"
            shift 2
            ;;
        --group=*)
            SERVICE_GROUP="${1#*=}"
            shift
            ;;
        --root)
            [ "$#" -ge 2 ] || { echo "缺少参数值: $1" >&2; exit 1; }
            FEEDBACK_ROOT="$2"
            shift 2
            ;;
        --root=*)
            FEEDBACK_ROOT="${1#*=}"
            shift
            ;;
        --listen)
            [ "$#" -ge 2 ] || { echo "缺少参数值: $1" >&2; exit 1; }
            LISTEN_ADDR="$2"
            shift 2
            ;;
        --listen=*)
            LISTEN_ADDR="${1#*=}"
            shift
            ;;
        --healthz-url)
            [ "$#" -ge 2 ] || { echo "缺少参数值: $1" >&2; exit 1; }
            HEALTHZ_URL="$2"
            shift 2
            ;;
        --healthz-url=*)
            HEALTHZ_URL="${1#*=}"
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "未知参数: $1" >&2
            usage >&2
            exit 1
            ;;
    esac
done

if [ -z "$SERVICE_GROUP" ]; then
    SERVICE_GROUP="$SERVICE_USER"
fi

if [ "$(id -u)" -ne 0 ]; then
    echo "请用 root 运行此脚本" >&2
    exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
    echo "找不到 systemctl，无法安装 systemd 服务" >&2
    exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
    echo "找不到 curl，无法探测健康检查接口" >&2
    exit 1
fi

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    echo "系统用户不存在：$SERVICE_USER" >&2
    exit 1
fi

if ! getent group "$SERVICE_GROUP" >/dev/null 2>&1; then
    echo "系统用户组不存在：$SERVICE_GROUP" >&2
    exit 1
fi

if [[ "$BIN_PATH" != /* ]]; then
    echo "--bin 必须是绝对路径：$BIN_PATH" >&2
    exit 1
fi

if [[ "$BIN_PATH" == /tmp/* || "$BIN_PATH" == /var/tmp/* ]]; then
    echo "--bin 不能位于 /tmp 或 /var/tmp（unit 启用了 PrivateTmp=true）：$BIN_PATH" >&2
    exit 1
fi

if [ ! -d "$FEEDBACK_ROOT" ]; then
    echo "找不到 FEEDBACK_ROOT 目录：$FEEDBACK_ROOT" >&2
    exit 1
fi
FEEDBACK_ROOT="$(cd "$FEEDBACK_ROOT" && pwd)"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_TEMPLATE="$SCRIPT_DIR/feedback-api.service"
UNIT_TARGET="/etc/systemd/system/feedback-api.service"
ENV_DIR="/etc/feedback-api"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_ROOT="/root/feedback-api-backups/$STAMP"

if [ ! -f "$UNIT_TEMPLATE" ]; then
    echo "找不到 systemd unit 模板：$UNIT_TEMPLATE" >&2
    exit 1
fi

if [ -n "$FROM_BIN" ]; then
    if [ ! -f "$FROM_BIN" ]; then
        echo "找不到源二进制文件：$FROM_BIN" >&2
        exit 1
    fi
    bin_dir="$(dirname "$BIN_PATH")"
    install -d -m 755 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$bin_dir"
    install -m 755 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$FROM_BIN" "$BIN_PATH.new"
    mv -f "$BIN_PATH.new" "$BIN_PATH"
    echo "已安装二进制：$BIN_PATH"
fi

if [ ! -f "$BIN_PATH" ]; then
    echo "找不到 Go 二进制文件：$BIN_PATH（请先上传或传入 --from <编译产物路径>）" >&2
    exit 1
fi

chown "$SERVICE_USER:$SERVICE_GROUP" "$BIN_PATH"
chmod 755 "$BIN_PATH"

# 确保配置目录存在（用于可选的 /etc/feedback-api/env，不覆盖已有 env 文件）
install -d -m 750 -o root -g "$SERVICE_GROUP" "$ENV_DIR"
echo "已就绪配置目录：$ENV_DIR (0750 root:$SERVICE_GROUP)"

# 确保 identify 存档目录存在且对服务用户可写
if [ -d "$FEEDBACK_ROOT/data" ] && [ ! -d "$FEEDBACK_ROOT/data/identify_archive" ]; then
    install -d -m 755 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$FEEDBACK_ROOT/data/identify_archive"
    echo "已创建存档目录：$FEEDBACK_ROOT/data/identify_archive"
fi

tmp_unit=""
tmp_resp=""
cleanup() {
    [ -n "$tmp_unit" ] && rm -f "$tmp_unit"
    [ -n "$tmp_resp" ] && rm -f "$tmp_resp"
}
trap cleanup EXIT

tmp_unit="$(mktemp)"
tmp_resp="$(mktemp)"

awk \
    -v svc_user="$SERVICE_USER" \
    -v svc_group="$SERVICE_GROUP" \
    -v svc_root="$FEEDBACK_ROOT" \
    -v svc_bin="$BIN_PATH" \
    -v svc_listen="$LISTEN_ADDR" '
    /^User=/ { print "User=" svc_user; next }
    /^Group=/ { print "Group=" svc_group; next }
    /^WorkingDirectory=/ { print "WorkingDirectory=" svc_root; next }
    /^ExecStart=/ { print "ExecStart=" svc_bin; next }
    /^Environment=FEEDBACK_LISTEN_ADDR=/ { print "Environment=FEEDBACK_LISTEN_ADDR=" svc_listen; next }
    /^Environment=FEEDBACK_ROOT=/ { print "Environment=FEEDBACK_ROOT=" svc_root; next }
    { print }
' "$UNIT_TEMPLATE" > "$tmp_unit"

if [ -f "$UNIT_TARGET" ] && cmp -s "$tmp_unit" "$UNIT_TARGET"; then
    echo "systemd unit 已是最新：$UNIT_TARGET"
else
    if [ -f "$UNIT_TARGET" ]; then
        mkdir -p "$BACKUP_ROOT"
        cp -a "$UNIT_TARGET" "$BACKUP_ROOT/feedback-api.service"
        echo "已备份旧 unit：$BACKUP_ROOT/feedback-api.service"
    fi
    install -m 644 -o root -g root "$tmp_unit" "$UNIT_TARGET"
    echo "已安装 systemd unit：$UNIT_TARGET (User=$SERVICE_USER, Group=$SERVICE_GROUP)"
fi

systemctl daemon-reload
systemctl enable feedback-api
systemctl restart feedback-api

if [ -z "$HEALTHZ_URL" ]; then
    if [[ "$LISTEN_ADDR" == :* ]]; then
        HEALTHZ_URL="http://127.0.0.1${LISTEN_ADDR}/healthz"
    else
        HEALTHZ_URL="http://${LISTEN_ADDR}/healthz"
    fi
fi

ok=0
last_code="000"
for _ in $(seq 1 15); do
    last_code="$(curl -sS --noproxy '*' --connect-timeout 2 --max-time 5 \
        -o "$tmp_resp" -w '%{http_code}' "$HEALTHZ_URL" 2>/dev/null || true)"
    if [ "$last_code" = "200" ]; then
        ok=1
        break
    fi
    sleep 1
done

if [ "$ok" -ne 1 ]; then
    echo "healthz 探针失败：$HEALTHZ_URL => HTTP ${last_code:-000}" >&2
    systemctl status feedback-api --no-pager >&2 || true
    journalctl -u feedback-api -n 30 --no-pager >&2 || true
    exit 1
fi

echo "PASS feedback-api 已就绪：$HEALTHZ_URL => HTTP 200 ($(cat "$tmp_resp"))"
