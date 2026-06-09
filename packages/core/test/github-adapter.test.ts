import { describe, expect, it } from 'vitest';
import type { RepoRef } from '../src/contracts/index.js';
import { labelNames } from '../src/contracts/labels.js';
import { GithubAdapter } from '../src/forge/github/github-adapter.js';
import { FakeExec } from './helpers/fake-exec.js';

const TOKEN = 'ghp-SECRET-TOKEN';
const repo: RepoRef = {
  forge: 'github',
  host: 'github.com',
  project: 'org/api',
  url: 'github.com/org/api',
};

function mk(fake = new FakeExec()): { a: GithubAdapter; fake: FakeExec } {
  const a = new GithubAdapter(fake, { token: TOKEN, host: 'github.com', botUser: 'maestro-bot' });
  return { a, fake };
}

/** Parse the JSON body (sent via stdin) of the first call matching method+pathSub. */
function bodyOf(fake: FakeExec, method: string, pathSub: string): Record<string, unknown> {
  const call = fake.callsTo(method, pathSub)[0];
  if (!call?.opts?.input) throw new Error(`no body for ${method} ${pathSub}`);
  return JSON.parse(call.opts.input);
}

const user = (id: number, login: string) => ({ id, login });
const rawIssue = (over: Record<string, unknown> = {}) => ({
  number: 42,
  node_id: 'I_kw42',
  id: 9042,
  title: 'Add OAuth login',
  body: 'please add oauth',
  state: 'open',
  labels: [] as unknown[],
  assignees: [user(1, 'maestro-bot')],
  user: user(2, 'reporter'),
  html_url: 'https://github.com/org/api/issues/42',
  ...over,
});
const rawPr = (over: Record<string, unknown> = {}) => ({
  number: 7,
  node_id: 'PR_kw7',
  id: 7007,
  title: 'Add OAuth login',
  body: 'Closes #42',
  state: 'open',
  draft: true,
  merged: false,
  head: { ref: 'maestro/issue-42-add-oauth-login', sha: 'deadbeef' },
  base: { ref: 'main' },
  assignees: [] as unknown[],
  labels: [] as unknown[],
  html_url: 'https://github.com/org/api/pull/7',
  ...over,
});

// --- Slice 0 + 16: token in env, never argv -------------------------------

describe('Slice 0/16 — token safety', () => {
  it('routes the token through env (GH_TOKEN), never argv', async () => {
    const { a, fake } = mk();
    fake.onApi('GET', '/issues', [rawIssue()]);
    await a.listAssignedOpenIssues(repo);
    const call = fake.calls[0];
    expect(call?.cmd).toBe('gh');
    expect(call?.opts?.env?.GH_TOKEN).toBe(TOKEN);
    expect(call?.args.join(' ')).not.toContain(TOKEN);
  });

  it('non-zero exit throws ForgeError without leaking the token', async () => {
    const { a, fake } = mk();
    fake.onApiError('GET', '/issues', 1, 'gh: HTTP 500 Internal');
    await expect(a.listAssignedOpenIssues(repo)).rejects.toThrow(/failed/);
    await a.listAssignedOpenIssues(repo).catch((e: Error) => {
      expect(e.message).not.toContain(TOKEN);
    });
  });
});

// --- Slice 1: listAssignedOpenIssues --------------------------------------

describe('Slice 1 — listAssignedOpenIssues', () => {
  it('filters by bot assignee + open, drops PRs, normalizes labels/author', async () => {
    const { a, fake } = mk();
    fake.onApi('GET', '/issues', [
      rawIssue(),
      rawIssue({ number: 43, node_id: 'I_kw43', labels: [{ name: 'maestro:in-progress' }] }),
      rawIssue({ number: 99, pull_request: { url: 'x' } }), // a PR masquerading as an issue
    ]);
    const issues = await a.listAssignedOpenIssues(repo);
    const q = fake.calls[0]?.args.join(' ');
    expect(q).toContain('assignee=maestro-bot');
    expect(q).toContain('state=open');
    expect(issues).toHaveLength(2); // PR excluded
    expect(issues[0]).toMatchObject({
      iid: 42,
      id: 'I_kw42',
      state: 'open',
      author: { username: 'reporter', id: '2' },
    });
    expect(issues[1]?.labels).toEqual(['maestro:in-progress']);
  });
});

