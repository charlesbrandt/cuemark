# DDJ-FLX4 feature gaps — what the hardware offers that cuemark doesn't do

Status: 📐 **CATALOGUE, no code implied.** Written 2026-08-22, alongside the FLX4 profile
work in `docs/design/controller-mapping.md`. This doc answers a different question than
that one:

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
| Loop IN / OUT buttons | Set loop start/end independently at the current position | 🟢 | `deck.loopIn`/`loopOut` + DeckCard's own IN/OUT buttons already do exactly this (`DeckCard.svelte` lines ~624–643) — mouse-only today, no MIDI binding. |
| 4BEAT/EXIT (loop on/off) | Toggle the currently-set loop | 🟢 | `ControlBinding::LoopToggle` exists and is bound on the Starlight (`(0x91,3)`/`(0x92,3)`). Straightforward FLX4 binding once its CC is captured. |
| Beat Loop pad mode | 8 pads select a loop length (1/4…32 beats), enable on press | 🟢 | `ControlBinding::LoopPreset` already implements this exact ladder (`LOOP_PRESET_BEATS` in `handler.ts`), built for the Starlight's own Loop pad-mode. FLX4's version is the same shape with 8 discrete pads instead of 4+shift — a wider pad range in the profile, no new logic. |
| Cue/Loop Call `<` / `>` (halve / double) | Halve or double the current loop length in place | 🔴 | No `LoopHalve`/`LoopDouble` action exists. Would need a new `MidiAction` and a `handler.ts` case that reads `loopIn`/`loopOut`, computes the new width around the same anchor, and re-quantizes. |
| SHIFT + Cue/Loop Call (jump ±32 beats) | Jump the playhead by a fixed 32-beat block, independent of any loop | 🔴 | No large-jump action exists. Closest relative is `CueJump` (jump to the stored cue point) — different semantics, not reusable as-is. |
| Reloop/Exit vs plain loop toggle | Re-engage the *last* loop after exiting, rather than toggling a currently-armed one | 🟡 | `LoopToggle` flips `deck.loop` and reuses whatever `loopIn`/`loopOut` are already set, so simple reloop-after-exit already works by accident. What's missing is the *history* case — re-looping a *previous* loop after a different one has since been set — which cuemark has no memory of. Likely fine to ignore unless it's asked for by ear. |
| Loop Adjust IN / OUT (nudge existing loop boundary by small increments while looping) | Fine-tune loop point without re-dropping it | 🔴 | No incremental-nudge action. Closest existing mechanism is dragging the waveform (`WaveformCanvas`), which isn't wired to loop boundaries specifically. |
| Beat Jump pad mode (SHIFT+Beat Loop button) — jump playhead ±1/2/4/8 beats, no loop | Quick non-looping navigation | 🔴 | Nothing in cuemark jumps the playhead by a beat count without engaging a loop. `LoopPreset` always sets `loop: true`; this needs a sibling action that seeks without looping. |

## 2. Tone / EQ / filter

