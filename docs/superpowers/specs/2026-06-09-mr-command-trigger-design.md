# MR command trigger — react to `/maestro` on standalone MRs

- **Date:** 2026-06-09
- **Status:** Approved (brainstorm), pending implementation plan
- **Extends:** `2026-06-03-maestro-design.md` §1/§7 (issue-driven lifecycle)

## 1. Goal

Let maestro act on a `/maestro <instruction>` comment written on an **open MR/PR
assigned to the bot that has no backing issue**. Today every trigger flows through
an issue (`listAssignedOpenIssues` → snapshot → reconcile); a standalone MR is
invisible. This adds the first non-issue trigger: a **command MR**.

The agent reads the instruction, follows it (investigate or change), pushes commits
if it changed code, and **always** posts a reply comment.

## 2. Decisions (locked in brainstorm)

| Decision | Choice | Rationale |
|---|---|---|
| Action scope | Agent decides; push iff it changed code; always reply | Faithful to open-ended instructions ("make sure this works" vs "fix the lint") |
| Integration | Separate daemon pass + **pure** `decideMrCommand`; issue reconciler untouched | Preserves the standing thesis: `core/reconciler` + issue `tick` stay byte-for-byte stable |
| Idempotency | Edge-trigger on the MR thread; **clears on the bot's reply comment** | The reply is always posted (even on failure), so the edge can never fail to clear — stronger than the push-based issue edge (issue #5) |
| Scope | **Standalone** MRs only (not `maestro/issue-*`, no `Closes #N`) | Issue-backed MRs already handled by the issue path; no double-fire |
| Authorization | Trigger guard `allowed_actors` + shared-account body-start `/maestro` = human | Same trust model as issue triggers (§13.1) |
| Workspace | Keyed `mr-<iid>`; cleanup sweep evicts on MR close/merge | Consistent with issue-workspace lifecycle |

## 3. The command-MR lifecycle

A new daemon pass, run per repo per tick alongside the existing lifecycle + cleanup
passes (spec §0.5):

```
(c) command-MR pass:
    listAssignedOpenMergeRequests(repo)
      → drop issue-backed MRs (maestro/issue-* branch OR closesIssueIid set)
      → for each remaining: assembleMrThread → decideMrCommand → execute intent
```

Only "run the command" consumes a concurrency slot. The in-flight set is keyed
`mr-<iid>` (a namespace distinct from issue iids) so a long run never stacks a
second on the same MR.

## 4. Trigger — `decideMrCommand` (pure)

A pure function, the MR-thread mirror of the issue reconciler. **No I/O.** Input is
the MR comment thread (newest-first), the bot user, and the resolved trigger guard.

```
decideMrCommand(thread, botUser, guard) →
  | { kind: 'run-mr-command'; instruction: string }
  | { kind: 'none' }
```

Edge rule (react-once, self-clearing):

1. `lastReplyAt` = createdAt of the newest bot comment containing
   `MR_COMMAND_REPLY_SENTINEL` (`<!-- maestro:mr-reply -->`), or `-∞`.
2. `command` = the **newest** comment that (a) is body-start `/maestro` per
   `MAESTRO_COMMAND_RE`, (b) comes from an authorized author, and (c) has
   `createdAt > lastReplyAt`.
3. If a `command` exists → `run-mr-command` with `instruction` = the command body
   minus the leading `/maestro` token. Else → `none`.

Older unaddressed commands are superseded by the newest; the human re-issues if
needed. **Authorized author** = a human comment under the shared-account rule
(author ≠ bot, OR body starts with `/maestro` — agent text never does, and daemon
replies lead with a heading), AND, when `guard.allowedActors` is non-empty, the
author is on the allowlist (fail-closed). Same `isHumanComment` predicate the issue
reconciler uses.

After any run the bot posts a reply carrying the sentinel, so `lastReplyAt` advances
past the command and the next tick derives `none`. The edge cannot loop: the reply
is posted on every terminal path (success, no-op, needs_input, failure).

## 5. Execution

On `run-mr-command`:

1. Acquire a slot (in-flight `mr-<iid>`).
2. `ensureWorkspace` on the MR's source branch, keyed `mr-<iid>`.
3. Run the agent with a built-in **MR-command prompt**: the instruction text, the MR
   description, and the branch diff vs target as context, with the repo's WORKFLOW
   body appended for conventions. (Independent of the #29 role pipeline — a fixed
   built-in role `mr-command`, not a WORKFLOW-declared section.)
