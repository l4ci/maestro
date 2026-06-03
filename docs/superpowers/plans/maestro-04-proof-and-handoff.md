# Maestro M4 — Proof & Handoff/Approval/Merge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the pluggable proof generator (`playwright` | `test-output` | `diff-summary` | `none`) and wire the reconciler's `handoff`, `review_check`, and `merge` executors so that — per spec §7 — proof is generated and posted to the issue **and** the MR *before* the reviewer is assigned, then the MR is un-drafted and labelled `in_review`; approval triggers a forge merge with the repo's git rules, and requested-changes bounce the issue back to `in_progress`.

**Architecture:** Proof strategies live in `packages/core/src/proof/`. Each strategy implements `ProofStrategy.run(ctx)` and returns `ProofArtifact[]`. `runProof(ctx)` dispatches on `ctx.workflow.proof.type`. Strategies run `workflow.proof.command` (and, for playwright, target `workflow.environment.baseUrl` against an already-running local instance per spec §6/§14) inside the issue workspace via `execa`. The three executors are added to `reconciler/index.ts`; they consume a `ForgeAdapter` (M1), a `ProofContext` built from the M3 workspace dir + loaded `WorkflowConfig`, and call `runProof` then the adapter methods in the spec-guaranteed order. Because `ForgeAdapter.comment` accepts **text only** (no file upload — see Open questions), proof artifacts are posted as a Markdown text reference listing each artifact's relative path, kind, and caption.

**Tech Stack:** Node 20+, TypeScript 5.x, ESM. Vitest (colocated `*.test.ts`). `execa` for subprocess. pnpm workspaces (`@maestro/core`). All proof strategies and executor tests use a small POSIX shell script fixture for the proof command and a recording fake `ForgeAdapter` for order assertions.

**Depends on:** M1 (reconciler/lifecycle: `domain/types.ts`, `domain/lifecycle.ts`, `forge/adapter.ts` `ForgeAdapter`/`ForgeError`, `forge/memory.ts` `MemoryForge`, `reconciler/derive.ts`, `reconciler/decide.ts`, `reconciler/index.ts` skeleton), M3 (`workspace/manager.ts` `WorkspaceManager` — proof commands run in the workspace dir returned by `ensure()`/`pathFor()`).

---

## File Structure

| Path | Responsibility | Action |
|---|---|---|
| `packages/core/src/proof/index.ts` | `ProofStrategy`, `ProofArtifact`, `ProofContext` types; `runProof(ctx)` dispatcher on `ctx.workflow.proof.type`; `renderArtifactComment(artifacts)` helper (text rendering of artifacts for `comment`). | Create |
| `packages/core/src/proof/index.test.ts` | Dispatch tests: each `proof.type` routes to its strategy; `'none'` returns `[]`; comment renderer output. | Create |
| `packages/core/src/proof/playwright.ts` | `playwrightProof: ProofStrategy` — runs `workflow.proof.command` in `workspaceDir` against `workflow.environment.baseUrl`, returns a `video` artifact pointing at the playwright output dir. | Create |
| `packages/core/src/proof/playwright.test.ts` | Runs against a stub script; asserts command executed in cwd, env carries base URL, returns a `video` artifact. | Create |
| `packages/core/src/proof/testOutput.ts` | `testOutputProof: ProofStrategy` — runs `workflow.proof.command`, writes captured stdout+stderr to a file, returns a `text` artifact. | Create |
| `packages/core/src/proof/testOutput.test.ts` | Stub script; asserts stdout+stderr captured to file and returned as `text` artifact even on non-zero exit. | Create |
| `packages/core/src/proof/diffSummary.ts` | `diffSummaryProof: ProofStrategy` — runs `git diff --stat <defaultBranch>...HEAD` in `workspaceDir`, writes summary to a file, returns a `text` artifact. | Create |
| `packages/core/src/proof/diffSummary.test.ts` | Temp git repo with a committed change; asserts diff summary file contains the changed filename. | Create |
| `packages/core/src/reconciler/index.ts` | Add `executeHandoff`, `executeReviewCheck`, `executeMerge` executors (exported), wired in spec-§7 order. | Modify |
| `packages/core/src/reconciler/handoff.test.ts` | Recording fake adapter; asserts proof posted to issue AND mr **before** `assignReviewer`, then `setMrReady`, then `setLifecycleLabel(in_review)`. | Create |
| `packages/core/src/reconciler/reviewCheck.test.ts` | Approved → merge invoked; changesRequested → `setLifecycleLabel(in_progress)` + ack comment. | Create |
| `packages/core/src/reconciler/merge.test.ts` | `executeMerge` calls `adapter.mergeMr(mrNumber, workflow.git.mergeStrategy, workflow.git.deleteSourceBranch)`. | Create |
| `packages/core/test/fixtures/proof-ok.sh` | Stub proof command (prints to stdout+stderr, exit 0). | Create |
| `packages/core/test/fixtures/proof-fail.sh` | Stub proof command (prints, exit 1). | Create |
| `packages/core/test/recordingForge.ts` | Reusable recording fake `ForgeAdapter` that appends every write-call to an ordered `calls: string[]` log. | Create |

