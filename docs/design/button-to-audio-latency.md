# Button-to-audio latency: an exploration

**Status:** exploration only, nothing built. This doc proposes instrumentation to find out
where the time actually goes — it is not a fix, and per this codebase's own rule (`CLAUDE.md`,
the `audio-debugging` skill), nothing here should be tuned until the instrumentation exists and
has been read from a real set.

**Date:** 2026-08-30

**Origin:** `todo.md`, "Load-time / button-to-audio latency during live mixing" —
the *second* of that entry's two complaints, and the one still unmeasured. The first complaint
(track load feels slow) was split into `docs/design/queue-prefetch-cache.md`, measured
2026-08-30 (preroll dominates, not the network read — see that doc's Status block and
`docs/design/preroll-latency.md`, which continues it). This doc picks up the half that doc
explicitly declined to fold in: *"a perceptible gap between pressing a button and hearing the
effect, which made beat-matching hard to line up."* That phrasing — beatmatching, hitting
something *on the beat* — points at transport-class presses (PLAY, CUE, hot cues) specifically,
not continuous controls like a fader or EQ knob, which have no "press-to-onset" moment to feel
laggy in the same way.

**Read first:** `skills/perf-log-reading/SKILL.md` (what's already measured and why none of it
answers this question); `src/lib/audio/transport.ts` (`reconcileAudioTransport`, the
play/pause reconciliation chain); `src-tauri/src/audio/mod.rs`'s `audio_play`/`audio_pause`
commands; `src-tauri/src/audio/pipeline.rs`'s `play()` (~line 3448); `src-tauri/src/midi/mod.rs`
(the MIDI receive thread and its `midi-action` emit); `docs/design/shared-output-pipeline.md`
(the measured 171.3ms output-graph latency — a floor this exploration inherits, not one it
introduces).

---

## 1. Why this is unmeasured today

Every standing instrument in `perf-log-reading` measures something adjacent to this complaint,
not this complaint itself:

