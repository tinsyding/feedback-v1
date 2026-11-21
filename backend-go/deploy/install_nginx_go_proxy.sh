#!/usr/bin/env bash
# 安装或回滚 feedback-v1 的 Go 后端 Nginx 反代片段 (zz-feedback-go-proxy.conf)。
# 参照 feedback-v1/scripts/install_nginx_hardening.sh 规范实现。
#
# 用法（在服务器上以 root 运行）：
#   # 主站生产机（jf，宝塔 extension 目录）：
#   sudo bash backend-go/deploy/install_nginx_go_proxy.sh
#
#   # 多站点覆盖：
#   SITES="feedback.wxjifang.cn" sudo -E bash backend-go/deploy/install_nginx_go_proxy.sh
#
#   # 非宝塔标准 Debian Nginx（如 jf-backup）：
#   sudo bash backend-go/deploy/install_nginx_go_proxy.sh \
#     --target-dir /etc/nginx/snippets --sites feedbackbackup.wxjifang.cn
#
#   # 1 秒回滚至 PHP-FPM：
#   sudo bash backend-go/deploy/install_nginx_go_proxy.sh --rollback
#   sudo bash backend-go/deploy/install_nginx_go_proxy.sh --rollback --target-dir /etc/nginx/snippets
#
# 脚本会：
#   1. （非回滚模式）先探测 http://127.0.0.1:8090/healthz 返回 200；Go 未就绪则拒绝切流
#   2. 备份旧的 zz-feedback-go-proxy.conf 到 /root/nginx-go-proxy-backups/
#   3. 安装（或 --rollback 移除）片段，执行 nginx -t（失败自动回滚）并 reload
#   4. 通过 curl --resolve 验证 /api/public_config.php、/api/calibrate_roi.php、/api/changelog.php?action=getActive、/api/auth.php?action=check 与 /api/retest.php?action=captcha：
#      - 切流模式：必须返回 HTTP 200 且包含响应头 X-Backend-Engine: go
#      - 回滚模式：必须返回 HTTP 200 且不再包含 X-Backend-Engine: go

set -euo pipefail

usage() {
    cat <<'EOF'
用法: sudo bash backend-go/deploy/install_nginx_go_proxy.sh [选项]

选项:
  --rollback              移除 zz-feedback-go-proxy.conf 并 reload Nginx（1 秒回滚至 PHP）
  --target-dir <dir>      非宝塔环境覆盖目标目录（直接安装/移除 <dir>/zz-feedback-go-proxy.conf）
  --sites <domains>       空格分隔的校验域名列表（默认读取 SITES 或 feedback.wxjifang.cn）
  --snippet <path>        自定义片段文件路径（默认使用仓库内 zz-feedback-go-proxy.conf）
  --healthz-url <url>     Go 后端健康检查地址（默认：http://127.0.0.1:8090/healthz）
  --verify-scheme <sch>   校验请求协议 https|http（默认：https）
  --verify-port <port>    校验连接端口（默认 https=443，http=80）
  -h, --help              显示此帮助信息
EOF
}

ROLLBACK=0
TARGET_DIR=""
SITES="${SITES:-feedback.wxjifang.cn}"
HEALTHZ_URL="${HEALTHZ_URL:-http://127.0.0.1:8090/healthz}"
VERIFY_SCHEME="${VERIFY_SCHEME:-https}"
VERIFY_PORT="${VERIFY_PORT:-}"
SNIPPET_OVERRIDE=""

while [ "$#" -gt 0 ]; do
    case "$1" in
        --rollback)
            ROLLBACK=1
            shift
            ;;
        --target-dir)
            [ "$#" -ge 2 ] || { echo "缺少参数值: $1" >&2; exit 1; }
            TARGET_DIR="$2"
            shift 2
            ;;
        --target-dir=*)
            TARGET_DIR="${1#*=}"
            shift
            ;;
        --sites)
            [ "$#" -ge 2 ] || { echo "缺少参数值: $1" >&2; exit 1; }
            SITES="$2"
            shift 2
            ;;
        --sites=*)
            SITES="${1#*=}"
            shift
            ;;
        --snippet)
            [ "$#" -ge 2 ] || { echo "缺少参数值: $1" >&2; exit 1; }
            SNIPPET_OVERRIDE="$2"
            shift 2
            ;;
        --snippet=*)
            SNIPPET_OVERRIDE="${1#*=}"
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
        --verify-scheme)
            [ "$#" -ge 2 ] || { echo "缺少参数值: $1" >&2; exit 1; }
            VERIFY_SCHEME="$2"
            shift 2
            ;;
        --verify-scheme=*)
            VERIFY_SCHEME="${1#*=}"
            shift
            ;;
        --verify-port)
            [ "$#" -ge 2 ] || { echo "缺少参数值: $1" >&2; exit 1; }
            VERIFY_PORT="$2"
            shift 2
            ;;
        --verify-port=*)
            VERIFY_PORT="${1#*=}"
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

