---
name: midi
description: Hercules DJControl Starlight MIDI mapping for cuemark — channel layout, full control map, and how to add or re-calibrate a MIDI controller. Load when editing midi.rs, adding bindings, or mapping a new controller.
---

# Cuemark MIDI — Hercules DJControl Starlight

## Channel layout (verified)

The Starlight uses separate MIDI channels per deck — do **not** mask the channel nibble in the map key:

| MIDI bytes | Deck / purpose |
|---|---|
| `0x91` Note On, `0xB1` CC | Left deck (ch 2) |
| `0x92` Note On, `0xB2` CC | Right deck (ch 3) |
| `0x96` Note On | Left hot-cue pads (ch 7) |
| `0x97` Note On | Right hot-cue pads (ch 8) |
| `0xB0` CC | Global — crossfader, master volume (ch 1) |

14-bit CC pairs: every continuous control sends a coarse MSB on CC N and a fine LSB on CC N+32.
For volume/crossfader, mapping the MSB only (7-bit = 128 steps) is sufficient.
For the **tempo fader**, map **both** MSB (CC 8) and LSB (CC 40): the MSB barely moves for small
slider adjustments — the real fine data is in the LSB. Both are combined via `rate_from_14bit(msb, lsb)`:
14-bit center = 8192 (MSB=64) → 1.0×; Rust emits a fixed ±50% range (0.5–1.5×).
**Direction**: the Starlight sends *higher* values for negative pitch (pushing down = faster). The
formula negates the delta so lower combined → rate > 1.0.

**Tempo range rescaling (frontend)**: The Rust `rate_from_14bit` always emits a ±50% rate; the
frontend rescales to the user-configured range (`tempoRange` store in `audioSettings.ts`, default ±20%):
```ts
const delta = (a.value - 1.0) / 0.5;       // recover normalized delta (-1..1) from Rust's ±50% value
const range = get(tempoRange) / 100;         // e.g. 0.20 for ±20%
const scaled = 1.0 + delta * range;          // full fader throw = ±tempoRange%
```
The `tempoRange` setting is persisted via `persistentWritable("cuemark:tempoRange", 20)` and
exposed in the Audio Settings panel (`AudioSettings.svelte`) as a `<select>` with preset values
(±4/6/8/10/16/20/50/100%). The DeckCard rate slider `min`/`max` are reactive to `$tempoRange`
so the UI slider and MIDI fader always agree on range. **Do not change `rate_from_14bit` in Rust**
to implement different ranges — the rescaling lives in `handler.ts` `deck_playback_rate` case.

## Control map

| Physical control | MIDI key | Action |
|---|---|---|
| Play/Pause L | `(0x91, 7)` | DeckPlayToggle deck-0 |
| Play/Pause R | `(0x92, 7)` | DeckPlayToggle deck-1 |
| Cue L | `(0x91, 6)` | CueJump deck-0 |
| Cue R | `(0x92, 6)` | CueJump deck-1 |
| Loop L | `(0x91, 3)` | LoopToggle deck-0 |
| Loop R | `(0x92, 3)` | LoopToggle deck-1 |
| Vinyl/Scratch L | `(0x91, 5)` | SyncToggle deck-0 (apply master BPM / deck BPM rate) |
| Vinyl/Scratch R | `(0x92, 5)` | SyncToggle deck-1 |
| Volume fader L | `(0xB1, 0)` | DeckGain deck-0 (pre-fader trim; crossfader drives DeckVolume) |
| Volume fader R | `(0xB2, 0)` | DeckGain deck-1 |
| Tempo fader L | `(0xB1, 8)` MSB + `(0xB1, 40)` LSB | DeckPlaybackRate deck-0 (14-bit combined; center 8192→1.0×; higher=slower) |
| Tempo fader R | `(0xB2, 8)` MSB + `(0xB2, 40)` LSB | DeckPlaybackRate deck-1 |
| Jog wheel L | `(0xB1, 10)` | JogNudge deck-0 — while playing: relative step → ±2% rate offset from a saved base (see gotcha below), resets after 150ms idle. While paused: audible bidirectional scratch through the PCM feeder branch (`docs/design/pcm-buffer-playback.md`), in one of two modes set by `scratchMode` (default `vinyl`). **Vinyl** accumulates ticks into an absolute position and the feeder servos to it — 1:1 with the hand, silent when the wheel is still (`docs/design/waveform-scrub.md`). **Shuttle** derives a rate from tick velocity (EMA) and free-runs between ticks, for fast searching. ⚠️ `VINYL_SEC_PER_TICK` is uncalibrated — see below. |
| Jog wheel R | `(0xB2, 10)` | JogNudge deck-1 (same dual behavior) |
| Crossfader | `(0xB0, 0)` | Crossfader (deck-0 ↔ deck-1 opacity) |
| Master volume | `(0xB0, 3)` | MasterVolume |
| Headphone volume | `(0xB0, 4)` MSB | CueGain |
| Hot cues L (1–4) | `(0x96, 0–3)` | HotCue deck-0 index 0–3 |
| Hot cues R (1–4) | `(0x97, 0–3)` | HotCue deck-1 index 0–3 |
| Shift + Hot cues L (1–4) | `(0x96, 8–11)` | HotCueSet deck-0 index 0–3 (stamp current time) |
| Shift + Hot cues R (1–4) | `(0x97, 8–11)` | HotCueSet deck-1 index 0–3 (stamp current time) |

