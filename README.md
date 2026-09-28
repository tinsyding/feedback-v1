# 作业反馈与错题本系统 (Feedback System)

学生作业反馈与错题巩固练习系统（v2 已于 2026-09-28 下线移除，仓库与线上均已删除）：

```text
feedback/
└── feedback-v1/   # 当前系统 (PHP 8.2 + 原生 HTML/CSS/JS + MySQL)
```

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
- 桌面工具发版：`git tag tools-x.y && git push origin tools-x.y` 触发
  `.github/workflows/build-tools.yml`，在云端构建 `反馈工具-x.y.exe`
  并挂到同名 Release（构建参数锁定见 `tools/desktop-sender/requirements.txt`）。
