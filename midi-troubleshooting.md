# MIDI Troubleshooting — Hercules DJControl Starlight

Running log of issues found, fixes applied, and things still to verify.
Debug logging is currently ON in `src-tauri/src/midi.rs` (the `eprintln!` block in the callback).

---

## Issue 1: Sync button toggled Loop in the UI

**Symptom:** Pressing the physical Vinyl/Scratch (Sync) button toggled the UI loop indicator instead of applying BPM sync.

**Root cause:** Note numbers 3 and 5 were swapped in the initial calibration. The CLAUDE.md originally documented:
- Loop L: `(0x91, 5)`
- Vinyl/Scratch L: `(0x91, 3)`

Hardware confirmed (by observed behavior) the reverse:
- Loop L: `(0x91, 3)`
- Vinyl/Scratch (Sync) L: `(0x91, 5)`

**Fix applied:** Swapped in `hercules_starlight_map()` and updated CLAUDE.md.

**Status:** ✅ Believed fixed — needs live verification.

---

## Issue 2: BPM Sync formula inverted

**Symptom:** Pressing Sync (MIDI or UI button) slowed the deck down instead of speeding it up to match master BPM.

**Root cause:** Formula was `deck.bpm / masterBpm`. If deck=100 BPM and master=120 BPM, this gives 0.83× (slows down). Correct is `masterBpm / deck.bpm` = 1.2× (speeds up to match).

**Fix applied:** Corrected in both `src/lib/midi/handler.ts` (sync_toggle case) and `src/components/DeckCard.svelte` (Sync button onclick + tooltip).

**Status:** ✅ Fixed in code — needs live verification.

---

## Issue 3: Jog wheel only seeked forward (both directions)

**Symptom:** Spinning the jog wheel CCW caused fast-forward instead of reverse nudge.

