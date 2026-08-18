# Network audio output — cuemark as a Snapcast source

Status: 🟢 **LIVE-VERIFIED 2026-08-14, audible end to end.** Deck-0 attached to a real
snapserver's `Cuemark` stream, played, and was heard on real speakers (`plex`'s local
client and `kitchen-pi`) after the fixes below and a manual `Group.SetStream` pointing
both groups at `Cuemark` (see "Group routing" below — that step does not persist and
will need repeating). The path from BUILT to here took two more fixes, both below: the
app-wide freeze on an unreachable target, and a Tailscale ACL gap on the machine used
for the live test.

## App-wide freeze on an unreachable target — FIXED 2026-08-14

🔴 **Live-hit, not hypothetical.** Pressing play on a deck routed to a `snapcast://` target
that never answers froze *all* transport control app-wide for ~2 minutes — every deck, not
just the network one — with no error, while the render loop kept ticking fine (`raf`/
`poll-stats` stayed healthy), so it read as "the app is alive but nothing responds," not a
crash.

**Root cause, two layers:**

1. `tcpclientsink` has **no `timeout` property** — checked directly against gst-plugins-base
   1.28 with `gst-inspect-1.0 tcpclientsink`, it genuinely does not exist. Its `connect()` ran
   unbounded, inside `pipeline.set_state(gst::State::Playing)` in `OutputGraph::create_node()`
   (`mixer.rs`), for as long as the OS took to give up on the TCP handshake (~2 minutes on
   Linux for a target that never responds — no RST, just silence).
2. That `set_state(Playing)` call runs while `attach_output_graph()` (`pipeline.rs`) holds the
   **shared output graph's mutex**. Every deck's play/pause/attach path needs that same lock,
   so the hang wasn't scoped to the one silent output the "unattached branch swallows buffers"
   design comment (below, "The shape") assumes — it blocked the whole app's transport control
   for the full ~2 minutes.

The trigger the first time this was hit: a Tailscale ACL grant that allowed `tcp:22`/
`tcp:32400` to the Snapcast host but not its stream/control ports, from a machine that reaches
`plex` via a Tailscale subnet route rather than `mele`'s direct LAN path — see the private
network-topology notes' "Tailscale subnet route" section. That's a network-config problem,
independent of the app bug; **fixing it alone would not have fixed the freeze mechanism**, since
any unreachable target (dead server, wrong port, a different firewall another day) would
reproduce it.

**Fix**: `make_snapcast_sink()` (`pipeline.rs`) now pre-flights the target with a bounded
`TcpStream::connect_timeout()` (3s) *before* ever building `tcpclientsink` or touching the
graph lock — an unreachable target now fails in seconds with a clear error instead of freezing
the app for minutes. Regression guard: `unreachable_target_fails_fast_not_after_minutes` in
`pipeline.rs`'s `snapcast_device_tests`.

**Also fixed: the failure was silent to the user.** A failed attach used to be `log::error!`
only — Settings kept showing the target as configured and checked with no sign it never came
up. `attach_output_graph()` now emits an `output-attach-status` Tauri event (success *and*
failure) that `AudioSettings.svelte` renders as a `⚠ not connected` badge on the target's row,
cleared automatically the next time that device attaches successfully. See
`OutputAttachStatusEvent`'s doc comment in `pipeline.rs` and `outputAttachStatus` in
`audioSettings.ts`.

⚠️ **This only bounds the initial connect.** It does not add reconnect-on-drop — that's still
the pre-existing "No reconnect" open item below, unchanged.

## Post-idle hang, reported 2026-08-15 — 🟡 UNCONFIRMED, two capture attempts, no reproduction yet

User report: deck-0 routed to `snap-192.168.2.97:4953` had been idle (paused) for ~1h40m in a
live instance; on pressing play, heard a brief blip of sound, then the app appeared to hang.
Investigated live, in the same session, within minutes of the report.

