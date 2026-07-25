// Phase 1 of docs/design/freeze-watchdog.md: heartbeat + trigger detection + diagnostics
// logging. Recovery (window.eval/reload/SIGKILL tiers) is NOT implemented yet — this
// phase only measures the false-positive rate of the 6s silence trigger across normal
// use. See the design doc's "Phases" section.
//
// Every observed WebKitGTK freeze lives in a WebKitWebProcess, a separate OS process from
// this one — so a dedicated thread here can watch heartbeats from the frontend without
// itself being affected by a frozen webview.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

// A window that has beaten at least once and then goes silent for this long is
// considered frozen. Generous enough to absorb Vite HMR reloads (~1-2s) in dev.
const SILENCE_THRESHOLD: Duration = Duration::from_secs(6);
const POLL_INTERVAL: Duration = Duration::from_secs(1);
// sysconf(_SC_CLK_TCK) is 100 on every Linux target this app ships to; not worth a
// libc dependency for a diagnostics-only reading.
const CLK_TCK: f64 = 100.0;

struct WindowBeat {
    last_beat: Instant,
    last_stats: serde_json::Value,
    // True while this window is in a silence episode we've already logged a trigger for
    // (so we don't re-log every poll tick while it stays silent).
    triggered: bool,
}

pub struct Inner {
    windows: HashMap<String, WindowBeat>,
}

/// Shared handle: registered in Tauri managed state and captured by the watchdog thread.
pub type WatchdogPersist = Arc<Mutex<Inner>>;

pub fn new_persist() -> WatchdogPersist {
    Arc::new(Mutex::new(Inner { windows: HashMap::new() }))
}

#[tauri::command]
pub fn watchdog_heartbeat(
    window: String,
    stats: serde_json::Value,
    state: tauri::State<'_, WatchdogPersist>,
) {
    let mut inner = state.lock().unwrap();
    let now = Instant::now();
    match inner.windows.get_mut(&window) {
        Some(beat) => {
            if beat.triggered {
                log::warn!(
                    "[watchdog] window '{window}' heartbeat resumed after {:.1}s silence",
                    beat.last_beat.elapsed().as_secs_f64()
                );
                beat.triggered = false;
            }
            beat.last_beat = now;
            beat.last_stats = stats;
        }
        None => {
            inner.windows.insert(window, WindowBeat { last_beat: now, last_stats: stats, triggered: false });
        }
    }
}

struct ProcStat {
    ppid: i32,
    comm: String,
    state: char,
    utime: u64,
    stime: u64,
    starttime: u64,
}

// Parses /proc/<pid>/stat. The comm field is delimited by the last ')' since it can
// itself contain spaces or parens.
fn read_proc_stat(pid: i32) -> Option<ProcStat> {
    let raw = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let comm_start = raw.find('(')?;
    let comm_end = raw.rfind(')')?;
    let comm = raw[comm_start + 1..comm_end].to_string();
    let rest: Vec<&str> = raw[comm_end + 2..].split_whitespace().collect();
    // Fields after comm, 0-indexed here: 0=state 1=ppid ... 11=utime 12=stime ... 19=starttime
    // (matches man 5 proc field numbers 3, 4, 14, 15, 22, each shifted down by the two
    // leading pid/comm fields we already consumed).
    Some(ProcStat {
        state: rest.first()?.chars().next()?,
        ppid: rest.get(1)?.parse().ok()?,
        utime: rest.get(11)?.parse().ok()?,
        stime: rest.get(12)?.parse().ok()?,
        starttime: rest.get(19)?.parse().ok()?,
        comm,
    })
}

fn all_pids() -> Vec<i32> {
    let mut pids = Vec::new();
    if let Ok(entries) = fs::read_dir("/proc") {
        for entry in entries.flatten() {
            if let Some(pid) = entry.file_name().to_str().and_then(|s| s.parse::<i32>().ok()) {
                pids.push(pid);
            }
        }
    }
    pids
}

