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

## Tasks — all done (one commit each, on main)
- [x] **6.** Full `ci` config block — `1a9b043`
- [x] **1.** `running` → wait + `wait_timeout` (`now` into `ReconcileInput`) — `ee4e5ce`
- [x] **2.** `blocked` escalation over the round cap (`park-ci-blocked`) — `2d1d4f4`
- [x] **3.** GitHub check-runs `ciStatus` — `812299b`
- [x] **4.** #29 pipeline-FSM handoff site (shared `ciHandoff`, D4 documented) — `23b381e`
- [x] **5.** Failing-log fetch + sha-keyed idempotency — `632bbb6`
- [x] **7.** In-review CI-regression bounce (scoped, opt-in) — `1111ebd`

## Review
- TDD throughout: each change started red, then green. Final: **846 passed**,
  `pnpm typecheck` strict clean, `pnpm lint` (biome) clean.
- FSM-equivalence stays meaningful: the grid runs `ci.gate: false`, so the
  reconciler changes are byte-for-byte inert there (D4 documents the gate-on case).
- Deliberate, flagged choices:
  - Config keys are integer-seconds (`wait_timeout_seconds`), matching
    `stall_timeout_seconds` — diverges from the spec's literal `20m`; no duration
    parser added (Simplicity First).
  - GitHub `ciStatus` fetches unconditionally for open candidates, matching the
    established GitLab pattern (the snapshot has no `ci.gate` flag). The spec's
    "only when gate on" optimization would touch both adapters + the shared
    `findMaestroMr` signature — left as a follow-up.
  - `ciFailureLogs` is an OPTIONAL adapter capability (like `ensureBoard?`), so
    test fakes degrade gracefully; the daemon falls back to the pipeline link.
  - Task 7 is scoped narrow: bounces only in the awaiting-review (poll) state,
    never overrides an approval-driven merge (forge branch protection owns
    merge-time required-checks), inert when `ci.gate` is off.
- Docs: the full `ci:` block added to `templates/WORKFLOW.md` and the repo's own
  `WORKFLOW.md`, both with `gate: false` (no behavior change to the live daemon).
