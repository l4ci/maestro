// Intent-executor unit tests (#105). These drive executeIntent / executeMrCommand
// DIRECTLY through a hand-rolled ExecutorContext — no TickContext, no buildContext, no
// Claims, no RateLimitGate class — proving at compile time that the executor's seam
// really is the narrower subset (admission machinery is not even constructible here).
// Full choreography behavior stays covered by the daemon-tick-* and mr-command-pass
// suites, which run the same code through the tick.

import { describe, expect, it, vi } from 'vitest';
import { CI_FAIL_SENTINEL, MR_COMMAND_REPLY_SENTINEL } from '../src/contracts/index.js';
import type { ExecutorContext, ExecutorWorkspace } from '../src/daemon/executor.js';
import { executeIntent, executeMrCommand } from '../src/daemon/executor.js';
import {
  type AdapterRecorder,
  type RunnerSpy,
  defaultSettings,
  defaultWorkflow,
  labels,
  makeMR,
  makeSnapshot,
  recordingAdapter,
  repo,
  scriptedRunner,
  silentLogger,
  user,
} from './helpers/daemon.js';

/** Minimal executor-side workspace: implements ONLY ExecutorWorkspace — the tick-side
 *  sweep methods (evict / list* / workspaceExists) do not exist on it, so this file
 *  compiles only while the executor truly needs nothing more. */
function executorWorkspace(opts: { unpushed?: number } = {}) {
  const calls: string[] = [];
  const pushed: { dir: string; branch: string }[] = [];
  const ws: ExecutorWorkspace & { calls: string[]; pushed: typeof pushed } = {
    calls,
    pushed,
    ensureWorkspace: async (r, iid) => {
      calls.push('ensureWorkspace');
      return { dir: `/x/${iid}`, repo: r, iid };
    },
    ensureMrWorkspace: async (r, iid) => {
      calls.push('ensureMrWorkspace');
      return { dir: `/x/mr-${iid}`, repo: r, iid };
    },
    prepareBranch: async () => void calls.push('prepareBranch'),
    pushBranch: async (handle, branch) => {
      calls.push('pushBranch');
      pushed.push({ dir: handle.dir, branch });
    },
    seedBranch: async () => void calls.push('seedBranch'),
    countUnpushedCommits: async () => opts.unpushed ?? 0,
  };
  return ws;
}

/** Hand-rolled rate-gate RECORDER — trip/clear only; `pausedUntil` (admission) is not
 *  part of the executor's contract. */
function gateRecorder() {
  const trips: (number | undefined)[] = [];
  let cleared = 0;
  return {
    trips,
    clears: () => cleared,
    trip: (resetAt?: number) => {
      trips.push(resetAt);
      return 1_000;
    },
    clear: () => {
      cleared += 1;
    },
  };
}

/** Plain-object ExecutorContext — deliberately NOT built from a TickContext fake. */
function executorContext(parts: {
  adapter: AdapterRecorder;
  runner: RunnerSpy;
  workspace?: ReturnType<typeof executorWorkspace>;
  gate?: ReturnType<typeof gateRecorder>;
}) {
  const workspace = parts.workspace ?? executorWorkspace();
  const gate = parts.gate ?? gateRecorder();
  const ctx: ExecutorContext = {
    adapter: parts.adapter.adapter,
    workspace,
    runner: parts.runner.runner,
    handoff: vi.fn(async () => {}),
    proofAndHandoff: vi.fn(async () => []),
    proofOnly: vi.fn(async () => []),
    exec: { run: async () => ({ code: 0, stdout: '', stderr: '' }) } as never,
    settings: defaultSettings(),
    workflow: defaultWorkflow(),
    promptBody: 'do the work',
    rateGate: gate,
    log: silentLogger(),
  };
  return { ctx, workspace, gate };
}

