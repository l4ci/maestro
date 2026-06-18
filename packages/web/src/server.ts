// Thin HTTP layer (M6 Part F) over the core read-model + the shared addRepo. NO framework,
// node's built-in `http` only. Every byte of real logic lives in @maestro/core; this file is
// a dumb adapter: route → injected dep → serialize. The deps shape is the read-only guarantee
// made structural — GET handlers close over loadDashboard/loadIssue only (functions that
// internally use the READ-ONLY-narrowed adapter), so a mutating forge call is unreachable from
// any GET path. The single write path is POST /repos → the SAME addRepo `maestro add` calls.

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer as httpCreateServer } from 'node:http';
import type { AddResult, DashboardView, IssueView, OpenIssueItem, WorkResult } from '@maestro/core';
import { DASHBOARD_HTML } from './page.js';

export interface ServerDeps {
  /** Read-only: wraps assembleDashboard for the configured repos. */
  loadDashboard: () => Promise<DashboardView>;
  /** Read-only: wraps assembleIssue for one repo/issue. */
  loadIssue: (repoId: string, iid: number) => Promise<IssueView>;
  /** The ONLY write path — wraps core addRepo (commit:true default). */
  addRepo: (url: string) => Promise<AddResult>;
  /** Read-only: wraps assembleOpenIssues for one repo — the grabbable backlog modal. */
  loadOpenIssues: (repoId: string) => Promise<OpenIssueItem[]>;
  /** A write path (bearer-gated): wraps core workOnIssue — assign the bot + optional label. */
  workOnIssue: (repoId: string, iid: number) => Promise<WorkResult>;
  /**
   * Bearer token that POST /repos must present. Writes are DISABLED unless this is set
   * (fail closed: no token configured → the write path is unreachable, returns 404). When
   * present, a request must carry a matching `Authorization: Bearer <token>` header,
   * compared in constant time. Read-only GETs are never gated by this.
   */
  writeToken?: string;
}

