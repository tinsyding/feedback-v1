use crate::parser::{parse_html, parse_json};
use crate::sender_engine::EngineCommand;
use crate::types::FeedbackItem;
use std::fs;
use std::path::Path;
use std::sync::Mutex;
use tokio::sync::watch;

/// 全局应用状态容器，持有引擎运行时的控制句柄
#[derive(Default)]
pub struct AppState {
    pub cmd_tx: Mutex<Option<watch::Sender<EngineCommand>>>,
}

/// 解析指定路径的数据文件（支持 .json 或 .html/.htm）
pub fn handle_load_data_file(path_str: &str) -> Result<Vec<FeedbackItem>, String> {
    let path = Path::new(path_str);
    if !path.exists() {
        return Err(format!("文件不存在: {}", path_str));
    }
    let content = fs::read_to_string(path).map_err(|e| format!("读取文件失败: {e}"))?;
    if path_str.ends_with(".json") {
        parse_json(&content).map_err(|e| e.to_string())
    } else {
        parse_html(&content)
    }
}

#[cfg(windows)]
pub mod tauri_bridge {
    use super::*;
    use crate::automation::{find_wecom_window, WinAutomationDriver};
    use crate::cloud::CloudClient;
    use crate::sender_engine::{EngineConfig, EngineEvent, SenderEngine};
    use std::sync::Arc;
    use tauri::{AppHandle, Emitter, State};
    use tokio::sync::mpsc;

    /// 构造云端诊断客户端
    ///
    /// 之前这里传的是 `None`，导致 `cloud.rs` 里的 `vision_detect` /
    /// `upload_logs` 成为永不调用的死代码——UI 上「强制默认启用 AI 视觉
    /// 双保险体系」实际并未生效。现按经典版 `DEFAULT_CLOUD_SERVER`（send_feedback.py:1190）
    /// 接上真实客户端。
    fn build_cloud_client() -> Arc<CloudClient> {
        Arc::new(CloudClient::from_env_or_default())
    }

    #[tauri::command]
    pub fn check_wecom_status() -> bool {
        find_wecom_window().is_some()
    }

    /// 后台线程以 80ms 粒度轮询物理 ESC 键（0x1B），上升沿触发 Stop。
    /// 任务结束（cmd 通道关闭）后线程自行退出，不残留。
    fn spawn_esc_stop_watcher(
        cmd_tx: watch::Sender<EngineCommand>,
        event_tx: mpsc::Sender<EngineEvent>,
    ) {
        use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
        std::thread::spawn(move || {
            let mut was_down = false;
            let mut last_fire =
                std::time::Instant::now() - std::time::Duration::from_secs(3600);
            loop {
                if cmd_tx.is_closed() {
                    break;
                }
                let down = unsafe { (GetAsyncKeyState(0x1B) as u16) & 0x8000 != 0 };
                if down
                    && !was_down
                    && last_fire.elapsed() > std::time::Duration::from_millis(600)
                {
                    last_fire = std::time::Instant::now();
                    let _ = cmd_tx.send(EngineCommand::Stop);
                    let _ = event_tx.try_send(EngineEvent::log(
                        "WARN",
                        "检测到 ESC 按键，已强制终止发信任务",
                    ));
                }
                was_down = down;
                std::thread::sleep(std::time::Duration::from_millis(80));
            }
        });
    }

    #[tauri::command]
    pub fn load_data_file(path: String) -> Result<Vec<FeedbackItem>, String> {
        handle_load_data_file(&path)
    }

    #[tauri::command]
    pub async fn start_send(
        app: AppHandle,
        state: State<'_, AppState>,
        items: Vec<FeedbackItem>,
        config: EngineConfig,
    ) -> Result<(), String> {
        let (cmd_tx, cmd_rx) = watch::channel(EngineCommand::Start);
        let (event_tx, mut event_rx) = mpsc::channel::<EngineEvent>(100);
        // 全局 ESC 急停监听（对应经典版 safe_sleep 的 GetAsyncKeyState 轮询）：
        // 发信期间焦点在企微窗口，前端收不到键盘事件，必须原生层监听。
        spawn_esc_stop_watcher(cmd_tx.clone(), event_tx.clone());
        {
            let mut guard = state.cmd_tx.lock().map_err(|e| e.to_string())?;
            *guard = Some(cmd_tx);
        }

        let driver = Arc::new(WinAutomationDriver::new());
        let engine = SenderEngine::new(config, driver, Some(build_cloud_client()));

        // 转发引擎事件到前端 Webview2
        let app_clone = app.clone();
        tokio::spawn(async move {
            while let Some(event) = event_rx.recv().await {
                let _ = app_clone.emit("engine-event", &event);
            }
        });

        // 异步运行发信任务循环
        tokio::spawn(async move {
            let mut items_clone = items;
            engine.run(&mut items_clone, event_tx, cmd_rx).await;
        });

        Ok(())
    }

    #[tauri::command]
    pub fn pause_send(state: State<'_, AppState>) -> Result<(), String> {
        if let Some(ref tx) = *state.cmd_tx.lock().map_err(|e| e.to_string())? {
            let _ = tx.send(EngineCommand::Pause);
        }
        Ok(())
    }

    #[tauri::command]
    pub fn resume_send(state: State<'_, AppState>) -> Result<(), String> {
        if let Some(ref tx) = *state.cmd_tx.lock().map_err(|e| e.to_string())? {
            let _ = tx.send(EngineCommand::Resume);
        }
        Ok(())
    }

    #[tauri::command]
    pub fn stop_send(state: State<'_, AppState>) -> Result<(), String> {
        if let Some(ref tx) = *state.cmd_tx.lock().map_err(|e| e.to_string())? {
            let _ = tx.send(EngineCommand::Stop);
        }
        Ok(())
    }
}
