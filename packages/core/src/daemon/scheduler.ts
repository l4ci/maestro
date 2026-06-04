// Adaptive-poll scheduler (spec §14). Per repo it tracks `nextTickAt`: a repo that did
// active work this tick re-polls at `poll_interval_active` (fast), an idle one at
// `poll_interval_idle` (slow), each spread by a jitter drawn uniformly from
// `[0, poll_jitter]` to avoid synchronized bursts / rate-limit spikes. Pure: all time
// and randomness are injected (Clock + Rng), so every interval/jitter decision is
// asserted deterministically without real time (see daemon-scheduler.test.ts).

import type { Rng } from './clock.js';

export interface PollIntervals {
  active: number; // poll_interval_active (ms)
  idle: number; // poll_interval_idle (ms)
  jitter: number; // poll_jitter (ms) — max jitter offset
}

/** Uniform jitter in the inclusive range [0, maxMs]. */
export function pickJitter(rng: Rng, maxMs: number): number {
  return Math.floor(rng.next() * (maxMs + 1));
}

export class Scheduler {
  readonly #intervals: PollIntervals;
  readonly #rng: Rng;
  readonly #nextTickAt = new Map<string, number>();

  constructor(intervals: PollIntervals, rng: Rng) {
    this.#intervals = intervals;
    this.#rng = rng;
  }

  /** Record (and return) the next tick time for `repoKey` after a tick at `now`. */
  schedule(repoKey: string, hadActiveWork: boolean, now: number): number {
    const base = hadActiveWork ? this.#intervals.active : this.#intervals.idle;
    const at = now + base + pickJitter(this.#rng, this.#intervals.jitter);
    this.#nextTickAt.set(repoKey, at);
    return at;
  }

  nextTickAt(repoKey: string): number | undefined {
    return this.#nextTickAt.get(repoKey);
  }

  /** Is `repoKey` due at `now`? A never-scheduled repo is due immediately. */
  due(repoKey: string, now: number): boolean {
    const at = this.#nextTickAt.get(repoKey);
    return at === undefined || now >= at;
  }

  /** Drop a repo from scheduling (e.g. removed by a config hot-reload, §5). */
  forget(repoKey: string): void {
    this.#nextTickAt.delete(repoKey);
  }
}
