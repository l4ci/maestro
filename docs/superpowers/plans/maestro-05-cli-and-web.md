# Maestro M5 — CLI & Web Dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `@maestro/cli` commands (`add`, `list`, `status`, `logs`, `run --attach`) and the read-only `@maestro/web` dashboard (`GET /api/state`, `GET /`), both as thin shells over `@maestro/core`, with the daemon process serving the web app so `maestro status` reads live state over HTTP.

**Architecture:** Each CLI command is a pure handler function that receives its dependencies (forge factory, config path, fetch function, logger) by injection, so tests run with fakes and a temp config file — no network, no real git, no real daemon. `add` clones via `execa`, calls `createForge` + `ensureLabels` + `ensureBoard`, detects a `WORKFLOW.md` in the clone, appends a `RepoEntry` to `maestro.config.yaml` (preserving YAML), and commits by default. `status` and `web` share one truth: the daemon's in-memory `RunState` plus the watched repos from config, serialized as a `DashboardState` JSON payload by `GET /api/state`; `status` is an HTTP client of that endpoint, and `GET /` server-renders the same payload as static HTML. `web/src/server.ts` is a Fastify app factory taking a `getState()` provider so it is testable via `app.inject()` with a fake provider.

**Tech Stack:** Node 20+, TypeScript 5.x, ESM. `commander` (CLI), `fastify` (web), `execa` (git subprocess), `yaml` (config read/write), `zod` (already in core for config), Vitest (`*.test.ts` colocated), pnpm workspaces.

**Depends on:** M1 (config schema/load, daemon RunState), M2 (forge factory — used by `add` for label/board setup). M7 implements the WORKFLOW.md onboarding that `add` will offer when none exists.

---

## File Structure

| Path | Responsibility |
|---|---|
| `packages/cli/package.json` | `@maestro/cli` manifest; deps on `@maestro/core`, `commander`, `execa`, `yaml`; `bin` → `maestro`. |
| `packages/cli/src/index.ts` | `commander` setup; registers `add`, `list`, `status`, `logs`, `run`; wires real dependencies into each handler; exposes `buildProgram(deps)` for tests. |
| `packages/cli/src/deps.ts` | `CliDeps` interface + `defaultCliDeps()` factory (real `createForge`, config path, `fetch`, `execa`, logger). The single injection seam. |
| `packages/cli/src/commands/add.ts` | `addCommand(deps, url, opts)`: clone, forge setup, WORKFLOW.md detection, append `RepoEntry`, commit-by-default (`--no-commit`). |
| `packages/cli/src/commands/list.ts` | `listCommand(deps)`: read config, print watched repos. |
| `packages/cli/src/commands/status.ts` | `statusCommand(deps)`: `fetch` `GET /api/state` from the daemon, render running/queued issues. |
| `packages/cli/src/commands/logs.ts` | `logsCommand(deps, opts)`: tail the daemon log file under `logs/`. |
| `packages/cli/src/commands/run.ts` | `runCommand(deps, issueNumber, opts)`: launch interactive `claude` in the issue workspace (inherit stdio) when `--attach`. |
| `packages/cli/src/render.ts` | `renderDashboardText(state)`: shared text rendering of `DashboardState` used by `status`. |
| `packages/web/package.json` | `@maestro/web` manifest; deps on `@maestro/core`, `fastify`. |
| `packages/web/src/server.ts` | `buildServer(opts)`: Fastify app factory taking `{ getState }`; registers routes; no `.listen()`. |
| `packages/web/src/routes.ts` | `registerRoutes(app, getState)`: `GET /api/state` (JSON) and `GET /` (HTML). |
| `packages/web/src/render.ts` | `renderDashboardHtml(state)`: pure `DashboardState` → HTML string. |

### Shared type: `DashboardState`

`status`, `/api/state`, and `/` all serialize the same shape. Its source fields come from the daemon's `RunState` (M1) plus config `repos`. **The exact `RunState` type is not defined in contracts** (see Open questions) — this plan defines `DashboardState` as the wire contract the web layer owns, and treats `RunState` as the provider that fills it. `DashboardState` lives in `packages/core/src/daemon/state.ts` exports so both packages import it from `@maestro/core`.

```ts
// added to packages/core/src/daemon/state.ts (M5 contribution)
export interface DashboardRepo {
  url: string;
  forge: import('../domain/types.js').Forge;
}
export interface DashboardIssue {
  repoUrl: string;
  issueNumber: number;
  title: string;
  lifecycle: import('../domain/types.js').LifecycleState;
}
export interface DashboardState {
  running: DashboardIssue[];   // issues holding a concurrency slot right now
  queued: DashboardIssue[];    // claimed/in_progress but not yet running
  repos: DashboardRepo[];      // watched repos from config
  generatedAt: string;         // ISO 8601
}
```

> If M1 ships a richer `RunState`, M5 adds a `toDashboardState(runState, repos): DashboardState` mapper in the same file. This plan builds against `DashboardState` only; the mapper is a thin adapter added in Task 12.

---

## Task 1: Web package scaffold

**Files:**
- Create: `packages/web/package.json`
- Create: `packages/web/tsconfig.json`

- [ ] **Step 1: Create the package manifest**

`packages/web/package.json`:

```json
{
  "name": "@maestro/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "dist/server.js",
  "types": "src/server.ts",
  "scripts": {
    "test": "vitest run",
    "build": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@maestro/core": "workspace:*",
    "fastify": "^4.28.1"
  },
  "devDependencies": {
    "typescript": "^5.5.4",
    "vitest": "^2.0.5"
  }
}
```

- [ ] **Step 2: Create the tsconfig**

`packages/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Install workspace deps**

Run: `pnpm install`
Expected: PASS — `@maestro/web` linked into the workspace, `fastify` resolved.

- [ ] **Step 4: Commit**

```bash
git add packages/web/package.json packages/web/tsconfig.json pnpm-lock.yaml
git commit -m "chore: scaffold @maestro/web package"
```

---

## Task 2: `DashboardState` type + HTML renderer (pure)

**Files:**
- Modify: `packages/core/src/daemon/state.ts` (add `DashboardState` exports)
- Create: `packages/web/src/render.ts`
- Test: `packages/web/src/render.test.ts`

- [ ] **Step 1: Add `DashboardState` types to core**

Append to `packages/core/src/daemon/state.ts`:

```ts
import type { Forge, LifecycleState } from '../domain/types.js';

export interface DashboardRepo {
  url: string;
  forge: Forge;
}

export interface DashboardIssue {
  repoUrl: string;
  issueNumber: number;
  title: string;
  lifecycle: LifecycleState;
}

export interface DashboardState {
  running: DashboardIssue[];
  queued: DashboardIssue[];
  repos: DashboardRepo[];
  generatedAt: string;
}
```

Ensure these are re-exported from `packages/core/src/index.ts` (add if missing):

```ts
export type { DashboardState, DashboardRepo, DashboardIssue } from './daemon/state.js';
```

- [ ] **Step 2: Write the failing test**

`packages/web/src/render.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { DashboardState } from '@maestro/core';
import { renderDashboardHtml } from './render.js';

