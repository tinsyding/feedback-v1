use desktop_sender_rs::header_verify::HeaderVerdict;
use desktop_sender_rs::sender_engine::{
    AutomationDriver, EngineCommand, EngineConfig, EngineEvent, EngineState, SenderEngine, VisionMode,
};
use desktop_sender_rs::types::{ContactCandidate, DropdownCapture, FeedbackItem, HeaderCapture, SendStatus};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, watch};

/// 可编排的 Mock 驱动：让测试显式控制标题核验结果，
/// 从而验证「核验不通过时绝不发送」这条安全不变量。
struct MockDriver {
    search_count: AtomicUsize,
    send_count: AtomicUsize,
    dismiss_count: AtomicUsize,
    /// None = 覆写 capture_chat_header 并返回固定文本；Some = 未实现标题抓取
    header_text: Option<String>,
    header_capture_err: bool,
}

impl MockDriver {
    fn new() -> Self {
        Self {
            search_count: AtomicUsize::new(0),
            send_count: AtomicUsize::new(0),
            dismiss_count: AtomicUsize::new(0),
            header_text: Some("90001张三".to_string()),
            header_capture_err: false,
        }
    }

    fn with_header_text(mut self, text: &str) -> Self {
        self.header_text = Some(text.to_string());
        self
    }

    fn without_header_capture(mut self) -> Self {
        self.header_capture_err = true;
        self
    }
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
        self.dismiss_count.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    async fn capture_chat_header(&self, _hwnd: isize) -> Result<HeaderCapture, String> {
        if self.header_capture_err {
            return Err("未实现标题抓取".to_string());
        }
        Ok(HeaderCapture {
            image: image::DynamicImage::new_rgba8(1, 1),
            text: self.header_text.clone().unwrap_or_default(),
            dpi_scale: 1.0,
        })
    }
}

fn sample_item() -> FeedbackItem {
    FeedbackItem {
        student_name: "90001张三".to_string(),
        student_id: "90001".to_string(),
        clean_name: "张三".to_string(),
        cycle: "第1周".to_string(),
        message: "作业优秀".to_string(),
        status: SendStatus::Pending,
        original_index: Some(0),
    }
}

fn local_config() -> EngineConfig {
    EngineConfig {
        batch_size: 10,
        item_interval_ms: 10,
        batch_cooldown_sec: 1,
        use_cloud_vision: false,
        vision_mode: VisionMode::Local,
        header_verify: true,
    }
}

/// 跑一次引擎，返回 (最终条目, 驱动, 是否进入 Completed)
async fn run_engine(driver: Arc<MockDriver>, config: EngineConfig) -> (Vec<FeedbackItem>, bool) {
    let engine = SenderEngine::new(config, driver.clone(), None);
    let mut items = vec![sample_item()];
    let (event_tx, mut event_rx) = mpsc::channel(64);
    let (_cmd_tx, cmd_rx) = watch::channel(EngineCommand::Start);

    let handle = tokio::spawn(async move {
        engine.run(&mut items, event_tx.into(), cmd_rx).await;
        items
    });

    let mut finished = false;
    while let Some(event) = event_rx.recv().await {
        if let EngineEvent::StateChanged {
            state: EngineState::Completed,
        } = event
        {
            finished = true;
            break;
        }
    }
    let result_items = handle.await.unwrap();
    (result_items, finished)
}

#[tokio::test]
async fn test_sender_engine_full_loop() {
    let driver = Arc::new(MockDriver::new());
    let (result_items, finished) = run_engine(driver.clone(), local_config()).await;

    assert!(finished, "引擎应当进入 Completed 状态");
    assert_eq!(result_items[0].status, SendStatus::Success);
    assert_eq!(driver.search_count.load(Ordering::SeqCst), 1);
    assert_eq!(driver.send_count.load(Ordering::SeqCst), 1);
}

// ========== 会话标题安全检查点（防误发拦截）==========

