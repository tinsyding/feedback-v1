#pragma once

#include "automation_driver.h"

#ifdef _WIN32
#include <windows.h>
#endif

namespace feedback {

#ifdef _WIN32
class Win32AutomationDriver : public IAutomationDriver {
public:
    Win32AutomationDriver();
    ~Win32AutomationDriver() override;

    bool is_wecom_running() override;
    bool activate_wecom() override;
    bool is_wecom_foreground() override;
    std::optional<WindowRect> get_wecom_rect() override;

    bool set_clipboard_text(const std::string& text) override;
    std::string get_clipboard_text() override;

    void send_key(uint16_t vk) override;
    void hotkey_ctrl(uint16_t vk) override;
    void send_text_via_search(const std::string& text) override;
    void dismiss_search() override;
    void select_candidate(int choice) override;
    bool send_message_text(const std::string& message) override;

    std::optional<RawImage> capture_rect(const WindowRect& rect) override;
    std::vector<ContactCandidate> capture_and_recognize_dropdown(const WindowRect& rect) override;
    std::string capture_and_recognize_header(const WindowRect& rect) override;

private:
    HWND find_wecom_hwnd();
};
#endif

} // namespace feedback
