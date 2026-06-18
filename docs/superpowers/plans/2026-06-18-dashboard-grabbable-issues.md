# Dashboard Grabbable-Issues + "Work on this" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the web dashboard show, per repo, a count of open issues the bot is NOT yet assigned to, list them in a modal, and hand one to the daemon with a one-click "Work on this" button.

**Architecture:** Two new forge primitives (`listGrabbableIssues`, `assignIssue`) on the `ForgeAdapter` seam; a read projection (`assembleOpenIssues` + `grabbableCount` on `RepoView`) and a write usecase (`workOnIssue`, beside `addRepo`) in `@maestro/core`; two new HTTP routes in the web server (one read, one bearer-gated write) plus a real `repoForId` lookup; and vanilla-JS additions to the single `page.ts` dashboard (badge, modal, button). The daemon is unchanged — it discovers the assignment on its next tick.

**Tech Stack:** TypeScript (ESM, NodeNext), pnpm workspace, Vitest, Biome, Node `http`, `gh`/`glab` CLIs behind a `ForgeCli` transport.

**Spec:** `docs/superpowers/specs/2026-06-18-dashboard-grabbable-issues-design.md`

**Conventions you MUST follow:**
- Run a single test file: `pnpm exec vitest run <path>`
- Build all packages: `pnpm -r build` · Typecheck: `pnpm -r typecheck` · Lint: `pnpm lint` (fix: `pnpm lint:fix`)
- Forge data in the frontend is rendered via `textContent` / the `span()`/`link()`/`avatar()` helpers — NEVER `innerHTML` (security §13.1).
- Commits: imperative mood, subject ≤72 chars, stage explicit paths only (never `git add .`/`-A`), NO `Co-Authored-By` trailer.
- After the LAST code step of each task run `pnpm lint:fix` before committing so Biome formatting doesn't fail CI.

---

## File Structure

**Modified:**
- `packages/core/src/contracts/forge-adapter.ts` — add `listGrabbableIssues` + `assignIssue` to `ForgeAdapter`; add `listGrabbableIssues` to `ReadOnlyForgeAdapter`.
- `packages/core/src/forge/gitlab/gitlab-adapter.ts` — implement both.
- `packages/core/src/forge/github/github-adapter.ts` — implement both.
- `packages/core/src/views/assemble.ts` — `OpenIssueItem` type, `assembleOpenIssues`, `grabbableCount` on `RepoView` + in `assembleDashboard`.
- `packages/core/src/public.ts` — export the new write usecase.
- `packages/web/src/server.ts` — `ServerDeps` fields + two routes.
- `packages/web/src/deps.ts` — wire the new read/write seams.
- `packages/web/src/main.ts` — real `repoForId`, build the `work` deps.
- `packages/web/src/page.ts` — badge, modal, button, token cache, CSS.
- Test fakes: `packages/core/test/helpers/daemon.ts`, `packages/core/test/views.test.ts`, `packages/web/test/server.test.ts`.

**Created:**
- `packages/core/src/onboarding/work-on-issue.ts` — the `workOnIssue` usecase.
- `packages/core/test/work-on-issue.test.ts` — its unit tests.

---

## Task 1: `listGrabbableIssues` forge primitive (interface + both adapters)

**Files:**
- Modify: `packages/core/src/contracts/forge-adapter.ts`
- Modify: `packages/core/src/forge/gitlab/gitlab-adapter.ts`
- Modify: `packages/core/src/forge/github/github-adapter.ts`
- Modify: `packages/core/test/helpers/daemon.ts` (keep the full-adapter fake compiling)
- Test: `packages/core/test/gitlab-adapter.test.ts`, `packages/core/test/github-adapter.test.ts`

- [ ] **Step 1: Add the interface method + narrow it into the read-only view type**

In `packages/core/src/contracts/forge-adapter.ts`, in the `// --- discovery ---` block (right after the `listOpenIssuesByLabel(...)` declaration, around line 47), add:

```typescript
  /** Open issues NOT assigned to bot_user — the dashboard's grabbable backlog. One bounded
   *  page (per_page 100, no pagination); bot-assigned issues (they ride the board already)
   *  and PRs are filtered out. The badge count is this list's length (capped at the page). */
  listGrabbableIssues(repo: RepoRef): Promise<Issue[]>;
```

Then extend the read-only narrowing at the bottom of the same file so the dashboard assembly can call it:

```typescript
/** Compile-time read-only narrowing for the web dashboard (AM-15). */
export type ReadOnlyForgeAdapter = Pick<
  ForgeAdapter,
  'kind' | 'listAssignedOpenIssues' | 'getSnapshot' | 'getIssueState' | 'listGrabbableIssues'
>;
```

- [ ] **Step 2: Keep the full-adapter test fake compiling**

In `packages/core/test/helpers/daemon.ts`, inside the `const a: ForgeAdapter = { ... }` literal (after the `listOpenIssuesByLabel` entry, near line 179), add a trivial implementation — the daemon/reconciler tests never call it, so it only needs to satisfy the type:

```typescript
    listGrabbableIssues: async () => {
      r.calls.push('listGrabbableIssues');
      return [];
    },
```

- [ ] **Step 3: Write the failing GitLab adapter test**

In `packages/core/test/gitlab-adapter.test.ts`, append a new `describe` block (the helpers `mk`, `rawIssue`, `user`, `repo` already exist at the top of the file):

```typescript
describe('listGrabbableIssues — open issues not assigned to the bot', () => {
  it('returns open issues and filters out bot-assigned ones', async () => {
    const { a, fake } = mk();
    fake.onApi('GET', '/issues', [
      rawIssue({ iid: 42, assignees: [user(1, 'maestro-bot')] }), // bot-assigned → dropped
      rawIssue({ iid: 43, assignees: [user(2, 'reporter')] }), // human → kept
      rawIssue({ iid: 44, assignees: [] }), // unassigned → kept
    ]);
    const out = await a.listGrabbableIssues(repo);
    expect(out.map((i) => i.iid)).toEqual([43, 44]);
    // bounded single page, no --paginate
    const call = fake.callsTo('GET', '/issues')[0];
    expect(call?.args.join(' ')).toContain('state=opened');
    expect(call?.args.join(' ')).toContain('per_page=100');
    expect(call?.args).not.toContain('--paginate');
  });
});
```

