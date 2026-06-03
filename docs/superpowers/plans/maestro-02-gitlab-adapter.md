# Maestro — M2: GitLab Forge Adapter (reference implementation)

- **Source of truth:** `docs/superpowers/specs/2026-06-03-maestro-design.md` (locked)
- **Frozen contracts:** `docs/superpowers/plans/maestro-00-scaffolding-and-contracts.md`
  — §0.2 model, §0.3 `ForgeAdapter`, §0.7 labels, §0.8 `Exec` seam. Implement those
  shapes **verbatim**; never redefine them.
- **Depends on:** M0 (frozen contracts).
- **Decisions in force:** GitLab is the **reference** forge adapter — its behaviour
  settles what GitHub (M7) mirrors. All subprocess/network I/O flows through the
  injected `Exec` seam (§0.8). Scoped labels `maestro::*` give mutual exclusion for
  free. MR approval = native GitLab MR approval. `changesRequested` is **edge-triggered**
  per §0.3.

---

## Goal

Implement `ForgeAdapter` (§0.3) for GitLab using `glab` + GitLab REST/GraphQL, every
call routed through the injected `Exec` seam (§0.8). The adapter normalizes GitLab
payloads into the §0.2 model so the reconciler stays forge-agnostic, is idempotent
per §13 (re-create no-ops or returns existing), and implements §11 Free-tier board
automation. This is the canonical adapter behaviour M7 (GitHub) will replicate.

---

## Scope

**In:**
- `class GitlabAdapter implements ForgeAdapter` in `packages/core/src/forge/gitlab/`,
  `kind = 'gitlab'`, constructed with an injected `Exec` and a token resolver.
- All 15 interface methods (§0.3): `listAssignedOpenIssues`, `getSnapshot`,
  `getIssueState`, `createBranch`, `createDraftMR`, `updateMRDescription`, `setDraft`,
  `assignMR`, `mergeMR`, `setIssueLabels`, `commentIssue`, `commentMR`, `ensureLabels`,
  `ensureBoard` (GitLab-only, §11), `createIssue`.
- Normalization of GitLab JSON → §0.2 `Issue` / `MergeRequest` / `ApprovalState` /
  `Comment` / `IssueSnapshot` / `ForgeUser` / `Label`.
- Edge-triggered `changesRequested` (§0.3): compare newest change-request signal
  timestamp vs newest bot-authored commit on source branch.
- `lastActor` capture from issue resource/label events for the trigger guard (§13.1).
- Idempotency for every mutation; scoped-label mutual exclusion via GitLab's native
  scoped labels (set `maestro::x`, GitLab drops the sibling).
- §11 board automation: ensure labels → ensure board → ensure lists ordered by
  lifecycle (`LabelNames.all()`).

**Out (other milestones / deferred):**
- Reconciler logic (M1), workspace/clone auth (M3), runner (M4/§0.9), daemon loop +
  cleanup sweep wiring (M5), GitHub adapter (M7), Projects-V2 board (deferred §11/§17).
- Real `Exec`-over-`child_process` impl if M0/M3 already provide it; M2 only *consumes*
  the seam. If no concrete `Exec` exists yet, M2 ships the minimal `node:child_process`
  wrapper it needs (see Open dependencies).

---

## Testing strategy — adapter tests without touching gitlab.com

**Unit tier (default, hermetic).** Inject a **fake `Exec`** (`FakeExec`) implementing
§0.8. It is a programmable transcript matcher: keyed on `(cmd, args-shape)`, returns a
recorded `ExecResult { code, stdout, stderr }`. The adapter issues `glab api ...` (REST)
and `glab api graphql ...` calls — so almost every fake response is a captured GitLab
JSON body on `stdout`. Tests assert two things: **(a) the command** the adapter built
(binary, subcommand, flags, request path/body — including that the token rides in
`ExecOptions.env`, never `argv`), and **(b) the normalization** of the returned JSON
into the §0.2 model.

