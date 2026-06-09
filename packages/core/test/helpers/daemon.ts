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
import { RateLimitGate } from '../../src/daemon/rate-limit-gate.js';
import { InFlightSet, SlotAccountant } from '../../src/daemon/slots.js';

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
  closes: { mrIid: number }[];
  issueComments: { iid: number; body: string }[];
  mrComments: { mrIid: number; body: string }[];
  mrDescriptions: { mrIid: number; body: string }[];
  branches: { name: string; fromRef: string }[];
  createdMRs: CreateMRArgs[];
  assigned: { mrIid: number; username: string }[];
}

export interface AdapterConfig {
  issues?: Issue[]; // listAssignedOpenIssues
  labeled?: Issue[]; // listOpenIssuesByLabel (#53)
  snapshot?: IssueSnapshot; // single-issue getSnapshot (default)
  snapshots?: Map<number, IssueSnapshot>; // per-iid getSnapshot
  issueStates?: Map<number, 'open' | 'closed' | 'missing'>; // getIssueState
  createdMR?: MergeRequest; // createDraftMR return
  mrs?: MergeRequest[]; // listAssignedOpenMergeRequests (command-MR pass)
  mrComments?: Map<number, Comment[]>; // getMrComments per mrIid
  mrStates?: Map<number, 'open' | 'closed' | 'merged' | 'missing'>; // getMergeRequestState
  fail?: Partial<Record<keyof ForgeAdapter, () => Error>>; // inject throws
}

