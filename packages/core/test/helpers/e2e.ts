// Live E2E harness (spec §15). Assembles a REAL TickContext from a maestro config +
// workflows dir — the SAME wiring `cli/src/daemon.ts:startDaemon` uses — and drives
// BOUNDED ticks against a live forge, polling the snapshot between them so the gated
// suite can assert each lifecycle edge. Plus a reviewer-side ForgeCli (a SECOND GitLab
// token, since GitLab forbids self-approval) so the human-gated edges — approve and
// changes-requested — can be driven programmatically, or polled-for when a human acts.
//
// Lives in test/ (never src/), imported ONLY by the MAESTRO_E2E=1 gated suites: the
// hermetic default `pnpm test` path never loads it, so it ships zero production code.
// Mirrors the M2 adapter integration tier — real I/O, opt-in, skipped by default.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger, TickContext } from '../../src/daemon/ports.js';
import {
  Claims,
  ClaudeRunner,
  ForgeCli,
  GithubAdapter,
  GitlabAdapter,
  NodeExec,
  RepoSettingsCell,
  WorkflowStore,
  WorkspaceManager,
  buildBootstrapWorkflow,
  deriveState,
  deriveWatchSet,
  encodeProject,
  handoff,
  parseConfig,
  parseWorkflow,
  proofAndHandoff,
  selectAdapter,
  slugifyProject,
  tickRepo,
} from '../../src/index.js';
import type {
  Exec,
  ForgeAdapter,
  IssueSnapshot,
  LifecycleState,
  MaestroConfig,
  RepoRef,
  RepoSettings,
  WorkflowParseResult,
} from '../../src/index.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Console logger — the E2E is a hand-run runbook; its progress is the point. */
export const e2eLog: Logger = {
  info: (m, meta) => console.log(JSON.stringify({ level: 'info', m, ...meta })),
  warn: (m, meta) => console.warn(JSON.stringify({ level: 'warn', m, ...meta })),
  error: (m, meta) => console.error(JSON.stringify({ level: 'error', m, ...meta })),
};

/** The four env vars the gated suite requires; throws (inside an `it`, never at
 *  describe-body level) with a precise message when one is missing. */
export interface E2EEnv {
  configPath: string;
  workflowsDir: string;
  pollMs: number;
  maxTicks: number;
}

export function readE2EEnv(): E2EEnv {
  const configPath = process.env.MAESTRO_E2E_CONFIG;
  const workflowsDir = process.env.MAESTRO_WORKFLOWS_DIR;
  if (!configPath) throw new Error('MAESTRO_E2E_CONFIG (path to maestro.config.yaml) is required');
  if (!workflowsDir) throw new Error('MAESTRO_WORKFLOWS_DIR (workflows root) is required');
  return {
    configPath,
    workflowsDir,
    pollMs: Number(process.env.MAESTRO_E2E_POLL_MS ?? '3000'),
    maxTicks: Number(process.env.MAESTRO_E2E_MAX_TICKS ?? '60'),
  };
}

/** One forge adapter per configured forge — a verbatim mirror of startDaemon's. */
function buildAdapters(config: MaestroConfig, exec: Exec): ForgeAdapter[] {
  const out: ForgeAdapter[] = [];
  const botUser = config.defaults.bot_user;
  if (config.forges.gitlab) {
    const { host, token_env } = config.forges.gitlab;
    out.push(new GitlabAdapter(exec, { token: process.env[token_env] ?? '', host, botUser }));
  }
  if (config.forges.github) {
    const { host, token_env } = config.forges.github;
    out.push(new GithubAdapter(exec, { token: process.env[token_env] ?? '', host, botUser }));
  }
  return out;
}

