// RateLimitGate (#47): process-wide Claude usage-limit backoff. Pure clock-injected
// unit — no I/O.

import { describe, expect, it } from 'vitest';
import { RateLimitGate } from '../src/daemon/rate-limit-gate.js';

const MIN = 60_000;

function gate(
  now: () => number,
  over: { baseMs?: number; capMs?: number; marginMs?: number } = {},
) {
  return new RateLimitGate({ now, baseMs: 5 * MIN, capMs: 60 * MIN, marginMs: 30_000, ...over });
}

describe('RateLimitGate (#47)', () => {
  it('open by default', () => {
    expect(gate(() => 1_000).pausedUntil()).toBeNull();
  });

  it('trips to the CLI-reported reset time plus a safety margin', () => {
    let t = 1_000_000;
    const g = gate(() => t);
    const until = g.trip(t + 10 * MIN);
    expect(until).toBe(t + 10 * MIN + 30_000);
    expect(g.pausedUntil()).toBe(until);
    t = until + 1; // clock passes the deadline → gate reopens on its own
    expect(g.pausedUntil()).toBeNull();
  });

  it('a stale reset time (already past) falls back to the backoff', () => {
    const t = 1_000_000;
    const g = gate(() => t);
    expect(g.trip(t - 1)).toBe(t + 5 * MIN); // base backoff, not the stale timestamp
  });

  it('consecutive trips without a reset time double from base up to the cap', () => {
    const t = 1_000_000;
    const g = gate(() => t);
    expect(g.trip()).toBe(t + 5 * MIN);
    expect(g.trip()).toBe(t + 10 * MIN);
    expect(g.trip()).toBe(t + 20 * MIN);
    expect(g.trip()).toBe(t + 40 * MIN);
    expect(g.trip()).toBe(t + 60 * MIN); // capped
    expect(g.trip()).toBe(t + 60 * MIN); // stays capped
  });

  it('clear() reopens the gate and resets the trip streak', () => {
    const t = 1_000_000;
    const g = gate(() => t);
    g.trip();
    g.trip();
    g.clear();
    expect(g.pausedUntil()).toBeNull();
    expect(g.trip()).toBe(t + 5 * MIN); // streak restarted at base
  });
});