**What the log actually shows** (`cuemark.log`, build `0ad671f`, dirty, session started
`18:06:12`): the target attached cleanly at `18:06:12` (`created for deck-0/main1 …
latency=451ms`) and stayed attached with no bus errors for the rest of the session. The
reported play was `19:47:58.318` (`Paused → Playing`) → `19:48:10.930` (`Playing → Paused`,
clean `async-done`) — 12s, no `WARN`/`ERROR`, `poll-stats`/`ipc-ping` round-trips all
single-digit ms. The `[raf]` heartbeat **never gapped** — 5s-interval log lines run
continuously through the whole window and past it — and the watchdog (trips at ≥6s silence)
never logged a `TRIGGER`. At the time of investigation the `cuemark` and `WebKitWebProcess`
processes were alive and `S`-state (not `T`/`D`/stuck), `WebKitWebProcess` at ~4% CPU, and
`192.168.2.97:4953` was reachable. So whatever happened either self-resolved in under ~5s, or
had already fully recovered by the time it was checked — the multi-minute freeze signature
from the bug above (raf gap + watchdog `TRIGGER`) is not present.

**Leading hypothesis, not yet confirmed**: this is the *other* half of the "No reconnect" gap
below, not the connect-timeout bug (which only guards `pipeline.set_state(Playing)` on
*initial* attach — irrelevant here since attach succeeded hours earlier). `tcpclientsink` has
no timeout on ongoing `send()` either. If the network path to `.97` blipped during the idle
stretch (host sleep, Wi-Fi drop, etc.) without a clean RST, a write on the already-established
socket could block the GStreamer streaming thread until the OS's own TCP retransmission gives
up or the path recovers — same shape as the connect bug, on the write side, and it would
produce exactly "plays briefly, then goes quiet" if it stalls right after a few buffers.
Unconfirmed because it never reproduced with anything to inspect.

**If this happens again, capture *during* the stall, before it clears**:
```sh
ss -tni state established '( dport = :4953 )'          # socket send-Q backed up = write blocked
gdb -p $(pgrep -x cuemark) -batch -ex 'thread apply all bt' # which thread, stuck where
```
A backed-up send queue plus a GStreamer thread parked in `send()`/`write()` would confirm the
write-block theory directly. Also check the raf/watchdog log lines at that moment — if this
theory is right, a *real* hit should this time show a raf gap and (past 6s) a watchdog
`TRIGGER`, unlike the 2026-08-15 report.

**Update, same day, second occurrence — socket is healthy; the "dead connection" read was a
misdiagnosis, corrected within the same session.** Ran the capture recipe live on the
recurrence. First `ss` snapshot on the `.97:4953` connection:

```
Send-Q 9600  notsent:9600  snd_wnd:1024  lastsnd:47  lastrcv:8954388  lastack:32  busy:8717400ms
rwnd_limited:3574153ms(41.0%)  retrans:0/259  bytes_sent:1696958440  bytes_acked:1696732801
```

First read of this called `lastrcv` (~2.49h) evidence of a permanently dead half-open
connection. **That was wrong** — `lastrcv` is `tcpi_last_data_recv`, time since a
*data-bearing* segment arrived, not time since any packet. This is a one-way stream (cuemark →
snapcast); the peer has no application data to ever send back, so `lastrcv` is expected to sit
at a huge, ever-growing number **on a perfectly healthy connection** and carries no signal here.
The field that does show freshness is `lastack` (`tcpi_last_ack_recv`) — **32ms**, i.e. the peer
ACKed something 32 milliseconds ago. A second capture ~5 minutes later confirmed it: `lastack`
still single/double-digit ms, `segs_in` +9,111, `bytes_acked` +~64MB, `Send-Q` shrinking
(9600→7552). **The socket is actively exchanging data, not stuck.** `snd_wnd:1024` and
`rwnd_limited` ~41-42% just describe a small, steady receive buffer on the snapcast side — not
evidence of failure.

