//! 獨立 Win32 媒體彈窗。AxonDeck 關閉／當機與播放器互不影響。
#![windows_subsystem = "windows"]
mod engine;
mod ui;
mod registration;
mod migration;
// 保留播放器的 taskbar 身分，讓舊釘選捷徑仍能歸到同一個應用程式。
const MEDIA_APP_ID: windows::core::PCWSTR = windows::core::w!("com.voiceink.media");
mod library;
mod actions;
mod view;
mod menu;
mod queue;
mod preferences;
mod persistence;
#[path = "../axondeck-term/pipe.rs"]
#[allow(dead_code)]
mod pipe;

use engine::{Engine, kind, local_file};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::cell::RefCell;
use std::process::Child;
use std::time::Instant;
use ui::*;
use windows::core::{PCWSTR, w};
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::{Dwm::*, Gdi::*};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::{Controls::*, Controls::Dialogs::*, HiDpi::*, Input::KeyboardAndMouse::*, Shell::*, WindowsAndMessaging::*};

use actions::*;

struct State {
    hwnd: HWND,
    surface: HWND,
    controls: Vec<(u16, HWND)>,
    paint: Paint,
    engine: Option<Engine>,
    files: Vec<PathBuf>,
    index: usize,
    category: String,
    status: String,
    loaded: bool,
    loaded_at: Instant,
    pause: bool,
    duration: f64,
    time: f64,
    volume: f64,
    metadata: Value,
    tracks: Vec<Value>,
    video: Value,
    zoom: f64,
    hwdec: String,
    show_queue: bool,
    menu_window: HWND,
    repeat: bool,
    shuffle: bool,
    mute: bool,
    speed: f64,
    slideshow: bool,
    slide_interval: u64,
    slide_at: Instant,
    show_help: bool,
    topmost: bool,
    chrome_hidden: bool,
    clean_view: bool,
    scrub_time: Option<f64>,
    interacted_at: Instant,
    mouse: POINT,
    actual: bool,
    rotate: i64,
    sub_delay: f64,
    screenshot_result: Option<bool>,
    tips: Vec<Vec<u16>>,
    fullscreen: Option<RECT>,
    converting: Option<(Child, PathBuf, Instant)>,
    temp: Vec<PathBuf>,
    attempted_conversion: bool,
    opened_at: Instant,
    probe_started: Instant,
    probe: Option<PathBuf>,
    probe_action: Option<String>,
    probe_stage: u8,
    probe_wait: f64,
    probe_shots: usize,
    probe_log: Vec<Value>,
    offscreen: bool,
    hidden: bool,
    error: bool,
    scan: Option<std::sync::mpsc::Receiver<(PathBuf, Vec<PathBuf>)>>,
    queue_indices: Vec<usize>,
    queue_query: String,
    queue_width: i32,
    queue_drag: bool,
    queue_tip: Vec<u16>,
    search_at: Option<Instant>,
    default_task: Option<std::sync::mpsc::Receiver<Result<usize,String>>>,
    storage: Option<preferences::Store>,
    settings_ready: bool,
    resume_requested: bool,
    resume_allowed: bool,
    saved_at: Instant,
}
impl State {
    fn get(&self, id: u16) -> HWND { self.controls.iter().find(|(key, _)| *key == id).unwrap().1 }
    fn command(&self, value: Value) { if let Some(engine) = &self.engine { engine.command(value); } }
    fn current(&self) -> Option<&Path> { self.files.get(self.index).map(PathBuf::as_path) }
    fn tag(&self, name: &str) -> Option<&str> {
        self.metadata.as_object()?.iter().find_map(|(key, value)| key.eq_ignore_ascii_case(name).then(|| value.as_str()).flatten())
    }
    fn redraw(&self) { unsafe { let _ = InvalidateRect(Some(self.hwnd), None, false); } }
    fn load(&mut self) {
        self.save_progress(); self.resume_requested=false; self.resume_allowed=true;
        self.loaded = false; self.error = false; self.attempted_conversion = false;
        self.metadata = Value::Null; self.video = Value::Null; self.tracks.clear();
        self.time = 0.; self.duration = 0.; self.scrub_time = None; self.opened_at = Instant::now();
        self.cancel_conversion();
        let Some(file) = self.current().map(Path::to_owned) else { self.status = "開啟檔案，或把檔案拖進來".into(); self.redraw(); return; };
        self.category = kind(&file).unwrap_or_else(|| "audio".into());
        self.status = "正在開啟…".into();
        if self.engine.is_none() { self.fail("解碼器尚未就緒，可從「更多」重新開啟"); return; }
        set_text(self.hwnd, &format!("{} — AxonDeck", file.file_name().unwrap_or_default().to_string_lossy()));
        set_text(self.get(PLAY), if self.category == "image" { if self.slideshow { "暫停輪播" } else { "開始輪播" } } else { "暫停" });
        set_text(self.get(NEXT), if self.category == "image" { "下一張" } else { "下一個" });
        set_text(self.get(PREV), if self.category == "image" { "上一張" } else { "上一個" });
        if self.category != "playlist" {
            if let Some(engine) = &self.engine {
                engine.load(&file, self.category == "image");
                if self.repeat && self.files.len() == 1 && self.category != "image" { self.command(json!(["set_property", "loop-file", "inf"])); }
            }
        }
        self.select_current();
        self.layout(); self.redraw();
        self.slide_at = Instant::now();
    }
    fn cancel_conversion(&mut self) {
        if let Some((mut child, _, _)) = self.converting.take() { let _ = child.kill(); let _ = child.wait(); }
        for file in self.temp.drain(..) { let _ = std::fs::remove_file(file); }
    }
    fn add_files(&mut self, mut files: Vec<PathBuf>) {
        files.retain(|f| local_file(f));
        if files.is_empty() { self.fail("這不是可開啟的本機媒體檔案"); return; }
        self.save_progress(); self.loaded=false;
        self.scan = if files.len() == 1 { Some(library::scan(files[0].clone())) } else { None };
        self.files = files; self.index = 0;
        self.refresh_queue(); self.load();
    }
    fn fail(&mut self, text: &str) { self.status = text.into(); self.error = true; self.layout(); self.redraw(); }
    fn next(&mut self, forward: bool) {
        if self.files.is_empty() { return; }
        self.save_progress(); self.loaded=false;
        self.index = if self.shuffle && forward && self.files.len() > 1 {
            (self.index + 1 + (self.opened_at.elapsed().as_nanos() as usize % (self.files.len() - 1))) % self.files.len()
        } else { (self.index + if forward { 1 } else { self.files.len() - 1 }) % self.files.len() };
        self.load();
    }
    fn action(&mut self, id: u16) {
        self.wake();
        match id {
            OPEN => if let Some(file) = open_dialog(self.hwnd, false) { self.add_files(vec![file]); },
            LIST | QUEUE_CLOSE => { self.show_queue = self.clean_view || !self.show_queue; self.clean_view = false; self.layout(); self.redraw(); },
            MORE => self.menu(),
            QUEUE_FIND => self.find_queue(),
            QUEUE_ADD => if let Some(file)=open_dialog(self.hwnd,false) { self.append_files(vec![file]); },
            QUEUE_REMOVE => self.remove_selected(),
            PREV => self.next(false), NEXT => self.next(true),
            PLAY if self.category == "image" => {
                self.slideshow = !self.slideshow; self.slide_at = Instant::now();
                set_text(self.get(PLAY), if self.slideshow { "暫停輪播" } else { "開始輪播" });
                self.notice(if self.slideshow { "開始輪播" } else { "暫停輪播" });
            },
            PLAY => self.command(json!(["cycle", "pause"])),
            FIT | ACTUAL => {
                for name in ["video-zoom", "video-pan-x", "video-pan-y", "video-align-x", "video-align-y"] { self.command(json!(["set_property", name, 0])); }
                self.command(json!(["set_property", "video-unscaled", if id == ACTUAL { "yes" } else { "no" }]));
                self.notice(if id == ACTUAL { "原始大小 1:1" } else { "適合視窗" });
            },
            ZOOM_IN | ZOOM_OUT if self.category == "image" => self.command(json!(["add", "video-zoom", if id == ZOOM_IN { 0.25 } else { -0.25 }])),
            ROTATE if self.category == "image" => { self.rotate = (self.rotate+90)%360; self.command(json!(["set_property", "video-rotate", self.rotate])); },
            ANIM_PAUSE if self.category == "image" => self.command(json!(["cycle","pause"])),
            FRAME_FORWARD | FRAME_BACK if self.category == "video" => self.command(json!([if id == FRAME_FORWARD { "frame-step" } else { "frame-back-step" }])),
            HELP => { self.show_help = !self.show_help; self.layout(); },
            ESCAPE if self.show_help => { self.show_help = false; self.layout(); },
            ESCAPE if self.fullscreen.is_some() => self.fullscreen(),
            ESCAPE if self.clean_view => { self.clean_view = false; self.layout(); },
            CLEAN_VIEW => { self.clean_view = !self.clean_view; self.layout(); self.notice(if self.clean_view { "純畫面 · Ctrl+H 恢復工具列" } else { "顯示工具列" }); },
            TOP => self.pin(),
            MUTE => self.command(json!(["cycle", "mute"])),
            SPEED => self.speed_menu(),
            SPEED_DOWN | SPEED_UP | SPEED_RESET => self.command(json!(["set_property", "speed", if id == SPEED_RESET { 1. } else { (self.speed + if id == SPEED_UP { 0.25 } else { -0.25 }).clamp(0.25,4.) }])),
            SEEK_BACK | SEEK_FORWARD | SEEK_FAR_BACK | SEEK_FAR_FORWARD if self.category != "image" => {
                self.resume_allowed=false;
                let seconds = match id { SEEK_BACK => -5, SEEK_FORWARD => 5, SEEK_FAR_BACK => -30, _ => 30 };
                self.command(json!(["seek", seconds, "relative+exact"])); self.notice(&format!("{}{seconds} 秒", if seconds > 0 { "+" } else { "" }));
            },
            VOL_UP | VOL_DOWN if self.category != "image" => self.command(json!(["set_property", "volume", (self.volume + if id == VOL_UP { 5. } else { -5. }).clamp(0.,100.)])),
            HOME | END if self.category == "image" && !self.files.is_empty() => { self.index = if id == HOME { 0 } else { self.files.len()-1 }; self.load(); },
            HOME => self.command(json!(["seek",0,"absolute+exact"])),
            END => self.command(json!(["seek", self.duration,"absolute+exact"])),
            REPEAT => { self.repeat = !self.repeat; self.command(json!(["set_property","loop-file", if self.repeat && self.files.len() == 1 && self.category != "image" { "inf" } else { "no" }])); self.notice(if self.repeat { "循環播放：開啟" } else { "循環播放：關閉" }); },
            SHUFFLE => { self.shuffle = !self.shuffle; self.notice(if self.shuffle { "隨機播放：開啟" } else { "隨機播放：關閉" }); },
            SUB_OPEN => if let Some(file) = open_dialog(self.hwnd, true) { self.command(json!(["sub-add", file.to_string_lossy(), "select"])); },
            SUB_OFF => self.command(json!(["set_property","sid","no"])),
            SUB_TOGGLE => self.command(json!(["cycle","sub-visibility"])),
            AUDIO_NEXT | SUB_NEXT => self.command(json!(["cycle", if id == AUDIO_NEXT { "aid" } else { "sid" }])),
            SUB_EARLIER | SUB_LATER => self.command(json!(["add","sub-delay", if id == SUB_LATER { 0.1 } else { -0.1 }])),
            SHOT if self.loaded => if let Some(file) = save_dialog(self.hwnd, self.current()) { self.screenshot(&file); },
            FULL => self.fullscreen(),
            QUEUE => if let Some(index)=self.selected_file() { self.save_progress(); self.loaded=false; self.index=index; self.load(); },
            _ => {}
        }
    }
    fn notice(&self, text: &str) { self.command(json!(["show-text",text,1400])); }
    fn screenshot(&mut self, file: &Path) {
        self.screenshot_result = None;
        if let Some(engine) = &self.engine { engine.request(9000, json!(["screenshot-to-file",file.to_string_lossy(),"subtitles"])); }
    }
    fn wake(&mut self) {
        self.interacted_at = Instant::now();
        if self.chrome_hidden { self.chrome_hidden = false; self.layout(); }
    }
    fn pin(&mut self) {
        self.topmost = !self.topmost;
        unsafe { let _ = SetWindowPos(self.hwnd, Some(if self.topmost { HWND_TOPMOST } else { HWND_NOTOPMOST }),0,0,0,0,SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE); }
        self.notice(if self.topmost { "視窗置頂：開啟" } else { "視窗置頂：關閉" }); self.redraw();
    }
    fn fullscreen(&mut self) {
        unsafe {
            if let Some(area) = self.fullscreen.take() {
                SetWindowLongPtrW(self.hwnd, GWL_STYLE, (WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN | if self.hidden { WINDOW_STYLE(0) } else { WS_VISIBLE }).0 as isize);
                let _ = SetWindowPos(self.hwnd, None, area.left, area.top, area.right-area.left, area.bottom-area.top, SWP_FRAMECHANGED | SWP_NOZORDER | SWP_NOACTIVATE);
            } else {
                let mut area = RECT::default(); let _ = GetWindowRect(self.hwnd, &mut area); self.fullscreen = Some(area);
                let monitor = MonitorFromWindow(self.hwnd, MONITOR_DEFAULTTONEAREST);
                let mut info = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
                let _ = GetMonitorInfoW(monitor, &mut info);
                SetWindowLongPtrW(self.hwnd, GWL_STYLE, (WS_POPUP | WS_CLIPCHILDREN | if self.hidden { WINDOW_STYLE(0) } else { WS_VISIBLE }).0 as isize);
                let r = info.rcMonitor;
                let _ = SetWindowPos(self.hwnd, None, if self.hidden || self.offscreen { area.left } else { r.left }, if self.hidden || self.offscreen { area.top } else { r.top }, r.right-r.left, r.bottom-r.top, SWP_FRAMECHANGED | SWP_NOZORDER | SWP_NOACTIVATE);
            }
        }
        self.layout(); self.redraw();
    }
    fn menu(&mut self) {
        self.wake();
        if unsafe { IsWindow(Some(self.menu_window)) }.as_bool() { unsafe { let _ = PostMessageW(Some(self.menu_window),WM_CLOSE,WPARAM(0),LPARAM(0)); } return; }
        use menu::Entry as E;
        let mut items = vec![E::action(OPEN as usize,"開啟檔案…\tCtrl+O",false),E::separator()];
        let add = |items: &mut Vec<E>, id, label: &str, checked| items.push(E::action(id,label,checked));
        if self.category == "image" {
            for (id,text) in [(FIT,"適合視窗\t0"),(ACTUAL,"原始大小\t1"),(ZOOM_IN,"放大\t+"),(ZOOM_OUT,"縮小\t−"),(ROTATE,"向右旋轉\tR")] { add(&mut items,id as usize,text,match id { FIT => !self.actual && self.zoom == 0., ACTUAL => self.actual, _ => false }); }
            items.push(E::separator()); add(&mut items,PLAY as usize,"自動輪播\tSpace",self.slideshow);
            add(&mut items,ANIM_PAUSE as usize,"暫停 / 播放動畫\tP",self.pause);
            items.push(E::branch("輪播間隔",[1,3,5,10].iter().enumerate().map(|(i,seconds)| E::action(400+i,&format!("{seconds} 秒"),self.slide_interval == *seconds)).collect()));
        } else {
            add(&mut items,PLAY as usize,if self.pause { "播放\tSpace" } else { "暫停\tSpace" },false);
            add(&mut items,MUTE as usize,"靜音\tM",self.mute);
            if self.category == "video" { add(&mut items,FRAME_FORWARD as usize,"下一格\t.",false); add(&mut items,FRAME_BACK as usize,"上一格\t,",false); }
            add(&mut items,REPEAT as usize,"循環播放\tR",self.repeat); add(&mut items,SHUFFLE as usize,"隨機播放\tL",self.shuffle);
            add(&mut items,SPEED as usize,&format!("播放速度 · {}×",self.speed),false);
            let mut sub = vec![E::action(SUB_OPEN as usize,"載入字幕…",false),E::action(SUB_TOGGLE as usize,"顯示 / 隱藏\tV",false),E::action(SUB_OFF as usize,"關閉字幕",false),E::action(SUB_EARLIER as usize,"提前 0.1 秒\tJ",false),E::action(SUB_LATER as usize,"延後 0.1 秒\tK",false)];
            let tracks = |kind: &str| self.tracks.iter().enumerate().take(64).filter(|(_,t)| t["type"] == kind).map(|(i,t)| E::action(300+i,t["title"].as_str().or(t["lang"].as_str()).unwrap_or(kind),t["selected"].as_bool().unwrap_or(false))).collect::<Vec<_>>();
            sub.extend(tracks("sub")); items.push(E::branch("字幕",sub));
            let audio = tracks("audio"); if !audio.is_empty() { items.push(E::branch("音軌",audio)); }
        }
        items.push(E::separator());
        for (id,text,checked) in [(SHOT,"儲存畫面…\tS",false),(TOP,"視窗置頂\tCtrl+T",self.topmost),(LIST,"播放清單\tCtrl+L",self.show_queue),(HELP,"快捷鍵說明\tF1",self.show_help),(CLEAN_VIEW,"純畫面\tCtrl+H",self.clean_view)] { add(&mut items,id as usize,text,checked); }
        items.push(E::separator());
        for (id,text) in [(214,"在檔案總管顯示"),(215,"重新開啟解碼器"),(213,"設為預設開啟程式…")] { add(&mut items,id,text,false); }
        let mut anchor = RECT::default(); unsafe { let _ = GetWindowRect(self.get(MORE),&mut anchor); }
        if !self.offscreen && !self.hidden { unsafe {
            let mut point = POINT::default(); let _ = GetCursorPos(&mut point);
            let mut area = RECT::default(); let _ = GetWindowRect(self.surface,&mut area);
            if PtInRect(&area,point).as_bool() { anchor = rect(point.x,point.y,0,0); }
        } }
        match menu::open(self.hwnd,anchor,items,self.paint.dark,self.paint.scale,self.offscreen || self.hidden) {
            Ok(hwnd) => self.menu_window = hwnd, Err(_) => self.fail("無法開啟操作選單")
        }
    }
    fn speed_menu(&mut self) {
        if self.category=="image" { return; }
        unsafe { if IsWindow(Some(self.menu_window)).as_bool() { let _=DestroyWindow(self.menu_window); } }
        let anchor_control=if unsafe { IsWindowVisible(self.get(SPEED)) }.as_bool() { self.get(SPEED) } else { self.get(MORE) };
        let mut anchor=RECT::default(); unsafe { let _=GetWindowRect(anchor_control,&mut anchor); }
        match menu::open_speed(self.hwnd,anchor,self.paint.dark,self.paint.scale,self.offscreen||self.hidden,self.speed) {
            Ok(hwnd)=>self.menu_window=hwnd,Err(_)=>self.fail("無法開啟播放速度")
        }
    }
    fn menu_action(&mut self, id: u16) {
        match id {
            490..=494 => self.search_edit(id),
            213 => self.begin_defaults(),
            214 => if let Some(file) = self.current() { let _ = std::process::Command::new("explorer.exe").arg(format!("/select,{}",file.display())).spawn(); },
            215 => self.restart(),
            300..=363 => if let Some(track) = self.tracks.get((id-300) as usize) { self.command(json!(["set_property",if track["type"] == "sub" { "sid" } else { "aid" },track["id"]])); },
            400..=403 => { self.slide_interval = [1,3,5,10][(id-400) as usize]; self.notice(&format!("輪播間隔：{} 秒",self.slide_interval)); },
            _ => self.action(id)
        }
    }
    fn restart(&mut self) {
        self.cancel_conversion(); self.engine.take();
        match Engine::start(self.surface.0 as usize) {
            Ok(engine) => { self.engine = Some(engine); self.load(); },
            Err(error) => self.fail(&error)
        }
    }
    fn tick(&mut self) {
        self.tick_queue(); self.tick_preferences();
        if let Some((seed, files)) = self.scan.as_ref().and_then(|receive| receive.try_recv().ok()) {
            self.scan.take();
            if self.current() == Some(seed.as_path()) {
                if files.is_empty() && self.category == "playlist" { self.fail("播放清單裡沒有可開啟的本機檔案"); }
                else if !files.is_empty() {
                    let playlist = self.category == "playlist";
                    self.index = files.iter().position(|f| f == &seed).unwrap_or(0);
                    self.files = files; self.refresh_queue();
                    if playlist { self.load(); } else { self.layout(); }
                }
            }
        }
        let events: Vec<_> = self.engine.as_ref().map(|e| e.events.try_iter().collect()).unwrap_or_default();
        for event in events { self.event(event); }
        if self.slideshow && self.category == "image" && self.loaded && !self.show_help && self.slide_at.elapsed().as_secs() >= self.slide_interval { self.next(true); }
        if self.fullscreen.is_some() {
            let mut point = POINT::default(); unsafe { let _ = GetCursorPos(&mut point); }
            if point != self.mouse { self.mouse = point; self.wake(); }
            let hide = self.interacted_at.elapsed().as_secs_f64() > 2.5 && !self.pause && !self.show_help && !self.show_queue && !self.error && self.scrub_time.is_none();
            if hide != self.chrome_hidden { self.chrome_hidden = hide; self.layout(); }
        }
        if let Some((child, output, started)) = &mut self.converting {
            let ready = child.try_wait();
            if matches!(ready, Ok(Some(_))) {
                let success = matches!(ready, Ok(Some(status)) if status.success()) && output.is_file();
                let (_, output, _) = self.converting.take().unwrap();
                if success { if let Some(engine) = &self.engine { engine.load(&output, true); } }
                else { self.fail("無法讀取這張圖片，檔案可能損壞或格式尚未支援"); }
            } else if started.elapsed().as_secs() > 35 || ready.is_err() {
                self.cancel_conversion(); self.fail("圖片解碼逾時，其他檔案仍可開啟");
            }
        }
        self.probe_tick();
    }
    fn event(&mut self, event: Value) {
        if event["request_id"] == 9000 {
            let success = event["error"] == "success"; self.screenshot_result = Some(success);
            self.notice(if success { "畫面已儲存" } else { "無法儲存畫面，請確認檔案位置" });
        }
        match event["event"].as_str().unwrap_or("") {
            "engine-ready" => { if let Some(engine) = &self.engine { engine.observe(); } },
            "file-loaded" => { if !self.loaded { self.loaded_at = Instant::now(); } self.loaded = true; self.error = false; self.status = "".into(); self.layout(); self.redraw(); },
            "engine-error" => { if !self.error { self.fail("解碼器已停止；可從「更多」重新開啟，AxonDeck 不受影響"); } },
            "end-file" if event["reason"] == "error" => self.fallback(),
            "client-message" if event["args"][0] == "axondeck" => match event["args"][1].as_str() {
                Some("action") => if let Some(id) = event["args"][2].as_str().and_then(|s| s.parse::<u16>().ok()) { self.action(id); },
                _ => {}
            },
            "property-change" => self.property(event["name"].as_str().unwrap_or(""), &event["data"]),
            _ => {}
        }
    }
    fn property(&mut self, name: &str, data: &Value) {
        match name {
            "time-pos" => {
                let previous = self.time as u64;
                self.time = data.as_f64().unwrap_or(0.);
                let held = self.scrub_time.is_some() || unsafe { GetCapture() } == self.get(SEEK);
                if !held && self.duration > 0. { position(self.get(SEEK), (self.time / self.duration * 10000.) as i32); }
                set_text(self.get(STATUS), &format!("{} / {}", clock(self.scrub_time.unwrap_or(self.time)), clock(self.duration)));
                // 只重畫底部時間，不讓每個 time-pos 把整個背景重畫。
                if previous != self.time as u64 { self.redraw_time(); }
            },
            "duration" => {
                self.duration = data.as_f64().unwrap_or(0.);
                if self.duration > 0. {
                    for (message,seconds) in [(TBM_SETLINESIZE,5.),(TBM_SETPAGESIZE,30.)] {
                        let step = (seconds/self.duration*10000.).round().clamp(1.,10000.) as isize;
                        unsafe { SendMessageW(self.get(SEEK),message,None,Some(LPARAM(step))); }
                    }
                }
                self.layout();
            },
            "pause" => {
                self.pause = data.as_bool().unwrap_or(false);
                if self.category != "image" { set_text(self.get(PLAY), if self.pause { "播放" } else { "暫停" }); }
                if self.pause { self.wake(); }
                unsafe { let _ = InvalidateRect(Some(self.get(QUEUE)),None,false); }
            },
            "volume" => {
                let volume=data.as_f64().unwrap_or(80.);
                if self.settings_ready && (self.volume-volume).abs()>0.01 { if let Some(store)=&self.storage { store.volume(volume); } }
                self.volume=volume; position(self.get(VOLUME),self.volume as i32); self.redraw();
            },
            "metadata" => { self.metadata = data.clone(); self.redraw(); },
            "track-list" => {
                self.tracks = data.as_array().cloned().unwrap_or_default();
                if !self.tracks.is_empty() && matches!(self.category.as_str(), "audio" | "video") {
                    self.category = if self.tracks.iter().any(|t| t["type"] == "video" && t["albumart"] != true) { "video" } else { "audio" }.into();
                }
                self.layout(); self.redraw();
            },
            "video-params" => { self.video = data.clone(); self.redraw(); },
            "video-zoom" => { self.zoom = data.as_f64().unwrap_or(0.); if self.loaded { self.notice(&format!("縮放 {:.2}×",2f64.powf(self.zoom))); } self.layout(); },
            "video-unscaled" => { self.actual = data == true || data == "yes"; self.layout(); },
            "video-rotate" => self.rotate = data.as_i64().unwrap_or(0),
            "sub-delay" => { self.sub_delay = data.as_f64().unwrap_or(0.); if self.loaded { self.notice(&format!("字幕延遲 {:+.1} 秒",self.sub_delay)); } },
            "sub-visibility" if self.loaded => self.notice(if data == true { "字幕：顯示" } else { "字幕：隱藏" }),
            "speed" => {
                self.speed = data.as_f64().unwrap_or(1.); set_text(self.get(SPEED),&format!("播放速度 {}×",self.speed));
                unsafe { if IsWindow(Some(self.menu_window)).as_bool() { SendMessageW(self.menu_window,WM_APP+9,Some(WPARAM((self.speed*100.).round().clamp(25.,400.) as usize)),None); } }
                if self.loaded { self.notice(&format!("播放速度 {}×",self.speed)); }
            },
            "mute" => { self.mute = data.as_bool().unwrap_or(false); set_text(self.get(MUTE),if self.mute { "取消靜音" } else { "靜音" }); self.redraw(); },
            "hwdec-current" => self.hwdec = data.as_str().unwrap_or("no").to_owned(),
            "eof-reached" if data.as_bool() == Some(true) && self.loaded && self.category != "image" && self.files.len() > 1 && (self.repeat || self.index + 1 < self.files.len()) => self.next(true),
            _ => {}
        }
    }
    fn fallback(&mut self) {
        if self.category != "image" || self.attempted_conversion { self.fail("無法播放，檔案可能損壞或格式尚未支援"); return; }
        // file-loaded 只代表容器已開啟；轉圖完成前還沒有可用的圖片。
        self.loaded = false; self.video = Value::Null;
        self.attempted_conversion = true;
        let Some(file) = self.current().map(Path::to_owned) else { return; };
        let animated = file.extension().is_some_and(|ext| ["gif", "webp", "apng", "mng", "avif"].iter().any(|name| ext.eq_ignore_ascii_case(name)));
        let output = std::env::temp_dir().join(format!("axondeck-media-{}-{}.{}", std::process::id(), self.index, if animated { "webp" } else { "png" }));
        self.temp.push(output.clone());
        match self.engine.as_ref().and_then(|e| engine::convert(file, output.clone(), e).ok()) {
            Some(child) => { self.converting = Some((child, output, Instant::now())); self.status = "正在解碼圖片…".into(); self.layout(); },
            None => self.fail("圖片解碼器未就緒")
        }
    }
    fn probe_tick(&mut self) {
        if self.probe.is_none() { return; }
        let elapsed = self.probe_started.elapsed().as_secs_f64();
        let ready = self.loaded && self.converting.is_none()
            && (self.category != "image" || (self.video["w"].as_u64().unwrap_or(0) > 0 && self.video["h"].as_u64().unwrap_or(0) > 0));
        if ready && self.probe_action.as_deref() == Some("animation") && self.probe_shots < 12 {
            if self.loaded_at.elapsed().as_secs_f64() >= 0.1 + self.probe_shots as f64 * 0.2 {
                let file = self.probe.as_ref().unwrap().with_extension(format!("{}.png", self.probe_shots));
                self.command(json!(["screenshot-to-file", file.to_string_lossy(), "video"]));
                self.probe_shots += 1;
            }
        }
        if ready && elapsed > 0.8 && self.probe_stage == 0 {
            self.probe_stage = 1;
            match self.probe_action.as_deref() {
                Some("decoder-crash") => if let Some(engine) = &mut self.engine { let _ = engine.child.kill(); },
                Some("pause") => self.command(json!(["set_property", "pause", true])),
                Some("seek") => self.command(json!(["seek", 1., "absolute"])),
                Some("zoom") => self.command(json!(["set_property", "video-zoom", 1.])),
                Some("ui-image") => {
                    for id in [ACTUAL,ZOOM_IN,ROTATE,ANIM_PAUSE,LIST,HELP] { self.action(id); }
                    if let Some(file) = self.probe.as_ref().map(|p| p.with_extension("capture.png")) { self.screenshot(&file); }
                },
                Some("ui-video") | Some("ui-audio") => {
                    self.action(PLAY); self.action(MUTE); self.action(SPEED_UP); self.action(SEEK_FORWARD); self.action(SUB_LATER);
                    self.action(REPEAT); self.action(SHUFFLE); self.action(LIST); self.action(HELP);
                    if self.category == "video" { if let Some(file) = self.probe.as_ref().map(|p| p.with_extension("capture.png")) { self.screenshot(&file); } }
                },
                Some("ui-fullscreen") => self.fullscreen(),
                Some("ui-queue" | "queue-resize") => if self.probe_action.as_deref()==Some("queue-resize") { self.probe_queue_resize(); } else { self.probe_queue(); },
                Some("defaults-close") => {
                    let (send,receive)=std::sync::mpsc::channel(); self.default_task=Some(receive);
                    let delay=std::time::Duration::from_secs_f64(self.probe_wait+1.5);
                    std::thread::spawn(move || { std::thread::sleep(delay); let _=send.send(Ok(0)); });
                },
                Some("preferences-save") => {
                    self.action(PLAY); self.command(json!(["seek",6.,"absolute+exact"])); self.command(json!(["set_property","volume",37.]));
                    unsafe { let _=SetWindowPos(self.hwnd,None,0,0,self.paint.px(820),self.paint.px(540),SWP_NOMOVE|SWP_NOZORDER|SWP_NOACTIVATE); }
                    self.save_window(); self.queue_width=344; if let Some(store)=&self.storage { store.queue_width(344); }
                },
                Some("preferences-read") => self.command(json!(["set_property","pause",true])),
                _ => {}
            }
        }
        if elapsed > 1.6 && self.probe_stage == 1 && self.probe_action.as_deref() == Some("ui-image") {
            self.probe_log.push(json!({"actual":self.actual,"zoom":self.zoom,"rotate":self.rotate,"pause":self.pause,"help":self.show_help,"queue":self.show_queue,"index":self.index}));
            self.action(HELP); self.action(NEXT); self.probe_stage = 2;
        }
        if ready && elapsed > 2.4 && self.probe_stage == 2 && self.probe_action.as_deref() == Some("ui-image") {
            self.probe_log.push(json!({"index":self.index,"loaded":self.loaded}));
            self.action(PREV); self.slide_interval = 1; self.action(PLAY); self.probe_stage = 3;
        }
        if elapsed > 4.4 && self.probe_stage == 3 && self.probe_action.as_deref() == Some("ui-image") {
            self.probe_log.push(json!({"index":self.index,"slideshow":self.slideshow})); self.action(PLAY); self.probe_stage = 4;
        }
        if elapsed > 3.6 && self.probe_stage == 1 && self.probe_action.as_deref() == Some("ui-fullscreen") {
            self.probe_log.push(json!({"full":self.fullscreen.is_some(),"chromeHidden":self.chrome_hidden}));
            self.action(HELP); self.probe_stage = 2;
        }
        if elapsed > 1.6 && self.probe_stage == 1 && self.probe_action.as_deref() == Some("ui-video") {
            self.probe_log.push(json!({"time":self.time})); self.action(FRAME_FORWARD); self.probe_stage = 2;
        }
        if elapsed > 2.4 && self.probe_stage == 2 && self.probe_action.as_deref() == Some("ui-video") {
            self.probe_log.push(json!({"time":self.time})); self.action(FRAME_BACK); self.probe_stage = 3;
        }
        if (ready && elapsed > self.probe_wait && (self.probe_action.as_deref() != Some("animation") || self.probe_shots == 12)) || self.error || elapsed > 40. {
            let decoder = self.engine.as_ref().map(|e| e.child.id());
            let value = json!({"loaded":self.loaded,"error":self.error,"status":self.status,"kind":self.category,
                "time":self.time,"duration":self.duration,"pause":self.pause,"video":self.video,"tracks":self.tracks,
                "pid":std::process::id(),"decoderPid":decoder,"elapsedMs":self.opened_at.elapsed().as_millis(),
                "nativeWindow":self.hwnd.0 as usize,"hidden":self.hidden});
            let mut value = value;
            value["firstLoadedMs"] = json!(self.loaded_at.saturating_duration_since(self.opened_at).as_millis());
            value["zoom"] = json!(self.zoom); value["hwdec"] = json!(self.hwdec);
            value["queueCount"] = json!(self.files.len()); value["index"] = json!(self.index);
            value["mute"] = json!(self.mute); value["speed"] = json!(self.speed); value["rotate"] = json!(self.rotate); value["actual"] = json!(self.actual);
            value["subDelay"] = json!(self.sub_delay); value["help"] = json!(self.show_help); value["queue"] = json!(self.show_queue);
            value["repeat"] = json!(self.repeat); value["shuffle"] = json!(self.shuffle); value["slideshow"] = json!(self.slideshow);
            value["screenshot"] = json!(self.screenshot_result); value["actions"] = json!(self.probe_log); value["chromeHidden"] = json!(self.chrome_hidden);
            value["cleanView"] = json!(self.clean_view);
            value["volume"] = json!(self.volume); value["queueWidth"] = json!(self.queue_width);
            let mut area=RECT::default(); unsafe { let _=GetWindowRect(self.hwnd,&mut area); }
            value["windowSize"] = json!([((area.right-area.left) as f32/self.paint.scale).round() as i32,((area.bottom-area.top) as f32/self.paint.scale).round() as i32]);
            if let Some(path) = self.probe.take() { let _ = std::fs::write(path, value.to_string()); }
            let _ = unsafe { PostMessageW(Some(self.hwnd), WM_CLOSE, WPARAM(0), LPARAM(0)) };
        }
    }
}
impl Drop for State { fn drop(&mut self) {
    self.save_progress(); self.engine.take(); self.cancel_conversion();
    // 視窗與解碼器已關閉；讓背景關聯完成，避免正常關閉中途留下半套設定。
    if let Some(task)=self.default_task.take() { let _=task.recv(); }
} }

