# Controller mapping — many controllers, one control surface

Status: 📐 **DESIGN, with phase 3 built.** Written 2026-08-17, prompted by a
**Pioneer DJ DDJ-FLX4** on order. The raw MIDI monitor (§7a) was built and verified the
same day — see the status note in §7. Everything else here is unbuilt. No FLX4 has been
plugged in yet, so every claim below about that specific device is marked ❓ and must be
captured before it is designed against — see §8, which is the part to read first when the
box arrives.

The Starlight mapping as it stands is not wrong; it is *singular*. Every layer assumes
exactly one controller, known at compile time, with the Starlight's specific encodings baked
in at four different levels. This doc is about what has to become data, what has to stay
code, and where the seam between them goes.

---

## 1. What exists today

```
midir port scan  ──►  hercules_starlight_map(): HashMap<(status,d1), ControlBinding>
   (substring match          │
    "hercules"/"starlight",  │  run_midi_loop closure
    first hit, once,         ▼
    at startup)        resolve_action(binding, data2) ──► MidiAction  ──emit──►  handler.ts
                             │                                                      │
                       knob_to_eq_db / knob_to_filter /                       midiDeckId() remap
                       rate_from_14bit / two's-complement jog                 + musical semantics
                             │                                                (tempoRange rescale,
                       persist_kv ──► midi_state.json                          jog scratch modes,
                                                                               grid quantize, …)
```

Five properties of that pipeline are load-bearing for the Starlight and blocking for
anything else:

1. **One port, one map, chosen once.** `run_midi_loop` matches a port name substring, takes
   the first hit, and if nothing matches it logs the available ports and *returns `Ok(())`* —
   the listener thread simply ends. There is no rescan, so plugging a controller in after
   launch does nothing until the app restarts (`skills/midi/SKILL.md` already tells the user
   to plug in first; that instruction is the bug, written down).
2. **The map is a function, not data.** Adding a controller means editing Rust and
   recompiling. Two controllers means two functions and a selector.
3. **Deck identity is baked into every binding.** `ControlBinding::DeckGain { deck_id:
   "deck-0" }` — the *hardware surface's* left side is spelled as a software deck ID, and
   `midiDeckId()` in `handler.ts` un-bakes it at the far end. That indirection is the right
   idea in the wrong place, and it has exactly two slots. The FLX4 has a deck 1/3, 2/4
   switch. ❓
4. **Encodings are hardcoded in the loop body.** `run_midi_loop` knows that a 14-bit pair's
   LSB is `MSB + 32`, and `resolve_action` knows a jog wheel is 7-bit two's complement.
   Both are Starlight facts asserted as universal facts.
5. **There is no MIDI output.** `midir`'s `MidiOutput` is never constructed. No LEDs, ever.
   The Starlight lights itself; a Pioneer surface largely does not. ❓

And one property that is *not* obvious from the code:

6. **The value-mapping seam is in three places and has no rule.** `rate_from_14bit` produces
   a rate in Rust and `handler.ts` immediately reverse-engineers the delta back out of it to
   rescale for `tempoRange`. `knob_to_eq_db` produces dB in Rust and the frontend passes it
   through. Jog ticks become steps in Rust and acquire their entire meaning (vinyl vs
   shuttle, position vs velocity) in the frontend. Each individual decision was argued and
   is defensible; collectively there is no line, so "where does this new control's maths go"
   has no answer for the next controller. §4 proposes the line.

---

## 2. What the FLX4 changes, structurally

Not "one more map". It exercises dimensions the current design has no representation for at
all. Each of these is ❓ until captured (§8), but each is a *category* the design must be
able to express even if a detail turns out different:

| Dimension | Starlight | FLX4 (expected ❓) | Current model can express it? |
|---|---|---|---|
| Deck slots per side | 1 | 2 (deck 1/3, 2/4 switch) | ❌ two hardcoded IDs |
| EQ bands | 1 (dual-function knob) | 3 + filter, per channel | ⚠️ only `DeckEqLow` exists as an action |
| Pads | 4/deck, one shift layer | 8/deck × several pad modes | ⚠️ only if modes are firmware-side |
| Jog | rotation only, ±1 CC | rotation **+ capacitive touch** | ❌ no touch concept — scratch-vs-bend is inferred from `deck.playing` |
| LED feedback | self-managed | host-driven | ❌ no output port |
| Audio interface | none (Starlight is a separate USB card here) | built-in, master + cue | n/a for MIDI, but see §8.6 |

