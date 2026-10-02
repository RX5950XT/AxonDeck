use serde::Serialize;
use serde_json::Value;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender},
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::{CloseHandle, HANDLE, WAIT_ABANDONED_0, WAIT_OBJECT_0, WAIT_TIMEOUT},
        System::Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject},
    },
};

const MAX_JSON_BYTES: usize = 512 * 1024;
const MAX_HISTORY: usize = 100;
const FLUSH_DELAY: Duration = Duration::from_millis(180);
const CLOSE_WAIT: Duration = Duration::from_millis(350);
const MUTEX_WAIT_MS: u32 = 250;
static FILE_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Preferences {
    pub volume: f64,
    pub width: i32,
    pub height: i32,
    pub queue_width: i32,
    pub window_saved: bool,
}

impl Default for Preferences {
    fn default() -> Self { Self { volume: 80.0, width: 1060, height: 740, queue_width: 276, window_saved: false } }
}

impl Preferences {
    fn sanitize(&mut self) {
        self.volume = sanitize_volume(self.volume);
        self.width = self.width.clamp(640, 2560);
        self.height = self.height.clamp(430, 1440);
        self.queue_width = self.queue_width.clamp(240, 520);
    }
}

fn sanitize_volume(value: f64) -> f64 {
    if value.is_finite() { value.clamp(0.0, 100.0) } else { Preferences::default().volume }
}

#[derive(Debug)]
pub enum Event {
    Ready(Preferences),
    Resume(PathBuf, f64),
    Error(String),
}

enum Command {
    Volume(f64),
    Window(i32, i32),
    QueueWidth(i32),
    Resume(PathBuf),
    Progress(PathBuf, f64, f64),
    Shutdown(SyncSender<()>),
}

pub struct Store {
    pub events: Receiver<Event>,
    send: Sender<Command>,
}

impl Store {
    pub fn start(dir: PathBuf) -> Self {
        let (send, commands) = mpsc::channel();
        let (events, receive) = mpsc::channel();
        let failed = events.clone();
        if thread::Builder::new().name("voiceink-media-preferences".into())
            .spawn(move || run(dir, commands, events)).is_err()
        {
            let _ = failed.send(Event::Error("無法啟動播放器設定背景工作".into()));
            let _ = failed.send(Event::Ready(Preferences::default()));
        }
        Self { events: receive, send }
    }

    pub fn volume(&self, value: f64) { let _ = self.send.send(Command::Volume(value)); }
    pub fn window(&self, width: i32, height: i32) { let _ = self.send.send(Command::Window(width, height)); }
    pub fn queue_width(&self, width: i32) { let _ = self.send.send(Command::QueueWidth(width)); }
    pub fn resume(&self, file: PathBuf) { let _ = self.send.send(Command::Resume(file)); }
    pub fn progress(&self, file: PathBuf, position: f64, duration: f64) {
        let _ = self.send.send(Command::Progress(file, position, duration));
    }
}

impl Drop for Store {
    fn drop(&mut self) {
        let (done, wait) = mpsc::sync_channel(1);
        if self.send.send(Command::Shutdown(done)).is_ok() {
            let _ = wait.recv_timeout(CLOSE_WAIT);
        }
    }
}

#[derive(Clone, Serialize)]
struct Document {
    version: u8,
    preferences: Preferences,
    history: Vec<ResumeRecord>,
}

impl Default for Document {
    fn default() -> Self { Self { version: 1, preferences: Preferences::default(), history: Vec::new() } }
}

#[derive(Clone, serde::Deserialize, Serialize)]
struct ResumeRecord {
    path: String,
    size: u64,
    modified_secs: u64,
    modified_nanos: u32,
    position: f64,
    duration: f64,
    updated: u64,
}

#[derive(Default)]
struct Patch {
    volume: Option<f64>,
    window: Option<(i32, i32)>,
    queue_width: Option<i32>,
    history: Vec<HistoryChange>,
}

struct HistoryChange { key: String, record: Option<ResumeRecord> }

