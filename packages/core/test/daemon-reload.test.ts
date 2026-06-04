import { describe, expect, it, vi } from 'vitest';
import { ConfigStore, parseConfig } from '../src/config/load-config.js';
import { RepoSettingsCell, WatchedConfig } from '../src/daemon/reload.js';
import { WorkflowStore, parseWorkflow } from '../src/workflow/load-workflow.js';

// Part E — hot-reload (§5). Validation lives in M1's stores (validate-before-reload);
// M5 wires watcher → store → live-state re-derivation and logs the rejected path.

const CONFIG_API = `
defaults:
  bot_user: maestro-bot
forges:
  gitlab:
    host: gitlab.com
    token_env: MAESTRO_GITLAB_TOKEN
repos:
  - url: gitlab.com/group/api
`;
const CONFIG_API_WEB = `
defaults:
  bot_user: maestro-bot
forges:
  gitlab:
    host: gitlab.com
    token_env: MAESTRO_GITLAB_TOKEN
repos:
  - url: gitlab.com/group/web
`;

function configStore(text: string): ConfigStore {
  const r = parseConfig(text);
  if (!r.ok) throw new Error(r.error);
  return new ConfigStore(r.value);
}

const wf = (mergeStrategy: string) => `---
project: group/api
bot_user: maestro-bot
proof:
  type: diff-summary
git:
  merge_strategy: ${mergeStrategy}
---
body`;

describe('E1 — valid config reload re-derives the watch set', () => {
  it('adds the new repo and drops the removed one', () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const wc = new WatchedConfig(configStore(CONFIG_API), log);
    expect(wc.watchSet.map((r) => r.project)).toEqual(['group/api']);

    const ok = wc.reload(CONFIG_API_WEB);

    expect(ok).toBe(true);
    expect(wc.watchSet.map((r) => r.project)).toEqual(['group/web']); // api dropped, web added
  });
});

describe('E2 — invalid config reload keeps the old value + logs', () => {
  it('ignores malformed text and logs the rejected path', () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const wc = new WatchedConfig(configStore(CONFIG_API), log);

    const ok = wc.reload('defaults: {}\nforges: {}\nrepos: not-an-array');

    expect(ok).toBe(false);
    expect(wc.watchSet.map((r) => r.project)).toEqual(['group/api']); // unchanged
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(String(log.error.mock.calls[0][1]?.error)).toMatch(/config invalid|repos/);
  });
});

describe('E3 — valid WORKFLOW reload re-derives RepoSettings', () => {
  const repo = {
    forge: 'gitlab' as const,
    host: 'gitlab.com',
    project: 'group/api',
    url: 'gitlab.com/group/api',
  };
  const defaults =
    parseConfig(CONFIG_API).ok &&
    (parseConfig(CONFIG_API) as { value: { defaults: unknown } }).value.defaults;

  function makeCell() {
    const r = parseWorkflow(wf('squash'), 'gitlab.com');
    if (!r.ok) throw new Error(r.error);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    return {
      cell: new RepoSettingsCell({
        repo,
        store: new WorkflowStore(r.value, 'gitlab.com'),
        defaults: defaults as never,
        log,
      }),
      log,
    };
  }

  it('a new merge_strategy flows into the resolved settings', () => {
    const { cell } = makeCell();
    expect(cell.settings.git.mergeStrategy).toBe('squash');

    const ok = cell.reload(wf('rebase'));

    expect(ok).toBe(true);
    expect(cell.settings.git.mergeStrategy).toBe('rebase');
  });

  it('an invalid WORKFLOW keeps the old settings + logs', () => {
    const { cell, log } = makeCell();

    const ok = cell.reload('no front matter fence here');

    expect(ok).toBe(false);
    expect(cell.settings.git.mergeStrategy).toBe('squash'); // unchanged
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});
