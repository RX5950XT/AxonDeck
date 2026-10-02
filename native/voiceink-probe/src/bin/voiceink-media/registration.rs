//! 開啟方式與有備份的靜默預設切換；不開 Windows 設定視窗。
use crate::{engine, ui::wide};
use std::{path::{Path, PathBuf}, process::Command, os::windows::process::CommandExt};
use serde_json::{Value, json};
use windows::core::{PCWSTR, PWSTR, w};
use windows::Win32::System::Registry::*;
use windows::Win32::Foundation::{WIN32_ERROR, ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND};
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0, WAIT_ABANDONED_0};
use windows::Win32::System::Threading::{CreateMutexW, WaitForSingleObject, ReleaseMutex};
use windows::Win32::UI::Shell::*;

const CAPABILITIES: &str = "Software\\VoiceInk\\Media\\Capabilities";
const INITIALIZED_VALUE: &str = "DefaultsInitialized";
struct DefaultsLock(HANDLE);
impl DefaultsLock {
    fn acquire() -> Result<Self, String> {
        let user = std::env::var_os("LOCALAPPDATA").ok_or("找不到使用者資料夾")?;
        let mut hash = 0xcbf29ce484222325u64;
        for byte in user.to_string_lossy().to_lowercase().as_bytes() {
            hash = (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3);
        }
        Self::named(&wide(&format!("Local\\VoiceInkMediaDefaults-{hash:016x}")))
    }
    fn named(name: &[u16]) -> Result<Self, String> {
        let handle = unsafe { CreateMutexW(None, false, PCWSTR(name.as_ptr())) }.map_err(|_| "無法鎖定預設關聯")?;
        let result = unsafe { WaitForSingleObject(handle, 5000) };
        if result != WAIT_OBJECT_0 && result != WAIT_ABANDONED_0 {
            unsafe { let _ = CloseHandle(handle); }
            return Err("預設關聯忙碌，請稍後重試".into());
        }
        Ok(Self(handle))
    }
}
impl Drop for DefaultsLock {
    fn drop(&mut self) { unsafe { let _ = ReleaseMutex(self.0); let _ = CloseHandle(self.0); } }
}
fn command() -> String { format!("\"{}\" -- \"%1\"", engine::runtime().join("voiceink-media.exe").display()) }
fn registered(root: HKEY) -> Option<String> {
    let mut text = [0u16; 32768]; let mut bytes = size_of_val(&text) as u32;
    let result = unsafe { RegGetValueW(root, w!("Software\\Classes\\Applications\\voiceink-media.exe\\shell\\open\\command"),
        None, RRF_RT_REG_SZ, None, Some(text.as_mut_ptr().cast()), Some(&mut bytes)) };
    result.is_ok().then(|| String::from_utf16_lossy(&text[..text.iter().position(|&v| v == 0).unwrap_or(text.len())]))
}
fn put(root: HKEY, path: &str, name: &str, value: &str) -> windows::core::Result<()> {
    unsafe {
        let mut key = HKEY::default();
        RegCreateKeyExW(root, PCWSTR(wide(path).as_ptr()), None, None, REG_OPTION_NON_VOLATILE,
            KEY_WRITE, None, &mut key, None).ok()?;
        let bytes: Vec<_> = wide(value).into_iter().flat_map(u16::to_le_bytes).collect();
        let result = RegSetValueExW(key, PCWSTR(wide(name).as_ptr()), None, REG_SZ, Some(&bytes)).ok();
        let _ = RegCloseKey(key); result
    }
}
pub fn register(machine: bool) -> windows::core::Result<()> {
    let root = if machine { HKEY_LOCAL_MACHINE } else { HKEY_CURRENT_USER };
    let command = command();
    put(root, CAPABILITIES, "ApplicationName", "VoiceInk Media")?;
    put(root, CAPABILITIES, "ApplicationDescription", "VoiceInk 原生圖片、動畫、影片與音樂播放器")?;
    put(root, CAPABILITIES, "ApplicationIcon", &format!("{},0", engine::runtime().join("icon.ico").display()))?;
    put(root, "Software\\RegisteredApplications", "VoiceInk Media", CAPABILITIES)?;
    put(root, "Software\\Classes\\Applications\\voiceink-media.exe", "FriendlyAppName", "VoiceInk Media")?;
    put(root, "Software\\Classes\\Applications\\voiceink-media.exe\\DefaultIcon", "", &engine::runtime().join("icon.ico").to_string_lossy())?;
    put(root, "Software\\Classes\\Applications\\voiceink-media.exe\\shell\\open\\command", "", &command)?;
    for (kind, formats) in engine::formats().as_object().unwrap() {
        let prog = format!("VoiceInk.Media.{kind}");
        let label = match kind.as_str() { "image" => "圖片", "video" => "影片", "audio" => "音樂", _ => "播放清單" };
        put(root, &format!("Software\\Classes\\{prog}"), "", &format!("VoiceInk {label}"))?;
        put(root, &format!("Software\\Classes\\{prog}\\DefaultIcon"), "", &engine::runtime().join("icon.ico").to_string_lossy())?;
        put(root, &format!("Software\\Classes\\{prog}\\shell\\open\\command"), "", &command)?;
        for ext in formats.as_array().unwrap() {
            let ext = format!(".{}", ext.as_str().unwrap());
            put(root, &format!("{CAPABILITIES}\\FileAssociations"), &ext, &prog)?;
            put(root, &format!("Software\\Classes\\{ext}\\OpenWithProgids"), &prog, "")?;
            put(root, "Software\\Classes\\Applications\\voiceink-media.exe\\SupportedTypes", &ext, "")?;
        }
    }
    unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST | SHCNF_FLUSH, None, None); }
    Ok(())
}
pub fn unregister(machine: bool) -> windows::core::Result<()> {
    let _lock = DefaultsLock::acquire().map_err(|_| windows::core::Error::new(windows::core::HRESULT(0x80004005u32 as i32), "預設關聯忙碌"))?;
    let root = if machine { HKEY_LOCAL_MACHINE } else { HKEY_CURRENT_USER };
    // 舊安裝／預覽版不可刪掉另一份播放器後來登記的開啟方式。
    if registered(root).is_some_and(|value| !value.eq_ignore_ascii_case(&command())) { return Ok(()); }
    if !machine {
        let file = backup_path();
        if let Some(file) = file { restore_defaults(Path::new(&file)).map_err(|_| windows::core::Error::new(windows::core::HRESULT(0x80004005u32 as i32), "無法還原預設關聯"))?; }
        for (ext, prog) in extensions() {
            if association(&ext) == prog { clear_choice(&ext).map_err(|_| windows::core::Error::new(windows::core::HRESULT(0x80004005u32 as i32), "無法還原預設關聯"))?; }
            if legacy_default(&ext).ok().flatten().as_deref() == Some(&prog) { delete_legacy(&ext).map_err(|_| windows::core::Error::new(windows::core::HRESULT(0x80004005u32 as i32), "無法還原預設關聯"))?; }
        }
    }
    let mut failure = None;
    let mut check = |result: WIN32_ERROR| {
        if result != ERROR_FILE_NOT_FOUND && result != ERROR_PATH_NOT_FOUND {
            if let Err(error) = result.ok() { failure.get_or_insert(error); }
        }
    };
    unsafe {
        for (kind, formats) in engine::formats().as_object().unwrap() {
            let prog = format!("VoiceInk.Media.{kind}");
            check(RegDeleteTreeW(root, PCWSTR(wide(&format!("Software\\Classes\\{prog}")).as_ptr())));
            for ext in formats.as_array().unwrap() {
                let mut key = HKEY::default();
                let path = wide(&format!("Software\\Classes\\.{}\\OpenWithProgids", ext.as_str().unwrap()));
                let opened = RegOpenKeyExW(root, PCWSTR(path.as_ptr()), None, KEY_SET_VALUE, &mut key);
                check(opened);
                if opened.is_ok() {
                    check(RegDeleteValueW(key, PCWSTR(wide(&prog).as_ptr()))); let _ = RegCloseKey(key);
                }
            }
        }
        for path in ["Software\\VoiceInk\\Media", "Software\\Classes\\Applications\\voiceink-media.exe"] {
            check(RegDeleteTreeW(root, PCWSTR(wide(path).as_ptr())));
        }
        let mut key = HKEY::default();
        let opened = RegOpenKeyExW(root, w!("Software\\RegisteredApplications"), None, KEY_SET_VALUE, &mut key);
        check(opened);
        if opened.is_ok() {
            check(RegDeleteValueW(key, w!("VoiceInk Media"))); let _ = RegCloseKey(key);
        }
        SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST | SHCNF_FLUSH, None, None);
    }
    if let Some(error) = failure { Err(error) } else { Ok(()) }
}
fn association(ext: &str) -> String {
    let mut buffer = [0u16; 32768]; let mut count = buffer.len() as u32;
    let result = unsafe { AssocQueryStringW(ASSOCF_NONE, ASSOCSTR_PROGID, PCWSTR(wide(ext).as_ptr()),
        None, Some(PWSTR(buffer.as_mut_ptr())), &mut count) };
    if result.is_err() { return String::new(); }
    String::from_utf16_lossy(&buffer[..buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len())])
}
fn legacy_default(ext: &str) -> Result<Option<String>, String> {
    let mut buffer = [0u16; 32768]; let mut bytes = size_of_val(&buffer) as u32;
    let result = unsafe { RegGetValueW(HKEY_CURRENT_USER, PCWSTR(wide(&format!("Software\\Classes\\{ext}")).as_ptr()),
        None, RRF_RT_REG_SZ, None, Some(buffer.as_mut_ptr().cast()), Some(&mut bytes)) };
    if result == ERROR_FILE_NOT_FOUND || result == ERROR_PATH_NOT_FOUND { return Ok(None); }
    result.ok().map_err(|_| "無法備份原預設關聯")?;
    Ok(Some(String::from_utf16_lossy(&buffer[..buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len())])))
}
fn backup_path() -> Option<String> {
    let mut buffer = [0u16; 32768]; let mut bytes = size_of_val(&buffer) as u32;
    let result = unsafe { RegGetValueW(HKEY_CURRENT_USER, w!("Software\\VoiceInk\\Media"), w!("DefaultsBackup"),
        RRF_RT_REG_SZ, None, Some(buffer.as_mut_ptr().cast()), Some(&mut bytes)) };
    result.is_ok().then(|| String::from_utf16_lossy(&buffer[..buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len())]))
}
fn defaults_initialized() -> windows::core::Result<bool> {
    let mut text = [0u16; 16]; let mut bytes = size_of_val(&text) as u32;
    let result = unsafe { RegGetValueW(HKEY_CURRENT_USER, w!("Software\\VoiceInk\\Media"),
        PCWSTR(wide(INITIALIZED_VALUE).as_ptr()), RRF_RT_REG_SZ, None, Some(text.as_mut_ptr().cast()), Some(&mut bytes)) };
    if result == ERROR_FILE_NOT_FOUND || result == ERROR_PATH_NOT_FOUND { return Ok(false); }
    result.ok()?;
    Ok(String::from_utf16_lossy(&text[..text.iter().position(|&v| v == 0).unwrap_or(text.len())]) == "1")
}
fn extensions() -> Vec<(String, String)> {
    engine::formats().as_object().unwrap().iter().flat_map(|(kind, formats)| {
        formats.as_array().unwrap().iter().map(move |ext| (format!(".{}", ext.as_str().unwrap()), format!("VoiceInk.Media.{kind}")))
    }).collect()
}
fn initialize_with(
    initialized: bool,
    defaults: impl FnOnce() -> Result<(), String>,
    register: impl FnOnce() -> Result<(), String>,
    mark_initialized: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if initialized { return register(); }
    defaults()?;
    mark_initialized()
}
fn clear_choice(ext: &str) -> Result<(), String> {
    let base = format!("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\{ext}");
    // 從父鍵刪除，只要求 DELETE；不改 ACL、不停系統服務。
    // Windows 11 25H2 另有 UserChoiceLatest/ProgId；不能只清舊 UserChoice。
    for child in ["UserChoiceLatest\\ProgId", "UserChoiceLatest", "UserChoice"] {
        let result = unsafe { RegDeleteKeyW(HKEY_CURRENT_USER, PCWSTR(wide(&format!("{base}\\{child}")).as_ptr())) };
        if result != ERROR_FILE_NOT_FOUND && result != ERROR_PATH_NOT_FOUND {
            result.ok().map_err(|_| "Windows 拒絕變更預設關聯；原設定備份已保留")?;
        }
    }
    Ok(())
}
fn choice_hash(ext: &str, mode: &str, prog: Option<&str>) -> Result<String, String> {
    let mut command = Command::new(engine::runtime().join("voiceink-association.exe"));
    command.args([mode, ext]).creation_flags(0x08000000);
    if let Some(prog) = prog { command.arg(prog); }
    let output = command.output().map_err(|_| "原生關聯工具無法執行")?;
    let hash = String::from_utf8(output.stdout).map_err(|_| "原生關聯工具回應不正確")?;
    let hash = hash.trim();
    if !output.status.success() || hash.len() != 12 || !hash.bytes().all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b)) {
        return Err("此 Windows 版本無法靜默設定預設關聯".into());
    }
    Ok(hash.to_owned())
}
fn set_choice(ext: &str, prog: &str) -> Result<(), String> {
    let classic_hash = choice_hash(ext, "--classic-for", Some(prog))?;
    clear_choice(ext)?;
    let prefix = format!("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\{ext}");
    let classic = format!("{prefix}\\UserChoice");
    let mut key = HKEY::default();
    unsafe { RegCreateKeyExW(HKEY_CURRENT_USER, PCWSTR(wide(&classic).as_ptr()), None, None, REG_OPTION_NON_VOLATILE,
        KEY_SET_VALUE, None, &mut key, None).ok().map_err(|_| "無法寫入相容關聯")?; }
    // 同一 handle 完成兩個值：Windows 中途套用 ACL 也不需重新開啟鍵。
    let result = (|| {
        let bytes: Vec<_> = wide(prog).into_iter().flat_map(u16::to_le_bytes).collect();
        unsafe { RegSetValueExW(key, w!("ProgId"), None, REG_SZ, Some(&bytes)).ok().map_err(|_| "無法寫入相容關聯")?; }
        let bytes: Vec<_> = wide(&classic_hash).into_iter().flat_map(u16::to_le_bytes).collect();
        unsafe { RegSetValueExW(key, w!("Hash"), None, REG_SZ, Some(&bytes)).ok().map_err(|_| "無法儲存相容關聯")?; }
        let latest = format!("{prefix}\\UserChoiceLatest");
        put(HKEY_CURRENT_USER, &format!("{latest}\\ProgId"), "ProgId", prog).map_err(|_| "無法寫入預設選擇")?;
        put(HKEY_CURRENT_USER, &latest, "Hash", "pending").map_err(|_| "無法寫入預設選擇")?;
        put(HKEY_CURRENT_USER, &latest, "Hash", &choice_hash(ext, "--hash", None)?).map_err(|_| "無法儲存預設選擇")?;
        Ok(())
    })();
    unsafe { let _ = RegCloseKey(key); }
    result
}
fn save_report(folder: &Path, report: &Value) -> Result<(), String> {
    std::fs::write(folder.join("report.json"), serde_json::to_vec_pretty(report).unwrap()).map_err(|_| "無法寫入關聯備份".into())
}
fn backup() -> Result<(PathBuf, Value), String> {
    let root = PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or("找不到使用者資料夾")?).join("VoiceInk Media/association-backups");
    std::fs::create_dir_all(&root).map_err(|_| "無法建立關聯備份")?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| "系統時間不正確")?.as_millis();
    let folder = root.join(format!("{stamp}-{}", std::process::id()));
    std::fs::create_dir(&folder).map_err(|_| "無法建立關聯備份")?;
    let mut entries = Vec::new();
    for (ext, expected) in extensions() {
        entries.push(json!({"extension":ext,"expected":expected,"before":association(&ext),"legacyBefore":legacy_default(&ext)?}));
    }
    let report = json!({"version":1,"player":engine::runtime().join("voiceink-media.exe"),"backup":folder,"entries":entries});
    save_report(&folder, &report)?;
    let output = Command::new("reg.exe").args(["export", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts"])
        .arg(folder.join("file-exts.reg")).arg("/y").creation_flags(0x08000000).output().map_err(|_| "無法備份 Windows 關聯")?;
    if !output.status.success() { return Err("Windows 關聯備份失敗，未切換預設".into()); }
    Ok((folder, report))
}
pub fn defaults() -> Result<usize, String> {
    let _lock = DefaultsLock::acquire()?;
    let formats = extensions();
    if formats.iter().all(|(ext, prog)| association(ext) == *prog) {
        register(false).map_err(|_| "無法登記播放器")?;
        return Ok(formats.len());
    }
    let (folder, mut report) = backup()?;
    register(false).map_err(|_| "無法登記播放器")?;
    put(HKEY_CURRENT_USER, "Software\\VoiceInk\\Media", "DefaultsBackup", &folder.join("report.json").to_string_lossy())
        .map_err(|_| "無法登記關聯備份")?;
    let entries = report["entries"].as_array_mut().unwrap();
    for entry in entries.iter_mut() {
        let ext = entry["extension"].as_str().unwrap(); let prog = entry["expected"].as_str().unwrap();
        let result = put(HKEY_CURRENT_USER, &format!("Software\\Classes\\{ext}"), "", prog)
            .map_err(|_| "無法寫入預設關聯".to_owned()).and_then(|_| set_choice(ext, prog));
        if let Err(error) = result { entry["error"] = json!(error); }
    }
    unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST | SHCNF_FLUSH, None, None); }
    // 跨分鐘或系統同時刷新可使一次寫入失效；只補一次，仍失敗就完整還原。
    for entry in entries.iter_mut() {
        let ext = entry["extension"].as_str().unwrap(); let prog = entry["expected"].as_str().unwrap();
        if association(ext) != prog {
            let result = set_choice(ext, prog);
            entry["retried"] = json!(true);
            if let Err(error) = result { entry["error"] = json!(error); }
            else { entry.as_object_mut().unwrap().remove("error"); }
        }
    }
    unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST | SHCNF_FLUSH, None, None); }
    let mut matched = 0;
    for entry in entries.iter_mut() {
        entry["after"] = json!(association(entry["extension"].as_str().unwrap()));
        if entry["after"] == entry["expected"] { matched += 1; }
    }
    let total = entries.len(); report["matched"] = json!(matched); save_report(&folder, &report)?;
    if matched != total {
        let restored = restore_report(&folder.join("report.json"), true);
        return Err(if restored.is_ok() { "預設切換未完全生效，已還原並保留備份" } else { "預設切換未完全生效，還原失敗；原設定備份已保留" }.into());
    }
    Ok(matched)
}
/// 首次安裝替使用者套用有備份的預設；成功後只重新登記，不再覆蓋後來的選擇。
pub fn initialize() -> Result<(), String> {
    let _lock = DefaultsLock::acquire()?;
    let initialized = defaults_initialized().map_err(|_| "無法讀取初始化狀態")?;
    initialize_with(
        initialized,
        || defaults().map(|_| ()),
        || register(false).map_err(|_| "無法登記播放器".into()),
        || put(HKEY_CURRENT_USER, "Software\\VoiceInk\\Media", INITIALIZED_VALUE, "1")
            .map_err(|_| "無法儲存初始化狀態".into()),
    )
}
pub fn restore_defaults(file: &Path) -> Result<usize, String> {
    let _lock = DefaultsLock::acquire()?;
    restore_report(file, false)
}
fn restore_report(file: &Path, rollback: bool) -> Result<usize, String> {
    if std::fs::metadata(file).map_err(|_| "找不到關聯備份")?.len() > 2 * 1024 * 1024 { return Err("關聯備份過大".into()); }
    let bytes = std::fs::read(file).map_err(|_| "無法讀取關聯備份")?;
    let report: Value = serde_json::from_slice(&bytes).map_err(|_| "關聯備份格式不正確")?;
    let entries = report["entries"].as_array().ok_or("關聯備份格式不正確")?;
    let allowed = extensions();
    let mut seen = std::collections::HashSet::new();
    if report["version"] != 1 || entries.len() != allowed.len() { return Err("關聯備份版本不正確".into()); }
    for entry in entries {
        let ext = entry["extension"].as_str().ok_or("關聯備份格式不正確")?;
        let before = entry["before"].as_str().ok_or("關聯備份格式不正確")?;
        let legacy = &entry["legacyBefore"];
        if !allowed.iter().any(|(e,p)| e == ext && entry["expected"] == *p) || !seen.insert(ext)
            || before.len() > 255 || !before.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
            || (!legacy.is_null() && !legacy.as_str().is_some_and(|v| v.len() <= 32767 && !v.contains('\0'))) { return Err("關聯備份內容不合法".into()); }
    }
    let mut restored = Vec::new();
    let mut failed = false;
    for entry in entries {
        let ext = entry["extension"].as_str().unwrap(); let before = entry["before"].as_str().unwrap();
        // 使用者後來自己選了別的程式就保留，不蓋掉新選擇。
        if association(ext) != entry["expected"].as_str().unwrap() && (!rollback || legacy_default(ext)?.as_deref() != entry["expected"].as_str()) { continue; }
        let result = (|| {
            if let Some(prog) = entry["legacyBefore"].as_str() {
                put(HKEY_CURRENT_USER, &format!("Software\\Classes\\{ext}"), "", prog).map_err(|_| "無法還原預設關聯")?;
            } else { delete_legacy(ext)?; }
            set_choice(ext, if before.is_empty() { "Unknown" } else { before })
        })();
        if result.is_err() { failed = true; } else { restored.push((ext, before)); }
    }
    unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST | SHCNF_FLUSH, None, None); }
    for (ext, before) in &restored {
        let current = association(ext);
        if current != *before && !((current.is_empty() || current == "Unknown") && (before.is_empty() || *before == "Unknown")) {
            return Err("部分預設關聯未還原，原設定備份已保留".into());
        }
    }
    if failed { return Err("部分預設關聯未還原，原設定備份已保留".into()); }
    Ok(restored.len())
}
fn delete_legacy(ext: &str) -> Result<(), String> {
    let mut key = HKEY::default();
    unsafe {
        let opened = RegOpenKeyExW(HKEY_CURRENT_USER, PCWSTR(wide(&format!("Software\\Classes\\{ext}")).as_ptr()), None, KEY_SET_VALUE, &mut key);
        if opened == ERROR_FILE_NOT_FOUND { return Ok(()); }
        opened.ok().map_err(|_| "無法還原預設關聯")?;
        let result = RegDeleteValueW(key, w!("")); let _ = RegCloseKey(key);
        if result == ERROR_FILE_NOT_FOUND { return Ok(()); }
        result.ok().map_err(|_| "無法還原預設關聯".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_lock_serializes_threads_and_is_reentrant() {
        let name=wide(&format!("Local\\VoiceInkMediaDefaults-Test-{}",std::process::id()));
        let first=DefaultsLock::named(&name).unwrap();
        drop(DefaultsLock::named(&name).unwrap());
        let (send,receive)=std::sync::mpsc::channel();
        let thread=std::thread::spawn(move || {
            send.send(false).unwrap();
            let _lock=DefaultsLock::named(&name).unwrap(); send.send(true).unwrap();
        });
        assert!(!receive.recv().unwrap());
        assert!(receive.recv_timeout(std::time::Duration::from_millis(50)).is_err());
        drop(first);
        assert!(receive.recv_timeout(std::time::Duration::from_secs(2)).unwrap());
        thread.join().unwrap();
    }
    #[test]
    fn initialization_failure_can_retry_without_setting_marker() {
        let mut initialized = false;
        let mut default_calls = 0;
        let mut mark_calls = 0;
        let first = initialize_with(
            initialized,
            || { default_calls += 1; Err("mock failure".into()) },
            || panic!("first initialization must apply defaults"),
            || { mark_calls += 1; initialized = true; Ok(()) },
        );
        assert!(first.is_err());
        assert!(!initialized);
        assert_eq!((default_calls, mark_calls), (1, 0));

        initialize_with(
            initialized,
            || { default_calls += 1; Ok(()) },
            || panic!("uninitialized retry must apply defaults"),
            || { mark_calls += 1; initialized = true; Ok(()) },
        ).unwrap();
        assert!(initialized);
        assert_eq!((default_calls, mark_calls), (2, 1));
    }

    #[test]
    fn initialized_choice_only_registers_without_reapplying_defaults() {
        let mut register_calls = 0;
        let mut mark_calls = 0;
        initialize_with(
            true,
            || panic!("a later install must preserve the user's choice"),
            || { register_calls += 1; Ok(()) },
            || { mark_calls += 1; Ok(()) },
        ).unwrap();
        assert_eq!((register_calls, mark_calls), (1, 0));
    }

    #[test]
    fn invalid_backup_cannot_change_associations() {
        let formats = extensions();
        let before: Vec<_> = formats.iter().map(|(ext, _)| association(ext)).collect();
        let mut entries: Vec<_> = formats.iter().map(|(ext, prog)| json!({"extension":ext,"expected":prog,"before":"Unknown","legacyBefore":null})).collect();
        entries.last_mut().unwrap()["extension"] = json!(".txt");
        let file = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("target/invalid-media-backup-{}.json", std::process::id()));
        std::fs::write(&file, serde_json::to_vec(&json!({"version":1,"entries":entries})).unwrap()).unwrap();
        let result = restore_defaults(&file);
        std::fs::remove_file(file).unwrap();
        assert!(result.is_err());
        let after: Vec<_> = formats.iter().map(|(ext, _)| association(ext)).collect();
        assert_eq!(before, after);
    }
}
