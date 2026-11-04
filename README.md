# 作业反馈与错题本系统

学生作业反馈与错题巩固练习系统：

```text
feedback/
├── docs/          # 架构、API、多环境与 GitHub 工具链文档
└── feedback-v1/   # 线上运行系统 (PHP 8.2 + 原生 HTML/CSS/JS + MySQL)
```

## 文档导航

- [多环境架构与运维说明（主站 / 测试站 / 备份站）](./docs/environments.md)
- [GitHub 配置与 CI/CD 工具链说明](./docs/github.md)
- [后端 API 接口文档](./docs/api.md)
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

生产环境配置如下：

| 环境 | 域名 | 分支 | 部署目录 | 数据库 | 说明 |
| :--- | :--- | :---: | :--- | :--- | :--- |
| **主站（生产）** | `feedback.wxjifang.cn`<br>`vip.wxjifang.cn` | `main` | `/www/wwwroot/JF/feedback-git` | `feedback` | 正式生产环境，push `main` 自动触发部署与冒烟检查 |

> **注**：原独立的测试站（`feedbacktest`）与热备镜像站（`feedbackbackup`）已于 2026-11-04 完成本地留底归档并下线清理，详见 [环境与运维说明](./docs/environments.md)。每日 03:00 由定时任务自动生成生产数据库物理快照至 `/www/backup/feedback_backup_snapshots/`。

域名解析、数据库隔离与定时同步机制见 [多环境架构与运维说明](./docs/environments.md)。

## GitHub 与自动化流水线

- 生产部署：[`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml)，监听 `main` push，SSH 到服务器执行 `git pull`、权限修复与 10 项冒烟检查。
- 客户端打包：[`.github/workflows/build-sender.yml`](./.github/workflows/build-sender.yml)，监听 `sender-*` tag，编译 Windows 客户端并发布 GitHub Release。

详细配置与分支约定见 [GitHub 配置与 CI/CD 工具链说明](./docs/github.md)。

## 运维与部署约定

- 服务器部署路径：
  - `/www/wwwroot/JF/feedback-git`：Git 仓库克隆（含 `feedback-v1/` 子目录），发版执行 `git pull`
  - Nginx `root` 指向 `feedback-git/feedback-v1`（旧 `feedback-v1` 目录保留作回滚备用）
  - `/www/wwwroot/JF/feedback`：指向旧 `feedback-v1` 的软链接（兼容旧脚本路径，非线上根目录）
- 线上 Nginx 由宝塔面板管理（`feedback.wxjifang.cn.conf`），仓库内 `feedback-v1/nginx.conf` 为镜像存档；面板侧安全规则位于 `vhost/nginx/extension/feedback.wxjifang.cn/zz-feedback-security.conf`（拦截 `/config.json` 与 `*.local.php`），面板升级不会覆盖该目录。
- 自动部署：`main` 分支 push 触发 `.github/workflows/deploy.yml`。首次配置需在仓库 Secrets 中填入 `DEPLOY_HOST`、`DEPLOY_PORT`、`DEPLOY_USER`、`DEPLOY_SSH_KEY`（见 workflow 文件头注释）。
- 桌面发送工具：源码位于 `feedback-v1/tools/sender_py/`，由 `.github/workflows/build-sender.yml` 打包，推送 `sender-*` tag 自动发布 Release。