// --- Slice 2: getSnapshot --------------------------------------------------

function wireSnapshot(fake: FakeExec, opts: { pr?: boolean; closed?: boolean } = {}) {
  fake.onApi('GET', '/issues/42/timeline', [
    { event: 'labeled', actor: user(5, 'maintainer'), created_at: '2026-06-01T00:00:00Z' },
    { event: 'assigned', actor: user(2, 'reporter'), created_at: '2026-06-02T00:00:00Z' },
  ]);
  fake.onApi('GET', '/issues/42/comments', [
    { id: 11, user: user(2, 'reporter'), body: 'old', created_at: '2026-06-01T00:00:00Z' },
    { id: 12, user: user(5, 'maintainer'), body: 'new', created_at: '2026-06-03T00:00:00Z' },
  ]);
  if (opts.pr) {
    fake.onApi('GET', '/pulls/7/reviews', []);
    fake.onApi('GET', '/issues/7/comments', []); // PR-conversation read (shared-account /maestro)
    fake.onApi('GET', '/pulls', [rawPr()]);
  } else {
    fake.onApi('GET', '/pulls', []);
  }
  fake.onApi('GET', '/issues/42', rawIssue({ state: opts.closed ? 'closed' : 'open' }));
}

describe('Slice 2 — getSnapshot', () => {
  it('assembles issue + maestro PR + newest-first capped comments + lastActor', async () => {
    const { a, fake } = mk();
    wireSnapshot(fake, { pr: true });
    const snap = await a.getSnapshot(repo, 42);
    expect(snap.issue.iid).toBe(42);
    expect(snap.issue.lastActor?.username).toBe('reporter'); // most recent timeline event
    expect(snap.mr?.iid).toBe(7);
    expect(snap.mr?.isDraft).toBe(true);
    expect(snap.mr?.closesIssueIid).toBe(42);
    expect(snap.recentComments.map((c) => c.body)).toEqual(['new', 'old']); // newest-first
  });

  it('with no PR yet → snapshot.mr undefined (the New state)', async () => {
    const { a, fake } = mk();
    wireSnapshot(fake, { pr: false });
    const snap = await a.getSnapshot(repo, 42);
    expect(snap.mr).toBeUndefined();
  });
});

// --- Slice 3: getIssueState ------------------------------------------------

describe('Slice 3 — getIssueState', () => {
  it('maps open / closed / missing(404)', async () => {
    const open = mk();
    open.fake.onApi('GET', '/issues/42', rawIssue({ state: 'open' }));
    expect(await open.a.getIssueState(repo, 42)).toBe('open');

    const closed = mk();
    closed.fake.onApi('GET', '/issues/42', rawIssue({ state: 'closed' }));
    expect(await closed.a.getIssueState(repo, 42)).toBe('closed');

    const gone = mk();
    gone.fake.onApiError('GET', '/issues/99', 1, 'gh: Not Found (HTTP 404)');
    expect(await gone.a.getIssueState(repo, 99)).toBe('missing');
  });
});

// --- Slice 4: createBranch -------------------------------------------------

describe('Slice 4 — createBranch', () => {
  it('resolves base sha then creates the ref', async () => {
    const { a, fake } = mk();
    fake.onApi('GET', '/git/ref/heads/main', { object: { sha: 'base-sha' } });
    fake.onApi('POST', '/git/refs', { ref: 'refs/heads/x' });
    await a.createBranch(repo, 'maestro/issue-42-x', 'main');
    const body = bodyOf(fake, 'POST', '/git/refs');
    expect(body.ref).toBe('refs/heads/maestro/issue-42-x');
    expect(body.sha).toBe('base-sha');
  });

  it('is idempotent when the ref already exists (422)', async () => {
    const { a, fake } = mk();
    fake.onApi('GET', '/git/ref/heads/main', { object: { sha: 'base-sha' } });
    fake.onApiError('POST', '/git/refs', 1, 'HTTP 422: Reference already exists');
    await expect(a.createBranch(repo, 'b', 'main')).resolves.toBeUndefined();
  });
});

