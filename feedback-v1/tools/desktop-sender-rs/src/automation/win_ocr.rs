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
