//! `axondeck-probe raise-window <reuseNames,...> [seconds]`：Ctrl+G 開出來的編輯器抬到最前面並置頂。
//! 對照 `src/main/terminal/foreground.js` 原本的 PowerShell 腳本（規則一樣，說明見那支的註解）：
//! 先記「pid → 主視窗＋標題」，之後幾秒內新程序開的視窗、或 reuse 名單裡的編輯器換了視窗／標題，就抬它。
//!
//! PowerShell 版冷啟＋Add-Type 編譯要一秒多才開始盯，記事本可能已經先開好而抬不到；這裡幾毫秒就拍好快照。

use std::collections::HashMap;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{HWND, LPARAM};
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GW_OWNER, GetForegroundWindow, GetWindow, GetWindowTextW, GetWindowThreadProcessId, HWND_TOPMOST,
    IsIconic, IsWindowVisible, SW_RESTORE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SetForegroundWindow, SetWindowPos,
    ShowWindow,
};
use windows::core::BOOL;

use crate::procs;

/// pid → (視窗, 標題)：跟 .NET 的 MainWindowHandle 一樣取第一個「看得見、沒有擁有者」的頂層視窗
fn main_windows() -> HashMap<u32, (isize, String)> {
    unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let map = unsafe { &mut *(lparam.0 as *mut HashMap<u32, (isize, String)>) };
        let visible = unsafe { IsWindowVisible(hwnd) }.as_bool();
        let owned = unsafe { GetWindow(hwnd, GW_OWNER) }.is_ok_and(|h| !h.is_invalid());
        if visible && !owned {
            let mut pid = 0u32;
            unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
            map.entry(pid).or_insert_with(|| {
                let mut buf = [0u16; 512];
                let len = unsafe { GetWindowTextW(hwnd, &mut buf) }.max(0) as usize;
                (hwnd.0 as isize, String::from_utf16_lossy(&buf[..len]))
            });
        }
        BOOL(1)
    }
    let mut map = HashMap::new();
    unsafe {
        let _ = EnumWindows(Some(each), LPARAM(&mut map as *mut _ as isize));
    }
    map
}

/// pid → 映像檔名（小寫、去掉 .exe）＝ .NET 的 ProcessName
fn names() -> HashMap<u32, String> {
    procs::snapshot(&mut Vec::new())
        .into_iter()
        .map(|p| {
            let lower = p.image.to_lowercase();
            (p.pid, lower.strip_suffix(".exe").unwrap_or(&lower).to_string())
        })
        .collect()
}

fn raise(target: HWND) {
    unsafe {
        let front = GetWindowThreadProcessId(GetForegroundWindow(), None);
        let mine = GetCurrentThreadId();
        // 不接上前景執行緒的輸入佇列的話，SetForegroundWindow 會被系統靜靜地忽略
        let _ = AttachThreadInput(mine, front, true);
        if IsIconic(target).as_bool() {
            let _ = ShowWindow(target, SW_RESTORE);
        }
        let _ = SetForegroundWindow(target);
        let _ = AttachThreadInput(mine, front, false);
        // 置頂：只 SetForegroundWindow 的話，回頭點一下 AxonDeck 就被蓋掉
        let _ = SetWindowPos(target, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
    }
}

/// 回傳該抬的視窗：新程序開的視窗不設限；既有程序只有 reuse 名單裡的換了視窗／標題才算
fn pick(known: &HashMap<u32, (isize, String)>, now: &HashMap<u32, (isize, String)>, reuse: &[String], names: &mut Option<HashMap<u32, String>>) -> Option<isize> {
    for (pid, win) in now {
        match known.get(pid) {
            None => return Some(win.0),
            Some(old) if old != win => {
                let names = names.get_or_insert_with(self::names);
                if names.get(pid).is_some_and(|n| reuse.contains(n)) {
                    return Some(win.0);
                }
            }
            _ => {}
        }
    }
    None
}

pub fn run(args: &[String]) -> i32 {
    let reuse: Vec<String> = args.first().map_or("", String::as_str).split(',').filter(|s| !s.is_empty()).map(str::to_lowercase).collect();
    let seconds = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(8u64);
    let known = main_windows();
    let deadline = Instant::now() + Duration::from_secs(seconds);
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(150));
        if let Some(hwnd) = pick(&known, &main_windows(), &reuse, &mut None) {
            raise(HWND(hwnd as *mut _));
            return 0;
        }
    }
    1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_process_wins_and_title_change_needs_reuse() {
        let known = HashMap::from([(1, (10, "a".to_string()))]);
        let fresh = HashMap::from([(1, (10, "a".to_string())), (2, (20, "n".to_string()))]);
        assert_eq!(pick(&known, &fresh, &[], &mut None), Some(20));
        let retitled = HashMap::from([(1, (10, "b".to_string()))]);
        assert_eq!(pick(&known, &retitled, &[], &mut Some(HashMap::from([(1, "chrome".to_string())]))), None);
        assert_eq!(pick(&known, &retitled, &["notepad".to_string()], &mut Some(HashMap::from([(1, "notepad".to_string())]))), Some(10));
        assert_eq!(pick(&known, &known, &["notepad".to_string()], &mut None), None);
    }
}
