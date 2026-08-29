import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigStore, botUserForHost, inferForge, parseConfig } from '../src/config/load-config.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// The stable example fixture (the live maestro.config.yaml is user data and changes).
const sample = readFileSync(resolve(repoRoot, 'maestro.config.example.yaml'), 'utf8');

describe('B0 — parse + validate', () => {
  it('parses the sample config and resolves durations→ms and sizes→bytes', () => {
    const r = parseConfig(sample);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.defaults.poll_interval_active).toBe(30_000);
      expect(r.value.defaults.workspaces.disk_cap).toBe(20 * 1024 ** 3);
      expect(r.value.defaults.workspaces.clone_filter).toBe('blob:none'); // #27 default
      expect(r.value.repos).toHaveLength(2);
    }
  });
});

describe('B0b — workspaces.clone_filter (#27)', () => {
  it('null opts back into full clones; a custom filter round-trips', () => {
    const nulled = sample.replace(/clone_filter:.*\n/, 'clone_filter: null\n');
    const r1 = parseConfig(nulled);
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.value.defaults.workspaces.clone_filter).toBeNull();

    const custom = sample.replace(/clone_filter:.*\n/, 'clone_filter: tree:0\n');
    const r2 = parseConfig(custom);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value.defaults.workspaces.clone_filter).toBe('tree:0');
  });
});

describe('B0c — defaults.agent selection (codex support)', () => {
  it('defaults to the claude agent with no command override', () => {
    const r = parseConfig(sample);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.defaults.agent.kind).toBe('claude');
      expect(r.value.defaults.agent.command).toBeUndefined();
    }
  });

  it('parses kind: codex and a command override', () => {
    const yaml = `
defaults:
  bot_user: maestro-bot
  agent:
    kind: codex
    command: /opt/bin/codex
forges:
  github:
    host: github.com
    token_env: T
repos: []
`;
    const r = parseConfig(yaml);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.defaults.agent.kind).toBe('codex');
      expect(r.value.defaults.agent.command).toBe('/opt/bin/codex');
    }
  });

  it('rejects an unknown agent kind', () => {
    const yaml = `
defaults:
  bot_user: b
  agent:
    kind: hermes
forges: {}
repos: []
`;
    expect(parseConfig(yaml).ok).toBe(false);
  });
});

describe('B0d — defaults.agent.runner selection (herdr support)', () => {
  it('defaults to the headless runner with herdr defaults filled in unused', () => {
    const r = parseConfig(sample);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.defaults.agent.runner).toBe('headless');
      expect(r.value.defaults.agent.herdr).toEqual({
        command: 'herdr',
        workspace_label: 'maestro',
        env: {},
      });
    }
  });

  it('parses runner: herdr with a herdr command/workspace_label override', () => {
    const yaml = `
defaults:
  bot_user: maestro-bot
  agent:
    kind: claude
    runner: herdr
    herdr:
      command: /opt/bin/herdr
      workspace_label: acme
forges:
  github:
    host: github.com
    token_env: T
repos: []
`;
    const r = parseConfig(yaml);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.defaults.agent.runner).toBe('herdr');
      expect(r.value.defaults.agent.herdr).toEqual({
        command: '/opt/bin/herdr',
        workspace_label: 'acme',
        env: {},
      });
    }
  });

  it('rejects an unknown runner value', () => {
    const yaml = `
defaults:
  bot_user: b
  agent:
    runner: tmux
forges: {}
repos: []
`;
    expect(parseConfig(yaml).ok).toBe(false);
  });
});

describe('B1 — invalid config rejected with a useful error', () => {
  it('rejects config missing required bot_user and carries the issue path', () => {
    const bad = 'defaults:\n  poll_interval_active: 30s\nforges: {}\nrepos: []\n';
    const r = parseConfig(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/bot_user/);
  });

  it('rejects non-YAML text', () => {
    const r = parseConfig(':::not yaml:::\n  - [');
    expect(r.ok).toBe(false);
  });
});

