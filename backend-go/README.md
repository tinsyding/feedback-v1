# feedback-api (`backend-go`)

`feedback-api` 是 `feedback-v1` 后端接口的渐进式 Go 重写服务，通过 Nginx 精确 `location =` 反代逐接口灰度接管现有 PHP 接口，并与 PHP 共用 MySQL `app_sessions` 会话表实现登录态无缝互通。

## 目录结构

```text
backend-go/
├── .env.example                    # 本地/生产环境变量示例（含 DB_* 覆盖项）
├── go.mod / go.sum                 # Go module 定义（go-sql-driver/mysql + x/crypto/bcrypt）
├── cmd/feedback-api/main.go        # 服务入口与路由注册
├── internal/
│   ├── auditlog/                   # MySQL system_logs + data/logs/*.jsonl 双写审计日志
│   ├── auth/                       # 前台教师/管理员认证与助教管理仓储层（bcrypt/SHA256）
│   ├── captcha/                    # 零外部字库 PNG 图形验证码生成器（130×42）
│   ├── config/                     # .env / config.json / data/.ai_secrets.json / db.local.php 动态读取
│   ├── db/                         # MySQL 连接池初始化（mysql.Config）
│   ├── normalize/                  # 学期/年级/学科归一化与 10 位错题本短码派生（对齐 lib_normalize.php）
│   ├── qbank/                      # 题库专题与题目事务仓储、元数据清洗与孤儿 PDF 引用清理
│   ├── ratelimit/                  # MySQL auth_rate_limits 共享防爆破限频存储
│   ├── senderctrl/                 # 桌面发送器单机云控覆盖与远程指令队列（data/sender_control/）
│   ├── senderlogs/                 # 桌面发送器日志分片、批次汇总与现场快照管理（data/sender_logs/）
│   ├── session/                    # app_sessions 共享读写会话、Regenerate 与鉴权中间件
│   ├── syslogs/                    # system_logs 分页检索、UTF-8 BOM CSV 导出与滑动窗口上报限流
│   ├── httpx/                      # CORS、同源/严格同主机 CSRF、真实 IP、Bearer 鉴权与统一 JSON 响应
│   ├── vision/                     # PNG/JPEG 校验与 OpenAI 兼容多模态客户端
│   └── handler/                    # /healthz 与 Phase 1/2/3.1~3.3 业务端点实现
├── deploy/
│   ├── feedback-api.service        # systemd 服务单元模板
│   ├── install_go_service.sh       # systemd 幂等安装脚本（支持 --user/--group/--root/--bin）
│   └── install_nginx_go_proxy.sh   # Nginx 灰度切流与 --rollback 回滚脚本
└── scripts/
    └── parity_test.py              # PHP vs Go 差分一致性测试脚本（Python 3 stdlib）
```

## 当前已接管接口（Phase 1 + Phase 2 + Phase 3.1~3.3）

- `GET /healthz`：服务健康探针（返回 `{"success":true,"data":{"service":"feedback-api","engine":"go","status":"ok"},"error":null}`）。
- `GET /api/public_config.php`：公开脱敏系统配置（含字段裁剪与区间收敛）。
- `GET|POST /api/calibrate_roi.php`：企业微信整窗截图多模态自动 ROI 校准。
- `POST /api/identify.php`：标题/回复/侧边栏视觉判定与 `data/identify_archive/` 举证存档（14 天滚动清理）。
- `POST /api/upload_pdf.php`：题库知识点 PDF 上传（需教师/管理员登录态，拦截助教，校验 `%PDF` 魔数与 20MB 限制）。
- `POST /api/upload_capture.php`：前端原始采集文件归档（需登录态，写 `data/uploads/` 与 `index.jsonl`，30 天概率清理）。
- `GET|POST /api/changelog.php`：系统更新日志读取（`getAll`/`getActive` 公开）与管理维护（`save`/`delete`/`setActive` 需管理员会话）。
- `GET|POST /api/auth.php`：前台教师/管理员认证（`captcha`/`check`/`login`/`logout`/`reset_password`）与助教账号 CRUD（`assistant_*`），与 PHP 共用 `app_sessions` 与 `auth_rate_limits`。
- `GET|POST|DELETE /api/qbank.php`：题库专题列表与详情查询、事务双表保存（含变式题知识点级联与孤儿 PDF 引用清理）及删除（助教仅可读禁写）。
- `GET|POST|DELETE /api/logs.php`：前端日志限频上报、管理后台检索/筛选/7 天统计/CSV 导出/删除，以及桌面发送器日志同步、现场快照、单机云控覆盖与远程指令下发（全部 15 个 action）。

