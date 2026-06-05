import { describe, expect, it, vi } from 'vitest';
import { DONE_SENTINEL, type RepoRef } from '../src/contracts/index.js';
import { repoKey } from '../src/daemon/ports.js';
import { SlotAccountant } from '../src/daemon/slots.js';
import { evaluateLifecycle, selectAdapter, tick, tickRepo } from '../src/daemon/tick.js';
import {
  buildContext,
  defaultSettings,
  fakeWorkspace,
  labels,
  makeIssue,
  makeSnapshot,
  recordingAdapter,
  repo,
  scriptedRunner,
} from './helpers/daemon.js';

const repoB: RepoRef = { ...repo, project: 'group/web', url: 'gitlab.com/group/web' };

// ── Part B — cleanup sweep (§0.5 pass B) ──────────────────────────────────────

describe('B1 — sweep evicts closed and missing, never open', () => {
  it('reads each dir state and evicts only the terminal ones', async () => {
    const ws = fakeWorkspace({
      dirs: [
        { dir: '/ws/1', iid: 1 },
        { dir: '/ws/2', iid: 2 },
        { dir: '/ws/3', iid: 3 },
      ],
    });
    const adapter = recordingAdapter({
      issues: [],
      issueStates: new Map([
        [1, 'closed'],
        [2, 'missing'],
        [3, 'open'],
      ]),
    });
    const { ctx } = buildContext({ adapter, workspace: ws });

    await tickRepo(repo, ctx);

    expect(ws.evicted.sort()).toEqual(['/ws/1', '/ws/2']);
    expect(adapter.calls.filter((c) => c === 'getIssueState')).toHaveLength(3);
  });
});

describe('B2 — sweep is independent of the open-issue list', () => {
  it('evicts terminal dirs even when no open issues are assigned', async () => {
    const ws = fakeWorkspace({
      dirs: [
        { dir: '/ws/8', iid: 8 },
        { dir: '/ws/9', iid: 9 },
      ],
    });
    const adapter = recordingAdapter({
      issues: [],
      issueStates: new Map([
        [8, 'closed'],
        [9, 'missing'],
      ]),
    });
    const { ctx } = buildContext({ adapter, workspace: ws });

    await tickRepo(repo, ctx);

    expect(ws.evicted.sort()).toEqual(['/ws/8', '/ws/9']);
  });
});

describe('B3 — post-eviction fixpoint', () => {
  it('a second sweep observes no dirs and does nothing', async () => {
    const ws = fakeWorkspace({ dirs: [{ dir: '/ws/1', iid: 1 }] });
    const adapter = recordingAdapter({ issues: [], issueStates: new Map([[1, 'closed']]) });
    const { ctx } = buildContext({ adapter, workspace: ws });

    await tickRepo(repo, ctx);
    const afterFirst = adapter.calls.filter((c) => c === 'getIssueState').length;
    await tickRepo(repo, ctx);
    const afterSecond = adapter.calls.filter((c) => c === 'getIssueState').length;

    expect(ws.evicted).toEqual(['/ws/1']); // evicted exactly once
    expect(afterFirst).toBe(1);
    expect(afterSecond).toBe(1); // no further getIssueState — nothing left to check
  });
});

describe('B4 — sweep keeps a workspace whose eviction is refused (#56)', () => {
  it('a dir with unpushed commits survives the sweep and is retried next tick', async () => {
    const ws = fakeWorkspace({
      dirs: [
        { dir: '/ws/1', iid: 1 },
        { dir: '/ws/2', iid: 2 },
      ],
      keep: ['/ws/1'],
    });
    const adapter = recordingAdapter({
      issues: [],
      issueStates: new Map([
        [1, 'closed'],
        [2, 'closed'],
      ]),
    });
    const { ctx } = buildContext({ adapter, workspace: ws });

    await tickRepo(repo, ctx);

    expect(ws.evicted).toEqual(['/ws/2']); // the kept dir was not deleted...
    expect(ws.dirs.map((d) => d.dir)).toEqual(['/ws/1']); // ...and is still enumerable

    await tickRepo(repo, ctx); // next sweep retries it (by then the push may have landed)
    const stateReads = adapter.calls.filter((c) => c === 'getIssueState');
    expect(stateReads.length).toBe(3); // 2 first sweep + 1 retry
  });
});

