// The proof seam's typed error mode (#109): generateProofs surfaces ANY throw inside a
// strategy run as one ProofGenerationError carrying strategy + cause. ok:false RESULTS
// stay non-fatal (pinned in proof.test.ts Slice 5); only the throwing path is typed.

import { describe, expect, it } from 'vitest';
import type {
  Exec,
  ExecOptions,
  ExecResult,
  ProofInput,
  SpawnHandle,
} from '../src/contracts/index.js';
import { ProofConfigError, ProofGenerationError, generateProofs } from '../src/proof/strategies.js';

function exec(h: () => Promise<ExecResult>): Exec {
  return {
    run: (_cmd: string, _args: string[], _opts?: ExecOptions) => h(),
    spawn: (): SpawnHandle => ({
      kill: () => {},
      exited: Promise.resolve({ code: 0, stdout: '', stderr: '' }),
    }),
    stream: () => Promise.reject(new Error('unused')),
    attach: () => Promise.reject(new Error('unused')),
  };
}

function base(e: Exec): Omit<ProofInput, 'workflowProof'> {
  return { workspaceDir: '/ws/42', environment: {}, git: { target: 'main' }, exec: e };
}

describe('generateProofs throws typed ProofGenerationError (#109)', () => {
  it('a config miss inside a strategy → typed error with strategy + ProofConfigError cause', async () => {
    const e = exec(async () => ({ code: 0, stdout: '', stderr: '' }));
    const err = await generateProofs(base(e), [{ type: 'test-output' }]) // command missing
      .then(() => null)
      .catch((x: unknown) => x);
    expect(err).toBeInstanceOf(ProofGenerationError);
    if (!(err instanceof ProofGenerationError)) throw new Error('unreachable');
    expect(err.strategy).toBe('test-output');
    expect(err.cause).toBeInstanceOf(ProofConfigError);
    expect(err.message).toContain('test-output');
    expect(err.message).toContain('proof.command');
  });

  it('a rejecting Exec (crashed subprocess) → typed error naming the strategy that ran', async () => {
    const e = exec(async () => {
      throw new Error('spawn ENOMEM');
    });
    const err = await generateProofs(base(e), [{ type: 'diff-summary' }])
      .then(() => null)
      .catch((x: unknown) => x);
    expect(err).toBeInstanceOf(ProofGenerationError);
    if (!(err instanceof ProofGenerationError)) throw new Error('unreachable');
    expect(err.strategy).toBe('diff-summary');
    expect(err.message).toBe('proof generation failed (diff-summary): spawn ENOMEM');
  });

  it('a later strategy throwing still surfaces typed, after earlier results', async () => {
    const e = exec(async () => ({ code: 0, stdout: 'ok', stderr: '' }));
    const err = await generateProofs(base(e), [
      { type: 'diff-summary' },
      { type: 'test-output' }, // command missing → throws second
    ])
      .then(() => null)
      .catch((x: unknown) => x);
    expect(err).toBeInstanceOf(ProofGenerationError);
    if (!(err instanceof ProofGenerationError)) throw new Error('unreachable');
    expect(err.strategy).toBe('test-output');
  });

  it('a failing-but-returning strategy (ok:false) does NOT throw — M4 policy unchanged', async () => {
    const e = exec(async () => ({ code: 1, stdout: '', stderr: 'tests failed' }));
    const results = await generateProofs(base(e), [{ type: 'diff-summary' }]);
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
  });
});
