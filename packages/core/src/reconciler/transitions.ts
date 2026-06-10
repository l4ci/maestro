// Lifecycle moves (#78, CONTEXT.md §Lifecycle move) — the write-side counterpart of the
// pure lifecycle edges (deriveState/deriveStage read labels; this table writes them).
// One named move per label transition the daemon performs; callers (tick, handoff) keep
// their own `setIssueLabels` calls and just spread the table's result. Pure, total,
// NO I/O; imports only contracts.
//
// Two constraints are load-bearing and forbid a "clear all other labels" normalization:
//  · the human-set `todo` definition gate (#29) must survive every move EXCEPT
//    begin-work-from-plan — planning is the one transition that consumes the gate;
//  · a non-implement `unblock` sets NO stage label — define/plan stages carry their own
//    labels already (#29): the artifacts, not the flip, decide the stage.
// The queued marker is capacity, not stage (#53) — its set/retract are moves like any
// other, never folded into "stage changed, clear everything".

import type { LabelNames } from '../contracts/labels.js';
import type { AgentRole } from '../contracts/runner.js';

export type LifecycleMove =
  /** start-new intent: an agent is actually on it now — in-progress replaces the
   *  queued capacity marker (#53). */
  | 'begin-work'
  /** run-plan intent (#29): the plan landed, work begins — in-progress replaces the
   *  whole pre-work ladder: todo (the human gate, consumed HERE and only here),
   *  backlog, and the queued marker. */
  | 'begin-work-from-plan'
  /** run-define intent (#29): the AC draft is posted — backlog marks the define
   *  stage, replacing the queued marker. */
  | 'enter-define'
  /** apply-changes-requested intent: review asked for changes — flip back from
   *  in-review to in-progress (§7 In-review→in-progress edge). */
  | 'resume-from-review'
  /** apply-unblock intent: a maintainer answered — clear blocked; only the implement
   *  role restores in-progress (non-implement roles set NO stage label, #29). */
  | 'unblock'
  /** review bounce cap (#29) and the after-run mark-blocked decision (needs_input,
   *  §0.9): park it for a human — blocked replaces in-progress. */
  | 'park-blocked'
  /** proof-only-then-in-review decision (#29 P3) and handoff step 5 (§7): the work is
   *  review-ready — in-review replaces in-progress. */
  | 'enter-review'
  /** mark-queued intent (#53/#29): wants a slot, none free — set the capacity marker,
   *  touch nothing else. */
  | 'mark-queued'
  /** cleanup sweep (#53): bot unassigned while queued — retract the stale capacity
   *  marker, touch nothing else. */
  | 'retract-queued';

/**
 * The one place label arithmetic lives: move → exact `{ set, unset }` arrays for
 * `ForgeAdapter.setIssueLabels`. `role` matters only for `unblock` (defaults to
 * 'implement', matching the tick's `intent.role ?? 'implement'`).
 */
export function lifecycleMove(
  move: LifecycleMove,
  labels: LabelNames,
  role: AgentRole = 'implement',
): { set: string[]; unset: string[] } {
  switch (move) {
    case 'begin-work':
      return { set: [labels.inProgress], unset: [labels.queued] };
    case 'begin-work-from-plan':
      return { set: [labels.inProgress], unset: [labels.todo, labels.backlog, labels.queued] };
    case 'enter-define':
      return { set: [labels.backlog], unset: [labels.queued] };
    case 'resume-from-review':
      return { set: [labels.inProgress], unset: [labels.inReview] };
    case 'unblock':
      return { set: role === 'implement' ? [labels.inProgress] : [], unset: [labels.blocked] };
    case 'park-blocked':
      return { set: [labels.blocked], unset: [labels.inProgress] };
    case 'enter-review':
      return { set: [labels.inReview], unset: [labels.inProgress] };
    case 'mark-queued':
      return { set: [labels.queued], unset: [] };
    case 'retract-queued':
      return { set: [], unset: [labels.queued] };
  }
}
