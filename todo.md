# todo

Way to record a session

~~Bass / filter parameters should work.~~ **DONE 2026-08-17, live-verified** — 3-band EQ
(`equalizer-nbands`, 250 Hz / 1 kHz / 4 kHz) plus a sweep filter, and the Starlight's
dual-function tone knob mapped in both its modes. See `docs/design/deck-eq-and-filter.md`;
§8 maps each "feels wrong" complaint to the constant that fixes it.

What is necessary to build for mac or windows machines. Is that possible?

## Feature requests — prioritized

Carried over from a 2026-08-08 review pass. Ranked by rough value/effort; each "scope" note is
a starting point for whoever picks it up, not a committed design. Digger-side requests from the
same review live in `~/repos/digger/todo.md` instead — different repo, different (chronological)
todo format.

1. **[MEDIUM] Auto DJ toggle.** Replace the "Rnd"/"Next" buttons (reportedly unused in
   practice) with a single "Auto" toggle. This is really the existing unbuilt "Auto-advance
   option" from the play-queue section below (auto-load `GET /queue/next` when a deck's clip
   ends) exposed as a toggle instead of two buttons nobody uses. Scope: UI swap plus wiring
   actual auto-advance logic — medium.

2. **[EXPLORE] Other streaming destinations from within the app (OBS, direct RTMP, …).** The
   Snapcast target (docs/design/network-audio-output.md) is one destination; a gig stream
   usually wants OBS or a direct platform RTMP ingest. Zero-code floor that already works:
   OBS on the gig machine capturing cuemark's projector window (video) + the booth sink's
   PulseAudio monitor (audio) — fine for one-off streams. In-app options, if we build them,
   ranked by fit with what exists: **(a) SRT out** — `srtclientsink` off the existing shared
   output graph (audio first; video is the hard part, see below), consumed by OBS ≥28's
   Media Source (`srt://…`) or FFmpeg; SRT is the only common option that tolerates the
   one-way-NAT topology this network has (same reason Route A beat AirPlay; topology
   facts tracked privately). **(b) Direct RTMP** — `flvmux ! rtmpsink` with H.264/AAC encode, no OBS
   needed, but video encode in-app hits the same wall as (a)'s video. **(c) NDI** —
   obs-ndi consumes it, but the GStreamer NDI plugin needs NewTek's proprietary SDK;
   licensing headache for an open-source goal. The actual blocker for video in all three:
   GPU→CPU readback of the WebGL composite is broken on the crocus machine and the compositing
   window is a separate WebKitWebProcess (see CLAUDE.md rendering pipeline) — in-app video
   out would need either a capture path in the output window itself or
   `ximagesrc`/pipewiresrc window capture in GStreamer, each with real latency/frame-pace
   questions. Start with audio-only SRT as a proof, decide video after measuring.


**"Transition points for auto-DJ training" — deliberately not built here.** Digger's own
`mix_transitions` table already reserves `source='play_history'` for transitions *mined from* the
plays log server-side, and its router docstring explicitly scopes that mining job as "out of scope
for this router" (i.e., separate future work, not something a client asserts live). So the
scoped-here piece is exactly the substrate that job will need — accurate `plays` rows with real
start times and durations — not the mining itself. Follow-up, when wanted: a Digger-side batch job
over `plays` (context='cuemark', ordered by started_at) that inserts `mix_transitions` rows for
consecutive tracks. Not blocked on the Auto DJ toggle above, contrary to what this list previously
assumed — real transitions get logged whenever tracks are actually played back-to-back, autoloaded
or not.

## Beat grid + snap-to-beat + phase nudge — DONE (2026-07-05 through 2026-08-12)

The full handoff spec (fractional-BPM auto-fit, beat-grid rendering, sync path
correctness, SNAP quantization, onset-snapped SET BEAT, local + Digger grid
persistence, downbeat phase anchor, NUDGE) shipped across `4d05e56`, `a1190cf`,
`7dce2f2`, and the onset-snap work landed 2026-08-12. Implementation detail lives in
the code (`bpm.ts`, `seekBus.ts`, `phaseNudge.ts`, `gridSource.ts`, `onsetStore.ts`,
`grid_store.rs`) and in those commit messages; design rationale, known limitations,
and ongoing sync-quality work (Digger grid trust, phase-lock PLL, bar detection) live
in `docs/design/beatmatching.md`.

**Not yet eyeballed live**: the onset-snapped SET BEAT (2026-08-12, still uncommitted
in the working tree) — verify by loading a track, pressing SET BEAT slightly off a
kick, and confirming the ♩ indicator lands on the kick rather than the raw press time.

---


## Batch F — MIDI expansion

