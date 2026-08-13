/**
 * `window.__cuemarkDebug` — the dev/test-only hook the headless WebDriver scripts drive the
 * app through (scripts/perf-idle-test.sh, latency-test.sh, rehydration-test.sh,
 * watchdog-test.sh). Extracted from App.svelte's onMount unchanged.
 *
 * `vite build` (used even for `cargo tauri build --debug`, the binary tauri-driver
 * launches) sets DEV=false regardless of Rust profile, so test runs must also pass
 * VITE_ENABLE_DEBUG_HOOK=1 to the build to get this — it is never present in a normal
 * production build the user runs for a live show.
 */
import { get } from "svelte/store";
import { invoke } from "@tauri-apps/api/core";
import { session, updateDeck, addDeck, removeDeck, setVisualization, setVisualizationOpacity } from "../state/session";
import { getVideoEl, getDeckTime, seekDeck, getCodecPlayer } from "../renderer/seekBus";
import { setVideoPathOverride } from "../video/videoPathSettings";
import { getBackendState } from "../video/backendRegistry";
import { getLegacyVideoOpCounts, hasLegacyVideoEl } from "../video/legacyVideo";
import { debugLog } from "../debugLog";

export interface DebugHookContext {
  /** Kills the rAF loop (checked at the tail of App.svelte's frame()). */
  killRafLoop: () => void;
}

export function installDebugHook(ctx: DebugHookContext): void {
  if (!(import.meta.env.DEV || import.meta.env.VITE_ENABLE_DEBUG_HOOK === "1")) return;

  (window as unknown as Record<string, unknown>).__cuemarkDebug = {
    updateDeck,
    addDeck,
    removeDeck,
    setVisualization,
    setVisualizationOpacity,
    getSession: () => get(session),

    // Returns the video element's currentTime for a deck (null if no element yet).
    // Used by latency-test.sh to verify video is actually advancing during playback.
    getVideoTime: (deckId: string) => getVideoEl(deckId)?.currentTime ?? null,

    // Phase 3 verification (docs/design/webcodecs-video-path.md): per-deck counts of
    // every <video>-element currentTime/playbackRate write and play()/pause() call
    // this session, plus whether a <video> element is currently registered for the
    // deck at all. A webcodecs-backend deck should show all-zero counts and
    // hasVideoEl=false for its entire lifetime — see legacyVideo.ts.
    getLegacyVideoOpCounts: (deckId: string) => ({
      ...getLegacyVideoOpCounts(deckId),
      hasVideoEl: hasLegacyVideoEl(deckId),
    }),

    // Phase 2 verification: live per-deck A/B override, same call the DeckCard toggle
    // button makes — lets a headless test force legacy/webcodecs without clicking.
    setVideoPathOverride,

    // Phase 2 verification: which video backend a deck actually resolved to
    // ('legacy' | 'pending' | 'webcodecs' | 'legacy-fallback' | null if no source).
    getVideoBackend: (deckId: string) => getBackendState(deckId)?.kind ?? null,

    // Phase 2 verification: the pts (seconds) of the codec player's currently-selected
    // frame for a deck, or null if the deck isn't on the codec path / has no frame yet.
    // Used to confirm a codec-path deck stays in sync with a legacy-path deck playing
    // the same file (compare against getAudioTime, which both paths share).
    getCodecFramePts: (deckId: string) => {
      const player = getCodecPlayer(deckId);
      const t = getDeckTime(deckId);
      if (!player || t === null) return null;
      const frame = player.getFrameForTime(t);
      return frame ? frame.timestamp / 1_000_000 : null;
    },

    // Returns the waveform's clock for a deck — the content-time position from the
    // audioTimes registry (set each frame from GStreamer position, rate-corrected).
    // Should match getVideoTime closely (both track content position, not wall-clock).
    getAudioTime: (deckId: string) => getDeckTime(deckId),

    // Seeks a deck to the given time (seconds). Clears audioTimes so getDeckTime
    // falls back to v.currentTime while the GStreamer IPC settles post-seek.
    seek: (deckId: string, time: number) => seekDeck(deckId, time),

    // Times sequential audio_set_rate IPC round-trips.
    // Returns {min, p50, p99, max, mean} in milliseconds.
    measureAudioIpc: async (deckId: string, rate: number, reps = 20) => {
      const timings: number[] = [];
      for (let i = 0; i < reps; i++) {
        const t0 = performance.now();
        await invoke<void>("audio_set_rate", { deckId, rate });
        timings.push(performance.now() - t0);
      }
      timings.sort((a, b) => a - b);
      const fmt = (n: number) => +n.toFixed(2);
      return {
        min: fmt(timings[0]),
        p50: fmt(timings[Math.floor(reps * 0.5)]),
        p99: fmt(timings[Math.floor(reps * 0.99)]),
        max: fmt(timings[reps - 1]),
        mean: fmt(timings.reduce((a, b) => a + b, 0) / reps),
      };
    },

    // Runs `n` MIDI state file writes through the Rust path and returns timing stats.
    // Used by latency-test.sh step 9 to measure Rust-side I/O latency.
    benchmarkMidiSave: (n = 100): Promise<Record<string, number>> =>
      invoke("midi_benchmark_save", { n }),

    // Fires `count` audio_set_rate calls fire-and-forget at `intervalMs` spacing,
    // matching the MIDI event rate a real tempo fader produces (~200 Hz at intervalMs=5).
    // Returns {fired, durationMs} after the last event fires.
    simulateMidiRateBurst: (deckId: string, count = 200, intervalMs = 5): Promise<{ fired: number; durationMs: number }> => {
      return new Promise((resolve) => {
        const rates = [0.9, 0.95, 1.0, 1.05, 1.1];
        const t0 = performance.now();
        let fired = 0;
        const id = setInterval(() => {
          invoke<void>("audio_set_rate", { deckId, rate: rates[fired % rates.length] }).catch(() => {});
          fired++;
          if (fired >= count) {
            clearInterval(id);
            resolve({ fired, durationMs: +(performance.now() - t0).toFixed(1) });
          }
        }, intervalMs);
      });
    },

    // Freeze-watchdog simulation hooks (docs/design/freeze-watchdog.md). Synchronous
    // busy-loop blocking the whole JS main thread — timers, rAF, and the watchdog
    // heartbeat interval itself all stop, simulating mechanism A. ms=0 blocks forever
    // (the only variant that truly exercises tiers 2-3 once recovery is armed; a
    // finite freeze lets a queued eval-based tier-1 recovery run as soon as it ends).
    freezeMainThread: (ms = 0) => {
      const start = performance.now();
      const end = ms > 0 ? start + ms : Infinity;
      debugLog(`[debug] freezeMainThread(${ms}) starting busy-loop`);
      while (performance.now() < end) { /* intentional spin */ }
      debugLog(`[debug] freezeMainThread(${ms}) finished busy-loop`);
    },

    // Kills the rAF loop (checked at the tail of frame()) while leaving setInterval
    // timers — including the watchdog heartbeat — alive. Simulates mechanism B /
    // "JS exception killed the loop" for exercising tier-1 recovery + lastRafMs.
    killRafLoop: ctx.killRafLoop,

    probeWebCodecs,
  };
}