`FakeExec` records every call so a test can assert call **count** (idempotency: second
`createDraftMR` makes zero create calls) and **order** (board: labels → board → lists).

**Fixture shape.** One file per GitLab response under
`packages/core/src/forge/gitlab/__fixtures__/`, named by API:
`issue-assigned-open.json`, `mr-draft-wip.json`, `mr-approved.json`,
`mr-changes-requested-events.json`, `issue-resource-label-events.json`,
`notes-issue.json`, `project-labels.json`, `boards-empty.json`, `board-lists.json`,
`commits-source-branch.json`, etc. Each is **verbatim GitLab REST/GraphQL JSON**
(captured once from a real project, then frozen). A small `loadFixture(name)` helper
reads them. A `FakeExec` builder maps a request matcher → fixture so a test reads as:
`onApi('GET', '/projects/:id/issues', issuesFixture)`.

**Integration tier (§15, opt-in, gated env var e.g. `MAESTRO_GITLAB_IT=1`).** Run the
**same** suite against a **throwaway scratch GitLab project** owned by a test bot,
using the real `Exec`. Tests create unique-named issues/MRs/labels (run-id suffixed),
assert against live responses, and tear down. CI default skips this tier; it runs on
demand / nightly. The recorded fixtures are *captured* from one blessed run of this
tier, keeping unit fixtures faithful. This is also the source for the exit-gate dry run.

**No test in M2 hits gitlab.com in the default `pnpm -r test` path.**

---

## TDD slices

Each slice: write the named failing test (intent + normalization assertions) first,
then the impl. All slices use `FakeExec`. Group tightly-coupled methods.

### Slice 0 — Adapter skeleton + REST/GraphQL call helper
- **Test** `gitlab adapter exposes kind 'gitlab' and routes a GET through Exec with
  token in env not argv`: construct `new GitlabAdapter(fakeExec, { token, host, ... })`;
  invoke the internal `api()` helper for a trivial `GET /version`; assert `fakeExec`
  saw `glab` (or `glab api`) with the path in args, `opts.env` carrying the token under
  the documented var, and **no token substring anywhere in `args`**.
- **Impl:** private `api(method, path, body?)` and `graphql(query, vars)` helpers that
  build `glab api` invocations, set `ExecOptions.env` from the injected token, parse
  `stdout` as JSON, and throw a typed `ForgeError` on non-zero `code` (carrying
  `stderr`, never the token). Pagination helper (follow `?page=`/Link or `--paginate`).

### Slice 1 — `listAssignedOpenIssues` (discovery)
- **Test** `assigned open issues normalize to Issue[] with labels as names and author`:
  `FakeExec` returns `issues-assigned.json` for `GET /projects/:id/issues?assignee_username=<bot>&state=opened`;
  assert each `Issue` has `iid`, `id` (stringified), `state:'open'`, `labels` as plain
  names, `assignees`/`author` as `ForgeUser{username,id}`, `webUrl`. Assert the query
  filters by `assignee_username = settings bot` and `state=opened`.
- **Impl:** build the request, paginate, map JSON → `Issue` via a shared
  `normalizeIssue()`.

### Slice 2 — `getSnapshot` (issue + maestro MR + recent comments)
- **Test** `getSnapshot assembles issue, its maestro MR, and newest-first capped comments`:
  fixtures for the issue, its related MRs (`GET /projects/:id/issues/:iid/related_merge_requests`
  or branch-derived lookup), and notes. Assert `IssueSnapshot.mr` is the maestro MR
  (the one whose source branch matches the maestro branch convention / that `Closes`
  the issue), `recentComments` newest-first and bounded (cap, e.g. 50), and `closesIssueIid`
  resolved on the MR.
- **Test** `getSnapshot with no MR yet → snapshot.mr undefined` (the New state).
- **Impl:** `normalizeMergeRequest()`, `normalizeComment()`, MR-selection logic
  (prefer the open MR that closes this issue; ignore unrelated MRs), comment cap + sort.

