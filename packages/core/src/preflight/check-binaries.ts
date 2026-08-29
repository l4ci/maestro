// Boot-time preflight: are the external binaries the daemon shells out to actually on
// PATH? The whole system is a thin orchestrator over `glab`/`gh` (forge transport, §8),
// `git` (workspace clone/branch), and the configured agent (`claude` or `codex` per
// `defaults.agent`, §10). A missing binary
// otherwise surfaces only as a failing tick that retries forever — this turns that into
// one clear up-front error. Pure over the injected Exec seam (§0.8), so unit-testable
// without the real tools.

import type { Exec, MaestroConfig } from '../contracts/index.js';

export interface BinaryReq {
  bin: string; // 'git' | 'glab' | 'gh' | 'claude' | 'codex'
  reason: string; // why the daemon needs it — shown to the operator
}

export interface PreflightResult {
  ok: boolean;
  present: string[];
  missing: BinaryReq[];
}

/** Every binary the daemon can depend on, with why. Used by `doctor` when config is
 *  unreadable (check everything) and as the source for the config-scoped subset. */
export function allBinaries(): BinaryReq[] {
  return [
    { bin: 'git', reason: 'clone and branch per-issue workspaces' },
    { bin: 'claude', reason: 'run the Claude coding agent headless' },
    { bin: 'codex', reason: 'run the Codex coding agent headless' },
    { bin: 'herdr', reason: 'host the coding agent in a herdr tab (runner: herdr)' },
    { bin: 'glab', reason: 'reach the GitLab API' },
    { bin: 'gh', reason: 'reach the GitHub API' },
  ];
}

/** The subset actually required by this install: git + selected agent always, plus only
 *  the forge binaries for forges the config declares. Proof commands (npx/playwright/…)
 *  are per-repo and out of scope here — they fail per-tick, not at boot.
 *
 *  Under `runner: herdr` the daemon shells out to `herdr` itself, not `claude`/`codex`
 *  directly — herdr resolves the agent binary from `--kind` on its own side (a
 *  documented limitation: `agent.command`/`claude.command` have no effect there), so
 *  preflighting the agent binary here would check the wrong (or an absent-by-design)
 *  local binary. */
export function requiredBinaries(config: MaestroConfig): BinaryReq[] {
  // Optional-chained: a no-defaults config (some test fixtures) → the claude default.
  const agent = config.defaults?.agent;
  const reqs: BinaryReq[] = [{ bin: 'git', reason: 'clone and branch per-issue workspaces' }];
  if (agent?.runner === 'herdr') {
    reqs.push({
      bin: agent.herdr?.command ?? 'herdr',
      reason: 'host the coding agent in a herdr tab',
    });
  } else {
    reqs.push({
      bin: agent?.command ?? agent?.kind ?? 'claude',
      reason: 'run the coding agent headless',
    });
  }
  if (config.forges.gitlab) reqs.push({ bin: 'glab', reason: 'reach the GitLab API' });
  if (config.forges.github) reqs.push({ bin: 'gh', reason: 'reach the GitHub API' });
  return reqs;
}

/** Probe each binary for PATH presence (sequential → deterministic `present` order). */
export async function checkBinaries(exec: Exec, reqs: BinaryReq[]): Promise<PreflightResult> {
  const present: string[] = [];
  const missing: BinaryReq[] = [];
  for (const req of reqs) {
    if (await isOnPath(exec, req.bin)) present.push(req.bin);
    else missing.push(req);
  }
  return { ok: missing.length === 0, present, missing };
}

/** `<bin> --version` proves presence: a resolved run (ANY exit code) means the binary
 *  exists and is executable. Only a spawn ENOENT means "not on PATH". Any other spawn
 *  error is treated as present-but-quirky — we're testing existence, not health. */
async function isOnPath(exec: Exec, bin: string): Promise<boolean> {
  try {
    await exec.run(bin, ['--version'], { timeoutMs: 5_000 });
    return true;
  } catch (err) {
    return !isEnoent(err);
  }
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}
