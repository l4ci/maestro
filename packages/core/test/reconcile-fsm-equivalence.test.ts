// Property test (#93): the legacy generalist FSM (`rolesDeclared: false`) is
// equivalent to the role-pipeline FSM (`rolesDeclared: true`) run as a SINGLE-STAGE
// pipeline, across an exhaustively enumerated snapshot grid. Test-only: this file
// pins behavior; it changes nothing in production (CONTEXT.md §Reconciler FSMs).
//
// ## What "pipeline with a single stage" means here
//
// `reconcile()` only sees the boolean `rolesDeclared`, never the role list — the
// pipeline's stages come from ARTIFACTS (deriveStage), not from which `## role:`
// sections exist. So a one-stage workflow is expressed as a premise on the input
// space plus an intent mapping, both grounded in the code/spec:
//
//  1. The definition gate is pre-approved: the HUMAN-set `todo` label is applied at
//     issue creation — the explicit skip-define escape hatch (labels.ts, deriveStage
//     docstring). The `backlog` stage therefore never occurs; inputs violating the
//     premise fall under divergence D3 below.
//  2. Plan and implement collapse into the one generalist role. Hence:
//       - legacy `start-new {branch, mrTitle}` ≅ pipeline `run-plan {branch, mrTitle}`
//         (identical payloads from the same naming helpers; both mean "begin work:
//         create branch + MR, run the agent"), normalized to a common `begin-work`;
//       - the `role` field on `run-agent` / `apply-unblock` is dispatch metadata —
//         with one role there is nothing to dispatch — so it is stripped.
//  3. `none` / `skip-untrusted` reasons are explanatory text, compared by kind only.
//
// ## Confirmed divergences (documented exclusions)
//
// The FSMs are NOT byte-equivalent everywhere. Each divergence below is a deliberate
// design difference (#29), encoded as an input predicate; the test asserts every
// generated input is either intent-equal under the normalization above OR falls in
// exactly one of these zones — and that each zone is actually exercised.
//
//  D1 — completion signal & internal review gate. Legacy trusts the daemon-computed
//      `workComplete` flag and hands off immediately (crash-recovery AM-1). The
//      pipeline ignores the flag and re-derives completion from thread markers,
//      inserting the internal review gate (#29 P3): proof → run-review; only a PASS
//      verdict hands off; a FAIL bounces back to implement. The two agree exactly
//      when the flag and the marker-derived phase say the same thing (no proof ⇒
//      keep implementing; proof + pass ⇒ handoff) — note the daemon couples the
//      flag to the proof marker (`detectWorkComplete`, tick.ts), so on real inputs
//      the divergence is precisely the review gate, not the flag source.
//
//  D2 — queue visibility. Legacy `in-progress` without a slot waits silently
//      (`none`); the pipeline marks every slotless agent stage `queued` (#53/#29),
//      so it emits `mark-queued` until the marker label lands.
//
//  D3 — state source. Legacy state := labels (deriveState); pipeline stage :=
//      artifacts (deriveStage: MR existence/draftness + definition gate). Snapshots
//      where the label-derived state disagrees with the artifact-derived stage
//      (transient mid-handoff windows, manually mangled labels, or the `backlog`
//      stage that the single-stage premise excludes) route to different FSM rows by
//      construction. The daemon's label projections keep real snapshots consistent
//      at fixpoints.
//
// Everything else — terminal/cleanup, trigger guard, blocked modifier (incl. the
// edge-triggered unblock and reply threading), new/todo queueing, the whole
// review:human row (merge / changes-requested / poll) — is asserted strictly equal.
//
// Deterministic by construction: exhaustive enumeration, fixed timestamps, no RNG.

import { describe, expect, it } from 'vitest';
import type {
  ApprovalState,
  Comment,
  ForgeUser,
  Intent,
  Issue,
  IssueSnapshot,
  LifecycleState,
  MergeRequest,
  ReconcileInput,
  RepoRef,
  RepoSettings,
} from '../src/contracts/index.js';
import { DONE_SENTINEL, REVIEW_PASS_SENTINEL } from '../src/contracts/index.js';
import { labelNames } from '../src/contracts/labels.js';
import {
  type Stage,
  analyzeReview,
  deriveStage,
  deriveState,
  reconcile,
} from '../src/reconciler/reconcile.js';

// --- fixed world ------------------------------------------------------------

