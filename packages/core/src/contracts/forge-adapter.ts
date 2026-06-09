// Forge adapter interface (spec §0.3). The ONLY forge-aware seam. GitLab (M2) is
// the reference impl; GitHub (M7) mirrors it. All mutations idempotent. FROZEN.

import type { Comment, Issue, IssueSnapshot, Label, MergeRequest, RepoRef } from './forge-model.js';

export type MergeStrategy = 'squash' | 'merge' | 'rebase';

export interface CreateMRArgs {
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string; // includes `Closes #N`
  draft: true; // maestro always opens draft
  assignToBot: boolean;
}

export interface CreateIssueArgs {
  title: string;
  body: string;
  assignToBot: boolean; // for the bootstrap "define my workflow" issue (§16)
}

export interface ForgeAdapter {
  readonly kind: RepoRef['forge'];
  readonly host: string;

  // --- discovery ---
  /** Open issues assigned to bot_user in this repo. Drives active lifecycle. */
  listAssignedOpenIssues(repo: RepoRef): Promise<Issue[]>;
  /** Full snapshot for one issue (issue + its maestro MR + recent comments). */
  getSnapshot(repo: RepoRef, issueIid: number): Promise<IssueSnapshot>;
  /** State of ONE issue by iid regardless of open/closed — used by the cleanup sweep (§0.5). */
  getIssueState(repo: RepoRef, issueIid: number): Promise<'open' | 'closed' | 'missing'>;
  /** Open issues carrying a label — the sweep uses it to retract stale maestro:todo
   *  marks from issues whose bot assignment was removed (#53). */
  listOpenIssuesByLabel(repo: RepoRef, label: string): Promise<Issue[]>;
  /** Open MRs/PRs assigned to bot_user. Drives the command-MR pass (the standalone-MR
   *  `/maestro` trigger, §MR-command) — no backing issue. */
  listAssignedOpenMergeRequests(repo: RepoRef): Promise<MergeRequest[]>;
  /** Comments on an MR/PR thread, normalized + system-filtered, newest-first capped. */
  getMrComments(repo: RepoRef, mrIid: number): Promise<Comment[]>;
  /** MR/PR state for the cleanup sweep: a merged or closed MR is terminal (§0.5). */
  getMergeRequestState(
    repo: RepoRef,
    mrIid: number,
  ): Promise<'open' | 'closed' | 'merged' | 'missing'>;

  // --- mutation (all idempotent) ---
  createBranch(repo: RepoRef, name: string, fromRef: string): Promise<void>;
  createDraftMR(repo: RepoRef, args: CreateMRArgs): Promise<MergeRequest>;
  updateMRDescription(repo: RepoRef, mrIid: number, body: string): Promise<void>;
  setDraft(repo: RepoRef, mrIid: number, draft: boolean): Promise<void>;
  assignMR(repo: RepoRef, mrIid: number, username: string): Promise<void>;
  mergeMR(
    repo: RepoRef,
    mrIid: number,
    strategy: MergeStrategy,
    deleteSource: boolean,
  ): Promise<void>;
  /** Close an open MR/PR WITHOUT merging — the daemon-action `/maestro close` (#88).
   *  Idempotent: a no-op on an already closed or merged MR. */
  closeMR(repo: RepoRef, mrIid: number): Promise<void>;

  setIssueLabels(repo: RepoRef, issueIid: number, set: string[], unset: string[]): Promise<void>;
  commentIssue(repo: RepoRef, issueIid: number, body: string): Promise<void>;
  commentMR(repo: RepoRef, mrIid: number, body: string): Promise<void>;

  // --- onboarding / setup (§11, §16) ---
  ensureLabels(repo: RepoRef, labels: Label[]): Promise<void>; // create missing; no-op existing
  ensureBoard?(repo: RepoRef, orderedLabels: Label[]): Promise<void>; // GitLab only; undefined on GitHub
  createIssue(repo: RepoRef, args: CreateIssueArgs): Promise<Issue>;
}

/** Compile-time read-only narrowing for the web dashboard (AM-15). */
export type ReadOnlyForgeAdapter = Pick<
  ForgeAdapter,
  'kind' | 'listAssignedOpenIssues' | 'getSnapshot' | 'getIssueState'
>;
