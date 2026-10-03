#include "parser.h"
#include <regex>
#include <algorithm>
#include <cctype>
#include <sstream>

namespace feedback {

static inline std::string trim(const std::string& s) {
    auto start = s.begin();
    while (start != s.end() && (std::isspace(static_cast<unsigned char>(*start)) || *start == '\r' || *start == '\n')) {
        start++;
    }
    auto end = s.end();
    do {
        end--;
    } while (std::distance(start, end) > 0 && (std::isspace(static_cast<unsigned char>(*end)) || *end == '\r' || *end == '\n'));
    return (start < end + 1) ? std::string(start, end + 1) : "";
}

std::pair<std::string, std::string> parse_student_identifier(const std::string& raw) {
    std::string s = trim(raw);
    if (s.empty()) {
        return {"", ""};
    }

    size_t i = 0;
    while (i < s.size() && std::isdigit(static_cast<unsigned char>(s[i]))) {
        i++;
    }

    if (i > 0) {
        std::string id = s.substr(0, i);
        // Skip separators: spaces, -, _, ., 、, etc.
        while (i < s.size()) {
            char c = s[i];
            if (std::isspace(static_cast<unsigned char>(c)) || c == '-' || c == '_' || c == '.' || c == ':') {
                i++;
            } else if (i + 2 < s.size() && 
                       static_cast<unsigned char>(s[i]) == 0xE3 && 
                       static_cast<unsigned char>(s[i+1]) == 0x80 && 
                       static_cast<unsigned char>(s[i+2]) == 0x81) {
                // Chinese pause mark "、" (UTF-8 E3 80 81)
                i += 3;
            } else {
                break;
            }
        }
        std::string name = trim(s.substr(i));
        return {id, name};
    }

    return {"", s};
}

std::string detect_cycle_from_string(const std::string& text) {
    if (text.empty()) return "";

    static const std::string DI = "\xE7\xAC\xAC"; // "第"
    static const std::vector<std::string> units = {
        "\xE5\x91\xA8", // 周
        "\xE8\xAE\xB2", // 讲
        "\xE6\x9C\x9F", // 期
        "\xE8\xAF\xBE", // 课
        "\xE6\xAC\xA1", // 次
        "\xE5\xA4\xA9", // 天
        "\xE6\xAD\xA5"  // 步
    };

    static const std::vector<std::pair<std::string, int>> cn_digits = {
        {"\xE4\xB8\x80", 1},  // 一
        {"\xE4\xBA\x8C", 2},  // 二
        {"\xE4\xB8\x89", 3},  // 三
        {"\xE5\x9B\x9B", 4},  // 四
        {"\xE4\xBA\x94", 5},  // 五
        {"\xE5\x85\xAD", 6},  // 六
        {"\xE4\xB8\x83", 7},  // 七
        {"\xE5\x85\xAB", 8},  // 八
        {"\xE4\xB9\x9D", 9},  // 九
        {"\xE5\x8D\x81", 10}  // 十
    };

    size_t pos = 0;
    while ((pos = text.find(DI, pos)) != std::string::npos) {
        size_t cur = pos + DI.size();
        while (cur < text.size() && std::isspace(static_cast<unsigned char>(text[cur]))) cur++;

        // 尝试阿拉伯数字
        if (cur < text.size() && std::isdigit(static_cast<unsigned char>(text[cur]))) {
            size_t num_start = cur;
            while (cur < text.size() && std::isdigit(static_cast<unsigned char>(text[cur]))) cur++;
            int val = std::stoi(text.substr(num_start, cur - num_start));
            while (cur < text.size() && std::isspace(static_cast<unsigned char>(text[cur]))) cur++;
            for (const auto& u : units) {
                if (text.compare(cur, u.size(), u) == 0) {
                    return "第 " + std::to_string(val) + " " + u;
                }
            }
        }

        // 尝试中文数字 (一到九十九)
        int cn_val = 0;
        size_t cn_cur = cur;
        for (const auto& d1 : cn_digits) {
            if (text.compare(cn_cur, d1.first.size(), d1.first) == 0) {
                cn_val = d1.second;
                cn_cur += d1.first.size();
                if (cn_val == 10 && cn_cur < text.size()) {
                    for (const auto& d2 : cn_digits) {
                        if (d2.second < 10 && text.compare(cn_cur, d2.first.size(), d2.first) == 0) {
                            cn_val = 10 + d2.second;
                            cn_cur += d2.first.size();
                            break;
                        }
                    }
                } else if (cn_cur < text.size() && text.compare(cn_cur, 3, "\xE5\x8D\x81") == 0) { // 十
                    cn_cur += 3;
                    cn_val *= 10;
                    for (const auto& d2 : cn_digits) {
                        if (d2.second < 10 && text.compare(cn_cur, d2.first.size(), d2.first) == 0) {
                            cn_val += d2.second;
                            cn_cur += d2.first.size();
                            break;
                        }
                    }
                }
                break;
            }
        }
        if (cn_val > 0) {
            while (cn_cur < text.size() && std::isspace(static_cast<unsigned char>(text[cn_cur]))) cn_cur++;
            for (const auto& u : units) {
                if (text.compare(cn_cur, u.size(), u) == 0) {
                    return "第 " + std::to_string(cn_val) + " " + u;
                }
            }
        }

        pos += DI.size();
    }

    // 检查 Week X / W01
    for (size_t i = 0; i < text.size(); ++i) {
        if ((text[i] == 'W' || text[i] == 'w') && i + 1 < text.size()) {
            if (i + 4 <= text.size() && (text.substr(i, 4) == "Week" || text.substr(i, 4) == "week")) {
                size_t w_cur = i + 4;
                while (w_cur < text.size() && std::isspace(static_cast<unsigned char>(text[w_cur]))) w_cur++;
                if (w_cur < text.size() && std::isdigit(static_cast<unsigned char>(text[w_cur]))) {
                    size_t num_start = w_cur;
                    while (w_cur < text.size() && std::isdigit(static_cast<unsigned char>(text[w_cur]))) w_cur++;
                    return "第 " + std::to_string(std::stoi(text.substr(num_start, w_cur - num_start))) + " 周";
                }
            } else if (std::isdigit(static_cast<unsigned char>(text[i+1]))) {
                // W01 / W1
                size_t w_cur = i + 1;
                size_t num_start = w_cur;
                while (w_cur < text.size() && std::isdigit(static_cast<unsigned char>(text[w_cur]))) w_cur++;
                return "第 " + std::to_string(std::stoi(text.substr(num_start, w_cur - num_start))) + " 周";
            }
        }
    }

    return "";
}

std::vector<FeedbackItem> parse_json(const std::string& content) {
    std::vector<FeedbackItem> items;
    try {
        auto parsed = nlohmann::json::parse(content);
        if (parsed.is_array()) {
            size_t idx = 0;
            for (const auto& elem : parsed) {
                FeedbackItem item = elem.get<FeedbackItem>();
                auto [id, clean_name] = parse_student_identifier(item.student_name);
                item.student_id = id;
                item.clean_name = clean_name.empty() ? item.student_name : clean_name;
                if (item.cycle.empty()) {
                    item.cycle = detect_cycle_from_string(item.message);
                }
                if (!item.original_index.has_value()) {
                    item.original_index = idx;
                }
                items.push_back(std::move(item));
                idx++;
            }
        }
    } catch (...) {}
    return items;
}

std::optional<std::vector<FeedbackItem>> parse_html_embedded_json(const std::string& html) {
    try {
        std::regex script_re(R"(<script[^>]+id=["']feedback-data["'][^>]*>([\s\S]*?)</script>)");
        std::smatch m;
        if (std::regex_search(html, m, script_re)) {
            std::string json_str = trim(m[1].str());
            auto items = parse_json(json_str);
            if (!items.empty()) {
                return items;
            }
        }
    } catch (...) {}
    return std::nullopt;
}

