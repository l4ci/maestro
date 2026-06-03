# Maestro — M1: Reconciler & Loaders

- **Milestone:** M1 — Reconciler & Loaders
- **Source of truth:** `docs/superpowers/specs/2026-06-03-maestro-design.md` (locked spec §5, §6, §7, §13.1)
- **Frozen contracts:** `docs/superpowers/plans/maestro-00-scaffolding-and-contracts.md` (§0.2–§0.7). All type/signature names below are quoted **verbatim** from M0; this plan defines no new shapes (gaps → "Open dependencies").
- **Depends on:** M0 (frozen contracts). M1 starts only after the M0 exit gate holds.
- **Decisions in force:** full spec M0–M8 · vertical-slice sequencing · name `maestro` (`maestro::*`/`maestro:*`, env `MAESTRO_*`) · toolchain pnpm + TS strict ESM + vitest + zod + biome + tsup.

---

## Goal

Implement the pure reconciler FSM `reconcile(input: ReconcileInput): Intent` (contracts §0.4) TDD against the spec §7 state table, plus the config and WORKFLOW loaders (§5, §6) with validate-before-reload hot-reload. The reconciler must be total, deterministic, idempotent, side-effect free, and emit **at most one** `Intent` per tick. The loaders produce the inputs that resolve into `RepoSettings` (defaults ⊕ repo overrides ⊕ WORKFLOW front matter).

## Scope

