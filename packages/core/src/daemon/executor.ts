// The intent executor (#105, CONTEXT.md §Intent executor): the effect-side counterpart
// of the pure reconciler edges. ONE module owns the workspace → run → push → record →
// move choreography that the tick's run* handlers and the command-MR runner used to
// re-implement. The switch and the thin per-intent functions live HERE, sharing the
// private helpers (acquire workspace, run agent with role, push-if-committed, record
// plan, apply lifecycle move); a declarative execution-plan table was rejected —
// review-verdict handling and AC-draft comments don't fit data.
//
// Admission stays with the callers: the tick keeps claims, slot policy, and the
// rate-limit GATE (pausedUntil); mr-command-pass keeps its claim loop and pure decide.
// The executor only RECORDS rate-limit outcomes (trip/clear) — see RateGateRecorder.

import {
  AC_DRAFT_SENTINEL,
  type AgentResult,
  type Comment,
  type Exec,
  type ForgeAdapter,
  type HandoffFn,
  type Intent,
  type IssueSnapshot,
  MR_COMMAND_REPLY_SENTINEL,
  type MergeRequest,
  PLAN_COMMENT_SENTINEL,
  type ProofResult,
  REVIEW_PASS_SENTINEL,
  type RepoRef,
  type RepoSettings,
  type Runner,
  type RunnerInput,
  type WorkflowFrontMatter,
  reviewFailMarker,
} from '../contracts/index.js';
import { branchName, mrTitle } from '../contracts/naming.js';
import { buildMrCommandPrompt } from '../mr-command/prompt.js';
import { decideAfterRun } from '../reconciler/after-run.js';
import { type LifecycleMove, lifecycleMove } from '../reconciler/transitions.js';
import { type AgentRole, declaresRoles, promptForRole } from '../workflow/roles.js';
import type { Logger, ProofAndHandoffFn, ProofOnlyFn, WorkspaceHandleLike } from './ports.js';
import { repoKey } from './ports.js';

/** The workspace surface execution drives — acquire / prepare / seed / push / count.
 *  The cleanup-sweep and reconcile-input methods (evict, list*, workspaceExists) stay
 *  with the tick; the real M3 Workspace satisfies this structurally. */
export interface ExecutorWorkspace {
  ensureWorkspace(repo: RepoRef, iid: number, fromRef: string): Promise<WorkspaceHandleLike>;
  ensureMrWorkspace(repo: RepoRef, mrIid: number, fromRef: string): Promise<WorkspaceHandleLike>;
  prepareBranch(handle: WorkspaceHandleLike, branchName: string): Promise<void>;
  pushBranch(handle: WorkspaceHandleLike, branchName: string): Promise<void>;
  seedBranch(handle: WorkspaceHandleLike, branchName: string): Promise<void>;
  countUnpushedCommits(handle: WorkspaceHandleLike): Promise<number>;
}

/** The slice of the #47 rate gate execution touches: RECORD the run's outcome — trip on
 *  a rate-limited result, clear on a healthy one. The gating decision (pausedUntil)
 *  is admission and stays with the tick; the real RateLimitGate satisfies this. */
export interface RateGateRecorder {
  trip(resetAt?: number): number;
  clear(): void;
}

/**
 * What execution needs — a materially narrower subset of TickContext (#105): no
 * `claims` (admission), a workspace without the sweep methods, a rate gate without
 * the pause check. TickContext satisfies this structurally, so the tick passes its
 * context straight through; executor tests construct one from scratch.
 */
export interface ExecutorContext {
  adapter: ForgeAdapter; // §0.3
  workspace: ExecutorWorkspace; // M3 subset
  runner: Runner; // §0.9
  handoff: HandoffFn; // M4 — bare sequence (crash-recovery resume, review pass)
  proofAndHandoff: ProofAndHandoffFn; // M4 — generate proof + sequence (agent `done`)
  proofOnly: ProofOnlyFn; // #29 P3 — proof comment only; review gate runs the handoff
  exec: Exec; // §0.8 — proof generation runs commands through this
  settings: RepoSettings;
  workflow: WorkflowFrontMatter;
  promptBody: string; // WORKFLOW body → RunnerInput.promptBody
  rateGate: RateGateRecorder; // #47 — outcome recording only
  log: Logger;
}

