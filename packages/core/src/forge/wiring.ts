// Forge wiring (#90) — the ONE home for forge-aware construction. Owns token-env
// lookup, botUser-per-host resolution, the GitLab/GitHub adapter choice, and the
// static settings path (config parse, WORKFLOW.md cache read with bootstrap-template
// fallback). The CLI entry, the web entry, and the daemon's upfront adapter build all
// construct forges through here — this used to live copy-pasted in each of them.
//
// Direct `process.env` / fs reads are IN-CONTRACT: this IS the composition layer, the
// one place real I/O is allowed to meet the pure core (§0.8). Tokens are resolved from
// `process.env[token_env]` only to construct adapters and never logged.
//
// NOT here, by decision: the daemon's hot-refresh settings path (WorkflowSource +
// validate-before-swap stays in cli/daemon.ts) — this module serves the STATIC path
// (one process-lifetime read: CLI commands, web boot, daemon upfront adapter build).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBootstrapWorkflow } from '../bootstrap/bootstrap-workflow.js';
import { botUserForHost, parseConfig } from '../config/load-config.js';
import { resolveRepoSettings } from '../config/resolve-settings.js';
import type {
  Exec,
  ForgeAdapter,
  ForgeEntry,
  ForgeKind,
  MaestroConfig,
  RepoRef,
  RepoSettings,
} from '../contracts/index.js';
import { parseWorkflow } from '../workflow/load-workflow.js';
import { slugifyProject } from '../workspace/paths.js';
import { GithubAdapter } from './github/github-adapter.js';
import { GitlabAdapter } from './gitlab/gitlab-adapter.js';

/** What composeForges hands its consumers: the two forge-aware lookups. */
export interface ForgeWiring {
  /** The concrete adapter for a repo's forge+host — cached per (forge, host). */
  adapterFor: (repo: RepoRef) => ForgeAdapter;
  /** A repo's resolved settings via the static path (cache read, bootstrap fallback). */
  settingsFor: (repo: RepoRef) => RepoSettings;
}

/** Read + parse maestro.config.yaml; throw with the parse error on an invalid file. */
export function loadConfigFile(configPath: string): MaestroConfig {
  const parsed = parseConfig(readFileSync(configPath, 'utf8'));
  if (!parsed.ok) throw new Error(`config invalid: ${parsed.error}`);
  return parsed.value;
}

/** The bare adapter constructor — one forge entry → one concrete adapter. The daemon's
 *  upfront build maps this over every configured entry; adapterFor (below) routes a
 *  repo to it via its forge entry. botUser resolves per host (forge entry bot_user,
 *  else the global default) — usernames are per-forge namespaces. */
export function makeForgeAdapter(
  forge: ForgeKind,
  entry: ForgeEntry,
  config: MaestroConfig,
  exec: Exec,
): ForgeAdapter {
  const cfg = {
    token: process.env[entry.token_env] ?? '',
    host: entry.host,
    botUser: botUserForHost(entry.host, config),
  };
  return forge === 'gitlab' ? new GitlabAdapter(exec, cfg) : new GithubAdapter(exec, cfg);
}

/** The M0 template — base for a bootstrap-mode repo's stand-in workflow. Empty string
 *  if unreadable; the parse error then surfaces from settingsFor. */
function readTemplate(): string {
  try {
    return readFileSync(process.env.MAESTRO_TEMPLATE ?? './templates/WORKFLOW.md', 'utf8');
  } catch {
    return '';
  }
}

/** Compose the forge-aware lookups over a loaded config. Env (MAESTRO_WORKFLOWS_DIR,
 *  MAESTRO_TEMPLATE, token vars) is read lazily per call — composition-root contract. */
export function composeForges(config: MaestroConfig, exec: Exec): ForgeWiring {
  // Cache per (forge, host) — two hosts of the same forge carry different tokens/bots.
  const adapters = new Map<string, ForgeAdapter>();
  const adapterFor = (repo: RepoRef): ForgeAdapter => {
    const key = `${repo.forge}:${repo.host}`;
    let a = adapters.get(key);
    if (!a) {
      const entry = config.forges[repo.forge]?.find((e) => e.host === repo.host);
      if (!entry) throw new Error(`no ${repo.forge} forge configured for host '${repo.host}'`);
      a = makeForgeAdapter(repo.forge, entry, config, exec);
      adapters.set(key, a);
    }
    return a;
  };

  const settingsFor = (repo: RepoRef): RepoSettings => {
    // The workflow cache only exists once the repo has a committed WORKFLOW.md; a
    // missing file means BOOTSTRAP mode (the daemon's deriveCell does the same dance),
    // so static consumers must fall back to the template instead of reporting the repo
    // unreachable.
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