export interface E2EHarness {
  repo: RepoRef;
  adapter: ForgeAdapter;
  settings: RepoSettings;
  config: MaestroConfig;
  /** Lifecycle states observed at the TOP of each poll, in order (consecutive duplicates
   *  collapsed). A coarse trace: a New issue's in-progress→handoff happens INSIDE one
   *  awaited tick, so the transient in-progress label is not observable here — the loop's
   *  real proof is the changesRequested true→false transition (it can only clear via a
   *  fresh bot push), which the test asserts directly. */
  observed: LifecycleState[];
  /** Run ONE bounded daemon tick over this repo (lifecycle pass + cleanup sweep). */
  tick(): Promise<void>;
  snapshot(issueIid: number): Promise<IssueSnapshot>;
  /** Tick + poll until `pred(snapshot)` holds, recording the trace; throws on timeout.
   *  Use to make the DAEMON act (start-new, handoff, apply-changes, merge, cleanup). */
  driveUntil(
    issueIid: number,
    label: string,
    pred: (s: IssueSnapshot) => boolean,
  ): Promise<IssueSnapshot>;
  /** Poll until `pred(snapshot)` holds WITHOUT ticking — for signals an external actor
   *  produces (a reviewer approving / opening a thread). Ticking here could consume the
   *  edge before it's observed, so waiting is passive. Throws on timeout. */
  pollUntil(
    issueIid: number,
    label: string,
    pred: (s: IssueSnapshot) => boolean,
  ): Promise<IssueSnapshot>;
}

/**
 * Build a real, bounded-tick harness over the FIRST configured repo. Unlike startDaemon
 * (run-forever setInterval), this exposes a single tick + a poll-until helper so a test
 * can assert between ticks. Settings/workflow are resolved once (no hot-reload in a test);
 * claims/workspace persist across ticks as the daemon's singletons do.
 */
export function buildHarness(): E2EHarness {
  const { configPath, workflowsDir, pollMs, maxTicks } = readE2EEnv();
  const exec = new NodeExec();

  const parsed = parseConfig(readFileSync(configPath, 'utf8'));
  if (!parsed.ok) throw new Error(`config invalid: ${parsed.error}`);
  const config = parsed.value;

  const repo = deriveWatchSet(config)[0];
  if (!repo) throw new Error('config has no repos to drive');

  const adapter = selectAdapter(repo, buildAdapters(config, exec));

  const workspace = new WorkspaceManager({
    root: config.defaults.workspaces.root,
    diskCap: config.defaults.workspaces.disk_cap,
    exec,
    tokenEnv: (r) => {
      const env = config.forges[r.forge]?.token_env;
      if (!env) throw new Error(`no '${r.forge}' forge configured for ${r.project}`);
      return env;
    },
  });

  const secretEnvKeys = [config.forges.gitlab?.token_env, config.forges.github?.token_env].filter(
    (k): k is string => typeof k === 'string',
  );
  const runner = new ClaudeRunner(exec, { secretEnvKeys });
  const claims = new Claims(config.defaults.concurrency.global_max);

  // Resolve the repo's WORKFLOW from <workflowsDir>/<slug>/WORKFLOW.md, else bootstrap.
  let workflowText: string | undefined;
  try {
    workflowText = readFileSync(
      join(workflowsDir, slugifyProject(repo.project), 'WORKFLOW.md'),
      'utf8',
    );
  } catch {
    workflowText = undefined;
  }
  const parsedWf: WorkflowParseResult =
    workflowText !== undefined
      ? parseWorkflow(workflowText, repo.host)
      : buildBootstrapWorkflow(repo, '', config.defaults.bot_user);
  if (!parsedWf.ok) throw new Error(`WORKFLOW invalid: ${parsedWf.error}`);

  const override = config.repos.find((r) => r.url === repo.url)?.overrides;
  const cell = new RepoSettingsCell({
    repo,
    store: new WorkflowStore(parsedWf.value, repo.host),
    defaults: config.defaults,
    ...(override ? { override } : {}),
    log: e2eLog,
  });

  const ctx: TickContext = {
    adapter,
    workspace,
    runner,
    handoff,
    proofAndHandoff,
    exec,
    settings: cell.settings,
    workflow: cell.frontMatter,
    promptBody: cell.promptBody,
    claims,
    log: e2eLog,
  };

  const observed: LifecycleState[] = [];
  const record = (s: IssueSnapshot) => {
    const state = deriveState(s, cell.settings);
    if (observed[observed.length - 1] !== state) observed.push(state);
    return state;
  };

  return {
    repo,
    adapter,
    settings: cell.settings,
    config,
    observed,
    tick: () => tickRepo(repo, ctx).then(() => {}),
    snapshot: (iid) => adapter.getSnapshot(repo, iid),
    driveUntil: async (iid, label, pred) => {
      for (let i = 0; i < maxTicks; i++) {
        const s = await adapter.getSnapshot(repo, iid);
        const state = record(s);
        if (pred(s)) return s;
        e2eLog.info(`e2e: driving "${label}"`, { iid, state, tick: `${i + 1}/${maxTicks}` });
        await tickRepo(repo, ctx);
        await sleep(pollMs);
      }
      throw new Error(`e2e: "${label}" not reached for issue ${iid} within ${maxTicks} ticks`);
    },
    pollUntil: async (iid, label, pred) => {
      for (let i = 0; i < maxTicks; i++) {
        const s = await adapter.getSnapshot(repo, iid);
        record(s);
        if (pred(s)) return s;
        e2eLog.info(`e2e: waiting "${label}"`, { iid, poll: `${i + 1}/${maxTicks}` });
        await sleep(pollMs);
      }
      throw new Error(`e2e: "${label}" not observed for issue ${iid} within ${maxTicks} polls`);
    },
  };
}

