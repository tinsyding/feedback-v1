#[cfg(windows)]
use crate::image_proc::preprocess_dropdown_image;
use crate::sender_engine::AutomationDriver;
use crate::types::{ContactCandidate, DropdownCapture};
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
        GetDIBits, RedrawWindow, ReleaseDC, SelectObject, UpdateWindow, BITMAPINFO, BITMAPINFOHEADER,
        BI_RGB, DIB_RGB_COLORS, RDW_ALLCHILDREN, RDW_ERASE, RDW_FRAME, RDW_INVALIDATE,
        RDW_UPDATENOW, SRCCOPY,
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

            if !IsWindow(hwnd).as_bool() {
                return BOOL(1);
            }

            let mut class_buf = [0u16; 256];
            let mut title_buf = [0u16; 256];
            let len_cls = GetClassNameW(hwnd, &mut class_buf);
            let len_title = GetWindowTextW(hwnd, &mut title_buf);

            let class_name = if len_cls > 0 {
                String::from_utf16_lossy(&class_buf[..len_cls as usize])
            } else {
                String::new()
            };
            let title = if len_title > 0 {
                String::from_utf16_lossy(&title_buf[..len_title as usize])
            } else {
                String::new()
            };

            // 企微典型主窗口特征类名及标题：
            // 1. 类名包含 WeWorkWindow (企微标准主窗体类名) 或 WXWork
            // 2. 标题包含 "企业微信"
            // 3. 排除 Wedoc (腾讯文档内嵌页) 和登录界面 ("登录" / "Login")
            let is_wecom = (class_name.contains("WeWorkWindow")
                || class_name.contains("WXWork")
                || title.contains("企业微信"))
                && !class_name.contains("Wedoc")
                && !title.contains("登录")
                && !title.contains("Login");

            if is_wecom {
                // 主窗口尺寸必须大于 300x300，过滤托盘小图标/阴影/悬浮条/隐藏窗口
                let mut rect = RECT::default();
                if GetWindowRect(hwnd, &mut rect).is_ok() {
                    let w = rect.right - rect.left;
                    let h = rect.bottom - rect.top;
                    if w > 300 && h > 300 {
                        unsafe {
                            *found_ptr = Some(hwnd);
                        }
                        return BOOL(0); // 找到主窗口，立即终止枚举
                    }
                }
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
            // 从托盘恢复的 GPU 合成窗口可能保持黑屏：强制整窗立即重绘
            let _ = RedrawWindow(
                hwnd,
                None,
                None,
                RDW_INVALIDATE | RDW_ERASE | RDW_ALLCHILDREN | RDW_FRAME | RDW_UPDATENOW,
            );
            let _ = UpdateWindow(hwnd);
            // 模拟 Alt 键绕过 Windows SetForegroundWindow 跨进程焦点保护限制
            keybd_event(0x12, 0, KEYBD_EVENT_FLAGS(0), 0); // Alt down
            let ok = SetForegroundWindow(hwnd).as_bool();
            keybd_event(0x12, 0, KEYEVENTF_KEYUP, 0); // Alt up
            ok
        }
    }

    pub fn is_foreground(hwnd_val: isize) -> bool {
        unsafe {
            let fg = GetForegroundWindow();
            if fg.0.is_null() {
                return false;
            }
            if (fg.0 as isize) == hwnd_val {
                return true;
            }

            // 考虑企微内部子窗体、搜索框、下拉浮层获焦的情况：
            // 只要当前前台窗口符合企微特征，均判定为处于企微前台
            let mut class_buf = [0u16; 256];
            let mut title_buf = [0u16; 256];
            let len_cls = GetClassNameW(fg, &mut class_buf);
            let len_title = GetWindowTextW(fg, &mut title_buf);

            let class_name = if len_cls > 0 {
                String::from_utf16_lossy(&class_buf[..len_cls as usize])
            } else {
                String::new()
            };
            let title = if len_title > 0 {
                String::from_utf16_lossy(&title_buf[..len_title as usize])
            } else {
                String::new()
            };

            if class_name.contains("WeWorkWindow")
                || class_name.contains("WXWork")
                || title.contains("企业微信")
            {
                return true;
            }

            false
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

    /// 窗口所在显示器的 DPI 缩放系数（1.0 = 100%）。
    /// 下拉框裁剪偏移量以 100% 为设计基准，必须按此系数缩放，
    /// 否则 125%/150%/200% 缩放下会截错区域，OCR 产生幽灵候选导致多按向下键。
    pub fn get_dpi_scale(hwnd_val: isize) -> f32 {
        use windows::Win32::UI::HiDpi::GetDpiForWindow;
        let hwnd = HWND(hwnd_val as *mut _);
        let dpi = unsafe { GetDpiForWindow(hwnd) };
        if dpi == 0 {
            return 1.0;
        }
        (dpi as f32 / 96.0).clamp(0.5, 4.0)
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
    pub fn get_dpi_scale(_hwnd_val: isize) -> f32 {
        1.0
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
        self.capture_dropdown(hwnd).await.map(|c| c.candidates)
    }

    async fn capture_dropdown(&self, hwnd: isize) -> Result<DropdownCapture, String> {
        #[cfg(windows)]
        {
            let rect = get_rect(hwnd).ok_or_else(|| "无法获取企微窗口坐标".to_string())?;
            // 关键修复：与经典版一致按显示器 DPI 缩放裁剪偏移，否则高缩放屏会截错区域
            let scale = get_dpi_scale(hwnd);
            let off_x = (38.0 * scale).round() as i32;
            let off_y = (46.0 * scale).round() as i32;
            let base_w = (380.0 * scale).round() as i32;
            let base_h = (460.0 * scale).round() as i32;

            let mut search_rect = WindowRect {
                left: rect.left + off_x,
                top: rect.top + off_y,
                right: (rect.left + off_x + base_w).min(rect.right),
                bottom: (rect.top + off_y + base_h).min(rect.bottom),
            };
            // 窗口过小时保底，避免空区域截图
            search_rect.right = search_rect.right.max(search_rect.left + 50);
            search_rect.bottom = search_rect.bottom.max(search_rect.top + 50);

            let img = capture_window_rect(search_rect).ok_or_else(|| "截取下拉框图像失败".to_string())?;
            let preprocessed = preprocess_dropdown_image(&img);
            let ocr_res = crate::automation::win_ocr::recognize_native_ocr(&preprocessed)?;
            // 传入 DPI 缩放，让解析阶段按物理像素过滤搜索框残留文字与右侧水印
            let candidates = crate::automation::win_ocr::parse_ocr_lines_to_contacts_at_scale(
                &ocr_res.lines,
                &ocr_res.full_text,
                scale,
            );
            Ok(DropdownCapture {
                candidates,
                raw_text: ocr_res.full_text,
                dpi_scale: scale,
            })
        }
        #[cfg(not(windows))]
        {
            let _ = hwnd;
            Ok(DropdownCapture::default())
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

    async fn dismiss_search(&self, _hwnd: isize) -> Result<(), String> {
        hotkey_ctrl(0x46); // Ctrl+F 激活搜索框
        tokio::time::sleep(Duration::from_millis(60)).await;
        hotkey_ctrl(0x41); // Ctrl+A 全选
        tokio::time::sleep(Duration::from_millis(40)).await;
        send_key(0x08);    // Backspace 清空文字
        tokio::time::sleep(Duration::from_millis(50)).await;
        send_key(0x1B);    // VK_ESCAPE 关闭下拉
        tokio::time::sleep(Duration::from_millis(40)).await;
        send_key(0x1B);    // VK_ESCAPE 退出搜索焦点
        Ok(())
    }
}
