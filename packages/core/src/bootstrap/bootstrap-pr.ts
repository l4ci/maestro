// Bootstrap WORKFLOW PR (onboarding iteration 2). When `maestro add` opens the "define
// my workflow" issue, it also opens a linked DRAFT PR carrying a sample WORKFLOW.md
// inferred from the repo — a concrete artifact to refine, instead of a blank issue. The
// normal lifecycle then drives the rest: the agent asks clarifying questions on the issue
// and finalizes the file in this PR. Reuses the existing seams (WorkspaceManager clone/
// push + ForgeAdapter.createDraftMR); no new forge surface.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOOTSTRAP_MARKER } from '../contracts/bootstrap.js';
import type { Exec, ForgeAdapter, MergeRequest, RepoRef } from '../contracts/index.js';
import type { WorkspaceManager } from '../workspace/workspace-manager.js';
import { inferWorkflowSeed } from './infer-workflow-seed.js';

/** The slice of WorkspaceManager this routine needs (narrowed for testability). */
export type BootstrapWorkspace = Pick<
  WorkspaceManager,
  'ensureWorkspace' | 'prepareBranch' | 'commitAndPush'
>;

export interface BootstrapPrDeps {
  workspace: BootstrapWorkspace;
  adapter: ForgeAdapter;
  exec: Exec;
  /** Contents of `templates/WORKFLOW.md` — the seed's base front matter + prompt body. */
  templateText: string;
  /** bot_user for the seed (resolved config default). */
  botUser: string;
  /** Read a repo-relative file from the cloned dir; undefined if absent (injectable). */
  readFile?: (clonedDir: string, relPath: string) => string | undefined;
  /** Write a file at an absolute path (injectable; defaults to fs). */
  writeFile?: (absPath: string, contents: string) => void;
}

/** Clone → infer the sample WORKFLOW.md → push it on a fresh branch → open the draft PR
 *  that `Closes` the bootstrap issue. Returns the opened MR. */
export async function openBootstrapWorkflowPr(
  repo: RepoRef,
  issueIid: number,
  deps: BootstrapPrDeps,
): Promise<MergeRequest> {
  const readFile = deps.readFile ?? defaultReadFile;
  const writeFile = deps.writeFile ?? ((p, c) => writeFileSync(p, c));

  // 1. Clone the repo (fresh) — needed both to infer the seed and to push the branch.
  const handle = await deps.workspace.ensureWorkspace(repo, issueIid, 'HEAD');

  // 2. Infer a schema-valid sample WORKFLOW.md from the cloned tree.
  const seed = await inferWorkflowSeed(repo, {
    exec: deps.exec,
    clonedDir: handle.dir,
    templateText: deps.templateText,
    readFile: (rel) => readFile(handle.dir, rel),
    botUser: deps.botUser,
  });
  const target = seed.frontMatter.git.target;

  // 3. Branch off the default, drop the seed file, commit + push (authenticated).
  const branch = `maestro/issue-${issueIid}-define-workflow`;
  await deps.workspace.prepareBranch(handle, branch);
  writeFile(join(handle.dir, 'WORKFLOW.md'), seed.text);
  await deps.workspace.commitAndPush(handle, {
    paths: ['WORKFLOW.md'],
    message: 'Add maestro WORKFLOW.md (sample — refine via the bootstrap issue)',
    branch,
  });

  // 4. Open the draft PR linked to the bootstrap issue.
  return deps.adapter.createDraftMR(repo, {
    sourceBranch: branch,
    targetBranch: target,
    title: "Define maestro's WORKFLOW.md",
    description: prDescription(issueIid),
    draft: true,
    assignToBot: true,
  });
}

/** PR body: explains the sample is a starting point, links the issue, carries the marker. */
export function prDescription(issueIid: number): string {
  return [
    `Closes #${issueIid}`,
    '',
    'This draft PR adds a **sample** `WORKFLOW.md` inferred from the repo — a starting',
    'point, not the final config.',
    '',
    `Maestro will ask clarifying questions on #${issueIid}; once answered it refines this`,
    'file and marks the PR ready for your review.',
    '',
    BOOTSTRAP_MARKER,
  ].join('\n');
}

function defaultReadFile(clonedDir: string, relPath: string): string | undefined {
  try {
    return readFileSync(join(clonedDir, relPath), 'utf8');
  } catch {
    return undefined;
  }
}
