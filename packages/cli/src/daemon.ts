// Daemon entrypoint (spec §14, plan M5). THIN composition root over @maestro/core: it
// supplies the real-I/O implementations the pure orchestrator delegates to — the forge
// adapter (per repo.forge), the workspace manager, the Claude runner, the M4 proof+
// handoff units, a system clock, a `Math.random` RNG, and the run-forever interval —
// then loops `tickDue`. ALL orchestration logic lives in core and is unit-tested
// headless; this file holds ZERO business logic (the §14 invariant the exit gate pins).
//
// OPS GUARDS (§14, ENFORCED BY DEPLOYMENT, not code — no cross-install coordination in
// v1, §17):
//  · Run exactly ONE daemon per (repo, bot_user). Two daemons sharing a repo+bot can
//    both claim the same assigned issue — the in-process SlotAccountant does not
//    arbitrate across installs. One-repo-one-install by convention or distinct bots.
//  · Size `global_max` to host RAM (≈ (RAM_MB − 512) / per_worker_peak_MB; 4 GB → 1–2).
//    The daemon only honors the cap; it does not measure RAM. Ship the systemd unit
//    with `MemoryMax` + `Restart=always` as the last-line OOM backstop — a restart
//    loses nothing (state is the forge + disk, §3).
//  · Tokens: read `process.env[token_env]` at this edge to construct adapters; they ride
//    to subprocesses via the M2/M3 env/credential-helper seams only — never argv, never
//    a log line. This file must not log a resolved token.
//
// SEAM (finalized in M8 bootstrap, §16): where each repo's WORKFLOW.md text comes from.
// v1 default reads it from a local dir; M8's `maestro add` formalizes the repo-hosted
// fetch. It is injected (`loadWorkflowText`) so nothing else changes when M8 lands.

import { readFileSync, watch } from 'node:fs';
import { join } from 'node:path';
import {
  ClaudeRunner,
  type Clock,
  ConfigStore,
  type Exec,
  type ForgeAdapter,
  GithubAdapter,
  GitlabAdapter,
  type Logger,
  type MaestroConfig,
  NodeExec,
  type RepoRef,
  RepoSettingsCell,
  type RepoUnit,
  type Rng,
  Scheduler,
  SlotAccountant,
  type TickContext,
  WatchedConfig,
  WorkflowStore,
  WorkspaceManager,
  handoff,
  inferForge,
  parseConfig,
  parseWorkflow,
  proofAndHandoff,
  selectAdapter,
  slugifyProject,
  tickDue,
} from '@maestro/core';

const log: Logger = {
  info: (m, meta) => console.log(JSON.stringify({ level: 'info', m, ...meta })),
  warn: (m, meta) => console.warn(JSON.stringify({ level: 'warn', m, ...meta })),
  error: (m, meta) => console.error(JSON.stringify({ level: 'error', m, ...meta })),
};

const systemClock: Clock = { now: () => Date.now() };
const systemRng: Rng = { next: () => Math.random() };

/** One forge adapter per configured forge; selectAdapter() picks per repo.forge. */
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

/** v1 WORKFLOW source: `<workflows_dir>/<repo-slug>/WORKFLOW.md` (M8 formalizes fetch). */
function workflowPath(workflowsDir: string, repo: RepoRef): string {
  return join(workflowsDir, slugifyProject(repo.project), 'WORKFLOW.md');
}

export interface DaemonOptions {
  configPath?: string;
  workflowsDir?: string;
  tickIntervalMs?: number;
}

/** Wire core + I/O and run forever. Returns stop() for graceful shutdown. */
export function startDaemon(opts: DaemonOptions = {}): { stop: () => void } {
  const configPath = opts.configPath ?? process.env.MAESTRO_CONFIG ?? './maestro.config.yaml';
  const workflowsDir = opts.workflowsDir ?? process.env.MAESTRO_WORKFLOWS_DIR ?? './workspaces';

  const exec = new NodeExec();
  const parsed = parseConfig(readFileSync(configPath, 'utf8'));
  if (!parsed.ok) throw new Error(`config invalid: ${parsed.error}`);
  const config = parsed.value;

  const watched = new WatchedConfig(new ConfigStore(config), log);
  const adapters = buildAdapters(config, exec);
  const workspace = new WorkspaceManager({
    root: config.defaults.workspaces.root,
    diskCap: config.defaults.workspaces.disk_cap,
    exec,
    tokenEnv: config.forges.gitlab?.token_env ?? 'MAESTRO_GITLAB_TOKEN',
  });
  const runner = new ClaudeRunner(exec);
  const slots = new SlotAccountant(config.defaults.concurrency.global_max);
  const scheduler = new Scheduler(
    {
      active: config.defaults.poll_interval_active,
      idle: config.defaults.poll_interval_idle,
      jitter: config.defaults.poll_jitter,
    },
    systemRng,
  );

  // Per-repo settings cell (settings/promptBody/front matter re-derived live on reload).
  const cells = new Map<string, { repo: RepoRef; cell: RepoSettingsCell }>();
  for (const repo of watched.watchSet) {
    const wf = parseWorkflow(readFileSync(workflowPath(workflowsDir, repo), 'utf8'), repo.host);
    if (!wf.ok) {
      log.error('skipping repo: WORKFLOW invalid', { repo: repo.project, error: wf.error });
      continue;
    }
    const override = config.repos.find((r) => r.url === repo.url)?.overrides;
    const cell = new RepoSettingsCell({
      repo,
      store: new WorkflowStore(wf.value, repo.host),
      defaults: config.defaults,
      ...(override ? { override } : {}),
      log,
    });
    cells.set(repo.url, { repo, cell });
  }

  /** Fresh units each pass so live settings/promptBody/front matter take effect (§5). */
  const buildUnits = (): RepoUnit[] =>
    [...cells.values()].map(({ repo, cell }): RepoUnit => {
      const ctx: TickContext = {
        adapter: selectAdapter(repo, adapters),
        workspace,
        runner,
        handoff,
        proofAndHandoff,
        exec,
        settings: cell.settings,
        workflow: cell.frontMatter,
        promptBody: cell.promptBody,
        slots,
        log,
      };
      return { repo, ctx };
    });

  let running = true;
  const timer = setInterval(() => {
    if (!running) return;
    void tickDue(buildUnits(), scheduler, systemClock).catch((err) =>
      log.error('daemon: tick pass failed', { err: String(err) }),
    );
  }, opts.tickIntervalMs ?? 1_000);

  // Hot-reload watchers (§5): re-validate on change; invalid keeps the prior good value.
  const watchers = [
    watch(configPath, () =>
      safe(() => watched.reload(readFileSync(configPath, 'utf8')), 'config reload'),
    ),
  ];
  for (const { repo, cell } of cells.values()) {
    try {
      const p = workflowPath(workflowsDir, repo);
      watchers.push(
        watch(p, () => safe(() => cell.reload(readFileSync(p, 'utf8')), 'WORKFLOW reload')),
      );
    } catch {
      // best-effort: the WORKFLOW file may not be locally present in v1.
    }
  }

  log.info('maestro daemon started', {
    repos: cells.size,
    globalMax: config.defaults.concurrency.global_max,
  });

  return {
    stop: () => {
      running = false;
      clearInterval(timer);
      for (const w of watchers) w.close();
    },
  };
}

function safe(fn: () => void, what: string): void {
  try {
    fn();
  } catch (err) {
    log.error(`daemon: ${what} failed`, { err: String(err) });
  }
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('daemon.js') || entry.endsWith('daemon.ts')) startDaemon();
