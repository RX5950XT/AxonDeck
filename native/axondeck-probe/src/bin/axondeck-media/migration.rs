//! 改名只搬使用者狀態，不修改 Windows 的預設選擇。
use std::path::{Path, PathBuf};
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_NO_MORE_ITEMS, WIN32_ERROR};
use windows::Win32::System::Registry::*;
use crate::ui::wide;

pub const DATA_KEY: &str = "Software\\AxonDeck\\Media";
pub const DATA_DIR: &str = "AxonDeck Media";
// 舊播放器的狀態及關聯備份必須搬過來；新值已存在時保留新值。
const LEGACY_DATA_KEY: &str = "Software\\VoiceInk\\Media";
// 舊資料夾包含原關聯備份與播放進度；改名失敗時繼續用它。
const LEGACY_DATA_DIR: &str = "VoiceInk Media";
// 舊開啟方式項目要清掉，避免顯示失效的 exe。
const LEGACY_APPLICATION: &str = "Software\\Classes\\Applications\\voiceink-media.exe";
// 舊 RegisteredApplications 值名要清掉，顯示名稱改用新名。
const LEGACY_REGISTERED_NAME: &str = "VoiceInk Media";
// 主 App 仍使用舊 userData，播放器從同一份設定讀取主題。
pub const LEGACY_APP_DIR: &str = "voiceink";

pub fn data_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|base| select_dir(Path::new(&base), |from, to| std::fs::rename(from, to)))
}

fn select_dir(base: &Path, rename: impl FnOnce(&Path, &Path) -> std::io::Result<()>) -> PathBuf {
    let current = base.join(DATA_DIR);
    let old = base.join(LEGACY_DATA_DIR);
    if !current.exists() && old.exists() && rename(&old, &current).is_err() { old } else { current }
}

// 登錄檔保留原值；資料夾搬過後，讀取時把備份檔路徑轉到新位置。
pub fn backup_file(file: &Path) -> PathBuf {
    if file.exists() { return file.to_owned(); }
    let Some(base) = std::env::var_os("LOCALAPPDATA") else { return file.to_owned() };
    relocated_backup(file, Path::new(&base))
}

fn relocated_backup(file: &Path, base: &Path) -> PathBuf {
    file.strip_prefix(base.join(LEGACY_DATA_DIR)).ok()
        .map(|rel| base.join(DATA_DIR).join(rel)).filter(|new| new.is_file()).unwrap_or_else(|| file.to_owned())
}

struct Key(HKEY);
impl Drop for Key { fn drop(&mut self) { unsafe { let _ = RegCloseKey(self.0); } } }

fn missing_ok(result: WIN32_ERROR) -> windows::core::Result<()> {
    if result == ERROR_FILE_NOT_FOUND || result == ERROR_PATH_NOT_FOUND { Ok(()) } else { result.ok() }
}

/// 保留所有值的型別（含 DWORD），只補缺少的值；全部寫成功才刪舊 key。
pub fn state(root: HKEY) -> windows::core::Result<()> {
    unsafe {
        let mut old = HKEY::default();
        let opened = RegOpenKeyExW(root, PCWSTR(wide(LEGACY_DATA_KEY).as_ptr()), None, KEY_READ, &mut old);
        if opened == ERROR_FILE_NOT_FOUND || opened == ERROR_PATH_NOT_FOUND { return Ok(()); }
        opened.ok()?;
        let old = Key(old);
        let mut new = HKEY::default();
        RegCreateKeyExW(root, PCWSTR(wide(DATA_KEY).as_ptr()), None, None, REG_OPTION_NON_VOLATILE,
            KEY_QUERY_VALUE | KEY_SET_VALUE, None, &mut new, None).ok()?;
        let new = Key(new);
        copy_values(old.0, new.0)?;
        drop(old);
        missing_ok(RegDeleteTreeW(root, PCWSTR(wide(LEGACY_DATA_KEY).as_ptr())))
    }
}

