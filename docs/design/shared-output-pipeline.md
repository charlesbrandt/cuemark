# Shared output pipeline — one `pulsesink` per device node

Status: **built and LIVE-CONFIRMED behind `CUEMARK_SHARED_OUTPUT=1`** (2026-08-11) — cue survives a scratch on the shared Starlight node, and position tracks honestly. Stages 1–3 done; **stage 4 (multi-deck / multi-node) is untested** and the flag still defaults off. `slow-jog-audio-inaudible.md` §10.14 is the closing entry. This is rung **C** of the fix ladder in
`slow-jog-audio-inaudible.md` §10.10, chosen deliberately over rungs A/B and over the
`clock.force-quantum` / `buffer-time` workaround of §10.13.

Read `slow-jog-audio-inaudible.md` §10.9–§10.13 first. This doc assumes its conclusions and
does not re-argue them.

## Why C, and why now

The bug, restated at its narrowest (§10.11):

| | Starlight | elsewhere |
|---|---|---|
| **two** `pulsesink`s on the node | 🔴 gates | 🟢 fine |
| **one** `pulsesink` on the node | 🟢 fine | 🟢 fine |

Two sinks and this device are **each necessary, neither sufficient**, and after §10.12 the
mechanism is still unnamed — the two streams are indistinguishable at the PipeWire layer in
both the failing and working arms. Nothing gets *fixed* by naming it; what fixes it is
reaching one sink, which arms 2 and 3 proved sufficient whatever the mechanism is.

**Why not the §10.13 quantum lever.** `clock.force-quantum 512` worked, and lowering
`sink_buffer_times()`'s `buffer-time` reaches the same quantum from inside the app. It was
tried and **the gating came back after a short playback duration** (user-observed,
2026-08-11) — so the in-app version of the lever is not even a reliable symptomatic fix, let
alone a structural one. It also walks straight into the 2026-08-02 choppiness regression it
was raised to avoid, and `clock.force-quantum` is global to the machine and does not survive
a PipeWire restart. Dead rung.

**Why not B.** B (one sink per node *per deck*) fixes the single-deck front+rear case and
then a second loaded deck puts a second sink back on the node. It halves the count; it does
not reach one. Today's live topology is up to **four** sinks on one node.

**Why C is worth its cost even apart from this bug.** The Starlight is physically **one
4-channel PCM** (`subdevices_count: 1`, `Channel map: FL FR RL RR`, §10.10). "Front" and
"Rear" are channels 0–1 and 2–3 of a single stream. cuemark currently splits one node into
two picker entries and opens two independent `pulsesink`s that pipewire-pulse must merge back
into the one PCM it started as. One sink per node is simply the honest shape for the
hardware. It also gives `audio-dropout-mid-playback.md`'s H1 the same treatment, and gives
`record.rs` (still a stub) an obvious place to tap.

## Topology

Today — per deck, up to four `pulsesink`s, two of them on one node:

```
deck pipeline (one gst::Pipeline per deck)
  … → pitch → input_selector → output_queue → tee ├─ volume₀ → [matrix] → pulsesink₀
                                                  ├─ volume₁ → [matrix] → pulsesink₁
                                                  └─ cue_valve → cue_volume → cue_queue
                                                                  → [matrix] → pulsesink_cue
```

Proposed — the deck pipeline is unchanged up to and including the gain stages, and every
`pulsesink` becomes an `appsink`. One **output pipeline per physical node**, shared by all
decks, terminates in exactly one `pulsesink`:

```
deck pipeline (unchanged upstream)
  … → output_queue → tee ├─ volume₀    → appsink ─┐
                         ├─ volume₁    → appsink ─┼─── handoff (new-sample → push_buffer)
                         └─ cue_valve → cue_volume → cue_queue → appsink ─┘
                                                                          │
output pipeline (one per node, shared by every deck)                      ▼
  appsrc(deck-0/main) → queue → audioconvert → mix-matrix → caps(N ch) ─┐
  appsrc(deck-0/cue)  → queue → audioconvert → mix-matrix → caps(N ch) ─┼→ audiomixer → pulsesink
  appsrc(deck-1/main) → queue → audioconvert → mix-matrix → caps(N ch) ─┘      (N ch)
```

Three properties of this shape are load-bearing:

- **The mix-matrix moves downstream of the split but stays per branch.** Each branch already
  maps stereo → N channels with its target pair live and the rest zeroed (fix A, §10.10), so
  summing branches in an `audiomixer` is exactly right: main lands on `FL,FR`, cue on
  `RL,RR`, and they never overlap (`front_and_rear_matrices_do_not_overlap` already tests
  this). **Fix A is a prerequisite, not a dead end** — this is the machinery it was built for.