#[tokio::test]
async fn test_header_match_allows_send() {
    // 标题同时含学号与姓名 -> MATCH -> 允许发送
    let driver = Arc::new(MockDriver::new().with_header_text("90001张三妈妈"));
    let (items, _) = run_engine(driver.clone(), local_config()).await;

    assert_eq!(items[0].status, SendStatus::Success);
    assert_eq!(driver.send_count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn test_header_mismatch_blocks_send() {
    // 标题是别人的 -> MISMATCH -> 绝不发送
    let driver = Arc::new(MockDriver::new().with_header_text("90002李四"));
    let (items, _) = run_engine(driver.clone(), local_config()).await;

    assert_ne!(
        items[0].status,
        SendStatus::Success,
        "标题核验不通过时绝不能标记为发送成功"
    );
    assert_eq!(items[0].status, SendStatus::Failed);
    assert_eq!(
        driver.send_count.load(Ordering::SeqCst),
        0,
        "误选他人会话时绝不允许调用发送"
    );
    assert!(
        driver.dismiss_count.load(Ordering::SeqCst) > 0,
        "拦截后必须清空搜索框退出，防下一次误按"
    );
}

#[tokio::test]
async fn test_header_uncertain_blocks_send() {
    // 只读到姓名、读不到学号（例如下拉选错人）-> MISMATCH -> 拦截
    let driver = Arc::new(MockDriver::new().with_header_text("李四妈妈"));
    let (items, _) = run_engine(driver.clone(), local_config()).await;

    assert_eq!(items[0].status, SendStatus::Failed);
    assert_eq!(driver.send_count.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn test_header_empty_blocks_send_fail_closed() {
    // OCR 完全读不到标题 -> UNCERTAIN -> fail-closed 拦截
    let driver = Arc::new(MockDriver::new().with_header_text(""));
    let (items, _) = run_engine(driver.clone(), local_config()).await;

    assert_eq!(items[0].status, SendStatus::Failed);
    assert_eq!(
        driver.send_count.load(Ordering::SeqCst),
        0,
        "标题读不到时必须拦截，绝不能盲发"
    );
}

#[tokio::test]
async fn test_header_capture_failure_blocks_send_fail_closed() {
    // 驱动无法抓取标题（截图/OCR 异常）-> UNCERTAIN -> fail-closed 拦截
    let driver = Arc::new(MockDriver::new().without_header_capture());
    let (items, _) = run_engine(driver.clone(), local_config()).await;

    assert_eq!(items[0].status, SendStatus::Failed);
    assert_eq!(driver.send_count.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn test_header_verify_can_be_disabled_explicitly() {
    // 显式关闭核验是允许的（仅供排查本机截图异常），此时恢复发送
    let driver = Arc::new(MockDriver::new().with_header_text("90002李四"));
    let mut config = local_config();
    config.header_verify = false;
    let (items, _) = run_engine(driver.clone(), config).await;

    assert_eq!(items[0].status, SendStatus::Success);
    assert_eq!(driver.send_count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn test_vision_mode_off_still_enforces_header_check() {
    // vision_mode=Off 只关闭下拉框核验：按经典版语义「传统两次回车进入第 1 项」，
    // 身份判定完全交给不可关闭的会话标题核验 —— 标题是别人时仍必须拦住
    let driver = Arc::new(MockDriver::new().with_header_text("90002李四"));
    let mut config = local_config();
    config.vision_mode = VisionMode::Off;
    let (items, _) = run_engine(driver.clone(), config).await;

    assert_eq!(items[0].status, SendStatus::Failed);
    assert_eq!(driver.send_count.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn test_vision_mode_off_allows_send_when_header_matches() {
    // Off 模式下标题正确时应当照常发送（否则关掉核验就没法用了）
    let driver = Arc::new(MockDriver::new().with_header_text("90001张三"));
    let mut config = local_config();
    config.vision_mode = VisionMode::Off;
    let (items, _) = run_engine(driver.clone(), config).await;

    assert_eq!(items[0].status, SendStatus::Success);
    assert_eq!(driver.send_count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn test_undecided_dropdown_probes_first_candidate_then_header_arbiter() {
    // 下拉无任何候选 -> evaluate_contact_candidates 返回 choice=0 -> 无此联系人，跳过
    let driver = Arc::new(EmptyDropdownDriver {
        inner: MockDriver::new().with_header_text("90001张三"),
    });
    let engine = SenderEngine::new(local_config(), driver, None);
    let mut items = vec![sample_item()];
    let (event_tx, mut event_rx) = mpsc::channel(64);
    let (_cmd_tx, cmd_rx) = watch::channel(EngineCommand::Start);

    let handle = tokio::spawn(async move {
        engine.run(&mut items, event_tx.into(), cmd_rx).await;
        items
    });
    while event_rx.recv().await.is_some() {}
    let result = handle.await.unwrap();

    assert_eq!(
        result[0].status,
        SendStatus::Skipped,
        "通讯录无此联系人应安全跳过，不应发送"
    );
}

/// 下拉框返回空候选的驱动（模拟企微通讯录里查无此人）
struct EmptyDropdownDriver {
    inner: MockDriver,
}

impl AutomationDriver for EmptyDropdownDriver {
    async fn find_wecom(&self) -> Option<isize> {
        self.inner.find_wecom().await
    }
    async fn is_wecom_foreground(&self, hwnd: isize) -> bool {
        self.inner.is_wecom_foreground(hwnd).await
    }
    async fn search_contact(&self, hwnd: isize, q: &str) -> Result<(), String> {
        self.inner.search_contact(hwnd, q).await
    }
    async fn capture_dropdown_candidates(
        &self,
        _hwnd: isize,
    ) -> Result<Vec<ContactCandidate>, String> {
        Ok(vec![])
    }
    async fn select_candidate(&self, hwnd: isize, c: usize) -> Result<(), String> {
        self.inner.select_candidate(hwnd, c).await
    }
    async fn send_message_text(&self, hwnd: isize, m: &str) -> Result<(), String> {
        self.inner.send_message_text(hwnd, m).await
    }
    async fn dismiss_search(&self, hwnd: isize) -> Result<(), String> {
        self.inner.dismiss_search(hwnd).await
    }
    async fn capture_chat_header(&self, hwnd: isize) -> Result<HeaderCapture, String> {
        self.inner.capture_chat_header(hwnd).await
    }
}

#[test]
fn test_verdict_send_permission_is_fail_closed() {
    assert!(HeaderVerdict::Match.allows_send());
    assert!(!HeaderVerdict::Mismatch.allows_send());
    assert!(
        !HeaderVerdict::Uncertain.allows_send(),
        "UNCERTAIN 必须 fail-closed 拦截"
    );
}

// ========== 前端配置契约（ui/app.js -> start_send）==========
// 这一层出错的表现是「点了开始发送直接报反序列化失败、整批发不出去」，
// 且只在真机 Tauri 环境下才暴露，因此在这里用前端实际下发的 JSON 锁死。

/// 与 ui/app.js onStartClick 中 config 对象逐字段一致的报文
fn ui_payload(vision_mode: &str, header_verify: bool) -> String {
    format!(
        r#"{{
          "batch_size": 15,
          "item_interval_ms": 1200,
          "batch_cooldown_sec": 10,
          "use_cloud_vision": {vision_cloud},
          "vision_mode": "{vision_mode}",
          "header_verify": {header_verify}
        }}"#,
        vision_cloud = vision_mode == "cloud",
        header_verify = header_verify
    )
}

#[test]
fn test_ui_config_payload_deserializes_for_every_mode() {
    for mode in ["cloud", "local", "off"] {
        let cfg: EngineConfig = serde_json::from_str(&ui_payload(mode, true))
            .unwrap_or_else(|e| panic!("前端下发的 vision_mode={mode} 反序列化失败: {e}"));
        assert_eq!(cfg.vision_mode.as_str(), mode);
        assert!(cfg.header_verify, "会话标题核验必须保持开启");
        assert_eq!(
            cfg.use_cloud_vision,
            mode == "cloud",
            "use_cloud_vision 必须与 vision_mode 联动"
        );
    }
}

#[test]
fn test_old_ui_payload_without_new_fields_still_works() {
    // 旧版前端只发 4 个字段；若未加 serde(default) 会导致老缓存的界面直接发不出信
    let cfg: EngineConfig = serde_json::from_str(
        r#"{"batch_size":15,"item_interval_ms":1200,"batch_cooldown_sec":10,"use_cloud_vision":true}"#,
    )
    .expect("旧版前端报文应仍可解析");
    assert_eq!(cfg.vision_mode, VisionMode::Cloud, "缺省应为模式 A");
    assert!(cfg.header_verify, "缺省必须开启标题核验");
}

#[test]
fn test_header_verify_cannot_be_silently_defaulted_off() {
    let base = r#"{"batch_size":15,"item_interval_ms":1200,"batch_cooldown_sec":10,"use_cloud_vision":true"#;
    // 显式传 false 应当生效（供排查本机 OCR 异常时临时关闭）
    let cfg: EngineConfig = serde_json::from_str(&format!("{base},\"header_verify\":false}}")).unwrap();
    assert!(!cfg.header_verify);
    // 但字段缺失时必须 fail-closed 回落到「开启」，绝不能默认成「不校验」
    let cfg: EngineConfig = serde_json::from_str(&format!("{base}}}")).unwrap();
    assert!(
        cfg.header_verify,
        "字段缺失时必须默认开启标题核验"
    );
}

#[test]
fn test_unknown_vision_mode_rejected_rather_than_silently_downgrading() {
    // 未知取值必须报错，不能悄悄退回默认模式而让人以为云端核验在跑
    let err = serde_json::from_str::<EngineConfig>(&ui_payload("turbo", true));
    assert!(err.is_err(), "未知 vision_mode 应解析失败而非静默降级");
}
// ========== 现场截图归档不得影响发信判定 ==========

/// 提供「真实尺寸」截图的驱动
///
/// 默认驱动返回 1x1 占位图（会被归档守卫拒绝）。这里给出真实尺寸，
/// 用来验证归档动作本身对发信结果**零影响**。
struct RealShotDriver {
    inner: MockDriver,
    shot: image::DynamicImage,
}

impl RealShotDriver {
    fn new(header_text: &str) -> Self {
        Self {
            inner: MockDriver::new().with_header_text(header_text),
            // 下拉与标题各给一张尺寸正常的灰图
            shot: image::DynamicImage::ImageLuma8(
                image::GrayImage::from_raw(400, 60, vec![128; 400 * 60]).unwrap(),
            ),
        }
    }
}

impl AutomationDriver for RealShotDriver {
    async fn find_wecom(&self) -> Option<isize> {
        self.inner.find_wecom().await
    }
    async fn is_wecom_foreground(&self, hwnd: isize) -> bool {
        self.inner.is_wecom_foreground(hwnd).await
    }
    async fn search_contact(&self, hwnd: isize, q: &str) -> Result<(), String> {
        self.inner.search_contact(hwnd, q).await
    }
    async fn capture_dropdown_candidates(
        &self,
        hwnd: isize,
    ) -> Result<Vec<ContactCandidate>, String> {
        self.inner.capture_dropdown_candidates(hwnd).await
    }
    async fn capture_dropdown(&self, hwnd: isize) -> Result<DropdownCapture, String> {
        Ok(DropdownCapture {
            candidates: self.inner.capture_dropdown_candidates(hwnd).await?,
            raw_text: "90001张三 其他家长".to_string(),
            dpi_scale: 1.0,
            image: self.shot.clone(),
        })
    }
    async fn select_candidate(&self, hwnd: isize, c: usize) -> Result<(), String> {
        self.inner.select_candidate(hwnd, c).await
    }
    async fn send_message_text(&self, hwnd: isize, m: &str) -> Result<(), String> {
        self.inner.send_message_text(hwnd, m).await
    }
    async fn dismiss_search(&self, hwnd: isize) -> Result<(), String> {
        self.inner.dismiss_search(hwnd).await
    }
    async fn capture_chat_header(&self, _hwnd: isize) -> Result<HeaderCapture, String> {
        Ok(HeaderCapture {
            image: self.shot.clone(),
            text: self.inner.header_text.clone().unwrap_or_default(),
            dpi_scale: 1.0,
        })
    }
}

/// 与 `run_engine` 同流程，但驱动类型具体化
///
/// 不能写成泛型：`AutomationDriver` 用 `async_fn_in_trait`，其 future 不保证
/// `Send`，泛型 helper 无法通过 `tokio::spawn` 的跨线程约束。
async fn run_real_shot_engine(
    driver: Arc<RealShotDriver>,
) -> (Vec<FeedbackItem>, bool) {
    let engine = SenderEngine::new(local_config(), driver, None);
    let mut items = vec![sample_item()];
    let (event_tx, mut event_rx) = mpsc::channel(64);
    let (_cmd_tx, cmd_rx) = watch::channel(EngineCommand::Start);

    let handle = tokio::spawn(async move {
        engine.run(&mut items, event_tx.into(), cmd_rx).await;
        items
    });
    let mut finished = false;
    while let Some(event) = event_rx.recv().await {
        if let EngineEvent::StateChanged {
            state: EngineState::Completed,
        } = event
        {
            finished = true;
        }
    }
    let items = handle.await.unwrap();
    (items, finished)
}

#[tokio::test]
async fn test_audit_shot_with_real_images_does_not_change_send_outcome() {
    // 归档会真实落盘，但它只是诊断旁路：判定与发送结果必须与无归档时一致
    let driver = Arc::new(RealShotDriver::new("90001张三"));
    let (items, finished) = run_real_shot_engine(driver.clone()).await;

    assert!(finished);
    assert_eq!(items[0].status, SendStatus::Success);
    assert_eq!(driver.inner.send_count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn test_audit_shot_with_real_images_still_blocks_on_mismatch() {
    // 反向验证：归档存在时，误选拦截必须照样生效 ——
    // 不能因为「已经留了证」就放宽判定
    let driver = Arc::new(RealShotDriver::new("90002李四"));
    let (items, _) = run_real_shot_engine(driver.clone()).await;

    assert_eq!(items[0].status, SendStatus::Failed);
    assert_eq!(
        driver.inner.send_count.load(Ordering::SeqCst),
        0,
        "标题为他人时绝不允许发送"
    );
}

#[tokio::test]
async fn test_missing_screenshot_never_blocks_sending() {
    // 守住「诊断旁路故障绝不能升级成发信故障」：驱动拿不到真实图像时
    // （默认实现返回 1x1 占位图），归档必然失败，发信必须照常完成。
    //
    // 这里刻意用默认 MockDriver 而非改环境变量去制造不可写目录：
    // data_dir() 依赖进程级环境变量，单测并行改它会与其它用例互相串扰，
    // 反而让这条断言变得不确定。写盘失败的分支由
    // debug_shot_tests::test_returns_specific_error_instead_of_silent_none 覆盖。
    let driver = Arc::new(MockDriver::new().with_header_text("90001张三"));
    let (items, finished) = run_engine(driver.clone(), local_config()).await;

    assert!(finished);
    assert_eq!(
        items[0].status,
        SendStatus::Success,
        "无截图可用绝不能导致发信被跳过或判失败"
    );
    assert_eq!(driver.send_count.load(Ordering::SeqCst), 1);
}
