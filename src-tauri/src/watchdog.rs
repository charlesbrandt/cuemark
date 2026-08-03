// Phase 3 of docs/design/freeze-watchdog.md: heartbeat + trigger detection + diagnostics
// logging + tiered recovery (eval → native reload → SIGKILL+reload). See the design
// doc's "Phases" section and "Rust watchdog" component for the tier rationale.
//
// Every observed WebKitGTK freeze lives in a WebKitWebProcess, a separate OS process from
// this one — so a dedicated thread here can watch heartbeats from the frontend without
// itself being affected by a frozen webview, and can reload/kill that process without
// depending on it to cooperate.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::Manager;

// A window that has beaten at least once and then goes silent for this long is
// considered frozen. Generous enough to absorb Vite HMR reloads (~1-2s) in dev.
const SILENCE_THRESHOLD: Duration = Duration::from_secs(6);
const POLL_INTERVAL: Duration = Duration::from_secs(1);
// sysconf(_SC_CLK_TCK) is 100 on every Linux target this app ships to; not worth a
// libc dependency for a diagnostics-only reading.
const CLK_TCK: f64 = 100.0;

// Tier wait times: how long to give a recovery step a chance to produce a fresh
// heartbeat before escalating to the next, cheaper-but-less-certain tier.
const TIER1_WAIT: Duration = Duration::from_secs(3);
const TIER2_WAIT: Duration = Duration::from_secs(5);
// Longer than tiers 1-2: those act on an existing process (near-instant if it's
// cooperative), but tier 3 forks a brand-new WebKitWebProcess from scratch and waits for
// it to load the page, run onMount, and rehydrate the session — empirically ~11s in
// headless testing (scripts/watchdog-test.sh), vs. the design doc's original 5s
// estimate. Underestimating this just wastes a redundant tier1+tier2 retry while the
// real recovery is still in flight — harmless but noisy in the log.
const TIER3_WAIT: Duration = Duration::from_secs(15);
// At most one full tier1→tier2→tier3 recovery sequence per window in this window.
const RECOVERY_BACKOFF: Duration = Duration::from_secs(15);
// After this many consecutive full sequences fail to produce a fresh heartbeat, stop
// escalating and just keep logging — repeatedly nuking a webview that never comes back
// helps no one and keeps disturbing the (still-fine) audio-owning Rust process for nothing.
const MAX_CONSECUTIVE_FAILURES: u32 = 3;

struct WindowBeat {
    last_beat: Instant,
    last_stats: serde_json::Value,
    // True while this window is in a silence episode we've already logged a trigger for
    // (so we don't re-log every poll tick while it stays silent). Cleared by
    // watchdog_heartbeat as soon as a fresh beat arrives — recovery threads poll this
    // to tell whether their tier worked.
    triggered: bool,
    // True while a recovery thread is actively working through the tiers for this
    // window — prevents the poll loop from spawning a second, overlapping sequence.
    recovering: bool,
    last_recovery_attempt: Option<Instant>,
    consecutive_failures: u32,
    // Set once MAX_CONSECUTIVE_FAILURES is hit, so the "giving up" log line fires once
    // instead of every poll tick until the window eventually recovers on its own.
    gave_up: bool,
}

impl WindowBeat {
    fn new(now: Instant, stats: serde_json::Value) -> Self {
        Self {
            last_beat: now,
            last_stats: stats,
            triggered: false,
            recovering: false,
            last_recovery_attempt: None,
            consecutive_failures: 0,
            gave_up: false,
        }
    }
}

pub struct Inner {
    windows: HashMap<String, WindowBeat>,
}

/// Shared handle: registered in Tauri managed state and captured by the watchdog thread.
pub type WatchdogPersist = Arc<Mutex<Inner>>;

pub fn new_persist() -> WatchdogPersist {
    Arc::new(Mutex::new(Inner { windows: HashMap::new() }))
}

