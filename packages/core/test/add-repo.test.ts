import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/load-config.js';
import type {
  CreateIssueArgs,
  ExecResult,
  ForgeAdapter,
  Issue,
  Label,
  RepoRef,
} from '../src/contracts/index.js';
import { BOOTSTRAP_MARKER, labelNames } from '../src/contracts/index.js';
import { addRepo } from '../src/onboarding/add-repo.js';
import { FakeExec } from './helpers/fake-exec.js';

const CONFIG = `# Maestro config
defaults:
  bot_user: maestro-bot
forges:
  gitlab:
    host: gitlab.com
    token_env: MAESTRO_GITLAB_TOKEN
  github:
    host: github.com
    token_env: MAESTRO_GITHUB_TOKEN
repos:
  - url: gitlab.com/group/api # the first repo
  - url: github.com/org/web
`;

const OK: ExecResult = { code: 0, stdout: '', stderr: '' };
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function tmpConfig(text = CONFIG): string {
  const dir = mkdtempSync(join(tmpdir(), 'maestro-add-'));
  roots.push(dir);
  const p = join(dir, 'maestro.config.yaml');
  writeFileSync(p, text);
  return p;
}

interface OnboardRecorder {
  adapter: ForgeAdapter;
  ensureLabelsArgs: Label[][];
  ensureBoardArgs: Label[][];
  createdIssues: CreateIssueArgs[];
}
function onboardAdapter(opts: { withBoard?: boolean } = {}): OnboardRecorder {
  const r: OnboardRecorder = {
    ensureLabelsArgs: [],
    ensureBoardArgs: [],
    createdIssues: [],
    adapter: undefined as unknown as ForgeAdapter,
  };
  const base: Partial<ForgeAdapter> = {
    kind: 'gitlab',
    ensureLabels: async (_repo, labels) => void r.ensureLabelsArgs.push(labels),
    createIssue: async (_repo, args): Promise<Issue> => {
      r.createdIssues.push(args);
      return {
        iid: 1,
        id: '1',
        title: args.title,
        body: args.body,
        state: 'open',
        assignees: [],
        labels: [],
        author: { username: 'x', id: 'x' },
        webUrl: 'u',
      };
    },
  };
  if (opts.withBoard !== false) {
    base.ensureBoard = async (_repo, labels) => void r.ensureBoardArgs.push(labels);
  }
  r.adapter = base as ForgeAdapter;
  return r;
}

function deps(
  configPath: string,
  exec = new FakeExec().on((c) => c.cmd === 'git', OK),
  rec = onboardAdapter(),
) {
  return {
    rec,
    exec,
    d: {
      exec,
      configPath,
      adapterFor: () => rec.adapter,
      hasWorkflow: () => false, // fresh repo, no WORKFLOW yet → bootstrap issue
    },
  };
}

describe('B1 — appends a repos[] entry, preserving comments', () => {
  it('adds the new url and keeps existing entries + comments', async () => {
    const p = tmpConfig();
    const { d } = deps(p);

    const res = await addRepo({ url: 'gitlab.com/group/new', commit: false }, d);

    expect(res.added).toBe(true);
    const text = readFileSync(p, 'utf8');
    expect(text).toContain('# Maestro config'); // header comment survives
    expect(text).toContain('# the first repo'); // inline comment survives
    const parsed = parseConfig(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const urls = parsed.value.repos.map((r) => r.url);
      expect(urls).toEqual(['gitlab.com/group/api', 'github.com/org/web', 'gitlab.com/group/new']);
    }
  });
});

describe('B2 — idempotent on an already-watched url', () => {
  it('does not double-append; returns added:false, already-watched', async () => {
    const p = tmpConfig();
    const { d } = deps(p);

    const res = await addRepo({ url: 'gitlab.com/group/api', commit: false }, d);

    expect(res).toEqual({ added: false, reason: 'already-watched' });
    const parsed = parseConfig(readFileSync(p, 'utf8'));
    expect(parsed.ok && parsed.value.repos).toHaveLength(2); // unchanged
  });
});

