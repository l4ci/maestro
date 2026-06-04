import { describe, expect, it } from 'vitest';
import type {
  ApprovalState,
  Comment,
  ForgeUser,
  Issue,
  IssueSnapshot,
  MergeRequest,
  ReconcileInput,
  RepoRef,
  RepoSettings,
} from '../src/contracts/index.js';
import { labelNames } from '../src/contracts/labels.js';
import { reconcile } from '../src/reconciler/reconcile.js';

// --- builders -------------------------------------------------------------

const BOT = 'maestro-bot';
const repo: RepoRef = {
  forge: 'gitlab',
  host: 'gitlab.com',
  project: 'group/api',
  url: 'gitlab.com/group/api',
};
const labels = labelNames('gitlab');
const user = (username: string): ForgeUser => ({ username, id: `id-${username}` });

function issue(over: Partial<Issue> = {}): Issue {
  return {
    iid: 42,
    id: 'gid-42',
    title: 'Add OAuth login',
    body: 'please add oauth',
    state: 'open',
    assignees: [user(BOT)],
    labels: [],
    author: user('reporter'),
    webUrl: 'https://gitlab.com/group/api/-/issues/42',
    ...over,
  };
}

function approvals(over: Partial<ApprovalState> = {}): ApprovalState {
  return { approved: false, approvedBy: [], changesRequested: false, ...over };
}

function mr(over: Partial<MergeRequest> = {}): MergeRequest {
  return {
    iid: 7,
    id: 'gid-mr-7',
    title: 'Add OAuth login (Closes #42)',
    description: '- [ ] step one',
    state: 'opened',
    isDraft: true,
    sourceBranch: 'maestro/issue-42-add-oauth-login',
    targetBranch: 'main',
    assignees: [user(BOT)],
    labels: [],
    approvals: approvals(),
    webUrl: 'https://gitlab.com/group/api/-/merge_requests/7',
    ...over,
  };
}

function settings(over: Partial<RepoSettings> = {}): RepoSettings {
  return {
    repo,
    botUser: BOT,
    trigger: { requireLabel: null, allowedActors: [] },
    git: {
      defaultBranch: 'main',
      target: 'main',
      mergeStrategy: 'squash',
      deleteSourceBranch: true,
    },
    manageBoard: true,
    labels,
    concurrency: { globalMax: 2, maxActive: 2 },
    ...over,
  };
}

function snapshot(over: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return { repo, issue: issue(), recentComments: [], ...over };
}

function buildInput(over: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    snapshot: snapshot(),
    settings: settings(),
    slotAvailable: true,
    workspaceExists: false,
    workComplete: false,
    ...over,
  };
}

// --- A0 -------------------------------------------------------------------

describe('A0 — total pure function', () => {
  it('returns an object with a kind for a minimal valid input', () => {
    const out = reconcile(buildInput());
    expect(out).toHaveProperty('kind');
  });
});

// --- A1–A3 trigger guard --------------------------------------------------

describe('trigger guard (§13.1)', () => {
  it('A1 rejects an issue not assigned to bot_user', () => {
    const out = reconcile(
      buildInput({ snapshot: snapshot({ issue: issue({ assignees: [user('someone')] }) }) }),
    );
    expect(out.kind).toBe('skip-untrusted');
  });

  it('A1 guard runs before state derivation (in-progress but unassigned still skips)', () => {
    const out = reconcile(
      buildInput({
        snapshot: snapshot({
          issue: issue({ assignees: [user('someone')], labels: [labels.inProgress] }),
        }),
      }),
    );
    expect(out.kind).toBe('skip-untrusted');
  });

  it('A2 rejects when require_label configured but missing', () => {
    const out = reconcile(
      buildInput({
        settings: settings({ trigger: { requireLabel: 'approved-for-bot', allowedActors: [] } }),
      }),
    );
    expect(out.kind).toBe('skip-untrusted');
  });

  it('A2 passes when require_label present', () => {
    const out = reconcile(
      buildInput({
        snapshot: snapshot({ issue: issue({ labels: ['approved-for-bot'] }) }),
        settings: settings({ trigger: { requireLabel: 'approved-for-bot', allowedActors: [] } }),
      }),
    );
    expect(out.kind).not.toBe('skip-untrusted');
  });

  it('A3 rejects when lastActor not in non-empty allowed_actors', () => {
    const out = reconcile(
      buildInput({
        snapshot: snapshot({ issue: issue({ lastActor: user('random') }) }),
        settings: settings({ trigger: { requireLabel: null, allowedActors: ['maintainer'] } }),
      }),
    );
    expect(out.kind).toBe('skip-untrusted');
  });

  it('A3 empty allowed_actors imposes no actor restriction', () => {
    const out = reconcile(
      buildInput({ snapshot: snapshot({ issue: issue({ lastActor: user('random') }) }) }),
    );
    expect(out.kind).not.toBe('skip-untrusted');
  });

  it('A3 fail-closed: non-empty allowed_actors but undefined lastActor rejects', () => {
    const out = reconcile(
      buildInput({
        snapshot: snapshot({ issue: issue({ lastActor: undefined }) }),
        settings: settings({ trigger: { requireLabel: null, allowedActors: ['maintainer'] } }),
      }),
    );
    expect(out.kind).toBe('skip-untrusted');
  });
});

