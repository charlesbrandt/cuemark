# todo

## Known issues

### Frontend had no uncaught-exception/rejection logging [fixed, 2026-07-24]

Found while investigating a live UI freeze (2:44 into playback, dropped BPM 120.1 ->
112.8): the JS main thread stopped dead — rAF heartbeat log went silent forever —
while GStreamer's independent Rust audio pipeline kept playing, but `cuemark.log`
had zero trace of why. Root cause of the *silence*: no `window.onerror`/
`unhandledrejection` handler existed anywhere, and the rAF loop (`frame()` in
`App.svelte`) had no try/catch, so any uncaught throw there would kill the loop
forever with nothing logged (`console.error` doesn't reach the Rust-side log file;
only explicit `debugLog()` calls do).

Fixed: `main.ts` now installs global `window.onerror`/`unhandledrejection` handlers
that forward to `debugLog`; `frame()`'s body is wrapped in try/catch that logs via
`debugLog` and still reschedules the loop instead of dying silently.

**Root-caused, 2026-07-24**: caught live via `gdb -p <pid> thread apply all bt`
on the still-hung WebKitWebProcess from the actual incident (see "Ninth
mechanism" in `docs/design/pcm-buffer-playback.md`). It's a genuine **deadlock
inside WebKitGTK's own `MediaPlayerPrivateGStreamer`** — the main thread stuck
inside a synchronous `gst_element_send_event()` (a video seek) holding a
GStreamer element mutex, while one of WebKit's own GStreamer streaming threads
is parked on a `WTF::ParkingLot` condition variable waiting for that same main
thread's run loop to service a "new sample ready" signal. Not a cuemark/Rust
bug — nothing on the backend participates, which is why audio kept playing.
Trigger: `App.svelte`'s drift-correction `v.currentTime = contentPos` seek
(fires whenever audio/video drift exceeds 80ms) issued while the video
pipeline is mid-flight — this fires repeatedly for the whole time any deck
plays at a non-1.0 rate, not just during scratch. **Mitigated**: widened the
threshold to 250ms (`App.svelte`) to cut how often the seek fires.

**Second, distinct freeze found live-testing the mitigation, 2026-07-25** ("Tenth
mechanism" in the design doc): a near-end-of-track stall, not during a seek —
video's `readyState` sticks at 2 (`HAVE_CURRENT_DATA`) with the JS main thread
staying fully responsive (unlike the deadlock above). First hypothesis (a
`media_server.rs` cache-lookup race falling back to a stall-prone SMB path) was
built into a fix (`MediaCache::lookup_wait()`) but **live-disproven** — the
stall recurred with `buffered` already showing the entire file downloaded,
ruling out any network cause. `lookup_wait()` is kept as a real but unrelated
improvement. **Actual root cause** (per a user hypothesis, confirmed via a
1.0×-rate control test that played through cleanly every time vs. 2/3 stalls
at 0.87×): WebKitGTK's own internal video-only GStreamer pipeline runs at
`segment.rate = deck.playbackRate`, and its EOS/segment bookkeeping doesn't
land cleanly at non-1.0 rates — a bug inside WebKitGTK itself, same family as
the deadlock above, different manifestation. **Not yet mitigated.** Proposed
direction: reset the `<video>` element (not Rust audio) to `playbackRate=1.0`
as a deck nears its track's end while playing off-tempo. Open question: worth
the complexity given VJs typically mix out before natural track end anyway.

## Beat grid + snap-to-beat — handoff spec

Goal: snap to a shared grid of beats between two songs so beat matching is easy and
drift is handled by an occasional one-tap re-sync. Step 1 (the algorithmic core) is
done; steps 2–5 below are specced for implementation and are deliberately mechanical.

### Step 1 — Fractional BPM + automatic beat-grid fit [done, 2026-07-05]

What now exists (context for the remaining steps):

- `audio_analyze_file` returns `{ peaks: number[], envelope: number[] }`
  (`AnalysisData` in `analysis.rs`): 30/s display peaks + 210/s RMS envelope,
  computed in one decode pass. **`ENVELOPE_RATE = 210` is declared in both
  `analysis.rs` and `waveform.ts` and must stay in sync** (210 divides 44100
  exactly, so envelope index → time has no cumulative rounding drift).
- `detectBeatGrid(envelope, envelopeRate)` in `bpm.ts` returns
  `{ bpm, gridOffset, confidence } | null`:
  - `bpm` is **fractional** (rounded to 0.01) — the old integer quantization was
    the dominant drift source (128 vs true 127.6 = one beat of drift per ~2.5 min).
  - `gridOffset` is a **beat-level** anchor in `[0, 60/bpm)`: a beat lies at
    `gridOffset + k·(60/bpm)`. It is NOT bar-beat-1 — all current consumers
    (`getPhase`, phase nudge) work mod one beat, so bar identity doesn't matter.
  - Algorithm: log-domain onset detection with parabolic sub-sample timing →
    pairwise-IOI histogram with a 120-BPM log-normal prior (coarse integer
    candidate) → comb/Fourier scan `S(f) = Σ wⱼ·exp(2πi·f·tⱼ)` over ±3% around
    the candidate *and its in-range octaves* (|S| collapses at the half tempo,
    which both repairs octave mistakes and gates bad fits via
    `confidence = |S|/Σw ≥ 0.15`). Comb weights are **linear** envelope rises
    (kick ≫ hat) even though detection is logarithmic — see comments in `bpm.ts`.
  - Old integer `detectBpm(peaks)` retained as the fallback when the fit fails.
- On every track load, `App.svelte` auto-populates `deck.bpm` **and**
  `deck.downbeat` from the fit (this also clears a stale downbeat carried over
  from the previous track). SET BEAT remains a manual override.
- Tests: `npm test` → `src/lib/audio/bpm.test.ts` (synthetic click envelopes with
  fractional ground truth; tolerances ±0.05 BPM / ±20 ms phase — keep them tight,
  "plausible but 0.2% off" is the exact failure mode this feature exists to kill).
  Rust smoke test: `cd src-tauri && cargo test analysis_rates`.

### Step 2 — Beat grid rendering in WaveformCanvas [done]

- `drawZoom()` calls `drawBeatGrid()` when `deck.bpm !== null && deck.downbeat !== null`
  (falls back to 1-second ticks otherwise); every 4th beat is brighter/taller.
  Overview mode intentionally has no grid (too dense).
- Both decks' zoom views pin the playhead at the same 25% x-position
  (`ZOOM_LEAD_RATIO`), so beat matching = lining up verticals across the two waveforms.
- Lines are batched into two `beginPath()` passes (normal, accented) per the perf note.

### Step 3 — Sync path correctness fixes [done, 2026-07-05]

1. **Rate-then-seek ordering** (violates the documented CLAUDE.md rule; can make
   Sync silently not take): `handler.ts` `sync_toggle` and DeckCard's Sync button
   both set `playbackRate` and then seek (near-)immediately. **Correction to an
   earlier draft of this spec, which had the fix backwards**: CLAUDE.md's
   "Rate-then-seek ordering" section is explicit — apply the rate change FIRST,
   wait ~200ms for the WebKit pipeline rebuild to settle, THEN seek. Seek-first
   does not avoid the race: `v.playbackRate` writes are rAF-throttled (deferred
   to `syncVideoElements` on the next frame), so even if a seek's `el.currentTime`
   write happens first in source order, the rate write's WebKit rebuild can still
   land shortly after and clobber the seek before the video element's own internal
   seek has settled — which is exactly today's bug. Fix: after setting
   `playbackRate`, `setTimeout(..., 200)` before performing the phase-align seek
   (both in `sync_toggle` and in the DeckCard Sync button's call into
   `nudgePhaseToMaster`). No existing code has this exact pattern to mirror —
   it's a new `setTimeout`, same idea as other debounce timers already in the
   codebase (e.g. `DiggerQueue.svelte`'s search debounce).
2. **`phaseNudge.ts` `applyRate()` must call `syncRate()`** (from `audioSync.ts`)
   instead of `audioSetRate()` directly — currently the rateMap goes stale and the
   `App.svelte` `$effect` fires a duplicate `audio_set_rate` IPC per nudge edge.
3. **Unify `sync_toggle`'s inline phase-align block with `nudgePhaseToMaster`** —
   `handler.ts` duplicates the shortest-arc logic and hard-seeks even while
   playing (audible jump); the UI path rate-spikes. Call `nudgePhaseToMaster`
   from the MIDI path (mind fix #1's ordering).
4. Optional, verify live: make nudges **audio-only** — don't write
   `deck.playbackRate` (and thus `v.playbackRate`) for the ±15% spike; let the
   existing 80 ms audio-clock snap pull the video back after. Avoids two WebKit
   pipeline rebuilds per nudge. Run `scripts/latency-test.sh` after touching this.

### Step 4 — Quantize / snap-to-beat [done, 2026-07-05]

- `Session.snapToBeat: boolean` (default false) + setter in `session.ts` + a
  "SNAP" toolbar toggle in `App.svelte`.
- Helper (suggested: `seekBus.ts`): `quantizeToGrid(deckId, t): number` — returns
  `max(0, downbeat + round((t − downbeat) / T) · T)` when snap is on and the deck
  has bpm+downbeat; otherwise returns `t` unchanged.
- Apply at the CALLERS, not inside `seekDeck()` (the nudge code needs raw seeks):
  waveform click-to-seek, hot-cue jump + hot-cue set (both DeckCard and
  `handler.ts`), loop IN/OUT stamping. Snapping loop points to beats is what makes
  the bar-length loop buttons land exactly on musical boundaries.
- Optional: snap SET BEAT to the nearest detected onset (needs keeping the onset
  list from analysis around) — fixes ~50–100 ms human button latency. Do NOT snap
  SET BEAT to the existing grid (that would make it unable to correct the grid).

### Step 5 — Grid persistence

#### Step 5a — Local JSON sidecar [done, 2026-07-05]

Implemented via `grid_store.rs` + `gridSource.ts` — see commit message for details.

#### Step 5b — Digger round-trip [done, 2026-07-05]

`GET /tracks/{id}/cuemark` now returns `bpm`/`downbeat` (downbeat via a new
`"downbeat"` marker type — no schema migration). `Deck.diggerTrackId` tracks which
Digger track is loaded; SET BEAT pushes corrections back (best-effort). See commit
messages in both repos for details, including the `gridSource.ts` path-keying fix
this required (a deck-id-only trust flag would misfire across track reloads).

All of Step 5 (grid persistence) is now done — this closes out the full beat-grid /
snap-to-beat feature (Steps 1-5).


- Digger side (`~/repos/digger`, see `digger-integration` skill): add `bpm`
  (float) and `downbeat` (float seconds) to the `GET /tracks/{id}/cuemark`
  response and the planned `POST /tracks/{id}/markers` write-back. Requires
  cuemark to remember which Digger track id is on each deck (also needed by the
  existing "Push markers to Digger" todo below).
- Local fallback for non-Digger loads: JSON sidecar in the app data dir
  (e.g. `~/.local/share/com.cuemark.app/grids.json`) keyed by absolute file path
  → `{ bpm, downbeat }`. Load before analysis completes; save on SET BEAT /
  manual bpm change.
- Precedence on track load: saved grid > auto-fit > integer fallback.

### Known limitations (by design — don't "fix" these)

- Constant-tempo model: one bpm + one offset per track. Right for electronic /
  dance material; live-drummer recordings will drift regardless — the NUDGE
  workflow is the answer there, not a variable beat map.
- Beat-level anchor, not bar-level. Phrase-aligned mixing would need bar
  detection or a SET BEAT convention; nothing currently consumes bar identity.
- Tempo prior centered at 120 BPM (σ 0.4 log) resolves octave ties toward
  danceable tempo; genuinely ambiguous material (sparse 64 BPM downtempo) may
  come back as 128 — harmless for sync if both decks get consistent treatment.

## Beat phase tracking + phase nudge

### Step 1 — Downbeat anchor in the data model [done]
- Add `downbeat: number | null` to `Deck` in `src/lib/state/types.ts`
- Initialize to `null` in `addDeck()` in `session.ts`
- Add a "SET BEAT" button to `DeckCard.svelte` transport row: on click, stamps
  `getDeckTime(deckId)` into `deck.downbeat` via `updateDeck()`
- Display a small indicator (e.g. "♩ 0.0s") showing the stamped downbeat time when set;
  right-click or ✕ clears it

### Step 2 — Phase computation [done]
- Add `getPhase(deckId: string): number | null` to `seekBus.ts`:
  - Reads `getDeckTime(deckId)` + `deck.downbeat` + `deck.bpm` from session store
  - Returns `null` if any are null
  - Returns `((currentTime - downbeat) / beatPeriod) % 1.0`, clamped to [0, 1)
- Add a phase readout to `DeckCard.svelte` (small arc or numeric 0.00–1.00) so the user
  can see phase live and verify the downbeat is set correctly

### Step 3 — Phase nudge action [done]
- Add `nudgePhaseToMaster(deckId: string)` in a new `src/lib/audio/phaseNudge.ts`:
  - Reads `getPhase(deckId)` and `getPhase(masterDeckId)` (master = whichever deck is
    set as the reference, or the session master BPM anchor)
  - Computes `phaseDelta` (shortest arc, −0.5 to +0.5)
  - If `|phaseDelta| < 0.02` (within ~1% of a beat), no-op
  - Otherwise: apply `rate × 1.15` (advance) or `rate × 0.85` (retard) for
    `|phaseDelta| × beatPeriod` seconds, then restore original rate
  - Revert is scheduled in the RAF loop (track `nudgeEndTime`), not setTimeout —
    setTimeout jitter at ~16ms is too coarse relative to a 500ms beat
- Wire to MIDI: map an unmapped button (e.g. `(0x91/92, 5)` Vinyl/Scratch if Sync is
  not in use, or a new binding) → `PhaseNudge` action in `midi.rs` + `handler.ts`
- Wire to UI: a "NUDGE" button per deck in `DeckCard.svelte`, disabled when
  `downbeat` or `bpm` is null

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

### shader deck source [superseded, 2026-06-21 — see "global visualization layer" below]
- Originally `DeckSource` had `{ type: 'shader'; fragmentSrc: string; uniforms: ... }` and DeckCard
  exposed Plasma/Tunnel buttons that replaced a deck's source. Problem: selecting a visualization
  on a deck made `syncVideoElements()` treat it as "no video source" and call `audioUnload()`,
  stopping the music. Removed entirely — decks are video-only now (`DeckSource` is
  `{ type: 'video'; ... } | null`).

### global visualization layer [done]
- Visualization moved off `Deck`/`DeckSource` entirely onto `Session.visualization` (single slot:
  `{ fragmentSrc, uniforms, name } | null`) + `Session.visualizationOpacity` (default `0.5`)
- `Compositor` gained a dedicated `vizFbo`/`vizProgram` (outside the per-deck maps — only one
  visualization is ever active) and `renderVisualization()`, mirroring `renderShader()`
- `composite(decks, visualizationOpacity)` blends all deck FBOs back-to-front as before, then
  blits the visualization FBO on top as a final pass if `visualizationOpacity > 0`
- New `VisualizationPanel.svelte` (shader picker + opacity slider), toggled from a toolbar button
  in `App.svelte`; `DeckCard.svelte`'s shader buttons removed
- Result: picking a visualization never touches deck/audio state — it's a pure compositor overlay
- `Compositor.renderVisualization()`: compiles + caches a single GLSL program (no per-deck map
  needed — only one visualization is ever active), renders fullscreen quad into `vizFbo` each RAF frame
- Uniforms: `u_time`, `u_resolution`, `u_bass`, `u_mid`, `u_high`; `a_pos` bound at location 0 so all programs share the same quadVAO

### audio-reactive shader uniforms [done]
- GStreamer `spectrum` element (32 bands, ~30 fps) inserted after `pitch` in each deck pipeline
- Bus thread parses spectrum messages and emits `audio-fft` Tauri events; frontend combines
  max-across-decks into `{ bass, mid, high }` and passes to `compositor.renderVisualization()`
- All three bands wired as `u_bass`, `u_mid`, `u_high` uniforms — confirmed responding to music
- Bug fixed: spectrum magnitude is `GstValueList` (`gst::List`), not `GstValueArray` (`gst::Array`);
  the mismatch silently dropped every message before this was corrected
- `ShaderAnalyzer` (Web Audio API fallback, `src/lib/audio/shaderAnalyzer.ts`) written but not
  connected — kept as dead code for now; GStreamer path is authoritative
- Band weights / sensitivity tuning deferred — current linear dBFS mapping is functional

### built-in shader library [done]
- Plasma / color wash [done]
- Tunnel / radial zoom [done]
- Particle field [done] — 80 star-like glows, hue-shifted by seed, speed/size driven by bass+high
- Feedback / echo trail [done] — 10 zoom+rotate layers with exponential decay; no ping-pong buffers needed
- VU bar / waveform scope [done] — 24-band spectrum bars (bottom 55%, green→yellow→red) + oscilloscope trace (top 45%)

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
- `src/lib/state/history.ts`: running log derived by subscribing to the `session` store
  (deck id, title, artist, file path, load timestamp, accumulated played-ms) rather than
  instrumenting every play/pause call site — there are several (DeckCard's transport
  button, App.svelte's EOS handler, the MIDI handler, `video.onended`, sync_toggle) and a
  low-frequency store subscription is the right tool for a discrete-action log like this
  (unlike the continuous MIDI controls that must bypass the store — see
  `docs/design/av-sync-architecture.md`).
- `src/components/HistoryPanel.svelte`: scrollable panel (toolbar "History" toggle,
  same sidebar slot pattern as the Queue panel), ticks the currently-playing entry's
  duration once per second.
- "Re-add to queue" action per entry — calls `addToQueue(diggerTrackId)`; disabled for
  entries with no Digger track id (locally-loaded files).
- "Push markers to Digger" — cue point (SET button) and hot cues (DeckCard) now call
  `pushMarker(diggerTrackId, positionMs, 'cue' | 'hot_cue')` on set, same best-effort
  fire-and-forget pattern already used for SET BEAT's downbeat/bpm push. Title/artist for
  history entries come from `setPendingTrackMeta()`, called by `DiggerQueue.svelte`'s
  `loadToDeck()` right before `updateDeck()` sets the new source (Deck itself has no
  title/artist fields); local-file loads fall back to the filename.
- **Fixed a latent bug found while wiring this up**: `DeckCard.svelte`'s `loadVideo()`
  never reset `diggerTrackId` to `null` when loading a local file over a deck that
  previously held a Digger track — every marker push (including the pre-existing SET
  BEAT one) would have silently written to the stale track id. Now cleared alongside
  `source` in the same `updateDeck()` call.

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
- Record compositor output to file via WebCodecs API (`VideoEncoder`) or Rust + ffmpeg
- Screenshot shortcut (capture current frame)