/**
 * The ONE intent-kind → lifecycle-move wiring (#105): a new lifecycle state's execution
 * hookup touches this map (plus a case in `executeIntent` when it needs its own
 * choreography). Decision-keyed moves (enter-review / park-blocked — chosen by the
 * after-run edge or a review verdict, not by the intent) live with their decisions in
 * `applyAgentResult` / `runReview`; the cleanup sweep's retract-queued stays with the
 * tick. Label arithmetic itself stays in `lifecycleMove` (#78).
 */
const INTENT_MOVES = {
  'start-new': 'begin-work',
  'run-plan': 'begin-work-from-plan',
  'run-define': 'enter-define',
  'apply-changes-requested': 'resume-from-review',
  'apply-unblock': 'unblock',
  'mark-queued': 'mark-queued',
} as const satisfies Partial<Record<Intent['kind'], LifecycleMove>>;

/** Apply the intent's lifecycle move. `role` matters only for apply-unblock (#29). */
async function applyIntentMove(
  kind: keyof typeof INTENT_MOVES,
  snapshot: IssueSnapshot,
  ctx: ExecutorContext,
  role: AgentRole = 'implement',
): Promise<void> {
  const m = lifecycleMove(INTENT_MOVES[kind], ctx.settings.labels, role);
  await ctx.adapter.setIssueLabels(snapshot.repo, snapshot.issue.iid, m.set, m.unset);
}

/**
 * Execute one admitted Intent. Total over `Intent` — the non-acting kinds
 * (poll-review · blocked-wait · none · skip-untrusted · cleanup) are no-ops here; the
 * tick never dispatches them. Admission (claims, slots, rate gate, the intent log
 * line) already happened in the caller.
 */
export async function executeIntent(
  intent: Intent,
  snapshot: IssueSnapshot,
  ctx: ExecutorContext,
): Promise<void> {
  switch (intent.kind) {
    case 'start-new':
      return runStartNew(intent, snapshot, ctx);
    case 'run-agent': {
      const comments = intent.feedback?.reviewComments ?? snapshot.recentComments;
      return runAgent(snapshot, snapshot.mr, comments, ctx, intent.role ?? 'implement');
    }
    case 'run-define':
      return runDefine(snapshot, ctx);
    case 'run-plan':
      return runPlan(intent, snapshot, ctx);
    case 'run-review':
      return runReview(intent, snapshot, ctx);
    case 'apply-changes-requested':
      return runApplyChanges(intent, snapshot, ctx);
    case 'apply-unblock':
      return runApplyUnblock(intent, snapshot, ctx);
    case 'mark-queued':
      // Wants a slot, none free (#53/#29): one cheap label write. Visible as
      // maestro:queued until a slot frees.
      return applyIntentMove('mark-queued', snapshot, ctx);
    case 'merge':
      await ctx.adapter.mergeMR(
        snapshot.repo,
        mrIidOf(snapshot),
        intent.strategy,
        intent.deleteSource,
      );
      return;
    case 'handoff':
      return runRecoveryHandoff(snapshot, ctx);
    default:
      // poll-review · blocked-wait · none · skip-untrusted · cleanup (pass B owns it)
      return;
  }
}

/** Proof stand-in for the crash-recovery resume: the real proof is already on the
 *  forge (the sentinel is how we detected workComplete), so handoff skips re-posting. */
const RECOVERED_PROOF: ProofResult[] = [{ ok: true, kind: 'none', summary: '(recovered)' }];

/** Start-of-work comment (#25): structured, and says where the plan will land. The agent
 *  only produces its plan during the first session, so the daemon posts the plan summary
 *  right after it (recordPlan's "### 🎼 Plan" comment) instead of inventing one here. */
