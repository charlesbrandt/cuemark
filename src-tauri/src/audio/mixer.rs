//! Shared output graph — **one `pulsesink` per physical device node**, fed by an
//! `audiomixer` that sums one live `appsrc` branch per deck output.
//!
//! This is rung **C** of `docs/design/slow-jog-audio-inaudible.md` §10.10's fix ladder, and
//! `docs/design/shared-output-pipeline.md` is the design of record — read it before
//! changing anything here, especially the clock and position sections.
//!
//! ```text
//!   deck-0 main → appsink ──┐ handoff          ┌─ one output pipeline per node ─────────┐
//!   deck-0 cue  → appsink ──┼─ push_buffer ──► │ appsrc → queue → matrix → caps ─┐      │
//!   deck-1 main → appsink ──┘                  │ appsrc → queue → matrix → caps ─┼→ mix │
//!                                              │                                 ┘  ↓   │
//!                                              │            master volume → pulsesink   │
//!                                              └────────────────────────────────────────┘
//! ```
//!
//! **Why an appsink→appsrc handoff rather than one big pipeline containing every deck.**
//! A flush seek on one deck would otherwise propagate downstream through the mixer to the
//! shared sink and flush *every* deck. The handoff makes each deck's time domain its own;
//! phase is re-established at the boundary by `do-timestamp` on every buffer.
//!
//! **Why every `appsrc` is `is-live=true`.** An aggregator with non-live pads waits
//! indefinitely for data on each pad, so one paused deck would silence the whole node.
//! This is not a theoretical concern — it is measured:
//! `scripts/probes/shared_output_mixer_probe.py --not-live` produces **zero** buffers at
//! the sink for as long as one branch stays idle, while the other branch is actively
//! feeding. With `is-live=true` the aggregator falls back to its latency deadline and an
//! idle branch simply contributes silence. Run that probe before touching liveness here.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use gstreamer::glib;
use gstreamer::{self as gst, prelude::*};
use gstreamer_app::{AppSink, AppSinkCallbacks, AppSrc};

use super::pipeline::{deck_output_caps, make_sink, parse_device_remap, ChannelRemap};

/// Jitter buffer between a deck's handoff and the mixer pad.
///
/// Deliberately small: this is added latency on the scratch path, and the position-mode
/// scratch feeder's whole point is responsiveness (`docs/design/waveform-scrub.md`). It
/// only has to absorb handoff jitter — the deck's own `output_queue` (100ms) is upstream
/// and does the real buffering. If a scratch gesture starts sounding laggy, this is the
/// first knob, not the feeder's servo constants (three sessions have made that mistake).
const MIX_QUEUE_NS: u64 = 30_000_000; // 30ms

/// `appsrc` byte cap. With `block=true` this backpressures the appsink's streaming thread,
/// which backpressures the deck pipeline exactly as `pulsesink` did before.
const APPSRC_MAX_BYTES: u64 = 64 * 1024;

/// Identifies one deck output attached to a node: `("deck-0", "main0")` / `("deck-0", "cue")`.
pub type BranchKey = (String, String);

/// Elements of one attached branch, kept so it can be detached again cleanly.
struct Branch {
    appsrc: AppSrc,
    /// appsrc → queue → audioconvert(mix-matrix) → capsfilter, in link order.
    els: Vec<gst::Element>,
    mixer_pad: gst::Pad,
}

/// One physical output device: exactly one `pulsesink`, however many decks are playing.
struct OutputNode {
    /// Bare PipeWire node name this pipeline targets — the registry key, kept on the node
    /// too so error paths deep in the build can name it.
    name: String,
    pipeline: gst::Pipeline,
    mixer: gst::Element,
    master_volume_el: gst::Element,
    branches: HashMap<BranchKey, Branch>,
    /// Channel width this node's mixer and sink are pinned to. Fixed at creation from the
    /// first branch's device id; a later branch that disagrees is adapted, not renegotiated.
    channels: i32,
    channel_mask: u64,
    /// Output-side latency in nanoseconds — what `position()` must subtract. See
    /// `OutputGraph::latency_ns`.
    latency_ns: Arc<AtomicU64>,
}