// --- Slice 5: createDraftMR ------------------------------------------------

describe('Slice 5 — createDraftMR', () => {
  it('opens a native draft PR with Closes #N and assigns the bot via issues endpoint', async () => {
    const { a, fake } = mk();
    fake.onApi('GET', '/pulls', []); // no existing
    fake.onApi('POST', '/pulls', rawPr());
    fake.onApi('POST', '/issues/7/assignees', { number: 7 });
    const mr = await a.createDraftMR(repo, {
      sourceBranch: 'maestro/issue-42-add-oauth-login',
      targetBranch: 'main',
      title: 'Add OAuth login',
      description: 'Closes #42',
      draft: true,
      assignToBot: true,
    });
    const body = bodyOf(fake, 'POST', '/pulls');
    expect(body.draft).toBe(true);
    expect(body.head).toBe('maestro/issue-42-add-oauth-login');
    expect(body.base).toBe('main');
    expect(body.body).toContain('Closes #42');
    expect(bodyOf(fake, 'POST', '/issues/7/assignees').assignees).toEqual(['maestro-bot']);
    expect(mr.isDraft).toBe(true);
  });

  it('is idempotent — existing open PR for the head branch is returned, zero creates', async () => {
    const { a, fake } = mk();
    fake.onApi('GET', '/pulls', [rawPr()]);
    const mr = await a.createDraftMR(repo, {
      sourceBranch: 'maestro/issue-42-add-oauth-login',
      targetBranch: 'main',
      title: 'x',
      description: 'Closes #42',
      draft: true,
      assignToBot: false,
    });
    expect(mr.iid).toBe(7);
    expect(fake.callsTo('POST', '/pulls')).toHaveLength(0);
  });

  it('queries the existing PR by owner-qualified head branch', async () => {
    const { a, fake } = mk();
    fake.onApi('GET', '/pulls', [rawPr()]);
    await a.createDraftMR(repo, {
      sourceBranch: 'maestro/issue-42-x',
      targetBranch: 'main',
      title: 'x',
      description: 'Closes #42',
      draft: true,
      assignToBot: false,
    });
    expect(fake.calls[0]?.args.join(' ')).toContain('head=org%3Amaestro%2Fissue-42-x');
  });
});

// --- Slice 6: updateMRDescription / setDraft / assignMR -------------------

describe('Slice 6 — description / draft / assign', () => {
  it('updateMRDescription PATCHes body', async () => {
    const { a, fake } = mk();
    fake.onApi('PATCH', '/pulls/7', rawPr());
    await a.updateMRDescription(repo, 7, '- [x] done');
    expect(bodyOf(fake, 'PATCH', '/pulls/7').body).toBe('- [x] done');
  });

  it('setDraft(false) marks the PR ready via GraphQL on the node id', async () => {
    const { a, fake } = mk();
    fake.onApi('GET', '/pulls/7', rawPr({ draft: true, node_id: 'PR_kw7' }));
    fake.on((c) => c.args.includes('graphql'), { code: 0, stdout: '{}', stderr: '' });
    await a.setDraft(repo, 7, false);
    const gql = fake.calls.find((c) => c.args.includes('graphql'));
    const joined = gql?.args.join(' ') ?? '';
    expect(joined).toContain('markPullRequestReadyForReview');
    expect(joined).toContain('PR_kw7');
  });

  it('setDraft(true) converts to draft via GraphQL', async () => {
    const { a, fake } = mk();
    fake.onApi('GET', '/pulls/7', rawPr({ draft: false }));
    fake.on((c) => c.args.includes('graphql'), { code: 0, stdout: '{}', stderr: '' });
    await a.setDraft(repo, 7, true);
    const gql = fake.calls.find((c) => c.args.includes('graphql'));
    expect(gql?.args.join(' ')).toContain('convertPullRequestToDraft');
  });

  it('setDraft is idempotent when already in the target state (no GraphQL)', async () => {
    const { a, fake } = mk();
    fake.onApi('GET', '/pulls/7', rawPr({ draft: true }));
    await a.setDraft(repo, 7, true);
    expect(fake.calls.some((c) => c.args.includes('graphql'))).toBe(false);
  });

  it('assignMR assigns by login; idempotent if already assigned', async () => {
    const { a, fake } = mk();
    fake.onApi('GET', '/issues/7', rawIssue({ number: 7, assignees: [] }));
    fake.onApi('POST', '/issues/7/assignees', { number: 7 });
    await a.assignMR(repo, 7, 'reporter');
    expect(bodyOf(fake, 'POST', '/issues/7/assignees').assignees).toEqual(['reporter']);

    const already = mk();
    already.fake.onApi(
      'GET',
      '/issues/7',
      rawIssue({ number: 7, assignees: [user(5, 'reporter')] }),
    );
    await already.a.assignMR(repo, 7, 'reporter');
    expect(already.fake.callsTo('POST', '/issues/7/assignees')).toHaveLength(0);
  });
});

