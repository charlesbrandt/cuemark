# todo

### Jog wheel reverse doesn't play video in reverse [confirmed open, 2026-08-08]

Real gap, not a quick patch. `codecPlayer.ts`'s frame ring only covers ~0.7–1.28s of reverse
travel; beyond that `getFrameForTime()` freezes on the oldest cached frame instead of
continuing to scrub backward. This is exactly the unbuilt "tier 2" (keyframe-quantized reverse
seek) already called out in `docs/design/codec-frame-cache.md` — treat it as a real feature to
scope, not a bugfix.

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
2. **[LOW] Default gain synced from Digger.** Store a per-track default gain in Digger, apply
   it on load (reset to default unless Digger supplies one), mirroring the existing
   bpm/downbeat pull-on-load pattern. Cross-repo: needs a Digger schema field +
   `GET /tracks/{id}/cuemark` addition, plus applying it in cuemark's load path. Medium, two
   repos.
3. **[LOW] Auto-save session history to Digger as "Sessions"**, with transition points
   recorded for future auto-DJ training. `history.ts` already tracks this locally; needs a new
   Digger endpoint (e.g. `POST /sessions`) plus a push call analogous to the existing
   `pushMarker` fire-and-forget pattern. Medium-large, two repos — and probably wants #1 done
   first, since "transition points" only means something once auto-advance exists.
