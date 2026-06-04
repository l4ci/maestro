# Maestro — M5: Daemon Loop

- **Milestone:** M5 — the stateless poll-driven daemon: the tick orchestrator that ties loaders + reconciler + adapter + workspace + runner + handoff into one process. **First full end-to-end milestone — the vertical slice completes here.**
- **Source pointers:** spec `docs/superpowers/specs/2026-06-03-maestro-design.md` §3 (stateless, two legible stores), §5 (config hot-reload), §7 (lifecycle → action per tick), §10 (runner result is all the daemon consumes), §13 (concurrency, retry, stall), §14 (one daemon, slot accounting, adaptive polling, jitter, double-claim, sizing/OOM/disk breakers, systemd `MemoryMax`), §15/§16 (E2E smoke). Contracts `docs/superpowers/plans/maestro-00-scaffolding-and-contracts.md` §0.3 (`ForgeAdapter`: `listAssignedOpenIssues`/`getSnapshot`/`getIssueState` + mutations), §0.4 (`ReconcileInput`/`Intent`/`reconcile`; the crash-recovery `handoff` note), §0.5 (two-pass tick: lifecycle + cleanup sweep), §0.6 (`ConfigSchema`/`WorkflowSchema`), §0.9 (`Runner`/`AgentResult`/`AgentStatus` → lifecycle mapping).
- **Depends on:** M0 (frozen contracts) · M1 (`reconcile`, config/WORKFLOW loaders + stores, `resolveRepoSettings`) · M2 (GitLab `ForgeAdapter` — the reference adapter the E2E smoke runs against) · M3 (`WorkspaceManager` + `ClaudeRunner`) · M4 (`handoff(...)` orchestrator + proof). GitHub adapter is **M7**, web dashboard **M6**, CLI/bootstrap **M8** — out of scope here.
- **Decisions one-liner:** the daemon is the **only** place I/O and concurrency live; per repo per tick it runs the two §0.5 passes (lifecycle + cleanup sweep); it owns the values M1/M3/M4 delegated to it — `slotAvailable`, `workspaceExists`, `workComplete`, and the `AgentResult`→lifecycle mapping — and everything is unit-testable by injecting fakes for adapter / runner / handoff / clock so no real I/O or real time runs in tests.

---

## Goal

A stateless tick loop that, given the loaded config + per-repo `RepoSettings`, drives every assigned issue across every watched repo through `New → in-progress → handoff → in-review → merge → Done`, fully automated, surviving multi-day review waits and crashes because all durable state lives in the forge + on disk (§3). The daemon composes the M1–M4 units; it adds **no business rules** beyond the orchestration the contracts explicitly assigned to it: concurrency accounting, the two-pass tick, the runner-result mapping, the adaptive scheduler, and hot-reload wiring. The exit of this milestone **is** the spec's E2E vertical slice (§15/§16): one GitLab repo, one assigned issue, driven end to end with no human action except the review approval.

## Scope

**In:**
- **Tick orchestrator** (`packages/core/src/daemon/tick.ts`): per repo, run pass (a) **lifecycle** and pass (b) **cleanup sweep** from contracts §0.5.
  - Pass (a): `adapter.listAssignedOpenIssues(repo)` → for each issue `adapter.getSnapshot` → build `ReconcileInput` (compute `slotAvailable`, `workspaceExists`, `workComplete`) → `reconcile(input)` → **execute** the returned `Intent` against adapter / workspace / runner / handoff.
  - Pass (b): list the dirs under `workspaces.root` belonging to this repo → `adapter.getIssueState(repo, iid)` → if `closed`/`missing` reconcile yields `cleanup` → `WorkspaceManager.evict`.