/// Registry of output pipelines, keyed by bare PipeWire node name (`""` = system default).
///
/// Held behind an `Arc<Mutex<…>>` shared with every `DeckAudioPipeline`. It must be an
/// `Arc` rather than a field reachable only through `AudioManager`, because
/// `with_pipeline_detached()` removes a deck from the manager's map for the duration of a
/// blocking call and that deck still has to reach the graph.
pub struct OutputGraph {
    nodes: HashMap<String, OutputNode>,
    master_volume: f32,
    /// The clock every deck pipeline slaves to — see `shared_clock()`.
    shared_clock: Option<gst::Clock>,
}

impl OutputGraph {
    pub fn new() -> Self {
        Self { nodes: HashMap::new(), master_volume: 1.0, shared_clock: None }
    }

    /// The clock deck pipelines must use, once any output node exists.
    ///
    /// ⚠️ **This is not a convenience — a deck pipeline that does not use it will drift.**
    /// A sink-less deck pipeline picks `GstSystemClock`, while the shared `pulsesink`
    /// renders against the device's own clock (the Starlight is a 44100-only ASYNC endpoint
    /// against a graph pinned to 48000). Those rates differ, so the deck would produce
    /// slightly faster or slower than the device consumes, forever — a guaranteed slow
    /// underrun or overflow at the handoff, presenting as a click every few minutes.
    ///
    /// Base time is deliberately *not* shared; only rate has to agree. Phase is
    /// re-established at the boundary by `do-timestamp` on the output `appsrc`, which is
    /// what lets a deck pause, seek and scratch without any base-time surgery.
    pub fn shared_clock(&self) -> Option<gst::Clock> {
        self.shared_clock.clone()
    }

    /// Output-side latency for a device, in nanoseconds: how far ahead of the audible
    /// signal a deck's `query_position()` now runs.
    ///
    /// ⚠️ **Subtracting this is not optional.** `GstAudioBaseSink` reports position as what
    /// the device is playing *now*, accounting for its own 200ms ringbuffer. An `appsink`
    /// reports the last buffer it handed off, which is then buffered by this graph's queue
    /// and the shared sink's ringbuffer. Without the correction every deck reports ~200ms
    /// ahead of what is audible, and since audio is the master clock, video leads audio by
    /// the same amount everywhere — a constant offset that reads exactly like "the video
    /// decoder is early" and would be chased in the wrong file.
    pub fn latency_ns(&self, device: &str) -> u64 {
        self.nodes
            .get(node_key(device))
            .map(|n| n.latency_ns.load(Ordering::Relaxed))
            .unwrap_or(0)
    }

    /// Attach one deck output to its device's node, creating the node's output pipeline on
    /// first use. Returns the `appsrc` the deck's appsink pushes into.
    ///
    /// `device` is the full picker id (`node@target!full_layout`), not the bare node name —
    /// the `@` suffix is what decides which channel pair this branch lands on.
    pub fn attach(
        &mut self,
        device: &str,
        key: BranchKey,
        label: &str,
    ) -> Result<AppSrc, String> {
        // Parse before building anything: a device id that requests a non-default channel
        // pair but fails to parse must never fall through to an unmapped stream on a shared
        // node — see compute_channel_remap's doc comment for the PipeWire-wide deadlock that
        // caused on 2026-08-02. Callers decide the fallback; this just refuses.
        let remap = parse_device_remap(device)?;

        let node_name = node_key(device).to_string();
        if !self.nodes.contains_key(&node_name) {
            let node = self.create_node(device, &remap, label)?;
            self.nodes.insert(node_name.clone(), node);
        }

        let master_volume = self.master_volume;
        let node = self.nodes.get_mut(&node_name).expect("just inserted");
        let branch = build_branch(node, &remap, &key, label)?;
        let appsrc = branch.appsrc.clone();
        node.branches.insert(key.clone(), branch);
        node.master_volume_el.set_property("volume", master_volume as f64);

        log::info!(
            "[audio/out/{}] attached {}/{} ({} branch(es) now on this node, {} ch)",
            short(&node_name), key.0, key.1, node.branches.len(), node.channels
        );
        Ok(appsrc)
    }

