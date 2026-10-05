# 极方每周反馈程序 (Rust 原生重构版)

> **定位**：基于 Rust 重构的极方教师端企业微信自动化反馈工具（Windows 原生单执行文件）。  
> **核心目标**：彻底根除杀毒软件误报、实现单 exe 绿色免解压分发、利用 Windows 10/11 原生 OCR 将体积压缩至 8~12MB、毫秒级快速启动。

---

## 一、 为什么用 Rust 重构？

| 指标 | 现有 Python 经典稳定版 (`v2.0`) | Rust 原生重构版 (`v2.0-rust`) |
| :--- | :--- | :--- |
| **杀毒软件误报** | PyInstaller 打包易被启发式扫描拦截 | **零误报**：LLVM 编译纯原生 PE 64 位机器码，信誉天然极高 |
| **分发方式** | `onedir` 目录式压缩包（教师必须解压） | **单文件免解压**：仅单个 `desktop-sender-rs.exe`，双击即用 |
| **产物体积** | 91.5MB（原）/ ~40MB（当前 zip） | **8MB ~ 12MB**（免去 ONNX Runtime 及其模型大文件） |
| **OCR 方案** | 捆绑 `RapidOCR` + `onnxruntime` + 离线权重 | **零依赖**：直调 Windows 10/11 系统内置 `Windows.Media.Ocr` |
| **冷启动延迟** | 1.5s ~ 3s（Python 解释器加载） | **< 0.1s**（毫秒级瞬开） |
| **内存占用** | 80MB ~ 150MB | **15MB ~ 30MB** |

---

## 二、 架构与版本基准

> **版本基准定位**：
> - **底层安全算法**：100% 对齐 Python 端最新 `v2.0`（包含他人提及防误选、**会话标题安全检查点**、失焦自动挂起、周次正则等）；
> - **产品与 UI 架构**：Python 侧已精简收敛为单一经典稳定版；现代 Fluent 架构（**Navigation Rail 现代侧导航**、多视图分页与卡片交互、☀️/🌙 深浅色无缝切换）由 Rust (Tauri 2.0) 独家接管实现。

```
desktop-sender-rs/
├── Cargo.toml            # 依赖声明 (tokio, reqwest, image, windows-rs)
├── README.md             # 本说明文档
├── src/
│   ├── main.rs           # PoC CLI / 启动入口
│   ├── lib.rs            # 核心库导出
│   ├── types.rs          # 领域模型 (FeedbackItem, DecisionResult, Candidate)
│   ├── parser.rs         # 学号/姓名正则、周次匹配、JSON/HTML 多策略解析器、决策中枢
│   ├── sender_engine.rs  # 批量发信异步调度引擎、会话标题核验与失焦守护状态机
│   ├── header_verify.rs  # 会话标题安全检查点判定 (MATCH/MISMATCH/UNCERTAIN) 与裁剪区域计算
│   ├── debug_shot.rs     # 现场截图归档 (事后举证误发/误拦)
│   ├── log_file.rs       # 持久化调试日志 (5MB 滚动) 与日志上报解析
│   ├── image_proc.rs     # 图像预处理管线 (去水印、去彩斑、双三次插值放大)
│   ├── cloud.rs          # 模式 A: 云端大模型视觉 (Qwen3.8-Flash) 与脱敏日志/历史上报
│   └── automation/
│       ├── mod.rs        # 自动化子系统入口
│       ├── win32.rs      # Win32 窗口枚举、句柄激活、DPI、多屏边界与失焦守护
│       └── win_ocr.rs    # 模式 B: Windows 10/11 原生 Media.Ocr 引擎及联系人行解析
└── tests/
    ├── parser_tests.rs     # 单元测试 (名单解析、去水印放大、他人描述避坑、OCR行解析)
    ├── engine_tests.rs     # 批量发信调度、防误发拦截、留证无副作用与前端配置契约集成测试
    ├── header_verify_tests.rs # 标题核验三态判定与 DPI 自适应裁剪区域单元测试
    ├── log_file_tests.rs   # 日志落盘、滚动归档、任务边界对齐与等级归一化
    └── debug_shot_tests.rs # 截图归档的占位图拒绝、文件名净化与错误传播
```

---

## 三、 本地构建与测试

### 1. 跨平台快速测试（Linux / macOS / Windows 均可）：
```bash
cargo test
cargo run
```
在非 Windows 环境下，Win32 与原生 OCR 会自动采用安全 Mock/Stub 模式，允许快速验证数据解析、图像算法与决策逻辑。

> ⚠️ 注意：会话标题安全检查点在**非 Windows 环境下默认判定为 `UNCERTAIN`（拦截）**，
> 这是刻意设计 —— Mock 驱动拿不到真实标题，若默认放行，会让「未经核验就发信」
> 这类严重缺陷在测试中静默通过。需要放行的测试请显式覆写 `capture_chat_header`。

### 1.5 在非 Windows 上类型检查 Windows 专属代码

`commands.rs` / `win32.rs` 的原生分支在 Linux 上会被 `cfg` 跳过，`cargo test`
**完全无法发现**其中的类型错误。以下技巧可在无 mingw/MSVC 链接器的机器上
把这些分支也真正过一遍类型检查（`cargo check` 不链接，因此不需要 `lib.exe`）：

