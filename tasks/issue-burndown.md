# Architecture burndown — 2026-06-10

Issues from the 2026-06-09 architecture review (designs recorded in CONTEXT.md).
Mode: worktree-isolated agents per issue, PRs only, sequential review+merge through CI.

## Lanes (parallel, no file overlap)

- [x] #90 forge wiring module — PR #98 merged
- [x] #91 Claim module — PR #99 merged (deviations: `open` scope param for the MR pass; `globalActive` getter for the heartbeat)
- [x] #92 authorized-actor predicate — PR #97 merged
- [x] #93 FSM property test — PR #100 merged; equivalence holds OUTSIDE three deliberate zones (D1 review gate #29, D2 mark-queued #53, D3 labels-vs-artifacts) → FSM unification off the table, CONTEXT.md updated

## Blocked (dispatch after blocker merges)

- [ ] #94 after-run edge — after #91 ✓ (unblocked)
- [ ] #95 public/runtime surface split — after #90 ✓ (unblocked)

## Review

- 2026-06-10: #97→#100 merged sequentially (plain merge commits), CI green on all; full verification chain re-run on combined main (98+99 both touched cli/daemon.ts).
