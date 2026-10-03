#pragma once

#include <string>
#include <vector>
#include <optional>
#include "../include/nlohmann/json.hpp"

namespace feedback {

enum class SendStatus {
    Pending,
    Sending,
    Success,
    Failed,
    Skipped
};

inline std::string to_string(SendStatus status) {
    switch (status) {
        case SendStatus::Pending: return "Pending";
        case SendStatus::Sending: return "Sending";
        case SendStatus::Success: return "Success";
        case SendStatus::Failed:  return "Failed";
        case SendStatus::Skipped: return "Skipped";
    }
    return "Pending";
}

inline SendStatus send_status_from_string(const std::string& str) {
    if (str == "Sending") return SendStatus::Sending;
    if (str == "Success") return SendStatus::Success;
    if (str == "Failed")  return SendStatus::Failed;
    if (str == "Skipped") return SendStatus::Skipped;
    return SendStatus::Pending;
}

struct FeedbackItem {
    std::string student_name;
    std::string message;
    std::string student_id;
    std::string clean_name;
    std::string cycle;
    SendStatus status = SendStatus::Pending;
    std::optional<size_t> original_index;
};

inline void to_json(nlohmann::json& j, const FeedbackItem& item) {
    j = nlohmann::json{
        {"studentName", item.student_name},
        {"message", item.message},
        {"student_id", item.student_id},
        {"clean_name", item.clean_name},
        {"cycle", item.cycle},
        {"status", to_string(item.status)}
    };
    if (item.original_index.has_value()) {
        j["original_index"] = item.original_index.value();
    }
}

inline void from_json(const nlohmann::json& j, FeedbackItem& item) {
    if (j.contains("studentName")) {
        item.student_name = j["studentName"].get<std::string>();
    } else if (j.contains("student_name")) {
        item.student_name = j["student_name"].get<std::string>();
    } else {
        item.student_name.clear();
    }

    if (j.contains("message") && j["message"].is_string()) {
        item.message = j["message"].get<std::string>();
    } else {
        item.message.clear();
    }

    if (j.contains("student_id") && j["student_id"].is_string()) {
        item.student_id = j["student_id"].get<std::string>();
    } else if (j.contains("studentId") && j["studentId"].is_string()) {
        item.student_id = j["studentId"].get<std::string>();
    } else {
        item.student_id.clear();
    }

    if (j.contains("clean_name") && j["clean_name"].is_string()) {
        item.clean_name = j["clean_name"].get<std::string>();
    } else if (j.contains("cleanName") && j["cleanName"].is_string()) {
        item.clean_name = j["cleanName"].get<std::string>();
    } else {
        item.clean_name.clear();
    }

    if (j.contains("cycle") && j["cycle"].is_string()) {
        item.cycle = j["cycle"].get<std::string>();
    } else {
        item.cycle.clear();
    }

    if (j.contains("status") && j["status"].is_string()) {
        item.status = send_status_from_string(j["status"].get<std::string>());
    } else {
        item.status = SendStatus::Pending;
    }

    if (j.contains("original_index") && j["original_index"].is_number()) {
        item.original_index = j["original_index"].get<size_t>();
    } else if (j.contains("originalIndex") && j["originalIndex"].is_number()) {
        item.original_index = j["originalIndex"].get<size_t>();
    } else if (j.contains("index") && j["index"].is_number()) {
        item.original_index = j["index"].get<size_t>();
    } else {
        item.original_index = std::nullopt;
    }
}

/// 企微搜索候选人条目
struct ContactCandidate {
    size_t index = 0;
    std::string title;
    std::vector<std::string> subtitles;
    bool has_desc = false;
    bool is_group = false;
};

inline void to_json(nlohmann::json& j, const ContactCandidate& c) {
    j = nlohmann::json{
        {"index", c.index},
        {"title", c.title},
        {"subtitles", c.subtitles},
        {"has_desc", c.has_desc},
        {"is_group", c.is_group}
    };
}

inline void from_json(const nlohmann::json& j, ContactCandidate& c) {
    if (j.contains("index")) c.index = j["index"].get<size_t>();
    if (j.contains("title")) c.title = j["title"].get<std::string>();
    if (j.contains("subtitles") && j["subtitles"].is_array()) {
        c.subtitles = j["subtitles"].get<std::vector<std::string>>();
    }
    if (j.contains("has_desc")) c.has_desc = j["has_desc"].get<bool>();
    if (j.contains("is_group")) c.is_group = j["is_group"].get<bool>();
}

/// 智能联系人安全决策结果
struct DecisionResult {
    /// 1: 首项为目标本人直接回车; >=2: 首项为他人描述，向下按键至对应项; 0: 未匹配安全放行; -2: 全部为他人描述拦截
    int choice = 0;
    std::string reason;
    std::string engine;
};

struct WindowRect {
    int left = 0;
    int top = 0;
    int right = 0;
    int bottom = 0;

    int width() const { return right - left; }
    int height() const { return bottom - top; }
};

/// 云端视觉 API 请求 Payload
struct CloudVisionPayload {
    std::string client;
    std::string task;
    std::string target_id;
    std::string target_name;
    std::string image;
};

inline void to_json(nlohmann::json& j, const CloudVisionPayload& p) {
    j = nlohmann::json{
        {"client", p.client},
        {"task", p.task},
        {"target_id", p.target_id},
        {"target_name", p.target_name},
        {"image", p.image}
    };
}

/// 云端视觉 API 响应
struct CloudVisionResponse {
    bool success = false;
    std::optional<int> choice;
    std::optional<bool> matched;
    std::optional<std::string> reason;
    std::optional<std::string> error;
};

inline void from_json(const nlohmann::json& j, CloudVisionResponse& r) {
    if (j.contains("success")) r.success = j["success"].get<bool>();
    if (j.contains("choice") && j["choice"].is_number()) r.choice = j["choice"].get<int>();
    if (j.contains("matched") && j["matched"].is_boolean()) r.matched = j["matched"].get<bool>();
    if (j.contains("reason") && j["reason"].is_string()) r.reason = j["reason"].get<std::string>();
    if (j.contains("error") && j["error"].is_string()) r.error = j["error"].get<std::string>();
}

} // namespace feedback
