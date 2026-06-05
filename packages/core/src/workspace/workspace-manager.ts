// Per-issue workspace lifecycle (§8, §13, §14). The ONLY place a path under
// workspaces/ is created/cloned/branched/evicted — the seam a future container
// backend swaps into (§17). Cleanup *decisions* belong to the daemon (§0.5); this
// manager only provides the eviction mechanism. Clone auth uses a per-clone git
// credential helper reading the token from env, never argv/URL (§0.8, OD-1).

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Exec, RepoRef } from '../contracts/index.js';
import { type GitAuth, gitCloneAuth } from './git-auth.js';
import { assertInsideRoot, resolveWorkspacePath, slugifyProject } from './paths.js';

export interface WorkspaceHandle {
  dir: string;
  repo: RepoRef;
  iid: number;
  /** Set when the reuse reset found committed-but-unpushed local work it could not
   *  catch-up push: the commits were parked on this ref before the reset (#55). */
  rescuedRef?: string;
}

export interface WorkspaceManagerConfig {
  root: string;
  diskCap: number; // bytes (§14 workspaces.disk_cap)
  exec: Exec;
  /** NAME of the env var holding the forge token (§5). A function resolves it PER REPO so
   *  one manager can clone repos on different forges (gh/glab) with their own tokens; a
   *  bare string is the single-forge shorthand. */
  tokenEnv: string | ((repo: RepoRef) => string);
  getEnv?: (key: string) => string | undefined; // injectable for tests; defaults to process.env
  now?: () => number; // injectable clock for LRU recency
}

export class WorkspaceManager {
  readonly #root: string;
  readonly #diskCap: number;
  readonly #exec: Exec;
  readonly #tokenEnv: string | ((repo: RepoRef) => string);
  readonly #getEnv: (key: string) => string | undefined;
  readonly #now: () => number;
  readonly #recency = new Map<string, number>();

  constructor(cfg: WorkspaceManagerConfig) {
    this.#root = cfg.root;
    this.#diskCap = cfg.diskCap;
    this.#exec = cfg.exec;
    this.#tokenEnv = cfg.tokenEnv;
    this.#getEnv = cfg.getEnv ?? ((k) => process.env[k]);
    this.#now = cfg.now ?? (() => Date.now());
  }

