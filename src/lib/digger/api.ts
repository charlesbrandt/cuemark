export interface DiggerTrack {
  id: number;
  title: string;
  artist: string;
  album: string | null;
  bpm: number | null;
  duration_ms: number | null;
  source: string;
  era: string;
  // Per-DJ favorite (Digger's track_likes table, added 2026-09-05) — scoped to
  // whichever `dj` was passed to search()/getQueue(), same identity as the DJ
  // selector's currentDjOrNull(). See docs/design/per-dj-favorites.md in the
  // digger repo and the digger-integration skill's "Liked (star)" pointer.
  is_liked: boolean;
}

export interface DiggerQueueItem {
  id: number;        // queue entry id (used for DELETE /queue/{id})
  track_id: number;
  position: number;
  added_at: string;
  title: string;
  artist: string;
  album: string | null;
  bpm: number | null;
  duration_ms: number | null;
  source: string;
  era: string;
  // Scoped to the same `owner` this queue was fetched for — see DiggerTrack.is_liked above.
  is_liked: boolean;
}

export interface CuemarkPayload {
  filePath: string;
  fileId: number | null;
  cuePoint: number | null;
  hotCues: number[];
  bpm: number | null;
  bpmSource: string | null;        // 'detected' | 'manual' | 'imported' | null
  downbeat: number | null;
  // Precision provenance for bpm/downbeat — see docs/design/beatmatching.md
  // "Root cause #2". 'comb-v1' means Digger ran the same comb-fit algorithm
  // cuemark's own bpm.ts uses (ported to Python); anything else is a coarse
  // librosa-only estimate that's a hint, not a trusted grid.
  beatGridAlgo: string | null;
  beatGridConfidence: number | null;
  gain: number | null;
  // Automix transition zones — two [start, end] pairs, all four auto-derived by Digger's
  // analyze_audio.py (`_derive_mix_points`) or manually set there via the markers API, and
  // all four returned by GET /tracks/{id}/cuemark. They feed Deck.mixInStart/mixInEnd/
  // mixOutStart/mixOutEnd respectively.
  //
  // ⚠️ The wire names are deliberately NOT the storage names. Digger stores these as the
  // marker types `mix_in_start`/`mix_in_end`/`mix_out_start`/`mix_out_end` (renamed from
  // `mix_in`/`mix_out` on 2026-09-20), but the payload keeps `mixIn`/`mixOut` for the two
  // starts so an un-updated cuemark build keeps working against an updated Digger. The
  // payload is a separate contract from the storage vocabulary — that is what made the
  // rename affordable. See docs/design/mix-zones.md §1.
  //
  // ⚠️ `mixIn` is auto-derived as `beat_times[0]`, the first tracked beat — i.e. "the
  // beginning of the song", not "the end of the intro". It is a usable START POSITION and
  // it is NOT an intro length; the length is `mixInEnd − mixIn`. Deriving a mix-in worth
  // having is docs/design/mix-zones.md §2.
  mixIn: number | null;
  mixInEnd: number | null;
  mixOut: number | null;
  mixOutEnd: number | null;
}

/** A cached decode from Digger's waveform_cache table (see beat-grid-precision.md) —
 * the same peaks(30/s)/envelope(210/s) arrays cuemark's own Rust decoder would
 * produce, letting cuemark skip that decode for a Digger-loaded track. */
export interface WaveformCache {
  peaks: Float32Array;
  envelope: Float32Array;
  durationS: number;
}

const STORAGE_KEY = 'cuemark:diggerBaseUrl';
const HISTORY_KEY = 'cuemark:diggerBaseUrlHistory';
const HISTORY_MAX = 5;

