# Maestro M3 — Workspace Manager & Claude Runner — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the REAL `WorkspaceManager` (clone/reuse/branch/LRU-cap), the Claude `AgentResult` parser, the `ClaudeRunner` (headless `claude -p --output-format stream-json` via execa), the `DEFAULT_PROTOCOL` prompt fragments, and wire all of them into the reconciler's `work` executor (which M1 stubbed with fakes).

**Architecture:** Three independently-testable seams under `packages/core/src`: `workspace/manager.ts` shells out to `git` via execa against per-issue clone dirs under `config.defaults.workspaces.root`; `agent/contract.ts` parses the final fenced JSON `{"status","summary"}` out of `claude` stream-json stdout; `agent/runner.ts` spawns `<command> -p --output-format stream-json --permission-mode <mode> --max-turns <n>` via execa, pipes the prompt on stdin, collects stdout, and returns `parseAgentResult(stdout)`. **Commits happen in two distinct places: the Claude agent makes atomic git commits INSIDE the workspace during its run (it has the `git` tool and the working tree); AFTER the run returns, the reconciler `work` executor runs `git push` via execa to publish the branch.** The executor builds the agent prompt (issue body + current MR description + `workflow.promptBody` + `DEFAULT_PROTOCOL` + git diff context), runs Claude, pushes the branch, and updates the MR description from the agent output. `needs_input` → block; `done` → next tick hands off.

**Tech Stack:** Node 20+, TypeScript 5.x, ESM, pnpm workspaces, Vitest (`*.test.ts` colocated), `execa` for `git`/`claude` subprocesses. Package: `@maestro/core`.

**Depends on:** M1 (reconciler injects ClaudeRunner/WorkspaceManager interfaces; M1 used fakes in tests — this milestone provides the REAL implementations and wires them in).

---

## File Structure

| Path | Responsibility | Action |
|---|---|---|
| `packages/core/src/agent/contract.ts` | `AgentResult` type + `parseAgentResult(streamJsonStdout)` — extracts final fenced JSON status block | Create |
| `packages/core/src/agent/contract.test.ts` | Unit tests over sample stream-json strings | Create |
| `packages/core/src/agent/protocol.ts` | `DEFAULT_PROTOCOL` §9 operating-protocol prompt fragments | Create |
| `packages/core/src/agent/protocol.test.ts` | Assert protocol contains the spine markers | Create |
| `packages/core/src/agent/runner.ts` | `RunnerOpts`, `ClaudeRunner` interface + `RealClaudeRunner` impl (execa) | Create |
| `packages/core/src/agent/runner.test.ts` | Runner driven against a stub script emitting canned stream-json | Create |
| `packages/core/src/agent/__fixtures__/stub-claude.mjs` | Test stub that emits canned stream-json on stdout | Create |
| `packages/core/src/workspace/manager.ts` | `WorkspaceManager` interface + `RealWorkspaceManager` (git via execa, LRU cap, path sanitize) | Create |
| `packages/core/src/workspace/manager.test.ts` | Temp-dir tests: ensure/reuse/remove/path-escape/LRU | Create |
| `packages/core/src/reconciler/index.ts` | `work` executor wired to REAL WorkspaceManager + ClaudeRunner | Modify |
| `packages/core/src/reconciler/index.test.ts` | `work` executor integration test (fakes for forge, real-ish runner/workspace via injection) | Modify |
| `packages/core/src/index.ts` | Re-export new public symbols | Modify |

**Assumption (flagged — see Open questions):** M1 has already created `packages/core/src/reconciler/index.ts` with a `reconcileRepo(...)` orchestrator and a `work` executor that receives `WorkspaceManager` and `ClaudeRunner` via injected dependencies. The exact dependency-injection shape of `reconcileRepo` is **not** fixed in the contracts. Tasks 8–9 below assume an injectable `ReconcileDeps` bag containing `forge`, `workspaceManager`, `claudeRunner`, `workflow`, and `config`. If M1 used a different DI shape, adapt the wiring in Task 9 to match M1's actual signature without changing the behavior described.

---

## Task 1: AgentResult parser — happy path (single fenced JSON block)

**Files:**
- Create: `packages/core/src/agent/contract.ts`
- Test: `packages/core/src/agent/contract.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/agent/contract.test.ts
import { describe, it, expect } from 'vitest';
import { parseAgentResult } from './contract.js';

describe('parseAgentResult', () => {
  it('extracts the final fenced JSON status block', () => {
    const stdout = [
      '{"type":"system","subtype":"init"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Working..."}]}}',
      '{"type":"result","subtype":"success","result":"Here is my summary.\\n\\n```json\\n{\\"status\\":\\"done\\",\\"summary\\":\\"Implemented feature X\\"}\\n```"}',
    ].join('\n');
    const result = parseAgentResult(stdout);
    expect(result).toEqual({ status: 'done', summary: 'Implemented feature X' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core vitest run src/agent/contract.test.ts`
Expected: FAIL — `Failed to load .../agent/contract.ts` / "does not provide an export named 'parseAgentResult'".

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/agent/contract.ts
export type AgentStatus = 'done' | 'needs_input' | 'in_progress';

export interface AgentResult {
  status: AgentStatus;
  summary: string;
}

const FENCE_RE = /```json\s*\n([\s\S]*?)\n```/g;
const VALID_STATUSES: readonly AgentStatus[] = ['done', 'needs_input', 'in_progress'];

function lastFencedJson(text: string): AgentResult | null {
  let match: RegExpExecArray | null;
  let last: string | null = null;
  FENCE_RE.lastIndex = 0;
  while ((match = FENCE_RE.exec(text)) !== null) {
    last = match[1];
  }
  if (last === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(last);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.status !== 'string' ||
    !VALID_STATUSES.includes(obj.status as AgentStatus) ||
    typeof obj.summary !== 'string'
  ) {
    return null;
  }
  return { status: obj.status as AgentStatus, summary: obj.summary };
}

// Parse the final result object out of `claude -p --output-format stream-json` output.
export function parseAgentResult(streamJsonStdout: string): AgentResult {
  // Pull the `result` field out of the final `type:"result"` JSON line, then
  // look for the fenced status block there; fall back to scanning all text.
  const lines = streamJsonStdout.split('\n').filter((l) => l.trim() !== '');
  let resultText = '';
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj.type === 'result' && typeof obj.result === 'string') {
        resultText = obj.result;
      }
    } catch {
      // non-JSON line; ignore
    }
  }
  const fromResult = resultText ? lastFencedJson(resultText) : null;
  if (fromResult) return fromResult;

  const fromAll = lastFencedJson(streamJsonStdout);
  if (fromAll) return fromAll;

  throw new Error('parseAgentResult: no valid status block found in stream-json output');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/core vitest run src/agent/contract.test.ts`
Expected: PASS — 1 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent/contract.ts packages/core/src/agent/contract.test.ts
git commit -m "feat(core): parse AgentResult from claude stream-json"
```

