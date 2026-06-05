import { describe, expect, it } from 'vitest';
import { DONE_SENTINEL, PLAN_COMMENT_SENTINEL } from '../src/contracts/index.js';
import { RateLimitGate } from '../src/daemon/rate-limit-gate.js';
import { tickRepo, withClosesTrailer } from '../src/daemon/tick.js';
import {
  buildContext,
  labels,
  makeSnapshot,
  recordingAdapter,
  repo,
  scriptedRunner,
  user,
} from './helpers/daemon.js';

// Part A — single-tick lifecycle. One acting intent per slice. We assert the daemon's
// ORCHESTRATION (adapter call order, runner invocation, label sets, slot deltas),
// treating M1's reconciler and M3/M4 units as already-tested black boxes.

describe('A1 — start-new executes the New path', () => {
  it('claims a slot, sets up branch+MR+label+comment before running the agent, releases the slot', async () => {
    const adapter = recordingAdapter({ snapshot: makeSnapshot() }); // new issue, no maestro labels
    const runner = scriptedRunner({ status: 'in_progress', summary: '' });
    const { ctx, ws, slots } = buildContext({ adapter, runner });

    await tickRepo(repo, ctx);

    const order = adapter.calls.filter((c) =>
      ['createBranch', 'createDraftMR', 'setIssueLabels', 'commentIssue'].includes(c),
    );
    expect(order).toEqual(['createBranch', 'createDraftMR', 'setIssueLabels', 'commentIssue']);
    // the branch is seeded with a commit BEFORE the PR is opened, else GitHub 422s (#14)
    expect(ws.seeded).toEqual([{ dir: '/ws/42', branch: adapter.branches[0]?.name }]);
    // branch + MR are consistent and target the resolved git target
    expect(adapter.branches[0]?.fromRef).toBe('main');
    expect(adapter.createdMRs[0]?.sourceBranch).toBe(adapter.branches[0]?.name);
    expect(adapter.createdMRs[0]?.targetBranch).toBe('main');
    expect(adapter.createdMRs[0]?.draft).toBe(true);
    expect(adapter.createdMRs[0]?.description).toContain('Closes #42');
    // label flip into in-progress, retiring the queued marker (#53)
    expect(adapter.labelOps).toEqual([{ iid: 42, set: [labels.inProgress], unset: [labels.todo] }]);
    // a "started" comment is posted
    expect(adapter.issueComments).toHaveLength(1);
    // the agent ran in the prepared workspace
    expect(runner.inputs).toHaveLength(1);
    expect(runner.inputs[0]?.workspaceDir).toBe('/ws/42');
    expect(runner.inputs[0]?.claude.command).toBe('claude');
    // slot released in finally
    expect(slots.globalActive).toBe(0);
    expect(ws.evicted).toEqual([]);
  });
});

describe('A2 — run-agent resumes an in-progress issue', () => {
  it('runs the agent with no branch/MR creation, threading the snapshot context', async () => {
    const snap = makeSnapshot({
      issue: { labels: [labels.inProgress] },
      comments: ['a prior note'],
    });
    const adapter = recordingAdapter({ snapshot: snap });
    const runner = scriptedRunner({ status: 'in_progress', summary: '' });
    const { ctx, slots } = buildContext({ adapter, runner });

    await tickRepo(repo, ctx);

    expect(adapter.calls).not.toContain('createBranch');
    expect(adapter.calls).not.toContain('createDraftMR');
    expect(runner.inputs).toHaveLength(1);
    expect(runner.inputs[0]?.context.mr?.iid).toBe(7);
    expect(runner.inputs[0]?.context.recentComments.map((c) => c.body)).toEqual(['a prior note']);
    expect(slots.globalActive).toBe(0);
  });
});

describe('A3 — apply-changes-requested feeds feedback back to the agent', () => {
  it('flips in-review→in-progress and runs the agent with the review feedback', async () => {
    const snap = makeSnapshot({
      issue: { labels: [labels.inReview] },
      mr: { approvals: { approved: false, approvedBy: [], changesRequested: true } },
      comments: ['please rename the handler'],
    });
    const adapter = recordingAdapter({ snapshot: snap });
    const runner = scriptedRunner({ status: 'in_progress', summary: '' });
    const { ctx, slots } = buildContext({ adapter, runner });

    await tickRepo(repo, ctx);

    expect(adapter.labelOps).toEqual([
      { iid: 42, set: [labels.inProgress], unset: [labels.inReview] },
    ]);
    expect(runner.inputs).toHaveLength(1);
    expect(runner.inputs[0]?.context.recentComments.map((c) => c.body)).toEqual([
      'please rename the handler',
    ]);
    expect(slots.globalActive).toBe(0);
  });
});

