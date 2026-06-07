import { describe, expect, it } from 'vitest';
import type {
  Exec,
  ExecOptions,
  ExecResult,
  ProofInput,
  SpawnHandle,
} from '../src/contracts/index.js';
import {
  ProofConfigError,
  generateProof,
  generateProofs,
  selectProofStrategy,
} from '../src/proof/strategies.js';

type RunHandler = (cmd: string, args: string[], n: number) => ExecResult;

class ProofExec implements Exec {
  runCalls: { cmd: string; args: string[]; opts?: ExecOptions }[] = [];
  spawnCalls: { cmd: string; args: string[] }[] = [];
  killCount = 0;
  #h: RunHandler;
  constructor(h: RunHandler = () => ({ code: 0, stdout: '', stderr: '' })) {
    this.#h = h;
  }
  run(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult> {
    this.runCalls.push({ cmd, args, opts });
    return Promise.resolve(this.#h(cmd, args, this.runCalls.length));
  }
  spawn(cmd: string, args: string[]): SpawnHandle {
    this.spawnCalls.push({ cmd, args });
    return {
      kill: () => {
        this.killCount++;
      },
      exited: Promise.resolve({ code: 0, stdout: '', stderr: '' }),
    };
  }
  stream(): Promise<ExecResult> {
    throw new Error('unused');
  }
  attach(): Promise<number> {
    throw new Error('unused');
  }
}

function input(over: Partial<ProofInput> = {}): ProofInput {
  return {
    workspaceDir: '/ws/group__repo/42',
    workflowProof: { type: 'none' },
    environment: {},
    git: { target: 'main' },
    exec: new ProofExec(),
    ...over,
  };
}

const fastPw = { sleep: () => Promise.resolve(), sleepMs: 0, healthAttempts: 5 };

// --- Slice 1: none ---------------------------------------------------------

describe('Slice 1 — none strategy', () => {
  it('returns ok with zero Exec calls', async () => {
    const exec = new ProofExec();
    const r = await generateProof(input({ workflowProof: { type: 'none' }, exec }));
    expect(r).toMatchObject({ kind: 'none', ok: true });
    expect(exec.runCalls).toHaveLength(0);
  });

  it('selecting an unknown type throws at selection time', () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately bad input
    expect(() => selectProofStrategy('bogus' as any)).toThrow(ProofConfigError);
  });
});

// --- Slice 2: diff-summary -------------------------------------------------

describe('Slice 2 — diff-summary', () => {
  it('runs git diff --stat against git.target with cwd, embeds output', async () => {
    const exec = new ProofExec((cmd) =>
      cmd === 'git'
        ? { code: 0, stdout: ' file | 2 +-', stderr: '' }
        : { code: 0, stdout: '', stderr: '' },
    );
    const r = await generateProof(
      input({ workflowProof: { type: 'diff-summary' }, exec, git: { target: 'main' } }),
    );
    expect(exec.runCalls).toHaveLength(1);
    expect(exec.runCalls[0]?.cmd).toBe('git');
    expect(exec.runCalls[0]?.args).toEqual(['diff', '--stat', 'main...HEAD']);
    expect(exec.runCalls[0]?.opts?.cwd).toBe('/ws/group__repo/42');
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('file | 2 +-');
  });

  it('non-zero exit → ok false, stderr captured (not thrown)', async () => {
    const exec = new ProofExec(() => ({ code: 1, stdout: '', stderr: 'bad revision' }));
    const r = await generateProof(input({ workflowProof: { type: 'diff-summary' }, exec }));
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('bad revision');
  });
});

// --- Slice 3: test-output --------------------------------------------------

describe('Slice 3 — test-output', () => {
  it('runs proof.command through the shell with cwd; ok reflects exit; long output truncated', async () => {
    const big = 'x'.repeat(9000);
    const exec = new ProofExec(() => ({ code: 0, stdout: big, stderr: '' }));
    const r = await generateProof(
      input({ workflowProof: { type: 'test-output', command: 'npm test' }, exec }),
    );
    expect(exec.runCalls[0]).toMatchObject({ cmd: 'sh', args: ['-c', 'npm test'] });
    expect(exec.runCalls[0]?.opts?.cwd).toBe('/ws/group__repo/42');
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('truncated');
  });

  it('a compound command (&&) reaches the shell verbatim, not split into argv', async () => {
    // Regression: `npm install && npm test` was whitespace-split and fed to npm as
    // literal args — npm died with `Invalid tag name "&&"` before any test ran.
    const exec = new ProofExec(() => ({ code: 0, stdout: 'ok', stderr: '' }));
    const r = await generateProof(
      input({ workflowProof: { type: 'test-output', command: 'npm install && npm test' }, exec }),
    );
    expect(exec.runCalls[0]).toMatchObject({ cmd: 'sh', args: ['-c', 'npm install && npm test'] });
    expect(r.ok).toBe(true);
  });

  it('missing command → ProofConfigError before any Exec call', async () => {
    const exec = new ProofExec();
    await expect(
      generateProof(input({ workflowProof: { type: 'test-output' }, exec })),
    ).rejects.toBeInstanceOf(ProofConfigError);
    expect(exec.runCalls).toHaveLength(0);
  });
});

// --- Slice 4: playwright ---------------------------------------------------

const pwEnv = {
  base_url: 'http://localhost:3000',
  start_command: 'npm run dev',
  seed_command: 'npm run db:seed',
  health_check: 'curl -sf localhost:3000/health',
};

describe('Slice 4 — playwright', () => {
  it('a. already-running: skips start_command, runs proof.command', async () => {
    // curl(health) returns 0 immediately; playwright test returns 0
    const exec = new ProofExec((_cmd, args) => ({
      code: 0,
      stdout: args[1]?.startsWith('curl') ? 'ok' : 'passed',
      stderr: '',
    }));
    const r = await generateProof(
      input({
        workflowProof: { type: 'playwright', command: 'npx playwright test' },
        environment: pwEnv,
        exec,
      }),
      fastPw,
    );
    expect(exec.spawnCalls).toHaveLength(0); // never booted
    expect(r.ok).toBe(true);
  });

  it('b. cold-boot: boots, seeds, polls health, then runs; c. tears down after', async () => {
    let healthProbes = 0;
    const exec = new ProofExec((_cmd, args) => {
      if (args[1]?.startsWith('curl')) {
        healthProbes++;
        return { code: healthProbes >= 3 ? 0 : 1, stdout: '', stderr: '' }; // healthy on 3rd probe
      }
      return { code: 0, stdout: 'passed', stderr: '' };
    });
    const r = await generateProof(
      input({
        workflowProof: { type: 'playwright', command: 'npx playwright test' },
        environment: pwEnv,
        exec,
      }),
      fastPw,
    );
    expect(exec.spawnCalls.map((c) => c.args[1])).toContain('npm run dev'); // start_command spawned
    expect(exec.runCalls.some((c) => c.args.some((a) => a.includes('db:seed')))).toBe(true); // seeded
    expect(r.ok).toBe(true);
    expect(exec.killCount).toBe(1); // teardown of what we started
  });

  it('c. teardown happens even when proof.command fails', async () => {
    const exec = new ProofExec((_cmd, args) => {
      if (args[1]?.startsWith('curl')) return { code: 1, stdout: '', stderr: '' }; // never healthy via probe...
      return { code: 0, stdout: '', stderr: '' };
    });
    // health never passes → bounded give-up, but a start was spawned → must tear down
    const r = await generateProof(
      input({
        workflowProof: { type: 'playwright', command: 'npx playwright test' },
        environment: pwEnv,
        exec,
      }),
      fastPw,
    );
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/health check/);
    expect(exec.killCount).toBe(1);
  });

  it('d. missing base_url/health_check → ProofConfigError before any Exec call', async () => {
    const exec = new ProofExec();
    await expect(
      generateProof(
        input({
          workflowProof: { type: 'playwright', command: 'npx playwright test' },
          environment: {},
          exec,
        }),
        fastPw,
      ),
    ).rejects.toBeInstanceOf(ProofConfigError);
    expect(exec.runCalls).toHaveLength(0);
    expect(exec.spawnCalls).toHaveLength(0);
  });
});

