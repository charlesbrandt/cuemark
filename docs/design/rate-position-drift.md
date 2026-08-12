# Non-1.0-rate position drift (open investigation)

Status: **two distinct bugs found and fixed (seek-domain scaling, 2026-07-27; false-seek
misdetection, 2026-07-26), one confirmed-still-open mechanism (slow steady-state drift),
root cause of that third one not yet pinned down.** This doc exists so the investigation
doesn't have to be re-derived from scratch in a future session.

## Bug #0 (found and fixed 2026-07-27): seek-domain scaling — `pitch` scales every seek by `tempo`

**This is almost certainly what the user actually meant to report** on 2026-07-27: not a
slow drift, but a large, immediate, per-seek offset. Direct quote: clicking the waveform
where the audio audibly gets quiet and builds slowly, the display jumps to a position
well past that point — "It's like the song jumps to 2:09 into the song as though the
rate was 1.0x, but when it is playing at .852, the jump needs to happen further (due to
the longer total playback)." That description is exactly this bug, not the slow-drift
mechanism described in Bug #2 below (which the user had *also* separately reported, on
2026-07-26 — see that section for its own, much smaller, still-open effect).

**Root cause**: the GStreamer `pitch` (soundtouch) element operates in **output/wall-clock
time**, and scales every seek position it forwards upstream to the decoder by the
`tempo` ratio. Cuemark issues all seeks in **content time** (the file's own timeline —
what the waveform maps, and what `cuePoint`/`hotCues`/`loopIn`/`loopOut` all store). At
any `tempo != 1.0` those two domains diverge: `seek_simple(V)` lands the actually-decoded
content at `V * tempo`, not at `V`.

**Confirmed empirically** with a standalone probe reproducing cuemark's exact audio
topology (`uridecodebin → … → capsfilter(48k) → pitch(tempo) → sink`), with a GStreamer
`identity` element inserted **upstream of `pitch`** so its buffer PTS is true source/content
time:
```
tempo=0.852, seeking pipeline to 129.0s (the waveform's click target, content-domain)
[SOURCE-DOMAIN] first buffer into pitch after seek: PTS = 109.440s   ← where audio actually resumes
query_position right after seek (output domain)      = 128.451s     ← what the display showed
```
Click 2:09 (129s) → the waveform/timestamp show 129s, but the audio actually restarts at
~1:49 (109s ≈ 129 × 0.852) — audio runs *behind* the display by `contentTime × (1 − tempo)`
(~19s at 0.852, ~13s at 0.9). This is a fixed step at the moment of every seek, not an
accumulating drift, which is why the user correctly distinguished it from a "drift issue."

**Why it was missed**: at `tempo = 1.0` the two domains coincide (`V/1.0 = V`), so it's
invisible — and essentially all the AV-sync test scripts (`latency-test.sh`, etc.) run at
1.0 or don't specifically re-check position accuracy immediately after a seek at a held
non-1.0 rate. It affects **every** seek: waveform clicks, hot cues, the cue point, loop
in/out wrap-around, MIDI-driven seeks, and phase-nudge — all of them pass content-time
straight into `DeckAudioPipeline::seek()`.

**The display was also self-consistently wrong in the same way**, which is what made this
easy to miss from the frontend side too: `App.svelte`'s RAF position-poll seek-detection
branch had a comment claiming `audioPos IS the correct content pos post-seek` — true only
at rate 1.0. Since `audioPos` (`query_position`) lives in the same tempo-scaled domain as
the (buggy) seek value, the two were self-consistent with each other and both wrong
relative to the actual audio.

**Fix** (three call sites, all in `src-tauri/src/audio/pipeline.rs`, sharing the same root
cause):
1. `DeckAudioPipeline::seek()` now divides the caller's content-time value by `self.rate`
   before issuing the GStreamer seek. The previous body (a raw `seek_simple`) is kept as a
   private `seek_output_domain()` for two internal callers (`set_devices`/`set_cue_device`)
   that already have a value in the *output* domain (from `position()`, used to restore
   playback position across the pipeline rebuild a device switch requires) — calling the
   new content-time `seek()` there would double-convert.