The jog row is the interesting one. Cuemark currently decides "scratch or pitch-bend?" by
reading `d.playing` — a *software* state standing in for a physical one. The FLX4 reports
the physical one directly (platter touched or not), which is strictly better information and
is what every other DJ app uses. That is not a mapping-table entry; it is a new binding kind
(`JogTouch`) plus a rule about which signal wins when a controller offers both. The design
must leave room for it without making the Starlight path worse — the Starlight has no touch
sensor and must keep inferring.

---

## 3. Profiles as data

**A controller profile is a data file, not a function.** Ship the known ones in-tree
(`profiles/hercules-starlight.toml`, `profiles/pioneer-ddj-flx4.toml`), load user ones from
the app data dir, and let a user profile with the same id shadow a built-in one.

Sketch — the shape matters more than the syntax:

```toml
id      = "pioneer-ddj-flx4"
name    = "Pioneer DJ DDJ-FLX4"
# Port-name patterns, case-insensitive substring, first profile whose pattern matches wins.
# A list because ALSA/JACK/CoreMIDI spell the same device differently.
match   = ["ddj-flx4", "flx4"]
# How many deck slots this surface addresses. The session maps slot → software deck.
slots   = 4

[[control]]
status = 0x90            # full status byte — channel is NOT masked (see §3.1)
d1     = 0x0B
kind   = "button"        # momentary | toggle | button
action = "play_toggle"
slot   = 0

[[control]]
status = 0xB0
d1     = 0x1F
kind   = "fader14"       # implies lsb_d1 = d1 + 32 unless lsb_d1 is given
lsb_d1 = 0x3F            # explicit, because "+32" is a convention, not a rule
action = "tempo"
slot   = 0
invert = true            # Starlight and Pioneer disagree about which end is fast

[[control]]
status = 0xB0
d1     = 0x22
kind   = "relative"      # encoding = how a delta is spelled on the wire
encoding = "twos7"       # twos7 | offset64 | binary_offset | twos14
action = "jog_turn"
slot   = 0

[[control]]
status = 0x90
d1     = 0x36
kind   = "button"
action = "jog_touch"     # the FLX4's capacitive platter; absent on the Starlight
slot   = 0
```

Three deliberate choices in there:

**3.1 — The full status byte stays the key.** Channel-per-deck is near-universal on DJ
controllers and masking it is the documented way to break the Starlight. Profiles keep
`(status, d1)` as the identity of a control, exactly as today.

**3.2 — `slot`, not `deck_id`.** A profile describes a *surface*, and a surface has slots.
Nothing in a profile may name a software deck; that binding lives in the session
(`Session.midiMapping`, generalised from `{left, right}` to a slot→deckId array). This is
what keeps the N-deck guarantee intact — a 4-slot controller on a 6-deck session is then a
routing question, not a mapping question, and the FLX4's deck 1/3 switch is a *slot* change,
not a remap. If the switch turns out to be firmware-side (the pads and knobs simply start
sending a different channel), it needs no host state at all and slots 2/3 are just more
rows in the table. ❓ Capture it before assuming either way — this is the tone-knob question
again (§8.3).

**3.3 — `encoding` is named, never inferred.** Today `resolve_action` hardcodes 7-bit two's
complement for jogs and `run_midi_loop` hardcodes `LSB = MSB + 32`. Both become fields.
Relative-encoder spellings in the wild are few and well known (two's complement, offset-64,
binary-offset), so this is a closed enum, not a scripting language — see §6 for the line
this deliberately does not cross.

---

## 4. The seam: decoding is Rust, meaning is TypeScript

The rule this design adopts, and the reason it is worth a small refactor:

> **Rust turns wire bytes into a normalized, hardware-neutral signal. TypeScript turns a
> normalized signal into a musical action.** Nothing that varies with a *user setting* is
> computed in Rust; nothing that varies with a *controller* is computed in TypeScript.

Applied to what exists:

| Today | Under the rule |
|---|---|
| `rate_from_14bit` → a rate `1.0 + delta*0.5`; `handler.ts` divides by 0.5 to recover the delta and rescales by `tempoRange` | Rust emits `delta ∈ −1…+1`. Frontend applies `tempoRange`. The round-trip through a fictional ±50% rate disappears. |
| `knob_to_eq_db` → dB, in Rust, "because the range isn't user-configurable" | Rust emits `bipolar ∈ −1…+1`. Frontend maps to `EQ_MIN_DB…EQ_MAX_DB`. The range stops being user-configurable *by accident of where the code sits* and starts being a frontend constant that could become a setting. |
| `knob_to_filter` → −1…+1 | Unchanged. It was already normalized; it just looked like an exception. |
| `KNOB_CENTRE_SNAP` | Stays in Rust, and becomes a **per-profile** field. It is a fact about a pot with no detent — a hardware property. A controller with a centre-detented knob wants it at 0. |
| Jog ticks → `JogNudge { value: steps }` | Unchanged in shape, but `encoding` comes from the profile instead of being assumed. |

Why this seam and not "all mapping in the frontend": the raw event rate is high (measured
~131 msg/s per jog wheel, and that is *one* control), the port is held by a Rust thread
already, log throttling and `persist_kv` live there, and pushing every raw byte over IPC to
be classified in JS puts controller decoding behind the same main thread this project has
repeatedly starved. Decoding is cheap, allocation-free, and testable in Rust; keep it there.

Why not "all mapping in Rust": the musical semantics are already in TypeScript and are
*entangled with app state* — grid quantize, scratch modes, `syncLocked`, the rAF patch
queue. Moving those into Rust would be a much larger change with no benefit to this goal.

⚠️ **This refactor changes numbers on the wire between Rust and the frontend.** `DeckEqLow`
currently carries dB and `DeckPlaybackRate` carries a rate; after the change they carry
normalized values. Anything that reads them — `persist_kv`'s saved `midi_state.json` keys
included — moves with them, or a restored session comes back with an EQ 24× too quiet.
The saved-state file needs either a version field or a one-time key rename.

---

## 5. Discovery, hotplug, and holding several ports

Replace "find one port by substring, or give up" with:

1. **Enumerate all input ports** at startup and every ~2s thereafter (`midir` has no hotplug
   notification; polling `midi_in.ports()` and diffing names is the standard approach and is
   cheap).
2. For each *new* port, pick the first profile whose `match` patterns hit the port name.
   Unmatched ports are logged once and left alone — not opened. A DAW keyboard plugged into
   the same machine must not start toggling decks.
3. Open a connection per matched port, keyed by port name, and hold them in a map. On
   disappearance, drop the connection and log it.
4. **Two controllers can be live at once**, and this must actually work rather than being an
   accident: the FLX4 and the Starlight both mapping slot 0 to `deck-0` is a *reasonable*
   configuration (one on the table, one in the bag), and slot assignment is per-connection,
   so it is also possible to give them different decks.

Two hazards worth writing down before they are hit:

- **Port names are not stable across replug** on ALSA (`hw:1,0,0` style indices move). Match
  on the descriptive part, not the numbers — the current substring approach is already right
  about this and should be preserved.
- **cuemark holds the port exclusively** (`skills/midi/SKILL.md`: `amidi` fails with "Device
  or resource busy" while the app runs, and the first attempt can look like a *silent empty
  capture* rather than an error). With hotplug this gets worse, not better: the app will grab
  a controller the moment it appears, including one plugged in specifically to capture from.
  §7's in-app monitor is the answer, and it is why that comes before learn mode.

---

## 6. Where this design stops

A profile is a **table of controls with a closed set of kinds and encodings**. It is
deliberately not:

- a scripting language (Mixxx-style JS mappings),
- a place to express conditional behaviour ("if shift held, then…"),
- a place to express modes the host must track.

The Starlight taught the reason directly: its Shift and Bass/Filter buttons are handled *in
firmware*, sending different notes/CCs, and `midi.rs` carries a 🛑 comment explaining that
tracking mode host-side would drift out of sync after a reconnect because the button is
momentary and never reports which mode it selected. **Firmware-side modes are just more rows
in the table.** Host-side modes are a state machine, and a state machine belongs in code with
tests, not in a data file.

If the FLX4's pad modes turn out to be host-tracked ❓, the honest answer is a *code* feature
(a small explicit mode layer with a defined power-on state and a resync story), not a
`[[mode]]` section in TOML. Do not discover this by writing the TOML section first.

---

## 7. MIDI learn — is now the right time?

**Half of it, yes. The binding UI, not yet — and the ordering is the whole answer.**

Split what "learn mode" usually means into two features that have very different value right
now:

**7a. Raw MIDI monitor — 🟢 BUILT 2026-08-17.** Toolbar → MIDI;
`src/components/MidiMonitor.svelte`, `midi_monitor_set`/`midi_list_ports`/`midi_capture_save`
in `midi.rs`. Operating notes and the mapping workflow now live in `skills/midi/SKILL.md`.

Verified end to end by **injecting synthetic MIDI into a driven second instance** rather
than by hand on the controller — the ALSA *sequencer* port turns out to be multi-subscriber
even though the raw `hw:` device is not, so a headless instance can be driven while the
user's app keeps running (recipe in the skill). The fixture exercised each claim this
section makes: an unmapped full-travel CC, an unmapped ±1-only CC, a `+32` partner pair in
both directions, a mapped note resolving to `LoopToggle { deck_id: "deck-0" }`, and a
**2-byte program change** — which appears in the monitor and correctly does not reach the
action path, confirming the emit really does sit ahead of the `len < 3` filter. The capture
export round-tripped to disk with `len: 2` preserved on that message.

Two things it does **not** yet answer, both awaiting hardware: no message has been observed
from a real controller through this panel (the Starlight was attached and connected, but
untouched), and the `guess` column's heuristics have only been exercised against synthetic
values chosen to trigger them. Treat the column as the hedge it is labelled with.

The reasoning that motivated it:
Rust already logs every message including unmapped ones; it just throttles continuous
controls to one line per 500 ms per key, which is precisely the data an unknown jog wheel
needs (this trap already cost this project once — see the `vinylTally` comment in
`handler.ts`, which exists solely because the Rust logger hides the real tick rate). Emit an
unthrottled `midi-raw` event and render it in a settings panel: status, d1, d2, channel,
rate, and whether it currently resolves to an action. That panel is what makes authoring the
FLX4 profile tractable at all — it is ~100 controls against the Starlight's ~30, and the
current workflow is tailing a log file that deliberately drops the interesting parts.
It also sidesteps the exclusive-port problem in §5.

**7b. Click-a-control-then-wiggle binding UI — build this *after* the FLX4 profile exists.**
Not because it is hard, but because building it now means designing an abstraction against
N=1. The FLX4 is the forcing function that reveals whether the profile schema is right; a
learn UI written first would encode today's assumptions into a persisted user-facing format
and then have to break it. Concretely, learn mode *cannot infer* the things §3.3 makes
explicit — it sees a CC move and cannot tell 7-bit-two's-complement from offset-64 from the
MSB of a 14-bit pair without either several heuristic samples or the user being asked. So
learn mode needs the profile schema to exist and be correct before it can write into it.

Which yields the order:

| Phase | Work | Gate to start |
|---|---|---|
| **1** | Profiles as data; port the Starlight map verbatim to TOML; slot→deck routing; hotplug/multi-port | now — no hardware needed |
| **2** | Normalized-signal refactor (§4), incl. `midi_state.json` migration | with phase 1, same change ideally |
| **3** | Raw MIDI monitor panel (`midi-raw`, unthrottled) — 🟢 **done 2026-08-17** | — |
| **4** | Author the FLX4 profile by hand from captures (§8) | FLX4 in hand |
| **5** | Learn-mode binding UI writing user profiles | phase 4 done — schema proven against 2 devices |
| **6** | MIDI output / LEDs | after 4; FLX4 is the device that needs it |

Phase 1+2 is the only part that is worth doing *before* the box arrives, and it is worth
doing then precisely because the second profile is what proves it. Porting the Starlight to
TOML with no second consumer is a refactor with no test; the FLX4 arriving one week later
is the test.

---

## 8. ❓ Capture before designing — the FLX4 unknown list

**Every row here is unverified.** The standing rule from the tone-knob work applies with
full force: *a terse doc phrase naming a physical control is a label, not a spec.* Capture
with the monitor (§7a), across the mode change, before writing a single profile row.

1. **Does it enumerate as class-compliant MIDI on Linux at all, and in what mode?** Some
   Pioneer units need a button held at power-on to leave their host-software mode. Check
   `aconnect -l` / `amidi -l` before the app touches it.
