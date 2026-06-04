// Shared `add a repo` routine (OD-4). The ONE implementation behind both `maestro add`
// (CLI) and the web POST /repos — never two copies (the rot M0 forbids). It appends a
// repos[] entry to maestro.config.yaml preserving comments, runs §11 onboarding setup
// through the adapter (labels + board + the §16 bootstrap issue), and commits by default
// staging ONLY the config path (never `.`/`-A`/`.env`; §5 secrets never enter git).

import { readFileSync, writeFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { parseConfig } from '../config/load-config.js';
import { BOOTSTRAP_MARKER } from '../contracts/bootstrap.js';
import type { Exec, ForgeAdapter, Label, RepoRef } from '../contracts/index.js';
import { labelNames } from '../contracts/labels.js';
import { repoRefFromUrl } from '../daemon/reload.js';

export type AddResult = { added: true; repo: RepoRef } | { added: false; reason: string };

export interface AddRepoInput {
  url: string;
  commit?: boolean; // default true
}

export interface AddRepoDeps {
  exec: Exec;
  configPath: string;
  adapterFor: (repo: RepoRef) => ForgeAdapter;
  /** Does this repo already have a committed WORKFLOW.md? false → seed the bootstrap issue. */
  hasWorkflow?: (repo: RepoRef) => boolean;
  /** Default true; mirrors WORKFLOW.manage_board for a fresh repo (§11). */
  manageBoard?: boolean;
}

/** The §16 onboarding issue body — greppable marker keeps a repeated add idempotent (M8). */
const BOOTSTRAP_BODY = `Maestro is now watching this repo. Define how it should work by committing a \`WORKFLOW.md\`, then assign issues to the bot.\n\n${BOOTSTRAP_MARKER}`;

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

  // 3. Append the entry, preserving comments/formatting (B1).
  const doc = parseDocument(text);
  doc.addIn(['repos'], doc.createNode({ url: input.url }));
  writeFileSync(deps.configPath, doc.toString());

  // 4. §11 setup through the adapter — reuses M2 verbatim, no M6-special path (B4).
  const adapter = deps.adapterFor(repo);
  const labels: Label[] = labelNames(repo.forge)
    .all()
    .map((name) => ({ name }));
  await adapter.ensureLabels(repo, labels);
  if (repo.forge === 'gitlab' && (deps.manageBoard ?? true) && adapter.ensureBoard) {
    await adapter.ensureBoard(repo, labels);
  }
  if (!(deps.hasWorkflow?.(repo) ?? false)) {
    await adapter.createIssue(repo, {
      title: "Let's define my workflow",
      body: BOOTSTRAP_BODY,
      assignToBot: true,
    });
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