const BOT = 'maestro-bot';
const REVIEW_FAIL_MARKER = '<!-- maestro:review-fail round=1 -->'; // matches REVIEW_FAIL_RE

const repo: RepoRef = {
  forge: 'gitlab',
  host: 'gitlab.com',
  project: 'group/api',
  url: 'gitlab.com/group/api',
};
const labels = labelNames('gitlab');
const user = (username: string): ForgeUser => ({ username, id: `id-${username}` });

const settings: RepoSettings = {
  repo,
  botUser: BOT,
  trigger: { requireLabel: null, allowedActors: [] },
  git: { defaultBranch: 'main', target: 'main', mergeStrategy: 'squash', deleteSourceBranch: true },
  manageBoard: true,
  labels,
  concurrency: { globalMax: 2, maxActive: 2 },
  ci: { gate: false }, // #118: gate off keeps both FSMs byte-for-byte (inert divergence)
};

// --- input grid dimensions ---------------------------------------------------

const ISSUE_STATES = ['open', 'closed'] as const;
const LIFECYCLE_LABELS = ['none', 'in-progress', 'in-review'] as const; // blocked is its own axis
const BOOLS = [false, true] as const;

type MrVariant = { name: string; build: () => MergeRequest | undefined };
const approvalGrid: Array<[string, Partial<ApprovalState>]> = [
  ['no-signal', {}],
  ['approved', { approved: true }],
  ['changes-requested', { changesRequested: true }],
  ['approved+changes', { approved: true, changesRequested: true }],
];
const MR_VARIANTS: MrVariant[] = [
  { name: 'no-mr', build: () => undefined },
  ...BOOLS.flatMap((ready) =>
    approvalGrid.map(
      ([apName, ap]): MrVariant => ({
        name: `${ready ? 'ready' : 'draft'}/${apName}`,
        build: () => ({
          iid: 7,
          id: 'gid-mr-7',
          title: 'Add OAuth login (Closes #42)',
          description: '- [ ] step one',
          state: 'opened',
          isDraft: !ready,
          sourceBranch: 'maestro/issue-42-add-oauth-login',
          targetBranch: 'main',
          assignees: [user(BOT)],
          labels: [],
          approvals: { approved: false, approvedBy: [], changesRequested: false, ...ap },
          webUrl: 'https://gitlab.com/group/api/-/merge_requests/7',
        }),
      }),
    ),
  ),
];

const botC = (body: string, createdAt: string): Comment => ({
  id: `b-${createdAt}`,
  author: user(BOT),
  body,
  createdAt,
});
const humanC = (body: string, createdAt: string): Comment => ({
  id: `h-${createdAt}`,
  author: user('reporter'),
  body,
  createdAt,
});
const T = (n: number) => `2026-06-05T1${n}:00:00Z`;

/** Newest-first, covering: block marker / reply-after / reply-before (edge-trigger),
 *  proof / fail / pass / bounce / human-resets-rounds (the timeout-bounce paths). */
const COMMENT_SCENARIOS: Array<{ name: string; comments: Comment[] }> = [
  { name: 'empty', comments: [] },
  { name: 'block-marker', comments: [botC('blocked: which db?', T(1))] },
  {
    name: 'reply-after-block',
    comments: [humanC('use postgres', T(2)), botC('blocked: which db?', T(1))],
  },
  {
    name: 'reply-before-block',
    comments: [botC('blocked: which db?', T(2)), humanC('some context', T(1))],
  },
  { name: 'proof', comments: [botC(`proof ok ${DONE_SENTINEL}`, T(1))] },
  {
    name: 'proof-fail',
    comments: [
      botC(`findings ${REVIEW_FAIL_MARKER}`, T(2)),
      botC(`proof ok ${DONE_SENTINEL}`, T(1)),
    ],
  },
  {
    name: 'proof-pass',
    comments: [botC(`lgtm ${REVIEW_PASS_SENTINEL}`, T(2)), botC(`proof ok ${DONE_SENTINEL}`, T(1))],
  },
  {
    name: 'proof-bounce',
    comments: [
      botC(`proof again ${DONE_SENTINEL}`, T(3)),
      botC(`findings ${REVIEW_FAIL_MARKER}`, T(2)),
      botC(`proof ok ${DONE_SENTINEL}`, T(1)),
    ],
  },
  { name: 'human-only', comments: [humanC('drive-by thought', T(1))] },
  {
    name: 'human-resets-rounds',
    comments: [
      botC(`proof again ${DONE_SENTINEL}`, T(4)),
      humanC('right direction', T(3)),
      botC(`findings ${REVIEW_FAIL_MARKER}`, T(2)),
      botC(`proof ok ${DONE_SENTINEL}`, T(1)),
    ],
  },
];

