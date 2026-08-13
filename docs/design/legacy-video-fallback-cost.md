# The legacy `<video>` fallback costs 50–340 ms per preview draw

Status: 🟡 **VP9 half re-closed 2026-08-05 (evening) — "the VP9 decay" was a measurement
artifact and does not exist. AV1's zero-frames finding still stands and is the only open
item.** A1, A2 and A4 all stand. The reopening below was half right: it correctly caught
that the sweep could not see paint-phase cost, but the decay it reported is **not a decay** —
a 7-minute controlled arm shows the frame rate oscillating 9–57 fps continuously, and the
"58.6 → ~13 fps plateau" was a 2-minute window that caught one trough of that oscillation
and read it as a terminal state. Leak, thermal and CPU-starvation are all refuted by
measurement. **Read "2026-08-05 (evening) — the decay arm ran" below before any other fps
claim in this file**, including the reopening's.

Superseded status line, kept for the history: **A1, A2 and A4 have all run (2026-08-05). The
finding is closed for VP9 and H.264; AV1 remains on the legacy path and cannot leave it.** H1
is refuted, H2 is half the answer, the per-call cost is pinned to the video codec by a
single-variable arm, and the structural fix has shipped: VP9 now goes through the WebCodecs
demux path and never touches a `<video>` element, which took the worst-case library file from
**~26 fps to ~55 fps**. Read "A1 ran", "A2 ran" and "A4 ran" below before anything else in
this doc; they supersede the ranking in "Hypotheses". **This paragraph's fps claims are now
superseded by "2026-08-05 live verification" below.**

Original status line, for context: **root-caused to a call site, mechanism not yet confirmed.**
Found 2026-08-05 by reading back a live set (the "Cassius 1999" session, 01:37–01:59) rather
than from a measurement run. Every number below is from that session's log; nothing here has
been reproduced under a controlled arm yet, and **step 1 of the plan is a control arm that
could still overturn the mechanism** (not the call-site attribution, which is solid).

**One-line version**: any file that is not H.264 falls back to the legacy `<video>` element,
and on that path `ctx.drawImage(video, …)` in `DeckCard`'s preview loop costs **86 ms median /
300 ms worst per call**, eating 61–68 % of the control window's wall clock. It takes a playing
deck from 58 fps to 5.6 fps, starves the GStreamer audio threads into underruns, and in one
case starved the heartbeat long enough for the freeze-watchdog to reload the window mid-set.

**If you are picking this up fresh, read "Where to pick up" at the bottom first.**

---

## Provenance

- Log: `~/.local/share/com.cuemark.app/logs/cuemark.log`, timestamps `2026-08-05 01:37`–`01:59`.
- Build stamp for that run: `cuemark 5909dcb (dirty) profile=debug built=2026-08-04 22:43:29Z
  exe=…/target/debug/cuemark` (logged at `22:48:07`; the process ran ~3 h without restarting,
  so every line in that window belongs to one build).
- Rotation is `KeepAll`, so the evidence survives — but find it by **timestamp and build
  stamp**, not by line number.
- No output window was open for the entire session (`[post-frame]` count = 0), so `postFrame()`
  contributed nothing. The compositor is not involved in any of this.
- Hardware: Intel i7-3615QM (Ivy Bridge, 4C/8T, 2012) + Intel HD 4000 / Mesa `crocus`.

Files involved, as identified by `gst-discoverer-1.0` on the media cache:

| Deck file | Codec | Size | fps | Path taken |
|---|---|---|---|---|
| Jonas Rathsman — Tobago | H.264 `avc1.64001f` | 1280×720 | 25 | webcodecs |
| Chancha Via Circuito — Sueño en Paraguay | H.264 `avc1.4d401f` | 1280×720 | 6 | webcodecs |
| **Cassius — Cassius 1999 (Radio Edit)** | **AV1** | **1920×1080** | **6** | **legacy** |
| **Daniel Wang — Free Lovin'** | **VP9** | **640×480** | **25** | **legacy** |

---

## The natural A/B already in the log

`01:41:27`–`01:42:41` is a single-variable experiment nobody designed. Two decks, both
playing, nothing else changed; one file is swapped from H.264-webcodecs to VP9-legacy and back
to paused:

```
01:41:30 [raf] 58.4fps | gap p50=16 p90=17    preview/deck-0 drew=0            busy 0%
01:41:40 [raf] 58.5fps | gap p50=16 p90=23    preview/deck-0 drew=0            busy 0%
01:41:45 [raf] 52.4fps | gap p50=16 p90=27    preview/deck-0 n=262 drew=0      busy 0%
─── 01:41:46.277  [video-path] deck-0 demux failed, falling back to legacy <video>:
                  unsupported codec for WebCodecs demux path: video/x-vp9 (H.264 only in phase 1)
01:41:56 [raf] 10.0fps | gap p50=96  p90=214  preview/deck-0 n=53 drew=19  dur p50=0.0  p90=139.0 max=261.0  busy 39%
01:42:01 [raf]  5.6fps | gap p50=164 p90=366  preview/deck-0 n=28 drew=28  dur p50=86.0 p90=258.0 max=301.0  busy 68%
01:42:06 [raf]  6.0fps | gap p50=105 p90=362  preview/deck-0 n=30 drew=28  dur p50=75.0 p90=247.0 max=337.0  busy 65%
01:42:11 [raf]  8.0fps | gap p50=88  p90=250  preview/deck-0 n=39 drew=31  dur p50=59.0 p90=187.0 max=249.0  busy 66%
01:42:16 [raf]  9.6fps                        preview/deck-0 n=49 drew=29  dur p50=47.0 p90=189.0 max=299.0  busy 61%
01:42:21 [raf]  9.7fps                        preview/deck-0 n=48 drew=29  dur p50=50.0 p90=176.0 max=189.0  busy 59%
01:42:26 [raf]  8.1fps                        preview/deck-0 n=41 drew=34  dur p50=48.0 p90=180.0 max=257.0  busy 61%
01:42:31 [raf] 10.4fps                        preview/deck-0 n=54 drew=32  dur p50=55.0 p90=175.0 max=193.0  busy 61%
─── 01:42:34.986  [bus/deck-0] pipeline: Playing → Paused
01:42:41 [raf] 51.8fps | gap p50=16 p90=27    preview/deck-0 n=260 drew=0     busy 0%
```

**58 fps → 5.6 fps → 52 fps**, on the swap in and the pause out. The other deck (`deck-1`,
H.264 webcodecs) held `dur p50=0.0 … busy 1–2 %` throughout, so this is not "the machine got
busy" — it is one deck, on one path.

## Why it is `drawImage`, not the surrounding code

Three independent facts, all from `[aux-loop]`, which times the whole `draw()` body on
**every** rAF tick (`DeckCard.svelte:192`, unconditional) and reports `drew` separately:

1. **Ticks that do not draw cost nothing.** `01:42:36`: `n=65 drew=21 dur p50=0.0 p90=149.0`.
   The median tick — a non-drawing one — is 0 ms. Only the drawing ticks are expensive. When
   `drew == n` (`01:42:01`), the median goes to 86 ms.
2. **The text publishers are already rate-limited** and cannot account for it. `publishTime()`
   fires on a whole-second change (≤ 5×/5 s) and `publishPhase()` is capped at
   `PHASE_PUBLISH_MS = 200`; §7 of `control-window-frame-budget.md` priced a deck-card text
   mutation at ~20 ms. Even assuming both fired on every tick that is ~20 ms of an 86 ms
   median, and fact (1) already excludes them — they run on non-drawing ticks too.
3. **It is not pixel work.** The 640×480 VP9 file cost **86 ms/draw**; the 1920×1080 AV1
   Cassius cost **12 ms/draw** — 7× cheaper for 6× the pixels. Resolution is refuted.

The call site is `src/components/DeckCard.svelte:149`:

```js
ctx!.drawImage(video, 0, 0, canvas.width, canvas.height);
```

## The Cassius case, for the record

Same mechanism, milder, because the file is 6 fps rather than 25 fps — the preview has a
genuinely new frame far less often:

```
01:39:30.453  [media_cache] Cassius - Cassius 1999 (Radio Edit) … → bf991bae5d40c8a2-9569484.mp4
01:39:30.523  [video-path] deck-1 demux failed, falling back to legacy <video>:
              unsupported codec for WebCodecs demux path: video/x-av1 (H.264 only in phase 1)
01:39:40.595  [position-poll] deck-0 took 588ms — toRust=586 inRust=0 (lock=0.0 query=0.1) toJs=3
01:39:43 [raf]  8.8fps | gap p50=71 p90=258 max=602   preview/deck-1 drew=23 dur p50=8.0  p90=18.0 busy  6%
01:39:48 [raf]  9.1fps                                preview/deck-1 drew=37 dur p50=9.0  p90=25.0 busy 11%
01:39:53 [raf] 10.2fps                                preview/deck-1 drew=46 dur p50=12.0 p90=23.0 busy 14%
```

Note `toRust=586 ms` on the position poll. Per `control-window-frame-budget.md` that leg is a
**load gauge, not a cost** — it says the GTK main thread is 586 ms late getting back to a
callback. `inRust=0`. Nothing about GStreamer is slow here; do not re-open that.

