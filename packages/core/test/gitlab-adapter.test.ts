import { describe, expect, it } from 'vitest';
import type { RepoRef } from '../src/contracts/index.js';
import { labelNames } from '../src/contracts/labels.js';
import { GitlabAdapter } from '../src/forge/gitlab/gitlab-adapter.js';
import { FakeExec } from './helpers/fake-exec.js';

const TOKEN = 'glpat-SECRET-TOKEN';
const repo: RepoRef = {
  forge: 'gitlab',
  host: 'gitlab.com',
  project: 'group/api',
  url: 'gitlab.com/group/api',
};

function mk(fake = new FakeExec()): { a: GitlabAdapter; fake: FakeExec } {
  const a = new GitlabAdapter(fake, { token: TOKEN, host: 'gitlab.com', botUser: 'maestro-bot' });
  return { a, fake };
}

/** Parse the JSON body (sent via stdin) of the first call matching method+pathSub. */
function bodyOf(fake: FakeExec, method: string, pathSub: string): Record<string, unknown> {
  const call = fake.callsTo(method, pathSub)[0];
  if (!call?.opts?.input) throw new Error(`no body for ${method} ${pathSub}`);
  return JSON.parse(call.opts.input);
}

const user = (id: number, username: string) => ({ id, username });
const rawIssue = (over: Record<string, unknown> = {}) => ({
  iid: 42,
  id: 9042,
  title: 'Add OAuth login',
  description: 'please add oauth',
  state: 'opened',
  labels: [] as string[],
  assignees: [user(1, 'maestro-bot')],
  author: user(2, 'reporter'),
  web_url: 'https://gitlab.com/group/api/-/issues/42',
  ...over,
});
const rawMr = (over: Record<string, unknown> = {}) => ({
  iid: 7,
  id: 7007,
  title: 'Draft: Add OAuth login',
  description: 'Closes #42',
  state: 'opened',
  work_in_progress: true,
  source_branch: 'maestro/issue-42-add-oauth-login',
  target_branch: 'main',
  assignees: [] as unknown[],
  labels: [] as string[],
  web_url: 'https://gitlab.com/group/api/-/merge_requests/7',
  ...over,
});

// --- Slice 0 + 16: token in env, never argv -------------------------------

describe('Slice 0/16 — token safety', () => {
  it('routes the token through env, never argv', async () => {
    const { a, fake } = mk();
    fake.onApi('GET', '/issues', [rawIssue()]);
    await a.listAssignedOpenIssues(repo);
    const call = fake.calls[0];
    expect(call?.opts?.env?.GITLAB_TOKEN).toBe(TOKEN);
    expect(call?.args.join(' ')).not.toContain(TOKEN);
  });

  it('non-zero exit throws ForgeError without leaking the token', async () => {
    const { a, fake } = mk();
    fake.onApiError('GET', '/issues', 1, 'GET https://gitlab.com/... 500 Internal');
    await expect(a.listAssignedOpenIssues(repo)).rejects.toThrow(/failed/);
    await a.listAssignedOpenIssues(repo).catch((e: Error) => {
      expect(e.message).not.toContain(TOKEN);
    });
  });
});

// --- Slice 1: listAssignedOpenIssues --------------------------------------

describe('Slice 1 — listAssignedOpenIssues', () => {
  it('filters by bot assignee + opened and normalizes', async () => {
    const { a, fake } = mk();
    fake.onApi('GET', '/issues', [
      rawIssue(),
      rawIssue({ iid: 43, id: 9043, labels: ['maestro::in-progress'] }),
    ]);
    const issues = await a.listAssignedOpenIssues(repo);
    const q = fake.calls[0]?.args.join(' ');
    expect(q).toContain('assignee_username=maestro-bot');
    expect(q).toContain('state=opened');
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({
      iid: 42,
      id: '9042',
      state: 'open',
      author: { username: 'reporter', id: '2' },
    });
    expect(issues[1]?.labels).toEqual(['maestro::in-progress']);
  });
});

// --- Slice 2: getSnapshot --------------------------------------------------

