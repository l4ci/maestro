// Thin GitLab REST/GraphQL client over `glab api`, routed through the injected Exec
// seam (§0.8). Token rides in GITLAB_TOKEN env, never argv (§13). JSON bodies go on
// stdin (--input -), keeping issue/branch text off the process table. 404 is
// surfaced as `null` (not an error) so callers can distinguish missing from broken.

import type { Exec } from '../../contracts/index.js';
import { ForgeError } from './errors.js';

export interface GitlabClientConfig {
  token: string;
  host: string; // e.g. gitlab.com
  botUser: string; // adapter construction config (M0 §0.10), used for edge-trigger/lastActor
  commentCap?: number; // recentComments bound (default 50)
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface ApiOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}

function buildPath(path: string, query?: ApiOptions['query']): string {
  if (!query) return path;
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return qs ? `${path}?${qs}` : path;
}

/** URL-encode a GitLab project path for the `:id` segment: group/repo → group%2Frepo. */
export function encodeProject(project: string): string {
  return encodeURIComponent(project);
}

export class GitlabClient {
  readonly #exec: Exec;
  readonly #cfg: GitlabClientConfig;

  constructor(exec: Exec, cfg: GitlabClientConfig) {
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
    // Token strictly in env; glab reads GITLAB_TOKEN + GITLAB_HOST.
    return { GITLAB_TOKEN: this.#cfg.token, GITLAB_HOST: this.#cfg.host };
  }

  /** Raw call returning parsed JSON, or `null` on 404. Throws ForgeError otherwise. */
  async api<T = unknown>(
    method: HttpMethod,
    path: string,
    opts: ApiOptions = {},
  ): Promise<T | null> {
    const fullPath = buildPath(path, opts.query);
    const args = ['api', fullPath, '-X', method];
    const runOpts: { env: Record<string, string>; input?: string } = { env: this.#env() };
    if (opts.body !== undefined) {
      args.push('--input', '-');
      runOpts.input = JSON.stringify(opts.body);
    }
    const res = await this.#exec.run('glab', args, runOpts);
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

  async graphql<T = unknown>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const args = ['api', 'graphql', '--input', '-'];
    const input = JSON.stringify({ query, variables });
    const res = await this.#exec.run('glab', args, { env: this.#env(), input });
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