function startWorkComment(branch: string, mr: MergeRequest): string {
  const mrRef = mr.webUrl && mr.webUrl !== 'u' ? `[!${mr.iid}](${mr.webUrl})` : `!${mr.iid}`;
  return [
    '🎼 **maestro started work on this issue.**',
    '',
    `- Branch: \`${branch}\``,
    `- Draft MR: ${mrRef} — its description carries the live plan + todo list`,
    '',
    '_A short plan summary follows after the first working session._',
  ].join('\n');
}

/** Surface a #55 rescue: the workspace reset found committed-but-unpushed work and
 *  parked it on a rescue ref instead of destroying it — a human may want it back. */
function warnIfRescued(handle: WorkspaceHandleLike, ctx: ExecutorContext): void {
  if (handle.rescuedRef) {
    ctx.log.warn('workspace: parked unpushed commits before reset (#55)', {
      repo: handle.repo.project,
      iid: handle.iid,
      ref: handle.rescuedRef,
    });
  }
}

/** New issue → branch + draft MR + label + "started" comment, THEN run the agent
 *  (§7 New row ordering: everything review-facing is set up before the agent runs). */
async function runStartNew(
  intent: Extract<Intent, { kind: 'start-new' }>,
  snapshot: IssueSnapshot,
  ctx: ExecutorContext,
): Promise<void> {
  const { repo, issue } = snapshot;
  const target = ctx.settings.git.target;
  const handle = await ctx.workspace.ensureWorkspace(repo, issue.iid, target);
  warnIfRescued(handle, ctx);
  await ctx.workspace.prepareBranch(handle, intent.branch);
  await ctx.adapter.createBranch(repo, intent.branch, target);
  // Seed the branch with an empty commit before opening the PR: GitHub 422s a PR whose head
  // has no commits beyond base, and at this point the branch still equals `target` (#14).
  await ctx.workspace.seedBranch(handle, intent.branch);
  const mr = await ctx.adapter.createDraftMR(repo, {
    sourceBranch: intent.branch,
    targetBranch: target,
    title: intent.mrTitle,
    description: `Closes #${issue.iid}`,
    draft: true,
    assignToBot: true,
  });
  // in-progress replaces the queued marker (#53) — an agent is actually on it now.
  await applyIntentMove('start-new', snapshot, ctx);
  await ctx.adapter.commentIssue(repo, issue.iid, startWorkComment(intent.branch, mr));
  const result = await ctx.runner.run(
    buildRunnerInput(handle.dir, snapshot, mr, snapshot.recentComments, ctx),
  );
  // Push the agent's commits to the MR branch BEFORE handoff — the agent's env has the
  // forge token scrubbed (§13.1), so the daemon owns the push; without it the work never
  // reaches the PR. Pushed even on in_progress/needs_input so partial work persists.
  await ctx.workspace.pushBranch(handle, intent.branch);
  await applyAgentResult(result, snapshot, mr, handle.dir, ctx);
}

/** Resume an in-progress issue (no branch/MR creation). Re-materializes the workspace on
 *  the MR's OWN branch (not target) so the agent continues its prior commits, then pushes
 *  the new ones back. With no MR (defensive) it falls back to target and skips the push. */
async function runAgent(
  snapshot: IssueSnapshot,
  mr: MergeRequest | undefined,
  comments: IssueSnapshot['recentComments'],
  ctx: ExecutorContext,
  role: AgentRole = 'implement',
): Promise<void> {
  const fromRef = mr?.sourceBranch ?? ctx.settings.git.target;
  const handle = await ctx.workspace.ensureWorkspace(snapshot.repo, snapshot.issue.iid, fromRef);
  warnIfRescued(handle, ctx);
  const result = await ctx.runner.run(
    buildRunnerInput(handle.dir, snapshot, mr, comments, ctx, role),
  );
  if (mr) await ctx.workspace.pushBranch(handle, mr.sourceBranch);
  await applyAgentResult(result, snapshot, mr, handle.dir, ctx);
}

