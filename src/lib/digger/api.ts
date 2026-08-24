export interface DiggerTrack {
  id: number;
  title: string;
  artist: string;
  album: string | null;
  bpm: number | null;
  duration_ms: number | null;
  source: string;
  era: string;
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
  source: string;
  era: string;
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

export async function search(q: string, hasFile = true, limit = 50): Promise<DiggerTrack[]> {
  const params = new URLSearchParams({ q, has_file: String(hasFile), limit: String(limit) });
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

export async function pushMarker(
  trackId: number,
  positionMs: number,
  type: 'cue' | 'hot_cue' | 'downbeat' = 'cue',
  label?: string,
): Promise<void> {
  const r = await fetch(`${_baseUrl}/tracks/${trackId}/markers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ position_ms: positionMs, type, label: label ?? null }),
  });
  if (!r.ok) throw new Error(`push marker ${r.status}`);
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
