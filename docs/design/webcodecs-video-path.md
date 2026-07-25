# WebCodecs video path: replacing the `<video>` element for deck playback (design)

Status: **approved direction, not yet implemented.** Feasibility spike completed 2026-07-25
(results below — all gates passed). Companion doc: `freeze-watchdog.md` (ships first;
independent of this work but makes any remaining webview failure recoverable).

## Why this exists

Both live-performance freeze mechanisms documented in `pcm-buffer-playback.md`
("Ninth mechanism" and "Tenth mechanism") are bugs inside WebKitGTK's own
`MediaPlayerPrivateGStreamer` — the machinery behind the `<video>` element:

- **Mechanism A**: AB-BA deadlock between the GTK/JS main thread (inside the
  synchronous `gst_element_send_event()` a `v.currentTime` seek triggers) and WebKit's
  internal streaming thread. Permanent main-thread freeze. Trigger: any seek issued
  while the internal pipeline is mid-flight — the drift-correction resync, **every loop
  wraparound** (`v.currentTime = loopIn`), hot cues, snap-quantized jumps.
- **Mechanism B**: WebKit's internal pipeline mishandles EOS/segment bookkeeping when
  `segment.rate != 1.0` (any `v.playbackRate != 1.0`) — video element starves near
  track end, main thread stays alive. Mitigation was built and reverted after three
  compounding regressions (see "Eleventh mechanism"); unmitigated by deliberate choice.

Every fix to date has been "poke WebKit's media player less often" (rAF throttling,
rate tolerance guards, drift threshold 80→250 ms, rate-then-seek ordering). That
approach hit its ceiling. The structural problem: **the authoritative clock lives in
Rust (GStreamer audio), but video decode and its clock live inside a third-party black
box, and keeping them in sync requires exactly the two operations WebKit's media player
handles worst — seeks during playback and non-1.0 playbackRate.**

WebCodecs dissolves this. `VideoDecoder` is a decode-only primitive: no internal
pipeline, no segments, no rates, no EOS bookkeeping, no seeks — none of the buggy
layers are involved. We feed it encoded chunks; it hands back `VideoFrame`s; we present
the frame whose timestamp matches the Rust audio clock. Sync is correct **by
construction**:

- No `v.playbackRate`, ever → mechanism B cannot occur; the WebKit-pipeline-rebuild
  dance, the 0.005 rate-tolerance guard, and the rate-then-seek ordering constraint all
  become dead code on this path.
- No `v.currentTime` writes, ever → mechanism A cannot occur; the drift-correction
  resync, `contentPosTracker` integration, and `pendingSeekTarget` filter become
  unnecessary on this path (the audio clock is consumed directly).
- Loops stop issuing seeks at all (the feeder just continues from the loop-in chunk).
- Reverse video scratch (impossible with `<video>`) becomes feasible — same
  buffer-walking idea as the audio PCM scratch branch.

This continues the project's established trajectory: audio playback, scratch PCM,
waveform analysis, and media serving all moved to Rust/GStreamer specifically to escape
WebKit bugs. Video decode is the last performance-critical subsystem still inside
WebKit's media player. This design removes it — while keeping *presentation* (WebGL
compositing, effects, visualizations) exactly where it is today.

## Feasibility spike results (2026-07-25)

Probes: `scripts/probes/` (`webcodecs_probe.py`, `webcodecs_decode_only_probe.py`,
`webcodecs_perf_probe.py`). They run a bare `WebKit2 4.1` GI webview headlessly under
Xvfb — the **same `libwebkit2gtk-4.1` library Tauri/wry links** — with the app's real
env (`WEBKIT_DISABLE_DMABUF_RENDERER=1`, `GST_PLUGIN_FEATURE_RANK` VA-API demotions).
Machine: Ubuntu 24.04, `libwebkit2gtk-4.1-0 2.52.3-0ubuntu0.24.04.1`.

