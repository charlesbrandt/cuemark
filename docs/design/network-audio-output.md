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
`plex` via a Tailscale subnet route rather than `mele`'s direct LAN path — see
`docs/network-topology.md`'s "Tailscale subnet route" section. That's a network-config problem,
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
this is now the *expected* first check, not a fallback. Automating this (cuemark calling
`Group.SetStream` itself when a target is enabled) is not built; see Open items.

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
  measurement, the commands that produced it and the full topology are in
  `docs/network-topology.md` — that is the canonical home for the network facts; this doc
  only records what they meant for the audio path.

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
  retry-with-backoff on the node's bus ERROR is the obvious next step.
- **`buffer` is not read from the server.** Snapcast's JSON-RPC could report it, which would
  make the delay field self-populating instead of hand-entered. Deliberately not done yet:
  the value that matters is the one the room *hears*, and the server's setting is only a
  lower bound on it.
- **Group routing is entirely manual** (see "Group routing" above) — enabling a target in
  Settings does not point any speaker at it, and there's no cuemark-side indication when a
  group drifts back to `House`. A `Group.SetStream` call from Settings when a target is
  ticked (and back to a stored previous stream when unticked) would close this, but it needs
  a decision about which groups cuemark is allowed to touch — not build yet.
