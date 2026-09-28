# Per-track visual override (cuemark side)

**Status (2026-09-27): DESIGN ONLY — nothing built.** Auto-visualize (ask #3) was merged
in on 2026-09-27; it's approved and can ship before any Digger work. Rewritten from the 2026-09-20 version,
which predated the ISF plugin system and still described visualizations as raw shader source.
**Storage, search, pairing history and the precedence rule now live in Digger** —
`digger/docs/design/visual-library.md` is the owning doc and the source of truth for all of
that. This doc is the presentation half: how cuemark resolves and renders the picture it is
handed, per deck.

## The ask

1. A track with no video (audio-only deck) should be able to have a *preferred generated
   visualization*, playing where the video would play.
2. The same mechanism should let a track use a *different video* than its own, even when it
   already has one.
3. **(2026-09-27, merged in from `viz-panel-and-settings-restyle.md`)** With *no* preference
   stored anywhere, a track with no video or only a still image should still get a
   visualization automatically, and it should switch off again when the next track comes in.
   This is **auto-visualize**. It needs no Digger work and no per-track data, so it can ship
   first. See "Automatic fallback" below.

## Decisions carried forward (2026-09-20, not re-opened)

- **Stored in Digger**, against the track, so it follows the track across machines and the
  queue like markers and the grid. Digger also owns the visual *library* — browsing,
  descriptions, tags, visual search, and the pairing history — so cuemark stays a
  presentation layer with no persistent state of its own. See `visual-library.md`.
- **An explicit override always wins** over the track's embedded video. "Fallback only" was
  rejected: it cannot express #2.
- **This is a per-deck render input, not the existing global visualization layer.** See "Why
  not the existing global layer" below.

## What changed since 2026-09-20 (why this doc was rewritten)

cuemark's visualization system became plugin-based
(`docs/design/visualization-plugins.md`, phases 1–4 built):

- `Session.visualization` is `{ pluginId, params }`. The old
  `{ fragmentSrc, uniforms }` shape **no longer exists** — a visual is identified by a
  **plugin id** (the path of a `.fs` file relative to cuemark's visualizations folder,
  deliberately stable across launches so it can be persisted and stored per track), plus a
  params map.
- Built-ins are ordinary ISF files going through the same loader; there is no separate code
  path for them.
- The renderer is already **instance-based** (`src/lib/renderer/isf/instance.ts`,
  `IsfInstance`), explicitly so this doc's per-deck viz can reuse it without a rewrite.
  `Compositor` holds a single `vizInstance` today; per-deck means a map of them.
- Parameters, multipass/persistent buffers and audio routing/bindings all exist
  (`vizBindings.ts`, `Session.vizAudioSource`).
- Milkdrop (phase 6, not built) renders via a stacked **opaque** canvas in a sandboxed
  iframe, not into a texture. See "Milkdrop is not available per-deck" below.

So the shape cuemark receives from Digger is a `pluginId` + `params`, or a video path — never
shader source.

## Shape

Digger resolves the whole precedence chain and hands cuemark one answer. The wire shape (see
`visual-library.md` for the authoritative schema and the full response):

```ts
type EffectiveVisual =
  | { kind: 'isf';      id: number; name: string; pluginId: string; params: Record<string, unknown> }
  | { kind: 'milkdrop'; id: number; name: string; pluginId: string; params: Record<string, unknown> }
  | { kind: 'video';    id: number; name: string; filePath: string | null; fileUrlPath: string | null;
                        durationMs: number | null; loopable: boolean }
  | null;   // no picture: audio-only deck, today's behaviour
```

It arrives on the payload cuemark already fetches — `GET /tracks/{id}/cuemark` gains a
`visual` key plus `visualResolvedFrom`, so `CuemarkPayload` in `src/lib/digger/api.ts` gains
two fields and no new request is needed on the load path. `GET /playlists/{id}/set-plan`
carries them per track for a whole set, for free.

`Deck` gains **one** field, named so it cannot be read as a saved preference:

```ts
effectiveVisual: EffectiveVisual;      // what this deck is rendering right now
effectiveVisualFrom: ResolvedFrom;     // 'queue_slot' | 'playlist_row' | 'track_default' | 'embedded' | 'none'
```

⚠️ **Do not add a second deck field that also means "the visual".** Digger distinguishes the
track's *saved default pairing*, a *queue-slot override*, a *playlist-row override*, the
track's *embedded video*, and the *effective* answer — five separate things, five separate
names (`visual-library.md` D6). cuemark holds only the last two, and `effectiveVisual` must
never double as "what to save". Saving is an explicit action that posts to Digger; it does
not read a deck field that might have been set by any of the five levels. This is the
`feedback_name_which_end_not_the_region` discipline applied here: one field, one meaning.

Cuemark does **not** compute precedence. If a deck needs to know why it is showing what it
is showing (for a badge, or a log line), it reads `effectiveVisualFrom`.

## Rendering

- **`kind: 'isf'`** — render an `IsfInstance` into *that deck's* FBO, so it takes the deck's
  opacity and the crossfader exactly as video does.
- **`kind: 'video'`** — replaces the video half of the deck's render input (demux/decode of
  the visual's path) while audio still comes from the track. ⚠️ Audio is the master clock and
  video is slaved to it; an override video's timeline is not the track's. **Open item 1.**
- **`kind: null`** — today's behaviour.

`DeckSource` and the audio path are **untouched** in all three cases.

## Why not the existing global layer

`Session.visualization` sits above all decks at its own opacity. With deck A on a viz and
deck B on video, the crossfader must fade between them, which only works if the viz is *the
deck's picture*. So this needs a per-deck viz render source. The global layer stays as it is.

This does **not** re-open the 2026-06-21 decision. That bug was `DeckSource` switching to
`'shader'`, which made `syncVideoElements()` tear the deck down and `audioUnload()` kill the
music. Here `DeckSource` and the audio path are untouched; only the compositor's per-deck
*render input* changes. **Do not reintroduce a `'shader'` `DeckSource`.**

## Automatic fallback (auto-visualize) — ask #3

Decided with the user 2026-09-27. Mockups: claude.ai design canvas
https://claude.ai/artifact/F2eBGJ3geKm8q6ZyTLPxTk (the "Auto-visualize across a set" board and
the auto strip on the panel board). Nothing built.

