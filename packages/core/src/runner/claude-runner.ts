// Claude runner (§8, §10). A thin AgentCli spec over the shared run core (run-cli.ts):
// build the cold `claude -p --output-format stream-json` argv and parse Claude's
// stream-json transcript into an AgentResult. Run machinery (stall watchdog, retry,
// env-scrub, rate-limit-on-error) lives in runCli; the prompt + §10 status contract live
// in prompt.ts; the {status} scanner + rate-limit detection live in agent-status.ts.
//
// SECURITY (§13.1): the agent acts on attacker-controllable context with the bot's
// credentials in an isolated cold workspace; honor permissionMode verbatim, keep secrets
// out of argv/summary. No session-resume flag — every run is a cold session.

import type { AgentResult, Exec, Runner, RunnerInput } from '../contracts/index.js';
import { detectRateLimit, pickLastStatus, tryParse } from './agent-status.js';
import { type AgentCli, type RunCliConfig, runCli } from './run-cli.js';

// Back-compat re-exports: existing call sites and tests import these from this module.
export { assemblePrompt, STATUS_CONTRACT } from './prompt.js';
export { detectRateLimit, topLevelJsonObjects } from './agent-status.js';
export type { StallInfo, RunCliConfig } from './run-cli.js';

/** Kept for back-compat (was the bespoke ClaudeRunnerConfig). */
export type ClaudeRunnerConfig = RunCliConfig;

export class ClaudeRunner implements Runner {
  readonly #exec: Exec;
  readonly #cfg: RunCliConfig;

  constructor(exec: Exec, cfg: RunCliConfig = {}) {
    this.#exec = exec;
    this.#cfg = cfg;
  }

  run(input: RunnerInput): Promise<AgentResult> {
    return runCli(this.#exec, claudeCli, input, this.#cfg);
  }
}

/** The Claude CLI spec consumed by runCli. */
const claudeCli: AgentCli = {
  command: (input) => input.claude.command,
  args: buildClaudeArgs,
  parse: parseAgentResult,
};

/** Cold-session argv. No --resume/--continue ever (every run is cold, §2/§8). */
export function buildClaudeArgs(input: RunnerInput): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-turns',
    String(input.claude.maxTurns),
  ];
  // bypassPermissions maps to the flag that skips every prompt; safety is workspace
  // ISOLATION (§13.1), not prompting. Other modes pass through verbatim.
  if (input.claude.permissionMode === 'bypassPermissions') {
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--permission-mode', input.claude.permissionMode);
  }
  return args;
}

interface StreamLine {
  type?: string;
  subtype?: string;
  result?: unknown;
  is_error?: boolean;
  message?: { content?: Array<{ type?: string; text?: unknown }> };
}

/**
 * Extract the §10 status from the stream-json transcript. Scan EVERY assistant message
 * plus the terminal `result` line in stream order and keep the LAST valid {status} block
 * (the result line is last, so a correctly-emitted final status wins; earlier assistant
 * messages are the fallback when the final one omits it, #4). Any failure → safe
 * `in_progress` (daemon re-runs next tick), with a usage-limit run marked for backoff (#47).
 */
export function parseAgentResult(lines: string[], exitCode: number, stderr = ''): AgentResult {
  const objs = lines.map(tryParse).filter((o): o is StreamLine => o !== null);
  const sawResult = objs.some((o) => o.type === 'result');
  const texts = objs.map((o) =>
    o.type === 'result' ? (typeof o.result === 'string' ? o.result : '') : assistantText(o),
  );

  const status = pickLastStatus(texts);
  if (status) return status;

  const limit = detectRateLimit(`${lines.join('\n')}\n${stderr}`);
  if (limit) {
    return {
      status: 'in_progress',
      summary: 'claude usage/rate limit reached; daemon backs off (#47)',
      rateLimit: limit,
    };
  }
  if (!sawResult) {
    return { status: 'in_progress', summary: `no result line (exit ${exitCode}); will retry` };
  }
  return {
    status: 'in_progress',
    summary: 'no parseable {status} block in transcript; will retry',
  };
}

/** Concatenated text of an assistant message's text content blocks (transcript scan). */
function assistantText(o: StreamLine): string {
  if (o.type !== 'assistant' || !Array.isArray(o.message?.content)) return '';
  return o.message.content
    .filter((b): b is { type?: string; text: string } => typeof b?.text === 'string')
    .map((b) => b.text)
    .join('\n');
}
