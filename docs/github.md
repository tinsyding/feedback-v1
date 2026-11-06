# GitHub 配置与 CI/CD 工具链说明

说明仓库远程源配置与 GitHub Actions 自动化工作流。

## 一、远程仓库与分支

- 远程仓库：
  - GitHub：`git@github.com:tinsyding/feedback-v1.git`
  - Gitee：`git@gitee.com:tinsysakura/feedback-v1.git`
  - 双推送配置：本地 `origin` 配置了双 `pushurl`，执行 `git push` 时会同时推送到 GitHub 与 Gitee。
- 分支说明：
  - `main`：主生产分支，合并或推送后触发生产环境自动部署。
  - `feat/*`：功能开发分支，验证完成后合并入 `main`。

## 二、GitHub Actions 工作流

工作流文件位于 `.github/workflows/`：

### 1. 生产环境部署：[`deploy.yml`](../.github/workflows/deploy.yml)
- 触发条件：Push 到 `main` 分支。
- 并发控制：`concurrency: production-deploy`，避免并发部署冲突。
- 执行步骤：
  1. 检查仓库 Secrets 是否齐全；
  2. 通过 SSH 连接生产服务器；
  3. 在 `/www/wwwroot/JF/feedback-git` 执行 `git pull --ff-only`，并将文件属主与权限重置为 `www:www`（目录 755 / 文件 644）；
  4. 校验服务器 HEAD 与当前 `GITHUB_SHA` 一致；
  5. 请求主站主要页面、接口及学生端页面，检查 HTTP 200 状态码。
- 仓库 Secrets：
  - `DEPLOY_HOST`：服务器 IP（`106.14.62.196`）
  - `DEPLOY_PORT`：SSH 端口（`28964`）
  - `DEPLOY_USER`：SSH 用户（`root`）
  - `DEPLOY_SSH_KEY`：部署私钥

### 2. 客户端构建与发布：[`build-sender.yml`](../.github/workflows/build-sender.yml)
- 架构主线：以 Web 版客户端（`web_main.py`）为主，Tkinter 桌面版已停止更新。
- 触发条件：
  - 推送 `sender-*` 格式的 tag（如 `git tag sender-v1.8.23 && git push origin sender-v1.8.23`）；
  - 或在 GitHub Actions 页面手动触发（`workflow_dispatch`）。
- 运行环境：Linux（单元测试）+ Windows（MSVC 编译打包与冒烟验证）。
- 发布流程：编译打包后通过 `softprops/action-gh-release@v2` 创建对应 tag 的 GitHub Release 并上传双附件：
  1. **Nuitka 原生机器码单文件版**：`JiFangFeedbackWeb-nuitka-onefile-windows-x64.exe`（原生 C++ 编译，彻底免疫杀软误报，推荐）；
  2. **普通绿色文件夹压缩包版**：`JiFangFeedbackWeb-onedir-windows-x64.zip`（解压即用）。
