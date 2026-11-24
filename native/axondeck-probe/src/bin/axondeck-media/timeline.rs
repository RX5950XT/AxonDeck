//! 時間軸體驗：懸停時間泡泡、章節、剩餘時間、媒體鍵（對齊 YouTube／IINA／uosc 的習慣）。
use crate::*;

const TIP_ID: usize = 1;
pub const CHAPTER_MENU: usize = 500;

/// 跟著滑鼠走的時間泡泡；建立失敗只是少了泡泡，不影響播放。
pub fn seek_tip(owner: HWND) -> HWND {
    unsafe {
        let Ok(tip) = CreateWindowExW(WS_EX_TOPMOST, TOOLTIPS_CLASSW, None, WS_POPUP | WINDOW_STYLE(TTS_NOPREFIX | TTS_ALWAYSTIP),
            CW_USEDEFAULT, CW_USEDEFAULT, CW_USEDEFAULT, CW_USEDEFAULT, Some(owner), None, None, None) else { return HWND::default(); };
        let mut empty = wide("");
        let tool = TTTOOLINFOW { cbSize: size_of::<TTTOOLINFOW>() as u32, uFlags: TTF_TRACK | TTF_ABSOLUTE, hwnd: owner, uId: TIP_ID,
            lpszText: windows::core::PWSTR(empty.as_mut_ptr()), ..Default::default() };
        SendMessageW(tip, TTM_ADDTOOLW, None, Some(LPARAM(&tool as *const _ as isize)));
        tip
    }
}
/// Windows 媒體鍵（視窗有焦點時）對應到播放器動作。
pub fn app_command(command: u32) -> Option<u16> {
    Some(match command { 14 => PLAY, 46 => PLAY_ONLY, 47 => PAUSE_ONLY, 13 => STOP, 11 => NEXT, 12 => PREV, 49 => SEEK_FORWARD, 50 => SEEK_BACK, _ => return None })
}