/** The issue under test: a prepared, bot-assigned New issue. Explicit iid (deterministic,
 *  what the runbook prepares) or auto-discover the first assigned issue with no maestro
 *  label still on it. */
export async function resolveIssueIid(h: E2EHarness): Promise<number> {
  const explicit = Number(process.env.MAESTRO_E2E_ISSUE ?? '0');
  if (explicit > 0) return explicit;
  const open = await h.adapter.listAssignedOpenIssues(h.repo);
  const ml = h.settings.labels;
  const fresh = open.find(
    (i) =>
      !i.labels.includes(ml.inProgress) &&
      !i.labels.includes(ml.inReview) &&
      !i.labels.includes(ml.blocked),
  );
  if (!fresh)
    throw new Error('no New (unlabelled) bot-assigned issue found; set MAESTRO_E2E_ISSUE');
  return fresh.iid;
}

/** The reviewer side of the loop. Approve and request-changes are the two human edges
 *  the bot itself cannot drive (it authors the MR; GitLab forbids self-approval), so they
 *  run under a SECOND account's token. When MAESTRO_E2E_REVIEWER_TOKEN is unset, the
 *  caller falls back to polling for a human performing the same action by hand. */
export interface Reviewer {
  approve(mrIid: number): Promise<void>;
  /** Open an unresolved, non-bot discussion — the §0.3 blocking thread that drives the
   *  changes-requested edge (newest blocking thread post-dating the last bot push). */
  requestChanges(mrIid: number, body: string): Promise<void>;
}

/** True when a reviewer token is present, i.e. the human edges can run unattended. */
export function reviewerEnabled(): boolean {
  return !!process.env.MAESTRO_E2E_REVIEWER_TOKEN;
}

export function gitlabReviewer(repo: RepoRef, exec: Exec = new NodeExec()): Reviewer {
  const token = process.env.MAESTRO_E2E_REVIEWER_TOKEN;
  if (!token)
    throw new Error('MAESTRO_E2E_REVIEWER_TOKEN required to drive the reviewer edges unattended');
  const cli = new ForgeCli(exec, {
    bin: 'glab',
    forge: 'gitlab',
    env: { GITLAB_TOKEN: token, GITLAB_HOST: repo.host },
    botUser: process.env.MAESTRO_E2E_REVIEWER_USER ?? 'reviewer',
  });
  const pid = encodeProject(repo.project);
  return {
    approve: async (mrIid) => {
      await cli.apiRequired('POST', `/projects/${pid}/merge_requests/${mrIid}/approve`);
    },
    requestChanges: async (mrIid, body) => {
      await cli.apiRequired('POST', `/projects/${pid}/merge_requests/${mrIid}/discussions`, {
        body: { body },
      });
    },
  };
}
