# 极方每周反馈程序（sender_py）

基于 `mss` 整窗截图、相对比例裁剪与多级身份核验（本地 OCR + 云端视觉模型）的企业微信学情反馈批量发送工具。

> [!IMPORTANT]
> **架构主线声明**：本项目已全面切换为**以 Web 版为主线**（入口：`web_main.py`）。传统的 Tkinter 原生桌面版（`sender.py`）已归档冻结且**不再进行功能更新**；GitHub Releases 同时发布 **Nuitka 原生机器码单文件版**（`JiFangFeedbackWeb-nuitka-onefile-windows-x64.exe`，彻底免疫杀软误报）与 **普通绿色文件夹压缩包版**（`JiFangFeedbackWeb-onedir-windows-x64.zip`）。

提供本地 Web 控制面板（内置零发送评测模块、视窗诊断核验现场留存、窗口出屏拉回保护），并通过 GitHub Actions 自动编译发布。

真实发送需在 Windows + 企业微信桌面版环境运行；全套纯函数单元测试可在 Linux / Windows 下直接运行。

## 1. 设计背景与机制

旧版发送器依赖固定屏幕像素坐标，更换显示器、修改分辨率、调整窗口大小或系统缩放后容易截错区域。当前版本采用以下机制：

1. `mss` 整窗截取与出屏拉回：截取企业微信窗口；当窗口部分移出屏幕边界时调用 Windows API 拉回可视区域。
2. 自动窗口标定与手动框选回退：
   - 校准前自动检索联系人（首位学生或「文件传输助手」）进入会话；
   - 优先调用 `Qwen3.8-Max` 识别顶部标题栏与底部输入框，自动计算相对坐标；
   - 自动识别失败或离线时回退到两框手动校准画板。
3. 三级身份核验：
   - 第 1 层：`winocr`（Windows 原生 WinRT OCR，约 47ms）；
   - 第 2 层：`RapidOCR`（ONNX 离线检测与识别，约 800ms）；
   - 第 3 层：`Qwen3.8-Flash`（云端视觉模型校验）；
   - 姓名容错：学号完全匹配且非群聊时，允许姓名存在 1 个字的 OCR 形近字容错。
4. 安全边界（Fail-Closed）：
   - 群聊一律拦截；
   - 身份未明确匹配不放行；
   - 底层键盘钩子拦截 Esc 物理按键，避免停止发送时误将企业微信最小化；
   - 剪贴板写入后读回校验，防止粘贴残留内容。

## 2. 目录结构

```text
feedback-v1/tools/sender_py/
├── web_main.py            # Web 版主入口（推荐：本地 HTTP 服务 + 自动呼出浏览器）
├── web_companion.py       # Web 版桌面微型伴随控制台（提供桌面常驻、防误关一键恢复与退出联动）
├── web_server.py          # 标准库 REST API 与 SSE 实时事件流服务
├── web_controller.py      # Web 端状态管理、文件去重与任务控制
├── web_ui.html            # Web 控制面板前端页面（原生 JS/CSS，主线界面）
├── sender.py              # Tkinter 桌面版（已冻结不再更新，保留兼容参考）
├── local_ocr.py           # 本地双层 OCR（winocr + RapidOCR）
├── benchmark.py           # 多引擎识别基准评测模块（零发送、并发比对、CSV 导出）
├── version_info.txt       # Windows exe 属性页版本元数据
├── window_utils.py        # 企微窗口枚举、DPI 感知、键鼠注入、出屏拉回、全局 Esc 钩子
├── capture.py             # mss 整窗截图与相对比例裁剪
├── roi_manager.py         # ROI 签名、相对比例存取、聊天区几何反推
├── roi_calibrator.py      # 两框手动校准画板
├── vision_api.py          # 云端窗口校准与视觉核验 API 客户端
├── reply_notes.py         # 本地待回名单管理与 CSV 导出
├── store.py               # 本地发送历史（断点续发）与已发记录归档
├── pacing.py              # 随机停顿控制（≤ 1 秒）
├── utils.py               # 输入解析（JSON 数组与 HTML 网页快照）
├── verify_stage2_win.py   # Windows 截图验证脚本
├── verify_stage4_win.py   # Windows ROI 校准验证脚本
└── tests/                 # 单元测试集（95 项）
```

配套文件：

- `feedback-v1/tools/example.png`：校准引导示意图（可选）。
- `feedback-v1/tools/测试.json`：示例输入数据。

