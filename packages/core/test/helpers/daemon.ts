// Shared M5 daemon test harness: recording/scripted fakes for every TickContext
// port + a buildContext(partial) factory. Tests assert ORCHESTRATION (call order,
// counts, slot deltas, label sets) — never the internals of M1–M4 units.

import { vi } from 'vitest';
import { resolveRepoSettings } from '../../src/config/resolve-settings.js';
import type {
  AgentResult,
  Comment,
  CreateMRArgs,
  ForgeAdapter,
  Issue,
  IssueSnapshot,
  MergeRequest,
  ProofResult,
  RepoRef,
  RepoSettings,
  RunnerInput,
  WorkflowFrontMatter,
} from '../../src/contracts/index.js';
import { WorkflowSchema, labelNames } from '../../src/contracts/index.js';
import type { TickContext, Workspace, WorkspaceHandleLike } from '../../src/daemon/ports.js';
import { SlotAccountant } from '../../src/daemon/slots.js';

export const repo: RepoRef = {
  forge: 'gitlab',
  host: 'gitlab.com',
  project: 'group/api',
  url: 'gitlab.com/group/api',
};
export const labels = labelNames('gitlab');
export const user = (u: string) => ({ username: u, id: `id-${u}` });

export function makeIssue(over: Partial<Issue> = {}): Issue {
  return {
    iid: 42,
    id: '9042',
    title: 'Add OAuth',
    body: '',
    state: 'open',
    assignees: [user('maestro-bot')],
    labels: [],
    author: user('reporter'),
    webUrl: 'u',
    ...over,
  };
}

export function makeMR(over: Partial<MergeRequest> = {}): MergeRequest {
  return {
    iid: 7,
    id: '7',
    title: 'Draft: Add OAuth',
    description: 'Closes #42',
    state: 'opened',
    isDraft: true,
    sourceBranch: 'maestro/issue-42',
    targetBranch: 'main',
    assignees: [],
    labels: [],
    approvals: { approved: false, approvedBy: [], changesRequested: false },
    webUrl: 'u',
    ...over,
  };
}

export function makeSnapshot(
  over: {
    issue?: Partial<Issue>;
    mr?: Partial<MergeRequest> | null;
    comments?: string[];
  } = {},
): IssueSnapshot {
  return {
    repo,
    issue: makeIssue(over.issue),
    mr: over.mr === null ? undefined : makeMR(over.mr ?? {}),
    recentComments: (over.comments ?? []).map((body, i) => ({
      id: `c${i}`,
      author: user('reporter'),
      body,
      createdAt: '2026-06-04T00:00:00Z',
    })),
  };
}

export interface AdapterRecorder {
  adapter: ForgeAdapter;
  calls: string[];
  labelOps: { iid: number; set: string[]; unset: string[] }[];
  merges: { mrIid: number; strategy: string; deleteSource: boolean }[];
  issueComments: { iid: number; body: string }[];
  branches: { name: string; fromRef: string }[];
  createdMRs: CreateMRArgs[];
  assigned: { mrIid: number; username: string }[];
}

export interface AdapterConfig {
  issues?: Issue[]; // listAssignedOpenIssues
  snapshot?: IssueSnapshot; // single-issue getSnapshot (default)
  snapshots?: Map<number, IssueSnapshot>; // per-iid getSnapshot
  issueStates?: Map<number, 'open' | 'closed' | 'missing'>; // getIssueState
  createdMR?: MergeRequest; // createDraftMR return
  fail?: Partial<Record<keyof ForgeAdapter, () => Error>>; // inject throws
}

