use crate::image_proc::image_to_base64_jpeg;
use crate::log_file::{LogEntry, UPLOAD_CHUNK};
use crate::types::{CloudVisionData, CloudVisionPayload, CloudVisionResponse, DecisionResult};
use image::DynamicImage;
use std::time::Duration;

/// 云端诊断服务器，对齐 Python 经典版 `DEFAULT_CLOUD_SERVER`（send_feedback.py:1190）
pub const DEFAULT_CLOUD_SERVER: &str = "https://feedback.wxjifang.cn";

/// 上报用的客户端版本号，与界面展示版本保持一致
pub const CLIENT_VERSION: &str = "v2.5.0-rust";

/// 本机指纹（服务端匿名上报的身份标识），对齐 `machine_tag()`（send_feedback.py:1203）
///
/// 计算机名清洗为 `[A-Za-z0-9_-]`，不可用时退化为 `pc`，最多 40 字符。
pub fn machine_tag() -> String {
    let raw = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "pc".to_string());
    let cleaned: String = raw
        .trim()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    let t = if cleaned.is_empty() { "pc" } else { &cleaned };
    t.chars().take(40).collect()
}

#[derive(Clone)]
pub struct CloudClient {
    base_url: String,
    client_tag: String,
    client: reqwest::Client,
}

