#include "win32_driver.h"
#include "mock_driver.h"
#include <chrono>
#include <thread>
#include <iostream>

namespace feedback {

#ifdef _WIN32

Win32AutomationDriver::Win32AutomationDriver() = default;
Win32AutomationDriver::~Win32AutomationDriver() = default;

HWND Win32AutomationDriver::find_wecom_hwnd() {
    HWND found = nullptr;
    EnumWindows([](HWND hwnd, LPARAM lparam) -> BOOL {
        if (!IsWindow(hwnd) || !IsWindowVisible(hwnd)) return TRUE;

        wchar_t className[256] = {0};
        wchar_t title[256] = {0};
        GetClassNameW(hwnd, className, 255);
        GetWindowTextW(hwnd, title, 255);

        std::wstring cls = className;
        std::wstring ttl = title;

        if (cls == L"WeWorkWindow" || cls == L"WXWork") {
            *reinterpret_cast<HWND*>(lparam) = hwnd;
            return FALSE;
        }
        if (ttl.find(L"企业微信") != std::wstring::npos && cls.find(L"Chrome") == std::wstring::npos) {
            *reinterpret_cast<HWND*>(lparam) = hwnd;
            return FALSE;
        }
        return TRUE;
    }, reinterpret_cast<LPARAM>(&found));

    return found;
}

bool Win32AutomationDriver::is_wecom_running() {
    return find_wecom_hwnd() != nullptr;
}

bool Win32AutomationDriver::activate_wecom() {
    HWND hwnd = find_wecom_hwnd();
    if (!hwnd) return false;

    if (IsIconic(hwnd)) {
        ShowWindow(hwnd, SW_RESTORE);
    } else {
        ShowWindow(hwnd, SW_SHOW);
    }

    SetForegroundWindow(hwnd);
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
    return is_wecom_foreground();
}

bool Win32AutomationDriver::is_wecom_foreground() {
    HWND foreground = GetForegroundWindow();
    if (!foreground) return false;

    wchar_t className[256] = {0};
    GetClassNameW(foreground, className, 255);
    std::wstring cls = className;
    return (cls == L"WeWorkWindow" || cls == L"WXWork");
}

std::optional<WindowRect> Win32AutomationDriver::get_wecom_rect() {
    HWND hwnd = find_wecom_hwnd();
    if (!hwnd) return std::nullopt;

    RECT rc;
    if (GetWindowRect(hwnd, &rc)) {
        return WindowRect{rc.left, rc.top, rc.right, rc.bottom};
    }
    return std::nullopt;
}

bool Win32AutomationDriver::set_clipboard_text(const std::string& text) {
    if (!OpenClipboard(nullptr)) return false;
    EmptyClipboard();

    int wide_len = MultiByteToWideChar(CP_UTF8, 0, text.c_str(), -1, nullptr, 0);
    if (wide_len <= 0) {
        CloseClipboard();
        return false;
    }

    HGLOBAL hGlobal = GlobalAlloc(GMEM_MOVEABLE, wide_len * sizeof(wchar_t));
    if (!hGlobal) {
        CloseClipboard();
        return false;
    }

    wchar_t* pBuf = static_cast<wchar_t*>(GlobalLock(hGlobal));
    MultiByteToWideChar(CP_UTF8, 0, text.c_str(), -1, pBuf, wide_len);
    GlobalUnlock(hGlobal);

    SetClipboardData(CF_UNICODETEXT, hGlobal);
    CloseClipboard();
    return true;
}

std::string Win32AutomationDriver::get_clipboard_text() {
    if (!OpenClipboard(nullptr)) return "";
    HANDLE hData = GetClipboardData(CF_UNICODETEXT);
    if (!hData) {
        CloseClipboard();
        return "";
    }

    wchar_t* pBuf = static_cast<wchar_t*>(GlobalLock(hData));
    if (!pBuf) {
        CloseClipboard();
        return "";
    }

    int utf8_len = WideCharToMultiByte(CP_UTF8, 0, pBuf, -1, nullptr, 0, nullptr, nullptr);
    std::string result(utf8_len > 0 ? utf8_len - 1 : 0, '\0');
    if (utf8_len > 0) {
        WideCharToMultiByte(CP_UTF8, 0, pBuf, -1, result.data(), utf8_len, nullptr, nullptr);
    }

    GlobalUnlock(hData);
    CloseClipboard();
    return result;
}

void Win32AutomationDriver::send_key(uint16_t vk) {
    INPUT inputs[2] = {};
    inputs[0].type = INPUT_KEYBOARD;
    inputs[0].ki.wVk = vk;

    inputs[1].type = INPUT_KEYBOARD;
    inputs[1].ki.wVk = vk;
    inputs[1].ki.dwFlags = KEYEVENTF_KEYUP;

    SendInput(2, inputs, sizeof(INPUT));
}

void Win32AutomationDriver::hotkey_ctrl(uint16_t vk) {
    INPUT inputs[4] = {};
    inputs[0].type = INPUT_KEYBOARD;
    inputs[0].ki.wVk = VK_CONTROL;

    inputs[1].type = INPUT_KEYBOARD;
    inputs[1].ki.wVk = vk;

    inputs[2].type = INPUT_KEYBOARD;
    inputs[2].ki.wVk = vk;
    inputs[2].ki.dwFlags = KEYEVENTF_KEYUP;

    inputs[3].type = INPUT_KEYBOARD;
    inputs[3].ki.wVk = VK_CONTROL;
    inputs[3].ki.dwFlags = KEYEVENTF_KEYUP;

    SendInput(4, inputs, sizeof(INPUT));
}

void Win32AutomationDriver::send_text_via_search(const std::string& text) {
    hotkey_ctrl('F');
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    set_clipboard_text(text);
    hotkey_ctrl('V');
    std::this_thread::sleep_for(std::chrono::milliseconds(350));
}

void Win32AutomationDriver::dismiss_search() {
    hotkey_ctrl('F');
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    hotkey_ctrl('A');
    std::this_thread::sleep_for(std::chrono::milliseconds(40));
    send_key(VK_BACK);
    std::this_thread::sleep_for(std::chrono::milliseconds(40));
    send_key(VK_ESCAPE);
    std::this_thread::sleep_for(std::chrono::milliseconds(40));
    send_key(VK_ESCAPE);
}

void Win32AutomationDriver::select_candidate(int choice) {
    if (choice >= 2) {
        for (int i = 0; i < choice - 1; ++i) {
            send_key(VK_DOWN);
            std::this_thread::sleep_for(std::chrono::milliseconds(80));
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
    send_key(VK_RETURN);
    std::this_thread::sleep_for(std::chrono::milliseconds(150));
    send_key(VK_RETURN);
    std::this_thread::sleep_for(std::chrono::milliseconds(300));
}

bool Win32AutomationDriver::send_message_text(const std::string& message) {
    // 安全拷贝与核验
    for (int retry = 0; retry < 5; ++retry) {
        set_clipboard_text(message);
        if (get_clipboard_text() == message) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    hotkey_ctrl('V');
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
    send_key(VK_RETURN);
    std::this_thread::sleep_for(std::chrono::milliseconds(400));
    return true;
}

std::optional<RawImage> Win32AutomationDriver::capture_rect(const WindowRect& rect) {
    int w = rect.width();
    int h = rect.height();
    if (w <= 0 || h <= 0) return std::nullopt;

    HDC hScreenDC = GetDC(nullptr);
    HDC hMemoryDC = CreateCompatibleDC(hScreenDC);
    HBITMAP hBitmap = CreateCompatibleBitmap(hScreenDC, w, h);
    HBITMAP hOldBitmap = static_cast<HBITMAP>(SelectObject(hMemoryDC, hBitmap));

    BitBlt(hMemoryDC, 0, 0, w, h, hScreenDC, rect.left, rect.top, SRCCOPY);

    BITMAPINFO bmi = {};
    bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bmi.bmiHeader.biWidth = w;
    bmi.bmiHeader.biHeight = -h; // Top-down
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = BI_RGB;

    RawImage out;
    out.width = w;
    out.height = h;
    out.channels = 4;
    out.data.resize(w * h * 4);

    GetDIBits(hMemoryDC, hBitmap, 0, h, out.data.data(), &bmi, DIB_RGB_COLORS);

    // BGRA to RGBA
    for (int i = 0; i < w * h; ++i) {
        std::swap(out.data[i * 4 + 0], out.data[i * 4 + 2]);
    }

    SelectObject(hMemoryDC, hOldBitmap);
    DeleteObject(hBitmap);
    DeleteDC(hMemoryDC);
    ReleaseDC(nullptr, hScreenDC);

    return out;
}

std::vector<ContactCandidate> Win32AutomationDriver::capture_and_recognize_dropdown(const WindowRect& rect) {
    auto img_opt = capture_rect(rect);
    if (!img_opt.has_value()) return {};
    auto preprocessed = preprocess_dropdown_image(*img_opt);
    // 可在此处接入 Windows.Media.Ocr (C++/WinRT) 或本地 OCR
    return {};
}

std::string Win32AutomationDriver::capture_and_recognize_header(const WindowRect& rect) {
    auto img_opt = capture_rect(rect);
    if (!img_opt.has_value()) return "";
    return "";
}

#endif // _WIN32

std::unique_ptr<IAutomationDriver> create_automation_driver() {
#ifdef _WIN32
    return std::make_unique<Win32AutomationDriver>();
#else
    return std::make_unique<MockAutomationDriver>();
#endif
}

} // namespace feedback
