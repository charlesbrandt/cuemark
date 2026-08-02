# Video not rendering on the webcodecs path (deck shows no picture, audio fine)

Status: **OPEN — not yet investigated.** Captured 2026-08-02 during the live test of the
`pipewiresink` → `pulsesink` audio fix (`docs/design/pipewiresink-play-hang.md`). Audio
was confirmed working by the user in that same session; video never appeared. Written up
for a fresh session rather than investigated inline, per user request.

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