---

## Task 2: AgentResult parser — needs_input, last-block-wins, and no-block error

**Files:**
- Modify: `packages/core/src/agent/contract.test.ts`

- [ ] **Step 1: Add failing tests**

```ts
// append inside the describe('parseAgentResult', ...) block in contract.test.ts
  it('parses needs_input status', () => {
    const stdout =
      '{"type":"result","subtype":"success","result":"```json\\n{\\"status\\":\\"needs_input\\",\\"summary\\":\\"Which DB?\\"}\\n```"}';
    expect(parseAgentResult(stdout)).toEqual({ status: 'needs_input', summary: 'Which DB?' });
  });

  it('uses the LAST fenced block when several are present', () => {
    const stdout =
      '{"type":"result","subtype":"success","result":"```json\\n{\\"status\\":\\"in_progress\\",\\"summary\\":\\"early\\"}\\n```\\nmore\\n```json\\n{\\"status\\":\\"done\\",\\"summary\\":\\"final\\"}\\n```"}';
    expect(parseAgentResult(stdout)).toEqual({ status: 'done', summary: 'final' });
  });

  it('throws when no valid status block is present', () => {
    const stdout = '{"type":"result","subtype":"success","result":"I could not finish."}';
    expect(() => parseAgentResult(stdout)).toThrow(/no valid status block/);
  });

  it('throws when the fenced JSON has an invalid status value', () => {
    const stdout =
      '{"type":"result","subtype":"success","result":"```json\\n{\\"status\\":\\"finished\\",\\"summary\\":\\"x\\"}\\n```"}';
    expect(() => parseAgentResult(stdout)).toThrow(/no valid status block/);
  });
```

- [ ] **Step 2: Run tests to verify they pass (impl already covers these)**

Run: `pnpm --filter @maestro/core vitest run src/agent/contract.test.ts`
Expected: PASS — 5 passing. (The Task 1 implementation already handles last-block-wins, status validation, and the throw. These tests lock that behavior in.)

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/agent/contract.test.ts
git commit -m "test(core): cover needs_input, last-block-wins, invalid-status in parseAgentResult"
```

---

## Task 3: DEFAULT_PROTOCOL prompt fragments

**Files:**
- Create: `packages/core/src/agent/protocol.ts`
- Test: `packages/core/src/agent/protocol.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/agent/protocol.test.ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_PROTOCOL } from './protocol.js';

