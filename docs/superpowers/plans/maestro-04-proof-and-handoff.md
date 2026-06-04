# Maestro — M4: Proof Generator & Handoff Orchestration

- **Milestone:** M4 — Proof generator (pluggable strategies) + Handoff orchestration (the transient Handoff step).
- **Source pointers:** spec `docs/superpowers/specs/2026-06-03-maestro-design.md` §6 (`proof`, `environment`), §7 (Handoff row + ordering guarantee), §8 (proof component), §13 (host-workspace tradeoff), §14 (Chromium RAM), §17 (local runnable instance). Contracts `docs/superpowers/plans/maestro-00-scaffolding-and-contracts.md` §0.3 (adapter), §0.4 (`handoff` intent + crash-recovery note), §0.6 (`WorkflowSchema`), §0.7 (`LabelNames`), §0.8 (`Exec`), §0.9 (`AgentResult`).
- **Depends on:** M0 (contracts) · M2 (adapter for `commentIssue`/`commentMR`/`assignMR`/`setDraft`/`setIssueLabels`) · M3 (`Exec` real impl + per-issue workspace dir).
- **Decisions one-liner:** proof is a strategy registry keyed by `WorkflowSchema.proof.type`, every strategy runs only through the injected `Exec` seam and returns a single `ProofResult` shape (proposed to M0 — see Open dependencies); handoff is a fixed ordered sequence (proof → comment issue+MR → assign reviewer → un-draft → label in-review) proven by a call-order recorder, re-entrant on crash recovery via a `done` sentinel comment + all-boxes-checked + still-draft detection.

---

## Goal

Two units that together turn an agent `done` into a review-ready, human-pinged MR:

1. **Proof generator** — given resolved `WorkflowSchema` (`proof`, `environment`) and a workspace dir, produce review evidence by running the configured strategy through `Exec`, returning a `ProofResult` the handoff step renders into comment markdown. Strategies: `none`, `diff-summary`, `test-output`, `playwright`.
2. **Handoff orchestration** — the transient Handoff step from spec §7: run proof, post it to issue **and** MR, then assign the MR to the ticket creator, un-draft it, and label `maestro::in-review` — **in that exact order**, idempotently, so a crash mid-sequence resumes without double-assigning or double-commenting and the human is pinged exactly once.

---

## Scope

**In:**
- A `ProofStrategy` registry selected by `proof.type`; one strategy implementation each (`none`, `diff-summary`, `test-output`, `playwright`).
- Playwright environment bring-up: reach `base_url` via `health_check`, else `start_command` + `seed_command` + poll `health_check`, then run `proof.command`; tear down anything this step started.
- `Handoff` orchestrator: the strict ordered sequence over the M2 adapter surface.
- Crash-recovery detection: decide whether handoff is already done / partway / not started from forge state alone (no local persistence).
- The `done` sentinel comment format that makes recovery legible.

**Out (other milestones / deferred):**
- The reconciler's decision to *enter* handoff (M1; `Intent.handoff` already defined §0.4).
- Wiring handoff into the daemon tick / invoking it on a live `AgentResult.status === 'done'` (M5; this plan exposes the callable unit and its tests, M5 calls it).
- Running the agent / producing `done` (M3 runner).
- Merge, approval polling, changes-requested (M1 reconciler + M5).
- Fully isolated DB/app standup in an ephemeral sandbox — deferred (§17); M4 only does the **local runnable instance** case via `environment`.
- Container sandboxing of proof commands (§13, §17 deferred) — M4 runs unsandboxed on host and **flags** it.

---

## TDD slices

Every slice: write the named test, watch it fail, implement the minimum to pass. All `Exec` is the injected fake (§0.8) — no real `git`/`npx`/`curl`/`claude`. All adapter calls go through a fake/spy `ForgeAdapter` (§0.3). No network, no real browser.

### Proof generator

**Slice 1 — strategy registry + `none` no-op.**
Test `proof-registry.test.ts`: `selectProofStrategy('none')` returns a strategy whose `generate()` resolves a `ProofResult` with `kind: 'none'`, empty/markerless body, and makes **zero** `Exec.run` calls (assert fake Exec call count is 0). Selecting an unknown type throws at config-resolution time, not at run time.
Impl: registry map `Record<proof.type, ProofStrategy>`; `none` returns a constant `ProofResult`.