4. **Codebase review/refactor for maintainability.** Real concern, but not a scoped task as
   written — needs its own short audit (likely candidates: `App.svelte`'s size, the audio
   pipeline's accumulated complexity reflected in how much of CLAUDE.md it now occupies)
   before it's actionable. Flagging rather than scoping blind.

(Resizable Digger Queue column shipped — `DiggerQueue.svelte`'s drag handle,
2026-08-11 — and dropped from this list.)

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

## Batch C — Audio routing [done]

### EQ per deck [done]
- Three biquad filter nodes per deck: lowShelf(250Hz) → midPeak(1kHz,Q=1) → highShelf(4kHz)
- `DeckEQ { low, mid, high }` in Deck type; ±12 dB sliders + reset in DeckCard
- `AudioAnalyzer.setDeckEQ(deckId, low, mid, high)`; synced via `$effect`
- MIDI: Bass/Filter toggle `(0x90, 1)` still unmapped — would need dedicated EQ knob CCs

### audio output device selection [done]
- `src/lib/audio/devices.ts`: `listAudioOutputs()`, `sinkIdSupported()`
- `AudioAnalyzer.setOutputDevice(deviceId)` via `setSinkId()`
- "Audio" toolbar button toggles settings bar; graceful fallback if setSinkId unsupported
- `src/lib/audio/audioSettings.ts`: module-level stores for device IDs and cue gain

### crossfader curve selection [done]
- Three curves per target (visual / audio independently): linear, equal-power (cos/sin), cut
- Equal-power default for audio so volume stays constant across sweep; linear default for visual
- Gain clamp extended to 4.0 (~+12 dB) for quiet track boosting

### headphone cue / pre-listen [done]
- Second `AudioContext` (cue ctx) on headphone device via `setSinkId()`
- Bridge: `highShelf → MediaStreamDest` (main ctx) → `MediaStreamSource` (cue ctx)
- `setCueDeck(deckId, enabled)`, `setCueOutputDevice(deviceId)`, `setCueVolume(v)`
- CUE button per deck in transport row; cue gain slider in Audio settings bar
- MIDI: `(0x91/0x92, 12)` → `HeadphoneCue` action → toggles `deck.cueEnabled`
- Split-cue mode (left=cue, right=main) not yet implemented

---

## Batch D — Shader visuals (Phase 2)

The global visualization layer (moved off per-deck `DeckSource` onto a single
`Session.visualization` slot, and why) is documented in CLAUDE.md's "Visualization layer"
section — don't re-read that history here. Also done and not carried further here:
audio-reactive uniforms (`u_bass`/`u_mid`/`u_high` from a GStreamer `spectrum` element,
32 bands ~30fps) and the built-in shader library (Plasma, Tunnel, Particles, Feedback,
VU/scope) — see `src/lib/renderer/compositor.ts` and `src/App.svelte`'s shader picker.

### shader overlays on video
- Per-deck effect chain: array of shader passes applied after video texture upload
- Blend mode selection per overlay (additive, multiply, screen, etc.)

---

## Batch E — Queue, history, and Digger integration

Media library management lives in `~/repos/digger` (FastAPI + SQLite, `http://localhost:8000`).
Cuemark does not embed a file browser — Digger feeds cuemark.

### play queue
- Sidebar panel: ordered list of upcoming tracks [done] — shown by default now
  (`showDiggerQueue` defaults `true`; window widened 1280→1600 to compensate)
- Items can be added from: Digger `GET /queue/next` suggestion, Digger search results, or
  OS drag-and-drop into the queue (not into a deck directly)
- Load to deck: clicking an item calls `GET /tracks/{id}/cuemark` → loads filePath +
  cuePoint + hotCues[] onto the target deck
- Live updates when the queue changes from Digger's own UI [done, 2026-06-22] — added
  `GET /queue/ws` to Digger (`api.py`); cuemark's `DiggerQueue.svelte` subscribes via
  `subscribeQueueChanges()` instead of polling; see CLAUDE.md "Integration: Digger"
- Drag-to-reorder; remove items from queue
- Auto-advance option: when a deck's clip ends, auto-load next queue item to that deck

### session playback history [done, 2026-07-26]
`src/lib/state/history.ts` (derived from the `session` store, not instrumented call
sites) + `src/components/HistoryPanel.svelte` (toolbar toggle, same sidebar slot as
Queue) + Digger marker pushes on cue/hot-cue set. Rationale and the fixed
`diggerTrackId`-not-cleared bug it uncovered: commit `5bc537d`.

### Digger connection
- Quick search widget in toolbar: text input → `GET /search?q=` → mini dropdown of results →
  click to add to queue
- Settings: configurable Digger base URL (default `http://localhost:8000`)
- Graceful degradation: if Digger is unreachable, show a notice; drag-and-drop and
  manual load still work unaffected

### evaluate: stream media through Digger directly (vs. local mount)
- Right now cuemark requires the file to already be locally readable (mount, e.g. the
  `t7` CIFS share — see journal.md 2026-06-19 entry) since GStreamer/WebKit read straight
  from the filesystem path Digger returns; Digger itself never serves the media bytes
  — see `CLAUDE.md`'s boundary rule "Cuemark calls Digger; Digger never calls cuemark"
- Open question: should Digger proxy/stream media content itself (e.g. an
  `GET /tracks/{id}/stream` endpoint) so cuemark doesn't need direct filesystem/CIFS
  access to the library at all?
- Concern: this adds a network round-trip per frame/seek on top of the home-network CIFS
  mount cuemark already depends on — likely too fragile away from home network (the
  exact scenario CIFS already struggles with), so may not be worth the implementation
  cost vs. just keeping the mount-based approach
- Alternative worth evaluating instead/alongside: a "Pack Crate" feature — explicitly
  select a set of upcoming tracks (e.g. a planned setlist) and download+cache them
  locally ahead of a gig, so cuemark doesn't need any network/mount access during a
  performance away from home
  - Needs to track which tracks were *also* loaded ad-hoc while offline/away from home
    (e.g. dragged in directly, not from a Pack), so they can be reconciled back into
    Digger's library/markers once back on the home network
- Not started — no code yet; flagged here for a future build/no-build decision

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
- Rust: always emit raw `midi-raw` events alongside mapped `midi-action` events
- Frontend: "MIDI Learn" mode button; clicking a mapped UI control → listens for next
  incoming `midi-raw` → saves `(status, d1) → action` mapping
- Custom mappings override the default Hercules map at runtime; persist to `~/.config/cuemark/midi-map.json`

### multi-controller support
- Open all connected MIDI input ports (not just the first/named one)
- Per-port mapping: if port name matches known controller, load that map; else load custom map
- UI: settings panel listing connected MIDI devices + their mapping files

---

## Batch G — Polish / Phase 3

### output window configuration
- Settings: output resolution (720p / 1080p / custom), aspect ratio, frame rate target
- Display selection: enumerate displays via Tauri, open output window on specified display
  (currently user manually moves window to projector)
- Fullscreen-on-open option (skip manual `F` press)

### project save / load
- Serialize session to JSON: deck sources, cue points, hot cues, BPMs, crossfader mapping
- Load: restore state, re-open video sources from stored paths
- Auto-save on exit; manual save/load via file picker

### pitch lock
- Preserve audio pitch when `playbackRate ≠ 1.0` (avoids chipmunk / slow-motion pitch shift)
- `video.preservesPitch = true` (already the browser default; verify in WebKitGTK)
- For extreme rates, AudioWorklet pitch correction may be needed

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







## Known issues

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

