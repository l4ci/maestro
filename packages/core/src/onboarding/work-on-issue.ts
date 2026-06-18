// The ONE "work on this issue" routine behind the web POST /repos/:id/issues/:iid/work.
// Hands an open issue to the bot — assign + (optional) trigger label — so the daemon picks it
// up on its next tick. A shared write usecase beside add-repo.ts; never a web-special path.

import type { ForgeAdapter, RepoRef, RepoSettings } from '../contracts/index.js';

/** Non-fatal hint the UI surfaces when the assignment will NOT auto-start the daemon: the
 *  repo restricts actors (allowed_actors) and the bot — who becomes lastActor on a dashboard
 *  write — is not on the list, so the trigger guard will ignore the assignment. */
export type WorkWarning = 'actor-allowlist-blocks-autostart';

export type WorkResult = { ok: true; warning?: WorkWarning };

export interface WorkOnIssueDeps {
  adapterFor: (repo: RepoRef) => ForgeAdapter;
  settingsFor: (repo: RepoRef) => RepoSettings;
}

export async function workOnIssue(
  repo: RepoRef,
  issueIid: number,
  deps: WorkOnIssueDeps,
): Promise<WorkResult> {
  const settings = deps.settingsFor(repo);
  const adapter = deps.adapterFor(repo);
  const botUser = settings.botUser;

  // 1. Assign the bot — the trigger guard's first, always-required condition.
  await adapter.assignIssue(repo, issueIid, botUser);

  // 2. Apply the trigger label only when the repo requires one (else the guard's label
  //    condition can never be satisfied). setIssueLabels is idempotent.
  if (settings.trigger.requireLabel !== null) {
    await adapter.setIssueLabels(repo, issueIid, [settings.trigger.requireLabel], []);
  }

  // 3. A dashboard write makes the bot the issue's lastActor. If the repo restricts actors and
  //    the bot isn't allowed, the daemon will ignore this — tell the UI rather than no-op.
  const { allowedActors } = settings.trigger;
  if (allowedActors.length > 0 && !allowedActors.includes(botUser)) {
    return { ok: true, warning: 'actor-allowlist-blocks-autostart' };
  }
  return { ok: true };
}
