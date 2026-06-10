// The tick orchestrator (spec §7, §0.5, §13, §14). The ONE place I/O and concurrency
// live. Per repo per tick it runs the two §0.5 passes:
//   (a) lifecycle  — listAssignedOpenIssues → getSnapshot → reconcile → execute Intent
//   (b) cleanup     — enumerate workspace dirs → getIssueState → evict terminal ones
// It adds NO business rules beyond the orchestration the contracts assigned it:
// concurrency accounting, the runner-result→lifecycle mapping (§0.9), and the two
// passes. Everything else is delegated to the already-tested M1–M4 units behind the
// TickContext seam (ports.ts), so this file is unit-testable with zero real I/O.
//
// OPS GUARDS (§14, documented not coded — there is no cross-install coordination in
// v1, §17):
//  · ONE daemon per (repo, bot_user). Two daemons sharing a repo+bot can both claim
//    the same assigned issue — the in-process Claims accounting does not arbitrate
//    across installs. Enforce one-repo-one-install by convention or distinct bot users.
//  · `global_max` is sized to host RAM (≈ (RAM_MB − 512) / per_worker_peak_MB); the
//    daemon only HONORS the cap (slot accounting) — it does not measure RAM or kill on
//    OOM. systemd `MemoryMax` + Restart=always is the last-line backstop (stateless,
//    so a restart loses nothing). Disk is bounded by the M3 WorkspaceManager LRU.

import {
  AC_DRAFT_SENTINEL,
  type AgentResult,
  DONE_SENTINEL,
  type Intent,
  type IssueSnapshot,
  type MergeRequest,
  PLAN_COMMENT_SENTINEL,
  type ProofResult,
  REVIEW_PASS_SENTINEL,
  type RepoRef,
  type RunnerInput,
  reviewFailMarker,
} from '../contracts/index.js';
import type { ForgeAdapter } from '../contracts/index.js';
import { branchName, mrTitle } from '../contracts/naming.js';
import { decideAfterRun } from '../reconciler/after-run.js';
import { reconcile } from '../reconciler/reconcile.js';
import { lifecycleMove } from '../reconciler/transitions.js';
import { type AgentRole, declaresRoles, promptForRole } from '../workflow/roles.js';
import type { Claim } from './claims.js';
import { evaluateMrCommands } from './mr-command-pass.js';
import type { TickContext, WorkspaceHandleLike } from './ports.js';
import { repoKey } from './ports.js';

/** Result of one repo's tick — `active` drives the adaptive scheduler (§14). */
export interface RepoTickResult {
  active: boolean; // did any issue run/start the agent this tick?
}

/** One repo paired with its (forge-selected, resolved) context. */
export interface RepoUnit {
  repo: RepoRef;
  ctx: TickContext;
}

/** Pick the adapter whose `kind` AND `host` match the repo (M7 drop-in seam, §0.3). */
export function selectAdapter(repo: RepoRef, adapters: ForgeAdapter[]): ForgeAdapter {
  const a = adapters.find((x) => x.kind === repo.forge && x.host === repo.host);
  if (!a) throw new Error(`no adapter registered for forge '${repo.forge}' host '${repo.host}'`);
  return a;
}

/**
 * One full daemon iteration over many repos sharing the process-wide slot accountant.
 * Repos are evaluated in order — each holds its acquired slots while later repos are
 * evaluated (so a global-cap-saturated daemon queues the rest, §14) — then all launched
 * agent work is awaited together. One repo's failure never blocks another (§13).
 */
export async function tick(units: RepoUnit[]): Promise<Map<string, RepoTickResult>> {
  const out = new Map<string, RepoTickResult>();
  const allPending: Promise<void>[] = [];
  for (const { repo, ctx } of units) {
    try {
      const { pending, active } = await evaluateLifecycle(repo, ctx);
      allPending.push(...pending);
      const mrPass = await evaluateMrCommands(repo, ctx); // standalone-MR /maestro trigger (§MR-command)
      allPending.push(...mrPass.pending);
      await cleanupSweep(repo, ctx);
      out.set(repoKey(repo), { active: active || mrPass.active });
    } catch (err) {
      ctx.log.error('tick: repo iteration failed', { repo: repoKey(repo), err: String(err) });
      out.set(repoKey(repo), { active: false });
    }
  }
  await Promise.all(allPending);
  return out;
}