// --- Slice 7: mergeMR ------------------------------------------------------

describe('Slice 7 — mergeMR', () => {
  it('squash merge maps merge_method and deletes the head ref', async () => {
    const { a, fake } = mk();
    fake.onApi('GET', '/pulls/7', rawPr({ merged: false }));
    fake.onApi('PUT', '/pulls/7/merge', { merged: true });
    fake.onApi('DELETE', '/git/refs/heads/maestro', { ok: true });
    await a.mergeMR(repo, 7, 'squash', true);
    expect(bodyOf(fake, 'PUT', '/pulls/7/merge').merge_method).toBe('squash');
    expect(fake.callsTo('DELETE', '/git/refs/heads/maestro')).toHaveLength(1);
  });

  it('maps rebase + skips ref delete when deleteSource=false', async () => {
    const { a, fake } = mk();
    fake.onApi('GET', '/pulls/7', rawPr({ merged: false }));
    fake.onApi('PUT', '/pulls/7/merge', { merged: true });
    await a.mergeMR(repo, 7, 'rebase', false);
    expect(bodyOf(fake, 'PUT', '/pulls/7/merge').merge_method).toBe('rebase');
    expect(fake.callsTo('DELETE', '/git/refs')).toHaveLength(0);
  });

  it('is idempotent — already-merged PR makes no merge call', async () => {
    const { a, fake } = mk();
    fake.onApi('GET', '/pulls/7', rawPr({ merged: true }));
    await a.mergeMR(repo, 7, 'squash', true);
    expect(fake.callsTo('PUT', '/pulls/7/merge')).toHaveLength(0);
  });
});

// --- Slice 8: setIssueLabels (FLAT mutual exclusion — the key divergence) --

describe('Slice 8 — setIssueLabels (flat mutual exclusion enforced in adapter)', () => {
  it('removes sibling maestro:* labels when setting one, leaves non-maestro untouched', async () => {
    const { a, fake } = mk();
    const l = labelNames('github');
    fake.onApi('GET', '/issues/42/labels', [
      { name: l.inProgress },
      { name: 'bug' }, // non-maestro — must survive
    ]);
    fake.on((c) => c.args.includes('api') && c.args[0] === 'api', {
      code: 0,
      stdout: '{}',
      stderr: '',
    });
    await a.setIssueLabels(repo, 42, [l.inReview], []);
    // removed the sibling in-progress, by name, URL-encoded
    expect(fake.callsTo('DELETE', `/labels/${encodeURIComponent(l.inProgress)}`)).toHaveLength(1);
    // non-maestro 'bug' never deleted
    expect(fake.callsTo('DELETE', '/labels/bug')).toHaveLength(0);
    // added the new label
    expect(bodyOf(fake, 'POST', '/issues/42/labels').labels).toEqual([l.inReview]);
  });

  it('honors explicit unset of a non-maestro label', async () => {
    const { a, fake } = mk();
    const l = labelNames('github');
    fake.onApi('GET', '/issues/42/labels', [{ name: 'needs-info' }]);
    fake.on((c) => c.args.includes('api'), { code: 0, stdout: '{}', stderr: '' });
    await a.setIssueLabels(repo, 42, [l.inProgress], ['needs-info']);
    expect(fake.callsTo('DELETE', '/labels/needs-info')).toHaveLength(1);
  });

  it('is idempotent — setting the already-present label with no siblings makes zero mutations', async () => {
    const { a, fake } = mk();
    const l = labelNames('github');
    fake.onApi('GET', '/issues/42/labels', [{ name: l.inReview }]);
    await a.setIssueLabels(repo, 42, [l.inReview], []);
    expect(fake.callsTo('DELETE', '/labels')).toHaveLength(0);
    expect(fake.callsTo('POST', '/issues/42/labels')).toHaveLength(0);
  });
});

