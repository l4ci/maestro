// openBootstrapWorkflowPr — the add-side that opens a linked draft PR carrying a sample
// WORKFLOW.md. Fakes the workspace (no real clone/push) and adapter (no real forge); the
// only real exec call is inferWorkflowSeed's default-branch probe, matched by FakeExec.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openBootstrapWorkflowPr } from '../src/bootstrap/bootstrap-pr.js';
import type { CreateMRArgs, ForgeAdapter, MergeRequest, RepoRef } from '../src/contracts/index.js';
import { BOOTSTRAP_MARKER } from '../src/contracts/index.js';
import { FakeExec } from './helpers/fake-exec.js';

const TEMPLATE = readFileSync('templates/WORKFLOW.md', 'utf8'); // the real M0 template
const repo: RepoRef = {
  forge: 'github',
  host: 'github.com',
  project: 'l4ci/maestro',
  url: 'github.com/l4ci/maestro',
};

function fakeWorkspace() {
  const calls = {
    ensure: [] as { iid: number; fromRef: string }[],
    prepare: [] as { branch: string }[],
    commitPush: [] as { paths: string[]; branch: string; message: string }[],
  };
  const ws = {
    ensureWorkspace: async (r: RepoRef, iid: number, fromRef: string) => {
      calls.ensure.push({ iid, fromRef });
      return { dir: '/tmp/ws', repo: r, iid };
    },
    prepareBranch: async (_h: { dir: string }, branch: string) =>
      void calls.prepare.push({ branch }),
    commitAndPush: async (
      _h: { dir: string },
      opts: { paths: string[]; branch: string; message: string },
    ) => void calls.commitPush.push(opts),
  };
  return { ws, calls };
}

function fakeAdapter() {
  const created: CreateMRArgs[] = [];
  const mr = { iid: 7, id: '7', title: 't', sourceBranch: 'b' } as unknown as MergeRequest;
  const adapter = {
    kind: 'github',
    createDraftMR: async (_r: RepoRef, args: CreateMRArgs): Promise<MergeRequest> => {
      created.push(args);
      return mr;
    },
  } as unknown as ForgeAdapter;
  return { adapter, created, mr };
}

describe('openBootstrapWorkflowPr', () => {
  it('clones, infers a sample WORKFLOW.md, pushes a branch, opens a draft PR closing the issue', async () => {
    const exec = new FakeExec().on((c) => c.cmd === 'git' && c.args.includes('symbolic-ref'), {
      code: 0,
      stdout: 'origin/main\n',
      stderr: '',
    });
    const { ws, calls } = fakeWorkspace();
    const { adapter, created, mr } = fakeAdapter();
    const writes: { path: string; contents: string }[] = [];

    const result = await openBootstrapWorkflowPr(repo, 42, {
      workspace: ws,
      adapter,
      exec,
      templateText: TEMPLATE,
      botUser: 'l4ci',
      readFile: (_dir, rel) =>
        rel === 'package.json' ? '{"scripts":{"test":"vitest"}}' : undefined,
      writeFile: (path, contents) => void writes.push({ path, contents }),
    });

    // cloned for this issue, off HEAD
    expect(calls.ensure[0]).toMatchObject({ iid: 42, fromRef: 'HEAD' });

    // wrote a schema-valid seed carrying the inferred facts
    const wf = writes.find((w) => w.path.endsWith('WORKFLOW.md'));
    expect(wf).toBeDefined();
    expect(wf?.contents).toContain('project: l4ci/maestro');
    expect(wf?.contents).toContain('test-output'); // detected from the package.json test script

    // branch + EXPLICIT-path push (never `git add .`)
    expect(calls.prepare[0]?.branch).toBe('maestro/issue-42-define-workflow');
    expect(calls.commitPush[0]).toMatchObject({
      paths: ['WORKFLOW.md'],
      branch: 'maestro/issue-42-define-workflow',
    });

    // draft PR, base = inferred default branch, links + marks the bootstrap issue
    expect(created[0]).toMatchObject({
      sourceBranch: 'maestro/issue-42-define-workflow',
      targetBranch: 'main',
      draft: true,
    });
    expect(created[0]?.description).toContain('Closes #42');
    expect(created[0]?.description).toContain(BOOTSTRAP_MARKER);

    expect(result).toBe(mr);
  });
});
