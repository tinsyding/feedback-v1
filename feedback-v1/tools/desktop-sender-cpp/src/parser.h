#pragma once

#include "types.h"
#include <string>
#include <vector>
#include <utility>
#include <optional>

namespace feedback {

/// 从字符串中拆分纯数字学号与纯学生姓名（例如从 '90001张三' 拆为 ('90001', '张三')）
std::pair<std::string, std::string> parse_student_identifier(const std::string& raw);

/// 智能从文案中识别周次/讲次/周期标记（如「第 3 周」、「第 1 讲」）
std::string detect_cycle_from_string(const std::string& text);

/// 从标准 JSON 文本中解析反馈名单
std::vector<FeedbackItem> parse_json(const std::string& content);

/// 从网页快照 HTML 中提取内嵌的结构化 JSON 数据
std::optional<std::vector<FeedbackItem>> parse_html_embedded_json(const std::string& html);

/// 解析 HTML 反馈快照，优先提取内嵌 JSON，其次匹配卡片 DOM 节点
std::vector<FeedbackItem> parse_html(const std::string& html);

/// 通用联系人下拉候选安全决策中枢 (与 Python/Rust 算法 1:1 对齐)
DecisionResult evaluate_contact_candidates(
    const std::vector<ContactCandidate>& contacts,
    const std::string& target_id,
    const std::string& target_name,
    const std::string& engine = "OCR"
);

} // namespace feedback
