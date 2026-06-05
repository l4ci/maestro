// I1 — canonical end-to-end vertical slice (spec §15/§16). The HEADLINE exit item: one
// GitLab repo, one assigned issue, driven New→Done. OPT-IN, gated by MAESTRO_E2E=1;
// SKIPPED in the default `pnpm test` path (it touches gitlab.com and runs the real
// `claude` agent). This is the ONLY place real I/O runs — real GitLab adapter (M2), real
// ClaudeRunner (M3), real workspace + proof + handoff (M4) — driven by the real tick
// orchestrator (M5) a bounded number of times via the test harness (helpers/e2e.ts).
//
// WHY this exists (#7): controlled live runs only ever exercised resume + needs_input +
// blocked for the *bootstrap* issue. The NORMAL lifecycle was unproven against a live
// forge + agent: proof generation, handoff (proof → assign → un-draft → in-review),
// merge-on-approval, and the changes-requested loop. This suite closes that gap.
//
// Scratch-project setup (throwaway, torn down after):
//   1. A scratch GitLab project committing a WORKFLOW.md with `proof.type: diff-summary`
//      (keeps Chromium/RAM out of the run; the playwright proof path is covered by M4
//      unit tests). Drop it at <MAESTRO_WORKFLOWS_DIR>/<repo-slug>/WORKFLOW.md.
//   2. maestro.config.yaml listing that one repo + the gitlab forge token_env.
//   3. A human assigns a prepared issue to bot_user (the New issue this drives).
//   4. A SECOND GitLab account (NOT the bot — GitLab forbids self-approval) whose token
//      drives the reviewer edges; without it the suite WAITS for a human to approve /
//      request changes by hand (the "fully automated except the human approval" mode).
//
// Run (fully automated):
//   MAESTRO_E2E=1 \
//   MAESTRO_GITLAB_TOKEN=glpat-...            # bot token (token_env in the config) \
//   MAESTRO_E2E_REVIEWER_TOKEN=glpat-...      # a DIFFERENT account's token \
//   MAESTRO_E2E_CONFIG=/path/to/maestro.config.yaml \
//   MAESTRO_WORKFLOWS_DIR=/path/to/workflows \
//   MAESTRO_E2E_ISSUE=1                        # the prepared New issue iid \
//   pnpm test daemon-e2e.integration
//
// This is the spec's "canonical end-to-end test" (§15). It is opt-in, NOT part of CI's
// default gate (CI runs typecheck + unit + lint per M0 §0.11): with MAESTRO_E2E unset the
// whole suite is SKIPPED, so no default run hits gitlab.com or spawns the agent.

import { describe, expect, it } from 'vitest';
import { DONE_SENTINEL } from '../src/index.js';
import {
  type E2EHarness,
  buildHarness,
  gitlabReviewer,
  resolveIssueIid,
  reviewerEnabled,
} from './helpers/e2e.js';

const ENABLED = process.env.MAESTRO_E2E === '1';

// Print a reviewer instruction when no reviewer token is configured — the caller then
// polls (without ticking) for the human's action: the "fully automated except the human
// approval" fallback (§15). `h`/`iid` are accepted so the log can name the issue.
function awaitHuman(h: E2EHarness, iid: number, instruction: string): void {
  console.log(`\n>>> ACTION NEEDED on ${h.repo.project} issue #${iid}: ${instruction}\n`);
}