### MIDI output / LED control (Starlight)
- Add MIDI output port enumeration + connection in `midi.rs` (midir supports output)
- On startup: open Starlight output port; sending any Note On/Off typically hands LED control
  to software and stops the standalone light show
- Experiment to discover Starlight LED protocol: send Note On to output port; log which buttons
  light up at which note numbers
- Sync LEDs to app state: play button on → Note On `0x91/7`; loop on → Note On `0x91/5`; etc.
- Goal: static/off LEDs during performance so they don't distract

### MIDI learn mode
🟢 **Raw feed + monitor panel DONE 2026-08-17** — `midi-raw` events (gated on the panel
being open), Toolbar → MIDI, capture export. See `skills/midi/SKILL.md`.
- ⏸ Frontend: "MIDI Learn" mode button; clicking a mapped UI control → listens for next
  incoming `midi-raw` → saves `(status, d1) → action` mapping
- ⏸ Custom mappings override the default Hercules map at runtime; persist to a user profile

🛑 **Deliberately scheduled after the FLX4 profile exists**, not before — a learn UI built
now would encode today's single-controller assumptions into a persisted user-facing format
and then have to break it. Reasoning and phase order:
`docs/design/controller-mapping.md` §7.

### multi-controller support
**Designed 2026-08-17: `docs/design/controller-mapping.md`** — read it before starting.
Profiles become data files keyed by port-name match; bindings address *slots*, never deck
IDs; Rust decodes wire bytes to a normalized signal and TypeScript owns musical meaning.
Phase 1+2 there is the part worth doing before the DDJ-FLX4 arrives.
- Open all connected MIDI input ports (not just the first/named one), with a rescan poll —
  today a controller plugged in after launch is invisible until restart
- Per-port mapping: if port name matches a known profile, load it; else load custom
- UI: settings panel listing connected MIDI devices + their profiles (the monitor's port
  list is the read-only half of this already)

---

## Batch G — Polish / Phase 3

### output window configuration
- Settings: output resolution (720p / 1080p / custom), aspect ratio, frame rate target
- Display selection: enumerate displays via Tauri, open output window on specified display
  (currently user manually moves window to projector)
- Fullscreen-on-open option (skip manual `F` press)

### key detection
- Detect musical key from audio on load (FFT-based chroma analysis or call ffprobe)
- Display key in Camelot/Open Key notation in DeckCard
- Pitch-shift recommendation for harmonic mixing

### remote control
- WebSocket server: small axum handler in Rust backend (Tauri plugin or manual setup)
- Phone-friendly minimal web UI: play/pause, crossfader, cue jump per deck
- OSC input as alternative transport (some setups prefer OSC over MIDI)

### video capture / recording
- Record compositor output to file — **Rust + ffmpeg only**; WebCodecs `VideoEncoder` is
  forbidden here (instant `WebKitWebProcess` SIGABRT, see CLAUDE.md "Constraints" and
  `docs/upstream/videoencoder-crash.md`). `record.rs` is currently a stub (returns `Ok`,
  writes nothing) — see `docs/design/silent-failure-inventory.md`.
- Screenshot shortcut (capture current frame)



---

## Shader visuals 

The global visualization layer (moved off per-deck `DeckSource` onto a single
`Session.visualization` slot, and why) is documented in CLAUDE.md's "Visualization layer"
section — don't re-read that history here. Also done and not carried further here:
audio-reactive uniforms (`u_bass`/`u_mid`/`u_high` from a GStreamer `spectrum` element,
32 bands ~30fps) and the built-in shader library (Plasma, Tunnel, Particles, Feedback,
VU/scope) — see `src/lib/renderer/compositor.ts` and `src/App.svelte`'s shader picker.

### shader overlays on video
- Per-deck effect chain: array of shader passes applied after video texture upload
- Blend mode selection per overlay (additive, multiply, screen, etc.)




**Codebase maintainability refactor — mostly DONE 2026-08-13.** Both scoped halves
   shipped as pure moves; see the two commit messages for what moved where and how each was
   verified.
   - `src/App.svelte` 1828 → 914 lines. Six new modules: `lib/audio/transport.ts`,
     `lib/audio/positionPoll.ts`, `lib/video/legacyVideo.ts`, `lib/video/backendRegistry.ts`,
     `lib/state/bootRestore.ts`, `lib/debug/debugHook.ts`. Two consistency fixes fell out of
     deduplicating the three copies of "destroy a `<video>` element" (stale
     `lastPlaybackRate`/`playPromises` across a legacy↔webcodecs toggle) and one write-only
     map (`audioLoadedFor`) is gone.
   - `DeckAudioPipeline::load()` 819 → 466 lines: `build_main_branches()`,
     `build_cue_branch()`, `spawn_bus_watch()`, `attach_output_graph()`. `pipeline.rs` is
     still the largest file in either tree — the extraction was about that one function, not
     about splitting the file.
   - **Still open, deliberately deferred**: `spawn_scratch_feeder()` (352 lines) and
     `make_appsink()` (242). Both sit on the scratch/handoff hot path where the reasoning is
     about thread timing rather than structure, and this repo has no cheap way to prove a
     timing-neutral refactor of them — a live jog-gesture session is the only real test.
     Worth doing *while* someone is already testing scratch live, not on its own.
   - CLAUDE.md's length is *not* itself the problem — it's a symptom of the pipeline's
     accumulated subtlety, each footgun already captured in its own `docs/design/*.md` and
     cross-referenced, which is the right pattern.