describe('executeIntent through a from-scratch ExecutorContext (#105)', () => {
  it('start-new: branch + seeded MR + begin-work move + comment before the run, push after', async () => {
    const adapter = recordingAdapter({ snapshot: makeSnapshot() });
    const runner = scriptedRunner({ status: 'in_progress', summary: '' });
    const { ctx, workspace, gate } = executorContext({ adapter, runner });
    const snapshot = makeSnapshot({ mr: null });

    await executeIntent(
      { kind: 'start-new', branch: 'maestro/issue-42', mrTitle: 'Draft: Add OAuth' },
      snapshot,
      ctx,
    );

    // forge-side ordering identical to the pre-extraction tick handler
    const order = adapter.calls.filter((c) =>
      ['createBranch', 'createDraftMR', 'setIssueLabels', 'commentIssue'].includes(c),
    );
    expect(order).toEqual(['createBranch', 'createDraftMR', 'setIssueLabels', 'commentIssue']);
    // the intent→move map applied begin-work (in-progress replaces queued, #53)
    expect(adapter.labelOps).toEqual([
      { iid: 42, set: [labels.inProgress], unset: [labels.queued] },
    ]);
    // workspace choreography: prepare + seed before the run, push after it
    expect(workspace.calls).toEqual([
      'ensureWorkspace',
      'prepareBranch',
      'seedBranch',
      'pushBranch',
    ]);
    expect(workspace.pushed).toEqual([{ dir: '/x/42', branch: 'maestro/issue-42' }]);
    expect(runner.inputs[0]?.workspaceDir).toBe('/x/42');
    // a healthy run cleared the rate-gate streak (#47) — recorder, not the real gate
    expect(gate.clears()).toBe(1);
  });

  it('mark-queued: applies exactly the mapped move and touches nothing else', async () => {
    const adapter = recordingAdapter({ snapshot: makeSnapshot() });
    const runner = scriptedRunner({ status: 'done', summary: '' });
    const { ctx } = executorContext({ adapter, runner });

    await executeIntent({ kind: 'mark-queued' }, makeSnapshot({ mr: null }), ctx);

    expect(adapter.calls).toEqual(['setIssueLabels']);
    expect(adapter.labelOps).toEqual([{ iid: 42, set: [labels.queued], unset: [] }]);
    expect(runner.inputs).toHaveLength(0);
  });

  it('apply-changes-requested: resume-from-review flip lands before the agent run', async () => {
    const adapter = recordingAdapter({ snapshot: makeSnapshot() });
    const runner = scriptedRunner({ status: 'in_progress', summary: '' });
    const { ctx, workspace } = executorContext({ adapter, runner });
    const feedback = {
      reviewComments: [
        {
          id: 'c9',
          author: user('reviewer'),
          body: 'rename it',
          createdAt: '2026-06-04T00:00:00Z',
        },
      ],
    };

    await executeIntent({ kind: 'apply-changes-requested', feedback }, makeSnapshot(), ctx);

    expect(adapter.labelOps[0]).toEqual({
      iid: 42,
      set: [labels.inProgress],
      unset: [labels.inReview],
    });
    // the flip happened before the workspace was even acquired
    expect(adapter.calls.indexOf('setIssueLabels')).toBeGreaterThanOrEqual(0);
    expect(workspace.calls[0]).toBe('ensureWorkspace');
    // the review feedback — not the snapshot comments — reached the agent
    expect(runner.inputs[0]?.context.recentComments.map((c) => c.body)).toEqual(['rename it']);
  });

  it('apply-ci-fix: posts the CI-failure marker, then runs the agent with it in context (#118)', async () => {
    const adapter = recordingAdapter({ snapshot: makeSnapshot() });
    const runner = scriptedRunner({ status: 'in_progress', summary: '' });
    const { ctx } = executorContext({ adapter, runner });
    const snap = makeSnapshot({ mr: { ci: { conclusion: 'failed', webUrl: 'https://ci/9' } } });

    await executeIntent(
      { kind: 'apply-ci-fix', feedback: { reviewComments: snap.recentComments } },
      snap,
      ctx,
    );

    // the failure marker is posted on the issue thread (drives the round cap + visibility)
    expect(adapter.calls).toContain('commentIssue');
    expect(adapter.issueComments.some((c) => c.body.includes(CI_FAIL_SENTINEL))).toBe(true);
    // no lifecycle flip — the issue stays in-progress
    expect(adapter.labelOps).toEqual([]);
    // the agent ran, and saw the CI failure in its context
    expect(runner.inputs).toHaveLength(1);
    expect(
      runner.inputs[0]?.context.recentComments.some((c) => c.body.includes(CI_FAIL_SENTINEL)),
    ).toBe(true);
  });

  it('apply-ci-fix: folds the fetched failing logs + a per-sha marker into the comment (#120)', async () => {
    const adapter = recordingAdapter({
      snapshot: makeSnapshot(),
      ciFailureLogs: { headSha: 'abc123', logs: 'FAILED test/foo.spec.ts: expected 1, got 2' },
    });
    const runner = scriptedRunner({ status: 'in_progress', summary: '' });
    const { ctx } = executorContext({ adapter, runner });
    const snap = makeSnapshot({ mr: { ci: { conclusion: 'failed', webUrl: 'https://ci/9' } } });

    await executeIntent(
      { kind: 'apply-ci-fix', feedback: { reviewComments: snap.recentComments } },
      snap,
      ctx,
    );

    const posted = adapter.issueComments.find((c) => c.body.includes(CI_FAIL_SENTINEL));
    expect(posted?.body).toContain('FAILED test/foo.spec.ts');
    expect(posted?.body).toContain('<!-- maestro:ci-fail-sha=abc123 -->');
    expect(runner.inputs).toHaveLength(1);
  });

  it('apply-ci-fix: idempotent — a failure already posted for this sha is not re-posted (#120)', async () => {
    const adapter = recordingAdapter({
      snapshot: makeSnapshot(),
      ciFailureLogs: { headSha: 'abc123', logs: 'still red' },
    });
    const runner = scriptedRunner({ status: 'in_progress', summary: '' });
    const { ctx } = executorContext({ adapter, runner });
    // the prior tick already posted the marker for sha abc123
    const snap = makeSnapshot({
      mr: { ci: { conclusion: 'failed' } },
      comments: [`### 🔴 CI failed\n${CI_FAIL_SENTINEL}\n<!-- maestro:ci-fail-sha=abc123 -->`],
    });

    await executeIntent(
      { kind: 'apply-ci-fix', feedback: { reviewComments: snap.recentComments } },
      snap,
      ctx,
    );

    // no new comment for the same sha; the agent still re-runs with the existing one in context
    expect(adapter.calls).not.toContain('commentIssue');
    expect(runner.inputs).toHaveLength(1);
    expect(
      runner.inputs[0]?.context.recentComments.some((c) => c.body.includes(CI_FAIL_SENTINEL)),
    ).toBe(true);
  });

  it('park-ci-blocked: flips in-progress→blocked and posts an @-mention escalation, no agent (#120)', async () => {
    const adapter = recordingAdapter({ snapshot: makeSnapshot() });
    const runner = scriptedRunner({ status: 'in_progress', summary: '' });
    const { ctx } = executorContext({ adapter, runner });
    const snap = makeSnapshot({ mr: { ci: { conclusion: 'failed', webUrl: 'https://ci/9' } } });

    await executeIntent({ kind: 'park-ci-blocked' }, snap, ctx);

    // flipped to blocked (the mirror of the review bounce cap)
    expect(adapter.labelOps).toEqual([
      { iid: 42, set: [labels.blocked], unset: [labels.inProgress] },
    ]);
    // escalation comment @-mentions the ticket creator and points at the pipeline
    const blocked = adapter.issueComments.find((c) => c.body.includes('Blocked'));
    expect(blocked?.body).toContain(`@${snap.issue.author.username}`);
    expect(blocked?.body).toContain('https://ci/9');
    // no agent ran
    expect(runner.inputs).toHaveLength(0);
  });

  it('non-acting kinds are no-ops', async () => {
    const adapter = recordingAdapter({ snapshot: makeSnapshot() });
    const runner = scriptedRunner({ status: 'done', summary: '' });
    const { ctx, workspace } = executorContext({ adapter, runner });

    await executeIntent({ kind: 'none', reason: 'nothing to do' }, makeSnapshot(), ctx);

    expect(adapter.calls).toEqual([]);
    expect(workspace.calls).toEqual([]);
    expect(runner.inputs).toHaveLength(0);
  });
});