    /// Detach one deck output. Safe to call for a key that was never attached.
    ///
    /// The node's pipeline is **retained** when its last branch leaves — see the note in
    /// `create_node`.
    pub fn detach(&mut self, key: &BranchKey) {
        for (name, node) in self.nodes.iter_mut() {
            let Some(branch) = node.branches.remove(key) else { continue };
            // Order matters: unlink before releasing the request pad, and stop the elements
            // before either, or the mixer can see a half-torn branch on its streaming thread.
            for el in &branch.els {
                let _ = el.set_state(gst::State::Null);
            }
            if let Some(peer) = branch.mixer_pad.peer() {
                let _ = peer.unlink(&branch.mixer_pad);
            }
            node.mixer.release_request_pad(&branch.mixer_pad);
            for el in &branch.els {
                let _ = node.pipeline.remove(el);
            }
            log::info!(
                "[audio/out/{}] detached {}/{} ({} branch(es) left)",
                short(name), key.0, key.1, node.branches.len()
            );
            return;
        }
    }

    /// Master volume, applied once per node after the mixer.
    ///
    /// This is where a master belongs. Applying it per deck was always a workaround for not
    /// having a master stage; with the shared graph in use the deck-side factor is left at
    /// 1.0 by `DeckAudioPipeline::deck_master_factor()`.
    ///
    /// ⚠️ That sentence was written here on 2026-08-11 as a description of intent and was
    /// **false in the code until 2026-08-13** — the deck side applied the factor too, so the
    /// two multiplied. If this claim is ever load-bearing again, check `deck_master_factor()`
    /// rather than trusting this comment; `master_volume_squares_across_the_shared_graph`
    /// in pipeline.rs is the test that now holds it.
    pub fn set_master_volume(&mut self, volume: f32) {
        self.master_volume = volume.clamp(0.0, 1.0);
        for node in self.nodes.values() {
            node.master_volume_el.set_property("volume", self.master_volume as f64);
        }
    }

