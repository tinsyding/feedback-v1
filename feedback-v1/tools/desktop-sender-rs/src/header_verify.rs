//! 会话标题安全检查点（Check Point）
//!
//! 对齐 Python 经典版 `verify_chat_header_title()`（send_feedback.py:1139）的能力：
//! 回车进入会话后、**发送文案之前**，截取企微聊天区顶部标题条并核验当前会话
//! 身份是否确为目标学生。判据与经典版保持一致：
//!
//! * `MATCH`     —— 标题同时包含学号与姓名（两者都提供时），放行发送。
//! * `MISMATCH`  —— 读到了文字但未全匹配，**拦截**。
//! * `UNCERTAIN` —— 完全读不到文字（截图为空 / OCR 无输出），**拦截**。
//!
//! 关键安全约定：本模块 **fail-closed**。经典版对 `MISMATCH` 与 `UNCERTAIN`
//! 一律 `dismiss_and_clear_search()` 后放弃发送（send_feedback.py:3921-3941），
//! 只有 `MATCH` 才继续粘贴并回车。Rust 版必须保持同样语义，
//! 绝不可把 `UNCERTAIN` 当作放行——那是不可逆的误发事故。
//!
//! 本模块只做纯逻辑，不碰 Win32 / OCR / 网络，便于单测覆盖全部判定分支。

use serde::{Deserialize, Serialize};

/// 标题核验三态结论
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum HeaderVerdict {
    /// 核验通过，可以发送
    Match,
    /// 确凿误选（当前会话是别人），必须拦截
    Mismatch,
    /// 读不到标题 / 无法判定，同样必须拦截（fail-closed）
    Uncertain,
}

impl HeaderVerdict {
    /// 是否允许继续发送。只有 Match 放行。
    pub fn allows_send(self) -> bool {
        matches!(self, HeaderVerdict::Match)
    }

    /// 日志级别：拦截类一律按 ERROR 记录，便于事后复盘
    pub fn log_level(self) -> &'static str {
        match self {
            HeaderVerdict::Match => "INFO",
            HeaderVerdict::Mismatch | HeaderVerdict::Uncertain => "ERROR",
        }
    }
}

/// 一次标题核验的完整结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeaderCheck {
    pub verdict: HeaderVerdict,
    /// 实际读到的标题文本（可能为空）
    pub detected_title: String,
    /// 判定理由，进日志
    pub reason: String,
}

impl HeaderCheck {
    pub fn match_ok(detected_title: impl Into<String>) -> Self {
        Self {
            verdict: HeaderVerdict::Match,
            detected_title: detected_title.into(),
            reason: "标题完全命中目标".to_string(),
        }
    }

    pub fn mismatch(detected_title: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            verdict: HeaderVerdict::Mismatch,
            detected_title: detected_title.into(),
            reason: reason.into(),
        }
    }

    pub fn uncertain(reason: impl Into<String>) -> Self {
        Self {
            verdict: HeaderVerdict::Uncertain,
            detected_title: String::new(),
            reason: reason.into(),
        }
    }

    pub fn allows_send(&self) -> bool {
        self.verdict.allows_send()
    }
}

/// 归一化标题文本：抹掉全部空白字符
///
/// 与经典版一致：Python 侧 OCR 结果统一做了 `replace(" ", "")` 再比对，
/// 否则 `80001 李四` 与 `80001李四` 会被判成不同标题。
///
/// 这里比经典版多去掉制表符与换行：OCR 在竖排文字或折行标题上会吐出
/// `\t` / `\n`，只抹半角空格会让「只读到空白」的样本落进 `MISMATCH`，
/// 日志里显示成「误选他人」而实际是「什么都没读到」，误导事后排查。
/// 两者的处置动作相同（都拦截），只是把原因说准。
fn normalize_title(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

/// 标题是否**完全**命中目标
///
/// 复刻经典版 `verify_chat_header_title_via_ocr` 的 `is_full_match`：
/// 学号与姓名都提供时必须同时出现，缺一不可。
fn is_full_match(text: &str, target_id: &str, target_name: &str) -> bool {
    match (target_id.is_empty(), target_name.is_empty()) {
        (false, false) => text.contains(target_id) && text.contains(target_name),
        (false, true) => text.contains(target_id),
        (true, false) => text.contains(target_name),
        (true, true) => false,
    }
}

/// 扫描文本中的 4~6 位数字串（学号）
///
/// **有意的行为差异**：经典版用 `re.findall(r'\b\d{4,6}\b', ...)`，
/// 而标题文本在 OCR 阶段已被抹掉全部空格，`90001张三` 中的 `90001`
/// 右侧紧邻汉字（Unicode 词字符），`\b` 不成立——所以经典版的这条
/// 误选判据在真实标题上几乎从不触发。
///
/// 这里改为**无边界**扫描，命中集合是经典版的超集，因此只会**多**判
/// MISMATCH、不会**少**判。误发是不可逆事故，多拦一次的方向是安全的；
/// 少拦一次不是。
///
/// 仅用于挑选更精确的 `reason` 文案，不参与放行/拦截的最终判定。
fn scan_id_runs(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() && i - start < 6 {
                i += 1;
            }
            if i - start >= 4 {
                out.push(&text[start..i]);
            }
        } else {
            i += 1;
        }
    }
    out
}

