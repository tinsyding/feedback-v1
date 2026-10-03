#pragma once

#include "../types.h"
#include "../image_proc.h"
#include <string>
#include <vector>
#include <optional>
#include <memory>

namespace feedback {

class IAutomationDriver {
public:
    virtual ~IAutomationDriver() = default;

    virtual bool is_wecom_running() = 0;
    virtual bool activate_wecom() = 0;
    virtual bool is_wecom_foreground() = 0;
    virtual std::optional<WindowRect> get_wecom_rect() = 0;

    virtual bool set_clipboard_text(const std::string& text) = 0;
    virtual std::string get_clipboard_text() = 0;

    virtual void send_key(uint16_t vk) = 0;
    virtual void hotkey_ctrl(uint16_t vk) = 0;
    virtual void send_text_via_search(const std::string& text) = 0;
    virtual void dismiss_search() = 0;
    virtual void select_candidate(int choice) = 0;
    virtual bool send_message_text(const std::string& message) = 0;

    virtual std::optional<RawImage> capture_rect(const WindowRect& rect) = 0;
    virtual std::vector<ContactCandidate> capture_and_recognize_dropdown(const WindowRect& rect) = 0;
    virtual std::string capture_and_recognize_header(const WindowRect& rect) = 0;
};

std::unique_ptr<IAutomationDriver> create_automation_driver();

} // namespace feedback
