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
        let hwnd = HWND(hwnd_val as _);
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
            fg.0 == hwnd_val as _
        }
    }

    pub fn get_rect(hwnd_val: isize) -> Option<WindowRect> {
        let hwnd = HWND(hwnd_val as _);
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
}

pub use imp::*;
