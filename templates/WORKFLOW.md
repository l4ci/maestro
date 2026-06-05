---
forge: gitlab # gitlab | github (inferred from repo host if omitted)
project: group/repo # GitLab path OR GitHub org/repo
bot_user: maestro-bot
manage_board: true # GitLab: auto-create labels + board lists. GitHub: labels only
trigger:
  assignee: bot # issue must be assigned to bot_user
  require_label: null # optional extra gate: a maintainer-added label (perms-gated)
  allowed_actors: [] # optional allowlist; recommended ON for PUBLIC repos
proof: # one strategy, or a list — every listed strategy must pass at handoff (#12)
  type: playwright # playwright | test-output | diff-summary | none
  command: "npx playwright test --reporter=line"
git:
  default_branch: main
  target: main
  merge_strategy: squash # squash | merge | rebase
  delete_source_branch: true
environment:
  base_url: http://localhost:3000 # an already-running local instance, if any
  start_command: "npm run dev" # else how to boot one
  seed_command: "npm run db:seed" # dummy/sample data
  health_check: "curl -sf localhost:3000/health"
claude:
  command: "claude" # same binary as interactive; daemon runs it headless (-p)
  max_turns: 40
  # Headless: no human approves tool calls, so the agent needs full Bash (git/pnpm) or it
  # can't commit its work or run proofs. bypassPermissions → --dangerously-skip-permissions.
  # SECURITY: v1 runs the agent ON THE HOST (a clone dir with the forge token scrubbed — NOT
  # a container, §17). Issue bodies are attacker-controlled, so on PUBLIC repos a prompt-
  # injected agent could run arbitrary host commands. Use bypass only on repos+actors you
  # trust (gate writers with trigger.allowed_actors); drop to 'acceptEdits'/'default'
  # otherwise — knowing the agent then can't commit/prove until a real sandbox lands.
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