- `[deliver-tel]` (`pipeline.rs`'s `spawn_delivery_reporter()`) reports sink/handoff health
  **while a deck is already playing**, sampled every 1s and emitted every 5s. It has no concept
  of "time since the play button was pressed" — a deck that has been playing for an hour and one
  that started 50ms ago look identical to it.
- `[poll-stats]` times the position-poll IPC round trip during steady playback — a different
  question (is the UI's clock keeping up) from "how long until sound starts."
- `[ipc-ping]` is a no-op round-trip baseline, useful as a control arm, but says nothing about
  the *work* `audio_play` actually does (a real GStreamer `set_state()` call, not a no-op).
- The memoried IPC latency baseline (sequential-await p50 ~140–190ms, driven by `AudioManager`
  mutex contention; post-burst p99 ~2–5ms) was measured against `audio_set_rate` under a MIDI-rate
  burst (`scripts/latency-test.sh`), not a cold play/cue press reaching first audible sound.
- `docs/design/shared-output-pipeline.md` established a **171.3ms measured latency** the shared
  output graph's own buffering imposes (§"Measured on the Starlight, 2026-08-11") — a real,
  already-quantified floor, but it's latency *compensation math* for position reporting, not a
  press-to-sound stopwatch, and nothing currently checks whether the actual press-to-sound gap
  is anywhere near that floor or several times larger.

No instrument here can currently distinguish "the MIDI thread was slow to notice the button,"
"the frontend was slow to dispatch," "the IPC round trip was slow," "GStreamer took a while to
reach Playing," and "the output graph's own buffering delayed the first audible buffer" — all
five would present identically as "there was a gap," which is exactly the situation
`CLAUDE.md`'s rule about blind instruments describes: build the instrument that would read
differently under each hypothesis before doing anything else.

## 2. The suspected chain, link by link

From a physical PLAY/CUE press to an audible sound, in order, with what's known vs. unmeasured
at each link:

```
Physical button
     │  (USB MIDI wire; unmeasured, out of this app's control)
     ▼
midir receive thread (src-tauri/src/midi/mod.rs, connect_port's callback)
     │  decodes to an `action`; emits Tauri event "midi-action" (mod.rs:389-392)
     │  — UNMEASURED. A parallel "midi-raw" event already carries a timestamp
     │    (`t: crate::epoch_ms()`, mod.rs:340-350) but only when the raw MIDI
     │    monitor panel is mounted (`monitor::is_monitor_on()`) — off during a
     │    normal set, so it isn't a standing instrument today.
     ▼
Tauri event bus → webview (IPC delivery leg)
     │  — UNMEASURED. This is the leg the existing `epoch_ms()`-stamped event
     │    proves is measurable; it just isn't stamped on the *always-on* path.
     ▼
src/lib/midi/handler.ts's listen("midi-action", …) callback (handler.ts:384)
     │  updateDeck(id, { playing: !wasPlaying }) or similar (handler.ts:399) —
     │  a synchronous Svelte store write, expected cheap but never measured.
     ▼
Reactive effect → reconcileAudioTransport(deckId, playing) (transport.ts:64)
     │  — has its own retry/chain machinery (TransportChain, transport.ts:61) for
     │    the case audioPlay/audioPause races ahead of audio_load finishing —
     │    UNMEASURED whether a normal press ever actually falls into a retry path
     │    that adds a full timer delay, vs. always taking the immediate branch.
     ▼
audioPlay(deckId) / audioPause(deckId) IPC call → Rust audio_play/audio_pause
     │  (audio/mod.rs:313-333, spawn_blocking) → pipeline.play()/pause()
     │  (pipeline.rs:3448) → GStreamer set_state(Playing) — documented elsewhere
     │  in this codebase as returning ASYNC (pipeline.rs:3399, mod.rs:6585's
     │  comment on the same pattern) — meaning the Rust call can return *before*
     │  the pipeline has actually reached Playing. UNMEASURED whether audio_play's
     │  own return time is a good proxy for "reached Playing" or badly understates it.
     ▼
GStreamer state transition completes; buffers begin flowing:
     input_selector → eq/filters → output_queue → tee → per-device volume → sink
     │  `output_queue` can hold up to 100ms of buffering by design
     │  (`OUTPUT_QUEUE_STEADY_CAP_NS`, pipeline.rs:32) — a *known*, deliberate
     │  cap, not a bug, but it means "first buffer queued" and "first buffer
     │  audible" are not the same moment even once GStreamer says Playing.
     ▼
Shared output graph (audio/mixer.rs's OutputGraph) — appsrc → audiomixer → pulsesink
     │  measured 171.3ms latency (shared-output-pipeline.md) — a floor inherited
     │  by every deck on a shared node, already quantified but never checked
     │  against how long a *button press* actually takes end to end.
     ▼
PipeWire device buffer / quantum → speakers
     │  — out of scope for cuemark's own code, but worth knowing the rough size
     │    of before concluding a software fix is possible.
     ▼
Audible
```

## 3. What to add

Four cheap, always-on (not monitor-gated) timing points, correlated on the one clock this
codebase already established as shared between the Rust process and the webview — epoch
milliseconds (`crate::epoch_ms()`, already in use at `midi/mod.rs:347`; `CLAUDE.md`'s note that
`Instant`/`performance.now()` have per-process origins and cannot be differenced is exactly why
this matters here, not just for `[poll-stats]`).

1. **`midi-action`'s payload gets a `t: crate::epoch_ms()` field** (mirroring the existing
   `midi-raw` pattern at `mod.rs:340-350`, but always emitted, not monitor-gated). Zero new
   mechanism — the timestamp already exists two structs over; it just isn't on the path that
   runs during a real set.
2. **`handler.ts`'s `listen("midi-action", …)` callback**, for transport-class actions only
   (play/pause/cue/hot-cue — not continuous controls, which have no press-to-onset moment to
   measure), `debugLog`s `Date.now() - a.t` immediately on receipt. This isolates the MIDI-thread
   → Tauri-event-bus → JS-listener leg on its own, before any app logic runs.
3. **`transport.ts`'s `reconcileAudioTransport`**, at the point it calls `audioPlay`/`audioPause`,
   stash `performance.now()` (or reuse the same epoch-ms convention) keyed by `deckId`, and log
   the elapsed time from receipt (step 2) to IPC dispatch — this isolates the store-write +
   reactive-effect + (if hit) retry-chain leg. If a normal press never falls into the retry chain,
   this number should be small and boring; if it sometimes doesn't, this is where that would show.
4. **`audio_play`/`audio_pause`** (`audio/mod.rs:313-333`), `Instant::now()` around the
   `p.play()`/`p.pause()` call, logging `[button-latency] deck=… play ipc_call=…ms`. This times
   only the Rust call itself — given `set_state(Playing)` is documented ASYNC elsewhere in this
   codebase, treat this number as a **lower bound**, not the real press-to-sound time, and say so
   in the log line's own field name (`ipc_call`, not `total`) so nobody mistakes it for one.

**The one measurement that actually answers the question — first audible buffer after a play
press — needs a fifth point that none of the above provides**: a one-shot buffer probe on
`output_queue`'s src pad (or the per-branch `volume` element just downstream), armed on every
`play()` call and firing exactly once, logging elapsed time since the `audio_play` command was
issued. This is the only point in the chain that observes something the app itself is about to
make audible, as opposed to something the app merely *believes* is now playing. It is also the
riskiest piece to add — `CLAUDE.md` has many "load-bearing and silent when broken" notes about
this exact region of the pipeline (`output_queue`, the tee/branch topology) — so prototype it on
a throwaway branch and confirm zero effect on the existing underrun/handoff instrumentation and
on cue routing before trusting it in a real set.

## 4. Falsifiable predictions

State what each outcome would mean before reading the log — the discipline
`docs/design/queue-prefetch-cache.md` used and that settled its own question cleanly.

- **The MIDI-arrival-to-IPC-dispatch legs (points 1–3) sum to single-digit/low-double-digit ms,
  and `ipc_call` (point 4) is similarly small** → the software chain is not the problem. The gap
  lives entirely in GStreamer's state transition + `output_queue`'s buffering + the shared
  graph's 171.3ms floor — a hardware/pipeline-buffering story, not a bug anywhere in this app's
  own event/IPC code. The fix, if one is wanted, means touching `output_queue`'s cap or the
  shared graph's buffering — both already documented as delicate.
- **Any one of points 1–3 is regularly tens to hundreds of ms** → there's a real software-side
  delay (a slow store subscriber, a `TransportChain` retry firing on normal presses, event-bus
  contention) worth fixing directly, independent of anything GStreamer-side, and cheaper to fix
  than touching pipeline buffering would be.
- **The probe in §3's last paragraph shows first-audible-buffer time consistently well above
  171.3ms plus `output_queue`'s 100ms cap (i.e. above ~270ms)** → there's an unaccounted leg
  somewhere in the chain not covered by points 1–4, and the probe's own placement (which element,
  how far downstream) needs to move closer to the actual sink to find it.
