use serde::{Deserialize, Deserializer, Serialize};

/// 原始与标准化的学生反馈条目
///
/// 注意：前端历史版本曾同时发送 `original_index` + `originalIndex`（见 ui/app.js），
/// serde 原生 `alias` 会把两者映射到同一字段并报 `duplicate field`。
/// 此处改为手工 Deserialize，对 snake_case / camelCase 做“后赢合并”，保证双端兼容。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FeedbackItem {
    #[serde(rename = "studentName")]
    pub student_name: String,
    pub message: String,
    pub student_id: String,
    pub clean_name: String,
    pub cycle: String,
    pub status: SendStatus,
    pub original_index: Option<usize>,
}

fn get_str<'a>(map: &'a serde_json::Map<String, serde_json::Value>, keys: &[&str]) -> String {
    for k in keys {
        if let Some(v) = map.get(*k) {
            if let Some(s) = v.as_str() {
                return s.to_string();
            }
            if v.is_number() {
                return v.to_string().trim_matches('"').to_string();
            }
        }
    }
    String::new()
}

fn get_opt_usize(map: &serde_json::Map<String, serde_json::Value>, keys: &[&str]) -> Option<usize> {
    // 后赢：按 keys 顺序遍历，保留最后一个有效值，兼容同时出现 snake + camel 的旧 payload
    let mut out: Option<usize> = None;
    for k in keys {
        if let Some(v) = map.get(*k) {
            if v.is_null() {
                continue;
            }
            if let Some(n) = v.as_u64() {
                out = Some(n as usize);
            } else if let Some(s) = v.as_str() {
                if let Ok(n) = s.trim().parse::<usize>() {
                    out = Some(n);
                }
            } else if let Some(n) = v.as_i64() {
                if n >= 0 {
                    out = Some(n as usize);
                }
            }
        }
    }
    out
}

impl<'de> Deserialize<'de> for FeedbackItem {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let map = serde_json::Map::<String, serde_json::Value>::deserialize(deserializer)?;
        let student_name = get_str(&map, &["studentName", "student_name"]);
        if student_name.is_empty() {
            // studentName 为必填，与之前 derive 行为保持一致（缺失即报错）
            return Err(serde::de::Error::missing_field("studentName"));
        }
        let message = map
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let student_id = get_str(&map, &["student_id", "studentId"]);
        let clean_name = get_str(&map, &["clean_name", "cleanName"]);
        let cycle = get_str(&map, &["cycle"]);
        let status: SendStatus = map
            .get("status")
            .map(|v| {
                serde_json::from_value::<SendStatus>(v.clone()).unwrap_or_default()
            })
            .unwrap_or_default();
        let original_index = get_opt_usize(&map, &["original_index", "originalIndex", "index"]);
        Ok(FeedbackItem {
            student_name,
            message,
            student_id,
            clean_name,
            cycle,
            status,
            original_index,
        })
    }
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

/// 下拉框单次抓取结果（含原始 OCR 文本与 DPI 信息，便于日志复盘）
#[derive(Debug, Clone, Default)]
pub struct DropdownCapture {
    pub candidates: Vec<ContactCandidate>,
    /// OCR 未结构化的原始全文（空格已去除）
    pub raw_text: String,
    /// 截取时所用显示器 DPI 缩放系数
    pub dpi_scale: f32,
    /// 下拉框原始裁剪图（预处理前的干净图）
    ///
    /// 保留它有两个用途：一是云端大模型核验（对齐经典版 `capture_dropdown_crop`），
    /// 二是判定留证 —— 选错联系人时，这是唯一能说明「当时屏幕上到底
    /// 看到了什么候选列表」的证据（对齐经典版 `_save_dropdown_debug_shot`）。
    pub image: image::DynamicImage,
}

/// 会话标题条单次抓取结果
///
/// 同时保留图像与 OCR 文本：文本供本地判定（模式 B），
/// 图像供云端大模型复核（模式 A）与拦截时的现场截图归档。
#[derive(Debug, Clone, Default)]
pub struct HeaderCapture {
    /// 标题条裁剪图
    pub image: image::DynamicImage,
    /// OCR 读到的标题文本（空格已去除；空串表示未读到有效文字）
    pub text: String,
    /// 截取时所用显示器 DPI 缩放系数
    pub dpi_scale: f32,
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

/// 云端视觉 API 响应（信封）
///
/// 服务端 `bootstrap.php:53` 的 `sendResponse()` 统一输出
/// `{success, data, error}`，业务字段全部嵌在 `data` 里：
/// * `task=dropdown` → `{ target_found, choice, matched_title, reason, duration_ms }`
/// * `task=header`   → `{ matched, detected_title, reason, duration_ms }`
///
/// 注意：此处**不能**把业务字段平铺到顶层——那与实际报文不符。
#[derive(Debug, Serialize, Deserialize)]
pub struct CloudVisionResponse {
    #[serde(default)]
    pub success: bool,
    #[serde(default)]
    pub data: Option<CloudVisionData>,
    #[serde(default)]
    pub error: Option<String>,
}

/// 云端视觉 API 业务数据（`data` 节点）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CloudVisionData {
    /// dropdown：目标是否在通讯录中找到独立条目
    #[serde(default)]
    pub target_found: Option<bool>,
    /// dropdown：命中项序号（1~4 命中；0 无联系人；-2 仅他人描述）
    #[serde(default)]
    pub choice: Option<isize>,
    /// dropdown：命中条目的主标题
    #[serde(default)]
    pub matched_title: Option<String>,
    /// header：标题是否为目标本人
    #[serde(default)]
    pub matched: Option<bool>,
    /// header：识别出的完整标题文本
    #[serde(default)]
    pub detected_title: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub duration_ms: Option<u64>,
}