### Slice 3 — `getIssueState` (cleanup sweep support, §0.5)
- **Test** `getIssueState returns 'open' | 'closed' | 'missing'`: three fixtures —
  open issue, closed issue, and a 404 (`code != 0` / `404` body) → `'missing'`.
- **Impl:** `GET /projects/:id/issues/:iid`; map `state` field; 404 → `'missing'`
  (must **not** throw — distinguish 404 from other errors).

### Slice 4 — `createBranch` (idempotent)
- **Test** `createBranch creates from ref`: assert `POST /projects/:id/repository/branches?branch=&ref=`.
- **Test** `createBranch is idempotent when branch exists`: fixture where the POST
  returns the "branch already exists" 400 → adapter no-ops (resolves), does **not** throw.
- **Impl:** POST; on the known "exists" error, swallow and return.

### Slice 5 — `createDraftMR` (idempotent, returns existing)
- **Test** `createDraftMR opens a draft MR with Closes #N and bot assignee`: assert
  `POST /projects/:id/merge_requests` body has `source_branch`, `target_branch`, title
  marked **Draft** (GitLab draft = `Draft:` title prefix; set via title prefix and/or
  `POST` then `setDraft`), `description` containing `Closes #N`, assignee = bot when
  `assignToBot`. Returns a normalized `MergeRequest` with `isDraft:true`.
- **Test** `createDraftMR is idempotent — existing MR for source branch is returned, no
  second create`: `FakeExec` first returns an existing open MR on
  `GET /projects/:id/merge_requests?source_branch=<b>&state=opened`; assert **zero**
  create POSTs and the existing MR returned.
- **Normalization assertion** `GitLab MR JSON with work_in_progress=true (or title
  "Draft: …") → MergeRequest.isDraft=true`; `state 'opened'/'merged'/'closed'` mapped
  through unchanged.
- **Impl:** lookup-then-create; map `work_in_progress`/`draft`/title-prefix → `isDraft`.

### Slice 6 — `updateMRDescription` / `setDraft` / `assignMR`
- **Test** `updateMRDescription PUTs description`: assert `PUT /projects/:id/merge_requests/:iid`
  body `{ description }`.
- **Test** `setDraft(true) marks draft, setDraft(false) un-drafts`: assert PUT toggles
  GitLab draft (title `Draft:` prefix add/remove, the Free-tier-portable mechanism).
- **Test** `setDraft is idempotent`: MR already in target draft-state → no PUT (or a
  no-op PUT) — assert no spurious title mangling on repeat.
- **Test** `assignMR assigns the reviewer by username`: adapter resolves username →
  user id (`GET /users?username=`) then `PUT ...{ assignee_ids:[id] }` (or
  `reviewer_ids` per §7 handoff — **assignee** per contract signature). Assert the
  resolved id is used; idempotent if already assigned.
- **Impl:** the three PUT-based mutations + username→id resolution helper (cached per call).

### Slice 7 — `mergeMR` (strategy + delete source, idempotent)
- **Test** `mergeMR squash deletes source branch`: assert
  `PUT /projects/:id/merge_requests/:iid/merge` with `squash:true` (strategy map:
  `squash`→`squash:true`, `merge`→plain merge, `rebase`→`merge_when_pipeline_succeeds`
  /rebase-then-merge — document the exact mapping) and `should_remove_source_branch:true`.
- **Test** `mergeMR is idempotent — already-merged MR no-ops`: fixture MR `state:'merged'`
  → adapter detects and returns without re-merging.
- **Impl:** pre-check state, build merge body per `MergeStrategy`, pass `deleteSource`.

