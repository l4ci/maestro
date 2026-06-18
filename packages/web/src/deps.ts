// Thin wiring: turn the real core routines (assembleDashboard / assembleIssue / addRepo)
// into the seam-shaped ServerDeps that createServer consumes. Deliberately UN-unit-tested —
// it's pure plumbing of real forge/git I/O (integration territory). The unit tests inject
// fakes straight into createServer; this helper only exists so a production entrypoint can
// say `createServer(buildServerDeps(...))` without duplicating the read-only/write split.

import {
  type AddRepoDeps,
  type AssembleDeps,
  type OpenIssueItem,
  type RepoRef,
  type WorkResult,
  addRepo,
  assembleDashboard,
  assembleIssue,
} from '@maestro/core';
import type { ServerDeps } from './server.js';

export interface BuildServerDepsArgs {
  /** The repos the dashboard projects (from the loaded config). */
  repos: RepoRef[];
  /** Read-only assembly seam (read-only-narrowed adapter inside). */
  assemble: AssembleDeps;
  /** Write seam for POST /repos — the SAME addRepo `maestro add` uses. */
  add: AddRepoDeps;
  /** Resolve a repo id (the :id path segment) back to a RepoRef for /repos/:id. */
  repoForId: (repoId: string) => RepoRef;
  /**
   * Bearer token gating POST /repos. Undefined → writes stay disabled (read-only host).
   * Read from the env at the composition root; never logged.
   */
  writeToken?: string;
}

export function buildServerDeps(args: BuildServerDepsArgs): ServerDeps {
  return {
    loadDashboard: () => assembleDashboard(args.repos, args.assemble),
    loadIssue: (repoId, iid) => assembleIssue(args.repoForId(repoId), iid, args.assemble),
    // commit:true by default — the web `add` has the same effect as `maestro add` (§8).
    addRepo: (url) => addRepo({ url, commit: true }, args.add),
    // Stubs — wired up in Task 6 (next step: deps.ts + main.ts integration).
    loadOpenIssues: (_repoId: string): Promise<OpenIssueItem[]> => Promise.resolve([]),
    workOnIssue: (_repoId: string, _iid: number): Promise<WorkResult> =>
      Promise.resolve({ ok: true }),
    ...(args.writeToken ? { writeToken: args.writeToken } : {}),
  };
}