`gdb -p $(pgrep -x cuemark) -batch -ex 'thread apply all bt'` also **failed**: `ptrace:
Operation not permitted` (`yama/ptrace_scope` blocks a non-parent, non-root attacher on this
machine). Needs `sudo gdb -p …` or a temporary `echo 0 | sudo tee /proc/sys/kernel/yama/ptrace_scope`
next time. Substituted `/proc/<pid>/task/*/{status,wchan}` (no ptrace needed) across all 54
threads: every thread was `S` (sleeping) on an ordinary wait (futex, poll, hrtimer,
`inet_csk_accept`), none parked in a write/send syscall — consistent with the socket being fine,
not with a blocked write that just happened to not need ptrace to see. `cuemark.log`'s `[raf]`
heartbeat was clean and continuous (`~60.0fps`, no gaps) throughout.

**Net effect: the send()-blocking / dead-socket hypothesis has no supporting evidence from either
capture**, and the "half-open connection with no keepalive" theory above is retracted pending a
capture that actually shows a stale `lastack`. What *is* still true and load-bearing: `gdb`
needs sudo/ptrace_scope adjustment ahead of time, not discovered mid-stall, and `lastrcv` must
never again be read as connection health for this one-way stream — `lastack` is the field to
watch.

**New lead**: the user's stop/pause action on the deck may be more relevant than idle duration
— worth checking whether the original report's "brief blip, then hang" correlates with a
play→pause or pause→play transition on the network-routed deck specifically, rather than with
how long it had been idle. Not yet investigated; check `audio_pause`/`audio_play` timestamps
in `cuemark.log` against the report time if it recurs.

**Still 🟡 UNCONFIRMED overall** — no reproduction has yet shown a raf gap, a watchdog
`TRIGGER`, a stale `lastack`, or a thread blocked in a syscall. Two capture attempts, two
different (and partly contradictory) leads, nothing confirmed yet.

## Group routing — live-confirmed 2026-08-14, and it is a real trap

After the freeze fix and the ACL fix above, cuemark attached to the `Cuemark` stream cleanly
(log showed `attached deck-0/main1`, no errors) and deck-0 played — and the room was still
silent. `Server.GetStatus` explained it in one look: **both connected client groups (`plex`'s
own client, `kitchen-pi`) had `stream_id: "House"`** — the pre-existing `meta:///Spotify/AirPlay`
combination — not `Cuemark`. Nothing was wrong with cuemark, the network path, or snapserver's
config; the speakers were simply listening to a different stream.

Fixed for this session with `Group.SetStream` per group:
```sh
curl -s -X POST http://10.20.2.97:1780/jsonrpc -d \
  '{"id":1,"jsonrpc":"2.0","method":"Group.SetStream","params":{"id":"<group-id>","stream_id":"Cuemark"}}'
```
`Server.GetStatus`'s `groups[].id` gives the ids; `groups[].clients[].host.name` says which
physical client each one is.

🛑 **This does not persist.** It's a live server-side setting, not config — a snapserver
restart, or anyone using Spotify/AirPlay again (which likely switches the group back to
`House`), silences cuemark again with zero indication anywhere in cuemark's own logs, because
from cuemark's side the attach is still healthy and buffers are still flowing. **When "cuemark
looks fine but the room is silent," check group routing before anything on cuemark's side** —
this is now the *expected* first check, not a fallback. Since 2026-08-16 the switching itself
is automatic — see "Group claiming" below; this section stays because the *non-persistence*
trap is unchanged: a snapserver restart mid-set still resets groups to its config defaults
and nothing re-claims them until the target is toggled or the app restarts.

## Group claiming — built 2026-08-16