/** Backlog stage (#29): the define agent refines the request into an AC draft. No
 *  branch, no MR — its only output is the draft comment the human gate approves.
 *  needs_input routes through the normal blocked path (applyAgentResult). */
async function runDefine(snapshot: IssueSnapshot, ctx: ExecutorContext): Promise<void> {
  const { repo, issue } = snapshot;
  const handle = await ctx.workspace.ensureWorkspace(repo, issue.iid, ctx.settings.git.target);
  warnIfRescued(handle, ctx);
  const result = await ctx.runner.run(
    buildRunnerInput(handle.dir, snapshot, undefined, snapshot.recentComments, ctx, 'define'),
  );
  if (result.rateLimit || result.status === 'needs_input') {
    await applyAgentResult(result, snapshot, undefined, handle.dir, ctx);
    return;
  }
  // done = "AC draft ready" (there is no proof/handoff at this stage). The draft rides
  // the #48 planComment channel; the sentinel makes the gate check and re-posts cheap.
  if (result.status === 'done' && result.planComment) {
    const alreadyDrafted = snapshot.recentComments.some((c) => c.body.includes(AC_DRAFT_SENTINEL));
    if (!alreadyDrafted) {
      await ctx.adapter.commentIssue(
        repo,
        issue.iid,
        `### 📋 Acceptance criteria (draft)\n\n${result.planComment}\n\n_Approve by applying the \`${ctx.settings.labels.todo}\` label or replying \`/maestro approve\`._\n\n${AC_DRAFT_SENTINEL}`,
      );
    }
    await applyIntentMove('run-define', snapshot, ctx);
  }
  // in_progress (ran out of turns) → resume next tick; done without a draft → retry.
}

/** Todo stage (#29): the plan agent produces the plan FIRST; only then does the daemon
 *  create the branch + draft MR carrying it (the #48 channel made durable from birth),
 *  flip labels to in-progress, and post the structured start comment. */
async function runPlan(
  intent: Extract<Intent, { kind: 'run-plan' }>,
  snapshot: IssueSnapshot,
  ctx: ExecutorContext,
): Promise<void> {
  const { repo, issue } = snapshot;
  const target = ctx.settings.git.target;
  const handle = await ctx.workspace.ensureWorkspace(repo, issue.iid, target);
  warnIfRescued(handle, ctx);
  const result = await ctx.runner.run(
    buildRunnerInput(handle.dir, snapshot, undefined, snapshot.recentComments, ctx, 'plan'),
  );
  if (result.rateLimit || result.status === 'needs_input') {
    await applyAgentResult(result, snapshot, undefined, handle.dir, ctx);
    return;
  }
  if (result.status !== 'done') return; // out of turns — re-plan next tick (no MR yet)

  await ctx.workspace.prepareBranch(handle, intent.branch);
  await ctx.adapter.createBranch(repo, intent.branch, target);
  await ctx.workspace.seedBranch(handle, intent.branch); // PR-able head before createDraftMR (#14)
  const mr = await ctx.adapter.createDraftMR(repo, {
    sourceBranch: intent.branch,
    targetBranch: target,
    title: intent.mrTitle,
    description: withClosesTrailer(result.mrDescription ?? `Closes #${issue.iid}`, issue.iid),
    draft: true,
    assignToBot: true,
  });
  // The ONE move that consumes the human-set todo gate (#29) — planning is done.
  await applyIntentMove('run-plan', snapshot, ctx);
  await ctx.adapter.commentIssue(repo, issue.iid, startWorkComment(intent.branch, mr));
  if (result.planComment) {
    await ctx.adapter.commentIssue(
      repo,
      issue.iid,
      `### 🎼 Plan\n\n${result.planComment}\n\n${PLAN_COMMENT_SENTINEL}`,
    );
  }
}

