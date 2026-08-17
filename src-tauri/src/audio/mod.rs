pub mod analysis;
pub mod devices;
pub mod mixer;
pub mod pcm_buffer;
pub mod pipeline;
pub mod record;
pub mod snapcontrol;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tauri::{Emitter, Manager, State};

use crate::media_cache::MediaCache;
use self::devices::AudioDevice;
use self::mixer::OutputGraph;
use self::pipeline::DeckAudioPipeline;
use self::record::{RecordFormat, RecordingSink};

/// Central audio state, held behind a Mutex in Tauri's managed state.
pub struct AudioManager {
    pipelines: HashMap<String, DeckAudioPipeline>,
    /// PipeWire sink names for the main outputs (empty vec = single system-default output).
    /// Passed to new pipelines at load time and applied to existing ones on change.
    main_devices: Vec<String>,
    /// PipeWire sink name for the headphone cue output (empty = no cue output).
    cue_device: String,
    /// Master volume factor (0–1). Applied to all deck pipelines as a multiplier on top of
    /// gain×vol. Stored here so new pipelines pick it up at load time.
    master_volume: f32,
    /// One `pulsesink` per device node, shared by every deck — the fix for
    /// `slow-jog-audio-inaudible.md`'s cue gating. Active by default since 2026-08-11
    /// (`CUEMARK_SHARED_OUTPUT=0` reverts to the legacy path, where this is constructed
    /// and never used — building no output pipelines costs nothing). See
    /// `docs/design/shared-output-pipeline.md`.
    ///
    /// An `Arc` because `with_pipeline_detached()` removes a deck from `pipelines` for the
    /// duration of a blocking call, and that deck still has to reach the graph.
    output_graph: Arc<Mutex<OutputGraph>>,
    /// Live Snapcast group claims, keyed by device id — one per enabled network target.
    /// Claimed in `audio_set_main_devices` when a target enters the main list, released
    /// when it leaves (or the app exits, via `take_snapcast_claims`). See `snapcontrol`.
    snapcast_claims: HashMap<String, snapcontrol::Claim>,
    record: RecordingSink,
}

impl AudioManager {
    pub fn new() -> Self {
        gstreamer::init().expect("GStreamer init failed");
        Self {
            pipelines: HashMap::new(),
            main_devices: Vec::new(),
            cue_device: String::new(),
            master_volume: 1.0,
            output_graph: Arc::new(Mutex::new(OutputGraph::new())),
            snapcast_claims: HashMap::new(),
            record: RecordingSink::new(),
        }
    }

    /// Take every live Snapcast claim out of the manager, for release on app exit —
    /// quitting with a target enabled must hand the speakers back the same way
    /// unticking it does. Take-then-release (rather than release-under-lock) keeps the
    /// JSON-RPC calls out from under the audio mutex; a claim lost to a concurrent
    /// device change here is impossible because exit is the last event the app processes.
    pub fn take_snapcast_claims(&mut self) -> Vec<snapcontrol::Claim> {
        self.snapcast_claims.drain().map(|(_, c)| c).collect()
    }

    fn pipeline_mut(&mut self, deck_id: &str) -> Result<&mut DeckAudioPipeline, String> {
        self.pipelines
            .get_mut(deck_id)
            .ok_or_else(|| format!("no audio pipeline for deck '{deck_id}'"))
    }

    /// Live status of every loaded pipeline — the ground truth for session recovery
    /// (docs/design/freeze-watchdog.md phase 2). A webview freeze/reload loses all JS
    /// state, but these pipelines are a separate OS process's objects and never stop;
    /// session_store.rs's `session_restore()` blends this on top of the (possibly ~1s
    /// stale) JSON snapshot the frontend last pushed.
    pub fn audio_status(&self) -> Vec<DeckAudioStatus> {
        self.pipelines
            .values()
            .map(|p| DeckAudioStatus {
                deck_id: p.deck_id.clone(),
                file_path: p.file_path.clone(),
                position_secs: p.position(),
                playing: p.is_playing(),
                rate: p.rate(),
            })
            .collect()
    }
}

/// Live snapshot of one deck's audio pipeline. See `AudioManager::audio_status`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckAudioStatus {
    pub deck_id: String,
    pub file_path: Option<String>,
    pub position_secs: Option<f64>,
    pub playing: bool,
    pub rate: f64,
}

