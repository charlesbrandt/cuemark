# Deck EQ and sweep filter

**Status**: 🟢 Built and **live-verified 2026-08-17** — user-confirmed audibly, on the real
Starlight, in both knob modes. The MIDI path resolves end to end across full travel with
an exact centre:

```
=> DeckFilter { deck_id: "deck-0", value: -1.0 … 0.0 … 1.0 }
=> DeckEqLow  { deck_id: "deck-0", value: -24.0 … 0.0 … 12.0 }
```

The bass/filter CC assignment (CC 2 = bass, CC 1 = filter) is confirmed by that same test:
a swapped mapping would have made the bass knob audibly sweep a filter.

What remains open is **taste, not correctness** — see §8.

## 1. What was wrong

The EQ was dead at two independent layers, and each one alone was enough to make the
sliders do nothing:

1. **The backend was a stub.** `DeckAudioPipeline::set_eq()` was
   `Ok(())` with a comment reading "No-op until equalizer-3bands element is added."
2. **Nothing called it.** `audioSetEq()` in `src/lib/audio/pipeline.ts` was exported and
   had **zero callers** anywhere in the tree. The DeckCard sliders wrote `deck.eq` into
   the Svelte store and stopped there.

Worth noting for its own sake: fixing only (1) would have left the sliders just as dead,
with a fully working EQ sitting behind them. The stub comment named the missing element
and drew attention away from the missing call site.

## 2. Where the tone stage sits, and why only there

```
… → pitch → [spectrum] → input_selector → eq → filter_hp → filter_lp → output_queue → tee
                              ↑                                                        ├─ main sinks
                        scratch branch                                                 └─ cue branch
                        (appsrc) joins here
```

Between `input_selector` and `output_queue` is the only position that satisfies all three
requirements at once:

- **Downstream of `input_selector`** — so the scratch/`appsrc` branch is EQ'd identically
  to the normal branch. Placing it upstream (say, next to `pitch`) would mean a scratch
  gesture silently bypassed the EQ, so the tone would change for the duration of every
  jog and drag.
- **Upstream of the `tee`** — so main *and* cue hear it. That matches a real mixer's
  post-EQ PFL: you want to hear in the headphones what the room is about to get.
- **Where caps are already pinned.** `rate_caps` and `capsfilter2` fully specify
  `deck_output_caps()` (F32LE/48k/2ch/mask 0x3) on both selector inputs. Every element
  added here accepts F32LE natively, so no `audioconvert` is needed and nothing
  renegotiates — the caps-identity invariant guarded by the long comment on `caps_48k`
  (the one that cost a four-session investigation into digital-zero cue output) is
  untouched.

Neither element adds latency: both are IIR. The graph's measured 171.3 ms latency
correction in `position()` needs no revisiting.

## 3. Why `equalizer-nbands` and not `equalizer-3bands`

`equalizer-3bands` is one element with no configuration, which is genuinely tempting. Its
bands are fixed at **100 Hz / 1.1 kHz / 11 kHz**.

11 kHz is far above a DJ mixer's high crossover (~3–4 kHz). Killing "highs" on that layout
would leave vocals, snares and most hat energy essentially intact — the control would
work, in the sense of measurably changing the signal, while not doing the thing the label
promises.

`equalizer-nbands num-bands=3` costs one extra helper (`make_eq()`) and gives the standard
mixer split, which is also what `DeckEQ` in `src/lib/state/types.ts` had *already been
documenting* since before any of this was implemented:

| Band | Type | Frequency | Bandwidth |
|---|---|---|---|
| `band0` | low-shelf | 250 Hz | 250 Hz |
| `band1` | peak | 1 kHz | 1800 Hz |
| `band2` | high-shelf | 4 kHz | 4000 Hz |

Bands are `GstChildProxy` children, not element properties. `gst::Element` does not
statically implement `ChildProxy`, so `eq_band()` goes through `dynamic_cast_ref`.

## 4. Range: −24…+12 dB, and why the UI had to change

