// Per-issue workspace lifecycle (§8, §13, §14). The ONLY place a path under
// workspaces/ is created/cloned/branched/evicted — the seam a future container
// backend swaps into (§17). Cleanup *decisions* belong to the daemon (§0.5); this
// manager only provides the eviction mechanism. Clone auth uses a per-clone git
// credential helper reading the token from env, never argv/URL (§0.8, OD-1).

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Exec, RepoRef } from '../contracts/index.js';
import { MissingTokenError } from './errors.js';
import { assertInsideRoot, resolveWorkspacePath } from './paths.js';

export interface WorkspaceHandle {
  dir: string;
  repo: RepoRef;
  iid: number;
}

export interface WorkspaceManagerConfig {
  root: string;
  diskCap: number; // bytes (§14 workspaces.disk_cap)
  exec: Exec;
  tokenEnv: string; // NAME of the env var holding the forge token (§5)
  getEnv?: (key: string) => string | undefined; // injectable for tests; defaults to process.env
  now?: () => number; // injectable clock for LRU recency
}

// Credential helper: emits oauth2 + the token read from $MAESTRO_GIT_TOKEN at git
// runtime. The token value never appears in argv — only the literal var reference.
const CRED_HELPER = '!f() { echo username=oauth2; echo "password=$MAESTRO_GIT_TOKEN"; }; f';

export class WorkspaceManager {
  readonly #root: string;
  readonly #diskCap: number;
  readonly #exec: Exec;
  readonly #tokenEnv: string;
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
    const auth = this.#cloneAuth();

    if (existsSync(join(dir, '.git'))) {
      // reuse: fetch + hard reset, no clone
      await this.#git([...auth.args, '-C', dir, 'fetch', 'origin', fromRef], auth.env);
      await this.#git(['-C', dir, 'reset', '--hard', 'FETCH_HEAD']);
    } else {
      const remote = `https://${repo.host}/${repo.project}.git`; // plain URL, no userinfo
      await this.#git([...auth.args, 'clone', remote, dir], auth.env);
    }
    this.#touch(dir);
    return { dir, repo, iid };
  }

  /** Create-or-reset the work branch (idempotent). Branch name is owned by the reconciler. */
  async prepareBranch(handle: WorkspaceHandle, branchName: string): Promise<void> {
    await this.#git(['-C', handle.dir, 'checkout', '-B', branchName]);
    this.#touch(handle.dir);
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

  #cloneAuth(): { args: string[]; env: Record<string, string> } {
    const token = this.#getEnv(this.#tokenEnv);
    if (!token) throw new MissingTokenError(this.#tokenEnv);
    // reset any inherited helper, then install ours; token rides in env only
    return {
      args: ['-c', 'credential.helper=', '-c', `credential.helper=${CRED_HELPER}`],
      env: { MAESTRO_GIT_TOKEN: token },
    };
  }

  #git(args: string[], env?: Record<string, string>): Promise<void> {
    return this.#exec.run('git', args, env ? { env } : {}).then((r) => {
      if (r.code !== 0)
        throw new Error(`git ${args[0]} failed (exit ${r.code}): ${r.stderr.trim()}`);
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