impl Patch {
    fn is_empty(&self) -> bool {
        self.volume.is_none() && self.window.is_none() && self.queue_width.is_none() && self.history.is_empty()
    }

    fn history(&mut self, key: String, record: Option<ResumeRecord>) {
        if let Some(index) = self.history.iter().position(|change| change.key == key) { self.history.remove(index); }
        self.history.push(HistoryChange { key, record });
    }
}

struct Loaded { document: Document, issue: Option<&'static str>, corrupt: bool }

fn run(dir: PathBuf, commands: Receiver<Command>, events: Sender<Event>) {
    let _ = fs::create_dir_all(&dir);
    let dir = fs::canonicalize(&dir).unwrap_or(dir);
    let path = dir.join("preferences.json");
    let lock_name = mutex_name(&dir);
    let initial = with_mutex(&lock_name, || read_document(&path));
    let mut preferences = match initial {
        Ok(loaded) => {
            if let Some(issue) = loaded.issue { send_error(&events, issue); }
            loaded.document.preferences
        }
        Err(error) => { send_error(&events, error); Preferences::default() }
    };
    let _ = events.send(Event::Ready(preferences.clone()));
    let mut patch = Patch::default();

    loop {
        let command = if patch.is_empty() {
            match commands.recv() { Ok(command) => command, Err(_) => break }
        } else {
            match commands.recv_timeout(FLUSH_DELAY) {
                Ok(command) => command,
                Err(RecvTimeoutError::Timeout) => {
                    flush(&path, &lock_name, &mut patch, &events);
                    continue;
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        };

        match command {
            Command::Volume(value) => {
                preferences.volume = sanitize_volume(value);
                patch.volume = Some(preferences.volume);
            }
            Command::Window(width, height) => {
                preferences.width = width.clamp(640, 2560);
                preferences.height = height.clamp(430, 1440);
                preferences.window_saved = true;
                patch.window = Some((preferences.width, preferences.height));
            }
            Command::QueueWidth(width) => {
                preferences.queue_width = width.clamp(240, 520);
                patch.queue_width = Some(preferences.queue_width);
            }
            Command::Progress(file, position, duration) => {
                if let Some((key, record)) = progress_change(&file, position, duration) { patch.history(key, record); }
            }
            Command::Resume(file) => resume(&file, &path, &lock_name, &mut patch, &events),
            Command::Shutdown(done) => {
                flush(&path, &lock_name, &mut patch, &events);
                let _ = done.send(());
                break;
            }
        }
    }
}

fn resume(file: &Path, path: &Path, lock_name: &[u16], patch: &mut Patch, events: &Sender<Event>) {
    if !resumable_media(file) { return; }
    let Some((canonical, key)) = file_key(file) else { return; };
    let stamp = match file_stamp(&canonical) {
        Ok(stamp) => stamp,
        Err(error) => {
            patch.history(key, None);
            send_error(events, error);
            return;
        }
    };
    if !patch.is_empty() { flush(path, lock_name, patch, events); }
    let latest = with_mutex(lock_name, || read_document(path));
    let loaded = match latest {
        Ok(loaded) => loaded,
        Err(error) => { send_error(events, error); return; }
    };
    if let Some(issue) = loaded.issue { send_error(events, issue); }
    if let Some(record) = loaded.document.history.iter().find(|record| path_key(Path::new(&record.path)) == key) {
        if record_matches(record, stamp) {
            let _ = events.send(Event::Resume(file.to_owned(), record.position));
        } else {
            patch.history(key, None);
        }
    }
}

#[derive(Clone, Copy)]
struct FileStamp { size: u64, modified_secs: u64, modified_nanos: u32 }

fn progress_change(file: &Path, position: f64, duration: f64) -> Option<(String, Option<ResumeRecord>)> {
    let (canonical, key) = file_key(file)?;
    if !resumable_media(file) || !valid_position(position, duration) {
        return Some((key, None));
    }
    let stamp = match file_stamp(&canonical) { Ok(stamp) => stamp, Err(_) => return Some((key, None)) };
    let path = canonical.to_string_lossy().into_owned();
    if path.encode_utf16().count() > 32767 { return Some((key, None)); }
    Some((key, Some(ResumeRecord {
        path, size: stamp.size, modified_secs: stamp.modified_secs,
        modified_nanos: stamp.modified_nanos, position, duration, updated: now_nanos(),
    })))
}

fn file_key(file: &Path) -> Option<(PathBuf, String)> {
    if !file.is_absolute() { return None; }
    let canonical = fs::canonicalize(file).unwrap_or_else(|_| file.to_owned());
    if canonical.as_os_str().encode_wide().count() > 32767 { return None; }
    let key = path_key(&canonical);
    Some((canonical, key))
}

fn file_stamp(file: &Path) -> Result<FileStamp, &'static str> {
    let metadata = fs::metadata(file).map_err(|_| "無法檢查媒體檔案，已略過續播")?;
    if !metadata.is_file() { return Err("無法檢查媒體檔案，已略過續播"); }
    let modified = metadata.modified().map_err(|_| "無法檢查媒體檔案，已略過續播")?;
    let elapsed = modified.duration_since(UNIX_EPOCH).map_err(|_| "無法檢查媒體檔案，已略過續播")?;
    Ok(FileStamp { size: metadata.len(), modified_secs: elapsed.as_secs(), modified_nanos: elapsed.subsec_nanos() })
}

fn valid_position(position: f64, duration: f64) -> bool {
    position.is_finite() && duration.is_finite() && position >= 5.0 && duration - position > 5.0
}

fn resumable_media(file: &Path) -> bool {
    matches!(crate::engine::kind(file).as_deref(), Some("video" | "audio"))
}

fn record_matches(record: &ResumeRecord, stamp: FileStamp) -> bool {
    valid_record(record) && record.size == stamp.size && record.modified_secs == stamp.modified_secs
        && record.modified_nanos == stamp.modified_nanos
}

fn valid_record(record: &ResumeRecord) -> bool {
    let path = Path::new(&record.path);
    path.is_absolute() && path.as_os_str().encode_wide().count() <= 32767
        && resumable_media(path)
        && record.modified_nanos < 1_000_000_000 && valid_position(record.position, record.duration)
}

fn path_key(path: &Path) -> String { path.to_string_lossy().replace('/', "\\").to_lowercase() }

fn now_nanos() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|time| time.as_nanos().min(u64::MAX as u128) as u64).unwrap_or(0)
}

