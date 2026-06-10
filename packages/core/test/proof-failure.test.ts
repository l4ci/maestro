// Pure proof-failure edge (#109) — streak → retry-or-park. Tested through the pure
// interface only: no TickContext, no mocks, mirroring after-run.test.ts.

import { describe, expect, it } from 'vitest';
import {
  PROOF_FAILURE_PARK_STREAK,
  decideProofFailure,
  proofFailureComment,
} from '../src/reconciler/proof-failure.js';

const failure = {
  strategy: 'playwright',
  message: 'proof generation failed (playwright): browser crashed during boot',
};

describe('decideProofFailure — consecutive-failure streak → decision (#109)', () => {
  it('streak 1 → retry next tick (silent, no park)', () => {
    expect(decideProofFailure(1, failure)).toEqual({ kind: 'retry-proof' });
  });

  it('streak 2 → still retry', () => {
    expect(decideProofFailure(2, failure)).toEqual({ kind: 'retry-proof' });
  });

  it('streak 3 (the cap) → park-blocked with the typed reason in the comment', () => {
    const decision = decideProofFailure(3, failure);
    expect(decision.kind).toBe('park-blocked');
    if (decision.kind !== 'park-blocked') throw new Error('unreachable');
    expect(decision.comment).toEqual(proofFailureComment(3, failure));
    expect(decision.comment).toContain('### 🚧 Blocked — proof generation failed');
    expect(decision.comment).toContain('3 consecutive attempts');
    // the typed failure is visible verbatim: strategy AND cause
    expect(decision.comment).toContain('`playwright`');
    expect(decision.comment).toContain('browser crashed during boot');
    // what un-parks it: the existing unblock edge (any human reply)
    expect(decision.comment).toContain('Reply in this thread to resume');
    expect(decision.comment).toContain('start the reply with `/maestro`');
  });

  it('beyond the cap (post-unblock failures, streak uncleared) → still park', () => {
    expect(decideProofFailure(4, failure).kind).toBe('park-blocked');
    expect(decideProofFailure(99, failure).kind).toBe('park-blocked');
  });

  it('the cap itself is 3 — the decided design, pinned', () => {
    expect(PROOF_FAILURE_PARK_STREAK).toBe(3);
  });

  it('is pure: same inputs, same decision', () => {
    expect(decideProofFailure(3, failure)).toEqual(decideProofFailure(3, failure));
  });
});
