#pragma once

#include "automation_driver.h"

namespace feedback {

class MockAutomationDriver : public IAutomationDriver {
public:
    MockAutomationDriver() = default;
    ~MockAutomationDriver() override = default;

    bool is_wecom_running() override { return true; }
    bool activate_wecom() override { return true; }
    bool is_wecom_foreground() override { return true; }
    std::optional<WindowRect> get_wecom_rect() override {
        return WindowRect{100, 100, 1000, 800};
    }

    bool set_clipboard_text(const std::string& text) override {
        mock_clipboard = text;
        return true;
    }
    std::string get_clipboard_text() override {
        return mock_clipboard;
    }

    void send_key(uint16_t /*vk*/) override {}
    void hotkey_ctrl(uint16_t /*vk*/) override {}
    void send_text_via_search(const std::string& /*text*/) override {}
    void dismiss_search() override {}
    void select_candidate(int /*choice*/) override {}
    bool send_message_text(const std::string& message) override {
        mock_clipboard = message;
        return true;
    }

    std::optional<RawImage> capture_rect(const WindowRect& rect) override {
        RawImage img;
        img.width = rect.width() > 0 ? rect.width() : 100;
        img.height = rect.height() > 0 ? rect.height() : 100;
        img.channels = 1;
        img.data.resize(img.width * img.height, 240);
        return img;
    }

    std::vector<ContactCandidate> capture_and_recognize_dropdown(const WindowRect& /*rect*/) override {
        return mock_candidates;
    }

    std::string capture_and_recognize_header(const WindowRect& /*rect*/) override {
        return mock_header_text;
    }

    void set_mock_candidates(std::vector<ContactCandidate> candidates) {
        mock_candidates = std::move(candidates);
    }

    void set_mock_header(const std::string& header) {
        mock_header_text = header;
    }

private:
    std::string mock_clipboard;
    std::vector<ContactCandidate> mock_candidates;
    std::string mock_header_text;
};

} // namespace feedback
