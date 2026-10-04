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
│   ├── debug_shot.rs     # 核验拦截时的现场截图归档 (事后举证误发/误拦)
│   ├── image_proc.rs     # 图像预处理管线 (去水印、去彩斑、双三次插值放大)
│   ├── cloud.rs          # 模式 A: 云端大模型视觉 (Qwen3.8-Flash) 与脱敏日志上报
│   └── automation/
│       ├── mod.rs        # 自动化子系统入口
│       ├── win32.rs      # Win32 窗口枚举、句柄激活、DPI、多屏边界与失焦守护
│       └── win_ocr.rs    # 模式 B: Windows 10/11 原生 Media.Ocr 引擎及联系人行解析
└── tests/
    ├── parser_tests.rs     # 单元测试 (名单解析、去水印放大、他人描述避坑、OCR行解析)
    ├── engine_tests.rs     # 批量发信调度、防误发拦截与前端配置契约集成测试
    └── header_verify_tests.rs # 标题核验三态判定与 DPI 自适应裁剪区域单元测试
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

### 2. Windows 本地编译（产出最终原生单 exe）：
```powershell
cargo build --release
```
编译产物位于 `target/release/desktop-sender-rs.exe`，无需任何外部依赖或配套 DLL。
