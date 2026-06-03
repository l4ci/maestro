# Maestro M7 — Bootstrap Onboarding & Self-Managed Wrapper — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a watched repo has no `WORKFLOW.md`, maestro opens a normal "Define my maestro workflow" issue assigned to the bot; that issue flows through the existing lifecycle and the agent writes a `WORKFLOW.md` MR seeded from `templates/WORKFLOW.md` plus inferred repo facts (test command, default branch, framework). Also harden the self-managed wrapper by validating config before hot-reload.

**Architecture:** Onboarding adds NO parallel execution path. The only new pieces are (1) a seed template `templates/WORKFLOW.md`, (2) pure inference helpers + a seed-prompt builder in `bootstrap/onboard.ts`, (3) `onboardRepo(repo)` that opens one issue via a `ForgeAdapter`, and (4) a trigger inside `commands/add.ts`. Everything after the issue is created is the M1–M5 state machine. Config validation reuses the existing `config/schema.ts` zod schema and is wired in front of the `watchConfig` reload callback.

**Tech Stack:** Node 20+, TypeScript 5.x, ESM. Vitest (colocated `*.test.ts`). `zod` for validation, `gray-matter` for front matter, `yaml` for YAML, `commander` for CLI, `execa` for subprocess. pnpm workspaces (`@maestro/core`, `@maestro/cli`).

**Depends on:** M1–M5 (full lifecycle, forge adapters, CLI). Onboarding REUSES the normal lifecycle — no special-case execution path.

---

## File Structure

| Path | Responsibility | Action |
|---|---|---|
| `templates/WORKFLOW.md` | Default `WORKFLOW.md` template: front matter matching `WorkflowConfig` (placeholders `{{project}}`/`{{forge}}`/`{{botUser}}`/`{{defaultBranch}}`/`{{proofType}}`/`{{proofCommand}}`) + prompt body embedding `DEFAULT_PROTOCOL`. | Create |
| `packages/core/src/agent/protocol.ts` | `DEFAULT_PROTOCOL` prompt fragment (the §9 operating protocol). Owned here per contracts; M7 consumes it for the template body. | Create |
| `packages/core/src/bootstrap/onboard.ts` | `inferTestCommand`, `inferFramework`, `seedWorkflow`, `buildOnboardingPrompt`, `onboardRepo`. Pure inference + one issue-create call. | Create |
| `packages/core/src/bootstrap/onboard.test.ts` | Unit tests: inference helpers, seeding, `onboardRepo` against a fake forge. | Create |
| `packages/core/src/agent/protocol.test.ts` | `DEFAULT_PROTOCOL` shape assertions. | Create |
| `packages/core/src/config/load.ts` | Add `validateConfig` gate so a broken config is rejected before the hot-reload callback fires. | Modify |
| `packages/core/src/config/load.test.ts` | Test: malformed config rejected before reload; valid config reloads. | Modify (or create if absent) |
| `packages/core/src/index.ts` | Export `onboardRepo`, `seedWorkflow`, inference helpers, `DEFAULT_PROTOCOL`, `validateConfig`. | Modify |
| `packages/cli/src/commands/add.ts` | After clone + label/board setup, when no `WORKFLOW.md`, call `onboardRepo`. | Modify |
| `packages/cli/src/commands/add.test.ts` | Test: `add` triggers `onboardRepo` only when `WORKFLOW.md` absent. | Modify (or create if absent) |

**Contract anchors (do not deviate):**
- `WorkflowConfig` fields: `forge`, `project`, `botUser`, `manageBoard`, `trigger {assignee, requireLabel, allowedActors}`, `proof {type, command?}`, `review {changesSignal, changesLabel?}` (changesSignal default `'label'`), `git {defaultBranch, target, mergeStrategy, deleteSourceBranch}`, `environment?`, `claude {command, maxTurns, permissionMode}`, `concurrency`, `promptBody`. (`workflow/schema.ts`)
- `ForgeAdapter` methods used: `listAssignedOpenIssues()`, `createIssue({ title, body, assignee? })`, `createBranch`, `createDraftMr`, `comment`, `getIssue`. (`forge/adapter.ts`)
- Branch/MR conventions: branch `maestro/issue-<number>`, MR body MUST contain `Closes #<number>`. (contracts §"Branch & MR conventions")
- `loadWorkflow(repoDir): WorkflowConfig | null` — `null` means no `WORKFLOW.md`. (`workflow/load.ts`)
- `RepoEntry { url; overrides? }`, `MaestroConfig { defaults; forges; repos }`, `loadConfig(path)`, `watchConfig(path, cb)`. (`config/schema.ts`, `config/load.ts`)

> **Key emphasis:** onboarding is just a normal issue going through the existing state machine. `onboardRepo` ONLY opens the issue. The agent (driven by the standard runner in M3, dispatched by the standard loop) is what writes the `WORKFLOW.md` MR. `seedWorkflow`/`buildOnboardingPrompt` produce the *content the agent is told to write*; they do not themselves create an MR.

---

## Task 1: `DEFAULT_PROTOCOL` prompt fragment (`agent/protocol.ts`)

**Files:**
- Create: `packages/core/src/agent/protocol.ts`
- Test: `packages/core/src/agent/protocol.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/agent/protocol.test.ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_PROTOCOL } from './protocol.js';

describe('DEFAULT_PROTOCOL', () => {
  it('embeds the read-first / plan-in-MR / atomic-commits / ask-when-unsure spine', () => {
    expect(DEFAULT_PROTOCOL).toContain('Orient');
    expect(DEFAULT_PROTOCOL).toContain('MR description');
    expect(DEFAULT_PROTOCOL).toContain('atomic commit');
    expect(DEFAULT_PROTOCOL).toContain('maestro::blocked');
  });

  it('documents the final status JSON contract the runner parses', () => {
    expect(DEFAULT_PROTOCOL).toContain('"status"');
    expect(DEFAULT_PROTOCOL).toContain('done');
    expect(DEFAULT_PROTOCOL).toContain('needs_input');
    expect(DEFAULT_PROTOCOL).toContain('in_progress');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core test -- src/agent/protocol.test.ts`