describe.runIf(ENABLED)('M5 E2E — New→Done vertical slice (scratch GitLab project)', () => {
  it(
    'drives one issue New→in-progress→handoff→in-review→changes-requested→in-review→merge→Done→evicted',
    async () => {
      const h = buildHarness();
      const { inReview } = h.settings.labels;
      const iid = await resolveIssueIid(h);
      const reviewer = reviewerEnabled() ? gitlabReviewer(h.repo) : null;

      // 1+2. New → in-progress → agent done → handoff → in-review. The whole New→handoff
      //   runs INSIDE one awaited tick (the agent runs synchronously within it), so the
      //   transient in-progress label isn't observable by between-tick polling — we drive
      //   straight to in-review and assert on the durable artifacts it leaves behind:
      //   branch + draft-then-undrafted MR (Closes #N), the "started" comment, the proof
      //   comment, and the reviewer assignment (the §7 ordering guarantee: proof is posted
      //   BEFORE the assignee is set, which is the FINAL handoff step).
      const review = await h.driveUntil(
        iid,
        'New → agent done → handoff → in-review',
        (s) => s.issue.labels.includes(inReview) && s.mr?.isDraft === false,
      );
      expect(h.observed[0]).toBe('new'); // genuinely started from New
      expect(review.mr).toBeDefined();
      expect(review.mr?.sourceBranch).toContain(`maestro/issue-${iid}-`);
      expect(review.mr?.description).toContain(`Closes #${iid}`);
      expect(review.mr?.isDraft).toBe(false);
      expect(review.issue.labels).toContain(inReview);
      expect(review.recentComments.some((c) => c.body.includes('maestro started work'))).toBe(true);
      // Proof comment carries the crash-recovery sentinel; it lands on the issue thread.
      expect(review.recentComments.some((c) => c.body.includes(DONE_SENTINEL))).toBe(true);
      // Reviewer is the ticket creator.
      expect(review.mr?.assignees.some((a) => a.username === review.issue.author.username)).toBe(
        true,
      );

      const mrIid = review.mr?.iid;
      expect(mrIid).toBeDefined();
      if (mrIid === undefined) return;

      // 3. Changes-requested loop. A reviewer opens an unresolved blocking thread; the daemon
      //    flips in-review → in-progress, threads the feedback to the agent, re-runs it, and on
      //    the new `done` hands back to in-review. We prove the loop via the changesRequested
      //    EDGE: it goes true (thread post-dates the last bot push), then clears to false — and
      //    it can ONLY clear because the re-run pushed a fresh bot commit past the thread.
      if (reviewer) await reviewer.requestChanges(mrIid, 'Please adjust: tighten the summary.');
      else awaitHuman(h, iid, `Open an unresolved thread on MR !${mrIid} requesting a change`);
      // Wait (no ticking) for the reviewer's edge to register, lest a tick consume it first.
      const cr = await h.pollUntil(
        iid,
        'changes-requested edge registered',
        (s) => s.mr?.approvals.changesRequested === true,
      );
      expect(cr.mr?.approvals.changesRequested).toBe(true);
      // Now drive: the daemon re-runs the agent and pushes, clearing the edge → back to in-review.
      const reReviewed = await h.driveUntil(
        iid,
        'changes-requested → re-run → in-review again',
        (s) =>
          s.issue.labels.includes(inReview) &&
          s.mr?.isDraft === false &&
          s.mr?.approvals.changesRequested === false,
      );
      expect(reReviewed.mr?.approvals.changesRequested).toBe(false);

      // 4. Approve → merge per the repo's git rules → issue auto-closes via `Closes #N` (Done).
      const finalMrIid = reReviewed.mr?.iid ?? mrIid;
      if (reviewer) await reviewer.approve(finalMrIid);
      else awaitHuman(h, iid, `Approve MR !${finalMrIid}`);
      // Wait (no ticking) for the approval to register, then drive the merge.
      await h.pollUntil(iid, 'approval registered', (s) => s.mr?.approvals.approved === true);
      const done = await h.driveUntil(
        iid,
        'approved → merge → Done',
        (s) => s.issue.state === 'closed',
      );
      expect(done.issue.state).toBe('closed');

      // 5. Cleanup sweep evicts the now-terminal issue's workspace (idempotent; runs every tick).
      await h.tick();
      expect(h.observed).toContain('done');
    },
    // Live agent runs are slow; the bound is the harness's own (maxTicks × pollMs) plus slack.
    30 * 60_000,
  );

  it('placeholder keeps the gated suite loadable', () => {
    expect(ENABLED).toBe(true); // only runs when explicitly enabled
  });
});
