//! Remote control (CLAUDE.md §7): SendInput injection + detection of the local user's own input.
//! Injected events carry INJECT_TAG in dwExtraInfo so the low-level hooks can tell them apart from
//! physical input (which always wins for 2 s, enforced in the main process).

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Mutex;
use windows_sys::Win32::Foundation::{LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows_sys::Win32::System::SystemInformation::GetTickCount64;
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
use windows_sys::Win32::UI::WindowsAndMessaging::*;

pub const INJECT_TAG: usize = 0x4E58_5243; // "NXRC"
static LAST_PHYSICAL: AtomicU64 = AtomicU64::new(0);
static HOOK_THREAD: AtomicU32 = AtomicU32::new(0);
static GUARD: Mutex<Option<std::thread::JoinHandle<()>>> = Mutex::new(None);

fn send(inputs: &[INPUT]) -> bool {
    unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32) == inputs.len() as u32 }
}

fn mouse(dx: i32, dy: i32, data: u32, flags: u32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 { mi: MOUSEINPUT { dx, dy, mouseData: data, dwFlags: flags, time: 0, dwExtraInfo: INJECT_TAG } },
    }
}

/// Absolute move to physical virtual-desktop pixel (x, y).
pub fn move_to(x: i32, y: i32) -> bool {
    let (vx, vy, vw, vh) = unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    };
    if vw <= 1 || vh <= 1 {
        return false;
    }
    let nx = (((x - vx) as i64 * 65535) / (vw - 1) as i64) as i32;
    let ny = (((y - vy) as i64 * 65535) / (vh - 1) as i64) as i32;
    send(&[mouse(nx, ny, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK)])
}

/// button: 0 left, 1 middle, 2 right, 3 back (X1), 4 forward (X2).
pub fn button(b: u32, down: bool) -> bool {
    let (flags, data) = match (b, down) {
        (0, true) => (MOUSEEVENTF_LEFTDOWN, 0),
        (0, false) => (MOUSEEVENTF_LEFTUP, 0),
        (1, true) => (MOUSEEVENTF_MIDDLEDOWN, 0),
        (1, false) => (MOUSEEVENTF_MIDDLEUP, 0),
        (2, true) => (MOUSEEVENTF_RIGHTDOWN, 0),
        (2, false) => (MOUSEEVENTF_RIGHTUP, 0),
        (3, d) => (if d { MOUSEEVENTF_XDOWN } else { MOUSEEVENTF_XUP }, 1),
        (4, d) => (if d { MOUSEEVENTF_XDOWN } else { MOUSEEVENTF_XUP }, 2),
        _ => return false,
    };
    send(&[mouse(0, 0, data, flags)])
}

/// Wheel in WHEEL_DELTA (120) units; positive dy scrolls up, positive dx scrolls right.
pub fn wheel(dx: i32, dy: i32) -> bool {
    let mut v = Vec::new();
    if dy != 0 {
        v.push(mouse(0, 0, dy as u32, MOUSEEVENTF_WHEEL));
    }
    if dx != 0 {
        v.push(mouse(0, 0, dx as u32, MOUSEEVENTF_HWHEEL));
    }
    v.is_empty() || send(&v)
}

/// Key by virtual-key code, sent with its scan code so games that read scan codes see it too.
pub fn key(vk: u32, down: bool) -> bool {
    let sc = unsafe { MapVirtualKeyW(vk, MAPVK_VK_TO_VSC_EX) };
    let mut flags = if down { 0 } else { KEYEVENTF_KEYUP };
    if sc == 0 {
        let ki = KEYBDINPUT { wVk: vk as u16, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: INJECT_TAG };
        return send(&[INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki } }]);
    }
    if sc & 0xFF00 == 0xE000 {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    let ki = KEYBDINPUT { wVk: vk as u16, wScan: (sc & 0xFF) as u16, dwFlags: flags | KEYEVENTF_SCANCODE, time: 0, dwExtraInfo: INJECT_TAG };
    send(&[INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki } }])
}

fn now() -> u64 {
    unsafe { GetTickCount64() }
}

unsafe extern "system" fn mouse_proc(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code >= 0 {
        let info = &*(l as *const MSLLHOOKSTRUCT);
        if info.dwExtraInfo != INJECT_TAG {
            LAST_PHYSICAL.store(now(), Ordering::Relaxed);
        }
    }
    CallNextHookEx(std::ptr::null_mut(), code, w, l)
}

unsafe extern "system" fn key_proc(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code >= 0 {
        let info = &*(l as *const KBDLLHOOKSTRUCT);
        if info.dwExtraInfo != INJECT_TAG {
            LAST_PHYSICAL.store(now(), Ordering::Relaxed);
        }
    }
    CallNextHookEx(std::ptr::null_mut(), code, w, l)
}

/// Start the low-level hooks on their own thread with a message loop.
pub fn guard_start() -> Result<(), String> {
    let mut g = GUARD.lock().unwrap();
    if g.is_some() {
        return Ok(());
    }
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let handle = std::thread::Builder::new()
        .name("nx-input-guard".into())
        .spawn(move || unsafe {
            let km = SetWindowsHookExW(WH_KEYBOARD_LL, Some(key_proc), std::ptr::null_mut(), 0);
            let mm = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), std::ptr::null_mut(), 0);
            if km.is_null() || mm.is_null() {
                if !km.is_null() {
                    UnhookWindowsHookEx(km);
                }
                if !mm.is_null() {
                    UnhookWindowsHookEx(mm);
                }
                let _ = tx.send(Err("SetWindowsHookEx failed".into()));
                return;
            }
            HOOK_THREAD.store(GetCurrentThreadId(), Ordering::SeqCst);
            let _ = tx.send(Ok(()));
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {}
            UnhookWindowsHookEx(km);
            UnhookWindowsHookEx(mm);
        })
        .map_err(|e| e.to_string())?;
    match rx.recv_timeout(std::time::Duration::from_secs(3)) {
        Ok(Ok(())) => {
            *g = Some(handle);
            Ok(())
        }
        Ok(Err(e)) => Err(e),
        Err(_) => Err("input guard start timed out".into()),
    }
}

pub fn guard_stop() {
    let h = GUARD.lock().unwrap().take();
    if let Some(h) = h {
        let tid = HOOK_THREAD.swap(0, Ordering::SeqCst);
        if tid != 0 {
            unsafe { PostThreadMessageW(tid, WM_QUIT, 0, 0) };
        }
        let _ = h.join();
    }
}

/// Milliseconds since the last physical keyboard/mouse input; huge when none was seen.
pub fn idle_ms() -> f64 {
    let last = LAST_PHYSICAL.load(Ordering::Relaxed);
    if last == 0 {
        f64::MAX
    } else {
        now().saturating_sub(last) as f64
    }
}

/// Visible frame of a top-level window in physical pixels (DWM extended frame bounds).
pub fn window_rect(hwnd: i64) -> Option<(i32, i32, i32, i32)> {
    let h = hwnd as isize as *mut core::ffi::c_void;
    unsafe {
        if IsWindow(h) == 0 || IsIconic(h) != 0 {
            return None;
        }
        let mut r: RECT = std::mem::zeroed();
        let hr = DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS as u32, &mut r as *mut RECT as *mut _, std::mem::size_of::<RECT>() as u32);
        if hr < 0 {
            return None;
        }
        Some((r.left, r.top, r.right - r.left, r.bottom - r.top))
    }
}

/// Current foreground window handle (0 when none).
pub fn foreground() -> i64 {
    unsafe { GetForegroundWindow() as isize as i64 }
}
