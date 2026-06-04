import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecResult, RepoRef } from '../src/contracts/index.js';
import { resolveWorkspacePath } from '../src/workspace/paths.js';
import { WorkspaceManager } from '../src/workspace/workspace-manager.js';
import { FakeExec } from './helpers/fake-exec.js';

// The cleanup sweep (§0.5 pass B) needs to enumerate the per-repo workspace dirs
// and map each back to an issue iid, and the lifecycle pass needs to know if a live
// workspace exists for an issue. Path/slug knowledge stays in the workspace module
// (paths.ts) — the daemon never re-derives it.

const repo: RepoRef = {
  forge: 'gitlab',
  host: 'gitlab.com',
  project: 'group/repo',
  url: 'gitlab.com/group/repo',
};
const other: RepoRef = { ...repo, project: 'group/other', url: 'gitlab.com/group/other' };

const OK: ExecResult = { code: 0, stdout: '', stderr: '' };
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) if (existsSync(r)) rmSync(r, { recursive: true, force: true });
});
function mgr() {
  const root = mkdtempSync(join(tmpdir(), 'maestro-ws-'));
  roots.push(root);
  return new WorkspaceManager({
    root,
    diskCap: 1024 ** 3,
    exec: new FakeExec().on(() => true, OK),
    tokenEnv: 'MAESTRO_GITLAB_TOKEN',
    getEnv: () => 'secret',
  });
}
/** Materialize a fake cloned workspace (a dir with a .git marker). */
function seed(root: string, r: RepoRef, iid: number): string {
  const dir = resolveWorkspacePath(root, r, iid);
  mkdirSync(join(dir, '.git'), { recursive: true });
  return dir;
}

describe('WorkspaceManager.workspaceExists', () => {
  it('is true only when a cloned workspace dir (.git) exists for the issue', () => {
    const m = mgr();
    const root = (m as unknown as { _root?: string }) && roots[roots.length - 1];
    expect(m.workspaceExists(repo, 42)).toBe(false);
    seed(root, repo, 42);
    expect(m.workspaceExists(repo, 42)).toBe(true);
    expect(m.workspaceExists(repo, 43)).toBe(false);
  });
});

describe('WorkspaceManager.listWorkspaces', () => {
  it('returns {dir, iid} for this repo only, ignoring other repos', () => {
    const m = mgr();
    const root = roots[roots.length - 1];
    const d42 = seed(root, repo, 42);
    const d7 = seed(root, repo, 7);
    seed(root, other, 99); // different repo — must not appear

    const got = m.listWorkspaces(repo).sort((a, b) => a.iid - b.iid);
    expect(got).toEqual([
      { dir: d7, iid: 7 },
      { dir: d42, iid: 42 },
    ]);
  });

  it('returns [] for a repo with no workspaces', () => {
    expect(mgr().listWorkspaces(repo)).toEqual([]);
  });
});
