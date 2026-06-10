// Concurrency accounting (spec §14). The daemon is the ONLY place slots live: a
// single in-process accountant bounds active workers globally (`global_max`) and
// per repo (`max_active`). "Active" = an issue currently running or starting the
// agent (`run-agent` / `start-new`); watching is not working, so poll/merge/
// blocked/handoff/none never acquire. There is NO cross-install coordination in v1
// (§17) — see the double-claim ops guard in the daemon header.
//
// INTERNAL since #91: both classes here are implementation seams behind the Claims
// interface (claims.ts) — the tick reaches them only through a Claim, and neither is
// exported from the package.

/** A release handle. Idempotent: calling it more than once decrements only once. */
export type SlotRelease = () => void;

export class SlotAccountant {
  readonly #globalMax: number;
  #globalActive = 0;
  readonly #perRepo = new Map<string, number>();

  constructor(globalMax: number) {
    this.#globalMax = globalMax;
  }

  /** Can a NEW active worker start for `repoKey` this tick, under both caps? */
  available(repoKey: string, maxActive: number): boolean {
    return this.#globalActive < this.#globalMax && this.activeFor(repoKey) < maxActive;
  }

  /** Claim a slot for `repoKey`. Returns an idempotent release handle. */
  acquire(repoKey: string): SlotRelease {
    this.#globalActive += 1;
    this.#perRepo.set(repoKey, this.activeFor(repoKey) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#globalActive -= 1;
      this.#perRepo.set(repoKey, this.activeFor(repoKey) - 1);
    };
  }

  get globalActive(): number {
    return this.#globalActive;
  }

  activeFor(repoKey: string): number {
    return this.#perRepo.get(repoKey) ?? 0;
  }
}

/**
 * Per-issue in-flight guard (§14, #18). The SlotAccountant bounds CAPACITY (how many
 * workers run at once); this set enforces UNIQUENESS (an issue already being worked is not
 * dispatched again). Needed because a repo stays "due" while its prior pass's agent work is
 * still settling, so overlapping tick passes would otherwise stack a second agent on one
 * issue whenever a slot is free (max_active ≥ 2). Keyed `${repoKey}:${iid}`.
 */
export class InFlightSet {
  readonly #active = new Set<string>();
  #key(repoKey: string, iid: number): string {
    return `${repoKey}:${iid}`;
  }
  has(repoKey: string, iid: number): boolean {
    return this.#active.has(this.#key(repoKey, iid));
  }
  add(repoKey: string, iid: number): void {
    this.#active.add(this.#key(repoKey, iid));
  }
  delete(repoKey: string, iid: number): void {
    this.#active.delete(this.#key(repoKey, iid));
  }
}
