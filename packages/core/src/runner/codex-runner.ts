// Codex runner (#codex). A thin AgentCli spec over the shared run core (run-cli.ts):
// invoke `codex exec - --json` (prompt on stdin via the `-` sentinel) and parse the
// JSONL ThreadEvent stream into an AgentResult. The {status} scanner, rate-limit
// detection, prompt assembly, stall watchdog, retry, and env-scrub are all shared —
// only the argv and the transcript→text mapping are Codex-specific.
//
// Codex differences from Claude (documented, intentional): no --max-turns (codex exec
// runs to completion; the WORKFLOW max_turns knob is ignored under codex); permission
// parity is via --sandbox (bypass → --dangerously-bypass-approvals-and-sandbox for full
// fs + network, the equivalent of claude's --dangerously-skip-permissions; safety is
// workspace ISOLATION, §13.1, not the sandbox). Model selection comes from codex's own
// config (~/.codex/config.toml), not maestro.

import type { AgentResult, Exec, Runner, RunnerInput } from '../contracts/index.js';
import { detectRateLimit, pickLastStatus, tryParse } from './agent-status.js';
import { type AgentCli, type RunCliConfig, runCli } from './run-cli.js';

export class CodexRunner implements Runner {
  readonly #exec: Exec;
  readonly #cfg: RunCliConfig;

  constructor(exec: Exec, cfg: RunCliConfig = {}) {
    this.#exec = exec;
    this.#cfg = cfg;
  }

  run(input: RunnerInput): Promise<AgentResult> {
    return runCli(this.#exec, codexCli, input, this.#cfg);
  }
}

const codexCli: AgentCli = {
  command: (input) => input.claude.command,
  args: buildCodexArgs,
  parse: parseCodexResult,
};

/** Cold-session argv. `-` forces codex to read the prompt from stdin (no prompt on argv). */
export function buildCodexArgs(input: RunnerInput): string[] {
  const args = ['exec', '-', '--json', '--skip-git-repo-check'];
  if (input.claude.permissionMode === 'bypassPermissions') {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    args.push('--sandbox', 'workspace-write');
  }
  return args;
}

interface CodexEvent {
  type?: string;
  item?: { type?: string; text?: unknown };
}

/** The agent's prose: the text of every `item.completed` agent_message, in stream order. */
export function extractCodexTexts(lines: string[]): string[] {
  const texts: string[] = [];
  for (const line of lines) {
    const o = tryParse(line) as CodexEvent | null;
    if (!o || o.type !== 'item.completed') continue;
    const item = o.item;
    if (!item || item.type !== 'agent_message' || typeof item.text !== 'string') continue;
    texts.push(item.text);
  }
  return texts;
}

/**
 * Parse the §10 status from codex's JSONL transcript: keep the LAST valid {status} block
 * across the agent_message items. Any failure → safe `in_progress` (daemon re-runs next
 * tick); a usage/rate-limit signal is marked so the daemon backs off (#47).
 */
export function parseCodexResult(lines: string[], exitCode: number, stderr = ''): AgentResult {
  const texts = extractCodexTexts(lines);

  const status = pickLastStatus(texts);
  if (status) return status;

  const limit = detectRateLimit(`${lines.join('\n')}\n${stderr}`);
  if (limit) {
    return {
      status: 'in_progress',
      summary: 'codex usage/rate limit reached; daemon backs off (#47)',
      rateLimit: limit,
    };
  }
  if (texts.length === 0) {
    return {
      status: 'in_progress',
      summary: `no agent message in codex output (exit ${exitCode}); will retry`,
    };
  }
  return {
    status: 'in_progress',
    summary: 'no parseable {status} block in transcript; will retry',
  };
}