(Resizable Digger Queue column shipped — `DiggerQueue.svelte`'s drag handle,
2026-08-11 — and dropped from this list. Default gain sync and session-history reporting
shipped 2026-08-12 — see "Digger sync: gain + play history" below.)



## Known issues

### Legacy `<video>` path renders colourful noise since GPU compositing became default [open, 2026-08-13]

🔴 **Any deck that lands on the legacy `<video>` backend shows colourful static instead of
video — in both the deck preview and the output window.** Audio, waveform and the position
clock are unaffected (separate GStreamer pipeline), so it reads as "video playback stopped"
while everything else looks healthy.

**This is the exact failure `src-tauri/src/main.rs`'s opening comment describes** — "DMA-BUF
surfaces from VA-API video decoding don't transfer to 2D canvas pixel reads in WebKitGTK —
`drawImage(video)` produces colorful noise" — and the same comment already flags the gap that
lets it happen now: the legacy fallback "has never been checked with the DMA-BUF renderer
enabled", which became the default on 2026-08-02 (`WEBKIT_DISABLE_DMABUF_RENDERER` retired).
`mele` has a full VA-API stack, so H.264 decodes through `vah264dec` into a DMA-BUF surface,
and both the preview and `outputBus.ts`'s scratch canvas `drawImage()` that same element.

**Status of the evidence**: the mechanism is inference from main.rs + the machine matrix in
`docs/environment.md`, corroborated by a live sighting on 2026-08-13 (deck-0 pinned to legacy,
`1280×720` badge showing — so metadata and a real video track — with noise in the preview).
It has **not** been measured. It cannot be reproduced headlessly: under Xvfb the legacy path
either needs `CUEMARK_DISABLE_DMABUF=1` for rAF to fire at all (which removes the very
condition under test), and a pixel check there wouldn't exercise VA-API anyway. **Reproduce on
a real display**: force a deck to legacy via the DeckCard badge, load an H.264 file, look at
the preview.

**Do not "fix" this by demoting VA-API H.264 globally without measuring first.** The obvious
patch — adding `vah264dec:0,vaapih264dec:0` to the `GST_PLUGIN_FEATURE_RANK` line in main.rs,
which is what that file prescribes for exactly this symptom — also forces software H.264
decode on the **default WebCodecs path**, since WebKitGTK's `VideoDecoder` is backed by the
same GStreamer registry. On a machine where VA-API works that is a real CPU regression on the
path 99% of playback actually uses, traded for a path that is only a fallback. Options worth
weighing before picking one:
- Scope the demotion to the legacy path only — needs a per-process or per-pipeline rank
  mechanism that may not exist; check before assuming.
- Leave ranks alone and accept the legacy path is display-broken here, i.e. treat it as
  audio-only fallback and say so in the UI (the badge already exists).
- Retire the legacy path outright via H.264 proxy transcode at ingest — already the
  alternative under consideration for the AV1 item below, and this makes the case stronger.

⚠️ **Related trap, fixed 2026-08-13**: `scripts/latency-test.sh` used to leave
`cuemark:videoPathOverride` set to `legacy` for deck-0 after every run. localStorage is keyed
by origin and every cuemark instance is `tauri://localhost`, so a *passing* test run silently
pinned the user's real app onto this broken path — and it read as a regression from the
then-current refactor, which was innocent. The script now saves/restores the override and
asserts it in Step 10; see `skills/verify-ui/SKILL.md` for the general rule about shared
localStorage.

### AV1 renders zero video frames on the legacy `<video>` path [open, 2026-08-05]

🔴 **The only genuinely open item here.** A live ~7-minute play of a real AV1 library file
(1920×1080, 6fps) showed `drew=0` on *every* preview tick — audio and cue worked fine, but
literally no video frame was ever presented, in either the deck preview or the output window.
The doc previously claimed this file class was "survivable at 26–54fps"; that assumed some
frames decode, and none do. Switching the same deck to a VP9 file drew frames normally moments
later in the same session, so this isn't a general preview-loop break.

