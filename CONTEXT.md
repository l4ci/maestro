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