- **First-audible-buffer time is close to the ~270ms floor described above** → the "perceptible
  gap" complaint may simply be describing a real, already-understood, structural latency this
  pipeline was built with — worth saying plainly rather than continuing to hunt for a bug that
  isn't there. A DJ-facing mitigation (visual/haptic feedback at press time, or pre-rolling the
  next deck's pipeline into Paused ahead of an anticipated press) would then be the honest next
  conversation, not further profiling.

## 5. Non-goals for this pass

- No change to `output_queue`'s 100ms cap, the shared output graph's buffering, or
  `TransportChain`'s retry logic — this doc only proposes measuring them, not touching them.
  Both are documented elsewhere as load-bearing and previously the site of real incidents
  (`docs/design/audio-dropout-mid-playback.md`, `shared-output-pipeline.md`'s own cautions).
- No coverage of continuous MIDI controls (faders, EQ, jog) — they have no discrete press-to-onset
  moment and are already covered by the `audioSync.ts` store-bypass pattern for a different reason
  (throughput, not onset latency).
- Doesn't re-open `docs/design/queue-prefetch-cache.md` or `docs/design/preroll-latency.md`'s
  territory — this is specifically about a press on an **already-loaded** deck.

## 6. Phasing

**1 — Instrumentation only.** The four points in §3, plus a prototyped (throwaway-branch-first)
first-buffer probe. Zero behavior change to the pipeline itself. Read logs from one real set
before deciding anything.

**2 — Only if the logs point at the software chain.** Fix whichever specific leg (points 1–3)
turns out to be slow — likely a small, targeted change once located.

**3 — Only if the logs point at pipeline buffering.** A separate design conversation about
whether/how to reduce `output_queue`'s cap or the shared graph's latency for transport-class
presses specifically, without reopening the dropout/underrun history those buffers exist to
prevent. Not started until phase 1's numbers justify it.

## Open decisions before implementation starts

1. **Where exactly to place the first-audible-buffer probe** — `output_queue`'s src pad is the
   natural choice (closest shared point before per-device branching) but the tee/branch topology
   has enough documented fragility that this needs a working prototype and a clean
   `[deliver-tel]`/underrun A/B before trusting it, not just a code read.
2. **Whether `TransportChain`'s retry path is ever hit on a normal, already-loaded-deck press**
   — if it's provably never hit outside of the audio_load race it was built for, point 3's
   timestamp may be unnecessary; if it's sometimes hit, that's independently worth knowing.
3. **Whether the mitigation, if the floor turns out to be structural, belongs in this doc's scope
   at all** — a DJ-facing UX mitigation (visual feedback, pre-roll) is a different kind of change
   than anything else this doc proposes, and may deserve its own doc once §4's predictions are
   read.
