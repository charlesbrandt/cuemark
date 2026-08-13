# Play pressed during a scratch gesture: lost transport + a runaway video clock (design)

**Status: 🟢 CLOSED 2026-08-13. Root-caused from log forensics with no reproducer, fixed, and
live-confirmed the same day — the deck now plays from where the gesture left off.**

Two independent defects that only surface together, both reachable by an ordinary live
action: end a vinyl scratch, press play before the gesture's idle timer has expired.

## The report

> I came off of a vinyl scratch and pressed play (I think) and the video started playing
> back at a very fast rate. I pressed pause / play again and then the position came back to
> the right spot and everything worked as expected.

## The evidence

`~/.local/share/com.cuemark.app/logs/cuemark.log`, 2026-08-13 20:45 UTC, deck-0, build
`6eaa0f5`:

```
20:44:46.898  [scratch/deck-0] feeder start frame=2085733 mode=position hold_ms=1000
20:44:46.898  [bus/deck-0] pipeline: Paused → Playing        ← scratch puts the pipeline in PLAYING
   … 24.8s of vinyl jog …
20:45:11.564  [video-path] deck-0 webcodecs branch: calling audioPlay (was=false)
20:45:11.565  [audio/deck-0] detached-pipeline IPC received: play
20:45:11.674  [scratch/deck-0] idle timer fired 2ms late     ← the hold expires 110ms AFTER the play
20:45:11.730  [audio/deck-0] detached-pipeline IPC received: stop_scratch
20:45:11.738  [scratch/deck-0] feeder stop frame=2945035     ← true content position 61.355s
20:45:11.874  [bus/deck-0] async-done  pos=130006ms          ← pipeline reports 130.006s
   … no Paused → Playing anywhere in the next 3.5s …
20:45:14.370  calling audioPause (was=true)                  ← the user's corrective pause
20:45:15.242  ... play
20:45:15.245  [bus/deck-0] pipeline: Paused → Playing        ← only NOW does it actually play
20:45:20.086  [bus/deck-0] async-done  pos=66213ms           = 61.355 + 4.84s ✓ correct again
```

A second instance, same signature and same corrective pause/play by the user 3s later, in
`cuemark_2026-08-12_04-32-39.log` at 2026-08-11 21:32:04 (play 52ms ahead of `stop_scratch`;
content 3.425s reported as `pos=6040ms`).

## Defect 1 — `stop_scratch()` silently discarded the play

`play()` deliberately does not tear the feeder down, and a gesture already holds the
pipeline in PLAYING, so an `audio_play` landing mid-gesture set `self.playing = true` and
did nothing else — `set_state(Playing)` was a no-op. `stop_scratch()` then ran
`stop_scratch_feeder()` followed by an **unconditional `self.pause()`**, reverting it.

The deck sat PAUSED with the frontend's `deck.playing` still true (it logs
`calling audioPause (was=true)` three seconds later), so the frontend went on polling
position on a deck that was not moving. Nothing logged an error; the bus trace is the only
witness, and only by the *absence* of a `Paused → Playing`.

**Fix** (`pipeline.rs`, `stop_scratch`): capture `self.playing` before the teardown and, if
set, `pause()` then `play()` at the end. The pause→play *cycle* is deliberate rather than
simply skipping the pause — see defect 2.

**Why this branch is dead code outside the race:** the scratch feeder only ever runs on a
paused deck. Both input routes gate on it — `jog_nudge` enters the scratch path under
`if (!d.playing)`, and `WaveformCanvas.handlePointerDown` sets `dragAudible = !deck.playing`
(a playing deck scrubs silently via seeks and never starts a feeder). So `self.playing` is
false for the whole of any normal gesture, and `resume` can only be true because a play
raced in. Behaviour on the normal path is unchanged.

## Defect 2 — `query_position()` is inflated after every teardown

The teardown's ACCURATE resync seek targets content time 61.355s. The pipeline then reports
**130.006s**, which is:

```
61.355 (content, = final_frame / 48000)
+ 43.671 (the pipeline's stream position before the gesture, per the 20:44:45.944 async-done)
+ 24.976 (the gesture's own time in PLAYING)
= 130.002   vs. 130.006 reported — a 4ms match
```

