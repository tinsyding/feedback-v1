# feedback-api (`backend-go`)

`feedback-api` 是 `feedback-v1` 后端接口的渐进式 Go 重写服务（纯 Go 标准库实现，零第三方依赖），通过 Nginx 精确 `location =` 反代逐接口灰度接管现有 PHP 接口。

## 目录结构

```text
backend-go/
├── .env.example                    # 本地/生产环境变量示例
├── go.mod                          # Go module 定义（仅标准库）
├── cmd/feedback-api/main.go        # 服务入口与路由注册
├── internal/
│   ├── config/                     # .env / config.json 动态读取、凭据解析与 SenderControl 策略
│   ├── httpx/                      # CORS、同源 CSRF、真实 IP、Bearer/Form 鉴权与统一 JSON 响应
│   ├── vision/                     # PNG/JPEG 校验与 OpenAI 兼容多模态客户端
│   └── handler/                    # /healthz 与 Phase 1 业务端点实现
├── deploy/
│   ├── feedback-api.service        # systemd 服务单元模板
│   ├── install_go_service.sh       # systemd 幂等安装脚本（支持 --user/--group/--root/--bin）
│   └── install_nginx_go_proxy.sh   # Nginx 灰度切流与 --rollback 回滚脚本
└── scripts/
    └── parity_test.py              # PHP vs Go 差分一致性测试脚本（Python 3 stdlib）
```

## 当前已接管接口（Phase 1）

- `GET /healthz`：服务健康探针（返回 `{"success":true,"data":{"service":"feedback-api","engine":"go","status":"ok"},"error":null}`）。
- `GET /api/public_config.php`：公开脱敏系统配置（含字段裁剪与区间收敛）。
- `GET|POST /api/calibrate_roi.php`：企业微信整窗截图多模态自动 ROI 校准。
- `POST /api/identify.php`：标题/回复/侧边栏视觉判定与 `data/identify_archive/` 举证存档（14 天滚动清理）。

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
