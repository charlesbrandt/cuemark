<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { get } from "svelte/store";
  import { session, addDeck, updateDeck, setMasterBpm, setSnapToBeat } from "./lib/state/session";
  import VisualizationPanel from "./components/VisualizationPanel.svelte";
  import { tapTempo } from "./lib/audio/bpm";
  import { startMidiListener } from "./lib/midi/handler";
  import { invoke } from "@tauri-apps/api/core";
  import {
    audioLoad, audioUnload, audioSetCue, audioSetMasterVolume, audioSetMainDevices,
    audioSetCueDevice, audioSetCueGain, gridGetSaved, setOutputLatency,
  } from "./lib/audio/pipeline";
  import { clearSavedGrid, markGridSaved, hasSavedGrid } from "./lib/audio/gridSource";
  import { setDeckOnsets } from "./lib/audio/onsetStore";
  import { syncRate, syncGain, syncVolume, clearDeckAudioSync } from "./lib/audio/audioSync";
  import { startSessionSync } from "./lib/state/sessionRecovery";
  import { restoreSessionOnBoot, restoreMidiControlState, hasPendingAdoption, takePendingAdoption } from "./lib/state/bootRestore";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { listen } from "@tauri-apps/api/event";
  import { getDeckTime, isScratching, registerCodecPlayer, unregisterCodecPlayer, getCodecPlayer, codecPlayerDeckIds } from "./lib/renderer/seekBus";
  import { postFrame, takeResendRequest, releaseDeck, type DeckFrameSource } from "./lib/renderer/outputBus";
  import DeckCard from "./components/DeckCard.svelte";
  import Crossfader from "./components/Crossfader.svelte";
  import WaveformCanvas from "./components/WaveformCanvas.svelte";
  import AudioSettings from "./components/AudioSettings.svelte";
  import DiggerQueue from "./components/DiggerQueue.svelte";
  import { mainOutputDeviceIds, cueOutputDeviceId, cueGain, networkOutputs } from "./lib/audio/audioSettings";
  import { fontScale, queueSidebarWidth } from "./lib/settings/displaySettings";
  import { CodecPlayer, type DemuxInfo } from "./lib/video/codecPlayer";
  import { videoPathOverrides, videoPathDefault, resolveVideoPath } from "./lib/video/videoPathSettings";
  import { getBackendState, setBackendState, clearBackendState, isAudioOnlyDeck } from "./lib/video/backendRegistry";
  import {
    createLegacyVideoEl, destroyLegacyVideoEl, syncLegacyVideoElement, checkLegacyVideoStall,
    getLegacyVideoEl, legacyVideoDeckIds, takeLegacyFrameIfAdvanced, forgetShippedLegacyFrames,
    resetStallWatch,
  } from "./lib/video/legacyVideo";
  import { reconcileAudioTransport, cancelAudioTransport, getLastAudioPlaying, setLastAudioPlaying, clearLastAudioPlaying } from "./lib/audio/transport";
  import { pollDeckPosition, resetPositionTracking } from "./lib/audio/positionPoll";
  import type { Deck } from "./lib/state/types";
  import { recordFrameTiming } from "./lib/audio/pollStats";
  import { advanceSweep, sweepAutostartTrack } from "./lib/audio/perfArm";
  import { installDebugHook } from "./lib/debug/debugHook";
  import { debugLog } from "./lib/debugLog";
  import { getDiggerFileUrl } from "./lib/digger/api";

  function openOutputWindow() {
    invoke('open_output_window').catch(console.error);
  }

  let midiUnlisten: (() => void) | undefined;
  let dragDropUnlisten: (() => void) | undefined;
  let eosUnlisten: (() => void) | undefined;
  let stopSessionSync: (() => void) | undefined;
  let tapTimestamps: number[] = [];
  let tapResetTimer: ReturnType<typeof setTimeout> | undefined;
  let showAudioSettings = $state(false);
  let showDiggerQueue = $state(true);
  let showVisualizationPanel = $state(false);

  const QUEUE_SIDEBAR_MIN_WIDTH = 220;
  const QUEUE_SIDEBAR_MAX_WIDTH = 640;

  function startQueueSidebarResize(e: PointerEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = get(queueSidebarWidth);
    function onMove(ev: PointerEvent) {
      // Sidebar is right-of-content, so dragging left (negative dx) widens it.
      const next = startWidth - (ev.clientX - startX);
      queueSidebarWidth.set(Math.min(QUEUE_SIDEBAR_MAX_WIDTH, Math.max(QUEUE_SIDEBAR_MIN_WIDTH, next)));
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  // --font-scale (app.css :root) is inherited into every component's scoped styles,
  // so setting it once here on documentElement is all that's needed to scale all UI text.
  $effect(() => {
    document.documentElement.style.setProperty("--font-scale", String($fontScale));
  });

  function handleTap() {
    const now = Date.now();
    tapTimestamps.push(now);
    clearTimeout(tapResetTimer);
    tapResetTimer = setTimeout(() => { tapTimestamps = []; }, 2000);
    const bpm = tapTempo(tapTimestamps);
    if (bpm !== null) setMasterBpm(bpm);
  }
  type BandAnalysis = { bass: number; mid: number; high: number };

  // The control window no longer composites. Since 2026-08-03 it ships each deck's current
  // frame to the output window, which runs the Compositor itself — snapshotting a WebGL
  // canvas is impossible on this machine's GPU driver, so there is nothing to gain from
  // compositing here and a whole WebGL context plus one 1920x1080 FBO per deck to lose.
  // See src/lib/renderer/outputProtocol.ts.
  let rendererReady = $state(false);
  // Per-deck FFT analysis received from GStreamer spectrum bus messages via Tauri events.
  const deckAnalysis = new Map<string, BandAnalysis>();
  let fftUnlisten: (() => void) | undefined;
  let rafId: number;
  // Timestamp of the previous rAF tick, used to report main-thread stalls. This used to
  // emit a "[heartbeat] rAF alive" line every single second unconditionally, which meant
  // every log file was ~100% heartbeat noise — actively hostile to reading a live repro
  // (the 2026-08-02 choppy-audio session opened a 32KB log whose entire visible tail was
  // nothing but heartbeats). Liveness is already reported to Rust once a second by the
  // watchdog_heartbeat invoke below, so this only logs the interesting case now: an
  // actual gap, with its measured duration, which is more useful than a missing line in
  // a wall of identical ones. Still distinguishes a frozen main thread from a merely
  // slow IPC round-trip — see debugLog.ts and docs/design/freeze-watchdog.md.
  const RAF_STALL_LOG_MS = 1000;
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
  // Signature of the last frame message's static inputs (deck id/source/opacity). Used to
  // skip postFrame() entirely when nothing visual changed and nothing is animating —
  // otherwise the full-resolution per-deck capture + cross-window postMessage runs forever
  // at 60fps even with zero decks loaded.
  let lastFrameSig = '';
  // WebKitGTK's GStreamer media backend can't resolve the custom media:// scheme for
  // <video> elements (confirmed: instant FormatError, no pipeline ever built). Production
  // serves video over a local-only HTTP server instead — same mechanism dev mode already
  // uses via the Vite middleware. Fetched once at startup; null until then.
  let mediaServerPort: number | null = null;
  // Last codec-path frame pts shipped to the output window per deck — the codec-path
  // counterpart of legacyVideo.ts's takeLegacyFrameIfAdvanced marker.
  const lastUploadedCodecPts = new Map<string, number>();

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

  // Each network output's configured delay — the part of its latency that happens on another
  // machine and that no query here can see (docs/design/network-audio-output.md).
  //
  // ⚠️ This lives in App, not in AudioSettings, because AudioSettings is only mounted while
  // the Settings panel is open. A persisted delay pushed from there would not reach the audio
  // graph until someone opened the panel — so every set would start with the projector
  // running ahead of the room, and the fix would look like it had never been applied.
  $effect(() => {
    for (const n of $networkOutputs) {
      setOutputLatency(n.id, n.latencyMs ?? 0).catch(console.error);
    }
  });

  // Sync headphone output device to Rust audio pipeline.
  // '' (the "— none —" option) must be sent like any other value: it is what tears the
  // cue pulsesink down and swaps in the fakesink. Guarding on truthiness left the backend
  // holding the previous device forever — the UI read "— none —" while the pipeline still
  // had a live cue sink on it (found 2026-08-08, mid-A/B: it silently turned arm A4 into
  // A3). Change-guarded because set_cue_device() rebuilds the pipeline unconditionally.
  let _lastCueDevice: string | undefined;
  $effect(() => {
    const deviceId = $cueOutputDeviceId;
    if (deviceId !== _lastCueDevice) {
      _lastCueDevice = deviceId;
      audioSetCueDevice(deviceId).catch(console.error);
    }
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
    // Dev/test-only hook so headless WebDriver perf/UI tests can drive the app without
    // going through the native file picker or OS drag-and-drop, neither of which
    // WebDriver can reach. No-op in a normal build — see debugHook.ts.
    installDebugHook({ killRafLoop: () => { debugKillRafLoop = true; } });
    // Always fetched (not just in prod): the legacy <video> element's src only needs this
    // in prod (dev uses the Vite media middleware instead), but the WebCodecs AU-fetch
    // route (/demux/<deck>/aus) is served by this same Rust media_server in both dev and
    // prod — codec-path decks need the port either way.
    mediaServerPort = await invoke<number>('media_server_port');
    midiUnlisten = await startMidiListener();

    // Session-of-record rehydration (docs/design/freeze-watchdog.md phase 2), before any
    // other init that would otherwise construct decks from the default empty session.
    const { isRecoveryBoot, globalsRestoredFromSnapshot } = await restoreSessionOnBoot();
    if (!isRecoveryBoot) await restoreMidiControlState(globalsRestoredFromSnapshot);

    stopSessionSync = startSessionSync();

    // Freeze-watchdog heartbeat (docs/design/freeze-watchdog.md phase 1: observe + log
    // only, no recovery yet). Deliberately a setInterval, not tied to the rAF loop —
    // WebKitGTK throttles rAF for occluded/hidden windows, which would false-alarm the
    // Rust-side silence trigger. lastRafMs lets Rust tell "rAF loop died, timers alive"
    // apart from "whole main thread dead" (the heartbeat itself would stop in that case).
    watchdogIntervalId = setInterval(() => {
      const decks = get(session).decks.map((d) => {
        const v = getLegacyVideoEl(d.id);
        return { id: d.id, vct: v?.currentTime ?? null, ready: v?.readyState ?? null };
      });
      invoke('watchdog_heartbeat', {
        window: 'main',
        stats: { lastRafMs: Math.round(performance.now() - lastRafTickAt), decks },
      }).catch(() => {});
    }, 1000);

    rendererReady = true;
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
          source: { type: 'video', filePath: paths[0], duration: 0, loadSeq: Date.now() },
          playing: false,
        });
      }
    });

    // Frame-budget sweep autostart (VITE_PERF_SWEEP=1 + VITE_PERF_SWEEP_TRACK=/abs/path).
    // Loads the track exactly the way a drag-and-drop does, waits out the pipeline preroll,
    // then presses play — the sweep itself refuses to advance until position actually moves,
    // so an early press costs a few seconds of `arm=off`, never a bogus arm.
    const sweepTrack = sweepAutostartTrack();
    if (sweepTrack) {
      const deckId = get(session).decks[0]?.id;
      if (deckId) {
        debugLog(`[perf-sweep] autostart: loading ${sweepTrack} into ${deckId}`);
        updateDeck(deckId, {
          source: { type: 'video', filePath: sweepTrack, duration: 0, loadSeq: Date.now() },
          playing: false,
        });
        setTimeout(() => {
          debugLog('[perf-sweep] autostart: play');
          updateDeck(deckId, { playing: true });
        }, 8000);
      }
    }
  });

  onDestroy(() => {
    midiUnlisten?.();
    dragDropUnlisten?.();
    eosUnlisten?.();
    stopSessionSync?.();
    clearInterval(watchdogIntervalId);
    cancelAnimationFrame(rafId);
    fftUnlisten?.();
    for (const id of legacyVideoDeckIds()) {
      destroyLegacyVideoEl(id);
      audioUnload(id).catch(console.error);
    }
    for (const id of codecPlayerDeckIds()) {
      teardownCodecPlayerOnly(id);
      audioUnload(id).catch(console.error);
    }
  });

  // Keep video backends in sync with the deck list. (Compositor FBOs are allocated on the
  // output window's side now, from the deck list carried in every frame message.)
  // syncVideoElements handles src changes, property sync, and play/pause.
  // rAF-throttled: rapid MIDI CC events (tempo fader at 14-bit = 200+/sec) are coalesced to
  // one syncVideoElements call per frame, preventing GStreamer from being overwhelmed with
  // rapid playbackRate changes that cause the pipeline to stall.
  let syncScheduled = false;
  // Deck ids the output bus currently holds per-deck resources for, so they can be released
  // when a deck is removed.
  const shippedDeckIds = new Set<string>();
  $effect(() => {
    const decks = $session.decks; // read before early-return so Svelte always tracks it
    if (!rendererReady) return;
    // Drop scratch canvases for decks that no longer exist (legacy <video> path only).
    for (const id of shippedDeckIds) {
      if (!decks.some((d) => d.id === id)) {
        releaseDeck(id);
        shippedDeckIds.delete(id);
      }
    }
    for (const d of decks) shippedDeckIds.add(d.id);
    if (!syncScheduled) {
      syncScheduled = true;
      requestAnimationFrame(() => {
        syncScheduled = false;
        syncVideoElements(get(session).decks);
      });
    }
  });

  // Loads the Rust audio pipeline for a (deckId, filePath) pair exactly once, regardless
  // of which video backend renders it — factored out of the old single "src changed"
  // branch so a live legacy<->webcodecs toggle never re-triggers audioLoad. Also runs the
  // saved-grid lookup and consumes a pending recovery adoption. Returns the adopted
  // recovery record (if any) so the caller can seek its video backend to the live position.
  function ensureAudioLoaded(deck: Deck, filePath: string): { positionSecs: number; playing: boolean } | undefined {
    const deckId = deck.id;
    if (!hasSavedGrid(deckId, filePath)) {
      // See the (removed) inline comment this used to carry: the trust map is write-only,
      // so it must be explicitly cleared on every new-file transition — confirmed live via
      // /run (loading A after visiting B silently inherited B's grid otherwise).
      clearSavedGrid(deckId);
      gridGetSaved(filePath).then((saved) => {
        const s = get(session).decks.find((d) => d.id === deckId)?.source;
        if (saved && s?.type === 'video' && s.filePath === filePath) {
          updateDeck(deckId, { bpm: saved.bpm, downbeat: saved.downbeat });
          markGridSaved(deckId, filePath);
        }
      }).catch(console.error);
    }
    const adopted = takePendingAdoption(deckId);
    if (adopted) {
      // Recovery adoption (freeze-watchdog.md phase 2): this deck's Rust/GStreamer
      // pipeline survived the freeze/reload — calling audioLoad() here would tear it down
      // and reload from scratch, audibly glitching the one thing this feature must never
      // do. The caller seeks its video backend to adopted.positionSecs once ready instead.
      setLastAudioPlaying(deckId, adopted.playing);
      debugLog(`[recovery] adopted ${deckId} at ${adopted.positionSecs.toFixed(2)}s playing=${adopted.playing}`);
    } else {
      // audio_load's loadedmetadata-equivalent: the <video> element's own loadedmetadata
      // never fires when WebKitGTK lacks a decoder for the file's codec, and codec-path
      // decks have no <video> element at all — audio_load's returned duration is the one
      // fallback both backends can rely on.
      // media_cache.rs tries filePath locally first regardless — this fallback only
      // matters when that stat fails, e.g. no local NAS mount, Digger reachable instead.
      const fallbackUrl = deck.diggerFileId != null ? getDiggerFileUrl(deck.diggerFileId) : undefined;
      audioLoad(deckId, filePath, fallbackUrl).then((duration) => {
        // A new DeckAudioPipeline is created with default gain/rate/volume=1.0 and
        // cue_enabled=false (pipeline.rs). Re-apply current session values so saved MIDI
        // state (or UI slider/cue-button state set before this track was loaded) takes
        // effect on the fresh pipeline.
        const d = get(session).decks.find((d) => d.id === deckId);
        if (d) {
          clearDeckAudioSync(deckId);
          syncGain(deckId, d.gain);
          syncRate(deckId, d.playbackRate);
          syncVolume(deckId, d.volume);
          // Cue is guarded separately by _prevCueStates (see the cueEnabled $effect
          // above) rather than audioSync.ts's module maps. teardownVideoBackendFull
          // clears this deck's entry so the guard doesn't look "unchanged" against a
          // pipeline that no longer exists, but clearing a plain Map is not a store
          // mutation, so the reactive $effect never reruns on its own to notice — it
          // only fires again on some *unrelated* future session change (a fader nudge,
          // MIDI event, etc). Without this explicit re-send, a deck reloaded while cue
          // was already on shows the button lit while the fresh pipeline's cue_valve is
          // silently closed, until something else happens to touch the store. Send
          // directly and mark the guard consistent, exactly like the MIDI direct-call
          // path bypasses the store for rate/gain/volume.
          _prevCueStates.set(deckId, d.cueEnabled);
          audioSetCue(deckId, d.cueEnabled).catch(console.error);
        }
        const s = get(session).decks.find((d) => d.id === deckId)?.source;
        if (duration && s?.type === "video" && s.filePath === filePath && (!s.duration || !Number.isFinite(s.duration))) {
          // Preserve s.loadSeq — see DeckSource.loadSeq's doc comment.
          updateDeck(deckId, { source: { type: "video", filePath, duration, loadSeq: s.loadSeq } });
        }
      }).catch(console.error);
      clearLastAudioPlaying(deckId);
    }
    resetPositionTracking(deckId);
    resetStallWatch(deckId);
    return adopted;
  }

  // Fully removes a deck's video presentation backend AND its audio pipeline — used when
  // the deck itself disappears or its source changes to a different file. NOT used for a
  // live legacy<->webcodecs toggle on the same file (see the *Only variants below), which
  // must leave the audio pipeline running untouched.
  function teardownVideoBackendFull(deckId: string) {
    destroyLegacyVideoEl(deckId);
    teardownCodecPlayerOnly(deckId);
    audioUnload(deckId).catch(console.error);
    clearLastAudioPlaying(deckId); cancelAudioTransport(deckId);
    clearDeckAudioSync(deckId); resetPositionTracking(deckId); resetStallWatch(deckId);
    clearBackendState(deckId);
    // audioUnload() above drops the Rust-side DeckAudioPipeline entirely (audio/mod.rs
    // audio_unload removes it from the pipelines map), so a subsequent load builds a brand
    // new one with cue_enabled defaulting to false (pipeline.rs). The cueEnabled $effect only
    // calls audioSetCue when deck.cueEnabled differs from _prevCueStates' last-seen value —
    // without clearing the entry here, a deck reloaded while cue was already on sees no
    // apparent change and never re-sends audioSetCue, leaving the fresh pipeline's cue valve
    // silently closed (confirmed live: headphone cue went dead after a deck reload until
    // manually re-toggled).
    _prevCueStates.delete(deckId);
  }

  // Tears down just the codec-path presentation backend (worker + Rust demux registry
  // entry) without touching the audio pipeline — safe to call for a live A/B toggle away
  // from webcodecs, or as part of teardownVideoBackendFull above.
  function teardownCodecPlayerOnly(deckId: string) {
    const player = getCodecPlayer(deckId);
    if (player) { player.destroy(); unregisterCodecPlayer(deckId); }
    invoke('video_demux_unload', { deckId }).catch(() => {});
    lastUploadedCodecPts.delete(deckId);
  }

  // Demuxes filePath via the Rust video_demux service and, on success, spawns a
  // CodecPlayer for deckId (docs/design/webcodecs-video-path.md phase 2). On failure
  // (unsupported codec, parse error) falls back to 'legacy-fallback' — the bottom of
  // syncVideoElements then creates a normal <video> element for this deck, same as if
  // 'legacy' had been requested. adoptedPos, if given, is a recovery-boot or live-toggle
  // position to seek the fresh player to once constructed.
  async function startCodecPath(deckId: string, filePath: string, adoptedPos?: number, fallbackUrl?: string) {
    try {
      const demux = await invoke<DemuxInfo>('video_demux_load', { deckId, filePath, fallbackUrl });
      // Guard: the deck's source may have changed again while this awaited.
      const cur = get(session).decks.find((d) => d.id === deckId)?.source;
      if (!cur || cur.type !== 'video' || cur.filePath !== filePath) {
        invoke('video_demux_unload', { deckId }).catch(() => {});
        return;
      }
      const port = mediaServerPort ?? await invoke<number>('media_server_port');
      const player = new CodecPlayer(deckId, port, demux);
      registerCodecPlayer(deckId, player);
      setBackendState(deckId, { filePath, kind: 'webcodecs', loadSeq: cur.loadSeq }, false);
      const curPlaying = get(session).decks.find((d) => d.id === deckId)?.playing;
      debugLog(`[video-path] ${deckId} entered webcodecs state: deck.playing=${curPlaying} lastAudioPlaying=${getLastAudioPlaying(deckId)} adoptedPos=${adoptedPos}`);
      if (adoptedPos !== undefined) player.seek(adoptedPos);
      const s = get(session).decks.find((d) => d.id === deckId)?.source;
      if (s?.type === 'video' && s.filePath === filePath && (!s.duration || !Number.isFinite(s.duration)) && demux.duration) {
        // Preserve s.loadSeq — this is a duration-fill on the load already in progress,
        // not a new deliberate reload (see DeckSource.loadSeq's doc comment).
        updateDeck(deckId, { source: { type: 'video', filePath, duration: demux.duration, loadSeq: s.loadSeq } });
      }
    } catch (e) {
      debugLog(`[video-path] ${deckId} demux failed, falling back to legacy <video>: ${e}`);
      const prev = getBackendState(deckId);
      // "parsebin never exposed a video pad" specifically means the container has no video
      // stream at all (e.g. a .wav loaded as a video-typed deck source) — see the
      // audioOnlyDecks doc comment in backendRegistry.ts. Other demux failures (parse
      // errors, unsupported codecs) leave a real video track for the legacy <video>
      // element to decode, so don't suppress sync there.
      const audioOnly = String(e).includes('timed out waiting for parsebin to expose a video stream');
      setBackendState(deckId, { filePath, kind: 'legacy-fallback', adoptedPos: prev?.adoptedPos, loadSeq: prev?.loadSeq }, audioOnly);
    }
    // The backend registry is a plain Map, not a Svelte store — flipping `kind` above does
    // not re-trigger the $effect that schedules syncVideoElements. If a play/pause intent
    // was already latent (e.g. deck.playing flipped true while this awaited), it would
    // otherwise sit unactioned until some unrelated store change happened to re-run the
    // effect (confirmed live: a 9+ second stall until the next click). Re-sync explicitly
    // now so the transition is applied immediately instead of waiting on a coincidence.
    syncVideoElements(get(session).decks);
  }

  function syncVideoElements(decks: Deck[]) {
    // Remove backends for decks that are gone or no longer have a video source. A deck id
    // is only ever in one of these two lists — the backends are mutually exclusive.
    for (const id of [...legacyVideoDeckIds(), ...codecPlayerDeckIds()]) {
      const deck = decks.find((d) => d.id === id);
      if (!deck || deck.source?.type !== "video") teardownVideoBackendFull(id);
    }

    for (const deck of decks) {
      if (deck.source?.type !== "video") continue;
      const deckId = deck.id;
      const filePath = deck.source.filePath;
      const desired = resolveVideoPath(deckId, get(videoPathOverrides), get(videoPathDefault));
      const state = getBackendState(deckId);

      if (!state || state.filePath !== filePath || state.loadSeq !== deck.source.loadSeq) {
        // Brand-new file for this deck (fresh load, track swap, OR a deliberate reload of
        // the file already here — same filePath but a new loadSeq) — tear down whatever
        // backend was active for the OLD file (including its audio pipeline) first.
        //
        // Skip teardown when an adoption is pending for this deck: this is the first sync
        // pass after a freeze-watchdog recovery reload, the backend registry is empty
        // simply because the page is fresh, and there is no stale frontend backend to
        // clean up — only the live Rust pipeline that survived the freeze.
        // teardownVideoBackendFull() calls audioUnload(), which drops that pipeline
        // immediately (Drop tears the GStreamer pipeline to Null and detaches its mixer
        // branches); ensureAudioLoaded() below then finds the adoption still pending and
        // skips audioLoad(), believing it adopted a survivor that this call already
        // destroyed. Confirmed live 2026-08-12: both decks came back marked "loaded" with
        // no underlying pipeline, and every subsequent play() failed silently forever —
        // see docs/design/freeze-watchdog.md "Adoption bugs".
        if (!hasPendingAdoption(deckId)) {
          teardownVideoBackendFull(deckId);
        }
        const adopted = ensureAudioLoaded(deck, filePath);
        if (desired === 'webcodecs') {
          setBackendState(deckId, { filePath, kind: 'pending', adoptedPos: adopted?.positionSecs, loadSeq: deck.source.loadSeq });
          const fallbackUrl = deck.diggerFileId != null ? getDiggerFileUrl(deck.diggerFileId) : undefined;
          startCodecPath(deckId, filePath, adopted?.positionSecs, fallbackUrl);
        } else {
          setBackendState(deckId, { filePath, kind: 'legacy', adoptedPos: adopted?.positionSecs, loadSeq: deck.source.loadSeq });
          createLegacyVideoEl(deckId, filePath, mediaServerPort, adopted?.positionSecs);
        }
        continue; // rest of this deck's sync resumes next rAF pass once state settles
      }

      if (state.kind === 'pending') continue; // demux probe in flight

      if (desired === 'webcodecs' && state.kind === 'legacy') {
        // Live per-deck A/B toggle to codec path — audio pipeline (and its already-applied
        // gain/rate/volume) survives untouched; only the presentation backend changes.
        const resumeAt = getDeckTime(deckId) ?? undefined;
        debugLog(`[video-path] ${deckId} live-toggle legacy->webcodecs: deck.playing=${deck.playing} resumeAt=${resumeAt} lastAudioPlaying=${getLastAudioPlaying(deckId)}`);
        destroyLegacyVideoEl(deckId);
        setBackendState(deckId, { filePath, kind: 'pending', loadSeq: state.loadSeq });
        startCodecPath(deckId, filePath, resumeAt);
        continue;
      }
      if (desired === 'legacy' && state.kind === 'webcodecs') {
        const resumeAt = getDeckTime(deckId) ?? undefined;
        teardownCodecPlayerOnly(deckId);
        setBackendState(deckId, { filePath, kind: 'legacy', loadSeq: state.loadSeq }, false);
        createLegacyVideoEl(deckId, filePath, mediaServerPort, resumeAt);
        continue;
      }

      if (state.kind === 'webcodecs') {
        // Codec-path deck: no <video> element. frame() handles per-tick clock/frame work;
        // here we just keep the worker's loop bounds in sync (CodecPlayer.setLoop no-ops
        // when unchanged) and mirror deck.playing to the audio pipeline exactly like the
        // legacy path does.
        const player = getCodecPlayer(deckId);
        if (player) {
          if (deck.loop && deck.loopIn !== null && deck.loopOut !== null) {
            player.setLoop({ inPos: deck.loopIn, outPos: deck.loopOut });
          } else {
            player.setLoop(null);
          }
        }
        const wasAudioPlaying = getLastAudioPlaying(deckId);
        if (deck.playing !== wasAudioPlaying) {
          // Only mark this play/pause as handled once the IPC call actually succeeds —
          // audio_load can still be mid-flight (Digger fetch + GStreamer preroll can take
          // several seconds), so audioPlay racing ahead of pipeline creation fails with
          // "no audio pipeline for deck". reconcileAudioTransport retries on its own timer
          // instead of depending on syncVideoElements running again (it doesn't, on every
          // tick — see transport.ts).
          debugLog(`[video-path] ${deckId} webcodecs branch: calling audio${deck.playing ? 'Play' : 'Pause'} (was=${wasAudioPlaying})`);
          reconcileAudioTransport(deckId, deck.playing);
        }
        continue;
      }

      // state.kind is 'legacy' or 'legacy-fallback': normal <video>-element sync path.
      const v = getLegacyVideoEl(deckId)
        ?? createLegacyVideoEl(deckId, filePath, mediaServerPort, state.adoptedPos);
      syncLegacyVideoElement(deck, filePath, v);
    }
  }

  // Audio clock of the first deck that claims to be playing or is being scratched, for the
  // frame-budget A/B sweep's liveness gate — null when nothing claims to be running at all.
  // Any one such deck is enough: the sweep only needs to know that the clock it is measuring
  // against is moving, not which deck supplies it.
  function sweepClockSec(): number | null {
    for (const deck of get(session).decks) {
      if (deck.playing || isScratching(deck.id)) return getDeckTime(deck.id) ?? 0;
    }
    return null;
  }

  // Builds this tick's per-deck frame for the output window, and runs the per-deck
  // clock/stall work that has to happen every tick regardless. Returns true when this deck
  // produced a frame the output window hasn't seen yet.
  function stepDeck(deck: Deck, out: { source: DeckFrameSource | null }, nowMs: number): boolean {
    const v = getLegacyVideoEl(deck.id);
    const codecPlayer = getCodecPlayer(deck.id);
    let dirty = false;

    if (v && takeLegacyFrameIfAdvanced(deck.id, v)) {
      out.source = { kind: 'video', el: v };
      dirty = true;
    } else if (codecPlayer) {
      // Codec-path deck: no <video> element to read a currentTime from — pick the
      // frame whose pts matches the audio clock (same value the waveform consumes),
      // gated on actual pts change per CLAUDE.md's per-frame RAF rule.
      const t = getDeckTime(deck.id);
      if (t !== null) {
        const frame = codecPlayer.getFrameForTime(t);
        if (frame && frame.timestamp !== lastUploadedCodecPts.get(deck.id)) {
          lastUploadedCodecPts.set(deck.id, frame.timestamp);
          out.source = { kind: 'codec', frame };
          dirty = true;
        }
      }
    }

    // Mechanism-B self-heal (freeze-watchdog.md phase 4) — see legacyVideo.ts.
    // <video>-element-specific; codec-path decks have no `v` and no WebKit media-player
    // pipeline to wedge in the first place (the whole point of that design, see
    // docs/design/webcodecs-video-path.md "Why this exists"), so this naturally never runs
    // for them. Also skipped for audio-only decks (see backendRegistry.ts) — a real
    // audio-only file's v.currentTime never has a video track driving it, which this would
    // otherwise misread as a wedged decoder and "recover" via v.load() every ~10s for the
    // deck's entire playback.
    if (v && !isAudioOnlyDeck(deck.id)) checkLegacyVideoStall(deck, v, nowMs);

    // Audio is the master clock for both backends — see positionPoll.ts.
    pollDeckPosition(deck, v, codecPlayer, isScratching(deck.id));
    return dirty;
  }

  // RAF render loop: ship each deck's current frame to the output window; sync video to
  // the audio clock.
  function frame() {
    const nowMs = performance.now();
    // Gap since the previous tick, before anything in this one runs. Paired with the
    // duration recorded at the tail, this separates "the main thread is saturated" from
    // "the main thread is idle but WebKit is delivering IPC replies late" — the two have
    // identical position-poll symptoms and completely different fixes. See pollStats.ts.
    const rafGapMs = lastRafTickAt === 0 ? 0 : nowMs - lastRafTickAt;
    lastRafTickAt = nowMs;
    // lastHeartbeatAt starts at 0, so skip the first tick — its "gap" is the whole
    // uptime since page load, not a stall.
    if (lastHeartbeatAt !== 0 && nowMs - lastHeartbeatAt > RAF_STALL_LOG_MS) {
      debugLog(`[heartbeat] rAF stalled ${Math.round(nowMs - lastHeartbeatAt)}ms`);
    }
    lastHeartbeatAt = nowMs;
    // Drive the frame-budget A/B sweep, if one is enabled (VITE_PERF_SWEEP=1 — off in every
    // ordinary run; see perfArm.ts for why the arms advance on a wall clock rather than on a
    // keypress or an edit). Fed the clock of a deck that claims to be playing, not the flag:
    // the sweep refuses to advance unless position is actually moving.
    //
    // At the top of the tick deliberately: the other two rAF loops read the arm's gates and
    // the flush stamps it, so flipping it here means one tick is governed by exactly one arm
    // end to end, rather than switching midway between the loops that are being compared.
    advanceSweep(sweepClockSec());
    try {
      if (rendererReady) {
        const { decks, visualization, visualizationOpacity } = get(session);
        const timeSecs = performance.now() / 1000;
        // The output window asks for this when it opens or is reloaded. Forgetting what has
        // already been shipped makes every deck count as changed below, so a paused deck —
        // which will never produce a new frame on its own — reappears on the projector.
        const resendRequested = takeResendRequest();
        if (resendRequested) {
          forgetShippedLegacyFrames();
          lastUploadedCodecPts.clear();
        }
        // Combine per-deck FFT data from GStreamer spectrum events: max across all playing decks.
        let bass = 0, mid = 0, high = 0;
        for (const a of deckAnalysis.values()) {
          bass = Math.max(bass, a.bass);
          mid = Math.max(mid, a.mid);
          high = Math.max(high, a.high);
        }
        const analysis: BandAnalysis = { bass, mid, high };
        // Any visualization (continuous u_time animation) or a video frame that actually
        // advanced/seeked this tick makes the output stale.
        // A resend must produce a message even when nothing else changed — otherwise a fresh
        // output window with no decks loaded (or only paused, sourceless ones) never hears
        // from us at all and sits on its "waiting for frames" state indefinitely.
        let dirty = resendRequested;
        // This tick's frame for each deck, in render order. A null source means "unchanged" —
        // the output window keeps showing what that deck's FBO already holds, so a paused
        // deck costs nothing per frame. Built for every deck, including sourceless ones, so
        // the output window always learns the full deck list and opacity set.
        const outputDecks: Array<{ id: string; opacity: number; source: DeckFrameSource | null }> =
          decks.map((d) => ({ id: d.id, opacity: d.opacity, source: null }));
        for (let i = 0; i < decks.length; i++) {
          if (decks[i].source?.type !== 'video') continue;
          if (stepDeck(decks[i], outputDecks[i], nowMs)) dirty = true;
        }
        // Global visualization layer — rendered by the output window's compositor, above all
        // decks, so picking a visualization never interrupts deck audio/video. It animates
        // continuously (u_time), so it always marks the frame dirty; only the uniforms and
        // time ride along per frame, never the shader source (see outputProtocol.ts).
        if (visualization) {
          dirty = true;
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
          postFrame({
            decks: outputDecks,
            vizSrc: visualization?.fragmentSrc ?? null,
            vizOpacity: visualization ? visualizationOpacity : 0,
            vizUniforms: visualization?.uniforms ?? {},
            time: timeSecs,
            analysis,
          });
        }
      }
    } catch (e) {
      // An uncaught throw here previously killed the rAF loop forever (this line never
      // reschedules) while GStreamer's independent audio pipeline kept playing — total,
      // permanent UI freeze with music still going and zero trace in the log (only
      // debugLog() reaches the Rust-side log file; console.error doesn't). See the
      // 2026-07-24 investigation in docs/design/pcm-buffer-playback.md. Log and keep the
      // loop alive instead of vanishing silently.
      // Message *and* stack. WebKit's `e.stack` is bare frames with no message line
      // (unlike V8), so logging the stack alone drops the only part that says what went
      // wrong: a per-frame `ReferenceError: Can't find variable: OUTPUT_ALIVE_TIMEOUT_MS`
      // reached the log as an anonymous `hasListener@…outputBus.ts:29:102` and read like a
      // crash inside working code (2026-08-03). Cheap here — this path only runs when a
      // frame has already thrown.
      debugLog(
        `[frame-error] ${e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? '(no stack)'}` : String(e)}`,
      );
    }
    // Synchronous cost of this tick only. Async work this tick *starts* (createImageBitmap,
    // the cross-process bitmap clone in outputBus.postFrame) lands outside it — a small
    // duration next to a large gap is the signature of exactly that kind of off-thread or
    // deferred work crowding the frame, rather than our own JS being slow.
    recordFrameTiming(rafGapMs, performance.now() - nowMs);
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
    <div class="toolbar-divider"></div>
    <button class="add-deck" onclick={addDeck}>+ Deck</button>
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
    <button class="output-btn" onclick={openOutputWindow}>Output Window</button>
    <button
      class="output-btn"
      class:active={showAudioSettings}
      onclick={() => { showAudioSettings = !showAudioSettings; }}
    >Settings</button>
    <div class="toolbar-divider"></div>
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
    <div class="toolbar-divider"></div>
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
    <label
      class="master-vol"
      class:disabled={!$cueOutputDeviceId}
      title={$cueOutputDeviceId ? "" : "Select a headphone/cue device in Settings first"}
    >
      Headphone Volume
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={$cueGain}
        disabled={!$cueOutputDeviceId}
        oninput={(e) => cueGain.set(+e.currentTarget.value)}
      />
      <span>{$cueGain.toFixed(2)}</span>
    </label>
  </header>

  <!-- The hidden 1x1 compositor canvas that used to live here is gone (2026-08-03). It
       existed only to be snapshotted for the output window, and on this machine that
       snapshot could never work: all GPU->CPU readback from WebGL is broken in the Mesa
       `crocus` driver, so createImageBitmap() returned correctly-sized transparent frames
       forever. The output window now composites for itself from per-deck frames — see
       src/lib/renderer/outputProtocol.ts and docs/upstream/webgl-canvas-readback-broken.md.
       If a composited preview is ever wanted *in* the control window, it needs its own
       visible canvas and its own Compositor; do not reintroduce a hidden one to capture. -->

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
            <!-- downbeat comes from the comb fit's measured grid phase (gridOffset), NOT
                 from t=0. Between 2026-07-25 and 2026-08-08 this deliberately used 0 on the
                 grounds that the fitted phase was "arbitrary" — it is not. gridOffset is the
                 measured position of a beat (bpm.test.ts asserts it within 20-25ms of truth);
                 t=0 is the arbitrary one, off by a uniformly-random fraction of a beat on
                 every track. Since getPhase() measures phase relative to this anchor, two
                 decks anchored at their own t=0 could sit up to half a beat apart while NUDGE
                 reported them perfectly in phase — beat-level sync could not work at all.
                 gridOffset marks *a* beat, not bar-beat-1; SET BEAT remains the manual
                 override for bar identity, and only a manual SET BEAT persists locally /
                 pushes to Digger. null (grid fit failed, integer detectBpm fallback) still
                 clears any stale downbeat carried over from the previous track. -->
            <WaveformCanvas {deck} onAnalyzed={({ bpm, gridOffset, onsets }) => {
              // Onsets feed SET BEAT's re-snap (onsetStore.ts) regardless of whether the
              // auto-fit itself is trusted below — a saved grid can still be manually
              // corrected, and that correction should snap to a real kick too.
              if (deck.source?.type === 'video' && onsets) {
                setDeckOnsets(deck.id, deck.source.filePath, onsets);
              }
              // A saved grid (sidecar or Digger) always wins over the auto-fit — see the
              // race-ordering comment at the gridGetSaved() call site above.
              if (deck.source?.type === 'video' && !hasSavedGrid(deck.id, deck.source.filePath)) {
                updateDeck(deck.id, { bpm, downbeat: gridOffset });
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
      <div
        class="queue-sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize queue sidebar"
        onpointerdown={startQueueSidebarResize}
      ></div>
      <aside class="queue-sidebar" style="width: {$queueSidebarWidth}px;">
        <DiggerQueue />
      </aside>
    {/if}
  </div>
</div>