// --- A4 Done / cleanup ----------------------------------------------------

describe('Done row (§7, §0.5)', () => {
  it('A4 closed issue with live workspace yields cleanup', () => {
    const out = reconcile(
      buildInput({
        snapshot: snapshot({ issue: issue({ state: 'closed' }) }),
        workspaceExists: true,
      }),
    );
    expect(out.kind).toBe('cleanup');
  });

  it('A4b closed issue without workspace is a stable no-op', () => {
    const out = reconcile(
      buildInput({
        snapshot: snapshot({ issue: issue({ state: 'closed' }) }),
        workspaceExists: false,
      }),
    );
    expect(out.kind).toBe('none');
  });

  it('A4b closed issue still cleans up even if no longer assigned to bot (terminal before guard)', () => {
    const out = reconcile(
      buildInput({
        snapshot: snapshot({ issue: issue({ state: 'closed', assignees: [] }) }),
        workspaceExists: true,
      }),
    );
    expect(out.kind).toBe('cleanup');
  });
});

// --- A5/A6 New ------------------------------------------------------------

describe('New row (§7)', () => {
  it('A5 new issue with slot starts work with derived branch + title', () => {
    const out = reconcile(buildInput());
    expect(out.kind).toBe('start-new');
    if (out.kind === 'start-new') {
      expect(out.branch).toContain('42');
      expect(out.branch).toMatch(/^maestro\/issue-42-/);
      expect(out.mrTitle).toContain('Closes #42');
    }
  });

  it('A6 new issue without slot queues', () => {
    const out = reconcile(buildInput({ slotAvailable: false }));
    expect(out.kind).toBe('none');
  });
});

// --- A7/A8 In-progress ----------------------------------------------------

describe('In-progress row (§7)', () => {
  it('A7 in-progress with slot resumes the agent', () => {
    const out = reconcile(
      buildInput({ snapshot: snapshot({ issue: issue({ labels: [labels.inProgress] }) }) }),
    );
    expect(out.kind).toBe('run-agent');
    if (out.kind === 'run-agent') {
      expect(out.resume).toBe(true);
      expect(out.feedback).toBeUndefined();
    }
  });

  it('A8 in-progress without slot waits', () => {
    const out = reconcile(
      buildInput({
        snapshot: snapshot({ issue: issue({ labels: [labels.inProgress] }) }),
        slotAvailable: false,
      }),
    );
    expect(out.kind).toBe('none');
  });

  it('A9 in-progress + workComplete yields handoff without consuming a slot', () => {
    const out = reconcile(
      buildInput({
        snapshot: snapshot({
          issue: issue({ labels: [labels.inProgress] }),
          mr: mr({ isDraft: true }),
        }),
        slotAvailable: false,
        workComplete: true,
      }),
    );
    expect(out.kind).toBe('handoff');
  });
});

// --- A10–A13 In-review ----------------------------------------------------

