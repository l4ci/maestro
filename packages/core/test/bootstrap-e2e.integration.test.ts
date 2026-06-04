// Slice 9 — §16 bootstrap E2E smoke: the CANONICAL v1 acceptance test. OPT-IN, gated
// by MAESTRO_E2E=1; SKIPPED in the default `pnpm test` path (it touches a live forge and
// runs the real `claude` agent). Mirrors the M2/M5 integration-tier posture: a documented
// runbook left as a skipped placeholder until a scratch repo + token exist, so the default
// suite stays hermetic.
//
// Scratch-repo setup (throwaway, run-id-suffixed names, torn down after):
//   A fresh repo with NO WORKFLOW.md, a bot account, a scoped token.
//
// Run:
//   MAESTRO_E2E=1 \
//   MAESTRO_GITLAB_TOKEN=glpat-... (or MAESTRO_GITHUB_TOKEN) \
//   MAESTRO_E2E_CONFIG=/path/to/maestro.config.yaml \
//   MAESTRO_WORKFLOWS_DIR=/path/to/workflows \
//   pnpm test bootstrap-e2e.integration
//
// The canonical acceptance sequence (the milestone headline — onboarding DOGFOODS the
// lifecycle, no new path):
//   1. `maestro add <scratch-url>` → ensures labels (+ GitLab board); the repo has no
//      WORKFLOW.md, so onboard() opens ONE self-assigned "Let's define my workflow"
//      issue whose body carries the inferred, WorkflowSchema-valid seed + the bootstrap
//      marker.
//   2. The UNMODIFIED daemon drives that issue: New → in-progress (branch + draft MR) →
//      the agent writes WORKFLOW.md from the seed, commits, ticks the MR todo, emits
//      `done` → handoff (proof + assign creator + un-draft + maestro::in-review).
//   3. A human approves the MR.
//   4. Next tick: merge per the repo's git rules → the issue auto-closes via `Closes #N`
//      (Done); the cleanup sweep evicts the issue workspace.
//   5. Re-running `maestro add <same-url>` opens NO second bootstrap issue (idempotent).
//
// This is the spec §15 canonical end-to-end and the headline v1 acceptance gate. It is
// opt-in, NOT part of CI's default gate (CI runs typecheck + unit + lint).

import { describe, expect, it } from 'vitest';

const ENABLED = process.env.MAESTRO_E2E === '1';

describe.runIf(ENABLED)('M8 bootstrap E2E — onboard a scratch repo end-to-end (§16)', () => {
  it.todo('add → seed issue → lifecycle drafts WORKFLOW.md MR → approve → merge → Done → evicted');
  it.todo('re-running add opens no second bootstrap issue (idempotent)');

  it('placeholder keeps the gated suite loadable', () => {
    expect(ENABLED).toBe(true); // only runs when explicitly enabled
  });
});
