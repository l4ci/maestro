import { describe, expect, it } from 'vitest';
import type {
  ForgeAdapter,
  HandoffInput,
  Issue,
  IssueSnapshot,
  MergeRequest,
  ProofResult,
  RepoRef,
} from '../src/contracts/index.js';
import { DONE_SENTINEL } from '../src/contracts/index.js';
import { labelNames } from '../src/contracts/labels.js';
import { handoff, proofAndHandoff } from '../src/handoff/handoff.js';

const repo: RepoRef = {
  forge: 'gitlab',
  host: 'gitlab.com',
  project: 'group/api',
  url: 'gitlab.com/group/api',
};
const user = (u: string) => ({ username: u, id: `id-${u}` });

function snapshot(
  over: { comments?: string[]; reviewers?: string[]; isDraft?: boolean; labels?: string[] } = {},
): IssueSnapshot {
  const issue: Issue = {
    iid: 42,
    id: '9042',
    title: 'Add OAuth',
    body: '',
    state: 'open',
    assignees: [user('maestro-bot')],
    labels: over.labels ?? [],
    author: user('reporter'),
    webUrl: 'u',
  };
  const mr: MergeRequest = {
    iid: 7,
    id: '7',
    title: 'Draft: Add OAuth',
    description: '- [x] done',
    state: 'opened',
    isDraft: over.isDraft ?? true,
    sourceBranch: 'maestro/issue-42',
    targetBranch: 'main',
    assignees: [],
    reviewers: (over.reviewers ?? []).map(user),
    labels: over.labels ?? [],
    approvals: { approved: false, approvedBy: [], changesRequested: false },
    webUrl: 'https://forge/mr/7',
  };
  return {
    repo,
    issue,
    mr,
    recentComments: (over.comments ?? []).map((body, i) => ({
      id: `c${i}`,
      author: user('x'),
      body,
      createdAt: '2026-06-04T00:00:00Z',
    })),
  };
}

/** Recording fake adapter: pushes each mutating method onto `calls`, captures issue-comment
 *  bodies and the usernames review was requested from. requestReview is a plain recorder — the
 *  handoff no longer re-reads after it, because the ready-for-review comment is the guaranteed
 *  notification regardless of whether the request landed (#115). */
function recorder(snap: IssueSnapshot) {
  const calls: string[] = [];
  const reviewers: string[] = [];
  const comments: string[] = [];
  const adapter: Partial<ForgeAdapter> = {
    getSnapshot: async () => snap,
    commentIssue: async (_r, _i, body) => {
      calls.push('commentIssue');
      comments.push(body);
    },
    commentMR: async () => void calls.push('commentMR'),
    requestReview: async (_r, _iid, username) => {
      calls.push('requestReview');
      reviewers.push(username);
    },
    setDraft: async () => void calls.push('setDraft'),
    setIssueLabels: async () => void calls.push('setIssueLabels'),
  };
  return { adapter: adapter as ForgeAdapter, calls, reviewers, comments };
}

const proof: ProofResult[] = [{ ok: true, kind: 'test-output', summary: 'all green' }];

