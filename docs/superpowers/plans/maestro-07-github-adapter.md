# Maestro — M7: GitHub Forge Adapter (second forge)

- **Source of truth:** `docs/superpowers/specs/2026-06-03-maestro-design.md` (locked)
- **Frozen contracts:** `docs/superpowers/plans/maestro-00-scaffolding-and-contracts.md`
  — §0.2 model, §0.3 `ForgeAdapter`, §0.7 labels, §0.8 `Exec` seam. Implement those
  shapes **verbatim**; never redefine them.
- **Reference adapter:** `docs/superpowers/plans/maestro-02-gitlab-adapter.md` — the
  settled behaviour this milestone mirrors. Where a shared concern was resolved there
  (draft mechanism, `changesRequested` edge-trigger, `botUser`-on-constructor), this
  plan **mirrors** it rather than re-choosing.
- **Depends on:** M0 (contracts), M2 (reference adapter behaviour).
- **Decisions in force:** GitHub is the **second** forge, built against the now-settled
  §0.3 surface. All subprocess/network I/O flows through the injected `Exec` seam (§0.8).
  GitHub diverges on three things and three only: (1) **flat** labels `maestro:*` with
  mutual exclusion **enforced in the adapter** (GitLab got it free from scoped labels);
  (2) approval/changes-requested derive from **PR reviews** (`APPROVED` /
  `CHANGES_REQUESTED`) per the §0.3 edge-trigger M2 settled; (3) `ensureBoard` is left
  **undefined** (labels only; Projects V2 deferred §11/§17). MR≡PR throughout.

---

## Goal

Implement `ForgeAdapter` (§0.3) for GitHub using `gh` + GitHub REST/GraphQL, every call
routed through the injected `Exec` seam (§0.8). The adapter normalizes GitHub payloads
into the **same** §0.2 model M2 produces, so the reconciler and daemon require **zero**
changes to drive GitHub. That zero-change property is the proof the abstraction held —
it is the headline of the exit gate. The adapter is idempotent per §13 (re-create
no-ops or returns existing) and implements §11 labels-only setup for GitHub.

---

## Scope

**In:**
- `class GithubAdapter implements ForgeAdapter` in `packages/core/src/forge/github/`,
  `kind = 'github'`, constructed with an injected `Exec` and the same construction
  config M2 settled: `new GithubAdapter(exec, { botUser, host, token, ... })`
  (`botUser` on the constructor — mirrors M2 Open-dependency resolution, not a per-call
  arg, not a contract change).
- The 14 **defined** interface methods (§0.3): `listAssignedOpenIssues`, `getSnapshot`,
  `getIssueState`, `createBranch`, `createDraftMR`, `updateMRDescription`, `setDraft`,
  `assignMR`, `mergeMR`, `setIssueLabels`, `commentIssue`, `commentMR`, `ensureLabels`,
  `createIssue`. **`ensureBoard` is left `undefined`** (optional in §0.3; GitHub gets
  labels only).
- Normalization of GitHub JSON → §0.2 `Issue` / `MergeRequest` / `ApprovalState` /
  `Comment` / `IssueSnapshot` / `ForgeUser` / `Label`. PR≡MR mapping throughout;
  `closesIssueIid` parsed from PR body `Closes #N`.
- **Flat-label mutual exclusion** enforced in `setIssueLabels`: setting one `maestro:*`
  label unsets the sibling `maestro:*` labels (GitHub has no scoped-label semantics).
- **Review-state** `ApprovalState`: `approved` from a PR review with state `APPROVED`
  not superseded by a later `CHANGES_REQUESTED`; `changesRequested` edge-triggered per
  §0.3 (latest `CHANGES_REQUESTED` review post-dating the last bot commit).
- `lastActor` capture from issue timeline events for the trigger guard (§13.1).
- Idempotency for every mutation; **label-by-name addressing** throughout (GitHub
  addresses labels by name, not id — §0.2 `Label.id` stays optional/unset).
- §11 GitHub setup: `ensureLabels` creates missing flat labels via `gh`/REST; **no
  board automation**.

**Out (other milestones / deferred):**
- Reconciler logic (M1), workspace/clone auth (M3), runner (M4/§0.9), daemon loop +
  cleanup sweep wiring (M5), GitLab adapter (M2).
