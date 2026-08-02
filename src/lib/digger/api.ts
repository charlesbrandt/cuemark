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
  downbeat: number | null;
}

const STORAGE_KEY = 'cuemark:diggerBaseUrl';

// Load persisted URL; fall back to Vite proxy path for dev if nothing stored.
let _baseUrl: string = (() => {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? '/digger-api';
  } catch {
    return '/digger-api';
  }
})();

export function setDiggerBaseUrl(url: string) {
  _baseUrl = url.replace(/\/$/, '');
  try { localStorage.setItem(STORAGE_KEY, _baseUrl); } catch {}
}

export function getDiggerBaseUrl(): string {
  return _baseUrl;
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

export async function randomTrack(hasFile = true): Promise<DiggerTrack> {
  const params = new URLSearchParams({ has_file: String(hasFile) });
  const r = await fetch(`${_baseUrl}/random?${params}`);
  if (!r.ok) throw new Error(`random ${r.status}`);
  return r.json();
}

export async function getQueue(): Promise<DiggerQueueItem[]> {
  const r = await fetch(`${_baseUrl}/queue`);
  if (!r.ok) throw new Error(`queue ${r.status}`);
  return r.json();
}

export async function addToQueue(trackId: number): Promise<void> {
  const r = await fetch(`${_baseUrl}/queue/tracks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ track_id: trackId }),
  });
  if (!r.ok) throw new Error(`queue/add ${r.status}`);
}

export async function removeFromQueue(itemId: number): Promise<void> {
  const r = await fetch(`${_baseUrl}/queue/${itemId}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(`queue/remove ${r.status}`);
}

export async function queueNext(): Promise<DiggerTrack> {
  const r = await fetch(`${_baseUrl}/queue/next`);
  if (!r.ok) throw new Error(`queue/next ${r.status}`);
  return r.json();
}

export async function getCuemarkPayload(trackId: number): Promise<CuemarkPayload> {
  const r = await fetch(`${_baseUrl}/tracks/${trackId}/cuemark`);
  if (!r.ok) throw new Error(`cuemark ${r.status}`);
  return r.json();
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
