// The command-MR pass (spec §3/§5): standalone bot-assigned MRs with a `/maestro` command
// get one agent run + one sentinel reply; issue-backed MRs are skipped; a replied edge
// does not re-run; the cleanup sweep evicts a terminal MR's workspace.

import { describe, expect, it } from 'vitest';
import type { Comment, MergeRequest } from '../src/contracts/index.js';
import { MR_COMMAND_REPLY_SENTINEL } from '../src/contracts/index.js';
import { evaluateMrCommands, isStandaloneMr } from '../src/daemon/mr-command-pass.js';
import { RateLimitGate } from '../src/daemon/rate-limit-gate.js';
import { cleanupSweep } from '../src/daemon/tick.js';
import {
  buildContext,
  fakeWorkspace,
  recordingAdapter,
  repo,
  scriptedRunner,
} from './helpers/daemon.js';

const mr = (over: Partial<MergeRequest> = {}): MergeRequest => ({
  iid: 7,
  id: '7',
  title: 'Tidy the parser',
  description: 'some changes',
  state: 'opened',
  isDraft: false,
  sourceBranch: 'feature/parser',
  targetBranch: 'main',
  assignees: [],
  labels: [],
  approvals: { approved: false, approvedBy: [], changesRequested: false },
  webUrl: 'u',
  ...over,
});
const cmd = (body: string, at: string, username = 'maintainer'): Comment => ({
  id: at,
  author: { id: '5', username },
  body,
  createdAt: at,
});
// a prior bot reply carrying the sentinel
const reply = (at: string): Comment => ({
  id: at,
  author: { id: '1', username: 'maestro-bot' },
  body: `done\n\n${MR_COMMAND_REPLY_SENTINEL}`,
  createdAt: at,
});

describe('isStandaloneMr', () => {
  it('true for a plain MR; false for a maestro-issue branch or a Closes link', () => {
    expect(isStandaloneMr(mr())).toBe(true);
    expect(isStandaloneMr(mr({ sourceBranch: 'maestro/issue-9-x' }))).toBe(false);
    expect(isStandaloneMr(mr({ closesIssueIid: 9 }))).toBe(false);
  });
});

describe('evaluateMrCommands', () => {
  it('runs the newest command, pushes the agent commits, and replies once with the sentinel', async () => {
    const adapter = recordingAdapter({
      mrs: [mr()],
      mrComments: new Map([[7, [cmd('/maestro make the tests pass', '2026-02-02')]]]),
    });
    const ws = fakeWorkspace({ unpushed: 2 });
    const { ctx, runnerSpy } = buildContext({
      adapter,
      workspace: ws,
      runner: scriptedRunner({ status: 'done', summary: 'fixed two failing tests' }),
    });

    const { pending, active } = await evaluateMrCommands(repo, ctx);
    await Promise.all(pending);

    expect(active).toBe(true);
    expect(runnerSpy.inputs).toHaveLength(1);
    expect(runnerSpy.inputs[0]?.context.issue).toBeUndefined(); // a command MR has no issue
    expect(ws.mrEnsured).toEqual([{ iid: 7, fromRef: 'feature/parser' }]);
    expect(ws.pushed).toEqual([{ dir: '/ws/mr-7', branch: 'feature/parser' }]);
    expect(adapter.mrComments).toHaveLength(1);
    expect(adapter.mrComments[0]?.mrIid).toBe(7);
    expect(adapter.mrComments[0]?.body).toContain('pushed 2 commits');
    expect(adapter.mrComments[0]?.body).toContain(MR_COMMAND_REPLY_SENTINEL);
  });

  it('replies WITHOUT pushing when the agent changed nothing', async () => {
    const adapter = recordingAdapter({
      mrs: [mr()],
      mrComments: new Map([[7, [cmd('/maestro do the tests pass?', '2026-02-02')]]]),
    });
    const ws = fakeWorkspace({ unpushed: 0 });
    const { ctx } = buildContext({
      adapter,
      workspace: ws,
      runner: scriptedRunner({ status: 'done', summary: 'yes, all green' }),
    });

    await Promise.all((await evaluateMrCommands(repo, ctx)).pending);

    expect(ws.pushed).toEqual([]);
    expect(adapter.mrComments[0]?.body).toContain('no code changes');
    expect(adapter.mrComments[0]?.body).toContain(MR_COMMAND_REPLY_SENTINEL);
  });

  it('skips issue-backed MRs — the issue path owns them', async () => {
    const adapter = recordingAdapter({
      mrs: [mr({ sourceBranch: 'maestro/issue-9-x' }), mr({ iid: 8, closesIssueIid: 9 })],
    });
    const ws = fakeWorkspace();
    const { ctx, runnerSpy } = buildContext({ adapter, workspace: ws });

    const { active } = await evaluateMrCommands(repo, ctx);

    expect(active).toBe(false);
    expect(runnerSpy.inputs).toEqual([]);
    expect(adapter.calls).not.toContain('getMrComments');
    expect(ws.mrEnsured).toEqual([]);
  });

  it('does not re-run once the bot has replied (edge cleared)', async () => {
    const adapter = recordingAdapter({
      mrs: [mr()],
      mrComments: new Map([[7, [reply('2026-02-03'), cmd('/maestro x', '2026-02-02')]]]),
    });
    const ws = fakeWorkspace();
    const { ctx, runnerSpy } = buildContext({ adapter, workspace: ws });

    const { active } = await evaluateMrCommands(repo, ctx);

    expect(active).toBe(false);
    expect(runnerSpy.inputs).toEqual([]);
    expect(adapter.mrComments).toEqual([]);
  });
});

