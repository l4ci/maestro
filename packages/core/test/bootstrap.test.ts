import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  detectProof,
  inferDefaultBranch,
  inferWorkflowSeed,
} from '../src/bootstrap/infer-workflow-seed.js';
import { BOOTSTRAP_TITLE, onboard } from '../src/bootstrap/onboard.js';
import { BOOTSTRAP_MARKER } from '../src/contracts/bootstrap.js';
import {
  type CreateIssueArgs,
  type ForgeAdapter,
  type Issue,
  type Label,
  type RepoRef,
  WorkflowSchema,
} from '../src/contracts/index.js';
import { reconcile } from '../src/reconciler/reconcile.js';
import { FakeExec } from './helpers/fake-exec.js';

const TEMPLATE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../templates/WORKFLOW.md'),
  'utf8',
);

const gl: RepoRef = {
  forge: 'gitlab',
  host: 'gitlab.com',
  project: 'group/api',
  url: 'gitlab.com/group/api',
};
const gh: RepoRef = {
  forge: 'github',
  host: 'github.com',
  project: 'org/web',
  url: 'github.com/org/web',
};

/** A FakeExec that returns a scripted `git symbolic-ref` stdout. */
function gitExec(stdout: string, code = 0): FakeExec {
  return new FakeExec().on((c) => c.cmd === 'git', { code, stdout, stderr: '' });
}

function readerFrom(files: Record<string, string>): (rel: string) => string | undefined {
  return (rel) => files[rel];
}

// --- Slice 1: default branch ----------------------------------------------

describe('Slice 1 — inferDefaultBranch', () => {
  it('reads origin/HEAD from the cloned repo (cwd, no network)', async () => {
    const exec = gitExec('origin/develop\n');
    expect(await inferDefaultBranch(exec, '/ws/clone')).toBe('develop');
    const call = exec.calls[0];
    expect(call?.args).toContain('-C');
    expect(call?.args).toContain('/ws/clone'); // probe runs in the clone dir
    expect(call?.args).toContain('refs/remotes/origin/HEAD');
  });

  it('falls back to main when the probe is inconclusive', async () => {
    expect(await inferDefaultBranch(gitExec('', 1), '/ws/clone')).toBe('main');
  });
});

// --- Slice 2: proof / framework detection (pure) --------------------------

describe('Slice 2 — detectProof (pure over injected fs)', () => {
  it('playwright dependency → playwright proof', () => {
    const proof = detectProof(
      readerFrom({
        'package.json': JSON.stringify({
          scripts: { test: 'playwright test' },
          devDependencies: { '@playwright/test': '^1' },
        }),
      }),
    );
    expect(proof.type).toBe('playwright');
    expect(proof.command).toMatch(/playwright/);
  });

  it('a plain test script → test-output', () => {
    const proof = detectProof(
      readerFrom({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) }),
    );
    expect(proof).toEqual({ type: 'test-output', command: 'npm test' });
  });

  it('the npm-init placeholder test script → none', () => {
    const proof = detectProof(
      readerFrom({
        'package.json': JSON.stringify({
          scripts: { test: 'echo "Error: no test specified" && exit 1' },
        }),
      }),
    );
    expect(proof.type).toBe('none');
  });

  it('a non-Node repo with a pyproject → test-output (pytest)', () => {
    expect(detectProof(readerFrom({ 'pyproject.toml': '[project]\nname="x"' }))).toEqual({
      type: 'test-output',
      command: 'pytest',
    });
  });

  it('nothing detectable → none (the floor)', () => {
    expect(detectProof(readerFrom({}))).toEqual({ type: 'none' });
  });
});

// --- Slice 3: seed is well-formed & passes WorkflowSchema ------------------