2. `App.svelte`'s RAF seek-detection branch: `contentPos = audioPos` → `contentPos =
   audioPos * currentRate` (a snapshot of `deck.playbackRate`, not
   `averageRateOverWindow` — a seek is a discontinuity, there's no meaningful "previous
   content position" to integrate a rate change across).
3. Two **related** instances of the identical domain confusion found while auditing the
   rest of the scratch code path, both in `pipeline.rs`:
   - `scratch()`'s `start_secs` was read directly from `query_position()` (output domain)
     and used to index the PCM buffer (content domain) — starting a scratch gesture after
     playing at a non-1.0 rate began the feeder from the wrong point in the file. Fixed by
     multiplying by `self.rate` before the PCM-frame conversion.
   - `stop_scratch_feeder()`'s second ("real resync") seek passes through `pitch` (it
     happens after `input_selector` has already switched back to the normal branch), so its
     `target` (real content time, from the PCM cursor) needed the same `/ self.rate`
     conversion before being handed to `seek_simple`. The first ("flush-only") seek in the
     same function does *not* need it — it fires while still on the scratch pad, before the
     branch switch, so it never reaches `pitch`.

**Live-tested** (2026-07-27) via the isolated `tauri-driver` + `Xvfb` harness (see
"Reproduction / continuation setup" below), driving the actual rebuilt debug binary, not
just the standalone probe:
- Seek to content 200s at `rate=0.852`: raw `query_position` read back `234.59` (≈
  `200/0.852 = 234.74`, off by ~0.15s — GStreamer buffer-resolution noise, not the bug),
  and the frontend's recovered content position (`raw * rate`) and `getAudioTime()` both
  read `≈199.87` — matching the seek target, not the old wrong value.
- Scratch start: played at `rate=0.852` for 2s then paused (`rawOutputDomainAtPause =
  2.018`, `contentPosAtPause = 1.7195`); started a frozen (`rate=0.0`) scratch gesture;
  `position()` during scratch reported `1.7202` — matching the true paused content
  position, not the `2.018` raw value the pre-fix code would have used.
- Scratch stop: after `audio_stop_scratch`, raw `query_position` read `2.019` (≈
  `1.72/0.852`), and the recovered content position (`raw * rate`) read `1.7202` — the
  normal branch resumed exactly where the scratch gesture left off.

**Not yet re-verified**: whether Bug #2 (the slow steady-state drift, below) is smaller,
unchanged, or was ever partially conflated with this bug's per-seek offset in past live
sessions. Worth a fresh live A/B session now that this larger, seek-triggered effect is
gone — it may make the residual drift easier to characterize (or it may turn out the
residual drift's ~90s-periodic anomalies were always a separate, real, smaller effect,
as the isolated single-deck Test 1 already suggested).

## Bug #2 (2026-07-26 report, still open): slow, ~90s-periodic steady-state drift

### Symptom (as originally reported, 2026-07-26)

At `deck.playbackRate = 0.9` (slowed down), with the rate held steady (not being
actively adjusted), the waveform playhead and the video frame shown both progressively
run ahead of where the audio actually is — e.g. audio is still audibly in a track's
build-up section while the waveform/video show a position well past it. See the
original screenshot context: DECK-0 rate slider at `0.900×`, `Rate 0.900x` label,
codec-path deck (`DECK-0 [CODEC]` badge).

### Background: how content position is computed

See `CLAUDE.md` / `docs/design/av-sync-architecture.md` "Audio pipeline" section for
the full topology. Summary relevant to this bug:

- **Audio is the master clock.** GStreamer's `query_position` (`pipeline.rs`
  `DeckAudioPipeline::position()`) always returns **wall-clock stream time** — the
  `pitch` (soundtouch) element changes tempo via WSOLA resampling but never issues a
  segment-rate seek, so `query_position` advances 1:1 with real elapsed time
  regardless of `deck.playbackRate`.
- `App.svelte`'s RAF loop polls `audio_get_position` per deck (one in-flight IPC at a
  time, `pendingPos` map) and integrates deltas at the deck's rate to recover true
  content position: `contentPos = prev.contentPos + (audioPos - prev.audioPos) * rate`,
  where `rate` is `averageRateOverWindow()` (`src/lib/audio/audioSync.ts`) — a
  time-weighted average of whatever rates were actually in effect across
  `[prev.tsMs, nowMs]`, not just a single snapshot (this part was already fixed once
  before, for the case of *actively changing* rate — see `audioSync.test.ts`).
- The computed `contentPos` feeds `setDeckAudioTime()` (`seekBus.ts`), which both the
  waveform (`WaveformCanvas.svelte`) and the codec-path frame picker
  (`codecPlayer.ts` `getFrameForTime()`) read from. This is backend-agnostic — legacy
  `<video>` decks additionally snap `v.currentTime` to `contentPos` if they drift
  apart by more than 250ms, but the underlying `contentPos` number is the same for
  both backends.

### Bug #1 (found and fixed 2026-07-26): false "seek" misdetection on a slow IPC round-trip

**Location**: `src/App.svelte`, the `audioGetPosition(deck.id).then(...)` callback
inside `frame()`.

**Before**:
```js
const prev = contentPosTracker.get(capturedDeckId);
if (prev && Math.abs(audioPos - prev.audioPos) < 0.5) {
  // rate-scaled integration
} else {
  contentPos = audioPos; // large jump = seek; audioPos IS correct content pos post-seek
}
```

The seek-vs-normal-poll heuristic compared the raw magnitude of the `audioPos` delta
against a fixed 500ms constant, on the assumption that a real gap that large is
"impossible at any real playback rate" (this exact phrase was in the old code
comment). That assumption is wrong: `audioPos` is wall-clock, so its delta between two
poll *resolutions* naturally equals however much real time elapsed between them —
and the poll interval isn't fixed at ~150-190ms, it's however long the IPC round-trip
actually took (already known to occasionally exceed 300ms under `Mutex<AudioManager>`
contention — see the existing `if (pollMs > 300) debugLog(...)` instrumentation a few
lines above this code). A round-trip slow enough to push the *cumulative* gap past
500ms real time — plausible under contention from multiple decks' concurrent polls,
MIDI IPC, `audio_analyze_file`, etc. — got misclassified as a seek. That branch
snaps `contentPos = audioPos` (the **raw, un-rate-scaled** wall-clock value), which at
any rate `!= 1.0` is a real, permanent forward jump relative to the true content
position. Nothing ever corrects it afterward except an actual seek, so it stays as a
fixed offset for the rest of playback — and if it happens more than once in a session,
each occurrence adds another offset, which reads exactly like a "drift."

**Fix**: compare the audio delta against how much wall-clock time *actually elapsed*
since the last poll (`nowMs - prev.tsMs`), not a fixed constant — a real seek makes
those two diverge by a lot; a merely-slow poll doesn't, however long it took.
```js
const prev = contentPosTracker.get(capturedDeckId);
const wallElapsedSec = prev ? (nowMs - prev.tsMs) / 1000 : 0;
if (prev && Math.abs((audioPos - prev.audioPos) - wallElapsedSec) < 0.5) {
  // rate-scaled integration
} else {
  contentPos = audioPos; // large jump = seek
}
```
Also updated the doc comments in `av-sync-architecture.md` and `App.svelte` to stop
asserting the false "impossible at any real rate" claim.

**Verification of this specific fix**: `npm run check` (0 errors). Rebuilt the
release launcher binary (`npm run tauri build -- --no-bundle`), stopped the running
instance, relaunched — confirmed via log (MIDI reconnect + rAF heartbeat) that the new
binary was live.

**This fix is real and necessary, but evidently not sufficient** — see below.

### User confirmation (2026-07-27): still a slow, ever-growing lead

Asked the user directly whether the remaining drift was (a) a slow ever-growing lead
(same character as the original report, just perhaps slower), (b) occasional small
jumps that then settle, or (c) only around a seek/loop/pause. Answer: **(a), slow,
ever-growing lead.** This ruled out the per-rate-change IPC-latency hypothesis below
(no rate changes were happening) and motivated Test 2 (multi-deck contention) over
just re-running Test 1's single-deck scenario for longer.

### Ruled out: per-rate-change IPC-latency bias

Before getting the user's clarifying answer, the leading hypothesis was that
`rateHistory` (`audioSync.ts`) timestamps a rate change at the moment `syncRate()` is
*called* in JS, not when the Rust side's `pitch.set_property("tempo", ...)` actually
takes audible effect (IPC round-trip + up to the 100ms `output_queue` drain of
old-rate audio already buffered downstream of `pitch`). That would bias every
individual rate change by a small fixed amount, compounding across many changes over
a session (e.g. continuous jog-wheel/tempo-fader riding).

**Ruled out**: user confirmed the rate was held steady (not being adjusted) while the
still-remaining drift was observed. This mechanism requires repeated rate changes, so
it cannot be the (sole) explanation here. Kept as a candidate worth revisiting if a
future repro *does* involve continuous rate riding rather than a static rate.

### Verification methodology: isolated diagnostic instance

To avoid touching the user's live running app (a VJ tool — assume any running
instance may be an active session), all measurement was done via a **separate**
`cargo tauri build --debug --no-bundle` binary (with `VITE_ENABLE_DEBUG_HOOK=1` so
`window.__cuemarkDebug` is present), driven headlessly via `tauri-driver` + `Xvfb`
on display `:99` (see `skills/verify-ui/SKILL.md`), talking to the WebDriver session
over `curl`/`jq`. This never touches the user's `:0`/real desktop session or its
running `cuemark` process. Locally-cached tracks under
`~/.local/share/com.cuemark.app/media_cache/` were used as test content (no SMB/Digger
dependency).

Direct measurement technique: `window.__cuemarkDebug.getAudioTime(deckId)` (the
frontend's cached `contentPos`, i.e. exactly what the waveform/codec-frame-picker
consume) sampled once per second over a multi-minute window via one `/execute/async`
WebDriver call (avoids per-sample HTTP round-trip jitter contaminating the timing —
the wait between samples is a plain in-page `setTimeout`, timed with
`performance.now()`). A least-squares fit of `contentPos` vs. elapsed wall time gives
the *actual* steady-state rate the display is advancing at, directly comparable to
the requested `deck.playbackRate`.

### Test 1: single deck, static 0.9x rate, 3 minutes, idle otherwise

- 180 samples, 1/sec.
- Least-squares slope: **0.900046** (requested: 0.9) — no systematic bias.
- Residual (`(c - c0) - 0.9*(t - t0)`) oscillated within **±0.2s** across the whole
  window — bounded, not growing.
- Two isolated blip-and-recover events (~90s apart), each a single 1-second sample
  interval showing a 0.17-0.45s deviation from the expected per-second delta, self-
  correcting within a second or two afterward. No `xrun`/bus-error log lines
  correlated with either blip in `~/.local/share/com.cuemark.app/logs/cuemark.log`
  (inconclusive on root cause — possibly a PipeWire quantum hiccup, possibly JS-timer
  jitter in the *test harness's* own `setTimeout(1000)` loop rather than the app).

**Conclusion**: a held-steady rate, single deck, no interaction, does not reproduce a
growing drift in this test. Bug #1's fix holds up under this specific scenario.

### Test 2: two decks playing concurrently — confirms a real, directionally-biased drift

Rationale: the user's real session (per the original screenshot: Digger queue,
MIDI controller connected, presumably more than one deck in play) has meaningfully
more `Mutex<AudioManager>` contention than Test 1 — two decks' independent RAF
position-polls, MIDI IPC, waveform analysis, etc. all competing for the same lock.
If Bug #1's fix only *reduces the frequency* of false-seek misfires rather than
eliminating the underlying contention, a busier real session could still rack up
occasional misfires (or some other contention-dependent bias) often enough, and
consistently enough in one direction, to look like a genuinely growing drift over a
longer real session even though a clean 3-minute single-deck test doesn't show it.

Setup: deck-0 (the deck being measured) at `playbackRate: 0.9`, deck-1 at
`playbackRate: 1.3` playing a large (~1.5GB, heavier decode load) clip concurrently
for contention — both `playing: true` simultaneously.

**First attempt failed instructively**: a single long (300-sample, 1/sec) in-page
`setTimeout` sampling loop, wrapped in one `/execute/async` WebDriver call, hit
WebDriver's own script timeout (330s) under the two-deck CPU load — the loop's own
`setTimeout(1000)` waits were themselves being throttled/delayed by the heavier
workload (matches the exact `verify-ui` SKILL.md gotcha about `setInterval` throttling
under CPU load, apparently also affecting `setTimeout`), pushing total wall time past
the timeout with zero data returned. **Switched to a more robust method**: separate,
short `execute/sync` round-trips from the *bash* side, spaced by a real `sleep 5`
between each — bash's sleep isn't subject to in-page JS timer throttling, so this
survives arbitrary in-page slowdowns. This also meant the earlier failed attempt had
been silently playing deck-0 in the background for its own ~330s before timing out;
the first re-run of the bash-side method loaded a 343s-duration track for deck-0 and
found it had *already reached end-of-stream* (flatlined at exactly the track's
duration for the entire sample run) — not a bug, just leftover playback from the
failed attempt exhausting a track that wasn't long enough. Re-loaded deck-0 with a
516s-duration track and restarted cleanly from position 0 to fix this.

**Clean run**: 72 samples, 5s apart (~357s / ~6 minutes), bash-side timing.

```
least-squares slope: 0.899934  (requested: 0.9 — still no systematic multiplicative bias)

