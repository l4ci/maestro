// The shared human-comment predicate (extracted from reconcile.ts, behaviour-preserving).
// Same shared-account rule (§13.1): a DIFFERENT author is human, OR a body STARTING with
// `/maestro` (the only shape an operator can type from the bot's own account). Body-start
// only — a smuggled mid-body `/maestro` inside a daemon comment must never count.

import { describe, expect, it } from 'vitest';
import type { Comment } from '../src/contracts/index.js';
import {
  isApproveCommand,
  isHumanComment,
  isMaestroCommand,
  stripCommandPrefix,
} from '../src/forge/comments.js';

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
    expect(
      isHumanComment(c({ author: { id: '1', username: 'bot' }, body: '/maestro do x' }), 'bot'),
    ).toBe(true);
  });

  it('bot author, mid-body /maestro is NOT human', () => {
    expect(
      isHumanComment(c({ author: { id: '1', username: 'bot' }, body: 'plan\n/maestro x' }), 'bot'),
    ).toBe(false);
  });

  it('bot author, plain body is NOT human', () => {
    expect(
      isHumanComment(c({ author: { id: '1', username: 'bot' }, body: 'just a note' }), 'bot'),
    ).toBe(false);
  });

  it('an @-mention does NOT make a bot-authored comment human (shared-account hatch is /maestro-only)', () => {
    expect(
      isHumanComment(c({ author: { id: '1', username: 'bot' }, body: '@bot do x' }), 'bot'),
    ).toBe(false);
  });
});

describe('isMaestroCommand — /maestro OR body-start @<bot> from a non-bot author', () => {
  it('body-start /maestro from any author', () => {
    expect(
      isMaestroCommand(c({ author: { id: '1', username: 'bot' }, body: '/maestro x' }), 'bot'),
    ).toBe(true);
    expect(
      isMaestroCommand(c({ author: { id: '9', username: 'someone' }, body: '/maestro x' }), 'bot'),
    ).toBe(true);
  });

  it('body-start @<bot> from a NON-bot author counts (dedicated account)', () => {
    expect(
      isMaestroCommand(
        c({ author: { id: '9', username: 'volker' }, body: '@bot fix the tests' }),
        'bot',
      ),
    ).toBe(true);
  });

  it('body-start @<bot> from the BOT itself does NOT count (shared account)', () => {
    expect(
      isMaestroCommand(
        c({ author: { id: '1', username: 'bot' }, body: '@bot fix the tests' }),
        'bot',
      ),
    ).toBe(false);
  });

  it('a mid-body @<bot> mention never counts (chatter / agent prose)', () => {
    expect(
      isMaestroCommand(
        c({ author: { id: '9', username: 'volker' }, body: 'I think @bot was wrong' }),
        'bot',
      ),
    ).toBe(false);
  });

  it('@<bot> is matched whole — @bottle does not trigger @bot', () => {
    expect(
      isMaestroCommand(
        c({ author: { id: '9', username: 'volker' }, body: '@bottle of wine' }),
        'bot',
      ),
    ).toBe(false);
  });

  it('a dotted/hyphenated handle is escaped, not treated as a wildcard', () => {
    expect(
      isMaestroCommand(
        c({ author: { id: '9', username: 'v' }, body: '@maestro-bot go' }),
        'maestro-bot',
      ),
    ).toBe(true);
    expect(
      isMaestroCommand(c({ author: { id: '9', username: 'v' }, body: '@acmeXbot go' }), 'acme.bot'),
    ).toBe(false);
  });

  it('undefined botUser → only /maestro is recognised (shared-account snapshot path)', () => {
    expect(
      isMaestroCommand(c({ author: { id: '9', username: 'v' }, body: '@bot x' }), undefined),
    ).toBe(false);
    expect(
      isMaestroCommand(c({ author: { id: '9', username: 'v' }, body: '/maestro x' }), undefined),
    ).toBe(true);
  });
});

describe('stripCommandPrefix — drops whichever prefix opened the body', () => {
  it('strips /maestro', () => {
    expect(stripCommandPrefix('/maestro   fix the lint', 'bot')).toBe('fix the lint');
  });
  it('strips a leading @<bot> mention', () => {
    expect(stripCommandPrefix('@bot fix the lint', 'bot')).toBe('fix the lint');
  });
  it('leaves a mid-body mention untouched', () => {
    expect(stripCommandPrefix('/maestro ping @bot', 'bot')).toBe('ping @bot');
  });
});

describe('isApproveCommand — define-gate approve, either prefix', () => {
  it('/maestro approve (any author)', () => {
    expect(
      isApproveCommand(
        c({ author: { id: '1', username: 'bot' }, body: '/maestro approve' }),
        'bot',
      ),
    ).toBe(true);
  });
  it('@<bot> approve from a non-bot author', () => {
    expect(
      isApproveCommand(c({ author: { id: '9', username: 'v' }, body: '@bot approve' }), 'bot'),
    ).toBe(true);
  });
  it('@<bot> approve from the bot itself does NOT count', () => {
    expect(
      isApproveCommand(c({ author: { id: '1', username: 'bot' }, body: '@bot approve' }), 'bot'),
    ).toBe(false);
  });
  it('a plain comment is not an approval', () => {
    expect(
      isApproveCommand(c({ author: { id: '9', username: 'v' }, body: 'looks good' }), 'bot'),
    ).toBe(false);
  });
});
