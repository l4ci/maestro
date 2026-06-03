# Maestro M2 — GitLab Forge Adapter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `GitLabForge` (every `ForgeAdapter` method) backed by `glab` + GitLab REST, plus `createForge` factory, and rewire the daemon loop to obtain the adapter via the factory instead of the M1 hard-wired `MemoryForge` demo path.

**Architecture:** `GitLabForge` is a thin, testable adapter that depends only on two injected seams — the shared `CommandRunner` (`run(cmd, args, opts) => {stdout, stderr, exitCode}`) from `packages/core/src/util/exec.ts` and an HTTP `fetch` — so all tests stub I/O and never touch real GitLab. Reads use `glab` JSON output; writes that have no clean `glab` flag (label create, board/list create, scoped-label exclusivity) use GitLab REST with a token resolved inside the adapter via `config.forges[forge].tokenEnv`. The adapter maps raw GitLab JSON into the normalized `Issue` / `MergeRequest` domain types so the reconciler stays forge-agnostic. `createForge` selects the implementation per repo forge. `daemon/loop.ts` is modified minimally to call `createForge` per repo.

**Tech Stack:** Node 20+, TypeScript 5.x (ESM), Vitest, `execa`, native `fetch`, contracts from `maestro-00-contracts.md`.

**Depends on:** M1 (domain types in `domain/types.ts`, `domain/lifecycle.ts`, `ForgeAdapter` interface + `ForgeError` in `forge/adapter.ts`, `forge/memory.ts`, the pure reconciler `derive.ts`/`decide.ts`/`index.ts`, and `daemon/loop.ts` + `daemon/state.ts` already exist and pass their tests).

---

## File Structure

| Path | Responsibility | Action |
|---|---|---|
| `packages/core/src/forge/gitlab.ts` | `GitLabForge implements ForgeAdapter` (every method incl. `createIssue`, `getMrDescription`, `blobUrl`); `glab`+REST I/O via the shared `CommandRunner` (`util/exec.ts`) and `fetch`; GitLab JSON → domain mapping (incl. `MergeRequest.description`); scoped-label exclusivity; approval + `changesSignal`-driven changes detection; `ensureLabels` (+ changes-requested label) / `ensureBoard`. | Create |
| `packages/core/src/forge/fixtures/*` | Pinned `glab` version + one recorded JSON payload per read method (Task 0). | Create |
| `packages/core/src/forge/gitlab.test.ts` | Unit tests: JSON→domain mapping, scoped-label exclusivity, approval + both `changesSignal` paths, `getMrForIssue` by head branch, `createIssue`/`getMrDescription`/`blobUrl`, `ensureLabels` (+ changes label) POST calls, `ensureBoard` board+list creation, rebase-then-merge. | Create |
| `packages/core/src/forge/factory.ts` | `createForge(forge, { url, project, botUser }, ForgeDeps)` → `GitLabForge` for `'gitlab'`; throws `ForgeError` for unimplemented forges (GitHub added in M6). | Create |
| `packages/core/src/forge/factory.test.ts` | Unit tests: returns `GitLabForge` for `'gitlab'`; throws for `'github'`. | Create |
| `packages/core/src/daemon/loop.ts` | Obtain the per-repo adapter via `createForge` instead of the M1 hard-wired `MemoryForge`. | Modify (minimal) |

### Injected seam type (imported from `util/exec.ts` — NOT declared here)

The subprocess seam is the **shared** `CommandRunner` from
`packages/core/src/util/exec.ts` (contract: "No plan declares its own
`ExecFn`/`CommandRunner`"). This plan imports it; it does not redefine it.

```ts
// packages/core/src/util/exec.ts (M1 — imported, not declared here)
export interface CommandRunner {
  run(cmd: string, args: string[], opts?: { cwd?: string; input?: string; env?: Record<string, string> }):
    Promise<{ stdout: string; stderr: string; exitCode: number }>;
}
export const execaRunner: CommandRunner;   // production impl over execa
```

`GitLabForge` is constructed by `createForge` with the contract-mandated shapes —
`repo: { url; project; botUser }` and `deps: ForgeDeps = { config; runner?; fetchImpl? }`.
It carries those forward internally:

```ts
// packages/core/src/forge/gitlab.ts
import type { CommandRunner } from '../util/exec.js';
import type { MaestroConfig } from '../config/schema.js';
import type { WorkflowConfig } from '../workflow/schema.js';

// The HTTP seam. Native `fetch` satisfies this in production; tests pass a stub.
export type FetchLike = typeof fetch;

export interface GitLabForgeDeps {
  runner: CommandRunner;     // shared seam from util/exec.ts (default execaRunner)
  fetchImpl: FetchLike;      // global fetch
  config: MaestroConfig;     // token + host resolved via config.forges.gitlab
  review: WorkflowConfig['review'];  // { changesSignal: 'native'|'label'; changesLabel? }
}
```

> **Why `review` is in deps:** the `ForgeAdapter` interface fixes
> `getMrForIssue(issueNumber)` / `ensureLabels()` with no per-call workflow arg, yet
> the contract says `MergeRequest.changesRequested` is "derived per
> `WorkflowConfig.review.changesSignal`" and `ensureLabels` creates the
> changes-requested label only when `changesSignal === 'label'`. The per-repo review
> config is therefore injected once at construction (the daemon already has the
> repo's `WorkflowConfig`).

> **Token rule (spec §5, contracts):** the adapter resolves the token from
> `config.forges.gitlab` — it reads the env var **named** by `tokenEnv`:
> `process.env[config.forges.gitlab.tokenEnv]`. The host comes from
> `config.forges.gitlab.host`. The plan never logs or hard-codes a token.

> **GitLab REST conventions used below:**
> - Base URL: `https://${this.host}/api/v4` where `this.host = config.forges.gitlab.host`.
> - Auth header: `PRIVATE-TOKEN: <token>`.
> - Project id in paths is the URL-encoded `project` path (e.g. `group%2Frepo`).
> - Scoped labels (`maestro::in_progress`) are mutually exclusive in GitLab *only when the `::` separator is single-colon-scoped*; the contract uses `maestro::<state>`. We additionally enforce exclusivity ourselves by removing the other maestro labels on every `setLifecycleLabel` so behaviour is identical regardless of GitLab's own scoped-label handling.

---

## Task 0: Version-pin `glab` + record one real JSON fixture per read method

Contract ("Module ownership notes"): **version-pin `glab`** and record one real
JSON fixture per read method to lock field shapes. `glab`'s `-F json` output has
historically drifted from raw REST (label objects vs. strings; `iid` vs `id`), and
the contracts pin no version, so the mappers in Tasks 2/4/6 must be validated
against a captured shape — not assumed.

**Files:**
- Create: `packages/core/src/forge/fixtures/glab-version.txt` (pinned `glab --version`)
- Create: `packages/core/src/forge/fixtures/issue-list.json`, `issue-view.json`, `mr-list.json`, `mr-approval-state.json`, `mr-discussions.json`

- [ ] **Step 1:** Pin the toolchain. Record the exact version this adapter is
  validated against (e.g. `glab 1.45.0`) in `fixtures/glab-version.txt`, and add it
  to the repo's tool-version doc / `mise`/`asdf` pin so CI and dev use the same `glab`.

- [ ] **Step 2:** Capture one real JSON payload per read method against a throwaway
  GitLab project, saving raw stdout verbatim:
  - `glab issue list --assignee <bot> --state opened -R <proj> -F json` → `issue-list.json`
  - `glab issue view <iid> -R <proj> -F json` → `issue-view.json`
  - `glab mr list --author <bot> --state opened -R <proj> -F json` → `mr-list.json`
  - `GET /projects/:id/merge_requests/:iid/approval_state` → `mr-approval-state.json`
  - `GET /projects/:id/merge_requests/:iid/discussions` → `mr-discussions.json`

- [ ] **Step 3:** Confirm each fixture's field names match the `Raw*` interfaces in
  Tasks 2/4/6 (`iid`, `web_url`, `source_branch`, `labels` as a string array,
  `assignees[].username`). If `glab` emits label objects instead of strings for the
  pinned version, adjust `RawGitLabIssue.labels` / the mapper accordingly **here**,
  before the mapping tasks rely on it. The Task 2/4/6 unit tests SHOULD derive their
  inline payloads from these fixtures so tests and reality stay locked.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/forge/fixtures/
git commit -m "chore(forge): pin glab version and record GitLab read fixtures"
```

---

## Task 1: `GitLabForge` skeleton with read-only props (shared `CommandRunner`)

**Files:**
- Create: `packages/core/src/forge/gitlab.ts`
- Test: `packages/core/src/forge/gitlab.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/forge/gitlab.test.ts
import { describe, it, expect, vi } from 'vitest';
import { GitLabForge, type GitLabForgeDeps } from './gitlab.js';
import type { MaestroConfig } from '../config/schema.js';

// Minimal config carrying the gitlab forge auth the adapter reads.
function makeConfig(over: Partial<MaestroConfig> = {}): MaestroConfig {
  return {
    defaults: {
      pollIntervalActive: '30s', pollIntervalIdle: '5m', pollJitter: '5s',
      botUser: 'maestro-bot',
      concurrency: { globalMax: 2 },
      workspaces: { root: './workspaces', diskCap: '20GB', cleanup: 'lru' },
      web: { port: 7330, host: '127.0.0.1' },
    },
    forges: { gitlab: { host: 'gitlab.com', tokenEnv: 'MAESTRO_GITLAB_TOKEN' } },
    repos: [],
    ...over,
  } as MaestroConfig;
}

const repo = { url: 'https://gitlab.com/group/repo', project: 'group/repo', botUser: 'maestro-bot' };

function makeDeps(over: Partial<GitLabForgeDeps> = {}): GitLabForgeDeps {
  return {
    runner: { run: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })) },
    fetchImpl: vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch,
    config: makeConfig(),
    review: { changesSignal: 'label', changesLabel: 'maestro::changes-requested' },
    ...over,
  };
}

