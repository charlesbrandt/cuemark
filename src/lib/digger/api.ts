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
  source: string;
  era: string;
}

export interface CuemarkPayload {
  filePath: string;
  cuePoint: number | null;
  hotCues: number[];
}

// In dev: requests proxy through Vite to http://localhost:8200 (bypasses CORS).
// In production: set a full URL via setDiggerBaseUrl() from app settings.
let _baseUrl = '/digger-api';

export function setDiggerBaseUrl(url: string) {
  _baseUrl = url.replace(/\/$/, '');
}

export function getDiggerBaseUrl(): string {
  return _baseUrl;
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

export async function pushMarker(
  trackId: number,
  positionMs: number,
  type: 'cue' | 'hot_cue' = 'cue',
  label?: string,
): Promise<void> {
  const r = await fetch(`${_baseUrl}/tracks/${trackId}/markers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ position_ms: positionMs, type, label: label ?? null }),
  });
  if (!r.ok) throw new Error(`push marker ${r.status}`);
}
