// The agent-agnostic run core (§8, §13): one RunnerInput → one cold CLI invocation via
// Exec.stream, with the stall watchdog (kill + retry once), forge-token env-scrub
// (§13.1), and a safe degrade — any parse failure / spawn error becomes a SAFE
// `in_progress` (never a false `done`), so the daemon re-runs next tick (§3). Each agent
// supplies an AgentCli (command/args/parse); everything else is identical across agents.

import type { AgentResult, Exec, RunnerInput } from '../contracts/index.js';
import { detectRateLimit, scrub } from './agent-status.js';
import { assemblePrompt } from './prompt.js';

export interface StallInfo {
  attempt: number; // 0-based attempt that stalled
  willRetry: boolean; // is another cold attempt coming?
  timeoutMs: number; // the window that elapsed with no agent events
}

export interface RunCliConfig {
  stallTimeoutMs?: number; // fallback when RunnerInput omits one (default 120s)
  maxStallRetries?: number; // extra cold attempts after a stall (default 1)
  /** Env var NAMES scrubbed from the agent's environment — the forge token_env(s), §13.1. */
  secretEnvKeys?: string[];
  /** Called once per stall kill so the daemon can log it. Never throws into the run. */
  onStall?: (info: StallInfo) => void;
}

/** A CLI agent backend: how to invoke it and how to read its transcript. */
export interface AgentCli {
  command(input: RunnerInput): string;
  args(input: RunnerInput): string[];
  parse(lines: string[], exitCode: number, stderr: string): AgentResult;
}

export async function runCli(
  exec: Exec,
  cli: AgentCli,
  input: RunnerInput,
  cfg: RunCliConfig,
): Promise<AgentResult> {
  const stallTimeoutMs = input.claude.stallTimeoutMs ?? cfg.stallTimeoutMs ?? 120_000;
  const maxStallRetries = cfg.maxStallRetries ?? 1;
  const secretEnvKeys = cfg.secretEnvKeys ?? [];
  let lastDiagnostic = 'no attempts ran';
  for (let attempt = 0; attempt <= maxStallRetries; attempt++) {
    const outcome = await attemptOnce(exec, cli, input, stallTimeoutMs, secretEnvKeys);
    if (outcome.kind === 'result') return outcome.result;
    lastDiagnostic = outcome.diagnostic; // 'stalled' — try a fresh cold attempt
    cfg.onStall?.({ attempt, willRetry: attempt < maxStallRetries, timeoutMs: stallTimeoutMs });
  }
  return { status: 'in_progress', summary: lastDiagnostic };
}

type Attempt = { kind: 'result'; result: AgentResult } | { kind: 'stall'; diagnostic: string };

async function attemptOnce(
  exec: Exec,
  cli: AgentCli,
  input: RunnerInput,
  stallTimeoutMs: number,
  secretEnvKeys: string[],
): Promise<Attempt> {
  const controller = new AbortController();
  const lines: string[] = [];
  let watchdog: NodeJS.Timeout | undefined;
  let stalled = false;

  const arm = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, stallTimeoutMs);
  };

  arm();
  let res: { code: number; stderr: string };
  try {
    res = await exec.stream(cli.command(input), cli.args(input), {
      cwd: input.workspaceDir,
      input: assemblePrompt(input),
      // scrub the forge token from the agent (§13.1): undefined => removed from child env
      env: Object.fromEntries(secretEnvKeys.map((k) => [k, undefined])),
      signal: controller.signal,
      onLine: (line) => {
        lines.push(line);
        arm(); // each event resets the stall window
      },
    });
  } catch (e) {
    if (stalled || controller.signal.aborted) return { kind: 'stall', diagnostic: 'stalled' };
    const msg = scrub((e as Error).message);
    const limit = detectRateLimit(msg);
    return {
      kind: 'result',
      result: limit
        ? { status: 'in_progress', summary: `runner error: ${msg}`, rateLimit: limit }
        : { status: 'in_progress', summary: `runner error: ${msg}` },
    };
  } finally {
    if (watchdog) clearTimeout(watchdog);
  }

  if (stalled) return { kind: 'stall', diagnostic: 'stalled' };
  return { kind: 'result', result: cli.parse(lines, res.code, res.stderr) };
}
