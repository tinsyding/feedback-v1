use crate::image_proc::image_to_base64_jpeg;
use crate::types::{CloudVisionPayload, CloudVisionResponse, DecisionResult};
use image::DynamicImage;
use std::time::Duration;

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

    /// 模式 A: 向服务端发起大模型视觉 (Qwen3.8-Flash) 候选人/标题判定请求
    pub async fn vision_detect(
        &self,
        task: &str,
        img: &DynamicImage,
        target_id: &str,
        target_name: &str,
    ) -> Result<DecisionResult, String> {
        let b64 = image_to_base64_jpeg(img, 85)
            .map_err(|e| format!("图像转码 Base64 失败: {e}"))?;

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

        let result: CloudVisionResponse = resp
            .json()
            .await
            .map_err(|e| format!("响应解析 JSON 失败: {e}"))?;

        if !result.success {
            return Err(result.error.unwrap_or_else(|| "服务端拒绝请求".into()));
        }

        let choice = result.choice.unwrap_or(0);
        let reason = result
            .reason
            .unwrap_or_else(|| "大模型视觉决策完成".into());

        Ok(DecisionResult {
            choice,
            reason,
            engine: "Qwen3.8-Flash (Cloud)".to_string(),
        })
    }

    /// 异步脱敏日志上报 (action=upload_logs)
    pub async fn upload_logs(&self, lines: &[String]) -> Result<(), String> {
        let url = format!("{}/api/desktop.php?action=upload_logs", self.base_url);
        let payload = serde_json::json!({
            "client": self.client_tag,
            "version": "v2.4-rust",
            "entries": lines
        });
        let _ = self.client.post(&url).json(&payload).send().await;
        Ok(())
    }
}
