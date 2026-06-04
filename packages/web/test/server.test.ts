import type { AddResult, DashboardView, IssueView } from '@maestro/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../src/server.js';
import type { ServerDeps } from '../src/server.js';

const repo = {
  forge: 'gitlab' as const,
  host: 'gitlab.com',
  project: 'g/r',
  url: 'gitlab.com/g/r',
};

const cannedDashboard: DashboardView = {
  repos: [
    {
      repo,
      issues: [{ iid: 42, title: 'Do the thing', state: 'in-review' }],
      counts: { new: 0, 'in-progress': 0, 'in-review': 1, blocked: 0, done: 0 },
    },
  ],
};

const cannedIssue: IssueView = { iid: 42, title: 'Do the thing', state: 'in-review' };

function fakeDeps(over: Partial<ServerDeps> = {}): ServerDeps {
  return {
    loadDashboard: async () => cannedDashboard,
    loadIssue: async () => cannedIssue,
    addRepo: async () => ({ added: true, repo }) as AddResult,
    ...over,
  };
}

// Drive a handler in-process without binding a socket: feed a fake req/res pair.
async function call(
  deps: ServerDeps,
  method: string,
  url: string,
  body?: string,
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  const server = createServer(deps);
  const { Readable } = await import('node:stream');
  const req = Readable.from(body ? [body] : []) as unknown as import('node:http').IncomingMessage;
  req.method = method;
  req.url = url;
  // Mirror how a client labels the body: JSON object → json, otherwise form-encoded.
  req.headers = body
    ? {
        'content-type': body.startsWith('{')
          ? 'application/json'
          : 'application/x-www-form-urlencoded',
      }
    : {};

  return await new Promise((resolve) => {
    let status = 0;
    const headers: Record<string, string> = {};
    const chunks: string[] = [];
    const res = {
      statusCode: 200,
      setHeader(k: string, v: string) {
        headers[k.toLowerCase()] = v;
      },
      writeHead(code: number, h?: Record<string, string>) {
        status = code;
        if (h) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v;
      },
      end(chunk?: string) {
        if (status === 0) status = this.statusCode;
        if (chunk) chunks.push(chunk);
        resolve({ status, body: chunks.join(''), headers });
      },
      write(chunk: string) {
        chunks.push(chunk);
      },
    } as unknown as import('node:http').ServerResponse;
    // @ts-expect-error reach the bound request listener for hermetic in-process dispatch
    server.emit('request', req, res);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('F1 — GET routes serialize assembled views, never mutate', () => {
  it('GET / returns the dashboard view as JSON with 200', async () => {
    const res = await call(fakeDeps(), 'GET', '/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(JSON.parse(res.body)).toEqual(cannedDashboard);
  });

  it('GET /repos/:id returns the issue view as JSON with 200', async () => {
    const loadIssue = vi.fn(async () => cannedIssue);
    const res = await call(fakeDeps({ loadIssue }), 'GET', '/repos/42');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual(cannedIssue);
    expect(loadIssue).toHaveBeenCalledWith(expect.anything(), 42);
  });

  it('GET handlers only receive read deps — no addRepo reachable from a GET', async () => {
    // The read-only guarantee is structural: the GET path closes over loadDashboard/
    // loadIssue only. Prove a GET never calls addRepo even when one is injected.
    const addRepo = vi.fn(async () => ({ added: true, repo }) as AddResult);
    await call(fakeDeps({ addRepo }), 'GET', '/');
    expect(addRepo).not.toHaveBeenCalled();
  });
});

describe('F2 — POST /repos delegates to the shared addRepo', () => {
  it('parses a JSON url and returns 2xx on added:true', async () => {
    const addRepo = vi.fn(async () => ({ added: true, repo }) as AddResult);
    const res = await call(
      fakeDeps({ addRepo }),
      'POST',
      '/repos',
      JSON.stringify({ url: 'gitlab.com/g/r' }),
    );
    expect(addRepo).toHaveBeenCalledWith('gitlab.com/g/r');
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(400);
  });

  it('parses a form-encoded url too', async () => {
    const addRepo = vi.fn(async () => ({ added: true, repo }) as AddResult);
    const res = await call(
      { ...fakeDeps({ addRepo }) },
      'POST',
      '/repos',
      'url=gitlab.com%2Fg%2Fr',
    );
    // form bodies arrive without the JSON content-type, handler must still parse
    expect(addRepo).toHaveBeenCalledWith('gitlab.com/g/r');
    expect(res.status).toBeLessThan(400);
  });

  it('returns a 4xx with the typed reason on added:false (never a 500)', async () => {
    const addRepo = vi.fn(async () => ({ added: false, reason: 'already-watched' }) as AddResult);
    const res = await call(fakeDeps({ addRepo }), 'POST', '/repos', JSON.stringify({ url: 'x' }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.body).toContain('already-watched');
  });

  it('missing url is a 4xx, not a crash', async () => {
    const res = await call(fakeDeps(), 'POST', '/repos', JSON.stringify({}));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe('unknown routes', () => {
  it('GET of an unknown path is a 404', async () => {
    const res = await call(fakeDeps(), 'GET', '/nope');
    expect(res.status).toBe(404);
  });
});

describe('HTML dashboard — browser content-negotiation', () => {
  it('GET / with Accept: text/html serves the HTML page, never the JSON', async () => {
    // fetch lets us set a real Accept header (the in-process `call` always omits it).
    const server = createServer(fakeDeps());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/`, {
        headers: { Accept: 'text/html' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(await res.text()).toContain('<title>maestro</title>');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('GET / without an HTML Accept still returns the JSON read-model', async () => {
    // The page's own data fetch, API clients, and every other test hit this path unchanged.
    const res = await call(fakeDeps(), 'GET', '/');
    expect(res.headers['content-type']).toContain('application/json');
    expect(JSON.parse(res.body)).toEqual(cannedDashboard);
  });
});

describe('F3 — wiring smoke (the only socket-binding test)', () => {
  it('binds 127.0.0.1:0, serves GET / and accepts POST /repos', async () => {
    const addRepo = vi.fn(async () => ({ added: true, repo }) as AddResult);
    const server = createServer(fakeDeps({ addRepo }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    const base = `http://127.0.0.1:${addr.port}`;
    try {
      const get = await fetch(`${base}/`);
      expect(get.status).toBe(200);
      expect(await get.json()).toEqual(cannedDashboard);

      const post = await fetch(`${base}/repos`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'gitlab.com/g/r' }),
      });
      expect(post.status).toBeLessThan(400);
      expect(addRepo).toHaveBeenCalledWith('gitlab.com/g/r');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
