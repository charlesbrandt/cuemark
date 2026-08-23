# Controller mapping — many controllers, one control surface

Status: 🟢 **Phases 1, 3, and a trimmed phase 4 built and live-tested (Rust/TS); phase 2
partially built.** Written 2026-08-17, prompted by a **Pioneer DJ DDJ-FLX4** on order.

**2026-08-22 (build session): profiles-as-data + the FLX4 profile landed**, on top of
the same-day capture session (§8/§11) and a scope call to trim what shipped now vs.
defer. What's actually running:

- **Phase 1 (profiles as data) — 🟢 built.** `src-tauri/src/midi/{mod,profile,decode,monitor}.rs`
  replaced the old single hand-written `hercules_starlight_map()`. Both controllers are
  TOML files in `src-tauri/profiles/`, loaded via `include_str!` plus an app-data
  `profiles/*.toml` override directory (same `id` shadows a built-in). §5's hotplug
  design is built too, not just sketched: a supervisor thread polls ports every 2s,
  opens one connection per matched profile, and **both controllers can be live at
  once**, each addressing its own decks — `ControlBinding`/`MidiAction` carry `slot: u8`
  instead of a baked-in `deck_id`, and `Session.midiMapping` is now
  `Record<profileId, string[]>` (slot → deck id per controller), with slot *i* →
  `decks[i]` as the zero-config default. `AudioSettings.svelte`'s L/R selects retarget
  whichever 2-slot profile is currently connected rather than being redesigned for N
  controllers — a real per-controller routing UI is still open.
