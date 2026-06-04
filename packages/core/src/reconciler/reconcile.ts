// Pure reconciler FSM (spec §7, contracts §0.4). Total, deterministic, idempotent,
// side-effect free, ≤1 Intent per tick. NO I/O, NO async, imports only contracts.
//
// Ordering (M0 §0.4, amended AM-2): terminal(closed) → trigger guard → state
// derivation. The guard governs starting/continuing work, NOT cleanup — a Done
// issue may have lost its assignee yet must still evict its workspace (§0.5).

import type {
  Comment,
  Intent,
  Issue,
  IssueSnapshot,
  LifecycleState,
  ReconcileInput,
  RepoSettings,
  TriggerGuard,
} from '../contracts/index.js';
import { branchName, mrTitle } from '../contracts/naming.js';

function assertNever(x: never): never {
  throw new Error(`unreachable lifecycle state: ${String(x)}`);
}

/** Security boundary (§13.1): fail-closed. Governs starting/continuing work only. */
function passesTriggerGuard(issue: Issue, trigger: TriggerGuard, botUser: string): boolean {
  const assignedToBot = issue.assignees.some((a) => a.username === botUser);
  if (!assignedToBot) return false;
  if (trigger.requireLabel !== null && !issue.labels.includes(trigger.requireLabel)) return false;
  if (trigger.allowedActors.length > 0) {
    const actor = issue.lastActor;
    if (!actor || !trigger.allowedActors.includes(actor.username)) return false; // fail-closed
  }
  return true;
}

/**
 * Pure state derivation, exported for CLI/web display (AM-14). Closed issues are
 * terminal (`done`). For open issues, intermediate labels win by most-terminal
 * priority: blocked > in-review > in-progress > (none ⇒ new). GitHub mutual
 * exclusion is adapter-enforced (§0.7); the reconciler stays total regardless.
 */
export function deriveState(snapshot: IssueSnapshot, settings: RepoSettings): LifecycleState {
  const { issue } = snapshot;
  if (issue.state === 'closed') return 'done';
  const { inProgress, inReview, blocked } = settings.labels;
  if (issue.labels.includes(blocked)) return 'blocked';
  if (issue.labels.includes(inReview)) return 'in-review';
  if (issue.labels.includes(inProgress)) return 'in-progress';
  return 'new';
}

/**
 * Edge-triggered unblock — the issue-thread mirror of `computeChangesRequested` (§0.3).
 * The bot's blocking comment (posted alongside the maestro:blocked label, §0.9) is the
 * block marker; the maintainer's answer is any non-bot comment that post-dates it. Returns
 * the answering comments in `recentComments` order (newest-first), or [] if the block still
 * stands. No bot comment ⇒ no marker ⇒ stay parked: never self-unblock on stale or absent
 * signal (fail-safe, like the changes-requested edge's `blockingAt === undefined → false`).
 */
function repliesSinceBlock(recentComments: Comment[], botUser: string): Comment[] {
  const blockedAt = recentComments.find((c) => c.author.username === botUser)?.createdAt;
  if (blockedAt === undefined) return [];
  return recentComments.filter((c) => c.author.username !== botUser && c.createdAt > blockedAt);
}

export function reconcile(input: ReconcileInput): Intent {
  const { snapshot, settings, slotAvailable, workspaceExists, workComplete } = input;
  const { issue, mr } = snapshot;

  // 1. Terminal first — exempt from the trigger guard (AM-2, §0.5).
  if (issue.state === 'closed') {
    return workspaceExists
      ? { kind: 'cleanup' }
      : { kind: 'none', reason: 'closed issue, no workspace — stable fixpoint' };
  }

  // 2. Trigger guard (open issues only).
  if (!passesTriggerGuard(issue, settings.trigger, settings.botUser)) {
    return { kind: 'skip-untrusted', reason: 'trigger guard rejected (assignee/label/actor)' };
  }

  // 3. Derive state, compute at most one intent.
  const state = deriveState(snapshot, settings);
  switch (state) {
    case 'new':
      return slotAvailable
        ? { kind: 'start-new', branch: branchName(issue), mrTitle: mrTitle(issue) }
        : { kind: 'none', reason: 'new issue queued: no concurrency slot' };

    case 'in-progress':
      if (workComplete) return { kind: 'handoff' }; // crash-recovery (AM-1); no slot consumed
      return slotAvailable
        ? { kind: 'run-agent', resume: true }
        : { kind: 'none', reason: 'in-progress waiting: no concurrency slot' };

    case 'in-review': {
      const ap = mr?.approvals;
      if (ap?.approved) {
        return {
          kind: 'merge',
          strategy: settings.git.mergeStrategy,
          deleteSource: settings.git.deleteSourceBranch,
        };
      }
      if (ap?.changesRequested) {
        // Trust the adapter's edge-triggering (§0.3); pass comments through as opaque data.
        return {
          kind: 'apply-changes-requested',
          feedback: { reviewComments: snapshot.recentComments },
        };
      }
      return { kind: 'poll-review' };
    }

    case 'blocked': {
      // Edge-triggered unblock: a maintainer reply post-dating the block resumes work,
      // threading the answer to the agent. The reconciler only reports the edge; the
      // daemon flips the label and gates on a slot (mirror of apply-changes-requested, §14).
      const replies = repliesSinceBlock(snapshot.recentComments, settings.botUser);
      return replies.length > 0
        ? { kind: 'apply-unblock', feedback: { reviewComments: replies } }
        : { kind: 'blocked-wait' };
    }

    case 'done':
      // Unreachable for open issues (terminal handled above); kept for totality.
      return workspaceExists ? { kind: 'cleanup' } : { kind: 'none', reason: 'done' };

    default:
      return assertNever(state);
  }
}
