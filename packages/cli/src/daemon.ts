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
//    both claim the same assigned issue — the in-process Claims accounting does not
//    arbitrate across installs. One-repo-one-install by convention or distinct bots.
//  · Size `global_max` to host RAM (≈ (RAM_MB − 512) / per_worker_peak_MB; 4 GB → 1–2).
//    The daemon only honors the cap; it does not measure RAM. Ship the systemd unit
//    with `MemoryMax` + `Restart=always` as the last-line OOM backstop — a restart
//    loses nothing (state is the forge + disk, §3).
//  · Tokens: read `process.env[token_env]` at this edge to construct adapters; they ride
//    to subprocesses via the M2/M3 env/credential-helper seams only — never argv, never
//    a log line. This file must not log a resolved token.
//
// WORKFLOW.md SOURCE (§16, #5): each repo's WORKFLOW.md is fetched from its OWN default
// branch via WorkflowSource, with `<workflows_dir>/<slug>/WORKFLOW.md` as a write-through
// cache. Startup builds cells from that cache (instant, offline-tolerant); a background
// refresh then converges to the default-branch copy and re-derives a repo's settings when
// it changes — so once a bootstrap PR merges, the daemon picks up the real WORKFLOW.md on
// its own, with nobody hand-placing a local file.

import { readFileSync, watch } from 'node:fs';
import { join } from 'node:path';
import {
  type Exec,
  type ForgeAdapter,
  type MaestroConfig,
  NodeExec,
  type RepoRef,
  WorkspaceManager,
  checkBinaries,
  loadConfig,
  makeForgeAdapter,
  requiredBinaries,
} from '@maestro/core';
import {
  Claims,
  ClaudeRunner,
  type Clock,
  CodexRunner,
  ConfigStore,
  HeartbeatWriter,
  HerdrRunner,
  type Logger,
  ProofStreaks,
  RateLimitGate,
  type RepoUnit,
  type Rng,
  Scheduler,
  type StallInfo,
  type TickContext,
  WatchedConfig,
  WorkflowCells,
  WorkflowSource,
  handoff,
  proofAndComment,
  proofAndHandoff,
  selectAdapter,
  slugifyProject,
  tickDue,
} from '@maestro/core/runtime';

const log: Logger = {
  info: (m, meta) => console.log(JSON.stringify({ level: 'info', m, ...meta })),
  warn: (m, meta) => console.warn(JSON.stringify({ level: 'warn', m, ...meta })),
  error: (m, meta) => console.error(JSON.stringify({ level: 'error', m, ...meta })),
};

const systemClock: Clock = { now: () => Date.now() };
const systemRng: Rng = { next: () => Math.random() };

/** One forge adapter per unique (kind, host); selectAdapter() picks per repo. Built once
 *  at startup through core's forge wiring (makeForgeAdapter), which resolves the token
 *  env and the per-host bot_user (forge entry bot_user, else the global default). */
function buildAdapters(config: MaestroConfig, exec: Exec): ForgeAdapter[] {
  const out: ForgeAdapter[] = [];
  for (const forge of ['gitlab', 'github'] as const) {
    for (const entry of config.forges[forge] ?? []) {
      out.push(makeForgeAdapter({ forge, host: entry.host }, config, exec));
    }
  }
  return out;
}

/** Local WORKFLOW.md cache path: `<workflows_dir>/<repo-slug>/WORKFLOW.md`. The repo's
 *  default branch is authoritative (#5); this file is its write-through cache (WorkflowSource). */
function workflowPath(workflowsDir: string, repo: RepoRef): string {
  return join(workflowsDir, slugifyProject(repo.project), 'WORKFLOW.md');
}

/** The M0 template, base for a bootstrap-mode repo's workflow. Empty string if unreadable
 *  (→ bootstrap build fails for those repos and they skip, logged). */
function readTemplate(): string {
  const p = process.env.MAESTRO_TEMPLATE ?? './templates/WORKFLOW.md';
  try {
    return readFileSync(p, 'utf8');
  } catch {
    log.warn('template not readable — bootstrap mode unavailable', { path: p });
    return '';
  }
}

export interface DaemonOptions {
  configPath?: string;
  workflowsDir?: string;
  tickIntervalMs?: number;
  /** How often to re-fetch each repo's WORKFLOW.md from its default branch (default 60s). */
  workflowRefreshMs?: number;
  /** Where the heartbeat status file is written; the web side reads the same root (#40). */
  logsRoot?: string;
}