- **Everything delicate stays in the deck pipeline.** Seeking, flushing, EOS, the
  input-selector switch, the scratch feeder and every gain stage are untouched. The deck
  pipeline remains a complete pipeline; only its terminal element changes.
- **The handoff decouples the two pipelines' time domains.** A flush seek on deck 0 cannot
  reach the shared sink and disturb deck 1. This is the reason for appsink→appsrc rather
  than one giant pipeline containing every deck: in a single pipeline a `FLUSH_START` from
  one deck's seek propagates downstream through the mixer to the shared sink and flushes
  *everyone*. That alone rules out the simpler-looking design.

## The clock architecture, which is the actual risk

CLAUDE.md and §10.13 both flag this: today each deck's `pulsesink` provides the pipeline
clock, the position query and the scratch feeder's timing reference. Removing it changes all
three. Taken one at a time:

### 1. Rate — share the device clock, do not share base time

A sink-less deck pipeline would pick `GstSystemClock`, while the shared `pulsesink` renders
against the device's own clock. Those two run at different rates (the Starlight is a
44100-only ASYNC endpoint against a graph pinned to 48000), so the deck would produce
slightly faster or slower than the device consumes, forever. Over minutes that is a
guaranteed slow underrun or overflow at the handoff.

**Fix: every deck pipeline `use_clock()`s the graph's clock**, so the appsink's `sync=true`
paces buffer release against the same clock the output side consumes against. Production and
consumption rates then agree, which is the only property required here.

⚠️ **Corrected against what actually runs (2026-08-11).** The intent above was to hand the
decks the *device's* audio clock. In practice the graph runs on **`GstSystemClock`** and the
decks adopt that: `GstAudioBaseSink` cannot provide a clock until its ringbuffer is acquired,
and on a live pipeline that happens after `GstBin` has already selected one. **This is still
correct, and for a reason worth understanding rather than patching over** — `pulsesink` then
slaves its device to the pipeline clock (`slave-method=skew`, its default), so both sides of
the handoff run at system-clock rate and the device difference is absorbed inside the sink,
which is precisely that element's job. Rate agreement holds either way; only the mechanism
differs.

The log line names the clock and says which case it is, so this cannot quietly rot. If slow
drift is ever observed (the tell: a click every few minutes, `lag` creeping up in
`[deliver-tel]`), the lever is to re-select `sink.provide_clock()` after PLAYING and push it
to every deck — but do not assume that is already happening.

With more than one node there is more than one candidate clock; the first output pipeline's
wins and the other node's `pulsesink` slaves to it, which is already the status quo (a deck
with two main devices today has two `pulsesink`s in one pipeline, one of which is slaving).

**Base time is deliberately *not* shared.** Aligning base times across pipelines that pause,
seek and scratch independently is the fragile version of this. Instead the output `appsrc`s
run `do-timestamp=true` and stamp each buffer on *arrival* at the output pipeline. The deck
side needs only rate agreement; phase is re-established at the boundary every buffer. A deck
that pauses for ten minutes and resumes needs no base-time surgery — it simply stops and
resumes arriving.

A pleasant consequence worth stating: **the whole `discont-wait` / `alignment-threshold`
class of fault stops being reachable.** `scratch-audio-downstream-delivery.md`'s root cause
was `GstAudioBaseSink` resyncing its ringbuffer write pointer backwards on discontinuous
timestamps from the scratch feeder. Re-stamping at arrival means the shared sink never sees a
discontinuity at all. Keep `scratch_sink_alignment()` and its widening — it costs nothing and
the fault it fixed was real — but it becomes belt-and-braces.

### 2. Position — the deck's reported position will lead the audible signal, and must be corrected

⚠️ **This is the one place where a naive port silently breaks A/V sync**, and it is worth
being explicit because every instrument would read healthy.

`GstAudioBaseSink` reports position as *what the device is playing now* — it accounts for its
own 200ms ringbuffer. An `appsink` reports the last buffer it handed off, which is then
buffered downstream by the output queue plus the shared sink's ringbuffer. So
`query_position()` would start reporting **~200–250ms ahead of what is audible**, and since
audio is the master clock, video would lead audio by the same amount, everywhere, constantly.
Not a drift — a constant offset, which is exactly the kind of thing that gets mistaken for
"the video decoder is early".

