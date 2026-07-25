<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { get } from "svelte/store";
  import { session, addDeck, removeDeck, updateDeck, setMasterBpm, setMasterVolume, setCrossfader, setVisualization, setVisualizationOpacity, setSnapToBeat } from "./lib/state/session";
  import VisualizationPanel from "./components/VisualizationPanel.svelte";
  import { tapTempo } from "./lib/audio/bpm";
  import { startMidiListener } from "./lib/midi/handler";
  import { Compositor } from "./lib/renderer/compositor";
  import { invoke } from "@tauri-apps/api/core";
  import {
    audioLoad, audioUnload, audioPlay, audioPause,
    audioSeek, audioSetCue, audioSetMasterVolume, audioSetMainDevices,
    audioSetCueDevice, audioSetCueGain, gridGetSaved,
  } from "./lib/audio/pipeline";
  import { clearSavedGrid, markGridSaved, hasSavedGrid } from "./lib/audio/gridSource";
  import { syncRate, syncGain, syncVolume, clearDeckAudioSync, averageRateOverWindow } from "./lib/audio/audioSync";
  import { startSessionSync } from "./lib/state/sessionRecovery";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { listen } from "@tauri-apps/api/event";
  import { registerVideoEl, unregisterVideoEl, setDeckAudioTime, getDeckTime, getVideoEl, seekDeck, getPendingSeekTarget, clearPendingSeekTarget, isScratching } from "./lib/renderer/seekBus";
  import { postFrame } from "./lib/renderer/outputBus";
  import DeckCard from "./components/DeckCard.svelte";
  import Crossfader from "./components/Crossfader.svelte";
  import WaveformCanvas from "./components/WaveformCanvas.svelte";
  import AudioSettings from "./components/AudioSettings.svelte";
  import DiggerQueue from "./components/DiggerQueue.svelte";
  import { mainOutputDeviceIds, cueOutputDeviceId, cueGain } from "./lib/audio/audioSettings";
  import type { Deck, Session } from "./lib/state/types";
  import { audioGetPosition, sessionRestore } from "./lib/audio/pipeline";
  import { debugLog } from "./lib/debugLog";

  function openOutputWindow() {
    invoke('open_output_window').catch(console.error);
  }

  let midiUnlisten: (() => void) | undefined;
  let dragDropUnlisten: (() => void) | undefined;
  let eosUnlisten: (() => void) | undefined;
  let stopSessionSync: (() => void) | undefined;
  // Decks awaiting adoption after a recovery boot (freeze-watchdog.md phase 2): the
  // Rust pipeline survived the freeze/reload and is still playing, so syncVideoElements
  // must skip audioLoad() for these and just point the fresh <video> element at the
  // live position instead. Populated in onMount before the first session.set(restored),
  // consumed (and cleared per-deck) the first time syncVideoElements creates that
  // deck's video element.
  const pendingAdoption = new Map<string, { positionSecs: number; playing: boolean }>();
  let tapTimestamps: number[] = [];
  let tapResetTimer: ReturnType<typeof setTimeout> | undefined;
  let showAudioSettings = $state(false);
  let showDiggerQueue = $state(true);
  let showVisualizationPanel = $state(false);

  function handleTap() {
    const now = Date.now();
    tapTimestamps.push(now);
    clearTimeout(tapResetTimer);
    tapResetTimer = setTimeout(() => { tapTimestamps = []; }, 2000);
    const bpm = tapTempo(tapTimestamps);
    if (bpm !== null) setMasterBpm(bpm);
  }
  type BandAnalysis = { bass: number; mid: number; high: number };

  let canvas: HTMLCanvasElement;
  let compositor = $state<Compositor | undefined>(undefined);
  // Per-deck FFT analysis received from GStreamer spectrum bus messages via Tauri events.
  const deckAnalysis = new Map<string, BandAnalysis>();
  let fftUnlisten: (() => void) | undefined;
  // Hidden <video> elements keyed by deck id; lives outside Svelte reactivity
  const videoEls = new Map<string, HTMLVideoElement>();
  // Per-deck in-flight play() promises; prevents overlapping play() calls that abort each other
  const playPromises = new Map<string, Promise<void>>();
  let rafId: number;
  // One in-flight audioGetPosition IPC per deck. Prevents stale out-of-order responses
  // from snapping video.currentTime backward when GStreamer is mid-rate-change.
  const pendingPos = new Map<string, boolean>();
  // Per-deck state for content-position computation from GStreamer query_position.
  // query_position returns stream time based on segment.rate=1.0 (the soundtouch tempo
  // property doesn't issue a rate-seek, so the GStreamer segment rate never changes).
  // That means audioPos advances at 1× wall-clock regardless of deck.playbackRate.
  // We integrate per-frame deltas at deck.playbackRate to recover actual content position.
  // A delta >500ms between consecutive frames (impossible at any real playback rate) signals
  // a seek — after a seek, GStreamer immediately returns the seek target, which IS the correct
  // content position, so we use it directly as the new reference.
  // `tsMs` (performance.now() at the moment this entry was computed) lets the next resolution
  // ask audioSync.ts's rate-history log for the time-weighted average rate actually in effect
  // across the gap, instead of a single instantaneous snapshot (see averageRateOverWindow).
  const contentPosTracker = new Map<string, { audioPos: number; contentPos: number; tsMs: number }>();
  // Debug: rAF heartbeat, throttled to ~1/sec, so a live "chokes up" repro can be
  // read against Rust-side timestamps to tell a fully-frozen main thread (no
  // heartbeat lines during the stall) apart from an IPC round-trip that's merely
  // slow (heartbeat keeps ticking fine) — see debugLog.ts.
  let lastHeartbeatAt = 0;
  // Timestamp of the most recent frame() call, updated unconditionally every rAF tick
  // (unlike lastHeartbeatAt above, which is throttled). Read by the watchdog heartbeat
  // interval below to report rAF staleness to Rust — see docs/design/freeze-watchdog.md.
  let lastRafTickAt = performance.now();
  let watchdogIntervalId: ReturnType<typeof setInterval> | undefined;
  // Set by the __cuemarkDebug.killRafLoop() simulation hook; checked at the tail of
  // frame() where the loop reschedules itself (see docs/design/freeze-watchdog.md
  // "Debug/simulation hooks").
  let debugKillRafLoop = false;
  // Last playbackRate applied to each video element. Setting v.playbackRate triggers
  // WebKitGTK to rebuild its internal GStreamer pipeline; only update on actual change.
  const lastPlaybackRate = new Map<string, number>();
  // Last deck.playing value sent to the Rust audio pipeline. Tracked independently of
  // v.paused because WebKitGTK temporarily pauses the video element during its internal
  // pipeline rebuild (triggered by any v.playbackRate write). Without this, a play→pause
  // toggle arriving in that window finds v.paused=true, matches neither branch, and
  // audioPause is never called — leaving GStreamer playing with the deck appearing frozen.
  const lastAudioPlaying = new Map<string, boolean>();
  // Per-deck audio rate/gain/volume are synced via audioSync.ts (module-level Maps shared
  // with handler.ts). No per-component Maps needed here.
  // Last video.currentTime uploaded to each deck's FBO texture. uploadVideoFrame() does a
  // full-resolution drawImage + texImage2D — skip it when the frame hasn't advanced (paused)
  // to avoid burning CPU/GPU every RAF tick while idle. Still catches seeks made while paused
  // since currentTime changes even with playing=false.
  const lastUploadedTime = new Map<string, number>();
  // Mechanism-B self-heal (freeze-watchdog.md phase 4): WebKitGTK's <video> element can
  // silently stop advancing (readyState stuck < HAVE_FUTURE_DATA) while the separate
  // Rust/GStreamer audio pipeline keeps playing fine — see project_webkit_freeze_mechanisms
  // memory, "Mechanism B". Detected here, per-frame, inside frame() itself — never a store
  // $effect (an $effect only re-runs on store mutation, so it silently never fires during a
  // stall with no other UI activity; this is the same lesson the Eleventh-mechanism/
  // nearTrackEnd attempt paid for four times before being reverted, see that memory).
  // lastVideoCt/lastChangeMs track native v.currentTime (never the IPC-fed audio clock,
  // for the same "must be reliably fresh" reason documented elsewhere in this file);
  // refAudioPos snapshots the audio content position at the moment video last moved, so a
  // later stall check can ask "did audio advance since video stopped?" over exactly the
  // stalled span. lastAttemptMs bounds recovery to at most once per deck per 10s (design
  // doc: "if it recurs, it recurs" — no permanent give-up, unlike the watchdog's 3-strike rule).
  type StallWatch = { lastVideoCt: number; lastChangeMs: number; refAudioPos: number; lastAttemptMs: number };
  const stallWatch = new Map<string, StallWatch>();
  // Signature of the last composited frame's static inputs (deck id/source/opacity).
  // Used to skip the composite()+postFrame() GPU readback entirely when nothing visual
  // changed and nothing is animating — otherwise that full-resolution capture + cross-window
  // postMessage runs forever at 60fps even with zero decks loaded.
  let lastFrameSig = '';
  // WebKitGTK's GStreamer media backend can't resolve the custom media:// scheme for
  // <video> elements (confirmed: instant FormatError, no pipeline ever built). Production
  // serves video over a local-only HTTP server instead — same mechanism dev mode already
  // uses via the Vite middleware. Fetched once at startup; null until then.
  let mediaServerPort: number | null = null;

  // Sync master volume to Rust audio pipeline. Guard: $session is coarse-grained — ANY
  // mutation (MIDI rate/gain/volume events) re-runs this effect, so only call IPC on change.
  let _lastMasterVolume: number | undefined;
  $effect(() => {
    const vol = $session.masterVolume;
    if (vol !== _lastMasterVolume) {
      _lastMasterVolume = vol;
      audioSetMasterVolume(vol).catch(console.error);
    }
  });

  // Sync main output devices to Rust audio pipeline (runs on init with persisted value)
  $effect(() => {
    audioSetMainDevices($mainOutputDeviceIds).catch(console.error);
  });

  // Sync headphone output device to Rust audio pipeline
  $effect(() => {
    const deviceId = $cueOutputDeviceId;
    if (deviceId) audioSetCueDevice(deviceId).catch(console.error);
  });

  // Sync headphone cue gain to Rust audio pipeline
  $effect(() => {
    audioSetCueGain($cueGain).catch(console.error);
  });

  // Sync deck cueEnabled flags to Rust audio pipeline.
  // Guard against the coarse $session store: any MIDI update (crossfader,
  // volume, rate) re-triggers this effect even when cueEnabled is unchanged —
  // without the guard that floods IPC at MIDI event rates and stalls the UI.
  const _prevCueStates = new Map<string, boolean>();
  $effect(() => {
    for (const deck of $session.decks) {
      if (_prevCueStates.get(deck.id) !== deck.cueEnabled) {
        _prevCueStates.set(deck.id, deck.cueEnabled);
        audioSetCue(deck.id, deck.cueEnabled).catch(console.error);
      }
    }
  });

  // Sync per-deck audio rate/gain/volume via the shared audioSync module.
  // This $effect handles UI slider changes (store update → effect → IPC).
  // MIDI-sourced changes are handled DIRECTLY in handler.ts (no store involved);
  // the module-level Maps in audioSync.ts prevent duplicate IPC calls here.
  $effect(() => {
    for (const deck of $session.decks) {
      syncRate(deck.id, deck.playbackRate);
      syncGain(deck.id, deck.gain);
      syncVolume(deck.id, deck.volume);
    }
  });

  onMount(async () => {
    // Dev-only hook so headless WebDriver perf/UI tests can mutate session state
    // directly (load decks, toggle playback) without going through the native file
    // picker or OS drag-and-drop, neither of which WebDriver can reach. `vite build`
    // (used even for `cargo tauri build --debug`, the binary tauri-driver launches)
    // sets DEV=false regardless of Rust profile, so test runs must also pass
    // VITE_ENABLE_DEBUG_HOOK=1 to the build to get this — it is never present in a
    // normal production build the user runs for a live show.
    if (import.meta.env.DEV || import.meta.env.VITE_ENABLE_DEBUG_HOOK === '1') {
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
            await invoke<void>('audio_set_rate', { deckId, rate });
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
          invoke('midi_benchmark_save', { n }),

        // Fires `count` audio_set_rate calls fire-and-forget at `intervalMs` spacing,
        // matching the MIDI event rate a real tempo fader produces (~200 Hz at intervalMs=5).
        // Returns {fired, durationMs} after the last event fires.
        simulateMidiRateBurst: (deckId: string, count = 200, intervalMs = 5): Promise<{ fired: number; durationMs: number }> => {
          return new Promise((resolve) => {
            const rates = [0.9, 0.95, 1.0, 1.05, 1.1];
            const t0 = performance.now();
            let fired = 0;
            const id = setInterval(() => {
              invoke<void>('audio_set_rate', { deckId, rate: rates[fired % rates.length] }).catch(() => {});
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
        killRafLoop: () => {
          debugKillRafLoop = true;
        },

        // docs/design/webcodecs-video-path.md phase 1 in-app verification: demuxes
        // filePath via the Rust video_demux service, fetches the resulting AUs over
        // HTTP from the media server, and decodes them with WebCodecs VideoDecoder —
        // exercising the exact real-file codec-string derivation + real-AU decode path
        // the feasibility spike (scripts/probes/) only approximated with host-encoded
        // synthetic data. Debug/verification only — not used by the real playback path
        // (that's phase 2's codecPlayer.ts). Bounded to 60 frames so a long file's
        // whole demux isn't decoded here (video_demux_load itself demuxes the whole
        // file into memory regardless — this just limits the HTTP fetch + decode).
        //
        // Tries annexb (no `description`, raw byte-stream chunks) first — the mode the
        // spike documented as working — then falls back to avc (`description` built from
        // the SPS/PPS, chunks re-muxed to length-prefixed NALs with parameter sets
        // stripped). Found live 2026-07-25, re-verifying this phase: WebKitGTK 2.52.3's
        // *hardware* (`vah264dec`/VA-API) WebCodecs H.264 decode path unconditionally
        // requires avc+description — its internal harness always signals
        // `stream-format=avc` downstream regardless of how `configure()` was called, so
        // annexb-without-description decodes 0 frames (`h264parse`: "H.264 AVC caps, but
        // no codec_data" → "refused caps") and `flush()` rejects with "EncodingError:
        // Decode error". Confirmed the spike's own probe script reproduces the identical
        // failure today, and only matches its documented "60/60 decoded" result once
        // `vah264dec`/`vaapih264dec` are demoted to force software `avdec_h264` — so the
        // spike's recorded pass was (unknowingly) exercising software decode only, not
        // the hardware path this app's real env (main.rs) leaves enabled for H.264. See
        // the design doc's phase 1 results note and `skills/audio-debugging` for the
        // full writeup.
        probeWebCodecs: async (deckId: string, filePath: string) => {
          try {
            const demux = await invoke<{
              codec: string;
              codedWidth: number;
              codedHeight: number;
              fpsHint: number;
              auCount: number;
              keyframes: { auIndex: number; ptsUs: number }[];
              duration: number;
            }>('video_demux_load', { deckId, filePath });

            const port = await invoke<number>('media_server_port');
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
                  type: c.key ? 'key' : 'delta',
                  timestamp: c.ptsUs,
                  data: toChunkData(c.data),
                }));
              }
              await decoder.flush(); // rejects if any decode() call errored
              const decodeMs = +(performance.now() - t0).toFixed(1);
              decoder.close();
              return { frameCount, errors, decodeMs };
            };

            let mode: 'annexb' | 'avc';
            let result: { frameCount: number; errors: string[]; decodeMs: number };
            try {
              result = await runDecode({ codec: demux.codec }, (d) => d);
              mode = 'annexb';
            } catch {
              const firstNals = splitNals(chunks[0].data);
              const sps = firstNals.find((n) => n.type === 7);
              const pps = firstNals.find((n) => n.type === 8);
              if (!sps || !pps) throw new Error('avc fallback: no SPS/PPS in first AU to build description');
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
              mode = 'avc';
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
        },
      };
    }
    if (!import.meta.env.DEV) {
      mediaServerPort = await invoke<number>('media_server_port');
    }
    midiUnlisten = await startMidiListener();

    // Session-of-record rehydration (docs/design/freeze-watchdog.md phase 2), before any
    // other init that would otherwise construct decks from the default empty session.
    // A recovery boot is when BOTH a prior snapshot exists AND at least one live Rust
    // pipeline still reports a loaded file — a stale session-recovery.json from a
    // previous app run must not ghost-restore decks into a genuinely clean boot (the
    // AudioManager is fresh with zero pipelines in that case, so `audio` comes back
    // empty and this check correctly declines).
    let isRecoveryBoot = false;
    try {
      const recovery = await sessionRestore();
      isRecoveryBoot = !!recovery.snapshot && recovery.audio.some((a) => a.filePath);
      if (isRecoveryBoot) {
        const restored = recovery.snapshot as Session;
        debugLog(`[recovery] rehydrating session — ${recovery.audio.length} live pipeline(s)`);
        // The trust map that gates saved-grid vs. auto-fit precedence (gridSource.ts) is
        // a module-level Map that died with the old page — it's already empty after this
        // reload, but clear explicitly anyway per the design doc, defensively, in case a
        // future caller invokes this rehydration path without a full page reload. Without
        // it, this is exactly the stale-trust bug class fixed in 060de16.
        for (const deck of restored.decks) clearSavedGrid(deck.id);
        for (const status of recovery.audio) {
          if (status.filePath) {
            // Audio wins on disagreement (design doc "Session-of-record"): the pipeline's
            // playing state is ground truth, the JS snapshot can be up to ~1s stale.
            const deck = restored.decks.find((d) => d.id === status.deckId);
            if (deck) deck.playing = status.playing;
            pendingAdoption.set(status.deckId, {
              positionSecs: status.positionSecs ?? 0,
              playing: status.playing,
            });
          }
        }
        session.set(restored);
      }
    } catch (e) {
      console.error('[recovery] session_restore failed, starting fresh:', e);
    }

    if (!isRecoveryBoot) {
      // Restore last-seen MIDI control positions from the persist file.
      // This pre-populates faders/knobs so the software matches the controller on startup
      // without requiring the user to touch every control. Applied before any track loads
      // so the values are in the session when the first audioLoad pipeline is created.
      // Skipped on a recovery boot: the just-restored session snapshot already carries
      // the exact pre-freeze fader positions, which is strictly more accurate than this
      // separate per-control persist file (last-seen values, not necessarily in sync).
      try {
        const saved = await invoke<Record<string, number>>('midi_get_saved_state');
        const deckPatches = new Map<string, Record<string, number>>();
        for (const [key, value] of Object.entries(saved)) {
          if (key === 'crossfader') {
            setCrossfader(value);
          } else if (key === 'masterVolume') {
            setMasterVolume(value);
          } else if (key === 'cueGain') {
            cueGain.set(value);
          } else {
            const dot = key.indexOf('.');
            if (dot > 0) {
              const deckId = key.slice(0, dot);
              const field = key.slice(dot + 1);
              const patch = deckPatches.get(deckId) ?? {};
              (patch as Record<string, number>)[field] = value;
              deckPatches.set(deckId, patch);
            }
          }
        }
        for (const [deckId, patch] of deckPatches) {
          updateDeck(deckId, patch as Parameters<typeof updateDeck>[1]);
        }
      } catch (e) {
        console.warn('[midi-state] failed to restore saved state:', e);
      }
    }

    stopSessionSync = startSessionSync();

    // Freeze-watchdog heartbeat (docs/design/freeze-watchdog.md phase 1: observe + log
    // only, no recovery yet). Deliberately a setInterval, not tied to the rAF loop —
    // WebKitGTK throttles rAF for occluded/hidden windows, which would false-alarm the
    // Rust-side silence trigger. lastRafMs lets Rust tell "rAF loop died, timers alive"
    // apart from "whole main thread dead" (the heartbeat itself would stop in that case).
    watchdogIntervalId = setInterval(() => {
      const decks = get(session).decks.map((d) => {
        const v = videoEls.get(d.id);
        return { id: d.id, vct: v?.currentTime ?? null, ready: v?.readyState ?? null };
      });
      invoke('watchdog_heartbeat', {
        window: 'main',
        stats: { lastRafMs: Math.round(performance.now() - lastRafTickAt), decks },
      }).catch(() => {});
    }, 1000);

    compositor = new Compositor(canvas);
    let fftEventCount = 0;
    fftUnlisten = await listen<{ deckId: string; bass: number; mid: number; high: number }>(
      'audio-fft',
      (event) => {
        deckAnalysis.set(event.payload.deckId, event.payload);
        if (fftEventCount++ < 5) {
          console.log('[audio-fft]', event.payload);
        }
      },
    );
    rafId = requestAnimationFrame(frame);

    // When a deck reaches EOS, mark it stopped so syncVideoElements doesn't auto-restart it.
    eosUnlisten = await listen<string>('deck-eos', (event) => {
      updateDeck(event.payload, { playing: false });
    });

    // Tauri intercepts OS file-drop before it reaches the DOM, so DataTransfer is
    // empty in the HTML5 drop event. Use the Tauri webview API for actual paths.
    dragDropUnlisten = await getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type !== 'drop') return;
      const { paths, position } = event.payload;
      if (!paths.length) return;
      const el = document.elementFromPoint(position.x, position.y);
      const card = el?.closest<HTMLElement>('[data-deck-id]');
      if (card?.dataset.deckId) {
        updateDeck(card.dataset.deckId, {
          source: { type: 'video', filePath: paths[0], duration: 0 },
          playing: false,
        });
      }
    });
  });

  onDestroy(() => {
    midiUnlisten?.();
    dragDropUnlisten?.();
    eosUnlisten?.();
    stopSessionSync?.();
    clearInterval(watchdogIntervalId);
    cancelAnimationFrame(rafId);
    fftUnlisten?.();
    for (const [id, v] of videoEls) {
      v.pause();
      v.remove();
      unregisterVideoEl(id);
      audioUnload(id).catch(console.error);
    }
    videoEls.clear();
  });

  // Keep compositor FBOs and video elements in sync with the deck list.
  // syncVideoElements handles src changes, property sync, and play/pause.
  // rAF-throttled: rapid MIDI CC events (tempo fader at 14-bit = 200+/sec) are coalesced to
  // one syncVideoElements call per frame, preventing GStreamer from being overwhelmed with
  // rapid playbackRate changes that cause the pipeline to stall.
  let syncScheduled = false;
  $effect(() => {
    const decks = $session.decks; // read before early-return so Svelte always tracks it
    if (!compositor) return;
    compositor.syncDecks(decks.map((d) => d.id));
    if (!syncScheduled) {
      syncScheduled = true;
      requestAnimationFrame(() => {
        syncScheduled = false;
        syncVideoElements(get(session).decks);
      });
    }
  });

  function syncVideoElements(decks: Deck[]) {
    // Remove elements for decks that are gone or no longer have a video source
    for (const [id, v] of videoEls) {
      const deck = decks.find((d) => d.id === id);
      if (!deck || deck.source?.type !== "video") {
        v.pause();
        v.remove();
        unregisterVideoEl(id);
        videoEls.delete(id);
        audioUnload(id).catch(console.error);
        playPromises.delete(id);
        lastPlaybackRate.delete(id);
        lastAudioPlaying.delete(id);
        clearDeckAudioSync(id);
        contentPosTracker.delete(id);
        stallWatch.delete(id);
      }
    }

    for (const deck of decks) {
      if (deck.source?.type !== "video") continue;
      const filePath = deck.source.filePath;
      // Dev: serve via Vite's HTTP middleware (localhost:1420/media/<abs-path>).
      // Prod: serve via our own local HTTP server (see media_server.rs) — the custom
      // media:// scheme doesn't work reliably with WebKitGTK's GStreamer media backend.
      const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
      const src = import.meta.env.DEV
        ? '/media' + encodedPath
        : `http://127.0.0.1:${mediaServerPort}${encodedPath}`;

      let v = videoEls.get(deck.id);
      if (!v) {
        console.log(`[${deck.id}] creating video element`);
        v = document.createElement("video");
        v.style.cssText = "position:fixed;top:-9999px;width:1px;height:1px;pointer-events:none";
        v.muted = true; // audio is handled by Rust/GStreamer; video element is for decode only
        // Video is served cross-origin (http://127.0.0.1:<port> vs. tauri://localhost in prod).
        // Without this, drawImage/texImage2D reads in fbo.ts taint the canvas with a
        // SecurityError, silently killing the compositor's render loop after one frame.
        v.crossOrigin = "anonymous";
        document.body.appendChild(v);
        registerVideoEl(deck.id, v);
        videoEls.set(deck.id, v);
        // audioLoad is called in the src-change block below (always runs for a new element)
      }

      // Update event handlers each sync so they capture the current filePath / deckId
      const deckId = deck.id;
      v.onloadedmetadata = () => {
        console.log(`[${deckId}] loadedmetadata fired, duration:`, v!.duration);
        const s = get(session).decks.find((d) => d.id === deckId)?.source;
        // v.duration is Infinity for non-fast-start MP4s (moov atom at the end of the
        // file) until enough of the file has streamed — Infinity is truthy in JS, so
        // storing it here would permanently block the audioLoad duration fallback below
        // (`!s.duration` never matches Infinity) and pins the waveform playhead at x=0
        // forever (currentTime / Infinity = 0). Only accept a real, finite duration.
        if (s?.type === "video" && s.filePath === filePath && Number.isFinite(v!.duration)) {
          updateDeck(deckId, { source: { type: "video", filePath, duration: v!.duration } });
        }
      };
      // Retry play if the user clicked play before the video had loaded enough data
      v.oncanplay = () => {
        console.log(`[${deckId}] canplay fired`);
        const d = get(session).decks.find((d) => d.id === deckId);
        if (d?.playing && v!.paused) v!.play().catch(console.error);
      };
      v.onerror = () => console.error(`[${deckId}] video error: code=${v!.error?.code} message=${v!.error?.message} src=${v!.src}`);
      v.onstalled = () => console.warn(`[${deckId}] stalled (networkState=${v!.networkState})`);
      v.onended = () => updateDeck(deckId, { playing: false });

      if (v.getAttribute('src') !== src) {
        console.log(`[${deck.id}] setting src:`, src);
        v.src = src;
        v.load();
        if (!hasSavedGrid(deck.id, filePath)) {
          // The trust map is write-only (markGridSaved never gets an automatic clear) —
          // if we don't invalidate it here, loading track A (saved grid) then track B
          // (no saved grid) then track A again would find the map still saying "deck-0
          // is trusted for A" from the first load, skip this lookup, and leave A's
          // bpm/downbeat frozen at whatever B's auto-fit last wrote. Confirmed live via
          // /run: reloading A after visiting B silently inherited B's grid.
          clearSavedGrid(deck.id);
          // Race-free vs. the auto-fit in the WaveformCanvas onAnalyzed callback below:
          // this lookup's updateDeck is UNCONDITIONAL (always wins, whenever it resolves,
          // even overwriting an auto-fit that already landed), while the auto-fit's
          // updateDeck is CONDITIONAL on hasSavedGrid(deckId, filePath) still being false.
          // So the final state is always the saved grid when one exists, regardless of
          // which async call resolves first. Skipped entirely when Digger already supplied
          // a trusted grid for this exact file (see DiggerQueue.svelte's loadToDeck).
          gridGetSaved(filePath).then((saved) => {
            const s = get(session).decks.find((d) => d.id === deckId)?.source;
            if (saved && s?.type === 'video' && s.filePath === filePath) {
              updateDeck(deckId, { bpm: saved.bpm, downbeat: saved.downbeat });
              markGridSaved(deckId, filePath);
            }
          }).catch(console.error);
        }
        const adopted = pendingAdoption.get(deck.id);
        if (adopted) {
          pendingAdoption.delete(deck.id);
          // Recovery adoption (freeze-watchdog.md phase 2): this deck's Rust/GStreamer
          // pipeline survived the freeze/reload and may already be playing — calling
          // audioLoad() here would tear it down and reload from scratch, audibly
          // glitching the one thing this feature must never do (see the "Adoption bugs"
          // risk in the design doc, and the matching assertion log in audio_load).
          // The fresh <video> element still needs its own normal decode-only load
          // (v.src / v.load() above already did that); just point its clock at the live
          // audio position once metadata is available, and let the play/pause branch
          // below start it if the pipeline was playing.
          v.addEventListener('loadedmetadata', () => {
            v!.currentTime = adopted.positionSecs;
          }, { once: true });
          lastAudioPlaying.set(deck.id, adopted.playing);
          debugLog(`[recovery] adopted ${deck.id} at ${adopted.positionSecs.toFixed(2)}s playing=${adopted.playing}`);
        } else {
          // The <video> element's loadedmetadata never fires when WebKitGTK lacks a decoder
          // for the file's video codec (e.g. AV1/H264) — but the audio-only GStreamer pipeline
          // still decodes fine and knows the real duration. Use it as a fallback so the
          // waveform isn't stuck waiting on a duration that will never arrive from the video
          // element. Don't clobber a duration loadedmetadata already supplied.
          audioLoad(deck.id, filePath).then((duration) => {
            // A new DeckAudioPipeline is created with default gain/rate/volume=1.0.
            // Re-apply current session values so saved MIDI state (or UI slider changes
            // made before this track was loaded) take effect on the fresh pipeline.
            const d = get(session).decks.find((d) => d.id === deckId);
            if (d) {
              clearDeckAudioSync(deckId);
              syncGain(deckId, d.gain);
              syncRate(deckId, d.playbackRate);
              syncVolume(deckId, d.volume);
            }
            const s = get(session).decks.find((d) => d.id === deckId)?.source;
            if (duration && s?.type === "video" && s.filePath === filePath && (!s.duration || !Number.isFinite(s.duration))) {
              updateDeck(deckId, { source: { type: "video", filePath, duration } });
            }
          }).catch(console.error);
          // Reset audio state tracker so the next sync re-applies play/pause to the new pipeline.
          lastAudioPlaying.delete(deck.id);
        }
        // New track loads to position 0 (or, on recovery adoption, the live audio
        // position handled above); either way reset the content-position integrator so
        // it reinitializes cleanly from the first position poll.
        contentPosTracker.delete(deck.id);
        // Same reason: a new track's fresh <video> element hasn't stalled yet — carrying
        // over the old track's stall-tracking state could either false-trigger (stale
        // refAudioPos far behind the new track's position) or block a real detection
        // for up to 10s (stale lastAttemptMs cooldown).
        stallWatch.delete(deck.id);
        // Report state after a short delay so we can see if the network request started
        setTimeout(() => {
          console.log(`[${deck.id}] state@500ms: readyState=${v!.readyState} networkState=${v!.networkState} error=${v!.error?.code ?? 'none'} src=${v!.src}`);
        }, 500);
      }

      // Custom loop: when loopIn/loopOut are set and loop is on, seek back manually
      // rather than relying on native video loop (which loops the whole file).
      if (deck.loop && deck.loopIn !== null && deck.loopOut !== null) {
        const loopIn = deck.loopIn;
        const loopOut = deck.loopOut;
        const deckId = deck.id;
        v.loop = false;
        v.ontimeupdate = () => {
          if (v!.currentTime >= loopOut) {
            v!.currentTime = loopIn;
            audioSeek(deckId, loopIn).catch(console.error);
          }
        };
      } else {
        v.loop = deck.loop;
        v.ontimeupdate = null;
      }

      // v.volume=0 survives WebKitGTK pipeline rebuilds (it's a JS property, not pipeline state).
      // v.muted=true is belt-and-suspenders but can be lost on playbackRate-triggered rebuilds.
      // Both together ensure no audio bleed even during the brief rebuild window.
      v.volume = 0;
      v.muted = true;
      // Only update playbackRate when it changes meaningfully: setting v.playbackRate causes
      // WebKitGTK to rebuild its internal GStreamer pipeline, causing CPU spikes and PipeWire
      // xruns when called at rAF rate. Use a 0.5% tolerance to absorb the tiny oscillation
      // between 14-bit fader MSB (CC 8) and LSB (CC 40) arriving in adjacent rAF frames —
      // each pair would otherwise trigger two rebuilds per fader position.
      const targetRate = Math.max(0.0625, deck.playbackRate);
      const lastRate = lastPlaybackRate.get(deck.id) ?? -1;
      if (Math.abs(targetRate - lastRate) > 0.005) {
        lastPlaybackRate.set(deck.id, targetRate);
        v.playbackRate = targetRate;
        v.volume = 0;
        v.muted = true;
      }
      // Video element: sync play/pause based on element state.
      if (deck.playing && v.paused && !playPromises.has(deck.id)) {
        const p = v.play().catch((e) => {
          if (e.name !== 'AbortError') console.error(e);
        }).finally(() => playPromises.delete(deck.id)) as Promise<void>;
        playPromises.set(deck.id, p);
      } else if (!deck.playing && !v.paused) {
        playPromises.delete(deck.id); // pending play() will abort; that's intentional
        v.pause();
      }

      // Audio pipeline: driven by deck.playing intent, independent of video element state.
      // WebKitGTK temporarily pauses the video element on any v.playbackRate write (it rebuilds
      // its internal pipeline). A play→pause toggle arriving in that window finds v.paused=true,
      // making both branches above no-ops. Tracking audio state separately ensures audioPause
      // always fires when deck.playing flips to false, regardless of the video element state.
      const wasAudioPlaying = lastAudioPlaying.get(deck.id);
      if (deck.playing !== wasAudioPlaying) {
        lastAudioPlaying.set(deck.id, deck.playing);
        if (deck.playing) {
          audioPlay(deck.id).catch(console.error);
        } else {
          audioPause(deck.id).catch(console.error);
        }
      }
    }
  }

  // RAF render loop: upload video frames → composite; sync video to audio clock
  function frame() {
    const nowMs = performance.now();
    lastRafTickAt = nowMs;
    if (nowMs - lastHeartbeatAt > 1000) {
      lastHeartbeatAt = nowMs;
      debugLog(`[heartbeat] rAF alive`);
    }
    try {
    if (compositor) {
      const { decks, visualization, visualizationOpacity } = get(session);
      const timeSecs = performance.now() / 1000;
      // Combine per-deck FFT data from GStreamer spectrum events: max across all playing decks.
      let bass = 0, mid = 0, high = 0;
      for (const a of deckAnalysis.values()) {
        bass = Math.max(bass, a.bass);
        mid = Math.max(mid, a.mid);
        high = Math.max(high, a.high);
      }
      const analysis: BandAnalysis = { bass, mid, high };
      // Any shader deck (continuous u_time animation) or a video frame that actually
      // advanced/seeked this tick makes the composited output stale.
      let dirty = false;
      for (const deck of decks) {
        if (deck.source?.type === 'video') {
          const v = videoEls.get(deck.id);
          const fbo = compositor.getFBO(deck.id);
          if (v && fbo && v.currentTime !== lastUploadedTime.get(deck.id)) {
            lastUploadedTime.set(deck.id, v.currentTime);
            fbo.uploadVideoFrame(v);
            dirty = true;
          }
          // Mechanism-B self-heal (freeze-watchdog.md phase 4) — see stallWatch comment above.
          if (v) {
            const deckId = deck.id;
            let st = stallWatch.get(deckId);
            if (!st) {
              st = { lastVideoCt: v.currentTime, lastChangeMs: nowMs, refAudioPos: getDeckTime(deckId) ?? 0, lastAttemptMs: 0 };
              stallWatch.set(deckId, st);
            }
            if (v.currentTime !== st.lastVideoCt) {
              st.lastVideoCt = v.currentTime;
              st.lastChangeMs = nowMs;
              st.refAudioPos = getDeckTime(deckId) ?? st.refAudioPos;
            }
            const stalledMs = nowMs - st.lastChangeMs;
            if (
              deck.playing && !v.paused && !v.ended && v.readyState < 3 &&
              stalledMs > 2000 && nowMs - st.lastAttemptMs > 10000
            ) {
              const curAudioPos = getDeckTime(deckId);
              // "Audio kept advancing while video didn't" over the exact stalled span —
              // the design doc's condition that distinguishes a real WebKit stall from a
              // legitimate pause/paused-deck/end-of-track state (already excluded above).
              if (curAudioPos !== null && curAudioPos - st.refAudioPos > 0.05) {
                st.lastAttemptMs = nowMs;
                st.lastChangeMs = nowMs; // restart the clock; don't re-trigger before canplay lands
                const target = curAudioPos;
                const rate = lastPlaybackRate.get(deckId) ?? 1.0;
                debugLog(`[self-heal] ${deckId} <video> stalled ${(stalledMs / 1000).toFixed(1)}s ` +
                  `while audio advanced ${(curAudioPos - st.refAudioPos).toFixed(2)}s — resetting element to ${target.toFixed(2)}s`);
                // Guard via playPromises (same map syncVideoElements checks before calling
                // v.play() itself) so its play/pause branch doesn't race a v.play() call
                // against the recovery sequence below while v.load() is still settling.
                // Safety-valve timeout: if canplay never fires (decoder wedged even after
                // load()), release the guard anyway rather than permanently blocking normal
                // play/pause sync for this deck.
                const releaseGuard = () => playPromises.delete(deckId);
                const guardTimeout = setTimeout(releaseGuard, 5000);
                playPromises.set(deckId, new Promise<void>((resolve) => {
                  v.addEventListener('canplay', () => {
                    clearTimeout(guardTimeout);
                    v.currentTime = target;
                    v.volume = 0;
                    v.muted = true;
                    v.playbackRate = rate;
                    lastPlaybackRate.set(deckId, rate);
                    // Rate-then-seek ordering doesn't apply here (load() built a fresh
                    // pipeline, no in-flight rebuild) but keep the 200ms settle delay
                    // anyway — cheap insurance per the design doc.
                    setTimeout(() => {
                      v.play().catch((e) => { if (e.name !== 'AbortError') console.error(e); })
                        .finally(() => { releaseGuard(); resolve(); });
                    }, 200);
                  }, { once: true });
                  v.load(); // full element reset — discards WebKit's wedged internal pipeline
                }));
              }
            }
          }
          // Audio is the master clock. One in-flight IPC per deck prevents stale
          // out-of-order responses from snapping currentTime backward mid-rate-change.
          // Also polls while scratching: scratch runs entirely with deck.playing=false
          // (see jog_nudge in handler.ts), so without this branch the pipeline's audio
          // position moves correctly but the UI (timestamp, waveform playhead) sits
          // frozen at wherever it was when the gesture started.
          const scratching = isScratching(deck.id);
          if ((deck.playing || scratching) && v && !pendingPos.get(deck.id)) {
            pendingPos.set(deck.id, true);
            const capturedDeckId = deck.id;
            const pollStartMs = performance.now();
            audioGetPosition(deck.id).then((audioPos) => {
              pendingPos.delete(capturedDeckId);
              const pollMs = performance.now() - pollStartMs;
              if (pollMs > 300) debugLog(`[position-poll] ${capturedDeckId} took ${pollMs.toFixed(0)}ms, audioPos=${audioPos}`);
              if (audioPos === null || !v) return;
              const nowMs = performance.now();
              let contentPos: number;
              if (scratching) {
                // During scratch, position() (Rust side) returns the feeder's live
                // PCM-buffer cursor directly — already true content position. Scratch
                // bypasses the pitch/tempo element entirely (speed comes from how fast
                // the feeder walks the buffer), so none of the wall-clock/rate
                // integration below applies here.
                contentPos = audioPos;
              } else {
                // Recover content position from wall-clock audioPos (see contentPosTracker comment).
                const prev = contentPosTracker.get(capturedDeckId);
                if (prev && Math.abs(audioPos - prev.audioPos) < 0.5) {
                  // Use the time-weighted average rate actually in effect across
                  // [prev.tsMs, nowMs], not just the rate at resolution time. During
                  // active tempo/pitch adjustment the rate can change several times within
                  // one poll's round trip (~140-190ms, see IPC latency baseline); applying
                  // only the latest snapshot to the whole span systematically overshoots
                  // contentPos while the rate is climbing (and undershoots while falling) —
                  // this is what made the waveform/video position drift ahead of the audio
                  // whenever tempo/pitch was actively being adjusted.
                  const currentRate = get(session).decks.find(d => d.id === capturedDeckId)?.playbackRate ?? 1.0;
                  const rate = averageRateOverWindow(capturedDeckId, prev.tsMs, nowMs, currentRate);
                  contentPos = prev.contentPos + (audioPos - prev.audioPos) * rate;
                } else {
                  contentPos = audioPos; // large jump = seek; audioPos IS correct content pos post-seek
                }
                // Filter out stale pre-seek IPC responses. On a heavy video, GStreamer
                // can take >1s to complete a seek, returning the pre-seek position the
                // whole time. If a seek is pending and contentPos is far from the seek
                // target, this IPC was in flight before the seek took effect — skip it.
                const seekTarget = getPendingSeekTarget(capturedDeckId);
                if (seekTarget !== undefined) {
                  if (Math.abs(contentPos - seekTarget) > 0.5) return; // stale
                  clearPendingSeekTarget(capturedDeckId); // seek complete
                }
              }
              contentPosTracker.set(capturedDeckId, { audioPos, contentPos, tsMs: nowMs });
              setDeckAudioTime(capturedDeckId, contentPos); // feeds waveform playhead — cheap, no WebKit cost
              // No v.currentTime writes at all during scratch — see the scratch-freeze
              // investigation in docs/design/pcm-buffer-playback.md, 2026-07-23. A 150ms
              // throttle (tried first) didn't help and measurably made a live-hardware
              // freeze worse (4.4s -> 12.3s), and debug instrumentation (rAF heartbeat +
              // idle-timer arm/fire timing) then proved the WebKit JS main thread itself
              // was frozen solid for ~7s after a gesture ended, with Rust completely idle
              // throughout and no single v.currentTime write ever measured >5ms — i.e. not
              // a slow synchronous write, but WebKit's own internal (non-Rust) video decode
              // pipeline blocking its main loop, apparently regardless of write frequency.
              // Video doesn't need frame-accurate tracking during a fast jog — audio (the
              // real cueing signal) is already exact via the independent PCM feeder — so
              // don't touch the video element's clock at all until scratch ends; the
              // non-scratch branch below then does one normal snap to resync it.
              //
              // Threshold widened 80ms -> 250ms (2026-07-24): this write is a <video> seek,
              // i.e. exactly the gst_element_send_event() call a live gdb backtrace caught
              // WebKitGTK's own main thread deadlocked inside (see "Ninth mechanism",
              // docs/design/pcm-buffer-playback.md) — a real bug in WebKitGTK's
              // MediaPlayerPrivateGStreamer, not something fixable on the cuemark/Rust side.
              // This resync fires on every position-poll resolution for as long as any deck
              // plays at a non-1.0 rate (not just during scratch), so it's the most frequent
              // source of these seeks. Widening the tolerance is a mitigation, not a fix —
              // it cuts how often the deadlock's trigger condition (a seek landing while the
              // video pipeline is mid-flight) can occur. 250ms of AV drift is imperceptible
              // for VJ visuals synced by eye to a beat, unlike e.g. lip-synced dialogue.
              if (!scratching && Math.abs(v.currentTime - contentPos) > 0.25) {
                v.currentTime = contentPos; // snap video to audio clock
              }
            }).catch(() => { pendingPos.delete(capturedDeckId); });
          }
        }
      }
      // Global visualization layer — rendered separately from decks and composited above
      // them, so picking a visualization never interrupts deck audio/video. It animates
      // continuously (u_time), same as a per-deck shader used to, so it always marks the
      // frame dirty.
      if (visualization) {
        dirty = true;
        compositor.renderVisualization(visualization.fragmentSrc, visualization.uniforms, timeSecs, analysis);
      }
      // Catch changes that don't come from per-frame video/visualization advancement:
      // opacity (crossfader), source swaps, deck add/remove, visualization toggle.
      const sig = `${visualization ? visualizationOpacity : 0}|` +
        decks.map((d) => `${d.id}:${d.source?.type}:${d.opacity}`).join('|');
      if (sig !== lastFrameSig) {
        lastFrameSig = sig;
        dirty = true;
      }
      if (dirty) {
        compositor.composite(decks, visualization ? visualizationOpacity : 0);
        postFrame(canvas);
      }
    }
    } catch (e) {
      // An uncaught throw here previously killed the rAF loop forever (this line never
      // reschedules) while GStreamer's independent audio pipeline kept playing — total,
      // permanent UI freeze with music still going and zero trace in the log (only
      // debugLog() reaches the Rust-side log file; console.error doesn't). See the
      // 2026-07-24 investigation in docs/design/pcm-buffer-playback.md. Log and keep the
      // loop alive instead of vanishing silently.
      debugLog(`[frame-error] ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    }
    // Deliberately outside the try/catch above (which exists precisely to keep the loop
    // alive through errors) — killRafLoop() needs to actually kill it, simulating
    // mechanism B for watchdog-test.sh: rAF dies, setInterval-based heartbeat keeps
    // ticking, so lastRafMs in the heartbeat stats grows while `stats` itself keeps arriving.
    if (debugKillRafLoop) {
      debugLog('[debug] killRafLoop: rAF loop intentionally terminated');
      throw new Error('killRafLoop debug hook: rAF loop intentionally terminated');
    }
    rafId = requestAnimationFrame(frame);
  }
</script>

<div class="app">
  <header class="toolbar">
    <span class="logo">CUEMARK</span>
    <button class="add-deck" onclick={addDeck}>+ Deck</button>
    <button class="output-btn" onclick={openOutputWindow}>Output Window</button>
    <button
      class="output-btn"
      class:active={showAudioSettings}
      onclick={() => { showAudioSettings = !showAudioSettings; }}
    >Settings</button>
    <button
      class="output-btn"
      class:active={showDiggerQueue}
      onclick={() => { showDiggerQueue = !showDiggerQueue; }}
    >Queue</button>
    <button
      class="output-btn"
      class:active={showVisualizationPanel}
      onclick={() => { showVisualizationPanel = !showVisualizationPanel; }}
    >Visualization</button>
    <button
      class="output-btn"
      class:active={$session.snapToBeat}
      onclick={() => setSnapToBeat(!$session.snapToBeat)}
      title="Snap seeks, hot cues, and loop points to the nearest beat"
    >SNAP</button>
    <span class="bpm">{$session.bpm !== null ? `${$session.bpm.toFixed(1)} BPM` : "—"}</span>
    <button class="tap-btn" onclick={handleTap}>TAP</button>
    {#if $session.bpm !== null}
      <button class="tap-reset" onclick={() => { setMasterBpm(null); tapTimestamps = []; }}>✕</button>
    {/if}
    <label class="master-vol">
      Main Volume
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={$session.masterVolume}
        oninput={(e) =>
          session.update((s) => ({ ...s, masterVolume: +e.currentTarget.value }))}
      />
      <span>{$session.masterVolume.toFixed(2)}</span>
    </label>
  </header>

  <!-- Compositor renders here; hidden from control window — visible only in Output Window -->
  <canvas bind:this={canvas} width={1920} height={1080} style="display:none"></canvas>

  <div class="main-layout">
    <div class="main-content">
      {#if showAudioSettings}
        <AudioSettings />
      {/if}

      {#if showVisualizationPanel}
        <VisualizationPanel />
      {/if}

      <div class="waveform-stack">
        {#each $session.decks as deck (deck.id)}
          <div class="waveform-row">
            <span class="waveform-label">{deck.id}</span>
            <!-- downbeat defaults to track start (0) on every auto-fit load — extrapolating
                 the grid from t=0 rather than the comb-fit's arbitrary beat phase (also
                 clears a stale downbeat carried over from the previous track). This is
                 intentionally a guess: SET BEAT in DeckCard is the manual override, and
                 only a manual SET BEAT persists locally / pushes to Digger. -->
            <WaveformCanvas {deck} onAnalyzed={({ bpm }) => {
              // A saved grid (sidecar or Digger) always wins over the auto-fit — see the
              // race-ordering comment at the gridGetSaved() call site above.
              if (deck.source?.type === 'video' && !hasSavedGrid(deck.id, deck.source.filePath)) {
                updateDeck(deck.id, { bpm, downbeat: 0 });
              }
            }} />
          </div>
        {/each}
      </div>

      <div class="decks" style="--deck-count: {$session.decks.length}">
        {#each $session.decks as deck (deck.id)}
          <DeckCard {deck} />
        {/each}
      </div>

      <Crossfader
        mapping={$session.crossfaderMapping}
        decks={$session.decks}
        crossfaderValue={$session.crossfaderValue}
        crossfaderTargets={$session.crossfaderTargets}
        audioCurve={$session.audioCurve}
        visualCurve={$session.visualCurve}
      />
    </div>

    {#if showDiggerQueue}
      <aside class="queue-sidebar">
        <DiggerQueue />
      </aside>
    {/if}
  </div>
</div>