describe('B3 — forge inference rejects garbage with no side effects', () => {
  it('an unknown host → typed result, no file mutation, no adapter call', async () => {
    const p = tmpConfig();
    const { d, rec } = deps(p);
    const before = readFileSync(p, 'utf8');

    const res = await addRepo({ url: 'bitbucket.org/x/y', commit: false }, d);

    expect(res.added).toBe(false);
    expect(readFileSync(p, 'utf8')).toBe(before); // untouched
    expect(rec.ensureLabelsArgs).toHaveLength(0); // adapter never called
  });
});

describe('B4 — triggers §11 setup through the adapter', () => {
  it('ensures labels + board from labelNames, and a bootstrap issue when no WORKFLOW', async () => {
    const p = tmpConfig();
    const { d, rec } = deps(p);

    await addRepo({ url: 'gitlab.com/group/new', commit: false }, d);

    expect(rec.ensureLabelsArgs).toHaveLength(1);
    expect(rec.ensureLabelsArgs[0]?.map((l) => l.name)).toEqual(labelNames('gitlab').all());
    expect(rec.ensureBoardArgs).toHaveLength(1); // gitlab + board manageable
    expect(rec.createdIssues).toHaveLength(1);
    expect(rec.createdIssues[0]?.body).toContain(BOOTSTRAP_MARKER);
    expect(rec.createdIssues[0]?.assignToBot).toBe(true);
  });

  it('skips the bootstrap issue when a WORKFLOW already exists', async () => {
    const p = tmpConfig();
    const rec = onboardAdapter();
    const exec = new FakeExec().on((c) => c.cmd === 'git', OK);
    const res = await addRepo(
      { url: 'gitlab.com/group/new', commit: false },
      { exec, configPath: p, adapterFor: () => rec.adapter, hasWorkflow: () => true },
    );
    expect(res.added).toBe(true);
    expect(rec.createdIssues).toHaveLength(0);
  });

  it('never calls ensureBoard on a github repo (method undefined)', async () => {
    const p = tmpConfig();
    const rec = onboardAdapter({ withBoard: false });
    rec.adapter = { ...rec.adapter, kind: 'github' } as ForgeAdapter;
    const exec = new FakeExec().on((c) => c.cmd === 'git', OK);
    await addRepo(
      { url: 'github.com/org/new', commit: false },
      { exec, configPath: p, adapterFor: () => rec.adapter, hasWorkflow: () => false },
    );
    expect(rec.ensureBoardArgs).toHaveLength(0);
  });
});

describe('B5/B7 — commit by default stages ONLY the config path', () => {
  it('runs git add <config> then git commit with an imperative ≤72-char subject, no Co-Authored-By', async () => {
    const p = tmpConfig();
    const exec = new FakeExec().on((c) => c.cmd === 'git', OK);
    const { d } = deps(p, exec);

    await addRepo({ url: 'gitlab.com/group/new' }, d); // commit defaults true

    const git = exec.calls.filter((c) => c.cmd === 'git');
    const add = git.find((c) => c.args[0] === 'add');
    const commit = git.find((c) => c.args[0] === 'commit');
    expect(add?.args).toEqual(['add', p]); // explicit path only
    expect(add?.args).not.toContain('.');
    expect(add?.args).not.toContain('-A');
    expect(add?.args.some((a) => a.includes('.env'))).toBe(false);
    const subject = commit?.args[commit.args.indexOf('-m') + 1] ?? '';
    expect(subject.length).toBeLessThanOrEqual(72);
    expect(subject).toMatch(/^Add /); // imperative
    expect(subject).not.toMatch(/Co-Authored-By/i);
  });
});

describe('B6 — --no-commit makes zero git calls', () => {
  it('appends but never invokes git', async () => {
    const p = tmpConfig();
    const exec = new FakeExec().on((c) => c.cmd === 'git', OK);
    const { d } = deps(p, exec);

    await addRepo({ url: 'gitlab.com/group/new', commit: false }, d);

    expect(exec.calls.filter((c) => c.cmd === 'git')).toHaveLength(0);
  });
});