- **Projects V2 board automation — explicitly deferred (§11 / §17).** GitHub repos get
  labels only in v1. `ensureBoard` is intentionally absent on `GithubAdapter`; the
  daemon already treats it as optional (`ensureBoard?` in §0.3). No GraphQL Projects-V2
  mutation in this milestone.
- Concrete `Exec`-over-`child_process` impl — M2 ships `NodeExec` (see Open
  dependencies); M7 only *consumes* the seam.

---

## Testing strategy — adapter tests without touching github.com (mirrors M2 tiers)

**Unit tier (default, hermetic).** Inject a **fake `Exec`** (`FakeExec`, the same
helper M2 introduced) implementing §0.8: a programmable transcript matcher keyed on
`(cmd, args-shape)`, returning a recorded `ExecResult { code, stdout, stderr }`. The
adapter issues `gh api ...` (REST) and `gh api graphql ...` calls, so almost every
fake response is a captured GitHub JSON body on `stdout`. Tests assert two things:
**(a) the command** the adapter built (binary, subcommand, flags, request
path/body — including that the token rides in `ExecOptions.env`, never `argv`), and
**(b) the normalization** of returned JSON into the §0.2 model.

`FakeExec` records every call so a test can assert call **count** (idempotency: second
`createDraftMR` makes zero create calls) and **order** (e.g. `setIssueLabels` removes
siblings then adds the new label).

**Fixture shape.** One file per GitHub response under
`packages/core/src/forge/github/__fixtures__/`, named by API:
`issues-assigned.json`, `pr-draft.json`, `pr-ready.json`,
`reviews-approved.json`, `reviews-changes-requested.json`,
`issue-labels.json`, `repo-labels.json`, `issue-comments.json`, `pr-comments.json`,
`pr-commits.json`, `issue-timeline.json`, `pr-for-branch.json`, etc. Each is
**verbatim GitHub REST/GraphQL JSON** (captured once from a real repo, then frozen).
Reuse M2's `loadFixture(name)` helper and the `FakeExec` request-matcher builder so a
test reads as `onApi('GET', '/repos/:owner/:repo/issues', issuesFixture)`.

**Integration tier (§15, opt-in, gated env var `MAESTRO_GITHUB_IT=1`).** Run the
**same** suite against a **throwaway scratch GitHub repo** owned by a test bot, using
the real `Exec`. Tests create unique-named issues/PRs/labels (run-id suffixed), assert
against live responses, and tear down. CI default skips this tier; it runs on
demand / nightly. The recorded fixtures are *captured* from one blessed run of this
tier, keeping unit fixtures faithful. This tier is also the source for the exit-gate
E2E dry run.

**No test in M7 hits github.com in the default `pnpm -r test` path.**

---

## TDD slices

Each slice: write the named failing test (command + normalization assertions) first,
then the impl. All slices use `FakeExec`. Slices for methods **identical in shape** to
M2 stay brief and point at the M2 normalization contract; slices where GitHub
**diverges** carry the full assertions.