const sample: DashboardState = {
  running: [
    { repoUrl: 'gitlab.com/group/api', issueNumber: 7, title: 'Fix login', lifecycle: 'in_progress' },
  ],
  queued: [
    { repoUrl: 'github.com/org/web', issueNumber: 12, title: 'Add search', lifecycle: 'in_progress' },
  ],
  repos: [
    { url: 'gitlab.com/group/api', forge: 'gitlab' },
    { url: 'github.com/org/web', forge: 'github' },
  ],
  generatedAt: '2026-06-03T10:00:00.000Z',
};

describe('renderDashboardHtml', () => {
  it('renders a self-contained read-only HTML page', () => {
    const html = renderDashboardHtml(sample);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Maestro');
    expect(html).toContain('Fix login');
    expect(html).toContain('#7');
    expect(html).toContain('Add search');
    expect(html).toContain('gitlab.com/group/api');
    expect(html).toContain('github.com/org/web');
    expect(html).toContain('2026-06-03T10:00:00.000Z');
  });

  it('escapes HTML in titles to prevent injection', () => {
    const html = renderDashboardHtml({
      ...sample,
      running: [{ repoUrl: 'r', issueNumber: 1, title: '<script>x</script>', lifecycle: 'in_progress' }],
    });
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
  });
});
```

- [ ] **Step 2b: Run test to verify it fails**

Run: `pnpm --filter @maestro/web test -- render`
Expected: FAIL with "Cannot find module './render.js'" (or "renderDashboardHtml is not a function").

- [ ] **Step 3: Write minimal implementation**

`packages/web/src/render.ts`:

```ts
import type { DashboardState, DashboardIssue } from '@maestro/core';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function issueRow(i: DashboardIssue): string {
  return `<tr><td>${esc(i.repoUrl)}</td><td>#${i.issueNumber}</td><td>${esc(i.title)}</td><td>${esc(i.lifecycle)}</td></tr>`;
}