**Where it sits in precedence: last.** An explicit visual from Digger (any level, including
`embedded`) always beats it. Auto applies only when `effectiveVisualFrom` is `'none'`, or
before phase 5 of the list below exists, whenever the deck has no video. It is a cuemark-local
behaviour, not a sixth Digger level. Nothing is stored per track, and it must not be written
into `effectiveVisual`.

**It drives the *global* layer, not a per-deck render.** This is the opposite of the
override's choice, and deliberately so. The user rates Milkdrop well above the ISF
built-ins, and Milkdrop can only be a whole-layer CSS-opacity canvas (see "Milkdrop is not
available per-deck"). Auto has no crossfade problem to solve on a single deck either,
because the rules below decide *which* deck drives the global layer. ⚠️ Once per-deck ISF
rendering exists, auto *could* move per-deck for ISF sources. That is **open item 5**, not
a change to make silently.

**Rules:**
- **The louder deck decides** (user-confirmed). Reuse `dominantDeckId` from
  `src/lib/viz/vizBindings.ts` (`pickDominant`). Don't write a second loudness rule. In a
  crossfade, the incoming deck takes over once it's the louder one.
- The dominant deck's picture kind: **no video** → the layer goes to 100%. **Still image** →
  the user's still-image level (default 60%, so the art shows through). **Video** → auto is
  inactive.
- What it shows: the user's choice of "current selection / a default / random favorite".
- Save the whole layer state (on/off, opacity, pluginId, params) when auto takes over.
  Restore it exactly when the dominant deck's track has real video again.
- **Touching opacity, source or VIZ during an auto track hands control back.** Auto then
  restores nothing for that track.
- Fade in and out over one bar if the dominant deck has a grid, otherwise over 2 s.
- Settings UI lives in the Visualization panel (auto strip). The toolbar VIZ control and a
  deck-header `AUTO VIZ n%` badge show its state. See `viz-panel-and-settings-restyle.md`.

**Detection:**
- **No video** already exists: `isAudioOnlyDeck()` in `src/lib/video/backendRegistry.ts`, set
  in `App.svelte` (~line 574). ⚠️ It works by matching the text of a demux *timeout* error, so
  it arrives late and is fragile. Consider a real "no video pad" signal from `video_demux.rs`.
  The same signal serves `kind: null` above.
- **Still image is detected nowhere yet.** Probe real library files first: mp4 `covr`, mkv
  attachments, a one-frame video stream. An mp3's embedded art is a tag, not a stream, so it
  probably reads as *no video*. Don't design the detector before a probe shows what
  GStreamer exposes.

**Build:** a pure state machine in `src/lib/viz/autoViz.ts` (inputs: dominant deck id,
per-deck picture kind, per-deck `effectiveVisualFrom` when it exists, user-touch events →
output: layer state). Unit-test it before wiring it into `App.svelte`. It depends on the
panel's on/off-without-losing-plugin state (`viz-panel-and-settings-restyle.md` phase 2).

## Work, in order

Auto-visualize (above) is independent of this list and ships first. The list below is the
per-deck override.

1. **Compositor** (`src/lib/renderer/compositor.ts`): it already holds one
   `vizInstance: VizRenderer | null` for the global layer. Add a per-deck map
   (`deckVizInstances: Map<deckId, VizRenderer>`), rendering each into that deck's existing
   `DeckFBO` in place of an uploaded bitmap. `composite()` needs no change — it already
   blends decks by opacity. **Dispose on switch** (programs, FBOs, textures), the same rule
   phase 1 of `visualization-plugins.md` established; 50 plugin switches in a set must not
   leak GPU memory.
2. **Protocol** (`src/lib/renderer/outputProtocol.ts`): a per-deck viz payload, mirroring the
   global one — plugin **payload only on change** (it carries the source text and asset URLs
   and is far too large per frame), with `bindings`/`params` riding along each frame. Read
   that file before touching it; the `bitmap: null` = "reuse the FBO" convention and the
   `hello` full-resend both interact with this.
3. **Frame loop** (`App.svelte` `frame()`): an active per-deck viz animates continuously, so
   it must mark the frame dirty, as the global layer already does. Open question 4 in
   `visualization-plugins.md` was decided for the global layer — keep animating whenever the
   output window is open; pause everything viz-related when it is closed, gated on the same
   `alive` beacon `postFrame()` already uses. **Apply the same rule per deck** rather than
   inventing a second liveness signal.
4. **Bindings** (`src/lib/viz/vizBindings.ts`): a per-deck viz wants **its own deck's**
   bands, not the max/mix across decks. `routeAudio` already supports `'deck:<id>'`; a
   per-deck instance should use that deck's id implicitly instead of `Session.vizAudioSource`.
   ⚠️ `effectiveDeckGain` deliberately skips the crossfader curve when `setCrossfader`
   already wrote it into `deck.volume` — don't apply it twice (same class as the
   master-volume squaring bug in `shared-output-pipeline.md` "Gain staging").
