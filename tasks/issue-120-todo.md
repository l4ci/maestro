# Issue #120 — CI-status rework Phase 2

Spec: `docs/superpowers/specs/2026-06-11-ci-status-rework-design.md`. TDD throughout
(watch each test fail first). `pnpm test` + `pnpm typecheck` + `pnpm lint` clean
before each commit. Committing per task directly to `main` (user-authorized).

## Decisions locked
- **`now` into the reconciler**: thread a tick timestamp `now: string` into
  `ReconcileInput` (spec §10 lean). Keeps `ciGate` whole + reconciler pure.
- **Config keys**: integer-seconds, matching `stall_timeout_seconds` convention →
  `wait_timeout_seconds` (default 1200 = 20m), `max_fix_rounds` (default 3).
  Diverges from spec's literal `wait_timeout: 20m` — no duration parser in repo.

## Tasks
- [ ] **6. Full `ci` config block.** (Pulled first — tasks 1/2 need the fields.)
  `ci: { gate, wait_timeout_seconds, max_fix_rounds }` in WORKFLOW schema,
  `RepoSettings.ci`, resolver, example configs/templates.
- [ ] **1. `running` → wait + `wait_timeout`.** `ReconcileInput.now`; `ciGate` →
  `'pass'|'wait'|'fix'`; `agedPast` helper; `running` holds (intent `none`) until
  `ci.at` ages past `wait_timeout` → `pass`. Thread `now` at tick.ts:147.
- [ ] **2. `blocked` escalation over the round cap.** `ci.max_fix_rounds`;
  at cap → park `blocked` w/ logs + @-mention (reuse `runReview` bounce-cap shape).
  Window resets on any human comment.
- [ ] **3. GitHub check-runs.** Implement stubbed `ciStatus`: `/commits/{sha}/check-runs`
  + combined status → CiStatus. Mirror GitLab adapter + normalize tests.
- [ ] **4. #29 pipeline-FSM handoff site.** Apply `ciGate` at `reconcilePipeline`
  `passed → handoff`. Document divergence D4 in `reconcile-fsm-equivalence.test.ts`.
- [ ] **5. Failing-log fetch.** Adapter capability: `glab ci view <sha>` /
  `gh run view --log-failed`, truncate, include in `ciFailComment`. Key comment on
  head sha (idempotency).
- [ ] **7. (Optional) In-review CI-regression edge.** Re-check CI after handoff,
  bounce on regression.

## Review
(filled at completion)
