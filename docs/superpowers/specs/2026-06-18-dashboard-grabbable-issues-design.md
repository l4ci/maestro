# Dashboard: grabbable open-issues + one-click "Work on this"

**Date:** 2026-06-18
**Status:** Approved (design), pending implementation plan

## Problem

The web dashboard only ever surfaces issues the bot is **already** assigned to
(it is built entirely on `listAssignedOpenIssues()`). There is no way to see the
backlog of open issues that nobody has handed to the bot yet, and no way to hand
one off from the dashboard. To assign work today you must go to the forge UI,
assign the bot manually, and wait for the next daemon tick.

This feature adds, per repo:

1. A **count of grabbable issues** — open issues *not* assigned to the bot —
   shown as a badge on the repo card.
2. A **modal** listing those issues on demand.
3. A **"Work on this"** button per issue that assigns the bot (and applies the
   configured trigger label if any), so the daemon picks the issue up on its
   next tick.

"Grabbable" = open AND not assigned to the bot (may be unassigned or assigned to
a human). In-flight bot work stays on the existing board and is excluded here.

## Background: what the daemon already does with an issue

When the daemon works an issue it is **not** starting from a blank slate. This is
relevant because "Work on this" can hand off an issue that already has discussion
and even a pre-existing maestro MR:

- `assembleSnapshot` (`packages/core/src/forge/snapshot.ts:29`) calls
  `prim.comments(issueIid)` and attaches a bounded, newest-first `recentComments`
  array to the snapshot. The agent reads the full thread
  (`buildRunnerInput` in `executor.ts`; rendered in `claude-runner.ts:143`), and
  the reconciler's state machine derives block replies, CI-fix rounds, AC
  approval, and review verdicts from those comments.
- `assembleSnapshot` also calls `prim.openMergeRequests(issueIid)` and
  `findMaestroMr` (`snapshot.ts:114`) matches the issue's maestro MR by branch
  prefix **or** by a `Closes #iid` link, then reads its blocking review thread,
  last bot push, and CI status.

Caveat: "linked MR" means *the maestro MR for that issue* (branch convention or
`Closes #iid`). An arbitrary PR a human pastes into a comment is visible to the
agent as comment text but is not independently fetched/parsed.

## The trigger guard — why "assign" is necessary but sometimes not sufficient

The daemon's trigger guard (`reconcile.ts:34`, `passesTriggerGuard`) is
fail-closed and requires all of:

1. the bot is an assignee,
2. if `require_label` is non-null, the issue carries that label,
3. if `allowed_actors` is non-empty, `issue.lastActor?.username` is in it.

Defaults (`workflow-schema.ts:11`): `require_label: null`, `allowed_actors: []`.
`isAuthorizedActor` (`security/authorized-actor.ts:9`) treats an **empty**
`allowed_actors` as "trust everyone" (the private-repo default).

`issue.lastActor` is the actor of the most recent **assign/label event**
(GitHub timeline, GitLab resource-label events — `github-adapter.ts:392`,
`gitlab-adapter.ts:400`). Comments do **not** change it.

**Consequence:** the dashboard performs forge writes using the bot's token, so
assigning the bot makes `lastActor = bot`.

- Default / private config (`allowed_actors: []`): guard passes → daemon starts.
- A repo that sets `allowed_actors` **excluding** the bot: the dashboard-driven
  assignment's `lastActor` is the bot, so the guard blocks and the daemon
  silently ignores it.

We do not try to spoof `lastActor`. Instead the `/work` endpoint **detects** this
case and returns a warning so the UI can be honest about it (see §3).

## 1. Forge layer

Add to the `ForgeAdapter` interface (`contracts/forge-adapter.ts`), implemented
for both GitHub (`forge/github/github-adapter.ts`) and GitLab
(`forge/gitlab/gitlab-adapter.ts`):

- `listGrabbableIssues(repo: RepoRef): Promise<Issue[]>`
  Open issues NOT assigned to the bot. One page (`per_page: 100`, no `--paginate`)
  of open issues, then **client-side filter** out any issue whose `assignees`
  include the bot (and, on GitHub, drop PRs — exactly as the existing list
  methods do). The badge count is `list.length`; the modal renders the same list.
- `assignIssue(repo: RepoRef, issueIid: number, username: string): Promise<void>`
  Idempotent assign of one user to an issue. (`assignMR` only covers MRs today;
  this is the missing primitive.)

**Design tension resolved — count vs. list cost, and why ONE method not two.**
The original design split a cheap "count" call from a lazy "list" call. Ground
truth killed that: the shared HTTP client (`forge/cli.ts` `ForgeCli.api`) returns
only the parsed JSON body — it does NOT expose response headers, so GitLab's
`X-Total` and GitHub's search `total_count` are unreachable without modifying the
frozen shared transport. Rather than plumb headers through it (or adopt the
rate-limited GitHub search API, which is used nowhere in the codebase), we use ONE
method that fetches a single bounded page and filters client-side.

Cost is acceptable because it is marginal next to work the dashboard already does
every poll: `assembleDashboard` already calls `listAssignedOpenIssues` per repo
AND a `getSnapshot` (several forge calls) per assigned issue. One extra single-page
list per repo is noise against that fan-out.

**Bounded-count caveat (documented, not hidden):** the page cap is 100. A repo
with >100 open issues may under-count grabbable ones, and the badge shows `100+`
when the page is full. This is a badge, not an accountant — acceptable, and
surfaced in the UI via the `+`.

## 2. Web read path