if [ -z "$VERIFY_PORT" ]; then
    if [ "$VERIFY_SCHEME" = "http" ]; then
        VERIFY_PORT="80"
    else
        VERIFY_PORT="443"
    fi
fi

if [ "$(id -u)" -ne 0 ]; then
    echo "请用 root 运行此脚本" >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SNIPPET="${SNIPPET_OVERRIDE:-$REPO_ROOT/feedback-v1/scripts/nginx/zz-feedback-go-proxy.conf}"
EXT_ROOT="/www/server/panel/vhost/nginx/extension"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_ROOT="/root/nginx-go-proxy-backups/$STAMP"

NGINX_BIN="${NGINX_BIN:-}"
if [ -z "$NGINX_BIN" ]; then
    if command -v nginx >/dev/null 2>&1; then
        NGINX_BIN="$(command -v nginx)"
    elif [ -x /www/server/nginx/sbin/nginx ]; then
        NGINX_BIN="/www/server/nginx/sbin/nginx"
    elif [ -x /usr/sbin/nginx ]; then
        NGINX_BIN="/usr/sbin/nginx"
    else
        echo "找不到 nginx 可执行文件" >&2
        exit 1
    fi
fi

if ! command -v curl >/dev/null 2>&1; then
    echo "找不到 curl，无法执行健康检查与切流验证" >&2
    exit 1
fi

tmp_body=""
tmp_hdr=""
cleanup() {
    [ -n "$tmp_body" ] && rm -f "$tmp_body"
    [ -n "$tmp_hdr" ] && rm -f "$tmp_hdr"
}
trap cleanup EXIT

tmp_body="$(mktemp)"
tmp_hdr="$(mktemp)"

# 切流前置检查：Go 后端必须返回 HTTP 200 才允许修改 Nginx
if [ "$ROLLBACK" -eq 0 ]; then
    if [ ! -f "$SNIPPET" ]; then
        echo "找不到 Go 反代片段：$SNIPPET" >&2
        exit 1
    fi

    health_code="$(curl -sS --noproxy '*' --connect-timeout 3 --max-time 5 \
        -o "$tmp_body" -w '%{http_code}' "$HEALTHZ_URL" 2>/dev/null || true)"
    if [ "$health_code" != "200" ]; then
        echo "前置健康检查失败：$HEALTHZ_URL => HTTP ${health_code:-000}，拒绝切流！" >&2
        echo "请先启动并确认 feedback-api 服务健康后再执行切流。" >&2
        exit 1
    fi
    echo "前置检查通过：$HEALTHZ_URL => HTTP 200"
fi

declare -a TARGET_ENTRIES=()
if [ -n "$TARGET_DIR" ]; then
    if [ ! -d "$TARGET_DIR" ]; then
        echo "找不到目标配置目录：$TARGET_DIR" >&2
        exit 1
    fi
    TARGET_ENTRIES+=("custom|$TARGET_DIR/zz-feedback-go-proxy.conf")
else
    for domain in $SITES; do
        ext_dir="$EXT_ROOT/$domain"
        if [ ! -d "$ext_dir" ]; then
            echo "跳过不存在的站点目录：$ext_dir"
            continue
        fi
        TARGET_ENTRIES+=("$domain|$ext_dir/zz-feedback-go-proxy.conf")
    done
fi

if [ "${#TARGET_ENTRIES[@]}" -eq 0 ]; then
    echo "未找到任何可用的 Nginx 配置目标目录（宝塔路径 $EXT_ROOT/<domain> 不存在时，请传 --target-dir <dir>）。" >&2
    exit 1
fi

declare -a CHANGED=()