2. **Jog encoding, and whether ticks are plain ±1 deltas.** Run the existing calibration
   procedure verbatim — `docs/design/waveform-scrub.md`'s `[jog-cal/…]`: one revolution
   slowly, one quickly, compare `absSum`. Equal ⇒ deltas, accumulation exact, and
   `VINYL_TICKS_PER_REV` gets an FLX4 value. Unequal ⇒ speed-scaled, and a single scale
   constant cannot be correct for it. This is a *per-controller* constant the moment there
   are two controllers, so it moves into the profile either way.
3. **Pad modes: firmware-side or host-tracked?** Capture one pad across a pad-mode button
   press, exactly as the Bass/Filter knob was captured (`skills/midi/SKILL.md` shows the
   capture and what the answer looked like). Different note per mode ⇒ table rows, no host
   state, done. Same note per mode ⇒ §6 applies and it becomes a code feature.
4. **Deck 1/3, 2/4 switch: does the surface change channel, or does it expect the host to
   track it?** Same capture shape as (3). Determines whether §3.2's slots are free or need a
   mode layer.
5. **LED protocol.** Note On to the output port, walk note numbers, log what lights. Same
   experiment already sketched for the Starlight in `todo.md` Batch F. Expect that sending
   *anything* may take the surface out of its standalone light show — check that it can be
   given back.
6. **The built-in audio interface.** Out of scope for this doc, but do not skip it: if
   PipeWire exposes the FLX4's master/cue outputs, that is a new output device node, and the
   shared-output rules apply unchanged — **one `pulsesink` per PCM node**, and "Front"/"Rear"
   style channel pairs on one device are *one node, not two*
   (`docs/design/shared-output-pipeline.md`). A DJ controller with master + headphone outs is
   exactly the shape that trips this.
7. **Tempo fader**: 14-bit or 7-bit, and which direction is fast. `invert` exists in the
   profile sketch because the Starlight sends higher values for *slower*, and there is no
   reason to expect agreement.

---

## 9. Testing without hardware

The current mapping tests (`tone_knob_tests` in `midi.rs`) are good and should survive the
move — but they test *one* map by calling it. With profiles, two cheap things become
possible and both should be built alongside phase 1:

- **Profile validation tests**, run over every shipped profile: no duplicate `(status, d1)`
  keys; every `fader14` MSB has its LSB present and not separately bound; every `slot` is
  `< slots`; every `action` is a known action. The Starlight's existing assertions
  ("both knob modes are mapped on both decks", "`(0x90,1)` stays unmapped") become rows of
  data-driven cases rather than bespoke tests, and the *reasoning* comments move with them.
- **Capture-and-replay.** A raw byte log from the monitor, saved to a file, fed through the
  resolver in a test, asserting the resulting action sequence. This is the piece that makes
  the FLX4 profile developable without the controller physically attached, and it converts
  "I turned the knob and it seemed right" into a regression test. It fits this project's
  existing probe culture and it costs almost nothing once `midi-raw` exists.

Neither replaces a live check. The Starlight work established that mapping bugs are *silent
and plausible* — a swapped bass/filter assignment produces a knob that does something, just
not the labelled thing — so the FLX4 profile still ends with a by-ear pass over every
control before it is called done.

---

## 10. Open questions this doc does not settle

- **Profile file format**: TOML (matches Cargo-adjacent tooling, comments survive) vs JSON
  (learn mode writes it programmatically, no Rust dep added). Learn mode writing *user*
  profiles argues for JSON on the write path even if built-ins ship as TOML; two formats for
  one schema is a cost. Decide at phase 1, not phase 5.
- **Where slot→deck routing is edited.** `Session.midiMapping` is session state and
  serialized with the session; a controller identity is more like a device setting
  (`cuemark:` localStorage, per `audioSettings.ts`). A profile bound to a session that is
  later restored on a machine with a different controller attached needs a defined answer.
- **Whether the frontend needs to know which controller sent an action.** Today it cannot,
  and does not need to. With two live surfaces, feedback (LEDs) and "which controller is
  driving this deck" both want it, which argues for a `source` field on `MidiAction` sooner
  rather than later — it is nearly free to add now and awkward to retrofit.
- **`JogTouch` precedence.** When a controller reports platter touch, does touch override
  `deck.playing` for the scratch-vs-bend decision, or gate it? Touching a *playing* FLX4
  platter conventionally means scratch-over-playback, which cuemark's paused-deck feeder
  does not currently do at all. That is a real feature gap, not just a mapping question, and
  it belongs in `docs/design/waveform-scrub.md` once the capture in §8.2 exists.