// --- Slice 9: comments -----------------------------------------------------

describe('Slice 9 — comments', () => {
  it('posts issue and PR comments via the issues-comments endpoint', async () => {
    const { a, fake } = mk();
    fake.onApi('POST', '/issues/42/comments', { id: 1 });
    fake.onApi('POST', '/issues/7/comments', { id: 2 });
    await a.commentIssue(repo, 42, 'started');
    await a.commentMR(repo, 7, 'proof attached');
    expect(bodyOf(fake, 'POST', '/issues/42/comments').body).toBe('started');
    expect(bodyOf(fake, 'POST', '/issues/7/comments').body).toBe('proof attached');
  });
});

// --- Slice 10: ensureLabels -----------------------------------------------

describe('Slice 10 — ensureLabels', () => {
  it('creates only the missing flat labels by name', async () => {
    const { a, fake } = mk();
    const l = labelNames('github');
    fake.onApi('GET', '/labels', [{ name: 'maestro:in-progress' }]);
    fake.onApi('POST', '/labels', { id: 2 });
    await a.ensureLabels(
      repo,
      l.all().map((name) => ({ name })),
    );
    const created = fake
      .callsTo('POST', '/labels')
      .map((c) => JSON.parse(c.opts?.input ?? '{}').name);
    expect(created).toEqual([
      'maestro:backlog',
      'maestro:todo',
      'maestro:in-review',
      'maestro:blocked',
      'maestro:queued',
    ]); // #53/#29 label set
  });

  it('is fully idempotent when all present', async () => {
    const { a, fake } = mk();
    const l = labelNames('github');
    fake.onApi(
      'GET',
      '/labels',
      l.all().map((name) => ({ name })),
    );
    await a.ensureLabels(
      repo,
      l.all().map((name) => ({ name })),
    );
    expect(fake.callsTo('POST', '/labels')).toHaveLength(0);
  });
});

// --- Slice 11: ensureBoard is UNDEFINED (Projects V2 deferred) -------------

describe('Slice 11 — ensureBoard absent (GitHub gets labels only)', () => {
  it('GithubAdapter does not implement ensureBoard', () => {
    const { a } = mk();
    expect(a.ensureBoard).toBeUndefined();
  });

  it('onboarding-style setup calls ensureLabels but never a board/Projects API', async () => {
    const { a, fake } = mk();
    const l = labelNames('github');
    fake.onApi('GET', '/labels', []);
    fake.onApi('POST', '/labels', { id: 1 });
    const labels = l.all().map((name) => ({ name }));
    await a.ensureLabels(repo, labels);
    await a.ensureBoard?.(repo, labels); // §0.3 optional-call form — no-op on GitHub
    expect(fake.callsTo('POST', '/labels').length).toBeGreaterThan(0);
    expect(fake.calls.some((c) => /boards|projects/i.test(c.args.join(' ')))).toBe(false);
  });
});

// --- Slice 12: createIssue -------------------------------------------------

describe('Slice 12 — createIssue', () => {
  it('opens an issue assigned to the bot by login', async () => {
    const { a, fake } = mk();
    fake.onApi('POST', '/issues', rawIssue({ title: "Let's define my workflow" }));
    const issue = await a.createIssue(repo, {
      title: "Let's define my workflow",
      body: 'hi',
      assignToBot: true,
    });
    expect(bodyOf(fake, 'POST', '/issues').assignees).toEqual(['maestro-bot']);
    expect(issue.iid).toBe(42);
  });
});

// --- Slice 13: ApprovalState from reviews ----------------------------------

