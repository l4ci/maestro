// main wiring — `run(argv)` parses and dispatches, mapping a usage-error to a nonzero exit
// WITHOUT a stacktrace (the message goes to stderr). This is the only main test needed;
// the commands themselves are tested in isolation.

import { afterEach, describe, expect, it, vi } from 'vitest';

// `maestro daemon` must route to the daemon boot path (#28) instead of the deep
// `dist/daemon.js` invocation. Mock bootDaemon so the test never starts the real loop.
// vi.hoisted keeps the spy reachable from the hoisted vi.mock factory.
const { bootDaemon } = vi.hoisted(() => ({ bootDaemon: vi.fn(async () => 0) }));
vi.mock('../src/daemon.js', () => ({ bootDaemon }));

import { run } from '../src/main.js';

describe('run (usage-error → nonzero exit, no stacktrace)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns a nonzero code and prints the message to stderr on bad input', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await run(['add']); // missing url → usage-error
    expect(code).not.toBe(0);
    expect(err).toHaveBeenCalled();
    const printed = err.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toMatch(/url/i);
    expect(printed).not.toMatch(/at .*\(.*:\d+:\d+\)/); // no stacktrace frames
  });

  it('returns 0 and prints help for an unknown verb', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await run(['frobnicate']);
    expect(code).toBe(0);
  });

  it('routes `daemon` to bootDaemon and returns its exit code', async () => {
    const code = await run(['daemon']);
    expect(bootDaemon).toHaveBeenCalledOnce();
    expect(code).toBe(0);
  });
});
