//! 清單索引與搜尋共用同一份檔案，不刪除磁碟上的檔案。
use crate::*;

impl State {
    fn probe_slider_damage(&mut self) -> bool { unsafe {
        let mut anchor=RECT::default(); let _=GetWindowRect(self.get(MORE),&mut anchor);
        let Ok(popup)=menu::open_speed(self.hwnd,anchor,self.paint.dark,self.paint.scale,true,1.) else { return false; };
        let _=SetWindowPos(popup,None,0,0,self.paint.px(860),self.paint.px(208),SWP_NOMOVE|SWP_NOZORDER|SWP_NOACTIVATE);
        let speed=GetDlgItem(Some(popup),SPEED_SLIDER as i32).unwrap_or_default();
        let mut full=true;
        for hwnd in [self.get(SEEK),self.get(VOLUME),speed] {
            let _=SetPropW(hwnd,w!("AxonDeckSliderProbe"),Some(HANDLE(1 as _)));
            for width in [276,800] {
                let _=SetWindowPos(hwnd,None,0,0,self.paint.px(width),self.paint.px(30),SWP_NOMOVE|SWP_NOZORDER|SWP_NOACTIVATE);
                for step in 0..20 {
                    let _=ValidateRect(Some(hwnd),None);
                    let damage=rect(self.paint.px(8+step*8),self.paint.px(6),self.paint.px(12),self.paint.px(16));
                    let _=InvalidateRect(Some(hwnd),Some(&damage),false);
                    SendMessageW(hwnd,WM_PAINT,None,None);
                    full &= GetPropW(hwnd,w!("AxonDeckSliderFullPaint")).0 as usize==2;
                }
            }
            let _=RemovePropW(hwnd,w!("AxonDeckSliderProbe")); let _=RemovePropW(hwnd,w!("AxonDeckSliderFullPaint"));
        }
        let _=DestroyWindow(popup); self.layout(); full
    } }
    fn probe_slider_frame(&self) -> [bool;4] { unsafe {
        let hwnd=self.get(SEEK); let dc=GetDC(Some(hwnd)); let memory=CreateCompatibleDC(Some(dc));
        let mut area=RECT::default(); let _=GetClientRect(hwnd,&mut area);
        let bitmap=CreateCompatibleBitmap(dc,area.right.max(1),area.bottom.max(1)); let old=SelectObject(memory,bitmap.into());
        position(hwnd,2500);
        let _=RedrawWindow(Some(hwnd),None,None,RDW_INVALIDATE|RDW_UPDATENOW|RDW_NOERASE);
        let mut channel=RECT::default(); SendMessageW(hwnd,TBM_GETCHANNELRECT,None,Some(LPARAM(&mut channel as *mut _ as isize)));
        let x=channel.left+(channel.right-channel.left)/4; let y=area.bottom/2;
        FillRect(memory,&area,HBRUSH(GetStockObject(WHITE_BRUSH).0));
        let item=NMCUSTOMDRAW { hdr:NMHDR { hwndFrom:hwnd,idFrom:SEEK as usize,code:NM_CUSTOMDRAW },dwDrawStage:CDDS_PREPAINT,hdc:memory,..Default::default() };
        SendMessageW(self.hwnd,WM_NOTIFY,None,Some(LPARAM(&item as *const _ as isize)));
        let callback=GetPixel(memory,x,y)==self.paint.accent();
        FillRect(memory,&area,HBRUSH(GetStockObject(WHITE_BRUSH).0));
        SendMessageW(hwnd,WM_PRINTCLIENT,Some(WPARAM(memory.0 as usize)),Some(LPARAM(PRF_CLIENT as isize)));
        let frame=GetPixel(memory,x,y)==self.paint.accent() && GetPixel(memory,2,2)==rgb(if self.paint.dark { 0x111417 } else { 0xeef3f0 });
        let before=GetPixel(memory,x,y); SendMessageW(hwnd,WM_ERASEBKGND,Some(WPARAM(memory.0 as usize)),None);
        let no_erase=GetPixel(memory,x,y)==before;
        let mut thumb=RECT::default(); SendMessageW(hwnd,TBM_GETTHUMBRECT,None,Some(LPARAM(&mut thumb as *mut _ as isize)));
        let hit=thumb.left<=x && x<thumb.right && thumb.top<=y && y<thumb.bottom;
        SelectObject(memory,old); let _=DeleteObject(bitmap.into()); let _=DeleteDC(memory); ReleaseDC(Some(hwnd),dc);
        [callback,frame,no_erase,hit]
    } }
    pub fn resize_queue_width(&mut self,width:i32) -> bool {
        let width=width.clamp(240,520); if width==self.queue_width { return false; }
        self.queue_width=width; self.layout(); true
    }
    pub fn probe_queue_resize(&mut self) {
        self.show_queue=true;
        unsafe {
            let mut button_refresh=true;
            for (name,value,id) in [("pause",json!(true),PLAY),("pause",json!(false),PLAY),("mute",json!(true),MUTE),("speed",json!(1.25),SPEED)] {
                let control=self.get(id); let _=ValidateRect(Some(control),None);
                self.property(name,&value);
                button_refresh &= GetUpdateRect(control,None,false).as_bool();
            }
            let _=SetWindowPos(self.hwnd,None,0,0,self.paint.px(1060),self.paint.px(880),SWP_NOMOVE|SWP_NOZORDER|SWP_NOACTIVATE);
            let full_paint=self.probe_slider_damage();
            let list=self.get(QUEUE); let dc=GetDC(Some(list));
            let mut frames=0; let mut white=0; let mut blank_dark=true; let mut callback_dark=true; let mut erase_dark=true; let mut first_mismatch=None;
            let mut slider=[true;4]; let mut duplicate_no_redraw=true; let mut layout_us=vec![];
            for count in [4,0] {
                if count==0 { SendMessageW(list,LB_RESETCONTENT,None,None); }
                for width in (0..21).chain((0..21).rev()).map(|step|240+step*14) {
                    let started=Instant::now(); self.resize_queue_width(width); layout_us.push(started.elapsed().as_micros());
                    let _=ValidateRect(Some(self.hwnd),None); let _=ValidateRect(Some(self.get(SEEK)),None);
                    self.resize_queue_width(width);
                    duplicate_no_redraw &= !GetUpdateRect(self.hwnd,None,false).as_bool() && !GetUpdateRect(self.get(SEEK),None,false).as_bool();
                    for (result,current) in slider.iter_mut().zip(self.probe_slider_frame()) { *result &= current; }
                    let memory=CreateCompatibleDC(Some(dc));
                    let mut area=RECT::default(); let _=GetClientRect(list,&mut area);
                    let bitmap=CreateCompatibleBitmap(dc,area.right.max(1),area.bottom.max(1)); let old=SelectObject(memory,bitmap.into());
                    SendMessageW(self.hwnd,WM_CTLCOLORLISTBOX,Some(WPARAM(memory.0 as usize)),Some(LPARAM(list.0 as isize)));
                    callback_dark &= GetBkColor(memory)==rgb(0x1c2123);
                    FillRect(memory,&area,HBRUSH(GetStockObject(WHITE_BRUSH).0));
                    SendMessageW(list,WM_ERASEBKGND,Some(WPARAM(memory.0 as usize)),None);
                    erase_dark &= GetPixel(memory,area.right/2,area.bottom-12)==rgb(0x1c2123);
                    SendMessageW(list,WM_PRINTCLIENT,Some(WPARAM(memory.0 as usize)),Some(LPARAM((PRF_CLIENT|PRF_ERASEBKGND) as isize)));
                    for x in [self.paint.px(12),area.right/2,area.right-self.paint.px(16)] {
                        for y in [area.bottom/2,area.bottom-self.paint.px(12)] {
                            let color=GetPixel(memory,x,y); blank_dark &= color==rgb(0x1c2123);
                            if color!=rgb(0x1c2123) && first_mismatch.is_none() { first_mismatch=Some(json!({"count":count,"width":width,"x":x,"y":y,"color":color.0})); }
                            if color==rgb(0xffffff) { white+=1; }
                        }
                    }
                    frames+=1; SelectObject(memory,old); let _=DeleteObject(bitmap.into()); let _=DeleteDC(memory);
                }
            }
            ReleaseDC(Some(list),dc);
            layout_us.sort_unstable();
            self.refresh_queue(); self.probe_log.push(json!({"fullSliderPaint":full_paint,"buttonRefresh":button_refresh,"frames":frames,"whitePixels":white,"blankDark":blank_dark,"callbackDark":callback_dark,"eraseDark":erase_dark,"firstMismatch":first_mismatch,"slider":slider,"duplicateNoRedraw":duplicate_no_redraw,"layoutP95Us":layout_us[layout_us.len()*95/100]}));
        }
    }
    pub fn queue_width(&self, width: i32) -> i32 {
        if self.show_queue && !self.clean_view { self.paint.px(self.queue_width).min((width-self.paint.px(384)).max(self.paint.px(180))) } else { 0 }
    }
    pub fn refresh_queue(&mut self) {
        let top = unsafe { SendMessageW(self.get(QUEUE),LB_GETTOPINDEX,None,None).0.max(0) };
        let query = self.queue_query.to_lowercase();
        self.queue_indices = self.files.iter().enumerate().filter_map(|(i,file)| {
            file.file_name().unwrap_or_default().to_string_lossy().to_lowercase().contains(&query).then_some(i)
        }).collect();
        unsafe {
            let list = self.get(QUEUE); SendMessageW(list,WM_SETREDRAW,Some(WPARAM(0)),None);
            SendMessageW(list,LB_RESETCONTENT,None,None);
            for &index in &self.queue_indices {
                let label = wide(&self.files[index].file_name().unwrap_or_default().to_string_lossy());
                SendMessageW(list,LB_ADDSTRING,None,Some(LPARAM(label.as_ptr() as isize)));
            }
            let selected = self.queue_indices.iter().position(|&i| i==self.index).map(|i| i as isize).unwrap_or(-1);
            SendMessageW(list,LB_SETCURSEL,Some(WPARAM(selected as usize)),None);
            SendMessageW(list,LB_SETTOPINDEX,Some(WPARAM(top as usize)),None);
            SendMessageW(list,WM_SETREDRAW,Some(WPARAM(1)),None);
            let _ = InvalidateRect(Some(list),None,false);
            let _ = EnableWindow(self.get(QUEUE_REMOVE),!self.queue_indices.is_empty());
        }
        self.redraw();
    }
    pub fn select_current(&self) {
        let selected = self.queue_indices.iter().position(|&i| i==self.index).map(|i| i as isize).unwrap_or(-1);
        unsafe { SendMessageW(self.get(QUEUE),LB_SETCURSEL,Some(WPARAM(selected as usize)),None); }
    }
    pub fn selected_file(&self) -> Option<usize> {
        let row = unsafe { SendMessageW(self.get(QUEUE),LB_GETCURSEL,None,None).0 };
        (row>=0).then(|| self.queue_indices.get(row as usize).copied()).flatten()
    }
    pub fn append_files(&mut self, files: Vec<PathBuf>) {
        self.scan = None;
        let empty = self.files.is_empty();
        let mut known: std::collections::HashSet<_> = self.files.iter().cloned().collect();
        for file in files.into_iter().take(10000) {
            let files = if kind(&file).as_deref()==Some("playlist") { library::playlist(&file) } else { vec![file] };
            for file in files { if self.files.len()<10000 && local_file(&file) && known.insert(file.clone()) { self.files.push(file); } }
        }
        self.refresh_queue();
        if empty && !self.files.is_empty() { self.index=0; self.load(); } else { self.layout(); }
    }
    pub fn remove_selected(&mut self) {
        let Some(index)=self.selected_file() else { return; };
        self.scan=None;
        if index==self.index { self.save_progress(); }
        self.files.remove(index);
        let reload = index==self.index;
        if index<self.index { self.index-=1; }
        self.index=self.index.min(self.files.len().saturating_sub(1));
        self.refresh_queue();
        if self.files.is_empty() { self.command(json!(["stop"])); }
        if reload || self.files.is_empty() { self.loaded=false; self.load(); } else { self.layout(); }
    }
    pub fn probe_queue(&mut self) {
        let extra=self.current().unwrap().parent().unwrap().join("extra.png");
        let count=self.files.len(); let current=self.current().unwrap().to_owned();
        self.append_files(vec![extra.clone(),extra.clone()]);
        let append=self.files.len()==count+1 && self.current()==Some(current.as_path());
        self.queue_query="extra".into(); self.refresh_queue();
        let search=self.queue_indices.len()==1;
        unsafe { SendMessageW(self.get(QUEUE),LB_SETCURSEL,Some(WPARAM(0)),None); }
        self.remove_selected(); self.queue_query.clear(); self.refresh_queue();
        self.probe_log.push(json!({"append":append,"search":search,"remove":self.files.len()==count,"filePreserved":extra.is_file()}));
    }
    pub fn search_changed(&mut self) {
        let mut text=[0u16;256];
        let length=unsafe { GetWindowTextW(self.get(QUEUE_SEARCH),&mut text) } as usize;
        self.queue_query=String::from_utf16_lossy(&text[..length]);
        self.search_at=Some(Instant::now());
    }
    pub fn find_queue(&mut self) {
        self.clean_view=false; self.show_queue=true; self.layout();
        if !self.hidden && !self.offscreen { unsafe { let _=SetFocus(Some(self.get(QUEUE_SEARCH))); } }
    }
    pub fn search_menu(&mut self) {
        if unsafe { IsWindow(Some(self.menu_window)) }.as_bool() { unsafe { let _=PostMessageW(Some(self.menu_window),WM_CLOSE,WPARAM(0),LPARAM(0)); } return; }
        let items=[(490,"復原\tCtrl+Z"),(491,"剪下\tCtrl+X"),(492,"複製\tCtrl+C"),(493,"貼上\tCtrl+V"),(494,"全選\tCtrl+A")]
            .into_iter().map(|(id,label)| menu::Entry::action(id,label,false)).collect();
        let mut anchor=RECT::default(); unsafe { let _=GetWindowRect(self.get(QUEUE_SEARCH),&mut anchor); }
        match menu::open(self.hwnd,anchor,items,true,self.paint.scale,self.offscreen||self.hidden) {
            Ok(hwnd)=>self.menu_window=hwnd,Err(_)=>self.notice("無法開啟搜尋選單")
        }
    }
    pub fn search_edit(&mut self,id:u16) {
        let messages=[EM_UNDO,WM_CUT,WM_COPY,WM_PASTE,EM_SETSEL];
        if let Some(&message)=messages.get((id-490) as usize) {
            unsafe { SendMessageW(self.get(QUEUE_SEARCH),message,Some(WPARAM(0)),Some(LPARAM(if message==EM_SETSEL { -1 } else { 0 }))); }
            self.search_changed();
            if !self.hidden && !self.offscreen { unsafe { let _=SetFocus(Some(self.get(QUEUE_SEARCH))); } }
        }
    }
    pub fn queue_tip(&mut self, info: &mut NMTTDISPINFOW) {
        let index=unsafe { GetPropW(self.get(QUEUE),w!("AxonDeckQueueHover")) }.0 as usize;
        let file=index.checked_sub(1).and_then(|i| self.queue_indices.get(i)).and_then(|&i| self.files.get(i));
        self.queue_tip=wide(&file.map(|f| f.to_string_lossy().into_owned()).unwrap_or_default());
        info.lpszText=windows::core::PWSTR(self.queue_tip.as_mut_ptr());
    }
    pub fn begin_defaults(&mut self) {
        if self.default_task.is_some() { return; }
        let (send,receive)=std::sync::mpsc::channel(); self.default_task=Some(receive);
        std::thread::spawn(move || { let _=send.send(registration::defaults()); });
        self.notice("正在背景設定預設開啟程式，仍可繼續播放");
    }
    pub fn tick_queue(&mut self) {
        if self.search_at.is_some_and(|at| at.elapsed().as_millis()>=120) { self.search_at=None; self.refresh_queue(); }
        if let Some(result)=self.default_task.as_ref().and_then(|receive| receive.try_recv().ok()) {
            self.default_task=None;
            let text=match result { Ok(_) => "已設為預設開啟程式，原設定已備份".to_owned(), Err(error) => error };
            self.status=text.clone(); self.notice(&text); self.redraw();
        }
    }
}
