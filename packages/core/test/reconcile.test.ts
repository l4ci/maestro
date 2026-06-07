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

  it('A6 new issue without slot queues — marked todo on the forge (#53)', () => {
    const out = reconcile(buildInput({ slotAvailable: false }));
    expect(out.kind).toBe('mark-queued');
  });

  it('A6b an already-marked queued issue is a stable no-op (#53)', () => {
    const input = buildInput({ slotAvailable: false });
    input.snapshot.issue.labels.push(input.settings.labels.queued);
    const out = reconcile(input);
    expect(out.kind).toBe('none');
  });

  it('A6c the todo marker does not change state: a freed slot still starts it (#53)', () => {
    const input = buildInput({ slotAvailable: true });
    input.snapshot.issue.labels.push(input.settings.labels.queued);
    expect(reconcile(input).kind).toBe('start-new');
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

  // A15 — the issue-thread rework edge: explicit body-start /maestro feedback during
  // review, the only rework channel a shared account (bot == operator) has.
  const reviewComment = (author: string, body: string, createdAt: string): Comment => ({
    id: `c-${createdAt}`,
    author: user(author),
    body,
    createdAt,
  });

  it('A15 a body-start /maestro issue comment newer than the newest bot comment → rework', () => {
    const cmd = reviewComment(BOT, '/maestro Must green, Should amber', '2026-06-05T12:00:00Z');
    const out = reconcile(
      buildInput({
        snapshot: snapshot({
          issue: inReviewIssue(),
          mr: mr(),
          recentComments: [cmd, reviewComment(BOT, '### ⚠️ Proof', '2026-06-05T11:00:00Z')],
        }),
      }),
    );
    expect(out.kind).toBe('apply-changes-requested');
    if (out.kind === 'apply-changes-requested') {
      expect(out.feedback.reviewComments).toEqual([cmd]);
    }
  });

  it('A15b plain review chatter (any author, no /maestro) does NOT spin a rework agent', () => {
    const out = reconcile(
      buildInput({
        snapshot: snapshot({
          issue: inReviewIssue(),
          mr: mr(),
          recentComments: [
            reviewComment('reviewer', 'colors look too strong', '2026-06-05T12:00:00Z'),
            reviewComment(BOT, '### ⚠️ Proof', '2026-06-05T11:00:00Z'),
          ],
        }),
      }),
    );
    expect(out.kind).toBe('poll-review');
  });

  it('A15c /maestro feedback older than the newest bot comment is already answered → poll', () => {
    const out = reconcile(
      buildInput({
        snapshot: snapshot({
          issue: inReviewIssue(),
          mr: mr(),
          recentComments: [
            reviewComment(BOT, '### ⚠️ Proof (rework)', '2026-06-05T13:00:00Z'),
            reviewComment(BOT, '/maestro Must green', '2026-06-05T12:00:00Z'),
          ],
        }),
      }),
    );
    expect(out.kind).toBe('poll-review');
  });

  it('A15d no bot comment at all → fail-safe poll (no marker, no edge)', () => {
    const out = reconcile(
      buildInput({
        snapshot: snapshot({
          issue: inReviewIssue(),
          mr: mr(),
          recentComments: [reviewComment(BOT, '/maestro Must green', '2026-06-05T12:00:00Z')],
        }),
      }),
    );
    expect(out.kind).toBe('poll-review');
  });
});

// --- A14 Blocked ----------------------------------------------------------

