import { describe, expect, it } from 'vitest';
import type {
  IssueSnapshot,
  LogLine,
  ReadOnlyForgeAdapter,
  RepoRef,
} from '../src/contracts/index.js';
import {
  assembleDashboard,
  assembleIssue,
  lastActivityOf,
  parsePlan,
} from '../src/views/assemble.js';
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

describe('daemon heartbeat threads onto the dashboard view (#40)', () => {
  const snaps = () =>
    new Map([[1, makeSnapshot({ issue: { iid: 1, labels: [labels.inProgress] } })]]);

  it('carries the heartbeat when the reader returns one', async () => {
    const rec = roAdapter(snaps());
    const beat = { lastTickAt: 123, activeWorkers: 1, maxWorkers: 2, tickIntervalMs: 1000 };
    const view = await assembleDashboard([repo], {
      ...deps(new Map([[repo.url, rec.adapter]])),
      heartbeat: () => beat,
    });
    expect(view.daemon).toEqual(beat);
  });

  it('omits daemon entirely when no heartbeat file exists (daemon never ran)', async () => {
    const rec = roAdapter(snaps());
    const view = await assembleDashboard([repo], {
      ...deps(new Map([[repo.url, rec.adapter]])),
      heartbeat: () => undefined,
    });
    expect('daemon' in view).toBe(false);
  });

  it('is undefined when no heartbeat dep is wired at all', async () => {
    const rec = roAdapter(snaps());
    const view = await assembleDashboard([repo], deps(new Map([[repo.url, rec.adapter]])));
    expect(view.daemon).toBeUndefined();
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

  it('exposes the issue author and, once review is requested, the reviewer (#37)', async () => {
    const snaps = new Map([
      [
        7,
        makeSnapshot({
          issue: {
            iid: 7,
            author: { username: 'reporter', id: '2', avatarUrl: 'https://f/a.png' },
          },
          mr: { reviewers: [{ username: 'reporter', id: '2', avatarUrl: 'https://f/a.png' }] },
        }),
      ],
    ]);
    const rec = roAdapter(snaps);

    const view = await assembleIssue(repo, 7, deps(new Map([[repo.url, rec.adapter]])));

    expect(view.author).toEqual({ username: 'reporter', id: '2', avatarUrl: 'https://f/a.png' });
    expect(view.reviewer).toEqual({ username: 'reporter', id: '2', avatarUrl: 'https://f/a.png' });
  });

  it('omits the reviewer when the MR has no review requested yet (pre-handoff)', async () => {
    const snaps = new Map([[8, makeSnapshot({ issue: { iid: 8 }, mr: { reviewers: [] } })]]);
    const rec = roAdapter(snaps);

    const view = await assembleIssue(repo, 8, deps(new Map([[repo.url, rec.adapter]])));

    expect(view.reviewer).toBeUndefined();
  });
});

describe('parsePlan — checkbox plan off an MR description (#41)', () => {
  it('counts done/total and returns items in source order', () => {
    const plan = parsePlan('intro\n- [ ] scaffold\n- [x] write tests\n- [X] ship\noutro');
    expect(plan).toEqual({
      done: 2,
      total: 3,
      items: [
        { checked: false, text: 'scaffold' },
        { checked: true, text: 'write tests' },
        { checked: true, text: 'ship' },
      ],
    });
  });

  it('accepts *, + and indented bullets', () => {
    const plan = parsePlan('* [ ] a\n+ [x] b\n  - [ ] c');
    expect(plan?.total).toBe(3);
    expect(plan?.done).toBe(1);
  });

  it('returns undefined when the description carries no checkboxes', () => {
    expect(parsePlan('Closes #42\n\nJust prose, no task list.')).toBeUndefined();
  });

  it('ignores a bare dash list with no checkbox', () => {
    expect(parsePlan('- not a task\n- still not')).toBeUndefined();
  });
});

describe('assembleIssue — drill-down detail enrichment (#41)', () => {
  const logsOf = (lines: Partial<LogLine>[]) => ({
    readIssueLog: async (_r: RepoRef, _iid: number, limit?: number): Promise<LogLine[]> => {
      const full: LogLine[] = lines.map((l, i) => ({
        ts: `t${i}`,
        repo: 'group/api',
        issueIid: 7,
        level: 'info',
        msg: `line ${i}`,
        ...l,
      }));
      return full.slice(-(limit ?? full.length));
    },
  });

  it('parses the MR description plan and exposes changesRequested + the log window', async () => {
    const snaps = new Map([
      [
        7,
        makeSnapshot({
          issue: { iid: 7 },
          mr: {
            description: '- [x] design\n- [ ] build',
            approvals: { approved: false, approvedBy: [], changesRequested: true },
          },
          comments: ['first', 'second'],
        }),
      ],
    ]);
    const rec = roAdapter(snaps);
    const logs = logsOf([{ msg: 'a' }, { msg: 'b' }, { msg: 'c' }]);

    const view = await assembleIssue(repo, 7, deps(new Map([[repo.url, rec.adapter]]), logs));

    expect(view.plan).toEqual({
      done: 1,
      total: 2,
      items: [
        { checked: true, text: 'design' },
        { checked: false, text: 'build' },
      ],
    });
    expect(view.changesRequested).toBe(true);
    expect(view.recentLogs?.map((l) => l.msg)).toEqual(['a', 'b', 'c']);
    expect(view.recentComments?.map((c) => c.body)).toEqual(['first', 'second']);
  });

  it('omits the plan when the MR description has no checkboxes', async () => {
    const snaps = new Map([
      [7, makeSnapshot({ issue: { iid: 7 }, mr: { description: 'Closes #7' } })],
    ]);
    const rec = roAdapter(snaps);

    const view = await assembleIssue(repo, 7, deps(new Map([[repo.url, rec.adapter]])));

    expect(view.plan).toBeUndefined();
  });

  it('omits the plan entirely when there is no MR', async () => {
    const snaps = new Map([[7, makeSnapshot({ issue: { iid: 7 }, mr: null })]]);
    const rec = roAdapter(snaps);

    const view = await assembleIssue(repo, 7, deps(new Map([[repo.url, rec.adapter]])));

    expect(view.plan).toBeUndefined();
    expect(view.mrUrl).toBeUndefined();
  });

  it('asks the log reader for a window, not a single line, in detail mode', async () => {
    const seen: (number | undefined)[] = [];
    const logs = {
      readIssueLog: async (_r: RepoRef, _iid: number, limit?: number): Promise<LogLine[]> => {
        seen.push(limit);
        return [];
      },
    };
    const snaps = new Map([[7, makeSnapshot({ issue: { iid: 7 } })]]);
    const rec = roAdapter(snaps);

    await assembleIssue(repo, 7, deps(new Map([[repo.url, rec.adapter]]), logs));

    expect(seen[0]).toBeGreaterThan(1); // a window of recent lines, not just the newest
  });
});

describe('assembleDashboard keeps the collapsed payload lean (#41)', () => {
  it('the dashboard list never carries the heavy detail fields', async () => {
    const snaps = new Map([
      [
        7,
        makeSnapshot({
          issue: { iid: 7, labels: [labels.inProgress] },
          mr: { description: '- [x] a\n- [ ] b' },
          comments: ['hello'],
        }),
      ],
    ]);
    const rec = roAdapter(snaps);
    const logs = {
      readIssueLog: async (): Promise<LogLine[]> => [
        { ts: 't', repo: 'group/api', issueIid: 7, level: 'info' as const, msg: 'x' },
      ],
    };

    const view = await assembleDashboard([repo], deps(new Map([[repo.url, rec.adapter]]), logs));
    const issue = view.repos[0]?.issues[0];

    // Detail-only fields stay off the board so the polled payload is no bigger than before.
    expect(issue?.plan).toBeUndefined();
    expect(issue?.recentLogs).toBeUndefined();
    expect(issue?.recentComments).toBeUndefined();
    // The lean fields it has always carried are still present.
    expect(issue?.lastLog).toBe('x');
  });
});

describe('lastActivityOf — newest of issue / MR / agent (#39)', () => {
  const comment = (at: string, body = 'looks good', username = 'reviewer') => ({
    id: 'c',
    author: { username, id: `id-${username}` },
    body,
    createdAt: at,
  });
  const log = (at: string, msg = 'cloned workspace'): LogLine => ({
    ts: at,
    repo: 'group/api',
    issueIid: 42,
    level: 'info',
    msg,
  });
  const snap = (over: Partial<IssueSnapshot>): IssueSnapshot => ({ ...makeSnapshot(), ...over });

  it('returns undefined when no source has a signal', () => {
    expect(lastActivityOf(snap({ recentComments: [] }))).toBeUndefined();
  });

  it('uses the issue comment when it is the only signal, author + truncated body', () => {
    const a = lastActivityOf(snap({ recentComments: [comment('2026-06-01T00:00:00Z')] }));
    expect(a?.source).toBe('issue');
    expect(a?.at).toBe('2026-06-01T00:00:00Z');
    expect(a?.summary).toBe('@reviewer: looks good');
  });

  it('prefers a newer MR push over a stale issue comment (the core acceptance case)', () => {
    const a = lastActivityOf(
      snap({
        recentComments: [comment('2026-06-01T00:00:00Z')],
        mrActivityAt: { at: '2026-06-03T00:00:00Z', kind: 'push' },
      }),
    );
    expect(a?.source).toBe('mr');
    expect(a?.at).toBe('2026-06-03T00:00:00Z');
    expect(a?.summary).toBe('bot pushed a commit');
  });

  it('labels an MR review thread distinctly from a push', () => {
    const a = lastActivityOf(
      snap({ recentComments: [], mrActivityAt: { at: '2026-06-03T00:00:00Z', kind: 'thread' } }),
    );
    expect(a?.summary).toBe('review thread');
  });

  it('lets the agent log win when its timestamp is the newest', () => {
    const a = lastActivityOf(
      snap({
        recentComments: [comment('2026-06-01T00:00:00Z')],
        mrActivityAt: { at: '2026-06-02T00:00:00Z', kind: 'push' },
      }),
      log('2026-06-04T00:00:00Z', 'agent completed proof'),
    );
    expect(a?.source).toBe('agent');
    expect(a?.summary).toBe('agent completed proof');
  });

  it('truncates a long comment body to ~80 chars with an ellipsis', () => {
    const long = 'x'.repeat(200);
    const a = lastActivityOf(snap({ recentComments: [comment('2026-06-01T00:00:00Z', long)] }));
    expect(a?.summary.length).toBeLessThanOrEqual(80);
    expect(a?.summary.endsWith('…')).toBe(true);
  });

  it('flattens newlines in a summary to a single line', () => {
    const body = 'line one\n\nline   two';
    const a = lastActivityOf(snap({ recentComments: [comment('2026-06-01T00:00:00Z', body)] }));
    expect(a?.summary).toBe('@reviewer: line one line two');
  });
});
