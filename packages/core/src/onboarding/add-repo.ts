// Shared `add a repo` routine (OD-4). The ONE implementation behind both `maestro add`
// (CLI) and the web POST /repos — never two copies (the rot M0 forbids). It appends a
// repos[] entry to maestro.config.yaml preserving comments, runs §11 onboarding setup
// through the adapter (labels + board + the §16 bootstrap issue), and commits by default
// staging ONLY the config path (never `.`/`-A`/`.env`; §5 secrets never enter git).

import { readFileSync, writeFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { type BootstrapWorkspace, openBootstrapWorkflowPr } from '../bootstrap/bootstrap-pr.js';
import type { WorkflowSeed } from '../bootstrap/infer-workflow-seed.js';
import { onboard } from '../bootstrap/onboard.js';
import { parseConfig } from '../config/load-config.js';
import type { Exec, ForgeAdapter, RepoRef } from '../contracts/index.js';
import { repoRefFromUrl } from '../daemon/reload.js';
import { requirePublicOptIn } from './public-guard.js';

export type AddResult = { added: true; repo: RepoRef } | { added: false; reason: string };

export interface AddRepoInput {
  url: string;
  commit?: boolean; // default true
  /** Conscious opt-in to onboard a PUBLIC repo (§13.1, OD-3). Declares public-ness in
   *  v1 (no auto-detection) AND opts in. Omitted → treated as private. */
  public?: boolean;
}

export interface AddRepoDeps {
  exec: Exec;
  configPath: string;
  adapterFor: (repo: RepoRef) => ForgeAdapter;
  /** Does this repo already have a committed WORKFLOW.md? false → seed the bootstrap issue. */
  hasWorkflow?: (repo: RepoRef) => boolean;
  /** Default true; mirrors WORKFLOW.manage_board for a fresh repo (§11). */
  manageBoard?: boolean;
  /** Optional inferred WORKFLOW seed for the bootstrap issue (the CLI wires this after
   *  cloning; absent → marker-only body). */
  seed?: () => Promise<WorkflowSeed>;
  /** When present, after the bootstrap issue is opened, also open a linked DRAFT PR
   *  carrying a sample WORKFLOW.md (clone → infer → push → createDraftMR). Omitted on the
   *  web POST path, which has no workspace/template — that path stays issue-only. */
  bootstrapPr?: {
    workspace: BootstrapWorkspace;
    templateText: string;
    botUser: string;
  };
}

export async function addRepo(input: AddRepoInput, deps: AddRepoDeps): Promise<AddResult> {
  const text = readFileSync(deps.configPath, 'utf8');
  const cfg = parseConfig(text);
  if (!cfg.ok) return { added: false, reason: `config invalid: ${cfg.error}` };

  // 1. Validate + infer forge BEFORE any side effect (B3).
  let repo: RepoRef;
  try {
    repo = repoRefFromUrl(input.url, cfg.value.forges);
  } catch (err) {
    return { added: false, reason: `unknown-forge: ${(err as Error).message}` };
  }

  // 2. Idempotent: already watched → no-op (B2).
  if (cfg.value.repos.some((r) => r.url === input.url)) {
    return { added: false, reason: 'already-watched' };
  }

  // 2b. Public-repo opt-in gate (§13.1, OD-3): refuse to silently onboard a public repo
  //     with no protection. In v1 `--public` both declares public-ness and opts in; the
  //     runtime trigger guard (reconciler A3) is the other half of this defense.
  const gate = requirePublicOptIn({
    visibility: input.public ? 'public' : 'private',
    allowedActors: [],
    optIn: input.public ?? false,
  });
  if (!gate.ok) return { added: false, reason: gate.reason };

  // 3. Append the entry, preserving comments/formatting (B1).
  const doc = parseDocument(text);
  doc.addIn(['repos'], doc.createNode({ url: input.url }));
  writeFileSync(deps.configPath, doc.toString());

  // 4. §11 setup + add-when-missing bootstrap trigger — the ONE onboarding routine,
  //    shared with any direct caller. No M6-special path (B4).
  const adapter = deps.adapterFor(repo);
  const onboarded = await onboard(repo, {
    adapter,
    hasWorkflow: deps.hasWorkflow?.(repo) ?? false,
    ...(deps.manageBoard !== undefined ? { manageBoard: deps.manageBoard } : {}),
    ...(deps.seed ? { seed: deps.seed } : {}),
  });

  // 4b. When wired (CLI), open the linked draft PR with the sample WORKFLOW.md and point
  //     the bootstrap issue at it. Best-effort: a PR failure must not lose the watch entry
  //     (the repo is already onboarded; the PR can be re-driven). Web path skips this.
  if (deps.bootstrapPr && onboarded.openedIssue && onboarded.issueIid !== undefined) {
    try {
      const mr = await openBootstrapWorkflowPr(repo, onboarded.issueIid, {
        workspace: deps.bootstrapPr.workspace,
        adapter,
        exec: deps.exec,
        templateText: deps.bootstrapPr.templateText,
        botUser: deps.bootstrapPr.botUser,
      });
      await adapter.commentIssue(
        repo,
        onboarded.issueIid,
        `🎼 Opened #${mr.iid} with a suggested \`WORKFLOW.md\` to refine.`,
      );
    } catch (err) {
      // Surfaced, not fatal — the issue + labels + watch entry already landed.
      await adapter.commentIssue(
        repo,
        onboarded.issueIid,
        `⚠️ maestro could not open the sample-WORKFLOW PR automatically: ${(err as Error).message}`,
      );
    }
  }

  // 5. Commit by default, staging the config path EXPLICITLY (B5/B7).
  if (input.commit !== false) {
    await commitConfig(deps.exec, deps.configPath, `Add ${repo.project} to maestro watchlist`);
  }
  return { added: true, repo };
}

/** Two git calls behind one helper: stage the explicit path, then commit. Never `git
 *  add .`/`-A`, never `.env` — explicit-path staging removes the secrets question (§5). */
async function commitConfig(exec: Exec, configPath: string, subject: string): Promise<void> {
  await exec.run('git', ['add', configPath]);
  await exec.run('git', ['commit', '-m', subject]);
}
