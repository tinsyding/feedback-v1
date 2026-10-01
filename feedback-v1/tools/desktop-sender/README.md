# 极方每周反馈程序 (Desktop Feedback Sender)

> **版本**：v1.4  
> **定位**：教师端企业微信自动化专属反馈发送程序（Windows 独立桌面客户端）  
> **核心源码**：[`send_feedback.py`](send_feedback.py)  
> **打包配置**：[`send_feedback.spec`](send_feedback.spec) / [`.github/workflows/build-tools.yml`](../../.github/workflows/build-tools.yml)

---

## 目录

- [一、 业务背景与系统定位](#一-业务背景与系统定位)
- [二、 整体架构与数据流转](#二-整体架构与数据流转)
- [三、 核心技术原理与防误发体系](#三-核心技术原理与防误发体系)
  - [1. 模式 B 视觉智能核验 (第一道防线)](#1-模式-b-视觉智能核验-第一道防线)
  - [2. 会话标题安全检查点与自愈回滚 (第二道防线)](#2-会话标题安全检查点与自愈回滚-第二道防线)
  - [3. 图像预处理管线与水印擦除](#3-图像预处理管线与水印擦除)
  - [4. 高 DPI 感知与物理像素对齐](#4-高-dpi-感知与物理像素对齐)
- [四、 防风控与稳定性保障](#四-防风控与稳定性保障)
  - [1. 模拟真人操作与批次休眠](#1-模拟真人操作与批次休眠)
  - [2. 前台窗口失焦守护机制](#2-前台窗口失焦守护机制)
  - [3. 剪贴板竞态与安全核验](#3-剪贴板竞态与安全核验)
- [五、 数据管理与断点续发](#五-数据管理与断点续发)
- [六、 云端诊断与运维上报](#六-云端诊断与运维上报)
- [七、 编译构建与自动化发版](#七-编译构建与自动化发版)

---

## 一、 业务背景与系统定位

在作业反馈与错题巩固系统中，教师完成作业批改后，系统会为每位学生生成专属的个性化反馈文案与错题本落地页专属链接（`https://vip.wxjifang.cn/retest.html?token=...`）。

### 为什么采用客户端自动化？
1. **官方 API 约束**：企业微信应用机器人/第三方接口无法直接、不受限地向外部个人微信（学生家长）发起 1 对 1 私聊，且有严格的会话配额与认证门槛。
2. **零成本与高到达率**：借助教师 PC 端已登录的企业微信客户端会话上下文，模拟人工操作逐一发送，点对点触达家长，沟通自然且免除额外接口成本。

---

## 二、 整体架构与数据流转

```mermaid
flowchart TD
    subgraph Web端
        A["教师批改并生成评语<br/>(upload.html / viewer.html)"] -->|导出数据| B["JSON 数据文件 / HTML 网页快照"]
    end

    subgraph 桌面程序[极方每周反馈程序]
        B --> C["数据解析引擎<br/>(嵌入式 JSON / 表格 / 卡片)"]
        C --> D["名单树状预览与控制面板 (Tkinter)"]
        D --> E["发送执行引擎 (多线程 Worker)"]
    end

    subgraph 系统层与视觉引擎
        E --> F["Win32 API (句柄激活/DPI换算)"]
        E --> G["RapidOCR / PaddleOCR ONNX 引擎"]
        E --> H["PyAutoGUI / Pyperclip (键鼠与剪贴板控制)"]
    end

    subgraph 目标客户端
        F & H --> I["PC 企业微信客户端 (WeCom)"]
        I --> J["学生家长个人微信"]
    end

    subgraph 云端协同
        E -.->|启动/退出异步上报| K["云端诊断接口 (api/desktop.php)"]
    end
```

### 数据载体解析策略
桌面程序支持两种数据载体：
1. **JSON 文件**：标准结构 `[{ "studentName": "90001张三", "message": "..." }]`。
2. **HTML 网页快照**：
   - **策略 1（高保真）**：优先提取 HTML 底部内嵌的 `<script type="application/json" id="feedback-data">`，实现结构化数据 100% 无损还原。
   - **策略 2（DOM 降级）**：解析 `<tr>` 表格中的 `.student-name` 与 `.feedback-content`。
   - **策略 3（卡片降级）**：兼容 Word 导出表格及 `.feedback-card` 布局。

---

## 三、 核心技术原理与防误发体系

家校沟通中，**“发错学生信息”是绝对不可接受的严重事故**。企微搜索输入姓名/学号时，常因群聊提及或备注描述，将“包含他人名字的联系人”排在第一位。

为彻底杜绝误发，程序设计了**模式 A / 模式 B 双引擎智能视觉防御体系**，并构筑了两道不可逾越的纵深闭环防护网：

```mermaid
flowchart TD
    Start["输入学生学号/姓名搜索"] --> D1{"【第一道防线】<br/>下拉候选框智能纠偏"}
    
    subgraph 引擎架构["双引擎并行与平滑降级"]
        D1 -->|优先| ModeA["模式 A: Qwen3.8-Flash 大模型<br/>(校内安全中转 / 语义抗干扰)"]
        ModeA -.->|网络波动或超时| Fallback["自动平滑降级"]
        Fallback -.-> ModeB["模式 B: RapidOCR / WinOCR<br/>(本地离线 / 毫秒级识别)"]
        D1 -->|手动配置| ModeB
    end

    ModeA --> Decision1["候选结果判定"]
    ModeB --> Decision1

    Decision1 -->|第1项即为本人| Enter1["回车进入会话"]
    Decision1 -->|第1项为他人描述，后项为本人| ArrowDown["智能纠偏：自动按【↓】移动光标至本人并回车"]
    Decision1 -->|列表全是他人描述| Intercept1["⛔ DESC_ONLY 安全拦截防误发"]
    Decision1 -->|无此联系人/全局搜索| Skip1["⚠️ NOT_FOUND 安全跳过"]

    Enter1 & ArrowDown --> D2{"【第二道防线】<br/>会话标题安全检查点"}
    
    D2 --> TitleCheck["动态 DPI 截取聊天窗口顶部 Header<br/>(0.35s 切换残影消除缓冲)"]
    TitleCheck --> ModeA_T["模式 A / 模式 B 标题深度核验<br/>(精准识别学号、姓名、微信后缀、emoji花名)"]

    ModeA_T -->|标题完全匹配 MATCH| SafeSend["✓ 粘贴文案并回车发送"]
    ModeA_T -->|标题不符 MISMATCH| SelfHeal{"触发自愈回滚流程"}
    ModeA_T -->|标题无法确认 UNCERTAIN| UncertainBlock["⛔ 存疑安全拦截防盲发"]

    SelfHeal -->|重新搜索并尝试后续候选项| RetryCheck{"二次核验是否通过?"}
    RetryCheck -->|通过| SafeSend
    RetryCheck -->|仍不符| FinalBlock["⛔ HEADER_MISMATCH 强行熔断拦截"]
```

### 1. 双引擎协同架构 (Mode A & Mode B)
- **模式 A (通义千问 Qwen3.8-Flash 大模型 API，推荐默认)**：
  - **超强语义抗干扰**：能敏锐分辨主联系人条目与次级“包含：90001”或“聊天记录：...”他人描述，无惧各种复杂昵称（如“🌺张三妈妈@微信”）、表情符号与群名混淆。
  - **架构安全中转**：客户端将局部截图通过 HTTPS 发送至校内中央服务器（`api/desktop.php?action=vision_detect`），由服务端集中调度阿里云百炼 DashScope 并校验，客户端代码及网络流量中完全不暴露大模型 API Key。
  - **超快响应**：调用参数关闭思考链（`enable_thinking: false`），单次判定耗时仅 300~600ms。
- **模式 B (本地离线 RapidOCR / WinOCR 视觉引擎)**：
  - **纯本地运行**：依托 ONNX 优化的 RapidOCR (PaddleOCR) 或 Windows 原生 WinOCR，无需外网访问，零云端 API 成本。
  - **毫秒级推断**：单张切片 OCR 识别仅需 50~150ms。
- **无缝平滑降级 (Auto Fallback)**：
  - 当启用模式 A 时，若因网络波动、学校防火墙或云端 API 偶发超时导致识别异常，客户端将毫秒级自动无缝回退至模式 B 本地 OCR 引擎继续执行，保障批量发送流水线绝不中断。

### 2. 第一道防线：下拉候选框智能纠偏
- 输入学生学号/姓名后，等待下拉候选列表呈现，自适应截取下拉区域（约 380x460 物理像素）。
- 视觉引擎对候选项列表执行结构化裁决：
  - **情况 1 (choice = 1)**：第 1 项即为本人独立联系人，直接两次回车进入会话。
  - **情况 2 (choice >= 2)**：第 1 项为他人描述（如提及了该学号的聊天记录），本人条目排在第 choice 项。程序自动模拟按 `(choice - 1)` 次【向下键 ↓】纠偏光标后回车进入。
  - **情况 3 (choice = -2 / DESC_ONLY)**：搜索结果全为他人描述或聊天记录，通讯录中不存在独立本人备注，自动清空搜索框并拦截防误发。
  - **情况 4 (choice = 0 / NOT_FOUND)**：无此联系人（显示网络查找或全局搜索），自动安全跳过并记录。

### 3. 第二道防线：会话标题安全检查点与自愈回滚
- **0.35s 切换残影消除**：企微从前一个聊天切换到新聊天时，顶部标题存在几百毫秒的淡入动画与残影。程序预留 0.35s 动画缓冲后再取景，确保截取的画面属于当前新会话。
- **标题深度核实**：截取右侧聊天区域顶部 Header 标题栏（约 400x52 物理像素），深度校验标题是否包含目标学号或目标姓名。
- **自愈纠错与多轮重试**：若标题不符（如误入其他学生或同事聊天），程序绝不输入任何内容，立即拉响警报并触发自愈回滚：重新唤起搜索，尝试按【↓】进入第 2、第 3 项重新比对标题。
- **强行熔断拦截**：若自愈依然不匹配，判定为 `HEADER_MISMATCH`，彻底终止对该学生的发送并清空输入框，100% 杜绝发错人。

### 4. 图像预处理管线与水印擦除 (模式 B)
企业微信窗口带有公司域半透明倾斜背景水印，模式 B 预处理管线执行：
1. 转为灰度图像，消除 ClearType 边缘噪点。
2. **水印消解**：将亮度值 `> 205` 的像素归一化为纯白底色（`255`），擦除倾斜水印文字。
3. **双三次插值（BICUBIC）放大 2 倍**：提升 12px~14px 细小字体的笔画边缘锐利度。

### 5. 高 DPI 感知与物理像素对齐
不同电脑显示器缩放设置（100%、125%、150%、200%）会导致坐标偏差。
- 启动时调用 Windows API `ctypes.windll.user32.SetProcessDpiAwarenessContext(-4)`（Per-Monitor DPI Aware V2）。
- 结合 `win32gui.GetWindowRect` 与 `get_display_scale()` 动态计算物理像素裁剪区域，保证在任意分辨率与多显示器环境下准确无误。

---

## 四、 防风控与稳定性保障

### 1. 模拟真人操作与批次休眠
为避免短时间内高频次自动化调用引起企业微信风控限制：
- **随机抖动延时**：单条之间配置随机浮动间隔（默认 2.0s ~ 5.0s）。
- **批次休息策略**：每连续发送 `batch_size` 人（默认 10 人），强制休眠 `batch_delay` 秒（默认 8.0s）。

### 2. 前台窗口失焦守护机制
- 发送循环中由 `is_foreground_wecom()` 实时巡检前台焦点窗口类名（`WeWorkWindow` / `WXWork`）。
- 一旦教师误点其他应用，或系统弹出弹窗夺走前台焦点，程序毫秒级暂停并告警，彻底避免向其它程序误输内容。

### 3. 剪贴板竞态与安全核验
- `safe_copy()` 写入剪贴板后立即循环回读校验内容，若不一致则多次重试，杜绝因系统剪贴板延迟导致把上一位学生的评语发送给下一位。

---

## 五、 数据管理与断点续发

- **本地存储路径**：数据持久化于用户文档目录 `%USERPROFILE%\Documents\JFFeedback\feedback_history.json`。
- **生命周期状态流转**：
  - `PENDING`：待发送
  - `SUCCESS`：发送成功
  - `NOT_FOUND`：通讯录中无此联系人
  - `DESC_ONLY`：仅有他人描述，智能拦截
  - `HEADER_MISMATCH`：会话标题核验不符，安全熔断
  - `UNCERTAIN_INTERCEPT`：会话身份存疑，安全拦截
  - `FAILED` / `ABORTED`：写入失败或手动中断
- **断点续发**：重复加载相同班级文件时，自动加载历史发送状态，支持“仅选中未发”与“一键重试失败项”。

---

## 六、 云端诊断与运维上报

程序包含单机诊断与远程协助链路：
- 启动与退出时，异步线程调用云端接口 [`api/desktop.php`](../../api/desktop.php)：
  - `action=upload_logs`：上报最近 300 行脱敏日志（含 OCR 决策过程、拦截原因）。
  - `action=upload_history`：上报发送历史快照。
- 管理员可在 Web 管理后台（`admin.html`）直接按 `module=desktop` 筛选查阅各校区教师的客户端运行状态。

---

## 七、 编译构建与自动化发版

本项目通过 GitHub Actions 实现 Windows 云端自动化打包，无需本地搭建复杂的 Windows 编译环境。

### 1. 触发构建
在本地打标签并推送：
```bash
git tag tools-v1.4
git push origin tools-v1.4
```

### 2. 云端流水线
工作流 [`.github/workflows/build-tools.yml`](../../.github/workflows/build-tools.yml) 将在 Windows Server 环境中自动执行：
1. 安装 Python 3.11 与锁定依赖（[`requirements.txt`](requirements.txt)）。
2. 使用 PyInstaller 与 [`send_feedback.spec`](send_feedback.spec) 完成单文件打包并注入图标。
3. 自动发布至 GitHub Releases，产物命名为 `极方每周反馈程序-v1.4.exe`。
