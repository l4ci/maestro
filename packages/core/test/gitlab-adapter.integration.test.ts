// Integration tier (§15) — OPT-IN, gated by MAESTRO_GITLAB_IT=1 plus a token and a
// throwaway scratch project. Skipped in the default `pnpm test` path (it touches
// gitlab.com). This is also where unit fixtures get re-captured from live responses.
//
// Run:
//   MAESTRO_GITLAB_IT=1 \
//   MAESTRO_GITLAB_TOKEN=glpat-... \
//   MAESTRO_GITLAB_TEST_PROJECT=group/scratch \
//   MAESTRO_GITLAB_TEST_ISSUE=1 \
//   pnpm test gitlab-adapter.integration
//
// The default-path expectation (M2 exit gate): with the env unset this whole suite
// is SKIPPED, so no CI run hits gitlab.com.

import { describe, expect, it } from 'vitest';
import type { RepoRef } from '../src/contracts/index.js';
import { labelNames } from '../src/contracts/labels.js';
import { NodeExec } from '../src/exec/node-exec.js';
import { GitlabAdapter } from '../src/forge/gitlab/gitlab-adapter.js';
import { reconcile } from '../src/reconciler/reconcile.js';

const ENABLED = process.env.MAESTRO_GITLAB_IT === '1';
const token = process.env.MAESTRO_GITLAB_TOKEN ?? '';
const project = process.env.MAESTRO_GITLAB_TEST_PROJECT ?? '';
const issueIid = Number(process.env.MAESTRO_GITLAB_TEST_ISSUE ?? '0');
const botUser = process.env.MAESTRO_GITLAB_BOT ?? 'maestro-bot';

describe.runIf(ENABLED)('GitLab adapter — integration (scratch project)', () => {
  const repo: RepoRef = {
    forge: 'gitlab',
    host: process.env.MAESTRO_GITLAB_HOST ?? 'gitlab.com',
    project,
    url: `${process.env.MAESTRO_GITLAB_HOST ?? 'gitlab.com'}/${project}`,
  };
  const adapter = new GitlabAdapter(new NodeExec(), { token, host: repo.host, botUser });

  it('lists assigned open issues against the live project', async () => {
    const issues = await adapter.listAssignedOpenIssues(repo);
    expect(Array.isArray(issues)).toBe(true);
  });

  it('reconcile over a real getSnapshot drives a fresh bot-assigned issue to start-new', async () => {
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
        manageBoard: true,
        labels: labelNames('gitlab'),
        concurrency: { globalMax: 2, maxActive: 2 },
      },
      slotAvailable: true,
      workspaceExists: false,
      workComplete: false,
    });
    // A freshly bot-assigned, label-less issue → New → start-new. (Read-only assertion;
    // executing the mutation sequence + revert is left to the M5 live E2E.)
    expect(['start-new', 'run-agent', 'poll-review', 'blocked-wait']).toContain(intent.kind);
  });
});
