//! 持久化调试日志（防误发事后举证）
//!
//! 对齐 Python 经典版 `log()`（send_feedback.py:321）与 `parse_log_entries()`
//! （send_feedback.py:1422）。
//!
//! 为什么必须有它：Rust 版此前所有日志只进内存 channel 转给前端 WebView，
//! 进程一关就彻底消失。误发事故发生后**没有任何证据**——既不知道当时
//! 核验读到了什么标题，也不知道下拉选中了第几项。Python 版靠落盘的
//! 5MB 滚动日志支撑事后复盘，这一层不能缺。
//!
//! 设计要点：
//! * 写入失败**绝不 panic、绝不阻塞发信主流程**（与经典版一致整体 try/except）。
//! * 超过 5MB 自动滚动为 `.bak`，只保留一代，与经典版一致。
//! * `parse_entries` 是**纯函数**（入参为日志文本而非文件路径），
//!   这样任务对齐逻辑可以完整单测，不依赖真实文件系统状态。

use serde::Serialize;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use crate::debug_shot::data_dir;

/// 单个日志文件上限，超过后滚动为 `.bak`
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

/// 日志文件名，与经典版 `LOG_FILE_PATH` 对齐
const LOG_FILENAME: &str = "feedback_debug.log";

/// 批量发送任务在日志中的标记，用于上传时对齐任务边界
const TASK_MARK: &str = "批量发送任务启动";

/// 上传时的硬上限，防止单次请求体过大
const HARD_CAP: usize = 1000;

/// 单次请求的分片大小，与经典版一致（服务端每片最多收这么多）
pub const UPLOAD_CHUNK: usize = 100;

/// 日志文件路径
pub fn log_path() -> PathBuf {
    data_dir().join(LOG_FILENAME)
}

// ================================================================
// 写入
// ================================================================

static LOGGER: OnceLock<Mutex<LogWriter>> = OnceLock::new();

fn logger() -> &'static Mutex<LogWriter> {
    LOGGER.get_or_init(|| Mutex::new(LogWriter::new(log_path(), MAX_LOG_BYTES)))
}

/// 追加写日志文件，超过上限自动滚动为 `.bak`
///
/// 抽成独立类型是为了**可注入阈值做单测**：5MB 阈值在测试里造一次太慢，
/// 而滚动逻辑恰恰是最容易写错、且写错后果最严重（磁盘被日志撑爆，
/// 或归档失效导致关键现场被覆盖）的部分。
pub struct LogWriter {
    path: PathBuf,
    max_bytes: u64,
    file: Option<File>,
    written: u64,
}

impl LogWriter {
    pub fn new(path: PathBuf, max_bytes: u64) -> Self {
        Self {
            path,
            max_bytes,
            file: None,
            written: 0,
        }
    }

    /// 滚动归档：当前文件改名 `.bak`，重新开一个空文件
    ///
    /// 只保留一代 `.bak`，与经典版一致 —— 更早的归档对排查最近一次事故
    /// 毫无价值，却会持续吃磁盘。
    fn rotate(&mut self) {
        // 必须先释放句柄，否则 Windows 上 rename 会被文件锁拒绝
        self.file = None;
        let bak = self.path.with_extension("log.bak");
        let _ = std::fs::remove_file(&bak);
        let _ = std::fs::rename(&self.path, &bak);
        self.written = 0;
    }

    fn ensure_open(&mut self) -> Result<&mut File, std::io::Error> {
        if self.file.is_none() {
            if let Some(dir) = self.path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            // 首次打开要认磁盘上已有的体积（上次进程留下的），否则滚动永远不触发
            self.written = std::fs::metadata(&self.path)
                .map(|m| m.len())
                .unwrap_or(0);
            if self.written > self.max_bytes {
                self.rotate();
            }
            self.file = Some(OpenOptions::new().create(true).append(true).open(&self.path)?);
        }
        Ok(self.file.as_mut().expect("刚打开"))
    }

