// Runner ↔ agent contract (spec §0.9 / §10). The daemon consumes ONLY AgentResult
// from a run; everything else it re-reads from the forge next tick. The {status,
// summary} core is FROZEN; #48 ADDS optional plan-channel fields (the agent can't
// touch the forge, so the daemon writes the plan it returns) — purely additive.

import type { Comment, Issue, MergeRequest } from './forge-model.js';

export type AgentStatus = 'done' | 'needs_input' | 'in_progress';

/** The role a dispatch runs as (#29): one purpose-built prompt per lifecycle stage.
 *  Prompt sections live in WORKFLOW.md (`## role: <name>`, workflow/roles.ts). */
export const AGENT_ROLES = ['define', 'plan', 'implement', 'review'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

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
  /** The internal review agent's verdict (#29 P3) — only meaningful from the `review`
   *  role. `pass` lets the daemon run the human handoff; `fail` posts the findings
   *  (with a round marker) and sends the issue back to implementation. */
  review?: { verdict: 'pass' | 'fail'; findings?: string };
  /** Set when the run failed because the Claude account is usage/rate-limited (#47).
   *  The daemon pauses ALL agent spawning until `resetAt` (epoch ms, when the CLI
   *  reported one) or its own capped exponential backoff. Additive like the above. */
  rateLimit?: { resetAt?: number };
}

/** Body-start `/maestro` — the only comment shape provably typed by a human when the
 *  bot account IS the operator account (shared-account convention): the agent cannot
 *  touch the forge (§13.1) and every daemon comment template leads with a heading.
 *  Anchored, deliberately NOT multiline: agent-returned text rides mid-body inside
 *  daemon comments, so a smuggled `/maestro` line must never count. */
export const MAESTRO_COMMAND_RE = /^\/maestro\b/;

/** Idempotency marker the daemon embeds in the one-time plan-summary issue comment,
 *  so a resumed/re-run tick never double-posts it (#48). */
export const PLAN_COMMENT_SENTINEL = '<!-- maestro:plan -->';

/** Marker on the define agent's acceptance-criteria draft comment (#29). Its presence
 *  is what the human definition gate approves (todo label or /maestro approve). */
export const AC_DRAFT_SENTINEL = '<!-- maestro:ac-draft -->';

/** Marks the bot's reply to an MR command (the standalone-MR `/maestro` trigger). Its
 *  presence newer than a command comment retires the edge — the reply is posted on every
 *  terminal path (success / no-op / needs_input / error), so the edge cannot loop. */
export const MR_COMMAND_REPLY_SENTINEL = '<!-- maestro:mr-reply -->';

/** Internal review verdict markers (#29 P3). Machine-readable HTML comments in the
 *  issue thread: durable across cold sessions/evictions, invisible to humans, and
 *  unspoofable by prose. The round number makes the bounce cap derivable read-only
 *  from the snapshot — count fails since the last human comment. */
export const REVIEW_PASS_SENTINEL = '<!-- maestro:review-pass -->';
export const REVIEW_FAIL_RE = /<!-- maestro:review-fail round=(\d+) -->/;
export function reviewFailMarker(round: number): string {
  return `<!-- maestro:review-fail round=${round} -->`;
}

/** CI-failure marker (#118). The daemon posts it alongside the failing pipeline's logs
 *  when it bounces a red-CI handoff back to the agent; counting occurrences since the
 *  last human comment makes the CI-fix round cap derivable read-only from the snapshot,
 *  exactly like {@link REVIEW_FAIL_RE}. */
export const CI_FAIL_SENTINEL = '<!-- maestro:ci-fail -->';

export interface RunnerInput {
  workspaceDir: string;
  promptBody: string; // WORKFLOW.md body + operating protocol (§9)
  // `issue` is absent for a command-MR run (a standalone MR has no backing issue, §MR-command);
  // every issue-lifecycle run still supplies it.
  context: { issue?: Issue; mr?: MergeRequest; recentComments: Comment[] };
  claude: {
    command: string;
    maxTurns: number;
    permissionMode: string;
    /** Per-run stall window (ms). No agent stream events past this → kill + retry once.
     *  From WORKFLOW.md `claude.stall_timeout_seconds`; absent → the runner's default. */
    stallTimeoutMs?: number;
    /** Whole-run ceiling (ms), consumed only by HerdrRunner's poll loop (spec §8
     *  amendment). From WORKFLOW.md `claude.run_timeout_seconds`; absent → the runner's
     *  default. The headless runner ignores this (max_turns bounds that run instead). */
    runTimeoutMs?: number;
  };
}

export interface Runner {
  run(input: RunnerInput): Promise<AgentResult>; // cold session; parses final stream-json result
}
