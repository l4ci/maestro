# Maestro M1 — Core Skeleton, Config & Reconciler — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Maestro monorepo skeleton and ship a forge-agnostic reconciler that drives the full issue lifecycle (new → in_progress → in_review → merge → done, plus blocked and changes-requested) against an in-memory fake forge, with config + WORKFLOW.md loaders and a runnable daemon demo.

**Architecture:** A pnpm/ESM TypeScript monorepo. `@maestro/core` holds the domain types, a pure reconciler (`derive` + `decide`), a `ForgeAdapter` interface with an in-memory `MemoryForge` implementation, config/workflow zod loaders, and a stateless poll loop with an injected clock. The reconciler executes one `Action` per assigned issue per tick by calling the adapter plus injected collaborators (`ClaudeRunner`, `runProof`, `WorkspaceManager`) — the seams that M3/M4 fill with real implementations. `@maestro/cli` wires `MemoryForge` + inline stub collaborators into a runnable demo.

**Tech Stack:** Node 20+, TypeScript 5.x, ESM (`"type": "module"`), pnpm workspaces, Vitest, zod, `yaml`, `gray-matter`, ESLint + Prettier. (`execa`, `commander`, `fastify` are declared for later milestones but not exercised here.)

**Depends on:** nothing (first milestone)

---

## File Structure

Files this milestone creates (✦ = owned/created here; later-milestone files in the contract tree are NOT created):

```
package.json                          ✦ pnpm workspace root (ESM)
pnpm-workspace.yaml                   ✦
tsconfig.base.json                    ✦ shared TS compiler options
vitest.config.ts                      ✦ root Vitest config (workspace-wide)
.eslintrc.json                        ✦ minimal flat-free ESLint config
.prettierrc.json                      ✦ minimal Prettier config
.gitignore                            ✦ node_modules, dist, workspaces, logs
packages/core/package.json            ✦ @maestro/core
packages/core/tsconfig.json           ✦ extends base
packages/core/src/
  domain/types.ts                     ✦ Forge, LifecycleState, Issue, MergeRequest, IssueSnapshot, Action, MergeStrategy
  domain/lifecycle.ts                 ✦ LABELED_STATES + label helpers
  config/schema.ts                    ✦ MaestroConfig zod schema + parseDuration
  config/load.ts                      ✦ loadConfig, watchConfig
  workflow/schema.ts                  ✦ WorkflowConfig zod schema
  workflow/load.ts                    ✦ parseWorkflow, loadWorkflow
  forge/adapter.ts                    ✦ ForgeAdapter interface, ForgeError, CreateMrArgs, CommentTarget
  forge/memory.ts                     ✦ MemoryForge (in-memory ForgeAdapter)
  agent/contract.ts                   ✦ AgentResult/AgentStatus (type-only; M3 adds parseAgentResult)
  agent/runner.ts                     ✦ ClaudeRunner interface (type-only seam; M3 adds impl)
  proof/index.ts                      ✦ ProofArtifact/ProofContext/ProofStrategy (type-only seam; M4 adds runProof)
  workspace/manager.ts                ✦ WorkspaceManager interface (type-only seam; M3 adds impl)
  util/exec.ts                        ✦ CommandRunner interface (type-only seam; M2/M3 add execaRunner)
  reconciler/derive.ts                ✦ deriveLifecycle (pure)
  reconciler/decide.ts                ✦ decideAction (pure)
  reconciler/index.ts                 ✦ reconcileRepo(deps): Promise<void> — derive+decide+executeAction
  daemon/state.ts                     ✦ SlotManager + RunState (in-memory slots, rebuilt from forge)
  daemon/scheduler.ts                 ✦ per-repo active/idle cadence + jitter (injected clock)
  daemon/loop.ts                      ✦ tick()
  logger.ts                           ✦ structured logger
  index.ts                            ✦ public exports
packages/cli/package.json             ✦ @maestro/cli
packages/cli/tsconfig.json            ✦ extends base
packages/cli/src/daemon.ts            ✦ runnable demo: MemoryForge + inline stub collaborators + loop
```

Colocated tests created alongside source (`*.test.ts`):

```
packages/core/src/config/schema.test.ts
packages/core/src/config/load.test.ts
packages/core/src/workflow/load.test.ts
packages/core/src/forge/memory.test.ts
packages/core/src/reconciler/derive.test.ts
packages/core/src/reconciler/decide.test.ts
packages/core/src/reconciler/index.test.ts
packages/core/src/daemon/scheduler.test.ts
packages/core/src/daemon/state.test.ts
packages/core/src/daemon/loop.test.ts
packages/core/src/logger.test.ts
```

**Conventions enforced throughout:** TDD (failing test → run → minimal impl → run → commit). Conventional Commits, explicit `git add <paths>`, NO `Co-Authored-By`. Pure reconciler (`derive.ts`/`decide.ts` import no adapter, do no I/O). No persistence beyond `daemon/state.ts` (rebuilt from forge). All intra-package imports use explicit `.js` extensions (ESM + NodeNext).

> **Test runner note:** all `npx vitest run ...` commands are run from the repo root. Vitest auto-loads `vitest.config.ts`. `vitest run` executes once and exits (no watch).

---

## Task 1: Monorepo scaffold (pnpm workspaces, ESM, TS, Vitest, lint)

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `.eslintrc.json`, `.prettierrc.json`, `.gitignore`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`
- Create: `packages/core/src/index.ts` (temporary stub), `packages/core/src/index.test.ts` (temporary smoke test, deleted in Task 16)

- [ ] **Step 1: Create the workspace + tooling files**

`pnpm-workspace.yaml`:

```yaml
packages:
  - 'packages/*'
```

`package.json` (root):

```json
{
  "name": "maestro",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "pnpm -r build",
    "test": "vitest run",
    "lint": "eslint . --ext .ts",
    "format": "prettier --write ."
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "@typescript-eslint/eslint-plugin": "^7.13.0",
    "@typescript-eslint/parser": "^7.13.0",
    "eslint": "^8.57.0",
    "prettier": "^3.3.0",
    "typescript": "^5.5.0",
    "vitest": "^1.6.0"
  }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "declaration": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true
  }
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    environment: 'node',
  },
});
```

`.eslintrc.json`:

```json
{
  "root": true,
  "parser": "@typescript-eslint/parser",
  "parserOptions": { "sourceType": "module", "ecmaVersion": 2022 },
  "plugins": ["@typescript-eslint"],
  "extends": ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  "env": { "node": true, "es2022": true },
  "ignorePatterns": ["dist", "node_modules"],
  "rules": {
    "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }]
  }
}
```

`.prettierrc.json`:

```json
{
  "singleQuote": true,
  "semi": true,
  "trailingComma": "all",
  "printWidth": 100
}
```

`.gitignore`:

```
node_modules/
dist/
*.tsbuildinfo
workspaces/
logs/
.env
```

- [ ] **Step 2: Create the core package files**

`packages/core/package.json`:

```json
{
  "name": "@maestro/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": { "build": "tsc -p tsconfig.json" },
  "dependencies": {
    "zod": "^3.23.0",
    "yaml": "^2.4.0",
    "gray-matter": "^4.0.3",
    "execa": "^9.1.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0"
  }
}
```

`packages/core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

`packages/core/src/index.ts` (temporary stub — replaced in Task 16):

```ts
export const MAESTRO_CORE = 'maestro-core';
```

`packages/core/src/index.test.ts` (temporary smoke test — deleted in Task 16):

```ts
import { describe, it, expect } from 'vitest';
import { MAESTRO_CORE } from './index.js';

describe('core package smoke', () => {
  it('exports a sentinel', () => {
    expect(MAESTRO_CORE).toBe('maestro-core');
  });
});
```

- [ ] **Step 3: Install dependencies**

Run: `pnpm install`
Expected: resolves and writes `pnpm-lock.yaml`, links `@maestro/core` into the workspace, exits 0.

- [ ] **Step 4: Run the smoke test to verify the toolchain works**

Run: `npx vitest run packages/core/src/index.test.ts`
Expected: PASS — `1 passed`. (If `pnpm install` failed, this fails first; fix install before proceeding.)

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json vitest.config.ts .eslintrc.json .prettierrc.json .gitignore pnpm-lock.yaml packages/core/package.json packages/core/tsconfig.json packages/core/src/index.ts packages/core/src/index.test.ts
git commit -m "chore: scaffold pnpm/ESM monorepo with core package and vitest"
```

---

## Task 2: Domain types

**Files:**
- Create: `packages/core/src/domain/types.ts`

> No test: this file is pure type declarations (erased at compile). It is exercised by every downstream test. Verify by compile only.

- [ ] **Step 1: Write the domain types**

`packages/core/src/domain/types.ts`:

```ts
export type Forge = 'gitlab' | 'github';

export type LifecycleState =
  | 'new' // assigned to bot, no maestro lifecycle label
  | 'in_progress'
  | 'in_review'
  | 'blocked'
  | 'done'; // issue closed

// Normalized, forge-agnostic issue.
export interface Issue {
  id: string; // forge-internal id (opaque)
  number: number; // human-facing #N
  title: string;
  body: string;
  state: 'open' | 'closed';
  assignees: string[]; // usernames
  authorUsername: string;
  labels: string[]; // raw labels (may include maestro lifecycle labels)
  createdAt: string; // ISO 8601
  webUrl: string;
}

// Normalized MR (GitLab) / PR (GitHub).
export interface MergeRequest {
  id: string;
  number: number;
  sourceBranch: string;
  targetBranch: string;
  isDraft: boolean;
  state: 'open' | 'merged' | 'closed';
  approved: boolean; // GitLab approval OR GitHub review state APPROVED
  changesRequested: boolean; // derived per WorkflowConfig.review.changesSignal
  reviewers: string[]; // REQUESTED reviewers
  linkedIssueNumbers: number[]; // from "Closes #N"
  description: string; // the agent's living plan/checklist (read back for context)
  webUrl: string;
}

export interface IssueSnapshot {
  issue: Issue;
  mr: MergeRequest | null;
  lifecycle: LifecycleState; // derived via deriveLifecycle()
}

// One action per issue per tick. `noop` means nothing to do this tick.
export type Action =
  | { kind: 'claim'; issueNumber: number } // new → create branch+draft MR, label in_progress
  | { kind: 'work'; issueNumber: number } // run/resume agent (consumes a slot); runs handoff inline on `done`
  | { kind: 'handoff'; issueNumber: number } // INTERNAL label only — invoked inline by the `work` executor, never returned by decideAction
  | { kind: 'review_check'; issueNumber: number } // poll approval; approved→merge, changes→in_progress
  | { kind: 'merge'; issueNumber: number }
  | { kind: 'cleanup'; issueNumber: number } // terminal → drop workspace
  | { kind: 'block'; issueNumber: number; reason: string }
  | { kind: 'noop'; issueNumber: number };

export type MergeStrategy = 'squash' | 'merge' | 'rebase';
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc -p packages/core/tsconfig.json --noEmit`
Expected: exits 0, no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/domain/types.ts
git commit -m "feat(core): add domain types"
```

---

## Task 3: Lifecycle label helpers

**Files:**
- Create: `packages/core/src/domain/lifecycle.ts`
- Test: `packages/core/src/domain/lifecycle.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/core/src/domain/lifecycle.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  LABELED_STATES,
  lifecycleLabel,
  allMaestroLabels,
  labeledStateOf,
} from './lifecycle.js';

describe('lifecycleLabel', () => {
  it('uses scoped labels for gitlab', () => {
    expect(lifecycleLabel('gitlab', 'in_progress')).toBe('maestro::in_progress');
    expect(lifecycleLabel('gitlab', 'in_review')).toBe('maestro::in_review');
    expect(lifecycleLabel('gitlab', 'blocked')).toBe('maestro::blocked');
  });

  it('uses flat labels for github', () => {
    expect(lifecycleLabel('github', 'in_progress')).toBe('maestro:in_progress');
    expect(lifecycleLabel('github', 'blocked')).toBe('maestro:blocked');
  });
});

describe('LABELED_STATES', () => {
  it('excludes new and done', () => {
    expect(LABELED_STATES).toEqual(['in_progress', 'in_review', 'blocked']);
  });
});

describe('allMaestroLabels', () => {
  it('lists all labels for a forge', () => {
    expect(allMaestroLabels('gitlab')).toEqual([
      'maestro::in_progress',
      'maestro::in_review',
      'maestro::blocked',
    ]);
  });
});

describe('labeledStateOf', () => {
  it('extracts the encoded state', () => {
    expect(labeledStateOf('gitlab', ['foo', 'maestro::in_review'])).toBe('in_review');
    expect(labeledStateOf('github', ['maestro:blocked'])).toBe('blocked');
  });

  it('returns null when no maestro label present', () => {
    expect(labeledStateOf('gitlab', ['bug', 'enhancement'])).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/domain/lifecycle.test.ts`
