// Thin HTTP layer (M6 Part F) over the core read-model + the shared addRepo. NO framework,
// node's built-in `http` only. Every byte of real logic lives in @maestro/core; this file is
// a dumb adapter: route → injected dep → serialize. The deps shape is the read-only guarantee
// made structural — GET handlers close over loadDashboard/loadIssue only (functions that
// internally use the READ-ONLY-narrowed adapter), so a mutating forge call is unreachable from
// any GET path. The single write path is POST /repos → the SAME addRepo `maestro add` calls.

import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer as httpCreateServer } from 'node:http';
import type { AddResult, DashboardView, IssueView } from '@maestro/core';

export interface ServerDeps {
  /** Read-only: wraps assembleDashboard for the configured repos. */
  loadDashboard: () => Promise<DashboardView>;
  /** Read-only: wraps assembleIssue for one repo/issue. */
  loadIssue: (repoId: string, iid: number) => Promise<IssueView>;
  /** The ONLY write path — wraps core addRepo (commit:true default). */
  addRepo: (url: string) => Promise<AddResult>;
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

  // --- write path (the single forge mutation reachable from the web) ---
  if (method === 'POST' && path === '/repos') {
    return postRepos(req, res, deps);
  }

  // --- read paths: these close over read-only deps only ---
  if (method === 'GET' && path === '/') {
    return sendJson(res, 200, await deps.loadDashboard());
  }
  const issue = path.match(/^\/repos\/([^/]+)$/);
  if (method === 'GET' && issue?.[1]) {
    const repoId = issue[1];
    const iid = Number(repoId);
    if (!Number.isInteger(iid)) return sendJson(res, 400, { error: 'invalid issue id' });
    return sendJson(res, 200, await deps.loadIssue(repoId, iid));
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
