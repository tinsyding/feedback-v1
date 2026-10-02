#[cfg(windows)]
use crate::image_proc::preprocess_dropdown_image;
use crate::sender_engine::AutomationDriver;
use crate::types::ContactCandidate;
use image::DynamicImage;
use std::time::Duration;

/// 跨平台窗口坐标矩形
#[derive(Debug, Clone, Copy, Default)]
pub struct WindowRect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl WindowRect {
    pub fn width(&self) -> i32 {
        self.right - self.left
    }
    pub fn height(&self) -> i32 {
        self.bottom - self.top
    }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM, RECT};
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        SRCCOPY,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        keybd_event, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetForegroundWindow, GetWindowRect, GetWindowTextW,
        IsIconic, IsWindow, SetForegroundWindow, ShowWindow, SW_RESTORE, SW_SHOW,
    };

    pub fn find_wecom_window() -> Option<isize> {
        let mut found_hwnd: Option<HWND> = None;

        unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let found_ptr = lparam.0 as *mut Option<HWND>;
            let mut class_buf = [0u16; 256];
            let mut title_buf = [0u16; 256];
            let _ = GetClassNameW(hwnd, &mut class_buf);
            let _ = GetWindowTextW(hwnd, &mut title_buf);

            let class_name = String::from_utf16_lossy(&class_buf);
            let title = String::from_utf16_lossy(&title_buf);

            // 企微典型主窗口特征类名及标题
            if (class_name.contains("WeChatMainWndForPC") || class_name.contains("WXWork_Frame"))
                && !title.contains("登录")
            {
                unsafe {
                    *found_ptr = Some(hwnd);
                }
                return BOOL(0); // 终止枚举
            }
            BOOL(1)
        }

        unsafe {
            let _ = EnumWindows(
                Some(enum_proc),
                LPARAM(&mut found_hwnd as *mut _ as isize),
            );
        }

        found_hwnd.map(|h| h.0 as isize)
    }

    pub fn activate_wecom(hwnd_val: isize) -> bool {
        let hwnd = HWND(hwnd_val as *mut _);
        unsafe {
            if !IsWindow(hwnd).as_bool() {
                return false;
            }
            if IsIconic(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            } else {
                let _ = ShowWindow(hwnd, SW_SHOW);
            }
            SetForegroundWindow(hwnd).as_bool()
        }
    }

    pub fn is_foreground(hwnd_val: isize) -> bool {
        unsafe {
            let fg = GetForegroundWindow();
            (fg.0 as isize) == hwnd_val
        }
    }

    pub fn get_rect(hwnd_val: isize) -> Option<WindowRect> {
        let hwnd = HWND(hwnd_val as *mut _);
        let mut r = RECT::default();
        unsafe {
            if GetWindowRect(hwnd, &mut r).is_ok() {
                Some(WindowRect {
                    left: r.left,
                    top: r.top,
                    right: r.right,
                    bottom: r.bottom,
                })
            } else {
                None
            }
        }
    }

    pub fn capture_window_rect(rect: WindowRect) -> Option<DynamicImage> {
        unsafe {
            let width = rect.width();
            let height = rect.height();
            if width <= 0 || height <= 0 {
                return None;
            }

            let hdc_screen = GetDC(HWND(std::ptr::null_mut()));
            let hdc_mem = CreateCompatibleDC(hdc_screen);
            let hbm = CreateCompatibleBitmap(hdc_screen, width, height);
            let old_obj = SelectObject(hdc_mem, hbm);

            let _ = BitBlt(hdc_mem, 0, 0, width, height, hdc_screen, rect.left, rect.top, SRCCOPY);

            let mut bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width,
                    biHeight: -height,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };

            let mut buf = vec![0u8; (width * height * 4) as usize];
            let lines = GetDIBits(
                hdc_mem,
                hbm,
                0,
                height as u32,
                Some(buf.as_mut_ptr() as *mut _),
                &mut bmi,
                DIB_RGB_COLORS,
            );

            SelectObject(hdc_mem, old_obj);
            DeleteObject(hbm);
            DeleteDC(hdc_mem);
            ReleaseDC(HWND(std::ptr::null_mut()), hdc_screen);

            if lines == 0 {
                return None;
            }

            for chunk in buf.chunks_exact_mut(4) {
                let b = chunk[0];
                let r = chunk[2];
                chunk[0] = r;
                chunk[2] = b;
            }

            image::RgbaImage::from_raw(width as u32, height as u32, buf).map(DynamicImage::ImageRgba8)
        }
    }

    pub fn key_down(vk: u8) {
        unsafe {
            keybd_event(vk, 0, KEYBD_EVENT_FLAGS(0), 0);
        }
    }

    pub fn key_up(vk: u8) {
        unsafe {
            keybd_event(vk, 0, KEYEVENTF_KEYUP, 0);
        }
    }

    pub fn send_key(vk: u8) {
        key_down(vk);
        std::thread::sleep(Duration::from_millis(30));
        key_up(vk);
    }

    pub fn hotkey_ctrl(key_vk: u8) {
        key_down(0x11); // VK_CONTROL
        std::thread::sleep(Duration::from_millis(20));
        send_key(key_vk);
        std::thread::sleep(Duration::from_millis(20));
        key_up(0x11);
    }

    pub fn set_clipboard_text(text: &str) -> Result<(), String> {
        let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("初始化剪贴板失败: {e}"))?;
        clipboard.set_text(text).map_err(|e| format!("写入剪贴板失败: {e}"))
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;

    pub fn find_wecom_window() -> Option<isize> {
        None
    }
    pub fn activate_wecom(_hwnd_val: isize) -> bool {
        false
    }
    pub fn is_foreground(_hwnd_val: isize) -> bool {
        false
    }
    pub fn get_rect(_hwnd_val: isize) -> Option<WindowRect> {
        None
    }
    pub fn capture_window_rect(_rect: WindowRect) -> Option<DynamicImage> {
        None
    }
    pub fn send_key(_vk: u8) {}
    pub fn hotkey_ctrl(_key_vk: u8) {}
    pub fn set_clipboard_text(_text: &str) -> Result<(), String> {
        Ok(())
    }
}