fn read_document(path: &Path) -> Result<Loaded, &'static str> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Loaded { document: Document::default(), issue: None, corrupt: false }),
        Err(_) => return Err("無法讀取播放器設定"),
    };
    let mut bytes = Vec::with_capacity(MAX_JSON_BYTES + 1);
    file.take((MAX_JSON_BYTES + 1) as u64).read_to_end(&mut bytes).map_err(|_| "無法讀取播放器設定")?;
    if bytes.len() > MAX_JSON_BYTES {
        return Ok(Loaded { document: Document::default(), issue: Some("設定檔超過大小限制，已改用預設設定"), corrupt: true });
    }
    let value: Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => return Ok(Loaded { document: Document::default(), issue: Some("設定檔格式損毀，已改用預設設定"), corrupt: true }),
    };
    if value.get("version").and_then(Value::as_u64) != Some(1) {
        return Ok(Loaded { document: Document::default(), issue: Some("設定檔版本不支援，已改用預設設定"), corrupt: true });
    }

    let defaults = Preferences::default();
    let values = value.get("preferences");
    let mut preferences = Preferences {
        volume: values.and_then(|v| v.get("volume")).and_then(Value::as_f64).unwrap_or(defaults.volume),
        width: read_dimension(values, "width", defaults.width, 640, 2560),
        height: read_dimension(values, "height", defaults.height, 430, 1440),
        queue_width: read_dimension(values, "queue_width", defaults.queue_width, 240, 520),
        window_saved: values.and_then(|v| v.get("window_saved")).and_then(Value::as_bool)
            .unwrap_or_else(|| values.and_then(Value::as_object).is_some_and(|v| v.contains_key("width") && v.contains_key("height"))),
    };
    preferences.sanitize();

    let mut history = value.get("history").and_then(Value::as_array).into_iter().flatten()
        .filter_map(|entry| serde_json::from_value::<ResumeRecord>(entry.clone()).ok())
        .filter(valid_record).collect::<Vec<_>>();
    history.sort_by(|a, b| b.updated.cmp(&a.updated));
    let mut seen = std::collections::HashSet::new();
    history.retain(|entry| seen.insert(path_key(Path::new(&entry.path))));
    history.truncate(MAX_HISTORY);
    Ok(Loaded { document: Document { version: 1, preferences, history }, issue: None, corrupt: false })
}

