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
    use crate::sender_engine::{EngineConfig, EngineEvent, SenderEngine};
    use std::sync::Arc;
    use tauri::{AppHandle, Emitter, State};
    use tokio::sync::mpsc;

    #[tauri::command]
    pub fn check_wecom_status() -> bool {
        find_wecom_window().is_some()
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
        {
            let mut guard = state.cmd_tx.lock().map_err(|e| e.to_string())?;
            *guard = Some(cmd_tx);
        }

        let (event_tx, mut event_rx) = mpsc::channel::<EngineEvent>(100);
        let driver = Arc::new(WinAutomationDriver::new());
        let engine = SenderEngine::new(config, driver, None);

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
