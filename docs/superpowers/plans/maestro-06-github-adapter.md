# Maestro M6 — GitHub Forge Adapter — Implementation Plan
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `GitHubForge implements ForgeAdapter` (`packages/core/src/forge/github.ts`) that drives a GitHub repo through the maestro lifecycle by shelling out to the `gh` CLI via `execa`, mapping `gh` JSON into the normalized `Issue` / `MergeRequest` (PR) domain model, enforcing flat-label (`maestro:<state>`) mutual exclusion, deriving approval/changes-requested from PR `reviewDecision`, and creating maestro labels idempotently. Wire `'github'` into `createForge` (`packages/core/src/forge/factory.ts`). `ensureBoard` is a no-op (Projects V2 deferred).

**Architecture:** The adapter is the *only* GitHub-aware code; everything above it (reconciler, daemon) consumes the normalized `ForgeAdapter` interface from `packages/core/src/forge/adapter.ts`. It mirrors the M2 GitLab adapter (`packages/core/src/forge/gitlab.ts`): a class taking an injected `execa`-shaped runner (so tests stub the subprocess; no real network), constructed from a normalized `repo` + `deps` by the factory. Tokens are passed by reading the env var whose *name* is `tokenEnv` (config never holds the token itself) and exporting it to `gh` as `GH_TOKEN`. Labels are FLAT: `lifecycleLabel('github', state)` → `maestro:in_progress` etc. `setLifecycleLabel` adds the one target label and removes every *other* maestro flat label, enforcing exclusivity in code (GitHub has no scoped-label semantics).

**Tech Stack:** Node 20+, TypeScript 5.x, ESM (`"type": "module"`). Vitest (tests colocated as `*.test.ts`). `execa` for subprocess. Package `@maestro/core`. No real `gh`/network in tests — the subprocess runner is injected and stubbed.

**Depends on:** M1 (`ForgeAdapter` interface in `forge/adapter.ts`, `ForgeError`, `CreateMrArgs`, `CommentTarget`; lifecycle label helpers in `domain/lifecycle.ts`; domain types in `domain/types.ts`), M2 (forge factory pattern in `forge/factory.ts` + GitLab adapter `forge/gitlab.ts` as the reference implementation to mirror).

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
packages/core/src/forge/gitlab.ts         # reference: structure, deps shape, exec injection
```

### Adapter construction contract (mirror M2)

`createForge(forge, repo, deps)` (per contracts `forge/factory.ts`) is the only constructor entry point. The contracts do not spell out the concrete shapes of `repo` and `deps`; this plan mirrors what M2's GitLab adapter must already have established. To stay self-contained and stubbable, `GitHubForge` is constructed with:

```ts
// All fields below are derived from the normalized repo entry + injected deps.
export interface GitHubForgeArgs {
  project: string;   // "org/repo"
  botUser: string;   // bot account username
  host: string;      // e.g. "github.com" (from forges.github.host)
  token: string;     // resolved value of process.env[forges.github.tokenEnv]
  exec: ExecFn;      // injected execa-shaped runner (stubbed in tests)
}
```

`ExecFn` is the minimal execa-shaped seam used for stubbing (matches how M2 stubs `glab`):

```ts
export type ExecResult = { stdout: string; stderr: string };
export type ExecFn = (
  file: string,
  args: string[],
  options?: { env?: Record<string, string>; cwd?: string },
) => Promise<ExecResult>;
```

> **Open question (recorded, not invented):** the exact `repo`/`deps` parameter shapes of `createForge` and the exact `ExecFn`/deps seam are defined by M1/M2 and are not in the contracts. If M2 already exports these (e.g. a shared `ExecFn` type or a `ForgeDeps`), the implementor MUST import and reuse them rather than redeclare. See "## Open questions".

---

## Tasks

### Task 0 — Read the references before writing code

- [ ] Open and read `packages/core/src/forge/adapter.ts` (the `ForgeAdapter` interface, `ForgeError`, `CreateMrArgs`, `CommentTarget`) and `packages/core/src/forge/gitlab.ts` (the M2 reference adapter). Note exactly how GitLab injects/stubs the subprocess runner, how it shapes its constructor args, and how `createForge` builds it in `factory.ts`. **Mirror that structure.** Do not redeclare types M2 already exports — import them.
- [ ] Open `packages/core/src/domain/lifecycle.ts` and confirm `lifecycleLabel('github', 'in_progress') === 'maestro:in_progress'`, and that `allMaestroLabels('github')` returns `['maestro:in_progress','maestro:in_review','maestro:blocked']`. These are the labels this adapter creates and strips.

---

### Task 1 — Adapter skeleton + readonly properties

Establish the class implementing `ForgeAdapter` with its three readonly props, so the type contract is satisfied before any method has behavior.

- [ ] **Write failing test.** Create `packages/core/src/forge/github.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { GitHubForge } from './github.js';
import type { ExecFn } from './github.js';