// Load persisted URL; fall back to Vite proxy path for dev if nothing stored.
let _baseUrl: string = (() => {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? '/digger-api';
  } catch {
    return '/digger-api';
  }
})();

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function setDiggerBaseUrl(url: string) {
  _baseUrl = url.replace(/\/$/, '');
  try {
    localStorage.setItem(STORAGE_KEY, _baseUrl);
    // MRU list, deduped, most-recent first — lets the settings panel offer
    // one-click reconnect to any endpoint typed in previously (e.g. a
    // Tailscale address), not just the two named presets.
    const history = [_baseUrl, ...loadHistory().filter((u) => u !== _baseUrl)].slice(0, HISTORY_MAX);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {}
}

export function getDiggerBaseUrl(): string {
  return _baseUrl;
}

// MRU list of previously-used base URLs (most recent first), for a "recent
// endpoints" quick-pick in the settings UI.
export function getDiggerBaseUrlHistory(): string[] {
  return loadHistory();
}

// Digger's docker-compose runs the API on :8200 and the Svelte UI on :5173
// (see ~/repos/digger/docker-compose.yml). The proxy path used in dev
// (`/digger-api`, see vite.config.ts) targets the API on localhost:8200,
// so map that case to the UI port directly rather than trying to resolve
// the proxy target at runtime.
export function getDiggerWebUrl(): string {
  if (_baseUrl === '/digger-api') return 'http://localhost:5173';
  try {
    const url = new URL(_baseUrl);
    url.port = '5173';
    return url.origin;
  } catch {
    return 'http://localhost:5173';
  }
}

// Absolute URL for Digger's GET /files/{id} (Range-capable raw file stream) — the
// media_cache.rs remote-fetch fallback for when a deck's local mount doesn't have the
// file (see docs/design/offline-crate.md in the digger repo). Only meaningful for the
// separate Rust process making its own outbound request, so returns undefined when
// `_baseUrl` is the dev-mode Vite proxy path (`/digger-api`) — that's relative and
// browser-only, not reachable from Rust. Every other call in this file goes through
// fetch() and can ride that proxy just fine; this is the one exception.
export function getDiggerFileUrl(fileId: number): string | undefined {
  if (!_baseUrl.startsWith('http')) return undefined;
  return `${_baseUrl}/files/${fileId}`;
}

export async function search(q: string, hasFile = true, limit = 50, dj: string | null = null): Promise<DiggerTrack[]> {
  const params = new URLSearchParams({ q, has_file: String(hasFile), limit: String(limit) });
  if (dj) params.set('dj_name', dj);
  const r = await fetch(`${_baseUrl}/search?${params}`);
  if (!r.ok) throw new Error(`search ${r.status}`);
  return r.json();
}

// `owner` throughout this section is Digger's queue-scoping param (see
// docs/design/guest-djs.md "Changes, by side → Cuemark" item 3, in the digger
// repo) — null/omitted means the owner's (Charles's) queue, matching
// `queue_items.owner`'s NULL convention. Callers should pass the DJ selector's
// value through `currentDjOrNull()` (src/lib/digger/djSelector.ts), never the
// raw store value, so an empty string never reaches Digger as a distinct
// query param from "omitted".

export async function getQueue(owner: string | null = null): Promise<DiggerQueueItem[]> {
  const params = new URLSearchParams();
  if (owner) params.set('owner', owner);
  const qs = params.toString();
  const r = await fetch(`${_baseUrl}/queue${qs ? `?${qs}` : ''}`);
  if (!r.ok) throw new Error(`queue ${r.status}`);
  return r.json();
}

export async function addToQueue(trackId: number, owner: string | null = null): Promise<void> {
  const r = await fetch(`${_baseUrl}/queue/tracks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ track_id: trackId, owner }),
  });
  if (!r.ok) throw new Error(`queue/add ${r.status}`);
}

export async function removeFromQueue(itemId: number, owner: string | null = null): Promise<void> {
  const params = new URLSearchParams();
  if (owner) params.set('owner', owner);
  const qs = params.toString();
  const r = await fetch(`${_baseUrl}/queue/${itemId}${qs ? `?${qs}` : ''}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(`queue/remove ${r.status}`);
}

export async function queueNext(owner: string | null = null): Promise<DiggerTrack> {
  const params = new URLSearchParams();
  if (owner) params.set('owner', owner);
  const qs = params.toString();
  const r = await fetch(`${_baseUrl}/queue/next${qs ? `?${qs}` : ''}`);
  if (!r.ok) throw new Error(`queue/next ${r.status}`);
  return r.json();
}

export async function getCuemarkPayload(trackId: number): Promise<CuemarkPayload> {
  const r = await fetch(`${_baseUrl}/tracks/${trackId}/cuemark`);
  if (!r.ok) throw new Error(`cuemark ${r.status}`);
  return r.json();
}

// Rates are a fixed cross-repo contract, not sent per-request — see
// src-tauri/src/audio/analysis.rs / src/lib/audio/waveform.ts / Digger's
// importers/analyze_audio.py, all of which must agree on 30/210.
const WAVEFORM_HEADER_BYTES = 8; // two little-endian u32s: peaksCount, envelopeCount

/**
 * Fetches Digger's pre-decoded peaks/envelope for a track, if cached — see
 * docs/design/beatmatching.md "Root cause #2" / GET /tracks/{id}/waveform's own
 * docstring in the Digger repo for the binary layout. Returns null on a 404 (not
 * cached yet) so callers can fall back to a local decode without treating "not
 * cached" as an error.
 */
export async function getWaveformCache(trackId: number): Promise<WaveformCache | null> {
  const r = await fetch(`${_baseUrl}/tracks/${trackId}/waveform`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`waveform ${r.status}`);
  const buf = await r.arrayBuffer();
  const header = new DataView(buf, 0, WAVEFORM_HEADER_BYTES);
  const peaksCount = header.getUint32(0, true);
  const envelopeCount = header.getUint32(4, true);
  const peaksStart = WAVEFORM_HEADER_BYTES;
  const envelopeStart = peaksStart + peaksCount * 4;
  const peaks = new Float32Array(buf.slice(peaksStart, envelopeStart));
  const envelope = new Float32Array(buf.slice(envelopeStart, envelopeStart + envelopeCount * 4));
  const durationS = Number(r.headers.get('X-Duration-Seconds') ?? 'NaN');
  return { peaks, envelope, durationS };
}

// Pushes from Digger's /queue/ws so the panel updates when the queue changes from
// elsewhere (Digger's own UI, another client) — avoids polling. Reconnects with a
// fixed 3s backoff if the socket drops (e.g. Digger restarts).
export function subscribeQueueChanges(onChange: () => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  function wsUrl(): string {
    if (_baseUrl.startsWith('/')) {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      return `${proto}://${location.host}${_baseUrl}/queue/ws`;
    }
    return `${_baseUrl.replace(/^http/, 'ws')}/queue/ws`;
  }

  function connect() {
    if (closed) return;
    ws = new WebSocket(wsUrl());
    ws.onmessage = (e) => {
      try {
        if (JSON.parse(e.data)?.type === 'queue_changed') onChange();
      } catch {}
    };
    ws.onclose = () => {
      if (!closed) retryTimer = setTimeout(connect, 3000);
    };
    ws.onerror = () => ws?.close();
  }
  connect();

  return () => {
    closed = true;
    clearTimeout(retryTimer);
    ws?.close();
  };
}

export type MarkerType = 'cue' | 'hot_cue' | 'downbeat' | MixMarkerType;

export interface DiggerMarker {
  id: number;
  track_id: number;
  position_ms: number;
  type: string;
  label: string | null;
  color: string | null;
  /** 'detected' (analyze_audio.py) or 'manual' (anything created through the API,
   *  including cuemark). Digger's cuemark payload does NOT rank by this — see
   *  `setMixMarker` below for why that matters. */
  source: string | null;
}

export async function pushMarker(
  trackId: number,
  positionMs: number,
  type: MarkerType = 'cue',
  label?: string,
): Promise<void> {
  const r = await fetch(`${_baseUrl}/tracks/${trackId}/markers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ position_ms: positionMs, type, label: label ?? null }),
  });
  if (!r.ok) throw new Error(`push marker ${r.status}`);
}

/** Full marker rows (with ids) for a track — `GET /tracks/{id}`'s `markers` array. The
 *  `/cuemark` payload deliberately flattens these to positions, so this is the only way
 *  to get an id to DELETE or PATCH. */
export async function getTrackMarkers(trackId: number): Promise<DiggerMarker[]> {
  const r = await fetch(`${_baseUrl}/tracks/${trackId}`);
  if (!r.ok) throw new Error(`track ${r.status}`);
  const track = await r.json();
  return (track.markers ?? []) as DiggerMarker[];
}

export async function deleteMarker(markerId: number): Promise<void> {
  const r = await fetch(`${_baseUrl}/markers/${markerId}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(`delete marker ${r.status}`);
}

/** The four mix-zone marker types, as Digger stores them since 2026-09-20. Each zone says
 *  which end it is, so no value can be read as a length by one consumer and a position by
 *  another — the exact defect this vocabulary replaced. See docs/design/mix-zones.md §1. */
export type MixMarkerType = 'mix_in_start' | 'mix_in_end' | 'mix_out_start' | 'mix_out_end';

const MIX_MARKER_LABEL: Record<MixMarkerType, string> = {
  mix_in_start: 'Mix in',
  mix_in_end: 'Mix in end',
  mix_out_start: 'Mix out',
  mix_out_end: 'Mix out end',
};

/**
 * Replace one of a track's four mix-zone markers — **delete-then-insert, not append**.
 *
 * ⚠️ This is load-bearing, and it is the reason a manual "set the outro here" control was
 * declined in phase 4 (see docs/design/auto-dj-transitions.md). Digger's
 * `_build_cuemark_payload()` resolves each mix marker by taking the **first marker of that
 * type ordered by `position_ms`** — not the most recent, and not `source='manual'` first,
 * the way it does for `downbeat`. So simply POSTing a manual marker later in the track
 * than the auto-derived 'detected' one silently loses to it, forever, with no error.
 * Clearing every existing marker of the type first leaves exactly one row, which makes
 * "first by position" unambiguous whatever cuemark writes.
 *
 * Note this is *within* Digger's existing API — no schema change, no endpoint change, and
 * no dependence on Digger's resolution rule being fixed later (if it ever is, this still
 * behaves identically). Re-running `analyze_audio.py` will NOT clobber what this writes:
 * `_upsert_mix_marker` backs off entirely for a type that has any non-'detected' row, and
 * every cuemark POST lands as `source='manual'`. The one residual is that a *cleared*
 * marker is re-derived on the next analysis run — moved is durable, cleared is not.
 */
export async function setMixMarker(
  trackId: number,
  type: MixMarkerType,
  positionSec: number,
): Promise<void> {
  await clearMixMarker(trackId, type);
  await pushMarker(trackId, Math.round(positionSec * 1000), type, MIX_MARKER_LABEL[type]);
}

/** Removes every marker of this type from the track (usually one 'detected' row, plus a
 *  'manual' one if cuemark has already overridden it). Leaves the track with no mix point
 *  of that type at all, which cuemark reads as "no marker" for that end of the zone. */
export async function clearMixMarker(trackId: number, type: MixMarkerType): Promise<void> {
  const markers = await getTrackMarkers(trackId);
  for (const m of markers) {
    if (m.type === type) await deleteMarker(m.id);
  }
}

export async function setTrackBpm(trackId: number, bpm: number): Promise<void> {
  const r = await fetch(`${_baseUrl}/tracks/${trackId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bpm }),
  });
  if (!r.ok) throw new Error(`set bpm ${r.status}`);
}

export async function setTrackGain(trackId: number, gain: number): Promise<void> {
  const r = await fetch(`${_baseUrl}/tracks/${trackId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gain }),
  });
  if (!r.ok) throw new Error(`set gain ${r.status}`);
}

// Toggles a per-DJ favorite in Digger's `track_likes` table (added 2026-09-05,
// docs/design/per-dj-favorites.md in the digger repo) — no longer the shared
// global `tracks.is_liked` flag. `djName` should be djSelector.ts's
// `currentDjOrNull($currentDj)`, the same identity used for queue scoping.
export async function setTrackLiked(trackId: number, liked: boolean, djName: string | null = null): Promise<void> {
  const url = new URL(`${_baseUrl}/tracks/${trackId}/like`);
  if (!liked && djName) url.searchParams.set('dj_name', djName);
  const r = await fetch(url, {
    method: liked ? 'POST' : 'DELETE',
    headers: liked ? { 'Content-Type': 'application/json' } : undefined,
    body: liked ? JSON.stringify({ dj_name: djName }) : undefined,
  });
  if (!r.ok) throw new Error(`set liked ${r.status}`);
}

// Session/play-history reporting — Digger's own `plays` table doubles as cuemark's
// set log (docs/design/play-tracking.md "Cuemark: standardize on the same log" in
// the digger repo): insert-on-start, ~30s heartbeats, finalize on track-end. No
// separate "Sessions" concept needed on either side.
// `listener` = the DJ selector's value at the moment the play started, already
// resolved through `currentDjOrNull()` by the caller — see history.ts, which
// captures it once at load time (not read reactively) so a mid-track DJ
// handoff can't retroactively reassign a play already in progress.
export async function playStart(trackId: number, sourceRef: string, listener: string | null = null): Promise<number> {
  const r = await fetch(`${_baseUrl}/plays/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ track_id: trackId, context: 'cuemark', source_ref: sourceRef, listener }),
  });
  if (!r.ok) throw new Error(`plays/start ${r.status}`);
  const { id } = await r.json();
  return id;
}

export async function playHeartbeat(playId: number, durationMs: number): Promise<void> {
  const r = await fetch(`${_baseUrl}/plays/${playId}/heartbeat`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ duration_ms: durationMs }),
  });
  if (!r.ok) throw new Error(`plays/heartbeat ${r.status}`);
}

export async function playFinish(playId: number, durationMs: number): Promise<void> {
  const r = await fetch(`${_baseUrl}/plays/${playId}/finish`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ duration_ms: durationMs }),
  });
  if (!r.ok) throw new Error(`plays/finish ${r.status}`);
}
