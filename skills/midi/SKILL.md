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
| Jog wheel L | `(0xB1, 10)` | JogNudge deck-0 — while playing: relative ±1 step → ±2% rate offset from a saved base (see gotcha below), resets after 150ms idle; while paused: scrubs track position (±0.015s/step, rAF-throttled seek) for finding a beat. Paused scrubbing is currently silent — see `docs/design/jog-scratch-audio.md` for the (not yet implemented) bidirectional scratch-audio design. |
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

Intentionally unmapped: Bass/filter toggle `(0x90,1)`, mode-switch buttons `(0x91,15/16)`.

Phase 2 goal: MIDI learn mode (click control in UI, wiggle knob to map).

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

1. Add a one-line debug print inside the MIDI callback in `midi.rs` (before the map lookup):
   ```rust
   eprintln!("[midi] raw: msg[0]=0x{:02X} d1={} d2={}", msg[0], msg[1], msg[2]);
   ```
2. Run `cargo tauri dev` and wiggle each physical control. The terminal shows the raw bytes.
3. `msg[0]` is the **full status byte** — high nibble = message type (`0x90`=Note On, `0xB0`=CC),
   low nibble = MIDI channel. Keep the full byte as the map key; do **not** mask off the channel
   nibble — DJ controllers use different channels for left/right decks.
4. Identify 14-bit CC pairs: if two CC messages fire together where `d1_B = d1_A + 32`, the coarse
   (MSB) is `d1_A` and the fine (LSB) is `d1_B`. Map the MSB and ignore the LSB.
5. Add entries to `hercules_starlight_map()` (or a new `foo_map()` function) using `(msg[0], d1)` as
   the key.
6. Remove the debug print when done.
