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
import {
  AC_DRAFT_SENTINEL,
  DONE_SENTINEL,
  REVIEW_FAIL_RE,
  REVIEW_PASS_SENTINEL,
} from '../contracts/index.js';
import { branchName, mrTitle } from '../contracts/naming.js';
import { isHumanComment } from '../forge/comments.js';
import { isAuthorizedActor } from '../security/authorized-actor.js';

function assertNever(x: never): never {
  throw new Error(`unreachable lifecycle state: ${String(x)}`);
}

/** Security boundary (§13.1): fail-closed. Governs starting/continuing work only. */
function passesTriggerGuard(issue: Issue, trigger: TriggerGuard, botUser: string): boolean {
  const assignedToBot = issue.assignees.some((a) => a.username === botUser);
  if (!assignedToBot) return false;
  if (trigger.requireLabel !== null && !issue.labels.includes(trigger.requireLabel)) return false;
  if (!isAuthorizedActor(issue.lastActor?.username, trigger.allowedActors)) return false;
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
 * block marker; the maintainer's answer is any HUMAN comment (isHumanComment — covers
 * same-account `/maestro` replies) that post-dates it. Returns the answering comments in
 * `recentComments` order (newest-first), or [] if the block still stands. No bot comment
 * ⇒ no marker ⇒ stay parked: never self-unblock on stale or absent signal (fail-safe,
 * like the changes-requested edge's `blockingAt === undefined → false`).
 */
function repliesSinceBlock(recentComments: Comment[], botUser: string): Comment[] {
  // The marker is the newest DAEMON comment — same-account human replies are excluded
  // by the human predicate so they cannot shadow the block marker.
  const blockedAt = recentComments.find(
    (c) => c.author.username === botUser && !isHumanComment(c, botUser),
  )?.createdAt;
  if (blockedAt === undefined) return [];
  return recentComments.filter((c) => isHumanComment(c, botUser) && c.createdAt > blockedAt);
}

/** Idempotent capacity marker (#53/#29): one label write, then a stable no-op. */
function markQueuedOnce(snapshot: IssueSnapshot, settings: RepoSettings, why: string): Intent {
  return snapshot.issue.labels.includes(settings.labels.queued)
    ? { kind: 'none', reason: `${why} (queued marked)` }
    : { kind: 'mark-queued' };
}

/** The #29 pipeline stages, P2 cut (review:internal arrives with P3). */
export type Stage = 'backlog' | 'todo' | 'in-progress' | 'review:human' | 'done';

/**
 * Stage derivation from ARTIFACTS alone (#29 "blocked is a modifier" decision): the
 * world state IS the origin, so resuming from blocked needs no stored state. Label
 * writes are projections for humans/boards; they are never read back here — except
 * `todo`, which is HUMAN-set by design (the daemon never applies it) and so is itself
 * an artifact: its presence is the definition-gate approval.
 */
export function deriveStage(snapshot: IssueSnapshot, settings: RepoSettings): Stage {
  const { issue, mr } = snapshot;
  if (issue.state === 'closed') return 'done';
  if (mr && !mr.isDraft) return 'review:human'; // handoff completed → human gate
  if (mr) return 'in-progress'; // draft MR = plan landed, implementation underway
  if (acApproved(snapshot, settings)) return 'todo'; // defined, awaiting planning
  return 'backlog'; // not yet defined
}

/** The definition gate (#29): a human applied the todo label (possibly at creation —
 *  the explicit skip-define escape hatch), or replied `/maestro approve` after the
 *  define agent's AC draft. Agent/daemon comments can never approve (isHumanComment:
 *  a same-account approve must carry the command at body start). */
function acApproved(snapshot: IssueSnapshot, settings: RepoSettings): boolean {
  if (snapshot.issue.labels.includes(settings.labels.todo)) return true;
  const draftAt = snapshot.recentComments.find((c) =>
    c.body.includes(AC_DRAFT_SENTINEL),
  )?.createdAt;
  if (draftAt === undefined) return false;
  return snapshot.recentComments.some(
    (c) =>
      isHumanComment(c, settings.botUser) &&
      c.createdAt > draftAt &&
      /^\/maestro approve\b/m.test(c.body),
  );
}

/** Blocked as a modifier (#29): the label is the bit; clearing it re-derives the stage
 *  from artifacts, so work resumes exactly where it left off. */
function isBlocked(snapshot: IssueSnapshot, settings: RepoSettings): boolean {
  return snapshot.issue.labels.includes(settings.labels.blocked);
}

/**
 * The internal-review sub-state of a draft MR (#29 P3), read-only from the thread:
 *  - `implementing` — no proof comment yet, or the newest verdict after it is a fail
 *    (the findings comment doubles as the next session's context).
 *  - `review-due`  — proof posted, no verdict after it yet.
 *  - `passed`      — pass marker after the proof → run the (idempotent) human handoff.
 * `rounds` counts review-fail markers since the last HUMAN comment — the bounce-cap
 * window resets by construction on any human action.
 */
export function analyzeReview(
  snapshot: IssueSnapshot,
  settings: RepoSettings,
): { phase: 'implementing' | 'review-due' | 'passed'; rounds: number } {
  const comments = snapshot.recentComments; // newest-first
  const lastHumanAt = comments.find((c) => isHumanComment(c, settings.botUser))?.createdAt ?? '';
  const rounds = comments.filter(
    (c) => REVIEW_FAIL_RE.test(c.body) && c.createdAt > lastHumanAt,
  ).length;

  const doneAt = comments.find((c) => c.body.includes(DONE_SENTINEL))?.createdAt;
  if (doneAt === undefined) return { phase: 'implementing', rounds };
  const passAt = comments.find(
    (c) => c.body.includes(REVIEW_PASS_SENTINEL) && c.createdAt > doneAt,
  )?.createdAt;
  const failAt = comments.find(
    (c) => REVIEW_FAIL_RE.test(c.body) && c.createdAt > doneAt,
  )?.createdAt;
  if (passAt !== undefined && (failAt === undefined || passAt > failAt)) {
    return { phase: 'passed', rounds };
  }
  if (failAt !== undefined) return { phase: 'implementing', rounds };
  return { phase: 'review-due', rounds };
}

/** Stage → agent role (#29). review:human/done run no agent. */
const STAGE_ROLE = { backlog: 'define', todo: 'plan', 'in-progress': 'implement' } as const;

/**
 * The per-stage pipeline (#29 P2), entered only when the repo's WORKFLOW declares
 * role sections (`rolesDeclared`) — legacy generalist repos keep the original FSM
 * below, byte-for-byte.
 */
function reconcilePipeline(input: ReconcileInput): Intent {
  const { snapshot, settings, slotAvailable, workspaceExists, workComplete } = input;
  const { issue, mr } = snapshot;

  // Blocked modifier first: wait, or surface the human's answer to the stage's agent.
  if (isBlocked(snapshot, settings)) {
    const replies = repliesSinceBlock(snapshot.recentComments, settings.botUser);
    if (replies.length === 0) return { kind: 'blocked-wait' };
    const stage = deriveStage(snapshot, settings);
    const role = stage in STAGE_ROLE ? STAGE_ROLE[stage as keyof typeof STAGE_ROLE] : 'implement';
    return { kind: 'apply-unblock', feedback: { reviewComments: replies }, role };
  }

  const stage = deriveStage(snapshot, settings);
  switch (stage) {
    case 'backlog':
      if (!slotAvailable) return markQueuedOnce(snapshot, settings, 'backlog queued: no slot');
      return { kind: 'run-define' };

    case 'todo':
      if (!slotAvailable) return markQueuedOnce(snapshot, settings, 'todo queued: no slot');
      return { kind: 'run-plan', branch: branchName(issue), mrTitle: mrTitle(issue) };

    case 'in-progress': {
      // The internal review gate (#29 P3) sits between "implementation done" (proof
      // comment) and the human handoff. All signals are thread markers, so the whole
      // sub-state machine is derivable read-only from the snapshot. workComplete
      // (proof posted) is subsumed: passed → handoff, unreviewed → review-due.
      const rv = analyzeReview(snapshot, settings);
      switch (rv.phase) {
        case 'implementing': // no proof yet, or the latest verdict after it was a fail
          if (!slotAvailable)
            return markQueuedOnce(snapshot, settings, 'in-progress queued: no slot');
          return { kind: 'run-agent', resume: true, role: 'implement' };
        case 'review-due':
          if (!slotAvailable) return markQueuedOnce(snapshot, settings, 'review queued: no slot');
          return { kind: 'run-review', rounds: rv.rounds };
        case 'passed':
          return { kind: 'handoff' }; // idempotent ordered sequence (M4) → review:human
        default:
          return assertNever(rv.phase);
      }
    }

    case 'review:human': {
      const ap = mr?.approvals;
      if (ap?.approved) {
        return {
          kind: 'merge',
          strategy: settings.git.mergeStrategy,
          deleteSource: settings.git.deleteSourceBranch,
        };
      }
      if (ap?.changesRequested) {
        return {
          kind: 'apply-changes-requested',
          feedback: { reviewComments: snapshot.recentComments },
        };
      }
      return { kind: 'poll-review' };
    }

    case 'done':
      return workspaceExists ? { kind: 'cleanup' } : { kind: 'none', reason: 'done' };

    default:
      return assertNever(stage);
  }
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

  // 2b. Role pipeline (#29): only when the repo's WORKFLOW opts in via role sections.
  if (input.rolesDeclared) return reconcilePipeline(input);

  // 3. Derive state, compute at most one intent.
  const state = deriveState(snapshot, settings);
  switch (state) {
    case 'new':
      if (slotAvailable) {
        return { kind: 'start-new', branch: branchName(issue), mrTitle: mrTitle(issue) };
      }
      // Queued with no slot: make the queue visible on the forge (#53). `queued` is a
      // marker, not a lifecycle state — deriveState still reads this issue as `new`,
      // so a freed slot starts it exactly as before. Idempotent: marked once.
      return markQueuedOnce(snapshot, settings, 'new issue queued: no concurrency slot');

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
