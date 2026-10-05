//! Windows 自己的視窗／按鈕／滑桿／清單：保留鍵盤、讀屏及縮放，不載入 WebView。
use windows::core::{PCWSTR, w};
use windows::Win32::Foundation::{COLORREF, HWND, RECT, WPARAM, LPARAM};
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::UI::Controls::*;
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::Shell::{SetWindowSubclass, DefSubclassProc};
use crate::actions::*;

pub fn wide(s: &str) -> Vec<u16> { s.encode_utf16().chain(Some(0)).collect() }
pub fn set_text(hwnd: HWND, s: &str) { unsafe { let _ = SetWindowTextW(hwnd, PCWSTR(wide(s).as_ptr())); } }
pub fn rect(x: i32, y: i32, w: i32, h: i32) -> RECT { RECT { left: x, top: y, right: x + w, bottom: y + h } }
pub fn rgb(hex: u32) -> COLORREF { COLORREF(((hex & 255) << 16) | (hex & 0xff00) | (hex >> 16)) }

pub struct Paint {
    pub dark: bool,
    pub scale: f32,
    pub normal: HFONT,
    pub heading: HFONT,
    pub small: HFONT,
    pub icons: HFONT,
    pub background: HBRUSH,
    pub panel: HBRUSH,
    pub queue_panel: HBRUSH,
}
impl Paint {
    pub fn new(dark: bool, scale: f32) -> Self {
        let font = |size: f32, weight| unsafe { CreateFontW(-(size * scale) as i32, 0, 0, 0, weight,
            0, 0, 0, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, 0, w!("Microsoft JhengHei UI")) };
        Self { dark, scale, normal: font(14., 400), heading: font(20., 600), small: font(12., 400),
            icons: unsafe { CreateFontW(-(19. * scale) as i32, 0, 0, 0, 400, 0, 0, 0, DEFAULT_CHARSET,
                OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, 0, w!("Segoe MDL2 Assets")) },
            background: unsafe { CreateSolidBrush(rgb(if dark { 0x111417 } else { 0xeef3f0 })) },
            panel: unsafe { CreateSolidBrush(rgb(if dark { 0x1c2123 } else { 0xf8f9f6 })) },
            queue_panel: unsafe { CreateSolidBrush(rgb(0x1c2123)) } }
    }
    pub fn px(&self, n: i32) -> i32 { (n as f32 * self.scale).round() as i32 }
    pub fn text_color(&self) -> COLORREF { rgb(if self.dark { 0xf4f1e8 } else { 0x1e2528 }) }
    pub fn muted(&self) -> COLORREF { rgb(if self.dark { 0xc5c4bd } else { 0x4e5a5e }) }
    pub fn accent(&self) -> COLORREF { rgb(if self.dark { 0x78a3b5 } else { 0x3d6a7d }) }
    pub fn surface(&self) -> COLORREF { rgb(if self.dark { 0x1c2123 } else { 0xf8f9f6 }) }
    pub fn line(&self) -> COLORREF { rgb(if self.dark { 0x343c3f } else { 0xc6d0ce }) }
    pub fn selection(&self) -> COLORREF { rgb(if self.dark { 0x283b44 } else { 0xdbe8ed }) }
    pub fn round(&self, dc: HDC, area: RECT, color: COLORREF, radius: i32) { unsafe {
        let brush = CreateSolidBrush(color); let pen = CreatePen(PS_SOLID,1,color);
        let old_b = SelectObject(dc,brush.into()); let old_p = SelectObject(dc,pen.into());
        let _ = RoundRect(dc,area.left,area.top,area.right,area.bottom,self.px(radius*2),self.px(radius*2));
        SelectObject(dc,old_b); SelectObject(dc,old_p); let _ = DeleteObject(brush.into()); let _ = DeleteObject(pen.into());
    } }
    pub fn fill(&self, dc: HDC, area: RECT, color: COLORREF) { unsafe {
        let brush = CreateSolidBrush(color); FillRect(dc, &area, brush); let _ = DeleteObject(brush.into());
    } }
    pub fn text(&self, dc: HDC, value: &str, mut area: RECT, font: HFONT, color: COLORREF) {
        // DrawTextW 的省略號路徑會讀取空 slice 的無效指標；沒有文字就不呼叫 Win32。
        if value.is_empty() || area.right <= area.left || area.bottom <= area.top { return; }
        unsafe {
            let old = SelectObject(dc, font.into()); SetBkMode(dc, TRANSPARENT); SetTextColor(dc, color);
            let mut text: Vec<u16> = value.encode_utf16().collect();
            DrawTextW(dc, &mut text, &mut area, DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX);
            SelectObject(dc, old);
        }
    }
    pub fn button(&self, item: &DRAWITEMSTRUCT, active: bool) {
        unsafe {
            let queue_close = matches!(item.CtlID as u16,QUEUE_CLOSE|QUEUE_ADD|QUEUE_REMOVE);
            FillRect(item.hDC, &item.rcItem, if queue_close { self.queue_panel } else { self.background });
            let pressed = item.itemState.0 & ODS_SELECTED.0 != 0;
            let focused = item.itemState.0 & ODS_FOCUS.0 != 0;
            let disabled = item.itemState.0 & ODS_DISABLED.0 != 0;
            let mut point = windows::Win32::Foundation::POINT::default(); let _ = GetCursorPos(&mut point);
            let _ = ScreenToClient(item.hwndItem, &mut point);
            let hover = point.x >= 0 && point.y >= 0 && point.x < item.rcItem.right && point.y < item.rcItem.bottom;
            let primary = item.CtlID == PLAY as u32;
            let bg = if primary { self.accent() } else if pressed || hover || active { if queue_close { rgb(0x283b44) } else { self.selection() } } else if queue_close { rgb(0x1c2123) } else { rgb(if self.dark { 0x111417 } else { 0xeef3f0 }) };
            let fill = CreateSolidBrush(bg);
            let pen = CreatePen(PS_SOLID, self.px(1), if focused { if queue_close { rgb(0x78a3b5) } else { self.accent() } } else { bg });
            let old_brush = SelectObject(item.hDC, fill.into()); let old_pen = SelectObject(item.hDC, pen.into());
            let _ = RoundRect(item.hDC, item.rcItem.left + 1, item.rcItem.top + 1, item.rcItem.right - 1,
                item.rcItem.bottom - 1, self.px(if primary { 40 } else { 8 }), self.px(if primary { 40 } else { 8 }));
            let mut text = [0u16; 80]; let count = GetWindowTextW(item.hwndItem, &mut text);
            let label = String::from_utf16_lossy(&text[..count as usize]);
            let glyph = match item.CtlID as u16 {
                OPEN => Some('\u{e8e5}'), LIST => Some('\u{e8f1}'), MORE => Some('\u{e712}'), QUEUE_CLOSE => Some('\u{e711}'),
                QUEUE_ADD => Some('\u{e710}'), QUEUE_REMOVE => Some('\u{e74d}'),
                PREV => Some('\u{e892}'), NEXT => Some('\u{e893}'),
                PLAY => Some(if label.starts_with("暫停") { '\u{e769}' } else { '\u{e768}' }),
                FULL => Some('\u{e740}'), FIT => Some('\u{e9a6}'), ROTATE => Some('\u{e7ad}'),
                ZOOM_IN => Some('\u{e8a3}'), ZOOM_OUT => Some('\u{e71f}'), HELP => Some('\u{e897}'),
                MUTE => Some(if label.starts_with("取消") { '\u{e74f}' } else { '\u{e767}' }),
                _ => None
            };
            let display = if item.CtlID == ACTUAL as u32 { "1:1".to_owned() } else if item.CtlID == SPEED as u32 { label.trim_start_matches("播放速度 ").to_owned() } else { glyph.map(|g| g.to_string()).unwrap_or(label) };
            let mut display: Vec<u16> = display.encode_utf16().collect();
            let old_font = SelectObject(item.hDC, if glyph.is_some() { self.icons } else { self.normal }.into());
            SetBkMode(item.hDC, TRANSPARENT);
            SetTextColor(item.hDC, if disabled { rgb(if self.dark { 0x747c7c } else { 0x74817f }) } else if primary { rgb(if self.dark { 0x0d1012 } else { 0xffffff }) } else if queue_close { rgb(0xf4f1e8) } else if active { self.accent() } else { self.text_color() });
            let mut area = item.rcItem;
            DrawTextW(item.hDC, &mut display, &mut area, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
            SelectObject(item.hDC, old_font); SelectObject(item.hDC, old_pen); SelectObject(item.hDC, old_brush);
            let _ = DeleteObject(fill.into()); let _ = DeleteObject(pen.into());
        }
    }
    pub fn base(&self, dc: HDC, area: &RECT) {
        unsafe { FillRect(dc, area, self.background); }
    }
    pub fn album(&self, dc: HDC, area: RECT) {
        unsafe {
            let size = (area.bottom-area.top).min(area.right-area.left).min(self.px(230));
            let x = (area.left+area.right-size)/2; let y = (area.top+area.bottom-size)/2;
            let brush = CreateSolidBrush(rgb(if self.dark { 0x20313a } else { 0xe0ecef }));
            let pen = CreatePen(PS_SOLID, self.px(2), self.accent());
            let old_b = SelectObject(dc, brush.into()); let old_p = SelectObject(dc, pen.into());
            let _ = RoundRect(dc, x, y, x+size, y+size, self.px(24), self.px(24));
            let old_font = SelectObject(dc,self.icons.into()); SetBkMode(dc,TRANSPARENT); SetTextColor(dc,self.accent());
            let mut note = ['\u{e8d6}' as u16]; let mut middle = rect(x,y,size,size);
            // 系統圖示字體有抗鋸齒；不額外載入圖片或讓空封面持續動畫。
            let big = CreateFontW(-size/3,0,0,0,400,0,0,0,DEFAULT_CHARSET,OUT_DEFAULT_PRECIS,CLIP_DEFAULT_PRECIS,CLEARTYPE_QUALITY,0,w!("Segoe MDL2 Assets"));
            SelectObject(dc,big.into()); DrawTextW(dc,&mut note,&mut middle,DT_CENTER|DT_VCENTER|DT_SINGLELINE);
            SelectObject(dc,old_font); let _ = DeleteObject(big.into());
            SelectObject(dc, old_b); SelectObject(dc, old_p);
            let _ = DeleteObject(brush.into()); let _ = DeleteObject(pen.into());
        }
    }
    pub fn queue(&self, item: &DRAWITEMSTRUCT, label: &str, detail: &str, active: bool) {
        if item.itemID == u32::MAX { return; }
        let p = |n| self.px(n); let r = item.rcItem;
        let selected = item.itemState.0 & (ODS_SELECTED.0|ODS_FOCUS.0) != 0;
        let hover = unsafe { GetPropW(item.hwndItem,w!("AxonDeckQueueHover")) }.0 as usize == item.itemID as usize+1;
        let ink = rgb(0xf4f1e8); let muted = rgb(0xc5c4bd); let accent = rgb(0x78a3b5);
        self.fill(item.hDC,r,rgb(0x1c2123));
        let inset = rect(r.left+p(6),r.top+p(3),r.right-r.left-p(20),r.bottom-r.top-p(6));
        if selected || active || hover { self.round(item.hDC,inset,rgb(if selected || active { 0x283b44 } else { 0x242c2f }),8); }
        let icon = rect(r.left+p(14),r.top+p(14),p(32),p(32));
        self.round(item.hDC,icon,if active { accent } else { rgb(0x343c3f) },8);
        let marker = if active { if detail.contains("暫停") { "\u{e769}".into() } else if detail.contains("顯示") { "\u{eb9f}".into() } else { "\u{e768}".into() } } else { format!("{:02}",item.itemID+1) };
        self.text(item.hDC,&marker,rect(icon.left+p(8),icon.top,p(24),p(32)),if active { self.icons } else { self.small },if active { rgb(0x111417) } else { muted });
        self.text(item.hDC,label,rect(r.left+p(56),r.top+p(8),r.right-r.left-p(78),p(24)),self.normal,ink);
        self.text(item.hDC,detail,rect(r.left+p(56),r.top+p(33),r.right-r.left-p(78),p(18)),self.small,if active { rgb(0x96bdc9) } else { muted });
    }
}
impl Drop for Paint {
    fn drop(&mut self) { unsafe {
        for font in [self.normal, self.heading, self.small, self.icons] { let _ = DeleteObject(font.into()); }
        let _ = DeleteObject(self.background.into());
        let _ = DeleteObject(self.panel.into());
        let _ = DeleteObject(self.queue_panel.into());
    } }
}
pub fn control(parent: HWND, class: PCWSTR, label: &str, id: u16, style: WINDOW_STYLE) -> windows::core::Result<HWND> {
    unsafe { CreateWindowExW(WINDOW_EX_STYLE(0), class, PCWSTR(wide(label).as_ptr()),
        WS_CHILD | WS_VISIBLE | style, 0, 0, 10, 10, Some(parent), Some(HMENU(id as usize as _)), None, None) }
}
pub fn button(parent: HWND, label: &str, id: u16) -> windows::core::Result<HWND> {
    let hwnd = control(parent, w!("BUTTON"), label, id, WS_TABSTOP | WINDOW_STYLE(BS_OWNERDRAW as u32))?;
    unsafe { let _ = SetWindowSubclass(hwnd, Some(button_proc), 1, 0); }
    Ok(hwnd)
}
unsafe extern "system" fn button_proc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM, _: usize, _: usize) -> windows::Win32::Foundation::LRESULT {
    if msg == WM_MOUSEMOVE { unsafe {
        let mut track = TRACKMOUSEEVENT { cbSize: size_of::<TRACKMOUSEEVENT>() as u32, dwFlags: TME_LEAVE, hwndTrack: hwnd, ..Default::default() };
        let _ = TrackMouseEvent(&mut track);
    } }
    let result=unsafe { DefSubclassProc(hwnd, msg, w, l) };
    // WM_SETTEXT/WM_ENABLE 可能同步畫圖；State 借用結束後仍須補畫新圖示。
    if matches!(msg, WM_SETTEXT | WM_MOUSEMOVE | WM_MOUSELEAVE | WM_SETFOCUS | WM_KILLFOCUS | WM_ENABLE) { unsafe { let _ = InvalidateRect(Some(hwnd), None, false); } }
    result
}
pub fn slider(parent: HWND, label: &str, id: u16, max: i32, dark: bool) -> windows::core::Result<HWND> {
    let hwnd = control(parent, TRACKBAR_CLASSW, label, id, WS_TABSTOP | WINDOW_STYLE(TBS_NOTICKS))?;
    unsafe {
        SetPropW(hwnd,w!("AxonDeckSliderTheme"),Some(windows::Win32::Foundation::HANDLE((dark as usize+1) as _)))?;
        let _=SetWindowSubclass(hwnd,Some(slider_proc),5,0); SendMessageW(hwnd, TBM_SETRANGEMAX, Some(WPARAM(1)), Some(LPARAM(max as isize)));
    }
    Ok(hwnd)
}
// 不借用播放器狀態，拖曳／更新數值時的同步重入也維持自繪。
pub fn slider_notification(msg:u32,l:LPARAM) -> Option<windows::Win32::Foundation::LRESULT> { unsafe {
    if msg!=WM_NOTIFY || l.0==0 { return None; }
    let header=&*(l.0 as *const NMHDR);
    if header.code!=NM_CUSTOMDRAW || !matches!(GetDlgCtrlID(header.hwndFrom),id if id==SEEK as i32 || id==VOLUME as i32 || id==SPEED_SLIDER as i32) { return None; }
    let item=&*(l.0 as *const NMCUSTOMDRAW); let theme=GetPropW(header.hwndFrom,w!("AxonDeckSliderTheme")).0 as usize;
    if item.dwDrawStage!=CDDS_PREPAINT || theme==0 { return None; }
    draw_slider(header.hwndFrom,item.hdc,theme==2); Some(windows::Win32::Foundation::LRESULT(CDRF_SKIPDEFAULT as isize))
} }
unsafe extern "system" fn slider_proc(hwnd: HWND,msg:u32,w:WPARAM,l:LPARAM,_:usize,_:usize) -> windows::Win32::Foundation::LRESULT { unsafe {
    // 原生拖曳只清舊 thumb；自繪圓點與填色較大，須在 BeginPaint 前擴大更新區。
    if msg==WM_PAINT { let _=InvalidateRect(Some(hwnd),None,false); }
    if msg==WM_PAINT && GetPropW(hwnd,w!("AxonDeckSliderProbe")).0 as usize!=0 {
        let mut damage=RECT::default(); let mut area=RECT::default();
        let _=GetUpdateRect(hwnd,Some(&mut damage),false); let _=GetClientRect(hwnd,&mut area);
        let full=damage.left==0 && damage.top==0 && damage.right==area.right && damage.bottom==area.bottom;
        let _=SetPropW(hwnd,w!("AxonDeckSliderFullPaint"),Some(windows::Win32::Foundation::HANDLE((full as usize+1) as _)));
    }
    if msg==WM_NCDESTROY { let _=RemovePropW(hwnd,w!("AxonDeckSliderTheme")); let _=RemovePropW(hwnd,w!("AxonDeckSliderPanel")); }
    if msg==WM_ERASEBKGND { return windows::Win32::Foundation::LRESULT(1); }
    DefSubclassProc(hwnd,msg,w,l)
} }
fn draw_slider(hwnd:HWND,dc:HDC,dark:bool) { unsafe {
    let mut area=RECT::default(); let _=GetClientRect(hwnd,&mut area);
    let scale=windows::Win32::UI::HiDpi::GetDpiForWindow(hwnd) as f32/96.; let p=|n:i32|(n as f32*scale).round() as i32;
    let memory=CreateCompatibleDC(Some(dc)); let bitmap=CreateCompatibleBitmap(dc,area.right.max(1),area.bottom.max(1)); let old=SelectObject(memory,bitmap.into());
    let panel=GetPropW(hwnd,w!("AxonDeckSliderPanel")).0 as usize!=0;
    let brush=HBRUSH(GetStockObject(DC_BRUSH).0); SetDCBrushColor(memory,rgb(if panel { if dark { 0x1c2123 } else { 0xf8f9f6 } } else if dark { 0x111417 } else { 0xeef3f0 })); FillRect(memory,&area,brush);
    let mut channel=RECT::default(); SendMessageW(hwnd,TBM_GETCHANNELRECT,None,Some(LPARAM(&mut channel as *mut _ as isize)));
    let max=SendMessageW(hwnd,TBM_GETRANGEMAX,None,None).0.max(1);
    let x=channel.left+((channel.right-channel.left) as i64*slider_pos(hwnd) as i64/max as i64) as i32; let y=area.bottom/2;
    let accent=rgb(if dark { 0x78a3b5 } else { 0x3d6a7d });
    for (right,color) in [(channel.right,rgb(if dark { 0x343c3f } else { 0xc6d0ce })),(x,accent)] {
        SetDCBrushColor(memory,color); FillRect(memory,&rect(channel.left,y-p(2),(right-channel.left).max(0),p(4)),brush);
    }
    let old_b=SelectObject(memory,GetStockObject(DC_BRUSH)); let old_p=SelectObject(memory,GetStockObject(DC_PEN));
    SetDCBrushColor(memory,accent); SetDCPenColor(memory,accent); let r=p(if GetFocus()==hwnd { 8 } else { 6 }); let _=Ellipse(memory,x-r,y-r,x+r,y+r);
    SelectObject(memory,old_b); SelectObject(memory,old_p);
    let _=BitBlt(dc,0,0,area.right,area.bottom,Some(memory),0,0,SRCCOPY);
    SelectObject(memory,old); let _=DeleteObject(bitmap.into()); let _=DeleteDC(memory);
} }
pub fn move_control(hwnd: HWND, area: RECT, show: bool) {
    move_controls(&[(hwnd,area,show)]);
}
pub fn move_controls(controls:&[(HWND,RECT,bool)]) { unsafe {
    let changed:Vec<_>=controls.iter().filter_map(|&(hwnd,area,show)| {
        let mut current=RECT::default(); let _=GetWindowRect(hwnd,&mut current);
        let mut origin=windows::Win32::Foundation::POINT { x:current.left,y:current.top };
        if let Ok(parent)=GetParent(hwnd) { let _=ScreenToClient(parent,&mut origin); }
        let visible=GetWindowLongPtrW(hwnd,GWL_STYLE) as u32 & WS_VISIBLE.0 != 0;
        if visible==show && origin.x==area.left && origin.y==area.top && current.right-current.left==area.right-area.left && current.bottom-current.top==area.bottom-area.top { return None; }
        let flags=SWP_NOZORDER|SWP_NOACTIVATE|SWP_NOREDRAW|SWP_NOCOPYBITS|
            if visible==show { SET_WINDOW_POS_FLAGS(0) } else if show { SWP_SHOWWINDOW } else { SWP_HIDEWINDOW };
        Some((hwnd,area,flags,show))
    }).collect();
    if changed.is_empty() { return; }
    let batch=(|| -> windows::core::Result<()> {
        let mut batch=BeginDeferWindowPos(changed.len() as i32)?;
        for &(hwnd,area,flags,_) in &changed { batch=DeferWindowPos(batch,hwnd,None,area.left,area.top,area.right-area.left,area.bottom-area.top,flags)?; }
        EndDeferWindowPos(batch)
    })();
    if let Err(error)=batch {
        eprintln!("media layout batch failed: {:?}",error.code());
        for &(hwnd,area,flags,_) in &changed { let _=SetWindowPos(hwnd,None,area.left,area.top,area.right-area.left,area.bottom-area.top,flags); }
    }
    for &(hwnd,_,_,show) in &changed {
        if show { let _=InvalidateRect(Some(hwnd),None,false); }
    }
    if let Ok(parent)=GetParent(changed[0].0) { let _=InvalidateRect(Some(parent),None,false); }
} }
pub fn queue_background(msg:u32,w:WPARAM,l:LPARAM) -> Option<windows::Win32::Foundation::LRESULT> {
    if !matches!(msg,WM_CTLCOLORLISTBOX|WM_CTLCOLOREDIT|WM_CTLCOLORSTATIC) { return None; }
    unsafe {
        if msg!=WM_CTLCOLORLISTBOX && GetDlgCtrlID(HWND(l.0 as _))!=QUEUE_SEARCH as i32 { return None; }
        let dc=HDC(w.0 as _); SetTextColor(dc,rgb(0xf4f1e8)); SetBkColor(dc,rgb(0x1c2123)); SetDCBrushColor(dc,rgb(0x1c2123));
        Some(windows::Win32::Foundation::LRESULT(GetStockObject(DC_BRUSH).0 as isize))
    }
}
pub fn slider_pos(hwnd: HWND) -> i32 { unsafe { SendMessageW(hwnd, WM_USER, None, None).0 as i32 } }
pub fn style_queue(hwnd: HWND, dark: bool) { unsafe { let _ = SetWindowSubclass(hwnd,Some(queue_proc),3,dark as usize); } }
pub fn style_search(hwnd: HWND) { unsafe { let _ = SetWindowSubclass(hwnd,Some(search_proc),4,0); } }
unsafe extern "system" fn search_proc(hwnd: HWND,msg: u32,w: WPARAM,l: LPARAM,_: usize,_: usize) -> windows::Win32::Foundation::LRESULT {
    unsafe {
        if msg==WM_CONTEXTMENU {
            if let Ok(parent)=GetParent(hwnd) { SendMessageW(parent,msg,Some(WPARAM(hwnd.0 as usize)),Some(l)); }
            return windows::Win32::Foundation::LRESULT(0);
        }
        let result=DefSubclassProc(hwnd,msg,w,l);
        if matches!(msg,WM_PAINT|WM_PRINTCLIENT) && GetWindowTextLengthW(hwnd)==0 {
            let dc=if msg==WM_PAINT { GetDC(Some(hwnd)) } else { HDC(w.0 as _) };
            let mut area=RECT::default(); let _=GetClientRect(hwnd,&mut area);
            let brush=CreateSolidBrush(rgb(0x1c2123)); FillRect(dc,&area,brush); let _=DeleteObject(brush.into());
            let font=SendMessageW(hwnd,WM_GETFONT,None,None); let old=SelectObject(dc,HGDIOBJ(font.0 as _));
            SetBkMode(dc,TRANSPARENT); SetTextColor(dc,rgb(0xc5c4bd));
            DrawTextW(dc,&mut wide("搜尋檔名 · Ctrl+F"),&mut area,DT_SINGLELINE|DT_VCENTER|DT_END_ELLIPSIS);
            SelectObject(dc,old); if msg==WM_PAINT { ReleaseDC(Some(hwnd),dc); }
        }
        result
    }
}
unsafe extern "system" fn queue_proc(hwnd: HWND,msg: u32,w: WPARAM,l: LPARAM,_: usize,dark: usize) -> windows::Win32::Foundation::LRESULT {
    unsafe {
        if msg==WM_PAINT {
            let mut paint=PAINTSTRUCT::default(); let dc=BeginPaint(hwnd,&mut paint);
            let mut area=RECT::default(); let _=GetClientRect(hwnd,&mut area);
            let memory=CreateCompatibleDC(Some(dc)); let bitmap=CreateCompatibleBitmap(dc,area.right.max(1),area.bottom.max(1));
            let old=SelectObject(memory,bitmap.into());
            // 列與捲軸先畫完才顯示，拖曳時不露出逐列清空的中間畫面。
            SendMessageW(hwnd,WM_PRINTCLIENT,Some(WPARAM(memory.0 as usize)),Some(LPARAM(PRF_CLIENT as isize)));
            let _=BitBlt(dc,0,0,area.right,area.bottom,Some(memory),0,0,SRCCOPY);
            SelectObject(memory,old); let _=DeleteObject(bitmap.into()); let _=DeleteDC(memory); let _=EndPaint(hwnd,&paint);
            return windows::Win32::Foundation::LRESULT(0);
        }
        if matches!(msg,WM_ERASEBKGND|WM_PRINTCLIENT) {
            let dc=HDC(w.0 as _); let mut area=RECT::default(); let _=GetClientRect(hwnd,&mut area);
            SetDCBrushColor(dc,rgb(0x1c2123)); FillRect(dc,&area,HBRUSH(GetStockObject(DC_BRUSH).0));
            if msg==WM_ERASEBKGND { return windows::Win32::Foundation::LRESULT(1); }
        }
        if msg == WM_NCDESTROY || msg == WM_CAPTURECHANGED {
            let _ = RemovePropW(hwnd,w!("AxonDeckQueueGrab"));
            if msg == WM_NCDESTROY { let _ = RemovePropW(hwnd,w!("AxonDeckQueueHover")); }
            return DefSubclassProc(hwnd,msg,w,l);
        }
        // 查詢 LB_* 會同步重入 subclass；只攔需要自繪／滑鼠操作的訊息。
        if !matches!(msg,WM_PAINT|WM_PRINTCLIENT|WM_MOUSEWHEEL|WM_MOUSEMOVE|WM_LBUTTONDOWN|WM_LBUTTONUP|WM_MOUSELEAVE) { return DefSubclassProc(hwnd,msg,w,l); }
        let mut area = RECT::default(); let _ = GetClientRect(hwnd,&mut area);
        let scale = windows::Win32::UI::HiDpi::GetDpiForWindow(hwnd) as f32/96.;
        let lane = (12.*scale) as i32;
        let count = SendMessageW(hwnd,LB_GETCOUNT,None,None).0.max(0);
        let row = SendMessageW(hwnd,LB_GETITEMHEIGHT,None,None).0.max(1);
        let page = (area.bottom as isize/row).max(1);
        let max = (count-page).max(0);
        let top = SendMessageW(hwnd,LB_GETTOPINDEX,None,None).0.max(0);
        let scroll = |index: isize| { SendMessageW(hwnd,LB_SETTOPINDEX,Some(WPARAM(index.clamp(0,max) as usize)),None); let _ = InvalidateRect(Some(hwnd),None,false); };
        let x = l.0 as u16 as i16 as i32; let y = (l.0>>16) as u16 as i16 as i32;
        if msg == WM_MOUSEWHEEL { scroll(top-if ((w.0>>16) as u16 as i16)>0 { 3 } else { -3 }); return windows::Win32::Foundation::LRESULT(0); }
        let thumb = ((area.bottom as isize*page/count.max(1)) as i32).max((24.*scale) as i32).min(area.bottom);
        if msg == WM_LBUTTONDOWN && max>0 && x>=area.right-lane {
            let thumb_top = ((area.bottom-thumb) as isize*top/max) as i32;
            let grab = if y>=thumb_top && y<thumb_top+thumb { y-thumb_top } else { thumb/2 };
            let _ = SetPropW(hwnd,w!("AxonDeckQueueGrab"),Some(windows::Win32::Foundation::HANDLE((grab+1) as _)));
            let _ = SetCapture(hwnd);
        }
        let grab = GetPropW(hwnd,w!("AxonDeckQueueGrab")).0 as isize;
        if (msg == WM_MOUSEMOVE || msg == WM_LBUTTONDOWN) && GetCapture() == hwnd && grab>0 {
            scroll(((y as isize-grab+1).max(0)*max)/(area.bottom-thumb).max(1) as isize);
            return windows::Win32::Foundation::LRESULT(0);
        }
        if msg == WM_LBUTTONUP && GetCapture() == hwnd && grab>0 { let _ = RemovePropW(hwnd,w!("AxonDeckQueueGrab")); let _ = ReleaseCapture(); return windows::Win32::Foundation::LRESULT(0); }
        if msg == WM_MOUSEMOVE {
            let index = SendMessageW(hwnd,LB_ITEMFROMPOINT,None,Some(l)).0;
            let hover = if index>>16 == 0 && x<area.right-lane { (index&0xffff)+1 } else { 0 };
            if GetPropW(hwnd,w!("AxonDeckQueueHover")).0 as isize != hover {
                let _ = SetPropW(hwnd,w!("AxonDeckQueueHover"),Some(windows::Win32::Foundation::HANDLE(hover as _)));
                let _ = InvalidateRect(Some(hwnd),None,false);
            }
            let mut cursor = windows::Win32::Foundation::POINT::default(); let _ = GetCursorPos(&mut cursor); let _ = ScreenToClient(hwnd,&mut cursor);
            if PtInRect(&area,cursor).as_bool() {
                let mut track = TRACKMOUSEEVENT { cbSize:size_of::<TRACKMOUSEEVENT>() as u32,dwFlags:TME_LEAVE,hwndTrack:hwnd,..Default::default() }; let _ = TrackMouseEvent(&mut track);
            }
        }
        if msg == WM_MOUSELEAVE { let _ = RemovePropW(hwnd,w!("AxonDeckQueueHover")); let _ = InvalidateRect(Some(hwnd),None,false); }
        let result = DefSubclassProc(hwnd,msg,w,l);
        if msg == WM_PRINTCLIENT {
            let dc = HDC(w.0 as _);
            let color = rgb(if dark != 0 { 0x1c2123 } else { 0xf8f9f6 });
            let brush = CreateSolidBrush(color); FillRect(dc,&rect(area.right-lane,0,lane,area.bottom),brush); let _ = DeleteObject(brush.into());
            if max>0 {
                let thumb = ((area.bottom as isize*page/count.max(1)) as i32).max((24.*scale) as i32).min(area.bottom);
                let top = SendMessageW(hwnd,LB_GETTOPINDEX,None,None).0;
                let y = ((area.bottom-thumb) as isize*top/max) as i32;
                let brush = CreateSolidBrush(rgb(if dark != 0 { 0x61767f } else { 0x3d6a7d }));
                FillRect(dc,&rect(area.right-(7.*scale) as i32,y,(3.*scale).max(2.) as i32,thumb),brush); let _ = DeleteObject(brush.into());
            }
        }
        result
    }
}
pub fn position(hwnd: HWND, value: i32) { unsafe {
    if slider_pos(hwnd)==value { return; }
    // redraw=true 會同步更新 Windows 的 thumb 命中區；自繪不代表可以略過它。
    SendMessageW(hwnd, TBM_SETPOS, Some(WPARAM(1)), Some(LPARAM(value as isize)));
    let _ = InvalidateRect(Some(hwnd), None, false);
} }
