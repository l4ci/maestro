# Maestro M6 — GitHub Forge Adapter — Implementation Plan
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `GitHubForge implements ForgeAdapter` (`packages/core/src/forge/github.ts`) that drives a GitHub repo through the maestro lifecycle by shelling out to the `gh` CLI via the shared `CommandRunner` (`util/exec.ts`), mapping `gh` JSON into the normalized `Issue` / `MergeRequest` (PR) domain model (incl. PR `description` and `linkedIssueNumbers`), enforcing flat-label (`maestro:<state>`) mutual exclusion, deriving `approved`/`changesRequested` per `WorkflowConfig.review.changesSignal` (both `'native'` and `'label'` paths), and creating maestro labels idempotently (incl. the changes-requested label in `'label'` mode). Implements the full `ForgeAdapter` surface including `createIssue`, `getMrDescription`, and `blobUrl`. Wire `'github'` into `createForge` (`packages/core/src/forge/factory.ts`). `ensureBoard` is a no-op (Projects V2 deferred).

**Architecture:** The adapter is the *only* GitHub-aware code; everything above it (reconciler, daemon) consumes the normalized `ForgeAdapter` interface from `packages/core/src/forge/adapter.ts`. It mirrors the M2 GitLab adapter (`packages/core/src/forge/gitlab.ts`): a class taking the injected shared `CommandRunner` from `util/exec.ts` (so tests stub `run`; no real network), constructed from a normalized `repo` + `deps` by the factory. Tokens are passed by reading the env var whose *name* is `tokenEnv` (config never holds the token itself) and exporting it to `gh` as `GH_TOKEN` (never embedded in URLs/logs). Labels are FLAT: `lifecycleLabel('github', state)` → `maestro:in_progress` etc. `setLifecycleLabel` adds the one target label and removes every *other* maestro flat label, enforcing exclusivity in code (GitHub has no scoped-label semantics).

**Tech Stack:** Node 20+, TypeScript 5.x, ESM (`"type": "module"`). Vitest (tests colocated as `*.test.ts`). Shared `CommandRunner` (`util/exec.ts`, `execaRunner` over `execa`) for subprocess. Package `@maestro/core`. No real `gh`/network in tests — the `CommandRunner` is injected and stubbed.

**Depends on:** M1 (`ForgeAdapter` interface in `forge/adapter.ts`, `ForgeError`, `CreateMrArgs`, `CommentTarget`; the shared `CommandRunner`/`execaRunner` seam in `util/exec.ts`; lifecycle label helpers in `domain/lifecycle.ts`; domain types in `domain/types.ts`; `WorkflowConfig` in `workflow/schema.ts`), M2 (forge factory pattern in `forge/factory.ts` + GitLab adapter `forge/gitlab.ts` as the reference implementation to mirror — including how it threads `WorkflowConfig.review`).

---

## File Structure

Files this milestone **creates**:

```
packages/core/src/forge/github.ts        # GitHubForge implements ForgeAdapter (NEW)
packages/core/src/forge/github.test.ts    # colocated Vitest unit tests (NEW)
```

Files this milestone **modifies**:

```
packages/core/src/forge/factory.ts        # add 'github' branch → GitHubForge
packages/core/src/forge/factory.test.ts    # add 'github' factory case (extends M2 test)
```

Files this milestone **reads only** (from M1/M2 — do NOT modify):

```
packages/core/src/forge/adapter.ts        # ForgeAdapter, ForgeError, CreateMrArgs, CommentTarget
packages/core/src/domain/types.ts         # Forge, Issue, MergeRequest, LifecycleState, MergeStrategy
packages/core/src/domain/lifecycle.ts     # lifecycleLabel, allMaestroLabels, labeledStateOf, LABELED_STATES
packages/core/src/util/exec.ts            # CommandRunner + execaRunner (shared subprocess seam — import, never redeclare)
packages/core/src/workflow/schema.ts      # WorkflowConfig (review.changesSignal / review.changesLabel)
packages/core/src/forge/gitlab.ts         # reference: structure, deps shape, CommandRunner injection, WorkflowConfig.review threading
```

### Adapter construction contract (mirror M2)

`createForge(forge, { url, project, botUser }, deps)` (per contracts `forge/factory.ts`) is the only constructor entry point, where `deps: ForgeDeps = { config, review, runner?, fetchImpl? }` (`review: WorkflowConfig['review']` is a required field). `GitHubForge` is constructed with the normalized fields the factory resolves from `repo` + `deps` — `changesSignal`/`changesLabel` are sourced from `deps.review`:

```ts
// All fields below are derived from the normalized repo entry + injected deps.
import type { CommandRunner } from '../util/exec.js';
import type { WorkflowConfig } from '../workflow/schema.js';

export interface GitHubForgeArgs {
  project: string;        // "org/repo"
  botUser: string;        // bot account username
  host: string;           // e.g. "github.com" (from forges.github.host)
  token: string;          // resolved value of process.env[forges.github.tokenEnv]
  changesSignal: WorkflowConfig['review']['changesSignal'];  // 'native' | 'label'
  changesLabel?: string;  // flat label name when changesSignal === 'label'
  runner: CommandRunner;  // shared subprocess seam (util/exec.ts), stubbed in tests
}
```

The subprocess seam is the **shared `CommandRunner`** from `packages/core/src/util/exec.ts` (per contracts "Shared exec seam" — no plan declares its own `ExecFn`/`CommandRunner`):

```ts
// from ../util/exec.js
export interface CommandRunner {
  run(cmd: string, args: string[], opts?: { cwd?: string; input?: string; env?: Record<string, string> }):
    Promise<{ stdout: string; stderr: string; exitCode: number }>;
}
```

Tests stub `CommandRunner.run` directly (returns `{ stdout, stderr, exitCode }`); no real `gh`/network.

---

## Tasks

### Task 0 — Read the references before writing code

- [ ] Open and read `packages/core/src/forge/adapter.ts` (the `ForgeAdapter` interface, `ForgeError`, `CreateMrArgs`, `CommentTarget`), `packages/core/src/util/exec.ts` (the shared `CommandRunner` seam — import it, do NOT redeclare), and `packages/core/src/forge/gitlab.ts` (the M2 reference adapter). Note exactly how GitLab injects the shared `CommandRunner`, how it shapes its constructor args, and how `createForge` builds it in `factory.ts`. **Mirror that structure.** Do not redeclare types M1/M2 already export — import them.
- [ ] Open `packages/core/src/domain/lifecycle.ts` and confirm `lifecycleLabel('github', 'in_progress') === 'maestro:in_progress'`, and that `allMaestroLabels('github')` returns `['maestro:in_progress','maestro:in_review','maestro:blocked']`. These are the labels this adapter creates and strips.

---

### Task 1 — Adapter skeleton + readonly properties

Establish the class implementing `ForgeAdapter` with its three readonly props, so the type contract is satisfied before any method has behavior.

- [ ] **Write failing test.** Create `packages/core/src/forge/github.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { GitHubForge } from './github.js';
import type { CommandRunner } from '../util/exec.js';

// A stub CommandRunner whose `run` returns canned {stdout,stderr,exitCode}.
function makeRunner(
  run: CommandRunner['run'] = vi.fn(async (cmd, args) => {
    // default: any unexpected call fails the test loudly
    throw new Error(`unexpected exec: ${cmd} ${args.join(' ')}`);
  }),
): CommandRunner {
  return { run } as CommandRunner;
}

function makeForge(
  run?: CommandRunner['run'],
  opts: { changesSignal?: 'native' | 'label'; changesLabel?: string } = {},
): GitHubForge {
  return new GitHubForge({
    project: 'org/web',
    botUser: 'maestro-bot',
    host: 'github.com',
    token: 'tok_test',
    changesSignal: opts.changesSignal ?? 'label',
    changesLabel: opts.changesLabel ?? 'maestro:changes-requested',
    runner: makeRunner(run),
  });
}

describe('GitHubForge identity', () => {
  it('exposes forge, project, and botUser', () => {
    const forge = makeForge();
    expect(forge.forge).toBe('github');
    expect(forge.project).toBe('org/web');
    expect(forge.botUser).toBe('maestro-bot');
  });
});
```