**Fix:** subtract the output pipeline's latency in `position()`. Query it once per output
pipeline on reaching PLAYING (`gst::query::Latency` — `pulsesink` reports its `buffer-time`)
and re-query on any device rebuild; it is constant otherwise. Log it at build time so the
correction is visible rather than implicit:

**Measured on the Starlight, 2026-08-11: 171.3ms** (`two_branches_share_one_node` prints it).
So this is not a rounding concern — uncorrected, video would lead audio by a sixth of a second
on every deck, all the time.

```
[audio/out/<node>] latency=213ms (queue=13ms sink=200ms) — subtracted from deck positions
```

The existing `PositionSample` instrumentation in `mod.rs` is where the corrected value
belongs, and the correction must be applied on the *output-domain* side, before
`seek_output_domain`'s tempo scaling — see `seek()`'s doc comment for which domain is which,
this is the exact place the 2026-07-27 seek-domain scaling bug lived.

### 3. Scratch feeder timing — unchanged, and check it that way

The feeder self-paces on wall clock and pushes into the deck's `appsrc` with
`do-timestamp=true`. Its reference is the deck pipeline's clock, which under this design is
the shared device clock — the same clock it effectively had before. `[scrub-deliver]` /
`[scrub-sec]` and the per-second feeder telemetry keep working unchanged, and a regression
here shows up as `late%` climbing.

## Liveness: what happens when a deck is idle

`audiomixer` is an aggregator: with **non-live** pads it waits indefinitely for data on every
pad, so one paused deck would stall the mixer and silence the whole node. That is the
failure mode to design against.

**Every output `appsrc` is `is-live=true`.** The output pipeline is then live, the aggregator
falls back to its latency deadline rather than waiting forever, and an idle pad contributes
silence. The node keeps streaming whatever any deck is doing, which also keeps the PipeWire
node out of suspend (a refuted hypothesis, §10.4, but a free nicety).

Backpressure: `appsrc` with `block=true` and a small `max-bytes` blocks the appsink's
`new-sample` thread, which backpressures the deck pipeline exactly as `pulsesink` does today.
The queue before each mixer pad absorbs jitter and should stay **small** — this is added
latency on the scratch path, and the whole point of the position-mode feeder is
responsiveness. Start at ~30ms and treat it as a tuning knob (`tuning-knobs` skill).

✅ **Measured, not assumed** — `scripts/probes/shared_output_mixer_probe.py`, 2026-08-11.
With `is-live=true` the sink received a steady ~100 buffers/s throughout, branch A live on
channels 0,1 while branch B sat attached-but-idle on 2,3 at `100%z`, and B came up cleanly
when it started feeding. `--late-attach` additionally attached B to an already-PLAYING mixer
without A dropping a single window.

🔴 **The control arm is the part worth remembering.** `--not-live` runs the identical graph
with `is-live=false`, and the sink receives **zero buffers for as long as one branch stays
idle** — while the other branch is actively feeding. One paused deck silences the whole node.
That is not a hypothetical: it is what this design does if the liveness flag is ever dropped,
and it fails silently (no error, no warning, just nothing). The arm exists so the main arm's
PASS means something — an instrument that cannot fail carries no information.

## Lifecycle and ownership

A new `OutputGraph` registry (fleshing out `audio/mixer.rs`, whose `MasterMix` stub is
signatures only) holds `HashMap<node_name, OutputPipeline>`, behind an `Arc<Mutex<…>>` that
each `DeckAudioPipeline` holds a handle to. It must be an `Arc`, not a field on
`AudioManager`: `with_pipeline_detached()` removes a deck from the manager's map for the
duration of a blocking call, so a detached deck must still be able to reach the graph.

- **Register** on branch construction: `graph.attach(node, branch_id, remap) -> AppSrc`.
  Creates the node's output pipeline on first use; otherwise adds an `appsrc` + chain,
  `sync_state_with_parent()`, requests an `audiomixer` sink pad and links.
- **Detach** on deck teardown / device change: unlink, release the mixer request pad, set the
  branch elements to NULL. When the last branch leaves a node, tear the output pipeline down.
- **Rebuilding one deck must not glitch the others.** A device change re-enters `load()`,
  which today rebuilds the whole deck pipeline; under this design it detaches and re-attaches
  that deck's branches while the node's output pipeline stays PLAYING. Dynamic pad add/remove
  on a playing aggregator is supported and is the fiddly part of the implementation — it is
  where to look first if a device change produces a click on an unrelated deck.

Master volume moves to the output pipeline (one `volume` per node, after the mixer) — it is
a master, and applying it per deck was always a workaround for not having a master stage.
Per-deck gain, crossfader volume and cue gain all stay where they are.

