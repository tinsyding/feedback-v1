# 环境架构与运维说明

记录作业反馈与错题本系统的线上生产环境、域名解析、自动化备份机制与历史环境归档记录。

## 一、当前线上环境概览

| 维度 | 主站（生产环境） |
| :--- | :--- |
| **教师端域名** | `https://feedback.wxjifang.cn` |
| **学生端错题本** | `https://vip.wxjifang.cn`（别名：`vip.jokerx.top`） |
| **Git 分支** | `main` |
| **服务器目录** | `/www/wwwroot/JF/feedback-git/feedback-v1` |
| **数据库** | `feedback`（账户：`tinsy`） |
| **发布方式** | GitHub Actions 监听 `main` 分支 push 自动部署并执行冒烟校验 |
| **备份机制** | 每天凌晨 03:00 自动导出 `mysqldump` 压缩快照，滚动保留 7 天 |

---

## 二、生产环境配置细节

### 1. 部署路径与服务结构
- **代码仓库**：位于 `/www/wwwroot/JF/feedback-git`；
- **Nginx WebRoot**：指向 `/www/wwwroot/JF/feedback-git/feedback-v1`；
- **历史软链接**：`/www/wwwroot/JF/feedback` 指向历史旧目录，仅保留兼容历史调用；
- **跨域与接口配置**：
  - 后端 `api/bootstrap.php` 放行 `*.wxjifang.cn` 跨域；
  - 前端 `js/viewer.js` 的 `getRetestBaseUrl()` 默认走 `vip.wxjifang.cn`。

### 2. 自动化发版流水线
- 推送到 `main` 分支后自动触发 `.github/workflows/deploy.yml`；
- GitHub Actions 通过 SSH 登录服务器执行 `git pull --ff-only`；
- 将新增文件属主设为 `www:www`，目录权限 `755`、文件权限 `644`；
- 对主要页面与 API 接口执行 HTTP 200 冒烟检查。

### 3. 生产数据库自动快照备份
- **定时任务**：Crontab 中每日凌晨 03:00 执行；
- **备份脚本**：`/root/feedback_prod_backup.sh`；
- **执行逻辑**：
  1. 使用 `mysqldump --single-transaction --quick --routines --triggers --events` 导出生产库 `feedback`；
  2. 生成压缩快照至 `/www/backup/feedback_backup_snapshots/feedback_YYYYMMDD_HHMMSS.sql.gz`；
  3. 自动清理超过 7 天的历史快照文件，保障磁盘健康；
- **日志路径**：`/var/log/feedback_prod_backup.log`。

---

## 三、历史环境清理归档记录（2026-11-04）

系统原先部署了独立的测试站（`feedbacktest.wxjifang.cn`）与镜像热备站（`feedbackbackup.wxjifang.cn`）。为精简系统架构、释放服务器存储与降低维护成本，已于 2026-11-04 执行下线清理：

1. **下线内容**：
   - 测试站代码目录 `/www/wwwroot/JF/feedback-test` 与独立库 `feedback_test`；
   - 备份站代码目录 `/www/wwwroot/JF/feedback-backup` 与独立库 `feedback_backup`；
   - Nginx 站点配置已禁用移入 `disabled_vhosts` 目录；
   - 移除了冗余的站点镜像同步脚本与定时任务。
2. **本地留底归档**：
   - 清理前已对两套库及 10 月份历史数据迁移快照执行全量导出并完成 MD5 校验；
   - 完整留底归档保存在本地仓库的 `backups/server_archive_20261104/` 目录下（受 `.gitignore` 保护）。

---

## 四、安全与凭据管理

1. **敏感配置隔离**：
   - 数据库凭据存放在服务器本地的 `feedback-v1/api/db.local.php` 中；
   - 私有 Key 存放在 `feedback-v1/api/secret_key.local.php` 中；
   - Nginx 规则（`vhost/nginx/extension/*/zz-feedback-security.conf`）严格拦截对 `/config.json` 与 `*.local.php` 的外部访问；
   - 本地凭据文件均已加入 `.gitignore`，绝不提交至代码仓库。