/** Recording fake adapter. Pushes each method name to `calls`; captures key args. */
export function recordingAdapter(cfg: AdapterConfig = {}): AdapterRecorder {
  const r: AdapterRecorder = {
    calls: [],
    labelOps: [],
    merges: [],
    issueComments: [],
    branches: [],
    createdMRs: [],
    assigned: [],
    adapter: undefined as unknown as ForgeAdapter,
  };
  const maybeThrow = (m: keyof ForgeAdapter) => {
    const f = cfg.fail?.[m];
    if (f) throw f();
  };
  const a: ForgeAdapter = {
    kind: 'gitlab',
    listAssignedOpenIssues: async () => {
      r.calls.push('listAssignedOpenIssues');
      maybeThrow('listAssignedOpenIssues');
      return cfg.issues ?? (cfg.snapshot ? [cfg.snapshot.issue] : []);
    },
    getSnapshot: async (_repo, iid) => {
      r.calls.push('getSnapshot');
      maybeThrow('getSnapshot');
      const s = cfg.snapshots?.get(iid) ?? cfg.snapshot;
      if (!s) throw new Error(`no snapshot configured for iid ${iid}`);
      return s;
    },
    getIssueState: async (_repo, iid) => {
      r.calls.push('getIssueState');
      maybeThrow('getIssueState');
      return cfg.issueStates?.get(iid) ?? 'open';
    },
    createBranch: async (_repo, name, fromRef) => {
      r.calls.push('createBranch');
      r.branches.push({ name, fromRef });
    },
    createDraftMR: async (_repo, args) => {
      r.calls.push('createDraftMR');
      r.createdMRs.push(args);
      return cfg.createdMR ?? makeMR({ sourceBranch: args.sourceBranch, title: args.title });
    },
    updateMRDescription: async () => void r.calls.push('updateMRDescription'),
    setDraft: async () => void r.calls.push('setDraft'),
    assignMR: async (_repo, mrIid, username) => {
      r.calls.push('assignMR');
      r.assigned.push({ mrIid, username });
    },
    mergeMR: async (_repo, mrIid, strategy, deleteSource) => {
      r.calls.push('mergeMR');
      maybeThrow('mergeMR');
      r.merges.push({ mrIid, strategy, deleteSource });
    },
    setIssueLabels: async (_repo, iid, set, unset) => {
      r.calls.push('setIssueLabels');
      r.labelOps.push({ iid, set, unset });
    },
    commentIssue: async (_repo, iid, body) => {
      r.calls.push('commentIssue');
      r.issueComments.push({ iid, body });
    },
    commentMR: async () => void r.calls.push('commentMR'),
    ensureLabels: async () => void r.calls.push('ensureLabels'),
    createIssue: async () => {
      r.calls.push('createIssue');
      return makeIssue();
    },
  };
  r.adapter = a;
  return r;
}

export interface RunnerSpy {
  runner: { run: (i: RunnerInput) => Promise<AgentResult> };
  inputs: RunnerInput[];
}

/** Scripted runner: returns the given result(s) in order; records each RunnerInput. */
export function scriptedRunner(results: AgentResult | AgentResult[]): RunnerSpy {
  const queue = Array.isArray(results) ? [...results] : null;
  const single = Array.isArray(results) ? null : results;
  const spy: RunnerSpy = {
    inputs: [],
    runner: { run: async () => ({ status: 'in_progress', summary: '' }) },
  };
  spy.runner.run = async (input: RunnerInput) => {
    spy.inputs.push(input);
    if (single) return single;
    const next = queue?.shift();
    if (!next) throw new Error('scriptedRunner: ran out of results');
    return next;
  };
  return spy;
}

export interface WorkspaceFake extends Workspace {
  evicted: string[];
  dirs: { dir: string; iid: number }[];
  ensured: { iid: number; fromRef: string }[]; // records ensureWorkspace(repo, iid, fromRef)
  pushed: { dir: string; branch: string }[]; // records pushBranch(handle, branch)
}

