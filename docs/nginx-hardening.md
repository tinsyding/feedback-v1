# nginx 安全硬化与版本管理

## 为什么需要

线上主站的 nginx 由宝塔面板管理，线上配置不在代码仓库里。之前出现过 `/data/vision_config.json` 和 `/data/identify_archive/` 被公网直接下载的问题，因此把安全规则做成可版本化的片段，避免重装/迁移时丢失。

## 版本化文件

- 安全片段：`feedback-v1/scripts/nginx/zz-feedback-security.conf`
- 安装脚本：`feedback-v1/scripts/install_nginx_hardening.sh`
- 参考镜像：`feedback-v1/nginx.conf`（只作存档，不自动覆盖线上面板配置）

片段放在 `scripts/nginx/` 下，是因为 nginx 线上配置已经禁止访问 `/scripts/`，不会把规则文件本身变成新的暴露面。

## 规则内容

- 禁止直读 `/config.json`
- 禁止访问 `*.local.php`
- 禁止下载 `*.conf` 配置文件（包括 `/nginx.conf`）
- 仅允许 `/data/pdfs/*.pdf` 静态下载，其余 `/data/` 一律 404

## 如何应用

### 方式一：在服务器上手动运行（推荐）

```bash
sudo bash /www/wwwroot/JF/feedback-git/feedback-v1/scripts/install_nginx_hardening.sh
```

脚本会备份旧文件、安装片段、执行 `nginx -t`，失败自动回滚；成功后 reload，并验证：

- `/data/vision_config.json` → 404
- `/data/identify_archive/` → 404
- `/nginx.conf` → 404
- 任一 `/data/pdfs/*.pdf` → 200

### 方式二：GitHub Actions 手动运行

GitHub → Actions → **Apply nginx hardening** → Run workflow。

该工作流使用与生产部署相同的 Secrets，SSH 到服务器后执行 `git pull` 和安装脚本。它是手动触发的，不会随普通代码 push 自动执行。

## 注意事项

- 只把片段提交到 GitHub 不会自动改动线上 nginx；必须运行安装脚本或手动工作流。
- 不要把整份线上 `nginx.conf` 自动覆盖到服务器，面板生成的配置包含服务器专属内容。
- 线上片段文件权限为 `600 root:root`，备份位于 `/root/nginx-hardening-backups/`。