function makeExec(impl: Partial<Record<string, () => unknown>> = {}): ExecFn {
  // default: any unexpected call fails the test loudly
  return vi.fn(async (file: string, args: string[]) => {
    throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
  }) as unknown as ExecFn;
}

function makeForge(exec: ExecFn = makeExec()): GitHubForge {
  return new GitHubForge({
    project: 'org/web',
    botUser: 'maestro-bot',
    host: 'github.com',
    token: 'tok_test',
    exec,
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

export type ExecResult = { stdout: string; stderr: string };
export type ExecFn = (
  file: string,
  args: string[],
  options?: { env?: Record<string, string>; cwd?: string },
) => Promise<ExecResult>;

export interface GitHubForgeArgs {
  project: string;
  botUser: string;
  host: string;
  token: string;
  exec: ExecFn;
}

export class GitHubForge implements ForgeAdapter {
  readonly forge: Forge = 'github';
  readonly project: string;
  readonly botUser: string;
  private readonly host: string;
  private readonly token: string;
  private readonly exec: ExecFn;

  constructor(args: GitHubForgeArgs) {
    this.project = args.project;
    this.botUser = args.botUser;
    this.host = args.host;
    this.token = args.token;
    this.exec = args.exec;
  }

  // --- internal: run gh with the token + repo flags wired in ---
  private async gh(args: string[]): Promise<string> {
    try {
      const res = await this.exec('gh', args, {
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
    const exec = vi.fn(async (file: string, args: string[]) => {
      expect(file).toBe('gh');
      expect(args).toContain('issue');
      expect(args).toContain('list');
      expect(args).toContain('--assignee');
      expect(args).toContain('maestro-bot');
      expect(args).toContain('--state');
      expect(args).toContain('open');
      return { stdout: GH_ISSUE_JSON, stderr: '' };
    }) as unknown as ExecFn;

    const forge = makeForge(exec);
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

Add these raw `gh` JSON shapes near the top of `github.ts` (below the `ExecFn` types):

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
    const exec = vi.fn(async (_file: string, args: string[]) => {
      expect(args).toContain('view');
      expect(args).toContain('7');
      return { stdout: JSON.stringify(single), stderr: '' };
    }) as unknown as ExecFn;

    const forge = makeForge(exec);
    const issue = await forge.getIssue(7);
    expect(issue?.number).toBe(7);
    expect(issue?.state).toBe('open');
  });

  it('returns null when gh reports the issue is not found', async () => {
    const exec = vi.fn(async () => {
      const err = new Error('gh: issue not found') as Error & { exitCode: number };
      err.exitCode = 1;
      throw err;
    }) as unknown as ExecFn;

    const forge = makeForge(exec);
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
    const res = await this.exec('gh', args, {
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

### Task 4 — PR (MergeRequest) mapping core + `getMrForIssue`

Map `gh pr view --json ...` (incl. `reviewDecision`, `isDraft`, `closingIssuesReferences`) into a normalized `MergeRequest`, with `approved`/`changesRequested` derived from `reviewDecision`.

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
    url: 'https://github.com/org/web/pull/42',
    ...overrides,
  });
}

describe('GitHubForge PR mapping', () => {
  it('maps an APPROVED PR to approved:true', async () => {
    const exec = vi.fn(async (_f: string, args: string[]) => {
      expect(args).toContain('pr');
      expect(args).toContain('view');
      return { stdout: ghPr({ reviewDecision: 'APPROVED' }), stderr: '' };
    }) as unknown as ExecFn;

    const mr = await makeForge(exec).getMrForIssue(7);
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
      webUrl: 'https://github.com/org/web/pull/42',
    });
  });

  it('maps CHANGES_REQUESTED to changesRequested:true', async () => {
    const exec = vi.fn(async () => ({
      stdout: ghPr({ reviewDecision: 'CHANGES_REQUESTED' }),
      stderr: '',
    })) as unknown as ExecFn;
    const mr = await makeForge(exec).getMrForIssue(7);
    expect(mr?.approved).toBe(false);
    expect(mr?.changesRequested).toBe(true);
  });

  it('maps REVIEW_REQUIRED / empty to neither', async () => {
    const exec = vi.fn(async () => ({
      stdout: ghPr({ reviewDecision: 'REVIEW_REQUIRED' }),
      stderr: '',
    })) as unknown as ExecFn;
    const mr = await makeForge(exec).getMrForIssue(7);
    expect(mr?.approved).toBe(false);
    expect(mr?.changesRequested).toBe(false);
  });

  it('maps MERGED and CLOSED PR states', async () => {
    const exec = vi.fn(async () => ({
      stdout: ghPr({ state: 'MERGED' }),
      stderr: '',
    })) as unknown as ExecFn;
    expect((await makeForge(exec).getMrForIssue(7))?.state).toBe('merged');
  });

  it('returns null when no PR exists for the issue', async () => {
    const exec = vi.fn(async () => {
      throw new Error('no pull requests found');
    }) as unknown as ExecFn;
    expect(await makeForge(exec).getMrForIssue(7)).toBeNull();
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
  url: string;
}

const PR_JSON_FIELDS =
  'id,number,headRefName,baseRefName,isDraft,state,reviewDecision,reviewRequests,closingIssuesReferences,url';
```

```ts
  private mapPr(raw: GhPr): MergeRequest {
    const decision = raw.reviewDecision ?? '';
    const stateMap: Record<GhPr['state'], MergeRequest['state']> = {
      OPEN: 'open',
      MERGED: 'merged',
      CLOSED: 'closed',
    };
    return {
      id: raw.id,
      number: raw.number,
      sourceBranch: raw.headRefName,
      targetBranch: raw.baseRefName,
      isDraft: raw.isDraft,
      state: stateMap[raw.state],
      approved: decision === 'APPROVED',
      changesRequested: decision === 'CHANGES_REQUESTED',
      reviewers: (raw.reviewRequests ?? []).map((r) => r.login),
      linkedIssueNumbers: (raw.closingIssuesReferences ?? []).map((c) => c.number),
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
```

> Note: PR lookup keys off the branch name `maestro/issue-<number>` (fixed branch convention in contracts: "Branch name: `maestro/issue-<number>`"). `gh pr view <branch>` resolves the PR for that head branch.

- [ ] **Run & see it pass.** Command: `pnpm --filter @maestro/core test forge/github.test.ts`
  Expected: all PR-mapping cases pass (9 passed total).

- [ ] **Commit.**
  `git add packages/core/src/forge/github.ts packages/core/src/forge/github.test.ts`
  `git commit -m "feat(core): map gh PR JSON incl reviewDecision to MergeRequest"`

---

### Task 5 — `listOpenMrsByBot`

List open PRs authored by the bot and map them.

- [ ] **Write failing test.** Append to `github.test.ts`:

```ts
describe('GitHubForge.listOpenMrsByBot', () => {
  it('lists open PRs authored by the bot', async () => {
    const exec = vi.fn(async (_f: string, args: string[]) => {
      expect(args).toContain('pr');
      expect(args).toContain('list');
      expect(args).toContain('--author');
      expect(args).toContain('maestro-bot');
      expect(args).toContain('--state');
      expect(args).toContain('open');
      return { stdout: `[${ghPr({ reviewDecision: 'APPROVED' })}]`, stderr: '' };
    }) as unknown as ExecFn;

    const mrs = await makeForge(exec).listOpenMrsByBot();
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
    const exec = vi.fn(async (_f: string, args: string[]) => {
      calls.push(args);
      if (args.includes('git/ref/heads/main')) {
        return { stdout: JSON.stringify({ object: { sha: 'deadbeef' } }), stderr: '' };
      }
      return { stdout: '{}', stderr: '' };
    }) as unknown as ExecFn;

    await makeForge(exec).createBranch('maestro/issue-7', 'main');

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
    const exec = vi.fn(async (_f: string, args: string[]) => {
      calls.push(args);
      if (args.includes('create')) {
        return { stdout: 'https://github.com/org/web/pull/42\n', stderr: '' };
      }
      // pr view readback
      return { stdout: ghPr({ isDraft: true }), stderr: '' };
    }) as unknown as ExecFn;

    const mr = await makeForge(exec).createDraftMr({
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
    const exec = vi.fn(async (_f: string, args: string[]) => {
      expect(args).toContain('pr');
      expect(args).toContain('ready');
      expect(args).toContain('42');
      return { stdout: '', stderr: '' };
    }) as unknown as ExecFn;
    await makeForge(exec).setMrReady(42);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('updateMrDescription edits the body', async () => {
    const exec = vi.fn(async (_f: string, args: string[]) => {
      expect(args).toContain('pr');
      expect(args).toContain('edit');
      expect(args).toContain('--body');
      expect(args).toContain('new plan');
      return { stdout: '', stderr: '' };
    }) as unknown as ExecFn;
    await makeForge(exec).updateMrDescription(42, 'new plan');
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('assignReviewer requests review from the user', async () => {
    const exec = vi.fn(async (_f: string, args: string[]) => {
      expect(args).toContain('pr');
      expect(args).toContain('edit');
      expect(args).toContain('--add-reviewer');
      expect(args).toContain('alice');
      return { stdout: '', stderr: '' };
    }) as unknown as ExecFn;
    await makeForge(exec).assignReviewer(42, 'alice');
    expect(exec).toHaveBeenCalledTimes(1);
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
      const exec = vi.fn(async (_f: string, args: string[]) => {
        expect(args).toContain('pr');
        expect(args).toContain('merge');
        expect(args).toContain('42');
        expect(args).toContain(flag);
        expect(args).toContain('--delete-branch');
        return { stdout: '', stderr: '' };
      }) as unknown as ExecFn;
      await makeForge(exec).mergeMr(42, strategy, true);
    });
  }

  it('omits --delete-branch when deleteSource is false', async () => {
    const exec = vi.fn(async (_f: string, args: string[]) => {
      expect(args).not.toContain('--delete-branch');
      return { stdout: '', stderr: '' };
    }) as unknown as ExecFn;
    await makeForge(exec).mergeMr(42, 'squash', false);
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
    const exec = vi.fn(async (_f: string, args: string[]) => {
      expect(args).toContain('issue');
      expect(args).toContain('comment');
      expect(args).toContain('7');
      expect(args).toContain('--body');
      expect(args).toContain('hello');
      return { stdout: '', stderr: '' };
    }) as unknown as ExecFn;
    await makeForge(exec).comment({ type: 'issue', number: 7 }, 'hello');
  });

  it('comments on a PR', async () => {
    const exec = vi.fn(async (_f: string, args: string[]) => {
      expect(args).toContain('pr');
      expect(args).toContain('comment');
      expect(args).toContain('42');
      return { stdout: '', stderr: '' };
    }) as unknown as ExecFn;
    await makeForge(exec).comment({ type: 'mr', number: 42 }, 'done');
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
    const exec = vi.fn(async (_f: string, args: string[]) => {
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
      return { stdout: '', stderr: '' };
    }) as unknown as ExecFn;
    await makeForge(exec).setLifecycleLabel(7, 'in_progress');
  });

  it('for new/done adds no label and removes all maestro labels', async () => {
    const exec = vi.fn(async (_f: string, args: string[]) => {
      const joined = args.join(' ');
      expect(joined).not.toContain('--add-label');
      expect(joined).toContain('maestro:in_progress');
      expect(joined).toContain('maestro:in_review');
      expect(joined).toContain('maestro:blocked');
      return { stdout: '', stderr: '' };
    }) as unknown as ExecFn;
    await makeForge(exec).setLifecycleLabel(7, 'done');
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
  it('creates each maestro label idempotently', async () => {
    const created: string[] = [];
    const exec = vi.fn(async (_f: string, args: string[]) => {
      expect(args).toContain('label');
      expect(args).toContain('create');
      // --force makes create idempotent
      expect(args).toContain('--force');
      const nameIdx = args.indexOf('create') + 1;
      created.push(args[nameIdx]);
      return { stdout: '', stderr: '' };
    }) as unknown as ExecFn;

    await makeForge(exec).ensureLabels();
    expect(created.sort()).toEqual(
      ['maestro:blocked', 'maestro:in_progress', 'maestro:in_review'].sort(),
    );
  });

  it('ensureBoard is a no-op (no exec calls)', async () => {
    const exec = vi.fn(async () => ({ stdout: '', stderr: '' })) as unknown as ExecFn;
    await makeForge(exec).ensureBoard();
    expect(exec).not.toHaveBeenCalled();
  });
});
```

- [ ] **Run & see it fail.** Command: `pnpm --filter @maestro/core test forge/github.test.ts`
  Expected failure: `ensureLabels` throws `ForgeError: not implemented`; `ensureBoard` throws `ForgeError: not implemented`.

- [ ] **Minimal complete implementation.** Replace both stubs:

```ts
  async ensureLabels(): Promise<void> {
    for (const name of this.allLabels()) {
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
  Expected: 25 passed.

- [ ] **Commit.**
  `git add packages/core/src/forge/github.ts packages/core/src/forge/github.test.ts`
  `git commit -m "feat(core): GitHubForge ensureLabels idempotent; ensureBoard no-op"`

---

### Task 13 — Wire `'github'` into the factory

Add the `'github'` branch to `createForge` so the daemon can build a `GitHubForge`. Mirror exactly how the M2 `'gitlab'` branch resolves the token (read `process.env[forges.github.tokenEnv]`) and constructs the adapter.

- [ ] **Read** `packages/core/src/forge/factory.ts` to confirm the existing `'gitlab'` branch shape: how it reads the forge auth (`host`, `tokenEnv`), how it resolves the token from `process.env`, how it derives `project`/`botUser`, and how it injects the `exec` dependency. Mirror that branch.

- [ ] **Write failing test.** Append to (or create alongside M2's) `packages/core/src/forge/factory.test.ts` a github case. (The exact `createForge` signature is owned by M2; this test uses whatever shape M2's gitlab test already uses, swapping `forge: 'github'`.) Sketch:

```ts
import { describe, it, expect } from 'vitest';
import { createForge } from './factory.js';
import { GitHubForge } from './github.js';

describe('createForge github branch', () => {
  it('builds a GitHubForge for forge=github', () => {
    // NOTE: mirror M2's gitlab test setup for repo/deps/env exactly; only swap forge.
    process.env.MAESTRO_GITHUB_TOKEN = 'tok';
    const forge = createForge(/* mirror M2 gitlab args, forge: 'github' */);
    expect(forge).toBeInstanceOf(GitHubForge);
    expect(forge.forge).toBe('github');
  });
});
```

- [ ] **Run & see it fail.** Command: `pnpm --filter @maestro/core test forge/factory.test.ts`
  Expected failure: `createForge` throws / returns undefined for `forge === 'github'` (no `'github'` branch yet) — assertion `expect(forge).toBeInstanceOf(GitHubForge)` fails.

- [ ] **Minimal complete implementation.** In `packages/core/src/forge/factory.ts`, add the `'github'` branch mirroring the `'gitlab'` one. Conceptually:

```ts
import { GitHubForge } from './github.js';
// ...inside createForge, mirroring the gitlab branch:
if (forge === 'github') {
  const auth = config.forges.github;
  if (!auth) throw new ForgeError('github forge not configured');
  const token = process.env[auth.tokenEnv];
  if (!token) throw new ForgeError(`env var ${auth.tokenEnv} is not set`);
  return new GitHubForge({
    project: repo.project,
    botUser: repo.botUser,
    host: auth.host,
    token,
    exec: deps.exec,
  });
}
```

> The precise variable names (`config`, `repo`, `deps`, `auth`) MUST match M2's existing `factory.ts`. Reuse them; do not introduce a parallel convention. If M2 resolves the token elsewhere (e.g. a shared `resolveToken` helper), call that instead of re-reading `process.env` here.

- [ ] **Run & see it pass.** Command: `pnpm --filter @maestro/core test forge/factory.test.ts`
  Expected: the github factory case passes (alongside the existing gitlab case).

- [ ] **Commit.**
  `git add packages/core/src/forge/factory.ts packages/core/src/forge/factory.test.ts`
  `git commit -m "feat(core): wire github branch into forge factory"`

---

### Task 14 — Full-suite green + typecheck

- [ ] **Run the whole core suite.** Command: `pnpm --filter @maestro/core test`
  Expected: all forge tests pass, including `github.test.ts` (25) and `factory.test.ts` (gitlab + github). No regressions in M1/M2 tests.

- [ ] **Typecheck.** Command: `pnpm --filter @maestro/core typecheck` (or `pnpm -w typecheck` if that is how M1 wired it — use the script M1/M2 established).
  Expected: no TypeScript errors; `GitHubForge` fully satisfies `ForgeAdapter` (every interface method implemented with the contract signature).

- [ ] **Lint.** Command: `pnpm --filter @maestro/core lint`
  Expected: clean (no unused imports — all of `lifecycleLabel`/`allMaestroLabels`/`LABELED_STATES`/`ForgeError` are used).

- [ ] **Final commit (only if lint/format produced changes).**
  `git add packages/core/src/forge/github.ts packages/core/src/forge/github.test.ts packages/core/src/forge/factory.ts packages/core/src/forge/factory.test.ts`
  `git commit -m "chore(core): lint/format GitHub forge adapter"`

---

## Verification checklist (definition of done)

- [ ] `GitHubForge` implements every method on the `ForgeAdapter` interface from `forge/adapter.ts` (typecheck proves it).
- [ ] JSON→domain mapping covered by tests: `Issue` (Task 2/3) and `MergeRequest`/PR (Task 4), including all three `state` values and `reviewDecision` → `approved`/`changesRequested`.
- [ ] Flat-label mutual exclusion enforced in code and tested: setting one maestro label removes the others; `new`/`done` strip all (Task 11).
- [ ] `reviewDecision` mapping tested for `APPROVED`, `CHANGES_REQUESTED`, and `REVIEW_REQUIRED`/empty (Task 4).
- [ ] `ensureLabels` idempotent (`--force`); `ensureBoard` a no-op (Task 12).
- [ ] Factory builds `GitHubForge` for `forge: 'github'`, resolving the token from `process.env[tokenEnv]` (Task 13).
- [ ] No real `gh`/network in any test — the injected `ExecFn` is always stubbed.

---

## Open questions

These are not specified by `maestro-00-contracts.md` (or the spec) and were **not invented** in the plan. They must be resolved against the actual M1/M2 code at implementation time, or escalated.

1. **`createForge` parameter shapes.** The contracts declare `createForge(forge, repo, deps)` in `forge/factory.ts` but do not define the concrete types of `repo` or `deps` (e.g. whether `repo` carries `project`/`botUser` already-normalized, and what `deps` contains). M2 owns these. The implementor MUST read `factory.ts`/`gitlab.ts` and mirror them; this plan's `GitHubForgeArgs` is a mirror assumption, not a contract.

2. **Subprocess injection seam (`ExecFn`).** The contracts fix `execa` as the subprocess tool but do not specify how adapters take it for testing (constructor-injected runner vs. importing `execa` directly). This plan injects an `ExecFn` to keep tests network-free, matching the stated M2 approach ("stub execa; no real network"). If M2 already exports a shared `ExecFn`/`ForgeDeps` type, reuse it instead of the local declaration here.

3. **Token → `gh` env wiring.** Contracts say `tokenEnv` holds the *name* of the env var and the adapter authenticates `gh` with that token, but do not name the variable `gh` expects. This plan uses `GH_TOKEN` (and `GH_HOST` for the host). If M2 established a different convention (e.g. a login step), align with it.

4. **PR↔issue association key.** Contracts fix the branch convention `maestro/issue-<number>` and the MR body `Closes #N`, and `MergeRequest.linkedIssueNumbers` "from Closes #N". They do not state *how* `getMrForIssue` finds the PR. This plan resolves the PR by head branch (`gh pr view maestro/issue-<number>`), which is consistent with the fixed branch convention; confirm this matches how M2's `getMrForIssue` locates the MR (e.g. it may instead list-and-filter on `linkedIssueNumbers`).

5. **Not-found detection.** Contracts require `getIssue`/`getMrForIssue` to return `null` on absence but do not specify how `gh` signals it (exit code vs. stderr text). This plan matches on stderr/message substrings (`not found`, `no pull requests found`). A more robust approach (parsing `gh`'s exit code, or using `gh api` with a 404 check) should be adopted if M2 established one.

6. **`gh` JSON field names.** The raw `gh` field names used here (`headRefName`, `baseRefName`, `reviewDecision`, `reviewRequests`, `closingIssuesReferences`, `assignees[].login`, `author.login`) are taken from the `gh` CLI's documented `--json` fields, not from the contracts. They should be verified against the installed `gh` version during implementation (e.g. `gh pr view --json` with no value lists available fields).

7. **`reviewRequests` vs. completed reviewers.** `MergeRequest.reviewers` is normalized but the contracts don't define whether it means *requested* reviewers or *those who reviewed*. This plan maps `gh`'s `reviewRequests` (pending requested reviewers). Confirm intended semantics against how the reconciler consumes `reviewers`.