    /// Build a node's output pipeline and start it.
    ///
    /// ⚠️ **Nodes are created on demand and then retained for the life of the process**,
    /// even when their last branch detaches. Two reasons, one good and one a deliberate
    /// simplification:
    /// - The first node created provides `shared_clock()`. Tearing it down would leave every
    ///   deck pipeline pinned to a clock object that still exists (it is refcounted) but has
    ///   stopped advancing — the decks would freeze, silently.
    /// - Deciding *when* a node may go, and re-clocking every deck if it was the provider, is
    ///   real work with a nasty failure mode. It is deferred to stage 4 of
    ///   `shared-output-pipeline.md` rather than half-done here.
    ///
    /// The cost is that a device stays open streaming silence after the last deck leaves it.
    /// The tell that this needs finishing: a controller unplugged mid-set leaves an ERROR on
    /// a retained node's bus. That is logged, loudly, below.
    fn create_node(
        &mut self,
        device: &str,
        remap: &Option<ChannelRemap>,
        label: &str,
    ) -> Result<OutputNode, String> {
        let node_name = node_key(device).to_string();
        let (channels, channel_mask) = match remap {
            Some(r) => (r.out_channels, r.channel_mask),
            None => (2i32, 0x3u64),
        };

        let pipeline = gst::Pipeline::new();
        let mixer = make("audiomixer")?;
        let caps_el = make("capsfilter")?;
        // Pin the mixer output. Leaving this open lets the sink's own preference decide the
        // layout, which is how a 4-channel node ends up receiving an unpositioned stereo
        // stream and putting cue audio wherever channelmix feels like — the exact
        // silent-ignore that fix A removed on the deck side (§10.10).
        caps_el.set_property(
            "caps",
            gst::Caps::builder("audio/x-raw")
                .field("format", "F32LE")
                .field("layout", "interleaved")
                .field("rate", 48_000i32)
                .field("channels", channels)
                .field("channel-mask", gst::Bitmask(channel_mask))
                .build(),
        );
        let master_volume_el = make("volume")?;
        master_volume_el.set_property("volume", self.master_volume as f64);
        let sink = make_sink(device, &format!("out/{}", short(&node_name)))?;

        // ── Silent keepalive ──────────────────────────────────────────────────────
        // A permanent live source of digital silence on its own mixer pad. It looks like
        // waste and it is doing three necessary jobs:
        //
        // 1. **An aggregator with no pads cannot start.** Without this the node could not
        //    go PLAYING until its first branch attached, so the clock and the latency —
        //    both read at creation, and both needed *by* that first branch — would not
        //    exist yet. (Measured: the node sat in PAUSED for the full 5s timeout.)
        // 2. **A node whose last branch detaches would otherwise run dry.** Nodes are
        //    retained for the life of the process (see below), and a retained node with no
        //    live pad would go EOS and never resume when a deck came back.
        // 3. It keeps the PipeWire node out of suspend, so the first buffer of the set does
        //    not have to wait for a device resume.
        //
        // It sums zeros into every output channel, so it cannot colour anything.
        let keepalive = make("audiotestsrc")?;
        keepalive.set_property_from_str("wave", "silence");
        keepalive.set_property("is-live", true);
        let keepalive_caps = make("capsfilter")?;
        keepalive_caps.set_property(
            "caps",
            gst::Caps::builder("audio/x-raw")
                .field("format", "F32LE")
                .field("layout", "interleaved")
                .field("rate", 48_000i32)
                .field("channels", channels)
                .field("channel-mask", gst::Bitmask(channel_mask))
                .build(),
        );

        pipeline
            .add_many([&keepalive, &keepalive_caps, &mixer, &caps_el, &master_volume_el, &sink])
            .map_err(|e| format!("[out/{}] add_many: {e}", short(&node_name)))?;
        gst::Element::link_many([&keepalive, &keepalive_caps, &mixer])
            .map_err(|e| format!("[out/{}] keepalive link: {e}", short(&node_name)))?;
        gst::Element::link_many([&mixer, &caps_el, &master_volume_el, &sink])
            .map_err(|e| format!("[out/{}] link: {e}", short(&node_name)))?;

        let latency_ns = Arc::new(AtomicU64::new(0));
        watch_bus(&pipeline, &node_name);

        // A live pipeline: NO_PREROLL is the expected answer and is itself a check that
        // is-live took on the appsrcs. ASYNC here means the graph is not live and an idle
        // branch will stall the mixer — see the module doc.
        let ret = pipeline
            .set_state(gst::State::Playing)
            .map_err(|e| format!("[out/{}] set_state(Playing): {e}", short(&node_name)))?;

        // ⚠️ **Wait for the state change to settle before reading the clock or the
        // latency.** `set_state` is asynchronous: it returns before the sink has reached
        // PLAYING, and until it does the pipeline has selected no clock and reports no
        // latency. Reading them straight after `set_state` yields `None`/0 — which is not
        // an error anywhere, it just means every deck silently falls back to the system
        // clock and drifts, and `position()` silently subtracts nothing. Caught by
        // `two_branches_share_one_node`; that assertion is the only thing standing between
        // this and a class of fault this project has shipped before.
        let (state_res, cur, _pending) = pipeline.state(Some(gst::ClockTime::from_seconds(5)));
        if state_res.is_err() || cur != gst::State::Playing {
            log::warn!(
                "[audio/out/{}] output pipeline did not reach PLAYING within 5s (state={cur:?}) \
                 — clock and latency below may be wrong",
                short(&node_name)
            );
        }

        // Latency is constant once PLAYING; query it here and log it, so the position
        // correction is visible in the log rather than implicit in the arithmetic.
        let mut q = gst::query::Latency::new();
        let (latency, is_live) = if pipeline.query(&mut q) {
            let (live, min, _max) = q.result();
            log::info!(
                "[audio/out/{}] latency query: live={live} min={:?}",
                short(&node_name), min
            );
            (min.nseconds(), live)
        } else {
            (0, false)
        };
        latency_ns.store(latency, Ordering::Relaxed);

        log::info!(
            "[audio/out/{}] created for {label}: {channels}ch mask={channel_mask:#x} \
             state_change={ret:?} latency={:.0}ms — subtracted from every deck position on \
             this node (see OutputGraph::latency_ns)",
            short(&node_name), latency as f64 / 1e6
        );
        // ⚠️ Liveness is checked with the **latency query**, not the `set_state` return.
        // A direct NULL→PLAYING returns ASYNC on a live pipeline too, so an earlier version
        // of this check warned on every single startup of a perfectly live graph
        // (observed 2026-08-11, alongside a working take). The latency query is the
        // authoritative answer — it reported `live=true` in exactly the case the
        // state-change check called broken.
        if !is_live {
            log::warn!(
                "[audio/out/{}] this graph is NOT live (latency query says so). An idle \
                 branch will stall the mixer and silence the whole node — measured, see \
                 scripts/probes/shared_output_mixer_probe.py --not-live.",
                short(&node_name)
            );
        }

        if self.shared_clock.is_none() {
            // Prefer the sink's own audio clock; fall back to whatever the pipeline chose.
            //
            // ⚠️ **The fallback is the normal case here, and it is fine — but only because
            // of *why*.** `GstAudioBaseSink` cannot provide a clock until its ringbuffer is
            // acquired, and on a live pipeline that does not happen until PLAYING — after
            // GstBin has already selected a clock. So the graph runs on `GstSystemClock`
            // and `pulsesink` *slaves its device to it* (`slave-method=skew`, its default).
            // The deck pipelines then adopt the same `GstSystemClock`, so both sides of the
            // handoff run at the same rate and the device-vs-system difference is absorbed
            // inside `pulsesink`, which is exactly that element's job.
            //
            // Rate agreement is what matters (see `shared_clock`), and it holds either way.
            // Verified live 2026-08-11: 4 minutes of playback with `lag=0 drop=0` on both
            // handoffs. If slow drift ever *is* observed, the lever is to re-select the
            // sink's clock after PLAYING and push it to every deck — do not assume that is
            // already happening because this doc comment mentions it.
            let from_sink = sink.provide_clock();
            let chosen = from_sink.clone().or_else(|| pipeline.clock());
            if let Some(clock) = chosen {
                log::info!(
                    "[audio/out/{}] shared clock for every deck pipeline: {} ({})",
                    short(&node_name),
                    clock.name(),
                    if from_sink.is_some() {
                        "the sink's own audio clock"
                    } else {
                        "pipeline fallback — pulsesink slaves its device to this; see OutputGraph::create_node"
                    }
                );
                self.shared_clock = Some(clock);
            } else {
                log::warn!(
                    "[audio/out/{}] no clock available — deck pipelines will run on the \
                     system clock and slowly drift against the device. See \
                     OutputGraph::shared_clock.",
                    short(&node_name)
                );
            }
        }

        Ok(OutputNode {
            name: node_name.clone(),
            pipeline,
            mixer,
            master_volume_el,
            branches: HashMap::new(),
            channels,
            channel_mask,
            latency_ns,
        })
    }
}

