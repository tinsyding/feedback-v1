use crate::cloud::CloudClient;
use crate::debug_shot::save_debug_shot;
use crate::header_verify::{
    apply_vlm_double_check, judge_header_text, HeaderCheck, HeaderVerdict,
};
use crate::parser::evaluate_contact_candidates;
use crate::types::{
    ContactCandidate, DecisionResult, DropdownCapture, FeedbackItem, HeaderCapture, SendStatus,
};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, watch};

use serde::{Deserialize, Serialize};

/// 自动化发信执行引擎状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EngineState {
    Idle,
    Running,
    Paused,
    FocusLost,
    Stopped,
    Completed,
}

/// 引擎向外广播的实时事件（供 GUI 或 CLI 监听渲染）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum EngineEvent {
    StateChanged {
        state: EngineState,
    },
    Progress {
        current: usize,
        total: usize,
        success: usize,
        failed: usize,
    },
    ItemUpdated {
        index: usize,
        status: SendStatus,
        reason: String,
    },
    Log {
        level: String,
        message: String,
    },
}

impl EngineEvent {
    pub fn state_changed(state: EngineState) -> Self {
        Self::StateChanged { state }
    }

    pub fn log(level: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Log {
            level: level.into(),
            message: message.into(),
        }
    }
}

/// 外部对引擎下发的控制指令
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EngineCommand {
    Start,
    Pause,
    Resume,
    Stop,
}

/// 视觉智能核验模式，对齐经典版 `smart_mode_var`（send_feedback.py:2322）
///
/// * `Cloud` —— 模式 A：云端大模型优先，异常时无缝降级本地 OCR（默认）
/// * `Local` —— 模式 B：仅本地 OCR，完全离线
/// * `Off`   —— 关闭下拉框核验（**不影响**会话标题核验，那条不可关闭）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum VisionMode {
    #[default]
    Cloud,
    Local,
    Off,
}

impl VisionMode {
    /// 与前端 `<select>` 的取值一一对应，双向转换避免拼写漂移
    pub fn as_str(self) -> &'static str {
        match self {
            VisionMode::Cloud => "cloud",
            VisionMode::Local => "local",
            VisionMode::Off => "off",
        }
    }
}

/// 发信引擎运行配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineConfig {
    pub batch_size: usize,
    pub item_interval_ms: u64,
    pub batch_cooldown_sec: u64,
    pub use_cloud_vision: bool,
    /// 下拉候选视觉核验模式（`use_cloud_vision` 为 false 时等价于 Local）
    #[serde(default)]
    pub vision_mode: VisionMode,
    /// 是否启用会话标题安全检查点。
    ///
    /// 默认为 true。关闭它意味着**放弃唯一的误发拦截防线**，仅供
    /// 排查本机 OCR/截图异常时临时使用，请勿在正式发信时关闭。
    #[serde(default = "default_true")]
    pub header_verify: bool,
}

fn default_true() -> bool {
    true
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            batch_size: 15,
            item_interval_ms: 1200,
            batch_cooldown_sec: 10,
            use_cloud_vision: true,
            vision_mode: VisionMode::Cloud,
            header_verify: true,
        }
    }
}

impl EngineConfig {
    /// 下拉框核验是否走云端大模型
    fn use_cloud_for_dropdown(&self) -> bool {
        self.use_cloud_vision && self.vision_mode == VisionMode::Cloud
    }

    /// 会话标题核验是否走云端大模型
    fn use_cloud_for_header(&self) -> bool {
        self.use_cloud_vision && self.vision_mode != VisionMode::Off
    }
}

/// 自动化驱动抽象（通过 Trait 隔离 Win32 原生操作与测试 Mock）
#[allow(async_fn_in_trait)]
pub trait AutomationDriver: Send + Sync {
    async fn find_wecom(&self) -> Option<isize>;
    async fn is_wecom_foreground(&self, hwnd: isize) -> bool;
    async fn search_contact(&self, hwnd: isize, query: &str) -> Result<(), String>;
    async fn capture_dropdown_candidates(&self, hwnd: isize) -> Result<Vec<ContactCandidate>, String>;
    /// 抓取下拉候选并附带原始 OCR 文本/DPI（用于详细日志）。默认降级到候选列表。
    async fn capture_dropdown(&self, hwnd: isize) -> Result<DropdownCapture, String> {
        let candidates = self.capture_dropdown_candidates(hwnd).await?;
        Ok(DropdownCapture {
            candidates,
            raw_text: String::new(),
            dpi_scale: 1.0,
        })
    }
    async fn select_candidate(&self, hwnd: isize, choice: usize) -> Result<(), String>;
    async fn send_message_text(&self, hwnd: isize, message: &str) -> Result<(), String>;
    async fn dismiss_search(&self, hwnd: isize) -> Result<(), String>;

