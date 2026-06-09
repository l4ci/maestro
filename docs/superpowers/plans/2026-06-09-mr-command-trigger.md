# MR Command Trigger — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** React to a `/maestro <instruction>` comment on an open, bot-assigned MR that has no backing issue — the agent follows the instruction, pushes if it changed code, and always replies.

**Architecture:** A new daemon pass parallel to the issue lifecycle, driven by a **pure** `decideMrCommand` edge that clears on the bot's always-posted reply comment (cannot loop — the issue #5 lesson). The issue reconciler gains zero MR logic. Spec: `docs/superpowers/specs/2026-06-09-mr-command-trigger-design.md`.

**Tech Stack:** TS strict ESM · vitest · zod · biome · `glab`/`gh` over the `Exec` seam.

---

## File structure

- Create `packages/core/src/forge/comments.ts` — shared `isHumanComment` + `/maestro` helpers (extracted from `reconcile.ts`; behaviour-preserving, removes the duplicate-predicate risk).
- Create `packages/core/src/mr-command/decide.ts` — pure `decideMrCommand` + `MrCommandIntent`.
- Create `packages/core/src/mr-command/prompt.ts` — built-in MR-command runner prompt.
- Create `packages/core/src/daemon/mr-command-pass.ts` — the I/O pass (keeps `tick.ts` from growing; it is already 877 lines).
- Modify `packages/core/src/contracts/index.ts` — add `MR_COMMAND_REPLY_SENTINEL`.
- Modify `packages/core/src/contracts/forge-adapter.ts` — add 3 methods.
- Modify `packages/core/src/forge/gitlab/gitlab-adapter.ts` + `github/github-adapter.ts` — implement them.
- Modify `packages/core/src/reconciler/reconcile.ts` — import the extracted helper (no logic change).
- Modify `packages/core/src/workspace/workspace-manager.ts` + `paths.ts` — `mr-<iid>` keying + MR-aware cleanup sweep.
- Modify `packages/core/src/daemon/tick.ts` + `ports.ts` — call the new pass; widen `TickContext`.
- Tests alongside each, under `packages/core/test/`.

---

## Task 1: Extract the shared comment predicate

**Files:**
- Create: `packages/core/src/forge/comments.ts`
- Modify: `packages/core/src/reconciler/reconcile.ts` (replace local `isHumanComment` with an import)
- Test: `packages/core/test/comments.test.ts`

- [ ] **Step 1 — failing test** for the extracted predicate:

```ts
import { isHumanComment } from '../src/forge/comments.js';
const c = (over: Partial<Comment>): Comment => ({ id: '1', author: { id: 1, username: 'x' }, body: '', createdAt: '2026-01-01', ...over });
it('a different author is human', () => expect(isHumanComment(c({ author: { id: 9, username: 'someone' } }), 'bot')).toBe(true));
it('bot author with body-start /maestro is human', () => expect(isHumanComment(c({ author: { id: 1, username: 'bot' }, body: '/maestro do x' }), 'bot')).toBe(true));
it('bot author, mid-body /maestro is NOT human', () => expect(isHumanComment(c({ author: { id: 1, username: 'bot' }, body: 'plan\n/maestro x' }), 'bot')).toBe(false));
```

- [ ] **Step 2 — run, expect FAIL** (`comments.ts` missing): `npx vitest run packages/core/test/comments.test.ts`
- [ ] **Step 3 — implement**, copying the exact predicate from `reconcile.ts` (do not change the rule):

```ts
import type { Comment } from '../contracts/index.js';
import { MAESTRO_COMMAND_RE } from '../contracts/index.js';
/** A comment provably written by a human (shared-account rule, §13.1): a different
 *  author, OR a body STARTING with `/maestro`. Body-start only — smuggled mid-body
 *  commands inside daemon comments must never count. */
export function isHumanComment(c: Comment, botUser: string): boolean {
  return c.author.username !== botUser || MAESTRO_COMMAND_RE.test(c.body);
}
```

- [ ] **Step 4 — update `reconcile.ts`**: delete its local `isHumanComment`, add `import { isHumanComment } from '../forge/comments.js';`. Run the full reconcile suite, expect PASS unchanged: `npx vitest run packages/core/test/reconcile.test.ts`
- [ ] **Step 5 — commit**: `git add … && git commit -m "Extract isHumanComment to a shared comment helper"`

## Task 2: Reply sentinel constant

**Files:** Modify `packages/core/src/contracts/index.ts` (or the constants module that holds `DONE_SENTINEL`, `AC_DRAFT_SENTINEL`).

- [ ] **Step 1 — add** next to the existing sentinels:

```ts
/** Marks the bot's reply to an MR command (§MR-command). Its presence newer than a
 *  command comment retires the edge — the reply is posted on every terminal path, so
 *  the edge cannot loop. */
export const MR_COMMAND_REPLY_SENTINEL = '<!-- maestro:mr-reply -->';
```

- [ ] **Step 2 — commit**: `git add … && git commit -m "Add MR_COMMAND_REPLY_SENTINEL"`

## Task 3: Pure `decideMrCommand`

**Files:**
- Create: `packages/core/src/mr-command/decide.ts`
- Test: `packages/core/test/mr-command-decide.test.ts`

- [ ] **Step 1 — failing tests** (newest-first thread; `guard = { requireLabel: null, allowedActors: [] }` unless noted):

```ts
import { decideMrCommand } from '../src/mr-command/decide.js';
// (a) command after no reply → run, instruction stripped of the leading token
expect(decideMrCommand([cmd('/maestro make sure this works', '2026-02-02', 'maintainer')], 'bot', guard))
  .toEqual({ kind: 'run-mr-command', instruction: 'make sure this works' });
// (b) command OLDER than the last bot reply → none
expect(decideMrCommand([reply('2026-02-03'), cmd('/maestro x', '2026-02-02', 'maintainer')], 'bot', guard).kind).toBe('none');
// (c) no /maestro comment → none
expect(decideMrCommand([plain('just a note', '2026-02-02', 'maintainer')], 'bot', guard).kind).toBe('none');
// (d) two stacked commands after last reply → newest wins
expect(decideMrCommand([cmd('/maestro newer', '2026-02-05', 'm'), cmd('/maestro older', '2026-02-04', 'm')], 'bot', guard).instruction).toBe('newer');
// (e) allowlist set, author not on it → none (fail-closed)
expect(decideMrCommand([cmd('/maestro x', '2026-02-02', 'stranger')], 'bot', { requireLabel: null, allowedActors: ['maintainer'] }).kind).toBe('none');
// (f) shared account: bot-authored body-start /maestro counts as human
expect(decideMrCommand([cmdBy('/maestro x', '2026-02-02', 'bot')], 'bot', guard).kind).toBe('run-mr-command');
```

(`cmd`/`reply`/`plain` build `Comment`s; `reply` body contains `MR_COMMAND_REPLY_SENTINEL` authored by `bot`.)

- [ ] **Step 2 — run, expect FAIL**: `npx vitest run packages/core/test/mr-command-decide.test.ts`
- [ ] **Step 3 — implement**:

```ts
import type { Comment, TriggerGuard } from '../contracts/index.js';
import { MAESTRO_COMMAND_RE, MR_COMMAND_REPLY_SENTINEL } from '../contracts/index.js';
import { isHumanComment } from '../forge/comments.js';

export type MrCommandIntent =
  | { kind: 'run-mr-command'; instruction: string }
  | { kind: 'none' };

/** Pure MR-thread edge (mirror of the issue reconciler). `thread` is newest-first.
 *  React-once: the newest authorized body-start /maestro command that post-dates the
 *  bot's newest reply. Self-clears because the reply is always posted. NO I/O. */
export function decideMrCommand(thread: Comment[], botUser: string, guard: TriggerGuard): MrCommandIntent {
  const lastReplyAt = thread.find((c) => c.author.username === botUser && c.body.includes(MR_COMMAND_REPLY_SENTINEL))?.createdAt ?? '';
  const authorized = (c: Comment) =>
    isHumanComment(c, botUser) &&
    (guard.allowedActors.length === 0 || guard.allowedActors.includes(c.author.username));
  const command = thread.find(
    (c) => MAESTRO_COMMAND_RE.test(c.body) && authorized(c) && c.createdAt > lastReplyAt,
  );
  if (!command) return { kind: 'none' };
  const instruction = command.body.replace(MAESTRO_COMMAND_RE, '').trim();
  return { kind: 'run-mr-command', instruction };
}
```

(`MAESTRO_COMMAND_RE` is the existing body-start `/maestro` matcher; confirm `.replace` strips the leading token — adjust the regex capture if it currently only `.test`s. Add a unit asserting `instruction` has no leading `/maestro`.)

- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit**: `git commit -m "Add pure decideMrCommand edge"`

## Task 4: Adapter — `listAssignedOpenMergeRequests`

**Files:** Modify `contracts/forge-adapter.ts`, `gitlab-adapter.ts`, `github-adapter.ts`. Tests in the two adapter suites.

- [ ] **Step 1 — add to the `ForgeAdapter` interface** (discovery group):

```ts
/** Open MRs/PRs assigned to bot_user. Drives the command-MR pass (no backing issue). */
listAssignedOpenMergeRequests(repo: RepoRef): Promise<MergeRequest[]>;
```