pub type AudioState = Mutex<AudioManager>;

/// Runs `f` against one deck's pipeline without holding `state`'s mutex for the
/// duration of `f` itself — only for the HashMap remove/insert around it. Same pattern
/// as `audio_load`'s preroll fix below, generalized: any deck command whose pipeline
/// call can block for a while (GStreamer preroll, the scratch-teardown resync seek in
/// `stop_scratch_feeder`) must not do so while every other deck's audio IPC (position
/// polls, rate/gain syncs) is queued up behind the same global lock. A concurrent call
/// for *this same* deck_id while it's detached fails fast with "no audio pipeline for
/// deck" (already a handled, `.catch()`'d error path everywhere on the frontend) rather
/// than racing on the pipeline's internal GStreamer state — see
/// docs/design/pcm-buffer-playback.md and project memory project_pcm_scratch_status.md
/// for the live-hardware stall this fixes (vinyl-mode jog decks became unresponsive).
fn with_pipeline_detached<T>(
    state: &Mutex<AudioManager>,
    deck_id: &str,
    op: &str,
    f: impl FnOnce(&mut DeckAudioPipeline) -> T,
) -> Result<T, String> {
    // Logged with millisecond precision (see lib.rs's custom log formatter) so a stall
    // report can be correlated against the last MIDI tick's own timestamp — narrows
    // down "JS-side delay before the IPC call was even issued" vs. "Rust-side work
    // itself took a long time" without guessing.
    //
    // `op` names the calling command. Without it these lines are anonymous, and a burst
    // of them says only "something detached 25 times a second" — which is exactly the
    // state a jog-lag report left this log in (2026-08-03): a sustained ~200ms-periodic
    // burst that could have been play, pause, stop_scratch or a device rebuild, each with
    // very different cost (stop_scratch alone runs a 130–400ms drain + two flush seeks).
    // A detach is rare by design; if a burst shows up here, the name is the whole lead.
    let start = std::time::Instant::now();
    log::info!("[audio/{deck_id}] detached-pipeline IPC received: {op}");
    let mut pipeline = {
        let mut mgr = state.lock().unwrap();
        mgr.pipelines
            .remove(deck_id)
            .ok_or_else(|| format!("no audio pipeline for deck '{deck_id}'"))?
        // mutex released here
    };
    let result = f(&mut pipeline);
    state.lock().unwrap().pipelines.insert(deck_id.to_string(), pipeline);
    // Only the slow ones — a no-op pause is ~0ms and would just double the log volume.
    // 20ms is well under the 130–400ms scratch teardown but above any healthy state change.
    let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
    if elapsed_ms > 20.0 {
        log::info!("[audio/{deck_id}] {op} held the pipeline detached for {elapsed_ms:.0}ms");
    }
    Ok(result)
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_audio_devices(_state: State<'_, AudioState>) -> Vec<AudioDevice> {
    devices::list_audio_devices()
}

// Async + spawn_blocking, same pattern as audio_analyze_file/video_demux_load below —
// necessary since ensure_cached() can now block on a multi-second network fetch (Digger
// fallback, media_cache.rs) rather than just a fast local stat/copy. A synchronous
// #[tauri::command] blocking for several seconds froze the whole window (confirmed live:
// tripped the freeze-watchdog's 6s threshold, cascaded through all three recovery tiers,
// and tier3's SIGKILL didn't bring the app back). `cache` is cloned to an owned Arc before
// spawning (State's borrow isn't 'static); `AudioState` (a bare Mutex, not Clone) is
// re-fetched inside the blocking closure via the cloned AppHandle's `.state::<AudioState>()`
// — same underlying managed Mutex<AudioManager>, not a new instance.
#[tauri::command]
pub async fn audio_load(app: tauri::AppHandle, cache: State<'_, Arc<MediaCache>>, deck_id: String, file_path: String, fallback_url: Option<String>) -> Result<Option<f64>, String> {
    let cache = cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AudioState>();

        // Resolve to a local disk copy before touching GStreamer at all — see media_cache.rs.
        // The library here is served over SMB/CIFS; scratch leaves the normal playback
        // branch idle for a whole gesture, and resuming it against the network share after
        // that idle period was measured blocking for ~10s on a live repro (SMB
        // re-negotiation). PCM decode and uridecodebin preroll below both read this same
        // local path, so the network is touched at most once per track, not repeatedly.
        // Caching is an optimization, not a requirement: fall back to the original path on
        // any failure (permissions, disk full, source not stat-able yet) rather than
        // failing the load outright. `fallback_url`, when the local path doesn't stat at
        // all, lets ensure_cached() fetch from Digger instead — see its doc comment.
        let load_path = cache.ensure_cached(&file_path, fallback_url.as_deref()).unwrap_or_else(|e| {
            log::warn!("[audio/{deck_id}] media cache miss, loading directly from source: {e}");
            file_path.clone()
        });

        // Pull the pipeline out of the map before calling load() so the mutex is not held
        // during GStreamer preroll (which can block for up to 5 seconds). Without this,
        // every other audio command (audio_get_position, audio_play, …) waits on the mutex
        // for the full preroll duration, making the UI unresponsive on first track load.
        let mut pipeline = {
            let mut mgr = state.lock().unwrap();
            // Temporary assertion (freeze-watchdog.md phases 2-3, "Adoption bugs" risk):
            // session recovery must NEVER call audio_load on a deck whose pipeline is
            // already loaded+playing — that's the one way rehydration could audibly
            // glitch a track that survived the freeze untouched. Any real caller hitting
            // this is a bug in the adoption-skip logic (App.svelte's pendingAdoption),
            // not an expected state; log loudly instead of silently reloading.
            if let Some(existing) = mgr.pipelines.get(&deck_id) {
                if existing.is_playing() {
                    log::error!(
                        "[audio/{deck_id}] audio_load called while pipeline is already playing \
                         (pos={:?}) — this will audibly glitch; see freeze-watchdog.md \"Adoption bugs\" risk",
                        existing.position()
                    );
                }
            }
            let main_devices = mgr.main_devices.clone();
            let cue_device = mgr.cue_device.clone();
            let master_volume = mgr.master_volume;
            let output_graph = mgr.output_graph.clone();
            mgr.pipelines.remove(&deck_id).unwrap_or_else(|| {
                let mut p = DeckAudioPipeline::new(&deck_id);
                p.devices = main_devices;
                p.cue_device = cue_device;
                p.master_volume = master_volume;
                // Must be set before load() — the graph is consulted while the pipeline is
                // being built, not after.
                p.set_output_graph(output_graph);
                let app_clone = app.clone();
                let did = deck_id.clone();
                p.set_eos_callback(move || {
                    let _ = app_clone.emit("deck-eos", did.clone());
                });
                p
            })
            // mutex released here
        };

        pipeline.set_app(app.clone());
        let result = pipeline.load(&load_path); // preroll runs without holding the mutex

        // Re-insert the pipeline (even on error, to preserve the object for future loads).
        state.lock().unwrap().pipelines.insert(deck_id, pipeline);

        result
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn audio_unload(state: State<'_, AudioState>, deck_id: String) -> Result<(), String> {
    let mut mgr = state.lock().unwrap();
    mgr.pipelines.remove(&deck_id);
    Ok(())
}

// Async + spawn_blocking (2026-08-01 live incident): `play()`'s gstreamer set_state(Playing)
// call can block on PipeWire's pw_thread_loop_lock() — confirmed live via gdb on a hung
// `cuemark` process: the GTK main thread (which every Tauri IPC dispatch, and therefore
// every WebKitWebProcess frame/event delivery, runs through) was parked inside exactly
// that lock, for a pipewiresink targeting a real USB audio interface for the first time
// that session (previously fakesink/default-target sinks negotiated fast enough that this
// never surfaced). WebKitWebProcess itself was NOT deadlocked (its own gdb backtrace showed
// every thread idle) — it was simply starved, since its parent process's main loop had
// stopped pumping entirely. A synchronous #[tauri::command] here blocks that same main
// thread for however long PipeWire takes to grant the lock, freezing the whole app, not
// just this deck's audio.
//
// The first fix attempt (spawn_blocking alone, still holding `state.lock()` across the
// whole `.play()` call) did NOT resolve this — a second live incident on the same night
// reproduced an identical-looking freeze, and a follow-up gdb capture showed why: the
// spawn_blocking thread was parked in `pw_thread_loop_lock()` *while still holding the
// `Mutex<AudioManager>`*, and `audio_get_position` (still fully synchronous, polled every
// rAF frame from the GTK main thread) piled up behind that same mutex — so the app-wide
// freeze reproduced via lock contention instead of a direct blocking call on the main
// thread. Fixed by switching to `with_pipeline_detached`, the same pattern `audio_pause`
// already used correctly below: the mutex is held only for the brief HashMap
// remove/insert around `.play()`, not for the call itself, so `audio_get_position` and
// every other deck's IPC never wait on PipeWire.
#[tauri::command]
pub async fn audio_play(app: tauri::AppHandle, deck_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AudioState>();
        with_pipeline_detached(&state, &deck_id, "play", |p| p.play())?
    })
    .await
    .map_err(|e| e.to_string())?
}