/**
 * docs/design/webcodecs-video-path.md phase 1 in-app verification: demuxes filePath via
 * the Rust video_demux service, fetches the resulting AUs over HTTP from the media server,
 * and decodes them with WebCodecs VideoDecoder — exercising the exact real-file
 * codec-string derivation + real-AU decode path the feasibility spike (scripts/probes/)
 * only approximated with host-encoded synthetic data. Debug/verification only — not used
 * by the real playback path (that's phase 2's codecPlayer.ts). Bounded to 60 frames so a
 * long file's whole demux isn't decoded here (video_demux_load itself demuxes the whole
 * file into memory regardless — this just limits the HTTP fetch + decode).
 *
 * Tries annexb (no `description`, raw byte-stream chunks) first — the mode the spike
 * documented as working — then falls back to avc (`description` built from the SPS/PPS,
 * chunks re-muxed to length-prefixed NALs with parameter sets stripped). Found live
 * 2026-07-25, re-verifying this phase: WebKitGTK 2.52.3's *hardware* (`vah264dec`/VA-API)
 * WebCodecs H.264 decode path unconditionally requires avc+description — its internal
 * harness always signals `stream-format=avc` downstream regardless of how `configure()`
 * was called, so annexb-without-description decodes 0 frames (`h264parse`: "H.264 AVC
 * caps, but no codec_data" → "refused caps") and `flush()` rejects with "EncodingError:
 * Decode error". Confirmed the spike's own probe script reproduces the identical failure
 * today, and only matches its documented "60/60 decoded" result once `vah264dec`/
 * `vaapih264dec` are demoted to force software `avdec_h264` — so the spike's recorded pass
 * was (unknowingly) exercising software decode only, not the hardware path this app's real
 * env (main.rs) leaves enabled for H.264. See the design doc's phase 1 results note and
 * `skills/audio-debugging` for the full writeup.
 */