/** Proof stand-in for the crash-recovery resume: the real proof is already on the
 *  forge (the sentinel is how we detected workComplete), so handoff skips re-posting. */
const RECOVERED_PROOF: ProofResult[] = [{ ok: true, kind: 'none', summary: '(recovered)' }];

/** crash-recovery signal (AM-1): the agent reached `done` (proof comment posted) on a
 *  prior tick but handoff did not finish (issue still labelled in-progress). */
function detectWorkComplete(snapshot: IssueSnapshot): boolean {
  return snapshot.recentComments.some((c) => c.body.includes(DONE_SENTINEL));
}

/** Run one repo's tick: lifecycle pass then cleanup sweep (§0.5). Never throws past
 *  here — a failed tick is caught, logged, and retried next tick (§13). */
export async function tickRepo(repo: RepoRef, ctx: TickContext): Promise<RepoTickResult> {
  const { pending, active } = await evaluateLifecycle(repo, ctx);
  const mrPass = await evaluateMrCommands(repo, ctx); // standalone-MR /maestro trigger (§MR-command)
  await cleanupSweep(repo, ctx);
  await Promise.all([...pending, ...mrPass.pending]);
  return { active: active || mrPass.active };
}

/**
 * Lifecycle pass (a). Sequential per-issue evaluation; each slot-consuming intent
 * acquires its slot SYNCHRONOUSLY (atomic with the availability check — no await
 * between) then LAUNCHES the agent work without awaiting it here. So issue N+1's
 * `slotAvailable` already observes issue N's held slot, and the caller can hold slots
 * across repos before any release. Returns the launched promises for the caller to
 * await. One issue's failure is isolated (caught) and retried next tick (§13).
 */
export async function evaluateLifecycle(
  repo: RepoRef,
  ctx: TickContext,
): Promise<{ pending: Promise<void>[]; active: boolean }> {
  const key = repoKey(repo);
  const pending: Promise<void>[] = [];
  let active = false;

  let issues: { iid: number }[] = [];
  try {
    issues = await ctx.adapter.listAssignedOpenIssues(repo);
  } catch (err) {
    ctx.log.error('lifecycle: listAssignedOpenIssues failed', { repo: key, err: String(err) });
    return { pending, active };
  }

  for (const { iid } of issues) {
    // #18: claim the issue BEFORE any await. A repo stays "due" until this pass's agent work
    // settles, so overlapping tick passes re-enter here; without a per-issue claim a free
    // slot (max_active ≥ 2) would stack a second agent on the same workspace. The claim owns
    // BOTH resources (uniqueness + capacity, #91); `close` is the only release path — called
    // below if this pass launches no work, else by `guard` when that work settles.
    const claim = ctx.claims.open(key, iid);
    if (!claim) continue;
    let launched: { active: boolean; promise?: Promise<void> } = { active: false };
    try {
      const snapshot = await ctx.adapter.getSnapshot(repo, iid);
      const slotAvailable = claim.slotAvailable(ctx.settings.concurrency.maxActive);
      const intent = reconcile({
        snapshot,
        settings: ctx.settings,
        slotAvailable,
        workspaceExists: ctx.workspace.workspaceExists(repo, iid),
        workComplete: detectWorkComplete(snapshot),
        rolesDeclared: declaresRoles(ctx.promptBody), // #29 pipeline opt-in per repo
      });
      launched = beginIntent(intent, snapshot, ctx, key, claim, slotAvailable);
      if (launched.active) active = true;
      if (launched.promise) pending.push(launched.promise);
    } catch (err) {
      ctx.log.error('lifecycle: issue tick failed', { repo: key, iid, err: String(err) });
    } finally {
      // No launched work (no-op intent, queued-no-slot, or a throw) → close the claim so
      // the next due pass re-evaluates this issue.
      if (!launched.promise) claim.close();
    }
  }
  return { pending, active };
}