// Async + spawn_blocking — same reasoning as audio_play above; pause() calls the identical
// gstreamer set_state() path (Playing -> Paused), equally capable of blocking on PipeWire.
#[tauri::command]
pub async fn audio_pause(app: tauri::AppHandle, deck_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AudioState>();
        // Detached: pause() may run stop_scratch_feeder()'s ~130-400ms teardown+resync
        // (drain sleep + two flush seeks) if a scratch was active — see
        // with_pipeline_detached's doc comment above.
        with_pipeline_detached(&state, &deck_id, "pause", |p| p.pause())?
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn audio_seek(state: State<'_, AudioState>, deck_id: String, secs: f64) -> Result<(), String> {
    state.lock().unwrap().pipeline_mut(&deck_id)?.seek(secs)
}

#[tauri::command]
pub fn audio_set_rate(state: State<'_, AudioState>, deck_id: String, rate: f64) -> Result<(), String> {
    state.lock().unwrap().pipeline_mut(&deck_id)?.set_rate(rate)
}

/// Variable-rate scratch playback while paused (PCM-buffer feeder branch, negative =
/// reverse). `hold_ms` controls how long the feeder keeps free-running at the last
/// `rate` after ticks stop arriving before decaying to silence/hold — large for
/// shuttle-style scratch (effectively never decays within a gesture), small for
/// vinyl-style direct manipulation (decays almost immediately, like a stationary
/// hand on a real record). See `DeckAudioPipeline::scratch` and
/// docs/design/pcm-buffer-playback.md.
#[tauri::command]
pub fn audio_scratch(state: State<'_, AudioState>, deck_id: String, rate: f64, hold_ms: u64) -> Result<(), String> {
    state.lock().unwrap().pipeline_mut(&deck_id)?.scratch(rate, hold_ms)
}

/// Position-mode scratch: drive the scratch feeder toward an absolute content position
/// rather than at a rate. Used by the waveform drag and by vinyl-mode jog — see
/// `DeckAudioPipeline::scratch_to`. Deliberately *not* detached: like `audio_scratch`
/// this is a per-frame hot path during a gesture, and after the first call it is only an
/// atomic store behind the manager lock.
///
/// `inertia_ms` is the platter-mass taste setting, sent on every call so it can be tuned by
/// ear during a live gesture — see `SCRATCH_RATE_INERTIA_MS`.
#[tauri::command]
pub fn audio_scratch_to(
    state: State<'_, AudioState>,
    deck_id: String,
    target_secs: f64,
    hold_ms: u64,
    inertia_ms: f64,
) -> Result<(), String> {
    state.lock().unwrap().pipeline_mut(&deck_id)?.scratch_to(target_secs, hold_ms, inertia_ms)
}

#[tauri::command]
pub fn audio_stop_scratch(state: State<'_, AudioState>, deck_id: String) -> Result<(), String> {
    // Detached — same reason as audio_pause above.
    with_pipeline_detached(&state, &deck_id, "stop_scratch", |p| p.stop_scratch())?
}

#[tauri::command]
pub fn audio_set_gain(state: State<'_, AudioState>, deck_id: String, gain: f32) -> Result<(), String> {
    state.lock().unwrap().pipeline_mut(&deck_id)?.set_gain(gain)
}

#[tauri::command]
pub fn audio_set_volume(state: State<'_, AudioState>, deck_id: String, volume: f32) -> Result<(), String> {
    state.lock().unwrap().pipeline_mut(&deck_id)?.set_volume(volume)
}

#[tauri::command]
pub fn audio_set_eq(
    state: State<'_, AudioState>,
    deck_id: String,
    low_db: f32,
    mid_db: f32,
    high_db: f32,
) -> Result<(), String> {
    state.lock().unwrap().pipeline_mut(&deck_id)?.set_eq(low_db, mid_db, high_db)
}

#[tauri::command]
pub fn audio_set_cue(state: State<'_, AudioState>, deck_id: String, enabled: bool) -> Result<(), String> {
    state.lock().unwrap().pipeline_mut(&deck_id)?.set_cue_enabled(enabled)
}

/// One `audio_get_position` reply, plus the timing breakdown of how it was served.
///
/// The position poll is the master clock's transport — every playing deck runs one per
/// rAF frame and a video resync hangs off each resolution — so when it goes slow the
/// first question is always *which layer*. The round trip has three legs: JS → GTK main
/// thread (this is a synchronous command, so it is dispatched there), the command body,
/// and GTK main thread → the JS callback. Only the middle leg is the audio backend.
/// `entry_ms`/`exit_ms` are epoch ms (see `crate::epoch_ms`), directly comparable to the
/// caller's `Date.now()`, so the frontend can attribute a slow poll instead of guessing.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionSample {
    /// Position in seconds, or null if unknown — the actual payload; everything else
    /// on this struct is instrumentation.
    pub pos: Option<f64>,
    /// Epoch ms at which the command body began running on the GTK main thread.
    pub entry_ms: f64,
    /// Ms spent waiting for the `Mutex<AudioManager>` (contention with a detached
    /// play/pause/device-rebuild — the mechanism behind the 2026-08-01 freeze).
    pub lock_ms: f64,
    /// Ms spent inside `DeckAudioPipeline::position()` — i.e. GStreamer's
    /// `query_position`. Near-zero during a scratch, which reads the feeder's atomic
    /// cursor and never touches the pipeline at all.
    pub query_ms: f64,
    /// Epoch ms at which the command body finished.
    pub exit_ms: f64,
}

