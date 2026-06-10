// Proof generator (§6, §8). A registry of strategies keyed by WorkflowSchema.proof
// .type; each runs ONLY through the injected Exec seam and returns the frozen
// ProofResult (§0.12). Selection validates config up front so a misconfigured proof
// fails before any subprocess runs.
//
// SECURITY (§13): proof/start/seed/health commands come from the repo's WORKFLOW.md
// and run UNSANDBOXED on the host with cwd pinned to the workspace. Real isolation
// is the deferred §17 container swap — flagged, not solved here.
// CAPACITY (§14): only `playwright` touches a browser (~300–700MB); it must tear
// down anything it started so the daemon doesn't leak processes.

import type {
  Exec,
  ProofInput,
  ProofResult,
  ProofStrategyKind,
  ProofStrategySpec,
} from '../contracts/index.js';

const OUTPUT_CAP = 4000; // bound captured output so a chatty command can't bloat a comment

export class ProofConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProofConfigError';
  }
}

/** The proof seam's typed error mode (#109, CONTEXT.md §Proof-failure escalation): any
 *  THROW inside a strategy run — a ProofConfigError, a rejecting Exec, a Playwright
 *  crash — surfaces from `generateProofs` as this one error carrying WHICH strategy and
 *  WHY, so the executor's catch path can tell a proof failure from an agent error and
 *  escalate instead of silently retrying forever. `ok: false` RESULTS are unaffected —
 *  still non-fatal (M4 policy); this types only the throwing path. */
export class ProofGenerationError extends Error {
  readonly strategy: ProofStrategyKind;
  constructor(strategy: ProofStrategyKind, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`proof generation failed (${strategy}): ${reason}`, { cause });
    this.name = 'ProofGenerationError';
    this.strategy = strategy;
  }
}

export interface PlaywrightTuning {
  healthAttempts?: number; // bounded health poll (default 10)
  sleep?: (ms: number) => Promise<void>; // injectable for fast tests
  sleepMs?: number; // delay between health probes (default 500)
}

/** Run a WORKFLOW command string through the host shell. These commands are
 *  operator-authored and already run unsandboxed on the host (§13), so `sh -c` adds
 *  no new trust — it adds the shell features real workflows need (`&&`, quotes, env
 *  vars). The previous whitespace-split fed `npm install && npm test` to npm as
 *  literal args (`Invalid tag name "&&"`). */
export function shellCommand(command: string): { cmd: string; args: string[] } {
  return { cmd: 'sh', args: ['-c', command.trim()] };
}

function cap(s: string): { text: string; truncated: boolean } {
  if (s.length <= OUTPUT_CAP) return { text: s, truncated: false };
  return { text: `${s.slice(0, OUTPUT_CAP)}\n…[truncated]`, truncated: true };
}

function fenced(title: string, body: string): string {
  return `**${title}**\n\n\`\`\`\n${body.trim()}\n\`\`\``;
}

async function probeHealthy(exec: Exec, healthCheck: string, cwd: string): Promise<boolean> {
  const { cmd, args } = shellCommand(healthCheck);
  const r = await exec.run(cmd, args, { cwd });
  return r.code === 0;
}

const noneStrategy = {
  kind: 'none' as const,
  async run(): Promise<ProofResult> {
    return { ok: true, kind: 'none', summary: 'No proof configured for this repo.' };
  },
};

const diffSummaryStrategy = {
  kind: 'diff-summary' as const,
  async run(input: ProofInput): Promise<ProofResult> {
    const r = await input.exec.run('git', ['diff', '--stat', `${input.git.target}...HEAD`], {
      cwd: input.workspaceDir,
    });
    const ok = r.code === 0;
    const body = ok ? r.stdout || '(no changes)' : r.stderr;
    return {
      ok,
      kind: 'diff-summary',
      summary: `${ok ? 'Diff summary' : `Diff summary failed (exit ${r.code})`}\n\n${fenced('git diff --stat', body)}`,
    };
  },
};

const testOutputStrategy = {
  kind: 'test-output' as const,
  async run(input: ProofInput): Promise<ProofResult> {
    if (!input.workflowProof.command) {
      throw new ProofConfigError("proof.type 'test-output' requires proof.command");
    }
    const { cmd, args } = shellCommand(input.workflowProof.command);
    const r = await input.exec.run(cmd, args, { cwd: input.workspaceDir });
    const ok = r.code === 0;
    const { text, truncated } = cap(`${r.stdout}\n${r.stderr}`);
    return {
      ok,
      kind: 'test-output',
      summary: `${ok ? '✅ Tests passed' : `❌ Tests failed (exit ${r.code})`}${
        truncated ? ' (output truncated)' : ''
      }\n\n${fenced(input.workflowProof.command, text)}`,
    };
  },
};

