import { describe, expect, it } from 'vitest';
import type {
  IssueSnapshot,
  LogLine,
  ReadOnlyForgeAdapter,
  RepoRef,
} from '../src/contracts/index.js';
import { assembleDashboard, assembleIssue } from '../src/views/assemble.js';
import { defaultSettings, labels, makeSnapshot, repo } from './helpers/daemon.js';

const repoB: RepoRef = { ...repo, project: 'group/web', url: 'gitlab.com/group/web' };

interface RoRecorder {
  adapter: ReadOnlyForgeAdapter;
  calls: string[];
}
function roAdapter(
  snaps: Map<number, IssueSnapshot>,
  opts: { throwList?: boolean } = {},
): RoRecorder {
  const calls: string[] = [];
  const adapter: ReadOnlyForgeAdapter = {
    kind: 'gitlab',
    listAssignedOpenIssues: async () => {
      calls.push('listAssignedOpenIssues');
      if (opts.throwList) throw new Error('forge unreachable');
      return [...snaps.values()].map((s) => s.issue);
    },
    getSnapshot: async (_r, iid) => {
      calls.push('getSnapshot');
      const s = snaps.get(iid);
      if (!s) throw new Error(`no snapshot ${iid}`);
      return s;
    },
    getIssueState: async () => {
      calls.push('getIssueState');
      return 'open';
    },
  };
  return { adapter, calls };
}

const noLogs = { readIssueLog: async (): Promise<LogLine[]> => [] };

function deps(adapters: Map<string, ReadOnlyForgeAdapter>, logs = noLogs) {
  return {
    adapterFor: (r: RepoRef) => adapters.get(r.url) as ReadOnlyForgeAdapter,
    settingsFor: () => defaultSettings(),
    logs,
  };
}

describe('E1 — assembleDashboard projects forge + logs, read-only', () => {
  it('builds per-repo issue views and makes only read adapter calls', async () => {
    const snaps = new Map([
      [42, makeSnapshot({ issue: { iid: 42, labels: [labels.inProgress] } })],
    ]);
    const rec = roAdapter(snaps);
    const logs = {
      readIssueLog: async (): Promise<LogLine[]> => [
        {
          ts: 't',
          repo: 'group/api',
          issueIid: 42,
          level: 'info' as const,
          msg: 'cloned workspace',
        },
      ],
    };

    const view = await assembleDashboard([repo], deps(new Map([[repo.url, rec.adapter]]), logs));

    expect(view.repos).toHaveLength(1);
    expect(view.repos[0]?.issues[0]?.iid).toBe(42);
    expect(view.repos[0]?.issues[0]?.author).toEqual({ username: 'reporter', id: 'id-reporter' });
    expect(view.repos[0]?.issues[0]?.lastLog).toBe('cloned workspace');
    // only read methods exist on a ReadOnlyForgeAdapter; assert none beyond reads ran
    expect(new Set(rec.calls)).toEqual(new Set(['listAssignedOpenIssues', 'getSnapshot']));
  });
});

describe('E2 — derived state equals core deriveState', () => {
  it('an in-review snapshot renders as in-review', async () => {
    const snaps = new Map([
      [
        9,
        makeSnapshot({
          issue: { iid: 9, labels: [labels.inReview] },
          mr: { approvals: { approved: false, approvedBy: [], changesRequested: false } },
        }),
      ],
    ]);
    const rec = roAdapter(snaps);

    const view = await assembleDashboard([repo], deps(new Map([[repo.url, rec.adapter]])));

    expect(view.repos[0]?.issues[0]?.state).toBe('in-review');
    expect(view.repos[0]?.counts['in-review']).toBe(1);
  });
});

describe('E3 — assembly degrades per-repo on a forge error', () => {
  it('a failing repo gets an error marker; other repos still render', async () => {
    const okSnaps = new Map([
      [1, makeSnapshot({ issue: { iid: 1, labels: [labels.inProgress] } })],
    ]);
    const adapters = new Map<string, ReadOnlyForgeAdapter>([
      [repo.url, roAdapter(new Map(), { throwList: true }).adapter],
      [repoB.url, roAdapter(okSnaps).adapter],
    ]);

    const view = await assembleDashboard([repo, repoB], deps(adapters));

    const failing = view.repos.find((r) => r.repo.url === repo.url);
    const healthy = view.repos.find((r) => r.repo.url === repoB.url);
    expect(failing?.error).toBeTruthy();
    expect(healthy?.error).toBeUndefined();
    expect(healthy?.issues).toHaveLength(1);
  });
});

describe('assembleIssue — single issue view for status', () => {
  it('carries the derived state, MR url and draft/approval flags', async () => {
    const snaps = new Map([
      [
        7,
        makeSnapshot({
          issue: { iid: 7, labels: [labels.inReview], webUrl: 'https://forge/issues/7' },
          mr: {
            webUrl: 'https://mr/7',
            isDraft: false,
            approvals: { approved: true, approvedBy: [], changesRequested: false },
          },
        }),
      ],
    ]);
    const rec = roAdapter(snaps);

    const view = await assembleIssue(repo, 7, deps(new Map([[repo.url, rec.adapter]])));

    expect(view.state).toBe('in-review');
    expect(view.issueUrl).toBe('https://forge/issues/7');
    expect(view.mrUrl).toBe('https://mr/7');
    expect(view.isDraft).toBe(false);
    expect(view.approved).toBe(true);
  });

  it('exposes the issue author and, once the MR is assigned, the reviewer (#37)', async () => {
    const snaps = new Map([
      [
        7,
        makeSnapshot({
          issue: {
            iid: 7,
            author: { username: 'reporter', id: '2', avatarUrl: 'https://f/a.png' },
          },
          mr: { assignees: [{ username: 'reporter', id: '2', avatarUrl: 'https://f/a.png' }] },
        }),
      ],
    ]);
    const rec = roAdapter(snaps);

    const view = await assembleIssue(repo, 7, deps(new Map([[repo.url, rec.adapter]])));

    expect(view.author).toEqual({ username: 'reporter', id: '2', avatarUrl: 'https://f/a.png' });
    expect(view.reviewer).toEqual({ username: 'reporter', id: '2', avatarUrl: 'https://f/a.png' });
  });

  it('omits the reviewer when the MR has no assignee yet (pre-handoff)', async () => {
    const snaps = new Map([[8, makeSnapshot({ issue: { iid: 8 }, mr: { assignees: [] } })]]);
    const rec = roAdapter(snaps);

    const view = await assembleIssue(repo, 8, deps(new Map([[repo.url, rec.adapter]])));

    expect(view.reviewer).toBeUndefined();
  });
});