Ticking a network target's Stream checkbox now **points every group on that server at this
app's stream**, and unticking gives each group back what it was on before — no manual
`Group.SetStream`, no forgotten-switchback silence. Code: `audio/snapcontrol.rs`, hooked into
`audio_set_main_devices` (which diffs the device list under its existing no-op guard, so each
toggle claims/releases exactly once) plus a `RunEvent::Exit` hook in `lib.rs` that releases on
clean app quit. No frontend changes: the Stream checkbox already drove `mainOutputDeviceIds`.

How it finds *our* stream without hardcoding a name: `Server.GetStatus` exposes each stream's
source `uri`, so the claim matches the target's port against the `tcp://` source's port
(`uri.host` arrives as `"0.0.0.0:4953"`). The JSON-RPC endpoint is snapserver's own default
port `1780` — a different listener than the audio port in the device id, which is why it
can't be read out of the id.

Deliberate semantics, all tested in `snapcontrol.rs` against a scripted fake server:

- **Claim takes every group on the server** (the "which groups may cuemark touch" decision
  from the old open item: all of them — a Snapcast server whose groups cuemark shouldn't
  touch is a second server, i.e. a second target).
- **Release restores only what still makes sense**: a group that vanished, was re-routed by
  someone else mid-claim, or whose saved stream no longer exists is left alone, never
  stomped.
- **A group already on our stream at claim time is a crash leftover** — its true prior stream
  is unknowable, so the claim records the server's `meta://` stream instead (the one stream
  that hands the speakers to whichever source is producing). Unticking then restores normal
  service even after an unclean exit; a clean quit releases on the spot.
- **Failure is logged, never propagated**: audio reaches the `tcp://` source regardless of
  group routing, so an unreachable RPC port degrades to the old manual-switch behaviour, not
  to silence. Untick/retick once the server is reachable to retry the claim.

Two routes were considered. **Route A (this one) — cuemark connects to a Snapcast server's
`tcp://` stream source and pushes raw PCM.** Route B — send AirPlay to the `shairport-sync`
instance snapserver already spawns, needing no cuemark code at all. Route B was tried first
as a cheap latency probe and is **impossible on a routed/NAT'd network**; see "Why not
AirPlay" below, because the failure is silent and someone will try it again.

## The shape

```
cuemark (deck mix)                                    snapserver                 clients
  audiomixer → master volume → audioconvert           tcp:// source  → meta? → snapclients
    → S16LE/48000/2 → queue(leaky) → tcpclientsink ═══════════►
                                                 one outbound TCP connection
```

A network target is an ordinary member of the shared output graph — its own `OutputNode`,
keyed by the whole `snapcast://host:port` id, with the same `audiomixer`, the same per-node
master volume, and the same silent keepalive as a local device. Nothing about decks,
crossfading, cue or scratch is special-cased. A deck can feed the booth and the house at the
same time simply by having both checked in Main.

Code: `make_snapcast_sink()` / `parse_snapcast_device()` in `audio/pipeline.rs`,
`OutputGraph::set_extra_latency()` / `latency_handle()` in `audio/mixer.rs`, the
`audio_set_output_latency` command in `audio/mod.rs`, and the `networkOutputs` store +
Settings UI on the frontend.

## Configuration — nothing about a particular network is in the code

Targets are **configured in Settings, not discovered and not hardcoded**: host, port, label,
and the delay below. Discovery is deliberately not attempted — a Snapcast server is reached
by address, and mDNS does not cross a routed subnet boundary, so on many networks (including
the one this was built on) discovery cannot work even in principle.

They persist in `cuemark:networkOutputs`. The backend's `list_audio_devices` enumerates local
PipeWire sinks only, so `AudioSettings` merges the configured targets into the device list
**before** its stale-id auto-heal runs — an id the heal cannot see is an id it silently
deletes, which is why the list has to reach the picker rather than living only in
`mainOutputDeviceIds`.

The Stream checkbox in the Net row is the same state as the Main checkbox for that target,
on purpose. Two independent notions of "enabled" would eventually disagree, and the
disagreement presents as silence with the toggle reading on.

