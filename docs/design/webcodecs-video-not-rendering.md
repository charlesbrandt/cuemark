# Video not rendering on the webcodecs path (deck shows no picture, audio fine)

Status: **FIXED and confirmed 2026-08-02** — user re-tested live after all three fixes
below and confirmed both audio and video play correctly for the original repro file (see
"Bug 3", the one that actually explained the symptom). Captured 2026-08-02 during the
live test of the
`pipewiresink` → `pulsesink` audio fix (`docs/design/pipewiresink-play-hang.md`). Audio
was confirmed working by the user in that same session; video never appeared. Written up
for a fresh session rather than investigated inline, per user request.

**Note on this doc's history:** the first pass (bugs 1 and 2 below) was marked "FIXED"
without a live re-test — both were real bugs worth fixing, but neither actually explained
the black screen. A live retest still showed no video; adding `debugLog()` instrumentation
into `codecWorker.ts`'s error path (previously `console.error`-only, invisible outside
WebKit devtools) surfaced the real cause within one more play attempt. Lesson: "compiles
and the specific mechanism I hypothesized is now correct" is not the same bar as "the
reported symptom is gone" — don't mark a live-repro bug FIXED without re-observing the
actual repro.

## Root cause and fix

The primary lead was correct on the symptom (`video_demux` really did return 0×0) but
wrong on the mechanism — `coded_width`/`coded_height` are never actually passed to
`VideoDecoder.configure()` anywhere in the real playback path (`codecWorker.ts`'s
`handleInit`/`handleSeek`/`maybeStartLoopPrefetch` all call `configure({ codec,
description })`, no dimensions; `DemuxInfo.codedWidth/codedHeight` are wired only into the
unrelated `probeWebCodecs` debug hook in `App.svelte`). So 0×0 dims alone don't explain a
black deck — but they were still a real, separate bug, and pointed at the actual one.

**Bug 1 — `video_demux.rs`'s 0×0 dims.** `demux_file`'s `parsebin::pad-added` callback
read `width`/`height`/`framerate` off `pad.current_caps()` (falling back to
`pad.query_caps(None)`) at the instant the pad was created — before any buffer had
flowed and before the pipeline even reached `PLAYING`. For this file, that pad only had
template (unfixed) caps at that point, so `.get::<i32>("width")` failed and
`.unwrap_or(0)` silently produced 0. **Fix:** read dimensions from the actual
`gst::Sample::caps()` of the first pulled buffer in the AU loop instead (guaranteed
negotiated by then), and hard-`Err` if they're still 0 after the loop rather than
returning a bogus `DemuxResult`. Added a GStreamer-backed regression test
(`video_demux::tests::demux_file_recovers_real_dimensions`, synthesizes an mp4 with
`videotestsrc ! x264enc ! mp4mux`) and manually re-ran `demux_file` against the exact
field-repro file — now returns `1280x720` (previously `0x0`).

**Bug 2 — a genuinely silent failure sink, but not this symptom's mechanism:**
`configure()` calls in `codecWorker.ts` weren't wrapped in `try/catch`.
`handleInit`/`handleSeek`/`maybeStartLoopPrefetch` are `async` functions invoked
fire-and-forget from `self.onmessage` — a synchronous throw from `decoder.configure()`
would become an unhandled rejection inside the Worker with no `self.onerror` registered,
never reaching `codecPlayer.ts`'s `error` message handling. **Fix:** added a
`configureDecoder()` wrapper used at all three call sites that catches the throw and
`post()`s an `{ type: "error" }` message, plus a one-shot warning from `pump()` if it's
ever invoked while `decoder` exists but isn't `"configured"`, plus a
`self.addEventListener("unhandledrejection", …)` catch-all in the worker for whatever the
*next* uncaught throw turns out to be. None of this actually fired live — `configure()`
was succeeding fine — but it closed a real gap and, critically, the same instrumentation
pass is what surfaced Bug 3 below (see the `console.error`-only visibility problem in the
history note above).

