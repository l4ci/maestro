# Codex agent backend support

**Date:** 2026-06-19
**Status:** Approved (design)

## Problem

Maestro is hardwired to one coding agent: Claude. The agent backend appears in
five places — the `claude:` WORKFLOW.md block, the `RunnerInput.claude` shape,
`ClaudeRunner`'s argv + stream-json parsing, the hardcoded `new ClaudeRunner` in
`daemon.ts`, and the always-required `claude` binary in preflight. We want to run
OpenAI's Codex CLI (`codex`) as an alternative agent, selected globally for the
daemon.

Hermes was considered and **dropped** — there is no identified `hermes` coding-agent
CLI, so it is out of scope until one is named.

## Goals

- Run `codex` as the daemon's agent, selected via maestro config (daemon-global).
- Reuse every agent-agnostic mechanism: the stall watchdog, retry-once, env-scrub,
  `Exec.stream` plumbing, the `{status,summary}` status contract, and the status
  block scanner — these must exist exactly once.
- Keep the working Claude path behaviourally unchanged (default agent = claude).

## Non-goals (YAGNI)

- Hermes or any third backend.
- Per-repo or per-role agent selection (selection is daemon-global only).
- Codex MCP / app-server mode — we shell `codex exec` like we shell `claude -p`.
- Renaming the `claude:` WORKFLOW.md block (kept for back-compat; renaming breaks
  every existing repo's WORKFLOW.md).

## Key observations

`claude-runner.ts` already splits cleanly into two layers that contain **zero**
Claude specifics and one layer that does:

| Layer | Current location | Claude-specific? |
|-------|------------------|------------------|
| Run machinery: env-scrub, stall watchdog, retry-once, `Exec.stream`, rate-limit-on-spawn-error | `claude-runner.ts:54–118` | No |
| Status extraction: `topLevelJsonObjects` / `extractStatus` / `toAgentResult` / `detectRateLimit` / `isAgentStatus` | `claude-runner.ts:277–346` | No |
| Argv builder (`buildClaudeArgs`) + transcript→final-text (`parseAgentResult` stream-json walk) | `claude-runner.ts:120–275` | **Yes** |

The status contract text (`STATUS_CONTRACT`) is also agent-agnostic — it instructs
the model to emit a final `{status,summary}` JSON line; nothing about it is Claude.

## Design — shared core + per-agent spec

An agent backend is reduced to a small **spec**:

```ts
interface AgentSpec {
  command: string;                       // resolved binary
  buildArgs(input: RunnerInput): string[];
  extractFinalText(lines: string[]): string[]; // candidate final-message texts, stream order
}
```

`runCli(spec, input, cfg)` owns all the run machinery (today's `ClaudeRunner.run` +
`#attempt`). It streams lines (resetting the watchdog per line), then hands the
collected lines to `spec.extractFinalText`, and runs the **shared** status scanner
over each candidate text keeping the last valid `{status}` block — exactly today's
"last valid block in stream order wins" semantics. Parse failure / no status →
safe `in_progress`. Spawn error → rate-limit detection then safe `in_progress`.

`ClaudeRunner` and `CodexRunner` become thin wrappers that construct their spec and
delegate to `runCli`.

### New / changed files

- `runner/agent-status.ts` *(new)* — moved status-extraction helpers, shared.
- `runner/run-cli.ts` *(new)* — the `runCli` core (moved machinery + `StallInfo`,
  `RunnerCoreConfig` carrying `stallTimeoutMs`/`maxStallRetries`/`secretEnvKeys`/`onStall`).
- `runner/codex-runner.ts` *(new)* — Codex spec.
- `runner/claude-runner.ts` *(shrinks)* — Claude spec (`buildClaudeArgs` +
  stream-json text walk) + re-exports `STATUS_CONTRACT`. Public exports used by tests
  (`parseAgentResult`, `buildClaudeArgs`, `topLevelJsonObjects`, `detectRateLimit`)
  remain importable (re-export from new homes) so existing tests don't churn.

### Config seam (daemon-global)

`config-schema.ts` `defaults` gains:

```ts
agent: z.object({
  kind: z.enum(['claude', 'codex']).default('claude'),
  command: z.string().optional(),   // binary override; defaults to kind name
}).default({})
```

`daemon.ts` replaces `new ClaudeRunner(...)` with a factory keyed on
`config.defaults.agent.kind`, passing the same `secretEnvKeys` / `onStall`.

### `RunnerInput` generalize

`input.claude` → `input.agent`:

```ts
agent: {
  command: string;
  stallTimeoutMs?: number;
  claude: { maxTurns: number; permissionMode: string }; // Claude-only; Codex ignores
}
```

`buildRunnerInput` (executor.ts) fills `command` from the global agent config,
falling back to WORKFLOW `claude.command` when `kind === 'claude'` (back-compat);
`stallTimeoutMs` still from WORKFLOW `claude.stall_timeout_seconds`.

### Codex specifics

- **Invocation:** `codex exec - --json --skip-git-repo-check <sandbox-flag> [--model <m>]`.
  Prompt goes on **stdin** (the `-` sentinel forces stdin read) — same `assemblePrompt`
  output as Claude.
- **Permission parity:** `permissionMode === 'bypassPermissions'` →
  `--dangerously-bypass-approvals-and-sandbox` (full fs + network, the true equivalent
  of Claude's `--dangerously-skip-permissions`; safety is workspace isolation, §13.1).
  Otherwise → `--sandbox workspace-write`.
- **`--json` output:** JSONL `ThreadEvent` stream. `extractFinalText` returns the text
  of each `item.completed` event whose item is an `AgentMessage`, in stream order; the
  shared scanner then keeps the last valid `{status}` block.
- **`max_turns`:** Codex `exec` has no turn cap; the WORKFLOW `max_turns` knob is
  **ignored** under Codex (documented in the schema comment).
- **Rate-limit:** extend `detectRateLimit` to recognise Codex's usage-limit wording
  (exact string verified against the CLI during TDD).

### Preflight

`requiredBinaries(config)` requires `claude` **or** `codex` per
`config.defaults.agent.kind` (not both). `allBinaries()` still lists both so `doctor`
checks everything.

## Testing

Reuse the existing runner test pattern with a fake `Exec` replaying Codex JSONL
fixtures:

- final `AgentMessage` extraction (incl. last-wins when multiple agent messages);
- bypass vs. `workspace-write` argv;
- prompt delivered on stdin via `-`;
- status-block parse incl. multi-line `mrDescription` (shared scanner — already covered,
  re-assert through the Codex path);
- no parseable status → safe `in_progress`;
- stall → retry-once: tested once against `runCli` (inherited by both agents);
- config: `defaults.agent.kind` selects the runner; preflight requires the right binary.

## Risks

- Refactor touches the working Claude path. Mitigation: the machinery and status
  helpers move verbatim; Claude argv/parse logic is unchanged; existing Claude runner
  tests must stay green (regression guard).
- Codex `--json` event schema is experimental (the `--json`/`experimental-json` alias).
  Mitigation: extraction degrades to safe `in_progress` on any unrecognised shape, and
  is pinned by fixtures.
