// Normalize GitHub REST/GraphQL JSON → the frozen §0.2 model so the reconciler
// stays forge-agnostic. Mirrors gitlab/normalize.ts; GitHub diverges on label
// shape (objects with `name`), draft (native `draft` boolean), state (`merged`),
// and ApprovalState (derived from PR reviews, not an approvals endpoint).

import type {
  ApprovalState,
  CiStatus,
  Comment,
  ForgeUser,
  Issue,
  MergeRequest,
} from '../../contracts/index.js';

export interface RawUser {
  id: number | string;
  login: string;
  avatar_url?: string;
}
/** GitHub labels are objects on issues/PRs; some endpoints return bare strings. */
export type RawLabel = { name: string; id?: number | string } | string;
export interface RawIssue {
  number: number;
  node_id?: string;
  id: number | string;
  title: string;
  body: string | null;
  state: string; // 'open' | 'closed'
  labels: RawLabel[];
  assignees?: RawUser[];
  user: RawUser; // author
  html_url: string;
  pull_request?: unknown; // present iff this "issue" is actually a PR — filtered out
}
export interface RawPr {
  number: number;
  node_id?: string;
  id: number | string;
  title: string;
  body: string | null;
  state: string; // 'open' | 'closed'
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  head: { ref: string; sha?: string };
  base: { ref: string };
  assignees?: RawUser[];
  requested_reviewers?: RawUser[];
  labels: RawLabel[];
  html_url: string;
}
export interface RawComment {
  id: number | string;
  user: RawUser;
  body: string;
  created_at: string;
}
export interface RawReview {
  id: number | string;
  user: RawUser | null;
  state: string; // 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | …
  submitted_at: string | null;
}
export interface RawCommit {
  sha: string;
  commit: {
    message?: string;
    committer?: { date?: string };
    author?: { date?: string; email?: string };
  };
  author: RawUser | null;
  committer: RawUser | null;
}
export interface RawTimelineEvent {
  event: string; // 'assigned' | 'labeled' | …
  actor?: RawUser | null;
  created_at?: string;
}

/** A single check-run for the head commit (`/commits/{ref}/check-runs`). `status` is the
 *  run's lifecycle (queued|in_progress|completed); `conclusion` is set once completed. */
export interface RawCheckRun {
  status?: string;
  conclusion?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  html_url?: string | null;
  details_url?: string | null;
}
export interface RawCheckRunsResponse {
  total_count?: number;
  check_runs?: RawCheckRun[];
}
/** The legacy combined commit status (`/commits/{ref}/status`). `state` aggregates the
 *  commit-status contexts; `total_count` is 0 when a commit has no statuses at all. */
export interface RawCombinedStatus {
  state?: string; // 'success' | 'pending' | 'failure' | 'error'
  total_count?: number;
}

// A completed check-run with one of these conclusions is a hard failure. `action_required`
// and `stale` are deliberately NOT failures: they fold into success for v1 (spec §12, the
// GitLab `manual` twin) — maestro reacts to the aggregate, not manual gates.
const CHECK_FAILED = new Set(['failure', 'timed_out', 'cancelled']);

/** Newest `completed_at ?? started_at` across the runs — the round-cap / wait_timeout window. */
function latestCheckAt(runs: RawCheckRun[]): string | undefined {
  return runs
    .map((r) => r.completed_at ?? r.started_at ?? '')
    .filter(Boolean)
    .sort()
    .at(-1);
}

function ciStatusWith(
  conclusion: CiStatus['conclusion'],
  runs: RawCheckRun[],
  deciding: RawCheckRun | undefined,
): CiStatus {
  const at = latestCheckAt(runs);
  const webUrl = deciding?.html_url ?? deciding?.details_url ?? undefined;
  return {
    conclusion,
    ...(at ? { at } : {}),
    ...(webUrl ? { webUrl } : {}),
  };
}

/**
 * Fold GitHub's two CI surfaces — check-runs and the legacy combined commit status — into
 * one §0.2 CiStatus for the head commit (#120). Precedence is failed → running → success →
 * none, so a single red check or a `failure`/`error` combined status wins over greens, and
 * an in-flight check or a `pending` combined status holds. `none` only when the commit has
 * neither check-runs nor commit statuses (repos without CI are unaffected). A `pending`
 * combined status with zero statuses is GitHub's empty default and never, on its own,
 * promotes the conclusion above `none`.
 */
export function normalizeCiStatus(
  checkRuns: RawCheckRun[],
  combined: RawCombinedStatus | null | undefined,
): CiStatus {
  const hasStatuses = (combined?.total_count ?? 0) > 0;
  const state = combined?.state;

  const failedRun = checkRuns.find((c) => c.conclusion != null && CHECK_FAILED.has(c.conclusion));
  if (failedRun || (hasStatuses && (state === 'failure' || state === 'error'))) {
    return ciStatusWith('failed', checkRuns, failedRun);
  }

  const runningRun = checkRuns.find((c) => c.status != null && c.status !== 'completed');
  if (runningRun || (hasStatuses && state === 'pending')) {
    return ciStatusWith('running', checkRuns, runningRun);
  }

  if (checkRuns.length > 0 || hasStatuses) return ciStatusWith('success', checkRuns, undefined);
  return { conclusion: 'none' };
}