export function createServer(deps: ServerDeps): Server {
  return httpCreateServer((req, res) => {
    handle(req, res, deps).catch((err) => {
      // Last-resort guard: an unexpected throw is a 500, but never a leaked stacktrace.
      sendJson(res, 500, { error: 'internal error' });
      void err;
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const method = req.method ?? 'GET';
  const path = (req.url ?? '/').split('?')[0] ?? '/';

  const writesEnabled = Boolean(deps.writeToken);

  // --- write path (the single forge mutation reachable from the web) ---
  if (method === 'POST' && path === '/repos') {
    // Fail closed: with no token configured the write surface does not exist (404), so a
    // shared-network reader can't even tell the route is there. When enabled, the request
    // must authenticate (401 missing / 403 wrong) before any forge-mutating call runs.
    if (!writesEnabled) return sendJson(res, 404, { error: 'not found' });
    const authz = checkAuth(req, deps.writeToken);
    if (authz) return sendJson(res, authz.status, { error: authz.error });
    return postRepos(req, res, deps);
  }

  // --- write path: hand an issue to the bot (assign + optional trigger label) ---
  const work = path.match(/^\/repos\/([^/]+)\/issues\/([^/]+)\/work$/);
  if (method === 'POST' && work?.[1] && work[2]) {
    if (!writesEnabled) return sendJson(res, 404, { error: 'not found' });
    const authz = checkAuth(req, deps.writeToken);
    if (authz) return sendJson(res, authz.status, { error: authz.error });
    const repoId = decodeURIComponent(work[1]);
    const iid = Number(work[2]);
    if (!Number.isInteger(iid) || iid <= 0)
      return sendJson(res, 400, { error: 'invalid issue id' });
    return sendJson(res, 200, await deps.workOnIssue(repoId, iid));
  }

  // --- read paths: these close over read-only deps only ---
  if (method === 'GET' && path === '/') {
    // A browser (Accept: text/html) gets the dashboard page; everything else — API
    // clients, the page's own data fetch, the unit tests — gets the JSON read-model.
    if (wantsHtml(req)) return sendHtml(res, 200, DASHBOARD_HTML);
    // The read-model carries the write-capability flag so the UI hides the add-repo form
    // when writes are off (and a token-less reader never sees an input it can't use).
    return sendJson(res, 200, { ...(await deps.loadDashboard()), writesEnabled });
  }
  // Per-issue drill-down (#41). The repo id (`group/repo`) is its OWN segment, distinct from
  // the issue iid — the old `/repos/:id` route conflated the two and 400'd for every real
  // repo whose id wasn't an integer. The repoId rides URL-encoded so a slash inside it stays
  // one segment; we decode it before handing it to the read-only loadIssue seam.
  const issue = path.match(/^\/repos\/([^/]+)\/issues\/([^/]+)$/);
  if (method === 'GET' && issue?.[1] && issue[2]) {
    const repoId = decodeURIComponent(issue[1]);
    const iid = Number(issue[2]);
    if (!Number.isInteger(iid) || iid <= 0)
      return sendJson(res, 400, { error: 'invalid issue id' });
    return sendJson(res, 200, await deps.loadIssue(repoId, iid));
  }

  const open = path.match(/^\/repos\/([^/]+)\/open-issues$/);
  if (method === 'GET' && open?.[1]) {
    const repoId = decodeURIComponent(open[1]);
    return sendJson(res, 200, { issues: await deps.loadOpenIssues(repoId) });
  }

  sendJson(res, 404, { error: 'not found' });
}

async function postRepos(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const body = await readBody(req);
  const url = parseUrlField(body, req.headers['content-type']);
  if (!url) return sendJson(res, 400, { error: 'missing url' });

  // Delegate to the IDENTICAL routine `maestro add` uses — never a duplicate add path.
  const result = await deps.addRepo(url);
  if (result.added) return sendJson(res, 200, { added: true, repo: result.repo });
  // A typed reason (e.g. already-watched / unknown-forge), never a 500 stacktrace.
  sendJson(res, 400, { added: false, reason: result.reason });
}

/**
 * Validate the bearer token on a write request. Returns undefined on success, or the
 * status+message to reject with: 401 when no/!bearer Authorization header is present,
 * 403 when a token is present but doesn't match. The comparison hashes both sides to a
 * fixed-length digest first so timingSafeEqual gets equal-length buffers (it throws
 * otherwise) and so token *length* never leaks through the equal-length requirement.
 */
function checkAuth(
  req: IncomingMessage,
  expected: string | undefined,
): { status: number; error: string } | undefined {
  const header = req.headers.authorization ?? '';
  const match = header.match(/^Bearer (.+)$/);
  if (!match?.[1]) return { status: 401, error: 'authentication required' };
  if (!expected) return { status: 403, error: 'forbidden' };
  const a = createHash('sha256').update(match[1]).digest();
  const b = createHash('sha256').update(expected).digest();
  if (!timingSafeEqual(a, b)) return { status: 403, error: 'forbidden' };
  return undefined;
}

/** Accept either a JSON body `{url}` or a form-encoded `url=...`. */
function parseUrlField(body: string, contentType: string | undefined): string | undefined {
  if (contentType?.includes('application/json')) {
    try {
      const parsed = JSON.parse(body) as { url?: unknown };
      return typeof parsed.url === 'string' ? parsed.url : undefined;
    } catch {
      return undefined;
    }
  }
  // Form / unknown content-type: parse as urlencoded.
  const url = new URLSearchParams(body).get('url');
  return url ?? undefined;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer | string) => chunks.push(typeof c === 'string' ? Buffer.from(c) : c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

/** True only when the client explicitly prefers HTML (a browser navigation). Absent or
 *  `* /*` Accept stays on the JSON path, so API clients and tests are unaffected. */
function wantsHtml(req: IncomingMessage): boolean {
  return (req.headers.accept ?? '').includes('text/html');
}
