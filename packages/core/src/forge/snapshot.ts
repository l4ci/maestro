// Snapshot assembly — the forge-agnostic choreography that turns one issue into an
// IssueSnapshot (§0.2/§0.3). Before the M2/M7 merge this lived duplicated in both
// adapters: identical call order, identical comment sort/slice, identical maestro-MR
// selection, and — the subtle one — an identical edge-triggered changes-requested
// comparison. A fix to one forge silently left the other wrong.
//
// The algorithm now lives once, above a narrow ForgePrimitives seam. Each adapter
// supplies only the forge-specific PIECES (normalized model objects + two timestamps);
// this module owns every decision. A third forge writes primitives, never an algorithm.

import { z } from 'zod';
import type {
  ApprovalState,
  CiStatus,
  Comment,
  ForgeKind,
  ForgeUser,
  Issue,
  IssueSnapshot,
  MergeRequest,
  MrActivity,
  RepoRef,
} from '../contracts/index.js';
import { CommentSchema, IssueSchema, MergeRequestSchema } from '../contracts/index.js';
import { isHumanComment, isMaestroCommand } from './comments.js';
import { SnapshotValidationError } from './errors.js';

const CommentsSchema = z.array(CommentSchema);

/**
 * Verify one normalized piece against its §0.2 schema — the runtime check of the
 * ForgePrimitives promise (issue #108). A violation throws naming the forge and the
 * failing field path, so a normalization bug fails AT assembly instead of crashing the
 * reconciler or views far from its cause; the lifecycle pass's per-issue catch contains
 * the blast radius to that issue's tick. The original object is kept (zod's parsed copy
 * is discarded), so valid data flows through byte-identical.
 */
function checkPiece<T>(forge: ForgeKind, piece: string, schema: z.ZodType<unknown>, value: T): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = [piece, ...(first?.path ?? [])].join('.');
    throw new SnapshotValidationError(
      forge,
      path,
      first?.message ?? 'invalid',
      result.error.issues.length,
    );
  }
  return value;
}

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
  /** Timestamp of the newest commit on the MR's source branch (author-AGNOSTIC), or undefined
   *  if the branch carries no commits. NOT filtered by bot_user — on a shared account the
   *  agent's commits wear the operator's git identity; the daemon owns the branch, so any
   *  commit post-dating the blocking signal counts as the feedback being addressed (issue #5). */
  lastBotPushAt(mr: MergeRequest): Promise<string | undefined>;
  /** Head-commit pipeline conclusion for the MR's source branch (#118). `none` when the
   *  head commit has no pipeline. Read only for an OPEN candidate AND only when the repo
   *  opts into the gate (#120) — the gate only fires at the handoff of in-flight work; the
   *  snapshot short-circuits it otherwise. */
  ciStatus(mr: MergeRequest): Promise<CiStatus>;
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
  if (lastBotPushAt === undefined) return true; // unaddressed feedback, no commit on the branch since
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
  ciGate = false,
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
  // CI status (#118/#120): gated twice — only when the repo opts into the gate (`ciGate`)
  // AND only for an OPEN candidate (a closed/merged match never reaches the handoff). A
  // gate-off repo pays NO pipeline read; the reconciler treats an absent ci as `none`.
  const ci = ciGate && candidate.state === 'opened' ? await prim.ciStatus(candidate) : undefined;
  return {
    mr: { ...candidate, approvals: { ...base, changesRequested }, ...(ci ? { ci } : {}) },
    ...(activityAt ? { activityAt } : {}),
  };
}

/** The newest body-start command timestamp, or undefined. A body-start `/maestro` (any
 *  author — the daemon leads every comment with a heading and the agent has no forge access,
 *  §13.1, so it can only be a human keystroke), or a body-start `@<botUser>` mention from a
 *  non-bot author (the dedicated-account trigger, isMaestroCommand). Comments are
 *  newest-first; `botUser` may be undefined on the shared-account path. */
function issueCommandAt(
  recentComments: Comment[],
  botUser: string | undefined,
): string | undefined {
  return recentComments.find((c) => isMaestroCommand(c, botUser))?.createdAt;
}

/**
 * The newest body-start `/maestro` issue command the daemon has NOT yet answered (#7).
 * `computeChangesRequested` retires this signal only on a branch commit that post-dates it —
 * but a resumed task can legitimately produce NO commit (the requested change already lived in
 * the target). The command then reads as permanent changes-requested and bounces the MR
 * in-progress↔in-review on every poll, burning an agent run each time. A DAEMON comment
 * (bot-authored, non-command) that post-dates the command is independent proof the agent ran
 * and responded, so the command is addressed even with no push. The push clear is preserved
 * for the no-daemon-reply case (the original self-clearing path). With `botUser` unknown the
 * shared-account thread can't tell daemon from operator, so it falls back to push-only
 * clearing — both adapters always supply it.
 */
function unansweredIssueCommandAt(
  recentComments: Comment[],
  botUser: string | undefined,
): string | undefined {
  const commandAt = issueCommandAt(recentComments, botUser);
  if (commandAt === undefined || botUser === undefined) return commandAt;
  const answeredAt = recentComments.find((c) => !isHumanComment(c, botUser))?.createdAt;
  return answeredAt !== undefined && answeredAt > commandAt ? undefined : commandAt;
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
  botUser?: string,
  ciGate = false,
): Promise<IssueSnapshot> {
  const issue = await prim.issue(issueIid);
  const lastActor = await prim.lastActor(issueIid);
  // Validated AFTER the merge so the lastActor primitive's output is covered too.
  const issueWithActor: Issue = checkPiece(
    repo.forge,
    'issue',
    IssueSchema,
    lastActor ? { ...issue, lastActor } : issue,
  );

  // Validated BEFORE the sort — a malformed createdAt would otherwise crash inside the
  // comparator with no forge or field path attached.
  const recentComments = checkPiece(
    repo.forge,
    'recentComments',
    CommentsSchema,
    await prim.comments(issueIid),
  )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, commentCap);

  // Comments are read BEFORE the MR so the issue-thread /maestro signal can feed the MR's
  // changes-requested edge (shared-account rework on the issue thread, self-clearing on push).
  const found = await findMaestroMr(
    issueIid,
    prim,
    unansweredIssueCommandAt(recentComments, botUser),
    ciGate,
  );
  // The CHOSEN MR is validated after its approvals are filled, covering both the
  // openMergeRequests and approvalBase primitives. The rest of the candidate pool is
  // not — on GitHub it is repo-wide, and other issues' MRs are other ticks' business.
  if (found) checkPiece(repo.forge, 'mr', MergeRequestSchema, found.mr);

  return {
    repo,
    issue: issueWithActor,
    recentComments,
    ...(found ? { mr: found.mr } : {}),
    ...(found?.activityAt ? { mrActivityAt: found.activityAt } : {}),
  };
}
