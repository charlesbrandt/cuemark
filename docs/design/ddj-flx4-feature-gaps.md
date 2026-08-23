# DDJ-FLX4 feature gaps — what the hardware offers that cuemark doesn't do

Status: 📐 **CATALOGUE, no code implied**, plus 🟢 **tier 1 + tier 2 rows below are
implemented and bench-verified live on the real FLX4 (2026-08-23), one byte fixed along
the way (SHIFT+CUE quantize toggle).** Written 2026-08-22, alongside
the FLX4 profile work in `docs/design/controller-mapping.md`. This doc answers a different
question than that one:

> **`controller-mapping.md`** is about *mapping* — turning a physical control's MIDI bytes
> into a `ControlBinding`/`MidiAction` cuemark already knows how to act on (jog encoding,
> pad-mode CC layout, the LED handshake, the profile-as-data system).
>
> **This doc** is about *application features* — physical controls whose target
> **behaviour doesn't exist in cuemark at all**, MIDI binding or not. A control here would
> stay dead even after the FLX4 gets a complete, correct profile, because there is nothing
> on the cuemark side for it to drive.

Nothing here should be built from this doc alone. It's an inventory to pull from when
scoping future work, cross-referenced against what cuemark's data model and audio pipeline
actually do today (verified by reading the code, not assumed from the hardware's labels —
see `feedback_hardware_semantics_ask_dont_infer` for why that distinction matters on this
project).

## Sources

