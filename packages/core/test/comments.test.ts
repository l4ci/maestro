// The shared human-comment predicate (extracted from reconcile.ts, behaviour-preserving).
// Same shared-account rule (§13.1): a DIFFERENT author is human, OR a body STARTING with
// `/maestro` (the only shape an operator can type from the bot's own account). Body-start
// only — a smuggled mid-body `/maestro` inside a daemon comment must never count.

import { describe, expect, it } from 'vitest';
import type { Comment } from '../src/contracts/index.js';
import { isHumanComment } from '../src/forge/comments.js';

const c = (over: Partial<Comment>): Comment => ({
  id: '1',
  author: { id: '1', username: 'x' },
  body: '',
  createdAt: '2026-01-01',
  ...over,
});

describe('isHumanComment — shared-account rule (§13.1)', () => {
  it('a different author is human', () => {
    expect(isHumanComment(c({ author: { id: '9', username: 'someone' } }), 'bot')).toBe(true);
  });

  it('bot author with body-start /maestro is human', () => {
    expect(isHumanComment(c({ author: { id: '1', username: 'bot' }, body: '/maestro do x' }), 'bot')).toBe(true);
  });

  it('bot author, mid-body /maestro is NOT human', () => {
    expect(isHumanComment(c({ author: { id: '1', username: 'bot' }, body: 'plan\n/maestro x' }), 'bot')).toBe(false);
  });

  it('bot author, plain body is NOT human', () => {
    expect(isHumanComment(c({ author: { id: '1', username: 'bot' }, body: 'just a note' }), 'bot')).toBe(false);
  });
});