40 s into this state the heartbeat went silent and the watchdog fired:

```
01:40:10.794 [watchdog] TRIGGER: window 'main' silent for >= 6s — last stats:
             {"decks":[{"id":"deck-0","ready":null,"vct":null},
                       {"id":"deck-1","ready":2,"vct":0.223711142}],"lastRafMs":75}
01:40:10.794 [watchdog]   descendant pid=1959706 comm=WebKitNetworkPr state=S etimes=10933s
             Δutime=0 Δstime=0 [near-0%-CPU, all-parked — matches known deadlock signature]
01:40:10.795 [watchdog] recovery tier1 (eval reload): window 'main'
01:40:13.795 [watchdog] recovery tier2 (native reload): window 'main'
01:40:16.485 [watchdog] window 'main' heartbeat resumed after 12.0s silence
01:40:18.795 [watchdog] recovery sequence for 'main' succeeded
```

⚠️ **The watchdog's `WebKitNetworkPr … matches known deadlock signature` line is a
misattribution here.** This was not a `NetworkProcess` deadlock (`webcodecs-video-path.md`
"Risks and open items"); it was steady-state main-thread saturation, and an idle
`NetworkProcess` is what you would expect either way. Do not let that line send a future
session down the deadlock path — cross-check `[raf]` fps and `[aux-loop] busy%` from the same
window first. See `freeze-watchdog.md` for the follow-up note.

**The diagnostic defect behind that line is fixed (2026-08-05, `watchdog.rs`)**, so a log
captured after that date cannot reproduce this misattribution — the sample now asserts
whether it actually saw a `WebKitWebProcess`, and the deadlock verdict carries its
denominator (`N/M WebKitWebProcess parked`) on a single line separate from the raw
per-descendant observations. A saturated web process now prints `0/1 WebKitWebProcess
parked — does NOT match the deadlock signature … main-thread saturation`, naming *this*
document. Full write-up in `freeze-watchdog.md` "Risks". **The line quoted above is still
what the 2026-08-05 log says** — it is preserved here verbatim as the historical evidence,
not as current output format.

The reload "succeeded" but re-loaded Cassius straight back onto deck-1 (`01:40:15.862`, same
AV1 fallback message) and the window sat at 14–17 fps for the next minute. **Recovery cannot
help when the cause is steady-state load** — this is a real limit of the watchdog design, not
a bug in it.

---

## Secondary finding: the preview's change-check does not work on the legacy path

`DeckCard.svelte:141` gates the draw on:

```js
if (video.currentTime !== lastDrawnTime) { … }
```

On WebKitGTK `currentTime` advances continuously, not in frame steps, so this never gates
anything. Cassius is a **6 fps** file and it drew on every single rAF tick:

```
01:41:21  preview/deck-1 n=70 drew=70 | dur p50=8.0 p90=18.0 max=25.0 | busy 14%
```

70 draws in 5 s of a source producing 30 frames in 5 s — **2.3× redundant**, and that is at a
degraded 13.6 fps. At a healthy 60 fps it would be 10× redundant.

The codec path's equivalent check is correct and should be the model
(`DeckCard.svelte:166`): `if (frame && frame.timestamp !== lastDrawnPts)`.

This was written up as an **amplifier, not the cause**. ✅ **Promoted 2026-08-05: for H.264 it
is the *entire* cause.** A1 arms 1 and 2 measured the same file's per-drawing-call cost as
9–10 ms on `legacy` against 7–8 ms on `webcodecs` — near-identical — while `drew/n` went
`172/172` against `~90/265`. The legacy path's 52.5 → 34.5 fps penalty on a codec it should not
have hurt is this check and nothing else. Ship A2.

✅ **A2 shipped 2026-08-05 — see "A2 ran" below for the before/after arms.**

---

## Hypotheses for the per-call cost

⚠️ **Historical — all four were tested on 2026-08-05. Read "A1 ran" below for the outcome
(H1 refuted, H2 half right, H3 reframed) before acting on anything in this section.**

Ranked, with the experiment that discriminates each.

**H1 — `drawImage(<video>)` is a synchronous GPU→CPU readback.** GPU compositing has been on
since 2026-08-02 (`WEBKIT_DISABLE_DMABUF_RENDERER` retired, see CLAUDE.md). With the DMA-BUF
renderer live, the `<video>` element's frames land in a GPU texture, and pulling them onto a 2D
canvas is exactly the class of operation that is broken/pathological on Mesa `crocus` here
(`docs/upstream/webgl-canvas-readback-broken.md`). CLAUDE.md flagged this precise path as
untested:

> ⚠️ **One path remains untested**: the legacy `<video>` fallback (non-H.264 and audio-only
> files) has never been checked with the DMA-BUF renderer enabled.

It has now been tested, by accident, in front of an audience. The predicted failure was VA-API
canvas *corruption*; the observed failure is a synchronous main-thread stall.
→ **Experiment: `CUEMARK_DISABLE_DMABUF=1`.**

**H2 — the cost is the legacy path itself, independent of codec.** `drawImage(video)` may be
blocking on the video sink / decoder handshake rather than on a readback.
→ **Experiment: force an *H.264* file onto the legacy path** via the per-deck override in
`src/lib/video/videoPathSettings.ts` (`setVideoPathOverride(deckId, 'legacy')`, persisted to
`localStorage` under `cuemark:videoPathOverride`), or `VITE_VIDEO_PATH=legacy` at build time.
**This is the control arm and it must run first.** If H.264-legacy also costs ~86 ms/draw, the
codec is exonerated and the problem is the path — which changes the fix completely.

**H3 — software decode of VP9/AV1 is the cost.** Already weak: this is an Ivy Bridge / HD 4000,
which has **no VP9 or AV1 hardware decode at all**, so both files are software-decoded
regardless of the `GST_PLUGIN_FEATURE_RANK` demotion in `main.rs:60`
(`vaav1dec:0,vaapiav1dec:0`). **That demotion is a red herring for this finding** — do not
spend a session on it. H3 is also hard to square with a 640×480 25 fps stream costing 7× a
1920×1080 6 fps one, and with the cost landing inside a JS call rather than showing up as
unaccounted-for wall clock.

**H4 — refuted: pixel/resolution work.** See "Why it is `drawImage`" fact (3).

---

## A1 ran — 2026-08-05, six arms