impl CloudClient {
    pub fn new(base_url: &str, client_tag: &str) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default();
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            client_tag: client_tag.to_string(),
            client,
        }
    }

    /// 按环境变量覆盖默认服务器地址，便于内网/自建服务端联调
    pub fn from_env_or_default() -> Self {
        let base = std::env::var("JF_CLOUD_SERVER")
            .unwrap_or_else(|_| DEFAULT_CLOUD_SERVER.to_string());
        Self::new(&base, &machine_tag())
    }

    pub fn client_tag(&self) -> &str {
        &self.client_tag
    }

    /// 发起一次大模型视觉判定请求，返回 `data` 节点
    ///
    /// `task` 取值 `'dropdown'`（下拉候选定位）或 `'header'`（会话标题核验）。
    /// 网络失败、服务端未配置密钥、模型返回非 JSON 等，一律 `Err`——
    /// 调用方据此无缝降级到本地 OCR 备用引擎。
    pub async fn vision_detect_raw(
        &self,
        task: &str,
        img: &DynamicImage,
        target_id: &str,
        target_name: &str,
    ) -> Result<CloudVisionData, String> {
        let b64 =
            image_to_base64_jpeg(img, 85).map_err(|e| format!("图像转码 Base64 失败: {e}"))?;

        let url = format!("{}/api/desktop.php?action=vision_detect", self.base_url);
        let payload = CloudVisionPayload {
            client: self.client_tag.clone(),
            task: task.to_string(),
            target_id: target_id.to_string(),
            target_name: target_name.to_string(),
            image: format!("data:image/jpeg;base64,{b64}"),
        };

        let resp = self
            .client
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("网络请求失败: {e}"))?;

        let status = resp.status();
        let result: CloudVisionResponse = resp
            .json()
            .await
            .map_err(|e| format!("响应解析 JSON 失败: {e}"))?;

        if !result.success {
            return Err(result
                .error
                .unwrap_or_else(|| format!("服务端拒绝请求 (HTTP {})", status.as_u16())));
        }
        result
            .data
            .ok_or_else(|| "服务端响应缺少 data 节点".to_string())
    }

    /// 模式 A：`task=dropdown` —— 下拉候选定位
    ///
    /// 返回 `None` 表示大模型未给出可用结论（相当于经典版的 `choice == -1`），
    /// 调用方应降级到本地 OCR。
    pub async fn detect_dropdown_via_vlm(
        &self,
        img: &DynamicImage,
        target_id: &str,
        target_name: &str,
    ) -> Option<DecisionResult> {
        let data = self
            .vision_detect_raw("dropdown", img, target_id, target_name)
            .await
            .ok()?;

        let choice = data.choice?;
        // target_found=false 时，choice 允许 0 / -2，都是有效拦截结论
        if !(-2..=4).contains(&choice) {
            return None;
        }
        Some(DecisionResult {
            choice,
            reason: data.reason.unwrap_or_else(|| {
                format!(
                    "大模型视觉决策 choice={}（title={}）",
                    choice,
                    data.matched_title.unwrap_or_default()
                )
            }),
            engine: "Qwen3.8-Flash (Cloud)".to_string(),
        })
    }

    /// 模式 A：`task=header` —— 会话标题核验
    ///
    /// **不做**最终判定：只回传模型的 `matched` 与 `detected_title`，
    /// 由 `header_verify::apply_vlm_double_check()` 做二次防御，
    /// 防止大模型幻觉直接放行误发。
    pub async fn verify_header_via_vlm(
        &self,
        img: &DynamicImage,
        target_id: &str,
        target_name: &str,
    ) -> Result<(bool, String, String), String> {
        let data = self
            .vision_detect_raw("header", img, target_id, target_name)
            .await?;
        Ok((
            data.matched.unwrap_or(false),
            data.detected_title.unwrap_or_default(),
            data.reason.unwrap_or_default(),
        ))
    }

    /// 异步脱敏日志上报 (action=upload_logs)
    ///
    /// 对齐经典版 `cloud_upload_async()`（send_feedback.py:1462）：
    /// 按 [`crate::log_file::UPLOAD_CHUNK`] 分片，服务端逐片确认已保存条数。
    ///
    /// 任一片失败即**中止后续分片并返回已保存数**（经典版同策略）：
    /// 网络已经出问题时继续打剩余分片只会雪上加霜，且会撞服务端 30 次/分钟限频。
    ///
    /// 返回值是 `(已保存条数, 是否有失败)`，调用方据此记日志。
    pub async fn upload_logs(&self, entries: &[LogEntry]) -> Result<usize, String> {
        if entries.is_empty() {
            return Ok(0);
        }
        let url = format!("{}/api/desktop.php?action=upload_logs", self.base_url);
        let mut saved_total = 0usize;

        for (idx, chunk) in entries.chunks(UPLOAD_CHUNK).enumerate() {
            let payload = serde_json::json!({
                "client": self.client_tag,
                "version": CLIENT_VERSION,
                "entries": chunk,
            });
            let resp = self
                .client
                .post(&url)
                .header("Content-Type", "application/json")
                .json(&payload)
                .send()
                .await
                .map_err(|e| format!("第 {} 片网络失败: {e}", idx + 1))?;

            let status = resp.status();
            let body: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| format!("第 {} 片响应解析失败: {e}", idx + 1))?;

            if body.get("success").and_then(|v| v.as_bool()) != Some(true) {
                let msg = body
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("未知错误");
                return Err(format!("第 {} 片被服务端拒绝 (HTTP {}): {msg}", idx + 1, status.as_u16()));
            }
            saved_total += body
                .get("data")
                .and_then(|d| d.get("saved"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as usize;
        }
        Ok(saved_total)
    }

    /// 上报本机发送历史 (action=upload_history)，对齐经典版 `read_history_payload()` + 上报
    ///
    /// 服务端按 `client_info` 去重覆盖同一台机器的记录（`ON DUPLICATE KEY UPDATE`），
    /// 所以重复上报是幂等的。
    pub async fn upload_history(&self, history: &serde_json::Value) -> Result<usize, String> {
        let empty = match history {
            serde_json::Value::Object(o) => o.is_empty(),
            serde_json::Value::Array(a) => a.is_empty(),
            serde_json::Value::Null => true,
            _ => false,
        };
        if empty {
            return Err("本机暂无发送历史记录".to_string());
        }
        let url = format!("{}/api/desktop.php?action=upload_history", self.base_url);
        let payload = serde_json::json!({
            "client": self.client_tag,
            "version": CLIENT_VERSION,
            "history": history,
        });
        let resp = self
            .client
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("网络请求失败: {e}"))?;

        let status = resp.status();
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("响应解析失败: {e}"))?;
        if body.get("success").and_then(|v| v.as_bool()) != Some(true) {
            let msg = body
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("未知错误");
            return Err(format!("服务端拒绝 (HTTP {}): {msg}", status.as_u16()));
        }
        Ok(body
            .get("data")
            .and_then(|d| d.get("bytes"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as usize)
    }

    /// 上报本机诊断日志（读本地日志尾部并分片上传）
    ///
    /// 这是经典版「每次批次结束后后台自动上报」的对齐实现：
    /// 服务端管理员无需让老师手动导出日志即可看到现场轨迹。
    /// 失败只记本地 DEBUG，绝不打扰正在发信的用户。
    pub async fn upload_diagnostic_logs(&self, limit: usize) -> Result<usize, String> {
        let entries = crate::log_file::read_entries(limit, true);
        self.upload_logs(&entries).await
    }
}