interface GridCase {
  desc: string;
  input: Omit<ReconcileInput, 'rolesDeclared'>;
}

function* enumerateGrid(): Generator<GridCase> {
  for (const issueState of ISSUE_STATES)
    for (const lifecycle of LIFECYCLE_LABELS)
      for (const blocked of BOOLS)
        for (const todo of BOOLS)
          for (const queued of BOOLS)
            for (const mrVariant of MR_VARIANTS)
              for (const cs of COMMENT_SCENARIOS)
                for (const assigned of BOOLS)
                  for (const slotAvailable of BOOLS)
                    for (const workspaceExists of BOOLS)
                      for (const workComplete of BOOLS) {
                        const issueLabels: string[] = [];
                        if (lifecycle === 'in-progress') issueLabels.push(labels.inProgress);
                        if (lifecycle === 'in-review') issueLabels.push(labels.inReview);
                        if (blocked) issueLabels.push(labels.blocked);
                        if (todo) issueLabels.push(labels.todo);
                        if (queued) issueLabels.push(labels.queued);
                        const issue: Issue = {
                          iid: 42,
                          id: 'gid-42',
                          title: 'Add OAuth login',
                          body: 'please add oauth',
                          state: issueState,
                          assignees: assigned ? [user(BOT)] : [user('someone-else')],
                          labels: issueLabels,
                          author: user('reporter'),
                          webUrl: 'https://gitlab.com/group/api/-/issues/42',
                        };
                        const snapshot: IssueSnapshot = {
                          repo,
                          issue,
                          mr: mrVariant.build(),
                          recentComments: cs.comments,
                        };
                        yield {
                          desc:
                            `state=${issueState} lifecycle=${lifecycle} blocked=${blocked} ` +
                            `todo=${todo} queued=${queued} mr=${mrVariant.name} ` +
                            `comments=${cs.name} assigned=${assigned} slot=${slotAvailable} ` +
                            `ws=${workspaceExists} wc=${workComplete}`,
                          input: {
                            snapshot,
                            settings,
                            slotAvailable,
                            workspaceExists,
                            workComplete,
                          },
                        };
                      }
}

const EXPECTED_TOTAL =
  ISSUE_STATES.length *
  LIFECYCLE_LABELS.length *
  2 * // blocked
  2 * // todo
  2 * // queued
  MR_VARIANTS.length *
  COMMENT_SCENARIOS.length *
  2 * // assigned
  2 * // slot
  2 * // workspace
  2; // workComplete

// --- single-stage normalization ----------------------------------------------

/** Single-stage intent normalization (interpretation points 2–3 above). */
function normalize(intent: Intent): unknown {
  switch (intent.kind) {
    case 'none':
      return { kind: 'none' }; // reasons are explanatory text
    case 'skip-untrusted':
      return { kind: 'skip-untrusted' };
    case 'start-new':
      return { kind: 'begin-work', branch: intent.branch, mrTitle: intent.mrTitle };
    case 'run-plan':
      return { kind: 'begin-work', branch: intent.branch, mrTitle: intent.mrTitle };
    case 'run-agent':
      return { kind: 'run-agent', resume: intent.resume, feedback: intent.feedback ?? null };
    case 'apply-unblock':
      return { kind: 'apply-unblock', feedback: intent.feedback };
    default:
      return intent;
  }
}

// --- divergence zones ----------------------------------------------------------

/** Legacy lifecycle state → the pipeline stage it corresponds to under the
 *  single-stage premise (`new` lands on `todo` because the definition gate is
 *  pre-approved at creation; `blocked` is a modifier handled before stages on
 *  both sides and never reaches this map). */
const STATE_TO_STAGE: Partial<Record<LifecycleState, Stage>> = {
  new: 'todo',
  'in-progress': 'in-progress',
  'in-review': 'review:human',
  done: 'done',
};

type Zone = 'D1' | 'D2' | 'D3';

