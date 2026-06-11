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
ci: # opt-in CI handoff gate (#118/#120). Default off — repos without CI are unaffected.
  gate: false # true ⇒ hold the human handoff until the head pipeline is conclusive,
  #            and bounce a failed pipeline back to the agent with the failing logs.
  wait_timeout_seconds: 1200 # a `running` pipeline older than this hands off anyway (stuck/external CI)
  max_fix_rounds: 3 # CI-fix bounces since the last human comment before parking as blocked
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

<!-- Repo authors extend below: test commands, lint rules, architecture notes,
     definition of done. The read-first / plan-via-mrDescription / atomic-commits /
     ask-when-unsure spine above is the shared default. -->

- **Test:** `npm test`
- **Lint:** `npm run lint`
- **Definition of done:** tests + lint green; proof attached; MR todo all checked.