**Slice 2 — `diff-summary` via `git diff --stat`.**
Test `proof-diff-summary.test.ts`: fake `Exec` returns canned `git diff --stat <target>...HEAD` stdout. Strategy calls `Exec.run('git', ['diff', '--stat', ...], { cwd: workspaceDir })` exactly once with `cwd === workspaceDir`, and the `ProofResult.summaryMarkdown` embeds the stat output in a fenced block. Non-zero exit → `ProofResult.ok === false` with stderr captured (handoff still proceeds — proof failure is reported, not fatal; assert this is a captured field, not a throw).
Impl: shell out to git through `Exec`; format result. Diff base = `git.target` from resolved settings.

**Slice 3 — `test-output` runs `proof.command`, captures output.**
Test `proof-test-output.test.ts`: `proof.command` (e.g. the WORKFLOW line) is parsed and run through `Exec.run` with `cwd: workspaceDir`; both stdout+stderr and the exit code land in `ProofResult` (`ok` = `code === 0`, output truncated to a bounded size — assert a long output is capped and marked truncated). Missing `proof.command` for a command-requiring type → validation error surfaced before any `Exec` call (assert zero Exec calls).
Impl: command parsing (respect the seam's `(cmd, args[])` split — define one place that turns a `proof.command` string into `cmd + args`; keep it dumb/whitespace-split with a documented limitation, not a shell), run, capture, truncate.

**Slice 4 — `playwright` boots/health-checks via `environment`, runs, captures.**
Test `proof-playwright.test.ts`, cases via fake `Exec` scripted per command:
  a. **Already-running:** `health_check` exits 0 on first probe → strategy does **not** call `start_command`; runs `proof.command`; result `ok` reflects the test exit. Assert `start_command` never executed.
  b. **Cold boot:** `health_check` fails, `start_command` launched, `seed_command` run, `health_check` polled until it passes (assert bounded ret/ timeout — N attempts then give up with `ProofResult.ok === false`, reason captured), then `proof.command` runs.
  c. **Teardown:** anything this step started (the `start_command` process) is torn down after the run even when `proof.command` fails (assert teardown invoked on the failure path). If the instance was already up (case a), do **not** tear it down.
  d. **No `base_url`/`health_check` configured** for a `playwright` proof → validation error before any `Exec` call.
Impl: order = probe health → (boot+seed+poll if needed) → run `proof.command` → capture → conditional teardown. Process handle for teardown comes back from `Exec` (this needs a non-blocking start primitive — see Open dependencies, `Exec` currently only models run-to-completion). Until that lands, gate case (b)/(c) behind the proposed seam addition; cases (a)/(d) pass on the current `Exec`.

### Handoff orchestration

**Slice 5 — strict ordering proven by a call recorder.**
Test `handoff-order.test.ts`: inject a fake adapter that pushes each method name onto an ordered `calls[]` recorder, plus a stub proof strategy that records when it ran. Run `handoff(...)` to completion. Assert the recorded order is exactly:
  `generateProof` < `commentIssue` < `commentMR` < `assignMR` < `setDraft(false)` < `setIssueLabels(set:[in-review])`.
Assert specifically that **`commentIssue` and `commentMR` both precede `assignMR`** (the spec §7 ordering guarantee: proof posted before reviewer assigned), and that `assignMR` < `setDraft(false)` < label. The reviewer username passed to `assignMR` equals `issue.author.username` (ticket creator), not `botUser`. Label set uses `LabelNames.inReview` and unsets `inProgress` (§0.7 names; pass set/unset through `setIssueLabels`).
Impl: a single async function performing the steps sequentially (await each before the next). No parallelism — ordering is the contract.

**Slice 6 — handoff is the only place the human is pinged; assignment is last meaningful step.**
Test `handoff-ping-once.test.ts`: assert `assignMR` is called exactly once and occurs after both proof comments; assert no adapter call after `setIssueLabels` (label is terminal for the step). Guards the "pinged only once everything is ready" property — if any earlier step threw, `assignMR` must not have been reached (drive a proof-comment failure and assert `assignMR` not called).
Impl: sequential awaits already give this; the test locks it against future reordering.

**Slice 7 — crash-recovery idempotency (re-entrant handoff).**
Test `handoff-recovery.test.ts`. The recovery predicate reads forge state only (§0.4 note: done sentinel comment present + all todo boxes in MR description checked + MR still draft). Cases:
  a. **Not started:** sentinel absent → `isHandoffComplete` false, `needsHandoff` derived from `done`-state inputs; full sequence runs.
  b. **Partway — proof commented, not yet assigned:** sentinel comment already present in `recentComments`, MR still draft, reviewer not yet assigned → re-running handoff must **not** post a second proof comment (assert `commentIssue`/`commentMR` skipped because sentinel detects prior completion of that sub-step) but **must** still `assignMR` + `setDraft(false)` + label. Net: no double-comment, no double-assign.
  c. **Fully done:** MR not draft + `in-review` label present + reviewer assigned → handoff is a no-op (assert zero mutating adapter calls).
Each sub-step is guarded by an *observable forge predicate* so re-entry skips already-applied steps:
  - proof-comments-done ⇔ `done` sentinel comment exists on the issue (and mirrored on MR);
  - assigned ⇔ `mr.assignees` contains the ticket creator;
  - undrafted ⇔ `mr.isDraft === false`;
  - labeled ⇔ `in-review` in `mr.labels`/issue labels.
Impl: before each mutating step, check its predicate against the passed `IssueSnapshot`; skip if already satisfied. The `done` sentinel is a fixed, greppable marker line emitted as part of the proof comment body (define the exact string once, e.g. an HTML-comment marker, so it survives human replies and is unambiguous). Posting the proof comment and writing the sentinel are the same write, so "sentinel present" ⇔ "proof already posted" with no extra state.

**Slice 8 — proof failure does not block handoff.**
Test `handoff-proof-fail.test.ts`: proof strategy returns `ProofResult.ok === false`. Handoff still posts the (failure-reporting) comment, still assigns, undrafts, labels. Assert the comment body marks proof as failed and the sequence completes. (Rationale: a flaky proof must not strand the MR in draft forever; the human reviews with the failure noted. Flag for review — this is a deliberate policy choice, callable out in Exit gate.)

---

## Exit gate

- [ ] All four proof strategies implemented; each runs solely through the injected `Exec` (no real binary touched in tests).
- [ ] `none` makes zero Exec calls; `diff-summary`/`test-output`/`playwright` make exactly the expected calls with `cwd === workspaceDir`.
- [ ] Playwright path: already-running (no boot), cold-boot (boot+seed+health-poll+bounded timeout), and conditional teardown all covered; missing `base_url`/`health_check` rejected pre-exec.
- [ ] **Ordering guarantee proven by a call-order test** (Slice 5): proof-comment (issue+MR) precedes `assignMR` precedes `setDraft(false)` precedes label `in-review`; reviewer = ticket creator.
- [ ] Human pinged exactly once: `assignMR` called once, only after proof comments, never reached if an earlier step throws.
- [ ] Crash-recovery idempotency proven (Slice 7): partway re-run does not double-comment or double-assign; fully-done re-run is a no-op (zero mutating calls).
- [ ] Proof failure is non-fatal to handoff and is surfaced in the comment (Slice 8) — policy confirmed.
- [ ] `done` sentinel string defined in exactly one place and used by both the proof-comment writer and the recovery predicate.
- [ ] No contract type redefined inline; any new shape is recorded in §0.10 contract change log (see Open dependencies) before merge.
- [ ] `pnpm -r typecheck && pnpm -r test && pnpm lint` clean.

---

## Cross-cutting

**QA:**
- Recovery predicates are tested against real `IssueSnapshot`/`MergeRequest` shapes (§0.2), not ad-hoc mocks, so M5 wiring can't drift.
- Bounded health-check polling and bounded output truncation are explicit test assertions, not incidental — they're the difference between "boots" and "hangs the daemon".

**Security:**
- ⚠️ **Proof commands run unsandboxed on the host (§13).** `proof.command`, `start_command`, `seed_command`, `health_check` all come from the repo's WORKFLOW.md and execute with the daemon's privileges via `Exec`. On public repos this compounds the §13.1 prompt-injection surface. M4 mitigations: run with `cwd` pinned to the workspace dir, pass only the scoped token env the command needs, never widen `permission_mode`. Real fix (per-issue containers) is the deferred §17 workspace-manager swap — flag, do not solve here.
- Tokenized env passed to proof subprocesses follows §0.8: from `process.env[token_env]` via `ExecOptions.env`, never on argv, never logged. Captured proof output may echo secrets the command itself prints — truncation does not redact; note this as a known limitation for M8 hardening, do not scrub in M4 beyond keeping output out of logs at error level.

**Capacity (§14):**
- ⚠️ **Playwright proof pulls in Chromium (~300–700 MB) on top of `claude`.** This is the dominant per-worker RAM cost and the OOM breaker that sizes `global_max`. M4 owns the boot path, so: do not pre-warm browsers, ensure teardown actually releases the started instance (Slice 4c), and keep the playwright path the only one that touches a browser. Sizing guidance stays in §14 / config; M4 just must not leak processes.

---

## Open dependencies

1. **`ProofResult` shape is undefined in M0 contracts.** *Gap:* §8 says the proof generator "returns artifacts the adapter attaches", but no `ProofResult`/`ProofArtifact` type exists in §0.2–§0.9, and the handoff step needs a stable shape to render into comments and to branch on (`ok`). *Why it matters:* without a frozen shape, M4 would invent a type and M5/M7 would diverge — the exact rot M0 §0.10 forbids. *Proposed fix (add to §0.10 + a new `contracts/proof.ts` before M4 implements):*
   ```ts
   // PROPOSAL — not yet frozen; for M0 reconciliation
   export type ProofKind = 'playwright' | 'test-output' | 'diff-summary' | 'none';
   export interface ProofResult {
     kind: ProofKind;
     ok: boolean;                 // strategy ran and signalled success (none ⇒ true)
     summaryMarkdown: string;     // rendered body for the issue/MR comment
     command?: string;            // the command run, if any (for transparency)
     exitCode?: number;
     truncated?: boolean;         // output was capped
   }
   export interface ProofStrategy {
     readonly kind: ProofKind;
     generate(input: ProofInput): Promise<ProofResult>;
   }
   export interface ProofInput {
     workspaceDir: string;
     proof: { type: ProofKind; command?: string };     // from WorkflowSchema.proof
     environment: WorkflowEnvironment;                  // from WorkflowSchema.environment
     git: { target: string };                           // diff base for diff-summary
     exec: Exec;                                        // injected seam (§0.8)
   }
   ```
   `WorkflowEnvironment` = `z.infer` of `WorkflowSchema.shape.environment` (§0.6) — reuse, do not redefine.

2. **`Exec` (§0.8) models only run-to-completion; the playwright cold-boot path needs a non-blocking long-lived `start_command`.** *Gap:* `Exec.run` resolves on process exit; `start_command` (`npm run dev`) does not exit, and Slice 4b/4c need a handle to health-poll against and to tear down. `stream()` exists but is shaped for `claude` line parsing, not "spawn and keep a handle". *Why it matters:* without it, the cold-boot/teardown cases can't be implemented faithfully and would force a hack. *Proposed fix (add to §0.8 + §0.10):* a `spawn(cmd, args, opts): { pid; kill(): void; exited: Promise<ExecResult> }` (or equivalent handle) on the `Exec` seam, fake-injectable like the rest. Until frozen, M4 implements/tests the already-running (4a) and validation (4d) cases on the current seam and gates 4b/4c behind this addition. *Flagging uncertainty:* exact handle shape (kill signal, process-group teardown for child trees spawned by `npm run dev`) should be settled at M0 reconciliation with M3, which owns the real `Exec` impl — I am not silently picking one.

3. **`done` sentinel comment is referenced by §0.4 but its exact string/format is unspecified.** *Gap:* §0.4 names "a `done` sentinel comment" for crash recovery; no canonical marker is defined. *Why it matters:* the recovery predicate (Slice 7) and the proof-comment writer must agree on one greppable, human-reply-surviving marker. *Proposed fix:* define one constant (e.g. an HTML comment line `<!-- maestro:proof:done -->` embedded in the proof comment body) in `contracts/proof.ts` alongside `ProofResult`, recorded in §0.10. Single source of truth; both M4 (write) and M4/M5 (detect) import it.
