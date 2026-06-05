// Web composition root (M6 Part F). The production entrypoint deps.ts was written for:
// read config + per-repo WORKFLOWs, wire the read-only assembly seam + the shared addRepo,
// and bind a port. Mirrors cli/daemon.ts — ZERO business logic; every call delegates to
// @maestro/core. Tokens are read from `process.env[token_env]` only to construct adapters
// and never logged. Run via `node packages/web/dist/main.js` (or the `web` setup step).

import { readFileSync } from 'node:fs';
import {
  type AddRepoDeps,
  type AssembleDeps,
  type Exec,
  FileLogReader,
  type ForgeAdapter,
  GithubAdapter,
  GitlabAdapter,
  type MaestroConfig,
  NodeExec,
  type ReadOnlyForgeAdapter,
  type RepoRef,
  type RepoSettings,
  botUserForHost,
  buildBootstrapWorkflow,
  deriveWatchSet,
  parseConfig,
  parseWorkflow,
  readHeartbeat,
  resolveRepoSettings,
  slugifyProject,
} from '@maestro/core';
import { buildServerDeps } from './deps.js';
import { createServer } from './server.js';

interface Env {
  configPath: string;
  workflowsDir: string;
  logsRoot: string;
  host: string;
  port: number;
  /** Bearer token gating POST /repos. Unset → the dashboard is read-only (no write path). */
  writeToken?: string;
}

function readEnv(): Env {
  // A blank/whitespace token must not silently enable writes with an empty secret.
  const token = process.env.MAESTRO_DASHBOARD_TOKEN?.trim();
  return {
    configPath: process.env.MAESTRO_CONFIG ?? './maestro.config.yaml',
    workflowsDir: process.env.MAESTRO_WORKFLOWS_DIR ?? './workspaces',
    logsRoot: process.env.MAESTRO_LOGS_DIR ?? './logs',
    host: process.env.MAESTRO_WEB_HOST ?? '127.0.0.1',
    port: Number(process.env.MAESTRO_WEB_PORT ?? '4000'),
    ...(token ? { writeToken: token } : {}),
  };
}

function loadConfig(configPath: string): MaestroConfig {
  const parsed = parseConfig(readFileSync(configPath, 'utf8'));
  if (!parsed.ok) throw new Error(`config invalid: ${parsed.error}`);
  return parsed.value;
}

/** The M0 template — base for a bootstrap-mode repo's stand-in workflow (mirrors the
 *  daemon's readTemplate). Empty string if unreadable; the parse error then surfaces. */
function readTemplate(): string {
  try {
    return readFileSync(process.env.MAESTRO_TEMPLATE ?? './templates/WORKFLOW.md', 'utf8');
  } catch {
    return '';
  }
}

/** The one forge-aware seam — construct the concrete adapter for a repo's forge+host.
 *  botUser resolves per host (forge entry bot_user, else the global default). */
function makeAdapter(repo: RepoRef, config: MaestroConfig, exec: Exec): ForgeAdapter {
  const botUser = botUserForHost(repo.host, config);
  if (repo.forge === 'gitlab') {
    const entry = config.forges.gitlab?.find((e) => e.host === repo.host);
    if (!entry) throw new Error(`no gitlab forge configured for host '${repo.host}'`);
    return new GitlabAdapter(exec, {
      token: process.env[entry.token_env] ?? '',
      host: entry.host,
      botUser,
    });
  }
  const entry = config.forges.github?.find((e) => e.host === repo.host);
  if (!entry) throw new Error(`no github forge configured for host '${repo.host}'`);
  return new GithubAdapter(exec, {
    token: process.env[entry.token_env] ?? '',
    host: entry.host,
    botUser,
  });
}

/** Build everything createServer needs: read-only assembly deps + the write (addRepo) deps. */
function buildDeps(env: Env) {
  const exec = new NodeExec();
  const config = loadConfig(env.configPath);
  const repos = deriveWatchSet(config);

  // Cache per (forge, host) — two hosts of the same forge carry different tokens/bots.
  const adapters = new Map<string, ReadOnlyForgeAdapter>();
  const adapterFor = (repo: RepoRef): ReadOnlyForgeAdapter => {
    const key = `${repo.forge}:${repo.host}`;
    let a = adapters.get(key);
    if (!a) {
      a = makeAdapter(repo, config, exec);
      adapters.set(key, a);
    }
    return a;
  };

  const settingsFor = (repo: RepoRef): RepoSettings => {
    // The workflow cache only exists once the repo has a committed WORKFLOW.md; a missing
    // file means BOOTSTRAP mode (the daemon's deriveCell does the same dance), so the
    // dashboard must fall back to the template instead of reporting the repo unreachable.
    const path = `${env.workflowsDir}/${slugifyProject(repo.project)}/WORKFLOW.md`;
    let text: string | undefined;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      // no cache yet → bootstrap fallback below
    }
    const wf =
      text !== undefined
        ? parseWorkflow(text, repo.host)
        : buildBootstrapWorkflow(repo, readTemplate(), botUserForHost(repo.host, config));
    if (!wf.ok) throw new Error(`WORKFLOW invalid for ${repo.project}: ${wf.error}`);
    const override = config.repos.find((r) => r.url === repo.url)?.overrides;
    return resolveRepoSettings({
      repo,
      workflow: wf.value.frontMatter,
      defaults: config.defaults,
      ...(override ? { override } : {}),
    });
  };

  const assemble: AssembleDeps = {
    adapterFor,
    settingsFor,
    logs: new FileLogReader(env.logsRoot),
    // Liveness from the SAME logs root the daemon writes its heartbeat to (#40). Read per
    // assembly (a tiny local file); absent → the dashboard shows "daemon not running".
    heartbeat: () => readHeartbeat(env.logsRoot),
  };
  const add: AddRepoDeps = {
    exec,
    configPath: env.configPath,
    adapterFor: (repo: RepoRef) => makeAdapter(repo, config, exec),
  };

  // v1 dashboard is single-repo-first (mirrors the CLI's `firstRepo`): the :id route maps
  // to the first watched repo. Multi-repo issue routing lands with the richer board view.
  const repoForId = (_repoId: string): RepoRef => {
    const repo = repos[0];
    if (!repo) throw new Error('no repos are watched');
    return repo;
  };

  return buildServerDeps({
    repos,
    assemble,
    add,
    repoForId,
    ...(env.writeToken ? { writeToken: env.writeToken } : {}),
  });
}

/** Wire deps + listen. Returns the server so callers can close() it. */
export function startWebServer(env: Env = readEnv()) {
  const server = createServer(buildDeps(env));
  server.listen(env.port, env.host, () => {
    // Single startup line — states the write mode but NEVER the token value itself.
    const mode = env.writeToken ? 'writes enabled (bearer token)' : 'read-only';
    console.log(`maestro dashboard on http://${env.host}:${env.port} — ${mode}`);
  });
  return server;
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('main.js') || entry.endsWith('main.ts')) {
  try {
    startWebServer();
  } catch (err) {
    console.error(`maestro web: cannot start — ${(err as Error).message}`);
    process.exitCode = 1;
  }
}
