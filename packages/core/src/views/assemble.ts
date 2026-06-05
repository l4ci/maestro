// Read-model assembly (M6 OD-2/OD-5/OD-7). Pure functions that project the forge (via a
// READ-ONLY-narrowed adapter — mutating calls aren't even in the type) plus the logs
// cache into serializable view objects. The CLI formatters AND the web dashboard consume
// the SAME assembly — no divergent view logic. State is the core `deriveState` (§0.4),
// never re-derived here, so the dashboard and the daemon always agree.

import type {
  Comment,
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

/** One parsed checklist line off the MR description (#41). `checked` is the `- [x]` box;
 *  `text` is forge content (attacker-controlled on public repos) the renderer MUST keep
 *  inert. */
export interface PlanItem {
  checked: boolean;
  text: string;
}

/** The agent's durable plan (§9), parsed from the MR description's GitHub-flavoured task
 *  list (#41). `done`/`total` are the checkbox tallies; `items` is the list in source order.
 *  Absent on an issue with no MR or no checkboxes in its description. */
export interface PlanProgress {
  done: number;
  total: number;
  items: PlanItem[];
}

/** The MR review posture (#41): the dashboard drill-down distinguishes draft / changes
 *  requested / approved / open. `changesRequested` rides alongside the existing draft and
 *  approved flags so the panel can read all three without a second derivation. */
export interface IssueView {
  iid: number;
  title: string;
  state: LifecycleState;
  issueUrl: string; // canonical forge URL — adapter-supplied, never synthesized (#35)
  mrUrl?: string;
  isDraft?: boolean;
  approved?: boolean;
  changesRequested?: boolean; // an open "changes requested" review on the MR (#41)
  lastLog?: string;
  author: ForgeUser; // the issue reporter (#37)
  reviewer?: ForgeUser; // MR assignee — the ticket creator assigned at handoff; absent before (#37)
  lastActivity?: LastActivity; // newest of issue/MR/agent movement, when any is known (#39)
  // --- drill-down detail (#41): populated ONLY by assembleIssue, never by the dashboard
  // list assembly, so the collapsed board payload stays as small as before. ---
  plan?: PlanProgress; // parsed checkbox plan off the MR description, when an MR with boxes exists
  recentLogs?: LogLine[]; // last ~N daemon log lines (oldest-first), newest at the end
  recentComments?: Comment[]; // newest issue comments (newest-first, as the snapshot supplies)
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

/** How many daemon log lines the drill-down detail (#41) surfaces — the issue asks for
 *  "last ~10". The collapsed dashboard list never reads this; it takes only the newest line
 *  for the last-activity signal. */
const DETAIL_LOG_LINES = 10;

// A GitHub-flavoured task-list line: optional indent, a `-`/`*`/`+` bullet, then `[ ]`/`[x]`
// (case-insensitive) and the item text. The MR description is the agent's plan scratchpad
// (§9); this is the only structure we read out of it. Anchored to the start of a line.
const TASK_LINE = /^[ \t]*[-*+]\s+\[([ xX])\]\s+(.*)$/;

/**
 * Parse the GitHub-flavoured checkbox plan out of an MR description (#41). Returns the
 * done/total tallies plus the items in source order, or undefined when the description
 * carries no task-list lines at all (a bare "Closes #42" body → no plan to show). The item
 * text stays raw forge content — the renderer keeps it inert (§13.1), never this parser.
 */
export function parsePlan(description: string): PlanProgress | undefined {
  const items: PlanItem[] = [];
  for (const line of description.split('\n')) {
    const m = TASK_LINE.exec(line);
    if (!m) continue;
    items.push({ checked: m[1] !== ' ', text: (m[2] ?? '').trim() });
  }
  if (items.length === 0) return undefined;
  return { done: items.filter((i) => i.checked).length, total: items.length, items };
}

async function issueView(
  repo: RepoRef,
  iid: number,
  deps: AssembleDeps,
  detail = false,
): Promise<IssueView> {
  const adapter = deps.adapterFor(repo);
  const snapshot = await adapter.getSnapshot(repo, iid);
  const state = deriveState(snapshot, deps.settingsFor(repo));
  // The drill-down wants a window of recent lines (#41); the board only needs the newest one
  // for the activity signal. Read the bigger window once in detail mode and reuse its tail.
  const recentLogs = await deps.logs.readIssueLog(repo, iid, detail ? DETAIL_LOG_LINES : 1);
  const log = recentLogs.at(-1);
  const lastLog = log?.msg;
  const lastActivity = lastActivityOf(snapshot, log);
  const mr = snapshot.mr;
  // The reviewer is whoever the MR is assigned to — handoff assigns the ticket creator
  // (§7), so before handoff (or on a bare MR) there is simply no assignee to show.
  const reviewer = mr?.assignees[0];
  const plan = detail && mr ? parsePlan(mr.description) : undefined;
  return {
    iid,
    title: snapshot.issue.title,
    state,
    issueUrl: snapshot.issue.webUrl,
    author: snapshot.issue.author,
    ...(mr
      ? {
          mrUrl: mr.webUrl,
          isDraft: mr.isDraft,
          approved: mr.approvals.approved,
          changesRequested: mr.approvals.changesRequested,
        }
      : {}),
    ...(reviewer ? { reviewer } : {}),
    ...(lastLog ? { lastLog } : {}),
    ...(lastActivity ? { lastActivity } : {}),
    // Detail-only fields (#41): kept off the dashboard list payload so the collapsed board
    // stays as small as it was. The drill-down fetch is the only caller that asks for them.
    ...(detail ? { recentLogs, recentComments: snapshot.recentComments } : {}),
    ...(plan ? { plan } : {}),
  };
}

/** One issue's view, enriched for the per-issue drill-down (#41): the parsed checkbox plan,
 *  the recent daemon log window, and the newest issue comments — none of which ride the
 *  collapsed dashboard list. Also the CLI `status` source (the extra fields are optional). */
export function assembleIssue(repo: RepoRef, iid: number, deps: AssembleDeps): Promise<IssueView> {
  return issueView(repo, iid, deps, true);
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
