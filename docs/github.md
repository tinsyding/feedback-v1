# GitHub 配置与 CI/CD 工具链指南 (GitHub & Toolchain Guide)

本文档说明作业反馈与错题本系统的 GitHub 仓库架构、GitHub Actions 自动化流水线、版本发布规范，以及本地开发环境中 GitHub 工具链（SSH、`gh` 命令行与 GitHub MCP Server）的配置与使用方法。

---

## 一、GitHub 仓库与分支规划

- **远程仓库**：
  - GitHub 主源：`git@github.com:tinsyding/feedback-v1.git`
  - Gitee 国内镜像源：`git@gitee.com:tinsysakura/feedback-v1.git`
  - **双推送机制**：本地 `origin` 远程已配置双 `pushurl`，每次执行 `git push` 会同时、自动将提交推送到 GitHub 与 Gitee 两端。
- **核心分支规范**：
  - **`main`**：生产环境主干分支。受保护分支，所有合并至 `main` 的提交将直接触发线上生产环境自动发版。
  - **`staging`**：测试与预发环境分支。用于汇聚各类特性（如预习题库、双专题选择、OCR离线增强等）并在测试站（`feedbacktest.wxjifang.cn`）进行全真验证。
  - **`feat/*`**：特性开发分支。按模块独立开发（例如 `feat/sender-onefile-ui`、`feat/preview-qbank`），通过 PR 方式合入 `staging` 或 `main`。

---

## 二、GitHub Actions 自动化流水线

仓库目前配置了两条自动化流水线，位于 `.github/workflows/`：

### 1. 生产环境自动部署：[`deploy.yml`](../.github/workflows/deploy.yml)
- **触发机制**：Push 到 `main` 分支。
- **并发控制**：设置 `concurrency: production-deploy`，防止多次并发 push 引起部署竞态。
- **运行流程**：
  1. **Secrets 前置检查**：确保必需的环境变量均已在仓库 Secrets 中配置；
  2. **SSH 远程连接**：配置部署密钥并连接目标生产服务器；
  3. **远程拉取与自愈**：在 `/www/wwwroot/JF/feedback-git` 执行 `git pull --ff-only`，并将文件归属与权限重置为 `www:www`（目录 755 / 文件 644）；
  4. **版本一致性比对**：比对服务器 HEAD 与触发 CI 的 `GITHUB_SHA`；
  5. **自动化冒烟测试 (Smoke Test)**：连续探测主站上传页、评语页、题库页、后台管理页、核心校验 API 及学生 VIP 端页面的 HTTP 200 返回码。
- **依赖 Secrets**：
  - `DEPLOY_HOST`：生产服务器 IP（当前 `106.14.62.196`）
  - `DEPLOY_PORT`：SSH 端口（当前 `28964`）
  - `DEPLOY_USER`：SSH 用户（当前 `root`）
  - `DEPLOY_SSH_KEY`：专用的 GitHub Actions 部署私钥

### 2. 客户端打包与自动发布：[`build-sender.yml`](../.github/workflows/build-sender.yml)
- **触发机制**：
  - 推送匹配 `sender-*` 的 tag（例如 `git tag sender-v1.8.10 && git push origin sender-v1.8.10`）；
  - 或在 GitHub Actions 页面手动点击（`workflow_dispatch`）。
- **运行环境**：`windows-latest`
- **构建产物**：
  - `JiFangFeedbackSender-onedir-windows-x64.zip`（极方企业微信反馈发送器免解压运行包）
  - `JiFangFeedbackWeb-onedir-windows-x64.zip`（现代化 WebUI 发送程序运行包）
- **发布逻辑**：
  - 调用 `softprops/action-gh-release@v2` 自动创建 GitHub Release，将上述产物上传为 Release 附件，并附带更新说明。

---

## 三、本机 GitHub 工具链配置

本机已配置全套 GitHub 协同环境，涵盖 Git SSH、GitHub CLI (`gh`) 与 Antigravity 官方 GitHub MCP：

### 1. Git SSH 鉴权（代码传输）
- **密钥路径**：`~/.ssh/id_ed25519`
- **验证命令**：
  ```bash
  ssh -T git@github.com
  # 输出: Hi tinsyding! You've successfully authenticated, but GitHub does not provide shell access.
  ```
- **用途**：保障 `git push`、`git pull`、`git fetch` 免密安全传输。

### 2. GitHub CLI (`gh` 命令行工具)
- **安装位置**：`/home/tinsywsl/.gemini/antigravity-cli/bin/gh`（已软链至 `~/.local/bin/gh`，默认在 PATH 中）
- **配置与权限**：存储于 `~/.config/gh/hosts.yml`，账号为 `tinsyding`，具备 `repo`、`workflow`、`gist` 权限。
- **常用诊断命令**：
  ```bash
  # 查看最近工作流执行情况
  gh run list -L 5

  # 查看某次工作流运行详情与失败日志
  gh run view <RUN_ID> --log

  # 列出最新的客户端版本发布
  gh release list -L 5

  # 查看指定 Release 详情及附带下载链接
  gh release view sender-v1.8.10
  ```

### 3. Antigravity 官方 GitHub MCP Server（AI 原生能力）
- **程序位置**：`/home/tinsywsl/.gemini/antigravity-cli/bin/github-mcp-server`（官方 Go 原生发布版本 v2.0.3）
- **配置文件**：`~/.gemini/config/mcp_config.json`
- **配置内容**：
  ```json
  {
    "mcpServers": {
      "github": {
        "command": "github-mcp-server",
        "args": [
          "stdio",
          "--toolsets=all"
        ],
        "env": {
          "GITHUB_PERSONAL_ACCESS_TOKEN": "您的_GITHUB_TOKEN"
        }
      }
    }
  }
  ```
- **核心价值**：
  - 将 GitHub 平台能力通过 Model Context Protocol 直接转化为 AI 原生工具；
  - 允许 AI 助手在对话中直接读取 Actions 编译日志、查询 Release 附件、检索 Issues 与 Pull Requests，无需开发者切出终端手动执行指令。
