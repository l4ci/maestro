// Executor catch path for proof failures (#109): the typed ProofGenerationError feeds
// the per-issue streak and the pure decideProofFailure edge — failures 1 and 2 retry
// silently, the third straight failure parks the issue blocked with the reason on the
// thread, success clears the streak, and NON-proof errors rethrow to the tick's guard
// untouched. Driven through executeIntent with a from-scratch ExecutorContext, like
// daemon-executor.test.ts.

import { describe, expect, it, vi } from 'vitest';
import type { ExecutorContext, ExecutorWorkspace } from '../src/daemon/executor.js';
import { executeIntent } from '../src/daemon/executor.js';
import { ProofStreaks } from '../src/daemon/proof-streaks.js';
import { ProofGenerationError } from '../src/proof/strategies.js';
import {
  type AdapterRecorder,
  defaultSettings,
  defaultWorkflow,
  labels,
  makeSnapshot,
  recordingAdapter,
  scriptedRunner,
  silentLogger,
} from './helpers/daemon.js';

const proofError = () => new ProofGenerationError('playwright', new Error('browser crashed'));

function workspace(): ExecutorWorkspace {
  return {
    ensureWorkspace: async (r, iid) => ({ dir: `/x/${iid}`, repo: r, iid }),
    ensureMrWorkspace: async (r, iid) => ({ dir: `/x/mr-${iid}`, repo: r, iid }),
    prepareBranch: async () => {},
    pushBranch: async () => {},
    seedBranch: async () => {},
    countUnpushedCommits: async () => 0,
  };
}

/** ExecutorContext with a `done` agent run, so every executeIntent reaches the proof
 *  seam. The proof fns and the streak store are the knobs under test. */
function escalationContext(parts: {
  adapter: AdapterRecorder;
  proofAndHandoff?: ExecutorContext['proofAndHandoff'];
  proofOnly?: ExecutorContext['proofOnly'];
  promptBody?: string;
}) {
  const streaks = new ProofStreaks();
  const log = silentLogger();
  const ctx: ExecutorContext = {
    adapter: parts.adapter.adapter,
    workspace: workspace(),
    runner: scriptedRunner({ status: 'done', summary: 'shipped' }).runner,
    handoff: vi.fn(async () => {}),
    proofAndHandoff: parts.proofAndHandoff ?? vi.fn(async () => []),
    proofOnly: parts.proofOnly ?? vi.fn(async () => []),
    exec: { run: async () => ({ code: 0, stdout: '', stderr: '' }) } as never,
    settings: defaultSettings(),
    workflow: defaultWorkflow(),
    promptBody: parts.promptBody ?? 'do the work',
    rateGate: { trip: () => 1_000, clear: () => {} },
    proofStreaks: streaks,
    log,
  };
  return { ctx, streaks, log };
}

const runAgentIntent = { kind: 'run-agent', resume: true } as const;

describe('executor proof-failure escalation (#109)', () => {
  it('failures 1 and 2 → silent retry: no labels, no comments, a warn each', async () => {
    const adapter = recordingAdapter({ snapshot: makeSnapshot() });
    const { ctx, log } = escalationContext({
      adapter,
      proofAndHandoff: vi.fn(async () => {
        throw proofError();
      }),
    });

    await executeIntent(runAgentIntent, makeSnapshot(), ctx); // streak 1
    await executeIntent(runAgentIntent, makeSnapshot(), ctx); // streak 2

    expect(adapter.labelOps).toEqual([]);
    expect(adapter.issueComments).toEqual([]);
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenLastCalledWith(
      'proof generation failed — retrying next tick (#109)',
      expect.objectContaining({ iid: 42, strategy: 'playwright', streak: 2 }),
    );
  });

  it('third straight failure → park-blocked with the typed reason on the thread', async () => {
    const adapter = recordingAdapter({ snapshot: makeSnapshot() });
    const { ctx } = escalationContext({
      adapter,
      proofAndHandoff: vi.fn(async () => {
        throw proofError();
      }),
    });

    for (let i = 0; i < 3; i++) await executeIntent(runAgentIntent, makeSnapshot(), ctx);

    expect(adapter.labelOps).toEqual([
      { iid: 42, set: [labels.blocked], unset: [labels.inProgress] },
    ]);
    expect(adapter.issueComments).toHaveLength(1);
    const comment = adapter.issueComments[0]?.body ?? '';
    expect(comment).toContain('### 🚧 Blocked — proof generation failed (3 consecutive attempts)');
    expect(comment).toContain('`playwright`');
    expect(comment).toContain('browser crashed');
    // park ordering: the label flip lands before the reason comment
    expect(adapter.calls.indexOf('setIssueLabels')).toBeLessThan(
      adapter.calls.indexOf('commentIssue'),
    );
  });

  it('success clears the streak: fail ×2, succeed, then a fresh failure retries again', async () => {
    const adapter = recordingAdapter({ snapshot: makeSnapshot() });
    const outcomes = ['fail', 'fail', 'ok', 'fail', 'fail'] as const;
    let n = 0;
    const { ctx } = escalationContext({
      adapter,
      proofAndHandoff: vi.fn(async () => {
        if (outcomes[n++] === 'fail') throw proofError();
        return [];
      }),
    });

    for (let i = 0; i < outcomes.length; i++) {
      await executeIntent(runAgentIntent, makeSnapshot(), ctx);
    }

    // five runs, never three CONSECUTIVE failures → never parked
    expect(adapter.labelOps).toEqual([]);
    expect(adapter.issueComments).toEqual([]);
  });

  it('a non-proof error (forge/network) rethrows to the guard untouched', async () => {
    const adapter = recordingAdapter({ snapshot: makeSnapshot() });
    const { ctx, streaks } = escalationContext({
      adapter,
      proofAndHandoff: vi.fn(async () => {
        throw new Error('requestReview: network down');
      }),
    });

    await expect(executeIntent(runAgentIntent, makeSnapshot(), ctx)).rejects.toThrow(
      'network down',
    );
    // the streak only counts TYPED proof failures
    expect(streaks.fail(makeSnapshot().repo, 42)).toBe(1);
  });

  it('pipeline path: a proofOnly failure never flips the issue to in-review', async () => {
    const ROLED = ['## role: implement', 'Execute the plan.'].join('\n');
    const adapter = recordingAdapter({ snapshot: makeSnapshot() });
    const { ctx } = escalationContext({
      adapter,
      promptBody: ROLED,
      proofOnly: vi.fn(async () => {
        throw proofError();
      }),
    });

    await executeIntent(runAgentIntent, makeSnapshot(), ctx);

    expect(adapter.labelOps).toEqual([]); // no enter-review on an unproven run
  });

  it('pipeline path parks on the third failure too, instead of entering review', async () => {
    const ROLED = ['## role: implement', 'Execute the plan.'].join('\n');
    const adapter = recordingAdapter({ snapshot: makeSnapshot() });
    const { ctx } = escalationContext({
      adapter,
      promptBody: ROLED,
      proofOnly: vi.fn(async () => {
        throw proofError();
      }),
    });

    for (let i = 0; i < 3; i++) await executeIntent(runAgentIntent, makeSnapshot(), ctx);

    expect(adapter.labelOps).toEqual([
      { iid: 42, set: [labels.blocked], unset: [labels.inProgress] },
    ]);
    expect(adapter.issueComments).toHaveLength(1);
  });
});