## What this does not change

- Deck pipelines, upstream of the tee: identical.
- `parse_device_remap` / `make_remap_chain` / the `node@target!layout` id format: identical.
- The picker in `devices.rs` and its per-pair entries: identical. One node with two picker
  entries now genuinely means two channel groups of one stream, which is what the user was
  always promised.
- `pulsesink` stays the sink (**not `pipewiresink`** — `pipewiresink-play-hang.md`).
- The `sink_buffer_times()` 200ms default stays. With one sink on the node the §10.13 quantum
  reasoning is no longer load-bearing, and 200ms is the value that fixed the 2026-08-02
  choppiness.

## Instrumentation

The existing probes are per-deck-branch and mostly keep working; they now measure the deck
side of the handoff rather than the device side. Two additions are needed, because otherwise
the new failure surface has no instrument (`feedback_blind_instruments_stop_theorising`):

- **Handoff counters** — buffers/s out of each `appsink` against buffers/s into the matching
  `appsrc`, plus `appsrc`'s queued level. A divergence localises a stall to the handoff.
  Fold into the existing `[deliver-tel]` line rather than adding a format.
- **Mixer-pad silence** — `zero%` on the mixer output, per channel group. This is the
  instrument that would have caught the original bug in one reading (§10.5: read `zero%`, not
  dBFS — a windowed RMS averages a duty cycle into a level and cannot distinguish gating from
  attenuation).

`instrument_level`'s `-inf/100%z` on the non-target channels of each branch remains correct
and expected; the fault signature is a *target* channel going silent while another branch's
target stays live.

⚠️ **One existing log line changes meaning, and it looks like a regression.** The scratch
sink-alignment widening reports `appsink0=SKIPPED(no property)` for every branch on this path,
where `slow-jog-audio-inaudible.md` §10.3 taught people to expect `discont-wait = 1 hour` read
back live. That is correct here: `alignment-threshold`/`discont-wait` are `GstAudioBaseSink`
properties and an `appsink` is not one. The widening has nothing left to do — re-stamping at
the handoff means the shared `pulsesink` never sees a discontinuity to resync on. Keep the
code (it is right on the legacy path, and the fault it fixed was real); do not read `SKIPPED`
as the fix having fallen off.

## Staging

Each stage is separately live-testable, and audio always needs a live pass.

1. ✅ **Probe** (`shared_output_mixer_probe.py`) — mixer liveness and negotiation, with the
   `--not-live` control arm. Gate met: idle pad does not stall, chain negotiates, late attach
   is clean.
2. ✅ **`OutputGraph` + the appsink handoff**, behind `CUEMARK_SHARED_OUTPUT=1`, default off.
   Gate met on the bench: `cargo test -- --ignored two_branches_share_one_node` builds the
   real two-branch Starlight graph and asserts one node, one sink, 4 channels, a shared clock
   and a measurable latency; `cargo test` (36) and `npm test` (56) green; `npm run check`
   clean. **Not yet run in the app**, which is where stage 2's real gate lives: play a track
   and check the position against a stopwatch, because that is what proves the latency
   correction.
3. ✅ **Cue branch on the shared node.** Gate met, user-confirmed live 2026-08-11: cue
   survives a scratch on main=Front / cue=Rear, the arm that had failed every time since
   §10.7, against a 21%-audible baseline. Position verified honest in the same pass — that
   was the stage-2 gate and it is what proves the 171ms latency correction. The take ran ~4
   minutes with `lag=0 drop=0` on both handoffs. (The capture-and-tabulate route via
   `scratch-envelope.py --by-gesture` was not needed: against a 1-in-50 baseline the direct
   observation is conclusive on its own — the same reasoning §10.8 used.)
4. **Multi-deck, multi-node — NOT DONE.** Gate: two decks on the Starlight during a scratch
   (the case that motivated C over B in the first place); device change on one deck while the
   other plays; a second output node in use at the same time.
5. **Flip the default**, keep the flag as an escape hatch for one release. Blocked on 4.

Keep the old topology reachable for the whole of this. Every measurement in this
investigation that mattered had a control arm, and the flag is what makes the control arm
cost nothing.

## Risks, each with its tell

