# Issue #88 — Command-MR daemon-action meta-commands (`/maestro merge`, `/maestro close`)

The token-scrubbed agent (§13.1) cannot mutate the forge, so `/maestro merge` is half-served:
the agent replies but nothing merges. Let the **daemon** recognize a fixed meta-command
vocabulary and perform it directly via the adapter — no agent run.

## Decisions (from issue open questions)
- **Routing (Q1):** leading-verb match on the stripped instruction (`^merge\b`, `^close\b`),
  case-insensitive. Pure helper.
- **Mixed commands (Q2a):** "review then merge" → leading verb `review` → agent path (unchanged).
  Only a *pure* `merge`/`close` is a daemon action.
- **Safety (Q3):** authorization already enforced by `decideMrCommand` (allowed_actors +
  shared-account, fail-closed). Merge additionally blocked on a draft MR. Always reply with the
  sentinel on every path (success / draft-blocked / error) → edge self-clears, never loops.
- Meta path is independent of the Claude rate gate (#47): a forge mutation needs no Claude spawn.

## Tasks
- [x] 1. `closeMR` on the `ForgeAdapter` contract (idempotent).
- [x] 2. GitHub `closeMR` (`PATCH /pulls/:n {state:'closed'}`; idempotent on closed/merged).
- [x] 3. GitLab `closeMR` (`PUT /merge_requests/:n {state_event:'close'}`; idempotent).
- [x] 4. Pure `metaCommandOf(instruction)` helper in `mr-command/meta.ts`.
- [x] 5. Wire the meta path in `evaluateMrCommands` → `runMetaCommand` (mutation + sentinel reply,
       no agent / slot / workspace / rate-gate).
- [x] 6. Test fake: `closeMR` recorder in `helpers/daemon.ts`.
- [x] 7. Tests: pure parser; pass meta cases (merge / draft-block / close / error→reply); adapter
       closeMR slices (GitHub + GitLab).
- [x] 8. `pnpm lint && pnpm typecheck && pnpm test` + `pnpm build` green.

## Review
- **What shipped:** the daemon now performs `/maestro merge` and `/maestro close` itself via the
  adapter — no agent run — closing the §13.1 gap where the token-scrubbed agent could only reply.
- **Files:**
  - `contracts/forge-adapter.ts` — new `closeMR(repo, mrIid)`.
  - `forge/github/github-adapter.ts`, `forge/gitlab/gitlab-adapter.ts` — `closeMR` (idempotent).
  - `mr-command/meta.ts` — pure `metaCommandOf` leading-verb router.
  - `daemon/mr-command-pass.ts` — meta path before the agent path: `runMetaCommand` + `metaReply`.
  - Tests: `mr-command-meta.test.ts` (6); meta cases in `mr-command-pass.test.ts` (6); `closeMR`
    slices in both adapter tests (3+3); `closeMR` recorder in `helpers/daemon.ts`.
- **Invariants honored:** always-reply-with-sentinel on every path (success / draft-block / error)
  → the edge self-clears, never loops (issue #5 lesson). Authorization stays with `decideMrCommand`
  (fail-closed). Meta path bypasses the Claude rate gate (#47) — a forge mutation needs no spawn.
  Thesis guard still green: the issue reconciler carries no command-MR symbols.
- **Verification:** typecheck clean · 660 tests pass (7 env-gated skips, 2 todo) · biome clean ·
  `pnpm build` regenerates `dist/`. No daemon currently running → picks up fresh `dist/` next start.
- **Deferred (per issue):** Q2b structured "review-then-merge" gate; close/merge are the v1 set.