describe('Slice 13 — ApprovalState from PR reviews', () => {
  it('an APPROVED review → approved=true with approvedBy', async () => {
    const { a, fake } = mk();
    fake.onApi('GET', '/issues/42/timeline', []);
    fake.onApi('GET', '/issues/42/comments', []);
    fake.onApi('GET', '/pulls/7/reviews', [
      {
        id: 1,
        user: user(5, 'maintainer'),
        state: 'APPROVED',
        submitted_at: '2026-06-02T00:00:00Z',
      },
    ]);
    fake.onApi('GET', '/issues/7/comments', []);
    fake.onApi('GET', '/pulls', [rawPr()]);
    fake.onApi('GET', '/issues/42', rawIssue());
    const snap = await a.getSnapshot(repo, 42);
    expect(snap.mr?.approvals.approved).toBe(true);
    expect(snap.mr?.approvals.approvedBy[0]?.username).toBe('maintainer');
  });

  it('no reviews → approved=false', async () => {
    const { a, fake } = mk();
    wireSnapshot(fake, { pr: true });
    expect((await a.getSnapshot(repo, 42)).mr?.approvals.approved).toBe(false);
  });

  it('APPROVED then later CHANGES_REQUESTED from same reviewer → approved=false', async () => {
    const { a, fake } = mk();
    fake.onApi('GET', '/issues/42/timeline', []);
    fake.onApi('GET', '/issues/42/comments', []);
    fake.onApi('GET', '/pulls/7/reviews', [
      {
        id: 1,
        user: user(5, 'maintainer'),
        state: 'APPROVED',
        submitted_at: '2026-06-01T00:00:00Z',
      },
      {
        id: 2,
        user: user(5, 'maintainer'),
        state: 'CHANGES_REQUESTED',
        submitted_at: '2026-06-02T00:00:00Z',
      },
    ]);
    fake.onApi('GET', '/pulls/7/commits', []);
    fake.onApi('GET', '/issues/7/comments', []);
    fake.onApi('GET', '/pulls', [rawPr()]);
    fake.onApi('GET', '/issues/42', rawIssue());
    expect((await a.getSnapshot(repo, 42)).mr?.approvals.approved).toBe(false);
  });
});

// --- Slice 14: changesRequested edge-trigger ------------------------------

function wireReviews(
  fake: FakeExec,
  opts: {
    reviewAt?: string;
    botCommitAt?: string;
    commitAuthor?: { login: string; email: string }; // override commit identity (shared-account case)
    prComments?: Record<string, unknown>[];
  },
) {
  fake.onApi('GET', '/issues/42/timeline', []);
  fake.onApi('GET', '/issues/7/comments', opts.prComments ?? []);
  fake.onApi('GET', '/issues/42/comments', []);
  fake.onApi(
    'GET',
    '/pulls/7/reviews',
    opts.reviewAt
      ? [
          {
            id: 1,
            user: user(5, 'maintainer'),
            state: 'CHANGES_REQUESTED',
            submitted_at: opts.reviewAt,
          },
        ]
      : [],
  );
  const login = opts.commitAuthor?.login ?? 'maestro-bot';
  fake.onApi(
    'GET',
    '/pulls/7/commits',
    opts.botCommitAt
      ? [
          {
            sha: 'c1',
            commit: {
              committer: { date: opts.botCommitAt },
              author: { date: opts.botCommitAt, email: opts.commitAuthor?.email ?? 'bot@x' },
            },
            author: user(1, login),
            committer: user(1, login),
          },
        ]
      : [],
  );
  fake.onApi('GET', '/pulls', [rawPr()]);
  fake.onApi('GET', '/issues/42', rawIssue());
}