function hin(adapter: ForgeAdapter, over: Partial<HandoffInput> = {}): HandoffInput {
  return {
    repo,
    issueIid: 42,
    mrIid: 7,
    ticketCreator: 'reporter',
    settings: {
      repo,
      botUser: 'maestro-bot',
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
    adapter,
    proof,
    ...over,
  };
}

// --- Slice 5: strict ordering ---------------------------------------------

const READY = '<!-- maestro:ready-for-review -->';

describe('Slice 5 — strict ordering (§7 guarantee)', () => {
  it('comment(issue) < comment(MR) < requestReview < ready comment < undraft < label; reviewer = ticket creator', async () => {
    const { adapter, calls, reviewers, comments } = recorder(snapshot());
    await handoff(hin(adapter));
    expect(calls).toEqual([
      'commentIssue', // proof
      'commentMR', // proof
      'requestReview',
      'commentIssue', // ready-for-review ping
      'setDraft',
      'setIssueLabels',
    ]);
    expect(reviewers).toEqual(['reporter']); // ticket creator, not the bot
    expect(comments[0]).toContain('all green'); // proof first
    expect(comments[1]).toContain('ready for your review'); // ping second
  });

  it('proofAndHandoff posts proof comment before requesting review (proof-before-ping end-to-end)', async () => {
    const { adapter, calls } = recorder(snapshot());
    await proofAndHandoff({
      ...hin(adapter),
      proofInput: {
        workspaceDir: '/ws',
        strategies: [{ type: 'none' }],
        environment: {},
        git: { target: 'main' },
        exec: adapter as never,
      },
    } as never);
    expect(calls.indexOf('commentIssue')).toBeLessThan(calls.indexOf('requestReview'));
  });
});

// --- Slice 6: pinged exactly once ------------------------------------------

describe('Slice 6 — human pinged exactly once', () => {
  it('requestReview and ready comment each happen once, after the proof comments', async () => {
    const { adapter, calls, comments } = recorder(snapshot());
    await handoff(hin(adapter));
    expect(calls.filter((c) => c === 'requestReview')).toHaveLength(1);
    expect(comments.filter((b) => b.includes(READY))).toHaveLength(1);
  });

  it('if a proof comment throws, the review request is never reached', async () => {
    const { adapter, calls } = recorder(snapshot());
    adapter.commentMR = async () => {
      throw new Error('network');
    };
    await expect(handoff(hin(adapter))).rejects.toThrow('network');
    expect(calls).not.toContain('requestReview');
  });
});

// --- Slice 6b: the ready comment always notifies (#115) --------------------

describe('Slice 6b — ready-for-review comment always @-mentions the creator (#115)', () => {
  it('posts an @-mention with the MR link and the three response channels', async () => {
    const { adapter, comments } = recorder(snapshot());
    await handoff(hin(adapter));
    const ready = comments.find((b) => b.includes(READY));
    expect(ready).toBeDefined();
    expect(ready).toContain('@reporter');
    expect(ready).toContain('review');
    expect(ready).toContain('https://forge/mr/7'); // MR link
    expect(ready).toContain('/maestro'); // the comment-steering channel
  });

  it('idempotent: a crash-recovery re-run does not re-ping (sentinel present)', async () => {
    const { adapter, calls } = recorder(
      snapshot({ comments: [`### Proof\nok\n${DONE_SENTINEL}`, READY], reviewers: ['reporter'] }),
    );
    await handoff(hin(adapter));
    // proof already posted, review already requested, ready already posted → no comments, no request
    expect(calls).not.toContain('commentIssue');
    expect(calls).not.toContain('requestReview');
    expect(calls).toEqual(['setDraft', 'setIssueLabels']);
  });
});

// --- Slice 7: crash-recovery idempotency -----------------------------------

describe('Slice 7 — crash-recovery idempotency', () => {
  it('a. not started → full sequence runs', async () => {
    const { adapter, calls } = recorder(snapshot());
    await handoff(hin(adapter));
    expect(calls).toContain('commentIssue');
    expect(calls).toContain('requestReview');
  });

  it('b. partway (proof posted, not requested) → no double proof comment; still requests/pings/undrafts/labels', async () => {
    const { adapter, calls, comments } = recorder(
      snapshot({ comments: [`### Proof\nall green\n${DONE_SENTINEL}`] }),
    );
    await handoff(hin(adapter));
    expect(comments.some((b) => b.includes('all green'))).toBe(false); // proof sentinel detected → skip
    expect(calls).not.toContain('commentMR');
    expect(calls).toEqual(['requestReview', 'commentIssue', 'setDraft', 'setIssueLabels']);
    expect(comments[0]).toContain(READY); // the only comment is the ping
  });

  it('c. fully done → no-op (zero mutating calls)', async () => {
    const l = labelNames('gitlab');
    const { adapter, calls } = recorder(
      snapshot({
        comments: [DONE_SENTINEL, READY],
        reviewers: ['reporter'],
        isDraft: false,
        labels: [l.inReview],
      }),
    );
    await handoff(hin(adapter));
    expect(calls).toEqual([]);
  });
});

// --- Slice 8: proof failure non-fatal --------------------------------------

describe('Slice 8 — proof failure does not block handoff', () => {
  it('failed proof still completes the sequence, comment marks failure', async () => {
    const bodies: string[] = [];
    const snap = snapshot();
    const adapter: Partial<ForgeAdapter> = {
      getSnapshot: async () => snap,
      commentIssue: async (_r, _i, body) => void bodies.push(body),
      commentMR: async () => {},
      requestReview: async () => {},
      setDraft: async () => {},
      setIssueLabels: async () => {},
    };
    await handoff(
      hin(adapter as ForgeAdapter, {
        proof: [{ ok: false, kind: 'playwright', summary: 'boot failed' }],
      }),
    );
    expect(bodies[0]).toMatch(/failed/i);
    expect(bodies[0]).toContain('boot failed');
  });
});

// --- Slice 9: multi-proof comment folding (#12) -----------------------------

describe('Slice 9 — multi-proof comment folding (#12)', () => {
  it('labels each strategy; header is all-must-pass (one failure → warning)', async () => {
    const { adapter, comments } = recorder(snapshot());
    await handoff(
      hin(adapter, {
        proof: [
          { ok: true, kind: 'diff-summary', summary: 'diff ok' },
          { ok: false, kind: 'playwright', summary: 'boot failed' },
        ],
      }),
    );
    const proofComment = comments[0] ?? '';
    expect(proofComment).toContain('⚠️ Proof (failed');
    expect(proofComment).toContain('#### ✅ diff-summary');
    expect(proofComment).toContain('#### ❌ playwright');
  });

  it('a single strategy renders flat, preserving the original comment shape', async () => {
    const { adapter, comments } = recorder(snapshot());
    await handoff(hin(adapter));
    const proofComment = comments[0] ?? '';
    expect(proofComment).toContain('### ✅ Proof');
    expect(proofComment).toContain('all green');
    expect(proofComment).not.toContain('####');
  });
});
