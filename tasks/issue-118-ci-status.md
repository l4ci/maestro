# Issue #118 — CI-status rework (MVP)

Spec: `docs/superpowers/specs/2026-06-11-ci-status-rework-design.md` §11 (MVP).
Branch: `issue-118-ci-status-rework`. TDD throughout.

MVP scope: model + GitLab-only `ciStatus` + `failed → bounce` at the legacy
handoff gate, hardcoded 1-round cap. No `running`-wait, no `wait_timeout`, no
GitHub, no pipeline-FSM site (deferred to follow-ups).

## Cycles (test-first each)

- [x] **C1 — Model**: `CiStatus` type + `ci?` on `MergeRequest`; `CiStatusSchema`
  wired into `MergeRequestSchema`; static type-tie updated.
- [x] **C2 — Settings**: `RepoSettings.ci: { gate: boolean }`; threaded through
  `resolveRepoSettings` + WORKFLOW schema (`ci.gate`, default false).
- [x] **C3 — Reconciler `ciGate`** (core): legacy `workComplete → handoff` gate.
  gate off → handoff; failed+under-cap → `apply-ci-fix`; success/none/running →
  handoff; failed+cap-reached → handoff. New `apply-ci-fix` intent.
- [x] **C4 — GitLab normalize**: `head_pipeline.status` → `CiStatus` (pure).
- [x] **C5 — Snapshot**: `ForgePrimitives.ciStatus` in `findMaestroMr` → `mr.ci`
  (open candidates only). GitHub stubbed to `none`.
- [x] **C6 — Executor `runApplyCiFix`** + tick admission: post CI_FAIL_SENTINEL
  comment → run agent with it in context. Registered as spawning/slot intent.

## Verify before done
- [x] `pnpm test` green — 815 passing (incl. fsm-equivalence, inert with gate off)
- [x] biome lint clean · tsc strict typecheck clean
- [x] gate-off reconcile output unchanged (equivalence test + all prior tests pass)

## Review

Shipped the spec §11 MVP end-to-end on GitLab, behind `ci.gate` (default off).
Six TDD cycles, one commit each (+ the spec commit). 9 new tests.

**Deferred to follow-ups (per spec §10/§12):** `running`→wait + `wait_timeout`
(MVP hands off while running); `blocked` escalation over cap (MVP hands off at
cap=1, hardcoded); GitHub check-runs (stubbed `none`); pipeline-FSM (#29) handoff
site; failing-log fetch (`glab ci view`) — MVP posts the marker + pipeline link
and lets the agent re-run checks in the workspace; in-review CI-regression edge.

**Not done (decision for the user):** turning the gate ON in maestro's own
WORKFLOW.md to dogfood. That changes maestro's live behavior, so left untouched.
