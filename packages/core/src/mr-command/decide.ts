// Pure MR-thread edge — the standalone-MR mirror of the issue reconciler (spec
// §4). Total, deterministic, side-effect free: (thread, botUser, guard) → at most one
// intent. NO I/O, NO async; imports only contracts + the shared comment predicate.

import type { Comment, TriggerGuard } from '../contracts/index.js';
import { MAESTRO_COMMAND_RE, MR_COMMAND_REPLY_SENTINEL } from '../contracts/index.js';
import { isHumanComment } from '../forge/comments.js';

export type MrCommandIntent = { kind: 'run-mr-command'; instruction: string } | { kind: 'none' };

/**
 * React-once, self-clearing: run the NEWEST authorized body-start `/maestro` command that
 * post-dates the bot's newest reply (the comment carrying MR_COMMAND_REPLY_SENTINEL). The
 * reply is posted on every terminal path, so `lastReplyAt` always advances past the command
 * and the next tick derives `none` — the edge can never loop (the issue #5 lesson, stronger
 * here because the clear is a reply, not a push that may never happen).
 *
 * Authorized = a human comment under the shared-account rule (isHumanComment: a different
 * author, OR a body-start `/maestro`), AND — when guard.allowedActors is non-empty — the
 * author is on the allowlist (fail-closed). `thread` is newest-first.
 */
export function decideMrCommand(
  thread: Comment[],
  botUser: string,
  guard: TriggerGuard,
): MrCommandIntent {
  const lastReplyAt =
    thread.find((c) => c.author.username === botUser && c.body.includes(MR_COMMAND_REPLY_SENTINEL))
      ?.createdAt ?? '';
  const authorized = (c: Comment): boolean =>
    isHumanComment(c, botUser) &&
    (guard.allowedActors.length === 0 || guard.allowedActors.includes(c.author.username));
  const command = thread.find(
    (c) => MAESTRO_COMMAND_RE.test(c.body) && authorized(c) && c.createdAt > lastReplyAt,
  );
  if (!command) return { kind: 'none' };
  return {
    kind: 'run-mr-command',
    instruction: command.body.replace(MAESTRO_COMMAND_RE, '').trim(),
  };
}