  /** Materialize (clone or reuse) the per-issue workspace and reset it to `fromRef`. */
  async ensureWorkspace(repo: RepoRef, iid: number, fromRef: string): Promise<WorkspaceHandle> {
    const dir = resolveWorkspacePath(this.#root, repo, iid);
    const auth = this.#cloneAuth(repo);
    let rescuedRef: string | undefined;

    if (existsSync(join(dir, '.git'))) {
      // reuse: fetch + hard reset, no clone. The reset must never destroy committed-
      // but-unpushed work (#55): a crash between the agent's commit and the daemon's
      // push would otherwise be erased on the next tick.
      await this.#git([...auth.args, '-C', dir, 'fetch', 'origin', fromRef], auth.env);
      const saved = await this.#preserveUnpushed(dir, fromRef, auth);
      if (saved.kind === 'rescued') rescuedRef = saved.ref;
      // After a successful catch-up push, remote == HEAD; resetting to FETCH_HEAD would
      // rewind the just-pushed commits — clean the working tree in place instead.
      await this.#git([
        '-C',
        dir,
        'reset',
        '--hard',
        saved.kind === 'pushed' ? 'HEAD' : 'FETCH_HEAD',
      ]);
    } else {
      const remote = `https://${repo.host}/${repo.project}.git`; // plain URL, no userinfo
      await this.#git([...auth.args, 'clone', remote, dir], auth.env);
    }
    this.#touch(dir);
    return rescuedRef !== undefined ? { dir, repo, iid, rescuedRef } : { dir, repo, iid };
  }

  /** Create-or-reset the work branch (idempotent). Branch name is owned by the reconciler. */
  async prepareBranch(handle: WorkspaceHandle, branchName: string): Promise<void> {
    await this.#git(['-C', handle.dir, 'checkout', '-B', branchName]);
    this.#touch(handle.dir);
  }

  /** Push an already-committed branch to origin (authenticated). The daemon calls this
   *  after the agent runs: the agent commits locally but its env has the forge token
   *  scrubbed (§13.1), so the daemon owns the push. No-op when there's nothing to push. */
  async pushBranch(handle: WorkspaceHandle, branchName: string): Promise<void> {
    const auth = this.#cloneAuth(handle.repo);
    await this.#git([...auth.args, '-C', handle.dir, 'push', '-u', 'origin', branchName], auth.env);
    this.#touch(handle.dir);
  }

  /** Stage EXPLICIT paths, commit, and push the current branch to origin (authenticated,
   *  same credential helper as clone). Used by bootstrap onboarding to seed a WORKFLOW.md
   *  onto a fresh PR branch. Never `git add .`/`-A` (§5): only the paths passed in. */
  async commitAndPush(
    handle: WorkspaceHandle,
    opts: { paths: string[]; message: string; branch: string },
  ): Promise<void> {
    const auth = this.#cloneAuth(handle.repo);
    await this.#git(['-C', handle.dir, 'add', ...opts.paths]);
    // Identity via -c so a headless clone with no configured git user can still commit.
    await this.#git([
      '-C',
      handle.dir,
      '-c',
      'user.email=maestro-bot@users.noreply',
      '-c',
      'user.name=maestro',
      'commit',
      '-m',
      opts.message,
    ]);
    await this.#git(
      [...auth.args, '-C', handle.dir, 'push', '-u', 'origin', opts.branch],
      auth.env,
    );
    this.#touch(handle.dir);
  }

  /** Seed the fresh work branch with one empty commit and push it. GitHub refuses to open a
   *  PR whose head has no commits beyond base ("No commits between …"); GitLab tolerates an
   *  empty-diff MR but this keeps the New-issue path forge-uniform. The daemon calls this in
   *  start-new BEFORE createDraftMR; the agent's real commits land on top and push later. */
  async seedBranch(handle: WorkspaceHandle, branchName: string): Promise<void> {
    const auth = this.#cloneAuth(handle.repo);
    // Identity via -c so a headless clone with no configured git user can still commit.
    await this.#git([
      '-C',
      handle.dir,
      '-c',
      'user.email=maestro-bot@users.noreply',
      '-c',
      'user.name=maestro',
      'commit',
      '--allow-empty',
      '-m',
      `maestro: start work on #${handle.iid}`,
    ]);
    await this.#git([...auth.args, '-C', handle.dir, 'push', '-u', 'origin', branchName], auth.env);
    this.#touch(handle.dir);
  }

  /** Does a live (cloned) workspace exist for this issue? Feeds ReconcileInput (§0.5). */
  workspaceExists(repo: RepoRef, iid: number): boolean {
    return existsSync(join(resolveWorkspacePath(this.#root, repo, iid), '.git'));
  }

  /** Per-repo workspace dirs mapped back to issue iids — drives the cleanup sweep (§0.5). */
  listWorkspaces(repo: RepoRef): { dir: string; iid: number }[] {
    const repoDir = join(this.#root, slugifyProject(repo.project));
    if (!existsSync(repoDir)) return [];
    const out: { dir: string; iid: number }[] = [];
    for (const name of readdirSync(repoDir)) {
      const dir = join(repoDir, name);
      const iid = Number(name);
      if (Number.isInteger(iid) && iid >= 0 && statSync(dir).isDirectory()) out.push({ dir, iid });
    }
    return out;
  }

  /** Evict LRU workspaces until total disk ≤ cap, never evicting a dir in `inUse`. */
  async enforceDiskCap(inUse: ReadonlySet<string> = new Set()): Promise<string[]> {
    const dirs = this.#listWorkspaceDirs();
    let total = dirs.reduce((sum, d) => sum + dirSize(d), 0);
    if (total <= this.#diskCap) return [];

    const evicted: string[] = [];
    const byLru = dirs
      .filter((d) => !inUse.has(d))
      .sort((a, b) => (this.#recency.get(a) ?? 0) - (this.#recency.get(b) ?? 0)); // oldest first

    for (const dir of byLru) {
      if (total <= this.#diskCap) break;
      const size = dirSize(dir);
      await this.evict(dir);
      total -= size;
      evicted.push(dir);
    }
    return evicted;
  }

  /** Recursively remove a workspace dir. Re-validates confinement (defense in depth);
   *  idempotent (missing dir is a no-op). The daemon's cleanup sweep calls this. */
  async evict(dir: string): Promise<void> {
    assertInsideRoot(this.#root, dir);
    rmSync(dir, { recursive: true, force: true });
    this.#recency.delete(dir);
  }

  // --- internals ----------------------------------------------------------

  /** #55 guard for the reuse reset. Counts commits on HEAD that no origin ref has; when
   *  found, catch-up pushes them if HEAD sits on `fromRef` and fast-forwards it (the
   *  crash-between-commit-and-push case — the push the daemon owed), else parks them on
   *  `refs/maestro/rescue/<sha>` so the reset cannot orphan them. */
  async #preserveUnpushed(
    dir: string,
    fromRef: string,
    auth: GitAuth,
  ): Promise<{ kind: 'none' | 'pushed' } | { kind: 'rescued'; ref: string }> {
    const unpushed = await this.#gitOut([
      '-C',
      dir,
      'rev-list',
      '--count',
      'HEAD',
      '--not',
      '--remotes=origin',
    ]);
    if (!Number(unpushed)) return { kind: 'none' };

    const branch = await this.#gitOut(['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']).catch(
      () => '',
    );
    const fastForward = await this.#exec
      .run('git', ['-C', dir, 'merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD'], {})
      .then((r) => r.code === 0);
    if (branch === fromRef && fastForward) {
      try {
        await this.#git([...auth.args, '-C', dir, 'push', '-u', 'origin', fromRef], auth.env);
        return { kind: 'pushed' };
      } catch {
        // push refused (e.g. remote moved underneath us) — park the commits instead
      }
    }
    const sha = await this.#gitOut(['-C', dir, 'rev-parse', '--short', 'HEAD']);
    const ref = `refs/maestro/rescue/${sha}`;
    await this.#git(['-C', dir, 'update-ref', ref, 'HEAD']);
    return { kind: 'rescued', ref };
  }

  #cloneAuth(repo: RepoRef): GitAuth {
    return gitCloneAuth(repo, this.#tokenEnv, this.#getEnv);
  }

  #git(args: string[], env?: Record<string, string>): Promise<void> {
    return this.#gitOut(args, env).then(() => {});
  }

  #gitOut(args: string[], env?: Record<string, string>): Promise<string> {
    return this.#exec.run('git', args, env ? { env } : {}).then((r) => {
      if (r.code !== 0)
        throw new Error(`git ${args[0]} failed (exit ${r.code}): ${r.stderr.trim()}`);
      return r.stdout.trim();
    });
  }

  #touch(dir: string): void {
    this.#recency.set(dir, this.#now());
  }

  #listWorkspaceDirs(): string[] {
    // workspaces/<repo-slug>/<iid>/ — two levels deep
    if (!existsSync(this.#root)) return [];
    const out: string[] = [];
    for (const repoSlug of readdirSync(this.#root)) {
      const repoDir = join(this.#root, repoSlug);
      if (!statSync(repoDir).isDirectory()) continue;
      for (const iid of readdirSync(repoDir)) {
        const d = join(repoDir, iid);
        if (statSync(d).isDirectory()) out.push(d);
      }
    }
    return out;
  }
}

function dirSize(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(p);
    else if (entry.isFile()) total += statSync(p).size;
  }
  return total;
}
