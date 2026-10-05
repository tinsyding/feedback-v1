//! 现场截图归档（防误发事后举证）
//!
//! 对齐 Python 经典版 `_save_dropdown_debug_shot`（send_feedback.py:942）与
//! `_save_debug_header_shot`（send_feedback.py:1018）。
//!
//! 为什么必须有它：标题核验一旦拦截，界面上只留一行文字。若不落盘截图，
//! 事后根本无法复盘「当时屏幕上到底看到了什么」——而 OCR 误读恰恰是
//! 最需要排查的故障类型。截图是这类事故唯一的证据。
//!
//! 存储目录与经典版一致：优先当前用户「文档」下的 `JFFeedback/`（重装/换
//! exe 位置不丢、多用户互不串），取不到时回退到 `%LOCALAPPDATA%\JFFeedback\`。

use image::DynamicImage;
use std::path::PathBuf;

/// 数据目录名，与经典版 `USER_DATA_DIRNAME` 保持一致
const DATA_DIRNAME: &str = "JFFeedback";
/// 现场截图子目录名，与经典版一致
const DEBUG_IMG_SUBDIR: &str = "debug_screenshots";

/// 判定「截图是否有效」的最小宽高
///
/// 驱动未提供真实图像时会退化成 1x1 占位图；归档它只会污染截图目录，
/// 让真正的现场图淹没在噪声里。下限取得很宽松，只挡明显占位图。
const MIN_SHOT_WIDTH: u32 = 16;
const MIN_SHOT_HEIGHT: u32 = 8;

/// 获取持久化数据目录（文档 → LOCALAPPDATA 兜底）
pub fn data_dir() -> PathBuf {
    if let Some(docs) = user_documents_dir() {
        let dir = docs.join(DATA_DIRNAME);
        if std::fs::create_dir_all(&dir).is_ok() {
            return dir;
        }
    }
    // 兜底：LOCALAPPDATA（JFFeedback），再兜底临时目录
    let fallback = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
        .unwrap_or_else(std::env::temp_dir)
        .join(DATA_DIRNAME);
    let _ = std::fs::create_dir_all(&fallback);
    fallback
}

/// 现场截图目录
pub fn debug_img_dir() -> PathBuf {
    data_dir().join(DEBUG_IMG_SUBDIR)
}

/// 取当前用户「文档」目录，含 OneDrive 重定向兼容。
///
/// 与经典版 `_get_user_documents_dir()`（send_feedback.py:242）同策略：
/// 只读环境变量并逐个探测，不引入 SHGetKnownFolderPath 等额外 Win32 依赖。
/// 返回 `None` 表示取不到，由调用方回退。
fn user_documents_dir() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        let home = PathBuf::from(home);
        candidates.push(home.join("Documents"));
    }
    if let Some(up) = std::env::var_os("USERPROFILE") {
        let up = PathBuf::from(up);
        candidates.push(up.join("Documents"));
        candidates.push(up.join("OneDrive/Documents"));
    }
    candidates.into_iter().find(|c| c.is_dir())
}

/// 把文件名里的路径分隔符与空白等非法字符替换为 `_`
///
/// 对齐经典版 `re.sub(r'[\\/:*?"<>|\s]', '_', ...)`（send_feedback.py:949）。
/// 全非法字符时退化为 `unknown` —— 空名会让文件名塌成 `.png`。
pub fn sanitize_filename(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_whitespace() => '_',
            c => c,
        })
        .collect();
    let t = s.trim_matches('_').to_string();
    if t.is_empty() {
        "unknown".to_string()
    } else {
        t
    }
}

/// 归档失败的原因
///
/// 刻意不静默吞掉：截图是防误发事故的**唯一**物证，
/// 存不下来这件事本身必须能被告警看见（对齐经典版 save 前后的
/// `[现场调试快照保存失败]` WARN 日志，send_feedback.py:952）。
#[derive(Debug)]
pub enum DebugShotError {
    /// 截图无有效尺寸（驱动未提供真实图像时的 1x1 占位图）
    NotCaptured { width: u32, height: u32 },
    /// 建目录失败
    CreateDir {
        /// 出错环节的中文描述，进日志时无需再翻译
        context: &'static str,
        source: std::io::Error,
    },
    /// PNG 编码 / 写盘失败
    Encode {
        path: PathBuf,
        source: image::ImageError,
    },
}

impl std::fmt::Display for DebugShotError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DebugShotError::NotCaptured { width, height } => write!(
                f,
                "未捕获到有效截图（{width}x{height}，疑似驱动未提供图像）"
            ),
            DebugShotError::CreateDir { context, source } => write!(f, "{context}失败: {source}"),
            DebugShotError::Encode { path, source } => {
                write!(f, "写入现场截图 {} 失败: {source}", path.display())
            }
        }
    }
}

impl std::error::Error for DebugShotError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            DebugShotError::NotCaptured { .. } => None,
            DebugShotError::CreateDir { source, .. } => Some(source),
            DebugShotError::Encode { source, .. } => Some(source),
        }
    }
}

/// 归档一张现场截图到默认目录（`debug_img_dir()`）
///
/// 语义见 [`save_debug_shot_into`]。
pub fn save_debug_shot(
    img: &DynamicImage,
    kind: &str,
    tag: &str,
    target_id: &str,
    target_name: &str,
) -> Result<PathBuf, DebugShotError> {
    let dir = debug_img_dir();
    save_debug_shot_into(&dir, img, kind, tag, target_id, target_name)
}

/// 归档一张现场截图到**指定目录**，返回落盘路径
///
/// * `dir` —— 输出目录，不存在时自动创建
/// * `img` —— 待保存的裁剪图
/// * `kind` —— 截图类别（`header` / `dropdown`）
/// * `tag` —— 判定标签（`mismatch` / `uncertain` / `choice2_LocalOCR` 等）
/// * `target_id` / `target_name` —— 目标学生，用于文件名溯源
///
/// 目录作为参数而非内部隐式解析，是为了让测试能落到各自的临时目录：
/// `data_dir()` 依赖进程级环境变量，单测里并行改它会互相串扰
/// （一个用例的清理会删掉另一个刚写的文件）。
///
/// 绝不 panic；失败以 [`DebugShotError`] 返回，由调用方决定是否告警。
pub fn save_debug_shot_into(
    dir: &std::path::Path,
    img: &DynamicImage,
    kind: &str,
    tag: &str,
    target_id: &str,
    target_name: &str,
) -> Result<PathBuf, DebugShotError> {
    // 空白/占位图不是证据，只会污染截图目录。
    // 驱动未提供真实图像时会退化成 1x1 占位图，这里直接拒绝。
    let (w, h) = (img.width(), img.height());
    if w < MIN_SHOT_WIDTH || h < MIN_SHOT_HEIGHT {
        return Err(DebugShotError::NotCaptured { width: w, height: h });
    }

    std::fs::create_dir_all(dir).map_err(|e| DebugShotError::CreateDir {
        context: "创建现场截图目录",
        source: e,
    })?;

    let label = sanitize_filename(&format!("{target_id}_{target_name}"));
    // 用与日志同源的文件名安全时间戳，保证截图能与日志对上同一时刻
    let path = dir.join(format!(
        "{}_{}_{}_{}.png",
        crate::log_file::timestamp_compact(),
        kind,
        tag,
        label
    ));
    img.save(&path)
        .map_err(|e| DebugShotError::Encode { path: path.clone(), source: e })?;
    Ok(path)
}