/** Fake workspace: configurable existing dirs; eviction removes from the list. */
export function fakeWorkspace(
  opts: { exists?: number[]; dirs?: { dir: string; iid: number }[] } = {},
): WorkspaceFake {
  const dirs = opts.dirs ? [...opts.dirs] : [];
  const exists = new Set(opts.exists ?? []);
  const ws: WorkspaceFake = {
    evicted: [],
    dirs,
    ensured: [],
    pushed: [],
    ensureWorkspace: async (r, iid, fromRef): Promise<WorkspaceHandleLike> => {
      ws.ensured.push({ iid, fromRef });
      return { dir: `/ws/${iid}`, repo: r, iid };
    },
    prepareBranch: async () => {},
    pushBranch: async (handle, branch) => void ws.pushed.push({ dir: handle.dir, branch }),
    evict: async (dir: string) => {
      ws.evicted.push(dir);
      const i = ws.dirs.findIndex((d) => d.dir === dir);
      if (i !== -1) ws.dirs.splice(i, 1);
    },
    workspaceExists: (_r, iid) => exists.has(iid),
    listWorkspaces: () => [...ws.dirs],
  };
  return ws;
}

export function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

export function defaultWorkflow(
  over: Partial<Parameters<typeof WorkflowSchema.parse>[0]> = {},
): WorkflowFrontMatter {
  return WorkflowSchema.parse({
    project: 'group/api',
    bot_user: 'maestro-bot',
    proof: { type: 'diff-summary' },
    git: {},
    ...over,
  });
}

export function defaultSettings(over: Partial<RepoSettings> = {}): RepoSettings {
  const base = resolveRepoSettings({
    repo,
    workflow: defaultWorkflow(),
    defaults: {
      bot_user: 'maestro-bot',
      poll_interval_active: 30_000,
      poll_interval_idle: 300_000,
      poll_jitter: 5_000,
      concurrency: { global_max: 2 },
      workspaces: { root: './workspaces', disk_cap: 1, cleanup: 'lru' },
    } as never,
  });
  return { ...base, ...over };
}

export interface BuiltContext {
  ctx: TickContext;
  adapterRec: AdapterRecorder;
  runnerSpy: RunnerSpy;
  ws: WorkspaceFake;
  handoffSpy: ReturnType<typeof vi.fn>;
  proofHandoffSpy: ReturnType<typeof vi.fn>;
  slots: SlotAccountant;
}

const RECOVERED_PROOF: ProofResult = { ok: true, kind: 'none', summary: 'recovered' };

/** Build a valid default TickContext; override any port via `partial`. */
export function buildContext(
  partial: {
    adapter?: AdapterRecorder;
    runner?: RunnerSpy;
    workspace?: WorkspaceFake;
    settings?: RepoSettings;
    workflow?: WorkflowFrontMatter;
    slots?: SlotAccountant;
    handoff?: ReturnType<typeof vi.fn>;
    proofAndHandoff?: ReturnType<typeof vi.fn>;
  } = {},
): BuiltContext {
  const settings = partial.settings ?? defaultSettings();
  const adapterRec = partial.adapter ?? recordingAdapter({ snapshot: makeSnapshot() });
  const runnerSpy = partial.runner ?? scriptedRunner({ status: 'in_progress', summary: '' });
  const ws = partial.workspace ?? fakeWorkspace();
  const slots = partial.slots ?? new SlotAccountant(settings.concurrency.globalMax);
  const handoffSpy = partial.handoff ?? vi.fn(async () => {});
  const proofHandoffSpy = partial.proofAndHandoff ?? vi.fn(async () => RECOVERED_PROOF);
  const ctx: TickContext = {
    adapter: adapterRec.adapter,
    workspace: ws,
    runner: runnerSpy.runner,
    handoff: handoffSpy,
    proofAndHandoff: proofHandoffSpy,
    exec: { run: async () => ({ code: 0, stdout: '', stderr: '' }) } as never,
    settings,
    workflow: partial.workflow ?? defaultWorkflow(),
    promptBody: 'do the work',
    slots,
    log: silentLogger(),
  };
  return { ctx, adapterRec, runnerSpy, ws, handoffSpy, proofHandoffSpy, slots };
}