fn copy_values(old: HKEY, new: HKEY) -> windows::core::Result<()> {
    unsafe {
        let (mut max_name, mut max_data) = (0, 0);
        RegQueryInfoKeyW(old, None, None, None, None, None, None, None,
            Some(&mut max_name), Some(&mut max_data), None, None).ok()?;
        let mut name = vec![0u16; max_name as usize + 1];
        let mut data = vec![0u8; max_data as usize];
        for index in 0.. {
            let (mut chars, mut bytes, mut kind) = (name.len() as u32, data.len() as u32, 0);
            let result = RegEnumValueW(old, index, Some(PWSTR(name.as_mut_ptr())), &mut chars, None,
                Some(&mut kind), Some(data.as_mut_ptr()), Some(&mut bytes));
            if result == ERROR_NO_MORE_ITEMS { return Ok(()); }
            result.ok()?;
            name[chars as usize] = 0;
            let exists = RegQueryValueExW(new, PCWSTR(name.as_ptr()), None, None, None, None);
            if exists == ERROR_FILE_NOT_FOUND {
                RegSetValueExW(new, PCWSTR(name.as_ptr()), None, REG_VALUE_TYPE(kind), Some(&data[..bytes as usize])).ok()?;
            } else { exists.ok()?; }
        }
        unreachable!()
    }
}

