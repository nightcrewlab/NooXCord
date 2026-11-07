//! Faz 0 / P3: WASAPI process loopback — can we capture system audio while EXCLUDING
//! our own process tree (so viewers never hear themselves in a stream)?
//!
//! Test setup (all tones quiet, ~5 s):
//!   * 1000 Hz played by this process            (own process)        -> must be EXCLUDED
//!   * 1500 Hz played by a child process          (own process tree)   -> must be EXCLUDED
//!   * 2000 Hz played by a process outside the tree (via WMI)          -> must be CAPTURED
//! Then we capture twice: INCLUDE(own tree) and EXCLUDE(own tree), and measure each tone.

use std::collections::VecDeque;
use std::f64::consts::PI;
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};
use wasapi::*;

type Res<T> = Result<T, Box<dyn std::error::Error>>;
const RATE: usize = 48000;
const AMP: f64 = 0.04;

fn play_tone(freq: f64, secs: f64) -> Res<()> {
    initialize_mta().ok()?;
    let dev = DeviceEnumerator::new()?.get_default_device(&Direction::Render)?;
    let mut client = dev.get_iaudioclient()?;
    let fmt = WaveFormat::new(32, 32, &SampleType::Float, RATE, 2, None);
    let align = fmt.get_blockalign() as usize;
    let (def, _) = client.get_device_period()?;
    client.initialize_client(&fmt, &Direction::Render, &StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: def })?;
    let ev = client.set_get_eventhandle()?;
    let render = client.get_audiorenderclient()?;
    let mut n: u64 = 0;
    let mut write = |frames: usize| -> Res<()> {
        let mut data = vec![0u8; frames * align];
        for fr in data.chunks_exact_mut(align) {
            let s = ((2.0 * PI * freq * n as f64 / RATE as f64).sin() * AMP) as f32;
            n += 1;
            fr[0..4].copy_from_slice(&s.to_le_bytes());
            fr[4..8].copy_from_slice(&s.to_le_bytes());
        }
        render.write_to_device(frames, &data, None)?;
        Ok(())
    };
    write(client.get_available_space_in_frames()? as usize)?;
    client.start_stream()?;
    let end = Instant::now() + Duration::from_secs_f64(secs);
    while Instant::now() < end {
        ev.wait_for_event(1000)?;
        write(client.get_available_space_in_frames()? as usize)?;
    }
    client.stop_stream()?;
    Ok(())
}

/// Captures `secs` seconds of mono f32 audio using process loopback.
fn capture(pid: u32, include_tree: bool, secs: f64) -> Res<Vec<f32>> {
    initialize_mta().ok()?;
    let fmt = WaveFormat::new(32, 32, &SampleType::Float, RATE, 2, None);
    let align = fmt.get_blockalign() as usize;
    let mut client = AudioClient::new_application_loopback_client(pid, include_tree)?;
    client.initialize_client(&fmt, &Direction::Capture, &StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 0 })?;
    let ev = client.set_get_eventhandle()?;
    let cap = client.get_audiocaptureclient()?;
    let mut q: VecDeque<u8> = VecDeque::new();
    client.start_stream()?;
    let end = Instant::now() + Duration::from_secs_f64(secs);
    while Instant::now() < end {
        if cap.get_next_packet_size()?.unwrap_or(0) > 0 {
            cap.read_from_device_to_deque(&mut q)?;
        }
        let _ = ev.wait_for_event(200);
    }
    client.stop_stream()?;
    let bytes: Vec<u8> = q.into_iter().collect();
    Ok(bytes.chunks_exact(align).map(|f| f32::from_le_bytes([f[0], f[1], f[2], f[3]])).collect())
}

/// Goertzel: estimated amplitude of `freq` in `x`.
fn tone_amp(x: &[f32], freq: f64) -> f64 {
    if x.is_empty() { return 0.0; }
    let w = 2.0 * PI * freq / RATE as f64;
    let c = 2.0 * w.cos();
    let (mut s1, mut s2) = (0.0f64, 0.0f64);
    for &v in x {
        let s0 = v as f64 + c * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    let p = s1 * s1 + s2 * s2 - c * s1 * s2;
    2.0 * p.max(0.0).sqrt() / x.len() as f64
}

fn main() -> Res<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("tone") {
        let f: f64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(1500.0);
        let secs: f64 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(6.0);
        return play_tone(f, secs);
    }

    let me = std::process::id();
    let exe = std::env::current_exe()?;
    println!("P3 process-loopback test · pid {me}");

    // 1000 Hz from this process
    let own = thread::spawn(|| play_tone(1000.0, 6.5).map_err(|e| e.to_string()));
    // 1500 Hz from a child (inside our tree)
    let mut child = Command::new(&exe).args(["tone", "1500", "6.5"]).spawn()?;
    // 2000 Hz from a process OUTSIDE our tree: WMI creates it with WmiPrvSE as parent
    let cmdline = format!("\"{}\" tone 2000 6.5", exe.display());
    let wmi = Command::new("powershell")
        .args(["-NoProfile", "-Command", &format!("(Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{{CommandLine='{}'}}).ProcessId", cmdline)])
        .output()?;
    println!("  outside-tree tone pid: {}", String::from_utf8_lossy(&wmi.stdout).trim());

    thread::sleep(Duration::from_millis(900));
    let inc = capture(me, true, 2.0)?;
    let exc = capture(me, false, 2.0)?;
    let _ = own.join();
    let _ = child.wait();

    let row = |name: &str, x: &[f32]| {
        println!("  {name:<22} samples={:<7} 1000Hz(own)={:.4}  1500Hz(child)={:.4}  2000Hz(outside)={:.4}",
            x.len(), tone_amp(x, 1000.0), tone_amp(x, 1500.0), tone_amp(x, 2000.0));
    };
    row("INCLUDE own tree", &inc);
    row("EXCLUDE own tree", &exc);

    let th = AMP * 0.25;
    let checks = [
        ("include captures own tone", tone_amp(&inc, 1000.0) > th),
        ("include captures child tone", tone_amp(&inc, 1500.0) > th),
        ("include ignores outside tone", tone_amp(&inc, 2000.0) < th),
        ("exclude drops own tone", tone_amp(&exc, 1000.0) < th),
        ("exclude drops child tone", tone_amp(&exc, 1500.0) < th),
        ("exclude keeps outside tone", tone_amp(&exc, 2000.0) > th),
    ];
    let mut pass = true;
    for (n, ok) in checks {
        println!("  {} {n}", if ok { "✓" } else { "✗" });
        pass &= ok;
    }
    println!("P3 {}", if pass { "PASS" } else { "FAIL" });
    std::process::exit(if pass { 0 } else { 1 });
}
