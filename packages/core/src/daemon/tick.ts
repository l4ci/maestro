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
//    the same assigned issue — the in-process SlotAccountant does not arbitrate across
//    installs. Enforce one-repo-one-install by convention or distinct bot users.
//  · `global_max` is sized to host RAM (≈ (RAM_MB − 512) / per_worker_peak_MB); the
//    daemon only HONORS the cap (slot accounting) — it does not measure RAM or kill on
//    OOM. systemd `MemoryMax` + Restart=always is the last-line backstop (stateless,
//    so a restart loses nothing). Disk is bounded by the M3 WorkspaceManager LRU.

import {
  type AgentResult,
  DONE_SENTINEL,
  type Intent,
  type IssueSnapshot,
  type MergeRequest,
  PLAN_COMMENT_SENTINEL,
  type ProofResult,
  type RepoRef,
  type RunnerInput,
} from '../contracts/index.js';
import type { ForgeAdapter } from '../contracts/index.js';
import { reconcile } from '../reconciler/reconcile.js';
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
      await cleanupSweep(repo, ctx);
      out.set(repoKey(repo), { active });
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
  await cleanupSweep(repo, ctx);
  await Promise.all(pending);
  return { active };
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
    // slot (max_active ≥ 2) would stack a second agent on the same workspace. Capacity is
    // the slot accountant's; UNIQUENESS is the in-flight set's. Released below if this pass
    // launches no work, else when that work settles.
    if (ctx.inFlight.has(key, iid)) continue;
    ctx.inFlight.add(key, iid);
    let launched: { active: boolean; promise?: Promise<void> } = { active: false };
    try {
      const snapshot = await ctx.adapter.getSnapshot(repo, iid);
      const slotAvailable = ctx.slots.available(key, ctx.settings.concurrency.maxActive);
      const intent = reconcile({
        snapshot,
        settings: ctx.settings,
        slotAvailable,
        workspaceExists: ctx.workspace.workspaceExists(repo, iid),
        workComplete: detectWorkComplete(snapshot),
      });
      launched = beginIntent(intent, snapshot, ctx, key, slotAvailable);
      if (launched.active) active = true;
      if (launched.promise) {
        pending.push(launched.promise.finally(() => ctx.inFlight.delete(key, iid)));
      }
    } catch (err) {
      ctx.log.error('lifecycle: issue tick failed', { repo: key, iid, err: String(err) });
    } finally {
      // No launched work (no-op intent, queued-no-slot, or a throw) → release the claim so
      // the next due pass re-evaluates this issue.
      if (!launched.promise) ctx.inFlight.delete(key, iid);
    }
  }
  return { pending, active };
}

/**
 * Translate one Intent into effects. The slot-consuming kinds (start-new, run-agent,
 * apply-changes-requested) acquire synchronously then return a launched promise that
 * releases in `finally`; everything else runs without a slot. Non-acting intents
 * (poll-review / blocked-wait / none / skip-untrusted / cleanup-in-passA) are no-ops.
 */
function beginIntent(
  intent: Intent,
  snapshot: IssueSnapshot,
  ctx: TickContext,
  key: string,
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

  switch (intent.kind) {
    case 'start-new': {
      const release = ctx.slots.acquire(key);
      return {
        active: true,
        promise: guard(runStartNew(intent, snapshot, ctx), ctx, meta, release),
      };
    }
    case 'run-agent': {
      const release = ctx.slots.acquire(key);
      const comments = intent.feedback?.reviewComments ?? snapshot.recentComments;
      return {
        active: true,
        promise: guard(runAgent(snapshot, snapshot.mr, comments, ctx), ctx, meta, release),
      };
    }
    case 'apply-changes-requested': {
      // reconcile does not gate this on a slot; the daemon does (§14). No slot → queue.
      if (!slotAvailable) {
        ctx.log.info('changes-requested queued: no concurrency slot', {
          repo: key,
          iid: issue.iid,
        });
        return { active: false };
      }
      const release = ctx.slots.acquire(key);
      return {
        active: true,
        promise: guard(runApplyChanges(intent, snapshot, ctx), ctx, meta, release),
      };
    }
    case 'apply-unblock': {
      // reconcile does not gate this on a slot; the daemon does (§14). No slot → queue.
      if (!slotAvailable) {
        ctx.log.info('unblock queued: no concurrency slot', { repo: key, iid: issue.iid });
        return { active: false };
      }
      const release = ctx.slots.acquire(key);
      return {
        active: true,
        promise: guard(runApplyUnblock(intent, snapshot, ctx), ctx, meta, release),
      };
    }
    case 'merge':
      return {
        active: false,
        promise: guard(
          ctx.adapter.mergeMR(repo, mrIidOf(snapshot), intent.strategy, intent.deleteSource),
          ctx,
          meta,
        ),
      };
    case 'handoff':
      return { active: false, promise: guard(runRecoveryHandoff(snapshot, ctx), ctx, meta) };
    default:
      // poll-review · blocked-wait · none · skip-untrusted · cleanup (pass B owns it)
      return { active: false };
  }
}