describe('Slice 14 — changesRequested edge-trigger (§0.3)', () => {
  it('CHANGES_REQUESTED review AFTER last bot push → true', async () => {
    const { a, fake } = mk();
    wireReviews(fake, { botCommitAt: '2026-06-01T00:00:00Z', reviewAt: '2026-06-02T00:00:00Z' });
    expect((await a.getSnapshot(repo, 42)).mr?.approvals.changesRequested).toBe(true);
  });

  it('CHANGES_REQUESTED OLDER than last bot push → false (already addressed)', async () => {
    const { a, fake } = mk();
    wireReviews(fake, { botCommitAt: '2026-06-03T00:00:00Z', reviewAt: '2026-06-02T00:00:00Z' });
    expect((await a.getSnapshot(repo, 42)).mr?.approvals.changesRequested).toBe(false);
  });

  it('no blocking review → false (no commits fetch needed)', async () => {
    const { a, fake } = mk();
    wireReviews(fake, { botCommitAt: '2026-06-01T00:00:00Z' });
    expect((await a.getSnapshot(repo, 42)).mr?.approvals.changesRequested).toBe(false);
  });

  // Shared-account regression (issue #5, GitLab twin): a push under the operator's personal
  // git identity (not bot_user) still retires the edge — the daemon owns the branch.
  it('a push under the operator identity (not bot_user) AFTER feedback → false', async () => {
    const { a, fake } = mk();
    wireReviews(fake, {
      botCommitAt: '2026-06-03T00:00:00Z',
      reviewAt: '2026-06-02T00:00:00Z',
      commitAuthor: { login: 'volker-otto', email: 'hello@volkerotto.net' },
    });
    expect((await a.getSnapshot(repo, 42)).mr?.approvals.changesRequested).toBe(false);
  });

  // Shared-account escape hatch: the bot/operator account cannot file a
  // CHANGES_REQUESTED review on its own PR — a body-start /maestro PR-conversation
  // comment counts as the blocking signal instead.
  it('a bot-authored body-start /maestro PR comment AFTER last bot push → true', async () => {
    const { a, fake } = mk();
    wireReviews(fake, {
      botCommitAt: '2026-06-01T00:00:00Z',
      prComments: [
        {
          id: 31,
          user: user(1, 'maestro-bot'),
          body: '/maestro tighten the error handling',
          created_at: '2026-06-02T00:00:00Z',
        },
      ],
    });
    expect((await a.getSnapshot(repo, 42)).mr?.approvals.changesRequested).toBe(true);
  });

  it('a bot-authored PR comment without the body-start prefix stays invisible', async () => {
    const { a, fake } = mk();
    wireReviews(fake, {
      botCommitAt: '2026-06-01T00:00:00Z',
      prComments: [
        {
          id: 31,
          user: user(1, 'maestro-bot'),
          body: '### 🎼 Plan\n\n/maestro mid-body must not count',
          created_at: '2026-06-02T00:00:00Z',
        },
      ],
    });
    expect((await a.getSnapshot(repo, 42)).mr?.approvals.changesRequested).toBe(false);
  });

  it('a /maestro PR comment OLDER than the last bot push is already addressed → false', async () => {
    const { a, fake } = mk();
    wireReviews(fake, {
      botCommitAt: '2026-06-03T00:00:00Z',
      prComments: [
        {
          id: 31,
          user: user(1, 'maestro-bot'),
          body: '/maestro tighten the error handling',
          created_at: '2026-06-02T00:00:00Z',
        },
      ],
    });
    expect((await a.getSnapshot(repo, 42)).mr?.approvals.changesRequested).toBe(false);
  });

  it('the newest of review vs /maestro comment wins the blocking timestamp', async () => {
    const { a, fake } = mk();
    wireReviews(fake, {
      botCommitAt: '2026-06-02T12:00:00Z',
      reviewAt: '2026-06-01T00:00:00Z', // already addressed by the push…
      prComments: [
        {
          id: 31,
          user: user(1, 'maestro-bot'),
          body: '/maestro one more thing',
          created_at: '2026-06-03T00:00:00Z', // …but the newer command is not
        },
      ],
    });
    expect((await a.getSnapshot(repo, 42)).mr?.approvals.changesRequested).toBe(true);
  });
});

// --- Slice 15: lastActor ---------------------------------------------------

describe('Slice 15 — lastActor', () => {
  it('reflects the most recent assignment/label-add actor', async () => {
    const { a, fake } = mk();
    wireSnapshot(fake, { pr: false });
    expect((await a.getSnapshot(repo, 42)).issue.lastActor?.username).toBe('reporter');
  });

  it('no relevant event → lastActor undefined', async () => {
    const { a, fake } = mk();
    fake.onApi('GET', '/issues/42/timeline', []);
    fake.onApi('GET', '/issues/42/comments', []);
    fake.onApi('GET', '/pulls', []);
    fake.onApi('GET', '/issues/42', rawIssue());
    expect((await a.getSnapshot(repo, 42)).issue.lastActor).toBeUndefined();
  });
});

