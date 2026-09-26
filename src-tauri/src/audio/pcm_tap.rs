//! PCM tap for the visualization layer (`docs/design/visualization-plugins.md`, Phase 5a).
//!
//! A `tee` sits between a shared output node's `capsfilter` and its master `volume`
//! (**pre-master-volume**: visuals follow the music, not the room level). One branch of it,
//! `valve → queue(leaky=downstream) → appsink`, feeds this module, which keeps the last
//! [`PCM_LEN`] frames of the **main** channel pair and emits mono + L + R as bytes at
//! ≤60 Hz.
//!
//! Everything that can be decided without GStreamer lives here as pure functions so it is
//! unit-tested (`cargo test pcm_tap`): which channels are "main", the mono downmix, the
//! quantisation, the sliding window, and the wire layout.
//!
//! ⚠️ Load-bearing, silent when broken:
//! - **Never tap the cue channels.** On a 4-channel node main and cue share the stream
//!   (main FL/FR, cue RL/RR). The tap reads only the channel indices derived from the main
//!   branch's own mix-matrix ([`main_pair`]); reading the node's first two channels
//!   unconditionally would leak the headphone cue onto the projector for a device whose main
//!   pair is not 0/1.
//! - **The branch must be leaky.** The deck `tee` upstream has no per-branch queue; a tap
//!   that can block stalls the booth monitor and the cue (network-audio-output.md).
//! - **Closed valve = zero work.** When nobody listens the branch is either never built or
//!   dropped at the valve, so a closed output window costs no PCM work.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

/// Samples per channel in one emitted frame (Milkdrop's native waveform length).
pub const PCM_LEN: usize = 1024;
/// Bytes per emitted frame: mono | left | right, each `PCM_LEN` long.
pub const PCM_FRAME_BYTES: usize = PCM_LEN * 3;
/// Minimum time between emits: 1/60 s, rounded up so the rate is never above 60 Hz.
pub const MIN_EMIT_INTERVAL_MS: u64 = 17;

/// "No pair" sentinel for [`PackedPair`].
const NO_PAIR: u32 = u32::MAX;

/// The tap's channel indices, shared lock-free with the appsink callback so a device change
/// re-targets a running tap without rebuilding it.
pub struct PackedPair(AtomicU32);

impl PackedPair {
    pub fn new() -> Self {
        Self(AtomicU32::new(NO_PAIR))
    }
    pub fn set(&self, pair: Option<(usize, usize)>) {
        let v = match pair {
            Some((l, r)) => ((l as u32) << 16) | (r as u32 & 0xFFFF),
            None => NO_PAIR,
        };
        self.0.store(v, Ordering::Relaxed);
    }
    pub fn get(&self) -> Option<(usize, usize)> {
        let v = self.0.load(Ordering::Relaxed);
        if v == NO_PAIR {
            None
        } else {
            Some(((v >> 16) as usize, (v & 0xFFFF) as usize))
        }
    }
}

/// State shared between the graph, the Tauri command and every tap callback.
pub struct PcmShared {
    /// Set by `viz_set_listening`. False = the tap does nothing.
    pub listening: AtomicBool,
}

impl PcmShared {
    pub fn new() -> Self {
        Self { listening: AtomicBool::new(false) }
    }
}

/// Callback the graph hands each frame's `PCM_FRAME_BYTES` bytes to (Tauri emit in the app,
/// a capture in tests).
pub type PcmEmit = Arc<dyn Fn(&[u8]) + Send + Sync>;

/// The (left, right) *node channel indices* a branch's mix-matrix feeds. `matrix_rows` is
/// audioconvert's mix-matrix: one `[from_left, from_right]` row per node channel. Returns
/// `None` if the matrix routes nothing (a silent branch has no pair worth tapping).
/// A branch that only feeds one channel (a mono target) returns that channel twice.
pub fn main_pair(matrix_rows: &[[f32; 2]]) -> Option<(usize, usize)> {
    let strongest = |col: usize| -> Option<usize> {
        matrix_rows
            .iter()
            .enumerate()
            .filter(|(_, r)| r[col] > 0.0)
            .max_by(|a, b| a.1[col].partial_cmp(&b.1[col]).unwrap_or(std::cmp::Ordering::Equal).then(b.0.cmp(&a.0)))
            .map(|(i, _)| i)
    };
    match (strongest(0), strongest(1)) {
        (Some(l), Some(r)) => Some((l, r)),
        (Some(l), None) => Some((l, l)),
        (None, Some(r)) => Some((r, r)),
        (None, None) => None,
    }
}

/// The pair for a branch built with no explicit remap: the front pair, exactly what
/// `build_branch` routes it to.
pub fn default_pair() -> (usize, usize) {
    (0, 1)
}