describe('B5 — stale queued marks are retracted when the bot is unassigned (#53)', () => {
  it('unassigned queued issue loses the label; an assigned one keeps it', async () => {
    const ws = fakeWorkspace();
    const adapter = recordingAdapter({
      issues: [],
      labeled: [
        makeIssue({ iid: 70, assignees: [] }), // bot unassigned → retract
        makeIssue({ iid: 71 }), // still assigned to maestro-bot → keep watching
      ],
    });
    const { ctx } = buildContext({ adapter, workspace: ws });

    await tickRepo(repo, ctx);

    expect(adapter.labelOps).toEqual([{ iid: 70, set: [], unset: [ctx.settings.labels.queued] }]);
  });
});

// ── Part C — slot accounting through the daemon (§14) ─────────────────────────

describe('C1 — global cap queues excess work across repos', () => {
  it('global_max=1 lets one repo run and queues the other', async () => {
    const slots = new SlotAccountant(1);
    const aAdapter = recordingAdapter({ snapshot: makeSnapshot() });
    const bAdapter = recordingAdapter({ snapshot: makeSnapshot({ issue: { iid: 5 } }) });
    const a = buildContext({
      adapter: aAdapter,
      runner: scriptedRunner({ status: 'in_progress', summary: '' }),
      slots,
    });
    const b = buildContext({
      adapter: bAdapter,
      runner: scriptedRunner({ status: 'in_progress', summary: '' }),
      slots,
    });

    await tick([
      { repo, ctx: a.ctx },
      { repo: repoB, ctx: b.ctx },
    ]);

    const runs = a.runnerSpy.inputs.length + b.runnerSpy.inputs.length;
    expect(runs).toBe(1); // exactly one agent ran; the other queued
    // the queued repo never created an MR
    const created = aAdapter.createdMRs.length + bAdapter.createdMRs.length;
    expect(created).toBe(1);
    expect(slots.globalActive).toBe(0); // all released after the iteration
  });
});

describe('C2 — per-repo max_active caps a single busy repo', () => {
  it('max_active=1 with global headroom still runs only one issue', async () => {
    const slots = new SlotAccountant(4);
    const adapter = recordingAdapter({
      issues: [
        makeIssue({ iid: 1, labels: [labels.inProgress] }),
        makeIssue({ iid: 2, labels: [labels.inProgress] }),
      ],
      snapshots: new Map([
        [1, makeSnapshot({ issue: { iid: 1, labels: [labels.inProgress] } })],
        [2, makeSnapshot({ issue: { iid: 2, labels: [labels.inProgress] } })],
      ]),
    });
    const { ctx, runnerSpy } = buildContext({
      adapter,
      runner: scriptedRunner([
        { status: 'in_progress', summary: '' },
        { status: 'in_progress', summary: '' },
      ]),
      settings: defaultSettings({ concurrency: { globalMax: 4, maxActive: 1 } }),
      slots,
    });

    await tickRepo(repo, ctx);

    expect(runnerSpy.inputs).toHaveLength(1);
  });
});

describe('C3 — only active work consumes a slot', () => {
  it('a merge proceeds even when the one global slot is held by an active agent', async () => {
    const slots = new SlotAccountant(1);
    const adapter = recordingAdapter({
      issues: [
        makeIssue({ iid: 1, labels: [labels.inProgress] }),
        makeIssue({ iid: 2, labels: [labels.inReview] }),
      ],
      snapshots: new Map([
        [1, makeSnapshot({ issue: { iid: 1, labels: [labels.inProgress] } })],
        [
          2,
          makeSnapshot({
            issue: { iid: 2, labels: [labels.inReview] },
            mr: { approvals: { approved: true, approvedBy: [], changesRequested: false } },
          }),
        ],
      ]),
    });
    const { ctx, runnerSpy } = buildContext({
      adapter,
      runner: scriptedRunner({ status: 'in_progress', summary: '' }),
      slots,
    });

    await tickRepo(repo, ctx);

    expect(runnerSpy.inputs).toHaveLength(1); // the agent ran (held the 1 slot)
    expect(adapter.merges).toHaveLength(1); // and the merge still happened (no slot needed)
  });
});

