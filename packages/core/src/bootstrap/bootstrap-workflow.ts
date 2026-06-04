// Bootstrap workflow (onboarding iteration 2). A repo with no committed WORKFLOW.md can't
// be operated by the normal lifecycle — the daemon has no prompt/settings for it, so it
// used to skip (or crash on the missing file). This builds a stand-in workflow from the
// M0 template overlaid with the repo's identity + a BOOTSTRAP agent protocol, so the
// daemon CAN work the "define my workflow" issue: the agent reads the sample-WORKFLOW PR,
// asks the maintainer what it can't infer, then writes the final WORKFLOW.md into the PR.
// Once that PR merges (repo gains a real WORKFLOW.md), the daemon uses that instead.

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { RepoRef } from '../contracts/index.js';
import {
  type WorkflowParseResult,
  parseWorkflow,
  splitFrontMatter,
} from '../workflow/load-workflow.js';

/** The agent's operating protocol while a repo has no WORKFLOW.md yet. */
export const BOOTSTRAP_PROMPT_BODY = `# Define this repository's WORKFLOW.md

This repo has no committed \`WORKFLOW.md\` yet. A draft PR linked to this issue already
contains a **suggested** WORKFLOW.md, inferred from the repo. Your job is to turn that
suggestion into the real, correct WORKFLOW.md — not to implement a feature.

1. **Orient** — read the issue, the linked PR, the suggested WORKFLOW.md on the PR branch,
   and the repo itself (package manifests, CI config, test setup, existing docs).
2. **Ask what you cannot safely infer** — the exact test and lint commands, the proof
   strategy (\`playwright\` | \`test-output\` | \`diff-summary\` | \`none\`) and its command,
   the target branch + merge strategy, how to boot a runnable instance (if any), and the
   definition of done. Put the questions in your needs_input summary (see HOW TO REPORT
   below) — that is what reaches the maintainer; do NOT write them to a file. You will be
   marked blocked until they answer. Do NOT guess commands or conventions you are unsure of.
3. **Finalize** — once answered, edit the WORKFLOW.md on the PR branch to the final version,
   commit it, and finish. The maintainer reviews and merges the PR; that is what makes this
   repo's workflow real.`;

/**
 * Build a stand-in WORKFLOW for a repo that has none: the template's front matter overlaid
 * with this repo's identity + safe bootstrap defaults (no board, no proof, no environment),
 * and the bootstrap agent protocol as the prompt body. Validated through the M1 loader.
 */
export function buildBootstrapWorkflow(
  repo: RepoRef,
  templateText: string,
  botUser: string,
): WorkflowParseResult {
  try {
    const { frontMatter } = splitFrontMatter(templateText);
    const base = (parseYaml(frontMatter) ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = {
      ...base,
      forge: repo.forge,
      project: repo.project,
      bot_user: botUser,
      manage_board: false, // labels already ensured at onboard; no board churn here
      proof: { type: 'none' }, // the "proof" of a bootstrap is the WORKFLOW.md itself
      environment: {}, // a fresh repo has no known running instance
    };
    const text = `---\n${stringifyYaml(merged)}---\n${BOOTSTRAP_PROMPT_BODY}`;
    return parseWorkflow(text, repo.host);
  } catch (err) {
    // A broken template must degrade to a skip, never crash the daemon's startup loop.
    return { ok: false, error: `bootstrap template unusable: ${(err as Error).message}` };
  }
}