**Shift note**: The Starlight handles Shift entirely in firmware — it does not pass a modifier flag
through MIDI. Instead, Shift+pad sends a different note number on the same channel (note += 8). No
host-side shift-state tracking is needed; the shifted notes map directly to `HotCueSet` bindings.

Intentionally unmapped: Bass/Filter button `(0x90,1)`, mode-switch buttons `(0x91,15/16)`.

## The dual-function tone knob (mapped 2026-08-17)

Each deck has **one** knob that acts as either bass or filter, switched by the global
Bass/Filter button. **The controller does the switching in firmware** — the same physical
knob simply sends a different CC — so cuemark tracks **no mode state at all**:

| Physical control | MIDI key | Action |
|---|---|---|
| Tone knob L — bass mode | `(0xB1, 2)` MSB (`34` LSB ignored) | `DeckEqLow` deck-0 → `deck.eq.low`, −24…+12 dB |
| Tone knob L — filter mode | `(0xB1, 1)` MSB (`33` LSB ignored) | `DeckFilter` deck-0 → `deck.filter`, −1…+1 |
| Tone knob R — bass mode | `(0xB2, 2)` MSB | `DeckEqLow` deck-1 |
| Tone knob R — filter mode | `(0xB2, 1)` MSB | `DeckFilter` deck-1 |

Verified live by capturing one knob across a button press:

```
0xB1 d1= 2  d2=63,2,0,38,64,106      ← knob sweeping (fine on CC 34)
0x90 d1= 1  d2=127 → d2=0            ← Bass/Filter button, momentary
0xB1 d1= 1  d2=127,96,73,63,32,15,0  ← same knob, different CC (fine on CC 33)
```

🛑 **Do not map `(0x90,1)` and do not track the mode host-side.** Both modes are already
bound, so the button needs no host action — exactly like Shift `(0x90,3)`. The button is
*momentary* (127 press / 0 release) and never reports which mode it selected, so any
host-side guess drifts out of sync with the hardware after a reconnect and the knob then
silently drives the wrong control.

Knob→value mapping lives in Rust (`knob_to_eq_db` / `knob_to_filter` in `midi.rs`), unlike
the tempo fader's range rescaling, because the EQ range is not user-configurable. Centre
is snapped to neutral (`KNOB_CENTRE_SNAP`): the pot has no detent, so without it "off"
is a position the user cannot actually select. See `docs/design/deck-eq-and-filter.md` §6.

⚠️ **cuemark holds the *raw ALSA device* exclusively — but not the sequencer port.**
`amidi -p hw:1,0,0 -d` fails with "Device or resource busy" while the app runs, and the
first such attempt in a session can look like a *silent* empty capture rather than an
error. That is a fact about `hw:1,0,0`, and it was over-generalised here until 2026-08-17:
`midir` connects through the **ALSA sequencer**, which is multi-subscriber. Verified that
day — two cuemark instances were connected to the one Starlight at the same time, both
receiving, neither disturbed:

```
client 20: 'DJControl Starlight' [type=kernel,card=1]
    0 'DJControl Starlight MIDI 1'
        Connecting To: 128:0, 129:0     ← two cuemark clients, both live
```

So a second instance *can* be driven headlessly to check MIDI behaviour while the user's
app keeps running (see "Injecting synthetic MIDI" below), and `aseqdump -p 20:0` is a
perfectly good second opinion on what the hardware is sending. Only `amidi -d` is blocked.

Reading the app's own log still works and needs no extra process:
```bash
tail -n0 -f ~/.local/share/com.cuemark.app/logs/cuemark.log | grep --line-buffered -a '\[midi\]'
```
⚠️ but **continuous controls are throttled to one line per 500ms per key** there, so a jog
wheel spinning at ~131 msg/s prints a tidy ±1 twice a second. For anything where the *rate*
or the *distinct values* matter, use the MIDI monitor below instead — that is what it is for.