## 3. 环境要求

- Windows 10 / 11（真实发送）
- 企业微信桌面版，已登录
- Python 3.10+（建议 3.11 / 3.12）
- 可访问判定服务端（默认 `https://feedback.wxjifang.cn`）
- 服务端 `api/identify.php` 已配置发送器令牌与视觉服务

安装依赖：

```powershell
cd feedback-v1\tools
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r sender_py\requirements.txt
```

Linux 下仅运行单测时不需要 `pywin32` / `mss`。

## 4. 发送器令牌说明

正式发布版（由 GitHub Actions 构建的 exe）会在构建时自动注入服务端令牌，**老师端开箱即用，无需手动配置**。

令牌来自 GitHub Actions Secret `SENDER_API_TOKEN`，构建时生成 `sender_token.py` 并打包进 exe；该文件不会提交到仓库。由于令牌在 exe 内，属于共享密钥，请勿公开分发源码或构建产物给无关人员；如怀疑泄露，更新 Secret 后重新构建发布即可。

从源码直接运行（未经过 CI 注入）时，仍可用以下方式覆盖：

方式一：环境变量

```powershell
setx SENDER_API_TOKEN "你的自定义令牌"
```

设置后重新打开终端生效。

方式二：配置文件

```text
%USERPROFILE%\.sender_py\config.json
```

```json
{
  "token": "你的自定义令牌"
}
```

服务端对应配置位于 `feedback-v1/api/secret_key.local.php` 的 `senderApiToken`。

## 5. 输入格式与运行方式

输入文件支持 JSON 数组或网站导出的 HTML 快照。JSON 格式示例：

```json
[
  {
    "studentName": "90001张三",
    "message": "张三家长您好，\n以下是本周反馈……"
  }
]
```

- `studentName` 原样用于企业微信搜索，支持 `90001张三`、`90001,张三`、`90001，张三`、`90001-张三` 等格式。
- `message` 中的 `\n` 原样保留。
- 必须包含学号。服务端判定要求标题同时包含「学号 + 姓名」才返回 `matched: true`；缺少学号不放行。
- 真实学生名单、聊天内容与截图包含个人信息，请保存在本地或已加入 `.gitignore` 的路径中，勿提交到仓库。

网站「导出报告 → HTML 快照」生成的文件同样支持导入（优先读取内嵌的 `feedback-data` JSON，旧版快照回退解析表格 DOM），支持同时混选多个 JSON 与 HTML 文件，按「学号 + 姓名」自动合并去重（保留首次出现项）。

运行命令：

```powershell
cd feedback-v1\tools

# 方式一：Web 控制面板（推荐，主线版本）
python sender_py\web_main.py

# 方式二：Tkinter 桌面版（已冻结不再更新）
python sender_py\sender.py --input 测试.json
```

命令行参数：

```text
--input    输入 JSON / HTML 路径；省略时尝试加载 测试.json，不存在则启动后在界面选择
--server   判定服务端地址，默认 https://feedback.wxjifang.cn
--version  输出程序名与版本号并退出
```

界面主要功能：

- 学生列表：支持勾选/取消勾选、查看状态（待发送、发送中、已发送、发送失败、已跳过、已拦截、未匹配）、双击状态查看原因，以及单条「复制学号姓名」「复制话术」。
- 筛选与重试：支持按学号或姓名搜索、按状态筛选、「只看失败」及「重试失败项」。
- 发送与停止：点击「开始发送」弹窗确认人数；发送中可按 `Esc` 或点击停止按钮，在当前学生处理完毕后停止，剩余勾选学生记为「已跳过」。

### GitHub Actions 编译与发布

推送 `feedback-v1/tools/sender_py/**` 到 `main` / `feat/**` 分支，或在 Actions 页面手动触发 `Build sender_py (Windows)`：

1. Linux 任务运行 `compileall` 与单元测试；
2. Windows 任务执行导入与界面冒烟检查、打包可执行文件并验证启动；
3. 需要发布正式版本时，推送 `sender-*` tag（如 `sender-v1.8.12`），工作流会自动创建 GitHub Release 并上传打包产物。

由于 GitHub Releases 会改写中文附件名，直接下载的单文件 exe 采用英文文件名，解压 zip 可获得中文文件名 `极方每周反馈程序.exe`。产物未做商业代码签名。

## 6. 窗口校准

