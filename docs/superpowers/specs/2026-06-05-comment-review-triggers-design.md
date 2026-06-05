# Comment-Based Review Triggers

**Date:** 2026-06-05
**Status:** Approved
**Related:** #6 (reviewer ping), #7 (live lifecycle E2E), #25 (comment formatting)

## Problem

The in-review state has exactly one merge trigger — a formal GitHub/GitLab approval —
and one rework trigger — a formal `CHANGES_REQUESTED` review (GitHub) / unresolved
blocking thread (GitLab). Two gaps:

1. When `bot_user` is also the reviewer (solo operation, e.g. l4ci reviewing maestro's
   own PRs), formal approval is impossible: GitHub forbids approving your own PR. The
   merge trigger can never fire.
2. A reviewer who writes a bug report as a *plain comment* (instead of a formal review)
   is silently ignored. Their feedback never reaches the agent.

## Decision summary

A **comment channel** runs in parallel with the formal review channel, always on
(no config knob):

| Signal | Trigger | Authorization |
|---|---|---|
| Merge | comment whose first non-empty line, trimmed, is `/approve` or starts with `/approve` + whitespace (case-insensitive) — so "/approve, nice work" counts, "I won't /approve this" does not | MR assignees minus `botUser` |
| Rework | any other non-bot comment | any non-bot human |

- **Asymmetric strictness:** merging is irreversible, so it requires an explicit token
  from the assigned reviewer. Rework is forgiving — prose bug reports count.
- **Listen on both** the issue and the MR. The ping comment (#6/#26) lives on the MR,
  so replies land there; issue comments count too.
- **Edge-triggered** against `lastBotPushAt`, exactly like `computeChangesRequested`:
  a stale `/approve` from before a rework push does not merge the new commits
  (mirrors GitHub stale-review dismissal); feedback already addressed by a later push
  does not re-trigger.
- **Newest signal wins** within the comment channel: bug report then later `/approve`
  → merge; `/approve` then later bug report → rework.
- An **unauthorized `/approve`** (drive-by) is ignored entirely — not treated as
  feedback either, so it cannot poison the channel.

### Cross-channel conflict

Formal approval + a *later* feedback comment → the reconciler checks `approved` first,
so it merges. Accepted: honoring newest-wins across channels would require threading
formal-review timestamps through `normalize.ts`; the conflict (formal click followed by
a trailing comment within one tick window) is rare. Within the comment channel
newest-wins holds strictly.

## Architecture

Logic lives **once, in the snapshot layer** (`packages/core/src/forge/snapshot.ts`),
above the `ForgePrimitives` seam — the same home as `computeChangesRequested`. The
adapters supply pieces, never decisions (the file's founding rule). The reconciler is
untouched: `reconcile.ts` in-review already branches on `ap.approved` /
`ap.changesRequested`.

### Snapshot layer

- New pure function `computeCommentSignal(comments, assignees, botUser, lastBotPushAt)`
  → `'approve' | 'changes' | 'none'`. Filters to non-bot comments postdating
  `lastBotPushAt` (drops unauthorized `/approve`s first), then the newest survivor
  decides.
- `findMaestroMr` folds the result into `ApprovalState`:
  - `approved = formalApproved || commentApproved`
  - `changesRequested = formalCR || commentChangesRequested`
- New primitive in `ForgePrimitives`:
  `mrComments(mrIid): Promise<Comment[]>` — normalized, system-notes filtered,
  any order (caller sorts), same cap as issue comments.
- `assembleSnapshot` fetches MR comments for the chosen MR. `IssueSnapshot` gains
  `mrComments: Comment[]` (newest-first, capped; `[]` when no MR). Kept **separate**
  from `recentComments`: merging the streams would corrupt `repliesSinceBlock`, which
  locates the bot's block-question by "newest bot comment" and would trip over bot
  ping/proof comments on the MR.
- `botUser` must reach snapshot assembly (today it stops at the reconciler). Likely
  path: adapter constructor options, alongside `commentCap`.

### Adapters (primitives only)

- **GitHub:** PR conversation comments = issues API on the PR number. Inline
  review-thread comments are **excluded in v1** — replies to the ping comment land in
  the conversation, and inline threads already feed the formal channel via
  `changesRequestedSince`.
- **GitLab:** MR notes, system-notes filtered (same filter as issue notes).

### Feedback to the agent

`apply-changes-requested` feedback becomes issue + MR comments merged newest-first
(today: issue comments only — a bug report written on the PR never reached the agent).

### Handoff ping

The reviewer @-mention comment (#26, `handoff.ts`) gains one line stating the
contract: "Reply `/approve` to merge, or describe needed changes to send it back."

## Untouched

Reconciler (`reconcile.ts`), blocked-state logic (`repliesSinceBlock` still reads
issue comments only), formal-review normalization paths.

## Known risks

1. **False-positive rework:** any stray non-bot comment ("thanks!") on the issue or MR
   during in-review triggers one rework cycle. Bounded — the agent runs once and
   pushes or no-ops — and the ping comment states the contract. Accepted.
2. **No-push re-trigger (inherited):** the edge-trigger stays hot until the bot pushes.
   If the agent addresses feedback without pushing, the next tick re-triggers. The
   formal path has the same shape today; if planning confirms it is a latent bug, it
   becomes its own issue rather than scope here.

## Testing

- **Unit, signal:** table-driven tests for `computeCommentSignal` — authorization,
  edge-trigger vs `lastBotPushAt`, newest-wins ordering, drive-by `/approve` ignored,
  bot comments ignored, `/approve` matching (case, whitespace, trailing text).
- **Unit, fold:** `findMaestroMr` with fake primitives — comment signal ORed with
  formal state, both directions.
- **Unit, assembly:** `assembleSnapshot` populates `mrComments` newest-first, capped,
  `[]` without an MR.
- **Adapter:** normalize tests for the new primitive per forge.
- **No live tier:** matches existing tiering; #7 covers live lifecycle.
