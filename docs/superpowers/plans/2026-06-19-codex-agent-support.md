# Codex Agent Backend Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the maestro daemon run OpenAI's Codex CLI as an alternative coding agent, selected daemon-globally via `maestro.config.yaml`, with Claude remaining the default and behaviourally unchanged.

**Architecture:** Extract the agent-agnostic machinery currently fused into `claude-runner.ts` — the stall watchdog / retry loop / env-scrub / `Exec.stream` plumbing (→ `run-cli.ts`), the prompt + status contract (→ `prompt.ts`), and the `{status}` scanner + rate-limit detection (→ `agent-status.ts`). Each agent becomes a small `AgentCli` spec (`command`, `args`, `parse`) delegating to `runCli`. A factory in `daemon.ts` picks the runner from `config.defaults.agent.kind`. `RunnerInput` is **not** renamed: it keeps its `claude` block (already carries `command`/`permissionMode`/`stallTimeoutMs` that both agents need); only the resolved binary changes, computed from a new `ExecutorContext.agent` field.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Zod (config/workflow schemas), Vitest, Biome. Codex CLI: `codex exec - --json` (prompt on stdin via the `-` sentinel; JSONL `ThreadEvent` stream; final answer = last `item.completed` `agent_message`).

**Commands:** Single test file: `pnpm exec vitest run packages/core/test/<file>.test.ts`. Full suite: `pnpm test`. Types: `pnpm -r typecheck`. Lint: `pnpm lint`.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `packages/core/src/contracts/config-schema.ts` | `defaults.agent` selection | Modify |
| `packages/core/src/runner/agent-status.ts` | `{status}` scanner, rate-limit detect, scrub (agent-agnostic) | **Create** (moved out of claude-runner) |
| `packages/core/src/runner/prompt.ts` | `assemblePrompt` + `STATUS_CONTRACT` (agent-agnostic) | **Create** (moved) |
| `packages/core/src/runner/run-cli.ts` | `runCli` core: watchdog, retry, env-scrub, stream, rate-limit-on-error | **Create** (moved) |
| `packages/core/src/runner/claude-runner.ts` | Claude `AgentCli` spec: `buildClaudeArgs` + stream-json `parseAgentResult` | Shrink + re-export |
| `packages/core/src/runner/codex-runner.ts` | Codex `AgentCli` spec: `buildCodexArgs` + `parseCodexResult` | **Create** |
| `packages/core/src/runtime.ts` | barrel export | Add codex-runner export |
| `packages/core/src/preflight/check-binaries.ts` | require the selected agent's binary | Modify |
| `packages/core/src/daemon/executor.ts` | `ExecutorContext.agent` + command resolution | Modify |
| `packages/cli/src/daemon.ts` | runner factory + `ctx.agent` wiring | Modify |
| `maestro.config.example.yaml` | document `defaults.agent` | Modify |

---

## Task 1: Config schema — `defaults.agent` selection

**Files:**
- Modify: `packages/core/src/contracts/config-schema.ts:22-39` (inside `defaults`)
- Modify: `maestro.config.example.yaml`
- Test: `packages/core/test/load-config.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/core/test/load-config.test.ts` (after the B0b block, ~line 36):

```ts
describe('B0c — defaults.agent selection (codex support)', () => {
  it('defaults to the claude agent with no command override', () => {
    const r = parseConfig(sample);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.defaults.agent.kind).toBe('claude');
      expect(r.value.defaults.agent.command).toBeUndefined();
    }
  });

  it('parses kind: codex and a command override', () => {
    const yaml = `
defaults:
  bot_user: maestro-bot
  agent:
    kind: codex
    command: /opt/bin/codex
forges:
  github:
    host: github.com
    token_env: T
repos: []
`;
    const r = parseConfig(yaml);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.defaults.agent.kind).toBe('codex');
      expect(r.value.defaults.agent.command).toBe('/opt/bin/codex');
    }
  });

  it('rejects an unknown agent kind', () => {
    const yaml = `
defaults:
  bot_user: b
  agent:
    kind: hermes
forges: {}
repos: []
`;
    expect(parseConfig(yaml).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/core/test/load-config.test.ts`
Expected: FAIL — `defaults.agent` is undefined / `agent.kind` not a property.

- [ ] **Step 3: Add the schema field**

In `packages/core/src/contracts/config-schema.ts`, inside the `defaults` object (after the `workspaces` block at line 38, before the closing `}),` at line 39), add:

```ts
      // Which coding agent the daemon runs (daemon-global, #codex). 'claude' (default)
      // or 'codex' (OpenAI Codex CLI). `command` overrides the binary/path; absent →
      // the kind name. Per-repo WORKFLOW.md keeps its `claude:` block for tuning
      // (stall_timeout/max_turns); max_turns/permission_mode are claude-only and ignored
      // under codex (codex exec has no turn cap; it uses --sandbox instead).
      agent: z
        .object({
          kind: z.enum(['claude', 'codex']).default('claude'),
          command: z.string().optional(),
        })
        .default({}),
```

Then add an exported type alias after the `MaestroConfig` interface (after line 65):

```ts
/** Daemon-global agent selection (config-schema.ts). */
export type AgentSelection = _RawConfig['defaults']['agent'];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/core/test/load-config.test.ts`
Expected: PASS (all three new cases + existing B0/B1/B2 still green).

- [ ] **Step 5: Document in the example config**

In `maestro.config.example.yaml`, under `defaults:`, add (place near `concurrency`):

```yaml
  # Coding agent the daemon runs (daemon-global). 'claude' (default) or 'codex'.
  # `command` overrides the binary/path; defaults to the kind name.
  agent:
    kind: claude
```

- [ ] **Step 6: Run the load-config test again (example must still parse)**

Run: `pnpm exec vitest run packages/core/test/load-config.test.ts`
Expected: PASS — the B0 "parses the sample config" case still passes with the new `agent` block present.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/contracts/config-schema.ts packages/core/test/load-config.test.ts maestro.config.example.yaml
git commit -m "Add daemon-global agent selection to config schema"
```

---

## Task 2: Extract the shared runner core (refactor; no behaviour change)

This is a pure move. The **regression guard is the existing `claude-runner.test.ts`** — it imports `ClaudeRunner`, `STATUS_CONTRACT`, `assemblePrompt`, `buildClaudeArgs`, `detectRateLimit`, `parseAgentResult`, `topLevelJsonObjects` from `claude-runner.js` and must stay green **unedited**.

**Files:**
- Create: `packages/core/src/runner/agent-status.ts`
- Create: `packages/core/src/runner/prompt.ts`
- Create: `packages/core/src/runner/run-cli.ts`
- Modify: `packages/core/src/runner/claude-runner.ts` (shrink to the Claude spec + re-exports)
- Test (guard, do not edit): `packages/core/test/claude-runner.test.ts`

- [ ] **Step 1: Run the existing claude-runner tests to confirm the green baseline**

Run: `pnpm exec vitest run packages/core/test/claude-runner.test.ts`
Expected: PASS (this is the snapshot we must preserve through the move).

- [ ] **Step 2: Create `agent-status.ts`** (move the scanner + rate-limit + scrub verbatim)

Create `packages/core/src/runner/agent-status.ts`:

```ts
// Agent-agnostic response parsing (§10). Given candidate final-message texts from ANY
// agent CLI, find the last valid {status,summary} block; detect the usage/rate-limit
// signal (#47); scrub token shapes from diagnostics. No CLI specifics live here — the
// per-agent transcript→text mapping is the runner's job.

import type { AgentResult, AgentStatus } from '../contracts/index.js';

/** Map extractStatus over candidate texts in stream order; the LAST valid block wins
 *  (done-safe precedence: a correctly-emitted final status beats an earlier one). */
export function pickLastStatus(texts: string[]): AgentResult | null {
  let status: AgentResult | null = null;
  for (const t of texts) {
    const found = extractStatus(t);
    if (found) status = found;
  }
  return status;
}

export function extractStatus(result: unknown): AgentResult | null {
  if (typeof result !== 'string') return null;
  // Newest balanced top-level {...} first; a brace scanner that ignores braces inside
  // JSON strings survives a multi-line `mrDescription` with markdown braces (#48).
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
  const rev = obj.review as { verdict?: unknown; findings?: unknown } | undefined;
  if (rev && (rev.verdict === 'pass' || rev.verdict === 'fail')) {
    out.review = {
      verdict: rev.verdict,
      ...(typeof rev.findings === 'string' && rev.findings.trim()
        ? { findings: rev.findings }
        : {}),
    };
  }
  return out;
}

/** Every balanced top-level `{...}` substring, document order; string-aware (#48). */
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