> **Note on executor signatures (contracts gap):** `reconciler/index.ts` exists from M1 as `reconcileRepo(...)` but the contracts do not specify the executor function signatures or how a tick supplies the loaded `WorkflowConfig`, the workspace dir, or the `ProofContext` to the execute phase. This plan defines minimal executor signatures (below) and FLAGS the broader wiring in **Open questions**. The executors are pure functions of `(adapter, deps)` so they are independently unit-testable without inventing daemon plumbing.

**Executor signatures introduced by this plan (M4-local, flagged in Open questions):**

```ts
export interface HandoffDeps {
  adapter: ForgeAdapter;
  proofCtx: ProofContext;     // { workspaceDir, workflow }
  issueNumber: number;
  mrNumber: number;
  reviewerUsername: string;   // = issue.authorUsername (caller resolves)
}
export async function executeHandoff(deps: HandoffDeps): Promise<void>;

export interface ReviewCheckDeps {
  adapter: ForgeAdapter;
  issueNumber: number;
  mr: MergeRequest;
  workflow: WorkflowConfig;
}
export async function executeReviewCheck(deps: ReviewCheckDeps): Promise<void>;

export interface MergeDeps {
  adapter: ForgeAdapter;
  mrNumber: number;
  workflow: WorkflowConfig;
}
export async function executeMerge(deps: MergeDeps): Promise<void>;
```

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
import type { WorkflowConfig } from '../workflow/schema.js';

function workflow(proof: WorkflowConfig['proof']): WorkflowConfig {
  return {
    forge: 'gitlab',
    project: 'group/repo',
    botUser: 'maestro-bot',
    manageBoard: true,
    trigger: { assignee: 'bot', requireLabel: null, allowedActors: [] },
    proof,
    git: { defaultBranch: 'main', target: 'main', mergeStrategy: 'squash', deleteSourceBranch: true },
    claude: { command: 'claude', maxTurns: 40, permissionMode: 'acceptEdits' },
    concurrency: {},
    promptBody: '',
  };
}

