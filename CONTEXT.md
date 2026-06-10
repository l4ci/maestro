# Context

Domain and architecture vocabulary for Maestro. The broad glossary lives in the design
spec ([`docs/superpowers/specs/2026-06-03-maestro-design.md`](docs/superpowers/specs/2026-06-03-maestro-design.md))
§0–§8; this file records terms introduced by architecture work so reviews stay consistent
and don't re-litigate settled seams.

## Forge adapter internals

The **forge adapter** (`ForgeAdapter`, spec §0.3) is the only forge-aware seam: GitLab and
GitHub each satisfy it, normalizing to the §0.2 model so the reconciler stays forge-agnostic.
Beneath that public interface, two shared modules carry what used to be duplicated per forge:

- **ForgeCli** (`forge/cli.ts`) — the shared REST/GraphQL transport over a forge binary
  (`glab` / `gh`), parameterized by `{ bin, forge, env, botUser }`. Token rides in env, never
  argv; 404 → `null`. Both adapters construct one; the per-forge `*ClientConfig` is just its
  construction config. _Do not re-split into per-forge client classes_ — the binary/env/flag
  differences are config, not behavior.

- **Snapshot assembly** (`forge/snapshot.ts`) — the forge-agnostic choreography that turns one
  issue into an `IssueSnapshot`: fetch issue (+ lastActor), find the maestro MR, fill its
  `ApprovalState`, sort/cap comments. Includes the **edge-triggered changes-requested**
  comparison (`computeChangesRequested`): changes are outstanding iff a blocking thread
  post-dates the last bot push. Lives once, above the **ForgePrimitives** seam.