export function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Recognize a CLI usage/rate-limit failure in transcript or stderr text (#47). Carries
 *  the reset time when present (seconds normalized to epoch ms). Wording is matched
 *  defensively so both Claude ("usage limit reached|<epoch>") and Codex variants hit. */
export function detectRateLimit(text: string): { resetAt?: number } | null {
  const m = text.match(/usage limit reached\|(\d{9,13})/i);
  if (m?.[1]) {
    const n = Number(m[1]);
    return { resetAt: n < 1e12 ? n * 1000 : n };
  }
  if (/usage limit reached|rate[ -]?limit(ed| exceeded)?/i.test(text)) return {};
  return null;
}

/** Best-effort scrub of obvious token shapes from diagnostics (defense in depth). */
export function scrub(s: string): string {
  return s.replace(/\b(glpat-|gh[pousr]_)[A-Za-z0-9_-]+/g, '$1***');
}
```

- [ ] **Step 3: Create `prompt.ts`** (move `assemblePrompt` + `STATUS_CONTRACT` verbatim)

Create `packages/core/src/runner/prompt.ts`. Move the bodies of `assemblePrompt` (claude-runner.ts:143-163) and `STATUS_CONTRACT` (claude-runner.ts:165-199) **unchanged**:

```ts
// The agent-facing half of the §10 contract: the stdin payload (operating-protocol
// prompt + reconstructed forge context) and the status contract appended to EVERY
// prompt. Agent-agnostic — both the Claude and Codex runners send this exact payload.

import type { RunnerInput } from '../contracts/index.js';

/** Assemble the stdin payload: operating-protocol prompt body + reconstructed context. */
export function assemblePrompt(input: RunnerInput): string {
  const { issue, mr, recentComments } = input.context;
  const ctx = {
    issue: issue
      ? { iid: issue.iid, title: issue.title, body: issue.body, webUrl: issue.webUrl }
      : null,
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
  'Summaries are posted to humans on the forge (#25): write readable Markdown — short ' +
  'paragraphs, bullet lists where they aid scanning, never one wall of text. When ' +
  'needs_input asks more than one question, NUMBER the questions (1., 2., …) so each ' +
  'can be answered by number.\n' +
  '\n' +
  'To make your PLAN VISIBLE (the daemon, not you, writes it to the forge), add these ' +
  'OPTIONAL fields to that same JSON object:\n' +
  '  "mrDescription": "<full Markdown for the MR description: a detailed plan AND a ' +
  '`- [ ]` / `- [x]` checkbox todo list>"\n' +
  '      The MR description is your DURABLE plan/todo — it is fed back to you next session. ' +
  'Re-emit it each session with the boxes you have finished ticked (`- [x]`). Keep the ' +
  '`Closes #<issue>` line so the merge auto-closes the issue.\n' +
  '  "planComment": "<a short plan summary>"\n' +
  '      Posted ONCE as an issue comment on your first planning session. Omit it afterwards.\n' +
  '\n' +
  'When you are the REVIEW agent (#29): judge the diff against the plan and add\n' +
  '  "review": {"verdict":"pass"}                                — no blocking findings\n' +
  '  "review": {"verdict":"fail","findings":"<numbered list>"}   — blocking findings; they are\n' +
  '                                                                posted for the next implementation\n' +
  '                                                                session, so be specific and actionable.';
```

- [ ] **Step 4: Create `run-cli.ts`** (move the watchdog/retry machinery)

Create `packages/core/src/runner/run-cli.ts`:

```ts
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

type Attempt =
  | { kind: 'result'; result: AgentResult }
  | { kind: 'stall'; diagnostic: string };

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
```

- [ ] **Step 5: Rewrite `claude-runner.ts` as the Claude spec + re-exports**

Replace the **entire** contents of `packages/core/src/runner/claude-runner.ts` with:

```ts
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
  parse: (lines, exitCode, stderr) => parseAgentResult(lines, exitCode, stderr),
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
  return { status: 'in_progress', summary: 'no parseable {status} block in transcript; will retry' };
}

/** Concatenated text of an assistant message's text content blocks (transcript scan). */
function assistantText(o: StreamLine): string {
  if (o.type !== 'assistant' || !Array.isArray(o.message?.content)) return '';
  return o.message.content
    .filter((b): b is { type?: string; text: string } => typeof b?.text === 'string')
    .map((b) => b.text)
    .join('\n');
}
```

- [ ] **Step 6: Run the regression guard — existing claude tests must pass unedited**

Run: `pnpm exec vitest run packages/core/test/claude-runner.test.ts`
Expected: PASS — every RUN-1..RUN-7 case green with no test edits.

- [ ] **Step 7: Typecheck the core package**

Run: `pnpm -r typecheck`
Expected: PASS (no missing exports; `runtime.ts`'s `export * from './runner/claude-runner.js'` still surfaces the same names).

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/runner/agent-status.ts packages/core/src/runner/prompt.ts packages/core/src/runner/run-cli.ts packages/core/src/runner/claude-runner.ts
git commit -m "Extract shared runner core from ClaudeRunner"
```

---

## Task 3: CodexRunner

Codex emits a JSONL `ThreadEvent` stream under `--json`. The agent's prose lands in
`item.completed` events whose item is an `agent_message`. The exact field nesting of the
experimental `--json` schema is pinned by fixtures here; **verify against a real
`codex exec --json` capture during execution** (run `codex exec - --json --skip-git-repo-check <<<'say hi'`
in a scratch dir and confirm the `agent_message` shape) and adjust `extractCodexTexts` +
the fixture builder together if the real events differ.

**Files:**
- Create: `packages/core/src/runner/codex-runner.ts`
- Create: `packages/core/test/codex-runner.test.ts`
- Modify: `packages/core/src/runtime.ts` (barrel export)

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/codex-runner.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { RunnerInput } from '../src/contracts/index.js';
import {
  CodexRunner,
  buildCodexArgs,
  extractCodexTexts,
  parseCodexResult,
} from '../src/runner/codex-runner.js';
import { FakeStreamExec, type StreamScript } from './helpers/fake-stream-exec.js';

function input(over: Partial<RunnerInput> = {}): RunnerInput {
  return {
    workspaceDir: '/ws/group__repo/42',
    promptBody: '# Agent operating protocol\nwork the next item',
    context: {
      issue: {
        iid: 42,
        id: '9042',
        title: 'Add OAuth',
        body: 'do it',
        state: 'open',
        assignees: [],
        labels: [],
        author: { username: 'r', id: '2' },
        webUrl: 'u',
      },
      recentComments: [],
    },
    claude: { command: 'codex', maxTurns: 40, permissionMode: 'bypassPermissions' },
    ...over,
  };
}

const fast = { stallTimeoutMs: 40, maxStallRetries: 1 };
const THREAD_STARTED = JSON.stringify({ type: 'thread.started', thread_id: 't1' });
const TURN_COMPLETED = JSON.stringify({ type: 'turn.completed', usage: {} });

/** A codex `--json` agent_message item.completed line carrying the given text. */
function agentMsg(text: string, id = 'item_0'): string {
  return JSON.stringify({ type: 'item.completed', item: { id, type: 'agent_message', text } });
}

function run(script: StreamScript, over: Partial<RunnerInput> = {}) {
  const exec = new FakeStreamExec(script);
  const runner = new CodexRunner(exec, fast);
  return { exec, result: runner.run(input(over)) };
}

describe('CODEX-1 — parse status from the final agent_message', () => {
  it('parses done', async () => {
    const { result } = run({
      lines: [
        THREAD_STARTED,
        agentMsg('Implemented it.\n{"status":"done","summary":"Implemented OAuth"}'),
        TURN_COMPLETED,
      ],
    });
    expect(await result).toEqual({ status: 'done', summary: 'Implemented OAuth' });
  });

  it('parses needs_input', async () => {
    const { result } = run({
      lines: [agentMsg('{"status":"needs_input","summary":"Which DB?"}'), TURN_COMPLETED],
    });
    expect((await result).status).toBe('needs_input');
  });

  it('takes the LAST agent_message when several carry a status', async () => {
    const { result } = run({
      lines: [
        agentMsg('{"status":"in_progress","summary":"early"}', 'a'),
        agentMsg('{"status":"done","summary":"final"}', 'b'),
        TURN_COMPLETED,
      ],
    });
    expect(await result).toEqual({ status: 'done', summary: 'final' });
  });

  it('carries plan-channel fields and survives a multi-line mrDescription with braces', async () => {
    const mrDescription = '## Plan\n```ts\nconst x = { a: 1 };\n```\n- [ ] do it';
    const { result } = run({
      lines: [agentMsg(JSON.stringify({ status: 'done', summary: 'ok', mrDescription })), TURN_COMPLETED],
    });
    const r = await result;
    expect(r.status).toBe('done');
    expect(r.mrDescription).toBe(mrDescription);
  });
});

describe('CODEX-2 — argv + stdin (cold exec)', () => {
  it('builds `exec - --json --skip-git-repo-check` with the bypass flag; prompt on stdin', async () => {
    const { exec, result } = run({ lines: [agentMsg('{"status":"done","summary":"ok"}'), TURN_COMPLETED] });
    await result;
    const call = exec.calls[0];
    expect(call?.cmd).toBe('codex');
    expect(call?.args).toEqual([
      'exec',
      '-',
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
    ]);
    expect(call?.opts.cwd).toBe('/ws/group__repo/42');
    expect(call?.opts.input).toContain('# Agent operating protocol'); // prompt on stdin
    expect(call?.opts.input).toContain('HOW TO REPORT'); // §10 contract appended
  });

  it('a non-bypass permission mode maps to --sandbox workspace-write', () => {
    const i = input();
    i.claude.permissionMode = 'acceptEdits';
    const args = buildCodexArgs(i);
    expect(args).toContain('--sandbox');
    expect(args).toContain('workspace-write');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });
});

describe('CODEX-3 — degrade safely', () => {
  it('no agent_message → safe in_progress', async () => {
    const { result } = run({ lines: [THREAD_STARTED, TURN_COMPLETED], code: 0 });
    const r = await result;
    expect(r.status).toBe('in_progress');
    expect(r.summary).toMatch(/no agent message/);
  });

  it('agent_message without a status block → safe in_progress', async () => {
    const { result } = run({ lines: [agentMsg('I finished but forgot the status'), TURN_COMPLETED] });
    const r = await result;
    expect(r.status).toBe('in_progress');
    expect(r.summary).toMatch(/no parseable/);
  });

  it('extractCodexTexts returns agent_message texts in order, ignoring other items', () => {
    const lines = [
      THREAD_STARTED,
      JSON.stringify({ type: 'item.completed', item: { id: 'c', type: 'command_execution', text: 'ls' } }),
      agentMsg('first', 'a'),
      agentMsg('second', 'b'),
      'not json {{{',
    ];
    expect(extractCodexTexts(lines)).toEqual(['first', 'second']);
  });

  it('a usage/rate-limit message with no status marks the result for backoff (#47)', () => {
    const r = parseCodexResult(
      [JSON.stringify({ type: 'error', message: 'rate limit exceeded' })],
      1,
    );
    expect(r.status).toBe('in_progress');
    expect(r.rateLimit).toEqual({});
  });
});

describe('CODEX-4 — stall watchdog (inherited from runCli)', () => {
  it('two stalls → in_progress "stalled", two attempts made', async () => {
    const exec = new FakeStreamExec({ lines: [THREAD_STARTED], hang: true });
    const r = await new CodexRunner(exec, fast).run(input());
    expect(r).toEqual({ status: 'in_progress', summary: 'stalled' });
    expect(exec.calls).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/core/test/codex-runner.test.ts`
Expected: FAIL — `codex-runner.js` does not exist.

- [ ] **Step 3: Create `codex-runner.ts`**

Create `packages/core/src/runner/codex-runner.ts`:

```ts
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
  parse: (lines, exitCode, stderr) => parseCodexResult(lines, exitCode, stderr),
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
    return { status: 'in_progress', summary: `no agent message in codex output (exit ${exitCode}); will retry` };
  }
  return { status: 'in_progress', summary: 'no parseable {status} block in transcript; will retry' };
}
```

- [ ] **Step 4: Export from the barrel**

In `packages/core/src/runtime.ts`, after the line `export * from './runner/claude-runner.js';` (line 10), add:

```ts
export * from './runner/codex-runner.js';
```

- [ ] **Step 5: Run the codex tests**

Run: `pnpm exec vitest run packages/core/test/codex-runner.test.ts`
Expected: PASS (all CODEX-1..CODEX-4 cases).

- [ ] **Step 6: Typecheck**

Run: `pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/runner/codex-runner.ts packages/core/test/codex-runner.test.ts packages/core/src/runtime.ts
git commit -m "Add CodexRunner agent backend"
```

---

## Task 4: Resolve the agent command in the executor

`RunnerInput.claude.command` must be the **selected** agent's binary. Resolution rule:
explicit `defaults.agent.command` wins; else the kind name; else (claude only) the
per-repo `workflow.claude.command` back-compat override.

**Files:**
- Modify: `packages/core/src/daemon/executor.ts` (`ExecutorContext` ~line 73-87; `buildRunnerInput` line 784-789; `buildMrRunnerInput` line 844-849)
- Test: `packages/core/test/daemon-executor.test.ts`

- [ ] **Step 1: Add the `agent` field to `ExecutorContext`**

In `packages/core/src/daemon/executor.ts`, import `AgentSelection` — add it to the existing import from `../contracts/index.js` (where `Runner`, `RunnerInput` are imported, ~line 31):

```ts
  type AgentSelection,
```

Then in `interface ExecutorContext` (after `workflow: WorkflowFrontMatter;` at line 82) add:

```ts
  agent: AgentSelection; // daemon-global agent selection (#codex); resolves RunnerInput command
```

- [ ] **Step 2: Add the resolver and use it in both builders**

In `packages/core/src/daemon/executor.ts`, add this helper just above `buildRunnerInput` (line 768):

```ts
/** The selected agent's binary: explicit override → kind name → (claude) WORKFLOW override. */
function resolveAgentCommand(ctx: ExecutorContext): string {
  if (ctx.agent.command) return ctx.agent.command;
  return ctx.agent.kind === 'claude' ? ctx.workflow.claude.command : ctx.agent.kind;
}
```

In `buildRunnerInput`, change line 785 from `command: ctx.workflow.claude.command,` to:

```ts
      command: resolveAgentCommand(ctx),
```

In `buildMrRunnerInput`, change line 845 from `command: ctx.workflow.claude.command,` to:

```ts
      command: resolveAgentCommand(ctx),
```

- [ ] **Step 3: Find how the executor test builds its context (read before editing)**

Run: `grep -n "agent:\|workflow:\|runner:\|ExecutorContext\|ctx" packages/core/test/daemon-executor.test.ts | head -30`
Purpose: locate the test's `ExecutorContext` fixture so you can add `agent` to it and assert the resolved command. If a shared fixture helper exists under `packages/core/test/helpers/`, edit it there instead.

- [ ] **Step 4: Add a focused test for command resolution**

Add to `packages/core/test/daemon-executor.test.ts` a test that builds the context with `agent: { kind: 'codex' }` and a workflow whose `claude.command` is `'claude'`, runs the dispatch path that calls the runner, and asserts the runner received `command: 'codex'`. Use the existing scripted-runner/context fixture in that file (discovered in Step 3) — add `agent: { kind: 'claude' }` to the base fixture so existing cases keep `command: 'claude'`, and override to `{ kind: 'codex' }` in the new case. Concretely, if the file uses a `makeCtx(over)` helper:

```ts
it('resolves the runner command from the daemon-global agent kind (#codex)', async () => {
  // scripted runner records the RunnerInput it receives
  const seen: RunnerInput[] = [];
  const runner = { run: async (i: RunnerInput) => (seen.push(i), { status: 'in_progress', summary: 'x' }) };
  const ctx = makeCtx({ runner, agent: { kind: 'codex' } });
  await dispatchImplement(ctx); // whatever the file's existing dispatch entry point is
  expect(seen[0]?.claude.command).toBe('codex');
});
```

Match the actual helper/dispatch names found in Step 3 (do not invent `makeCtx`/`dispatchImplement` if the file names them differently — use the real ones).

- [ ] **Step 5: Run the executor test to verify it fails, then add `agent` to every context fixture**

Run: `pnpm exec vitest run packages/core/test/daemon-executor.test.ts`
Expected: FAIL first on a TypeScript/`undefined` error because existing fixtures lack the now-required `agent` field. Add `agent: { kind: 'claude' }` to the base fixture (and any other `ExecutorContext` literals the suite constructs) so existing cases stay green and resolve `command` to the workflow's `claude.command` as before.

- [ ] **Step 6: Run the executor test to verify it passes**

Run: `pnpm exec vitest run packages/core/test/daemon-executor.test.ts`
Expected: PASS (existing cases + the new codex-command case).

- [ ] **Step 7: Typecheck the whole repo (catches other ExecutorContext constructors)**

Run: `pnpm -r typecheck`
Expected: FAIL listing every other place that builds an `ExecutorContext`/`TickContext` without `agent` (notably `packages/cli/src/daemon.ts` — fixed in Task 6, and possibly other test fixtures). Fix any **test** fixtures here by adding `agent: { kind: 'claude' }`; leave `daemon.ts` for Task 6. Re-run until only the `daemon.ts` site remains (or it too is clean if you prefer to jump to Task 6 first).

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/daemon/executor.ts packages/core/test/daemon-executor.test.ts
git commit -m "Resolve runner command from the daemon-global agent kind"
```

---

## Task 5: Preflight requires the selected agent's binary

**Files:**
- Modify: `packages/core/src/preflight/check-binaries.ts:23-43`
- Test: `packages/core/test/check-binaries.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/core/test/check-binaries.test.ts`, replace the `requiredBinaries` describe block (lines 72-95) with:

```ts
describe('requiredBinaries', () => {
  const base = (
    forges: MaestroConfig['forges'],
    agent?: { kind: 'claude' | 'codex'; command?: string },
  ): MaestroConfig =>
    ({ forges, defaults: agent ? { agent } : undefined }) as unknown as MaestroConfig;

  it('defaults to git + claude when no agent is configured, plus configured forges', () => {
    const gitlabOnly = requiredBinaries(base({ gitlab: { host: 'gitlab.com', token_env: 'X' } }));
    expect(gitlabOnly.map((r) => r.bin)).toEqual(['git', 'claude', 'glab']);

    const githubOnly = requiredBinaries(base({ github: { host: 'github.com', token_env: 'Y' } }));
    expect(githubOnly.map((r) => r.bin)).toEqual(['git', 'claude', 'gh']);
  });

  it('requires codex instead of claude when agent.kind is codex', () => {
    const r = requiredBinaries(
      base({ github: { host: 'github.com', token_env: 'Y' } }, { kind: 'codex' }),
    );
    expect(r.map((x) => x.bin)).toEqual(['git', 'codex', 'gh']);
  });

  it('requires the explicit command override binary', () => {
    const r = requiredBinaries(
      base({ github: { host: 'github.com', token_env: 'Y' } }, { kind: 'codex', command: '/opt/codex' }),
    );
    expect(r.map((x) => x.bin)).toEqual(['git', '/opt/codex', 'gh']);
  });

  it('allBinaries lists the full superset including codex', () => {
    expect(allBinaries().map((r) => r.bin)).toEqual(['git', 'claude', 'codex', 'glab', 'gh']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/core/test/check-binaries.test.ts`
Expected: FAIL — `requiredBinaries` still hardcodes `claude`; `allBinaries` lacks `codex`.

- [ ] **Step 3: Implement agent-aware preflight**

In `packages/core/src/preflight/check-binaries.ts`, replace `allBinaries` (lines 23-30) with:

```ts
export function allBinaries(): BinaryReq[] {
  return [
    { bin: 'git', reason: 'clone and branch per-issue workspaces' },
    { bin: 'claude', reason: 'run the Claude coding agent headless' },
    { bin: 'codex', reason: 'run the Codex coding agent headless' },
    { bin: 'glab', reason: 'reach the GitLab API' },
    { bin: 'gh', reason: 'reach the GitHub API' },
  ];
}
```

Replace `requiredBinaries` (lines 35-43) with:

```ts
export function requiredBinaries(config: MaestroConfig): BinaryReq[] {
  // Optional-chained: a no-defaults config (some test fixtures) → the claude default.
  const agent = config.defaults?.agent;
  const agentBin = agent?.command ?? agent?.kind ?? 'claude';
  const reqs: BinaryReq[] = [
    { bin: 'git', reason: 'clone and branch per-issue workspaces' },
    { bin: agentBin, reason: 'run the coding agent headless' },
  ];
  if (config.forges.gitlab) reqs.push({ bin: 'glab', reason: 'reach the GitLab API' });
  if (config.forges.github) reqs.push({ bin: 'gh', reason: 'reach the GitHub API' });
  return reqs;
}
```

Update the `BinaryReq.bin` doc comment (line 11) to read: `bin: string; // 'git' | 'glab' | 'gh' | 'claude' | 'codex'`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/core/test/check-binaries.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/preflight/check-binaries.ts packages/core/test/check-binaries.test.ts
git commit -m "Require the selected agent binary in preflight"
```

---

## Task 6: Wire the runner factory into the daemon

**Files:**
- Modify: `packages/cli/src/daemon.ts` (imports line 43-58; runner construction line 158-168; context literal line 226-241)

- [ ] **Step 1: Import CodexRunner**

In `packages/cli/src/daemon.ts`, add `CodexRunner,` to the second import block (the one containing `ClaudeRunner,` at line 44), keeping alphabetical order:

```ts
  ClaudeRunner,
  CodexRunner,
```

- [ ] **Step 2: Replace the hardcoded ClaudeRunner with a factory**

Replace lines 158-168 (`const runner = new ClaudeRunner(exec, { ... });`) with:

```ts
  const agentSel = config.defaults.agent;
  const runnerCfg = {
    secretEnvKeys,
    // Surface stall kills (otherwise invisible) so a false-positive kill during a long
    // no-event tool call — e.g. a cold `pnpm install` — is diagnosable in the journal.
    onStall: ({ attempt, willRetry, timeoutMs }: { attempt: number; willRetry: boolean; timeoutMs: number }) =>
      log.warn('runner: stall watchdog fired — no agent output, killed', {
        attempt,
        willRetry,
        timeoutMs,
      }),
  };
  const runner =
    agentSel.kind === 'codex'
      ? new CodexRunner(exec, runnerCfg)
      : new ClaudeRunner(exec, runnerCfg);
```

- [ ] **Step 3: Pass the agent selection into the context**

In the `buildUnits` context literal (line 226-241), add after `workflow: cell.frontMatter,` (line 235):

```ts
        agent: agentSel,
```

- [ ] **Step 4: Typecheck the repo**

Run: `pnpm -r typecheck`
Expected: PASS — `daemon.ts` now satisfies the `agent`-bearing `ExecutorContext`; the `StallInfo`-shaped inline type matches `runCli`'s `onStall`.

- [ ] **Step 5: Lint**

Run: `pnpm lint`
Expected: PASS (Biome clean; no unused imports — `ClaudeRunner` and `CodexRunner` are both referenced).

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/daemon.ts
git commit -m "Select the daemon runner from the configured agent"
```

---

## Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`
Expected: PASS — all packages green, including the new `codex-runner.test.ts` and unchanged `claude-runner.test.ts`.

- [ ] **Step 2: Typecheck every package**

Run: `pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 3: Lint**

Run: `pnpm lint`
Expected: PASS.

- [ ] **Step 4: Manual smoke against a real Codex CLI (if `codex` is installed)**

Confirm the `--json` event shape assumed by `extractCodexTexts` matches reality:

Run:
```bash
cd $(mktemp -d) && git init -q && printf 'Reply with the single line {"status":"done","summary":"hi"} and nothing else.' \
  | codex exec - --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox | tail -20
```
Expected: a JSONL stream containing an `item.completed` event whose `item.type` is `agent_message` and whose `item.text` carries the `{status:"done",...}` line. If the field names differ (experimental schema drift), update `extractCodexTexts` + the test fixture's `agentMsg()` builder together and re-run Task 3 Step 5. If `codex` is not installed, note that this step was skipped — the unit fixtures still pin the assumed shape.

- [ ] **Step 5: Final commit if Step 4 required adjustments**

```bash
git add -p   # stage only the codex extraction/fixture changes
git commit -m "Align codex event extraction with real --json output"
```

---

## Self-Review

**Spec coverage:**
- Daemon-global selection → Task 1 (schema) + Task 6 (factory). ✓
- Shared core + per-agent spec → Task 2 (`run-cli`/`agent-status`/`prompt`) + Tasks 3/the Claude spec. ✓
- Codex invocation (`exec - --json`, stdin, bypass/sandbox parity, last AgentMessage) → Task 3. ✓
- `max_turns` ignored under codex → documented in Task 3's `codex-runner.ts` header and the schema comment in Task 1. ✓
- Preflight requires `claude` **or** `codex`; `allBinaries` lists both → Task 5. ✓
- Claude path unchanged → Task 2's regression guard (unedited `claude-runner.test.ts`). ✓
- `claude:` WORKFLOW block name kept; `RunnerInput` not renamed → no task touches either (refinement vs. the spec's original "generalize `RunnerInput`"; the spec is updated to match). ✓
- Rate-limit detection extended for codex → `detectRateLimit` already matches generic "rate limit"/"usage limit" wording (Task 2 comment), asserted in Task 3 CODEX-3. ✓

**Placeholder scan:** No TBD/TODO. The one runtime-verification dependency (codex `--json` field names) is an explicit Task 7 Step 4 check with a named remediation, not a blank. Task 4 Steps 3-4 deliberately read the real fixture/dispatch names before editing rather than inventing them — the example code flags `makeCtx`/`dispatchImplement` as placeholders to replace.

**Type consistency:** `AgentCli` (`command`/`args`/`parse`), `RunCliConfig` (`stallTimeoutMs`/`maxStallRetries`/`secretEnvKeys`/`onStall`), and `StallInfo` (`attempt`/`willRetry`/`timeoutMs`) are defined once in `run-cli.ts` and consumed identically in `claude-runner.ts`, `codex-runner.ts`, and `daemon.ts`. `AgentSelection` (`{ kind: 'claude'|'codex'; command?: string }`) is defined in `config-schema.ts` and consumed in `executor.ts` (`ExecutorContext.agent`) and `daemon.ts`. `extractCodexTexts`/`parseCodexResult`/`buildCodexArgs` names match between `codex-runner.ts` and its test. `pickLastStatus`/`detectRateLimit`/`tryParse`/`topLevelJsonObjects`/`scrub` names match between `agent-status.ts` and both runners.
