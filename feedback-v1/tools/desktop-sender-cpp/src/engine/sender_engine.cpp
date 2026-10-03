#include "sender_engine.h"
#include "../parser.h"
#include <random>
#include <chrono>

namespace feedback {

SenderEngine::SenderEngine(std::shared_ptr<IAutomationDriver> driver)
    : driver_(std::move(driver)) {}

SenderEngine::~SenderEngine() {
    stop();
}

void SenderEngine::set_items(std::vector<FeedbackItem> items) {
    items_ = std::move(items);
}

void SenderEngine::emit_log(const std::string& msg, const std::string& level) {
    if (log_cb_) {
        log_cb_(msg, level);
    }
}

void SenderEngine::start() {
    if (state_ == EngineState::Running) return;

    stop_requested_ = false;
    pause_requested_ = false;
    state_ = EngineState::Running;
    if (state_changed_cb_) state_changed_cb_(EngineState::Running);

    if (worker_thread_.joinable()) {
        worker_thread_.join();
    }

    worker_thread_ = std::thread(&SenderEngine::worker_loop, this);
}

void SenderEngine::pause() {
    if (state_ == EngineState::Running) {
        pause_requested_ = true;
        state_ = EngineState::Paused;
        if (state_changed_cb_) state_changed_cb_(EngineState::Paused);
        emit_log("发送任务已暂停", "WARN");
    }
}

void SenderEngine::resume() {
    if (state_ == EngineState::Paused) {
        pause_requested_ = false;
        state_ = EngineState::Running;
        if (state_changed_cb_) state_changed_cb_(EngineState::Running);
        cv_pause_.notify_all();
        emit_log("发送任务已恢复执行", "INFO");
    }
}

void SenderEngine::stop() {
    stop_requested_ = true;
    pause_requested_ = false;
    cv_pause_.notify_all();

    if (worker_thread_.joinable()) {
        worker_thread_.join();
    }

    state_ = EngineState::Stopped;
    if (state_changed_cb_) state_changed_cb_(EngineState::Stopped);
    emit_log("发送任务已停止", "INFO");
}

void SenderEngine::worker_loop() {
    emit_log("调度引擎工作线程启动，待处理名单总数: " + std::to_string(items_.size()), "INFO");

    if (!driver_->is_wecom_running()) {
        emit_log("未检测到企业微信客户端正在运行，请先登录企业微信", "ERROR");
        state_ = EngineState::Stopped;
        if (state_changed_cb_) state_changed_cb_(EngineState::Stopped);
        return;
    }

    driver_->activate_wecom();
    std::this_thread::sleep_for(std::chrono::milliseconds(500));

    std::random_device rd;
    std::mt19937 gen(rd());
    std::uniform_real_distribution<double> interval_dist(config_.min_interval_sec, config_.max_interval_sec);

    size_t consecutive_sent = 0;

    for (size_t i = 0; i < items_.size(); ++i) {
        if (stop_requested_) break;

        // 检查暂停
        if (pause_requested_) {
            std::unique_lock<std::mutex> lock(cv_mtx_);
            cv_pause_.wait(lock, [this]() { return !pause_requested_ || stop_requested_; });
            if (stop_requested_) break;
        }

        auto& item = items_[i];
        if (item.status == SendStatus::Success) {
            continue; // 跳过已发送记录
        }

        if (progress_cb_) {
            progress_cb_(i + 1, items_.size(), item);
        }

        // 失焦守护检查
        if (!driver_->is_wecom_foreground()) {
            emit_log("检测到企业微信失去前台焦点，触发失焦守护自动暂停！", "WARN");
            pause();
            std::unique_lock<std::mutex> lock(cv_mtx_);
            cv_pause_.wait(lock, [this]() { return !pause_requested_ || stop_requested_; });
            if (stop_requested_) break;
            driver_->activate_wecom();
        }

        bool ok = process_single_item(i, item);
        if (ok) {
            consecutive_sent++;
            if (config_.batch_size > 0 && consecutive_sent >= config_.batch_size) {
                emit_log("已连续发送 " + std::to_string(consecutive_sent) + " 人，触发防风控休眠 " + std::to_string(static_cast<int>(config_.batch_delay_sec)) + " 秒...", "INFO");
                consecutive_sent = 0;
                std::this_thread::sleep_for(std::chrono::milliseconds(static_cast<int>(config_.batch_delay_sec * 1000)));
            } else {
                double delay = interval_dist(gen);
                std::this_thread::sleep_for(std::chrono::milliseconds(static_cast<int>(delay * 1000)));
            }
        }
    }

    state_ = EngineState::Idle;
    if (state_changed_cb_) state_changed_cb_(EngineState::Idle);
    emit_log("批量发信流程执行完毕", "INFO");
}

bool SenderEngine::process_single_item(size_t index, FeedbackItem& item) {
    std::string search_key = item.student_id.empty() ? item.clean_name : item.student_id;
    emit_log("正在检索学生: " + item.student_name + " (查询词: " + search_key + ")", "INFO");

    auto rect_opt = driver_->get_wecom_rect();
    if (!rect_opt.has_value()) {
        emit_log("获取企微窗口物理坐标失败", "ERROR");
        item.status = SendStatus::Failed;
        if (item_finished_cb_) item_finished_cb_(index, SendStatus::Failed, "未获取到窗口坐标");
        return false;
    }

    // 1. 模拟搜索框输入
    driver_->send_text_via_search(search_key);
    std::this_thread::sleep_for(std::chrono::milliseconds(300));

    // 2. 第一道防线：下拉候选框智能纠偏
    auto candidates = driver_->capture_and_recognize_dropdown(*rect_opt);
    auto decision = evaluate_contact_candidates(candidates, item.student_id, item.clean_name, "LocalDriver");

    emit_log("候选决策结果: choice=" + std::to_string(decision.choice) + " (" + decision.reason + ")", "INFO");

    if (decision.choice == 0) {
        emit_log("⚠️ 未在通讯录中检索到联系人，安全跳过: " + item.student_name, "WARN");
        driver_->dismiss_search();
        item.status = SendStatus::Skipped;
        if (history_mgr_) {
            history_mgr_->update_student_status(archive_key_, item.student_id, item.clean_name, "未找到联系人", decision.reason);
        }
        if (item_finished_cb_) item_finished_cb_(index, SendStatus::Skipped, decision.reason);
        return false;
    }

    if (decision.choice == -2) {
        emit_log("⛔ 下拉结果全为他人描述或群聊，智能拦截防误发: " + item.student_name, "WARN");
        driver_->dismiss_search();
        item.status = SendStatus::Failed;
        if (history_mgr_) {
            history_mgr_->update_student_status(archive_key_, item.student_id, item.clean_name, "拦截(他人描述)", decision.reason);
        }
        if (item_finished_cb_) item_finished_cb_(index, SendStatus::Failed, decision.reason);
        return false;
    }

    // 进入对应条目
    driver_->select_candidate(decision.choice);
    std::this_thread::sleep_for(std::chrono::milliseconds(350));

    // 3. 第二道防线：聊天窗口 Header 标题安全核验
    if (config_.enable_header_check) {
        std::string header_text = driver_->capture_and_recognize_header(*rect_opt);
        if (!header_text.empty()) {
            bool title_ok = false;
            if (!item.student_id.empty() && header_text.find(item.student_id) != std::string::npos) {
                title_ok = true;
            } else if (!item.clean_name.empty() && header_text.find(item.clean_name) != std::string::npos) {
                title_ok = true;
            }

            if (!title_ok) {
                emit_log("⛔ 会话标题核验不符 (当前标题: " + header_text + ")，触发安全熔断！", "ERROR");
                driver_->dismiss_search();
                item.status = SendStatus::Failed;
                if (history_mgr_) {
                    history_mgr_->update_student_status(archive_key_, item.student_id, item.clean_name, "标题核验熔断", "Header不符: " + header_text);
                }
                if (item_finished_cb_) item_finished_cb_(index, SendStatus::Failed, "会话标题核验不符: " + header_text);
                return false;
            }
        }
    }

    // 4. 发送文案
    bool send_ok = driver_->send_message_text(item.message);
    if (send_ok) {
        emit_log("✓ 成功发送反馈: " + item.student_name, "INFO");
        item.status = SendStatus::Success;
        if (history_mgr_) {
            history_mgr_->update_student_status(archive_key_, item.student_id, item.clean_name, "已发送 ✓", "");
        }
        if (item_finished_cb_) item_finished_cb_(index, SendStatus::Success, "");
        return true;
    } else {
        emit_log("✕ 剪贴板或按键注入失败: " + item.student_name, "ERROR");
        item.status = SendStatus::Failed;
        if (history_mgr_) {
            history_mgr_->update_student_status(archive_key_, item.student_id, item.clean_name, "发送失败 ✕", "按键注入失败");
        }
        if (item_finished_cb_) item_finished_cb_(index, SendStatus::Failed, "按键注入失败");
        return false;
    }
}

} // namespace feedback
