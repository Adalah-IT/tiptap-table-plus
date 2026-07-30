# Table cell overflow normalizer — status: SHELVED, pending a pagination refactor

**Do not merge `fix/overflow-normalizer` (PR #11) as-is.** It is kept for reference. The
table `dir` attribute that used to ride along in this branch was split into its own
change (PR #12) and is unaffected by this decision.

## What it tried to do

When a table cell holds more content than fits in the remaining space of the current
page, the desired behaviour is: fill the rest of the current page, then cut the cell into
the next page — instead of pushing the whole cell down and leaving a large blank band.
The normalizer (`src/pagination/TableRowOverflow.ts`) implemented this, plus the inverse
(pull content back up when margins grow and space reopens), as a ProseMirror plugin that:

- measures rendered DOM geometry against the pagination breaker bands,
- splits leading blocks of an overflowing cell into a *linked continuation row*
  (`rmRowId` / `rmLinkedTo`) on the next page,
- runs debounced, bidirectional normalize passes (split on shrink, pull on growth),
- reacts to margin changes via a `MutationObserver` on the editor DOM.

## Why it is being shelved

The approach measures and mutates the document *after* layout, which fights the
pagination engine (`tiptap-pagination-plus`) that itself reflows on every content change.
That coupling is the root problem and it surfaces as a family of issues that patching
cannot fully close:

1. **Thrash / livelock risk.** Split → reflow → re-measure → split is a feedback loop.
   Convergence only holds behind hand-tuned hysteresis buffers (`LIMIT_PAGE_BUFFER`,
   `PULL_GAP`, `PULL_MARGIN`, `MIN_FIRST_CHUNK`, chrome estimation). These are brittle and
   layout-dependent.
2. **Cell chrome is invisible to block sums.** Per-block heights miss cell
   padding/border (~100px+), so the fill budget needs a heuristic correction that can be
   wrong for unusual cell styling.
3. **Collaboration races.** Two Yjs clients normalizing the same overflow produce
   duplicate splits. Gating on the `y-sync$` transaction meta plus a dedup cleanup pass
   reduces but does not eliminate this.
4. **Undo entanglement.** Normalize/cleanup transactions must carry
   `addToHistory: false` across three independent history mechanisms (y-tiptap's
   `ySyncPlugin`, CLM's custom `UndoManager`, and `prosemirror-history`). Easy to
   regress.
5. **Paragraph granularity.** The smallest movable unit is a block. A single paragraph
   taller than the remaining space cannot be split, so a blank band still remains. Real
   parity with print layout needs intra-paragraph (line-level) breaking.
6. **Parallel data model.** Linked continuation rows are a second, hand-maintained
   structure layered on the real table. It is fragile around caret-follow empty rows,
   cell merges, and row/column edits.

## The real fix

Make breaking a **layout-engine** concern, not a document mutation. The pagination engine
should be table-aware and break rows/cells at render time (paged-media style), leaving the
ProseMirror document untouched. That removes the measure-then-mutate loop, the linked-row
bookkeeping, the collab/undo special-casing, and unlocks line-level breaking. Until that
refactor lands, cell overflow keeps the pre-existing "push whole cell to next page"
behaviour.

## Where the code is

- Branch: `fix/overflow-normalizer` (PR #11)
- File: `src/pagination/TableRowOverflow.ts`
- Relevant commits: `5523192` (normalizer), `beb41ae` (page-fill), `10ded18` (bidirectional pull-up)
