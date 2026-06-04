import { describe, expect, it } from 'vitest';
import type { RepoRef } from '../src/contracts/index.js';
import type { Clock } from '../src/daemon/clock.js';
import { repoKey } from '../src/daemon/ports.js';
import { tickDue } from '../src/daemon/run.js';
import { Scheduler } from '../src/daemon/scheduler.js';
import {
  buildContext,
  labels,
  makeSnapshot,
  recordingAdapter,
  repo,
  scriptedRunner,
} from './helpers/daemon.js';

// The daemon loop body: tick only the repos that are due, then reschedule each by
// whether it did active work (adaptive interval, §14). Time is injected.

const repoB: RepoRef = { ...repo, project: 'group/web', url: 'gitlab.com/group/web' };
const intervals = { active: 30_000, idle: 300_000, jitter: 0 };
const fixedClock = (t: number): Clock => ({ now: () => t });

describe('tickDue — adaptive run-loop body', () => {
  it('ticks only due repos and reschedules an active repo fast, an idle one slow', async () => {
    const seq = [0]; // jitter rng → 0
    const scheduler = new Scheduler(intervals, { next: () => seq[0] as number });

    const active = buildContext({
      adapter: recordingAdapter({
        snapshot: makeSnapshot({ issue: { labels: [labels.inProgress] } }),
      }),
      runner: scriptedRunner({ status: 'in_progress', summary: '' }),
    });
    const idle = buildContext({
      adapter: recordingAdapter({
        snapshot: makeSnapshot({
          issue: { labels: [labels.inReview] },
          mr: { approvals: { approved: false, approvedBy: [], changesRequested: false } },
        }),
      }),
    });
    const units = [
      { repo, ctx: active.ctx },
      { repo: repoB, ctx: idle.ctx },
    ];

    await tickDue(units, scheduler, fixedClock(1_000));

    // both were unseen → due → ticked
    expect(active.runnerSpy.inputs).toHaveLength(1); // active repo ran its agent
    expect(idle.runnerSpy.inputs).toHaveLength(0); // idle repo only polled
    expect(scheduler.nextTickAt(repoKey(repo))).toBe(1_000 + 30_000); // fast
    expect(scheduler.nextTickAt(repoKey(repoB))).toBe(1_000 + 300_000); // slow
  });

  it('skips a repo that is not yet due', async () => {
    const scheduler = new Scheduler(intervals, { next: () => 0 });
    const c = buildContext({
      adapter: recordingAdapter({
        snapshot: makeSnapshot({ issue: { labels: [labels.inProgress] } }),
      }),
    });
    scheduler.schedule(repoKey(repo), false, 0); // next due at 300_000

    await tickDue([{ repo, ctx: c.ctx }], scheduler, fixedClock(100)); // 100 < 300_000

    expect(c.runnerSpy.inputs).toHaveLength(0); // not due → no tick
  });
});
