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
  deriveWatchSet,
  parseConfig,
  parseWorkflow,
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
}

function readEnv(): Env {
  return {
    configPath: process.env.MAESTRO_CONFIG ?? './maestro.config.yaml',
    workflowsDir: process.env.MAESTRO_WORKFLOWS_DIR ?? './workspaces',
    logsRoot: process.env.MAESTRO_LOGS_DIR ?? './logs',
    host: process.env.MAESTRO_WEB_HOST ?? '127.0.0.1',
    port: Number(process.env.MAESTRO_WEB_PORT ?? '4000'),
  };
}

function loadConfig(configPath: string): MaestroConfig {
  const parsed = parseConfig(readFileSync(configPath, 'utf8'));
  if (!parsed.ok) throw new Error(`config invalid: ${parsed.error}`);
  return parsed.value;
}

/** The one forge-aware seam — construct the concrete adapter for a repo's forge. */
function makeAdapter(repo: RepoRef, config: MaestroConfig, exec: Exec): ForgeAdapter {
  const botUser = config.defaults.bot_user;
  if (repo.forge === 'gitlab') {
    const gl = config.forges.gitlab;
    if (!gl) throw new Error('no gitlab forge configured');
    return new GitlabAdapter(exec, {
      token: process.env[gl.token_env] ?? '',
      host: gl.host,
      botUser,
    });
  }
  const gh = config.forges.github;
  if (!gh) throw new Error('no github forge configured');
  return new GithubAdapter(exec, {
    token: process.env[gh.token_env] ?? '',
    host: gh.host,
    botUser,
  });
}

/** Build everything createServer needs: read-only assembly deps + the write (addRepo) deps. */
function buildDeps(env: Env) {
  const exec = new NodeExec();
  const config = loadConfig(env.configPath);
  const repos = deriveWatchSet(config);

  const adapters = new Map<string, ReadOnlyForgeAdapter>();
  const adapterFor = (repo: RepoRef): ReadOnlyForgeAdapter => {
    let a = adapters.get(repo.forge);
    if (!a) {
      a = makeAdapter(repo, config, exec);
      adapters.set(repo.forge, a);
    }
    return a;
  };

  const settingsFor = (repo: RepoRef): RepoSettings => {
    const path = `${env.workflowsDir}/${slugifyProject(repo.project)}/WORKFLOW.md`;
    const wf = parseWorkflow(readFileSync(path, 'utf8'), repo.host);
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

  return buildServerDeps({ repos, assemble, add, repoForId });
}

/** Wire deps + listen. Returns the server so callers can close() it. */
export function startWebServer(env: Env = readEnv()) {
  const server = createServer(buildDeps(env));
  server.listen(env.port, env.host, () => {
    // Single startup line — never logs a token (deps read env directly at construction).
    console.log(`maestro dashboard on http://${env.host}:${env.port}`);
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