- [ ] **Step 4: Run it — expect failure**

Run: `pnpm exec vitest run packages/core/test/gitlab-adapter.test.ts`
Expected: FAIL — `a.listGrabbableIssues is not a function` (interface declared, GitLab impl missing).

- [ ] **Step 5: Implement GitLab `listGrabbableIssues`**

In `packages/core/src/forge/gitlab/gitlab-adapter.ts`, directly after `listOpenIssuesByLabel` (around line 139), add:

```typescript
  async listGrabbableIssues(repo: RepoRef): Promise<Issue[]> {
    const raw = await this.#c.apiRequired<RawIssue[]>(
      'GET',
      `/projects/${this.#pid(repo)}/issues`,
      {
        query: { state: 'opened', per_page: 100 },
      },
    );
    const bot = this.#c.botUser;
    // Drop issues already assigned to the bot — those ride the board, not the grabbable list.
    return raw.filter((i) => !(i.assignees ?? []).some((u) => u.username === bot)).map(normalizeIssue);
  }
```

- [ ] **Step 6: Run the GitLab test — expect pass**

Run: `pnpm exec vitest run packages/core/test/gitlab-adapter.test.ts`
Expected: PASS.

- [ ] **Step 7: Write the failing GitHub adapter test**

In `packages/core/test/github-adapter.test.ts`, append (helpers `mk`, `rawIssue`, `user`, `repo` exist at the top):

```typescript
describe('listGrabbableIssues — open issues not assigned to the bot', () => {
  it('returns open issues, dropping bot-assigned ones and PRs', async () => {
    const { a, fake } = mk();
    fake.onApi('GET', '/issues', [
      rawIssue({ number: 42, assignees: [user(1, 'maestro-bot')] }), // bot-assigned → dropped
      rawIssue({ number: 43, assignees: [user(2, 'reporter')] }), // human → kept
      rawIssue({ number: 44, assignees: [], pull_request: { url: 'x' } }), // PR → dropped
    ]);
    const out = await a.listGrabbableIssues(repo);
    expect(out.map((i) => i.iid)).toEqual([43]);
    const call = fake.callsTo('GET', '/issues')[0];
    expect(call?.args.join(' ')).toContain('state=open');
    expect(call?.args.join(' ')).toContain('per_page=100');
    expect(call?.args).not.toContain('--paginate');
  });
});
```

- [ ] **Step 8: Run it — expect failure**

Run: `pnpm exec vitest run packages/core/test/github-adapter.test.ts`
Expected: FAIL — `a.listGrabbableIssues is not a function`.

- [ ] **Step 9: Implement GitHub `listGrabbableIssues`**

In `packages/core/src/forge/github/github-adapter.ts`, directly after `listOpenIssuesByLabel` (around line 129), add:

```typescript
  async listGrabbableIssues(repo: RepoRef): Promise<Issue[]> {
    const raw = await this.#c.apiRequired<RawIssue[]>('GET', `${this.#base(repo)}/issues`, {
      query: { state: 'open', per_page: 100 },
    });
    const bot = this.#c.botUser;
    // GitHub's /issues list includes PRs (every PR is an issue) — drop them; and drop issues
    // already assigned to the bot (those ride the board, not the grabbable list).
    return raw
      .filter((i) => i.pull_request === undefined)
      .filter((i) => !(i.assignees ?? []).some((u) => u.login === bot))
      .map(normalizeIssue);
  }
```

- [ ] **Step 10: Run the GitHub test — expect pass**

Run: `pnpm exec vitest run packages/core/test/github-adapter.test.ts`
Expected: PASS.

- [ ] **Step 11: Typecheck (the new full-adapter fake + interface) and lint**

Run: `pnpm -r typecheck && pnpm lint:fix`
Expected: typecheck clean (the `helpers/daemon.ts` fake now satisfies the grown interface), lint applies any formatting.

- [ ] **Step 12: Commit**

```bash
git add packages/core/src/contracts/forge-adapter.ts \
  packages/core/src/forge/gitlab/gitlab-adapter.ts \
  packages/core/src/forge/github/github-adapter.ts \
  packages/core/test/helpers/daemon.ts \
  packages/core/test/gitlab-adapter.test.ts \
  packages/core/test/github-adapter.test.ts
git commit -m "Add listGrabbableIssues forge primitive"
```

---

## Task 2: `assignIssue` forge primitive (interface + both adapters)

**Files:**
- Modify: `packages/core/src/contracts/forge-adapter.ts`
- Modify: `packages/core/src/forge/gitlab/gitlab-adapter.ts`
- Modify: `packages/core/src/forge/github/github-adapter.ts`
- Modify: `packages/core/test/helpers/daemon.ts`
- Test: `packages/core/test/gitlab-adapter.test.ts`, `packages/core/test/github-adapter.test.ts`

- [ ] **Step 1: Add the interface method**

In `packages/core/src/contracts/forge-adapter.ts`, in the `// --- mutation (all idempotent) ---` block (right after `assignMR(...)`, around line 69), add:

```typescript
  /** Assign one user to an ISSUE (assignMR covers MRs only). Idempotent: a no-op when the
   *  user is already an assignee. Backs the dashboard "Work on this" hand-off to the bot. */
  assignIssue(repo: RepoRef, issueIid: number, username: string): Promise<void>;
```

- [ ] **Step 2: Keep the full-adapter fake compiling**

In `packages/core/test/helpers/daemon.ts`, inside the `const a: ForgeAdapter = { ... }` literal, next to the `listGrabbableIssues` entry you added in Task 1, add:

```typescript
    assignIssue: async () => {
      r.calls.push('assignIssue');
    },
```

- [ ] **Step 3: Write the failing GitLab test**

In `packages/core/test/gitlab-adapter.test.ts`, append:

```typescript
describe('assignIssue — hand an issue to a user', () => {
  it('resolves the username and PUTs assignee_ids when not already assigned', async () => {
    const { a, fake } = mk();
    fake.onApi('GET', '/users', [user(7, 'maestro-bot')]);
    fake.onApi('GET', '/issues/42', rawIssue({ iid: 42, assignees: [] }));
    fake.onApi('PUT', '/issues/42', rawIssue({ iid: 42 }));
    await a.assignIssue(repo, 42, 'maestro-bot');
    expect(bodyOf(fake, 'PUT', '/issues/42')).toEqual({ assignee_ids: [7] });
  });

  it('is a no-op when the user is already assigned', async () => {
    const { a, fake } = mk();
    fake.onApi('GET', '/users', [user(7, 'maestro-bot')]);
    fake.onApi('GET', '/issues/42', rawIssue({ iid: 42, assignees: [user(7, 'maestro-bot')] }));
    await a.assignIssue(repo, 42, 'maestro-bot');
    expect(fake.callsTo('PUT', '/issues/42')).toHaveLength(0);
  });
});
```

- [ ] **Step 4: Run it — expect failure**

Run: `pnpm exec vitest run packages/core/test/gitlab-adapter.test.ts`
Expected: FAIL — `a.assignIssue is not a function`.

- [ ] **Step 5: Implement GitLab `assignIssue`**

In `packages/core/src/forge/gitlab/gitlab-adapter.ts`, add after `assignMR` (around line 265). It mirrors `assignMR` but targets the issues endpoint:

```typescript
  async assignIssue(repo: RepoRef, issueIid: number, username: string): Promise<void> {
    const pid = this.#pid(repo);
    const id = Number(await this.#resolveUserId(username));
    const issue = await this.#c.apiRequired<RawIssue & { assignees?: RawUser[] }>(
      'GET',
      `/projects/${pid}/issues/${issueIid}`,
    );
    if ((issue.assignees ?? []).some((u) => String(u.id) === String(id))) return; // already assigned
    await this.#c.api('PUT', `/projects/${pid}/issues/${issueIid}`, {
      body: { assignee_ids: [id] },
    });
  }
```

If `RawUser` is not already imported in this file, add it to the existing `import type { ... } from './raw.js'` (or wherever `RawIssue` comes from) — the typecheck step will tell you if it's missing.

- [ ] **Step 6: Run the GitLab test — expect pass**

Run: `pnpm exec vitest run packages/core/test/gitlab-adapter.test.ts`
Expected: PASS.

- [ ] **Step 7: Write the failing GitHub test**

In `packages/core/test/github-adapter.test.ts`, append:

```typescript
describe('assignIssue — hand an issue to a user', () => {
  it('POSTs the assignee when not already assigned', async () => {
    const { a, fake } = mk();
    fake.onApi('GET', '/issues/42', rawIssue({ number: 42, assignees: [] }));
    fake.onApi('POST', '/issues/42/assignees', rawIssue({ number: 42 }));
    await a.assignIssue(repo, 42, 'maestro-bot');
    expect(bodyOf(fake, 'POST', '/issues/42/assignees')).toEqual({ assignees: ['maestro-bot'] });
  });

  it('is a no-op when the user is already assigned', async () => {
    const { a, fake } = mk();
    fake.onApi('GET', '/issues/42', rawIssue({ number: 42, assignees: [user(1, 'maestro-bot')] }));
    await a.assignIssue(repo, 42, 'maestro-bot');
    expect(fake.callsTo('POST', '/issues/42/assignees')).toHaveLength(0);
  });
});
```

- [ ] **Step 8: Run it — expect failure**

Run: `pnpm exec vitest run packages/core/test/github-adapter.test.ts`
Expected: FAIL — `a.assignIssue is not a function`.

- [ ] **Step 9: Implement GitHub `assignIssue`**

In `packages/core/src/forge/github/github-adapter.ts`, add after `assignMR` (around line 264). It reuses the existing private `#addAssignees` helper (the PR/issue assignees endpoint is shared):

```typescript
  async assignIssue(repo: RepoRef, issueIid: number, username: string): Promise<void> {
    const issue = await this.#c.apiRequired<RawIssue>('GET', `${this.#base(repo)}/issues/${issueIid}`);
    if ((issue.assignees ?? []).some((a) => a.login === username)) return; // already assigned
    await this.#addAssignees(repo, issueIid, [username]);
  }
```

- [ ] **Step 10: Run the GitHub test — expect pass**

Run: `pnpm exec vitest run packages/core/test/github-adapter.test.ts`
Expected: PASS.

- [ ] **Step 11: Typecheck + lint**

Run: `pnpm -r typecheck && pnpm lint:fix`
Expected: clean.

- [ ] **Step 12: Commit**

```bash
git add packages/core/src/contracts/forge-adapter.ts \
  packages/core/src/forge/gitlab/gitlab-adapter.ts \
  packages/core/src/forge/github/github-adapter.ts \
  packages/core/test/helpers/daemon.ts \
  packages/core/test/gitlab-adapter.test.ts \
  packages/core/test/github-adapter.test.ts
git commit -m "Add assignIssue forge primitive"
```

---

## Task 3: View assembly — `grabbableCount` + `assembleOpenIssues`

**Files:**
- Modify: `packages/core/src/views/assemble.ts`
- Test: `packages/core/test/views.test.ts`

- [ ] **Step 1: Update the read-only fake in the view test**

In `packages/core/test/views.test.ts`, the `roAdapter(...)` factory builds a `ReadOnlyForgeAdapter` literal. It will no longer satisfy the (grown) type until you add the new method. Add this entry inside the `const adapter: ReadOnlyForgeAdapter = { ... }` literal (alongside `getIssueState`):

```typescript
    listGrabbableIssues: async () => {
      calls.push('listGrabbableIssues');
      return opts.grabbable ?? [];
    },
