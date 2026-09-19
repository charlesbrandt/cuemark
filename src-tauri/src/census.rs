//! One `[census]` line every 5 minutes: threads, file descriptors, memory, the shared
//! output graph's shape, and the host's I/O pressure.
//!
//! **Why this exists.** Two of this project's worst faults are *accumulations* whose only
//! reliable cure is restarting the app — the leaked decode threads of the
//! `audio-debugging` skill's "Audio goes silent after a long-running session" entry, and
//! the 2026-09-19 incident where an 8-day-old instance played nothing at all while every
//! per-deck instrument read healthy. Neither is visible in a per-deck log line, because
//! neither is about any one deck: what changed was the *process*. Nothing in this app has
//! ever recorded that, so every such investigation has had to start by asking the user to
//! run `ps`/`ls /proc` against a process whose interesting hours are already behind it.
//!
//! A standing 5-minute line makes the slope readable after the fact, from the log alone —
//! which is the only way to read it, since the fault takes days to appear and a restart
//! destroys the evidence.
//!
//! Everything here degrades to `?` rather than failing: this is a diagnostic, and a
//! diagnostic that can take the audio process down is worse than no diagnostic. The
//! `/proc` reads are Linux-only and compiled out elsewhere (the counts then read `?`).

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::audio::mixer::OutputGraph;

/// Cadence. Deliberately coarse — this measures drift over hours and days, and a line
/// that is cheap enough to ignore is a line that survives a multi-hour set.
const CENSUS_INTERVAL: Duration = Duration::from_secs(300);

/// Comm groups printed per line, largest first. The total is always exact; this only
/// bounds the breakdown so one pathological process cannot produce a 200-column line.
const MAX_COMM_GROUPS: usize = 12;

/// Start the census thread. Runs for the life of the process (there is nothing to stop it
/// for — it holds only a handle to the graph, which itself lives that long).
pub fn spawn(graph: Arc<Mutex<OutputGraph>>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(CENSUS_INTERVAL);
        log::info!("[census] {}", snapshot(&graph));
    });
}

/// One census line's body. Separated from the thread so the formatting is exercised by
/// the tests below without waiting five minutes for it.
fn snapshot(graph: &Arc<Mutex<OutputGraph>>) -> String {
    let (total, groups) = thread_census();
    let breakdown = format_groups(&groups);
    let g = graph.lock().unwrap().census();

    format!(
        "threads={} ({breakdown}) fds={} rss={} swap={} | graph nodes={} branches={} appsrcs={} \
         | host io.full.avg60={} swapfree={}/{}",
        opt_num(total),
        opt_num(fd_count()),
        opt_mb(status_kb("VmRSS")),
        opt_mb(status_kb("VmSwap")),
        g.nodes,
        g.branches,
        g.appsrcs,
        io_pressure_full_avg60().map(|v| format!("{v:.2}")).unwrap_or_else(|| "?".into()),
        opt_mb(meminfo_kb("SwapFree")),
        opt_mb(meminfo_kb("SwapTotal")),
    )
}

/// Total thread count and the per-comm-prefix breakdown. `(None, empty)` off Linux.
fn thread_census() -> (Option<usize>, BTreeMap<String, usize>) {
    if !cfg!(target_os = "linux") {
        return (None, BTreeMap::new());
    }
    let Ok(dir) = std::fs::read_dir("/proc/self/task") else {
        return (None, BTreeMap::new());
    };
    let comms = dir.filter_map(|e| e.ok()).map(|e| {
        std::fs::read_to_string(e.path().join("comm")).unwrap_or_else(|_| "?".to_string())
    });
    let groups = group_comms(comms);
    (Some(groups.values().sum()), groups)
}

/// Group thread names by comm prefix: the leading run of characters before the first
/// digit or `:`.
///
/// That grouping is the whole point of the field. GStreamer names a streaming thread
/// after the element it belongs to (`qtdemux112:sink`, `queue3:src`), so ungrouped these
/// are a hundred unique strings; grouped, a leaked pipeline shows up as a *count* of
/// `qtdemux` threads far above the number of loaded decks — which is exactly the leak the
/// `audio-debugging` skill's long-session-silence entry describes, and the one thing that
/// would have made it visible without a live `/proc` walk.
fn group_comms<I: IntoIterator<Item = String>>(comms: I) -> BTreeMap<String, usize> {
    let mut out: BTreeMap<String, usize> = BTreeMap::new();
    for comm in comms {
        *out.entry(comm_prefix(comm.trim())).or_insert(0) += 1;
    }
    out
}

fn comm_prefix(comm: &str) -> String {
    let prefix: String = comm
        .chars()
        .take_while(|c| !c.is_ascii_digit() && *c != ':')
        .collect();
    let prefix = prefix.trim_end_matches(['-', '_', '.']);
    if prefix.is_empty() { "?".to_string() } else { prefix.to_string() }
}

/// Largest groups first, capped — see `MAX_COMM_GROUPS`.
fn format_groups(groups: &BTreeMap<String, usize>) -> String {
    if groups.is_empty() {
        return "?".to_string();
    }
    let mut rows: Vec<(&String, &usize)> = groups.iter().collect();
    // Count descending, then name, so the line is stable between two identical censuses.
    rows.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
    let shown: Vec<String> = rows
        .iter()
        .take(MAX_COMM_GROUPS)
        .map(|(name, n)| format!("{name}:{n}"))
        .collect();
    let rest = rows.len().saturating_sub(MAX_COMM_GROUPS);
    if rest > 0 {
        format!("{} +{rest} more", shown.join(" "))
    } else {
        shown.join(" ")
    }
}

fn fd_count() -> Option<usize> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    Some(std::fs::read_dir("/proc/self/fd").ok()?.count())
}

