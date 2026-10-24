//! `axondeck-probe procs-json`：整機程序清單一列 JSON，欄位跟終端機原本用的
//! `Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,Name,CommandLine,StartedAt` 一樣，
//! `src/main/terminal/agent-processes.js` 不必知道對面換了人。
//!
//! PowerShell 版每次冷啟約 0.8 秒；這裡是 `NtQuerySystemInformation` 一次拿清單，
//! 指令列再逐支 `NtQueryInformationProcess(ProcessCommandLineInformation)`，幾十毫秒內。
//! 讀不到指令列（系統程序、別的使用者）就給 null，跟 CIM 一樣。

use std::ffi::c_void;

use chrono::{DateTime, SecondsFormat};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

use crate::procs;
use crate::util::filetime_epoch_ms;

const PROCESS_COMMAND_LINE_INFORMATION: u32 = 60;
const STATUS_INFO_LENGTH_MISMATCH: i32 = 0xC000_0004_u32 as i32;

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtQueryInformationProcess(process: HANDLE, class: u32, buf: *mut c_void, len: u32, ret: *mut u32) -> i32;
}

fn command_line(pid: u32) -> Option<String> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    // 回傳是 UNICODE_STRING（Length、MaximumLength、對齊、Buffer 指標）後面接字串本體
    let mut buf = vec![0u64; 128];
    let mut status;
    loop {
        let mut need = 0u32;
        status = unsafe {
            NtQueryInformationProcess(handle, PROCESS_COMMAND_LINE_INFORMATION, buf.as_mut_ptr() as *mut c_void, (buf.len() * 8) as u32, &mut need)
        };
        if status == STATUS_INFO_LENGTH_MISMATCH && (need as usize) > buf.len() * 8 {
            buf.resize((need as usize).div_ceil(8), 0);
            continue;
        }
        break;
    }
    unsafe { let _ = CloseHandle(handle); }
    if status < 0 {
        return None;
    }
    let len = (buf[0] & 0xFFFF) as usize / 2;
    let ptr = buf[1] as *const u16;
    if ptr.is_null() || len == 0 {
        return Some(String::new());
    }
    // Buffer 指向同一塊緩衝裡面
    Some(String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(ptr, len) }))
}

fn started_at(create_time: i64) -> Option<String> {
    if create_time <= 0 {
        return None;
    }
    DateTime::from_timestamp_millis(filetime_epoch_ms(create_time)).map(|t| t.to_rfc3339_opts(SecondsFormat::Millis, true))
}

pub fn run() -> i32 {
    let rows: Vec<serde_json::Value> = procs::snapshot(&mut Vec::new())
        .into_iter()
        .map(|p| {
            serde_json::json!({
                "ProcessId": p.pid,
                "ParentProcessId": p.parent,
                "Name": p.image,
                "CommandLine": command_line(p.pid),
                "StartedAt": started_at(p.create_time),
            })
        })
        .collect();
    println!("{}", serde_json::Value::Array(rows));
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_own_command_line_and_start() {
        let me = std::process::id();
        let line = command_line(me).expect("自己的指令列一定讀得到");
        assert!(line.to_lowercase().contains("axondeck_probe"), "{line}");
        let p = procs::snapshot(&mut Vec::new()).into_iter().find(|p| p.pid == me).unwrap();
        let at = started_at(p.create_time).unwrap();
        assert!(at.ends_with('Z') && at.len() == 24, "{at}");
    }
}
