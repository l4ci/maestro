// Pure after-run edge (§0.9) — the runner-result half of the issue lifecycle, beside
// the pre-run reconciler so every lifecycle decision reads from one directory. Total,
// deterministic, side-effect free: (result, { hasMr, rolesDeclared }) → one decision.
// NO I/O, NO async; imports only contracts. The tick only executes the effects.

import type { AgentResult } from '../contracts/index.js';

export type AfterRunDecision =
  /** Rate-limited run (#47): the spawn was doomed, not an agent error. Pause ALL
   *  spawning and apply nothing — no plan write, no lifecycle transition; the issue
   *  resumes untouched once the gate reopens. `resetAt` is the CLI-reported reset
   *  time (ISO 8601) when present; absent → the gate's own capped backoff. */
  | { kind: 'pause-spawns'; resetAt?: string }
  /** done, legacy repo: post the proof AND hand off to a human reviewer. */
  | { kind: 'proof-and-handoff' }
  /** done, role pipeline (#29 P3): post the proof but NOT the handoff — the internal
   *  review gate decides when a human gets pinged. The in-review label is a
   *  projection for boards; the thread markers are the truth. */
  | { kind: 'proof-only-then-in-review' }
  /** done, but no MR to hand off — defensive; the tick logs an error. */
  | { kind: 'no-mr-error' }
  /** needs_input: flip to blocked and post `comment` on the issue thread. */
  | { kind: 'mark-blocked'; comment: string }
  /** in_progress: leave the labels untouched; the next tick resumes (§0.9). */
  | { kind: 'wait' };

/** Blocked comment (#25): a heading the thread can scan, the agent's questions verbatim
 *  (the STATUS_CONTRACT asks it to number multiple questions), and what unblocks it.
 *  Unblock detection keys on author + timestamp (repliesSinceBlock), not on this text. */
export function blockedComment(summary: string): string {
  return [
    '### 🚧 Blocked — input needed',
    '',
    summary,
    '',
    '_Reply in this thread to answer; maestro resumes this issue on its next pass. If you write from the bot’s own account, start the reply with `/maestro`._',
  ].join('\n');
}

/** §0.9 runner-result → lifecycle mapping — the decision the daemon executes.
 *  `rateLimit` takes precedence over `status` (a doomed spawn says nothing about the
 *  issue); then `done` branches on hasMr → rolesDeclared, mirroring the tick's old
 *  inline ordering exactly. */
export function decideAfterRun(
  result: AgentResult,
  ctx: { hasMr: boolean; rolesDeclared: boolean },
): AfterRunDecision {
  if (result.rateLimit) {
    const { resetAt } = result.rateLimit;
    return resetAt === undefined
      ? { kind: 'pause-spawns' }
      : { kind: 'pause-spawns', resetAt: new Date(resetAt).toISOString() };
  }
  switch (result.status) {
    case 'done':
      if (!ctx.hasMr) return { kind: 'no-mr-error' };
      return ctx.rolesDeclared
        ? { kind: 'proof-only-then-in-review' }
        : { kind: 'proof-and-handoff' };
    case 'needs_input':
      return { kind: 'mark-blocked', comment: blockedComment(result.summary) };
    default:
      return { kind: 'wait' };
  }
}
