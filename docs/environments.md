# 反馈系统多环境架构与运维指南 (Environments Manual)

本文档详细记录作业反馈与错题本系统的**主站（生产站）**、**测试站（预览站）**与**备份站（应急站）**的架构规划、域名解析、Git 分支策略、数据库隔离与自动化运维机制。

---

## 一、三套环境核心概览

| 维度 | 主站（生产站 / Production） | 测试站（预览站 / Staging） | 备份站（应急暖备 / Backup） |
| :--- | :--- | :--- | :--- |
| **教师端域名** | `https://feedback.wxjifang.cn` | `https://feedbacktest.wxjifang.cn` | `https://feedbackbackup.wxjifang.cn` |
| **学生 VIP 错题本** | `https://vip.wxjifang.cn`<br>*(别名: `vip.jokerx.top`)* | 自动对齐当前域名（`https://feedbacktest.wxjifang.cn/retest.html`） | 自动对齐当前域名（`https://feedbackbackup.wxjifang.cn/retest.html`） |
| **Git 分支** | **`main`** | **`staging`** | **`main`** |
| **服务器目录** | `/www/wwwroot/JF/feedback-git/feedback-v1` | `/www/wwwroot/JF/feedback-test/feedback-v1` | `/www/wwwroot/JF/feedback-backup/feedback-v1` |
| **对应数据库** | `feedback` (独立账户: `tinsy`) | `feedback_test` (独立账户: `feedback_test`) | `feedback_backup` (独立账户: `feedback_backup`) |
| **发布与同步方式** | GitHub Actions CI/CD 监听 `main` push 自动部署 | 开发人员手动或经由测试分支部署/验证 | 每天凌晨 03:00 自动从主站全量克隆快照与静态文件 |
| **核心定位** | 线上稳定运营环境，要求最高可用性 | 提前验证预习题库、双专题、UI改版等新特性 | 生产环境的暖备容灾镜像，支持突发事故快速顶上 |

---

## 二、详细架构设计与实现机制

### 1. 主站（Production）
- **路径规范**：
  - 源码仓库位于 `/www/wwwroot/JF/feedback-git`；
  - Nginx 根目录指向 `/www/wwwroot/JF/feedback-git/feedback-v1`；
  - 旧路径 `/www/wwwroot/JF/feedback` 为软链接，保留兼容历史脚本。
- **自动发版链路**：
  - 本地推送到 GitHub `main` 分支后，触发 `.github/workflows/deploy.yml`；
  - GitHub Actions 通过 SSH 免密登录服务器执行 `git pull --ff-only`；
  - 自动将新增文件权属交还 `www:www` 并修正目录为 `755`、文件为 `644`；
  - 触发包含 10 个核心页面与 API 接口的 HTTP 200 冒烟测试。

### 2. 测试站（Staging）
- **路径规范**：
  - 独立目录 `/www/wwwroot/JF/feedback-test`，内含完整 git 仓库，检出至 `staging` 分支；
  - 根目录指向 `/www/wwwroot/JF/feedback-test/feedback-v1`。
- **环境隔离与安全性**：
  - **物理隔离**：拥有完全独立的数据库 `feedback_test` 和独立的存储目录，绝不会被主站备份任务覆盖；
  - **目录安全**：配置独立的 `.user.ini`，限制 `open_basedir=/www/wwwroot/JF/feedback-test/:/tmp/`，严防跨站点文件读取；
  - **配置自适应**：后端 `api/bootstrap.php` 会动态识别并放行 `*.wxjifang.cn` 跨域；前端 `js/viewer.js` 的 `getRetestBaseUrl()` 会在检测到 `feedbacktest` 域名时自动将生成的错题本链接锁定在当前测试站下，避免测试数据串入生产学生端。

### 3. 备份站（Backup / Disaster Recovery）
- **路径规范**：
  - 独立目录 `/www/wwwroot/JF/feedback-backup`，代码保持与 `main` 分支一致；
  - 根目录指向 `/www/wwwroot/JF/feedback-backup/feedback-v1`。
- **每日自动快照与同步机制**：
  - **定时任务**：`/etc/cron.d/feedback-backup-sync`（每天凌晨 03:00 执行）；
  - **执行脚本**：`/root/feedback_backup_sync.sh`；
  - **同步逻辑**：
    1. 使用 `mysqldump --single-transaction` 对生产库 `feedback` 做一致性热导出；
    2. 压缩备份到 `/www/backup/feedback_backup_snapshots/`（自动滚动清理 7 天前快照）；
    3. 将数据导入中转库 `feedback_backup_staging`，校验学生表与题目表记录数无误；
    4. 执行数据库原子重命名（`RENAME TABLE`）切换至 `feedback_backup`；
    5. 使用 `rsync -av --delete` 增量同步运行期目录（`data/pdfs/`、`data/uploads/`、`data/qbank/`、`data/history/` 等）。
  - **执行日志**：`/var/log/feedback_backup_sync.log`。

---

## 三、证书管理与安全规范

1. **SSL 证书自动续签**：
   - 脚本：`/root/feedback_backup_renew_cert.sh`；
   - 计划任务：每周一凌晨 04:00；
   - 证书覆盖：同时包含 `feedbacktest.wxjifang.cn` 与 `feedbackbackup.wxjifang.cn`；
   - 到期前 30 天内通过 Let's Encrypt / ACME 自动签发并执行 Nginx 热重载（`nginx -s reload`）。
2. **机密文件隔离守则**：
   - 数据库凭据统一存放在各站私有的 `feedback-v1/config.json` 或 `*.local.php` 中；
   - Nginx 硬化规则（`vhost/nginx/extension/*/zz-feedback-security.conf`）已全局拦截对 `/config.json` 与 `*.local.php` 的 HTTP 访问；
   - 各站私有凭据已被 `.gitignore` 忽略，严禁提交到 Git 版本控制中。
