import { describe, expect, it } from 'vitest';
import type { Rng } from '../src/daemon/clock.js';
import { Scheduler, pickJitter } from '../src/daemon/scheduler.js';

// Part D — adaptive interval + jitter (§14). All time/randomness is injected: a fake
// clock supplies `now`, a seeded RNG supplies jitter. No real time runs here.

const intervals = { active: 30_000, idle: 300_000, jitter: 5_000 };

/** Deterministic RNG over a fixed sequence of [0,1) values (wraps around). */
function seqRng(values: number[]): Rng {
  let i = 0;
  return { next: () => values[i++ % values.length] as number };
}

describe('D1 — an active repo polls fast (poll_interval_active)', () => {
  it('schedules now + active + jitter', () => {
    const sched = new Scheduler(intervals, seqRng([0.5])); // jitter = floor(0.5 * 5001) = 2500
    const at = sched.schedule('repoA', true, 1_000_000);
    expect(at).toBe(1_000_000 + 30_000 + 2_500);
    expect(sched.nextTickAt('repoA')).toBe(at);
  });
});

describe('D2 — an idle repo polls slow (poll_interval_idle)', () => {
  it('schedules now + idle + jitter when nothing was active', () => {
    const sched = new Scheduler(intervals, seqRng([0])); // jitter = 0
    const at = sched.schedule('repoB', false, 2_000_000);
    expect(at).toBe(2_000_000 + 300_000 + 0);
  });

  it('reports due only once now has reached nextTickAt', () => {
    const sched = new Scheduler(intervals, seqRng([0]));
    sched.schedule('repoB', false, 0); // next at 300_000
    expect(sched.due('repoB', 299_999)).toBe(false);
    expect(sched.due('repoB', 300_000)).toBe(true);
    expect(sched.due('never-scheduled', 0)).toBe(true); // unseen repo ticks immediately
  });
});

describe('D3 — jitter is bounded [0, poll_jitter] and spreads', () => {
  it('every offset is within range', () => {
    for (const x of [0, 0.25, 0.5, 0.99, 0.999999]) {
      const j = pickJitter(seqRng([x]), 5_000);
      expect(j).toBeGreaterThanOrEqual(0);
      expect(j).toBeLessThanOrEqual(5_000);
    }
  });

  it('produces a spread of values, not all identical', () => {
    const rng = seqRng([0.1, 0.4, 0.7, 0.95, 0.2, 0.6]);
    const offsets = new Set(Array.from({ length: 6 }, () => pickJitter(rng, 5_000)));
    expect(offsets.size).toBeGreaterThan(1);
  });
});
