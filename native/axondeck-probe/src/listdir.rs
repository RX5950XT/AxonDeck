//! `axondeck-probe list-dir <path>`：檔案頁列一層資料夾，對照 `src/main/explorer/fs.js` 的
//! `readDirectoryEntries`（readdir＋逐檔 lstat＋殼層 sidecar 問隱藏屬性，三趟）。
//!
//! Windows 列目錄（FindFirstFile）本身就帶大小、修改時間與屬性，`DirEntry::metadata` 不必再開檔，
//! 一趟拿齊；只有連結才另外跟過去看是不是資料夾。stdout 一列 JSON 陣列；讀不到資料夾 exit 1、不輸出。

use std::os::windows::fs::MetadataExt;
use std::path::Path;
use std::time::UNIX_EPOCH;

const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;

fn entry_json(dir: &Path, entry: &std::fs::DirEntry) -> serde_json::Value {
    let name = entry.file_name().to_string_lossy().into_owned();
    let meta = entry.metadata().ok();
    // junction 也算連結（std 把 name-surrogate reparse point 當 symlink），跟 Node 的 lstat 一致
    let link = meta.as_ref().is_some_and(|m| m.file_type().is_symlink());
    let dir_flag = if link {
        std::fs::metadata(dir.join(&name)).is_ok_and(|m| m.is_dir())
    } else {
        meta.as_ref().is_some_and(|m| m.is_dir())
    };
    let size = if dir_flag { 0 } else { meta.as_ref().map_or(0, |m| m.len()) };
    let mtime_ms = meta
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
    let hidden = meta.as_ref().is_some_and(|m| m.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0);
    serde_json::json!({ "name": name, "dir": dir_flag, "link": link, "size": size, "mtimeMs": mtime_ms, "hidden": hidden })
}

pub fn run(args: &[String]) -> i32 {
    let [dir] = args else {
        eprintln!("usage: axondeck-probe list-dir <path>");
        return 2;
    };
    let dir = Path::new(dir);
    let Ok(entries) = std::fs::read_dir(dir) else { return 1 };
    // 單筆讀不到（權限、瞬間消失）就跳過，跟 readdir 一樣列得出的才列
    let rows: Vec<_> = entries.flatten().map(|entry| entry_json(dir, &entry)).collect();
    println!("{}", serde_json::Value::Array(rows));
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_files_dirs_and_sizes() {
        let root = std::env::temp_dir().join(format!("axondeck-listdir-{}", std::process::id()));
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("a.txt"), b"hello").unwrap();
        let rows: Vec<_> = std::fs::read_dir(&root).unwrap().flatten().map(|e| entry_json(&root, &e)).collect();
        std::fs::remove_file(root.join("a.txt")).unwrap();
        std::fs::remove_dir(root.join("sub")).unwrap();
        std::fs::remove_dir(&root).unwrap();
        let file = rows.iter().find(|r| r["name"] == "a.txt").unwrap();
        assert_eq!((file["dir"].as_bool(), file["size"].as_u64(), file["link"].as_bool()), (Some(false), Some(5), Some(false)));
        assert!(file["mtimeMs"].as_f64().unwrap() > 1.6e12);
        let sub = rows.iter().find(|r| r["name"] == "sub").unwrap();
        assert_eq!((sub["dir"].as_bool(), sub["size"].as_u64()), (Some(true), Some(0)));
    }
}