- [ ] **Run & see it fail.** Command: `pnpm --filter @maestro/core test forge/github.test.ts`
  Expected failure: `Error: Failed to resolve import "./github.js"` (the module does not exist yet) / `GitHubForge is not exported`.

- [ ] **Minimal complete implementation.** Create `packages/core/src/forge/github.ts`:

```ts
import type {
  Forge,
  Issue,
  MergeRequest,
  LifecycleState,
  MergeStrategy,
} from '../domain/types.js';
import type {
  ForgeAdapter,
  CreateMrArgs,
  CommentTarget,
} from './adapter.js';
import { ForgeError } from './adapter.js';
import {
  lifecycleLabel,
  allMaestroLabels,
  LABELED_STATES,
} from '../domain/lifecycle.js';
import type { LabeledState } from '../domain/lifecycle.js';
import type { CommandRunner } from '../util/exec.js';
import type { WorkflowConfig } from '../workflow/schema.js';

export interface GitHubForgeArgs {
  project: string;
  botUser: string;
  host: string;
  token: string;
  changesSignal: WorkflowConfig['review']['changesSignal'];
  changesLabel?: string;
  runner: CommandRunner;
}

export class GitHubForge implements ForgeAdapter {
  readonly forge: Forge = 'github';
  readonly project: string;
  readonly botUser: string;
  private readonly host: string;
  private readonly token: string;
  private readonly changesSignal: WorkflowConfig['review']['changesSignal'];
  private readonly changesLabel?: string;
  private readonly runner: CommandRunner;

  constructor(args: GitHubForgeArgs) {
    this.project = args.project;
    this.botUser = args.botUser;
    this.host = args.host;
    this.token = args.token;
    this.changesSignal = args.changesSignal;
    this.changesLabel = args.changesLabel;
    this.runner = args.runner;
  }

  // --- internal: run gh with the token + host wired in ---
  private async gh(args: string[]): Promise<string> {
    try {
      const res = await this.runner.run('gh', args, {
        env: { GH_TOKEN: this.token, GH_HOST: this.host },
      });
      return res.stdout;
    } catch (err) {
      throw new ForgeError(`gh ${args.join(' ')} failed`, err);
    }
  }

  // method stubs implemented in later tasks
  listAssignedOpenIssues(): Promise<Issue[]> {
    throw new ForgeError('not implemented');
  }
  getIssue(_issueNumber: number): Promise<Issue | null> {
    throw new ForgeError('not implemented');
  }
  listOpenMrsByBot(): Promise<MergeRequest[]> {
    throw new ForgeError('not implemented');
  }
  getMrForIssue(_issueNumber: number): Promise<MergeRequest | null> {
    throw new ForgeError('not implemented');
  }
  getMrDescription(_mrNumber: number): Promise<string> {
    throw new ForgeError('not implemented');
  }
  createIssue(_args: { title: string; body: string; assignee?: string }): Promise<Issue> {
    throw new ForgeError('not implemented');
  }
  createBranch(_name: string, _fromRef: string): Promise<void> {
    throw new ForgeError('not implemented');
  }
  createDraftMr(_args: CreateMrArgs): Promise<MergeRequest> {
    throw new ForgeError('not implemented');
  }
  setMrReady(_mrNumber: number): Promise<void> {
    throw new ForgeError('not implemented');
  }
  updateMrDescription(_mrNumber: number, _body: string): Promise<void> {
    throw new ForgeError('not implemented');
  }
  assignReviewer(_mrNumber: number, _username: string): Promise<void> {
    throw new ForgeError('not implemented');
  }
  mergeMr(
    _mrNumber: number,
    _strategy: MergeStrategy,
    _deleteSource: boolean,
  ): Promise<void> {
    throw new ForgeError('not implemented');
  }
  comment(_target: CommentTarget, _body: string): Promise<void> {
    throw new ForgeError('not implemented');
  }
  setLifecycleLabel(_issueNumber: number, _state: LifecycleState): Promise<void> {
    throw new ForgeError('not implemented');
  }
  ensureLabels(): Promise<void> {
    throw new ForgeError('not implemented');
  }
  ensureBoard(): Promise<void> {
    throw new ForgeError('not implemented');
  }

  // --- pure helper (no I/O) ---
  // GitHub blob URL: https://<host>/<project>/blob/<branch>/<path>
  blobUrl(branch: string, path: string): string {
    return `https://${this.host}/${this.project}/blob/${branch}/${path}`;
  }

  // referenced by later tasks; keep imports live
  protected readonly _labeledStates = LABELED_STATES;
  protected labelFor(state: LabeledState): string {
    return lifecycleLabel('github', state);
  }
  protected allLabels(): string[] {
    return allMaestroLabels('github');
  }
}
```

- [ ] **Run & see it pass.** Command: `pnpm --filter @maestro/core test forge/github.test.ts`
  Expected: `GitHubForge identity > exposes forge, project, and botUser` passes (1 passed).

- [ ] **Commit.**
  `git add packages/core/src/forge/github.ts packages/core/src/forge/github.test.ts`
  `git commit -m "feat(core): scaffold GitHubForge adapter skeleton"`

---

### Task 2 — `listAssignedOpenIssues` (gh JSON → Issue[])

Map `gh issue list --json ... --assignee <bot> --state open` output into normalized `Issue[]`.

- [ ] **Write failing test.** Append to `github.test.ts`:

```ts
const GH_ISSUE_JSON = JSON.stringify([
  {
    id: 'I_kwAB',
    number: 7,
    title: 'Fix login',
    body: 'It is broken',
    state: 'OPEN',
    assignees: [{ login: 'maestro-bot' }],
    author: { login: 'alice' },
    labels: [{ name: 'bug' }, { name: 'maestro:in_progress' }],
    createdAt: '2026-06-01T10:00:00Z',
    url: 'https://github.com/org/web/issues/7',
  },
]);

describe('GitHubForge.listAssignedOpenIssues', () => {
  it('maps gh issue JSON to normalized Issue[]', async () => {
    const run = vi.fn(async (cmd: string, args: string[]) => {
      expect(cmd).toBe('gh');
      expect(args).toContain('issue');
      expect(args).toContain('list');
      expect(args).toContain('--assignee');
      expect(args).toContain('maestro-bot');
      expect(args).toContain('--state');
      expect(args).toContain('open');
      return { stdout: GH_ISSUE_JSON, stderr: '', exitCode: 0 };
    });

    const forge = makeForge(run);
    const issues = await forge.listAssignedOpenIssues();

    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({
      id: 'I_kwAB',
      number: 7,
      title: 'Fix login',
      body: 'It is broken',
      state: 'open',
      assignees: ['maestro-bot'],
      authorUsername: 'alice',
      labels: ['bug', 'maestro:in_progress'],
      createdAt: '2026-06-01T10:00:00Z',
      webUrl: 'https://github.com/org/web/issues/7',
    });
  });
});
```

- [ ] **Run & see it fail.** Command: `pnpm --filter @maestro/core test forge/github.test.ts`
  Expected failure: `ForgeError: not implemented` thrown from `listAssignedOpenIssues`.

- [ ] **Minimal complete implementation.** In `github.ts`, add a private mapper and implement the method. Replace the `listAssignedOpenIssues` stub:

```ts
  private mapIssue(raw: GhIssue): Issue {
    return {
      id: raw.id,
      number: raw.number,
      title: raw.title,
      body: raw.body ?? '',
      state: raw.state === 'OPEN' ? 'open' : 'closed',
      assignees: (raw.assignees ?? []).map((a) => a.login),
      authorUsername: raw.author?.login ?? '',
      labels: (raw.labels ?? []).map((l) => l.name),
      createdAt: raw.createdAt,
      webUrl: raw.url,
    };
  }

  async listAssignedOpenIssues(): Promise<Issue[]> {
    const stdout = await this.gh([
      'issue',
      'list',
      '--repo',
      this.project,
      '--assignee',
      this.botUser,
      '--state',
      'open',
      '--json',
      'id,number,title,body,state,assignees,author,labels,createdAt,url',
    ]);
    const raw = JSON.parse(stdout) as GhIssue[];
    return raw.map((r) => this.mapIssue(r));
  }