    /// 写入一行。任何 I/O 失败都只返回 `Err`，由调用方静默忽略。
    ///
    /// **滚动判定必须放在每次写入前**。曾经把它放在「打开文件」分支里，
    /// 结果句柄一旦常驻就再也不会走到那里 —— 5MB 上限形同虚设，
    /// 日志文件会无上限增长直至撑爆磁盘。
    pub fn write_line(&mut self, level: &str, msg: &str) -> Result<(), std::io::Error> {
        if self.written > self.max_bytes {
            self.rotate();
        }
        let line = format!("[{}] [{}] {}\n", timestamp(), level, msg);
        let f = self.ensure_open()?;
        let n = f.write(line.as_bytes())?;
        let _ = f.flush();
        self.written = self.written.saturating_add(n as u64);
        Ok(())
    }

    /// 累计已写入字节数（供测试与诊断）
    pub fn written_bytes(&self) -> u64 {
        self.written
    }
}

/// 当前本地时间的各字段
///
/// Windows 上走 `GetLocalTime` 取真本地时间 —— 排查「下午 3 点那次误发」时，
/// UTC 时间戳对老师毫无参考价值。非 Windows 平台（仅用于单测与 CLI 诊断）
/// 退化为 UTC。
fn now_civil() -> (i64, u32, u32, u32, u32, u32, u16) {
    #[cfg(windows)]
    {
        use windows::Win32::System::SystemInformation::GetLocalTime;
        unsafe {
            let st = GetLocalTime();
            (
                st.wYear as i64,
                st.wMonth as u32,
                st.wDay as u32,
                st.wHour as u32,
                st.wMinute as u32,
                st.wSecond as u32,
                st.wMilliseconds as u16,
            )
        }
    }
    #[cfg(not(windows))]
    {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        let (y, mo, d, h, mi, s) = civil_from_epoch(now.as_secs() as i64);
        (y, mo, d, h, mi, s, now.subsec_millis() as u16)
    }
}

/// 本地时间戳 `YYYY-MM-DD HH:MM:SS.mmm`（日志行用）
///
/// 与经典版 `datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]` 同格式。
/// 这个格式**不可**用于文件名 —— 空格与冒号在 Windows 上都是非法字符。
pub fn timestamp() -> String {
    let (y, mo, d, h, mi, s, ms) = now_civil();
    format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}.{ms:03}")
}

/// 文件名安全的本地时间戳 `YYYYMMDD_HHMMSS`（现场截图用）
///
/// 与日志时间戳同源，保证「截图与日志能对上同一时刻」。
pub fn timestamp_compact() -> String {
    let (y, mo, d, h, mi, s, _) = now_civil();
    format!("{y:04}{mo:02}{d:02}_{h:02}{mi:02}{s:02}")
}

/// Unix 秒 → (年, 月, 日, 时, 分, 秒)，UTC。供非 Windows 平台生成时间戳。
#[cfg(not(windows))]
fn civil_from_epoch(secs: i64) -> (i64, u32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    // Hinnant 的 civil_from_days 算法
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (
        y,
        m,
        d,
        (sod / 3600) as u32,
        ((sod % 3600) / 60) as u32,
        (sod % 60) as u32,
    )
}

/// 写入一行日志到全局日志文件
///
/// 格式 `[ts] [LEVEL] msg`，与经典版逐字节一致 —— `parse_entries` 与
/// 服务端日志都依赖这个格式，改动需同步三处。
///
/// **任何失败都静默忽略**：日志是诊断旁路，绝不能因为磁盘满、权限不足
/// 或杀毒软件锁文件而中断发信。
pub fn write_line(level: &str, msg: &str) {
    let mut guard = match logger().lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    let _ = guard.write_line(level, msg);
}

// ================================================================
// 解析（供云端上报）
// ================================================================

/// 一条结构化日志，对应服务端 `upload_logs` 的 entries 元素
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LogEntry {
    /// 客户端时间戳（字符串，服务端原样存库，不参与解析）
    pub ts: String,
    /// 归一化等级：info / warn / error（服务端白名单外的会被降级为 info）
    pub level: String,
    /// 日志正文（服务端截断到 2000 字符）
    pub msg: String,
}