Expected: FAIL — `Failed to resolve import "./lifecycle.js"` (module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/domain/lifecycle.ts`:

```ts
import type { Forge, LifecycleState } from './types.js';

// Lifecycle states that map to a label (excludes 'new' and 'done').
export const LABELED_STATES = ['in_progress', 'in_review', 'blocked'] as const;
export type LabeledState = (typeof LABELED_STATES)[number];

// GitLab uses scoped labels (mutually exclusive): `maestro::in_progress`.
// GitHub uses flat labels: `maestro:in_progress` (exclusivity enforced by adapter).
export function lifecycleLabel(forge: Forge, state: LabeledState): string {
  return forge === 'gitlab' ? `maestro::${state}` : `maestro:${state}`;
}

// All maestro-owned labels for a forge (used to create labels and to strip).
export function allMaestroLabels(forge: Forge): string[] {
  return LABELED_STATES.map((s) => lifecycleLabel(forge, s));
}

// Extract the lifecycle state encoded in a label set, if any.
export function labeledStateOf(forge: Forge, labels: string[]): LabeledState | null {
  for (const s of LABELED_STATES) {
    if (labels.includes(lifecycleLabel(forge, s))) return s;
  }
  return null;
}

// Type guard helper: which lifecycle states are labeled.
export function isLabeledState(state: LifecycleState): state is LabeledState {
  return (LABELED_STATES as readonly string[]).includes(state);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/domain/lifecycle.test.ts`
Expected: PASS — all assertions green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/domain/lifecycle.ts packages/core/src/domain/lifecycle.test.ts
git commit -m "feat(core): add lifecycle label helpers"
```

---

## Task 4: parseDuration helper

**Files:**
- Create: `packages/core/src/config/schema.ts` (parseDuration only this task; zod schema added in Task 5)
- Test: `packages/core/src/config/schema.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/core/src/config/schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseDuration } from './schema.js';

describe('parseDuration', () => {
  it('parses seconds', () => {
    expect(parseDuration('30s')).toBe(30_000);
  });

  it('parses minutes', () => {
    expect(parseDuration('5m')).toBe(300_000);
  });

  it('parses hours', () => {
    expect(parseDuration('2h')).toBe(7_200_000);
  });

  it('parses milliseconds', () => {
    expect(parseDuration('250ms')).toBe(250);
  });

  it('throws on invalid input', () => {
    expect(() => parseDuration('soon')).toThrow();
    expect(() => parseDuration('10')).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/config/schema.test.ts`
Expected: FAIL — `Failed to resolve import "./schema.js"`.

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/config/schema.ts`:

```ts
// Parse a human duration ("30s", "5m", "2h", "250ms") into milliseconds.
const DURATION_RE = /^(\d+)(ms|s|m|h)$/;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

export function parseDuration(s: string): number {
  const match = DURATION_RE.exec(s.trim());
  if (!match) throw new Error(`Invalid duration: "${s}" (expected e.g. "30s", "5m", "2h", "250ms")`);
  const value = Number(match[1]);
  const unit = match[2]!;
  return value * UNIT_MS[unit]!;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/config/schema.test.ts`
Expected: PASS — `5 passed`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config/schema.ts packages/core/src/config/schema.test.ts
git commit -m "feat(core): add parseDuration helper"
```

---

## Task 5: Config zod schema

**Files:**
- Modify: `packages/core/src/config/schema.ts` (append zod schema + types)
- Test: `packages/core/src/config/schema.test.ts` (append schema tests)

> Contract field names: `pollIntervalActive`, `pollIntervalIdle`, `pollJitter`, `botUser`, `concurrency {globalMax?, maxActive?}`, `workspaces {root, diskCap, cleanup}`, `forges` (partial record of Forge → `{host, tokenEnv}`), `repos [{url, overrides?}]`. The YAML uses snake_case (`poll_interval_active`, `bot_user`, `global_max`, `disk_cap`, `token_env`); zod maps it to the camelCase TS interface.

- [ ] **Step 1: Write the failing test (append to schema.test.ts)**

Append to `packages/core/src/config/schema.test.ts`:

```ts
import { MaestroConfigSchema } from './schema.js';

describe('MaestroConfigSchema', () => {
  const raw = {
    defaults: {
      poll_interval_active: '30s',
      poll_interval_idle: '5m',
      poll_jitter: '5s',
      bot_user: 'maestro-bot',
      concurrency: { global_max: 2 },
      workspaces: { root: './workspaces', disk_cap: '20GB', cleanup: 'lru' },
    },
    forges: {
      gitlab: { host: 'gitlab.com', token_env: 'MAESTRO_GITLAB_TOKEN' },
      github: { host: 'github.com', token_env: 'MAESTRO_GITHUB_TOKEN' },
    },
    repos: [
      { url: 'gitlab.com/group/api' },
      { url: 'github.com/org/web', overrides: { concurrency: { max_active: 1 } } },
    ],
  };

  it('parses a full config into the camelCase shape', () => {
    const cfg = MaestroConfigSchema.parse(raw);
    expect(cfg.defaults.pollIntervalActive).toBe('30s');
    expect(cfg.defaults.botUser).toBe('maestro-bot');
    expect(cfg.defaults.concurrency.globalMax).toBe(2);
    expect(cfg.defaults.workspaces.cleanup).toBe('lru');
    expect(cfg.forges.gitlab?.tokenEnv).toBe('MAESTRO_GITLAB_TOKEN');
    expect(cfg.repos[0]!.url).toBe('gitlab.com/group/api');
    expect(cfg.repos[1]!.overrides?.concurrency?.maxActive).toBe(1);
  });

  it('rejects an unknown cleanup value', () => {
    const bad = structuredClone(raw);
    (bad.defaults.workspaces as { cleanup: string }).cleanup = 'sometimes';
    expect(() => MaestroConfigSchema.parse(bad)).toThrow();
  });

  it('rejects a config missing defaults', () => {
    expect(() => MaestroConfigSchema.parse({ forges: {}, repos: [] })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/config/schema.test.ts`
Expected: FAIL — `MaestroConfigSchema` is not exported (import error / undefined).

- [ ] **Step 3: Write minimal implementation (append to schema.ts)**

Append to `packages/core/src/config/schema.ts`:

```ts
import { z } from 'zod';

const concurrencySchema = z
  .object({
    global_max: z.number().int().positive().optional(),
    max_active: z.number().int().positive().optional(),
  })
  .transform((c) => ({ globalMax: c.global_max, maxActive: c.max_active }));

const workspacesSchema = z
  .object({
    root: z.string(),
    disk_cap: z.string(),
    cleanup: z.enum(['lru', 'on_terminal']),
  })
  .transform((w) => ({ root: w.root, diskCap: w.disk_cap, cleanup: w.cleanup }));

const defaultsSchema = z
  .object({
    poll_interval_active: z.string(),
    poll_interval_idle: z.string(),
    poll_jitter: z.string(),
    bot_user: z.string(),
    concurrency: concurrencySchema,
    workspaces: workspacesSchema,
  })
  .transform((d) => ({
    pollIntervalActive: d.poll_interval_active,
    pollIntervalIdle: d.poll_interval_idle,
    pollJitter: d.poll_jitter,
    botUser: d.bot_user,
    concurrency: d.concurrency,
    workspaces: d.workspaces,
  }));

const forgeAuthSchema = z
  .object({ host: z.string(), token_env: z.string() })
  .transform((f) => ({ host: f.host, tokenEnv: f.token_env }));

const repoEntrySchema = z.object({
  url: z.string(),
  overrides: z
    .object({
      poll_interval_active: z.string().optional(),
      poll_interval_idle: z.string().optional(),
      poll_jitter: z.string().optional(),
      bot_user: z.string().optional(),
      concurrency: concurrencySchema.optional(),
      workspaces: workspacesSchema.optional(),
    })
    .transform((o) => ({
      pollIntervalActive: o.poll_interval_active,
      pollIntervalIdle: o.poll_interval_idle,
      pollJitter: o.poll_jitter,
      botUser: o.bot_user,
      concurrency: o.concurrency,
      workspaces: o.workspaces,
    }))
    .optional(),
});

export const MaestroConfigSchema = z.object({
  defaults: defaultsSchema,
  forges: z.object({ gitlab: forgeAuthSchema.optional(), github: forgeAuthSchema.optional() }),
  repos: z.array(repoEntrySchema),
});

export interface ForgeAuth {
  host: string;
  tokenEnv: string;
}
export interface ConcurrencyCfg {
  globalMax?: number;
  maxActive?: number;
}
export interface WorkspacesCfg {
  root: string;
  diskCap: string;
  cleanup: 'lru' | 'on_terminal';
}
export interface DefaultsCfg {
  pollIntervalActive: string;
  pollIntervalIdle: string;
  pollJitter: string;
  botUser: string;
  concurrency: ConcurrencyCfg;
  workspaces: WorkspacesCfg;
}
export interface RepoEntry {
  url: string;
  overrides?: Partial<DefaultsCfg>;
}
export interface MaestroConfig {
  defaults: DefaultsCfg;
  forges: Partial<Record<import('../domain/types.js').Forge, ForgeAuth>>;
  repos: RepoEntry[];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/config/schema.test.ts`
Expected: PASS — `8 passed` (5 parseDuration + 3 schema).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config/schema.ts packages/core/src/config/schema.test.ts
git commit -m "feat(core): add MaestroConfig zod schema"
```

---

## Task 6: Config loader (loadConfig + watchConfig)

**Files:**
- Create: `packages/core/src/config/load.ts`
- Test: `packages/core/src/config/load.test.ts`

> `loadConfig(path)` reads a YAML file, parses with `yaml`, validates with `MaestroConfigSchema`. `watchConfig(path, cb)` uses `fs.watch`, re-runs `loadConfig` on change, calls `cb(config)` only on a valid parse (validate before reload), returns a `() => void` unsubscribe.

- [ ] **Step 1: Write the failing test**

`packages/core/src/config/load.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, watchConfig } from './load.js';

const VALID = `
defaults:
  poll_interval_active: 30s
  poll_interval_idle: 5m
  poll_jitter: 5s
  bot_user: maestro-bot
  concurrency: { global_max: 2 }
  workspaces: { root: ./workspaces, disk_cap: 20GB, cleanup: lru }
forges:
  gitlab: { host: gitlab.com, token_env: MAESTRO_GITLAB_TOKEN }
repos:
  - url: gitlab.com/group/api
`;

let dir: string;
const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('loads and validates a YAML config file', () => {
    dir = mkdtempSync(join(tmpdir(), 'maestro-cfg-'));
    const p = join(dir, 'maestro.config.yaml');
    writeFileSync(p, VALID);
    const cfg = loadConfig(p);
    expect(cfg.defaults.botUser).toBe('maestro-bot');
    expect(cfg.repos[0]!.url).toBe('gitlab.com/group/api');
  });

  it('throws on invalid YAML config', () => {
    dir = mkdtempSync(join(tmpdir(), 'maestro-cfg-'));
    const p = join(dir, 'bad.yaml');
    writeFileSync(p, 'defaults: {}\nforges: {}\nrepos: []\n');
    expect(() => loadConfig(p)).toThrow();
  });
});

