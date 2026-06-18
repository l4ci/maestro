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

- `countGrabbableIssues(repo: RepoRef): Promise<number>`
  Open issues not assigned to the bot. Uses the forge's native negation filter
  so it is cheap (no full pagination):
  - GitHub: search API, `is:issue is:open repo:<repo> -assignee:<bot>`, read
    `total_count`.
  - GitLab: `GET /projects/:id/issues?state=opened&not[assignee_username]=<bot>&per_page=1`,
    read the `X-Total` header.
- `listGrabbableIssues(repo: RepoRef): Promise<Issue[]>`
  The full list (reuses the same filter, paginated). Fetched only when a modal
  opens.
- `assignIssue(repo: RepoRef, issueIid: number, username: string): Promise<void>`
  Idempotent assign of one user to an issue. (`assignMR` only covers MRs today;
  this is the missing primitive.)

**Design tension resolved — count vs. list cost.** Listing every repo's full open
backlog on every 5s poll is real API load on large repos. So the badge uses the
cheap header/`total_count` count on each poll, and the full list is fetched
lazily only when the modal opens (mirrors the per-issue drill-down, #41).

## 2. Web read path

- `RepoView` (`packages/core/src/views/assemble.ts`) gains
  `grabbableCount: number`, populated during assembly via
  `countGrabbableIssues`. A per-repo forge error degrades to omitting the count
  (existing `error` field pattern), never breaks the card.
- The view also exposes a `writesEnabled: boolean` flag so the frontend can
  show/hide the "Work on this" button (writes are gated server-side regardless).
- New route `GET /repos/:repoId/open-issues` (`packages/web/src/server.ts`) →
  `{ issues: IssueListItem[] }`, driven by `listGrabbableIssues`. `repoId` is the
  URL-encoded `group/repo` segment, consistent with the existing
  `/repos/:repoId/issues/:iid` route. `IssueListItem` carries `iid, title,
  author, labels, issueUrl` — the fields the modal renders.

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

- Adapter unit tests (GitHub + GitLab) for `countGrabbableIssues`,
  `listGrabbableIssues`, `assignIssue` against mocked API responses — including
  the negation-filter count parsing (`total_count` / `X-Total`).
- `assemble.ts` test: `grabbableCount` populated; per-repo error degrades to no
  count without throwing.
- Server route tests for `GET /open-issues` and `POST .../work`, including auth
  gating (401 no token, 403 writes disabled) and the allowlist-warning path.
- Reconciler/daemon: unchanged — no new tests needed; existing coverage applies
  because the daemon path (assignment → next-tick pickup) is unmodified.

## Decisions (locked)

- One-click, no confirm dialog — optimistic feedback instead.
- Cheap count on every poll, lazy full list on modal open.
- Trigger label auto-applied only when `require_label` is configured.
- `allowed_actors` mismatch is surfaced as a warning, not silently worked around.

## Out of scope (YAGNI)

- Bulk "work on all" / multi-select.
- Cross-repo global view (per-repo only, matching the board).
- Fetching/parsing arbitrary PRs referenced in comments.
- Unassigning or re-prioritising from the dashboard.