**Root cause:** Two's complement decoding bug. MIDI data bytes are 7-bit (0–127). The code did `data2 as i8 as f32`, but:
- `127u8 as i8 = +127` (positive — fits in i8's positive range)
- Correct 7-bit two's complement: values ≥ 64 are negative (127 → -1, 64 → -64)

So CCW (value 127) was treated as +127 steps → rate clamped to 4.0 (maximum fast-forward).

**Fix applied:** In `resolve_action` for `JogWheel`:
```rust
let step = if data2 >= 64 { data2 as i32 - 128 } else { data2 as i32 };
```

Also changed jog wheel to emit a new `JogNudge` action (distinct from `DeckPlaybackRate`) so the frontend can restore the pre-jog rate 150ms after spinning stops. See `src/lib/midi/handler.ts` (`jogBaseRate`, `jogTimers`).

**Status:** ✅ Fixed in code — needs live verification.

---

## Issue 4: Tempo fader — rate stuck, seeking, play/pause broken

**Symptom:**
- Moving the tempo slider changed the Rate display, but rate was stuck at ~1.016× regardless of how far the slider moved.
- Moving the slider appeared to seek the track position.
- Play/pause became unreliable while the slider was being moved.

### Sub-issue 4a: 14-bit CC not combined (rate stuck)

**Debug output captured:**
```
[midi] CC      ch03  status=0xB2  d1=  8  d2= 66   → DeckPlaybackRate 1.015625
[midi] CC      ch03  status=0xB2  d1= 40  d2= 18   → (unmapped)
[midi] CC      ch03  status=0xB2  d1=  8  d2= 66   → DeckPlaybackRate 1.015625
[midi] CC      ch03  status=0xB2  d1= 40  d2= 37   → (unmapped)
[midi] CC      ch03  status=0xB2  d1=  8  d2= 66   → DeckPlaybackRate 1.015625
[midi] CC      ch03  status=0xB2  d1= 40  d2= 56   → (unmapped)
```

**Analysis:** The Starlight sends the tempo fader as a 14-bit CC pair:
- CC 8 (MSB/coarse): barely changes — stuck at 66 for small slider movements
- CC 40 (LSB/fine): changes on every movement — this is where the real data is

We were only reading CC 8. For small slider movements the MSB never changes, so rate was frozen.

**Fix applied:**
- Added `DeckPlaybackRateLsb` binding variant in `ControlBinding`.
- Mapped `(0xB1, 40)` and `(0xB2, 40)` as `DeckPlaybackRateLsb` in the Starlight map.
- In `run_midi_loop`, the closure owns `cc14_msb` and `cc14_lsb` HashMaps keyed by `(status_byte, msb_cc_num)`.
- Added `rate_from_14bit(msb, lsb)`: `combined = (msb << 7) | lsb`; center = 8192 (MSB=64, LSB=0); rate = 1.0 + (combined−8192)/8192 × 0.5.
- On CC 8: cache MSB, combine with last known LSB, emit rate.
- On CC 40: cache LSB under MSB key `(status, cc−32)`, combine with last known MSB (default 64), emit rate.

**Status:** ✅ Fix applied — not yet tested.

### Sub-issue 4b: play/pause broken while slider moves

**Analysis:** The `$effect` in `App.svelte` re-ran `syncVideoElements` on every session change, including every MIDI CC event. `syncVideoElements` checks `deck.playing` vs `v.paused` and calls `v.play()` or `v.pause()`. With CC 40 firing rapidly, multiple async `v.play()` promises could be in flight simultaneously, causing race conditions where a play call was interrupted by a concurrent pause check.

**Fix applied:** `syncVideoElements` is now deferred via `queueMicrotask`. Multiple session changes within the same microtask window share a single deferred `syncVideoElements` call (using the latest settled state). `compositor.syncDecks()` (WebGL FBO allocation) still runs synchronously inside the effect.

**Status:** ✅ Fix applied — not yet tested.

---

## Outstanding unknowns

### Tempo fader center value
- Direction confirmed inverted: higher CC values = negative pitch (slower). `rate_from_14bit` is now negated.
- Center (CC 8 = 64, 14-bit = 8192) still assumed. **To verify:** Move slider to physical center detent, confirm rate reads 1.0×.
- Full throw values (top/bottom) not yet captured to confirm ±50% range is calibrated correctly.

### Volume fader 14-bit
- Volume fader (CC 0 + CC 32) is also a 14-bit pair but currently only the MSB (CC 0) is read.
- For volume the fine byte matters less (0–1 range with 128 steps is adequate), but if small movements don't register, the same fix applies.
- **To verify:** Move volume fader slightly and check if CC 32 carries the movement data.

### Jog wheel — rate persistence
- After jog spin stops, rate resets to pre-jog value after 150ms (the `jogBaseRate`/`jogTimers` mechanism in `handler.ts`).
- If the tempo fader is set away from 1.0×, the jog nudge will reset to 1.0× (not back to the fader position), because there is no separate "tempo fader position" field in the model.
- **Accepted limitation for now.** Future fix: store `basePlaybackRate` separately in Deck model; tempo fader writes there; jog nudge temporarily offsets from it.

### Sync/Loop note swap — needs live confirmation
- The swap (note 3 = Loop, note 5 = Sync) was inferred from observed behavior, not from a raw MIDI dump of those buttons.
- **To verify:** With debug logging on, press the physical Loop button and confirm it emits note 3. Press Vinyl/Scratch and confirm note 5.

---

## How to re-enable/disable debug logging

Debug `eprintln!` block is in `src-tauri/src/midi.rs` inside the `midi_in.connect` callback. Look for the comment `// DEBUG:`. Remove or comment out the block when no longer needed.

When reading debug output, the key columns are:
- `status=0xNN` — full status byte: high nibble = message type (`0x90`=NoteOn, `0xB0`=CC), low nibble = MIDI channel
- `d1=NNN` — data byte 1: note number (for NoteOn) or CC number (for CC)
- `d2=NNN` — data byte 2: velocity (NoteOn) or CC value (CC)
- Second line: `=> ActionName` if mapped, `(unmapped)` if not

---

## Files changed

| File | What changed |
|---|---|
| `src-tauri/src/midi.rs` | Note swap (3↔5 for loop/sync), jog 7-bit fix, JogNudge action, DeckPlaybackRateLsb binding, 14-bit CC combination, debug logging, **tempo direction negated** |
| `src/lib/midi/handler.ts` | BPM sync formula (masterBpm/deck.bpm), jog_nudge handler with rate reset |
| `src/components/DeckCard.svelte` | BPM sync formula and tooltip |
| `src/App.svelte` | syncVideoElements: **rAF throttle** (was microtask) + **playPromises guard** against overlapping play() calls |
| `src/components/WaveformCanvas.svelte` | **waveform-canvas CSS moved into scoped style block** (was global app.css — canvas wasn't filling wrap) |
| `src/app.css` | Removed .waveform-canvas rule (now in component) |
| `CLAUDE.md` | Control map updated (note numbers, sync formula description) |