## Raw MIDI monitor (built 2026-08-17)

**Toolbar → MIDI.** A live, unthrottled table of every message arriving on the port, mapped
or not, plus port enumeration and a capture export. `src/components/MidiMonitor.svelte` +
`midi_monitor_set` / `midi_list_ports` / `midi_capture_save` in `midi.rs`. Design and the
role it plays in controller work: `docs/design/controller-mapping.md` §7a.

It replaces the old "add an `eprintln!` to the MIDI callback and recompile" procedure
entirely — that meant a Rust rebuild per iteration, and it printed into the same throttled
stream that hides the interesting part.

| Column | What it answers |
|---|---|
| `ctrl` | `STATUS:D1` in hex — the map key, in the exact form `hercules_starlight_map()` uses |
| `d2` / `range` / `values` | Is this a button, a full-travel fader, or an encoder that only ever sends ±1? |
| `msg/s` | Live rate over the last 32 messages — *not* a lifetime average, which reads ~0 for a wheel spun a minute ago |
| `guess` | A hedged shape hint (see the caution below) |
| `mapped to` | The `ControlBinding` debug form, deck id included — a binding on the **wrong deck** reads as wrong here, not merely as "mapped" |

Rows sort most-recently-touched first, so wiggling a control makes it jump to the top. That
is the whole interaction model for identifying an unknown surface.

🛑 **The `guess` column is a hint from what has arrived so far, never a conclusion.** A fader
only nudged looks like an encoder; an encoder spun one way looks like a fader stuck at one
end. Move a control through its whole travel before believing its row, and settle the
questions that actually matter — encoder deltas, firmware-vs-host modes — with the capture
procedures in `docs/design/controller-mapping.md` §8, not by reading this table.

Two properties worth knowing before trusting it:

- **The raw feed is gated off unless the panel is mounted.** Mounting turns it on,
  unmounting turns it off (`[midi] raw monitor ON`/`off` in the log says which). Two jog
  wheels alone deliver ~260 msg/s and every emit crosses the GTK main thread — the same
  thread every audio IPC call uses. Monitoring is a bench activity, not a performance one;
  don't leave the panel open during a set.
- **It emits before every filter**, including the `msg.len() < 3` guard the mapping loop
  applies. A 2-byte message (program change, and anything else a controller does that the
  mapper cannot handle) is visible here and nowhere else. Confirmed by injection —
  `C0 05` appears in the monitor and is correctly absent from the action path.

**Save capture** writes `~/.local/share/com.cuemark.app/midi-captures/capture-<epoch>.json`
— `{t, bytes, len}` per message. That is a replayable fixture: the intent
(`controller-mapping.md` §9) is to feed one through the resolver in a test and assert an
action sequence, so profile work can happen without the controller attached.

## Injecting synthetic MIDI into a running cuemark

Because the sequencer port is multi-subscriber (above), a known byte sequence can be pushed
into a live app — no hardware, no hands. This is how the monitor was verified end to end on
2026-08-17.

```bash
aconnect -l | grep -A2 "client.*cuemark"    # find the client; note the PID on each
# 🔴 With two instances running there are TWO cuemark clients. Match the pid — connecting to
#    the wrong one drives the user's live app instead of the one under test.
aconnect 14:0 129:0                          # Midi Through -> the instance under test
aplaymidi -p 14:0 probe.mid                  # anything sent to Midi Through now arrives
aconnect -d 14:0 129:0                       # ALWAYS undo it; the route outlives the test
```

`aplaymidi` needs a standard MIDI file, which is ~30 lines of `struct.pack` to generate (an
SMF-0 header plus varlen-delta events) — keep the generator in the scratchpad, it is a
fixture and not worth committing.

⚠️ **Injected messages take the real path**, so a *mapped* key really does toggle the deck.
Pick unmapped keys for shape tests, and for a mapped one pick something self-cancelling
(sending `91 03 7F` twice returns `deck.loop` to where it started).

Phase 2 goal: MIDI learn mode — the binding half, deliberately scheduled *after* a second
controller profile exists. `docs/design/controller-mapping.md` §7 has the reasoning and the
phase order.

## Jog-wheel gotchas (fixed 2026-07-21 — see `skills/run-app/SKILL.md` "MIDI audio lag" for detail)

Two real bugs were found in `jog_nudge`'s "while playing" branch (`handler.ts`), both worth
checking for in any similar nudge-style continuous control:

1. **Rate compounded instead of bounding**: the nudge offset was computed from the live
   `d.playbackRate` (already includes previous ticks) instead of the saved `jogBaseRate[deckId]`
   captured at gesture start. A sustained spin ran the rate to its 0.25–4.0 clamp in under a
   second — audible pitch runaway plus soundtouch buffer stress.
2. **Synchronous `updateDeck()` per tick**: unlike every sibling continuous control in the same
   switch statement, jog_nudge wasn't routed through `queueDeckPatch()` — a sustained spin
   saturated the JS thread with full Session/Deck rebuilds, freezing the UI while GStreamer
   audio (separate Rust thread) kept playing.

**Also learned while debugging this**: don't infer real MIDI event rate from log line counts —
continuous controls are log-throttled to 1 line/500ms per key (`midi.rs`) but dispatch to the
frontend unthrottled. See `skills/audio-debugging/SKILL.md` "MIDI log throttle" for the full trap
and how to get a real count instead.

## Adding or re-calibrating a MIDI controller

⚠️ **`run_midi_loop` opens exactly one port, matched by name substring at startup, and never
rescans** — plug the controller in *before* launching. If nothing matches it logs the
available ports and the listener thread simply returns; there is no retry. Making this
multi-port and hotplug-capable is phase 1 of `docs/design/controller-mapping.md`.

1. Open **Toolbar → MIDI** and wiggle each physical control. No rebuild, no debug print —
   every message shows up, mapped or not, and rows sort by most-recently-touched.
2. `ctrl` is `STATUS:D1`, and `STATUS` is the **full status byte** — high nibble = message
   type (`0x90`=Note On, `0xB0`=CC), low nibble = MIDI channel. Keep the full byte as the map
   key; do **not** mask off the channel nibble — DJ controllers use different channels for
   left/right decks.
3. 14-bit CC pairs: the monitor flags a `partner CC N+32 seen` when both halves have been
   touched. Map the MSB and ignore the LSB — except the **tempo fader**, where the MSB barely
   moves and both are needed (see the channel-layout section above).
4. **Capture across any mode button before mapping the controls it affects.** The Starlight's
   Shift and Bass/Filter buttons swap which note/CC a control sends, entirely in firmware, so
   both modes are just more rows and the host tracks nothing. Whether a given controller does
   that is a *measurement*, not an assumption — press the mode button with the monitor open
   and see whether the same physical control changes its `ctrl` key. If it does not, the mode
   is host-tracked and that is a code feature, not a mapping entry
   (`docs/design/controller-mapping.md` §6).
5. Add entries to `hercules_starlight_map()` (or a new `foo_map()` function) using
   `(status, d1)` as the key.
6. **Save capture** before you close the panel, so the session's raw bytes survive as a
   fixture rather than as a memory of what the table said.

## ⚠️ Open: calibrate `VINYL_SEC_PER_TICK` (needs the controller)

Vinyl-mode jog now maps encoder ticks to an absolute position rather than to a rate
(`handler.ts` `jog_nudge` → the scrub bus in `seekBus.ts` → `scratch_to()` in
`pipeline.rs`; rationale in `docs/design/waveform-scrub.md`). The scale constant
`VINYL_SEC_PER_TICK` in `handler.ts` is currently a **placeholder** (`0.0045`).

The measurement also has to settle a correctness question, not just pick a number. A
comment on `SCRATCH_MODE_PARAMS.shuttle` suspects the Starlight encoder "reports larger
step values, not just ±1, as physical speed increases." If those values are deltas
accumulated since the previous message (standard for relative CC encoders) accumulation is
exact and the design is right as built; if they are genuinely speed-scaled, a single scale
constant cannot be correct.

Procedure — **plug the controller in before launching the app**, `midir` enumerates at
startup:

1. Log raw `JogNudge` values (`a.value`) from the vinyl branch of `jog_nudge`.
2. Rotate one jog wheel exactly one full revolution **slowly**; sum `|value|`.
3. Repeat the same revolution **quickly**; sum again.
4. **Equal totals** → accumulation is exact; set `VINYL_SEC_PER_TICK = 1.8 / total`
   (33⅓rpm = 1.8s per revolution).
   **Unequal totals** → the constant alone cannot be right; revisit
   `docs/design/waveform-scrub.md` before shipping the jog change.

Then check by ear: slow cue-hunting should track the wheel 1:1, go silent when the wheel
stops, and never jump — including across pauses longer than `SCRATCH_IDLE_MS` (500ms),
which is the teardown/restart path `last_scratch_frame` now covers.