/// Whether a branch key's second half names a main output (`"main0"`, `"main1"`, …) as
/// opposed to `"cue"` or `"record"`.
pub fn is_main_key(branch: &str) -> bool {
    branch.starts_with("main")
}

/// Quantise a sample in [-1, 1] to a byte, 128 = silence (Milkdrop / Web Audio time-domain
/// convention). Out-of-range and NaN are clamped/zeroed.
pub fn quantise(x: f32) -> u8 {
    let x = if x.is_nan() { 0.0 } else { x.clamp(-1.0, 1.0) };
    ((x * 0.5 + 0.5) * 255.0).round() as u8
}

/// Sliding window of the most recent [`PCM_LEN`] frames of the tapped pair, oldest first.
pub struct PcmWindow {
    left: Vec<f32>,
    right: Vec<f32>,
}

impl PcmWindow {
    pub fn new() -> Self {
        Self { left: vec![0.0; PCM_LEN], right: vec![0.0; PCM_LEN] }
    }

    /// Append the tapped pair from an interleaved F32 buffer of `channels` channels. Indices
    /// outside the buffer's width read as silence rather than panicking (a stale pair during
    /// a device change).
    pub fn push_interleaved(&mut self, samples: &[f32], channels: usize, pair: (usize, usize)) {
        if channels == 0 {
            return;
        }
        let frames = samples.len() / channels;
        let skip = frames.saturating_sub(PCM_LEN);
        let take = frames - skip;
        for w in [&mut self.left, &mut self.right] {
            w.copy_within(take.., 0);
        }
        let base = PCM_LEN - take;
        let (li, ri) = pair;
        for f in 0..take {
            let frame = &samples[(skip + f) * channels..(skip + f + 1) * channels];
            self.left[base + f] = frame.get(li).copied().unwrap_or(0.0);
            self.right[base + f] = frame.get(ri).copied().unwrap_or(0.0);
        }
    }

    /// Wire layout: `mono[PCM_LEN] | left[PCM_LEN] | right[PCM_LEN]`, quantised. Mono is the
    /// mean of L and R *before* quantising.
    pub fn encode(&self, out: &mut Vec<u8>) {
        out.clear();
        out.reserve(PCM_FRAME_BYTES);
        out.extend(self.left.iter().zip(&self.right).map(|(l, r)| quantise((l + r) * 0.5)));
        out.extend(self.left.iter().map(|&l| quantise(l)));
        out.extend(self.right.iter().map(|&r| quantise(r)));
    }
}

