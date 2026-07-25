# WebCodecs video path: replacing the `<video>` element for deck playback (design)

Status: **phase 3 done (2026-07-25)** — audited and live-tested the legacy/codec-path
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
