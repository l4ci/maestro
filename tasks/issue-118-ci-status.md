# Issue #118 — CI-status rework (MVP)

Spec: `docs/superpowers/specs/2026-06-11-ci-status-rework-design.md` §11 (MVP).
Branch: `issue-118-ci-status-rework`. TDD throughout.

MVP scope: model + GitLab-only `ciStatus` + `failed → bounce` at the legacy
handoff gate, hardcoded 1-round cap. No `running`-wait, no `wait_timeout`, no
GitHub, no pipeline-FSM site (deferred to follow-ups).

## Cycles (test-first each)

- [ ] **C1 — Model**: `CiStatus` type + `ci?` on `MergeRequest`; `CiStatusSchema`
  wired into `MergeRequestSchema`; static type-tie updated.
- [ ] **C2 — Settings**: `RepoSettings.ci: { gate: boolean }`; thread through
  `resolveRepoSettings` + zod schemas (config + WORKFLOW).
- [ ] **C3 — Reconciler `ciGate`** (core): legacy `workComplete → handoff` gate.
  gate off → handoff; failed+under-cap → `apply-ci-fix`; success/none → handoff;
  failed+cap-reached → handoff. New `apply-ci-fix` intent.
- [ ] **C4 — GitLab normalize**: `head_pipeline.status` → `CiStatus` (pure).
- [ ] **C5 — Snapshot**: `ForgePrimitives.ciStatus` in `findMaestroMr` → `mr.ci`.
- [ ] **C6 — Executor `runApplyCiFix`**: post failing-logs comment (sentinel keyed
  on head sha, idempotent) → label in-progress → run agent with it in context.

## Verify before done
- [ ] `pnpm test` green (incl. fsm-equivalence — inert with gate off)
- [ ] biome lint clean · tsc strict build clean
- [ ] gate-off reconcile output byte-identical to main

## Review
(filled at end)
