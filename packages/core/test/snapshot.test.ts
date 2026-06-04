// Forge-free tests for the hoisted snapshot algorithm (snapshot.ts). Before the M2/M7
// merge this choreography + the edge-trigger comparison were duplicated in both adapters
// and only reachable through a forge transcript; now they sit behind one ForgePrimitives
// seam and are tested once against an in-memory fake. The adapter suites still cover the
// forge-specific primitives end-to-end.

import { describe, expect, it, vi } from 'vitest';
import type {
  ApprovalState,
  Comment,
  ForgeUser,
  Issue,
  MergeRequest,
  RepoRef,
} from '../src/contracts/index.js';
import {
  type ForgePrimitives,
  assembleSnapshot,
  computeChangesRequested,
  findMaestroMr,
} from '../src/forge/snapshot.js';

const repo: RepoRef = {
  forge: 'gitlab',
  host: 'gitlab.com',
  project: 'g/r',
  url: 'gitlab.com/g/r',
};
const user = (username: string): ForgeUser => ({ username, id: username });

const issue = (over: Partial<Issue> = {}): Issue => ({
  iid: 42,
  id: '42',
  title: 'Add OAuth',
  body: '',
  state: 'open',
  assignees: [user('maestro-bot')],
  labels: [],
  author: user('reporter'),
  webUrl: 'u',
  ...over,
});

const mr = (over: Partial<MergeRequest> = {}): MergeRequest => ({
  iid: 7,
  id: '7',
  title: 'Add OAuth',
  description: 'Closes #42',
  state: 'opened',
  isDraft: true,
  sourceBranch: 'maestro/issue-42-add-oauth',
  targetBranch: 'main',
  assignees: [],
  labels: [],
  approvals: { approved: false, approvedBy: [], changesRequested: false },
  webUrl: 'u',
  closesIssueIid: 42,
  ...over,
});

const APPROVED: ApprovalState = {
  approved: true,
  approvedBy: [user('reporter')],
  changesRequested: false,
};

/** A fully-stubbed ForgePrimitives; override per test. All reads default to empty. */
function fakePrimitives(over: Partial<ForgePrimitives> = {}): ForgePrimitives {
  return {
    issue: async () => issue(),
    lastActor: async () => undefined,
    comments: async () => [],
    openMergeRequests: async () => [],
    approvalBase: async () => ({ approved: false, approvedBy: [], changesRequested: false }),
    blockingThreadAt: async () => undefined,
    lastBotPushAt: async () => undefined,
    ...over,
  };
}

describe('computeChangesRequested — the edge-trigger comparison', () => {
  it('no blocking thread → false', () => {
    expect(computeChangesRequested(undefined, '2026-01-01')).toBe(false);
  });
  it('blocking thread, no bot push since → true', () => {
    expect(computeChangesRequested('2026-01-02', undefined)).toBe(true);
  });
  it('blocking newer than last bot push → true', () => {
    expect(computeChangesRequested('2026-01-03', '2026-01-02')).toBe(true);
  });
  it('blocking older than last bot push → false (feedback already addressed)', () => {
    expect(computeChangesRequested('2026-01-01', '2026-01-02')).toBe(false);
  });
});

describe('findMaestroMr', () => {
  it('matches by maestro branch prefix', async () => {
    const m = mr({ closesIssueIid: undefined, description: 'no link' });
    const found = await findMaestroMr(42, fakePrimitives({ openMergeRequests: async () => [m] }));
    expect(found?.iid).toBe(7);
  });

  it('matches by Closes #iid when the branch differs', async () => {
    const m = mr({ sourceBranch: 'feature/x' });
    const found = await findMaestroMr(42, fakePrimitives({ openMergeRequests: async () => [m] }));
    expect(found?.iid).toBe(7);
  });

  it('prefers an open MR over a non-open match', async () => {
    const closed = mr({ iid: 1, state: 'closed' });
    const open = mr({ iid: 2, state: 'opened' });
    const found = await findMaestroMr(
      42,
      fakePrimitives({ openMergeRequests: async () => [closed, open] }),
    );
    expect(found?.iid).toBe(2);
  });

  it('returns undefined when nothing matches', async () => {
    const other = mr({ sourceBranch: 'feature/x', closesIssueIid: 99, description: 'Closes #99' });
    expect(
      await findMaestroMr(42, fakePrimitives({ openMergeRequests: async () => [other] })),
    ).toBeUndefined();
  });

  it('fills the chosen MR with approvalBase + computed changesRequested', async () => {
    const found = await findMaestroMr(
      42,
      fakePrimitives({
        openMergeRequests: async () => [mr()],
        approvalBase: async () => APPROVED,
        blockingThreadAt: async () => '2026-01-03',
        lastBotPushAt: async () => '2026-01-02',
      }),
    );
    expect(found?.approvals).toEqual({ ...APPROVED, changesRequested: true });
  });

  it('short-circuits the commit read when there is no blocking thread', async () => {
    const lastBotPushAt = vi.fn(async () => '2026-01-02');
    const found = await findMaestroMr(
      42,
      fakePrimitives({
        openMergeRequests: async () => [mr()],
        blockingThreadAt: async () => undefined,
        lastBotPushAt,
      }),
    );
    expect(found?.approvals.changesRequested).toBe(false);
    expect(lastBotPushAt).not.toHaveBeenCalled(); // no blocking → never reads commits
  });
});

describe('assembleSnapshot', () => {
  it('attaches lastActor onto the issue when present', async () => {
    const snap = await assembleSnapshot(
      repo,
      42,
      fakePrimitives({ lastActor: async () => user('triager') }),
      50,
    );
    expect(snap.issue.lastActor).toEqual(user('triager'));
  });

  it('omits lastActor when none', async () => {
    const snap = await assembleSnapshot(repo, 42, fakePrimitives(), 50);
    expect(snap.issue.lastActor).toBeUndefined();
  });

  it('sorts comments newest-first and caps to commentCap', async () => {
    const c = (id: string, at: string): Comment => ({
      id,
      author: user('x'),
      body: id,
      createdAt: at,
    });
    const snap = await assembleSnapshot(
      repo,
      42,
      fakePrimitives({
        comments: async () => [c('a', '2026-01-01'), c('c', '2026-01-03'), c('b', '2026-01-02')],
      }),
      2,
    );
    expect(snap.recentComments.map((x) => x.id)).toEqual(['c', 'b']); // newest two
  });

  it('includes the MR when one is found, omits it otherwise', async () => {
    const withMr = await assembleSnapshot(
      repo,
      42,
      fakePrimitives({ openMergeRequests: async () => [mr()] }),
      50,
    );
    expect(withMr.mr?.iid).toBe(7);
    const without = await assembleSnapshot(repo, 42, fakePrimitives(), 50);
    expect(without.mr).toBeUndefined();
  });
});