fn status_kb(field: &str) -> Option<u64> {
    parse_kb_field(&std::fs::read_to_string("/proc/self/status").ok()?, field)
}

fn meminfo_kb(field: &str) -> Option<u64> {
    parse_kb_field(&std::fs::read_to_string("/proc/meminfo").ok()?, field)
}

/// `VmRSS:\t  512000 kB` → `512000`. Shared by `/proc/self/status` and `/proc/meminfo`,
/// which use the same `Field: <n> kB` shape.
fn parse_kb_field(text: &str, field: &str) -> Option<u64> {
    text.lines()
        .find(|l| l.starts_with(field) && l[field.len()..].starts_with(':'))
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|v| v.parse().ok())
}

fn io_pressure_full_avg60() -> Option<f64> {
    parse_pressure_full_avg60(&std::fs::read_to_string("/proc/pressure/io").ok()?)
}

/// `full avg10=0.00 avg60=4.21 avg300=1.05 total=…` → `4.21`.
///
/// **`full`, not `some`.** `some` counts time any task was stalled on I/O, which a media
/// app reading from a CIFS share does constantly and harmlessly. `full` is time *every*
/// runnable task was stalled — i.e. the machine got nothing done — which is the condition
/// that can starve a GStreamer streaming thread.
pub fn parse_pressure_full_avg60(text: &str) -> Option<f64> {
    text.lines()
        .find(|l| l.starts_with("full "))?
        .split_whitespace()
        .find_map(|tok| tok.strip_prefix("avg60=")?.parse().ok())
}

/// Host I/O pressure right now, for a caller that wants to check it at a specific moment
/// rather than wait for the next census (see `audio_load`). `None` off Linux or if the
/// kernel was built without PSI.
pub fn io_pressure_now() -> Option<f64> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    io_pressure_full_avg60()
}

/// Live thread count, for the per-load delta in `[audio_load]`. One `read_dir`, no
/// per-thread `comm` reads — cheap enough to sit on the load path.
pub fn thread_count() -> Option<usize> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    Some(std::fs::read_dir("/proc/self/task").ok()?.count())
}

fn opt_num(v: Option<usize>) -> String {
    v.map(|n| n.to_string()).unwrap_or_else(|| "?".into())
}

fn opt_mb(kb: Option<u64>) -> String {
    kb.map(|kb| format!("{}MB", kb / 1024)).unwrap_or_else(|| "?".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comm_prefixes_collapse_gstreamer_element_threads() {
        let comms = [
            "qtdemux112:sink",
            "qtdemux113:sink",
            "queue3:src",
            "queue41:src",
            "pool-cuemark",
            "gmain",
        ]
        .map(String::from);
        let groups = group_comms(comms);
        assert_eq!(groups.get("qtdemux"), Some(&2));
        assert_eq!(groups.get("queue"), Some(&2));
        assert_eq!(groups.get("pool-cuemark"), Some(&1));
        assert_eq!(groups.get("gmain"), Some(&1));
    }

    #[test]
    fn unreadable_comm_is_counted_not_dropped() {
        // `thread_census` substitutes "?" for a thread whose comm could not be read (it
        // exited between the readdir and the open). Losing it would understate the total,
        // which is the one number this line exists to trend.
        let groups = group_comms(["?".to_string(), "gmain\n".to_string()]);
        assert_eq!(groups.values().sum::<usize>(), 2);
        assert_eq!(groups.get("?"), Some(&1));
    }

    #[test]
    fn parses_status_and_meminfo_fields() {
        let status = "Name:\tcuemark\nVmRSS:\t  812340 kB\nVmSwap:\t       0 kB\n";
        assert_eq!(parse_kb_field(status, "VmRSS"), Some(812_340));
        assert_eq!(parse_kb_field(status, "VmSwap"), Some(0));
        // A prefix match must not answer for a different field: `VmRSS` is not `VmRSSAnon`.
        assert_eq!(parse_kb_field("VmRSSAnon:\t 10 kB\n", "VmRSS"), None);
        assert_eq!(parse_kb_field(status, "SwapFree"), None);

        let meminfo = "MemTotal:       16316000 kB\nSwapTotal:       8388604 kB\nSwapFree:        8388604 kB\n";
        assert_eq!(parse_kb_field(meminfo, "SwapFree"), Some(8_388_604));
        assert_eq!(parse_kb_field(meminfo, "SwapTotal"), Some(8_388_604));
    }

    #[test]
    fn parses_io_pressure_full_avg60() {
        let psi = "some avg10=0.00 avg60=12.34 avg300=3.00 total=123456\n\
                   full avg10=0.00 avg60=4.21 avg300=1.05 total=65432\n";
        // The `some` line's avg60 (12.34) must not be the one picked up — see the doc
        // comment for why the two say different things.
        assert_eq!(parse_pressure_full_avg60(psi), Some(4.21));
        // A kernel without PSI serves an empty/absent file rather than erroring.
        assert_eq!(parse_pressure_full_avg60(""), None);
        // Some older kernels report only `some` for I/O.
        assert_eq!(parse_pressure_full_avg60("some avg10=0.00 avg60=1.00 avg300=0.00 total=1\n"), None);
    }

    #[test]
    fn group_formatting_is_bounded_and_stable() {
        let mut groups = BTreeMap::new();
        for i in 0..MAX_COMM_GROUPS + 3 {
            groups.insert(format!("t{i:02}"), i + 1);
        }
        let line = format_groups(&groups);
        assert!(line.ends_with("+3 more"), "got {line}");
        // Largest first.
        assert!(line.starts_with(&format!("t{:02}:{}", MAX_COMM_GROUPS + 2, MAX_COMM_GROUPS + 3)), "got {line}");
        assert_eq!(format_groups(&BTreeMap::new()), "?");
    }
}
