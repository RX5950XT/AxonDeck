//! `axondeck-probe search <root> <caseSensitive 0|1> <maxHits> <maxFiles> <maxBytes> <maxMs> <maxLineChars> <skipDirs,...>`：
//! 專案全文搜尋，對照 `src/main/workspace/search.js` 的 `walk`／`scanFile`（同樣的上限、跳過規則與命中格式）。
//!
//! 搜尋字串走 stdin（UTF-8，不經命令列引號）；stdout 一列 JSON `{ hits:[{rel,line,text}], truncated, scanned }`。
//! 快在整檔一次讀進來、不分段 await，大小寫相符時先用 memmem 篩掉沒命中的檔案。取消＝main 砍程序。

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;

#[derive(Serialize)]
struct Hit {
    rel: String,
    line: usize,
    text: String,
}

struct Opts {
    needle: String,
    case_sensitive: bool,
    max_hits: usize,
    max_files: usize,
    max_bytes: u64,
    max_line_chars: usize,
    skip: Vec<String>,
    deadline: Instant,
}

/// search.js 的 walk：readdir 順序深度優先，不追 symlink／junction，跳過 SKIP_DIRS
fn walk(dir: &Path, out: &mut Vec<(PathBuf, u64)>, o: &Opts) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if out.len() >= o.max_files || Instant::now() > o.deadline {
            return;
        }
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if !o.skip.contains(&name) {
                walk(&entry.path(), out, o);
            }
        } else if kind.is_file() {
            // Windows 的 DirEntry::metadata 取自列目錄結果，不必再開一次檔
            out.push((entry.path(), entry.metadata().map_or(0, |m| m.len())));
        }
    }
}

/// search.js 的 trimLine（以字元而非 UTF-16 單位切，不會切出半個 emoji）
fn trim_line(line: &str, at_byte: usize, max: usize) -> String {
    let len = line.chars().count();
    if len <= max {
        return line.to_string();
    }
    let at = line[..at_byte.min(line.len())].chars().count();
    let start = at.saturating_sub(max / 3);
    let body: String = line.chars().skip(start).take(max).collect();
    format!("{}{body}…", if start > 0 { "…" } else { "" })
}

/// 回 None＝二進位檔（含 NUL），跟 JS 一樣整檔不列
fn scan_file(bytes: &[u8], rel: &str, o: &Opts, limit: usize) -> Option<Vec<Hit>> {
    if memchr::memchr(0, bytes).is_some() {
        return None;
    }
    let mut hits = Vec::new();
    if o.case_sensitive && memchr::memmem::find(bytes, o.needle.as_bytes()).is_none() {
        return Some(hits);
    }
    for (index, raw) in bytes.split(|&b| b == b'\n').enumerate() {
        if hits.len() >= limit {
            break;
        }
        let line = String::from_utf8_lossy(raw);
        let at = if o.case_sensitive {
            line.find(&o.needle)
        } else {
            // 小寫後長度可能變（İ → i̇），位置只拿來置中摘要，跟 JS 一樣容許這點偏差
            line.to_lowercase().find(&o.needle)
        };
        if let Some(at) = at {
            let text = line.strip_suffix('\r').unwrap_or(&line);
            hits.push(Hit { rel: rel.to_string(), line: index + 1, text: trim_line(text, at, o.max_line_chars) });
        }
    }
    Some(hits)
}

const HEAD_BYTES: usize = 64 * 1024;

fn read_full(file: &mut std::fs::File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match file.read(&mut buf[filled..])? {
            0 => break,
            n => filled += n,
        }
    }
    Ok(filled)
}

/// 一個檔案：None＝讀不到／太大／二進位（不算 scanned）
fn scan_one(root: &Path, full: &Path, size: u64, o: &Opts, limit: usize) -> Option<Vec<Hit>> {
    if size > o.max_bytes {
        return None;
    }
    let mut file = std::fs::File::open(full).ok()?;
    // 先讀開頭一塊：二進位檔多半一開始就有 NUL，不必整檔讀完
    let mut bytes = vec![0u8; HEAD_BYTES];
    let head = read_full(&mut file, &mut bytes).ok()?;
    bytes.truncate(head);
    if memchr::memchr(0, &bytes).is_some() {
        return None;
    }
    if head == HEAD_BYTES {
        file.take(o.max_bytes + 1 - head as u64).read_to_end(&mut bytes).ok()?;
    }
    if bytes.len() as u64 > o.max_bytes {
        return None;
    }
    scan_file(&bytes, &rel_of(root, full), o, limit)
}

