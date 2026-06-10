// Forge wiring (compose/forge-wiring.ts) — the one home for forge-aware construction,
// tested through its own interface: token-env resolution, per-host botUser fallback,
// the missing-forge-entry error, and the WORKFLOW-cache → bootstrap-template fallback.
// Direct process.env/fs reads are in-contract for the composition layer, so the tests
// drive it with stubbed env vars + temp dirs (never the live user config).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composeForges, loadConfig, makeForgeAdapter } from '../src/compose/forge-wiring.js';
import { parseConfig } from '../src/config/load-config.js';
import type { MaestroConfig, RepoRef } from '../src/contracts/index.js';
import { slugifyProject } from '../src/workspace/paths.js';
import { FakeExec } from './helpers/fake-exec.js';

const CONFIG_YAML = `
defaults:
  bot_user: l4ci
forges:
  gitlab:
    - host: gitlab.com
      token_env: MAESTRO_TEST_GL_TOKEN
    - host: git.acme.internal
      token_env: MAESTRO_TEST_ACME_TOKEN
      bot_user: acme-bot
  github:
    - host: github.com
      token_env: MAESTRO_TEST_GH_TOKEN
repos: []
`;

function config(): MaestroConfig {
  const r = parseConfig(CONFIG_YAML);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

function ref(forge: 'gitlab' | 'github', host: string, project = 'group/api'): RepoRef {
  return { forge, host, project, url: `${host}/${project}` };
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'maestro-wiring-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

describe('forge wiring — adapter construction', () => {
  it('resolves the token from the forge entry token_env into the adapter env', async () => {
    vi.stubEnv('MAESTRO_TEST_GL_TOKEN', 'glpat-secret');
    const exec = new FakeExec().onApi('GET', '/issues', []);
    const { adapterFor } = composeForges(config(), exec);
    await adapterFor(ref('gitlab', 'gitlab.com')).listAssignedOpenIssues(
      ref('gitlab', 'gitlab.com'),
    );
    expect(exec.calls[0]?.opts?.env?.GITLAB_TOKEN).toBe('glpat-secret');
  });

  it('falls back to an empty token when the env var is unset (never throws)', async () => {
    const exec = new FakeExec().onApi('GET', '/issues', []);
    const { adapterFor } = composeForges(config(), exec);
    await adapterFor(ref('gitlab', 'gitlab.com')).listAssignedOpenIssues(
      ref('gitlab', 'gitlab.com'),
    );
    expect(exec.calls[0]?.opts?.env?.GITLAB_TOKEN).toBe('');
  });

  it('picks the adapter by forge kind', () => {
    const { adapterFor } = composeForges(config(), new FakeExec());
    expect(adapterFor(ref('gitlab', 'gitlab.com')).kind).toBe('gitlab');
    expect(adapterFor(ref('github', 'github.com')).kind).toBe('github');
  });

  it('caches per (forge, host) — same host reuses, second host gets its own', () => {
    const { adapterFor } = composeForges(config(), new FakeExec());
    const a = adapterFor(ref('gitlab', 'gitlab.com'));
    expect(adapterFor(ref('gitlab', 'gitlab.com', 'other/repo'))).toBe(a);
    expect(adapterFor(ref('gitlab', 'git.acme.internal'))).not.toBe(a);
  });

  it('resolves botUser per host: forge entry bot_user, else the global default', async () => {
    const exec = new FakeExec().onApi('GET', '/issues', []);
    const { adapterFor } = composeForges(config(), exec);
    const acme = ref('gitlab', 'git.acme.internal');
    await adapterFor(acme).listAssignedOpenIssues(acme);
    // the adapter queries issues assigned to ITS bot — per-host identity, not the default
    expect(exec.calls[0]?.args.join(' ')).toContain('assignee_username=acme-bot');
  });

  it('throws a clear error for a host with no configured forge entry', () => {
    const { adapterFor } = composeForges(config(), new FakeExec());
    expect(() => adapterFor(ref('gitlab', 'unknown.host'))).toThrow(
      "no gitlab forge configured for host 'unknown.host'",
    );
    expect(() =>
      makeForgeAdapter({ forge: 'github', host: 'ghe.missing' }, config(), new FakeExec()),
    ).toThrow("no github forge configured for host 'ghe.missing'");
  });
});

describe('forge wiring — static settings path', () => {
  it('falls back to the bootstrap template when the WORKFLOW cache file is absent', () => {
    vi.stubEnv('MAESTRO_WORKFLOWS_DIR', tmp); // empty → no cache for any repo
    vi.stubEnv('MAESTRO_TEMPLATE', 'templates/WORKFLOW.md');
    const { settingsFor } = composeForges(config(), new FakeExec());
    const s = settingsFor(ref('gitlab', 'gitlab.com'));
    expect(s.manageBoard).toBe(false); // bootstrap overlay, not the template's `true`
    expect(s.botUser).toBe('l4ci'); // default bot — no entry bot_user on gitlab.com
  });

  it('bootstrap fallback resolves botUser per host (forge entry bot_user)', () => {
    vi.stubEnv('MAESTRO_WORKFLOWS_DIR', tmp);
    vi.stubEnv('MAESTRO_TEMPLATE', 'templates/WORKFLOW.md');
    const { settingsFor } = composeForges(config(), new FakeExec());
    expect(settingsFor(ref('gitlab', 'git.acme.internal')).botUser).toBe('acme-bot');
  });

  it('reads the WORKFLOW cache when present (no bootstrap overlay)', () => {
    const repo = ref('gitlab', 'gitlab.com');
    const dir = join(tmp, slugifyProject(repo.project));
    mkdirSync(dir, { recursive: true });
    const cached = readFileSync('templates/WORKFLOW.md', 'utf8').replace(
      'bot_user: maestro-bot',
      'bot_user: cached-bot',
    );
    writeFileSync(join(dir, 'WORKFLOW.md'), cached);
    vi.stubEnv('MAESTRO_WORKFLOWS_DIR', tmp);
    const { settingsFor } = composeForges(config(), new FakeExec());
    const s = settingsFor(repo);
    expect(s.botUser).toBe('cached-bot');
    expect(s.manageBoard).toBe(true); // the committed workflow, not the bootstrap overlay
  });

  it('surfaces an invalid cached WORKFLOW as a clear per-repo error', () => {
    const repo = ref('gitlab', 'gitlab.com');
    const dir = join(tmp, slugifyProject(repo.project));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'WORKFLOW.md'), 'no front matter fence here');
    vi.stubEnv('MAESTRO_WORKFLOWS_DIR', tmp);
    const { settingsFor } = composeForges(config(), new FakeExec());
    expect(() => settingsFor(repo)).toThrow(/WORKFLOW invalid for group\/api/);
  });
});

describe('forge wiring — loadConfig', () => {
  it('reads + parses a config file', () => {
    const p = join(tmp, 'maestro.config.yaml');
    writeFileSync(p, CONFIG_YAML);
    expect(loadConfig(p).defaults.bot_user).toBe('l4ci');
  });

  it('throws the canonical message on an invalid config', () => {
    const p = join(tmp, 'maestro.config.yaml');
    writeFileSync(p, 'defaults: {}\nforges: {}\nrepos: []\n');
    expect(() => loadConfig(p)).toThrow(/config invalid/);
  });
});
