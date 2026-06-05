// Read-model assembly (M6 OD-2/OD-5/OD-7). Pure functions that project the forge (via a
// READ-ONLY-narrowed adapter — mutating calls aren't even in the type) plus the logs
// cache into serializable view objects. The CLI formatters AND the web dashboard consume
// the SAME assembly — no divergent view logic. State is the core `deriveState` (§0.4),
// never re-derived here, so the dashboard and the daemon always agree.

import type {
  ForgeUser,
  LifecycleState,
  LogReader,
  ReadOnlyForgeAdapter,
  RepoRef,
  RepoSettings,
} from '../contracts/index.js';
import { deriveState } from '../reconciler/reconcile.js';

export interface IssueView {
  iid: number;
  title: string;
  state: LifecycleState;
  issueUrl: string; // canonical forge URL — adapter-supplied, never synthesized (#35)
  mrUrl?: string;
  isDraft?: boolean;
  approved?: boolean;
  lastLog?: string;
  author: ForgeUser; // the issue reporter (#37)
  reviewer?: ForgeUser; // MR assignee — the ticket creator assigned at handoff; absent before (#37)
}

export interface RepoView {
  repo: RepoRef;
  issues: IssueView[];
  counts: Record<LifecycleState, number>;
  error?: string; // per-repo degradation marker (E3) — never a whole-dashboard 500
}

export interface DashboardView {
  repos: RepoView[];
}

export interface AssembleDeps {
  adapterFor: (repo: RepoRef) => ReadOnlyForgeAdapter;
  settingsFor: (repo: RepoRef) => RepoSettings;
  logs: LogReader;
}

function zeroCounts(): Record<LifecycleState, number> {
  return { new: 0, 'in-progress': 0, 'in-review': 0, blocked: 0, done: 0 };
}

async function issueView(repo: RepoRef, iid: number, deps: AssembleDeps): Promise<IssueView> {
  const adapter = deps.adapterFor(repo);
  const snapshot = await adapter.getSnapshot(repo, iid);
  const state = deriveState(snapshot, deps.settingsFor(repo));
  const lastLog = (await deps.logs.readIssueLog(repo, iid, 1)).at(-1)?.msg;
  const mr = snapshot.mr;
  // The reviewer is whoever the MR is assigned to — handoff assigns the ticket creator
  // (§7), so before handoff (or on a bare MR) there is simply no assignee to show.
  const reviewer = mr?.assignees[0];
  return {
    iid,
    title: snapshot.issue.title,
    state,
    issueUrl: snapshot.issue.webUrl,
    author: snapshot.issue.author,
    ...(mr ? { mrUrl: mr.webUrl, isDraft: mr.isDraft, approved: mr.approvals.approved } : {}),
    ...(reviewer ? { reviewer } : {}),
    ...(lastLog ? { lastLog } : {}),
  };
}

/** One issue's view (CLI `status`). */
export function assembleIssue(repo: RepoRef, iid: number, deps: AssembleDeps): Promise<IssueView> {
  return issueView(repo, iid, deps);
}

/** The full read-only dashboard: per-repo issues + per-state tallies, resilient to a
 *  forge that can't be reached for one repo (E3). */
export async function assembleDashboard(
  repos: RepoRef[],
  deps: AssembleDeps,
): Promise<DashboardView> {
  const out: RepoView[] = [];
  for (const repo of repos) {
    try {
      const issues = await deps.adapterFor(repo).listAssignedOpenIssues(repo);
      const views: IssueView[] = [];
      const counts = zeroCounts();
      for (const issue of issues) {
        const v = await issueView(repo, issue.iid, deps);
        views.push(v);
        counts[v.state] += 1;
      }
      out.push({ repo, issues: views, counts });
    } catch (err) {
      out.push({ repo, issues: [], counts: zeroCounts(), error: String((err as Error).message) });
    }
  }
  return { repos: out };
}
