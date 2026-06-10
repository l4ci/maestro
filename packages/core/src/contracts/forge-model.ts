// Normalized forge model (spec §0.2). The reconciler only ever sees these types;
// glab/gh differences are erased by the adapter. FROZEN — see plan maestro-00.

export type ForgeKind = 'gitlab' | 'github';

/** Lifecycle states. Order matters for board list ordering (§11). */
export type LifecycleState =
  | 'new' // assigned to bot, no maestro:: label
  | 'in-progress'
  | 'in-review'
  | 'blocked'
  | 'done'; // issue closed (terminal)
// 'handoff' is NOT a label — it is a transient computed step (see §0.4 / M4).

export interface ForgeUser {
  username: string; // canonical handle, no '@'
  id: string; // forge-native id as string
  avatarUrl?: string; // forge-hosted profile image, when the raw payload carries one (#37)
}

export interface Label {
  name: string; // e.g. 'maestro::in-progress' (GitLab) or 'maestro:in-progress' (GitHub)
  id?: string; // forge-native; optional (GitHub addresses labels by name)
}

export interface Issue {
  iid: number; // per-project issue number (GitLab iid / GitHub number)
  id: string; // global id as string
  title: string;
  body: string; // description; attacker-controlled on public repos (§13.1)
  state: 'open' | 'closed';
  assignees: ForgeUser[];
  labels: string[]; // names only
  author: ForgeUser;
  webUrl: string;
  /** Who performed the most recent assignment/label add, when known — trigger guard (§13.1). */
  lastActor?: ForgeUser;
}

export interface MergeRequest {
  // MR≡PR throughout
  iid: number;
  id: string;
  title: string;
  description: string; // the agent's durable scratchpad: plan + checkbox todo (§9)
  state: 'opened' | 'merged' | 'closed';
  isDraft: boolean;
  sourceBranch: string;
  targetBranch: string;
  assignees: ForgeUser[];
  reviewers: ForgeUser[]; // review requested from these users (GitLab reviewer_ids / GitHub requested_reviewers); handoff requests the ticket creator (§7)
  labels: string[];
  approvals: ApprovalState;
  webUrl: string;
  /** linkage back to the issue this MR Closes (parsed from body or API), if resolvable */
  closesIssueIid?: number;
}

export interface ApprovalState {
  approved: boolean; // GitLab: required approval met; GitHub: an APPROVED review exists, none later request changes
  approvedBy: ForgeUser[];
  changesRequested: boolean; // edge-triggered per the adapter (§0.3 note)
}

export interface Comment {
  id: string;
  author: ForgeUser;
  body: string;
  createdAt: string; // ISO 8601
}

/** Newest MR-side movement, derived from the edge-trigger timestamps the snapshot already
 *  fetches (a blocking review thread or a bot push). Exposed for the dashboard's unified
 *  last-activity line (#39); the reconciler never reads it. */
export interface MrActivity {
  at: string; // ISO 8601
  kind: 'thread' | 'push'; // a review thread vs. a bot commit push
}

/** Everything the reconciler needs about ONE issue, gathered by the adapter in one snapshot. */
export interface IssueSnapshot {
  repo: RepoRef;
  issue: Issue;
  mr?: MergeRequest; // the maestro MR for this issue, if one exists
  recentComments: Comment[]; // newest-first; bounded (adapter caps, e.g. last 50)
  mrActivityAt?: MrActivity; // newest MR review-thread / bot-push timestamp (#39), when an MR exists
}

export interface RepoRef {
  forge: ForgeKind;
  host: string; // gitlab.com / github.com / self-hosted
  project: string; // 'group/repo' (GitLab path) or 'org/repo' (GitHub)
  url: string; // canonical url as configured
}
