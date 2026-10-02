//! 解碼程序只拿本機路徑，不跑使用者設定、腳本或網路播放清單。
use serde_json::{Value, json};
use crate::pipe::Pipe;
use std::sync::Arc;
use std::os::windows::{io::AsRawHandle, process::CommandExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::{Duration, Instant};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::JobObjects::*;

pub fn formats() -> &'static Value {
    static FORMATS: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    FORMATS.get_or_init(|| serde_json::from_str(include_str!("../../../../../src/main/media-formats.json")).expect("embedded format list"))
}
pub fn kind(file: &Path) -> Option<String> {
    let ext = file.extension()?.to_str()?.to_ascii_lowercase();
    formats().as_object()?.iter().find_map(|(k, list)| {
        list.as_array()?.iter().any(|e| e.as_str() == Some(&ext)).then(|| k.clone())
    })
}
pub fn local_file(file: &Path) -> bool {
    file.is_absolute() && file.is_file() && kind(file).is_some()
}
pub fn runtime() -> PathBuf {
    std::env::current_exe().expect("executable path").parent().unwrap().to_owned()
}

pub struct Engine {
    pub child: Child,
    pub events: Receiver<Value>,
    commands: Sender<Value>,
    job: HANDLE,
}
impl Engine {
    pub fn start(wid: usize) -> Result<Self, String> {
        let pipe = format!(r"\\.\pipe\voiceink-media-{}-{}", std::process::id(), wid);
        let job = unsafe { CreateJobObjectW(None, None) }.map_err(|_| "無法隔離解碼程序")?;
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let set = unsafe { SetInformationJobObject(job, JobObjectExtendedLimitInformation,
            &limits as *const _ as _, size_of_val(&limits) as u32) };
        if set.is_err() { unsafe { let _ = CloseHandle(job); } return Err("無法隔離解碼程序".into()); }
        let mut command = Command::new(runtime().join("mpv.exe"));
        command.args(["--no-config", "--load-scripts=no", "--osc=no", "--input-default-bindings=no",
            "--input-vo-keyboard=yes", "--input-cursor=yes", "--idle=yes", "--keep-open=yes",
            "--force-window=yes", "--hwdec=auto-safe", "--vo=gpu-next", "--gpu-api=d3d11",
            "--audio-display=embedded-first", "--image-display-duration=inf", "--terminal=no",
            "--autoload-files=no", "--demuxer-lavf-o=protocol_whitelist=[file,pipe,data]",
            "--ytdl=no", "--access-references=no", "--demuxer-max-bytes=32MiB", "--demuxer-max-back-bytes=16MiB" ]).arg(format!("--input-ipc-server={pipe}")).arg(format!("--wid={wid}"))
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).creation_flags(0x08000000);
        if let Some(log) = std::env::var_os("VOICEINK_MEDIA_TRACE") { command.arg(format!("--log-file={}", log.to_string_lossy())).arg("--msg-level=all=debug"); }
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(_) => { unsafe { let _ = CloseHandle(job); } return Err("找不到媒體解碼器，請重新安裝 VoiceInk".into()); }
        };
        if unsafe { AssignProcessToJobObject(job, HANDLE(child.as_raw_handle())) }.is_err() {
            let _ = child.kill(); let _ = child.wait(); unsafe { let _ = CloseHandle(job); }
            return Err("無法隔離解碼程序".into());
        }
        let (commands, receive) = mpsc::channel();
        let (send, events) = mpsc::sync_channel(256);
        std::thread::spawn(move || {
            let start = Instant::now();
            let file = loop {
                if let Ok(file) = Pipe::open(&pipe) { break Arc::new(file); }
                if start.elapsed() > Duration::from_secs(8) {
                    let _ = send.send(json!({"event":"engine-error"})); return;
                }
                std::thread::sleep(Duration::from_millis(30));
            };
            let writer = Arc::clone(&file);
            std::thread::spawn(move || write_commands(writer, receive));
            let _ = send.send(json!({"event":"engine-ready"}));
            // 有界讀行：異常 decoder 不准把 UI 的記憶體填滿。
            let mut buffer = [0u8; 8192];
            let mut pending = Vec::new();
            loop {
                let count = file.read(&mut buffer);
                if count == 0 { break; }
                pending.extend_from_slice(&buffer[..count]);
                if pending.len() > 1024 * 1024 { break; }
                while let Some(end) = pending.iter().position(|b| *b == b'\n') {
                    let line: Vec<_> = pending.drain(..=end).collect();
                    if let Ok(event) = serde_json::from_slice(&line) { if send.send(event).is_err() { return; } }
                }
            }
            let _ = send.send(json!({"event":"engine-error"}));
        });
        Ok(Self { child, events, commands, job })
    }
    pub fn command(&self, command: Value) { self.request(0, command); }
    pub fn request(&self, id: u64, command: Value) { let _ = self.commands.send(json!({"command":command,"request_id":id})); }
    pub fn observe(&self) {
        for (id, name) in ["time-pos", "duration", "pause", "volume", "metadata", "track-list", "video-params", "video-zoom", "hwdec-current", "eof-reached", "speed", "mute", "video-unscaled", "video-rotate", "sub-delay", "sub-visibility"].iter().enumerate() {
            self.command(json!(["observe_property", id + 1, name]));
        }
    }
    pub fn load(&self, file: &Path, image: bool) {
        self.command(json!(["define-section", "voiceink", crate::actions::bindings(image), "force"]));
        self.command(json!(["enable-section", "voiceink"]));
        // WebP 的 FFmpeg demuxer 無法可靠倒帶；原生 playlist 循環會重新讀檔，長動畫也不必整份留在 RAM。
        self.command(json!(["set_property", "loop-file", "no"]));
        self.command(json!(["set_property", "loop-playlist", if image { "inf" } else { "no" }]));
        self.command(json!(["set_property", "keep-open", if image { "no" } else { "yes" }]));
        self.command(json!(["set_property", "video-zoom", 0]));
        self.command(json!(["set_property", "video-pan-x", 0]));
        self.command(json!(["set_property", "video-pan-y", 0]));
        self.command(json!(["set_property", "video-align-x", 0]));
        self.command(json!(["set_property", "video-align-y", 0]));
        self.command(json!(["set_property", "video-unscaled", "no"]));
        self.command(json!(["set_property", "video-rotate", 0]));
        self.command(json!(["set_property", "sub-delay", 0]));
        self.command(json!(["loadfile", file.to_string_lossy(), "replace"]));
        self.command(json!(["set_property", "pause", false]));
    }
    pub fn attach(&self, child: &Child) -> bool {
        unsafe { AssignProcessToJobObject(self.job, HANDLE(child.as_raw_handle())) }.is_ok()
    }
}
fn write_commands(file: Arc<Pipe>, commands: Receiver<Value>) {
    for command in commands {
        if !file.write_all(format!("{command}\n").as_bytes()) { break; }
    }
}
impl Drop for Engine {
    fn drop(&mut self) {
        // UI 正常關閉與被強制結束都會關掉 job，decoder／轉圖不留孤兒。
        unsafe { let _ = CloseHandle(self.job); }
        let _ = self.child.wait();
    }
}