/** Review asked for changes: flip in-review→in-progress, then run the agent with the
 *  review feedback threaded into context (§7 In-review→in-progress edge). */
async function runApplyChanges(
  intent: Extract<Intent, { kind: 'apply-changes-requested' }>,
  snapshot: IssueSnapshot,
  ctx: ExecutorContext,
): Promise<void> {
  await applyIntentMove('apply-changes-requested', snapshot, ctx);
  await runAgent(snapshot, snapshot.mr, intent.feedback.reviewComments, ctx);
}

/** Maintainer answered a blocked issue: flip blocked→in-progress, then run the agent with
 *  the answer threaded into context (§7 Blocked→in-progress edge). The label flip is what
 *  retires the edge — without it `deriveState` stays `blocked` and the next tick would
 *  re-resume on every poll. Mirrors runApplyChanges; the agent re-blocks if it needs more. */
async function runApplyUnblock(
  intent: Extract<Intent, { kind: 'apply-unblock' }>,
  snapshot: IssueSnapshot,
  ctx: ExecutorContext,
): Promise<void> {
  const role = intent.role ?? 'implement';
  // Only implementation restores in-progress; define/plan stages carry their own
  // labels already (#29) — the artifacts, not this flip, decide the stage.
  await applyIntentMove('apply-unblock', snapshot, ctx, role);
  // The human's answer is in recentComments — each stage handler reads it from there.
  if (role === 'define') return runDefine(snapshot, ctx);
  if (role === 'plan') {
    return runPlan(
      {
        kind: 'run-plan',
        branch: branchName(snapshot.issue),
        mrTitle: mrTitle(snapshot.issue),
      },
      snapshot,
      ctx,
    );
  }
  await runAgent(snapshot, snapshot.mr, intent.feedback.reviewComments, ctx, role);
}

/** review:internal stage (#29 P3): a cold code-review session over the diff. The
 *  verdict rides the final JSON. pass → pass marker + the idempotent human handoff
 *  (M4 — proof comment already posted, so it only assigns/undrafts/labels). fail →
 *  findings comment with a round marker (handoff context AND the countable bounce
 *  signal); at review.max_rounds since the last human action, escalate: blocked flag
 *  + a summary instead of another doomed bounce. */
async function runReview(
  intent: Extract<Intent, { kind: 'run-review' }>,
  snapshot: IssueSnapshot,
  ctx: ExecutorContext,
): Promise<void> {
  const { repo, issue } = snapshot;
  const mr = snapshot.mr;
  if (!mr) {
    ctx.log.error('review intent but no MR', { repo: repoKey(repo), iid: issue.iid });
    return;
  }
  const handle = await ctx.workspace.ensureWorkspace(repo, issue.iid, mr.sourceBranch);
  warnIfRescued(handle, ctx);
  const result = await ctx.runner.run(
    buildRunnerInput(handle.dir, snapshot, mr, snapshot.recentComments, ctx, 'review'),
  );
  if (result.rateLimit || result.status === 'needs_input') {
    await applyAgentResult(result, snapshot, mr, handle.dir, ctx);
    return;
  }
  if (result.status !== 'done' || !result.review) {
    // No verdict (out of turns / contract miss): retry next tick — never guess a pass.
    ctx.log.warn('review run ended without a verdict — will retry', {
      repo: repoKey(repo),
      iid: issue.iid,
      status: result.status,
    });
    return;
  }

  if (result.review.verdict === 'pass') {
    await ctx.adapter.commentIssue(
      repo,
      issue.iid,
      `### ✅ Internal review passed\n\n${result.summary}\n\n${REVIEW_PASS_SENTINEL}`,
    );
    await ctx.handoff({
      repo,
      issueIid: issue.iid,
      mrIid: mr.iid,
      ticketCreator: issue.author.username,
      settings: ctx.settings,
      adapter: ctx.adapter,
      proof: [{ ok: true, kind: 'none', summary: '(internal review passed)' }],
    });
    return;
  }

  const round = intent.rounds + 1;
  const findings = result.review.findings ?? result.summary;
  await ctx.adapter.commentIssue(
    repo,
    issue.iid,
    `### 🔍 Internal review — changes needed (round ${round})\n\n${findings}\n\n${reviewFailMarker(round)}`,
  );
  const maxRounds = ctx.workflow.review.max_rounds;
  if (round >= maxRounds) {
    // Bounce cap (#29): never auto-merge, never silently drop — park it for a human.
    const m = lifecycleMove('park-blocked', ctx.settings.labels);
    await ctx.adapter.setIssueLabels(repo, issue.iid, m.set, m.unset);
    await ctx.adapter.commentIssue(
      repo,
      issue.iid,
      `### 🚧 Blocked — review bounce cap reached (${maxRounds} rounds)\n\nThe internal review keeps finding blocking issues. Outstanding findings are in the round comments above.\n\n_Reply in this thread to reset the count and resume; any human comment clears it (from the bot’s own account, start with \`/maestro\`)._`,
    );
    ctx.log.warn('review bounce cap hit — escalated to blocked (#29)', {
      repo: repoKey(repo),
      iid: issue.iid,
      rounds: round,
    });
  }
}