/// 平行讀檔（瓶頸是開檔 I/O 不是比對）。依序領號，命中總數滿了就不再領，
/// 所以比號碼小的檔案一定都做過，照號碼合併＝跟逐檔掃一樣的結果。
/// 外層 None＝沒做到（撞時間或已滿）。
fn scan_all(root: &Path, candidates: &[(PathBuf, u64)], o: &Opts) -> Vec<Option<Option<Vec<Hit>>>> {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};
    let next = AtomicUsize::new(0);
    let total = AtomicUsize::new(0);
    let slots: Vec<Mutex<Option<Option<Vec<Hit>>>>> = candidates.iter().map(|_| Mutex::new(None)).collect();
    let workers = std::thread::available_parallelism().map_or(4, |n| n.get()).min(16);
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                if total.load(Ordering::Relaxed) >= o.max_hits || Instant::now() > o.deadline {
                    return;
                }
                let index = next.fetch_add(1, Ordering::Relaxed);
                let Some((full, size)) = candidates.get(index) else { return };
                let found = scan_one(root, full, *size, o, o.max_hits);
                if let Some(found) = &found {
                    total.fetch_add(found.len(), Ordering::Relaxed);
                }
                *slots[index].lock().unwrap() = Some(found);
            });
        }
    });
    slots.into_iter().map(|slot| slot.into_inner().unwrap()).collect()
}

fn rel_of(root: &Path, full: &Path) -> String {
    full.strip_prefix(root).unwrap_or(full).to_string_lossy().replace('\\', "/")
}

pub fn run(args: &[String]) -> i32 {
    let [root, case_sensitive, max_hits, max_files, max_bytes, max_ms, max_line_chars, skip] = args else {
        eprintln!("usage: axondeck-probe search <root> <0|1> <maxHits> <maxFiles> <maxBytes> <maxMs> <maxLineChars> <skipDirs>");
        return 2;
    };
    let mut query = String::new();
    if std::io::stdin().read_to_string(&mut query).is_err() {
        return 2;
    }
    let query = query.trim();
    let case_sensitive = case_sensitive == "1";
    let o = Opts {
        needle: if case_sensitive { query.to_string() } else { query.to_lowercase() },
        case_sensitive,
        max_hits: max_hits.parse().unwrap_or(200),
        max_files: max_files.parse().unwrap_or(8000),
        max_bytes: max_bytes.parse().unwrap_or(1024 * 1024),
        max_line_chars: max_line_chars.parse().unwrap_or(200),
        skip: skip.split(',').filter(|s| !s.is_empty()).map(str::to_lowercase).collect(),
        deadline: Instant::now() + Duration::from_millis(max_ms.parse().unwrap_or(15_000)),
    };
    if o.needle.is_empty() {
        return 2;
    }
    let root = Path::new(root);
    let mut candidates = Vec::new();
    walk(root, &mut candidates, &o);

    let results = scan_all(root, &candidates, &o);
    let mut hits: Vec<Hit> = Vec::new();
    let mut scanned = 0usize;
    let mut truncated = candidates.len() >= o.max_files;
    for found in results {
        // 沒做到的檔案（撞時間或命中已滿）之後全部都沒做到
        let Some(found) = found else {
            truncated = true;
            break;
        };
        if hits.len() >= o.max_hits {
            truncated = true;
            break;
        }
        let Some(found) = found else { continue };
        scanned += 1;
        let room = o.max_hits - hits.len();
        hits.extend(found.into_iter().take(room));
        if hits.len() >= o.max_hits {
            truncated = true;
        }
    }
    let out = serde_json::json!({ "hits": hits, "truncated": truncated || Instant::now() > o.deadline, "scanned": scanned });
    println!("{out}");
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(needle: &str, case_sensitive: bool) -> Opts {
        Opts {
            needle: needle.to_string(),
            case_sensitive,
            max_hits: 200,
            max_files: 8000,
            max_bytes: 1 << 20,
            max_line_chars: 200,
            skip: vec![],
            deadline: Instant::now() + Duration::from_secs(5),
        }
    }

    #[test]
    fn lines_case_crlf_and_binary() {
        let text = "First NEEDLE\r\nsecond needle\n最後 needle".as_bytes();
        let hits = scan_file(text, "a", &opts("needle", false), 200).unwrap();
        let got: Vec<_> = hits.iter().map(|h| (h.line, h.text.as_str())).collect();
        assert_eq!(got, [(1, "First NEEDLE"), (2, "second needle"), (3, "最後 needle")]);
        assert_eq!(scan_file(text, "a", &opts("NEEDLE", true), 200).unwrap().len(), 1);
        assert!(scan_file(b"needle\n\0", "a", &opts("needle", false), 200).is_none());
    }

    #[test]
    fn trims_long_lines_around_hit() {
        let line = format!("{}中needle{}", "x".repeat(300), "y".repeat(300));
        let at = line.find("中needle").unwrap();
        let out = trim_line(&line, at, 200);
        assert!(out.starts_with('…') && out.ends_with('…') && out.contains("中needle"));
        assert_eq!(out.chars().count(), 202);
    }
}
