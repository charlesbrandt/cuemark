// IndexedDB wrapper around api.ts's getWaveformCache() — see docs/design/
// queue-prefetch-cache.md §4 ("Piggybacking the waveform cache"). This lane is
// deliberately separate from media_cache.rs: it's browser-only data (peaks/envelope
// feed WaveformCanvas.svelte and detectBeatGrid(), nothing in Rust ever reads it),
// two to three orders of magnitude smaller than the media cache, and has no
// cap/eviction machinery — see the design doc for why none of that is worth building
// at this scale.
import { getWaveformCache, type WaveformCache } from './api';

const DB_NAME = 'cuemark-waveform-cache';
const STORE_NAME = 'waveforms';
const DB_VERSION = 1;

// librosa.load(..., duration=600) caps Digger's analysis at 10 minutes (see
// importers/analyze_audio.py) — must match WaveformCanvas.svelte's own constant.
// A cached entry landing at this duration is a truncated analysis, not a real
// waveform, and must never be served as if it were valid forever: a later
// re-analysis without the cap should win, so this rejection has to travel with
// the cache, not just the live fetch.
const DIGGER_ANALYSIS_CAP_S = 600;

// Digger's `/tracks/{id}/waveform` doesn't expose `updated_at` yet (design doc §4,
// open decision #8) — once it adds an `X-Updated-At` header, swap this TTL for an
// exact check against a stored `updatedAt` instead of a wall-clock guess.
const TTL_MS = 24 * 60 * 60 * 1000;

interface StoredEntry {
  trackId: number;
  peaks: ArrayBuffer;
  envelope: ArrayBuffer;
  durationS: number;
  cachedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'trackId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readEntry(trackId: number): Promise<StoredEntry | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(trackId);
      req.onsuccess = () => resolve((req.result as StoredEntry | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Private-browsing quota block, blocked origin, etc. — degrade to "no local
    // cache," same convention as this codebase's localStorage call sites.
    return null;
  }
}

async function writeEntry(entry: StoredEntry): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Fire-and-forget write; a failure here just means the next load re-fetches.
  }
}

/**
 * Drop-in replacement for api.ts's getWaveformCache() that checks a local
 * IndexedDB cache first. Same return shape (null = not cached on Digger, fall
 * back to a local decode). Never throws on a storage failure — falls through
 * to the network call, same as api.ts's own function does.
 */
export async function getCachedWaveform(trackId: number): Promise<WaveformCache | null> {
  const stored = await readEntry(trackId);
  if (stored) {
    const expired = Date.now() - stored.cachedAt > TTL_MS;
    const capped = Math.abs(stored.durationS - DIGGER_ANALYSIS_CAP_S) <= 1;
    if (!expired && !capped) {
      return {
        peaks: new Float32Array(stored.peaks),
        envelope: new Float32Array(stored.envelope),
        durationS: stored.durationS,
      };
    }
  }

  const fresh = await getWaveformCache(trackId);
  if (fresh) {
    void writeEntry({
      trackId,
      peaks: fresh.peaks.buffer as ArrayBuffer,
      envelope: fresh.envelope.buffer as ArrayBuffer,
      durationS: fresh.durationS,
      cachedAt: Date.now(),
    });
  }
  return fresh;
}

/** Feeds the Storage settings tab's waveform-lane usage line — see the design
 * doc §7 ("Storage UI"): a separate, much smaller number from the media cache's,
 * not folded into its total. */
export async function waveformCacheStats(): Promise<{ bytes: number; tracks: number }> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).openCursor();
      let bytes = 0;
      let tracks = 0;
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const entry = cursor.value as StoredEntry;
          // +32 bytes/entry as a rough estimate of the keyPath/durationS/cachedAt
          // overhead alongside the two big buffers — not meant to be exact.
          bytes += entry.peaks.byteLength + entry.envelope.byteLength + 32;
          tracks += 1;
          cursor.continue();
        } else {
          resolve({ bytes, tracks });
        }
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return { bytes: 0, tracks: 0 };
  }
}
