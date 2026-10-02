use crate::cloud::CloudClient;
use crate::parser::evaluate_contact_candidates;
use crate::types::{ContactCandidate, FeedbackItem, SendStatus};
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

/// 发信引擎运行配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineConfig {
    pub batch_size: usize,
    pub item_interval_ms: u64,
    pub batch_cooldown_sec: u64,
    pub use_cloud_vision: bool,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            batch_size: 15,
            item_interval_ms: 1200,
            batch_cooldown_sec: 10,
            use_cloud_vision: true,
        }
    }
}

/// 自动化驱动抽象（通过 Trait 隔离 Win32 原生操作与测试 Mock）
#[allow(async_fn_in_trait)]
pub trait AutomationDriver: Send + Sync {
    async fn find_wecom(&self) -> Option<isize>;
    async fn is_wecom_foreground(&self, hwnd: isize) -> bool;
    async fn search_contact(&self, hwnd: isize, query: &str) -> Result<(), String>;
    async fn capture_dropdown_candidates(&self, hwnd: isize) -> Result<Vec<ContactCandidate>, String>;
    async fn select_candidate(&self, hwnd: isize, choice: usize) -> Result<(), String>;
    async fn send_message_text(&self, hwnd: isize, message: &str) -> Result<(), String>;
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
                let _ = event_tx
                    .send(EngineEvent::log("WARN", "收到停止指令，任务提前终止"))
                    .await;
                let _ = event_tx
                    .send(EngineEvent::state_changed(EngineState::Stopped))
                    .await;
                return;
            }

            // 2. 前台失焦守护
            while !self.driver.is_wecom_foreground(hwnd).await {
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
            let search_key = if !item.student_id.is_empty() {
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
                let _ = event_tx
                    .send(EngineEvent::ItemUpdated {
                        index: i,
                        status: SendStatus::Failed,
                        reason: format!("搜索异常: {e}"),
                    })
                    .await;
                continue;
            }

            // 4. 抓取候选人并智能决策
            tokio::time::sleep(Duration::from_millis(300)).await;
            let candidates = match self.driver.capture_dropdown_candidates(hwnd).await {
                Ok(c) => c,
                Err(e) => {
                    item.status = SendStatus::Failed;
                    failed += 1;
                    let _ = event_tx
                        .send(EngineEvent::ItemUpdated {
                            index: i,
                            status: SendStatus::Failed,
                            reason: format!("识别候选人失败: {e}"),
                        })
                        .await;
                    continue;
                }
            };

            let decision = evaluate_contact_candidates(
                &candidates,
                &item.student_id,
                &item.clean_name,
                "Engine",
            );

            if decision.choice <= 0 {
                item.status = SendStatus::Skipped;
                let _ = event_tx
                    .send(EngineEvent::ItemUpdated {
                        index: i,
                        status: SendStatus::Skipped,
                        reason: decision.reason,
                    })
                    .await;
                continue;
            }

            // 5. 选中联系人并发送文案
            if let Err(e) = self
                .driver
                .select_candidate(hwnd, decision.choice as usize)
                .await
            {
                item.status = SendStatus::Failed;
                failed += 1;
                let _ = event_tx
                    .send(EngineEvent::ItemUpdated {
                        index: i,
                        status: SendStatus::Failed,
                        reason: format!("选择候选人失败: {e}"),
                    })
                    .await;
                continue;
            }

            tokio::time::sleep(Duration::from_millis(200)).await;
            if let Err(e) = self.driver.send_message_text(hwnd, &item.message).await {
                item.status = SendStatus::Failed;
                failed += 1;
                let _ = event_tx
                    .send(EngineEvent::ItemUpdated {
                        index: i,
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
                    index: i,
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

            // 6. 批次休眠与间隔冷却
            if (i + 1) % self.config.batch_size == 0 && (i + 1) < total {
                let _ = event_tx
                    .send(EngineEvent::log(
                        "INFO",
                        format!(
                            "已达到批次阈值 {}，防风控休眠 {} 秒...",
                            self.config.batch_size, self.config.batch_cooldown_sec
                        ),
                    ))
                    .await;
                tokio::time::sleep(Duration::from_secs(self.config.batch_cooldown_sec)).await;
            } else {
                tokio::time::sleep(Duration::from_millis(self.config.item_interval_ms)).await;
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