**Bug 3 — the actual black-screen mechanism: some access units carry no slice NAL at
all, and `decoder.decode()` on an empty chunk closes the decoder.** Live retest (after
fixes 1+2, with `debugLog()` added to `codecWorker.ts`'s error path so it would reach
`cuemark.log` instead of only the WebKit devtools console) immediately showed:
```
[codecPlayer:deck-0] worker error: EncodingError: Empty frame
...
[codecPlayer:deck-0] worker error: pump(): decoder.state=closed, not feeding
```
Dumping the real repro file's first few AUs' NAL types (temporary `#[test]` in
`video_demux.rs`, since removed) showed:
```
au[0] key=true  len=79521 nal_types=[9, 7, 8, 5]   ← AUD, SPS, PPS, IDR slice — normal
au[1] key=false len=51    nal_types=[9, 6]         ← AUD, SEI — NO slice NAL at all
au[2] key=false len=35545 nal_types=[9, 1]          ← normal
```
`h264.ts`'s `annexBToAvc()` filters to only slice NALs (type 1/5, per the AVC re-mux
spec) — for AU 1 that filter matches nothing, producing a zero-length chunk. Handing
`VideoDecoder.decode()` an empty `EncodedVideoChunk` throws `EncodingError: Empty frame`,
and per the WebCodecs spec that transitions the decoder to `"closed"` — permanently
killing the deck, silently, since (pre-Bug-2-fix) nothing surfaced the error and
(post-Bug-2-fix) `pump()`'s state guard now stops feeding a closed decoder without
knowing why it closed. This demux stream apparently emits some access units that carry
only non-VCL NALs (AUD+SEI) with the actual picture data in an adjacent AU — not itself a
bug in the demux (each buffer genuinely is a distinct GStreamer AU), just not something
the WebCodecs-facing layer accounted for. **Fix:** in `codecWorker.ts`'s `pump()` and
`feedLoopFrames()`, compute `annexBToAvc(au.data)` first and skip the `decoder.decode()`
call (advancing past the AU exactly as normal) when it comes back empty, instead of
handing the decoder a chunk with nothing in it.

Confirmed fixed by the user via live retest (2026-08-02): audio and video both play
correctly on the webcodecs path for the original repro file, no dev-server restart
needed (pure `codecWorker.ts` change — Vite hot-reloads it; reloading the track spun up
a fresh Worker with the fix already applied).

## Lessons for next time (all three bugs)

- **A "plausible mechanism" fix is not a confirmed fix for a live-repro bug.** Bugs 1+2
  were both real, both compiled clean, and bug 1 exactly matched the symptom the doc's
  own primary lead predicted (0×0 dims) — every signal said "done" except the one that
  matters: the user re-running the actual repro. It still showed a black screen. Don't
  change a live-repro doc's status to FIXED (or say so to the user) until they've
  re-observed the original symptom gone, not just until your hypothesis compiles.
- **`console.error` inside a Tauri app's Worker is not visible to an agent working from
  the CLI** — there's no attached devtools session on this launch path. Any error path
  that might need debugging later should also call `debugLog()` (Tauri IPC → the Rust
  log file) alongside or instead of `console.error`, *before* you need it, not only after
  a first live-test attempt comes back silently negative. This is what actually unblocked
  bug 3 here — the `EncodingError: Empty frame` had presumably been thrown on every play
  attempt, but nothing had ever surfaced it anywhere Claude could read.
- **A caught/logged error is still worth chasing to its root cause, not just its
  symptom.** Bug 2's fix (catch `configure()` throws) would have made bug 3 *visible*
  even without further work, but the deck would still have stayed black. Silencing the
  silence is progress, not a fix — the goal is the reported symptom gone, confirmed live.
- **When a demuxer hands you "one buffer = one access unit," don't assume every AU has
  a decodable picture in it.** This file's H.264 stream had at least one AU (immediately
  after the opening keyframe) consisting only of an Access Unit Delimiter + SEI message,
  no VCL/slice NAL — a legal AU that carries no picture. Any AU-to-EncodedVideoChunk
  translation layer needs to treat "this AU re-muxes to zero picture bytes" as a normal,
  skippable case, not funnel it into `decoder.decode()` and let the spec's "empty chunk"
  error tear down the whole decoder.

## Symptom

Load a track, press play: **audio plays correctly, the deck's video preview stays black.**
No crash, no frontend exception, no visible error in the UI.

Reproduced on: 2026 MacBookPro10,1 / Ubuntu 26.04 / WebKitGTK 2.52.3, `cargo tauri dev`
build at 2026-08-02 14:32. Deck is on the **webcodecs** video path, which is the default
since commit `f6b94ea` ("Flip webcodecs-video-path default", phase 5).