- **ForgePrimitives** (`forge/snapshot.ts`) — the narrow seam the snapshot algorithm composes:
  each adapter supplies only forge-specific *fetches* returning normalized model pieces plus the
  two edge-trigger timestamps (`blockingThreadAt`, `lastBotPushAt`). A third forge writes
  primitives, never an algorithm — this is the same property the spec §8 calls the GitHub
  milestone's "zero-change" headline, now extended below `getSnapshot`.

  `lastBotPushAt` is the newest commit on the MR branch **author-agnostic** — _not_ filtered by
  `bot_user`. The daemon owns the branch, so any commit post-dating the blocking signal means the
  work was redone. Filtering by author stranded the timestamp on shared accounts (bot account ==
  operator account: the agent's commits wear the operator's git identity) and the issue bounced
  in-review↔in-progress forever (issue #5). Do not re-add an author filter here.

## Forge wiring

The **forge wiring** module (`core/src/compose/forge-wiring.ts`, built 2026-06-10, PR #98) is the one
place forge-aware construction lives: token-env lookup, botUser-per-host resolution, the
GitLab/GitHub adapter choice, plus the static settings path (config parse, WORKFLOW.md cache read
with bootstrap-template fallback) that `cli/main` and `web/main` previously each implemented.
Interface: `composeForges(config, exec) → { adapterFor, settingsFor }` plus the bare adapter
constructor for the daemon's upfront `buildAdapters`. Direct `process.env`/fs I/O is in-contract —
this *is* the composition layer; tests use temp dirs and env vars. The daemon's hot-refresh
settings path (`deriveCell`/WorkflowSource) is intentionally NOT behind this interface — its
validate-before-swap semantics differ from the static read.

Known gap, out of scope for the extraction: the daemon builds adapters once at startup and never
rebuilds them on config hot-reload (a forge host added live gets no adapter until restart). The
wiring module makes that later fix one-place.

## Claim

A **claim** (`daemon/claims.ts`, built 2026-06-10, PR #99) is the daemon's unit of work admission
— one object owning both concurrency resources for one unit of work (an issue, or a command MR):
**uniqueness** (not already being worked; internally `InFlightSet`) and **capacity** (a worker
slot under global and per-repo caps; internally `SlotAccountant`). Interface:
`claims.open(key, iid, scope = key) → Claim | null` (null = already in flight, claimed before any
await; the command-MR pass passes a distinct `scope` so issue iid 5 and MR iid 5 never collide
while the SLOT stays keyed on the repo — one shared per-repo budget, §14),
`claim.slotAvailable(max)`, `claim.holdSlot()` (called once in
`beginIntent`, keyed on the slot-consuming intent set — not per switch case), `claim.close()`
(releases whatever is held, idempotent, the only release path). SlotAccountant and InFlightSet
survive as internal seams behind the Claims interface; only Claims is exported. `holdSlot` is
deliberately uncheck-and-take like today's `acquire` — capacity policy lives in the reconciler via
`slotAvailable`, not in the claim.

## After-run edge

The **after-run edge** (`reconciler/after-run.ts`, built 2026-06-10, PR #101) is the pure
runner-result half of the issue lifecycle: `decideAfterRun(result, { hasMr, rolesDeclared }) →
AfterRunDecision`, a tagged union in the Intent idiom (`pause-spawns` / `proof-and-handoff` /
`proof-only-then-in-review` / `no-mr-error` / `mark-blocked` / `wait`). It lives beside
`reconcile.ts` so every lifecycle decision — pre-run and post-run — reads from one directory; the
tick's `applyAgentResult` shrinks to recordPlan (every kind except `pause-spawns`) plus one
effects-only switch. Same idiom as the reconciler and `decideMrCommand`: decisions are pure edges,
the tick only executes.

## Lifecycle move

A **lifecycle move** (`reconciler/transitions.ts`, built 2026-06-10, PR #103) is the write-side counterpart
of the pure lifecycle edges: a named label transition owned by one pure table,
`lifecycleMove(move, labels, role?) → { set, unset }` in `reconciler/transitions.ts` — the write
half beside the read half (`deriveState`/`deriveStage`). Moves preserve today's exact label pairs
(`begin-work`, `begin-work-from-plan`, `enter-define`, `resume-from-review`, role-aware `unblock`,
`park-blocked`, `enter-review`, `mark-queued`, `retract-queued`); the tick and handoff keep their
own `setIssueLabels` calls and just spread the table's result. Two constraints are load-bearing
and forbid a "clear all other labels" normalization: the human-set `todo` definition gate must
survive every move, and a non-implement `unblock` sets NO stage label (artifacts carry the stage,
#29). The queued marker is capacity, not stage — its set/retract are moves like any other.

## Progress mirror

The **progress mirror** (`daemon/progress-mirror.ts`, built 2026-06-10, PR #104) is a daemon-owned,
marker-delimited region (`<!-- maestro:progress:start/end -->`) inside the MR description,
listing the branch's commit subjects (chronological, capped at 50 with a truncation note). It is
the FALLBACK "where it's at" when a session dies before emitting `mrDescription` — the
agent-emitted todo stays the primary channel and owns everything outside the markers. Refresh is
**every due tick** for issues with a maestro MR, compare-and-skip against the snapshot's already
fetched `mr.description` (one write only on change; a post-run hook would miss stall-kills, the
motivating failure on #84). `recordPlan`'s full-description overwrite is healed by the next
tick's upsert. The region transform is a pure helper; commits come from `listMrCommits` — on
GitHub the same `/pulls/:n/commits` endpoint as `lastBotPushAt`, on GitLab the MR-scoped
`/merge_requests/:iid/commits` (NOT `/repository/commits?ref_name=` — that lists the branch's
full ancestry including target-branch history). An empty commit fetch skips the write entirely
so a transient miss never wipes a live region. v1 mirrors commits only — NO fuzzy-matching
commit text to plan checkboxes (decided in the issue).

## Intent executor

The **intent executor** (`daemon/executor.ts`, decided 2026-06-10 round-2 review, built
2026-06-10) is the effect-side counterpart of the pure edges: one module owning the
workspace → run → push → record → move choreography that the eight `run*` handlers in `tick.ts`
and the command-MR `runMrCommand` each re-implement today. Interface:
`executeIntent(intent, snapshot, ctx: ExecutorContext)` (plus the command-MR entry) — the switch
and the thin per-intent functions live INSIDE the module sharing private helpers; a declarative
plan table was rejected (verdict handling and AC-draft comments don't fit data). The executor
owns a small intent-kind → LifecycleMove map (the reconciler's Intent contract does NOT gain a
move field). `ExecutorContext` is a narrow subset of TickContext — the tick keeps claims/slots
and rate-gating, the executor gets only what execution needs. The command-MR run path folds in
the same slice; mr-command-pass keeps its claim loop and pure decide.

## Proof-failure escalation

Proof generation has a typed error mode (decided 2026-06-10, not yet built):
`ProofGenerationError` (strategy + cause) thrown at the proof seam; a per-issue in-memory
consecutive-failure streak in the daemon (restart resets it — acceptable); a pure
`decideProofFailure(streak)` edge beside the after-run edge returning retry-proof (streak < 3) or
park-blocked with a comment carrying the failure reason. Counter clears on success; a human
reply un-parks via the existing unblock edge. Replaces the silent identical-retry-forever loop.
Ships with the missing crash-recovery (agent-done → daemon restart → idempotent handoff)
integration test.

## Snapshot validation

`assembleSnapshot` verifies the ForgePrimitives promise (decided 2026-06-10, not yet built): zod
schemas for the §0.2 model pieces (Issue, MergeRequest, Comment — core already ships zod for the
same semi-trusted-input reason as WorkflowSchema), `safeParse` at assembly, throw naming the
forge and field path. Normalization bugs surface at the seam that promised them away instead of
in the reconciler or views; a third forge inherits the contract check for free.

## Workspace seam (deferred)

The task-level workspace seam (raise the 8 granular git/fs methods to
acquire-workspace → run-task → push so a container backend wraps whole task lifecycles) is
DEFERRED (decided 2026-06-10): one adapter exists, nothing varies across the seam. Trigger to
revisit: the container backend becoming real. Until then all workspace choreography routes
through the intent executor, making the later raise a one-caller change. Do not re-propose while
the host backend is the only adapter.

## Public vs. runtime surface

Core presents two interfaces via package.json subpath exports (decided 2026-06-09, built
2026-06-10 in `public.ts`/`runtime.ts`): `@maestro/core` is the **public surface** — contracts,
pure reconciler edges, view assembly, onboarding, forge wiring, config/WORKFLOW parsing, log +
heartbeat READING — the only thing cli/web may import; `@maestro/core/runtime` is the **runtime
surface** — daemon internals (tick, ClaudeRunner, WorkflowSource, proof, handoff, heartbeat
writer, hot-reload stores, workspace plumbing) — imported only by the daemon composition
(`cli/daemon.ts`). One deliberate exception: the `WorkspaceManager` class stays public because
`cli/main.ts` constructs it (`maestro add` bootstrap-PR wiring, `maestro run` attach); its
path/auth internals do not follow it. The forge adapter classes (ForgeCli, GitlabAdapter,
GithubAdapter, snapshot plumbing) are exported from NEITHER surface — composeForges /
makeForgeAdapter are the way in (#90). Node resolution enforces the seam (pinned by
`cli/test/core-surface.test.ts`); the flat `index.ts` grab-bag is gone.

## Authorized actor

`isAuthorizedActor(username | undefined, allowedActors)` (`security/authorized-actor.ts`, built
2026-06-10, PR #97) is the one implementation of the trigger allowlist rule: empty list →
allowed; missing username with a non-empty list → fail-closed. Both the issue trigger guard
(`reconcile.ts`) and the command-MR edge (`mr-command/decide.ts`) call it; `isHumanComment` stays
separate in the MR path. security/ is neutral ground, so the mr-command thesis guard (reconciler
stays MR-free) is unaffected.

## Reconciler FSMs (legacy + pipeline)

The two FSMs in `reconcile.ts` (legacy `deriveState` switch vs. role-pipeline `deriveStage`,
toggled by `rolesDeclared`) stay separate (decided 2026-06-09; outcome 2026-06-10). The property
test (`reconcile-fsm-equivalence.test.ts`, PR #100) enumerated the input grid exhaustively: the
FSMs are equivalent everywhere EXCEPT three deliberate divergences — D1 the internal review gate
(#29 P3), D2 queue visibility (`mark-queued`, #53), D3 label-derived state vs. artifact-derived
stage. Unification is therefore off the table; the test pins the equivalence everywhere else and
the divergence zones are envelope-guarded. Do not re-propose unifying these FSMs — the
differences are features, not drift (details: issue #93 comment).

## Command MR

A **command MR** is an open MR/PR assigned to the bot that has **no backing issue**, carrying a
body-start `/maestro <instruction>` comment from an authorized human. It is the only non-issue
trigger (spec `2026-06-09-mr-command-trigger-design.md`). The **command-MR pass**
(`daemon/mr-command-pass.ts`) runs each tick beside the issue lifecycle: list bot-assigned MRs →
keep only standalone ones (`isStandaloneMr` — not a `maestro/issue-*` branch, no `Closes #N`; the
issue path owns the rest) → `decideMrCommand` (a pure edge, the MR-thread mirror of the issue
reconciler) → run the agent on the one instruction → push iff it committed → **always reply**.

The edge is **edge-triggered and self-clearing on the reply**: a command is pending iff the newest
authorized `/maestro` comment post-dates the bot's newest reply (the comment carrying
`MR_COMMAND_REPLY_SENTINEL`). The reply is posted on every terminal path, so the edge can never loop
— stronger than the issue changes-requested edge, which clears on a push that might not happen (cf.
issue #5). The issue reconciler stays free of all this (thesis guard in `mr-command-thesis.test.ts`).
