// Shared comment predicates (§13.1). Extracted from reconcile.ts so the issue
// reconciler and the MR-command edge (decideMrCommand) test ONE predicate, not two
// drifting copies. Pure, no I/O — imports only frozen contracts.

import type { Comment } from '../contracts/index.js';
import { MAESTRO_COMMAND_RE } from '../contracts/index.js';

/**
 * A comment provably written by a human. A different author is the normal proof. The
 * same-account escape hatch (bot account == operator account): a body STARTING with
 * `/maestro` — the agent cannot touch the forge (no token, §13.1) and every daemon
 * comment template leads with a heading, so a body-start command can only come from a
 * keyboard. Deliberately NOT multiline: agent-returned text rides mid-body inside daemon
 * comments, so a smuggled `/maestro` line must never count.
 */
export function isHumanComment(c: Comment, botUser: string): boolean {
  return c.author.username !== botUser || MAESTRO_COMMAND_RE.test(c.body);
}

/** Regex-escape a bot handle so it can be embedded literally. Forge usernames are
 *  `[A-Za-z0-9._-]`, but `.`/`-` are still escaped so e.g. `acme.bot` can't match
 *  `acmeXbot`. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

/** Body-start `@<botUser>` mention, anchored like {@link MAESTRO_COMMAND_RE}. */
function mentionRe(botUser: string): RegExp {
  return new RegExp(`^@${escapeRe(botUser)}\\b`);
}

/**
 * A body-start command DIRECTED AT the bot — the trigger shape every command channel
 * accepts (issue-thread feedback, the standalone-MR command). Two equivalent ways to write
 * one:
 *   • `/maestro …` — works from ANY account, including the bot's own (the shared-account
 *     escape hatch); see {@link isHumanComment}.
 *   • `@<botUser> …` — addressing the bot like a teammate, but ONLY when the author is NOT
 *     the bot itself. On a dedicated bot account every operator is a different author, so
 *     the mention is provably human; on a shared account the author IS the bot, so the
 *     mention branch can never fire and `/maestro` stays the sole hatch. That author check
 *     IS the "only when he has his own account" condition — derived, never configured.
 *
 * Anchored at body-start like `/maestro` (and the mention gated on a non-bot author), so a
 * mid-body mention — agent prose echoed inside a daemon comment, or casual review chatter —
 * never counts. `botUser` may be undefined (the shared-account snapshot path that can't tell
 * daemon from operator): then only the `/maestro` shape is recognised.
 */
export function isMaestroCommand(c: Comment, botUser: string | undefined): boolean {
  if (MAESTRO_COMMAND_RE.test(c.body)) return true;
  if (botUser === undefined) return false;
  return c.author.username !== botUser && mentionRe(botUser).test(c.body);
}

/** Strip whichever command prefix (`/maestro` or `@<botUser>`) opened the body, leaving the
 *  bare instruction. Only one can match a given body — both are body-start anchored. */
export function stripCommandPrefix(body: string, botUser: string): string {
  return body.replace(MAESTRO_COMMAND_RE, '').replace(mentionRe(botUser), '').trim();
}

/** The define-gate approval shape (#29): `<prefix> approve` at a line start, for either
 *  prefix. Multiline like the original `/maestro approve` so an approve can ride its own
 *  line after prose; the `@<bot>` form additionally requires a non-bot author, mirroring
 *  {@link isMaestroCommand}. The call site still composes this with {@link isHumanComment}. */
export function isApproveCommand(c: Comment, botUser: string): boolean {
  if (/^\/maestro\s+approve\b/m.test(c.body)) return true;
  return (
    c.author.username !== botUser &&
    new RegExp(`^@${escapeRe(botUser)}\\s+approve\\b`, 'm').test(c.body)
  );
}
