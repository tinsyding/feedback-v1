use desktop_sender_rs::sender_engine::{
    AutomationDriver, EngineCommand, EngineConfig, EngineEvent, EngineState, SenderEngine,
};
use desktop_sender_rs::types::{ContactCandidate, FeedbackItem, SendStatus};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, watch};

struct MockDriver {
    search_count: AtomicUsize,
    send_count: AtomicUsize,
}

impl AutomationDriver for MockDriver {
    async fn find_wecom(&self) -> Option<isize> {
        Some(12345) // Mock HWND
    }

    async fn is_wecom_foreground(&self, _hwnd: isize) -> bool {
        true
    }

    async fn search_contact(&self, _hwnd: isize, _query: &str) -> Result<(), String> {
        self.search_count.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    async fn capture_dropdown_candidates(
        &self,
        _hwnd: isize,
    ) -> Result<Vec<ContactCandidate>, String> {
        Ok(vec![
            ContactCandidate {
                index: 1,
                title: "其他家长".to_string(),
                subtitles: vec!["描述: 提及学生".to_string()],
                has_desc: true,
                is_group: false,
            },
            ContactCandidate {
                index: 2,
                title: "90001张三".to_string(),
                subtitles: vec![],
                has_desc: false,
                is_group: false,
            },
        ])
    }

    async fn select_candidate(&self, _hwnd: isize, _choice: usize) -> Result<(), String> {
        Ok(())
    }

    async fn send_message_text(&self, _hwnd: isize, _message: &str) -> Result<(), String> {
        self.send_count.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    async fn dismiss_search(&self, _hwnd: isize) -> Result<(), String> {
        Ok(())
    }
}

#[tokio::test]
async fn test_sender_engine_full_loop() {
    let driver = Arc::new(MockDriver {
        search_count: AtomicUsize::new(0),
        send_count: AtomicUsize::new(0),
    });

    let config = EngineConfig {
        batch_size: 10,
        item_interval_ms: 10,
        batch_cooldown_sec: 1,
        use_cloud_vision: false,
    };

    let engine = SenderEngine::new(config, driver.clone(), None);

    let mut items = vec![FeedbackItem {
        student_name: "90001张三".to_string(),
        student_id: "90001".to_string(),
        clean_name: "张三".to_string(),
        cycle: "第1周".to_string(),
        message: "作业优秀".to_string(),
        status: SendStatus::Pending,
        original_index: Some(0),
    }];

    let (event_tx, mut event_rx) = mpsc::channel(32);
    let (_cmd_tx, cmd_rx) = watch::channel(EngineCommand::Start);

    // 在后台协程运行引擎
    let handle = tokio::spawn(async move {
        engine.run(&mut items, event_tx, cmd_rx).await;
        items
    });

    // 监听事件
    let mut finished = false;
    while let Some(event) = event_rx.recv().await {
        if let EngineEvent::StateChanged { state: EngineState::Completed } = event {
            finished = true;
            break;
        }
    }

    let result_items = handle.await.unwrap();
    assert!(finished, "引擎应当进入 Completed 状态");
    assert_eq!(result_items[0].status, SendStatus::Success);
    assert_eq!(driver.search_count.load(Ordering::SeqCst), 1);
    assert_eq!(driver.send_count.load(Ordering::SeqCst), 1);
}
