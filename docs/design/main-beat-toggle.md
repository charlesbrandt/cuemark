# Main Beat button — toggle behavior (open design question)

Renamed from "Master" to "Main Beat" (2026-07-21) to avoid clashing with the unrelated
Master Volume slider in the toolbar. This doc captures a design question raised in the
same conversation: should the button act as a toggle? Not implemented yet — decision
and implementation are future work.

## Current behavior

`DeckCard.svelte` — clicking **Main Beat** unconditionally calls `setMasterBpm(deck.bpm)`,
which sets `session.bpm` (the sync target read by every deck's **Sync** button and by
`nudgePhaseToMaster`'s `findReferenceDeck`, `phaseNudge.ts:47-62`). It is a one-way
"select this deck as the reference" action, not a per-deck on/off toggle:

- Clicking it on a *different* deck overwrites `session.bpm`, silently moving the
  reference — there's no confirmation and no visual change on the deck that lost
  reference status beyond its `active` class turning off.
- Clicking it again on the *current* reference deck is a harmless no-op (same value
  written back).
- There is **no per-deck way to clear** the reference. The only clear path is the
  toolbar's `✕` next to the global BPM readout (`App.svelte:641`,
  `setMasterBpm(null)`), which is spatially and conceptually distant from the
  per-deck button that sets it.

## Open questions for a toggle design

1. **Click-to-clear**: should clicking Main Beat on the already-active deck clear
   `session.bpm` (toggle off) instead of no-op'ing? If so, what happens to decks
   already `Sync`'d to it — do their rates freeze at the last-synced value (current
   behavior of any rate change) or should losing the reference be surfaced somehow?
2. **Reassignment cascade**: when Main Beat moves from deck A to deck B, should decks
   previously `Sync`'d to A automatically re-sync to B's BPM? Currently they don't —
   their `playbackRate` stays wherever it was left, silently drifting out of sync with
   the new reference until the user re-clicks Sync manually.
3. **Active-state float equality**: the `active` class check
   (`masterBpm === deck.bpm`, `DeckCard.svelte:224`) uses exact equality, but
   `findReferenceDeck` in `phaseNudge.ts:59` already had to switch to a `< 0.05` BPM
   tolerance because bpm is fractional and can shift slightly on re-analysis. The
   button's active highlight doesn't have this tolerance, so it can silently stop
   showing "this is the reference deck" while `nudgePhaseToMaster` still treats it as
   one. Should be reconciled regardless of the toggle decision.
4. **Auto-refit interaction**: per the fractional beat-grid auto-fit on track load
   (see CLAUDE.md's "Grid persistence" section), a reload can change `deck.bpm` out
   from under an already-set Main Beat deck. `session.bpm` doesn't follow — it stays
   frozen at the value captured when the button was clicked. Combined with (3), this
   means the reference deck's own button can stop showing as active after a reload,
   even though it's still functionally driving `session.bpm`. Should a reload of the
   current Main Beat deck re-fire `setMasterBpm` with the new bpm automatically?

## Non-goals for this doc

Not proposing an answer — flagging the shape of the decision so it isn't made
piecemeal inside an unrelated bug-fix commit. `setMasterBpm`/`masterBpm` internal
naming was left as-is; only the user-facing button label and tooltips changed in the
2026-07-21 rename.
