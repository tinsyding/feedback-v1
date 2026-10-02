use crate::types::{ContactCandidate, DecisionResult, FeedbackItem};
use regex::Regex;
use std::sync::OnceLock;

static ID_REGEX: OnceLock<Regex> = OnceLock::new();
static CYCLE_REGEX: OnceLock<Regex> = OnceLock::new();
static HTML_JSON_REGEX: OnceLock<Regex> = OnceLock::new();

/// 从字符串中拆分纯数字学号与纯学生姓名（例如从 '90001张三' 拆为 ('90001', '张三')）
pub fn parse_student_identifier(raw: &str) -> (String, String) {
    let raw = raw.trim();
    let re = ID_REGEX.get_or_init(|| Regex::new(r"^(\d+)[\s\-_\.、]*(.*)$").unwrap());
    if let Some(caps) = re.captures(raw) {
        let id = caps.get(1).map_or("", |m| m.as_str()).to_string();
        let name = caps.get(2).map_or("", |m| m.as_str()).trim().to_string();
        (id, name)
    } else {
        (String::new(), raw.to_string())
    }
}

/// 智能从文案中识别周次/讲次/周期标记（如「第 3 周」、「第 1 讲」）
pub fn detect_cycle_from_string(text: &str) -> String {
    let re = CYCLE_REGEX.get_or_init(|| {
        Regex::new(r"(?i)(第\s*\d+\s*[周讲期课]|week\s*\d+|w\d+)").unwrap()
    });
    if let Some(mat) = re.find(text) {
        let raw = mat.as_str().trim();
        // 归一化空格
        let normalized = raw.split_whitespace().collect::<Vec<_>>().join(" ");
        normalized
    } else {
        String::new()
    }
}

/// 从标准 JSON 文本中解析反馈名单
pub fn parse_json(content: &str) -> Result<Vec<FeedbackItem>, serde_json::Error> {
    let mut items: Vec<FeedbackItem> = serde_json::from_str(content)?;
    for item in &mut items {
        let (id, name) = parse_student_identifier(&item.student_name);
        item.student_id = id;
        item.clean_name = if name.is_empty() {
            item.student_name.clone()
        } else {
            name
        };
        if item.cycle.is_empty() {
            item.cycle = detect_cycle_from_string(&item.message);
        }
    }
    Ok(items)
}

/// 从网页快照 HTML 中提取内嵌的结构化 JSON 数据
pub fn parse_html_embedded_json(html: &str) -> Option<Vec<FeedbackItem>> {
    let re = HTML_JSON_REGEX.get_or_init(|| {
        Regex::new(r#"(?s)<script[^>]+id=["']feedback-data["'][^>]*>(.*?)</script>"#).unwrap()
    });
    let caps = re.captures(html)?;
    let json_text = caps.get(1)?.as_str().trim();
    parse_json(json_text).ok()
}

/// 解析 HTML 反馈快照，优先提取内嵌 JSON，其次匹配卡片 DOM 节点
pub fn parse_html(html: &str) -> Result<Vec<FeedbackItem>, String> {
    if let Some(items) = parse_html_embedded_json(html) {
        return Ok(items);
    }

    let card_re = Regex::new(r#"(?s)<div[^>]*class=["'][^"']*(?:feedback-card|student-card)[^"']*["'][^>]*>(.*?)</div>"#).map_err(|e| e.to_string())?;
    let name_re = Regex::new(r#"(?s)<(?:h\d|div|span)[^>]*class=["'][^"']*student-name[^"']*["'][^>]*>(.*?)</(?:h\d|div|span)>"#).map_err(|e| e.to_string())?;
    let msg_re = Regex::new(r#"(?s)<(?:pre|div|p)[^>]*class=["'][^"']*(?:message-body|feedback-text)[^"']*["'][^>]*>(.*?)</(?:pre|div|p)>"#).map_err(|e| e.to_string())?;

    let mut items = Vec::new();
    for card in card_re.captures_iter(html) {
        let card_html = card.get(1).map_or("", |m| m.as_str());
        let name = name_re.captures(card_html).and_then(|c| c.get(1)).map_or("", |m| m.as_str()).trim();
        let msg = msg_re.captures(card_html).and_then(|c| c.get(1)).map_or("", |m| m.as_str()).trim();
        if !name.is_empty() && !msg.is_empty() {
            let (id, clean_name) = parse_student_identifier(name);
            items.push(FeedbackItem {
                student_name: name.to_string(),
                message: msg.to_string(),
                student_id: id,
                clean_name: if clean_name.is_empty() { name.to_string() } else { clean_name },
                cycle: detect_cycle_from_string(msg),
                status: Default::default(),
            });
        }
    }

    if items.is_empty() {
        Err("未能从 HTML 中提取到学生反馈数据".to_string())
    } else {
        Ok(items)
    }
}

/// 通用联系人下拉候选安全决策中枢 (与 Python 算法 1:1 对齐)
pub fn evaluate_contact_candidates(
    contacts: &[ContactCandidate],
    target_id: &str,
    target_name: &str,
    engine: &str,
) -> DecisionResult {
    if contacts.is_empty() {
        return DecisionResult {
            choice: 0,
            reason: format!("未找到该联系人 [{engine}]"),
            engine: engine.to_string(),
        };
    }

    let match_contact = |c: &ContactCandidate| -> bool {
        let title = c.title.trim();
        if title.is_empty() || c.is_group {
            return false;
        }
        // 排除全局搜索等按钮项
        if ["全局", "查找", "搜索", "网络"].iter().any(|&k| title.contains(k)) {
            return false;
        }
        // 如果该项明确带描述 (如「描述: 包含90001」)，而标题并非目标本人，则不作为目标候选
        if c.has_desc {
            return false;
        }
        // 1. 标题包含数字学号 (如 '90001', '90001张三')
        if !target_id.is_empty() && title.contains(target_id) {
            return true;
        }
        // 2. 标题包含目标学生纯姓名 (如 '张三', '张三妈妈')
        if !target_name.is_empty() && title.contains(target_name) {
            return true;
        }
        false
    };

    let target_pos = contacts.iter().position(match_contact).map(|idx| idx + 1);
    let has_any_desc = contacts.iter().any(|c| c.has_desc);

    match target_pos {
        Some(1) => DecisionResult {
            choice: 1,
            reason: format!("第1项即为目标本人 ({}) [{engine}]", contacts[0].title),
            engine: engine.to_string(),
        },
        Some(pos) => DecisionResult {
            choice: pos as isize,
            reason: format!(
                "第1项为他人描述，第{pos}项为目标本人 ({}) [{engine}]",
                contacts[pos - 1].title
            ),
            engine: engine.to_string(),
        },
        None if has_any_desc => DecisionResult {
            choice: -2,
            reason: format!("全部为他人描述，无本人备注 [{engine}]"),
            engine: engine.to_string(),
        },
        None => DecisionResult {
            choice: 0,
            reason: format!("未找到该联系人 [{engine}]"),
            engine: engine.to_string(),
        },
    }
}