Expected: FAIL — `Cannot find module './protocol.js'` (or "DEFAULT_PROTOCOL is not exported").

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/agent/protocol.ts

/**
 * The default agent operating protocol (design spec §9), baked into the
 * WORKFLOW.md template prompt body. Every cold `claude -p` session runs this
 * loop, reconstructing context purely from the forge + git.
 */
export const DEFAULT_PROTOCOL = `## Operating protocol

You are an autonomous coding agent working a single issue through to a merged
change. You have no memory of previous sessions — reconstruct all context from
the issue, the MR description, recent commits, the diff, and this WORKFLOW.md.

1. **Orient.** Read the issue, the MR description (your plan, if present), recent
   commits and the current diff, and the repo conventions in this WORKFLOW.md.
2. **First session only — gather context.** If the task is ambiguous, post a
   comment with specific questions, set \`maestro::blocked\`, and stop. Otherwise
   write a plan plus a checkbox todo list into the **MR description**.
3. **Work the next unchecked item.** Make one atomic commit per meaningful step.
4. **After each step**, tick the box in the MR description; post a short progress
   comment if notable.
5. **Done.** When all boxes are checked and the definition of done is met, emit a
   \`done\` status.
6. **Blocked anytime.** If you need a human decision, comment the question, set
   \`maestro::blocked\`, and stop.

The MR description is your durable scratchpad; issue and MR comments are the
append-only log. A fresh agent needs no handoff — it reads these sources and
continues.

## Final status (required)

End every session by emitting a single fenced JSON block as the last thing you
output:

\`\`\`json
{"status":"done|needs_input|in_progress","summary":"one-line summary"}
\`\`\`

- \`done\` — all work complete, definition of done met.
- \`needs_input\` — you set \`maestro::blocked\` and need a human answer.
- \`in_progress\` — more work remains for a later session.
`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/core test -- src/agent/protocol.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent/protocol.ts packages/core/src/agent/protocol.test.ts
git commit -m "feat(core): add DEFAULT_PROTOCOL agent operating-protocol fragment"
```

---

## Task 2: `inferTestCommand` — parse package.json → test command

**Files:**
- Create: `packages/core/src/bootstrap/onboard.ts`
- Test: `packages/core/src/bootstrap/onboard.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/bootstrap/onboard.test.ts
import { describe, it, expect } from 'vitest';
import { inferTestCommand } from './onboard.js';

