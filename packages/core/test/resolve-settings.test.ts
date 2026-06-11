import { describe, expect, it } from 'vitest';
import { resolveRepoSettings } from '../src/config/resolve-settings.js';
import { ConfigSchema, WorkflowSchema } from '../src/contracts/index.js';
import type { MaestroConfig, RepoRef, WorkflowFrontMatter } from '../src/contracts/index.js';
import { labelNames } from '../src/contracts/labels.js';

const repo: RepoRef = {
  forge: 'gitlab',
  host: 'gitlab.com',
  project: 'group/api',
  url: 'gitlab.com/group/api',
};

const defaults: MaestroConfig['defaults'] = ConfigSchema.parse({
  defaults: { bot_user: 'config-bot' },
  forges: {},
  repos: [],
}).defaults;

function workflow(over: Record<string, unknown> = {}): WorkflowFrontMatter {
  return WorkflowSchema.parse({
    project: 'group/api',
    bot_user: 'wf-bot',
    proof: { type: 'test-output', command: 'npm test' },
    git: {},
    ...over,
  });
}

describe('D0 — merge into the frozen RepoSettings shape', () => {
  it('maps snake_case WORKFLOW fields to the camelCase RepoSettings', () => {
    const s = resolveRepoSettings({ repo, workflow: workflow(), defaults });
    expect(s.repo).toBe(repo);
    expect(s.git).toEqual({
      defaultBranch: 'main',
      target: 'main',
      mergeStrategy: 'squash',
      deleteSourceBranch: true,
    });
    expect(s.manageBoard).toBe(true);
    expect(s.labels.all()).toEqual(labelNames('gitlab').all());
    expect(s.labels.inProgress).toBe('maestro::in-progress');
    expect(s.concurrency.globalMax).toBe(2);
  });

  it('bot_user precedence: WORKFLOW wins, config default is fallback (AM-5)', () => {
    expect(resolveRepoSettings({ repo, workflow: workflow(), defaults }).botUser).toBe('wf-bot');
    const noWfBot = WorkflowSchema.parse({
      project: 'group/api',
      bot_user: '',
      proof: { type: 'none' },
      git: {},
    });
    expect(resolveRepoSettings({ repo, workflow: noWfBot, defaults }).botUser).toBe('config-bot');
  });
});

describe('D1 — concurrency precedence (operator override > WORKFLOW > implicit)', () => {
  it('uses WORKFLOW max_active when no operator override', () => {
    const s = resolveRepoSettings({
      repo,
      workflow: workflow({ concurrency: { max_active: 3 } }),
      defaults,
    });
    expect(s.concurrency.maxActive).toBe(3);
  });

  it('operator config override beats the WORKFLOW value (safety: caps a semi-trusted repo)', () => {
    const s = resolveRepoSettings({
      repo,
      workflow: workflow({ concurrency: { max_active: 9 } }),
      defaults,
      override: { concurrency: { max_active: 1 } },
    });
    expect(s.concurrency.maxActive).toBe(1);
  });
});

describe('D3 — CI gate opt-in (#118 / #120)', () => {
  it('defaults the full ci block: gate off, wait_timeout 20m, 3 fix rounds', () => {
    const s = resolveRepoSettings({ repo, workflow: workflow(), defaults });
    expect(s.ci).toEqual({ gate: false, waitTimeoutSeconds: 1200, maxFixRounds: 3 });
  });

  it('carries the full WORKFLOW ci block through', () => {
    const s = resolveRepoSettings({
      repo,
      workflow: workflow({
        ci: { gate: true, wait_timeout_seconds: 600, max_fix_rounds: 5 },
      }),
      defaults,
    });
    expect(s.ci).toEqual({ gate: true, waitTimeoutSeconds: 600, maxFixRounds: 5 });
  });

  it('fills ci defaults when only gate is set (back-compat with the MVP block)', () => {
    const s = resolveRepoSettings({ repo, workflow: workflow({ ci: { gate: true } }), defaults });
    expect(s.ci).toEqual({ gate: true, waitTimeoutSeconds: 1200, maxFixRounds: 3 });
  });
});

describe('D2 — TriggerGuard mapping fidelity (§13.1 → §0.4)', () => {
  it('maps default trigger to {requireLabel:null, allowedActors:[]}', () => {
    const s = resolveRepoSettings({ repo, workflow: workflow(), defaults });
    expect(s.trigger).toEqual({ requireLabel: null, allowedActors: [] });
  });

  it('carries require_label and allowed_actors through', () => {
    const s = resolveRepoSettings({
      repo,
      workflow: workflow({ trigger: { require_label: 'ok', allowed_actors: ['a', 'b'] } }),
      defaults,
    });
    expect(s.trigger).toEqual({ requireLabel: 'ok', allowedActors: ['a', 'b'] });
  });
});