Anomalous steps (single 5s sample interval, actual delta vs 0.9×expected):
  t= 65.5s   +0.275s
  t=156.0s   +0.282s
  t=231.6s   +0.265s
  t=322.1s   +0.428s
```

Four occurrences over 357s, spaced roughly 90s apart (75.6–90.5s between consecutive
ones) — and unlike Test 1's two blips (which were of opposite sign and largely
canceled out), **all four here push in the same direction** (position running ahead
of the true rate-scaled value). This is the mechanism that reads as "slow, ever-growing
lead" over a real session: ~0.3s every ~90s is small per-occurrence, but compounds
over a full set (~40 occurrences/hour × ~0.3s ≈ 12s/hour, and climbing) — a difference
in *degree*, not in *character*, from what was originally reported.

Suspicious detail: **the ~90s spacing shows up in both Test 1 (single deck, in-page
JS timer, 1/sec) and Test 2 (two decks, bash-side curl, 1/5sec)** — two completely
different sampling mechanisms landing on roughly the same period is good evidence this
is a real property of the app/system, not an artifact of either test harness.

**Root cause of the ~90s periodicity: not yet found.** Checked and ruled out as the
literal source (no ~90s constant matches):
- `App.svelte`'s freeze-watchdog heartbeat `setInterval` — 1000ms, not 90s
  (`App.svelte:613`, mirrored in `output.ts`).
- `sessionRecovery.ts`'s `startSessionSync` debounce — 1000ms, and only fires on an
  actual session-store mutation (none were happening during these tests).
- `midi.rs`'s keep-alive loop — `Duration::from_secs(60)`, a plain "hold the
  connection open" sleep with no action performed on wake, not a rescan.
- `watchdog.rs`'s tiers — `SILENCE_THRESHOLD`/`POLL_INTERVAL`/`TIER1-3_WAIT` are all
  1-15s, none near 90s.
- No literal `90` (as milliseconds/seconds) constant anywhere in `src/` or
  `src-tauri/src/` outside of an unrelated MIDI status-byte check
  (`midi.rs:298`, `0x90 => "NoteOn"`).

Candidates not yet checked (would need lower-level tracing, not just grep): WebKit's
own JS engine GC cadence (major GC cycles are timer/heap-pressure driven, not
necessarily a literal source-visible constant), a PipeWire quantum/graph
renegotiation cycle, or something specific to the two test files' own GOP/keyframe
or internal buffering cadence (would want to re-run with different source files to
check if the period changes — if it's tied to a specific file's internal structure
rather than wall-clock time, that's diagnostic).

### Next step: instrument the actual misfire, don't keep guessing from outside

Test 2 confirms the mechanism is real and reproducible (4/4 occurrences same
direction, ~90s apart, two independent test harnesses agreeing on the period) but
external black-box measurement has reached its useful limit — further narrowing needs
instrumentation *inside* the moment it happens, not more slope-fitting from outside.
Concretely: temporarily log, on every resolution of the `audioGetPosition(...).then()`
callback in `App.svelte`, the actual IPC round-trip time (`pollMs`, already computed
just above), the computed mismatch `(audioPos - prev.audioPos) - wallElapsedSec`, and
which branch was taken — then re-run Test 2 and grep the log for entries around each
~90s-spaced anomaly to see whether the branch taken was actually the `else` (seek
misdetected) or the normal integration path landed on an already-off `audioPos`. That
distinguishes "Bug #1's fix isn't as complete as it looked" from "a new, third
mechanism entirely." Also worth capturing `pidstat`/GC-trace data over the same
window to check for a correlated CPU/GC event at each ~90s mark.

### Other candidate mechanisms not yet tested

Ranked roughly by plausibility given "held steady" + "slow, ever-growing" + Test 2's
confirmed ~90s-periodic, directionally-biased pattern:

1. **`averageRateOverWindow`'s `rateHistory` retention under a long-idle deck**: the
   trim logic in `recordRateChange` (`audioSync.ts`) only runs when a *new* rate
   change is recorded — a deck that's had its rate set once and never touched again
   keeps exactly one (arbitrarily old) history entry forever. Functionally this
   should still resolve to the correct rate (see `averageRateOverWindow`'s "uses the
   rate in effect at window start" test case in `audioSync.test.ts`), but hasn't
   been explicitly stress-tested over a *very* long single-rate hold (tens of
   minutes) in case some edge case in the loop logic degrades over many accumulated
   (never-trimmed) calls to `averageRateOverWindow` itself (the function is `O(history
   length)` per call, but for a single-entry history this is negligible — flagged
   here mainly for completeness, not because there's concrete evidence of a problem).
2. **Real device/PipeWire audio clock skew vs. the JS/system monotonic clock**: if
   the actual audio hardware clock runs at a slightly different rate than
   `performance.now()`'s underlying clock (typically tens of PPM in the real world),
   `query_position`'s wall-clock assumption would itself be very slightly off from
   true wall-clock, and that error would compound linearly over a session regardless
   of `deck.playbackRate`. This is a generic clock-domain-crossing issue, not specific
   to non-1.0 rates — but at rate 1.0 it wouldn't visibly manifest (the displayed
   position would just directly mirror GStreamer's own clock, which is "correct" by
   definition for its own domain), whereas at any rate != 1.0 the JS-side rescaling
   makes this cross-clock error visible for the first time. Not yet tested; would
   require an independent, audio-hardware-level ground truth (e.g. a recorded click
   track at a known timestamp) to actually measure, which is a bigger undertaking
   than the tests done so far.
3. **`pitch` (soundtouch) element's actual output tempo ratio deviating slightly from
   the requested `tempo` property value** (block-based WSOLA processing, internal
   quantization) — if the *true* physical playback speed is e.g. 0.898x instead of
   the nominal 0.900x we use for the JS-side rescaling, the resulting error is
   linear in time and would look exactly like a growing drift, and — like #2 above —
   would be invisible at rate 1.0 (identity transform, no scaling to get wrong).
   Would need to be verified against soundtouch's own documented accuracy
   guarantees, or measured empirically (e.g. a track with an audible click every N
   seconds, played at 0.9x, checking whether clicks land where math predicts after
   several minutes).

## Reproduction / continuation setup

For anyone picking this up:

```bash
# Build a debug binary with the frontend debug hook compiled in
. "$HOME/.cargo/env"; export PATH="$HOME/.cargo/bin:$PATH"
VITE_ENABLE_DEBUG_HOOK=1 cargo tauri build --debug --no-bundle
# binary: src-tauri/target/debug/cuemark