- **Phase 2 (normalized-signal refactor, §4) — 🟡 built only where it was load-bearing.**
  The jog wheel is the one place this couldn't be deferred: `JogNudge` was renamed
  `JogTurn` and now carries **revolutions**, not raw ticks — a per-profile
  `jog_ticks_per_rev` (Starlight 256, FLX4 ~721.7, §8.2) is divided out in Rust, and a
  per-profile `invert` flag on the tempo fader recovers each controller's own
  higher-raw-value sign convention (Starlight `invert=true`, FLX4 `invert=false`, §8.7)
  — both are wire-format changes, both verified by a capture-replay test
  (`src-tauri/tests/replay.rs`) landing within 1.0 of the real ~10-revolution capture.
  **EQ/tempo values themselves stay denormalized** (actual dB, actual multiplier rate,
  same as before this refactor) — the dB↔bipolar rework §4 describes is deferred, along
  with any `midi_state.json` version-field ceremony beyond the slot-key rename the slot
  refactor already forced (`{profileId}:{slot}.{field}`, a one-time silent break, not a
  migration — see `persist_kv`'s doc comment in `midi/decode.rs`). `DeckEqMid`/
  `DeckEqHigh` actions were added (the FLX4 has 3 real EQ knobs; cuemark's `mid`/`high`
  bands existed with zero MIDI path before this).
- **Phase 4 (author `pioneer-ddj-flx4.toml`) — 🟢 built and fully bench-verified
  2026-08-22.** Every row in the file — jog/pad/tempo (cuemark's own §8/§11 captures)
  and every Mixxx-sourced row (play, cue, sync, channel fader, trim, EQ hi/mid/low,
  filter/CFX, crossfader, headphone level) — has been confirmed against the real unit;
  see the bench-pass writeup below for the two findings that came out of it. See
  `docs/design/ddj-flx4-feature-gaps.md` for what's out of scope entirely (Sampler
  pads, Beat FX, browse encoder).

**2026-08-22 (first live spot-check, FLX4 alone, no Starlight attached)**: Play and Cue
(left deck, slot 0) confirmed working end-to-end — pressing the physical buttons paused/
resumed playback and jumped to the cue point as expected. `pioneer-ddj-flx4.toml`'s notes
on those two rows are updated accordingly. ⚠️ **One unresolved wrinkle**: the very first
attempt that session produced no visible effect even though the Rust log showed both
actions resolving correctly (`DeckPlayToggle`/`CueJump` with the right slot) and no
downstream IPC call followed — i.e. the frontend received a correctly-shaped event and did
nothing with it. A full `cargo tauri dev` restart (unrelated — the whole dev-server process
tree had vanished, likely from another concurrent session) made it work on the next
attempt, and it hasn't recurred since. Root cause not found; nothing in the code changed
between the failure and the success. See `todo.md`'s handoff entry for what to check first
if this recurs (a `debugLog()`-based diagnostic technique that works but wasn't needed once
the retry succeeded).

**2026-08-22 (bench-verification pass, FLX4 alone, no Starlight)**: every remaining
Mixxx-sourced row in `pioneer-ddj-flx4.toml` walked control-by-control against the real
unit and confirmed — sync, channel fader, trim, EQ hi/mid/low, filter/CFX, crossfader,
headphone level, and the entire right-deck/slot-1 side (play/cue/sync/headphone-cue/
volume/gain/EQ). All wire bytes match what the profile already declared; no `d1`/`status`
corrections were needed anywhere. Two real findings came out of it, not mapping bugs:

- **EQ knobs' printed hardware scale (-26..+6dB) doesn't match cuemark's actual EQ range**
  (`EQ_MIN_DB`/`EQ_MAX_DB` in `pipeline.rs`, -24..+12, the real range of GStreamer's
  `equalizer-nbands` element and shared globally across every controller). The FLX4 in
  MIDI mode sends a plain 0-127 rotation with no dB semantics on the wire — the printed
  labels are Pioneer's own convention for standalone-mixer mode, not a protocol fact — so
  there's no "correct" answer here, just an open taste call on whether to reshape the
  global dB curve to match this one controller's silkscreen. Not changed.
- **The FLX4's headphone LEVEL and MIX knobs are physically separate and send different
  CCs** — but getting there took two wrong turns worth recording, since both were
  app-level tests and both were wrong the same way. Two rounds of "turn only LEVEL, then
  turn only MIX" through cuemark's own log both showed `0xB6/0x0C` for *both* knobs,
  which looked like a firmware quirk (two knobs sharing one CC). It wasn't — a third,
  independent capture directly off the ALSA sequencer port (`aseqdump -p 20:0`,
  bypassing cuemark's Rust entirely) with the same "MIX then LEVEL" gesture showed two
  clean, non-overlapping blocks: MIX on CC `0x0C`/`0x2C`, LEVEL on CC `0x0D`/`0x2D` — one
  CC apart, easy to miss, and easy to physically confuse between two adjacent unlabeled-
  on-screen knobs under verbal instruction. **The lesson: for a "these two things look
  identical" finding, verify with a capture independent of the code path already under
  test, not just a second attempt through the same path.** `pioneer-ddj-flx4.toml`'s
  `cue_gain` row is now bound to LEVEL (`0x0D`/`0x2D`, the correct semantic match — a
  plain output level); MIX (`0x0C`/`0x2C`) is deliberately left unbound, since cuemark
  has no cue/master mix-ratio concept to bind it to. `ddj-flx4-feature-gaps.md` §8's
  "HEADPHONES LEVEL is analog-only" claim (sourced from the manual) was also wrong —
  both knobs send real MIDI.

**Still open**: the full §4 normalized-signal refactor for EQ/tempo, a real
multi-controller routing UI, LED output (still no MIDI output code at all — §1/§11),
`JogTouch` precedence (§10), and the unresolved one-time Play/Cue miss noted above (never
recurred since).

This doc is about *mapping* — wire bytes to bindings cuemark already knows how to act on.
For physical FLX4 controls whose target *behaviour doesn't exist in cuemark at all* (Beat FX,
sampler pads, loop halve/double, browse/library, reverse playback, …), see the separate
inventory in `docs/design/ddj-flx4-feature-gaps.md`.

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
slots   = 4             # ⚠️ pre-hardware guess, wrong — the real profile ships slots=2,
                         # no 1/3-2/4 switch exists on this unit (§8.4)

[[control]]
status = 0x90            # full status byte — channel is NOT masked (see §3.1)
d1     = 0x0B
kind   = "button"        # ⚠️ pre-hardware guess, wrong — resolve_action has no
                          # toggle/momentary concept; the real closed set the built
                          # schema uses is button | fader | fader14 | relative
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

**7a. Raw MIDI monitor — 🟢 BUILT 2026-08-17.** Toolbar → Settings → MIDI tab (merged into
the tabbed SettingsPanel 2026-08-22; was its own toolbar toggle before that);
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
| **1** | Profiles as data; port the Starlight map verbatim to TOML; slot→deck routing; hotplug/multi-port — 🟢 **done 2026-08-22** | now — no hardware needed |
| **2** | Normalized-signal refactor (§4), incl. `midi_state.json` migration — 🟡 **jog+tempo slice done 2026-08-22, EQ/tempo dB rework deferred** (see the top-of-doc status note) | with phase 1, same change ideally |
| **3** | Raw MIDI monitor panel (`midi-raw`, unthrottled) — 🟢 **done 2026-08-17**, extended 2026-08-22 for multi-controller (`source`, per-port keying) | — |
| **4** | Author the FLX4 profile by hand from captures (§8) — 🟡 **done 2026-08-22 for captured controls; every other control sourced from Mixxx, not live-verified** | FLX4 in hand |
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
2. ✅ **RESOLVED 2026-08-22 — plain ±1 deltas, accumulation exact, no speed-scaling.**
   Measured via the raw monitor's Save-capture export (segmented by jog-touch note on/off
   boundaries, not by shell timing — freehand single-revolution trials were unusably noisy,
   off by as much as 4× on a miscount): 5 slow revolutions = 3602 ticks (720.4/rev,
   3.65s/rev pace), 5 fast revolutions = 3615 abs ticks (723.0/rev, 1.80s/rev pace — landed
   almost exactly on real 33⅓rpm). **0.4% apart ⇒ equal**, same conclusion as the Starlight.
   Byte values `63/65/66` centered on `64` confirm **`offset64` encoding** (not two's
   complement like the Starlight — `-1` there would be `0x7F`, not `0x3F`). Candidate
   `VINYL_SEC_PER_TICK` for the FLX4: `1.8 / 721.7 ≈ 0.0025` (vs. the Starlight's
   `1.8/256`) — a *per-controller* value, confirming this belongs in the profile
   (`docs/design/waveform-scrub.md`'s `VINYL_SEC_PER_TICK`), not a shared constant, the
   moment a second controller exists. Jog turn while touched is CC `0x22` (control 34);
   CC `0x21` (control 33) fires for untouched/pitch-bend rotation — matches the Mixxx
   mapping's split exactly. Not yet wired into a real binding — no FLX4 map entry exists,
   this is a captured fact for when phase 4 authors one.
3. ✅ **RESOLVED 2026-08-22 — firmware-side, same shape as the Starlight's tone knob.**
   Captured the top-left pad (deck 1, status `0x97`) across three mode-button presses
   (`0x90`): Hot Cue (`d1=0x1B`) → pad sends `0x00`; Beat Jump (`d1=0x20`) → pad sends
   `0x20`; Sampler (`d1=0x22`) → pad sends `0x30`. Channel never changes, only the note —
   confirms §6's "just more rows in the table," no host-tracked mode layer needed. Matches
   the Mixxx reference mapping's ranges exactly (Hot Cue `0x00-0x07`, Beat Jump `0x20-0x27`,
   Sampler `0x30-0x37`, all per deck channel). The mode-select buttons themselves
   (`(0x90,0x1B)` etc.) likely need no binding either, same as the Starlight's Bass/Filter
   button — the firmware already did the work.