function wireSnapshot(fake: FakeExec, opts: { mr?: boolean; closed?: boolean } = {}) {
  // order: specific sub-issue paths before the bare /issues/42
  fake.onApi('GET', '/issues/42/resource_label_events', [
    { id: 1, user: user(5, 'maintainer'), created_at: '2026-06-01T00:00:00Z' },
    { id: 2, user: user(2, 'reporter'), created_at: '2026-06-02T00:00:00Z' },
  ]);
  fake.onApi('GET', '/issues/42/related_merge_requests', opts.mr ? [rawMr()] : []);
  fake.onApi('GET', '/issues/42/notes', [
    { id: 11, author: user(2, 'reporter'), body: 'old', created_at: '2026-06-01T00:00:00Z' },
    { id: 12, author: user(5, 'maintainer'), body: 'new', created_at: '2026-06-03T00:00:00Z' },
    {
      id: 13,
      author: user(0, 'system'),
      body: 'changed label',
      created_at: '2026-06-04T00:00:00Z',
      system: true,
    },
  ]);
  if (opts.mr) {
    fake.onApi('GET', '/merge_requests/7/approvals', { approved: false, approved_by: [] });
    fake.onApi('GET', '/repository/commits', []);
    fake.onApi('GET', '/merge_requests/7/discussions', []);
  }
  fake.onApi('GET', '/issues/42', rawIssue({ state: opts.closed ? 'closed' : 'opened' }));
}

describe('Slice 2 — getSnapshot', () => {
  it('assembles issue + maestro MR + newest-first capped non-system comments + lastActor', async () => {
    const { a, fake } = mk();
    wireSnapshot(fake, { mr: true });
    const snap = await a.getSnapshot(repo, 42);
    expect(snap.issue.iid).toBe(42);
    expect(snap.issue.lastActor?.username).toBe('reporter'); // most recent label event
    expect(snap.mr?.iid).toBe(7);
    expect(snap.mr?.isDraft).toBe(true);
    expect(snap.mr?.closesIssueIid).toBe(42);
    expect(snap.recentComments.map((c) => c.body)).toEqual(['new', 'old']); // newest-first, system dropped
  });

  it('with no MR yet → snapshot.mr undefined (the New state)', async () => {
    const { a, fake } = mk();
    wireSnapshot(fake, { mr: false });
    const snap = await a.getSnapshot(repo, 42);
    expect(snap.mr).toBeUndefined();
  });
});

// --- Slice 3: getIssueState ------------------------------------------------

describe('Slice 3 — getIssueState', () => {
  it('maps open / closed / missing(404)', async () => {
    const open = mk();
    open.fake.onApi('GET', '/issues/42', rawIssue({ state: 'opened' }));
    expect(await open.a.getIssueState(repo, 42)).toBe('open');

    const closed = mk();
    closed.fake.onApi('GET', '/issues/42', rawIssue({ state: 'closed' }));
    expect(await closed.a.getIssueState(repo, 42)).toBe('closed');

    const gone = mk();
    gone.fake.onApiError('GET', '/issues/99', 1, '404 Not Found');
    expect(await gone.a.getIssueState(repo, 99)).toBe('missing');
  });
});

// --- Slice 4: createBranch -------------------------------------------------

describe('Slice 4 — createBranch', () => {
  it('creates from ref', async () => {
    const { a, fake } = mk();
    fake.onApi('POST', '/repository/branches', { name: 'b' });
    await a.createBranch(repo, 'maestro/issue-42-x', 'main');
    const q = fake.calls[0]?.args.join(' ');
    expect(q).toContain('branch=maestro%2Fissue-42-x');
    expect(q).toContain('ref=main');
  });

  it('is idempotent when the branch already exists', async () => {
    const { a, fake } = mk();
    fake.onApiError('POST', '/repository/branches', 1, 'Branch already exists');
    await expect(a.createBranch(repo, 'b', 'main')).resolves.toBeUndefined();
  });
});

// --- Slice 5: createDraftMR ------------------------------------------------

describe('Slice 5 — createDraftMR', () => {
  it('opens a draft MR with Closes #N and bot assignee; returns isDraft', async () => {
    const { a, fake } = mk();
    fake.onApi('GET', '/merge_requests', []); // no existing
    fake.onApi('GET', '/users', [user(1, 'maestro-bot')]);
    fake.onApi('POST', '/merge_requests', rawMr());
    const mr = await a.createDraftMR(repo, {
      sourceBranch: 'maestro/issue-42-x',
      targetBranch: 'main',
      title: 'Add OAuth login (Closes #42)',
      description: 'Closes #42',
      draft: true,
      assignToBot: true,
    });
    const body = bodyOf(fake, 'POST', '/merge_requests');
    expect(body.title).toMatch(/^Draft:/);
    expect(body.description).toContain('Closes #42');
    expect(body.assignee_ids).toEqual([1]);
    expect(mr.isDraft).toBe(true);
  });

  it('is idempotent — existing open MR for the source branch is returned, zero creates', async () => {
    const { a, fake } = mk();
    fake.onApi('GET', '/merge_requests', [rawMr()]);
    const mr = await a.createDraftMR(repo, {
      sourceBranch: 'maestro/issue-42-add-oauth-login',
      targetBranch: 'main',
      title: 'x',
      description: 'Closes #42',
      draft: true,
      assignToBot: false,
    });
    expect(mr.iid).toBe(7);
    expect(fake.callsTo('POST', '/merge_requests')).toHaveLength(0);
  });
});