describe('A3b — apply-unblock resumes a blocked issue with the maintainer answer', () => {
  it('flips blocked→in-progress and runs the agent with the reply threaded in', async () => {
    const snap = makeSnapshot({ issue: { labels: [labels.blocked] } });
    // newest-first: maintainer reply (12:00) post-dates the bot block comment (10:00)
    snap.recentComments = [
      {
        id: 'h1',
        author: user('reporter'),
        body: 'use postgres',
        createdAt: '2026-06-04T12:00:00Z',
      },
      {
        id: 'b1',
        author: user('maestro-bot'),
        body: '🚧 Blocked — agent needs input:\n\nwhich database?',
        createdAt: '2026-06-04T10:00:00Z',
      },
    ];
    const adapter = recordingAdapter({ snapshot: snap });
    const runner = scriptedRunner({ status: 'in_progress', summary: '' });
    const { ctx, slots } = buildContext({ adapter, runner });

    await tickRepo(repo, ctx);

    // the edge-retiring label flip: blocked → in-progress
    expect(adapter.labelOps).toEqual([
      { iid: 42, set: [labels.inProgress], unset: [labels.blocked] },
    ]);
    // the agent runs with the maintainer's answer (not the bot's block comment)
    expect(runner.inputs).toHaveLength(1);
    expect(runner.inputs[0]?.context.recentComments.map((c) => c.body)).toEqual(['use postgres']);
    expect(slots.globalActive).toBe(0);
  });

  it('queues (no label flip, no run) when no concurrency slot is free', async () => {
    const snap = makeSnapshot({ issue: { labels: [labels.blocked] } });
    snap.recentComments = [
      {
        id: 'h1',
        author: user('reporter'),
        body: 'use postgres',
        createdAt: '2026-06-04T12:00:00Z',
      },
      {
        id: 'b1',
        author: user('maestro-bot'),
        body: '🚧 Blocked',
        createdAt: '2026-06-04T10:00:00Z',
      },
    ];
    const adapter = recordingAdapter({ snapshot: snap });
    const { SlotAccountant } = await import('../src/daemon/slots.js');
    const slots = new SlotAccountant(1);
    slots.acquire('someone-else'); // global cap already full
    const { ctx, runnerSpy } = buildContext({ adapter, slots });

    await tickRepo(repo, ctx);

    expect(adapter.calls).not.toContain('setIssueLabels');
    expect(runnerSpy.inputs).toHaveLength(0);
  });
});

describe('A4 — merge merges per WORKFLOW git rules, consuming no slot', () => {
  it('calls mergeMR with the resolved strategy/deleteSource and never touches the runner', async () => {
    const snap = makeSnapshot({
      issue: { labels: [labels.inReview] },
      mr: { approvals: { approved: true, approvedBy: [], changesRequested: false } },
    });
    const adapter = recordingAdapter({ snapshot: snap });
    const { ctx, runnerSpy, slots } = buildContext({ adapter });

    await tickRepo(repo, ctx);

    expect(adapter.merges).toEqual([{ mrIid: 7, strategy: 'squash', deleteSource: true }]);
    expect(runnerSpy.inputs).toHaveLength(0);
    expect(slots.globalActive).toBe(0);
  });
});