describe('C4 — slot released in finally even when the agent throws', () => {
  it('a rejecting run does not leak the slot and does not crash the tick', async () => {
    const adapter = recordingAdapter({
      snapshot: makeSnapshot({ issue: { labels: [labels.inProgress] } }),
    });
    const throwingRunner = {
      runner: {
        run: async () => {
          throw new Error('agent boom');
        },
      },
      inputs: [],
    };
    const { ctx, slots } = buildContext({ adapter, runner: throwingRunner as never });

    await expect(tickRepo(repo, ctx)).resolves.toBeDefined(); // caught, not thrown
    expect(slots.globalActive).toBe(0); // no leak
  });
});

describe('C5 — an in-flight issue is not dispatched twice across overlapping passes (#18)', () => {
  it('a second pass skips an issue whose prior agent is still running, then resumes after', async () => {
    // a runner that blocks until released, so the first pass's agent stays in-flight
    let releaseAgent: () => void = () => {};
    const gate = new Promise<void>((r) => {
      releaseAgent = r;
    });
    const inputs: unknown[] = [];
    const blockingRunner = {
      runner: {
        run: async (i: never) => {
          inputs.push(i);
          await gate;
          return { status: 'in_progress' as const, summary: '' };
        },
      },
      inputs,
    };
    const adapter = recordingAdapter({
      snapshot: makeSnapshot({ issue: { labels: [labels.inProgress] } }),
    });
    // global + per-repo headroom: the slot cap alone would NOT stop a second dispatch —
    // only the in-flight guard does.
    const { ctx, inFlight } = buildContext({
      adapter,
      runner: blockingRunner as never,
      settings: defaultSettings({ concurrency: { globalMax: 4, maxActive: 2 } }),
      slots: new SlotAccountant(4),
    });
    const key = repoKey(repo);

    // pass 1: launches the (blocking) agent and claims the issue
    const r1 = await evaluateLifecycle(repo, ctx);
    expect(r1.pending).toHaveLength(1);
    expect(inFlight.has(key, 42)).toBe(true);

    // pass 2 while the agent is still in-flight: skipped — no second dispatch
    const r2 = await evaluateLifecycle(repo, ctx);
    expect(r2.pending).toHaveLength(0);

    // let the first agent finish → the claim clears
    releaseAgent();
    await Promise.all(r1.pending);
    expect(inFlight.has(key, 42)).toBe(false);

    // a later pass dispatches again (normal resume), proving the guard only blocks overlap
    const r3 = await evaluateLifecycle(repo, ctx);
    expect(r3.pending).toHaveLength(1);
    await Promise.all(r3.pending);
    expect(inputs).toHaveLength(2); // one per non-overlapping pass, never the skipped one
  });
});

// ── Part F — retry / idempotency (§13) ────────────────────────────────────────

describe('F1 — a failed tick is isolated and recovers next tick', () => {
  it('getSnapshot throwing on tick 1 is caught; tick 2 drives the issue normally', async () => {
    const adapter = recordingAdapter({ snapshot: makeSnapshot() });
    let n = 0;
    const realGetSnapshot = adapter.adapter.getSnapshot;
    adapter.adapter.getSnapshot = async (r, iid) => {
      n += 1;
      if (n === 1) throw new Error('network');
      return realGetSnapshot(r, iid);
    };
    const { ctx, runnerSpy } = buildContext({ adapter });

    await expect(tickRepo(repo, ctx)).resolves.toBeDefined();
    expect(runnerSpy.inputs).toHaveLength(0); // tick 1 reached nothing

    await tickRepo(repo, ctx);
    expect(runnerSpy.inputs).toHaveLength(1); // tick 2 recovered
  });
});

describe('F2 — one repo failing never blocks another', () => {
  it('repo A throwing on its issue list still lets repo B tick', async () => {
    const aAdapter = recordingAdapter({ snapshot: makeSnapshot() });
    aAdapter.adapter.listAssignedOpenIssues = async () => {
      throw new Error('A down');
    };
    const bAdapter = recordingAdapter({ snapshot: makeSnapshot({ issue: { iid: 5 } }) });
    const a = buildContext({ adapter: aAdapter });
    const b = buildContext({ adapter: bAdapter });

    await tick([
      { repo, ctx: a.ctx },
      { repo: repoB, ctx: b.ctx },
    ]);

    expect(bAdapter.createdMRs).toHaveLength(1); // B ran to completion
  });
});

