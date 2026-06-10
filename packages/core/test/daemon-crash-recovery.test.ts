// Crash-recovery integration test (#109, the missing AM-1 coverage): agent `done` →
// proof comment posted → the daemon dies mid-handoff → a RESTARTED daemon's next tick
// reconciles the issue to the `handoff` intent and the idempotent M4 sequence finishes
// WITHOUT double-commenting or double-pinging. Hermetic: the REAL proofAndHandoff /
// handoff units run through the REAL tick + reconciler + executor; only the forge,
// workspace, runner, and exec are fakes. A "restart" is a fresh TickContext (new
// Claims, new ProofStreaks) — the daemon is stateless by design (§0.4), so that IS the
// restart.

import { describe, expect, it, vi } from 'vitest';
import { DONE_SENTINEL } from '../src/contracts/index.js';
import { tickRepo } from '../src/daemon/tick.js';
import { handoff, proofAndHandoff } from '../src/handoff/handoff.js';
import {
  buildContext,
  labels,
  makeSnapshot,
  recordingAdapter,
  scriptedRunner,
  silentLogger,
  user,
} from './helpers/daemon.js';

const REPO = makeSnapshot().repo;
const READY = '<!-- maestro:ready-for-review -->';
const READY_BODY = `@reporter ready for review\n\n${READY}`;

describe('crash recovery — handoff resumes idempotently after a daemon restart (#109)', () => {
  it('proof posted → crash → restart → handoff intent finishes: one proof, one ping, one review request', async () => {
    // ---- Tick 1: the run that crashes mid-handoff -------------------------------
    // In-progress issue, draft MR, agent reports done. The REAL proofAndHandoff runs
    // (diff-summary proof through the fake exec) and posts the proof comments; the
    // forge's requestReview then "crashes the daemon" (throws) — handoff step 3 of 6.
    const snap1 = makeSnapshot({ issue: { labels: [labels.inProgress] } });
    const adapter1 = recordingAdapter({ snapshot: snap1 });
    adapter1.adapter.requestReview = async () => {
      throw new Error('daemon crashed mid-handoff');
    };
    const log1 = silentLogger();
    const t1 = buildContext({
      adapter: adapter1,
      runner: scriptedRunner({ status: 'done', summary: 'shipped' }),
      proofAndHandoff: vi.fn(proofAndHandoff),
      log: log1,
    });
    await tickRepo(REPO, t1.ctx);

    // the proof comment (with the crash-recovery sentinel) landed on issue AND MR
    const proofComments = adapter1.issueComments.filter((c) => c.body.includes(DONE_SENTINEL));
    expect(proofComments).toHaveLength(1);
    expect(adapter1.mrComments.filter((c) => c.body.includes(DONE_SENTINEL))).toHaveLength(1);
    // ...but the handoff never finished: no ready ping, no undraft, no in-review label
    expect(adapter1.reviewRequests).toEqual([]);
    expect(adapter1.issueComments.some((c) => c.body.includes(READY))).toBe(false);
    expect(adapter1.calls).not.toContain('setDraft');
    expect(adapter1.labelOps).toEqual([]);
    // the crash surfaced through the tick's guard, isolated to this issue
    expect(log1.error).toHaveBeenCalledWith(
      'tick: issue work failed',
      expect.objectContaining({ iid: 42, err: expect.stringContaining('crashed mid-handoff') }),
    );

    // ---- Tick 2: the restarted daemon ------------------------------------------
    // Fresh context (new Claims/ProofStreaks — the restart), forge state as tick 1
    // left it: proof comment on the thread, MR still draft, issue still in-progress.
    const proofBody = proofComments[0]?.body ?? '';
    const snap2 = makeSnapshot({
      issue: { labels: [labels.inProgress] },
      comments: [proofBody],
    });
    const adapter2 = recordingAdapter({ snapshot: snap2 });
    const runner2 = scriptedRunner({ status: 'done', summary: 'should never run' });
    const t2 = buildContext({
      adapter: adapter2,
      runner: runner2,
      handoff: vi.fn(handoff), // the REAL idempotent bare sequence (M4)
    });
    await tickRepo(REPO, t2.ctx);

    // reconciled straight to the handoff intent — no second agent run
    expect(runner2.inputs).toHaveLength(0);
    // idempotent resume: the proof sentinel suppressed BOTH proof comments — the only issue
    // comment is the ready-for-review ping, posted exactly once
    expect(adapter2.issueComments).toHaveLength(1);
    expect(adapter2.issueComments[0]?.body).toContain(READY);
    expect(adapter2.mrComments).toEqual([]);
    // the remaining steps ran exactly once: request review, un-draft, label in-review
    expect(adapter2.reviewRequests).toEqual([{ mrIid: 7, username: 'reporter' }]);
    expect(adapter2.calls.filter((c) => c === 'requestReview')).toHaveLength(1);
    expect(adapter2.calls.filter((c) => c === 'setDraft')).toHaveLength(1);
    expect(adapter2.labelOps).toEqual([
      { iid: 42, set: [labels.inReview], unset: [labels.inProgress] },
    ]);

    // ---- Tick 3: another restart over the now-complete handoff -----------------
    // Fully recovered forge state → the tick is a pure no-op: nothing mutates.
    const snap3 = makeSnapshot({
      issue: { labels: [labels.inReview] },
      mr: { isDraft: false, reviewers: [user('reporter')] },
      comments: [proofBody, READY_BODY],
    });
    const adapter3 = recordingAdapter({ snapshot: snap3 });
    const runner3 = scriptedRunner({ status: 'done', summary: 'should never run' });
    const t3 = buildContext({ adapter: adapter3, runner: runner3, handoff: vi.fn(handoff) });
    await tickRepo(REPO, t3.ctx);

    expect(runner3.inputs).toHaveLength(0);
    expect(adapter3.issueComments).toEqual([]);
    expect(adapter3.reviewRequests).toEqual([]);
    expect(adapter3.labelOps).toEqual([]);
    expect(adapter3.calls).not.toContain('setDraft');
  });
});