function divergenceZone(input: Omit<ReconcileInput, 'rolesDeclared'>): Zone | null {
  const { snapshot } = input;
  if (snapshot.issue.state === 'closed') return null; // terminal handled before the fork
  const state = deriveState(snapshot, settings);
  if (state === 'blocked') return null; // blocked modifier is shared logic on both sides
  const stage = deriveStage(snapshot, settings);
  if (STATE_TO_STAGE[state] !== stage) return 'D3'; // label state ≠ artifact stage
  if (state !== 'in-progress') return null; // new/todo and in-review/review:human rows agree
  const { phase } = analyzeReview(snapshot, settings);
  const wc = input.workComplete;
  // D1: the flag and the marker-derived phase disagree on "is the work complete",
  // or the phase is review-due (the gate legacy simply does not have).
  if (wc !== (phase === 'passed') || phase === 'review-due') return 'D1';
  // D2: both still implementing, but no slot — legacy waits silently, pipeline queues.
  if (
    !wc &&
    phase === 'implementing' &&
    !input.slotAvailable &&
    !snapshot.issue.labels.includes(labels.queued)
  ) {
    return 'D2';
  }
  return null;
}

/** Per-zone envelopes: loose kind sets so a zone can never silently absorb an
 *  unrelated behavior change. D3 spans arbitrary row pairs, so no envelope. */
const ZONE_ENVELOPE: Record<Zone, { legacy: string[]; pipeline: string[] } | null> = {
  D1: {
    legacy: ['handoff', 'run-agent', 'none'],
    pipeline: ['handoff', 'run-agent', 'run-review', 'mark-queued', 'none'],
  },
  D2: { legacy: ['none'], pipeline: ['mark-queued'] },
  D3: null,
};

// --- the property ----------------------------------------------------------------

describe('#93 — legacy FSM ≡ one-stage role pipeline (property over the input grid)', () => {
  it('every generated input is intent-equal under single-stage normalization, or falls in a documented divergence zone', () => {
    const counts: Record<'equal' | Zone, number> = { equal: 0, D1: 0, D2: 0, D3: 0 };
    const undocumented: string[] = [];
    const outOfEnvelope: string[] = [];
    let total = 0;

    for (const { desc, input } of enumerateGrid()) {
      total++;
      const legacy = reconcile({ ...input, rolesDeclared: false });
      const pipeline = reconcile({ ...input, rolesDeclared: true });

      if (JSON.stringify(normalize(legacy)) === JSON.stringify(normalize(pipeline))) {
        counts.equal++;
        continue;
      }
      const zone = divergenceZone(input);
      if (zone === null) {
        undocumented.push(`${desc} :: legacy=${legacy.kind} pipeline=${pipeline.kind}`);
        continue;
      }
      counts[zone]++;
      const envelope = ZONE_ENVELOPE[zone];
      if (
        envelope &&
        !(envelope.legacy.includes(legacy.kind) && envelope.pipeline.includes(pipeline.kind))
      ) {
        outOfEnvelope.push(`${zone} ${desc} :: legacy=${legacy.kind} pipeline=${pipeline.kind}`);
      }
    }

    // The equivalence claim: NO divergence outside the three documented zones.
    expect(
      undocumented,
      `undocumented divergences (first 20 of ${undocumented.length}):\n${undocumented
        .slice(0, 20)
        .join('\n')}`,
    ).toEqual([]);
    expect(
      outOfEnvelope,
      `zone envelope violations (first 20 of ${outOfEnvelope.length}):\n${outOfEnvelope
        .slice(0, 20)
        .join('\n')}`,
    ).toEqual([]);

    // Grid wiring guard: a broken dimension loop must not silently shrink coverage.
    expect(total).toBe(EXPECTED_TOTAL);
    // Anti-rot: the equivalence domain and every documented zone are actually exercised.
    expect(counts.equal).toBeGreaterThan(0);
    expect(counts.D1).toBeGreaterThan(0);
    expect(counts.D2).toBeGreaterThan(0);
    expect(counts.D3).toBeGreaterThan(0);
  });

  it('blocked is shared logic: any blocked input is intent-equal modulo the role field', () => {
    // Sub-property pinning the strongest agreement: the blocked modifier path never
    // diverges, whatever the rest of the snapshot looks like.
    for (const { desc, input } of enumerateGrid()) {
      if (input.snapshot.issue.state === 'closed') continue;
      if (!input.snapshot.issue.labels.includes(labels.blocked)) continue;
      const legacy = reconcile({ ...input, rolesDeclared: false });
      const pipeline = reconcile({ ...input, rolesDeclared: true });
      expect(JSON.stringify(normalize(legacy)), desc).toBe(JSON.stringify(normalize(pipeline)));
    }
  });
});