impl Drop for OutputGraph {
    fn drop(&mut self) {
        for node in self.nodes.values() {
            let _ = node.pipeline.set_state(gst::State::Null);
        }
    }
}

/// `appsrc → queue → audioconvert(mix-matrix) → capsfilter → audiomixer`, added to a node
/// that may already be PLAYING.
fn build_branch(
    node: &mut OutputNode,
    remap: &Option<ChannelRemap>,
    key: &BranchKey,
    label: &str,
) -> Result<Branch, String> {
    let appsrc_el = make("appsrc")?;
    appsrc_el.set_property("format", gst::Format::Time);
    // See the module doc: is-live is what stops one idle deck silencing the node.
    appsrc_el.set_property("is-live", true);
    // Stamp on arrival. This is the "share rate, re-stamp phase" decision — the deck's own
    // timeline (which pauses, seeks and scratches) never reaches the mixer, so a scratch
    // gesture's discontinuous timestamps cannot resync the shared sink's ringbuffer. That
    // was the root cause in scratch-audio-downstream-delivery.md, and this shape makes it
    // structurally unreachable.
    appsrc_el.set_property("do-timestamp", true);
    appsrc_el.set_property("block", true);
    appsrc_el.set_property("max-bytes", APPSRC_MAX_BYTES);
    appsrc_el.set_property("caps", deck_output_caps());
    let appsrc = appsrc_el
        .downcast_ref::<AppSrc>()
        .ok_or_else(|| "appsrc is not an AppSrc".to_string())?
        .clone();

    let queue = make("queue")?;
    queue.set_property("max-size-buffers", 0u32);
    queue.set_property("max-size-bytes", 0u32);
    queue.set_property("max-size-time", MIX_QUEUE_NS);

    // The per-branch channel remap moves here from the deck pipeline. Each branch maps its
    // stereo stream into the node's full width with its own pair live and the rest zeroed,
    // so summing branches in the mixer is exactly right: main on FL,FR and cue on RL,RR
    // never overlap (`front_and_rear_matrices_do_not_overlap` in pipeline.rs tests this).
    let conv = make("audioconvert")?;
    let matrix_rows: Vec<[f32; 2]> = match remap {
        Some(r) => r.matrix_rows.clone(),
        None if node.channels == 2 => vec![[1.0, 0.0], [0.0, 1.0]],
        None => {
            // A bare (suffix-less) device id arriving at a node that another branch already
            // widened. Route it to the front pair rather than letting audioconvert invent a
            // layout — an unmapped stereo stream on a 4-channel node is precisely the
            // silent-ignore fix A removed.
            log::warn!(
                "[audio/out] {label}: no channel suffix on a {}ch node — routing to the \
                 front pair. Re-select the device in Settings to choose a pair explicitly.",
                node.channels
            );
            let mut rows = vec![[0.0f32, 0.0]; node.channels as usize];
            rows[0] = [1.0, 0.0];
            rows[1] = [0.0, 1.0];
            rows
        }
    };
    if matrix_rows.len() != node.channels as usize {
        return Err(format!(
            "{label}: branch maps to {} channels but node {} is {}ch — a device id from a \
             different layout reached this node",
            matrix_rows.len(), short(&node.name), node.channels
        ));
    }
    let arrays: Vec<gst::Array> =
        matrix_rows.iter().map(|r| gst::Array::new([r[0], r[1]])).collect();
    conv.set_property("mix-matrix", gst::Array::new(arrays));

    let caps_el = make("capsfilter")?;
    caps_el.set_property(
        "caps",
        gst::Caps::builder("audio/x-raw")
            .field("channels", node.channels)
            .field("channel-mask", gst::Bitmask(node.channel_mask))
            .build(),
    );

    let els = vec![appsrc_el, queue, conv, caps_el];
    node.pipeline
        .add_many(els.iter().collect::<Vec<_>>())
        .map_err(|e| format!("{label}: add_many: {e}"))?;
    for pair in els.windows(2) {
        pair[0]
            .link(&pair[1])
            .map_err(|e| format!("{label}: link {} → {}: {e}", pair[0].name(), pair[1].name()))?;
    }

    let mixer_pad = node
        .mixer
        .request_pad_simple("sink_%u")
        .ok_or_else(|| format!("{label}: audiomixer refused a request pad"))?;
    let src_pad = els
        .last()
        .expect("els is non-empty")
        .static_pad("src")
        .ok_or_else(|| format!("{label}: capsfilter has no src pad"))?;
    src_pad
        .link(&mixer_pad)
        .map_err(|e| format!("{label}: capsfilter → audiomixer: {e}"))?;

    // The node may already be PLAYING with other decks on it — a device change on one deck
    // must not interrupt another. Verified against a playing mixer by
    // shared_output_mixer_probe.py --late-attach.
    for el in &els {
        el.sync_state_with_parent()
            .map_err(|e| format!("{label}: sync_state_with_parent: {e}"))?;
    }

    let _ = key; // key is the caller's bookkeeping; branches are anonymous in the graph
    Ok(Branch { appsrc, els, mixer_pad })
}

