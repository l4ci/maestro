// Per-issue consecutive proof-failure streak (#109, CONTEXT.md §Proof-failure
// escalation). In-memory BY DESIGN: a daemon restart resets every streak — acceptable,
// the run just retries with a fresh count. One process-wide instance lives beside
// Claims / RateLimitGate in the daemon composition; the executor's catch path feeds it
// and consults the pure decideProofFailure edge with the count it returns.

import type { RepoRef } from '../contracts/index.js';
import { repoKey } from './ports.js';

export class ProofStreaks {
  #streaks = new Map<string, number>();

  /** Record one more consecutive failure for this issue; returns the new streak (1-based). */
  fail(repo: RepoRef, iid: number): number {
    const key = this.#key(repo, iid);
    const next = (this.#streaks.get(key) ?? 0) + 1;
    this.#streaks.set(key, next);
    return next;
  }

  /** Proof generation succeeded — the consecutive streak is broken. */
  clear(repo: RepoRef, iid: number): void {
    this.#streaks.delete(this.#key(repo, iid));
  }

  #key(repo: RepoRef, iid: number): string {
    return `${repoKey(repo)}#${iid}`;
  }
}
