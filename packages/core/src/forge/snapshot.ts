// Snapshot assembly — the forge-agnostic choreography that turns one issue into an
// IssueSnapshot (§0.2/§0.3). Before the M2/M7 merge this lived duplicated in both
// adapters: identical call order, identical comment sort/slice, identical maestro-MR
// selection, and — the subtle one — an identical edge-triggered changes-requested
// comparison. A fix to one forge silently left the other wrong.
//
// The algorithm now lives once, above a narrow ForgePrimitives seam. Each adapter
// supplies only the forge-specific PIECES (normalized model objects + two timestamps);
// this module owns every decision. A third forge writes primitives, never an algorithm.

import type {
  ApprovalState,
  Comment,
  ForgeUser,
  Issue,
  IssueSnapshot,
  MergeRequest,
  MrActivity,
  RepoRef,
} from '../contracts/index.js';
import { MAESTRO_COMMAND_RE } from '../contracts/index.js';

/** The later of two ISO timestamps; either may be undefined. */
function laterOf(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a > b ? a : b;
}

/**
 * The forge-specific fetches the snapshot algorithm composes. Everything returned is
 * already normalized to the §0.2 model; the adapter's ForgeCli + normalize live below
 * this seam, the choreography above it. `repo` is captured by the implementation.
 */
export interface ForgePrimitives {
  /** The issue itself. Throws (not null) if absent — a missing assigned issue is a bug. */
  issue(issueIid: number): Promise<Issue>;
  /** Who performed the most recent assignment/label add, if known (trigger guard §13.1). */
  lastActor(issueIid: number): Promise<ForgeUser | undefined>;
  /** Recent comments, normalized and system-notes filtered, in any order (caller sorts). */
  comments(issueIid: number): Promise<Comment[]>;
  /** Candidate MR pool for this issue (approvals left EMPTY — the algorithm fills them). */
  openMergeRequests(issueIid: number): Promise<MergeRequest[]>;
  /** Approval base for the chosen MR: approved / approvedBy, with changesRequested=false. */
  approvalBase(mrIid: number): Promise<ApprovalState>;
  /** Timestamp of the newest unresolved non-bot blocking thread, or undefined if none. */
  blockingThreadAt(mrIid: number): Promise<string | undefined>;
  /** Timestamp of the newest bot commit on the MR's source branch, or undefined. */
  lastBotPushAt(mr: MergeRequest): Promise<string | undefined>;
}

/**
 * Edge-triggered changes-requested (§0.3): changes are outstanding iff a blocking thread
 * post-dates the last bot push. No blocking thread → not requested; blocking but no bot
 * push since → requested. This is the comparison that was duplicated per forge.
 */
export function computeChangesRequested(
  blockingAt: string | undefined,
  lastBotPushAt: string | undefined,
): boolean {
  if (blockingAt === undefined) return false;
  if (lastBotPushAt === undefined) return true; // unaddressed feedback, no bot push since
  return blockingAt > lastBotPushAt;
}

/**
 * Pick this issue's maestro MR from the candidate pool and fill its ApprovalState.
 * Match on the maestro branch prefix or a `Closes #iid` link; prefer an open MR, else
 * any match. The blocking-thread read short-circuits the commit read (no blocking → no
 * need to know the last push), preserving the per-forge optimization.
 */
export async function findMaestroMr(
  issueIid: number,
  prim: ForgePrimitives,
  issueBlockingAt?: string,
): Promise<{ mr: MergeRequest; activityAt?: MrActivity } | undefined> {
  const pool = await prim.openMergeRequests(issueIid);
  const prefix = `maestro/issue-${issueIid}-`;
  const matches = (m: MergeRequest): boolean =>
    m.sourceBranch.startsWith(prefix) || m.closesIssueIid === issueIid;
  const candidate = pool.find((m) => m.state === 'opened' && matches(m)) ?? pool.find(matches);
  if (!candidate) return undefined;

  const base = await prim.approvalBase(candidate.iid);
  // Two blocking surfaces, one edge: the MR's own review thread AND the issue thread's
  // body-start `/maestro` feedback (the shared-account case — the operator replies on the
  // issue, where the daemon posts everything, because their account IS the bot's, so they
  // cannot file a non-bot MR review). Both are "changes requested" and BOTH clear the same
  // way — a bot push that post-dates them (computeChangesRequested). Folding the issue
  // signal in here (rather than as a separate reconciler edge) is what makes it self-clear:
  // a separate edge keyed only on "newest daemon comment" never retired on a push and looped.
  const threadAt = await prim.blockingThreadAt(candidate.iid);
  const blockingAt = laterOf(threadAt, issueBlockingAt);
  // The push read short-circuits when NOTHING blocks (the per-forge hot-path optimization the
  // reconciler depends on): no thread and no issue command → no commit fetch. A standing
  // /maestro command now DOES trigger the fetch, which is exactly what lets it clear on push.
  const lastBotPushAt = blockingAt === undefined ? undefined : await prim.lastBotPushAt(candidate);
  const changesRequested = computeChangesRequested(blockingAt, lastBotPushAt);
  const activityAt = newestMrActivity(blockingAt, lastBotPushAt);
  return {
    mr: { ...candidate, approvals: { ...base, changesRequested } },
    ...(activityAt ? { activityAt } : {}),
  };
}

/** The newest body-start `/maestro` comment timestamp, or undefined. Any author: the daemon
 *  leads every comment with a heading and the agent has no forge access (§13.1), so a
 *  body-start command can only be a human keystroke. Comments are newest-first. */
function issueCommandAt(recentComments: Comment[]): string | undefined {
  return recentComments.find((c) => MAESTRO_COMMAND_RE.test(c.body))?.createdAt;
}

/** The newer of a blocking review thread vs. the last bot push, tagged with which it was.
 *  Only timestamps already fetched are considered (the push read is short-circuited). */
function newestMrActivity(
  blockingAt: string | undefined,
  lastBotPushAt: string | undefined,
): MrActivity | undefined {
  if (lastBotPushAt !== undefined && (blockingAt === undefined || lastBotPushAt > blockingAt)) {
    return { at: lastBotPushAt, kind: 'push' };
  }
  if (blockingAt !== undefined) return { at: blockingAt, kind: 'thread' };
  return undefined;
}

/**
 * Assemble one issue's full snapshot: issue (+ lastActor) → maestro MR (+ approvals) →
 * recent comments (newest-first, capped). The single choreography both adapters delegate
 * `getSnapshot` to.
 */
export async function assembleSnapshot(
  repo: RepoRef,
  issueIid: number,
  prim: ForgePrimitives,
  commentCap: number,
): Promise<IssueSnapshot> {
  const issue = await prim.issue(issueIid);
  const lastActor = await prim.lastActor(issueIid);
  const issueWithActor: Issue = lastActor ? { ...issue, lastActor } : issue;

  const recentComments = (await prim.comments(issueIid))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, commentCap);

  // Comments are read BEFORE the MR so the issue-thread /maestro signal can feed the MR's
  // changes-requested edge (shared-account rework on the issue thread, self-clearing on push).
  const found = await findMaestroMr(issueIid, prim, issueCommandAt(recentComments));

  return {
    repo,
    issue: issueWithActor,
    recentComments,
    ...(found ? { mr: found.mr } : {}),
    ...(found?.activityAt ? { mrActivityAt: found.activityAt } : {}),
  };
}
