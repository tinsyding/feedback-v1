# GitHub 配置与 CI/CD 工具链说明

说明仓库远程源配置、GitHub Actions 自动化流水线与敏感凭据（Secrets）管理。

## 一、远程仓库与分支

- 远程仓库：
  - GitHub：`git@github.com:tinsyding/feedback-v1.git`
  - Gitee：`git@gitee.com:tinsysakura/feedback-v1.git`
  - 双推送配置：本地 `origin` 配置了双 `pushurl`，执行 `git push` 时会同时推送到 GitHub 与 Gitee。
- 分支约定：
  - `main`：主生产分支，合并或推送后触发生产环境自动部署、代码同步与相关自动化。
  - `feat/*`：功能开发分支，验证完成后合并入 `main`。

## 二、GitHub Actions 工作流

工作流文件位于 `.github/workflows/`：

### 1. 生产环境部署：[`deploy.yml`](../.github/workflows/deploy.yml)
- **触发条件**：Push 到 `main` 分支（自动忽略纯文档 `docs/**`、`**/*.md`、CI 配置与杂项，节省 Actions 分钟数）。
- **并发控制**：`concurrency: production-deploy`，避免并发部署冲突。
- **执行步骤**：
  1. **Secrets 预检**：检查服务器 IP、端口、用户与私钥是否齐全，检验端口合法性；
  2. **部署私钥挂载**：临时生成 `~/.ssh/deploy_key` 并设置 `600` 权限；
  3. **代码检出与对齐**：
     - 临时解除 `.user.ini` 宝塔防跨目录不可变保护 (`chattr -i`)；
     - 执行 `git fetch origin main && git reset --hard $TARGET_SHA`，彻底避免分支分叉或脏数据干扰；
     - 统一属主为 `www:www`，规范权限（目录 755 / 文件 644 / Git 目录 700）；
     - 重新对 `.user.ini` 加锁 (`chattr +i`)；
  4. **增量数据库迁移**：优先调用 PHP 8.2 执行 `scripts/migrate.php migrate`，实现幂等增量迁移；
  5. **刷新 PHP-FPM**：重载 `php-fpm-82` 刷新 opcache 字节码缓存；
  6. **版本与健康冒烟测试**：比对线上 HEAD 与当前 `GITHUB_SHA`，对 10 个核心页面和 API（教师端、学生端、鉴权、配置、CSS/JS 等）执行 HTTP 200 连通性测试；
  7. **清理凭据**：无论执行成功还是失败，均安全擦除临时私钥。

### 2. 客户端构建与发布：[`build-sender.yml`](../.github/workflows/build-sender.yml)
- **架构主线**：以 Web 版客户端（`web_main.py`）为主，Tkinter 桌面版已停止更新。
- **触发条件**：
  - 推送 `sender-*` 格式的 tag（如 `git tag sender-v1.8.23 && git push origin sender-v1.8.23`）；
  - 或在 GitHub Actions 页面手动触发（`workflow_dispatch`）。
- **运行环境**：Linux（快速单元测试）+ Windows（MSVC 编译打包与冒烟验证）。
- **发布流程**：CI 自动注入服务端令牌 `SENDER_API_TOKEN`，编译打包后通过 `softprops/action-gh-release@v2` 创建对应 tag 的 GitHub Release 并上传双附件：
  1. **Nuitka 原生机器码单文件版**：`JiFangFeedbackWeb-nuitka-onefile-windows-x64.exe`（原生 C++ 编译，彻底免疫杀软误报，推荐）；
  2. **普通绿色文件夹压缩包版**：`JiFangFeedbackWeb-onedir-windows-x64.zip`（解压即用）。

### 3. Nginx 安全硬化应用：[`apply-nginx-hardening.yml`](../.github/workflows/apply-nginx-hardening.yml)
- **触发条件**：GitHub Actions 网页端手动触发（`workflow_dispatch`），不随日常代码 push 执行，避免非预期刷新 Nginx。
- **执行步骤**：通过 SSH 远程拉取最新代码，运行 `feedback-v1/scripts/install_nginx_hardening.sh`，备份旧规则、安装版本化片段并执行 `nginx -t` 与 reload，验证敏感路径 404 与 PDF 访问正常。

### 4. 生产数据异地定时备份至 Google Drive：[`backup-production-to-gdrive.yml`](../.github/workflows/backup-production-to-gdrive.yml)
- **触发条件**：每天北京时间凌晨 03:30（UTC 19:30）定时执行，或手动即时触发。
- **备份内容**：
  1. 生产全量 MySQL 数据库 gzip 快照；
  2. 教师上传与题库 PDF 材料（`/data/pdfs/`、`/data/qbank/`、`/data/uploads/`）；
  3. 服务器敏感配置文件（`config.json`、`api/db.local.php`、`api/secret_key.local.php`）。
- **保留策略**：使用 rclone 同步，云端快照默认保留 30 天并自动滚动清理超期文件。

### 5. 代码仓库异地增量同步至 Google Drive：[`sync-google-drive.yml`](../.github/workflows/sync-google-drive.yml)
- **触发条件**：Push 到 `main` 分支时触发，或手动触发。
- **执行步骤**：检出完整仓库并通过 rclone 增量同步至 Google Drive 备份归档目录。

---

## 三、仓库 Secrets 配置清单

在 GitHub 仓库中通过 **Settings → Secrets and variables → Actions → Repository secrets** 进行配置：

| Secret 键名 | 用途 | 适用工作流 | 示例/说明 |
| :--- | :--- | :--- | :--- |
| `DEPLOY_HOST` | 服务器公网 IP | `deploy.yml`, `apply-nginx-hardening.yml`, `backup-production-to-gdrive.yml` | `43.142.104.218`（原 `106.14.62.196`） |
| `DEPLOY_PORT` | SSH 端口 | 同上 | `28964`（须为纯数字） |
| `DEPLOY_USER` | SSH 登录用户 | 同上 | `root` |
| `DEPLOY_SSH_KEY` | 自动化部署私钥 | 同上 | `id_github_actions` 私钥完整文本（含 BEGIN/END 行） |
| `SENDER_API_TOKEN` | 发送器鉴权令牌 | `build-sender.yml` | 打包时注入 exe，使客户端免配连接服务端 |
| `GDRIVE_RCLONE_CONFIG` | Google Drive rclone 配置 | `backup-production-to-gdrive.yml`, `sync-google-drive.yml` | 个人 Google One 账号 OAuth 授权配置（优先） |
| `GDRIVE_SA_JSON` | Google 服务账号 JSON | 同上 | 团队盘服务账号凭据（备用） |
| `GDRIVE_FOLDER_ID` | Google Drive 备份目录 ID | 同上 | 目标云端文件夹 ID（团队盘模式使用） |