/// 从 OCR 文本判定标题核验结论
///
/// 判定顺序与经典版一致（send_feedback.py:1054-1133 + 1119-1133 兜底分支）：
/// 1. 抹空格后为空 → `UNCERTAIN`
/// 2. 学号与姓名同时命中 → `MATCH`
/// 3. 其余读到了文字的情况 → `MISMATCH`（fail-closed）
///
/// 经典版步骤 2/3 中的「其他学号」「含 @ 」两条子判据只是**提前返回**以
/// 多存一张现场截图；语义上等价于兜底分支，因此这里合并为同一个
/// `MISMATCH` 结果，只保留它们用于细化 `reason`。
pub fn judge_header_text(text: &str, target_id: &str, target_name: &str) -> HeaderCheck {
    let normalized = normalize_title(text);
    if normalized.is_empty() {
        return HeaderCheck::uncertain("标题条未读到有效文本");
    }

    if is_full_match(&normalized, target_id, target_name) {
        return HeaderCheck::match_ok(normalized);
    }

    // 未全匹配但读到了文字 —— 拦截。细化 reason 便于事后定位误选类型。
    let reason = if has_foreign_id(&normalized, target_id) {
        format!(
            "标题为其他学生学号（期望 id='{}' name='{}'）",
            target_id, target_name
        )
    } else if is_other_contact(&normalized, target_name) {
        format!(
            "标题为其他联系人且不含目标姓名（期望 id='{}' name='{}'）",
            target_id, target_name
        )
    } else {
        format!(
            "标题未同时包含学号与姓名（期望 id='{}' name='{}'）",
            target_id, target_name
        )
    };
    HeaderCheck::mismatch(normalized, reason)
}

/// 判据 A：标题里出现了 4~6 位学号，且不含目标学号
fn has_foreign_id(text: &str, target_id: &str) -> bool {
    if target_id.is_empty() {
        return false;
    }
    let runs = scan_id_runs(text);
    !runs.is_empty() && !runs.iter().any(|r| *r == target_id)
}

/// 判据 B：标题含 `@微信` / `@` 且不含目标姓名
fn is_other_contact(text: &str, target_name: &str) -> bool {
    if target_name.is_empty() {
        return false;
    }
    (text.contains("@微信") || text.contains('@')) && !text.contains(target_name)
}

/// 云端大模型核验结果的二次防御
///
/// 复刻经典版 `verify_chat_header_title_via_vlm`（send_feedback.py:1393）：
/// 模型可能误报 `matched=true`，因此**无条件**用本地字符串再核一遍
/// `detected_title`；模型说匹配但字符串里没有学号/姓名时，一律降级为
/// `MISMATCH`。这一步是防止大模型幻觉直接放行误发的关键防线。
pub fn apply_vlm_double_check(
    model_matched: bool,
    detected_title: &str,
    target_id: &str,
    target_name: &str,
) -> HeaderCheck {
    let normalized = normalize_title(detected_title);
    if !model_matched {
        return HeaderCheck::mismatch(normalized, "大模型判定不匹配");
    }
    if is_full_match(&normalized, target_id, target_name) {
        HeaderCheck::match_ok(normalized)
    } else {
        HeaderCheck::mismatch(
            normalized,
            format!(
                "大模型返回 matched=true 但标题未同时包含学号与姓名，已纠偏为不匹配（期望 id='{}' name='{}'）",
                target_id, target_name
            ),
        )
    }
}

/// 计算聊天区顶部标题条的裁剪矩形（纯函数，可单测）
///
/// 逐行复刻经典版 `capture_header_crop`（send_feedback.py:1318）与
/// `verify_chat_header_title_via_ocr` 内联的同一套偏移量：以 96 DPI（100%）
/// 为设计基准，左侧导航与会话列表约占 240px，标题条高约 52px，
/// 必须按显示器 DPI 缩放，否则高缩放屏会截错区域。
///
/// * `window` —— `(left, top, width)`，企微主窗口位置与宽度
/// * `scale` —— 窗口所在显示器 DPI 缩放系数（1.0 = 100%）
/// * `virtual_screen` —— `(vx, vy, vw, vh)` 多显示器虚拟桌面边界，
///   副屏在左侧/上方时为负坐标，这里做边界收敛防止截到屏幕外
///
/// 返回 `(left, top, width, height)`
pub fn compute_header_crop_rect(
    window: (i32, i32, i32),
    scale: f32,
    virtual_screen: (i32, i32, i32, i32),
) -> (i32, i32, i32, i32) {
    let (wx, wy, ww) = window;
    let (vx, vy, vw, vh) = virtual_screen;

    // Rust 的 `as i32` 与 Python 的 `int()` 一样向零截断，缩放口径一致
    let offset_x = (240.0 * scale) as i32;
    let offset_y = (4.0 * scale) as i32;
    let base_w = (400.0 * scale) as i32;
    let base_h = (52.0 * scale) as i32;

    let crop_x = vx.max(wx + offset_x);
    let crop_y = vy.max(wy + offset_y);

    // max(int(160*scale), min(base_w, max(200, ww - int(260*scale))))
    let mut crop_w = ((160.0 * scale) as i32)
        .max(base_w.min(200.max(ww - (260.0 * scale) as i32)));
    // max(int(40*scale), base_h)
    let mut crop_h = ((40.0 * scale) as i32).max(base_h);

    // 收敛到虚拟桌面边界内
    if crop_x + crop_w > vx + vw {
        crop_w = 50.max((vx + vw) - crop_x);
    }
    if crop_y + crop_h > vy + vh {
        crop_h = 30.max((vy + vh) - crop_y);
    }

    (crop_x, crop_y, crop_w, crop_h)
}