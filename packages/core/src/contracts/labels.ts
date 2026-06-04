// Label namespacing (spec §0.7). GitLab uses scoped `maestro::state` (mutual
// exclusion free); GitHub uses flat `maestro:state` (adapter enforces exclusion).
// Pure helper — ships implemented in M0.

import type { ForgeKind } from './forge-model.js';

const BASE = 'maestro';

export interface LabelNames {
  inProgress: string;
  inReview: string;
  blocked: string;
  all(): string[]; // ordered for board lists (§11): in-progress → in-review → blocked
}

export function labelNames(forge: ForgeKind): LabelNames {
  const sep = forge === 'gitlab' ? '::' : ':';
  const inProgress = `${BASE}${sep}in-progress`;
  const inReview = `${BASE}${sep}in-review`;
  const blocked = `${BASE}${sep}blocked`;
  return {
    inProgress,
    inReview,
    blocked,
    all: () => [inProgress, inReview, blocked],
  };
}