```

Add these raw `gh` JSON shapes near the top of `github.ts` (below the `GitHubForgeArgs`/`CommandRunner` imports):

```ts
interface GhUser {
  login: string;
}
interface GhLabel {
  name: string;
}
interface GhIssue {
  id: string;
  number: number;
  title: string;
  body?: string;
  state: 'OPEN' | 'CLOSED';
  assignees?: GhUser[];
  author?: GhUser;
  labels?: GhLabel[];
  createdAt: string;
  url: string;
}
```

- [ ] **Run & see it pass.** Command: `pnpm --filter @maestro/core test forge/github.test.ts`
  Expected: both `identity` and `listAssignedOpenIssues` tests pass (2 passed).

- [ ] **Commit.**
  `git add packages/core/src/forge/github.ts packages/core/src/forge/github.test.ts`
  `git commit -m "feat(core): map gh issue list to normalized Issue[]"`

---

### Task 3 — `getIssue` (single issue, null on absence)

- [ ] **Write failing test.** Append to `github.test.ts`:

```ts
describe('GitHubForge.getIssue', () => {
  it('maps a single issue via gh issue view', async () => {
    const single = JSON.parse(GH_ISSUE_JSON)[0];
    const run = vi.fn(async (_cmd: string, args: string[]) => {
      expect(args).toContain('view');
      expect(args).toContain('7');
      return { stdout: JSON.stringify(single), stderr: '', exitCode: 0 };
    });

    const forge = makeForge(run);
    const issue = await forge.getIssue(7);
    expect(issue?.number).toBe(7);
    expect(issue?.state).toBe('open');
  });

  it('returns null when gh reports the issue is not found', async () => {
    const run = vi.fn(async () => {
      const err = new Error('gh: issue not found') as Error & { exitCode: number };
      err.exitCode = 1;
      throw err;
    });

    const forge = makeForge(run);
    expect(await forge.getIssue(999)).toBeNull();
  });
});
```

- [ ] **Run & see it fail.** Command: `pnpm --filter @maestro/core test forge/github.test.ts`
  Expected failure: first case throws `ForgeError: not implemented`; second case throws instead of returning `null`.

- [ ] **Minimal complete implementation.** Replace the `getIssue` stub in `github.ts`:

```ts
  async getIssue(issueNumber: number): Promise<Issue | null> {
    let stdout: string;
    try {
      stdout = await this.execGhRaw([
        'issue',
        'view',
        String(issueNumber),
        '--repo',
        this.project,
        '--json',
        'id,number,title,body,state,assignees,author,labels,createdAt,url',
      ]);
    } catch (err) {
      if (this.isNotFound(err)) return null;
      throw new ForgeError(`gh issue view ${issueNumber} failed`, err);
    }
    return this.mapIssue(JSON.parse(stdout) as GhIssue);
  }
```

Add two private helpers to `github.ts` (the raw runner without the catch-wrap, so `getIssue` can distinguish not-found; and a not-found detector). The `gh()` helper from Task 1 stays for fire-and-forget writes:

```ts
  // raw runner: surfaces the original error so callers can branch (e.g. not-found)
  private async execGhRaw(args: string[]): Promise<string> {
    const res = await this.runner.run('gh', args, {
      env: { GH_TOKEN: this.token, GH_HOST: this.host },
    });
    return res.stdout;
  }

  private isNotFound(err: unknown): boolean {
    const msg = err instanceof Error ? err.message.toLowerCase() : '';
    return msg.includes('not found') || msg.includes('could not resolve');
  }
```

- [ ] **Run & see it pass.** Command: `pnpm --filter @maestro/core test forge/github.test.ts`
  Expected: 4 tests pass (identity, list, getIssue maps, getIssue null).

- [ ] **Commit.**
  `git add packages/core/src/forge/github.ts packages/core/src/forge/github.test.ts`
  `git commit -m "feat(core): implement GitHubForge.getIssue with not-found handling"`

---

### Task 4 — PR (MergeRequest) mapping core + `getMrForIssue` + `getMrDescription`

Map `gh pr view --json ...` (incl. `reviewDecision`, `isDraft`, `closingIssuesReferences`, `body`, `labels`) into a normalized `MergeRequest`. `approved` derives from `reviewDecision === 'APPROVED'`; `description` from the PR `body`; `changesRequested` per `WorkflowConfig.review.changesSignal` — `'native'` reads `reviewDecision === 'CHANGES_REQUESTED'`, `'label'` (default) reads whether `changesLabel` is present on the PR. `getMrDescription` reads back the PR `body` by number.

- [ ] **Write failing test.** Append to `github.test.ts`:

```ts
function ghPr(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'PR_kw1',
    number: 42,
    headRefName: 'maestro/issue-7',
    baseRefName: 'main',
    isDraft: true,
    state: 'OPEN',
    reviewDecision: '',
    reviewRequests: [{ login: 'alice' }],
    closingIssuesReferences: [{ number: 7 }],
    body: 'Living plan\n- [ ] step one',
    labels: [],
    url: 'https://github.com/org/web/pull/42',
    ...overrides,
  });
}

describe('GitHubForge PR mapping', () => {
  it('maps an APPROVED PR to approved:true', async () => {
    const run = vi.fn(async (_f: string, args: string[]) => {
      expect(args).toContain('pr');
      expect(args).toContain('view');
      return { stdout: ghPr({ reviewDecision: 'APPROVED' }), stderr: '', exitCode: 0 };
    });

    const mr = await makeForge(run).getMrForIssue(7);
    expect(mr).toEqual({
      id: 'PR_kw1',
      number: 42,
      sourceBranch: 'maestro/issue-7',
      targetBranch: 'main',
      isDraft: true,
      state: 'open',
      approved: true,
      changesRequested: false,
      reviewers: ['alice'],
      linkedIssueNumbers: [7],
      description: 'Living plan\n- [ ] step one',
      webUrl: 'https://github.com/org/web/pull/42',
    });
  });

  it('maps CHANGES_REQUESTED to changesRequested:true under changesSignal=native', async () => {
    const run = vi.fn(async () => ({
      stdout: ghPr({ reviewDecision: 'CHANGES_REQUESTED' }),
      stderr: '',
      exitCode: 0,
    }));
    const mr = await makeForge(run, { changesSignal: 'native' }).getMrForIssue(7);
    expect(mr?.approved).toBe(false);
    expect(mr?.changesRequested).toBe(true);
  });

  it('ignores reviewDecision for changes under changesSignal=label (uses label instead)', async () => {
    // default makeForge uses changesSignal='label', changesLabel='maestro:changes-requested'
    const withLabel = vi.fn(async () => ({
      stdout: ghPr({
        reviewDecision: 'CHANGES_REQUESTED',
        labels: [{ name: 'maestro:changes-requested' }],
      }),
      stderr: '',
      exitCode: 0,
    }));
    expect((await makeForge(withLabel).getMrForIssue(7))?.changesRequested).toBe(true);

    // native CHANGES_REQUESTED but NO label → not flagged in label mode
    const noLabel = vi.fn(async () => ({
      stdout: ghPr({ reviewDecision: 'CHANGES_REQUESTED', labels: [] }),
      stderr: '',
      exitCode: 0,
    }));
    expect((await makeForge(noLabel).getMrForIssue(7))?.changesRequested).toBe(false);
  });

  it('maps REVIEW_REQUIRED / empty to neither', async () => {
    const run = vi.fn(async () => ({
      stdout: ghPr({ reviewDecision: 'REVIEW_REQUIRED' }),
      stderr: '',
      exitCode: 0,
    }));
    const mr = await makeForge(run, { changesSignal: 'native' }).getMrForIssue(7);
    expect(mr?.approved).toBe(false);
    expect(mr?.changesRequested).toBe(false);
  });

  it('maps MERGED and CLOSED PR states', async () => {
    const run = vi.fn(async () => ({
      stdout: ghPr({ state: 'MERGED' }),
      stderr: '',
      exitCode: 0,
    }));
    expect((await makeForge(run).getMrForIssue(7))?.state).toBe('merged');
  });

  it('returns null when no PR exists for the issue', async () => {
    const run = vi.fn(async () => {
      throw new Error('no pull requests found');
    });
    expect(await makeForge(run).getMrForIssue(7)).toBeNull();
  });

  it('getMrDescription reads the PR body by number', async () => {
    const run = vi.fn(async (_f: string, args: string[]) => {
      expect(args).toContain('pr');
      expect(args).toContain('view');
      expect(args).toContain('42');
      expect(args).toContain('body');
      return { stdout: JSON.stringify({ body: 'living plan' }), stderr: '', exitCode: 0 };
    });
    expect(await makeForge(run).getMrDescription(42)).toBe('living plan');
  });
});
```

- [ ] **Run & see it fail.** Command: `pnpm --filter @maestro/core test forge/github.test.ts`
  Expected failure: every PR-mapping case throws `ForgeError: not implemented` from `getMrForIssue`.

- [ ] **Minimal complete implementation.** Add raw PR shape + mapper, then implement `getMrForIssue`. Add to `github.ts`:

```ts
interface GhPr {
  id: string;
  number: number;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  reviewDecision?: string; // 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | ''
  reviewRequests?: GhUser[];
  closingIssuesReferences?: { number: number }[];
  body?: string;
  labels?: GhLabel[];
  url: string;
}

