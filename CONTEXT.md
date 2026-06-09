# Context

Domain and architecture vocabulary for Maestro. The broad glossary lives in the design
spec ([`docs/superpowers/specs/2026-06-03-maestro-design.md`](docs/superpowers/specs/2026-06-03-maestro-design.md))
§0–§8; this file records terms introduced by architecture work so reviews stay consistent
and don't re-litigate settled seams.

## Forge adapter internals

The **forge adapter** (`ForgeAdapter`, spec §0.3) is the only forge-aware seam: GitLab and
GitHub each satisfy it, normalizing to the §0.2 model so the reconciler stays forge-agnostic.
Beneath that public interface, two shared modules carry what used to be duplicated per forge:

- **ForgeCli** (`forge/cli.ts`) — the shared REST/GraphQL transport over a forge binary
  (`glab` / `gh`), parameterized by `{ bin, forge, env, botUser }`. Token rides in env, never
  argv; 404 → `null`. Both adapters construct one; the per-forge `*ClientConfig` is just its
  construction config. _Do not re-split into per-forge client classes_ — the binary/env/flag
  differences are config, not behavior.

- **Snapshot assembly** (`forge/snapshot.ts`) — the forge-agnostic choreography that turns one
  issue into an `IssueSnapshot`: fetch issue (+ lastActor), find the maestro MR, fill its
  `ApprovalState`, sort/cap comments. Includes the **edge-triggered changes-requested**
  comparison (`computeChangesRequested`): changes are outstanding iff a blocking thread
  post-dates the last bot push. Lives once, above the **ForgePrimitives** seam.

- **ForgePrimitives** (`forge/snapshot.ts`) — the narrow seam the snapshot algorithm composes:
  each adapter supplies only forge-specific *fetches* returning normalized model pieces plus the
  two edge-trigger timestamps (`blockingThreadAt`, `lastBotPushAt`). A third forge writes
  primitives, never an algorithm — this is the same property the spec §8 calls the GitHub
  milestone's "zero-change" headline, now extended below `getSnapshot`.

  `lastBotPushAt` is the newest commit on the MR branch **author-agnostic** — _not_ filtered by
  `bot_user`. The daemon owns the branch, so any commit post-dating the blocking signal means the
  work was redone. Filtering by author stranded the timestamp on shared accounts (bot account ==
  operator account: the agent's commits wear the operator's git identity) and the issue bounced
  in-review↔in-progress forever (issue #5). Do not re-add an author filter here.

## Command MR

A **command MR** is an open MR/PR assigned to the bot that has **no backing issue**, carrying a
body-start `/maestro <instruction>` comment from an authorized human. It is the only non-issue
trigger (spec `2026-06-09-mr-command-trigger-design.md`). The **command-MR pass**
(`daemon/mr-command-pass.ts`) runs each tick beside the issue lifecycle: list bot-assigned MRs →
keep only standalone ones (`isStandaloneMr` — not a `maestro/issue-*` branch, no `Closes #N`; the
issue path owns the rest) → `decideMrCommand` (a pure edge, the MR-thread mirror of the issue
reconciler) → run the agent on the one instruction → push iff it committed → **always reply**.

The edge is **edge-triggered and self-clearing on the reply**: a command is pending iff the newest
authorized `/maestro` comment post-dates the bot's newest reply (the comment carrying
`MR_COMMAND_REPLY_SENTINEL`). The reply is posted on every terminal path, so the edge can never loop
— stronger than the issue changes-requested edge, which clears on a push that might not happen (cf.
issue #5). The issue reconciler stays free of all this (thesis guard in `mr-command-thesis.test.ts`).