// The token is read from the env var NAMED by config.forges.gitlab.tokenEnv.
// Tasks that exercise REST set process.env[...] (or stub it) before constructing.
beforeEach(() => { process.env.MAESTRO_GITLAB_TOKEN = 'tok-123'; });

describe('GitLabForge construction', () => {
  it('exposes forge, project and botUser', () => {
    const f = new GitLabForge(repo, makeDeps());
    expect(f.forge).toBe('gitlab');
    expect(f.project).toBe('group/repo');
    expect(f.botUser).toBe('maestro-bot');
  });
});
```

> `beforeEach` requires importing it from `vitest`. Tests that must assert a missing
> token (Task 5) `delete process.env.MAESTRO_GITLAB_TOKEN` inside the case.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core test -- src/forge/gitlab.test.ts`
Expected: FAIL — `Failed to resolve import "./gitlab.js"` / "GitLabForge is not a constructor".

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/forge/gitlab.ts
import type {
  Forge,
  Issue,
  MergeRequest,
  LifecycleState,
  MergeStrategy,
} from '../domain/types.js';
import type { ForgeAdapter, CreateMrArgs, CommentTarget } from './adapter.js';
import { ForgeError } from './adapter.js';
import { LABELED_STATES, lifecycleLabel, allMaestroLabels } from '../domain/lifecycle.js';
import type { CommandRunner } from '../util/exec.js';
import type { MaestroConfig } from '../config/schema.js';
import type { WorkflowConfig } from '../workflow/schema.js';

export type FetchLike = typeof fetch;

export interface GitLabForgeDeps {
  runner: CommandRunner;     // shared seam from util/exec.ts (default execaRunner)
  fetchImpl: FetchLike;      // global fetch
  config: MaestroConfig;     // token + host resolved via config.forges.gitlab
  review: WorkflowConfig['review'];  // { changesSignal: 'native'|'label'; changesLabel? }
}

// The repo identity the factory passes through (contract createForge `repo` shape).
export interface GitLabForgeRepo {
  url: string;       // clone url (kept for parity; reads use `project`)
  project: string;   // gitlab path, e.g. "group/repo"
  botUser: string;
}

export class GitLabForge implements ForgeAdapter {
  readonly forge: Forge = 'gitlab';
  readonly project: string;
  readonly botUser: string;
  private readonly url: string;

  constructor(
    repo: GitLabForgeRepo,
    private readonly deps: GitLabForgeDeps,
  ) {
    this.project = repo.project;
    this.botUser = repo.botUser;
    this.url = repo.url;
  }

  // --- reads ---
  listAssignedOpenIssues(): Promise<Issue[]> { throw new Error('not implemented'); }
  getIssue(_issueNumber: number): Promise<Issue | null> { throw new Error('not implemented'); }
  listOpenMrsByBot(): Promise<MergeRequest[]> { throw new Error('not implemented'); }
  getMrForIssue(_issueNumber: number): Promise<MergeRequest | null> { throw new Error('not implemented'); }
  getMrDescription(_mrNumber: number): Promise<string> { throw new Error('not implemented'); }

  // --- writes ---
  createIssue(_args: { title: string; body: string; assignee?: string }): Promise<Issue> { throw new Error('not implemented'); }
  createBranch(_name: string, _fromRef: string): Promise<void> { throw new Error('not implemented'); }
  createDraftMr(_args: CreateMrArgs): Promise<MergeRequest> { throw new Error('not implemented'); }
  setMrReady(_mrNumber: number): Promise<void> { throw new Error('not implemented'); }
  updateMrDescription(_mrNumber: number, _body: string): Promise<void> { throw new Error('not implemented'); }
  assignReviewer(_mrNumber: number, _username: string): Promise<void> { throw new Error('not implemented'); }
  mergeMr(_mrNumber: number, _strategy: MergeStrategy, _deleteSource: boolean): Promise<void> { throw new Error('not implemented'); }
  comment(_target: CommentTarget, _body: string): Promise<void> { throw new Error('not implemented'); }
  setLifecycleLabel(_issueNumber: number, _state: LifecycleState): Promise<void> { throw new Error('not implemented'); }

  // --- pure helper (no I/O) ---
  blobUrl(_branch: string, _path: string): string { throw new Error('not implemented'); }

