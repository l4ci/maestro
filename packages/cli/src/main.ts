// CLI entry. A THIN dispatcher: parse argv → route to the matching command → return an
// exit code. A usage-error maps to a nonzero exit with the message on stderr and NO
// stacktrace (the §A3 guarantee — the CLI never crashes on a typo). All real logic lives
// in core (addRepo, assemble*, FileLogReader) and the per-command modules; main only
// marshals argv and composes the read-I/O deps.

import { readFileSync } from 'node:fs';
import {
  type AddRepoDeps,
  type AssembleDeps,
  FileLogReader,
  GitlabAdapter,
  NodeExec,
  type ReadOnlyForgeAdapter,
  type RepoRef,
  type RepoSettings,
  WorkspaceManager,
  addRepo,
  assembleDashboard,
  assembleIssue,
  deriveWatchSet,
  parseConfig,
  parseWorkflow,
  repoRefFromUrl,
  resolveRepoSettings,
  slugifyProject,
} from '@maestro/core';
import { runAdd } from './commands/add.js';
import { attach } from './commands/run.js';
import { renderList, renderLogs, renderStatus } from './format.js';
import { type ParsedCommand, parse } from './parse.js';

interface Env {
  configPath: string;
  workflowsDir: string;
  logsRoot: string;
}

function readEnv(): Env {
  return {
    configPath: process.env.MAESTRO_CONFIG ?? './maestro.config.yaml',
    workflowsDir: process.env.MAESTRO_WORKFLOWS_DIR ?? './workspaces',
    logsRoot: process.env.MAESTRO_LOGS_DIR ?? './logs',
  };
}

function loadConfig(configPath: string) {
  const parsed = parseConfig(readFileSync(configPath, 'utf8'));
  if (!parsed.ok) throw new Error(`config invalid: ${parsed.error}`);
  return parsed.value;
}

/** Build the read-only assembly deps (adapter + per-repo settings + logs cache reader). */
function buildAssembleDeps(env: Env): { repos: RepoRef[]; deps: AssembleDeps } {
  const exec = new NodeExec();
  const config = loadConfig(env.configPath);
  const repos = deriveWatchSet(config);

  const adapters = new Map<string, ReadOnlyForgeAdapter>();
  const adapterFor = (repo: RepoRef): ReadOnlyForgeAdapter => {
    let a = adapters.get(repo.forge);
    if (!a) {
      const gl = config.forges.gitlab;
      if (!gl || repo.forge !== 'gitlab') throw new Error(`no adapter for forge ${repo.forge}`);
      a = new GitlabAdapter(exec, {
        token: process.env[gl.token_env] ?? '',
        host: gl.host,
        botUser: config.defaults.bot_user,
      });
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

  return { repos, deps: { adapterFor, settingsFor, logs: new FileLogReader(env.logsRoot) } };
}

/** Build the full (read+write) deps addRepo needs for the §11 onboarding setup. */
function buildAddDeps(env: Env): AddRepoDeps {
  const exec = new NodeExec();
  const config = loadConfig(env.configPath);
  return {
    exec,
    configPath: env.configPath,
    adapterFor: (repo: RepoRef) => {
      const gl = config.forges.gitlab;
      if (!gl || repo.forge !== 'gitlab') throw new Error(`no adapter for forge ${repo.forge}`);
      return new GitlabAdapter(exec, {
        token: process.env[gl.token_env] ?? '',
        host: gl.host,
        botUser: config.defaults.bot_user,
      });
    },
  };
}

function firstRepo(env: Env): { repo: RepoRef; deps: AssembleDeps } {
  const { repos, deps } = buildAssembleDeps(env);
  const repo = repos[0];
  if (!repo) throw new Error('no repos are watched');
  return { repo, deps };
}

async function dispatch(cmd: ParsedCommand, env: Env): Promise<number> {
  switch (cmd.kind) {
    case 'help':
      console.log('maestro <add|status|list|logs|run> — see docs');
      return 0;
    case 'usage-error':
      console.error(cmd.message);
      return 1;
    case 'add': {
      const out = await runAdd(cmd, { addRepo, addDeps: buildAddDeps(env) });
      console.log(out);
      return 0;
    }
    case 'list': {
      const { repos, deps } = buildAssembleDeps(env);
      console.log(renderList(await assembleDashboard(repos, deps)));
      return 0;
    }
    case 'status': {
      const { repo, deps } = firstRepo(env);
      console.log(renderStatus(await assembleIssue(repo, cmd.issue, deps)));
      return 0;
    }
    case 'logs': {
      const { repo } = firstRepo(env);
      const logs = new FileLogReader(env.logsRoot);
      console.log(renderLogs(await logs.readIssueLog(repo, cmd.issue)));
      return 0;
    }
    case 'run': {
      const exec = new NodeExec();
      const config = loadConfig(env.configPath);
      const repo = repoRefFromUrl(config.repos[0]?.url ?? '', config.forges);
      const workspace = new WorkspaceManager({
        root: config.defaults.workspaces.root,
        diskCap: config.defaults.workspaces.disk_cap,
        exec,
        tokenEnv: config.forges.gitlab?.token_env ?? 'MAESTRO_GITLAB_TOKEN',
      });
      const resolveWorkspace = (iid: number): string | undefined =>
        workspace.workspaceExists(repo, iid)
          ? workspace.listWorkspaces(repo).find((w) => w.iid === iid)?.dir
          : undefined;
      return attach(cmd.issue, { exec, resolveWorkspace });
    }
  }
}

/** Parse + dispatch. Usage errors map to a nonzero exit; unexpected errors print a clean
 *  message (not a raw stacktrace) and exit nonzero. */
export async function run(argv: string[]): Promise<number> {
  const cmd = parse(argv);
  try {
    return await dispatch(cmd, readEnv());
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
}