describe('evaluateMrCommands — daemon-action meta-commands (#88)', () => {
  it('/maestro merge merges via the adapter, replies once, and runs NO agent', async () => {
    const adapter = recordingAdapter({
      mrs: [mr()],
      mrComments: new Map([[7, [cmd('/maestro merge', '2026-02-02')]]]),
    });
    const ws = fakeWorkspace();
    const { ctx, runnerSpy } = buildContext({ adapter, workspace: ws });

    await Promise.all((await evaluateMrCommands(repo, ctx)).pending);

    expect(adapter.merges).toEqual([{ mrIid: 7, strategy: 'squash', deleteSource: true }]);
    expect(runnerSpy.inputs).toEqual([]); // no agent run
    expect(ws.mrEnsured).toEqual([]); // no workspace
    expect(adapter.mrComments).toHaveLength(1);
    expect(adapter.mrComments[0]?.body).toContain('Merged this MR');
    expect(adapter.mrComments[0]?.body).toContain(MR_COMMAND_REPLY_SENTINEL);
  });

  it('/maestro merge on a DRAFT MR refuses to merge but still replies (sentinel)', async () => {
    const adapter = recordingAdapter({
      mrs: [mr({ isDraft: true })],
      mrComments: new Map([[7, [cmd('/maestro merge', '2026-02-02')]]]),
    });
    const { ctx } = buildContext({ adapter });

    await Promise.all((await evaluateMrCommands(repo, ctx)).pending);

    expect(adapter.merges).toEqual([]);
    expect(adapter.mrComments[0]?.body).toContain('still a draft');
    expect(adapter.mrComments[0]?.body).toContain(MR_COMMAND_REPLY_SENTINEL);
  });

  it('/maestro close closes via the adapter and replies once, NO agent', async () => {
    const adapter = recordingAdapter({
      mrs: [mr()],
      mrComments: new Map([[7, [cmd('/maestro close', '2026-02-02')]]]),
    });
    const { ctx, runnerSpy } = buildContext({ adapter });

    await Promise.all((await evaluateMrCommands(repo, ctx)).pending);

    expect(adapter.closes).toEqual([{ mrIid: 7 }]);
    expect(runnerSpy.inputs).toEqual([]);
    expect(adapter.mrComments[0]?.body).toContain('Closed this MR');
    expect(adapter.mrComments[0]?.body).toContain(MR_COMMAND_REPLY_SENTINEL);
  });

  it('a failed merge still replies with the sentinel — the edge self-clears, never loops', async () => {
    const adapter = recordingAdapter({
      mrs: [mr()],
      mrComments: new Map([[7, [cmd('/maestro merge', '2026-02-02')]]]),
      fail: { mergeMR: () => new Error('merge conflict') },
    });
    const { ctx } = buildContext({ adapter });

    await Promise.all((await evaluateMrCommands(repo, ctx)).pending);

    expect(adapter.mrComments).toHaveLength(1);
    expect(adapter.mrComments[0]?.body).toContain("Couldn't merge");
    expect(adapter.mrComments[0]?.body).toContain('merge conflict');
    expect(adapter.mrComments[0]?.body).toContain(MR_COMMAND_REPLY_SENTINEL);
  });

  it('a mixed "review then merge" routes to the agent unchanged (Q2a)', async () => {
    const adapter = recordingAdapter({
      mrs: [mr()],
      mrComments: new Map([[7, [cmd('/maestro review then merge', '2026-02-02')]]]),
    });
    const ws = fakeWorkspace({ unpushed: 0 });
    const { ctx, runnerSpy } = buildContext({
      adapter,
      workspace: ws,
      runner: scriptedRunner({ status: 'done', summary: 'looks good' }),
    });

    await Promise.all((await evaluateMrCommands(repo, ctx)).pending);

    expect(adapter.merges).toEqual([]);
    expect(runnerSpy.inputs).toHaveLength(1); // agent ran
    expect(ws.mrEnsured).toEqual([{ iid: 7, fromRef: 'feature/parser' }]);
  });

  it('merges even while Claude is rate-limited (#47) — no spawn needed', async () => {
    const adapter = recordingAdapter({
      mrs: [mr()],
      mrComments: new Map([[7, [cmd('/maestro merge', '2026-02-02')]]]),
    });
    const rateGate = new RateLimitGate();
    rateGate.trip(Date.now() + 60_000);
    const { ctx } = buildContext({ adapter, rateGate });

    await Promise.all((await evaluateMrCommands(repo, ctx)).pending);

    expect(adapter.merges).toEqual([{ mrIid: 7, strategy: 'squash', deleteSource: true }]);
    expect(adapter.mrComments[0]?.body).toContain(MR_COMMAND_REPLY_SENTINEL);
  });
});

describe('cleanupSweep — command-MR branch', () => {
  it('evicts a command-MR workspace once its MR is merged; keeps an open one', async () => {
    const adapter = recordingAdapter({
      mrStates: new Map([
        [7, 'merged'],
        [8, 'open'],
      ]),
    });
    const ws = fakeWorkspace({
      mrDirs: [
        { dir: '/ws/mr-7', iid: 7 },
        { dir: '/ws/mr-8', iid: 8 },
      ],
    });
    const { ctx } = buildContext({ adapter, workspace: ws });

    await cleanupSweep(repo, ctx);

    expect(ws.evicted).toEqual(['/ws/mr-7']);
  });
});
