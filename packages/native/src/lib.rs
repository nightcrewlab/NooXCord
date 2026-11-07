//! NooXCord native helpers (Windows). Loaded by the Electron main process only.
//!  * Process-loopback system audio that EXCLUDES our own process tree (CLAUDE.md §6.3, ADR 0002 / P3)
//!  * Key state polling for global push-to-talk
//! Every function returns a Result or a plain value; JS wraps calls in try/catch.

#[macro_use]
extern crate napi_derive;

use napi::bindgen_prelude::*;

#[napi(object)]
pub struct LoopbackInfo {
    pub sample_rate: u32,
    pub channels: u32,
}

#[cfg(windows)]
mod loopback {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::thread::JoinHandle;
    use wasapi::*;

    pub const RATE: usize = 48000;
    pub const CHANNELS: usize = 2;
    const MAX_BUFFERED: usize = RATE * CHANNELS; // 1 s

    pub struct Capture {
        pub stop: Arc<AtomicBool>,
        pub buf: Arc<Mutex<VecDeque<f32>>>,
        pub thread: Option<JoinHandle<()>>,
    }

    pub static CURRENT: Mutex<Option<Capture>> = Mutex::new(None);

    fn run(pid: u32, stop: Arc<AtomicBool>, buf: Arc<Mutex<VecDeque<f32>>>, ready: mpsc::Sender<Result<(), String>>) {
        let res = (|| -> Result<(), Box<dyn std::error::Error>> {
            initialize_mta().ok()?;
            let fmt = WaveFormat::new(32, 32, &SampleType::Float, RATE, CHANNELS, None);
            let align = fmt.get_blockalign() as usize;
            // include_tree = false -> PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
            let mut client = AudioClient::new_application_loopback_client(pid, false)?;
            client.initialize_client(&fmt, &Direction::Capture, &StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 0 })?;
            let ev = client.set_get_eventhandle()?;
            let cap = client.get_audiocaptureclient()?;
            client.start_stream()?;
            let _ = ready.send(Ok(()));
            let mut raw: VecDeque<u8> = VecDeque::new();
            while !stop.load(Ordering::Relaxed) {
                while cap.get_next_packet_size()?.unwrap_or(0) > 0 {
                    cap.read_from_device_to_deque(&mut raw)?;
                }
                let samples = (raw.len() / align) * CHANNELS;
                if samples > 0 {
                    let bytes: Vec<u8> = raw.drain(..samples * 4).collect();
                    let mut out = buf.lock().unwrap();
                    out.extend(bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])));
                    let excess = out.len().saturating_sub(MAX_BUFFERED);
                    out.drain(..excess);
                }
                let _ = ev.wait_for_event(100);
            }
            client.stop_stream()?;
            Ok(())
        })();
        if let Err(e) = res {
            let _ = ready.send(Err(e.to_string()));
        }
    }

    pub fn start(pid: u32) -> Result<(), String> {
        stop();
        let stop_flag = Arc::new(AtomicBool::new(false));
        let buf = Arc::new(Mutex::new(VecDeque::with_capacity(MAX_BUFFERED)));
        let (tx, rx) = mpsc::channel();
        let (s2, b2) = (stop_flag.clone(), buf.clone());
        let thread = std::thread::Builder::new()
            .name("nx-loopback".into())
            .spawn(move || run(pid, s2, b2, tx))
            .map_err(|e| e.to_string())?;
        match rx.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(Ok(())) => {
                *CURRENT.lock().unwrap() = Some(Capture { stop: stop_flag, buf, thread: Some(thread) });
                Ok(())
            }
            Ok(Err(e)) => Err(e),
            Err(_) => {
                stop_flag.store(true, Ordering::Relaxed);
                Err("loopback start timed out".into())
            }
        }
    }

    pub fn read() -> Vec<f32> {
        let guard = CURRENT.lock().unwrap();
        match guard.as_ref() {
            Some(c) => c.buf.lock().unwrap().drain(..).collect(),
            None => Vec::new(),
        }
    }

    pub fn stop() {
        let cur = CURRENT.lock().unwrap().take();
        if let Some(mut c) = cur {
            c.stop.store(true, Ordering::Relaxed);
            if let Some(t) = c.thread.take() {
                let _ = t.join();
            }
        }
    }
}

/// Start capturing system audio, excluding the process tree of `exclude_pid`.
#[napi]
pub fn loopback_start(exclude_pid: u32) -> Result<LoopbackInfo> {
    #[cfg(windows)]
    {
        loopback::start(exclude_pid).map_err(Error::from_reason)?;
        Ok(LoopbackInfo { sample_rate: loopback::RATE as u32, channels: loopback::CHANNELS as u32 })
    }
    #[cfg(not(windows))]
    {
        let _ = exclude_pid;
        Err(Error::from_reason("not supported on this platform"))
    }
}

/// Drain captured interleaved float32 PCM.
#[napi]
pub fn loopback_read() -> Float32Array {
    #[cfg(windows)]
    {
        Float32Array::new(loopback::read())
    }
    #[cfg(not(windows))]
    {
        Float32Array::new(Vec::new())
    }
}

#[napi]
pub fn loopback_stop() {
    #[cfg(windows)]
    loopback::stop();
}

/// Is the virtual key currently held down (anywhere in the system)?
#[napi]
pub fn key_down(vk: u32) -> bool {
    #[cfg(windows)]
    unsafe {
        (windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(vk as i32) as u16 & 0x8000) != 0
    }
    #[cfg(not(windows))]
    {
        let _ = vk;
        false
    }
}

/// Exclusive (D3D) fullscreen app in the foreground? Our overlay cannot draw over those
/// (CLAUDE.md §8): the app then suggests borderless mode. Uses SHQueryUserNotificationState.
#[napi]
pub fn exclusive_fullscreen() -> bool {
    #[cfg(windows)]
    unsafe {
        let mut state: i32 = 0;
        // QUNS_RUNNING_D3D_FULL_SCREEN = 3
        windows_sys::Win32::UI::Shell::SHQueryUserNotificationState(&mut state) >= 0 && state == 3
    }
    #[cfg(not(windows))]
    {
        false
    }
}