// --- Slice 12: listOpenIssuesByLabel (#53) ----------------------------------

describe('Slice 12 — listOpenIssuesByLabel (#53)', () => {
  it('queries open issues by label and drops PRs', async () => {
    const { a, fake } = mk();
    fake.onApi('GET', '/issues', [
      {
        number: 9,
        id: 9,
        title: 'queued',
        state: 'open',
        assignees: [],
        labels: [],
        user: { login: 'r', id: 1 },
        html_url: 'u',
      },
      {
        number: 10,
        id: 10,
        title: 'a PR',
        state: 'open',
        assignees: [],
        labels: [],
        user: { login: 'r', id: 1 },
        html_url: 'u',
        pull_request: {},
      },
    ]);
    const out = await a.listOpenIssuesByLabel(repo, 'maestro:todo');
    expect(out.map((i) => i.iid)).toEqual([9]); // the PR row is dropped
    const call = fake.callsTo('GET', '/issues')[0];
    expect(call?.args.join(' ')).toContain('labels=maestro%3Atodo');
    expect(call?.args.join(' ')).toContain('state=open');
  });
});

// --- MR-command: listAssignedOpenMergeRequests ------------------------------

describe('MR-command — listAssignedOpenMergeRequests', () => {
  it('keeps only PR rows from /issues and fetches each as a normalized PR', async () => {
    const { a, fake } = mk();
    fake.onApi('GET', '/issues', [
      rawIssue({ number: 9, title: 'a real issue' }), // no pull_request → dropped
      rawIssue({ number: 7, title: 'a PR', pull_request: {} }),
    ]);
    fake.onApi('GET', '/pulls/7', rawPr({ head: { ref: 'feature/x' } }));
    const mrs = await a.listAssignedOpenMergeRequests(repo);
    const q = fake.callsTo('GET', '/issues')[0]?.args.join(' ');
    expect(q).toContain('assignee=maestro-bot');
    expect(q).toContain('state=open');
    expect(mrs).toHaveLength(1);
    expect(mrs[0]?.iid).toBe(7);
    expect(mrs[0]?.sourceBranch).toBe('feature/x');
  });
});

// --- MR-command: getMrComments ----------------------------------------------

describe('MR-command — getMrComments', () => {
  it('normalizes the PR conversation newest-first', async () => {
    const { a, fake } = mk();
    fake.onApi('GET', '/issues/7/comments', [
      { id: 11, user: user(2, 'reporter'), body: 'old', created_at: '2026-06-01T00:00:00Z' },
      { id: 12, user: user(5, 'maintainer'), body: 'new', created_at: '2026-06-03T00:00:00Z' },
    ]);
    const out = await a.getMrComments(repo, 7);
    expect(out.map((c) => c.body)).toEqual(['new', 'old']); // newest-first
  });
});

// --- MR-command: getMergeRequestState ---------------------------------------

describe('MR-command — getMergeRequestState', () => {
  it('maps open/merged/closed and 404→missing', async () => {
    const open = mk();
    open.fake.onApi('GET', '/pulls/7', rawPr({ state: 'open', merged: false }));
    expect(await open.a.getMergeRequestState(repo, 7)).toBe('open');

    const merged = mk();
    merged.fake.onApi('GET', '/pulls/7', rawPr({ state: 'closed', merged: true }));
    expect(await merged.a.getMergeRequestState(repo, 7)).toBe('merged');

    const mergedAt = mk();
    mergedAt.fake.onApi('GET', '/pulls/7', rawPr({ state: 'closed', merged_at: '2026-06-01' }));
    expect(await mergedAt.a.getMergeRequestState(repo, 7)).toBe('merged');

    const closed = mk();
    closed.fake.onApi('GET', '/pulls/7', rawPr({ state: 'closed', merged: false }));
    expect(await closed.a.getMergeRequestState(repo, 7)).toBe('closed');

    const gone = mk();
    gone.fake.onApiError('GET', '/pulls/7', 1, '404 Not Found');
    expect(await gone.a.getMergeRequestState(repo, 7)).toBe('missing');
  });
});
