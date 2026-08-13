# PipeWire `pipewiresink` hangs on Paused→Playing (new-platform bring-up)

Status: **ROOT CAUSE FOUND (2026-08-02).** The hang is an AB-BA lock inversion inside
`libgstpipewire.so` (gst-plugin-pipewire 1.6.2), triggered by having **more than one
`pipewiresink` element in a single process** go PAUSED→PLAYING with any delay between
the two transitions. It is a race, and its probability scales with the number of
`pipewiresink` elements: 0/6 runs with one sink, 4/6 with two, 6/6 with three.
cuemark always has at least two per deck (≥1 main output + the cue branch), so it hits
it essentially every time.

Reproduced standalone in ~30 lines of Python with no cuemark code, no Tauri and no GTK:
`scripts/probes/pipewiresink_multisink_deadlock.py`. Full evidence below.

**The earlier "isolated to PipeWire itself" conclusion (kept below, struck through, for
the record) was wrong** — see "Correction" for why the bare-`gst-launch` test that
produced it was invalid.

## Platform context

First time cuemark has been run on this machine:

⚠️ **The Ubuntu version below (26.04) doesn't match every later-dated doc, which mostly say
24.04** (`webcodecs-video-path.md`'s Phase 1, `pcm-buffer-playback.md`, `audio-debugging`
skill). The hardware description here (2012 MacBook Pro, Intel HD 4000 + Nvidia GK107M)
does match the rest of this doc's own cluster (this doc + `webcodecs-video-not-rendering.md`,
same 2026-08-02 session) and other MacBook-Pro-hardware docs elsewhere, so this reads as the
same physical box moving between OS versions over time (24.04 before 08-02 → 26.04 on 08-02,
reason not documented → 24.04 again from 08-05 onward per `legacy-video-fallback-cost.md`) —
**not confirmed why**, could be a real reinstall, could be something else; re-run the
identify commands in `docs/environment.md` rather than trusting a version number by date.
Separately: cuemark is also developed/tested on at least one other physical machine
(`mele`, an Intel N150 box unrelated to this MacBook Pro) — see `docs/environment.md` for
the full machine matrix. Treat any specific package/version number in this doc as dated
2026-08-02 and re-check on whichever machine you're actually on before trusting it.

- 2012 MacBook Pro (MacBookPro9,1/10,1-class), dual-GPU (Intel HD 4000 + Nvidia GK107M).
  Nvidia GPU disabled via `nouveau` blacklist (see `~/mbpr/gpu-thermal-notes.md`) — but
  its HDA audio function still enumerates as ALSA card 0 (`HDA NVidia`), separate from
  the graphics driver.
- **Ubuntu 26.04 LTS** ("resolute") — a very recent release, freshly installed.
- `pipewire 1.6.2`, `gstreamer 1.28.2`, `wireplumber 0.5.13` — all current versions.
- Audio hardware in play during this investigation:
  - `alsa_output.pci-0000_00_1b.0.analog-stereo` — built-in "HDA Intel PCH" (card 1,
    `hw:1,0`). Referred to below as "local analog" / "built-in."
  - `alsa_output.usb-Guillemot_Corporation_DJControl_Starlight-00.analog-surround-40` —
    Hercules DJControl Starlight's onboard 4-channel USB audio codec (card 2,
    `Starlight`). Exposes one PipeWire node with `audio.position` = 4 channels
    (FL,FR,RL,RR); front pair = main out, rear pair = cue/headphone.
- cuemark itself has previously worked live on other machines (this repo has a long
  history of confirmed live audio playback) — so this is a bring-up problem specific to
  this platform/OS combination, not a regression in previously-working code.

## Three bugs found and fixed this session

### 1. Waveform race condition (`ensure_cached()` vs `lookup_wait()`)

Symptom: waveform rendered silent/blank when loading a Digger track with the NAS
unmounted (media fetched from Digger's remote-cache fallback, see
`skills/digger-integration/SKILL.md`).

