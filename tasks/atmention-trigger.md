# Task: @-mention trigger (alternative to `/maestro`)

Let users address the bot by body-start `@<bot_user>` mention, equivalent to a
body-start `/maestro` command — but ONLY on a dedicated bot account (i.e. when the
comment author is not the bot itself). Scope: command channels only (no new-work
kickoff — the assignment permission gate stays). Position: body-start only.

## Design
- Trust is derived, not configured: `@<bot>` counts only when `author != bot_user`.
  On a shared account every comment is bot-authored ⇒ the mention branch never
  fires ⇒ `/maestro` stays the sole hatch. That IS "if he is his own account".
- Body-start anchored, like `/maestro` ⇒ preserves the smuggling defense (agent
  prose rides mid-body) and the "no review-chatter spin-up" property.

## Steps (TDD: red → green per unit)
- [ ] `comments.ts`: add `isMaestroCommand(c, botUser?)`, `stripCommandPrefix(body, botUser)`,
      `isApproveCommand(c, botUser)`, private `mentionRe`/`escapeRe`. Leave
      `isHumanComment` UNCHANGED (shared-account proof, /maestro-only).
- [ ] `snapshot.ts` `issueCommandAt`: thread `botUser`, use `isMaestroCommand`.
- [ ] `decide.ts` `decideMrCommand`: detect via `isMaestroCommand`, strip via
      `stripCommandPrefix`.
- [ ] `reconcile.ts` `acApproved`: detect via `isApproveCommand`.
- [ ] Do NOT touch `isHumanComment`, `#maestroCommandAt` (GitHub), `#blockingThreadAt`
      (GitLab) — shared-account self-block hatch, different mechanism.
- [ ] Tests: comments, mr-command-decide, snapshot, reconcile (define gate).
- [ ] README: document the @-mention path + the dedicated-account condition.
- [ ] Verify: pnpm typecheck + test + lint.

## Review
Done. One predicate `isMaestroCommand(c, botUser?)` = body-start `/maestro` OR
body-start `@<bot>` from a non-bot author; the author≠bot clause IS the
dedicated-account condition (no config). Helpers `stripCommandPrefix` /
`isApproveCommand` added beside it. Wired into `decideMrCommand` (MR command),
`issueCommandAt` (issue rework feedback), `acApproved` (define gate).
`isHumanComment` and the two adapter self-block hatches left untouched
(shared-account mechanism). Tests added across comments/decide/snapshot/reconcile;
full suite 917 pass, typecheck + lint clean. README documents the alias + the
dedicated-account condition.

Not done (out of agreed scope): new-work kickoff via @-mention — assignment
permission gate preserved. Runtime hint strings (handoff/blocked) still say only
`/maestro`, since the daemon can't tell shared vs dedicated at comment time and a
generic `@bot` hint would mislead shared-account users.
