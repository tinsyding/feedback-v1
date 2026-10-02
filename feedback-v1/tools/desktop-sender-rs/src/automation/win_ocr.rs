use image::DynamicImage;

#[derive(Debug, Clone, Default)]
pub struct OcrLine {
    pub text: String,
}

#[derive(Debug, Clone, Default)]
pub struct OcrRecognizeResult {
    pub lines: Vec<OcrLine>,
    pub full_text: String,
}

#[cfg(windows)]
mod imp {
    use super::*;
    use windows::core::HSTRING;
    use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};

    pub fn is_windows_ocr_available() -> bool {
        let lang = HSTRING::from("zh-Hans-CN");
        OcrEngine::IsLanguageSupported(&lang).unwrap_or(false)
    }

    /// 使用 Windows 10/11 原生系统内置离线 OCR 识别图像
    pub fn recognize_native_ocr(img: &DynamicImage) -> Result<OcrRecognizeResult, String> {
        let rgba = img.to_rgba8();
        let (width, height) = rgba.dimensions();

        let stream = InMemoryRandomAccessStream::new()
            .map_err(|e| format!("创建流失败: {e}"))?;
        let writer = DataWriter::CreateDataWriter(&stream)
            .map_err(|e| format!("创建 DataWriter 失败: {e}"))?;

        writer
            .WriteBytes(rgba.as_raw())
            .map_err(|e| format!("写入像素流失败: {e}"))?;
        writer
            .StoreAsync()
            .map_err(|e| format!("持久化流失败: {e}"))?
            .get()
            .map_err(|e| format!("等待流写入失败: {e}"))?;

        let software_bitmap = SoftwareBitmap::CreateCopyFromBuffer(
            &stream.GetInputStreamAt(0).map_err(|e| format!("获取输入流失败: {e}"))?,
            BitmapPixelFormat::Rgba8,
            width as i32,
            height as i32,
        ).map_err(|e| format!("创建 SoftwareBitmap 失败: {e}"))?;

        let lang = HSTRING::from("zh-Hans-CN");
        let engine = OcrEngine::TryCreateFromLanguage(&lang)
            .map_err(|e| format!("创建 OcrEngine 失败: {e}"))?;

        let ocr_result = engine
            .RecognizeAsync(&software_bitmap)
            .map_err(|e| format!("发起 OCR 识别失败: {e}"))?
            .get()
            .map_err(|e| format!("OCR 识别执行失败: {e}"))?;

        let lines_view = ocr_result.Lines().map_err(|e| format!("获取行列表失败: {e}"))?;
        let mut lines = Vec::new();
        let mut full_text = String::new();

        for line in lines_view {
            if let Ok(text) = line.Text() {
                let line_str = text.to_string();
                full_text.push_str(&line_str);
                lines.push(OcrLine { text: line_str });
            }
        }

        Ok(OcrRecognizeResult { lines, full_text })
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;

    pub fn is_windows_ocr_available() -> bool {
        false
    }

    pub fn recognize_native_ocr(_img: &DynamicImage) -> Result<OcrRecognizeResult, String> {
        Err("Windows Native OCR 仅支持在 Windows 操作系统运行".to_string())
    }
}

pub use imp::*;

use crate::types::ContactCandidate;

/// 从 OCR 识别出的文本行序列中，结构化还原联系人列表与描述关系（1:1 对齐企微下拉列表交互特征）
pub fn parse_ocr_lines_to_contacts(lines: &[OcrLine], full_text: &str) -> Vec<ContactCandidate> {
    let contact_headers = ["联系人", "外部联系人", "客户", "企业通讯录"];
    let section_end_keywords = [
        "群聊", "最常使用", "功能", "聊天记录", "文档",
        "网络查找", "相关搜索", "查看全部", "进入全局搜索", "查找所有",
    ];
    let subtitle_keywords = [
        "描述", "庙述", "猫述", "描术", "微信昵称", "昵称",
        "手机号", "手机", "包含", "部门", "企业", "公司", "邮箱", "微信号", "备注", "含",
    ];

    let is_subtitle = |t: &str| -> bool {
        subtitle_keywords.iter().any(|&kw| t.contains(kw)) || t.contains('：') || t.contains(':')
    };

    let has_contact_header = lines
        .iter()
        .any(|l| contact_headers.iter().any(|&h| l.text.contains(h)));
    let has_empty_indicator = [
        "进入全局搜索", "全局搜索", "查找所有", "网络查找", "没有找到", "无结果", "未找到", "暂无结果",
    ]
    .iter()
    .any(|&k| full_text.contains(k));

    if !has_contact_header && has_empty_indicator {
        return Vec::new();
    }

    let mut contacts: Vec<ContactCandidate> = Vec::new();
    let mut in_contacts = !has_contact_header;
    let mut current_contact: Option<ContactCandidate> = None;

    for line in lines {
        let text = line.text.trim();
        if text.is_empty() {
            continue;
        }

        if contact_headers.iter().any(|&h| text.contains(h)) {
            in_contacts = true;
            continue;
        }

        if in_contacts && section_end_keywords.iter().any(|&h| text.contains(h)) {
            if let Some(c) = current_contact.take() {
                contacts.push(c);
            }
            break;
        }

        if in_contacts
            && (text.contains("包含") || text.contains("包含:") || text.contains("包含："))
        {
            if let Some(c) = current_contact.take() {
                contacts.push(c);
            }
            break;
        }

        if in_contacts {
            if is_subtitle(text) {
                if let Some(c) = current_contact.as_mut() {
                    c.subtitles.push(text.to_string());
                    if ["描述", "庙述", "猫述", "描术", "含"].iter().any(|&k| text.contains(k)) {
                        c.has_desc = true;
                    }
                } else {
                    let has_desc = ["描述", "庙述", "猫述", "描术", "含"].iter().any(|&k| text.contains(k));
                    current_contact = Some(ContactCandidate {
                        index: contacts.len() + 1,
                        title: String::new(),
                        subtitles: vec![text.to_string()],
                        has_desc,
                        is_group: false,
                    });
                }
            } else {
                if let Some(c) = current_contact.take() {
                    contacts.push(c);
                }
                current_contact = Some(ContactCandidate {
                    index: contacts.len() + 1,
                    title: text.to_string(),
                    subtitles: Vec::new(),
                    has_desc: false,
                    is_group: text.contains("群聊") || text.contains("人)"),
                });
            }
        }
    }

    if let Some(c) = current_contact {
        contacts.push(c);
    }

    contacts
}