4. ✅ **RESOLVED 2026-08-22 — no such switch exists.** The FLX4 is a strictly 2-channel
   controller; Pioneer's own docs confirm deck 3/4 access requires an FLX6/FLX10 or switching
   focus in software (touching `[DECK 1]`/`[DECK 2]` in rekordbox's Performance mode), not a
   hardware control. The switch found under "MASTER LEVEL"/"BEAT FX" labeled `1 / 2 / 1&2` is
   the **Beat FX channel-select**, unrelated to deck slots — confirmed live, sends Note On/Off
   on channels 4/5 (`0x94`/`0x95`), notes `0x10`/`0x11`. §2's "Deck slots per side" row was a
   pre-hardware guess and is wrong for this unit: it's **1**, same as the Starlight, so §3.2's
   slots need no mode layer for the FLX4.
5. ✅ **RESOLVED 2026-08-22 (follow-up session) — SysEx handshake unlocks the left deck; see §11.**
   Right deck (`0x99`) is a plain Note On/Off echo. Left deck (`0x97`) needed the SysEx
   `F0 00 40 05 00 00 04 05 00 50 02 F7` sent once first — after that it behaves identically
   to `0x99` (Note On vel `7F` lights a pad, `00` clears it, no per-note resend of the SysEx
   needed). The handshake has a real side effect: it dims the Hot Cue mode-select button LEDs
   on *both* decks, which are then separately relit with Note On to `(0x90,0x1B)` /
   `(0x91,0x1B)` — a host app must be doing exactly this on connect. Full writeup in §11.
6. ✅ **PARTIALLY RESOLVED 2026-08-22 — confirmed, and it's exactly the anticipated shape.**
   `wpctl status` shows the FLX4 as device 109 with sink **`DDJ-FLX4 Analog Surround 4.0`**
   (one 4-channel node — master + cue bundled, same "Front/Rear = one node" pattern
   `front_and_rear_of_one_device_are_one_node` already tests for) and source
   `DDJ-FLX4 Analog Stereo` (2ch input, likely mic/line return — out of scope here). Still
   open: actually wiring an FLX4 output-device option end to end through
   `make_snapcast_sink`-style device selection and confirming channel-pair assignment
   (which pair is master vs cue) by ear — this only confirms the node shape, not the wiring.
7. ✅ **RESOLVED 2026-08-22 — 14-bit, MSB `(0xB0,0)` / LSB `(0xB0,32)`, higher = `+`/faster.**
   Confirmed genuinely 14-bit, not LSB noise: MSB advances one step roughly every 8-9ms while
   LSB sweeps its full 0-127 range in between each MSB increment — real fine resolution, same
   `+32` offset convention as the rest of this controller. Direction, from the physical `+`/`-`
   printed on the fader: pushing to `+` (bottom) drove the combined value to its max (`127`);
   pushing to `-` (top) drove it to `0`. So **higher raw value = faster** here — whether that
   agrees or disagrees with the Starlight's `invert` needs re-deriving the Starlight's own
   sign convention carefully before setting the flag; don't assume disagreement by default
   the way this line originally speculated.
   ✅ **RESOLVED 2026-08-22 (build session) — they disagree.** `rate_from_14bit`'s actual
   formula, `(8192 − combined)/8192`, makes the Starlight's higher-raw-value = *slower*;
   this row's own measurement above is higher-raw-value = *faster*. `pioneer-ddj-flx4.toml`
   ships `invert = false` against the Starlight's `invert = true`, verified by
   `src-tauri/tests/replay.rs` against the real jog/tempo captures.

---

## 9. Testing without hardware

✅ **Both bullets below are built** (2026-08-22 build session): profile validation lives in
`src-tauri/src/midi/profile.rs`'s tests (the old `tone_knob_tests` moved and split between
`midi/decode.rs` — the value-mapping math — and `midi/profile.rs` — the map-shape
assertions), and capture-and-replay is `src-tauri/tests/replay.rs` against real fixtures in
`src-tauri/tests/captures/`, including the FLX4 jog capture. What follows is the original
reasoning, kept because it still explains *why*:

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
- ✅ **RESOLVED / built 2026-08-22.** `MidiEvent { source: u32, profile: String, action:
  MidiAction }` (`midi/mod.rs`) wraps every emitted action; `midi_list_controllers` +
  `"midi-controllers"` expose live connections to the UI. `source` isn't yet consumed
  frontend-side beyond `MidiMonitor.svelte`'s per-port keying — using it to disambiguate
  which controller is driving a given deck in the general UI is still open.