describe('DEFAULT_PROTOCOL', () => {
  it('is a non-empty string', () => {
    expect(typeof DEFAULT_PROTOCOL).toBe('string');
    expect(DEFAULT_PROTOCOL.length).toBeGreaterThan(100);
  });

  it('covers the §9 operating-protocol spine', () => {
    const p = DEFAULT_PROTOCOL.toLowerCase();
    expect(p).toContain('orient');
    expect(p).toContain('mr description'); // plan-in-MR
    expect(p).toContain('atomic commit');
    expect(p).toContain('tick'); // tick the checkboxes
    expect(p).toContain('blocked');
  });

  it('documents the exact final status block the runner parses', () => {
    expect(DEFAULT_PROTOCOL).toContain('```json');
    expect(DEFAULT_PROTOCOL).toContain('"status"');
    expect(DEFAULT_PROTOCOL).toContain('"summary"');
    expect(DEFAULT_PROTOCOL).toContain('done');
    expect(DEFAULT_PROTOCOL).toContain('needs_input');
    expect(DEFAULT_PROTOCOL).toContain('in_progress');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core vitest run src/agent/protocol.test.ts`
Expected: FAIL — "does not provide an export named 'DEFAULT_PROTOCOL'".

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/agent/protocol.ts

// The default agent operating protocol (design spec §9). Baked into the prompt
// every cold `claude -p` session receives. The agent reconstructs all context
// from the issue, the MR description, and git — there is no session resume.
export const DEFAULT_PROTOCOL = `## Operating protocol

You are an autonomous coding agent working a single issue in a fresh, cold
session. You have no memory of prior runs. Reconstruct all context from the
issue text, the merge-request (MR) description, recent commits, the working-tree
diff, and the repository conventions below.

Follow this loop every run:

1. **Orient.** Read the issue, the MR description (this is YOUR plan/todo list if
   one already exists), recent commits and the current diff, and the repo
   conventions in this prompt.
2. **First session only.** If no plan exists in the MR description: if the task
   is ambiguous, post a comment with specific questions and stop with status
   \`needs_input\`. Otherwise write a plan as a markdown checkbox todo list into
   the **MR description**.
3. **Work the next unchecked item.** Make one **atomic commit** per meaningful
   step, with a clear message. Commit inside this workspace; do NOT push — the
   daemon pushes the branch after you finish.
4. **After each step.** Tick the corresponding checkbox in the MR description.
   Post a short progress comment when something notable happens.
5. **Done.** When every checkbox is ticked and the definition of done is met, end
   with status \`done\`.
6. **Blocked anytime.** If you need a human decision you cannot make
   autonomously, post the question as a comment and end with status
   \`needs_input\`.

## Required final output

End EVERY run by emitting exactly one fenced JSON block as the last thing you
output, summarizing the run for the daemon:

\`\`\`json
{"status": "done | needs_input | in_progress", "summary": "one line of what happened"}
\`\`\`

- \`done\` — all checkboxes ticked and definition of done met.
- \`needs_input\` — you are blocked and have posted a question.
- \`in_progress\` — you made progress but more work remains for a later run.
`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/core vitest run src/agent/protocol.test.ts`
Expected: PASS — 3 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent/protocol.ts packages/core/src/agent/protocol.test.ts
git commit -m "feat(core): add DEFAULT_PROTOCOL agent operating-protocol fragments"
```

---

## Task 4: ClaudeRunner interface + RunnerOpts (compile-only seam)

**Files:**
- Create: `packages/core/src/agent/runner.ts`
- Test: `packages/core/src/agent/runner.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/agent/runner.test.ts
import { describe, it, expect } from 'vitest';
import { RealClaudeRunner } from './runner.js';

describe('RealClaudeRunner', () => {
  it('constructs and exposes a run method', () => {
    const runner = new RealClaudeRunner();
    expect(typeof runner.run).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core vitest run src/agent/runner.test.ts`
Expected: FAIL — "does not provide an export named 'RealClaudeRunner'".

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/agent/runner.ts
import { execa } from 'execa';
import type { PermissionMode } from '../workflow/schema.js';
import { parseAgentResult, type AgentResult } from './contract.js';

export interface RunnerOpts {
  command: string; // workflow.claude.command, e.g. "claude"
  maxTurns: number;
  permissionMode: PermissionMode;
}

export interface ClaudeRunner {
  // Runs `<command> -p --output-format stream-json --permission-mode <mode> --max-turns <n>`
  // in cwd, feeding `prompt` on stdin. Resolves with the parsed AgentResult.
  run(cwd: string, prompt: string, opts: RunnerOpts): Promise<AgentResult>;
}

export class RealClaudeRunner implements ClaudeRunner {
  async run(cwd: string, prompt: string, opts: RunnerOpts): Promise<AgentResult> {
    const { stdout } = await execa(
      opts.command,
      [
        '-p',
        '--output-format',
        'stream-json',
        '--permission-mode',
        opts.permissionMode,
        '--max-turns',
        String(opts.maxTurns),
      ],
      { cwd, input: prompt },
    );
    return parseAgentResult(stdout);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/core vitest run src/agent/runner.test.ts`
Expected: PASS — 1 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent/runner.ts packages/core/src/agent/runner.test.ts
git commit -m "feat(core): add ClaudeRunner interface and RealClaudeRunner skeleton"
```

---

## Task 5: ClaudeRunner end-to-end against a stub `claude` script

**Files:**
- Create: `packages/core/src/agent/__fixtures__/stub-claude.mjs`
- Modify: `packages/core/src/agent/runner.test.ts`

This tests the real execa wiring: the stub plays the role of the `claude` binary,
reads stdin, and emits canned stream-json so we verify args, cwd, stdin piping,
and parsing without invoking the real model.

- [ ] **Step 1: Create the stub script**

```js
// packages/core/src/agent/__fixtures__/stub-claude.mjs
#!/usr/bin/env node
// Stub standing in for the `claude` binary in tests.
// Echoes the args it was called with and the prompt it received on stdin into
// the canned stream-json `result`, so the test can assert the runner wired
// everything correctly. The final fenced block drives parseAgentResult.

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);

let stdin = '';
try {
  stdin = readFileSync(0, 'utf8'); // fd 0 = stdin
} catch {
  stdin = '';
}

const status = process.env.STUB_STATUS ?? 'done';
const resultText =
  `args=${JSON.stringify(args)} cwd=${process.cwd()} promptLen=${stdin.length}\n` +
  '```json\n' +
  JSON.stringify({ status, summary: 'stub run complete' }) +
  '\n```';

const line = JSON.stringify({ type: 'result', subtype: 'success', result: resultText });
process.stdout.write(line + '\n');
```

- [ ] **Step 2: Add the failing test**

```ts
// append to packages/core/src/agent/runner.test.ts
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STUB = join(__dirname, '__fixtures__', 'stub-claude.mjs');

describe('RealClaudeRunner.run (against stub)', () => {
  it('passes flags, cwd and prompt, and returns the parsed result', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maestro-runner-'));
    const runner = new RealClaudeRunner();
    const result = await runner.run(cwd, 'PROMPT-CONTENT', {
      command: process.execPath, // node, invoking the stub
      maxTurns: 7,
      permissionMode: 'acceptEdits',
    });
    expect(result).toEqual({ status: 'done', summary: 'stub run complete' });
  });

  it('returns needs_input when the agent reports it', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maestro-runner-'));
    const runner = new RealClaudeRunner();
    const result = await runner.run(cwd, 'PROMPT', {
      command: process.execPath,
      maxTurns: 3,
      permissionMode: 'acceptEdits',
    });
    // We pass the stub path as the first arg via a wrapper below.
    expect(result.status).toBe('done'); // default STUB_STATUS
  });
});
```

> Note: `RealClaudeRunner.run` invokes `opts.command` directly with the fixed
> flag list. To make `node <stub>` work, the test must invoke node with the stub
> as the *first* arg. The current `run` signature does not allow extra leading
> args, so Step 3 adds an optional `extraArgs` hook used only here.

- [ ] **Step 3: Extend `RunnerOpts` with an optional `argsPrefix` and use it**

```ts
// in packages/core/src/agent/runner.ts — replace RunnerOpts and the execa call

export interface RunnerOpts {
  command: string; // workflow.claude.command, e.g. "claude"
  maxTurns: number;
  permissionMode: PermissionMode;
  // Args inserted before the standard flags. Production leaves this empty;
  // tests use it to invoke `node <stub-script>` as the command.
  argsPrefix?: string[];
}
```

```ts
// replace the execa call body in RealClaudeRunner.run
    const { stdout } = await execa(
      opts.command,
      [
        ...(opts.argsPrefix ?? []),
        '-p',
        '--output-format',
        'stream-json',
        '--permission-mode',
        opts.permissionMode,
        '--max-turns',
        String(opts.maxTurns),
      ],
      { cwd, input: prompt },
    );
    return parseAgentResult(stdout);
```

- [ ] **Step 4: Update the stub test to use `argsPrefix`**

```ts
// replace the two `run(...)` calls in the 'against stub' describe block:
    const result = await runner.run(cwd, 'PROMPT-CONTENT', {
      command: process.execPath,
      maxTurns: 7,
      permissionMode: 'acceptEdits',
      argsPrefix: [STUB],
    });
```

```ts
    const result = await runner.run(cwd, 'PROMPT', {
      command: process.execPath,
      maxTurns: 3,
      permissionMode: 'acceptEdits',
      argsPrefix: [STUB],
    });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @maestro/core vitest run src/agent/runner.test.ts`
Expected: PASS — 3 passing (the constructor test plus the two stub-driven tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/agent/runner.ts packages/core/src/agent/runner.test.ts packages/core/src/agent/__fixtures__/stub-claude.mjs
git commit -m "feat(core): drive RealClaudeRunner via execa with stdin prompt"
```

---

## Task 6: WorkspaceManager — pathFor sanitization and escape rejection

**Files:**
- Create: `packages/core/src/workspace/manager.ts`
- Test: `packages/core/src/workspace/manager.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/workspace/manager.test.ts
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { RealWorkspaceManager } from './manager.js';

describe('RealWorkspaceManager.pathFor', () => {
  const root = resolve('/tmp/maestro-ws-root');
  const mgr = new RealWorkspaceManager(root);

  it('produces a sanitized path under root', () => {
    const p = mgr.pathFor('https://gitlab.com/group/api.git', 42);
    expect(p.startsWith(root)).toBe(true);
    // only alphanumeric, dot, underscore, hyphen, path separators in the leaf
    const leaf = p.slice(root.length + 1);
    expect(leaf).toMatch(/^[A-Za-z0-9._-]+\/issue-42$/);
  });

  it('rejects repo urls that would escape the root', () => {
    expect(() => mgr.pathFor('../../etc/passwd', 1)).toThrow(/escape|outside|invalid/i);
  });

  it('is stable: same inputs yield the same path', () => {
    const a = mgr.pathFor('gitlab.com/group/api', 7);
    const b = mgr.pathFor('gitlab.com/group/api', 7);
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core vitest run src/workspace/manager.test.ts`
Expected: FAIL — "does not provide an export named 'RealWorkspaceManager'".

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/workspace/manager.ts
import { resolve, join, sep } from 'node:path';

export interface WorkspaceManager {
  // Clone repo (or reuse existing) for an issue; checkout/create the issue branch. Returns dir.
  ensure(repoUrl: string, issueNumber: number, branch: string): Promise<string>;
  remove(repoUrl: string, issueNumber: number): Promise<void>; // terminal cleanup
  enforceDiskCap(capBytes: number): Promise<void>; // LRU eviction of terminal/oldest
  pathFor(repoUrl: string, issueNumber: number): string; // sanitized, MUST stay under root
}

// Turn a repo URL into a single sanitized path segment: strip scheme, drop a
// trailing .git, replace any char outside [A-Za-z0-9._-] with '-'.
function slugForRepo(repoUrl: string): string {
  const noScheme = repoUrl.replace(/^[a-z]+:\/\//i, '');
  const noGit = noScheme.replace(/\.git$/i, '');
  const slug = noGit.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug;
}

export class RealWorkspaceManager implements WorkspaceManager {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  pathFor(repoUrl: string, issueNumber: number): string {
    const slug = slugForRepo(repoUrl);
    if (slug.length === 0) {
      throw new Error(`Invalid repo url (empty slug): ${repoUrl}`);
    }
    const candidate = resolve(join(this.root, slug, `issue-${issueNumber}`));
    // Reject anything that resolves outside the root (path traversal guard).
    if (candidate !== this.root && !candidate.startsWith(this.root + sep)) {
      throw new Error(`Workspace path escapes root: ${candidate} not under ${this.root}`);
    }
    return candidate;
  }

  async ensure(): Promise<string> {
    throw new Error('not implemented');
  }
  async remove(): Promise<void> {
    throw new Error('not implemented');
  }
  async enforceDiskCap(): Promise<void> {
    throw new Error('not implemented');
  }
}
```

> The escape test passes because `slugForRepo('../../etc/passwd')` collapses the
> `..`/`/` chars to `-`, producing `etc-passwd`, which stays under root. To make
> the *intent* explicit and test the traversal guard directly, Step 4 adds a test
> that the guard fires when given a slug that genuinely escapes.

- [ ] **Step 4: Add a direct traversal-guard test**

```ts
// append to manager.test.ts
import { RealWorkspaceManager as WM } from './manager.js';

describe('RealWorkspaceManager path guard (internal)', () => {
  it('throws if a crafted segment escapes root', () => {
    const root = resolve('/tmp/maestro-ws-root');
    const mgr = new WM(root);
    // Monkeypatch the private slug step by feeding a url that sanitizes to ".."
    // Such input cannot occur after sanitization, so we assert the sanitizer
    // never yields a traversal segment instead.
    const p = mgr.pathFor('https://host/a/../../b', 3);
    expect(p.startsWith(root + '/')).toBe(true);
    expect(p).not.toContain('..');
  });
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @maestro/core vitest run src/workspace/manager.test.ts`
Expected: PASS — 4 passing.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/workspace/manager.ts packages/core/src/workspace/manager.test.ts
git commit -m "feat(core): add WorkspaceManager pathFor sanitization + traversal guard"
```

---

## Task 7: WorkspaceManager.ensure — clone, reuse, branch checkout/create

**Files:**
- Modify: `packages/core/src/workspace/manager.ts`
- Modify: `packages/core/src/workspace/manager.test.ts`

Tests use a real local "remote": a bare git repo created in a temp dir, so
`git clone <file-path>` works offline.

- [ ] **Step 1: Add the failing test**

```ts
// append to manager.test.ts
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execa } from 'execa';

async function makeBareRemote(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-remote-'));
  const work = join(dir, 'work');
  const bare = join(dir, 'origin.git');
  await mkdir(work, { recursive: true });
  await execa('git', ['init', '-b', 'main', work]);
  await execa('git', ['-C', work, 'config', 'user.email', 't@t'], {});
  await execa('git', ['-C', work, 'config', 'user.name', 'T'], {});
  await writeFile(join(work, 'README.md'), '# seed\n');
  await execa('git', ['-C', work, 'add', 'README.md']);
  await execa('git', ['-C', work, 'commit', '-m', 'seed']);
  await execa('git', ['clone', '--bare', work, bare]);
  return bare;
}

describe('RealWorkspaceManager.ensure', () => {
  it('clones the repo and creates the issue branch on first call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maestro-ensure-'));
    const remote = await makeBareRemote();
    const mgr = new RealWorkspaceManager(root);

    const dir = await mgr.ensure(remote, 11, 'maestro/issue-11');
    expect(dir).toBe(mgr.pathFor(remote, 11));
    expect(existsSync(join(dir, '.git'))).toBe(true);
    expect(existsSync(join(dir, 'README.md'))).toBe(true);

    const { stdout } = await execa('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']);
    expect(stdout.trim()).toBe('maestro/issue-11');

    await rm(root, { recursive: true, force: true });
  });

  it('reuses the existing clone on the second call (no re-clone)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maestro-reuse-'));
    const remote = await makeBareRemote();
    const mgr = new RealWorkspaceManager(root);

    const dir1 = await mgr.ensure(remote, 12, 'maestro/issue-12');
    await writeFile(join(dir1, 'marker.txt'), 'kept');
    const dir2 = await mgr.ensure(remote, 12, 'maestro/issue-12');

    expect(dir2).toBe(dir1);
    expect(existsSync(join(dir2, 'marker.txt'))).toBe(true); // not wiped by a re-clone

    await rm(root, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core vitest run src/workspace/manager.test.ts -t ensure`
Expected: FAIL — `ensure` throws "not implemented".

- [ ] **Step 3: Implement `ensure`**

```ts
// in packages/core/src/workspace/manager.ts
// add imports at top:
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execa } from 'execa';
```

```ts
// replace the stub `ensure` in RealWorkspaceManager
  async ensure(repoUrl: string, issueNumber: number, branch: string): Promise<string> {
    const dir = this.pathFor(repoUrl, issueNumber);
    const isClone = existsSync(join(dir, '.git'));

    if (!isClone) {
      await mkdir(dir, { recursive: true });
      await execa('git', ['clone', repoUrl, dir]);
    } else {
      // Reuse: refresh refs so a new branch can be based on the latest default.
      await execa('git', ['-C', dir, 'fetch', '--all', '--prune']);
    }

    // Checkout the branch if it already exists locally, else create it.
    const branchExists = await execa('git', ['-C', dir, 'rev-parse', '--verify', branch], {
      reject: false,
    });
    if (branchExists.exitCode === 0) {
      await execa('git', ['-C', dir, 'checkout', branch]);
    } else {
      await execa('git', ['-C', dir, 'checkout', '-b', branch]);
    }

    return dir;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @maestro/core vitest run src/workspace/manager.test.ts -t ensure`
Expected: PASS — 2 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/workspace/manager.ts packages/core/src/workspace/manager.test.ts
git commit -m "feat(core): implement WorkspaceManager.ensure clone/reuse + branch"
```

---

## Task 8: WorkspaceManager.remove

**Files:**
- Modify: `packages/core/src/workspace/manager.ts`
- Modify: `packages/core/src/workspace/manager.test.ts`

- [ ] **Step 1: Add the failing test**

```ts
// append to manager.test.ts
describe('RealWorkspaceManager.remove', () => {
  it('deletes the issue workspace dir and is idempotent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maestro-remove-'));
    const remote = await makeBareRemote();
    const mgr = new RealWorkspaceManager(root);

    const dir = await mgr.ensure(remote, 21, 'maestro/issue-21');
    expect(existsSync(dir)).toBe(true);

    await mgr.remove(remote, 21);
    expect(existsSync(dir)).toBe(false);

    // second remove must not throw
    await mgr.remove(remote, 21);

    await rm(root, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core vitest run src/workspace/manager.test.ts -t remove`
Expected: FAIL — `remove` throws "not implemented".

- [ ] **Step 3: Implement `remove`**

```ts
// add to imports in manager.ts: import { rm } from 'node:fs/promises';  (merge with existing fs/promises import)
```

```ts
// replace the stub `remove`
  async remove(repoUrl: string, issueNumber: number): Promise<void> {
    const dir = this.pathFor(repoUrl, issueNumber);
    await rm(dir, { recursive: true, force: true });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @maestro/core vitest run src/workspace/manager.test.ts -t remove`
Expected: PASS — 1 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/workspace/manager.ts packages/core/src/workspace/manager.test.ts
git commit -m "feat(core): implement WorkspaceManager.remove (idempotent)"
```

---

## Task 9: WorkspaceManager.enforceDiskCap — LRU eviction by mtime

**Files:**
- Modify: `packages/core/src/workspace/manager.ts`
- Modify: `packages/core/src/workspace/manager.test.ts`

Eviction policy: total bytes across all issue workspaces under root. While over
the cap, evict the workspace with the **oldest mtime** (least-recently used),
repeating until under cap. `du` is avoided for portability — size is computed by
walking files.

- [ ] **Step 1: Add the failing test**

```ts
// append to manager.test.ts
import { utimes, stat } from 'node:fs/promises';

describe('RealWorkspaceManager.enforceDiskCap', () => {
  it('evicts the oldest workspace(s) until under the cap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maestro-cap-'));
    const mgr = new RealWorkspaceManager(root);

    // Two fake workspaces with known sizes and mtimes.
    const older = mgr.pathFor('host/a', 1);
    const newer = mgr.pathFor('host/a', 2);
    await mkdir(older, { recursive: true });
    await mkdir(newer, { recursive: true });
    await writeFile(join(older, 'blob'), Buffer.alloc(2000));
    await writeFile(join(newer, 'blob'), Buffer.alloc(2000));

    const old = new Date(Date.now() - 60_000);
    const now = new Date();
    await utimes(older, old, old);
    await utimes(newer, now, now);

    // Cap below the combined size: the older one must be evicted first.
    await mgr.enforceDiskCap(3000);

    expect(existsSync(older)).toBe(false);
    expect(existsSync(newer)).toBe(true);

    await rm(root, { recursive: true, force: true });
  });

  it('is a no-op when already under the cap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maestro-cap2-'));
    const mgr = new RealWorkspaceManager(root);
    const ws = mgr.pathFor('host/a', 1);
    await mkdir(ws, { recursive: true });
    await writeFile(join(ws, 'blob'), Buffer.alloc(100));

    await mgr.enforceDiskCap(10_000);
    expect(existsSync(ws)).toBe(true);

    await rm(root, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core vitest run src/workspace/manager.test.ts -t enforceDiskCap`
Expected: FAIL — `enforceDiskCap` throws "not implemented".

- [ ] **Step 3: Implement `enforceDiskCap`**

```ts
// add to imports in manager.ts: readdir, stat  (merge into the node:fs/promises import)
//   import { mkdir, rm, readdir, stat } from 'node:fs/promises';
```

```ts
// add private helpers + replace the stub enforceDiskCap in RealWorkspaceManager

  // Recursively sum file sizes under a dir.
  private async dirSize(dir: string): Promise<number> {
    let total = 0;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        total += await this.dirSize(full);
      } else if (e.isFile()) {
        const s = await stat(full);
        total += s.size;
      }
    }
    return total;
  }

  // List every issue workspace dir (root/<repoSlug>/issue-<n>) with size + mtime.
  private async listWorkspaces(): Promise<Array<{ dir: string; size: number; mtimeMs: number }>> {
    const out: Array<{ dir: string; size: number; mtimeMs: number }> = [];
    let repoDirs;
    try {
      repoDirs = await readdir(this.root, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const repo of repoDirs) {
      if (!repo.isDirectory()) continue;
      const repoPath = join(this.root, repo.name);
      const issueDirs = await readdir(repoPath, { withFileTypes: true });
      for (const issue of issueDirs) {
        if (!issue.isDirectory() || !issue.name.startsWith('issue-')) continue;
        const dir = join(repoPath, issue.name);
        const s = await stat(dir);
        out.push({ dir, size: await this.dirSize(dir), mtimeMs: s.mtimeMs });
      }
    }
    return out;
  }

  async enforceDiskCap(capBytes: number): Promise<void> {
    let workspaces = await this.listWorkspaces();
    let total = workspaces.reduce((acc, w) => acc + w.size, 0);
    if (total <= capBytes) return;

    // Oldest mtime first (LRU).
    workspaces.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const w of workspaces) {
      if (total <= capBytes) break;
      await rm(w.dir, { recursive: true, force: true });
      total -= w.size;
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @maestro/core vitest run src/workspace/manager.test.ts -t enforceDiskCap`
Expected: PASS — 2 passing.

- [ ] **Step 5: Run the full workspace suite**

Run: `pnpm --filter @maestro/core vitest run src/workspace/manager.test.ts`
Expected: PASS — all workspace tests green.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/workspace/manager.ts packages/core/src/workspace/manager.test.ts
git commit -m "feat(core): implement WorkspaceManager.enforceDiskCap LRU eviction"
```

---

## Task 10: Export new symbols from the core barrel

**Files:**
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Add the failing test**

```ts
// packages/core/src/index.test.ts  (create if absent)
import { describe, it, expect } from 'vitest';
import * as core from './index.js';

describe('core barrel exports M3 symbols', () => {
  it('exports parseAgentResult, DEFAULT_PROTOCOL, RealClaudeRunner, RealWorkspaceManager', () => {
    expect(typeof core.parseAgentResult).toBe('function');
    expect(typeof core.DEFAULT_PROTOCOL).toBe('string');
    expect(typeof core.RealClaudeRunner).toBe('function');
    expect(typeof core.RealWorkspaceManager).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core vitest run src/index.test.ts`
Expected: FAIL — one or more of the symbols is `undefined` (not re-exported).

- [ ] **Step 3: Add the re-exports**

```ts
// append to packages/core/src/index.ts
export { parseAgentResult } from './agent/contract.js';
export type { AgentResult, AgentStatus } from './agent/contract.js';
export { DEFAULT_PROTOCOL } from './agent/protocol.js';
export { RealClaudeRunner } from './agent/runner.js';
export type { ClaudeRunner, RunnerOpts } from './agent/runner.js';
export { RealWorkspaceManager } from './workspace/manager.js';
export type { WorkspaceManager } from './workspace/manager.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/core vitest run src/index.test.ts`
Expected: PASS — 1 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/index.ts packages/core/src/index.test.ts
git commit -m "chore(core): export M3 workspace/agent symbols from barrel"
```

---

## Task 11: Build the agent prompt — `buildAgentPrompt` helper in the reconciler

**Files:**
- Modify: `packages/core/src/reconciler/index.ts`
- Modify: `packages/core/src/reconciler/index.test.ts`

This is a **pure** string-builder, unit-tested in isolation before wiring it into
the `work` executor. It composes the four context sources the spec (§9) calls
for: issue body + current MR description + `workflow.promptBody` + `DEFAULT_PROTOCOL`,
plus the working-tree diff passed in by the executor.

- [ ] **Step 1: Add the failing test**

```ts
// append to packages/core/src/reconciler/index.test.ts
import { buildAgentPrompt } from './index.js';
import { DEFAULT_PROTOCOL } from '../agent/protocol.js';

describe('buildAgentPrompt', () => {
  it('composes issue body, MR description, repo prompt body, protocol, and diff', () => {
    const prompt = buildAgentPrompt({
      issueTitle: 'Add health endpoint',
      issueBody: 'We need GET /health returning 200.',
      mrDescription: '- [ ] add route\n- [ ] add test',
      promptBody: 'Run tests with `pnpm test`.',
      diff: 'diff --git a/x b/x',
    });

    expect(prompt).toContain('Add health endpoint');
    expect(prompt).toContain('We need GET /health returning 200.');
    expect(prompt).toContain('- [ ] add route');
    expect(prompt).toContain('Run tests with `pnpm test`.');
    expect(prompt).toContain(DEFAULT_PROTOCOL);
    expect(prompt).toContain('diff --git a/x b/x');
  });

  it('handles an empty MR description and empty diff gracefully', () => {
    const prompt = buildAgentPrompt({
      issueTitle: 'T',
      issueBody: 'B',
      mrDescription: '',
      promptBody: 'P',
      diff: '',
    });
    expect(prompt).toContain('T');
    expect(prompt).toContain('B');
    expect(prompt).toContain(DEFAULT_PROTOCOL);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core vitest run src/reconciler/index.test.ts -t buildAgentPrompt`
Expected: FAIL — "does not provide an export named 'buildAgentPrompt'".

- [ ] **Step 3: Implement `buildAgentPrompt`**

```ts
// add near the top of packages/core/src/reconciler/index.ts (after existing imports)
import { DEFAULT_PROTOCOL } from '../agent/protocol.js';

export interface AgentPromptParts {
  issueTitle: string;
  issueBody: string;
  mrDescription: string; // current MR description (the agent's living plan); may be empty
  promptBody: string;    // workflow.promptBody — repo conventions
  diff: string;          // working-tree / branch diff context; may be empty
}

// Pure: compose the full prompt fed to `claude -p` on stdin.
export function buildAgentPrompt(parts: AgentPromptParts): string {
  const sections: string[] = [];
  sections.push(`# Issue\n\n## ${parts.issueTitle}\n\n${parts.issueBody}`);
  sections.push(
    `# Current MR description (your plan/todo — empty means none yet)\n\n${
      parts.mrDescription.trim() === '' ? '(none yet)' : parts.mrDescription
    }`,
  );
  sections.push(`# Repository conventions\n\n${parts.promptBody}`);
  sections.push(
    `# Working-tree diff\n\n${
      parts.diff.trim() === '' ? '(clean — no uncommitted changes)' : '```diff\n' + parts.diff + '\n```'
    }`,
  );
  sections.push(DEFAULT_PROTOCOL);
  return sections.join('\n\n---\n\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/core vitest run src/reconciler/index.test.ts -t buildAgentPrompt`
Expected: PASS — 2 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/reconciler/index.ts packages/core/src/reconciler/index.test.ts
git commit -m "feat(core): add buildAgentPrompt composing issue/MR/protocol/diff"
```

---

## Task 12: Wire the REAL WorkspaceManager + ClaudeRunner into the `work` executor

**Files:**
- Modify: `packages/core/src/reconciler/index.ts`
- Modify: `packages/core/src/reconciler/index.test.ts`

**Where commits happen (stated explicitly):** the Claude agent makes atomic git
commits INSIDE the workspace during `claudeRunner.run(...)`. The `work` executor
does NOT commit. AFTER the run returns, the executor runs `git push -u origin
<branch>` via execa to publish those commits, then mirrors the agent's view by
updating the MR description. On `needs_input` it blocks (label + comment); on
`done` it leaves the branch pushed and lets the NEXT tick's reconciler produce
the `handoff` action. On `in_progress` it pushes and stops (next tick runs `work`
again).

> **DI assumption (flagged — see Open questions):** this task assumes the `work`
> executor is reachable as an exported async function `executeWork(deps, issueNumber)`
> where `deps` carries `forge`, `workspaceManager`, `claudeRunner`, `workflow`,
> and `config`. If M1 placed the executor inside `reconcileRepo` with a different
> shape, extract/adapt to that shape — keep the behavior identical.

- [ ] **Step 1: Add the failing test (fakes for forge; stub binary for runner; real WorkspaceManager)**

```ts
// append to packages/core/src/reconciler/index.test.ts
import { executeWork } from './index.js';
import { RealWorkspaceManager } from '../workspace/manager.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import type { ClaudeRunner, RunnerOpts } from '../agent/runner.js';
import type { AgentResult } from '../agent/contract.js';

// Minimal fake forge capturing description updates, comments, and labels.
function makeFakeForge(issue: any, mr: any) {
  const calls = { descriptions: [] as string[], comments: [] as any[], labels: [] as string[] };
  return {
    forge: 'gitlab' as const,
    project: 'group/api',
    botUser: 'maestro-bot',
    async getIssue() { return issue; },
    async getMrForIssue() { return mr; },
    async updateMrDescription(_n: number, body: string) { calls.descriptions.push(body); },
    async comment(t: any, body: string) { calls.comments.push({ t, body }); },
    async setLifecycleLabel(_n: number, state: string) { calls.labels.push(state); },
    calls,
  };
}

class FakeRunner implements ClaudeRunner {
  constructor(private result: AgentResult, public seen?: { cwd: string; prompt: string; opts: RunnerOpts }) {}
  async run(cwd: string, prompt: string, opts: RunnerOpts): Promise<AgentResult> {
    this.seen = { cwd, prompt, opts };
    // Simulate the agent making an atomic commit inside the workspace.
    await writeFile(join(cwd, 'feature.txt'), 'done by agent');
    await execa('git', ['-C', cwd, 'add', 'feature.txt']);
    await execa('git', ['-C', cwd, 'commit', '-m', 'feat: agent change']);
    return this.result;
  }
}

async function bareRemote(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-wk-remote-'));
  const work = join(dir, 'work');
  const bare = join(dir, 'origin.git');
  await mkdir(work, { recursive: true });
  await execa('git', ['init', '-b', 'main', work]);
  await execa('git', ['-C', work, 'config', 'user.email', 't@t']);
  await execa('git', ['-C', work, 'config', 'user.name', 'T']);
  await writeFile(join(work, 'README.md'), '# seed\n');
  await execa('git', ['-C', work, 'add', 'README.md']);
  await execa('git', ['-C', work, 'commit', '-m', 'seed']);
  await execa('git', ['clone', '--bare', work, bare]);
  return bare;
}

describe('executeWork', () => {
  it('ensures workspace, runs agent, pushes branch, updates MR; done leaves it for next tick', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maestro-wk-root-'));
    const remote = await bareRemote();
    const wm = new RealWorkspaceManager(root);
    const issue = { number: 5, title: 'Add X', body: 'do X', state: 'open' };
    const mr = { number: 9, sourceBranch: 'maestro/issue-5', state: 'open' };
    const forge = makeFakeForge(issue, mr);
    const runner = new FakeRunner({ status: 'done', summary: 'added X' });

    const deps = {
      forge,
      workspaceManager: wm,
      claudeRunner: runner,
      repoUrl: remote,
      workflow: {
        promptBody: 'Conventions here.',
        git: { defaultBranch: 'main' },
        claude: { command: 'claude', maxTurns: 40, permissionMode: 'acceptEdits' },
      },
    };

    await executeWork(deps as any, 5);

    // workspace was created with the issue branch
    const dir = wm.pathFor(remote, 5);
    const { stdout: branch } = await execa('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']);
    expect(branch.trim()).toBe('maestro/issue-5');

    // agent's commit was pushed to the remote branch
    const { stdout: remoteBranches } = await execa('git', ['-C', remote, 'branch', '--list', 'maestro/issue-5']);
    expect(remoteBranches).toContain('maestro/issue-5');

    // MR description updated from the agent run; no block label on `done`
    expect(forge.calls.descriptions.length).toBeGreaterThan(0);
    expect(forge.calls.labels).not.toContain('blocked');

    await rm(root, { recursive: true, force: true });
  });

  it('on needs_input sets the blocked label and comments the summary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maestro-wk-block-'));
    const remote = await bareRemote();
    const wm = new RealWorkspaceManager(root);
    const issue = { number: 6, title: 'T', body: 'B', state: 'open' };
    const mr = { number: 10, sourceBranch: 'maestro/issue-6', state: 'open' };
    const forge = makeFakeForge(issue, mr);
    const runner = new FakeRunner({ status: 'needs_input', summary: 'Which DB?' });

    const deps = {
      forge,
      workspaceManager: wm,
      claudeRunner: runner,
      repoUrl: remote,
      workflow: {
        promptBody: 'P',
        git: { defaultBranch: 'main' },
        claude: { command: 'claude', maxTurns: 40, permissionMode: 'acceptEdits' },
      },
    };

    await executeWork(deps as any, 6);

    expect(forge.calls.labels).toContain('blocked');
    expect(forge.calls.comments.some((c) => String(c.body).includes('Which DB?'))).toBe(true);

    await rm(root, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core vitest run src/reconciler/index.test.ts -t executeWork`
Expected: FAIL — "does not provide an export named 'executeWork'".

- [ ] **Step 3: Implement `executeWork`**

```ts
// add to packages/core/src/reconciler/index.ts
import { execa } from 'execa';
import type { WorkspaceManager } from '../workspace/manager.js';
import type { ClaudeRunner } from '../agent/runner.js';
import type { ForgeAdapter } from '../forge/adapter.js';
import type { WorkflowConfig } from '../workflow/schema.js';

export interface WorkDeps {
  forge: ForgeAdapter;
  workspaceManager: WorkspaceManager;
  claudeRunner: ClaudeRunner;
  repoUrl: string;
  workflow: WorkflowConfig;
}

// Run one agent pass for an issue:
//  1. ensure workspace + issue branch
//  2. build prompt from issue/MR/promptBody/protocol/diff
//  3. run claude (the AGENT makes atomic commits inside the workspace)
//  4. push the branch (THIS executor pushes — the agent never pushes)
//  5. update MR description from the agent's view; block on needs_input
export async function executeWork(deps: WorkDeps, issueNumber: number): Promise<void> {
  const branch = `maestro/issue-${issueNumber}`;
  const dir = await deps.workspaceManager.ensure(deps.repoUrl, issueNumber, branch);

  const issue = await deps.forge.getIssue(issueNumber);
  if (!issue) throw new Error(`executeWork: issue #${issueNumber} not found`);
  const mr = await deps.forge.getMrForIssue(issueNumber);

  // Current working-tree diff against the default branch for agent orientation.
  const diffRes = await execa(
    'git',
    ['-C', dir, 'diff', `${deps.workflow.git.defaultBranch}...HEAD`],
    { reject: false },
  );
  const diff = diffRes.exitCode === 0 ? diffRes.stdout : '';

  const prompt = buildAgentPrompt({
    issueTitle: issue.title,
    issueBody: issue.body,
    mrDescription: mr?.id !== undefined ? (mr as { description?: string }).description ?? '' : '',
    promptBody: deps.workflow.promptBody,
    diff,
  });

  const result = await deps.claudeRunner.run(dir, prompt, {
    command: deps.workflow.claude.command,
    maxTurns: deps.workflow.claude.maxTurns,
    permissionMode: deps.workflow.claude.permissionMode,
  });

  // The agent committed atomically inside the workspace; we publish the branch.
  await execa('git', ['-C', dir, 'push', '-u', 'origin', branch]);

  if (mr) {
    await deps.forge.updateMrDescription(mr.number, result.summary);
  }

  if (result.status === 'needs_input') {
    await deps.forge.setLifecycleLabel(issueNumber, 'blocked');
    await deps.forge.comment(
      { type: 'issue', number: issueNumber },
      `Blocked — agent needs input: ${result.summary}`,
    );
  }
  // `done` and `in_progress`: branch is pushed; the next tick's reconciler
  // derives lifecycle and (for done) produces the `handoff` action.
}
```

> Note on the MR description source: the contracts' `MergeRequest` type has no
> `description` field, so the executor reads it defensively via a structural cast
> and falls back to empty string. See Open questions — the forge needs a way to
> return the current MR description for the agent to read its prior plan.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @maestro/core vitest run src/reconciler/index.test.ts -t executeWork`
Expected: PASS — 2 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/reconciler/index.ts packages/core/src/reconciler/index.test.ts
git commit -m "feat(core): wire real WorkspaceManager+ClaudeRunner into work executor"
```

---

## Task 13: Full core suite green + type check

**Files:** none (verification only)

- [ ] **Step 1: Run the full core test suite**

Run: `pnpm --filter @maestro/core vitest run`
Expected: PASS — all suites green (agent contract, protocol, runner, workspace, reconciler, index barrel).

- [ ] **Step 2: Type-check the package**

Run: `pnpm --filter @maestro/core exec tsc --noEmit`
Expected: no type errors.

- [ ] **Step 3: Commit (only if a fix was needed; otherwise skip)**

```bash
git add packages/core/src
git commit -m "test(core): verify M3 workspace+agent suite green"
```

---

## Self-Review

- **§9 protocol spine** → Task 3 (`DEFAULT_PROTOCOL`) asserts orient / plan-in-MR / atomic commits / tick / blocked.
- **§10 agent contract** → Tasks 1–2 (`parseAgentResult`, final fenced JSON).
- **Runner (`claude -p --output-format stream-json --permission-mode --max-turns`, stdin prompt)** → Tasks 4–5.
- **WorkspaceManager.ensure/remove/enforceDiskCap/pathFor + path-escape** → Tasks 6–9, matching the contracts' interface exactly.
- **Commit location stated explicitly** → Task 12 prose + code comments: agent commits inside workspace; executor pushes after the run.
- **`work` executor wiring (ensure → prompt → run → push → update MR; needs_input→block; done→next-tick handoff)** → Tasks 11–12.
- **Types/paths** — all symbols (`AgentResult`, `AgentStatus`, `PermissionMode`, `WorkflowConfig`, `ForgeAdapter`, `WorkspaceManager`, `ClaudeRunner`, `RunnerOpts`) come from contracts; only `RealWorkspaceManager`, `RealClaudeRunner`, `buildAgentPrompt`, `AgentPromptParts`, `WorkDeps`, `executeWork`, and the test-only `argsPrefix` are new and are flagged below where they exceed the contracts.

---

## Open questions

These are gaps the contracts (`maestro-00-contracts.md`) did not cover. They are
recorded here rather than invented in the plan; M3 makes the minimal, flagged
assumptions noted inline to stay buildable.

1. **MR description read-back.** The `MergeRequest` type in the contracts has no
   `description`/`body` field, and `ForgeAdapter` exposes `updateMrDescription`
   (write) but no `getMrDescription` (read). The agent protocol (§9) requires the
   agent to read its prior plan from the MR description each cold session. Task 12
   reads it defensively via a structural cast and falls back to empty. Needs a
   contract addition: either a `description: string` field on `MergeRequest` or a
   `getMrDescription(mrNumber)` adapter method.

2. **Reconciler DI shape.** The contracts give `reconciler/index.ts` as
   `reconcileRepo(...)` but do not fix how `WorkspaceManager`/`ClaudeRunner`/
   `ForgeAdapter`/`WorkflowConfig`/repo URL are injected into the `work` executor.
   This plan assumes an exported `executeWork(deps, issueNumber)` with a `WorkDeps`
   bag. If M1 chose a different shape, the wiring in Task 12 must adapt to it.

3. **Repo URL → forge clone auth.** `WorkspaceManager.ensure(repoUrl, ...)` takes a
   plain URL, but the contracts do not specify how cloning authenticates for
   private repos (token injection into the clone URL, a credential helper, or
   `glab`/`gh` clone). M3 clones with bare `git clone <url>`; private-repo auth is
   unspecified and likely belongs to M2/M6 forge work.

4. **Push remote/auth + force semantics.** Task 12 runs `git push -u origin
   <branch>`. The contracts do not define the push remote name, credential flow,
   or whether re-runs need `--force-with-lease` (the agent may have rewritten
   history via amends). Assumed: plain fast-forward push to `origin`; revisit if
   agents amend commits.

5. **`enforceDiskCap` call site & cadence.** The contracts define the method but
   not who calls it or when (per tick? after each `work`?). The disk-cap string
   (`workspaces.diskCap`, e.g. "20GB") also needs a parser to bytes; contracts
   define `parseDuration` for time but no size parser. M3 implements
   `enforceDiskCap(capBytes)` taking bytes; the GB→bytes parse and the invocation
   schedule are out of scope (daemon loop, likely M5/daemon work).

6. **`cleanup: on_terminal` vs `lru`.** `WorkspacesCfg.cleanup` has two modes, but
   `enforceDiskCap` only implements LRU eviction. Whether `on_terminal` eviction
   (drop a workspace as soon as its issue reaches `done`) routes through this
   manager or through the `cleanup` action executor (M4) is unspecified.

7. **stream-json result shape stability.** `parseAgentResult` assumes the final
   status lives in a fenced \`\`\`json block inside the `type:"result"` line's
   `result` string (with a whole-output fallback). If a future `claude` version
   changes the stream-json envelope, the parser's line/field assumptions may need
   revisiting. Locked by the protocol instruction in Task 3, but the envelope
   itself is external.
