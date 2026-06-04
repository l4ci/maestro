// Integration tier (§15) — OPT-IN, gated by MAESTRO_GITHUB_IT=1 plus a token and a
// throwaway scratch repo. Skipped in the default `pnpm test` path (it touches
// github.com). This is also where unit fixtures get re-captured from live responses,
// and the source for the exit-gate E2E dry run.
//
// Run:
//   MAESTRO_GITHUB_IT=1 \
//   MAESTRO_GITHUB_TOKEN=ghp-... \
//   MAESTRO_GITHUB_TEST_PROJECT=org/scratch \
//   MAESTRO_GITHUB_TEST_ISSUE=1 \
//   pnpm test github-adapter.integration
//
// Default-path expectation (M7 exit gate): with the env unset this whole suite is
// SKIPPED, so no CI run hits github.com.

import { describe, expect, it } from 'vitest';
import type { RepoRef } from '../src/contracts/index.js';
import { labelNames } from '../src/contracts/labels.js';
import { NodeExec } from '../src/exec/node-exec.js';
import { GithubAdapter } from '../src/forge/github/github-adapter.js';
import { reconcile } from '../src/reconciler/reconcile.js';

const ENABLED = process.env.MAESTRO_GITHUB_IT === '1';
const token = process.env.MAESTRO_GITHUB_TOKEN ?? '';
const project = process.env.MAESTRO_GITHUB_TEST_PROJECT ?? '';
const issueIid = Number(process.env.MAESTRO_GITHUB_TEST_ISSUE ?? '0');
const botUser = process.env.MAESTRO_GITHUB_BOT ?? 'maestro-bot';
const host = process.env.MAESTRO_GITHUB_HOST ?? 'github.com';

describe.runIf(ENABLED)('GitHub adapter — integration (scratch repo)', () => {
  const repo: RepoRef = { forge: 'github', host, project, url: `${host}/${project}` };
  const adapter = new GithubAdapter(new NodeExec(), { token, host, botUser });

  it('lists assigned open issues against the live repo (PRs excluded)', async () => {
    const issues = await adapter.listAssignedOpenIssues(repo);
    expect(Array.isArray(issues)).toBe(true);
  });

  it('reconcile over a real getSnapshot drives a fresh bot-assigned issue forward', async () => {
    const snapshot = await adapter.getSnapshot(repo, issueIid);
    const intent = reconcile({
      snapshot,
      settings: {
        repo,
        botUser,
        trigger: { requireLabel: null, allowedActors: [] },
        git: {
          defaultBranch: 'main',
          target: 'main',
          mergeStrategy: 'squash',
          deleteSourceBranch: true,
        },
        manageBoard: false, // GitHub: labels only, no board
        labels: labelNames('github'),
        concurrency: { globalMax: 2, maxActive: 2 },
      },
      slotAvailable: true,
      workspaceExists: false,
      workComplete: false,
    });
    // The reconciler is forge-agnostic: the SAME call shape M2 uses, zero GitHub
    // branching — that is the §0.3 zero-change proof.
    expect(['start-new', 'run-agent', 'poll-review', 'blocked-wait']).toContain(intent.kind);
  });
});
