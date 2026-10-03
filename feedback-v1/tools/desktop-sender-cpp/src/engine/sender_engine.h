#pragma once

#include "../types.h"
#include "../automation/automation_driver.h"
#include "../history_manager.h"
#include <vector>
#include <string>
#include <functional>
#include <atomic>
#include <memory>
#include <thread>
#include <mutex>
#include <condition_variable>

namespace feedback {

enum class EngineState {
    Idle,
    Running,
    Paused,
    Stopped
};

struct EngineConfig {
    double min_interval_sec = 2.0;
    double max_interval_sec = 5.0;
    size_t batch_size = 10;
    double batch_delay_sec = 8.0;
    bool enable_header_check = true;
};

class SenderEngine {
public:
    using LogCallback = std::function<void(const std::string& msg, const std::string& level)>;
    using ProgressCallback = std::function<void(size_t current, size_t total, const FeedbackItem& item)>;
    using ItemFinishedCallback = std::function<void(size_t index, SendStatus status, const std::string& reason)>;
    using StateChangedCallback = std::function<void(EngineState state)>;

    explicit SenderEngine(std::shared_ptr<IAutomationDriver> driver);
    ~SenderEngine();

    void set_items(std::vector<FeedbackItem> items);
    void set_archive_key(const std::string& key) { archive_key_ = key; }
    void set_history_manager(std::shared_ptr<HistoryManager> mgr) { history_mgr_ = mgr; }
    void set_config(const EngineConfig& cfg) { config_ = cfg; }

    void set_log_callback(LogCallback cb) { log_cb_ = std::move(cb); }
    void set_progress_callback(ProgressCallback cb) { progress_cb_ = std::move(cb); }
    void set_item_finished_callback(ItemFinishedCallback cb) { item_finished_cb_ = std::move(cb); }
    void set_state_changed_callback(StateChangedCallback cb) { state_changed_cb_ = std::move(cb); }

    void start();
    void pause();
    void resume();
    void stop();

    EngineState get_state() const { return state_.load(); }
    const std::vector<FeedbackItem>& get_items() const { return items_; }

private:
    void worker_loop();
    bool process_single_item(size_t index, FeedbackItem& item);
    void emit_log(const std::string& msg, const std::string& level = "INFO");

    std::shared_ptr<IAutomationDriver> driver_;
    std::shared_ptr<HistoryManager> history_mgr_;
    std::string archive_key_;
    EngineConfig config_;

    std::vector<FeedbackItem> items_;
    std::atomic<EngineState> state_{EngineState::Idle};
    std::atomic<bool> stop_requested_{false};
    std::atomic<bool> pause_requested_{false};

    std::thread worker_thread_;
    std::mutex cv_mtx_;
    std::condition_variable cv_pause_;

    LogCallback log_cb_;
    ProgressCallback progress_cb_;
    ItemFinishedCallback item_finished_cb_;
    StateChangedCallback state_changed_cb_;
};

} // namespace feedback