class PlaywrightStrategy {
  readonly kind = 'playwright' as const;
  readonly #attempts: number;
  readonly #sleepMs: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(tuning: PlaywrightTuning = {}) {
    this.#attempts = tuning.healthAttempts ?? 10;
    this.#sleepMs = tuning.sleepMs ?? 500;
    this.#sleep = tuning.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async run(input: ProofInput): Promise<ProofResult> {
    const env = input.environment;
    if (!env.base_url || !env.health_check) {
      throw new ProofConfigError(
        "proof.type 'playwright' requires environment.base_url and health_check",
      );
    }
    if (!input.workflowProof.command) {
      throw new ProofConfigError("proof.type 'playwright' requires proof.command");
    }
    const { cwd } = { cwd: input.workspaceDir };

    let started: { kill: (s?: NodeJS.Signals) => void } | undefined;
    try {
      const alreadyUp = await probeHealthy(input.exec, env.health_check, cwd);
      if (!alreadyUp) {
        if (!env.start_command) {
          return {
            ok: false,
            kind: 'playwright',
            summary: 'instance not running and no start_command configured',
          };
        }
        const sc = shellCommand(env.start_command);
        started = input.exec.spawn(sc.cmd, sc.args, { cwd }); // long-lived; we own teardown
        if (env.seed_command) {
          const seed = shellCommand(env.seed_command);
          await input.exec.run(seed.cmd, seed.args, { cwd });
        }
        const healthy = await this.#pollHealth(input.exec, env.health_check, cwd);
        if (!healthy) {
          return {
            ok: false,
            kind: 'playwright',
            summary: `instance failed health check after ${this.#attempts} attempts`,
          };
        }
      }

      const pc = shellCommand(input.workflowProof.command);
      const r = await input.exec.run(pc.cmd, pc.args, { cwd });
      const ok = r.code === 0;
      const { text, truncated } = cap(`${r.stdout}\n${r.stderr}`);
      return {
        ok,
        kind: 'playwright',
        summary: `${ok ? '✅ Playwright passed' : `❌ Playwright failed (exit ${r.code})`}${
          truncated ? ' (output truncated)' : ''
        }\n\n${fenced(input.workflowProof.command, text)}`,
      };
    } finally {
      started?.kill(); // tear down only what THIS step started (§14 no process leak)
    }
  }

  async #pollHealth(exec: Exec, healthCheck: string, cwd: string): Promise<boolean> {
    for (let i = 0; i < this.#attempts; i++) {
      if (await probeHealthy(exec, healthCheck, cwd)) return true;
      await this.#sleep(this.#sleepMs);
    }
    return false;
  }
}

export function selectProofStrategy(kind: ProofStrategyKind, tuning?: PlaywrightTuning) {
  switch (kind) {
    case 'none':
      return noneStrategy;
    case 'diff-summary':
      return diffSummaryStrategy;
    case 'test-output':
      return testOutputStrategy;
    case 'playwright':
      return new PlaywrightStrategy(tuning);
    default:
      throw new ProofConfigError(`unknown proof type: ${String(kind)}`);
  }
}

/** Select + run a single configured strategy. */
export function generateProof(input: ProofInput, tuning?: PlaywrightTuning): Promise<ProofResult> {
  return selectProofStrategy(input.workflowProof.type, tuning).run(input);
}

/**
 * Run every configured strategy and return one ProofResult per strategy, in config
 * order. Sequential by design (§14): a server-spawning strategy (playwright) must not
 * race another for ports/resources, and the order is what the handoff comment renders.
 * The handoff folds these into the single proof comment (all-must-pass).
 *
 * This is the daemon's proof seam (#109): a strategy that THROWS (vs. returning
 * ok:false) aborts the run and surfaces as one typed ProofGenerationError, which the
 * executor's catch path escalates (retry → park-blocked). Callers that drive a single
 * strategy directly (`generateProof`) still see the raw error.
 */
export async function generateProofs(
  base: Omit<ProofInput, 'workflowProof'>,
  strategies: ProofStrategySpec[],
  tuning?: PlaywrightTuning,
): Promise<ProofResult[]> {
  const results: ProofResult[] = [];
  for (const workflowProof of strategies) {
    try {
      results.push(await generateProof({ ...base, workflowProof }, tuning));
    } catch (err) {
      throw new ProofGenerationError(workflowProof.type, err);
    }
  }
  return results;
}
