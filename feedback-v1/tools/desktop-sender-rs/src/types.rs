use serde::{Deserialize, Serialize};

/// 原始与标准化的学生反馈条目
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FeedbackItem {
    #[serde(rename = "studentName", alias = "student_name")]
    pub student_name: String,
    pub message: String,
    #[serde(default, alias = "studentId")]
    pub student_id: String,
    #[serde(default, alias = "cleanName")]
    pub clean_name: String,
    #[serde(default)]
    pub cycle: String,
    #[serde(default)]
    pub status: SendStatus,
    #[serde(default, alias = "originalIndex", alias = "index")]
    pub original_index: Option<usize>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
pub enum SendStatus {
    #[default]
    Pending,
    Sending,
    Success,
    Failed,
    Skipped,
}

/// 企微搜索候选人条目
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ContactCandidate {
    pub index: usize,
    pub title: String,
    #[serde(default)]
    pub subtitles: Vec<String>,
    #[serde(default)]
    pub has_desc: bool,
    #[serde(default)]
    pub is_group: bool,
}

/// 智能联系人安全决策结果
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DecisionResult {
    /// 1: 首项为目标本人直接回车; >=2: 首项为他人描述，向下按键至对应项; 0: 未匹配安全放行; -2: 全部为他人描述拦截
    pub choice: isize,
    pub reason: String,
    pub engine: String,
}

/// 云端视觉 API 请求 Payload
#[derive(Debug, Serialize, Deserialize)]
pub struct CloudVisionPayload {
    pub client: String,
    pub task: String,
    pub target_id: String,
    pub target_name: String,
    pub image: String,
}

/// 云端视觉 API 响应
#[derive(Debug, Serialize, Deserialize)]
pub struct CloudVisionResponse {
    pub success: bool,
    #[serde(default)]
    pub choice: Option<isize>,
    #[serde(default)]
    pub matched: Option<bool>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}
