// Thin REST/GraphQL transport over a forge CLI (`glab` / `gh`), routed through the
// injected Exec seam (§0.8). The ONE transport body both adapters share — before the
// M2/M7 merge this lived duplicated in gitlab/client.ts and github/client.ts, differing
// only by binary, env vars, the optional `--paginate` flag, and the GraphQL form.
//
// Token rides in env (GITLAB_TOKEN / GH_TOKEN), never argv (§13); JSON bodies go on
// stdin (--input -), keeping issue/branch text off the process table. 404 surfaces as
// `null` (not an error) so callers distinguish a missing resource from a broken call.

import type { Exec, ForgeKind } from '../contracts/index.js';
import { ForgeError } from './errors.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ApiOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  paginate?: boolean; // append `--paginate` (gh merges JSON-array pages); glab callers omit it
}

export interface ForgeCliConfig {
  bin: string; // 'glab' | 'gh'
  forge: ForgeKind; // labels ForgeError; never affects argv
  env: Record<string, string>; // e.g. { GITLAB_TOKEN, GITLAB_HOST } — the token-carrying child env
  botUser: string; // construction config (M0 §0.10) — edge-trigger / bot assignment
  commentCap?: number; // recentComments bound (default 50)
}

export function buildPath(path: string, query?: ApiOptions['query']): string {
  if (!query) return path;
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return qs ? `${path}?${qs}` : path;
}

export class ForgeCli {
  readonly #exec: Exec;
  readonly #cfg: ForgeCliConfig;

  constructor(exec: Exec, cfg: ForgeCliConfig) {
    this.#exec = exec;
    this.#cfg = cfg;
  }

  get botUser(): string {
    return this.#cfg.botUser;
  }

  get commentCap(): number {
    return this.#cfg.commentCap ?? 50;
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
    const runOpts: { env: Record<string, string>; input?: string } = { env: this.#cfg.env };
    if (opts.body !== undefined) {
      // glab's --input sends an EMPTY Content-Type and GitLab rejects the call with
      // HTTP 415, so the header must be explicit. gh already defaults JSON for --input;
      // there the explicit header is a no-op. One transport, one rule.
      args.push('-H', 'Content-Type: application/json', '--input', '-');
      runOpts.input = JSON.stringify(opts.body);
    }
    const res = await this.#exec.run(this.#cfg.bin, args, runOpts);
    if (res.code !== 0) {
      if (is404(res.stderr)) return null;
      throw new ForgeError(this.#cfg.forge, method, fullPath, res.code, res.stderr);
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
    if (r === null) {
      throw new ForgeError(this.#cfg.forge, method, buildPath(path, opts.query), 404, 'not found');
    }
    return r;
  }

  /**
   * GraphQL via gh's native field form: `gh api graphql -f query=… -f <var>=…`. The
   * SOLE caller is GitHub's draft toggle; GitLab's stdin-JSON graphql() was removed as
   * dead code in the M2/M7 transport merge. If GitLab ever needs GraphQL, reintroduce a
   * per-forge strategy here (two callers = a real seam; today there is one).
   */
  async graphql<T = unknown>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const args = ['api', 'graphql', '-f', `query=${query}`];
    for (const [k, v] of Object.entries(variables)) {
      args.push('-f', `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
    }
    const res = await this.#exec.run(this.#cfg.bin, args, { env: this.#cfg.env });
    if (res.code !== 0)
      throw new ForgeError(this.#cfg.forge, 'POST', 'graphql', res.code, res.stderr);
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