pub fn cleanup(root: HKEY) -> windows::core::Result<()> {
    unsafe {
        missing_ok(RegDeleteTreeW(root, PCWSTR(wide(LEGACY_APPLICATION).as_ptr())))?;
        let mut key = HKEY::default();
        let result = RegOpenKeyExW(root, PCWSTR(wide("Software\\RegisteredApplications").as_ptr()), None, KEY_SET_VALUE, &mut key);
        if result == ERROR_FILE_NOT_FOUND || result == ERROR_PATH_NOT_FOUND { return Ok(()); }
        result.ok()?;
        let key = Key(key);
        missing_ok(RegDeleteValueW(key.0, PCWSTR(wide(LEGACY_REGISTERED_NAME).as_ptr())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn directory_move_preserves_backups_and_locked_fallback() {
        let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("target/media-migration-{}", std::process::id()));
        fs::create_dir_all(base.join(LEGACY_DATA_DIR).join("association-backups/123")).unwrap();
        let old_report = base.join(LEGACY_DATA_DIR).join("association-backups/123/report.json");
        fs::write(&old_report, b"original backup").unwrap();
        fs::write(base.join(LEGACY_DATA_DIR).join("preferences.json"), b"original preferences").unwrap();
        let locked = select_dir(&base, |_, _| Err(std::io::ErrorKind::PermissionDenied.into()));
        assert_eq!(locked, base.join(LEGACY_DATA_DIR));
        assert!(old_report.is_file());
        let moved = select_dir(&base, |from, to| fs::rename(from, to));
        assert_eq!(moved, base.join(DATA_DIR));
        assert_eq!(fs::read(relocated_backup(&old_report, &base)).unwrap(), b"original backup");
        assert_eq!(fs::read(moved.join("preferences.json")).unwrap(), b"original preferences");
        fs::create_dir(base.join(LEGACY_DATA_DIR)).unwrap();
        fs::write(base.join(LEGACY_DATA_DIR).join("preferences.json"), b"leave old copy alone").unwrap();
        assert_eq!(select_dir(&base, |_, _| panic!("new directory must not be overwritten")), moved);
        assert_eq!(fs::read(base.join(LEGACY_DATA_DIR).join("preferences.json")).unwrap(), b"leave old copy alone");
        fs::remove_file(moved.join("preferences.json")).unwrap();
        fs::remove_file(moved.join("association-backups/123/report.json")).unwrap();
        fs::remove_dir(moved.join("association-backups/123")).unwrap();
        fs::remove_dir(moved.join("association-backups")).unwrap();
        fs::remove_dir(moved).unwrap();
        fs::remove_file(base.join(LEGACY_DATA_DIR).join("preferences.json")).unwrap();
        fs::remove_dir(base.join(LEGACY_DATA_DIR)).unwrap();
        fs::remove_dir(base).unwrap();
    }

    #[test]
    fn isolated_registry_moves_values_without_overwriting_and_cleans_old_names() {
        // 所有路徑都位於本測試的 key 底下，不碰真正的檔案關聯。
        let test_path = wide(&format!("Software\\AxonDeckMediaMigrationTest-{}", std::process::id()));
        unsafe {
            let mut root = HKEY::default();
            RegCreateKeyExW(HKEY_CURRENT_USER, PCWSTR(test_path.as_ptr()), None, None, REG_OPTION_NON_VOLATILE,
                KEY_ALL_ACCESS, None, &mut root, None).ok().unwrap();
            let root = Key(root);
            crate::registration::put(root.0, LEGACY_DATA_KEY, "DefaultsBackup", "old-report.json").unwrap();
            crate::registration::put(root.0, LEGACY_DATA_KEY, "DefaultsInitialized", "1").unwrap();
            crate::registration::put(root.0, DATA_KEY, "DefaultsBackup", "new-report.json").unwrap();
            let mut old = HKEY::default();
            RegOpenKeyExW(root.0, PCWSTR(wide(LEGACY_DATA_KEY).as_ptr()), None, KEY_SET_VALUE, &mut old).ok().unwrap();
            let old = Key(old);
            RegSetValueExW(old.0, PCWSTR(wide("Initialized").as_ptr()), None, REG_DWORD, Some(&7u32.to_le_bytes())).ok().unwrap();
            drop(old);
            state(root.0).unwrap();
            state(root.0).unwrap();
            let mut text = [0u16; 32]; let mut bytes = size_of_val(&text) as u32;
            RegGetValueW(root.0, PCWSTR(wide(DATA_KEY).as_ptr()), PCWSTR(wide("DefaultsBackup").as_ptr()), RRF_RT_REG_SZ,
                None, Some(text.as_mut_ptr().cast()), Some(&mut bytes)).ok().unwrap();
            assert_eq!(String::from_utf16_lossy(&text[..text.iter().position(|&c| c == 0).unwrap()]), "new-report.json");
            let mut initialized = 0u32; let mut bytes = 4;
            RegGetValueW(root.0, PCWSTR(wide(DATA_KEY).as_ptr()), PCWSTR(wide("Initialized").as_ptr()), RRF_RT_REG_DWORD,
                None, Some((&mut initialized as *mut u32).cast()), Some(&mut bytes)).ok().unwrap();
            assert_eq!(initialized, 7);
            let mut bytes = size_of_val(&text) as u32;
            RegGetValueW(root.0, PCWSTR(wide(DATA_KEY).as_ptr()), PCWSTR(wide("DefaultsInitialized").as_ptr()), RRF_RT_REG_SZ,
                None, Some(text.as_mut_ptr().cast()), Some(&mut bytes)).ok().unwrap();
            assert_eq!(text[0], b'1' as u16);
            assert_eq!(RegOpenKeyExW(root.0, PCWSTR(wide(LEGACY_DATA_KEY).as_ptr()), None, KEY_READ, &mut HKEY::default()), ERROR_FILE_NOT_FOUND);
            crate::registration::put(root.0, LEGACY_APPLICATION, "FriendlyAppName", "old").unwrap();
            crate::registration::put(root.0, "Software\\RegisteredApplications", LEGACY_REGISTERED_NAME, "old").unwrap();
            crate::registration::put(root.0, "Software\\RegisteredApplications", DATA_DIR, "new").unwrap();
            cleanup(root.0).unwrap();
            cleanup(root.0).unwrap();
            assert_eq!(RegOpenKeyExW(root.0, PCWSTR(wide(LEGACY_APPLICATION).as_ptr()), None, KEY_READ, &mut HKEY::default()), ERROR_FILE_NOT_FOUND);
            assert_eq!(RegGetValueW(root.0, PCWSTR(wide("Software\\RegisteredApplications").as_ptr()),
                PCWSTR(wide(LEGACY_REGISTERED_NAME).as_ptr()), RRF_RT_REG_SZ, None, None, None), ERROR_FILE_NOT_FOUND);
            RegGetValueW(root.0, PCWSTR(wide("Software\\RegisteredApplications").as_ptr()),
                PCWSTR(wide(DATA_DIR).as_ptr()), RRF_RT_REG_SZ, None, None, None).ok().unwrap();
            drop(root);
            RegDeleteTreeW(HKEY_CURRENT_USER, PCWSTR(test_path.as_ptr())).ok().unwrap();
        }
    }
}