std::vector<FeedbackItem> parse_html(const std::string& html) {
    auto embedded = parse_html_embedded_json(html);
    if (embedded.has_value() && !embedded->empty()) {
        return *embedded;
    }

    std::vector<FeedbackItem> items;
    try {
        std::regex card_re(R"(<div[^>]*class=["'][^"']*(?:feedback-card|student-card)[^"']*["'][^>]*>([\s\S]*?)</div>)");
        std::regex name_re(R"(<(?:h\d|div|span)[^>]*class=["'][^"']*student-name[^"']*["'][^>]*>([\s\S]*?)</(?:h\d|div|span)>)");
        std::regex msg_re(R"(<(?:pre|div|p)[^>]*class=["'][^"']*(?:message-body|feedback-text)[^"']*["'][^>]*>([\s\S]*?)</(?:pre|div|p)>)");

        auto cards_begin = std::sregex_iterator(html.begin(), html.end(), card_re);
        auto cards_end = std::sregex_iterator();

        size_t idx = 0;
        for (auto it = cards_begin; it != cards_end; ++it) {
            std::string card_html = (*it)[1].str();
            std::smatch m_name, m_msg;
            if (std::regex_search(card_html, m_name, name_re) && std::regex_search(card_html, m_msg, msg_re)) {
                std::string name = trim(m_name[1].str());
                std::string msg = trim(m_msg[1].str());
                if (!name.empty() && !msg.empty()) {
                    auto [id, clean_name] = parse_student_identifier(name);
                    FeedbackItem item;
                    item.student_name = name;
                    item.message = msg;
                    item.student_id = id;
                    item.clean_name = clean_name.empty() ? name : clean_name;
                    item.cycle = detect_cycle_from_string(msg);
                    item.status = SendStatus::Pending;
                    item.original_index = idx++;
                    items.push_back(std::move(item));
                }
            }
        }
    } catch (...) {}

    return items;
}

DecisionResult evaluate_contact_candidates(
    const std::vector<ContactCandidate>& contacts,
    const std::string& target_id,
    const std::string& target_name,
    const std::string& engine
) {
    if (contacts.empty()) {
        return {
            0,
            "未找到该联系人 [" + engine + "]",
            engine
        };
    }

    auto match_contact = [&](const ContactCandidate& c) -> bool {
        std::string title = trim(c.title);
        if (title.empty() || c.is_group) {
            return false;
        }

        // 排除全局搜索、网络查找等按钮项
        static const std::vector<std::string> blacklist = {"全局", "查找", "搜索", "网络"};
        for (const auto& word : blacklist) {
            if (title.find(word) != std::string::npos) {
                return false;
            }
        }

        // 核心安全准则：必须完全同时匹配学号与姓名！
        if (!target_id.empty() && !target_name.empty()) {
            return (title.find(target_id) != std::string::npos && title.find(target_name) != std::string::npos);
        } else if (!target_id.empty()) {
            return (title.find(target_id) != std::string::npos);
        } else if (!target_name.empty()) {
            return (title.find(target_name) != std::string::npos);
        }
        return false;
    };

    int target_pos = 0;
    for (size_t i = 0; i < contacts.size(); ++i) {
        if (match_contact(contacts[i])) {
            target_pos = static_cast<int>(i + 1);
            break;
        }
    }

    bool has_any_desc = false;
    for (const auto& c : contacts) {
        if (c.has_desc) {
            has_any_desc = true;
            break;
        }
    }

    if (target_pos == 1) {
        return {
            1,
            "第1项即为目标本人 (" + contacts[0].title + ") [" + engine + "]",
            engine
        };
    } else if (target_pos > 1) {
        return {
            target_pos,
            "第1项为他人描述，第" + std::to_string(target_pos) + "项为目标本人 (" + contacts[target_pos - 1].title + ") [" + engine + "]",
            engine
        };
    } else if (has_any_desc) {
        return {
            -2,
            "全部为他人描述，无本人备注 [" + engine + "]",
            engine
        };
    } else {
        return {
            0,
            "未找到该联系人 [" + engine + "]",
            engine
        };
    }
}

} // namespace feedback
