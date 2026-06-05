// Label namespacing (spec §0.7). GitLab uses scoped `maestro::state` (mutual
// exclusion free); GitHub uses flat `maestro:state` (adapter enforces exclusion).
// Pure helper — ships implemented in M0.

import type { ForgeKind } from './forge-model.js';

const BASE = 'maestro';

export interface LabelNames {
  /** Seen + queued, no agent launched yet (#53). Removed when the bot is unassigned. */
  todo: string;
  inProgress: string;
  inReview: string;
  blocked: string;
  all(): string[]; // ordered for board lists (§11): todo → in-progress → in-review → blocked
}

export function labelNames(forge: ForgeKind): LabelNames {
  const sep = forge === 'gitlab' ? '::' : ':';
  const todo = `${BASE}${sep}todo`;
  const inProgress = `${BASE}${sep}in-progress`;
  const inReview = `${BASE}${sep}in-review`;
  const blocked = `${BASE}${sep}blocked`;
  return {
    todo,
    inProgress,
    inReview,
    blocked,
    all: () => [todo, inProgress, inReview, blocked],
  };
}
