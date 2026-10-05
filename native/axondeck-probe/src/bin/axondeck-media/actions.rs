//! 同一份動作同時供 Win32 控制、快捷鍵與 mpv 畫面使用。
pub const OPEN: u16 = 101;
pub const LIST: u16 = 102;
pub const MORE: u16 = 103;
pub const PREV: u16 = 104;
pub const PLAY: u16 = 105;
pub const NEXT: u16 = 106;
pub const FIT: u16 = 107;
pub const FULL: u16 = 108;
pub const SEEK: u16 = 109;
pub const VOLUME: u16 = 110;
pub const QUEUE: u16 = 111;
pub const STATUS: u16 = 112;
pub const MUTE: u16 = 113;
pub const SPEED: u16 = 114;
pub const ROTATE: u16 = 115;
pub const ACTUAL: u16 = 116;
pub const ZOOM_OUT: u16 = 117;
pub const ZOOM_IN: u16 = 118;
pub const HELP: u16 = 119;
pub const TOP: u16 = 121;
pub const REPEAT: u16 = 204;
pub const SHUFFLE: u16 = 205;
pub const SUB_OPEN: u16 = 211;
pub const SUB_OFF: u16 = 212;
pub const SHOT: u16 = 216;
pub const SPEED_DOWN: u16 = 217;
pub const SPEED_UP: u16 = 218;
pub const SPEED_RESET: u16 = 219;
pub const SEEK_BACK: u16 = 220;
pub const SEEK_FORWARD: u16 = 221;
pub const SEEK_FAR_BACK: u16 = 222;
pub const SEEK_FAR_FORWARD: u16 = 223;
pub const VOL_UP: u16 = 224;
pub const VOL_DOWN: u16 = 225;
pub const SUB_TOGGLE: u16 = 226;
pub const AUDIO_NEXT: u16 = 227;
pub const SUB_NEXT: u16 = 228;
pub const SUB_EARLIER: u16 = 229;
pub const SUB_LATER: u16 = 230;
pub const HOME: u16 = 231;
pub const END: u16 = 232;
pub const ESCAPE: u16 = 233;
pub const ANIM_PAUSE: u16 = 234;
pub const FRAME_FORWARD: u16 = 235;
pub const FRAME_BACK: u16 = 236;
pub const CLEAN_VIEW: u16 = 237;
pub const QUEUE_CLOSE: u16 = 238;
pub const QUEUE_ADD: u16 = 239;
pub const QUEUE_REMOVE: u16 = 240;
pub const QUEUE_SEARCH: u16 = 241;
pub const QUEUE_FIND: u16 = 242;
pub const SPEED_SLIDER: u16 = 243;