describe('runProof', () => {
  it('returns no artifacts for the "none" strategy', async () => {
    const ctx: ProofContext = { workspaceDir: '/tmp/ws', workflow: workflow({ type: 'none' }) };
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

export interface ProofArtifact {
  path: string;
  kind: 'video' | 'image' | 'text';
  caption: string;
}

export interface ProofContext {
  workspaceDir: string;
  workflow: WorkflowConfig;
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

- [ ] **Step 4: Create the recording fake adapter**

```ts
// packages/core/test/recordingForge.ts
import type { ForgeAdapter, CreateMrArgs, CommentTarget } from '../src/forge/adapter.js';
import type { Forge, Issue, MergeRequest, LifecycleState, MergeStrategy } from '../src/domain/types.js';

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

  async createBranch(name: string, fromRef: string): Promise<void> { this.calls.push(`createBranch(${name},${fromRef})`); }
  async createDraftMr(args: CreateMrArgs): Promise<MergeRequest> { this.calls.push(`createDraftMr(${args.sourceBranch})`); throw new Error('not used'); }
  async setMrReady(mrNumber: number): Promise<void> { this.calls.push(`setMrReady(${mrNumber})`); }
  async updateMrDescription(mrNumber: number, body: string): Promise<void> { this.calls.push(`updateMrDescription(${mrNumber})`); }
  async assignReviewer(mrNumber: number, username: string): Promise<void> { this.calls.push(`assignReviewer(${mrNumber},${username})`); }
  async mergeMr(mrNumber: number, strategy: MergeStrategy, deleteSource: boolean): Promise<void> { this.calls.push(`mergeMr(${mrNumber},${strategy},${deleteSource})`); }
  async comment(target: CommentTarget, body: string): Promise<void> { this.calls.push(`comment(${target.type}:${target.number})`); }
  async setLifecycleLabel(issueNumber: number, state: LifecycleState): Promise<void> { this.calls.push(`setLifecycleLabel(${issueNumber},${state})`); }
  async ensureLabels(): Promise<void> { this.calls.push('ensureLabels'); }
  async ensureBoard(): Promise<void> { this.calls.push('ensureBoard'); }
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
import type { WorkflowConfig } from '../workflow/schema.js';

const okScript = fileURLToPath(new URL('../../test/fixtures/proof-ok.sh', import.meta.url));
const failScript = fileURLToPath(new URL('../../test/fixtures/proof-fail.sh', import.meta.url));

function ctxFor(command: string, workspaceDir: string): ProofContext {
  const workflow = {
    forge: 'gitlab', project: 'group/repo', botUser: 'maestro-bot', manageBoard: true,
    trigger: { assignee: 'bot', requireLabel: null, allowedActors: [] },
    proof: { type: 'test-output', command },
    git: { defaultBranch: 'main', target: 'main', mergeStrategy: 'squash', deleteSourceBranch: true },
    claude: { command: 'claude', maxTurns: 40, permissionMode: 'acceptEdits' },
    concurrency: {}, promptBody: '',
  } as WorkflowConfig;
  return { workspaceDir, workflow };
}

describe('testOutputProof', () => {
  let ws: string;
  beforeEach(async () => { ws = await mkdtemp(join(tmpdir(), 'maestro-proof-')); });

  it('captures stdout and stderr to a text artifact', async () => {
    const [artifact] = await testOutputProof.run(ctxFor(okScript, ws));
    expect(artifact.kind).toBe('text');
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
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import type { ProofArtifact, ProofContext, ProofStrategy } from './index.js';

const OUTPUT_FILE = 'maestro-proof-test-output.txt';

export const testOutputProof: ProofStrategy = {
  async run(ctx: ProofContext): Promise<ProofArtifact[]> {
    const command = ctx.workflow.proof.command;
    if (!command) throw new Error('test-output proof requires workflow.proof.command');

    // reject: false — capture output even when the command fails the suite.
    const result = await execa(command, {
      cwd: ctx.workspaceDir,
      shell: true,
      reject: false,
      all: true,
    });

    const captured = result.all ?? `${result.stdout}\n${result.stderr}`;
    const body = `$ ${command}\nexit code: ${result.exitCode}\n\n${captured}\n`;
    await writeFile(join(ctx.workspaceDir, OUTPUT_FILE), body, 'utf8');

    return [
      {
        path: OUTPUT_FILE,
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
import type { WorkflowConfig } from '../workflow/schema.js';

function ctxFor(workspaceDir: string): ProofContext {
  const workflow = {
    forge: 'gitlab', project: 'group/repo', botUser: 'maestro-bot', manageBoard: true,
    trigger: { assignee: 'bot', requireLabel: null, allowedActors: [] },
    proof: { type: 'diff-summary' },
    git: { defaultBranch: 'main', target: 'main', mergeStrategy: 'squash', deleteSourceBranch: true },
    claude: { command: 'claude', maxTurns: 40, permissionMode: 'acceptEdits' },
    concurrency: {}, promptBody: '',
  } as WorkflowConfig;
  return { workspaceDir, workflow };
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

  it('writes a diff summary text artifact naming the changed file', async () => {
    const [artifact] = await diffSummaryProof.run(ctxFor(ws));
    expect(artifact.kind).toBe('text');
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
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import type { ProofArtifact, ProofContext, ProofStrategy } from './index.js';

const OUTPUT_FILE = 'maestro-proof-diff-summary.txt';

export const diffSummaryProof: ProofStrategy = {
  async run(ctx: ProofContext): Promise<ProofArtifact[]> {
    const base = ctx.workflow.git.defaultBranch;
    const result = await execa('git', ['diff', '--stat', `${base}...HEAD`], {
      cwd: ctx.workspaceDir,
      reject: false,
    });

    const body = `git diff --stat ${base}...HEAD\n\n${result.stdout}\n`;
    await writeFile(join(ctx.workspaceDir, OUTPUT_FILE), body, 'utf8');

    return [
      {
        path: OUTPUT_FILE,
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

> Per spec §6/§14 the command runs against an already-running local instance reachable at `workflow.environment.baseUrl`. The strategy passes that URL to the command via env (`PLAYWRIGHT_BASE_URL`, a Playwright-recognised convention) and points the returned artifact at Playwright's conventional output dir (`test-results/`), captured as a `video` artifact. The test uses the shell stub (no real browser) and only asserts the contract: command ran in `workspaceDir`, base URL was exported, and a `video` artifact is returned.

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
import type { WorkflowConfig } from '../workflow/schema.js';

// Stub that records its working dir + the base URL env into a file, so we can assert them.
const probeScript = 'echo "$PLAYWRIGHT_BASE_URL" > pw-probe.txt; pwd >> pw-probe.txt';

function ctxFor(workspaceDir: string): ProofContext {
  const workflow = {
    forge: 'gitlab', project: 'group/repo', botUser: 'maestro-bot', manageBoard: true,
    trigger: { assignee: 'bot', requireLabel: null, allowedActors: [] },
    proof: { type: 'playwright', command: probeScript },
    git: { defaultBranch: 'main', target: 'main', mergeStrategy: 'squash', deleteSourceBranch: true },
    environment: { baseUrl: 'http://localhost:3000' },
    claude: { command: 'claude', maxTurns: 40, permissionMode: 'acceptEdits' },
    concurrency: {}, promptBody: '',
  } as WorkflowConfig;
  return { workspaceDir, workflow };
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
    expect(artifacts[0].path).toBe('test-results');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core test proof/playwright.test.ts`
Expected: FAIL — `Cannot find module './playwright.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/proof/playwright.ts
import { execa } from 'execa';
import type { ProofArtifact, ProofContext, ProofStrategy } from './index.js';

// Playwright's conventional artifact directory (videos/screenshots/traces).
const RESULTS_DIR = 'test-results';

export const playwrightProof: ProofStrategy = {
  async run(ctx: ProofContext): Promise<ProofArtifact[]> {
    const command = ctx.workflow.proof.command;
    if (!command) throw new Error('playwright proof requires workflow.proof.command');

    const baseUrl = ctx.workflow.environment?.baseUrl;
    const env: Record<string, string> = {};
    if (baseUrl) env.PLAYWRIGHT_BASE_URL = baseUrl;

    // reject: false — a failing assertion still produces a video worth posting.
    await execa(command, {
      cwd: ctx.workspaceDir,
      shell: true,
      reject: false,
      env,
      extendEnv: true,
    });

    return [
      {
        path: RESULTS_DIR,
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

// add inside describe('runProof', ...) or a new describe block:
describe('runProof dispatch', () => {
  it('throws for an unknown proof type at runtime', async () => {
    const ctx: ProofContext = {
      workspaceDir: '/tmp/ws',
      // force-cast to exercise the default branch
      workflow: workflow({ type: 'bogus' as never }),
    };
    await expect(runProof(ctx)).rejects.toThrow(/unknown proof type/);
  });
});

describe('renderArtifactComment', () => {
  it('returns a "no proof artifacts" note for an empty list', () => {
    expect(renderArtifactComment([])).toContain('No proof artifacts');
  });

  it('renders each artifact as a markdown line with kind, caption and path', () => {
    const artifacts: ProofArtifact[] = [
      { path: 'test-results', kind: 'video', caption: 'Playwright run' },
      { path: 'maestro-proof-test-output.txt', kind: 'text', caption: 'Test output (exit 0)' },
    ];
    const out = renderArtifactComment(artifacts);
    expect(out).toContain('## Proof');
    expect(out).toContain('**video** — Playwright run (`test-results`)');
    expect(out).toContain('**text** — Test output (exit 0) (`maestro-proof-test-output.txt`)');
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

// Render artifacts as a text comment body. ForgeAdapter.comment takes text only
// (no binary upload — see plan Open questions), so we reference each artifact by
// its relative path within the MR's source branch / workspace.
export function renderArtifactComment(artifacts: ProofArtifact[]): string {
  if (artifacts.length === 0) {
    return '## Proof\n\nNo proof artifacts produced for this change.';
  }
  const lines = artifacts.map(
    (a) => `- **${a.kind}** — ${a.caption} (\`${a.path}\`)`,
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

## Task 7: `executeHandoff` — proof BEFORE assign reviewer (ordering guarantee)

**Files:**
- Modify: `packages/core/src/reconciler/index.ts`
- Test: `packages/core/src/reconciler/handoff.test.ts`

> Spec §7 ordering guarantee: `runProof` → comment artifacts on **issue AND MR** → `assignReviewer` → `setMrReady` → `setLifecycleLabel(in_review)`. The test asserts the recorded call order. This is the load-bearing test of M4.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/reconciler/handoff.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeHandoff } from './index.js';
import { RecordingForge } from '../../test/recordingForge.js';
import type { ProofContext } from '../proof/index.js';
import type { WorkflowConfig } from '../workflow/schema.js';

function proofCtx(workspaceDir: string): ProofContext {
  const workflow = {
    forge: 'gitlab', project: 'group/repo', botUser: 'maestro-bot', manageBoard: true,
    trigger: { assignee: 'bot', requireLabel: null, allowedActors: [] },
    proof: { type: 'none' },   // 'none' keeps the handoff test pure (no subprocess)
    git: { defaultBranch: 'main', target: 'main', mergeStrategy: 'squash', deleteSourceBranch: true },
    claude: { command: 'claude', maxTurns: 40, permissionMode: 'acceptEdits' },
    concurrency: {}, promptBody: '',
  } as WorkflowConfig;
  return { workspaceDir, workflow };
}

describe('executeHandoff', () => {
  let ws: string;
  beforeEach(async () => { ws = await mkdtemp(join(tmpdir(), 'maestro-handoff-')); });

  it('posts proof to issue and MR before assigning the reviewer, then readies and labels', async () => {
    const adapter = new RecordingForge();
    await executeHandoff({
      adapter,
      proofCtx: proofCtx(ws),
      issueNumber: 7,
      mrNumber: 42,
      reviewerUsername: 'alice',
    });

    // Exact spec-§7 order.
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
    await executeHandoff({
      adapter, proofCtx: proofCtx(ws), issueNumber: 1, mrNumber: 2, reviewerUsername: 'bob',
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
Expected: FAIL — `executeHandoff is not a function` / not exported from `./index.js`.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/core/src/reconciler/index.ts` (add imports at the top; keep the existing M1 `reconcileRepo` content intact):

```ts
// --- add to imports at top of packages/core/src/reconciler/index.ts ---
import type { ForgeAdapter } from '../forge/adapter.js';
import { runProof, renderArtifactComment, type ProofContext } from '../proof/index.js';

// --- append to packages/core/src/reconciler/index.ts ---

export interface HandoffDeps {
  adapter: ForgeAdapter;
  proofCtx: ProofContext;
  issueNumber: number;
  mrNumber: number;
  reviewerUsername: string; // = issue.authorUsername, resolved by the caller
}

// Spec §7 ordering guarantee: proof is generated and posted to BOTH the issue and
// the MR BEFORE the reviewer is assigned. Assignment is the final pings-the-human
// step, after the MR is readied and the lifecycle label flips to in_review.
export async function executeHandoff(deps: HandoffDeps): Promise<void> {
  const { adapter, proofCtx, issueNumber, mrNumber, reviewerUsername } = deps;

  const artifacts = await runProof(proofCtx);
  const body = renderArtifactComment(artifacts);

  await adapter.comment({ type: 'issue', number: issueNumber }, body);
  await adapter.comment({ type: 'mr', number: mrNumber }, body);

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
git commit -m "feat(reconciler): add handoff executor posting proof before assigning reviewer"
```

---

## Task 8: `executeMerge` — merge with WORKFLOW.md git rules

**Files:**
- Modify: `packages/core/src/reconciler/index.ts`
- Test: `packages/core/src/reconciler/merge.test.ts`

> Issue auto-closes via the MR's `Closes #N` body, so the executor only invokes `mergeMr`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/reconciler/merge.test.ts
import { describe, it, expect } from 'vitest';
import { executeMerge } from './index.js';
import { RecordingForge } from '../../test/recordingForge.js';
import type { WorkflowConfig } from '../workflow/schema.js';

function workflow(mergeStrategy: 'squash' | 'merge' | 'rebase', deleteSourceBranch: boolean): WorkflowConfig {
  return {
    forge: 'gitlab', project: 'group/repo', botUser: 'maestro-bot', manageBoard: true,
    trigger: { assignee: 'bot', requireLabel: null, allowedActors: [] },
    proof: { type: 'none' },
    git: { defaultBranch: 'main', target: 'main', mergeStrategy, deleteSourceBranch },
    claude: { command: 'claude', maxTurns: 40, permissionMode: 'acceptEdits' },
    concurrency: {}, promptBody: '',
  } as WorkflowConfig;
}

describe('executeMerge', () => {
  it('merges using the workflow git strategy and delete-source-branch flag', async () => {
    const adapter = new RecordingForge();
    await executeMerge({ adapter, mrNumber: 42, workflow: workflow('squash', true) });
    expect(adapter.calls).toEqual(['mergeMr(42,squash,true)']);
  });

  it('honours an alternative strategy and flag', async () => {
    const adapter = new RecordingForge();
    await executeMerge({ adapter, mrNumber: 9, workflow: workflow('rebase', false) });
    expect(adapter.calls).toEqual(['mergeMr(9,rebase,false)']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core test reconciler/merge.test.ts`
Expected: FAIL — `executeMerge is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/core/src/reconciler/index.ts` (add the `WorkflowConfig` import if not already present):

```ts
// --- add to imports at top of packages/core/src/reconciler/index.ts (if not present) ---
import type { WorkflowConfig } from '../workflow/schema.js';

// --- append to packages/core/src/reconciler/index.ts ---

export interface MergeDeps {
  adapter: ForgeAdapter;
  mrNumber: number;
  workflow: WorkflowConfig;
}

// Merge per the repo's own git rules. The issue auto-closes via the MR's
// "Closes #N" body, so no explicit issue close is needed.
export async function executeMerge(deps: MergeDeps): Promise<void> {
  const { adapter, mrNumber, workflow } = deps;
  await adapter.mergeMr(
    mrNumber,
    workflow.git.mergeStrategy,
    workflow.git.deleteSourceBranch,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/core test reconciler/merge.test.ts`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/reconciler/index.ts packages/core/src/reconciler/merge.test.ts
git commit -m "feat(reconciler): add merge executor using workflow git strategy"
```

---

## Task 9: `executeReviewCheck` — approved→merge, changes→back to in_progress

**Files:**
- Modify: `packages/core/src/reconciler/index.ts`
- Test: `packages/core/src/reconciler/reviewCheck.test.ts`

> Per spec §7: **approved** → perform the merge; **changes requested** → flip the label to `in_progress` AND comment acknowledging the feedback so the agent picks it up next tick. If neither, do nothing (keep polling).

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/reconciler/reviewCheck.test.ts
import { describe, it, expect } from 'vitest';
import { executeReviewCheck } from './index.js';
import { RecordingForge } from '../../test/recordingForge.js';
import type { MergeRequest } from '../domain/types.js';
import type { WorkflowConfig } from '../workflow/schema.js';

function mr(over: Partial<MergeRequest>): MergeRequest {
  return {
    id: 'm1', number: 42, sourceBranch: 'maestro/issue-7', targetBranch: 'main',
    isDraft: false, state: 'open', approved: false, changesRequested: false,
    reviewers: [], linkedIssueNumbers: [7], webUrl: 'http://x', ...over,
  };
}

const workflow = {
  forge: 'gitlab', project: 'group/repo', botUser: 'maestro-bot', manageBoard: true,
  trigger: { assignee: 'bot', requireLabel: null, allowedActors: [] },
  proof: { type: 'none' },
  git: { defaultBranch: 'main', target: 'main', mergeStrategy: 'squash', deleteSourceBranch: true },
  claude: { command: 'claude', maxTurns: 40, permissionMode: 'acceptEdits' },
  concurrency: {}, promptBody: '',
} as WorkflowConfig;

describe('executeReviewCheck', () => {
  it('merges when the MR is approved', async () => {
    const adapter = new RecordingForge();
    await executeReviewCheck({ adapter, issueNumber: 7, mr: mr({ approved: true }), workflow });
    expect(adapter.calls).toEqual(['mergeMr(42,squash,true)']);
  });

  it('flips to in_progress and comments acknowledgement when changes are requested', async () => {
    const adapter = new RecordingForge();
    await executeReviewCheck({ adapter, issueNumber: 7, mr: mr({ changesRequested: true }), workflow });
    expect(adapter.calls).toEqual([
      'setLifecycleLabel(7,in_progress)',
      'comment(mr:42)',
    ]);
  });

  it('does nothing when neither approved nor changes requested', async () => {
    const adapter = new RecordingForge();
    await executeReviewCheck({ adapter, issueNumber: 7, mr: mr({}), workflow });
    expect(adapter.calls).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core test reconciler/reviewCheck.test.ts`
Expected: FAIL — `executeReviewCheck is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/core/src/reconciler/index.ts` (reuses `MergeRequest` — add the type import if not present):

```ts
// --- add to imports at top of packages/core/src/reconciler/index.ts (if not present) ---
import type { MergeRequest } from '../domain/types.js';

// --- append to packages/core/src/reconciler/index.ts ---

const FEEDBACK_ACK =
  'Thanks for the review — picking up the requested changes and will push updates shortly.';

export interface ReviewCheckDeps {
  adapter: ForgeAdapter;
  issueNumber: number;
  mr: MergeRequest;
  workflow: WorkflowConfig;
}

// Poll outcome of an in_review MR.
//  approved          -> merge per workflow git rules
//  changesRequested  -> flip label to in_progress + ack comment (agent resumes next tick)
//  neither           -> noop (keep polling)
export async function executeReviewCheck(deps: ReviewCheckDeps): Promise<void> {
  const { adapter, issueNumber, mr, workflow } = deps;

  if (mr.approved) {
    await executeMerge({ adapter, mrNumber: mr.number, workflow });
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
git commit -m "feat(reconciler): add review_check executor for approval and changes-requested"
```

---

## Task 10: Full-suite green + public exports

**Files:**
- Modify: `packages/core/src/index.ts`

> Surface the M4 executors and proof API through the package barrel so M5 (CLI/web) and the daemon loop can import them.

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
  executeHandoff,
  executeReviewCheck,
  executeMerge,
  type HandoffDeps,
  type ReviewCheckDeps,
  type MergeDeps,
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
git add packages/core/src/index.ts
git commit -m "feat(core): export proof API and reconciler executors"
```

---

## Self-Review (performed against spec + contracts)

- **Proof strategies (spec §6/§8, contract `ProofStrategy`/`runProof`):** `none` (Task 1), `test-output` (Task 3), `diff-summary` (Task 4), `playwright` (Task 5), all dispatched by `runProof` (Task 6). Covered.
- **Handoff ordering guarantee (spec §7):** proof → comment issue+MR → assignReviewer → setMrReady → setLifecycleLabel(in_review), asserted by exact call-order test (Task 7). Covered.
- **review_check (spec §7):** approved→merge, changesRequested→in_progress+comment (Task 9). Covered.
- **merge (spec §7):** `mergeMr(mrNumber, mergeStrategy, deleteSourceBranch)`; auto-close via `Closes #N` (Task 8). Covered.
- **Type consistency:** `ProofArtifact`/`ProofContext`/`ProofStrategy`/`runProof` match contracts exactly; executor dep-interfaces are M4-local and flagged. `setLifecycleLabel` takes `LifecycleState` (`in_progress`/`in_review`) per contract. `mergeMr` arg order matches `ForgeAdapter`.
- **No placeholders:** every code/command step is complete.

---

## Open questions

1. **No binary upload capability on `ForgeAdapter` (FLAGGED per task brief).** `comment(target, body)` accepts **text only**; there is no method to upload/attach a video, screenshot, or file artifact to an issue or MR. The `playwright` and (file-based) proof strategies produce real artifacts (`ProofArtifact.path`, kinds `video`/`image`/`text`), but the handoff executor can currently only post a **Markdown text reference** listing each artifact's relative path/kind/caption (`renderArtifactComment`). To actually surface videos/screenshots inline, the contracts need a new adapter capability (e.g. `uploadArtifact(path): Promise<string /* url/markdown */>` or `comment` accepting attachments). Until added, reviewers must inspect artifacts on the MR's source branch / in the workspace. **Needs a contract addition before binary proof is reviewer-visible.**

2. **Executor signatures and tick wiring are unspecified.** The contracts define `reconcileRepo(...)` as "orchestrates derive+decide+execute" but specify no signatures for the per-action executors, nor how a tick supplies the loaded `WorkflowConfig`, the M3 workspace dir, the resolved `reviewerUsername` (= `issue.authorUsername`), or the `mrNumber` to the execute phase. This plan introduces M4-local `HandoffDeps`/`ReviewCheckDeps`/`MergeDeps` and standalone `execute*` functions so they are unit-testable in isolation. The daemon loop (M-daemon) that constructs these deps and routes `Action` → executor is **out of scope here and needs a contract decision** on the `reconcileRepo` execute-phase interface.

3. **Proof artifact path semantics.** `ProofArtifact.path` — is it relative to `workspaceDir` (assumed here) or absolute? The contract field is just `path: string`. This plan treats it as **relative to `workspaceDir`** so the text comment can reference a stable repo-relative location; the strategies write files into `workspaceDir` accordingly. If absolute paths are expected, the renderer and strategies need adjustment.

4. **Playwright base-URL plumbing convention.** The contract gives `environment.baseUrl` but does not specify *how* the proof command receives it. This plan exports it as `PLAYWRIGHT_BASE_URL` (a Playwright config convention). If repos expect a different mechanism (CLI flag, `BASE_URL`, config file), the strategy needs that instead — a per-repo WORKFLOW.md detail not currently modelled.

5. **`start_command`/`seed_command`/`health_check` not used by M4.** Spec §6/§17 describe booting+seeding a local instance for proof when none is running. This plan assumes an **already-running** instance at `baseUrl` (the supported local case per §17) and does **not** boot/seed. Who owns lifecycle of the runnable instance (workspace manager? a separate environment manager? the daemon loop?) is unspecified in the contracts and deferred.
