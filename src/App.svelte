<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { get } from "svelte/store";
  import { session, addDeck, updateDeck, setMasterBpm } from "./lib/state/session";
  import { tapTempo } from "./lib/audio/bpm";
  import { startMidiListener } from "./lib/midi/handler";
  import { Compositor } from "./lib/renderer/compositor";
  import { invoke } from "@tauri-apps/api/core";
  import {
    audioLoad, audioUnload, audioPlay, audioPause,
    audioSeek, audioSetRate, audioSetGain, audioSetVolume,
    audioSetCue, audioSetMasterVolume, audioSetMainDevices,
    audioSetCueDevice, audioSetCueGain,
  } from "./lib/audio/pipeline";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { listen } from "@tauri-apps/api/event";
  import { registerVideoEl, unregisterVideoEl, setDeckAudioTime } from "./lib/renderer/seekBus";
  import { postFrame } from "./lib/renderer/outputBus";
  import DeckCard from "./components/DeckCard.svelte";
  import Crossfader from "./components/Crossfader.svelte";
  import WaveformCanvas from "./components/WaveformCanvas.svelte";
  import AudioSettings from "./components/AudioSettings.svelte";
  import { mainOutputDeviceIds, cueOutputDeviceId, cueGain } from "./lib/audio/audioSettings";
  import type { Deck } from "./lib/state/types";
  import { audioGetPosition } from "./lib/audio/pipeline";

  function openOutputWindow() {
    invoke('open_output_window').catch(console.error);
  }

  let midiUnlisten: (() => void) | undefined;
  let dragDropUnlisten: (() => void) | undefined;
  let eosUnlisten: (() => void) | undefined;
  let tapTimestamps: number[] = [];
  let tapResetTimer: ReturnType<typeof setTimeout> | undefined;
  let showAudioSettings = $state(false);

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
  // Last playbackRate applied to each video element. Setting v.playbackRate triggers
  // WebKitGTK to rebuild its internal GStreamer pipeline; only update on actual change.
  const lastPlaybackRate = new Map<string, number>();
  // Last deck.playing value sent to the Rust audio pipeline. Tracked independently of
  // v.paused because WebKitGTK temporarily pauses the video element during its internal
  // pipeline rebuild (triggered by any v.playbackRate write). Without this, a play→pause
  // toggle arriving in that window finds v.paused=true, matches neither branch, and
  // audioPause is never called — leaving GStreamer playing with the deck appearing frozen.
  const lastAudioPlaying = new Map<string, boolean>();

  // Sync master volume to Rust audio pipeline
  $effect(() => {
    audioSetMasterVolume($session.masterVolume).catch(console.error);
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

  // Sync deck cueEnabled flags to Rust audio pipeline
  $effect(() => {
    for (const deck of $session.decks) {
      audioSetCue(deck.id, deck.cueEnabled).catch(console.error);
    }
  });

  onMount(async () => {
    midiUnlisten = await startMidiListener();
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
    console.log('[syncVideoElements]', decks.map(d => `${d.id}=${d.source?.type ?? 'null'}`));
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
      }
    }

    for (const deck of decks) {
      if (deck.source?.type !== "video") continue;
      const filePath = deck.source.filePath;
      // Dev: serve via Vite HTTP middleware so GStreamer's souphttpsrc can reach it.
      // Prod: use the Rust media:// custom scheme (bundled app, no Vite server).
      const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
      const src = import.meta.env.DEV
        ? '/media' + encodedPath
        : 'media://localhost' + encodedPath;

      let v = videoEls.get(deck.id);
      if (!v) {
        console.log(`[${deck.id}] creating video element`);
        v = document.createElement("video");
        v.style.cssText = "position:fixed;top:-9999px;width:1px;height:1px;pointer-events:none";
        v.muted = true; // audio is handled by Rust/GStreamer; video element is for decode only
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
        if (s?.type === "video" && s.filePath === filePath) {
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
        audioLoad(deck.id, filePath).catch(console.error);
        // Reset audio state tracker so the next sync re-applies play/pause to the new pipeline.
        lastAudioPlaying.delete(deck.id);
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

      audioSetGain(deck.id, deck.gain).catch(console.error);
      audioSetVolume(deck.id, deck.volume).catch(console.error);
      // v.volume=0 survives WebKitGTK pipeline rebuilds (it's a JS property, not pipeline state).
      // v.muted=true is belt-and-suspenders but can be lost on playbackRate-triggered rebuilds.
      // Both together ensure no audio bleed even during the brief rebuild window.
      v.volume = 0;
      v.muted = true;
      // Only update playbackRate when it changes: setting v.playbackRate causes WebKitGTK
      // to rebuild its internal GStreamer pipeline, causing CPU spikes and PipeWire xruns
      // when called at rAF rate (60/sec) from rapid MIDI tempo events.
      const targetRate = Math.max(0.0625, deck.playbackRate);
      if (lastPlaybackRate.get(deck.id) !== targetRate) {
        lastPlaybackRate.set(deck.id, targetRate);
        v.playbackRate = targetRate;
        v.volume = 0;
        v.muted = true;
      }
      audioSetRate(deck.id, deck.playbackRate).catch(console.error);

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

  const shaderDebugLogged = new Set<string>();

  // RAF render loop: upload video frames → composite; sync video to audio clock
  function frame() {
    if (compositor) {
      const { decks } = get(session);
      const timeSecs = performance.now() / 1000;
      // Combine per-deck FFT data from GStreamer spectrum events: max across all playing decks.
      let bass = 0, mid = 0, high = 0;
      for (const a of deckAnalysis.values()) {
        bass = Math.max(bass, a.bass);
        mid = Math.max(mid, a.mid);
        high = Math.max(high, a.high);
      }
      const analysis: BandAnalysis = { bass, mid, high };
      for (const deck of decks) {
        if (deck.source?.type === 'shader') {
          if (!shaderDebugLogged.has(deck.id)) {
            shaderDebugLogged.add(deck.id);
            console.log(`[shader ${deck.id}] first render — deckAnalysis size=${deckAnalysis.size} analysis=`, analysis);
          }
          compositor.renderShader(deck.id, deck.source.fragmentSrc, deck.source.uniforms, timeSecs, analysis);
        } else if (deck.source?.type === 'video') {
          const v = videoEls.get(deck.id);
          const fbo = compositor.getFBO(deck.id);
          if (v && fbo) fbo.uploadVideoFrame(v);
          // Audio is the master clock. One in-flight IPC per deck prevents stale
          // out-of-order responses from snapping currentTime backward mid-rate-change.
          if (deck.playing && v && !pendingPos.get(deck.id)) {
            pendingPos.set(deck.id, true);
            audioGetPosition(deck.id).then((audioPos) => {
              pendingPos.delete(deck.id);
              if (audioPos === null || !v) return;
              setDeckAudioTime(deck.id, audioPos); // feeds waveform playhead
              if (Math.abs(v.currentTime - audioPos) > 0.08) {
                v.currentTime = audioPos; // snap video to audio clock
              }
            }).catch(() => { pendingPos.delete(deck.id); });
          }
        }
      }
      compositor.composite(decks);
      postFrame(canvas);
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
    >Audio</button>
    <span class="bpm">{$session.bpm ? `${$session.bpm} BPM` : "—"}</span>
    <button class="tap-btn" onclick={handleTap}>TAP</button>
    {#if $session.bpm !== null}
      <button class="tap-reset" onclick={() => { setMasterBpm(null); tapTimestamps = []; }}>✕</button>
    {/if}
    <label class="master-vol">
      Master
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

  {#if showAudioSettings}
    <AudioSettings />
  {/if}

  <div class="waveform-stack">
    {#each $session.decks as deck (deck.id)}
      <div class="waveform-row">
        <span class="waveform-label">{deck.id}</span>
        <WaveformCanvas {deck} onBpmDetected={(bpm) => updateDeck(deck.id, { bpm })} />
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