describe('A5 — non-acting intents are pure no-ops', () => {
  const mutating = [
    'createBranch',
    'createDraftMR',
    'setDraft',
    'assignMR',
    'mergeMR',
    'setIssueLabels',
    'commentIssue',
    'commentMR',
  ];
  it.each([
    [
      'poll-review',
      makeSnapshot({
        issue: { labels: [labels.inReview] },
        mr: { approvals: { approved: false, approvedBy: [], changesRequested: false } },
      }),
    ],
    ['blocked-wait', makeSnapshot({ issue: { labels: [labels.blocked] } })],
  ])('%s touches nothing', async (_name, snap) => {
    const adapter = recordingAdapter({ snapshot: snap });
    const { ctx, runnerSpy, slots } = buildContext({ adapter });

    await tickRepo(repo, ctx);

    for (const m of mutating) expect(adapter.calls).not.toContain(m);
    expect(runnerSpy.inputs).toHaveLength(0);
    expect(slots.globalActive).toBe(0);
  });

  it('queued (no slot) marks todo once, then touches nothing (#53)', async () => {
    const snap = makeSnapshot(); // new issue
    const adapter = recordingAdapter({ snapshot: snap });
    const { SlotAccountant } = await import('../src/daemon/slots.js');
    const slots = new SlotAccountant(1);
    slots.acquire('someone-else'); // global cap already full
    const { ctx, runnerSpy } = buildContext({ adapter, slots });

    await tickRepo(repo, ctx);

    // first queued pass: exactly one cheap label write, nothing else
    expect(adapter.labelOps).toEqual([{ iid: 42, set: [labels.todo], unset: [] }]);
    expect(adapter.calls.filter((c) => c === 'createBranch')).toEqual([]);
    expect(runnerSpy.inputs).toHaveLength(0);

    // second queued pass with the marker present: pure no-op
    snap.issue.labels.push(labels.todo);
    await tickRepo(repo, ctx);
    expect(adapter.labelOps).toHaveLength(1);
    expect(runnerSpy.inputs).toHaveLength(0);
  });
});

describe('A6 — AgentResult → lifecycle mapping (§0.9)', () => {
  const inProgress = () => makeSnapshot({ issue: { labels: [labels.inProgress] } });

  it('a. done → immediate handoff this same tick (proofAndHandoff), no block', async () => {
    const adapter = recordingAdapter({ snapshot: inProgress() });
    const runner = scriptedRunner({ status: 'done', summary: 'shipped' });
    const { ctx, proofHandoffSpy, handoffSpy } = buildContext({ adapter, runner });

    await tickRepo(repo, ctx);

    expect(proofHandoffSpy).toHaveBeenCalledTimes(1);
    const arg = proofHandoffSpy.mock.calls[0][0];
    expect(arg.issueIid).toBe(42);
    expect(arg.mrIid).toBe(7);
    expect(arg.ticketCreator).toBe('reporter');
    expect(arg.proofInput.workspaceDir).toBe('/ws/42');
    expect(arg.proofInput.strategies[0]?.type).toBe('diff-summary');
    expect(handoffSpy).not.toHaveBeenCalled(); // done uses proofAndHandoff, not the bare seam
    // not blocked
    expect(adapter.labelOps.some((o) => o.set.includes(labels.blocked))).toBe(false);
  });

  it('b. needs_input → set blocked + comment the reason, no handoff', async () => {
    const adapter = recordingAdapter({ snapshot: inProgress() });
    const runner = scriptedRunner({ status: 'needs_input', summary: 'which database?' });
    const { ctx, proofHandoffSpy } = buildContext({ adapter, runner });

    await tickRepo(repo, ctx);

    expect(adapter.labelOps).toContainEqual({
      iid: 42,
      set: [labels.blocked],
      unset: [labels.inProgress],
    });
    expect(adapter.issueComments.at(-1)?.body).toContain('which database?');
    expect(proofHandoffSpy).not.toHaveBeenCalled();
  });

  it('c. in_progress → stay (no label change, no handoff, resumes next tick)', async () => {
    const adapter = recordingAdapter({ snapshot: inProgress() });
    const runner = scriptedRunner({ status: 'in_progress', summary: '' });
    const { ctx, proofHandoffSpy } = buildContext({ adapter, runner });

    await tickRepo(repo, ctx);

    expect(adapter.labelOps).toEqual([]);
    expect(proofHandoffSpy).not.toHaveBeenCalled();
    expect(adapter.calls).not.toContain('commentIssue');
  });
});