/** Wire core + I/O and run forever. Returns stop() for graceful shutdown. */
export function startDaemon(opts: DaemonOptions = {}): { stop: () => void } {
  const configPath = opts.configPath ?? process.env.MAESTRO_CONFIG ?? './maestro.config.yaml';
  const workflowsDir = opts.workflowsDir ?? process.env.MAESTRO_WORKFLOWS_DIR ?? './workspaces';
  // Same root the web dashboard reads (MAESTRO_LOGS_DIR, default ./logs) — the heartbeat
  // file lands there so the read-only web process shares one filesystem signal (#40).
  const logsRoot = opts.logsRoot ?? process.env.MAESTRO_LOGS_DIR ?? './logs';
  const tickIntervalMs = opts.tickIntervalMs ?? 1_000;

  const exec = new NodeExec();
  const config = loadConfig(configPath);

  const watched = new WatchedConfig(new ConfigStore(config), log);
  const adapters = buildAdapters(config, exec);
  // Resolve the git token from the repo's OWN forge entry — one daemon serves repos on
  // different forges (gh/glab) and hosts (#15, #33), each with its own token_env. Shared
  // by the clone path and the WORKFLOW.md fetch.
  const resolveTokenEnv = (repo: RepoRef): string => {
    const entry = config.forges[repo.forge]?.find((e) => e.host === repo.host);
    if (!entry) throw new Error(`no '${repo.forge}' forge configured for host '${repo.host}'`);
    return entry.token_env;
  };
  const workspace = new WorkspaceManager({
    root: config.defaults.workspaces.root,
    diskCap: config.defaults.workspaces.disk_cap,
    cloneFilter: config.defaults.workspaces.clone_filter, // partial clone (#27)
    exec,
    tokenEnv: resolveTokenEnv,
  });
  // Fetches each repo's WORKFLOW.md from its default branch; workflowsDir is the cache (#5).
  const source = new WorkflowSource({
    cacheDir: workflowsDir,
    exec,
    tokenEnv: resolveTokenEnv,
    log,
  });
  // Scrub the configured forge token(s) from the agent's env (§13.1): the agent acts
  // with the bot's credentials OUTSIDE the workspace, never finds the token INSIDE it.
  const secretEnvKeys = [
    ...(config.forges.gitlab ?? []).map((e) => e.token_env),
    ...(config.forges.github ?? []).map((e) => e.token_env),
  ];
  const agentSel = config.defaults.agent;
  const runnerCfg = {
    secretEnvKeys,
    // Surface stall kills (previously invisible) so a false-positive kill during a long
    // no-event tool call — e.g. a cold `pnpm install` — is diagnosable in the journal.
    onStall: ({ attempt, willRetry, timeoutMs }: StallInfo) =>
      log.warn('runner: stall watchdog fired — no agent output, killed', {
        attempt,
        willRetry,
        timeoutMs,
      }),
  };
  // `runner` (headless vs herdr) is orthogonal to `kind` (claude vs codex): herdr can
  // host either agent kind in a named, human-attachable tab (spec §8 amendment).
  const runner =
    agentSel.runner === 'herdr'
      ? new HerdrRunner(exec, {
          ...runnerCfg,
          kind: agentSel.kind,
          command: agentSel.herdr.command,
          workspaceLabel: agentSel.herdr.workspace_label,
          env: agentSel.herdr.env,
        })
      : agentSel.kind === 'codex'
        ? new CodexRunner(exec, runnerCfg)
        : new ClaudeRunner(exec, runnerCfg);
  if (agentSel.runner === 'herdr') {
    // Startup bulk sweep (correction #9): close any `m-*` tab left LIVE by a crash mid-run
    // on a prior daemon process — best-effort, never blocks boot.
    void (runner as HerdrRunner)
      .sweepOrphans()
      .catch((err) => log.warn('herdr: startup orphan sweep failed', { err: String(err) }));
  }
  const globalMax = config.defaults.concurrency.global_max;
  // Work admission (#91): per-issue uniqueness (#18) + slot capacity (§14) in one seam.
  const claims = new Claims(globalMax);
  const heartbeat = new HeartbeatWriter(logsRoot); // liveness signal for the web dashboard (#40)
  const rateGate = new RateLimitGate(); // global Claude usage-limit backoff (#47)
  const proofStreaks = new ProofStreaks(); // per-issue proof-failure streaks (#109)
  const scheduler = new Scheduler(
    {
      active: config.defaults.poll_interval_active,
      idle: config.defaults.poll_interval_idle,
      jitter: config.defaults.poll_jitter,
    },
    systemRng,
  );

  // The M0 template — base for the bootstrap workflow a no-WORKFLOW repo runs on.
  const templateText = readTemplate();

  // Per-repo settings cells (settings/promptBody/front matter re-derived live on reload),
  // owned by core's WorkflowCells (#107): validate-before-swap on refresh, and an invalid
  // WORKFLOW with no prior good cell SKIPS the repo with an error log — never a bootstrap
  // fallback over a file the user actually wrote.
  const cells = new WorkflowCells({ config, templateText, log });

  // Initial cells from the LOCAL CACHE (instant, offline-tolerant). A missing cache file →
  // bootstrap; the background refresh below then converges to the default-branch copy.
  for (const repo of watched.watchSet) {
    let cached: string | undefined;
    try {
      cached = readFileSync(workflowPath(workflowsDir, repo), 'utf8');
    } catch {
      cached = undefined;
    }
    cells.seed(repo, cached);
  }

  // Fetch a repo's WORKFLOW.md from its default branch and re-derive its cell ON CHANGE.
  // This is how the bootstrap→merge loop closes (#5): once the bootstrap PR lands, the next
  // refresh sees the real WORKFLOW.md and swaps the repo out of bootstrap mode by itself.
  const refreshFromRemote = async (repo: RepoRef): Promise<void> => {
    // load() serves cache on transient failure, never throws here
    cells.applyRemote(repo, await source.load(repo));
  };

  const refreshAll = async (): Promise<void> => {
    await Promise.all(
      watched.watchSet.map((repo) =>
        refreshFromRemote(repo).catch((err) =>
          log.warn('WORKFLOW refresh failed', { repo: repo.project, err: String(err) }),
        ),
      ),
    );
  };

  /** Fresh units each pass so live settings/promptBody/front matter take effect (§5). */
  const buildUnits = (): RepoUnit[] =>
    cells.entries().map(({ repo, cell }): RepoUnit => {
      const ctx: TickContext = {
        adapter: selectAdapter(repo, adapters),
        workspace,
        runner,
        handoff,
        proofAndHandoff,
        proofOnly: proofAndComment, // #29 P3 — review gate owns the handoff
        exec,
        settings: cell.settings,
        workflow: cell.frontMatter,
        agent: agentSel,
        promptBody: cell.promptBody,
        claims,
        rateGate,
        proofStreaks,
        log,
      };
      return { repo, ctx };
    });

  // One heartbeat write — current active-worker count, the cap, the cadence (#40). Written
  // every tick (even when a pass throws) so a stuck/failing daemon still ages out as stale
  // rather than freezing the last good timestamp. A write failure must never kill the loop.
  const beat = (): void =>
    safe(
      () =>
        heartbeat.write({
          lastTickAt: systemClock.now(),
          activeWorkers: claims.globalActive,
          maxWorkers: globalMax,
          tickIntervalMs,
        }),
      'heartbeat write',
    );

  let running = true;
  const timer = setInterval(() => {
    if (!running) return;
    void tickDue(buildUnits(), scheduler, systemClock)
      .catch((err) => log.error('daemon: tick pass failed', { err: String(err) }))
      .finally(beat);
  }, tickIntervalMs);
  beat(); // stamp once at boot so the dashboard sees the daemon immediately, not a tick later

  // Converge to the default-branch WORKFLOW.md: an immediate refresh (so the daemon doesn't
  // wait a full interval to leave a stale local cache behind) then a periodic poll. The poll
  // REPLACES a local-file watcher — with the repo as the source of truth, only a remote
  // change matters, and re-deriving lives in refreshFromRemote (§5 validate-before-swap).
  void refreshAll().catch((err) =>
    log.error('daemon: initial WORKFLOW refresh failed', { err: String(err) }),
  );
  const refreshTimer = setInterval(() => {
    if (!running) return;
    void refreshAll();
  }, opts.workflowRefreshMs ?? 60_000);

  // Hot-reload watcher (§5): re-validate config on change; invalid keeps the prior good value.
  const watchers = [
    watch(configPath, () =>
      safe(() => watched.reload(readFileSync(configPath, 'utf8')), 'config reload'),
    ),
  ];

  log.info('maestro daemon started', {
    repos: cells.size,
    globalMax: config.defaults.concurrency.global_max,
  });

  return {
    stop: () => {
      running = false;
      clearInterval(timer);
      clearInterval(refreshTimer);
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

/** Real CLI boot: preflight the external tools the daemon shells out to (`glab`/`gh`/
 *  `git`/`claude`, §8/§10) BEFORE looping. A missing binary otherwise hides as an
 *  endlessly-retried failing tick; here it's one clear error and a nonzero exit.
 *  startDaemon() stays sync (and preflight-free) so programmatic/test callers are
 *  unaffected — only this entry path gates on the check. Returns the exit code so both
 *  the `maestro daemon` subcommand (main.ts) and the `dist/daemon.js` alias share it. */
export async function bootDaemon(): Promise<number> {
  const configPath = process.env.MAESTRO_CONFIG ?? './maestro.config.yaml';
  let config: MaestroConfig;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    log.error('daemon: cannot start — config unreadable', { err: String(err) });
    return 1;
  }

  const preflight = await checkBinaries(new NodeExec(), requiredBinaries(config));
  if (!preflight.ok) {
    for (const m of preflight.missing) {
      log.error('daemon: required tool missing from PATH', { bin: m.bin, needed_to: m.reason });
    }
    log.error('daemon: not starting — install the missing tool(s) (try `maestro doctor`)', {
      missing: preflight.missing.map((m) => m.bin),
    });
    return 1;
  }

  startDaemon({ configPath });
  return 0;
}

// `dist/daemon.js` alias (§14 systemd target): when invoked directly, boot and map the
// resolved code onto the process. `maestro daemon` routes through main.ts → bootDaemon().
const entry = process.argv[1] ?? '';
if (entry.endsWith('daemon.js') || entry.endsWith('daemon.ts'))
  void bootDaemon().then((code) => {
    process.exitCode = code;
  });
