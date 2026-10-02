//! 自繪選單浮窗；BUTTON 只提供鍵盤／讀屏名稱，外觀全部由 GDI 繪製。
use crate::ui::*;
use crate::actions::{SPEED_SLIDER,SPEED_RESET};
use std::cell::RefCell;
use windows::core::w;
use windows::Win32::{Foundation::*, Graphics::{Dwm::*, Gdi::*}, System::LibraryLoader::GetModuleHandleW,
    UI::{Controls::*, Input::KeyboardAndMouse::*, Shell::{SetWindowSubclass, DefSubclassProc}, WindowsAndMessaging::*}};

#[derive(Clone)]
pub struct Entry { pub id: u16, pub label: String, pub checked: bool, pub children: Vec<Entry> }
const HOVER: u32 = WM_APP+2;
impl Entry {
    pub fn action(id: usize, label: &str, checked: bool) -> Self { Self { id: id as u16, label: label.into(), checked, children: vec![] } }
    pub fn branch(label: &str, children: Vec<Entry>) -> Self { Self { id: 0, label: label.into(), checked: false, children } }
    pub fn separator() -> Self { Self::action(0, "", false) }
}
struct Popup {
    owner: HWND, hwnd: HWND, paint: Paint, pages: Vec<(String, Vec<Entry>, usize)>,
    buttons: Vec<(usize, HWND)>, selected: usize, top: usize, visible: usize, max_height: i32, quiet: bool,
    speed: Option<i32>, speed_slider: HWND, pending_speed: Option<i32>,
}
impl Popup {
    fn rows(&self) -> &Vec<Entry> { &self.pages.last().unwrap().1 }
    fn close(&self) { unsafe { let _ = PostMessageW(Some(self.hwnd), WM_CLOSE, WPARAM(0), LPARAM(0)); } }
    fn rebuild(&mut self) -> windows::core::Result<()> {
        unsafe { for (_, button) in self.buttons.drain(..) { let _ = DestroyWindow(button); } }
        let p = |n| self.paint.px(n); let width = p(312); let row = p(34);
        if let Some(value)=self.speed {
            self.speed_slider=slider(self.hwnd,"播放速度",SPEED_SLIDER,375,self.paint.dark)?;
            unsafe {
                SetPropW(self.speed_slider,w!("VoiceInkSliderPanel"),Some(HANDLE(1 as _)))?;
                SendMessageW(self.speed_slider,TBM_SETLINESIZE,None,Some(LPARAM(5)));
                SendMessageW(self.speed_slider,TBM_SETPAGESIZE,None,Some(LPARAM(25)));
            }
            move_control(self.speed_slider,rect(p(18),p(84),p(276),p(30)),true); position(self.speed_slider,value);
            let reset=button(self.hwnd,"恢復 1×",SPEED_RESET)?;
            move_control(reset,rect(p(104),p(141),p(104),p(32)),true); self.buttons.push((usize::MAX,reset));
            unsafe {
                let _=SetWindowPos(self.hwnd,None,0,0,width,p(208),SWP_NOMOVE|SWP_NOZORDER|SWP_NOACTIVATE);
            }
            return Ok(());
        }
        self.visible = ((self.max_height-p(80))/row).max(1) as usize;
        let end = (self.top+self.visible).min(self.rows().len());
        let mut y = p(48);
        if self.pages.len() > 1 {
            let back = button(self.hwnd, "返回上一層", 900)?;
            move_control(back, rect(p(8),p(8),p(32),p(32)),true);
            self.buttons.push((usize::MAX,back));
        }
        for i in self.top..end {
            let entry = &self.rows()[i];
            if entry.label.is_empty() { y += p(10); continue; }
            let label = format!("{}{}", entry.label.replace('\t', "　"), if entry.checked { "，已選取" } else if !entry.children.is_empty() { "，子選單" } else { "" });
            let control = button(self.hwnd,&label,1000+i as u16)?;
            unsafe { let _ = SetWindowSubclass(control,Some(row_proc),2,0); }
            move_control(control,rect(p(8),y,width-p(16),row),true);
            self.buttons.push((i,control)); y += row;
        }
        unsafe {
            let _ = SetWindowPos(self.hwnd,None,0,0,width,y+p(30),SWP_NOMOVE|SWP_NOZORDER|SWP_NOACTIVATE);
            if !self.quiet {
                let mut info = MONITORINFO { cbSize:size_of::<MONITORINFO>() as u32,..Default::default() };
                let _ = GetMonitorInfoW(MonitorFromWindow(self.hwnd,MONITOR_DEFAULTTONEAREST),&mut info);
                let mut area = RECT::default(); let _ = GetWindowRect(self.hwnd,&mut area);
                let x = area.left.clamp(info.rcWork.left+8,(info.rcWork.right-width-8).max(info.rcWork.left+8));
                let top = area.top.clamp(info.rcWork.top+8,(info.rcWork.bottom-y-p(30)-8).max(info.rcWork.top+8));
                let _ = SetWindowPos(self.hwnd,None,x,top,0,0,SWP_NOSIZE|SWP_NOZORDER|SWP_NOACTIVATE);
            }
            let region = CreateRoundRectRgn(0,0,width+1,y+p(30)+1,p(20),p(20));
            if SetWindowRgn(self.hwnd,Some(region),true) == 0 { let _ = DeleteObject(region.into()); }
            let _ = InvalidateRect(Some(self.hwnd),None,false);
        }
        self.highlight(); Ok(())
    }
    fn highlight(&self) {
        if self.speed.is_some() { if !self.quiet { unsafe { let _=SetFocus(Some(self.speed_slider)); } } return; }
        for &(i, hwnd) in &self.buttons {
            unsafe { let _ = InvalidateRect(Some(hwnd),None,false); }
            if i == self.selected && !self.quiet { unsafe { let _ = SetFocus(Some(hwnd)); } }
        }
    }
    fn select(&mut self, index: usize) {
        if self.rows().get(index).is_none_or(|r| r.label.is_empty()) { return; }
        self.selected = index;
        if index < self.top || index >= self.top+self.visible {
            self.top = if index < self.top { index } else { index+1-self.visible };
            if self.rebuild().is_err() { self.close(); }
        } else { self.highlight(); }
    }
    fn activate(&mut self, index: usize) {
        let Some(entry) = self.rows().get(index).cloned() else { return; };
        if entry.label.is_empty() { return; }
        if !entry.children.is_empty() {
            self.pages.last_mut().unwrap().2 = self.selected;
            self.pages.push((entry.label,entry.children,0)); self.selected = 0; self.top = 0;
            if self.rebuild().is_err() { self.close(); }
        } else if entry.id != 0 {
            unsafe { let _ = PostMessageW(Some(self.owner),WM_COMMAND,WPARAM(entry.id as usize),LPARAM(0)); }
            self.close();
        }
    }
    fn back(&mut self) {
        if self.pages.len() == 1 { self.close(); return; }
        self.pages.pop(); self.selected = self.pages.last().unwrap().2;
        self.top = self.selected.saturating_sub(self.visible.saturating_sub(1));
        if self.rebuild().is_err() { self.close(); }
    }
    fn key(&mut self, key: usize, shift: bool) {
        if self.speed.is_some() {
            match key { 0x1b => self.close(), 0x08 => self.set_speed(75,true), _=>{} }
            return;
        }
        let indexes: Vec<_> = self.rows().iter().enumerate().filter(|(_,r)| !r.label.is_empty()).map(|(i,_)| i).collect();
        if indexes.is_empty() { if key == 0x1b { self.back(); } return; }
        let at = indexes.iter().position(|&i| i == self.selected).unwrap_or(0);
        match key {
            0x1b | 0x25 => self.back(),
            0x0d | 0x20 | 0x27 => self.activate(self.selected),
            0x24 => self.select(indexes[0]), 0x23 => self.select(*indexes.last().unwrap()),
            0x26 | 0x28 | 0x09 => {
                let previous = key == 0x26 || (key == 0x09 && shift);
                self.select(indexes[(at+if previous { indexes.len()-1 } else { 1 })%indexes.len()]);
            }, _ => {}
        }
    }
    fn row(&self, item: &DRAWITEMSTRUCT) {
        if self.speed.is_some() {
            self.paint.fill(item.hDC,item.rcItem,self.paint.surface());
            self.paint.round(item.hDC,item.rcItem,if item.itemState.0 & (ODS_SELECTED.0|ODS_FOCUS.0)!=0 { self.paint.line() } else { self.paint.selection() },8);
            self.paint.text(item.hDC,"恢復 1×",rect(self.paint.px(18),0,item.rcItem.right-self.paint.px(18),item.rcItem.bottom),self.paint.normal,self.paint.text_color());
            return;
        }
        let p = |n| self.paint.px(n); let r = item.rcItem;
        let back = item.CtlID == 900;
        let index = item.CtlID.saturating_sub(1000) as usize;
        self.paint.fill(item.hDC,r,self.paint.surface());
        let selected = !back && self.selected == index;
        if selected || item.itemState.0 & (ODS_SELECTED.0|ODS_FOCUS.0) != 0 {
            self.paint.round(item.hDC,rect(0,p(1),r.right,r.bottom-p(2)),self.paint.selection(),8);
        }
        if back { self.paint.text(item.hDC,"‹",r,self.paint.heading,self.paint.muted()); return; }
        let Some(entry) = self.rows().get(index) else { return; };
        let (label, shortcut) = entry.label.split_once('\t').unwrap_or((&entry.label,""));
        if entry.checked { self.paint.text(item.hDC,"✓",rect(p(10),0,p(22),r.bottom),self.paint.normal,self.paint.accent()); }
        let reserved = if !shortcut.is_empty() { p(82) } else if !entry.children.is_empty() { p(24) } else { 0 };
        self.paint.text(item.hDC,label,rect(p(36),0,r.right-p(48)-reserved,r.bottom),self.paint.normal,self.paint.text_color());
        self.paint.text(item.hDC,shortcut,rect(r.right-p(84),0,p(76),r.bottom),self.paint.small,self.paint.muted());
        if !entry.children.is_empty() { self.paint.text(item.hDC,"›",rect(r.right-p(22),0,p(20),r.bottom),self.paint.heading,self.paint.muted()); }
    }
    fn render(&self, dc: HDC) {
        let p = |n| self.paint.px(n); let mut r = RECT::default(); unsafe { let _ = GetClientRect(self.hwnd,&mut r); }
        self.paint.fill(dc,r,self.paint.surface());
        self.paint.text(dc,if self.speed.is_some() { "播放速度" } else { &self.pages.last().unwrap().0 },rect(p(if self.pages.len()>1 { 44 } else { 18 }),p(8),r.right-p(62),p(30)),self.paint.normal,self.paint.muted());
        self.paint.fill(dc,rect(p(12),p(43),r.right-p(24),p(1)),self.paint.line());
        if let Some(value)=self.speed {
            self.paint.text(dc,&format!("{:.2}×",(value+25) as f64/100.),rect(p(126),p(50),p(88),p(30)),self.paint.heading,self.paint.accent());
            for (label,x) in [("0.25×",18),("4×",272)] { self.paint.text(dc,label,rect(p(x),p(115),p(44),p(22)),self.paint.small,self.paint.muted()); }
            self.paint.text(dc,"← → 微調 · Backspace 恢復 · Esc 關閉",rect(p(18),p(180),p(280),p(22)),self.paint.small,self.paint.muted());
            return;
        }
        let mut y = p(48);
        for entry in self.rows().iter().skip(self.top).take(self.visible) {
            if entry.label.is_empty() { self.paint.fill(dc,rect(p(20),y+p(5),r.right-p(40),p(1)),self.paint.line()); y += p(10); } else { y += p(34); }
        }
        let hint = if self.rows().len()>self.visible { "↑ ↓ 選擇 · 滾輪捲動 · Esc 返回" } else { "↑ ↓ 選擇 · Enter 確認 · Esc 返回" };
        self.paint.text(dc,hint,rect(p(18),r.bottom-p(28),r.right-p(36),p(24)),self.paint.small,self.paint.muted());
    }
    fn print(&self, dc: HDC) {
        let saved = unsafe { SaveDC(dc) };
        unsafe { let _ = SelectClipRgn(dc,None); }
        self.render(dc);
        if self.speed.is_some() { unsafe {
            let saved=SaveDC(dc); let _=SetViewportOrgEx(dc,self.paint.px(18),self.paint.px(84),None);
            SendMessageW(self.speed_slider,WM_PRINTCLIENT,Some(WPARAM(dc.0 as usize)),Some(LPARAM(PRF_CLIENT as isize))); let _=RestoreDC(dc,saved);
        } }
        for &(_,button) in &self.buttons { unsafe {
            let mut area = RECT::default(); let _ = GetWindowRect(button,&mut area);
            let mut point = POINT { x:area.left,y:area.top }; let _ = ScreenToClient(self.hwnd,&mut point);
            let saved = SaveDC(dc); let _ = SetViewportOrgEx(dc,point.x,point.y,None);
            self.row(&DRAWITEMSTRUCT { CtlType:ODT_BUTTON,CtlID:GetDlgCtrlID(button) as u32,hwndItem:button,hDC:dc,
                rcItem:rect(0,0,area.right-area.left,area.bottom-area.top),..Default::default() });
            let _ = RestoreDC(dc,saved);
        } }
        unsafe { let _ = RestoreDC(dc,saved); }
    }
    fn set_speed(&mut self,value:i32,send:bool) {
        if self.speed.is_none() { return; }
        let value=value.clamp(0,375); let changed=self.speed!=Some(value); self.speed=Some(value);
        position(self.speed_slider,value);
        if changed { unsafe {
            let area=rect(self.paint.px(126),self.paint.px(50),self.paint.px(88),self.paint.px(30));
            let _=InvalidateRect(Some(self.hwnd),Some(&area),false);
            if send { self.pending_speed=Some(value); let _=PostMessageW(Some(self.owner),WM_APP+8,WPARAM((value+25) as usize),LPARAM(0)); }
        } }
    }
}
unsafe extern "system" fn row_proc(hwnd: HWND,msg: u32,w: WPARAM,l: LPARAM,_: usize,_: usize) -> LRESULT {
    if msg == WM_MOUSEMOVE { unsafe {
        if let Ok(parent) = GetParent(hwnd) { let _ = PostMessageW(Some(parent),WM_APP+2,WPARAM(GetDlgCtrlID(hwnd) as usize),LPARAM(0)); }
    } }
    if msg == WM_MOUSEWHEEL { unsafe { if let Ok(parent) = GetParent(hwnd) { return SendMessageW(parent,msg,Some(w),Some(l)); } } }
    unsafe { DefSubclassProc(hwnd,msg,w,l) }
}
unsafe extern "system" fn proc(hwnd: HWND,msg: u32,w: WPARAM,l: LPARAM) -> LRESULT {
    unsafe {
        if let Some(result)=slider_notification(msg,l) { return result; }
        if msg==WM_ERASEBKGND { return LRESULT(1); }
        if msg == WM_NCCREATE { SetWindowLongPtrW(hwnd,GWLP_USERDATA,(*(l.0 as *const CREATESTRUCTW)).lpCreateParams as isize); }
        let ptr = GetWindowLongPtrW(hwnd,GWLP_USERDATA) as *mut RefCell<Popup>;
        if ptr.is_null() { return DefWindowProcW(hwnd,msg,w,l); }
        if msg == WM_NCDESTROY { SetWindowLongPtrW(hwnd,GWLP_USERDATA,0); drop(Box::from_raw(ptr)); return DefWindowProcW(hwnd,msg,w,l); }
        if msg == WM_CLOSE { let _ = DestroyWindow(hwnd); return LRESULT(0); }
        let Ok(mut s) = (&*ptr).try_borrow_mut() else { return DefWindowProcW(hwnd,msg,w,l); };
        match msg {
            WM_PAINT => { let mut ps = PAINTSTRUCT::default(); let dc = BeginPaint(hwnd,&mut ps); s.render(dc); let _ = EndPaint(hwnd,&ps); },
            WM_PRINTCLIENT => s.print(HDC(w.0 as _)),
            WM_PRINT => s.print(HDC(w.0 as _)),
            WM_DRAWITEM => { s.row(&*(l.0 as *const DRAWITEMSTRUCT)); return LRESULT(1); },
            WM_COMMAND => if s.speed.is_some() { if w.0 & 0xffff==SPEED_RESET as usize { s.set_speed(75,true); } } else if w.0 & 0xffff == 900 { s.back(); } else { s.activate((w.0 & 0xffff).saturating_sub(1000)); },
            WM_HSCROLL if s.speed.is_some() && HWND(l.0 as _)==s.speed_slider => { let value=slider_pos(s.speed_slider); s.set_speed(value,true); },
            msg if msg==WM_APP+9 && s.speed.is_some() => {
                let value=w.0 as i32-25;
                // 快速拖曳時忽略較早送出的解碼器回報，避免圓點倒跳。
                if s.pending_speed.is_none_or(|pending| pending==value) {
                    s.pending_speed=None;
                    if GetCapture()!=s.speed_slider { s.set_speed(value,false); }
                }
            },
            WM_KEYDOWN => s.key(w.0,GetKeyState(VK_SHIFT.0 as i32)<0),
            HOVER => { let i = w.0.saturating_sub(1000); if w.0 >= 1000 && i != s.selected { s.select(i); } },
            WM_MOUSEWHEEL => {
                let down = ((w.0>>16) as u16 as i16) < 0;
                s.top = if down { (s.top+3).min(s.rows().len().saturating_sub(s.visible)) } else { s.top.saturating_sub(3) };
                let end = (s.top+s.visible).min(s.rows().len());
                if s.selected < s.top || s.selected >= end {
                    s.selected = (s.top..end).filter(|&i| !s.rows()[i].label.is_empty())
                        .min_by_key(|i| i.abs_diff(s.selected)).unwrap_or(s.selected);
                }
                if s.rebuild().is_err() { s.close(); }
            },
            WM_ACTIVATE if w.0 & 0xffff == WA_INACTIVE as usize && !s.quiet => s.close(),
            _ => { drop(s); return DefWindowProcW(hwnd,msg,w,l); }
        }
        LRESULT(0)
    }
}
pub fn open(owner: HWND, anchor: RECT, entries: Vec<Entry>, dark: bool, scale: f32, quiet: bool) -> windows::core::Result<HWND> {
    create(owner,anchor,entries,dark,scale,quiet,None)
}
pub fn open_speed(owner: HWND,anchor:RECT,dark:bool,scale:f32,quiet:bool,speed:f64) -> windows::core::Result<HWND> {
    create(owner,anchor,vec![],dark,scale,quiet,Some((speed*100.).round().clamp(25.,400.) as i32-25))
}
fn create(owner: HWND, anchor: RECT, entries: Vec<Entry>, dark: bool, scale: f32, quiet: bool,speed:Option<i32>) -> windows::core::Result<HWND> {
    unsafe {
        let instance = GetModuleHandleW(None)?;
        RegisterClassW(&WNDCLASSW { hInstance: instance.into(),lpszClassName:w!("VoiceInkMediaMenu"),lpfnWndProc:Some(proc),hCursor:LoadCursorW(None,IDC_ARROW)?,..Default::default() });
        let mut info = MONITORINFO { cbSize:size_of::<MONITORINFO>() as u32,..Default::default() };
        let _ = GetMonitorInfoW(MonitorFromWindow(owner,MONITOR_DEFAULTTONEAREST),&mut info);
        let state = Box::new(RefCell::new(Popup { owner,hwnd:HWND::default(),paint:Paint::new(dark,scale),pages:vec![("更多操作".into(),entries,0)],buttons:vec![],selected:0,top:0,visible:0,max_height:(info.rcWork.bottom-info.rcWork.top-24).min((760.*scale) as i32),quiet,speed,speed_slider:HWND::default(),pending_speed:None }));
        let raw = Box::into_raw(state);
        let result = CreateWindowExW(WS_EX_TOOLWINDOW,w!("VoiceInkMediaMenu"),w!("更多操作"),WS_POPUP|WS_CLIPCHILDREN,anchor.left,anchor.top,1,1,Some(owner),None,Some(instance.into()),Some(raw.cast()));
        // WM_NCDESTROY owns the allocation after WM_NCCREATE, including failed creation.
        let hwnd = result?;
        let mut s = (&*raw).borrow_mut(); s.hwnd = hwnd;
        if let Err(error) = s.rebuild() { drop(s); let _ = DestroyWindow(hwnd); return Err(error); }
        let mut r = RECT::default(); let _ = GetWindowRect(hwnd,&mut r);
        let width = r.right-r.left; let height = r.bottom-r.top;
        let context = anchor.left == anchor.right;
        let left = if context { anchor.left } else { anchor.right-width };
        let top = if context { anchor.top } else { anchor.top-height };
        let x = if quiet { left } else { left.clamp(info.rcWork.left+8,(info.rcWork.right-width-8).max(info.rcWork.left+8)) };
        let y = if quiet { top } else { top.clamp(info.rcWork.top+8,(info.rcWork.bottom-height-8).max(info.rcWork.top+8)) };
        let _ = SetWindowPos(hwnd,None,x,y,0,0,SWP_NOSIZE|SWP_NOZORDER|SWP_NOACTIVATE);
        let corner: i32 = 2; let _ = DwmSetWindowAttribute(hwnd,DWMWA_WINDOW_CORNER_PREFERENCE,&corner as *const _ as _,4);
        drop(s);
        let _ = ShowWindow(hwnd,if quiet { SW_SHOWNOACTIVATE } else { SW_SHOW });
        (&*raw).borrow().highlight();
        Ok(hwnd)
    }
}
pub fn dispatch(message: &MSG) -> bool {
    if message.message != WM_KEYDOWN { return false; }
    unsafe {
        let root = GetAncestor(message.hwnd,GA_ROOT);
        let mut class = [0u16;64]; let n = GetClassNameW(root,&mut class);
        if String::from_utf16_lossy(&class[..n as usize]) != "VoiceInkMediaMenu" { return false; }
        let slider=GetDlgItem(Some(root),SPEED_SLIDER as i32).unwrap_or_default();
        if IsWindow(Some(slider)).as_bool() {
            if matches!(message.wParam.0,0x21..=0x28) { SendMessageW(slider,WM_KEYDOWN,Some(message.wParam),Some(message.lParam)); return true; }
            if message.wParam.0==0x09 {
                let ptr=GetWindowLongPtrW(root,GWLP_USERDATA) as *const RefCell<Popup>;
                if !ptr.is_null() && !(&*ptr).borrow().quiet { if GetFocus()==slider { let _=SetFocus(GetDlgItem(Some(root),SPEED_RESET as i32).ok()); } else { let _=SetFocus(Some(slider)); } }
                return true;
            }
            if matches!(message.wParam.0,0x0d|0x20) && GetDlgCtrlID(message.hwnd)==SPEED_RESET as i32 { SendMessageW(root,WM_COMMAND,Some(WPARAM(SPEED_RESET as usize)),None); return true; }
        }
        SendMessageW(root,WM_KEYDOWN,Some(message.wParam),Some(message.lParam)); true
    }
}