// --- Slice 6: updateMRDescription / setDraft / assignMR -------------------

describe('Slice 6 — description / draft / assign', () => {
  it('updateMRDescription PUTs description', async () => {
    const { a, fake } = mk();
    fake.onApi('PUT', '/merge_requests/7', rawMr());
    await a.updateMRDescription(repo, 7, '- [x] done');
    expect(bodyOf(fake, 'PUT', '/merge_requests/7').description).toBe('- [x] done');
  });

  it('setDraft(false) strips the Draft: prefix', async () => {
    const { a, fake } = mk();
    fake.onApi('GET', '/merge_requests/7', rawMr({ title: 'Draft: Add OAuth login' }));
    fake.onApi('PUT', '/merge_requests/7', rawMr());
    await a.setDraft(repo, 7, false);
    expect(bodyOf(fake, 'PUT', '/merge_requests/7').title).toBe('Add OAuth login');
  });

  it('setDraft is idempotent when already in the target state (no PUT)', async () => {
    const { a, fake } = mk();
    fake.onApi(
      'GET',
      '/merge_requests/7',
      rawMr({ title: 'Draft: Add OAuth login', work_in_progress: true }),
    );
    await a.setDraft(repo, 7, true);
    expect(fake.callsTo('PUT', '/merge_requests/7')).toHaveLength(0);
  });

  it('assignMR resolves username→id and assigns; idempotent if already assigned', async () => {
    const { a, fake } = mk();
    fake.onApi('GET', '/users', [user(5, 'reporter')]);
    fake.onApi('GET', '/merge_requests/7', rawMr({ assignees: [] }));
    fake.onApi('PUT', '/merge_requests/7', rawMr());
    await a.assignMR(repo, 7, 'reporter');
    expect(bodyOf(fake, 'PUT', '/merge_requests/7').assignee_ids).toEqual([5]);

    const already = mk();
    already.fake.onApi('GET', '/users', [user(5, 'reporter')]);
    already.fake.onApi('GET', '/merge_requests/7', rawMr({ assignees: [user(5, 'reporter')] }));
    await already.a.assignMR(repo, 7, 'reporter');
    expect(already.fake.callsTo('PUT', '/merge_requests/7')).toHaveLength(0);
  });
});

// --- Slice 7: mergeMR ------------------------------------------------------

describe('Slice 7 — mergeMR', () => {
  it('squash merge removes the source branch', async () => {
    const { a, fake } = mk();
    fake.onApi('GET', '/merge_requests/7', rawMr({ state: 'opened' }));
    fake.onApi('PUT', '/merge_requests/7/merge', rawMr({ state: 'merged' }));
    await a.mergeMR(repo, 7, 'squash', true);
    const body = bodyOf(fake, 'PUT', '/merge_requests/7/merge');
    expect(body.squash).toBe(true);
    expect(body.should_remove_source_branch).toBe(true);
  });

  it('is idempotent — already-merged MR makes no merge call', async () => {
    const { a, fake } = mk();
    fake.onApi('GET', '/merge_requests/7', rawMr({ state: 'merged' }));
    await a.mergeMR(repo, 7, 'squash', true);
    expect(fake.callsTo('PUT', '/merge_requests/7/merge')).toHaveLength(0);
  });
});

// --- Slice 8: setIssueLabels ----------------------------------------------

describe('Slice 8 — setIssueLabels (scoped mutual exclusion is free)', () => {
  it('uses add_labels/remove_labels deltas; no manual sibling unset needed', async () => {
    const { a, fake } = mk();
    const l = labelNames('gitlab');
    fake.onApi('PUT', '/issues/42', rawIssue());
    await a.setIssueLabels(repo, 42, [l.inReview], []); // scoped label drops in-progress automatically
    const body = bodyOf(fake, 'PUT', '/issues/42');
    expect(body.add_labels).toBe('maestro::in-review');
    expect(body.remove_labels).toBeUndefined();
  });
});