const PR_JSON_FIELDS =
  'id,number,headRefName,baseRefName,isDraft,state,reviewDecision,reviewRequests,closingIssuesReferences,body,labels,url';
```

```ts
  private mapPr(raw: GhPr): MergeRequest {
    const decision = raw.reviewDecision ?? '';
    const stateMap: Record<GhPr['state'], MergeRequest['state']> = {
      OPEN: 'open',
      MERGED: 'merged',
      CLOSED: 'closed',
    };
    const labels = (raw.labels ?? []).map((l) => l.name);
    // changesRequested per WorkflowConfig.review.changesSignal (contracts "Review signal"):
    //  'native' → PR reviewDecision === 'CHANGES_REQUESTED'
    //  'label'  (default) → the changesLabel is present on the PR
    const changesRequested =
      this.changesSignal === 'native'
        ? decision === 'CHANGES_REQUESTED'
        : this.changesLabel != null && labels.includes(this.changesLabel);
    return {
      id: raw.id,
      number: raw.number,
      sourceBranch: raw.headRefName,
      targetBranch: raw.baseRefName,
      isDraft: raw.isDraft,
      state: stateMap[raw.state],
      approved: decision === 'APPROVED',
      changesRequested,
      reviewers: (raw.reviewRequests ?? []).map((r) => r.login),
      linkedIssueNumbers: (raw.closingIssuesReferences ?? []).map((c) => c.number),
      description: raw.body ?? '',
      webUrl: raw.url,
    };
  }

  async getMrForIssue(issueNumber: number): Promise<MergeRequest | null> {
    let stdout: string;
    try {
      stdout = await this.execGhRaw([
        'pr',
        'view',
        `maestro/issue-${issueNumber}`,
        '--repo',
        this.project,
        '--json',
        PR_JSON_FIELDS,
      ]);
    } catch (err) {
      if (this.isNotFound(err) || this.isNoPr(err)) return null;
      throw new ForgeError(`gh pr view for issue ${issueNumber} failed`, err);
    }
    return this.mapPr(JSON.parse(stdout) as GhPr);
  }

  private isNoPr(err: unknown): boolean {
    const msg = err instanceof Error ? err.message.toLowerCase() : '';
    return msg.includes('no pull requests found') || msg.includes('no pull request');
  }

  // Read the PR body (the agent's living plan/checklist) for M3 context.
  async getMrDescription(mrNumber: number): Promise<string> {
    const stdout = await this.gh([
      'pr',
      'view',
      String(mrNumber),
      '--repo',
      this.project,
      '--json',
      'body',
    ]);
    return (JSON.parse(stdout) as { body?: string }).body ?? '';
  }
```

> Note: PR lookup keys off the branch name `maestro/issue-<number>` (fixed branch convention in contracts: "Branch name: `maestro/issue-<number>`"). `gh pr view <branch>` resolves the PR for that head branch. `getMrDescription(mrNumber)` reads back the same `body` field by PR number.

- [ ] **Run & see it pass.** Command: `pnpm --filter @maestro/core test forge/github.test.ts`
  Expected: all PR-mapping cases pass (description, both changesSignal paths, states, null, getMrDescription).

- [ ] **Commit.**
  `git add packages/core/src/forge/github.ts packages/core/src/forge/github.test.ts`
  `git commit -m "feat(core): map gh PR JSON incl body/reviewDecision/changesSignal to MergeRequest"`

---

### Task 5 — `listOpenMrsByBot`

List open PRs authored by the bot and map them.

- [ ] **Write failing test.** Append to `github.test.ts`:

```ts
describe('GitHubForge.listOpenMrsByBot', () => {
  it('lists open PRs authored by the bot', async () => {
    const run = vi.fn(async (_f: string, args: string[]) => {
      expect(args).toContain('pr');
      expect(args).toContain('list');
      expect(args).toContain('--author');
      expect(args).toContain('maestro-bot');
      expect(args).toContain('--state');
      expect(args).toContain('open');
      return { stdout: `[${ghPr({ reviewDecision: 'APPROVED' })}]`, stderr: '', exitCode: 0 };
    });

    const mrs = await makeForge(run).listOpenMrsByBot();
    expect(mrs).toHaveLength(1);
    expect(mrs[0].approved).toBe(true);
    expect(mrs[0].number).toBe(42);
  });
});
```

- [ ] **Run & see it fail.** Command: `pnpm --filter @maestro/core test forge/github.test.ts`
  Expected failure: `ForgeError: not implemented` from `listOpenMrsByBot`.

- [ ] **Minimal complete implementation.** Replace the `listOpenMrsByBot` stub:

```ts
  async listOpenMrsByBot(): Promise<MergeRequest[]> {
    const stdout = await this.gh([
      'pr',
      'list',
      '--repo',
      this.project,
      '--author',
      this.botUser,
      '--state',
      'open',
      '--json',
      PR_JSON_FIELDS,
    ]);
    const raw = JSON.parse(stdout) as GhPr[];
    return raw.map((r) => this.mapPr(r));
  }
```

- [ ] **Run & see it pass.** Command: `pnpm --filter @maestro/core test forge/github.test.ts`
  Expected: 10 passed.

- [ ] **Commit.**
  `git add packages/core/src/forge/github.ts packages/core/src/forge/github.test.ts`
  `git commit -m "feat(core): implement GitHubForge.listOpenMrsByBot"`

---

### Task 6 — `createBranch`

Create a branch from a ref via the git refs REST API (`gh api`). `gh` has no first-class "create branch"; the contracts allow REST.

- [ ] **Write failing test.** Append to `github.test.ts`:

```ts
describe('GitHubForge.createBranch', () => {
  it('resolves the base sha then creates the ref via gh api', async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (_f: string, args: string[]) => {
      calls.push(args);
      if (args.includes('git/ref/heads/main')) {
        return { stdout: JSON.stringify({ object: { sha: 'deadbeef' } }), stderr: '', exitCode: 0 };
      }
      return { stdout: '{}', stderr: '', exitCode: 0 };
    });

    await makeForge(run).createBranch('maestro/issue-7', 'main');

    // first call resolves base sha
    expect(calls[0]).toContain('repos/org/web/git/ref/heads/main');
    // second call POSTs the new ref with the resolved sha
    const create = calls[1];
    expect(create).toContain('repos/org/web/git/refs');
    expect(create.join(' ')).toContain('refs/heads/maestro/issue-7');
    expect(create.join(' ')).toContain('deadbeef');
  });
});
```

- [ ] **Run & see it fail.** Command: `pnpm --filter @maestro/core test forge/github.test.ts`
  Expected failure: `ForgeError: not implemented` from `createBranch`.

- [ ] **Minimal complete implementation.** Replace the `createBranch` stub:

```ts
  async createBranch(name: string, fromRef: string): Promise<void> {
    const refStdout = await this.gh([
      'api',
      `repos/${this.project}/git/ref/heads/${fromRef}`,
    ]);
    const sha = (JSON.parse(refStdout) as { object: { sha: string } }).object.sha;
    await this.gh([
      'api',
      `repos/${this.project}/git/refs`,
      '-X',
      'POST',
      '-f',
      `ref=refs/heads/${name}`,
      '-f',
      `sha=${sha}`,
    ]);
  }
