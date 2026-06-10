// Pure proof-failure edge (#109, CONTEXT.md §Proof-failure escalation) — beside the
// after-run edge so every lifecycle decision reads from one directory. Total,
// deterministic, side-effect free: (streak, failure) → one decision. NO I/O, NO async;
// imports nothing.
//
// A throwing proof run (Playwright crash, health-check timeout, misconfigured command)
// used to vanish into the tick's guard log line: the issue retried the identical run
// every tick forever and the operator saw NOTHING on the forge — the one place they
// look. The daemon now counts consecutive failures per issue (in-memory, restart
// resets) and consults this edge: below the cap → retry next tick; at the cap →
// park-blocked with the typed reason on the issue thread. The streak clears on
// success; a human reply un-parks via the existing unblock edge.

/** Consecutive proof failures tolerated before parking: failures 1 and 2 retry. */
export const PROOF_FAILURE_PARK_STREAK = 3;

/** What the typed ProofGenerationError carries, flattened so this edge stays free of
 *  proof-module imports: which configured strategy threw, and its message (which
 *  already embeds the cause). */
export interface ProofFailure {
  strategy: string;
  message: string;
}

export type ProofFailureDecision =
  /** Below the cap: log and wait — the next tick re-runs the issue (and its proof). */
  | { kind: 'retry-proof' }
  /** At the cap: flip to blocked and post `comment` (the typed reason) on the thread. */
  | { kind: 'park-blocked'; comment: string };

/** Park comment (#109): a heading the thread can scan, the typed failure verbatim, and
 *  what unblocks it. Unblock detection keys on author + timestamp (the existing unblock
 *  edge), not on this text. */
export function proofFailureComment(streak: number, failure: ProofFailure): string {
  return [
    `### 🚧 Blocked — proof generation failed (${streak} consecutive attempts)`,
    '',
    `The \`${failure.strategy}\` proof strategy threw instead of producing a result:`,
    '',
    '```',
    failure.message,
    '```',
    '',
    'The agent’s work is committed and pushed; only the proof step is failing — check the `proof` / `environment` commands in this repo’s WORKFLOW.md.',
    '',
    '_Reply in this thread to resume; maestro re-runs the issue (and its proof) on its next pass. If you write from the bot’s own account, start the reply with `/maestro`._',
  ].join('\n');
}

/** Streak → decision. The streak is 1-based (the failure that just happened is counted
 *  in), so 1 and 2 retry and the third straight failure parks. */
export function decideProofFailure(streak: number, failure: ProofFailure): ProofFailureDecision {
  if (streak < PROOF_FAILURE_PARK_STREAK) return { kind: 'retry-proof' };
  return { kind: 'park-blocked', comment: proofFailureComment(streak, failure) };
}