Test file (came from Digger's remote-cache fallback — the NAS was unmounted):
`.../media_cache/219000972d411d6b-80498295.mp4`, H.264 High 3.1, 1280×720, 25fps.

## Primary lead: `video_demux` reports 0×0 @ 0.00 fps

From `cuemark.log`:

```
[video_demux] /home/account/.local/share/com.cuemark.app/media_cache/219000972d411d6b-80498295.mp4:
    codec=avc1.64001f 0x0@0.00 au_count=7512 keyframes=301
```

That format string is `{coded_width}x{coded_height}@{fps_hint:.2}` (`video_demux.rs:333`),
so the demuxer returned **`coded_width=0`, `coded_height=0`, `fps_hint=0.0`** — while AU
parsing plainly succeeded (7512 access units, 301 keyframes, correct codec string
`avc1.64001f`).

The dimensions are definitely present in the file. GStreamer's own caps, logged seconds
later in the same run, read them fine:

```
video/x-h264, ... level=(string)3.1, profile=(string)high,
  width=(int)1280, height=(int)720, framerate=(fraction)25/1, ...
```

So this is a `video_demux.rs` extraction bug, not a bad file. A `VideoDecoder.configure()`
call with `codedWidth: 0, codedHeight: 0` is invalid per spec and will throw or leave the
decoder unconfigured — which would produce exactly this symptom (silent black deck).

**Start here.** Find where `coded_width`/`coded_height`/`fps_hint` are populated in
`video_demux.rs` and why they come back zero for this file while `au_count`/`keyframes`
do not.

## Secondary lead: new decoder-state guards in `codecWorker.ts` silently `break`

`src/lib/video/codecWorker.ts` has **uncommitted** changes (this session's working tree)
adding a state re-check before each `decode()` call, in both `pump()` and
`feedLoopFrames()`:

```ts
if (!decoder || decoder.state !== "configured") break;
```

These were added to fix a real race (a concurrent seek/loop-wrap/destroy closing the
decoder while the loop was suspended on an `await`). But they are also a **silent** exit:
if `configure()` never succeeded — e.g. because it was handed 0×0 from the primary lead
above — both feed loops now `break` immediately on every pass and no frame is ever
decoded, with nothing logged.

This is very likely the *mechanism* by which the 0×0 turns into a black screen rather than
a visible error. Worth adding a one-shot `debugLog()` on that branch regardless of the
root cause — a guard that can stall all video output should not be silent.

## Explicitly NOT the bug

The log contains a loud GStreamer warning that looks damning and is a red herring:

```
[bus/deck-0] WARNING: No decoder available for type 'video/x-h264, ...'
  (gsturidecodebin.c(1006): unknown_type_cb)
```

This is **by design**. `DeckAudioPipeline` installs an `autoplug-select` handler that
returns `SKIP` (2) for any factory whose klass contains both "Decoder" and "Video", so
video decoders are never instantiated in the *audio* pipeline (see the comment block in
`pipeline.rs`, and CLAUDE.md's note about VA-API corruption). decodebin then fires
`unknown-type` as a WARNING and abandons the video stream cleanly. Audio is unaffected —
which the same run confirms. Do not chase this.

## Other context worth having

- `src-tauri/src/video_demux.rs` also has an **uncommitted** change this session:
  `video_demux_load` gained a `fallback_url` param and now calls `ensure_cached()` instead
  of `lookup_wait()` (bug #1 in `docs/design/pipewiresink-play-hang.md`). The media in this
  test came through exactly that Digger remote-cache fallback path
  (`[media_cache] ... not found locally, reusing existing cache`), so it is in scope — but
  note the file *was* resolved and demuxed, so the caching change looks like it worked.
- Whether this is a regression or has been broken since the webcodecs default flip
  (`f6b94ea`) is **unknown** — nobody has A/B'd it against
  `VITE_...` legacy backend. `scripts/latency-test.sh <video> legacy|webcodecs` exists and
  is the cheapest way to find out.
- `docs/design/webcodecs-video-path.md` is the design doc for this path.

## Suggested first steps

1. Reproduce and confirm the 0×0 in `video_demux`'s log line for a *local* (non-cached,
   non-Digger) file too, to rule the cache path in or out in one shot.
2. Read the dimension/fps extraction in `video_demux.rs`. Compare against what the same
   file yields via `gst-discoverer-1.0` or the caps already in the log.
3. Check what the frontend does with `DemuxResult.coded_width/height` — specifically the
   `VideoDecoder.configure()` call — and whether a throw there is caught and logged
   anywhere. (`scripts/probes/webcodecs_decode_only_probe.py` is a working reference for a
   correct configure+decode sequence.)
4. Add logging to the `decoder.state !== "configured"` guards before anything else, so the
   next repro is not silent.

## Warning for whoever picks this up

Do **not** run the app and leave it deadlocked while testing anything else audio-related on
this machine — see `docs/design/pipewiresink-play-hang.md`. That mistake cost a full
session. The `pulsesink` switch should have removed the deadlock, but if you revert it or
experiment with `pipewiresink`, `pgrep -a cuemark` before trusting any external tool.