// Enumerates all descendants of `root` by walking the whole /proc ppid tree rather than
// just direct children — the sandbox may interpose a bwrap layer between this process
// and WebKitWebProcess.
fn descendant_pids(root: i32) -> Vec<i32> {
    let mut children: HashMap<i32, Vec<i32>> = HashMap::new();
    for pid in all_pids() {
        if let Some(stat) = read_proc_stat(pid) {
            children.entry(stat.ppid).or_default().push(pid);
        }
    }
    let mut out = Vec::new();
    let mut queue = vec![root];
    while let Some(p) = queue.pop() {
        if let Some(kids) = children.get(&p) {
            for &k in kids {
                out.push(k);
                queue.push(k);
            }
        }
    }
    out
}

fn uptime_secs() -> Option<f64> {
    let raw = fs::read_to_string("/proc/uptime").ok()?;
    raw.split_whitespace().next()?.parse().ok()
}

struct WebkitSample {
    pid: i32,
    comm: String,
    state: char,
    etimes: f64,
    dutime: u64,
    dstime: u64,
}

// Samples every WebKitWebProcess descendant, diffing utime/stime against the previous
// call's readings (`prior`, kept alive across watchdog thread ticks) so a triggered
// diagnostic dump can report real per-second CPU deltas instead of a single snapshot.
fn sample_webkit_processes(prior: &mut HashMap<i32, (u64, u64)>) -> Vec<WebkitSample> {
    let own_pid = std::process::id() as i32;
    let uptime = uptime_secs().unwrap_or(0.0);
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for pid in descendant_pids(own_pid) {
        let Some(stat) = read_proc_stat(pid) else { continue };
        if !stat.comm.contains("WebKit") {
            continue;
        }
        seen.insert(pid);
        let (dutime, dstime) = match prior.get(&pid) {
            Some(&(pu, ps)) => (stat.utime.saturating_sub(pu), stat.stime.saturating_sub(ps)),
            None => (0, 0),
        };
        prior.insert(pid, (stat.utime, stat.stime));
        out.push(WebkitSample {
            pid,
            state: stat.state,
            etimes: (uptime - stat.starttime as f64 / CLK_TCK).max(0.0),
            comm: stat.comm,
            dutime,
            dstime,
        });
    }
    prior.retain(|pid, _| seen.contains(pid));
    out
}

/// Spawns the dedicated watchdog thread. Wakes every second; on a window's first tick
/// past `SILENCE_THRESHOLD` of no heartbeat, logs a diagnostics dump. Does NOT attempt
/// any recovery — phase 1 is observe-only (see design doc "Phases").
pub fn spawn_watchdog(state: WatchdogPersist) {
    thread::spawn(move || {
        let mut prior_cpu: HashMap<i32, (u64, u64)> = HashMap::new();
        loop {
            thread::sleep(POLL_INTERVAL);

            // Sample every tick (not just on trigger) so utime/stime deltas reflect a
            // real 1s window by the time a trigger fires, rather than a first reading of 0.
            let samples = sample_webkit_processes(&mut prior_cpu);

            let mut triggers: Vec<(String, serde_json::Value)> = Vec::new();
            {
                let mut inner = state.lock().unwrap();
                for (label, beat) in inner.windows.iter_mut() {
                    if !beat.triggered && beat.last_beat.elapsed() >= SILENCE_THRESHOLD {
                        beat.triggered = true;
                        triggers.push((label.clone(), beat.last_stats.clone()));
                    }
                }
            }

            for (label, stats) in &triggers {
                log::error!(
                    "[watchdog] TRIGGER: window '{label}' silent for >= {}s — last stats: {stats}",
                    SILENCE_THRESHOLD.as_secs()
                );
                if samples.is_empty() {
                    log::error!("[watchdog]   no WebKitWebProcess descendants found (already exited?)");
                }
                for s in &samples {
                    let parked = s.dutime == 0 && s.dstime == 0 && s.state != 'R';
                    log::error!(
                        "[watchdog]   descendant pid={} comm={} state={} etimes={:.0}s Δutime={} Δstime={}{}",
                        s.pid, s.comm, s.state, s.etimes, s.dutime, s.dstime,
                        if parked { " [near-0%-CPU, all-parked — matches known deadlock signature]" } else { "" },
                    );
                }
                log::warn!(
                    "[watchdog] recovery is DISABLED (phase 1: observe-only) — no action taken for '{label}'"
                );
            }
        }
    });
}