// mpv 與 Win32 都走 action()，避免畫面有焦點時操作另一套狀態。
pub fn shortcut(key: u32, ctrl: bool, shift: bool, image: bool) -> Option<u16> {
    if ctrl { return match key { 0x4f => Some(OPEN), 0x4c => Some(LIST), 0x46 => Some(QUEUE_FIND), 0x54 => Some(TOP), 0x48 => Some(CLEAN_VIEW), _ => None }; }
    Some(match key {
        0x20 => PLAY, 0x0d | 0x46 => FULL, 0x1b => ESCAPE, 0x70 => HELP,
        0x21 => PREV, 0x22 => NEXT, 0x24 => HOME, 0x23 => END,
        0x25 if image => PREV, 0x27 if image => NEXT,
        0x25 if shift => SEEK_FAR_BACK, 0x27 if shift => SEEK_FAR_FORWARD,
        0x25 => SEEK_BACK, 0x27 => SEEK_FORWARD, 0x26 => VOL_UP, 0x28 => VOL_DOWN,
        0x4d => MUTE, 0x52 if image => ROTATE, 0x52 => REPEAT, 0x4c => SHUFFLE,
        0xbb | 0x6b if image => ZOOM_IN, 0xbd | 0x6d if image => ZOOM_OUT,
        0x30 | 0x60 if image => FIT, 0x31 | 0x61 if image => ACTUAL,
        0x50 if image => ANIM_PAUSE, 0xbe if !image => FRAME_FORWARD, 0xbc if !image => FRAME_BACK,
        0xdb => SPEED_DOWN, 0xdd => SPEED_UP, 0x08 => SPEED_RESET,
        0x53 => SHOT, 0x56 => SUB_TOGGLE, 0x41 => AUDIO_NEXT, 0x43 => SUB_NEXT,
        0x4a => SUB_EARLIER, 0x4b => SUB_LATER,
        _ => return None
    })
}
pub fn bindings(image: bool) -> String {
    let mut text = if image {
        "MBTN_LEFT script-binding positioning/drag-to-pan\nWHEEL_UP script-binding positioning/cursor-centric-zoom 0.15\nWHEEL_DOWN script-binding positioning/cursor-centric-zoom -0.15\n".to_owned()
    } else { "MBTN_LEFT script-message axondeck action 105\nWHEEL_UP script-message axondeck action 224\nWHEEL_DOWN script-message axondeck action 225\n".to_owned() };
    for (mpv, key, ctrl, shift) in [
        ("SPACE",0x20,false,false),("ENTER",0x0d,false,false),("f",0x46,false,false),("ESC",0x1b,false,false),
        ("F1",0x70,false,false),("PGUP",0x21,false,false),("PGDWN",0x22,false,false),
        ("HOME",0x24,false,false),("END",0x23,false,false),("LEFT",0x25,false,false),("RIGHT",0x27,false,false),
        ("Shift+LEFT",0x25,false,true),("Shift+RIGHT",0x27,false,true),("UP",0x26,false,false),("DOWN",0x28,false,false),
        ("m",0x4d,false,false),("r",0x52,false,false),("l",0x4c,false,false),
        ("+",0xbb,false,true),("-",0xbd,false,false),("KP_ADD",0x6b,false,false),("KP_SUBTRACT",0x6d,false,false),
        ("0",0x30,false,false),("1",0x31,false,false),("[",0xdb,false,false),("]",0xdd,false,false),
        ("p",0x50,false,false),(".",0xbe,false,false),(",",0xbc,false,false),
        ("BS",0x08,false,false),("s",0x53,false,false),("v",0x56,false,false),("a",0x41,false,false),
        ("c",0x43,false,false),("j",0x4a,false,false),("k",0x4b,false,false),
        ("Ctrl+o",0x4f,true,false),("Ctrl+l",0x4c,true,false),("Ctrl+f",0x46,true,false),("Ctrl+t",0x54,true,false),("Ctrl+h",0x48,true,false)
    ] {
        if let Some(id) = shortcut(key, ctrl, shift, image) { text.push_str(&format!("{mpv} script-message axondeck action {id}\n")); }
    }
    text.push_str("MBTN_LEFT_DBL script-message axondeck action 108\nMBTN_RIGHT script-message axondeck action 103\n");
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shortcuts_match_decoder_and_preserve_modifiers() {
        assert_eq!(shortcut(0x25, false, false, true), Some(PREV));
        assert_eq!(shortcut(0x25, false, true, false), Some(SEEK_FAR_BACK));
        assert_eq!(shortcut(0x4f, true, false, false), Some(OPEN));
        assert_eq!(shortcut(0x53, true, false, false), None);
        assert_eq!(shortcut(0x31, false, false, true), Some(ACTUAL));
        assert_eq!(shortcut(0x50,false,false,true),Some(ANIM_PAUSE));
        assert_eq!(shortcut(0xbe,false,false,false),Some(FRAME_FORWARD));
        assert!(bindings(true).contains("1 script-message axondeck action 116"));
        assert!(bindings(false).contains("Shift+RIGHT script-message axondeck action 223"));
        assert!(bindings(false).contains("MBTN_LEFT script-message axondeck action 105"));
        assert_eq!(shortcut(0x48,true,false,true),Some(CLEAN_VIEW));
        assert!(bindings(false).contains("Ctrl+h script-message axondeck action 237"));
    }
}
