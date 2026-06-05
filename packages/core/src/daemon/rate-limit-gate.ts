// Global Claude rate-limit backoff (#47). One instance per daemon process, shared
// across repos (like SlotAccountant): when ANY agent run dies on the account's usage
// limit, every subsequent spawn is pointless until the limit window resets — so the
// gate pauses spawning process-wide. In-memory only by design: after a restart the
// first doomed spawn re-trips it.

export interface RateLimitGateOptions {
  /** First backoff when the CLI gave no reset time (default 5 min). */
  baseMs?: number;
  /** Backoff cap for repeated trips (default 60 min). */
  capMs?: number;
  /** Safety margin added to a CLI-reported reset time (default 30 s). */
  marginMs?: number;
  now?: () => number; // injectable clock for tests
}

export class RateLimitGate {
  #pausedUntil = 0;
  #trips = 0; // consecutive trips without a healthy run → exponential backoff
  readonly #baseMs: number;
  readonly #capMs: number;
  readonly #marginMs: number;
  readonly #now: () => number;

  constructor(opts: RateLimitGateOptions = {}) {
    this.#baseMs = opts.baseMs ?? 5 * 60_000;
    this.#capMs = opts.capMs ?? 60 * 60_000;
    this.#marginMs = opts.marginMs ?? 30_000;
    this.#now = opts.now ?? (() => Date.now());
  }

  /** Epoch ms the pause runs to, or null when spawning is allowed. */
  pausedUntil(): number | null {
    return this.#pausedUntil > this.#now() ? this.#pausedUntil : null;
  }

  /** Record a rate-limited run. Uses the CLI-reported reset time when it's in the
   *  future; otherwise doubles from base up to cap per consecutive trip. Returns the
   *  pause deadline (epoch ms). */
  trip(resetAt?: number): number {
    const now = this.#now();
    this.#trips += 1;
    if (resetAt !== undefined && resetAt > now) {
      this.#pausedUntil = resetAt + this.#marginMs;
    } else {
      const backoff = Math.min(this.#baseMs * 2 ** (this.#trips - 1), this.#capMs);
      this.#pausedUntil = now + backoff;
    }
    return this.#pausedUntil;
  }

  /** A healthy (non-rate-limited) agent run: clear the pause and the trip streak. */
  clear(): void {
    this.#trips = 0;
    this.#pausedUntil = 0;
  }
}