Root cause: `audio_analyze_file` and `video_demux_load` called `media_cache.rs`'s passive
`lookup_wait()` (returns `None` immediately if no cache entry exists yet) instead of
`ensure_cached()` (the only chokepoint that actually primes the cache, including the
Digger fallback fetch). Whichever Svelte `$effect` fired first — waveform analysis vs.
`audio_load` — won the race; the loser saw an empty cache and silently fell back to the
unreachable original NAS path.

Fix: both `audio_analyze_file` and `video_demux_load` now take their own `fallback_url`
and call `ensure_cached()` directly, same as `audio_load`. **User-confirmed fixed.**

### 2. App-wide freeze on `audioPlay` — mutex held across a blocking PipeWire call

Symptom: pressing Play with a real Hercules USB device configured froze the *entire*
app (all windows, all IPC) — not just playback. GNOME's compositor showed "'Cuemark' Is
Not Responding." First live occurrence recreated and captured with `gdb`.

Root cause (confirmed via two live gdb captures of the parent `cuemark` process, not
guessed): in this Tauri+GTK(`tao`)+WebKitGTK stack, synchronous `#[tauri::command]`
handlers run directly on the GTK main thread — the same thread every window's event loop
and every IPC dispatch depends on. `audio_play`'s call chain
(`DeckAudioPipeline::play()` → `gstreamer::ElementExt::set_state(Playing)`) blocked on
GStreamer's PipeWire sink element (`pw_thread_loop_lock()`), and since the command was
synchronous, that block froze the whole app.

First fix attempt — `spawn_blocking` alone — was **insufficient**: it moved the blocking
call off the GTK thread, but the closure still held `state.lock()` (the shared
`Mutex<AudioManager>`) for the whole blocked duration. `audio_get_position`, polled every
rAF frame directly on the GTK main thread, immediately queued behind that same mutex,
reproducing an identical-looking freeze via lock contention instead of a direct blocking
call. Confirmed via a second gdb capture: `audio_get_position` (frame captured mid-wait)
parked on `Mutex::lock` for `AudioManager` while `audio_play`'s background thread sat in
`pw_thread_loop_lock()`.

Real fix: `audio_play`, `audio_set_main_devices`, and `audio_set_cue_device` (the latter
two hold the lock across a *loop* over every pipeline — an even bigger exposure) now use
the pre-existing `with_pipeline_detached()` pattern (already used correctly by
`audio_pause`/`audio_stop_scratch`): remove the pipeline from the map under a brief lock,
release the mutex, run the blocking call on the detached object, reinsert. **Confirmed
fixed via a follow-up live freeze test** — gdb showed the GTK main thread healthy
(`gtk_main_iteration_do`, not blocked) while the play call was still stuck on PipeWire in
its own isolated background thread. This surfaced the next issue:

### 3. PipeWire *daemon* deadlock + corrupted device IDs (channel-remap parser bug)

With bug #2 fixed, a stuck `audio_play` call no longer freezes cuemark's UI — but it was
still stuck, and `pw-cli`/`pw-dump` (external processes, no cuemark code involved) also
hung until the stuck cuemark process was killed. This means PipeWire's own daemon-side
node-negotiation thread was deadlocked, not just a cuemark-side wait. gdb on the parent
process showed a non-cuemark thread, `"pipewire-main-l"` (PipeWire's own graph thread,
confirmed by thread name and the fact it belongs to the same PID as the whole app since
`pipewiresink` runs PipeWire client code in-process), stuck in
`pw_impl_node_set_state()` → deep in `spa-0.2/audioconvert/libspa-audioconvert.so` →
`g_cond_wait()` in `libgstpipewire.so`.

Initial hypothesis: two `pipewiresink` elements (main output + cue) both targeting the
Hercules's single 4-channel node without channel disambiguation, colliding on the same
physical channels. Investigating the existing channel-remap machinery
(`compute_cue_remap()` in `pipeline.rs`, which is supposed to route cue to the *rear*
pair via a GStreamer mix-matrix + channel-mask so it doesn't collide with main's *front*
pair) turned up a real, live bug:

`devices.rs`'s `parse_pw_dump()` assumed `audio.position` is a bare comma-separated
string (`"FL,FR,RL,RR"`, matching its own unit test fixtures) and split+trimmed it
directly. **Real `pw-dump` output on this machine/PipeWire version wraps it in brackets
with spaces** (`"[ FL, FR, RL, RR ]"`) — confirmed by querying `pw-dump` directly. Since
`.trim()` only strips whitespace, not brackets, this corrupted the first/last channel
tokens (`"[ FL"`, `"RR ]"`) in every generated device ID for this multi-channel device.
Downstream, `compute_cue_remap` couldn't parse these corrupted tokens, silently returned
`None` (no remap), and the cue branch fell through to a plain, undisambiguated
`pipewiresink` targeting the same node as main — the exact collision the remap mechanism
exists to prevent.

Two fixes applied:
- `devices.rs`: strip a leading `[` / trailing `]` before splitting `audio.position`.
  Added a regression test (`pw_dump_strips_brackets_from_real_audio_position_format`)
  using the real bracket-wrapped format, since the existing fixtures never caught this.
- `pipeline.rs`: `compute_cue_remap` now returns `Result<Option<CueRemap>, String>`
  instead of silently treating a parse failure as "no remap needed." A malformed device
  ID now logs loudly and routes the cue branch to `fakesink` — safe — instead of an
  unmapped real sink that risks exactly this collision. (`AudioSettings.svelte` also
  gained an on-mount auto-heal that drops any persisted device id no longer present in
  the live device list — the corrupted ids were otherwise invisible/unclearable through
  the checkbox-list and `<select>` UI, since neither renders a checked/selected state
  for an id that matches nothing.)