// #48 — the agent has no forge access, so the daemon writes the plan it returns:
// MR description (durable detailed plan + ticked todo) + a one-time issue summary.
describe('A6b — the daemon records the agent plan on the forge (#48)', () => {
  const inProgress = () => makeSnapshot({ issue: { labels: [labels.inProgress] } });

  it('writes mrDescription via updateMRDescription and posts the planComment once', async () => {
    const adapter = recordingAdapter({ snapshot: inProgress() });
    const mrDescription = '## Plan\n\n- [x] step one\n- [ ] step two\n\nCloses #42';
    const runner = scriptedRunner({
      status: 'in_progress',
      summary: 'planned',
      planComment: 'Here is my plan',
      mrDescription,
    });
    const { ctx } = buildContext({ adapter, runner });

    await tickRepo(repo, ctx);

    expect(adapter.mrDescriptions).toEqual([{ mrIid: 7, body: mrDescription }]);
    const plan = adapter.issueComments.at(-1);
    expect(plan?.iid).toBe(42);
    expect(plan?.body).toContain('Here is my plan');
    expect(plan?.body).toContain(PLAN_COMMENT_SENTINEL);
  });

  it('preserves Closes #N when the agent description dropped it', async () => {
    const adapter = recordingAdapter({ snapshot: inProgress() });
    const runner = scriptedRunner({
      status: 'in_progress',
      summary: '',
      mrDescription: '## Plan\n\n- [ ] do it', // no Closes line
    });
    const { ctx } = buildContext({ adapter, runner });

    await tickRepo(repo, ctx);

    expect(adapter.mrDescriptions[0]?.body).toMatch(/Closes #42$/);
  });

  it('does not re-post the plan comment when the sentinel is already on the issue', async () => {
    const snap = makeSnapshot({
      issue: { labels: [labels.inProgress] },
      comments: [`### 🎼 Plan\n\nearlier plan\n\n${PLAN_COMMENT_SENTINEL}`],
    });
    const adapter = recordingAdapter({ snapshot: snap });
    const runner = scriptedRunner({
      status: 'in_progress',
      summary: '',
      planComment: 'a second plan attempt',
    });
    const { ctx } = buildContext({ adapter, runner });

    await tickRepo(repo, ctx);

    expect(adapter.calls).not.toContain('commentIssue');
  });

  it('records no plan when the agent returns none (back-compat)', async () => {
    const adapter = recordingAdapter({ snapshot: inProgress() });
    const runner = scriptedRunner({ status: 'in_progress', summary: '' });
    const { ctx } = buildContext({ adapter, runner });

    await tickRepo(repo, ctx);

    expect(adapter.calls).not.toContain('updateMRDescription');
    expect(adapter.calls).not.toContain('commentIssue');
  });
});

describe('A6c — withClosesTrailer', () => {
  it('appends the closing keyword when absent', () => {
    expect(withClosesTrailer('a plan', 42)).toBe('a plan\n\nCloses #42');
  });
  it.each(['Closes #42', 'fixes #42', 'Resolves #42'])('leaves %s untouched', (ref) => {
    const body = `## Plan\n\n${ref}`;
    expect(withClosesTrailer(body, 42)).toBe(body);
  });
  it('ignores a different issue number', () => {
    expect(withClosesTrailer('Closes #99', 42)).toBe('Closes #99\n\nCloses #42');
  });
});

// guards a subtle wiring point: the crash-recovery detector keys off the sentinel
describe('A6 sanity — a fresh done has no pre-existing sentinel', () => {
  it('does not treat a just-started in-progress issue as already handed off', async () => {
    const snap = makeSnapshot({ issue: { labels: [labels.inProgress] }, comments: [] });
    expect(snap.recentComments.some((c) => c.body.includes(DONE_SENTINEL))).toBe(false);
  });
});

// Agent push-back (§13.1): the agent's env has the forge token scrubbed, so the DAEMON
// must push the agent's commits — otherwise the work never reaches the PR.
describe('A7 — the daemon pushes the agent commits to the MR branch', () => {
  it('start-new pushes the newly created branch after the agent runs', async () => {
    const adapter = recordingAdapter({ snapshot: makeSnapshot() }); // New issue
    const runner = scriptedRunner({ status: 'in_progress', summary: '' });
    const { ctx, ws } = buildContext({ adapter, runner });

    await tickRepo(repo, ctx);

    const branch = adapter.branches[0]?.name; // the branch start-new created
    expect(branch).toBeTruthy();
    expect(ws.pushed).toEqual([{ dir: '/ws/42', branch }]);
  });

  it('resume re-materializes the workspace on the MR branch and pushes it back', async () => {
    const snap = makeSnapshot({ issue: { labels: [labels.inProgress] } }); // In-progress
    const adapter = recordingAdapter({ snapshot: snap });
    const runner = scriptedRunner({ status: 'in_progress', summary: '' });
    const { ctx, ws } = buildContext({ adapter, runner });

    await tickRepo(repo, ctx);

    // resumed on the MR's OWN branch (not target=main), then pushed back
    expect(ws.ensured).toContainEqual({ iid: 42, fromRef: 'maestro/issue-42' });
    expect(adapter.calls).not.toContain('createDraftMR'); // no new PR on resume
    expect(ws.pushed).toEqual([{ dir: '/ws/42', branch: 'maestro/issue-42' }]);
  });
});

describe('A8 — rate-limited run pauses ALL spawning until the gate reopens (#47)', () => {
  const inProgress = () => makeSnapshot({ issue: { labels: [labels.inProgress] } });
  const MIN = 60_000;

  it('trips the gate, mutates nothing, skips spawns, resumes after the deadline', async () => {
    let t = 1_000_000;
    const rateGate = new RateLimitGate({ now: () => t });
    const adapter = recordingAdapter({ snapshot: inProgress() });
    const runner = scriptedRunner([
      { status: 'in_progress', summary: 'claude usage/rate limit reached', rateLimit: {} },
      { status: 'in_progress', summary: 'resumed fine' },
    ]);
    const { ctx, runnerSpy, proofHandoffSpy } = buildContext({ adapter, runner, rateGate });

    await tickRepo(repo, ctx); // run happens, comes back rate-limited
    expect(runnerSpy.inputs).toHaveLength(1);
    expect(rateGate.pausedUntil()).toBe(t + 5 * MIN); // base backoff
    // doomed spawn, not an agent error: no lifecycle transition of any kind
    expect(adapter.labelOps).toEqual([]);
    expect(proofHandoffSpy).not.toHaveBeenCalled();

    await tickRepo(repo, ctx); // paused → spawn skipped as a no-op
    expect(runnerSpy.inputs).toHaveLength(1);

    t += 6 * MIN; // clock passes the deadline → gate reopens by itself
    await tickRepo(repo, ctx);
    expect(runnerSpy.inputs).toHaveLength(2);
  });

  it('the CLI-reported reset time wins over the default backoff', async () => {
    const t = 1_000_000;
    const rateGate = new RateLimitGate({ now: () => t, marginMs: 30_000 });
    const adapter = recordingAdapter({ snapshot: inProgress() });
    const runner = scriptedRunner({
      status: 'in_progress',
      summary: 'limit',
      rateLimit: { resetAt: t + 42 * MIN },
    });
    const { ctx } = buildContext({ adapter, runner, rateGate });

    await tickRepo(repo, ctx);
    expect(rateGate.pausedUntil()).toBe(t + 42 * MIN + 30_000);
  });

  it('a healthy run clears the trip streak', async () => {
    let t = 1_000_000;
    const rateGate = new RateLimitGate({ now: () => t });
    const adapter = recordingAdapter({ snapshot: inProgress() });
    const runner = scriptedRunner([
      { status: 'in_progress', summary: 'limit', rateLimit: {} },
      { status: 'in_progress', summary: 'working' },
      { status: 'in_progress', summary: 'limit again', rateLimit: {} },
    ]);
    const { ctx } = buildContext({ adapter, runner, rateGate });

    await tickRepo(repo, ctx); // trip #1 → 5 min
    t += 6 * MIN;
    await tickRepo(repo, ctx); // healthy → clear()
    expect(rateGate.pausedUntil()).toBeNull();
    await tickRepo(repo, ctx); // trip again → back at BASE, not doubled
    expect(rateGate.pausedUntil()).toBe(t + 5 * MIN);
  });
});

describe('A9 — forge comments are structured Markdown (#25)', () => {
  it('start-of-work comment names the branch, links the MR, and flags the coming plan', async () => {
    const adapter = recordingAdapter({ snapshot: makeSnapshot() }); // new issue → start-new
    const runner = scriptedRunner({ status: 'in_progress', summary: 'working' });
    const { ctx } = buildContext({ adapter, runner });

    await tickRepo(repo, ctx);

    const started = adapter.issueComments.find((c) => c.body.includes('started work'));
    expect(started).toBeDefined();
    expect(started?.body).toContain('- Branch: `');
    expect(started?.body).toContain('Draft MR:');
    expect(started?.body).toContain('plan summary follows');
  });

  it('blocked comment is a scannable section: heading + questions + how to unblock', async () => {
    const adapter = recordingAdapter({
      snapshot: makeSnapshot({ issue: { labels: [labels.inProgress] } }),
    });
    const runner = scriptedRunner({
      status: 'needs_input',
      summary: '1. postgres or sqlite?\n2. which node version?',
    });
    const { ctx } = buildContext({ adapter, runner });

    await tickRepo(repo, ctx);

    const blocked = adapter.issueComments.find((c) => c.body.includes('🚧'));
    expect(blocked?.body).toContain('### 🚧 Blocked — input needed');
    expect(blocked?.body).toContain('1. postgres or sqlite?'); // questions verbatim
    expect(blocked?.body).toContain('Reply in this thread');
  });
});