/// Wire a deck's `appsink` to an output `appsrc`. This is the handoff.
///
/// Returns the counters both ends are measured by — see `docs/design/shared-output-pipeline.md`
/// "Instrumentation": a divergence between them localises a stall to the handoff itself,
/// which no existing probe could see (all of them live on one side or the other).
pub fn wire_handoff(appsink: &AppSink, appsrc: AppSrc, label: String) -> Arc<HandoffCounters> {
    let counters = Arc::new(HandoffCounters::default());
    let c = counters.clone();
    appsink.set_callbacks(
        AppSinkCallbacks::builder()
            .new_sample(move |sink| {
                let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                let Some(buffer) = sample.buffer_owned() else {
                    return Ok(gst::FlowSuccess::Ok);
                };
                c.pulled.fetch_add(1, Ordering::Relaxed);

                // Clear the deck-side timestamps explicitly rather than relying on
                // do-timestamp to overwrite them. The deck's running time is meaningless on
                // the other side of the handoff, and a stale PTS that *did* survive would be
                // interpreted by the mixer as a position on its own timeline — silently
                // dropping the buffer as too old, or holding the whole node waiting for it.
                let mut buffer = buffer;
                {
                    let b = buffer.make_mut();
                    b.set_pts(gst::ClockTime::NONE);
                    b.set_dts(gst::ClockTime::NONE);
                    b.set_duration(gst::ClockTime::NONE);
                }

                match appsrc.push_buffer(buffer) {
                    Ok(_) => {
                        c.pushed.fetch_add(1, Ordering::Relaxed);
                        Ok(gst::FlowSuccess::Ok)
                    }
                    Err(gst::FlowError::Flushing) | Err(gst::FlowError::Eos) => {
                        // The output node is being torn down or rebuilt. Not an error for
                        // the deck: returning Err here would post an error on the *deck's*
                        // bus and stop its playback, for a condition that belongs entirely
                        // to the output side.
                        c.dropped.fetch_add(1, Ordering::Relaxed);
                        Ok(gst::FlowSuccess::Ok)
                    }
                    Err(e) => {
                        let n = c.dropped.fetch_add(1, Ordering::Relaxed);
                        // Rate-limited: a wedged handoff would otherwise write ~67 lines/s.
                        if n < 3 || n % 500 == 0 {
                            log::warn!("[audio/out] {label}: push_buffer failed ({e:?}), n={n}");
                        }
                        Ok(gst::FlowSuccess::Ok)
                    }
                }
            })
            .build(),
    );
    counters
}

