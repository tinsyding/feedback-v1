# 极方每周反馈程序 (C++ & Qt 原生重构版)

> **定位**：基于 C++17 与 Qt 6 原生重构的极方教师端企业微信自动化反馈工具（Windows 原生桌面客户端）。  
> **核心目标**：实现毫秒级瞬开启动、20MB 极低内存占用、调用 Win32 原生 API 零胶水损耗、彻底压制杀毒软件误报。

---

## 一、 为什么用 C++ & Qt 重构？

| 评估指标 | Python 经典版 (`send_feedback.py`) | Rust + Tauri 版 (`desktop-sender-rs/`) | C++ & Qt 原生版 (`desktop-sender-cpp/`) |
| :--- | :--- | :--- | :--- |
| **杀毒软件误报** | PyInstaller onefile 易被启发式扫描拦截 | 极低（LLVM 纯机器码） | **极低（MSVC 传统受信度最高）** |
| **启动延迟** | 1.5s ~ 3.0s | < 0.1s | **< 0.05s（毫秒级秒开）** |
| **运行内存** | 80MB ~ 160MB | 20MB ~ 40MB | **20MB ~ 35MB** |
| **系统底层交互** | `pywin32` / `ctypes` 胶水包装 | `windows-rs` 类型转换 | **原生 `<windows.h>`，母语级性能与掌控力** |
| **UI 架构** | Tkinter 原生风格 | HTML5 / CSS / Fluent UI Webview | **Qt 6 Widgets 原生稳健控件** |
| **数据向下兼容** | `%USERPROFILE%\Documents\JFFeedback\*.json` | 100% 格式对齐 | **100% 格式对齐，三端自由无缝切换** |

---

## 二、 模块架构设计

```
desktop-sender-cpp/
├── CMakeLists.txt                # CMake 构建脚本 (自适应 Qt6 / CLI 诊断模式)
├── README.md                     # 本架构与编译指南文档
├── build-local.bat               # Windows 本地一键构建脚本
├── version.rc                    # Windows PE 资源文件 (公司名、版本号、产品名，防杀软误报)
├── assets/
│   └── app.ico                   # 客户端高分辨率图标
├── include/
│   └── nlohmann/json.hpp         # 现代化 JSON 领域模型解析库
├── src/
│   ├── main.cpp                  # 程序入口 (支持 GUI 启动与 --cli 诊断模式)
│   ├── types.h                   # 领域模型 (FeedbackItem, ContactCandidate, DecisionResult)
│   ├── parser.h / .cpp           # 正则解析学号姓名、周次识别、JSON/HTML 多策略解析器
│   ├── image_proc.h / .cpp       # 图像去水印管线 (阈值归一化) 与双三次插值 (Bicubic 2x)
│   ├── history_manager.h / .cpp  # 本地 JSON 档案持久化与断点续发、CSV 报表导出
│   ├── automation/
│   │   ├── automation_driver.h   # 自动化驱动纯虚接口
│   │   ├── win32_driver.h / .cpp # Windows 原生 Win32 API 句柄、截图、按键注入与剪贴板
│   │   └── mock_driver.h         # 跨平台 (Linux/macOS/CI) 安全模拟桩驱动
│   ├── engine/
│   │   ├── sender_engine.h / .cpp # 异步工作线程、防风控休眠、失焦守护状态机
│   └── ui/
│       ├── main_window.h / .cpp   # Qt 6 主窗口逻辑 (名单勾选树、文案实时预览、日志总线)
└── tests/
    └── test_parser.cpp           # 核心业务算法完整单元测试套件
```

---

## 三、 本地构建与验证

### 1. 跨平台快速测试（Linux / macOS / Windows 均可）：
在非 Windows 环境下，CMake 会自动切换为 CLI 诊断与自动化单元测试模式：

```bash
cmake -B build -S .
cmake --build build
./build/run_unit_tests
./build/desktop-sender-cpp --cli
```

### 2. Windows 本地编译（产出 Qt GUI 桌面客户端）：
前提：安装了 Visual Studio (含 MSVC C++ 编译器) 与 Qt 6 (Widgets, Network)。

直接双击运行：
```cmd
build-local.bat
```
或通过命令行：
```cmd
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release
```
产物将自动链接 Qt 并写入带有“极方教育”版本签名的 PE 元数据，有效压制各类杀软拦截。