```

And extend the `opts` parameter type of `roAdapter` to carry the fixture:

```typescript
function roAdapter(
  snaps: Map<number, IssueSnapshot>,
  opts: { throwList?: boolean; grabbable?: Issue[] } = {},
): RoRecorder {
```

Add `Issue` to the `import type { ... } from '../src/contracts/index.js'` at the top of the file.

- [ ] **Step 2: Fix the existing calls-set assertion (it will now include the new read)**

The E1 test asserts the exact set of adapter calls. `assembleDashboard` will now also call `listGrabbableIssues`, so update that assertion:

```typescript
    expect(new Set(rec.calls)).toEqual(
      new Set(['listAssignedOpenIssues', 'getSnapshot', 'listGrabbableIssues']),
    );
```

- [ ] **Step 3: Write the failing `grabbableCount` test**

In `packages/core/test/views.test.ts`, add to the `assembleDashboard` describe block:

```typescript
  it('reports grabbableCount from listGrabbableIssues length', async () => {
    const snaps = new Map([[42, makeSnapshot({ issue: { iid: 42 } })]]);
    const rec = roAdapter(snaps, {
      grabbable: [
        makeSnapshot({ issue: { iid: 50 } }).issue,
        makeSnapshot({ issue: { iid: 51 } }).issue,
      ],
    });
    const view = await assembleDashboard([repo], deps(new Map([[repo.url, rec.adapter]])));
    expect(view.repos[0]?.grabbableCount).toBe(2);
  });
```

- [ ] **Step 4: Write the failing `assembleOpenIssues` test**

Add a new describe block in the same file (import `assembleOpenIssues` from `../src/views/assemble.js`):

```typescript
describe('assembleOpenIssues — the grabbable backlog projection', () => {
  it('projects iid/title/author/labels/issueUrl from listGrabbableIssues', async () => {
    const rec = roAdapter(new Map(), {
      grabbable: [makeSnapshot({ issue: { iid: 77, title: 'Fix the thing' } }).issue],
    });
    const items = await assembleOpenIssues(repo, deps(new Map([[repo.url, rec.adapter]])));
    expect(items).toHaveLength(1);
    expect(items[0]?.iid).toBe(77);
    expect(items[0]?.title).toBe('Fix the thing');
    expect(items[0]?.author).toEqual({ username: 'reporter', id: 'id-reporter' });
    expect(typeof items[0]?.issueUrl).toBe('string');
  });
});
```

- [ ] **Step 5: Run the view tests — expect failure**

Run: `pnpm exec vitest run packages/core/test/views.test.ts`
Expected: FAIL — `grabbableCount` is undefined and `assembleOpenIssues` is not exported.

- [ ] **Step 6: Add the `grabbableCount` field to `RepoView`**

In `packages/core/src/views/assemble.ts`, extend the `RepoView` interface:

```typescript
export interface RepoView {
  repo: RepoRef;
  issues: IssueView[];
  counts: Record<LifecycleState, number>;
  /** Count of open issues NOT yet assigned to the bot — the grabbable backlog badge. Capped
   *  at the adapter's single-page fetch; absent on a repo whose forge call failed (`error`). */
  grabbableCount?: number;
  error?: string; // per-repo degradation marker (E3) — never a whole-dashboard 500
}
```

- [ ] **Step 7: Populate it in `assembleDashboard`**

In the same file, inside the `try` of `assembleDashboard` (replace the existing `out.push(...)` success line):

```typescript
      const grabbable = await deps.adapterFor(repo).listGrabbableIssues(repo);
      out.push({ repo, issues: views, counts, grabbableCount: grabbable.length });
```

(Leave the `catch` branch untouched — a forge failure still degrades the whole card to `error`, exactly as before.)

- [ ] **Step 8: Add the `OpenIssueItem` type + `assembleOpenIssues`**

In the same file, after `assembleIssue` (around line 216), add:

```typescript
/** One grabbable issue row for the dashboard modal (#open-issues). Forge content (title,
 *  labels, author) stays raw — the renderer keeps it inert (§13.1), never this projection. */
export interface OpenIssueItem {
  iid: number;
  title: string;
  author: ForgeUser;
  labels: string[];
  issueUrl: string;
}

/** Project a repo's grabbable backlog (open issues NOT assigned to the bot) for the modal.
 *  Read-only: the single forge call is `listGrabbableIssues`, on the narrowed adapter. */
export async function assembleOpenIssues(
  repo: RepoRef,
  deps: AssembleDeps,
): Promise<OpenIssueItem[]> {
  const issues = await deps.adapterFor(repo).listGrabbableIssues(repo);
  return issues.map((i) => ({
    iid: i.iid,
    title: i.title,
    author: i.author,
    labels: i.labels,
    issueUrl: i.webUrl,
  }));
}
```

(`ForgeUser` and `RepoRef` are already imported at the top of this file.)

- [ ] **Step 9: Run the view tests — expect pass**

Run: `pnpm exec vitest run packages/core/test/views.test.ts`
Expected: PASS (all, including the updated calls-set assertion).

- [ ] **Step 10: Typecheck + lint**

Run: `pnpm -r typecheck && pnpm lint:fix`
Expected: clean. `assemble.ts` is already re-exported via `public.ts` (`export * from './views/assemble.js'`), so `OpenIssueItem` is now on the `@maestro/core` surface automatically.

- [ ] **Step 11: Commit**

```bash
git add packages/core/src/views/assemble.ts packages/core/test/views.test.ts
git commit -m "Surface grabbable issue count and backlog in view assembly"
```

---

## Task 4: `workOnIssue` write usecase

**Files:**
- Create: `packages/core/src/onboarding/work-on-issue.ts`
- Modify: `packages/core/src/public.ts`
- Test: `packages/core/test/work-on-issue.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/work-on-issue.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import type { ForgeAdapter, RepoRef, RepoSettings } from '../src/contracts/index.js';
import { workOnIssue } from '../src/onboarding/work-on-issue.js';

const repo: RepoRef = {
  forge: 'gitlab',
  host: 'gitlab.com',
  project: 'group/api',
  url: 'gitlab.com/group/api',
};

function settings(trigger: RepoSettings['trigger']): RepoSettings {
  return { botUser: 'maestro-bot', trigger } as unknown as RepoSettings;
}

function fakeAdapter() {
  const calls: Array<[string, ...unknown[]]> = [];
  const adapter = {
    assignIssue: async (_r: RepoRef, iid: number, user: string) => {
      calls.push(['assignIssue', iid, user]);
    },
    setIssueLabels: async (_r: RepoRef, iid: number, set: string[], unset: string[]) => {
      calls.push(['setIssueLabels', iid, set, unset]);
    },
  } as unknown as ForgeAdapter;
  return { adapter, calls };
}

function deps(trigger: RepoSettings['trigger']) {
  const { adapter, calls } = fakeAdapter();
  return {
    calls,
    d: { adapterFor: () => adapter, settingsFor: () => settings(trigger) },
  };
}

describe('workOnIssue', () => {
  it('assigns the bot and does not label when no require_label is set', async () => {
    const { calls, d } = deps({ requireLabel: null, allowedActors: [] });
    const res = await workOnIssue(repo, 42, d);
    expect(res).toEqual({ ok: true });
    expect(calls).toContainEqual(['assignIssue', 42, 'maestro-bot']);
    expect(calls.some(([m]) => m === 'setIssueLabels')).toBe(false);
  });

  it('applies the trigger label when require_label is set', async () => {
    const { calls, d } = deps({ requireLabel: 'maestro::queued', allowedActors: [] });
    await workOnIssue(repo, 42, d);
    expect(calls).toContainEqual(['setIssueLabels', 42, ['maestro::queued'], []]);
  });

  it('warns when an allowlist excludes the bot (daemon will not auto-start)', async () => {
    const { d } = deps({ requireLabel: null, allowedActors: ['alice'] });
    const res = await workOnIssue(repo, 42, d);
    expect(res).toEqual({ ok: true, warning: 'actor-allowlist-blocks-autostart' });
  });

  it('does not warn when the allowlist includes the bot', async () => {
    const { d } = deps({ requireLabel: null, allowedActors: ['maestro-bot'] });
    const res = await workOnIssue(repo, 42, d);
    expect(res).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Run it — expect failure**

Run: `pnpm exec vitest run packages/core/test/work-on-issue.test.ts`
Expected: FAIL — cannot find module `work-on-issue.js`.

- [ ] **Step 3: Implement the usecase**

Create `packages/core/src/onboarding/work-on-issue.ts`:

```typescript
// The ONE "work on this issue" routine behind the web POST /repos/:id/issues/:iid/work.
// Hands an open issue to the bot — assign + (optional) trigger label — so the daemon picks it
// up on its next tick. A shared write usecase beside add-repo.ts; never a web-special path.

import type { ForgeAdapter, RepoRef, RepoSettings } from '../contracts/index.js';

/** Non-fatal hint the UI surfaces when the assignment will NOT auto-start the daemon: the
 *  repo restricts actors (allowed_actors) and the bot — who becomes lastActor on a dashboard
 *  write — is not on the list, so the trigger guard will ignore the assignment. */
export type WorkWarning = 'actor-allowlist-blocks-autostart';

export type WorkResult = { ok: true; warning?: WorkWarning };

export interface WorkOnIssueDeps {
  adapterFor: (repo: RepoRef) => ForgeAdapter;
  settingsFor: (repo: RepoRef) => RepoSettings;
}

export async function workOnIssue(
  repo: RepoRef,
  issueIid: number,
  deps: WorkOnIssueDeps,
): Promise<WorkResult> {
  const settings = deps.settingsFor(repo);
  const adapter = deps.adapterFor(repo);
  const botUser = settings.botUser;

  // 1. Assign the bot — the trigger guard's first, always-required condition.
  await adapter.assignIssue(repo, issueIid, botUser);

  // 2. Apply the trigger label only when the repo requires one (else the guard's label
  //    condition can never be satisfied). setIssueLabels is idempotent.
  if (settings.trigger.requireLabel !== null) {
    await adapter.setIssueLabels(repo, issueIid, [settings.trigger.requireLabel], []);
  }

  // 3. A dashboard write makes the bot the issue's lastActor. If the repo restricts actors and
  //    the bot isn't allowed, the daemon will ignore this — tell the UI rather than no-op.
  const { allowedActors } = settings.trigger;
  if (allowedActors.length > 0 && !allowedActors.includes(botUser)) {
    return { ok: true, warning: 'actor-allowlist-blocks-autostart' };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Export it from the public surface**

In `packages/core/src/public.ts`, next to the existing `export * from './onboarding/add-repo.js';`, add:

```typescript
export * from './onboarding/work-on-issue.js';
```

- [ ] **Step 5: Run it — expect pass**

Run: `pnpm exec vitest run packages/core/test/work-on-issue.test.ts`
Expected: PASS (all four).

- [ ] **Step 6: Typecheck + lint**

Run: `pnpm -r typecheck && pnpm lint:fix`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/onboarding/work-on-issue.ts packages/core/src/public.ts \
  packages/core/test/work-on-issue.test.ts
git commit -m "Add workOnIssue write usecase"
```

---

## Task 5: Web server routes (read open-issues + write work)

**Files:**
- Modify: `packages/web/src/server.ts`
- Test: `packages/web/test/server.test.ts`

- [ ] **Step 1: Extend `ServerDeps`**

In `packages/web/src/server.ts`, update the import and the `ServerDeps` interface:

```typescript
import type { AddResult, DashboardView, IssueView, OpenIssueItem, WorkResult } from '@maestro/core';
```

Add these two fields to `ServerDeps` (after `loadIssue`):

```typescript
  /** Read-only: wraps assembleOpenIssues for one repo — the grabbable backlog modal. */
  loadOpenIssues: (repoId: string) => Promise<OpenIssueItem[]>;
  /** A write path (bearer-gated): wraps core workOnIssue — assign the bot + optional label. */
  workOnIssue: (repoId: string, iid: number) => Promise<WorkResult>;
```

- [ ] **Step 2: Add the failing route tests**

In `packages/web/test/server.test.ts`, first extend the `fakeDeps` factory so it satisfies the grown `ServerDeps` (add the two fields; import the types):

```typescript
import type { AddResult, OpenIssueItem, WorkResult } from '@maestro/core';

const cannedOpenIssues: OpenIssueItem[] = [
  { iid: 7, title: 'Add OAuth', author: { username: 'reporter', id: '2' }, labels: [], issueUrl: 'https://x/7' },
];

function fakeDeps(over: Partial<ServerDeps> = {}): ServerDeps {
  return {
    loadDashboard: async () => cannedDashboard,
    loadIssue: async () => cannedIssue,
    loadOpenIssues: async () => cannedOpenIssues,
    workOnIssue: async () => ({ ok: true }) as WorkResult,
    addRepo: async () => ({ added: true, repo }) as AddResult,
    writeToken: TOKEN,
    ...over,
  };
}
```

Then add the new describe blocks (the `call(...)` helper already exists in this file):

```typescript
describe('GET /repos/:id/open-issues — the grabbable backlog', () => {
  it('returns the projected list as { issues }', async () => {
    const res = await call(
      fakeDeps(),
      'GET',
      '/repos/' + encodeURIComponent('gitlab.com/group/api') + '/open-issues',
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ issues: cannedOpenIssues });
  });

  it('decodes the repo id and passes it through', async () => {
    const loadOpenIssues = vi.fn(async () => cannedOpenIssues);
    await call(
      fakeDeps({ loadOpenIssues }),
      'GET',
      '/repos/' + encodeURIComponent('gitlab.com/group/api') + '/open-issues',
    );
    expect(loadOpenIssues).toHaveBeenCalledWith('gitlab.com/group/api');
  });
});

describe('POST /repos/:id/issues/:iid/work — hand an issue to the bot', () => {
  const workUrl = '/repos/' + encodeURIComponent('gitlab.com/group/api') + '/issues/42/work';

  it('200 + result when the correct bearer token is presented', async () => {
    const workOnIssue = vi.fn(async () => ({ ok: true }) as WorkResult);
    const res = await call(fakeDeps({ workOnIssue }), 'POST', workUrl, undefined, TOKEN);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(workOnIssue).toHaveBeenCalledWith('gitlab.com/group/api', 42);
  });

  it('passes the allowlist warning straight through', async () => {
    const workOnIssue = vi.fn(
      async () => ({ ok: true, warning: 'actor-allowlist-blocks-autostart' }) as WorkResult,
    );
    const res = await call(fakeDeps({ workOnIssue }), 'POST', workUrl, undefined, TOKEN);
    expect(JSON.parse(res.body)).toEqual({ ok: true, warning: 'actor-allowlist-blocks-autostart' });
  });

  it('401 when no Authorization header is sent', async () => {
    const workOnIssue = vi.fn(async () => ({ ok: true }) as WorkResult);
    const res = await call(fakeDeps({ workOnIssue }), 'POST', workUrl);
    expect(res.status).toBe(401);
    expect(workOnIssue).not.toHaveBeenCalled();
  });

  it('403 when the bearer token does not match', async () => {
    const workOnIssue = vi.fn(async () => ({ ok: true }) as WorkResult);
    const res = await call(fakeDeps({ workOnIssue }), 'POST', workUrl, undefined, 'wrong-token');
    expect(res.status).toBe(403);
    expect(workOnIssue).not.toHaveBeenCalled();
  });

  it('404 when writes are disabled (no token configured)', async () => {
    const workOnIssue = vi.fn(async () => ({ ok: true }) as WorkResult);
    const res = await call(
      fakeDeps({ workOnIssue, writeToken: undefined }),
      'POST',
      workUrl,
      undefined,
      TOKEN,
    );
    expect(res.status).toBe(404);
    expect(workOnIssue).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run it — expect failure**

Run: `pnpm exec vitest run packages/web/test/server.test.ts`
Expected: FAIL — routes return 404 (not implemented).

- [ ] **Step 4: Add the write route (work)**

In `packages/web/src/server.ts`, inside `handle(...)`, directly after the `POST /repos` block (around line 55, before the `// --- read paths` comment), add — it mirrors the `POST /repos` gating exactly:

```typescript
  // --- write path: hand an issue to the bot (assign + optional trigger label) ---
  const work = path.match(/^\/repos\/([^/]+)\/issues\/([^/]+)\/work$/);
  if (method === 'POST' && work?.[1] && work[2]) {
    if (!writesEnabled) return sendJson(res, 404, { error: 'not found' });
    const authz = checkAuth(req, deps.writeToken);
    if (authz) return sendJson(res, authz.status, { error: authz.error });
    const repoId = decodeURIComponent(work[1]);
    const iid = Number(work[2]);
    if (!Number.isInteger(iid) || iid <= 0) return sendJson(res, 400, { error: 'invalid issue id' });
    return sendJson(res, 200, await deps.workOnIssue(repoId, iid));
  }
```

- [ ] **Step 5: Add the read route (open-issues)**

In the same function, in the read section (after the per-issue drill-down `if` block, around line 77, before the final `sendJson(res, 404, ...)`), add:

```typescript
  const open = path.match(/^\/repos\/([^/]+)\/open-issues$/);
  if (method === 'GET' && open?.[1]) {
    const repoId = decodeURIComponent(open[1]);
    return sendJson(res, 200, { issues: await deps.loadOpenIssues(repoId) });
  }
```

- [ ] **Step 6: Run it — expect pass**

Run: `pnpm exec vitest run packages/web/test/server.test.ts`
Expected: PASS (all new + existing).

- [ ] **Step 7: Typecheck + lint**

Run: `pnpm -r typecheck && pnpm lint:fix`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add packages/web/src/server.ts packages/web/test/server.test.ts
git commit -m "Add web routes for open issues and work-on-issue"
```

---

## Task 6: Web composition — wire deps + real `repoForId`

**Files:**
- Modify: `packages/web/src/deps.ts`
- Modify: `packages/web/src/main.ts`

- [ ] **Step 1: Extend `BuildServerDepsArgs` and `buildServerDeps`**

In `packages/web/src/deps.ts`, add the new core imports (alongside the existing `assembleDashboard`/`assembleIssue`/`addRepo` imports):

```typescript
import { assembleOpenIssues, workOnIssue, type WorkOnIssueDeps } from '@maestro/core';
```

Add a `work` field to `BuildServerDepsArgs`:

```typescript
  /** Write seam for POST /repos/:id/issues/:iid/work — assign the bot + optional trigger label. */
  work: WorkOnIssueDeps;
```

And wire both seams in the returned `buildServerDeps` object (after the `loadIssue` line):

```typescript
    loadOpenIssues: (repoId) => assembleOpenIssues(args.repoForId(repoId), args.assemble),
    workOnIssue: (repoId, iid) => workOnIssue(args.repoForId(repoId), iid, args.work),
```

- [ ] **Step 2: Replace the `repoForId` stub + build the `work` deps in main.ts**

In `packages/web/src/main.ts`, add `WorkOnIssueDeps` to the `@maestro/core` import list. Then, in `buildDeps`, replace the single-repo `repoForId` stub:

```typescript
  // Resolve a repo id (the URL-encoded :id path segment = repo.url) back to its RepoRef.
  // The frontend sends r.repo.url; an unknown id is a 500 (the outer handler guards it).
  const repoForId = (repoId: string): RepoRef => {
    const repo = repos.find((r) => r.url === repoId);
    if (!repo) throw new Error(`unknown repo: ${repoId}`);
    return repo;
  };
```

Add the `work` deps (it uses the FULL adapter via `makeForgeAdapter`, plus the `settingsFor` already destructured from `composeForges`):

```typescript
  const work: WorkOnIssueDeps = {
    adapterFor: (repo: RepoRef) => makeForgeAdapter(repo, config, exec),
    settingsFor,
  };
```

And pass `work` into the `buildServerDeps({ ... })` call:

```typescript
  return buildServerDeps({
    repos,
    assemble,
    add,
    work,
    repoForId,
    ...(env.writeToken ? { writeToken: env.writeToken } : {}),
  });
```

- [ ] **Step 3: Build everything (no unit test for composition; the build is the gate)**

Run: `pnpm -r build && pnpm -r typecheck`
Expected: clean — `buildServerDeps` now receives a `work` arg of the right shape, and `repoForId` resolves against the watched repos.

- [ ] **Step 4: Lint + run the whole web package test**

Run: `pnpm lint:fix && pnpm exec vitest run packages/web/test/server.test.ts`
Expected: clean + PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/deps.ts packages/web/src/main.ts
git commit -m "Wire work-on-issue deps and real repoForId in web composition"
```

---

## Task 7: Frontend — badge, modal, "Work on this" button

> No frontend unit-test harness exists in this repo (`page.ts` is a static HTML string). This task is verified by build + a manual run (Task 8 Step 4). All forge content goes through `span()` / `link()` / `avatar()` (which use `textContent`) — NEVER `innerHTML`.

**Files:**
- Modify: `packages/web/src/page.ts`

- [ ] **Step 1: Add the modal markup to the template**

In `packages/web/src/page.ts`, next to the existing `<dialog id="addDialog">` block, add a second dialog:

```html
  <dialog id="issuesDialog">
    <div class="issues">
      <div class="issues-head">
        <h3 id="issuesTitle"></h3>
        <button type="button" class="cancel" id="issuesClose">close</button>
      </div>
      <div id="issuesList" class="issues-list"></div>
    </div>
  </dialog>
```

- [ ] **Step 2: Add CSS for the badge, modal, rows, and button**

In the `<style>` block, after the existing `dialog#addDialog` rules, add (reusing the theme custom properties):

```css
  .open-badge {
    margin-left: 8px; padding: 1px 8px; border-radius: 999px; cursor: pointer;
    font-size: 12px; background: var(--surface-2); color: var(--accent);
    border: 1px solid var(--border-soft);
  }
  .open-badge:hover { border-color: var(--accent); }
  dialog#issuesDialog {
    padding: 0; border: 1px solid var(--border); border-radius: 8px;
    background: var(--bg); color: var(--fg); width: min(640px, calc(100vw - 32px));
  }
  dialog#issuesDialog::backdrop { background: rgba(0, 0, 0, .5); }
  .issues { display: flex; flex-direction: column; gap: 10px; padding: 20px; }
  .issues-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .issues-head h3 { margin: 0; font-size: 14px; overflow-wrap: anywhere; }
  .issues-list { display: flex; flex-direction: column; gap: 6px; max-height: 60vh; overflow: auto; }
  .issue-row {
    display: flex; align-items: center; gap: 10px; padding: 8px 10px;
    border: 1px solid var(--border-soft); border-radius: 6px; background: var(--surface);
  }
  .issue-main { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
  .issue-link { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .label-chip {
    padding: 0 6px; border-radius: 999px; font-size: 11px;
    background: var(--surface-2); color: var(--muted-2); border: 1px solid var(--border-soft);
  }
  .work-btn {
    padding: 6px 12px; border-radius: 6px; border: 1px solid var(--border);
    background: var(--btn-bg); color: var(--btn-fg); font: inherit; cursor: pointer; white-space: nowrap;
  }
  .work-btn:disabled { opacity: .6; cursor: default; }
```

- [ ] **Step 3: Add a module-level token cache + `writesEnabled` flag**

Near the top of the embedded script (after `const el = (id) => document.getElementById(id);`), add:

```javascript
    let writesEnabled = false; // mirrors the dashboard view each poll
    let dashToken = ''; // cached bearer token for write actions (add-repo / work)
    function getToken() {
      if (dashToken) return dashToken;
      const t = window.prompt('dashboard token');
      if (t === null) return null; // user cancelled
      dashToken = t.trim();
      return dashToken;
    }
```

- [ ] **Step 4: Set the flag (and reuse the add-repo token) in the poll loop**

In `refresh()`, where it already sets `el('addBtn').hidden = !view.writesEnabled;`, add right after it:

```javascript
    writesEnabled = !!view.writesEnabled;
```

In the add-repo submit handler, where it reads the token from the form (the `const token = ...` line before the `fetch('/repos'...)` call), cache it so a subsequent "Work on this" doesn't re-prompt:

```javascript
    if (token) dashToken = token;
```

- [ ] **Step 5: Render the badge on each repo card**

In `createRepoCard()`, add an open-badge span to the `h2` and wire its click (stop propagation so it doesn't toggle the card collapse):

```javascript
  const openBadge = span('open-badge', '');
  openBadge.hidden = true;
  h2.append(chev, span('project', ''), span('counts', ''), openBadge);
  openBadge.addEventListener('click', (e) => {
    e.stopPropagation();
    if (card.dataset.repoUrl) openIssuesModal(card.dataset.repoUrl, card.dataset.repoForge);
  });
```

(Replace the existing `h2.append(chev, span('project', ''), span('counts', ''));` line with the version above.)

In `updateRepoCard(card, r)`, near the top (after the `.project` textContent line), stash the repo identity and update the badge:

```javascript
  card.dataset.repoUrl = r.repo.url;
  card.dataset.repoForge = r.repo.forge;
  const ob = card.querySelector('.open-badge');
  const n = r.grabbableCount;
  if (!r.error && typeof n === 'number' && n > 0) {
    ob.hidden = false;
    ob.textContent = (n >= 100 ? '100+' : n) + ' open';
  } else {
    ob.hidden = true;
  }
```

- [ ] **Step 6: Add the modal open + render functions**

Add these functions in the script (next to `loadDetail`, the existing lazy-fetch analog):

```javascript
    function openIssuesModal(repoUrl, forge) {
      const dlg = el('issuesDialog');
      const list = el('issuesList');
      el('issuesTitle').textContent = repoUrl;
      list.replaceChildren(span('loading', 'loading…'));
      dlg.showModal();
      loadOpenIssues(list, repoUrl, forge);
    }

    async function loadOpenIssues(list, repoUrl, forge) {
      try {
        const url = '/repos/' + encodeURIComponent(repoUrl) + '/open-issues';
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error('open issues returned ' + res.status);
        const data = await res.json();
        const issues = data.issues || [];
        if (issues.length === 0) {
          list.replaceChildren(span('none', 'no open issues to grab'));
          return;
        }
        list.replaceChildren(...issues.map((i) => issueRow(i, repoUrl, forge)));
      } catch (err) {
        list.replaceChildren(span('none', 'could not load open issues: ' + err.message));
      }
    }

    function issueRow(issue, repoUrl, forge) {
      const row = document.createElement('div');
      row.className = 'issue-row';
      const main = document.createElement('div');
      main.className = 'issue-main';
      main.append(link('issue-link', '#' + issue.iid + ' ' + issue.title, issue.issueUrl));
      if (issue.author) main.append(avatar('author', issue.author));
      for (const l of issue.labels || []) main.append(span('label-chip', l));
      row.append(main);
      if (writesEnabled) {
        const btn = document.createElement('button');
        btn.className = 'work-btn';
        btn.textContent = 'Work on this';
        btn.addEventListener('click', () => requestWork(btn, repoUrl, issue.iid));
        row.append(btn);
      }
      return row;
    }

    async function requestWork(btn, repoUrl, iid) {
      const token = getToken();
      if (token === null) return; // cancelled
      btn.disabled = true;
      btn.textContent = 'Queued…';
      try {
        const url = '/repos/' + encodeURIComponent(repoUrl) + '/issues/' + iid + '/work';
        const res = await fetch(url, {
          method: 'POST',
          headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        });
        if (!res.ok) throw new Error('work returned ' + res.status);
        const data = await res.json();
        if (data.warning === 'actor-allowlist-blocks-autostart') {
          btn.textContent = 'Assigned (blocked)';
          btn.title =
            "Assigned, but this repo's actor allowlist will block auto-start — add the bot to allowed_actors.";
        } else {
          btn.textContent = 'Queued ✓';
        }
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Work on this';
        btn.title = 'could not assign: ' + err.message;
      }
    }
```

- [ ] **Step 7: Wire the modal close button**

Where the existing `addCancel` close handler is registered, add the analogous one for the issues dialog:

```javascript
    el('issuesClose').addEventListener('click', () => el('issuesDialog').close());
```

- [ ] **Step 8: Build + lint**

Run: `pnpm -r build && pnpm lint:fix`
Expected: clean (the page is a string constant — the build just bundles it).

- [ ] **Step 9: Commit**

```bash
git add packages/web/src/page.ts
git commit -m "Add grabbable-issues badge, modal and Work-on-this button to dashboard"
```

---

## Task 8: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Whole-suite test**

Run: `pnpm test`
Expected: PASS — all packages, including the new adapter/view/usecase/server tests.

- [ ] **Step 2: Typecheck all packages**

Run: `pnpm -r typecheck`
Expected: clean.

- [ ] **Step 3: Lint**

Run: `pnpm lint`
Expected: no errors.

- [ ] **Step 4: Manual smoke test (the frontend, end to end)**

Start the dashboard against a real config with writes enabled, against a repo that has at least one open issue NOT assigned to the bot:

```bash
MAESTRO_DASHBOARD_TOKEN=dev-token \
MAESTRO_CONFIG=./maestro.config.yaml \
node packages/web/dist/main.js
```

Then in a browser at `http://127.0.0.1:4000`:
1. Confirm the repo card header shows an "N open" badge.
2. Click the badge → the modal lists the grabbable issues (each with author + labels + a link).
3. Click "Work on this" on one row, enter `dev-token` when prompted → the button flips to "Queued ✓".
4. Verify on the forge that the bot is now an assignee of that issue (and, if the repo sets `require_label`, that the label was applied).
5. Within one daemon tick, that issue appears on the board; reopening the modal no longer lists it.

If `allowed_actors` is set on the repo and excludes the bot, confirm the button shows "Assigned (blocked)" with the explanatory tooltip instead.

- [ ] **Step 5: Confirm the branch is clean and review the diff**

Run: `git status && git log --oneline main..HEAD`
Expected: 7 focused commits (Tasks 1-7), clean working tree.

---

## Self-Review (completed by plan author)

**Spec coverage:** §1 forge layer → Tasks 1-2. §2 read path (`grabbableCount`, `assembleOpenIssues`, `GET /open-issues`, real `repoForId`) → Tasks 3, 5, 6. §3 write path (`POST .../work`, assign + label + warning, auth gating) → Tasks 4, 5. §4 frontend (badge, modal, button, optimistic + warning UI) → Task 7. §5 testing → tests embedded in every task + Task 8. ✅ All sections mapped.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every test step shows full assertions. ✅

**Type consistency:** `listGrabbableIssues`, `assignIssue`, `OpenIssueItem`, `WorkResult`, `WorkWarning`, `WorkOnIssueDeps`, `grabbableCount`, `loadOpenIssues`, `workOnIssue`, `repoForId` are spelled identically across interface, impl, deps, server, and tests. The `actor-allowlist-blocks-autostart` warning string is identical in core, server test, and frontend. ✅
