// Forge wiring (#90) — the ONE home for forge-aware construction. Tested through its
// own interface: token-env resolution, botUser per-host fallback, adapter caching per
// (forge, host), the missing-forge-entry error, and the static settings path with its
// bootstrap-template fallback when the WORKFLOW cache is absent.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config/load-config.js';
import type { MaestroConfig, RepoRef } from '../src/contracts/index.js';
import { GithubAdapter } from '../src/forge/github/github-adapter.js';
import { GitlabAdapter } from '../src/forge/gitlab/gitlab-adapter.js';
import { composeForges, loadConfigFile, makeForgeAdapter } from '../src/forge/wiring.js';
import { slugifyProject } from '../src/workspace/paths.js';
import { FakeExec } from './helpers/fake-exec.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const realTemplate = resolve(repoRoot, 'templates/WORKFLOW.md');

const CONFIG_YAML = `
defaults:
  bot_user: default-bot
forges:
  gitlab:
    - host: gitlab.example.com
      token_env: TEST_WIRING_GL_TOKEN
      bot_user: gl-bot
  github:
    - host: github.com
      token_env: TEST_WIRING_GH_TOKEN
repos:
  - url: gitlab.example.com/group/api
  - url: github.com/acme/site
`;

function config(): MaestroConfig {
  const parsed = parseConfig(CONFIG_YAML);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

const glRepo: RepoRef = {
  forge: 'gitlab',
  host: 'gitlab.example.com',
  project: 'group/api',
  url: 'gitlab.example.com/group/api',
};
const ghRepo: RepoRef = {
  forge: 'github',
  host: 'github.com',
  project: 'acme/site',
  url: 'github.com/acme/site',
};

const WORKFLOW_MD = `---
forge: gitlab
project: group/api
bot_user: wf-bot
proof:
  type: none
git: {}
---
# Workflow body
`;

afterEach(() => vi.unstubAllEnvs());

describe('composeForges — adapterFor', () => {
  it('resolves the token from the forge entry token_env into the adapter env', async () => {
    vi.stubEnv('TEST_WIRING_GL_TOKEN', 'glpat-wired');
    const fake = new FakeExec().onApi('GET', '/issues', []);
    const { adapterFor } = composeForges(config(), fake);
    await adapterFor(glRepo).listAssignedOpenIssues(glRepo);
    const call = fake.callsTo('GET', '/issues')[0];
    expect(call?.opts?.env?.GITLAB_TOKEN).toBe('glpat-wired');
    expect(call?.args.join(' ')).not.toContain('glpat-wired'); // env, never argv
  });

  it('falls back to an empty token when the env var is unset', async () => {
    const fake = new FakeExec().onApi('GET', '/issues', []);
    const { adapterFor } = composeForges(config(), fake);
    await adapterFor(glRepo).listAssignedOpenIssues(glRepo);
    expect(fake.callsTo('GET', '/issues')[0]?.opts?.env?.GITLAB_TOKEN).toBe('');
  });

  it("botUser per host: the forge entry's bot_user wins, defaults.bot_user is the fallback", async () => {
    const fake = new FakeExec().onApi('GET', '/issues', []);
    const { adapterFor } = composeForges(config(), fake);
    await adapterFor(glRepo).listAssignedOpenIssues(glRepo); // entry declares gl-bot
    expect(fake.callsTo('GET', '/issues')[0]?.args.join(' ')).toContain('assignee_username=gl-bot');
    await adapterFor(ghRepo).listAssignedOpenIssues(ghRepo); // entry has no bot_user
    expect(fake.callsTo('GET', '/issues')[1]?.args.join(' ')).toContain('assignee=default-bot');
  });

  it('constructs the forge-matching adapter class', () => {
    const { adapterFor } = composeForges(config(), new FakeExec());
    expect(adapterFor(glRepo)).toBeInstanceOf(GitlabAdapter);
    expect(adapterFor(ghRepo)).toBeInstanceOf(GithubAdapter);
  });

  it('caches one adapter per (forge, host)', () => {
    const { adapterFor } = composeForges(config(), new FakeExec());
    expect(adapterFor(glRepo)).toBe(adapterFor(glRepo));
    expect(adapterFor(glRepo)).not.toBe(adapterFor(ghRepo));
  });

  it('fails with a clear message when no forge entry matches the host', () => {
    const { adapterFor } = composeForges(config(), new FakeExec());
    const stranger: RepoRef = { ...glRepo, host: 'nowhere.example.com' };
    expect(() => adapterFor(stranger)).toThrow(
      "no gitlab forge configured for host 'nowhere.example.com'",
    );
  });
});

describe('composeForges — settingsFor (static settings path)', () => {
  it('derives settings from the cached WORKFLOW.md when present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wiring-'));
    mkdirSync(join(dir, slugifyProject(glRepo.project)));
    writeFileSync(join(dir, slugifyProject(glRepo.project), 'WORKFLOW.md'), WORKFLOW_MD);
    vi.stubEnv('MAESTRO_WORKFLOWS_DIR', dir);
    const { settingsFor } = composeForges(config(), new FakeExec());
    const s = settingsFor(glRepo);
    expect(s.botUser).toBe('wf-bot');
    expect(s.manageBoard).toBe(true); // WorkflowSchema default — NOT the bootstrap build
  });

  it('falls back to the bootstrap template when the WORKFLOW cache is absent', () => {
    vi.stubEnv('MAESTRO_WORKFLOWS_DIR', mkdtempSync(join(tmpdir(), 'wiring-empty-')));
    vi.stubEnv('MAESTRO_TEMPLATE', realTemplate);
    const { settingsFor } = composeForges(config(), new FakeExec());
    const s = settingsFor(glRepo);
    expect(s.botUser).toBe('gl-bot'); // botUserForHost: forge entry bot_user
    expect(s.manageBoard).toBe(false); // bootstrap build pins manage_board: false
  });

  it('surfaces an invalid cached WORKFLOW.md as a clear error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wiring-bad-'));
    mkdirSync(join(dir, slugifyProject(glRepo.project)));
    writeFileSync(join(dir, slugifyProject(glRepo.project), 'WORKFLOW.md'), 'no front matter');
    vi.stubEnv('MAESTRO_WORKFLOWS_DIR', dir);
    const { settingsFor } = composeForges(config(), new FakeExec());
    expect(() => settingsFor(glRepo)).toThrow(/WORKFLOW invalid for group\/api/);
  });
});

