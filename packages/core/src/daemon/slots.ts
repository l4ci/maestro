// Concurrency accounting (spec §14). The daemon is the ONLY place slots live: a
// single in-process accountant bounds active workers globally (`global_max`) and
// per repo (`max_active`). "Active" = an issue currently running or starting the
// agent (`run-agent` / `start-new`); watching is not working, so poll/merge/
// blocked/handoff/none never acquire. There is NO cross-install coordination in v1
// (§17) — see the double-claim ops guard in the daemon header.

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
