import { describe, expect, it, vi } from 'vitest';
import { BOOTSTRAP_PROMPT_BODY } from '../src/bootstrap/bootstrap-workflow.js';
import { ConfigStore, parseConfig } from '../src/config/load-config.js';
import {
  RepoSettingsCell,
  WatchedConfig,
  WorkflowCells,
  deriveCell,
} from '../src/daemon/reload.js';
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

// ---------------------------------------------------------------------------
// #107 — tagged deriveCell outcomes + the WorkflowCells swap policy around them.

const repo = {
  forge: 'gitlab' as const,
  host: 'gitlab.com',
  project: 'group/api',
  url: 'gitlab.com/group/api',
};

function fullConfig() {
  const r = parseConfig(CONFIG_API);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

function makeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const INVALID_WF = 'no front matter fence here';

describe('E4 — deriveCell tags its outcomes (#107)', () => {
  const config = fullConfig();
  const templateText = wf('squash'); // a perfectly usable bootstrap template

  it('a committed-but-invalid WORKFLOW is `invalid` (with the parse failure), never bootstrap', () => {
    const r = deriveCell({ repo, workflowText: INVALID_WF, templateText, config, log: makeLog() });

    // Even with a usable template at hand, a file the user wrote must not be papered
    // over with a bootstrap fallback — the tag says `invalid`, not `bootstrap`.
    expect(r).toMatchObject({
      ok: false,
      reason: 'invalid',
      error: expect.stringMatching(/front matter/),
    });
  });

  it('no committed WORKFLOW + usable template → a bootstrap cell', () => {
    const r = deriveCell({ repo, workflowText: undefined, templateText, config, log: makeLog() });

    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.cell.promptBody).toBe(BOOTSTRAP_PROMPT_BODY);
  });

  it('no committed WORKFLOW + unusable template → `bootstrap`', () => {
    const r = deriveCell({
      repo,
      workflowText: undefined,
      templateText: '',
      config,
      log: makeLog(),
    });

    expect(r).toEqual({ ok: false, reason: 'bootstrap' });
  });

  it('a valid committed WORKFLOW → a cell with resolved settings', () => {
    const r = deriveCell({
      repo,
      workflowText: wf('rebase'),
      templateText,
      config,
      log: makeLog(),
    });

    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.cell.settings.git.mergeStrategy).toBe('rebase');
  });
});

describe('E5 — WorkflowCells: skip loudly on invalid-without-prior, keep prior otherwise (#107)', () => {
  const config = fullConfig();
  const templateText = wf('squash');

  it('bootstrap repo + invalid committed WORKFLOW → repo skipped, error logged, no bootstrap path', () => {
    const log = makeLog();
    const cells = new WorkflowCells({ config, templateText, log });

    cells.seed(repo, INVALID_WF);

    // Skipped: no cell → the daemon builds no unit for it, so neither the normal
    // lifecycle nor the bootstrap "define my workflow" (PR) path can run on this repo.
    expect(cells.size).toBe(0);
    expect(cells.entries()).toEqual([]);
    expect(log.info).not.toHaveBeenCalled(); // no 'operating in bootstrap mode'
    // Loud: one error-level log naming the parse failure.
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(String(log.error.mock.calls[0]?.[0])).toMatch(/skipped/);
    expect(String(log.error.mock.calls[0]?.[1]?.error)).toMatch(/front matter/);
  });

  it('the invalid-text error logs once per distinct text (last-text dedupe)', () => {
    const log = makeLog();
    const cells = new WorkflowCells({ config, templateText, log });

    cells.seed(repo, INVALID_WF);
    cells.applyRemote(repo, INVALID_WF); // unchanged remote → no re-derive, no re-log
    expect(log.error).toHaveBeenCalledTimes(1);

    cells.applyRemote(repo, '---\nstill: broken'); // a DIFFERENT bad text → one more log
    expect(log.error).toHaveBeenCalledTimes(2);
  });

  it('a fixed WORKFLOW on a later refresh brings the skipped repo back', () => {
    const log = makeLog();
    const cells = new WorkflowCells({ config, templateText, log });
    cells.seed(repo, INVALID_WF);
    expect(cells.size).toBe(0);

    cells.applyRemote(repo, wf('rebase'));

    expect(cells.size).toBe(1);
    expect(cells.entries()[0]?.cell.settings.git.mergeStrategy).toBe('rebase');
  });

  it('valid prior cell + invalid refresh → the prior cell is kept (validate-before-swap)', () => {
    const log = makeLog();
    const cells = new WorkflowCells({ config, templateText, log });
    cells.seed(repo, wf('squash'));
    const prior = cells.entries()[0]?.cell;

    cells.applyRemote(repo, INVALID_WF);

    expect(cells.size).toBe(1);
    expect(cells.entries()[0]?.cell).toBe(prior); // same live cell, untouched
    expect(cells.entries()[0]?.cell.settings.git.mergeStrategy).toBe('squash');
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(String(log.error.mock.calls[0]?.[0])).toMatch(/keeping previous/);
  });

  it('a bootstrap repo swaps to the real WORKFLOW once the default branch gains one', () => {
    const log = makeLog();
    const cells = new WorkflowCells({ config, templateText, log });
    cells.seed(repo, undefined); // no cache → bootstrap mode
    expect(cells.entries()[0]?.cell.promptBody).toBe(BOOTSTRAP_PROMPT_BODY);
    expect(log.info).toHaveBeenCalledWith(
      'repo has no WORKFLOW.md yet — operating in bootstrap mode',
      {
        repo: 'group/api',
      },
    );

    cells.applyRemote(repo, wf('rebase'));

    expect(cells.entries()[0]?.cell.promptBody).toBe('body');
    expect(cells.entries()[0]?.cell.settings.git.mergeStrategy).toBe('rebase');
  });
});