describe('Slice 3 — inferWorkflowSeed renders a schema-valid seed', () => {
  it('merges inferred facts and parses clean through the M1 loader', async () => {
    const seed = await inferWorkflowSeed(gl, {
      exec: gitExec('origin/trunk\n'),
      clonedDir: '/ws/clone',
      templateText: TEMPLATE,
      readFile: readerFrom({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) }),
      botUser: 'maestro-bot',
    });
    // schema-valid (loader already validated; re-assert the public schema too)
    expect(() => WorkflowSchema.parse(seed.frontMatter)).not.toThrow();
    expect(seed.frontMatter.project).toBe('group/api');
    expect(seed.frontMatter.forge).toBe('gitlab');
    expect(seed.frontMatter.bot_user).toBe('maestro-bot');
    expect(seed.frontMatter.git.default_branch).toBe('trunk');
    expect(seed.frontMatter.git.target).toBe('trunk');
    expect(seed.frontMatter.proof).toEqual([{ type: 'test-output', command: 'npm test' }]);
    // schema defaults still carried
    expect(seed.frontMatter.manage_board).toBe(true);
    expect(seed.frontMatter.git.merge_strategy).toBe('squash');
    expect(seed.frontMatter.claude.max_turns).toBe(40);
    // the operating-protocol prompt body survives
    expect(seed.promptBody).toContain('Agent operating protocol');
  });

  it('a fresh repo with no detectable proof still yields a valid `none` seed', async () => {
    const seed = await inferWorkflowSeed(gh, {
      exec: gitExec('origin/main\n'),
      clonedDir: '/ws/clone',
      templateText: TEMPLATE,
      readFile: readerFrom({}),
      botUser: 'maestro-bot',
    });
    expect(seed.frontMatter.proof[0]?.type).toBe('none');
    expect(seed.frontMatter.forge).toBe('github');
  });

  it('NEGATIVE: a seed missing proof.type fails the schema (validated, not trusted)', () => {
    // simulate a malformed render — proof block without the required `type`
    const bad = TEMPLATE.replace(
      /proof:.*\n(\s+type:.*\n)(\s+command:.*\n)/,
      'proof:\n  command: "x"\n',
    );
    const parsed = WorkflowSchema.safeParse({
      project: 'a/b',
      bot_user: 'x',
      proof: { command: 'x' },
      git: {},
    });
    expect(parsed.success).toBe(false);
    expect(bad).not.toContain('type: playwright'); // sanity: the type really was stripped
  });
});

// --- Part B: onboard spy adapter ------------------------------------------

interface Rec {
  adapter: ForgeAdapter;
  labels: Label[][];
  boards: Label[][];
  created: CreateIssueArgs[];
}
function spyAdapter(opts: { kind?: 'gitlab' | 'github'; openIssues?: Issue[] } = {}): Rec {
  const rec: Rec = {
    labels: [],
    boards: [],
    created: [],
    adapter: undefined as unknown as ForgeAdapter,
  };
  const base: Partial<ForgeAdapter> = {
    kind: opts.kind ?? 'gitlab',
    listAssignedOpenIssues: async () => opts.openIssues ?? [],
    ensureLabels: async (_r, labels) => void rec.labels.push(labels),
    createIssue: async (_r, args): Promise<Issue> => {
      rec.created.push(args);
      return mkIssue({ iid: 1, body: args.body });
    },
  };
  if ((opts.kind ?? 'gitlab') === 'gitlab') {
    base.ensureBoard = async (_r, labels) => void rec.boards.push(labels);
  }
  rec.adapter = base as ForgeAdapter;
  return rec;
}
function mkIssue(over: Partial<Issue> = {}): Issue {
  return {
    iid: 1,
    id: '1',
    title: 't',
    body: '',
    state: 'open',
    assignees: [],
    labels: [],
    author: { username: 'a', id: 'a' },
    webUrl: 'u',
    ...over,
  };
}

// --- Slice 4: add-when-missing trigger ------------------------------------