### Slice 0 — Adapter skeleton + REST/GraphQL call helper
- **Test** `github adapter exposes kind 'github' and routes a GET through Exec with
  token in env not argv`: construct `new GithubAdapter(fakeExec, { botUser, token, host, ... })`;
  invoke the internal `api()` helper for a trivial `GET /` (or `/rate_limit`); assert
  `fakeExec` saw `gh api` with the path in args, `opts.env` carrying the token under
  `GH_TOKEN` (gh's documented env var), and **no token substring anywhere in `args`**.
- **Impl:** private `api(method, path, body?)` and `graphql(query, vars)` helpers that
  build `gh api` invocations (`gh api --method <M> <path> -f/-F …`, `gh api graphql -f
  query=…`), set `ExecOptions.env` (`GH_TOKEN` from the injected token; `GH_HOST` for
  self-hosted/GHE), parse `stdout` as JSON, throw a typed `ForgeError` on non-zero
  `code` (carrying `stderr`, never the token). Pagination helper (`--paginate` /
  `gh api` link-following). **Mirror M2 Slice 0 exactly; only the binary (`gh`), token
  env var (`GH_TOKEN`), and path scheme (`/repos/:owner/:repo/...`) differ.**

### Slice 1 — `listAssignedOpenIssues` (discovery)
- **Test** `assigned open issues normalize to Issue[] with labels as names and author`:
  `FakeExec` returns `issues-assigned.json` for
  `GET /repos/:owner/:repo/issues?assignee=<bot>&state=open`; assert each `Issue` has
  `iid` (GitHub `number`), `id` (stringified `node_id` or `id`), `state:'open'`,
  `labels` as plain names, `assignees`/`author` (`user`) as `ForgeUser{username,id}`,
  `webUrl` (`html_url`). Assert the query filters by `assignee = botUser` and
  `state=open`.
- **Divergence note (assert):** GitHub's `/issues` list **includes pull requests**
  (every PR is an issue). The adapter must **drop entries carrying `pull_request`** so
  only true issues are returned. Add a fixture entry that is a PR and assert it is
  excluded.
- **Impl:** build request, paginate, filter out `pull_request` entries, map JSON →
  `Issue` via a shared `normalizeIssue()`. (Shape otherwise per M2 Slice 1.)

### Slice 2 — `getSnapshot` (issue + maestro PR + recent comments)
- **Test** `getSnapshot assembles issue, its maestro PR, and newest-first capped comments`:
  fixtures for the issue, the maestro PR, and issue comments. The maestro PR is the
  open PR whose **head branch matches the maestro branch convention** and/or whose body
  `Closes #N` references this issue. Assert `IssueSnapshot.mr` is that PR,
  `recentComments` newest-first and bounded (cap, e.g. 50), `closesIssueIid` resolved
  from the PR body (`Closes #N` regex).
- **Test** `getSnapshot with no PR yet → snapshot.mr undefined` (the New state).
- **Impl:** `normalizeMergeRequest()` (from PR JSON), `normalizeComment()`, PR-selection
  (prefer the open PR for the maestro head branch; resolve `closesIssueIid` from body),
  comment cap + sort. **Selection logic and `closesIssueIid`-from-body mirror M2 Slice
  2; only the source is a GitHub PR + `Closes #N` body parse.** PR lookup uses
  `GET /repos/:owner/:repo/pulls?head=:owner::branch&state=open` (or list-by-issue via
  timeline cross-references).

### Slice 3 — `getIssueState` (cleanup sweep support, §0.5)
- **Test** `getIssueState returns 'open' | 'closed' | 'missing'`: three fixtures —
  open issue, closed issue, and a 404 (`code != 0` / 404 body) → `'missing'`.
- **Impl:** `GET /repos/:owner/:repo/issues/:number`; map `state`; 404 → `'missing'`
  (must **not** throw; distinguish 404 from other errors). **Identical in shape to M2
  Slice 3.**

### Slice 4 — `createBranch` (idempotent)
- **Test** `createBranch creates from ref`: resolve `fromRef` → its commit sha
  (`GET /repos/:o/:r/git/ref/heads/:fromRef`), then
  `POST /repos/:o/:r/git/refs { ref: 'refs/heads/<name>', sha }`.
- **Test** `createBranch is idempotent when branch exists`: POST returns the
  "Reference already exists" 422 → adapter no-ops (resolves), does **not** throw.
- **Impl:** resolve base sha, POST git ref; on the known "exists" 422, swallow and
  return. (GitHub needs the explicit sha-resolution step GitLab did not; otherwise
  same idempotency contract as M2 Slice 4.)

### Slice 5 — `createDraftMR` (idempotent, returns existing)
- **Test** `createDraftMR opens a draft PR with Closes #N and bot assignee`: assert
  `POST /repos/:o/:r/pulls` body has `head`, `base`, `title`, `body` containing
  `Closes #N`, and **`draft: true`**. Returns a normalized `MergeRequest` with
  `isDraft:true`. Bot assignment: PRs assign via the **issues** endpoint
  (`POST /repos/:o/:r/issues/:prNumber/assignees { assignees:[bot] }`) when
  `assignToBot` — assert that follow-up call.
- **Test** `createDraftMR is idempotent — existing PR for head branch is returned, no
  second create`: `FakeExec` first returns an existing open PR on
  `GET /repos/:o/:r/pulls?head=:owner::branch&state=open`; assert **zero** create POSTs
  and the existing PR returned.
- **Normalization assertion** `GitHub PR JSON with draft=true → MergeRequest.isDraft=true`;
  PR `state` + `merged` map to §0.2 `'opened'|'merged'|'closed'` (open→`opened`;
  `merged_at`/`merged:true`→`merged`; closed-unmerged→`closed`).
- **Divergence note:** GitHub draft is a **native `draft` boolean** on PR create — no
  title-prefix hack (contrast M2's `Draft:` prefix). This is the GitHub-native draft
  mechanism; M2 resolved the *portable* mechanism for GitLab, GitHub uses its own.
- **Impl:** lookup-then-create; pass `draft:true`; assign bot via issues endpoint; map
  `draft` → `isDraft`, `state`/`merged` → §0.2 state.

### Slice 6 — `updateMRDescription` / `setDraft` / `assignMR`
- **Test** `updateMRDescription PATCHes body`: `PATCH /repos/:o/:r/pulls/:number { body }`.
- **Test** `setDraft(false) marks PR ready, setDraft(true) converts to draft`: GitHub
  toggles draft via **GraphQL** (`markPullRequestReadyForReview` /
  `convertPullRequestToDraft`) — REST has no draft toggle. Assert the GraphQL mutation
  with the PR node id. **Divergence:** draft-toggle mechanism differs from M2 (title
  prefix); the §0.2 `isDraft` read still maps from the REST `draft` boolean.
- **Test** `setDraft is idempotent`: PR already in target draft-state → no mutation.
- **Test** `assignMR assigns the reviewer by username`: handoff assigns the ticket
  creator. Assert `POST /repos/:o/:r/issues/:prNumber/assignees { assignees:[username] }`
  (PR assignees use the issues endpoint). Idempotent if already assigned. **Username is
  used directly — no username→id resolution needed (GitHub addresses users by login),
  a simplification over M2 Slice 6.**
- **Impl:** PATCH body; GraphQL draft toggle (needs PR `node_id` — fetch once); assignees
  POST. Mirror M2 Slice 6 semantics; only mechanisms differ as noted.

### Slice 7 — `mergeMR` (strategy + delete source, idempotent)
- **Test** `mergeMR squash deletes source branch`: assert
  `PUT /repos/:o/:r/pulls/:number/merge { merge_method:'squash' }`, then delete the head
  ref (`DELETE /repos/:o/:r/git/refs/heads/<headBranch>`) when `deleteSource`. Strategy
  map: `squash`→`merge_method:'squash'`, `merge`→`'merge'`, `rebase`→`'rebase'`
  (document this mapping — it is **cleaner than GitLab's**; GitHub has all three
  natively).
- **Test** `mergeMR is idempotent — already-merged PR no-ops`: fixture PR `merged:true`
  → adapter detects and returns without re-merging (and skips ref delete if already
  gone).
- **Impl:** pre-check `merged`, PUT merge with mapped `merge_method`, optional ref
  delete. Same idempotency contract as M2 Slice 7.

### Slice 8 — `setIssueLabels` (FLAT mutual exclusion — THE key divergence)
- **Test** `setIssueLabels removes sibling maestro:* labels when setting one`: issue
  currently carries `maestro:in-progress`; call `setIssueLabels(set:['maestro:in-review'],
  unset:[])`. Assert the adapter (a) **removes** every *other* `maestro:*` label present
  on the issue — including ones the caller did **not** list in `unset` — via
  `DELETE /repos/:o/:r/issues/:n/labels/maestro:in-progress` (URL-encoded), and (b)
  **adds** `maestro:in-review` via `POST /repos/:o/:r/issues/:n/labels { labels:[…] }`.
  This is the behaviour GitLab got free from scoped labels (M2 Slice 8 explicitly noted
  "M7 must unset manually"). Assert **non-maestro labels are left untouched.**
- **Test** `setIssueLabels honors explicit unset too`: labels in the `unset` arg are
  removed even if not `maestro:*`.
- **Test** `setIssueLabels is idempotent`: setting the label already present, with no
  other `maestro:*` siblings → no add POST, no delete (or harmless no-op) — assert zero
  mutating calls.
- **Impl:** read current issue labels (from the snapshot's issue or a
  `GET /repos/:o/:r/issues/:n/labels`); compute `toRemove = (existing ∩ maestro:* \ set)
  ∪ unset`; DELETE each `toRemove` by **name** (URL-encoded, single colon); POST `set`
  not already present. **Mutual exclusion is enforced here, not in the reconciler
  (§0.7).** The maestro-namespace prefix comes from `labelNames('github')` (§0.7,
  `maestro:` single colon).

### Slice 9 — `commentIssue` / `commentMR`
- **Test** `commentIssue posts a comment`: `POST /repos/:o/:r/issues/:n/comments { body }`.
- **Test** `commentMR posts a comment`: PR comments use the **issues** endpoint —
  `POST /repos/:o/:r/issues/:prNumber/comments { body }` (an issue-comment on the PR,
  not a review comment). Assert that path.
- **Impl:** two thin POSTs (both via the issues-comments endpoint; PR number ≡ issue
  number on GitHub). Append-only, no idempotency required (§9). Identical intent to M2
  Slice 9; only the unified endpoint differs.

### Slice 10 — `ensureLabels` (idempotent create-missing, flat names)
- **Test** `ensureLabels creates only missing flat labels`: fixture `repo-labels.json`
  already contains `maestro:in-progress`; call with all of `labelNames('github').all()`;
  assert `POST /repos/:o/:r/labels { name, color }` fires **only** for absent ones, flat
  `maestro:*` names correct, existing ones untouched.
- **Test** `ensureLabels is fully idempotent`: all present → zero POSTs.
- **Impl:** `GET /repos/:o/:r/labels` (paginated) → diff against requested `Label[]` by
  **name** → POST gaps. Same shape as M2 Slice 10; labels are flat and addressed by
  name (no id needed).

### Slice 11 — `ensureBoard` is **undefined / no-op** (Projects V2 deferred)
- **Test** `GithubAdapter does not implement ensureBoard`: assert
  `(adapter as ForgeAdapter).ensureBoard === undefined` (the property is absent on the
  instance). This is the GitHub-specific divergence from M2 Slice 11 — GitHub gets
  labels only.
- **Test** `daemon-style setup against GithubAdapter calls ensureLabels but never
  ensureBoard`: a tiny harness that runs the onboarding setup sequence with the §0.3
  optional-call pattern (`adapter.ensureBoard?.(…)`) and asserts, via `FakeExec`, that
  **no boards/Projects API call is made** and `ensureLabels` did run.
- **Impl:** simply **do not define** `ensureBoard` on `GithubAdapter` (it is `ensureBoard?`
  optional in §0.3). No Projects V2 GraphQL. Caller already guards with `?.` — proving
  the daemon needs zero GitHub-specific branching.

### Slice 12 — `createIssue` (bootstrap, §16)
- **Test** `createIssue opens an issue assigned to bot`: assert
  `POST /repos/:o/:r/issues { title, body, assignees:[botUser] }` when `assignToBot`;
  returns normalized `Issue`. **Bot assigned by login directly** (no id resolution).
- **Impl:** POST with `assignees:[botUser]` when assigning, normalize. No dedupe
  (bootstrap caller guards — same note as M2 Slice 12).

### Slice 13 — `ApprovalState` from PR reviews (APPROVED)
- **Test** `PR with an APPROVED review → ApprovalState.approved=true with approvedBy`:
  fixture `GET /repos/:o/:r/pulls/:n/reviews` containing a review `state:'APPROVED'`;
  assert `approved:true`, `approvedBy` populated as `ForgeUser[]` (the approving
  reviewers).
- **Test** `PR with no reviews → approved=false`.
- **Test** `APPROVED later superseded by CHANGES_REQUESTED from same reviewer →
  approved=false` (latest review state per reviewer wins — §0.2 `ApprovalState`
  comment: "a review with state APPROVED exists and none later request changes").
- **Impl:** fetch reviews, reduce to **latest review state per reviewer** (by
  `submitted_at`); `approved` = at least one reviewer's latest state is `APPROVED` and
  no reviewer's latest is `CHANGES_REQUESTED`. Fold into `normalizeMergeRequest` /
  `getSnapshot`. **This is the GitHub realization of M2 Slice 13's `approved`
  semantics — same §0.2 output shape.**

### Slice 14 — `changesRequested` edge-trigger (§0.3, mirrors M2 Slice 14)
- **Test** `CHANGES_REQUESTED review AFTER last bot push → changesRequested=true`:
  fixtures for (a) `GET /repos/:o/:r/pulls/:n/reviews` with the **latest** review state
  `CHANGES_REQUESTED` and its `submitted_at`, and (b) `pr-commits.json`
  (`GET /repos/:o/:r/pulls/:n/commits`) giving the newest **bot-authored** commit
  timestamp. When the review post-dates the bot commit → `changesRequested:true`.
- **Test** `CHANGES_REQUESTED OLDER than last bot push → changesRequested=false
  (already addressed)`: same shapes, bot commit newer than the review → `false`. This
  is the idempotency guard that stops re-triggering `in-review → in-progress` on
  feedback the agent already handled.
- **Test** `approved with no later change-request → changesRequested=false`.
- **Impl:** mirror **M2 Slice 14 verbatim in semantics** — the §0.3 edge-trigger M2
  settled. `changesRequestedSince` = `submitted_at` of the newest review whose
  **latest-per-reviewer** state is `CHANGES_REQUESTED`; `lastBotPush` = max commit
  `committer.date` (or author date) among PR commits authored by `botUser`;
  `changesRequested = changesRequestedSince > lastBotPush`. Bot-authored detection keys
  on commit `author`/`committer` login (or email) == bot identity, resolved once from
  the constructor `botUser`. Document the exact GitHub endpoints. **This logic mirrors
  the M2 reference; only the signal source (GitHub reviews vs GitLab unapprove/discussion)
  differs.**

### Slice 15 — `lastActor` capture (trigger guard, §13.1)
- **Test** `Issue.lastActor reflects the most recent assignment/label-add actor`:
  fixture `issue-timeline.json` (`GET /repos/:o/:r/issues/:n/timeline`, preview accept
  header if needed) containing `assigned` / `labeled` events; assert `lastActor` = the
  `actor` of the most recent relevant event, as `ForgeUser`.
- **Test** `no event data → lastActor undefined` (optional field; reconciler treats
  empty `allowedActors` as no restriction, §0.4 rule 1).
- **Impl:** fold a timeline read into `normalizeIssue` for **snapshot** paths only
  (not the bulk `listAssignedOpenIssues` — keep the list call cheap; fetch `lastActor`
  in `getSnapshot` where the guard actually runs). **Same cost tradeoff M2 Slice 15
  made.**

### Slice 16 — Error mapping + token-safety unit
- **Test** `non-zero Exec code throws ForgeError carrying stderr but NOT the token`:
  give `FakeExec` a failing call whose `opts.env` held the token; assert the thrown
  error contains no token substring.
- **Test** `404 path is not an error for getIssueState` (cross-check Slice 3).
- **Impl:** centralized error mapper in `api()`; never interpolate the secret into
  `args` or error paths. **Identical to M2 Slice 16; `GH_TOKEN` is the env key.**

---

## Exit gate (checklist)

**Headline:** **reconciler + daemon run unchanged against a GitHub repo — New→Done E2E
on a scratch GitHub repo.** Zero reconciler/daemon edits is the proof the §0.3
abstraction held.

- [ ] `GithubAdapter` **satisfies the M0 `ForgeAdapter` interface** verbatim (compiles
      against `contracts/forge-adapter.ts`; `kind:'github'`; `ensureBoard` **undefined**).
- [ ] All 14 defined methods implemented; every mutation has an idempotency test
      (re-call → no-op / returns existing). `ensureBoard` proven absent (Slice 11).
- [ ] Normalization tests green for `Issue` (PRs filtered out of the issue list),
      `MergeRequest` (incl. `isDraft` from `draft`, `closesIssueIid` from `Closes #N`),
      `ApprovalState` (APPROVED, supersession, edge-triggered `changesRequested`),
      `Comment`, `IssueSnapshot`, `lastActor`.
- [ ] **Flat-label mutual exclusion proven:** `setIssueLabels` removes sibling
      `maestro:*` labels when setting one, leaves non-maestro labels untouched (Slice 8).
- [ ] `changesRequested` edge-trigger proven both directions (after-push = true,
      before-push = false), matching M2's reference behaviour.
- [ ] Token-safety test: token only ever in `ExecOptions.env` (`GH_TOKEN`), never in
      `argv` or any thrown error.
- [ ] No default-path test touches github.com; integration tier runs green against the
      scratch repo when `MAESTRO_GITHUB_IT=1`.
- [ ] **Reconciler + daemon unchanged — E2E on a scratch GitHub repo:** point the M5
      daemon (config a GitHub repo) at a freshly bot-assigned, label-less issue with
      **zero source changes to the reconciler or daemon**; assert it drives the full
      lifecycle **New → in-progress → handoff (proof + assign + un-draft) → in-review →
      merge → Done** (issue auto-closes via `Closes #N`; workspace evicted by the
      cleanup sweep). If M5 is not yet merged, gate as an integration smoke that wires
      `reconcile()` over a real GitHub `getSnapshot` and replays the action sequence
      directly, and mark it as the M5 GitHub-wiring acceptance.
- [ ] `pnpm -r typecheck && pnpm -r test && pnpm lint` clean.

---

## Cross-cutting (QA + Security)

- **Token via env only.** The scoped bot token is read from `process.env[token_env]`
  at the adapter edge and passed solely through `ExecOptions.env` (`GH_TOKEN`) to `gh`
  (§0.8). **Never** on `argv`, never logged, never in a thrown error. Slice 0 + Slice
  16 assert this; it is a hard gate. Scope the bot token to the minimum (issues, PRs,
  contents, labels) — a fine-grained PAT or GitHub App installation token.
- **Host / path validation.** `RepoRef.host` and `project` are validated before use:
  host must match the configured GitHub host (no SSRF to an arbitrary host via a crafted
  `RepoRef`; set `GH_HOST` for GHE); `:owner`/`:repo` URL-encoded into the path; reject
  shell-meta in owner/repo/branch names before they reach `gh` args (defense even though
  `Exec` uses argv-array, not a shell string). Label names are URL-encoded for the
  `DELETE .../labels/<name>` path (the single colon in `maestro:*` must encode safely).
- **Untrusted issue body — prompt injection (§13.1) is forge-agnostic.** ⚠️ On public
  repos the issue/comment text is attacker-controlled and the agent acts on it with the
  bot's credentials — **this risk is identical on GitHub and GitLab**; the adapter only
  *transports* `issue.body` into the §0.2 model, neither executing nor interpolating it
  into commands. The real mitigation is the runner/permission-mode + container isolation
  (M4 / deferred §17), not the adapter. **Public-repo support is explicit opt-in** per
  §13.1; note it, do not solve it here.
- **QA.** Unit tier hermetic (FakeExec + frozen fixtures) in `pnpm -r test`; integration
  tier opt-in (`MAESTRO_GITHUB_IT`) for the scratch-repo suite that also re-captures
  fixtures, keeping unit fixtures faithful to live GitHub. Mirrors M2's two-tier QA.

---

## Open dependencies

- **Concrete `Exec` implementation ownership (inherited from M2, not re-opened).** §0.8
  says "the real impl wraps `node:child_process` (M2/M3)"; M2's Open-dependencies
  resolved this by having M2 ship the minimal `NodeExec`. M7 **reuses** that `NodeExec`
  for its integration tier. *No new gap* — flagged only so the integration tier and E2E
  dry run assume `NodeExec` exists from M2. Confirm M2 landed it.

- **`botUser` on the adapter constructor (mirrors M2 resolution).** The §0.3 method
  surface carries no bot identity, but `changesRequested` (bot-authored commit
  detection) and bot-assignment need it. M2 resolved this by passing `botUser` as
  **adapter construction config** (`new GithubAdapter(exec, { botUser, host, token, … })`),
  outside the frozen method surface — **not** a contract change. M7 mirrors that exact
  resolution. Flagging only to confirm the constructor shape is accepted, consistent
  with M2.

- **`ensureBoard` optionality already in the frozen contract — no change needed.** §0.3
  declares `ensureBoard?` optional; GitHub leaving it `undefined` is contract-compliant
  by construction. The daemon must call it as `adapter.ensureBoard?.(…)`. *Confirm the
  M5 daemon uses the optional-call form* so GitHub needs no special-casing — that is the
  zero-change proof. No §0.8 / §0.2 / §0.3 amendment required by M7.

*(No new contract types invented; no §0.3 surface redefined; no §0.10 change-log entry
required by this milestone.)*