### Server side (Snapcast)

One line in `/etc/snapserver.conf`, then restart the service:

```
source = tcp://0.0.0.0:4953?name=Cuemark&mode=server&sampleformat=48000:16:2
```

`mode=server` means snapserver listens and cuemark connects out, so either side can restart
independently. The sample format must match what the sink sends (it is snapserver's own
default).

🛑 **Do not add this source to a `meta://` stream.** Every output node carries a permanent
silent `audiotestsrc` keepalive — three separate things in `OutputGraph::create_node` depend
on it — so cuemark's TCP source is **always producing audio**, even with no deck loaded. A
meta stream selects the first *playing* source, so a permanently-playing one takes the
speakers and never gives them back: Spotify and AirPlay would never be selected again.
Switch groups to the `Cuemark` stream deliberately instead (`Group.SetStream` over the
server's JSON-RPC), or accept that this output is a separate stream by design.
`snapcast_node_streams_pcm_and_carries_its_configured_latency` in `mixer.rs` pins the
keepalive behaviour that makes this true.

## Latency, and which output the video is in sync with

⚠️ **GStreamer's latency query cannot see past the socket, and never will.** It ends at
`tcpclientsink`; the receiving server's `buffer` and its clients' presentation delay are on
another machine. Uncorrected, a deck routed to the house reports that far ahead of what the
room hears — and since audio is the master clock, the projector runs ahead of the music by
the same constant. It reads exactly like "the video decoder is early", which this project has
already chased into the wrong file once (see `OutputGraph::latency_ns`).

So the delay is **declared, not measured**: the per-target `delay` field in Settings, pushed
down by `audio_set_output_latency` and added to the queried latency. It defaults to **0
(uncorrected)** — the app has no way to know it, and a plausible-looking guess would be worse
than an obvious zero. For Snapcast it is the server's `buffer` setting (Snapcast's own default
is 1000ms; a tuned wired LAN can run far lower) plus client delay. Snapcast holds that
deterministically by design, which is why a constant offset is the right model rather than an
estimate.

It applies **live**, to a deck already playing — `output_latency_ns` is an `Arc<AtomicU64>`
shared with the node rather than a value copied at attach time, precisely so it can be tuned
by ear against a real room. A correction that only took effect on the next track load could
not be tuned at all.

⚠️ **It only moves the video when the network target is the deck's *first* main output.**
`attach_output_graph()` takes the position correction from branch 0. That is the knob for
"which output is the projector in sync with", and **you cannot have both**: list the booth
monitor first to sync video to the booth, list the house first to sync it to the room.

### The other two offsets, which are not this one

- **Booth vs house echo.** Snapcast syncs its clients to each other, not to a local sink.
  Running a local device and the house in one room puts the same audio ~`buffer` ms apart.
  The lever is `ts-offset` on the *local* sink (positive delays rendering) to match. Not
  built, not measured — reach for it only if both outputs are audible in one space.
- **Monitoring.** Keep the cue branch on a local device, always. That is what makes the
  network delay tolerable at all: beatmatch and cue against a local monitor while the room
  hears a delayed feed. Scratch and jog gestures land in the room a full buffer late no
  matter what, so this is a house/secondary-room output, not a dance-floor mixing target.

## A dead server must not stall the booth — and nearly does

The deck's `tee` has **no per-branch queue**, so backpressure from any one branch stalls
*every* branch: booth monitor, cue and all. A blocked TCP write — dead server, wedged
snapserver, saturated link — propagates back through the mixer and the appsink→appsrc
handoff (`block=true`) into the deck itself.

`leaky=downstream` on the queue inside `make_snapcast_sink()` is what prevents that. It never
blocks upstream; it discards. The room glitches, the booth does not. **This is load-bearing
and silent when removed.**

Measured 2026-08-13 with `scripts/probes/snapcast_tcp_sink_probe.py`, against a server that
accepts the connection and never reads:

| arm | booth branch, final 2s | verdict |
|---|---|---|
| `--stall` (shipping: leaky) | **94 buffers** — the healthy rate | isolated |
| `--stall --no-leaky` (control) | **0 buffers** | whole deck stalled |

⚠️ **Two things about that measurement, both of which made the probe lie at first:**

1. **The window must be the *end* of the run, not the whole of it.** A total across the run
   counts the healthy opening seconds and reads as "still flowing" regardless.
2. **A stalled reader does not stall the sender for ~21 seconds.** Kernel socket buffers
   autotune into the megabytes (`tcp_wmem` max 4MB ÷ 192KB/s), on top of the branch queues.
   The first two attempts at the control arm ran 12s and 15s, **passed**, and therefore
   proved nothing. The probe now pins `SO_RCVBUF` small and defaults `--stall` to 35s.

An instrument that cannot register the fault it checks for carries no information about it.
Run `--stall --no-leaky` and watch it fail before trusting `--stall` passing.

## Why not AirPlay (Route B) — measured, not assumed

Route B needed no cuemark code: PipeWire's `libpipewire-module-raop-sink` pointed at the
`shairport-sync` snapserver already runs, appearing as an ordinary `Audio/Sink` that the
existing device picker lists.

It got as far as an established RTSP control connection and then produced **no audio, with no
error anywhere** — snapserver's AirPlay stream stayed `idle` while the sink read `running`
locally. Two independent blockers, both structural:

- **mDNS does not cross a routed subnet boundary**, so the endpoint cannot be discovered and
  must be configured by hand (workable — that part was done).
- **RAOP requires the receiver to send timing and retransmit requests back to the sender.**
  Behind one-way NAT those never arrive. Verified directly: a UDP packet sent from the server
  to the sender's port never arrived, while the sender's outbound TCP worked fine. The
  measurement, the commands that produced it and the full topology are tracked privately, not
  in this repo; this doc only records what they meant for the audio path.

This is not a tuning problem and no amount of buffer configuration reaches it. Route A works
on the same network precisely because it is **one outbound connection with no return path**.

If a machine ever sits on the same subnet as the Snapcast server, Route B becomes viable
again as a zero-code option — at AirPlay's own latency, which is considerably worse than
Route A's. The working config is preserved in this doc's history rather than in the repo.

## Open items

- ~~Not yet heard~~ — **done 2026-08-14**, see Status above. The delay value is still unset
  and needs tuning by ear against the room now that it's audible at all.
- **No reconnect.** `tcpclientsink` does not retry. A server restart mid-set leaves that node
  erroring; the deck keeps playing and every other output is unaffected (attach failures are
  already non-fatal — `attach_output_graph()` leaves an unattached branch silently swallowing
  buffers rather than blocking), but the house stays dead until the deck is re-routed. A
  retry-with-backoff on the node's bus ERROR is the obvious next step. ⚠️ That's the clean-RST
  case. `tcpclientsink` also has no timeout on ongoing `send()` — a target that goes silent
  without closing the connection (sleep, dropped Wi-Fi) can block the streaming thread instead
  of erroring; see "Post-idle hang, reported 2026-08-15" above for the unconfirmed live report
  and the capture recipe for next time.
- **`buffer` is not read from the server.** Snapcast's JSON-RPC could report it, which would
  make the delay field self-populating instead of hand-entered. Deliberately not done yet:
  the value that matters is the one the room *hears*, and the server's setting is only a
  lower bound on it.
- ~~**Group routing is entirely manual**~~ — **built 2026-08-16**, see "Group claiming"
  above. Remaining edge, accepted for now: a snapserver restart mid-set resets groups to its
  config defaults and nothing re-claims until the target is toggled or the app restarts
  (re-claiming on a server-elected `Server.OnUpdate`-style notification would need a
  persistent subscription, which nothing else here maintains yet).
