# 多环境架构与运维说明

记录作业反馈与错题本系统的主站（生产）、测试站与备份站的域名、分支、目录、数据库隔离与定时同步机制。

## 一、环境概览

| 维度 | 主站（生产） | 测试站 | 备份站 |
| :--- | :--- | :--- | :--- |
| 教师端域名 | `https://feedback.wxjifang.cn` | `https://feedbacktest.wxjifang.cn` | `https://feedbackbackup.wxjifang.cn` |
| 学生端错题本 | `https://vip.wxjifang.cn`<br>（别名：`vip.jokerx.top`） | `https://feedbacktest.wxjifang.cn/retest.html` | `https://feedbackbackup.wxjifang.cn/retest.html` |
| Git 分支 | `main` | `staging` | `main` |
| 服务器目录 | `/www/wwwroot/JF/feedback-git/feedback-v1` | `/www/wwwroot/JF/feedback-test/feedback-v1` | `/www/wwwroot/JF/feedback-backup/feedback-v1` |
| 数据库 | `feedback`（账户：`tinsy`） | `feedback_test`（账户：`feedback_test`） | `feedback_backup`（账户：`feedback_backup`） |
| 发布/同步方式 | GitHub Actions 监听 `main` push 自动部署 | 手动或按测试分支部署 | 每天 03:00 自动从主站导出快照并同步静态文件 |
| 用途 | 线上正式环境 | 新功能上线前验证 | 生产环境容灾备份 |

## 二、各环境配置细节

### 1. 主站
- 路径：
  - 仓库位于 `/www/wwwroot/JF/feedback-git`；
  - Nginx 根目录指向 `/www/wwwroot/JF/feedback-git/feedback-v1`；
  - 旧路径 `/www/wwwroot/JF/feedback` 为软链接，保留兼容历史脚本。
- 自动发版：
  - 推送到 `main` 分支后触发 `.github/workflows/deploy.yml`；
  - GitHub Actions 通过 SSH 登录服务器执行 `git pull --ff-only`；
  - 将新增文件属主设为 `www:www`，目录权限 `755`、文件权限 `644`；
  - 对 10 个主要页面与 API 接口执行 HTTP 200 冒烟检查。

### 2. 测试站
- 路径：
  - 独立仓库目录 `/www/wwwroot/JF/feedback-test`，检出 `staging` 分支；
  - Nginx 根目录指向 `/www/wwwroot/JF/feedback-test/feedback-v1`。
- 隔离配置：
  - 使用独立数据库 `feedback_test` 与独立数据目录，不受主站备份任务影响；
  - `.user.ini` 限制 `open_basedir=/www/wwwroot/JF/feedback-test/:/tmp/`；
  - 后端 `api/bootstrap.php` 放行 `*.wxjifang.cn` 跨域；前端 `js/viewer.js` 的 `getRetestBaseUrl()` 在 `feedbacktest` 域名下会将生成的错题本链接指向测试站自身，避免测试数据写入生产端。

### 3. 备份站
- 路径：
  - 独立目录 `/www/wwwroot/JF/feedback-backup`，跟踪 `main` 分支；
  - Nginx 根目录指向 `/www/wwwroot/JF/feedback-backup/feedback-v1`。
- 每日自动快照与同步：
  - 定时任务：`/etc/cron.d/feedback-backup-sync`（每天 03:00 执行）；
  - 执行脚本：`/root/feedback_backup_sync.sh`；
  - 同步步骤：
    1. 使用 `mysqldump --single-transaction` 导出生产库 `feedback`；
    2. 压缩备份至 `/www/backup/feedback_backup_snapshots/`（保留最近 7 天）；
    3. 导入中转库 `feedback_backup_staging`，校验学生表与题目表行数；
    4. 通过 `RENAME TABLE` 原子切换至 `feedback_backup`；
    5. 使用 `rsync -av --delete` 增量同步运行期目录（`data/pdfs/`、`data/uploads/`、`data/qbank/`、`data/history/` 等）。
  - 日志路径：`/var/log/feedback_backup_sync.log`。

## 三、证书与凭据管理

1. SSL 证书续签：
   - 脚本：`/root/feedback_backup_renew_cert.sh`；
   - 计划任务：每周一 04:00；
   - 覆盖域名：`feedbacktest.wxjifang.cn`、`feedbackbackup.wxjifang.cn`；
   - 到期前 30 天内自动续签并执行 `nginx -s reload`。
2. 敏感配置隔离：
   - 数据库凭据存放在各站点本地的 `feedback-v1/config.json` 或 `*.local.php` 中；
   - Nginx 规则（`vhost/nginx/extension/*/zz-feedback-security.conf`）拦截对 `/config.json` 与 `*.local.php` 的外部访问；
   - 私有凭据文件已加入 `.gitignore`，不纳入版本控制。
