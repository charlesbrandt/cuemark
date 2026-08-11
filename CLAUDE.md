# Cuemark

VJ / live A/V mixing software for Linux. Built for live performance: garage dance parties,
projector output, MIDI controller integration. Open source goal.

Domain: cuemark.com (Charles Brandt's former DJ name)

## Tech stack

- **Tauri** (Rust backend + WebKit frontend) — cross-platform, Wayland-native on Linux via GTK4
- **WebGL** — GPU-accelerated rendering, FBO-per-deck compositing
- **GStreamer** (Rust, `gstreamer` + `gstreamer-audio` crates, `features = ["v1_18"]` required) — audio playback, gain/EQ, device routing, headphone cue mix, recording. Each deck has its own `DeckAudioPipeline` (uridecodebin → queue → audioconvert → audioresample → capsfilter(48kHz) → pitch → output_queue → volume → pulsesink/autoaudiosink). Audio is the master clock; video element syncs to it.
- **Web Audio API** — FFT analysis for BPM detection and audio-reactive visuals (not used for playback or waveform peak extraction — that runs in Rust via `audio_analyze_file` to avoid VA-API corruption)
- **GLSL shaders** — effects and audio-reactive visualizations
- **Rust `midir` crate** — MIDI input (Web MIDI API unreliable in WebKitGTK); events piped to frontend via Tauri IPC
- **`<video>` element → 2D canvas → texImage2D** — video decode into WebGL texture via a scratch canvas intermediary (direct video→texImage2D triggers SIGTRAP assertion failures in WebKitGTK; see `fbo.ts`). The `<video>` element is **muted** — audio is owned by the GStreamer pipeline.
- **Local HTTP media server** — WebKitGTK's GStreamer media backend cannot reliably resolve custom URI
  schemes (`media://`, `asset://`) for `<video>` elements: confirmed empirically (instant `FormatError`,
  no GStreamer pipeline ever constructed, regardless of codec or `WEBKIT_DISABLE_DMABUF_RENDERER`). Both
  dev and prod instead serve local video files over plain HTTP, which `souphttpsrc`/WebKit handle natively:
  - **Dev**: a Node.js middleware in `vite.config.ts` serves `http://localhost:1420/media/<abs-path>`.
  - **Prod**: `src-tauri/src/media_server.rs` runs a `tiny_http` server on an ephemeral `127.0.0.1` port
    (Range-request support for seeking), started in `lib.rs` `run()` and exposed to the frontend via the
    `media_server_port` Tauri command. `App.svelte` fetches the port once in `onMount` and builds
    `http://127.0.0.1:<port>/<abs-path>` for video `src`.
  Never use `asset://` or `file://` from an `http:` origin — WebKit blocks them silently.

## Architecture

### Audio pipeline

```
GStreamer (Rust, per deck):
  uridecodebin → queue(2buf) → audioconvert → audioresample
    → capsfilter(48kHz) → pitch(tempo) → output_queue(100ms) → tee
                                                                  ├─ volume₀ → sink₀  ┐ one branch per main device
                                                                  ├─ volume₁ → sink₁  ┘ (≥1; empty → system default)
                                                                  └─ cue_valve → cue_volume → cue_queue → cue_sink
```

`AudioManager` (held in Tauri managed state as `Mutex<AudioManager>`) owns all `DeckAudioPipeline` instances.
Tauri commands (`audio_load`, `audio_play`, `audio_pause`, `audio_seek`, `audio_set_rate`, `audio_set_gain`,
`audio_set_volume`, `audio_set_eq`, `audio_set_cue`, `audio_get_position`, `audio_set_master_volume`,
`audio_set_main_devices`, `audio_set_cue_device`, `audio_set_cue_gain`, `audio_record_start/stop`) expose the
pipeline to the frontend. The frontend wrapper lives in `src/lib/audio/pipeline.ts`.

**Audio is the master clock.** The `<video>` element is muted and used only for frame decode; the RAF loop
integrates GStreamer position deltas (via `contentPosTracker`) to recover actual content position at
`deck.playbackRate`, since `query_position` always returns wall-clock stream time. Rate changes go through
the `pitch` (soundtouch) element's `tempo` property (0.1–4.0) — pitch-preserving, no seek/flush needed.
Device routing uses `pulsesink device=<pipewire-node-name>` (empty device = system default),
falling back to `autoaudiosink` if `pulsesink` is unavailable. **Not `pipewiresink`** — the native
element deadlocks whenever two or more of them in one process go PAUSED→PLAYING with any delay,
which cuemark does on every play (≥1 main sink + the cue branch per deck). See
`docs/design/pipewiresink-play-hang.md` before changing the sink; re-run
`scripts/probes/pipewiresink_multisink_deadlock.py` if you do.

**Full gotchas and rationale** — position-tracking drift math, the `pendingSeekTarget` seek-race filter,
why `v.playbackRate` writes must be rAF-throttled, rate-then-seek ordering, EOS handling, PipeWire quantum
sizing, preroll, the `uridecodebin` video-decoder-skip signal, and the tee/`async=false` sink topology:
`docs/design/av-sync-architecture.md`. **Read it before touching** video playback, seeking, rate changes,
or the MIDI-to-audio path — several of these are subtle, previously-fixed races that are easy to reintroduce.

### Rendering pipeline

**Compositing happens in the output window, not the control window** (2026-08-03). The two
windows are separate `WebKitWebProcess`es, and what crosses between them is *per-deck frames*,
never a composited image:

```
CONTROL WINDOW (App.svelte frame())          |  OUTPUT WINDOW (output.ts)
                                             |
VideoDecoder ──► VideoFrame ──┐              |
<video> ──► drawImage ──► scratch canvas ──┤ |
                              ▼              |
        createImageBitmap(…, imageOrientation:'flipY')
                              │              |
                              └─ BroadcastChannel('cuemark-output') ─►  Compositor
                                 { decks:[{id,opacity,bitmap}], viz… }      │
                                             |                    texImage2D ──► [FBO N]
                                             |                              alpha composite
                                             |                            + visualization layer
                                             |                                    ▼
                                             |                            visible WebGL canvas
```

Each FBO renders at full output resolution. Compositor alpha-blends decks back-to-front by `opacity`.
The crossfader is a UI/MIDI convenience that drives two selected decks' opacities inversely — not a
structural field in the data model.

**Why it is split this way**: the control window used to composite and ship a
`createImageBitmap()` snapshot of its WebGL canvas. That is impossible on this machine — all
GPU→CPU readback from WebGL is broken in the Mesa `crocus` driver, so every snapshot arrived
correctly-sized and *fully transparent*, silently (see the readback warning below). WebGL
**display** works fine, so the fix is to never read back: ship the compositor's *inputs* and
composite on the side that displays. The contract, the probe evidence and the reasoning live in
`src/lib/renderer/outputProtocol.ts` — **read it before changing anything about the output path.**

Consequences worth knowing:
- The control window has **no compositor and no WebGL context at all**. There is no composited
  preview in the control UI; adding one means a real visible canvas plus its own `Compositor`,
  never a hidden one to capture.
- **`postFrame()` does nothing unless the output window is listening.** It builds a
  full-resolution `drawImage` + `createImageBitmap` per changed deck at up to 60fps, and until
  2026-08-03 it did so even with no output window open — the single largest consumer of the
  control window's frame budget (`docs/design/control-window-frame-budget.md`). The output
  window beacons `alive` every second; the sender gives up after 3s of silence. It is a beacon
  rather than a goodbye-on-unload because a window killed by the freeze-watchdog or the window
  manager never gets to say goodbye, and believing a dead window is alive wastes work forever.
- Only decks whose frame actually changed carry a bitmap; `bitmap: null` means "reuse the FBO".
  A paused deck costs nothing per frame. The output window sends `{kind:'hello'}` on load to ask
  for a full re-send, which is what makes a window opened mid-set (or reloaded by the
  freeze-watchdog) show paused decks instead of black.
- ⚠️ **Orientation on this WebKitGTK is broken in *two* independent ways, and the only
  combination that works is canvas + `imageOrientation`.** Both failures are silent — no GL
  error, no exception, just unflipped pixels — and both are WebKit-level, identical under
  llvmpipe and on hardware:
  - `UNPACK_FLIP_Y_WEBGL` is ignored for **`ImageBitmap`** sources, so `uploadImageBitmap()`
    in `fbo.ts` deliberately sets no pixel-store flag. (The `<video>`/`VideoFrame` upload
    paths there still use the flag and still need it.)
  - `createImageBitmap(…, {imageOrientation:'flipY'})` is ignored for **`VideoFrame`**
    sources. It is honored for a canvas source — which is why `outputBus.ts` routes *every*
    deck frame, codec and legacy alike, through a scratch canvas before constructing the
    bitmap. Shipping codec frames straight from the `VideoFrame` saves a copy and puts the
    projector upside down (2026-08-03).

  Verified by `scripts/probes/imagebitmap_upload_probe.py` (`orient/*` cases), end-to-end by
  `scripts/probes/output_window_compositor_probe.py` — which drives the real `postFrame()`
  with a codec-kind source rather than a hand-rolled bitmap, precisely because the earlier
  hand-rolled version passed while the shipping app rendered upside down.
- A newly created `DeckFBO` clears itself to transparent black. `texImage2D(…, null)` allocates
  but leaves contents *undefined*, and an empty deck is still composited at its own opacity — so
  without the clear the projector blits uninitialised GPU memory.

**`WEBKIT_DISABLE_DMABUF_RENDERER=1` is RETIRED as the default** (2026-08-02) — GPU compositing is now
on. It was originally set in `main.rs` to prevent VA-API DMA-BUF canvas corruption via
`drawImage(video)`, but that premise died in `f6b94ea` when WebCodecs became the default video path
(`VideoDecoder` → `texImage2D(VideoFrame)`, no `<video>` element). Two independent measurements
condemned it, both same-binary A/Bs with only this variable changed:
- **Performance**: it forced WebKit to composite the whole page in software on the main thread —
  55–59% of all main-thread samples in `libwebkit2gtk`'s software rasteriser; 87% → 62% main thread
  for two decks, rAF stalls 6 → 0.
- **Correctness**: it *corrupted the WebGL compositor canvas*, rendering growing horizontal bands of
  uninitialised memory. This was the long-running "output window noise" — which was never an
  output-window bug; that window faithfully mirrored an already-corrupt compositor canvas. Unset, the
  canvas is clean. User-confirmed live.

Set `CUEMARK_DISABLE_DMABUF=1` to restore the old behaviour. If VA-API canvas corruption ever
appears, fix it with a codec-specific `GST_PLUGIN_FEATURE_RANK` demotion, not by re-killing the
renderer process-wide. See `docs/design/output-noise-and-track-reload-silence.md`,
"ROOT-CAUSED 2026-08-02 (late)".

🔴 **The previously-untested path — the legacy `<video>` fallback — was exercised live on
2026-08-05 and it is unusable.** On that path `drawImage(video)` in `DeckCard`'s preview loop
costs **86ms median / 300ms worst per call**, 61–68% of the control window's wall clock, taking a
playing deck from 58fps to 5.6fps and starving the GStreamer audio threads into underruns. Cost is
per-call and independent of resolution (640×480 VP9 measured 7× *more* expensive than 1080p AV1),
so it is not decode and not pixel work. The failure is a stall, not the predicted corruption.
**Root-caused 2026-08-05 in two parts, both measured:**
- **The per-call cost is a property of the video codec feeding the `<video>` element**, not of
  the legacy path and not of DMA-BUF. A single-variable pair (same frames, same container, same
  640×480@25, only the codec re-encoded) cost **22–24ms on VP9 against 8ms on H.264**, with
  *more* main-thread `busy%` at *less* process CPU — so the call is parked, not working. It is
  inside WebKit's GStreamer media player and cuemark cannot fix it; the only lever is not to use
  a `<video>` element for that codec (extend the WebCodecs demux gate). ❌ **`CUEMARK_DISABLE_DMABUF=1`
  makes it strictly worse** (22–32 → 54ms/call, 17.2 → 9.1fps) — do not reach for it.
- **The draw *frequency* was separately broken and is now fixed.** `video.currentTime` advances
  continuously here, so the preview's `currentTime !== lastDrawnTime` change-check gated nothing
  and every legacy deck drew on 100% of rAF ticks. It now compares
  `getVideoPlaybackQuality().totalVideoFrames` (`legacyFrameChanged()` in `DeckCard.svelte`),
  which the probe measured advancing at exactly the source frame rate. A 6fps file went
  `drew=133/133` → `30/258` and **26.4 → 51.6fps**. ⚠️ **`requestVideoFrameCallback` is exposed
  here but was deliberately not used** — its firing rate cannot be verified outside the app
  (a bare webview has no display-refresh source at all), and a preview that never draws is worse
  than one that draws too often.

**Fixed 2026-08-05 for VP9, by not taking the path at all.** `video_demux.rs` now accepts
**H.264 and VP9** (`CodecKind`, `vp9parse` with `alignment=super-frame`, a derived
`vp09.PP.LL.DD` string); `codecWorker.ts`'s `needsAvcRemux` is the single switch — H.264 keeps
its mandatory avc `description` + Annex-B→avc re-mux, VP9 gets neither and its AUs go to
`decode()` untouched. The worst library file went **23.9–28.6 → 54.2–56.4fps**, per-call
19–22ms → 0.0ms, `busy%` 49–52 → 9–10. ⚠️ **Process CPU is flat across that change** (61.0 →
60.1%) — there is no VA-API on this machine so VP9 is software-decoded either way; what moved is
*where*, from a main-thread block into a decode worker. Read the fps and CPU numbers together.

✅ **The "VP9 decay" was a measurement artifact and does not exist (settled 2026-08-05
evening).** A live 2-minute play appeared to go 58.6fps → a ~13fps plateau with `busy%` flat
at 1–2%, which looked exactly like a paint-phase cost the sweep's metrics cannot see. A
7-minute controlled arm refuted it: **the frame rate oscillates 9–57fps continuously**
(n=182: min 8.7, p50 24.5, max 57.1) and recovers after every trough, so the "plateau" was a
short window on one trough. All three candidate mechanisms are refuted by measurement — leak
(webRSS spread 9MB across a full track, *under* the paused control's own 16MB sawtooth),
thermal (178ms throttled in 420s, and fps **anti**-correlated with temperature: 100.0°C mean
when fps>45 against 85.5°C when fps<20), and CPU starvation (`/proc/pressure/cpu full=0.00`;
`webCPU` is *higher* in the fast state). ⚠️ **A window shorter than ~2 minutes cannot measure
this machine's steady-state frame rate at all** — it samples a fraction of one oscillation
cycle and reads as a clean monotonic trend in whichever direction it sits, which is what
three separate "monotonic degradation" sightings were. Compare medians over multi-minute
runs. Tooling: `scripts/decay-sample.sh` + `scripts/decay-join.py` (always run the paused
idle control arm — it is what eliminated iowait and calibrated the leak threshold). Full
write-up: `legacy-video-fallback-cost.md` "2026-08-05 (evening) — the decay arm ran".

**Still on legacy `<video>`: AV1 — and live verification 2026-08-05 found it worse than
documented: zero video frames, not just a low frame rate.** `VideoDecoder.isConfigSupported({codec:
'av01.…'})` returns `true` here and then **decodes zero frames** — for a real file, in all four
bitstream framings, with and without a `description`, and for a 320×240 stream GStreamer's own
`av1enc` produced as a control. ⚠️ **Never trust `isConfigSupported` on this WebKitGTK; probe a
real decode** (`scripts/probes/webcodecs_vp9_av1_probe.py`). This doc previously claimed AV1 was
"survivable" at 26–54fps on the legacy `<video>` fallback — **that assumed some frames decode.**
A live session playing a real AV1 library file (1920×1080, 6fps, on the legacy path) for ~7
minutes logged `[aux-loop] preview/deck-N drew=0` on **every single tick, the entire time** —
audio played and cue toggled normally, but no video frame was ever presented, in either the
`DeckCard` preview or the output window. Immediately after, switching the same deck to a VP9
file on the webcodecs path drew frames normally in the same session, which rules out a general
rAF/preview-loop breakage. Root cause not yet confirmed — the Rust-side `WARNING: No decoder
available for type 'video/x-av1…'` in the audio pipeline's `uridecodebin` is expected/harmless
(it is deliberately skipping the video stream in the *audio-only* pipeline, see the log-pattern
table below) and says nothing about WebKitGTK's own internal `<video>` decode, which this
project cannot log into directly. See `legacy-video-fallback-cost.md` for the full writeup and
open questions.

See `docs/design/legacy-video-fallback-cost.md` and `webcodecs-video-path.md` "Phase 7" before
touching `DeckCard`'s preview loop, `video_demux.rs`'s codec gate, `codecWorker.ts`'s
`needsAvcRemux` switch, or anything about DMA-BUF.

⚠️ **The compositor canvas in `App.svelte` must not be `display:none`.** It was, from `ee91c54` until
2026-08-02, which meant nobody could see what the compositor actually produced — the single biggest
reason Bug A went unsolved for three sessions. Keep it laid out but visually negligible (1×1, near-zero
opacity, off-screen). Its WebGL drawing buffer is 1920×1080 regardless, set by the `width`/`height`
attributes rather than CSS. To debug compositing, temporarily give it a real size and a bright border —
that one change is what cracked the bug.
Also demote broken VA-API decoders via `GST_PLUGIN_FEATURE_RANK` in `main.rs` — currently only
`vaav1dec:0,vaapiav1dec:0`.
⚠️ **This demotion is a no-op today, and "H.264 hardware decode is deliberately live" (claimed
here on 2026-06-20) is stale: this machine has no VA-API driver for any codec.** Re-verified
2026-08-05 — no Intel `*_drv_video.so` under `/usr/lib/x86_64-linux-gnu/dri` (only d3d12,
nouveau, r600, radeonsi, virtio_gpu), no `gstreamer1.0-vaapi`, and `gst-inspect-1.0 va` registers
`0 features`. **Everything decodes in software**, so never explain a codec-specific cost
difference by hardware decode without re-running those three checks.
See `audio-debugging` skill for the full VA-API investigation, debugging tips, and env-var override
pitfalls.

**Waveform analysis uses `audio_analyze_file` Tauri command** (Rust/GStreamer, `analysis.rs`), not
`decodeAudioData` — avoids VA-API corruption in the separate WebKitWebProcess. It returns
`{ peaks, envelope }` (30/s display peaks + 210/s RMS envelope) used by `detectBeatGrid()` (`bpm.ts`)
to fit a fractional BPM and beat-level grid anchor, auto-populating `deck.bpm`/`deck.downbeat` on load.
A saved grid (DeckCard SET BEAT button) beats the auto-fit — see `gridSource.ts`. `Session.snapToBeat`
(SNAP toolbar toggle) routes seeks/hot-cues/loop points through `quantizeToGrid()` in `seekBus.ts`.

**Direct manipulation (waveform drag, vinyl jog) drives the scratch feeder by absolute
*position*, never by rate** — `scratch_to()` in `pipeline.rs`, the scrub bus in `seekBus.ts`.
Both inputs are burst-delivered (USB MIDI ticks; rAF- and WebKit-coalesced pointer moves),
which makes a velocity estimate unrecoverable: the inter-event interval it divides by is an
artefact of delivery timing, coalescing a *rate* silently discards motion, and with no
absolute reference the error accumulates for the whole gesture. A target has none of those
failure modes and coalesces losslessly. Shuttle-mode jog deliberately stays on the velocity
path (`scratch()`) — free-running between ticks is the point of that mode.
**Read `docs/design/waveform-scrub.md` before touching** `WaveformCanvas`'s pointer
handlers, the scrub bus, `jog_nudge`'s vinyl branch, or the feeder's servo. `VINYL_SEC_PER_TICK`
is calibrated (`1.8 / 256`; the Starlight encoder reports plain ±1 deltas, measured live —
re-confirmed 2026-08-09 at 243 and 247 ticks/revolution).

🟢 **"Slow-jog audio gates out" — FIXED 2026-08-11, live-confirmed.** The cue branch was
chopped into ~80% digital silence during a scratch while main played normally — **GATED, not
pitched**, and not starvation (delivery probes read `cuevol=67/s cuesink=67/s` throughout).
Cause: **two `pulsesink`s on one PipeWire node.** Fix: **one `pulsesink` per device node**,
fed by an `audiomixer` summing one live `appsrc` per deck branch, with deck pipelines
terminating in `appsink`s (`audio/mixer.rs`'s `OutputGraph`, rung C of the fix ladder).
Enabled by `CUEMARK_SHARED_OUTPUT=1`; **still defaults off** pending the multi-deck /
multi-node pass. **Read `docs/design/shared-output-pipeline.md` before touching any of it**,
and `slow-jog-audio-inaudible.md` §10.14 for the closing account.

⚠️ **The mechanism was never named, and the fix does not name it.** §10.11 established that
two sinks *and* the Starlight are each necessary and neither sufficient; §10.12 that the two
streams are indistinguishable at the PipeWire layer in both the failing and working arms. What
was established is that **one sink on the node is sufficient**, so the fix reaches that
configuration structurally. If it ever resurfaces on other hardware, the remaining tap is
below PipeWire (ALSA/USB) — §10.12's last paragraph.

**Three things in the shared graph are load-bearing and silent when broken:**
- **`is-live=true` on every output `appsrc`.** With it false the mixer emits **zero** buffers
  for as long as any branch is idle — one paused deck silences the whole node. Measured:
  `scripts/probes/shared_output_mixer_probe.py --not-live`.
- **Deck pipelines `use_clock()` the graph's clock.** In practice that is `GstSystemClock`
  and `pulsesink` slaves its device to it — rate agreement holds, but via the sink's slaving
  rather than the device clock the design first assumed. The log line says which.
- **`position()` subtracts the graph's latency — measured 171.3ms.** An `appsink` reports the
  last buffer handed off, not what the device is playing. Uncorrected, video leads audio by a
  sixth of a second on every deck, constantly, and it reads exactly like "the video decoder is
  early".

Each node also carries a permanent silent `audiotestsrc` keepalive: an `audiomixer` with no
pads cannot reach PLAYING, and a retained node with no live pad runs dry and never resumes.

⚠️ **Two instruments changed meaning on this path.** `output_queue underrun` now fires
continuously during ordinary playback (the appsink renders just-in-time, so the queue empties
between every buffer) — downgraded to info here, still a warning on the legacy path. And the
scratch sink-alignment widening reports `SKIPPED(no property)` because `appsink` is not a
`GstAudioBaseSink`; that is correct, since re-stamping at the handoff means the shared sink
never sees a discontinuity to resync on. Neither is a regression.

⚠️ **The `buffer-time`/quantum lever (§10.13) is a dead rung** — `clock.force-quantum 512`
worked once, but reaching the same quantum from inside the app via `sink_buffer_times()` does
**not** hold: the gating returns after a short playback duration. It moves the symptom without
fixing it. `sink_buffer_times()` keeps its 200ms default.

**It is not the device.** `/proc/asound/card1/stream0` is a bare USB Audio Class endpoint (4ch
S24_3LE, 44100 only, `Channel map: FL FR RL RR`) — no Dolby, no DSP. "Analog Surround 4.0" is
*PulseAudio's profile name* for a 4-channel analog output, not a surround format. And the
gating was measured in the PipeWire sink **monitor**, upstream of the DAC. The Starlight is
**one PCM, one subdevice, four channels** (`subdevices_count: 1`) — "Front" and "Rear" are
channels 0–1 and 2–3 of a single stream, which is exactly why one sink per *node* is the
honest shape and why `front_and_rear_of_one_device_are_one_node` is a unit test.

⚠️ **Six hypotheses were refuted along the way; do not re-run them** — caps renegotiation on
the cue branch, PipeWire node suspend/resume, jog rate, the cue sink being excluded from the
scratch alignment widening (that one was *correctly applied and insufficient*, not refuted),
channel-layout mismatch between the branches, and generic co-tenancy (two `pulsesink`s on the
*USB CODEC* scratch cleanly). Full account: `docs/design/slow-jog-audio-inaudible.md` §10.

⚠️ **`scratch-envelope.py` defaults changed 2026-08-10** — `--channels` now defaults to `auto`
(picks the pair carrying signal, warns when the pick is near-arbitrary), an all-silent pair now
says so instead of printing no verdict, and the cross-pair note distinguishes a *dead* pair from
a **live-but-gated** one. Two new modes: `--extract OUT.wav` writes the analysed pair as plain
stereo so a capture can be *listened to* rather than only tabulated, and `--by-gesture` ranks
each `feeder start`/`stop` gesture by how long its audio survived and contrasts the extremes —
refusing to draw the contrast when no gesture in the take stayed audible, since ranking an
all-failing take sorts failures by degree and reads exactly like success-vs-failure.
**Capture the working state, not more of the broken one**: the failing state is over-sampled at
n=64: a useful take is a long one with many varied turns including the ones that sound
continuous, which `--by-gesture` then sorts out with nothing marked by hand.

⚠️ **`instrument_level()` reports `dBFS/zero%` per channel — read `zero%` first.** A windowed
RMS averages a duty cycle into a level: 25% duty cycle is −6.0 dB *exactly*, so the cue pads
reading ~−25 dBFS against main's ~−19 was the gating in plain sight, mistaken for `cue_gain`
for a full session. **Gating and attenuation are indistinguishable in a windowed RMS.** The
tell: during normal playback main and cue read equal, and the gap opens only during a
scratch. Two things in a clean reading look like faults and are not — `-inf/100%z` on
channels 0,1 of the post-matrix probe is the mix-matrix working as designed, and 30–35%
`zero%` spikes at gesture boundaries are the feeder's designed ramp (they appear *equally* on
main and cue; the fault signature is cue rising while main stays low).

⚠️ **The prior "RESOLVED — it was pitch" verdict was measured correctly and answered the
wrong question**, and the mistake is the reusable lesson: the analysis ran on channels 0,1
(**main**) while the user was monitoring on **headphones**, which on this device is a
different physical channel pair. The pitch arithmetic is real — sustained jog gestures do run
the cursor at 0.10–0.26x, ~2.7 octaves down, and `Jog scale` (`jogSecondsPerRev`) is a
genuine taste lever — but it was never what the user was hearing, and the same capture had
digitally-silent headphone channels nobody had looked at. **Ask which output the listener is
actually on before analysing any capture, and read both pairs:**
`scripts/scratch-envelope.py <cap>.wav --channels 2,3`. Full account, including six refuted
mechanisms not to re-run: `docs/design/slow-jog-audio-inaudible.md` §10.

⚠️ **The generalisable part**: every instrument in the audio path is a level, a count, or a
state — `rms` is blind to frequency *and* blind to duty cycle, so the feeder's own `rms` read
healthy the entire time and *could not have shown this*. **An instrument that cannot vary
with the fault carries no information about it; a clean reading from one is no evidence, not
weak evidence.** When the producing stage reports healthy AND delivery counters advance AND
the user still reports the fault, stop reading telemetry and **capture the signal** — see the
`audio-debugging` skill, "Capture the actual output and look at it".

⚠️ **Before spending a build on a hypothesis, ask which instrument would read differently if
it were true — and if the answer is "none of the current ones", build the instrument first.**
The `zero%` probe took ten minutes and was worth more than the three hypotheses that died
around it. A timeline of a handful of gestures will always suggest *some* ordering variable;
with a ~1-in-7 base rate it has no power to choose between the many equally good answers, and
two hypotheses were built that way and died on the first controlled arm.

⚠️ **One bounded exception to "never by rate", added 2026-08-08: `HandTracker` in
`pipeline.rs`.** A slowly-moving hand does not produce a steady event stream — measured at
**5–12 pointer events/s** with gaps to 1180ms while the hand was still moving — so between
events the servo converged and faded, muting 15–45% of a gentle gesture. It now coasts:
extrapolates the target along an estimated hand speed, tapering over 300ms and capped at 50ms
of content. Velocity is still not the control variable; position is, so every real target
re-anchors the cursor absolutely and an estimate error can neither accumulate nor persist.
Delivery legs are instrumented per gesture by `src/lib/audio/scrubStats.ts`
(`[scrub-deliver]`/`[scrub-sec]`) — read them before blaming the servo again, which three
sessions did by mistake.

**Reverse scrub video is served from a retained ring of decoded frames** in
`codecPlayer.ts`, sized by a byte budget alone (`FRAME_RING_BYTES = 192MB`, capped at
`MAX_HELD_FRAMES = 32`) — 17 frames at 4K, 32 at 1080p and below. A duration target
(`RING_TARGET_SECONDS`) was tried on 2026-08-09 and **removed the same day**: it fixed 4K
and simultaneously cut sub-4K content, i.e. most of the library, from 32 frames to 9. A
larger ceiling fixes 4K without that cost. If a high-frame-rate file ever scrubs short, add
a duration *floor*, never a target that can shrink a window the ceiling would allow. Decode
is forward-only and GOPs here are ~250 frames, so an out-of-order frame costs ~125 frames of
software decode (no VA-API on this machine) and doing that per scrub step is a live **audio**
regression, built and reverted 2026-08-09. 🛑 **Do not lower `BACKWARD_JUMP_SECONDS` or make
the `setClock` anchor accumulate backward travel** — widen the ring instead. The design,
the brittleness inventory and the directional-working-set roadmap (keyframe thumbnail cache,
directional prefetch, hot-region pinning) are in `docs/design/codec-frame-cache.md`; the
operational "which knob, what symptom" version is the `tuning-knobs` skill.

**`deck.downbeat` is a beat-level phase anchor, NOT bar-beat-1** — every consumer
(`getPhase`, `quantizeToGrid`, `nudgePhaseToMaster`) works mod one beat, and nothing detects
bar identity yet. It must carry the comb fit's *measured* `gridOffset`; anchoring it at `t=0`
instead silently breaks beat sync outright (each deck's reported phase is then off by a random
fraction of a beat, so NUDGE reports alignment two decks don't have). That regression shipped
2026-07-25 and was fixed 2026-08-08. **Read `docs/design/beatmatching.md` before touching**
the grid anchor, the Digger grid-trust path, Sync/Lock/NUDGE, or downbeat detection — it also
holds the roadmap (Digger provenance-aware trust, quantized play, phase-lock PLL, bar detection).

**Canvas sizing rule — always use JS, never rely on scoped CSS width**: WebKitGTK does not reliably
apply CSS width to a `<canvas>` inside a flex child (falls back to the 300px intrinsic default).
Every canvas must size its pixel buffer via a `ResizeObserver` + `c.style.width/height` set in a
`resize()` function — never via CSS `width:`. Reassigning `canvas.width`/`height` resets 2D context
state (re-apply `imageSmoothingQuality` after every resize).

**Full gotchas and rationale** — the grid-persistence trust-flag bug, the RAF actual-change-check
discipline, why MIDI-driven `syncVideoElements` must be rAF-throttled, the 14-bit fader tolerance fix,
and the `audioSync.ts` Svelte-store-bypass pattern for continuous MIDI controls:
`docs/design/av-sync-architecture.md`. **Read it before touching** the render loop (`App.svelte`
`frame()`), `WaveformCanvas`, grid persistence, or the MIDI handler's continuous controls.

### Dual output

- Window 1 (control): deck previews, crossfader, media browser, MIDI status. Ships per-deck
  frames; does no compositing of its own.
- Window 2 (output): **runs the compositor** and displays it fullscreen on the projector
  (display 2). Its drawing buffer is fixed at 1920x1080 by the canvas `width`/`height`
  attributes; CSS only scales it, so resizing never reallocates deck FBOs.

See "Rendering pipeline" above and `src/lib/renderer/outputProtocol.ts` for the message contract.

### Data model

`src/lib/state/types.ts` is the source of truth for `Deck`, `Session`, `Visualization`,
`AudioAnalysis` and related types — read it directly rather than trusting a copy here; its
inline comments carry the same field-level rationale (units, ranges, invariants) this section
used to duplicate, and duplicating it let this doc drift out of sync with real fields
(`eq`, `cueEnabled`, `syncLocked`, `masterDeckId`, `midiMapping`, Digger integration, `loadSeq`
reload-detection) more than once.

### MIDI architecture

Rust backend (`midir`) receives raw MIDI → maps to structured actions → emits via Tauri `emit()` → frontend applies to session state → calls audio Tauri commands for gain/rate/play/pause changes. MIDI mappings reference `deckId` strings.

## Deck sources

Decks are video-only — `DeckSource` is `{ type: 'video'; filePath; duration } | null`.
Load a file, loop, control playback rate. `<video>` element → WebGL texture.

## Visualization layer

Shader visualizations (Plasma, Tunnel, Particles, Feedback, Scope, …) are **not** a deck
source. They live as a single global layer on `Session.visualization` (`fragmentSrc`,
`uniforms`, `name`) with its own `Session.visualizationOpacity` (default `0.5`, so deck
video stays visible underneath — turn it up to 1.0 for visualization-only).

**Why this is a separate layer, not a per-deck source (architecture decision, 2026-06-21)**:
the original design let a deck's source switch between `'video'` and `'shader'`. Selecting
a visualization on a deck replaced that deck's source, and `syncVideoElements()` in
`App.svelte` treats any non-video source as "tear this deck down" — it called
`audioUnload()`, killing music playback the instant a visualization was picked. Since VJs
want visualizations *blended over* a playing track, not swapped in for it, the fix is
structural: visualizations never touch deck state at all.

**Rendering**: `Compositor` (`src/lib/renderer/compositor.ts`) holds one extra `DeckFBO`
(`vizFbo`) and one cached GLSL program (`vizProgram`) outside the per-deck `fbos`/
`shaderPrograms` maps — there is always at most one active visualization, so no map is
needed. `renderVisualization(fragmentSrc, uniforms, time, analysis)` renders into `vizFbo`
exactly like `renderShader()` does for a deck. `composite(decks, visualizationOpacity)`
blends all deck FBOs back-to-front as before, then — if `visualizationOpacity > 0` — blits
`vizFbo` on top as a final pass using the same shared blit shader.

Since 2026-08-03 all of this runs in the **output window** (`src/output.ts`), driven by the
frame messages it receives rather than by `App.svelte`'s `frame()` loop. The shader *source*
is sent only when it changes — it is far too large for a per-frame path — while `u_time`, the
audio-analysis bands and any custom uniforms ride along with every frame. `App.svelte` still
decides *when* a frame is due (an active visualization animates continuously, so it always
marks the frame dirty); it just no longer renders it.

Standard uniforms fed to every visualization shader: `u_time`, `u_resolution`,
`u_bass`/`u_mid`/`u_high` (from `AudioAnalysis`, max-across-playing-decks), plus any custom
uniforms declared on `Visualization.uniforms`.

**UI**: controls live in `src/components/VisualizationPanel.svelte` (shader picker + opacity
slider), toggled from a toolbar button in `App.svelte` — mirrors the existing `Audio`/`Queue`
panel-toggle pattern. `DeckCard.svelte` no longer has any shader-picker UI.

## Active architecture plan (2026-07-25)

The WebKitGTK freeze mechanisms (see `skills/audio-debugging` "UI frozen solid" entry)
are being fixed structurally, not mitigated further. Read these before touching video
playback, the drift-resync path, or anything freeze-related:

- `docs/design/freeze-watchdog.md` — **build first**: Rust heartbeat watchdog +
  session-of-record + webview reload recovery.
- `docs/design/webcodecs-video-path.md` — **build second**: replace the `<video>`
  element with WebCodecs `VideoDecoder` slaved to the Rust audio clock. Feasibility
  spike passed (results table in the doc).
- `docs/design/native-output-pipeline.md` — shelved escalation path; do not start
  without an explicit decision.

## Open findings from the 2026-08-05 live set

Two distinct faults were root-caused from a single ~3-hour session's log. **Both are open again
as of a same-day live verification pass** (see below) — neither should be cited as closed.

- `docs/design/legacy-video-fallback-cost.md` — 🔴 **REOPENED 2026-08-05 (late), by the live
  verification the doc itself called for.** A1/A2/A4 (codec-linked cost, the draw-frequency
  fix, moving VP9 to WebCodecs) all still stand and are not in question. What broke on
  live verification: (1) the **55fps VP9 number does not hold** — a real ~2-minute play of the
  same worst-library-file decayed 58.6 → ~13fps while `busy%` stayed 1–2%, the signature of a
  paint-phase cost the automated sweep's metrics cannot see; (2) **AV1 on the legacy path
  renders zero video frames**, not just a low frame rate — audio and cue worked, `drew=0` for
  a full ~7-minute play, worse than the doc's prior "survivable at 26–54fps" claim. Do not
  re-run the DMA-BUF arm (it made things worse in the earlier investigation) — neither new
  finding points at DMA-BUF. See the doc's "2026-08-05 live verification" section.
- `docs/design/audio-dropout-mid-playback.md` — 10.8s of silence mid-track with the pipeline in
  `Playing` and the frame rate healthy, ~21s after headphone cue was enabled on a USB controller
  carrying both the main and cue sinks. Fix the 6:1 false-positive rate in
  `instrument_sink_flow()` first or the soak will be unreadable. 🟢 **"No reproducer yet" is
  out of date** — see below. 🟢 **Instrumented 2026-08-08**: the cue sink previously carried
  **no probes at all** — the one branch H1 blames was the one branch that could not be
  measured — and the delivery counters were readable only during a scratch gesture. Both fixed
  (`[deliver-tel]`, above). ⚠️ **Nothing in this pipeline can see *clipping*.** The gap warning
  needs >1s of silence and `underrun` needs starvation; brief glitching is below the resolution
  of every instrument here, so **"the log is clean" and "the artifact is gone" are very nearly
  independent statements** — an 80s clean run on the live topology (2026-08-09) is the
  established baseline, not evidence of a fix.
- `docs/design/scratch-audio-downstream-delivery.md` — 🟢 **CLOSED 2026-08-08, in two stages,
  both user-confirmed live.** (1) The silence was `GstAudioBaseSink` resyncing its ringbuffer
  write pointer ~253ms *backwards* after `discont-wait` expired, fixed by widening the sink's
  alignment tolerance for the duration of a gesture. (2) The chatter/wobble left behind was the
  servo's designed `arrived ⇒ silence` firing in the gaps between the **5–12 pointer events/s**
  a slow hand actually produces, fixed by coasting (`HandTracker`, see "Direct manipulation"
  above). Keep the doc's three standing cautions: a **sustained negative delivery margin during
  a scratch is the fix working**, not a fault; `output_queue underrun` fires once per chunk by
  construction here (66.8/s against a 66.7/s chunk rate) and adjudicates nothing; and both
  `arrived%` on a decelerating hand and `snaps` on a coarse drag are silence **by design**, so
  ask for slow smooth zoomed gestures when requesting a repro. Still open in the neighbourhood:
  the deck runs three `pulsesink`s with two on one device, which remains
  `audio-dropout-mid-playback.md`'s H1 and a sufficient explanation for clipping during normal
  playback with cue open.

## Development phases

### Phase 1 — Two decks, crossfader, MIDI
- Load video clips to deck-0 and deck-1
- Loop playback, crossfade (video + audio)
- Hercules controller: jog wheels, crossfader, play/pause, volume faders
- Fullscreen output to display 2

### Phase 2 — Audio-reactive visuals
- Global visualization layer (composited above all decks, see "Visualization layer" above)
- FFT uniforms fed to shader (bass/mid/high, waveform)
- Built-in shaders: plasma, tunnel, particle field, feedback, scope
- BPM detection

### Phase 3 — Polish
- MIDI learn mode
- Shader effect overlays on video
- Media browser / clip library
- Remote control (network, phone as secondary)

## N-deck guarantee

Every layer is deliberately free of hardcoded deck counts:

| Concern | File | Mechanism |
|---|---|---|
| Data model | `src/lib/state/types.ts` | `Session.decks: Deck[]` — no count anywhere |
| Session store | `src/lib/state/session.ts` | `addDeck()` / `removeDeck()` / `updateDeck(id, patch)` by string ID |
| Compositor | `src/lib/renderer/compositor.ts` | `syncDecks(ids[])` allocates one FBO per deck; `composite(decks[])` iterates all |
| UI | `src/App.svelte` | `{#each $session.decks as deck (deck.id)}` — `+ Deck` button in toolbar |
| Seek | `src/lib/renderer/seekBus.ts` | `Map<deckId, HTMLVideoElement>` — `seekDeck(id, t)` works for any deck ID |
| MIDI | `src-tauri/src/midi.rs` | `MidiMap: HashMap<(u8,u8), ControlBinding>` — bindings reference deck IDs as strings |

The crossfader maps to two *named* deck IDs (`crossfaderMapping.left/right`), not indices 0 and 1.
Adding a third deck and reassigning the crossfader mapping is fully supported.

## Running

```
cargo tauri dev        # starts Vite dev server + Tauri window
npm run check          # TypeScript + Svelte type check
npm test               # vitest — beat-grid / BPM algorithm tests (bpm.test.ts)
cd src-tauri && cargo check   # Rust type check only
cd src-tauri && cargo test    # includes analysis.rs decode smoke test (needs GStreamer)
```

**Dev server lifecycle**: `cargo tauri dev` watches frontend files and hot-reloads them instantly.
Rust changes (`src-tauri/`) require a full recompile — Tauri detects them and rebuilds automatically,
but **the old binary keeps running until the rebuild finishes and the window restarts**.
If managing the dev server from Claude Code: kill the background process before making Rust changes,
then restart after. A change that was edited but never recompiled has no effect at runtime.

⚠️ **An HMR update to `App.svelte` remounts it, which tears the deck down and pauses playback**
— and repeated remounts can leave the GStreamer pipeline wedged (see the retry-storm tell under
"Standing performance instrumentation"). This makes edit-driven A/B measurement expensive: every
switch costs a remount, a re-play, and sometimes a track re-load. **Prefer an A/B switch that
needs no further edits** — a wall-clock sweep driven from `frame()` that advances arms itself and
stamps the arm on every log line, rearming on pause so each press of play is a fresh run
(`docs/design/control-window-frame-budget.md` §5). Keyboard switching is a trap twice over: F7/F8
never reach the webview on this desktop, and a raw `addEventListener` in `onMount` is not unwound
by HMR, so handlers belonging to destroyed instances keep logging switches that never took effect.

⚠️ **Vite can serve a stale transform of a file that is correct on disk.** Two rapid successive
writes to one file in a single command (e.g. a `sed -i` followed by a rewrite) can leave the
watcher holding the intermediate state, and its mtime-based dedupe then misses the second write.
On 2026-08-03 this served an `outputBus.ts` missing one import, so `hasListener()` threw a
`ReferenceError` every frame and the projector stayed black — while the source file was correct
and `npm run check` passed. **Before trusting a measurement run, diff the served artifact against
disk**, not just the source:
```bash
curl -s http://localhost:1420/src/lib/renderer/outputBus.ts | head -20   # what the app loaded
```
`touch`ing the file forces a re-transform. The built artifact is the thing under test, and this
project's failure modes are overwhelmingly silent — see the "silent-ignore" note in `journal.md`.

**The desktop-launcher release binary is a separate build that never auto-rebuilds** — unlike
`cargo tauri dev`, nothing watches `src-tauri/` for the launcher build (`~/.local/bin/cuemark`,
see `run-app` skill's "Desktop launcher" section). It only updates when someone explicitly runs
`npm run tauri build -- --no-bundle`. Caught stale by a month on 2026-07-26: a live-session freeze
was diagnosed against a binary built 2026-06-22, missing the *entire* webcodecs-video-path effort
(phases 1-5) and everything after — the freeze was old, already-fixed behavior, not a regression.
**Rebuild the launcher binary periodically, and always after a troubleshooting/design-doc session
that touched `src-tauri/`, before trusting a direct (non-`cargo tauri dev`) launch to reflect
current code.** `scripts/check-launcher-staleness.sh` reports whether it is behind (exit 1 = stale)
without forcing a slow release build.

**Build provenance is stamped into every run.** `build.rs` emits the git SHA, worktree
clean/dirty flag, and build timestamp as compile-time env vars; `lib.rs` logs them as the
first line of `setup()`:
```
[build] cuemark e998273 (dirty) profile=debug built=2026-08-02 18:15:04Z exe=…/target/debug/cuemark
```
The real hazard is not a stale build, it is not knowing which build is running — `exe=`
distinguishes the dev binary from the launcher one, and old log files keep their own stamp,
so a report from last week still identifies its code. Check this line before diagnosing
anything from a log.

⚠️ **`built=` is when `build.rs` last ran, not when the binary was last linked.** Cargo reruns
`build.rs` on its own trigger conditions, so an ordinary source edit can recompile and relink
while the stamp stays put — observed 2026-08-08 with the stamp 8s behind the exe's mtime. The
SHA and dirty flag are still right, which is what usually matters. To settle "is this binary
the current source", the reliable check is `cargo build` reporting `Finished` with no
`Compiling` line.

**First-time / new machine setup** (in addition to Rust + Node toolchains):
```bash
# GStreamer dev headers — runtime packages alone aren't enough
sudo apt install \
  libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev \
  gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
  gstreamer1.0-pipewire   # optional: enables device-specific routing

npm install                              # JS deps (node_modules not committed)
cargo install tauri-cli --version "^2"  # CLI subcommand; compiles from source (~5 min)
```

## Logging

`tauri-plugin-log` is wired up unconditionally in `lib.rs` `run()` (not gated to debug builds), at
`LevelFilter::Info`, targeting both stdout and the platform log directory. All backend `eprintln!`/
`println!` call sites (audio pipeline, MIDI, device enumeration, analysis) use `log::info!`/`warn!`/
`error!` instead, so output lands in the log file regardless of how the app was launched — including
from a desktop launcher with no attached terminal.

Log file: `~/.local/share/com.cuemark.app/logs/cuemark.log`. Tail it live to see MIDI events,
GStreamer bus messages, and pipeline state changes:
```bash
tail -f ~/.local/share/com.cuemark.app/logs/cuemark.log
```

**Rotation is 8MB + `KeepAll`, deliberately not the plugin's defaults.** 40KB/`KeepOne` let a
session self-erase in under two minutes at this app's log volume — twice on 2026-08-03 it deleted
the exact window being diagnosed, including the build-provenance line this file tells you to check
first. Rotated files are date-stamped, so a report from last week is still readable. If a log looks
suspiciously short, check whether it rotated before theorizing about what is missing.

See the `perf-log-reading` skill for the standing performance-log line formats
([poll-stats], [raf], [aux-loop], [deliver-tel], [scrub-deliver]/[scrub-sec]) and how to read them —
load it when investigating a performance regression, not every session.

## Skills

Project-specific skills live in `skills/`. Load one with `/skill-name` (or via the Skill tool) when
needed — don't load them on every session.

| Skill | When to load |
|---|---|
| `audio-debugging` | GStreamer bus errors, rate-change issues, layered/detuned audio, pipeline recovery, VA-API details |
| `run-app` | Launch and monitor the app; stop/restart for Rust changes; log patterns; GNOME desktop launcher |
| `verify-ui` | Screenshot/click/inspect the real webview headlessly via tauri-driver + Xvfb |
| `midi` | Hercules Starlight channel layout, full control map, adding or re-calibrating a controller |
| `digger-integration` | Digger API endpoints, WebSocket queue updates, cuemark/Digger boundary rules |
| `perf-log-reading` | Investigating a performance regression or reading a `[poll-stats]`/`[deliver-tel]`/`[scrub-deliver]` log dump |
| `tuning-knobs` | A feature is running and correct but *feels* wrong live, or a shipped fix reads as "not working" — which constant to reach for, its live symptom, and which ones are known traps |

Several automated test scripts build on `verify-ui`'s setup (tauri-driver + Xvfb +
`VITE_ENABLE_DEBUG_HOOK=1`):

| Script | When to run |
|---|---|
| `scripts/perf-idle-test.sh [video]` | CPU regression — samples `WebKitWebProcess` CPU% across empty/paused/playing scenarios. Run after touching the render loop (`App.svelte` `frame()`), `WaveformCanvas`, or `DeckCard`'s preview canvas. |
| `scripts/latency-test.sh <video> [backend]` | Full deck workflow — load track → waveform renders → position clock advances → `audio_set_rate` IPC latency stats → 200-event MIDI-rate burst with CPU check. `backend` is `legacy` (default) or `webcodecs` (docs/design/webcodecs-video-path.md phase 2 A/B toggle — added phase 4); on webcodecs the "video position" checks read `getCodecFramePts()` instead of `getVideoTime()` and a final step confirms zero legacy `<video>` DOM writes for the whole run. Run after touching the MIDI handler, `audioSync.ts`, or the GStreamer audio pipeline. |
| `scripts/rehydration-test.sh <video>` | `docs/design/freeze-watchdog.md` phase 2 gate — forced-reload session rehydration (deck/bpm/downbeat intact, audio position continuous, no stray `audioLoad`). Run after touching `session_store.rs`, `sessionRecovery.ts`, or `App.svelte`'s onMount rehydration path. |
| `scripts/watchdog-test.sh <video>` | `docs/design/freeze-watchdog.md` phase 3 gate — tiered recovery (`kill -STOP`/`freezeMainThread(0)`/`kill -KILL`) plus a 15s false-positive smoke check. Run after touching `watchdog.rs` or the recovery/adoption path. |
| `scripts/watchdog-soak-test.sh <video> [seconds]` | The design doc's full 10-minute false-positive soak (default 600s) — looped playback + a MIDI-rate burst every 60s, asserts zero watchdog triggers. Run before relying on recovery in prod, not on every change. |
| `scripts/check-launcher-staleness.sh [path]` | Is `~/.local/bin/cuemark` behind the code? Exit 0 fresh / 1 stale / 2 not built. No toolchain or running app needed. Run before diagnosing anything against a non-dev launch. |
| `scripts/scratch-capture.sh` + `scripts/scratch-envelope.py` | **Any audio symptom the in-pipeline probes call healthy.** Captures the PipeWire device monitor — downstream of everything — and reports a per-window envelope (`rms`, `hp200`, zero-crossing rate) with `[scratch-tel]` joined inline, separating **GATED / PITCHED / CLEAN**. `rms` is blind to frequency, so this sees the whole class of faults the pipeline's own instruments structurally cannot. Ended a four-session investigation in one pass. See the `audio-debugging` skill for the traps (the stub recorder, the wrong-node capture, UTC vs local). |
| `scripts/probes/shared_output_mixer_probe.py` | **Before changing the shared output graph** (`audio/mixer.rs`) — one `audiomixer` into one `pulsesink`, fed by live `appsrc` branches: does an idle pad stall the aggregator, does the 4-channel matrix chain negotiate, can a branch attach to a PLAYING mixer. Always run `--not-live` too: it is the control arm that proves the idle-pad check can fail, and it fails *hard* (zero buffers at the sink for as long as one branch is idle). Seconds, no app; stop cuemark first if using the real device. |
| `scripts/probes/shared_node_stream_diff.py` | **Why does the same two-sink topology gate on one device and not another?** Samples `pw-top` (xruns, quantum, rate, wait/busy) and `pw-dump` (negotiated format, node state) for cuemark's own streams during a jog gesture, joined by the private `cuemark.branch` key — both streams present as `NAME = cuemark` and pw-top alone cannot tell main from cue. `--compare A.json B.json` diffs a failing arm against a working one. Capture **both** arms the same way; the comparison is the whole value. Pre-flight refuses on an idle/suspended stream, which reports `ERR 0` forever and reads exactly like a healthy one. |
| `scripts/probes/offscreencanvas_webgl_capture_probe.py` | Can pixels be read back out of a WebGL canvas on this WebKitGTK? Run **before designing anything that moves rendered content between windows or processes**, and before trusting any pixel assertion against WebGL output. Seconds, no app, no Xvfb. |
| `scripts/probes/webgl_readback_variants_probe.py` | Route matrix for the same question — attachment formats, explicit `readBuffer`, PBO + `getBufferSubData`, `copyTexSubImage2D` — with a `LIBGL_ALWAYS_SOFTWARE=1` control arm that separates driver faults from WebKit faults. Run this before concluding anything about readback. |
| `scripts/probes/webgl_readpixels_diag_probe.py` | Why a readback failed: reports the returned bytes *and* the GL error, `getError()` sanity, framebuffer completeness, and the implementation's preferred read format. |
| `scripts/probes/imagebitmap_upload_probe.py` | `ImageBitmap`/`VideoFrame` upload semantics — does `createImageBitmap(VideoFrame)` carry real pixels, and which flip mechanism actually applies. Run before touching the output path's orientation handling. Needs `LIBGL_ALWAYS_SOFTWARE=1` for pixel verdicts. |
| `scripts/probes/pointer_events_probe.py` | Does this WebKitGTK deliver **Pointer Events** for real mouse input on a `<canvas>`? Pushes GDK button/motion events through the same platform→DOM path an X11 mouse takes, with a mouse-event control arm — API presence alone proves nothing here. Also answers **is `event.timeStamp` usable as an event-queueing delay** (`stale` arm: backdate one `GdkEvent.time` by 250ms, see whether the DOM stamp moves with it — it does, so the stamp is platform-derived, but its origin is offset from `performance.now()` by a per-page-load constant). Run before building any drag/pointer gesture or timing one. Seconds, no app, no media. |
| `scripts/probes/video_frame_signal_probe.py` | Which frame-change signal a legacy `<video>` element actually exposes here — `currentTime` (gates nothing), `requestVideoFrameCallback` (present, rate unmeasurable headlessly), `getVideoPlaybackQuality().totalVideoFrames` (tracks the source frame rate exactly). Run before writing any "has this video advanced a frame?" check. Seconds, needs a real media file. |
| `scripts/probes/output_window_compositor_probe.py` | End-to-end check of the **real** `output.html`: posts a synthetic frame from a same-origin sender and reads the composited result back, including an orientation assertion. Run after touching `outputBus.ts`, `output.ts`, `outputProtocol.ts` or `fbo.ts`. Needs the Vite dev server and `LIBGL_ALWAYS_SOFTWARE=1`. |

⚠️ **All GPU→CPU readback from WebGL is broken on this machine — it is a Mesa `crocus`
(Intel HD 4000, gen7) driver bug, not a WebKit one.** `createImageBitmap`, `drawImage(glCanvas)`,
`toDataURL` and *every* `readPixels` variant (default FB, complete `SAMPLES=0` user FBO, PBO,
after `copyTexSubImage2D`) return transparent or `INVALID_OPERATION` + a zeroed buffer, while
the canvas **displays** correctly. None of them throw. Under `LIBGL_ALWAYS_SOFTWARE=1` every
one of them passes — that A/B is how you attribute this, since WebKit masks `RENDERER`.
GPU→GPU is fine; only GPU→CPU fails.

What still works and is the basis of any fix: a plain 2D canvas captures fine;
`drawImage(VideoFrame)` onto a 2D canvas works (WebCodecs decodes in software, so frames are
already in system memory); and cross-process `ImageBitmap` transfer over `BroadcastChannel`
works. **The rule is: never read back from WebGL — ship frames that were never in GPU memory.**

Consequences: the output window cannot be fed composited snapshots at all — it runs the
compositor itself and receives per-deck frames instead (see "Rendering pipeline" and
`src/lib/renderer/outputProtocol.ts`) — and **automated screenshot/pixel checks of compositor
output silently verify nothing** on this machine. `LIBGL_ALWAYS_SOFTWARE=1` is not a usable workaround — it would put
the 1920x1080 shader compositor on llvmpipe. See `docs/upstream/webgl-canvas-readback-broken.md`
and Bug A in `docs/design/output-noise-and-track-reload-silence.md`.

## Constraints

- No hardcoded 2-deck limit — `Session.decks` is always an array
- Cross-platform: avoid platform-specific code outside Tauri's abstraction layer
- Wayland primary target; X11 fallback via GTK
- Open source goal — keep dependencies permissively licensed
- **Never use WebCodecs `VideoEncoder`** — `isConfigSupported()` or `configure()`
  SIGABRTs WebKitWebProcess on WebKitGTK 2.52.3 (100% reproducible; see
  `docs/upstream/videoencoder-crash.md`). Recording stays in Rust (`record.rs`).
  `VideoDecoder` is fine and is the basis of `docs/design/webcodecs-video-path.md`.