/// Returns the pipeline's current position in seconds, or null if unknown.
/// The frontend uses this as the authoritative clock for video sync.
#[tauri::command]
pub fn audio_get_position(state: State<'_, AudioState>, deck_id: String) -> PositionSample {
    let entry_ms = crate::epoch_ms();

    let lock_start = std::time::Instant::now();
    let mgr = state.lock().unwrap();
    let lock_ms = lock_start.elapsed().as_secs_f64() * 1000.0;

    let query_start = std::time::Instant::now();
    let pos = mgr.pipelines.get(&deck_id).and_then(|p| p.position());
    let query_ms = query_start.elapsed().as_secs_f64() * 1000.0;
    drop(mgr); // don't hold the lock across the exit timestamp

    PositionSample { pos, entry_ms, lock_ms, query_ms, exit_ms: crate::epoch_ms() }
}

#[tauri::command]
pub fn audio_set_master_volume(state: State<'_, AudioState>, volume: f32) -> Result<(), String> {
    let mut mgr = state.lock().unwrap();
    let factor = volume.clamp(0.0, 1.0);
    mgr.master_volume = factor;
    // Pushed to both places on purpose, but only **one of them applies it**: each deck
    // gates its own factor through `deck_master_factor()`, which is 1.0 whenever the shared
    // graph is in use because the graph's per-node master stage is the real one there.
    // Every deck still stores the factor, so falling back to the legacy per-branch path
    // (CUEMARK_SHARED_OUTPUT=0) does not silently lose master attenuation.
    //
    // ⚠️ Until 2026-08-13 the deck side applied it unconditionally and the two multiplied:
    // a silent extra −9 dB at the usual setting, invisible to every deck-side probe because
    // they all sit upstream of the node's master stage. See `deck_master_factor()`.
    mgr.output_graph.lock().unwrap().set_master_volume(factor);
    for pipeline in mgr.pipelines.values_mut() {
        pipeline.set_master_volume_factor(factor);
    }
    Ok(())
}

