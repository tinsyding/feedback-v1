#include "history_manager.h"
#include "parser.h"
#include <fstream>
#include <filesystem>
#include <chrono>
#include <iomanip>
#include <sstream>
#include <cstdlib>

namespace feedback {

static std::string current_time_string() {
    auto now = std::chrono::system_clock::now();
    auto in_time_t = std::chrono::system_clock::to_time_t(now);
    std::stringstream ss;
    ss << std::put_time(std::localtime(&in_time_t), "%Y-%m-%d %H:%M:%S");
    return ss.str();
}

std::string HistoryManager::get_default_storage_path() {
#ifdef _WIN32
    const char* user_profile = std::getenv("USERPROFILE");
    if (user_profile) {
        return (std::filesystem::path(user_profile) / "Documents" / "JFFeedback" / "feedback_history.json").string();
    }
#else
    const char* home = std::getenv("HOME");
    if (home) {
        return (std::filesystem::path(home) / ".local" / "share" / "JFFeedback" / "feedback_history.json").string();
    }
#endif
    return "./feedback_history.json";
}

HistoryManager::HistoryManager(const std::string& storage_path) {
    if (storage_path.empty()) {
        storage_path_ = get_default_storage_path();
    } else {
        storage_path_ = storage_path;
    }
    load();
}

bool HistoryManager::load() {
    archives_.clear();
    if (!std::filesystem::exists(storage_path_)) {
        return false;
    }

    try {
        std::ifstream ifs(storage_path_);
        if (!ifs.is_open()) return false;

        nlohmann::json root;
        ifs >> root;
        if (!root.contains("classes") || !root["classes"].is_object()) {
            return false;
        }

        for (auto& [key, entry] : root["classes"].items()) {
            if (!entry.is_object()) continue;
            ClassArchive archive;
            archive.class_name = entry.value("class_name", "");
            archive.cycle = entry.value("cycle", "第 1 周");
            archive.file_name = entry.value("file_name", "");
            archive.last_updated = entry.value("last_updated", "");

            if (entry.contains("students") && entry["students"].is_array()) {
                for (auto& s : entry["students"]) {
                    StudentRecord rec;
                    rec.student_id = s.value("student_id", "");
                    rec.student_name = s.value("student_name", "");
                    rec.clean_name = s.value("clean_name", "");
                    rec.status = s.value("status", "待发送");
                    rec.update_time = s.value("update_time", "");
                    rec.error = s.value("error", "");
                    rec.message = s.value("message", "");
                    archive.students.push_back(std::move(rec));
                }
            }
            archives_[key] = std::move(archive);
            recalc_stats(key);
        }
        return true;
    } catch (...) {
        return false;
    }
}

bool HistoryManager::save() {
    try {
        std::filesystem::path p(storage_path_);
        if (p.has_parent_path()) {
            std::filesystem::create_directories(p.parent_path());
        }

        nlohmann::json root;
        root["classes"] = nlohmann::json::object();

        for (const auto& [key, archive] : archives_) {
            nlohmann::json entry;
            entry["class_name"] = archive.class_name;
            entry["cycle"] = archive.cycle;
            entry["file_name"] = archive.file_name;
            entry["last_updated"] = archive.last_updated;

            nlohmann::json students_arr = nlohmann::json::array();
            for (const auto& s : archive.students) {
                nlohmann::json item;
                item["student_id"] = s.student_id;
                item["student_name"] = s.student_name;
                item["clean_name"] = s.clean_name;
                item["status"] = s.status;
                item["update_time"] = s.update_time;
                item["error"] = s.error;
                item["message"] = s.message;
                students_arr.push_back(item);
            }
            entry["students"] = students_arr;
            entry["stats"] = archive.stats;

            root["classes"][key] = entry;
        }

        std::ofstream ofs(storage_path_);
        if (!ofs.is_open()) return false;
        ofs << root.dump(2);
        return true;
    } catch (...) {
        return false;
    }
}

std::string HistoryManager::build_archive_key(const std::string& class_name, const std::string& cycle) const {
    std::string c_name = class_name.empty() ? "未命名班级" : class_name;
    std::string cyc = cycle.empty() ? "第 1 周" : cycle;
    return c_name + " [" + cyc + "]";
}

std::string HistoryManager::resolve_archive_key(const std::string& file_path, const std::string& cycle) const {
    if (file_path.empty()) return "";

    std::filesystem::path p(file_path);
    std::string f_name = p.filename().string();
    std::string cyc = cycle.empty() ? detect_cycle_from_string(f_name) : cycle;
    if (cyc.empty()) cyc = "第 1 周";

    std::string stem = p.stem().string();
    std::string target_key = build_archive_key(stem, cyc);
    if (archives_.find(target_key) != archives_.end()) {
        return target_key;
    }
    return target_key;
}

void HistoryManager::sync_file_loaded(const std::string& file_path, const std::vector<FeedbackItem>& items, const std::string& cycle) {
    if (file_path.empty() || items.empty()) return;

    std::filesystem::path p(file_path);
    std::string f_name = p.filename().string();
    std::string c_name = p.stem().string();
    std::string cyc = cycle.empty() ? detect_cycle_from_string(f_name) : cycle;
    if (cyc.empty()) cyc = "第 1 周";

    std::string key = build_archive_key(c_name, cyc);
    std::string now_str = current_time_string();

    auto it = archives_.find(key);
    if (it == archives_.end()) {
        ClassArchive archive;
        archive.class_name = c_name;
        archive.cycle = cyc;
        archive.file_name = f_name;
        archive.last_updated = now_str;

        for (const auto& item : items) {
            StudentRecord rec;
            rec.student_id = item.student_id;
            rec.student_name = item.student_name;
            rec.clean_name = item.clean_name;
            rec.status = "待发送";
            rec.update_time = now_str;
            rec.message = item.message;
            archive.students.push_back(std::move(rec));
        }
        archives_[key] = std::move(archive);
    } else {
        it->second.last_updated = now_str;
        // 合并更新文案
        for (const auto& item : items) {
            bool found = false;
            for (auto& s : it->second.students) {
                if ((!item.student_id.empty() && s.student_id == item.student_id) ||
                    (!item.clean_name.empty() && s.clean_name == item.clean_name)) {
                    s.message = item.message;
                    found = true;
                    break;
                }
            }
            if (!found) {
                StudentRecord rec;
                rec.student_id = item.student_id;
                rec.student_name = item.student_name;
                rec.clean_name = item.clean_name;
                rec.status = "待发送";
                rec.update_time = now_str;
                rec.message = item.message;
                it->second.students.push_back(std::move(rec));
            }
        }
    }
    recalc_stats(key);
    save();
}

void HistoryManager::update_student_status(
    const std::string& archive_key,
    const std::string& student_id,
    const std::string& clean_name,
    const std::string& status,
    const std::string& error
) {
    auto it = archives_.find(archive_key);
    if (it == archives_.end()) return;

    std::string now_str = current_time_string();
    for (auto& s : it->second.students) {
        if ((!student_id.empty() && s.student_id == student_id) ||
            (!clean_name.empty() && s.clean_name == clean_name)) {
            s.status = status;
            s.error = error;
            s.update_time = now_str;
            break;
        }
    }
    it->second.last_updated = now_str;
    recalc_stats(archive_key);
    save();
}

std::optional<std::string> HistoryManager::get_student_status(
    const std::string& archive_key,
    const std::string& student_id,
    const std::string& clean_name
) const {
    auto it = archives_.find(archive_key);
    if (it == archives_.end()) return std::nullopt;

    for (const auto& s : it->second.students) {
        if ((!student_id.empty() && s.student_id == student_id) ||
            (!clean_name.empty() && s.clean_name == clean_name)) {
            return s.status;
        }
    }
    return std::nullopt;
}

void HistoryManager::recalc_stats(const std::string& key) {
    auto it = archives_.find(key);
    if (it == archives_.end()) return;

    int total = static_cast<int>(it->second.students.size());
    int sent = 0;
    int unsent = 0;
    int failed = 0;

    for (const auto& s : it->second.students) {
        if (s.status.find("已发送") != std::string::npos || s.status.find("✓") != std::string::npos) {
            sent++;
        } else if (s.status.find("未发送") != std::string::npos || s.status.find("待发送") != std::string::npos) {
            unsent++;
        } else {
            failed++;
        }
    }

    it->second.stats["total"] = total;
    it->second.stats["sent"] = sent;
    it->second.stats["unsent"] = unsent;
    it->second.stats["failed"] = failed;
}

std::vector<std::string> HistoryManager::get_all_archive_keys() const {
    std::vector<std::string> keys;
    for (const auto& [k, _] : archives_) {
        keys.push_back(k);
    }
    return keys;
}

std::optional<ClassArchive> HistoryManager::get_archive(const std::string& archive_key) const {
    auto it = archives_.find(archive_key);
    if (it != archives_.end()) {
        return it->second;
    }
    return std::nullopt;
}

bool HistoryManager::export_csv(const std::string& archive_key, const std::string& output_csv_path) const {
    auto archive_opt = get_archive(archive_key);
    if (!archive_opt.has_value()) return false;

    try {
        std::ofstream ofs(output_csv_path);
        if (!ofs.is_open()) return false;

        // UTF-8 BOM for Excel
        ofs << "\xEF\xBB\xBF";
        ofs << "序号,学号,姓名,周次,发送状态,更新时间,异常信息\n";

        const auto& archive = *archive_opt;
        for (size_t i = 0; i < archive.students.size(); ++i) {
            const auto& s = archive.students[i];
            ofs << (i + 1) << ","
                << "\"" << s.student_id << "\","
                << "\"" << s.clean_name << "\","
                << "\"" << archive.cycle << "\","
                << "\"" << s.status << "\","
                << "\"" << s.update_time << "\","
                << "\"" << s.error << "\"\n";
        }
        return true;
    } catch (...) {
        return false;
    }
}

} // namespace feedback
