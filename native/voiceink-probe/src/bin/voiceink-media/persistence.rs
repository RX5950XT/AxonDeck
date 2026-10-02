//! 設定與續播由背景工作者處理；probe 預設不碰使用者設定。
use crate::*;

impl State {
    pub fn save_progress(&self) {
        if self.loaded && self.category!="image" && self.duration>0. {
            if let (Some(store),Some(file))=(&self.storage,self.current()) { store.progress(file.to_owned(),self.time,self.duration); }
        }
    }
    pub fn save_window(&self) {
        if self.fullscreen.is_some() { return; }
        let mut area=RECT::default();
        if unsafe { GetWindowRect(self.hwnd,&mut area) }.is_ok() {
            if let Some(store)=&self.storage { store.window(((area.right-area.left) as f32/self.paint.scale).round() as i32,((area.bottom-area.top) as f32/self.paint.scale).round() as i32); }
        }
    }
    pub fn tick_preferences(&mut self) {
        let events:Vec<_>=self.storage.as_ref().map(|store| store.events.try_iter().collect()).unwrap_or_default();
        for event in events {
            match event {
                preferences::Event::Ready(saved) => {
                    self.settings_ready=true; self.volume=saved.volume; self.queue_width=saved.queue_width;
                    self.command(json!(["set_property","volume",saved.volume]));
                    position(self.get(VOLUME),saved.volume as i32);
                    let mut info=MONITORINFO { cbSize:size_of::<MONITORINFO>() as u32,..Default::default() };
                    if saved.window_saved { unsafe {
                        let _=GetMonitorInfoW(MonitorFromWindow(self.hwnd,MONITOR_DEFAULTTONEAREST),&mut info);
                        let width=self.paint.px(saved.width).min((info.rcWork.right-info.rcWork.left).max(self.paint.px(640)));
                        let height=self.paint.px(saved.height).min((info.rcWork.bottom-info.rcWork.top).max(self.paint.px(430)));
                        let _=SetWindowPos(self.hwnd,None,0,0,width,height,SWP_NOMOVE|SWP_NOZORDER|SWP_NOACTIVATE);
                    } }
                    self.layout();
                },
                preferences::Event::Resume(file,seconds) if self.loaded && self.resume_allowed && self.current()==Some(file.as_path()) && self.category!="image" => {
                    self.resume_allowed=false; self.command(json!(["seek",seconds,"absolute+exact"])); self.notice("已接續上次播放位置");
                },
                preferences::Event::Error(text) => self.notice(&text),
                _ => {}
            }
        }
        if self.loaded && self.settings_ready && !self.resume_requested && self.category!="image" {
            self.resume_requested=true;
            if let (Some(store),Some(file))=(&self.storage,self.current()) { store.resume(file.to_owned()); }
        }
        if self.saved_at.elapsed().as_secs()>=5 { self.saved_at=Instant::now(); self.save_progress(); }
    }
}