/// Declare how far behind this process a device's audible output actually is, in
/// milliseconds — the delay GStreamer's latency query structurally cannot see because it
/// happens on another machine (a Snapcast server's `buffer`, its clients' presentation
/// delay). See `OutputGraph::set_extra_latency`.
///
/// Configured in Settings, never inferred: it is a property of the receiving system, and
/// the app has no way to measure it. Zero (the default) means "uncorrected", which is
/// correct for every local device.
///
/// Applies immediately, including to a deck that is already playing — the value is tuned by
/// ear against a real room, and a correction that only took effect on the next track reload
/// could not be tuned at all.
#[tauri::command]
pub fn audio_set_output_latency(
    state: State<'_, AudioState>,
    device_id: String,
    latency_ms: u32,
) -> Result<(), String> {
    let mgr = state.lock().unwrap();
    mgr.output_graph
        .lock()
        .unwrap()
        .set_extra_latency(&device_id, latency_ms as u64 * 1_000_000);
    Ok(())
}

// Async + spawn_blocking (2026-08-01 live incident — see audio_play's doc comment for the
// full gdb-confirmed root cause). `set_devices()`/`set_cue_device()` below are an even
// bigger exposure than plain play/pause: they unconditionally tear down and rebuild each
// pipeline's GStreamer graph, including brand-new pipewiresink negotiation with PipeWire —
// exactly the call path caught blocked on `pw_thread_loop_lock()` in the live incident.
// This was previously invisible because every prior test tonight used fakesink or an empty
// (system-default) target; it reproduced the moment a real USB hardware device was set as
// the cue output for the first time.
//
// Like audio_play, spawn_blocking alone wasn't enough — the original version below held
// `state.lock()` for the ENTIRE per-pipeline loop, so one pipeline stuck in
// `pw_thread_loop_lock()` blocked `audio_get_position` (and every other deck command) via
// mutex contention for as long as PipeWire took, reproducing the same app-wide freeze.
// Fixed by taking the lock only for the no-op check / bookkeeping / device-id snapshot,
// then detaching each pipeline via `with_pipeline_detached` for its own `set_devices()`/
// `set_cue_device()` call, same as `audio_play` above.
#[tauri::command]
pub async fn audio_set_main_devices(app: tauri::AppHandle, device_ids: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AudioState>();
        let (deck_ids, now_claiming, releasing): (Vec<String>, Vec<String>, Vec<snapcontrol::Claim>) = {
            let mut mgr = state.lock().unwrap();
            // No-op guard: the frontend calls this unconditionally on every mount (App.svelte's
            // `$effect` syncing the persisted `mainOutputDeviceIds` store has no change check),
            // and `DeckAudioPipeline::set_devices` unconditionally tears down and rebuilds the
            // GStreamer pipeline (PipeWire's pipewiresink can't retarget at runtime). On a normal
            // cold boot `pipelines` is still empty so the rebuild is free — but on a freeze-watchdog
            // recovery-boot reload (docs/design/freeze-watchdog.md phase 2), the pipeline the
            // frontend just finished carefully *adopting* without an audioLoad call gets torn down
            // and rebuilt seconds later by this unrelated call, producing an audible glitch (brief
            // stutter, position rewound slightly) — confirmed live 2026-07-25. Same fix pattern as
            // `audio_set_cue_device` below.
            if mgr.main_devices == device_ids {
                return Ok(());
            }
            let previous = mgr.main_devices.clone();
            mgr.main_devices = device_ids.clone();
            // Snapcast group claiming (snapcontrol.rs): a network target entering the main
            // list takes over the server's speaker groups; one leaving gives them back.
            // Diffed under the same guard that already de-duplicates this command, so each
            // toggle claims/releases exactly once — including the app-start case, where a
            // persisted ticked target is "entering" an empty list and claims on mount.
            let is_network = |id: &String| pipeline::parse_snapcast_device(id).is_some();
            let now_claiming: Vec<String> = device_ids
                .iter()
                .filter(|id| is_network(id) && !previous.contains(*id))
                .cloned()
                .collect();
            let mut releasing = Vec::new();
            for id in previous.iter().filter(|id| is_network(id) && !device_ids.contains(*id)) {
                if let Some(ticket) = mgr.snapcast_claims.remove(id) {
                    releasing.push(ticket);
                }
            }
            // Nothing to do here for the shared output graph: it learns about devices from
            // each deck's rebuild below (`set_devices` → `load()` → `OutputGraph::attach`),
            // which is also what tears down the branches on the old node. The `MasterMix`
            // stub that used to be called here never did anything.
            (
                mgr.pipelines.keys().cloned().collect(),
                now_claiming,
                releasing,
            )
            // mutex released here — claim/release do blocking JSON-RPC and must not run
            // under it, exactly like the per-deck rebuilds below
        };
        // Releases before claims, so swapping one server for another never routes a group
        // straight from the old claim to the new one and back. Every failure is logged
        // and swallowed: the audio path to the tcp:// source is independent of group
        // routing, so this degrades to the old manual-switch behaviour, never to silence.
        for ticket in &releasing {
            if let Err(e) = snapcontrol::release(ticket) {
                log::warn!(
                    "[audio/snapcast] release failed ({}) — speakers may need switching back \
                     manually: {e}",
                    ticket.describe()
                );
            }
        }
        for device in &now_claiming {
            match snapcontrol::claim(device) {
                Ok(ticket) => {
                    log::info!("[audio/snapcast] claimed {}", ticket.describe());
                    state.lock().unwrap().snapcast_claims.insert(device.clone(), ticket);
                }
                Err(e) => log::warn!(
                    "[audio/snapcast] could not claim groups on {device} — audio will still \
                     stream, but no speaker group switches to it automatically; untick and \
                     retick the target once the server is reachable: {e}"
                ),
            }
        }
        for deck_id in deck_ids {
            let device_ids = device_ids.clone();
            let outcome = with_pipeline_detached(&state, &deck_id, "set_devices", move |p| p.set_devices(&device_ids));
            match outcome {
                Ok(Err(e)) => log::error!("[audio] set_devices failed for {deck_id}: {e}"),
                Err(e) => log::error!("[audio] set_devices: pipeline vanished for {deck_id}: {e}"),
                Ok(Ok(())) => {}
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn audio_set_cue_device(app: tauri::AppHandle, device_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AudioState>();
        let deck_ids: Vec<String> = {
            let mut mgr = state.lock().unwrap();
            // No-op guard — see the matching comment in audio_set_main_devices above; same bug,
            // same fix, for the headphone cue output's `$effect` in App.svelte.
            if mgr.cue_device == device_id {
                return Ok(());
            }
            mgr.cue_device = device_id.clone();
            // See audio_set_main_devices: the graph is driven by the per-deck rebuilds below.
            mgr.pipelines.keys().cloned().collect()
            // mutex released here
        };
        for deck_id in deck_ids {
            let device_id = device_id.clone();
            let outcome = with_pipeline_detached(&state, &deck_id, "set_cue_device", move |p| p.set_cue_device(&device_id));
            match outcome {
                Ok(Err(e)) => log::error!("[audio] set_cue_device failed for {deck_id}: {e}"),
                Err(e) => log::error!("[audio] set_cue_device: pipeline vanished for {deck_id}: {e}"),
                Ok(Ok(())) => {}
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn audio_set_cue_gain(state: State<'_, AudioState>, gain: f32) -> Result<(), String> {
    let mut mgr = state.lock().unwrap();
    // Cue gain is per deck (each deck's cue branch has its own `volume`), so unlike master
    // volume there is no node-level stage for it in the shared output graph.
    for pipeline in mgr.pipelines.values_mut() {
        if let Err(e) = pipeline.set_cue_gain(gain) {
            log::error!("[audio] set_cue_gain failed for {}: {e}", pipeline.deck_id);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn audio_record_start(
    state: State<'_, AudioState>,
    output_path: String,
    format: RecordFormat,
) -> Result<(), String> {
    state
        .lock()
        .unwrap()
        .record
        .start(output_path.into(), format)
}

#[tauri::command]
pub fn audio_record_stop(state: State<'_, AudioState>) -> Result<(), String> {
    state.lock().unwrap().record.stop()
}

/// Compute waveform peaks (30/s) and beat-grid RMS envelope (210/s) for a file
/// entirely in Rust, bypassing WebKit's `decodeAudioData` path which triggers
/// vaav1dec on video+audio containers and corrupts VA-API driver state.
///
/// Async so the Tauri IPC thread is not blocked during the full-file GStreamer decode.
/// `spawn_blocking` runs compute_analysis on a dedicated OS thread so it doesn't starve
/// the async executor.
#[tauri::command]
pub async fn audio_analyze_file(
    cache: State<'_, Arc<MediaCache>>,
    analysis_cache: State<'_, Arc<analysis::AnalysisCache>>,
    file_path: String,
    fallback_url: Option<String>,
) -> Result<analysis::AnalysisData, String> {
    // Calls ensure_cached() directly (same as audio_load) rather than a passive
    // lookup_wait() — this runs independently of/racing with audio_load (WaveformCanvas's
    // $effect fires off the same deck.source change, on Svelte's own scheduler, not
    // App.svelte's rAF-scheduled syncVideoElements), and lookup_wait() only waits out a
    // copy that is *already* InProgress — if this call reaches MediaCache before
    // audio_load's ensure_cached() has inserted that marker, lookup_wait() sees no entry
    // at all and returns immediately, silently falling back to the original (possibly
    // unreachable, e.g. no local NAS mount) path. Confirmed live 2026-08-01: analysis
    // failed and the waveform rendered blank/silent while audio_load's own fetch was still
    // in flight. ensure_cached()'s InProgress branch already coordinates concurrent
    // callers safely (whichever arrives first does the copy/fetch, the other waits), so
    // calling it here directly closes the race instead of depending on call-order luck.
    let cache = cache.inner().clone();
    let analysis_cache = analysis_cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path = cache.ensure_cached(&file_path, fallback_url.as_deref())?;
        analysis_cache.get_or_compute(&path)
    })
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod concurrency_stress_test {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    /// Regression guard for the vinyl-mode stall fixed by `with_pipeline_detached`:
    /// before this fix, `audio_pause`/`audio_stop_scratch` held the single
    /// `Mutex<AudioManager>` for the entire scratch-teardown resync (~130-400ms: a
    /// drain sleep plus two flush seeks in `stop_scratch_feeder`), so every other
    /// deck's audio IPC — including a plain position poll — queued up behind it.
    /// Drives deck-a through repeated scratch → pause (teardown) cycles on one thread
    /// while hammering deck-b's `position()` on another, and asserts deck-b's
    /// worst-case call latency never approaches the teardown's blocking duration.
    /// Manually run (`cargo test concurrency_stress -- --ignored --nocapture`) — like
    /// the pipeline.rs smoke tests, it needs real GStreamer init and a real local file.
    #[test]
    #[ignore]
    fn other_deck_ipc_stays_responsive_during_teardown() {
        gstreamer::init().expect("gst init");
        let path = "/home/account/Downloads/audio.wav";

        let mgr = Mutex::new(AudioManager::new());
        {
            let mut m = mgr.lock().unwrap();
            let mut a = DeckAudioPipeline::new("deck-a");
            a.load(path).expect("load deck-a");
            m.pipelines.insert("deck-a".to_string(), a);
            let mut b = DeckAudioPipeline::new("deck-b");
            b.load(path).expect("load deck-b");
            m.pipelines.insert("deck-b".to_string(), b);
        }
        let mgr = Arc::new(mgr);

        let stop = Arc::new(AtomicBool::new(false));
        let max_latency_us = Arc::new(AtomicU64::new(0));

        // Thread A: repeatedly start a scratch gesture on deck-a, then immediately
        // pause it — pause() runs the full teardown+resync every time, same as a real
        // vinyl-mode nudge-then-release cycle.
        let mgr_a = mgr.clone();
        let stop_a = stop.clone();
        let deck_a = std::thread::spawn(move || {
            while !stop_a.load(Ordering::Relaxed) {
                let _ = with_pipeline_detached(&mgr_a, "deck-a", "test", |p| {
                    let _ = p.scratch(1.0, 100_000);
                    std::thread::sleep(Duration::from_millis(10));
                    let _ = p.pause();
                });
            }
        });

        // Thread B: hammer deck-b's position() and record worst-case call latency.
        let mgr_b = mgr.clone();
        let stop_b = stop.clone();
        let max_b = max_latency_us.clone();
        let deck_b = std::thread::spawn(move || {
            while !stop_b.load(Ordering::Relaxed) {
                let t0 = Instant::now();
                let _ = with_pipeline_detached(&mgr_b, "deck-b", "test", |p| p.position());
                let us = t0.elapsed().as_micros() as u64;
                max_b.fetch_max(us, Ordering::Relaxed);
                std::thread::sleep(Duration::from_millis(5));
            }
        });

        std::thread::sleep(Duration::from_secs(3));
        stop.store(true, Ordering::Relaxed);
        deck_a.join().unwrap();
        deck_b.join().unwrap();

        let max_ms = max_latency_us.load(Ordering::Relaxed) as f64 / 1000.0;
        println!("deck-b worst-case position() latency during deck-a teardown churn: {max_ms:.1}ms");
        assert!(
            max_ms < 50.0,
            "deck-b's position() should never wait behind deck-a's teardown; worst case was {max_ms:.1}ms"
        );
    }
}
