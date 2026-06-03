# Maestro M4 — Proof & Handoff/Approval/Merge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the pluggable proof generator (`playwright` | `test-output` | `diff-summary` | `none`) and wire the reconciler's `handoff` routine plus the `review_check` and `merge` cases so that — per the contract "Handoff order" — proof artifacts are written into `<workspaceDir>/proof/`, committed and pushed to the MR branch, then linked (via `adapter.blobUrl`) in a comment on the issue **and** the MR *before* the reviewer is assigned; the MR is then un-drafted and labelled `in_review`. Approval triggers a forge merge with the repo's git rules, and requested-changes bounce the issue back to `in_progress`.

**Architecture:** Proof strategies live in `packages/core/src/proof/`. Each strategy implements `ProofStrategy.run(ctx)` and returns `ProofArtifact[]` whose `path` is **relative to `workspaceDir`**; strategies write their files into `<workspaceDir>/proof/` (e.g. `proof/maestro-proof-test-output.txt`). `runProof(ctx)` dispatches on `ctx.workflow.proof.type`. Strategies run `workflow.proof.command` (and, for playwright, target `workflow.environment.baseUrl` against an already-running local instance per the contract — proof boot/seed is deferred) inside the issue workspace through the shared exec seam `ctx.exec` (`CommandRunner` from `util/exec.ts`, default `execaRunner`). Handoff is **not a standalone executor**: it is an inline routine invoked by the `work` executor on agent `done`, and the `handoff`/`review_check`/`merge` cases live inside `executeAction(action, snapshot, deps: ReconcileDeps)` in `reconciler/index.ts`. There are **no per-executor deps bags** — everything uses the single `ReconcileDeps` (contract "Reconciler orchestration"). Per the contract "Handoff order", proof artifacts are committed to the MR branch and surfaced as a comment of `adapter.blobUrl(branch, path)` links on both the issue and the MR (links are the contract; inline `![]()` embedding is not guaranteed for private repos).

**Tech Stack:** Node 20+, TypeScript 5.x, ESM. Vitest (colocated `*.test.ts`). `execa` for subprocess. pnpm workspaces (`@maestro/core`). All proof strategies and executor tests use a small POSIX shell script fixture for the proof command and a recording fake `ForgeAdapter` for order assertions.

**Depends on:** M1 (reconciler/lifecycle: `domain/types.ts`, `domain/lifecycle.ts`, `forge/adapter.ts` `ForgeAdapter`/`ForgeError`, `forge/memory.ts` `MemoryForge`, `reconciler/derive.ts`, `reconciler/decide.ts`, `reconciler/index.ts` skeleton), M3 (`workspace/manager.ts` `WorkspaceManager` — proof commands run in the workspace dir returned by `ensure()`/`pathFor()`).

---

## File Structure

| Path | Responsibility | Action |
|---|---|---|
| `packages/core/src/proof/index.ts` | `ProofStrategy`, `ProofArtifact`, `ProofContext` types; `runProof(ctx)` dispatcher on `ctx.workflow.proof.type`; `renderArtifactComment(adapter, branch, artifacts)` helper (renders `blobUrl` links for `comment`). | Create |
| `packages/core/src/proof/index.test.ts` | Dispatch tests: each `proof.type` routes to its strategy; `'none'` returns `[]`; comment renderer emits `blobUrl` links. | Create |
| `packages/core/src/proof/playwright.ts` | `playwrightProof: ProofStrategy` — runs `workflow.proof.command` in `workspaceDir` against `workflow.environment.baseUrl`, writes into `proof/`, returns a `video` artifact. | Create |
| `packages/core/src/proof/playwright.test.ts` | Runs against a stub script; asserts command executed in cwd, env carries base URL, returns a `video` artifact under `proof/`. | Create |
| `packages/core/src/proof/testOutput.ts` | `testOutputProof: ProofStrategy` — runs `workflow.proof.command`, writes captured stdout+stderr to `proof/`, returns a `text` artifact. | Create |
| `packages/core/src/proof/testOutput.test.ts` | Stub script; asserts stdout+stderr captured to a `proof/` file and returned as `text` artifact even on non-zero exit. | Create |
| `packages/core/src/proof/diffSummary.ts` | `diffSummaryProof: ProofStrategy` — runs `git diff --stat <defaultBranch>...HEAD` in `workspaceDir`, writes summary into `proof/`, returns a `text` artifact. | Create |
| `packages/core/src/proof/diffSummary.test.ts` | Temp git repo with a committed change; asserts the `proof/` diff summary file contains the changed filename. | Create |
| `packages/core/src/reconciler/index.ts` | Add the inline `handoff` routine plus `review_check` and `merge` cases inside `executeAction(action, snapshot, deps: ReconcileDeps)`; the `work` executor invokes `handoff` on agent `done`. | Modify |
| `packages/core/src/reconciler/handoff.test.ts` | Recording fake adapter; asserts proof committed+pushed, then linked via `blobUrl` in comments on issue AND mr **before** `assignReviewer`, then `setMrReady`, then `setLifecycleLabel(in_review)`. | Create |
| `packages/core/src/reconciler/reviewCheck.test.ts` | `runReviewCheck`: approved → merge invoked; changesRequested → `setLifecycleLabel(in_progress)` + ack comment. | Create |
| `packages/core/src/reconciler/merge.test.ts` | `runMerge` calls `adapter.mergeMr(mrNumber, workflow.git.mergeStrategy, workflow.git.deleteSourceBranch)`. | Create |
| `packages/core/test/fixtures/proof-ok.sh` | Stub proof command (prints to stdout+stderr, exit 0). | Create |
| `packages/core/test/fixtures/proof-fail.sh` | Stub proof command (prints, exit 1). | Create |
| `packages/core/test/recordingForge.ts` | Reusable recording fake `ForgeAdapter` that appends every write-call to an ordered `calls: string[]` log. | Create |

> **Executor architecture (per contract "Reconciler orchestration"):** `reconciler/index.ts` exists from M1 as `reconcileRepo(deps: ReconcileDeps)`. The `handoff`/`review_check`/`merge` cases live inside the **single** internal `executeAction(action: Action, snapshot: IssueSnapshot, deps: ReconcileDeps): Promise<void>` dispatcher — there are **no per-executor deps bags** (`HandoffDeps`/`ReviewCheckDeps`/`MergeDeps` are forbidden) and collaborator types are imported from their owning modules. `handoff` is **not** a returned `Action`: it is an inline routine the `work` executor invokes on agent `done`. M4 fills these case-handlers and the `handoff` routine; M4 does not export new deps bags.
>
> The handoff routine needs subprocess access to commit+push `proof/`. The contract's `ReconcileDeps` exposes `exec: CommandRunner` (from `util/exec.ts`), so the `work` executor passes `deps.exec` into the routine; proof strategies receive the same seam via `ProofContext.exec`. These helpers take their collaborators as **plain parameters** (`adapter`, the `CommandRunner`, the proof `ProofContext`, branch, issue/mr numbers, reviewer) so they stay unit-testable, and the `executeAction` `handoff` case sources the `CommandRunner` from `deps.exec`.