# Isolated display + driver (does NOT touch the user's real :0/wayland-0 session)
Xvfb :99 -screen 0 1280x900x24 &
# WebKitWebDriver's providing package name is not stable across sessions/distro
# releases (seen as both webkit2gtk-driver and webkitgtk-webdriver on this same
# project at different times) — resolve the binary, don't hardcode one package name,
# see skills/verify-ui/SKILL.md "One-time setup" and the scripts/*-test.sh scripts.
WEBKIT_DRIVER="$(command -v WebKitWebDriver \
  || dpkg -L webkitgtk-webdriver 2>/dev/null | grep -E '/WebKitWebDriver$' \
  || dpkg -L webkit2gtk-driver 2>/dev/null | grep -E '/WebKitWebDriver$')"
DISPLAY=:99 tauri-driver --port 4444 --native-driver "$WEBKIT_DRIVER" &

# Create a session (launches the app)
BINARY=$(pwd)/src-tauri/target/debug/cuemark
SESSION=$(curl -s -X POST http://localhost:4444/session \
  -H "Content-Type: application/json" \
  -d "{\"capabilities\":{\"alwaysMatch\":{\"tauri:options\":{\"application\":\"$BINARY\"}}}}" \
  | jq -r '.value.sessionId')
```

Then use `window.__cuemarkDebug.updateDeck/seek/getAudioTime` via
`/session/$SESSION/execute/sync` (see `skills/verify-ui/SKILL.md` for the `js_sync`
helper and full gotcha list — in particular the `jq --arg` JSON-encoding requirement
and the 30s default WebDriver script timeout). The one-second-sample-and-fit-a-slope
technique above (rather than a single before/after snapshot compared to a fresh IPC
call) is deliberately chosen: a single snapshot comparison is contaminated by
`getAudioTime()`'s own cache staleness (up to one poll interval, ~150-190ms) at
whichever exact instant it's read, which is large enough to produce a misleading
one-off number — an early version of this investigation got a spurious-looking 0.36s
gap over 30s from exactly this artifact before switching to the slope-fit method.

Cached local test tracks (no SMB/Digger dependency, per `verify-ui`'s "reuse a
locally-cached copy" gotcha): anything under
`~/.local/share/com.cuemark.app/media_cache/`, `ffprobe -v error -show_entries
format=duration -of csv=p=0 <file>` to check duration before picking one (needs to be
long enough that `contentDuration >= testDurationSeconds * playbackRate` so the test
doesn't run off the end of the file and hit EOS/loop mid-measurement).

Always tear down cleanly even on failure — leftover `Xvfb`/`tauri-driver` processes
hold the display and port for the next attempt:
```bash
curl -s -X DELETE "http://localhost:4444/session/$SESSION"
pkill -f "tauri-driver --port 4444"; pkill -f "Xvfb :99"
```