```

- [ ] **Run & see it pass.** Command: `pnpm --filter @maestro/core test forge/github.test.ts`
  Expected: 11 passed.

- [ ] **Commit.**
  `git add packages/core/src/forge/github.ts packages/core/src/forge/github.test.ts`
  `git commit -m "feat(core): implement GitHubForge.createBranch via gh api"`

---

### Task 7 — `createDraftMr` (returns mapped MergeRequest)

Create a draft PR, then read it back as a normalized `MergeRequest`.

- [ ] **Write failing test.** Append to `github.test.ts`:

```ts
describe('GitHubForge.createDraftMr', () => {
  it('creates a draft PR and returns the mapped MergeRequest', async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (_f: string, args: string[]) => {
      calls.push(args);
      if (args.includes('create')) {
        return { stdout: 'https://github.com/org/web/pull/42\n', stderr: '', exitCode: 0 };
      }
      // pr view readback
      return { stdout: ghPr({ isDraft: true }), stderr: '', exitCode: 0 };
    });

    const mr = await makeForge(run).createDraftMr({
      sourceBranch: 'maestro/issue-7',
      targetBranch: 'main',
      title: 'Fix login',
      body: 'Closes #7',
      draft: true,
    });

    const create = calls[0];
    expect(create).toContain('create');
    expect(create).toContain('--draft');
    expect(create).toContain('--head');
    expect(create).toContain('maestro/issue-7');
    expect(create).toContain('--base');
    expect(create).toContain('main');
    expect(create).toContain('--title');
    expect(create).toContain('Fix login');
    expect(create).toContain('--body');
    expect(create).toContain('Closes #7');

    expect(mr.number).toBe(42);
    expect(mr.isDraft).toBe(true);
    expect(mr.sourceBranch).toBe('maestro/issue-7');
  });
});
```

- [ ] **Run & see it fail.** Command: `pnpm --filter @maestro/core test forge/github.test.ts`
  Expected failure: `ForgeError: not implemented` from `createDraftMr`.

- [ ] **Minimal complete implementation.** Replace the `createDraftMr` stub:

```ts
  async createDraftMr(args: CreateMrArgs): Promise<MergeRequest> {
    const createArgs = [
      'pr',
      'create',
      '--repo',
      this.project,
      '--head',
      args.sourceBranch,
      '--base',
      args.targetBranch,
      '--title',
      args.title,
      '--body',
      args.body,
    ];
    if (args.draft) createArgs.push('--draft');
    const url = (await this.gh(createArgs)).trim();
    const number = Number(url.split('/').pop());
    const viewStdout = await this.gh([
      'pr',
      'view',
      String(number),
      '--repo',
      this.project,
      '--json',
      PR_JSON_FIELDS,
    ]);
    return this.mapPr(JSON.parse(viewStdout) as GhPr);
  }