4. If the agent changed tracked files → commit + push to the MR's source branch
   (the daemon owns the push; the agent env is token-scrubbed, §13.1).
5. **Always** post a reply comment with `MR_COMMAND_REPLY_SENTINEL`:
   - `done`, code changed → "✅ Done — `<summary>`. Pushed N commit(s)."
   - `done`, no change → the agent's findings/answer.
   - `needs_input` → the agent's question.
   - run failed / no result → a short error note. The reply (with sentinel) is
     still posted, so the edge **clears** — no silent auto-retry loop (the issue #5
     lesson). A re-issued `/maestro …` restarts it.

The reply both informs the human and retires the edge — on every terminal path.

## 6. Contracts & modules touched

**New:**
- `ForgeAdapter.listAssignedOpenMergeRequests(repo): Promise<MergeRequest[]>` —
  open MRs assigned to bot_user (GitLab `assignee_username`; GitHub assigned PRs
  via the issues endpoint filtered to `pull_request`).
- `decideMrCommand` (pure) + `MrCommandIntent` type — new module under `reconciler/`
  (or `mr-command/`), NOT inside `reconcile.ts`.
- `assembleMrThread(repo, mrIid, prim)` — MR comments + the chosen MR, newest-first
  capped; reuses the `ForgePrimitives` `comments`/MR fetches at MR scope.
- `MR_COMMAND_REPLY_SENTINEL` in `contracts`.
- Built-in MR-command prompt (`runner`/`workflow`).
- Daemon command-MR pass in `tick.ts` (its own functions; the issue passes stay
  unchanged).
- Workspace `mr-<iid>` key support in `resolveWorkspacePath` + an MR-state check
  for the cleanup sweep (`getMergeRequestState`/reuse).

**Unchanged (asserted by test):** `reconcile.ts`, `deriveState`, `deriveStage`, the
issue lifecycle pass, all issue intents. The command MR is an additive parallel path.

## 7. Workspace lifecycle

MR workspaces are keyed `mr-<iid>`, reused across commands on the same MR. The
cleanup sweep (pass b) is generalized: per workspace dir it derives the entity kind
from the key (`issue-` vs `mr-`) and queries the matching state — issue via
`getIssueState`, MR via a new `getMergeRequestState` (open / closed / merged /
missing). A terminal MR (closed or merged) evicts its workspace, same as a closed
issue. LRU disk cap (§5) still applies on top.

## 8. Safety (§13.1)

Identical surface to issue work: bot credentials, unsandboxed host workspace,
token-scrubbed agent env, workspace path guard (never escape `workspaces/`). On
public repos the MR diff and command text are attacker-controlled and the agent acts
with bot creds — `allowed_actors` is the gate, exactly as for issue assignment.
Assigning an MR to the bot already requires write/triage permission on both forges,
so random public users cannot trigger by assignment alone.

## 9. Testing

- **Pure `decideMrCommand`** (unit, TDD): newest command after last reply → run;
  command older than last reply → none; no command → none; unauthorized author →
  none; shared-account body-start `/maestro` from the bot account → counts;
  mid-body `/maestro` → ignored; two stacked commands → newest wins.
- **Adapters**: `listAssignedOpenMergeRequests` filters by bot assignee + open
  (GitLab + GitHub); `getMergeRequestState` maps open/closed/merged/missing.
- **Daemon pass**: standalone MR with a pending command → one agent run + one
  sentinel reply + slot consumed; issue-backed MR (`maestro/issue-*`) ignored by
  this pass; reply clears the edge (second tick → no-op).
- **Workspace**: `mr-<iid>` path round-trips; sweep evicts a merged MR's workspace.
- **Thesis guard**: a test greps `reconcile.ts` / issue `tick` paths to assert no
  command-MR coupling leaked in.

## 10. Out of scope (v1)

- Reacting to `/maestro` on issue-backed MRs via this path (the issue path owns
  them).
- A WORKFLOW-declared `mr-command` role / per-repo prompt override (built-in only).
- Acting on more than the newest pending command per tick.
- MR creation by maestro from a command (commands operate on an existing MR).