AV1 also cannot join the WebCodecs path: `VideoDecoder.isConfigSupported` returns `true` here
and then decodes **zero** frames. ⚠️ Never gate on `isConfigSupported`; probe a real decode
(`scripts/probes/webcodecs_vp9_av1_probe.py`) — though note that probe is about `VideoDecoder`,
a *different* code path from the legacy `<video>` element's zero-frames finding above.

**The library already contains three AV1 files, two of them high-frame-rate** (1920×1080@29.97
and 1080×1080@25, not just the 6fps one everyone measured), so the "only slow files are
affected" framing was wrong. AV1 is what YouTube serves; Digger will keep delivering it.

Next: confirm whether the AV1 `<video>` element ever reaches `readyState >= 2`, then whether
WebKitGTK's internal playbin autoplugs the registered `aom: av1dec` for a `<video>` src
(`GST_DEBUG=avdec_av1:5,av1dec:5,playbin:3`). Retiring the legacy path outright — by
transcoding unsupported codecs to an H.264 video-only proxy at ingest, measured at ~1.0×
realtime for 1080p30 AV1 — is the alternative under consideration.

### `auCache` grows unbounded in the codec worker [latent, not a performance cause]

`codecWorker.ts:75`'s `Map<number, Au>` has no `delete`, no `clear` and no cap — it accumulates
every access unit for a whole playthrough, bounded only by the file's compressed video size.
Measured **not** to be a performance factor (RSS is flat across a full track and fps doesn't
track it), so it is hygiene, not a fix. Worth capping before a long set on large files.

### 10.8s of silence mid-track with the pipeline in PLAYING [open, no reproducer, 2026-08-05]

Deck-0's `output_queue` ran dry and no buffer reached the sink for 10.8s, with no state
transition, no seek, no scratch and no bus error — while rAF was healthy at 49.7fps, on the
H.264 webcodecs path. Headphone cue had been enabled 21s earlier; main and cue are two
`pulsesink`s on the same USB controller. Same symptom class as the 2026-08-02 `buffer-time` fix,
which was verified over 106s; this was the first multi-hour set since.

Also: `instrument_sink_flow()` does not gate on the `playing` atomic, so **six of its seven
"buffer flow resumed after a Ns gap" warnings that session were preroll artifacts** — fix that
first or any soak is unreadable. `docs/design/audio-dropout-mid-playback.md`.

### Control window drops to ~20fps while playing [fixed + verified live, 2026-08-04]

Root cause and fix are done: `DeckCard` was rewriting the deck's timestamp text 60×/s to
change a `m:ss` string that only changes once a second. `publishTime()`/`publishPhase()`
now gate that write on the rendered value actually changing. A/B confirmed **flat ~61fps**
where it used to run 21fps and slide to 13. The waveform canvas, the original prime
suspect, is exonerated — deleting its redraw entirely moved neither fps nor CPU.

One tuning item remains open: the φ (phase) readout still costs ~20ms of `WebKitWebProcess`
CPU per mutation and is rate-capped at 5Hz as a result; drawing it into a canvas instead of
a DOM span is the untried, likely-free fix. See `docs/design/control-window-frame-budget.md`
"Where to pick up" for the exact next step and the A/B harness (`VITE_PERF_SWEEP=1`).

### Scratch feeder starves the sink in vinyl mode [open, 2026-08-03]

A slow vinyl-mode jog on a paused deck produced 335 `output_queue underrun`s in 5.0
seconds (~67/sec — suspiciously exactly 1/15ms, the feeder's own chunk period) for the
whole duration of the gesture. Not main-thread latency: the frontend was healthy in that
window (scratch poll p50=39ms at ~25fps, idle timer fired 1ms late). First things to check
and how to reproduce: `docs/design/scratch-feeder-underruns.md`.



### OVR waveform stutter [mostly explained, one thread open, 2026-08-08]

Dragging a **paused** deck in OVR mode is *supposed* to sound choppy — `waveform-scrub.md`
already documents the overview's coarse pixel-to-time scale (~24x coarser than the zoomed view)
legitimately saturating the scratch servo's snap threshold, and snapping is deliberately silent.
Don't touch `SCRATCH_TARGET_SNAP_SECS` or `secondsPerPixel()` over this — it's working as
designed. What's still genuinely untested: dragging a **playing** deck in OVR goes through a
different, throttled silent-seek path (`seekBus.ts`, `SILENT_SCRUB_SEEK_MS`) that the design
doc itself flags as never live-verified — that's the more likely source of a real stutter.
Next step: a `scratch-capture.sh` run against that specific scenario before touching anything.

