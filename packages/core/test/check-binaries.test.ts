// Preflight binary-presence checks. A bespoke Exec fake (not FakeExec) so we can model
// the one signal that matters: a spawn ENOENT rejection = "not on PATH", everything else
// = present. We assert the ENOENT discrimination, the config-scoped requirement set, and
// the structured result.

import { describe, expect, it } from 'vitest';
import type { Exec, ExecOptions, ExecResult, MaestroConfig, SpawnHandle } from '../src/public.js';
import { allBinaries, checkBinaries, requiredBinaries } from '../src/public.js';

/** Exec whose run() resolves for binaries in `installed`, else rejects with an
 *  ENOENT-coded error — exactly how node:child_process surfaces a missing executable. */
function fakeExec(
  installed: string[],
  opts?: { otherErrorFor?: string },
): Exec & {
  versionCalls: string[];
} {
  const versionCalls: string[] = [];
  return {
    versionCalls,
    run(cmd: string, args: string[], _o?: ExecOptions): Promise<ExecResult> {
      versionCalls.push(cmd);
      expect(args).toEqual(['--version']);
      if (opts?.otherErrorFor === cmd) {
        return Promise.reject(new Error('exploded for some non-ENOENT reason'));
      }
      if (installed.includes(cmd)) {
        return Promise.resolve({ code: 0, stdout: `${cmd} 1.2.3`, stderr: '' });
      }
      const err = Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' });
      return Promise.reject(err);
    },
    stream: () => Promise.reject(new Error('unused')),
    spawn: (): SpawnHandle => {
      throw new Error('unused');
    },
    attach: () => Promise.reject(new Error('unused')),
  };
}

const REQS = [
  { bin: 'git', reason: 'clone' },
  { bin: 'glab', reason: 'gitlab' },
];

describe('checkBinaries', () => {
  it('reports all present when every binary is on PATH', async () => {
    const exec = fakeExec(['git', 'glab']);
    const r = await checkBinaries(exec, REQS);
    expect(r.ok).toBe(true);
    expect(r.present).toEqual(['git', 'glab']);
    expect(r.missing).toEqual([]);
    expect(exec.versionCalls).toEqual(['git', 'glab']); // probes via --version, in order
  });

  it('flags a missing binary (ENOENT) and keeps its reason', async () => {
    const exec = fakeExec(['git']); // glab absent
    const r = await checkBinaries(exec, REQS);
    expect(r.ok).toBe(false);
    expect(r.present).toEqual(['git']);
    expect(r.missing).toEqual([{ bin: 'glab', reason: 'gitlab' }]);
  });

  it('treats a non-ENOENT spawn error as present (existence, not health)', async () => {
    const exec = fakeExec(['git'], { otherErrorFor: 'glab' });
    const r = await checkBinaries(exec, REQS);
    expect(r.ok).toBe(true);
    expect(r.present).toEqual(['git', 'glab']);
  });
});

describe('requiredBinaries', () => {
  const base = (forges: MaestroConfig['forges']): MaestroConfig =>
    ({ forges }) as unknown as MaestroConfig;

  it('always needs git + claude, and only the configured forge binaries', () => {
    const gitlabOnly = requiredBinaries(base({ gitlab: { host: 'gitlab.com', token_env: 'X' } }));
    expect(gitlabOnly.map((r) => r.bin)).toEqual(['git', 'claude', 'glab']);

    const githubOnly = requiredBinaries(base({ github: { host: 'github.com', token_env: 'Y' } }));
    expect(githubOnly.map((r) => r.bin)).toEqual(['git', 'claude', 'gh']);

    const both = requiredBinaries(
      base({
        gitlab: { host: 'gitlab.com', token_env: 'X' },
        github: { host: 'github.com', token_env: 'Y' },
      }),
    );
    expect(both.map((r) => r.bin)).toEqual(['git', 'claude', 'glab', 'gh']);
  });

  it('allBinaries lists the full superset', () => {
    expect(allBinaries().map((r) => r.bin)).toEqual(['git', 'claude', 'glab', 'gh']);
  });
});
