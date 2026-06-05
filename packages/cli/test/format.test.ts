// Part C — pure formatters over core view objects. The CLI re-derives NOTHING: the view
// already carries the core-derived LifecycleState. Tests build fake views by hand.

import type { DashboardView, IssueView } from '@maestro/core';
import type { LogLine, PreflightResult, RepoRef } from '@maestro/core';
import { describe, expect, it } from 'vitest';
import { renderDoctor, renderList, renderLogs, renderStatus } from '../src/format.js';

const repo = (project: string): RepoRef => ({
  forge: 'gitlab',
  host: 'gitlab.com',
  project,
  url: `gitlab.com/${project}`,
});

describe('renderList (C1/C4)', () => {
  it('renders one row per repo with per-state tallies using only LifecycleState names', () => {
    const view: DashboardView = {
      repos: [
        {
          repo: repo('g/r'),
          issues: [],
          counts: { new: 1, 'in-progress': 2, 'in-review': 0, blocked: 1, done: 3 },
        },
      ],
    };
    const out = renderList(view);
    expect(out).toContain('g/r');
    expect(out).toMatch(/new\D*1/);
    expect(out).toMatch(/in-progress\D*2/);
    expect(out).toMatch(/blocked\D*1/);
    // No invented state names.
    expect(out).not.toMatch(/handoff|todo|pending|open\b/);
  });

  it('zero repos renders a friendly nothing-watched line', () => {
    expect(renderList({ repos: [] })).toMatch(/nothing watched/i);
  });
});

describe('renderStatus (C2)', () => {
  it('prints iid, state, mrUrl, draft + approval flags, and last log', () => {
    const view: IssueView = {
      iid: 42,
      title: 'Fix the thing',
      state: 'in-review',
      issueUrl: 'https://gitlab.com/g/r/-/issues/42',
      mrUrl: 'https://gitlab.com/g/r/-/merge_requests/7',
      isDraft: true,
      approved: false,
      lastLog: 'opened MR',
    };
    const out = renderStatus(view);
    expect(out).toContain('42');
    expect(out).toContain('in-review');
    expect(out).toContain('https://gitlab.com/g/r/-/merge_requests/7');
    expect(out).toMatch(/draft/i);
    expect(out).toContain('opened MR');
  });

  it('renders an issue with no MR without crashing (C4)', () => {
    const view: IssueView = {
      iid: 1,
      title: 't',
      state: 'new',
      issueUrl: 'https://gitlab.com/g/r/-/issues/1',
    };
    const out = renderStatus(view);
    expect(out).toContain('new');
  });

  it('shows the plan tally and a changes-requested flag when present (#41)', () => {
    const view: IssueView = {
      iid: 9,
      title: 'Add OAuth',
      state: 'in-review',
      issueUrl: 'https://gitlab.com/g/r/-/issues/9',
      mrUrl: 'https://gitlab.com/g/r/-/merge_requests/9',
      isDraft: false,
      approved: false,
      changesRequested: true,
      plan: {
        done: 1,
        total: 3,
        items: [
          { checked: true, text: 'design' },
          { checked: false, text: 'build' },
          { checked: false, text: 'test' },
        ],
      },
    };
    const out = renderStatus(view);
    expect(out).toContain('plan: 1/3 tasks');
    expect(out).toMatch(/changes-requested/);
  });
});

describe('renderLogs (C3)', () => {
  it('prints log lines', () => {
    const lines: LogLine[] = [
      { ts: '2026-06-04T00:00:00Z', repo: 'g/r', issueIid: 42, level: 'info', msg: 'first' },
      { ts: '2026-06-04T00:01:00Z', repo: 'g/r', issueIid: 42, level: 'warn', msg: 'second' },
    ];
    const out = renderLogs(lines);
    expect(out).toContain('first');
    expect(out).toContain('second');
    expect(out.indexOf('first')).toBeLessThan(out.indexOf('second'));
  });

  it('empty logs is a friendly message, not an error', () => {
    expect(renderLogs([])).toMatch(/no logs yet/i);
  });
});

describe('renderDoctor', () => {
  it('all present → ✓ rows and an OK verdict', () => {
    const result: PreflightResult = { ok: true, present: ['git', 'glab'], missing: [] };
    const out = renderDoctor(result);
    expect(out).toContain('✓ git');
    expect(out).toContain('✓ glab');
    expect(out).toMatch(/all required tools found/i);
  });

  it('missing tool → ✗ row with the reason and a nonzero-worthy verdict', () => {
    const result: PreflightResult = {
      ok: false,
      present: ['git'],
      missing: [{ bin: 'gh', reason: 'GitHub API transport' }],
    };
    const out = renderDoctor(result);
    expect(out).toContain('✓ git');
    expect(out).toContain('✗ gh');
    expect(out).toContain('GitHub API transport');
    expect(out).toMatch(/missing 1 required tool/i);
  });
});