```bash
# 1) 临时去掉 rustls 特性：ring 需要 C 交叉编译器，是唯一的拦路石
sed -i 's|features = \["json", "rustls-tls"\]|features = ["json"]|' Cargo.toml
# 2) 只检查 lib：bin 目标会因缺少 icons/icon.png 而失败（跨平台编译的既有现象，
#    Windows 真机用 icon.ico 正常）
cargo check --target x86_64-pc-windows-msvc --lib
# 3) 立即还原依赖与 lockfile
git checkout -- Cargo.toml Cargo.lock
```

本项目所有 Windows 专属代码均位于 `lib.rs` 导出的模块内，故 `--lib` 足以覆盖。
此方法已实际查出过 `spawn_esc_stop_watcher` 的实参类型不匹配（`EventSink` vs
`mpsc::Sender`）—— 该缺陷在 Linux 上永远不会被 `cargo test` 发现。

> 有条件时优先依赖 CI（见下节第 3 条）：它在真 Windows 上跑全量测试，
> 比这里的临时交叉检查更权威。

### 防误发核验体系（与 Python 经典版对齐）

发信流程中共有两道核验，**两道都是 fail-closed（核验不通过一律拦截，绝不发送）**：

| 环节 | 判据 | 云端模式 A | 本地模式 B |
| --- | --- | --- | --- |
| 下拉候选定位 | 在搜索结果中定位目标学生本人条目，自动按向下键纠偏 | `vision_detect`（`task=dropdown`） | Windows 原生 OCR |
| **会话标题检查点** | 进入会话后、发送文案前，核验聊天窗口顶部标题是否为目标学生 | `vision_detect`（`task=header`）+ 二次防御 | Windows 原生 OCR |

云端大模型（模式 A）异常时自动无缝降级到本地 OCR（模式 B），不会中断批次。

**大模型二次防御**：模型即便返回 `matched=true`，也一定会用本地字符串复核
`detected_title`；模型说匹配但标题里没有目标学号/姓名时，一律纠偏为 `MISMATCH`。
这是防止大模型幻觉直接放行误发的关键防线，不可移除。

**下拉识别未确立（`choice == -1`）不等于跳过**：此时按经典版语义试探性进入第 1 项，
交由会话标题检查点裁决。这保证「识别存疑」不会导致整批学生漏发。

### 事故举证与复盘（与 Python 经典版对齐）

两道核验只会在界面上留一行文字。为了让「当时屏幕上到底看到了什么」事后可查，
另有一层**只读证据链**，与核验判定完全解耦：

| 证据 | 落盘位置 | 触发时机 |
| --- | --- | --- |
| 持久化调试日志 | `%USERPROFILE%\Documents\JFFeedback\feedback_debug.log`（超 5MB 滚动为 `.bak`，只留一代） | 每条 `Log` 事件，由 `EventSink` 自动分流 |
| 会话标题现场截图 | `…\JFFeedback\debug_screenshots\` | 标题核验判定为 `MISMATCH` / `UNCERTAIN` 时 |
| 下拉候选现场截图 | 同上 | **每一次**下拉判定（全量存档，文件名含 `choiceN_<引擎>`） |

设计上的几条硬约束：

* **日志与截图绝不阻断发信**。写盘失败只记一条 `WARN`，判定与发送结果不受影响
  （`tests/engine_tests.rs` 有专门用例守着这条）。
* **日志用本地时间**。Windows 上走 `GetLocalTime` —— 排查「下午 3 点那次误发」时
  UTC 时间戳毫无参考价值。截图文件名用同源的 `YYYYMMDD_HHMMSS`，保证能与日志对上时刻。
* **上报会按任务边界对齐**。`parse_entries` 对齐到最近一次「批量发送任务启动」标记，
  保证上传片段里至少含一个**完整**任务（启动参数 → 逐人轨迹 → 结束统计），
  而不是从半途开始的一段；硬上限 1000 行封顶。
* 界面「📊 运行与诊断控制台」提供 **📂 载入磁盘日志**（进程重启/崩溃后复盘）
  与 **☁️ 上传诊断日志**（分片上报，批次结束后也会自动后台上报一次）。

> ⚠️ 归档目录取不到时的行为是「跳过并静默」，**不会**退化到临时目录 ——
> 避免截图散落在各处、事后找不到。

### 2. Windows 本地编译（产出最终原生单 exe）：
```powershell
cargo build --release
```
编译产物位于 `target/release/desktop-sender-rs.exe`，无需任何外部依赖或配套 DLL。

### 3. Windows 原生代码由 CI 自动验证

`push` 到 `main` 且改动命中本目录时，`.github/workflows/build-tools-rs.yml`
会在 `windows-latest` 上跑完整的 `cargo test` + `cargo build --release
--target x86_64-pc-windows-msvc`，并把 exe 作为 artifact 上传。

这意味着 `cfg(windows)` 分支**每次改动都会被真机编译与测试覆盖**，不依赖
开发者本机有 MSVC 环境。若本地改动了 `win32.rs` / `commands.rs`，本地
Linux 上跑再多测试也发现不了那部分的问题 —— 请以 CI 结果为准。