/**
 * Translate one Intent into effects. Every slot-consuming kind (SLOT_INTENTS) holds its
 * slot through the ONE `claim.holdSlot()` site below — synchronously, before any await —
 * then returns a launched promise; everything else runs without a slot. `guard` closes
 * the claim (slot + uniqueness) when the launched work settles. Non-acting intents
 * (poll-review / blocked-wait / none / skip-untrusted / cleanup-in-passA) are no-ops.
 */
function beginIntent(
  intent: Intent,
  snapshot: IssueSnapshot,
  ctx: TickContext,
  key: string,
  claim: Claim,
  slotAvailable: boolean,
): { active: boolean; promise?: Promise<void> } {
  const { repo, issue } = snapshot;
  const meta = { repo: key, iid: issue.iid, intent: intent.kind };

  // Claude rate-limited (#47): every new spawn is doomed until the window resets, so
  // agent-spawning intents become no-ops (NOT failures — no lifecycle transition, no
  // error state; the next tick after the deadline picks the issue up where it was).
  if (SPAWNING_INTENTS.has(intent.kind)) {
    const pausedUntil = ctx.rateGate.pausedUntil();
    if (pausedUntil !== null) {
      ctx.log.info('agent spawn skipped: claude rate-limited (#47)', {
        ...meta,
        resumeAt: new Date(pausedUntil).toISOString(),
      });
      return { active: false };
    }
  }

  // One info line per ACTING intent, so the journal tells the story (label flips and
  // agent spawns were previously only visible on the forge). The recurring no-op kinds
  // (poll-review / blocked-wait / none / skip-untrusted / cleanup) stay quiet — they
  // fire every tick and would flood the log.
  if (!QUIET_INTENTS.has(intent.kind)) ctx.log.info('reconcile intent', meta);

  // reconcile does not gate these two on a slot; the daemon does (§14). No slot → queue.
  if (!slotAvailable && intent.kind === 'apply-changes-requested') {
    ctx.log.info('changes-requested queued: no concurrency slot', { repo: key, iid: issue.iid });
    return { active: false };
  }
  if (!slotAvailable && intent.kind === 'apply-unblock') {
    ctx.log.info('unblock queued: no concurrency slot', { repo: key, iid: issue.iid });
    return { active: false };
  }

  // The ONE capacity take (#91): unconditional, exactly like the per-case acquires it
  // replaced — capacity POLICY stayed in the reconciler (via `slotAvailable`) and the
  // two queue checks above. Released with the claim when the launched work settles.
  if (SLOT_INTENTS.has(intent.kind)) claim.holdSlot();

  switch (intent.kind) {
    case 'start-new':
      return {
        active: true,
        promise: guard(runStartNew(intent, snapshot, ctx), ctx, meta, claim),
      };
    case 'run-agent': {
      const comments = intent.feedback?.reviewComments ?? snapshot.recentComments;
      return {
        active: true,
        promise: guard(
          runAgent(snapshot, snapshot.mr, comments, ctx, intent.role ?? 'implement'),
          ctx,
          meta,
          claim,
        ),
      };
    }
    case 'run-define':
      return {
        active: true,
        promise: guard(runDefine(snapshot, ctx), ctx, meta, claim),
      };
    case 'run-plan':
      return {
        active: true,
        promise: guard(runPlan(intent, snapshot, ctx), ctx, meta, claim),
      };
    case 'run-review':
      return {
        active: true,
        promise: guard(runReview(intent, snapshot, ctx), ctx, meta, claim),
      };
    case 'apply-changes-requested':
      return {
        active: true,
        promise: guard(runApplyChanges(intent, snapshot, ctx), ctx, meta, claim),
      };
    case 'apply-unblock':
      return {
        active: true,
        promise: guard(runApplyUnblock(intent, snapshot, ctx), ctx, meta, claim),
      };
    case 'mark-queued': {
      // Wants a slot, none free (#53/#29): one cheap label write, no slot, not "active"
      // (the issue is waiting, not worked). Visible as maestro:queued until a slot frees.
      const m = lifecycleMove('mark-queued', ctx.settings.labels);
      return {
        active: false,
        promise: guard(
          ctx.adapter.setIssueLabels(repo, issue.iid, m.set, m.unset),
          ctx,
          meta,
          claim,
        ),
      };
    }
    case 'merge':
      return {
        active: false,
        promise: guard(
          ctx.adapter.mergeMR(repo, mrIidOf(snapshot), intent.strategy, intent.deleteSource),
          ctx,
          meta,
          claim,
        ),
      };
    case 'handoff':
      return { active: false, promise: guard(runRecoveryHandoff(snapshot, ctx), ctx, meta, claim) };
    default:
      // poll-review · blocked-wait · none · skip-untrusted · cleanup (pass B owns it)
      return { active: false };
  }
}

