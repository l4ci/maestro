# Architecture burndown — 2026-06-10

Issues from the 2026-06-09 architecture review (designs recorded in CONTEXT.md).
Mode: worktree-isolated agents per issue, PRs only, sequential review+merge through CI.

## Lanes (parallel, no file overlap)

- [x] #90 forge wiring module — PR #98 merged
- [x] #91 Claim module — PR #99 merged (deviations: `open` scope param for the MR pass; `globalActive` getter for the heartbeat)
- [x] #92 authorized-actor predicate — PR #97 merged
- [x] #93 FSM property test — PR #100 merged; equivalence holds OUTSIDE three deliberate zones (D1 review gate #29, D2 mark-queued #53, D3 labels-vs-artifacts) → FSM unification off the table, CONTEXT.md updated

## Blocked (dispatch after blocker merges)

- [x] #94 after-run edge — PR #101 merged (deviation: decision carries resetAt as ISO 8601, tick parses back; round trip pinned by test)
- [x] #95 public/runtime surface split — PR #102 merged (exceptions documented in public.ts and CONTEXT.md: WorkspaceManager + ForgeError stay public; adapter classes exported from NEITHER surface)

## Follow-up from re-check of the 2026-06-07 review

- [x] #78 lifecycle-move table — PR #103 merged (pure write-side table, 10 tick sites + handoff flip migrated, todo-gate invariant pinned)
- [x] #80 loader Result-union — closed: completed by #98's loadConfig
- [x] #81 onboarding as one concept — closed not-planned per its own caveat; #95 delivered the interface-narrowing half

## Review

- 2026-06-10: #97→#100 merged sequentially (plain merge commits), CI green on all; full verification chain re-run on combined main (98+99 both touched cli/daemon.ts).
- 2026-06-10: #101 merged; #102 conflicted with it (index.ts deleted vs. modified) — agent merged main back in, after-run edge routed onto the public surface, chain green, merged. Final main verified: all six review issues (#90–#95) closed.
- Daemon residue: the daemon had independently picked up #90 (PR #96) — closed as superseded by #98.