首次运行，或企业微信窗口尺寸、系统 DPI 缩放变化时，会触发窗口校准。

### 自动标定

1. 将企业微信置于前台，自动快捷键检索首位学生（或「文件传输助手」）进入会话；
2. 调用 `api/calibrate_roi.php` 识别右侧会话顶部标题栏与底部输入框；
3. 客户端校验坐标合法性后反推中间聊天区域，写入配置生效。

界面顶部提供「校准视野」按钮，可随时手动触发重新校准。

### 手动框选（回退方式）

若网络离线或自动识别返回异常，会弹出手动校准画板：

1. 点击「知道了，开始框选」；
2. 框选顶部标题栏（蓝框）；
3. 框选底部输入框（红框）；
4. 自动生成中间聊天区绿色虚线预览，确认后保存。

校验规则：仅框选标题栏和输入框（原图尺寸宽 ≥ 40、高 ≥ 20），输入框位于标题栏下方，反推聊天区高度 ≥ 40px，且均在截图范围内。

配置文件路径：

```text
%USERPROFILE%\.sender_py\roi_config.json
```

配置按窗口签名 `宽x高@DPI缩放` 归档，存储相对比例：仅拖动窗口位置无需重校准；改变窗口大小或系统缩放会自动触发重新校准。

Windows 冒烟脚本：

```powershell
cd feedback-v1\tools
python sender_py\verify_stage2_win.py
python sender_py\verify_stage4_win.py
```

脚本会在 `%TEMP%` 下生成调试截图与配置，验证后请手动清理。

## 7. 单人发送与核验流程

1. 唤起企业微信窗口，若窗口超出屏幕边界则自动拉回并等待重绘；
2. 检查 ROI 签名，命中缓存则直接使用，未命中则执行校准；
3. `Ctrl+F` 搜索学生，按候选 1 → 2 → 3 依次定位；若触发企业微信「全局搜索」弹窗（说明无匹配联系人），自动关闭弹窗并跳过后续候选；
4. `mss` 截取整窗并裁剪出标题栏与聊天区尾部；
5. 执行三级身份核验（`winocr` → `RapidOCR` → `Qwen3.8-Flash`），学号一致且非群聊时允许姓名 1 字形近容错；
6. 动作决策：
   - `is_group = true`：拦截，不发送；
   - `matched = true`：校验剪贴板并粘贴发送；
   - `matched` 非 true 或接口异常：切换下一候选；
   - 3 个候选均未匹配：记为 `unmatched`，不发送；
7. 随机短暂停顿后处理下一名学生。

发送中按 `Esc` 键通过 Windows 底层键盘钩子（`WH_KEYBOARD_LL`）拦截，防止触发企业微信自身快捷键导致窗口最小化。

## 8. 本地历史、已发记录与待回名单

### 发送历史（断点续发）

```text
%USERPROFILE%\.sender_py\feedback_history.json
```

存档键为「输入文件名 [第 1 周]」，默认开启「已发送自动跳过」（`SKIP_SENT = True`），重新载入文件时自动跳过已发送学生。

### 已发记录归档

每批次发送完成后，在 `%USERPROFILE%\.sender_py\sent_records/` 下生成：
- `{时间戳}_{文件名}_已发记录.json`
- `{时间戳}_{文件名}_已发记录.html`（可离线用浏览器直接打开查看）

### 待回名单

- 发送期间后台线程提取家长最后一条消息及回复意向；
- 「待回名单」展示需回复（`needs_reply=true`）或待确认（`needs_reply` 未知）的学生，包含学号、姓名、判定结果、最新家长留言与复制按钮；
- 点击单行「复制」可复制紧凑格式的学号姓名（如 `90001张三`），并将该行标记为已复制；
- 支持导出带 BOM 的 UTF-8 CSV 文件；
- 待回名单仅保存在本地，不上传云端。

## 9. 云端上传声明

与 `vision_api.py` 顶部注释一致：

> 每次判定调用云端视觉 API 时，通过 HTTPS 上传 title.png、chat_tail.png 两张裁剪图与 target_id/target_name 等请求字段，这是判定所必需的，由所配置的视觉服务端处理与留存，使用前请确认服务商隐私政策。服务端收到后存档两图 + 请求/返回 JSON 用于举证复盘。客户端本地默认不长期存判定原图；reply_notes 只存本地展示给老师，不自动上报云端。

## 10. 数据与隐私说明

