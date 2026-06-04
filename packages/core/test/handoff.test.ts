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
  over: { comments?: string[]; assignees?: string[]; isDraft?: boolean; labels?: string[] } = {},
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
    assignees: (over.assignees ?? []).map(user),
    labels: over.labels ?? [],
    approvals: { approved: false, approvedBy: [], changesRequested: false },
    webUrl: 'u',
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

/** Recording fake adapter: pushes each mutating method onto `calls`. `assignLands` models
 *  whether the forge actually applies the assignee — GitHub/GitLab silently drop an
 *  un-assignable user, so a re-read (getSnapshot) reflects it only when it landed. */
function recorder(snap: IssueSnapshot, opts: { assignLands?: boolean } = {}) {
  const assignLands = opts.assignLands ?? true;
  const calls: string[] = [];
  const assigned: string[] = [];
  const comments: string[] = [];
  const adapter: Partial<ForgeAdapter> = {
    getSnapshot: async () =>
      snap.mr
        ? {
            ...snap,
            mr: {
              ...snap.mr,
              assignees: [...snap.mr.assignees, ...(assignLands ? assigned.map(user) : [])],
            },
          }
        : snap,
    commentIssue: async (_r, _i, body) => {
      calls.push('commentIssue');
      comments.push(body);
    },
    commentMR: async () => void calls.push('commentMR'),
    assignMR: async (_r, _iid, username) => {
      calls.push('assignMR');
      assigned.push(username);
    },
    setDraft: async () => void calls.push('setDraft'),
    setIssueLabels: async () => void calls.push('setIssueLabels'),
  };
  return { adapter: adapter as ForgeAdapter, calls, assigned, comments };
}

const proof: ProofResult = { ok: true, kind: 'test-output', summary: 'all green' };

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

describe('Slice 5 — strict ordering (§7 guarantee)', () => {
  it('comment(issue) < comment(MR) < assign < undraft < label; reviewer = ticket creator', async () => {
    const { adapter, calls, assigned } = recorder(snapshot());
    await handoff(hin(adapter));
    expect(calls).toEqual(['commentIssue', 'commentMR', 'assignMR', 'setDraft', 'setIssueLabels']);
    expect(assigned).toEqual(['reporter']); // ticket creator, not the bot
  });

  it('proofAndHandoff posts proof comment before assigning (proof-before-assign end-to-end)', async () => {
    const { adapter, calls } = recorder(snapshot());
    await proofAndHandoff({
      ...hin(adapter),
      proofInput: {
        workspaceDir: '/ws',
        workflowProof: { type: 'none' },
        environment: {},
        git: { target: 'main' },
        exec: adapter as never,
      },
    } as never);
    expect(calls.indexOf('commentIssue')).toBeLessThan(calls.indexOf('assignMR'));
  });
});

// --- Slice 6: pinged exactly once ------------------------------------------

describe('Slice 6 — human pinged exactly once', () => {
  it('assignMR called once, after proof comments', async () => {
    const { adapter, calls } = recorder(snapshot());
    await handoff(hin(adapter));
    expect(calls.filter((c) => c === 'assignMR')).toHaveLength(1);
  });

  it('if a proof comment throws, assignMR is never reached', async () => {
    const { adapter, calls } = recorder(snapshot());
    adapter.commentMR = async () => {
      throw new Error('network');
    };
    await expect(handoff(hin(adapter))).rejects.toThrow('network');
    expect(calls).not.toContain('assignMR');
  });
});

// --- Slice 6b: un-assignable reviewer → @-mention fallback (#6) -------------

describe('Slice 6b — un-assignable reviewer falls back to an @-mention (#6)', () => {
  const PING = '<!-- maestro:reviewer-ping -->';

  it('pings the ticket creator when the assign silently no-ops', async () => {
    const { adapter, calls, comments } = recorder(snapshot(), { assignLands: false });
    await handoff(hin(adapter));
    expect(calls.filter((c) => c === 'assignMR')).toHaveLength(1); // attempted
    const ping = comments.find((b) => b.includes('@reporter'));
    expect(ping).toBeDefined();
    expect(ping).toContain('review');
    expect(ping).toContain(PING);
    // the rest of the sequence still completes
    expect(calls).toContain('setDraft');
    expect(calls).toContain('setIssueLabels');
  });

  it('does not ping when the assign lands', async () => {
    const { adapter, comments } = recorder(snapshot(), { assignLands: true });
    await handoff(hin(adapter));
    expect(comments.some((b) => b.includes('@reporter'))).toBe(false);
  });

  it('idempotent: a crash-recovery re-run does not re-ping', async () => {
    const { adapter, calls } = recorder(
      snapshot({ comments: [`### Proof\nok\n${DONE_SENTINEL}`, PING] }),
      { assignLands: false },
    );
    await handoff(hin(adapter));
    // proof already posted AND already pinged → no commentIssue at all
    expect(calls).not.toContain('commentIssue');
    expect(calls).toEqual(['assignMR', 'setDraft', 'setIssueLabels']);
  });
});

// --- Slice 7: crash-recovery idempotency -----------------------------------

describe('Slice 7 — crash-recovery idempotency', () => {
  it('a. not started → full sequence runs', async () => {
    const { adapter, calls } = recorder(snapshot());
    await handoff(hin(adapter));
    expect(calls).toContain('commentIssue');
    expect(calls).toContain('assignMR');
  });

  it('b. partway (proof posted, not assigned) → no double-comment, still assigns/undrafts/labels', async () => {
    const { adapter, calls } = recorder(
      snapshot({ comments: [`### Proof\nall green\n${DONE_SENTINEL}`] }),
    );
    await handoff(hin(adapter));
    expect(calls).not.toContain('commentIssue'); // sentinel detected → skip
    expect(calls).not.toContain('commentMR');
    expect(calls).toEqual(['assignMR', 'setDraft', 'setIssueLabels']);
  });

  it('c. fully done → no-op (zero mutating calls)', async () => {
    const l = labelNames('gitlab');
    const { adapter, calls } = recorder(
      snapshot({
        comments: [DONE_SENTINEL],
        assignees: ['reporter'],
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
      assignMR: async () => {},
      setDraft: async () => {},
      setIssueLabels: async () => {},
    };
    await handoff(
      hin(adapter as ForgeAdapter, {
        proof: { ok: false, kind: 'playwright', summary: 'boot failed' },
      }),
    );
    expect(bodies[0]).toMatch(/failed/i);
    expect(bodies[0]).toContain('boot failed');
  });
});