| risk | tell | fallback |
|---|---|---|
| Aggregator stalls on an idle pad | all output silent when any deck is paused | ✅ ruled out by the stage-1 probe + its `--not-live` control |
| Clock sharing not actually applied | slow drift → periodic clicks every few minutes | ✅ asserted by `two_branches_share_one_node`; it caught exactly this (the clock is `None` until the state change settles, and nothing else would have said so) |
| Position leads audio | video consistently early by a fixed ~200ms | the latency correction; check with a stopwatch in stage 2 |
| Added scratch latency | jog feels laggy, `late%` unchanged (it is not the feeder) | shrink the pre-mixer queue |
| Dynamic pad add/remove races | click on deck 1 when deck 0 changes device | rebuild the node pipeline instead, accept the glitch |
| It does not fix the gating | cue `zero%` unchanged at stage 3 | the tap is below PipeWire (ALSA/USB); §10.12's last paragraph |

That last row is the one to keep honest about. Arms 2 and 3 make it unlikely — one sink on
this node is measured-clean — but the mechanism is still unnamed (§10.12), and a fix
justified by "reaching a configuration that was measured to work" is not the same as a fix
justified by understanding. Stage 3's gate is what converts it.

## As built (2026-08-11)

- `audio/mixer.rs` — `OutputGraph` replaces the `MasterMix` stub. `attach`/`detach` by
  `(deck_id, branch)`, keyed on the bare node name so **"— Front" and "— Rear" of one device
  are one node**. That invariant is the whole fix, and it has its own unit test
  (`front_and_rear_of_one_device_are_one_node`) precisely because breaking it would restore
  the bug silently — two sinks on one node is not an error, it just gates during a scratch.
- `wire_handoff()` — the appsink `new-sample` → `push_buffer` bridge, with counters folded
  into `[deliver-tel]` as `<branch>.handoff=N/s lag=N drop=N`. A `Flushing`/`Eos` from the
  output side returns `Ok` to the deck: an output-side teardown must never post an error on a
  deck's bus and stop its playback.
- `pipeline.rs` — `make_appsink()`; the branch loop picks appsink-or-pulsesink; the channel
  matrix is skipped on the deck side when shared (it lives in the graph, and building it in
  both places would map stereo into N channels twice); `position()` subtracts
  `output_latency_ns`; both teardown paths call `detach_output_branches()`.
- Every deck's `pipeline.use_clock()` is set to the graph's clock before its first state
  change.

### Two things the build discovered that the design got wrong

Both were caught by the hardware test, and both would have been silent in production.

1. **An `audiomixer` with no request pads cannot reach PLAYING.** The design had
   `create_node` start the pipeline before the first branch attached, so the clock and
   latency — needed *by* that first branch — would not exist yet. It sat in PAUSED for the
   full 5s timeout.
2. **`set_state(Playing)` returns before a clock is selected.** Reading `pipeline.clock()`
   straight afterwards yields `None`, which is not an error anywhere; it just silently drops
   every deck onto the system clock.

Both are fixed by the same two additions: a **permanent silent keepalive source**
(`audiotestsrc wave=silence is-live=true`) on every node's mixer, and waiting for the state
change to settle before reading the clock and latency. The keepalive also makes the retained
-node decision coherent — a node whose last branch detaches would otherwise run dry and EOS,
and never resume when a deck came back.

## Live confirmation, 2026-08-11

```
[audio/out/analog-surround-40] latency query: live=true min=0:00:00.171333333
[audio/out/analog-surround-40] created for deck-0/main0: 4ch mask=0x33 latency=171ms
[audio/out/analog-surround-40] attached deck-0/main0 (1 branch(es) now on this node, 4 ch)
[audio/out/analog-surround-40] attached deck-0/cue  (2 branch(es) now on this node, 4 ch)
[deliver-tel/deck-0] vol0=67/s … cuesink=67/s … | main0.handoff=66/s lag=0 drop=0
                                                 | cue.handoff=66/s lag=0 drop=0
```

Two branches, one node, one `pulsesink` — which is the entire fix — and a handoff that
neither lags nor drops across the take.

⚠️ **Three things in that log would have misled a later reader, and all three are now fixed
in the code rather than explained away here.** They are worth knowing about because each is a
case of an instrument silently changing meaning under a refactor:

1. `output_queue underrun` fired 67/s throughout, saying *"expect audible choppiness"*, while
   the audio was perfect. Structural: the appsink renders just-in-time so the queue empties
   between every buffer. Downgraded to info **on this path only**.
2. `expected NO_PREROLL … but got Async` warned on a graph the latency query simultaneously
   reported as `live=true`. A direct NULL→PLAYING returns ASYNC on live pipelines too; the
   check now uses the latency query, which is authoritative.
3. The shared clock is `GstSystemClock`, not the device clock this doc's clock section
   assumed — see "1. Rate" above, which has been corrected. Rate agreement still holds,
   via `pulsesink`'s own slaving.
