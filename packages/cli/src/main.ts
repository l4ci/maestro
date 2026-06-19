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
  NodeExec,
  type RepoRef,
  WorkspaceManager,
  addRepo,
  allBinaries,
  assembleDashboard,
  assembleIssue,
  botUserForHost,
  checkBinaries,
  composeForges,
  deriveWatchSet,
  loadConfig,
  makeForgeAdapter,
  repoRefFromUrl,
  requiredBinaries,
} from '@maestro/core';
import { runAdd } from './commands/add.js';
import { dashboard } from './commands/dashboard.js';
import { attach } from './commands/run.js';
import { bootDaemon } from './daemon.js';
import { renderDoctor, renderList, renderLogs, renderStatus } from './format.js';
import { type ParsedCommand, parse } from './parse.js';

interface Env {
  configPath: string;
  logsRoot: string;
}

function readEnv(): Env {
  return {
    configPath: process.env.MAESTRO_CONFIG ?? './maestro.config.yaml',
    logsRoot: process.env.MAESTRO_LOGS_DIR ?? './logs',
  };
}

/** Build the read-only assembly deps (adapter + per-repo settings + logs cache reader).
 *  Forge-aware construction lives in core's forge wiring (composeForges). */
function buildAssembleDeps(env: Env): { repos: RepoRef[]; deps: AssembleDeps } {
  const config = loadConfig(env.configPath);
  const repos = deriveWatchSet(config);
  const { adapterFor, settingsFor } = composeForges(config, new NodeExec());
  return { repos, deps: { adapterFor, settingsFor, logs: new FileLogReader(env.logsRoot) } };
}

/** Build the full (read+write) deps addRepo needs for the §11 onboarding setup. Includes
 *  the bootstrap-PR wiring (workspace + template) when both are resolvable, so `maestro
 *  add` opens a sample-WORKFLOW PR alongside the issue. */
function buildAddDeps(env: Env, url: string): AddRepoDeps {
  const exec = new NodeExec();
  const config = loadConfig(env.configPath);
  const deps: AddRepoDeps = {
    exec,
    configPath: env.configPath,
    adapterFor: (repo: RepoRef) => makeForgeAdapter(repo, config, exec),
  };

  // Best-effort: open the sample-WORKFLOW PR too, but only when we can resolve the repo's
  // forge token env AND read the template. Any gap → fall back to issue-only onboarding.
  try {
    const repo = repoRefFromUrl(url, config.forges);
    const entries = repo.forge === 'github' ? config.forges.github : config.forges.gitlab;
    const tokenEnv = entries?.find((e) => e.host === repo.host)?.token_env;
    const templatePath = process.env.MAESTRO_TEMPLATE ?? './templates/WORKFLOW.md';
    if (tokenEnv) {
      const workspace = new WorkspaceManager({
        root: config.defaults.workspaces.root,
        diskCap: config.defaults.workspaces.disk_cap,
        exec,
        tokenEnv,
      });
      deps.bootstrapPr = {
        workspace,
        templateText: readFileSync(templatePath, 'utf8'),
        botUser: botUserForHost(repo.host, config),
      };
    }
  } catch {
    // unresolvable forge / missing template → issue-only onboarding (addRepo handles it).
  }
  return deps;
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
      console.log('maestro <add|status|list|logs|run|daemon|dashboard|doctor> — see docs');
      return 0;
    case 'daemon':
      // Fold the daemon entry into the CLI so `maestro daemon` replaces the deep
      // `node dist/daemon.js` path (#28). bootDaemon() owns the preflight + run-forever
      // loop and returns the exit code; the `dist/daemon.js` alias stays for systemd.
      return bootDaemon();
    case 'dashboard':
      // Same fold-in for the web dashboard: spawn the sibling package's built entry
      // (never import @maestro/web — both shells stay thin over core).
      return dashboard({ exec: new NodeExec() });
    case 'doctor': {
      // Check the binaries this install actually needs (config-scoped); if the config
      // can't be read, fall back to probing the full set so doctor still helps mid-setup.
      let reqs = allBinaries();
      try {
        reqs = requiredBinaries(loadConfig(env.configPath));
      } catch {
        // config missing/invalid — checking everything is the safe, useful default.
      }
      const result = await checkBinaries(new NodeExec(), reqs);
      console.log(renderDoctor(result));
      return result.ok ? 0 : 1;
    }
    case 'usage-error':
      console.error(cmd.message);
      return 1;
    case 'add': {
      const out = await runAdd(cmd, { addRepo, addDeps: buildAddDeps(env, cmd.url) });
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
        tokenEnv:
          config.forges.gitlab?.find((e) => e.host === repo.host)?.token_env ??
          'MAESTRO_GITLAB_TOKEN',
      });
      const resolveWorkspace = (iid: number): string | undefined =>
        workspace.workspaceExists(repo, iid)
          ? workspace.listWorkspaces(repo).find((w) => w.iid === iid)?.dir
          : undefined;
      // Attach has no per-repo WORKFLOW loaded, so use the global agent selection:
      // an explicit command override, else the kind name (claude|codex).
      const agentCommand = config.defaults.agent.command ?? config.defaults.agent.kind;
      return attach(cmd.issue, { exec, agentCommand, resolveWorkspace });
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