/// Minimal RFC 4648 base64 (no dependency) for the `audio-pcm` event payload: a JSON array
/// of 3072 numbers is ~5x the size of the same bytes as a string.
pub fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        s.push(T[(n >> 18) as usize & 63] as char);
        s.push(T[(n >> 12) as usize & 63] as char);
        s.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        s.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn front_pair_of_a_four_channel_node() {
        // main on FL,FR of a 4ch node: rows are [FL, FR, RL, RR]
        let rows = vec![[1.0, 0.0], [0.0, 1.0], [0.0, 0.0], [0.0, 0.0]];
        assert_eq!(main_pair(&rows), Some((0, 1)));
    }

    #[test]
    fn rear_main_pair_is_not_the_front() {
        // A main branch routed to RL,RR must tap channels 2,3 — and by construction never 0,1.
        let rows = vec![[0.0, 0.0], [0.0, 0.0], [1.0, 0.0], [0.0, 1.0]];
        assert_eq!(main_pair(&rows), Some((2, 3)));
    }

    #[test]
    fn cue_pair_is_never_chosen_for_a_main_front_branch() {
        // The cue branch on the same node has the rear matrix; the main one the front.
        let main = vec![[1.0, 0.0], [0.0, 1.0], [0.0, 0.0], [0.0, 0.0]];
        let cue = vec![[0.0, 0.0], [0.0, 0.0], [1.0, 0.0], [0.0, 1.0]];
        let m = main_pair(&main).unwrap();
        let c = main_pair(&cue).unwrap();
        assert_ne!(m, c);
        assert!(m.0 < 2 && m.1 < 2);
    }

    #[test]
    fn one_channel_target_uses_it_for_both_sides_and_empty_matrix_is_none() {
        assert_eq!(main_pair(&[[0.0, 0.0], [1.0, 0.0]]), Some((1, 1)));
        assert_eq!(main_pair(&[[0.0, 0.0], [0.0, 0.0]]), None);
        assert_eq!(main_pair(&[]), None);
    }

    #[test]
    fn stereo_identity_matrix() {
        assert_eq!(main_pair(&[[1.0, 0.0], [0.0, 1.0]]), Some((0, 1)));
        assert_eq!(default_pair(), (0, 1));
    }

    #[test]
    fn key_classification() {
        assert!(is_main_key("main0"));
        assert!(is_main_key("main12"));
        assert!(!is_main_key("cue"));
        assert!(!is_main_key("record"));
    }

    #[test]
    fn quantise_endpoints_and_centre() {
        assert_eq!(quantise(0.0), 128); // 127.5 rounds up: silence is 128, Milkdrop's centre
        assert_eq!(quantise(1.0), 255);
        assert_eq!(quantise(-1.0), 0);
        assert_eq!(quantise(5.0), 255);
        assert_eq!(quantise(-5.0), 0);
        assert_eq!(quantise(f32::NAN), 128);
    }

    #[test]
    fn quantise_is_monotonic() {
        let mut last = 0u8;
        for i in -100..=100 {
            let q = quantise(i as f32 / 100.0);
            assert!(q >= last);
            last = q;
        }
    }

    #[test]
    fn window_takes_only_the_main_pair_from_interleaved_four_channel() {
        let mut w = PcmWindow::new();
        // 4ch frames: FL=0.5 FR=-0.5 RL=1.0 RR=1.0 (loud cue that must not appear)
        let frames: Vec<f32> = (0..10).flat_map(|_| [0.5, -0.5, 1.0, 1.0]).collect();
        w.push_interleaved(&frames, 4, (0, 1));
        let mut out = Vec::new();
        w.encode(&mut out);
        assert_eq!(out.len(), PCM_FRAME_BYTES);
        // last 10 samples of each block carry the signal
        let (mono, l, r) = (&out[..PCM_LEN], &out[PCM_LEN..2 * PCM_LEN], &out[2 * PCM_LEN..]);
        assert_eq!(l[PCM_LEN - 1], quantise(0.5));
        assert_eq!(r[PCM_LEN - 1], quantise(-0.5));
        assert_eq!(mono[PCM_LEN - 1], 128, "mean of 0.5 and -0.5 is silence");
        assert_eq!(l[PCM_LEN - 11], 128, "older samples are still the initial silence");
        // and the cue's 1.0 (255) appears nowhere
        assert!(!out.contains(&255));
    }

    #[test]
    fn window_slides_and_keeps_the_newest_samples() {
        let mut w = PcmWindow::new();
        let a: Vec<f32> = vec![0.25; 600 * 2];
        let b: Vec<f32> = vec![-0.25; 600 * 2];
        w.push_interleaved(&a, 2, (0, 1));
        w.push_interleaved(&b, 2, (0, 1));
        let mut out = Vec::new();
        w.encode(&mut out);
        let l = &out[PCM_LEN..2 * PCM_LEN];
        assert_eq!(l[PCM_LEN - 1], quantise(-0.25));
        assert_eq!(l[PCM_LEN - 600], quantise(-0.25));
        assert_eq!(l[PCM_LEN - 601], quantise(0.25));
        assert_eq!(l[0], quantise(0.25));
    }

    #[test]
    fn oversized_buffer_keeps_only_the_last_window() {
        let mut w = PcmWindow::new();
        let mut s = vec![0.0f32; 3000 * 2];
        for (i, f) in s.chunks_mut(2).enumerate() {
            f[0] = if i >= 3000 - PCM_LEN { 0.5 } else { -0.5 };
            f[1] = f[0];
        }
        w.push_interleaved(&s, 2, (0, 1));
        let mut out = Vec::new();
        w.encode(&mut out);
        assert!(out[PCM_LEN..2 * PCM_LEN].iter().all(|&b| b == quantise(0.5)));
    }

    #[test]
    fn stale_pair_beyond_the_buffer_reads_silence_not_a_panic() {
        let mut w = PcmWindow::new();
        w.push_interleaved(&[0.9, 0.9, 0.9, 0.9], 2, (2, 3));
        let mut out = Vec::new();
        w.encode(&mut out);
        assert!(out.iter().all(|&b| b == 128));
    }

    #[test]
    fn mono_is_the_mean_before_quantising() {
        let mut w = PcmWindow::new();
        w.push_interleaved(&[1.0, 0.0], 2, (0, 1));
        let mut out = Vec::new();
        w.encode(&mut out);
        assert_eq!(out[PCM_LEN - 1], quantise(0.5));
        assert_eq!(out[2 * PCM_LEN - 1], 255);
        assert_eq!(out[3 * PCM_LEN - 1], 128);
    }

    #[test]
    fn packed_pair_round_trips() {
        let p = PackedPair::new();
        assert_eq!(p.get(), None);
        p.set(Some((2, 3)));
        assert_eq!(p.get(), Some((2, 3)));
        p.set(None);
        assert_eq!(p.get(), None);
    }

    #[test]
    fn base64_matches_rfc_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }
}