### Slice 8 — `setIssueLabels` (scoped mutual exclusion is free)
- **Test** `setIssueLabels adds set and removes unset using GitLab add_labels/remove_labels`:
  assert `PUT /projects/:id/issues/:iid?add_labels=…&remove_labels=…` (or the
  `labels` replace form). Assert that setting `maestro::in-review` while
  `maestro::in-progress` is present **does not** require the adapter to explicitly
  unset the sibling — note in the test that GitLab scoped labels drop the prior
  `maestro::*` automatically (contrast with M7 which must unset manually).
- **Test** `setIssueLabels is idempotent`: re-applying the same set yields no change.
- **Impl:** use `add_labels`/`remove_labels` delta params (avoids clobbering non-maestro
  labels). Mutual exclusion relies on scoped-label semantics; do not hand-roll it.

### Slice 9 — `commentIssue` / `commentMR`
- **Test** `commentIssue posts a note`: `POST /projects/:id/issues/:iid/notes {body}`.
- **Test** `commentMR posts a note`: `POST /projects/:id/merge_requests/:iid/notes {body}`.
- **Impl:** two thin POSTs. (Idempotency is not required for comments — appends by
  design, §9 append-only log.)

### Slice 10 — `ensureLabels` (idempotent create-missing)
- **Test** `ensureLabels creates only missing scoped labels`: fixture `project-labels.json`
  already contains `maestro::in-progress`; call with all of `LabelNames.all()`; assert
  POST `/projects/:id/labels` fires **only** for the absent ones, color/scoped name
  correct, existing ones untouched.
- **Test** `ensureLabels is fully idempotent`: all present → zero POSTs.
- **Impl:** GET existing labels → diff against requested `Label[]` by name → POST gaps.

### Slice 11 — `ensureBoard` (§11 GitLab Free-tier board automation)
- **Test** `ensureBoard creates board when none and adds lists ordered by lifecycle`:
  fixtures `boards-empty.json` then post-create board id. Call with the ordered
  `LabelNames.all()`. Assert **strict order** via `FakeExec` call log:
  1. (labels already ensured by `ensureLabels`; `ensureBoard` may re-resolve label ids
     via `GET /projects/:id/labels`),
  2. `GET /projects/:id/boards` → empty → `POST /projects/:id/boards`,
  3. `POST /projects/:id/boards/:board_id/lists` once per label, **in lifecycle order**
     (`inProgress`, `inReview`, `blocked` per `LabelNames.all()`), each with the
     resolved `label_id`.
- **Test** `ensureBoard reuses the single existing Free-tier board and skips existing
  lists`: `boards` non-empty + some lists present → no `POST /boards`, lists POSTed only
  for missing labels, no duplicate lists (idempotent).
- **Test** `ensureBoard is the GitLab-only method` — present and callable on
  `GitlabAdapter`; (M7 leaves it `undefined`). No assertion of GitHub here.
- **Impl:** label-id resolution → board get-or-create (honor Free-tier single-board:
  use `boards[0]` if any) → list get-or-create per label in order. Respect
  `manage_board:false` upstream (caller skips; adapter still safe if called).

### Slice 12 — `createIssue` (bootstrap, §16; idempotent-ish)
- **Test** `createIssue opens an issue assigned to bot`: assert
  `POST /projects/:id/issues {title, description, assignee_ids:[botId]}` when
  `assignToBot`; returns normalized `Issue`.
- **Impl:** resolve bot id when assigning, POST, normalize. (No dedupe required by
  contract; bootstrap caller guards against duplicates — note this, do not invent a
  dedupe key.)

### Slice 13 — `ApprovalState` normalization (native GitLab MR approval)
- **Test** `approved MR → ApprovalState.approved=true with approvedBy`: fixture
  `GET /projects/:id/merge_requests/:iid/approvals` (or `approval_state`) showing
  required approvals met → `approved:true`, `approvedBy` populated as `ForgeUser[]`.
- **Test** `MR with no approvals → approved=false`.
- **Impl:** fold the approvals endpoint into `normalizeMergeRequest` / `getSnapshot`;
  `approved` = required approvals satisfied (native GitLab MR approval, per spec §2/§7).

