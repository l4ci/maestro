# CI-status rework — gate handoff on the pipeline, auto-fix red CI

- **Date:** 2026-06-11
- **Status:** Approved (brainstorm), pending implementation plan
- **Extends:** `2026-06-03-maestro-design.md` §7 (in-review→in-progress edge), §0.3 (edge-triggered changes-requested)

## 1. Goal

Make the head commit's CI conclusion a reconciler input so maestro:

1. **never hands a red-CI MR to a human** — the handoff is held until CI is conclusive, and
2. **auto-bounces a failing pipeline back to the agent**, threading the failing job
   logs in as context, clearing itself on the next push exactly like the
   changes-requested edge.

Today the reconciler is structurally blind to CI: `MergeRequest` (§0.2) carries
`state`, `isDraft`, `labels`, `approvals` — no pipeline status. A ticket can pass
local proof, hand off, and sit in front of a human with red CI; the human has to
notice, request changes, and bounce it manually. CI runs strictly more than local
proof (lint, typecheck, integration, OS matrix) and repos using `diff-summary` /
`none` proof run no tests at all, so CI is a genuine additional gate.

## 2. The core realization

CI is **a third blocking surface that clears the same way every other one does.**
`snapshot.ts` already folds two blocking timestamps (`blockingThreadAt`, the
issue-thread `/maestro` command) through `laterOf` → `computeChangesRequested`,
self-clearing against `lastBotPushAt`. CI fits the same shape — with one twist the
others lack: a **running** state. So CI cannot be a pure boolean; it is a three-way
gate read directly off world state (the head commit's pipeline), in the spirit of
the #29 "the world state IS the origin" decision (`reconcile.ts` `deriveStage`).

## 3. Decisions (locked in brainstorm)

| Decision | Choice | Rationale |
|---|---|---|
| Where CI gates | **Only the handoff transition** (both FSMs) | Smallest seam; the whole value is "don't ping a human on red CI" |
| Signal source | **Head commit of the source branch** — pipeline conclusion read directly | World state, not stored state; no timestamp bookkeeping for the decision |
| Three-way gate | `failed`→fix · `running`→wait · `success`/`none`→pass | `running` is the state thread/approval edges don't have; must hold, not bounce |
| No-CI repos | `none` conclusion ⇒ `pass`, automatically | Repos without pipelines are unaffected for free |
| Opt-in | `ci.gate` per repo, **default off** | Slow/flaky/manual pipelines could otherwise stall handoffs; mirrors #29 opt-in |
| Rework context delivery | Daemon posts failing logs as a **forge comment** (sentinel-keyed on head sha) | Forge-is-memory: context for the agent + visibility for humans + idempotency, no daemon state |
| Loop control | **Round cap** (count CI-fail sentinel comments since last human comment) → park as `blocked` | Mirrors the review bounce cap and proof-failure 3-strike; prevents thrash on an unfixable failure |
| Stuck CI | `ci.wait_timeout`: `running` past the timeout ⇒ `pass` (hand off anyway) | Pathological / external CI must not block handoff forever |

## 4. Model (`contracts/forge-model.ts`)

```ts
export interface CiStatus {
  conclusion: 'success' | 'failed' | 'running' | 'none'; // head-commit pipeline
  at?: string;     // ISO; conclusion/update time — round-cap + wait_timeout window
  webUrl?: string; // link to the failing pipeline/run, surfaced in the comment
}
```

Add `ci?: CiStatus` to `MergeRequest`, plus the zod schema in `contracts`. It
describes the **head commit of the source branch** and is read directly each tick —
no `lastBotPushAt` comparison needed for the decision (a fresh push changes the head
sha → new pipeline → `running`, which the gate already holds on).

## 5. Snapshot primitive (`forge/snapshot.ts` + both adapters)

New `ForgePrimitives` member, the mirror of `blockingThreadAt`:

```ts
/** Head-commit pipeline conclusion for the MR's source branch. `none` if no pipeline. */
ciStatus(mr: MergeRequest): Promise<CiStatus>;
```

Composed in `findMaestroMr`, **short-circuited like the push read**: only fetched
when an MR is open (skip merged/closed) and only when `ci.gate` is on. One API call
per active MR per tick; adaptive polling already throttles idle repos.

- **GitLab** (`gitlab-adapter.ts`, beside `#lastBotPushAt`): MR `head_pipeline.status`
  → `success`/`skipped`/`manual` → `success`; `failed`/`canceled`/`timed_out` →
  `failed`; `pending`/`running`/`created` → `running`; absent → `none`.
- **GitHub** (`github-adapter.ts`): `/commits/{headSha}/check-runs` + combined commit
  status → `failure`/`timed_out`/`cancelled` → `failed`; `queued`/`in_progress` →
  `running`; all success/neutral/skipped → `success`; none → `none`.

The mapping lives once, above the adapter seam, beside `computeChangesRequested`
(a normalization bug fails AT assembly via `checkPiece`, not in the reconciler).

## 6. Reconciler (`reconciler/reconcile.ts` + `contracts/reconciler.ts`)

A pure helper used at **both** handoff gates — the legacy `workComplete → handoff`
(`reconcile.ts` `case 'in-progress'`) and the pipeline `passed → handoff`
(`reconcilePipeline` `case 'in-progress'` / `phase: 'passed'`):

```ts
function ciGate(snapshot, settings, now): 'pass' | 'wait' | 'fix' {
  if (!settings.ci.gate) return 'pass';
  const ci = snapshot.mr?.ci;
  const c = ci?.conclusion ?? 'none';
  if (c === 'failed')  return 'fix';
  if (c === 'running') {
    return ci?.at && agedPast(ci.at, settings.ci.waitTimeout, now) ? 'pass' : 'wait';
  }
  return 'pass'; // success | none
}
```

> `now` enters via `ReconcileInput` (the reconciler stays pure — the daemon passes a
> tick timestamp, as it already does nowhere today; alternative: fold the timeout
> check into the daemon and keep `ciGate` two-valued at the FSM. See §10 open item.)

Handoff sites become:

```ts
if (workComplete) {
  switch (ciGate(snapshot, settings, now)) {
    case 'fix':  return ciFixIntent(snapshot, settings); // bounce, or block over cap
    case 'wait': return { kind: 'none', reason: 'ci running — holding handoff' };
    case 'pass': return { kind: 'handoff' };
  }
}
```

New intent on `contracts/reconciler.ts`:

```ts
| { kind: 'apply-ci-fix'; feedback: AgentFeedback }
```

**Round cap, stateless.** `ciFixIntent` counts CI-fail sentinel comments since the
last human comment — the exact idiom in `analyzeReview` (review bounce cap) and
`proof-failure.ts` (3-strike). Under cap → `apply-ci-fix`. Over cap → a `blocked`
park (label + a comment carrying the logs and `@`-mentioning the human), reusing the
review-bounce-cap escalation shape. The window resets on any human comment by
construction.

## 7. Executor (`daemon/executor.ts`)

`apply-ci-fix` runs as the mirror of `runApplyChanges`:

1. Fetch failing job logs — `glab ci view <sha>` / `gh run view --log-failed` —
   truncated to a bound.
2. **Post them as a forge comment** carrying `CI_FAIL_SENTINEL` keyed on the head
   sha. Idempotent: if a comment for this sha already exists, skip the re-post and
   just re-run. The comment is human-visible AND becomes agent context for free via
   the existing comment-context path (`run-agent` feeds `recentComments`).
3. `applyIntentMove` back to `in-progress`, then `runAgent` with the CI-failure
   comment in context (built-in framing: "CI failed on the latest push — fix it").
4. The agent's next push changes the head sha → new pipeline → `running` → the gate
   holds → re-evaluates on conclusion. No daemon-side CI state persisted.

## 8. Config & WORKFLOW (`config` loader + `workflow` front-matter → `RepoSettings.ci`)

```yaml
ci:
  gate: false          # opt-in per repo; default off
  wait_timeout: 20m    # running longer than this ⇒ hand off anyway (stuck/external CI)
  max_fix_rounds: 3    # CI-fix bounces before parking as blocked
```

Resolved into `RepoSettings.ci` (config default ⊕ repo override ⊕ WORKFLOW front
matter, like every other setting). `gate: false` makes `ciGate` a constant `pass`,
so the legacy FSM stays byte-for-byte for every repo that doesn't opt in.

## 9. Contracts & modules touched

**New:**
- `CiStatus` type + `ci?` on `MergeRequest` (`contracts/forge-model.ts`) + zod schema.
- `ForgePrimitives.ciStatus` (`forge/snapshot.ts`) + GitLab/GitHub implementations.
- `ciGate` + `ciFixIntent` helpers and the `apply-ci-fix` intent (`reconciler/`).
- `CI_FAIL_SENTINEL` in `contracts`; built-in CI-fix agent framing (`runner`/`workflow`).
- `runApplyCiFix` executor handler (`daemon/executor.ts`).
- `RepoSettings.ci` + config/WORKFLOW parsing.

**Unchanged when `ci.gate` is off (asserted by test):** `deriveState`, `deriveStage`,
every existing intent. CI gating is purely additive and gated behind the opt-in.

## 10. Open items / decisions surfaced

- **Strict vs lenient gate.** Spec ships **strict** (`running` ⇒ wait, with
  `wait_timeout`). Lenient (act only on `failed`, hand off while running) drops the
  timeout but lets a human be pinged seconds before CI goes red. Recommend strict.
- **`now` in the reconciler.** The `wait_timeout` check needs a clock. Either thread
  a tick timestamp into `ReconcileInput` (keeps the gate whole, reconciler still pure)
  or evaluate the timeout in the daemon and keep `ciGate` two-valued. Lean: thread the
  timestamp — one field, no logic split.
- **FSM equivalence test.** `reconcile-fsm-equivalence.test.ts` gains a documented
  divergence (D4: CI gate) that is inert while `gate: false`, so legacy/pipeline
  equivalence is unaffected for non-opted repos.

## 11. MVP (de-risk first)

Model + GitLab-only `ciStatus` + the `failed → bounce` path with a hardcoded
1-round cap, no `running`-wait, no timeout. Prove the loop end-to-end on maestro's
own repo (which has CI), then layer on `running`/`wait_timeout`, GitHub, the round
cap + `blocked` escalation, and the pipeline-FSM handoff site.

## 12. Out of scope (v1)

- Re-checking CI **after** handoff (in-review) and bouncing on a regression — the
  changes-requested edge already covers human-driven bounces; a CI-regression edge in
  review is a follow-up.
- Per-job granularity / selective re-run — maestro reacts to the aggregate head-commit
  conclusion only.
- Waiting on `manual`/`action_required` pipelines as a distinct state (folded into
  `success` for v1; they don't block handoff).
- Triggering or re-running CI from maestro (it only reads conclusions).