describe('F3 — re-ticking is idempotent (forge label is the dedup key)', () => {
  it('once the issue is in-progress, the next tick resumes instead of re-creating the MR', async () => {
    const t1 = recordingAdapter({ snapshot: makeSnapshot() }); // new
    const c1 = buildContext({
      adapter: t1,
      runner: scriptedRunner({ status: 'in_progress', summary: '' }),
    });
    await tickRepo(repo, c1.ctx);
    expect(t1.createdMRs).toHaveLength(1);

    const t2 = recordingAdapter({
      snapshot: makeSnapshot({ issue: { labels: [labels.inProgress] } }),
    });
    const c2 = buildContext({
      adapter: t2,
      runner: scriptedRunner({ status: 'in_progress', summary: '' }),
    });
    await tickRepo(repo, c2.ctx);
    expect(t2.createdMRs).toHaveLength(0); // resumed, not re-created
  });
});

// ── Part G — crash-recovery handoff resume (AM-1 / M4) ────────────────────────

describe('G1 — workComplete drives the standalone handoff intent', () => {
  it('an in-progress issue with the proof sentinel resumes handoff, no agent, no slot', async () => {
    const adapter = recordingAdapter({
      snapshot: makeSnapshot({
        issue: { labels: [labels.inProgress] },
        comments: [`### ✅ Proof\nall green\n${DONE_SENTINEL}`],
      }),
    });
    const { ctx, runnerSpy, handoffSpy, proofHandoffSpy, slots } = buildContext({ adapter });

    await tickRepo(repo, ctx);

    expect(handoffSpy).toHaveBeenCalledTimes(1);
    expect(handoffSpy.mock.calls[0][0].mrIid).toBe(7);
    expect(proofHandoffSpy).not.toHaveBeenCalled(); // not the agent-done path
    expect(runnerSpy.inputs).toHaveLength(0); // no agent run
    expect(slots.globalActive).toBe(0); // handoff consumes no slot
  });
});

describe('G2 — workComplete=false keeps normal resume', () => {
  it('an in-progress issue without the sentinel resumes the agent, not handoff', async () => {
    const adapter = recordingAdapter({
      snapshot: makeSnapshot({ issue: { labels: [labels.inProgress] } }),
    });
    const { ctx, runnerSpy, handoffSpy } = buildContext({ adapter });

    await tickRepo(repo, ctx);

    expect(runnerSpy.inputs).toHaveLength(1);
    expect(handoffSpy).not.toHaveBeenCalled();
  });
});

// ── Part H — composition / forge selection ────────────────────────────────────

describe('H1 — a full tick runs lifecycle then cleanup', () => {
  it('both passes execute in one tickRepo call, lifecycle first', async () => {
    const ws = fakeWorkspace({ dirs: [{ dir: '/ws/99', iid: 99 }] });
    const adapter = recordingAdapter({
      issues: [makeIssue()],
      snapshot: makeSnapshot(),
      issueStates: new Map([[99, 'closed']]),
    });
    const { ctx } = buildContext({ adapter, workspace: ws });

    await tickRepo(repo, ctx);

    expect(adapter.createdMRs).toHaveLength(1); // lifecycle ran
    expect(ws.evicted).toEqual(['/ws/99']); // cleanup ran
    expect(adapter.calls.indexOf('listAssignedOpenIssues')).toBeLessThan(
      adapter.calls.indexOf('getIssueState'),
    ); // lifecycle before cleanup
  });
});

describe('H2 — adapter selected by RepoRef.forge + host', () => {
  it('picks the adapter whose kind AND host match the repo', () => {
    const gitlab = { kind: 'gitlab', host: 'gitlab.com' } as never;
    const github = { kind: 'github', host: 'github.com' } as never;
    expect(selectAdapter(repo, [gitlab, github])).toBe(gitlab);
    expect(selectAdapter({ ...repo, forge: 'github', host: 'github.com' }, [gitlab, github])).toBe(
      github,
    );
    expect(() => selectAdapter({ ...repo, forge: 'github', host: 'github.com' }, [gitlab])).toThrow(
      /no adapter/,
    );
  });

  it('disambiguates multiple adapters of the same kind by host', () => {
    const gitlabCom = { kind: 'gitlab', host: 'gitlab.com' } as never;
    const gitlabSelf = { kind: 'gitlab', host: 'git.digital-masters.de' } as never;
    expect(selectAdapter({ ...repo, host: 'gitlab.com' }, [gitlabCom, gitlabSelf])).toBe(gitlabCom);
    expect(
      selectAdapter({ ...repo, host: 'git.digital-masters.de' }, [gitlabCom, gitlabSelf]),
    ).toBe(gitlabSelf);
  });
});