| Control | Hardware behaviour | Status | Notes |
|---|---|---|---|
| EQ HI / MID / LOW (3 dedicated knobs per channel) | Independent −24…+12 dB shelving/peak per band | 🟢 (mid/high are MIDI-only gaps) | `DeckEQ` already has `low`/`mid`/`high` (`types.ts`), `equalizer-nbands` in the GStreamer chain implements all three (`pipeline.rs` `make_eq`), and `DeckCard`'s EQ sliders already control all three by mouse. **But no MIDI path has ever driven `mid` or `high`** — the Starlight has one dual-function knob that only reaches `low` (`ControlBinding::DeckEqLow`). The FLX4's three separate physical knobs are a clean match for an existing, currently mouse-only feature; `ControlBinding::DeckEqMid`/`DeckEqHigh` variants are new but trivial (same shape as `DeckEqLow`, different target field), not a design gap. |
| CFX / filter knob | Sweep filter, −1…+1 like a mixer's | 🟢 | `ControlBinding::DeckFilter` already exists and does exactly this. Plain binding once captured — the FLX4 doesn't share a knob between EQ and filter the way the Starlight does, so §6's "firmware-side mode" reasoning doesn't even apply here; it's just one more control. |
| Smart CFX / alternate QuickEffect assignments | Assign the CFX knob to a different effect type than "filter" | 🔴 | cuemark has exactly one filter type (the parked HP/LP pair). No effect-assignment concept exists. Low priority — the default (filter) is already covered. |
| TRIM knob | Pre-fader gain trim | 🟢 | This is `ControlBinding::DeckGain`, already bound on the Starlight's volume fader. Same target, different physical control. |

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
| PLAY/PAUSE, CUE | Standard transport | 🟢 | `DeckPlayToggle`/`CueJump` already exist and are bound on the Starlight. |
| SHIFT+PLAY (censor/reverse — momentary reverse while held, resumes forward on release) | Backspin-style reverse scrub | 🔴 | `rate_from_14bit` and the scratch feeder both clamp to positive rates (`(1.0 + delta*0.5).clamp(0.25, 4.0)` in `midi.rs`; `SCRATCH_TARGET_MAX_RATE` bounds in `pipeline.rs` are also one-sided). Reverse playback has never been exercised anywhere in the audio pipeline — GStreamer *can* do negative rates with the right seek flags, but nothing here has tried it, and the `pitch` (soundtouch) element's behavior at negative rates is unknown. Worth a probe before assuming it's a small change. |
| SHIFT+CUE (stutter play from cue point) | Press-and-hold plays from cue, release jumps back | 🔴 | No momentary-preview-from-cue action exists; `CueJump` is a single discrete jump. |
| Quantize toggle (SHIFT+Cue/PFL) | Toggle beat-quantized cue/loop actions | 🟢 | This is exactly `Session.snapToBeat` (the toolbar SNAP toggle, `quantizeToGrid()` in `seekBus.ts`) — a fully-built feature with zero MIDI binding anywhere, Starlight included. Cheapest possible win once a binding exists: `SnapToggle` action, one line in `handler.ts`. |
| SYNC (tap) | One-shot tempo+phase match to the reference deck | 🟢 | `ControlBinding::SyncToggle` exists and toggles `deck.syncLocked` (continuous re-lock, per `docs/design/beatmatching.md`) — a stronger behavior than the FLX4's one-shot tap, but a superset, not a gap. |
| SYNC long-press (lock) | Distinguish tap-sync from hold-to-lock | 🟡 | cuemark's `SyncToggle` is already the "lock" behavior unconditionally (see above) — there's no *tap-only* variant to distinguish from. Only relevant if a future design wants the FLX4's tap/hold distinction specifically; today's single toggle already gets to the stronger state. |
| SHIFT+SYNC (cycle tempo range) | Cycle the tempo fader's ± range | 🟡 | Different UI, same underlying setting: cuemark already has this as `tempoRange` (`audioSettings.ts`, a Settings-panel `<select>` with presets ±4…±100%, per `skills/midi/SKILL.md`). No binding wires a physical control to it; would need a `TempoRangeCycle` action if wanted on-controller. |

## 6. Browse / library

| Control | Hardware behaviour | Status | Notes |
|---|---|---|---|
| Rotary browse encoder (turn: navigate list, press: toggle list/tree focus) | Library navigation without touching the mouse/keyboard | 🔴 | No component named anything like a media browser exists in `src/components/` (checked directly — none found). CLAUDE.md's own "Phase 3" roadmap lists "Media browser / clip library" as **not yet built**. This control has nothing to drive until that ships. |
| LOAD (deck 1 / deck 2) | Load the browser's selected track into a deck | 🔴 | Same dependency — needs the browser to exist first. |
| SHIFT+browse encoder (waveform zoom) | Zoom the waveform view | 🟡 | `WaveformCanvas` likely has *some* zoom concept already (OVR vs zoomed view is referenced throughout `docs/design/waveform-scrub.md`) — worth checking whether this is a real binding opportunity independent of the browser gap, since it doesn't actually need library UI to exist. Not verified in this pass; flagged for whoever picks this up. |

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
  (light an LED/meter from software), which is the same "no MIDI output" gap already
  tracked in `controller-mapping.md` §1/§11. Not re-listed as a separate item.
- **Microphone input** — 1/4" jack, explicitly not routed to the computer per the manual.
  Nothing for cuemark to do here regardless of feature completeness.

---

## Rough sizing, for whoever scopes this next

Cheapest first, using the 🟢/🟡/🔴 legend above:

1. **Free once the profile exists** (🟢, no new app code): loop IN/OUT, loop toggle, beat
   loop pads, EQ mid/high, filter knob, trim, play/cue, sync, **quantize toggle** (genuinely
   zero-cost — the feature is fully built and has never had *any* controller binding, Starlight included).
2. **Small, scoped additions** (🔴 but narrow): loop halve/double, 32-beat jump, beat-jump
   pads (seek-without-loop sibling of `LoopPreset`), loop adjust nudge.
3. **Real features, own design pass needed**: reverse/censor playback (probe GStreamer
   negative-rate behavior first), sampler pad mode (new audio-source kind), Beat FX (new
   DSP subsystem), browse/library (blocked on the Phase 3 media browser existing at all).
4. **Already tracked elsewhere, don't duplicate**: jog-touch-as-scratch-trigger
   (`controller-mapping.md` §10), MIDI/LED output (`controller-mapping.md` §1/§11).