    /// 抓取当前会话顶部标题条（图像 + OCR 文本）。
    ///
    /// 默认实现返回 `Err` —— 上层据此判为 `Uncertain` 并**拦截**。
    /// 这一点是刻意的：Mock / 测试驱动拿不到真实截图，若默认放行，会让
    /// 「引擎在没做标题核验的情况下把消息发了」这件事在测试里静默通过，
    /// 掩盖真实缺陷。需要放行的测试驱动请显式覆写本方法。
    async fn capture_chat_header(&self, _hwnd: isize) -> Result<HeaderCapture, String> {
        Err("当前驱动未实现会话标题抓取".to_string())
    }

    /// 抓取下拉框原始裁剪图，供云端大模型视觉核验。
    /// 默认 `None`（驱动不支持截图），此时下拉核验自动降级到本地 OCR。
    async fn capture_dropdown_image(&self, _hwnd: isize) -> Option<image::DynamicImage> {
        None
    }
}

/// 批量发信调度引擎
pub struct SenderEngine<D: AutomationDriver> {
    config: EngineConfig,
    driver: Arc<D>,
    #[allow(dead_code)]
    cloud_client: Option<Arc<CloudClient>>,
}

impl<D: AutomationDriver> SenderEngine<D> {
    pub fn new(config: EngineConfig, driver: Arc<D>, cloud_client: Option<Arc<CloudClient>>) -> Self {
        Self {
            config,
            driver,
            cloud_client,
        }
    }

    /// 可被 Stop 指令打断的休眠（50ms 粒度轮询），返回 false 表示中途被终止。
    /// 对应经典版 safe_sleep 的 ESC 轮询语义。
    async fn sleep_or_stop(
        cmd_rx: &watch::Receiver<EngineCommand>,
        dur: Duration,
    ) -> bool {
        let mut remaining = dur;
        let step = Duration::from_millis(50);
        while !remaining.is_zero() {
            if *cmd_rx.borrow() == EngineCommand::Stop {
                return false;
            }
            let chunk = remaining.min(step);
            tokio::time::sleep(chunk).await;
            remaining = remaining.saturating_sub(chunk);
        }
        *cmd_rx.borrow() != EngineCommand::Stop
    }

