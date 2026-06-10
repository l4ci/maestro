# Issue burndown — round-2 tech-debt (2026-06-10)

Five open issues, all with designs approved in the round-2 grilling (CONTEXT.md). Standard burndown workflow: worktree-isolated agents open PRs, main loop reviews + merges sequentially through CI. Issues stay unassigned (daemon races assigned ones).

## Lanes (by file overlap)

| Lane | Issue | Files | Wave |
|------|-------|-------|------|
| A: executor | #105 intent executor | core/src/daemon/tick.ts, run.ts, mr-command-pass.ts, new module | 1 |
| A: executor | #109 proof-failure escalation | executor catch path, proof seam, new edge | 2 (blocked by #105) |
| B: workflow | #107 tagged deriveCell | core/src/compose/forge-wiring.ts, cli/src/daemon.ts, workflow/ | 1 |
| C: snapshot | #108 zod snapshot validation | core/src/forge/snapshot.ts, contracts/ | 1 |
| D: web | #106 single render path | web/src/page.ts | 1 |

## Plan

- [x] Wave 1: dispatch #105, #106, #107, #108 in parallel worktrees
- [x] Review + merge wave-1 PRs sequentially through CI — #106→PR #110, #108→PR #111, #107→PR #112, #105→PR #113; branches + worktrees cleaned
- [x] Wave 2: dispatch #109 on fresh main (4f91f42)
- [x] Review + merge #109 → PR #114 merged (ff833e5)
- [x] Rebuild + restart maestro/maestro-web once heartbeat shows activeWorkers: 0

Deviations accepted in review:
- #108: schema↔type tie via Equals-assertion instead of `z.ZodType<Issue>` (exactOptionalPropertyTypes; stricter anyway); only the CHOSEN MR validated, not the repo-wide pool (blast-radius).
- #107: deriveCell lived in cli/daemon.ts, not forge-wiring; swap policy moved to core `WorkflowCells` (§14 zero-logic composition root); skip-case log dedupe made real.
- #105: #88 meta-commands stayed in mr-command-pass (forge mutation, not run choreography); merge-with-no-MR error now rejects via guard with same message/claim release.

## Review

All five round-2 issues closed in one session (2026-06-10, ~50 min wall clock):
#106→PR #110, #108→PR #111, #107→PR #112, #105→PR #113, #109→PR #114 — each
reviewed in the main loop, merged through green CI with plain merge commits,
branches (local+remote) and agent worktrees removed. Final test count grew
753→789 (parity suite, snapshot validation, deriveCell policy, executor unit
tests, proof escalation, crash-recovery integration test). Daemon + dashboard
rebuilt and restarted on idle heartbeat; clean start with 2 repos.

Leftover noticed, not touched: 9 stale agent worktrees from the 2026-06-05
burndown (fix/* branches, all merged) still under .claude/worktrees/.