/** The intents that recur every tick without acting — excluded from the intent log. */
const QUIET_INTENTS: ReadonlySet<Intent['kind']> = new Set([
  'poll-review',
  'blocked-wait',
  'none',
  'skip-untrusted',
  'cleanup',
]);

/** The intents that launch a Claude agent — the ones a rate-limit pause gates (#47). */
const SPAWNING_INTENTS: ReadonlySet<Intent['kind']> = new Set([
  'start-new',
  'run-define',
  'run-plan',
  'run-review',
  'run-agent',
  'apply-changes-requested',
  'apply-unblock',
]);

/** The intents that consume a worker slot (§14) — today exactly the spawning set: a
 *  Claude agent process is precisely what capacity bounds. Kept as a separate name so
 *  a future non-slot spawn (or slot-only intent) splits the sets deliberately. */
const SLOT_INTENTS: ReadonlySet<Intent['kind']> = SPAWNING_INTENTS;

/** Isolate one issue's launched work: a rejection is caught + logged (retried next
 *  tick, §13), and the claim — slot and uniqueness together — is closed no matter
 *  what (no leak, §14; the ONLY release path for launched work, #91). */
function guard(
  work: Promise<unknown>,
  ctx: TickContext,
  meta: Record<string, unknown>,
  claim: Claim,
): Promise<void> {
  return work
    .then(
      () => {},
      (err) => ctx.log.error('tick: issue work failed', { ...meta, err: String(err) }),
    )
    .finally(() => claim.close());
}

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
function warnIfRescued(handle: WorkspaceHandleLike, ctx: TickContext): void {
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
  ctx: TickContext,
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
  const m = lifecycleMove('begin-work', ctx.settings.labels);
  await ctx.adapter.setIssueLabels(repo, issue.iid, m.set, m.unset);
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
  ctx: TickContext,
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
async function runDefine(snapshot: IssueSnapshot, ctx: TickContext): Promise<void> {
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
    const m = lifecycleMove('enter-define', ctx.settings.labels);
    await ctx.adapter.setIssueLabels(repo, issue.iid, m.set, m.unset);
  }
  // in_progress (ran out of turns) → resume next tick; done without a draft → retry.
}

/** Todo stage (#29): the plan agent produces the plan FIRST; only then does the daemon
 *  create the branch + draft MR carrying it (the #48 channel made durable from birth),
 *  flip labels to in-progress, and post the structured start comment. */
async function runPlan(
  intent: Extract<Intent, { kind: 'run-plan' }>,
  snapshot: IssueSnapshot,
  ctx: TickContext,
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
  const m = lifecycleMove('begin-work-from-plan', ctx.settings.labels);
  await ctx.adapter.setIssueLabels(repo, issue.iid, m.set, m.unset);
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
  ctx: TickContext,
): Promise<void> {
  const m = lifecycleMove('resume-from-review', ctx.settings.labels);
  await ctx.adapter.setIssueLabels(snapshot.repo, snapshot.issue.iid, m.set, m.unset);
  await runAgent(snapshot, snapshot.mr, intent.feedback.reviewComments, ctx);
}

/** Maintainer answered a blocked issue: flip blocked→in-progress, then run the agent with
 *  the answer threaded into context (§7 Blocked→in-progress edge). The label flip is what
 *  retires the edge — without it `deriveState` stays `blocked` and the next tick would
 *  re-resume on every poll. Mirrors runApplyChanges; the agent re-blocks if it needs more. */