// --- Slice 9: comments -----------------------------------------------------

describe('Slice 9 — comments', () => {
  it('posts issue and MR notes', async () => {
    const { a, fake } = mk();
    fake.onApi('POST', '/issues/42/notes', { id: 1 });
    fake.onApi('POST', '/merge_requests/7/notes', { id: 2 });
    await a.commentIssue(repo, 42, 'started');
    await a.commentMR(repo, 7, 'proof attached');
    expect(bodyOf(fake, 'POST', '/issues/42/notes').body).toBe('started');
    expect(bodyOf(fake, 'POST', '/merge_requests/7/notes').body).toBe('proof attached');
  });
});

// --- Slice 10: ensureLabels -----------------------------------------------

describe('Slice 10 — ensureLabels', () => {
  it('creates only the missing scoped labels', async () => {
    const { a, fake } = mk();
    const l = labelNames('gitlab');
    fake.onApi('GET', '/labels', [{ id: 1, name: 'maestro::in-progress' }]);
    fake.onApi('POST', '/labels', { id: 2 });
    await a.ensureLabels(
      repo,
      l.all().map((name) => ({ name })),
    );
    const created = fake
      .callsTo('POST', '/labels')
      .map((c) => JSON.parse(c.opts?.input ?? '{}').name);
    expect(created).toEqual(['maestro::in-review', 'maestro::blocked']);
  });

  it('is fully idempotent when all present', async () => {
    const { a, fake } = mk();
    const l = labelNames('gitlab');
    fake.onApi(
      'GET',
      '/labels',
      l.all().map((name, i) => ({ id: i + 1, name })),
    );
    await a.ensureLabels(
      repo,
      l.all().map((name) => ({ name })),
    );
    expect(fake.callsTo('POST', '/labels')).toHaveLength(0);
  });
});

// --- Slice 11: ensureBoard -------------------------------------------------

describe('Slice 11 — ensureBoard (§11)', () => {
  it('creates the board then adds lists in lifecycle order', async () => {
    const { a, fake } = mk();
    const l = labelNames('gitlab');
    // specific paths registered before '/boards' so substrings don't over-match
    fake.onApi('GET', '/boards/99/lists', []);
    fake.onApi('POST', '/boards/99/lists', { id: 1 });
    fake.onApi(
      'GET',
      '/labels',
      l.all().map((name, i) => ({ id: i + 10, name })),
    );
    fake.onApi('GET', '/boards', []);
    fake.onApi('POST', '/boards', { id: 99 });
    await a.ensureBoard(
      repo,
      l.all().map((name) => ({ name })),
    );

    expect(fake.callsMatching('POST', /\/boards$/)).toHaveLength(1); // board create, not lists
    const listLabelIds = fake
      .callsTo('POST', '/boards/99/lists')
      .map((c) => JSON.parse(c.opts?.input ?? '{}').label_id);
    expect(listLabelIds).toEqual([10, 11, 12]); // inProgress, inReview, blocked — lifecycle order
  });

  it('reuses the single existing Free-tier board and skips existing lists', async () => {
    const { a, fake } = mk();
    const l = labelNames('gitlab');
    fake.onApi('GET', '/boards/5/lists', [{ id: 1, label: { id: 10, name: l.inProgress } }]);
    fake.onApi('POST', '/boards/5/lists', { id: 2 });
    fake.onApi(
      'GET',
      '/labels',
      l.all().map((name, i) => ({ id: i + 10, name })),
    );
    fake.onApi('GET', '/boards', [{ id: 5 }]);
    await a.ensureBoard(
      repo,
      l.all().map((name) => ({ name })),
    );
    expect(fake.callsMatching('POST', /\/boards$/)).toHaveLength(0); // reused, no board create
    const listLabelIds = fake
      .callsTo('POST', '/boards/5/lists')
      .map((c) => JSON.parse(c.opts?.input ?? '{}').label_id);
    expect(listLabelIds).toEqual([11, 12]); // in-progress list already existed
  });
});

// --- Slice 12: createIssue -------------------------------------------------