### Slice 14 — `changesRequested` edge-trigger (§0.3, the subtle one)
- **Test** `unapprove/blocking-thread AFTER last bot push → changesRequested=true`:
  fixtures for (a) the newest change-request signal — an explicit **unapprove** event
  (`GET .../approvals` flipping, or resource events) OR an unresolved discussion opened
  after the last bot push (`GET .../discussions`), and (b) `commits-source-branch.json`
  giving the newest **bot-authored** commit timestamp. When the signal post-dates the
  bot commit → `changesRequested:true`.
- **Test** `feedback OLDER than last bot push → changesRequested=false (already
  addressed)`: same shapes but bot commit newer than the change-request signal → `false`.
  This is the idempotency guard that stops re-triggering `in-review → in-progress` on
  feedback the agent already handled.
- **Test** `approved with no later change-request → changesRequested=false`.
- **Impl:** in approval normalization, compute `changesRequestedSince` = max timestamp of
  {explicit unapprove event, unresolved discussion opened by a non-bot after lastBotPush};
  `lastBotPush` = max committed_date among source-branch commits authored by `bot_user`;
  `changesRequested = changesRequestedSince > lastBotPush`. Bot-authored detection keys
  on commit author/committer == bot identity (resolved once via the bot user). Document
  the exact GitLab endpoints chosen. **This logic is the reference M7 mirrors.**

### Slice 15 — `lastActor` capture (trigger guard, §13.1)
- **Test** `Issue.lastActor reflects the most recent assignment/label-add actor`:
  fixture `issue-resource-events.json` (resource label events + assignment events,
  `GET /projects/:id/issues/:iid/resource_label_events` and
  `.../resource_state_events`/assignment notes). Assert `lastActor` = the `user` of the
  most recent relevant event, as `ForgeUser`.
- **Test** `no event data → lastActor undefined` (optional field; reconciler treats
  empty `allowedActors` as no restriction, §0.4 rule 1).
- **Impl:** fold a resource-events read into `normalizeIssue` for snapshot paths (not
  necessarily for the bulk `listAssignedOpenIssues` — note the cost tradeoff: fetch
  lastActor in `getSnapshot` where the guard actually runs, keep the list call cheap).

### Slice 16 — Error mapping + token-safety unit
- **Test** `non-zero Exec code throws ForgeError carrying stderr but NOT the token`:
  give `FakeExec` a failing call whose `opts.env` held the token; assert the thrown
  error message/`stderr` contains no token substring.
- **Test** `404 path is not an error for getIssueState` (cross-check Slice 3).
- **Impl:** centralized error mapper in `api()`; ensure no `args`/error path ever
  interpolates the secret.

---

## Exit gate (checklist)

- [ ] `GitlabAdapter` **satisfies the M0 `ForgeAdapter` interface** verbatim (compiles
      against `contracts/forge-adapter.ts`; `kind:'gitlab'`; `ensureBoard` defined).
- [ ] All 15 methods implemented; every mutation has an idempotency test (re-call →
      no-op / returns existing).
- [ ] Normalization tests green for `Issue`, `MergeRequest` (incl. `isDraft` from
      `work_in_progress`/`Draft:`), `ApprovalState` (incl. edge-triggered
      `changesRequested`), `Comment`, `IssueSnapshot`, `lastActor`.
- [ ] §11 board automation test proves order: ensure labels → board get-or-create →
      lists in `LabelNames.all()` lifecycle order; Free-tier single-board respected;
      idempotent on re-run.
- [ ] `changesRequested` edge-trigger proven both directions (after-push = true,
      before-push = false).
- [ ] Token-safety test: token only ever in `ExecOptions.env`, never in `argv` or any
      thrown error.
- [ ] No default-path test touches gitlab.com; integration tier runs green against the
      scratch project when `MAESTRO_GITLAB_IT=1`.