- **`JogTouch` precedence.** When a controller reports platter touch, does touch override
  `deck.playing` for the scratch-vs-bend decision, or gate it? Touching a *playing* FLX4
  platter conventionally means scratch-over-playback, which cuemark's paused-deck feeder
  does not currently do at all. That is a real feature gap, not just a mapping question, and
  it belongs in `docs/design/waveform-scrub.md` once the capture in §8.2 exists.

---

## 11. LED protocol (§8.5) — RESOLVED 2026-08-22 (follow-up session)

**What's confirmed, live** (all via `amidi -p hw:1,0,0 -S "<status> <note> <vel>"`, sent
directly to the raw ALSA device — cuemark has no MIDI output code, see §1's "no MIDI output";
sending this way works fine alongside cuemark's own input connection, no conflict; card index
may differ per machine, check `amidi -l`):

- **Right deck (`0x99`) pad LEDs are a plain Note On/Off echo.** Velocity `7F` lights a pad,
  `00` clears it, from a clean state. No handshake, no SysEx, just the obvious thing.
- **Left deck (`0x97`) needs a one-time SysEx handshake first, then behaves identically.**
  The candidate handshake from a lower-confidence secondary source —
  `F0 00 40 05 00 00 04 05 00 50 02 F7` — is real. Sent once, immediately after, plain
  Note On (`97 <note> 7F`) / Note Off (`97 <note> 00`) worked on the left-deck pads exactly
  like `0x99`, confirmed on two different pads, with **no need to resend the SysEx** between
  them — it is a one-time unlock for the session, not a per-note precondition. This settles
  question 1 from the original handoff (channel `0x97` was always correct; it just had an
  unmet precondition) and question 3 (the secondary-source handshake is genuinely the host's
  init sequence, not a dead end).