/** §0.9 runner-result → lifecycle mapping. The DECISION lives in the pure after-run
 *  edge (reconciler/after-run.ts); this function only executes its effects. */
async function applyAgentResult(
  result: AgentResult,
  snapshot: IssueSnapshot,
  mr: MergeRequest | undefined,
  workspaceDir: string,
  ctx: ExecutorContext,
): Promise<void> {
  const { repo, issue } = snapshot;
  const decision = decideAfterRun(result, {
    hasMr: mr !== undefined,
    rolesDeclared: declaresRoles(ctx.promptBody),
  });
  // Rate-limited run (#47): the spawn was doomed, not an agent error. Pause ALL
  // spawning (CLI-reported reset time when present, else capped exponential backoff)
  // and apply nothing — no plan write, no lifecycle transition; the issue resumes
  // untouched once the gate reopens. A healthy run clears the gate's trip streak.
  if (decision.kind === 'pause-spawns') {
    const until = ctx.rateGate.trip(
      decision.resetAt === undefined ? undefined : Date.parse(decision.resetAt),
    );
    ctx.log.warn('claude rate-limited: pausing all agent spawns (#47)', {
      repo: repoKey(repo),
      iid: issue.iid,
      resumeAt: new Date(until).toISOString(),
    });
    return;
  }
  ctx.rateGate.clear();
  // #48: the agent can't touch the forge (§13.1), so the daemon writes the plan it
  // returned — regardless of status — BEFORE the status switch, so an in_progress run
  // still records its plan and a done run lands the fully-ticked todo. The MR
  // description is the durable detailed plan/todo; the issue gets a one-time summary.
  await recordPlan(result, snapshot, mr, ctx);
  switch (decision.kind) {
    case 'no-mr-error':
      ctx.log.error('agent done but no MR to hand off', { repo: repoKey(repo), iid: issue.iid });
      return;
    // Role pipeline (#29 P3): implementation `done` posts the proof but NOT the
    // handoff — the internal review gate decides when a human gets pinged. The
    // in-review label is a projection for boards; the thread markers are the truth.
    case 'proof-only-then-in-review': {
      if (!mr) return; // unreachable: the decision implies hasMr
      await ctx.proofOnly({
        repo,
        issueIid: issue.iid,
        mrIid: mr.iid,
        ticketCreator: issue.author.username,
        settings: ctx.settings,
        adapter: ctx.adapter,
        proofInput: {
          workspaceDir,
          strategies: ctx.workflow.proof,
          environment: ctx.workflow.environment,
          exec: ctx.exec,
        },
      });
      const m = lifecycleMove('enter-review', ctx.settings.labels);
      await ctx.adapter.setIssueLabels(repo, issue.iid, m.set, m.unset);
      return;
    }
    case 'proof-and-handoff': {
      if (!mr) return; // unreachable: the decision implies hasMr
      await ctx.proofAndHandoff({
        repo,
        issueIid: issue.iid,
        mrIid: mr.iid,
        ticketCreator: issue.author.username,
        settings: ctx.settings,
        adapter: ctx.adapter,
        proofInput: {
          workspaceDir,
          strategies: ctx.workflow.proof, // already normalized to a list by WorkflowSchema
          environment: ctx.workflow.environment,
          exec: ctx.exec,
        },
      });
      return;
    }
    case 'mark-blocked': {
      const m = lifecycleMove('park-blocked', ctx.settings.labels);
      await ctx.adapter.setIssueLabels(repo, issue.iid, m.set, m.unset);
      await ctx.adapter.commentIssue(repo, issue.iid, decision.comment);
      return;
    }
    case 'wait':
      // in_progress → leave the labels untouched; the next tick resumes (§0.9).
      return;
  }
}

