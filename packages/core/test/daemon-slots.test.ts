import { describe, expect, it } from 'vitest';
import { SlotAccountant } from '../src/daemon/slots.js';

// The accountant is the §14 concurrency gate: it bounds *active workers* globally
// (global_max) and per repo (max_active). Only active work (start-new / run-agent)
// ever acquires; everything else (poll/merge/blocked/handoff/none) never touches it.

describe('SlotAccountant — §14 concurrency accounting', () => {
  it('reports a slot available when under both caps', () => {
    const slots = new SlotAccountant(2);
    expect(slots.available('repoA', 2)).toBe(true);
  });

  it('global cap blocks new work once globalMax acquired', () => {
    const slots = new SlotAccountant(1);
    slots.acquire('repoA');
    expect(slots.available('repoB', 2)).toBe(false); // global is full, other repo blocked
  });

  it('per-repo maxActive blocks a single busy repo with global headroom', () => {
    const slots = new SlotAccountant(4);
    slots.acquire('repoA');
    expect(slots.available('repoA', 1)).toBe(false); // repo at its cap
    expect(slots.available('repoB', 1)).toBe(true); // other repo still free (global headroom)
  });

  it('release frees the slot (global and per-repo) for reuse', () => {
    const slots = new SlotAccountant(1);
    const release = slots.acquire('repoA');
    expect(slots.available('repoA', 1)).toBe(false);
    release();
    expect(slots.available('repoA', 1)).toBe(true);
  });

  it('release is idempotent — calling twice does not double-decrement', () => {
    const slots = new SlotAccountant(2);
    const release = slots.acquire('repoA');
    release();
    release(); // must not drive the count negative
    slots.acquire('repoA');
    slots.acquire('repoA');
    expect(slots.available('repoA', 5)).toBe(false); // global (2) full after two real acquires
  });

  it('tracks global and per-repo active counts independently', () => {
    const slots = new SlotAccountant(4);
    slots.acquire('repoA');
    slots.acquire('repoA');
    slots.acquire('repoB');
    expect(slots.globalActive).toBe(3);
    expect(slots.activeFor('repoA')).toBe(2);
    expect(slots.activeFor('repoB')).toBe(1);
    expect(slots.activeFor('repoC')).toBe(0);
  });
});
