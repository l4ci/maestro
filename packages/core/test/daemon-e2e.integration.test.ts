// I1 — canonical end-to-end vertical slice (spec §15/§16). The HEADLINE exit item: one
// GitLab repo, one assigned issue, driven New→Done fully automated except the human
// approval. OPT-IN, gated by MAESTRO_E2E=1; SKIPPED in the default `pnpm test` path
// (it touches gitlab.com and runs the real `claude` agent). This is the ONLY place real
// I/O runs — real GitLab adapter (M2), real ClaudeRunner (M3), real workspace + handoff.
//
// Scratch-project setup (throwaway, torn down after):
//   1. Create a scratch GitLab project; commit a WORKFLOW.md with
//      `proof.type: diff-summary` (keeps Chromium/RAM out of CI; the playwright proof
//      path is covered by M4 unit tests).
//   2. A human assigns a prepared issue to `bot_user`.
//
// Run:
//   MAESTRO_E2E=1 \
//   MAESTRO_GITLAB_TOKEN=glpat-... \
//   MAESTRO_E2E_CONFIG=/path/to/maestro.config.yaml \
//   MAESTRO_WORKFLOWS_DIR=/path/to/workflows \
//   pnpm test daemon-e2e.integration
//
// Asserted by polling GitLab (driving the daemon for a bounded number of ticks):
//   · creates the branch + draft MR (`Closes #N`), labels maestro::in-progress, comments
//     "started", runs the agent to `done`, runs handoff (proof comment on issue+MR,
//     reviewer = ticket creator assigned, MR un-drafted, maestro::in-review);
//   · a human approves the MR;
//   · next tick: the daemon merges per WORKFLOW git rules → issue auto-closes (Done);
//   · next tick: the cleanup sweep evicts the issue's workspace dir.
//
// This is the spec's "canonical end-to-end test" (§15). It is opt-in, NOT part of CI's
// default gate (CI runs typecheck + unit + lint per M0 §0.11). Implemented as a live
// runbook once a scratch project + token exist; left as a documented, skipped placeholder
// here so the default suite stays hermetic (mirrors the M2 integration tier).

import { describe, expect, it } from 'vitest';

const ENABLED = process.env.MAESTRO_E2E === '1';

describe.runIf(ENABLED)('M5 E2E — New→Done vertical slice (scratch GitLab project)', () => {
  it.todo('drives one assigned issue New→in-progress→handoff→in-review→merge→Done→evicted');

  it('placeholder keeps the gated suite loadable', () => {
    expect(ENABLED).toBe(true); // only runs when explicitly enabled
  });
});