/**
 * Write the agent's plan to the forge (#48). `mrDescription` (the durable detailed
 * plan + checkbox todo) is set via the idempotent `updateMRDescription`, with the
 * `Closes #N` auto-close trailer preserved. `planComment` is posted once as an issue
 * comment, guarded by a sentinel read from this tick's snapshot so a later tick (which
 * re-reads the snapshot, now carrying the comment) never double-posts.
 */
async function recordPlan(
  result: AgentResult,
  snapshot: IssueSnapshot,
  mr: MergeRequest | undefined,
  ctx: ExecutorContext,
): Promise<void> {
  const { repo, issue } = snapshot;
  if (mr && result.mrDescription) {
    await ctx.adapter.updateMRDescription(
      repo,
      mr.iid,
      withClosesTrailer(result.mrDescription, issue.iid),
    );
  }
  if (result.planComment) {
    const alreadyPosted = snapshot.recentComments.some((c) =>
      c.body.includes(PLAN_COMMENT_SENTINEL),
    );
    if (!alreadyPosted) {
      await ctx.adapter.commentIssue(
        repo,
        issue.iid,
        `### 🎼 Plan\n\n${result.planComment}\n\n${PLAN_COMMENT_SENTINEL}`,
      );
    }
  }
}

/** Keep the `Closes #N` keyword so merging the MR still auto-closes the issue, even if
 *  the agent's rewritten description dropped it. No-op when an issue-closing reference
 *  to this iid is already present (any of closes/fixes/resolves). */
export function withClosesTrailer(body: string, iid: number): string {
  if (new RegExp(`\\b(clos(e|es|ed)|fix(e[sd])?|resolv(e|es|ed))\\s+#${iid}\\b`, 'i').test(body)) {
    return body;
  }
  return `${body.trimEnd()}\n\nCloses #${iid}`;
}

/** Crash-recovery resume: handoff started (proof posted) but didn't finish. Re-run the
 *  idempotent bare sequence (M4) — proof already on the forge, so it only assigns /
 *  undrafts / labels. No slot consumed (handoff is not active agent work). */
async function runRecoveryHandoff(snapshot: IssueSnapshot, ctx: ExecutorContext): Promise<void> {
  const { repo, issue } = snapshot;
  if (!snapshot.mr) {
    ctx.log.error('handoff recovery but no MR present', { repo: repoKey(repo), iid: issue.iid });
    return;
  }
  await ctx.handoff({
    repo,
    issueIid: issue.iid,
    mrIid: snapshot.mr.iid,
    ticketCreator: issue.author.username,
    settings: ctx.settings,
    adapter: ctx.adapter,
    proof: RECOVERED_PROOF,
  });
}