**In:**
- `reconcile(...)` — every §7 row, the §13.1 trigger guard, state derivation from `(issue.state, labels, mr, approvals)`, the `cleanup` branch via `ReconcileInput.workspaceExists` (§0.5), `apply-changes-requested` edge gating consumed from `ApprovalState.changesRequested` (§0.3), and the crash-recovery `handoff` intent shape (§0.4 note).
- Config loader: parse + validate `maestro.config.yaml` via `ConfigSchema`; hot-reload with validate-before-reload (§5); host→`ForgeKind` inference.
- WORKFLOW loader: split front matter / `promptBody`, validate front matter via `WorkflowSchema` (§6); hot-reload.
- `RepoSettings` resolution: merge config defaults ⊕ per-repo `overrides` ⊕ WORKFLOW front matter into the frozen `RepoSettings` shape (§0.4), using `labelNames(forge)` (§0.7) for `labels`.
- `zDuration` / `zByteSize` helper implementations behind the M0 schemas (M0 declared them; M1 makes them real if M0 left them stubbed — see Open dependencies #4).

**Out (deferred):**
- Any forge implementation, network, or `Exec` against real binaries (M2 GitLab, M7 GitHub). Loaders inject a **fake fs**; no real subprocess.
- The **handoff *detection* predicate** ("all todo boxes checked + `done` sentinel comment") and the proof+assign sequence — **M4**. M1 only pins the `handoff` intent *shape* and the crash-recovery branch via an injected boolean (see Open dependencies #1).
- The cleanup **sweep** (listing `workspaces/` dirs, calling `getIssueState`) — **M5**. M1 covers only the `cleanup` *intent* via `workspaceExists`.
- Slot accounting / concurrency bookkeeping — M5 computes `slotAvailable`; M1 only consumes it.
- Runner invocation — M3/M5. M1 emits `run-agent`; it does not run anything.
- The actual file-watch mechanism (`fs.watch`/chokidar) — M1's loaders expose a pure `reload(text)` + a thin watch wrapper tested via the fake fs; the daemon wires the real watcher (M5).

---

## TDD slices

Convention: each slice is a named **failing** vitest test first, then the minimal implementation to green. Reconciler tests need **no mocks** (pure). Loader tests inject a **fake fs** (a `(path) => string` map) and never touch real disk or `Exec`. All tests live in `packages/core/`. Helper for reconciler tests: a `buildInput(partial): ReconcileInput` factory producing a valid default `IssueSnapshot` + `RepoSettings`, overridden per case — keeps each test asserting one axis.

### Part A — Reconciler FSM (`packages/core/src/reconciler/reconcile.ts`)

**Slice A0 — module + signature exist (compile gate).**
Test `reconcile is a total pure function`: importing `reconcile` from core and calling it with a minimal valid `ReconcileInput` returns an object with a `kind`. Pins the exact signature `reconcile(input: ReconcileInput): Intent` (§0.4). Green: stub returning `{ kind: 'none', reason: 'stub' }`.

**Slice A1 — trigger guard: not assigned to bot → `skip-untrusted` (§13.1, §0.4 rule 1).**
Test `rejects an issue not assigned to bot_user`: `issue.assignees` does not contain `settings.botUser` → `{ kind: 'skip-untrusted' }` with a `reason`. Assert **no other branch** is reachable: even an issue carrying `maestro::in-progress` but not assigned to bot still returns `skip-untrusted` (guard runs *first*, before state derivation). Green: implement guard step 1.

**Slice A2 — trigger guard: `requireLabel` absent → `skip-untrusted` (§13.1).**
Test `rejects when require_label is configured but missing`: `settings.trigger.requireLabel = 'approved-for-bot'`, issue assigned to bot but label absent → `skip-untrusted`. Complementary test: with the label present, the guard passes (falls through to state derivation). Green: extend guard.

**Slice A3 — trigger guard: `allowedActors` non-empty and `lastActor` not in it → `skip-untrusted` (§13.1).**
Test `rejects when lastActor not in non-empty allowed_actors`: `allowedActors = ['maintainer']`, `issue.lastActor.username = 'random'` → `skip-untrusted`. Two complementary tests pinning §0.4 rule 1 semantics: (a) `allowedActors` **empty** ⇒ no actor restriction (passes regardless of `lastActor`); (b) `allowedActors` non-empty but `issue.lastActor` **undefined** ⇒ reject (cannot prove a trusted actor). Green: extend guard. Factor the guard into a private `passesTriggerGuard(issue, trigger, botUser): boolean`.

**Slice A4 — §7 "Done": closed issue + `workspaceExists` → `cleanup` (§7 Done row, §0.4 rule 2, §0.5).**
Test `closed issue with live workspace yields cleanup`: `issue.state = 'closed'`, `workspaceExists = true` → `{ kind: 'cleanup' }`. Green: state-derivation branch for closed issues. **Note** the guard precedence question: a closed issue may not satisfy assignment any longer — see slice A4b.

**Slice A4b — §7 "Done": closed issue, no workspace → `none` (§0.5 fixpoint).**
Test `closed issue without workspace is a stable no-op`: `issue.state='closed'`, `workspaceExists=false` → `{ kind:'none' }`. This is the post-eviction fixpoint (§0.5). **Guard-vs-terminal ordering:** the closed-issue terminal branch must be evaluated such that cleanup is **not** suppressed by the trigger guard (a Done issue may have lost the assignee). Resolution baked into tests: **terminal/closed detection precedes the trigger guard** for the cleanup path — the guard governs *starting/continuing* work, not *cleaning up*. Test `closed issue still cleans up even if no longer assigned to bot` pins this. (Flagged as Open dependency #2 — §0.4 rule 1 says "guard first"; rules 1 vs 2 ordering needs central confirmation.)

**Slice A5 — §7 "New": open, no `maestro::*` label, slot available → `start-new` (§7 New row).**
Test `new issue with slot starts work`: open, `labels` contains no `maestro::*` member, `slotAvailable=true` → `{ kind:'start-new', branch, mrTitle }`. Assert `branch` and `mrTitle` are non-empty deterministic strings derived from `issue.iid`/`issue.title` (see Open dependency #3 for the exact branch naming convention). Green: `new` branch.

**Slice A6 — §7 "New": no slot → `none` (queued) (§0.4 rule 2, §14).**
Test `new issue without slot queues`: same as A5 but `slotAvailable=false` → `{ kind:'none', reason: <mentions queue/slot> }`. Pins §14 "the rest queue; nothing breaks." Green: gate `start-new` on `slotAvailable`.

**Slice A7 — §7 "In progress": `maestro::in-progress`, slot available → `run-agent{resume:true}` (§7 In-progress row).**
Test `in-progress with slot resumes agent`: `labels` has `inProgress`, `slotAvailable=true` → `{ kind:'run-agent', resume:true }`, `feedback` undefined. Green: `in-progress` branch.

**Slice A8 — §7 "In progress": no slot → `none` (slot is the constraint).**
Test `in-progress without slot waits`: `inProgress` label, `slotAvailable=false` → `{ kind:'none' }`. Pins that resuming active work consumes a slot (§7, §14). Green: gate `run-agent` on `slotAvailable`.

**Slice A9 — crash-recovery `handoff` (§0.4 note).**
Test `in-progress work already complete but handoff incomplete yields handoff`: an issue still labelled `maestro::in-progress`, MR present and `isDraft=true`, where the **work-complete signal is true** → `{ kind:'handoff' }`, and it must **not** consume a slot / must not return `run-agent`. Because the reconciler is pure and the §0.4 note assigns the "work complete" detection predicate to M4, M1 consumes this signal as an **injected boolean** rather than recomputing it. **This requires a field M0 does not define** — see Open dependency #1. Until reconciled, this slice is written but its single input field is marked TODO and the test `xit`-skipped with a pointer to Open dependency #1, so M1 ships green without guessing a contract shape.

**Slice A10 — §7 "In review": approved → `merge` (§7 In-review row, approved branch).**
Test `in-review approved merges with WORKFLOW git rules`: `inReview` label, `mr.approvals.approved=true` → `{ kind:'merge', strategy, deleteSource }` where `strategy === settings.git.mergeStrategy` and `deleteSource === settings.git.deleteSourceBranch`. Pins that merge rules come from resolved `RepoSettings.git`. Green: `in-review` approved branch.

**Slice A11 — §7 "In review": changes requested → `apply-changes-requested` (§7 In-review changes branch, §0.3 edge-trigger note).**
Test `in-review with changes-requested re-enters in-progress`: `inReview`, `approved=false`, `approvals.changesRequested=true` → `{ kind:'apply-changes-requested', feedback }` where `feedback.reviewComments` is sourced from `snapshot.recentComments` (per `AgentFeedback`, §0.4). Assert the reconciler **trusts** `changesRequested` as already edge-triggered by the adapter (§0.3) — it does **not** attempt to dedupe timestamps itself (that's the adapter's job). Green: changes-requested branch.

**Slice A12 — §7 "In review": neither approved nor changes → `poll-review` (§7 In-review default).**
Test `in-review pending just polls`: `inReview`, `approved=false`, `changesRequested=false` → `{ kind:'poll-review' }` (a no-op re-read). Green: default in-review branch.

**Slice A13 — approval precedence: approved AND changesRequested both true → `merge` wins.**
Test `approved takes precedence over stale changes-requested`: pins §0.4 rule 2 ordering ("if approved → merge; **else if** changesRequested → ..."). Asserts deterministic precedence so a race in adapter signals can't oscillate. Green: ensure `approved` checked before `changesRequested` (already true if A10/A11 implemented as `else if`; this test locks it).

**Slice A14 — §7 "Blocked": `maestro::blocked` → `blocked-wait` (§7 Blocked row).**
Test `blocked issue waits for human`: `labels` has `blocked` → `{ kind:'blocked-wait' }`, regardless of `slotAvailable`. Assert it does **not** consume a slot. Green: `blocked` branch.

**Slice A15 — label precedence when multiple maestro labels present (determinism guard).**
Test `derives a single state under conflicting labels deterministically`: if both `inProgress` and `inReview` are somehow present, derivation picks one deterministically by a fixed priority and never throws. This pins "state derivation is a pure function" (§0.4 rule 2) and totality even on malformed forge state (GitLab scoped labels make this near-impossible, but GitHub mutual exclusion is adapter-enforced, §0.7 — so the reconciler must still be total). Priority order documented in code: `blocked` > `in-review` > `in-progress` (most-terminal-wins, avoids resuming an agent on an issue a human blocked). Green: implement `deriveState(...)` with explicit ordering.

**Slice A16 — determinism + idempotency property (§0.4 rules 3–4).**
Test `same input yields same intent and at most one intent`: call `reconcile` twice on a deep-frozen input; assert deep-equal results and that the return is a single object (never an array). Add a small table-driven sweep over the canonical §7 rows asserting each yields exactly one expected `kind`. Pins §0.4 rule 3 ("at most one intent") and rule 4 ("idempotent"). Green: no code if A1–A15 done; this is the locking property test. Also assert input is **not mutated** (purity): re-read fields after the call.

**Implementation of Part A:** a single pure function: `passesTriggerGuard` → terminal/closed check (per A4b ordering) → `deriveState` → `switch(state)` returning one `Intent`. No `async`, no imports from any package other than `contracts`. Exhaustive `switch` with a `never` default so a new `LifecycleState` fails the typecheck (totality enforced at compile time).

### Part B — Config loader (`packages/core/src/config/load-config.ts`)

**Slice B0 — parse + validate a valid config (§5, §0.6).**
Test `parses the sample maestro.config.yaml`: feed the M0 sample text (the round-trip fixture) → returns a typed `z.infer<typeof ConfigSchema>` with `defaults.poll_interval_active` resolved to **milliseconds** (30000) via `zDuration`, `disk_cap` to bytes via `zByteSize`. Green: YAML parse (`yaml` lib) → `ConfigSchema.parse`.

**Slice B1 — invalid config rejected with a useful error (§5 validate).**
Test `rejects config missing required bot_user`: malformed YAML/text → loader throws/returns a typed error carrying the zod issue path. Pins "validate" (§5). Green: surface `ConfigSchema.safeParse` errors.

**Slice B2 — host → `ForgeKind` inference per repo (§0.6 comment "host inferred → ForgeKind").**
Test `infers forge from repo url host`: `repos[].url = 'gitlab.com/group/api'` → resolves `forge: 'gitlab'`; `'github.com/org/web'` → `'github'`. Unknown host with no matching `forges` entry → typed error. Green: a `inferForge(url, forges): ForgeKind` helper (self-hosted hosts match by the configured `forges.*.host`).

**Slice B3 — hot-reload with validate-before-reload (§5).**
Test `keeps the previous good config when the new text is invalid`: a `ConfigStore` holding the current value; `store.reload(badText)` returns `{ ok:false, error }` and leaves `store.current` unchanged; `store.reload(goodText)` swaps it atomically and returns `{ ok:true }`. Pins §5 "validate before reload." Green: `ConfigStore` wrapping parse; only assign on success. The fs-watch trigger is injected (fake fs in tests); the real watcher is M5.

### Part C — WORKFLOW loader (`packages/core/src/workflow/load-workflow.ts`)

**Slice C0 — split front matter + body (§6).**
Test `separates YAML front matter from the prompt body`: a `WORKFLOW.md` text with `---` fenced front matter + markdown body → `{ frontMatter, promptBody }` where `promptBody` is the markdown after the closing `---` (carried separately per §0.6 note). Missing/empty front matter → typed error. Green: a front-matter splitter (gray-matter or hand-rolled `---` split — prefer hand-rolled to avoid a dep if trivial).

**Slice C1 — validate front matter via `WorkflowSchema` (§6).**
Test `parses and defaults the sample template front matter`: feed `templates/WORKFLOW.md` (M0 fixture) → `WorkflowSchema`-typed object with defaults applied (`manage_board:true`, `git.merge_strategy:'squash'`, `claude.max_turns:40`, etc.). Invalid front matter (missing required `proof.type` or `project`) → typed error. Green: `WorkflowSchema.parse` on the split front matter.

**Slice C2 — `forge` inference when omitted (§6 "inferred from host if omitted").**
Test `infers forge from repo host when WORKFLOW omits it`: front matter without `forge` + the repo's host → resolved forge. Green: reuse `inferForge` from Part B; the loader takes the repo's `host` as a parameter (it does not re-read config).

**Slice C3 — hot-reload + validate-before-reload (§6 "hot-reloads on change, validates").**
Test `WorkflowStore keeps last good front matter on invalid reload`: mirrors B3 for `WorkflowStore`. Green: same store pattern.

### Part D — `RepoSettings` resolution (`packages/core/src/config/resolve-settings.ts`)

**Slice D0 — merge defaults ⊕ overrides ⊕ WORKFLOW into `RepoSettings` (§0.4 shape).**
Test `resolves RepoSettings for a repo`: given a parsed config repo entry + its parsed WORKFLOW front matter + the `RepoRef`, produce the frozen `RepoSettings` (§0.4): `botUser` from WORKFLOW `bot_user` (falling back to config `defaults.bot_user` — see Open dependency #5), `trigger` mapped from WORKFLOW `trigger` to `TriggerGuard` (`requireLabel`, `allowedActors`), `git` from WORKFLOW `git` mapped to `{ defaultBranch, target, mergeStrategy, deleteSourceBranch }`, `manageBoard` from WORKFLOW `manage_board`, and `labels = labelNames(repo.forge)` (§0.7). Assert field-name mapping snake_case→camelCase is exact per `RepoSettings`. Green: a pure `resolveRepoSettings(...)`.

**Slice D1 — override precedence (§5 defaults ⊕ overrides).**
Test `repo concurrency override beats default`: config `repos[].overrides.concurrency.max_active` overrides the default; assert the resolved value. (Note: `RepoSettings` in §0.4 does not carry concurrency — see Open dependency #6 for where `max_active` lands. This test pins the *resolution* of the value even if its destination type is M5's; M1 produces it for M5's consumption.) Green: merge logic with documented precedence WORKFLOW > repo override > config default.

**Slice D2 — `TriggerGuard` mapping fidelity (§13.1 → §0.4).**
Test `maps WORKFLOW trigger to TriggerGuard`: `require_label: null` → `requireLabel: null`; `allowed_actors: ['a']` → `allowedActors: ['a']`; defaults (`require_label` absent) → `requireLabel: null`, `allowedActors: []`. Closes the loop with reconciler slices A1–A3 (the guard the reconciler reads is exactly what the loader produces). Green: explicit mapping.

---

## Exit gate

Before any M2+ work depends on M1, all must hold:

1. `pnpm -r typecheck && pnpm -r test && pnpm lint` clean; new code lives only under `packages/core/src/{reconciler,config,workflow}` and imports nothing from a forge/CLI/web package.
2. **Every §7 state-table row** has a passing reconciler test: New (A5/A6), In-progress (A7/A8), Handoff/crash-recovery (A9 — see Open dependency #1; skipped-with-pointer is acceptable for the gate, but the *gap must be logged in §0.10*), In-review approved (A10) / changes (A11) / pending (A12), Blocked (A14), Done/cleanup (A4/A4b).
3. **Every guard** has its own test: trigger guard assignment (A1), `require_label` (A2), `allowed_actors` incl. empty + undefined-actor cases (A3), slot gating (A6/A8).
4. Determinism + idempotency + at-most-one-intent property test (A16) passes over the full §7 row table; reconciler `switch` is exhaustive with a `never` default.
5. Config loader: parses the M0 sample, resolves durations→ms and sizes→bytes, infers forge, and validate-before-reload proven (B0–B3).
6. WORKFLOW loader: splits front matter/body, validates via `WorkflowSchema`, infers omitted forge, validate-before-reload proven (C0–C3).
7. `resolveRepoSettings` produces the **exact** frozen `RepoSettings` shape (§0.4) including `labels = labelNames(forge)` (D0–D2).
8. Reconciler is provably I/O-free: no `async` in `reconcile`, no imports of `Exec`/`fs`/forge; a lint/grep check or a test asserting the module has no side effects.
9. Any contract gap encountered is recorded in M0 §0.10 (change log) — **not** patched inline in M1 code.

## Cross-cutting

**QA:**
- Reconciler is the highest-leverage pure unit surface in the system (§15) — aim for branch-complete coverage of `deriveState` and the guard; a table-driven §7 fixture doubles as living documentation of the state machine.
- Loaders: test the **invalid** path as hard as the valid path — validate-before-reload (§5) is a correctness property, not a nicety; a silently-swallowed bad reload would brick the daemon's view of a repo.
- Freeze test inputs (`Object.freeze`) to catch accidental mutation and prove purity.

**Security (§13.1):**
- The trigger guard is a **security boundary**, not a convenience filter. Its tests must assert *fail-closed*: empty/undefined/ambiguous actor info ⇒ reject (slice A3 undefined-actor case). A bug here lets attacker-controlled issues (§13.1, public repos) start agent work.
- `issue.body` and `recentComments` are attacker-controlled on public repos (§0.2, §13.1). The reconciler must treat them as **opaque data** — never parse them for control decisions. `apply-changes-requested` passes `recentComments` through as `AgentFeedback` data only; no reconciler branch keys off their content.
- Loaders parse YAML from disk (config + WORKFLOW). Use a **safe** YAML load (no custom tags / no code execution); config text is repo-committed but WORKFLOW lives in *watched* repos and is effectively semi-trusted. Schema validation (zod) is the containment.
- No secrets in M1: loaders read `token_env` **names** only (§0.8); they must never resolve `process.env[token_env]` (that's the edge, M2/M3). A test asserts the loaded config carries the env-var *name*, not a token value.

## Open dependencies

1. **Crash-recovery `handoff`: no "work-complete" input field on `ReconcileInput`.**
   *Gap:* §0.4 rule 2 says `maestro::in-progress → if agent's last result was 'done' → handoff`, and the §0.4 note states the daemon acts on `done` immediately so a standalone `handoff` intent "only arises on crash recovery" detected via "a draft MR whose todo boxes are all checked + a `done` sentinel comment." But `ReconcileInput` (§0.4) exposes only `snapshot`, `settings`, `slotAvailable`, `workspaceExists` — **no signal the reconciler can read to distinguish "resume agent" from "resume handoff."**
   *Why it blocks:* slice A9 cannot pin the §7 Handoff row without inventing either (a) a new `ReconcileInput` field, or (b) a reconciler-side parse of MR description checkboxes + comment sentinel — which would put detection logic in the pure reconciler, contradicting the §0.4 note that assigns that predicate to M4.
   *Proposed resolution (for central reconciliation, not self-applied):* add to `ReconcileInput` an injected boolean computed by M4's detector and passed by M5, e.g. `workComplete: boolean` (true when M4's "all boxes checked + done sentinel" predicate holds). Reconciler rule becomes: `in-progress + workComplete → handoff`; `in-progress + !workComplete + slot → run-agent{resume}`. This keeps the predicate in M4, the wiring in M5, and the reconciler pure. Requires an entry in M0 §0.10. Until reconciled, A9 is written but `xit`-skipped with this pointer.

2. **Guard-vs-terminal precedence is under-specified.**
   *Gap:* §0.4 rule 1 says "Trigger guard **first**." Rule 2's first bullet handles closed (terminal/cleanup) issues. A Done issue may no longer be assigned to the bot (assignment can be cleared on close), so applying the guard before terminal detection would yield `skip-untrusted` and **leak the workspace** (cleanup never fires), violating §0.5's fixpoint.
   *Why it blocks:* slice A4/A4b need a defined ordering to be correct, and the two stated rules conflict at the closed-issue boundary.
   *Proposed resolution:* the trigger guard governs **starting/continuing work**, not cleanup. Order: **terminal(closed) check → trigger guard → state derivation.** Cleanup of a closed issue is exempt from the guard (it touches no forge state beyond evicting a local dir; §0.5). Document in M0 §0.4 rule ordering. M1 implements this ordering and pins it with A4b's "closed issue still cleans up even if unassigned" test.

3. **Branch / MR-title naming convention for `start-new` is undefined.**
   *Gap:* `Intent.start-new` carries `branch` and `mrTitle` (§0.4) but no contract specifies their format. M1 must emit concrete deterministic strings.
   *Why it blocks:* A5 asserts exact values; M2 (`createBranch`/`createDraftMR`) consumes them; an unspecified format risks M1/M2 divergence — the exact failure mode that deleted the prior plan set.
   *Proposed resolution:* define a pure helper in contracts (or M1, if M0 agrees) e.g. `branch = `maestro/issue-${iid}-${slug(title)}`` and `mrTitle = `Draft: ${title} (Closes #${iid})``, slug = lowercased, non-alnum→`-`, capped length. Needs a one-line addition to §0.4 or a `contracts/naming.ts` entry + §0.10 log. Until set, A5 asserts only *shape* (non-empty + contains `iid`), not an exact literal.

4. **`zDuration` / `zByteSize` ownership (M0 vs M1).**
   *Gap:* §0.6 references `zDuration` and `zByteSize` as helpers behind `ConfigSchema`; the M0 exit gate requires the schemas to round-trip the sample, which *implies* M0 implemented them. If M0 only declared signatures, M1 owns the implementation.
   *Why it blocks (minor):* B0 asserts ms/bytes resolution; need to know whether to implement or import.
   *Proposed resolution:* confirm M0 ships working `zDuration`/`zByteSize` (the round-trip exit-gate test forces it). If not, M1 implements them under `contracts/` and logs it in §0.10. Assumed implemented in M0 unless told otherwise.

5. **`bot_user` precedence: config `defaults.bot_user` vs WORKFLOW `bot_user`.**
   *Gap:* both `ConfigSchema.defaults.bot_user` (§0.6) and `WorkflowSchema.bot_user` (§0.6) exist; `RepoSettings.botUser` is singular (§0.4). Precedence is unstated.
   *Why it blocks (minor):* D0 must pick one.
   *Proposed resolution:* WORKFLOW `bot_user` (repo-local, most specific) wins; config `defaults.bot_user` is the fallback when WORKFLOW omits it. Consistent with the general "defaults ⊕ overrides ⊕ WORKFLOW" precedence (§0.4). M1 implements this; flag for §0.10 confirmation.

6. **Resolved `max_active` / concurrency has no home in `RepoSettings`.**
   *Gap:* `WorkflowSchema.concurrency.max_active` and config `overrides.concurrency.max_active` both exist (§0.6), but `RepoSettings` (§0.4) carries no concurrency field. The reconciler consumes only `slotAvailable` (computed elsewhere), so it doesn't need it — but M5's slot accounting does.
   *Why it blocks (deferred, not M1-blocking):* M1 resolves the value (D1) but has nowhere in the frozen contract to put it.
   *Proposed resolution:* this is an **M5** concern; M1's `resolveRepoSettings` can return resolved concurrency as a separate sibling value (not on `RepoSettings`), or M0 adds `concurrency` to `RepoSettings`. Defer to M5; M1 will expose the resolved number via the resolver's return without mutating the frozen `RepoSettings` shape. No M0 change required for M1 to ship.