- 调用云端判定时经 HTTPS 上传 `title.png`、`chat_tail.png` 及目标学号姓名；
- 服务端归档裁剪图与请求/返回 JSON 用于复盘排查，保留期 14 天；
- 客户端本地默认不持久保存判定原图，待回名单仅保存在本地；
- 发送器令牌、服务端密钥、真实学生数据均不可提交至 Git。

## 11. 测试

Linux / Windows 纯函数单元测试：

```bash
cd feedback-v1/tools
PYTHONPATH=. python3 -m unittest discover -s sender_py/tests -v
```

共 95 项测试，涵盖输入解析、HTML 快照提取、去重、ROI 比例与几何反推、双层本地 OCR、姓名容错与群聊拦截、基准评测模块、云端返回判定矩阵、候选切换、全局键盘钩子、窗口拉回、Web 控制器与本地归档等逻辑。

Windows 真机回归建议覆盖：
1. 首次自动校准、保存及重启复用；
2. 调整窗口大小或缩放后触发重校准；
3. 目标学生匹配并正常发送；
4. 同名/相似联系人不匹配时切换候选；
5. 群聊拦截；
6. 3 个候选均不匹配时记为 `unmatched`；
7. 待回名单显示与单行复制、CSV 导出；
8. 断网或云端异常时回退本地 OCR；
9. 发送中按 `Esc` 停止且企业微信不最小化；
10. Web 面板查看本地已发 HTML 报告。

## 12. 打包方式与杀软误报说明

因调用截图与窗口控制 API 且未做商业代码签名，部分杀毒软件（如 360 安全卫士）可能对 PyInstaller 单文件自解压行为产生误报。项目支持三种打包方式：

| 打包方式 | 产物形式 | 运行机制 | 误报情况 | 适用场景 | 本地打包脚本 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1. 文件夹版 (`--onedir`) | ZIP 压缩包（解压为目录） | 直接加载目录内依赖，不向 `Temp` 解压 | 低 | 日常分发，解压后运行目录内 exe | `build_onedir.bat` |
| 2. Nuitka 编译版 | ZIP 压缩包（原生二进制目录） | 转译为 C++ 编译为本地机器码 | 极低 | 杀软策略严格的机房或终端 | `build_nuitka.bat` |
| 3. 单文件版 (`--onefile`) | 单个 `.exe` 文件 | 启动时自解压至 `AppData\Local\Temp` | 较高（易触发启发式拦截） | 临时单文件拷贝测试 | `build_onefile.bat` |

本地可运行 `tools/sender_py/build_all.bat` 选择打包模式；推送 `sender-*` tag（如 `sender-v1.8.26`）或手动触发 GitHub Actions 工作流时会自动构建并发布 **Nuitka 原生机器码单文件版**（`JiFangFeedbackWeb-nuitka-onefile-windows-x64.exe`）与 **普通绿色文件夹压缩包版**（`JiFangFeedbackWeb-onedir-windows-x64.zip`）。GitHub Releases 已停止收录 Tkinter 桌面版产物。

## 13. 已知限制

- 构建产物未签名，如单文件版被拦截，建议使用文件夹版或 Nuitka 编译版；
- 真实发送依赖 Windows 与企业微信桌面版，若企业微信客户端界面改版需做真机回归；
- 停止操作在当前学生发送流程结束后生效，不中途截断正在执行的粘贴；
- 云端视觉不可用时仅回退本地 OCR 或跳过候选，不会在未核验身份的情况下盲发。

## 14. 常见问题

**Q：提示“缺少发送器令牌”或“鉴权失败”？**

请先升级到最新发布版 exe。正式发布版会在构建时自动注入服务端令牌，默认无需配置。旧版 exe 仍然使用已被服务端禁用的默认令牌，不会自动变好。如果从源码运行，请设置 `SENDER_API_TOKEN` 或 `~/.sender_py/config.json`。

**Q：频繁触发重新校准？**

校准配置按 `宽x高@DPI缩放` 保存，改变企业微信窗口大小或系统显示缩放比例都会触发重新校准。

**Q：截图截到了其他窗口？**

发送器会尝试将企业微信置顶并拉回屏幕内；若被置顶窗口遮挡导致失败，请手动移开遮挡窗口后重试。

**Q：搜到了学生但没有发送？**

身份核验未返回 `matched: true`，或识别为群聊触发了拦截。可在运行日志中查看具体候选的核验结果。