export function renderDashboardHtml(state: DashboardState): string {
  const running = state.running.map(issueRow).join('') || '<tr><td colspan="4">none</td></tr>';
  const queued = state.queued.map(issueRow).join('') || '<tr><td colspan="4">none</td></tr>';
  const repos = state.repos
    .map((r) => `<li>${esc(r.url)} <em>(${esc(r.forge)})</em></li>`)
    .join('') || '<li>none</li>';
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Maestro</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem;max-width:60rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:.4rem .6rem;text-align:left}h1,h2{color:#222}</style>
</head>
<body>
<h1>Maestro</h1>
<p>Read-only dashboard. Generated at ${esc(state.generatedAt)}.</p>
<h2>Running</h2>
<table><thead><tr><th>Repo</th><th>Issue</th><th>Title</th><th>State</th></tr></thead><tbody>${running}</tbody></table>
<h2>Queued</h2>
<table><thead><tr><th>Repo</th><th>Issue</th><th>Title</th><th>State</th></tr></thead><tbody>${queued}</tbody></table>
<h2>Watched repos</h2>
<ul>${repos}</ul>
</body>
</html>`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/web test -- render`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/daemon/state.ts packages/core/src/index.ts packages/web/src/render.ts packages/web/src/render.test.ts
git commit -m "feat(web): add DashboardState type and read-only HTML renderer"
```

---

## Task 3: Web routes — `GET /api/state` and `GET /`

**Files:**
- Create: `packages/web/src/routes.ts`
- Test: `packages/web/src/routes.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/web/src/routes.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import type { DashboardState } from '@maestro/core';
import { registerRoutes } from './routes.js';

const sample: DashboardState = {
  running: [{ repoUrl: 'gitlab.com/g/api', issueNumber: 7, title: 'Fix login', lifecycle: 'in_progress' }],
  queued: [],
  repos: [{ url: 'gitlab.com/g/api', forge: 'gitlab' }],
  generatedAt: '2026-06-03T10:00:00.000Z',
};

function appWith(state: DashboardState) {
  const app = Fastify();
  registerRoutes(app, async () => state);
  return app;
}

describe('routes', () => {
  it('GET /api/state returns the DashboardState as JSON', async () => {
    const app = appWith(sample);
    const res = await app.inject({ method: 'GET', url: '/api/state' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json()).toEqual(sample);
  });

  it('GET / returns the HTML dashboard', async () => {
    const app = appWith(sample);
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<!doctype html>');
    expect(res.body).toContain('Fix login');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/web test -- routes`
Expected: FAIL with "Cannot find module './routes.js'".

- [ ] **Step 3: Write minimal implementation**

`packages/web/src/routes.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type { DashboardState } from '@maestro/core';
import { renderDashboardHtml } from './render.js';

export type StateProvider = () => Promise<DashboardState>;

export function registerRoutes(app: FastifyInstance, getState: StateProvider): void {
  app.get('/api/state', async (_req, reply) => {
    const state = await getState();
    reply.header('content-type', 'application/json; charset=utf-8');
    return state;
  });

  app.get('/', async (_req, reply) => {
    const state = await getState();
    reply.header('content-type', 'text/html; charset=utf-8');
    return renderDashboardHtml(state);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/web test -- routes`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/routes.ts packages/web/src/routes.test.ts
git commit -m "feat(web): add GET /api/state and GET / routes"
```

---

## Task 4: Fastify app factory `buildServer`

**Files:**
- Create: `packages/web/src/server.ts`
- Test: `packages/web/src/server.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/web/src/server.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { DashboardState } from '@maestro/core';
import { buildServer } from './server.js';

const empty: DashboardState = { running: [], queued: [], repos: [], generatedAt: '2026-06-03T00:00:00.000Z' };

describe('buildServer', () => {
  it('builds an injectable Fastify app wired to the state provider', async () => {
    let called = 0;
    const app = buildServer({
      getState: async () => {
        called += 1;
        return empty;
      },
    });
    const res = await app.inject({ method: 'GET', url: '/api/state' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(empty);
    expect(called).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/web test -- server`
Expected: FAIL with "Cannot find module './server.js'".

- [ ] **Step 3: Write minimal implementation**

`packages/web/src/server.ts`:

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import { registerRoutes, type StateProvider } from './routes.js';

export interface ServerOpts {
  getState: StateProvider;
}

export function buildServer(opts: ServerOpts): FastifyInstance {
  const app = Fastify({ logger: false });
  registerRoutes(app, opts.getState);
  return app;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/web test -- server`
Expected: PASS (1 passed).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/server.ts packages/web/src/server.test.ts
git commit -m "feat(web): add buildServer Fastify app factory"
```

---

## Task 5: CLI package scaffold + dependency seam

**Files:**
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Create: `packages/cli/src/deps.ts`
- Test: `packages/cli/src/deps.test.ts`

> **Default port & daemon URL (flagged in Open questions):** Neither the web PORT nor the daemon base URL is defined in contracts. This plan defaults to port **7330** and base URL **`http://127.0.0.1:7330`**, overridable via env vars `MAESTRO_WEB_PORT` and `MAESTRO_DAEMON_URL`. **Default log path (flagged):** contracts say `logs/` is a gitignored cache but name no file; this plan defaults to `logs/maestro.log`, overridable via `MAESTRO_LOG_FILE`.

- [ ] **Step 1: Create the package manifest**

`packages/cli/package.json`:

```json
{
  "name": "@maestro/cli",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": { "maestro": "dist/index.js" },
  "scripts": {
    "test": "vitest run",
    "build": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@maestro/core": "workspace:*",
    "commander": "^12.1.0",
    "execa": "^9.3.0",
    "yaml": "^2.5.0"
  },
  "devDependencies": {
    "typescript": "^5.5.4",
    "vitest": "^2.0.5"
  }
}
```

- [ ] **Step 2: Create the tsconfig**

`packages/cli/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write the failing test for the deps seam**

`packages/cli/src/deps.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { defaultCliDeps } from './deps.js';

describe('defaultCliDeps', () => {
  it('provides config path, daemon URL, log file, and the real collaborators', () => {
    const deps = defaultCliDeps();
    expect(deps.configPath).toMatch(/maestro\.config\.yaml$/);
    expect(deps.daemonUrl).toBe('http://127.0.0.1:7330');
    expect(deps.logFile).toMatch(/logs\/maestro\.log$/);
    expect(typeof deps.createForge).toBe('function');
    expect(typeof deps.fetch).toBe('function');
    expect(typeof deps.execa).toBe('function');
    expect(typeof deps.log).toBe('function');
  });

  it('honors env overrides', () => {
    const deps = defaultCliDeps({
      MAESTRO_DAEMON_URL: 'http://example:9000',
      MAESTRO_LOG_FILE: '/tmp/x.log',
      MAESTRO_CONFIG: '/tmp/c.yaml',
    });
    expect(deps.daemonUrl).toBe('http://example:9000');
    expect(deps.logFile).toBe('/tmp/x.log');
    expect(deps.configPath).toBe('/tmp/c.yaml');
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @maestro/cli test -- deps`
Expected: FAIL with "Cannot find module './deps.js'".

- [ ] **Step 5: Write minimal implementation**

`packages/cli/src/deps.ts`:

```ts
import { resolve } from 'node:path';
import { execa } from 'execa';
import { createForge } from '@maestro/core';

// Injection seam: every command receives a CliDeps so tests pass fakes.
export interface CliDeps {
  configPath: string;
  daemonUrl: string;
  logFile: string;
  createForge: typeof createForge;
  fetch: typeof fetch;
  execa: typeof execa;
  log: (line: string) => void;
}

const DEFAULT_PORT = 7330;

export function defaultCliDeps(env: NodeJS.ProcessEnv = process.env): CliDeps {
  const port = env.MAESTRO_WEB_PORT ?? String(DEFAULT_PORT);
  return {
    configPath: env.MAESTRO_CONFIG ?? resolve(process.cwd(), 'maestro.config.yaml'),
    daemonUrl: env.MAESTRO_DAEMON_URL ?? `http://127.0.0.1:${port}`,
    logFile: env.MAESTRO_LOG_FILE ?? resolve(process.cwd(), 'logs/maestro.log'),
    createForge,
    fetch: globalThis.fetch,
    execa,
    log: (line: string) => process.stdout.write(line + '\n'),
  };
}
```

> `createForge` is imported from `@maestro/core` per the contract file tree (`forge/factory.ts`, re-exported from `index.ts`). If `index.ts` does not yet re-export it, add `export { createForge } from './forge/factory.js';` to `packages/core/src/index.ts` as part of this step.

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @maestro/cli test -- deps`
Expected: PASS (2 passed).

- [ ] **Step 7: Install and commit**

```bash
pnpm install
git add packages/cli/package.json packages/cli/tsconfig.json packages/cli/src/deps.ts packages/cli/src/deps.test.ts packages/core/src/index.ts pnpm-lock.yaml
git commit -m "chore: scaffold @maestro/cli package with injectable deps"
```

---

## Task 6: `maestro list`

**Files:**
- Create: `packages/cli/src/commands/list.ts`
- Test: `packages/cli/src/commands/list.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/cli/src/commands/list.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listCommand } from './list.js';

function tempConfig(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'maestro-list-'));
  const path = join(dir, 'maestro.config.yaml');
  writeFileSync(path, yaml);
  return path;
}

const baseConfig = `defaults:
  pollIntervalActive: "30s"
  pollIntervalIdle: "5m"
  pollJitter: "5s"
  botUser: maestro-bot
  concurrency: { globalMax: 2 }
  workspaces: { root: ./workspaces, diskCap: 20GB, cleanup: lru }
forges:
  gitlab: { host: gitlab.com, tokenEnv: MAESTRO_GITLAB_TOKEN }
repos:
  - url: gitlab.com/group/api
  - url: github.com/org/web
`;

describe('listCommand', () => {
  it('prints each watched repo url', async () => {
    const lines: string[] = [];
    await listCommand({
      configPath: tempConfig(baseConfig),
      log: (l) => lines.push(l),
    });
    const out = lines.join('\n');
    expect(out).toContain('gitlab.com/group/api');
    expect(out).toContain('github.com/org/web');
  });

  it('prints a friendly message when no repos are watched', async () => {
    const empty = baseConfig.replace(/repos:[\s\S]*$/, 'repos: []\n');
    const lines: string[] = [];
    await listCommand({ configPath: tempConfig(empty), log: (l) => lines.push(l) });
    expect(lines.join('\n')).toMatch(/no repos/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/cli test -- list`
Expected: FAIL with "Cannot find module './list.js'".

- [ ] **Step 3: Write minimal implementation**

`packages/cli/src/commands/list.ts`:

```ts
import { loadConfig } from '@maestro/core';

export interface ListDeps {
  configPath: string;
  log: (line: string) => void;
}

export async function listCommand(deps: ListDeps): Promise<void> {
  const config = loadConfig(deps.configPath);
  if (config.repos.length === 0) {
    deps.log('No repos watched. Use `maestro add <url>` to add one.');
    return;
  }
  deps.log(`Watching ${config.repos.length} repo(s):`);
  for (const repo of config.repos) {
    deps.log(`  - ${repo.url}`);
  }
}
```

> Uses `loadConfig(path)` from `@maestro/core` (contract: `config/load.ts`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/cli test -- list`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/list.ts packages/cli/src/commands/list.test.ts
git commit -m "feat(cli): add maestro list command"
```

---

## Task 7: `status` text renderer (pure)

**Files:**
- Create: `packages/cli/src/render.ts`
- Test: `packages/cli/src/render.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/cli/src/render.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { DashboardState } from '@maestro/core';
import { renderDashboardText } from './render.js';

const sample: DashboardState = {
  running: [{ repoUrl: 'gitlab.com/g/api', issueNumber: 7, title: 'Fix login', lifecycle: 'in_progress' }],
  queued: [{ repoUrl: 'github.com/o/web', issueNumber: 12, title: 'Add search', lifecycle: 'in_progress' }],
  repos: [{ url: 'gitlab.com/g/api', forge: 'gitlab' }, { url: 'github.com/o/web', forge: 'github' }],
  generatedAt: '2026-06-03T10:00:00.000Z',
};

describe('renderDashboardText', () => {
  it('shows running and queued issues with repo and number', () => {
    const out = renderDashboardText(sample);
    expect(out).toMatch(/Running \(1\)/);
    expect(out).toContain('gitlab.com/g/api#7');
    expect(out).toContain('Fix login');
    expect(out).toMatch(/Queued \(1\)/);
    expect(out).toContain('github.com/o/web#12');
  });

  it('handles an idle daemon', () => {
    const out = renderDashboardText({ running: [], queued: [], repos: [], generatedAt: 'x' });
    expect(out).toMatch(/Running \(0\)/);
    expect(out).toMatch(/Queued \(0\)/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/cli test -- render`
Expected: FAIL with "Cannot find module './render.js'".

- [ ] **Step 3: Write minimal implementation**

`packages/cli/src/render.ts`:

```ts
import type { DashboardState, DashboardIssue } from '@maestro/core';

function line(i: DashboardIssue): string {
  return `  ${i.repoUrl}#${i.issueNumber}  ${i.title}  [${i.lifecycle}]`;
}

export function renderDashboardText(state: DashboardState): string {
  const out: string[] = [];
  out.push(`Running (${state.running.length}):`);
  for (const i of state.running) out.push(line(i));
  out.push(`Queued (${state.queued.length}):`);
  for (const i of state.queued) out.push(line(i));
  out.push(`Watching ${state.repos.length} repo(s). Generated at ${state.generatedAt}.`);
  return out.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/cli test -- render`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/render.ts packages/cli/src/render.test.ts
git commit -m "feat(cli): add dashboard text renderer for status"
```

---

## Task 8: `maestro status`

**Files:**
- Create: `packages/cli/src/commands/status.ts`
- Test: `packages/cli/src/commands/status.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/cli/src/commands/status.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { DashboardState } from '@maestro/core';
import { statusCommand } from './status.js';

const state: DashboardState = {
  running: [{ repoUrl: 'gitlab.com/g/api', issueNumber: 7, title: 'Fix login', lifecycle: 'in_progress' }],
  queued: [],
  repos: [{ url: 'gitlab.com/g/api', forge: 'gitlab' }],
  generatedAt: '2026-06-03T10:00:00.000Z',
};

function fakeFetch(ok: boolean, body: unknown): typeof fetch {
  return (async () =>
    ({
      ok,
      status: ok ? 200 : 503,
      json: async () => body,
    }) as unknown as Response) as typeof fetch;
}

describe('statusCommand', () => {
  it('fetches /api/state from the daemon and renders it', async () => {
    const lines: string[] = [];
    await statusCommand({
      daemonUrl: 'http://127.0.0.1:7330',
      fetch: fakeFetch(true, state),
      log: (l) => lines.push(l),
    });
    const out = lines.join('\n');
    expect(out).toContain('gitlab.com/g/api#7');
    expect(out).toContain('Fix login');
  });

  it('prints a helpful error when the daemon is unreachable', async () => {
    const lines: string[] = [];
    await statusCommand({
      daemonUrl: 'http://127.0.0.1:7330',
      fetch: (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch,
      log: (l) => lines.push(l),
    });
    expect(lines.join('\n')).toMatch(/daemon.*not.*reach|unreachable|ECONNREFUSED/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/cli test -- status`
Expected: FAIL with "Cannot find module './status.js'".

- [ ] **Step 3: Write minimal implementation**

`packages/cli/src/commands/status.ts`:

```ts
import type { DashboardState } from '@maestro/core';
import { renderDashboardText } from '../render.js';

export interface StatusDeps {
  daemonUrl: string;
  fetch: typeof fetch;
  log: (line: string) => void;
}

export async function statusCommand(deps: StatusDeps): Promise<void> {
  let res: Response;
  try {
    res = await deps.fetch(`${deps.daemonUrl}/api/state`);
  } catch (err) {
    deps.log(`Could not reach the maestro daemon at ${deps.daemonUrl} (${(err as Error).message}).`);
    deps.log('Is the daemon running?');
    return;
  }
  if (!res.ok) {
    deps.log(`Daemon returned HTTP ${res.status} for /api/state.`);
    return;
  }
  const state = (await res.json()) as DashboardState;
  deps.log(renderDashboardText(state));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/cli test -- status`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/status.ts packages/cli/src/commands/status.test.ts
git commit -m "feat(cli): add maestro status command reading daemon /api/state"
```

---

## Task 9: `maestro logs`

**Files:**
- Create: `packages/cli/src/commands/logs.ts`
- Test: `packages/cli/src/commands/logs.test.ts`

> Default (non-follow) prints the last N lines of the log file. `--follow` streaming tail is flagged in Open questions; this task implements the read-and-print path so the command is complete and testable without long-lived processes.

- [ ] **Step 1: Write the failing test**

`packages/cli/src/commands/logs.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logsCommand } from './logs.js';

function tempLog(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'maestro-logs-'));
  const path = join(dir, 'maestro.log');
  writeFileSync(path, content);
  return path;
}

describe('logsCommand', () => {
  it('prints the last N lines of the log file', async () => {
    const content = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const lines: string[] = [];
    await logsCommand({ logFile: tempLog(content), log: (l) => lines.push(l) }, { lines: 3 });
    expect(lines).toEqual(['line 8', 'line 9', 'line 10']);
  });

  it('reports when the log file does not exist yet', async () => {
    const lines: string[] = [];
    await logsCommand({ logFile: '/nonexistent/maestro.log', log: (l) => lines.push(l) }, { lines: 3 });
    expect(lines.join('\n')).toMatch(/no log file|not found/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/cli test -- logs`
Expected: FAIL with "Cannot find module './logs.js'".

- [ ] **Step 3: Write minimal implementation**

`packages/cli/src/commands/logs.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';

export interface LogsDeps {
  logFile: string;
  log: (line: string) => void;
}

export interface LogsOpts {
  lines: number;
}

export async function logsCommand(deps: LogsDeps, opts: LogsOpts): Promise<void> {
  if (!existsSync(deps.logFile)) {
    deps.log(`No log file at ${deps.logFile} (daemon may not have started yet).`);
    return;
  }
  const all = readFileSync(deps.logFile, 'utf8').split('\n').filter((l) => l.length > 0);
  for (const line of all.slice(-opts.lines)) {
    deps.log(line);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/cli test -- logs`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/logs.ts packages/cli/src/commands/logs.test.ts
git commit -m "feat(cli): add maestro logs command (tail last N lines)"
```

---

## Task 10: `maestro run <issue> --attach`

**Files:**
- Create: `packages/cli/src/commands/run.ts`
- Test: `packages/cli/src/commands/run.test.ts`

> Workspace resolution uses `WorkspaceManager.pathFor(repoUrl, issueNumber)` from `@maestro/core`. **One repo per issue number is ambiguous when several repos are watched** — flagged in Open questions. This task requires `--repo <url>` to disambiguate, defaulting to the single watched repo when exactly one exists.

- [ ] **Step 1: Write the failing test**

`packages/cli/src/commands/run.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from './run.js';

const baseConfig = `defaults:
  pollIntervalActive: "30s"
  pollIntervalIdle: "5m"
  pollJitter: "5s"
  botUser: maestro-bot
  concurrency: { globalMax: 2 }
  workspaces: { root: ./workspaces, diskCap: 20GB, cleanup: lru }
forges:
  gitlab: { host: gitlab.com, tokenEnv: MAESTRO_GITLAB_TOKEN }
repos:
  - url: gitlab.com/group/api
`;

function tempConfig(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'maestro-run-'));
  const path = join(dir, 'maestro.config.yaml');
  writeFileSync(path, yaml);
  return path;
}

describe('runCommand', () => {
  it('launches interactive claude in the issue workspace with inherited stdio', async () => {
    const calls: Array<{ file: string; args: string[]; cwd?: string; stdio?: string }> = [];
    const fakeExeca = vi.fn((file: string, args: string[], options: { cwd?: string; stdio?: string }) => {
      calls.push({ file, args, cwd: options.cwd, stdio: options.stdio });
      return Promise.resolve({ exitCode: 0 });
    });
    await runCommand(
      {
        configPath: tempConfig(baseConfig),
        execa: fakeExeca as unknown as typeof import('execa').execa,
        pathFor: (url, n) => `/ws/${url.replace(/\W/g, '_')}/issue-${n}`,
        log: () => {},
      },
      7,
      { attach: true },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('claude');
    expect(calls[0].cwd).toBe('/ws/gitlab_com_group_api/issue-7');
    expect(calls[0].stdio).toBe('inherit');
    expect(calls[0].args).not.toContain('-p'); // interactive, NOT headless
  });

  it('errors without --attach (daemon path is not the CLI run path)', async () => {
    const lines: string[] = [];
    await runCommand(
      {
        configPath: tempConfig(baseConfig),
        execa: (() => Promise.resolve({ exitCode: 0 })) as unknown as typeof import('execa').execa,
        pathFor: (url, n) => `/ws/${n}`,
        log: (l) => lines.push(l),
      },
      7,
      { attach: false },
    );
    expect(lines.join('\n')).toMatch(/--attach/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/cli test -- run`
Expected: FAIL with "Cannot find module './run.js'".

- [ ] **Step 3: Write minimal implementation**

`packages/cli/src/commands/run.ts`:

```ts
import type { execa } from 'execa';
import { loadConfig } from '@maestro/core';

export interface RunDeps {
  configPath: string;
  execa: typeof execa;
  pathFor: (repoUrl: string, issueNumber: number) => string;
  log: (line: string) => void;
}

export interface RunOpts {
  attach: boolean;
  repo?: string;
}

export async function runCommand(deps: RunDeps, issueNumber: number, opts: RunOpts): Promise<void> {
  if (!opts.attach) {
    deps.log('maestro run requires --attach (launches an interactive claude session for one issue).');
    return;
  }
  const config = loadConfig(deps.configPath);
  let repoUrl = opts.repo;
  if (!repoUrl) {
    if (config.repos.length === 1) {
      repoUrl = config.repos[0].url;
    } else {
      deps.log('Multiple repos watched. Specify which with --repo <url>.');
      return;
    }
  }
  const cwd = deps.pathFor(repoUrl, issueNumber);
  deps.log(`Launching interactive claude in ${cwd} for issue #${issueNumber} ...`);
  // Interactive: no -p, no --output-format; inherit stdio so the human drives the TTY.
  await deps.execa('claude', [], { cwd, stdio: 'inherit' });
}
```

> `pathFor` is the `WorkspaceManager.pathFor` signature from the contract (`workspace/manager.ts`). It is injected here so the test needs no real WorkspaceManager; `index.ts` will wire a real instance.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/cli test -- run`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/run.ts packages/cli/src/commands/run.test.ts
git commit -m "feat(cli): add maestro run <issue> --attach interactive session"
```

---

## Task 11: `maestro add <url>` — config append helper

**Files:**
- Create: `packages/cli/src/commands/add.ts` (config-append helper first)
- Test: `packages/cli/src/commands/add.test.ts`

> `add` is large; build it in two tasks. Task 11 adds the pure `appendRepoEntry` helper (YAML round-trip). Task 12 adds the full `addCommand` orchestration (clone, forge setup, commit).

- [ ] **Step 1: Write the failing test**

`packages/cli/src/commands/add.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';
import { appendRepoEntry } from './add.js';

const baseConfig = `defaults:
  pollIntervalActive: "30s"
  pollIntervalIdle: "5m"
  pollJitter: "5s"
  botUser: maestro-bot
  concurrency: { globalMax: 2 }
  workspaces: { root: ./workspaces, diskCap: 20GB, cleanup: lru }
forges:
  gitlab: { host: gitlab.com, tokenEnv: MAESTRO_GITLAB_TOKEN }
repos:
  - url: gitlab.com/group/api
`;

describe('appendRepoEntry', () => {
  it('appends a new repo entry to the YAML, preserving existing repos', () => {
    const next = appendRepoEntry(baseConfig, 'github.com/org/web');
    const parsed = parse(next) as { repos: Array<{ url: string }> };
    expect(parsed.repos.map((r) => r.url)).toEqual(['gitlab.com/group/api', 'github.com/org/web']);
    expect(parsed).toHaveProperty('defaults.botUser', 'maestro-bot');
  });

  it('is idempotent — does not duplicate an already-watched repo', () => {
    const next = appendRepoEntry(baseConfig, 'gitlab.com/group/api');
    const parsed = parse(next) as { repos: Array<{ url: string }> };
    expect(parsed.repos.filter((r) => r.url === 'gitlab.com/group/api')).toHaveLength(1);
  });

  it('handles an empty repos list', () => {
    const empty = baseConfig.replace(/repos:[\s\S]*$/, 'repos: []\n');
    const next = appendRepoEntry(empty, 'github.com/org/web');
    const parsed = parse(next) as { repos: Array<{ url: string }> };
    expect(parsed.repos.map((r) => r.url)).toEqual(['github.com/org/web']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/cli test -- add`
Expected: FAIL with "Cannot find module './add.js'".

- [ ] **Step 3: Write minimal implementation**

`packages/cli/src/commands/add.ts`:

```ts
import { parseDocument, type YAMLSeq, type YAMLMap } from 'yaml';

// Append a { url } RepoEntry to the repos sequence, preserving comments/formatting.
export function appendRepoEntry(configYaml: string, url: string): string {
  const doc = parseDocument(configYaml);
  const repos = doc.get('repos') as YAMLSeq | undefined;
  const exists =
    repos?.items.some((item) => {
      const map = item as YAMLMap;
      return map.get('url') === url;
    }) ?? false;
  if (exists) return doc.toString();
  if (!repos) {
    doc.set('repos', [{ url }]);
  } else {
    repos.add({ url });
  }
  return doc.toString();
}
```

> Uses `yaml`'s `parseDocument` for a comment-preserving round-trip (contract tech stack: YAML via `yaml`). `RepoEntry` is `{ url, overrides? }` per `config/schema.ts`; only `url` is written here.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/cli test -- add`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/add.ts packages/cli/src/commands/add.test.ts
git commit -m "feat(cli): add appendRepoEntry YAML helper for maestro add"
```

---

## Task 12: `maestro add <url>` — full orchestration

**Files:**
- Modify: `packages/cli/src/commands/add.ts`
- Modify: `packages/cli/src/commands/add.test.ts`

- [ ] **Step 1: Write the failing test (append to add.test.ts)**

Add to `packages/cli/src/commands/add.test.ts`:

```ts
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { addCommand } from './add.js';

function tempConfigFile(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'maestro-add-'));
  const path = join(dir, 'maestro.config.yaml');
  writeFileSync(path, yaml);
  return path;
}

function fakeForge() {
  return {
    forge: 'github' as const,
    project: 'org/web',
    botUser: 'maestro-bot',
    ensureLabels: vi.fn(async () => {}),
    ensureBoard: vi.fn(async () => {}),
  };
}

describe('addCommand', () => {
  it('clones, sets up labels+board, appends the repo, and commits by default', async () => {
    const configPath = tempConfigFile(baseConfig);
    const forge = fakeForge();
    const execaCalls: Array<{ file: string; args: string[] }> = [];
    const fakeExeca = vi.fn((file: string, args: string[], opts?: { cwd?: string }) => {
      execaCalls.push({ file, args });
      // simulate `git clone` creating a dir WITHOUT a WORKFLOW.md
      if (file === 'git' && args[0] === 'clone') {
        const dest = args[args.length - 1];
        mkdirSync(dest, { recursive: true });
      }
      return Promise.resolve({ exitCode: 0, stdout: '' });
    });
    const lines: string[] = [];

    await addCommand(
      {
        configPath,
        createForge: (() => forge) as never,
        execa: fakeExeca as never,
        cloneRoot: mkdtempSync(join(tmpdir(), 'maestro-clones-')),
        log: (l) => lines.push(l),
      },
      'github.com/org/web',
      { commit: true },
    );

    // forge setup ran
    expect(forge.ensureLabels).toHaveBeenCalledOnce();
    expect(forge.ensureBoard).toHaveBeenCalledOnce();
    // config updated
    expect(readFileSync(configPath, 'utf8')).toContain('github.com/org/web');
    // committed by default
    const commit = execaCalls.find((c) => c.file === 'git' && c.args.includes('commit'));
    expect(commit).toBeTruthy();
    expect(commit!.args.join(' ')).toMatch(/maestro\.config\.yaml/);
    // guidance printed because no WORKFLOW.md found
    expect(lines.join('\n')).toMatch(/WORKFLOW\.md.*onboard|onboarding/i);
  });

  it('respects --no-commit', async () => {
    const configPath = tempConfigFile(baseConfig);
    const forge = fakeForge();
    const execaCalls: Array<{ file: string; args: string[] }> = [];
    const fakeExeca = vi.fn((file: string, args: string[]) => {
      execaCalls.push({ file, args });
      if (file === 'git' && args[0] === 'clone') {
        mkdirSync(args[args.length - 1], { recursive: true });
      }
      return Promise.resolve({ exitCode: 0, stdout: '' });
    });

    await addCommand(
      {
        configPath,
        createForge: (() => forge) as never,
        execa: fakeExeca as never,
        cloneRoot: mkdtempSync(join(tmpdir(), 'maestro-clones-')),
        log: () => {},
      },
      'github.com/org/web',
      { commit: false },
    );
    expect(execaCalls.find((c) => c.args.includes('commit'))).toBeUndefined();
    expect(readFileSync(configPath, 'utf8')).toContain('github.com/org/web');
  });

  it('skips onboarding guidance when the clone already has a WORKFLOW.md', async () => {
    const configPath = tempConfigFile(baseConfig);
    const forge = fakeForge();
    const fakeExeca = vi.fn((file: string, args: string[]) => {
      if (file === 'git' && args[0] === 'clone') {
        const dest = args[args.length - 1];
        mkdirSync(dest, { recursive: true });
        writeFileSync(join(dest, 'WORKFLOW.md'), '---\nforge: github\n---\nbody');
      }
      return Promise.resolve({ exitCode: 0, stdout: '' });
    });
    const lines: string[] = [];
    await addCommand(
      {
        configPath,
        createForge: (() => forge) as never,
        execa: fakeExeca as never,
        cloneRoot: mkdtempSync(join(tmpdir(), 'maestro-clones-')),
        log: (l) => lines.push(l),
      },
      'github.com/org/web',
      { commit: false },
    );
    expect(lines.join('\n')).not.toMatch(/run.*onboarding/i);
    expect(lines.join('\n')).toMatch(/already has a WORKFLOW\.md|onboarded/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/cli test -- add`
Expected: FAIL with "addCommand is not a function" / "Cannot find export addCommand".

- [ ] **Step 3: Write minimal implementation (append to add.ts)**

Append to `packages/cli/src/commands/add.ts`:

```ts
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { execa } from 'execa';
import { loadConfig, type createForge } from '@maestro/core';

export interface AddDeps {
  configPath: string;
  createForge: typeof createForge;
  execa: typeof execa;
  cloneRoot: string;      // where to clone the repo for inspection/setup
  log: (line: string) => void;
}

export interface AddOpts {
  commit: boolean;        // commander maps --no-commit to commit:false
}

// Derive forge from host, and clone target dir name, from a repo url like "github.com/org/web".
function parseRepoUrl(url: string): { forge: 'gitlab' | 'github'; cloneUrl: string; dirName: string } {
  const host = url.split('/')[0];
  const forge = host.includes('gitlab') ? 'gitlab' : 'github';
  const dirName = url.replace(/[^A-Za-z0-9]+/g, '_');
  const cloneUrl = `https://${url}.git`;
  return { forge, cloneUrl, dirName };
}

export async function addCommand(deps: AddDeps, url: string, opts: AddOpts): Promise<void> {
  const { forge, cloneUrl, dirName } = parseRepoUrl(url);
  const dest = join(deps.cloneRoot, dirName);

  deps.log(`Cloning ${url} ...`);
  await deps.execa('git', ['clone', '--depth', '1', cloneUrl, dest]);

  const config = loadConfig(deps.configPath);
  const adapter = deps.createForge(forge, url, { config });
  deps.log('Ensuring labels ...');
  await adapter.ensureLabels();
  deps.log('Ensuring board ...');
  await adapter.ensureBoard();

  const updated = appendRepoEntry(readFileSync(deps.configPath, 'utf8'), url);
  writeFileSync(deps.configPath, updated);
  deps.log(`Added ${url} to ${deps.configPath}.`);

  if (opts.commit) {
    await deps.execa('git', ['add', deps.configPath]);
    await deps.execa('git', ['commit', '-m', `feat: watch ${url}`]);
    deps.log('Committed config change.');
  }

  if (existsSync(join(dest, 'WORKFLOW.md'))) {
    deps.log(`${url} already has a WORKFLOW.md — fully onboarded.`);
  } else {
    deps.log(`No WORKFLOW.md found in ${url}. Run onboarding to create one (maestro onboarding, M7).`);
  }
}
```

> **`createForge` signature note:** the contract names `createForge(forge, repo, deps)` but does not specify the `deps` shape. This plan passes `{ config }`; flagged in Open questions. The test fakes `createForge` so the exact `deps` shape does not block M5.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/cli test -- add`
Expected: PASS (6 passed — 3 from Task 11 + 3 here).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/add.ts packages/cli/src/commands/add.test.ts
git commit -m "feat(cli): add maestro add command (clone, forge setup, commit)"
```

---

## Task 13: `commander` wiring in `index.ts`

**Files:**
- Create: `packages/cli/src/index.ts`
- Test: `packages/cli/src/index.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/cli/src/index.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { buildProgram } from './index.js';

function deps() {
  return {
    list: vi.fn(async () => {}),
    status: vi.fn(async () => {}),
    logs: vi.fn(async () => {}),
    run: vi.fn(async () => {}),
    add: vi.fn(async () => {}),
  };
}

describe('buildProgram', () => {
  it('registers all five commands', () => {
    const program = buildProgram(deps());
    const names = program.commands.map((c) => c.name()).sort();
    expect(names).toEqual(['add', 'list', 'logs', 'run', 'status']);
  });

  it('routes `add <url>` to the add handler, --no-commit → commit:false', async () => {
    const d = deps();
    const program = buildProgram(d);
    await program.parseAsync(['add', 'github.com/org/web', '--no-commit'], { from: 'user' });
    expect(d.add).toHaveBeenCalledWith('github.com/org/web', expect.objectContaining({ commit: false }));
  });

  it('routes `run <issue> --attach` with a numeric issue', async () => {
    const d = deps();
    const program = buildProgram(d);
    await program.parseAsync(['run', '7', '--attach'], { from: 'user' });
    expect(d.run).toHaveBeenCalledWith(7, expect.objectContaining({ attach: true }));
  });

  it('routes `logs --lines 50`', async () => {
    const d = deps();
    const program = buildProgram(d);
    await program.parseAsync(['logs', '--lines', '50'], { from: 'user' });
    expect(d.logs).toHaveBeenCalledWith(expect.objectContaining({ lines: 50 }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/cli test -- index`
Expected: FAIL with "Cannot find module './index.js'".

- [ ] **Step 3: Write minimal implementation**

`packages/cli/src/index.ts`:

```ts
import { Command } from 'commander';

// Handler bundle: index wires real handlers; tests pass spies.
export interface ProgramHandlers {
  add: (url: string, opts: { commit: boolean; repo?: string }) => Promise<void>;
  list: () => Promise<void>;
  status: () => Promise<void>;
  logs: (opts: { lines: number }) => Promise<void>;
  run: (issueNumber: number, opts: { attach: boolean; repo?: string }) => Promise<void>;
}

export function buildProgram(h: ProgramHandlers): Command {
  const program = new Command();
  program.name('maestro').description('Maestro — multi-repo issue orchestrator');

  program
    .command('add')
    .argument('<url>', 'repo url, e.g. github.com/org/web')
    .option('--no-commit', 'do not commit the config change')
    .option('--repo <url>', 'unused for add; reserved')
    .action(async (url: string, opts: { commit: boolean }) => {
      await h.add(url, { commit: opts.commit });
    });

  program.command('list').action(async () => {
    await h.list();
  });

  program.command('status').action(async () => {
    await h.status();
  });

  program
    .command('logs')
    .option('--lines <n>', 'number of trailing lines', (v) => parseInt(v, 10), 200)
    .action(async (opts: { lines: number }) => {
      await h.logs({ lines: opts.lines });
    });

  program
    .command('run')
    .argument('<issue>', 'issue number')
    .option('--attach', 'launch an interactive claude session', false)
    .option('--repo <url>', 'disambiguate which watched repo')
    .action(async (issue: string, opts: { attach: boolean; repo?: string }) => {
      await h.run(parseInt(issue, 10), { attach: opts.attach, repo: opts.repo });
    });

  return program;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/cli test -- index`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/index.ts packages/cli/src/index.test.ts
git commit -m "feat(cli): wire commander program with all five commands"
```

---

## Task 14: `main()` entrypoint wiring real deps

**Files:**
- Modify: `packages/cli/src/index.ts` (add `main()` + shebang export)

- [ ] **Step 1: Add the real-deps wiring (no new test — covered by handler tests + buildProgram test)**

Append to `packages/cli/src/index.ts`:

```ts
import { WorkspaceManager } from '@maestro/core';
import { defaultCliDeps } from './deps.js';
import { addCommand } from './commands/add.js';
import { listCommand } from './commands/list.js';
import { statusCommand } from './commands/status.js';
import { logsCommand } from './commands/logs.js';
import { runCommand } from './commands/run.js';
import { resolve, dirname } from 'node:path';

export async function main(argv: string[] = process.argv): Promise<void> {
  const deps = defaultCliDeps();
  const cloneRoot = resolve(dirname(deps.configPath), 'workspaces');
  const ws = new WorkspaceManager({ root: cloneRoot } as never);

  const program = buildProgram({
    add: (url, opts) =>
      addCommand(
        { configPath: deps.configPath, createForge: deps.createForge, execa: deps.execa, cloneRoot, log: deps.log },
        url,
        opts,
      ),
    list: () => listCommand({ configPath: deps.configPath, log: deps.log }),
    status: () => statusCommand({ daemonUrl: deps.daemonUrl, fetch: deps.fetch, log: deps.log }),
    logs: (opts) => logsCommand({ logFile: deps.logFile, log: deps.log }, opts),
    run: (issueNumber, opts) =>
      runCommand(
        {
          configPath: deps.configPath,
          execa: deps.execa,
          pathFor: (url, n) => ws.pathFor(url, n),
          log: deps.log,
        },
        issueNumber,
        opts,
      ),
  });

  await program.parseAsync(argv);
}

// Run when invoked as the bin entrypoint.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(String(err) + '\n');
    process.exit(1);
  });
}
```

> **`WorkspaceManager` construction note:** the contract declares the `WorkspaceManager` interface but not its constructor. `new WorkspaceManager({ root })` is the assumed shape; flagged in Open questions. If M3 exports a factory instead, swap the construction here — no command handler changes needed since `pathFor` is injected.

- [ ] **Step 2: Run the full CLI test suite to confirm nothing broke**

Run: `pnpm --filter @maestro/cli test`
Expected: PASS (all CLI suites green).

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/index.ts
git commit -m "feat(cli): add main() entrypoint wiring real core dependencies"
```

---

## Task 15: Daemon serves the web app (`/api/state`)

**Files:**
- Modify: `packages/core/src/daemon/state.ts` (add `toDashboardState` mapper)
- Test: `packages/core/src/daemon/state.test.ts`

> The daemon process must serve `buildServer` so `maestro status` can read `/api/state`. The daemon entrypoint is `packages/cli/src/daemon.ts` (M1 owns its lifecycle). M5's contribution is the `RunState → DashboardState` mapper and a documented wiring point. **M5 does not own the daemon loop**, so wiring is a documented call, not a new daemon file. The mapper lives in core where `DashboardState` is defined.

- [ ] **Step 1: Write the failing test**

`packages/core/src/daemon/state.test.ts` (append; create if absent):

```ts
import { describe, it, expect } from 'vitest';
import { toDashboardState, type RunState } from './state.js';
import type { RepoEntry } from '../config/schema.js';

describe('toDashboardState', () => {
  it('maps running/queued slots and repos into a DashboardState', () => {
    const runState: RunState = {
      running: [{ repoUrl: 'gitlab.com/g/api', issueNumber: 7, title: 'Fix login', lifecycle: 'in_progress' }],
      queued: [{ repoUrl: 'github.com/o/web', issueNumber: 9, title: 'Add x', lifecycle: 'in_progress' }],
    };
    const repos: RepoEntry[] = [{ url: 'gitlab.com/g/api' }, { url: 'github.com/o/web' }];
    const dash = toDashboardState(runState, repos);
    expect(dash.running).toEqual(runState.running);
    expect(dash.queued).toEqual(runState.queued);
    expect(dash.repos).toEqual([
      { url: 'gitlab.com/g/api', forge: 'gitlab' },
      { url: 'github.com/o/web', forge: 'github' },
    ]);
    expect(typeof dash.generatedAt).toBe('string');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core test -- state`
Expected: FAIL with "toDashboardState is not a function" (or missing `RunState` export).

- [ ] **Step 3: Write minimal implementation**

Append to `packages/core/src/daemon/state.ts`:

```ts
import type { RepoEntry } from '../config/schema.js';

// M5-assumed RunState shape (NOT defined in contracts — see Open questions).
// running = slots actively held; queued = claimed/in_progress awaiting a slot.
export interface RunState {
  running: DashboardIssue[];
  queued: DashboardIssue[];
}

function forgeOf(url: string): Forge {
  return url.split('/')[0].includes('gitlab') ? 'gitlab' : 'github';
}

export function toDashboardState(runState: RunState, repos: RepoEntry[]): DashboardState {
  return {
    running: runState.running,
    queued: runState.queued,
    repos: repos.map((r) => ({ url: r.url, forge: forgeOf(r.url) })),
    generatedAt: new Date().toISOString(),
  };
}
```

> Re-export from `packages/core/src/index.ts`: `export { toDashboardState } from './daemon/state.js'; export type { RunState } from './daemon/state.js';`

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/core test -- state`
Expected: PASS (1 passed).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/daemon/state.ts packages/core/src/daemon/state.test.ts packages/core/src/index.ts
git commit -m "feat(core): add RunState→DashboardState mapper for web/status"
```

---

## Task 16: Full-suite green + lint

**Files:** none (verification only)

- [ ] **Step 1: Run all package test suites**

Run: `pnpm -r test`
Expected: PASS — `@maestro/core`, `@maestro/cli`, `@maestro/web` all green.

- [ ] **Step 2: Typecheck builds**

Run: `pnpm -r build`
Expected: PASS — no TS errors across all three packages.

- [ ] **Step 3: Lint**

Run: `pnpm exec eslint packages/cli/src packages/web/src`
Expected: PASS — no errors.

- [ ] **Step 4: Commit any formatting fixes (only if files changed)**

```bash
git add packages/cli packages/web
git commit -m "chore: lint and format cli and web packages"
```

---

## Self-Review notes

- **Spec coverage:** `add` (clone/labels/board/commit/WORKFLOW detection) §16/§11/§5 → Tasks 11–12. `list` §8 → Task 6. `status` (live daemon state) §8 → Task 8. `logs` §8 → Task 9. `run --attach` (interactive claude) §8/§13 → Task 10. Web `/api/state` + `/` read-only dashboard §8 → Tasks 2–4. Daemon serves web §8/§14 → Task 15. `--no-commit` §5 → Task 12.
- **Out of scope confirmed not implemented:** onboarding internals (M7) — `add` only prints guidance; forge impls (M2/M6) — faked in tests, real wired via `createForge`; agent/proof internals (M3/M4).
- **Type consistency:** `DashboardState`/`DashboardIssue`/`DashboardRepo` defined once in `core/daemon/state.ts`, imported everywhere. `pathFor(repoUrl, issueNumber)` matches the contract `WorkspaceManager` signature. `RepoEntry { url }` matches `config/schema.ts`.

---

## Open questions

These are gaps the contracts (`maestro-00-contracts.md`) did not cover. The plan picked reasonable defaults where it had to, marked here so the contract can be updated rather than treating any of these as settled.

1. **`RunState` shape is undefined.** `daemon/state.ts` is listed as "in-memory RunState (running slots, no persistence)" but no `RunState` type/interface is given. `status`, `/api/state`, and the dashboard all need it. This plan **invented** a minimal `RunState { running: DashboardIssue[]; queued: DashboardIssue[] }` plus a `DashboardState` wire type. Contracts should define the authoritative `RunState` and whether `DashboardState` is its public projection (M5 Task 2/15). If M1 ships a richer `RunState`, only `toDashboardState` changes.

2. **Web server PORT is undefined.** Contracts name `web/src/server.ts` as a Fastify factory but give no port and no `listen` convention. This plan defaults to **7330** (`MAESTRO_WEB_PORT` env override). Needs confirmation + a contract entry, and a decision on bind address (this plan assumes loopback `127.0.0.1`).

3. **How `maestro status` reaches the daemon is undefined.** No daemon-discovery mechanism, socket, or URL is specified. This plan has `status` make an HTTP `GET` to **`http://127.0.0.1:7330/api/state`** (`MAESTRO_DAEMON_URL` override), relying on "the daemon process serves the web app". Confirm whether HTTP-over-loopback is the intended IPC, or whether a unix socket / pid file is expected.

4. **`createForge(forge, repo, deps)` `deps` shape is undefined.** The factory is named in the file tree but its `deps` parameter is unspecified. `add` needs `createForge` to build an adapter with enough context (token env, host) to call `ensureLabels`/`ensureBoard`. This plan passes `{ config }` and fakes the factory in tests. Contracts should pin the exact `createForge` signature (M2 owns it).

5. **`WorkspaceManager` constructor is undefined.** The interface is specified but not how to construct an instance. `maestro run` and `add` need `pathFor`/clone dirs. This plan assumes `new WorkspaceManager({ root })` and injects `pathFor` into the `run` handler so tests don't depend on it. Contracts should specify the constructor or a factory (M3 owns it).

6. **Daemon log file path/format is undefined.** `logs/` is described as a gitignored cache with no filename. `maestro logs` defaults to **`logs/maestro.log`** (`MAESTRO_LOG_FILE` override) and prints trailing lines. Whether the daemon writes a single file, rotates, or uses JSON-lines (and whether `--follow` streaming is required) is unspecified — this plan implements last-N-lines only and flags `--follow` as deferred.

7. **`maestro run <issue>` repo disambiguation.** An issue number alone does not identify a repo when several are watched, but `pathFor(repoUrl, issueNumber)` requires a repo URL. This plan adds a `--repo <url>` flag, defaulting to the sole watched repo. Contracts should confirm whether `run` is keyed by issue+repo or whether workspaces are keyed differently.

8. **Clone URL scheme / auth for `maestro add`.** Contracts give repo URLs as `host/path` (e.g. `github.com/org/web`) but not the clone transport. This plan constructs `https://<url>.git`. SSH vs HTTPS and how the bot token authenticates the clone are unspecified.
