# Per-track visual override

**Status (2026-09-20): DESIGN ONLY — nothing built.** Decisions below were made with the user
in conversation; the open items are at the end.

## The ask

1. A track with no video (audio-only deck) should be able to have a *preferred generated
   visualization*, playing where the video would play.
2. The same mechanism should let a track use a *different video* than its own, even when it
   already has one.

## Decisions (2026-09-20)

- **Stored in Digger**, against the track, so it follows the track across machines and the
  queue like markers and the grid. Cross-repo: needs a `db.py` column/table plus a numbered
  `migrate.py` step (pattern: `mix-zones.md`).
- **An explicit override always wins** over the track's embedded video. Unset ⇒ embedded video,
  else nothing (today's behaviour). "Fallback only" was rejected: it cannot express #2.

## Shape

```
VisualOverride =
  | { kind: 'viz',   name: string, uniforms?: Record<string, number> }
  | { kind: 'video', filePath: string }
```

Applied when a track loads onto a deck (Digger queue load, same path that already carries
`diggerTrackId` and the mix-zone fields). `Deck` gains `visualOverride: VisualOverride | null`.

- **`video` override**: replaces the video half of `DeckSource` (demux/decode of `filePath`)
  while audio still comes from the track. ⚠️ Audio is the master clock and the video is slaved
  to it: an override video's timeline is not the track's. Open question 1.
- **`viz` override**: renders a shader *into that deck's FBO*, so it takes the deck's opacity
  and the crossfader like video does.

## Why not the existing global layer

`Session.visualization` sits above all decks at its own opacity. With deck A on a viz and deck
B on video, the crossfader must fade between them, which only works if the viz is *the deck's
picture*. So this needs a per-deck viz render source.

This does **not** re-open the 2026-06-21 decision. That bug was `DeckSource` switching to
`'shader'`, which made `syncVideoElements()` tear the deck down and `audioUnload()` kill the
music. Here `DeckSource` and the audio path are untouched; only the compositor's per-deck
*render input* changes. Do not reintroduce a `'shader'` `DeckSource`. The global layer stays.

## Work, in order

1. **Compositor**: `renderVisualization` already renders into a `vizFbo` with a cached
   program. Generalise to a per-deck FBO + program keyed by deck id (there is no per-deck
   shader path any more; `renderShader` is gone). `composite()` needs no change, since it
   already blends decks by opacity.
2. **Protocol** (`outputProtocol.ts`): per-deck viz payload. Shader *source* only on change;
   `u_time`, bands and uniforms every frame, as the global layer does. Read that file first.
3. **Frame loop** (`App.svelte`): an active per-deck viz animates continuously, so it must
   mark the frame dirty (the global layer already does). A paused deck with a viz still costs
   frames; decide whether paused freezes it.
4. **State + load**: `Deck.visualOverride`, applied in the Digger load path.
5. **UI**: a picker on DeckCard (reuse VisualizationPanel's shader list) with a
   "save to track" action, writing through Digger's API.
6. **Digger**: storage + migration + endpoint.

Phase 1-4 are useful without 5-6 (set per deck for a session), and can be live-tested first.

## Open items

1. Timeline for a `video` override: loop it, or start at 0 on play and free-run? Slaving it to
   the track's position makes no sense if durations differ.
2. Audio analysis for the viz (`u_bass`/`u_mid`/`u_high`) is max-across-playing-decks today. A
   per-deck viz probably wants *its own deck's* bands.
3. Verify on the real app: automated pixel checks of compositor output are unreliable on the
   MacBook Pro (WebGL readback), so this needs a visual look on the projector.