  // --- setup ---
  ensureLabels(): Promise<void> { throw new Error('not implemented'); }
  ensureBoard(): Promise<void> { throw new Error('not implemented'); }
}
```

> The unused imports (`ForgeError`, `LABELED_STATES`, `lifecycleLabel`, `allMaestroLabels`) are consumed by later tasks; if your lint config fails on unused imports, add them in the task that first uses them instead. Keep them out of Step 3 if lint blocks the commit, and re-add per task.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/core test -- src/forge/gitlab.test.ts`
Expected: PASS (1 passing).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/forge/gitlab.ts packages/core/src/forge/gitlab.test.ts
git commit -m "feat(forge): add GitLabForge skeleton with injected runner/fetch deps"
```

---

## Task 2: Map GitLab issue JSON → normalized `Issue` (`listAssignedOpenIssues`)

`glab issue list` supports `--assignee`, `--state`, and `-F json`. We map each raw issue to the `Issue` shape. Raw GitLab issue JSON fields used: `id`, `iid`, `title`, `description`, `state` (`opened`/`closed`), `assignees[].username`, `author.username`, `labels[]` (array of label name strings via `glab`), `created_at`, `web_url`.

**Files:**
- Modify: `packages/core/src/forge/gitlab.ts`
- Test: `packages/core/src/forge/gitlab.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/core/src/forge/gitlab.test.ts
describe('GitLabForge.listAssignedOpenIssues', () => {
  it('maps glab issue JSON to normalized Issue and filters by assignee+state', async () => {
    const raw = [
      {
        id: 1001,
        iid: 7,
        title: 'Fix login',
        description: 'body text',
        state: 'opened',
        assignees: [{ username: 'maestro-bot' }],
        author: { username: 'alice' },
        labels: ['bug', 'maestro::in_progress'],
        created_at: '2026-06-01T10:00:00Z',
        web_url: 'https://gitlab.com/group/repo/-/issues/7',
      },
    ];
    const run = vi.fn(async () => ({ stdout: JSON.stringify(raw), stderr: '', exitCode: 0 }));
    const f = new GitLabForge(repo, makeDeps({ runner: { run } }));

    const issues = await f.listAssignedOpenIssues();

    expect(run).toHaveBeenCalledWith(
      'glab',
      ['issue', 'list', '--assignee', 'maestro-bot', '--state', 'opened', '-R', 'group/repo', '-F', 'json'],
    );
    expect(issues).toEqual([
      {
        id: '1001',
        number: 7,
        title: 'Fix login',
        body: 'body text',
        state: 'open',
        assignees: ['maestro-bot'],
        authorUsername: 'alice',
        labels: ['bug', 'maestro::in_progress'],
        createdAt: '2026-06-01T10:00:00Z',
        webUrl: 'https://gitlab.com/group/repo/-/issues/7',
      },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core test -- src/forge/gitlab.test.ts -t listAssignedOpenIssues`
Expected: FAIL with `Error: not implemented`.

- [ ] **Step 3: Write minimal implementation**

Add a raw-issue type and a private mapper, then implement the method. Replace the `listAssignedOpenIssues` stub and the `getIssue` stub-neighbours stay as-is.

```ts
// add near the top of gitlab.ts (after imports)
interface RawGitLabIssue {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  state: string;                 // 'opened' | 'closed'
  assignees?: { username: string }[];
  author?: { username: string };
  labels?: string[];
  created_at: string;
  web_url: string;
}

function mapIssue(raw: RawGitLabIssue): Issue {
  return {
    id: String(raw.id),
    number: raw.iid,
    title: raw.title,
    body: raw.description ?? '',
    state: raw.state === 'closed' ? 'closed' : 'open',
    assignees: (raw.assignees ?? []).map((a) => a.username),
    authorUsername: raw.author?.username ?? '',
    labels: raw.labels ?? [],
    createdAt: raw.created_at,
    webUrl: raw.web_url,
  };
}
```

```ts
// replace the listAssignedOpenIssues stub
async listAssignedOpenIssues(): Promise<Issue[]> {
  const { stdout } = await this.deps.runner.run('glab', [
    'issue', 'list',
    '--assignee', this.botUser,
    '--state', 'opened',
    '-R', this.project,
    '-F', 'json',
  ]);
  const raw = JSON.parse(stdout) as RawGitLabIssue[];
  return raw.map(mapIssue);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/core test -- src/forge/gitlab.test.ts -t listAssignedOpenIssues`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/forge/gitlab.ts packages/core/src/forge/gitlab.test.ts
git commit -m "feat(forge): map glab issue JSON to normalized Issue in listAssignedOpenIssues"
```

---

## Task 3: `getIssue` (single issue, returns null when not found)

`glab issue view <iid> -R <project> -F json` returns one raw issue. A non-existent issue makes `glab` exit non-zero; we surface that as `null`.

**Files:**
- Modify: `packages/core/src/forge/gitlab.ts`
- Test: `packages/core/src/forge/gitlab.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to gitlab.test.ts
describe('GitLabForge.getIssue', () => {
  it('returns a mapped Issue when found', async () => {
    const raw = {
      id: 2002, iid: 9, title: 'T', description: null, state: 'opened',
      assignees: [], author: { username: 'bob' }, labels: [],
      created_at: '2026-06-02T00:00:00Z', web_url: 'https://gitlab.com/group/repo/-/issues/9',
    };
    const run = vi.fn(async () => ({ stdout: JSON.stringify(raw), stderr: '', exitCode: 0 }));
    const f = new GitLabForge(repo, makeDeps({ runner: { run } }));
    const issue = await f.getIssue(9);
    expect(run).toHaveBeenCalledWith('glab', ['issue', 'view', '9', '-R', 'group/repo', '-F', 'json']);
    expect(issue?.number).toBe(9);
    expect(issue?.body).toBe('');
  });

  it('returns null when glab fails (issue not found)', async () => {
    const run = vi.fn(async () => { throw new Error('404 not found'); });
    const f = new GitLabForge(repo, makeDeps({ runner: { run } }));
    expect(await f.getIssue(123)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core test -- src/forge/gitlab.test.ts -t getIssue`
Expected: FAIL with `Error: not implemented`.

- [ ] **Step 3: Write minimal implementation**

```ts
// replace the getIssue stub
async getIssue(issueNumber: number): Promise<Issue | null> {
  try {
    const { stdout } = await this.deps.runner.run('glab', [
      'issue', 'view', String(issueNumber), '-R', this.project, '-F', 'json',
    ]);
    return mapIssue(JSON.parse(stdout) as RawGitLabIssue);
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/core test -- src/forge/gitlab.test.ts -t getIssue`
Expected: PASS (2 passing).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/forge/gitlab.ts packages/core/src/forge/gitlab.test.ts
git commit -m "feat(forge): implement getIssue with null-on-not-found"
```

---

## Task 4: Map GitLab MR JSON → normalized `MergeRequest` (`listOpenMrsByBot`)

`glab mr list --author <bot> --state opened -R <project> -F json`. Raw MR fields used: `id`, `iid`, `source_branch`, `target_branch`, `draft` (bool), `state` (`opened`/`merged`/`closed`), `reviewers[].username`, `web_url`, `description`. Approval and changes-requested are NOT in this list payload — they are computed lazily and default to `false` here (Task 6 fills them in `getMrForIssue`). `linkedIssueNumbers` is parsed from the description's `Closes #N` (and friends).

**Files:**
- Modify: `packages/core/src/forge/gitlab.ts`
- Test: `packages/core/src/forge/gitlab.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to gitlab.test.ts
describe('GitLabForge.listOpenMrsByBot', () => {
  it('maps glab MR JSON to normalized MergeRequest and parses Closes #N', async () => {
    const raw = [
      {
        id: 5005, iid: 12, source_branch: 'maestro/issue-7', target_branch: 'main',
        draft: true, state: 'opened', reviewers: [{ username: 'alice' }],
        description: 'Plan\n\nCloses #7', web_url: 'https://gitlab.com/group/repo/-/merge_requests/12',
      },
    ];
    const run = vi.fn(async () => ({ stdout: JSON.stringify(raw), stderr: '', exitCode: 0 }));
    const f = new GitLabForge(repo, makeDeps({ runner: { run } }));
    const mrs = await f.listOpenMrsByBot();
    expect(run).toHaveBeenCalledWith(
      'glab',
      ['mr', 'list', '--author', 'maestro-bot', '--state', 'opened', '-R', 'group/repo', '-F', 'json'],
    );
    expect(mrs).toEqual([
      {
        id: '5005', number: 12, sourceBranch: 'maestro/issue-7', targetBranch: 'main',
        isDraft: true, state: 'open', approved: false, changesRequested: false,
        reviewers: ['alice'], linkedIssueNumbers: [7],
        description: 'Plan\n\nCloses #7',
        webUrl: 'https://gitlab.com/group/repo/-/merge_requests/12',
      },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core test -- src/forge/gitlab.test.ts -t listOpenMrsByBot`
Expected: FAIL with `Error: not implemented`.

- [ ] **Step 3: Write minimal implementation**

```ts
// add near the other raw types / mappers in gitlab.ts
interface RawGitLabMr {
  id: number;
  iid: number;
  source_branch: string;
  target_branch: string;
  draft?: boolean;
  state: string;                 // 'opened' | 'merged' | 'closed'
  reviewers?: { username: string }[];
  description?: string | null;
  web_url: string;
}

// Parse "Closes #7", "closes #7, #8", "Close #9" etc. from an MR description.
function parseLinkedIssues(description: string | null | undefined): number[] {
  if (!description) return [];
  const nums = new Set<number>();
  const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[^#\n]*?#(\d+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(description)) !== null) nums.add(Number(m[1]));
  return [...nums];
}

function mapMr(raw: RawGitLabMr, approved: boolean, changesRequested: boolean): MergeRequest {
  const state = raw.state === 'merged' ? 'merged' : raw.state === 'closed' ? 'closed' : 'open';
  return {
    id: String(raw.id),
    number: raw.iid,
    sourceBranch: raw.source_branch,
    targetBranch: raw.target_branch,
    isDraft: raw.draft ?? false,
    state,
    approved,
    changesRequested,
    reviewers: (raw.reviewers ?? []).map((r) => r.username),
    linkedIssueNumbers: parseLinkedIssues(raw.description),
    description: raw.description ?? '',
    webUrl: raw.web_url,
  };
}
```

```ts
// replace the listOpenMrsByBot stub
async listOpenMrsByBot(): Promise<MergeRequest[]> {
  const { stdout } = await this.deps.runner.run('glab', [
    'mr', 'list',
    '--author', this.botUser,
    '--state', 'opened',
    '-R', this.project,
    '-F', 'json',
  ]);
  const raw = JSON.parse(stdout) as RawGitLabMr[];
  return raw.map((r) => mapMr(r, false, false));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/core test -- src/forge/gitlab.test.ts -t listOpenMrsByBot`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/forge/gitlab.ts packages/core/src/forge/gitlab.test.ts
git commit -m "feat(forge): map glab MR JSON to MergeRequest and parse Closes #N"
```

---

## Task 5: REST helper — authenticated `api()` method

A private helper centralises base URL, auth header, project-id encoding, and error handling for every REST call (used by Tasks 6–9). On non-2xx it throws `ForgeError`.

**Files:**
- Modify: `packages/core/src/forge/gitlab.ts`
- Test: `packages/core/src/forge/gitlab.test.ts`

- [ ] **Step 1: Write the failing test**

We test the helper indirectly through a tiny exported behaviour: a public `projectId` getter (URL-encoded path) and that `api()` sends the token header and throws on error. Add a test-only narrow surface by making `api` `public` (it is harmless and useful) and exposing `projectId`.

```ts
// append to gitlab.test.ts
describe('GitLabForge.api', () => {
  it('builds the v4 URL, encodes the project path, sends PRIVATE-TOKEN, returns JSON', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const f = new GitLabForge(repo, makeDeps({
      fetchImpl: fetchMock as unknown as typeof fetch,
    }));
    const out = await f.api('GET', '/projects/:id/labels');
    expect(f.projectId).toBe('group%2Frepo');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gitlab.com/api/v4/projects/group%2Frepo/labels');
    expect((init as RequestInit).method).toBe('GET');
    expect((init as RequestInit & { headers: Record<string, string> }).headers['PRIVATE-TOKEN']).toBe('tok-123');
    expect(out).toEqual({ ok: true });
  });

  it('throws ForgeError when the token env var is unset', async () => {
    delete process.env.MAESTRO_GITLAB_TOKEN;
    const f = new GitLabForge(repo, makeDeps());
    await expect(f.api('GET', '/projects/:id/labels')).rejects.toThrow(/MAESTRO_GITLAB_TOKEN/);
  });

  it('throws ForgeError on non-2xx', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 403 }));
    const f = new GitLabForge(repo, makeDeps({
      fetchImpl: fetchMock as unknown as typeof fetch,
    }));
    await expect(f.api('GET', '/projects/:id/labels')).rejects.toThrow(/403/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core test -- src/forge/gitlab.test.ts -t "GitLabForge.api"`
Expected: FAIL — `f.api is not a function` / `projectId` undefined.

- [ ] **Step 3: Write minimal implementation**

```ts
// inside the GitLabForge class
get projectId(): string {
  return encodeURIComponent(this.project);
}

// The gitlab forge auth from config (host + tokenEnv). Throws if unconfigured.
private get auth(): { host: string; tokenEnv: string } {
  const a = this.deps.config.forges.gitlab;
  if (!a) throw new ForgeError('No gitlab forge configured (config.forges.gitlab)');
  return a;
}

private get host(): string {
  return this.auth.host;
}

private token(): string {
  const { tokenEnv } = this.auth;
  const tok = process.env[tokenEnv];
  if (!tok) throw new ForgeError(`GitLab token env var ${tokenEnv} is not set`);
  return tok;
}

// Generic REST call. `:id` in the path is replaced by the encoded project id.
// `body` (if given) is JSON-encoded. Returns parsed JSON (or null for 204).
async api<T = unknown>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `https://${this.host}/api/v4${path.replace(':id', this.projectId)}`;
  const headers: Record<string, string> = { 'PRIVATE-TOKEN': this.token() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await this.deps.fetchImpl(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ForgeError(`GitLab API ${method} ${path} failed: ${res.status} ${text}`);
  }
  if (res.status === 204) return null as T;
  return (await res.json()) as T;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/core test -- src/forge/gitlab.test.ts -t "GitLabForge.api"`
Expected: PASS (2 passing).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/forge/gitlab.ts packages/core/src/forge/gitlab.test.ts
git commit -m "feat(forge): add authenticated GitLab REST api() helper"
```

---

## Task 6: `getMrForIssue` (located by head branch) with approval + changes-requested detection

**Locate by head branch (contract):** the MR for issue `N` is the bot's open MR whose
`sourceBranch === maestro/issue-<N>` — NOT by parsing `Closes #N` from the description.
Branch names are the fixed convention (`maestro/issue-<number>`), so this is exact and
avoids description-format drift. Reuse `listOpenMrsByBot`, then enrich with REST:

- **Approved:** `GET /projects/:id/merge_requests/:iid/approval_state` → approved when any
  `rules[].approved === true` (Free-tier returns a single rule).
- **Changes requested (per `review.changesSignal`):** the adapter implements **both** paths
  (contract "Review signal"):
  - **`'label'` (default):** the `review.changesLabel` is present on the issue
    (`getIssue(N).labels`). Default label = `maestro::changes-requested` (scoped).
  - **`'native'`:** unapproval-after-approval + an unresolved reviewer thread. GitLab Free
    has no first-class "request changes", so the signal is: the MR is **not** currently
    approved (`approval_state` has no approved rule) AND there is an unresolved discussion
    note authored by someone other than the bot. `GET /projects/:id/merge_requests/:iid/discussions`.

**Files:**
- Modify: `packages/core/src/forge/gitlab.ts`
- Test: `packages/core/src/forge/gitlab.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to gitlab.test.ts
describe('GitLabForge.getMrForIssue', () => {
  function mrListStdout(over: Record<string, unknown> = {}) {
    return JSON.stringify([
      {
        id: 5005, iid: 12, source_branch: 'maestro/issue-7', target_branch: 'main',
        draft: false, state: 'opened', reviewers: [{ username: 'alice' }],
        description: 'Plan', web_url: 'https://gitlab.com/group/repo/-/merge_requests/12',
        ...over,
      },
    ]);
  }

  it('returns null when no open MR has the maestro/issue-<n> head branch', async () => {
    // MR exists but for a different branch — must NOT match issue 7.
    const run = vi.fn(async () => ({ stdout: mrListStdout({ source_branch: 'maestro/issue-9' }), stderr: '', exitCode: 0 }));
    const f = new GitLabForge(repo, makeDeps({ runner: { run } }));
    expect(await f.getMrForIssue(7)).toBeNull();
  });

  it('locates the MR by head branch maestro/issue-<n>', async () => {
    const run = vi.fn(async () => ({ stdout: mrListStdout(), stderr: '', exitCode: 0 }));
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('/approval_state')
        ? new Response(JSON.stringify({ rules: [{ approved: true }] }), { status: 200 })
        : new Response('[]', { status: 200 }));
    const f = new GitLabForge(repo, makeDeps({ runner: { run }, fetchImpl: fetchMock as unknown as typeof fetch }));
    const mr = await f.getMrForIssue(7);
    expect(mr?.number).toBe(12);
    expect(mr?.sourceBranch).toBe('maestro/issue-7');
    expect(mr?.approved).toBe(true);
  });

  // --- changesSignal: 'label' (default) ---
  it("label mode: changesRequested=true when the changesLabel is on the issue", async () => {
    const run = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        return { stdout: JSON.stringify({
          id: 1, iid: 7, title: 'T', description: '', state: 'opened',
          assignees: [], author: { username: 'a' },
          labels: ['maestro::changes-requested'],
          created_at: '2026-06-01T00:00:00Z', web_url: 'x',
        }), stderr: '', exitCode: 0 };
      }
      return { stdout: mrListStdout(), stderr: '', exitCode: 0 };
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ rules: [] }), { status: 200 }));
    const f = new GitLabForge(repo, makeDeps({
      runner: { run }, fetchImpl: fetchMock as unknown as typeof fetch,
      review: { changesSignal: 'label', changesLabel: 'maestro::changes-requested' },
    }));
    const mr = await f.getMrForIssue(7);
    expect(mr?.changesRequested).toBe(true);
  });

  it("label mode: changesRequested=false when the changesLabel is absent", async () => {
    const run = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        return { stdout: JSON.stringify({
          id: 1, iid: 7, title: 'T', description: '', state: 'opened',
          assignees: [], author: { username: 'a' }, labels: ['bug'],
          created_at: '2026-06-01T00:00:00Z', web_url: 'x',
        }), stderr: '', exitCode: 0 };
      }
      return { stdout: mrListStdout(), stderr: '', exitCode: 0 };
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ rules: [] }), { status: 200 }));
    const f = new GitLabForge(repo, makeDeps({
      runner: { run }, fetchImpl: fetchMock as unknown as typeof fetch,
      review: { changesSignal: 'label', changesLabel: 'maestro::changes-requested' },
    }));
    const mr = await f.getMrForIssue(7);
    expect(mr?.changesRequested).toBe(false);
  });

  // --- changesSignal: 'native' ---
  it('native mode: changesRequested=true when unapproved + an unresolved non-bot discussion exists', async () => {
    const run = vi.fn(async () => ({ stdout: mrListStdout(), stderr: '', exitCode: 0 }));
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/approval_state')) {
        return new Response(JSON.stringify({ rules: [{ approved: false }] }), { status: 200 });
      }
      if (url.includes('/discussions')) {
        return new Response(JSON.stringify([
          { notes: [{ resolvable: true, resolved: false, author: { username: 'alice' }, body: 'please fix' }] },
        ]), { status: 200 });
      }
      return new Response('[]', { status: 200 });
    });
    const f = new GitLabForge(repo, makeDeps({
      runner: { run }, fetchImpl: fetchMock as unknown as typeof fetch,
      review: { changesSignal: 'native' },
    }));
    const mr = await f.getMrForIssue(7);
    expect(mr?.approved).toBe(false);
    expect(mr?.changesRequested).toBe(true);
  });

  it('native mode: ignores resolved discussions and the bot’s own notes', async () => {
    const run = vi.fn(async () => ({ stdout: mrListStdout(), stderr: '', exitCode: 0 }));
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/approval_state')) {
        return new Response(JSON.stringify({ rules: [] }), { status: 200 });
      }
      if (url.includes('/discussions')) {
        return new Response(JSON.stringify([
          { notes: [{ resolvable: true, resolved: true, author: { username: 'alice' }, body: 'old' }] },
          { notes: [{ resolvable: true, resolved: false, author: { username: 'maestro-bot' }, body: 'progress' }] },
        ]), { status: 200 });
      }
      return new Response('[]', { status: 200 });
    });
    const f = new GitLabForge(repo, makeDeps({
      runner: { run }, fetchImpl: fetchMock as unknown as typeof fetch,
      review: { changesSignal: 'native' },
    }));
    const mr = await f.getMrForIssue(7);
    expect(mr?.changesRequested).toBe(false);
  });

  it('native mode: changesRequested=false when the MR is currently approved', async () => {
    const run = vi.fn(async () => ({ stdout: mrListStdout(), stderr: '', exitCode: 0 }));
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/approval_state')) {
        return new Response(JSON.stringify({ rules: [{ approved: true }] }), { status: 200 });
      }
      if (url.includes('/discussions')) {
        return new Response(JSON.stringify([
          { notes: [{ resolvable: true, resolved: false, author: { username: 'alice' }, body: 'fix' }] },
        ]), { status: 200 });
      }
      return new Response('[]', { status: 200 });
    });
    const f = new GitLabForge(repo, makeDeps({
      runner: { run }, fetchImpl: fetchMock as unknown as typeof fetch,
      review: { changesSignal: 'native' },
    }));
    const mr = await f.getMrForIssue(7);
    expect(mr?.changesRequested).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core test -- src/forge/gitlab.test.ts -t getMrForIssue`
Expected: FAIL with `Error: not implemented`.

- [ ] **Step 3: Write minimal implementation**

```ts
// add a branch-name helper near the top of gitlab.ts
function issueBranch(issueNumber: number): string {
  return `maestro/issue-${issueNumber}`;
}

// add raw types for approval + discussions near the other raw types
interface RawApprovalState { rules?: { approved?: boolean }[] }
interface RawDiscussion {
  notes?: { resolvable?: boolean; resolved?: boolean; author?: { username?: string }; body?: string }[];
}
```

```ts
// replace the getMrForIssue stub
async getMrForIssue(issueNumber: number): Promise<MergeRequest | null> {
  const branch = issueBranch(issueNumber);
  const mrs = await this.listOpenMrsByBot();
  const base = mrs.find((mr) => mr.sourceBranch === branch);
  if (!base) return null;

  const approved = await this.isApproved(base.number);
  const changesRequested = await this.hasChangesRequested(issueNumber, base.number, approved);
  return { ...base, approved, changesRequested };
}

private async isApproved(mrNumber: number): Promise<boolean> {
  const state = await this.api<RawApprovalState>(
    'GET',
    `/projects/:id/merge_requests/${mrNumber}/approval_state`,
  );
  return (state.rules ?? []).some((r) => r.approved === true);
}

// Derives changesRequested per workflow.review.changesSignal (contract "Review signal").
private async hasChangesRequested(
  issueNumber: number,
  mrNumber: number,
  approved: boolean,
): Promise<boolean> {
  if (this.deps.review.changesSignal === 'label') {
    const label = this.changesLabel();
    const issue = await this.getIssue(issueNumber);
    return issue?.labels.includes(label) ?? false;
  }
  // 'native': unapproval (no approved rule) + an unresolved non-bot reviewer thread.
  if (approved) return false;
  const discussions = await this.api<RawDiscussion[]>(
    'GET',
    `/projects/:id/merge_requests/${mrNumber}/discussions`,
  );
  return discussions.some((d) =>
    (d.notes ?? []).some(
      (n) =>
        n.resolvable === true &&
        n.resolved === false &&
        n.author?.username !== this.botUser,
    ),
  );
}

// The configured changes-requested label, defaulting to the scoped maestro label.
private changesLabel(): string {
  return this.deps.review.changesLabel ?? 'maestro::changes-requested';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/core test -- src/forge/gitlab.test.ts -t getMrForIssue`
Expected: PASS (7 passing).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/forge/gitlab.ts packages/core/src/forge/gitlab.test.ts
git commit -m "feat(forge): detect MR approval and changes-requested in getMrForIssue"
```

---

## Task 7: Branch + MR/issue write methods + `getMrDescription` + `blobUrl`

Covers the remaining `ForgeAdapter` members: `createBranch`, `createDraftMr`,
`createIssue`, `getMrDescription`, `setMrReady`, `updateMrDescription`,
`assignReviewer`, `mergeMr`, `comment`, and the pure `blobUrl` helper.

These are I/O passthroughs over `glab` / REST. `createBranch` uses REST (`POST /projects/:id/repository/branches`) since it must run without a local clone. `createDraftMr` / `createIssue` use `glab mr|issue create`. `getMrDescription` uses `glab mr view ... -F json` and returns `.description`. Ready/description/assign/merge use REST (deterministic, JSON in/out). `comment` uses `glab issue note` / `glab mr note`. `blobUrl` is pure (no I/O): `https://<host>/<project>/-/blob/<branch>/<path>`.

**Files:**
- Modify: `packages/core/src/forge/gitlab.ts`
- Test: `packages/core/src/forge/gitlab.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to gitlab.test.ts
describe('GitLabForge writes', () => {
  it('createBranch POSTs to repository/branches with encoded params', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ name: 'maestro/issue-7' }), { status: 201 }));
    const f = new GitLabForge(repo, makeDeps({ fetchImpl: fetchMock as unknown as typeof fetch }));
    await f.createBranch('maestro/issue-7', 'main');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gitlab.com/api/v4/projects/group%2Frepo/repository/branches');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ branch: 'maestro/issue-7', ref: 'main' });
  });

  it('createDraftMr calls glab mr create with --draft and returns the mapped MR', async () => {
    const created = {
      id: 9, iid: 3, source_branch: 'maestro/issue-7', target_branch: 'main',
      draft: true, state: 'opened', reviewers: [], description: 'Closes #7',
      web_url: 'https://gitlab.com/group/repo/-/merge_requests/3',
    };
    const run = vi.fn(async () => ({ stdout: JSON.stringify(created), stderr: '', exitCode: 0 }));
    const f = new GitLabForge(repo, makeDeps({ runner: { run } }));
    const mr = await f.createDraftMr({
      sourceBranch: 'maestro/issue-7', targetBranch: 'main',
      title: 'Fix login', body: 'Closes #7', draft: true,
    });
    expect(run).toHaveBeenCalledWith('glab', [
      'mr', 'create', '-R', 'group/repo',
      '--source-branch', 'maestro/issue-7',
      '--target-branch', 'main',
      '--title', 'Fix login',
      '--description', 'Closes #7',
      '--draft', '--yes', '-F', 'json',
    ]);
    expect(mr.number).toBe(3);
    expect(mr.isDraft).toBe(true);
    expect(mr.description).toBe('Closes #7');
  });

  it('createIssue calls glab issue create and returns the mapped Issue', async () => {
    const created = {
      id: 4, iid: 8, title: 'New', description: 'body', state: 'opened',
      assignees: [{ username: 'maestro-bot' }], author: { username: 'maestro-bot' },
      labels: [], created_at: '2026-06-03T00:00:00Z', web_url: 'https://gitlab.com/group/repo/-/issues/8',
    };
    const run = vi.fn(async () => ({ stdout: JSON.stringify(created), stderr: '', exitCode: 0 }));
    const f = new GitLabForge(repo, makeDeps({ runner: { run } }));
    const issue = await f.createIssue({ title: 'New', body: 'body', assignee: 'maestro-bot' });
    expect(run).toHaveBeenCalledWith('glab', [
      'issue', 'create', '-R', 'group/repo',
      '--title', 'New', '--description', 'body',
      '--assignee', 'maestro-bot', '--yes', '-F', 'json',
    ]);
    expect(issue.number).toBe(8);
  });

  it('getMrDescription reads back the MR description via glab', async () => {
    const run = vi.fn(async () => ({ stdout: JSON.stringify({
      id: 9, iid: 3, source_branch: 'maestro/issue-7', target_branch: 'main',
      draft: false, state: 'opened', reviewers: [], description: 'living plan',
      web_url: 'https://gitlab.com/group/repo/-/merge_requests/3',
    }), stderr: '', exitCode: 0 }));
    const f = new GitLabForge(repo, makeDeps({ runner: { run } }));
    const desc = await f.getMrDescription(3);
    expect(run).toHaveBeenCalledWith('glab', ['mr', 'view', '3', '-R', 'group/repo', '-F', 'json']);
    expect(desc).toBe('living plan');
  });

  it('setMrReady PUTs draft=false', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ iid: 3 }), { status: 200 }));
    const f = new GitLabForge(repo, makeDeps({ fetchImpl: fetchMock as unknown as typeof fetch }));
    await f.setMrReady(3);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gitlab.com/api/v4/projects/group%2Frepo/merge_requests/3');
    expect((init as RequestInit).method).toBe('PUT');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ draft: false });
  });

  it('updateMrDescription PUTs the new description', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ iid: 3 }), { status: 200 }));
    const f = new GitLabForge(repo, makeDeps({ fetchImpl: fetchMock as unknown as typeof fetch }));
    await f.updateMrDescription(3, 'new body');
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ description: 'new body' });
  });

  it('assignReviewer resolves the username to an id and PUTs reviewer_ids', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/users?username=')) {
        return new Response(JSON.stringify([{ id: 42, username: 'alice' }]), { status: 200 });
      }
      return new Response(JSON.stringify({ iid: 3 }), { status: 200 });
    });
    const f = new GitLabForge(repo, makeDeps({ fetchImpl: fetchMock as unknown as typeof fetch }));
    await f.assignReviewer(3, 'alice');
    const putCall = fetchMock.mock.calls.find((c) => (c[1] as RequestInit).method === 'PUT')!;
    expect(JSON.parse((putCall[1] as RequestInit).body as string)).toEqual({ reviewer_ids: [42] });
  });

  it('mergeMr PUTs merge with squash + remove_source_branch', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ state: 'merged' }), { status: 200 }));
    const f = new GitLabForge(repo, makeDeps({ fetchImpl: fetchMock as unknown as typeof fetch }));
    await f.mergeMr(3, 'squash', true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gitlab.com/api/v4/projects/group%2Frepo/merge_requests/3/merge');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ squash: true, should_remove_source_branch: true });
  });

  it('mergeMr rebase: PUTs /rebase first, then /merge', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      new Response(JSON.stringify({ ok: true }), { status: url.includes('/rebase') ? 202 : 200 }));
    const f = new GitLabForge(repo, makeDeps({ fetchImpl: fetchMock as unknown as typeof fetch }));
    await f.mergeMr(3, 'rebase', true);
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls[0]).toBe('https://gitlab.com/api/v4/projects/group%2Frepo/merge_requests/3/rebase');
    expect(urls[1]).toBe('https://gitlab.com/api/v4/projects/group%2Frepo/merge_requests/3/merge');
    const mergeBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(mergeBody).toEqual({ should_remove_source_branch: true });
  });

  it('comment on an issue calls glab issue note', async () => {
    const run = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const f = new GitLabForge(repo, makeDeps({ runner: { run } }));
    await f.comment({ type: 'issue', number: 7 }, 'hello');
    expect(run).toHaveBeenCalledWith('glab', ['issue', 'note', '7', '-R', 'group/repo', '-m', 'hello']);
  });

  it('comment on an MR calls glab mr note', async () => {
    const run = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const f = new GitLabForge(repo, makeDeps({ runner: { run } }));
    await f.comment({ type: 'mr', number: 3 }, 'proof attached');
    expect(run).toHaveBeenCalledWith('glab', ['mr', 'note', '3', '-R', 'group/repo', '-m', 'proof attached']);
  });

  it('blobUrl builds the GitLab -/blob/ url (pure, no I/O)', () => {
    const f = new GitLabForge(repo, makeDeps());
    expect(f.blobUrl('maestro/issue-7', 'proof/issue-7-login.png'))
      .toBe('https://gitlab.com/group/repo/-/blob/maestro/issue-7/proof/issue-7-login.png');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core test -- src/forge/gitlab.test.ts -t "GitLabForge writes"`
Expected: FAIL with `Error: not implemented`.

- [ ] **Step 3: Write minimal implementation**

```ts
// replace the corresponding stubs in GitLabForge

async createBranch(name: string, fromRef: string): Promise<void> {
  await this.api('POST', '/projects/:id/repository/branches', { branch: name, ref: fromRef });
}

async createDraftMr(args: CreateMrArgs): Promise<MergeRequest> {
  const flags = [
    'mr', 'create', '-R', this.project,
    '--source-branch', args.sourceBranch,
    '--target-branch', args.targetBranch,
    '--title', args.title,
    '--description', args.body,
  ];
  if (args.draft) flags.push('--draft');
  flags.push('--yes', '-F', 'json');
  const { stdout } = await this.deps.runner.run('glab', flags);
  return mapMr(JSON.parse(stdout) as RawGitLabMr, false, false);
}

async createIssue(args: { title: string; body: string; assignee?: string }): Promise<Issue> {
  const flags = ['issue', 'create', '-R', this.project, '--title', args.title, '--description', args.body];
  if (args.assignee) flags.push('--assignee', args.assignee);
  flags.push('--yes', '-F', 'json');
  const { stdout } = await this.deps.runner.run('glab', flags);
  return mapIssue(JSON.parse(stdout) as RawGitLabIssue);
}

async getMrDescription(mrNumber: number): Promise<string> {
  const { stdout } = await this.deps.runner.run('glab', [
    'mr', 'view', String(mrNumber), '-R', this.project, '-F', 'json',
  ]);
  return (JSON.parse(stdout) as RawGitLabMr).description ?? '';
}

async setMrReady(mrNumber: number): Promise<void> {
  await this.api('PUT', `/projects/:id/merge_requests/${mrNumber}`, { draft: false });
}

async updateMrDescription(mrNumber: number, body: string): Promise<void> {
  await this.api('PUT', `/projects/:id/merge_requests/${mrNumber}`, { description: body });
}

async assignReviewer(mrNumber: number, username: string): Promise<void> {
  const users = await this.api<{ id: number }[]>('GET', `/users?username=${encodeURIComponent(username)}`);
  const id = users[0]?.id;
  if (id === undefined) throw new ForgeError(`GitLab user not found: ${username}`);
  await this.api('PUT', `/projects/:id/merge_requests/${mrNumber}`, { reviewer_ids: [id] });
}

async mergeMr(mrNumber: number, strategy: MergeStrategy, deleteSource: boolean): Promise<void> {
  // 'rebase' (contract): rebase the MR onto target first, then merge. This relies on the
  // project having "Fast-forward merge" enabled; if it is not, the subsequent merge falls
  // back to a merge commit. The rebase is a no-op when already up to date.
  if (strategy === 'rebase') {
    await this.api('PUT', `/projects/:id/merge_requests/${mrNumber}/rebase`);
  }
  const body: Record<string, unknown> = { should_remove_source_branch: deleteSource };
  if (strategy === 'squash') body.squash = true;
  await this.api('PUT', `/projects/:id/merge_requests/${mrNumber}/merge`, body);
}

async comment(target: CommentTarget, body: string): Promise<void> {
  const kind = target.type === 'issue' ? 'issue' : 'mr';
  await this.deps.runner.run('glab', [kind, 'note', String(target.number), '-R', this.project, '-m', body]);
}

// Pure (no I/O). GitLab blob URL for a committed file on a branch.
blobUrl(branch: string, path: string): string {
  return `https://${this.host}/${this.project}/-/blob/${branch}/${path}`;
}
```

> **`'rebase'` semantics (contract "Module ownership notes"):** GitLab's `PUT .../merge`
> has no single "rebase-then-merge" flag, so the adapter calls `PUT .../rebase` first and
> then merges. Result depends on the project's "Fast-forward merge" setting: with it on the
> merge is a true fast-forward; with it off GitLab still produces a merge commit after the
> rebase. This is documented reliance, not a deferral.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/core test -- src/forge/gitlab.test.ts -t "GitLabForge writes"`
Expected: PASS (8 passing).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/forge/gitlab.ts packages/core/src/forge/gitlab.test.ts
git commit -m "feat(forge): implement branch/MR write methods and comments"
```

---

## Task 8: `setLifecycleLabel` — scoped-label exclusivity

Set exactly one `maestro::<state>` label (for `in_progress`/`in_review`/`blocked`) and remove every other maestro label. For `new` and `done` (no label), remove ALL maestro labels. GitLab's issue update supports `add_labels` / `remove_labels` (comma-joined) in one `PUT /projects/:id/issues/:iid`.

**Files:**
- Modify: `packages/core/src/forge/gitlab.ts`
- Test: `packages/core/src/forge/gitlab.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to gitlab.test.ts
describe('GitLabForge.setLifecycleLabel', () => {
  it('adds the target scoped label and removes the other maestro labels', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ iid: 7 }), { status: 200 }));
    const f = new GitLabForge(repo, makeDeps({ fetchImpl: fetchMock as unknown as typeof fetch }));
    await f.setLifecycleLabel(7, 'in_review');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gitlab.com/api/v4/projects/group%2Frepo/issues/7');
    expect((init as RequestInit).method).toBe('PUT');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.add_labels).toBe('maestro::in_review');
    expect(body.remove_labels.split(',').sort()).toEqual(['maestro::blocked', 'maestro::in_progress'].sort());
  });

  it('for new/done removes all maestro labels and adds none', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ iid: 7 }), { status: 200 }));
    const f = new GitLabForge(repo, makeDeps({ fetchImpl: fetchMock as unknown as typeof fetch }));
    await f.setLifecycleLabel(7, 'done');
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.add_labels).toBeUndefined();
    expect(body.remove_labels.split(',').sort())
      .toEqual(['maestro::blocked', 'maestro::in_progress', 'maestro::in_review'].sort());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core test -- src/forge/gitlab.test.ts -t setLifecycleLabel`
Expected: FAIL with `Error: not implemented`.

- [ ] **Step 3: Write minimal implementation**

```ts
// replace the setLifecycleLabel stub
async setLifecycleLabel(issueNumber: number, state: LifecycleState): Promise<void> {
  const all = allMaestroLabels(this.forge); // ['maestro::in_progress','maestro::in_review','maestro::blocked']
  const isLabeled = (LABELED_STATES as readonly string[]).includes(state);
  const target = isLabeled ? lifecycleLabel(this.forge, state as (typeof LABELED_STATES)[number]) : null;

  const body: Record<string, string> = {
    remove_labels: all.filter((l) => l !== target).join(','),
  };
  if (target) body.add_labels = target;

  await this.api('PUT', `/projects/:id/issues/${issueNumber}`, body);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/core test -- src/forge/gitlab.test.ts -t setLifecycleLabel`
Expected: PASS (2 passing).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/forge/gitlab.ts packages/core/src/forge/gitlab.test.ts
git commit -m "feat(forge): enforce scoped-label exclusivity in setLifecycleLabel"
```

---

## Task 9: `ensureLabels` — idempotent label creation (+ changes-requested label)

Create each maestro lifecycle label via `POST /projects/:id/labels` with `{ name, color }`.
**Contract:** when `review.changesSignal === 'label'`, `ensureLabels` ALSO creates the
configured `changesLabel` (default `maestro::changes-requested`). When the signal is
`'native'` the changes-requested label is not created. Idempotent: an existing label
returns 409; we swallow only that and rethrow other errors. Colors are fixed per state.

**Files:**
- Modify: `packages/core/src/forge/gitlab.ts`
- Test: `packages/core/src/forge/gitlab.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to gitlab.test.ts
describe('GitLabForge.ensureLabels', () => {
  it("POSTs a label for each lifecycle state AND the changes-requested label (label mode)", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 1 }), { status: 201 }));
    const f = new GitLabForge(repo, makeDeps({
      fetchImpl: fetchMock as unknown as typeof fetch,
      review: { changesSignal: 'label', changesLabel: 'maestro::changes-requested' },
    }));
    await f.ensureLabels();
    const names = fetchMock.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string).name).sort();
    expect(names).toEqual(['maestro::blocked', 'maestro::changes-requested', 'maestro::in_progress', 'maestro::in_review']);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe('https://gitlab.com/api/v4/projects/group%2Frepo/labels');
      expect((init as RequestInit).method).toBe('POST');
    }
  });

  it("omits the changes-requested label in native mode", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 1 }), { status: 201 }));
    const f = new GitLabForge(repo, makeDeps({
      fetchImpl: fetchMock as unknown as typeof fetch,
      review: { changesSignal: 'native' },
    }));
    await f.ensureLabels();
    const names = fetchMock.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string).name).sort();
    expect(names).toEqual(['maestro::blocked', 'maestro::in_progress', 'maestro::in_review']);
  });

  it('swallows 409 (label already exists)', async () => {
    const fetchMock = vi.fn(async () => new Response('Label already exists', { status: 409 }));
    const f = new GitLabForge(repo, makeDeps({ fetchImpl: fetchMock as unknown as typeof fetch }));
    await expect(f.ensureLabels()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core test -- src/forge/gitlab.test.ts -t ensureLabels`
Expected: FAIL with `Error: not implemented`.

- [ ] **Step 3: Write minimal implementation**

```ts
// add a fixed color map near the top of gitlab.ts
const LABEL_COLORS: Record<(typeof LABELED_STATES)[number], string> = {
  in_progress: '#1f78d1',
  in_review: '#fc9403',
  blocked: '#dd2b0e',
};
const CHANGES_LABEL_COLOR = '#ad4363';
```

```ts
// replace the ensureLabels stub
async ensureLabels(): Promise<void> {
  const targets: { name: string; color: string }[] = LABELED_STATES.map((state) => ({
    name: lifecycleLabel(this.forge, state),
    color: LABEL_COLORS[state],
  }));
  // Contract: create the changes-requested label too when the signal is label-based.
  if (this.deps.review.changesSignal === 'label') {
    targets.push({ name: this.changesLabel(), color: CHANGES_LABEL_COLOR });
  }
  for (const { name, color } of targets) {
    try {
      await this.api('POST', '/projects/:id/labels', { name, color });
    } catch (err) {
      if (err instanceof ForgeError && /\b409\b/.test(err.message)) continue;
      throw err;
    }
  }
}
```

> `changesLabel()` is the helper added in Task 6 (`review.changesLabel ?? 'maestro::changes-requested'`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/core test -- src/forge/gitlab.test.ts -t ensureLabels`
Expected: PASS (2 passing).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/forge/gitlab.ts packages/core/src/forge/gitlab.test.ts
git commit -m "feat(forge): create maestro labels idempotently in ensureLabels"
```

---

## Task 10: `ensureBoard` — Free-tier board + label lists

Spec §11 / §11 Free-tier path:
1. `GET /projects/:id/boards` → if empty, `POST /projects/:id/boards` to create the single board.
2. For each lifecycle label, resolve its `label_id` (from `GET /projects/:id/labels`) and `POST /projects/:id/boards/:board_id/lists` with `{ label_id }`, ordered to mirror the lifecycle (`in_progress`, `in_review`, `blocked`).
3. Skip lists whose label already has a list (idempotent) — detect via the board's existing `lists`.

`manageBoard` opt-out is handled by the *factory caller* (the daemon decides whether to call `ensureBoard`); `ensureBoard` itself always does the work. We still add a guard test that, given a board that already has all lists, no `POST .../lists` is made.

**Files:**
- Modify: `packages/core/src/forge/gitlab.ts`
- Test: `packages/core/src/forge/gitlab.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to gitlab.test.ts
describe('GitLabForge.ensureBoard', () => {
  function routedFetch(handlers: { boardsGet: unknown; labels: unknown; existingLists?: unknown }) {
    const posted: { url: string; body: unknown }[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (url.endsWith('/boards') && method === 'GET') {
        return new Response(JSON.stringify(handlers.boardsGet), { status: 200 });
      }
      if (url.endsWith('/boards') && method === 'POST') {
        return new Response(JSON.stringify({ id: 77, lists: handlers.existingLists ?? [] }), { status: 201 });
      }
      if (url.endsWith('/labels') && method === 'GET') {
        return new Response(JSON.stringify(handlers.labels), { status: 200 });
      }
      if (url.includes('/lists') && method === 'POST') {
        posted.push({ url, body: JSON.parse(init!.body as string) });
        return new Response(JSON.stringify({ id: 1 }), { status: 201 });
      }
      return new Response('{}', { status: 200 });
    });
    return { fetchMock, posted };
  }

  it('creates the board when none exists and adds one list per lifecycle label in order', async () => {
    const { fetchMock, posted } = routedFetch({
      boardsGet: [],
      labels: [
        { id: 10, name: 'maestro::in_progress' },
        { id: 11, name: 'maestro::in_review' },
        { id: 12, name: 'maestro::blocked' },
        { id: 99, name: 'bug' },
      ],
    });
    const f = new GitLabForge(repo, makeDeps({ fetchImpl: fetchMock as unknown as typeof fetch }));
    await f.ensureBoard();
    expect(posted.map((p) => (p.body as { label_id: number }).label_id)).toEqual([10, 11, 12]);
    for (const p of posted) {
      expect(p.url).toBe('https://gitlab.com/api/v4/projects/group%2Frepo/boards/77/lists');
    }
  });

  it('reuses an existing board and skips labels that already have a list', async () => {
    const { fetchMock, posted } = routedFetch({
      boardsGet: [{ id: 55, lists: [{ label: { id: 10 } }] }], // in_progress already listed
      labels: [
        { id: 10, name: 'maestro::in_progress' },
        { id: 11, name: 'maestro::in_review' },
        { id: 12, name: 'maestro::blocked' },
      ],
    });
    const f = new GitLabForge(repo, makeDeps({ fetchImpl: fetchMock as unknown as typeof fetch }));
    await f.ensureBoard();
    expect(posted.map((p) => (p.body as { label_id: number }).label_id)).toEqual([11, 12]);
    for (const p of posted) {
      expect(p.url).toBe('https://gitlab.com/api/v4/projects/group%2Frepo/boards/55/lists');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core test -- src/forge/gitlab.test.ts -t ensureBoard`
Expected: FAIL with `Error: not implemented`.

- [ ] **Step 3: Write minimal implementation**

```ts
// add raw types near the others
interface RawBoardList { label?: { id?: number } }
interface RawBoard { id: number; lists?: RawBoardList[] }
interface RawLabel { id: number; name: string }
```

```ts
// replace the ensureBoard stub
async ensureBoard(): Promise<void> {
  const boards = await this.api<RawBoard[]>('GET', '/projects/:id/boards');
  let board = boards[0];
  if (!board) {
    board = await this.api<RawBoard>('POST', '/projects/:id/boards', {});
  }

  const existingLabelIds = new Set(
    (board.lists ?? []).map((l) => l.label?.id).filter((id): id is number => id !== undefined),
  );

  const labels = await this.api<RawLabel[]>('GET', '/projects/:id/labels');
  const byName = new Map(labels.map((l) => [l.name, l.id] as const));

  for (const state of LABELED_STATES) {
    const labelId = byName.get(lifecycleLabel(this.forge, state));
    if (labelId === undefined || existingLabelIds.has(labelId)) continue;
    await this.api('POST', `/projects/:id/boards/${board.id}/lists`, { label_id: labelId });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/core test -- src/forge/gitlab.test.ts -t ensureBoard`
Expected: PASS (2 passing).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/forge/gitlab.ts packages/core/src/forge/gitlab.test.ts
git commit -m "feat(forge): ensure Free-tier board with one label list per lifecycle state"
```

---

## Task 11: `createForge` factory (contract signature)

The factory matches the contract exactly:

```ts
export interface ForgeDeps { config: MaestroConfig; runner?: CommandRunner; fetchImpl?: typeof fetch; }
export function createForge(
  forge: Forge,
  repo: { url: string; project: string; botUser: string },
  deps: ForgeDeps,
): ForgeAdapter;
```

It returns a `GitLabForge` for `'gitlab'` and throws `ForgeError` for `'github'` (M6
extends it). It defaults `runner` to the shared `execaRunner` (from `util/exec.ts`) and
`fetchImpl` to global `fetch`. Token + host are NOT passed in — the adapter resolves them
from `deps.config.forges.gitlab` (`tokenEnv` names the env var; `host` is the API host).
The per-repo `review` config the GitLab adapter needs is threaded through
`ForgeDeps.review` (see contract note below).

**Files:**
- Create: `packages/core/src/forge/factory.ts`
- Test: `packages/core/src/forge/factory.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/forge/factory.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createForge, type ForgeDeps, type ForgeRepo } from './factory.js';
import { GitLabForge } from './gitlab.js';
import { ForgeError } from './adapter.js';
import type { MaestroConfig } from '../config/schema.js';

const config = {
  defaults: {
    pollIntervalActive: '30s', pollIntervalIdle: '5m', pollJitter: '5s', botUser: 'maestro-bot',
    concurrency: { globalMax: 2 },
    workspaces: { root: './workspaces', diskCap: '20GB', cleanup: 'lru' },
    web: { port: 7330, host: '127.0.0.1' },
  },
  forges: { gitlab: { host: 'gitlab.com', tokenEnv: 'MAESTRO_GITLAB_TOKEN' } },
  repos: [],
} as unknown as MaestroConfig;

const repo: ForgeRepo = { url: 'https://gitlab.com/group/repo', project: 'group/repo', botUser: 'maestro-bot' };
const deps: ForgeDeps = {
  config,
  runner: { run: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })) },
  fetchImpl: vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch,
  review: { changesSignal: 'label' },
};