- Pioneer/AlphaTheta's own DDJ-FLX4 manual (part-names-and-functions section), via the
  [Mixxx user manual's hardware page](https://manual.mixxx.org/2.4/en/hardware/controllers/pioneer_ddj_flx4).
  ⚠️ **The manual is not more trustworthy than the Mixxx mapping below just because it's
  the vendor's own document.** §8's original "MASTER level, HEADPHONES LEVEL knobs...
  analog pots" claim was sourced from here and was wrong for HEADPHONES LEVEL — it sends
  real MIDI, confirmed by a live capture 2026-08-22 (see §8's correction note). A manual
  describes the control surface for a human, not the wire protocol; treat it the same as
  the Mixxx mapping below — a lead on *which controls exist*, never a substitute for a
  capture on this unit.
- Mixxx's shipped mapping,
  [`Pioneer-DDJ-FLX4.midi.xml`](https://github.com/mixxxdj/mixxx/blob/main/res/controllers/Pioneer-DDJ-FLX4.midi.xml)
  — a third party's byte-level reference, useful for *which controls exist* and *roughly
  which section they're in*. ⚠️ **Not verified against cuemark's own raw-MIDI monitor.**
  Where `controller-mapping.md` §8 already captured a control live (jog encoding, pad-mode
  CC layout), this doc defers to that capture; everything else here is Mixxx's byte values,
  unconfirmed on this unit, and must go through the same "capture before designing" process
  before any profile row is written from it.
- Direct reads of `src/lib/state/types.ts`, `src/components/DeckCard.svelte`,
  `src-tauri/src/audio/pipeline.rs`, and `src/lib/midi/handler.ts` (2026-08-22) — what
  cuemark's data model, UI, and audio DSP chain actually contain, not what a doc claims
  they contain.

## How to read the tables

- 🟢 **Feature exists, MIDI binding doesn't.** cuemark already has the state field, the UI,
  and (where relevant) the DSP element. Once the physical control's bytes are captured and
  the profile system exists, wiring this is a normal profile row — no new application code.
- 🟡 **Partial / different shape.** A related cuemark concept exists but doesn't do the same
  thing the hardware control does. Needs a design decision, not just a binding.
- 🔴 **No cuemark feature at all.** The hardware control has nothing to drive — new
  data-model fields, UI, and possibly new DSP or non-MIDI subsystems (browse/library, a
  sample-slot player) would be needed first.

---

## 1. Loop tools

| Control | Hardware behaviour | Status | Notes |
|---|---|---|---|
| Loop IN / OUT buttons | Set loop start/end independently at the current position | 🟢 done, live-verified | `deck.loopIn`/`loopOut` + DeckCard's own IN/OUT buttons already did this by mouse. **Implemented 2026-08-22, bench-verified 2026-08-23**: `ActionId::LoopIn`/`LoopOut`, `MidiAction::LoopIn`/`LoopOut` (`decode.rs`), `handler.ts` cases mirroring DeckCard's onclick logic, FLX4 rows at `(0x90/0x91, 0x10)`/`(0x11)` — Mixxx's bytes were correct as-is, confirmed live on both decks. |
| 4BEAT/EXIT (loop on/off) | Toggle the currently-set loop | 🟢 done, live-verified | `ControlBinding::LoopToggle` already existed (bound on the Starlight). **Implemented 2026-08-22, bench-verified 2026-08-23**: FLX4 binding at `(0x90/0x91, 0x4D)` (RELOOP/EXIT) — Mixxx's byte correct as-is, confirmed live on both decks (loop audibly engages/disengages). |
| Beat Loop pad mode | 8 pads select a loop length (1/4…32 beats), enable on press | 🟢 done, live-verified | `ControlBinding::LoopPreset` implements this ladder. Already bound and live-verified on the FLX4 as part of the 2026-08-22 bench pass (`loop_preset` rows in `pioneer-ddj-flx4.toml`, status `0x97`/`0x99` d1 `0x20`-`0x23`) — this row was stale when first written; no further work needed. |
| Cue/Loop Call `<` / `>` (halve / double) | Halve or double the current loop length in place | 🟢 done, live-verified | **Implemented 2026-08-22, bench-verified 2026-08-23**: `ActionId::LoopHalve`/`LoopDouble`, `MidiAction::LoopHalve`/`LoopDouble`, `handler.ts` case (reads `loopIn`/`loopOut`, halves/doubles the width anchored at `loopIn`), FLX4 rows at `(0x90/0x91, 0x51)`/`(0x53)` (Cue/Loop Call left/right) — Mixxx's bytes correct as-is, confirmed live and audible on both decks. |
| SHIFT + Cue/Loop Call (jump ±32 beats) | Jump the playhead by a fixed 32-beat block, independent of any loop | 🟢 done, live-verified | **Implemented 2026-08-22, bench-verified 2026-08-23**: new generic `ActionId::BeatJump { beats: f32 }` / `MidiAction::BeatJump { slot, beats }` (the seek-without-loop sibling of `LoopPreset` this row originally called for), `handler.ts` case using `seekDeckExitingLoop` + grid-forced `quantizeToGrid`. FLX4 rows at `(0x90/0x91, 0x3D/0x3E)` with `beats = ±32.0` — Mixxx's bytes correct as-is, confirmed live (correct sign, correct magnitude) on both decks. The `BeatJump` action is generic (any signed beat count), so the pad-mode row below can reuse it once captured. |
| Reloop/Exit vs plain loop toggle | Re-engage the *last* loop after exiting, rather than toggling a currently-armed one | 🟡 | Unchanged — `LoopToggle` flips `deck.loop` and reuses whatever `loopIn`/`loopOut` are already set, so simple reloop-after-exit already works by accident. What's missing is the *history* case — re-looping a *previous* loop after a different one has since been set — which cuemark has no memory of. Likely fine to ignore unless it's asked for by ear. |
| Loop Adjust IN / OUT (nudge existing loop boundary by small increments while looping) | Fine-tune loop point without re-dropping it | 🔴 **deliberately out of scope for this pass** | Not just a discrete-action gap: per Mixxx's mapping, SHIFT+LOOP IN/OUT *toggles a mode* that then repurposes the jog wheel's turn events to nudge loop points instead of scratching — a stateful mode overlay on the jog-turn path, which CLAUDE.md flags repeatedly as fragile (`docs/design/waveform-scrub.md`, the scrub bus, the feeder's servo). This is a real feature with its own design questions, not a narrow addition — left for a dedicated pass, not bundled into the 2026-08-22 automated sweep. |
| Beat Jump pad mode (SHIFT+Beat Loop button) — jump playhead ±1/2/4/8 beats, no loop | Quick non-looping navigation | 🟡 **app-side done, binding blocked on a real capture** | The `BeatJump` action this needs already exists (see the 32-beat row above). **Not bound in the FLX4 profile**: Mixxx's mapping puts these pads at status `0x97`/`0x99` d1 `0x20`-`0x27`, which collides directly with this profile's own **live-captured** Beat Loop pad rows at the same keys (`0x20`-`0x23`) — a real disagreement between Mixxx's reference and this unit's actual firmware bytes, not something to guess past. Needs a live capture (see the comment in `pioneer-ddj-flx4.toml` near the Sampler-mode note). |

## 2. Tone / EQ / filter

| Control | Hardware behaviour | Status | Notes |
|---|---|---|---|
| EQ HI / MID / LOW (3 dedicated knobs per channel) | Independent −24…+12 dB shelving/peak per band | 🟢 done, live-verified | `DeckEQ` has `low`/`mid`/`high`, `equalizer-nbands` implements all three. The Starlight only ever reached `low` (one dual-function knob); the FLX4's three separate knobs were bound and live-verified 2026-08-22 (`eq_low`/`eq_mid`/`eq_high` rows, both decks) as part of the original bench pass — this row was stale when first written; no further work needed. |
| CFX / filter knob | Sweep filter, −1…+1 like a mixer's | 🟢 done, live-verified | `ControlBinding::DeckFilter` bound and live-verified 2026-08-22 (`filter` rows, both decks, status `0xB6`). Stale row; no further work needed. |
| Smart CFX / alternate QuickEffect assignments | Assign the CFX knob to a different effect type than "filter" | 🔴 | cuemark has exactly one filter type (the parked HP/LP pair). No effect-assignment concept exists. Low priority — the default (filter) is already covered. |
| TRIM knob | Pre-fader gain trim | 🟢 done, live-verified | `ControlBinding::DeckGain`, bound to the FLX4's Trim knob and live-verified 2026-08-22 (`gain` rows, both decks). Stale row; no further work needed. |

## 3. Beat FX section

| Control | Hardware behaviour | Status | Notes |
|---|---|---|---|
| FX Select, Beat `<`/`>`, Level/Depth, ON/OFF, channel-route switch | Loads/selects a beat-synced audio effect (echo, delay, reverb, etc.) into a send, controls wet/dry and effect-specific parameter, routes deck 1/2/both into it | 🔴 **Whole subsystem missing.** | cuemark's only per-deck audio processing beyond gain/EQ/filter is the tone stage (`pipeline.rs`'s `eq` → `filter_hp` → `filter_lp` chain, described in CLAUDE.md's audio pipeline diagram). There is no delay/echo/reverb GStreamer element anywhere in the pipeline, no per-deck effect-send concept in the data model, and no "which beat-fraction" timing logic. This is a real feature, not a mapping task — likely a `gst-plugins-bad` element (`audioecho`, `gstreamer_deinterlace`-style bank, or similar) tempo-synced off `deck.bpm`, with its own design doc before any MIDI binding is written. Don't scope this as part of the FLX4 profile. |

## 4. Sampler pad mode

| Control | Hardware behaviour | Status | Notes |
|---|---|---|---|
| Sampler mode (8 pads: load / play / stop-and-unload) | Trigger short one-shot audio clips independent of the two decks | 🔴 | No "sample slot" concept anywhere in cuemark — `Deck` is exclusively `{type:'video', filePath, duration}` per CLAUDE.md's "Deck sources" section, and there is no lightweight one-shot player alongside the deck pipelines. Building this means a third kind of audio source (short clip, no video, no crossfader involvement, probably its own small `DeckAudioPipeline`-lite) — a real feature with its own design questions (how many slots, persistence, does it need a video counterpart given cuemark is fundamentally a VJ tool). Not something to improvise while authoring the FLX4 profile. |

## 5. Transport / playback

| Control | Hardware behaviour | Status | Notes |
|---|---|---|---|
| PLAY/PAUSE, CUE | Standard transport | 🟢 done, live-verified | `DeckPlayToggle`/`CueJump` bound on the Starlight and live-verified on the FLX4 2026-08-22 (`play_toggle`/`cue_jump` rows, both decks). Stale row; no further work needed. |
| SHIFT+PLAY (censor/reverse — momentary reverse while held, resumes forward on release) | Backspin-style reverse scrub | 🔴 | `rate_from_14bit` and the scratch feeder both clamp to positive rates (`(1.0 + delta*0.5).clamp(0.25, 4.0)` in `midi.rs`; `SCRATCH_TARGET_MAX_RATE` bounds in `pipeline.rs` are also one-sided). Reverse playback has never been exercised anywhere in the audio pipeline — GStreamer *can* do negative rates with the right seek flags, but nothing here has tried it, and the `pitch` (soundtouch) element's behavior at negative rates is unknown. Worth a probe before assuming it's a small change. |
| SHIFT+CUE (stutter play from cue point) | Press-and-hold plays from cue, release jumps back | 🔴 | No momentary-preview-from-cue action exists; `CueJump` is a single discrete jump. |
| Quantize toggle (SHIFT+Cue/PFL) | Toggle beat-quantized cue/loop actions | 🟢 done, live-verified | This is `Session.snapToBeat` (the toolbar SNAP toggle, `quantizeToGrid()` in `seekBus.ts`). **Implemented 2026-08-22, bench-verified 2026-08-23**: `ActionId::SnapToggle`, `MidiAction::SnapToggle {}` (global, no slot), `handler.ts` case flipping `session.snapToBeat`. **Mixxx's assumed byte (`0x68`) was wrong for this unit** — live capture showed SHIFT+CUE actually sends `d1=0x48` (a distinct note; the bare SHIFT button separately sends its own note `0x3F`, held, unbound). Fixed to `(0x90/0x91, 0x48)` and re-verified live on both decks — the SNAP toolbar toggle now flips on SHIFT+CUE. Still unbound on the Starlight. |
| SYNC (tap) | One-shot tempo+phase match to the reference deck | 🟢 done, wire-confirmed | `ControlBinding::SyncToggle` toggles `deck.syncLocked` (continuous re-lock, per `docs/design/beatmatching.md`) — a stronger behavior than the FLX4's one-shot tap, but a superset, not a gap. Bound and wire-confirmed on the FLX4 2026-08-22 (`sync_toggle` rows) — the deck-bpm-sync effect itself wasn't exercised in that pass (no track loaded). |
| SYNC long-press (lock) | Distinguish tap-sync from hold-to-lock | 🟡 | cuemark's `SyncToggle` is already the "lock" behavior unconditionally (see above) — there's no *tap-only* variant to distinguish from. Only relevant if a future design wants the FLX4's tap/hold distinction specifically; today's single toggle already gets to the stronger state. |
| SHIFT+SYNC (cycle tempo range) | Cycle the tempo fader's ± range | 🟡 | Different UI, same underlying setting: cuemark already has this as `tempoRange` (`audioSettings.ts`, a Settings-panel `<select>` with presets ±4…±100%, per `skills/midi/SKILL.md`). No binding wires a physical control to it; would need a `TempoRangeCycle` action if wanted on-controller. |

## 6. Browse / library

**Reframed 2026-08-23**: cuemark deliberately has no embedded media browser
(`skills/digger-integration/SKILL.md`'s "No embedded file browser in cuemark" boundary
rule — Digger owns the library). So the encoder/LOAD don't drive a library browser;
they drive a cursor through the **Digger queue panel** that already exists
(`DiggerQueue.svelte`). See the design discussion in the session that added this —
three shapes considered (queue-only cursor / cursor also covers search results / full
paginated library browse), queue-only chosen as the one that needs no new Digger
endpoint and doesn't duplicate Digger's own UI inside cuemark.

| Control | Hardware behaviour | Status | Notes |
|---|---|---|---|
| Rotary browse encoder (turn: move queue-cursor) | Move a selection through the Digger queue, wrapping at both ends | 🟢 live-verified 2026-08-23 | **Implemented 2026-08-23**: `ActionId::QueueCursor`/`MidiAction::QueueCursor{delta}` (relative, twos7-encoded — a DIFFERENT relative encoding than this unit's own jog wheels, which use offset64, §8.2), `queueStore.ts`'s `moveQueueSelection()` (wraps), `handler.ts`'s `queue_cursor` case (also auto-opens the queue panel via the new `showDiggerQueue` store). FLX4 row at `(0xB6, 0x40)`. Raw wire sign kept unflipped in `decode.rs` (CW=-1, CCW=+1) — a first pass flipped it on an unverified assumption ("CW should mean forward"), and live testing against the real running app said that direction read backward; reverted to the raw sign and confirmed correct. Locked in by a capture-replay test (`flx4_queue_browse_replay_matches_capture`) against `capture-1787503280692.json`. |
| LOAD (deck 1 / deck 2) | Load the queue-cursor's current selection into a deck | 🟢 live-verified 2026-08-23 | **Implemented 2026-08-23**: `ActionId::QueueLoad`/`MidiAction::QueueLoad{slot}`, `queueStore.ts`'s `loadSelectedQueueItem()` (reuses the same `loadQueueItemToDeck()` the panel's own click-to-load buttons now call, extracted out of `DiggerQueue.svelte` so the two paths can't drift), `handler.ts`'s `queue_load` case. FLX4 rows at `(0x96, 0x46)`/`(0x96, 0x47)` — note-on channel 6, **not** the per-deck 0x90/0x91 channel other deck-scoped buttons on this unit use; both decks' LOAD share that one channel, distinguished only by note number. |
| SHIFT+browse encoder (waveform zoom) | Zoom the waveform view | 🟡 | Unchanged — `WaveformCanvas` likely has *some* zoom concept already (OVR vs zoomed view is referenced throughout `docs/design/waveform-scrub.md`), not verified or wired in this pass. |

## 7. Jog wheel — capacitive touch

Already tracked in `controller-mapping.md` §2 and §10 ("`JogTouch` precedence") — not
duplicated here in full. Short version: the FLX4 reports platter touch as a real physical
signal (`(0x90/0x91, 0x36)` per Mixxx's mapping, matching cuemark's own capture referenced
in §8.5's writeup), which cuemark's *scratch-while-playing* feature has never had — today
`deck.playing` alone decides scratch-vs-bend. Touching a **playing** deck's platter to
scratch over live audio is a real, user-visible feature gap (not just an unmapped control),
flagged as its own open item in `controller-mapping.md` §10 and `docs/design/waveform-scrub.md`.

## 8. Mixer controls that are hardware-only (not gaps)

For completeness — these appear in the manual but **never send MIDI on this unit**, so they
are neither a mapping task nor an application gap, just controls the box handles itself:

- **MASTER level** — analog pot on the FLX4's own audio interface output stage; no MIDI
  observed. ⚠️ **CORRECTED 2026-08-22**: this row previously also listed HEADPHONES LEVEL
  as analog-only, sourced from the manual rather than a live capture. That was wrong —
  live-verified the same session (via an independent `aseqdump` capture, after two
  app-level tests initially misattributed it), HEADPHONES LEVEL sends `0xB6`, CC
  `0x0D`/`0x2D` and is bound to `cue_gain` in `pioneer-ddj-flx4.toml`. The separate
  HEADPHONES MIX knob also sends real MIDI (`0xB6`, CC `0x0C`/`0x2C`) but is deliberately
  left unbound — cuemark has no cue/master mix-ratio concept. See `controller-mapping.md`'s
  bench-pass writeup for the full story.
- **Channel level indicators (VU meters)** — these would need cuemark to *send* MIDI
  (light an LED/meter from software). The generic output plumbing landed 2026-08-23
  (`controller-mapping.md` §12) for one control (headphone-Cue LED); meters are a
  different control group with their own uncaptured bytes and likely continuous-update
  semantics (not a plain Note On/Off toggle), so this remains its own uncaptured item,
  not automatically covered by that plumbing existing. Not re-listed as a separate item.
- **Microphone input** — 1/4" jack, explicitly not routed to the computer per the manual.
  Nothing for cuemark to do here regardless of feature completeness.

---

## Rough sizing, for whoever scopes this next

Cheapest first, using the 🟢/🟡/🔴 legend above.

**Update 2026-08-22 (automated pass, forked sub-agents, sequential):** tiers 1 and 2
implemented in code, passing `cargo check` / `cargo test midi::` / `npm run check`.

**Update 2026-08-23 (bench pass with the real FLX4, chat-relayed):** all 8 new controls
verified live on both decks (16 button presses total) — loop IN/OUT, RELOOP/EXIT,
halve/double, both SHIFT+Cue/Loop-Call beat jumps, and SHIFT+CUE quantize toggle. **One
real bug found and fixed**: Mixxx's reference byte for SHIFT+CUE (`0x68`) was wrong for
this unit — live capture showed it actually sends `d1=0x48`, a distinct note from the
bare SHIFT button's own note (`0x3F`, held, confirmed unmapped and not needed — same
firmware pattern as the Starlight, the shifted control already arrives as its own note).
Fixed in `pioneer-ddj-flx4.toml` for both decks, re-verified live. Every other assumed
byte from Mixxx's mapping was correct as-is. Also surfaced, out of scope for this pass:
an audible glitch when a loop wraps back to its start (`4BEAT/EXIT` test) — not
investigated here, worth a follow-up.

1. ~~**Free once the profile exists**~~ **DONE, bench-verified 2026-08-23**: loop IN/OUT,
   loop toggle, beat loop pads, EQ mid/high, filter knob, trim, play/cue, sync, quantize
   toggle (byte fixed from Mixxx's wrong `0x68` to the real `0x48`).
2. ~~**Small, scoped additions**~~ **DONE, bench-verified 2026-08-23**: loop halve/double
   and the 32-beat SHIFT+Cue/Loop-Call jump (new generic `BeatJump` action), both
   directions, both decks. Beat-jump *pads* are app-side ready (same `BeatJump` action) but
   **still not bound** — Mixxx's assumed pad-mode bytes collide with this profile's own
   live-captured Beat Loop pad bytes at the same keys, so binding them needs a real
   capture, not a guess (see the row above and the comment in the TOML). Loop adjust nudge
   was **deliberately excluded** from this pass — it's a stateful jog-wheel mode overlay,
   not a narrow addition; moved to tier 3 below.
2a. ~~**Browse/queue cursor + LOAD**~~ **DONE, live-verified 2026-08-23** (§6): reframed
   from "blocked on a media browser" to "cursor through the existing Digger queue panel"
   — no media browser needed, no new Digger endpoint. `QueueCursor`/`QueueLoad` actions,
   `queueStore.ts`, FLX4 rows at `(0xB6,0x40)` relative + `(0x96,0x46)`/`(0x96,0x47)`
   buttons, locked in by `flx4_queue_browse_replay_matches_capture`. **One direction bug
   found live**: a first pass flipped the encoder's raw sign on the unverified assumption
   that clockwise should mean "forward" — live testing said that read backward, so the
   sign flip was reverted (raw wire ticks used as-is: CW=-1, CCW=+1). Re-confirmed correct
   after the fix.
3. **Real features, own design pass needed**: reverse/censor playback (probe GStreamer
   negative-rate behavior first), sampler pad mode (new audio-source kind), Beat FX (new
   DSP subsystem), SHIFT+browse encoder waveform zoom (§6, still unverified/unwired),
   **loop adjust nudge** (jog-wheel mode overlay — read `docs/design/waveform-scrub.md`
   first, this touches fragile territory).
4. **Already tracked elsewhere, don't duplicate**: jog-touch-as-scratch-trigger
   (`controller-mapping.md` §10), MIDI/LED output (`controller-mapping.md` §1/§11).
