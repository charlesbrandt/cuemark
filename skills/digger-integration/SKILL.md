---
name: digger-integration
description: Digger API integration in cuemark — endpoints, WebSocket queue updates, boundary rules between the two projects. Load when working on src/lib/digger/ or the DiggerQueue panel.
---

# Cuemark ↔ Digger Integration

Media library management lives in a **separate project** (`~/repos/digger`).
Cuemark does not embed a media browser — Digger owns that concern.

## What Digger provides

FastAPI REST at `http://localhost:8200` by default:

| Endpoint | Used for |
|---|---|
| `GET /queue/next` | Weighted-random track suggestion to push to the cuemark queue |
| `GET /search?q=` | Quick track search from the cuemark toolbar |
| `GET /tracks/{id}/cuemark` | Deck-ready payload: `filePath`, `cuePoint`, `hotCues[]` |
| `POST /tracks/{id}/markers` | Write cue/hot-cue positions back after editing in cuemark |
| `GET /queue/ws` | WebSocket — pushes `{"type": "queue_changed"}` after any queue mutation in Digger (add/remove/clear/consume/source-disable) |

The `/cuemark` payload maps directly to cuemark's `Deck` source interface:
```json
{ "filePath": "/media/charles/music/artist/track.mp4", "cuePoint": 4.2, "hotCues": [32.0, 128.5],
  "bpm": 123.4, "downbeat": 0.812 }
```
File preference in Digger: video > audio > any. Marker mapping: first `cue` → `cuePoint`, first 3
`hot_cue` → `hotCues[]`. `bpm`/`downbeat` round-trip the trusted beat grid (see cuemark's
`gridSource.ts` gotcha in the top-level `CLAUDE.md`).

**Gotcha — Digger omits unset `bpm`/`downbeat` instead of sending JSON `null`.** cuemark's
`CuemarkPayload` TS interface declares `bpm: number | null`, but that's just a type annotation —
if the FastAPI response body simply omits the key (e.g. a Pydantic model with
`exclude_none=True`), `payload.bpm` deserializes as JS `undefined`, not `null`. Every consumer in
cuemark (`DeckCard.svelte`, `gridSource.ts`, etc.) only ever guards `!== null` to match the `Deck`
type's `number | null` invariant — `undefined !== null` is `true`, so it slips straight through
every guard. Confirmed root cause of a live freeze (2026-07-06): `deck.bpm` ended up `undefined`,
and `DeckCard.svelte`'s `{deck.bpm.toFixed(1)}` threw, which aborted that Svelte effect-flush tick
before `App.svelte`'s `syncVideoElements` (and therefore `audioLoad`) or `WaveformCanvas`'s
`analyzeFile` ever ran — the deck showed its filename (state updated fine) but never got a video
frame, audio pipeline, or waveform, and the Rust log showed zero pipeline-construction lines
because the backend was never actually invoked. Fixed in `DiggerQueue.svelte`'s `loadToDeck` by
normalizing `payload.bpm ?? null` / `payload.downbeat ?? null` right at the API boundary, before
the value touches any `!== null` guard. **Any new consumer of Digger JSON should normalize
optional fields the same way at the point they enter cuemark** — don't trust the TS interface to
guarantee the runtime shape.

## Queue panel live updates

`DiggerQueue.svelte` opens once via `subscribeQueueChanges()` (`src/lib/digger/api.ts`) on mount
and refetches the queue on every `queue_changed` event — no polling. Reconnects with a fixed 3s
backoff if the socket drops (e.g. Digger restarts). Resubscribes if the user changes the Digger
base URL in settings. In dev, the `/digger-api` Vite proxy needs `ws: true` (set in
`vite.config.ts`) for the WebSocket upgrade to pass through alongside the existing REST proxying.

**Queue panel is shown by default**: `showDiggerQueue` in `App.svelte` defaults to `true` — the
queue is a primary workflow surface, not an opt-in panel. The main window width was bumped from
1280 to 1600 (`src-tauri/tauri.conf.json`) so decks aren't squeezed by the now-default-visible
sidebar.

## What cuemark owns

- Current play queue — ordered list of upcoming loads; may be populated from Digger or manually
- Session playback history — what has played this session (deck, title, artist, timestamp)
- Runtime cue/hot-cue state; persisting them across sessions = push back to Digger markers API

## Boundary rules

- Cuemark calls Digger; Digger never calls cuemark
- Graceful degradation: if Digger is unreachable, drag-and-drop and manual load still work
- No embedded file browser in cuemark