/** Recording fake adapter. Pushes each method name to `calls`; captures key args. */
export function recordingAdapter(cfg: AdapterConfig = {}): AdapterRecorder {
  const r: AdapterRecorder = {
    calls: [],
    labelOps: [],
    merges: [],
    closes: [],
    issueComments: [],
    mrComments: [],
    mrDescriptions: [],
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
    host: 'gitlab.com',
    listAssignedOpenMergeRequests: async () => {
      r.calls.push('listAssignedOpenMergeRequests');
      maybeThrow('listAssignedOpenMergeRequests');
      return cfg.mrs ?? [];
    },
    getMrComments: async (_repo, mrIid) => {
      r.calls.push('getMrComments');
      maybeThrow('getMrComments');
      return cfg.mrComments?.get(mrIid) ?? [];
    },
    getMergeRequestState: async (_repo, mrIid) => {
      r.calls.push('getMergeRequestState');
      maybeThrow('getMergeRequestState');
      return cfg.mrStates?.get(mrIid) ?? 'open';
    },
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
    listOpenIssuesByLabel: async () => {
      r.calls.push('listOpenIssuesByLabel');
      return cfg.labeled ?? [];
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
    updateMRDescription: async (_repo, mrIid, body) => {
      r.calls.push('updateMRDescription');
      r.mrDescriptions.push({ mrIid, body });
    },
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
    closeMR: async (_repo, mrIid) => {
      r.calls.push('closeMR');
      maybeThrow('closeMR');
      r.closes.push({ mrIid });
    },
    setIssueLabels: async (_repo, iid, set, unset) => {
      r.calls.push('setIssueLabels');
      r.labelOps.push({ iid, set, unset });
    },
    commentIssue: async (_repo, iid, body) => {
      r.calls.push('commentIssue');
      r.issueComments.push({ iid, body });
    },
    commentMR: async (_repo, mrIid, body) => {
      r.calls.push('commentMR');
      r.mrComments.push({ mrIid, body });
    },
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
  mrDirs: { dir: string; iid: number }[];
  ensured: { iid: number; fromRef: string }[]; // records ensureWorkspace(repo, iid, fromRef)
  mrEnsured: { iid: number; fromRef: string }[]; // records ensureMrWorkspace(repo, iid, fromRef)
  pushed: { dir: string; branch: string }[]; // records pushBranch(handle, branch)
  seeded: { dir: string; branch: string }[]; // records seedBranch(handle, branch)
}

/** Fake workspace: configurable existing dirs; eviction removes from the list.
 *  `keep` lists dirs whose eviction is REFUSED (unpushed commits, #56). `unpushed` is the
 *  count `countUnpushedCommits` reports (the command-MR pass's "did the agent commit?"
 *  signal, spec §5); default 0 (no change). */
export function fakeWorkspace(
  opts: {
    exists?: number[];
    dirs?: { dir: string; iid: number }[];
    mrDirs?: { dir: string; iid: number }[];
    keep?: string[];
    unpushed?: number;
  } = {},
): WorkspaceFake {
  const dirs = opts.dirs ? [...opts.dirs] : [];
  const mrDirs = opts.mrDirs ? [...opts.mrDirs] : [];
  const exists = new Set(opts.exists ?? []);
  const keep = new Set(opts.keep ?? []);
  const unpushed = opts.unpushed ?? 0;
  const ws: WorkspaceFake = {
    evicted: [],
    dirs,
    mrDirs,
    ensured: [],
    mrEnsured: [],
    pushed: [],
    seeded: [],
    ensureWorkspace: async (r, iid, fromRef): Promise<WorkspaceHandleLike> => {
      ws.ensured.push({ iid, fromRef });
      return { dir: `/ws/${iid}`, repo: r, iid };
    },
    ensureMrWorkspace: async (r, iid, fromRef): Promise<WorkspaceHandleLike> => {
      ws.mrEnsured.push({ iid, fromRef });
      return { dir: `/ws/mr-${iid}`, repo: r, iid };
    },
    prepareBranch: async () => {},
    pushBranch: async (handle, branch) => void ws.pushed.push({ dir: handle.dir, branch }),
    seedBranch: async (handle, branch) => void ws.seeded.push({ dir: handle.dir, branch }),
    evict: async (dir: string) => {
      if (keep.has(dir)) return false; // refused: unpushed commits (#56)
      ws.evicted.push(dir);
      const i = ws.dirs.findIndex((d) => d.dir === dir);
      if (i !== -1) ws.dirs.splice(i, 1);
      const j = ws.mrDirs.findIndex((d) => d.dir === dir);
      if (j !== -1) ws.mrDirs.splice(j, 1);
      return true;
    },
    workspaceExists: (_r, iid) => exists.has(iid),
    listWorkspaces: () => [...ws.dirs],
    listMrWorkspaces: () => [...ws.mrDirs],
    countUnpushedCommits: async () => unpushed,
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
  proofOnlySpy: ReturnType<typeof vi.fn>;
  slots: SlotAccountant;
  inFlight: InFlightSet;
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
    inFlight?: InFlightSet;
    handoff?: ReturnType<typeof vi.fn>;
    proofAndHandoff?: ReturnType<typeof vi.fn>;
    proofOnly?: ReturnType<typeof vi.fn>;
    rateGate?: RateLimitGate;
    log?: TickContext['log'];
    promptBody?: string;
  } = {},
): BuiltContext {
  const settings = partial.settings ?? defaultSettings();
  const adapterRec = partial.adapter ?? recordingAdapter({ snapshot: makeSnapshot() });
  const runnerSpy = partial.runner ?? scriptedRunner({ status: 'in_progress', summary: '' });
  const ws = partial.workspace ?? fakeWorkspace();
  const slots = partial.slots ?? new SlotAccountant(settings.concurrency.globalMax);
  const inFlight = partial.inFlight ?? new InFlightSet();
  const handoffSpy = partial.handoff ?? vi.fn(async () => {});
  const proofHandoffSpy = partial.proofAndHandoff ?? vi.fn(async () => RECOVERED_PROOF);
  const proofOnlySpy = partial.proofOnly ?? vi.fn(async () => RECOVERED_PROOF);
  const ctx: TickContext = {
    adapter: adapterRec.adapter,
    workspace: ws,
    runner: runnerSpy.runner,
    handoff: handoffSpy,
    proofAndHandoff: proofHandoffSpy,
    proofOnly: proofOnlySpy,
    exec: { run: async () => ({ code: 0, stdout: '', stderr: '' }) } as never,
    settings,
    workflow: partial.workflow ?? defaultWorkflow(),
    promptBody: partial.promptBody ?? 'do the work',
    slots,
    inFlight,
    rateGate: partial.rateGate ?? new RateLimitGate(),
    log: partial.log ?? silentLogger(),
  };
  return {
    ctx,
    adapterRec,
    runnerSpy,
    ws,
    handoffSpy,
    proofHandoffSpy,
    proofOnlySpy,
    slots,
    inFlight,
  };
}