**This did NOT fix the underlying hang** — see below. It closed a real, separate bug
(the corrupted IDs, and the cue branch's unsafe fallback), but the Paused→Playing stall
persisted afterward.

> **2026-08-02 follow-up on bug #3.** The bracket-stripping parser fix and the
> `Result`-returning `compute_cue_remap` are both still correct and worth keeping. But
> the *diagnosis* attached to them was wrong in two ways:
>
> - The channel collision was never the trigger. Two `pipewiresink` elements deliberately
>   targeting the same node on the same channels, in one process, run fine
>   (verified directly: `tee` → stereo sink + 4-channel remapped sink, both to the
>   Starlight, clean EOS). What matters is the *count* of `pipewiresink` elements, not
>   what they target — a second sink pointed at a completely different card deadlocks
>   just as readily.
> - It was not "PipeWire's daemon-side node-negotiation thread." The stuck
>   `pw_impl_node_set_state()` frame is in **cuemark's own process** — `pipewiresink`
>   runs an in-process client node (`library.name = "audioconvert/libspa-audioconvert"`),
>   so those `libspa-audioconvert` frames are client-side, not daemon-side. The daemon
>   itself is healthy throughout; all three of its threads sit in `ep_poll`.

## ~~OPEN ISSUE: `pipewiresink` hangs on Paused→Playing, isolated to PipeWire itself~~ (WRONG — see Correction)

After fixing all three bugs above, the hang was still 100% reproducible — and follow-up
tests ruled out every cuemark-side explanation:

1. **Retested with the Hercules USB device**, freshly-repicked clean device IDs, PipeWire
   services (`pipewire`, `pipewire-pulse`, `wireplumber`) restarted to rule out any
   wedged state from repeated `kill -9`s during earlier debugging: **same hang.**
2. **Retested with Main routed to "local analog" only** (built-in `HDA Intel PCH`, USB
   device entirely unchecked): **same hang.** This ruled out the Hercules
   device/surround-40 profile as the cause.
3. **Bare `gst-launch-1.0` reproduction, zero cuemark code involved:**
   ```
   gst-launch-1.0 audiotestsrc num-buffers=200 ! audioconvert ! audioresample \
     ! pipewiresink target-object="alsa_output.pci-0000_00_1b.0.analog-stereo"
   ```
   Output: `Setting pipeline to PLAYING ... / Redistribute latency... / New clock:
   pipewireclock0` — then hangs indefinitely (`timeout 8` had to kill it). **Identical
   symptom to cuemark**: succeeds through Paused, hangs specifically entering Playing.
   This proves the bug is in the PipeWire/GStreamer stack itself on this machine, not in
   any cuemark Rust code, stream-properties, or pipeline topology.
4. **Raw ALSA sanity check** (`speaker-test -D hw:1,0 -c 2 -t sine -f 440 -l 1`, entirely
   bypassing PipeWire): **user confirmed audible tones** — the hardware and kernel ALSA
   driver work fine. (The process didn't exit cleanly within the test timeout window,
   but that's very likely ordinary `speaker-test -l 1` behavior/timing, not a hang
   signature — real audio was produced, which is the decisive fact.)

~~**Conclusion: this is a PipeWire-level (or PipeWire↔ALSA-plugin-level) bug or
misconfiguration on this specific fresh Ubuntu 26.04 / PipeWire 1.6.2 install**,
triggered by any `pipewiresink`'s Paused→Playing transition against either of this
machine's two tested ALSA-backed sinks. It is not specific to cuemark, to the Hercules
device, to multi-channel remapping, or to anything in this session's other three fixes.~~

**This conclusion is wrong.** See below.

### Evidence from the original live cuemark captures (retained)

These are the gdb captures taken from the real app during the 2026-08-01/02 session
(scratchpad captures are session-ephemeral, so they are inlined here). They were
originally read as proof of a *daemon-side* deadlock; they are not that, but they remain
useful — they are the same two stacks the standalone reproducer produces, which is what
ties the app's freeze to the `libgstpipewire` lock inversion described below.

Stuck-thread backtrace, second live incident (parent `cuemark` process, PID varies per
run — this shape recurred across multiple independent test runs). Despite the
`pw_impl_node_set_state()` frame, this thread is **in cuemark's process**, not the
daemon: `pipewiresink` runs an in-process client node:

```
Thread N (pipewire-main-l):
#0  syscall () ...
#1  g_cond_wait () at libglib-2.0.so.0
#2  ??? () at libgstpipewire.so
#3  ??? () at libpipewire-0.3.so.0
#4  ??? () at spa-0.2/audioconvert/libspa-audioconvert.so   (×3 frames)
#7  pw_impl_node_set_state () at libpipewire-0.3.so.0
#8  ??? () at pipewire-0.3/libpipewire-module-client-node.so  (×2 frames)
#10 ??? () at pipewire-0.3/libpipewire-module-protocol-native.so  (×2 frames)
#12 ??? () at spa-0.2/support/libspa-support.so
#13 ??? () at libpipewire-0.3.so.0
#14 start_thread ...
```

cuemark/GStreamer-side stuck frame (consistent across all runs, both before and after
the `with_pipeline_detached` fix — only *which* thread it blocks changed):

```
#0 futex_wait ...
#5 pw_thread_loop_lock () at libpipewire-0.3.so.0
#6 ??? () at libgstpipewire.so
... DeckAudioPipeline::play() → gstreamer::ElementExt::set_state(Playing)
```

Log signature (both cuemark and bare `gst-launch-1.0`): `Ready → Paused` transition and
`async-done` always complete normally and quickly; nothing is ever logged after the
Playing transition starts. No GStreamer bus ERROR message, no timeout, no crash — just
silence, matching a true deadlock rather than a slow-but-eventually-failing negotiation.

`pw-cli`/`pw-dump` hang while a client is stuck this way, and killing the stuck client
process (not the daemon) is enough to unstick PipeWire again. ~~The daemon's own
graph-negotiation thread was waiting on something tied to that one client's connection.~~
Corrected 2026-08-02: the daemon is not involved — it stays in `ep_poll` throughout. The
stalled graph belongs to the client's stranded node, and every other client that touches
that graph blocks behind it.

## Correction: why the "bare `gst-launch`" test was invalid

Test 3 above — the bare `gst-launch-1.0` pipeline said to prove "zero cuemark code
involved" — **was run while an already-deadlocked cuemark process was still resident on
the machine.** That is the whole error. A deadlocked `pipewiresink` client holds its node
half-way through a state transition, and that wedges the shared graph for *every* other
PipeWire client on the system. So the bare pipeline did hang — but because of cuemark,
not instead of it.

Re-run on 2026-08-02 with the stuck cuemark process killed and nothing else changed:

| test | with stuck cuemark resident | after `kill <cuemark>` |
|---|---|---|
| `pw-play --target=37 test.wav` | hangs until killed | exits 0 in 4.8s |
| `gst-launch-1.0 audiotestsrc ! … ! pipewiresink target-object=…` | hangs until killed | `Got EOS`, clean exit in 2.4s |

Nothing else was touched between those two columns — no reboot, no service restart, no
config change. Every one of the "suggested next steps" the old conclusion implied
(reboot, `PIPEWIRE_LATENCY` overrides, quantum tuning, hunting an upstream PipeWire
release regression) was chasing a symptom cuemark itself was causing.

Two further observations from the same session, both of which the "PipeWire is broken"
reading had backwards:

- **The PipeWire daemon is never deadlocked.** During a live hang all three daemon
  threads (`pipewire`, `module-rt`, `data-loop.0`) sit in `ep_poll`, and `data-loop.0`
  holds `RTPRIO 20 / SCHED_RR` as expected. `pw-cli`/`pw-dump` hanging is a *downstream*
  effect of the wedged client, not evidence of daemon-side corruption.
- **`target-object` was not being honoured the way the old test 2 assumed.** With the
  Starlight as the default sink, `pw-play --target=37` (the built-in) still got linked by
  WirePlumber to node 61 (the Starlight), with its links stuck in `[init]`. So "retested
  with Main routed to local analog only: same hang" never actually routed away from the
  Hercules — that test could not have ruled the device out. (It is ruled out anyway, but
  for a different reason: the deadlock reproduces against the built-in card too.)

## Actual root cause: AB-BA lock inversion in `libgstpipewire.so`

Confirmed by `gdb` on a standalone Python reproducer — no cuemark, no Tauri, no GTK,
no WebKit. Two threads, each holding what the other needs:

```
Thread 13 ("set_state(PLAYING)" caller):
#3  ___pthread_mutex_lock                          <-- blocked
#4  ??? spa-0.2/support/libspa-support.so
#5  pw_thread_loop_lock ()          libpipewire-0.3.so.0
#6  ??? gstreamer-1.0/libgstpipewire.so
#7  gst_element_change_state ()     libgstreamer-1.0.so.0
    ... GstBin state change, PAUSED -> PLAYING

Thread 5 ("pipewire-main-l" — HOLDS the mutex thread 13 wants):
#1  g_cond_wait ()                  libglib-2.0.so.0     <-- blocked
#2  ??? gstreamer-1.0/libgstpipewire.so
#3  ??? libpipewire-0.3.so.0
#4-6 ??? spa-0.2/audioconvert/libspa-audioconvert.so
#7  pw_impl_node_set_state ()       libpipewire-0.3.so.0
#8-9 pipewire-0.3/libpipewire-module-client-node.so
#10-11 pipewire-0.3/libpipewire-module-protocol-native.so
```

The PipeWire thread-loop, **while holding its own loop lock**, dispatches a node state
change from the server and calls down into `libgstpipewire`, which then waits on a
`GCond` that only the GStreamer streaming/state-change thread can signal — and that
thread is itself blocked acquiring the loop lock the pw thread already holds. Neither
side can advance, forever. No timeout, no bus ERROR, no crash: exactly the "silence
after the Playing transition starts" signature described earlier.

This is byte-for-byte the same pair of stacks captured live from cuemark in the earlier
session. The bug is in gst-plugin-pipewire 1.6.2, not in cuemark's Rust — but cuemark's
*configuration* is what makes it fire every time.

A related PipeWire-internal assertion fires from the same code path on the
PLAYING→PAUSED direction, corroborating that the loop's lock accounting is what breaks:

```
'impl->recurse > 0' failed at ../spa/plugins/support/loop.c:663 loop_unlock()
```

### Trigger and measured rates

Two ingredients, both necessary:

1. **More than one `pipewiresink` element in the same process.**
2. **A delay between the PAUSED and the PLAYING transition.** Even 1s is enough. This is
   why a one-shot `gst-launch-1.0` pipeline — which runs straight through to PLAYING —
   almost never reproduces it, and why the bug looked like it needed exotic hardware.

Everything else that was previously suspected turned out to be irrelevant. Measured with
`scripts/probes/pipewiresink_multisink_deadlock.py`, 6 runs per configuration:

| configuration | deadlock rate |
|---|---|
| `pipewiresink` × 1 | **0 / 6** |
| `pipewiresink` × 2 | 4 / 6 |
| `pipewiresink` × 3 | **6 / 6** |
| `pulsesink` × 2 | **0 / 6** |
| `pulsesink` × 3 | **0 / 6** |

Independently verified to make **no** difference to whether it deadlocks:

- the 4-channel cue mix-matrix / channel remap (deadlocks without it)
- whether the cue valve is dropping buffers, i.e. whether the cue sink is starved
- whether the second sink targets the *same* node as the first or a different card
- `async=false` on the cue sink (it widens the race but is not required)
- `stream-properties` / `node.latency=1024/48000`
- the Hercules Starlight specifically — the built-in HDA Intel PCH deadlocks identically
- the 44100-only rate of the Starlight's USB codec

### Why it looked like a machine-wide PipeWire failure

Once one `pipewiresink` client deadlocks, its client node is stranded mid
`pw_impl_node_set_state()`. The graph the node belongs to cannot complete a state change,
so **every** client that touches it stalls — including unrelated processes and
`pw-cli`/`pw-dump`/`wpctl`. Killing the one stuck client (not the daemon) releases
everything immediately. That blast radius is what made a single-app bug present as a
fresh-install / new-hardware / new-PipeWire-release problem.

## Fix options for cuemark

In rough order of preference:

1. **Switch `make_sink()` to `pulsesink`** — ✅ **IMPLEMENTED 2026-08-02.** PipeWire's
   PulseAudio compat layer, already running as `pipewire-pulse.service`, so this is still
   PipeWire — just reached through a different GStreamer element. 0/6 deadlocks at both 2
   and 3 sinks. The earlier session's observation that `pulsesink` also hung is another
   casualty of the stuck-cuemark-resident problem — retested clean, it is fine.

   What the switch entailed:
   - `device` instead of `target-object`. The value is unchanged: cuemark's device ids are
     built from PipeWire's `node.name` (`devices.rs`), which is exactly what `pulsesink`
     expects, so the `node@target!full_layout` id format and the `@`-strip in `make_sink`
     both stay as they were.
   - `buffer-time`/`latency-time` (50 ms / 10 ms) instead of the
     `stream-properties node.latency=1024/48000` workaround — `pulsesink` is a
     `GstAudioBaseSink` and has the real properties, which `pipewiresink` lacks.
   - The 4-channel cue mix-matrix remap works unchanged through `pulsesink`.
   - Fallback message now names `gstreamer1.0-plugins-good` (which actually ships
     `libgstpulseaudio.so`), not the non-existent `gstreamer1.0-pulseaudio`.

   **One behavioural regression to be aware of:** an unresolvable `device` does *not*
   error — `pulsesink` silently falls back to the system default sink (verified: a bogus
   device name plays clean with no warning). A stale or corrupted persisted device id
   therefore presents as "audio came out of the wrong device", never as a failure. Given
   bug #3's history with corrupted ids, `AudioSettings.svelte`'s on-mount auto-heal is now
   load-bearing rather than merely tidy.

   Verified: `cargo check` clean, `cargo test` 6/6 passing, and the full deck-topology
   replica (uridecodebin → tee → main sink + remapped cue sink, with PAUSED idle, tempo
   sweep, mid-stream cue-valve open and a pause/play cycle) survives 3/3 with the position
   clock advancing correctly and zero xruns — the exact configuration that deadlocked 3/3
   on `pipewiresink`. Listening tests on the Starlight's rear/cue pair were clean.

   Still unverified: **the real app has not been run against this change yet** — all
   verification so far is the standalone replica. Also unresolved is a transient "steady
   jitter" heard once during replica testing that did not reproduce on a rebuilt
   equivalent topology; the likeliest explanation is residue from deadlocked
   `pipewiresink` processes still resident at the time, but that is unconfirmed. A single
   1–2 sample-drop artifact on the PLAYING→PAUSED→PLAYING cycle was heard and *is*
   reproducible — minor, but worth a look if pause/resume clicks become a complaint.
2. **Collapse to one `pipewiresink` per process.** Structurally hard here: the design is
   ≥1 main device + a cue branch per deck, and every deck adds more. Not realistic without
   reviving the shared-`audiomixer` topology stubbed in `mixer.rs`.
3. **Report upstream.** `scripts/probes/pipewiresink_multisink_deadlock.py` is a clean,
   dependency-free reproducer suitable for a PipeWire GitLab issue against
   gst-plugin-pipewire 1.6.2. Worth doing regardless of which workaround ships.

Whatever is chosen, the freeze watchdog (`docs/design/freeze-watchdog.md`) should treat a
stuck audio state change as a recoverable condition: because the blast radius extends to
every other PipeWire client on the machine, leaving a deadlocked cuemark alive during a
live set takes the whole system's audio down with it.

## Unrelated issue found along the way: the log is unusable for diagnosis

`~/.local/share/com.cuemark.app/logs/cuemark.log` at the end of the hung session
contained **nothing but `[frontend] [heartbeat] rAF alive` lines**, one per second. The
sink configuration, the cue remap decisions and the GStreamer bus messages — everything
this investigation actually needed — had already been flushed out of the rotation window
by heartbeat spam. The rAF heartbeat should drop to `debug`, or be rate-limited to
something like once per 30s, so the log retains real diagnostic history.

## Debugging notes for next time

- **Kill every stuck cuemark before drawing any conclusion from an external tool.** A
  deadlocked `pipewiresink` client makes `pw-play`, `gst-launch-1.0`, `pw-cli`, `pw-dump`
  and `wpctl` all hang. Any "reproduces without our code" test run in that state is
  meaningless. `pgrep -a cuemark` first, every time.
- `ptrace_scope` is `1` on this machine, so `gdb -p <pid>` cannot attach to a process that
  is not a descendant of the debugger. Either launch the target under
  `gdb --batch -ex run --args …`, or have the process abort itself on a watchdog timeout
  so a parent `gdb` catches the signal. `PR_SET_PTRACER` via `ctypes` did *not* work here.
- Cheap triage without a debugger: `cat /proc/<pid>/task/*/comm` and
  `/proc/<pid>/task/*/wchan`. A cuemark whose `pipewire-main-l` thread sits in
  `futex_do_wait` is in this deadlock.
- `wpctl status` shows link state per stream; links stuck in `[init]` (rather than
  `[active]`) mean the graph never started. `pw-top -b` showing quantum `0` on every node
  means nothing at all is being driven.
- Watch out for a subtle trap when writing a Python watchdog for this:
  `pipeline.set_state(...) or event.set()` never sets the event, because
  `Gst.StateChangeReturn.SUCCESS` is truthy. That produces 100%-deadlock false positives.
