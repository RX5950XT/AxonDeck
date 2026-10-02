//! 原生版面與繪圖；畫面優先，進階操作放在更多與 F1。
use crate::*;

impl State {
    fn toolbar_height(&self) -> i32 {
        if self.chrome_hidden || self.clean_view || self.show_help { 0 } else { self.paint.px(if self.category == "image" { 56 } else { 80 }) }
    }
    pub fn layout(&self) {
        let mut controls=Vec::with_capacity(self.controls.len()+1);
        let mut move_control=|hwnd,area,show|controls.push((hwnd,area,show));
        let mut area = RECT::default(); unsafe { let _ = GetClientRect(self.hwnd, &mut area); }
        let p = |n| self.paint.px(n); let width = area.right; let height = area.bottom;
        let queue = self.queue_width(width);
        let content = width - queue; let image = self.category == "image";
        let stage = rect(0, 0, content, (height-self.toolbar_height()).max(1));
        let cover = self.cover_rect(stage);
        let has_art = self.tracks.iter().any(|t| t["type"] == "video");
        move_control(self.surface, if self.category == "audio" { cover } else { stage }, self.loaded && !self.error && !self.show_help && !self.files.is_empty() && (self.category != "audio" || has_art));
        let y = height - p(44); let visible = self.toolbar_height() > 0;
        for (id, offset) in [(OPEN, 148), (LIST, 112), (FULL, 76), (MORE, 40)] {
            move_control(self.get(id), rect(content-p(offset), y, p(32), p(32)), visible);
        }
        move_control(self.get(HELP), rect(0,0,p(32),p(32)), false);
        let center = if image { p(72) } else if content < p(760) { (content-p(80))/2 } else { content/2 };
        for (id, x, size) in [(PREV,center-p(60),32),(PLAY,center-p(20),40),(NEXT,center+p(28),32)] {
            move_control(self.get(id), rect(x, y-if id == PLAY { p(4) } else { 0 }, p(size), p(size)), visible);
        }
        for (id, x, show) in [(FIT,148,true),(ACTUAL,184,true),(ROTATE,228,content>=p(600)),(ZOOM_OUT,272,content>=p(760)),(ZOOM_IN,308,content>=p(760))] {
            move_control(self.get(id), rect(p(x), y, p(32), p(32)), visible && image && show);
        }
        move_control(self.get(SEEK), rect(p(66), height-p(78), content-p(132), p(24)), visible && !image);
        move_control(self.get(STATUS), rect(p(12), y, p(72), p(32)), false);
        move_control(self.get(MUTE), rect(p(12), y, p(32), p(32)), visible && !image);
        move_control(self.get(VOLUME), rect(p(48), y+p(2), p(88), p(28)), visible && !image && content >= p(620));
        move_control(self.get(SPEED), rect(content-p(208), y, p(52), p(32)), visible && !image && content >= p(680));
        move_control(self.get(QUEUE), rect(content+p(6), p(106), queue-p(12), (height-p(138)).max(1)), self.show_queue && !self.clean_view);
        move_control(self.get(QUEUE_SEARCH),rect(content+p(18),p(71),queue-p(40),p(24)),self.show_queue && !self.clean_view);
        move_control(self.get(QUEUE_CLOSE),rect(width-p(40),p(8),p(32),p(32)),self.show_queue && !self.clean_view);
        move_control(self.get(QUEUE_ADD),rect(width-p(112),p(8),p(32),p(32)),self.show_queue && !self.clean_view);
        move_control(self.get(QUEUE_REMOVE),rect(width-p(76),p(8),p(32),p(32)),self.show_queue && !self.clean_view);
        move_controls(&controls);
        for id in [PREV,NEXT,PLAY,FIT,ACTUAL,ROTATE,ZOOM_OUT,ZOOM_IN,SEEK] {
            let enabled = if id == PREV || id == NEXT { self.files.len()>1 } else if id == SEEK { self.duration>0. } else { self.loaded && !self.error };
            unsafe { if IsWindowEnabled(self.get(id)).as_bool()!=enabled { let _=EnableWindow(self.get(id),enabled); } }
        }
        self.redraw();
    }
    pub fn redraw_time(&self) {
        if self.toolbar_height()==0 || self.category=="image" { return; }
        let mut area=RECT::default(); unsafe { let _=GetClientRect(self.hwnd,&mut area); }
        area.right-=self.queue_width(area.right); area.top=area.bottom-self.paint.px(78); area.bottom=area.top+self.paint.px(24);
        unsafe { let _=InvalidateRect(Some(self.hwnd),Some(&area),false); }
    }
    pub fn cover_rect(&self, stage: RECT) -> RECT {
        let p = |n| self.paint.px(n); let width = stage.right-stage.left; let height = stage.bottom-stage.top;
        let size = p(if width < p(620) { 168 } else { 240 }).min((height-p(if width < p(620) { 115 } else { 40 })).max(p(80)));
        let x = if width < p(620) { stage.left+(width-size)/2 } else { stage.left+p(42) };
        rect(x, stage.top + if width < p(620) { p(18) } else { (height-size)/2 }, size, size)
    }
    pub fn draw(&self) {
        unsafe {
            let mut paint = PAINTSTRUCT::default(); let dc = BeginPaint(self.hwnd, &mut paint);
            let mut area = RECT::default(); let _ = GetClientRect(self.hwnd, &mut area);
            let r = paint.rcPaint;
            let memory = CreateCompatibleDC(Some(dc)); let bitmap = CreateCompatibleBitmap(dc,(r.right-r.left).max(1),(r.bottom-r.top).max(1));
            let _ = SetViewportOrgEx(memory,-r.left,-r.top,None);
            let old = SelectObject(memory, bitmap.into()); self.render(memory);
            let _ = BitBlt(dc,r.left,r.top,r.right-r.left,r.bottom-r.top,Some(memory),r.left,r.top,SRCCOPY);
            SelectObject(memory, old); let _ = DeleteObject(bitmap.into()); let _ = DeleteDC(memory);
            let _ = EndPaint(self.hwnd, &paint);
        }
    }
    pub fn render(&self, dc: HDC) {
        let mut area = RECT::default(); unsafe { let _ = GetClientRect(self.hwnd, &mut area); }
        self.paint.base(dc, &area); let p = |n| self.paint.px(n);
        let queue = self.queue_width(area.right); let content = area.right-queue;
        let filename = self.current().and_then(Path::file_name).map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "VoiceInk 媒體".into());
        let title = self.tag("title").unwrap_or(&filename);
        let image = self.category == "image";
        let stage = rect(0,0,content,area.bottom-self.toolbar_height());
        if self.category == "audio" && !self.error && !self.show_help {
            let cover = self.cover_rect(stage);
            if !self.tracks.iter().any(|t| t["type"] == "video") { self.paint.album(dc, cover); }
            let narrow = content < p(620);
            let x = if narrow { p(26) } else { cover.right+p(36) };
            let y = if narrow { cover.bottom+p(20) } else { cover.top+p(56) };
            let width = content-x-p(26);
            self.paint.text(dc, title, rect(x,y,width,p(32)), self.paint.heading, self.paint.text_color());
            self.paint.text(dc, self.tag("artist").unwrap_or("本機音樂"), rect(x,y+p(38),width,p(24)), self.paint.normal, self.paint.muted());
            self.paint.text(dc, self.tag("album").unwrap_or(""), rect(x,y+p(66),width,p(24)), self.paint.small, self.paint.muted());
        }
        if self.error || self.files.is_empty() {
            self.paint.text(dc, if self.error { "這個檔案暫時無法開啟" } else { "開啟一個檔案，開始欣賞" }, rect(p(32),p(80),content-p(64),p(36)), self.paint.heading, self.paint.text_color());
            self.paint.text(dc, if self.error { &self.status } else { "拖曳圖片、影片或音樂到這裡，或按 Ctrl+O" }, rect(p(32),p(125),content-p(64),p(28)), self.paint.normal, self.paint.muted());
        } else if !self.loaded {
            self.paint.text(dc,&self.status,rect(p(32),p(80),content-p(64),p(32)),self.paint.normal,self.paint.muted());
        }
        if self.toolbar_height() > 0 {
            let bottom = area.bottom-self.toolbar_height();
            self.paint.fill(dc, rect(0,bottom,content,1), self.paint.line());
            if !image {
                self.paint.text(dc, &clock(self.scrub_time.unwrap_or(self.time)), rect(p(12),area.bottom-p(78),p(56),p(24)), self.paint.small,if self.scrub_time.is_some() { self.paint.accent() } else { self.paint.muted() });
                self.paint.text(dc, &clock(self.duration), rect(content-p(58),area.bottom-p(78),p(54),p(24)),self.paint.small,self.paint.muted());
                if content >= p(620) { self.paint.text(dc,&format!("{}%", if self.mute { 0 } else { self.volume as u32 }),rect(p(142),area.bottom-p(44),p(44),p(32)),self.paint.small,self.paint.muted()); }
            } else if content >= p(560) {
                let dimensions = if content >= p(760) { match (self.video["w"].as_i64(),self.video["h"].as_i64()) { (Some(w),Some(h)) => format!("{w} × {h} · "), _ => String::new() } } else { String::new() };
                let detail = format!("{dimensions}{} / {}{}",self.index+1,self.files.len(),if self.slideshow { " · 輪播中" } else { "" });
                let x = p(if content >= p(760) { 356 } else { 272 });
                self.paint.text(dc, &detail, rect(x,area.bottom-p(44),content-x-p(160),p(32)),self.paint.small,self.paint.muted());
            }
        }
        if self.show_queue && !self.clean_view {
            self.paint.fill(dc, rect(content,0,queue,area.bottom),rgb(0x1c2123));
            self.paint.fill(dc,rect(content,0,p(1),area.bottom),rgb(0x343c3f));
            self.paint.text(dc,"播放清單",rect(content+p(18),p(10),queue-p(132),p(26)),self.paint.normal,rgb(0xf4f1e8));
            let count=if self.queue_query.is_empty() { format!("{} 個檔案",self.files.len()) } else { format!("{} / {} 個檔案",self.queue_indices.len(),self.files.len()) };
            self.paint.text(dc,&count,rect(content+p(18),p(38),queue-p(36),p(20)),self.paint.small,rgb(0xc5c4bd));
            self.paint.round(dc,rect(content+p(12),p(65),queue-p(26),p(36)),rgb(0x343c3f),8);
            self.paint.fill(dc,rect(content+p(17),p(70),queue-p(38),p(26)),rgb(0x1c2123));
            if self.queue_indices.is_empty() { self.paint.text(dc,if self.files.is_empty() { "拖入檔案，或按 + 加入" } else { "沒有符合的檔案" },rect(content+p(18),p(120),queue-p(36),p(28)),self.paint.small,rgb(0xc5c4bd)); }
            self.paint.text(dc,"Enter 播放 · Delete 移除",rect(content+p(18),area.bottom-p(28),queue-p(36),p(22)),self.paint.small,rgb(0xc5c4bd));
        }
        if self.show_help { self.help(dc, rect(stage.left,stage.top,stage.right-stage.left,area.bottom-stage.top-p(8))); }
    }
    fn help(&self, dc: HDC, area: RECT) {
        let p = |n| self.paint.px(n); let x = area.left+p(24); let width = area.right-area.left-p(48);
        self.paint.text(dc,"快捷鍵",rect(x,area.top+p(14),width,p(32)),self.paint.heading,self.paint.text_color());
        let rows: &[(&str,&str)] = if self.category == "image" {
            &[("← / →、PageUp / PageDown","上一張 / 下一張"),("Space / P","輪播 / 暫停動畫"),("+ / −、滑鼠滾輪","放大 / 縮小"),("0 / 1","適合視窗 / 原始大小"),("R、滑鼠拖曳","向右旋轉 / 平移"),("Home / End","第一張 / 最後一張")]
        } else {
            &[("Space、M、. / ,","播放 / 暫停、靜音、逐格"),("← / →、Shift + ← / →","前後 5 秒 / 30 秒"),("↑ / ↓、滑鼠滾輪","調整音量"),("[ / ]、Backspace","調整倍速 / 恢復 1×"),("PageUp / PageDown、R / L","上一個 / 下一個、循環 / 隨機"),("V、A / C、J / K","顯示字幕、切音軌 / 字幕、字幕延遲")]
        };
        let stacked = width < p(560);
        let step = p(if stacked { 38 } else { 30 }).min(((area.bottom-area.top-p(60))/9).max(p(if stacked { 34 } else { 22 })));
        for (i,(key,label)) in rows.iter().chain([("F / Enter、Esc","全螢幕 / 離開"),("Ctrl+O / L / F / T","開啟 / 清單 / 搜尋 / 置頂"),("Ctrl+H、S、F1","純畫面 / 儲存畫面 / 關閉說明")].iter()).enumerate() {
            let y = area.top+p(56)+step*i as i32;
            self.paint.text(dc,key,rect(x,y,if stacked { width } else { width/2 },p(if stacked { 16 } else { 26 })),self.paint.small,self.paint.accent());
            self.paint.text(dc,label,rect(x+if stacked { 0 } else { width/2 },y+if stacked { p(16) } else { 0 },if stacked { width } else { width/2 },p(if stacked { 18 } else { 26 })),self.paint.small,self.paint.text_color());
        }
    }
}
