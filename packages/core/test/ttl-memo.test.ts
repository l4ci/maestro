import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TtlMemoizer } from '../src/utils/ttl-memo.js';

describe('TtlMemoizer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('executes the factory once and caches the promise', async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const memo = new TtlMemoizer(1_000);

    const p1 = memo.get('k', fn);
    const p2 = memo.get('k', fn);

    expect(p1).toBe(p2); // same promise reference
    expect(fn).toHaveBeenCalledTimes(1);
    expect(await p1).toBe(42);
  });

  it('re-executes only after the TTL expires', async () => {
    const fn = vi.fn().mockResolvedValue('first');
    const memo = new TtlMemoizer(5_000);

    void memo.get('x', fn);
    expect(fn).toHaveBeenCalledTimes(1);

    // Before TTL expires → still cached
    void memo.get('x', fn);
    expect(fn).toHaveBeenCalledTimes(1);

    // After TTL expires → re-executes
    fn.mockResolvedValue('second');
    vi.advanceTimersByTime(5_001);
    const v = await memo.get('x', fn);
    expect(v).toBe('second');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('releases the entry on rejection so a later call retries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));
    const memo = new TtlMemoizer(10_000);

    await expect(memo.get('y', fn)).rejects.toThrow('fail');

    // A subsequent call after the failed promise settles recreates the entry
    fn.mockResolvedValue('recovered');
    expect(await memo.get('y', fn)).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