fn clock(seconds: f64) -> String { let n = seconds.max(0.) as u64; if n >= 3600 { format!("{}:{:02}:{:02}", n/3600, n/60%60, n%60) } else { format!("{}:{:02}", n/60, n%60) } }
fn open_dialog(parent: HWND, subtitle: bool) -> Option<PathBuf> {
    let mut buffer = [0u16; 32768];
    let filter = wide(if subtitle { "字幕\0*.srt;*.ass;*.ssa;*.vtt;*.sub\0所有檔案\0*.*\0" } else { "媒體檔案\0*.*\0" });
    let mut dialog = OPENFILENAMEW { lStructSize: size_of::<OPENFILENAMEW>() as u32, hwndOwner: parent,
        lpstrFile: windows::core::PWSTR(buffer.as_mut_ptr()), nMaxFile: buffer.len() as u32,
        lpstrFilter: PCWSTR(filter.as_ptr()), Flags: OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR, ..Default::default() };
    if unsafe { GetOpenFileNameW(&mut dialog) }.as_bool() {
        let end = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len()); Some(PathBuf::from(String::from_utf16_lossy(&buffer[..end])))
    } else { None }
}
fn save_dialog(parent: HWND, source: Option<&Path>) -> Option<PathBuf> {
    let mut buffer = [0u16; 32768];
    let name = source.and_then(Path::file_stem).unwrap_or_default().to_string_lossy();
    let initial = wide(&format!("{name}-畫面.png")); let length = initial.len().min(buffer.len()); buffer[..length].copy_from_slice(&initial[..length]);
    let filter = wide("PNG 圖片\0*.png\0");
    let mut dialog = OPENFILENAMEW { lStructSize: size_of::<OPENFILENAMEW>() as u32, hwndOwner: parent,
        lpstrFile: windows::core::PWSTR(buffer.as_mut_ptr()), nMaxFile: buffer.len() as u32, lpstrFilter: PCWSTR(filter.as_ptr()),
        lpstrDefExt: w!("png"), Flags: OFN_OVERWRITEPROMPT|OFN_PATHMUSTEXIST|OFN_NOCHANGEDIR, ..Default::default() };
    if unsafe { GetSaveFileNameW(&mut dialog) }.as_bool() {
        let end = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len()); Some(PathBuf::from(String::from_utf16_lossy(&buffer[..end])))
    } else { None }
}