- **The handshake has a real, visible side effect beyond unlocking the left deck**: it dims
  the Hot Cue mode-select button LEDs on **both** decks (not just left). This is a strong
  signal for what question 2 was asking — the firmware's default/standalone light state
  includes those mode buttons lit, and the handshake is a real "host is taking over" signal
  that resets some LED state as a side effect, not an isolated left-deck fix. A real host app
  must be relighting them afterward: sending Note On to `(0x90,0x1B)` (deck 1) and
  `(0x91,0x1B)` (deck 2) — the same `(status, d1)` pairs the mode-select *buttons* themselves
  use, per §8.3 — restored both to lit, confirmed live. So a real LED-init sequence is at
  least: SysEx handshake → relight whichever mode buttons should be active by default.
- This session never revisited the **stuck pulsing state** from the original handoff (the
  left deck was already idle/dark going in, so there was nothing to un-stick) — whether the
  handshake is *also* the fix for that specific stuck state remains untested. If it recurs,
  try the handshake before reaching for a physical replug.
- Not tested this session: CC-based LED control (moot now that the Note path is confirmed
  working for both decks), and whether other LED groups (jog ring, level meters, browse
  encoder) need their own handshake-adjacent quirks — assume "capture before designing" still
  applies per-control-group rather than generalizing from pads.

**What this means for phase 4 (the actual `pioneer-ddj-flx4` profile)**: an LED-output init
routine for this controller is now fully specified — send the SysEx handshake once on
connect, then relight default-state mode buttons — but per §10's open question on `MidiAction`
`source`/output plumbing and §1's "no MIDI output" gap, there is still no code path to hang
this on. **No code should be written yet.** This is captured fact for whoever builds MIDI
output (needed regardless, for LED feedback in general) and the profile system (§3) that would
hold a per-controller init sequence as data rather than a hand-wired call.
