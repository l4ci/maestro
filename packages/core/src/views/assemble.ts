// Read-model assembly (M6 OD-2/OD-5/OD-7). Pure functions that project the forge (via a
// READ-ONLY-narrowed adapter — mutating calls aren't even in the type) plus the logs
// cache into serializable view objects. The CLI formatters AND the web dashboard consume
// the SAME assembly — no divergent view logic. State is the core `deriveState` (§0.4),
// never re-derived here, so the dashboard and the daemon always agree.

import type {
  ForgeUser,
  IssueSnapshot,
  LifecycleState,
  LogLine,
  LogReader,
  ReadOnlyForgeAdapter,
  RepoRef,
  RepoSettings,
} from '../contracts/index.js';
import type { Heartbeat } from '../daemon/heartbeat.js';
import { deriveState } from '../reconciler/reconcile.js';

/** The single newest signal across an issue's three activity sources (#39), projected for
 *  the dashboard. `at` is ISO 8601 (rendered relative, with the absolute time on hover);
 *  `summary` is a short, forge-controlled string the page MUST render as inert text. */
export interface LastActivity {
  at: string; // ISO 8601 of the newest movement
  source: 'issue' | 'mr' | 'agent';
  summary: string; // truncated; attacker-controlled on public repos (§13.1)
}

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
  lastActivity?: LastActivity; // newest of issue/MR/agent movement, when any is known (#39)
}

export interface RepoView {
  repo: RepoRef;
  issues: IssueView[];
  counts: Record<LifecycleState, number>;
  error?: string; // per-repo degradation marker (E3) — never a whole-dashboard 500
}

export interface DashboardView {
  repos: RepoView[];
  /** Daemon liveness (#40). `undefined` when no heartbeat file exists (daemon never ran);
   *  the page ages `lastTickAt` against `tickIntervalMs` to read up / stale. The forge view
   *  is otherwise unchanged — a dead daemon must not look like a healthy empty board. */
  daemon?: Heartbeat;
}

export interface AssembleDeps {
  adapterFor: (repo: RepoRef) => ReadOnlyForgeAdapter;
  settingsFor: (repo: RepoRef) => RepoSettings;
  logs: LogReader;
  /** Reads the daemon heartbeat from the shared logs root; `undefined` (or omitted) → no
   *  signal. Synchronous (a tiny local file) and called once per dashboard assembly. */
  heartbeat?: () => Heartbeat | undefined;
}

function zeroCounts(): Record<LifecycleState, number> {
  return { new: 0, 'in-progress': 0, 'in-review': 0, blocked: 0, done: 0 };
}

const SUMMARY_CAP = 80;

/** Collapse whitespace and cap to ~80 chars with an ellipsis, so a multi-line or huge
 *  comment body renders as one short line. Inert-text safety is the renderer's job. */
function truncate(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SUMMARY_CAP ? `${flat.slice(0, SUMMARY_CAP - 1)}…` : flat;
}

/**
 * The unified last-activity line (#39): the single newest movement across the three
 * sources an issue can move through — a new issue comment, an MR review thread or bot
 * push, and the daemon's own log. Each candidate carries its own timestamp; the newest
 * (lexicographic on ISO 8601) wins. Sources without a signal simply don't compete, and
 * when none do the whole line is omitted (caller spreads it conditionally).
 */
export function lastActivityOf(snapshot: IssueSnapshot, log?: LogLine): LastActivity | undefined {
  const candidates: LastActivity[] = [];

  const comment = snapshot.recentComments[0];
  if (comment) {
    candidates.push({
      at: comment.createdAt,
      source: 'issue',
      summary: truncate(`@${comment.author.username}: ${comment.body}`),
    });
  }

  const mrAt = snapshot.mrActivityAt;
  if (mrAt) {
    candidates.push({
      at: mrAt.at,
      source: 'mr',
      summary: mrAt.kind === 'push' ? 'bot pushed a commit' : 'review thread',
    });
  }

  if (log) candidates.push({ at: log.ts, source: 'agent', summary: truncate(log.msg) });

  return candidates.sort((a, b) => b.at.localeCompare(a.at))[0];
}

async function issueView(repo: RepoRef, iid: number, deps: AssembleDeps): Promise<IssueView> {
  const adapter = deps.adapterFor(repo);
  const snapshot = await adapter.getSnapshot(repo, iid);
  const state = deriveState(snapshot, deps.settingsFor(repo));
  const log = (await deps.logs.readIssueLog(repo, iid, 1)).at(-1);
  const lastLog = log?.msg;
  const lastActivity = lastActivityOf(snapshot, log);
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
    ...(lastActivity ? { lastActivity } : {}),
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
  const daemon = deps.heartbeat?.();
  return { repos: out, ...(daemon ? { daemon } : {}) };
}