function buildRunnerInput(
  workspaceDir: string,
  snapshot: IssueSnapshot,
  mr: MergeRequest | undefined,
  recentComments: IssueSnapshot['recentComments'],
  ctx: ExecutorContext,
  role: AgentRole = 'implement', // every dispatch today is implementation work (#29 P1)
): RunnerInput {
  return {
    workspaceDir,
    // The role's own section when the WORKFLOW declares roles; whole body otherwise
    // (legacy generalist — #29 stays opt-in per repo).
    promptBody: promptForRole(ctx.promptBody, role),
    context: mr
      ? { issue: snapshot.issue, mr, recentComments }
      : { issue: snapshot.issue, recentComments },
    claude: {
      command: ctx.workflow.claude.command,
      maxTurns: ctx.workflow.claude.max_turns,
      permissionMode: ctx.workflow.claude.permission_mode,
      stallTimeoutMs: ctx.workflow.claude.stall_timeout_seconds * 1000,
    },
  };
}

function mrIidOf(snapshot: IssueSnapshot): number {
  if (!snapshot.mr) throw new Error(`merge intent for issue ${snapshot.issue.iid} with no MR`);
  return snapshot.mr.iid;
}

/** Command-MR entry point (#105, spec §5): check out the MR branch, run the agent on the
 *  one instruction, push iff it committed, and ALWAYS reply — the reply clears the edge.
 *  The single exception is a rate-limited spawn: nothing ran, so it does NOT reply and
 *  the command stays pending for next tick. mr-command-pass keeps the claim loop and the
 *  pure decide; only this execution sequence lives here. */
export async function executeMrCommand(
  repo: RepoRef,
  mr: MergeRequest,
  instruction: string,
  thread: Comment[],
  ctx: ExecutorContext,
): Promise<void> {
  const handle = await ctx.workspace.ensureMrWorkspace(repo, mr.iid, mr.sourceBranch);
  const result = await ctx.runner.run(buildMrRunnerInput(handle.dir, mr, instruction, thread, ctx));

  if (result.rateLimit) {
    const until = ctx.rateGate.trip(result.rateLimit.resetAt);
    ctx.log.warn('claude rate-limited during mr-command: pausing spawns (#47)', {
      repo: repoKey(repo),
      mr: mr.iid,
      resumeAt: new Date(until).toISOString(),
    });
    return; // no reply → edge stays hot, retried once the gate reopens
  }
  ctx.rateGate.clear();

  let pushed = 0;
  const unpushed = await ctx.workspace.countUnpushedCommits(handle);
  if (unpushed > 0) {
    await ctx.workspace.pushBranch(handle, mr.sourceBranch);
    pushed = unpushed;
  }
  await ctx.adapter.commentMR(repo, mr.iid, mrReply(result, pushed));
}

function buildMrRunnerInput(
  workspaceDir: string,
  mr: MergeRequest,
  instruction: string,
  thread: Comment[],
  ctx: ExecutorContext,
): RunnerInput {
  return {
    workspaceDir,
    promptBody: buildMrCommandPrompt({ instruction, mr, workflowBody: ctx.promptBody }),
    context: { mr, recentComments: thread }, // no issue — a command MR has none
    claude: {
      command: ctx.workflow.claude.command,
      maxTurns: ctx.workflow.claude.max_turns,
      permissionMode: ctx.workflow.claude.permission_mode,
      stallTimeoutMs: ctx.workflow.claude.stall_timeout_seconds * 1000,
    },
  };
}

/** The reply body (§5). Every terminal status posts it WITH the sentinel, so the edge
 *  clears on every path — success, no-op, needs_input, ran-out-of-turns. */
function mrReply(result: AgentResult, pushed: number): string {
  const head =
    result.status === 'done'
      ? pushed > 0
        ? `✅ Done — pushed ${pushed} commit${pushed === 1 ? '' : 's'} to this MR.`
        : '✅ Done — no code changes were needed.'
      : result.status === 'needs_input'
        ? '🙋 I need a decision before continuing:'
        : '⏳ Ran out of turns before finishing — re-comment `/maestro …` to continue.';
  return `🎼 ${head}\n\n${result.summary}\n\n${MR_COMMAND_REPLY_SENTINEL}`;
}
