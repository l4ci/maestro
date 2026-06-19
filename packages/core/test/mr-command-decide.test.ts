// Pure MR-thread edge (mirror of the issue reconciler). React-once: the newest authorized
// body-start /maestro command that post-dates the bot's newest reply. Self-clears because
// the reply (carrying MR_COMMAND_REPLY_SENTINEL) is always posted. NO I/O.

import { describe, expect, it } from 'vitest';
import type { Comment, TriggerGuard } from '../src/contracts/index.js';
import { MR_COMMAND_REPLY_SENTINEL } from '../src/contracts/index.js';
import { decideMrCommand } from '../src/mr-command/decide.js';

const guard: TriggerGuard = { requireLabel: null, allowedActors: [] };

/** A /maestro command from `author`. */
const cmd = (body: string, createdAt: string, author: string): Comment => ({
  id: `${createdAt}-${author}`,
  author: { id: `id-${author}`, username: author },
  body,
  createdAt,
});
const cmdBy = cmd; // alias for readability in the shared-account case
/** The bot's reply carrying the sentinel. */
const reply = (createdAt: string): Comment => ({
  id: `reply-${createdAt}`,
  author: { id: 'id-bot', username: 'bot' },
  body: `### Done\n\n${MR_COMMAND_REPLY_SENTINEL}`,
  createdAt,
});
const plain = (body: string, createdAt: string, author: string): Comment => ({
  id: `${createdAt}-${author}`,
  author: { id: `id-${author}`, username: author },
  body,
  createdAt,
});

describe('decideMrCommand — react-once self-clearing edge', () => {
  it('(a) command after no reply → run, instruction stripped of the leading token', () => {
    expect(
      decideMrCommand(
        [cmd('/maestro make sure this works', '2026-02-02', 'maintainer')],
        'bot',
        guard,
      ),
    ).toEqual({ kind: 'run-mr-command', instruction: 'make sure this works' });
  });

  it('(b) command OLDER than the last bot reply → none', () => {
    expect(
      decideMrCommand(
        [reply('2026-02-03'), cmd('/maestro x', '2026-02-02', 'maintainer')],
        'bot',
        guard,
      ).kind,
    ).toBe('none');
  });

  it('(c) no /maestro comment → none', () => {
    expect(
      decideMrCommand([plain('just a note', '2026-02-02', 'maintainer')], 'bot', guard).kind,
    ).toBe('none');
  });

  it('(d) two stacked commands after last reply → newest wins', () => {
    const got = decideMrCommand(
      [cmd('/maestro newer', '2026-02-05', 'm'), cmd('/maestro older', '2026-02-04', 'm')],
      'bot',
      guard,
    );
    expect(got).toEqual({ kind: 'run-mr-command', instruction: 'newer' });
  });

  it('(e) allowlist set, author not on it → none (fail-closed)', () => {
    expect(
      decideMrCommand([cmd('/maestro x', '2026-02-02', 'stranger')], 'bot', {
        requireLabel: null,
        allowedActors: ['maintainer'],
      }).kind,
    ).toBe('none');
  });

  it('(e2) allowlist set, author on it → run', () => {
    expect(
      decideMrCommand([cmd('/maestro x', '2026-02-02', 'maintainer')], 'bot', {
        requireLabel: null,
        allowedActors: ['maintainer'],
      }),
    ).toEqual({ kind: 'run-mr-command', instruction: 'x' });
  });

  it('(f) shared account: bot-authored body-start /maestro counts as human', () => {
    expect(decideMrCommand([cmdBy('/maestro x', '2026-02-02', 'bot')], 'bot', guard).kind).toBe(
      'run-mr-command',
    );
  });

  it('(g) a mid-body /maestro inside a bot comment is NOT a command', () => {
    expect(
      decideMrCommand([cmd('please\n/maestro x', '2026-02-02', 'bot')], 'bot', guard).kind,
    ).toBe('none');
  });

  it('(h) the returned instruction never carries the leading /maestro token', () => {
    const got = decideMrCommand([cmd('/maestro   fix the lint', '2026-02-02', 'm')], 'bot', guard);
    expect(got).toEqual({ kind: 'run-mr-command', instruction: 'fix the lint' });
    if (got.kind === 'run-mr-command') expect(got.instruction.startsWith('/maestro')).toBe(false);
  });

  it('(i) dedicated account: a body-start @bot mention from a human triggers, prefix stripped', () => {
    expect(
      decideMrCommand([cmd('@bot fix the e2e tests', '2026-02-02', 'maintainer')], 'bot', guard),
    ).toEqual({ kind: 'run-mr-command', instruction: 'fix the e2e tests' });
  });

  it('(j) shared account: a @bot mention authored BY the bot is NOT a command', () => {
    expect(decideMrCommand([cmdBy('@bot fix it', '2026-02-02', 'bot')], 'bot', guard).kind).toBe(
      'none',
    );
  });

  it('(k) a mid-body @bot mention (casual chatter) does not trigger', () => {
    expect(
      decideMrCommand([cmd('I think @bot missed a case', '2026-02-02', 'maintainer')], 'bot', guard)
        .kind,
    ).toBe('none');
  });

  it('(l) @bot mention still respects the allowlist (fail-closed)', () => {
    expect(
      decideMrCommand([cmd('@bot x', '2026-02-02', 'stranger')], 'bot', {
        requireLabel: null,
        allowedActors: ['maintainer'],
      }).kind,
    ).toBe('none');
  });
});