// --- Slice 5: generateProofs — multiple strategies (#12) --------------------

describe('Slice 5 — generateProofs runs every strategy in config order (#12)', () => {
  it('one result per strategy, in config order, sequentially', async () => {
    const exec = new ProofExec((_cmd, _args, n) => ({ code: 0, stdout: `run ${n}`, stderr: '' }));
    const { workflowProof: _single, ...base } = input({ exec });
    const results = await generateProofs(base, [
      { type: 'diff-summary' },
      { type: 'test-output', command: 'npm test' },
    ]);
    expect(results.map((r) => r.kind)).toEqual(['diff-summary', 'test-output']);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(exec.runCalls).toHaveLength(2);
    expect(exec.runCalls[0]?.cmd).toBe('git'); // diff-summary ran first
  });

  it('a failing strategy yields ok:false without stopping later strategies', async () => {
    const exec = new ProofExec((cmd) =>
      cmd === 'git'
        ? { code: 1, stdout: '', stderr: 'boom' }
        : { code: 0, stdout: 'all green', stderr: '' },
    );
    const { workflowProof: _single, ...base } = input({ exec });
    const results = await generateProofs(base, [
      { type: 'diff-summary' },
      { type: 'test-output', command: 'npm test' },
    ]);
    expect(results.map((r) => r.ok)).toEqual([false, true]);
  });
});
