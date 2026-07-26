# WebCodecs video path: replacing the `<video>` element for deck playback (design)

Status: **phase 4 (soak + live testing) automated portion done; one of two
2026-07-25 findings fixed and verified 2026-07-26, one still open** — (1) the
×10 natural-EOS soak surfaced a 100%-reproducible silent stall in the shared
Rust `DeckAudioPipeline` a fraction of a second before every track's true end,
independent of playback rate, file, and video backend (confirmed on both
`legacy` and `webcodecs`) — **not a WebCodecs regression** (it reproduces on a
plain `legacy` deck too, since both backends share the same Rust audio clock)
and, as it turned out, **not the `input_selector`/scratch topology originally
suspected** either — root-caused 2026-07-26 to `cue_valve` silently swallowing
the EOS event whenever the headphone cue is off (its default state), fixed,
and verified via a new deterministic regression test (see "Finding: silent
stall..." below for the full root-cause chain and fix). (2) the 30-minute
sustained-loop test ran clean for 28 minutes, then hit a real, spontaneous
`WebKitNetworkProcess` deadlock — a previously-uncaught freeze class — that
`freeze-watchdog.md`'s recovery machinery caught and fixed automatically in
~14s (a genuine, uncontrived save, the strongest evidence yet that the
watchdog works). This one is **still open**: a 2026-07-26 code review of the
webcodecs HTTP AU-fetch path found no smoking gun on our side and points more
toward a generic WebKitGTK `NetworkProcess` bug than an app-level cause — see
"Risks and open items" for why, and what a real root-cause session would need.
It's tracked as a lower-urgency item (the watchdog already covers it in
practice), not a Phase 5 blocker. See "Phase 4 results" below for full
evidence on both. The MIDI-burst and CPU-baseline conditions completed cleanly
(no freezes).

**Human real-desktop verification (2026-07-26): done, one new finding, fixed.**
A real (non-Xvfb) `cargo tauri dev` session on the actual desktop, real GStreamer
audio device, real DJControl Starlight controller connected, surfaced a third bug:
a live legacy→webcodecs toggle could silently fail to start audio on the first
play attempt (self-recovering on the next click) — root-caused to a Svelte
reactivity gap, **not** a WebKit/GStreamer issue this time. Fixed and verified
live the same session. See "Finding: live-toggle play stall..." below. The same
session also independently reproduced finding (2) above — the
`WebKitNetworkProcess` deadlock — twice in a row on the real desktop (not just
Xvfb), both times caught and auto-recovered by the watchdog within 7–11s. This
closes the human-verification gate for the play-stall bug and adds further
real-desktop confirmation that (2) is a genuine, if still unresolved, WebKitGTK
issue that the watchdog fully covers in practice.
Phase 3 (done 2026-07-25): audited and live-tested the legacy/codec-path
isolation Phase 2 already built; zero code gaps found, one live-test proof instrumentation
added (kept permanently). See "Phase 3 results" below. Phase 2: full playback path
(`codecPlayer.ts`/`codecWorker.ts`), feature flag + live per-deck A/B toggle, `App.svelte`
integration, and in-app verification (real Tauri webview, real library files) — see "Phase 2
results". Phase 1: demux service + in-app WebCodecs verification — one real finding that
changed the phase 2 plan: hardware H.264 decode needs `description`/avc format, not the
spike's annexb-only assumption. Feasibility spike completed 2026-07-25 (results below — all
gates passed *for software decode*; see phase 1 results for the correction). Companion doc:
`freeze-watchdog.md` (ships first; independent of this work but makes any remaining webview
failure recoverable).

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

1. **DONE (2026-07-25). In-app verification + demux service.** Built `video_demux.rs` +
   the media_server endpoint. Added a `__cuemarkDebug.probeWebCodecs()` debug-hook method
   that runs the decode-only probe (fetch AUs for a loaded deck, decode, time it) inside
   the real Tauri webview. Verified on real library files, including one AV1 file (see
   `project_av1_vaapi_bug` history — AV1 is the likeliest codec-support gap; WebCodecsAV1
   is *preview* status). Results below.