export const EMPTY_APPROVALS: ApprovalState = {
  approved: false,
  approvedBy: [],
  changesRequested: false,
};

export function normalizeUser(u: RawUser): ForgeUser {
  return {
    username: u.login,
    id: String(u.id),
    ...(u.avatar_url ? { avatarUrl: u.avatar_url } : {}),
  };
}

function labelName(l: RawLabel): string {
  return typeof l === 'string' ? l : l.name;
}

function globalId(node_id: string | undefined, id: number | string): string {
  return String(node_id ?? id);
}

export function normalizeIssue(raw: RawIssue): Issue {
  return {
    iid: raw.number,
    id: globalId(raw.node_id, raw.id),
    title: raw.title,
    body: raw.body ?? '',
    state: raw.state === 'closed' ? 'closed' : 'open',
    assignees: (raw.assignees ?? []).map(normalizeUser),
    labels: (raw.labels ?? []).map(labelName),
    author: normalizeUser(raw.user),
    webUrl: raw.html_url,
  };
}

function mapPrState(raw: RawPr): MergeRequest['state'] {
  if (raw.merged === true || (raw.merged_at != null && raw.merged_at !== '')) return 'merged';
  if (raw.state === 'closed') return 'closed';
  return 'opened';
}

/** Parse `Closes #N` (and Closes/Fixes/Resolves variants) from a PR body. */
export function parseClosesIid(body: string | null): number | undefined {
  if (!body) return undefined;
  const m = /\b(?:closes|fixes|resolves)\s+#(\d+)/i.exec(body);
  return m ? Number(m[1]) : undefined;
}

export function normalizeMergeRequest(
  raw: RawPr,
  approvals: ApprovalState = EMPTY_APPROVALS,
): MergeRequest {
  const closes = parseClosesIid(raw.body);
  return {
    iid: raw.number,
    id: globalId(raw.node_id, raw.id),
    title: raw.title,
    description: raw.body ?? '',
    state: mapPrState(raw),
    isDraft: raw.draft === true,
    sourceBranch: raw.head.ref,
    targetBranch: raw.base.ref,
    assignees: (raw.assignees ?? []).map(normalizeUser),
    reviewers: (raw.requested_reviewers ?? []).map(normalizeUser),
    labels: (raw.labels ?? []).map(labelName),
    approvals,
    webUrl: raw.html_url,
    ...(closes !== undefined ? { closesIssueIid: closes } : {}),
  };
}

export function normalizeComment(raw: RawComment): Comment {
  return {
    id: String(raw.id),
    author: normalizeUser(raw.user),
    body: raw.body,
    createdAt: raw.created_at,
  };
}

/**
 * Reduce PR reviews to the §0.2 ApprovalState (sans the edge-triggered
 * changesRequested, which the adapter folds in from commit timing). Latest review
 * per reviewer wins (by submitted_at): `approved` iff at least one reviewer's
 * latest state is APPROVED and no reviewer's latest is CHANGES_REQUESTED.
 */
export function normalizeReviews(reviews: RawReview[]): ApprovalState {
  const latest = latestPerReviewer(reviews);
  const states = [...latest.values()];
  const approvedBy = [...latest.entries()]
    .filter(([, r]) => r.state === 'APPROVED')
    .map(([, r]) => normalizeUser(r.user as RawUser));
  const anyChanges = states.some((r) => r.state === 'CHANGES_REQUESTED');
  const anyApproved = states.some((r) => r.state === 'APPROVED');
  return {
    approved: anyApproved && !anyChanges,
    approvedBy,
    changesRequested: false, // edge-trigger computed by the adapter (Slice 14)
  };
}

/** submitted_at of the newest review whose latest-per-reviewer state is CHANGES_REQUESTED. */
export function changesRequestedSince(reviews: RawReview[]): string | undefined {
  const latest = latestPerReviewer(reviews);
  return [...latest.values()]
    .filter((r) => r.state === 'CHANGES_REQUESTED')
    .map((r) => r.submitted_at ?? '')
    .filter(Boolean)
    .sort()
    .at(-1);
}

function latestPerReviewer(reviews: RawReview[]): Map<string, RawReview> {
  const latest = new Map<string, RawReview>();
  for (const r of reviews) {
    if (!r.user) continue;
    if (r.state !== 'APPROVED' && r.state !== 'CHANGES_REQUESTED') continue; // COMMENTED/DISMISSED ignored
    const key = r.user.login;
    const prev = latest.get(key);
    if (!prev || (r.submitted_at ?? '') >= (prev.submitted_at ?? '')) latest.set(key, r);
  }
  return latest;
}
