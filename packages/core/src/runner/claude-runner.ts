// Claude runner (§8, §10, contracts §0.9). A thin, deterministic translator:
// one RunnerInput → one cold `claude -p --output-format stream-json` invocation via
// Exec.stream → AgentResult. Prompt + context go on stdin (AM-7), never argv. Stall
// watchdog kills + retries once (§13); a parse failure or truncation degrades to a
// SAFE `in_progress` (never a false `done`), so the daemon re-runs next tick (§3).
//
// SECURITY (§13.1): the agent acts on attacker-controllable context with the bot's
// credentials. M3 does not solve prompt injection (deferred: containers §17 +
// public-repo opt-in, M8). M3's obligations: honor permissionMode verbatim (never
// widen it), keep secrets out of argv/summary. No session-resume flag — every run
// is a cold session.

import type { AgentResult, AgentStatus, Exec, Runner, RunnerInput } from '../contracts/index.js';

export interface ClaudeRunnerConfig {
  stallTimeoutMs?: number; // no agent events past this → kill (default 120s)
  maxStallRetries?: number; // extra cold attempts after a stall (default 1)
}

export class ClaudeRunner implements Runner {
  readonly #exec: Exec;
  readonly #stallTimeoutMs: number;
  readonly #maxStallRetries: number;

  constructor(exec: Exec, cfg: ClaudeRunnerConfig = {}) {
    this.#exec = exec;
    this.#stallTimeoutMs = cfg.stallTimeoutMs ?? 120_000;
    this.#maxStallRetries = cfg.maxStallRetries ?? 1;
  }

  async run(input: RunnerInput): Promise<AgentResult> {
    let lastDiagnostic = 'no attempts ran';
    for (let attempt = 0; attempt <= this.#maxStallRetries; attempt++) {
      const outcome = await this.#attempt(input); // each attempt is a fresh cold session
      if (outcome.kind === 'result') return outcome.result;
      lastDiagnostic = outcome.diagnostic; // 'stalled' — try a fresh cold attempt
    }
    return { status: 'in_progress', summary: lastDiagnostic };
  }

  /** One cold invocation. Returns a parsed result, or signals a stall to retry. */
  async #attempt(
    input: RunnerInput,
  ): Promise<{ kind: 'result'; result: AgentResult } | { kind: 'stall'; diagnostic: string }> {
    const controller = new AbortController();
    const lines: string[] = [];
    let watchdog: NodeJS.Timeout | undefined;
    let stalled = false;

    const arm = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        stalled = true;
        controller.abort();
      }, this.#stallTimeoutMs);
    };

    arm();
    let res: { code: number; stderr: string };
    try {
      res = await this.#exec.stream(input.claude.command, buildClaudeArgs(input), {
        cwd: input.workspaceDir,
        input: assemblePrompt(input),
        signal: controller.signal,
        onLine: (line) => {
          lines.push(line);
          arm(); // each event resets the stall window
        },
      });
    } catch (e) {
      if (stalled || controller.signal.aborted) return { kind: 'stall', diagnostic: 'stalled' };
      // Non-stall stream error: degrade safely (daemon retries next tick).
      return {
        kind: 'result',
        result: { status: 'in_progress', summary: `runner error: ${scrub((e as Error).message)}` },
      };
    } finally {
      if (watchdog) clearTimeout(watchdog);
    }

    if (stalled) return { kind: 'stall', diagnostic: 'stalled' };
    return { kind: 'result', result: parseAgentResult(lines, res.code) };
  }
}

/** Cold-session argv. No --resume/--continue ever (every run is cold, §2/§8). */
export function buildClaudeArgs(input: RunnerInput): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-turns',
    String(input.claude.maxTurns),
    '--permission-mode',
    input.claude.permissionMode, // honored verbatim — never widened (§13.1)
  ];
}

/** Assemble the stdin payload: operating-protocol prompt body + reconstructed context. */
export function assemblePrompt(input: RunnerInput): string {
  const { issue, mr, recentComments } = input.context;
  const ctx = {
    issue: { iid: issue.iid, title: issue.title, body: issue.body, webUrl: issue.webUrl },
    mr: mr ? { iid: mr.iid, description: mr.description, isDraft: mr.isDraft } : null,
    recentComments: recentComments.map((c) => ({
      author: c.author.username,
      body: c.body,
      at: c.createdAt,
    })),
  };
  return `${input.promptBody}\n\n--- CONTEXT (reconstructed from GitLab) ---\n${JSON.stringify(ctx, null, 2)}\n`;
}

interface StreamLine {
  type?: string;
  subtype?: string;
  result?: unknown;
  is_error?: boolean;
}

/**
 * Extract the §10 status from the terminal `type:"result"` line. The agent emits
 * `{status, summary}` in its final message text (§9/§10), which lands in the result
 * object's `result` string. Any failure to find a valid status → safe `in_progress`.
 */
export function parseAgentResult(lines: string[], exitCode: number): AgentResult {
  const objs = lines.map(tryParse).filter((o): o is StreamLine => o !== null);
  const resultLine = [...objs].reverse().find((o) => o.type === 'result');

  if (!resultLine) {
    return { status: 'in_progress', summary: `no result line (exit ${exitCode}); will retry` };
  }
  const status = extractStatus(resultLine.result);
  if (!status) {
    return {
      status: 'in_progress',
      summary: 'result line had no parseable {status} block; will retry',
    };
  }
  return status;
}

function extractStatus(result: unknown): AgentResult | null {
  if (typeof result !== 'string') return null;
  // Try the whole field as JSON, then the last {...} block mentioning "status".
  const candidates: string[] = [result];
  const matches = result.match(/\{[^{}]*"status"[^{}]*\}/g);
  if (matches) candidates.push(...matches.reverse());
  for (const c of candidates) {
    const obj = tryParse(c) as { status?: unknown; summary?: unknown } | null;
    if (obj && isAgentStatus(obj.status)) {
      return { status: obj.status, summary: typeof obj.summary === 'string' ? obj.summary : '' };
    }
  }
  return null;
}

function isAgentStatus(s: unknown): s is AgentStatus {
  return s === 'done' || s === 'needs_input' || s === 'in_progress';
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Best-effort scrub of obvious token shapes from diagnostics (defense in depth). */
function scrub(s: string): string {
  return s.replace(/\b(glpat-|gh[pousr]_)[A-Za-z0-9_-]+/g, '$1***');
}
