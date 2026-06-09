// The command-MR pass (spec §3/§5): standalone bot-assigned MRs with a `/maestro` command
// get one agent run + one sentinel reply; issue-backed MRs are skipped; a replied edge
// does not re-run; the cleanup sweep evicts a terminal MR's workspace.

import { describe, expect, it } from 'vitest';
import type { Comment, MergeRequest } from '../src/contracts/index.js';
import { MR_COMMAND_REPLY_SENTINEL } from '../src/contracts/index.js';
import { evaluateMrCommands, isStandaloneMr } from '../src/daemon/mr-command-pass.js';
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
