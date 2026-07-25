# Freeze watchdog and session recovery (design)

Status: **Phase 1 (observe-only) implemented and live-verified 2026-07-25. Phase 2
(session-of-record) implemented 2026-07-25; full gate PASSED 2026-07-25 — headless (5/5
runs, `scripts/rehydration-test.sh`, 14/14 checks each run — deck source/bpm/downbeat
intact, audio position continuous within ~0.1s of expected across the reload, `<video>`
adoption landed within 20-150ms of live audio position, no `audioLoad` call on the
surviving pipeline) and real-desktop (user confirmed by ear, after one fix — see below).
Phase 3 (armed recovery tiers) implemented 2026-07-25; headless gate PASSED — 3/3 clean
runs of `scripts/watchdog-test.sh` (23/23 checks each run) across `kill -STOP`,
`freezeMainThread(0)`, and `kill -KILL`, plus a short false-positive smoke check. The
full 10-minute false-positive soak (design doc's step-5 gate, distinct from the 15s
smoke check) also PASSED 2026-07-25 via new `scripts/watchdog-soak-test.sh` — 600s of
looped playback + a 200-event MIDI-rate burst every 60s (9 bursts total), zero
`[watchdog] TRIGGER` lines, deck still playing at the end. **Real-desktop pass also
PASSED 2026-07-25**: user ran `freezeMainThread(0)` mid-playback on a real track via
devtools console; confirmed by ear that audio never glitched and by eye that the deck
came back playing at the right spot. Rust log for that run: `TRIGGER` at 21:00:15 →
tier1 (eval, no-op — queued behind the infinite busy-loop) → tier2 (native reload,
no-op) → tier3 SIGKILL'd 4 WebKitWebProcess/WebKitNetworkProcess descendants, first
`reload_all_windows()` raced process teardown as documented above, the built-in retry
landed → frontend adopted deck-0 at 74.22s still `playing=true` → heartbeat resumed
after 21.2s silence → recovery sequence succeeded. **Phase 3 is fully closed** — both
headless and real-desktop gates green.

**Bug found and fixed during the real-desktop pass**: the first live attempt had an
audible stutter on reload ("went back just a subtle amount"). Root cause: `App.svelte`'s
`$effect`s syncing `mainOutputDeviceIds`/`cueOutputDeviceId` (persisted stores) to Rust
call `audio_set_main_devices`/`audio_set_cue_device` unconditionally on every mount —
and both Rust commands unconditionally call `DeckAudioPipeline::set_devices`/
`set_cue_device` on every live pipeline, which **always tears the GStreamer pipeline
down and rebuilds it** (PipeWire's `pipewiresink` can't retarget at runtime) even when
the device list is unchanged. Pre-existing bug, invisible before phase 2 because there
was never a scenario where a live, playing pipeline existed when a fresh webview mounted
and ran this effect. Fixed with a no-op guard in both Rust commands
(`src-tauri/src/audio/mod.rs`: skip the rebuild loop entirely when the new device
list/id matches the stored one) — confirmed via log inspection that a post-fix reload
shows `[recovery] adopted` with **no** `Null → Ready` pipeline-rebuild sequence, and
confirmed by ear on the real desktop. **The headless test suite does not catch this
class of bug** — it runs with a fresh WebKitGTK profile, so `mainOutputDeviceIds`
defaults to empty, which trivially equals the stored empty default even pre-fix. Only a
real desktop with a configured output device exposes it. Heartbeat
(`App.svelte`/`output.ts` → `watchdog_heartbeat`), the Rust watchdog thread
(`src-tauri/src/watchdog.rs`), and diagnostics logging are in; recovery is still
disabled. Verified live: `kill -STOP` on the real `WebKitWebProcess` produced a
trigger log (with the process's `T` state and zero utime/stime delta flagged as the
known deadlock signature) ~5.5s after the last heartbeat, and `kill -CONT` produced a
"heartbeat resumed after Ns silence" log — no false triggers across ~35s of otherwise
idle operation. Also added the `freezeMainThread`/`killRafLoop` debug hooks from the
"Debug/simulation hooks" section below.