5. **State + load**: `Deck.effectiveVisual` / `effectiveVisualFrom`, applied on the Digger
   load path that already carries `diggerTrackId` and the mix-zone fields.
6. **Missing-plugin handling**: an `'isf'` visual whose `pluginId` is not installed on this
   machine must show a badge on the DeckCard, fall back to the embedded video (or nothing),
   and `debugLog()` once — never a silent black deck. A plugin id is machine-local; Digger
   storing one does not make it exist here (`visual-library.md` D2, open decision O1).
   The `cuemark:vizQuarantine` path from `visualization-plugins.md` "Hazards" applies too: a
   plugin that lost the GL context must not be re-selected by the output window's `hello`
   resend, per deck as well as globally.
7. **In-session UI** (DeckCard): a picker that queries Digger's `GET /visuals?q=` for this
   deck now, plus two write-through actions — "Save as track default"
   (`POST /tracks/{id}/visual-default`) and "Set for this queue slot"
   (`PATCH /queue/{item_id}/visual`). Nothing else.

Phases 1–4 are useful and live-testable before any Digger work exists (set a per-deck visual
for a session by hand); 5–7 need the Digger side.

## What is explicitly **not** cuemark's

All of it lives in Digger — see `visual-library.md` "UI ownership":

- The visual library: browsing, search by visual content, descriptions, tags, thumbnails,
  retiring an entry.
- The pairing **history** view ("what has been paired with this track over time").
- Editing a track's saved default outside a live session, and authoring playlist-level
  overrides for a set.
- The precedence rule itself, and every stored representation of a pairing.

cuemark gets no library-management, description-editing, tagging or history UI.

## Milkdrop is not available per-deck

Butterchurn renders into its **own opaque canvas** (`alpha: false`) in a sandboxed iframe
stacked above the compositor canvas, because reading its pixels back is impossible on the
2012 MacBook Pro (`crocus` GPU→CPU readback is broken — CLAUDE.md). Whole-layer CSS opacity
is the only blend available there, which is fine for a global layer and useless for a deck
that has to crossfade. A per-deck Milkdrop would need a texture route that does not exist;
`visualization-plugins.md` says so explicitly. So `kind: 'milkdrop'` is accepted on the wire
(Digger can store it) and must **degrade with a badge**, not render, until that is solved.

## Open items

1. **Timeline for a `video` visual**: loop it, or start at 0 on play and free-run? Slaving it
   to the track's position makes no sense when durations differ. `visuals.duration_ms` and
   `visuals.loopable` are carried on the wire for whatever rule is chosen.
2. **Serving an override video.** The deck's `<video>`/WebCodecs path needs an
   `http://127.0.0.1:<port>/<abs-path>` URL from cuemark's own media server, which requires
   the file to exist on *this* machine. When it does not, Digger's
   `GET /visuals/{id}/file` (Range-capable) is the fallback — the same split
   `filePath`/`fileId` already has for tracks. Decide whether the override video also goes
   through `media_cache.rs` like track media does.
3. **Verification.** Automated pixel checks of compositor output verify nothing on the
   MacBook Pro (WebGL readback). Readback works on `mele`
   (`docs/environment.md`) — verify there headlessly, then look at the real projector.
4. **Paused decks.** A paused deck with a viz still costs frames. Decide whether a paused
   deck's viz freezes or keeps animating; the global layer's answer (keep animating, bindings
   decay to 0) may not be right for a deck that is visually "off".
5. **Auto-visualize, global or per-deck?** It is global today because Milkdrop is. Once
   per-deck ISF rendering ships, decide whether auto should use it for ISF sources (the
   crossfader would then blend it like video) and stay global only for Milkdrop. Ask the
   user; don't switch silently.

## Cross-repo

`digger/docs/design/visual-library.md` — schema (`visuals`, `visual_tags`,
`track_visual_pairings`, the override columns on `queue_items`/`playlist_tracks`), the
precedence rule and its vocabulary, the API, the migration plan (steps 56–58), the
visual-search phasing, and the open decisions that need the user. **Keep the precedence
vocabulary identical in both docs.**
