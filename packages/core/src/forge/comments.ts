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