**One-line verdict: what makes the call expensive is the *video codec of the stream feeding
the `<video>` element*.** At identical container, resolution, frame rate, video path and
preview-canvas size, `drawImage(<video>)` costs **22–24 ms on VP9 and 8 ms on H.264** — a 3×
difference from an arm that changed the codec and nothing else. It is **not** the DMA-BUF
renderer (arm 4 refutes that outright) and it is **not** the legacy path as such (arm 1/2 show
the legacy path's H.264 penalty is almost entirely draw *frequency*, not per-call cost).

### Method

Six clean app launches, one arm each, driven by the existing `perfArm.ts` harness
(`VITE_PERF_SWEEP=1 VITE_PERF_SWEEP_TRACK=/abs/path`) so no operator input was needed and the
sweep's own wedged-pipeline guard applied. Every arm was validated as genuinely playing before
its numbers were read: `[poll-stats] total` p50 ≥ 10 ms (never the ~2 ms wedge tell),
`[aux-loop] drew > 0`, no `play` IPC retry storm. One instance at a time, verified with
`pgrep -x cuemark` + `ss -ltn | grep 1420` before each launch. Build for all six:
`cuemark 5909dcb (dirty) profile=debug exe=…/src-tauri/target/debug/cuemark`, and the served
`DeckCard.svelte` was diffed against disk (`curl localhost:1420/src/components/DeckCard.svelte`)
before the first arm.

Numbers below are the **`arm=baseline` window only** (the sweep's first 30 s / six 5 s flushes),
because every later arm suppresses deck-card text and is therefore not comparable across runs.
`WebKitWebProcess`/`cuemark` CPU is `top -b -n 2 -d 2`, second sample, never `ps`.

**The instrumentation gap is closed**: `DeckCard.svelte`'s `[aux-loop]` bucket now carries
`@WxH` like the waveform bucket does. Every arm below ran at `preview/deck-0@1195x672` — one
deck, window maximised — and that is recorded in the log, so these numbers are re-comparable.

### The arms

| # | file | codec | container | src res / fps | video path | DMA-BUF | `dur` p50 | `dur` p90 | `busy%` | `drew/n` | `[raf]` fps | webkit CPU |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `219000972d…mp4` | H.264 | mp4 | 1280×720@25 | **legacy (forced)** | on | **9** | 10–12 | 31–32 | **172/172** | **34.5** | 88–101 % |
| 2 | `219000972d…mp4` | H.264 | mp4 | 1280×720@25 | webcodecs | on | 0 | 7–8 | 12–14 | **~90/265** | **52.5** | 70–102 % |
| 3 | `d4f4826e…webm` | VP9 | webm | 640×480@25 | legacy (auto) | on | **22–32** | 36–130 | 52–61 | n/n | **17.2** | 22–60 % |
| 4 | `d4f4826e…webm` | VP9 | webm | 640×480@25 | legacy (auto) | **off** | **54–55** | 58–60 | 49–53 | n/n | **9.1** | **99–106 %** |
| 5 | `probe-vp9.mp4` | VP9 | **mp4** | 640×480@25 | legacy (forced) | on | **22–24** | 36–41 | 52–55 | n/n | 26.8 | 45–60 % |
| 6 | `probe-h264.mp4` | **H.264** | **mp4** | 640×480@25 | legacy (forced) | on | **8** | 9–17 | 27–31 | n/n | 34.8 | 54–69 % |

Arms 5 and 6 are the single-variable pair: `probe-h264.mp4` is `probe-vp9.mp4` re-encoded from
the same decoded frames (`vp9dec ! x264enc`), same container, same resolution, same frame rate,
same AAC audio, both forced to `legacy`, consecutive launches. They were built from the VP9
file in the media cache with plain `gst-launch-1.0` (no `ffmpeg` on this machine); the recipe is
under "How to reproduce". Arms 1 and 2 are the H.264 path pair. Arms 3 and 4 are the DMA-BUF pair.

### Verdicts

**H1 (`drawImage(<video>)` is a synchronous GPU→CPU readback through the DMA-BUF renderer) —
REFUTED.** Arm 4 vs arm 3 changes exactly one thing, `CUEMARK_DISABLE_DMABUF=1`, and the cost
goes the **wrong way**: per-call `dur` p50 22–32 ms → **54 ms**, frame rate 17.2 → **9.1 fps**.
If the cost were a readback that exists only because the DMA-BUF renderer put the frame in GPU
memory, removing the DMA-BUF renderer would remove the cost. It doubles it. (The `WebKitWebProcess`
CPU jump to 99–106 % in that arm is the software-page-composition signature CLAUDE.md already
documents for `WEBKIT_DISABLE_DMABUF_RENDERER=1`, and is independent confirmation that the env
var reached the process — as is `/proc/<pid>/environ`, checked live on a later arm.)
**`CUEMARK_DISABLE_DMABUF=1` is not a mitigation for this bug. It makes it worse.**

**H2 (the cost is the legacy path itself, codec-independent) — HALF RIGHT, and the useful half
is not the one the hypothesis named.** Forcing a known-good H.264 file onto `legacy` *is*
expensive — 52.5 → 34.5 fps, `busy` 12–14 % → 31–32 % — so the fallback is genuinely unusable
even for the codec it was never supposed to hurt. But the mechanism is **draw frequency, not
per-call cost**: per drawing call the two paths are within ~2 ms of each other (legacy 9 ms
median; webcodecs `dur` p90 7–8 ms across a distribution where only ~1 tick in 3 draws), while
legacy draws on **every single rAF tick** (`drew=172/172`) against webcodecs' ~90 of 265. That is
exactly the broken `video.currentTime !== lastDrawnTime` check written up under "Secondary
finding" — which is hereby promoted from "amplifier" to **the entire H.264-legacy penalty**, and
which A2 already fixes.

**The 22–86 ms per-call cost is codec-linked — arms 5 vs 6.** Nothing else survives: container
identical (mp4), source resolution identical (640×480), frame rate identical (25), destination
canvas identical (1195×672), path identical (forced `legacy`), audio codec identical, content
identical to the pixel before encode. VP9 costs **22–24 ms/call and 52–55 % of the main thread**;
the same frames as H.264 cost **8 ms and 27–31 %**.

**H3 (software decode is the cost) — the *conclusion* survives in reframed form, but its stated
reason was wrong, and so was CLAUDE.md's.** H3 was ranked weak partly on "this GPU has no VP9 or
AV1 hardware decode, so both files are software-decoded regardless". That is true but far too
narrow: **this machine has no VA-API driver for any codec at all right now.** There is no
`i965_drv_video.so` or `iHD_drv_video.so` anywhere under `/usr`, no `mesa-va-drivers` package
installed (only `libva2`/`libva-drm2`/`libva-x11-2`), and no `gstreamer1.0-vaapi` plugin; the
GStreamer `va` plugin loads but registers **`0 features`**:

```
$ gst-inspect-1.0 va | tail -1
  0 features:
$ ls /usr/lib/x86_64-linux-gnu/dri/*_drv_video.so
d3d12  nouveau  r600  radeonsi  virtio_gpu      # no Intel entry
```

So **H.264 is software-decoded too**, and the 3× gap in arms 5/6 is *not* hardware-vs-software
decode. ⚠️ **CLAUDE.md's "H.264 hardware decode is deliberately live (re-tested working
2026-06-20)" is stale** — whatever provided VA-API in June is gone. Correct that line rather
than reasoning from it.

**And the cost is a block, not compute.** The pairing CLAUDE.md insists on pays off here: the VP9
arm shows **more** main-thread `busy%` (52–55 %) at **less** `WebKitWebProcess` CPU (45–60 %) than
the H.264 arm (27–31 % busy at 54–69 % CPU). Higher wall-clock share with lower CPU means the JS
call is *waiting*, not working — the opposite regime from the deck-card text finding in
`control-window-frame-budget.md` §7, where `busy%` was low and CPU high. Whatever `drawImage`
does with a VP9-backed `<video>`, it spends most of that 22–24 ms parked.

### What is still open

⚠️ **Superseded 2026-08-05 by A4 — this subsection is now academic and is kept only for
provenance.** cuemark no longer routes VP9 through a `<video>` element at all, so "why VP9
specifically" no longer gates anything. Do not spend a session on it.

Why VP9 specifically. Candidates, none tested:

- WebKit's `MediaPlayerPrivateGStreamer` may take a different frame-handoff route per decoder
  (`avdec_vp9`/`vp9dec` output memory type, stride/alignment, or a missing `GstVideoMeta`) forcing
  a synchronous copy or convert inside `drawImage` that H.264's `avdec_h264` output does not.
- The wait could be on a decoder/sink lock — plausible given the block signature — in which case
  it is a contention bug, not a conversion cost.
- The obvious next arm is one `GST_DEBUG` capture (`GST_DEBUG=GST_CAPS:5,*videoconvert*:5` or a
  `gst-shark`-style trace) on the WebKitWebProcess for each of arms 5 and 6, comparing the caps
  actually negotiated into the video sink. That is a **frontend/WebKit-internals** question, so
  weigh it against A4 (below) before spending a session on it.

### Two observations worth carrying, unrelated to the verdict

1. **Every arm degrades monotonically over its own run**, webcodecs included: arm 2 went 52.5 →
   36.4 fps and arm 1 went 34.5 → 23.4 fps across ~3 minutes, with `gap p90` blowing out while
   `gap p50` and `dur` p50 stayed flat. This is the same growing-tail behaviour
   `control-window-frame-budget.md` §6 flagged as unexplained and §7 attributed largely to φ; it
   survives here with φ's fix in place. It is **not** caused by anything in this doc, but it does
   mean a long arm reads worse than a short one, so only compare like-for-like windows.

   ⚠️ **Reinterpreted 2026-08-05 (evening): "monotonic degradation" was an artifact of arm
   length.** The 7-minute arm shows the frame rate *oscillating* 9–57 fps with a period of
   roughly a minute, recovering fully after every trough. A 30 s arm samples a fraction of one
   cycle and will read as a clean monotonic trend in whichever direction it happens to sit —
   which is exactly what these three sightings (here, §6, and the live verification) were. The
   practical rule is stronger than "compare like-for-like windows": **a window shorter than
   ~2 minutes cannot measure this machine's steady-state frame rate at all**, and the median
   across a multi-minute run is the only figure worth comparing.
2. **Even the healthy path is not at vsync.** H.264 on webcodecs, one deck, no output window,
   read **52.5 fps** in its baseline window, not the 61–62 fps `control-window-frame-budget.md` §7
   measured on an audio-only file. The preview `drawImage` of an actual video frame costs
   ~7–8 ms/draw at 1195×672 on this hardware, which is most of the difference. Worth knowing
   before treating 62 fps as the target for a deck with video in it.

---

## A2 ran — 2026-08-05, shipped

**One-line verdict: the preview now draws at exactly the source frame rate, and the gain is
proportional to how far rAF outruns that frame rate.** On the 6 fps AV1 file `drew` went
`133/133` → `30/258` per 5 s window — **6.0 draws/s, the file's frame rate to one decimal** —
and `[raf]` went **26.4 → 51.6 fps**. On the 25 fps VP9 file, where rAF was *already* slower
than the source, the same fix buys only 20.7 → 24.0 fps because there was almost no redundancy
left to remove.

### What the fix is, and why it is not `requestVideoFrameCallback`

The check is now `getVideoPlaybackQuality().totalVideoFrames` — the count of frames the media
player has actually presented — compared against the count at the last draw.

`scripts/probes/video_frame_signal_probe.py` (new) settled the choice. It plays a real file in
a bare `WebKit2 4.1` webview over plain HTTP and reports every candidate signal:

| Signal | Result on WebKitGTK 2.52.3 |
|---|---|
| `video.currentTime !== last` | changed on **1/1** rAF ticks — 100 %, i.e. gates nothing, exactly as suspected |
| `requestVideoFrameCallback` | **exposed**, and its metadata is complete (`mediaTime`, `presentedFrames`, `presentationTime`, `expectedDisplayTime`, `processingDuration`, `width`, `height`) — but **fired once in 6 s** |
| `getVideoPlaybackQuality().totalVideoFrames` | **+35 in 6 s = 5.8/s** on the 6 fps AV1 file, **+149 = 24.8/s** on the 25 fps VP9 file — the source frame rate, to within rounding |
| `webkitDecodedFrameCount` | not present |

⚠️ **rVFC's "fired once" is not evidence that rVFC is broken** — `rafTicks` was also **1**,
against `intervalTicks=453` from a plain `setInterval` control in the same run. A bare webview
here has no display-refresh source at all, so rVFC's *rate* is simply not measurable outside
the app, on Xvfb or on the real display (both tried). That control arm is why the probe reports
`intervalTicks`: without it the honest reading of `rvfc.calls=1` is unavailable.

So rVFC was rejected on **risk**, not on evidence against it: gating the only preview draw on a
callback whose firing rate cannot be verified risks a *frozen* preview, which is worse than a
redundant one — and `metadata.presentedFrames` is the same number `totalVideoFrames` returns
anyway, so rVFC would have bought nothing but that risk. The counter is also **decoder-driven
rather than display-driven** (it advanced fully in the probe while rAF was stalled), which is
precisely the regime this bug lives in.

Two deliberate details in the shipped code:

- **While paused it falls back to `currentTime`.** A seek made while paused must still repaint,
  and a paused deck draws a handful of times at most.
- **A stuck counter falls back permanently**, with a `debugLog` line. If the counter does not
  move for 1 s while the clock advances, the old check returns. Redundant draws are a
  performance bug; no draws is a broken UI.

### The arms

Two clean launches per file (fix stashed / fix applied), `VITE_PERF_SWEEP=1` autostart, one
deck, window maximised. `arm=baseline` window only. Build `cuemark 5909dcb (dirty) profile=debug`.
Every arm validated as genuinely playing (`drew > 0`, `Paused → Playing` on the bus, no `play`
IPC retry storm) and the served `DeckCard.svelte` diffed against disk each launch.

| file | codec / fps | arm | `drew/n` per 5 s | draws/s | `dur` p50 | `busy%` | **`[raf]` fps** |
|---|---|---|---|---|---|---|---|
| `bf991bae…mp4` | AV1 1920×1080@**6** | before | **133/133** (100 %) | 26.4 | 13–14 ms | 38–39 % | **26.0–26.9** |
| `bf991bae…mp4` | AV1 1920×1080@**6** | **after** | **30/258** (12 %) | **6.0** | **0.0 ms** | **10–11 %** | **50.0–54.7** |
| `d4f4826e…webm` | VP9 640×480@**25** | before | **104/104** (100 %) | 20.8 | 22–23 ms | 51–53 % | **20.6–21.6** |
| `d4f4826e…webm` | VP9 640×480@**25** | **after** | **100/121** (83 %) | 20.0 | 19–21 ms | 49–51 % | **23.6–25.1** |

Work metric and outcome metric move **together** on AV1 (draws −77 %, `busy%` −28 points, fps
+95 %) — the case §4 warns about, where one alone would lie, does not arise here.

### The result that matters for planning

**The fix's value is `min(rAF fps, source fps) / rAF fps`, and on the worst file that ratio is
already ~1.** The VP9 file plays at 25 fps into a loop running at ~21 fps, so nearly every rAF
tick genuinely *has* a new frame and there is nothing to skip — 104/104 before, 100/121 after.
The +3 fps it does gain is real but small, and it comes from the handful of ticks that fall
inside one frame interval.

This sharpened A3/A4 rather than softening them (**and A4 has since run — see "A4 ran"; the
prediction below held exactly, and shipping VP9 on the codec path removed the residual**):
**A2 does not rescue the VP9 case and was never going to.** 20 draws/s × ~20 ms is still ~40 % of the main thread, which is the codec-linked
per-call cost A1 pinned and only A4 removes. What A2 does fix outright is every legacy-path file
whose frame rate is below the frame rate the window could otherwise sustain — the 6 fps AV1
file, which is the one that starved the heartbeat into a watchdog reload mid-set.

Two incidental notes from the run:

1. **Re-measured baselines beat remembered ones.** A1's arm 3 read 17.2 fps for the VP9 file;
   the same arm re-run in this session read 20.6–21.6 fps. Same file, same path, same build
   family. Do not A/B across sessions.
2. ⚠️ **Vite bakes `import.meta.env` at *server* start, not per request.** A dev server left
   alive from a previous arm kept serving the *previous* arm's `VITE_PERF_SWEEP_TRACK`, so a
   run launched with the VP9 path silently loaded and measured the AV1 file — with a perfectly
   correct-looking log, because the *code* was re-transformed fresh from disk and only the env
   value was stale. The tell is the `[perf-sweep] autostart: loading …` line naming a file you
   did not ask for; check it, and kill `node …/node_modules/.bin/vite` between arms, not just
   `cuemark` and `cargo tauri dev`. (Happily this produced a free reproducibility check: the
   accidental re-run of the AV1 after-arm reproduced `drew=30`, 48.8–53.4 fps.)

---

## A4 ran — 2026-08-05, shipped for VP9, refused for AV1

**One-line verdict: VP9 now leaves the `<video>` element entirely, and the codec-linked
per-call cost A1 pinned goes to zero — 19–22 ms/draw and 49–52 % of the main thread become
0.0 ms and 9–10 %, taking `[raf]` from 23.9–28.6 fps to 54.2–56.4 fps.** AV1 cannot follow
it: `VideoDecoder` on this WebKitGTK decodes **zero** AV1 frames while
`isConfigSupported()` reports `true`.

Full implementation notes, the probe table, the gate results and the AV1 evidence live in
`webcodecs-video-path.md` "Phase 7 results (2026-08-05)". The short version:

### What `VideoDecoder` here actually does

`scripts/probes/webcodecs_vp9_av1_probe.py` (new) demuxes a real library file through the
same GStreamer chain `video_demux.rs` uses and decodes every AU in a bare webview:

| codec | `isConfigSupported` | frames decoded | outcome |
|---|---|---|---|
| VP9 `vp09.00.30.08` | `true` | **120/120**, I420 640×480 | ships |
| AV1 `av01.0.08M.08` | `true` | **0/120**, `EncodingError: Decode error` | refused |

⚠️ **`isConfigSupported()` lies about AV1.** Gating on it would have shipped a permanently
black deck for every AV1 file. Four bitstream framings and both description modes fail, and
so does a 320×240 stream GStreamer's own `av1enc` produced — so it is the decoder, not the
file, not the level, not the framing.

### The arms

Two clean launches, `VITE_PERF_SWEEP=1` autostart on
`~/.local/share/com.cuemark.app/media_cache/d4f4826ea21dc657-14817724.webm` (VP9
640×480@25 — the worst case), one deck, window maximised, `arm=baseline` window only. Vite
killed and relaunched between arms. Build for both `cuemark 5909dcb (dirty) profile=debug
built=2026-08-05 03:40:33Z`. Both validated as genuinely playing (`Paused → Playing` on the
bus, `drew > 0`, no `play` IPC retry storm); served `codecWorker.ts` diffed against disk.

| arm | path | `drew/n` per 5 s | draws/s | `dur` p50 / p90 | `busy%` | **`[raf]` fps** | webkit CPU |
|---|---|---|---|---|---|---|---|
| before | legacy `<video>` (`VITE_VIDEO_PATH=legacy`) | ~100/130 | ~20 | **19–22 / 32–41 ms** | **49–52 %** | **23.9–28.6** | 61.00 % |
| **after** | **webcodecs (VP9)** | ~124/277 | **25.0** | **0.0 / 4–5 ms** | **9–10 %** | **54.2–56.4** | 60.05 % |

All at `preview/deck-0@1195x672`. Closing `arm=baseline2` read 55.5–56.3 fps, so the run did
not drift. The CPU column is `perf-idle-test.sh`'s `video-deck-playing` vs
`webcodecs-deck-playing` on this same file.

**Read the CPU column and the fps column together or you will draw the wrong conclusion.**
CPU is flat (61.00 → 60.05 %) while the frame rate doubles. That is exactly right and it
corroborates A1's "the cost is a block, not compute" verdict: this machine has no VA-API,
so VP9 is software-decoded either way and the total work is unchanged — what moved is
*where* it happens. The legacy path paid for it by parking the main thread inside
`drawImage`; the codec path pays for it in a decode worker. A1 measured the same signature
from the other side (more `busy%` at less CPU on VP9-legacy).

`drew` is **25.0/s against a 25 fps source** — the codec path's
`frame.timestamp !== lastDrawnPts` check lands exactly on the source frame rate, and the
preview now costs a rounding error.

### What this leaves behind

- **AV1 is still on the legacy `<video>` path and has nowhere else to go.** What makes that
  survivable is A2: the library's AV1 file is 6 fps, and A2's frame-change gate already took
  it from 26 → 50–54 fps. A *high-frame-rate* AV1 file would still be bad, because A2's
  value is `min(rAF fps, source fps) / rAF fps`. Re-run the probe after any WebKitGTK
  upgrade; if AV1 decode starts working it is a small change to `video_demux.rs`.
- **A3 is no longer needed for VP9 and was never shipped.** Its poster-frame guard and
  preview-draw rate cap were stopgaps for exactly the case A4 has now removed. The only
  file class that would still benefit is high-frame-rate AV1, which does not currently exist
  in the library — leave A3 unbuilt unless one shows up.

  ❌ **Factually wrong as of 2026-08-05 (evening): high-frame-rate AV1 files are already in
  the library and always were.** `gst-discoverer-1.0` over the media cache finds **three**
  distinct AV1 files, only one of which is the 6fps clip everyone measured:

  | cache file | AV1 stream |
  |---|---|
  | `bf991bae5d40c8a2-9569484.mp4` | 1920×1080 **@6** — the only one ever measured |
  | `f87d86839efca2df-61335849.mp4` | 1920×1080 **@29.97** |
  | `6b88001ec763a5fe-10237095.mp4` | 1080×1080 **@25** |

  So "the exposure only applies to fast AV1 files, and we have none" was wrong twice over —
  the live verification separately found even the 6fps file renders *zero* frames. **Check
  the cache with `gst-discoverer-1.0` before making a claim about what the library
  contains**; three of ~13 distinct cached files are AV1, and AV1 is what YouTube serves, so
  Digger will keep delivering them.
- **The residual on a playing VP9 deck is now the deck-card text, not video.** In the same
  run the `noDeckText` arm reads 60.4–61.3 fps against baseline's ~55. That is
  `control-window-frame-budget.md` §7's known residual, now the largest remaining item.
- **The open "why VP9 specifically" question in "A1 ran → What is still open" is now
  academic.** It is a WebKit-internals errand about a path cuemark no longer takes for VP9.
  Do not spend a session on it; the only codec it would still explain is AV1, and AV1's
  problem is a different one (WebCodecs decode, not `drawImage`).

⚠️ **Incidental, and it was masking every gate**: all five `scripts/*-test.sh` harnesses
resolved `WebKitWebDriver` through `dpkg -L webkit2gtk-driver`, a package that no longer
exists here (it is `webkitgtk-webdriver` now). Under `set -e` each aborted immediately with
a bare `dpkg-query` error. Fixed in all five.

**Correction, 2026-08-12: "it is `webkitgtk-webdriver` now" did not flip back on this
machine — a *different* machine was checked and got misattributed here.** This whole doc's
investigation was on the 2012 MacBook Pro. The 2026-08-12 re-check
(`skills/verify-ui/SKILL.md`) actually ran on **`mele`** (Intel N150), a second cuemark
dev/test machine this doc corpus otherwise never mentions — it found `webkit2gtk-driver`
installed with `webkitgtk-webdriver` absent from apt entirely, which was written here as if
it re-confirmed the MacBook Pro's own package state. It didn't; the MacBook Pro's current
package name (as of any date after 2026-08-05) isn't actually known from this correction.
See `docs/environment.md` for the real per-machine matrix. What still holds regardless:
the package name isn't a durable fact on any single machine, so resolve the
`WebKitWebDriver` binary itself (PATH, then either package name as fallback) rather than
hardcoding one — that's what the "Fixed in all five" fix above actually does; don't undo it
by "simplifying" back to a single name.

---

## The plan

Four work items. **A2 is independent and can ship first.** A1 gates A3 and A4.

### A1 — Confirm the mechanism (diagnosis only, no fix) — ✅ DONE 2026-08-05

Ran as six arms; see "A1 ran" above for the numbers and the verdict. Outcome in one line: the
codec is the variable, H1 is refuted, and A4 is unblocked and promoted.

<details><summary>Original A1 brief (kept for provenance)</summary>

1. **Control arm first**: play a known-good H.264 file with the deck forced to `legacy`.
   Record `[aux-loop] preview/deck-N dur p50/p90` and `[raf]` fps. This decides H1 vs H2.
2. Re-run the VP9 file (`Daniel Wang - Free Lovin'`, cached as
   `~/.local/share/com.cuemark.app/media_cache/d4f4826ea21dc657-14817724.webm`) with
   `CUEMARK_DISABLE_DMABUF=1` and without, same session length, nothing else changed.
3. Report **both** a work metric (`dur p50`, `busy%`) and an outcome metric (`[raf]` fps).
   Either alone lies, in opposite directions — see `control-window-frame-budget.md` §4.

Exit criterion: a single sentence naming what makes the call expensive, backed by an arm that
changed *that* thing and nothing else.
</details>

### A2 — Fix the preview change-check on the legacy path — ✅ DONE 2026-08-05

Shipped in `DeckCard.svelte` (`legacyFrameChanged()`); see "A2 ran" above for the arms and for
why the signal is `getVideoPlaybackQuality().totalVideoFrames` rather than
`requestVideoFrameCallback()`. The exit criterion was met exactly: on the 6 fps Cassius file
`drew` is **30 per 5 s window**, not 70, and `[raf]` roughly doubled (26.4 → 51.6 fps).

<details><summary>Original A2 brief (kept for provenance)</summary>

Replace `video.currentTime !== lastDrawnTime` with a real frame-change signal. In order of
preference:

1. `video.requestVideoFrameCallback()` if WebKitGTK 2.52 exposes it — **check first**, this is
   exactly what it is for. A probe under `scripts/probes/` is the cheap way to find out.
2. Otherwise quantize: only draw when `Math.floor(currentTime * fps)` changes, with `fps` taken
   from the demux probe or defaulted conservatively.

Verify with `[aux-loop] drew` against the file's known frame rate over a fixed window — for the
6 fps Cassius file, `drew` should be ~30 per 5 s window, not 70.
</details>

### A3 — Fix the per-call cost — ⏸️ NOT NEEDED, not built (superseded by A4 for VP9)

A4 removed the case A3 existed to mitigate. The only file class that would still benefit is
a **high-frame-rate AV1** file, which the library does not currently contain (the one AV1
file is 6 fps, and A2's gate already handles it). Leave this unbuilt unless one shows up.
Original reasoning kept below because it is still the right plan *if* one does.

A1 removed the H1 branch entirely and reduced the H2 branch to A2. What is left is a
codec-linked block inside `drawImage(<video>)` that this codebase cannot fix — it is inside
WebKit's GStreamer media player. So A3 is no longer "fix the cost"; it is "stop paying it on a
path we should not be on at all" (A4), with these as the cheap guards in the meantime:

- **Stop drawing from `<video>` on the legacy path.** Still the cheapest correct mitigation and
  still available: a legacy-path deck can show a static poster frame, or nothing, rather than
  spend 52–55 % of the main thread on a preview. Cheap enough to ship as a guard now.
- **Rate-limit the preview draw off rAF entirely**, the way the waveform overview was cached in
  `81c5a28`. A1 measured the legacy path drawing on 100 % of rAF ticks; A2 has now corrected
  that to the source frame rate and the prediction held exactly — VP9 still measures **20
  draws/s × ~20 ms ≈ 50 % of the main thread** after A2. A cap of, say, 10 preview draws/s
  would halve that at no cost to audio, and is the cheapest remaining guard.
- ❌ **Do not use `CUEMARK_DISABLE_DMABUF=1`.** Arm 4 measured it making this exact bug **worse**
  (22–32 → 54 ms per call, 17.2 → 9.1 fps, `WebKitWebProcess` to 99–106 %). It was listed here as
  the H1 escape hatch; that is now a measured dead end, on top of CLAUDE.md's existing
  correctness objection (it corrupts the WebGL compositor canvas).

### A4 — Extend WebCodecs demux past H.264 — ✅ DONE 2026-08-05 (VP9 shipped, AV1 refused)

See "A4 ran" above for the arms and the verdict, and `webcodecs-video-path.md` "Phase 7
results" for the implementation. Outcome in one line: VP9 leaves the `<video>` element and
goes 23.9–28.6 → 54.2–56.4 fps; AV1 cannot leave it, because `VideoDecoder` on this
WebKitGTK decodes zero AV1 frames while claiming support.

<details><summary>Original A4 brief (kept for provenance)</summary>

**A1 promotes this from "the structural fix" to "the fix".** The per-call cost is a property of
the codec feeding the `<video>` element, inside WebKit; the only lever cuemark holds is not to
use a `<video>` element for that codec. Arm 2 is the existence proof: the same file on the codec
path draws at ~7–8 ms/call and one tick in three.


`src-tauri/src/video_demux.rs:231` gates the whole path:

```rust
"unsupported codec for WebCodecs demux path: {name} (H.264 only in phase 1)"
```

Every non-H.264 file in the library therefore hits the legacy path, which is now known to be
unusable live. Extending to VP9 (and AV1 if `VideoDecoder` supports it here) removes the
fallback rather than repairing it. Note this is a **codec-support** question — WebCodecs
`VideoDecoder` is fine to use; only `VideoEncoder` SIGABRTs (`docs/upstream/videoencoder-crash.md`).

Tracked as a candidate phase 7 in `webcodecs-video-path.md`.
</details>

---

## How to reproduce

The two offending files are already in the media cache and do not need the NAS or Digger:

```
~/.local/share/com.cuemark.app/media_cache/d4f4826ea21dc657-14817724.webm   VP9  640x480@25   (worst case)
~/.local/share/com.cuemark.app/media_cache/bf991bae5d40c8a2-9569484.mp4     AV1  1920x1080@6  (Cassius)
```

Load either onto a deck and press play. The tell is immediate:

```
[video-path] deck-N demux failed, falling back to legacy <video>: unsupported codec …
[aux-loop] preview/deck-N … dur p50=<tens of ms>  busy 60%+
[raf] n=… (~6fps)
```

⚠️ **Kill every previous instance first.** Two `cuemark` processes at once produce a ~9.7 fps
window that looks exactly like this bug. Check `ps -eo pid,comm | grep -E "cuemark|WebKitWebProces"`
and `ss -ltn | grep 1420`. See `control-window-frame-budget.md`'s closing warning.

⚠️ **Only compare windows with a deck playing.** An idle window has no polls in it and reads a
flat 62 fps; it is not a control for a playing one.

### Running an arm without an operator

Use the existing sweep harness — it loads the track and presses play by itself, refuses to
advance while the audio clock is stalled, and stamps `arm=` on every `[raf]`/`[aux-loop]` line:

```bash
VITE_PERF_SWEEP=1 \
VITE_PERF_SWEEP_TRACK=/abs/path/to/file.mp4 \
VITE_VIDEO_PATH=legacy \        # forces the legacy <video> path for this run
cargo tauri dev
```

`VITE_VIDEO_PATH=legacy` only seeds the default when `cuemark:videoPathDefault` is absent from
the origin's localStorage — which it is for `http_localhost_1420` today, and stays absent unless
someone clicks the DeckCard path toggle. **Check it before and after a run**, there is no
sqlite3 binary here:

```bash
python3 -c "import sqlite3;print([r for r in sqlite3.connect('file:$HOME/.local/share/com.cuemark.app/localstorage/http_localhost_1420.localstorage?mode=ro',uri=True).execute('select key from ItemTable')])"
```

Read the `arm=baseline` window (the sweep's first 30 s) when comparing across runs — every later
arm suppresses deck-card text and is not comparable to another run's baseline.

### Building a codec-only A/B pair

There is **no `ffmpeg` on this machine**; `gst-launch-1.0` does the job. This is the recipe that
produced arms 5 and 6 — same decoded frames, same container, same resolution/frame rate, same
audio codec, only the video codec differs:

```bash
SRC=~/.local/share/com.cuemark.app/media_cache/d4f4826ea21dc657-14817724.webm
# VP9 arm: remux only, no re-encode
gst-launch-1.0 -q filesrc location=$SRC ! matroskademux name=d \
  d.video_0 ! queue max-size-buffers=0 max-size-bytes=0 max-size-time=0 ! vp9parse ! qtmux name=m ! filesink location=probe-vp9.mp4 \
  d.audio_0 ! queue max-size-buffers=0 max-size-bytes=0 max-size-time=0 ! opusdec ! audioconvert ! audioresample ! voaacenc bitrate=128000 ! aacparse ! m.
# H.264 arm: same frames, re-encoded
gst-launch-1.0 -q filesrc location=$SRC ! matroskademux name=d \
  d.video_0 ! queue max-size-buffers=0 max-size-bytes=0 max-size-time=0 ! vp9dec ! videoconvert ! video/x-raw,format=I420 \
    ! x264enc speed-preset=ultrafast bitrate=1500 key-int-max=50 ! h264parse ! qtmux name=m ! filesink location=probe-h264.mp4 \
  d.audio_0 ! queue max-size-buffers=0 max-size-bytes=0 max-size-time=0 ! opusdec ! audioconvert ! audioresample ! voaacenc bitrate=128000 ! aacparse ! m.
```

⚠️ **The unbounded `queue` settings are load-bearing.** With default queue limits the two-branch
pipeline deadlocks: it ran 10 minutes and wrote 68 KB, looking exactly like "x264enc is
impossibly slow on this CPU". With them it finishes the whole 7-minute file in **18 s** — the
encoder was never the bottleneck.

### Instrumentation gap — ✅ CLOSED 2026-08-05

`[aux-loop] preview/<deck>` now carries `@WxH` like `waveform/<deck>@2448x144` does, per
CLAUDE.md's "record the width" rule. All six A1 arms logged
`preview/deck-0@1195x672`, so they are re-comparable. Older log windows (anything before
2026-08-05 02:28 UTC) have a bare `preview/deck-N` label and an **unknown canvas size** — do not
A/B them against a labelled run.

---

## 2026-08-05 live verification — both remaining claims broke

⚠️ **Half of this section is superseded.** Its VP9 half — "the ~55fps number does not hold,
it decays to a ~13fps plateau" — was tested under a controlled arm the same evening and
**does not survive**: there is no decay and no plateau. See "2026-08-05 (evening) — the
decay arm ran" below. The section is kept intact because its *method* critique was correct
and worth preserving (the sweep's metrics genuinely cannot see paint-phase cost), and
because its **AV1 half still stands unrefuted**. Read the two together.

The doc's own "Where to pick up" said *"nothing here is fixed until the user has played one
and not seen the stall."* That session happened this same day, in the real `cargo tauri dev`
window (build `0da1c0d`, clean), Hercules Starlight connected. Two things were checked; neither
held up.

### VP9 does not hold ~55fps in a real session

The exact file A4's 55fps number came from —
`~/.local/share/com.cuemark.app/media_cache/8dfeff2b1440d665-14817724.webm` (640×480 VP9 @25,
"the worst library file") — was loaded onto a deck and played continuously via the webcodecs
path (confirmed via `[video-path] deck-0 webcodecs branch: calling audioPlay`). `[raf]` over
the following ~2.5 minutes:

```
18:07:26  58.6fps | busy 1%
18:07:36  40.2fps | busy 2%
18:07:51  24.4fps | busy 1%
18:08:16  18.9fps | busy 1%
18:08:47  14.3fps | busy 1%
18:09:02  13.6fps | busy 1%
18:09:52  12.5fps | busy 1%   ← plateau, stable for the last ~35s of observation
```

`frame-dur` stayed at 0–1ms and `[aux-loop] preview/deck-0` `busy%` stayed at 6–8% throughout
— i.e. every JS-observable cost metric says nothing changed, while measured fps fell 4.5×. At
the plateau, `WebKitWebProcess` CPU (via `top -b -n2`, the correct point-in-time method per
`skills/run-app`) read **46.8%**, sampled twice with the same result.

**This is the exact signature CLAUDE.md's own instrumentation notes warn about**: *"`busy%`
measures the JS that records canvas drawing, not the paint that follows it... Symptoms: `busy%`
low while `WebKitWebProcess` CPU is high, and fps that does not respond to removing JS work."*
The automated sweep that produced 55fps measured `dur`/`busy%` — exactly the metrics that
warning says cannot see this class of cost. It was never in a position to rule this out, and
did not.

**Ruled out, weakly**: system memory pressure. `free -h` showed `available` at 9.2Gi (healthy)
and swap steady at 3.2Gi (not climbing across the two checks a few minutes apart) — a `top`
snapshot taken mid-investigation showed 39% `wa` (iowait), which raised the question, but the
steady-not-growing swap figure argues against active thrashing. Not fully eliminated —
no continuous sampling was run — but it is the second-place suspect, not the leading one.

**Not yet done**: a same-session A/B (this VP9 file vs. a forced-legacy H.264 file, or vs. the
same VP9 file with the deck paused/reloaded) to see whether the decay is time-based (grows with
elapsed playback — leak-shaped) or state-based (triggered once and then steady — a one-time
transition, e.g. a buffer/cache filling up). The plateau holding steady for 35s before
observation ended is the only hint so far, and it's compatible with either.

### AV1 on the legacy path: zero video frames, not a low frame rate

Deck-0 had an AV1 file auto-restored from session recovery on launch — Cassius, "Cassius 1999
(Radio Edit)", 1920×1080, AV1 @6fps (per the codec string in the pipeline's own log), the
exact class of file this doc previously called "survivable... because the library's AV1 is
6fps (26 → 50–54fps)". It was played for **~7 continuous minutes** (`18:00:34`–`18:07:22`),
audio confirmed working throughout (cue toggled on/off repeatedly via the real MIDI
controller, logged as `[audio/deck-0] cue ON`/`cue OFF`). Over that entire span:

```
[aux-loop] preview/deck-0@1195x672 n=305 drew=0 | ...
```

**`drew=0` on every single one of ~85 logged ticks across 7 minutes.** A real 6fps decode
would produce a nonzero `drew` within the first 5-second window (CLAUDE.md's own prior
measurement: `drew=133/133`/`30/258` for exactly this file class). Zero for the entire play is
not "slow," it is "never." The user confirmed this by eye: no video appeared in either the
`DeckCard` preview or the output window, for the whole play.

**Immediately after** (18:07:22), the same deck was switched to the VP9 file above, and
`preview/deck-0` started drawing normally (`drew=102/231`, `drew=123/201`, ...) in the same
session — which rules out a general rAF/preview-loop breakage and confines the fault to
something specific to this AV1 file/path.

**Root cause not established.** What is ruled out:
- The Rust-side `WARNING: No decoder available for type 'video/x-av1…'` logged at load time
  is **not** the cause — it comes from the audio pipeline's own `uridecodebin` correctly
  declining to decode a stream it only wants audio from (CLAUDE.md's own log-pattern table:
  *"Normal — autoplug-select is correctly skipping video decoders in the audio pipeline"*).
  It says nothing about WebKitGTK's separate, internal `<video>`-element decode pipeline,
  which this project has no logging visibility into at all.
- Not a missing GStreamer element system-wide: `gst-inspect-1.0` lists `aom: av1dec` (a
  software AV1 decoder) as registered on this machine. Whether WebKitGTK's own internal
  media player actually autoplugs it for a `<video>` element is unconfirmed — this is the
  next thing to check, not something this session could observe.
- `DeckCard.svelte`'s `legacyFrameChanged()` (the frame-change gate) has an explicit
  fallback for a stuck `totalVideoFrames` counter that logs
  `"preview: totalVideoFrames stuck at N for >1s while the clock advanced"` via `debugLog` —
  that line **never appeared**, but the code shows why that's not exculpatory: the
  stuck-counter timer only arms when `video.currentTime` is independently observed to be
  advancing (`timeChanged`). If `readyState` never reaches 2 at all (the same code path
  documented for genuinely audio-only files), the branch that reads `totalVideoFrames` is
  never entered and neither `currentTime` advances nor does the stuck-warning fire — which
  is indistinguishable, from this log, from "this file has no video track." The leading
  reading is that this AV1 `<video>` element is stuck at an early `readyState`, not that it
  reached `readyState 2` and then froze — but that has not been directly observed (would
  need `video.readyState`/`videoWidth`/`videoHeight` via the debug hook or devtools console,
  neither available against this live, user-visible window without disturbing it).

**This escalates the exposure CLAUDE.md already flagged.** The prior text said a
high-frame-rate AV1 file "would still perform badly" — implying the 6fps file was fine. Live
verification shows the 6fps file itself shows **no video at all**, so the exposure applies to
every AV1 file cuemark can currently be handed, not just fast ones.

### What to do next, in order

1. Confirm whether the AV1 `<video>` element ever reaches `readyState >= 2` at all. Needs
   `window.__cuemarkDebug` (already present — this is a `cargo tauri dev` build, so the hook
   needs no special build flag) via a tauri-driver session, or ask the user to check
   devtools (right-click → Inspect Element → Console →
   `document.querySelector('video').readyState`) live.
2. If `readyState` never advances: check whether WebKitGTK's internal playbin actually
   autoplugs `av1dec` for a `<video>` src — this may need `GST_DEBUG=avdec_av1:5,av1dec:5,
   playbin:3` exported before launch (propagates to `WebKitWebProcess` since it's inherited
   from the environment) to see the internal pipeline's decoder selection.
3. For the VP9 fps decay: re-run the same file with continuous `top -b -n1 -d1` sampling of
   `WebKitWebProcess` across the full decay window (not two snapshots), and try a same-session
   forced-legacy H.264 file as a comparison arm to see if the decay is specific to the
   webcodecs/canvas-paint path or general to this session/machine state.
4. Do not re-open A1/A2/A4's mechanism — the codec-linked cost, the draw-frequency fix, and
   the WebCodecs demux move are not what broke. Re-open only the fps/frame-count *outcome*
   claims built on top of them.

---

## 2026-08-05 (evening) — the decay arm ran

**One-line verdict: the VP9 "decay" does not exist. The frame rate oscillates 9–57 fps
continuously for as long as a deck plays; the reported "58.6 → ~13 fps plateau" was a
2-minute window that caught one trough. Leak, thermal throttling and CPU starvation are all
refuted, two of them by anti-correlation. The surviving anomaly is machine-level and
ambient, not cuemark-level.**

### Why an external sampler

The reopening's own argument was that every JS-observable metric stayed flat while fps fell
4.5×, so the cost had to be in a phase `busy%` and `dur` structurally cannot see. That is a
correct reading — and it means **adding more in-app instrumentation measures the same blind
spot again.** The three candidates each leave a distinct fingerprint *outside* the webview,
so the arm was built to sample from outside it:

| candidate | fingerprint |
|---|---|
| leak (ours or WebKit's) | RSS climbs monotonically with the decay |
| thermal throttle | throttle counters tick, package temp high, MHz drops |
| memory pressure / swap | swap grows, iowait rises, available falls |

New tooling, both dependency-free (`/proc` and `/sys` only, no root, no app changes):

- `scripts/decay-sample.sh` — 2 s samples of per-process RSS and **true point-in-time CPU**
  (from `/proc/<pid>/stat` jiffy deltas, never `ps`, per CLAUDE.md's lifetime-average
  warning), package temp, thermal-throttle counter deltas, CPU MHz, iowait, swap. Re-resolves
  pids every sample so a watchdog reload cannot silently blind it.
- `scripts/decay-join.py` — joins that CSV against `[raf]`/`[aux-loop]` lines on UTC
  wall-clock, so the outcome metric and the machine state read as one table.

### The idle control arm, and what it bought

3.5 minutes, deck loaded but **paused**, app untouched. Run this before any play arm — the
whole finding is a claim about change over time, and without it there is no way to tell
play-induced drift from ambient drift.

```
fps          61.9–62.0     110 windows, zero decay
webRSS       314 -> 305MB  sawtooth 302–318, ends BELOW start
throttled    0 ms          across the entire run
pkg temp     74–80 C
iowait       46 % mean
min avg MHz  1424          the CPU idles down; it has headroom
```

Three results for free:

1. **The decay is play-induced, not ambient** — the window holds a flat 62 fps indefinitely.
2. ✅ **iowait is eliminated as the cause.** The reopening listed memory pressure / iowait as
   its "second-place suspect" off a single 39 % `wa` snapshot. It sits at **46 % while the app
   holds a rock-steady 62 fps.** It is ambient on this machine.
3. **A leak verdict now needs > 16 MB of growth** to clear the idle sawtooth — a calibrated
   threshold rather than a guess.

### The play arm

Deliberately run on the **aged process from the live verification itself** — build `0da1c0d`,
up 40 minutes, the same VP9 file (`8dfeff2b1440d665-14817724.webm`, 640×480@25) still loaded
on deck-0 and paused since `18:14`. Resuming into that process rather than restarting is what
makes the arm able to test accumulation at all: `auCache` and every other in-app map survives
a pause, so a run that starts fast in a 40-minute-old process has already refuted them.

Play span `18:41:29` → `18:48:28` (EOS) — **6 min 59 s continuous**, 3.5× the window the
reopening measured. Validated as genuinely playing throughout (`drew` 62–126 per window,
clock advancing, no `play` IPC retry storm). One deck, no output window.

```
   t     fps   busy  gap90  drew  webRSS  webCPU  temp   MHz  thrD
   0    19.3    1%     73    95      +0            90    3093    0
  46    54.0    3%     30   122      -1    58.9   101    3101    7
  62    55.2    5%     29   125      -1    58.5    94    1903    0
  94    35.6    2%     74    98      -4    58.0    97    3093    0
 125    14.6    1%    148    67      -3    49.2    86    3093    0
 158    12.5    1%    151    63      -1    45.2    86    1197    0
 190    26.4    1%     96    81      -2    50.2    88    3103    0
 222    15.7    1%    135    69      -1    50.8    83    1198    0
 254    26.9    2%     97    83      -1    52.6    87    3094    0
 319    19.0    1%    113    73      +0    49.7    87    3093    0
 400    24.2    1%     98    78      +1    51.4    80    1197    0
 416    61.9    0%     17     1      +0     3.7    81    2295    0   <- EOS, deck stopped
```

Distribution over 182 playing samples: **min 8.7, p25 21.0, p50 24.5, p75 28.8, max 57.1.**

### Verdicts

**There is no decay — REFUTED, and this is the load-bearing result.** The frame rate reaches
its *maximum* (55.2 fps) at t=62, **after** a low start, and returns to 26–28 fps after every
trough for the remaining five minutes. A monotonic decay to a stable plateau is not what this
does. The reopening's "13.6 → 12.5 fps, plateau, stable for the last ~35 s of observation" is
a real observation of a real trough; the error was inferring a terminal state from it. ⚠️ **A
2-minute window cannot distinguish a decay from the falling half of an oscillation** — and
the earlier arms were 30 s, which is shorter still.

**Leak — REFUTED.** webRSS spread across a *complete* 7-minute playthrough was **9 MB**,
*smaller* than the idle control's own 16 MB sawtooth, with no trend. The Rust side was flat
to ±1 MB. Resuming into a 40-minute-old process started at 19 fps and rose to 55, which is
the opposite of what accumulated state predicts.

⚠️ **This also clears `auCache`, which is nonetheless a real latent bug.**
`codecWorker.ts:75`'s `Map<number, Au>` has **no `delete`, no `clear` and no cap** — it
accumulates every access unit for the whole playthrough, bounded only by the file's
compressed video size. It was the leading in-app suspect going in. It is not this bug: it is
too small to move RSS measurably and the frame rate does not track it. Worth fixing for
hygiene (a long set on large files is unbounded growth), **not** worth citing as a
performance cause.

**Thermal throttling — REFUTED, and anti-correlated.** 178 ms throttled across the entire
420 s run (0.04 %), essentially all of it in one early burst. The correlation runs the wrong
way:

```
fps < 20   n=32   mean temp  85.5 C   mean webCPU 48.7%
fps > 45   n=11   mean temp 100.0 C   mean webCPU 56.5%
```

**The frame rate is highest when the CPU is hottest.** Causation runs fps → temp (more
frames, more work, more heat), not temp → fps. Package temp also *fell* 101 → 79 °C across
the run while fps stayed in the low 20s. ⚠️ **Loud fans during a bad window are a
consequence, not a diagnosis** — this machine idles at 74–80 °C, and "it sounds hot" was
nearly mistaken for evidence.

**CPU starvation — REFUTED.** `/proc/pressure/cpu` reads `full=0.00`, and `webCPU` is
*higher* in the fast state (56.5 %) than the slow one (48.7 %). The low-fps state is one in
which the web process does **less** work and runs **cooler**. It is not being starved; it is
not being asked.

### The surviving anomaly — and it is not cuemark's

⚠️ **Correlational only. This is not established as the cause of the oscillation.**

```
/proc/pressure/io   some avg10=81.2   full avg10=72.4
                    full total = 85.0 h of 94.4 h uptime
vmstat              b = 5-6 blocked, wa = 50-57%
swap                3.3 GB of 4 GB used (80%)
sda (SSD)           in-flight = 0, counters nearly static
```

The system reports being **fully stalled on I/O ~72 % of the time, across 90 % of a
four-day uptime, while the disk is idle.** Bare metal, not a VM (`systemd-detect-virt` →
`none`, no hypervisor CPU flag). Whatever this is, it is **ambient** — the idle control shows
the same 46 % iowait while holding a flat 62 fps — so it does not set the frame rate on its
own. But a scheduler in that state under load fits *erratic oscillation* far better than
anything in cuemark's render path does.

### What this means for the native-rendering escalation

**Nothing here supports `native-output-pipeline.md`.** Its reopen criterion is "webview
rendering itself becomes the bottleneck or a new freeze class appears in compositing/WebGL
rather than media". The single measurement that looked like that evidence was a misread
window, and every in-app hypothesis it could have implicated is refuted. Do not cite the VP9
decay as an argument for the rewrite.

### Next — one cheap control, then stop

**Reboot and re-run this exact arm.** Four days of uptime, 3.3 GB swapped out and a
90 %-of-uptime I/O stall are all cleared by it, and it is the only remaining variable with a
plausible link to the oscillation. If fps holds ~55 afterwards, this finding closes for VP9
entirely.

```bash
scripts/decay-sample.sh 240 2 /tmp/idle.csv     # control: app open, deck PAUSED
scripts/decay-sample.sh 420 2 /tmp/play.csv     # arm: press play, then do not touch the window
scripts/decay-join.py /tmp/play.csv
```

⚠️ **Run the idle control every time.** It is what eliminated iowait and calibrated the leak
threshold, and both would otherwise have been guesses.

### Limits of this arm, stated plainly

- **One run, one file, one machine state.** The oscillation is reproducible within the run
  (many cycles) but the run itself has not been repeated.
- **The oscillation's own cause is not established** — only that it is not leak, not
  thermal, not CPU, and not JS.
- **It measures the machine, not WebKit's internals.** It can say the cost is not in any
  sampled resource; it cannot say which WebKit phase the time goes to.
- ✅ **What it does settle** is the question that was actually blocking: whether the reported
  decay is real (no), and whether anything in this doc justifies the rendering rewrite (no).

---

## What this does *not* explain

The 10.8 s audio dropout at `01:38:31`–`01:38:42` happened on the **H.264 webcodecs** path with
rAF at ~50 fps. It is a separate fault with a separate cause and its own doc:
`docs/design/audio-dropout-mid-playback.md`. Do not fold the two together — the later
underruns (`01:42:27`, `01:43:40`) *are* downstream of this doc's finding, but the first one is not.

---

## Where to pick up

**A1, A2 and A4's *measurements* are done (2026-08-05) and still stand — read "A1 ran", "A2
ran" and "A4 ran" first, they supersede "Hypotheses". The live verification they called for
ran 2026-08-05 (late) and reopened two outcome claims; the decay arm ran the same evening and
**closed the VP9 one as a measurement artifact**. Read "2026-08-05 (evening) — the decay arm
ran" first. AV1 is the only genuinely open item.**

1. ✅ **VP9 fps decay — CLOSED, it was not a decay.** A 7-minute controlled arm shows the
   frame rate oscillating 9–57 fps and recovering after every trough; the "58.6 → ~13fps
   plateau" was a 2-minute window on one trough. Leak (webRSS spread 9MB, under the idle
   control's own 16MB sawtooth), thermal (178ms throttled in 420s, and fps *anti*-correlated
   with temperature) and CPU starvation (`pressure/cpu full=0.00`) are all refuted. **One
   control still outstanding: re-run after a reboot**, which clears the 4-day uptime, 3.3GB
   of swap and the 90%-of-uptime I/O stall that is the last variable standing. Do not cite
   this decay as evidence for the native rendering rewrite — see the arm's own section.
2. **AV1 on the legacy path draws zero video frames, confirmed live** — not the "6fps but
   survivable" claim this doc previously made. `drew=0` for a full ~7-minute play, audio and
   cue working normally throughout; the same deck drew VP9 frames normally moments later in
   the same session, ruling out a general preview-loop break. Next: confirm via
   `window.__cuemarkDebug`/devtools whether `video.readyState` ever reaches 2 for this file;
   if not, check whether WebKitGTK's internal playbin autoplugs the registered `aom: av1dec`
   element for a `<video>` src at all (`GST_DEBUG=avdec_av1:5,av1dec:5,playbin:3`).
   `scripts/probes/webcodecs_vp9_av1_probe.py`'s "decodes zero frames" finding was about
   `VideoDecoder`, a different code path from the legacy `<video>` element — re-running it
   does not answer this.
3. **Do not build A3.** Its stopgaps were for the case A4 removed.
4. **The largest remaining cost on a playing deck is now the deck-card text**, not video —
   `noDeckText` reads 60.4–61.3 fps against baseline's ~55 in the A4 run. That belongs to
   `control-window-frame-budget.md` §7, not to this doc.
5. Do not re-investigate: **H1 / the DMA-BUF renderer** (refuted by arm 4, which made it worse),
   **why VP9 blocks inside `drawImage`** (now academic — cuemark no longer takes that path for
   VP9), GStreamer `query_position` (`inRust=0`), the waveform canvas (exonerated twice), the AV1
   `GST_PLUGIN_FEATURE_RANK` demotion (no VA-API at all on this machine), or the
   `WebKitNetworkProcess` deadlock (misattributed by the watchdog in the 2026-08-05 session).
6. ~~Correct CLAUDE.md~~ ✅ Done 2026-08-05 (A2 session), after re-verifying the three checks
   live: no Intel `*_drv_video.so`, no `gstreamer1.0-vaapi`, `gst-inspect-1.0 va` → `0 features`.

### Files that will be touched

| File | Why |
|---|---|
| `src/components/DeckCard.svelte` | the `drawImage` call site, the change-check — now `legacyFrameChanged()` (A2, done 2026-08-05); the `[aux-loop]` label now carries `@WxH` (done 2026-08-05) |
| `scripts/probes/video_frame_signal_probe.py` | which frame-change signal a legacy `<video>` actually exposes here — the probe that chose A2's mechanism |
| `src/lib/video/videoPathSettings.ts` | per-deck `legacy` override / `VITE_VIDEO_PATH`, used for A1 arms 1, 5, 6 |
| `src/lib/audio/perfArm.ts` | the sweep harness A1 and A4 were driven with (`VITE_PERF_SWEEP` + `VITE_PERF_SWEEP_TRACK`) |
| `scripts/probes/webcodecs_vp9_av1_probe.py` | A4's gate: does `VideoDecoder` here really decode VP9 / AV1? (it lies about AV1) |
| `src-tauri/src/video_demux.rs` | the codec gate — now `CodecKind::{H264,Vp9}` + `vp9_level_code()` (A4, done 2026-08-05) |
| `src/lib/video/codecWorker.ts` | `needsAvcRemux` — the one switch separating H.264's avc mode from VP9's pass-through (A4) |
| `scripts/decay-sample.sh` | machine-state sampler (RSS, true CPU, thermal-throttle deltas, iowait, swap) — the arm that refuted the decay, 2026-08-05 evening |
| `scripts/decay-join.py` | joins that CSV against `[raf]`/`[aux-loop]` on UTC wall-clock |
| `src/lib/video/codecWorker.ts` | `auCache` (line ~75) grows unbounded — a real latent bug, but measured *not* to be a performance cause |
| `scripts/*-test.sh` (all five) | `WebKitWebDriver` lookup, broken by a Debian package rename (fixed 2026-08-05) |
| `src-tauri/src/main.rs` | `CUEMARK_DISABLE_DMABUF` handling and the rank demotions (~38–60) |

### Related docs

- `control-window-frame-budget.md` — how to read `[raf]`, `[aux-loop]`, `busy%`, the IPC legs.
  **Read §4, §6, §7 before measuring anything here.**
- `webcodecs-video-path.md` — why the codec path exists, and the phase structure A4 would join.
- `output-noise-and-track-reload-silence.md` — the 2026-08-02 DMA-BUF re-enablement and its evidence.
- `audio-dropout-mid-playback.md` — the separate audio fault from the same session.
- `freeze-watchdog.md` — the recovery that fired, and why its signature line misled.
