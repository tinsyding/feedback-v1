#pragma once

#include "types.h"
#include <string>
#include <vector>
#include <map>
#include <optional>

namespace feedback {

struct StudentRecord {
    std::string student_id;
    std::string student_name;
    std::string clean_name;
    std::string status; // "待发送", "已发送 ✓", "发送失败 ✕", etc.
    std::string update_time;
    std::string error;
    std::string message;
};

struct ClassArchive {
    std::string class_name;
    std::string cycle;
    std::string file_name;
    std::string last_updated;
    std::vector<StudentRecord> students;
    std::map<std::string, int> stats; // total, sent, unsent, failed
};

class HistoryManager {
public:
    explicit HistoryManager(const std::string& storage_path = "");

    bool load();
    bool save();

    std::string build_archive_key(const std::string& class_name, const std::string& cycle) const;
    std::string resolve_archive_key(const std::string& file_path, const std::string& cycle = "") const;

    void sync_file_loaded(const std::string& file_path, const std::vector<FeedbackItem>& items, const std::string& cycle = "");
    void update_student_status(const std::string& archive_key, const std::string& student_id, const std::string& clean_name, const std::string& status, const std::string& error = "");
    std::optional<std::string> get_student_status(const std::string& archive_key, const std::string& student_id, const std::string& clean_name) const;

    std::vector<std::string> get_all_archive_keys() const;
    std::optional<ClassArchive> get_archive(const std::string& archive_key) const;

    bool export_csv(const std::string& archive_key, const std::string& output_csv_path) const;

    const std::string& get_storage_path() const { return storage_path_; }

    static std::string get_default_storage_path();

private:
    void recalc_stats(const std::string& key);

    std::string storage_path_;
    std::map<std::string, ClassArchive> archives_;
};

} // namespace feedback
