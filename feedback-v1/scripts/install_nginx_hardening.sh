#!/usr/bin/env bash
# 安装 feedback-v1 的 nginx 安全硬化片段到生产主站。
#
# 用法（在服务器上以 root 运行）：
#   sudo bash feedback-v1/scripts/install_nginx_hardening.sh
#
# 可用 SITES 覆盖站点列表：
#   SITES="feedback.wxjifang.cn" sudo -E bash feedback-v1/scripts/install_nginx_hardening.sh
#
# 脚本会：
#   1. 备份旧的 zz-feedback-security.conf 到 /root/nginx-hardening-backups/
#   2. 安装版本库中的片段
#   3. nginx -t 通过后 reload；失败自动回滚
#   4. 验证敏感路径 404、PDF 仍可下载

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "请用 root 运行此脚本" >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SNIPPET="$SCRIPT_DIR/nginx/zz-feedback-security.conf"
EXT_ROOT="/www/server/panel/vhost/nginx/extension"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_ROOT="/root/nginx-hardening-backups/$STAMP"

DEFAULT_SITES="feedback.wxjifang.cn"
SITES="${SITES:-$DEFAULT_SITES}"

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

if [ ! -f "$SNIPPET" ]; then
    echo "找不到安全片段：$SNIPPET" >&2
    exit 1
fi

declare -a CHANGED=()

for domain in $SITES; do
    ext_dir="$EXT_ROOT/$domain"
    target="$ext_dir/zz-feedback-security.conf"

    if [ ! -d "$ext_dir" ]; then
        echo "跳过不存在的站点目录：$ext_dir"
        continue
    fi

    if [ -f "$target" ] && cmp -s "$SNIPPET" "$target"; then
        echo "已是最新：$target"
        continue
    fi

    mkdir -p "$BACKUP_ROOT/$domain"
    backup="$BACKUP_ROOT/$domain/zz-feedback-security.conf"
    if [ -f "$target" ]; then
        cp -a "$target" "$backup"
    else
        backup=""
    fi

    install -m 600 -o root -g root "$SNIPPET" "$target"
    CHANGED+=("$domain|$target|$backup")
    echo "已安装：$target"
done

if [ "${#CHANGED[@]}" -eq 0 ]; then
    echo "所有站点均已是最新片段，无需 reload。"
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

http_code() {
    local domain="$1"
    local path="$2"
    curl -sk --noproxy '*' --resolve "$domain:443:127.0.0.1" \
        --connect-timeout 5 --max-time 15 \
        -o /dev/null -w '%{http_code}' "https://$domain$path" || true
}

check_path() {
    local domain="$1"
    local path="$2"
    local expected="$3"
    local code=""
    for _ in 1 2 3 4 5; do
        code="$(http_code "$domain" "$path")"
        if [ "$code" = "$expected" ]; then
            return 0
        fi
        sleep 1
    done
    echo "FAIL $domain $path => $code（期望 $expected）"
    return 1
}

sleep 1

for domain in $SITES; do
    check_path "$domain" "/data/vision_config.json" "404" || fail=1
    check_path "$domain" "/data/identify_archive/" "404" || fail=1
    check_path "$domain" "/nginx.conf" "404" || fail=1

    case "$domain" in
        feedback.wxjifang.cn) site_root="/www/wwwroot/JF/feedback-git/feedback-v1" ;;
        feedbacktest.wxjifang.cn) site_root="/www/wwwroot/JF/feedback-test/feedback-v1" ;;
        feedbackbackup.wxjifang.cn) site_root="/www/wwwroot/JF/feedback-backup/feedback-v1" ;;
        *) site_root="" ;;
    esac

    if [ -n "$site_root" ] && [ -d "$site_root/data/pdfs" ]; then
        pdf=$(find "$site_root/data/pdfs" -maxdepth 1 -type f -name '*.pdf' -printf '%f\n' 2>/dev/null | head -n 1 || true)
        if [ -n "$pdf" ]; then
            check_path "$domain" "/data/pdfs/$pdf" "200" || fail=1
        fi
    fi
done

if [ "$fail" -ne 0 ]; then
    echo "验证失败，请检查上面的 FAIL 项。" >&2
    exit 1
fi

echo "验证通过：敏感路径 404，PDF 可下载。"