Phase 2 adds: `src-tauri/src/session_store.rs` (`session_sync`/`session_restore`
commands, in-memory + atomic write-through to `session-recovery.json`); `DeckAudioStatus`
+ `AudioManager::audio_status()` in `audio/mod.rs` (live per-deck deck_id/file_path/
position/playing/rate, the ground truth for recovery); an 8-entry FIFO analysis cache
(`audio/analysis.rs`'s `AnalysisCache`) so a recovery boot's waveform re-fetch is instant
instead of re-decoding; `src/lib/state/sessionRecovery.ts` (1s-debounced push on every
Session store change, via a plain store subscription rather than hooking individual
mutation call sites); and `App.svelte` onMount rehydration — calls `session_restore()`
before other init, and on a recovery boot (snapshot present AND at least one live
pipeline reports a loaded file) rebuilds the store from the snapshot with `playing`
overridden from live audio status ("audio wins"), skips the MIDI-saved-state restore
pass (the snapshot already has more accurate fader positions), and routes adopted decks'
video-element creation around `audioLoad()` via a `pendingAdoption` map in
`syncVideoElements` (mirrors the temporary assertion log added in `audio_load` for the
same risk). Only exercised so far via `cargo check`/`npm run check`; the design doc's
own gate for this phase — forced-reload rehydration seamless 5/5 runs, headless + real
desktop — has not been run yet.

Phase 3 adds: the tiered recovery sequence in `src-tauri/src/watchdog.rs`
(`spawn_recovery_sequence`) — tier1 `window.eval("location.reload()")`, tier2 native
`window.reload()`, tier3 `kill -KILL` every `WebKitWebProcess`/`WebKitNetworkProcess`
descendant (shells out to `kill`, no libc/nix dependency) followed by reloading every
open window (attribution of the killed process to one specific window isn't reliable,
per the design doc's original risk note). Backoff (15s between sequences) and a
give-up threshold (3 consecutive full-sequence failures, reset on the next real
heartbeat) are tracked per window in the existing `WindowBeat` struct. `spawn_watchdog`
now takes an `AppHandle` (threaded through from `lib.rs` `setup()`) so the watchdog
thread can call `eval`/`reload` on the actual `WebviewWindow` and enumerate/reload
`app.webview_windows()`.

Two things changed from the design doc's original estimates, found empirically via
`scripts/watchdog-test.sh` (see that script's own comments for the full story):

- **`TIER3_WAIT` raised from the doc's estimated 5s to 15s.** Tiers 1-2 act on an
  existing process (fast if it's cooperative); tier 3 forks a brand-new
  `WebKitWebProcess` and waits for it to load the page, run `onMount`, and rehydrate the
  session — empirically ~11-20s in headless testing, not ~5s.
- **Tier 3 retries its `reload_all_windows()` call once, partway through its wait
  budget.** A `reload()` dispatched in the same instant as the `SIGKILL` was observed to
  sometimes get silently dropped — most likely a race with WebKitGTK's own
  SIGCHLD-driven bookkeeping for the just-killed process not having caught up yet on the
  GTK main loop. Without the retry, the first full sequence would reliably "fail" and a
  second sequence's tier 1/2 would end up doing the real work ~15-20s later — harmless
  (audio never touched) but slower and noisier in the log than necessary.

Also discovered: a real, externally-triggered navigation on a window under an active
tauri-driver/WebKitWebDriver session (eval/reload/SIGKILL+reload dispatched from Rust,
as opposed to a `location.reload()` called *from inside* a WebDriver `execute/async`
script, which is what `rehydration-test.sh` does) leaves that WebDriver session unable
to reliably answer further `execute/sync` calls, even though the page itself reloaded
and rehydrated correctly (confirmed via the Rust log). `watchdog-test.sh` works around
this by verifying recovery through the Rust log (`TRIGGER`, `recovery sequence ...
succeeded`, the frontend's `[recovery] adopted deck-0 at Xs playing=Y` line) instead of
polling the debug hook through the same session post-reload, and by giving each freeze
scenario its own fresh app launch + session rather than chaining three scenarios through
one session. Real-desktop verification (`kill -STOP`/`kill -CONT` plus
`freezeMainThread(0)` mid-playback, confirming by ear per
`feedback_audio_midi_live_testing`) has not been done yet for phase 3 — only phase 1's
observe-only behavior was live-verified on the real desktop so far.

Phase 4 (mechanism-B self-heal) implemented 2026-07-25 in `App.svelte`'s `frame()` loop
(per-frame detection, per the design below — not a store `$effect`, learned the hard way
from the reverted `nearTrackEnd`/`applyVideoRate` attempt, see
`project_webkit_freeze_mechanisms` memory). `npm run check` clean; `scripts/perf-idle-test.sh`
and `scripts/latency-test.sh` both re-run against a rebuilt binary and show no regression
(CPU deltas within normal run-to-run noise, all 10 latency-test checks pass) — confirms the
new per-frame Map bookkeeping is cheap and the normal load/play/rate-change path is
undisturbed. **A live-test attempt was made 2026-07-25 (same day) via `verify-ui`, using
the confirmed historical mechanism-B repro recipe (`pcm-buffer-playback.md`'s "Tenth
mechanism": load the same 288.485s track, set `playbackRate=0.87`, seek to ~90% through,
play to the real end) — it did NOT reproduce.** Two attempts, both completed cleanly to a
real EOS (Rust pipeline self-paused correctly, video reached `ended=true` at the true
duration). Mechanism-B is documented as intermittent (historically ~2/3 stall rate on a
small sample), so two clean runs don't rule it out, but the self-heal recovery path
specifically has still never been exercised against a genuine stall — **the phase 4 gate
remains open**; do not rely on it in a live show until it clears a real repro, per the
reverted-attempt history above. **A different, real bug surfaced as a byproduct of this
testing attempt** (not mechanism-B, not WebKitGTK's fault): a permanent waveform-position
freeze during seek-while-playing, independently corroborated by the user live on their own
desktop at the same time. Root-caused and fixed the same session — see
`project_seek_staleness_freeze_fix` memory and `audio-debugging` skill's `pendingSeekTarget`
section for the full writeup; unrelated to this design doc's own scope but worth knowing
about if a future mechanism-B repro attempt also produces a stuck-looking waveform, since
that symptom can now have two different causes. Ships before (and independently of)
`webcodecs-video-path.md`. Rationale discussion: 2026-07-25 session; background:
`pcm-buffer-playback.md` mechanisms Nine/Ten/Eleven and the `project_webkit_freeze_mechanisms`
memory.

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
   gate). `watchdog-test.sh` runs a ~15s smoke version of this (playback + one
   200-event MIDI burst) as a quick sanity check on every run; `scripts/watchdog-soak-test.sh`
   is the real 10-minute version (loops a track via `deck.loop`, fires a 200-event
   burst every 60s) — run that separately before relying on recovery in prod. **PASSED
   2026-07-25** — see Status above.

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
   correct) 5/5 runs, headless + real desktop. **PASSED 2026-07-25** — headless
   (`scripts/rehydration-test.sh`, 5/5 runs, 14/14 checks each) and real desktop
   (user-confirmed by ear, after fixing the `set_devices`/`set_cue_device` rebuild bug
   — see Status above). Phase 2 is done.
3. **Arm recovery tiers** + `watchdog-test.sh` green. **PASSED 2026-07-25 — phase fully
   closed.** Headless (`scripts/watchdog-test.sh`, 3/3 clean runs, 23/23 checks each,
   covering `kill -STOP`/`freezeMainThread(0)`/`kill -KILL` plus a false-positive smoke
   check). `TIER3_WAIT` and a tier-3 retry were tuned based on what this testing found
   — see Status above. The full 10-minute false-positive soak
   (`scripts/watchdog-soak-test.sh`) also PASSED — zero triggers across 600s of
   playback + 9 MIDI-rate bursts. Real-desktop pass (per
   `feedback_audio_midi_live_testing`) also PASSED — user-confirmed by ear/eye with
   `freezeMainThread(0)` mid-playback, full tier1→tier2→tier3 escalation, deck adopted
   back at the correct live position. See Status above for the log detail.
4. **Mechanism-B self-heal** (smallest piece, riskiest history — the Eleventh
   mechanism was four failed iterations of a *cousin* of this; the difference here is
   it acts only on an already-stalled element, never on healthy playback. Live-test
   accordingly, and be willing to drop this phase if it misbehaves — phases 1–3 stand
   alone). **Implemented 2026-07-25** (`frame()` in `App.svelte`): per-frame stall
   detection (`deck.playing && !v.paused && !v.ended && v.readyState < 3`, native
   `v.currentTime` unchanged > 2s, audio content position — via `getDeckTime()` —
   advanced > 0.05s over that same span); recovery is `v.load()`, then on `canplay`
   restore `currentTime`/`volume`/`muted`/`playbackRate`, wait 200ms, `play()`; bounded
   to one attempt per deck per 10s; guarded through the existing `playPromises` map
   (with a 5s safety-valve release) so `syncVideoElements`'s own play/pause branch can't
   race the recovery sequence. `npm run check` clean; `perf-idle-test.sh`/`latency-test.sh`
   re-run with no regression. **Live-test attempt made 2026-07-25 — did not reproduce.** Two
   headless `verify-ui` attempts at the historical repro recipe (0.87× rate, seek to ~90%
   through the confirmed 288.485s repro track, play to real end) both completed cleanly with
   no stall. **Gate remains open**: mechanism-B is documented as intermittent (~2/3 stall
   rate historically on a small sample), so this doesn't clear it — needs more attempts,
   ideally also on the real desktop, before the recovery logic can be trusted live. See
   Status above for what this attempt *did* find (an unrelated waveform-position-freeze bug,
   fixed the same session).

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