/// 归一化日志等级，对齐经典版 `_LOG_LEVEL_MAP`
///
/// 注意 `DEBUG` 归为 `info`：`debug` 不在服务端白名单里，
/// 传上去也会被降级为 info，不如在客户端就对齐语义。
fn normalize_level(raw: &str) -> &'static str {
    match raw.trim().to_ascii_uppercase().as_str() {
        "WARN" | "WARNING" => "warn",
        "ERROR" => "error",
        // "DEBUG" / "INFO" / 任何未知值
        _ => "info",
    }
}

/// 从「若干行日志文本」解析为结构化条目（**纯函数**）
///
/// `align_task = true` 时对齐到最近一次「批量发送任务启动」标记，
/// 保证上传的片段里至少包含一个**完整**任务（启动参数 → 逐人轨迹 →
/// 结束统计），而不是从半途开始的一段。找不到标记时退化为普通截尾。
///
/// 硬上限 [`HARD_CAP`] 行：任务过大或没有标记时兜底封顶上传体积。
///
/// 入参是文本而非路径，这样任务对齐逻辑可完整单测，
/// 不需要真的去造文件、也不受上一次日志状态污染。
pub fn parse_entries(content: &str, limit: usize, align_task: bool) -> Vec<LogEntry> {
    let lines: Vec<&str> = content.lines().collect();
    if lines.is_empty() {
        return Vec::new();
    }

    let selected: &[&str] = if align_task {
        let window = &lines[lines.len().saturating_sub(HARD_CAP)..];
        // 取**最后**一次任务起点：window 里后面的才是本次任务的日志
        match window.iter().rposition(|l| l.contains(TASK_MARK)) {
            Some(idx) => &window[idx..],
            None => &lines[lines.len().saturating_sub(limit)..],
        }
    } else {
        &lines[lines.len().saturating_sub(limit)..]
    };

    selected
        .iter()
        .filter(|l| !l.trim().is_empty())
        .map(|line| parse_line(line))
        .collect()
}

/// 解析单行日志
///
/// 无法匹配 `[ts] [LEVEL] msg` 时**不丢行**，而是以 `level=info`、空 `ts`
/// 原样保留正文。人手写的提示与早期版本遗留的行不会因此消失。
fn parse_line(line: &str) -> LogEntry {
    // 对齐经典版正则 `^\[(?P<ts>[^\]]+)\]\s*\[(?P<level>[A-Za-z]+)\]\s*(?P<msg>.*)$`
    if let Some(rest) = line.strip_prefix('[') {
        if let Some(ts_end) = rest.find(']') {
            let ts = &rest[..ts_end];
            let after = rest[ts_end + 1..].trim_start();
            if let Some(level) = after.strip_prefix('[') {
                if let Some(level_end) = level.find(']') {
                    let raw_level = &level[..level_end];
                    // 等级必须全部是字母（与经典版 [A-Za-z]+ 一致）
                    if !raw_level.is_empty() && raw_level.chars().all(|c| c.is_ascii_alphabetic()) {
                        return LogEntry {
                            ts: ts.chars().take(40).collect(),
                            level: normalize_level(raw_level).to_string(),
                            msg: level[level_end + 1..].trim_start().chars().take(2000).collect(),
                        };
                    }
                }
            }
        }
    }
    LogEntry {
        ts: String::new(),
        level: "info".to_string(),
        msg: line.chars().take(2000).collect(),
    }
}

/// 读取本地日志末尾并解析为待上报条目
///
/// 文件不存在或读失败都返回空列表（不报错）——上报是纯诊断旁路，
/// 不该因为没有日志文件而打扰用户。
pub fn read_entries(limit: usize, align_task: bool) -> Vec<LogEntry> {
    match std::fs::read_to_string(log_path()) {
        Ok(text) => parse_entries(&text, limit, align_task),
        Err(_) => Vec::new(),
    }
}

/// 供 UI 展示的本地日志尾部文本（对齐经典版「查看日志」面板）
pub fn tail_lines(limit: usize) -> Vec<String> {
    match std::fs::read_to_string(log_path()) {
        Ok(text) => {
            let all: Vec<&str> = text.lines().collect();
            all[all.len().saturating_sub(limit)..]
                .iter()
                .map(|s| s.to_string())
                .collect()
        }
        Err(_) => Vec::new(),
    }
}