impl State {
    pub fn seek_hover(&mut self, value: Option<i32>) {
        let mut tool = TTTOOLINFOW { cbSize: size_of::<TTTOOLINFOW>() as u32, hwnd: self.hwnd, uId: TIP_ID, ..Default::default() };
        let Some(value) = value.filter(|_| self.duration > 0. && self.category != "image") else {
            unsafe { SendMessageW(self.seek_tip, TTM_TRACKACTIVATE, Some(WPARAM(0)), Some(LPARAM(&tool as *const _ as isize))); }
            return;
        };
        let time = value as f64 / 10000. * self.duration;
        self.seek_tip_label = match self.chapter_at(time) { Some(name) => format!("{} · {name}", clock(time)), None => clock(time) };
        // 測試視窗在螢幕外或隱藏時只算文字，不在使用者畫面上冒泡泡。
        if self.seek_tip.is_invalid() || self.hidden || self.offscreen { return; }
        self.seek_tip_text = wide(&self.seek_tip_label);
        tool.lpszText = windows::core::PWSTR(self.seek_tip_text.as_mut_ptr());
        unsafe {
            SendMessageW(self.seek_tip, TTM_UPDATETIPTEXTW, None, Some(LPARAM(&tool as *const _ as isize)));
            let size = SendMessageW(self.seek_tip, TTM_GETBUBBLESIZE, None, Some(LPARAM(&tool as *const _ as isize))).0;
            let (width, height) = ((size & 0xffff) as i32, ((size >> 16) & 0xffff) as i32);
            let seek = self.get(SEEK);
            let mut point = POINT { x: slider_x(seek, value), y: 0 }; let _ = ClientToScreen(seek, &mut point);
            let (x, y) = (point.x - width / 2, point.y - height - self.paint.px(2));
            SendMessageW(self.seek_tip, TTM_TRACKPOSITION, None, Some(LPARAM(((x as u16 as u32) | ((y as u16 as u32) << 16)) as isize)));
            SendMessageW(self.seek_tip, TTM_TRACKACTIVATE, Some(WPARAM(1)), Some(LPARAM(&tool as *const _ as isize)));
        }
    }
    fn chapter_at(&self, time: f64) -> Option<String> {
        self.chapters.iter().rev().find(|(start, _)| *start <= time).map(|(_, name)| name.clone()).filter(|name| !name.is_empty())
    }
    pub fn set_chapters(&mut self, data: &Value) {
        self.chapters = data.as_array().map(|list| list.iter().filter_map(|c| Some((c["time"].as_f64()?, c["title"].as_str().unwrap_or("").to_owned()))).collect()).unwrap_or_default();
        self.update_marks();
    }
    pub fn update_marks(&self) {
        let marks = if self.duration > 0. { self.chapters.iter().map(|(start, _)| start / self.duration).filter(|f| *f > 0. && *f < 1.).collect() } else { Vec::new() };
        set_marks(self.get(SEEK), marks);
    }
    pub fn chapter_menu(&self) -> Option<menu::Entry> {
        if self.chapters.is_empty() { return None; }
        let current = self.chapters.iter().rposition(|(start, _)| *start <= self.time + 0.05);
        Some(menu::Entry::branch("章節", self.chapters.iter().take(64).enumerate().map(|(i, (start, name))| {
            let label = if name.is_empty() { format!("第 {} 章", i + 1) } else { name.clone() };
            menu::Entry::action(CHAPTER_MENU + i, &format!("{label}\t{}", clock(*start)), current == Some(i))
        }).collect()))
    }
    /// 右下角總長；點一下切換成剩餘時間。
    pub fn duration_rect(&self) -> Option<RECT> {
        if self.toolbar_height() == 0 || self.category == "image" || self.duration <= 0. { return None; }
        let mut area = RECT::default(); unsafe { let _ = GetClientRect(self.hwnd, &mut area); }
        let content = area.right - self.queue_width(area.right);
        Some(rect(content - self.paint.px(58), area.bottom - self.paint.px(78), self.paint.px(54), self.paint.px(24)))
    }
    pub fn duration_label(&self) -> String {
        if self.remaining { format!("-{}", clock(self.duration - self.scrub_time.unwrap_or(self.time))) } else { clock(self.duration) }
    }
    pub fn hit_duration(&self, x: i32, y: i32) -> bool {
        self.duration_rect().is_some_and(|r| x >= r.left && x < r.right && y >= r.top && y < r.bottom)
    }
    pub fn probe_modern(&mut self, elapsed: f64) {
        let post = |hwnd: HWND, msg: u32, x: i32, y: i32| unsafe { let _ = PostMessageW(Some(hwnd), msg, WPARAM(1), LPARAM(((x as u16 as u32) | ((y as u16 as u32) << 16)) as isize)); };
        let seek = self.get(SEEK);
        match self.probe_stage {
            1 => {
                // 走真的滑鼠訊息：點進度條一半處、懸停 25% 處、點總長切成剩餘時間。
                let mut area = RECT::default(); unsafe { let _ = GetClientRect(seek, &mut area); }
                post(seek, WM_LBUTTONDOWN, slider_x(seek, 5000), area.bottom / 2);
                post(seek, WM_LBUTTONUP, slider_x(seek, 5000), area.bottom / 2);
                post(seek, WM_MOUSEMOVE, slider_x(seek, 2500), area.bottom / 2);
                if let Some(r) = self.duration_rect() { post(self.hwnd, WM_LBUTTONDOWN, r.left + 4, r.top + 4); }
                self.probe_stage = 2;
            },
            2 if elapsed > 1.8 => {
                let subtitles = self.tracks.iter().filter(|t| t["type"] == "sub" && t["external"] == true).count();
                let cover = self.tracks.iter().any(|t| t["type"] == "video" && t["albumart"] == true);
                self.probe_log.push(json!({"time":self.time,"remaining":self.remaining,"label":self.duration_label(),"tip":self.seek_tip_label,
                    "chapters":self.chapters.len(),"menu":self.chapter_menu().is_some(),"subtitles":subtitles,"cover":cover}));
                self.action(SEEK_PERCENT + 2); self.probe_stage = 3;
            },
            3 if elapsed > 2.6 => {
                self.probe_log.push(json!({"time":self.time,"pause":self.pause}));
                self.command(json!(["keypress", "PLAYPAUSE"])); self.probe_stage = 4;
            },
            4 if elapsed > 3.4 => {
                self.probe_log.push(json!({"pause":self.pause}));
                self.action(app_command(14).unwrap_or(PLAY)); self.probe_stage = 5;
            },
            5 if elapsed > 4.0 => { self.probe_log.push(json!({"pause":self.pause})); self.probe_stage = 6; },
            _ => {}
        }
    }
}
