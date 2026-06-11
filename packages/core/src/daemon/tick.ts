// The tick orchestrator (spec §7, §0.5, §13, §14). The ONE place I/O and concurrency
// live. Per repo per tick it runs the two §0.5 passes:
//   (a) lifecycle  — listAssignedOpenIssues → getSnapshot → reconcile → execute Intent
//   (b) cleanup     — enumerate workspace dirs → getIssueState → evict terminal ones
// It adds NO business rules beyond the orchestration the contracts assigned it:
// concurrency accounting (claims, slots, the rate-limit gate) and the two passes.
// Executing an admitted Intent — the workspace → run → push → record → move
// choreography, including the §0.9 runner-result→lifecycle mapping — lives in the
// intent executor (executor.ts, #105). Everything else is delegated to the
// already-tested M1–M4 units behind the TickContext seam (ports.ts), so this file is
// unit-testable with zero real I/O.
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
  DONE_SENTINEL,
  type Intent,
  type IssueSnapshot,
  type RepoRef,
} from '../contracts/index.js';
import type { ForgeAdapter } from '../contracts/index.js';
import { reconcile } from '../reconciler/reconcile.js';
import { lifecycleMove } from '../reconciler/transitions.js';
import { declaresRoles } from '../workflow/roles.js';
import type { Claim } from './claims.js';
import { executeIntent } from './executor.js';
import { evaluateMrCommands } from './mr-command-pass.js';
import type { TickContext } from './ports.js';
import { repoKey } from './ports.js';
import { upsertProgressRegion } from './progress-mirror.js';

// The full run choreography (workspace → run → push → record → move) lives in the
// intent executor (#105); `withClosesTrailer` moved with it — re-exported here for
// the existing import sites.
export { withClosesTrailer } from './executor.js';

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
      // #86: refresh the commit-derived progress mirror on EVERY due tick the issue has a
      // maestro MR — independent of the intent (a poll-review no-op still refreshes), so a
      // session that died before emitting `mrDescription` still leaves "where it's at" on
      // the MR. Best-effort: its own try/catch, never fails the issue's tick. Closed issues
      // never reach here (this pass lists open assigned issues only).
      await refreshProgressMirror(snapshot, ctx);
      const slotAvailable = claim.slotAvailable(ctx.settings.concurrency.maxActive);
      const intent = reconcile({
        snapshot,
        settings: ctx.settings,
        slotAvailable,
        workspaceExists: ctx.workspace.workspaceExists(repo, iid),
        workComplete: detectWorkComplete(snapshot),
        rolesDeclared: declaresRoles(ctx.promptBody), // #29 pipeline opt-in per repo
        now: new Date().toISOString(), // tick clock for the CI wait_timeout gate (#120)
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
 * Progress mirror (#86): upsert the daemon-owned marker region (commit subjects from the
 * forge) into the MR description, compare-and-skip against the snapshot's already-fetched
 * description — zero writes when nothing changed. Empty subjects skip entirely: there is
 * nothing to mirror, and a transient empty fetch must never wipe a live region down to
 * the placeholder. `recordPlan`'s full-description overwrite is healed by the next tick's
 * upsert by design. Best-effort: failures are logged, never thrown.
 */
async function refreshProgressMirror(snapshot: IssueSnapshot, ctx: TickContext): Promise<void> {
  const mr = snapshot.mr;
  if (!mr) return;
  try {
    const subjects = await ctx.adapter.listMrCommits(snapshot.repo, mr.iid);
    if (subjects.length === 0) return;
    const next = upsertProgressRegion(mr.description ?? '', subjects);
    if (next === mr.description) return; // compare-and-skip
    await ctx.adapter.updateMRDescription(snapshot.repo, mr.iid, next);
  } catch (err) {
    ctx.log.warn('progress mirror refresh failed — best-effort, retried next tick (#86)', {
      repo: repoKey(snapshot.repo),
      iid: snapshot.issue.iid,
      err: String(err),
    });
  }
}

/**
 * Admit one Intent and dispatch it to the executor (#105). This function owns
 * ADMISSION only — the rate gate, the intent journal line, the two queue checks, and
 * the slot take; the choreography itself (workspace → run → push → record → move) is
 * `executeIntent`. Every slot-consuming kind (SLOT_INTENTS) holds its slot through the
 * ONE `claim.holdSlot()` site below — synchronously, before any await — then the
 * launched promise is returned; everything else runs without a slot. `guard` closes
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
  const { issue } = snapshot;
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
  if (!slotAvailable && intent.kind === 'apply-ci-fix') {
    ctx.log.info('ci-fix queued: no concurrency slot', { repo: key, iid: issue.iid });
    return { active: false };
  }

  // poll-review · blocked-wait · none · skip-untrusted · cleanup (pass B owns it):
  // nothing to launch, nothing to claim.
  if (!ACTING_INTENTS.has(intent.kind)) return { active: false };

  // The ONE capacity take (#91): unconditional, exactly like the per-case acquires it
  // replaced — capacity POLICY stayed in the reconciler (via `slotAvailable`) and the
  // two queue checks above. Released with the claim when the launched work settles.
  if (SLOT_INTENTS.has(intent.kind)) claim.holdSlot();

  // "active" = an agent runs this tick (drives the adaptive scheduler, §14) — exactly
  // the spawning set. mark-queued / merge / handoff launch cheap forge effects while
  // the issue is waiting, not worked.
  return {
    active: SPAWNING_INTENTS.has(intent.kind),
    promise: guard(executeIntent(intent, snapshot, ctx), ctx, meta, claim),
  };
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
  'apply-ci-fix',
  'apply-unblock',
]);

/** The intents that consume a worker slot (§14) — today exactly the spawning set: a
 *  Claude agent process is precisely what capacity bounds. Kept as a separate name so
 *  a future non-slot spawn (or slot-only intent) splits the sets deliberately. */
const SLOT_INTENTS: ReadonlySet<Intent['kind']> = SPAWNING_INTENTS;

/** Everything the executor acts on: the spawning set plus the slot-free forge effects.
 *  The complement (QUIET_INTENTS — and any future kind until it is wired here) launches
 *  nothing. */
const ACTING_INTENTS: ReadonlySet<Intent['kind']> = new Set([
  ...SPAWNING_INTENTS,
  'mark-queued',
  'merge',
  'handoff',
]);

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