所有 Go 响应均携带响应头 `X-Backend-Engine: go`，便于联调与灰度假期核验。

## 本地开发与测试

### 1. 运行单元测试

```bash
cd backend-go
go test -race -count=1 ./...
```

### 2. 编译本地二进制 / Linux 生产产物

```bash
cd backend-go

# 本地运行编译
go build -o bin/feedback-api ./cmd/feedback-api

# Linux amd64 静态编译（与 GitHub Actions CI 一致）
mkdir -p dist
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o dist/feedback-api ./cmd/feedback-api
```

### 3. 本地启动服务

服务默认监听 `127.0.0.1:8090`，需要通过 `FEEDBACK_ROOT` 指向 `feedback-v1/` 目录（动态按请求读取 `config.json`，并可只读回退解析 `api/secret_key.local.php`）：

```bash
cd backend-go
cp .env.example .env   # 按需填写临时测试 Key，勿提交 .env

FEEDBACK_LISTEN_ADDR=127.0.0.1:8090 \
FEEDBACK_ROOT="$(cd ../feedback-v1 && pwd)" \
FEEDBACK_ENV_FILE="$(pwd)/.env" \
  ./bin/feedback-api
```

验证健康探针与接口：

```bash
curl -i http://127.0.0.1:8090/healthz
curl -i http://127.0.0.1:8090/api/public_config.php
```

### 4. PHP vs Go 差分一致性测试

使用 `backend-go/scripts/parity_test.py` 在临时隔离目录中并发启动 `php -S`、Go 二进制及 Mock Vision API，逐项校验状态码、响应头、JSON 字段与存档落盘：

```bash
# 仅验证 PHP 基线
python3 backend-go/scripts/parity_test.py --php-only

# PHP vs Go 双端全量差分比对
python3 backend-go/scripts/parity_test.py --go-bin backend-go/bin/feedback-api
```

## 环境变量与配置优先级

1. `FEEDBACK_LISTEN_ADDR`：监听地址，默认 `127.0.0.1:8090`。
2. `FEEDBACK_ROOT`：`feedback-v1` 站点根目录（用于读取 `config.json`、`api/secret_key.local.php` 及写入 `data/identify_archive/`）。
3. `FEEDBACK_ENV_FILE`：可选 `.env` 文件路径（仅填充尚未设置的进程环境变量，不覆盖系统已有环境变量）。
4. `FEEDBACK_SECRETS_FILE`：可选 JSON 密钥文件路径。
5. 密钥与模型优先级（严格对齐 PHP 实现）：
   - `SenderAPIToken`：`SENDER_API_TOKEN` 环境变量 → 密钥文件 `senderApiToken` → 未配置时仅接受内置默认 Token。
   - `VisionAPIKey`：`config.json["dashscopeApiKey"]` → `DASHSCOPE_API_KEY` 环境变量 → `FEEDBACK_SECRETS_FILE` / `secret_key.local.php`。
   - `IdentifyAPIBase` / `IdentifyModel` / `IdentifyFastModel`：同理优先读取 `config.json`，缺失再依次回退环境变量与密钥文件。

## 部署与运维文档

- Staging（`jf-backup`）、生产环境（`jf`）切流、1 秒回滚及 Phase 0~4 迁移路线图见：[docs/go-migration.md](../docs/go-migration.md)。
