// Forge wiring — the ONE home for forge-aware construction (CONTEXT.md §Forge wiring).
// Owns the token-env lookup, the per-host botUser resolution, the GitLab/GitHub adapter
// choice, and the static settings path (config parse + WORKFLOW.md cache read with
// bootstrap-template fallback) that cli/main and web/main previously each implemented.
//
// Direct `process.env`/fs reads are in-contract here — this IS the composition layer.
// Tokens are read from `process.env[token_env]` only to construct adapters and are
// never logged. The daemon's hot-refresh settings path (WorkflowSource/deriveCell) is
// deliberately NOT behind this interface — its validate-before-swap semantics differ
// from this static read.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBootstrapWorkflow } from '../bootstrap/bootstrap-workflow.js';
import { botUserForHost, parseConfig } from '../config/load-config.js';
import { resolveRepoSettings } from '../config/resolve-settings.js';
import type {
  Exec,
  ForgeAdapter,
  MaestroConfig,
  RepoRef,
  RepoSettings,
} from '../contracts/index.js';
import { GithubAdapter } from '../forge/github/github-adapter.js';
import { GitlabAdapter } from '../forge/gitlab/gitlab-adapter.js';
import { parseWorkflow } from '../workflow/load-workflow.js';
import { slugifyProject } from '../workspace/paths.js';

/** Read + parse maestro.config.yaml; invalid config throws the one canonical message. */
export function loadConfig(configPath: string): MaestroConfig {
  const parsed = parseConfig(readFileSync(configPath, 'utf8'));
  if (!parsed.ok) throw new Error(`config invalid: ${parsed.error}`);
  return parsed.value;
}

/** Construct the concrete adapter for a repo's forge+host — the one forge-aware seam.
 *  botUser resolves per host (forge entry bot_user, else the global default); the token
 *  is read from the entry's token_env at construction. Missing forge entry → clear error.
 *  Bare (uncached) so the daemon's upfront buildAdapters can construct one per entry. */
export function makeForgeAdapter(
  repo: Pick<RepoRef, 'forge' | 'host'>,
  config: MaestroConfig,
  exec: Exec,
): ForgeAdapter {
  const entry = config.forges[repo.forge]?.find((e) => e.host === repo.host);
  if (!entry) throw new Error(`no ${repo.forge} forge configured for host '${repo.host}'`);
  const cfg = {
    token: process.env[entry.token_env] ?? '',
    host: entry.host,
    botUser: botUserForHost(repo.host, config),
  };
  return repo.forge === 'gitlab' ? new GitlabAdapter(exec, cfg) : new GithubAdapter(exec, cfg);
}

/** The M0 template — base for a bootstrap-mode repo's stand-in workflow (the daemon's
 *  readTemplate warns instead; here a silent '' lets the parse error surface). */
function readTemplate(): string {
  try {
    return readFileSync(process.env.MAESTRO_TEMPLATE ?? './templates/WORKFLOW.md', 'utf8');
  } catch {
    return '';
  }
}

export interface ComposedForges {
  /** Adapter for a repo, cached per (forge, host) — two hosts of the same forge carry
   *  different tokens/bots. */
  adapterFor(repo: RepoRef): ForgeAdapter;
  /** Static per-repo settings from the local WORKFLOW.md cache, falling back to the
   *  bootstrap template when no cache exists yet. */
  settingsFor(repo: RepoRef): RepoSettings;
}

/** Wire the forge-aware deps the read paths (CLI entry, web entry) compose over. */
export function composeForges(config: MaestroConfig, exec: Exec): ComposedForges {
  // Cache per (forge, host) — two hosts of the same forge carry different tokens/bots.
  const adapters = new Map<string, ForgeAdapter>();
  const adapterFor = (repo: RepoRef): ForgeAdapter => {
    const key = `${repo.forge}:${repo.host}`;
    let a = adapters.get(key);
    if (!a) {
      a = makeForgeAdapter(repo, config, exec);
      adapters.set(key, a);
    }
    return a;
  };

  const settingsFor = (repo: RepoRef): RepoSettings => {
    // The workflow cache only exists once the repo has a committed WORKFLOW.md; a missing
    // file means BOOTSTRAP mode (the daemon's deriveCell does the same dance), so readers
    // must fall back to the template instead of reporting the repo unreachable.
    const workflowsDir = process.env.MAESTRO_WORKFLOWS_DIR ?? './workspaces';
    const path = join(workflowsDir, slugifyProject(repo.project), 'WORKFLOW.md');
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

  return { adapterFor, settingsFor };
}
