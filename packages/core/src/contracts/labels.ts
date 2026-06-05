// Label namespacing (spec §0.7). GitLab uses scoped `maestro::state` (mutual
// exclusion free); GitHub uses flat `maestro:state` (adapter enforces exclusion).
// Pure helper — ships implemented in M0.

import type { ForgeKind } from './forge-model.js';

const BASE = 'maestro';

export interface LabelNames {
  /** Capacity marker (#53, renamed in #29): wants a slot, none free. Orthogonal to
   *  stage — any agent stage can be queued. Removed when the bot is unassigned. */
  queued: string;
  /** Stage: being defined — the define agent refines the request into AC (#29). */
  backlog: string;
  /** Stage: defined, awaiting planning. HUMAN-set — this is the definition gate (#29):
   *  the daemon never applies it, so its presence proves a maintainer approved the AC
   *  (or pre-approved by labelling at creation, skipping the define stage). */
  todo: string;
  inProgress: string;
  inReview: string;
  blocked: string;
  /** Board lists in lifecycle order (§11). Excludes the queued marker — capacity is
   *  not a lifecycle column. */
  board(): string[];
  all(): string[]; // every label maestro creates/owns
}

export function labelNames(forge: ForgeKind): LabelNames {
  const sep = forge === 'gitlab' ? '::' : ':';
  const queued = `${BASE}${sep}queued`;
  const backlog = `${BASE}${sep}backlog`;
  const todo = `${BASE}${sep}todo`;
  const inProgress = `${BASE}${sep}in-progress`;
  const inReview = `${BASE}${sep}in-review`;
  const blocked = `${BASE}${sep}blocked`;
  return {
    queued,
    backlog,
    todo,
    inProgress,
    inReview,
    blocked,
    board: () => [backlog, todo, inProgress, inReview, blocked],
    all: () => [backlog, todo, inProgress, inReview, blocked, queued],
  };
}
