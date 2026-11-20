# Feedback-V1 Go 后端渐进迁移指南

本文档记录 `feedback-v1` 从 PHP 8.2 (FPM) 向 Go (`feedback-api`) 渐进迁移的架构原则、灰度切流（Staging / Production）操作手册、1 秒回滚方案及 Phase 0~4 演进路线图。

---

## 一、迁移架构与切流原理

采用 **Strangler Fig（绞杀者）模式** 在 Nginx 层按精确接口路径逐个接管流量：

1. **零侵入并行运行**：Go 服务 `feedback-api` 作为独立 systemd 常驻进程监听本机 `127.0.0.1:8090`，直接挂载现有 `feedback-v1/` 目录，动态按请求读取 `config.json` 与 `data/identify_archive/`，不缓存后台实时修改的配置。
2. **Nginx 精确路由覆写**：[`feedback-v1/scripts/nginx/zz-feedback-go-proxy.conf`](../feedback-v1/scripts/nginx/zz-feedback-go-proxy.conf) 使用 `location = /api/<endpoint>.php` 精确匹配转发到 `http://127.0.0.1:8090`。在 Nginx `location` 优先级规则中，精确匹配 `=` 始终高于 `enable-php-82.conf` 的正则匹配 `location ~ \.php$`（与 `include` 顺序无关）。
3. **作用域隔离**：`client_max_body_size 15m` 与 `proxy_*` 超时配置仅写在各 `location =` 块内，不影响 PHP 端其他大文件接口（如 `upload_pdf.php` 的 20MB 或 `retest.php` 临时下载的 25MB 限制）。
4. **可观测性标识**：Go 后端所有响应均附带 `X-Backend-Engine: go` 响应头，切流或回滚后可通过 `curl` 一眼确认实际承载引擎。

---

## 二、CI/CD 零风险发布设计

[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) 已集成 Go 自动化构建与发布，且保证在服务器尚未切流时安全无副作用：

1. **Runner 构建与测试（含 `GOCACHE` 缓存）**：使用 `actions/setup-go@v5`（`cache: true`）配合 `actions/cache@v4` 缓存 `~/.cache/go-build`，运行 `go test -race -count=1 ./...`，并交叉编译静态二进制 `CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o dist/feedback-api ./cmd/feedback-api`。
2. **原子替换二进制**：通过 `scp` 上传至 `/opt/feedback-go/feedback-api.new`，设置 `www:www` 与 `755` 后原子 `mv -f` 覆盖 `/opt/feedback-go/feedback-api`。
3. **条件重启与探活**：仅当 `systemctl is-enabled feedback-api` 成功时才重启 `feedback-api`；仅当服务处于 `active` 状态时探测 `http://127.0.0.1:8090/healthz` 返回 HTTP 200。未安装 systemd unit 前推送 `deploy.yml` 不会中断生产 PHP 链路。
4. **PHP 发布链路保留**：原有代码检出、`.user.ini` 加解锁、`scripts/migrate.php migrate`、`php-fpm-82 reload` 及 10 项全量冒烟测试保持不变。

---

## 三、本地开发与前置验收

在任意机台切流前，必须在本地跑通 Go 单测与 PHP/Go 差分测试：

```bash
# 1. Go 单元测试与竞态检测
cd backend-go
go test -race -count=1 ./...

# 2. 编译 Linux amd64 二进制
mkdir -p dist
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o dist/feedback-api ./cmd/feedback-api

# 3. 差分一致性校验（并发启动 php -S 与 feedback-api 比对响应与存档）
python3 scripts/parity_test.py --go-bin dist/feedback-api
```

更多本地环境变量说明见 [`backend-go/README.md`](../backend-go/README.md)。

---

## 四、Staging 切流手册：`jf-backup`（Debian 12 / `www-data`）

`jf-backup`（`106.14.62.196`，SSH 端口 `28964`）为干净精简的 Debian 12 系统，Nginx 与 PHP-FPM 运行用户为 `www-data:www-data`，站点 Nginx 配置非宝塔目录结构。

### 1. 准备二进制并安装 systemd 服务

```bash
# 在 jf-backup 上以 root 执行（假设仓库已检出在 /www/wwwroot/JF/feedback-git，
# 且二进制已上传至 /opt/feedback-go/feedback-api；也可附带 --from <path> 直接复制）：
sudo bash /www/wwwroot/JF/feedback-git/backend-go/deploy/install_go_service.sh \
  --user www-data \
  --group www-data \
  --root /www/wwwroot/JF/feedback-git/feedback-v1 \
  --bin /opt/feedback-go/feedback-api
```