| Question | Result |
|---|---|
| WebCodecs available? | **Yes, by default.** Feature flags: `WebCodecsVideo` (status *mature*, default on), `WebCodecsAudio` (*stable*), `WebCodecsHEVC` (*mature*), `WebCodecsAV1` (**preview**, default on). No settings toggles needed. |
| API surface | `VideoDecoder`, `VideoFrame`, `EncodedVideoChunk` present in **main thread and Workers**. `OffscreenCanvas` 2D works in workers. |
| `isConfigSupported` | true for h264 (avc **and annexb**), hevc, vp8, vp9, av1. |
| Real decode correctness | 60 real H.264 annex-B AUs (host-encoded via x264): **60/60 frames decoded, zero errors, pixel-exact content** (solid red → (253,0,0)), output format I420. |
| Decode throughput (1080p, software — VA-API demoted) | **153–165 fps** (~6.1–6.6 ms/frame). Two decks at 30 fps ≈ 40% of one core, and decode can run in a Worker off the main thread. |
| Seek pattern (reset + feed from keyframe) | Works. 30-frame keyframe→target catch-up decoded in **5 ms** at 320×240; at 1080p budget ~6.5 ms/frame ⇒ a 60-frame GOP catch-up ≈ 0.4 s worst case — at parity or better vs. today's ">1 s GStreamer seek on a heavy video" (`pendingSeekTarget`'s raison d'être). |
| `texImage2D(VideoFrame)` → WebGL | **Works on a DOM-canvas GL context — no SIGTRAP** (unlike direct `<video>`→texImage2D, which crashes WebKitGTK and forced the scratch-canvas detour in `fbo.ts`). Steady-state 24 ms/frame *under Xvfb/llvmpipe software GL* — must be re-measured on the real GPU before relying on it. Not a gate: see fallback next row. |
| `drawImage(VideoFrame)` → 2D canvas | 6.7 ms/frame at 1080p — same cost class as today's `<video>`→scratch-canvas path. Guaranteed-viable upload path: worst case, frame upload costs exactly what it costs today. |
| WebGL on OffscreenCanvas | **Not available** in this WebKitGTK. Decode can live in a Worker, but GL upload must happen on the main thread. `VideoFrame` is transferable, so this is fine. |
| `VideoEncoder` | **☠ Any real use crashes WebKitWebProcess outright** (SIGABRT: GObject type-system errors registering its internal `webkitvideoencoder` element, then `gst_register_core_elements: code should not be reached`). 100% reproducible. Verified triggers: `VideoEncoder.isConfigSupported(...)` and `encoder.configure(...)`; bare `new VideoEncoder({...})` is lazy and survives, but treat the whole class as untouchable. **Never use `VideoEncoder`; recording stays 100% in Rust (`record.rs`).** Upstream report + standalone reproducer in `docs/upstream/`. |

Caveat: probes ran in a bare GI webview, not inside Tauri. Same library, same env, but
Phase 1 below re-verifies inside the actual app webview before anything else is built.

## Architecture

```
Rust (per deck):                                      Frontend:
  video_demux.rs                                        codecPlayer.ts (Worker)
  parsebin → h264parse → appsink                          fetch AUs (HTTP, binary)
  → Vec<Au{pts, dur, key, data}>  ──media_server──►       VideoDecoder (annexb)
  + keyframe index                    HTTP GET            frame queue (decode-ahead)
  (no decoding — parse only)                                │ transfer VideoFrame
                                                            ▼
                                                      main thread rAF:
                                                        pick frame with pts ≤ audio
                                                        clock (contentPos), upload to
                                                        deck FBO, close() the rest
```

### Rust side: demux service (`src-tauri/src/video_demux.rs`)

- New Tauri command `video_demux_load(deck_id, file_path)`:
  pipeline `filesrc location=<cached-path> ! parsebin ! h264parse config-interval=-1
  ! video/x-h264,stream-format=byte-stream,alignment=au ! appsink` (equivalents for
  hevc/vp8/vp9/av1 — `parsebin` auto-selects the demuxer/parser; caps on the appsink
  pad determine what we request). **No decoder anywhere** — this is parse-only, so it
  runs at I/O speed (a 4-min file demuxes in well under a second) and cannot touch the
  VA-API pitfalls. Reuse the same `media_cache` lookup the audio path uses
  (`lookup_wait`) so demux never reads the SMB original.
- Pull all AUs into memory: `Vec<Au { pts_us: i64, dur_us: i64, key: bool, data: Vec<u8> }>`
  plus a keyframe index `Vec<(pts_us, au_index)>`. Memory is compressed-video-sized
  (a 4-min 8 Mbps clip ≈ 240 MB·bit = 30 MB) — far below the audio PCM buffers already
  held per deck. Store in `Mutex<HashMap<DeckId, DemuxedVideo>>` managed state.