fn read_dimension(values: Option<&Value>, field: &str, fallback: i32, min: i32, max: i32) -> i32 {
    values.and_then(|value| value.get(field)).and_then(Value::as_f64)
        .filter(|number| number.is_finite()).unwrap_or(fallback as f64)
        .round().clamp(min as f64, max as f64) as i32
}

fn flush(path: &Path, lock_name: &[u16], patch: &mut Patch, events: &Sender<Event>) {
    if patch.is_empty() { return; }
    let result = with_mutex(lock_name, || {
        let mut loaded = read_document(path)?;
        let issue = loaded.issue;
        if loaded.corrupt { preserve_corrupt(path)?; }
        if let Some(value) = patch.volume { loaded.document.preferences.volume = value; }
        if let Some((width, height)) = patch.window {
            loaded.document.preferences.width = width;
            loaded.document.preferences.height = height;
            loaded.document.preferences.window_saved = true;
        }
        if let Some(width) = patch.queue_width { loaded.document.preferences.queue_width = width; }
        for change in &patch.history {
            loaded.document.history.retain(|entry| path_key(Path::new(&entry.path)) != change.key);
            if let Some(record) = &change.record { loaded.document.history.insert(0, record.clone()); }
        }
        loaded.document.history.truncate(MAX_HISTORY);
        let bytes = encode(&mut loaded.document)?;
        atomic_write(path, &bytes)?;
        Ok(issue)
    });
    match result {
        Ok(issue) => {
            if issue.is_some() { send_error(events, "設定檔已損毀，原檔已保留副本並重新建立"); }
            *patch = Patch::default();
        }
        Err(error) => send_error(events, error),
    }
}

fn encode(document: &mut Document) -> Result<Vec<u8>, &'static str> {
    loop {
        let bytes = serde_json::to_vec(document).map_err(|_| "播放器設定無法整理")?;
        if bytes.len() <= MAX_JSON_BYTES { return Ok(bytes); }
        if document.history.pop().is_none() { return Err("播放器設定超過大小限制，尚未儲存"); }
    }
}

fn preserve_corrupt(path: &Path) -> Result<(), &'static str> {
    let parent = path.parent().ok_or("無法保留損毀設定，未覆寫原檔")?;
    let name = path.file_name().ok_or("無法保留損毀設定，未覆寫原檔")?.to_string_lossy();
    for _ in 0..100 {
        let id = FILE_ID.fetch_add(1, Ordering::Relaxed);
        let backup = parent.join(format!("{name}.corrupt-{}-{}-{id}.bak", std::process::id(), now_nanos()));
        match OpenOptions::new().write(true).create_new(true).open(&backup) {
            Ok(file) => {
                drop(file);
                if fs::copy(path, &backup).is_err()
                    || OpenOptions::new().read(true).write(true).open(&backup).and_then(|file| file.sync_all()).is_err()
                {
                    let _ = fs::remove_file(backup);
                    return Err("無法保留損毀設定，未覆寫原檔");
                }
                return Ok(());
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("無法保留損毀設定，未覆寫原檔"),
        }
    }
    Err("無法保留損毀設定，未覆寫原檔")
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), &'static str> {
    let parent = path.parent().ok_or("無法儲存播放器設定")?;
    let name = path.file_name().ok_or("無法儲存播放器設定")?.to_string_lossy();
    for _ in 0..100 {
        let id = FILE_ID.fetch_add(1, Ordering::Relaxed);
        let temp = parent.join(format!("{name}.tmp-{}-{id}", std::process::id()));
        match OpenOptions::new().write(true).create_new(true).open(&temp) {
            Ok(mut file) => {
                if file.write_all(bytes).and_then(|_| file.sync_all()).is_err() {
                    let _ = fs::remove_file(temp);
                    return Err("無法儲存播放器設定");
                }
                drop(file);
                if fs::rename(&temp, path).is_err() {
                    let _ = fs::remove_file(temp);
                    return Err("無法儲存播放器設定");
                }
                return Ok(());
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("無法儲存播放器設定"),
        }
    }
    Err("無法儲存播放器設定")
}