**Helper signatures introduced by this plan (M4-local helpers, NOT exported deps bags):**

```ts
// Commits and pushes the proof/ dir to the MR source branch (contract "Handoff order" step 2).
// The CommandRunner is deps.exec (ReconcileDeps), passed in by the work executor.
export async function commitProof(
  exec: CommandRunner,
  workspaceDir: string,
  branch: string,
  issueNumber: number,
): Promise<void>;

// The inline handoff routine (contract "Handoff order" steps 1–6).
export async function runHandoff(args: {
  adapter: ForgeAdapter;
  exec: CommandRunner;         // = ReconcileDeps.exec
  proofCtx: ProofContext;      // { workspaceDir, workflow, exec }
  branch: string;             // MR source branch (maestro/issue-<n>)
  issueNumber: number;
  mrNumber: number;
  reviewerUsername: string;   // = issue.authorUsername (caller resolves)
}): Promise<void>;
```

`review_check` and `merge` are handled inline in `executeAction` from `(action, snapshot, deps)` — `merge` calls `adapter.mergeMr(snapshot.mr.number, workflow.git.mergeStrategy, workflow.git.deleteSourceBranch)`; `review_check` reads `snapshot.mr.approved` / `snapshot.mr.changesRequested`. The tests below exercise the inline routines directly via these helpers and a small `executeAction`-shaped wrapper, with no per-action deps bag.

---

## Task 1: Proof types + dispatcher skeleton (`'none'` strategy)

**Files:**
- Create: `packages/core/src/proof/index.ts`
- Test: `packages/core/src/proof/index.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/proof/index.test.ts
import { describe, it, expect } from 'vitest';
import { runProof, type ProofContext } from './index.js';
import type { CommandRunner } from '../util/exec.js';
import type { WorkflowConfig } from '../workflow/schema.js';

// none/unknown-type paths never touch the seam, so a no-op runner keeps the test pure.
const noopExec: CommandRunner = {
  async run() { return { stdout: '', stderr: '', exitCode: 0 }; },
};

function workflow(proof: WorkflowConfig['proof']): WorkflowConfig {
  return {
    forge: 'gitlab',
    project: 'group/repo',
    botUser: 'maestro-bot',
    manageBoard: true,
    trigger: { assignee: 'bot', requireLabel: null, allowedActors: [] },
    proof,
    review: { changesSignal: 'label' },
    git: { defaultBranch: 'main', target: 'main', mergeStrategy: 'squash', deleteSourceBranch: true },
    claude: { command: 'claude', maxTurns: 40, permissionMode: 'acceptEdits' },
    concurrency: {},
    promptBody: '',
  };
}

describe('runProof', () => {
  it('returns no artifacts for the "none" strategy', async () => {
    const ctx: ProofContext = { workspaceDir: '/tmp/ws', workflow: workflow({ type: 'none' }), exec: noopExec };
    await expect(runProof(ctx)).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core test proof/index.test.ts`
Expected: FAIL — `Cannot find module './index.js'` (or `runProof is not a function`).

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/proof/index.ts
import type { WorkflowConfig } from '../workflow/schema.js';
import type { CommandRunner } from '../util/exec.js';

export interface ProofArtifact {
  path: string;
  kind: 'video' | 'image' | 'text';
  caption: string;
}

export interface ProofContext {
  workspaceDir: string;
  workflow: WorkflowConfig;
  exec: CommandRunner;   // shared exec seam (util/exec.ts); strategies run subprocesses through it
}

export interface ProofStrategy {
  run(ctx: ProofContext): Promise<ProofArtifact[]>;
}

const noneProof: ProofStrategy = {
  async run(): Promise<ProofArtifact[]> {
    return [];
  },
};

