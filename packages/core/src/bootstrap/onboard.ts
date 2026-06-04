// Add-when-missing bootstrap trigger (§16, M8 Part B). The ONE onboarding-setup
// routine behind `maestro add` and any direct caller: ensure labels (+ board on
// GitLab) via the EXISTING §0.3 adapter methods, then — only when the repo has no
// committed WORKFLOW.md — have the bot open a self-assigned "define my workflow"
// issue so the NORMAL lifecycle drafts the file. It stores no state and adds no new
// lifecycle path; the issue is just a one-shot trigger. Idempotent: it never opens a
// second bootstrap issue (the marker is the dedupe key — createIssue has no dedupe,
// so the caller guards, per M2 Slice 12).

import { BOOTSTRAP_MARKER } from '../contracts/bootstrap.js';
import type { ForgeAdapter, Label, RepoRef } from '../contracts/index.js';
import { labelNames } from '../contracts/labels.js';
import type { WorkflowSeed } from './infer-workflow-seed.js';

/** The §16 onboarding issue title — also part of how a human recognizes it. */
export const BOOTSTRAP_TITLE = "Let's define my workflow";

export interface OnboardDeps {
  adapter: ForgeAdapter;
  /** Does the cloned repo already carry a committed WORKFLOW.md? true → no bootstrap issue. */
  hasWorkflow: boolean;
  /** Default true; mirrors WORKFLOW.manage_board (§11). GitHub ignores it (no board). */
  manageBoard?: boolean;
  /** Lazily produce the inferred seed — only invoked when an issue is actually opened. */
  seed?: () => Promise<WorkflowSeed>;
}

export interface OnboardResult {
  openedIssue: boolean;
  reason?: 'has-workflow' | 'already-open' | 'opened';
}

export async function onboard(repo: RepoRef, deps: OnboardDeps): Promise<OnboardResult> {
  const { adapter } = deps;
  const labels: Label[] = labelNames(repo.forge)
    .all()
    .map((name) => ({ name }));

  // §11 setup — idempotent, uses the EXISTING adapter methods (no new surface).
  await adapter.ensureLabels(repo, labels);
  if (repo.forge === 'gitlab' && (deps.manageBoard ?? true) && adapter.ensureBoard) {
    await adapter.ensureBoard(repo, labels);
  }

  if (deps.hasWorkflow) return { openedIssue: false, reason: 'has-workflow' };

  // Idempotency: a re-run must not open a second bootstrap issue (Slice 5).
  const open = await adapter.listAssignedOpenIssues(repo);
  if (open.some((i) => i.body.includes(BOOTSTRAP_MARKER))) {
    return { openedIssue: false, reason: 'already-open' };
  }

  const seed = deps.seed ? await deps.seed() : undefined;
  await adapter.createIssue(repo, {
    title: BOOTSTRAP_TITLE,
    body: bootstrapBody(seed),
    assignToBot: true,
  });
  return { openedIssue: true, reason: 'opened' };
}

/** Issue body: the onboarding prompt + (when inferred) a ready-to-commit WORKFLOW seed,
 *  always terminated by the greppable marker that makes the trigger idempotent. */
export function bootstrapBody(seed?: WorkflowSeed): string {
  const intro =
    'Maestro is now watching this repo. Define how it should work by committing a ' +
    '`WORKFLOW.md`, then assign issues to the bot.';
  const seedBlock = seed
    ? `\n\nA suggested starting point (inferred from the repo — refine as needed):\n\n\`\`\`markdown\n${seed.text}\n\`\`\``
    : '';
  return `${intro}${seedBlock}\n\n${BOOTSTRAP_MARKER}`;
}