struct ProcessMutex(HANDLE);

impl ProcessMutex {
    fn acquire(name: &[u16]) -> Result<Self, &'static str> {
        let handle = unsafe { CreateMutexW(None, false, PCWSTR(name.as_ptr())) }.map_err(|_| "無法存取播放器設定")?;
        let result = unsafe { WaitForSingleObject(handle, MUTEX_WAIT_MS) };
        if result.0 != WAIT_OBJECT_0.0 && result.0 != WAIT_ABANDONED_0.0 {
            unsafe { let _ = CloseHandle(handle); }
            return Err(if result.0 == WAIT_TIMEOUT.0 { "播放器設定忙碌，這次變更尚未儲存" } else { "無法存取播放器設定" });
        }
        Ok(Self(handle))
    }
}

impl Drop for ProcessMutex {
    fn drop(&mut self) {
        unsafe { let _ = ReleaseMutex(self.0); let _ = CloseHandle(self.0); }
    }
}

fn with_mutex<T>(name: &[u16], action: impl FnOnce() -> Result<T, &'static str>) -> Result<T, &'static str> {
    let _lock = ProcessMutex::acquire(name)?;
    action()
}

fn mutex_name(dir: &Path) -> Vec<u16> {
    let normalized = dir.to_string_lossy().replace('/', "\\").to_lowercase();
    let mut hash = 0xcbf29ce484222325u64;
    for unit in normalized.encode_utf16() {
        for byte in unit.to_le_bytes() { hash = (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3); }
    }
    format!("Local\\VoiceInkMediaPreferences-{hash:016x}\0").encode_utf16().collect()
}

fn send_error(events: &Sender<Event>, message: &str) { let _ = events.send(Event::Error(message.to_owned())); }

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, time::Instant};

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let id = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let path = std::env::temp_dir().join(format!("voiceink-media-preferences-{}-{id}", std::process::id()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn file(&self) -> PathBuf { self.0.join("sample.mp4") }
    }
    impl Drop for TempDir { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    fn ready(store: &Store) -> Preferences {
        loop {
            match store.events.recv_timeout(Duration::from_secs(2)).expect("設定載入逾時") {
                Event::Ready(prefs) => return prefs,
                Event::Error(_) | Event::Resume(_, _) => {}
            }
        }
    }

    #[test]
    fn clamps_and_reopens_preferences() {
        let temp = TempDir::new();
        let store = Store::start(temp.0.clone());
        assert_eq!(ready(&store), Preferences::default());
        store.volume(150.0);
        store.window(100, 5000);
        store.queue_width(900);
        drop(store);

        let reopened = Store::start(temp.0.clone());
        let prefs = ready(&reopened);
        assert_eq!(prefs.volume, 100.0);
        assert_eq!((prefs.width, prefs.height, prefs.queue_width), (640, 1440, 520));
        assert_eq!(sanitize_volume(f64::NAN), 80.0);
    }
    #[test]
    fn long_history_stays_within_reader_limit() {
        let mut document=Document::default();
        document.history=(0..100).map(|index| ResumeRecord {
            path:format!("C:\\{}-{index}.mp4","a".repeat(20000)),size:1,
            modified_secs:1,modified_nanos:0,position:10.,duration:100.,updated:1
        }).collect();
        let bytes=encode(&mut document).unwrap();
        assert!(bytes.len()<=MAX_JSON_BYTES && document.history.len()<100);
        assert!(!document.history.is_empty());
    }

    #[test]
    fn changed_file_does_not_resume() {
        let temp = TempDir::new();
        let file = temp.file();
        fs::write(&file, b"first version").unwrap();
        let store = Store::start(temp.0.clone());
        let _ = ready(&store);
        store.progress(file.clone(), 10.0, 100.0);
        drop(store);

        let store = Store::start(temp.0.clone());
        let _ = ready(&store);
        store.resume(file.clone());
        assert!(matches!(store.events.recv_timeout(Duration::from_secs(2)), Ok(Event::Resume(_, 10.0))));
        fs::write(&file, b"replacement with a different size").unwrap();
        store.resume(file.clone());
        let deadline = Instant::now() + Duration::from_millis(300);
        while Instant::now() < deadline {
            if matches!(store.events.recv_timeout(Duration::from_millis(25)), Ok(Event::Resume(_, _))) {
                panic!("檔案已變更，不應續播");
            }
        }
        drop(store);

        let reopened = Store::start(temp.0.clone());
        let _ = ready(&reopened);
        reopened.resume(file);
        assert!(!matches!(reopened.events.recv_timeout(Duration::from_millis(300)), Ok(Event::Resume(_, _))));
    }

    #[test]
    fn audio_can_resume() {
        let temp = TempDir::new();
        let file = temp.0.join("sample.mp3");
        fs::write(&file, b"audio bytes").unwrap();
        let store = Store::start(temp.0.clone());
        let _ = ready(&store);
        store.progress(file.clone(), 8.0, 50.0);
        drop(store);

        let reopened = Store::start(temp.0.clone());
        let _ = ready(&reopened);
        reopened.resume(file);
        assert!(matches!(reopened.events.recv_timeout(Duration::from_secs(2)), Ok(Event::Resume(_, 8.0))));
    }

    #[test]
    fn separate_stores_merge_updates() {
        let temp = TempDir::new();
        let first = Store::start(temp.0.clone());
        let second = Store::start(temp.0.clone());
        let _ = ready(&first);
        let _ = ready(&second);
        first.volume(37.0);
        second.queue_width(344);
        drop(first);
        drop(second);

        let reopened = Store::start(temp.0.clone());
        let prefs = ready(&reopened);
        assert_eq!(prefs.volume, 37.0);
        assert_eq!(prefs.queue_width, 344);
    }

    #[test]
    fn corrupt_file_is_backed_up_before_replacement() {
        let temp = TempDir::new();
        let settings = temp.0.join("preferences.json");
        fs::write(&settings, b"preserve this damaged file").unwrap();
        let store = Store::start(temp.0.clone());
        let _ = ready(&store);
        store.volume(45.0);
        drop(store);

        let backup = fs::read_dir(&temp.0).unwrap().filter_map(Result::ok)
            .find(|entry| entry.file_name().to_string_lossy().starts_with("preferences.json.corrupt-"))
            .expect("損毀原檔應有備份").path();
        assert_eq!(fs::read(backup).unwrap(), b"preserve this damaged file");
        let reopened = Store::start(temp.0.clone());
        let prefs = ready(&reopened);
        assert_eq!(prefs.volume, 45.0);
        assert!(!prefs.window_saved);
    }

    #[test]
    fn legacy_window_dimensions_are_treated_as_saved() {
        let temp = TempDir::new();
        fs::write(temp.0.join("preferences.json"),
            br#"{"version":1,"preferences":{"width":1200,"height":800},"history":[]}"#).unwrap();
        let store = Store::start(temp.0.clone());
        let prefs = ready(&store);
        assert_eq!((prefs.width, prefs.height), (1200, 800));
        assert!(prefs.window_saved);
    }
}
