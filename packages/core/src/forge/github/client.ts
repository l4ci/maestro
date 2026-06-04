// Thin GitHub REST/GraphQL client over `gh api`, routed through the injected Exec
// seam (§0.8). Token rides in GH_TOKEN env, never argv (§13); GH_HOST targets GHE.
// JSON bodies go on stdin (--input -), keeping issue/branch text off the process
// table. 404 is surfaced as `null` (not an error) so callers can distinguish a
// missing resource from a broken call. Mirrors the GitLab client; only the binary
// (`gh`), token env var, path scheme (/repos/:owner/:repo/…), and the GraphQL field
// form differ.

import type { Exec } from '../../contracts/index.js';
import { ForgeError } from './errors.js';

export interface GithubClientConfig {
  token: string;
  host: string; // github.com or a self-hosted GHE host
  botUser: string; // adapter construction config (M0 §0.10) — edge-trigger / bot assignment
  commentCap?: number; // recentComments bound (default 50)
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ApiOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  paginate?: boolean; // gh merges JSON-array pages into one array for list endpoints
}

function buildPath(path: string, query?: ApiOptions['query']): string {
  if (!query) return path;
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return qs ? `${path}?${qs}` : path;
}

/** Split 'org/repo' into URL-encoded path segments for /repos/:owner/:repo. */
export function repoSegments(project: string): { owner: string; repo: string } {
  const i = project.indexOf('/');
  if (i === -1) throw new ForgeError('GET', project, 0, `invalid repo path '${project}'`);
  return {
    owner: encodeURIComponent(project.slice(0, i)),
    repo: encodeURIComponent(project.slice(i + 1)),
  };
}

export class GithubClient {
  readonly #exec: Exec;
  readonly #cfg: GithubClientConfig;

  constructor(exec: Exec, cfg: GithubClientConfig) {
    this.#exec = exec;
    this.#cfg = cfg;
  }

  get botUser(): string {
    return this.#cfg.botUser;
  }

  get commentCap(): number {
    return this.#cfg.commentCap ?? 50;
  }

  #env(): Record<string, string> {
    // Token strictly in env; gh reads GH_TOKEN + GH_HOST.
    return { GH_TOKEN: this.#cfg.token, GH_HOST: this.#cfg.host };
  }

  /** Raw call returning parsed JSON, or `null` on 404. Throws ForgeError otherwise. */
  async api<T = unknown>(
    method: HttpMethod,
    path: string,
    opts: ApiOptions = {},
  ): Promise<T | null> {
    const fullPath = buildPath(path, opts.query);
    const args = ['api', fullPath, '-X', method];
    if (opts.paginate) args.push('--paginate');
    const runOpts: { env: Record<string, string>; input?: string } = { env: this.#env() };
    if (opts.body !== undefined) {
      args.push('--input', '-');
      runOpts.input = JSON.stringify(opts.body);
    }
    const res = await this.#exec.run('gh', args, runOpts);
    if (res.code !== 0) {
      if (is404(res.stderr)) return null;
      throw new ForgeError(method, fullPath, res.code, res.stderr);
    }
    return parseJson<T>(res.stdout);
  }

  /** Like api() but throws ForgeError on 404 too (for endpoints where absence is a bug). */
  async apiRequired<T = unknown>(
    method: HttpMethod,
    path: string,
    opts: ApiOptions = {},
  ): Promise<T> {
    const r = await this.api<T>(method, path, opts);
    if (r === null) throw new ForgeError(method, buildPath(path, opts.query), 404, 'not found');
    return r;
  }

  /** GraphQL via gh's native field form: `gh api graphql -f query=… -f <var>=…`.
   *  Non-`query` fields become GraphQL variables. Used only for the draft toggle. */
  async graphql<T = unknown>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const args = ['api', 'graphql', '-f', `query=${query}`];
    for (const [k, v] of Object.entries(variables)) {
      args.push('-f', `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
    }
    const res = await this.#exec.run('gh', args, { env: this.#env() });
    if (res.code !== 0) throw new ForgeError('POST', 'graphql', res.code, res.stderr);
    return parseJson<T>(res.stdout);
  }
}

function is404(stderr: string): boolean {
  return /\b404\b/.test(stderr) || /not found/i.test(stderr);
}

function parseJson<T>(stdout: string): T {
  const trimmed = stdout.trim();
  return (trimmed === '' ? null : JSON.parse(trimmed)) as T;
}