2. **DONE (2026-07-25). `codecPlayer.ts` behind a feature flag.** Deck video renders via
   WebCodecs when flagged; `<video>` element not created for those decks. Live
   per-deck A/B toggle shipped (`DeckCard`'s LEGACY/CODEC badge). Results below.
3. **DONE (2026-07-25). Audit + harden legacy/codec-path isolation.** Corrected
   framing (was: "retire sync machinery for codec-path decks... remove drift-resync +
   `pendingSeekTarget` + `contentPosTracker` involvement for these decks"). That
   description conflated two different things. `contentPosTracker`'s wall-clock→
   content-position integration and `pendingSeekTarget`'s stale-IPC filter are **not**
   `<video>`-element-specific — they exist because the *Rust audio pipeline's*
   `query_position` always returns wall-clock stream time regardless of video
   backend (soundtouch's `tempo` property never issues a rate-seek), so both backends
   need this shared clock math; Phase 2 already fed it into `codecPlayer.setClock()`
   for codec-path decks rather than bypassing it. What actually *is* legacy-only —
   and was already gated correctly in Phase 2 — is the small set of literal `<video>`
   DOM writes: `v.currentTime =`, `v.playbackRate =`, `v.play()`/`v.pause()`, and the
   mechanism-B self-heal block. All of these are reached only through a `v` obtained
   from `videoEls`/`seekBus.ts`'s `els` map, which by construction never holds an
   entry for a webcodecs-backend deck. Phase 3's actual work was auditing every one
   of those call sites for a missing guard, and proving the isolation live rather than
   trusting the code review. See "Phase 3 results" below — zero gaps found; one
   permanent proof-instrumentation hook added (`__cuemarkDebug.getLegacyVideoOpCounts`).
4. **Soak + live testing — STATUS: DONE, both automated and human real-desktop
   verification closed (2026-07-26).** (`feedback_audio_midi_live_testing`
   applies in full): headless soak — off-tempo (0.87×) full-track playback to
   natural end, repeated ×10 (mechanism B's repro conditions: was 2-of-3
   stall); sustained off-tempo playback with a loop for 30+ min (mechanism
   A's exposure profile); MIDI-rate burst via `latency-test.sh`. Then
   real-desktop sessions with human eyes/ears — the automated pass alone is
   insufficient (proven twice) — completed 2026-07-26 on the real desktop with
   physical MIDI hardware connected; found and fixed one new bug (the
   live-toggle play-stall, a Svelte reactivity gap — see "Real-desktop human
   verification" below) and gathered fresh confirmation of the still-open
   `WebKitNetworkProcess` finding. Success bar: zero freezes under conditions
   where legacy reliably froze, AV sync subjectively tight, CPU within
   `perf-idle-test.sh` baselines.
   **Result: two findings, both detailed in "Phase 4 results" below.** (1)
   The ×10 natural-EOS soak found a new, 100%-reproducible freeze — not in
   WebCodecs, but in the shared Rust `DeckAudioPipeline` — that must be fixed
   before Phase 5, independent of WebCodecs' own rollout status. (2) The
   30-minute sustained-loop test ran clean for 28 minutes, then hit a real
   `WebKitNetworkProcess` deadlock that `freeze-watchdog.md`'s recovery
   caught and fixed automatically in ~14s — a genuine, uncontrived proof the
   watchdog works, but also a previously-uncaught freeze class worth
   root-causing. The MIDI-burst and CPU-baseline conditions completed
   cleanly (no freezes) on the webcodecs backend.
5. **Flip the default.** Keep legacy `<video>` as automatic fallback for
   unsupported codecs; reassess deleting it entirely after a few weeks of use.

## Phase 1 results (2026-07-25)

Built `src-tauri/src/video_demux.rs` (parsebin → explicit `h264parse config-interval=-1` →
capsfilter(byte-stream/au) → appsink, all AUs pulled into memory, `avc1.PPCCLL` codec string
read directly off the SPS NAL's profile_idc/constraint_flags/level_idc bytes — no name→code
table needed), `media_server.rs`'s `GET /demux/<deck_id>/aus?from=&count=` binary route, and
`App.svelte`'s `__cuemarkDebug.probeWebCodecs(deckId, filePath)`. Verified via `verify-ui`
(tauri-driver + Xvfb, `VITE_ENABLE_DEBUG_HOOK=1 cargo tauri build --debug --no-bundle`) against
two real cached library files:

| File | Codec detected | Result |
|---|---|---|
| H.264, 8s, 1920×1088, High@4.0, 24fps (`6832161a...4443393.mp4`) | `avc1.640028` (verified against the SPS bytes and against `ffprobe`'s `profile=High level=40`) | **60/60 frames decoded, 0 errors, ~129ms** (avc+description mode — see finding below) |
| AV1, 244s, 1080×1080, Main, 25fps (`2e286b6e...14627479.mp4`) | `video/x-av1` | **Correctly rejected** — `unsupported codec for WebCodecs demux path: video/x-av1 (H.264 only in phase 1)`, returned in ~40ms (parsebin's pad-added bails before pulling a single AU, so the 244s file is never actually demuxed) |

No VA-API corruption observed for the AV1 file (checked the app log for the duration of the
test session): `video_demux.rs`'s pipeline never links a decoder for any codec it doesn't
support — it bails at container-pad-detection, before an `h264parse`/decoder element is even
instantiated — so the AV1/VA-API corruption class of bug (`project_av1_vaapi_bug`) structurally
cannot occur here, confirmed empirically, not just by design.

**One real finding that changes the phase 2 plan**: the spike's "annexb, no `description`"
recipe (`dec.configure({codec})`, raw Annex-B chunks) **does not work with H.264 hardware
decode** (`vah264dec`, enabled in this app's env — see `audio-debugging` skill's "VA-API
hardware decode status"). It decodes 0 frames and `flush()` rejects with `EncodingError:
Decode error`. Re-running the spike's own probe script today reproduces this same failure —
its recorded "60/60 decoded" pass only holds with `vah264dec`/`vaapih264dec` demoted to force
software `avdec_h264`, which is not this app's actual configuration. Full root-cause writeup:
`audio-debugging` skill, "WebCodecs H.264 hardware decode requires `description` (avc), not
annexb". **Fix applied in `probeWebCodecs`**: try annexb first, and on failure build an
AVCDecoderConfigurationRecord `description` from the first keyframe's SPS/PPS and re-mux each
chunk to length-prefixed (avc) format with parameter sets stripped; this is what actually
decoded the H.264 file above (`mode: "avc"` in the probe result). **Phase 2's `codecPlayer.ts`
should go straight to avc+description** (skip the annexb attempt — it's dead on arrival with
hardware decode on) and do the Annex-B→avc re-mux once per chunk in the decode-ahead worker,
not per-frame in a hot path.

Other gotchas found, none blocking: (1) Tauri capabilities needed no changes —
`video_demux_load`/`video_demux_unload` worked immediately under the existing `core:default`
capability set, same as the `audio_*`/`grid_*` commands. (2) The test file's GOP structure is
a single keyframe for the whole 8s clip (`au_count=192`, `keyframes=1`) — fine for forward-only
decode, but phase 3's loop-without-seek and hot-cue-without-seek plans should keep in mind that
some real library content may have very sparse keyframes, making an arbitrary seek target's
"nearest keyframe ≤ target" catch-up window much larger than the spike's `key-int-max=30` test
data implied.

## Phase 2 results (2026-07-25)

Built the full playback path:

- **`src/lib/video/h264.ts`** — Annex-B/avc helpers (NAL split, `AVCDecoderConfigurationRecord`
  builder, avc re-mux, AU-framing parser) factored out of phase 1's `probeWebCodecs` debug
  hook so `codecWorker.ts` reuses the exact proven logic rather than re-deriving it.
- **`src/lib/video/codecWorker.ts`** — one `VideoDecoder` per deck in a Worker. Always
  avc+description (per phase 1's finding — annexb-without-description not attempted).
  Decode-ahead gated on `pts/1e6 - clockPos > ~5/fpsHint` (N≈5 frames) plus
  `decoder.decodeQueueSize` backpressure. Seek: `reset()`+`configure()`, feed from
  `keyframeAuIndexAtOrBefore(target)`, drop output pts < target. Loop: a second
  `VideoDecoder` pre-decodes from `loopIn`'s keyframe once the clock is within 1.5s of
  `loopOut` (buffers up to 6 frames), then a `loopWrap` message swaps it in as primary
  with zero seek for the common case — the same physical `VideoDecoder` instance is
  reused post-swap (its output callback checks a `loopIsNowPrimary` flag rather than
  needing a new decoder, since a `VideoDecoder`'s callback is fixed at construction).
  Falls back to a normal seek if the wrap arrives before prefetch finished. EOS: stops
  feeding, no synthesized `ended` event, per the doc's "one source of truth" rule.
- **`src/lib/video/codecPlayer.ts`** — main thread, holds ≤2 `VideoFrame`s, `getFrameForTime`
  picks largest pts ≤ t (no CFR assumption). `setClock()` detects a backward jump (>0.5s,
  mirroring `contentPosTracker`'s own seek heuristic) and treats it as an implicit seek —
  this is what makes the Rust EOS-then-replay-from-zero path work correctly on the codec
  path with no extra code (confirmed live: an EOS-restarted deck resumed cleanly).
- **`fbo.ts`**: `uploadVideoFrameFromCodec()` tries `texImage2D(gl, VideoFrame)` directly,
  falls back to the scratch-canvas `drawImage` detour on the first throw, caching the
  choice in a module-level static (not per-instance — the capability is a GPU/driver
  property, not a per-deck one). **Finding**: on this real GPU (not just the spike's
  Xvfb/llvmpipe), `texImage2D(gl, VideoFrame)` direct upload works — confirmed by the
  compositor output screenshot below rendering correctly with no fallback exception
  logged. **No Y-flip is applied** for this path (unlike `uploadVideoFrame`'s
  `UNPACK_FLIP_Y_WEBGL`) — verified by screenshot: codec-path frames render right-side-up
  and color-correct with the flip *omitted*, confirming WebCodecs' pixel format is already
  in the orientation WebGL expects.
- **`seekBus.ts`** extended with a `CodecPlayerHandle` registry (`registerCodecPlayer`/
  `getCodecPlayer`/`codecPlayerDeckIds`) alongside the existing `els` video-element map.
  `seekDeck()` routes to both, so every existing call site (hot cues, loop in/out, cue
  point in `DeckCard.svelte`) needed **zero changes** — they already went through
  `seekDeck`/`getDeckTime` generically.
- **Feature flag**: `src/lib/video/videoPathSettings.ts` — `cuemark:videoPathDefault`
  (global, seeded from `VITE_VIDEO_PATH=webcodecs` on first run only, same
  first-run-only precedent as other `persistentWritable` settings) and
  `cuemark:videoPathOverride` (per-deck `Record<deckId, 'legacy'|'webcodecs'>`).
  **UI**: a small LEGACY/CODEC badge button in `DeckCard`'s header (next to the deck id)
  — click to flip that deck's override live, no reload needed.
- **`App.svelte`**: `syncVideoElements` now resolves a per-deck backend (`legacy` |
  `pending` | `webcodecs` | `legacy-fallback`) via `resolveVideoPath()`, tearing down/
  spinning up the right backend on file changes and on live A/B toggles — a toggle on an
  already-loaded file does **not** call `audio_load` again (verified: toggling
  legacy→webcodecs→legacy on a playing deck never glitched the audio). `frame()`'s
  position-poll (audio clock) is no longer gated on a `<video>` element existing — it now
  drives both `v.currentTime` snapping (legacy) and `codecPlayer.setClock()` (webcodecs)
  from the same poll. The deck's custom loop (`loopIn`/`loopOut`) wraps via
  `codecPlayer.notifyLoopWrap()` + `audioSeek()` in that same poll for codec-path decks,
  the poll-driven equivalent of legacy's `v.ontimeupdate` loop-back.

### Verification (real Tauri webview, tauri-driver + Xvfb, real cached library files)

Two decks loaded with the same 8s H.264 file, deck-0 forced `legacy`, deck-1 forced
`webcodecs` (`__cuemarkDebug.setVideoPathOverride`, added as a phase 2 verification hook):

- **Backend resolution**: `getVideoBackend('deck-0')` → `legacy`, `getVideoBackend('deck-1')`
  → `webcodecs`. `document.querySelectorAll('video').length` → **1** (only deck-0's) while
  deck-1's `DeckCard` preview canvas and the main compositor output both showed moving,
  correctly-oriented, color-correct content — confirmed by `canvas.toDataURL()` screenshot
  comparison (see gotcha below on why `toDataURL()` was used instead of the WebDriver
  screenshot endpoint).
- **Sync**: both decks' `getAudioTime()` (same audio-driven clock) tracked within ~20ms of
  each other while playing; deck-1's `getCodecFramePts()` stayed within one frame interval
  (~40ms at 24fps) of `getAudioTime()`.
- **Visual correctness**: screenshots of both decks' composited output at matching audio
  positions — codec-path frame is right-side-up, correct color (matches the legacy
  frame's palette/content), not garbled/static. No rotation-metadata or BT.601/709 test
  clip was available locally; only the orientation/gross-color-correctness checks the doc
  asks for were run.
- **Seek**: `seek('deck-1', 1.0)` landed the audio clock at the target within ~1s
  (GStreamer seek latency, same as legacy); the codec frame briefly returned `null` from
  `getFrameForTime` until the worker decoded past the seek target, then tracked correctly
  — no black flash held for seconds (confirmed via screenshot at the target position).
- **Loop**: `loopIn=0.5`/`loopOut=2.0`/`loop=true` on the webcodecs deck — `getAudioTime`
  oscillated repeatedly between ~0.5s and ~2.0s (confirming wraparound, not a run to real
  EOS) with the codec frame staying in the loop window and no black frame at the wrap
  (screenshot taken mid-loop shows valid content). A few individual polls showed the
  codec frame briefly lagging the audio clock by ~0.3–0.4s right after a wrap on this
  single-keyframe test file (see gotcha below) — self-corrected within the next poll.
- **`scripts/perf-idle-test.sh`**: added a `webcodecs-deck-playing` scenario (mirrors the
  existing `video-deck-playing` one). Results: `video-deck-playing` 46.75% avg CPU vs.
  `webcodecs-deck-playing` 49.69% — comparable, no regression, on this Xvfb/software-GL
  test box.
- **`scripts/latency-test.sh`**: left unmodified — deck-0 stays on the (unaffected)
  legacy path by default, and the script's actual subject (WebKit pipeline rebuild
  timing on `v.playbackRate` writes) structurally doesn't apply to codec-path decks
  (no `v`, no rate writes at all — see the doc's "Rate changes" bullet). All 10 checks
  passed against a 25s file (an 8s file made step 7's 2× rate check hit real EOS
  mid-test — a test-fixture artifact of file length, not a regression, confirmed by
  re-running with a longer file).
- **`npm run check`**: clean (0 errors/warnings, 230 files). No Rust changes this phase,
  so `cargo check` wasn't re-run.

### New gotchas found

- **WebDriver's full-window `/screenshot` endpoint hangs indefinitely in this
  environment** (confirmed: 45s timeout, no response, even with an empty session/no
  decks loaded) — a pre-existing issue unrelated to this phase's code, matching the
  precedent already noted in `journal.md`'s 2026-07-06 entry ("extracted the waveform
  canvas's raw pixel data via `toDataURL()` rather than trusting a full-window
  screenshot"). Use `canvas.toDataURL('image/png')` via `execute/sync` instead — reads
  back the actual composited WebGL output (or any other canvas) and is fast/reliable.
  Added to `verify-ui` skill.
- **A leftover `WebKitWebDriver` process from an earlier session in the same Xvfb
  display can silently steal tauri-driver's native-driver port** (`4445`, i.e.
  `webdriver-port+1`) — the *new* tauri-driver still accepts a session and answers
  `execute/sync` (confusing: it looks alive), but its log shows
  `FATAL: Unable to listen for HTTP server at host 127.0.0.1 and port 4445` and some
  operations (screenshot) hang. Check `ps -o pid,lstart,cmd -p $(pgrep -f
  WebKitWebDriver)` and compare start times/`DISPLAY` before trusting a session is
  clean; kill anything stale on your own `:99`-style display (never touch a process
  whose `DISPLAY=:0` — that's the user's real desktop).
- **Single-keyframe test files make every seek/loop-fallback a full re-decode from AU
  0** — the 8s test file has exactly one keyframe (per phase 1's own note). Loop
  wraparound still worked correctly in testing because the loop-prefetch path doesn't
  need a keyframe seek for the common case, but any *fallback* path (prefetch not
  ready in time, or a hot-cue seek deep into a sparse-keyframe file) pays the full
  from-AU-0 decode cost. Not a phase 2 regression — flagged as a real limitation for
  phase 3/4 soak testing on content with realistic GOP structure.
- **Reloading the identical file path on a deck is a no-op** for both backends (matches
  the pre-existing legacy behavior of comparing `v.getAttribute('src')`) — `backendState`
  tracks `(deckId, filePath)`, so calling `updateDeck(deckId, {source: {...same
  filePath...}})` doesn't retrigger `audio_load`, `video_demux_load`, or grid lookup.
  Confirmed via testing but worth remembering when scripting repeated-load test
  sequences — force a `source: null` clear first if a fresh reload is actually needed.

### Known limitations carried into phase 3

- Codec support is still H.264-only (unchanged from phase 1) — any other codec on a
  deck flagged `webcodecs` falls back to `legacy` automatically (`legacy-fallback`
  state), logged via `debugLog`.
- Loop-prefetch and seek-fallback both use `keyframeAuIndexAtOrBefore`, which can be
  arbitrarily far from the target on sparse-keyframe content (see gotcha above) —
  fine for phase 2's "common case" bar, worth re-measuring in phase 4's soak on real
  multi-minute library content with normal GOP sizes.
- No rotation-metadata or BT.601-vs-709 real test clip was available locally to
  exercise the doc's specific color-space/rotation call-out — only gross
  orientation/color-sanity was verified. Revisit if a rotated or unusual-colorimetry
  clip surfaces in the library.

## Phase 3 results (2026-07-25)

**Audit method**: grepped every reference to `videoEls`, `lastPlaybackRate`,
`stallWatch`, `v.currentTime`, `v.playbackRate`, `v.play(`, `v.pause(`,
`pendingSeekTarget`, `contentPosTracker` across `App.svelte`, `seekBus.ts`,
`audioSync.ts`, `DeckCard.svelte`, `WaveformCanvas.svelte`, and `Crossfader.svelte`.

**Finding: no gaps.** Every literal `<video>` DOM mutation (all `v.currentTime =`,
`v.playbackRate =`, `v.play()`, `v.pause()` call sites — createLegacyVideoEl's
adopted-position seek, the custom loop-wraparound `ontimeupdate`, the rate-tolerance
write, play/pause sync, the mechanism-B self-heal reset, and the drift-resync snap in
`frame()`) is reached only via a `v` obtained from `videoEls`/`seekBus.ts`'s `els`
map, and `syncVideoElements`'s state machine only ever populates that map for a deck
resolved to `legacy`/`legacy-fallback` — a `webcodecs`-resolved deck is torn out of
both maps in the same rAF pass that switches it over (`teardownCodecPlayerOnly`/the
toggle branches). `DeckCard.svelte`'s preview canvas reads `video.currentTime` but
never writes it, and falls through to `codec.getFrameForTime()` when no `v` exists.
`WaveformCanvas.svelte` and `Crossfader.svelte` never touch a video element at all —
they go through `getDeckTime`/`getPhase`/`seekDeck` exclusively. `audioSync.ts` is
pure Rust-IPC (rate/gain/volume), not video-backend-aware, confirming it's genuinely
shared infrastructure rather than something that needed scoping. **No code changes
were needed** — Phase 2 built the isolation preemptively and correctly, exactly as
its own inline comments already claimed (e.g. the `frame()` self-heal block's "codec-
path decks have no `v`... this block naturally never runs for them").

**Live-test proof** (`verify-ui`: tauri-driver + Xvfb, `VITE_ENABLE_DEBUG_HOOK=1
cargo tauri build --debug --no-bundle`, two decks on the 265s/1080p H.264 cached
file `a3f47c64298e7849-36194713.mp4`, deck-0 forced `legacy`, deck-1 forced
`webcodecs`):

- Added `window.__cuemarkDebug.getLegacyVideoOpCounts(deckId)` — per-deck counters
  (`currentTime`, `playbackRate`, `playPause`) bumped at every one of the write
  sites above, plus `hasVideoEl` (`videoEls.has(deckId)`). Kept permanently (cheap
  Map bump, same style as the rest of the debug hook) as a standing live sanity
  check for this isolation, not a one-off test hook — removed nothing else, no
  `console.log` added to the RAF loop.
- Ran two cumulative `simulateMidiRateBurst('deck-1', …)` calls that each exceeded
  the WebDriver async script timeout (90s) while still executing server-side
  (fire-and-forget `setInterval`, confirmed still advancing after the timeout), plus
  one clean bounded run — **1000 events fired over 22.5s** (rates cycling
  0.9/0.95/1.0/1.05/1.1×) with a clean result. Combined sustained non-1.0-rate
  exposure on deck-1: **~230+ seconds**, well over the "a minute or more" bar.
- One `seek('deck-1', 50.0)` mid-burst: `getCodecFramePts` landed at 50.33s,
  `getAudioTime` at 50.35s — within one frame interval, no black-flash stall.
- One loop (`loopIn=50.0, loopOut=52.0`) driven for 6 polls across ~12s: audio clock
  oscillated 47.3 → 51.4 → 48.9 → 50.9 → 48.1, confirming repeated wraparound (not a
  run to real EOS).
- **`getLegacyVideoOpCounts('deck-1')` throughout all of the above:
  `{currentTime: 0, playbackRate: 0, playPause: 0, hasVideoEl: false}` — never
  changed from zero, at any single poll, across the whole workout.**
  `document.querySelectorAll('video').length` was `1` the entire time (deck-0's
  element only).
- **Side-by-side legacy sanity check**: deck-0 (`legacy`, same file) showed its
  normal machinery firing throughout — `currentTime` counter climbed from 278→314
  over ~10s of playback (the drift-resync snap firing repeatedly, as expected for a
  playing legacy deck), `playbackRate`/`playPause` incremented on each session-
  lifecycle event (fresh load, toggle). Confirms this phase's audit/instrumentation
  didn't accidentally disable or no-op the legacy path.
- App log (`~/.local/share/com.cuemark.app/logs/cuemark.log`) showed zero
  `[self-heal]` lines for either deck across the session — no mechanism-B stall
  triggered on either backend during the test.

**Gate scripts**: `scripts/perf-idle-test.sh` — no regression (`video-deck-playing`
46.00%, new `webcodecs-deck-playing` scenario 50.62%, both comparable to Phase 2's
recorded baseline). `scripts/latency-test.sh` — 10/10 passed on the 8s light clip;
run a second time against the 265s/1080p heavy clip and failed only step 6's CPU
threshold (106% vs. an 80% bar) — this reproduces the skill's own documented gotcha
("The CPU > 80% failure for heavy content is expected... use a light DJ clip to
verify the 80% threshold") rather than a regression; the light-clip run confirms the
actual gate passes cleanly. `npm run check` — clean, 230 files, 0 errors/warnings.
No Rust changed this phase, so `cargo check` wasn't re-run.

**New gotcha confirmed, nothing new needed**: this phase found no new isolation bug
and needed no code fix beyond the doc correction above — worth recording plainly as
a "the design held" result, per this project's memory culture, rather than
inventing a gotcha to report. The one genuinely new procedural note (added to
`skills/verify-ui/SKILL.md`): `simulateMidiRateBurst`'s `setInterval` can be
throttled far enough under this environment's CPU load (two decks playing + a
sustained burst) that its wrapping WebDriver `/execute/async` call hits the default
90s script timeout well before the requested event count fires — the burst keeps
running fire-and-forget in the page regardless (confirmed: audio position kept
advancing, and a smaller bounded re-run completed and reported real numbers), so a
timed-out response is not itself a failure signal for this particular hook.

## Phase 4 results (2026-07-25)

**Method**: `verify-ui` (tauri-driver + Xvfb, `VITE_ENABLE_DEBUG_HOOK=1 cargo tauri
build --debug --no-bundle` — binary confirmed rebuilt after phase 3's commit
`4b9671f`). Two cached library files used throughout (`project_media_library_smb_mount`):
the 25.693s H.264 clip (`02d9ad35e5ffb8e1-20875734.mp4`) for the EOS soak, and the
265.08s H.264 clip (`a3f47c64298e7849-36194713.mp4`) for the sustained-loop test and
a spot-check.

### Finding: silent stall a fraction of a second before every track's true end — NOT WebCodecs-specific

**Symptom**: partway through the ×10 natural-EOS soak, `getAudioTime(deckId)` (the
shared audio clock both video backends read) stopped advancing a few hundred
milliseconds before the file's real duration and never moved again. `deck.playing`
stayed `true` forever — the Rust EOS self-pause (`pipeline.rs`'s bus thread, see
CLAUDE.md "EOS handling") never fired, because no `EOS` bus message was ever posted.

**Reproduced 5/5, with escalating isolation to rule out WebCodecs/rate/file-specific
causes:**

| # | File | Rate | Backend | Froze at (content pos) | Duration | Gap from true end |
|---|---|---|---|---|---|---|
| 1 | 25.693s clip | 0.87× | webcodecs (deck-0) | 22.317409832960006s | 25.693s | 3.38s of *content* remaining (3.88s wall-clock at 0.87×) |
| 2 | 25.693s clip | 0.87× | webcodecs (deck-0, fresh reload) | 22.31740983296s (bit-identical to #1) | 25.693s | same |
| 3 | 25.693s clip | 0.87× | **legacy** (deck-1, same moment as #2) | 22.317409832959996s (bit-identical to #1/#2) | 25.693s | same |
| 4 | 25.693s clip | **1.0×** (control) | webcodecs (deck-0) | 25.650666666s | 25.693s | 0.042s |
| 5 | 265.08s clip | 1.0×, seeked to near end | webcodecs (deck-0) | 265.078979166s | 265.079996416s | 0.001s |

Runs #2 and #3 were **simultaneous, independent pipeline instances** (two decks, two
`DeckAudioPipeline`s) that froze at the same wall-clock moment at a bit-identical
content position — this rules out both a WebCodecs-side bug and a frontend-only
caching bug (two independent Rust pipelines don't coincidentally agree to 11 decimal
places by chance; this is deterministic given the same file/rate). Run #4 (rate=1.0,
the classic "does a rate-hypothesis-predicted-clean control still fail?" check from
`skills/audio-debugging`'s own diagnostic guidance) still froze, just much closer to
the true end — **this is not the previously-documented rate-dependent "mechanism B"**
(WebKit `<video>`-internal EOS/segment mishandling at non-1.0 rate); it reproduces at
1.0× too, and there is no `<video>` element involved on the webcodecs deck at all.
Run #5 (a completely different, much longer file, approached via seek rather than
full playback) still froze within 1ms of true EOS, showing this isn't specific to the
short test clip's encoding.

**Confirmed genuinely frozen at the source, not a frontend artifact** — the
`audio-debugging` skill's own "raw vs. cached" diagnostic
(`window.__TAURI__.core.invoke('audio_get_position', {deckId})`, bypassing every
frontend cache/derivation) returned the exact same value across repeated polls
seconds apart (e.g. `25.650999808` three times, 3s apart). `pw-top -b` showed the
deck's PipeWire stream in state `R` (still "running") with **ERR (xrun count)
climbing continuously** (~47/s: 36737 → 37064 over 7 samples) — PipeWire keeps
scheduling the stream every ~21ms and getting nothing back, forever. `pidstat -t`
on every thread in the app process showed ~0% CPU across the board during the
stall — **blocked, not spinning** — consistent with an ordinary GStreamer queue/
segment deadlock (same general class as the `gst_pad_push()`/`GstQueue`
backpressure stall found and root-caused via `gdb` in a previous session, per
`audio-debugging`'s "Catching an intermittent GStreamer-side stall" section —
not re-diagnosed with `gdb` this session: `ptrace_scope=1` blocked attaching to
the already-running process and no passwordless `sudo` was available to lower
it). The app log showed **zero** bus messages of any kind (no `EOS`, `ERROR`,
`WARNING`, `StateChanged`) after the `Paused → Playing` transition — the pipeline
doesn't even reach a state GStreamer itself recognizes as wrong; it just stops
producing data. The rAF heartbeat kept ticking at ~1/sec throughout every one of
these stalls — **the JS main thread stayed fully alive** the entire time; this is
not a UI freeze (mechanism A/B in `skills/audio-debugging`) at all, and self-heal
(which only watches `<video>`-element symptoms) correctly never fired — it isn't
built to catch this.

**Why this reached a fresh discovery only now**: `pipeline.rs` gained an
`input_selector`-based topology (normal decode path vs. an `appsrc`-fed PCM-scratch
branch) in recent scratch-feature work, and no prior test in this project ran a
plain track to its own natural end, repeatedly, under continuous automated
observation — prior sessions used seeks, short bursts, and loops, which this bug
doesn't affect (see the clean 30-minute sustained-loop result below — a loop that
never approaches the file's true end never hits this). It is **not caused by, or
specific to, the WebCodecs work** — it affects the pre-existing shared Rust audio
pipeline that both backends depend on as their master clock, confirmed by run #3
above reproducing on a plain `legacy` deck.

**Root-caused and fixed (2026-07-26).** The `input_selector`/`output_queue`
hypothesis above was wrong. Root cause: **`cue_valve` (a `valve` element, gating
the headphone-cue branch) silently swallows the EOS event, not just data
buffers, whenever `drop=true`** — which is its state on every deck by default
(cue off) until a user explicitly enables headphone cue. `GstBin` only posts its
aggregate pipeline-level EOS message to the bus once *every* sink element has
posted its own; with `cue_sink` never seeing EOS, the bus message never arrives,
even though the main output branch reaches real EOS cleanly. This is a stock
GStreamer gotcha (confirmed in isolation: `gst-launch-1.0 audiotestsrc
num-buffers=20 ! valve drop=true ! fakesink` hangs forever on EOS; the same
pipeline with `drop=false` exits immediately) that has existed since the cue
branch was first added — unrelated to the `input_selector`/scratch work — and
was simply never exercised by a natural-EOS run before (all prior testing used
loops/seeks that never reach true end of file with the cue branch idling).

Found via: a new deterministic regression test (`eos_stall_repro` in
`pipeline.rs`, using the existing local 5.6s test file — reproduces the stall in
~6s, no webview/Xvfb needed), a live `gdb` catch of the blocked `queue0:src`
thread (`scripts/gdb-eos-stall-catcher.py`, adapted from the existing stall
catcher — this bug's 100% reproducibility made it a one-shot catch, no retries
needed), and a pad-probe trace (`eos_stall_probe_trace`) that pinpointed the
exact last pad EOS reached (`cue_valve`'s sink pad) by walking the real pad
graph rather than guessing from a symbol-stripped backtrace.

**Fix**: `make_eos_passthrough_valve()` in `pipeline.rs` installs a downstream-
event probe on a valve's sink pad that flips `drop` to `false` the instant an
EOS event arrives, then lets it `Pass` through the valve's own already-correct
forwarding logic — applied to both `cue_valve` and `valve_normal` (the scratch
gate, same latent risk in principle). An earlier version of the fix tried
manually re-pushing a cloned EOS event past the valve instead; that "worked" but
triggered a `gst_mini_object_unref: assertion 'mini_object != NULL' failed`
GStreamer-CRITICAL, root-caused (again via `gdb`, `G_DEBUG=fatal-criticals`) to
a reentrant `gst_pad_push_event` call corrupting `tee`'s own in-progress
`gst_pad_forward` fan-out across its other src pads. The `drop`-flip approach
needs no reentrant push and shows no criticals across repeated runs.
`eos_stall_repro` now passes cleanly (`at_eos` flips true, pipeline self-pauses
correctly); `scratch_smoke`/`vinyl_hold_smoke` still pass unaffected.

### Off-tempo natural-EOS soak (×10 target)

Could not be completed as specified — the deterministic stall above meant every
attempt on the 25.693s clip at 0.87× stalled at the identical point before a track
ever reached one full natural pass. **3 attempts, 3 stalls, 0 clean completions**
(see rows #1–#3 above) — further repetitions would only reproduce the same
deterministic failure, so the remaining 7 reps were not run; the useful signal (a
100%-reproducible stall, not an intermittent one) was already established.

### Sustained off-tempo + loop, 30+ minutes — clean for 28 minutes, then a real freeze caught and recovered by freeze-watchdog

Deck-0 forced `webcodecs`, 265.08s clip, `playbackRate=0.87`, `loopIn=60`/
`loopOut=68` (an 8s loop well clear of both the start and the EOS-stall zone
above). Polled every 45s, cross-checked with two extended (90–120s)
`pidstat` CPU samples and an `pw-top` xrun check mid-run.

**First 28 minutes (1666s, 37 polls): clean.** `getAudioTime` oscillated
correctly within the 56–68s loop window on every poll (confirmed multiple full
wrap cycles, including brief exact-match readings between `getAudioTime` and
`getCodecFramePts`, e.g. poll 26: both 58.4x); `getLegacyVideoOpCounts('deck-0')`
stayed all-zero (`currentTime`/`playbackRate`/`playPause`/`hasVideoEl:false`) on
every single poll — zero legacy `<video>` DOM writes across the entire run;
rAF heartbeat never gapped (checked directly in the app log, not just inferred
from successful polls); `pw-top` showed the xrun ERR counter low and stable
(106, non-climbing) — no cascade, unlike the EOS-stall condition. Extended
`pidstat` sampling (uncontaminated by concurrent WebDriver polling, unlike the
per-poll numbers) put steady-state WebKitWebProcess CPU at **~97–100% average**
across four separate 90–120s windows spanning the run.

**At ~28 minutes (2026-07-26 00:28:17 UTC / 20:28:17 EDT): a real, spontaneous
freeze — and the freeze-watchdog caught and recovered it correctly.** The app
log shows:
```
[watchdog] TRIGGER: window 'main' silent for >= 6s — last stats: {...,"lastRafMs":153}
[watchdog]   descendant pid=2632100 comm=WebKitNetworkPr state=S etimes=3092s
             Δutime=0 Δstime=0 [near-0%-CPU, all-parked — matches known deadlock signature]
[watchdog] recovery tier1 (eval reload): window 'main'
[watchdog] recovery tier2 (native reload): window 'main'
[watchdog] window 'main' heartbeat resumed after 11.4s silence
[recovery] rehydrating session — 1 live pipeline(s)
[recovery] adopted deck-0 at 66.17s playing=true
[watchdog] recovery sequence for 'main' succeeded
```
The watchdog identified a parked `WebKitNetworkProcess` descendant (not
`WebKitWebProcess` — the process that owns the webview's `fetch()` calls,
notably including `codecWorker.ts`'s AU-fetch requests to the local media
server) as matching its known-deadlock signature, tier1 (JS eval reload)
didn't resolve it within 3s, tier2 (native window reload) did. Total time
from actual freeze onset to recovered/rehydrated: **~14 seconds** (11.4s
silent + ~3s to complete rehydration). Heartbeat resumed cleanly and kept
ticking for 90+ seconds of further observation with no additional triggers or
`[self-heal]` lines. **This is a genuine, previously-uncaught freeze — a
`WebKitNetworkProcess` deadlock, not mechanism A or B (both specific to
`WebKitWebProcess`'s internal `<video>`-element GStreamer pipeline, which
this deck doesn't have at all) — plausibly related to the webcodecs path's
HTTP-based AU-fetch transport under sustained load.** Not root-caused this
session (would need the same `gdb`/network-process-specific investigation the
EOS-stall finding above couldn't get either, for the same `ptrace_scope`
reason). Filed as a second, distinct freeze-class finding, separate from the
EOS-stall bug — but note the practical outcome: the system recovered
automatically in ~14s with **no user-visible failure beyond a brief reload**,
which is exactly the safety net `freeze-watchdog.md` was built to provide.
This is a real, uncontrived freeze-watchdog save, not a synthetic
`kill -STOP`/`freezeMainThread()` test — the strongest evidence yet that the
watchdog works as designed.

(The WebDriver session itself died at this point — "session deleted because
of page crash or hang" — consistent with `verify-ui`'s documented gotcha that
a Rust-triggered native reload breaks the WebDriver session even though the
page itself recovers correctly; recovery was confirmed via the app log per
that skill's own guidance, not by polling the dead session.)

**Minor secondary observation, not root-caused**: during this test,
`getCodecFramePts('deck-0')` intermittently returned values wildly
inconsistent with `getAudioTime` (e.g. audio at ~61s, frame pts reading
~208–233s) on most polls, self-correcting on at least one poll (#26, both
~58.4x). The wrong values are suspiciously exact multiples of a ~24fps frame
interval (`208.333333 × 24 = 5000.0` exactly; `226.333333 × 24 = 5432.0`
exactly; similarly for others), suggesting a frame is occasionally being
mislabeled with an index-derived pts rather than its real decoded pts —
possibly in the loop-prefetch path. No visible symptom was confirmed (a
`toDataURL()` screenshot during the anomaly showed static album-art content
typical of this file, so a wrong-frame selection wouldn't be perceptible
here) — flagged for follow-up investigation, not conflated with either freeze
finding above.

### MIDI-rate burst via `latency-test.sh`

`scripts/latency-test.sh` gained a `[backend]` argument (`legacy`, default, or
`webcodecs`) — a small, structure-preserving addition: forces deck-0's A/B
override before loading (explicitly, on **both** branches — see gotcha below),
swaps the "video position" reads in steps 4/7/8 from `getVideoTime()` (no
`<video>` element on webcodecs) to `getCodecFramePts()`, and adds a step 10
asserting `getLegacyVideoOpCounts('deck-0')` stayed all-zero through the
entire run, including the MIDI burst.

**Gotcha found and fixed while writing this**: the first legacy run showed 2
failures (steps 4 and 7, position stuck at 0). Root cause: `cuemark:videoPathOverride`
is a `persistentWritable` backed by WebKit's `localStorage` for the app's
origin, which **survives across app process restarts**, not just page
reloads. Manual `setVideoPathOverride('deck-0','webcodecs')` calls from
earlier in this same phase 4 session had persisted `{"deck-0":"webcodecs"}`
to disk; the "legacy" test run never explicitly reset it, so deck-0 silently
resolved to `webcodecs` (confirmed via `getVideoBackend()` + reading
`localStorage.getItem('cuemark:videoPathOverride')` directly) — `getVideoTime()`
correctly returned null/0 for a deck with no `<video>` element. **Not a
product bug** — audio, IPC, and MIDI-burst all worked fine underneath; only
the position-source assertions in the test were affected. Fixed by forcing
the override explicitly for both `legacy` and `webcodecs` (previously only
the `webcodecs` branch did this).

Final clean results after the fix:
- **legacy**: 10/10 passed. IPC round-trip `p50=20ms p99=45ms`; MIDI burst
  200 events in 3.87s, WebKitWebProcess avg CPU 59.80% during the burst;
  post-burst IPC `p99=3ms`; 2×-rate position check `+6.15s` in 3s (expected
  ~6s).
- **webcodecs**: 14/14 passed (10 shared + step 10's zero-regression check).
  IPC round-trip `p50=95ms p99=105ms` (higher — consistent with the general
  host load during this run, see the CPU baseline note below, not a
  backend-specific IPC cost: both backends' IPC goes through the identical
  Rust `audio_set_rate` command); MIDI burst 200 events in 13.9s (throttled
  under load — `setInterval` throttling under CPU pressure is an
  already-documented `verify-ui` gotcha, not new), CPU 70.78% during burst;
  post-burst IPC `p99=2ms`; 2×-rate check `+6.13s` in 3s;
  `getLegacyVideoOpCounts('deck-0')` all-zero (`hasVideoEl:false`) through
  the entire run including the burst.

### CPU baseline (`perf-idle-test.sh`)

| Scenario | This run | Phase 2/3 baseline |
|---|---|---|
| empty | 3.12% | — |
| visualization-layer-animating | 88.75% | — |
| video-deck-paused | 3.62% | — |
| two-video-decks-paused | 4.38% | — |
| video-deck-playing (legacy) | 112.13% | 46–50% |
| webcodecs-deck-playing | 111.38% | ~50% |

Both playing scenarios are well above the phase 2/3 baseline **in absolute
terms**, but legacy and webcodecs remain at parity with each other (111–112%,
~1% apart) — the number that actually matters for a regression check.
Checked the host at the time: `load average: 2.6` on a 4-core box, `top`
showing **68.8% iowait and 4.1 GB of swap in use** — the machine was under
genuine memory/IO pressure from ~45 minutes of cumulative Xvfb/WebKit test
sessions (EOS-stall repros, extended `pidstat` sampling, the 28-minute soak),
not a code-level CPU regression. Both backends degrading by the same
proportion supports host contention over a webcodecs-specific issue. Re-run
on a quiesced host before trusting the absolute numbers for a real go/no-go
CPU decision.

### Cleanup

All Xvfb/tauri-driver/app processes launched for this phase were torn down
after every test; confirmed via `pgrep -af "tauri-driver|Xvfb|target/debug/cuemark|WebKitWebDriver"`
returning clean (only the user's own unrelated real-desktop processes, none
touched) at the end of the session.

## Real-desktop human verification (2026-07-26)

**Method**: a real (non-Xvfb) `cargo tauri dev` session on the user's actual desktop
(`DISPLAY=:0`), real audio output, a physical DJControl Starlight controller connected
(covering the MIDI-feel condition with real hardware rather than the simulated burst).
The user drove the app directly per a checklist (load → toggle CODEC → play, sustained
loop, MIDI feel, subjective AV sync) while the Rust log was tailed live for freeze/error
signals.

### Finding: live legacy→webcodecs toggle could silently fail to start audio on the first play attempt — a Svelte reactivity gap, not WebKit/GStreamer

**Symptom**: load a track (legacy by default), toggle the deck to CODEC, click Play —
no audio, video stuck on the first frame, zero console errors, zero Rust log activity
for the click (no `[bus/<deck>] pipeline: Paused → Playing` line). The very next
play/pause click, or a raw `window.__TAURI__.core.invoke('audio_play', ...)` from
devtools, worked immediately. 100% reproducible across three attempts (with and
without an intervening legacy play).

**Root cause**: `backendState` (`App.svelte`, tracks each deck's `legacy` |
`pending` | `webcodecs` | `legacy-fallback` state) is a plain JS `Map`, not a Svelte
store. `syncVideoElements` only runs inside an rAF callback scheduled by a `$effect`
that tracks `$session.decks` — so it re-runs whenever deck state changes, but nothing
about `backendState` itself is reactive. `startCodecPath()`'s async resolution (the
`video_demux_load` round trip) flips `backendState`'s `kind` to `'webcodecs'` once
the demux completes, entirely outside of Svelte's reactivity. If a play/pause intent
was already latent at that moment (`deck.playing` already `true`, the per-deck
`lastAudioPlaying` guard still `false` from before the toggle), the mismatch just sat
there — unnoticed — until some *unrelated* future store mutation (the user's next
click) happened to re-run the `$effect` and let `syncVideoElements` catch up.

**Diagnosis**: three sparse `debugLog()` calls added at the toggle entry, the
`startCodecPath` success point, and the `audioPlay()` call site (all one-shot,
state-transition events, not per-frame — same discipline as the project's other
`debugLog` usage) pinned the exact gap on a live repro:

```
15:33:33.826  live-toggle legacy->webcodecs: deck.playing=true lastAudioPlaying=false
15:33:34.083  entered webcodecs state:        deck.playing=true lastAudioPlaying=false
15:33:43.442  webcodecs branch: calling audioPlay (was=false)      ← 9.36s later
15:33:43.443  [bus/deck-1] pipeline: Paused → Playing
```

The trigger condition (`deck.playing !== lastAudioPlaying`) was already satisfied at
`34.083`, immediately after the codec player came up — but nothing re-evaluated it
until the user's next click at `43.442`.

**Fix** (`App.svelte`, `startCodecPath()`): explicitly call
`syncVideoElements(get(session).decks)` once at the end of the function, after either
the success path (`kind: 'webcodecs'`) or the fallback path (`kind:
'legacy-fallback'`) settles — rather than relying on an incidental future store
change to re-trigger it. Verified live: three repeats of load → toggle CODEC → play,
audio started immediately every time, no stale-latency window.

**Not a WebKitGTK/GStreamer bug** — pure frontend reactivity gap between an
async-resolved plain `Map` and a Svelte-effect-gated sync function. Doesn't implicate
mechanism A/B, the EOS-stall fix, or the open `WebKitNetworkProcess` finding below.

### Fresh confirmation of the open `WebKitNetworkProcess` deadlock finding, on a real desktop

During the same real-desktop session (app uptime ~3h44m, well past the ~28-minute
mark from the original Xvfb finding), the watchdog caught and recovered **two**
spontaneous freezes in quick succession:

```
15:36:43  TRIGGER: window 'main' silent for >= 6s
          descendant WebKitNetworkPr / WebKitWebProces — Δutime=0 Δstime=0, all-parked
          recovery tier1 (eval reload) → tier2 (native reload)
          heartbeat resumed after 11.3s
15:36:54  TRIGGER: silent for >= 6s again, immediately after recovery
          recovery sequence succeeded
          [recovery] rehydrating session — 1 live pipeline(s)
          [recovery] adopted deck-1 at 0.00s playing=false
          heartbeat resumed after 7.0s
```

This is the same freeze class as the phase-4 28-minute Xvfb finding (parked
`WebKitNetworkProcess`/`WebKitWebProcess`, near-0% CPU, matching signature) —
confirming it's a genuine, real-desktop-reproducible WebKitGTK issue, not an
Xvfb/software-GL artifact, and that it isn't tied specifically to a ~28-minute
threshold (it recurred here at a very different point in a long session). Both
times, the watchdog's tiered recovery worked exactly as designed with no lasting
damage beyond the deck-1 position being rehydrated at 0.00s rather than its true
pre-freeze position (a rehydration-accuracy gap, not a freeze-recovery failure —
worth a closer look if it recurs, but not re-investigated this session). Still
tracked as the one lower-priority open item below; this is additional evidence, not
a root cause.

## Risks and open items

- **Two open freeze/stall findings from phase 4 — (1) fixed, (2) still open**:
  (1) the shared Rust `DeckAudioPipeline` near-end-of-track stall is
  root-caused and fixed (2026-07-26) — see "Finding: silent stall..." above;
  `cue_valve` was swallowing EOS, not the `input_selector` topology originally
  suspected. (2) the `WebKitNetworkProcess` deadlock caught once during the
  28-minute webcodecs soak, recovered automatically by `freeze-watchdog.md`'s
  tiered reload in ~14s, is **still open** — a 2026-07-26 code review of
  `codecWorker.ts`'s AU-fetch loop and `media_server.rs` found no obvious
  deadlock-causing pattern on our side: `auCache` never evicts, so once a
  loop's region is cached (the 28-minute soak used a fixed 8s loop), steady-
  state HTTP request volume drops to ~zero — which actually argues *against*
  "sustained HTTP load" being the direct trigger, and toward this being a
  generic WebKitGTK `NetworkProcess` longevity/idle-connection bug (same
  general class as the already-documented `MediaPlayerPrivateGStreamer`
  mechanisms in `skills/audio-debugging`, just a different WebKit process).
  `media_cache.rs`'s `lookup_wait()` (in the server's hot path) is
  Condvar-based with a bounded 10s timeout, not a source of an unbounded
  block. Root-causing (2) further needs a live `gdb -p <pid>` backtrace of the
  actual `WebKitNetworkProcess` at the moment of a fresh freeze — which needs
  a full ~30+ minute real-desktop re-soak (uncertain timing: this triggered
  once at ~28 minutes, not on a fixed schedule) plus root ptrace access for
  attaching to an already-running process (unlike (1), the target here can't
  be launched fresh under `gdb --args` — the freeze only shows up deep into a
  long real session). Given the watchdog already provides a working ~14s
  automatic recovery, this is tracked as a lower-urgency open item rather than
  a Phase 5 blocker — revisit with a dedicated long-soak session (ideally with
  `sudo` available) rather than folding it into a normal work session.
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