describe('inferTestCommand', () => {
  it('returns the package.json test script wrapped in the package manager', () => {
    const pkg = JSON.stringify({ scripts: { test: 'vitest run' } });
    expect(inferTestCommand(pkg)).toBe('npm test');
  });

  it('prefers pnpm when a pnpm-lock marker is supplied', () => {
    const pkg = JSON.stringify({ scripts: { test: 'vitest run' } });
    expect(inferTestCommand(pkg, { packageManager: 'pnpm' })).toBe('pnpm test');
  });

  it('returns null when there is no test script', () => {
    const pkg = JSON.stringify({ scripts: { build: 'tsc' } });
    expect(inferTestCommand(pkg)).toBeNull();
  });

  it('returns null when the package.json is missing or unparseable', () => {
    expect(inferTestCommand(null)).toBeNull();
    expect(inferTestCommand('{ not json')).toBeNull();
  });

  it('ignores the npm placeholder test script', () => {
    const pkg = JSON.stringify({
      scripts: { test: 'echo "Error: no test specified" && exit 1' },
    });
    expect(inferTestCommand(pkg)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core test -- src/bootstrap/onboard.test.ts`
Expected: FAIL — `Cannot find module './onboard.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/bootstrap/onboard.ts

export type PackageManager = 'npm' | 'pnpm' | 'yarn';

const NPM_PLACEHOLDER_TEST = 'echo "Error: no test specified" && exit 1';

interface InferOpts {
  packageManager?: PackageManager;
}

function parsePkg(raw: string | null): { scripts?: Record<string, string> } | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { scripts?: Record<string, string> };
  } catch {
    return null;
  }
}

/**
 * Infer the test command from a package.json string. Returns the package
 * manager's `test` invocation (e.g. `pnpm test`), or null if there is no
 * usable test script.
 */
export function inferTestCommand(
  packageJson: string | null,
  opts: InferOpts = {},
): string | null {
  const pkg = parsePkg(packageJson);
  const test = pkg?.scripts?.test;
  if (!test || test.trim() === NPM_PLACEHOLDER_TEST) return null;
  const pm = opts.packageManager ?? 'npm';
  return `${pm} test`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/core test -- src/bootstrap/onboard.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/bootstrap/onboard.ts packages/core/src/bootstrap/onboard.test.ts
git commit -m "feat(core): infer test command from package.json for onboarding"
```

---

## Task 3: `inferFramework` — detect framework from package.json deps

**Files:**
- Modify: `packages/core/src/bootstrap/onboard.ts`
- Test: `packages/core/src/bootstrap/onboard.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/core/src/bootstrap/onboard.test.ts
import { inferFramework } from './onboard.js';

describe('inferFramework', () => {
  it('detects next from dependencies', () => {
    const pkg = JSON.stringify({ dependencies: { next: '14.0.0', react: '18' } });
    expect(inferFramework(pkg)).toBe('next');
  });

  it('detects fastify from devDependencies', () => {
    const pkg = JSON.stringify({ devDependencies: { fastify: '4.0.0' } });
    expect(inferFramework(pkg)).toBe('fastify');
  });

  it('falls back to react when react is present without a meta-framework', () => {
    const pkg = JSON.stringify({ dependencies: { react: '18.0.0' } });
    expect(inferFramework(pkg)).toBe('react');
  });

  it('returns "unknown" when no known framework dependency is present', () => {
    const pkg = JSON.stringify({ dependencies: { lodash: '4' } });
    expect(inferFramework(pkg)).toBe('unknown');
  });

  it('returns "unknown" for missing or unparseable package.json', () => {
    expect(inferFramework(null)).toBe('unknown');
    expect(inferFramework('nope')).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core test -- src/bootstrap/onboard.test.ts`
Expected: FAIL — `inferFramework is not exported` / `is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to packages/core/src/bootstrap/onboard.ts

export type Framework = 'next' | 'remix' | 'vue' | 'svelte' | 'fastify' | 'express' | 'react' | 'unknown';

// Order matters: meta-frameworks before the base libraries they build on.
const FRAMEWORK_PRIORITY: Framework[] = [
  'next', 'remix', 'vue', 'svelte', 'fastify', 'express', 'react',
];

/**
 * Detect the primary framework by scanning dependencies + devDependencies.
 * Returns 'unknown' when nothing recognized is present.
 */
export function inferFramework(packageJson: string | null): Framework {
  const pkg = parsePkg(packageJson) as
    | { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    | null;
  if (!pkg) return 'unknown';
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  for (const fw of FRAMEWORK_PRIORITY) {
    if (deps[fw]) return fw;
  }
  return 'unknown';
}
```

> Note: `parsePkg` is reused from Task 2 (same file). Loosen its return type if your linter complains — declare it as `Record<string, unknown> | null` and cast at the two call sites.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/core test -- src/bootstrap/onboard.test.ts`
Expected: PASS (Task 2 + Task 3 = 10 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/bootstrap/onboard.ts packages/core/src/bootstrap/onboard.test.ts
git commit -m "feat(core): infer framework from package.json deps for onboarding"
```

---

## Task 4: `templates/WORKFLOW.md` seed template

**Files:**
- Create: `templates/WORKFLOW.md`
- (Tested indirectly by Task 5's `seedWorkflow`.)

- [ ] **Step 1: Create the template file**

The front matter must match every required field of `WorkflowConfig`
(`workflow/schema.ts`). Placeholders use `{{...}}` and are substituted by
`seedWorkflow` (Task 5). The body embeds `DEFAULT_PROTOCOL` at fill time via the
`{{protocol}}` marker.

```markdown
---
forge: {{forge}}
project: {{project}}
bot_user: {{botUser}}
manage_board: true
trigger:
  assignee: bot
  require_label: null
  allowed_actors: []
proof:
  type: {{proofType}}
  command: {{proofCommand}}
review:
  changes_signal: label
git:
  default_branch: {{defaultBranch}}
  target: {{defaultBranch}}
  merge_strategy: squash
  delete_source_branch: true
claude:
  command: claude
  max_turns: 40
  permission_mode: acceptEdits
concurrency:
  max_active: 2
---
# {{project}} — maestro workflow

<!-- Detected framework: {{framework}} -->

{{protocol}}

## Repo-specific conventions

> Replace the guidance below with this repo's real rules. The agent reads this
> section on every session.

- **Tests:** `{{proofCommand}}`
- **Lint:** _add the lint command here_
- **Architecture notes:** _add a short orientation here_
- **Definition of done:** tests pass, lint passes, and the change satisfies the
  issue's acceptance criteria.
```

> **Why placeholders, not a finished file:** the template is seed material. The
> agent (via the normal lifecycle) fills the conventions section with real repo
> facts during onboarding. `seedWorkflow` only substitutes the mechanically
> inferable values.

- [ ] **Step 2: Commit**

```bash
git add templates/WORKFLOW.md
git commit -m "feat: add default WORKFLOW.md bootstrap template"
```

---

## Task 5: `seedWorkflow` — substitute inferred facts into the template

**Files:**
- Modify: `packages/core/src/bootstrap/onboard.ts`
- Test: `packages/core/src/bootstrap/onboard.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/core/src/bootstrap/onboard.test.ts
import matter from 'gray-matter';
import { seedWorkflow } from './onboard.js';
import { parseWorkflow } from '../workflow/load.js';

const TEMPLATE = `---
forge: {{forge}}
project: {{project}}
bot_user: {{botUser}}
manage_board: true
trigger:
  assignee: bot
  require_label: null
  allowed_actors: []
proof:
  type: {{proofType}}
  command: {{proofCommand}}
review:
  changes_signal: label
git:
  default_branch: {{defaultBranch}}
  target: {{defaultBranch}}
  merge_strategy: squash
  delete_source_branch: true
claude:
  command: claude
  max_turns: 40
  permission_mode: acceptEdits
concurrency:
  max_active: 2
---
# {{project}} — maestro workflow

<!-- Detected framework: {{framework}} -->

{{protocol}}
`;

describe('seedWorkflow', () => {
  it('substitutes inferred facts and yields a parseable WorkflowConfig', () => {
    const seeded = seedWorkflow(TEMPLATE, {
      forge: 'github',
      project: 'org/web',
      botUser: 'maestro-bot',
      defaultBranch: 'main',
      testCommand: 'pnpm test',
      framework: 'next',
    });

    // No placeholders remain.
    expect(seeded).not.toContain('{{');

    // Front matter parses and matches the inferred facts.
    const parsed = parseWorkflow(seeded);
    expect(parsed.forge).toBe('github');
    expect(parsed.project).toBe('org/web');
    expect(parsed.botUser).toBe('maestro-bot');
    expect(parsed.git.defaultBranch).toBe('main');
    expect(parsed.git.target).toBe('main');
    expect(parsed.proof.type).toBe('test-output');
    expect(parsed.proof.command).toBe('pnpm test');

    // Body carries the protocol and the framework hint.
    expect(parsed.promptBody).toContain('Operating protocol');
    expect(parsed.promptBody).toContain('Detected framework: next');
  });

  it('falls back to proof type "none" when no test command was inferred', () => {
    const seeded = seedWorkflow(TEMPLATE, {
      forge: 'gitlab',
      project: 'group/lib',
      botUser: 'maestro-bot',
      defaultBranch: 'master',
      testCommand: null,
      framework: 'unknown',
    });
    const fm = matter(seeded).data as { proof: { type: string; command: unknown } };
    expect(fm.proof.type).toBe('none');
    // command must be null (not the literal "null" placeholder) so it parses cleanly.
    expect(fm.proof.command).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core test -- src/bootstrap/onboard.test.ts`
Expected: FAIL — `seedWorkflow is not exported`.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to packages/core/src/bootstrap/onboard.ts
import type { Forge } from '../domain/types.js';
import { DEFAULT_PROTOCOL } from '../agent/protocol.js';
import type { Framework } from './onboard.js'; // (self-import not needed; Framework already in scope)

export interface SeedFacts {
  forge: Forge;
  project: string;
  botUser: string;
  defaultBranch: string;
  testCommand: string | null;   // from inferTestCommand
  framework: Framework;         // from inferFramework
}

/**
 * Fill the WORKFLOW.md template with inferred facts. When a test command was
 * detected we seed proof type `test-output`; otherwise `none` with a null
 * command. (Contracts prefer screenshot-oriented proof by default, but
 * `ProofType` has no `screenshot` value — screenshots are produced by the
 * `playwright` strategy, which is opt-in and needs a running environment we
 * can't infer here. So we seed the safe mechanically-derivable choice and let
 * the agent upgrade to `playwright` during onboarding when appropriate.)
 * The result is a complete WORKFLOW.md the agent then refines.
 */
export function seedWorkflow(template: string, facts: SeedFacts): string {
  const hasTest = facts.testCommand !== null;
  const proofType = hasTest ? 'test-output' : 'none';
  // YAML scalar for the command: a quoted string, or bare `null`.
  const proofCommand = hasTest ? JSON.stringify(facts.testCommand) : 'null';

  const replacements: Record<string, string> = {
    forge: facts.forge,
    project: facts.project,
    botUser: facts.botUser,
    defaultBranch: facts.defaultBranch,
    proofType,
    proofCommand,
    framework: facts.framework,
    protocol: DEFAULT_PROTOCOL,
  };

  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    if (!(key in replacements)) {
      throw new Error(`seedWorkflow: unknown template placeholder {{${key}}}`);
    }
    return replacements[key];
  });
}
```

> Remove the `import type { Framework } ... ` self-import line if `Framework` is
> already declared earlier in this same file (it is — from Task 3). It is listed
> only to make the type dependency explicit.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/core test -- src/bootstrap/onboard.test.ts`
Expected: PASS (Tasks 2,3,5 — 12 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/bootstrap/onboard.ts packages/core/src/bootstrap/onboard.test.ts
git commit -m "feat(core): seed WORKFLOW.md template from inferred facts"
```

---

## Task 6: `buildOnboardingPrompt` — instructions the agent follows

**Files:**
- Modify: `packages/core/src/bootstrap/onboard.ts`
- Test: `packages/core/src/bootstrap/onboard.test.ts`

This is the issue body the bot opens. It tells the agent (running the normal
lifecycle) exactly what to do: write `WORKFLOW.md` seeded from the template +
inferred facts, then refine the conventions. No new pipeline — just text.

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/core/src/bootstrap/onboard.test.ts
import { buildOnboardingPrompt } from './onboard.js';

describe('buildOnboardingPrompt', () => {
  it('instructs the agent to commit WORKFLOW.md and embeds the seeded content', () => {
    const seeded = '---\nforge: github\n---\n# seeded body\n';
    const body = buildOnboardingPrompt({ project: 'org/web', seededWorkflow: seeded });
    expect(body).toContain('WORKFLOW.md');
    expect(body).toContain('org/web');
    expect(body).toContain('# seeded body');
    // The seeded content is fenced so the agent can copy it verbatim.
    expect(body).toContain('```markdown');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core test -- src/bootstrap/onboard.test.ts`
Expected: FAIL — `buildOnboardingPrompt is not exported`.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to packages/core/src/bootstrap/onboard.ts

export interface OnboardingPromptArgs {
  project: string;
  seededWorkflow: string;   // output of seedWorkflow()
}

/**
 * The issue body for the "Define my maestro workflow" onboarding issue. The
 * agent picks this up through the NORMAL lifecycle; nothing here is special-cased.
 */
export function buildOnboardingPrompt(args: OnboardingPromptArgs): string {
  return `This repo (\`${args.project}\`) has no \`WORKFLOW.md\` yet. Onboard it.

**Your task**

1. Create a \`WORKFLOW.md\` at the repo root with the seeded content below.
2. Review the front matter: confirm the detected \`proof\` command runs, and fix
   it if wrong.
3. Replace the placeholder guidance in the **Repo-specific conventions** section
   with this repo's real lint command, architecture notes, and definition of done.
4. Commit \`WORKFLOW.md\` and update the MR description with a short checklist.

Seed (copy this, then refine):

\`\`\`markdown
${args.seededWorkflow}
\`\`\`

When \`WORKFLOW.md\` is committed and the conventions section is filled in, you're
done.`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/core test -- src/bootstrap/onboard.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/bootstrap/onboard.ts packages/core/src/bootstrap/onboard.test.ts
git commit -m "feat(core): build onboarding issue prompt with seeded WORKFLOW.md"
```

---

## Task 7: `onboardRepo` — open the onboarding issue via a forge adapter

**Files:**
- Modify: `packages/core/src/bootstrap/onboard.ts`
- Test: `packages/core/src/bootstrap/onboard.test.ts`

`onboardRepo` creates ONE issue titled "Define my maestro workflow", assigned to
the bot, with the onboarding prompt as the body. It is idempotent: if such an
open issue already exists (assigned to the bot, matching title), it does nothing.
After this, the issue flows through the normal lifecycle — `onboardRepo` returns.

`ForgeAdapter` exposes `createIssue(args: { title; body; assignee? }): Promise<Issue>`
(contracts §forge/adapter.ts), so `onboardRepo` takes a `ForgeAdapter` directly —
no bespoke issue-create seam.

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/core/src/bootstrap/onboard.test.ts
import { onboardRepo, ONBOARD_ISSUE_TITLE } from './onboard.js';
import type { Issue } from '../domain/types.js';

function fakeIssue(over: Partial<Issue> = {}): Issue {
  return {
    id: 'i1', number: 1, title: 't', body: '', state: 'open',
    assignees: ['maestro-bot'], authorUsername: 'maestro-bot', labels: [],
    createdAt: '2026-06-03T00:00:00Z', webUrl: 'https://x/1', ...over,
  };
}

function makeFakeForge() {
  const created: { title: string; body: string; assignee?: string }[] = [];
  let existing: Issue[] = [];
  return {
    forge: 'github' as const,
    project: 'org/web',
    botUser: 'maestro-bot',
    listAssignedOpenIssues: async () => existing,
    createIssue: async (args: { title: string; body: string; assignee?: string }) => {
      created.push(args);
      const issue = fakeIssue({
        number: 7, title: args.title, body: args.body,
        assignees: args.assignee ? [args.assignee] : [],
      });
      existing = [...existing, issue];
      return issue;
    },
    _created: created,
    _setExisting: (xs: Issue[]) => { existing = xs; },
  };
}

describe('onboardRepo', () => {
  it('creates the onboarding issue assigned to the bot when none exists', async () => {
    const forge = makeFakeForge();
    const result = await onboardRepo({
      forge,
      project: 'org/web',
      defaultBranch: 'main',
      packageJson: JSON.stringify({ scripts: { test: 'vitest run' } }),
      template: '---\nforge: {{forge}}\nproject: {{project}}\nbot_user: {{botUser}}\n' +
        'manage_board: true\ntrigger:\n  assignee: bot\n  require_label: null\n  allowed_actors: []\n' +
        'proof:\n  type: {{proofType}}\n  command: {{proofCommand}}\n' +
        'git:\n  default_branch: {{defaultBranch}}\n  target: {{defaultBranch}}\n' +
        '  merge_strategy: squash\n  delete_source_branch: true\n' +
        'claude:\n  command: claude\n  max_turns: 40\n  permission_mode: acceptEdits\n' +
        'concurrency:\n  max_active: 2\n---\n# {{project}}\n<!-- {{framework}} -->\n{{protocol}}\n',
    });

    expect(result.created).toBe(true);
    expect(forge._created).toHaveLength(1);
    expect(forge._created[0].title).toBe(ONBOARD_ISSUE_TITLE);
    expect(forge._created[0].assignee).toBe('maestro-bot');
    expect(forge._created[0].body).toContain('WORKFLOW.md');
    // Inferred test command flowed through the seed into the issue body.
    expect(forge._created[0].body).toContain('npm test');
  });

  it('is idempotent: does not re-create when an open onboarding issue exists', async () => {
    const forge = makeFakeForge();
    forge._setExisting([fakeIssue({ number: 3, title: ONBOARD_ISSUE_TITLE })]);
    const result = await onboardRepo({
      forge,
      project: 'org/web',
      defaultBranch: 'main',
      packageJson: null,
      template: '---\nforge: {{forge}}\n---\n{{protocol}}\n{{project}}{{botUser}}{{defaultBranch}}{{proofType}}{{proofCommand}}{{framework}}',
    });
    expect(result.created).toBe(false);
    expect(forge._created).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core test -- src/bootstrap/onboard.test.ts`
Expected: FAIL — `onboardRepo is not exported` / `ONBOARD_ISSUE_TITLE is not exported`.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to packages/core/src/bootstrap/onboard.ts

export const ONBOARD_ISSUE_TITLE = 'Define my maestro workflow';

// onboardRepo depends only on this slice of ForgeAdapter (contracts §forge/adapter.ts):
// the three members it actually touches. Production passes a real ForgeAdapter; tests
// pass a fake. No bespoke seam — these are the exact ForgeAdapter signatures.
type OnboardForge = Pick<
  import('../forge/adapter.js').ForgeAdapter,
  'forge' | 'project' | 'botUser' | 'listAssignedOpenIssues' | 'createIssue'
>;

export interface OnboardArgs {
  forge: OnboardForge;
  project: string;
  defaultBranch: string;
  packageJson: string | null;   // contents of the repo's root package.json, or null
  template: string;             // contents of templates/WORKFLOW.md
}

export interface OnboardResult {
  created: boolean;
  issueNumber?: number;
}

/**
 * Open the onboarding issue if the repo needs one. Idempotent. After this the
 * issue runs through the standard lifecycle — there is no special-case path.
 */
export async function onboardRepo(args: OnboardArgs): Promise<OnboardResult> {
  const { forge } = args;

  const open = await forge.listAssignedOpenIssues();
  const already = open.find((i) => i.title === ONBOARD_ISSUE_TITLE);
  if (already) return { created: false, issueNumber: already.number };

  const seeded = seedWorkflow(args.template, {
    forge: forge.forge,
    project: args.project,
    botUser: forge.botUser,
    defaultBranch: args.defaultBranch,
    testCommand: inferTestCommand(args.packageJson),
    framework: inferFramework(args.packageJson),
  });

  const body = buildOnboardingPrompt({ project: args.project, seededWorkflow: seeded });
  const issue = await forge.createIssue({ title: ONBOARD_ISSUE_TITLE, body, assignee: forge.botUser });
  return { created: true, issueNumber: issue.number };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/core test -- src/bootstrap/onboard.test.ts`
Expected: PASS (15 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/bootstrap/onboard.ts packages/core/src/bootstrap/onboard.test.ts
git commit -m "feat(core): onboardRepo opens idempotent onboarding issue"
```

---

## Task 8: Export onboarding API from core barrel

**Files:**
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/index.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/index.test.ts  (append if file exists)
import { describe, it, expect } from 'vitest';
import * as core from './index.js';

describe('core barrel — bootstrap exports', () => {
  it('re-exports onboarding API + protocol', () => {
    expect(typeof core.onboardRepo).toBe('function');
    expect(typeof core.seedWorkflow).toBe('function');
    expect(typeof core.inferTestCommand).toBe('function');
    expect(typeof core.inferFramework).toBe('function');
    expect(typeof core.buildOnboardingPrompt).toBe('function');
    expect(typeof core.DEFAULT_PROTOCOL).toBe('string');
    expect(core.ONBOARD_ISSUE_TITLE).toBe('Define my maestro workflow');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core test -- src/index.test.ts`
Expected: FAIL — `core.onboardRepo is not a function` (undefined export).

- [ ] **Step 3: Add the exports**

```ts
// append to packages/core/src/index.ts
export {
  onboardRepo,
  seedWorkflow,
  buildOnboardingPrompt,
  inferTestCommand,
  inferFramework,
  ONBOARD_ISSUE_TITLE,
} from './bootstrap/onboard.js';
export type {
  OnboardArgs,
  OnboardResult,
  SeedFacts,
  Framework,
  PackageManager,
} from './bootstrap/onboard.js';
export { DEFAULT_PROTOCOL } from './agent/protocol.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/core test -- src/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/index.ts packages/core/src/index.test.ts
git commit -m "feat(core): export onboarding + protocol from public barrel"
```

---

## Task 9: Config validation gate before hot-reload (`config/load.ts`)

**Files:**
- Modify: `packages/core/src/config/load.ts`
- Test: `packages/core/src/config/load.test.ts` (create if absent)

The self-managed wrapper edits `maestro.config.yaml` via the normal lifecycle. A
merged-but-broken config must NOT take down the daemon. Add `validateConfig` and
wire it so `watchConfig` skips the reload callback (and logs) when the new file
fails validation, keeping the last-good config in effect.

> **Contract anchor:** `config/schema.ts` already defines the zod `MaestroConfig`
> schema; `validateConfig` reuses it. `watchConfig(path, cb)` signature is fixed
> by contracts — we do not change it; we only guard the `cb` call internally.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/config/load.test.ts
import { describe, it, expect } from 'vitest';
import { validateConfig } from './load.js';

const VALID = `
defaults:
  pollIntervalActive: "30s"
  pollIntervalIdle: "5m"
  pollJitter: "5s"
  botUser: maestro-bot
  concurrency: { globalMax: 2 }
  workspaces: { root: ./workspaces, diskCap: 20GB, cleanup: lru }
forges:
  github: { host: github.com, tokenEnv: MAESTRO_GITHUB_TOKEN }
repos:
  - url: github.com/org/web
`;

const BROKEN = `
defaults:
  botUser: maestro-bot
repos: "not-an-array"
`;

describe('validateConfig', () => {
  it('returns ok:true with the parsed config for a valid YAML string', () => {
    const r = validateConfig(VALID);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.repos[0].url).toBe('github.com/org/web');
      expect(r.config.defaults.botUser).toBe('maestro-bot');
    }
  });

  it('returns ok:false with errors for a malformed config (no throw)', () => {
    const r = validateConfig(BROKEN);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.errors.join(' ')).toMatch(/repos/);
    }
  });

  it('returns ok:false for unparseable YAML rather than throwing', () => {
    const r = validateConfig(':\n  - [unbalanced');
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core test -- src/config/load.test.ts`
Expected: FAIL — `validateConfig is not exported`.

- [ ] **Step 3: Write minimal implementation**

Add `validateConfig` and route the existing parse path through it. Adjust the
imports to match the actual M1 `config/load.ts` (it already imports the zod
schema and `yaml`); this shows the new export and the guard wiring.

```ts
// packages/core/src/config/load.ts  — add near the top-level exports

import { parse as parseYaml } from 'yaml';
// `MaestroConfigSchema` is the zod schema declared in config/schema.ts (contracts §config).
import { MaestroConfigSchema } from './schema.js';
import type { MaestroConfig } from './schema.js';

export type ValidateResult =
  | { ok: true; config: MaestroConfig }
  | { ok: false; errors: string[] };

/**
 * Parse + validate a maestro.config.yaml string WITHOUT throwing. Used as the
 * gate in front of hot-reload so a broken merged config is rejected rather than
 * crashing the daemon (self-managed wrapper safety, spec §12).
 */
export function validateConfig(raw: string): ValidateResult {
  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (e) {
    return { ok: false, errors: [`YAML parse error: ${(e as Error).message}`] };
  }
  const parsed = MaestroConfigSchema.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    };
  }
  return { ok: true, config: parsed.data as MaestroConfig };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/core test -- src/config/load.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config/load.ts packages/core/src/config/load.test.ts
git commit -m "feat(core): add validateConfig gate (no-throw parse + zod)"
```

---

## Task 10: Guard `watchConfig` reload with `validateConfig`

**Files:**
- Modify: `packages/core/src/config/load.ts`
- Test: `packages/core/src/config/load.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/core/src/config/load.test.ts
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchConfig } from './load.js';

const VALID2 = `
defaults:
  pollIntervalActive: "30s"
  pollIntervalIdle: "5m"
  pollJitter: "5s"
  botUser: maestro-bot
  concurrency: { globalMax: 2 }
  workspaces: { root: ./workspaces, diskCap: 20GB, cleanup: lru }
forges:
  github: { host: github.com, tokenEnv: MAESTRO_GITHUB_TOKEN }
repos:
  - url: github.com/org/web
`;

describe('watchConfig reload gate', () => {
  it('does NOT invoke the callback when the new file is invalid', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'maestro-cfg-'));
    const path = join(dir, 'maestro.config.yaml');
    writeFileSync(path, VALID2);

    const seen: string[] = [];
    const stop = watchConfig(path, (cfg) => seen.push(cfg.repos[0].url));

    // Write a broken config; reload must be rejected.
    writeFileSync(path, 'repos: "not-an-array"\n');
    await new Promise((r) => setTimeout(r, 200));

    expect(seen).toHaveLength(0); // watchConfig fires only on change, never initial load (contracts §config); broken write rejected
    stop();
  });

  it('invokes the callback when a valid new file is written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'maestro-cfg-'));
    const path = join(dir, 'maestro.config.yaml');
    writeFileSync(path, VALID2);

    const seen: string[] = [];
    const stop = watchConfig(path, (cfg) => seen.push(cfg.repos[0].url));

    writeFileSync(path, VALID2.replace('org/web', 'org/api'));
    await new Promise((r) => setTimeout(r, 200));

    expect(seen).toContain('github.com/org/api');
    stop();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/core test -- src/config/load.test.ts`
Expected: FAIL — without the gate, the broken write either throws or invokes the
callback; the validation guard is not yet present.

- [ ] **Step 3: Wire the gate into `watchConfig`**

Inside `watchConfig`'s file-change handler, replace the direct parse+callback
with the validated path. Keep the contracts signature `watchConfig(path, cb): () => void`.

```ts
// packages/core/src/config/load.ts — within the change handler of watchConfig
import { readFileSync } from 'node:fs';
import { logger } from '../logger.js';

// ...inside the fs.watch / chokidar 'change' handler:
const raw = readFileSync(path, 'utf8');
const result = validateConfig(raw);
if (!result.ok) {
  logger.warn(
    { errors: result.errors },
    'rejected invalid maestro.config.yaml; keeping last-good config',
  );
  return; // do NOT call cb — last-good config stays in effect
}
cb(result.config);
```

> Use whatever watcher M1 already wired (`fs.watch` or `chokidar`). Only the body
> of the change handler changes: parse → validate → guard → `cb`. Debounce
> behavior from M1 is preserved.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/core test -- src/config/load.test.ts`
Expected: PASS (5 tests total in this file).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config/load.ts packages/core/src/config/load.test.ts
git commit -m "feat(core): reject invalid config before hot-reload"
```

---

## Task 11: `maestro add` triggers onboarding when no WORKFLOW.md (`commands/add.ts`)

**Files:**
- Modify: `packages/cli/src/commands/add.ts`
- Test: `packages/cli/src/commands/add.test.ts` (create if absent)

After M5's `add` clones the repo, appends the `RepoEntry`, and runs label/board
setup, it must check for `WORKFLOW.md` and call `onboardRepo` when absent. Reuse
`loadWorkflow(repoDir)` (returns `null` when missing). The maestro repo itself
adds as a normal `RepoEntry` — no special path; this same code onboards it.

> M5's `commands/add.ts` already builds a `ForgeAdapter` via `createForge(...)`
> (contracts §forge/factory.ts), and that adapter exposes `createIssue` — so the
> production wiring passes the real adapter straight into `onboardRepo`. The test
> below injects a fake forge.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/src/commands/add.test.ts
import { describe, it, expect, vi } from 'vitest';
import { maybeOnboard } from './add.js';

describe('maybeOnboard', () => {
  it('calls onboardRepo when the cloned repo has no WORKFLOW.md', async () => {
    const onboard = vi.fn().mockResolvedValue({ created: true, issueNumber: 7 });
    const loadWorkflow = vi.fn().mockReturnValue(null); // no WORKFLOW.md

    const r = await maybeOnboard({
      repoDir: '/tmp/clone',
      forge: { forge: 'github', project: 'org/web', botUser: 'maestro-bot' } as never,
      defaultBranch: 'main',
      packageJson: JSON.stringify({ scripts: { test: 'vitest run' } }),
      template: '---\nforge: {{forge}}\n---\n{{protocol}}{{project}}{{botUser}}{{defaultBranch}}{{proofType}}{{proofCommand}}{{framework}}',
      deps: { onboardRepo: onboard, loadWorkflow },
    });

    expect(loadWorkflow).toHaveBeenCalledWith('/tmp/clone');
    expect(onboard).toHaveBeenCalledOnce();
    expect(r.onboarded).toBe(true);
  });

  it('does NOT onboard when WORKFLOW.md already exists', async () => {
    const onboard = vi.fn();
    const loadWorkflow = vi.fn().mockReturnValue({ project: 'org/web' });

    const r = await maybeOnboard({
      repoDir: '/tmp/clone',
      forge: { forge: 'github', project: 'org/web', botUser: 'maestro-bot' } as never,
      defaultBranch: 'main',
      packageJson: null,
      template: '---\nforge: {{forge}}\n---\n{{protocol}}{{project}}{{botUser}}{{defaultBranch}}{{proofType}}{{proofCommand}}{{framework}}',
      deps: { onboardRepo: onboard, loadWorkflow },
    });

    expect(onboard).not.toHaveBeenCalled();
    expect(r.onboarded).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @maestro/cli test -- src/commands/add.test.ts`
Expected: FAIL — `maybeOnboard is not exported`.

- [ ] **Step 3: Write minimal implementation**

Extract the onboarding decision into a small injectable `maybeOnboard` so it is
unit-testable, then call it from the `add` action after clone + setup.

```ts
// packages/cli/src/commands/add.ts — add this helper (exported for tests)
import { onboardRepo, type OnboardArgs, type OnboardResult } from '@maestro/core';
import { loadWorkflow } from '@maestro/core'; // re-exported by core barrel (M1)
import type { ForgeAdapter } from '@maestro/core';

export interface MaybeOnboardArgs {
  repoDir: string;
  forge: ForgeAdapter;
  defaultBranch: string;
  packageJson: string | null;
  template: string;
  // injectable deps for testing
  deps?: {
    onboardRepo?: (a: OnboardArgs) => Promise<OnboardResult>;
    loadWorkflow?: (repoDir: string) => unknown | null;
  };
}

export interface MaybeOnboardResult {
  onboarded: boolean;
  issueNumber?: number;
}

/**
 * After clone + label/board setup, open an onboarding issue iff the repo has no
 * WORKFLOW.md. Onboarding then runs through the NORMAL lifecycle — no special path.
 */
export async function maybeOnboard(args: MaybeOnboardArgs): Promise<MaybeOnboardResult> {
  const load = args.deps?.loadWorkflow ?? loadWorkflow;
  const onboard = args.deps?.onboardRepo ?? onboardRepo;

  if (load(args.repoDir) !== null) return { onboarded: false };

  const result = await onboard({
    forge: args.forge,
    project: args.forge.project,
    defaultBranch: args.defaultBranch,
    packageJson: args.packageJson,
    template: args.template,
  });
  return { onboarded: result.created, issueNumber: result.issueNumber };
}
```

Then, in the existing `add` command action (after clone, `RepoEntry` append, and
`ensureLabels`/`ensureBoard`), read the template and the repo's root
`package.json` from disk and call `maybeOnboard`:

```ts
// inside the add action, after setup:
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// `dest` is M5's clone dir (parseRepoUrl → join(cloneRoot, dirName)); `forge`
// is the ForgeAdapter from createForge(); `log` is M5's logger.
const template = readFileSync(resolveTemplatePath(), 'utf8'); // see Open question Q3

let packageJson: string | null = null;
try {
  packageJson = readFileSync(join(dest, 'package.json'), 'utf8');
} catch {
  packageJson = null; // not a Node repo; inference returns null/unknown
}

const onboardResult = await maybeOnboard({
  repoDir: dest,
  forge,                      // the ForgeAdapter built via createForge() in M5
  defaultBranch,              // see Open question Q6 — M5 add does not resolve this today
  packageJson,
  template,
  // no deps override in production — uses real onboardRepo + loadWorkflow
});

if (onboardResult.onboarded) {
  log.info({ issue_number: onboardResult.issueNumber }, 'opened onboarding issue');
}
```

> `dest`, `forge`, and `log` exist in M5's `add.ts` — reuse them. Two values M5
> does NOT currently provide are flagged in Open questions: the template path
> (Q3) and `defaultBranch` (Q6). The real `ForgeAdapter` already exposes
> `createIssue`, so production passes it straight to `onboardRepo`; the
> `maybeOnboard` unit test injects fakes.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @maestro/cli test -- src/commands/add.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/add.ts packages/cli/src/commands/add.test.ts
git commit -m "feat(cli): trigger onboarding from `add` when WORKFLOW.md is absent"
```

---

## Task 12: Self-managed wrapper — full-suite regression + verification

The maestro repo adds as a normal `RepoEntry` (`url: <host>/<group>/maestro`) and
flows config changes through issue → MR → approve → merge → hot-reload, now
guarded by `validateConfig`. There is no new code for "self-management" — it is
the same `add` + lifecycle + the Task 10 reload gate. This task proves the whole
M7 surface holds together.

**Files:** none new — verification only.

- [ ] **Step 1: Run the full core suite**

Run: `pnpm --filter @maestro/core test`
Expected: PASS — includes `agent/protocol.test.ts`, `bootstrap/onboard.test.ts`,
`config/load.test.ts`, `index.test.ts`. No failures.

- [ ] **Step 2: Run the full CLI suite**

Run: `pnpm --filter @maestro/cli test`
Expected: PASS — includes `commands/add.test.ts`.

- [ ] **Step 3: Typecheck the workspace**

Run: `pnpm -r exec tsc --noEmit`
Expected: PASS — no type errors. Confirms `onboardRepo`/`OnboardArgs`/`SeedFacts`
match the contract types they reference (`Forge`, `Issue`, `ForgeAdapter`, `WorkflowConfig`).

- [ ] **Step 4: Lint**

Run: `pnpm -r lint`
Expected: PASS — no ESLint/Prettier errors in new files.

- [ ] **Step 5: Commit (only if lint/format auto-fixed anything)**

```bash
git add -p packages/core/src/bootstrap/onboard.ts packages/core/src/agent/protocol.ts packages/core/src/config/load.ts packages/cli/src/commands/add.ts
git commit -m "chore: lint/format M7 onboarding + self-manage sources"
```

> If nothing changed, skip the commit. Do not stage unrelated files.

---

## Self-Review (against spec §12, §16 and contracts)

- **§16 onboarding reuses standard lifecycle:** `onboardRepo` only opens an issue
  (Task 7). Seed + inference (Tasks 2–6) produce content the agent writes via the
  normal MR flow. No parallel pipeline. ✔
- **Inferred facts (test command, framework, default branch):** Tasks 2, 3, and
  the `defaultBranch` passed through `OnboardArgs`/`SeedFacts`. ✔
- **Template matches `WorkflowConfig`:** Task 4 front matter covers every required
  field; Task 5 verifies via `parseWorkflow`. ✔
- **`DEFAULT_PROTOCOL` embedded in body:** Task 1 defines it, Task 4/5 embed it. ✔
- **`maestro add` triggers onboarding:** Task 11. ✔
- **Self-managed wrapper + config validation before reload:** Tasks 9, 10, 12. ✔
- **Conventions:** TDD per step, explicit `git add <paths>`, Conventional Commits,
  no `Co-Authored-By`. ✔
- **Type consistency:** `SeedFacts`, `OnboardArgs`, `OnboardResult`, `Framework`,
  `PackageManager`, `ValidateResult` are defined once and reused consistently
  across Tasks 2–11; `onboardRepo`/`maybeOnboard` consume the canonical
  `ForgeAdapter.createIssue({ title, body, assignee? })` — no bespoke seam. ✔

---

## Open questions

These are gaps the contracts (`maestro-00-contracts.md`) do not cover. They are
flagged here rather than invented into canonical interfaces.

1. **Onboarding seeds an issue, but the seed must reach the agent's MR.** The
   agent writes `WORKFLOW.md` by following the onboarding issue body
   (`buildOnboardingPrompt`). That relies on the standard runner/loop (M3/M5)
   feeding the issue body into the agent prompt. Contracts do not specify how the
   issue body is incorporated into the runner prompt. Assumed: the standard
   "Orient" step (reads the issue) suffices. Confirm.

2. **`templates/WORKFLOW.md` location at runtime.** Task 11 reads the template via
   a `resolveTemplatePath()` placeholder. M5's `add.ts` does NOT define a
   `repoRoot` (verified against `maestro-05-cli-and-web.md` — it has `cloneRoot`/
   `dest`, no install-root anchor), so M7 cannot "reuse" one. In a packaged daemon
   (`/opt/maestro`, spec §14) the template ships alongside `packages/`. Contracts
   define `templates/WORKFLOW.md` as the canonical path (file tree) but no
   resolution helper. Proposed: `core` exports `loadDefaultTemplate()` resolving
   relative to its own module (`import.meta.url`) rather than the CLI reading a
   path it has to guess. Confirm approach + helper ownership.

3. **Default-branch detection during `add`.** Task 11 passes `defaultBranch` into
   onboarding. Verified against `maestro-05-cli-and-web.md`: M5's `add` clones
   `--depth 1` and does NOT resolve a default branch — so this value is not
   available today. Either M5 must add detection (e.g. `git symbolic-ref
   refs/remotes/origin/HEAD` or the forge API) or M7 must resolve it before
   calling `maybeOnboard`. Where should default-branch resolution live?

4. **Package-manager detection for `inferTestCommand`.** The helper accepts a
   `packageManager` option but `onboardRepo` currently always infers `npm`.
   Detecting pnpm/yarn requires inspecting lockfiles in the clone, which the
   contracts do not model. Assumed `npm` as the safe default; the agent corrects
   it during onboarding. Acceptable, or should lockfile detection be added?
