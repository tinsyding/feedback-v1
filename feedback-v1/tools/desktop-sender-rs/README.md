# 极方每周反馈程序 (Rust 原生重构版)

> **定位**：基于 Rust 重构的极方教师端企业微信自动化反馈工具（Windows 原生单执行文件）。  
> **核心目标**：彻底根除杀毒软件误报、实现单 exe 绿色免解压分发、利用 Windows 10/11 原生 OCR 将体积压缩至 8~12MB、毫秒级快速启动。

---

## 一、 为什么用 Rust 重构？

| 指标 | 现有 Python 经典版/Fluent版 (`v2.0`) | Rust 原生重构版 (`v2.0-rust`) |
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
> - **底层安全算法**：100% 对齐 Python 两版共同演进的最新 `v2.0`（包含他人提及防误选、失焦自动挂起、周次正则等）；
> - **产品与 UI 架构**：100% 基于 **新版 Fluent 现代版（`send_feedback_fluent.py`）**，采用 **Navigation Rail 现代侧导航**、多视图分页（工作区/历史/日志/设置）与流式卡片交互，并支持 ☀️/🌙 深浅色无缝切换。

```
desktop-sender-rs/
├── Cargo.toml            # 依赖声明 (tokio, reqwest, image, windows-rs)
├── README.md             # 本说明文档
├── src/
│   ├── main.rs           # PoC CLI / 启动入口
│   ├── lib.rs            # 核心库导出
│   ├── types.rs          # 领域模型 (FeedbackItem, DecisionResult, Candidate)
│   ├── parser.rs         # 学号/姓名正则、周次匹配、JSON/HTML 多策略解析器、决策中枢
│   ├── sender_engine.rs  # 批量发信异步调度引擎与失焦守护状态机
│   ├── image_proc.rs     # 图像预处理管线 (去水印、去彩斑、双三次插值放大)
│   ├── cloud.rs          # 模式 A: 云端大模型视觉 (Qwen3.8-Flash) 与脱敏日志上报
│   └── automation/
│       ├── mod.rs        # 自动化子系统入口
│       ├── win32.rs      # Win32 窗口枚举、句柄激活、DPI 与失焦守护
│       └── win_ocr.rs    # 模式 B: Windows 10/11 原生 Media.Ocr 引擎及联系人行解析
└── tests/
    ├── parser_tests.rs   # 单元测试 (名单解析、去水印放大、他人描述避坑、OCR行解析)
    └── engine_tests.rs   # 批量发信调度与状态机集成测试
```

---

## 三、 本地构建与测试

### 1. 跨平台快速测试（Linux / macOS / Windows 均可）：
```bash
cargo test
cargo run
```
在非 Windows 环境下，Win32 与原生 OCR 会自动采用安全 Mock/Stub 模式，允许快速验证数据解析、图像算法与决策逻辑。

### 2. Windows 本地编译（产出最终原生单 exe）：
```powershell
cargo build --release
```
编译产物位于 `target/release/desktop-sender-rs.exe`，无需任何外部依赖或配套 DLL。
