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
  /** Env var NAMES scrubbed from the agent's environment — the forge token_env(s).
   *  §13.1: the agent must find no forge secret in its workspace env (blast-radius
   *  reduction). The daemon passes the configured token_env names here. */
  secretEnvKeys?: string[];
}

export class ClaudeRunner implements Runner {
  readonly #exec: Exec;
  readonly #stallTimeoutMs: number;
  readonly #maxStallRetries: number;
  readonly #secretEnvKeys: string[];

  constructor(exec: Exec, cfg: ClaudeRunnerConfig = {}) {
    this.#exec = exec;
    this.#stallTimeoutMs = cfg.stallTimeoutMs ?? 120_000;
    this.#maxStallRetries = cfg.maxStallRetries ?? 1;
    this.#secretEnvKeys = cfg.secretEnvKeys ?? [];
  }

  /** The env handed to the agent: inherit the daemon env MINUS the forge secret(s).
   *  Each secret key maps to `undefined`, which NodeExec deletes from the child env. */
  #agentEnv(): Record<string, string | undefined> {
    return Object.fromEntries(this.#secretEnvKeys.map((k) => [k, undefined]));
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
        env: this.#agentEnv(), // scrub the forge token from the agent (§13.1)
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
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-turns',
    String(input.claude.maxTurns),
  ];
  // The agent is headless: there is no human to approve tool calls. `--permission-mode`
  // values other than bypass still gate Bash (git/pnpm), so a non-bypass agent can write
  // files but never commit or run its proof. `bypassPermissions` maps to the flag that
  // actually skips every prompt; safety comes from workspace ISOLATION (§13.1) — the agent
  // runs in a throwaway clone with the forge token scrubbed — not from prompting.
  if (input.claude.permissionMode === 'bypassPermissions') {
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--permission-mode', input.claude.permissionMode); // honored verbatim (§13.1)
  }
  return args;
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
  return (
    `${input.promptBody}\n\n` +
    `--- CONTEXT (reconstructed from the forge) ---\n${JSON.stringify(ctx, null, 2)}\n\n` +
    `--- HOW TO REPORT (required) ---\n${STATUS_CONTRACT}\n`
  );
}

/** The §10 status contract, appended to EVERY prompt so emission never depends on the
 *  per-repo WORKFLOW author getting it right. The daemon consumes only this final line; the
 *  agent has no forge token, so the daemon (not the agent) acts on it. */
export const STATUS_CONTRACT =
  'Make your changes as atomic git commits in this working directory — the daemon pushes ' +
  'them; never push or use the network yourself. You have NO access to the issue or MR ' +
  'beyond the context above: you cannot post comments or edit the MR yourself. You ' +
  'communicate ONLY through your final message: end it with EXACTLY one JSON object on its ' +
  'own line, with nothing after it:\n' +
  '  {"status":"done","summary":"<what you changed>"}          — work complete, hand off for review\n' +
  '  {"status":"needs_input","summary":"<your questions>"}     — you need a human decision; you will be\n' +
  '                                                              marked blocked and the summary is posted to\n' +
  '                                                              them verbatim. Put questions HERE, never in a file.\n' +
  '  {"status":"in_progress","summary":"<where you are>"}      — you ran out of turns; will resume next tick\n' +
  '\n' +
  'To make your PLAN VISIBLE (the daemon, not you, writes it to the forge), add these ' +
  'OPTIONAL fields to that same JSON object:\n' +
  '  "mrDescription": "<full Markdown for the MR description: a detailed plan AND a ' +
  '`- [ ]` / `- [x]` checkbox todo list>"\n' +
  '      The MR description is your DURABLE plan/todo — it is fed back to you next session. ' +
  'Re-emit it each session with the boxes you have finished ticked (`- [x]`). Keep the ' +
  '`Closes #<issue>` line so the merge auto-closes the issue.\n' +
  '  "planComment": "<a short plan summary>"\n' +
  '      Posted ONCE as an issue comment on your first planning session. Omit it afterwards.';

interface StreamLine {
  type?: string;
  subtype?: string;
  result?: unknown;
  is_error?: boolean;
  message?: { content?: Array<{ type?: string; text?: unknown }> };
}

/**
 * Extract the §10 status from the stream-json transcript. The happy path is the
 * terminal `type:"result"` line, whose `result` string is the agent's final message
 * text (§9/§10). But emission is nondeterministic (#4): real Claude sometimes omits
 * the `{status, summary}` block from its LITERAL final message even though it emitted
 * it earlier in the turn. So we scan EVERY assistant message plus the result line in
 * stream order and keep the LAST valid `{status}` block. The result line is last, so
 * a correctly-emitted final status still wins (done-safe — never a false `done` from
 * recovery); earlier assistant messages are the fallback when the final one lacks it.
 * Any failure to find a valid status → safe `in_progress` (daemon re-runs next tick).
 */
export function parseAgentResult(lines: string[], exitCode: number): AgentResult {
  const objs = lines.map(tryParse).filter((o): o is StreamLine => o !== null);
  const resultLine = [...objs].reverse().find((o) => o.type === 'result');

  let status: AgentResult | null = null;
  for (const o of objs) {
    const text = o.type === 'result' ? o.result : assistantText(o);
    const found = extractStatus(text);
    if (found) status = found; // last valid block in stream order wins
  }
  if (status) return status;

  if (!resultLine) {
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

function extractStatus(result: unknown): AgentResult | null {
  if (typeof result !== 'string') return null;
  // Scan for balanced top-level {...} objects (string-aware), newest first. A flat regex
  // can't survive a multi-line `mrDescription` with Markdown braces/newlines (#48); a
  // brace scanner that ignores braces inside JSON strings can.
  for (const span of topLevelJsonObjects(result).reverse()) {
    const obj = tryParse(span) as Record<string, unknown> | null;
    if (obj && isAgentStatus(obj.status)) return toAgentResult(obj);
  }
  return null;
}

/** Build the result, carrying the optional #48 plan-channel fields when present. */
function toAgentResult(obj: Record<string, unknown>): AgentResult {
  const out: AgentResult = {
    status: obj.status as AgentStatus,
    summary: typeof obj.summary === 'string' ? obj.summary : '',
  };
  if (typeof obj.mrDescription === 'string' && obj.mrDescription.trim()) {
    out.mrDescription = obj.mrDescription;
  }
  if (typeof obj.planComment === 'string' && obj.planComment.trim()) {
    out.planComment = obj.planComment;
  }
  return out;
}

/**
 * Return every balanced top-level `{...}` substring, in document order. String-aware:
 * braces and escapes inside JSON string literals don't affect nesting, so a markdown
 * `mrDescription` carrying `{`, `}` or escaped quotes is matched as one object.
 */
export function topLevelJsonObjects(text: string): string[] {
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        spans.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return spans;
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