async function runApplyUnblock(
  intent: Extract<Intent, { kind: 'apply-unblock' }>,
  snapshot: IssueSnapshot,
  ctx: TickContext,
): Promise<void> {
  const role = intent.role ?? 'implement';
  // Only implementation restores in-progress; define/plan stages carry their own
  // labels already (#29) — the artifacts, not this flip, decide the stage.
  const m = lifecycleMove('unblock', ctx.settings.labels, role);
  await ctx.adapter.setIssueLabels(snapshot.repo, snapshot.issue.iid, m.set, m.unset);
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
  ctx: TickContext,
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
  ctx: TickContext,
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
  ctx: TickContext,
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
async function runRecoveryHandoff(snapshot: IssueSnapshot, ctx: TickContext): Promise<void> {
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

/** Unassigning the bot is how a human stops maestro on a queued issue (#53). Queued
 *  (todo-labelled) issues vanish from listAssignedOpenIssues the moment they are
 *  unassigned, so the lifecycle pass can never see them again — this sweep step finds
 *  them BY LABEL and retracts the stale mark. Stateless (survives restarts); one extra
 *  list call per repo per sweep. Failures are logged and retried next sweep. */
async function retractStaleTodos(repo: RepoRef, ctx: TickContext): Promise<void> {
  try {
    const marked = await ctx.adapter.listOpenIssuesByLabel(repo, ctx.settings.labels.queued);
    for (const issue of marked) {
      const assignedToBot = issue.assignees.some((a) => a.username === ctx.settings.botUser);
      if (assignedToBot) continue;
      const m = lifecycleMove('retract-queued', ctx.settings.labels);
      await ctx.adapter.setIssueLabels(repo, issue.iid, m.set, m.unset);
      ctx.log.info('queued mark retracted: bot unassigned — no longer watching (#53)', {
        repo: repoKey(repo),
        iid: issue.iid,
      });
    }
  } catch (err) {
    ctx.log.error('cleanup: todo retraction failed', { repo: repoKey(repo), err: String(err) });
  }
}

/** Cleanup sweep (b). Workspace-cache-driven and INDEPENDENT of the open-issue list
 *  (§0.5): enumerate this repo's workspace dirs, read each issue's state, evict the
 *  terminal (closed/missing) ones. Per-dir failures are isolated. */
export async function cleanupSweep(repo: RepoRef, ctx: TickContext): Promise<void> {
  await retractStaleTodos(repo, ctx);
  for (const { dir, iid } of ctx.workspace.listWorkspaces(repo)) {
    try {
      const state = await ctx.adapter.getIssueState(repo, iid);
      if (state === 'closed' || state === 'missing') {
        const evicted = await ctx.workspace.evict(dir);
        // refused (#56): the dir still holds unpushed commits — keep it, retry next sweep
        if (!evicted)
          ctx.log.warn('cleanup: workspace kept — unpushed commits (#56)', {
            repo: repoKey(repo),
            iid,
          });
      }
    } catch (err) {
      ctx.log.error('cleanup: sweep entry failed', { repo: repoKey(repo), iid, err: String(err) });
    }
  }
  // Command-MR branch of the sweep (§MR-command / spec §7): `mr-<iid>` dirs are evicted once
  // their MR is terminal (merged/closed) or gone — the mirror of the issue loop above.
  for (const { dir, iid } of ctx.workspace.listMrWorkspaces(repo)) {
    try {
      const state = await ctx.adapter.getMergeRequestState(repo, iid);
      if (state === 'merged' || state === 'closed' || state === 'missing') {
        const evicted = await ctx.workspace.evict(dir);
        if (!evicted)
          ctx.log.warn('cleanup: command-MR workspace kept — unpushed commits (#56)', {
            repo: repoKey(repo),
            mr: iid,
          });
      }
    } catch (err) {
      ctx.log.error('cleanup: mr sweep entry failed', {
        repo: repoKey(repo),
        mr: iid,
        err: String(err),
      });
    }
  }
}

function buildRunnerInput(
  workspaceDir: string,
  snapshot: IssueSnapshot,
  mr: MergeRequest | undefined,
  recentComments: IssueSnapshot['recentComments'],
  ctx: TickContext,
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