    /// 会话标题安全检查点总控（对齐经典版 `verify_chat_header_title`，send_feedback.py:1139）
    ///
    /// 模式 A：云端大模型复核 `detected_title`；网络/服务端异常或模型给出
    ///         无法判定的结论时，无缝降级到本地 OCR。
    /// 模式 B：仅本地 OCR。
    ///
    /// **返回值语义是 fail-closed 的**：只有 `HeaderVerdict::Match` 才允许
    /// 继续发送；`Mismatch` 与 `Uncertain` 一律拦截。
    async fn verify_chat_header(
        &self,
        hwnd: isize,
        target_id: &str,
        target_name: &str,
        event_tx: &mpsc::Sender<EngineEvent>,
    ) -> HeaderCheck {
        if !self.config.header_verify {
            let _ = event_tx
                .send(EngineEvent::log(
                    "WARN",
                    "⚠️ 会话标题安全检查点已被关闭，当前无误发拦截防线！",
                ))
                .await;
            return HeaderCheck::match_ok("（核验已关闭）");
        }

        // 消除企微会话切换动画的残影，否则第一帧可能仍是上一位学生的标题条
        tokio::time::sleep(Duration::from_millis(350)).await;

        let cloud = if self.config.use_cloud_for_header() {
            self.cloud_client.clone()
        } else {
            None
        };

        // ---- 模式 A：云端大模型 ----
        if let Some(cc) = cloud.as_ref() {
            match self.driver.capture_chat_header(hwnd).await {
                Ok(cap) => {
                    match cc
                        .verify_header_via_vlm(&cap.image, target_id, target_name)
                        .await
                    {
                        Ok((matched, detected, reason)) => {
                            let _ = event_tx
                                .send(EngineEvent::log(
                                    "INFO",
                                    format!(
                                        "[大模型标题核验] matched={}, title='{}', reason='{}'",
                                        matched, detected, reason
                                    ),
                                ))
                                .await;
                            // 双重防御：模型说匹配，也要用本地字符串再核一遍
                            let check =
                                apply_vlm_double_check(matched, &detected, target_id, target_name);
                            if check.verdict == HeaderVerdict::Match
                                || check.verdict == HeaderVerdict::Mismatch
                            {
                                if !check.allows_send() {
                                    save_debug_shot(
                                        &cap.image,
                                        "header",
                                        "vlm_mismatch",
                                        target_id,
                                        target_name,
                                    );
                                }
                                return check;
                            }
                        }
                        Err(e) => {
                            let _ = event_tx
                                .send(EngineEvent::log(
                                    "WARN",
                                    format!("云端标题核验异常（{}），自动降级至本地 OCR...", e),
                                ))
                                .await;
                        }
                    }
                }
                Err(e) => {
                    let _ = event_tx
                        .send(EngineEvent::log(
                            "WARN",
                            format!("抓取标题条失败（{}），自动降级至本地 OCR...", e),
                        ))
                        .await;
                }
            }
        }

        // ---- 模式 B：本地 OCR 兜底 ----
        match self.driver.capture_chat_header(hwnd).await {
            Ok(cap) => {
                let check = judge_header_text(&cap.text, target_id, target_name);
                if !check.allows_send() {
                    let tag = if check.verdict == HeaderVerdict::Mismatch {
                        "mismatch"
                    } else {
                        "uncertain"
                    };
                    save_debug_shot(&cap.image, "header", tag, target_id, target_name);
                }
                check
            }
            Err(e) => HeaderCheck::uncertain(format!("本地标题核验失败: {e}")),
        }
    }

    /// 下拉候选视觉核验总控（对齐经典版 `detect_dropdown_target`，send_feedback.py:974）
    ///
    /// 模式 A 拿不到可用结论（网络异常 / 模型未给出合法 choice）时，降级到
    /// 本地 OCR 的 `evaluate_contact_candidates`；模式 B / Off 直接走本地。
    async fn detect_dropdown_target(
        &self,
        hwnd: isize,
        capture: &DropdownCapture,
        target_id: &str,
        target_name: &str,
        event_tx: &mpsc::Sender<EngineEvent>,
    ) -> DecisionResult {
        let local = || evaluate_contact_candidates(&capture.candidates, target_id, target_name, "LocalOCR");

        if self.config.vision_mode == VisionMode::Off {
            // 对齐经典版：未开启视觉智能核验时走「传统两次回车」进入第 1 项，
            // 身份仍由不可关闭的会话标题检查点裁决
            return DecisionResult {
                choice: -1,
                reason: "下拉框视觉核验已关闭，交由会话标题检查点裁决".to_string(),
                engine: "Disabled".to_string(),
            };
        }

        if self.config.use_cloud_for_dropdown() {
            if let Some(cc) = self.cloud_client.as_ref() {
                // 模式 A 需要原始裁剪图；驱动不支持截图时直接走本地 OCR，
                // 不做无谓的云端往返
                match self.driver.capture_dropdown_image(hwnd).await {
                    Some(img) => {
                        match cc.detect_dropdown_via_vlm(&img, target_id, target_name).await {
                            Some(decision) => {
                                let _ = event_tx
                                    .send(EngineEvent::log(
                                        "INFO",
                                        format!(
                                            "[大模型下拉核验] choice={}（{}）",
                                            decision.choice, decision.reason
                                        ),
                                    ))
                                    .await;
                                return decision;
                            }
                            None => {
                                let _ = event_tx
                                    .send(EngineEvent::log(
                                        "WARN",
                                        "云端下拉核验未给出可用结论，自动降级至本地 OCR..."
                                            .to_string(),
                                    ))
                                    .await;
                            }
                        }
                    }
                    None => {
                        let _ = event_tx
                            .send(EngineEvent::log(
                                "WARN",
                                "下拉框截图不可用，跳过云端核验，改用本地 OCR".to_string(),
                            ))
                            .await;
                    }
                }
            }
        }

        local()
    }

