// Normalize GitLab REST JSON → the frozen §0.2 model so the reconciler stays
// forge-agnostic. This mapping is the reference behaviour M7 (GitHub) mirrors.

import type {
  ApprovalState,
  Comment,
  ForgeUser,
  Issue,
  MergeRequest,
} from '../../contracts/index.js';

export interface RawUser {
  id: number | string;
  username: string;
  avatar_url?: string;
}
export interface RawIssue {
  iid: number;
  id: number | string;
  title: string;
  description: string | null;
  state: string; // 'opened' | 'closed'
  labels: string[];
  assignees?: RawUser[];
  author: RawUser;
  web_url: string;
}
export interface RawMr {
  iid: number;
  id: number | string;
  title: string;
  description: string | null;
  state: string; // 'opened' | 'merged' | 'closed' | 'locked'
  draft?: boolean;
  work_in_progress?: boolean;
  source_branch: string;
  target_branch: string;
  assignees?: RawUser[];
  reviewers?: RawUser[];
  labels: string[];
  web_url: string;
}
export interface RawNote {
  id: number | string;
  author: RawUser;
  body: string;
  created_at: string;
  system?: boolean;
}
export interface RawApprovals {
  approved?: boolean;
  approved_by?: { user: RawUser }[];
  approvals_required?: number;
  approvals_left?: number;
}

export const EMPTY_APPROVALS: ApprovalState = {
  approved: false,
  approvedBy: [],
  changesRequested: false,
};

export function normalizeUser(u: RawUser): ForgeUser {
  return {
    username: u.username,
    id: String(u.id),
    ...(u.avatar_url ? { avatarUrl: u.avatar_url } : {}),
  };
}

export function normalizeIssue(raw: RawIssue): Issue {
  return {
    iid: raw.iid,
    id: String(raw.id),
    title: raw.title,
    body: raw.description ?? '',
    state: raw.state === 'closed' ? 'closed' : 'open',
    assignees: (raw.assignees ?? []).map(normalizeUser),
    labels: raw.labels ?? [],
    author: normalizeUser(raw.author),
    webUrl: raw.web_url,
  };
}

function mapMrState(s: string): MergeRequest['state'] {
  if (s === 'merged') return 'merged';
  if (s === 'closed' || s === 'locked') return 'closed';
  return 'opened';
}

function deriveIsDraft(raw: RawMr): boolean {
  if (typeof raw.draft === 'boolean') return raw.draft;
  if (typeof raw.work_in_progress === 'boolean') return raw.work_in_progress;
  return /^(draft:|wip:)/i.test(raw.title.trim());
}

/** Parse `Closes #N` (and Closes/Fixes/Resolves variants) from an MR description. */
export function parseClosesIid(description: string | null): number | undefined {
  if (!description) return undefined;
  const m = /\b(?:closes|fixes|resolves)\s+#(\d+)/i.exec(description);
  return m ? Number(m[1]) : undefined;
}

export function normalizeMergeRequest(
  raw: RawMr,
  approvals: ApprovalState = EMPTY_APPROVALS,
): MergeRequest {
  const closes = parseClosesIid(raw.description);
  return {
    iid: raw.iid,
    id: String(raw.id),
    title: raw.title,
    description: raw.description ?? '',
    state: mapMrState(raw.state),
    isDraft: deriveIsDraft(raw),
    sourceBranch: raw.source_branch,
    targetBranch: raw.target_branch,
    assignees: (raw.assignees ?? []).map(normalizeUser),
    reviewers: (raw.reviewers ?? []).map(normalizeUser),
    labels: raw.labels ?? [],
    approvals,
    webUrl: raw.web_url,
    ...(closes !== undefined ? { closesIssueIid: closes } : {}),
  };
}

export function normalizeComment(raw: RawNote): Comment {
  return {
    id: String(raw.id),
    author: normalizeUser(raw.author),
    body: raw.body,
    createdAt: raw.created_at,
  };
}

export function normalizeApprovals(raw: RawApprovals): ApprovalState {
  const approved =
    raw.approved === true ||
    (typeof raw.approvals_required === 'number' &&
      raw.approvals_required > 0 &&
      raw.approvals_left === 0);
  return {
    approved,
    approvedBy: (raw.approved_by ?? []).map((a) => normalizeUser(a.user)),
    changesRequested: false, // edge-trigger computed by the adapter (Slice 14)
  };
}