unsafe extern "system" fn window_proc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    // 底色回呼會在 layout 借用 State 時重入，固定深色不必讀取 State。
    if let Some(result)=queue_background(msg,w,l) { return result; }
    if let Some(result)=slider_notification(msg,l) { return result; }
    if msg==WM_ERASEBKGND { return LRESULT(1); }
    if msg == WM_NCCREATE {
        let cs = unsafe { &*(l.0 as *const CREATESTRUCTW) };
        unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, cs.lpCreateParams as isize); }
    }
    let ptr = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) } as *mut RefCell<State>;
    if ptr.is_null() { return unsafe { DefWindowProcW(hwnd, msg, w, l) }; }
    // Win32 會同步重入 callback；借用中交回預設處理，避免 &mut 同時指向同一份狀態。
    let Ok(mut s) = (unsafe { &*ptr }).try_borrow_mut() else { return unsafe { DefWindowProcW(hwnd, msg, w, l) }; };
    match msg {
        WM_PAINT => { s.draw(); LRESULT(0) },
        WM_PRINTCLIENT => { s.render(HDC(w.0 as _)); LRESULT(0) },
        WM_SIZE => {
            if !s.controls.is_empty() { s.layout(); }
            drop(s);
            unsafe { let _=RedrawWindow(Some(hwnd),None,None,RDW_UPDATENOW|RDW_ALLCHILDREN|RDW_NOERASE); }
            LRESULT(0)
        },
        WM_GETMINMAXINFO => {
            let info = unsafe { &mut *(l.0 as *mut MINMAXINFO) };
            info.ptMinTrackSize = POINT { x: s.paint.px(640), y: s.paint.px(430) }; LRESULT(0)
        },
        WM_TIMER => { s.tick(); LRESULT(0) },
        msg if msg==WM_APP+8 => {
            if l.0==0 && (25..=400).contains(&w.0) && s.category!="image" { s.command(json!(["set_property","speed",w.0 as f64/100.])); }
            LRESULT(0)
        },
        msg if msg==WM_APP+7 && s.probe.is_some() && s.offscreen => { s.queue_drag=w.0!=0; LRESULT(0) },
        WM_COMMAND => { let id = (w.0 & 0xffff) as u16; let notification = (w.0 >> 16) as u16;
            if id==QUEUE_SEARCH { if notification==EN_CHANGE as u16 { s.search_changed(); } return LRESULT(0); }
            if id != QUEUE || notification == LBN_DBLCLK as u16 { s.menu_action(id); } LRESULT(0) },
        WM_HSCROLL => {
            let control = HWND(l.0 as _); let code = w.0 & 0xffff;
            if control == s.get(SEEK) {
                s.resume_allowed=false;
                s.wake();
                let target = slider_pos(control) as f64 / 10000. * s.duration;
                if code == TB_THUMBTRACK as usize {
                    s.scrub_time = Some(target);
                    set_text(s.get(STATUS),&format!("{} / {}",clock(target),clock(s.duration)));
                } else if code != TB_ENDTRACK as usize || s.scrub_time.is_some() {
                    s.scrub_time = None; s.command(json!(["seek", target, "absolute+exact"]));
                }
                s.redraw_time();
            } else if control == s.get(VOLUME) { s.command(json!(["set_property", "volume", slider_pos(control)])); }
            LRESULT(0)
        },
        WM_DRAWITEM => {
            let item = unsafe { &*(l.0 as *const DRAWITEMSTRUCT) };
            if item.CtlID == QUEUE as u32 {
                if let Some((index,file)) = s.queue_indices.get(item.itemID as usize).and_then(|&i| s.files.get(i).map(|f| (i,f))) {
                    let label = file.file_stem().unwrap_or_default().to_string_lossy();
                    let active = index == s.index;
                    let format = file.extension().unwrap_or_default().to_string_lossy().to_uppercase();
                    let detail = if active { format!("{format} · {}",if s.category == "image" { "正在顯示" } else if s.pause { "已暫停" } else { "正在播放" }) } else { format!("{format} 檔案") };
                    s.paint.queue(item,&label,&detail,active);
                }
            } else {
                let active = match item.CtlID as u16 { LIST => s.show_queue, MUTE => s.mute, FIT => !s.actual && s.zoom == 0., ACTUAL => s.actual, _ => false };
                s.paint.button(item,active);
                if s.probe.is_some() && item.CtlID==PLAY as u32 { unsafe {
                    let _=SetPropW(item.hwndItem,w!("AxonDeckPaintedPause"),Some(HANDLE((s.pause as usize+1) as _)));
                } }
            } LRESULT(1)
        },
        WM_NOTIFY => {
            let header = unsafe { &*(l.0 as *const NMHDR) };
            if header.code==TTN_GETDISPINFOW && header.idFrom==s.get(QUEUE).0 as usize { s.queue_tip(unsafe { &mut *(l.0 as *mut NMTTDISPINFOW) }); return LRESULT(0); }
            LRESULT(0)
        },
        WM_CTLCOLORSTATIC | WM_CTLCOLORLISTBOX | WM_CTLCOLOREDIT => {
            let dc = HDC(w.0 as _);
            unsafe { SetTextColor(dc,s.paint.text_color()); SetBkColor(dc,rgb(if s.paint.dark { 0x111417 } else { 0xeef3f0 })); }
            LRESULT(s.paint.background.0 as isize)
        },
        WM_KEYDOWN => {
            if let Some(id) = shortcut(w.0 as u32, unsafe { GetKeyState(VK_CONTROL.0 as i32) } < 0, unsafe { GetKeyState(VK_SHIFT.0 as i32) } < 0, s.category == "image") { s.action(id); }
            LRESULT(0)
        },
        WM_MOUSEWHEEL => {
            let delta = ((w.0 >> 16) as u16 as i16) as f64 / 120.;
            s.command(if s.category == "image" { json!(["add", "video-zoom", delta * 0.15]) } else { json!(["add", "volume", delta * 5.]) }); LRESULT(0)
        },
        WM_CONTEXTMENU => { if HWND(w.0 as _)==s.get(QUEUE_SEARCH) { s.search_menu(); } else { s.menu(); } LRESULT(0) },
        WM_DROPFILES => {
            let drop = HDROP(w.0 as _); let count = unsafe { DragQueryFileW(drop, u32::MAX, None) };
            let mut files = Vec::new();
            for i in 0..count.min(10000) { let mut buffer = [0u16; 32768]; let n = unsafe { DragQueryFileW(drop, i, Some(&mut buffer)) }; files.push(PathBuf::from(String::from_utf16_lossy(&buffer[..n as usize]))); }
            unsafe { DragFinish(drop); }
            if files.len() == 1 && files[0].extension().is_some_and(|e| ["srt","ass","ssa","vtt","sub"].iter().any(|name| e.eq_ignore_ascii_case(name))) {
                s.command(json!(["sub-add",files[0].to_string_lossy(),"select"]));
            } else if s.files.is_empty() { s.add_files(files); } else { s.append_files(files); } LRESULT(0)
        },
        WM_EXITSIZEMOVE => { s.save_window(); LRESULT(0) },
        WM_SETCURSOR => {
            let mut point=POINT::default(); unsafe { let _=GetCursorPos(&mut point); let _=ScreenToClient(hwnd,&mut point); }
            let mut area=RECT::default(); unsafe { let _=GetClientRect(hwnd,&mut area); }
            let edge=area.right-s.queue_width(area.right);
            if s.show_queue && !s.clean_view && (point.x-edge).abs()<=s.paint.px(5) {
                unsafe { if let Ok(cursor)=LoadCursorW(None,IDC_SIZEWE) { SetCursor(Some(cursor)); } } return LRESULT(1);
            }
            drop(s); unsafe { DefWindowProcW(hwnd,msg,w,l) }
        },
        WM_LBUTTONDOWN | WM_MOUSEMOVE | WM_LBUTTONUP | WM_CAPTURECHANGED => {
            let x=l.0 as u16 as i16 as i32;
            let mut area=RECT::default(); unsafe { let _=GetClientRect(hwnd,&mut area); }
            if msg==WM_LBUTTONDOWN && s.show_queue && !s.clean_view && (x-(area.right-s.queue_width(area.right))).abs()<=s.paint.px(5) {
                s.queue_drag=true; unsafe { let _=SetCapture(hwnd); }
            } else if msg==WM_MOUSEMOVE && s.queue_drag {
                let width=((area.right-x) as f32/s.paint.scale).round() as i32; let changed=s.resize_queue_width(width);
                // 合併移動後再借用狀態繪圖；即時畫完整一格，避免連續滑鼠訊息餓死 WM_PAINT。
                drop(s); if changed { unsafe { let _=RedrawWindow(Some(hwnd),None,None,RDW_UPDATENOW|RDW_ALLCHILDREN|RDW_NOERASE); } } return LRESULT(0);
            } else if s.queue_drag && (msg==WM_LBUTTONUP || msg==WM_CAPTURECHANGED) {
                s.queue_drag=false;
                if let Some(store)=&s.storage { store.queue_width(s.queue_width); }
                if msg==WM_LBUTTONUP { unsafe { let _=ReleaseCapture(); } }
            }
            LRESULT(0)
        },
        WM_DPICHANGED => {
            s.paint = Paint::new(s.paint.dark, (w.0 & 0xffff) as f32 / 96.);
            for &(_, control) in &s.controls { unsafe { SendMessageW(control, WM_SETFONT, Some(WPARAM(s.paint.normal.0 as usize)), Some(LPARAM(1))); } }
            unsafe { SendMessageW(s.get(QUEUE),LB_SETITEMHEIGHT,Some(WPARAM(0)),Some(LPARAM(s.paint.px(62) as isize))); }
            let area = unsafe { &*(l.0 as *const RECT) };
            unsafe { let _ = SetWindowPos(hwnd, None, area.left, area.top, area.right-area.left, area.bottom-area.top, SWP_NOZORDER | SWP_NOACTIVATE); }
            s.layout(); s.redraw(); LRESULT(0)
        },
        WM_DESTROY => { unsafe { let _ = KillTimer(Some(hwnd), 1); PostQuitMessage(0); } LRESULT(0) },
        _ => { drop(s); unsafe { DefWindowProcW(hwnd, msg, w, l) } }
    }
}
fn run() -> windows::core::Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.iter().any(|s| s == "--register") { registration::register(args.iter().any(|s| s == "--machine"))?; return Ok(()); }
    if args.iter().any(|s| s == "--unregister") { registration::unregister(args.iter().any(|s| s == "--machine"))?; return Ok(()); }
    if args.iter().any(|s| s == "--initialize") {
        registration::initialize().map_err(|error| windows::core::Error::new(windows::core::HRESULT(0x80004005u32 as i32),error))?; return Ok(());
    }
    if args.iter().any(|s| s == "--defaults") {
        registration::defaults().map_err(|error| windows::core::Error::new(windows::core::HRESULT(0x80004005u32 as i32), error))?;
        return Ok(());
    }
    if let Some(file) = args.iter().find_map(|s| s.strip_prefix("--restore-defaults=")) {
        registration::restore_defaults(Path::new(file)).map_err(|error| windows::core::Error::new(windows::core::HRESULT(0x80004005u32 as i32), error))?;
        return Ok(());
    }
    let flag = |name: &str| args.iter().find_map(|s| s.strip_prefix(name)).map(str::to_owned);
    let saved_theme = std::env::var_os("APPDATA").and_then(|dir| {
        let base = PathBuf::from(dir);
        let old = base.join(migration::LEGACY_APP_DIR);
        let file = if old.exists() { old } else { base.join("axondeck") }.join("config.json");
        if std::fs::metadata(&file).ok()?.len() > 1024 * 1024 { return None; }
        let value: Value = serde_json::from_slice(&std::fs::read(file).ok()?).ok()?;
        value["theme"].as_str().map(str::to_owned)
    });
    let dark = flag("--theme=").or(saved_theme).as_deref() != Some("light"); let hidden = args.iter().any(|s| s == "--hidden");
    let offscreen = args.iter().any(|s| s == "--offscreen");
    let settings_dir=flag("--settings-dir=").map(PathBuf::from).or_else(|| if flag("--probe=").is_none() {
        migration::data_dir()
    } else { None });
    let files: Vec<_> = args.iter().filter(|s| !s.starts_with("--")).map(PathBuf::from).filter(|p| local_file(p)).collect();
    unsafe {
        let _ = SetCurrentProcessExplicitAppUserModelID(MEDIA_APP_ID);
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let _ = InitCommonControlsEx(&INITCOMMONCONTROLSEX { dwSize: size_of::<INITCOMMONCONTROLSEX>() as u32, dwICC: ICC_BAR_CLASSES });
        let instance = GetModuleHandleW(None)?;
        let class = WNDCLASSW { hInstance: instance.into(), lpszClassName: w!("AxonDeckMedia"), lpfnWndProc: Some(window_proc), hCursor: LoadCursorW(None, IDC_ARROW)?, ..Default::default() };
        RegisterClassW(&class);
        let state = Box::new(RefCell::new(State { hwnd: HWND::default(), surface: HWND::default(), controls: vec![], paint: Paint::new(dark, 1.),
            engine: None, files, index: 0, category: "video".into(), status: "".into(), loaded: false, loaded_at: Instant::now(), pause: false,
            duration: 0., time: 0., volume: 80., metadata: Value::Null, tracks: vec![], video: Value::Null, zoom: 0., hwdec: "no".into(),
            show_queue: false, menu_window: HWND::default(), repeat: false, shuffle: false, mute: false, speed: 1., slideshow: false, slide_interval: 3, slide_at: Instant::now(),
            show_help: false, topmost: false, chrome_hidden: false, clean_view: false, scrub_time: None, interacted_at: Instant::now(), mouse: POINT::default(), actual: false, rotate: 0,
            sub_delay: 0., screenshot_result: None, tips: vec![], fullscreen: None, converting: None, temp: vec![], scan: None,
            attempted_conversion: false, opened_at: Instant::now(), probe_started: Instant::now(), probe: flag("--probe=").map(PathBuf::from),
            probe_action: flag("--probe-action="), probe_stage: 0, probe_wait: flag("--probe-wait=").and_then(|v| v.parse().ok()).unwrap_or(2.5), probe_shots: 0, probe_log: vec![], offscreen, hidden, error: false,
            queue_indices:vec![],queue_query:String::new(),queue_width:276,queue_drag:false,queue_tip:vec![],search_at:None,default_task:None,
            storage:settings_dir.map(preferences::Store::start),settings_ready:false,resume_requested:false,resume_allowed:true,saved_at:Instant::now() }));
        let mut s = state.borrow_mut();
        let image = s.files.first().and_then(|p| kind(p)).as_deref() == Some("image");
        let audio = s.files.first().and_then(|p| kind(p)).as_deref() == Some("audio");
        s.hwnd = CreateWindowExW(WS_EX_ACCEPTFILES | if offscreen { WS_EX_TOOLWINDOW } else { WINDOW_EX_STYLE(0) }, w!("AxonDeckMedia"), w!("AxonDeck 媒體"), WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
            CW_USEDEFAULT, CW_USEDEFAULT, if audio { 740 } else if image { 940 } else { 1060 }, if audio { 580 } else { 740 },
            None, None, Some(instance.into()), Some((&*state as *const RefCell<State>).cast()))?;
        s.paint = Paint::new(dark, GetDpiForWindow(s.hwnd) as f32 / 96.);
        let _ = SetWindowPos(s.hwnd, None, if offscreen { -30000 } else { 0 }, if offscreen { -30000 } else { 0 },
            s.paint.px(if audio { 740 } else if image { 940 } else { 1060 }), s.paint.px(if audio { 580 } else { 740 }),
            SWP_NOZORDER | SWP_NOACTIVATE | if offscreen { SET_WINDOW_POS_FLAGS(0) } else { SWP_NOMOVE });
        let dark_value: i32 = if dark { 1 } else { 0 };
        let _ = DwmSetWindowAttribute(s.hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, &dark_value as *const _ as _, 4);
        let caption = rgb(if dark { 0x111417 } else { 0xeef3f0 });
        let _ = DwmSetWindowAttribute(s.hwnd,DWMWA_CAPTION_COLOR,&caption as *const _ as _,4);
        let backdrop: i32 = 2; let _ = DwmSetWindowAttribute(s.hwnd, DWMWA_SYSTEMBACKDROP_TYPE, &backdrop as *const _ as _, 4);
        if let Ok(icon) = LoadImageW(None, PCWSTR(wide(&engine::runtime().join("icon.ico").to_string_lossy()).as_ptr()), IMAGE_ICON, 32, 32, LR_LOADFROMFILE) {
            SendMessageW(s.hwnd, WM_SETICON, Some(WPARAM(ICON_BIG as usize)), Some(LPARAM(icon.0 as isize)));
            SendMessageW(s.hwnd, WM_SETICON, Some(WPARAM(ICON_SMALL as usize)), Some(LPARAM(icon.0 as isize)));
        }
        s.surface = control(s.hwnd, w!("STATIC"), "媒體畫面", 120, WS_CLIPCHILDREN)?;
        let hwnd = s.hwnd;
        for (id, label) in [(QUEUE_CLOSE,"收起播放清單"),(QUEUE_ADD,"加入檔案"),(QUEUE_REMOVE,"從清單移除"),(OPEN,"開啟檔案"),(LIST,"播放清單"),(MORE,"更多"),(PREV,"上一個"),(PLAY,"暫停"),(NEXT,"下一個"),(FIT,"適合視窗"),(FULL,"全螢幕"),
            (MUTE,"靜音"),(SPEED,"播放速度 1×"),(ROTATE,"向右旋轉"),(ACTUAL,"原始大小"),(ZOOM_OUT,"縮小"),(ZOOM_IN,"放大"),(HELP,"快捷鍵說明")] {
            s.controls.push((id, button(hwnd, label, id)?));
        }
        s.controls.push((SEEK, slider(hwnd, "播放進度", SEEK, 10000,dark)?));
        s.controls.push((VOLUME, slider(hwnd, "音量", VOLUME, 100,dark)?));
        s.controls.push((STATUS, control(hwnd, w!("STATIC"), "播放時間", STATUS, WINDOW_STYLE(0x200))?));
        s.controls.push((QUEUE_SEARCH,control(hwnd,w!("EDIT"),"",QUEUE_SEARCH,WS_TABSTOP|WINDOW_STYLE(ES_AUTOHSCROLL as u32))?));
        style_search(s.get(QUEUE_SEARCH));
        SendMessageW(s.get(QUEUE_SEARCH),EM_SETLIMITTEXT,Some(WPARAM(255)),None);
        SendMessageW(s.get(QUEUE_SEARCH),EM_SETCUEBANNER,Some(WPARAM(1)),Some(LPARAM(wide("搜尋檔名 · Ctrl+F").as_ptr() as isize)));
        s.controls.push((QUEUE, control(hwnd, w!("LISTBOX"), "播放清單", QUEUE, WS_TABSTOP | WINDOW_STYLE((LBS_NOTIFY|LBS_OWNERDRAWFIXED|LBS_HASSTRINGS|LBS_NOINTEGRALHEIGHT) as u32))?));
        style_queue(s.get(QUEUE),true);
        SendMessageW(s.get(QUEUE),LB_SETITEMHEIGHT,Some(WPARAM(0)),Some(LPARAM(s.paint.px(62) as isize)));
        let tooltip = CreateWindowExW(WS_EX_TOPMOST,TOOLTIPS_CLASSW,None,WS_POPUP|WINDOW_STYLE(TTS_ALWAYSTIP|TTS_NOPREFIX),CW_USEDEFAULT,CW_USEDEFAULT,CW_USEDEFAULT,CW_USEDEFAULT,Some(hwnd),None,None,None)?;
        SendMessageW(tooltip,TTM_SETMAXTIPWIDTH,None,Some(LPARAM(s.paint.px(300) as isize)));
        for (id,label) in [(QUEUE_ADD,"加入檔案；也可拖入多個檔案"),(QUEUE_REMOVE,"只從清單移除，不刪除檔案 · Delete"),(QUEUE_CLOSE,"收起播放清單"),(OPEN,"開啟檔案 · Ctrl+O"),(LIST,"播放清單 · Ctrl+L"),(MORE,"更多操作"),(PREV,"上一個 · PageUp"),(PLAY,"播放 / 暫停 · Space"),(NEXT,"下一個 · PageDown"),
            (FIT,"適合視窗 · 0"),(FULL,"全螢幕 · F / Enter"),(MUTE,"靜音 · M"),(SPEED,"播放速度滑桿 · [ / ]；Backspace 恢復 1×"),(ROTATE,"向右旋轉 · R"),(ACTUAL,"原始大小 · 1"),(ZOOM_OUT,"縮小 · −"),(ZOOM_IN,"放大 · +"),(HELP,"快捷鍵說明 · F1")] {
            s.tips.push(wide(label));
            let tool = TTTOOLINFOW { cbSize: size_of::<TTTOOLINFOW>() as u32, uFlags: TTF_IDISHWND|TTF_SUBCLASS, hwnd, uId: s.get(id).0 as usize,
                lpszText: windows::core::PWSTR(s.tips.last_mut().unwrap().as_mut_ptr()), ..Default::default() };
            SendMessageW(tooltip,TTM_ADDTOOLW,None,Some(LPARAM(&tool as *const _ as isize)));
        }
        let tool=TTTOOLINFOW { cbSize:size_of::<TTTOOLINFOW>() as u32,uFlags:TTF_IDISHWND|TTF_SUBCLASS,hwnd,uId:s.get(QUEUE).0 as usize,
            lpszText:windows::core::PWSTR(-1isize as _),..Default::default() };
        SendMessageW(tooltip,TTM_ADDTOOLW,None,Some(LPARAM(&tool as *const _ as isize)));
        for &(_, control) in &s.controls {
            SendMessageW(control, WM_SETFONT, Some(WPARAM(s.paint.normal.0 as usize)), Some(LPARAM(1)));
            let _ = SetWindowTheme(control, if dark { w!("DarkMode_Explorer") } else { w!("Explorer") }, None);
        }
        position(s.get(VOLUME), 80);
        SendMessageW(s.get(VOLUME),TBM_SETLINESIZE,None,Some(LPARAM(5)));
        SendMessageW(s.get(VOLUME),TBM_SETPAGESIZE,None,Some(LPARAM(10)));
        let startup = Engine::start(s.surface.0 as usize);
        let startup_error = startup.as_ref().err().cloned();
        if let Ok(engine) = startup { s.engine = Some(engine); }
        s.command(json!(["set_property", "volume", if s.probe.is_some() && s.storage.is_none() { 0 } else { 80 }]));
        if s.probe.is_some() && s.storage.is_some() { s.command(json!(["set_property","mute",true])); }
        let initial = std::mem::take(&mut s.files);
        if initial.is_empty() { s.load(); } else { s.add_files(initial); }
        if s.probe_action.as_deref()==Some("preferences-read") { s.command(json!(["set_property","pause",true])); }
        if let Some(error) = startup_error { s.fail(&error); }
        s.layout();
        SetTimer(Some(s.hwnd), 1, 100, None);
        if !hidden { let _ = ShowWindow(s.hwnd, if offscreen { SW_SHOWNOACTIVATE } else { SW_SHOW }); }
        let hwnd = s.hwnd;
        drop(s);
        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).0 > 0 {
            if menu::dispatch(&message) { continue; }
            // 全域快捷鍵先處理；按鈕 Space、清單／滑桿箭頭保留原生操作。
            let code = message.wParam.0 as u32;
            if message.message == WM_KEYDOWN && GetKeyState(VK_MENU.0 as i32) >= 0 {
                let mut s = state.borrow_mut();
                if message.hwnd==s.get(QUEUE_SEARCH) && code==0x41 && GetKeyState(VK_CONTROL.0 as i32)<0 { s.search_edit(494); continue; }
                if message.hwnd==s.get(QUEUE_SEARCH) && GetKeyState(VK_CONTROL.0 as i32)>=0 {
                    if code==0x1b { set_text(s.get(QUEUE_SEARCH),""); s.queue_query.clear(); s.refresh_queue(); if !s.offscreen && !s.hidden { let _=SetFocus(Some(s.get(QUEUE))); } continue; }
                    drop(s); let _=TranslateMessage(&message); DispatchMessageW(&message); continue;
                }
                let arrows = matches!(code,0x21..=0x28);
                let native = (message.hwnd == s.get(QUEUE) || message.hwnd == s.get(SEEK) || message.hwnd == s.get(VOLUME)) && arrows;
                if message.hwnd == s.get(QUEUE) && code == 0x0d { s.action(QUEUE); continue; }
                if message.hwnd==s.get(QUEUE) && code==0x2e { s.remove_selected(); continue; }
                if message.hwnd==s.get(QUEUE_SEARCH) && shortcut(code,true,false,s.category=="image").is_none() { drop(s); let _=TranslateMessage(&message); DispatchMessageW(&message); continue; }
                if !native { if let Some(id) = shortcut(code,GetKeyState(VK_CONTROL.0 as i32)<0,GetKeyState(VK_SHIFT.0 as i32)<0,s.category == "image") { s.action(id); continue; } }
            }
            if !IsDialogMessageW(hwnd, &message).as_bool() { let _ = TranslateMessage(&message); DispatchMessageW(&message); }
        }
    }
    Ok(())
}
fn main() {
    if let Err(_) = run() { std::process::exit(1); }
}