    /// 启动发信任务循环
    pub async fn run(
        &self,
        items: &mut [FeedbackItem],
        event_tx: mpsc::Sender<EngineEvent>,
        mut cmd_rx: watch::Receiver<EngineCommand>,
    ) {
        let total = items.len();
        let mut success = 0;
        let mut failed = 0;

        let _ = event_tx
            .send(EngineEvent::state_changed(EngineState::Running))
            .await;
        let _ = event_tx
            .send(EngineEvent::log(
                "INFO",
                format!("发信任务启动，总计 {} 位待发送学生", total),
            ))
            .await;

        let hwnd = match self.driver.find_wecom().await {
            Some(h) => h,
            None => {
                let _ = event_tx
                    .send(EngineEvent::log(
                        "ERROR",
                        "未找到企业微信主窗口，请先打开并登录企微",
                    ))
                    .await;
                let _ = event_tx
                    .send(EngineEvent::state_changed(EngineState::Stopped))
                    .await;
                return;
            }
        };

        for i in 0..total {
            // 1. 检查外部控制指令
            if self.handle_control_commands(&mut cmd_rx, &event_tx).await == EngineCommand::Stop {
                let _ = self.driver.dismiss_search(hwnd).await;
                let _ = event_tx
                    .send(EngineEvent::log("WARN", "收到停止指令，任务提前终止"))
                    .await;
                let _ = event_tx
                    .send(EngineEvent::state_changed(EngineState::Stopped))
                    .await;
                return;
            }

            // 2. 前台失焦守护（等待期间同样响应停止指令，避免卡死到重获焦点）
            while !self.driver.is_wecom_foreground(hwnd).await {
                if *cmd_rx.borrow() == EngineCommand::Stop {
                    let _ = self.driver.dismiss_search(hwnd).await;
                    let _ = event_tx
                        .send(EngineEvent::log("WARN", "收到停止指令，任务提前终止"))
                        .await;
                    let _ = event_tx
                        .send(EngineEvent::state_changed(EngineState::Stopped))
                        .await;
                    return;
                }
                let _ = event_tx
                    .send(EngineEvent::state_changed(EngineState::FocusLost))
                    .await;
                let _ = event_tx
                    .send(EngineEvent::log(
                        "WARN",
                        "企微窗口失去焦点，已自动挂起发信；请切换回企微窗口继续...",
                    ))
                    .await;
                tokio::time::sleep(Duration::from_millis(800)).await;
            }

            let item = &mut items[i];
            let item_index = item.original_index.unwrap_or(i);
            let search_key = if !item.student_name.is_empty() {
                item.student_name.clone()
            } else if !item.student_id.is_empty() {
                item.student_id.clone()
            } else {
                item.clean_name.clone()
            };

            let _ = event_tx
                .send(EngineEvent::log(
                    "INFO",
                    format!(
                        "[{}/{}] 正在处理: {} (学号: {})",
                        i + 1,
                        total,
                        item.clean_name,
                        item.student_id
                    ),
                ))
                .await;

            // 3. 搜索联系人
            if let Err(e) = self.driver.search_contact(hwnd, &search_key).await {
                item.status = SendStatus::Failed;
                failed += 1;
                let _ = self.driver.dismiss_search(hwnd).await;
                let _ = event_tx
                    .send(EngineEvent::ItemUpdated {
                        index: item_index,
                        status: SendStatus::Failed,
                        reason: format!("搜索异常: {e}"),
                    })
                    .await;
                continue;
            }

            // 4. 抓取候选人并智能决策
            tokio::time::sleep(Duration::from_millis(300)).await;
            let capture = match self.driver.capture_dropdown(hwnd).await {
                Ok(c) => c,
                Err(e) => {
                    item.status = SendStatus::Failed;
                    failed += 1;
                    let _ = self.driver.dismiss_search(hwnd).await;
                    let _ = event_tx
                        .send(EngineEvent::ItemUpdated {
                            index: item_index,
                            status: SendStatus::Failed,
                            reason: format!("识别候选人失败: {e}"),
                        })
                        .await;
                    continue;
                }
            };
            let candidates = &capture.candidates;

            // 4.5 下拉候选视觉核验总控（云端大模型优先，异常降级本地 OCR）
            let decision = self
                .detect_dropdown_target(hwnd, &capture, &item.student_id, &item.clean_name, &event_tx)
                .await;

            // 原始 OCR 全文进日志：出现多按向下时可据此还原到底识别到了什么
            let _ = event_tx
                .send(EngineEvent::log(
                    "INFO",
                    format!(
                        "[OCR原文] DPI缩放={:.2} 全文=\"{}\"",
                        capture.dpi_scale, capture.raw_text
                    ),
                ))
                .await;

            // 判定明细进日志（与经典版“智能纠偏”日志对齐）：首项即本人 / 纠正至第N项一目了然
            {
                let titles: Vec<String> = candidates
                    .iter()
                    .map(|c| {
                        if c.title.trim().is_empty() {
                            "(空)".to_string()
                        } else {
                            c.title.clone()
                        }
                    })
                    .collect();
                let _ = event_tx
                    .send(EngineEvent::log(
                        if decision.choice >= 2 { "WARN" } else { "INFO" },
                        format!(
                            "[智能判定] 目标 {} {} => choice={}（{}），候选=[{}]",
                            item.student_id,
                            item.clean_name,
                            decision.choice,
                            decision.reason,
                            titles.join(" | ")
                        ),
                    ))
                    .await;
            }

            // choice 语义对齐经典版 send_single_feedback（send_feedback.py:3830-3896）：
            //   0       —— 通讯录中无此联系人（全局搜索）      -> 安全跳过
            //   -2      —— 仅为他人描述命中，无本人独立条目    -> 智能拦截
            //   -1      —— 识别未确立 -> **试探性进入第 1 项，交由会话标题检查点裁决**
            //   >= 1    —— 按向下键纠正至对应项
            //
            // 注意 -1 不是「跳过」：经典版明确注释「绝不直接发送，交由下一步
            // 标题检查点裁决」。把它当跳过会让一批识别存疑的学生永远发不出去。
            if decision.choice == 0 || decision.choice < -1 {
                item.status = SendStatus::Skipped;
                let _ = event_tx
                    .send(EngineEvent::ItemUpdated {
                        index: item_index,
                        status: SendStatus::Skipped,
                        reason: decision.reason,
                    })
                    .await;
                // 核心安全清理：退出下拉浮层并清空搜索框
                let _ = self.driver.dismiss_search(hwnd).await;
                continue;
            }

            if decision.choice < 0 {
                let _ = event_tx
                    .send(EngineEvent::log(
                        "WARN",
                        "下拉识别未明确，试探性进入第1项，等待会话标题检查点裁决..."
                            .to_string(),
                    ))
                    .await;
            }

            // 5. 选中联系人（-1 时按第 1 项试探）
            let target_choice = if decision.choice < 0 { 1 } else { decision.choice as usize };
            if let Err(e) = self.driver.select_candidate(hwnd, target_choice).await {
                item.status = SendStatus::Failed;
                failed += 1;
                let _ = self.driver.dismiss_search(hwnd).await;
                let _ = event_tx
                    .send(EngineEvent::ItemUpdated {
                        index: item_index,
                        status: SendStatus::Failed,
                        reason: format!("选择候选人失败: {e}"),
                    })
                    .await;
                continue;
            }

            tokio::time::sleep(Duration::from_millis(200)).await;

            // 5. 【会话标题安全检查点】—— 发送文案之前的最后一道误发拦截
            //    只在选中联系人后执行；MISMATCH 与 UNCERTAIN 一律拦截（fail-closed）。
            let header = self
                .verify_chat_header(hwnd, &item.student_id, &item.clean_name, &event_tx)
                .await;
            let _ = event_tx
                .send(EngineEvent::log(
                    header.verdict.log_level(),
                    format!(
                        "[标题检查点] {} — 目标 {} {}，读到 '{}'（{}）",
                        match header.verdict {
                            HeaderVerdict::Match => "✓ 放行",
                            HeaderVerdict::Mismatch => "⛔ 误选拦截",
                            HeaderVerdict::Uncertain => "⛔ 存疑拦截",
                        },
                        item.student_id,
                        item.clean_name,
                        header.detected_title,
                        header.reason
                    ),
                ))
                .await;

            if !header.allows_send() {
                item.status = SendStatus::Failed;
                failed += 1;
                // 立即安全退出会话并彻底清空搜索框，杜绝下一次盲目按向下键误入
                let _ = self.driver.dismiss_search(hwnd).await;
                let _ = event_tx
                    .send(EngineEvent::ItemUpdated {
                        index: item_index,
                        status: SendStatus::Failed,
                        reason: format!(
                            "会话标题核验未通过（{}）：{}",
                            match header.verdict {
                                HeaderVerdict::Mismatch => "误选他人会话",
                                HeaderVerdict::Uncertain => "身份存疑",
                                HeaderVerdict::Match => "通过",
                            },
                            header.reason
                        ),
                    })
                    .await;
                continue;
            }

            if let Err(e) = self.driver.send_message_text(hwnd, &item.message).await {
                item.status = SendStatus::Failed;
                failed += 1;
                let _ = self.driver.dismiss_search(hwnd).await;
                let _ = event_tx
                    .send(EngineEvent::ItemUpdated {
                        index: item_index,
                        status: SendStatus::Failed,
                        reason: format!("发送消息失败: {e}"),
                    })
                    .await;
                continue;
            }

            item.status = SendStatus::Success;
            success += 1;
            let _ = event_tx
                .send(EngineEvent::ItemUpdated {
                    index: item_index,
                    status: SendStatus::Success,
                    reason: "发送成功".to_string(),
                })
                .await;

            let _ = event_tx
                .send(EngineEvent::Progress {
                    current: i + 1,
                    total,
                    success,
                    failed,
                })
                .await;

            // 6. 批次休眠与间隔冷却（可被停止指令打断，对应经典版 safe_sleep）
            let interrupted = if (i + 1) % self.config.batch_size == 0 && (i + 1) < total {
                let _ = event_tx
                    .send(EngineEvent::log(
                        "INFO",
                        format!(
                            "已达到批次阈值 {}，防风控休眠 {} 秒...",
                            self.config.batch_size, self.config.batch_cooldown_sec
                        ),
                    ))
                    .await;
                Self::sleep_or_stop(&cmd_rx, Duration::from_secs(self.config.batch_cooldown_sec)).await
            } else {
                Self::sleep_or_stop(&cmd_rx, Duration::from_millis(self.config.item_interval_ms)).await
            };
            if !interrupted {
                let _ = self.driver.dismiss_search(hwnd).await;
                let _ = event_tx
                    .send(EngineEvent::log("WARN", "收到停止指令，任务提前终止"))
                    .await;
                let _ = event_tx
                    .send(EngineEvent::state_changed(EngineState::Stopped))
                    .await;
                return;
            }
        }

        let _ = event_tx
            .send(EngineEvent::state_changed(EngineState::Completed))
            .await;
        let _ = event_tx
            .send(EngineEvent::log(
                "INFO",
                format!(
                    "发信任务全部结束！总计: {}, 成功: {}, 失败/跳过: {}",
                    total,
                    success,
                    total - success
                ),
            ))
            .await;
    }

    async fn handle_control_commands(
        &self,
        rx: &mut watch::Receiver<EngineCommand>,
        event_tx: &mpsc::Sender<EngineEvent>,
    ) -> EngineCommand {
        let mut cmd = *rx.borrow();
        if cmd == EngineCommand::Pause {
            let _ = event_tx
                .send(EngineEvent::state_changed(EngineState::Paused))
                .await;
            let _ = event_tx
                .send(EngineEvent::log(
                    "WARN",
                    "用户暂停了发信任务，等待恢复...",
                ))
                .await;

            while *rx.borrow() == EngineCommand::Pause {
                if rx.changed().await.is_err() {
                    return EngineCommand::Stop;
                }
            }
            cmd = *rx.borrow();
            let _ = event_tx
                .send(EngineEvent::state_changed(EngineState::Running))
                .await;
        }
        cmd
    }
}
