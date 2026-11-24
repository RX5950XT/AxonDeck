//! 哪些程序是「應用程式」（工作管理員把它們排在「應用程式」那一段，其餘是背景處理程序）：
//! 有一個工作列上看得到的頂層視窗——看得見、沒有擁有者、不是工具視窗、有標題、沒被 DWM 藏起來。
//! UWP 的視窗外框屬於 ApplicationFrameHost，真正的程式是框裡那個不同 pid 的子視窗。

use std::collections::HashSet;
use std::ffi::c_void;

use windows::Win32::Foundation::{HWND, LPARAM};
use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, EnumWindows, GW_OWNER, GWL_EXSTYLE, GetClassNameW, GetWindow, GetWindowLongPtrW,
    GetWindowTextLengthW, GetWindowThreadProcessId, IsWindowVisible, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
};
use windows::core::BOOL;

/// 被另一個虛擬桌面藏起來的視窗是 shell 隱藏（2）：工作管理員照樣算應用程式
const DWM_CLOAKED_SHELL: u32 = 2;

fn pid_of(hwnd: HWND) -> u32 {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    pid
}

fn is_app_window(hwnd: HWND) -> bool {
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() || GetWindow(hwnd, GW_OWNER).is_ok_and(|h| !h.is_invalid()) {
            return false;
        }
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        if ex & WS_EX_TOOLWINDOW.0 != 0 && ex & WS_EX_APPWINDOW.0 == 0 {
            return false;
        }
        if GetWindowTextLengthW(hwnd) <= 0 {
            return false;
        }
        let mut cloaked = 0u32;
        let ok = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut c_void, 4).is_ok();
        !ok || cloaked == 0 || cloaked == DWM_CLOAKED_SHELL
    }
}

fn class_is(hwnd: HWND, name: &str) -> bool {
    let mut buf = [0u16; 64];
    let len = unsafe { GetClassNameW(hwnd, &mut buf) }.max(0) as usize;
    String::from_utf16_lossy(&buf[..len]) == name
}

/// UWP 外框裡第一個不屬於外框程序的子視窗 → 真正的 app pid
fn uwp_pid(frame: HWND) -> Option<u32> {
    struct Find { host: u32, found: Option<u32> }
    unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let find = unsafe { &mut *(lparam.0 as *mut Find) };
        let pid = pid_of(hwnd);
        if pid != find.host && pid != 0 {
            find.found = Some(pid);
            return BOOL(0);
        }
        BOOL(1)
    }
    let mut find = Find { host: pid_of(frame), found: None };
    unsafe {
        let _ = EnumChildWindows(Some(frame), Some(each), LPARAM(&mut find as *mut _ as isize));
    }
    find.found
}

pub fn app_pids() -> HashSet<u32> {
    unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let set = unsafe { &mut *(lparam.0 as *mut HashSet<u32>) };
        // 頂層的 CoreWindow 是開始選單、搜尋、輸入法這類系統介面（真正的 UWP 視窗是外框裡的子視窗）
        if is_app_window(hwnd) && !class_is(hwnd, "Windows.UI.Core.CoreWindow") {
            let pid = if class_is(hwnd, "ApplicationFrameWindow") { uwp_pid(hwnd) } else { Some(pid_of(hwnd)) };
            if let Some(pid) = pid.filter(|p| *p != 0) {
                set.insert(pid);
            }
        }
        BOOL(1)
    }
    let mut set = HashSet::new();
    unsafe {
        let _ = EnumWindows(Some(each), LPARAM(&mut set as *mut _ as isize));
    }
    set
}

#[cfg(test)]
mod tests {
    #[test]
    fn runs() {
        // CI／服務工作階段可能沒有桌面：只要求不當掉
        let _ = super::app_pids();
    }
}
