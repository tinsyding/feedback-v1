#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# 从生产服务器 (jf) 一键拉取最新题库数据与错题数据到本地
# 同步内容：
#   1. MySQL 题库表 (qbank_weeks, qbank_questions)
#   2. MySQL 错题与学情表 (class_batches, student_records, student_record_history,
#      generation_batches, retest_access_logs, retest_revoked_tokens)
#   3. 题库/错题相关 PDF 与上传文件 (data/pdfs/, data/uploads/)
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOCAL_V1_DIR="${REPO_ROOT}/feedback-v1"
LOCAL_DB_CFG="${LOCAL_V1_DIR}/api/db.local.php"
BACKUP_DIR="${REPO_ROOT}/backups/prod_sync"

SSH_HOST="jf"
REMOTE_V1_DIR="/www/wwwroot/JF/feedback-git/feedback-v1"

TABLES=(
  "qbank_weeks"
  "qbank_questions"
  "class_batches"
  "student_records"
  "student_record_history"
  "generation_batches"
  "retest_access_logs"
  "retest_revoked_tokens"
)

echo "============================================================"
echo "  极方反馈系统 - 从生产服务器拉取最新题库与错题数据"
echo "============================================================"
echo ""

# 1. 检查本地依赖与配置
for cmd in ssh rsync mysql gzip python3; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "❌ 缺少本地命令: $cmd"
    exit 1
  fi
done

if [ ! -f "$LOCAL_DB_CFG" ]; then
  echo "❌ 未找到本地数据库配置文件: $LOCAL_DB_CFG"
  exit 1
fi

# 从 feedback-v1/api/db.local.php 解析本地数据库配置
read -r LOCAL_DB_HOST LOCAL_DB_PORT LOCAL_DB_NAME LOCAL_DB_USER LOCAL_DB_PASS < <(
  python3 - "$LOCAL_DB_CFG" << 'PY'
import re, sys
text = open(sys.argv[1], encoding="utf-8").read()
def get(k, default=""):
    m = re.search(rf"['\"]{k}['\"]\s*=>\s*['\"]([^'\"]*)['\"]", text)
    if m:
        return m.group(1)
    m = re.search(rf"['\"]{k}['\"]\s*=>\s*(\d+)", text)
    return m.group(1) if m else default
print(
    get("host", "127.0.0.1"),
    get("port", "3306"),
    get("dbname", "feedback"),
    get("username", "tinsy"),
    get("password", ""),
)
PY
)

# 2. 检查 SSH 连通性
echo "🔌 [1/4] 正在测试连接服务器 (${SSH_HOST})..."
if ! ssh -o ConnectTimeout=10 -o BatchMode=yes "$SSH_HOST" "echo ok" >/dev/null 2>&1; then
  echo "❌ 无法通过 SSH 连接到 ${SSH_HOST}，请检查网络或 ~/.ssh/config 配置。"
  exit 1
fi
echo "✅ 服务器连接正常"
echo ""

# 3. 导出生产库题库与错题数据
mkdir -p "$BACKUP_DIR"
TIMESTAMP="$(date +'%Y%m%d_%H%M%S')"
DUMP_FILE="${BACKUP_DIR}/feedback_qbank_retest_${TIMESTAMP}.sql.gz"
TABLES_STR="${TABLES[*]}"

echo "🗄️  [2/4] 正在从服务器导出题库与错题数据库表..."
ssh -o ConnectTimeout=15 "$SSH_HOST" "bash -s" -- "$REMOTE_V1_DIR" $TABLES_STR << 'EOF' > "$DUMP_FILE"
set -euo pipefail
REMOTE_DIR="$1"
shift
TABLES_TO_DUMP=("$@")

MYSQLDUMP=$(if [ -x /www/server/mysql/bin/mysqldump ]; then echo /www/server/mysql/bin/mysqldump; else command -v mysqldump; fi)

if [ -r /root/.my.cnf ]; then
  "$MYSQLDUMP" --defaults-extra-file=/root/.my.cnf \
    --single-transaction --quick --default-character-set=utf8mb4 \
    feedback "${TABLES_TO_DUMP[@]}" | gzip -c
