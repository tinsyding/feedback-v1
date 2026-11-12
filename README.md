# 作业反馈与错题本系统

学生作业反馈与错题巩固练习系统：

```text
feedback/
├── docs/          # 架构、API、多环境与 GitHub 工具链文档
└── feedback-v1/   # 线上运行系统 (PHP 8.2 + 原生 HTML/CSS/JS + MySQL)
```

## 文档导航

- [生产环境与运维说明](./docs/environments.md)
- [GitHub 配置与 CI/CD 工具链说明](./docs/github.md)
- [后端 API 接口文档](./docs/api.md)
- [更新日志 (CHANGELOG)](./CHANGELOG.md)
- [桌面端企业微信反馈发送器说明](./feedback-v1/tools/sender_py/README.md)

## 目录说明

### `feedback-v1/`
- 技术栈：PHP 8.2 + 原生 JavaScript / CSS + MySQL
- 主要模块：
  - `upload.html`：教师作业反馈评语上传与批改解析
  - `viewer.html`：教师查看评语、缺交通知与微信话术复制
  - `question-bank.html`：题库与错题本管理
  - `retest.html`：学生错题巩固练习页（支持在线生成与打印 PDF）
  - `admin.html`：管理后台（教师账号管理、日志审计）
  - `api/`：后端各模块接口
  - `data/`：历史记录、日志与临时文件
  - `scripts/`：数据库建表与迁移脚本
- 线上域名：
  - 教师端：`https://feedback.wxjifang.cn`
  - 学生端：`https://vip.wxjifang.cn`

## 站点环境

线上生产环境配置如下：

| 环境 | 服务器 IP / 端口 | 本地别名 | 域名 | 分支 | 部署目录 | 数据库 | 说明 |
| :--- | :--- | :---: | :---: | :--- | :--- | :--- | :--- |
| **主站（生产）** | `43.142.104.218`<br>SSH：`28964` | `jf` | `feedback.wxjifang.cn`<br>`vip.wxjifang.cn` | `main` | `/www/wwwroot/JF/feedback-git` | `feedback` | 正式生产环境，push `main` 自动触发部署、数据库迁移与冒烟检查 |
| **备用（灾备）** | `106.14.62.196`<br>SSH：`28964` | `jf-backup` | - | - | - | - | 备用服务器（Debian 12），关闭密码仅密钥登录，历史全量数据已本地归档 |

- **本地备份**：每天凌晨 03:00 由定时任务自动生成生产数据库物理快照至 `/www/backup/feedback_backup_snapshots/`（滚动保留 7 天）。
- **异地灾备**：每天凌晨 03:30 由 GitHub Actions 将数据库全量快照、题库/教学 PDF 材料与核心脱敏凭据异地备份至 Google Drive（滚动保留 30 天）。

详细的架构与运维约定见 [生产环境与运维说明](./docs/environments.md)。

## GitHub 与自动化流水线

- 生产部署：[`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml)，监听 `main` push，SSH 到服务器执行代码拉取对齐、权限校验、`scripts/migrate.php` 数据库增量迁移、PHP-FPM 重载与 10 项冒烟检查。
- 客户端打包：[`.github/workflows/build-sender.yml`](./.github/workflows/build-sender.yml)，监听 `sender-*` tag，编译 Windows Web 版客户端并发布 GitHub Release（含 Nuitka 原生机器码单文件版与普通绿色压缩包版）。
- 安全硬化：[`.github/workflows/apply-nginx-hardening.yml`](./.github/workflows/apply-nginx-hardening.yml)，手动触发，一键更新并验证生产 Nginx 安全规则片段。
- 异地灾备：[`.github/workflows/backup-production-to-gdrive.yml`](./.github/workflows/backup-production-to-gdrive.yml)，每日定时将生产数据归档同步至 Google Drive。
- 代码同步：[`.github/workflows/sync-google-drive.yml`](./.github/workflows/sync-google-drive.yml)，push 自动将代码库镜像增量同步至 Google Drive。

详细配置、Secrets 清单与分支约定见 [GitHub 配置与 CI/CD 工具链说明](./docs/github.md)。

## 运维与部署约定

- 服务器部署路径：
  - `/www/wwwroot/JF/feedback-git`：Git 仓库克隆（含 `feedback-v1/` 子目录），发版执行 `git fetch & reset`
  - Nginx `root` 指向 `feedback-git/feedback-v1`（旧 `feedback-v1` 目录保留作回滚备用）
  - `/www/wwwroot/JF/feedback`：指向旧 `feedback-v1` 的软链接（兼容旧脚本路径，非线上根目录）
- 线上 Nginx 由宝塔面板管理（`feedback.wxjifang.cn.conf`），仓库内 `feedback-v1/nginx.conf` 为镜像存档；面板侧安全规则位于 `vhost/nginx/extension/feedback.wxjifang.cn/zz-feedback-security.conf`（拦截 `/config.json` 与 `*.local.php`，禁止外部访问除 `/data/pdfs/*.pdf` 外的 `/data/` 目录），面板升级不会覆盖该目录。
- 自动部署：`main` 分支 push 触发 `.github/workflows/deploy.yml`。首次配置需在仓库 Secrets 中填入 `DEPLOY_HOST`（`43.142.104.218`）、`DEPLOY_PORT`（`28964`）、`DEPLOY_USER`、`DEPLOY_SSH_KEY` 等（见 docs 与 workflow 文件头注释）。
- 桌面发送工具：全面以 Web 版（`web_main.py`）为主线，Tkinter 版已停止更新。源码位于 `feedback-v1/tools/sender_py/`，由 `.github/workflows/build-sender.yml` 打包，推送 `sender-*` tag 自动发布 Web 版 Release。
