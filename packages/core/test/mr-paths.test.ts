import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecResult, RepoRef } from '../src/contracts/index.js';
import { resolveMrWorkspacePath, resolveWorkspacePath } from '../src/workspace/paths.js';
import { WorkspaceManager } from '../src/workspace/workspace-manager.js';
import { FakeExec } from './helpers/fake-exec.js';

// The command-MR pass (§MR-command, spec §7) keys its workspaces `mr-<iid>` so a
// command MR can never collide with the issue workspace of the same number, and the
// cleanup sweep can tell the two kinds apart from the dir name alone.

const repo: RepoRef = {
  forge: 'gitlab',
  host: 'gitlab.com',
  project: 'group/repo',
  url: 'gitlab.com/group/repo',
};

describe('resolveMrWorkspacePath', () => {
  it('keys MR workspaces distinctly from issue workspaces of the same iid', () => {
    const root = '/tmp/ws';
    const mr = resolveMrWorkspacePath(root, repo, 7);
    const issue = resolveWorkspacePath(root, repo, 7);
    expect(mr).not.toBe(issue);
    expect(mr.endsWith('/mr-7')).toBe(true);
    expect(issue.endsWith('/7')).toBe(true);
  });

  it('rejects a negative or non-integer MR iid (path-escape guard, §13)', () => {
    expect(() => resolveMrWorkspacePath('/tmp/ws', repo, -1)).toThrow();
    expect(() => resolveMrWorkspacePath('/tmp/ws', repo, 1.5)).toThrow();
  });
});

const OK: ExecResult = { code: 0, stdout: '', stderr: '' };
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) if (existsSync(r)) rmSync(r, { recursive: true, force: true });
});
function mgr() {
  const root = mkdtempSync(join(tmpdir(), 'maestro-mrws-'));
  roots.push(root);
  return new WorkspaceManager({
    root,
    diskCap: 1024 ** 3,
    exec: new FakeExec().on(() => true, OK),
    tokenEnv: 'MAESTRO_GITLAB_TOKEN',
    getEnv: () => 'secret',
  });
}

describe('WorkspaceManager.listMrWorkspaces', () => {
  it('returns only mr-<iid> dirs, ignoring issue dirs', () => {
    const m = mgr();
    const root = roots[roots.length - 1];
    // an issue workspace (bare number) and two MR workspaces
    mkdirSync(join(resolveWorkspacePath(root, repo, 42), '.git'), { recursive: true });
    const mr7 = resolveMrWorkspacePath(root, repo, 7);
    const mr9 = resolveMrWorkspacePath(root, repo, 9);
    mkdirSync(join(mr7, '.git'), { recursive: true });
    mkdirSync(join(mr9, '.git'), { recursive: true });

    const got = m.listMrWorkspaces(repo).sort((a, b) => a.iid - b.iid);
    expect(got).toEqual([
      { dir: mr7, iid: 7 },
      { dir: mr9, iid: 9 },
    ]);
    // the issue sweep still ignores the MR dirs
    expect(m.listWorkspaces(repo)).toEqual([{ dir: resolveWorkspacePath(root, repo, 42), iid: 42 }]);
  });
});
