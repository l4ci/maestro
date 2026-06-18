// Web composition root (M6 Part F). The production entrypoint deps.ts was written for:
// read config + per-repo WORKFLOWs, wire the read-only assembly seam + the shared addRepo,
// and bind a port. Mirrors cli/daemon.ts — ZERO business logic; every call delegates to
// @maestro/core. Tokens are read from `process.env[token_env]` only to construct adapters
// and never logged. Run via `node packages/web/dist/main.js` (or the `web` setup step).

import {
  type AddRepoDeps,
  type AssembleDeps,
  FileLogReader,
  NodeExec,
  type RepoRef,
  type WorkOnIssueDeps,
  composeForges,
  deriveWatchSet,
  loadConfig,
  makeForgeAdapter,
  readHeartbeat,
} from '@maestro/core';
import { buildServerDeps } from './deps.js';
import { createServer } from './server.js';

interface Env {
  configPath: string;
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
    logsRoot: process.env.MAESTRO_LOGS_DIR ?? './logs',
    host: process.env.MAESTRO_WEB_HOST ?? '127.0.0.1',
    port: Number(process.env.MAESTRO_WEB_PORT ?? '4000'),
    ...(token ? { writeToken: token } : {}),
  };
}

/** Build everything createServer needs: read-only assembly deps + the write (addRepo) deps.
 *  Forge-aware construction lives in core's forge wiring (composeForges). */
function buildDeps(env: Env) {
  const exec = new NodeExec();
  const config = loadConfig(env.configPath);
  const repos = deriveWatchSet(config);
  const { adapterFor, settingsFor } = composeForges(config, exec);

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
    adapterFor: (repo: RepoRef) => makeForgeAdapter(repo, config, exec),
  };

  // Resolve a repo id (the URL-encoded :id path segment = repo.url) back to its RepoRef.
  // The frontend sends r.repo.url; an unknown id is a 500 (the outer handler guards it).
  const repoForId = (repoId: string): RepoRef => {
    const repo = repos.find((r) => r.url === repoId);
    if (!repo) throw new Error(`unknown repo: ${repoId}`);
    return repo;
  };

  const work: WorkOnIssueDeps = {
    adapterFor: (repo: RepoRef) => makeForgeAdapter(repo, config, exec),
    settingsFor,
  };

  return buildServerDeps({
    repos,
    assemble,
    add,
    repoForId,
    work,
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