`equalizer-nbands` clamps each band to **−24…+12 dB** and silently accepts anything
outside that. The sliders were `min="-12" max="12"`.

The asymmetry is the element's, but it happens to match how real mixers are marked: gentle
boost, cut deep enough to serve as a kill. So the bottom of the slider travel **is** the
kill — the per-band `×` button jumps there rather than engaging any separate mechanism,
and the readout prints `KILL` at the endpoint.

⚠️ Do not widen the sliders past −24. Everything below it is accepted, displayed, and
ignored.

## 5. The sweep filter is a parked pair, not a mode switch

One knob, −1 … 0 … +1. Left of centre sweeps a low-pass down; right sweeps a high-pass up.

`audiocheblimit` has a runtime-writable `mode` property, so one element could serve both.
It is not used that way here: flipping `mode` recalculates coefficients under a running
stream, which clicks — on a control whose entire purpose is being swept back and forth
*through* centre. Instead there are two elements, each parked outside the audible band
when idle. Only `cutoff` ever moves.

Travel is **logarithmic** in frequency, so the knob tracks pitch. Linear travel would
spend over half its range above 11 kHz, where a sweep is barely audible, and cross the
musically interesting decade in the last few percent. `travel_is_logarithmic_not_linear`
guards this.

| Constant | Value | Meaning |
|---|---|---|
| `FILTER_HP_PARK_HZ` | 20 Hz | high-pass when idle |
| `FILTER_LP_PARK_HZ` | 23 kHz | low-pass when idle |
| `FILTER_LP_MIN_HZ` | 200 Hz | full-left endpoint |
| `FILTER_HP_MAX_HZ` | 8 kHz | full-right endpoint |
| `FILTER_POLES` | 4 | 24 dB/octave |
| `FILTER_DEADBAND` | 0.02 | knob travel treated as centred |

### Neutral must be transparent — measured, not assumed

Both stages sit in the chain **permanently**, including at neutral. If either coloured the
signal at rest, every deck would inherit that colouration forever, and in this codebase's
usual style, silently.

Measured with a per-frequency sine transfer test (30 Hz – 16 kHz) against an unfiltered
control arm, plus a `lp500` arm that must fail:

| Chain | Worst deviation | Verdict |
|---|---|---|
| `equalizer-nbands`, all gains 0 | **0.00 dB** | exactly transparent |
| high-pass parked at 20 Hz | +0.24 dB @ 60 Hz | flat |
| low-pass parked at 20 kHz | +0.22 dB @ 16 kHz | flat |
| low-pass parked at **23 kHz** | **+0.05 dB** @ 16 kHz | flat |
| full neutral chain | +0.24 dB | flat |
| control: low-pass at 500 Hz | **−87.3 dB** @ 16 kHz | coloured, as required |

The residual is Chebyshev passband ripple and is inaudible. The low-pass parks at 23 kHz
rather than 20 kHz purely on this measurement — both are fine, there is no reason to take
the worse one.

The control arm matters: without it, "flat" everywhere is equally consistent with a
measurement that cannot detect filtering at all.

## 6. MIDI: the Starlight's dual-function tone knob

The Starlight does not have a bass *button*. It has **one knob per deck** that acts as
either bass or filter, switched by the global Bass/Filter button at `(0x90, 1)` — which is
what `midi.rs` had been quietly documenting all along:

```rust
// CC: bass/filter knob (CC 2 coarse; CC 34 fine — ignored)
// TODO: wire to shader u_bass_gain once Phase 2 audio-reactive uniforms land
```

**The controller performs the switch itself, in firmware.** Verified live 2026-08-17 by
capturing one physical knob across a button press:

```
0xB1 d1= 2  d2=63,2,0,38,64,106      ← knob sweeping (fine on CC 34)
0x90 d1= 1  d2=127 → d2=0            ← Bass/Filter button, momentary
0xB1 d1= 1  d2=127,96,73,63,32,15,0  ← same knob, different CC (fine on CC 33)
```

So cuemark holds **no mode state**. The two modes arrive as two CCs and map to two
destinations, exactly like Shift's firmware pad remapping:

| CC | Binding | Destination |
|---|---|---|
| `(0xB1, 2)` / `(0xB2, 2)` | `DeckEqLow` | `deck.eq.low`, −24…+12 dB |
| `(0xB1, 1)` / `(0xB2, 1)` | `DeckFilter` | `deck.filter`, −1…+1 |

🛑 `(0x90, 1)` stays **unmapped**, and the mode must not be tracked host-side. The button
is momentary and never reports which mode it selected, so a host-side guess would drift
out of sync with the hardware after any reconnect — and the knob would then silently drive
the wrong control. `bass_filter_button_stays_unmapped` is a regression guard.

Knob→value mapping lives in Rust (`knob_to_eq_db`, `knob_to_filter`), *unlike* the tempo
fader whose range rescaling deliberately lives in `handler.ts`. The difference is that the
tempo range is user-configurable and the EQ range is not, so keeping it in Rust means the
persisted value is already semantic and needs no second copy of the dB range.

Centre is snapped to neutral (`KNOB_CENTRE_SNAP = 0.02`). The pot has no detent, so
without the snap "off" is a position the user cannot actually select by feel — the same
always-on-never-noticed failure §5's transparency measurement guards against downstream.

### Persistence has one special case

`persist_kv` writes `deck-N.eqLow`, and `restoreMidiControlState()` applies persisted keys
as flat deck fields. `eqLow` is the only key that names a **nested** field, so it is merged
into the deck's current `eq` explicitly. A raw patch would create a bogus top-level
`eqLow` property and leave the real EQ untouched — silently.

### An earlier version of this got the control wrong

This was first built as `ControlBinding::EqKill` — a button that toggles a band between
full cut and flat. That is a perfectly ordinary DJ control, but it is not the control this
hardware has, and it was designed around a misreading of "Bass/filter toggle `(0x90,1)`"
in the skill doc as *"a button that kills bass"* rather than *"a button that changes what
the knob does."* It was removed rather than left in place: dead code carrying a confident
but wrong rationale is worse than no code.

## 7. Persistence across reloads

`load()` rebuilds every element on **every track load and every device rebuild**. EQ gains
and filter position are therefore held on `DeckAudioPipeline` and re-applied there,
immediately alongside `pitch.set_property("tempo", self.rate)` which exists for exactly
the same reason.

Both setters also work with no pipeline built: the value is stored and applied when one
appears, so setting EQ on an empty deck is not silently discarded.

Without this the EQ would have worked until the next track load and then reset to flat
mid-set, with nothing logged — the failure mode catalogued throughout
`docs/design/silent-failure-inventory.md`.

## 8. What is verified, and what is still open

**Verified**: type-checked; unit-tested (`tone_stage_tests` ×4, `tone_knob_tests` ×6);
neutral transparency measured at the GStreamer level (§5); both knob modes confirmed
audibly by the user on the real Starlight, including the CC assignment.

**Still open — all of it taste, none of it correctness.** These are judgement calls that
only show up over a real set, and each has a named lever:

| Question | Lever if it feels wrong |
|---|---|
| Do 250 Hz / 1 kHz / 4 kHz split the way you mix? | `EQ_*_FREQ_HZ` / `EQ_*_BW_HZ` |
| Does −24 dB read as a *kill*, or does it need a true mute? | `EQ_MIN_DB`, or a separate mute stage |
| Is 200 Hz / 8 kHz the right filter travel? | `FILTER_LP_MIN_HZ` / `FILTER_HP_MAX_HZ` |
| Is the sweep too gentle or too abrupt? | `FILTER_POLES` (24 dB/oct today) |
| Is the centre detent easy to find on the knob? | `KNOB_CENTRE_SNAP` in `midi.rs` |

One structural item is worth a deliberate check rather than waiting to notice it:
**the EQ during a scratch gesture.** That is the single path where this element placement
(downstream of `input_selector`) differs from the obvious one, and it is why the placement
was chosen — so it is also the thing that would silently regress if anyone "simplified"
the topology later. Grab the bass knob mid-scratch; the tone should not change.
