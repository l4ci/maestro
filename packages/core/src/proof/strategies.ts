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

import type { Exec, ProofInput, ProofResult, ProofStrategyKind } from '../contracts/index.js';

const OUTPUT_CAP = 4000; // bound captured output so a chatty command can't bloat a comment

export class ProofConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProofConfigError';
  }
}

export interface PlaywrightTuning {
  healthAttempts?: number; // bounded health poll (default 10)
  sleep?: (ms: number) => Promise<void>; // injectable for fast tests
  sleepMs?: number; // delay between health probes (default 500)
}

/** Whitespace-split a WORKFLOW command string into cmd + args. Dumb by design — no
 *  shell, no quotes (documented limitation); keeps it off a shell interpreter. */
export function parseCommand(command: string): { cmd: string; args: string[] } {
  const parts = command.trim().split(/\s+/);
  const cmd = parts[0] ?? '';
  return { cmd, args: parts.slice(1) };
}

function cap(s: string): { text: string; truncated: boolean } {
  if (s.length <= OUTPUT_CAP) return { text: s, truncated: false };
  return { text: `${s.slice(0, OUTPUT_CAP)}\n…[truncated]`, truncated: true };
}

function fenced(title: string, body: string): string {
  return `**${title}**\n\n\`\`\`\n${body.trim()}\n\`\`\``;
}

async function probeHealthy(exec: Exec, healthCheck: string, cwd: string): Promise<boolean> {
  const { cmd, args } = parseCommand(healthCheck);
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
    const { cmd, args } = parseCommand(input.workflowProof.command);
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
        const sc = parseCommand(env.start_command);
        started = input.exec.spawn(sc.cmd, sc.args, { cwd }); // long-lived; we own teardown
        if (env.seed_command) {
          const seed = parseCommand(env.seed_command);
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

      const pc = parseCommand(input.workflowProof.command);
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

/** Select + run the configured strategy. */
export function generateProof(input: ProofInput, tuning?: PlaywrightTuning): Promise<ProofResult> {
  return selectProofStrategy(input.workflowProof.type, tuning).run(input);
}
