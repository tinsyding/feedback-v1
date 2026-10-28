# 作业反馈与错题本系统 (Feedback System)

学生作业反馈与错题巩固练习系统：

```text
feedback/
├── docs/          # 架构、API、多环境与 GitHub 工具链文档
└── feedback-v1/   # 当前运行系统 (PHP 8.2 + 原生 HTML/CSS/JS + MySQL)
```

---

## 项目文档导航

- 📘 [多环境架构与运维指南 (主站 / 测试站 / 备份站)](./docs/environments.md)
- 🛠️ [GitHub 配置与 CI/CD 工具链指南 (Actions / Releases / gh CLI / MCP)](./docs/github.md)
- 🔌 [后端 API 接口设计文档](./docs/api.md)
- 📦 [桌面端微信反馈发送器说明](./feedback-v1/tools/sender_py/README.md)

---

## 目录结构说明

### `feedback-v1/`（稳定运行版）
- **技术栈**：PHP 8.2 + 原生 JavaScript / CSS + MySQL
- **核心模块**：
  - `upload.html`：教师作业反馈评语上传与批改解析
  - `viewer.html`：教师查看评语、缺交通知与微信话术一键复制
  - `question-bank.html`：校区题库与错题本管理中心
  - `retest.html`：学生与家长端专属错题巩固练习落地页（支持 PDF 在线生成与打印）
  - `admin.html`：管理员后台（教师账号管理、系统日志审计）
  - `api/`：后端各功能模块 API 接口
  - `data/`：持久化历史记录、日志与临时缓存
  - `scripts/`：数据库建表与历史数据迁移脚本
- **线上对应**：
  - 教师端：`https://feedback.wxjifang.cn`
  - VIP 家长学生端：`https://vip.wxjifang.cn`

---

## 站点环境架构 (主站 / 测试站 / 备份站)

系统在生产服务器上规划并运行了三套相互隔离的站点环境：

| 环境 | 域名 | 对应分支 | 部署目录 | 核心职责 |
| :--- | :--- | :---: | :--- | :--- |
| **主站 (生产站)** | `feedback.wxjifang.cn`<br>`vip.wxjifang.cn` | `main` | `/www/wwwroot/JF/feedback-git` | 正式生产环境，push `main` 自动触发 CI/CD 部署与冒烟测试 |
| **测试站 (预览站)** | `feedbacktest.wxjifang.cn` | `staging` | `/www/wwwroot/JF/feedback-test` | 独立数据库（`feedback_test`），承载新特性提前验证 |
| **备份站 (应急暖备)** | `feedbackbackup.wxjifang.cn` | `main` | `/www/wwwroot/JF/feedback-backup` | 每天 03:00 自动热快照与文件增量同步，作为主站容灾回退站 |

> 完整的多环境域名解析、数据库隔离策略与 Cron 同步机制详见：[多环境架构与运维指南](./docs/environments.md)。

---

## GitHub 配置与自动化流水线

1. **GitHub Actions 持续集成**：
   - 生产自动部署：[`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml)（监听 `main` push，SSH 到服务器执行 `git pull` + 权限修复 + 10 项冒烟检查）。
   - 客户端打包：[`.github/workflows/build-sender.yml`](./.github/workflows/build-sender.yml)（监听 `sender-*` tag，自动编译 Windows 单文件与 WebUI 双版本并发布 GitHub Releases）。
2. **本机开发工具链**：
   - **Git SSH**：已绑定 `tinsyding` 账号免密连接；
   - **GitHub CLI (`gh`)**：已就绪，可在终端直接执行 `gh run list`、`gh release view`；
   - **GitHub MCP Server**：已配置官方 Go 原生版 MCP（`github-mcp-server`），为 AI 助手提供原生的 GitHub Actions、Releases 与 Issue 操作工具。

> 完整的工具链配置与使用范例详见：[GitHub 配置与 CI/CD 工具链指南](./docs/github.md)。

---

## 运维与部署规范

- 远端服务器部署路径标准：
  - `/www/wwwroot/JF/feedback-git` -> git 仓库克隆（含 `feedback-v1/` 子目录），发版即 `git pull`
  - nginx `root` 直接指向 `feedback-git/feedback-v1`（旧 `feedback-v1` 目录保留作紧急回滚）
  - `/www/wwwroot/JF/feedback` -> 指向旧 `feedback-v1` 的软链接（兼容旧路径，已非线上根）
- 线上 nginx 由宝塔面板管理（`feedback.wxjifang.cn.conf`），仓库 `feedback-v1/nginx.conf`
  为线上镜像存档；面板侧硬化片段位于
  `vhost/nginx/extension/feedback.wxjifang.cn/zz-feedback-security.conf`
  （拦截 `/config.json` 与 `*.local.php`），面板升级不会覆盖该目录。
- 自动部署：`main` 分支每次 push 触发 `.github/workflows/deploy.yml`，
  经 GitHub Actions ssh 到服务器执行 `git pull` + 权限修复 + 冒烟检查。
  首次配置需在仓库 Secrets 中填入 `DEPLOY_HOST/DEPLOY_PORT/DEPLOY_USER/DEPLOY_SSH_KEY`
 （详见 workflow 文件头注释）。
- 桌面工具：旧 `desktop-sender` 及其云端打包工作流已移除（历史版本可从 git 历史取回）；
  重写版源码位于 `feedback-v1/tools/sender_py/`，由 `.github/workflows/build-sender.yml`
  构建单文件 `极方每周反馈程序.exe`，推送 `sender-*` tag 自动发布 GitHub Release，
  详见该目录 README。