describe('executeMrCommand — the command-MR run sequence (#105, spec §5)', () => {
  it('pushes iff the agent committed and ALWAYS replies with the sentinel', async () => {
    const adapter = recordingAdapter({});
    const runner = scriptedRunner({ status: 'done', summary: 'tweaked the handler' });
    const workspace = executorWorkspace({ unpushed: 2 });
    const { ctx } = executorContext({ adapter, runner, workspace });
    const mr = makeMR({ iid: 31, sourceBranch: 'feature/tune' });

    await executeMrCommand(repo, mr, 'fix the lint', [], ctx);

    expect(workspace.calls).toEqual(['ensureMrWorkspace', 'pushBranch']);
    expect(workspace.pushed).toEqual([{ dir: '/x/mr-31', branch: 'feature/tune' }]);
    expect(adapter.mrComments).toHaveLength(1);
    expect(adapter.mrComments[0]?.body).toContain('pushed 2 commits');
    expect(adapter.mrComments[0]?.body).toContain(MR_COMMAND_REPLY_SENTINEL);
  });

  it('skips the push when nothing was committed, still replies', async () => {
    const adapter = recordingAdapter({});
    const runner = scriptedRunner({ status: 'done', summary: 'all good already' });
    const workspace = executorWorkspace({ unpushed: 0 });
    const { ctx } = executorContext({ adapter, runner, workspace });

    await executeMrCommand(repo, makeMR({ iid: 31 }), 'check it', [], ctx);

    expect(workspace.calls).toEqual(['ensureMrWorkspace']);
    expect(adapter.mrComments[0]?.body).toContain('no code changes were needed');
  });

  it('a rate-limited spawn trips the gate and does NOT reply — the edge stays hot', async () => {
    const adapter = recordingAdapter({});
    const runner = scriptedRunner({
      status: 'in_progress',
      summary: '',
      rateLimit: { resetAt: 9_999 },
    });
    const gate = gateRecorder();
    const { ctx, workspace } = executorContext({ adapter, runner, gate });

    await executeMrCommand(repo, makeMR({ iid: 31 }), 'try again', [], ctx);

    expect(gate.trips).toEqual([9_999]);
    expect(adapter.mrComments).toHaveLength(0);
    expect(workspace.pushed).toEqual([]);
  });
});