pub use imp::*;

/// 真实企业微信 Win32 自动化驱动
#[derive(Debug, Default)]
pub struct WinAutomationDriver;

impl WinAutomationDriver {
    pub fn new() -> Self {
        Self
    }
}

impl AutomationDriver for WinAutomationDriver {
    async fn find_wecom(&self) -> Option<isize> {
        find_wecom_window()
    }

    async fn is_wecom_foreground(&self, hwnd: isize) -> bool {
        is_foreground(hwnd)
    }

    async fn search_contact(&self, hwnd: isize, query: &str) -> Result<(), String> {
        activate_wecom(hwnd);
        tokio::time::sleep(Duration::from_millis(200)).await;

        // 1. Ctrl+F 激活搜索
        hotkey_ctrl(0x46);
        tokio::time::sleep(Duration::from_millis(300)).await;

        // 2. Ctrl+A, Backspace 清空残留搜索框文本
        hotkey_ctrl(0x41);
        tokio::time::sleep(Duration::from_millis(50)).await;
        send_key(0x08);
        tokio::time::sleep(Duration::from_millis(50)).await;

        // 3. 写入剪贴板并粘贴
        set_clipboard_text(query)?;
        hotkey_ctrl(0x56);

        // 4. 等待下拉框展开
        tokio::time::sleep(Duration::from_millis(800)).await;
        Ok(())
    }

    async fn capture_dropdown_candidates(&self, hwnd: isize) -> Result<Vec<ContactCandidate>, String> {
        #[cfg(windows)]
        {
            let rect = get_rect(hwnd).ok_or_else(|| "无法获取企微窗口坐标".to_string())?;
            let search_rect = WindowRect {
                left: rect.left,
                top: rect.top + 50,
                right: (rect.left + 360).min(rect.right),
                bottom: (rect.top + 450).min(rect.bottom),
            };

            let img = capture_window_rect(search_rect).ok_or_else(|| "截取下拉框图像失败".to_string())?;
            let preprocessed = preprocess_dropdown_image(&img);
            let ocr_res = crate::automation::win_ocr::recognize_native_ocr(&preprocessed)?;
            let candidates = crate::automation::win_ocr::parse_ocr_lines_to_contacts(&ocr_res.lines, &ocr_res.full_text);
            Ok(candidates)
        }
        #[cfg(not(windows))]
        {
            let _ = hwnd;
            Ok(Vec::new())
        }
    }

    async fn select_candidate(&self, _hwnd: isize, choice: usize) -> Result<(), String> {
        if choice >= 2 {
            for _ in 0..(choice - 1) {
                send_key(0x28); // VK_DOWN
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        send_key(0x0D); // VK_RETURN
        tokio::time::sleep(Duration::from_millis(200)).await;
        send_key(0x0D); // Enter 会话
        tokio::time::sleep(Duration::from_millis(300)).await;
        Ok(())
    }

    async fn send_message_text(&self, _hwnd: isize, message: &str) -> Result<(), String> {
        set_clipboard_text(message)?;
        hotkey_ctrl(0x56); // Ctrl+V
        tokio::time::sleep(Duration::from_millis(300)).await;
        send_key(0x0D); // VK_RETURN 发送
        tokio::time::sleep(Duration::from_millis(500)).await;
        Ok(())
    }
}