- **Concurrency accounting** (§14): compute `slotAvailable` from `global_max` (config default) and per-repo `max_active` (the resolved value M1 surfaced, OD #6). **Only active work consumes a slot** (§7, §14): `start-new` and `run-agent` consume; `poll-review`, `merge`, `blocked-wait`, `cleanup`, `handoff`, `none` do not. Queue (no-op) when full.
- **Runner-result → lifecycle mapping** (§0.9): after a `run-agent` intent runs the `ClaudeRunner`, map `AgentResult.status`: `needs_input` → set `maestro::blocked` + comment why; `done` → invoke M4 `handoff(...)` **immediately, same tick**; `in_progress` → leave `maestro::in-progress` (resumes next tick).
- **`workComplete` signal** (crash-recovery handoff, M1 OD #1 / M4): compute the M4 detector ("done sentinel comment present + all MR todo boxes checked + MR still draft") from the snapshot, pass it into `ReconcileInput` so the reconciler can return the standalone `handoff` intent on a tick that follows a crash mid-handoff.
- **`workspaceExists`** (§0.5): does a live workspace dir exist for this issue (via `WorkspaceManager`), fed into `ReconcileInput`.
- **Adaptive-poll scheduler** (§14): a repo with active work polls every `poll_interval_active` (30s); an idle repo every `poll_interval_idle` (5m); `poll_jitter` spread on each scheduled tick to avoid bursts/rate-limit spikes. Per-repo next-tick scheduling off an injected clock.
- **Hot-reload wiring** (§5): wrap M1's `ConfigStore` / `WorkflowStore` with the real file watcher; validate-before-reload (valid → swap atomically; invalid → keep old + log). A config reload re-derives the watch set; a WORKFLOW reload re-derives that repo's `RepoSettings`.
- **Retry / idempotency** (§13): a failed tick (network/`glab`/exec error) is caught, logged, and **retried next tick** — no in-process retry loop needed because the reconciler is idempotent (state lives in the forge). One repo's failure never blocks another.
- **Stall handling**: delegated to the runner (M3 RUN-5 watchdog). The daemon does not re-implement it; it only consumes the runner's `in_progress`-on-stall result and lets the next tick resume.
- **§14 invariants as ops guards (documentation, not code):** single-daemon / one-repo-one-install / double-claim hazard / sizing `global_max` to RAM / systemd `MemoryMax` backstop — written into the module header + this plan's Cross-cutting, **not** enforced in code (there is no cross-install coordination in v1, §17).
- **Daemon entrypoint** (`packages/cli/src/daemon.ts`): thin `main()` that loads config, builds the adapter per forge, constructs the scheduler, and runs forever under systemd. Thin over `core`; the orchestration logic itself is in `core` so it is unit-testable headless.

**Out (and where it lives):**
- GitHub adapter → **M7** (the daemon is forge-agnostic: it picks an adapter by `RepoRef.forge`; M7 drops in behind the same `ForgeAdapter` seam with zero daemon change).
- Web dashboard → **M6**.
- CLI commands (`add`/`status`/`list`/`logs`, `run --attach`) + the `maestro add` bootstrap onboarding flow (§16) → **M8**. (The bootstrap *runs through this daemon's normal lifecycle* once the seed issue exists; M5 needs no special path for it — §16 "no special-case code path.")
- The reconciler FSM, loaders, `resolveRepoSettings` → **M1** (consumed, not redefined).
- Workspace clone/branch/evict mechanics, runner argv/parse/stall → **M3** (consumed).
- Proof + handoff sequence → **M4** (`handoff(...)` invoked, not reimplemented).
- Per-issue container isolation → deferred (§17).

---

## Architecture sketch

**One process, one loop, N repos, bounded workers.** (§14: "one daemon, period.")

```
daemon.ts (cli, thin)
  └─ Scheduler (core)                  ← adaptive per-repo next-tick times, injected Clock
       └─ tickRepo(repo, ctx)          ← one repo, one tick; never throws past here (retry = next tick)
            ├─ pass A: lifecycle
            │    listAssignedOpenIssues → for each:
            │      getSnapshot → buildReconcileInput → reconcile → executeIntent
            └─ pass B: cleanup sweep
                 list workspace dirs for repo → getIssueState → (cleanup) → evict
```

**Composition (`TickContext`, injected — the unit-test seam):**

```ts
// module-local to core/src/daemon — NOT a frozen contract type; composes frozen seams only
interface TickContext {
  adapter: ForgeAdapter;            // §0.3 (GitLab M2 / GitHub M7) — picked by repo.forge
  workspace: WorkspaceManager;      // M3
  runner: Runner;                   // §0.9 (ClaudeRunner M3)
  handoff: HandoffFn;               // M4 handoff(...) — callable unit
  settings: RepoSettings;           // M1 resolveRepoSettings (per repo)
  resolvedConcurrency: { maxActive: number };  // M1 OD#6 sibling value
  promptBody: string;               // WORKFLOW body (M1 loader) → RunnerInput.promptBody
  workComplete(snapshot: IssueSnapshot): boolean;  // M4 detector (OD#1 / §0.4 note)
  clock: Clock;                     // injected; no real Date.now / setTimeout in core
  slots: SlotAccountant;            // global + per-repo accounting (this milestone)
  log: Logger;
}
```

Everything in `TickContext` is an interface; tests inject fakes (recording adapter, scripted runner, spy handoff, fake clock, in-memory slot accountant). **No test in M5 starts a real subprocess, opens a socket, or reads a real clock.** The only real-I/O test is the documented E2E smoke (§15/§16), which is explicitly out of the unit suite and gated separately.

**Concurrency accounting model (§14).** A single `SlotAccountant` holds the count of currently-active workers across all repos (`global_max`) and per repo (`max_active`). `slotAvailable` for an issue is computed *before* `reconcile` as: `globalActive < global_max && repoActive[repo] < resolvedConcurrency.maxActive`. Active = an issue currently running the agent (`run-agent`) or being started (`start-new`). The accountant is incremented when an intent that consumes a slot begins and decremented when it finishes (try/finally). Because the agent run is awaited within the tick, slot lifetime = the synchronous span of that issue's active intent. **Only active work consumes a slot** — `poll-review`/`merge`/`blocked-wait`/`cleanup`/`handoff`(transient, no agent)/`none` never touch the accountant. When full, `slotAvailable=false` → reconciler returns `none` (queued); nothing breaks, throughput is bounded (§14: "100 watched repos, global_max 2 → 2 run, rest queue").

> **Slot vs. ticking concurrency note (flagged):** the accountant bounds *active workers*. Whether multiple repos' lifecycle passes run concurrently or sequentially within one daemon iteration is an orchestration choice, not a correctness one (the accountant is the gate either way). The simplest correct model — process repos' ticks with bounded parallelism ≤ `global_max`, each issue's active intent guarded by the accountant — is the default. See Open dependencies if a per-issue async-claim race needs a contract-level mutex (it does not in v1: one daemon, in-process accountant).

**Adaptive-poll scheduler (§14).** Per repo, the scheduler tracks `nextTickAt`. After a tick: if the repo had *any* active work this tick (an in-progress/start-new issue), schedule `now + poll_interval_active + jitter`; else `now + poll_interval_idle + jitter`. `jitter` = uniform `[0, poll_jitter]` drawn from an injected RNG (fake/seeded in tests). The clock is injected (`Clock { now(): number; sleepUntil(ts, signal): Promise<void> }` or a timer-wheel the tests advance) so adaptive-interval and jitter selection are asserted deterministically without real time.

**Hot-reload wiring (§5).** A file watcher (chokidar/`fs.watch`, in `cli`/`core` edge) feeds raw text to M1's `ConfigStore.reload(text)` / `WorkflowStore.reload(text)`. On `ok:true` the daemon swaps the live config/settings and re-derives the watch set (config) or that repo's `RepoSettings` (WORKFLOW). On `ok:false` it keeps the previous good value and logs the zod error path. Validation lives in M1's stores; M5 only wires the watcher → store → live-state swap. A swapped-out repo (removed from config) stops being scheduled; a newly-added repo starts on the next scheduler pass.

---

## TDD slices

Convention: each slice is a named **failing** vitest test first, then minimal impl to green. All slices inject the `TickContext` fakes above. Reconciler/loaders/adapter/runner/handoff are consumed as already-tested units — M5 tests assert **orchestration**, not their internals. Use fake timers + an injected `Clock`/RNG for all time/jitter assertions. A `buildContext(partial)` factory yields a valid default `TickContext` overridden per case.

### Part A — single-tick lifecycle (one intent kind per slice)

**A1 — `start-new` executes the New path.**
Test `new issue with a free slot starts work end to end`: reconciler (real, M1) returns `start-new` for a New snapshot with `slotAvailable=true`. Assert the tick: claims a slot, calls `workspace.ensureWorkspace`+`prepareBranch` with the intent's `branch`, `adapter.createBranch` + `adapter.createDraftMR` (draft, `Closes #N`), `adapter.setIssueLabels(set:[inProgress], unset:[])`, posts the "started" comment, then `runner.run`, then maps the result (A6). Assert slot released in `finally`. (Note ordering: branch/MR/label/comment happen before the agent runs, per §7 New row.)

**A2 — `run-agent` resumes an in-progress issue.**
Test `in-progress with slot runs the agent`: reconciler returns `run-agent{resume:true}`. Assert the tick claims a slot, builds `RunnerInput` (`workspaceDir` from `workspace.ensureWorkspace`, `promptBody`, `context` = issue/mr/recentComments from snapshot, `claude` from settings), calls `runner.run` once, releases the slot. No MR/branch creation (already exists).

**A3 — `apply-changes-requested` feeds feedback back to the agent.**
Test `changes-requested re-enters in-progress and runs agent with feedback`: reconciler returns `apply-changes-requested{feedback}`. Assert the tick sets `maestro::in-progress` (unset `in-review`), then runs the agent with the feedback comments threaded into `RunnerInput.context.recentComments`, consuming a slot. Pins §7 In-review→in-progress edge.

**A4 — `merge` merges per WORKFLOW git rules.**
Test `approved in-review merges and consumes no slot`: reconciler returns `merge{strategy, deleteSource}`. Assert `adapter.mergeMR(mrIid, strategy, deleteSource)` called once with values from `RepoSettings.git`; assert the slot accountant is **untouched** (merge is not active work). Issue auto-closes via `Closes #N` (adapter/forge concern; daemon does not re-close).

**A5 — non-acting intents are pure no-ops.**
Test `poll-review / blocked-wait / none touch nothing`: for each of `poll-review`, `blocked-wait`, `none`, assert zero mutating adapter calls, zero runner calls, zero slot changes. Pins §7 In-review-pending / Blocked rows + the queued-`none`.

**A6 — `AgentResult` → lifecycle mapping (§0.9).**
Three tests off a scripted `runner`:
  a. `done → immediate handoff`: `run-agent` whose runner returns `{status:'done'}` → tick invokes `handoff(...)` **this same tick** (not a future one, per §0.4 note); assert `handoff` called once with the issue/MR/reviewer context; assert no `maestro::blocked`.
  b. `needs_input → blocked`: runner returns `{status:'needs_input'}` → tick `adapter.setIssueLabels(set:[blocked], unset:[inProgress])` + `commentIssue` with the agent's summary as the "why"; assert `handoff` NOT called.
  c. `in_progress → stay`: runner returns `{status:'in_progress'}` → tick leaves labels unchanged (stays `maestro::in-progress`), no handoff, no block; resumes next tick.
Pins the exact §0.9 mapping the daemon owns.

### Part B — cleanup sweep (pass B, §0.5)

**B1 — sweep evicts terminal workspaces.**
Test `cleanup sweep evicts closed and missing issues`: seed two workspace dirs for the repo; `adapter.getIssueState` returns `closed` for one, `missing` for the other, `open` for a third. Assert pass B calls `getIssueState` per dir, and `workspace.evict` is called for exactly the `closed`+`missing` dirs, never the `open` one. (The reconciler's `cleanup` branch from `workspaceExists` is M1; here we assert the *sweep* wiring drives it.)

**B2 — sweep is independent of the lifecycle pass.**
Test `cleanup sweep runs even when no open issues are assigned`: `listAssignedOpenIssues` returns `[]` but two terminal workspace dirs exist → sweep still evicts them. Pins §0.5 "two independent passes" — cleanup never depends on the issue being in the open-issue list (the exact contradiction §0.5 fixed).

**B3 — post-eviction fixpoint.**
Test `a second sweep after eviction is a no-op`: run B1's sweep twice; the second observes no dirs (first run removed them) → zero `evict`, zero `getIssueState` (no dirs to check). Pins the §0.5 stable fixpoint.

### Part C — slot accounting (§14)

**C1 — global cap queues excess work.**
Test `global_max=1 lets one issue run and queues the rest`: two repos each with a New issue, `global_max=1`. Assert exactly one issue's `start-new`/agent runs; the other's `reconcile` sees `slotAvailable=false` → `none` (queued); no second `runner.run`. (Assert via the `slotAvailable` the daemon computed, and via runner call count.)

**C2 — per-repo `max_active` caps a single busy repo.**
Test `per-repo max_active=1 caps one repo regardless of global headroom`: one repo, two in-progress issues, `global_max=4`, repo `max_active=1`. Assert only one runs; the second sees `slotAvailable=false`. Pins the resolved per-repo value (M1 OD#6) is honored.

**C3 — only active work consumes a slot.**
Test `merge/poll/blocked do not consume slots`: with `global_max=1` already saturated by one active agent, a *separate* issue in `in-review`/`approved` still `merge`s in the same tick (merge needs no slot). Assert the merge proceeds. Pins §14 "watching ≠ working; only active work holds a slot."

**C4 — slot released after the agent finishes (and on error).**
Test `slot is released in finally even when the agent run throws`: a `run-agent` whose `runner.run` rejects → the tick catches, the slot count returns to baseline, and a subsequent issue can claim it. Pins no slot leak on failure (ties to retry, Part F).

### Part D — adaptive interval + jitter (§14)

**D1 — active repo schedules at `poll_interval_active`.**
Test `a repo with active work polls fast`: after a tick that ran an agent, assert `nextTickAt === now + poll_interval_active + jitter`. Use the injected clock + seeded RNG; assert the base interval is the active one.

**D2 — idle repo schedules at `poll_interval_idle`.**
Test `a repo with nothing in flight polls slow`: a tick with only `none`/`poll-review`/no issues → `nextTickAt === now + poll_interval_idle + jitter`. Pins the active-vs-idle classification (active ⇔ any issue ran the agent or started this tick; `in-review` polling counts as idle for scheduling — it's a cheap re-read).

**D3 — jitter stays within `[0, poll_jitter]` and spreads.**
Test `jitter is bounded and varies`: drive the scheduler with a seeded RNG over many repos; assert every offset ∈ `[0, poll_jitter_ms]` and the set is not all-identical (spread). Pins §14 burst-avoidance.

### Part E — hot-reload (§5)

**E1 — valid config reload swaps and re-derives the watch set.**
Test `valid config reload updates the watched repos`: feed a new valid config text adding a repo → `ConfigStore.reload` returns `ok:true`, the daemon's live watch set now includes the new repo and the scheduler will tick it; a removed repo is dropped. Assert no tick fires for a removed repo afterward.

**E2 — invalid config reload keeps the old value + logs.**
Test `invalid config reload is ignored and logged`: feed malformed text → `reload` returns `ok:false`; assert the live config is unchanged (old watch set intact) and an error carrying the zod path was logged. Pins §5 "validate before reload."

**E3 — WORKFLOW reload re-derives that repo's `RepoSettings`.**
Test `valid WORKFLOW reload updates resolved settings`: change a repo's WORKFLOW (e.g. `merge_strategy: rebase`) → on `ok:true` the daemon re-runs `resolveRepoSettings` and a subsequent `merge` intent uses the new strategy. Invalid WORKFLOW → keep old settings + log (mirror of E2).

### Part F — retry / idempotency (§13)

**F1 — a failed tick is isolated and retried next tick.**
Test `a throwing adapter call does not crash the daemon and recovers next tick`: `getSnapshot` rejects on tick 1 → the tick is caught + logged, no unhandled rejection, the daemon keeps scheduling; on tick 2 the (now-succeeding) adapter drives the issue normally. Pins §13 retry + §3 statelessness (no in-process retry state needed).

**F2 — one repo's failure never blocks another.**
Test `repo A failing still ticks repo B`: tick A's adapter throws; assert repo B's lifecycle pass still runs to completion in the same daemon iteration. Pins per-repo isolation.

**F3 — re-running an already-started tick is idempotent.**
Test `re-ticking a New issue that was already started does not re-create`: tick once (creates branch+MR+label); the next tick's snapshot now shows `maestro::in-progress` → reconciler returns `run-agent`, not `start-new`; assert zero second `createDraftMR`. Pins §0.4 rule 4 idempotency through the daemon (the forge label is the dedup key — no daemon-side state).

### Part G — crash-recovery handoff resume (`workComplete`, §0.4 note / M4)

**G1 — `workComplete` drives the standalone `handoff` intent.**
Test `an in-progress issue whose work is complete but handoff incomplete resumes handoff`: snapshot = `maestro::in-progress`, MR draft, M4 detector (done sentinel + all boxes checked) true → the daemon computes `workComplete=true`, feeds it to `ReconcileInput`, reconciler returns `handoff` (not `run-agent`), and the tick invokes `handoff(...)`. Assert no slot consumed (handoff is not active agent work) and no `runner.run`. This is the crash-recovery path: a prior tick ran the agent to `done` but died before completing handoff; this tick re-detects and resumes via M4's idempotent sequence (M4 Slice 7).

**G2 — `workComplete=false` keeps normal resume.**
Test `incomplete work resumes the agent, not handoff`: same `in-progress` label but detector false → `workComplete=false` → reconciler returns `run-agent`. Pins the two cases the injected boolean distinguishes (the exact gap M1 OD#1 flagged, resolved by M0 amendment — see Open dependencies).

### Part H — composition / full single-tick wiring

**H1 — a full tick runs both passes in order.**
Test `tickRepo runs lifecycle then cleanup`: with both an open assignable issue and a terminal workspace dir, assert pass A (lifecycle) and pass B (cleanup sweep) both execute in one `tickRepo` call, lifecycle first. Locks the two-pass §0.5 structure at the orchestration boundary.

**H2 — forge selection by `RepoRef.forge`.**
Test `the daemon picks the adapter matching the repo's forge`: given a GitLab repo and a GitHub repo with two registered adapters, assert each repo's tick uses the adapter whose `kind === repo.forge`. Pins the M7 drop-in seam (no daemon change when GitHub lands).

### Part I — documented E2E smoke (NOT in the unit suite; spec §15/§16)

**I1 — canonical end-to-end vertical slice (manual/gated integration).**
A scripted smoke, run against a **scratch GitLab project** (throwaway, §15), gated behind an env flag (e.g. `MAESTRO_E2E=1`) and excluded from the default `pnpm test`. Steps, asserted by polling GitLab:
  1. Config points at the scratch repo with a committed WORKFLOW.md (`proof.type: diff-summary` to avoid Chromium/RAM in CI; playwright path is covered by M4 unit tests).
  2. A human assigns a prepared issue to `bot_user`.
  3. Run the daemon for a bounded number of ticks (or until state reached): assert it creates the branch + draft MR (`Closes #N`), labels `maestro::in-progress`, comments "started", runs the (real) agent to `done`, runs handoff (proof comment on issue+MR, reviewer = ticket creator assigned, MR un-drafted, `maestro::in-review`).
  4. A human approves the MR.
  5. Next tick: assert the daemon merges per WORKFLOW git rules and the issue auto-closes (`Done`).
  6. Next tick: assert the cleanup sweep evicts the issue's workspace dir.
This is the spec's "canonical end-to-end test" (§15) and the headline exit item. It uses the **real** GitLab adapter (M2), real `ClaudeRunner` (M3), real workspace + handoff — the only place real I/O runs. Document the scratch-project setup + teardown in the test header; it is opt-in, not part of CI's default gate (CI runs typecheck + unit + lint per M0 §0.11).

---

## Exit gate (checklist)

- [ ] **HEADLINE — vertical slice New→Done (I1):** the documented E2E smoke against a scratch GitLab project drives one assigned issue `New → in-progress → handoff → in-review → (human approve) → merge → Done → workspace evicted`, fully automated except the approval. This is the spec's §15/§16 acceptance and the milestone's reason to exist.
- [ ] Single-tick lifecycle green for every acting intent: `start-new` (A1), `run-agent` (A2), `apply-changes-requested` (A3), `merge` (A4); non-acting intents are no-ops (A5).
- [ ] `AgentResult` mapping (A6) green for all three statuses: `done`→immediate handoff, `needs_input`→blocked+comment, `in_progress`→stay.
- [ ] Cleanup sweep (B1–B3): evicts closed+missing, independent of the open-issue list, stable fixpoint after eviction.
- [ ] Slot accounting (C1–C4): global cap queues, per-repo `max_active` caps, only active work consumes a slot, slot released in `finally` on error. No slot leak.
- [ ] Adaptive scheduler (D1–D3): active→fast, idle→slow, jitter bounded `[0, poll_jitter]` and spread — all via injected clock + seeded RNG, no real time.
- [ ] Hot-reload (E1–E3): valid→swap (config watch-set + WORKFLOW settings re-derived), invalid→keep-old+log. Validate-before-reload proven.
- [ ] Retry/idempotency (F1–F3): a failing tick is caught + retried next tick, repos isolated, re-ticking is idempotent (forge label is the dedup key; no daemon state).
- [ ] Crash-recovery handoff (G1–G2): `workComplete` distinguishes resume-handoff from resume-agent; standalone `handoff` consumes no slot.
- [ ] Composition (H1–H2): both passes run in order; adapter selected by `RepoRef.forge` (M7 drop-in proven).
- [ ] `core` daemon logic imports **only** frozen contracts + M1–M4 units; the `cli/daemon.ts` entrypoint is thin (loads config, builds adapter, runs scheduler) with zero business logic. No `process.argv`/server in `core`.
- [ ] The daemon redefines **no** frozen contract type; any field it needs that M0 lacks is recorded in §0.10 (see Open dependencies) before impl — never invented inline.
- [ ] `pnpm -r typecheck && pnpm -r test && pnpm lint` clean (unit suite excludes the E2E smoke, which is env-gated).

---

## Cross-cutting (QA + Security)

**QA:**
- The daemon is the integration nexus — its unit tests must assert **wiring and ordering**, treating M1–M4 as black boxes. Spy/recorder fakes (adapter call order, runner call count, handoff invocation, slot deltas) are the right granularity; do not re-test reconciler branches (M1) or runner parsing (M3) here.
- Time and randomness are injected (Clock + RNG). A real `setTimeout`/`Date.now`/`Math.random` in `core/daemon` is a test-flakiness bug — assert their absence (lint/grep) the way M1 asserts the reconciler is I/O-free.
- The cleanup-sweep fixpoint (B3) and the retry-idempotency (F3) tests are the statelessness proof (§3): the daemon holds **no** durable state; truth is forge + disk. A regression that adds in-process state (a "seen issues" set, a retry counter) breaks crash-recovery and must fail a test.

**Security (§13, §13.1, §14):**
- **§14 sizing / OOM / disk breakers are ops guards, documented not coded.** `global_max` sized to RAM is the real OOM protection (`global_max ≈ (RAM_MB − ~512) / per_worker_peak_MB`; 4 GB box → 1–2). The daemon's only code-level contribution is *honoring* the cap (slot accounting, Part C) so it never exceeds configured `global_max` — it does **not** measure RAM or kill on OOM. Disk is bounded by the M3 `WorkspaceManager` LRU at `workspaces.disk_cap`; the daemon triggers eviction via the sweep + relies on M3's cap. Document both breakers in the module header.
- **systemd `MemoryMax` backstop (§14).** Ship the `maestro.service` unit (or document it for M8) with `MemoryMax=3500M` and `Restart=always`. This is the last-line OOM kill; restart loses nothing (stateless). Code can't replace correct `global_max` sizing — say so explicitly.
- **Double-claim hazard (§14) — operational guard, not code.** A repo must be watched by **exactly one** install per `bot_user`; two daemons sharing a repo+bot could both claim the same assigned issue (the in-process `SlotAccountant` does not coordinate across installs — there is no cross-install arbitration in v1, §17). Enforce one-repo-one-install by convention or distinct bot users. Document prominently in the daemon header and ops docs; do **not** build a distributed lock (explicitly deferred, §17).
- **Prompt injection blast radius (§13.1).** The daemon orchestrates the agent run that consumes attacker-controlled issue text on public repos. M5 does not mitigate prompt injection (deferred containers, §17 / public-repo opt-in, M8). M5's obligation: keep secrets out of the agent's env (tokens flow via the M3 credential helper, never into `RunnerInput`/workspace env — §0.8/M3 OD-5), honor `permission_mode` verbatim, and never key any daemon control decision off issue/comment *content* (the reconciler already treats it as opaque data, M1 security).
- **Token handling (§0.8).** The daemon reads `process.env[token_env]` at the edge to construct the adapter; tokens flow to subprocesses only via `ExecOptions.env`/credential helper, never argv, never logged. The adapter (M2) and runner/workspace (M3) own the actual subprocess token-passing; the daemon must not log the resolved token and must not place it in any scheduler/log line.

---

## Open dependencies

Genuine gaps where M5 needs something the frozen M0 contracts don't yet define. Each must be reconciled into M0 §0.10 **additively** before M5 impl lands — no inline invention. All are the additive amendments M1/M3/M4 already proposed; M5 is written assuming they land.

1. **`workComplete` field on `ReconcileInput` (M1 OD#1 / §0.4 crash-recovery note).**
   *Gap:* `ReconcileInput` (§0.4) carries `snapshot`, `settings`, `slotAvailable`, `workspaceExists` — no signal to distinguish "resume agent" from "resume handoff" for an `in-progress` issue. M1 left slice A9 `xit`-skipped pending this.
   *Why M5 needs it:* slices G1/G2 require the daemon to compute the M4 detector and pass it in so the reconciler can return the standalone `handoff` intent on crash recovery.
   *Proposed fix (additive):* add `workComplete: boolean` to `ReconcileInput`; the daemon computes it from the M4 detector (`workComplete(snapshot)` in `TickContext`) and passes it. Reconciler rule: `in-progress + workComplete → handoff`; `in-progress + !workComplete + slot → run-agent`. Predicate stays in M4, wiring in M5, reconciler stays pure. **Requires the M0 §0.10 entry M1 OD#1 proposed.**

2. **`ProofResult` type + `done` sentinel constant (M4 OD#1, OD#3).**
   *Gap:* the daemon's `done→handoff` path (A6a) invokes M4's `handoff(...)`, which returns/consumes `ProofResult` and uses the `done` sentinel marker for crash-recovery detection (which M5 also reads to compute `workComplete`). Neither is in §0.2–§0.9.
   *Why M5 needs it:* `workComplete` (dep #1) is computed partly from "the `done` sentinel comment is present"; M5 must import the **same** sentinel constant M4 writes, not re-define it.
   *Proposed fix (additive):* M0 freezes `contracts/proof.ts` with `ProofResult`/`ProofStrategy`/`ProofInput` and the sentinel constant (e.g. `<!-- maestro:proof:done -->`) per M4 OD#1/OD#3. M5 imports the sentinel for its `workComplete` detector and the `HandoffFn` signature. **M0 §0.10 entry, as M4 proposed.**

3. **`AbortSignal` on `ExecOptions` (M3 OD-4).**
   *Gap:* §0.8 `Exec` has no cancellation primitive; the runner's stall-kill (M3 RUN-5) needs it.
   *Why M5 needs it (indirectly):* M5 relies on the runner returning `in_progress` on stall so the next tick resumes; that behavior depends on the M3 abort path. No new M5-specific field, but M5's stall-handling story assumes this amendment is in place.
   *Proposed fix (additive):* `signal?: AbortSignal` on `ExecOptions`, per M3 OD-4 + its §0.10 entry. M5 needs nothing beyond M3 adopting it.

4. **Resolved per-repo `max_active` has no home in a frozen type (M1 OD#6).**
   *Gap:* `RepoSettings` (§0.4) carries no concurrency field; M1's `resolveRepoSettings` returns the resolved `max_active` as a sibling value. M5's `SlotAccountant` consumes it.
   *Why M5 needs it:* per-repo slot cap (C2) keys off this number.
   *Proposed fix (additive, low-risk):* M5 consumes M1's sibling return value directly (no contract change strictly required), OR M0 adds `concurrency: { maxActive: number }` to `RepoSettings` for a single tidy carrier. **Prefer the additive `RepoSettings.concurrency` field** so the value travels with the rest of the resolved settings into the daemon; record in §0.10. If M0 declines, M5 threads the sibling value through `TickContext.resolvedConcurrency` (shown above) with no frozen-type change.

5. **`HandoffFn` signature (callable shape of M4's handoff unit).**
   *Gap:* M4 exposes a "callable unit" `handoff(...)` but its exact parameter list is defined in M4, not M0. M5 invokes it on `done` (A6a) and on crash recovery (G1).
   *Why it matters:* the daemon must call it with a stable signature (adapter + snapshot/settings + proof selection); if M4's shape and M5's call drift, the wiring breaks — the exact rot M0 forbids.
   *Proposed fix:* M4 publishes the `handoff` function signature (likely `(deps: { adapter; exec; proof: ProofStrategy }, ctx: { snapshot; settings }) => Promise<void>`) as part of its deliverable; M5 imports it verbatim. If it needs to be a frozen contract (because both M4 and M5 reference it), add it to `contracts/handoff.ts` + §0.10. **Flagging uncertainty:** I did not invent the signature here — M4 owns it; M5 assumes whatever M4 ships and calls it through the `HandoffFn` seam in `TickContext`.

Everything else M5 needs is already frozen in §0.2–§0.9 and provided by M1–M4. No other contract gaps.
