# Architecture burndown — 2026-06-10

Issues from the 2026-06-09 architecture review (designs recorded in CONTEXT.md).
Mode: worktree-isolated agents per issue, PRs only, sequential review+merge through CI.

## Lanes (parallel, no file overlap)

- [ ] #90 forge wiring module — core/src/compose (new), cli/main, web/main, cli/daemon, core index
- [ ] #91 Claim module — core/src/daemon/slots.ts, tick.ts
- [ ] #92 authorized-actor predicate — core/src/security (new), reconciler/reconcile.ts, mr-command/decide.ts
- [ ] #93 FSM property test — core/test only

## Blocked (dispatch after blocker merges)

- [ ] #94 after-run edge — after #91
- [ ] #95 public/runtime surface split — after #90

## Review

(filled as PRs land)