describe('makeForgeAdapter — bare per-entry constructor (daemon upfront build)', () => {
  it('builds an adapter straight from a forge entry', async () => {
    vi.stubEnv('TEST_WIRING_GH_TOKEN', 'gho-wired');
    const cfg = config();
    const entry = cfg.forges.github?.[0];
    if (!entry) throw new Error('fixture broke');
    const fake = new FakeExec().onApi('GET', '/issues', []);
    const a = makeForgeAdapter('github', entry, cfg, fake);
    expect(a).toBeInstanceOf(GithubAdapter);
    await a.listAssignedOpenIssues(ghRepo);
    expect(fake.callsTo('GET', '/issues')[0]?.opts?.env?.GH_TOKEN).toBe('gho-wired');
  });
});

describe('loadConfigFile', () => {
  it('parses a valid config file', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'wiring-cfg-')), 'maestro.config.yaml');
    writeFileSync(p, CONFIG_YAML);
    expect(loadConfigFile(p).defaults.bot_user).toBe('default-bot');
  });

  it('throws `config invalid` on a schema violation', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'wiring-cfg-bad-')), 'maestro.config.yaml');
    writeFileSync(p, 'defaults: {}\nforges: {}\nrepos: []\n');
    expect(() => loadConfigFile(p)).toThrow(/config invalid/);
  });
});