/// Drops a window's heartbeat entry. Called when a window is closed/destroyed (see
/// `lib.rs`'s `on_window_event`).
///
/// Without this, a **deliberately closed** window is indistinguishable from a frozen one:
/// its entry lingers, stops being fed, trips `SILENCE_THRESHOLD` 6s later, and drives the
/// full recovery cascade against a window that no longer exists. That is not hypothetical
/// — it is exactly what the `output` window did in the incidents recorded in
/// `docs/design/output-noise-and-track-reload-silence.md` (Bug A): tier1/tier2 logging
/// `window 'output' not found` on every attempt, tier3 SIGKILLing *every* WebKit
/// descendant (including `main`'s perfectly healthy one) as collateral, three sequences
/// failing, and the watchdog finally giving up. Note that a healthy final `lastRafMs`
/// followed by silence is the signature of a clean close, **not** of a freeze — that
/// reading is what made those triggers look genuine.
///
/// Reopening the window re-registers it on its next heartbeat via the insert branch
/// below, so forgetting is safe and needs no corresponding "re-add" path.
pub fn forget_window(state: &WatchdogPersist, label: &str) {
    if state.lock().unwrap().windows.remove(label).is_some() {
        log::info!("[watchdog] window '{label}' closed — dropped from heartbeat tracking");
    }
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
                // A resumed heartbeat means this silence episode is over, whether it
                // healed on its own or a recovery tier just landed — either way, don't
                // hold a stale failure count against the *next* unrelated freeze.
                beat.consecutive_failures = 0;
                beat.gave_up = false;
            }
            beat.last_beat = now;
            beat.last_stats = stats;
        }
        None => {
            inner.windows.insert(window, WindowBeat::new(now, stats));
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

// Returns true once a fresh heartbeat has cleared `triggered` for this window — the
// signal a recovery tier checks after its wait to decide whether it worked.
fn resumed(state: &WatchdogPersist, label: &str) -> bool {
    state.lock().unwrap().windows.get(label).map(|b| !b.triggered).unwrap_or(false)
}

// Looks a window up by label, falling back to a scan of every managed webview window.
//
// In tauri 2.10.3 these two are keyed identically — `get_webview_window(label)` is
// `manager().get_webview(label)` filtered by `is_webview_window()`, and
// `webview_windows()` is the same filter applied to `manager().webviews()` — so the
// fallback is belt-and-braces, not a real second source. It is worth stating explicitly
// because the Bug A notes hypothesised an asymmetry between the two (tier1/tier2 using
// the by-label lookup, tier3 using the map) and that asymmetry does not exist: when
// tier1/tier2 logged `window 'output' not found`, tier3's `reload_all_windows()` was not
// quietly succeeding where they failed — it simply had no `output` entry to reload
// either, and logged nothing because it only reports per-window *errors*. The window was
// genuinely gone. That is what `forget_window` above now prevents from ever reaching a
// recovery tier.
fn find_window(app: &tauri::AppHandle, label: &str) -> Option<tauri::WebviewWindow> {
    app.get_webview_window(label).or_else(|| app.webview_windows().remove(label))
}

fn eval_reload(app: &tauri::AppHandle, label: &str) {
    match find_window(app, label) {
        Some(w) => {
            if let Err(e) = w.eval("location.reload()") {
                log::warn!("[watchdog] tier1 eval failed for '{label}': {e}");
            }
        }
        None => log::warn!("[watchdog] tier1: window '{label}' not found"),
    }
}

fn native_reload(app: &tauri::AppHandle, label: &str) {
    match find_window(app, label) {
        Some(w) => {
            if let Err(e) = w.reload() {
                log::warn!("[watchdog] tier2 reload failed for '{label}': {e}");
            }
        }
        None => log::warn!("[watchdog] tier2: window '{label}' not found"),
    }
}

// Kills every WebKitWebProcess descendant of this process. SIGKILL cannot be ignored or
// queued behind a wedged event loop (unlike eval/reload, which depend on the JS main
// thread eventually running them) — this is the tier that actually breaks mechanism A's
// deadlock and any process-level freeze (e.g. `kill -STOP`). Shells out to `kill` rather
// than adding a libc/nix dependency for one syscall (same tradeoff as CLK_TCK above).
//
// ⚠️ This is unconditional and takes healthy windows down with the stuck one: recovering
// `output` also kills `main`'s WebKitWebProcess, mid-performance. That is not an oversight
// that can be fixed here — attributing a WebKitWebProcess back to a window label isn't
// reliable across the sandbox's possible bwrap layer (see `descendant_pids`), so there is
// nothing to be selective *with*. The mitigation is upstream instead: never let a window
// that isn't genuinely frozen reach this tier (see the closed-window guard in the poll
// loop and `forget_window`). If selectivity is ever actually needed, it needs a real
// attribution mechanism first — e.g. having each window report its own WebKitWebProcess
// pid alongside its heartbeat — not a guess based on process start order.
fn kill_webkit_descendants() -> usize {
    let own_pid = std::process::id() as i32;
    let mut killed = 0;
    for pid in descendant_pids(own_pid) {
        let Some(stat) = read_proc_stat(pid) else { continue };
        if !stat.comm.contains("WebKit") {
            continue;
        }
        match std::process::Command::new("kill").arg("-KILL").arg(pid.to_string()).status() {
            Ok(status) if status.success() => killed += 1,
            Ok(status) => log::warn!("[watchdog] tier3: `kill -KILL {pid}` exited {status}"),
            Err(e) => log::warn!("[watchdog] tier3: failed to run kill for pid {pid}: {e}"),
        }
    }
    killed
}

// Reloads every currently-open webview window. Tier 3 kills ALL WebKitWebProcess
// descendants — attribution of a single process to a single window isn't reliable
// across the sandbox's possible bwrap layer (see descendant_pids) — so every window
// needs a fresh load afterward, not just the one whose heartbeat triggered.
fn reload_all_windows(app: &tauri::AppHandle) {
    for (label, window) in app.webview_windows() {
        if let Err(e) = window.reload() {
            log::warn!("[watchdog] tier3: reload failed for '{label}': {e}");
        }
    }
}

/// Runs one full tier1→tier2→tier3 recovery sequence for `label` in its own thread, so
/// the main poll loop keeps monitoring every window's heartbeat (including this one, to
/// detect success) while this sequence's multi-second waits are in flight. Clears
/// `recovering` and updates the failure count/backoff timer on shared state when done —
/// see the design doc's "Rust watchdog" component for the tier rationale and the
/// backoff/give-up thresholds.
fn spawn_recovery_sequence(app: tauri::AppHandle, state: WatchdogPersist, label: String) {
    thread::spawn(move || {
        log::warn!("[watchdog] recovery tier1 (eval reload): window '{label}'");
        eval_reload(&app, &label);
        thread::sleep(TIER1_WAIT);
        let mut ok = resumed(&state, &label);

        if !ok {
            log::warn!("[watchdog] recovery tier2 (native reload): window '{label}'");
            native_reload(&app, &label);
            thread::sleep(TIER2_WAIT);
            ok = resumed(&state, &label);
        }

        if !ok {
            log::warn!("[watchdog] recovery tier3 (SIGKILL + reload all windows): window '{label}'");
            let killed = kill_webkit_descendants();
            log::warn!("[watchdog] tier3: killed {killed} WebKitWebProcess descendant(s)");
            // A reload() dispatched in the same instant as the SIGKILL is unreliable —
            // observed empirically (scripts/watchdog-test.sh) to sometimes get silently
            // dropped, most likely a race with WebKitGTK's own SIGCHLD-driven internal
            // bookkeeping for the just-killed process not having caught up yet on the
            // GTK main loop. A first reload() is still fired immediately (cheap, and
            // correct on every run where it isn't raced), with one retry partway through
            // the wait budget in case that first attempt was the one that got lost.
            reload_all_windows(&app);
            thread::sleep(TIER3_WAIT / 3);
            ok = resumed(&state, &label);
            if !ok {
                log::warn!("[watchdog] tier3: retrying reload (first attempt may have raced process teardown)");
                reload_all_windows(&app);
                thread::sleep(TIER3_WAIT - TIER3_WAIT / 3);
                ok = resumed(&state, &label);
            }
        }

        let mut inner = state.lock().unwrap();
        if let Some(beat) = inner.windows.get_mut(&label) {
            beat.recovering = false;
            if ok {
                log::warn!("[watchdog] recovery sequence for '{label}' succeeded");
                beat.consecutive_failures = 0;
                beat.gave_up = false;
            } else {
                beat.consecutive_failures += 1;
                log::error!(
                    "[watchdog] recovery sequence for '{label}' exhausted all tiers ({} consecutive failure(s))",
                    beat.consecutive_failures
                );
                if beat.consecutive_failures >= MAX_CONSECUTIVE_FAILURES && !beat.gave_up {
                    beat.gave_up = true;
                    log::error!(
                        "[watchdog] '{label}': {MAX_CONSECUTIVE_FAILURES} consecutive recovery sequences failed — giving up, leaving audio alone, will keep logging triggers"
                    );
                }
            }
        }
    });
}

/// Spawns the dedicated watchdog thread. Wakes every second; on a window's first tick
/// past `SILENCE_THRESHOLD` of no heartbeat, logs a diagnostics dump and (subject to the
/// backoff/give-up rules above) kicks off a tiered recovery sequence in its own thread.
/// Never touches `AudioManager` — the Rust audio pipelines are untouched by any of this.
pub fn spawn_watchdog(state: WatchdogPersist, app: tauri::AppHandle) {
    thread::spawn(move || {
        let mut prior_cpu: HashMap<i32, (u64, u64)> = HashMap::new();
        loop {
            thread::sleep(POLL_INTERVAL);

            // Sample every tick (not just on trigger) so utime/stime deltas reflect a
            // real 1s window by the time a trigger fires, rather than a first reading of 0.
            let samples = sample_webkit_processes(&mut prior_cpu);

            let mut triggers: Vec<(String, serde_json::Value)> = Vec::new();
            let mut to_recover: Vec<String> = Vec::new();
            {
                let mut inner = state.lock().unwrap();
                let now = Instant::now();
                for (label, beat) in inner.windows.iter_mut() {
                    if !beat.triggered && beat.last_beat.elapsed() >= SILENCE_THRESHOLD {
                        beat.triggered = true;
                        triggers.push((label.clone(), beat.last_stats.clone()));
                    }
                    if beat.triggered && !beat.recovering && !beat.gave_up {
                        let due = beat
                            .last_recovery_attempt
                            .is_none_or(|t| now.duration_since(t) >= RECOVERY_BACKOFF);
                        if due {
                            beat.recovering = true;
                            beat.last_recovery_attempt = Some(now);
                            to_recover.push(label.clone());
                        }
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
            }

            // Last line of defence before doing something destructive: confirm the window
            // is still there. `forget_window` handles the ordinary close path, but it
            // depends on GTK actually delivering a Destroyed/CloseRequested event, and a
            // missed event here costs a SIGKILL of every WebKit process in the app. This
            // check needs no event at all — a label with no window is a closed window, and
            // the only correct response is to stop tracking it, never to escalate.
            //
            // Deliberately done outside the state lock: it reaches into Tauri's window
            // manager, which takes its own locks, and `watchdog_heartbeat` already holds
            // ours from inside a command handler. Nesting the two in opposite orders is a
            // deadlock waiting to happen, and this thread is the one that must never wedge.
            for label in to_recover {
                if find_window(&app, &label).is_none() {
                    log::warn!(
                        "[watchdog] window '{label}' has no live webview — treating as closed, not frozen; skipping recovery"
                    );
                    forget_window(&state, &label);
                    continue;
                }
                spawn_recovery_sequence(app.clone(), state.clone(), label);
            }
        }
    });
}
