// Runner ↔ agent contract (spec §0.9 / §10). The daemon consumes ONLY AgentResult
// from a run; everything else it re-reads from the forge next tick. The {status,
// summary} core is FROZEN; #48 ADDS optional plan-channel fields (the agent can't
// touch the forge, so the daemon writes the plan it returns) — purely additive.

import type { Comment, Issue, MergeRequest } from './forge-model.js';

export type AgentStatus = 'done' | 'needs_input' | 'in_progress';

export interface AgentResult {
  status: AgentStatus;
  summary: string;
  /**
   * Optional plan/progress the agent wants recorded ON THE FORGE (#48). The agent
   * has NO forge access (§13.1 — token scrubbed, cold isolated workspace), so it
   * returns this in its final JSON and the DAEMON writes it. Additive: the §0.9
   * status/summary contract is unchanged; consumers that ignore these still work.
   */
  /** Full MR description markdown — the durable detailed plan + checkbox todo. The
   *  agent rewrites it each session to tick boxes; the daemon writes it via
   *  `updateMRDescription`. The MR description is fed back in as context next tick. */
  mrDescription?: string;
  /** A short plan summary posted ONCE as an issue comment (first planning session).
   *  The daemon guards re-posting with {@link PLAN_COMMENT_SENTINEL}. */
  planComment?: string;
  /** Set when the run failed because the Claude account is usage/rate-limited (#47).
   *  The daemon pauses ALL agent spawning until `resetAt` (epoch ms, when the CLI
   *  reported one) or its own capped exponential backoff. Additive like the above. */
  rateLimit?: { resetAt?: number };
}

/** Idempotency marker the daemon embeds in the one-time plan-summary issue comment,
 *  so a resumed/re-run tick never double-posts it (#48). */
export const PLAN_COMMENT_SENTINEL = '<!-- maestro:plan -->';

export interface RunnerInput {
  workspaceDir: string;
  promptBody: string; // WORKFLOW.md body + operating protocol (§9)
  context: { issue: Issue; mr?: MergeRequest; recentComments: Comment[] };
  claude: { command: string; maxTurns: number; permissionMode: string };
}

export interface Runner {
  run(input: RunnerInput): Promise<AgentResult>; // cold session; parses final stream-json result
}