describe('Slice 4 — onboard opens the bootstrap issue only when WORKFLOW.md is absent', () => {
  it('no WORKFLOW → ensures labels+board then opens ONE self-assigned "define" issue with the seed', async () => {
    const rec = spyAdapter();
    const out = await onboard(gl, {
      adapter: rec.adapter,
      hasWorkflow: false,
      seed: async () => ({ text: 'SEED-YAML', frontMatter: {} as never, promptBody: '' }),
    });
    expect(out.openedIssue).toBe(true);
    expect(rec.labels).toHaveLength(1);
    expect(rec.boards).toHaveLength(1); // gitlab
    expect(rec.created).toHaveLength(1);
    expect(rec.created[0]?.title).toBe(BOOTSTRAP_TITLE);
    expect(rec.created[0]?.title.toLowerCase()).toContain('define');
    expect(rec.created[0]?.assignToBot).toBe(true);
    expect(rec.created[0]?.body).toContain('SEED-YAML'); // seed attached for the agent
    expect(rec.created[0]?.body).toContain(BOOTSTRAP_MARKER);
  });

  it('WORKFLOW already exists → labels still ensured, ZERO createIssue (no-op trigger)', async () => {
    const rec = spyAdapter();
    const out = await onboard(gl, { adapter: rec.adapter, hasWorkflow: true });
    expect(out.openedIssue).toBe(false);
    expect(rec.labels).toHaveLength(1); // idempotent setup still runs
    expect(rec.created).toHaveLength(0);
  });

  it('GitHub onboarding never calls ensureBoard (labels only)', async () => {
    const rec = spyAdapter({ kind: 'github' });
    await onboard(gh, { adapter: rec.adapter, hasWorkflow: false });
    expect(rec.boards).toHaveLength(0);
    expect(rec.created).toHaveLength(1);
  });
});

// --- Slice 5: idempotent re-onboard ---------------------------------------

describe('Slice 5 — onboard does not open a second bootstrap issue', () => {
  it('an existing open marker issue → no createIssue', async () => {
    const existing = mkIssue({ iid: 9, body: `older bootstrap\n${BOOTSTRAP_MARKER}` });
    const rec = spyAdapter({ openIssues: [existing] });
    const out = await onboard(gl, { adapter: rec.adapter, hasWorkflow: false });
    expect(out).toMatchObject({ openedIssue: false, reason: 'already-open' });
    expect(rec.created).toHaveLength(0);
  });
});

// --- Slice 6: bootstrap issue flows through the EXISTING lifecycle ---------

describe('Slice 6 — no new path: the bootstrap issue is just a New issue', () => {
  it('reconcile yields the standard start-new intent for the bootstrap issue', () => {
    const bootstrapIssue = mkIssue({
      iid: 1,
      body: `Maestro is now watching this repo.\n${BOOTSTRAP_MARKER}`,
      assignees: [{ username: 'maestro-bot', id: 'b' }],
      labels: [], // New: assigned to bot, no maestro:: label
    });
    const intent = reconcile({
      snapshot: { repo: gl, issue: bootstrapIssue, recentComments: [] },
      settings: {
        repo: gl,
        botUser: 'maestro-bot',
        trigger: { requireLabel: null, allowedActors: [] },
        git: {
          defaultBranch: 'main',
          target: 'main',
          mergeStrategy: 'squash',
          deleteSourceBranch: true,
        },
        manageBoard: true,
        labels: {
          inProgress: 'maestro::in-progress',
          inReview: 'maestro::in-review',
          blocked: 'maestro::blocked',
          all: () => [],
        },
        concurrency: { globalMax: 2, maxActive: 2 },
      },
      slotAvailable: true,
      workspaceExists: false,
      workComplete: false,
    });
    expect(intent.kind).toBe('start-new'); // identical to any other New issue — no bootstrap branch
  });

  it('the reconciler and daemon-tick modules contain no bootstrap/onboard identifier', () => {
    const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
    const reconcileSrc = readFileSync(resolve(dir, 'reconciler/reconcile.ts'), 'utf8');
    const tickSrc = readFileSync(resolve(dir, 'daemon/tick.ts'), 'utf8');
    expect(reconcileSrc.toLowerCase()).not.toMatch(/bootstrap|onboard/);
    expect(tickSrc.toLowerCase()).not.toMatch(/bootstrap|onboard/);
  });
});