beforeEach(() => { process.env.MAESTRO_GITLAB_TOKEN = 'x'; });

describe('createForge', () => {
  it('returns a GitLabForge for gitlab', () => {
    const f = createForge('gitlab', repo, deps);
    expect(f).toBeInstanceOf(GitLabForge);
    expect(f.project).toBe('group/repo');
    expect(f.botUser).toBe('maestro-bot');
  });

  it('throws ForgeError for github (deferred to M6)', () => {
    expect(() => createForge('github', repo, deps)).toThrow(ForgeError);
  });
});
```

> **`ForgeDeps.review` (canonical):** the contract's `ForgeDeps` includes the required
> field `review: WorkflowConfig['review']`. The GitLab adapter uses it to derive
> `changesRequested` and to create the changes-requested label per the per-repo review
> signal, since the `ForgeAdapter` method signatures carry no workflow argument.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core test -- src/forge/factory.test.ts`
Expected: FAIL — `Failed to resolve import "./factory.js"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/forge/factory.ts
import type { Forge } from '../domain/types.js';
import type { MaestroConfig } from '../config/schema.js';
import type { WorkflowConfig } from '../workflow/schema.js';
import type { ForgeAdapter } from './adapter.js';
import { ForgeError } from './adapter.js';
import { GitLabForge } from './gitlab.js';
import { type CommandRunner, execaRunner } from '../util/exec.js';

export interface ForgeRepo {
  url: string;       // clone url
  project: string;   // gitlab path or github org/repo
  botUser: string;
}

export interface ForgeDeps {
  config: MaestroConfig;
  runner?: CommandRunner;            // defaults to execaRunner (util/exec.ts)
  fetchImpl?: typeof fetch;          // defaults to global fetch
  review: WorkflowConfig['review'];  // per-repo changes-signal config (see note above)
}

export function createForge(forge: Forge, repo: ForgeRepo, deps: ForgeDeps): ForgeAdapter {
  if (forge === 'gitlab') {
    return new GitLabForge(repo, {
      runner: deps.runner ?? execaRunner,
      fetchImpl: deps.fetchImpl ?? fetch,
      config: deps.config,
      review: deps.review,
    });
  }
  throw new ForgeError(`Forge not implemented: ${forge}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/core test -- src/forge/factory.test.ts`
Expected: PASS (2 passing).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/forge/factory.ts packages/core/src/forge/factory.test.ts
git commit -m "feat(forge): add createForge factory returning GitLabForge"
```