else
  PHP_BIN=$(if [ -x /www/server/php/82/bin/php ]; then echo /www/server/php/82/bin/php; else command -v php; fi)
  DB_CFG="${REMOTE_DIR}/api/db.local.php"
  DB_HOST=$($PHP_BIN -r '$c = @include "'"$DB_CFG"'"; echo is_array($c) ? ($c["host"] ?? "127.0.0.1") : "127.0.0.1";')
  DB_PORT=$($PHP_BIN -r '$c = @include "'"$DB_CFG"'"; echo is_array($c) ? ($c["port"] ?? "3306") : "3306";')
  DB_USER=$($PHP_BIN -r '$c = @include "'"$DB_CFG"'"; echo is_array($c) ? ($c["username"] ?? "root") : "root";')
  DB_PASS=$($PHP_BIN -r '$c = @include "'"$DB_CFG"'"; echo is_array($c) ? ($c["password"] ?? "") : "";')
  DB_NAME=$($PHP_BIN -r '$c = @include "'"$DB_CFG"'"; echo is_array($c) ? ($c["dbname"] ?? "feedback") : "feedback";')

  if [ -n "$DB_PASS" ]; then
    export MYSQL_PWD="$DB_PASS"
  fi

  "$MYSQLDUMP" \
    -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" \
    --single-transaction --quick --default-character-set=utf8mb4 \
    "$DB_NAME" "${TABLES_TO_DUMP[@]}" | gzip -c
fi
EOF

FILE_SIZE=$(wc -c < "$DUMP_FILE" || echo 0)
if [ "$FILE_SIZE" -le 200 ] || ! gzip -t "$DUMP_FILE" 2>/dev/null; then
  echo "❌ 数据库导出失败或压缩包损坏: $DUMP_FILE (大小: ${FILE_SIZE} bytes)"
  rm -f "$DUMP_FILE"
  exit 1
fi
echo "✅ 数据库导出成功: ${DUMP_FILE} ($(ls -lh "$DUMP_FILE" | awk '{print $5}'))"
echo ""

# 4. 导入到本地 MySQL
echo "📥 [3/4] 正在导入数据到本地 MySQL (${LOCAL_DB_NAME}@${LOCAL_DB_HOST})..."
if [ -n "$LOCAL_DB_PASS" ]; then
  export MYSQL_PWD="$LOCAL_DB_PASS"
fi
gzip -dc "$DUMP_FILE" | mysql -h"$LOCAL_DB_HOST" -P"$LOCAL_DB_PORT" -u"$LOCAL_DB_USER" --default-character-set=utf8mb4 "$LOCAL_DB_NAME"
echo "✅ 本地数据库已更新为最新数据"
echo ""

# 5. 增量同步 PDF 与上传文件
echo "📄 [4/4] 正在增量同步题库 PDF 与上传文件 (rsync)..."
mkdir -p "${LOCAL_V1_DIR}/data/pdfs" "${LOCAL_V1_DIR}/data/uploads" "${LOCAL_V1_DIR}/data/qbank"

echo "  -> 同步 data/pdfs/ ..."
rsync -az --info=stats2 --exclude='.gitkeep' \
  "${SSH_HOST}:${REMOTE_V1_DIR}/data/pdfs/" \
  "${LOCAL_V1_DIR}/data/pdfs/"

echo "  -> 同步 data/uploads/ ..."
rsync -az --info=stats2 --exclude='.gitkeep' \
  "${SSH_HOST}:${REMOTE_V1_DIR}/data/uploads/" \
  "${LOCAL_V1_DIR}/data/uploads/"

echo "  -> 同步 data/qbank/ ..."
rsync -az --info=stats2 --exclude='.gitkeep' \
  "${SSH_HOST}:${REMOTE_V1_DIR}/data/qbank/" \
  "${LOCAL_V1_DIR}/data/qbank/"

echo ""
echo "============================================================"
echo "🎉 全部同步完成！本地当前数据统计："
mysql -h"$LOCAL_DB_HOST" -P"$LOCAL_DB_PORT" -u"$LOCAL_DB_USER" "$LOCAL_DB_NAME" -e "
SELECT '题库专题 (qbank_weeks)' AS 数据项, COUNT(*) AS 记录数, MAX(updated_at) AS 最新更新时间 FROM qbank_weeks
UNION ALL
SELECT '题库题目 (qbank_questions)', COUNT(*), MAX(updated_at) FROM qbank_questions
UNION ALL
SELECT '班级批次 (class_batches)', COUNT(*), MAX(created_at) FROM class_batches
UNION ALL
SELECT '学生错题 (student_records)', COUNT(*), MAX(updated_at) FROM student_records
UNION ALL
SELECT '错题历史 (student_record_history)', COUNT(*), MAX(archived_at) FROM student_record_history;
"
echo "📁 SQL 备份归档: ${DUMP_FILE}"
echo "📁 题库 PDF 目录: ${LOCAL_V1_DIR}/data/pdfs ($(find "${LOCAL_V1_DIR}/data/pdfs" -maxdepth 1 -type f ! -name '.gitkeep' | wc -l) 个文件)"
echo "============================================================"