describe('B2 — host → ForgeKind inference', () => {
  const forges = {
    gitlab: { host: 'gitlab.com', token_env: 'MAESTRO_GITLAB_TOKEN' },
    github: { host: 'github.com', token_env: 'MAESTRO_GITHUB_TOKEN' },
  };

  it('infers gitlab and github from the url host', () => {
    expect(inferForge('gitlab.com/group/api', forges)).toBe('gitlab');
    expect(inferForge('github.com/org/web', forges)).toBe('github');
  });

  it('matches a self-hosted host configured in forges', () => {
    expect(
      inferForge('gitlab.acme.internal/team/svc', {
        gitlab: { host: 'gitlab.acme.internal', token_env: 'X' },
      }),
    ).toBe('gitlab');
  });

  it('throws on an unknown host', () => {
    expect(() => inferForge('bitbucket.org/x/y', forges)).toThrow();
  });

  it('infers from an array of forge entries (multi-host #33)', () => {
    const multi = {
      gitlab: [
        { host: 'gitlab.com', token_env: 'MAESTRO_GITLAB_TOKEN' },
        { host: 'git.digital-masters.de', token_env: 'MAESTRO_GITLAB_DM_TOKEN' },
      ],
      github: [{ host: 'github.com', token_env: 'MAESTRO_GITHUB_TOKEN' }],
    };
    expect(inferForge('gitlab.com/group/api', multi)).toBe('gitlab');
    expect(inferForge('git.digital-masters.de/team/project', multi)).toBe('gitlab');
    expect(inferForge('github.com/org/web', multi)).toBe('github');
  });
});

describe('B2b — per-host bot user (forge entry bot_user)', () => {
  const yaml = `
defaults:
  bot_user: l4ci
forges:
  gitlab:
    - host: gitlab.com
      token_env: A
    - host: git.acme.internal
      token_env: B
      bot_user: acme-bot
  github:
    host: github.com
    token_env: C
repos: []
`;

  it('resolves the entry bot_user for its host, the global default elsewhere', () => {
    const r = parseConfig(yaml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(botUserForHost('git.acme.internal', r.value)).toBe('acme-bot');
    expect(botUserForHost('gitlab.com', r.value)).toBe('l4ci');
    expect(botUserForHost('github.com', r.value)).toBe('l4ci');
    expect(botUserForHost('unknown.host', r.value)).toBe('l4ci'); // total: default, never throw
  });
});

describe('B2a — config schema accepts single or array forge entries', () => {
  it('parses a single forge entry (backward compat)', () => {
    const r = parseConfig(`
defaults:
  bot_user: maestro-bot
forges:
  gitlab:
    host: gitlab.com
    token_env: MAESTRO_GITLAB_TOKEN
repos: []
`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.forges.gitlab).toHaveLength(1);
      expect(r.value.forges.gitlab?.[0]?.host).toBe('gitlab.com');
    }
  });

  it('parses an array of forge entries (multi-host)', () => {
    const r = parseConfig(`
defaults:
  bot_user: maestro-bot
forges:
  gitlab:
    - host: gitlab.com
      token_env: MAESTRO_GITLAB_TOKEN
    - host: git.digital-masters.de
      token_env: MAESTRO_GITLAB_DM_TOKEN
repos: []
`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.forges.gitlab).toHaveLength(2);
      expect(r.value.forges.gitlab?.[1]?.host).toBe('git.digital-masters.de');
    }
  });
});

describe('B3 — hot-reload with validate-before-reload (§5)', () => {
  it('keeps the previous good config when the new text is invalid', () => {
    const store = new ConfigStore(parseConfigOrThrow(sample));
    const before = store.current;
    const r = store.reload('not: [valid');
    expect(r.ok).toBe(false);
    expect(store.current).toBe(before); // unchanged reference
  });

  it('swaps atomically on a valid reload', () => {
    const store = new ConfigStore(parseConfigOrThrow(sample));
    const next = sample.replace('global_max: 2', 'global_max: 4');
    const r = store.reload(next);
    expect(r.ok).toBe(true);
    expect(store.current.defaults.concurrency.global_max).toBe(4);
  });
});

function parseConfigOrThrow(text: string) {
  const r = parseConfig(text);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}
