// Bootstrap inference (§16, M8 Part A). Produces a WorkflowSchema-valid WORKFLOW.md
// SEED for a freshly-cloned repo with none, so the "define my workflow" bootstrap
// issue carries a concrete starting point the agent refines. Pure-ish: the default-
// branch probe goes through the injected Exec; file detection is pure over an
// injected reader. The seed is ALWAYS validated through the M1 loader before it
// leaves here — a seed that misses a required field is a bug, not something we ship.

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { Exec, RepoRef, WorkflowFrontMatter } from '../contracts/index.js';
import { parseWorkflow, splitFrontMatter } from '../workflow/load-workflow.js';

export type ProofType = 'playwright' | 'test-output' | 'diff-summary' | 'none';
export interface ProofSeed {
  type: ProofType;
  command?: string;
}

export interface InferDeps {
  exec: Exec;
  /** The cloned repo dir the git probe runs in (cwd). */
  clonedDir: string;
  /** Contents of `templates/WORKFLOW.md` (the M0 template). Injected so core stays fs-free. */
  templateText: string;
  /** Read a repo file by path relative to the clone; undefined if absent (fake-able). */
  readFile: (relPath: string) => string | undefined;
  /** bot_user for the seed (config default / WORKFLOW precedence resolved by the caller). */
  botUser: string;
}

export interface WorkflowSeed {
  text: string; // the rendered WORKFLOW.md (front matter + prompt body)
  frontMatter: WorkflowFrontMatter; // validated
  promptBody: string;
}

/** Probe the cloned repo's default branch from its remote HEAD; 'main' on any doubt. */
export async function inferDefaultBranch(exec: Exec, clonedDir: string): Promise<string> {
  const r = await exec.run(
    'git',
    ['-C', clonedDir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
    {},
  );
  if (r.code === 0) {
    const name = r.stdout.trim().replace(/^origin\//, ''); // 'origin/main' → 'main'
    if (name) return name;
  }
  return 'main'; // documented default (matches WorkflowSchema git.default_branch default)
}

/** Detect the proof strategy purely from repo files. Order: playwright > test script >
 *  non-Node test target > none (the floor). `none` is always schema-legal. */
export function detectProof(readFile: (relPath: string) => string | undefined): ProofSeed {
  const pkgRaw = readFile('package.json');
  if (pkgRaw) {
    const pkg = tryJson(pkgRaw) as
      | {
          scripts?: Record<string, string>;
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        }
      | undefined;
    if (pkg) {
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      const testScript = pkg.scripts?.test;
      if ('@playwright/test' in deps || 'playwright' in deps) {
        return { type: 'playwright', command: 'npx playwright test --reporter=line' };
      }
      if (testScript && !/no test specified/i.test(testScript)) {
        return { type: 'test-output', command: 'npm test' };
      }
    }
  }
  if (readFile('pyproject.toml')) return { type: 'test-output', command: 'pytest' };
  if (/^test:/m.test(readFile('Makefile') ?? ''))
    return { type: 'test-output', command: 'make test' };
  return { type: 'none' };
}

/**
 * Render a validated WORKFLOW.md seed by overlaying inferred facts onto the M0
 * template's front matter, reusing the M1 loader to split + validate (never
 * re-implementing parsing). Throws if the result fails WorkflowSchema — the seed is
 * validated, not trusted.
 */
export async function inferWorkflowSeed(repo: RepoRef, deps: InferDeps): Promise<WorkflowSeed> {
  const branch = await inferDefaultBranch(deps.exec, deps.clonedDir);
  const proof = detectProof(deps.readFile);

  const { frontMatter: templateFm, promptBody } = splitFrontMatter(deps.templateText);
  const base = (parseYaml(templateFm) ?? {}) as Record<string, unknown>;

  const merged: Record<string, unknown> = {
    ...base,
    forge: repo.forge,
    project: repo.project,
    bot_user: deps.botUser,
    git: { ...(base.git as Record<string, unknown>), default_branch: branch, target: branch },
    proof: proof.command ? { type: proof.type, command: proof.command } : { type: proof.type },
    environment: {}, // a fresh repo has no known running instance yet (§16 / Slice 9)
  };

  const text = `---\n${stringifyYaml(merged)}---\n${promptBody}`;
  const parsed = parseWorkflow(text, repo.host);
  if (!parsed.ok) throw new Error(`inferred WORKFLOW seed failed WorkflowSchema: ${parsed.error}`);
  return { text, frontMatter: parsed.value.frontMatter, promptBody: parsed.value.promptBody };
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