describe('Slice 12 — createIssue', () => {
  it('opens an issue assigned to the bot', async () => {
    const { a, fake } = mk();
    fake.onApi('GET', '/users', [user(1, 'maestro-bot')]);
    fake.onApi('POST', '/issues', rawIssue({ title: "Let's define my workflow" }));
    const issue = await a.createIssue(repo, {
      title: "Let's define my workflow",
      body: 'hi',
      assignToBot: true,
    });
    expect(bodyOf(fake, 'POST', '/issues').assignee_ids).toEqual([1]);
    expect(issue.iid).toBe(42);
  });
});

// --- Slice 13: ApprovalState ----------------------------------------------

describe('Slice 13 — ApprovalState normalization', () => {
  it('approved MR → approved=true with approvedBy', async () => {
    const { a, fake } = mk();
    fake.onApi('GET', '/issues/42/resource_label_events', []);
    fake.onApi('GET', '/issues/42/related_merge_requests', [rawMr()]);
    fake.onApi('GET', '/issues/42/notes', []);
    fake.onApi('GET', '/merge_requests/7/approvals', {
      approved: true,
      approved_by: [{ user: user(5, 'maintainer') }],
    });
    fake.onApi('GET', '/repository/commits', []);
    fake.onApi('GET', '/merge_requests/7/discussions', []);
    fake.onApi('GET', '/issues/42', rawIssue());
    const snap = await a.getSnapshot(repo, 42);
    expect(snap.mr?.approvals.approved).toBe(true);
    expect(snap.mr?.approvals.approvedBy[0]?.username).toBe('maintainer');
  });
});

// --- Slice 14: changesRequested edge-trigger ------------------------------

function wireChanges(fake: FakeExec, opts: { discussionAt?: string; botCommitAt?: string }) {
  fake.onApi('GET', '/issues/42/resource_label_events', []);
  fake.onApi('GET', '/issues/42/related_merge_requests', [rawMr()]);
  fake.onApi('GET', '/issues/42/notes', []);
  fake.onApi('GET', '/merge_requests/7/approvals', { approved: false });
  fake.onApi(
    'GET',
    '/repository/commits',
    opts.botCommitAt
      ? [
          {
            id: 'c1',
            committed_date: opts.botCommitAt,
            author_name: 'maestro-bot',
            author_email: 'bot@x',
          },
        ]
      : [],
  );
  fake.onApi(
    'GET',
    '/merge_requests/7/discussions',
    opts.discussionAt
      ? [
          {
            id: 'd1',
            notes: [
              {
                id: 1,
                author: user(5, 'maintainer'),
                created_at: opts.discussionAt,
                resolvable: true,
                resolved: false,
              },
            ],
          },
        ]
      : [],
  );
  fake.onApi('GET', '/issues/42', rawIssue());
}

describe('Slice 14 — changesRequested edge-trigger (§0.3)', () => {
  it('blocking discussion AFTER last bot push → true', async () => {
    const { a, fake } = mk();
    wireChanges(fake, {
      botCommitAt: '2026-06-01T00:00:00Z',
      discussionAt: '2026-06-02T00:00:00Z',
    });
    expect((await a.getSnapshot(repo, 42)).mr?.approvals.changesRequested).toBe(true);
  });

  it('feedback OLDER than last bot push → false (already addressed)', async () => {
    const { a, fake } = mk();
    wireChanges(fake, {
      botCommitAt: '2026-06-03T00:00:00Z',
      discussionAt: '2026-06-02T00:00:00Z',
    });
    expect((await a.getSnapshot(repo, 42)).mr?.approvals.changesRequested).toBe(false);
  });

  it('no blocking discussion → false', async () => {
    const { a, fake } = mk();
    wireChanges(fake, { botCommitAt: '2026-06-01T00:00:00Z' });
    expect((await a.getSnapshot(repo, 42)).mr?.approvals.changesRequested).toBe(false);
  });
});

// --- Slice 15: lastActor ---------------------------------------------------

describe('Slice 15 — lastActor', () => {
  it('reflects the most recent label-event actor', async () => {
    const { a, fake } = mk();
    wireSnapshot(fake, { mr: false });
    expect((await a.getSnapshot(repo, 42)).issue.lastActor?.username).toBe('reporter');
  });

  it('no event data → lastActor undefined', async () => {
    const { a, fake } = mk();
    fake.onApi('GET', '/issues/42/resource_label_events', []);
    fake.onApi('GET', '/issues/42/related_merge_requests', []);
    fake.onApi('GET', '/issues/42/notes', []);
    fake.onApi('GET', '/issues/42', rawIssue());
    expect((await a.getSnapshot(repo, 42)).issue.lastActor).toBeUndefined();
  });
});
