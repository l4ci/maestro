// Pure after-run edge (§0.9) — the runner-result half of the issue lifecycle. The
// decision table is tested through the pure interface only: no TickContext, no mocks.

import { describe, expect, it } from 'vitest';
import type { AgentResult } from '../src/contracts/index.js';
import { blockedComment, decideAfterRun } from '../src/reconciler/after-run.js';

const result = (over: Partial<AgentResult> = {}): AgentResult => ({
  status: 'done',
  summary: 'did the thing',
  ...over,
});

const legacy = { hasMr: true, rolesDeclared: false };
const pipeline = { hasMr: true, rolesDeclared: true };

describe('decideAfterRun — runner-result → lifecycle decision', () => {
  it('done on a legacy repo → proof-and-handoff', () => {
    expect(decideAfterRun(result(), legacy)).toEqual({ kind: 'proof-and-handoff' });
  });

  it('done on a role-pipeline repo → proof-only-then-in-review (no human ping yet)', () => {
    expect(decideAfterRun(result(), pipeline)).toEqual({ kind: 'proof-only-then-in-review' });
  });

  it('done with no MR → no-mr-error, regardless of roles', () => {
    expect(decideAfterRun(result(), { hasMr: false, rolesDeclared: false })).toEqual({
      kind: 'no-mr-error',
    });
    // hasMr is checked BEFORE rolesDeclared — a pipeline repo without an MR is
    // still an error, never a silent proof-only.
    expect(decideAfterRun(result(), { hasMr: false, rolesDeclared: true })).toEqual({
      kind: 'no-mr-error',
    });
  });

  it('needs_input → mark-blocked carrying the blocked comment with the summary verbatim', () => {
    const decision = decideAfterRun(
      result({ status: 'needs_input', summary: '1. which database?\n2. which region?' }),
      legacy,
    );
    expect(decision).toEqual({
      kind: 'mark-blocked',
      comment: blockedComment('1. which database?\n2. which region?'),
    });
    if (decision.kind !== 'mark-blocked') throw new Error('unreachable');
    expect(decision.comment).toContain('### 🚧 Blocked — input needed');
    expect(decision.comment).toContain('1. which database?\n2. which region?');
    expect(decision.comment).toContain('start the reply with `/maestro`');
  });

  it('in_progress → wait (no labels touched; the next tick resumes)', () => {
    expect(decideAfterRun(result({ status: 'in_progress' }), legacy)).toEqual({ kind: 'wait' });
    expect(decideAfterRun(result({ status: 'in_progress' }), pipeline)).toEqual({ kind: 'wait' });
  });

  it('rateLimit takes precedence over EVERY status — the spawn was doomed, not the issue', () => {
    const resetAt = Date.UTC(2026, 0, 1, 12, 0, 0);
    for (const status of ['done', 'needs_input', 'in_progress'] as const) {
      expect(decideAfterRun(result({ status, rateLimit: { resetAt } }), pipeline)).toEqual({
        kind: 'pause-spawns',
        resetAt: '2026-01-01T12:00:00.000Z',
      });
    }
  });

  it('rateLimit without a CLI-reported reset → pause-spawns without resetAt', () => {
    expect(decideAfterRun(result({ rateLimit: {} }), legacy)).toEqual({ kind: 'pause-spawns' });
  });

  it('pause-spawns resetAt round-trips through Date.parse without losing precision', () => {
    const resetAt = 1767268800123; // arbitrary epoch ms with a sub-second component
    const decision = decideAfterRun(result({ rateLimit: { resetAt } }), legacy);
    if (decision.kind !== 'pause-spawns' || decision.resetAt === undefined)
      throw new Error('unreachable');
    expect(Date.parse(decision.resetAt)).toBe(resetAt);
  });
});
