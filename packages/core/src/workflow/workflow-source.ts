// WORKFLOW.md source (§16 seam, closes #5). The committed `WORKFLOW.md` lives INSIDE
// each watched repo on its default branch; this fetches it from there so the
// bootstrap → finalize → merge loop closes on its own — once the bootstrap MR merges,
// the next refresh sees the real WORKFLOW.md without anyone hand-placing a local copy.
//
// The local dir (`<cacheDir>/<slug>/WORKFLOW.md`) is a PURE CACHE: a successful fetch
// writes through to it (only on a real change, so an fs.watcher fires only for genuine
// updates), and a transient fetch failure (offline, rate limit) falls back to the last
// cached copy. `undefined` means the repo has no committed WORKFLOW.md AND no cache —
// the daemon then operates that repo in bootstrap mode.
//
// I/O lives here (git via Exec, fs for the cache) rather than in the daemon so the
// daemon stays a thin composition root (§14) and this stays unit-testable headless.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Exec, RepoRef } from '../contracts/index.js';
import type { Logger } from '../daemon/ports.js';
import { gitCloneAuth } from '../workspace/git-auth.js';
import { slugifyProject } from '../workspace/paths.js';

export interface WorkflowSourceConfig {
  /** Where the local WORKFLOW.md cache + its fetch metadata live (= daemon workflowsDir). */
  cacheDir: string;
  exec: Exec;
  /** NAME of the env var holding the forge token, or a per-repo resolver (matches the
   *  WorkspaceManager seam so one source serves repos across forges, #15). */
  tokenEnv: string | ((repo: RepoRef) => string);
  getEnv?: (key: string) => string | undefined; // injectable for tests; defaults to process.env
  log?: Logger;
}

export class WorkflowSource {
  readonly #cacheDir: string;
  readonly #exec: Exec;
  readonly #tokenEnv: string | ((repo: RepoRef) => string);
  readonly #getEnv: (key: string) => string | undefined;
  readonly #log: Logger | undefined;

  constructor(cfg: WorkflowSourceConfig) {
    this.#cacheDir = cfg.cacheDir;
    this.#exec = cfg.exec;
    this.#tokenEnv = cfg.tokenEnv;
    this.#getEnv = cfg.getEnv ?? ((k) => process.env[k]);
    this.#log = cfg.log;
  }

  /** Fetch `<default branch>:WORKFLOW.md` from the repo, write it through to the local
   *  cache, and return its text. Returns `undefined` when the repo has no committed
   *  WORKFLOW.md (→ bootstrap mode) — or, on a transient fetch failure, the last cached
   *  copy if one exists. */
  async load(repo: RepoRef): Promise<string | undefined> {
    const slugDir = join(this.#cacheDir, slugifyProject(repo.project));
    const cacheFile = join(slugDir, 'WORKFLOW.md');
    const gitDir = join(slugDir, '.workflow-src');

    let fetched: string | undefined;
    try {
      fetched = await this.#fetch(repo, slugDir, gitDir);
    } catch (err) {
      // Transient (network/auth/transport): the remote is authoritative but unreachable
      // right now, so serve the last good cache rather than dropping the repo to bootstrap.
      this.#log?.warn('WORKFLOW fetch failed — using local cache if present', {
        repo: repo.project,
        err: String(err),
      });
      return existsSync(cacheFile) ? readFileSync(cacheFile, 'utf8') : undefined;
    }

    if (fetched === undefined) return undefined; // no WORKFLOW.md on the default branch

    // Write through only on change so an fs.watcher fires for real updates, not refreshes.
    const current = existsSync(cacheFile) ? readFileSync(cacheFile, 'utf8') : undefined;
    if (current !== fetched) {
      mkdirSync(slugDir, { recursive: true });
      writeFileSync(cacheFile, fetched);
    }
    return fetched;
  }

  /** Fetch the default-branch WORKFLOW.md blob. Returns its text, or `undefined` when the
   *  file is absent on the default branch. Throws on a network/transport failure so the
   *  caller can fall back to the cache. */
  async #fetch(repo: RepoRef, slugDir: string, gitDir: string): Promise<string | undefined> {
    mkdirSync(slugDir, { recursive: true });
    const auth = gitCloneAuth(repo, this.#tokenEnv, this.#getEnv);
    const remote = `https://${repo.host}/${repo.project}.git`; // plain URL, no userinfo

    if (!existsSync(join(gitDir, 'HEAD'))) {
      // Metadata-only bare repo: no working tree (we read the blob via `git show`).
      await this.#git(['init', '--bare', gitDir]);
      await this.#git(['--git-dir', gitDir, 'remote', 'add', 'origin', remote]);
    }

    // Fetch the remote's HEAD (its default branch tip) shallowly — no branch name needed.
    const fetch = await this.#exec.run(
      'git',
      [...auth.args, '--git-dir', gitDir, 'fetch', '--depth=1', 'origin', 'HEAD'],
      { env: auth.env },
    );
    if (fetch.code !== 0) {
      throw new Error(`git fetch failed (exit ${fetch.code}): ${fetch.stderr.trim()}`);
    }

    const show = await this.#exec.run(
      'git',
      ['--git-dir', gitDir, 'show', 'FETCH_HEAD:WORKFLOW.md'],
      {},
    );
    // A clean fetch + a `show` miss means the path is genuinely absent on the default
    // branch (not a transport error) → no committed WORKFLOW.md yet.
    return show.code === 0 ? show.stdout : undefined;
  }

  #git(args: string[]): Promise<void> {
    return this.#exec.run('git', args, {}).then((r) => {
      if (r.code !== 0) {
        throw new Error(`git ${args[0]} failed (exit ${r.code}): ${r.stderr.trim()}`);
      }
    });
  }
}
