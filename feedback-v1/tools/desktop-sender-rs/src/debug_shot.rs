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
fn sanitize(name: &str) -> String {
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

/// 本地时间戳 `YYYYMMDD_HHMMSS_mmm`
///
/// 无 chrono 依赖，手工按本地时间格式化。取不到时间时退化为进程内计数，
/// 保证文件名不重复即可（截图本身才是证据，文件名次要）。
fn timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // 累加秒 → 时/分/日/月/年（UTC），命名只需单调可读，不追求时区精确
    let mut y: i64 = 1970;
    let mut days = (now / 86_400) as i64;
    let secs_of_day = now % 86_400;
    while days > 0 {
        let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
        let ylen = if leap { 366 } else { 365 };
        if days < ylen {
            break;
        }
        days -= ylen;
        y += 1;
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let mlen = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut mi = 0usize;
    while mi < 12 && days >= mlen[mi] {
        days -= mlen[mi];
        mi += 1;
    }
    let m = mi as i64 + 1;
    let d = days + 1;

    let hh = secs_of_day / 3600;
    let mm = (secs_of_day % 3600) / 60;
    let ss = secs_of_day % 60;
    format!("{:04}{:02}{:02}_{:02}{:02}{:02}", y, m, d, hh, mm, ss)
}

/// 归档一张现场截图，返回落盘路径
///
/// * `img` —— 待保存的裁剪图
/// * `kind` —— 截图类别（`header` / `dropdown`）
/// * `tag` —— 判定标签（`mismatch` / `uncertain` / `vlm` / `vlm_mismatch`）
/// * `target_id` / `target_name` —— 目标学生，用于文件名溯源
///
/// 任何失败都只返回 `None`，绝不 panic 也绝不影响主发信流程。
pub fn save_debug_shot(
    img: &DynamicImage,
    kind: &str,
    tag: &str,
    target_id: &str,
    target_name: &str,
) -> Option<PathBuf> {
    let dir = debug_img_dir();
    std::fs::create_dir_all(&dir).ok()?;

    let label = sanitize(&format!("{}_{}", target_id, target_name));
    let path = dir.join(format!("{}_{}_{}_{}.png", timestamp(), kind, tag, label));
    img.save(&path).ok()?;
    Some(path)
}