---

## Task 12: Export new symbols from `core/src/index.ts`

Make the factory and `GitLabForge` reachable by the CLI/daemon packages.

**Files:**
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/forge/exports.test.ts
import { describe, it, expect } from 'vitest';
import * as core from '../index.js';

describe('core public exports', () => {
  it('re-exports createForge and GitLabForge', () => {
    expect(typeof core.createForge).toBe('function');
    expect(typeof core.GitLabForge).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core test -- src/forge/exports.test.ts`
Expected: FAIL — `core.createForge` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/core/src/index.ts` (keep existing M1 exports above):

```ts
export { createForge } from './forge/factory.js';
export type { ForgeRepo, ForgeDeps } from './forge/factory.js';
export { GitLabForge } from './forge/gitlab.js';
export type { GitLabForgeDeps, GitLabForgeRepo, FetchLike } from './forge/gitlab.js';
```

> `CommandRunner` is exported by M1 from `util/exec.ts` (not re-exported here to avoid a
> duplicate symbol). The factory imports `execaRunner`/`CommandRunner` from there.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/core test -- src/forge/exports.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/index.ts packages/core/src/forge/exports.test.ts
git commit -m "chore(core): export createForge and GitLabForge from package root"
```

---

## Task 13: Wire the daemon loop to use `createForge`

Replace the M1 hard-wired `MemoryForge` demo path in `daemon/loop.ts` so the per-repo adapter is built via `createForge`, selecting GitLab by the repo's forge. Keep the change minimal: derive `forge`, `host`, `project`, and `botUser` from the loaded config + the repo entry, and call `createForge(forge, { url, project, botUser }, { config, review, ... })`. Host/token are resolved inside the adapter from `config.forges[forge]`; the loop only forwards the whole `config`, the repo identity, and the repo's `review` config (from its `WorkflowConfig`).

> **Assumption (see Open questions):** the exact current shape of `daemon/loop.ts` is set by M1 and not available in this repo yet. The steps below assume `loop.ts` exposes a function that, given a `MaestroConfig` and a `RepoEntry`, must obtain a `ForgeAdapter`. Adjust the seam name to match M1; the *behaviour* to test is "the loop asks the factory for an adapter, not `MemoryForge`."

**Files:**
- Modify: `packages/core/src/daemon/loop.ts`
- Test: `packages/core/src/daemon/loop.test.ts` (extend M1's test file; if absent, create it)

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/daemon/loop.test.ts (add this describe block)
import { describe, it, expect, vi } from 'vitest';
import { adapterForRepo } from './loop.js';
import { GitLabForge } from '../forge/gitlab.js';
import type { MaestroConfig } from '../config/schema.js';

const config = {
  defaults: {
    pollIntervalActive: '30s', pollIntervalIdle: '5m', pollJitter: '5s',
    botUser: 'maestro-bot',
    concurrency: { globalMax: 2 },
    workspaces: { root: './workspaces', diskCap: '20GB', cleanup: 'lru' },
    web: { port: 7330, host: '127.0.0.1' },
  },
  forges: { gitlab: { host: 'gitlab.com', tokenEnv: 'MAESTRO_GITLAB_TOKEN' } },
  repos: [{ url: 'gitlab.com/group/repo' }],
} as unknown as MaestroConfig;

describe('adapterForRepo', () => {
  it('builds a GitLabForge for a gitlab repo via the factory', () => {
    const adapter = adapterForRepo(config, config.repos[0], {
      review: { changesSignal: 'label' },
      runner: { run: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })) },
      fetchImpl: vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch,
    });
    expect(adapter).toBeInstanceOf(GitLabForge);
    expect(adapter.forge).toBe('gitlab');
    expect(adapter.project).toBe('group/repo');
    expect(adapter.botUser).toBe('maestro-bot');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core test -- src/daemon/loop.test.ts -t adapterForRepo`
Expected: FAIL — `adapterForRepo` is not exported / not defined.

- [ ] **Step 3: Write minimal implementation**

Add a small, pure-ish helper to `loop.ts` that parses the repo URL into `{ forge, host, project }`, looks up the matching `ForgeAuth`, and calls `createForge`. Then replace the M1 `MemoryForge` construction inside the tick with a call to `adapterForRepo`.

```ts
// packages/core/src/daemon/loop.ts — add near the top
import { createForge, type ForgeDeps } from '../forge/factory.js';
import type { ForgeAdapter } from '../forge/adapter.js';
import { ForgeError } from '../forge/adapter.js';
import type { Forge } from '../domain/types.js';
import type { MaestroConfig, RepoEntry } from '../config/schema.js';
import type { WorkflowConfig } from '../workflow/schema.js';

// "gitlab.com/group/repo" -> { forge:'gitlab', project:'group/repo' }
// "github.com/org/web"    -> { forge:'github', project:'org/web' }
export function parseRepoUrl(url: string): { forge: Forge; project: string } {
  const clean = url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const slash = clean.indexOf('/');
  if (slash === -1) throw new ForgeError(`Invalid repo url: ${url}`);
  const host = clean.slice(0, slash);
  const project = clean.slice(slash + 1);
  const forge: Forge = host.includes('github') ? 'github' : 'gitlab';
  return { forge, project };
}

// Build the per-repo adapter via the factory. `over` injects the repo's review config
// (from its WorkflowConfig) plus optional runner/fetch stubs for tests.
export function adapterForRepo(
  config: MaestroConfig,
  repo: RepoEntry,
  over: Partial<Pick<ForgeDeps, 'runner' | 'fetchImpl'>> & { review: WorkflowConfig['review'] },
): ForgeAdapter {
  const { forge, project } = parseRepoUrl(repo.url);
  if (!config.forges[forge]) throw new ForgeError(`No forge auth configured for ${forge}`);
  const botUser = config.defaults.botUser;
  return createForge(
    forge,
    { url: repo.url, project, botUser },
    { config, review: over.review, runner: over.runner, fetchImpl: over.fetchImpl },
  );
}
```

Then, in the existing tick body, **replace** the M1 line that constructed `MemoryForge`
(e.g. `const adapter = new MemoryForge(...)`) with a call that passes the repo's loaded
`WorkflowConfig.review` (M3 loads the per-repo `WorkflowConfig` during the tick):

```ts
const adapter = adapterForRepo(config, repo, { review: workflow.review });
```

Keep all other M1 reconcile/dispatch logic unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/core test -- src/daemon/loop.test.ts -t adapterForRepo`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/daemon/loop.ts packages/core/src/daemon/loop.test.ts
git commit -m "feat(daemon): obtain per-repo adapter via createForge instead of MemoryForge"
```

---

## Task 14: Full-suite green + typecheck

Confirm the whole core package compiles and every test (M1 + M2) passes.

**Files:** none (verification only).

- [ ] **Step 1: Run the full test suite**

Run: `pnpm --filter @maestro/core test`
Expected: PASS — all M1 tests plus the new `gitlab.test.ts` (≈30 cases), `factory.test.ts` (2), `exports.test.ts` (1), and the `adapterForRepo` case in `loop.test.ts`.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @maestro/core exec tsc --noEmit`
Expected: no errors. If unused-import lint errors appear from Task 1, they are resolved because every import is now consumed.

- [ ] **Step 3: Lint**

Run: `pnpm --filter @maestro/core lint`
Expected: no errors.

- [ ] **Step 4: Commit (only if lint/typecheck required source fixes)**

```bash
git add packages/core/src/forge/gitlab.ts
git commit -m "chore(forge): satisfy lint/typecheck for GitLab adapter"
```

---

## Self-Review (performed)

- **Spec coverage:** §7 lifecycle labels → Task 8; §7 approval/changes-requested → Task 6; §11 labels → Task 9; §11 board + lists (Free-tier, single board) → Task 10; §8 forge adapter normalization → Tasks 2/4/6; §6 `manage_board` opt-out → handled by the daemon caller (noted in Task 10); contracts `ForgeAdapter` every method (incl. `createIssue`, `getMrDescription`, `blobUrl`) → Tasks 2–10; `createForge` → Task 11; daemon rewire → Task 13; `glab` pin + fixtures → Task 0.
- **Contract conformance:** `createForge(forge, { url, project, botUser }, ForgeDeps)` with `ForgeDeps = { config; runner?; fetchImpl?; review }`; token resolved inside the adapter via `config.forges.gitlab.tokenEnv`; subprocess seam is the shared `CommandRunner` from `util/exec.ts` (no local declaration); `getMrForIssue` locates by head branch `maestro/issue-<n>`; `changesRequested` derives both `'label'` and `'native'` paths from `review.changesSignal`; `mergeMr('rebase')` calls `PUT .../rebase` then merge; `MergeRequest.description` mapped.
- **Placeholder scan:** none — every code step is complete; commands and expected outputs are exact.
- **Type consistency:** `Issue`/`MergeRequest`/`Action`/`LifecycleState`/`MergeStrategy` used verbatim from contracts; `lifecycleLabel`/`allMaestroLabels`/`LABELED_STATES` from `domain/lifecycle.ts`; `ForgeAdapter`/`CreateMrArgs`/`CommentTarget`/`ForgeError` from `forge/adapter.ts`; `CommandRunner`/`execaRunner` from `util/exec.ts`; `WorkflowConfig` from `workflow/schema.ts`; `MaestroConfig` from `config/schema.ts`. `GitLabForgeDeps`/`GitLabForgeRepo`/`FetchLike` are declared once in the production `gitlab.ts`; the plan shows the `GitLabForgeDeps` interface in two doc blocks (the canonical seam-section prose and the Task 1 Step-3 implementation copy) — both kept byte-identical, including the required `review: WorkflowConfig['review']` field.

---

## Open questions

1. **Exact `daemon/loop.ts` shape (M1).** The M1 source is not present in this repo (only the spec and contracts exist). Task 13 introduces `adapterForRepo`/`parseRepoUrl` and assumes M1's tick currently constructs a `MemoryForge` to be swapped, and that the per-repo `WorkflowConfig` (for `review`) is already loaded in the tick (M3). The precise function name, signature, and threading of `MaestroConfig`/`RepoEntry`/`WorkflowConfig` must be matched to M1/M3's actual code. The behavioural contract ("loop uses the factory, not `MemoryForge`") is stable; the wiring detail is not.

2. **`getMrForIssue` cost.** `getMrForIssue` calls `listOpenMrsByBot` (one `glab` call) then, depending on `changesSignal`, one or two REST calls (`approval_state`, plus `discussions` in native mode or `getIssue` in label mode). The spec budgets "~3 calls/repo/tick" (§14). For a repo with many in-flight MRs this multiplies. Confirm per-tick re-fetch is acceptable or whether a snapshot batch read should be added.
