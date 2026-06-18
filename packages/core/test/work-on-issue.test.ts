import { describe, expect, it } from 'vitest';
import type { ForgeAdapter, RepoRef, RepoSettings } from '../src/contracts/index.js';
import { workOnIssue } from '../src/onboarding/work-on-issue.js';

const repo: RepoRef = {
  forge: 'gitlab',
  host: 'gitlab.com',
  project: 'group/api',
  url: 'gitlab.com/group/api',
};

function settings(trigger: RepoSettings['trigger']): RepoSettings {
  return { botUser: 'maestro-bot', trigger } as unknown as RepoSettings;
}

function fakeAdapter() {
  const calls: Array<[string, ...unknown[]]> = [];
  const adapter = {
    assignIssue: async (_r: RepoRef, iid: number, user: string) => {
      calls.push(['assignIssue', iid, user]);
    },
    setIssueLabels: async (_r: RepoRef, iid: number, set: string[], unset: string[]) => {
      calls.push(['setIssueLabels', iid, set, unset]);
    },
  } as unknown as ForgeAdapter;
  return { adapter, calls };
}

function deps(trigger: RepoSettings['trigger']) {
  const { adapter, calls } = fakeAdapter();
  return {
    calls,
    d: { adapterFor: () => adapter, settingsFor: () => settings(trigger) },
  };
}

describe('workOnIssue', () => {
  it('assigns the bot and does not label when no require_label is set', async () => {
    const { calls, d } = deps({ requireLabel: null, allowedActors: [] });
    const res = await workOnIssue(repo, 42, d);
    expect(res).toEqual({ ok: true });
    expect(calls).toContainEqual(['assignIssue', 42, 'maestro-bot']);
    expect(calls.some(([m]) => m === 'setIssueLabels')).toBe(false);
  });

  it('applies the trigger label when require_label is set', async () => {
    const { calls, d } = deps({ requireLabel: 'maestro::queued', allowedActors: [] });
    await workOnIssue(repo, 42, d);
    expect(calls).toContainEqual(['setIssueLabels', 42, ['maestro::queued'], []]);
  });

  it('warns when an allowlist excludes the bot (daemon will not auto-start)', async () => {
    const { d } = deps({ requireLabel: null, allowedActors: ['alice'] });
    const res = await workOnIssue(repo, 42, d);
    expect(res).toEqual({ ok: true, warning: 'actor-allowlist-blocks-autostart' });
  });

  it('does not warn when the allowlist includes the bot', async () => {
    const { d } = deps({ requireLabel: null, allowedActors: ['maestro-bot'] });
    const res = await workOnIssue(repo, 42, d);
    expect(res).toEqual({ ok: true });
  });
});