脚本会自动：
- 校验 `www-data` 用户/组与 `FEEDBACK_ROOT` 目录存在；
- 创建 `/etc/feedback-api`（`750 root:www-data`，用于可选的 `env` 密钥文件）；
- 生成并安装 `/etc/systemd/system/feedback-api.service`（已将 `User=`/`Group=` 改写为 `www-data`）；
- 执行 `systemctl daemon-reload && systemctl enable feedback-api && systemctl restart feedback-api`；
- 探测 `http://127.0.0.1:8090/healthz` 返回 `200`。

### 2. 挂载 Nginx 灰度反代片段

确认 `jf-backup` 的站点 `server {}` 中已包含某个片段目录（例如 `include /etc/nginx/snippets/feedback-*.conf;` 或 `include /etc/nginx/snippets/zz-feedback-*.conf;`），然后运行：

```bash
# 若 jf-backup 使用标准 HTTP 80 或测试域名，请按实际 vhost 调整参数：
sudo bash /www/wwwroot/JF/feedback-git/backend-go/deploy/install_nginx_go_proxy.sh \
  --target-dir /etc/nginx/snippets \
  --sites feedbackbackup.wxjifang.cn \
  --verify-scheme https \
  --verify-port 443
```

> 若预发站仅开放 HTTP 80 端口验证，可传 `--verify-scheme http --verify-port 80`。

### 3. Staging 核验

```bash
systemctl status feedback-api --no-pager
curl -sS http://127.0.0.1:8090/healthz
curl -skI --resolve feedbackbackup.wxjifang.cn:443:127.0.0.1 \
  https://feedbackbackup.wxjifang.cn/api/public_config.php | grep -i x-backend-engine
# 预期输出：x-backend-engine: go
```

---

## 五、生产环境切流手册：`jf`（Ubuntu / 宝塔 / `www`）

主站 `jf`（`43.142.104.218`，SSH 端口 `28964`）使用宝塔面板 Nginx + PHP 8.2 FPM，运行用户为 `www:www`，代码目录为 `/www/wwwroot/JF/feedback-git/feedback-v1`，扩展片段目录为 `/www/server/panel/vhost/nginx/extension/feedback.wxjifang.cn/`。

### 1. 确认二进制已就位

推入 `main` 后，GitHub Actions `deploy.yml` 已自动将测试通过的二进制放置于 `/opt/feedback-go/feedback-api`（`755 www:www`）。也可登录 `jf` 检查：

```bash
ls -lh /opt/feedback-go/feedback-api
```

### 2. 安装并启动 systemd 服务

```bash
sudo bash /www/wwwroot/JF/feedback-git/backend-go/deploy/install_go_service.sh
```

默认参数即为 `--bin /opt/feedback-go/feedback-api --user www --group www --root /www/wwwroot/JF/feedback-git/feedback-v1`。等待输出 `PASS feedback-api 已就绪：http://127.0.0.1:8090/healthz => HTTP 200`。

### 3. 安装 Nginx 灰度反代片段并自动核验

```bash
sudo bash /www/wwwroot/JF/feedback-git/backend-go/deploy/install_nginx_go_proxy.sh
```

脚本会执行以下保护动作：
1. **切流前硬门禁**：先请求 `http://127.0.0.1:8090/healthz`，非 200 直接拒绝安装 Nginx 片段。
2. **备份与权限收敛**：备份既有配置到 `/root/nginx-go-proxy-backups/<timestamp>/`，以 `600 root:root` 写入 `/www/server/panel/vhost/nginx/extension/feedback.wxjifang.cn/zz-feedback-go-proxy.conf`。
3. **`nginx -t` 自动回滚保护**：校验失败自动恢复备份并退出，不 reload 坏配置。
4. **切流后实测**：通过 `curl --resolve` 校验 `https://feedback.wxjifang.cn/api/public_config.php` 与 `/api/calibrate_roi.php` 返回 HTTP 200 且包含 `X-Backend-Engine: go`。

> 注意：`feedback.wxjifang.cn.conf` 的 `server_name` 同时覆盖 `vip.wxjifang.cn`（其中 `/api/public_config.php` 已放行），因此无需为 `vip` 单独建立扩展目录。

### 4. 生产运行观察

```bash
# 查看 Go 服务实时日志
journalctl -u feedback-api -f

# 检查 identify 举证存档是否正常落盘
ls -lt /www/wwwroot/JF/feedback-git/feedback-v1/data/identify_archive/ | head
```

---

## 六、1 秒回滚至 PHP 操作指南

