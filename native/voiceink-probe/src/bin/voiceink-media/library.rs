//! 資料夾與播放清單在背景讀取，過期結果由視窗丟掉。
use crate::engine::{kind, local_file};
use crate::ui::wide;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver};
use windows::Win32::UI::Shell::StrCmpLogicalW;
use windows::core::PCWSTR;

pub fn scan(seed: PathBuf) -> Receiver<(PathBuf, Vec<PathBuf>)> {
    let (send, receive) = mpsc::channel();
    std::thread::spawn(move || {
        let category = kind(&seed);
        let files = if category.as_deref() == Some("playlist") { playlist(&seed) } else { siblings(&seed) };
        let _ = send.send((seed, files));
    });
    receive
}
fn siblings(seed: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if let Some(dir) = seed.parent() {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.take(10000).flatten() {
                let file = entry.path();
                if kind(&file) == kind(seed) && local_file(&file) { files.push(file); }
            }
        }
    }
    files.sort_by(|a, b| unsafe {
        StrCmpLogicalW(PCWSTR(wide(&a.file_name().unwrap_or_default().to_string_lossy()).as_ptr()),
            PCWSTR(wide(&b.file_name().unwrap_or_default().to_string_lossy()).as_ptr())).cmp(&0)
    });
    files
}
pub fn playlist(seed: &Path) -> Vec<PathBuf> {
    let Ok(meta) = std::fs::metadata(seed) else { return vec![]; };
    if meta.len() > 2 * 1024 * 1024 { return vec![]; }
    let Ok(text) = std::fs::read_to_string(seed) else { return vec![]; };
    let ext = seed.extension().unwrap_or_default().to_string_lossy().to_ascii_lowercase();
    text.trim_start_matches('\u{feff}').lines().take(10000).filter_map(|line| {
        let line = line.trim();
        let value = if ext == "pls" {
            let (key, value) = line.split_once('=')?;
            if !key.to_ascii_lowercase().starts_with("file") { return None; } value.trim()
        } else if ext == "cue" {
            // ponytail: CUE 先播放整個來源檔；曲目分段需搭配 seek/end offset，尚未實作。
            let value = line.strip_prefix("FILE \"")?; value.split_once('"')?.0
        } else { line };
        if value.is_empty() || value.starts_with('#') || value.contains("://") || value.contains('\0') { return None; }
        let value = value.trim_matches('"');
        let file = seed.parent()?.join(value);
        (local_file(&file) && kind(&file).as_deref() != Some("playlist")).then_some(file)
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_playlist_only() {
        let dir = std::env::temp_dir().join(format!("voiceink-media-playlist-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let audio = dir.join("test.flac"); let list = dir.join("list.m3u8");
        std::fs::write(&audio, b"test").unwrap();
        std::fs::write(&list, "\u{feff}#EXTM3U\nhttps://example.com/test.mp3\nunknown.exe\ntest.flac\n").unwrap();
        assert_eq!(playlist(&list), vec![audio.clone()]);
        for file in [audio, list] { std::fs::remove_file(file).unwrap(); }
        std::fs::remove_dir(dir).unwrap();
    }
}