async function probeWebCodecs(deckId: string, filePath: string) {
  try {
    const demux = await invoke<{
      codec: string;
      codedWidth: number;
      codedHeight: number;
      fpsHint: number;
      auCount: number;
      keyframes: { auIndex: number; ptsUs: number }[];
      duration: number;
    }>("video_demux_load", { deckId, filePath });

    const port = await invoke<number>("media_server_port");
    const auLimit = Math.min(demux.auCount, 60);
    const res = await fetch(
      `http://127.0.0.1:${port}/demux/${encodeURIComponent(deckId)}/aus?from=0&count=${auLimit}`,
    );
    if (!res.ok) throw new Error(`AU fetch failed: ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // Per-AU framing (media_server.rs's /demux/<deck>/aus route):
    // [u32 le length][u8 flags(bit0=key)][i64 le pts_us][i64 le dur_us][data…]
    const chunks: { key: boolean; ptsUs: number; data: Uint8Array }[] = [];
    let off = 0;
    while (off + 21 <= bytes.length) {
      const len = view.getUint32(off, true); off += 4;
      const flags = view.getUint8(off); off += 1;
      const ptsUs = Number(view.getBigInt64(off, true)); off += 8;
      off += 8; // dur_us — not needed for this probe
      const data = bytes.slice(off, off + len); off += len;
      chunks.push({ key: (flags & 1) !== 0, ptsUs, data });
    }

    // --- Annex-B NAL splitting, used by both the annexb attempt (to check for
    // an SPS/PPS at all) and the avc fallback (to build description + rewrite
    // each chunk to length-prefixed form). Trims the zero_byte padding Annex-B
    // allows before a start code — spec-mandated, not a heuristic.
    const splitNals = (data: Uint8Array): { type: number; bytes: Uint8Array }[] => {
      const starts: number[] = [];
      for (let i = 0; i + 2 < data.length; i++) {
        if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) starts.push(i + 3);
      }
      const nals: { type: number; bytes: Uint8Array }[] = [];
      for (let k = 0; k < starts.length; k++) {
        const start = starts[k];
        let end = k + 1 < starts.length ? starts[k + 1] - 3 : data.length;
        while (end > start && data[end - 1] === 0) end--;
        if (end > start) nals.push({ type: data[start] & 0x1f, bytes: data.slice(start, end) });
      }
      return nals;
    };

    const runDecode = async (
      config: VideoDecoderConfig,
      toChunkData: (data: Uint8Array) => Uint8Array,
    ) => {
      const errors: string[] = [];
      let frameCount = 0;
      const decoder = new VideoDecoder({
        output: (frame) => { frameCount++; frame.close(); },
        error: (e) => errors.push(String(e)),
      });
      decoder.configure(config);
      const t0 = performance.now();
      for (const c of chunks) {
        decoder.decode(new EncodedVideoChunk({
          type: c.key ? "key" : "delta",
          timestamp: c.ptsUs,
          data: toChunkData(c.data),
        }));
      }
      await decoder.flush(); // rejects if any decode() call errored
      const decodeMs = +(performance.now() - t0).toFixed(1);
      decoder.close();
      return { frameCount, errors, decodeMs };
    };

    let mode: "annexb" | "avc";
    let result: { frameCount: number; errors: string[]; decodeMs: number };
    try {
      result = await runDecode({ codec: demux.codec }, (d) => d);
      mode = "annexb";
    } catch {
      const firstNals = splitNals(chunks[0].data);
      const sps = firstNals.find((n) => n.type === 7);
      const pps = firstNals.find((n) => n.type === 8);
      if (!sps || !pps) throw new Error("avc fallback: no SPS/PPS in first AU to build description");
      const description = new Uint8Array(11 + sps.bytes.length + pps.bytes.length);
      let o = 0;
      description[o++] = 1; // configurationVersion
      description[o++] = sps.bytes[1]; // AVCProfileIndication
      description[o++] = sps.bytes[2]; // profile_compatibility
      description[o++] = sps.bytes[3]; // AVCLevelIndication
      description[o++] = 0xff; // reserved(6)=111111 | lengthSizeMinusOne=3 (4-byte length prefix)
      description[o++] = 0xe1; // reserved(3)=111 | numOfSequenceParameterSets=1
      description[o++] = (sps.bytes.length >> 8) & 0xff; description[o++] = sps.bytes.length & 0xff;
      description.set(sps.bytes, o); o += sps.bytes.length;
      description[o++] = 1; // numOfPictureParameterSets
      description[o++] = (pps.bytes.length >> 8) & 0xff; description[o++] = pps.bytes.length & 0xff;
      description.set(pps.bytes, o);

      const toAvc = (data: Uint8Array) => {
        const slices = splitNals(data).filter((n) => n.type === 1 || n.type === 5);
        const out = new Uint8Array(slices.reduce((n, s) => n + 4 + s.bytes.length, 0));
        let p = 0;
        for (const s of slices) {
          const len = s.bytes.length;
          out[p++] = (len >>> 24) & 0xff; out[p++] = (len >>> 16) & 0xff;
          out[p++] = (len >>> 8) & 0xff; out[p++] = len & 0xff;
          out.set(s.bytes, p); p += len;
        }
        return out;
      };
      result = await runDecode({ codec: demux.codec, description }, toAvc);
      mode = "avc";
    }

    return {
      codec: demux.codec,
      mode,
      frameCount: result.frameCount,
      errors: result.errors,
      decodeMs: result.decodeMs,
      codedWidth: demux.codedWidth,
      codedHeight: demux.codedHeight,
    };
  } catch (e) {
    return { error: String(e instanceof Error ? (e.stack ?? e.message) : e) };
  }
}
