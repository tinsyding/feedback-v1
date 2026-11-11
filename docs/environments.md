# 生产环境架构与运维说明

记录作业反馈与错题本系统的线上生产环境、域名解析、自动化发版、数据库与文件灾备机制。

## 一、线上环境概览

| 维度 | 主站（生产环境） | 备用 / 灾备环境 |
| :--- | :--- | :--- |
| **服务器 IP** | `43.142.104.218`（4核4G） | `106.14.62.196`（原主站服务器） |
| **本地 SSH 别名** | `jf` (`ssh jf`) | `jf-backup` (`ssh jf-backup`) |
| **SSH 端口** | `28964` | `28964` |
| **认证方式** | 仅 ED25519 密钥免密登录（禁用密码） | 仅 ED25519 密钥免密登录（禁用密码） |
| **系统与环境** | 腾讯云 Ubuntu / 宝塔 Linux 面板 / Nginx / PHP 8.2 (FPM) / MySQL 8.0 | 阿里云 Debian 12 (bookworm) / 干净精简系统 |
| **教师端域名** | `https://feedback.wxjifang.cn` | - |
| **学生端错题本** | `https://vip.wxjifang.cn`（别名：`vip.jokerx.top`） | - |
| **Git 分支** | `main` | - |
| **服务器目录** | `/www/wwwroot/JF/feedback-git/feedback-v1` | - |
| **数据库** | `feedback`（账户：`tinsy`） | 历史数据已全量归档至本地 `backups/` |
| **发布方式** | GitHub Actions 监听 `main` 分支 push 自动部署、增量迁移并执行冒烟校验 | - |
| **本地快照机制** | 每天凌晨 03:00 自动导出 `mysqldump` 压缩快照至本地，滚动保留 7 天 | - |
| **异地灾备机制** | 每天凌晨 03:30 GitHub Actions 自动将数据库快照、PDF 材料与凭据异地备份至 Google Drive，保留 30 天 | 本地全量归档存档于 `backups/server_archive_final_jf_106.14.62.196_20261110/` |

---

## 二、生产环境配置细节

### 1. 部署路径与服务结构
- **代码仓库**：位于 `/www/wwwroot/JF/feedback-git`；
- **Nginx WebRoot**：指向 `/www/wwwroot/JF/feedback-git/feedback-v1`；
- **历史软链接**：`/www/wwwroot/JF/feedback` 指向历史旧目录，仅保留兼容历史调用；
- **跨域与接口配置**：
  - 后端 `api/bootstrap.php` 放行 `*.wxjifang.cn` 与 `vip.jokerx.top` 跨域；
  - 前端 `js/viewer.js` 的 `getRetestBaseUrl()` 默认走 `vip.wxjifang.cn`。

### 2. 自动化发版流水线
- 推送到 `main` 分支后自动触发 [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)；
- GitHub Actions 通过 SSH 登录服务器执行部署（`concurrency: production-deploy`）：
  1. **Secrets 预检**：校验 `DEPLOY_HOST`、`DEPLOY_PORT`、`DEPLOY_USER` 与 `DEPLOY_SSH_KEY` 完整性及端口格式；
  2. **解除不可变锁**：临时解除 `.user.ini` 宝塔防跨目录不可变保护 (`chattr -i`)；
  3. **代码检出与对齐**：执行 `git fetch origin main && git reset --hard $TARGET_SHA`，保证与触发提交严格一致；
  4. **权限收敛**：重置代码属主为 `www:www`，目录权限 `755`、文件权限 `644`，Git 目录 `700`；
  5. **恢复目录锁**：重新锁定 `.user.ini` (`chattr +i`)，恢复目录隔离防御；
  6. **自动数据库迁移**：调用 PHP 8.2 执行 `scripts/migrate.php migrate`，幂等执行增量表结构补齐与升级；
  7. **重载 PHP-FPM**：重载 `php-fpm-82` 刷新字节码缓存（Opcache）；
  8. **冒烟回归**：核验线上 HEAD Commit SHA，并对 10 个核心页面及 API 执行 HTTP 200 连通性测试；
  9. **凭据擦除**：清理临时 SSH 私钥文件。

### 3. 数据备份与容灾机制

#### (1) 本地自动快照备份
- **定时任务**：服务器 Crontab 中每日凌晨 03:00 执行；
- **备份脚本**：`/root/feedback_prod_backup.sh`；
- **执行逻辑**：
  1. 使用 `mysqldump --single-transaction --quick --routines --triggers --events` 导出生产库 `feedback`；
  2. 生成压缩快照至 `/www/backup/feedback_backup_snapshots/feedback_YYYYMMDD_HHMMSS.sql.gz`；
  3. 自动清理超过 7 天的历史快照文件，保障磁盘健康；
- **日志路径**：`/var/log/feedback_prod_backup.log`。

#### (2) Google Drive 异地定时容灾备份
- **工作流**：[`.github/workflows/backup-production-to-gdrive.yml`](../.github/workflows/backup-production-to-gdrive.yml)；
- **定时调度**：每日北京时间 03:30（UTC 19:30）执行，亦可在 GitHub Actions 页面手动即时触发；
- **备份范围**：
  1. **MySQL 数据库**：从生产机导出全量数据库，经 gzip 压缩后同步至 Google Drive；
  2. **教学与题库材料**：同步老师上传的 PDF 切片、错题本与采集上传资源（`/data/pdfs/`、`/data/qbank/`、`/data/uploads/`）；
  3. **核心脱敏凭据**：同步备份服务器本地的 `config.json`、`api/db.local.php`、`api/secret_key.local.php`；
- **生命周期**：云端快照默认保留 30 天，支持工作流输入自定义清理周期。

#### (3) 源码异地增量同步
- **工作流**：[`.github/workflows/sync-google-drive.yml`](../.github/workflows/sync-google-drive.yml)；
- **执行逻辑**：监听 `main` 分支变动，自动将源码仓库增量镜像同步至 Google Drive 备份归档。

---

## 三、安全与凭据管理

1. **敏感配置隔离**：
   - 数据库凭据存放在服务器本地的 `feedback-v1/api/db.local.php` 中；
   - 私有 Key 存放在 `feedback-v1/api/secret_key.local.php` 中；
   - 公共脱敏配置走 `api/public_config.php`，禁止直读 `config.json`；
   - 本地凭据文件均已加入 `.gitignore`，绝不提交至代码仓库。

2. **Nginx 访问控制与安全硬化**：
   - 面板侧配置片段：`/www/server/panel/vhost/nginx/extension/feedback.wxjifang.cn/zz-feedback-security.conf`；
   - 严格拦截对 `/config.json`、`*.local.php`、`*.conf` 以及 `/data/` 非 PDF 路径的外部直接访问；
   - 纳入版本管理：规则片段存于 `feedback-v1/scripts/nginx/zz-feedback-security.conf`，可通过服务器脚本 `install_nginx_hardening.sh` 或 GitHub Actions `apply-nginx-hardening.yml` 进行一键安装与验证（详见 [nginx-hardening.md](./nginx-hardening.md)）。
