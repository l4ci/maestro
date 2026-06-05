# Comment-Based Review Triggers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/approve` comment from the assigned reviewer merges an in-review MR, and any other non-bot comment triggers rework — a parallel channel to formal forge reviews.

**Architecture:** All decisions live in the snapshot layer (`packages/core/src/forge/snapshot.ts`) above the `ForgePrimitives` seam, folded into `ApprovalState` so the reconciler's in-review branching is untouched. Adapters gain one primitive (`mrComments`); the snapshot gains an `mrComments` field; rework feedback merges both comment streams.

**Tech Stack:** TypeScript (strict), vitest, pnpm workspace. Tests live in `packages/core/test/`; run from the repo root with `pnpm test -- <file-filter>` (root script is `vitest run`).

**Spec:** `docs/superpowers/specs/2026-06-05-comment-review-triggers-design.md` — read it first.

**Conventions:** Comments explain *why*, matching the codebase's dense comment style. Commit messages: imperative, ≤72-char subject, body explains why. NO `Co-Authored-By` trailers. Stage explicit paths only (no `git add .`).

---

### Task 0: Branch setup

The spec commit (`bb69818`) sits on local `main`, unpushed. Move it onto the feature branch and restore `main` to origin.

- [ ] **Step 1: Create branch, reset main**

```bash
git checkout -b feat/comment-review-triggers
git branch -f main origin/main
```

- [ ] **Step 2: Verify**

Run: `git log --oneline -2` → shows `bb69818 Add design spec…` on top; `git log --oneline origin/main..main` (after `git checkout main && git checkout feat/comment-review-triggers` is NOT needed — just run `git log main..HEAD --oneline`) → shows only the spec commit.

---

### Task 1: `computeCommentSignal` — the pure signal function

**Files:**
- Modify: `packages/core/src/forge/snapshot.ts` (add below `computeChangesRequested`, ~line 55)
- Test: `packages/core/test/snapshot.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `snapshot.test.ts` (imports: add `computeCommentSignal`, `isApproveCommand` to the existing `../src/forge/snapshot.js` import). A comment helper exists inline in the assembleSnapshot describe — hoist a shared one to module scope:

```ts
const comment = (id: string, at: string, by: string, body: string): Comment => ({
  id,
  author: user(by),
  body,
  createdAt: at,
});
```

(Then simplify the existing `c(...)` helper inside the "sorts comments newest-first" test to use it: `comment(id, at, 'x', id)`.)

```ts
describe('isApproveCommand', () => {
  it.each([
    ['/approve', true],
    ['/APPROVE', true],
    ['  /approve  ', true],
    ['/approve, nice work', true],
    ['\n\n/approve\nthanks', true], // first non-empty line decides
    ['I will not /approve this', false],
    ['/approved', false], // not the bare command
    ['looks good', false],
    ['', false],
  ])('%j → %s', (body, expected) => {
    expect(isApproveCommand(body)).toBe(expected);
  });
});