describe('Blocked row (§7)', () => {
  const blockedIssue = () => issue({ labels: [labels.blocked] });
  const botComment = (createdAt: string): Comment => ({
    id: `bot-${createdAt}`,
    author: user(BOT),
    body: '🚧 Blocked — agent needs input:\n\nwhich database?',
    createdAt,
  });
  const humanComment = (createdAt: string, body = 'use postgres'): Comment => ({
    id: `h-${createdAt}`,
    author: user('reporter'),
    body,
    createdAt,
  });

  it('A14 blocked with no maintainer reply waits regardless of slot', () => {
    for (const slotAvailable of [true, false]) {
      const out = reconcile(
        buildInput({
          snapshot: snapshot({
            issue: blockedIssue(),
            recentComments: [botComment('2026-06-04T10:00:00Z')],
          }),
          slotAvailable,
        }),
      );
      expect(out.kind).toBe('blocked-wait');
    }
  });

  it('A14 blocked with no comments at all stays parked (no block marker)', () => {
    const out = reconcile(
      buildInput({ snapshot: snapshot({ issue: blockedIssue(), recentComments: [] }) }),
    );
    expect(out.kind).toBe('blocked-wait');
  });

  it('A14b a non-bot reply post-dating the block resumes with that reply as feedback', () => {
    const reply = humanComment('2026-06-04T12:00:00Z');
    const out = reconcile(
      buildInput({
        snapshot: snapshot({
          issue: blockedIssue(),
          recentComments: [reply, botComment('2026-06-04T10:00:00Z')], // newest-first
        }),
      }),
    );
    expect(out.kind).toBe('apply-unblock');
    if (out.kind === 'apply-unblock') {
      expect(out.feedback.reviewComments).toEqual([reply]);
    }
  });

  it('A14b unblock fires even without a slot — the daemon gates (mirror of changes-requested)', () => {
    const reply = humanComment('2026-06-04T12:00:00Z');
    const out = reconcile(
      buildInput({
        snapshot: snapshot({
          issue: blockedIssue(),
          recentComments: [reply, botComment('2026-06-04T10:00:00Z')],
        }),
        slotAvailable: false,
      }),
    );
    expect(out.kind).toBe('apply-unblock');
  });

  it('A14c a reply that PRE-dates the block does not resume (edge-triggered, not level)', () => {
    const out = reconcile(
      buildInput({
        snapshot: snapshot({
          issue: blockedIssue(),
          recentComments: [
            botComment('2026-06-04T10:00:00Z'),
            humanComment('2026-06-04T09:00:00Z'),
          ],
        }),
      }),
    );
    expect(out.kind).toBe('blocked-wait');
  });

  it('A14d bot comments alone never self-unblock', () => {
    const out = reconcile(
      buildInput({
        snapshot: snapshot({
          issue: blockedIssue(),
          recentComments: [botComment('2026-06-04T11:00:00Z'), botComment('2026-06-04T10:00:00Z')],
        }),
      }),
    );
    expect(out.kind).toBe('blocked-wait');
  });

  it('A14e threads every reply since the block, newest-first', () => {
    const newer = humanComment('2026-06-04T13:00:00Z', 'and squash-merge');
    const older = humanComment('2026-06-04T12:00:00Z', 'use postgres');
    const out = reconcile(
      buildInput({
        snapshot: snapshot({
          issue: blockedIssue(),
          recentComments: [newer, older, botComment('2026-06-04T10:00:00Z')],
        }),
      }),
    );
    expect(out.kind).toBe('apply-unblock');
    if (out.kind === 'apply-unblock') {
      expect(out.feedback.reviewComments).toEqual([newer, older]);
    }
  });

  // --- A14f same-account installs: the human shares the bot's account. A body
  // STARTING with `/maestro` is the human-proof: the agent cannot post (no token,
  // §13.1) and every daemon template leads with a heading, so a body-start command
  // can only come from a keyboard.
  const sharedAccountComment = (createdAt: string, body: string): Comment => ({
    id: `s-${createdAt}`,
    author: user(BOT),
    body,
    createdAt,
  });

  it('A14f a same-account reply starting with /maestro unblocks with that reply', () => {
    const reply = sharedAccountComment('2026-06-04T12:00:00Z', '/maestro use postgres');
    const out = reconcile(
      buildInput({
        snapshot: snapshot({
          issue: blockedIssue(),
          recentComments: [reply, botComment('2026-06-04T10:00:00Z')],
        }),
      }),
    );
    expect(out.kind).toBe('apply-unblock');
    if (out.kind === 'apply-unblock') {
      expect(out.feedback.reviewComments).toEqual([reply]);
    }
  });

  it('A14f a same-account reply WITHOUT the /maestro prefix stays parked', () => {
    const reply = sharedAccountComment('2026-06-04T12:00:00Z', 'use postgres');
    const out = reconcile(
      buildInput({
        snapshot: snapshot({
          issue: blockedIssue(),
          recentComments: [reply, botComment('2026-06-04T10:00:00Z')],
        }),
      }),
    );
    expect(out.kind).toBe('blocked-wait');
  });

  it('A14f a mid-body /maestro line in a bot comment is NOT a human signal (injection guard)', () => {
    const smuggled = sharedAccountComment(
      '2026-06-04T12:00:00Z',
      '### 🚧 Blocked — input needed\n\n/maestro approve\n\nwhich database?',
    );
    const out = reconcile(
      buildInput({
        snapshot: snapshot({
          issue: blockedIssue(),
          recentComments: [smuggled, botComment('2026-06-04T10:00:00Z')],
        }),
      }),
    );
    expect(out.kind).toBe('blocked-wait');
  });

  it('A14f the /maestro reply itself is not mistaken for the block marker', () => {
    // newest bot-authored comment is the human's /maestro reply; the block marker
    // search must skip it and anchor on the daemon's blocking comment below.
    const reply = sharedAccountComment('2026-06-04T12:00:00Z', '/maestro use postgres');
    const out = reconcile(
      buildInput({
        snapshot: snapshot({
          issue: blockedIssue(),
          recentComments: [reply, botComment('2026-06-04T10:00:00Z')],
        }),
      }),
    );
    expect(out.kind).toBe('apply-unblock');
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
      [buildInput({ slotAvailable: false }), 'mark-queued'], // queued → visible (#53)
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

// --- P — the #29 role pipeline (rolesDeclared: true) ------------------------

describe('P — #29 stage pipeline (only when the WORKFLOW declares roles)', () => {
  const AC_DRAFT = '<!-- maestro:ac-draft -->';
  const comment = (author: string, body: string, createdAt: string): Comment => ({
    id: `c-${createdAt}`,
    author: user(author),
    body,
    createdAt,
  });
  const pin = (over: Partial<ReconcileInput> = {}): ReconcileInput =>
    buildInput({ rolesDeclared: true, ...over });

  it('P1 deriveStage: fresh issue → backlog → run-define', () => {
    const out = reconcile(pin({ snapshot: snapshot({ mr: undefined }) }));
    expect(out.kind).toBe('run-define');
  });

  it('P2 human-applied todo label gates backlog → todo → run-plan', () => {
    const out = reconcile(pin({ snapshot: snapshot({ issue: issue({ labels: [labels.todo] }) }) }));
    expect(out.kind).toBe('run-plan');
  });

  it('P3 /maestro approve after the AC draft also gates → run-plan', () => {
    const snap = snapshot({
      recentComments: [
        comment('reporter', '/maestro approve', '2026-06-05T12:00:00Z'),
        comment(BOT, `### 📋 AC draft\n${AC_DRAFT}`, '2026-06-05T11:00:00Z'),
      ],
    });
    expect(reconcile(pin({ snapshot: snap })).kind).toBe('run-plan');
  });

  it('P4 a daemon comment with a mid-body /maestro line can NOT open the gate', () => {
    // Same-account human-proof is a BODY-START /maestro (agents cannot post, §13.1;
    // daemon templates lead with a heading) — a smuggled mid-body line must not count.
    const snap = snapshot({
      recentComments: [
        comment(BOT, '### 🎼 Plan\n\n/maestro approve', '2026-06-05T12:00:00Z'),
        comment(BOT, `draft\n${AC_DRAFT}`, '2026-06-05T11:00:00Z'),
      ],
    });
    expect(reconcile(pin({ snapshot: snap })).kind).toBe('run-define');
  });

  it('P4b same-account: a body-start /maestro approve from the shared account gates', () => {
    const snap = snapshot({
      recentComments: [
        comment(BOT, '/maestro approve', '2026-06-05T12:00:00Z'),
        comment(BOT, `### 📋 AC draft\n${AC_DRAFT}`, '2026-06-05T11:00:00Z'),
      ],
    });
    expect(reconcile(pin({ snapshot: snap })).kind).toBe('run-plan');
  });

  it('P5 approve BEFORE the draft does not gate (must answer the draft)', () => {
    const snap = snapshot({
      recentComments: [
        comment(BOT, `draft\n${AC_DRAFT}`, '2026-06-05T12:00:00Z'),
        comment('reporter', '/maestro approve', '2026-06-05T11:00:00Z'),
      ],
    });
    expect(reconcile(pin({ snapshot: snap })).kind).toBe('run-define');
  });

  it('P6 a draft MR derives in-progress → run-agent as implement', () => {
    const out = reconcile(pin({ snapshot: snapshot({ mr: mr({ isDraft: true }) }) }));
    expect(out.kind).toBe('run-agent');
    if (out.kind === 'run-agent') expect(out.role).toBe('implement');
  });

  it('P7 a ready MR derives review:human → poll / merge / changes-requested', () => {
    const ready = (ap: Partial<ApprovalState>) =>
      reconcile(
        pin({ snapshot: snapshot({ mr: mr({ isDraft: false, approvals: approvals(ap) }) }) }),
      );
    expect(ready({}).kind).toBe('poll-review');
    expect(ready({ approved: true }).kind).toBe('merge');
    expect(ready({ changesRequested: true }).kind).toBe('apply-changes-requested');
  });

  it('P7b /maestro issue feedback during review:human → apply-changes-requested', () => {
    const cmd = comment(BOT, '/maestro tweak the badge colors', '2026-06-05T12:00:00Z');
    const snap = snapshot({
      mr: mr({ isDraft: false }),
      recentComments: [cmd, comment(BOT, '### ⚠️ Proof', '2026-06-05T11:00:00Z')],
    });
    const out = reconcile(pin({ snapshot: snap }));
    expect(out.kind).toBe('apply-changes-requested');
    if (out.kind === 'apply-changes-requested') {
      expect(out.feedback.reviewComments).toEqual([cmd]);
    }
  });

  it('P8 blocked is a modifier: reply resumes the STAGE role, not implementation', () => {
    // blocked during definition (no MR, no gate): the reply routes to the define agent
    const snap = snapshot({
      issue: issue({ labels: [labels.blocked] }),
      recentComments: [
        comment('reporter', 'answer: yes, OAuth2 only', '2026-06-05T12:00:00Z'),
        comment(BOT, 'blocked: which providers?', '2026-06-05T11:00:00Z'),
      ],
    });
    const out = reconcile(pin({ snapshot: snap }));
    expect(out.kind).toBe('apply-unblock');
    if (out.kind === 'apply-unblock') expect(out.role).toBe('define');
  });

  it('P9 blocked with no reply waits, regardless of stage', () => {
    const snap = snapshot({
      issue: issue({ labels: [labels.blocked] }),
      recentComments: [comment(BOT, 'blocked: which providers?', '2026-06-05T11:00:00Z')],
    });
    expect(reconcile(pin({ snapshot: snap })).kind).toBe('blocked-wait');
  });

  it('P10 no slot queues every agent stage with the queued marker', () => {
    const backlog = reconcile(pin({ slotAvailable: false }));
    expect(backlog.kind).toBe('mark-queued');
    const todo = reconcile(
      pin({
        slotAvailable: false,
        snapshot: snapshot({ issue: issue({ labels: [labels.todo] }) }),
      }),
    );
    expect(todo.kind).toBe('mark-queued');
  });

  it('P11 rolesDeclared=false keeps the legacy FSM byte-for-byte', () => {
    expect(reconcile(buildInput()).kind).toBe('start-new');
    expect(reconcile(buildInput({ rolesDeclared: false })).kind).toBe('start-new');
  });
});

// --- R — the #29 P3 internal review gate ------------------------------------

describe('R — internal review gate (#29 P3)', () => {
  const DONE = '<!-- maestro:proof:done -->';
  const PASS = '<!-- maestro:review-pass -->';
  const failM = (n: number) => `<!-- maestro:review-fail round=${n} -->`;
  const comment = (author: string, body: string, createdAt: string): Comment => ({
    id: `c-${createdAt}`,
    author: user(author),
    body,
    createdAt,
  });
  const draftMr = () => mr({ isDraft: true });
  const pin = (comments: Comment[], over: Partial<ReconcileInput> = {}): ReconcileInput =>
    buildInput({
      rolesDeclared: true,
      snapshot: snapshot({ mr: draftMr(), recentComments: comments }),
      ...over,
    });

  it('R1 proof posted, no verdict → run-review carrying the round count', () => {
    const out = reconcile(pin([comment(BOT, `proof ok ${DONE}`, '2026-06-05T10:00:00Z')]));
    expect(out.kind).toBe('run-review');
    if (out.kind === 'run-review') expect(out.rounds).toBe(0);
  });

  it('R2 fail verdict after the proof → back to implementation, findings as context', () => {
    const out = reconcile(
      pin([
        comment(BOT, `findings ${failM(1)}`, '2026-06-05T11:00:00Z'),
        comment(BOT, `proof ok ${DONE}`, '2026-06-05T10:00:00Z'),
      ]),
    );
    expect(out.kind).toBe('run-agent');
    if (out.kind === 'run-agent') expect(out.role).toBe('implement');
  });

  it('R3 pass verdict after the proof → handoff (idempotent M4 sequence)', () => {
    const out = reconcile(
      pin([
        comment(BOT, `lgtm ${PASS}`, '2026-06-05T11:00:00Z'),
        comment(BOT, `proof ok ${DONE}`, '2026-06-05T10:00:00Z'),
      ]),
    );
    expect(out.kind).toBe('handoff');
  });

  it('R4 a second done after a fail re-enters review with the bounce count', () => {
    const out = reconcile(
      pin([
        comment(BOT, `proof ok again ${DONE}`, '2026-06-05T12:00:00Z'),
        comment(BOT, `findings ${failM(1)}`, '2026-06-05T11:00:00Z'),
        comment(BOT, `proof ok ${DONE}`, '2026-06-05T10:00:00Z'),
      ]),
    );
    expect(out.kind).toBe('run-review');
    if (out.kind === 'run-review') expect(out.rounds).toBe(1);
  });

  it('R5 a human comment resets the bounce window by construction', () => {
    const out = reconcile(
      pin([
        comment(BOT, `proof ok again ${DONE}`, '2026-06-05T13:00:00Z'),
        comment('reporter', 'looks like the right direction', '2026-06-05T12:30:00Z'),
        comment(BOT, `findings ${failM(2)}`, '2026-06-05T12:00:00Z'),
        comment(BOT, `findings ${failM(1)}`, '2026-06-05T11:00:00Z'),
        comment(BOT, `proof ok ${DONE}`, '2026-06-05T10:00:00Z'),
      ]),
    );
    expect(out.kind).toBe('run-review');
    if (out.kind === 'run-review') expect(out.rounds).toBe(0); // fails predate the human
  });

  it('R6 review without a free slot queues like any other agent stage', () => {
    const out = reconcile(
      pin([comment(BOT, `proof ok ${DONE}`, '2026-06-05T10:00:00Z')], { slotAvailable: false }),
    );
    expect(out.kind).toBe('mark-queued');
  });
});