- [ ] **Step 2 — GitLab failing test** (mirror `Slice 1`): stub `GET /merge_requests?state=opened&assignee_username=<bot>` returning two raw MRs; assert normalized iids + `sourceBranch`.
- [ ] **Step 3 — GitLab impl**:

```ts
async listAssignedOpenMergeRequests(repo: RepoRef): Promise<MergeRequest[]> {
  const raw = (await this.#c.api<RawMr[]>('GET', `/projects/${this.#pid(repo)}/merge_requests`, {
    query: { state: 'opened', assignee_username: this.#c.botUser, per_page: 100 },
  })) ?? [];
  return raw.map((m) => normalizeMergeRequest(m));
}
```

- [ ] **Step 4 — GitHub failing test + impl**: PRs assigned to the bot via the issues endpoint, filtered to PRs, then normalized:

```ts
async listAssignedOpenMergeRequests(repo: RepoRef): Promise<MergeRequest[]> {
  const issues = (await this.#c.api<RawIssue[]>('GET', `${this.#base(repo)}/issues`, {
    query: { state: 'open', assignee: this.#c.botUser, per_page: 100 }, paginate: true,
  })) ?? [];
  const prs = issues.filter((i) => i.pull_request);
  return Promise.all(prs.map((i) => this.#getMergeRequest(repo, i.number)));
}
```

(`#getMergeRequest` = the existing PR fetch+normalize used by `getSnapshot`; reuse it.)

- [ ] **Step 5 — run both adapter suites, expect PASS. Commit.**

## Task 5: Adapter — `getMrComments` + `getMergeRequestState`

**Files:** same three files + suites.

- [ ] **Step 1 — interface**:

```ts
/** Comments on an MR/PR thread, normalized + system-filtered, newest-first capped. */
getMrComments(repo: RepoRef, mrIid: number): Promise<Comment[]>;
/** MR/PR state for the cleanup sweep: a merged or closed MR is terminal. */
getMergeRequestState(repo: RepoRef, mrIid: number): Promise<'open' | 'closed' | 'merged' | 'missing'>;
```

- [ ] **Step 2 — GitLab tests + impl**: `getMrComments` → `GET /merge_requests/:iid/notes` (drop `system`, `normalizeComment`, sort desc, cap `commentCap`). `getMergeRequestState` → `GET /merge_requests/:iid` mapping `state` `opened→open`, `merged→merged`, `closed/locked→closed`, 404→`missing`.
- [ ] **Step 3 — GitHub tests + impl**: comments → `GET /issues/:number/comments` (PR conversation). State → `GET /pulls/:number`: `merged===true → merged`, else `state open/closed`, 404→`missing`.
- [ ] **Step 4 — run, PASS. Commit.**

## Task 6: Built-in MR-command prompt

**Files:**
- Create: `packages/core/src/mr-command/prompt.ts`
- Test: `packages/core/test/mr-command-prompt.test.ts`

- [ ] **Step 1 — failing test**: `buildMrCommandPrompt({ instruction, mr, workflowBody })` returns a string containing the instruction, the MR title/description, an explicit "commit your changes; the daemon pushes" note, and the appended `workflowBody`.
- [ ] **Step 2 — implement** a fixed prompt (NOT a WORKFLOW-declared role): orient on the MR diff/description, follow `instruction`, make atomic commits if changing code, end with the agent contract status (reuse `STATUS_CONTRACT` from the runner). Append `workflowBody` for repo conventions.
- [ ] **Step 3 — PASS. Commit.**

## Task 7: Workspace `mr-<iid>` keying + MR-aware cleanup

**Files:** Modify `workspace/paths.ts`, `workspace/workspace-manager.ts`. Tests in `paths.test.ts` + `workspace-manager` suite.

- [ ] **Step 1 — failing test** for `paths.ts`: introduce an entity key so `resolveWorkspacePath(root, repo, { kind: 'mr', iid: 7 })` and `{ kind: 'issue', iid: 7 }` resolve to **distinct** dirs (e.g. `…/issue-7` vs `…/mr-7`). Keep a back-compat overload or migrate issue callers in the same task.
- [ ] **Step 2 — implement** the key in `resolveWorkspacePath`; update `WorkspaceManager.ensureWorkspace`/`workspaceExists`/`listWorkspaces` to carry the kind. Update issue callers in `tick.ts` to pass `{ kind: 'issue', iid }`.
- [ ] **Step 3 — cleanup sweep test**: a `mr-7` workspace whose MR is `merged` is evicted; an `open` MR's workspace is kept. (The sweep reads the kind from the dir name and calls `getMergeRequestState` vs `getIssueState`.)
- [ ] **Step 4 — implement** the sweep branch in `tick.ts cleanupSweep` (or `workspace-manager`): parse kind from the dir, query the matching state, evict on `closed`/`merged`/`missing` (issue: `closed`/`missing`).
- [ ] **Step 5 — full workspace + tick suites PASS. Commit.**

## Task 8: The command-MR daemon pass

**Files:**
- Create: `packages/core/src/daemon/mr-command-pass.ts`
- Modify: `packages/core/src/daemon/ports.ts` (widen `TickContext` with the 3 new adapter methods — already on `ForgeAdapter`, so this is just the type flowing through — and add a `mr` in-flight namespace), `packages/core/src/daemon/tick.ts` (call the pass from `tick()`/`tickRepo()` after the lifecycle pass).
- Test: `packages/core/test/mr-command-pass.test.ts`

- [ ] **Step 1 — failing test** (fake `TickContext`, FakeExec-free, mock adapter): a standalone MR (branch `feature/x`, no `Closes`) with a pending `/maestro` command →
  - one `runner.run` call,
  - `pushBranch` called iff the fake result reports a change,
  - exactly one `commentMR` containing `MR_COMMAND_REPLY_SENTINEL`,
  - a slot acquired+released.
  And: an issue-backed MR (branch `maestro/issue-9-…` or `Closes #9`) is **skipped** by this pass; a second tick after the reply → no `runner.run` (edge cleared).
- [ ] **Step 2 — implement**:

```ts
const isStandalone = (mr: MergeRequest) =>
  !mr.sourceBranch.startsWith('maestro/issue-') && mr.closesIssueIid === undefined;
// per repo per tick:
//   for mr of (await ctx.adapter.listAssignedOpenMergeRequests(repo)).filter(isStandalone):
//     if ctx.inFlight.has(key, mrTag(mr.iid)) continue; claim it
//     const thread = await ctx.adapter.getMrComments(repo, mr.iid)
//     const intent = decideMrCommand(thread, ctx.settings.botUser, ctx.settings.trigger)
//     if (intent.kind !== 'run-mr-command') { release; continue }
//     acquire slot → guard(runMrCommand(mr, intent.instruction, ctx)) → finally release + inFlight.delete
```

`runMrCommand`: `ensureWorkspace({kind:'mr', iid})` on `mr.sourceBranch` → `runner.run(buildMrCommandPrompt(...))` → if changed, `pushBranch` → **always** `commentMR(repo, mr.iid, reply + MR_COMMAND_REPLY_SENTINEL)` (success/no-op/needs_input/error variants per spec §5). Catch errors and still post the error reply (so the edge clears).

- [ ] **Step 3 — wire into `tick()`** alongside `evaluateLifecycle` + `cleanupSweep`; the command-MR pass shares the slot accountant and returns launched promises into the same `pending` array. Rate-limit gate (#47) applies to its spawns too (treat `run-mr-command` like a spawning intent).
- [ ] **Step 4 — run, PASS. Commit.**

## Task 9: Thesis guard + full verification

**Files:** Test `packages/core/test/mr-command-thesis.test.ts`; run the whole chain.

- [ ] **Step 1 — guard test**: read `reconciler/reconcile.ts` and assert it contains no `mr-command`/`MergeRequest command`/`MR_COMMAND_REPLY_SENTINEL` references — the issue FSM stays free of command-MR logic.
- [ ] **Step 2 — full suite**: `npx vitest run packages/core` → all green.
- [ ] **Step 3 — typecheck**: `npx tsc -p packages/core/tsconfig.json --noEmit`
- [ ] **Step 4 — lint**: `npx biome check packages/core/src packages/core/test`
- [ ] **Step 5 — build**: `pnpm --filter @maestro/core build`
- [ ] **Step 6 — docs**: add the **command MR** concept to `CONTEXT.md` (new vocabulary) and a short README lifecycle note. Commit.
- [ ] **Step 7 — final commit** if anything remains.

---

## Verification summary (run before opening the PR)
- `npx vitest run packages/core` — all green incl. the new decide/pass/adapter/workspace tests
- `npx tsc -p packages/core/tsconfig.json --noEmit` — clean
- `npx biome check packages/core/src packages/core/test` — clean
- `pnpm --filter @maestro/core build` — exit 0
- Manual (optional, gated): on a scratch MR with no issue, post `/maestro make sure the tests pass`; confirm exactly one reply with the sentinel and no second run on the next tick.

## Out of scope (v1)
`/maestro` on issue-backed MRs (issue path owns them) · WORKFLOW-declared `mr-command` role · acting on more than the newest pending command per tick · MR creation from a command.