describe('In-review row (§7)', () => {
  const inReviewIssue = () => issue({ labels: [labels.inReview] });

  it('A10 approved merges with WORKFLOW git rules', () => {
    const out = reconcile(
      buildInput({
        snapshot: snapshot({
          issue: inReviewIssue(),
          mr: mr({ approvals: approvals({ approved: true }) }),
        }),
      }),
    );
    expect(out.kind).toBe('merge');
    if (out.kind === 'merge') {
      expect(out.strategy).toBe('squash');
      expect(out.deleteSource).toBe(true);
    }
  });

  it('A11 changes-requested re-enters in-progress with feedback from comments', () => {
    const comments: Comment[] = [
      { id: 'c1', author: user('reviewer'), body: 'please fix', createdAt: '2026-06-04T00:00:00Z' },
    ];
    const out = reconcile(
      buildInput({
        snapshot: snapshot({
          issue: inReviewIssue(),
          mr: mr({ approvals: approvals({ changesRequested: true }) }),
          recentComments: comments,
        }),
      }),
    );
    expect(out.kind).toBe('apply-changes-requested');
    if (out.kind === 'apply-changes-requested') {
      expect(out.feedback.reviewComments).toEqual(comments);
    }
  });

  it('A12 pending review just polls', () => {
    const out = reconcile(buildInput({ snapshot: snapshot({ issue: inReviewIssue(), mr: mr() }) }));
    expect(out.kind).toBe('poll-review');
  });

  it('A13 approved takes precedence over stale changes-requested', () => {
    const out = reconcile(
      buildInput({
        snapshot: snapshot({
          issue: inReviewIssue(),
          mr: mr({ approvals: approvals({ approved: true, changesRequested: true }) }),
        }),
      }),
    );
    expect(out.kind).toBe('merge');
  });
});

// --- A14 Blocked ----------------------------------------------------------

describe('Blocked row (§7)', () => {
  it('A14 blocked issue waits for human regardless of slot', () => {
    for (const slotAvailable of [true, false]) {
      const out = reconcile(
        buildInput({
          snapshot: snapshot({ issue: issue({ labels: [labels.blocked] }) }),
          slotAvailable,
        }),
      );
      expect(out.kind).toBe('blocked-wait');
    }
  });
});

// --- A15 label precedence -------------------------------------------------

describe('A15 — deterministic state under conflicting labels', () => {
  it('blocked beats in-review beats in-progress', () => {
    const out = reconcile(
      buildInput({
        snapshot: snapshot({
          issue: issue({ labels: [labels.inProgress, labels.inReview, labels.blocked] }),
        }),
      }),
    );
    expect(out.kind).toBe('blocked-wait');
  });

  it('in-review beats in-progress', () => {
    const out = reconcile(
      buildInput({
        snapshot: snapshot({
          issue: issue({ labels: [labels.inProgress, labels.inReview] }),
          mr: mr(),
        }),
      }),
    );
    expect(out.kind).toBe('poll-review');
  });
});

// --- A16 determinism / idempotency / purity -------------------------------

describe('A16 — determinism, idempotency, purity', () => {
  it('same input yields deep-equal single intent twice and does not mutate input', () => {
    const input = buildInput({
      snapshot: snapshot({ issue: issue({ labels: [labels.inProgress] }) }),
    });
    Object.freeze(input);
    Object.freeze(input.snapshot);
    Object.freeze(input.settings);
    const a = reconcile(input);
    const b = reconcile(input);
    expect(a).toEqual(b);
    expect(Array.isArray(a)).toBe(false);
    expect(input.snapshot.issue.labels).toEqual([labels.inProgress]);
  });

  it('every canonical §7 row yields exactly one expected kind', () => {
    const rows: Array<[ReconcileInput, string]> = [
      [buildInput(), 'start-new'],
      [buildInput({ slotAvailable: false }), 'none'],
      [
        buildInput({ snapshot: snapshot({ issue: issue({ labels: [labels.inProgress] }) }) }),
        'run-agent',
      ],
      [
        buildInput({ snapshot: snapshot({ issue: issue({ labels: [labels.blocked] }) }) }),
        'blocked-wait',
      ],
      [
        buildInput({
          snapshot: snapshot({ issue: issue({ state: 'closed' }) }),
          workspaceExists: true,
        }),
        'cleanup',
      ],
    ];
    for (const [input, kind] of rows) {
      expect(reconcile(input).kind).toBe(kind);
    }
  });
});
