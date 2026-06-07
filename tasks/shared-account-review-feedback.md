# Shared-account review feedback: close the changes-requested holes

Context: on hosts where `bot_user` == operator account (dm-docu-gen), human review
feedback can never trigger rework. The `8c31dd0` `/maestro` escape hatch covers only
issue-thread paths (unblock, AC-approve), not the changes-requested edge. Plus the
proof runner can't run `npm install && npm test` (no shell).

## Plan

- [x] A. GitLab `#blockingThreadAt`: count a same-account MR note whose body starts
      with `/maestro` as a blocking signal (unresolved; resolvable not required —
      plain notes aren't resolvable). Edge still clears via `lastBotPushAt`.
- [x] B. GitHub parity: `blockingThreadAt` = newest of `changesRequestedSince(reviews)`
      and the newest body-start-`/maestro` PR conversation comment.
- [x] C. Reconciler: in `in-review` (legacy) and `review:human` (pipeline), a human
      body-start-`/maestro` issue comment newer than the newest daemon comment →
      `apply-changes-requested` with those comments as feedback. Explicit prefix
      required for ALL authors (review chatter must not spin agents).
- [x] D. Proof strategies: run WORKFLOW command strings through `sh -c` so `&&`,
      quotes, env vars work (commands are already trusted + unsandboxed per §13).
- [x] E. Shared `/^\/maestro\b/` regex in contracts (additive), used by reconcile +
      adapters.
- [x] F. Tests for A–D done (chain green, 601 passed); PR #75 merged (CI green) →
      rebuilt + restarted `maestro`/`maestro-web` → reposted the #5 color feedback
      as `/maestro` comment (note 46312).

## Review

Shipped as PR #75 (merge commit 76e5580, 2026-06-07), two commits:

- `2f6c44e` — shared-account `/maestro` rework edges (GitLab MR notes, GitHub PR
  conversation comments, reconciler in-review/review:human issue comments;
  `MAESTRO_COMMAND_RE` added to contracts).
- `c03e805` — proof commands run through `sh -c` (the `npm install && npm test`
  EINVALIDTAGNAME failure on dm-docu-gen#5).

Live verification: `/maestro`-prefixed comment posted on dm-docu-gen#5 at
17:48; within the poll window the daemon flipped `maestro::in-review` →
`maestro::in-progress` (17:58:19), heartbeat showed `activeWorkers: 1`, and a
`claude -p` agent spawned in the issue workspace. The previously dead
shared-account review-feedback loop works end-to-end.

Follow-up PR #76 (935c40c, merged + deployed same day): one `reconcile intent`
journal line per acting intent (quiet set: poll-review/blocked-wait/none/
skip-untrusted/cleanup). Verified live right after the idle-gap restart:
`reconcile intent … iid:5 intent:apply-changes-requested` in journalctl.
