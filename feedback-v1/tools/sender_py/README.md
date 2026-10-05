# sender_py（重写版企业微信反馈发送器，mss + ROI 反推）

目录说明（阶段 1 骨架，详 docs 待阶段 7 补全）：

- `sender.py`：主流程（阶段 6）
- `window_utils.py`：企微窗口查找/DPI（Windows 调用隔离）
- `capture.py`：mss 整窗截图 + `crop_by_rel` 纯函数
- `roi_manager.py`：窗口签名/ROI 存储/反推（阶段 3 纯函数）
- `roi_calibrator.py`：两框校准 UI（阶段 4）
- `vision_api.py`：云端判定客户端（阶段 5）
- `reply_notes.py`：待回名单本地模型（fail-open）
- `store.py`：发送历史存档，兼容读旧 `feedback_history.json`
- `utils.py`：输入契约（`测试.json` 解析）纯函数
