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
  reviewers: [],
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
    ciStatus: async () => ({ conclusion: 'none' }),
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
    expect(found?.mr.iid).toBe(7);
  });

  it('matches by Closes #iid when the branch differs', async () => {
    const m = mr({ sourceBranch: 'feature/x' });
    const found = await findMaestroMr(42, fakePrimitives({ openMergeRequests: async () => [m] }));
    expect(found?.mr.iid).toBe(7);
  });

  it('prefers an open MR over a non-open match', async () => {
    const closed = mr({ iid: 1, state: 'closed' });
    const open = mr({ iid: 2, state: 'opened' });
    const found = await findMaestroMr(
      42,
      fakePrimitives({ openMergeRequests: async () => [closed, open] }),
    );
    expect(found?.mr.iid).toBe(2);
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
    expect(found?.mr.approvals).toEqual({ ...APPROVED, changesRequested: true });
  });

  it('reports the newest MR movement: a blocking thread that post-dates the push (#39)', async () => {
    const found = await findMaestroMr(
      42,
      fakePrimitives({
        openMergeRequests: async () => [mr()],
        blockingThreadAt: async () => '2026-01-03',
        lastBotPushAt: async () => '2026-01-02',
      }),
    );
    expect(found?.activityAt).toEqual({ at: '2026-01-03', kind: 'thread' });
  });

  it('reports a bot push as the MR movement when it post-dates the thread (#39)', async () => {
    const found = await findMaestroMr(
      42,
      fakePrimitives({
        openMergeRequests: async () => [mr()],
        blockingThreadAt: async () => '2026-01-02',
        lastBotPushAt: async () => '2026-01-04',
      }),
    );
    expect(found?.activityAt).toEqual({ at: '2026-01-04', kind: 'push' });
  });

  it('keeps the push read short-circuited behind a blocking thread; no thread → no MR activity (#39)', async () => {
    const lastBotPushAt = vi.fn(async () => '2026-01-04');
    const found = await findMaestroMr(
      42,
      fakePrimitives({
        openMergeRequests: async () => [mr()],
        blockingThreadAt: async () => undefined,
        lastBotPushAt,
      }),
    );
    expect(found?.mr.approvals.changesRequested).toBe(false);
    expect(lastBotPushAt).not.toHaveBeenCalled(); // hot-path optimization preserved
    expect(found?.activityAt).toBeUndefined(); // push never read → no cheap MR signal
  });

  // The issue-thread /maestro signal folds into the SAME edge as the MR thread, so the
  // shared-account rework request self-clears on a bot push (the loop fix).
  it('an issue /maestro command with no MR thread blocks, and triggers the push read', async () => {
    const lastBotPushAt = vi.fn(async () => undefined);
    const found = await findMaestroMr(
      42,
      fakePrimitives({ openMergeRequests: async () => [mr()], lastBotPushAt }),
      '2026-01-05', // issueBlockingAt — a standing /maestro command
    );
    expect(found?.mr.approvals.changesRequested).toBe(true);
    expect(lastBotPushAt).toHaveBeenCalled(); // no longer short-circuited away
  });

  it('an issue /maestro command is RETIRED by a bot push that post-dates it', async () => {
    const found = await findMaestroMr(
      42,
      fakePrimitives({
        openMergeRequests: async () => [mr()],
        blockingThreadAt: async () => undefined,
        lastBotPushAt: async () => '2026-01-06', // agent pushed after the command
      }),
      '2026-01-05',
    );
    expect(found?.mr.approvals.changesRequested).toBe(false); // addressed → no loop
  });

  it('attaches the head pipeline CI status to an open MR when the gate is on (#118/#120)', async () => {
    const found = await findMaestroMr(
      42,
      fakePrimitives({
        openMergeRequests: async () => [mr()],
        ciStatus: async () => ({ conclusion: 'failed', at: '2026-01-03', webUrl: 'p' }),
      }),
      undefined,
      true, // ciGate on
    );
    expect(found?.mr.ci).toEqual({ conclusion: 'failed', at: '2026-01-03', webUrl: 'p' });
  });

  it('does not read CI when the gate is off, even for an open candidate (#120)', async () => {
    const ciStatus = vi.fn(async () => ({ conclusion: 'failed' as const }));
    const found = await findMaestroMr(
      42,
      fakePrimitives({ openMergeRequests: async () => [mr()], ciStatus }),
      undefined,
      false, // ciGate off (also the default)
    );
    expect(found?.mr.ci).toBeUndefined();
    expect(ciStatus).not.toHaveBeenCalled();
  });

  it('does not read CI for a non-open candidate even with the gate on (short-circuit) (#118)', async () => {
    const ciStatus = vi.fn(async () => ({ conclusion: 'failed' as const }));
    const found = await findMaestroMr(
      42,
      fakePrimitives({ openMergeRequests: async () => [mr({ state: 'merged' })], ciStatus }),
      undefined,
      true, // gate on — the merged state, not the gate, is what short-circuits
    );
    expect(found?.mr.ci).toBeUndefined();
    expect(ciStatus).not.toHaveBeenCalled();
  });

  it('takes the later of an MR thread and an issue command as the blocking edge', async () => {
    const found = await findMaestroMr(
      42,
      fakePrimitives({
        openMergeRequests: async () => [mr()],
        blockingThreadAt: async () => '2026-01-03',
        lastBotPushAt: async () => '2026-01-04', // clears the thread…
      }),
      '2026-01-05', // …but the newer issue command still stands
    );
    expect(found?.mr.approvals.changesRequested).toBe(true);
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

  // §0.2 validation (issue #108): a normalization bug fails AT assembly, naming the
  // forge and the field path, instead of crashing the reconciler or views downstream.
  describe('validates the normalized pieces against the §0.2 schemas', () => {
    const ghRepo: RepoRef = {
      forge: 'github',
      host: 'github.com',
      project: 'o/r',
      url: 'github.com/o/r',
    };

    it('a string iid on the issue fails with forge + field path (gitlab)', async () => {
      const broken = { ...issue(), iid: '42' } as unknown as Issue;
      await expect(
        assembleSnapshot(repo, 42, fakePrimitives({ issue: async () => broken }), 50),
      ).rejects.toThrow(/gitlab snapshot .*issue\.iid/);
    });

    it('a comment missing its author fails with the indexed field path (github)', async () => {
      const broken = { id: 'c1', body: 'hi', createdAt: '2026-01-01' } as unknown as Comment;
      await expect(
        assembleSnapshot(ghRepo, 42, fakePrimitives({ comments: async () => [broken] }), 50),
      ).rejects.toThrow(/github snapshot .*recentComments\.0\.author/);
    });

    it('a malformed approval on the chosen MR fails after approvals are filled', async () => {
      const badBase = { approved: true, approvedBy: [{}], changesRequested: false };
      await expect(
        assembleSnapshot(
          repo,
          42,
          fakePrimitives({
            openMergeRequests: async () => [mr()],
            approvalBase: async () => badBase as unknown as ApprovalState,
          }),
          50,
        ),
      ).rejects.toThrow(/gitlab snapshot .*mr\.approvals\.approvedBy\.0\.username/);
    });

    it('valid pieces pass through byte-identical on both forges', async () => {
      for (const r of [repo, ghRepo]) {
        const snap = await assembleSnapshot(
          r,
          42,
          fakePrimitives({
            openMergeRequests: async () => [mr()],
            comments: async () => [
              { id: 'c1', author: user('x'), body: 'hi', createdAt: '2026-01-01' },
            ],
            lastActor: async () => user('triager'),
          }),
          50,
        );
        expect(snap.issue).toEqual({ ...issue(), lastActor: user('triager') });
        expect(snap.mr?.iid).toBe(7);
        expect(snap.recentComments).toHaveLength(1);
      }
    });
  });

  it('feeds the newest body-start /maestro issue comment into the MR changes-requested edge', async () => {
    const cmt = (body: string, at: string): Comment => ({
      id: at,
      author: user('volker.otto'), // shared account: bot == operator
      body,
      createdAt: at,
    });
    // A standing /maestro command, no bot push since → rework requested.
    const requested = await assembleSnapshot(
      repo,
      42,
      fakePrimitives({
        openMergeRequests: async () => [mr({ isDraft: false })],
        comments: async () => [
          cmt('/maestro make the badges greener', '2026-01-05'),
          cmt('### ⚠️ Proof', '2026-01-04'),
        ],
      }),
      50,
    );
    expect(requested.mr?.approvals.changesRequested).toBe(true);

    // A bot push after the command retires it (self-clearing — the loop fix).
    const cleared = await assembleSnapshot(
      repo,
      42,
      fakePrimitives({
        openMergeRequests: async () => [mr({ isDraft: false })],
        lastBotPushAt: async () => '2026-01-06',
        comments: async () => [cmt('/maestro make the badges greener', '2026-01-05')],
      }),
      50,
    );
    expect(cleared.mr?.approvals.changesRequested).toBe(false);

    // A mid-body /maestro line (daemon comment echoing the agent) must NOT count.
    const ignored = await assembleSnapshot(
      repo,
      42,
      fakePrimitives({
        openMergeRequests: async () => [mr({ isDraft: false })],
        comments: async () => [cmt('### 🎼 Plan\n\n/maestro inside a heading', '2026-01-05')],
      }),
      50,
    );
    expect(ignored.mr?.approvals.changesRequested).toBe(false);
  });

  // #7: a /maestro reply that answers a BLOCKED question lingers as a standing command. When
  // the resumed work is a no-op (the fix already lived in the target → no branch commit), the
  // push-only clear never fires and the MR bounces in-progress↔in-review forever. A daemon
  // comment post-dating the command proves the agent responded → the command is addressed.
  it('RETIRES an issue /maestro command once a daemon comment answers it, even with no push (#7)', async () => {
    const cmt = (body: string, at: string): Comment => ({
      id: at,
      author: user('volker.otto'), // shared account: bot == operator
      body,
      createdAt: at,
    });
    const snap = await assembleSnapshot(
      repo,
      42,
      fakePrimitives({
        openMergeRequests: async () => [mr({ isDraft: false })],
        lastBotPushAt: async () => '2026-01-02', // scaffold commit, BEFORE the command — never clears
        comments: async () => [
          cmt('@reporter this is ready for your review', '2026-01-07'), // daemon handoff
          cmt('### ✅ Proof', '2026-01-06'), // daemon
          cmt('/maestro 1', '2026-01-05'), // operator's unblock answer
        ],
      }),
      50,
      'volker.otto', // botUser
    );
    expect(snap.mr?.approvals.changesRequested).toBe(false);
  });

  it('keeps blocking when the only daemon comment PRECEDES the /maestro command (#7 guard)', async () => {
    const cmt = (body: string, at: string): Comment => ({
      id: at,
      author: user('volker.otto'),
      body,
      createdAt: at,
    });
    const snap = await assembleSnapshot(
      repo,
      42,
      fakePrimitives({
        openMergeRequests: async () => [mr({ isDraft: false })],
        comments: async () => [
          cmt('/maestro fix the spacing', '2026-01-07'), // newest — daemon has not responded yet
          cmt('### ✅ Proof', '2026-01-06'),
        ],
      }),
      50,
      'volker.otto',
    );
    expect(snap.mr?.approvals.changesRequested).toBe(true);
  });
});