/// Buffers out of a deck's appsink against buffers into the matching output appsrc.
#[derive(Default)]
pub struct HandoffCounters {
    pub pulled: AtomicU64,
    pub pushed: AtomicU64,
    pub dropped: AtomicU64,
}

fn make(factory: &str) -> Result<gst::Element, String> {
    gst::ElementFactory::make(factory)
        .build()
        .map_err(|e| format!("[audio/out] element '{factory}' missing: {e}"))
}

/// The bare PipeWire `node.name` a device id targets — everything before `@`. `""` is the
/// system default, and is a legitimate key: all default-output branches share one node.
fn node_key(device: &str) -> &str {
    match device.find('@') {
        Some(at) => &device[..at],
        None => device,
    }
}

/// Last path component of a node name, for log lines. Full PipeWire node names are ~60
/// characters and make every line unreadable.
fn short(node_name: &str) -> String {
    if node_name.is_empty() {
        return "default".to_string();
    }
    node_name.rsplit('.').next().unwrap_or(node_name).to_string()
}

/// An output pipeline has no owner watching it, so its errors would otherwise be silent —
/// and a silent output pipeline is indistinguishable from a deck that stopped producing.
fn watch_bus(pipeline: &gst::Pipeline, node_name: &str) {
    let Some(bus) = pipeline.bus() else { return };
    let name = short(node_name);
    let _ = bus.add_watch(move |_, msg| {
        match msg.view() {
            gst::MessageView::Error(e) => log::error!(
                "[audio/out/{name}] ERROR from {:?}: {} ({:?}). This node is retained for the \
                 life of the process (see OutputGraph::create_node), so it will not recover \
                 on its own — every deck routed here is now silent.",
                e.src().map(|s| s.path_string()), e.error(), e.debug()
            ),
            gst::MessageView::Warning(w) => log::warn!(
                "[audio/out/{name}] WARNING from {:?}: {}",
                w.src().map(|s| s.path_string()), w.error()
            ),
            _ => {}
        }
        glib::ControlFlow::Continue
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const STARLIGHT: &str = "alsa_output.usb-Guillemot_Corporation_DJControl_Starlight-00.analog-surround-40";
    const CODEC: &str = "alsa_output.usb-BurrBrown_from_Texas_Instruments_USB_AUDIO_CODEC-00.analog-stereo";
    const LAYOUT: &str = "FL,FR,RL,RR";

    /// **The whole fix, as an invariant.** The picker offers "— Front" and "— Rear" as two
    /// entries, and the hardware behind them is one 4-channel PCM
    /// (`subdevices_count: 1`, slow-jog-audio-inaudible.md §10.10). If these two ids ever
    /// key to different output nodes, the graph opens two `pulsesink`s on the Starlight
    /// again and the cue gating comes straight back — silently, because two sinks on one
    /// node is not an error, it just gates during a scratch.
    #[test]
    fn front_and_rear_of_one_device_are_one_node() {
        let front = format!("{STARLIGHT}@FL,FR!{LAYOUT}");
        let rear = format!("{STARLIGHT}@RL,RR!{LAYOUT}");
        assert_eq!(node_key(&front), node_key(&rear));
        assert_eq!(node_key(&front), STARLIGHT);
    }

    #[test]
    fn different_devices_are_different_nodes() {
        let starlight = format!("{STARLIGHT}@FL,FR!{LAYOUT}");
        assert_ne!(node_key(&starlight), node_key(CODEC));
    }

    /// A bare id (a genuinely stereo device) and the empty id (system default) are both
    /// legitimate keys — and crucially the empty one is *shared*, so two decks on the
    /// default output also reach one sink.
    #[test]
    fn bare_and_default_ids_key_cleanly() {
        assert_eq!(node_key(CODEC), CODEC);
        assert_eq!(node_key(""), "");
        assert_eq!(short(""), "default");
    }

    #[test]
    fn short_names_the_device_not_the_whole_path() {
        assert_eq!(short(STARLIGHT), "analog-surround-40");
    }

    /// Needs a real audio device, hence `#[ignore]`:
    ///     cargo test -- --ignored --nocapture two_branches_share_one_node
    ///
    /// Asserts the property the design exists for: two branches targeting the two channel
    /// pairs of one device produce **one** output pipeline, and detaching both leaves the
    /// node with no branches (it is retained on purpose — see `create_node`).
    #[test]
    #[ignore]
    fn two_branches_share_one_node() {
        gst::init().expect("gst init");
        let mut graph = OutputGraph::new();
        let front = format!("{STARLIGHT}@FL,FR!{LAYOUT}");
        let rear = format!("{STARLIGHT}@RL,RR!{LAYOUT}");

        let main_key: BranchKey = ("deck-0".into(), "main0".into());
        let cue_key: BranchKey = ("deck-0".into(), "cue".into());
        graph.attach(&front, main_key.clone(), "deck-0/main0").expect("attach main");
        graph.attach(&rear, cue_key.clone(), "deck-0/cue").expect("attach cue");

        assert_eq!(graph.nodes.len(), 1, "front and rear must share one output pipeline");
        let node = graph.nodes.values().next().unwrap();
        assert_eq!(node.branches.len(), 2);
        assert_eq!(node.channels, 4, "the node must be the device's full width");
        assert!(graph.shared_clock().is_some(), "a playing output node must provide a clock");
        let latency_ms = graph.latency_ns(&front) as f64 / 1e6;
        println!("output latency = {latency_ms:.1}ms (subtracted from every deck position)");
        assert!(
            latency_ms > 0.0,
            "latency must be measurable — position() subtracts it, and a zero here means \
             every deck reports ahead of what is audible"
        );
        // Sanity band rather than an exact value: it is buffer-time (200ms) plus the mixer
        // and queue, and it moves with CUEMARK_SINK_BUFFER_MS. Outside this band something
        // structural changed and the position correction should be re-checked by stopwatch.
        assert!(
            (50.0..600.0).contains(&latency_ms),
            "output latency {latency_ms:.1}ms is outside the expected band"
        );

        graph.detach(&main_key);
        graph.detach(&cue_key);
        assert_eq!(graph.nodes.values().next().unwrap().branches.len(), 0);
    }
}
