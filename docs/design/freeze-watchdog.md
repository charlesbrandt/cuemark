# Freeze watchdog and session recovery (design)

Status: **Phase 1 (observe-only) implemented and live-verified 2026-07-25.** Heartbeat
(`App.svelte`/`output.ts` → `watchdog_heartbeat`), the Rust watchdog thread
(`src-tauri/src/watchdog.rs`), and diagnostics logging are in; recovery is still
disabled. Verified live: `kill -STOP` on the real `WebKitWebProcess` produced a
trigger log (with the process's `T` state and zero utime/stime delta flagged as the
known deadlock signature) ~5.5s after the last heartbeat, and `kill -CONT` produced a
"heartbeat resumed after Ns silence" log — no false triggers across ~35s of otherwise
idle operation. Also added the `freezeMainThread`/`killRafLoop` debug hooks from the
"Debug/simulation hooks" section below. Phases 2–4 (session-of-record, armed recovery,
mechanism-B self-heal) not started. Ships before (and independently of)
`webcodecs-video-path.md`. Rationale discussion: 2026-07-25 session; background:
`pcm-buffer-playback.md` mechanisms Nine/Ten/Eleven and the
`project_webkit_freeze_mechanisms` memory.

## Goal

Cuemark is live-performance software. The two known WebKitGTK freeze mechanisms are
unfixable in-app (they're inside `MediaPlayerPrivateGStreamer`), and there will be
webview failure modes we haven't met yet. This design does not prevent freezes — it
converts **any** webview death or freeze into: *music never stops, visuals blink for a
few seconds, the UI comes back with the session intact.* That guarantee holds
regardless of which bug fires, including future unknown ones, and it remains valuable
after the WebCodecs migration removes the two known mechanisms.

Non-goals: preventing mechanism A/B (that's `webcodecs-video-path.md`); surviving a
crash of the **Rust** process (out of scope — GStreamer/Tauri Rust side has never been
the thing that dies).

## Why this works: process anatomy

The Rust process (Tauri UI process, GTK main loop, `AudioManager`, all GStreamer audio
pipelines, MIDI via `midir`) is a **separate OS process** from `WebKitWebProcess`
(where all JS/DOM/WebGL runs — one per webview window). Every observed freeze lives in
a WebKitWebProcess; audio kept playing every single time. So the Rust side is the
natural watchdog *and* the natural place for the session-of-record.

Recovery primitive: `WebviewWindow::reload()` (Tauri 2.10 — verified present) is a
**native UI-process call** (dispatches through tauri-runtime-wry to
`webkit_web_view_reload`), not JS injection — it does not depend on the frozen web
process cooperating, and after the web process is killed, WebKitGTK spawns a fresh one
for the load. `navigate()` and `eval()` also exist as verified fallbacks/first-tries.

## Components

### 1. Heartbeat (frontend → Rust)

- New Tauri command `watchdog_heartbeat(window: String, stats: Value)`.
- Sent from a **`setInterval(1000)`** in each window's entry script (`App.svelte`
  onMount for `main`, `output.html`'s script for `output`) — *not* from the rAF loop:
  WebKitGTK throttles rAF for occluded/hidden windows, which would false-alarm.
  DOM-timer throttling for hidden pages exists too but is far milder; the 6 s
  threshold below absorbs it. If observation (Phase 1) shows hidden-window timer
  throttling exceeding the threshold, gate the watchdog on window visibility via
  Tauri window events rather than tightening the frontend.
- `stats` payload (small, diagnostics only): `{ lastRafMs, decks: [{id, vct, ready}] }`
  — the last rAF tick age lets Rust distinguish "rAF dead but timers alive"
  (mechanism-B-adjacent / JS exception killed the loop) from "whole main thread dead"
  (mechanism A — heartbeat itself stops). Log it on every state transition.

### 2. Rust watchdog (`src-tauri/src/watchdog.rs`)

- Managed state: `HashMap<String /*window label*/, Instant /*last beat*/>`, plus a
  recovery-attempt log. A dedicated thread (same pattern as the pipeline bus threads)
  wakes every second.
- **Trigger**: a window that has beaten at least once goes silent for **6 s** (6
  missed beats). Do not gate on audio playing — a frozen UI while idle also deserves
  recovery; the threshold is generous enough for Vite HMR reloads (~1–2 s) in dev.
- **Before recovering, capture diagnostics** (this is the "capture state for
  troubleshooting" half of the feature — cheap and permanent):
  `log::error!` the trigger, the last received `stats`, and for each descendant
  process named `WebKitWebProcess`: pid, `stat` state, `etimes`, utime/stime deltas
  (read `/proc/<pid>/stat`; enumerate descendants by walking `/proc/*/stat` ppids
  from our own pid — the sandbox may interpose a `bwrap` layer, so walk the tree, not
  just direct children). A near-0% CPU, all-threads-parked signature = the known
  deadlock class; log it as such. This gives every future incident a first-class
  post-mortem record even when the user just sees a blink.
- **Tiered recovery** (verify tier behavior empirically during implementation using
  the simulators below; the tiers exist because each is cheaper but less certain):
  1. `window.eval("location.reload()")` — succeeds only if the JS main thread is
     actually alive (covers "rAF loop died" without nuking the process). Wait 3 s for
     a fresh heartbeat.
  2. `window.reload()` (native). Wait 5 s.
  3. `SIGKILL` the window's WebKitWebProcess, then `window.reload()`. (WebKitGTK
     replaces the dead process on the next load. If per-window process attribution is
     ambiguous, killing all WebKitWebProcess descendants and reloading both windows
     is acceptable — the output window rehydrates trivially.)
- **Backoff**: at most one recovery sequence per 15 s per window; after 3 consecutive
  failed sequences, stop escalating, keep logging, leave audio alone. Never touch
  `AudioManager` from the watchdog.

### 3. Session-of-record in Rust (`src-tauri/src/session_store.rs`)

The webview must be disposable, so authoritative session state can't live only in a
Svelte store.

- `session_sync(snapshot: serde_json::Value)` — frontend pushes its full `Session`
  snapshot, **opaque JSON** (no Rust-side mirror of the TS types — avoids type-drift;
  Rust only stores/returns it). Push points: debounced 1 s after any store change —
  hook the existing `queueDeckPatch` rAF flush plus direct `updateDeck` paths; do
  NOT push at MIDI event rates (`audioSync.ts` discipline applies — continuous
  controls only reach the store at ≤60 fps already, and the 1 s debounce sits after
  that).
- Store in managed state + write-through to `app_data_dir()/session-recovery.json`
  (atomic: write temp file, rename) so a full app restart can also offer recovery.
  Include a `savedAt` timestamp and app instance id.
- `session_restore()` returns `{ snapshot, audio: [{deckId, uri, positionSecs,
  playing, rate}] }` — the `audio` part queried **live** from `AudioManager` (new
  `audio_status()` internals): the pipelines are the ground truth that survived the
  freeze; the JSON snapshot may be up to a second stale. Where they disagree
  (position, playing), audio wins.
- **Frontend rehydration** (in `App.svelte` onMount, before normal init): call
  `session_restore()`. If a snapshot exists and any pipeline reports a loaded uri →
  this is a recovery boot: rebuild the session store from the snapshot, then for each
  deck **adopt** the live pipeline — *do not call `audioLoad`* (the pipeline is
  already playing; reloading it is the one way this feature could interrupt audio).
  Create the `<video>` element, set `v.currentTime` to the live audio position,
  `play()` it if the pipeline is playing. Re-fetch waveforms via `audio_analyze_file`
  (see cache note below). Grids re-fetch through the existing `gridSource.ts` path —
  call `clearSavedGrid` for all decks first (the trust map died with the old page;
  the stale-trust bug class from `060de16` must not be reintroduced here).
- **Waveform re-analysis cache**: add an in-memory `HashMap<PathBuf, AnalysisResult>`
  (last ~8 entries) in the Rust analysis layer so recovery's re-fetch returns
  instantly instead of re-decoding for seconds per deck. Straightforward win; also
  speeds ordinary repeat loads.
- MIDI needs nothing: `midir` lives in Rust and never died; the reloaded frontend
  re-registers its Tauri event listener exactly as on a cold boot.
- Output window needs nothing beyond reload: it re-joins the `BroadcastChannel` and
  frames resume.

### 4. Mechanism-B self-heal (frontend, interim until WebCodecs path lands)

Mechanism B starves the `<video>` element while the JS main thread stays healthy —
the watchdog never fires. Self-heal in the deck loop inside `frame()` (per-frame
decision in the rAF loop, per the Eleventh-mechanism lessons — not a store `$effect`):

- Condition, all of: deck `playing`; `!v.paused && !v.ended`; audio clock advancing
  (Rust position delta > 0 over the window); `v.currentTime` (native read) unchanged
  for > 2 s; `v.readyState < 3`. The `paused`/`ended`/`readyState` guards are the
  documented defense against misreading a clean end-of-track as a stall.
- Recovery: log via `debugLog`; save target = current audio content position;
  `v.load()` (full element reset — discards WebKit's wedged internal pipeline); on
  `canplay`, set `currentTime` to target, re-apply the rate-tolerance-guarded
  `playbackRate`, `play()`. Rate-then-seek ordering does not apply here (`load()`
  built a fresh pipeline; there is no in-flight rebuild), but keep one 200 ms settle
  delay anyway — it's cheap insurance.
- Bound it: at most one attempt per deck per 10 s. If it recurs, it recurs — each
  recurrence costs ~1–2 s of frozen video, strictly better than frozen-until-track-
  change. This whole component is deleted for codec-path decks later.

## Debug/simulation hooks (also the future troubleshooting toolkit)

Gated behind `VITE_ENABLE_DEBUG_HOOK=1` like the rest of `__cuemarkDebug`:

- `__cuemarkDebug.freezeMainThread(ms)` — synchronous busy-loop; `ms = 0` means
  forever. Simulates mechanism A's observable effect (heartbeat + rAF + eval all
  dead) without needing the real deadlock. Note: tier-1 eval will *queue* behind a
  finite busy-loop and run when it ends — only the forever variant truly exercises
  tiers 2–3.
- `__cuemarkDebug.killRafLoop()` — throw from inside `frame()` scheduling so the rAF
  loop dies but timers live (tests tier 1 + the lastRafMs diagnostics).
- External (document in `verify-ui` skill): `kill -STOP <WebKitWebProcess pid>` =
  process-level freeze (closest cheap analog of mechanism A; `-CONT` to release);
  `kill -KILL` = crash. Find pids via `pgrep -f WebKitWebProcess` filtered to
  cuemark's descendants.

## Test plan

New `scripts/watchdog-test.sh` (verify-ui harness pattern):
1. Launch headless, load a track via debug hook, play, confirm heartbeat log lines.
2. `kill -STOP` the WebKitWebProcess. Assert: `audio_get_position` (direct Tauri
   invoke — note the webview is frozen, so poll via the log or a helper that talks to
   the Rust log) keeps advancing; within ~15 s the log shows watchdog trigger →
   diagnostics → recovery; a fresh heartbeat appears.
3. Assert post-recovery state: deck source path matches, `getAudioTime` within 1 s of
   pre-freeze trajectory, deck still `playing`, waveform canvas non-black again.
4. Repeat with `freezeMainThread(0)` (tier coverage) and `kill -KILL` (crash path).
5. Negative test: 10 min of ordinary playback + MIDI burst (`latency-test.sh` load
   profile) with recovery armed — assert **zero** watchdog triggers (false-positive
   gate).

Gates: `perf-idle-test.sh` and `latency-test.sh` unchanged-or-better (heartbeat and
1 s debounced `session_sync` are negligible next to existing per-frame IPC).
Live-desktop pass per `feedback_audio_midi_live_testing`: user triggers
`freezeMainThread(0)` mid-playback on the real desktop and confirms by ear that audio
never hiccups and by eye that the UI returns with decks intact.

## Phases

1. **Observe only** (implemented 2026-07-25): heartbeat + watchdog + diagnostics
   logging, recovery disabled. Run normal sessions (incl. heavy load) to measure the
   false-positive rate. Gate: zero false triggers across a week of normal use — not
   yet run; only spot-verified so far (see Status above).
2. **Session-of-record**: `session_sync`/`session_restore` + rehydration, exercised
   via a debug-hook forced reload (recovery still not automatic). Gate:
   forced-reload rehydration is seamless (audio uninterrupted, decks/positions/grids
   correct) 5/5 runs, headless + real desktop.
3. **Arm recovery tiers** + `watchdog-test.sh` green.
4. **Mechanism-B self-heal** (smallest piece, riskiest history — the Eleventh
   mechanism was four failed iterations of a *cousin* of this; the difference here is
   it acts only on an already-stalled element, never on healthy playback. Live-test
   accordingly, and be willing to drop this phase if it misbehaves — phases 1–3 stand
   alone).

## Risks

- **False-positive recovery is the main hazard** (reloading a healthy UI mid-set).
  Hence: observe-first phase, 6 s threshold, eval-first tiering, 15 s backoff.
- **Adoption bugs**: rehydration accidentally calling `audioLoad`/`audioSeek` on a
  playing pipeline would audibly glitch — the exact thing this feature must never do.
  Add a temporary assertion log in `pipeline.ts` (`audioLoad` called for a deck whose
  pipeline reports loaded+playing → `debugLog` error) during phases 2–3.
- **Two windows, one session**: only `main` owns session state; the watchdog must
  reload `output` without touching session flow. Keep per-window logic keyed by label.
- **`session-recovery.json` staleness**: a snapshot from a previous app run must not
  ghost-restore decks on a clean boot. Cold boot (no live pipelines) → offer nothing,
  just start fresh; the file is only consulted when `audio_status()` shows live state,
  except for an explicit future "restore last session" feature (not in scope).
