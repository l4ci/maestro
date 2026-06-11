---
forge: github
project: l4ci/maestro
bot_user: l4ci
manage_board: true
trigger:
  assignee: bot
  require_label: null
  allowed_actors: []
proof:
  type: test-output
  command: pnpm test
git:
  default_branch: main
  target: main
  merge_strategy: merge
  delete_source_branch: true
environment: {}
claude:
  command: claude
  max_turns: 40
  # Cold `pnpm install` + a full tsc build on this monorepo emit no agent stream
  # events for minutes; 120s false-killed healthy agents mid-install. Size above that.
  stall_timeout_seconds: 300
  permission_mode: bypassPermissions
concurrency:
  max_active: 2
ci: # CI handoff gate (#118/#120). On: this repo's CI (build + typecheck + test + lint)
  gate: true #          runs on every branch push, so hold the handoff until it's green.
  wait_timeout_seconds: 1200 # hand off anyway if a run is stuck past 20m
  max_fix_rounds: 3 #          red-CI bounces before parking the ticket as blocked
---

# Agent operating protocol

You are working a single issue end-to-end in a cold session. Reconstruct all
context from the issue, the MR description (your durable plan/todo), recent
commits + diff, and the repo conventions below.

You cannot touch the forge yourself (no token, no network). You speak to the daemon
ONLY through the final JSON object described under **HOW TO REPORT** below — the
daemon writes your plan, comments, and MR to the forge on your behalf.

1. **Orient** — read the issue, the MR description (your plan, if present), recent
   commits + diff, and the conventions in this file.
2. **First session only** — gather context. If the task is ambiguous: emit
   `needs_input` with your questions (you'll be marked blocked). Otherwise: emit a
   `planComment` (a short summary for the issue) and an `mrDescription` (the detailed
   plan + a `- [ ]` checkbox todo list) in your final JSON.
3. **Work the next unchecked item** — one atomic commit per meaningful step.
4. **After each step** — re-emit `mrDescription` with the finished boxes ticked
   (`- [x]`). Keep the `Closes #<issue>` line so merge auto-closes the issue.
5. **Done** — all boxes checked + definition-of-done met → emit `done`.
6. **Blocked anytime** — need a human decision → emit `needs_input` with the question.

## Repo-specific conventions

This is a **pnpm monorepo** (pnpm@9.15.0, three workspaces under `packages/`:
`core`, `cli`, `web`). Use pnpm, never npm. Commands match CI:

- **Typecheck:** `pnpm -r typecheck` (tsc, all packages)
- **Test:** `pnpm test` (vitest, run mode)
- **Lint:** `pnpm lint` (biome)
- **Build:** `pnpm build` (tsc, all packages)

The binding proof at handoff is `test-output` running `pnpm test` — a green run
is sufficient (no live daemon/web instance required to prove the work). When a
change touches the **web dashboard** (`packages/web`, served on
`http://localhost:4000`), additionally exercise the affected UI with Playwright
before marking done.

- **Definition of done:** `pnpm -r typecheck`, `pnpm test`, `pnpm lint`, and
  `pnpm build` all green; proof attached; MR todo all checked; dashboard changes
  verified with Playwright.