- [ ] **Reconcile → adapter dry run on a scratch project:** wire reconciler (M1, if
      available) over a real `getSnapshot` of a freshly bot-assigned, label-less issue;
      assert it drives **New → in-progress** (branch + draft MR + `maestro::in-progress`
      + "started" comment) on the scratch project, then revert. (If M1 not yet merged,
      gate this as an integration smoke that calls the adapter sequence directly and is
      explicitly the M5 wiring's acceptance.)
- [ ] `pnpm -r typecheck && pnpm -r test && pnpm lint` clean.

---

## Cross-cutting (QA + Security)

- **Token via env only.** The scoped bot token is read from `process.env[token_env]`
  at the adapter edge and passed solely through `ExecOptions.env` to `glab` (§0.8).
  **Never** on `argv`, never logged, never in a thrown error. Slice 0 + Slice 16
  assert this; it is a hard gate.
- **Host / path validation.** `RepoRef.host` and `project` are validated before use:
  host must match the configured GitLab host (no SSRF to an arbitrary host via a
  crafted `RepoRef`); `project` is URL-encoded for the `:id` path segment; reject
  shell-meta in project/branch names before they reach `glab` args (defense even though
  `Exec` uses argv-array, not a shell string).
- **Untrusted issue body (§13.1).** The adapter only *transports* `issue.body` into the
  §0.2 model; it neither executes nor interpolates it into commands. Prompt-injection
  defense is the runner/permission-mode concern (M4) — noted, not solved here.
- **QA.** Unit tier hermetic (FakeExec + frozen fixtures) in `pnpm -r test`; integration
  tier opt-in (`MAESTRO_GITLAB_IT`) for the scratch-project suite that also re-captures
  fixtures, keeping unit fixtures faithful to live GitLab.

---

## Open dependencies

- **Concrete `Exec` implementation ownership.** §0.8 declares the `Exec` interface and
  says "the real impl wraps `node:child_process` (M2/M3)." *Gap:* it's ambiguous whether
  M2 or M3 lands the concrete wrapper. *Why it blocks:* the integration tier and the
  exit-gate dry run need a real `Exec`. *Proposed resolution:* M2 ships the minimal
  `NodeExec` (argv-array `child_process.spawn`, env injection, no shell) since M2 is the
  first consumer; M3 reuses it. No contract change — only an ownership note. Confirm before build.

- **Bot identity resolution for `changesRequested` / `lastActor`.** §0.3 specifies the
  edge-trigger semantics but the contract carries no bot-user id; `RepoSettings.botUser`
  (a username) lives in §0.4, not in the `ForgeAdapter` method signatures. *Why it
  blocks:* "bot-authored commit" and "actor on allowlist" need the bot's identity, and
  no §0.3 method takes it as a parameter. *Proposed resolution:* the bot username is
  adapter **construction config** (passed to `new GitlabAdapter(exec, { botUser, host,
  token, ... })`), not a per-call arg — consistent with §0.8 token handling at the edge.
  This is an adapter-constructor detail outside the frozen method surface, so **not** a
  contract change; flagging only to confirm the constructor shape is acceptable. If a
  reviewer wants it on `RepoRef`/`RepoSettings` plumbed per call, that *would* be a §0.2
  change-log entry — do not do this without sign-off.

- **GitLab draft mechanism portability.** Spec/contract say "draft MR" but don't pin the
  GitLab mechanism (`work_in_progress` boolean vs `Draft:` title prefix vs the newer
  `/draft` quick-action). *Why it matters:* idempotent `setDraft` must read and write the
  same signal. *Proposed resolution (no contract impact):* normalize-read from
  `work_in_progress`/`draft` field; write via `Draft:` title-prefix toggle (most
  Free-tier/version-portable). Documented in Slice 5/6; confirm if the target GitLab
  version warrants the API boolean instead.