It stays that way until the pipeline next goes Paused→Playing, which resets `base_time`.
That is exactly why the user's manual pause/play fixed it, and why the 20:45:20 reading is
correct again.

This inflation happens on **every** gesture teardown, not just the racing one — the
2026-08-11 log shows `feeder stop frame=6843828` (142.58s) reported as `pos=152052ms` on a
gesture with no play race at all. It normally goes unread because a deck is paused after a
gesture and the frontend only polls a playing deck. Defect 1 is what left it polling.

Latent even without defect 1: a device-switch pipeline rebuild restores position from
`position()`, and `audio_status` feeds the freeze-watchdog's session-of-record.

**Fix** (`pipeline.rs`, `position`): when `last_scratch_frame` is set, answer from it rather
than from `query_position()`. It is the same value the resync seek targeted, and the same
reason `begin_or_update_scratch()` already prefers it. `play()`, `seek_output_domain()` and
`load()` all clear it, so normal playback is never served from this branch. Returned in the
seek/output domain (divided by `self.rate`), because that is the domain every non-scratch
caller reads — the frontend's poll multiplies by rate to recover content time.

## Why the video raced

`positionPoll.ts` classifies a position delta far larger than the wall-clock time that
elapsed as a seek, and takes the raw value: `contentPos = audioPos * seekRate` — 129.8s
against a true 61.355s. That goes to `codecPlayer.setClock()`, where **only backward jumps**
beyond `BACKWARD_JUMP_SECONDS` (0.5) take the flush-and-reseek path. A forward jump is
handed straight to the worker, which decodes forward to catch up: ~68.6s at 25fps ≈ 1700
frames chased as fast as software decode allows.

⚠️ That asymmetry is **correct and must not be "fixed"** — making forward jumps reseek is
adjacent to the change that was built and reverted on 2026-08-09 as a live audio regression
(`codec-frame-cache.md` §5a, `waveform-scrub.md`). The clock feeding it was wrong; the
clock is what got fixed.

This leg is inferred from the code, not from telemetry: the position poll logs its
latencies (`[poll-stats]`) but never its values. It matches the report exactly — video
racing forward, no audio (pipeline paused), position wrong until a pause/play.

## Defect 3 — the UI play button had no scratch guard

The MIDI `deck_play_toggle` path had carried a guard since the feature landed: cancel the
idle timer and stop the scratch before flipping `playing`. `DeckCard.svelte`'s play button
never did, and there is no keyboard play affordance — so the button is what fired here (the
MIDI trace around 20:45:11.5 shows only unmapped NoteOns).

**Fix**: the guard is now `flushScratch(deckId)`, exported from `handler.ts` and called from
both. Both stop-IPCs are dispatched synchronously from it, so a `updateDeck({ playing })` on
the next line is guaranteed to reach Rust behind the stop.

Rust now survives the bad ordering on its own; this keeps the ordering correct in the first
place, which is cheaper and stops the feeder driving output for an extra fraction of a
second.

## How to reproduce (the gesture used for live confirmation)

1. Load a track, play it for ~30s (the inflation scales with accumulated stream time — this
   is why the 20:45 event was spectacular at +68s and the 21:32 one was +2.6s and probably
   unnoticed).
2. Pause. Start a vinyl jog gesture and hold it for ~20s.
3. Release the wheel and press **play within `SCRATCH_IDLE_MS`** of the last tick.

Pre-fix: no audio, video races tens of seconds ahead, position wrong until a manual
pause/play. Post-fix: the deck plays from where the gesture left it.

## Standing cautions

- **The absence of a `Paused → Playing` in the bus trace is the tell** for a lost play. There
  is no error line for it — `play()` succeeding and `play()` having any effect are different
  statements, and only the bus distinguishes them. (`silent-failure-inventory.md`.)
- **`async-done pos=` is raw `query_position()`**, not `position()` — it does not have the
  output-graph latency subtracted and does not go through any of the corrections above. It
  is the right instrument for *this* bug precisely because it is raw.
- **Do not conclude a rate scaling bug from an inflated position.** The ratio here
  (130.006 / 61.355 = 2.12) looks like a plausible tempo and is not one: the deck was at
  rate 1.0 the whole time, confirmed by the pre-gesture `pos=43671ms` after exactly 43.63s
  of playback. It is an additive offset, not a multiplicative one — check both.