- `RepoView` (`packages/core/src/views/assemble.ts`) gains
  `grabbableCount: number`, populated during assembly via `listGrabbableIssues`
  (`= list.length`, capped at the 100 page). It rides in the SAME `try` as the
  existing assigned-issue assembly, so a per-repo forge error already degrades the
  whole card to `error` (the existing pattern) rather than half-rendering.
- The dashboard JSON already carries `writesEnabled` (server.ts:64) — the frontend
  uses the SAME flag for the "Work on this" button as it does for the add-repo
  button. No new flag.
- New route `GET /repos/:repoId/open-issues` (`packages/web/src/server.ts`) →
  `{ issues: OpenIssueItem[] }`, driven by a new read seam `loadOpenIssues` that
  calls `listGrabbableIssues`. `repoId` is the URL-encoded `repo.url` segment,
  consistent with the existing `/repos/:repoId/issues/:iid` route. `OpenIssueItem`
  carries `iid, title, author, labels, issueUrl` — the fields the modal renders.
- This route forces a real `repoForId` resolution: `main.ts` currently stubs it to
  `repos[0]` (single-repo v1). We replace the stub with
  `repos.find(r => r.url === repoId)`, which also fixes multi-repo drill-down.

## 3. Web write path

New route `POST /repos/:repoId/issues/:iid/work` (`packages/web/src/server.ts`),
gated by the **same** writes-enabled + bearer-token guard that already protects
`POST /repos`. Behaviour:

1. `assignIssue(repo, iid, botUser)`.
2. If the repo's resolved `require_label` is non-null,
   `setIssueLabels(repo, iid, [label], [])`.
3. Inspect the repo's resolved `allowed_actors`. If it is non-empty and does not
   contain `botUser`, include `{ warning: "actor-allowlist-blocks-autostart" }`
   in the response body.
4. Respond `200 { ok: true, warning? }`.

No direct daemon invocation — the dashboard stays a one-way projection; the
daemon discovers the assignment on its next tick. `assignIssue` and
`setIssueLabels` are idempotent, so a double-click or an already-assigned issue
is harmless.

Auth responses: `401` without/!valid bearer token, `403` when writes are
disabled (consistent with `POST /repos`).

## 4. Frontend (`packages/web/src/page.ts`, vanilla JS)

- **Badge:** repo card header shows "N open" when `grabbableCount > 0`; hidden
  when 0 or undefined (error). Clicking opens the modal.
- **Modal:** lazy-fetches `GET /repos/:repoId/open-issues` on open. Renders one
  row per issue: iid, title, author, labels, external link, and a "Work on this"
  button. All forge-supplied strings rendered via `textContent` / inert-text per
  §13.1 — never `innerHTML`. Reuses the existing dialog/modal styling and the 5s
  keyed-reconciliation conventions where it overlaps the board.
- **Work on this:** hidden when `writesEnabled` is false. On click, `POST .../work`
  with the bearer token (reuse the add-repo token entry flow). Optimistic UI: the
  row shows "Queued…"; the issue migrates onto the board within one tick and
  drops out of the grabbable list on the next poll. If the response carries
  `warning: "actor-allowlist-blocks-autostart"`, show an inline notice
  ("Assigned, but this repo's actor allowlist will block auto-start — add the bot
  to `allowed_actors`."). A `403`/`401` surfaces a non-destructive error message.

## 5. Testing

- Adapter unit tests (GitHub + GitLab) for `listGrabbableIssues` (open issues
  returned; bot-assigned filtered out; GitHub PRs dropped) and `assignIssue`
  (idempotent no-op when already assigned; correct endpoint/body otherwise),
  against the `FakeExec` + `onApi` mock the existing adapter tests use.
- `core` unit test for `workOnIssue`: assigns the bot; applies `require_label`
  only when set; returns the `actor-allowlist-blocks-autostart` warning iff
  `allowed_actors` is non-empty and excludes the bot.
- `assemble.ts` test (`views.test.ts`): `grabbableCount` populated from the new
  read method; the existing `roAdapter` fake and its calls-set assertion are
  updated for the added read method.
- Server route tests (`server.test.ts`) for `GET /open-issues` and
  `POST .../work`, including auth gating (401 no token, 403 wrong token, 404 when
  writes disabled) and the allowlist-warning passthrough.
- The full-adapter fake `test/helpers/daemon.ts` and any `ReadOnlyForgeAdapter`
  literal gain the new methods so the suite compiles.
- Frontend (`page.ts`): covered by the existing jsdom harness in
  `packages/web/test/page.test.ts` (it `eval`s the page script) — add cases for
  badge visibility/thresholding, modal lazy-fetch, `writesEnabled` button gating,
  the work POST + warning handling, and token-clear on auth failure. Plus a manual
  verification step (load dashboard, open modal, click "Work on this", observe
  assignment).
- Reconciler/daemon: unchanged — existing coverage applies because the daemon
  path (assignment → next-tick pickup) is unmodified.

## Decisions (locked)

- One-click, no confirm dialog — optimistic feedback instead.
- ONE `listGrabbableIssues` method; count = `list.length` (single bounded page),
  no separate count call and no header/search plumbing into the shared transport.
- Trigger label auto-applied only when `require_label` is configured.
- `allowed_actors` mismatch is surfaced as a warning, not silently worked around.
- `repoForId` upgraded from the `repos[0]` stub to a real URL lookup.

## Out of scope (YAGNI)

- Bulk "work on all" / multi-select.
- Cross-repo global view (per-repo only, matching the board).
- Fetching/parsing arbitrary PRs referenced in comments.
- Unassigning or re-prioritising from the dashboard.
