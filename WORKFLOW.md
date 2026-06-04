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
  command: npm test
git:
  default_branch: main
  target: main
  merge_strategy: squash
  delete_source_branch: true
environment: {}
claude:
  command: claude
  max_turns: 40
  permission_mode: acceptEdits
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
   comment with specific questions, set `maestro::blocked`, stop. Otherwise: write
   a plan + checkbox todo list into the **MR description**.
3. **Work the next unchecked item** — one atomic commit per meaningful step.
4. **After each step** — tick the box in the MR description; post a short progress
   comment if notable.
5. **Done** — all boxes checked + definition-of-done met → emit `done`.
6. **Blocked anytime** — need a human decision → comment the question, label
   `maestro::blocked`, stop.

## Repo-specific conventions

<!-- Repo authors extend below: test commands, lint rules, architecture notes,
     definition of done. The read-first / plan-in-MR / atomic-commits /
     ask-when-unsure spine above is the shared default. -->

- **Test:** `npm test`
- **Lint:** `npm run lint`
- **Definition of done:** tests + lint green; proof attached; MR todo all checked.
