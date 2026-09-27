# Sink clock stall — decks silent (or delayed by minutes) after the output graph has been idle

Status: 🔴 **OPEN (2026-09-27).** Three incidents on file (2026-09-19, 2026-09-26 ×2) plus a
2026-09-27 live report (§10, USB device toggle) plus a week of `CLOCK REFERENCE OFF BY`
warnings that are the same fault in its milder form.
Mechanism **proposed, not proven**. Instrumentation (§6) and the clock pin (§5 fix 1) are
built and committed (`e19c255`); the pin is live but did not prevent the 09-26 16:13 incident — see §9 and §6a. This doc supersedes the "Clock reference drifting while idle" section of
`shared-output-pipeline.md` as the place to read; that section keeps the 09-19 measurements.

Read `shared-output-pipeline.md` first (one `pulsesink` per device node, `audiomixer` summing
`is-live` appsrcs, a permanent silent `audiotestsrc` keepalive, deck pipelines `use_clock()`
the graph's clock).

## 1. Symptoms — one fault, three faces

| Face | What the user / log sees | When |
|---|---|---|
| **A. Total wedge** | Press Play: first (preroll) buffer lands, then `[deliver-tel]` reads `0/s` on every counter forever, position stays 0.000, no bus ERROR/EOS. New loads, deck-1, and a partial output-device change do not help. Restart cures. | 2026-09-26, 8h-old instance, idle ~6h before the load |
| **B. Delayed audio** | `play: first buffer … margin +161334ms`, then +66s, +39s, +19s on later plays: buffers stamped minutes **ahead** of the sink's running time, so the sink waits that long. Audio starts minutes after Play, or after the user gave up and paused. | 2026-09-25 22:47 (and +321s, +205s at 22:01–22:02); 09-20 ×35, 09-21 ×6, 09-22 ×3 — all `CLOCK REFERENCE OFF BY +N s` |
| **C. Idle-time playback** | The user reports audio playing "for short periods" while cuemark has sat idle with no action taken. Consistent with **B**: a Play (manual, Auto DJ, MIDI, queue advance) whose audio was scheduled minutes into the future and finally comes out on its own. **Not yet confirmed against a log** — see §7. | Reported anecdotally, several times |
| (09-19 form) | margin ≈ −(graph idle time), sinks pacing in bursts at 3.6× real time; a resumed deck delivered zero buffers for 34s. | 2026-09-19, 8-day instance |

Common ground in every case: shared clock is **`GstPulseSinkClock`** (not the
`GstSystemClock` the design assumes), and the graph had been without real audio for a long
time before the first Play.

## 2. The 2026-09-26 specimen (face A) — what was measured

- Load at 12:53:23 UTC (host I/O pressure warning, preroll 3.6s). Play 12:53:31: first buffer
  58ms, margin +99ms (clean), then nothing. Earlier plays in the same process, ~10h before,
  delivered 15 buffers/s. `graph idle 0.0s` at play (this reading is **blind**, §6.1).
- Webview healthy throughout (rAF 60fps, IPC ~5ms). PipeWire healthy (`pw-top`: nodes scheduled,
  no xruns; ERR=1 static on the USB codec sink). Host was degraded (swap ~full, iowait 40–70%,
  RAM 32GB) — contributory at most.
- **pipewire-pulse journal**: 25 `stream … OVERFLOW` events in the single second of the first
  play, then silence; fresh bursts at each later Paused→Playing (09:05:32, 09:07:09, 09:07:49
  local). Reproducible on demand while wedged.
- Experiments on the wedged instance: deck-1 load+play also silent → graph-level, not
  deck-level. Changing the main output device logged `set_devices` and created a new
  `out/default` node, but **only partially rebuilt** the graph (main1 and the cue kept the old
  nodes) and `shared_clock` is never replaced → "no effect" refutes nothing about a full
  rebuild.
- gdb (needs sudo: `ptrace_scope=1`), `thread apply all bt 30`, saved during the incident.

### ⚠️ Correction — the stacks were first misread

The first reading said "both output sinks are parked in `gst_clock_id_wait`, so the sinks are
stuck." Resolving the addresses against the installed GStreamer 1.24.2 (no debug symbols)
shows otherwise:

- `audiomixer0:src` / `audiomixer1:src` are the **node** sinks, in
  `gst_audio_base_sink_render → gst_event_new_gap → wait_event → do_sync → gst_clock_id_wait`
  — the *normal* pacing wait for a GAP buffer. It proves the mixer output was **GAP-only** (no
  deck audio reaching it). It does not prove the sink was stuck; their context-switch rates
  (~100/s, keepalives ~48/s) show the node pipelines cycling normally.
- `queue103:src` is **not** the other node: `chain_unlocked → do_sync` is a **deck `appsink`**
  (`sync=true`, no per-branch queue on the deck tee). That is the real stuck wait: the deck's
  appsink waiting for a clock that has not reached its buffer's timestamp.
- qtdemux/multiqueue/queue threads are ordinary backpressure behind that appsink.

Lesson: an `audiomixer*:src` thread sitting in `gst_clock_id_wait` is healthy pacing, not a
wedge. Look for the **deck appsink** thread.

## 3. Proposed mechanism (H1) — inference, not verified

Verified from GStreamer 1.24 / pipewire 1.0.5 source unless marked *(inference)*:

1. With no branch attached, the only input to a node is the keepalive silence. `audiotestsrc
   wave=silence` buffers are flagged GAP *(inference — the stacks support it)*. `GstAudioBaseSink`
   never writes GAP buffers to the PulseAudio stream, so pulsesink's **write index stops
   advancing** while idle.
2. The first real buffer after idle is written with `PA_SEEK_ABSOLUTE` at an offset derived
   from running time, i.e. about the *idle span* ahead of the server's write_index.
3. pipewire-pulse flags **OVERFLOW** when `filled + len > maxlength` (4 MiB ≈ 11s here) but still
   stores the data. That is the 25-event burst at Play.
4. The pulse read_index / `pa_stream_get_time` then steps *(inference)*. `GstAudioClock` clamps
   to `last_time` when its computed time goes backwards, so a backward step becomes a **freeze**
   of about the step size (face A); a **forward-lag** gives buffers stamped far ahead of the
   clock (face B: `margin +161s`), shrinking as the clock catches up — which is exactly the
   +161 → +66 → +39 → +19s sequence and the 09-19 "3.6× bursts".
5. Every new Play takes its base_time from that clock, so it re-wedges. `shared_clock` is set
   once (`mixer.rs`, `if self.shared_clock.is_none()`) and never replaced, which is why a partial
   node rebuild did nothing.

**H2 — race-dependent clock choice.** `mixer.rs` publishes `sink.provide_clock()` if the
ringbuffer is already acquired, else falls back to `pipeline.clock()`. So decks sometimes get
the pulse clock and sometimes `GstSystemClock`. The existing log line reports the *sink's*
clock, not the node pipeline's own. Prediction: runs that chose `GstSystemClock` never show
this fault (and the design doc's stated assumption would then be true only sometimes).

**H3 — host swap/iowait:** shifts the timing of the first push; cannot explain a persistent
state. **Refuted:** a node sink blocked forever; a PipeWire or USB stall.

Not a match for any upstream bug report found. Versions: GStreamer 1.24.2, pipewire and
pipewire-pulse 1.0.5, libpulse 16.1.

## 4. Why the existing instruments did not see it

- `CLOCK REFERENCE OFF BY` (09-19) needs **flowing** buffers with a large |margin| for two 5s
  windows. Face B trips it (and did, repeatedly). Face A never does: with no buffers, margin
  is stale, so the warning stays quiet while the deck is dead.
- `play: … graph idle 0.0s` reads ~0 always: the activity probe (`mixer.rs`, BUFFER probe on
  the sink pad) also stamps **keepalive** buffers, so the "graph" never looks idle.
- `[deliver-tel]` repeats the last margin (`+101ms`) for minutes when the rate is 0/s.
- The `first buffer …ms after Playing` follow-up is the preroll buffer, not evidence of flow.
- pulse / audiobasesink warnings never reach `cuemark.log`; the OVERFLOWs are only in the
  system journal.

## 5. Candidate fixes (lowest risk first — none applied yet)

1. **Pin every node pipeline and every deck to `gst::SystemClock`**; stop publishing the sink's
   clock. Makes the assumed configuration deterministic; pulsesink absorbs device drift by
   skew slaving. Kills H1/H2 if either is right.
2. **Make the keepalive non-GAP** (clear the GAP flag in a probe on the mixer src pad). pulsesink
   then writes real silence continuously, its write index tracks running time, and the
   absolute-offset jump cannot happen. Negligible cost.
3. **Detector + full rebuild**, fired only when *both* a deck has been Playing with 0 appsink
   buffers for >1.5s **and** the clock sampler (§6.3) shows a stall or step. Must clear
   `shared_clock`, set every node to Null, rebuild the nodes, then move each deck through
   Paused → `use_clock(new)` → Playing. Plausible, but the current partial rebuild proves a
   rebuild that keeps the clock is useless.

Do not add rebuild-on-idle timers or self-heal before the data in §6 says which face is
which — that was the 09-19 rule and it stands.

## 6. Instrumentation to add (before or with fix 1)

| # | What | Answers |
|---|---|---|
| 6.1 | Count **non-GAP** buffers only in the graph-activity probe, so `graph idle` means what it says | Was the graph really idle before this play? |
| 6.2 | Log each node pipeline's own `clock()` beside the published clock, per node, at build | H2 |
| 6.3 | Every 5s per node + shared clock: `clock.time()` − monotonic; WARN on plateau or step >100ms; at Play also log the deck's `base_time()` | H1 — plateau vs step, size and sign |
| 6.4 | `[deliver-tel]`: when rate is 0/s print `no buffers` and `clock − base_time` instead of a stale margin | Face A visibility |
| 6.5 | `gst::log` handler forwarding `pulsesink`/`audiobasesink` WARN+ into `cuemark.log` | Overflow visible without journalctl |
| 6.6 | Watchdog: Playing with 0 deck-appsink buffers for >2s → WARN `PLAY PRODUCED NO AUDIO` with clock samples and node/deck states | Silent-failure inventory rule: verify the effect, not the call |
| 6.7 | Log buffers/audio-ms each appsrc pushes in the first 500ms after Playing | Backlog-burst hypothesis |

## 6a. Implementation status (2026-09-26, uncommitted, NOT live-verified)

Built and unit-tested (`cargo test --lib clock_watch` 7/7; `audio::mixer` 9/9; the
hardware-gated `two_branches_share_one_node` passes with `--ignored`):

| Item | Where | Notes |
|---|---|---|
| **Fix 1 — pin nodes to `GstSystemClock`** | `mixer.rs` `create_node()`, `shared_clock_pinned()` | Default on. `CUEMARK_SHARED_CLOCK=sink` restores the old behaviour for A/B. The published shared clock is the system clock, so decks adopt it. The `EXPECTED_SHARED_CLOCK` warning now stays quiet by construction. |
| 6.1 — non-GAP activity probe | `mixer.rs` sink-pad probe | `graph idle` in the `play:` line now means "since the last buffer that carried audio". Expect it to finally read large after a long idle. |
| 6.2 — node clock beside published clock | `mixer.rs` `[audio/out/N] clocks at build: pipeline=… sink=… policy=…` | Answers H2 per node. |
| 6.3 — clock sampler | new `audio/clock_watch.rs` | Per node, every 5s: pipeline clock **and** the pulsesink's own clock vs monotonic. WARN `CLOCK STALLED` / `CLOCK STEPPED` at >100ms error; INFO `node-tel: real=…/s gap=…/s | pipeline=… drift … | sink=… drift …` every 30s. The sink clock stays sampled even when the pin removes its consequences, so a pulse-clock step is still visible. |
| 6.4 — stale margin | `pipeline.rs` `[deliver-tel]` | Window with no buffers prints `margin STALE(no buffers; last +101ms)`. |
| 6.6 — dry watchdog | `pipeline.rs` reporter | Playing with zero buffers to any sink for 3s → WARN `PLAY PRODUCED NO AUDIO`, once per episode, plus an INFO when flow resumes. |
| **post-mix level probe (§9's "missing instrument")** | `mixer.rs` `create_node()`, reuses `pipeline.rs`'s `instrument_level()` | 2026-09-27. Attached to each node's device-sink pad (post-master-volume, the last point in our own graph before the sink element), logging `[level/out/<node>] post-mix (to device): [L/zL% R/zR%] dBFS/zero% per ch  frames=N` once a second, same format as the existing `[level/deck-N]` lines. Settles §9 directly: `real`/`gap` buffer counts and `pcm-tap` throughput prove a buffer *reached* the pad, not that it carried signal (measured 2026-09-27: `analog-stereo` read 45 real buffers/s while the user heard silence) — this reads the samples. Still does not reach past our own pulsesink into PipeWire/the device; `pw-record --target <sink>.monitor` is still the next rung if this reads healthy and the device is still silent. `cargo check`/`cargo test --lib audio::mixer` clean; **not live-verified**. |

**Not built yet:** 6.5 (forward pulsesink/audiobasesink warnings into the log — unclear that
the overflow even produces a client-side warning, since it is a server-side event), 6.7
(burst size at Playing), fix 2 (non-GAP keepalive), fix 3 (detector + full rebuild).

**How to read the next run:** load a track and look for `clocks at build` (H2: what did each
node's pipeline actually pick), then `node-tel` every 30s. If a `CLOCK STEPPED/STALLED` for
`sink` appears while `pipeline` stays clean and audio is fine, H1 is supported *and* fix 1 is
doing its job. If `pipeline` steps too, the pin is not enough. If audio fails with no clock
warning at all, H1 is wrong and the gdb-and-journal route reopens.

## 7. Open questions / verification

- **Is face C really face B?** Next time audio starts by itself, the log should show a `play:`
  line (or an IPC `play`) minutes earlier with a large positive `margin at first buffer`. If
  there is no earlier Play at all, face C is something else (Auto DJ / queue advance / MIDI
  spurious) and this doc does not explain it. Grep for it before assuming.
- Repro recipe for the mechanism, once §6 exists: run with
  `GST_DEBUG=pulse:5,audioclock:6,audiobasesink:5`; play, unload, idle 5 and 30 minutes, play;
  check `journalctl` for OVERFLOW and the clock sampler for plateau/step.
- Whether GAP-flagging on `audiotestsrc` is real (verify with a pad probe), which decides
  whether fix 2 is meaningful.
- Not live-verified: any fix. Never rebuild/deploy during a live set (see memory).

## 9. Third incident, 2026-09-26 16:13–16:19 UTC — self-recovered, clock pinned (evidence only)

User report: a deck played silent, then audio "came back on its own", no restart. Findings from
`cuemark.log` (all UTC):

- **Trigger looks the same as §2.** deck-0 was loaded and played at 16:13:18 with `graph idle
  5873.2s` (98 min). Its margins were degraded from the first buffer and stayed so: `sink0 +63ms`,
  `sink1 -0ms` (min -15ms). A first play after 1137s idle at 14:33 was healthy (+99ms).
- **Recovery coincided with a different pipeline, not a drain.** Auto DJ played deck-1 (loaded
  16:18:08, played 16:18:42, `graph idle 0.0s`): margins `+101ms / +36ms`. deck-0 was detached at
  16:19:02. deck-0 reloaded 16:22:29 and replayed 16:23:04 with healthy `+100 / +36`. So a fresh
  pipeline on the now-active graph is healthy; the pipeline that first played after the idle was not.
- **The sink clock did NOT drain.** `CLOCK STALLED` (sink `GstAudioClock` advanced 0ms/5s, cumulative
  drift +4803s at 16:26 and falling 5s per 5s, i.e. frozen ~80 min ahead) kept firing, unchanged,
  while audio was audible again. Decks are on the pinned `GstSystemClock` (`e19c255`), and node-tel
  read `real=100/s gap=0/s` throughout: the node emitted real audio to the pulsesink the whole time.
  **A stalled sink clock is therefore neither necessary nor sufficient for silence with the pin.**
- ⚠️ **Retracted signals.** `pw-top` showing the USB sinks `R` with quantum 0 / rate 0 read identically
  while silent and while audible, and `CLOCK STALLED` did too. Neither discriminates. Do not diagnose
  "silent" from them.
- The window overlapped headless verify-agent instances (isolated XDG dirs, same PipeWire). Stall
  warnings doubled from 12 to 24/min at 16:08 (an extra instance's nodes?). Not ruled out as a cause.
- **Unknown, and the missing instrument:** whether the samples reached PipeWire. Next time it
  happens, capture the sink's monitor (`pw-record --target <sink>.monitor`, or `pw-cat`) for a few
  seconds while silent, and check `zero%`. Better: a post-mixer level probe per node (6.x) so the log
  itself says whether a node emitted signal. Until then the mechanism stays unproven.
- Workaround supported by the data: reload the deck (a fresh pipeline on an active graph played fine).

## 10. Fourth incident, 2026-09-27 — manual Main-device toggle, live report

User report: with Main output flipped between "None" and "USB AUDIO CODEC" repeatedly, audio was
audible with Main **off** (routed to the `default` node) and **silent** with Main **on** (routed
to the `analog-stereo` node) — the opposite of what the user expected from the setting's label.

`cuemark.log` 17:44:32–17:51:16 shows the attach/detach bookkeeping itself is correct on every
toggle (`set_devices` → detach old node → attach new node → `first buffer reached the sink`).
The asymmetry is entirely in the two nodes' health, matching this doc's mechanism:

- **`audio/out/default`**: `node-tel` reads clean for the whole ~7-minute window —
  `real=100/s gap=0/s`, sink clock drift within ±13ms — including through an unrelated auto-dj
  crossfade at 17:49:46 that played correctly.
- **`audio/out/analog-stereo`** (the USB Audio Codec device): `CLOCK STEPPED` (jumps of
  4.8–8.6s) on each of the three brief attach windows, settling into continuous `CLOCK STALLED`
  (0ms/5s) the moment it went idle again, cumulative drift sitting around **+27,600s (~7.6h)** —
  consistent with this node's pulsesink clock having wedged once, early in this long-running
  instance, and never recovering, exactly as §3 (H1) predicts for a node that sat idle a long
  time before first use.

New data point for the §9 "missing instrument": `pcm-tap/analog-stereo` logged real (non-GAP)
throughput during two of the attach windows — `45.0/s` and `12.5/s` — yet the user heard
silence. So buffers reaching the mixer/tap is confirmed **not sufficient** evidence of audible
output; whether they reached PipeWire/the physical device is still unmeasured. §9's suggested
`pw-record --target <sink>.monitor` capture (or a post-mixer level probe, 6.x) remains the
missing instrument and should be run the next time a device reproduces this rather than trusting
`pcm-tap` counts or the `first buffer reached the sink` log line.

Not a reversed-logic bug: device selection routes to the correct node every time. It only
*looks* inverted because whichever node the user happens to be idling on is healthy and
whichever one they just reactivated after a long idle is the one carrying the stale clock.

## 8. Evidence index

- Logs: `~/.local/share/com.cuemark.app/logs/cuemark_2026-09-26_*.log` (incident 12:53 UTC),
  `cuemark_2026-09-25_23-01-39.log` (face B, lines ~52611–55572),
  `cuemark_2026-09-20_03-12-32.log` (35 warnings). Rotated files are date-stamped and kept.
- Journal: `journalctl --since '08:53:00'` → `pipewire-pulse … OVERFLOW` (system journal
  rotates; copy anything you still need).
- Analysis by a read-only Opus review (2026-09-26): GStreamer 1.24.2 address resolution and the
  `mixer.rs` claims above (lines ~495–541, 616–664, 714; `pipeline.rs` ~3336) were checked
  against the repo before being written here. The clock-step/clamp chain (§3 step 4) is the one
  link it marks as inference.