/** The intents that launch a Claude agent — the ones a rate-limit pause gates (#47). */
const SPAWNING_INTENTS: ReadonlySet<Intent['kind']> = new Set([
  'start-new',
  'run-agent',
  'apply-changes-requested',
  'apply-unblock',
]);

/** Isolate one issue's launched work: a rejection is caught + logged (retried next
 *  tick, §13), and the slot — if any — is released no matter what (no leak, §14). */
function guard(
  work: Promise<unknown>,
  ctx: TickContext,
  meta: Record<string, unknown>,
  release?: () => void,
): Promise<void> {
  return work
    .then(
      () => {},
      (err) => ctx.log.error('tick: issue work failed', { ...meta, err: String(err) }),
    )
    .finally(() => release?.());
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
  await ctx.adapter.setIssueLabels(repo, issue.iid, [ctx.settings.labels.inProgress], []);
  await ctx.adapter.commentIssue(repo, issue.iid, '🎼 maestro started work on this issue.');
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
): Promise<void> {
  const fromRef = mr?.sourceBranch ?? ctx.settings.git.target;
  const handle = await ctx.workspace.ensureWorkspace(snapshot.repo, snapshot.issue.iid, fromRef);
  warnIfRescued(handle, ctx);
  const result = await ctx.runner.run(buildRunnerInput(handle.dir, snapshot, mr, comments, ctx));
  if (mr) await ctx.workspace.pushBranch(handle, mr.sourceBranch);
  await applyAgentResult(result, snapshot, mr, handle.dir, ctx);
}

/** Review asked for changes: flip in-review→in-progress, then run the agent with the
 *  review feedback threaded into context (§7 In-review→in-progress edge). */
async function runApplyChanges(
  intent: Extract<Intent, { kind: 'apply-changes-requested' }>,
  snapshot: IssueSnapshot,
  ctx: TickContext,
): Promise<void> {
  await ctx.adapter.setIssueLabels(
    snapshot.repo,
    snapshot.issue.iid,
    [ctx.settings.labels.inProgress],
    [ctx.settings.labels.inReview],
  );
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
  await ctx.adapter.setIssueLabels(
    snapshot.repo,
    snapshot.issue.iid,
    [ctx.settings.labels.inProgress],
    [ctx.settings.labels.blocked],
  );
  await runAgent(snapshot, snapshot.mr, intent.feedback.reviewComments, ctx);
}

/** §0.9 runner-result → lifecycle mapping — the mapping the daemon OWNS. */
async function applyAgentResult(
  result: AgentResult,
  snapshot: IssueSnapshot,
  mr: MergeRequest | undefined,
  workspaceDir: string,
  ctx: TickContext,
): Promise<void> {
  const { repo, issue } = snapshot;
  // Rate-limited run (#47): the spawn was doomed, not an agent error. Pause ALL
  // spawning (CLI-reported reset time when present, else capped exponential backoff)
  // and apply nothing — no plan write, no lifecycle transition; the issue resumes
  // untouched once the gate reopens. A healthy run clears the gate's trip streak.
  if (result.rateLimit) {
    const until = ctx.rateGate.trip(result.rateLimit.resetAt);
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
  switch (result.status) {
    case 'done': {
      if (!mr) {
        ctx.log.error('agent done but no MR to hand off', { repo: repoKey(repo), iid: issue.iid });
        return;
      }
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
    case 'needs_input':
      await ctx.adapter.setIssueLabels(
        repo,
        issue.iid,
        [ctx.settings.labels.blocked],
        [ctx.settings.labels.inProgress],
      );
      await ctx.adapter.commentIssue(
        repo,
        issue.iid,
        `🚧 Blocked — agent needs input:\n\n${result.summary}`,
      );
      return;
    default:
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

/** Cleanup sweep (b). Workspace-cache-driven and INDEPENDENT of the open-issue list
 *  (§0.5): enumerate this repo's workspace dirs, read each issue's state, evict the
 *  terminal (closed/missing) ones. Per-dir failures are isolated. */
export async function cleanupSweep(repo: RepoRef, ctx: TickContext): Promise<void> {
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
}

function buildRunnerInput(
  workspaceDir: string,
  snapshot: IssueSnapshot,
  mr: MergeRequest | undefined,
  recentComments: IssueSnapshot['recentComments'],
  ctx: TickContext,
): RunnerInput {
  return {
    workspaceDir,
    promptBody: ctx.promptBody,
    context: mr
      ? { issue: snapshot.issue, mr, recentComments }
      : { issue: snapshot.issue, recentComments },
    claude: {
      command: ctx.workflow.claude.command,
      maxTurns: ctx.workflow.claude.max_turns,
      permissionMode: ctx.workflow.claude.permission_mode,
    },
  };
}

function mrIidOf(snapshot: IssueSnapshot): number {
  if (!snapshot.mr) throw new Error(`merge intent for issue ${snapshot.issue.iid} with no MR`);
  return snapshot.mr.iid;
}