- Returns `{ codec: String, codedWidth, codedHeight, fps_hint, au_count, keyframes: [...],
  duration }`. The `codec` string must be a valid WebCodecs codec string
  (`avc1.PPCCLL` from the SPS profile/level via `h264parse` caps; same idea for
  `hvc1.*`, `vp09.*`, `av01.*`). If the container/codec can't be parsed → return an
  error; the frontend then **falls back to the legacy `<video>` path for that deck**.
- Chunk transport: extend `media_server.rs` with
  `GET /demux/<deck_id>/aus?from=<idx>&count=<n>` → binary body, per-AU framing:
  `[u32 le length][u8 flags(bit0=key)][i64 le pts_us][i64 le dur_us][data…]`.
  HTTP on loopback is the established transport (video files already stream this way);
  encoded AUs are ~1 MB/s per deck at typical bitrates. Do **not** send AU data over
  Tauri JSON IPC.
- `video_demux_unload(deck_id)` on source change/removal. Guard the map the same way
  `AudioManager` is guarded; demux load runs on `spawn_blocking` like `audio_analyze_file`.

### Frontend: `src/lib/video/codecPlayer.ts` + `codecWorker.ts`

Per-deck player object, created when a deck's source loads (feature-flagged, Phase 2):

- **Worker** (`codecWorker.ts`): owns the `VideoDecoder` and the chunk fetch loop.
  Receives control messages: `{init: {codec, port, deckId, aus…}}`,
  `{clock: {contentPos, playing}}` (posted at most once per rAF from the main thread —
  reuse the throttling discipline from `audioSync.ts`), `{seek: {target}}`,
  `{loop: {inPos, outPos} | null}`.
  - Maintains a decode-ahead queue: keep N=4–6 decoded `VideoFrame`s ahead of the
    clock position. Decode more when the queue drains below N; stall never blocks the
    main thread (it's a Worker).
  - **Seek**: `decoder.reset()`, `configure()` again, feed from the nearest keyframe
    ≤ target, drop output frames with pts < target. (Measured cheap; see spike table.)
  - **Loop**: when the clock approaches `loopOut`, pre-decode from `loopIn`'s
    keyframe into a second queue; swap queues when the audio clock wraps. No seek, no
    stall, no mechanism-A trigger — this is strictly better than today.
  - **EOS**: when the last AU is decoded, just stop feeding. End-of-track policy stays
    audio-driven (Rust pipeline self-pauses on EOS and emits `deck-eos`) — one source
    of truth, no `<video>` `ended` event to reconcile (that reconciliation is what
    sank the mechanism-B mitigation attempt).
  - Transfers due frames to the main thread (`postMessage(frame, [frame])`) —
    `VideoFrame` is transferable; no copies.
- **Main thread** (`codecPlayer.ts`): holds the ≤2 most recent transferred frames. In
  `App.svelte`'s existing `frame()` loop, replaces `uploadVideoFrame(v, fbo)` for
  codec-path decks: pick the frame with the largest pts ≤ `getDeckTime(deckId)` (the
  same audio-clock value the waveform already consumes), upload it, `close()` older
  frames. Upload path: try `texImage2D(gl, VideoFrame)` directly (worked in the spike;
  measure on real GPU) with the scratch-canvas `drawImage` path as the fallback —
  keep both behind one function, chosen once at startup by a timed self-test.
  **Always `close()` every `VideoFrame`** — leaked frames exhaust the decoder's
  frame pool and stall decode silently.
- **Rate changes**: nothing to do. The audio clock (`contentPos`) already advances at
  the deck's rate; the worker just decodes far enough ahead. Delete-list (Phase 3):
  `lastPlaybackRate` map, `v.playbackRate` writes, rebuild-settle waits, the
  video-element halves of the drift-correction and `pendingSeekTarget` machinery.

### What does NOT change

- The Rust audio pipeline, the audio clock, `audioSync.ts`, waveforms, BPM/grid — all
  untouched. Audio remains the master clock; this design *consumes* it.
- WebGL compositor, FBO-per-deck, effects, visualization layer — untouched; only the
  texture *source* changes.
- Recording (`record.rs`) — stays in Rust. **`VideoEncoder` is forbidden** (crashes
  the web process; see spike table).
- The legacy `<video>` path remains in the codebase as the per-deck fallback for
  sources the demuxer/decoder can't handle, until Phase 5 retires or archives it.

## Phased rollout

Gate scripts (`scripts/perf-idle-test.sh`, `scripts/latency-test.sh`) must pass at
every phase; new soak test added in Phase 4. One phase per PR/branch; do not combine.

1. **In-app verification + demux service.** Build `video_demux.rs` + the media_server
   endpoint. Add a `__cuemarkDebug.probeWebCodecs()` debug-hook method that runs the
   decode-only probe (fetch AUs for a loaded deck, decode 60, pixel-check, time it)
   inside the real Tauri webview. Verify on a real library file, including one AV1
   file (see `project_av1_vaapi_bug` history — AV1 is the likeliest codec-support
   gap; WebCodecsAV1 is *preview* status).
2. **`codecPlayer.ts` behind a feature flag** (`VITE_VIDEO_PATH=webcodecs` or a
   settings toggle persisted via the `cuemark:` localStorage pattern). Deck video
   renders via WebCodecs when flagged; `<video>` element not created for those decks.
   A/B toggle must be live-switchable per deck for side-by-side comparison (visual
   correctness: color range/space vs. the `<video>` rendering — check BT.601 vs 709
   on real content; rotation metadata; variable-frame-rate files must present by pts,
   never by assumed cfr).
3. **Retire sync machinery for codec-path decks**: loop wraparound via worker (no
   seek), hot cues/snap seeks via worker seek, remove drift-resync +
   `pendingSeekTarget` + `contentPosTracker` involvement for these decks. Keep all
   of it for legacy-path decks.
4. **Soak + live testing** (`feedback_audio_midi_live_testing` applies in full):
   headless soak — off-tempo (0.87×) full-track playback to natural end, repeated
   ×10 (mechanism B's repro conditions: was 2-of-3 stall); sustained off-tempo
   playback with a 4-bar loop for 30+ min (mechanism A's exposure profile);
   MIDI-rate burst via `latency-test.sh`. Then real-desktop sessions with human
   eyes/ears — the automated pass alone is insufficient (proven twice).
   Success bar: zero freezes under conditions where legacy reliably froze, AV sync
   subjectively tight, CPU within `perf-idle-test.sh` baselines.
5. **Flip the default.** Keep legacy `<video>` as automatic fallback for
   unsupported codecs; reassess deleting it entirely after a few weeks of use.

## Risks and open items

- **WebCodecs implementation quality in WebKitGTK**: it is GStreamer-backed too, but
  decoder-element-only — none of `MediaPlayerPrivateGStreamer`, `multiqueue`
  rate-scaled buffering, or segment/EOS machinery is involved. The `VideoEncoder`
  crash shows this code is not battle-hardened, so Phase 1's in-app verification and
  Phase 4's soak are the real gates, not the spike. Watchdog (`freeze-watchdog.md`)
  backstops whatever remains.
- **Decode-ahead vs. scratch**: video scratch presentation (walking frames backward)
  needs GOP-cached decoded frames; defer to a follow-up design once forward playback
  ships (audio scratch already works and is the perceptually dominant channel).
- **Memory ceiling**: compressed AUs per deck (~10–50 MB typical) + ≤8 in-flight
  decoded 1080p frames (~3 MB each, decoder-pooled). Fine at 4 decks; revisit only if
  real usage shows pressure (same posture as the PCM buffer decision).
- **Codec strings from caps**: mapping GStreamer caps → precise WebCodecs codec
  strings (esp. hevc/av1 profiles) has fiddly cases. Start with H.264 (the library's
  dominant codec), return "unsupported" honestly otherwise → legacy fallback path.
- **If Phase 1 or Phase 4 fails** (in-app decode broken, or new instability class):
  the escalation path is the native output pipeline — Rust GStreamer decode +
  `glvideomixer`/`glshader` compositing into a native output window, webview demoted
  to control surface with thumbnail previews. Deliberately not designed further here;
  it's a separate large project that only gets scoped if this cheaper path fails.