若切流后发现任何异常（接口报错、响应延迟或业务逻辑差异），可立即将全部灰度接口切回 PHP 8.2 FPM，全程耗时约 1 秒且无需重启 Go 或 PHP 进程。

### 方式 A：使用脚本一键回滚并自动校验（推荐）

```bash
# 生产机 (jf)
sudo bash /www/wwwroot/JF/feedback-git/backend-go/deploy/install_nginx_go_proxy.sh --rollback

# 备用机 (jf-backup)
sudo bash /www/wwwroot/JF/feedback-git/backend-go/deploy/install_nginx_go_proxy.sh \
  --rollback --target-dir /etc/nginx/snippets --sites feedbackbackup.wxjifang.cn
```

脚本会备份并删除 `zz-feedback-go-proxy.conf`，执行 `nginx -t && nginx -s reload`，并确认 `/api/public_config.php` 与 `/api/calibrate_roi.php` 返回 HTTP 200 且不再带有 `X-Backend-Engine: go`。

### 方式 B：紧急手工 1 秒回滚

```bash
sudo rm -f /www/server/panel/vhost/nginx/extension/feedback.wxjifang.cn/zz-feedback-go-proxy.conf \
  && sudo nginx -t && sudo nginx -s reload
```

如需同时彻底停止并禁用 Go 服务（避免后续 CI 再次重启它）：

```bash
sudo systemctl disable --now feedback-api
```

---

## 七、Phase 0 ~ Phase 4 演进路线图

结合现有 `feedback-v1/api/` 与 [`feedback-v1/scripts/schema.sql`](../feedback-v1/scripts/schema.sql) 表结构，Go 化迁移分五个阶段推进：

| 阶段 | 范围与核心目标 | 对应现有 PHP 模块 / 基础设施 | 切流与验证策略 |
| :--- | :--- | :--- | :--- |
| **Phase 0**<br>底座与工具链 *(已完成)* | 搭建 `feedback-api` 骨架、动态 `config.json` / `secret_key.local.php` 读取、CORS/CSRF/IP/JSON 中间件、`/healthz`、systemd/Nginx 脚本、CI 构建（含 `GOCACHE`）与差分测试框架 | `api/bootstrap.php`<br>`api/secret_key.php`<br>`api/sender_control_helper.php`<br>`.github/workflows/deploy.yml` | `go test -race` + `parity_test.py --php-only` 与双端比对；CI 仅预置二进制不改动线上流量 |
| **Phase 1**<br>无状态配置与 AI 视觉接口 *(已完成)* | 接管无数据库连接的高延迟/高并发外部模型调用与公开配置接口，释放 PHP-FPM Worker 阻塞 | `api/public_config.php`<br>`api/calibrate_roi.php`<br>`api/identify.php`<br>`data/identify_archive/` | `parity_test.py` 全量对齐 + `zz-feedback-go-proxy.conf` 精确 `location =` 灰度切流 + `X-Backend-Engine: go` 校验 |
| **Phase 2**<br>共享 Session 与文件/日志接口 *(当前)* | 落地 MySQL `app_sessions` 共享会话底座（消除 PHP 文件 Session 攻击面）；接管 PDF 上传、前端采集归档与更新日志 | `api/session_mysql.php` (`008_app_sessions_table.sql`)<br>`api/upload_pdf.php`<br>`api/upload_capture.php`<br>`api/changelog.php` | Go 引入 `go-sql-driver/mysql` 只读校验 `app_sessions.payload_json`；`zz-feedback-go-proxy.conf` 扩展 6 个 `location =` 并用真实 PHP 会话跨引擎验证 |
| **Phase 3**<br>MySQL 核心业务与后台管理 | 迁移教师认证、系统日志审计、题库 CRUD、管理后台与版本历史 | `api/auth.php`、`api/logs.php`、`api/sender_control_helper.php`、`api/qbank.php`、`api/admin.php`（`api/admin/*`） | 复用 `app_sessions` 与 `db.local.php`；针对分页、排序、事务回滚与权限拦截建立 DB 差分用例 |
| **Phase 4**<br>错题本重练域与 PHP 下线 | 迁移最复杂的家长端错题本域（Token 三级解析、SVG 验证码、临时 PDF 暂存下载、清理任务）与迁移运行器，完成全量切换并下线 PHP-FPM | `api/retest.php`、`api/lib_retest_*.php`、`api/lib_normalize.php`、`scripts/migrate.php` | 双轨并行观测稳定周期后，移除 `enable-php-82.conf` 与 PHP-FPM 依赖，由 Go 直接承接全部 `/api/*` |