for item in "${TARGET_ENTRIES[@]}"; do
    IFS='|' read -r label target <<< "$item"

    if [ "$ROLLBACK" -eq 1 ]; then
        if [ ! -f "$target" ]; then
            echo "未安装（无需移除）：$target"
            continue
        fi

        mkdir -p "$BACKUP_ROOT/$label"
        backup="$BACKUP_ROOT/$label/zz-feedback-go-proxy.conf"
        cp -a "$target" "$backup"
        rm -f "$target"
        CHANGED+=("$label|$target|$backup")
        echo "已移除（已备份至 $backup）：$target"
    else
        if [ -f "$target" ] && cmp -s "$SNIPPET" "$target"; then
            echo "已是最新：$target"
            continue
        fi

        mkdir -p "$BACKUP_ROOT/$label"
        backup="$BACKUP_ROOT/$label/zz-feedback-go-proxy.conf"
        if [ -f "$target" ]; then
            cp -a "$target" "$backup"
        else
            backup=""
        fi

        install -m 600 -o root -g root "$SNIPPET" "$target"
        CHANGED+=("$label|$target|$backup")
        echo "已安装：$target"
    fi
done

if [ "${#CHANGED[@]}" -eq 0 ]; then
    echo "Nginx 反代配置无变更，无需 reload。"
else
    if ! "$NGINX_BIN" -t; then
        echo "nginx -t 失败，开始回滚本次修改..." >&2
        for entry in "${CHANGED[@]}"; do
            IFS='|' read -r _ target backup <<< "$entry"
            if [ -n "$backup" ] && [ -f "$backup" ]; then
                cp -a "$backup" "$target"
            else
                rm -f "$target"
            fi
            echo "已回滚：$target"
        done
        exit 1
    fi

    "$NGINX_BIN" -s reload
    echo "nginx 已 reload。"
fi

fail=0

probe_endpoint() {
    local domain="$1"
    local path="$2"
    local expect_go="$3"
    local code=""
    local has_go_header=0

    for _ in 1 2 3 4 5; do
        : > "$tmp_hdr"
        code="$(curl -sk --noproxy '*' --resolve "$domain:$VERIFY_PORT:127.0.0.1" \
            --connect-timeout 5 --max-time 15 \
            -D "$tmp_hdr" -o /dev/null -w '%{http_code}' \
            "$VERIFY_SCHEME://$domain:$VERIFY_PORT$path" || true)"

        if tr -d '\r' < "$tmp_hdr" | grep -Eiq '^X-Backend-Engine:[[:space:]]*go[[:space:]]*$'; then
            has_go_header=1
        else
            has_go_header=0
        fi

        if [ "$code" = "200" ]; then
            if [ "$expect_go" -eq 1 ] && [ "$has_go_header" -eq 1 ]; then
                echo "PASS [go]  $domain$path => HTTP 200 (X-Backend-Engine: go)"
                return 0
            elif [ "$expect_go" -eq 0 ] && [ "$has_go_header" -eq 0 ]; then
                echo "PASS [php] $domain$path => HTTP 200 (已回退 PHP，无 X-Backend-Engine: go)"
                return 0
            fi
        fi
        sleep 1
    done

    if [ "$expect_go" -eq 1 ]; then
        echo "FAIL [go]  $domain$path => HTTP ${code:-000} (has X-Backend-Engine: go = $has_go_header, 期望 200 且含 Go 标识)" >&2
    else
        echo "FAIL [php] $domain$path => HTTP ${code:-000} (has X-Backend-Engine: go = $has_go_header, 期望 200 且不含 Go 标识)" >&2
    fi
    return 1
}

sleep 1

expect_go=1
if [ "$ROLLBACK" -eq 1 ]; then
    expect_go=0
fi

for domain in $SITES; do
    probe_endpoint "$domain" "/api/public_config.php" "$expect_go" || fail=1
    probe_endpoint "$domain" "/api/calibrate_roi.php" "$expect_go" || fail=1
    probe_endpoint "$domain" "/api/changelog.php?action=getActive" "$expect_go" || fail=1
    probe_endpoint "$domain" "/api/auth.php?action=check" "$expect_go" || fail=1
    probe_endpoint "$domain" "/api/retest.php?action=captcha" "$expect_go" || fail=1
done

if [ "$fail" -ne 0 ]; then
    echo "验证失败，请检查上面的 FAIL 项。" >&2
    exit 1
fi

if [ "$ROLLBACK" -eq 1 ]; then
    echo "回滚验证通过：所有灰度接口已恢复 PHP-FPM 处理。"
else
    echo "切流验证通过：灰度接口已由 Go 后端 (X-Backend-Engine: go) 接管。"
fi