```

- [ ] **Run & see it pass.** Command: `pnpm --filter @maestro/core test forge/github.test.ts`
  Expected: 12 passed.

- [ ] **Commit.**
  `git add packages/core/src/forge/github.ts packages/core/src/forge/github.test.ts`
  `git commit -m "feat(core): implement GitHubForge.createDraftMr"`

---

### Task 8 — `setMrReady`, `updateMrDescription`, `assignReviewer`

Three thin write commands that issue a single `gh` call each.

- [ ] **Write failing test.** Append to `github.test.ts`:

```ts
describe('GitHubForge simple PR writes', () => {
  it('setMrReady un-drafts the PR', async () => {
    const run = vi.fn(async (_f: string, args: string[]) => {
      expect(args).toContain('pr');
      expect(args).toContain('ready');
      expect(args).toContain('42');
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    await makeForge(run).setMrReady(42);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('updateMrDescription edits the body', async () => {
    const run = vi.fn(async (_f: string, args: string[]) => {
      expect(args).toContain('pr');
      expect(args).toContain('edit');
      expect(args).toContain('--body');
      expect(args).toContain('new plan');
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    await makeForge(run).updateMrDescription(42, 'new plan');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('assignReviewer requests review from the user', async () => {
    const run = vi.fn(async (_f: string, args: string[]) => {
      expect(args).toContain('pr');
      expect(args).toContain('edit');
      expect(args).toContain('--add-reviewer');
      expect(args).toContain('alice');
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    await makeForge(run).assignReviewer(42, 'alice');
    expect(run).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Run & see it fail.** Command: `pnpm --filter @maestro/core test forge/github.test.ts`
  Expected failure: each of the three throws `ForgeError: not implemented`.

- [ ] **Minimal complete implementation.** Replace the three stubs:

```ts
  async setMrReady(mrNumber: number): Promise<void> {
    await this.gh(['pr', 'ready', String(mrNumber), '--repo', this.project]);
  }

  async updateMrDescription(mrNumber: number, body: string): Promise<void> {
    await this.gh([
      'pr',
      'edit',
      String(mrNumber),
      '--repo',
      this.project,
      '--body',
      body,
    ]);
  }

  async assignReviewer(mrNumber: number, username: string): Promise<void> {
    await this.gh([
      'pr',
      'edit',
      String(mrNumber),
      '--repo',
      this.project,
      '--add-reviewer',
      username,
    ]);
  }
```

- [ ] **Run & see it pass.** Command: `pnpm --filter @maestro/core test forge/github.test.ts`
  Expected: 15 passed.

- [ ] **Commit.**
  `git add packages/core/src/forge/github.ts packages/core/src/forge/github.test.ts`
  `git commit -m "feat(core): implement GitHubForge PR ready/edit/reviewer writes"`

---

### Task 9 — `mergeMr` (strategy + delete-source mapping)

Map the normalized `MergeStrategy` to the `gh pr merge` flag, and honor `deleteSource`.

- [ ] **Write failing test.** Append to `github.test.ts`:

```ts
describe('GitHubForge.mergeMr', () => {
  const cases: [MergeStrategy, string][] = [
    ['squash', '--squash'],
    ['merge', '--merge'],
    ['rebase', '--rebase'],
  ];
  for (const [strategy, flag] of cases) {
    it(`merges with ${flag} for strategy ${strategy}`, async () => {
      const run = vi.fn(async (_f: string, args: string[]) => {
        expect(args).toContain('pr');
        expect(args).toContain('merge');
        expect(args).toContain('42');
        expect(args).toContain(flag);
        expect(args).toContain('--delete-branch');
        return { stdout: '', stderr: '', exitCode: 0 };
      });
      await makeForge(run).mergeMr(42, strategy, true);
    });
  }

  it('omits --delete-branch when deleteSource is false', async () => {
    const run = vi.fn(async (_f: string, args: string[]) => {
      expect(args).not.toContain('--delete-branch');
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    await makeForge(run).mergeMr(42, 'squash', false);
  });
});
```

Add the import at the top of `github.test.ts`:

```ts
import type { MergeStrategy } from '../domain/types.js';
```

- [ ] **Run & see it fail.** Command: `pnpm --filter @maestro/core test forge/github.test.ts`
  Expected failure: each merge case throws `ForgeError: not implemented`.

- [ ] **Minimal complete implementation.** Replace the `mergeMr` stub:

```ts
  async mergeMr(
    mrNumber: number,
    strategy: MergeStrategy,
    deleteSource: boolean,
  ): Promise<void> {
    const flag: Record<MergeStrategy, string> = {
      squash: '--squash',
      merge: '--merge',
      rebase: '--rebase',
    };
    const args = ['pr', 'merge', String(mrNumber), '--repo', this.project, flag[strategy]];
    if (deleteSource) args.push('--delete-branch');
    await this.gh(args);
  }
```

- [ ] **Run & see it pass.** Command: `pnpm --filter @maestro/core test forge/github.test.ts`
  Expected: 19 passed.

- [ ] **Commit.**
  `git add packages/core/src/forge/github.ts packages/core/src/forge/github.test.ts`
  `git commit -m "feat(core): implement GitHubForge.mergeMr with strategy mapping"`

---

### Task 10 — `comment` (issue vs PR target)

- [ ] **Write failing test.** Append to `github.test.ts`:

```ts
describe('GitHubForge.comment', () => {
  it('comments on an issue', async () => {
    const run = vi.fn(async (_f: string, args: string[]) => {
      expect(args).toContain('issue');
      expect(args).toContain('comment');
      expect(args).toContain('7');
      expect(args).toContain('--body');
      expect(args).toContain('hello');
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    await makeForge(run).comment({ type: 'issue', number: 7 }, 'hello');
  });

  it('comments on a PR', async () => {
    const run = vi.fn(async (_f: string, args: string[]) => {
      expect(args).toContain('pr');
      expect(args).toContain('comment');
      expect(args).toContain('42');
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    await makeForge(run).comment({ type: 'mr', number: 42 }, 'done');
  });
});
```

- [ ] **Run & see it fail.** Command: `pnpm --filter @maestro/core test forge/github.test.ts`
  Expected failure: both throw `ForgeError: not implemented`.

- [ ] **Minimal complete implementation.** Replace the `comment` stub:

```ts
  async comment(target: CommentTarget, body: string): Promise<void> {
    const noun = target.type === 'issue' ? 'issue' : 'pr';
    await this.gh([
      noun,
      'comment',
      String(target.number),
      '--repo',
      this.project,
      '--body',
      body,
    ]);
  }
```

- [ ] **Run & see it pass.** Command: `pnpm --filter @maestro/core test forge/github.test.ts`
  Expected: 21 passed.

- [ ] **Commit.**
  `git add packages/core/src/forge/github.ts packages/core/src/forge/github.test.ts`
  `git commit -m "feat(core): implement GitHubForge.comment for issue and PR"`

---

### Task 11 — `setLifecycleLabel` (flat-label mutual exclusion)

Add the one target label and remove every *other* maestro flat label in a single `gh issue edit` call. For `new`/`done` (no `LabeledState`), add nothing and remove all maestro labels.

- [ ] **Write failing test.** Append to `github.test.ts`:

```ts
describe('GitHubForge.setLifecycleLabel (flat exclusivity)', () => {
  it('adds in_progress and removes the other maestro labels', async () => {
    const run = vi.fn(async (_f: string, args: string[]) => {
      expect(args).toContain('issue');
      expect(args).toContain('edit');
      expect(args).toContain('7');
      const joined = args.join(' ');
      expect(joined).toContain('--add-label');
      expect(joined).toContain('maestro:in_progress');
      expect(joined).toContain('--remove-label');
      // the other two maestro labels are removed, target is NOT removed
      expect(joined).toContain('maestro:in_review');
      expect(joined).toContain('maestro:blocked');
      // assert target not in any remove-label slot
      const removeIdxs = args.flatMap((a, i) => (a === '--remove-label' ? [i + 1] : []));
      const removed = removeIdxs.map((i) => args[i]);
      expect(removed).not.toContain('maestro:in_progress');
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    await makeForge(run).setLifecycleLabel(7, 'in_progress');
  });

  it('for new/done adds no label and removes all maestro labels', async () => {
    const run = vi.fn(async (_f: string, args: string[]) => {
      const joined = args.join(' ');
      expect(joined).not.toContain('--add-label');
      expect(joined).toContain('maestro:in_progress');
      expect(joined).toContain('maestro:in_review');
      expect(joined).toContain('maestro:blocked');
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    await makeForge(run).setLifecycleLabel(7, 'done');
  });
});
```

- [ ] **Run & see it fail.** Command: `pnpm --filter @maestro/core test forge/github.test.ts`
  Expected failure: both throw `ForgeError: not implemented`.

- [ ] **Minimal complete implementation.** Replace the `setLifecycleLabel` stub. Map the lifecycle `state` onto a `LabeledState` only when it is one; `new`/`done` add nothing.

```ts
  async setLifecycleLabel(
    issueNumber: number,
    state: LifecycleState,
  ): Promise<void> {
    const target = (LABELED_STATES as readonly string[]).includes(state)
      ? this.labelFor(state as LabeledState)
      : null;

    const toRemove = this.allLabels().filter((l) => l !== target);

    const args = ['issue', 'edit', String(issueNumber), '--repo', this.project];
    if (target) {
      args.push('--add-label', target);
    }
    for (const label of toRemove) {
      args.push('--remove-label', label);
    }
    await this.gh(args);
  }
```

- [ ] **Run & see it pass.** Command: `pnpm --filter @maestro/core test forge/github.test.ts`
  Expected: 23 passed.

- [ ] **Commit.**
  `git add packages/core/src/forge/github.ts packages/core/src/forge/github.test.ts`
  `git commit -m "feat(core): enforce flat-label exclusivity in setLifecycleLabel"`

---

### Task 12 — `ensureLabels` (idempotent) + `ensureBoard` (no-op)

Create each maestro flat label via `gh label create --force` (idempotent). `ensureBoard` is a no-op (Projects V2 deferred per spec §11/§17).

- [ ] **Write failing test.** Append to `github.test.ts`:

```ts
describe('GitHubForge.ensureLabels / ensureBoard', () => {
  it('creates each maestro lifecycle label idempotently (changesSignal=native: no changes label)', async () => {
    const created: string[] = [];
    const run = vi.fn(async (_f: string, args: string[]) => {
      expect(args).toContain('label');
      expect(args).toContain('create');
      // --force makes create idempotent
      expect(args).toContain('--force');
      const nameIdx = args.indexOf('create') + 1;
      created.push(args[nameIdx]);
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    await makeForge(run, { changesSignal: 'native' }).ensureLabels();
    expect(created.sort()).toEqual(
      ['maestro:blocked', 'maestro:in_progress', 'maestro:in_review'].sort(),
    );
  });

  it('also creates the changes-requested label when changesSignal=label', async () => {
    const created: string[] = [];
    const run = vi.fn(async (_f: string, args: string[]) => {
      const nameIdx = args.indexOf('create') + 1;
      created.push(args[nameIdx]);
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    // default makeForge: changesSignal='label', changesLabel='maestro:changes-requested'
    await makeForge(run).ensureLabels();
    expect(created.sort()).toEqual(
      [
        'maestro:blocked',
        'maestro:changes-requested',
        'maestro:in_progress',
        'maestro:in_review',
      ].sort(),
    );
  });

  it('ensureBoard is a no-op (no exec calls)', async () => {
    const run = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    await makeForge(run).ensureBoard();
    expect(run).not.toHaveBeenCalled();
  });
});
```

- [ ] **Run & see it fail.** Command: `pnpm --filter @maestro/core test forge/github.test.ts`
  Expected failure: `ensureLabels` throws `ForgeError: not implemented`; `ensureBoard` throws `ForgeError: not implemented`.

- [ ] **Minimal complete implementation.** Replace both stubs:

```ts
  async ensureLabels(): Promise<void> {
    const names = [...this.allLabels()];
    // When changes are signaled by a flat label, that label must exist too.
    if (this.changesSignal === 'label' && this.changesLabel) {
      names.push(this.changesLabel);
    }
    for (const name of names) {
      await this.gh([
        'label',
        'create',
        name,
        '--repo',
        this.project,
        '--force',
      ]);
    }
  }

  // Projects V2 board automation is deferred (spec §11/§17): GitHub repos get labels only.
  async ensureBoard(): Promise<void> {
    return;
  }
```

- [ ] **Run & see it pass.** Command: `pnpm --filter @maestro/core test forge/github.test.ts`
  Expected: lifecycle-only (native), lifecycle+changes (label), and ensureBoard no-op all pass.

- [ ] **Commit.**
  `git add packages/core/src/forge/github.ts packages/core/src/forge/github.test.ts`
  `git commit -m "feat(core): GitHubForge ensureLabels idempotent (incl changes label); ensureBoard no-op"`

---

### Task 12b — `createIssue` + `blobUrl`

Two remaining `ForgeAdapter` methods. `createIssue` (M7 onboarding) creates an issue via `gh issue create` and reads it back as a normalized `Issue`. `blobUrl` is a pure helper (no I/O) returning the GitHub committed-file URL `https://<host>/<project>/blob/<branch>/<path>` (already added in the skeleton — this task adds its test).

- [ ] **Write failing test.** Append to `github.test.ts`:

```ts
describe('GitHubForge.createIssue', () => {
  it('creates an issue and returns the mapped Issue', async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (_f: string, args: string[]) => {
      calls.push(args);
      if (args.includes('create')) {
        return { stdout: 'https://github.com/org/web/issues/7\n', stderr: '', exitCode: 0 };
      }
      // issue view readback returns the single issue object
      return { stdout: JSON.stringify(JSON.parse(GH_ISSUE_JSON)[0]), stderr: '', exitCode: 0 };
    });

    const issue = await makeForge(run).createIssue({
      title: 'Onboard maestro',
      body: 'WORKFLOW.md self-creation',
      assignee: 'maestro-bot',
    });

    const create = calls[0];
    expect(create).toContain('issue');
    expect(create).toContain('create');
    expect(create).toContain('--title');
    expect(create).toContain('Onboard maestro');
    expect(create).toContain('--body');
    expect(create).toContain('--assignee');
    expect(create).toContain('maestro-bot');
    expect(issue.number).toBe(7);
  });
});

describe('GitHubForge.blobUrl', () => {
  it('builds the GitHub blob URL (no exec)', () => {
    const forge = makeForge();
    expect(forge.blobUrl('maestro/issue-7', 'proof/issue-7.png')).toBe(
      'https://github.com/org/web/blob/maestro/issue-7/proof/issue-7.png',
    );
  });
});
```

- [ ] **Run & see it fail.** Command: `pnpm --filter @maestro/core test forge/github.test.ts`
  Expected failure: `createIssue` throws `ForgeError: not implemented`; `blobUrl` may already pass (skeleton impl).

- [ ] **Minimal complete implementation.** Replace the `createIssue` stub in `github.ts` (`blobUrl` is already implemented in the skeleton):

```ts
  async createIssue(args: {
    title: string;
    body: string;
    assignee?: string;
  }): Promise<Issue> {
    const createArgs = [
      'issue',
      'create',
      '--repo',
      this.project,
      '--title',
      args.title,
      '--body',
      args.body,
    ];
    if (args.assignee) createArgs.push('--assignee', args.assignee);
    const url = (await this.gh(createArgs)).trim();
    const number = Number(url.split('/').pop());
    const issue = await this.getIssue(number);
    if (!issue) throw new ForgeError(`created issue ${number} could not be read back`);
    return issue;
  }
```

- [ ] **Run & see it pass.** Command: `pnpm --filter @maestro/core test forge/github.test.ts`
  Expected: `createIssue` and `blobUrl` pass.

- [ ] **Commit.**
  `git add packages/core/src/forge/github.ts packages/core/src/forge/github.test.ts`
  `git commit -m "feat(core): implement GitHubForge.createIssue; cover blobUrl"`

---

### Task 13 — Wire `'github'` into the factory

Add the `'github'` branch to `createForge` so the daemon can build a `GitHubForge`. Mirror exactly how the M2 `'gitlab'` branch resolves the token (read `process.env[forges.github.tokenEnv]`) and constructs the adapter.

- [ ] **Read** `packages/core/src/forge/factory.ts` to confirm the existing `'gitlab'` branch shape: how it reads the forge auth (`host`, `tokenEnv`), how it resolves the token from `process.env`, how it derives `project`/`botUser`, and how it injects the `exec` dependency. Mirror that branch.

- [ ] **Write failing test.** Append to (or create alongside M2's) `packages/core/src/forge/factory.test.ts` a github case using the contract signature `createForge(forge, { url, project, botUser }, ForgeDeps)`:

```ts
import { describe, it, expect } from 'vitest';
import { createForge } from './factory.js';
import { GitHubForge } from './github.js';
import type { MaestroConfig } from '../config/schema.js';
import type { WorkflowConfig } from '../workflow/schema.js';
import type { CommandRunner } from '../util/exec.js';

const stubRunner: CommandRunner = {
  run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
};

const review: WorkflowConfig['review'] = { changesSignal: 'label', changesLabel: 'maestro:changes-requested' };

function ghConfig(): MaestroConfig {
  return {
    defaults: {} as MaestroConfig['defaults'],
    forges: { github: { host: 'github.com', tokenEnv: 'MAESTRO_GITHUB_TOKEN' } },
    repos: [],
  };
}

describe('createForge github branch', () => {
  it('builds a GitHubForge for forge=github', () => {
    process.env.MAESTRO_GITHUB_TOKEN = 'tok';
    const forge = createForge(
      'github',
      { url: 'https://github.com/org/web', project: 'org/web', botUser: 'maestro-bot' },
      { config: ghConfig(), review, runner: stubRunner },
    );
    expect(forge).toBeInstanceOf(GitHubForge);
    expect(forge.forge).toBe('github');
    expect(forge.project).toBe('org/web');
  });

  it('throws when the token env var is unset', () => {
    delete process.env.MAESTRO_GITHUB_TOKEN;
    expect(() =>
      createForge(
        'github',
        { url: 'https://github.com/org/web', project: 'org/web', botUser: 'maestro-bot' },
        { config: ghConfig(), review, runner: stubRunner },
      ),
    ).toThrow(/MAESTRO_GITHUB_TOKEN/);
  });
});
```

- [ ] **Run & see it fail.** Command: `pnpm --filter @maestro/core test forge/factory.test.ts`
  Expected failure: `createForge` has no `'github'` branch yet — `expect(forge).toBeInstanceOf(GitHubForge)` fails (returns/throws for unknown forge).

- [ ] **Minimal complete implementation.** In `packages/core/src/forge/factory.ts`, add the `'github'` branch mirroring the `'gitlab'` one. The factory resolves the token name from `config.forges.github.tokenEnv` and reads `process.env` (token is never embedded in URLs/logs), and threads the changes-requested signal from `deps.review` (the contract's `ForgeDeps` now carries `review: WorkflowConfig['review']` as a required field — same as M2). Use the same `config`/`repo`/`deps` variable names M2 established:

```ts
import { GitHubForge } from './github.js';
import { execaRunner } from '../util/exec.js';
// ...inside createForge(forge, repo, deps), mirroring the gitlab branch:
if (forge === 'github') {
  const auth = deps.config.forges.github;
  if (!auth) throw new ForgeError('github forge not configured');
  const token = process.env[auth.tokenEnv];
  if (!token) throw new ForgeError(`env var ${auth.tokenEnv} is not set`);
  return new GitHubForge({
    project: repo.project,
    botUser: repo.botUser,
    host: auth.host,
    token,
    changesSignal: deps.review.changesSignal,
    // flat default on GitHub; only meaningful when changesSignal === 'label'
    changesLabel: deps.review.changesLabel ?? 'maestro:changes-requested',
    runner: deps.runner ?? execaRunner,
  });
}
```

> **`changesSignal`/`changesLabel` source.** `deps.review` is the per-repo `WorkflowConfig['review']` block, a required `ForgeDeps` field in the reconciled contract (`{ config, review, runner?, fetchImpl? }`). Source both from there exactly as M2's gitlab branch does — do not re-read the workflow elsewhere or invent a parallel mechanism. `changesSignal` defaults to `'label'` at the `WorkflowConfig` schema level, so it is always present on `deps.review`; the only adapter-side default is the flat changes label `maestro:changes-requested` when `changesLabel` is omitted.
>
> The precise variable names (`config`, `repo`, `deps`, `auth`) MUST match M2's existing `factory.ts`. Reuse them; do not introduce a parallel convention. If M2 resolves the token via a shared helper, call that instead of re-reading `process.env` here.

- [ ] **Run & see it pass.** Command: `pnpm --filter @maestro/core test forge/factory.test.ts`
  Expected: the github factory case passes (alongside the existing gitlab case).

- [ ] **Commit.**
  `git add packages/core/src/forge/factory.ts packages/core/src/forge/factory.test.ts`
  `git commit -m "feat(core): wire github branch into forge factory"`

---

### Task 14 — Full-suite green + typecheck

- [ ] **Run the whole core suite.** Command: `pnpm --filter @maestro/core test`
  Expected: all forge tests pass, including `github.test.ts` and `factory.test.ts` (gitlab + github). No regressions in M1/M2 tests.

- [ ] **Typecheck.** Command: `pnpm --filter @maestro/core typecheck` (or `pnpm -w typecheck` if that is how M1 wired it — use the script M1/M2 established).
  Expected: no TypeScript errors; `GitHubForge` fully satisfies `ForgeAdapter` — **every** interface method implemented with the contract signature, including `createIssue`, `getMrDescription`, and `blobUrl`. The structural `implements ForgeAdapter` check is the proof there are no missing/mismatched methods.

- [ ] **Lint.** Command: `pnpm --filter @maestro/core lint`
  Expected: clean (no unused imports — all of `lifecycleLabel`/`allMaestroLabels`/`LABELED_STATES`/`ForgeError` are used).

- [ ] **Final commit (only if lint/format produced changes).**
  `git add packages/core/src/forge/github.ts packages/core/src/forge/github.test.ts packages/core/src/forge/factory.ts packages/core/src/forge/factory.test.ts`
  `git commit -m "chore(core): lint/format GitHub forge adapter"`

---

### Task 15 — Pin `gh` + record one real JSON fixture per read method

Contracts mandate: "Version-pin `glab` and `gh` and record one real JSON fixture per read method to lock field shapes (a setup task in M2/M6)." The unit tests above hand-author JSON; this task captures **real** `gh --json` output once so the hand-authored shapes can be verified against the installed CLI and don't silently drift.

- [ ] **Pin `gh`.** Record the exact `gh` version this adapter targets (e.g. in the repo README / a `.tool-versions` or docs note alongside the M2 `glab` pin). Use the same mechanism M2 used for `glab`.
- [ ] **Capture fixtures.** Against a scratch repo, run each read command and save the raw stdout under `packages/core/src/forge/__fixtures__/github/`:
  - `gh issue list --json id,number,title,body,state,assignees,author,labels,createdAt,url` → `issue-list.json`
  - `gh issue view <n> --json ...` → `issue-view.json`
  - `gh pr view <branch> --json id,number,headRefName,baseRefName,isDraft,state,reviewDecision,reviewRequests,closingIssuesReferences,body,labels,url` → `pr-view.json`
  - `gh pr list --json ...` → `pr-list.json`
- [ ] **Verify field names** in the captured fixtures match the mappers (`mapIssue`/`mapPr`) — especially `reviewDecision`, `reviewRequests[].login`, `closingIssuesReferences[].number`, `headRefName`/`baseRefName`, `author.login`, `assignees[].login`, and the `body`/`labels` fields added for `description`/changes-label. Run `gh pr view --json` (no value) to list the actually-supported fields for the pinned version. Adjust `PR_JSON_FIELDS`/mappers if any name differs.
- [ ] **Wire one mapper test against a fixture** (read the fixture file, feed it through the mapper) so a CLI shape change breaks CI rather than silently producing wrong domain objects.
- [ ] **Commit.**
  `git add packages/core/src/forge/__fixtures__/github packages/core/src/forge/github.test.ts`
  `git commit -m "test(core): pin gh + lock github JSON fixtures for read methods"`

---

## Verification checklist (definition of done)

- [ ] `GitHubForge` implements every method on the `ForgeAdapter` interface from `forge/adapter.ts` (typecheck proves it) — **including `createIssue`, `getMrDescription`, and `blobUrl`** (Tasks 4, 12b).
- [ ] JSON→domain mapping covered by tests: `Issue` (Task 2/3) and `MergeRequest`/PR (Task 4), including all three `state` values, `description` (PR `body`), and `approved`/`changesRequested`.
- [ ] Flat-label mutual exclusion enforced in code and tested: setting one maestro label removes the others; `new`/`done` strip all (Task 11).
- [ ] `approved` from `reviewDecision === 'APPROVED'`; `changesRequested` implements **both** `WorkflowConfig.review.changesSignal` paths — `'native'` (reviewDecision) and `'label'` default (changesLabel present), tested both ways (Task 4).
- [ ] `ensureLabels` idempotent (`--force`) and **also creates the changes-requested label when `changesSignal === 'label'`**; `ensureBoard` a no-op (Task 12).
- [ ] `blobUrl(branch, path)` returns `https://<host>/<project>/blob/<branch>/<path>` (Task 12b).
- [ ] Factory builds `GitHubForge` via the contract signature `createForge(forge, { url, project, botUser }, ForgeDeps)`, resolving the token from `process.env[tokenEnv]` and threading `changesSignal`/`changesLabel` (Task 13).
- [ ] `gh` pinned + one real JSON fixture recorded per read method; at least one mapper test runs against a fixture (Task 15).
- [ ] No real `gh`/network in any test — the injected `CommandRunner` is always stubbed.

---

## Open questions

The reconciled contract (`maestro-00-contracts.md`) resolved the former Q1 (factory signature), Q2 (shared exec seam), Q4 (`getMrForIssue` by head branch), Q7 (`reviewers` = requested), and the `WorkflowConfig.review` threading question (`ForgeDeps` now carries a required `review: WorkflowConfig['review']` field, sourced via `deps.review` in `createForge`) — those are now fixed in the plan body. The following are genuinely still open and must be resolved against the actual M1/M2 code at implementation time, or escalated.

1. **Token → `gh` env wiring.** Contracts say `tokenEnv` holds the *name* of the env var and the token must never be embedded in URLs/logs, but do not name the variable `gh` expects. This plan exports `GH_TOKEN` (and `GH_HOST` for the host) on each `runner.run`. If M2 established a different convention (e.g. a `gh auth login` step), align with it.

2. **Not-found detection.** Contracts require `getIssue`/`getMrForIssue` to return `null` on absence but do not specify how `gh` signals it (exit code vs. stderr text). This plan matches on stderr/message substrings (`not found`, `no pull requests found`). A more robust approach (parsing `gh`'s exit code via the `CommandRunner`'s `exitCode`, or `gh api` with a 404 check) should be adopted if M2 established one.

3. **`gh` JSON field names (verified by Task 15 fixtures).** The raw `gh` field names used here (`headRefName`, `baseRefName`, `reviewDecision`, `reviewRequests`, `closingIssuesReferences`, `assignees[].login`, `author.login`, `body`, `labels[].name`) are taken from the `gh` CLI's documented `--json` fields. Task 15 records real fixtures to lock them; if the pinned `gh` version uses different names, adjust `PR_JSON_FIELDS`/mappers accordingly.