describe('computeCommentSignal — the comment review channel', () => {
  const REVIEWERS = ['reporter'];
  const BOT = 'maestro-bot';
  const PUSH = '2026-01-02';

  it('no comments → none', () => {
    expect(computeCommentSignal([], REVIEWERS, BOT, PUSH)).toBe('none');
  });

  it('authorized /approve postdating the push → approve', () => {
    const cs = [comment('1', '2026-01-03', 'reporter', '/approve')];
    expect(computeCommentSignal(cs, REVIEWERS, BOT, PUSH)).toBe('approve');
  });

  it('any other non-bot comment postdating the push → changes', () => {
    const cs = [comment('1', '2026-01-03', 'someone', 'found a bug in the retry path')];
    expect(computeCommentSignal(cs, REVIEWERS, BOT, PUSH)).toBe('changes');
  });

  it('stale comments (predating the push) are invisible', () => {
    const cs = [comment('1', '2026-01-01', 'reporter', '/approve')];
    expect(computeCommentSignal(cs, REVIEWERS, BOT, PUSH)).toBe('none');
  });

  it('bot comments are invisible', () => {
    const cs = [comment('1', '2026-01-03', BOT, 'proof attached')];
    expect(computeCommentSignal(cs, REVIEWERS, BOT, PUSH)).toBe('none');
  });

  it('newest signal wins: bug report then later /approve → approve', () => {
    const cs = [
      comment('1', '2026-01-03', 'reporter', 'bug: crashes on empty input'),
      comment('2', '2026-01-04', 'reporter', '/approve'),
    ];
    expect(computeCommentSignal(cs, REVIEWERS, BOT, PUSH)).toBe('approve');
  });

  it('newest signal wins: /approve then later bug report → changes', () => {
    const cs = [
      comment('1', '2026-01-03', 'reporter', '/approve'),
      comment('2', '2026-01-04', 'reporter', 'wait, found a bug'),
    ];
    expect(computeCommentSignal(cs, REVIEWERS, BOT, PUSH)).toBe('changes');
  });

  it('drive-by /approve from a non-reviewer is dropped entirely — cannot merge', () => {
    const cs = [comment('1', '2026-01-03', 'stranger', '/approve')];
    expect(computeCommentSignal(cs, REVIEWERS, BOT, PUSH)).toBe('none');
  });

  it('a dropped drive-by /approve does not shadow an earlier real signal', () => {
    const cs = [
      comment('1', '2026-01-03', 'reporter', '/approve'),
      comment('2', '2026-01-04', 'stranger', '/approve'), // dropped, not "changes"
    ];
    expect(computeCommentSignal(cs, REVIEWERS, BOT, PUSH)).toBe('approve');
  });

  it('no bot push yet → every non-bot comment counts (mirror of computeChangesRequested)', () => {
    const cs = [comment('1', '2026-01-01', 'reporter', '/approve')];
    expect(computeCommentSignal(cs, REVIEWERS, BOT, undefined)).toBe('approve');
  });

  it('input order is irrelevant — newest by createdAt decides', () => {
    const cs = [
      comment('2', '2026-01-04', 'reporter', '/approve'),
      comment('1', '2026-01-03', 'reporter', 'bug report'),
    ];
    expect(computeCommentSignal(cs, REVIEWERS, BOT, PUSH)).toBe('approve');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- snapshot.test`
Expected: FAIL — `computeCommentSignal is not a function` (or import error).

- [ ] **Step 3: Implement**

In `snapshot.ts`, directly below `computeChangesRequested`:

```ts
/** The comment channel's verdict for one tick: merge, rework, or nothing new. */
export type CommentSignal = 'approve' | 'changes' | 'none';

const APPROVE_RE = /^\/approve(\s|$)/i;

/** Does a comment invoke the `/approve` command? First non-empty line, trimmed, must
 *  BE the command (optionally followed by prose) — "I won't /approve" is not it. */
export function isApproveCommand(body: string): boolean {
  const line = body.split('\n').find((l) => l.trim() !== '');
  return line !== undefined && APPROVE_RE.test(line.trim());
}

/**
 * Comment-channel review signal (spec 2026-06-05): non-bot comments postdating the last
 * bot push form the channel; the NEWEST one decides. `/approve` from an authorized
 * reviewer → 'approve'; any other comment → 'changes' (prose bug reports count).
 * Unauthorized `/approve`s are dropped entirely — a drive-by can neither merge nor
 * poison the channel into rework. No bot push yet → every non-bot comment counts
 * (mirror of computeChangesRequested).
 */
export function computeCommentSignal(
  comments: Comment[],
  reviewers: string[],
  botUser: string,
  lastBotPushAt: string | undefined,
): CommentSignal {
  const channel = comments.filter(
    (c) =>
      c.author.username !== botUser &&
      (lastBotPushAt === undefined || c.createdAt > lastBotPushAt) &&
      (!isApproveCommand(c.body) || reviewers.includes(c.author.username)),
  );
  const newest = channel.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!newest) return 'none';
  return isApproveCommand(newest.body) ? 'approve' : 'changes';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- snapshot.test`
Expected: PASS (all new + all pre-existing).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/forge/snapshot.ts packages/core/test/snapshot.test.ts
git commit -m "Add comment-channel review signal computation

A /approve comment from an authorized reviewer should merge and any
other non-bot comment should trigger rework, edge-triggered against
the last bot push like computeChangesRequested. Pure function only;
wiring into the snapshot algorithm follows."
```

---

### Task 2: `mrComments` primitive — interface + both adapters

No behavior change yet: the primitive exists but nothing calls it. Existing tests must stay green.

**Files:**
- Modify: `packages/core/src/forge/snapshot.ts` (ForgePrimitives, ~line 34)
- Modify: `packages/core/src/forge/github/github-adapter.ts` (`#primitives`, ~line 310)
- Modify: `packages/core/src/forge/gitlab/gitlab-adapter.ts` (`#primitives`, ~line 337)
- Modify: `packages/core/test/snapshot.test.ts` (`fakePrimitives`, ~line 68)

- [ ] **Step 1: Add to `ForgePrimitives`** (after the `openMergeRequests` member):

```ts
  /** The chosen MR's comments, normalized and system-notes filtered, in any order
   *  (caller sorts). The comment review channel reads these (spec 2026-06-05). */
  mrComments(mrIid: number): Promise<Comment[]>;
```

- [ ] **Step 2: GitHub implementation** — in `#primitives`, after the `openMergeRequests` entry:

```ts
      mrComments: async (mrIid) => {
        // PR conversation comments live on the issues endpoint (PR number ≡ issue
        // number). Inline review-thread comments are NOT read — those feed the formal
        // channel via blockingThreadAt.
        const comments =
          (await this.#c.api<RawComment[]>('GET', `${base}/issues/${mrIid}/comments`, {
            query: { per_page: this.#c.commentCap },
            paginate: true,
          })) ?? [];
        return comments.map(normalizeComment);
      },
```

- [ ] **Step 3: GitLab implementation** — in `#primitives`, after the `openMergeRequests` entry:

```ts
      mrComments: async (mrIid) => {
        const notes =
          (await this.#c.api<RawNote[]>('GET', `/projects/${pid}/merge_requests/${mrIid}/notes`, {
            query: { sort: 'desc', order_by: 'created_at', per_page: this.#c.commentCap },
          })) ?? [];
        return notes.filter((n) => !n.system).map(normalizeComment);
      },
```

- [ ] **Step 4: Update `fakePrimitives`** in `snapshot.test.ts` — add `mrComments: async () => [],` after the `openMergeRequests` stub.

- [ ] **Step 5: Build + full test run**

Run: `pnpm -r build && pnpm test`
Expected: PASS everywhere — the primitive is dead code so far.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/forge/snapshot.ts \
        packages/core/src/forge/github/github-adapter.ts \
        packages/core/src/forge/gitlab/gitlab-adapter.ts \
        packages/core/test/snapshot.test.ts
git commit -m "Add mrComments primitive to the ForgePrimitives seam

The comment review channel needs MR conversation comments; reviewers
reply on the PR they were pinged on, not the issue. Primitive only —
the snapshot algorithm starts reading it next."
```

---

### Task 3: Fold the signal in `findMaestroMr`

`findMaestroMr` gains a required context (botUser + issue comments + cap) and returns `{ mr, mrComments }` so `assembleSnapshot` doesn't re-fetch. Only callers: `assembleSnapshot` and `snapshot.test.ts` (verified by grep).

**Files:**
- Modify: `packages/core/src/forge/snapshot.ts` (`findMaestroMr` + `assembleSnapshot`)
- Test: `packages/core/test/snapshot.test.ts`

- [ ] **Step 1: Write the failing tests**

In the `findMaestroMr` describe, first a shared default context at the top of the describe:

```ts
  const CTX = { botUser: 'maestro-bot', issueComments: [] as Comment[], commentCap: 50 };
```

Update the five existing tests mechanically: add `CTX` as the third argument, and the result is now `{ mr, mrComments }` — `found?.iid` → `found?.mr.iid`, `found?.approvals` → `found?.mr.approvals` (the short-circuit test's `not.toHaveBeenCalled()` assertion survives: empty comment streams → commit read still skipped). Then add:

```ts
  it('authorized /approve comment on the MR folds approved=true', async () => {
    const found = await findMaestroMr(
      42,
      fakePrimitives({
        openMergeRequests: async () => [mr({ assignees: [user('reporter')] })],
        mrComments: async () => [comment('1', '2026-01-03', 'reporter', '/approve')],
        lastBotPushAt: async () => '2026-01-02',
      }),
      CTX,
    );
    expect(found?.mr.approvals.approved).toBe(true);
    expect(found?.mr.approvals.changesRequested).toBe(false);
  });

  it('non-bot feedback comment folds changesRequested=true', async () => {
    const found = await findMaestroMr(
      42,
      fakePrimitives({
        openMergeRequests: async () => [mr()],
        mrComments: async () => [comment('1', '2026-01-03', 'anyone', 'bug: crashes')],
        lastBotPushAt: async () => '2026-01-02',
      }),
      CTX,
    );
    expect(found?.mr.approvals.changesRequested).toBe(true);
    expect(found?.mr.approvals.approved).toBe(false);
  });

  it('issue comments feed the same channel (listen on both surfaces)', async () => {
    const found = await findMaestroMr(
      42,
      fakePrimitives({
        openMergeRequests: async () => [mr({ assignees: [user('reporter')] })],
        lastBotPushAt: async () => '2026-01-02',
      }),
      { ...CTX, issueComments: [comment('1', '2026-01-03', 'reporter', '/approve')] },
    );
    expect(found?.mr.approvals.approved).toBe(true);
  });

  it('the bot is never an authorized reviewer, even when assigned', async () => {
    const found = await findMaestroMr(
      42,
      fakePrimitives({
        openMergeRequests: async () => [mr({ assignees: [user('maestro-bot')] })],
        mrComments: async () => [comment('1', '2026-01-03', 'maestro-bot', '/approve')],
        lastBotPushAt: async () => '2026-01-02',
      }),
      CTX,
    );
    expect(found?.mr.approvals.approved).toBe(false);
  });

  it('a human comment forces the commit read (the edge-trigger needs the push time)', async () => {
    const lastBotPushAt = vi.fn(async () => '2026-01-02');
    await findMaestroMr(
      42,
      fakePrimitives({
        openMergeRequests: async () => [mr()],
        mrComments: async () => [comment('1', '2026-01-03', 'anyone', 'hello')],
        lastBotPushAt,
      }),
      CTX,
    );
    expect(lastBotPushAt).toHaveBeenCalled();
  });

  it('returns the MR comments newest-first, capped', async () => {
    const found = await findMaestroMr(
      42,
      fakePrimitives({
        openMergeRequests: async () => [mr()],
        mrComments: async () => [
          comment('a', '2026-01-01', 'x', 'a'),
          comment('c', '2026-01-03', 'x', 'c'),
          comment('b', '2026-01-02', 'x', 'b'),
        ],
        lastBotPushAt: async () => '2026-01-04', // all stale → no signal, just data
      }),
      { ...CTX, commentCap: 2 },
    );
    expect(found?.mrComments.map((x) => x.id)).toEqual(['c', 'b']);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- snapshot.test`
Expected: FAIL — `findMaestroMr` doesn't accept the context / result shape mismatch. (`assembleSnapshot` also breaks compile — fix together in Step 3.)

- [ ] **Step 3: Implement** — replace `findMaestroMr` and the call in `assembleSnapshot`:

```ts
/** Caller-supplied context for the comment review channel (spec 2026-06-05). */
export interface MaestroMrContext {
  botUser: string;
  /** Issue comments — the channel listens on both surfaces. Any order. */
  issueComments: Comment[];
  /** Bound applied to the fetched MR comments (newest-first), mirroring recentComments. */
  commentCap: number;
}

export interface MaestroMrResult {
  mr: MergeRequest;
  /** The chosen MR's comments, newest-first, capped — surfaced on IssueSnapshot. */
  mrComments: Comment[];
}

/**
 * Pick this issue's maestro MR from the candidate pool and fill its ApprovalState.
 * Match on the maestro branch prefix or a `Closes #iid` link; prefer an open MR, else
 * any match. Approvals fold BOTH channels: the forge's formal review state and the
 * comment channel (spec 2026-06-05) — `/approve` ORs into approved, feedback ORs into
 * changesRequested. The commit read serves both edge-triggers; it is skipped only when
 * neither needs it (no blocking thread AND no human comment), preserving the per-forge
 * optimization.
 */
export async function findMaestroMr(
  issueIid: number,
  prim: ForgePrimitives,
  ctx: MaestroMrContext,
): Promise<MaestroMrResult | undefined> {
  const pool = await prim.openMergeRequests(issueIid);
  const prefix = `maestro/issue-${issueIid}-`;
  const matches = (m: MergeRequest): boolean =>
    m.sourceBranch.startsWith(prefix) || m.closesIssueIid === issueIid;
  const candidate = pool.find((m) => m.state === 'opened' && matches(m)) ?? pool.find(matches);
  if (!candidate) return undefined;

  const base = await prim.approvalBase(candidate.iid);
  const blockingAt = await prim.blockingThreadAt(candidate.iid);
  const mrComments = (await prim.mrComments(candidate.iid))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, ctx.commentCap);

  const channel = [...ctx.issueComments, ...mrComments];
  const hasHumanComment = channel.some((c) => c.author.username !== ctx.botUser);
  const lastPush =
    blockingAt !== undefined || hasHumanComment ? await prim.lastBotPushAt(candidate) : undefined;

  const formalChanges = computeChangesRequested(blockingAt, lastPush);
  // Authorized approvers: the MR's human assignees (handoff assigns the ticket creator).
  const reviewers = candidate.assignees.map((a) => a.username).filter((u) => u !== ctx.botUser);
  const signal = computeCommentSignal(channel, reviewers, ctx.botUser, lastPush);

  const approvals: ApprovalState = {
    ...base,
    approved: base.approved || signal === 'approve',
    changesRequested: formalChanges || signal === 'changes',
  };
  return { mr: { ...candidate, approvals }, mrComments };
}
```

`ApprovalState` needs importing in `snapshot.ts` (it's in the existing `../contracts/index.js` type import list — add it).

In `assembleSnapshot`, reorder so issue comments exist before the MR lookup, and destructure the new result (full replacement comes in Task 4; for now the minimal compile fix):

```ts
  const recentComments = (await prim.comments(issueIid))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, commentCap);

  const found = await findMaestroMr(issueIid, prim, {
    botUser: '', // TEMP — Task 4 threads the real botUser through
    issueComments: recentComments,
    commentCap,
  });

  return { repo, issue: issueWithActor, recentComments, ...(found ? { mr: found.mr } : {}) };
```

- [ ] **Step 4: Run tests**

Run: `pnpm test -- snapshot.test`
Expected: PASS.

- [ ] **Step 5: Full suite** — `pnpm -r build && pnpm test`. Adapter getSnapshot tests may now fail on unstubbed routes (the new `mrComments` + commit fetches). If so, do NOT fix here — that's Task 4's job; only confirm the failures are exactly those routes (the `FakeExec: no matcher for …` message names them). If anything ELSE fails, stop and fix before committing. If adapter tests do fail on the new routes, commit anyway is NOT allowed — fold Task 4's Step 1 stub fixes in first, then commit both together with this task's message plus a body line noting the stub updates. Otherwise:

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/forge/snapshot.ts packages/core/test/snapshot.test.ts
git commit -m "Fold the comment review channel into ApprovalState

findMaestroMr now reads issue + MR comments and ORs the comment
signal into approved/changesRequested, so the reconciler's in-review
branching consumes both channels without changing. Returns the MR
comments so assembleSnapshot can surface them without re-fetching."
```

---

### Task 4: Thread `botUser` + surface `mrComments` on the snapshot

**Files:**
- Modify: `packages/core/src/contracts/forge-model.ts` (`IssueSnapshot`, ~line 71)
- Modify: `packages/core/src/forge/snapshot.ts` (`assembleSnapshot` signature)
- Modify: `packages/core/src/forge/github/github-adapter.ts:107-109` (`getSnapshot`)
- Modify: `packages/core/src/forge/gitlab/gitlab-adapter.ts:117-119` (`getSnapshot`)
- Test: `packages/core/test/snapshot.test.ts`, `packages/core/test/github-adapter.test.ts`, `packages/core/test/gitlab-adapter.test.ts`

- [ ] **Step 1: Write the failing tests**

In `snapshot.test.ts`, the four `assembleSnapshot(...)` calls change shape: `assembleSnapshot(repo, 42, fakePrimitives(...), 50)` → `assembleSnapshot(repo, 42, fakePrimitives(...), { commentCap: 50, botUser: 'maestro-bot' })` (and `2` → `{ commentCap: 2, botUser: 'maestro-bot' }`). Add:

```ts
  it('surfaces the MR comments on the snapshot, newest-first', async () => {
    const snap = await assembleSnapshot(
      repo,
      42,
      fakePrimitives({
        openMergeRequests: async () => [mr()],
        mrComments: async () => [
          comment('a', '2026-01-01', 'x', 'a'),
          comment('b', '2026-01-02', 'x', 'b'),
        ],
        lastBotPushAt: async () => '2026-01-03',
      }),
      { commentCap: 50, botUser: 'maestro-bot' },
    );
    expect(snap.mrComments?.map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('omits mrComments when there is no MR (mirror of mr)', async () => {
    const snap = await assembleSnapshot(repo, 42, fakePrimitives(), {
      commentCap: 50,
      botUser: 'maestro-bot',
    });
    expect(snap.mrComments).toBeUndefined();
  });
```

- [ ] **Step 2: Implement**

`forge-model.ts`, in `IssueSnapshot` after `recentComments`:

```ts
  /** The maestro MR's conversation comments, newest-first, bounded like recentComments.
   *  Present iff `mr` is (spec 2026-06-05: the comment review channel + rework feedback). */
  mrComments?: Comment[];
```

`snapshot.ts` — final `assembleSnapshot`:

```ts
/** The two construction-config scalars the algorithm needs from the adapter. */
export interface SnapshotOptions {
  commentCap: number;
  botUser: string;
}

export async function assembleSnapshot(
  repo: RepoRef,
  issueIid: number,
  prim: ForgePrimitives,
  opts: SnapshotOptions,
): Promise<IssueSnapshot> {
  const issue = await prim.issue(issueIid);
  const lastActor = await prim.lastActor(issueIid);
  const issueWithActor: Issue = lastActor ? { ...issue, lastActor } : issue;

  // Issue comments are fetched BEFORE the MR lookup: the comment review channel
  // listens on both surfaces, so findMaestroMr needs them (spec 2026-06-05).
  const recentComments = (await prim.comments(issueIid))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, opts.commentCap);

  const found = await findMaestroMr(issueIid, prim, {
    botUser: opts.botUser,
    issueComments: recentComments,
    commentCap: opts.commentCap,
  });

  return {
    repo,
    issue: issueWithActor,
    recentComments,
    ...(found ? { mr: found.mr, mrComments: found.mrComments } : {}),
  };
}
```

Both adapters' `getSnapshot`:

```ts
    return assembleSnapshot(repo, issueIid, this.#primitives(repo), {
      commentCap: this.#c.commentCap,
      botUser: this.#c.botUser,
    });
```

- [ ] **Step 3: Fix adapter test wiring**

The new fetches hit unstubbed FakeExec routes (loud failure: `FakeExec: no matcher for …`). **Stub registration order matters** — `onApi` matches by path *substring* and the FIRST registered matcher wins, so the new, more-specific routes must be registered BEFORE the broad ones (`/pulls/7/commits` would otherwise match the existing `GET /pulls` stub and silently return PRs as commits).

`github-adapter.test.ts` `wireSnapshot` — in the `opts.pr` branch, register the new stubs FIRST:

```ts
  if (opts.pr) {
    fake.onApi('GET', '/pulls/7/commits', []); // BEFORE '/pulls' — substring order
    fake.onApi('GET', '/issues/7/comments', []);
    fake.onApi('GET', '/pulls/7/reviews', []);
    fake.onApi('GET', '/pulls', [rawPr()]);
  } else {
```

`gitlab-adapter.test.ts` `wireSnapshot` equivalent: add `fake.onApi('GET', '/merge_requests/7/notes', [])` plus whatever commits route the failure message names, registered before any broader substring match.

Other getSnapshot tests in both files (GitHub ~lines 460-560) wire stubs themselves — run the suites and add the same two stubs to each failing wiring. Then **audit, don't just green**: for every test asserting `approvals.approved` / `approvals.changesRequested`, confirm the stubbed comments can't now flip the expectation through the comment channel (non-bot issue comments + an empty commits stub means `lastPush === undefined` → ALL non-bot comments count). Where a test's intent is formal-channel-only, stub the comments empty rather than weakening the assertion.

- [ ] **Step 4: Full build + suite**

Run: `pnpm -r build && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/contracts/forge-model.ts \
        packages/core/src/forge/snapshot.ts \
        packages/core/src/forge/github/github-adapter.ts \
        packages/core/src/forge/gitlab/gitlab-adapter.ts \
        packages/core/test/snapshot.test.ts \
        packages/core/test/github-adapter.test.ts \
        packages/core/test/gitlab-adapter.test.ts
git commit -m "Surface MR comments on the snapshot, thread botUser

The comment channel needs the bot identity to filter its own proof
and ping comments, and downstream rework feedback needs the MR
conversation — so the snapshot carries both."
```

---

### Task 5: Adapter-level channel tests (through `getSnapshot`)

End-to-end through each adapter's primitives: raw forge JSON in, folded ApprovalState out.

**Files:**
- Test: `packages/core/test/github-adapter.test.ts` (new describe after Slice 2)
- Test: `packages/core/test/gitlab-adapter.test.ts` (same)

- [ ] **Step 1: GitHub tests**

```ts
describe('comment review channel — /approve and feedback comments', () => {
  function wireChannel(fake: FakeExec, mrComments: unknown[]) {
    fake.onApi('GET', '/issues/42/timeline', []);
    fake.onApi('GET', '/issues/42/comments', []);
    fake.onApi('GET', '/pulls/7/commits', [
      // bot push at 06-02 — the edge the channel triggers against
      {
        author: { login: 'maestro-bot' },
        commit: { committer: { date: '2026-06-02T00:00:00Z' } },
      },
    ]);
    fake.onApi('GET', '/issues/7/comments', mrComments);
    fake.onApi('GET', '/pulls/7/reviews', []);
    fake.onApi('GET', '/pulls', [rawPr({ assignees: [user(2, 'reporter')] })]);
    fake.onApi('GET', '/issues/42', rawIssue());
  }

  it('/approve from the PR assignee → approved', async () => {
    const { a, fake } = mk();
    wireChannel(fake, [
      { id: 1, user: user(2, 'reporter'), body: '/approve', created_at: '2026-06-03T00:00:00Z' },
    ]);
    const snap = await a.getSnapshot(repo, 42);
    expect(snap.mr?.approvals.approved).toBe(true);
    expect(snap.mr?.approvals.changesRequested).toBe(false);
  });

  it('feedback comment → changesRequested', async () => {
    const { a, fake } = mk();
    wireChannel(fake, [
      { id: 1, user: user(5, 'anyone'), body: 'bug: 500 on empty body', created_at: '2026-06-03T00:00:00Z' },
    ]);
    const snap = await a.getSnapshot(repo, 42);
    expect(snap.mr?.approvals.changesRequested).toBe(true);
    expect(snap.mr?.approvals.approved).toBe(false);
  });

  it('comment predating the bot push → neither (stale)', async () => {
    const { a, fake } = mk();
    wireChannel(fake, [
      { id: 1, user: user(2, 'reporter'), body: '/approve', created_at: '2026-06-01T00:00:00Z' },
    ]);
    const snap = await a.getSnapshot(repo, 42);
    expect(snap.mr?.approvals.approved).toBe(false);
    expect(snap.mr?.approvals.changesRequested).toBe(false);
  });

  it('snapshot carries the MR comments for rework feedback', async () => {
    const { a, fake } = mk();
    wireChannel(fake, [
      { id: 1, user: user(5, 'anyone'), body: 'fix this', created_at: '2026-06-03T00:00:00Z' },
    ]);
    const snap = await a.getSnapshot(repo, 42);
    expect(snap.mrComments?.map((c) => c.body)).toEqual(['fix this']);
  });
});
```

(Adjust the raw commit shape to whatever `#lastBotPushAt`'s `RawCommit` expects if TS complains — see `normalize.ts`.)

- [ ] **Step 2: GitLab tests** — mirror the four cases with GitLab raw shapes: notes via `GET /merge_requests/7/notes` (`{ id, author: { id, username }, body, created_at, system: false }`), bot commit via the repository-commits route used by `#lastBotPushAt` (`gitlab-adapter.ts:387` — check the exact path + raw shape there and in existing gitlab tests), MR assignee on `rawMr({ assignees: [...] })`. Register specific routes before broad substrings, as in Task 4.

- [ ] **Step 3: Run**

Run: `pnpm test -- adapter.test`
Expected: PASS (both files).

- [ ] **Step 4: Commit**

```bash
git add packages/core/test/github-adapter.test.ts packages/core/test/gitlab-adapter.test.ts
git commit -m "Cover the comment review channel through both adapters"
```

---

### Task 6: Rework feedback includes MR comments

**Files:**
- Modify: `packages/core/src/reconciler/reconcile.ts:105-111`
- Test: `packages/core/test/reconcile.test.ts`
- Modify: `docs/superpowers/specs/2026-06-05-comment-review-triggers-design.md` (Untouched section)

- [ ] **Step 1: Write the failing test** — next to the existing apply-changes-requested feedback test (~line 294, reuse its `snapshot()`/`issue()`/`mr()` helpers; copy the existing test's setup for an in-review issue with `changesRequested: true`):

```ts
  it('passes MERGED issue + MR comments as feedback, newest-first', () => {
    const issueC = comment('1', '2026-01-01', 'reporter', 'issue feedback');
    const mrC = comment('2', '2026-01-02', 'reporter', 'MR feedback');
    const out = reconcile(
      buildInput({
        snapshot: snapshot({
          issue: inReviewIssue(),
          mr: mr({ approvals: { approved: false, approvedBy: [], changesRequested: true } }),
          recentComments: [issueC],
          mrComments: [mrC],
        }),
      }),
    );
    expect(out.kind).toBe('apply-changes-requested');
    if (out.kind === 'apply-changes-requested') {
      expect(out.feedback.reviewComments.map((c) => c.id)).toEqual(['2', '1']);
    }
  });
```

(Add a local `comment` helper mirroring the snapshot-test one if the file lacks an equivalent; match the file's existing fixture style.)

- [ ] **Step 2: Run to verify it fails** — `pnpm test -- reconcile.test` → FAIL: feedback contains only the issue comment.

- [ ] **Step 3: Implement** — in `reconcile.ts`, add near `repliesSinceBlock`:

```ts
/** Issue + MR comments merged newest-first — review feedback lives on either surface
 *  (spec 2026-06-05), and the agent should see all of it. */
function mergedComments(snapshot: IssueSnapshot): Comment[] {
  return [...snapshot.recentComments, ...(snapshot.mrComments ?? [])].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
}
```

and change line ~109: `feedback: { reviewComments: snapshot.recentComments }` → `feedback: { reviewComments: mergedComments(snapshot) }`. (`IssueSnapshot` is already imported there; add it if not.)

- [ ] **Step 4: Run** — `pnpm test -- reconcile.test` → PASS.

- [ ] **Step 5: Amend the spec** — in the spec's `## Untouched` section, replace the first line with:

```markdown
Reconciler branching logic — the in-review case statement consumes the folded
`ApprovalState` unchanged; only the `apply-changes-requested` feedback assembly
gains MR comments. Blocked-state logic (`repliesSinceBlock` still reads issue
comments only), formal-review normalization paths.
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/reconciler/reconcile.ts packages/core/test/reconcile.test.ts \
        docs/superpowers/specs/2026-06-05-comment-review-triggers-design.md
git commit -m "Include MR comments in changes-requested feedback

A bug report written on the PR never reached the agent — feedback
only carried issue comments. Merge both streams newest-first."
```

---

### Task 7: State the contract in handoff comments

**Files:**
- Modify: `packages/core/src/handoff/handoff.ts:25-38`
- Test: `packages/core/test/handoff.test.ts`

- [ ] **Step 1: Write the failing test** — `handoff.test.ts` has a `recorder()` fake whose `comments` array captures every `commentIssue` body, and `hin()` builds a HandoffInput (lines 67-124). With `assignLands: false` the handoff posts BOTH the proof comment and the fallback ping:

```ts
  it('proof and ping comments state the /approve contract', async () => {
    const { adapter, comments } = recorder(snapshot(), { assignLands: false });
    await handoff(hin(adapter));
    expect(comments).toHaveLength(2); // proof + reviewer ping
    for (const body of comments) expect(body).toContain('Reply `/approve` to merge');
  });
```

- [ ] **Step 2: Run to verify it fails** — `pnpm test -- handoff.test` → FAIL.

- [ ] **Step 3: Implement** — in `handoff.ts`:

```ts
/** The comment review channel's contract (spec 2026-06-05), stated wherever the
 *  reviewer is pinged so they never need to know maestro internals. */
const REVIEW_CONTRACT =
  'Reply `/approve` to merge, or describe needed changes to send it back.';

function proofCommentBody(proof: ProofResult): string {
  const header = proof.ok ? '### ✅ Proof' : '### ⚠️ Proof (failed — review with caution)';
  return `${header}\n\n${proof.summary}\n\n${REVIEW_CONTRACT}\n\n${DONE_SENTINEL}`;
}
```

and in `reviewPingBody`, insert `${REVIEW_CONTRACT}\n\n` before `${REVIEW_PING_SENTINEL}`.

- [ ] **Step 4: Run** — `pnpm test -- handoff.test` → PASS (existing assertions are `toContain`-style, so additive text is safe).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/handoff/handoff.ts packages/core/test/handoff.test.ts
git commit -m "State the /approve contract in handoff comments

The comment review channel only works if the reviewer knows it
exists; the proof comment is the always-present surface."
```

---

### Task 8: Final verification

- [ ] **Step 1: Full build + suite** — `pnpm -r build && pnpm test` → all green.
- [ ] **Step 2: Spec coverage check** — re-read the spec; every Decision-summary row and Architecture bullet maps to a commit (Q-channel semantics → T1/T3, both surfaces → T3/T4, adapters → T2/T5, feedback merge → T6, ping contract → T7).
- [ ] **Step 3: Push + PR** — use the superpowers:finishing-a-development-branch skill. PR body: closes nothing (no tracking issue yet) — reference the spec path; verbatim test output of `pnpm test` in the proof section.

---

## Notes for the executor

- The repo's comment style is dense and explains *why* + spec references (`§7`, `#6`) — match it.
- `pnpm test -- <pattern>` filters vitest by filename from the repo root.
- If GitLab raw shapes are unclear, read `packages/core/src/forge/gitlab/normalize.ts` and the existing fixtures in `gitlab-adapter.test.ts` — never invent fields.
- Integration-test files (`*.integration.test.ts`) are env-gated; do not touch them.