export async function runProof(ctx: ProofContext): Promise<ProofArtifact[]> {
  switch (ctx.workflow.proof.type) {
    case 'none':
      return noneProof.run(ctx);
    default:
      throw new Error(`unknown proof type: ${ctx.workflow.proof.type}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/core test proof/index.test.ts`
Expected: PASS (1 passed).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/proof/index.ts packages/core/src/proof/index.test.ts
git commit -m "feat(proof): add proof types and runProof dispatcher with none strategy"
```

---

## Task 2: Stub command fixtures + recording fake adapter

**Files:**
- Create: `packages/core/test/fixtures/proof-ok.sh`
- Create: `packages/core/test/fixtures/proof-fail.sh`
- Create: `packages/core/test/recordingForge.ts`

> No test of its own — these are shared test fixtures consumed by Tasks 3–8. Verified by being imported/executed there. Committed together so later tasks reference real files.

- [ ] **Step 1: Create the success stub script**

```sh
# packages/core/test/fixtures/proof-ok.sh
#!/usr/bin/env sh
echo "stdout: tests passed"
echo "stderr: warning emitted" 1>&2
exit 0
```

- [ ] **Step 2: Create the failure stub script**

```sh
# packages/core/test/fixtures/proof-fail.sh
#!/usr/bin/env sh
echo "stdout: 1 test failed"
echo "stderr: assertion error" 1>&2
exit 1
```

- [ ] **Step 3: Make the scripts executable**

Run: `chmod +x packages/core/test/fixtures/proof-ok.sh packages/core/test/fixtures/proof-fail.sh`
Expected: no output, exit 0.

- [ ] **Step 4: Create the recording fake adapter + recording runner**

```ts
// packages/core/test/recordingForge.ts
import type { ForgeAdapter, CreateMrArgs, CommentTarget } from '../src/forge/adapter.js';
import type { Forge, Issue, MergeRequest, LifecycleState, MergeStrategy } from '../src/domain/types.js';
import type { CommandRunner } from '../src/util/exec.js';

// A ForgeAdapter that records every call in order, so tests can assert call ordering.
export class RecordingForge implements ForgeAdapter {
  readonly forge: Forge = 'gitlab';
  readonly project = 'group/repo';
  readonly botUser = 'maestro-bot';

  readonly calls: string[] = [];

  // Optional canned MR returned by getMrForIssue.
  constructor(private readonly mr: MergeRequest | null = null) {}

  async listAssignedOpenIssues(): Promise<Issue[]> { this.calls.push('listAssignedOpenIssues'); return []; }
  async getIssue(n: number): Promise<Issue | null> { this.calls.push(`getIssue(${n})`); return null; }
  async listOpenMrsByBot(): Promise<MergeRequest[]> { this.calls.push('listOpenMrsByBot'); return []; }
  async getMrForIssue(n: number): Promise<MergeRequest | null> { this.calls.push(`getMrForIssue(${n})`); return this.mr; }
  async getMrDescription(mrNumber: number): Promise<string> { this.calls.push(`getMrDescription(${mrNumber})`); return ''; }

  async createIssue(args: { title: string; body: string; assignee?: string }): Promise<Issue> { this.calls.push(`createIssue(${args.title})`); throw new Error('not used'); }
  async createBranch(name: string, fromRef: string): Promise<void> { this.calls.push(`createBranch(${name},${fromRef})`); }
  async createDraftMr(args: CreateMrArgs): Promise<MergeRequest> { this.calls.push(`createDraftMr(${args.sourceBranch})`); throw new Error('not used'); }
  async setMrReady(mrNumber: number): Promise<void> { this.calls.push(`setMrReady(${mrNumber})`); }
  async updateMrDescription(mrNumber: number, body: string): Promise<void> { this.calls.push(`updateMrDescription(${mrNumber})`); }
  async assignReviewer(mrNumber: number, username: string): Promise<void> { this.calls.push(`assignReviewer(${mrNumber},${username})`); }
  async mergeMr(mrNumber: number, strategy: MergeStrategy, deleteSource: boolean): Promise<void> { this.calls.push(`mergeMr(${mrNumber},${strategy},${deleteSource})`); }
  async comment(target: CommentTarget, body: string): Promise<void> { this.calls.push(`comment(${target.type}:${target.number})`); }
  async setLifecycleLabel(issueNumber: number, state: LifecycleState): Promise<void> { this.calls.push(`setLifecycleLabel(${issueNumber},${state})`); }

  // Pure helper (no I/O) — deterministic so handoff tests can assert link contents.
  blobUrl(branch: string, path: string): string { return `https://gitlab.example/${this.project}/-/blob/${branch}/${path}`; }

  async ensureLabels(): Promise<void> { this.calls.push('ensureLabels'); }
  async ensureBoard(): Promise<void> { this.calls.push('ensureBoard'); }
}

// Recording CommandRunner (util/exec.ts seam) so handoff tests can assert the
// proof-commit git invocations without touching a real repo.
export class RecordingRunner implements CommandRunner {
  readonly calls: string[] = [];
  async run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    this.calls.push(`${cmd} ${args.join(' ')}`);
    return { stdout: '', stderr: '', exitCode: 0 };
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/test/fixtures/proof-ok.sh packages/core/test/fixtures/proof-fail.sh packages/core/test/recordingForge.ts
git commit -m "test(core): add proof command stubs and recording forge adapter"
```

---

## Task 3: `test-output` proof strategy

**Files:**
- Create: `packages/core/src/proof/testOutput.ts`
- Test: `packages/core/src/proof/testOutput.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/proof/testOutput.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testOutputProof } from './testOutput.js';
import type { ProofContext } from './index.js';
import { execaRunner } from '../util/exec.js';
import type { WorkflowConfig } from '../workflow/schema.js';

const okScript = fileURLToPath(new URL('../../test/fixtures/proof-ok.sh', import.meta.url));
const failScript = fileURLToPath(new URL('../../test/fixtures/proof-fail.sh', import.meta.url));

function ctxFor(command: string, workspaceDir: string): ProofContext {
  const workflow = {
    forge: 'gitlab', project: 'group/repo', botUser: 'maestro-bot', manageBoard: true,
    trigger: { assignee: 'bot', requireLabel: null, allowedActors: [] },
    proof: { type: 'test-output', command },
    review: { changesSignal: 'label' },
    git: { defaultBranch: 'main', target: 'main', mergeStrategy: 'squash', deleteSourceBranch: true },
    claude: { command: 'claude', maxTurns: 40, permissionMode: 'acceptEdits' },
    concurrency: {}, promptBody: '',
  } as WorkflowConfig;
  // Real exec seam so the stub script actually runs and writes the artifact file.
  return { workspaceDir, workflow, exec: execaRunner };
}

describe('testOutputProof', () => {
  let ws: string;
  beforeEach(async () => { ws = await mkdtemp(join(tmpdir(), 'maestro-proof-')); });

  it('captures stdout and stderr to a text artifact under proof/', async () => {
    const [artifact] = await testOutputProof.run(ctxFor(okScript, ws));
    expect(artifact.kind).toBe('text');
    expect(artifact.path.startsWith('proof/')).toBe(true);
    const contents = await readFile(join(ws, artifact.path), 'utf8');
    expect(contents).toContain('stdout: tests passed');
    expect(contents).toContain('stderr: warning emitted');
  });

  it('still returns an artifact when the command exits non-zero', async () => {
    const [artifact] = await testOutputProof.run(ctxFor(failScript, ws));
    const contents = await readFile(join(ws, artifact.path), 'utf8');
    expect(contents).toContain('stdout: 1 test failed');
    expect(contents).toContain('stderr: assertion error');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core test proof/testOutput.test.ts`
Expected: FAIL — `Cannot find module './testOutput.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/proof/testOutput.ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProofArtifact, ProofContext, ProofStrategy } from './index.js';

// Artifacts live under <workspaceDir>/proof/ so the handoff routine can commit them.
const OUTPUT_PATH = 'proof/maestro-proof-test-output.txt';

export const testOutputProof: ProofStrategy = {
  async run(ctx: ProofContext): Promise<ProofArtifact[]> {
    const command = ctx.workflow.proof.command;
    if (!command) throw new Error('test-output proof requires workflow.proof.command');

    // Run through the shared exec seam (ctx.exec). The runner never rejects on a
    // non-zero exit, so we capture output even when the command fails the suite.
    const result = await ctx.exec.run('sh', ['-c', command], { cwd: ctx.workspaceDir });

    const captured = `${result.stdout}\n${result.stderr}`;
    const body = `$ ${command}\nexit code: ${result.exitCode}\n\n${captured}\n`;
    await mkdir(join(ctx.workspaceDir, 'proof'), { recursive: true });
    await writeFile(join(ctx.workspaceDir, OUTPUT_PATH), body, 'utf8');

    return [
      {
        path: OUTPUT_PATH,
        kind: 'text',
        caption: `Test output (exit ${result.exitCode})`,
      },
    ];
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/core test proof/testOutput.test.ts`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/proof/testOutput.ts packages/core/src/proof/testOutput.test.ts
git commit -m "feat(proof): add test-output proof strategy capturing stdout and stderr"
```

---

## Task 4: `diff-summary` proof strategy

**Files:**
- Create: `packages/core/src/proof/diffSummary.ts`
- Test: `packages/core/src/proof/diffSummary.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/proof/diffSummary.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { diffSummaryProof } from './diffSummary.js';
import type { ProofContext } from './index.js';
import { execaRunner } from '../util/exec.js';
import type { WorkflowConfig } from '../workflow/schema.js';

function ctxFor(workspaceDir: string): ProofContext {
  const workflow = {
    forge: 'gitlab', project: 'group/repo', botUser: 'maestro-bot', manageBoard: true,
    trigger: { assignee: 'bot', requireLabel: null, allowedActors: [] },
    proof: { type: 'diff-summary' },
    review: { changesSignal: 'label' },
    git: { defaultBranch: 'main', target: 'main', mergeStrategy: 'squash', deleteSourceBranch: true },
    claude: { command: 'claude', maxTurns: 40, permissionMode: 'acceptEdits' },
    concurrency: {}, promptBody: '',
  } as WorkflowConfig;
  // Real exec seam so git diff actually runs against the temp repo.
  return { workspaceDir, workflow, exec: execaRunner };
}

describe('diffSummaryProof', () => {
  let ws: string;
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), 'maestro-diff-'));
    await execa('git', ['init', '-b', 'main'], { cwd: ws });
    await execa('git', ['config', 'user.email', 't@t.t'], { cwd: ws });
    await execa('git', ['config', 'user.name', 'T'], { cwd: ws });
    await writeFile(join(ws, 'base.txt'), 'base\n');
    await execa('git', ['add', 'base.txt'], { cwd: ws });
    await execa('git', ['commit', '-m', 'base'], { cwd: ws });
    // change on a feature branch off main
    await execa('git', ['checkout', '-b', 'maestro/issue-1'], { cwd: ws });
    await writeFile(join(ws, 'feature.txt'), 'feature\n');
    await execa('git', ['add', 'feature.txt'], { cwd: ws });
    await execa('git', ['commit', '-m', 'add feature'], { cwd: ws });
  });

  it('writes a diff summary text artifact under proof/ naming the changed file', async () => {
    const [artifact] = await diffSummaryProof.run(ctxFor(ws));
    expect(artifact.kind).toBe('text');
    expect(artifact.path.startsWith('proof/')).toBe(true);
    const contents = await readFile(join(ws, artifact.path), 'utf8');
    expect(contents).toContain('feature.txt');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core test proof/diffSummary.test.ts`
Expected: FAIL — `Cannot find module './diffSummary.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/proof/diffSummary.ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProofArtifact, ProofContext, ProofStrategy } from './index.js';

const OUTPUT_PATH = 'proof/maestro-proof-diff-summary.txt';

export const diffSummaryProof: ProofStrategy = {
  async run(ctx: ProofContext): Promise<ProofArtifact[]> {
    const base = ctx.workflow.git.defaultBranch;
    // Run git through the shared exec seam (ctx.exec).
    const result = await ctx.exec.run('git', ['diff', '--stat', `${base}...HEAD`], {
      cwd: ctx.workspaceDir,
    });

    const body = `git diff --stat ${base}...HEAD\n\n${result.stdout}\n`;
    await mkdir(join(ctx.workspaceDir, 'proof'), { recursive: true });
    await writeFile(join(ctx.workspaceDir, OUTPUT_PATH), body, 'utf8');

    return [
      {
        path: OUTPUT_PATH,
        kind: 'text',
        caption: `Diff summary vs ${base}`,
      },
    ];
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/core test proof/diffSummary.test.ts`
Expected: PASS (1 passed).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/proof/diffSummary.ts packages/core/src/proof/diffSummary.test.ts
git commit -m "feat(proof): add diff-summary proof strategy via git diff --stat"
```

---

## Task 5: `playwright` proof strategy

**Files:**
- Create: `packages/core/src/proof/playwright.ts`
- Test: `packages/core/src/proof/playwright.test.ts`

> Per the contract the command runs against an already-running local instance reachable at `workflow.environment.baseUrl` (proof boot/seed is deferred). The strategy passes that URL to the command via env (`PLAYWRIGHT_BASE_URL`, a Playwright-recognised convention) and directs Playwright's output under `<workspaceDir>/proof/` via `PLAYWRIGHT_OUTPUT_DIR`, returning a `video` artifact at the workspace-relative path `proof/test-results` so the handoff routine can commit it. The test uses the shell stub (no real browser) and only asserts the contract: command ran in `workspaceDir`, base URL was exported, and a `video` artifact under `proof/` is returned.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/proof/playwright.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { playwrightProof } from './playwright.js';
import type { ProofContext } from './index.js';
import { execaRunner } from '../util/exec.js';
import type { WorkflowConfig } from '../workflow/schema.js';

// Stub that records its working dir + the base URL env into a file, so we can assert them.
const probeScript = 'echo "$PLAYWRIGHT_BASE_URL" > pw-probe.txt; pwd >> pw-probe.txt';

function ctxFor(workspaceDir: string): ProofContext {
  const workflow = {
    forge: 'gitlab', project: 'group/repo', botUser: 'maestro-bot', manageBoard: true,
    trigger: { assignee: 'bot', requireLabel: null, allowedActors: [] },
    proof: { type: 'playwright', command: probeScript },
    review: { changesSignal: 'label' },
    git: { defaultBranch: 'main', target: 'main', mergeStrategy: 'squash', deleteSourceBranch: true },
    environment: { baseUrl: 'http://localhost:3000' },
    claude: { command: 'claude', maxTurns: 40, permissionMode: 'acceptEdits' },
    concurrency: {}, promptBody: '',
  } as WorkflowConfig;
  // Real exec seam so the probe script actually runs and writes pw-probe.txt.
  return { workspaceDir, workflow, exec: execaRunner };
}

describe('playwrightProof', () => {
  let ws: string;
  beforeEach(async () => { ws = await mkdtemp(join(tmpdir(), 'maestro-pw-')); });

  it('runs the command in the workspace with the base URL exported and returns a video artifact', async () => {
    const artifacts = await playwrightProof.run(ctxFor(ws));
    const probe = await readFile(join(ws, 'pw-probe.txt'), 'utf8');
    expect(probe).toContain('http://localhost:3000');
    expect(probe).toContain(ws);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].kind).toBe('video');
    expect(artifacts[0].path).toBe('proof/test-results');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core test proof/playwright.test.ts`
Expected: FAIL — `Cannot find module './playwright.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/proof/playwright.ts
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProofArtifact, ProofContext, ProofStrategy } from './index.js';

// Artifact path is workspace-relative and lives under proof/ so the handoff
// routine commits it; Playwright is directed to write here via PLAYWRIGHT_OUTPUT_DIR.
const RESULTS_PATH = 'proof/test-results';

export const playwrightProof: ProofStrategy = {
  async run(ctx: ProofContext): Promise<ProofArtifact[]> {
    const command = ctx.workflow.proof.command;
    if (!command) throw new Error('playwright proof requires workflow.proof.command');

    const baseUrl = ctx.workflow.environment?.baseUrl;
    const env: Record<string, string> = { PLAYWRIGHT_OUTPUT_DIR: RESULTS_PATH };
    if (baseUrl) env.PLAYWRIGHT_BASE_URL = baseUrl;

    await mkdir(join(ctx.workspaceDir, RESULTS_PATH), { recursive: true });

    // Run through the shared exec seam (ctx.exec). The runner never rejects on a
    // non-zero exit — a failing assertion still produces a video worth posting.
    await ctx.exec.run('sh', ['-c', command], { cwd: ctx.workspaceDir, env });

    return [
      {
        path: RESULTS_PATH,
        kind: 'video',
        caption: baseUrl ? `Playwright run against ${baseUrl}` : 'Playwright run',
      },
    ];
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/core test proof/playwright.test.ts`
Expected: PASS (1 passed).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/proof/playwright.ts packages/core/src/proof/playwright.test.ts
git commit -m "feat(proof): add playwright proof strategy targeting environment.baseUrl"
```

---

## Task 6: Wire all strategies into `runProof` + comment renderer

**Files:**
- Modify: `packages/core/src/proof/index.ts`
- Modify: `packages/core/src/proof/index.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/proof/index.test.ts` (inside the existing file, after the `'none'` test, plus a new import line):

```ts
// add to imports at top of packages/core/src/proof/index.test.ts:
import { renderArtifactComment, type ProofArtifact } from './index.js';
import { RecordingForge } from '../../test/recordingForge.js';

// add inside describe('runProof', ...) or a new describe block:
describe('runProof dispatch', () => {
  it('throws for an unknown proof type at runtime', async () => {
    const ctx: ProofContext = {
      workspaceDir: '/tmp/ws',
      // force-cast to exercise the default branch
      workflow: workflow({ type: 'bogus' as never }),
      exec: noopExec,
    };
    await expect(runProof(ctx)).rejects.toThrow(/unknown proof type/);
  });
});

describe('renderArtifactComment', () => {
  const adapter = new RecordingForge();
  const branch = 'maestro/issue-7';

  it('returns a "no proof artifacts" note for an empty list', () => {
    expect(renderArtifactComment(adapter, branch, [])).toContain('No proof artifacts');
  });

  it('renders each artifact as a markdown line with a blobUrl link', () => {
    const artifacts: ProofArtifact[] = [
      { path: 'proof/test-results', kind: 'video', caption: 'Playwright run' },
      { path: 'proof/maestro-proof-test-output.txt', kind: 'text', caption: 'Test output (exit 0)' },
    ];
    const out = renderArtifactComment(adapter, branch, artifacts);
    expect(out).toContain('## Proof');
    // links are the contract — each artifact is a blobUrl on the MR branch.
    expect(out).toContain(`**video** — [Playwright run](${adapter.blobUrl(branch, 'proof/test-results')})`);
    expect(out).toContain(
      `**text** — [Test output (exit 0)](${adapter.blobUrl(branch, 'proof/maestro-proof-test-output.txt')})`,
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @maestro/core test proof/index.test.ts`
Expected: FAIL — `renderArtifactComment is not a function` and the unknown-type test fails because real strategies aren't wired (the dispatch test itself passes only once `default` remains for unknown types; it should already throw, but `renderArtifactComment` import breaks compilation so the whole file fails).

- [ ] **Step 3: Write the implementation**

Replace the body of `packages/core/src/proof/index.ts` (keeping the type exports) with the full wiring:

```ts
// packages/core/src/proof/index.ts
import type { WorkflowConfig } from '../workflow/schema.js';
import type { ForgeAdapter } from '../forge/adapter.js';
import type { CommandRunner } from '../util/exec.js';
import { testOutputProof } from './testOutput.js';
import { diffSummaryProof } from './diffSummary.js';
import { playwrightProof } from './playwright.js';

export interface ProofArtifact {
  path: string;
  kind: 'video' | 'image' | 'text';
  caption: string;
}

export interface ProofContext {
  workspaceDir: string;
  workflow: WorkflowConfig;
  exec: CommandRunner;   // shared exec seam (util/exec.ts); strategies run subprocesses through it
}

export interface ProofStrategy {
  run(ctx: ProofContext): Promise<ProofArtifact[]>;
}

const noneProof: ProofStrategy = {
  async run(): Promise<ProofArtifact[]> {
    return [];
  },
};

export async function runProof(ctx: ProofContext): Promise<ProofArtifact[]> {
  switch (ctx.workflow.proof.type) {
    case 'none':
      return noneProof.run(ctx);
    case 'test-output':
      return testOutputProof.run(ctx);
    case 'diff-summary':
      return diffSummaryProof.run(ctx);
    case 'playwright':
      return playwrightProof.run(ctx);
    default:
      throw new Error(`unknown proof type: ${ctx.workflow.proof.type}`);
  }
}

// Render artifacts as a comment body. Proof artifacts are committed to the MR
// branch (contract "Handoff order" step 2), so each is linked via adapter.blobUrl
// — links are the contract; inline ![]() embedding is not guaranteed for private repos.
export function renderArtifactComment(
  adapter: ForgeAdapter,
  branch: string,
  artifacts: ProofArtifact[],
): string {
  if (artifacts.length === 0) {
    return '## Proof\n\nNo proof artifacts produced for this change.';
  }
  const lines = artifacts.map(
    (a) => `- **${a.kind}** — [${a.caption}](${adapter.blobUrl(branch, a.path)})`,
  );
  return ['## Proof', '', ...lines, ''].join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @maestro/core test proof/index.test.ts`
Expected: PASS (4 passed: none, unknown-type, empty render, populated render).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/proof/index.ts packages/core/src/proof/index.test.ts
git commit -m "feat(proof): wire all strategies into runProof and add comment renderer"
```

---

## Task 7: `runHandoff` routine — proof commit + push, then link BEFORE assign reviewer

**Files:**
- Modify: `packages/core/src/reconciler/index.ts`
- Test: `packages/core/src/reconciler/handoff.test.ts`

> Contract "Handoff order" (the `work` executor's inline routine on agent `done`):
> 1. `runProof(ctx)` → strategies write into `<workspaceDir>/proof/`.
> 2. **commit + push** `proof/` to the MR branch (`chore: add proof artifacts for #<n>`).
> 3. **comment** on **both** the issue and the MR, linking each committed file via `adapter.blobUrl(branch, path)`.
> 4. `assignReviewer(mr, reviewer)`.
> 5. `setMrReady(mr)`.
> 6. `setLifecycleLabel(issue, 'in_review')`.
>
> The test asserts both the recorded git invocations (proof-commit step) and the exact adapter call order. This is the load-bearing test of M4. `runHandoff` is the inline routine invoked by the `work` executor — it is NOT a returned `Action` and takes no per-executor deps bag; its collaborators (`adapter`, the `exec: CommandRunner` from `ReconcileDeps.exec`, `proofCtx`, ...) are passed as plain parameters and sourced from `ReconcileDeps` at the call site. The proof `ProofContext` carries the same seam via `ProofContext.exec`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/reconciler/handoff.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHandoff } from './index.js';
import { RecordingForge, RecordingRunner } from '../../test/recordingForge.js';
import type { ProofContext } from '../proof/index.js';
import type { CommandRunner } from '../util/exec.js';
import type { WorkflowConfig } from '../workflow/schema.js';

function proofCtx(workspaceDir: string, exec: CommandRunner): ProofContext {
  const workflow = {
    forge: 'gitlab', project: 'group/repo', botUser: 'maestro-bot', manageBoard: true,
    trigger: { assignee: 'bot', requireLabel: null, allowedActors: [] },
    proof: { type: 'none' },   // 'none' keeps the handoff test pure (no subprocess)
    review: { changesSignal: 'label' },
    git: { defaultBranch: 'main', target: 'main', mergeStrategy: 'squash', deleteSourceBranch: true },
    claude: { command: 'claude', maxTurns: 40, permissionMode: 'acceptEdits' },
    concurrency: {}, promptBody: '',
  } as WorkflowConfig;
  return { workspaceDir, workflow, exec };
}

describe('runHandoff', () => {
  let ws: string;
  beforeEach(async () => { ws = await mkdtemp(join(tmpdir(), 'maestro-handoff-')); });

  it('commits+pushes proof, then links it on issue and MR before assigning, readying, labelling', async () => {
    const adapter = new RecordingForge();
    const exec = new RecordingRunner();
    await runHandoff({
      adapter,
      exec,
      proofCtx: proofCtx(ws, exec),
      branch: 'maestro/issue-7',
      issueNumber: 7,
      mrNumber: 42,
      reviewerUsername: 'alice',
    });

    // Step 2: proof committed + pushed to the MR branch.
    expect(exec.calls).toEqual([
      'git add proof/',
      'git commit -m chore: add proof artifacts for #7',
      'git push -u origin maestro/issue-7',
    ]);

    // Steps 3–6: comment issue+MR, then assign, ready, label — exact order.
    expect(adapter.calls).toEqual([
      'comment(issue:7)',
      'comment(mr:42)',
      'assignReviewer(42,alice)',
      'setMrReady(42)',
      'setLifecycleLabel(7,in_review)',
    ]);
  });

  it('comments proof on both targets strictly before assignReviewer', async () => {
    const adapter = new RecordingForge();
    const exec = new RecordingRunner();
    await runHandoff({
      adapter, exec, proofCtx: proofCtx(ws, exec), branch: 'maestro/issue-1',
      issueNumber: 1, mrNumber: 2, reviewerUsername: 'bob',
    });
    const issueComment = adapter.calls.indexOf('comment(issue:1)');
    const mrComment = adapter.calls.indexOf('comment(mr:2)');
    const assign = adapter.calls.indexOf('assignReviewer(2,bob)');
    expect(issueComment).toBeGreaterThanOrEqual(0);
    expect(mrComment).toBeGreaterThanOrEqual(0);
    expect(issueComment).toBeLessThan(assign);
    expect(mrComment).toBeLessThan(assign);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core test reconciler/handoff.test.ts`
Expected: FAIL — `runHandoff is not a function` / not exported from `./index.js`.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/core/src/reconciler/index.ts` (add imports at the top; keep the existing M1 `reconcileRepo` content intact). No per-executor deps bag is introduced — `runHandoff` takes plain parameters sourced from `ReconcileDeps` at the call site.

```ts
// --- add to imports at top of packages/core/src/reconciler/index.ts ---
import type { ForgeAdapter } from '../forge/adapter.js';
import type { CommandRunner } from '../util/exec.js';
import { runProof, renderArtifactComment, type ProofContext } from '../proof/index.js';

// --- append to packages/core/src/reconciler/index.ts ---

// Handoff order step 2: commit + push the proof/ dir to the MR branch.
// Plain `git push -u origin <branch>` per contract (no --force; agents don't amend).
// `exec` is ReconcileDeps.exec, the shared util/exec.ts seam.
export async function commitProof(
  exec: CommandRunner,
  workspaceDir: string,
  branch: string,
  issueNumber: number,
): Promise<void> {
  const opts = { cwd: workspaceDir };
  await exec.run('git', ['add', 'proof/'], opts);
  await exec.run('git', ['commit', '-m', `chore: add proof artifacts for #${issueNumber}`], opts);
  await exec.run('git', ['push', '-u', 'origin', branch], opts);
}

// The inline handoff routine, invoked by the `work` executor on agent `done`.
// Contract "Handoff order": runProof → commit+push proof/ → comment (issue + MR)
// with blobUrl links → assignReviewer → setMrReady → setLifecycleLabel(in_review).
export async function runHandoff(args: {
  adapter: ForgeAdapter;
  exec: CommandRunner;        // = ReconcileDeps.exec
  proofCtx: ProofContext;
  branch: string;
  issueNumber: number;
  mrNumber: number;
  reviewerUsername: string; // = issue.authorUsername, resolved by the caller
}): Promise<void> {
  const { adapter, exec, proofCtx, branch, issueNumber, mrNumber, reviewerUsername } = args;

  // 1. Generate proof artifacts into <workspaceDir>/proof/.
  const artifacts = await runProof(proofCtx);

  // 2. Commit + push proof/ to the MR branch.
  await commitProof(exec, proofCtx.workspaceDir, branch, issueNumber);

  // 3. Comment on BOTH issue and MR, linking each committed file via blobUrl.
  const body = renderArtifactComment(adapter, branch, artifacts);
  await adapter.comment({ type: 'issue', number: issueNumber }, body);
  await adapter.comment({ type: 'mr', number: mrNumber }, body);

  // 4–6. Assign the reviewer, ready the MR, flip the lifecycle label.
  await adapter.assignReviewer(mrNumber, reviewerUsername);
  await adapter.setMrReady(mrNumber);
  await adapter.setLifecycleLabel(issueNumber, 'in_review');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/core test reconciler/handoff.test.ts`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/reconciler/index.ts packages/core/src/reconciler/handoff.test.ts
git commit -m "feat(reconciler): add handoff routine committing proof and linking via blobUrl"
```

---

## Task 8: `runMerge` — merge with WORKFLOW.md git rules

**Files:**
- Modify: `packages/core/src/reconciler/index.ts`
- Test: `packages/core/src/reconciler/merge.test.ts`

> Issue auto-closes via the MR's `Closes #N` body, so the routine only invokes `mergeMr`. `runMerge` is the body of the `merge` case in `executeAction`; it takes plain parameters (no per-executor deps bag), sourced from `(snapshot, deps)` at the call site.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/reconciler/merge.test.ts
import { describe, it, expect } from 'vitest';
import { runMerge } from './index.js';
import { RecordingForge } from '../../test/recordingForge.js';
import type { WorkflowConfig } from '../workflow/schema.js';

function workflow(mergeStrategy: 'squash' | 'merge' | 'rebase', deleteSourceBranch: boolean): WorkflowConfig {
  return {
    forge: 'gitlab', project: 'group/repo', botUser: 'maestro-bot', manageBoard: true,
    trigger: { assignee: 'bot', requireLabel: null, allowedActors: [] },
    proof: { type: 'none' },
    review: { changesSignal: 'label' },
    git: { defaultBranch: 'main', target: 'main', mergeStrategy, deleteSourceBranch },
    claude: { command: 'claude', maxTurns: 40, permissionMode: 'acceptEdits' },
    concurrency: {}, promptBody: '',
  } as WorkflowConfig;
}

describe('runMerge', () => {
  it('merges using the workflow git strategy and delete-source-branch flag', async () => {
    const adapter = new RecordingForge();
    await runMerge(adapter, 42, workflow('squash', true));
    expect(adapter.calls).toEqual(['mergeMr(42,squash,true)']);
  });

  it('honours an alternative strategy and flag', async () => {
    const adapter = new RecordingForge();
    await runMerge(adapter, 9, workflow('rebase', false));
    expect(adapter.calls).toEqual(['mergeMr(9,rebase,false)']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core test reconciler/merge.test.ts`
Expected: FAIL — `runMerge is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/core/src/reconciler/index.ts` (add the `WorkflowConfig` import if not already present):

```ts
// --- add to imports at top of packages/core/src/reconciler/index.ts (if not present) ---
import type { WorkflowConfig } from '../workflow/schema.js';

// --- append to packages/core/src/reconciler/index.ts ---

// Body of the `merge` case in executeAction. Merge per the repo's own git rules.
// The issue auto-closes via the MR's "Closes #N" body, so no explicit close is needed.
export async function runMerge(
  adapter: ForgeAdapter,
  mrNumber: number,
  workflow: WorkflowConfig,
): Promise<void> {
  await adapter.mergeMr(mrNumber, workflow.git.mergeStrategy, workflow.git.deleteSourceBranch);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/core test reconciler/merge.test.ts`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/reconciler/index.ts packages/core/src/reconciler/merge.test.ts
git commit -m "feat(reconciler): add merge routine using workflow git strategy"
```

---

## Task 9: `runReviewCheck` — approved→merge, changes→back to in_progress

**Files:**
- Modify: `packages/core/src/reconciler/index.ts`
- Test: `packages/core/src/reconciler/reviewCheck.test.ts`

> Per the contract: **approved** → perform the merge; **changes requested** → flip the label to `in_progress` AND comment acknowledging the feedback so the agent picks it up next tick. If neither, do nothing (keep polling). `mr.changesRequested` is derived in the adapter per `workflow.review.changesSignal`, so this routine just reads the flag. `runReviewCheck` is the body of the `review_check` case in `executeAction`; it takes plain parameters (no per-executor deps bag), sourced from `(snapshot, deps)` at the call site.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/reconciler/reviewCheck.test.ts
import { describe, it, expect } from 'vitest';
import { runReviewCheck } from './index.js';
import { RecordingForge } from '../../test/recordingForge.js';
import type { MergeRequest } from '../domain/types.js';
import type { WorkflowConfig } from '../workflow/schema.js';

function mr(over: Partial<MergeRequest>): MergeRequest {
  return {
    id: 'm1', number: 42, sourceBranch: 'maestro/issue-7', targetBranch: 'main',
    isDraft: false, state: 'open', approved: false, changesRequested: false,
    reviewers: [], linkedIssueNumbers: [7], description: '', webUrl: 'http://x', ...over,
  };
}

const workflow = {
  forge: 'gitlab', project: 'group/repo', botUser: 'maestro-bot', manageBoard: true,
  trigger: { assignee: 'bot', requireLabel: null, allowedActors: [] },
  proof: { type: 'none' },
  review: { changesSignal: 'label' },
  git: { defaultBranch: 'main', target: 'main', mergeStrategy: 'squash', deleteSourceBranch: true },
  claude: { command: 'claude', maxTurns: 40, permissionMode: 'acceptEdits' },
  concurrency: {}, promptBody: '',
} as WorkflowConfig;

describe('runReviewCheck', () => {
  it('merges when the MR is approved', async () => {
    const adapter = new RecordingForge();
    await runReviewCheck(adapter, 7, mr({ approved: true }), workflow);
    expect(adapter.calls).toEqual(['mergeMr(42,squash,true)']);
  });

  it('flips to in_progress and comments acknowledgement when changes are requested', async () => {
    const adapter = new RecordingForge();
    await runReviewCheck(adapter, 7, mr({ changesRequested: true }), workflow);
    expect(adapter.calls).toEqual([
      'setLifecycleLabel(7,in_progress)',
      'comment(mr:42)',
    ]);
  });

  it('does nothing when neither approved nor changes requested', async () => {
    const adapter = new RecordingForge();
    await runReviewCheck(adapter, 7, mr({}), workflow);
    expect(adapter.calls).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core test reconciler/reviewCheck.test.ts`
Expected: FAIL — `runReviewCheck is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/core/src/reconciler/index.ts` (reuses `MergeRequest` — add the type import if not present):

```ts
// --- add to imports at top of packages/core/src/reconciler/index.ts (if not present) ---
import type { MergeRequest } from '../domain/types.js';

// --- append to packages/core/src/reconciler/index.ts ---

const FEEDBACK_ACK =
  'Thanks for the review — picking up the requested changes and will push updates shortly.';

// Body of the `review_check` case in executeAction. mr.changesRequested is derived
// in the adapter per workflow.review.changesSignal; this routine just reads it.
//  approved          -> merge per workflow git rules
//  changesRequested  -> flip label to in_progress + ack comment (agent resumes next tick)
//  neither           -> noop (keep polling)
export async function runReviewCheck(
  adapter: ForgeAdapter,
  issueNumber: number,
  mr: MergeRequest,
  workflow: WorkflowConfig,
): Promise<void> {
  if (mr.approved) {
    await runMerge(adapter, mr.number, workflow);
    return;
  }

  if (mr.changesRequested) {
    await adapter.setLifecycleLabel(issueNumber, 'in_progress');
    await adapter.comment({ type: 'mr', number: mr.number }, FEEDBACK_ACK);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/core test reconciler/reviewCheck.test.ts`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/reconciler/index.ts packages/core/src/reconciler/reviewCheck.test.ts
git commit -m "feat(reconciler): add review_check routine for approval and changes-requested"
```

---

## Task 10: Wire executeAction cases + full-suite green + public exports

**Files:**
- Modify: `packages/core/src/reconciler/index.ts`
- Modify: `packages/core/src/index.ts`

> Wire the M4 routines into the single internal `executeAction(action, snapshot, deps: ReconcileDeps)` dispatcher (contract "Reconciler orchestration"), then surface the proof API and routines through the package barrel.

- [ ] **Step 0: Wire the `handoff`/`review_check`/`merge` cases into `executeAction`**

In `packages/core/src/reconciler/index.ts`, the internal `executeAction` switch routes to the M4 routines, sourcing every collaborator from the single `ReconcileDeps` bag (no per-executor bags). The `work` executor invokes `runHandoff` inline on agent `done` (the `handoff` kind is never returned by `decideAction`). Sketch:

```ts
// inside executeAction(action, snapshot, deps: ReconcileDeps)
case 'review_check':
  await runReviewCheck(deps.adapter, action.issueNumber, snapshot.mr!, deps.workflow);
  break;
case 'merge':
  await runMerge(deps.adapter, snapshot.mr!.number, deps.workflow);
  break;
// 'handoff' is NOT a case here — it is invoked inline by the 'work' executor on
// agent `done`, e.g.:
//   await runHandoff({
//     adapter: deps.adapter, exec: deps.exec /* CommandRunner from ReconcileDeps */,
//     proofCtx: { workspaceDir, workflow: deps.workflow, exec: deps.exec },
//     branch: `maestro/issue-${action.issueNumber}`,
//     issueNumber: action.issueNumber, mrNumber: snapshot.mr!.number,
//     reviewerUsername: snapshot.issue.authorUsername,
//   });
```

> Both `runHandoff`'s `exec` and the `ProofContext.exec` are sourced from `ReconcileDeps.exec` (the shared `util/exec.ts` seam, default `execaRunner`), so proof strategies and the proof-commit step run through one injectable runner.

- [ ] **Step 1: Add exports to the barrel**

> Surface the M4 proof API and reconciler routines through the package barrel so M5 (CLI/web) and the daemon loop can import them. No per-executor deps bags are exported (forbidden by the contract); the routines take plain parameters and the single `ReconcileDeps` bag (M1) wires them into `executeAction`.

- [ ] **Step 1: Add exports to the barrel**

Append to `packages/core/src/index.ts`:

```ts
export {
  runProof,
  renderArtifactComment,
  type ProofArtifact,
  type ProofContext,
  type ProofStrategy,
} from './proof/index.js';
export {
  runHandoff,
  commitProof,
  runReviewCheck,
  runMerge,
} from './reconciler/index.js';
```

- [ ] **Step 2: Run the full core test suite**

Run: `pnpm --filter @maestro/core test`
Expected: PASS — all M4 suites green (`proof/index`, `proof/testOutput`, `proof/diffSummary`, `proof/playwright`, `reconciler/handoff`, `reconciler/merge`, `reconciler/reviewCheck`) plus existing M1/M3 suites unaffected.

- [ ] **Step 3: Typecheck the package**

Run: `pnpm --filter @maestro/core exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/reconciler/index.ts packages/core/src/index.ts
git commit -m "feat(core): wire executeAction cases and export proof API + reconciler routines"
```

---

## Self-Review (performed against contracts)

- **Proof strategies (contract `ProofStrategy`/`runProof`):** `none` (Task 1), `test-output` (Task 3), `diff-summary` (Task 4), `playwright` (Task 5), all dispatched by `runProof` (Task 6). Each writes into `<workspaceDir>/proof/`; `ProofArtifact.path` is workspace-relative. Covered.
- **Handoff order (contract "Handoff order"):** runProof → commit+push `proof/` (`chore: add proof artifacts for #<n>`) → comment issue+MR with `blobUrl` links → assignReviewer → setMrReady → setLifecycleLabel(in_review), asserted by exact runner + adapter call-order test (Task 7). Covered.
- **review_check (contract):** approved→merge, changesRequested→in_progress+comment; `mr.changesRequested` derived in adapter per `review.changesSignal` (Task 9). Covered.
- **merge (contract):** `mergeMr(mrNumber, mergeStrategy, deleteSourceBranch)`; auto-close via `Closes #N` (Task 8). Covered.
- **Executor architecture (contract "Reconciler orchestration"):** no per-executor deps bags — `runHandoff`/`runReviewCheck`/`runMerge`/`commitProof` take plain parameters and are wired into the single `executeAction(action, snapshot, deps: ReconcileDeps)` (Task 10); `handoff` is an inline routine invoked by the `work` executor, never a returned `Action`. The proof-commit step and proof strategies run through `deps.exec`/`ProofContext.exec` (both = `ReconcileDeps.exec`, the shared `util/exec.ts` seam). Covered.
- **changesRequested / review (contract):** every `WorkflowConfig` fixture carries `review: { changesSignal: 'label' }`. Covered.
- **Type consistency:** `ProofArtifact`/`ProofContext`/`ProofStrategy`/`runProof` match contracts exactly; `renderArtifactComment(adapter, branch, artifacts)` emits `blobUrl` links; `RecordingForge` implements `getMrDescription`, `createIssue`, `blobUrl`. `setLifecycleLabel` takes `LifecycleState`. `mergeMr` arg order matches `ForgeAdapter`.
- **No placeholders:** every code/command step is complete.

---

## Open questions

None. All M4 contract dependencies are resolved: proof artifacts live under `proof/`, are committed/pushed and linked via `blobUrl`; the handoff routine and proof strategies source their `CommandRunner` from `ReconcileDeps.exec` / `ProofContext.exec`; `review.changesSignal` is on every fixture; the reconciler uses the single `ReconcileDeps` bag with no per-executor bags.
