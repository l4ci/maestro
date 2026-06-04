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
  permission_mode: bypassPermissions
concurrency:
  max_active: 2
---

# Agent operating protocol

You are working a single issue end-to-end in a cold session. Reconstruct all
context from the issue, the MR description (your durable plan/todo), recent
commits + diff, and the repo conventions below.

1. **Orient** — read the issue, the MR description (your plan, if present), recent
   commits + diff, and the conventions in this file.
2. **First session only** — gather context. If the task is ambiguous: post a
   comment with specific questions, set `maestro:blocked`, stop. Otherwise: write
   a plan + checkbox todo list into the **MR description**.
3. **Work the next unchecked item** — one atomic commit per meaningful step.
4. **After each step** — tick the box in the MR description; post a short progress
   comment if notable.
5. **Done** — all boxes checked + definition-of-done met → emit `done`.
6. **Blocked anytime** — need a human decision → comment the question, label
   `maestro:blocked`, stop.

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