/// mpv 支援的圖直接開；RAW／PSD／SVG 等轉 PNG。只碰本輪建立的檔案。
pub fn convert(file: PathBuf, output: PathBuf, engine: &Engine) -> Result<Child, String> {
    let animated = output.extension().is_some_and(|ext| ext == "webp");
    let mut command = Command::new(runtime().join("magick.exe"));
    command.env("MAGICK_CONFIGURE_PATH", runtime()).env("MAGICK_TEMPORARY_PATH", output.parent().unwrap())
        .args(["-limit", "memory", "256MiB", "-limit", "map", "512MiB", "-limit", "disk", "1GiB",
            "-limit", "time", "30", "-limit", "thread", "2"])
        .arg(format!("{}{}{}", if file.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("svg") || ext.eq_ignore_ascii_case("svgz")) { "MSVG:" } else { "" }, file.to_string_lossy(), if animated { "" } else { "[0]" })).args(["-auto-orient", "-strip"]);
    if animated { command.args(["-coalesce", "-define", "webp:lossless=true"]); }
    else { command.args(["-define", "png:compression-level=1"]); }
    command.arg(format!("{}:{}", if animated { "WEBP" } else { "PNG" }, output.to_string_lossy())).stdin(Stdio::null()).stdout(Stdio::null())
        .stderr(Stdio::null()).creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|_| "圖片解碼器尚未安裝")?;
    if !engine.attach(&child) { let _ = child.kill(); let _ = child.wait(); return Err("無法隔離圖片解碼器".into()); }
    Ok(child)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn format_and_path_boundary() {
        for (file, expected) in [("C:/x.WEBP", "image"), ("C:/x.CR3", "image"), ("C:/x.mkv", "video"), ("C:/x.flac", "audio"), ("C:/x.m3u8", "playlist")] {
            assert_eq!(kind(Path::new(file)).as_deref(), Some(expected));
        }
        for file in ["https://example.com/x.mp4", "x.mp4", "C:/x.exe"] { assert!(!local_file(Path::new(file))); }
    }
}