describe('watchConfig', () => {
  it('invokes the callback on a valid change and ignores invalid ones', async () => {
    dir = mkdtempSync(join(tmpdir(), 'maestro-cfg-'));
    const p = join(dir, 'maestro.config.yaml');
    writeFileSync(p, VALID);
    const seen: string[] = [];
    const stop = watchConfig(p, (cfg) => seen.push(cfg.defaults.botUser));
    cleanups.push(stop);

    // invalid write — should NOT trigger callback
    writeFileSync(p, 'garbage: true\n');
    await new Promise((r) => setTimeout(r, 50));

    // valid write — should trigger callback
    writeFileSync(p, VALID.replace('maestro-bot', 'maestro-bot-2'));
    await new Promise((r) => setTimeout(r, 50));

    expect(seen).toContain('maestro-bot-2');
    expect(seen).not.toContain('garbage');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/config/load.test.ts`
Expected: FAIL — `Failed to resolve import "./load.js"`.

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/config/load.ts`:

```ts
import { readFileSync, watch } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { MaestroConfigSchema, type MaestroConfig } from './schema.js';

export function loadConfig(path: string): MaestroConfig {
  const raw = readFileSync(path, 'utf8');
  const data = parseYaml(raw);
  return MaestroConfigSchema.parse(data) as MaestroConfig;
}

// Watch a config file; call cb only when a change yields a valid config
// (validate-before-reload). Returns an unsubscribe function.
export function watchConfig(path: string, cb: (config: MaestroConfig) => void): () => void {
  const watcher = watch(path, () => {
    try {
      cb(loadConfig(path));
    } catch {
      // invalid config on disk: keep the last good one, do not call cb.
    }
  });
  return () => watcher.close();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/config/load.test.ts`
Expected: PASS — `3 passed`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config/load.ts packages/core/src/config/load.test.ts
git commit -m "feat(core): add config loader with validated hot-reload"
```

---

## Task 7: WORKFLOW.md zod schema

**Files:**
- Create: `packages/core/src/workflow/schema.ts`

> Type-only file plus a zod schema; validated by Task 8's loader tests. The front matter YAML uses snake_case (`manage_board`, `require_label`, `allowed_actors`, `changes_signal`, `changes_label`, `default_branch`, `merge_strategy`, `delete_source_branch`, `base_url`, `start_command`, `seed_command`, `health_check`, `max_turns`, `permission_mode`, `max_active`); zod maps to the camelCase `WorkflowConfig`. `forge` may be omitted in the file and is supplied by the loader (Task 8) from the repo host (`forgeHint`), so the schema treats it as optional and the loader fills it. The `review` block is optional and defaults to `{ changesSignal: 'label' }` (the contract default). The exported schema is named `WorkflowConfigSchema`.

- [ ] **Step 1: Write the schema**

`packages/core/src/workflow/schema.ts`:

```ts
import { z } from 'zod';
import type { Forge, MergeStrategy } from '../domain/types.js';
import type { ConcurrencyCfg } from '../config/schema.js';

export type ProofType = 'playwright' | 'test-output' | 'diff-summary' | 'none';
export type PermissionMode = 'acceptEdits' | 'plan' | 'default' | 'bypassPermissions';

export interface TriggerCfg {
  assignee: 'bot';
  requireLabel: string | null;
  allowedActors: string[]; // empty => any actor with perms
}

export interface WorkflowConfig {
  forge: Forge; // inferred from host if omitted in file
  project: string;
  botUser: string;
  manageBoard: boolean;
  trigger: TriggerCfg;
  proof: { type: ProofType; command?: string };
  review: {
    changesSignal: 'native' | 'label'; // default: 'label'
    changesLabel?: string; // used when changesSignal === 'label'
  };
  git: {
    defaultBranch: string;
    target: string;
    mergeStrategy: MergeStrategy;
    deleteSourceBranch: boolean;
  };
  environment?: {
    baseUrl?: string;
    startCommand?: string;
    seedCommand?: string;
    healthCheck?: string;
  };
  claude: { command: string; maxTurns: number; permissionMode: PermissionMode };
  concurrency: ConcurrencyCfg;
  promptBody: string; // the markdown body after front matter
}

const concurrencySchema = z
  .object({
    global_max: z.number().int().positive().optional(),
    max_active: z.number().int().positive().optional(),
  })
  .transform((c) => ({ globalMax: c.global_max, maxActive: c.max_active }));

// Front-matter schema (snake_case). `forge` optional; loader fills it from host.
export const WorkflowConfigSchema = z.object({
  forge: z.enum(['gitlab', 'github']).optional(),
  project: z.string(),
  bot_user: z.string(),
  manage_board: z.boolean(),
  trigger: z.object({
    assignee: z.literal('bot'),
    require_label: z.string().nullable(),
    allowed_actors: z.array(z.string()),
  }),
  proof: z.object({
    type: z.enum(['playwright', 'test-output', 'diff-summary', 'none']),
    command: z.string().optional(),
  }),
  // Optional in the file; defaults to changesSignal:'label' (the contract default).
  review: z
    .object({
      changes_signal: z.enum(['native', 'label']).default('label'),
      changes_label: z.string().optional(),
    })
    .default({ changes_signal: 'label' }),
  git: z.object({
    default_branch: z.string(),
    target: z.string(),
    merge_strategy: z.enum(['squash', 'merge', 'rebase']),
    delete_source_branch: z.boolean(),
  }),
  environment: z
    .object({
      base_url: z.string().optional(),
      start_command: z.string().optional(),
      seed_command: z.string().optional(),
      health_check: z.string().optional(),
    })
    .optional(),
  claude: z.object({
    command: z.string(),
    max_turns: z.number().int().positive(),
    permission_mode: z.enum(['acceptEdits', 'plan', 'default', 'bypassPermissions']),
  }),
  concurrency: concurrencySchema,
});

export type WorkflowFrontMatter = z.infer<typeof WorkflowConfigSchema>;

// Map validated front matter + prompt body + resolved forge into WorkflowConfig.
export function toWorkflowConfig(
  fm: WorkflowFrontMatter,
  promptBody: string,
  forge: Forge,
): WorkflowConfig {
  return {
    forge,
    project: fm.project,
    botUser: fm.bot_user,
    manageBoard: fm.manage_board,
    trigger: {
      assignee: fm.trigger.assignee,
      requireLabel: fm.trigger.require_label,
      allowedActors: fm.trigger.allowed_actors,
    },
    proof: { type: fm.proof.type, command: fm.proof.command },
    review: {
      changesSignal: fm.review.changes_signal,
      changesLabel: fm.review.changes_label,
    },
    git: {
      defaultBranch: fm.git.default_branch,
      target: fm.git.target,
      mergeStrategy: fm.git.merge_strategy as MergeStrategy,
      deleteSourceBranch: fm.git.delete_source_branch,
    },
    environment: fm.environment
      ? {
          baseUrl: fm.environment.base_url,
          startCommand: fm.environment.start_command,
          seedCommand: fm.environment.seed_command,
          healthCheck: fm.environment.health_check,
        }
      : undefined,
    claude: {
      command: fm.claude.command,
      maxTurns: fm.claude.max_turns,
      permissionMode: fm.claude.permission_mode,
    },
    concurrency: fm.concurrency,
    promptBody,
  };
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc -p packages/core/tsconfig.json --noEmit`
Expected: exits 0, no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/workflow/schema.ts
git commit -m "feat(core): add WorkflowConfig zod schema"
```

---

## Task 8: WORKFLOW.md loader (parseWorkflow + loadWorkflow)

**Files:**
- Create: `packages/core/src/workflow/load.ts`
- Test: `packages/core/src/workflow/load.test.ts`

> `parseWorkflow(raw, forgeHint?)` uses `gray-matter` to split front matter from the markdown body, validates the front matter, resolves `forge` (front-matter value wins; else `forgeHint`; else `'gitlab'`), and returns a `WorkflowConfig`. `loadWorkflow(repoDir, forgeHint?)` reads `<repoDir>/WORKFLOW.md`; returns `null` if absent. The caller (M5 `maestro add` / M7 onboarding) derives `forgeHint` from the repo's configured host.

- [ ] **Step 1: Write the failing test**

`packages/core/src/workflow/load.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkflow, loadWorkflow } from './load.js';

const RAW = `---
forge: github
project: org/web
bot_user: maestro-bot
manage_board: true
trigger:
  assignee: bot
  require_label: null
  allowed_actors: []
proof:
  type: playwright
  command: "npx playwright test --reporter=line"
git:
  default_branch: main
  target: main
  merge_strategy: squash
  delete_source_branch: true
claude:
  command: claude
  max_turns: 40
  permission_mode: acceptEdits
concurrency: { max_active: 2 }
---
# Operating protocol

Work the issue. Atomic commits.
`;

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('parseWorkflow', () => {
  it('parses front matter and prompt body into WorkflowConfig', () => {
    const wf = parseWorkflow(RAW);
    expect(wf.forge).toBe('github');
    expect(wf.project).toBe('org/web');
    expect(wf.manageBoard).toBe(true);
    expect(wf.trigger.requireLabel).toBeNull();
    expect(wf.proof.type).toBe('playwright');
    expect(wf.git.mergeStrategy).toBe('squash');
    expect(wf.claude.maxTurns).toBe(40);
    expect(wf.concurrency.maxActive).toBe(2);
    expect(wf.promptBody).toContain('Operating protocol');
  });

  it('defaults review.changesSignal to label when omitted', () => {
    const wf = parseWorkflow(RAW);
    expect(wf.review.changesSignal).toBe('label');
  });

  it('honors an explicit review.changes_signal', () => {
    const wf = parseWorkflow(RAW.replace('concurrency: { max_active: 2 }', 'review: { changes_signal: native }\nconcurrency: { max_active: 2 }'));
    expect(wf.review.changesSignal).toBe('native');
  });

  it('defaults forge to gitlab when front matter omits it', () => {
    const wf = parseWorkflow(RAW.replace('forge: github\n', ''));
    expect(wf.forge).toBe('gitlab');
  });

  it('uses forgeHint when front matter omits forge', () => {
    const wf = parseWorkflow(RAW.replace('forge: github\n', ''), 'github');
    expect(wf.forge).toBe('github');
  });

  it('throws on invalid front matter', () => {
    expect(() => parseWorkflow('---\nproject: x\n---\nbody')).toThrow();
  });
});

describe('loadWorkflow', () => {
  it('returns null when WORKFLOW.md is absent', () => {
    dir = mkdtempSync(join(tmpdir(), 'maestro-wf-'));
    expect(loadWorkflow(dir)).toBeNull();
  });

  it('loads WORKFLOW.md from a repo dir', () => {
    dir = mkdtempSync(join(tmpdir(), 'maestro-wf-'));
    writeFileSync(join(dir, 'WORKFLOW.md'), RAW);
    const wf = loadWorkflow(dir);
    expect(wf?.project).toBe('org/web');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/workflow/load.test.ts`
Expected: FAIL — `Failed to resolve import "./load.js"`.

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/workflow/load.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import type { Forge } from '../domain/types.js';
import {
  WorkflowConfigSchema,
  toWorkflowConfig,
  type WorkflowConfig,
} from './schema.js';

// front-matter `forge` wins; else forgeHint; else default 'gitlab'.
export function parseWorkflow(raw: string, forgeHint?: Forge): WorkflowConfig {
  const parsed = matter(raw);
  const fm = WorkflowConfigSchema.parse(parsed.data);
  const forge: Forge = fm.forge ?? forgeHint ?? 'gitlab';
  return toWorkflowConfig(fm, parsed.content.trim(), forge);
}

// forgeHint is derived from the repo's configured host by the caller (M5/M7).
export function loadWorkflow(repoDir: string, forgeHint?: Forge): WorkflowConfig | null {
  const path = join(repoDir, 'WORKFLOW.md');
  if (!existsSync(path)) return null;
  return parseWorkflow(readFileSync(path, 'utf8'), forgeHint);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/workflow/load.test.ts`
Expected: PASS — `7 passed`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/workflow/load.ts packages/core/src/workflow/load.test.ts
git commit -m "feat(core): add WORKFLOW.md loader"
```

---

## Task 9: ForgeAdapter interface + ForgeError

**Files:**
- Create: `packages/core/src/forge/adapter.ts`

> Type/interface-only file plus the `ForgeError` class. Exercised by Task 10's MemoryForge tests. Verify by compile.

- [ ] **Step 1: Write the interface**

`packages/core/src/forge/adapter.ts`:

```ts
import type {
  Forge,
  Issue,
  MergeRequest,
  LifecycleState,
  MergeStrategy,
} from '../domain/types.js';

export class ForgeError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ForgeError';
  }
}

export interface CreateMrArgs {
  sourceBranch: string;
  targetBranch: string;
  title: string;
  body: string; // includes "Closes #N"
  draft: boolean;
}

export type CommentTarget =
  | { type: 'issue'; number: number }
  | { type: 'mr'; number: number };

export interface ForgeAdapter {
  readonly forge: Forge;
  readonly project: string; // gitlab path or github org/repo
  readonly botUser: string;

  // --- reads ---
  listAssignedOpenIssues(): Promise<Issue[]>; // assigned to botUser, state open
  getIssue(issueNumber: number): Promise<Issue | null>;
  listOpenMrsByBot(): Promise<MergeRequest[]>;
  getMrForIssue(issueNumber: number): Promise<MergeRequest | null>;

  // --- writes ---
  createBranch(name: string, fromRef: string): Promise<void>;
  createDraftMr(args: CreateMrArgs): Promise<MergeRequest>;
  setMrReady(mrNumber: number): Promise<void>; // un-draft
  updateMrDescription(mrNumber: number, body: string): Promise<void>;
  assignReviewer(mrNumber: number, username: string): Promise<void>;
  mergeMr(mrNumber: number, strategy: MergeStrategy, deleteSource: boolean): Promise<void>;
  comment(target: CommentTarget, body: string): Promise<void>;

  // Set exactly one lifecycle label (or none for 'new'/'done'), removing the rest.
  setLifecycleLabel(issueNumber: number, state: LifecycleState): Promise<void>;

  // --- setup (idempotent) ---
  ensureLabels(): Promise<void>; // create maestro labels if absent
  ensureBoard(): Promise<void>; // GitLab: board + lists. GitHub: no-op.
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc -p packages/core/tsconfig.json --noEmit`
Expected: exits 0, no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/forge/adapter.ts
git commit -m "feat(core): add ForgeAdapter interface and ForgeError"
```

---

## Task 10: MemoryForge — in-memory ForgeAdapter

**Files:**
- Create: `packages/core/src/forge/memory.ts`
- Test: `packages/core/src/forge/memory.test.ts`

> A fully in-memory `ForgeAdapter`. Seeds are issues; branches/MRs/comments/labels live in maps. `setLifecycleLabel` strips all maestro labels then adds the one for the target state (none for `new`/`done`) — enforcing mutual exclusion in-process. `createDraftMr` parses `Closes #N` out of the body to populate `linkedIssueNumbers` and seeds `description` from the body; `updateMrDescription` overwrites it. `getMrForIssue` matches on parsed `Closes #N` linkage (real adapters locate by head branch `maestro/issue-<number>`). Test helpers (`approveMr`, `requestChanges`, `closeIssue`) let tests drive review outcomes. The constructor takes `{ forge, project, botUser }`.

- [ ] **Step 1: Write the failing test**

`packages/core/src/forge/memory.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryForge } from './memory.js';
import { lifecycleLabel } from '../domain/lifecycle.js';
import type { Issue } from '../domain/types.js';

function seedIssue(over: Partial<Issue> = {}): Issue {
  return {
    id: 'i1',
    number: 1,
    title: 'Fix the thing',
    body: 'please',
    state: 'open',
    assignees: ['maestro-bot'],
    authorUsername: 'alice',
    labels: [],
    createdAt: '2026-06-03T00:00:00Z',
    webUrl: 'https://example/issues/1',
    ...over,
  };
}

let forge: MemoryForge;
beforeEach(() => {
  forge = new MemoryForge({ forge: 'gitlab', project: 'group/api', botUser: 'maestro-bot' });
});

describe('MemoryForge reads', () => {
  it('lists open issues assigned to the bot', async () => {
    forge.seedIssue(seedIssue());
    forge.seedIssue(seedIssue({ id: 'i2', number: 2, assignees: ['someone'] }));
    forge.seedIssue(seedIssue({ id: 'i3', number: 3, state: 'closed' }));
    const issues = await forge.listAssignedOpenIssues();
    expect(issues.map((i) => i.number)).toEqual([1]);
  });

  it('getIssue returns null for unknown number', async () => {
    expect(await forge.getIssue(99)).toBeNull();
  });
});

describe('MemoryForge MR lifecycle', () => {
  beforeEach(() => forge.seedIssue(seedIssue()));

  it('creates a draft MR with linked issue parsed from Closes #N', async () => {
    await forge.createBranch('maestro/issue-1', 'main');
    const mr = await forge.createDraftMr({
      sourceBranch: 'maestro/issue-1',
      targetBranch: 'main',
      title: 'Fix the thing',
      body: 'Closes #1',
      draft: true,
    });
    expect(mr.isDraft).toBe(true);
    expect(mr.linkedIssueNumbers).toEqual([1]);
    expect((await forge.getMrForIssue(1))?.number).toBe(mr.number);
  });

  it('setMrReady un-drafts the MR', async () => {
    const mr = await forge.createDraftMr({
      sourceBranch: 'maestro/issue-1',
      targetBranch: 'main',
      title: 't',
      body: 'Closes #1',
      draft: true,
    });
    await forge.setMrReady(mr.number);
    expect((await forge.getMrForIssue(1))?.isDraft).toBe(false);
  });

  it('mergeMr marks the MR merged', async () => {
    const mr = await forge.createDraftMr({
      sourceBranch: 'maestro/issue-1',
      targetBranch: 'main',
      title: 't',
      body: 'Closes #1',
      draft: true,
    });
    await forge.mergeMr(mr.number, 'squash', true);
    expect((await forge.getMrForIssue(1))?.state).toBe('merged');
  });

  it('listOpenMrsByBot excludes merged MRs', async () => {
    const mr = await forge.createDraftMr({
      sourceBranch: 'maestro/issue-1',
      targetBranch: 'main',
      title: 't',
      body: 'Closes #1',
      draft: true,
    });
    expect((await forge.listOpenMrsByBot()).length).toBe(1);
    await forge.mergeMr(mr.number, 'squash', true);
    expect((await forge.listOpenMrsByBot()).length).toBe(0);
  });
});

describe('MemoryForge labels (mutual exclusion)', () => {
  beforeEach(() => forge.seedIssue(seedIssue()));

  it('setLifecycleLabel keeps exactly one maestro label', async () => {
    await forge.setLifecycleLabel(1, 'in_progress');
    expect((await forge.getIssue(1))!.labels).toContain(lifecycleLabel('gitlab', 'in_progress'));
    await forge.setLifecycleLabel(1, 'in_review');
    const labels = (await forge.getIssue(1))!.labels;
    expect(labels).toContain(lifecycleLabel('gitlab', 'in_review'));
    expect(labels).not.toContain(lifecycleLabel('gitlab', 'in_progress'));
  });

  it('setLifecycleLabel to new/done strips all maestro labels', async () => {
    await forge.setLifecycleLabel(1, 'in_progress');
    await forge.setLifecycleLabel(1, 'done');
    const labels = (await forge.getIssue(1))!.labels;
    expect(labels.some((l) => l.startsWith('maestro::'))).toBe(false);
  });
});

describe('MemoryForge comments and test helpers', () => {
  beforeEach(() => forge.seedIssue(seedIssue()));

  it('records comments per target', async () => {
    await forge.comment({ type: 'issue', number: 1 }, 'started working');
    expect(forge.commentsFor({ type: 'issue', number: 1 })).toEqual(['started working']);
  });

  it('approveMr / requestChanges flip review flags', async () => {
    const mr = await forge.createDraftMr({
      sourceBranch: 'maestro/issue-1',
      targetBranch: 'main',
      title: 't',
      body: 'Closes #1',
      draft: true,
    });
    forge.approveMr(mr.number);
    expect((await forge.getMrForIssue(1))?.approved).toBe(true);
    forge.requestChanges(mr.number);
    const after = await forge.getMrForIssue(1);
    expect(after?.approved).toBe(false);
    expect(after?.changesRequested).toBe(true);
  });

  it('assignReviewer adds the reviewer', async () => {
    const mr = await forge.createDraftMr({
      sourceBranch: 'maestro/issue-1',
      targetBranch: 'main',
      title: 't',
      body: 'Closes #1',
      draft: true,
    });
    await forge.assignReviewer(mr.number, 'alice');
    expect((await forge.getMrForIssue(1))?.reviewers).toContain('alice');
  });

  it('closeIssue sets state closed', async () => {
    forge.closeIssue(1);
    expect((await forge.getIssue(1))!.state).toBe('closed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/forge/memory.test.ts`
Expected: FAIL — `Failed to resolve import "./memory.js"`.

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/forge/memory.ts`:

```ts
import type {
  Forge,
  Issue,
  MergeRequest,
  LifecycleState,
  MergeStrategy,
} from '../domain/types.js';
import {
  allMaestroLabels,
  isLabeledState,
  lifecycleLabel,
} from '../domain/lifecycle.js';
import type { CommentTarget, CreateMrArgs, ForgeAdapter } from './adapter.js';

interface MemoryForgeInit {
  forge: Forge;
  project: string;
  botUser: string;
}

function commentKey(t: CommentTarget): string {
  return `${t.type}#${t.number}`;
}

function parseLinkedIssues(body: string): number[] {
  const out: number[] = [];
  const re = /closes\s+#(\d+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) out.push(Number(m[1]));
  return out;
}

export class MemoryForge implements ForgeAdapter {
  readonly forge: Forge;
  readonly project: string;
  readonly botUser: string;

  private issues = new Map<number, Issue>();
  private mrs = new Map<number, MergeRequest>();
  private branches = new Set<string>();
  private comments = new Map<string, string[]>();
  private nextMrNumber = 1;

  constructor(init: MemoryForgeInit) {
    this.forge = init.forge;
    this.project = init.project;
    this.botUser = init.botUser;
  }

  // --- test/dev seed + driver helpers ---
  seedIssue(issue: Issue): void {
    this.issues.set(issue.number, { ...issue, labels: [...issue.labels] });
  }
  closeIssue(issueNumber: number): void {
    const i = this.issues.get(issueNumber);
    if (i) i.state = 'closed';
  }
  approveMr(mrNumber: number): void {
    const mr = this.mrs.get(mrNumber);
    if (mr) {
      mr.approved = true;
      mr.changesRequested = false;
    }
  }
  requestChanges(mrNumber: number): void {
    const mr = this.mrs.get(mrNumber);
    if (mr) {
      mr.approved = false;
      mr.changesRequested = true;
    }
  }
  commentsFor(target: CommentTarget): string[] {
    return this.comments.get(commentKey(target)) ?? [];
  }
  hasBranch(name: string): boolean {
    return this.branches.has(name);
  }

  // --- reads ---
  async listAssignedOpenIssues(): Promise<Issue[]> {
    return [...this.issues.values()].filter(
      (i) => i.state === 'open' && i.assignees.includes(this.botUser),
    );
  }
  async getIssue(issueNumber: number): Promise<Issue | null> {
    return this.issues.get(issueNumber) ?? null;
  }
  async listOpenMrsByBot(): Promise<MergeRequest[]> {
    return [...this.mrs.values()].filter((m) => m.state === 'open');
  }
  async getMrForIssue(issueNumber: number): Promise<MergeRequest | null> {
    // Real adapters (M2/M6) locate the MR by its head branch `maestro/issue-<number>`.
    // The in-memory fake matches on parsed `Closes #N` linkage instead.
    for (const mr of this.mrs.values()) {
      if (mr.linkedIssueNumbers.includes(issueNumber)) return mr;
    }
    return null;
  }

  // --- writes ---
  async createBranch(name: string, _fromRef: string): Promise<void> {
    this.branches.add(name);
  }
  async createDraftMr(args: CreateMrArgs): Promise<MergeRequest> {
    const number = this.nextMrNumber++;
    const mr: MergeRequest = {
      id: `mr-${number}`,
      number,
      sourceBranch: args.sourceBranch,
      targetBranch: args.targetBranch,
      isDraft: args.draft,
      state: 'open',
      approved: false,
      changesRequested: false,
      reviewers: [],
      linkedIssueNumbers: parseLinkedIssues(args.body),
      description: args.body,
      webUrl: `https://memory/${this.project}/mr/${number}`,
    };
    this.mrs.set(number, mr);
    return mr;
  }
  async setMrReady(mrNumber: number): Promise<void> {
    const mr = this.mrs.get(mrNumber);
    if (mr) mr.isDraft = false;
  }
  async updateMrDescription(mrNumber: number, body: string): Promise<void> {
    const mr = this.mrs.get(mrNumber);
    if (mr) mr.description = body;
  }
  async assignReviewer(mrNumber: number, username: string): Promise<void> {
    const mr = this.mrs.get(mrNumber);
    if (mr && !mr.reviewers.includes(username)) mr.reviewers.push(username);
  }
  async mergeMr(mrNumber: number, _strategy: MergeStrategy, _deleteSource: boolean): Promise<void> {
    const mr = this.mrs.get(mrNumber);
    if (mr) mr.state = 'merged';
  }
  async comment(target: CommentTarget, body: string): Promise<void> {
    const key = commentKey(target);
    const list = this.comments.get(key) ?? [];
    list.push(body);
    this.comments.set(key, list);
  }
  async setLifecycleLabel(issueNumber: number, state: LifecycleState): Promise<void> {
    const issue = this.issues.get(issueNumber);
    if (!issue) return;
    const maestro = allMaestroLabels(this.forge);
    issue.labels = issue.labels.filter((l) => !maestro.includes(l));
    if (isLabeledState(state)) issue.labels.push(lifecycleLabel(this.forge, state));
  }

  // --- setup (idempotent) ---
  async ensureLabels(): Promise<void> {
    // in-memory: labels are virtual, nothing to create
  }
  async ensureBoard(): Promise<void> {
    // in-memory: no board
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/forge/memory.test.ts`
Expected: PASS — all groups green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/forge/memory.ts packages/core/src/forge/memory.test.ts
git commit -m "feat(core): add in-memory MemoryForge adapter"
```

---

## Task 11: deriveLifecycle (pure)

**Files:**
- Create: `packages/core/src/reconciler/derive.ts`
- Test: `packages/core/src/reconciler/derive.test.ts`

> PURE: no I/O, imports only domain types + `labeledStateOf`. Rules per contract: closed → done; blocked label → blocked; in_review label → in_review; in_progress label → in_progress; else → new.

- [ ] **Step 1: Write the failing test**

`packages/core/src/reconciler/derive.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { deriveLifecycle } from './derive.js';
import { lifecycleLabel } from '../domain/lifecycle.js';
import type { Issue } from '../domain/types.js';

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: 'i1',
    number: 1,
    title: 't',
    body: '',
    state: 'open',
    assignees: ['maestro-bot'],
    authorUsername: 'alice',
    labels: [],
    createdAt: '2026-06-03T00:00:00Z',
    webUrl: 'u',
    ...over,
  };
}

describe('deriveLifecycle', () => {
  it('closed issue -> done', () => {
    expect(deriveLifecycle('gitlab', issue({ state: 'closed' }), null)).toBe('done');
  });

  it('blocked label -> blocked', () => {
    const i = issue({ labels: [lifecycleLabel('gitlab', 'blocked')] });
    expect(deriveLifecycle('gitlab', i, null)).toBe('blocked');
  });

  it('in_review label -> in_review', () => {
    const i = issue({ labels: [lifecycleLabel('gitlab', 'in_review')] });
    expect(deriveLifecycle('gitlab', i, null)).toBe('in_review');
  });

  it('in_progress label -> in_progress', () => {
    const i = issue({ labels: [lifecycleLabel('gitlab', 'in_progress')] });
    expect(deriveLifecycle('gitlab', i, null)).toBe('in_progress');
  });

  it('assigned, no maestro label -> new', () => {
    expect(deriveLifecycle('gitlab', issue(), null)).toBe('new');
  });

  it('closed wins over any label', () => {
    const i = issue({ state: 'closed', labels: [lifecycleLabel('gitlab', 'in_progress')] });
    expect(deriveLifecycle('gitlab', i, null)).toBe('done');
  });

  it('works for github flat labels', () => {
    const i = issue({ labels: [lifecycleLabel('github', 'in_review')] });
    expect(deriveLifecycle('github', i, null)).toBe('in_review');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/reconciler/derive.test.ts`
Expected: FAIL — `Failed to resolve import "./derive.js"`.

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/reconciler/derive.ts`:

```ts
import type { Forge, Issue, MergeRequest, LifecycleState } from '../domain/types.js';
import { labeledStateOf } from '../domain/lifecycle.js';

// PURE: no I/O. Derives the lifecycle state from a forge-agnostic snapshot.
export function deriveLifecycle(
  forge: Forge,
  issue: Issue,
  _mr: MergeRequest | null,
): LifecycleState {
  if (issue.state === 'closed') return 'done';
  const labeled = labeledStateOf(forge, issue.labels);
  if (labeled === 'blocked') return 'blocked';
  if (labeled === 'in_review') return 'in_review';
  if (labeled === 'in_progress') return 'in_progress';
  return 'new';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/reconciler/derive.test.ts`
Expected: PASS — `7 passed`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/reconciler/derive.ts packages/core/src/reconciler/derive.test.ts
git commit -m "feat(core): add pure deriveLifecycle"
```

---

## Task 12: decideAction (pure) — full mapping table

**Files:**
- Create: `packages/core/src/reconciler/decide.ts`
- Test: `packages/core/src/reconciler/decide.test.ts`

> PURE: no I/O, imports only domain types. Exhaustive coverage of the contract mapping. `decideAction` maps the forge-derived lifecycle → action ONLY; agent status (`done`/`needs_input`) is NOT a decide input — it is consumed in the SAME tick by the `work` executor (see Task 13). Order in `in_review`: approved→merge; else changesRequested→work; else review_check. `in_progress` → `work` ALWAYS (the work executor handles `done`/`needs_input` inline).

- [ ] **Step 1: Write the failing test**

`packages/core/src/reconciler/decide.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { decideAction } from './decide.js';
import type { DecideContext } from './decide.js';
import type { Issue, IssueSnapshot, MergeRequest, LifecycleState } from '../domain/types.js';

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: 'i1',
    number: 7,
    title: 't',
    body: '',
    state: 'open',
    assignees: ['maestro-bot'],
    authorUsername: 'alice',
    labels: [],
    createdAt: '2026-06-03T00:00:00Z',
    webUrl: 'u',
    ...over,
  };
}

function mr(over: Partial<MergeRequest> = {}): MergeRequest {
  return {
    id: 'mr1',
    number: 3,
    sourceBranch: 'maestro/issue-7',
    targetBranch: 'main',
    isDraft: false,
    state: 'open',
    approved: false,
    changesRequested: false,
    reviewers: [],
    linkedIssueNumbers: [7],
    description: 'Closes #7',
    webUrl: 'u',
    ...over,
  };
}

function snap(lifecycle: LifecycleState, mrv: MergeRequest | null = null): IssueSnapshot {
  return { issue: issue(), mr: mrv, lifecycle };
}

const baseCtx: DecideContext = { triggerOk: true };

describe('decideAction', () => {
  it('new && triggerOk -> claim', () => {
    expect(decideAction(snap('new'), baseCtx)).toEqual({ kind: 'claim', issueNumber: 7 });
  });

  it('new && !triggerOk -> noop', () => {
    expect(decideAction(snap('new'), { triggerOk: false })).toEqual({
      kind: 'noop',
      issueNumber: 7,
    });
  });

  it('in_progress -> work (always; work executor handles done/needs_input inline)', () => {
    expect(decideAction(snap('in_progress'), baseCtx)).toEqual({ kind: 'work', issueNumber: 7 });
  });

  it('in_review && approved -> merge', () => {
    expect(decideAction(snap('in_review', mr({ approved: true })), baseCtx)).toEqual({
      kind: 'merge',
      issueNumber: 7,
    });
  });

  it('in_review && changesRequested -> work', () => {
    expect(decideAction(snap('in_review', mr({ changesRequested: true })), baseCtx)).toEqual({
      kind: 'work',
      issueNumber: 7,
    });
  });

  it('in_review (pending) -> review_check', () => {
    expect(decideAction(snap('in_review', mr()), baseCtx)).toEqual({
      kind: 'review_check',
      issueNumber: 7,
    });
  });

  it('in_review with no MR -> review_check', () => {
    expect(decideAction(snap('in_review', null), baseCtx)).toEqual({
      kind: 'review_check',
      issueNumber: 7,
    });
  });

  it('blocked -> noop', () => {
    expect(decideAction(snap('blocked'), baseCtx)).toEqual({ kind: 'noop', issueNumber: 7 });
  });

  it('done -> cleanup', () => {
    expect(decideAction(snap('done'), baseCtx)).toEqual({ kind: 'cleanup', issueNumber: 7 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/reconciler/decide.test.ts`
Expected: FAIL — `Failed to resolve import "./decide.js"`.

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/reconciler/decide.ts`:

```ts
import type { Action, IssueSnapshot } from '../domain/types.js';

export interface DecideContext {
  triggerOk: boolean; // trigger guard (assignee/require_label/allowed_actors) satisfied
}
// NOTE: agent status (done/needs_input) is NOT a decide input. It is consumed in
// the SAME tick by the `work` executor (see reconciler/index.ts). decideAction maps
// only the forge-derived lifecycle → action.

// PURE. Maps a snapshot + context to exactly one Action. No I/O.
export function decideAction(snapshot: IssueSnapshot, ctx: DecideContext): Action {
  const n = snapshot.issue.number;
  switch (snapshot.lifecycle) {
    case 'new':
      return ctx.triggerOk ? { kind: 'claim', issueNumber: n } : { kind: 'noop', issueNumber: n };
    case 'in_progress':
      // ALWAYS work; the work executor runs handoff (done) or block (needs_input) inline.
      return { kind: 'work', issueNumber: n };
    case 'in_review':
      if (snapshot.mr?.approved) return { kind: 'merge', issueNumber: n };
      if (snapshot.mr?.changesRequested) return { kind: 'work', issueNumber: n };
      return { kind: 'review_check', issueNumber: n };
    case 'blocked':
      return { kind: 'noop', issueNumber: n };
    case 'done':
      return { kind: 'cleanup', issueNumber: n };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/reconciler/decide.test.ts`
Expected: PASS — `9 passed`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/reconciler/decide.ts packages/core/src/reconciler/decide.test.ts
git commit -m "feat(core): add pure decideAction state machine"
```

---

## Task 13: reconcileRepo — derive + decide + execute against the adapter

**Files:**
- Create: `packages/core/src/reconciler/index.ts`
- Test: `packages/core/src/reconciler/index.test.ts`

> `reconcileRepo(deps)` fetches assigned open issues, builds a snapshot per issue (`getMrForIssue` + `deriveLifecycle`), computes one `Action` via `decideAction`, then executes it via an internal `executeAction(action, snapshot, deps)`. It returns `Promise<void>` — no `Action[]` and no cross-tick agent memory. Collaborators (`ClaudeRunner`, `runProof`, `WorkspaceManager`, `CommandRunner`, `SlotManager`) are injected via a single `ReconcileDeps` bag; M1 supplies FAKES in tests.
>
> Per the contract, `ReconcileDeps` is the ONE deps bag in `reconciler/index.ts` — there are NO per-executor deps bags. Collaborator types are **imported from their owning modules** (`ForgeAdapter` from `forge/adapter.ts`, `WorkflowConfig` from `workflow/schema.ts`, `AgentResult` from `agent/contract.ts`), never re-declared structurally. The M3/M4-owned collaborators (`ClaudeRunner`, `runProof`, `WorkspaceManager`, `CommandRunner` from `util/exec.ts`, `SlotManager`) are typed via `import type` against their contract modules; M1 still supplies fakes in tests. The `exec` seam carries git commit/push for the handoff routine (exercised by M4). The contract field name for the adapter is `adapter` (not `forge`).
>
> Agent status is consumed in the **SAME tick** (no `agentResults` map across ticks): the `work` executor runs the agent, inspects the returned `AgentResult`, and acts immediately — `done` → run the handoff routine inline; `needs_input` → block inline; `in_progress` → leave label `in_progress`.
>
> Per-action behavior:
> - **claim:** `createBranch('maestro/issue-<n>', workflow.git.defaultBranch)` → `createDraftMr({ title: snapshot.issue.title, body:'Closes #<n>', draft:true })` → `setLifecycleLabel(n,'in_progress')` → `comment(issue,'started working')`.
> - **work:** `workspace.ensure(...)` → `runner.run(dir, prompt, opts)`. `needs_input` → `setLifecycleLabel(n,'blocked')` + comment. `done` → run the handoff routine inline (proof → comments → assign reviewer → ready → in_review). `in_progress` → leave label `in_progress`.
> - **handoff routine (inline, on agent `done`):** `runProof(ctx)` → `comment(issue, proofText)` + `comment(mr, proofText)` → `assignReviewer(mr.number, issue.authorUsername)` → `setMrReady(mr.number)` → `setLifecycleLabel(n,'in_review')`.
> - **review_check:** no-op write (polling only).
> - **merge:** `mergeMr(mr.number, workflow.git.mergeStrategy, workflow.git.deleteSourceBranch)`.
> - **changes-requested path:** decide returns `work` for an `in_review` MR with `changesRequested`; the executor first flips the label back to `in_progress` (`setLifecycleLabel`), then runs the work routine.
> - **cleanup:** `workspace.remove(repoUrl, n)`.
> - **block:** `setLifecycleLabel(n,'blocked')` + `comment(issue, reason)`.

- [ ] **Step 1: Write the failing test**

`packages/core/src/reconciler/index.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryForge } from '../forge/memory.js';
import { reconcileRepo, type ReconcileDeps } from './index.js';
import { lifecycleLabel } from '../domain/lifecycle.js';
import type { SlotManager } from '../daemon/state.js';
import type { CommandRunner } from '../util/exec.js';
import type { Issue } from '../domain/types.js';
import type { MaestroConfig } from '../config/schema.js';
import type { WorkflowConfig } from '../workflow/schema.js';
import type { AgentResult } from '../agent/contract.js';

function seedIssue(forge: MemoryForge, over: Partial<Issue> = {}): void {
  forge.seedIssue({
    id: 'i1',
    number: 1,
    title: 'Fix the thing',
    body: 'please',
    state: 'open',
    assignees: ['maestro-bot'],
    authorUsername: 'alice',
    labels: [],
    createdAt: '2026-06-03T00:00:00Z',
    webUrl: 'u',
    ...over,
  });
}

const workflow: WorkflowConfig = {
  forge: 'gitlab',
  project: 'group/api',
  botUser: 'maestro-bot',
  manageBoard: true,
  trigger: { assignee: 'bot', requireLabel: null, allowedActors: [] },
  proof: { type: 'none' },
  review: { changesSignal: 'label' },
  git: { defaultBranch: 'main', target: 'main', mergeStrategy: 'squash', deleteSourceBranch: true },
  claude: { command: 'claude', maxTurns: 40, permissionMode: 'acceptEdits' },
  concurrency: { maxActive: 2 },
  promptBody: 'do the work',
};

const config: MaestroConfig = {
  defaults: {
    pollIntervalActive: '30s',
    pollIntervalIdle: '5m',
    pollJitter: '5s',
    botUser: 'maestro-bot',
    concurrency: { globalMax: 2 },
    workspaces: { root: './workspaces', diskCap: '20GB', cleanup: 'lru' },
  },
  forges: {},
  repos: [],
};

interface Fakes {
  runnerResults: AgentResult[]; // popped FIFO per run() call
  runnerCalls: string[];
  proofCalls: number;
  removed: number[];
}

// Minimal SlotManager fake (real RunState lands in Task 14). M1's reconciler
// does not call slot methods, so a no-op gate suffices here.
const fakeSlots: SlotManager = {
  tryClaimSlot: () => true,
  releaseSlot: () => {},
  isActive: () => false,
  activeCount: () => 0,
};

// Minimal CommandRunner fake (git ops are exercised by M4's handoff impl, not M1).
const fakeExec: CommandRunner = {
  async run() {
    return { stdout: '', stderr: '', exitCode: 0 };
  },
};

function makeDeps(forge: MemoryForge, fakes: Fakes): ReconcileDeps {
  return {
    adapter: forge,
    workflow,
    config,
    repoUrl: 'gitlab.com/group/api',
    runner: {
      async run(cwd, prompt, _opts) {
        fakes.runnerCalls.push(`${cwd}:${prompt.slice(0, 10)}`);
        return fakes.runnerResults.shift() ?? { status: 'in_progress', summary: '...' };
      },
    },
    runProof: async () => {
      fakes.proofCalls++;
      return [{ path: 'proof/p.txt', kind: 'text', caption: 'proof' }];
    },
    workspace: {
      async ensure(_repoUrl, issueNumber, branch) {
        return `/ws/${issueNumber}/${branch}`;
      },
      async remove(_repoUrl, issueNumber) {
        fakes.removed.push(issueNumber);
      },
      async enforceDiskCap() {},
      pathFor(_repoUrl, issueNumber) {
        return `/ws/${issueNumber}`;
      },
    },
    exec: fakeExec,
    slots: fakeSlots,
    clock: () => 0,
  };
}

let forge: MemoryForge;
let fakes: Fakes;
beforeEach(() => {
  forge = new MemoryForge({ forge: 'gitlab', project: 'group/api', botUser: 'maestro-bot' });
  fakes = {
    runnerResults: [],
    runnerCalls: [],
    proofCalls: 0,
    removed: [],
  };
});

describe('reconcileRepo — claim (new issue)', () => {
  it('creates branch + draft MR (title = issue.title), labels in_progress, comments started', async () => {
    seedIssue(forge);
    await reconcileRepo(makeDeps(forge, fakes));
    expect(forge.hasBranch('maestro/issue-1')).toBe(true);
    const mr = await forge.getMrForIssue(1);
    expect(mr?.isDraft).toBe(true);
    expect(mr?.linkedIssueNumbers).toEqual([1]);
    expect(mr?.description).toContain('Closes #1');
    expect((await forge.getIssue(1))!.labels).toContain(lifecycleLabel('gitlab', 'in_progress'));
    expect(forge.commentsFor({ type: 'issue', number: 1 })).toContain('started working');
  });
});

describe('reconcileRepo — work (agent status consumed same-tick)', () => {
  it('runs the agent and leaves in_progress on an in_progress result', async () => {
    seedIssue(forge, { labels: [lifecycleLabel('gitlab', 'in_progress')] });
    fakes.runnerResults = [{ status: 'in_progress', summary: 'wip' }];
    await reconcileRepo(makeDeps(forge, fakes));
    expect(fakes.runnerCalls.length).toBe(1);
    expect((await forge.getIssue(1))!.labels).toContain(lifecycleLabel('gitlab', 'in_progress'));
  });

  it('blocks inline when the agent returns needs_input', async () => {
    seedIssue(forge, { labels: [lifecycleLabel('gitlab', 'in_progress')] });
    fakes.runnerResults = [{ status: 'needs_input', summary: 'need a decision' }];
    await reconcileRepo(makeDeps(forge, fakes));
    expect((await forge.getIssue(1))!.labels).toContain(lifecycleLabel('gitlab', 'blocked'));
    expect(forge.commentsFor({ type: 'issue', number: 1 })).toContain('need a decision');
  });

  it('runs the handoff routine inline when the agent returns done', async () => {
    seedIssue(forge, { labels: [lifecycleLabel('gitlab', 'in_progress')] });
    await forge.createDraftMr({
      sourceBranch: 'maestro/issue-1',
      targetBranch: 'main',
      title: 't',
      body: 'Closes #1',
      draft: true,
    });
    fakes.runnerResults = [{ status: 'done', summary: 'finished' }];
    await reconcileRepo(makeDeps(forge, fakes));
    expect(fakes.proofCalls).toBe(1);
    const mr = await forge.getMrForIssue(1);
    expect(mr?.isDraft).toBe(false);
    expect(mr?.reviewers).toContain('alice');
    expect((await forge.getIssue(1))!.labels).toContain(lifecycleLabel('gitlab', 'in_review'));
    expect(forge.commentsFor({ type: 'mr', number: mr!.number }).length).toBeGreaterThan(0);
  });
});

describe('reconcileRepo — review_check / merge', () => {
  it('review_check is a no-op poll when pending', async () => {
    seedIssue(forge, { labels: [lifecycleLabel('gitlab', 'in_review')] });
    await forge.createDraftMr({
      sourceBranch: 'maestro/issue-1',
      targetBranch: 'main',
      title: 't',
      body: 'Closes #1',
      draft: true,
    });
    await reconcileRepo(makeDeps(forge, fakes));
    expect((await forge.getMrForIssue(1))?.state).toBe('open');
    expect(fakes.runnerCalls.length).toBe(0);
  });

  it('merges when approved', async () => {
    seedIssue(forge, { labels: [lifecycleLabel('gitlab', 'in_review')] });
    const mr = await forge.createDraftMr({
      sourceBranch: 'maestro/issue-1',
      targetBranch: 'main',
      title: 't',
      body: 'Closes #1',
      draft: true,
    });
    forge.approveMr(mr.number);
    await reconcileRepo(makeDeps(forge, fakes));
    expect((await forge.getMrForIssue(1))?.state).toBe('merged');
  });

  it('changes requested flips back to in_progress and runs work', async () => {
    seedIssue(forge, { labels: [lifecycleLabel('gitlab', 'in_review')] });
    const mr = await forge.createDraftMr({
      sourceBranch: 'maestro/issue-1',
      targetBranch: 'main',
      title: 't',
      body: 'Closes #1',
      draft: true,
    });
    forge.requestChanges(mr.number);
    fakes.runnerResults = [{ status: 'in_progress', summary: 'addressing' }];
    await reconcileRepo(makeDeps(forge, fakes));
    expect((await forge.getIssue(1))!.labels).toContain(lifecycleLabel('gitlab', 'in_progress'));
    expect(fakes.runnerCalls.length).toBe(1);
  });
});

describe('reconcileRepo — cleanup (done)', () => {
  it('removes the workspace for a closed issue', async () => {
    seedIssue(forge, { state: 'closed' });
    await reconcileRepo(makeDeps(forge, fakes));
    expect(fakes.removed).toContain(1);
  });
});

describe('reconcileRepo — single-tick lifecycle (no cross-tick agent memory)', () => {
  it('claim → (next tick) work+done handoff → review_check → merge → cleanup', async () => {
    seedIssue(forge);

    // tick 1: new → claim
    await reconcileRepo(makeDeps(forge, fakes));
    expect((await forge.getIssue(1))!.labels).toContain(lifecycleLabel('gitlab', 'in_progress'));

    // tick 2: in_progress → work; agent reports done → handoff runs inline this tick
    fakes.runnerResults = [{ status: 'done', summary: 'all done' }];
    await reconcileRepo(makeDeps(forge, fakes));
    expect((await forge.getIssue(1))!.labels).toContain(lifecycleLabel('gitlab', 'in_review'));

    // tick 3: in_review pending → review_check (no-op)
    await reconcileRepo(makeDeps(forge, fakes));
    expect((await forge.getMrForIssue(1))?.state).toBe('open');

    // approve, tick 4: merge
    const mr = await forge.getMrForIssue(1);
    forge.approveMr(mr!.number);
    await reconcileRepo(makeDeps(forge, fakes));
    expect((await forge.getMrForIssue(1))?.state).toBe('merged');

    // issue auto-closes (simulate), tick 5: cleanup
    forge.closeIssue(1);
    await reconcileRepo(makeDeps(forge, fakes));
    expect(fakes.removed).toContain(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/reconciler/index.test.ts`
Expected: FAIL — `Failed to resolve import "./index.js"` (and `../agent/contract.js`). Note: `agent/contract.ts` is owned by M3 but its `AgentResult` type is needed now; M1 creates a minimal type-only version of that file (the `parseAgentResult` parser remains M3's responsibility).

- [ ] **Step 3: Write minimal implementation**

The reconciler imports collaborator types from their owning modules rather than re-declaring them (contract: "collaborators imported, never re-declared structurally"). M3/M4 own the *implementations* of those modules; M1 lands minimal **type-only** seam files so the reconciler typechecks now and M3/M4 fill the bodies later. Create these four type-only files (parsers/clients are M3/M4's responsibility):

`packages/core/src/agent/contract.ts`:

```ts
export type AgentStatus = 'done' | 'needs_input' | 'in_progress';

export interface AgentResult {
  status: AgentStatus;
  summary: string;
}
// parseAgentResult(streamJsonStdout) is added by M3.
```

`packages/core/src/agent/runner.ts` (type-only seam; M3 adds the impl):

```ts
import type { AgentResult } from './contract.js';
import type { PermissionMode } from '../workflow/schema.js';

export interface RunnerOpts {
  command: string;
  maxTurns: number;
  permissionMode: PermissionMode;
}
export interface ClaudeRunner {
  run(cwd: string, prompt: string, opts: RunnerOpts): Promise<AgentResult>;
}
```

`packages/core/src/proof/index.ts` (type-only seam; M4 adds `runProof` + strategies):

```ts
import type { WorkflowConfig } from '../workflow/schema.js';
import type { CommandRunner } from '../util/exec.js';

export interface ProofArtifact {
  path: string; // RELATIVE to workspaceDir
  kind: 'video' | 'image' | 'text';
  caption: string;
}
export interface ProofContext {
  workspaceDir: string;
  workflow: WorkflowConfig;
  exec: CommandRunner; // shared subprocess seam (util/exec.ts)
}
export interface ProofStrategy {
  run(ctx: ProofContext): Promise<ProofArtifact[]>;
}
// runProof(ctx) is added by M4.
```

`packages/core/src/workspace/manager.ts` (type-only seam; M3 adds the impl):

```ts
export interface WorkspaceManager {
  ensure(repoUrl: string, issueNumber: number, branch: string): Promise<string>;
  remove(repoUrl: string, issueNumber: number): Promise<void>;
  enforceDiskCap(capBytes: number): Promise<void>;
  pathFor(repoUrl: string, issueNumber: number): string;
}
```

`packages/core/src/util/exec.ts` (shared subprocess seam; the `execaRunner` impl is added by M2/M3):

```ts
export interface CommandRunner {
  run(
    cmd: string,
    args: string[],
    opts?: { cwd?: string; input?: string; env?: Record<string, string> },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}
```

Also create `packages/core/src/daemon/state.ts` with **just the `SlotManager` interface** now (the `RunState` class that implements it is added in Task 14, which appends to this file):

```ts
// Concurrency gate consumed by the reconciler (contract bag field `slots`).
export interface SlotManager {
  tryClaimSlot(issueNumber: number): boolean;
  releaseSlot(issueNumber: number): void;
  isActive(issueNumber: number): boolean;
  activeCount(): number;
}
```

Then the reconciler:

`packages/core/src/reconciler/index.ts`:

```ts
import type { Action, Issue, IssueSnapshot, MergeRequest } from '../domain/types.js';
import type { ForgeAdapter } from '../forge/adapter.js';
import type { MaestroConfig } from '../config/schema.js';
import type { WorkflowConfig } from '../workflow/schema.js';
import type { AgentResult } from '../agent/contract.js';
import type { ClaudeRunner } from '../agent/runner.js';
import type { ProofArtifact, ProofContext } from '../proof/index.js';
import type { WorkspaceManager } from '../workspace/manager.js';
import type { SlotManager } from '../daemon/state.js';
import type { CommandRunner } from '../util/exec.js';
import { deriveLifecycle } from './derive.js';
import { decideAction } from './decide.js';

// The ONE reconciler deps bag (contract: no per-executor bags). Collaborator
// types are IMPORTED from their owning modules (M3/M4); M1 supplies fakes in tests.
// `agent/contract.ts` is created here as a type-only stub (its parser is M3's).
// The M3/M4 source modules (agent/runner.ts, proof/index.ts, workspace/manager.ts)
// are NOT created by M1 — these are `import type` references the compiler resolves
// once those milestones land; M1's tests use structurally-compatible fakes.
export interface ReconcileDeps {
  adapter: ForgeAdapter;
  workflow: WorkflowConfig;
  config: MaestroConfig;
  repoUrl: string;
  workspace: WorkspaceManager; // from workspace/manager.ts (M3)
  runner: ClaudeRunner; // from agent/runner.ts (M3)
  runProof: (ctx: ProofContext) => Promise<ProofArtifact[]>; // from proof/index.ts (M4)
  exec: CommandRunner; // shared subprocess seam (util/exec.ts) — git commit/push in handoff (M4)
  slots: SlotManager; // concurrency gate, from daemon/state.ts
  clock: () => number;
}

const branchFor = (n: number) => `maestro/issue-${n}`;

// Trigger guard: assignee is the bot, require_label present (if set), and the
// issue author is an allowed actor (empty list = any).
function triggerOk(issue: Issue, workflow: WorkflowConfig): boolean {
  if (!issue.assignees.includes(workflow.botUser)) return false;
  if (workflow.trigger.requireLabel && !issue.labels.includes(workflow.trigger.requireLabel))
    return false;
  if (
    workflow.trigger.allowedActors.length > 0 &&
    !workflow.trigger.allowedActors.includes(issue.authorUsername)
  )
    return false;
  return true;
}

function proofText(artifacts: ProofArtifact[]): string {
  if (artifacts.length === 0) return 'Proof: (no artifacts)';
  return ['Proof:', ...artifacts.map((a) => `- ${a.caption} (${a.kind}): ${a.path}`)].join('\n');
}

export async function reconcileRepo(deps: ReconcileDeps): Promise<void> {
  const { adapter, workflow } = deps;
  const issues = await adapter.listAssignedOpenIssues();

  for (const issue of issues) {
    const mr = await adapter.getMrForIssue(issue.number);
    const lifecycle = deriveLifecycle(adapter.forge, issue, mr);
    const snapshot: IssueSnapshot = { issue, mr, lifecycle };
    const action = decideAction(snapshot, { triggerOk: triggerOk(issue, workflow) });
    await executeAction(action, snapshot, deps);
  }
}

// Runs the agent and consumes its status IN THE SAME TICK: done → handoff inline,
// needs_input → block inline, in_progress → leave label in_progress.
async function runWork(snapshot: IssueSnapshot, deps: ReconcileDeps): Promise<void> {
  const { adapter, workflow, repoUrl } = deps;
  const n = snapshot.issue.number;
  const branch = branchFor(n);
  const dir = await deps.workspace.ensure(repoUrl, n, branch);
  const result: AgentResult = await deps.runner.run(dir, workflow.promptBody, {
    command: workflow.claude.command,
    maxTurns: workflow.claude.maxTurns,
    permissionMode: workflow.claude.permissionMode,
  });
  if (result.status === 'needs_input') {
    await adapter.setLifecycleLabel(n, 'blocked');
    await adapter.comment({ type: 'issue', number: n }, result.summary);
  } else if (result.status === 'done') {
    await handoff(snapshot, deps);
  }
  // 'in_progress' → leave label in_progress (nothing to do).
}

// The inline handoff routine (contract "Handoff order").
async function handoff(snapshot: IssueSnapshot, deps: ReconcileDeps): Promise<void> {
  const { adapter, workflow, repoUrl } = deps;
  const n = snapshot.issue.number;
  const dir = deps.workspace.pathFor(repoUrl, n);
  const artifacts = await deps.runProof({ workspaceDir: dir, workflow, exec: deps.exec });
  const text = proofText(artifacts);
  await adapter.comment({ type: 'issue', number: n }, text);
  if (snapshot.mr) {
    await adapter.comment({ type: 'mr', number: snapshot.mr.number }, text);
    await adapter.assignReviewer(snapshot.mr.number, snapshot.issue.authorUsername);
    await adapter.setMrReady(snapshot.mr.number);
  }
  await adapter.setLifecycleLabel(n, 'in_review');
}

async function executeAction(
  action: Action,
  snapshot: IssueSnapshot,
  deps: ReconcileDeps,
): Promise<void> {
  const { adapter, workflow, repoUrl } = deps;
  const n = action.issueNumber;
  const mr: MergeRequest | null = snapshot.mr;
  switch (action.kind) {
    case 'claim': {
      const branch = branchFor(n);
      await adapter.createBranch(branch, workflow.git.defaultBranch);
      await adapter.createDraftMr({
        sourceBranch: branch,
        targetBranch: workflow.git.target,
        title: snapshot.issue.title,
        body: `Closes #${n}`,
        draft: true,
      });
      await adapter.setLifecycleLabel(n, 'in_progress');
      await adapter.comment({ type: 'issue', number: n }, 'started working');
      return;
    }
    case 'work': {
      // changes-requested path: flip label back to in_progress before working.
      if (mr?.changesRequested) await adapter.setLifecycleLabel(n, 'in_progress');
      await runWork(snapshot, deps);
      return;
    }
    case 'review_check':
      return; // polling only
    case 'merge': {
      if (mr)
        await adapter.mergeMr(mr.number, workflow.git.mergeStrategy, workflow.git.deleteSourceBranch);
      return;
    }
    case 'cleanup':
      await deps.workspace.remove(repoUrl, n);
      return;
    case 'block':
      await adapter.setLifecycleLabel(n, 'blocked');
      await adapter.comment({ type: 'issue', number: n }, action.reason);
      return;
    case 'handoff': // never returned by decideAction; handled inline by runWork.
    case 'noop':
      return;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/reconciler/index.test.ts`
Expected: PASS — all 9 tests green (claim; work x3 incl. inline done→handoff and needs_input→block; review_check/merge/changes-requested x3; cleanup; single-tick lifecycle).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent/contract.ts packages/core/src/agent/runner.ts packages/core/src/proof/index.ts packages/core/src/workspace/manager.ts packages/core/src/util/exec.ts packages/core/src/daemon/state.ts packages/core/src/reconciler/index.ts packages/core/src/reconciler/index.test.ts
git commit -m "feat(core): add reconcileRepo executor over injected collaborators"
```

---

## Task 14: daemon RunState (in-memory slots, rebuilt from forge)

**Files:**
- Modify: `packages/core/src/daemon/state.ts` (append `RunState`; the `SlotManager` interface was created in Task 13)
- Test: `packages/core/src/daemon/state.test.ts`

> No persistence. `RunState implements SlotManager` and tracks running slots (issues currently `in_progress`) and counts. `rebuildFromForge(forge)` derives the active set from the forge (issues whose derived lifecycle is `in_progress`) — proving restart-safety. `tryClaimSlot` / `releaseSlot` enforce `globalMax`.

- [ ] **Step 1: Write the failing test**

`packages/core/src/daemon/state.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { RunState } from './state.js';
import { MemoryForge } from '../forge/memory.js';
import { lifecycleLabel } from '../domain/lifecycle.js';
import type { Issue } from '../domain/types.js';

function seed(forge: MemoryForge, n: number, labels: string[] = []): void {
  const i: Issue = {
    id: `i${n}`,
    number: n,
    title: 't',
    body: '',
    state: 'open',
    assignees: ['maestro-bot'],
    authorUsername: 'alice',
    labels,
    createdAt: '2026-06-03T00:00:00Z',
    webUrl: 'u',
  };
  forge.seedIssue(i);
}

describe('RunState slots', () => {
  let state: RunState;
  beforeEach(() => {
    state = new RunState(2);
  });

  it('claims up to globalMax then refuses', () => {
    expect(state.tryClaimSlot(1)).toBe(true);
    expect(state.tryClaimSlot(2)).toBe(true);
    expect(state.tryClaimSlot(3)).toBe(false);
    expect(state.activeCount()).toBe(2);
  });

  it('claiming the same issue twice is idempotent', () => {
    expect(state.tryClaimSlot(1)).toBe(true);
    expect(state.tryClaimSlot(1)).toBe(true);
    expect(state.activeCount()).toBe(1);
  });

  it('releasing frees a slot', () => {
    state.tryClaimSlot(1);
    state.tryClaimSlot(2);
    state.releaseSlot(1);
    expect(state.activeCount()).toBe(1);
    expect(state.tryClaimSlot(3)).toBe(true);
  });
});

describe('RunState.rebuildFromForge', () => {
  it('derives active slots from in_progress issues (restart-safe)', async () => {
    const forge = new MemoryForge({ forge: 'gitlab', project: 'group/api', botUser: 'maestro-bot' });
    seed(forge, 1, [lifecycleLabel('gitlab', 'in_progress')]);
    seed(forge, 2, [lifecycleLabel('gitlab', 'in_review')]);
    seed(forge, 3, []);
    const state = new RunState(5);
    await state.rebuildFromForge(forge);
    expect(state.activeCount()).toBe(1);
    expect(state.isActive(1)).toBe(true);
    expect(state.isActive(2)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/daemon/state.test.ts`
Expected: FAIL — `Failed to resolve import "./state.js"`.

- [ ] **Step 3: Write minimal implementation (append `RunState` to `state.ts`)**

Append to `packages/core/src/daemon/state.ts` (the `SlotManager` interface already lives there from Task 13). M1 keys slots by `issueNumber`; M5 reconciles the full `(repoUrl, issueNumber)` `SlotManager` + `RunState` data-shape split from the contract.

```ts
import type { ForgeAdapter } from '../forge/adapter.js';
import { deriveLifecycle } from '../reconciler/derive.js';
// SlotManager is declared above in this same file (added in Task 13).

// In-memory only. The single piece of daemon state; rebuilt from the forge on
// restart (no persistence). Tracks which issues currently hold an active slot.
export class RunState implements SlotManager {
  private active = new Set<number>();

  constructor(private readonly globalMax: number) {}

  activeCount(): number {
    return this.active.size;
  }
  isActive(issueNumber: number): boolean {
    return this.active.has(issueNumber);
  }

  // Claim a slot for an issue. Idempotent. Returns false if at capacity.
  tryClaimSlot(issueNumber: number): boolean {
    if (this.active.has(issueNumber)) return true;
    if (this.active.size >= this.globalMax) return false;
    this.active.add(issueNumber);
    return true;
  }

  releaseSlot(issueNumber: number): void {
    this.active.delete(issueNumber);
  }

  // Restart-safety: re-derive active set from the forge's in_progress issues.
  async rebuildFromForge(forge: ForgeAdapter): Promise<void> {
    this.active.clear();
    const issues = await forge.listAssignedOpenIssues();
    for (const issue of issues) {
      const mr = await forge.getMrForIssue(issue.number);
      if (deriveLifecycle(forge.forge, issue, mr) === 'in_progress') {
        this.active.add(issue.number);
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/daemon/state.test.ts`
Expected: PASS — `5 passed`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/daemon/state.ts packages/core/src/daemon/state.test.ts
git commit -m "feat(core): add in-memory RunState rebuilt from forge"
```

---

## Task 15: daemon scheduler (active/idle cadence + jitter, injected clock)

**Files:**
- Create: `packages/core/src/daemon/scheduler.ts`
- Test: `packages/core/src/daemon/scheduler.test.ts`

> Per-repo cadence: a repo with active work polls every `pollIntervalActive`; an idle repo every `pollIntervalIdle`; plus `pollJitter` (bounded random offset). Clock + RNG injected for determinism. `nextDueAt(repoUrl, now, hasActiveWork)` returns the next poll time; `isDue(repoUrl, now)` checks if a repo should poll. Durations parsed via `parseDuration`.

- [ ] **Step 1: Write the failing test**

`packages/core/src/daemon/scheduler.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Scheduler } from './scheduler.js';
import type { DefaultsCfg } from '../config/schema.js';

const defaults: DefaultsCfg = {
  pollIntervalActive: '30s',
  pollIntervalIdle: '5m',
  pollJitter: '5s',
  botUser: 'maestro-bot',
  concurrency: { globalMax: 2 },
  workspaces: { root: './workspaces', diskCap: '20GB', cleanup: 'lru' },
};

describe('Scheduler cadence', () => {
  it('uses the active interval for repos with active work (jitter=0)', () => {
    const s = new Scheduler(defaults, () => 0); // rng -> 0 jitter
    const next = s.nextDueAt('r', 1000, true);
    expect(next).toBe(1000 + 30_000);
  });

  it('uses the idle interval for idle repos (jitter=0)', () => {
    const s = new Scheduler(defaults, () => 0);
    expect(s.nextDueAt('r', 1000, false)).toBe(1000 + 300_000);
  });

  it('adds bounded jitter (rng=1 -> full jitter window)', () => {
    const s = new Scheduler(defaults, () => 1);
    expect(s.nextDueAt('r', 0, true)).toBe(30_000 + 5_000);
  });

  it('isDue is false before the next due time and true at/after it', () => {
    const s = new Scheduler(defaults, () => 0);
    s.schedule('r', 1000, true); // next due at 31000
    expect(s.isDue('r', 30_999)).toBe(false);
    expect(s.isDue('r', 31_000)).toBe(true);
  });

  it('treats an unscheduled repo as due immediately', () => {
    const s = new Scheduler(defaults, () => 0);
    expect(s.isDue('never-seen', 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/daemon/scheduler.test.ts`
Expected: FAIL — `Failed to resolve import "./scheduler.js"`.

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/daemon/scheduler.ts`:

```ts
import { parseDuration, type DefaultsCfg } from '../config/schema.js';

// Adaptive polling cadence per repo, with bounded jitter. Clock values are
// passed in (injected) so the loop owns the clock; rng() in [0,1) is injected
// for deterministic tests.
export class Scheduler {
  private dueAt = new Map<string, number>();
  private readonly activeMs: number;
  private readonly idleMs: number;
  private readonly jitterMs: number;

  constructor(
    defaults: DefaultsCfg,
    private readonly rng: () => number = Math.random,
  ) {
    this.activeMs = parseDuration(defaults.pollIntervalActive);
    this.idleMs = parseDuration(defaults.pollIntervalIdle);
    this.jitterMs = parseDuration(defaults.pollJitter);
  }

  // Compute the next poll time without recording it.
  nextDueAt(_repoUrl: string, now: number, hasActiveWork: boolean): number {
    const base = hasActiveWork ? this.activeMs : this.idleMs;
    const jitter = Math.floor(this.rng() * this.jitterMs);
    return now + base + jitter;
  }

  // Record the next poll time for a repo.
  schedule(repoUrl: string, now: number, hasActiveWork: boolean): void {
    this.dueAt.set(repoUrl, this.nextDueAt(repoUrl, now, hasActiveWork));
  }

  // A repo never scheduled is due immediately.
  isDue(repoUrl: string, now: number): boolean {
    const due = this.dueAt.get(repoUrl);
    return due === undefined || now >= due;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/daemon/scheduler.test.ts`
Expected: PASS — `5 passed`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/daemon/scheduler.ts packages/core/src/daemon/scheduler.test.ts
git commit -m "feat(core): add adaptive polling scheduler with injected clock"
```

---

## Task 16: daemon loop (tick), logger, and public exports

**Files:**
- Create: `packages/core/src/logger.ts`
- Test: `packages/core/src/logger.test.ts`
- Create: `packages/core/src/daemon/loop.ts`
- Test: `packages/core/src/daemon/loop.test.ts`
- Modify: `packages/core/src/index.ts` (replace stub with real public exports)
- Delete: `packages/core/src/index.test.ts` (temporary smoke test from Task 1)

> `tick()` runs one poll cycle for due repos: for each repo, if `scheduler.isDue`, run `reconcileRepo` (returns `void`), then re-derive active work from the forge (`state.rebuildFromForge`) and reschedule on the active/idle cadence accordingly. The logger is a structured logger carrying `issue_number`, `forge`, `mr_number` fields. Loop test drives one tick against MemoryForge end-to-end and checks the forge mutated (issue claimed → in_progress) and the repo was rescheduled.

- [ ] **Step 1: Write the failing logger test**

`packages/core/src/logger.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createLogger } from './logger.js';

describe('createLogger', () => {
  it('emits structured JSON lines with context fields', () => {
    const lines: string[] = [];
    const log = createLogger({ forge: 'gitlab' }, (l) => lines.push(l));
    log.info('started', { issue_number: 7, mr_number: 3 });
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('started');
    expect(parsed.forge).toBe('gitlab');
    expect(parsed.issue_number).toBe(7);
    expect(parsed.mr_number).toBe(3);
  });

  it('child merges additional context', () => {
    const lines: string[] = [];
    const log = createLogger({ forge: 'github' }, (l) => lines.push(l)).child({ issue_number: 9 });
    log.error('boom');
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.level).toBe('error');
    expect(parsed.forge).toBe('github');
    expect(parsed.issue_number).toBe(9);
  });
});
```

- [ ] **Step 2: Run logger test to verify it fails**

Run: `npx vitest run packages/core/src/logger.test.ts`
Expected: FAIL — `Failed to resolve import "./logger.js"`.

- [ ] **Step 3: Write the logger**

`packages/core/src/logger.ts`:

```ts
type Level = 'debug' | 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;
type Sink = (line: string) => void;

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  child(fields: Fields): Logger;
}

// Structured logger. Default sink writes JSON lines to stdout. Context fields
// (issue_number, forge, mr_number, ...) are merged into every line.
export function createLogger(context: Fields = {}, sink: Sink = (l) => console.log(l)): Logger {
  const emit = (level: Level, msg: string, fields?: Fields): void => {
    sink(JSON.stringify({ level, msg, ...context, ...(fields ?? {}) }));
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (f) => createLogger({ ...context, ...f }, sink),
  };
}
```

- [ ] **Step 4: Run logger test to verify it passes**

Run: `npx vitest run packages/core/src/logger.test.ts`
Expected: PASS — `2 passed`.

- [ ] **Step 5: Write the failing loop test**

`packages/core/src/daemon/loop.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { tick, type TickDeps } from './loop.js';
import { Scheduler } from './scheduler.js';
import { RunState } from './state.js';
import { MemoryForge } from '../forge/memory.js';
import { lifecycleLabel } from '../domain/lifecycle.js';
import type { DefaultsCfg } from '../config/schema.js';
import type { MaestroConfig } from '../config/schema.js';
import type { WorkflowConfig } from '../workflow/schema.js';
import type { ReconcileDeps } from '../reconciler/index.js';
import type { Issue } from '../domain/types.js';

const defaults: DefaultsCfg = {
  pollIntervalActive: '30s',
  pollIntervalIdle: '5m',
  pollJitter: '5s',
  botUser: 'maestro-bot',
  concurrency: { globalMax: 2 },
  workspaces: { root: './workspaces', diskCap: '20GB', cleanup: 'lru' },
};

const config: MaestroConfig = { defaults, forges: {}, repos: [] };

const workflow: WorkflowConfig = {
  forge: 'gitlab',
  project: 'group/api',
  botUser: 'maestro-bot',
  manageBoard: true,
  trigger: { assignee: 'bot', requireLabel: null, allowedActors: [] },
  proof: { type: 'none' },
  review: { changesSignal: 'label' },
  git: { defaultBranch: 'main', target: 'main', mergeStrategy: 'squash', deleteSourceBranch: true },
  claude: { command: 'claude', maxTurns: 40, permissionMode: 'acceptEdits' },
  concurrency: { maxActive: 2 },
  promptBody: 'do the work',
};

function reconcileDeps(forge: MemoryForge, slots: RunState): ReconcileDeps {
  return {
    adapter: forge,
    workflow,
    config,
    repoUrl: 'gitlab.com/group/api',
    runner: { async run() { return { status: 'in_progress', summary: '...' }; } },
    runProof: async () => [],
    workspace: {
      async ensure(_r, n, b) { return `/ws/${n}/${b}`; },
      async remove() {},
      async enforceDiskCap() {},
      pathFor(_r, n) { return `/ws/${n}`; },
    },
    exec: { async run() { return { stdout: '', stderr: '', exitCode: 0 }; } },
    slots,
    clock: () => 0,
  };
}

describe('tick', () => {
  it('reconciles a due repo and reschedules it on the active cadence', async () => {
    const forge = new MemoryForge({ forge: 'gitlab', project: 'group/api', botUser: 'maestro-bot' });
    const issue: Issue = {
      id: 'i1', number: 1, title: 't', body: '', state: 'open',
      assignees: ['maestro-bot'], authorUsername: 'alice', labels: [],
      createdAt: '2026-06-03T00:00:00Z', webUrl: 'u',
    };
    forge.seedIssue(issue);

    const scheduler = new Scheduler(defaults, () => 0);
    const state = new RunState(2);
    const deps: TickDeps = {
      now: 1000,
      scheduler,
      state,
      repos: [{ repoUrl: 'gitlab.com/group/api', reconcile: reconcileDeps(forge, state) }],
    };

    await tick(deps);
    // claim ran → issue is now in_progress (active work) → active cadence (30s).
    expect((await forge.getIssue(1))!.labels).toContain(lifecycleLabel('gitlab', 'in_progress'));
    expect(scheduler.isDue('gitlab.com/group/api', 1000)).toBe(false);
    expect(scheduler.isDue('gitlab.com/group/api', 1000 + 30_000)).toBe(true);
  });

  it('skips a repo that is not due (no reconcile side effects)', async () => {
    const forge = new MemoryForge({ forge: 'gitlab', project: 'group/api', botUser: 'maestro-bot' });
    forge.seedIssue({
      id: 'i1', number: 1, title: 't', body: '', state: 'open',
      assignees: ['maestro-bot'], authorUsername: 'alice', labels: [],
      createdAt: '2026-06-03T00:00:00Z', webUrl: 'u',
    });
    const scheduler = new Scheduler(defaults, () => 0);
    scheduler.schedule('gitlab.com/group/api', 1000, false); // due at 301000
    const state = new RunState(2);
    const deps: TickDeps = {
      now: 2000,
      scheduler,
      state,
      repos: [
        { repoUrl: 'gitlab.com/group/api', reconcile: reconcileDeps(forge, state) },
      ],
    };
    await tick(deps);
    // not due → reconcile did not run → no branch was claimed.
    expect(forge.hasBranch('maestro/issue-1')).toBe(false);
  });
});
```

- [ ] **Step 6: Run loop test to verify it fails**

Run: `npx vitest run packages/core/src/daemon/loop.test.ts`
Expected: FAIL — `Failed to resolve import "./loop.js"`.

- [ ] **Step 7: Write the loop**

`packages/core/src/daemon/loop.ts`:

```ts
import { reconcileRepo, type ReconcileDeps } from '../reconciler/index.js';
import { Scheduler } from './scheduler.js';
import { RunState } from './state.js';

export interface RepoTickEntry {
  repoUrl: string;
  reconcile: ReconcileDeps;
}

export interface TickDeps {
  now: number; // injected clock (ms epoch)
  scheduler: Scheduler;
  state: RunState;
  repos: RepoTickEntry[];
}

// One poll cycle. Reconciles every due repo, then reschedules it based on
// whether it currently has active (in_progress) work — derived from the forge
// (durable), not from in-tick action results. `reconcileRepo` returns void.
export async function tick(deps: TickDeps): Promise<void> {
  for (const entry of deps.repos) {
    if (!deps.scheduler.isDue(entry.repoUrl, deps.now)) continue;
    await reconcileRepo(entry.reconcile);
    // Active cadence iff the forge shows in_progress work after reconcile.
    await deps.state.rebuildFromForge(entry.reconcile.adapter);
    const hasActiveWork = deps.state.activeCount() > 0;
    deps.scheduler.schedule(entry.repoUrl, deps.now, hasActiveWork);
  }
}
```

- [ ] **Step 8: Run loop test to verify it passes**

Run: `npx vitest run packages/core/src/daemon/loop.test.ts`
Expected: PASS — `2 passed`.

- [ ] **Step 9: Replace the public exports and delete the smoke test**

Replace `packages/core/src/index.ts` entirely with:

```ts
// Public surface of @maestro/core (M1).
export type {
  Forge,
  LifecycleState,
  Issue,
  MergeRequest,
  IssueSnapshot,
  Action,
  MergeStrategy,
} from './domain/types.js';
export {
  LABELED_STATES,
  lifecycleLabel,
  allMaestroLabels,
  labeledStateOf,
  isLabeledState,
} from './domain/lifecycle.js';
export type { LabeledState } from './domain/lifecycle.js';

export {
  parseDuration,
  MaestroConfigSchema,
} from './config/schema.js';
export type {
  MaestroConfig,
  DefaultsCfg,
  RepoEntry,
  ForgeAuth,
  ConcurrencyCfg,
  WorkspacesCfg,
} from './config/schema.js';
export { loadConfig, watchConfig } from './config/load.js';

export {
  WorkflowConfigSchema,
  toWorkflowConfig,
} from './workflow/schema.js';
export type {
  WorkflowConfig,
  TriggerCfg,
  ProofType,
  PermissionMode,
} from './workflow/schema.js';
export { parseWorkflow, loadWorkflow } from './workflow/load.js';

export { ForgeError } from './forge/adapter.js';
export type { ForgeAdapter, CreateMrArgs, CommentTarget } from './forge/adapter.js';
export { MemoryForge } from './forge/memory.js';

export { deriveLifecycle } from './reconciler/derive.js';
export { decideAction } from './reconciler/decide.js';
export type { DecideContext } from './reconciler/decide.js';
export { reconcileRepo } from './reconciler/index.js';
export type { ReconcileDeps } from './reconciler/index.js';

export type { AgentResult, AgentStatus } from './agent/contract.js';
export type { ClaudeRunner, RunnerOpts } from './agent/runner.js';
export type { ProofArtifact, ProofContext, ProofStrategy } from './proof/index.js';
export type { WorkspaceManager } from './workspace/manager.js';
export type { CommandRunner } from './util/exec.js';

export { RunState } from './daemon/state.js';
export type { SlotManager } from './daemon/state.js';
export { Scheduler } from './daemon/scheduler.js';
export { tick } from './daemon/loop.js';
export type { TickDeps, RepoTickEntry } from './daemon/loop.js';

export { createLogger } from './logger.js';
export type { Logger } from './logger.js';
```

Delete the temporary smoke test:

```bash
git rm packages/core/src/index.test.ts
```

- [ ] **Step 10: Verify the whole core package compiles and all tests pass**

Run: `npx tsc -p packages/core/tsconfig.json --noEmit && npx vitest run`
Expected: tsc exits 0; Vitest reports all suites passing across `packages/core/src/**` (no `index.test.ts` since it was removed).

- [ ] **Step 11: Commit**

```bash
git add packages/core/src/logger.ts packages/core/src/logger.test.ts packages/core/src/daemon/loop.ts packages/core/src/daemon/loop.test.ts packages/core/src/index.ts
git commit -m "feat(core): add daemon tick loop, structured logger, public exports"
```

---

## Task 17: CLI daemon entrypoint — runnable MemoryForge demo

**Files:**
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Create: `packages/cli/src/daemon.ts`

> A runnable demo wiring `MemoryForge` + inline stub collaborators (clearly marked as M3/M4 seams) into a few `tick()` cycles and logging the issue's derived state after each. No commander yet (M5). It seeds one issue, runs ticks, logs progress, and exits. Run via `node` after a build, or `tsx`/`vitest`-free direct check; this milestone verifies it by a smoke test through the build.

- [ ] **Step 1: Create the CLI package files**

`packages/cli/package.json`:

```json
{
  "name": "@maestro/cli",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": { "maestro-daemon": "./dist/daemon.js" },
  "scripts": { "build": "tsc -p tsconfig.json" },
  "dependencies": {
    "@maestro/core": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.5.0"
  }
}
```

`packages/cli/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist"
  },
  "references": [{ "path": "../core" }],
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 2: Write the daemon demo entrypoint**

`packages/cli/src/daemon.ts`:

```ts
import {
  MemoryForge,
  RunState,
  Scheduler,
  tick,
  createLogger,
  type DefaultsCfg,
  type MaestroConfig,
  type WorkflowConfig,
  type ReconcileDeps,
  type TickDeps,
} from '@maestro/core';

// --- demo config (in real use: loadConfig / loadWorkflow) ---
const defaults: DefaultsCfg = {
  pollIntervalActive: '30s',
  pollIntervalIdle: '5m',
  pollJitter: '5s',
  botUser: 'maestro-bot',
  concurrency: { globalMax: 2 },
  workspaces: { root: './workspaces', diskCap: '20GB', cleanup: 'lru' },
};

const config: MaestroConfig = { defaults, forges: {}, repos: [] };

const workflow: WorkflowConfig = {
  forge: 'gitlab',
  project: 'group/api',
  botUser: 'maestro-bot',
  manageBoard: true,
  trigger: { assignee: 'bot', requireLabel: null, allowedActors: [] },
  proof: { type: 'none' },
  review: { changesSignal: 'label' },
  git: { defaultBranch: 'main', target: 'main', mergeStrategy: 'squash', deleteSourceBranch: true },
  claude: { command: 'claude', maxTurns: 40, permissionMode: 'acceptEdits' },
  concurrency: { maxActive: 2 },
  promptBody: 'Work the issue. Atomic commits.',
};

// --- M3/M4 SEAMS: inline stubs. Replaced by real ClaudeRunner (M3),
//     runProof (M4), and WorkspaceManager (M3). ---
function buildReconcileDeps(forge: MemoryForge, slots: RunState): ReconcileDeps {
  return {
    adapter: forge,
    workflow,
    config,
    repoUrl: 'gitlab.com/group/api',
    runner: {
      // SEAM (M3): real runner invokes `claude -p --output-format stream-json`.
      async run() {
        return { status: 'done', summary: 'demo: pretended to work and finished' };
      },
    },
    // SEAM (M4): real runProof dispatches on workflow.proof.type.
    runProof: async () => [{ path: 'proof/demo-proof.txt', kind: 'text', caption: 'demo proof' }],
    // SEAM (M3): real WorkspaceManager clones under workspaces/.
    workspace: {
      async ensure(_repoUrl, issueNumber, branch) {
        return `./workspaces/${issueNumber}/${branch}`;
      },
      async remove() {},
      async enforceDiskCap() {},
      pathFor(_repoUrl, issueNumber) {
        return `./workspaces/${issueNumber}`;
      },
    },
    // SEAM (M2/M3): real execaRunner from util/exec.ts runs git/CLI subprocesses.
    exec: { async run() { return { stdout: '', stderr: '', exitCode: 0 }; } },
    slots,
    clock: () => Date.now(),
  };
}

async function main(): Promise<void> {
  const log = createLogger({ forge: 'gitlab', project: 'group/api' });
  const forge = new MemoryForge({ forge: 'gitlab', project: 'group/api', botUser: 'maestro-bot' });

  // seed one assigned issue so the demo has something to do
  forge.seedIssue({
    id: 'i1',
    number: 1,
    title: 'Add a greeting endpoint',
    body: 'please add /hello',
    state: 'open',
    assignees: ['maestro-bot'],
    authorUsername: 'alice',
    labels: [],
    createdAt: new Date().toISOString(),
    webUrl: 'https://memory/group/api/issues/1',
  });

  const scheduler = new Scheduler(defaults);
  const state = new RunState(defaults.concurrency.globalMax ?? 2);
  await state.rebuildFromForge(forge);

  const deps: TickDeps = {
    now: Date.now(),
    scheduler,
    state,
    repos: [{ repoUrl: 'gitlab.com/group/api', reconcile: buildReconcileDeps(forge, state) }],
  };

  // Run a few ticks to walk the lifecycle. The runner stub reports `done`, so the
  // `work` executor runs the handoff inline in the same tick. tick() returns void;
  // we log the issue's derived state after each tick to show progress.
  for (let i = 0; i < 3; i++) {
    // force-due each iteration for the demo by using a fresh scheduler check window
    await tick({ ...deps, now: Date.now() + i, scheduler: new Scheduler(defaults) });
    const issue = await forge.getIssue(1);
    log.info('tick complete', { issue_number: 1, labels: issue?.labels ?? [] });
  }

  log.info('demo complete');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Install the new package and build both packages**

Run: `pnpm install && pnpm -r build`
Expected: install links `@maestro/cli` (depends on `@maestro/core` via `workspace:*`); both `tsc` builds exit 0, emitting `packages/core/dist` and `packages/cli/dist`.

- [ ] **Step 4: Run the demo to verify it executes end-to-end**

Run: `node packages/cli/dist/daemon.js`
Expected: prints JSON `tick complete` lines for issue 1 — tick 1 leaves it `maestro::in_progress` (claim), tick 2 advances it to `maestro::in_review` (work runs the agent, which reports `done`, so handoff runs inline), tick 3 holds at `in_review` (review_check). Ends with `demo complete`. Exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/package.json packages/cli/tsconfig.json packages/cli/src/daemon.ts pnpm-lock.yaml
git commit -m "feat(cli): add runnable MemoryForge daemon demo"
```

---

## Task 18: Final verification — lint, typecheck, full test suite

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: all suites pass (config schema/load, workflow load, memory forge, derive, decide, reconciler index, state, scheduler, loop, logger). Zero failures.

- [ ] **Step 2: Typecheck both packages**

Run: `npx tsc -p packages/core/tsconfig.json --noEmit && npx tsc -p packages/cli/tsconfig.json --noEmit`
Expected: both exit 0, no type errors.

- [ ] **Step 3: Lint**

Run: `npx eslint . --ext .ts`
Expected: exits 0 (no errors). If any `no-unused-vars` fire on intentionally-unused params, confirm they are prefixed `_`.

- [ ] **Step 4: Format check**

Run: `npx prettier --check .`
Expected: exits 0, "All matched files use Prettier code style". If it reports unformatted files, run `npx prettier --write .` and re-commit the formatting.

- [ ] **Step 5: Commit any formatting fixes (only if Step 4 required changes)**

```bash
git add packages/core packages/cli
git commit -m "chore: apply prettier formatting"
```

---

## Self-Review (performed against the contracts + milestone scope)

- **Domain types/lifecycle/ForgeAdapter/derive/decide/config/workflow schemas:** all derived from the contracts (camelCase TS, snake_case YAML mapping) — including `MergeRequest.description`, `WorkflowConfig.review`, schema names `MaestroConfigSchema`/`WorkflowConfigSchema`. ✓
- **State machine coverage:** `derive.test.ts` covers all five states; `decide.test.ts` covers the lifecycle→action table (`in_progress → work` always); `reconciler/index.test.ts` exercises a single-tick lifecycle new→in_progress→(work+done→inline handoff)→in_review→merge→done plus blocked and changes-requested. ✓
- **Pure reconciler:** `derive.ts` and `decide.ts` import only domain types (+ `labeledStateOf`), do no I/O; `DecideContext` is `triggerOk`-only (no agent status). ✓
- **No persistence / no cross-tick memory:** only `daemon/state.ts` holds in-memory slots; agent status is consumed in the same tick by the `work` executor; `rebuildFromForge` proves restart-safety. ✓
- **Collaborator seams:** one `ReconcileDeps` bag with `adapter`/`workspace`/`runner`/`runProof`/`exec`/`slots`/`config`/`clock`; collaborator types imported from owning modules (`agent/runner.ts`, `proof/index.ts`, `workspace/manager.ts`, `util/exec.ts`, `daemon/state.ts`) as type-only seams; CLI uses clearly-marked inline stubs. ✓
- **Commits:** Conventional Commits, explicit `git add <paths>`, no `Co-Authored-By`. ✓
- **Out of scope respected:** no `glab`/`gh`/`claude`/proof/workspace real modules, no CLI commands beyond the daemon demo, no web. ✓

---

## Open questions

These are gaps the contracts (plan 00) did not fully specify; M1 made the minimal local choice noted, and they should be confirmed before later milestones lock in:

1. **`enforceDiskCap` / LRU eviction is unexercised in M1.** `WorkspaceManager.enforceDiskCap` is declared (type-only seam) and the CLI stub no-ops it. The real LRU policy (`workspaces.cleanup: lru | on_terminal`, `disk_cap`) is M3's `WorkspaceManager`. No action needed in M1; flagged so M3 owns it.

2. **`SlotManager`/`RunState` data-shape split.** M1's `SlotManager` keys slots by `issueNumber` and `RunState` is the implementing class. The contract's `daemon/state.ts` also defines a `RunState` *data* interface (`{ running, queued, totals }`) and a `SlotManager` keyed by `(repoUrl, issueNumber)` with `snapshot(): RunState`. M5 owns the HTTP `/api/state` surface and must reconcile these shapes; M1 deliberately kept the gate minimal since the reconciler does not yet call slot methods.
